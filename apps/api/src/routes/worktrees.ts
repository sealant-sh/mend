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
  WorktreeRangeDiff,
  WorktreeRangeFile,
} from "@mend/api-contracts";
import {
  ProjectsRepo,
  SessionsRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionRepositoriesRepo,
  CheckpointsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { currentAgentProcess, heldRepositoriesRefusal } from "@mend/domain/workbench";
import { captureHoldWords, SessionEngine, WorktreeReads } from "@mend/sessions";
import { type DiffFileFact, Store } from "@mend/store";
import { Clock, Duration, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";
import { unlandedWork } from "../landing-state.ts";
import { LIVE_STATES, observationOf, readFailure, withinCheckpointLimit } from "./workbench.ts";

/**
 * A checkpoint slice's budget (`GET /worktrees/:id/diff`), for the whole request: listing its
 * files and rendering their patches share one deadline. The listing reads at most this much of
 * git's output, within its share of the time; past either it answers the first files, cut. Then
 * at most this many files' patches (as the live change's diff renders at most 200 untracked
 * files), within this many bytes and what is left of the deadline; past any, the rest are omitted
 * by name. Never a failure for size or time.
 */
const RANGE_DEADLINE_MS = 20_000;
const RANGE_LIST_DEADLINE_MS = 10_000;
const RANGE_LIST_BYTES = 8 * 1024 * 1024;
const RANGE_RENDER_FILES = 200;
const RANGE_RENDER_BYTES = 8 * 1024 * 1024;

/** A path as git prints it in a patch: bare, or C-quoted (`"a/x\ty"`) when it must be. */
const unquoted = (raw: string): string => {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: Array<number> = [];
  const body = raw.slice(1, -1);
  const escapes: Readonly<Record<string, number>> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1, index + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
};

/** `a/<path>` or `b/<path>` as a patch writes it, quoted or not; null for `/dev/null`. */
const sidePath = (raw: string): string | null => {
  const path = unquoted(raw.trim());
  if (path === "/dev/null") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
};

/**
 * Every path the patches in `diff` name: their rename and copy lines, their `---` and `+++`
 * lines, and the header of a patch with neither (a binary file, a mode change), whose two sides
 * are the same path.
 */
export const patchedPaths = (diff: string): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const lines = section.split("\n");
    let named = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
      const match =
        /^(?:rename|copy) (?:from|to) (.*)$/.exec(line) ?? /^(?:---|\+\+\+) (.*)$/.exec(line);
      if (match === null) continue;
      const path =
        line.startsWith("---") || line.startsWith("+++")
          ? sidePath(match[1] ?? "")
          : unquoted(match[1] ?? "");
      if (path !== null) paths.add(path);
      named = true;
    }
    if (named) continue;
    // `a/<p> b/<p>`: the same path both sides, so its length decides where it splits.
    const header = lines[0] ?? "";
    if (header.startsWith('"')) {
      const end = header.indexOf('" ', 1);
      const path = end === -1 ? null : sidePath(header.slice(0, end + 1));
      if (path !== null) paths.add(path);
      continue;
    }
    const side = (header.length - 5) / 2;
    if (Number.isInteger(side) && side > 0 && header.startsWith("a/")) {
      paths.add(header.slice(2, 2 + side));
    }
  }
  return paths;
};

