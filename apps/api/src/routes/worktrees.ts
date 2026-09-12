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
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import { Store } from "@mend/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { LIVE_STATES } from "./workbench.ts";

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
        yield* (yield* ProjectsRepo)
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
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
        yield* (yield* ProjectsRepo)
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
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
        const worktrees = yield* WorktreesRepo;
        const sessions = yield* SessionsRepo;
        const changes = yield* WorktreeChangesRepo;
        const checkpoints = yield* CheckpointsRepo;
        const processes = yield* SessionProcessesRepo;
        const worktree = yield* worktrees
          .byId(params.id)
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
        const worktree = yield* worktrees
          .byId(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const members = yield* sessions.listForWorktree(worktree.id);
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
        // An unreviewed diff refuses (evidence, not verdicts: the facts are
        // stated; `force=true` is the human's explicit override).
        if (query.force !== "true") {
          const reads = yield* WorktreeReads;
          const diff = (yield* reads.diffWorktree(project.id, worktree.id, worktree.baseSha).pipe(
            Effect.mapError(
              (error) =>
                new StoreFailure({
                  message:
                    error._tag === "GitError" ? error.stderr : String(error.message ?? error._tag),
                }),
            ),
          )).value;
          if (diff.trim() !== "") {
            return yield* new StoreFailure({
              message:
                "This worktree still contains a reviewable change. Review, export, commit, or discard it before removal — or pass force=true.",
            });
          }
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
        const engine = yield* SessionEngine;
        const caller = yield* CurrentUser;
        return yield* engine
          .provisionSessionIn(params.id, {
            harness: payload.harness,
            label: payload.label,
            ownerUserId: caller.user.id,
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
        const worktree = yield* worktrees
          .byId(params.id)
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
