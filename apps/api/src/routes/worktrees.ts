import { IncomingMessage } from "node:http";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  CurrentUser,
  RawFileBusy,
  RawFilePreparing,
  RawFileNotFound,
  RawFileTooLarge,
  MendApi,
  NotFound,
  SessionAnnotation,
  StoreFailure,
  WorktreeAnnotation,
  WorktreeDetail,
  WorktreeListing,
  WorktreeNameTaken,
  WorktreeNotFound,
  WorktreeContents,
  WorktreeFile,
  WorktreeMatch,
  WorktreeRangeDiff,
  WorktreeRangeFile,
} from "@mend/api-contracts";
import {
  PreviewPreparationsRepo,
  PreviewsRepo,
  ServiceObservationsRepo,
  SessionsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  CheckpointsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { CheckpointId, WorktreeId } from "@mend/domain";
import {
  currentAgentProcess,
  previewStatusesOf,
  previewStatusLine,
  unpreparedStatusOf,
} from "@mend/domain/workbench";
import {
  SessionEngine,
  startFromBase,
  WorktreeReads,
  stampLabel,
  type RawView,
} from "@mend/sessions";
import { type DiffFileFact, isWorktreeRelativePath } from "@mend/store";
import { Clock, Context, Duration, Effect, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { Budgets } from "../budgets.ts";
import { LIVE_STATES } from "../live-states.ts";
import { PreviewSetupConfig } from "../preview-config.ts";
import { previewOpenOf } from "../preview-open.ts";
import { refuseStartWhileRemoving, Removal } from "../removal.ts";
import { budgetExceeded } from "../session-budgets.ts";
import { observationOf, readFailure, withinCheckpointLimit } from "./workbench.ts";

const rawFile = (
  id: WorktreeId,
  query: {
    readonly path: string;
    readonly within?: string | undefined;
    readonly at?: CheckpointId | undefined;
    readonly capture?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const worktree = yield* (yield* ProjectAccess)
      .worktree(id)
      .pipe(Effect.mapError(() => new WorktreeNotFound({ id })));
    if (query.at !== undefined && query.capture !== undefined)
      return yield* new RawFileNotFound({});
    let view: RawView =
      query.capture === undefined
        ? { kind: "current" }
        : { kind: "capture", captureId: query.capture };
    if (query.at !== undefined) {
      const checkpoints = yield* CheckpointsRepo;
      const chain = yield* checkpoints.listForWorktree(worktree.id);
      const checkpoint = chain.find(
        (item) => item.id === query.at && item.worktreeId === worktree.id,
      );
      if (checkpoint === undefined) return yield* new RawFileNotFound({});
      view = {
        kind: "checkpoint",
        commit: checkpoint.sha,
        captureId: yield* checkpoints.captureIdOf(checkpoint.id, worktree.id),
      };
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The one way to end a body whose headers went out: Node's adapter would end it short, and a
    // keep-alive client would wait for the rest.
    const reset = () => {
      if (request.source instanceof IncomingMessage)
        NodeHttpServerRequest.toServerResponse(request).destroy();
    };
    const full = yield* (yield* Budgets).rawReadSlot((yield* CurrentUser).user.id);
    if (full !== null) return yield* budgetExceeded(full, (yield* Budgets).limits);
    const file = yield* (yield* WorktreeReads)
      .openRawFile(worktree.projectId, worktree.id, {
        path: query.path,
        within: query.within ?? "",
        view,
      })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "preparing"
            ? new RawFilePreparing({})
            : error.reason === "full" || error.reason === "busy"
              ? new RawFileBusy({ reason: error.reason })
              : error.reason === "too-large"
                ? new RawFileTooLarge({})
                : new RawFileNotFound({}),
        ),
      );
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      "x-mend-file-path": encodeURIComponent(file.canonicalPath),
      "x-mend-file-revision": file.revision,
      "x-mend-file-identity": file.identity,
      "content-length": String(file.size),
      ...(file.stamp?.source === "capture" && file.stamp.captureId !== null
        ? {
            "x-mend-capture-id": file.stamp.captureId,
            "x-mend-observation": stampLabel(file.stamp),
          }
        : {}),
    };
    let offset = 0;
    let length = file.size;
    let status = 200;
    const range =
      request.method === "HEAD" || request.headers["if-range"] !== undefined
        ? undefined
        : request.headers.range;
    const match =
      range === undefined || range.length > 1024 ? null : /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (match !== null && (match[1] || match[2])) {
      const first = match[1] ? BigInt(match[1]) : null;
      const last = match[2] ? BigInt(match[2]) : null;
      const size = BigInt(file.size);
      if (!(first !== null && last !== null && last < first)) {
        if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
          return HttpServerResponse.empty({
            status: 416,
            headers: { ...headers, "content-length": "0", "content-range": `bytes */${size}` },
          });
        }
        const start = first ?? (last === null || last >= size ? 0n : size - last);
        const end = first === null || last === null || last >= size ? size - 1n : last;
        offset = Number(start);
        length = Number(end - start + 1n);
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
        headers["content-length"] = String(length);
      }
    }
    if (request.method === "HEAD") return HttpServerResponse.empty({ status, headers });
    const stall = Duration.toMillis(yield* RawReadStallLimit);
    let taken = yield* Clock.currentTimeMillis;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while ((yield* Clock.currentTimeMillis) - taken < stall) yield* Effect.sleep(stall / 4);
        reset();
      }),
    );
    return HttpServerResponse.stream(
      file.read(offset, length).pipe(
        Stream.tap(() =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            taken = now;
          }),
        ),
        Stream.onError(() => Effect.sync(reset)),
      ),
      { status, headers },
    );
  });

