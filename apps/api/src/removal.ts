import {
  NotFound,
  RemovalForbidden,
  RemovalInProgress,
  RemovalRefused,
  RemovalReport,
  StoreFailure,
  WorktreeNotFound,
} from "@mend/api-contracts";
import {
  type FencedRow,
  type RemovalFenceId,
  HotWorkspacesRepo,
  isRemovalFenced,
  ProjectsRepo,
  RemovalFencesRepo,
  ResourcesRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionRepositoriesRepo,
  SessionsRepo,
  UsersRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import {
  type ChangeStanding,
  decideRemoval,
  REMOVAL_START_REFUSED,
  REMOVAL_FENCE_LEASE_SECONDS,
  type ForeignHolderFact,
  type HoldFact,
  type NonEmptyBlockers,
  notChangeOwnerWords,
  type Person,
  type Project,
  projectRefusalWords,
  type RemovalDecision,
  type Session,
  type SessionActivity,
  type SessionFact,
  underway,
  type Worktree,
  type WorktreeFacts,
  type WorktreeHolds,
  worktreeRefusalWords,
  worktreeRemovalRight,
  underwayWith,
} from "@mend/domain/workbench";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { Store } from "@mend/store";
import { Effect, Fiber, Layer } from "effect";
import * as Context from "effect/Context";

import { changeStandingOf } from "./landing-state.ts";
import { LIVE_STATES } from "./live-states.ts";

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
    ) => Effect.Effect<
      RemovalReport,
      WorktreeNotFound | RemovalForbidden | RemovalRefused | StoreFailure
    >;
    /** Refused while any worktree, anyone's, has work running, saving or not on origin. */
    readonly project: (
      project: Project,
      caller: RemovalCaller,
    ) => Effect.Effect<RemovalReport, NotFound | RemovalRefused | StoreFailure>;
  }
>()("@mend/api/Removal") {}

/** How often a removal renews its `checking` mark: well inside the lease. */
const RENEW_EVERY = `${Math.floor(REMOVAL_FENCE_LEASE_SECONDS / 4)} seconds` as const;

/** A session start in a worktree or project a removal has marked, refused before anything runs. */
export const refuseStartWhileRemoving = Effect.fn("refuseStartWhileRemoving")(function* (place: {
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId | null;
}) {
  if (!(yield* (yield* RemovalFencesRepo).admitsStart(place))) {
    return yield* new RemovalInProgress({ message: REMOVAL_START_REFUSED });
  }
});

/**
 * The same refusal, for a start whose insert met a mark taken after the check above: migration
 * 0164's trigger refused the session or worktree row.
 */