/** A file of a slice by its path: the new one, else the old. */
const pathOf = (fact: DiffFileFact) => fact.newPath ?? fact.oldPath ?? "";

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
              pullRequest: facts?.pullRequest ?? null,
            });
          }),
        });
      }),
    )
    .handle("diff", ({ params, query }) =>
      Effect.gen(function* () {
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const chain = yield* (yield* CheckpointsRepo).listForWorktree(worktree.id);
        const to = chain.find((checkpoint) => checkpoint.id === query.to);
        if (to === undefined) return yield* new NotFound({ id: query.to });
        const from =
          query.from === undefined
            ? null
            : (chain.find((checkpoint) => checkpoint.id === query.from) ?? null);
        if (query.from !== undefined && from === null) {
          return yield* new NotFound({ id: query.from });
        }
        if (from !== null && from.ordinal > to.ordinal) {
          return yield* new StoreFailure({
            message: `checkpoint ${from.ordinal} comes after checkpoint ${to.ordinal}; a slice runs forward`,
          });
        }
        const fromSha = from?.sha ?? worktree.baseSha;
        const reads = yield* WorktreeReads;
        const options = query.whitespace === "ignore" ? { ignoreWhitespace: true } : {};
        const started = yield* Clock.currentTimeMillis;
        // The files first, within the listing budget: a slice too large or slow to list whole
        // answers its first files, cut. A path asked for is the only one git lists.
        const listed = yield* reads
          .diffFileFactsBounded(worktree.projectId, worktree.id, fromSha, to.sha, {
            ...options,
            ...(query.path === undefined ? {} : { paths: [query.path] }),
            maxBytes: RANGE_LIST_BYTES,
            deadlineMs: RANGE_LIST_DEADLINE_MS,
          })
          .pipe(
            Effect.mapError(readFailure),
            Effect.timeoutOrElse({
              duration: Duration.millis(RANGE_DEADLINE_MS),
              orElse: () => Effect.succeed(null),
            }),
          );
        const facts = listed?.value.facts ?? [];
        const listingCut = listed === null || listed.value.cut;
        // The pathspec also matches a directory's files: only the file itself is the answer.
        const wanted =
          query.path === undefined
            ? facts
            : facts.filter((fact) => fact.newPath === query.path || fact.oldPath === query.path);
        if (query.path !== undefined && wanted.length === 0 && !listingCut) {
          return yield* new NotFound({ id: query.path });
        }
        // Then the patches of the first files, within the budget and what is left of the
        // deadline: past either, the files rendered whole stay and the rest are named as omitted.
        const page = wanted.slice(0, RANGE_RENDER_FILES);
        const paths = [
          ...new Set(
            page.flatMap((fact) => [fact.oldPath, fact.newPath].filter((p) => p !== null)),
          ),
        ];
        const left = RANGE_DEADLINE_MS - ((yield* Clock.currentTimeMillis) - started);
        const rendered =
          page.length === 0 || left <= 0
            ? null
            : yield* reads
                .diffRange(worktree.projectId, worktree.id, fromSha, to.sha, {
                  ...options,
                  paths,
                  maxBytes: RANGE_RENDER_BYTES,
                })
                .pipe(
                  Effect.mapError(readFailure),
                  Effect.timeoutOrElse({
                    duration: Duration.millis(left),
                    orElse: () => Effect.succeed(null),
                  }),
                );
        const diff = rendered?.value ?? "";
        // One patch per file, in the files' order (both are git's, from the same range).
        // A file has a patch when a patch names it, not by counting patches: past git's rename
        // limit the listing shows a moved file as deleted and added, while the page, small enough,
        // renders it as one rename (601-R2-2).
        const patched = patchedPaths(diff);
        const omitted = wanted
          .filter(
            (fact) =>
              !(
                (fact.newPath !== null && patched.has(fact.newPath)) ||
                (fact.oldPath !== null && patched.has(fact.oldPath))
              ),
          )
          .map(pathOf);
        const stamp = (rendered ?? listed)?.stamp;
        return new WorktreeRangeDiff({
          worktreeId: worktree.id,
          from,
          to,
          fromSha,
          diff,
          files: wanted.map((fact) => new WorktreeRangeFile(fact)),
          truncated: omitted.length > 0 || listingCut,
          omitted,
          listingCut,
          ...(stamp === undefined ? {} : { observation: observationOf(stamp) }),
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
        const liveServices = new Map<string, number>(
          yield* (yield* ServicesRepo).liveCountsForSessions(members.map((session) => session.id)),
        );
        const bySession = new Map<string, Array<(typeof processRows)[number]>>();
        for (const row of processRows) {
          const list = bySession.get(row.sessionId);
          if (list === undefined) bySession.set(row.sessionId, [row]);
          else list.push(row);
        }
        const preReleaseMemory = yield* (yield* SessionEngine).preReleaseMemory(worktree.id);
        return new WorktreeDetail({
          worktree,
          change,
          checkpoints: chain,
          sessions: members,
          preReleaseMemory,
          sessionAnnotations: annotations
            .filter((annotation) => memberIds.has(annotation.sessionId))
            .map(
              (annotation) =>
                new SessionAnnotation({
                  ...annotation,
                  currentAgent: currentAgentProcess(bySession.get(annotation.sessionId) ?? []),
                  liveServices: liveServices.get(annotation.sessionId) ?? 0,
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
        // The conversations here, plus the sessions that hold this worktree as a repository
        // beside their own (docs/adr/0010): their owners have a say, and their liveness holds.
        const inhabitants = yield* sessions.listForWorktree(worktree.id);
        const holders = yield* Effect.forEach(
          yield* (yield* SessionRepositoriesRepo).listForWorktree(worktree.id),
          (row) =>
            sessions
              .byId(row.sessionId)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null))),
        );
        const holdingSessions = holders.flatMap((holder) =>
          holder === null || inhabitants.some((member) => member.id === holder.id) ? [] : [holder],
        );
        const members = [...inhabitants, ...holdingSessions];
        if (!manages && members.some((member) => member.ownerUserId !== caller.user.id)) {
          return yield* new WorktreeNotFound({ id: params.id });
        }
        // Refuse while anything lives here — a live conversation, a process
        // holding the workspace, or an open Service forward. Never silently stop. A holding
        // session that is `stopping` still holds: its drain is saving the repository's files.
        const liveSessions = members.filter(
          (session) =>
            LIVE_STATES.has(session.status) ||
            (session.status === "stopping" &&
              holdingSessions.some((holder) => holder.id === session.id)),
        );
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
        // Capture mode: the rows are an executor's identity and the chain its saved work. While a
        // drain runs, a drain kept its workspace, or an executor was not observed to end, they
        // stay — `force` overrides unlanded work, never unsaved work; the owner's "discard unsaved
        // and stop" is how that goes (docs/adr/0002, "Stop drains, then terminates").
        const holds = yield* (yield* SessionEngine).captureHolds(worktree.id);
        if (holds.length > 0) {
          return yield* new StoreFailure({
            message: `not removed · ${captureHoldWords(holds)} · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved`,
          });
        }
        // A holding session's files for this repository travel with ITS worktree's captures
        // (docs/adr/0010, today): while that worktree's executor saves, this one stays too.
        for (const holder of holdingSessions) {
          const holderHolds = yield* (yield* SessionEngine).captureHolds(holder.worktreeId);
          if (holderHolds.length > 0) {
            return yield* new StoreFailure({
              message: `not removed · a session holding this worktree as a repository is ${captureHoldWords(holderHolds)} · the worktree stays until that session's workspace has saved and ended`,
            });
          }
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
          const unlanded = yield* unlandedWork({
            change,
            project,
            worktree,
            userId: caller.user.id,
          }).pipe(Effect.mapError(readFailure));
          // The repositories this worktree's sessions added live nested inside it, outside its
          // change (`.mend/` is excluded), and go with it (docs/adr/0011): they refuse too.
          const held = yield* SessionRepositoriesRepo;
          const repositories = (yield* Effect.forEach(inhabitants, (session) =>
            held.listForSession(session.id),
          )).flat();
          const refusal = [unlanded, heldRepositoriesRefusal(repositories)]
            .filter((words) => words !== null)
            .join(" ");
          if (refusal !== "") return yield* new StoreFailure({ message: refusal });
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
            // A project Mend refuses (SHA-256, reftable): the reason, as the person reads it.
            Effect.catchTag("GitError", (error) =>
              Effect.fail(new StoreFailure({ message: error.stderr })),
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
          withinCheckpointLimit("The checkpoint"),
        );
      }),
    ),
);
