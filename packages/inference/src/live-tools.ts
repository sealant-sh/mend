import { BriefCommentsRepo, BriefsRepo, ChangesRepo, IssuesRepo, RunsRepo } from "@mend/db";
import type { ChangeId, IssueId, RunId } from "@mend/domain";
import { SealantClient } from "@mend/sealant";
import { Effect, Layer, Stream } from "effect";

import { InferenceToolError } from "./provider.ts";
import {
  ChangedFile,
  ChangeView,
  CommentRef,
  IssueView,
  PublishBrief,
  ReadBrief,
  ReadChange,
  ReadIssue,
  ReadRecording,
  RecordingEvent,
  ReplyOnBrief,
  type RecordingSelector,
} from "./tools.ts";

/**
 * The live layers behind the read/act tool contracts — everything the
 * `brief-compilation` context is handed. Errors surface as `InferenceToolError`
 * with a message the model can act on (correct the input, narrow the slice),
 * never as defects: a bad tool call is part of the loop, not a crash.
 */

/** One read_recording call returns at most this many events — narrow with the selector. */
const MAX_RECORDING_EVENTS = 500;

/** The record's source-trail kinds (PLATFORM-FEEDBACK.md, typed taxonomy). */
const SOURCE_KINDS: ReadonlySet<string> = new Set(["networkRequest", "networkSourceObserved"]);

export const readRecordingLayer = Layer.effect(
  ReadRecording,
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    const runs = yield* RunsRepo;

    const read = Effect.fn("ReadRecording.read")(function* (
      runId: RunId,
      selector?: RecordingSelector,
    ) {
      const run = yield* runs
        .byId(runId)
        .pipe(
          Effect.mapError(
            () => new InferenceToolError({ tool: "read_recording", message: `no run ${runId}` }),
          ),
        );
      if (run.sealantRunId === null) {
        return yield* new InferenceToolError({
          tool: "read_recording",
          message: `run ${runId} has no recording (the harness never started)`,
        });
      }

      const sdkRun = yield* sealant
        .getRun(run.sealantRunId)
        .pipe(toToolError("read_recording", "the record could not be opened"));

      const from = selector?.fromSequence ?? 0n;
      const to = selector?.toSequence ?? null;
      const kinds = selector?.kinds ?? null;
      const sourcesOnly = selector?.sourcesOnly ?? false;

      // The timeline surface ends at the record's end — a read, not a live tail.
      const events = yield* sealant.recordTimeline(sdkRun, { from }).pipe(
        Stream.takeWhile((entry) => to === null || entry.sequence <= to),
        Stream.filter((entry) => (sourcesOnly ? SOURCE_KINDS.has(entry.kind) : true)),
        Stream.filter((entry) => (kinds === null ? true : kinds.includes(entry.kind))),
        Stream.take(MAX_RECORDING_EVENTS),
        Stream.map(
          (entry) =>
            new RecordingEvent({
              sequence: entry.sequence,
              kind: entry.kind,
              occurredAt: new Date(entry.occurredAt),
              summary: entry.summary,
              // The runtime recorded every timeline entry — that is what `observed` means.
              provenance: "observed",
              data: entry.data,
            }),
        ),
        Stream.runCollect,
        toToolError("read_recording", "reading the record failed"),
      );

      return events;
    });

    return { read };
  }),
);

export const readIssueLayer = Layer.effect(
  ReadIssue,
  Effect.gen(function* () {
    const issues = yield* IssuesRepo;

    const read = Effect.fn("ReadIssue.read")(function* (issueId: IssueId) {
      const issue = yield* issues
        .byId(issueId)
        .pipe(
          Effect.mapError(
            () => new InferenceToolError({ tool: "read_issue", message: `no issue ${issueId}` }),
          ),
        );
      // Manual issues carry no comment thread and no links; trackers add both in M3.
      return new IssueView({ title: issue.title, body: issue.body, comments: [], links: [] });
    });

    return { read };
  }),
);

