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
import { resolveAutomation } from "@mend/domain/workbench";
import { CaptureRuntime, WorktreeReads } from "@mend/sessions";
import { Effect, Layer, Schema, Stream } from "effect";

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
 */

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

const SETTLED = new Set(["completed", "failed", "stopped"]);

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
      if (capture.enabled) {
        const head = (yield* capture.repo.headOf(session.worktreeId))?.head ?? null;
        const summary = head === null ? null : yield* capture.repo.summaryOf(head.id);
        if (head !== null && summary !== null && summary.state === "claimed") {
          yield* jobs.enqueue({
            name: "summary-observe",
            payload: { worktreeId: session.worktreeId, captureId: head.id },
            idempotencyKey: `summary-observe:${head.id}`,
          });
        }
      }
      const settings = yield* settingsRepo.get();
      const autoTour = resolveAutomation(project.autoTour, settings.autoTour);
      const autoSuggest = resolveAutomation(project.autoSuggest, settings.autoSuggest);
      if (!autoTour && !autoSuggest) return;

      // The passes read worktree-versus-base themselves; this is only the
      // cheap "is there anything at all" gate before spending inference.
      const files = (yield* reads.changedFiles(project.id, session.worktreeId, change.baseSha))
        .value;
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
          Effect.catchCause((cause) =>
            Effect.logWarning("review prep: event handling failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("review prep: listen stream ended").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