export const refusedWhileRemoving = <A, E, R>(
  start: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RemovalInProgress, R> =>
  start.pipe(
    Effect.catchCause(
      (cause): Effect.Effect<never, E | RemovalInProgress> =>
        isRemovalFenced(cause)
          ? Effect.fail(new RemovalInProgress({ message: REMOVAL_START_REFUSED }))
          : Effect.failCause(cause),
    ),
  );

const activityOf = (
  session: Session,
  role: SessionFact["role"],
  running: ReadonlySet<string>,
  forwarding: ReadonlySet<string>,
): SessionActivity | "settled" => {
  if (LIVE_STATES.has(session.status)) return "live";
  // A holder that is stopping still holds: its drain is saving the repository's files.
  if (role === "holder" && session.status === "stopping") return "stopping";
  if (running.has(session.id)) return "process-running";
  if (forwarding.has(session.id)) return "forward-open";
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

export const RemovalLive: Layer.Layer<
  Removal,
  never,
  | StandingServices
  | HotWorkspacesRepo
  | ProjectsRepo
  | RemovalFencesRepo
  | ResourcesRepo
  | SealantClient
  | ServiceForwardsRepo
  | ServicesRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionRepositoriesRepo
  | SessionsRepo
  | Store
  | UsersRepo
  | WorktreeChangesRepo
  | WorktreesRepo
> = Layer.effect(
  Removal,
  Effect.gen(function* () {
    const fences = yield* RemovalFencesRepo;
    const worktrees = yield* WorktreesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const repositories = yield* SessionRepositoriesRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const forwards = yield* ServiceForwardsRepo;
    const changes = yield* WorktreeChangesRepo;
    const users = yield* UsersRepo;
    const engine = yield* SessionEngine;
    const store = yield* Store;
    const resources = yield* ResourcesRepo;
    const hotWorkspaces = yield* HotWorkspacesRepo;
    const sealant = yield* SealantClient;
    // What reading a change's standing asks for: landings, the worktree's files, origin.
    const standingServices = yield* Effect.context<StandingServices>();

    const personOf = Effect.fn("Removal.personOf")(function* (userId: string | null) {
      if (userId === null) return null;
      const facts = yield* users.byId(userId);
      return { userId, name: facts?.name ?? userId } satisfies Person;
    });

    /** Each session's unexited processes and open Service forwards, read once. */
    const holdsOnWorkspaces = Effect.fn("Removal.holdsOnWorkspaces")(function* (
      members: ReadonlyArray<Session>,
    ) {
      const open = yield* forwards.listOpen();
      const running = new Set<string>();
      const forwarding = new Set<string>();
      for (const member of members) {
        if (LIVE_STATES.has(member.status)) continue;
        const unexited = (yield* processes.listForSession(member.id)).some(
          (process) => process.exitedAt === null,
        );
        if (unexited) running.add(member.id);
        const serviceIds = new Set(
          (yield* services.listForSession(member.id)).map((service) => service.id),
        );
        if (open.some((forward) => serviceIds.has(forward.serviceId))) forwarding.add(member.id);
      }
      return { running, forwarding };
    });

    /** The worktree's sessions, and the sessions holding it as a repository (docs/adr/0010). */
    const membersOf = Effect.fn("Removal.membersOf")(function* (worktree: Worktree) {
      const inhabitants = yield* sessions.listForWorktree(worktree.id);
      const holders = (yield* Effect.forEach(
        yield* repositories.listForWorktree(worktree.id),
        (row) =>
          sessions
            .byId(row.sessionId)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null))),
      )).flatMap((holder) =>
        holder === null || inhabitants.some((member) => member.id === holder.id) ? [] : [holder],
      );
      return { inhabitants, holders };
    });

    /**
     * What every worktree removal reads: the worktree's sessions and the sessions holding it as a
     * repository, each classified once, and unsaved captures on it and on those holders' worktrees.
     */
    const worktreeHolds = Effect.fn("Removal.worktreeHolds")(function* (worktree: Worktree) {
      const { inhabitants, holders } = yield* membersOf(worktree);
      const { running, forwarding } = yield* holdsOnWorkspaces([...inhabitants, ...holders]);
      const sessionFacts = yield* Effect.forEach(
        [
          ...inhabitants.map((session) => ({ session, role: "inhabitant" as const })),
          ...holders.map((session) => ({ session, role: "holder" as const })),
        ],
        ({ session, role }) =>
          Effect.gen(function* () {
            return {
              sessionId: session.id,
              owner: yield* personOf(session.ownerUserId),
              role,
              activity: activityOf(session, role, running, forwarding),
            } satisfies SessionFact;
          }),
      );
      const own = (yield* engine.captureHolds(worktree.id)).map(
        (hold): HoldFact => ({ ...hold, via: "own" }),
      );
      const viaHolders = (yield* Effect.forEach(holders, (holder) =>
        engine.captureHolds(holder.worktreeId),
      ))
        .flat()
        .map((hold): HoldFact => ({ ...hold, via: "holder" }));
      return {
        facts: {
          worktreeId: worktree.id,
          name: worktree.name,
          changeOwner: yield* personOf(worktree.changeOwnerUserId),
          sessions: sessionFacts,
          holds: [...own, ...viaHolders],
        } satisfies WorktreeHolds,
        inhabitants,
      };
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
    ) {
      const { facts } = yield* worktreeHolds(worktree);
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
                  : `the change in ${worktree.name} could not be read`,
            }),
        ),
      );
      const nested = yield* worktrees.nestedRepositories(worktree.id);
      return { ...facts, standing, nestedRepositories: nested } satisfies WorktreeFacts;
    });

    /** Sessions of other projects holding one of this project's worktrees as a repository. */
    const foreignHolders = Effect.fn("Removal.foreignHolders")(function* (project: Project) {
      const facts: Array<ForeignHolderFact> = [];
      for (const row of yield* repositories.listForProject(project.id)) {
        const holder = yield* sessions
          .byId(row.sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (holder === null || holder.projectId === project.id) continue;
        const { running, forwarding } = yield* holdsOnWorkspaces([holder]);
        facts.push({
          sessionId: holder.id,
          path: row.path,
          activity: activityOf(holder, "holder", running, forwarding),
        });
      }
      return facts;
    });

    /** Keeps this removal's `checking` mark fresh for as long as `checks` runs. */
    const renewing = <A, E>(row: FencedRow, id: RemovalFenceId, checks: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const renew = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(RENEW_EVERY);
            if (!(yield* fences.renew(row, id))) return;
          }
        });
        const renewal = yield* Effect.forkChild(renew);
        return yield* checks.pipe(Effect.ensuring(Fiber.interrupt(renewal)));
      });

    /**
     * Marks `row`, then reads who may remove it and what stands in the way under that mark, and
     * either gives the mark back and refuses, or commits it and deletes. `finish` skips the
     * decision: an earlier removal passed it and stopped while deleting. A deletion that fails
     * keeps the mark, open for the next removal to finish at once. A removal that meets another
     * under way reports that with every other blocker, read without a mark.
     */
    const underFence = <Target, Denied, E, Gone>(
      row: FencedRow,
      scope: "worktree" | "project",
      steps: {
        readonly authorize: Effect.Effect<Target, Denied>;
        readonly decide: (target: Target) => Effect.Effect<RemovalDecision, E>;
        readonly remove: (target: Target) => Effect.Effect<RemovalReport>;
        readonly gone: Gone;
      },
    ): Effect.Effect<RemovalReport, Denied | E | Gone | RemovalRefused> =>
      Effect.gen(function* () {
        const taken = yield* fences.take(row);
        if (taken._tag === "gone") return yield* Effect.fail(steps.gone);
        if (taken._tag === "underway") {
          const decision = yield* steps.decide(yield* steps.authorize);
          return yield* refused(scope, underwayWith(decision), false);
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
          if (!(yield* fences.commit(row, taken.id))) {
            yield* giveBack;
            return yield* refused(scope, underway, false);
          }
        }
        return yield* steps
          .remove(target)
          .pipe(Effect.onError(() => fences.handOver(row, taken.id)));
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
        const { inhabitants, holders } = yield* membersOf(current);
        const right = worktreeRemovalRight({
          callerUserId: caller.userId,
          changeOwner: yield* personOf(current.changeOwnerUserId),
          changeOwnerProven: current.changeOwnerProven,
          managesProject: caller.managesProject,
          ownsEverySession: [...inhabitants, ...holders].every(
            (session) => session.ownerUserId === caller.userId,
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
          force
            ? worktreeHolds(current).pipe(
                Effect.map(({ facts }) =>
                  decideRemoval({ kind: "worktree", force, worktree: facts }),
                ),
              )
            : worktreeFacts(project, current, caller.userId).pipe(
                Effect.map((facts) => decideRemoval({ kind: "worktree", force, worktree: facts })),
              ),
        remove: (current) =>
          Effect.gen(function* () {
            const { leftover } = yield* store.removeWorktreeForce(
              project.storePath,
              current.directory,
            );
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
        // Resources keep their data only in their volumes (docs/adr/0019, "Durability"): a
        // declaration made while this removal's mark stands is refused, so the names read here
        // are every one there will be.
        decide: () =>
          Effect.gen(function* () {
            const facts = yield* Effect.forEach(
              yield* worktrees.listForProject(target.id),
              (worktree) => worktreeFacts(target, worktree, caller.userId),
              { concurrency: 4 },
            );
            return decideRemoval({
              kind: "project",
              project: {
                worktrees: facts,
                foreignHolders: yield* foreignHolders(target),
                resources: yield* resources.declaredNames(target.id),
              },
            });
          }),
        remove: () =>
          Effect.gen(function* () {
            // Hot workspaces hold nobody's work: their rows cascade with the project, but the
            // containers would otherwise run until the platform's TTL.
            yield* Effect.forEach(
              yield* hotWorkspaces.listForProject(target.id),
              (entry) =>
                entry.sealantWorkspaceId === null
                  ? Effect.void
                  : sealant.getWorkspace(entry.sealantWorkspaceId).pipe(
                      Effect.flatMap((workspace) => sealant.stopWorkspace(workspace)),
                      Effect.ignore,
                      asSealantUser(entry.ownerUserId),
                    ),
              { concurrency: 4 },
            );
            const { leftover } = yield* store.removeProjectStore(target.storePath);
            yield* projects.remove(target.id);
            return new RemovalReport({ removed: true, leftover });
          }),
        gone: new NotFound({ id: target.id }),
      });
    });

    return { worktree: removeWorktree, project: removeProject };
  }),
);
