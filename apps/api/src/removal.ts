import {
  NotFound,
  ProjectRemovalReport,
  ProjectPurgeReport,
  ProjectNameConflict,
  ProjectRetentionForbidden,
  ProjectRestoreUnavailable,
  PurgeNotConfirmed,
  ProjectPurgeIncomplete,
  RemovalForbidden,
  RemovalRefused,
  RemovalReport,
  RemovedProjectsDisk,
  WorktreeNotFound,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  type FencedRow,
  type RemovalFenceId,
  ProjectsRepo,
  REMOVAL_FENCE_RENEW_EVERY,
  RemovalFenced,
  RemovalFencesRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionRepositoriesRepo,
  SessionsRepo,
  SetupRunsRepo,
  UsersRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { proofBlobPrefix } from "@mend/domain/workbench";
import {
  type ChangeStanding,
  decideRemoval,
  type HoldFact,
  type NonEmptyBlockers,
  notChangeOwnerWords,
  type Person,
  type Project,
  ProjectVisibility,
  type Viewer,
  RemovedProject,
  canSeeProject,
  canRemoveProject,
  projectRetentionRights,
  projectRefusalWords,
  type Session,
  type SessionActivity,
  type SessionFact,
  type SessionRole,
  underway,
  underwayWith,
  type Worktree,
  type WorktreeFacts,
  type WorktreeHolds,
  worktreeRefusalWords,
  worktreeRemovalRight,
} from "@mend/domain/workbench";
import { SessionEngine, CaptureRuntime, ResourceRemoval } from "@mend/sessions";
import { BlobStore } from "@mend/store";
import { Store } from "@mend/store";
import { Data, Effect, Fiber, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import { changeStandingOf } from "./landing-state.ts";
import { LIVE_STATES } from "./live-states.ts";
import {
  keptObjectBytes,
  purgeProjectBlobs,
  type UploadAuthorityOpen,
  uploadsLanded,
} from "./project-purge-blobs.ts";

/** Who asks for a removal, as the route resolved them. */
export interface RemovalCaller {
  readonly userId: string;
  /** Whether the caller manages the worktree's project (ADR 0003: an owner, or its creator). */
  readonly managesProject: boolean;
}

/**
 * The one place a worktree or a project is removed (docs/adr/0007-landing.md, "Worktree removal";
 * ADR 0003). Each removal marks its row, reads every fact that could stand in the way, lets
 * `decideRemoval` answer, then either clears its mark and refuses with every blocker, or deletes.
 * It never stops a session or a Service on the caller's behalf. Running it again after a refusal,
 * a crash or a second request ends with the row gone or the same refusal.
 */
export class Removal extends Context.Service<
  Removal,
  {
    /** `force`: the change owner's explicit override; it lifts only what LIFTED_BY_FORCE lifts. */
    readonly worktree: (
      worktree: Worktree,
      caller: RemovalCaller,
      force: boolean,
    ) => Effect.Effect<RemovalReport, WorktreeNotFound | RemovalForbidden | RemovalRefused>;
    /** Refused while any worktree, anyone's, has work running, saving or not on origin. */
    readonly project: (
      project: Project,
      caller: RemovalCaller,
    ) => Effect.Effect<ProjectRemovalReport, NotFound | RemovalRefused>;
    readonly disk: (viewer: Viewer) => Effect.Effect<RemovedProjectsDisk>;
    readonly removed: (viewer: Viewer) => Effect.Effect<ReadonlyArray<RemovedProject>>;
    readonly restore: (
      id: ProjectId,
      viewer: Viewer,
      name?: string,
    ) => Effect.Effect<
      Project,
      NotFound | ProjectRetentionForbidden | ProjectRestoreUnavailable | ProjectNameConflict
    >;
    readonly purge: (
      id: ProjectId,
      viewer: Viewer,
      confirm: string,
    ) => Effect.Effect<
      ProjectPurgeReport,
      | NotFound
      | ProjectRetentionForbidden
      | PurgeNotConfirmed
      | ProjectPurgeIncomplete
      | RemovalRefused
    >;
  }
>()("@mend/api/Removal") {}

/**
 * A session start in a worktree or project a removal has marked, refused before the route does
 * anything the start's own rows would come after (a new worktree's directory). It dies as the
 * database's refusal would, so the error boundary answers both alike.
 */
export const refuseStartWhileRemoving = Effect.fn("refuseStartWhileRemoving")(function* (place: {
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId | null;
}) {
  if (!(yield* (yield* RemovalFencesRepo).admitsStart(place))) {
    return yield* Effect.die(
      new RemovalFenced(`project ${place.projectId} or its worktree is being removed`),
    );
  }
});

/** An upload started before the removal may still land: purge refuses until it cannot. */
const uploadOpen = ({ until }: UploadAuthorityOpen) =>
  new ProjectPurgeIncomplete({
    message: `An upload this project started may still land until ${until.toISOString()}. Purge again after then to finish.`,
  });

/** A total, or null when any part of it could not be measured. */
const sumOrNull = (values: ReadonlyArray<number | null>) =>
  values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** This removal's mark went to another removal while it deleted: it stops where it is. */
class MarkLost extends Data.TaggedError("MarkLost") {}

const activityOf = (
  session: Session,
  role: SessionRole,
  facts: {
    readonly starting: ReadonlySet<string>;
    readonly running: ReadonlySet<string>;
    readonly forwarding: ReadonlySet<string>;
  },
): SessionActivity | "settled" => {
  if (LIVE_STATES.has(session.status)) return "live";
  if (facts.starting.has(session.id)) return "starting";
  // A holder that is stopping still holds: its drain is saving the repository's files.
  if (role === "holder" && session.status === "stopping") return "stopping";
  if (facts.running.has(session.id)) return "process-running";
  if (facts.forwarding.has(session.id)) return "forward-open";
  return "settled";
};

const refused = (
  scope: "worktree" | "project",
  blockers: NonEmptyBlockers,
  forceWouldLift: boolean,
) =>
  new RemovalRefused({
    scope,
    blockers,
    forceWouldLift,
    message:
      scope === "worktree"
        ? worktreeRefusalWords({ blockers, forceWouldLift }, "in-mend")
        : projectRefusalWords(blockers, "in-mend"),
  });

type StandingServices = Effect.Services<ReturnType<typeof changeStandingOf>>;

/** A session working in a worktree, and how. */
interface Member {
  readonly session: Session;
  readonly role: SessionRole;
}

export const RemovalLive: Layer.Layer<
  Removal,
  never,
  | StandingServices
  | AuditEventsRepo
  | CaptureRuntime
  | ProjectsRepo
  | RemovalFencesRepo
  | ResourceRemoval
  | ServiceForwardsRepo
  | ServicesRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionRepositoriesRepo
  | SessionsRepo
  | SetupRunsRepo
  | Store
  | BlobStore
  | UsersRepo
  | WorktreeChangesRepo
  | WorktreesRepo
> = Layer.effect(
  Removal,
  Effect.gen(function* () {
    const capture = yield* CaptureRuntime;
    const audit = yield* AuditEventsRepo;
    const fences = yield* RemovalFencesRepo;
    const worktrees = yield* WorktreesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const repositories = yield* SessionRepositoriesRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const forwards = yield* ServiceForwardsRepo;
    const setupRuns = yield* SetupRunsRepo;
    const changes = yield* WorktreeChangesRepo;
    const users = yield* UsersRepo;
    const engine = yield* SessionEngine;
    const store = yield* Store;
    const resources = yield* ResourceRemoval;
    const blobs = yield* BlobStore;
    const removeProof = (worktreeId: WorktreeId) =>
      Effect.gen(function* () {
        const change = yield* changes.byWorktree(worktreeId);
        if (change === null) return;
        for (const blob of yield* blobs.list(proofBlobPrefix(change.id)))
          yield* blobs.remove(blob.key);
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("proof artifacts: blob cleanup failed; retry removal").pipe(
            Effect.annotateLogs({ worktreeId, operation: error.operation }),
          ),
        ),
      );
    // What reading a change's standing asks for: landings, the worktree's files, origin.
    const standingServices = yield* Effect.context<StandingServices>();

    const personOf = Effect.fn("Removal.personOf")(function* (userId: string | null) {
      if (userId === null) return null;
      const facts = yield* users.byId(userId);
      return { userId, name: facts?.name ?? userId } satisfies Person;
    });

    /**
     * Every session working in the worktree (`RemovalFencesRepo.sessionsIn`, the inverse of the
     * places the fence refuses new work in), with how each works there.
     */
    const membersOf = Effect.fn("Removal.membersOf")(function* (worktree: Worktree) {
      const held = new Set(
        (yield* repositories.listForWorktree(worktree.id)).map((row) => row.sessionId),
      );
      const found = yield* Effect.forEach(yield* fences.sessionsIn(worktree.id), (sessionId) =>
        sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null))),
      );
      return found.flatMap((session): ReadonlyArray<Member> => {
        if (session === null) return [];
        const role: SessionRole =
          session.worktreeId === worktree.id
            ? "inhabitant"
            : held.has(session.id)
              ? "holder"
              : "linked";
        return [{ session, role }];
      });
    });

    /** Each settled member's unexited processes and open Service forwards. */
    const processesAndForwards = Effect.fn("Removal.processesAndForwards")(function* (
      members: ReadonlyArray<Member>,
      openServices: ReadonlySet<string>,
    ) {
      const running = new Set<string>();
      const forwarding = new Set<string>();
      for (const { session } of members) {
        if (LIVE_STATES.has(session.status)) continue;
        const unexited = (yield* processes.listForSession(session.id)).some(
          (process) => process.exitedAt === null,
        );
        if (unexited) running.add(session.id);
        const serviceIds = (yield* services.listForSession(session.id)).map(
          (service) => service.id,
        );
        if (serviceIds.some((id) => openServices.has(id))) forwarding.add(session.id);
      }
      return { running, forwarding };
    });

    /** The Services with a forward open now: read once per removal. */
    const openServicesNow = Effect.suspend(() => forwards.listOpen()).pipe(
      Effect.map((open) => new Set<string>(open.map((forward) => forward.serviceId))),
    );

    /**
     * What every worktree removal reads: the sessions working in the worktree, each classified
     * once, the Service setups running there, and unsaved captures on it and on its holders'
     * worktrees. Admitted starts are read first: one that ends before its session is read has
     * written what the session read then shows.
     */
    const worktreeHolds = Effect.fn("Removal.worktreeHolds")(function* (
      worktree: Worktree,
      openServices: ReadonlySet<string>,
    ) {
      const starting = new Set<SessionId>(yield* fences.startingIn(worktree.id));
      const members = yield* membersOf(worktree);
      const { running, forwarding } = yield* processesAndForwards(members, openServices);
      const sessionFacts = yield* Effect.forEach(members, ({ session, role }) =>
        Effect.gen(function* () {
          return {
            sessionId: session.id,
            owner: yield* personOf(session.ownerUserId),
            role,
            activity: activityOf(session, role, { starting, running, forwarding }),
          } satisfies SessionFact;
        }),
      );
      const own = (yield* engine.captureHolds(worktree.id)).map(
        (hold): HoldFact => ({ ...hold, via: "own" }),
      );
      // A holder's files for this repository travel with its own worktree's captures.
      const viaHolders = (yield* Effect.forEach(
        members.filter((member) => member.role === "holder"),
        ({ session }) => engine.captureHolds(session.worktreeId),
      ))
        .flat()
        .map((hold): HoldFact => ({ ...hold, via: "holder" }));
      return {
        worktreeId: worktree.id,
        name: worktree.name,
        changeOwner: yield* personOf(worktree.changeOwnerUserId),
        sessions: sessionFacts,
        holds: [...own, ...viaHolders],
        setupRunning: yield* setupRuns.unendedInWorktree(worktree.id),
      } satisfies WorktreeHolds;
    });

    /**
     * Everything a removal without force reads about one worktree: its holds, where its change
     * stands, and the repositories nested inside it (docs/adr/0011), kept after the session that
     * added them is gone. A change that cannot be read stands in the way with the rest.
     */
    const worktreeFacts = Effect.fn("Removal.worktreeFacts")(function* (
      project: Project,
      worktree: Worktree,
      callerUserId: string,
      openServices: ReadonlySet<string>,
    ) {
      const holds = yield* worktreeHolds(worktree, openServices);
      const standing = yield* changeStandingOf({
        change: yield* changes.byWorktree(worktree.id),
        project,
        worktree,
        userId: callerUserId,
      }).pipe(
        Effect.provideContext(standingServices),
        Effect.catch(
          (error): Effect.Effect<ChangeStanding> =>
            Effect.succeed({
              _tag: "unread",
              reason:
                error._tag === "GitError" && error.stderr !== ""
                  ? error.stderr
                  : error._tag === "WorktreeNotCapturedError"
                    ? error.message
                    : `the change in ${worktree.name} could not be read`,
            }),
        ),
      );
      const nested = yield* worktrees.nestedRepositories(worktree.id);
      return { ...holds, standing, nestedRepositories: nested } satisfies WorktreeFacts;
    });

    /** Keeps mark `id` fresh for as long as `work` runs, checking or deleting. */
    const renewing = <A, E>(row: FencedRow, id: RemovalFenceId, work: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const renew = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(REMOVAL_FENCE_RENEW_EVERY);
            if (!(yield* fences.renew(row, id))) return;
          }
        });
        const renewal = yield* Effect.forkChild(Effect.interruptible(renew));
        return yield* work.pipe(Effect.ensuring(Fiber.interrupt(renewal)));
      });

    /**
     * Marks the worktree, then reads who may remove it and what stands in the way under that
     * mark, and either gives the mark back and refuses, or commits it and deletes. `finish` skips
     * the decision: an earlier removal passed it and stopped while deleting. The deletion runs to
     * its end even when the request goes away, renewing the mark, and asks before each destructive
     * step whether the mark is still its own. A deletion that fails keeps the mark, open for the
     * next removal to finish at once. A removal that meets another under way reports that with
     * every other blocker, read without a mark.
     */
    const removeWorktree = Effect.fn("Removal.worktree")(function* (
      target: Worktree,
      caller: RemovalCaller,
      force: boolean,
    ) {
      const row = { kind: "worktree", id: target.id } as const;
      const notFound = new WorktreeNotFound({ id: target.id });
      const project = yield* projects
        .byId(target.projectId)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.fail(notFound)));
      // The owner a first session records while the route reads decides, so this reads afresh.
      const authorize = Effect.gen(function* () {
        const current = yield* worktrees
          .byId(target.id)
          .pipe(Effect.catchTag("WorktreeNotFoundError", () => Effect.fail(notFound)));
        const right = worktreeRemovalRight({
          callerUserId: caller.userId,
          changeOwner: yield* personOf(current.changeOwnerUserId),
          changeOwnerProven: current.changeOwnerProven,
          managesProject: caller.managesProject,
          ownsEverySession: (yield* membersOf(current)).every(
            ({ session }) => session.ownerUserId === caller.userId,
          ),
        });
        if (right._tag === "hidden") return yield* notFound;
        if (right._tag === "not-change-owner") {
          return yield* new RemovalForbidden({
            owner: right.owner,
            message: notChangeOwnerWords(right.owner, "in-mend"),
          });
        }
        return current;
      });
      const decide = (current: Worktree) =>
        Effect.gen(function* () {
          const openServices = yield* openServicesNow;
          return force
            ? decideRemoval({
                kind: "worktree",
                force,
                worktree: yield* worktreeHolds(current, openServices),
              })
            : decideRemoval({
                kind: "worktree",
                force,
                worktree: yield* worktreeFacts(project, current, caller.userId, openServices),
              });
        });
      // Refused before any mark is taken; asked again under it, where the answer holds.
      yield* authorize;
      const taken = yield* fences.take(row);
      if (taken._tag === "gone") return yield* notFound;
      if (taken._tag === "underway") {
        const decision = yield* decide(yield* authorize);
        return yield* refused("worktree", underwayWith(taken.stopped, decision), false);
      }
      const giveBack =
        taken._tag === "held" ? fences.release(row, taken.id) : fences.handOver(row, taken.id);
      const current = yield* authorize.pipe(Effect.onError(() => giveBack));
      if (taken._tag === "held") {
        const decision = yield* renewing(row, taken.id, decide(current)).pipe(
          Effect.onError(() => giveBack),
        );
        if (decision._tag === "Refuse") {
          yield* giveBack;
          return yield* refused("worktree", decision.blockers, decision.forceWouldLift);
        }
      }
      const step = fences
        .renew(row, taken.id)
        .pipe(Effect.flatMap((held) => (held ? Effect.void : Effect.fail(new MarkLost()))));
      const lost = refused("worktree", underway(null), false);
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (
            taken._tag === "held" &&
            !(yield* fences.commit(row, taken.id).pipe(Effect.onError(() => giveBack)))
          ) {
            yield* giveBack;
            return yield* lost;
          }
          return yield* renewing(
            row,
            taken.id,
            Effect.gen(function* () {
              yield* step;
              const resourceStatusLines = yield* resources
                .worktree(project, current.id)
                .pipe(
                  Effect.mapError((error) =>
                    refused(
                      "worktree",
                      [{ _tag: "ResourcePreservationFailed", message: error.message }],
                      false,
                    ),
                  ),
                );
              yield* step;
              const { leftover } = yield* store.removeWorktreeForce(
                project.storePath,
                current.directory,
              );
              yield* step;
              // Keep the fenced row on failure so retrying removal can finish blob cleanup.
              yield* removeProof(current.id).pipe(Effect.orDie);
              // Sessions, change, chain, and review artifacts cascade with the row.
              yield* worktrees.remove(current.id);
              return new RemovalReport({
                removed: true,
                leftover,
                ...(resourceStatusLines.length === 0 ? {} : { resourceStatusLines }),
              });
            }),
          ).pipe(
            Effect.onError(() => fences.handOver(row, taken.id)),
            Effect.catchTag("MarkLost", () => Effect.fail(lost)),
          );
        }),
      );
    });

    /**
     * Removal deletes nothing: it marks the project, reads what stands in the way under that
     * mark, and either gives the mark back and refuses, or keeps the project in one transaction,
     * which leaves it listed or removed and never half.
     */
    const removeProject = Effect.fn("Removal.project")(function* (
      target: Project,
      caller: RemovalCaller,
    ) {
      const row = { kind: "project", id: target.id } as const;
      const notFound = new NotFound({ id: target.id });
      // Soft removal remains reversible. Resource containers and data are archived at purge,
      // under its durable fence, before the first destructive step.
      const decide = Effect.gen(function* () {
        const openServices = yield* openServicesNow;
        const facts = yield* Effect.forEach(
          yield* worktrees.listForProject(target.id),
          (worktree) => worktreeFacts(target, worktree, caller.userId, openServices),
          { concurrency: 4 },
        );
        return decideRemoval({
          kind: "project",
          project: { worktrees: facts },
        });
      });
      const taken = yield* fences.take(row);
      if (taken._tag === "gone") return yield* notFound;
      if (taken._tag === "underway")
        return yield* refused("project", underwayWith(taken.stopped, yield* decide), false);
      // `deleting` comes only with removed_at (migration 0167), and `take` answers a removed
      // project `gone`: a listed project has no stopped deletion to finish.
      if (taken._tag === "finish")
        return yield* Effect.die("a listed project had a stopped deletion to finish");
      const release = fences.release(row, taken.id);
      const decision = yield* renewing(row, taken.id, decide).pipe(Effect.onError(() => release));
      if (decision._tag === "Refuse") {
        yield* release;
        return yield* refused("project", decision.blockers, decision.forceWouldLift);
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const kept = yield* fences
            .keep(target.id, taken.id, caller.userId)
            .pipe(Effect.onError(() => release));
          if (kept !== "kept") {
            yield* release;
            return yield* kept === "forbidden"
              ? notFound
              : refused("project", underway(null), false);
          }
          // Hot workspaces hold nobody's work: the pool drains a removed project's standbys,
          // and its sweep retries any it could not stop.
          yield* engine.reconcileHotSessions(target.id);
          return new ProjectRemovalReport({
            removed: true,
            leftover: null,
            retained: true,
            message:
              "Project removed. Its files and history are kept. Restore it from Removed projects.",
          });
        }),
      );
    });

    const disk = Effect.fn("Removal.disk")(function* (viewer: Viewer) {
      // An owner answers for the organization's disk: a departed member's kept project too.
      const kept = (yield* projects.removedForOrganization(viewer.organizationId)).filter(
        ({ project }) => viewer.role === "owner" || canSeeProject(project, viewer),
      );
      const sizes = yield* Effect.forEach(
        kept,
        ({ project }) =>
          Effect.all({
            files: store.projectDiskUsage(project.storePath),
            objects: capture.enabled
              ? worktrees.listForProject(project.id).pipe(
                  Effect.flatMap((trees) =>
                    keptObjectBytes(
                      capture,
                      project.id,
                      trees.map((tree) => tree.id),
                    ),
                  ),
                )
              : Effect.succeed({ own: 0, shared: 0 }),
          }),
        { concurrency: 4 },
      );
      return new RemovedProjectsDisk({
        projects: kept.length,
        bytes: sumOrNull(sizes.flatMap(({ files, objects }) => [files, objects?.own ?? null])),
        sharedBytes: sumOrNull(sizes.map(({ objects }) => objects?.shared ?? null)),
      });
    });

    const removed = Effect.fn("Removal.removed")(function* (viewer: Viewer) {
      return (yield* projects.removedForOrganization(viewer.organizationId))
        .filter(({ project }) => canSeeProject(project, viewer))
        .map(
          ({ project, removedAt, removedByUserId, state }) =>
            new RemovedProject({
              id: project.id,
              name: project.name,
              organizationId: project.organizationId,
              visibility: project.visibility,
              createdByUserId: project.createdByUserId,
              removedAt,
              removedByUserId,
              state,
              rights: {
                ...projectRetentionRights(project, viewer),
                restore: state === "removed" && canRemoveProject(project, viewer),
              },
            }),
        );
    });

    const retentionForbidden = new ProjectRetentionForbidden({
      message:
        "Only the private project's creator or an organization owner for a shared project can Restore or purge it.",
    });

    const authorizedRetained = Effect.fn("Removal.authorizedRetained")(function* (
      id: ProjectId,
      viewer: Viewer,
    ) {
      const kept = yield* projects.removedById(id);
      if (kept === null || !canSeeProject(kept.project, viewer)) return yield* new NotFound({ id });
      if (!canRemoveProject(kept.project, viewer)) return yield* retentionForbidden;
      return kept;
    });

    const restore = Effect.fn("Removal.restore")(function* (
      id: ProjectId,
      viewer: Viewer,
      name?: string,
    ) {
      const listed = yield* projects
        .byId(id)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
      if (listed !== null) {
        if (!canSeeProject(listed, viewer)) return yield* new NotFound({ id });
        if (!canRemoveProject(listed, viewer))
          return yield* new ProjectRetentionForbidden({
            message: "You cannot Restore this project.",
          });
        return listed;
      }
      const kept = yield* authorizedRetained(id, viewer);
      if (kept.state !== "removed")
        return yield* new ProjectRestoreUnavailable({
          message:
            kept.state === "recovery-required"
              ? "An earlier deletion stopped partway. The inventory of files and records it deleted is missing, so completeness cannot be proved. Purge again to finish deleting it."
              : "Purge has started. Its files may be incomplete. Purge again to finish.",
        });
      const problem = yield* store.retainedStoreProblem(
        kept.project.storePath,
        capture.enabled
          ? []
          : (yield* worktrees.listForProject(id)).map((worktree) => worktree.directory),
      );
      if (problem !== null) return yield* new ProjectRestoreUnavailable({ message: problem });
      const outcome = yield* fences.restore(id, viewer.userId, name ?? kept.project.name).pipe(
        Effect.catchTag("ProjectNameTakenError", () =>
          Effect.fail(
            new ProjectNameConflict({
              name: name ?? kept.project.name,
              message: "A listed project has that name. Supply a new name to Restore this project.",
            }),
          ),
        ),
      );
      if (outcome === "gone") return yield* new NotFound({ id });
      if (outcome === "forbidden") return yield* retentionForbidden;
      if (outcome === "purging" || outcome === "legacy")
        return yield* new ProjectRestoreUnavailable({
          message: "Purge has started. Purge again to finish.",
        });
      return yield* projects
        .byId(id)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.fail(new NotFound({ id }))));
    });

    /**
     * The organization's record that `id` was purged, when the viewer is someone who could have
     * purged it: an owner for a shared project, its creator (who purged it) for a private one.
     */
    const purgedEarlier = Effect.fn("Removal.purgedEarlier")(function* (
      id: ProjectId,
      viewer: Viewer,
    ) {
      const event = yield* audit.latest({
        organizationId: viewer.organizationId,
        action: "project.purged",
        subjectId: id,
      });
      if (event === null) return null;
      const visibility = Schema.decodeUnknownOption(ProjectVisibility)(event.data["visibility"]);
      if (Option.isNone(visibility)) return null;
      const tenancy = {
        organizationId: event.organizationId,
        visibility: visibility.value,
        createdByUserId: visibility.value === "private" ? event.actorUserId : null,
      };
      return canRemoveProject(tenancy, viewer) ? event : null;
    });

    const purge = Effect.fn("Removal.purge")(function* (
      id: ProjectId,
      viewer: Viewer,
      confirm: string,
    ) {
      // The row goes in the transaction that records `project.purged`, so an id has one or the other.
      const earlier = yield* purgedEarlier(id, viewer);
      if (earlier !== null) {
        const name = earlier.data["name"];
        return new ProjectPurgeReport({
          id,
          purged: true,
          alreadyPurged: true,
          message: `${typeof name === "string" ? name : "This project"} was already purged on ${earlier.createdAt.toISOString().slice(0, 10)}. Nothing is left to delete.`,
        });
      }
      const kept = yield* authorizedRetained(id, viewer);
      if (confirm !== kept.project.name)
        return yield* new PurgeNotConfirmed({
          message: "Type the project's name exactly to confirm purge.",
        });
      // Asked before the mark too, so a purge that cannot start leaves the project restorable.
      if (capture.enabled)
        yield* uploadsLanded(
          capture,
          (yield* worktrees.listForProject(id)).map((tree) => tree.id),
        ).pipe(Effect.mapError(uploadOpen));
      const taken = yield* fences.takePurge(id, viewer.userId, {
        name: kept.project.name,
        removedAt: kept.removedAt,
      });
      if (taken._tag === "gone") return yield* new NotFound({ id });
      if (taken._tag === "forbidden") return yield* retentionForbidden;
      if (taken._tag === "changed")
        return yield* new PurgeNotConfirmed({
          message:
            "This project was restored, renamed or removed again since you confirmed. Check its name and confirm purge again.",
        });
      if (taken._tag === "underway")
        return yield* new RemovalRefused({
          scope: "project",
          blockers: underway(taken.stopped),
          forceWouldLift: false,
          message:
            "Another purge of this project is under way. Purge again later to see its result.",
        });
      const row = { kind: "project", id } as const;
      // Asked before every destructive step: once another purge took the mark, this one stops.
      const holding = fences.renew(row, taken.id).pipe(
        Effect.flatMap((held) =>
          held
            ? Effect.void
            : Effect.fail(
                new ProjectPurgeIncomplete({
                  message: "Another purge took over this one. Retry purge to observe its result.",
                }),
              ),
        ),
      );
      return yield* Effect.uninterruptible(
        renewing(
          row,
          taken.id,
          Effect.gen(function* () {
            yield* holding;
            const resourceStatusLines = yield* resources
              .project(kept.project)
              .pipe(
                Effect.mapError((error) => new ProjectPurgeIncomplete({ message: error.message })),
              );
            yield* holding;
            if (capture.enabled)
              yield* purgeProjectBlobs(
                capture,
                { projectId: id, mark: taken.id },
                (yield* worktrees.listForProject(id)).map((tree) => tree.id),
                yield* worktrees.handoffPacks(id),
                holding,
              ).pipe(
                Effect.catchTags({
                  PurgeBlobFailure: () =>
                    Effect.fail(
                      new ProjectPurgeIncomplete({
                        message: "Some stored objects could not be deleted. Purge again to finish.",
                      }),
                    ),
                  UploadAuthorityOpen: (open) => Effect.fail(uploadOpen(open)),
                }),
              );
            yield* holding;
            for (const tree of yield* worktrees.listForProject(id)) {
              yield* holding;
              yield* removeProof(tree.id).pipe(
                Effect.mapError(
                  () =>
                    new ProjectPurgeIncomplete({
                      message: "Some proof media could not be deleted. Purge again to finish.",
                    }),
                ),
              );
            }
            const { leftover, outsideRoot } = yield* store.removeProjectStore(
              kept.project.storePath,
            );
            if (outsideRoot !== undefined)
              return yield* new ProjectPurgeIncomplete({
                message: `The kept store is at ${leftover ?? kept.project.storePath}, outside the store root ${outsideRoot} Mend runs with now, so nothing there was deleted. Run Mend with the store root the project was adopted under and purge again.`,
              });
            if (leftover !== null)
              return yield* new ProjectPurgeIncomplete({
                message: `Some files under ${leftover} could not be deleted or checked. Fix their permissions and purge again to finish.`,
              });
            if (!(yield* fences.finishPurge(id, taken.id, viewer.userId)))
              return yield* new ProjectPurgeIncomplete({
                message: "Purge stopped before deleting records. Purge again to finish.",
              });
            return new ProjectPurgeReport({
              id,
              purged: true,
              alreadyPurged: false,
              message: [
                `Purged ${kept.project.name}. Instance audit and backups are unchanged.`,
                ...resourceStatusLines,
              ].join("\n"),
            });
          }),
        ).pipe(Effect.onError(() => fences.handOver(row, taken.id))),
      );
    });

    return { worktree: removeWorktree, project: removeProject, removed, restore, purge, disk };
  }),
);
