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
  WorktreeNotFound,
} from "@mend/api-contracts";
import {
  type FencedRow,
  type RemovalFenceId,
  ProjectsRepo,
  REMOVAL_FENCE_RENEW_EVERY,
  RemovalFenced,
  RemovalFencesRepo,
  ResourcesRepo,
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
import {
  type ChangeStanding,
  decideRemoval,
  type HoldFact,
  type NonEmptyBlockers,
  notChangeOwnerWords,
  type Person,
  type Project,
  type Viewer,
  RemovedProject,
  canSeeProject,
  canRemoveProject,
  projectRetentionRights,
  projectRefusalWords,
  type RemovalDecision,
  type Session,
  type SessionActivity,
  type SessionFact,
  type SessionRole,
  type StoppedRemoval,
  underway,
  underwayWith,
  type Worktree,
  type WorktreeFacts,
  type WorktreeHolds,
  worktreeRefusalWords,
  worktreeRemovalRight,
} from "@mend/domain/workbench";
import { SessionEngine, CaptureRuntime } from "@mend/sessions";
import { Store } from "@mend/store";
import { Data, Effect, Fiber, Layer } from "effect";
import * as Context from "effect/Context";

import { changeStandingOf } from "./landing-state.ts";
import { LIVE_STATES } from "./live-states.ts";
import { purgeProjectBlobs } from "./project-purge-blobs.ts";

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
    readonly disk: (
      viewer: Viewer,
    ) => Effect.Effect<{ readonly projects: number; readonly bytes: number | null }>;
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
  | CaptureRuntime
  | ProjectsRepo
  | RemovalFencesRepo
  | ResourcesRepo
  | ServiceForwardsRepo
  | ServicesRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionRepositoriesRepo
  | SessionsRepo
  | SetupRunsRepo
  | Store
  | UsersRepo
  | WorktreeChangesRepo
  | WorktreesRepo
> = Layer.effect(
  Removal,
  Effect.gen(function* () {
    const capture = yield* CaptureRuntime;
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
    const resources = yield* ResourcesRepo;
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
     * Marks `row`, then reads who may remove it and what stands in the way under that mark, and
     * either gives the mark back and refuses, or commits it and deletes. `finish` skips the
     * decision: an earlier removal passed it and stopped while deleting. The deletion runs to its
     * end even when the request goes away, renewing the mark, and asks before each destructive
     * step whether the mark is still its own. A deletion that fails keeps the mark, open for the
     * next removal to finish at once. A removal that meets another under way reports that with
     * every other blocker, read without a mark.
     */
    const underFence = <Target, Denied, E, Gone, Report>(
      row: FencedRow,
      scope: "worktree" | "project",
      steps: {
        readonly authorize: Effect.Effect<Target, Denied>;
        readonly decide: (target: Target) => Effect.Effect<RemovalDecision, E>;
        /** `step` answers MarkLost once the mark is another removal's. */
        readonly remove: (
          target: Target,
          step: Effect.Effect<void, MarkLost>,
        ) => Effect.Effect<Report, MarkLost>;
        readonly gone: Gone;
        /** Moves the mark past the checks; fails `gone` once the caller may no longer remove. */
        readonly commit?: (target: Target, mark: RemovalFenceId) => Effect.Effect<boolean, Gone>;
      },
    ): Effect.Effect<Report, Denied | E | Gone | RemovalRefused> =>
      Effect.gen(function* () {
        const taken = yield* fences.take(row);
        if (taken._tag === "gone") return yield* Effect.fail(steps.gone);
        if (taken._tag === "underway") {
          const decision = yield* steps.decide(yield* steps.authorize);
          return yield* refused(scope, underwayWith(taken.stopped, decision), false);
        }
        const giveBack =
          taken._tag === "held" ? fences.release(row, taken.id) : fences.handOver(row, taken.id);
        const target = yield* steps.authorize.pipe(Effect.onError(() => giveBack));
        if (taken._tag === "held") {
          const decision = yield* renewing(row, taken.id, steps.decide(target)).pipe(
            Effect.onError(() => giveBack),
          );
          if (decision._tag === "Refuse") {
            yield* giveBack;
            return yield* refused(scope, decision.blockers, decision.forceWouldLift);
          }
        }
        const step = fences
          .renew(row, taken.id)
          .pipe(Effect.flatMap((held) => (held ? Effect.void : Effect.fail(new MarkLost()))));
        const lost = (stopped: StoppedRemoval | null) => refused(scope, underway(stopped), false);
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (
              taken._tag === "held" &&
              !(yield* (
                steps.commit === undefined
                  ? fences.commit(row, taken.id)
                  : steps.commit(target, taken.id)
              ).pipe(Effect.onError(() => giveBack)))
            ) {
              yield* giveBack;
              return yield* lost(null);
            }
            return yield* renewing(row, taken.id, steps.remove(target, step)).pipe(
              Effect.onError(() => fences.handOver(row, taken.id)),
              Effect.catchTag("MarkLost", () => Effect.fail(lost(null))),
            );
          }),
        );
      });

    const removeWorktree = Effect.fn("Removal.worktree")(function* (
      target: Worktree,
      caller: RemovalCaller,
      force: boolean,
    ) {
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
      // Refused before any mark is taken; asked again under it, where the answer holds.
      yield* authorize;
      return yield* underFence({ kind: "worktree", id: target.id }, "worktree", {
        authorize,
        decide: (current) =>
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
          }),
        remove: (current, step) =>
          Effect.gen(function* () {
            yield* step;
            const { leftover } = yield* store.removeWorktreeForce(
              project.storePath,
              current.directory,
            );
            yield* step;
            // Sessions, change, chain, and review artifacts cascade with the row.
            yield* worktrees.remove(current.id);
            return new RemovalReport({ removed: true, leftover });
          }),
        gone: notFound,
      });
    });

    const removeProject = Effect.fn("Removal.project")(function* (
      target: Project,
      caller: RemovalCaller,
    ) {
      return yield* underFence({ kind: "project", id: target.id }, "project", {
        authorize: Effect.succeed(target),
        commit: (_, mark) =>
          fences
            .keep(target.id, mark, caller.userId)
            .pipe(
              Effect.flatMap((outcome) =>
                outcome === "forbidden"
                  ? Effect.fail(new NotFound({ id: target.id }))
                  : Effect.succeed(outcome === "kept"),
              ),
            ),
        // Resources keep their data only in their volumes (docs/adr/0019, "Durability"): a
        // declaration made while this removal's mark stands is refused, so the names read here
        // are every one there will be.
        decide: () =>
          Effect.gen(function* () {
            const openServices = yield* openServicesNow;
            const facts = yield* Effect.forEach(
              yield* worktrees.listForProject(target.id),
              (worktree) => worktreeFacts(target, worktree, caller.userId, openServices),
              { concurrency: 4 },
            );
            return decideRemoval({
              kind: "project",
              project: { worktrees: facts, resources: yield* resources.declaredNames(target.id) },
            });
          }),
        remove: (_, step) =>
          Effect.gen(function* () {
            yield* step;
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
        gone: new NotFound({ id: target.id }),
      });
    });

    const disk = Effect.fn("Removal.disk")(function* (viewer: Viewer) {
      const kept = (yield* projects.removedForOrganization(viewer.organizationId)).filter(
        ({ project }) => canSeeProject(project, viewer),
      );
      const sizes = yield* Effect.forEach(
        kept,
        ({ project }) => store.projectDiskUsage(project.storePath),
        { concurrency: 4 },
      );
      return {
        projects: kept.length,
        bytes: sizes.some((size) => size === null)
          ? null
          : sizes.reduce<number>((total, size) => total + (size ?? 0), 0),
      };
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

    const purge = Effect.fn("Removal.purge")(function* (
      id: ProjectId,
      viewer: Viewer,
      confirm: string,
    ) {
      const kept = yield* authorizedRetained(id, viewer);
      if (confirm !== kept.project.name)
        return yield* new PurgeNotConfirmed({
          message: "Type the project's name exactly to confirm purge.",
        });
      const taken = yield* fences.takePurge(id, viewer.userId);
      if (taken._tag === "gone") return yield* new NotFound({ id });
      if (taken._tag === "forbidden") return yield* retentionForbidden;
      if (taken._tag === "underway")
        return yield* refused("project", underway(taken.stopped), false);
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
                  UploadAuthorityOpen: ({ until }) =>
                    Effect.fail(
                      new ProjectPurgeIncomplete({
                        message: `An upload this project started may still land until ${until.toISOString()}. Purge again after then to finish.`,
                      }),
                    ),
                }),
              );
            yield* holding;
            if (yield* projects.storeClaimed(kept.project.storePath, id))
              return yield* new ProjectPurgeIncomplete({
                message:
                  "Another project now claims this project's store directory, so its files were kept.",
              });
            const { leftover } = yield* store.removeProjectStore(kept.project.storePath);
            if (leftover !== null)
              return yield* new ProjectPurgeIncomplete({
                message:
                  "Some files could not be deleted. Fix their permissions and purge again to finish.",
              });
            if (!(yield* fences.finishPurge(id, taken.id, viewer.userId)))
              return yield* new ProjectPurgeIncomplete({
                message: "Purge stopped before deleting records. Purge again to finish.",
              });
            return new ProjectPurgeReport({ id, purged: true });
          }),
        ).pipe(Effect.onError(() => fences.handOver(row, taken.id))),
      );
    });

    return { worktree: removeWorktree, project: removeProject, removed, restore, purge, disk };
  }),
);