export const readChangeLayer = Layer.effect(
  ReadChange,
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    const changes = yield* ChangesRepo;
    const runs = yield* RunsRepo;

    const read = Effect.fn("ReadChange.read")(function* (changeId: ChangeId) {
      const change = yield* changes
        .byId(changeId)
        .pipe(
          Effect.mapError(
            () => new InferenceToolError({ tool: "read_change", message: `no change ${changeId}` }),
          ),
        );

      // The diff behind the current head: the latest completed recording that
      // could have changed code — verification runs change nothing by design.
      const issueRuns = yield* runs.listForIssue(change.issueId);
      const latest = issueRuns.find(
        (run) =>
          run.outcome === "completed" && run.sealantRunId !== null && run.kind !== "verification",
      );
      if (latest === undefined || latest.sealantRunId === null) {
        return yield* new InferenceToolError({
          tool: "read_change",
          message: `change ${changeId} has no completed recording behind it`,
        });
      }

      // The diff is a machine fact of the change, read from git — the source of
      // truth for what the commit contains. The recording-derived `runChanges`
      // diff is currently empty (the runtime records no file-change events —
      // PLATFORM-FEEDBACK.md), so when there is a committed head that differs
      // from base, read the real `git diff base..head`; fall back to runChanges
      // only when there is no committed range to read (e.g. uncommitted work).
      const base = change.baseSha;
      const head = change.headSha;
      const workspaceId = latest.sealantWorkspaceId;

      const resolved: {
        readonly diff: string;
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly additions: number;
          readonly deletions: number;
        }>;
      } =
        base !== null && head !== null && base !== head && workspaceId !== null
          ? yield* sealant
              .diffCommits(workspaceId, base, head)
              .pipe(toToolError("read_change", "reading the committed diff failed"))
          : yield* sealant.getRun(latest.sealantRunId).pipe(
              Effect.flatMap((sdkRun) => sealant.runChanges(sdkRun)),
              toToolError("read_change", "reading the change failed"),
              // Core never read this run's changes: its empty diff is not "no changes".
              Effect.filterOrFail(
                (rc) => rc.available,
                (rc) =>
                  new InferenceToolError({
                    tool: "read_change",
                    message: changesNotRead(rc.unavailableReason),
                  }),
              ),
              Effect.map((rc) => {
                const counts = diffCounts(rc.diff);
                return {
                  diff: rc.diff,
                  files: rc.files.map((file) => ({
                    path: file.path,
                    additions: counts.get(file.path)?.additions ?? 0,
                    deletions: counts.get(file.path)?.deletions ?? 0,
                  })),
                };
              }),
            );

      return new ChangeView({
        diff: resolved.diff,
        baseSha: change.baseSha,
        headSha: change.headSha,
        files: resolved.files.map((file) => new ChangedFile(file)),
        // CI checks join the brief with the PR (M3).
        checks: [],
        freshness: change.freshness,
      });
    });

    return { read };
  }),
);

export const readBriefLayer = Layer.effect(
  ReadBrief,
  Effect.gen(function* () {
    const briefs = yield* BriefsRepo;

    const read = Effect.fn("ReadBrief.read")(function* (changeId: ChangeId) {
      return yield* briefs.byChange(changeId).pipe(
        Effect.mapError(
          () =>
            new InferenceToolError({
              tool: "read_brief",
              message: `no brief exists for change ${changeId} yet — this is the first compile`,
            }),
        ),
      );
    });

    return { read };
  }),
);

export const publishBriefLayer = Layer.effect(
  PublishBrief,
  Effect.gen(function* () {
    const briefs = yield* BriefsRepo;

    const publish = Effect.fn("PublishBrief.publish")((changeId: ChangeId, document) =>
      briefs.publish(changeId, document),
    );

    return { publish };
  }),
);

export const replyOnBriefLayer = Layer.effect(
  ReplyOnBrief,
  Effect.gen(function* () {
    const briefs = yield* BriefsRepo;
    const comments = yield* BriefCommentsRepo;

    const reply = Effect.fn("ReplyOnBrief.reply")(function* (
      changeId: ChangeId,
      thread: string,
      body: string,
    ) {
      const brief = yield* briefs.byChange(changeId).pipe(
        Effect.mapError(
          () =>
            new InferenceToolError({
              tool: "reply_on_brief",
              message: `no brief exists for change ${changeId}`,
            }),
        ),
      );
      const comment = yield* comments.create({
        briefId: brief.id,
        thread,
        authorKind: "mend",
        authorName: "Mend",
        body,
      });
      return new CommentRef({ id: comment.id, url: null });
    });

    return { reply };
  }),
);

/**
 * Every live tool layer, ready to sit behind the per-context tool sets.
 * `start_run`'s live layer lives in @mend/jobs beside the run machinery.
 */
export const liveToolsLayer = Layer.mergeAll(
  readRecordingLayer,
  readIssueLayer,
  readChangeLayer,
  readBriefLayer,
  publishBriefLayer,
  replyOnBriefLayer,
);

const toToolError =
  (tool: string, what: string) =>
  <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (error) => new InferenceToolError({ tool, message: `${what}: ${error.message}` }),
      ),
    );

/** What read_change says for a run whose changes Core never read, in place of an empty diff. */
const changesNotRead = (reason: string | null): string =>
  `changes not read · ${reason ?? "Core gave no reason"}`;

/** Per-file +/− counts out of a unified diff — the brief's mono facts. */
const diffCounts = (diff: string) => {
  const counts = new Map<string, { additions: number; deletions: number }>();
  let current: { additions: number; deletions: number } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current = { additions: 0, deletions: 0 };
      if (path !== "/dev/null") counts.set(path, current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  return counts;
};