/**
 * How long a raw body waits for its reader to take the next chunk. A paused video or a sleeping
 * laptop stops reading without closing; its connection is reset, which frees the descriptor and
 * the read slot. Longer than a slow phone takes over one chunk. A reference so a test can shorten
 * it.
 */
export const RawReadStallLimit: Context.Reference<Duration.Duration> =
  Context.Reference<Duration.Duration>("@mend/api/RawReadStallLimit", {
    defaultValue: () => Duration.seconds(30),
  });

/** How much of one file a read answers: enough to show it, never a large artifact whole. */
const FILE_READ_LIMIT = 1024 * 1024;
/** How many matching lines one search answers at most. */
const CONTENT_SEARCH_LIMIT = 500;

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
          .ensureWorktree(
            params.id,
            { name: payload.name, start: startFromBase(payload.base) },
            caller.user.id,
          )
          .pipe(
            Effect.catchTag("ProjectNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("GitError", (error) =>
              Effect.fail(new StoreFailure({ message: error.stderr })),
            ),
            Effect.catchTags({
              WorktreeNameTakenError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              WorktreeStartUnsupportedError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
            }),
            // Unreachable after the byName check above, but the type is honest.
            Effect.catchTag("WorktreeBaseConflictError", (error) =>
              Effect.fail(new StoreFailure({ message: `worktree "${error.name}" already exists` })),
            ),
          );
      }),
    )
    .handle("raw", ({ params, query }) => rawFile(params.id, query))
    .handle("rawHead", ({ params, query }) => rawFile(params.id, query))
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
        // answers its first files, cut, at least the page rendered whole below. A path asked for
        // is the only one git lists.
        const listed = yield* reads
          .diffFileFactsBounded(worktree.projectId, worktree.id, fromSha, to.sha, {
            ...options,
            ...(query.path === undefined ? {} : { paths: [query.path] }),
            maxBytes: RANGE_LIST_BYTES,
            deadlineMs: RANGE_LIST_DEADLINE_MS,
            minFiles: RANGE_RENDER_FILES,
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
    .handle("contents", ({ params, query }) =>
      Effect.gen(function* () {
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const reads = yield* WorktreeReads;
        if ((query.path === undefined) === (query.query === undefined)) {
          return yield* new StoreFailure({
            message: "name either a path to read or a query to search, one of them",
          });
        }
        if (query.query !== undefined) {
          const pattern = query.query;
          const limit = query.limit === undefined ? 100 : Number.parseInt(query.limit, 10);
          if (
            pattern.length === 0 ||
            pattern.length > 256 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > CONTENT_SEARCH_LIMIT ||
            (query.limit !== undefined && String(limit) !== query.limit)
          ) {
            return yield* new StoreFailure({
              message: `a search needs 1 to 256 characters and a limit from 1 to ${CONTENT_SEARCH_LIMIT}`,
            });
          }
          const found = yield* reads
            .searchFiles(
              worktree.projectId,
              worktree.id,
              {
                pattern,
                caseSensitive: query.caseSensitive === "true",
                wholeWord: query.wholeWord === "true",
                regex: query.regex === "true",
              },
              limit,
            )
            .pipe(Effect.mapError(readFailure));
          return new WorktreeContents({
            worktreeId: worktree.id,
            file: null,
            search: {
              matches: found.value.matches.map((match) => new WorktreeMatch(match)),
              truncated: found.value.truncated,
            },
            observation: observationOf(found.stamp),
          });
        }
        const relative = query.path ?? "";
        if (!isWorktreeRelativePath(relative)) {
          return yield* new StoreFailure({
            message: "a path is relative to the worktree, without `..`, and never into `.git`",
          });
        }
        const at =
          query.at === undefined
            ? null
            : (yield* (yield* CheckpointsRepo).listForWorktree(worktree.id)).find(
                (checkpoint) => checkpoint.id === query.at,
              );
        if (at === undefined) return yield* new NotFound({ id: query.at ?? "" });
        const read = yield* reads
          .readFile(worktree.projectId, worktree.id, relative, at?.sha ?? null, FILE_READ_LIMIT)
          .pipe(Effect.mapError(readFailure));
        if (read.value === null) return yield* new NotFound({ id: relative });
        const file = read.value;
        return new WorktreeContents({
          worktreeId: worktree.id,
          file: new WorktreeFile({
            path: relative,
            at: at?.id ?? null,
            contents: file.binary ? null : new TextDecoder().decode(file.bytes),
            size: file.size,
            truncated: file.truncated,
            binary: file.binary,
          }),
          search: null,
          observation: observationOf(read.stamp),
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
    .handle("previews", ({ params }) =>
      Effect.gen(function* () {
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const previews = yield* PreviewsRepo;
        const observations = yield* ServiceObservationsRepo;
        const processes = yield* SessionProcessesRepo;
        const services = yield* ServicesRepo;
        const views = yield* previews
          .ensureForWorktree(worktree.id)
          .pipe(
            Effect.catchTag("WorktreeNotFoundError", () =>
              Effect.fail(new WorktreeNotFound({ id: params.id })),
            ),
          );
        const snapshots = yield* previews.gatewaySnapshots(views.map(({ preview }) => preview.id));
        const preparation = yield* (yield* PreviewPreparationsRepo).latestForWorktree(worktree.id);
        const { setup } = yield* PreviewSetupConfig;
        const now = new Date(yield* Clock.currentTimeMillis);
        const described = yield* Effect.forEach(views, (view) =>
          Effect.gen(function* () {
            const resolution = snapshots.get(view.preview.id)?.resolution ?? null;
            const bound = resolution?._tag === "Bound" ? resolution.attempt : null;
            const observation =
              bound === null ? null : yield* observations.latestForService(bound.serviceId);
            const attemptId =
              resolution?._tag === "Bound"
                ? resolution.attempt.attemptId
                : resolution?._tag === "Starting"
                  ? resolution.attemptId
                  : resolution?._tag === "Dormant"
                    ? resolution.source.sourceAttemptId
                    : null;
            const attempt = attemptId === null ? null : yield* processes.byId(attemptId);
            const boundService =
              view.binding._tag === "Bound" ? yield* services.byId(view.binding.serviceId) : null;
            const open = previewOpenOf(setup, view);
            const facts = previewStatusesOf(
              {
                preview: view.preview,
                resolution,
                observation,
                attemptStartedAt: attempt?.createdAt ?? null,
              },
              preparation,
            );
            return {
              ...view,
              status: facts.map((status) => previewStatusLine(status, now)),
              facts,
              open: open._tag === "Open" ? open.target : null,
              boundTo:
                boundService === null
                  ? null
                  : { serviceId: boundService.id, sessionId: boundService.sessionId },
            };
          }),
        );
        const unprepared = unpreparedStatusOf(
          views.map(({ preview }) => preview),
          preparation,
        );
        return {
          previews: described,
          unprepared: unprepared === null ? null : previewStatusLine(unprepared, now),
          starting: [...described.flatMap(({ facts }) => facts), unprepared].some(
            (status) => status?._tag === "Starting",
          ),
          routing: setup._tag === "On" ? setup.routing.mode : null,
        };
      }),
    )
    .handle("remove", ({ params, query }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        const worktree = yield* access
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        const managesProject = yield* access.manageProject(worktree.projectId).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
        const caller = { userId: (yield* CurrentUser).user.id, managesProject };
        return yield* (yield* Removal).worktree(worktree, caller, query.force === "true");
      }),
    )
    .handle("createSession", ({ params, payload }) =>
      Effect.gen(function* () {
        const worktree = yield* (yield* ProjectAccess)
          .worktree(params.id)
          .pipe(Effect.mapError(() => new WorktreeNotFound({ id: params.id })));
        yield* refuseStartWhileRemoving({ projectId: worktree.projectId, worktreeId: worktree.id });
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
