import {
  CurrentUser,
  MendApi,
  NotFound,
  RemovalReport,
  SessionAnnotation,
  StoreFailure,
  WorktreeActive,
  WorktreeAnnotation,
  WorktreeDetail,
  WorktreeListing,
  WorktreeNameTaken,
  WorktreeNotFound,
} from "@mend/api-contracts";
import {
  ProjectsRepo,
  SessionsRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  CheckpointsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { currentAgentProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { Store } from "@mend/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";
import { unlandedWork } from "../landing-state.ts";
import { LIVE_STATES, readFailure } from "./workbench.ts";

/**
 * The worktree container's own verbs (plan §5.5/§5.6): provision the durable
 * place, list and read it, open conversations inside it, and the ONE explicit
 * destructive act that removes it with everything it owns.
 */
export const WorktreesGroupLive = HttpApiBuilder.group(MendApi, "worktrees", (handlers) =>
  handlers
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        const worktrees = yield* WorktreesRepo;
        const engine = yield* SessionEngine;
        yield* (yield* ProjectAccess).project(params.id);
        // This verb PROVISIONS; joining an existing name is the sessions verb.
        if (payload.name !== null) {
          const existing = yield* worktrees.byName(params.id, payload.name);
          if (existing !== null) {
            return yield* new WorktreeNameTaken({ projectId: params.id, name: payload.name });
          }
        }
        const caller = yield* CurrentUser;
        return yield* engine
          .ensureWorktree(params.id, { name: payload.name, base: payload.base }, caller.user.id)
          .pipe(
            Effect.catchTag("ProjectNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("GitError", (error) =>
              Effect.fail(new StoreFailure({ message: error.stderr })),
            ),
            // Unreachable after the byName check above, but the type is honest.
            Effect.catchTag("WorktreeBaseConflictError", (error) =>
              Effect.fail(new StoreFailure({ message: `worktree "${error.name}" already exists` })),
            ),
          );
      }),
    )
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const worktrees = yield* WorktreesRepo;
        const sessions = yield* SessionsRepo;
        const changes = yield* WorktreeChangesRepo;
        const processes = yield* SessionProcessesRepo;
        yield* (yield* ProjectAccess).project(params.id);
        const rows = yield* worktrees.listForProject(params.id);
        const projectSessions = yield* sessions.listForProject(params.id);
        const annotations = yield* changes.annotationsForProject(params.id);
        const processRows = yield* processes.listForSessions(
          projectSessions.map((session) => session.id),
        );
        return new WorktreeListing({
          worktrees: rows,
          annotations: rows.map((row) => {
            const members = projectSessions.filter((session) => session.worktreeId === row.id);
            const memberIds = new Set<string>(members.map((session) => session.id));
            // Every member session carries the worktree's change facts; any row will do.
            const facts = annotations.find((annotation) => memberIds.has(annotation.sessionId));
            return new WorktreeAnnotation({
              worktreeId: row.id,
              changeId: facts?.changeId ?? null,
              sessions: members.length,
              liveSessions: members.filter((session) => LIVE_STATES.has(session.status)).length,
              openComments: facts?.openComments ?? 0,
              totalComments: facts?.totalComments ?? 0,
              pendingFollowUp: annotations.some(
                (annotation) => memberIds.has(annotation.sessionId) && annotation.pendingFollowUp,
              ),
              currentAgent: currentAgentProcess(
                processRows.filter((process) => memberIds.has(process.sessionId)),
              ),
            });
          }),
        });
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const changes = yield* WorktreeChangesRepo;
        const checkpoints = yield* CheckpointsRepo;
        const processes = yield* SessionProcessesRepo;
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const members = yield* sessions.listForWorktree(worktree.id);
        const change = yield* changes.byWorktree(worktree.id);
        const chain = yield* checkpoints.listForWorktree(worktree.id);
        const annotations = yield* changes.annotationsForProject(worktree.projectId);
        const memberIds = new Set<string>(members.map((session) => session.id));
        const processRows = yield* processes.listForSessions(members.map((session) => session.id));
        const bySession = new Map<string, Array<(typeof processRows)[number]>>();
        for (const row of processRows) {
          const list = bySession.get(row.sessionId);
          if (list === undefined) bySession.set(row.sessionId, [row]);
          else list.push(row);
        }
        return new WorktreeDetail({
          worktree,
          change,
          checkpoints: chain,
          sessions: members,
          sessionAnnotations: annotations
            .filter((annotation) => memberIds.has(annotation.sessionId))
            .map(
              (annotation) =>
                new SessionAnnotation({
                  ...annotation,
                  currentAgent: currentAgentProcess(bySession.get(annotation.sessionId) ?? []),
                }),
            ),
        });
      }),
    )
    .handle("remove", ({ params, query }) =>
      Effect.gen(function* () {
        const worktrees = yield* WorktreesRepo;
        const sessions = yield* SessionsRepo;
        const projects = yield* ProjectsRepo;
        const processes = yield* SessionProcessesRepo;
        const services = yield* ServicesRepo;
        const forwards = yield* ServiceForwardsRepo;
        const store = yield* Store;
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        // Removal discards every conversation's record here: whoever manages the project, or a
        // caller who owns every session in the worktree.
        const caller = yield* CurrentUser;
        const manages = yield* (yield* ProjectAccess).manageProject(worktree.projectId).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
        const members = yield* sessions.listForWorktree(worktree.id);
        if (!manages && members.some((member) => member.ownerUserId !== caller.user.id)) {
          return yield* new WorktreeNotFound({ id: params.id });
        }
        // Refuse while anything lives here — a live conversation, a process
        // holding the workspace, or an open Service forward. Never silently stop.
        const liveSessions = members.filter((session) => LIVE_STATES.has(session.status));
        const openForwards = yield* forwards.listOpen();
        let liveHolds = liveSessions.length;
        for (const member of members) {
          if (LIVE_STATES.has(member.status)) continue;
          const memberProcesses = (yield* processes.listForSession(member.id)).filter(
            (process) => process.exitedAt === null,
          );
          const serviceIds = new Set(
            (yield* services.listForSession(member.id)).map((service) => service.id),
          );
          const memberForwards = openForwards.filter((forward) =>
            serviceIds.has(forward.serviceId),
          );
          if (memberProcesses.length > 0 || memberForwards.length > 0) liveHolds += 1;
        }
        if (liveHolds > 0) {
          return yield* new WorktreeActive({ id: params.id, liveSessions: liveHolds });
        }
        const project = yield* projects
          .byId(worktree.projectId)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: worktree.projectId })));
        // A change not on origin refuses (docs/adr/0007-landing.md, "Worktree removal"): the
        // refusal names the files and line counts that are not landed, and `force=true` is the
        // human's explicit override. A change whose last landing holds it, and whose commit
        // origin's branch still has, goes without one.
        if (query.force !== "true") {
          const change = yield* (yield* WorktreeChangesRepo).byWorktree(worktree.id);
          const refusal = yield* unlandedWork({
            change,
            project,
            worktree,
            userId: caller.user.id,
          }).pipe(Effect.mapError(readFailure));
          if (refusal !== null) return yield* new StoreFailure({ message: refusal });
        }
        const { leftover } = yield* store.removeWorktreeForce(
          project.storePath,
          worktree.directory,
        );
        // Sessions, change, chain, and review artifacts cascade with the row.
        yield* worktrees.remove(worktree.id);
        return new RemovalReport({ removed: true, leftover });
      }),
    )
    .handle("createSession", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const engine = yield* SessionEngine;
        const caller = yield* CurrentUser;
        return yield* engine
          .provisionSessionIn(params.id, {
            harness: payload.harness,
            label: payload.label,
            ownerUserId: caller.user.id,
            autoLand: payload.autoLand,
          })
          .pipe(
            Effect.catchTag("WorktreeNotFoundError", () =>
              Effect.fail(new WorktreeNotFound({ id: params.id })),
            ),
            Effect.catchTag("ProjectNotFoundError", (error) =>
              Effect.fail(new WorktreeNotFound({ id: error.projectId })),
            ),
          );
      }),
    )
    .handle("checkpoint", ({ params, payload }) =>
      Effect.gen(function* () {
        const worktrees = yield* WorktreesRepo;
        const changes = yield* WorktreeChangesRepo;
        const engine = yield* SessionEngine;
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        // Snapshot through a conversation: newest live wins, else the change's
        // last contributor — provenance stays honest either way.
        const change = yield* changes.byWorktree(worktree.id);
        const viaSessionId =
          (yield* worktrees.newestLiveSessionId(worktree.id)) ?? change?.sessionId ?? null;
        if (viaSessionId === null) {
          return yield* new StoreFailure({
            message: "No conversation has inhabited this worktree yet — start a session first.",
          });
        }
        return yield* engine.checkpointNow(viaSessionId, payload.trigger).pipe(
          Effect.catchTags({
            SessionNotFoundError: () => Effect.fail(new WorktreeNotFound({ id: params.id })),
            ProjectNotFoundError: () => Effect.fail(new WorktreeNotFound({ id: params.id })),
            GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
          }),
        );
      }),
    ),
);
