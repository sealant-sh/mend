import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  ChangePassesRepo,
  listenEvents,
  MendEvent,
  ProjectsRepo,
  WorktreeChangesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  SettingsRepo,
} from "@mend/db";
import { ChangeId, SessionId, type WorktreeId } from "@mend/domain";
import {
  agentProcessesOf,
  isLiveAgentProcess,
  resolveAutomation,
  type AutomationChoice,
  type SessionOrigin,
  type SessionProcess,
  type SessionStatus,
} from "@mend/domain/workbench";
import { CaptureRuntime, WorktreeReads } from "@mend/sessions";
import type { GitError } from "@mend/store";
import { Cause, Duration, Effect, FiberMap, Layer, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { JobRunner } from "./job-runner.ts";
import { queueReviewPass } from "./review-passes.ts";

/**
 * Review automation (the cascade's execution point): when a session settles for review (its
 * status settled, or its agent stopped or exited while shells or Services keep the workspace:
 * `settledForReview`), resolve each switch — project override first, Settings default under
 * `inherit` — and queue the passes whose switch is on, so review opens with
 * the tour composed and the suggestions drafted instead of a pair of buttons.
 *
 * Discipline shared with the session notifier:
 * - transition, not state: only a session seen leaving a live phase queues
 *   the passes; the settle event flapping or repeating cannot re-queue, and
 *   `stopping` is a settle in flight, so idle → stopping → completed is one.
 * - not twice in a row for one diff: each pass records the digest of the diff
 *   it was last queued for (`ChangePassesRepo.recordPrep`), so a restarted
 *   worker, another session of the worktree, or a resumed turn that wrote
 *   nothing queues no second spend. Only the last digest per pass is kept: a
 *   diff that comes back after another one is prepared again.
 * - never lost behind a running pass: a pass already running read an older
 *   diff, so the request it absorbs records nothing and is retried when that
 *   pass ends (`follow`). A waiting pass reads the diff when it runs, so a
 *   request it absorbs is recorded.
 * - known baseline only: a session first seen already settled (reconnect,
 *   restart) records silently — prep belongs to the settle moment, and the
 *   review page still offers both passes on demand.
 * - an empty change queues nothing: no diff, no tour, no suggestions — an
 *   inference pass over nothing is spend without evidence.
 * - a session started from Slack always queues the tour, whatever the switch
 *   says: its summary is the thread's end-of-session reply (docs/adr/0006-slack.md).
 */

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

const SETTLED = new Set(["completed", "failed", "stopped"]);

/**
 * Whether a session has settled FOR REVIEW: its status settled, or its agent no longer live
 * while shells or Services keep the workspace (`idle`, with an agent that ran). A stop keeps
 * Services running (docs/SESSION-SERVICES.md), so waiting for the workspace to end would leave a
 * stopped agent's change unprepared for as long as a dev server runs.
 */
export const settledForReview = (
  status: SessionStatus,
  processes: ReadonlyArray<SessionProcess>,
): boolean =>
  SETTLED.has(status) ||
  (status === "idle" &&
    agentProcessesOf(processes).length > 0 &&
    !processes.some(isLiveAgentProcess));

/** Where a session stands for review: live work, a settle in flight, or settled. */
export type ReviewReading = "live" | "stopping" | "settled";

export const reviewReading = (
  status: SessionStatus,
  processes: ReadonlyArray<SessionProcess>,
): ReviewReading =>
  status === "stopping" ? "stopping" : settledForReview(status, processes) ? "settled" : "live";

/**
 * Whether the session counts as settled after this reading. `stopping` neither starts a settle
 * nor leaves one: it keeps what came before, and a session first seen stopping has its settle
 * still ahead.
 */
export const settledAfter = (previous: boolean | undefined, reading: ReviewReading): boolean =>
  reading === "stopping" ? (previous ?? false) : reading === "settled";

/**
 * Transition, not state: prep runs once, when a session is seen moving from live work to settled
 * for review. An unknown baseline records silently; staying settled (`idle` → `stopped` as the
 * last Service ends) is not a second settle.
 */
export const shouldPrepareReview = (previous: boolean | undefined, settled: boolean): boolean =>
  previous === false && settled;

/** The passes a settled session queues over a non-empty change. */
export interface ReviewPasses {
  readonly tour: boolean;
  readonly suggest: boolean;
}

/**
 * Resolve each switch, the project's choice first and Settings under `inherit`. A session started
 * from Slack gets the tour even with the switch off: the thread's summary is the tour's.
 */
export const reviewPassesFor = (input: {
  readonly origin: SessionOrigin;
  readonly project: { readonly autoTour: AutomationChoice; readonly autoSuggest: AutomationChoice };
  readonly settings: { readonly autoTour: boolean; readonly autoSuggest: boolean };
}): ReviewPasses => ({
  tour:
    input.origin === "slack" || resolveAutomation(input.project.autoTour, input.settings.autoTour),
  suggest: resolveAutomation(input.project.autoSuggest, input.settings.autoSuggest),
});

/** The passes review prep queues. */
type PrepKind = "tour" | "suggest";
const PREP_KINDS: ReadonlyArray<PrepKind> = ["tour", "suggest"];

/** What became of one pass in one prep, as the log says it. */
type PrepOutcome =
  | "queued"
  | "covered by a waiting pass"
  | "behind a running pass"
  | "prepared already"
  | "not queued";

/** How long a retry waits for an ended pass's job to leave `active`: two and a half minutes. */
const RETRY_DELAYS: ReadonlyArray<Duration.Input> = [
  "0 millis",
  "1 second",
  "2 seconds",
  "4 seconds",
  "8 seconds",
  "15 seconds",
  "30 seconds",
  "30 seconds",
  "30 seconds",
  "30 seconds",
];

/**
 * The digest of a change's diff, over its per-file patches in order. The read lists tracked files
 * before untracked ones, so staging a file moves its patch without changing a byte of it. A rename
 * staged between two reads still reads as a new diff: git pairs a rename only among tracked files.
 */
export const diffDigest = (diff: string): string =>
  createHash("sha256")
    .update(
      diff
        .split(/\n(?=diff --git )/)
        .map((patch) => patch.replace(/\n+$/, ""))
        .toSorted()
        .join("\n"),
    )
    .digest("hex");

/** The chain head as the log names it: which capture the read would have come from. */
export interface ReviewPrepHead {
  readonly n: number;
  readonly id: string;
  readonly gitFsck: string;
}

/**
 * What the warning carries when the change cannot be read: git's own words (the command and
 * its stderr — `fatal: unable to read tree …`, never `Cause([Fail(GitError)])`) and where the
 * bytes were to come from (the worktree, the chain head and its verification state), so the
 * log line alone says which capture is unreadable and why.
 */
export const readFailureAnnotations = (
  error: GitError,
  context: {
    readonly sessionId: string;
    readonly worktreeId: string;
    readonly changeId: string;
    readonly head: ReviewPrepHead | null;
  },
): Record<string, string | number | null> => ({
  sessionId: context.sessionId,
  worktreeId: context.worktreeId,
  changeId: context.changeId,
  captureN: context.head?.n ?? null,
  captureId: context.head?.id ?? null,
  gitFsck: context.head?.gitFsck ?? null,
  git: `git ${error.args.join(" ")}`,
  exitCode: error.exitCode,
  stderr: error.stderr.trim(),
});

export const reviewPrep = (events: Stream.Stream<string, SqlError>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const changes = yield* WorktreeChangesRepo;
    const passes = yield* ChangePassesRepo;
    const projects = yield* ProjectsRepo;
    const settingsRepo = yield* SettingsRepo;
    const reads = yield* WorktreeReads;
    const capture = yield* CaptureRuntime;
    const jobs = yield* JobRunner;

    const lastSettled = new Map<string, boolean>();
    // Passes a running job absorbed, per change: that job read an older diff, so each waits for it
    // to end. Held in memory: after a restart the diff is still unrecorded, so the next settle
    // queues it.
    const behind = new Map<ChangeId, { sessionId: SessionId; kinds: Set<PrepKind> }>();
    const retries = yield* FiberMap.make<ChangeId>();

    const headOf = Effect.fn("ReviewPrep.headOf")(function* (worktreeId: WorktreeId) {
      if (!capture.enabled) return null;
      return (yield* capture.repo.headOf(worktreeId))?.head ?? null;
    });

    // Capture mode (ADR-0002 "Review"): a summary the executor posted for the chain head is
    // `claimed` until a runner recomputes it; queue that pass at settle so the review page
    // reads `observed` by the time a human opens it.
    const observeSummary = Effect.fn("ReviewPrep.observeSummary")(function* (
      worktreeId: WorktreeId,
    ) {
      const head = yield* headOf(worktreeId);
      if (!capture.enabled || head === null) return;
      const summary = yield* capture.repo.summaryOf(head.id);
      if (summary === null || summary.state !== "claimed") return;
      yield* jobs.enqueue({
        name: "summary-observe",
        payload: { worktreeId, captureId: head.id },
        idempotencyKey: `summary-observe:${head.id}`,
      });
    });

    const settleBehind = (changeId: ChangeId, kind: PrepKind) => {
      const waiting = behind.get(changeId);
      waiting?.kinds.delete(kind);
      if (waiting?.kinds.size === 0) behind.delete(changeId);
    };

    /** Queue the enabled passes (only those in `only`, when given) over the change as it is now. */
    const queuePasses = Effect.fn("ReviewPrep.queuePasses")(function* (
      sessionId: SessionId,
      only?: ReadonlySet<PrepKind>,
    ) {
      const session = yield* sessions.byId(sessionId);
      const change = yield* changes.byWorktree(session.worktreeId);
      if (change === null) return;
      const project = yield* projects.byId(session.projectId);
      const switches = reviewPassesFor({
        origin: session.origin,
        project,
        settings: yield* settingsRepo.forOrganization(project.organizationId),
      });
      const kinds = PREP_KINDS.filter(
        (kind) => switches[kind] && (only === undefined || only.has(kind)),
      );
      for (const kind of PREP_KINDS) if (!switches[kind]) settleBehind(change.id, kind);
      if (kinds.length === 0) return;

      // The passes read worktree-versus-base themselves; this read is the gate before spending
      // inference: nothing changed, or this diff was prepared already. A change git cannot read
      // is logged with git's words and queues nothing: the review page still offers both passes
      // on demand.
      const read = yield* reads.diffWorktree(project.id, session.worktreeId, change.baseSha).pipe(
        Effect.catchTag("GitError", (error) =>
          Effect.gen(function* () {
            const head = yield* headOf(session.worktreeId);
            yield* Effect.logWarning(
              "review prep: the change could not be read · no passes queued",
            ).pipe(
              Effect.annotateLogs(
                readFailureAnnotations(error, {
                  sessionId,
                  worktreeId: session.worktreeId,
                  changeId: change.id,
                  head: head === null ? null : { n: head.n, id: head.id, gitFsck: head.gitFsck },
                }),
              ),
            );
            return null;
          }),
        ),
      );
      if (read === null || read.value === "") {
        behind.delete(change.id);
        return;
      }

      // One key per change and pass (`reviewPassKey`), shared with the review page: a pass
      // already queued for this change absorbs this request, and one already running holds it
      // until it ends.
      // On the login of the session that settled: a teammate's session in this worktree pays for
      // its own passes, never the change owner's. A session with no owner spends no one's.
      const paidBy = session.ownerUserId;
      if (paidBy === null) {
        yield* Effect.logInfo("review prep: the session has no owner · no passes queued").pipe(
          Effect.annotateLogs({ sessionId, changeId: change.id }),
        );
        behind.delete(change.id);
        return;
      }
      const digest = diffDigest(read.value);
      const outcomes: Partial<Record<PrepKind, PrepOutcome>> = {};
      for (const kind of kinds) {
        if ((yield* passes.preparedDigest(change.id, kind)) === digest) {
          outcomes[kind] = "prepared already";
          settleBehind(change.id, kind);
          continue;
        }
        const enqueued = yield* queueReviewPass(kind, change.id, paidBy).pipe(
          Effect.provideService(JobRunner, jobs),
          Effect.provideService(ChangePassesRepo, passes),
          Effect.catchTag("JobEnqueueError", (error) =>
            Effect.logWarning("review prep: the pass could not be queued").pipe(
              Effect.annotateLogs({ sessionId, changeId: change.id, kind, cause: String(error) }),
              Effect.as(null),
            ),
          ),
        );
        if (enqueued === null) {
          outcomes[kind] = "not queued";
          settleBehind(change.id, kind);
        } else if (enqueued._tag === "Absorbed" && enqueued.running) {
          outcomes[kind] = "behind a running pass";
          const waiting = behind.get(change.id) ?? { sessionId, kinds: new Set<PrepKind>() };
          waiting.sessionId = sessionId;
          waiting.kinds.add(kind);
          behind.set(change.id, waiting);
        } else {
          yield* passes.recordPrep(change.id, kind, digest);
          outcomes[kind] = enqueued._tag === "Queued" ? "queued" : "covered by a waiting pass";
          settleBehind(change.id, kind);
        }
      }
      const said = Object.values(outcomes);
      const message = said.some((outcome) => outcome === "queued")
        ? "review prep queued"
        : said.every((outcome) => outcome === "prepared already")
          ? "review prep: this diff was prepared already · no passes queued"
          : "review prep: no new pass queued";
      yield* Effect.logInfo(message).pipe(
        Effect.annotateLogs({ sessionId, changeId: change.id, diffDigest: digest, ...outcomes }),
      );
      yield* follow(change.id, "absorbed");
    });

    /**
     * Retry the passes a running job absorbed once it ends. Its pass row's last write (completed
     * or failed) is the signal this worker hears; the job leaves `active` a moment after that
     * write, so a retry still absorbed backs off until it is not. On a row's write only a pass
     * that ended starts it: the retry's own request rewrites an ended row as `queued`, and that
     * write must not start the next one.
     */
    const follow = (changeId: ChangeId, after: "absorbed" | "row write"): Effect.Effect<void> =>
      Effect.gen(function* () {
        const waiting = behind.get(changeId);
        if (waiting === undefined) return;
        const rows = yield* passes.listForChange(changeId);
        const ready = [...waiting.kinds].some((kind) => {
          const status = rows.find((row) => row.kind === kind)?.status;
          return after === "absorbed"
            ? status !== "running"
            : status === "completed" || status === "failed";
        });
        if (!ready) return;
        yield* FiberMap.run(retries, changeId, retry(changeId), { onlyIfMissing: true });
      });

    const allRunning = Effect.fn("ReviewPrep.allRunning")(function* (
      changeId: ChangeId,
      kinds: ReadonlySet<PrepKind>,
    ) {
      const rows = yield* passes.listForChange(changeId);
      return [...kinds].every((kind) =>
        rows.some((row) => row.kind === kind && row.status === "running"),
      );
    });

    const retry = (changeId: ChangeId) =>
      Effect.gen(function* () {
        for (const delay of RETRY_DELAYS) {
          yield* Effect.sleep(delay);
          const waiting = behind.get(changeId);
          if (waiting === undefined) return;
          // A session live again prepares at its next settle.
          if (lastSettled.get(waiting.sessionId) !== true) {
            behind.delete(changeId);
            return;
          }
          yield* queuePasses(waiting.sessionId, new Set(waiting.kinds));
          const still = behind.get(changeId);
          if (still === undefined || (yield* allRunning(changeId, still.kinds))) return;
        }
        yield* Effect.logWarning(
          "review prep: a running pass still holds this change · the next settle prepares it",
        ).pipe(Effect.annotateLogs({ changeId }));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("review prep: the retry failed · the next settle prepares it").pipe(
            Effect.annotateLogs({ changeId, cause: Cause.pretty(cause) }),
            Effect.andThen(Effect.sync(() => behind.delete(changeId))),
          ),
        ),
      );

    const prepare = Effect.fn("ReviewPrep.prepare")(function* (sessionId: SessionId) {
      const session = yield* sessions.byId(sessionId);
      if ((yield* changes.byWorktree(session.worktreeId)) === null) return;
      yield* observeSummary(session.worktreeId);
      yield* queuePasses(sessionId);
    });

    const readingNow = Effect.fn("ReviewPrep.readingNow")(function* (session: {
      readonly id: SessionId;
      readonly status: SessionStatus;
    }) {
      // Only an `idle` session needs its processes read: every other status answers alone.
      const read = session.status === "idle" ? yield* processes.listForSession(session.id) : [];
      return reviewReading(session.status, read);
    });

    const observe = Effect.fn("ReviewPrep.observe")(function* (sessionId: string) {
      const session = yield* sessions.byId(SessionId.make(sessionId));
      const previous = lastSettled.get(session.id);
      const settled = settledAfter(previous, yield* readingNow(session));
      lastSettled.set(session.id, settled);
      if (!shouldPrepareReview(previous, settled)) return;
      yield* prepare(session.id);
    });

    // Baseline: whatever exists right now settled before we were listening.
    const active = yield* sessions.listActive();
    for (const session of active) {
      lastSettled.set(session.id, settledAfter(undefined, yield* readingNow(session)));
    }

    yield* events.pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          // Settled for review reads the live agents as well as the status: an agent that exits
          // while a shell keeps the session `idle` changes only its process row.
          Effect.flatMap((event) =>
            event.type === "session" || event.type === "session-process"
              ? observe(event.sessionId)
              : // A pass row's write: the pass a prep waits behind may have ended.
                event.type === "session-change" && behind.has(ChangeId.make(event.changeId))
                ? follow(ChangeId.make(event.changeId), "row write")
                : Effect.void,
          ),
          // `Cause.pretty` renders the failure itself (its tag and fields), where
          // `String(cause)` reads `Cause([Fail(GitError)])` and names nothing.
          Effect.catchCause((cause) =>
            Effect.logWarning("review prep: event handling failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("review prep: listen stream ended").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  });

export const ReviewPrepLive: Layer.Layer<
  never,
  never,
  | PgClient.PgClient
  | SessionsRepo
  | SessionProcessesRepo
  | ChangePassesRepo
  | WorktreeChangesRepo
  | ProjectsRepo
  | SettingsRepo
  | WorktreeReads
  | CaptureRuntime
  | JobRunner
> = Layer.effectDiscard(Effect.flatMap(PgClient.PgClient, (sql) => reviewPrep(listenEvents(sql))));
