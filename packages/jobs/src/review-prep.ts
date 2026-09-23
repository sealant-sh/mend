import { PgClient } from "@effect/sql-pg";
import {
  MEND_EVENTS_CHANNEL,
  MendEvent,
  ProjectsRepo,
  WorktreeChangesRepo,
  SessionsRepo,
  SettingsRepo,
} from "@mend/db";
import { SessionId } from "@mend/domain";
import {
  resolveAutomation,
  type AutomationChoice,
  type SessionOrigin,
} from "@mend/domain/workbench";
import { CaptureRuntime, WorktreeReads } from "@mend/sessions";
import type { GitError } from "@mend/store";
import { Cause, Effect, Layer, Schema, Stream } from "effect";

import { JobRunner } from "./job-runner.ts";

/**
 * Review automation (the cascade's execution point): when a session settles,
 * resolve each switch — project override first, Settings default under
 * `inherit` — and queue the passes whose switch is on, so review opens with
 * the tour composed and the suggestions drafted instead of a pair of buttons.
 *
 * Discipline shared with the session notifier:
 * - transition, not state: only a session seen leaving a live phase queues
 *   the passes; the settle event flapping or repeating cannot re-queue (and
 *   the jobs' idempotency keys dedup anything that races through anyway).
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

export const ReviewPrepLive: Layer.Layer<
  never,
  never,
  | PgClient.PgClient
  | SessionsRepo
  | WorktreeChangesRepo
  | ProjectsRepo
  | SettingsRepo
  | WorktreeReads
  | CaptureRuntime
  | JobRunner
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sessions = yield* SessionsRepo;
    const changes = yield* WorktreeChangesRepo;
    const projects = yield* ProjectsRepo;
    const settingsRepo = yield* SettingsRepo;
    const reads = yield* WorktreeReads;
    const capture = yield* CaptureRuntime;
    const jobs = yield* JobRunner;

    const lastSettled = new Map<string, boolean>();

    const prepare = Effect.fn("ReviewPrep.prepare")(function* (sessionId: SessionId) {
      const session = yield* sessions.byId(sessionId);
      const change = yield* changes.byWorktree(session.worktreeId);
      if (change === null) return;
      const project = yield* projects.byId(session.projectId);
      // Capture mode (ADR-0002 "Review"): a summary the executor posted for the chain head is
      // `claimed` until a runner recomputes it; queue that pass at settle so the review page
      // reads `observed` by the time a human opens it.
      let chainHead: ReviewPrepHead | null = null;
      if (capture.enabled) {
        const head = (yield* capture.repo.headOf(session.worktreeId))?.head ?? null;
        chainHead = head === null ? null : { n: head.n, id: head.id, gitFsck: head.gitFsck };
        const summary = head === null ? null : yield* capture.repo.summaryOf(head.id);
        if (head !== null && summary !== null && summary.state === "claimed") {
          yield* jobs.enqueue({
            name: "summary-observe",
            payload: { worktreeId: session.worktreeId, captureId: head.id },
            idempotencyKey: `summary-observe:${head.id}`,
          });
        }
      }
      const { tour: autoTour, suggest: autoSuggest } = reviewPassesFor({
        origin: session.origin,
        project,
        settings: yield* settingsRepo.get(),
      });
      if (!autoTour && !autoSuggest) return;

      // The passes read worktree-versus-base themselves; this is only the
      // cheap "is there anything at all" gate before spending inference. A
      // change git cannot read is logged with git's words and queues nothing:
      // the review page still offers both passes on demand.
      const read = yield* reads.changedFiles(project.id, session.worktreeId, change.baseSha).pipe(
        Effect.catchTag("GitError", (error) =>
          Effect.logWarning("review prep: the change could not be read · no passes queued").pipe(
            Effect.annotateLogs(
              readFailureAnnotations(error, {
                sessionId,
                worktreeId: session.worktreeId,
                changeId: change.id,
                head: chainHead,
              }),
            ),
            Effect.as(null),
          ),
        ),
      );
      if (read === null) return;
      const files = read.value;
      if (files.length === 0) return;

      // Key by content, not identity: many sessions settle onto ONE worktree
      // change now, so a bare change id would dedupe forever after the first
      // settle — and an unchanged head must not re-spend inference.
      const head = change.headSha ?? change.baseSha;
      if (autoTour) {
        yield* jobs.enqueue({
          name: "compose-tour",
          payload: { changeId: change.id },
          idempotencyKey: `compose-tour:${change.id}:${head}`,
        });
      }
      if (autoSuggest) {
        yield* jobs.enqueue({
          name: "suggest-change",
          payload: { changeId: change.id },
          idempotencyKey: `suggest-change:${change.id}:${head}`,
        });
      }
      yield* Effect.annotateLogs(Effect.logInfo("review prep queued"), {
        sessionId,
        changeId: change.id,
        autoTour,
        autoSuggest,
      });
    });

    const observe = Effect.fn("ReviewPrep.observe")(function* (sessionId: string) {
      const session = yield* sessions.byId(SessionId.make(sessionId));
      const settled = SETTLED.has(session.status);
      const previous = lastSettled.get(session.id);
      lastSettled.set(session.id, settled);
      if (previous === undefined) return; // unknown baseline — record, never queue
      if (previous || !settled) return;
      yield* prepare(session.id);
    });

    // Baseline: whatever exists right now settled before we were listening.
    const active = yield* sessions.listActive();
    for (const session of active) lastSettled.set(session.id, SETTLED.has(session.status));

    yield* sql.listen(MEND_EVENTS_CHANNEL).pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) =>
            event.type === "session" ? observe(event.sessionId) : Effect.void,
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
  }),
);
