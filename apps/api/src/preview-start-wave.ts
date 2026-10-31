import type { PreviewId } from "@mend/domain";
import {
  type PreviewBoundAttempt,
  type PreviewGatewayResolution,
  type PreviewStartReason,
  previewStartReasonOf,
} from "@mend/domain/workbench";
import { PreviewStartDeclined } from "@mend/sessions";
import { Cause, Clock, Deferred, Duration, Effect, Option } from "effect";

import { budgetMessage, Budgets } from "./budgets.ts";
import {
  budgetPage,
  CEILING_RETRY_SECONDS,
  notDelivered,
  REFUSED,
  undeliveredAnswer,
} from "./preview-headers.ts";
import { PreviewNotFound } from "./preview-identity.ts";
import type { BoundResolution } from "./preview-pools.ts";
import { gatewayPage, type PreviewAnswer, refusalAnswer } from "./preview-requests.ts";
import { PreviewTargets } from "./preview-targets.ts";

export type PreviewRoute =
  | { readonly _tag: "Bound"; readonly resolution: BoundResolution }
  | { readonly _tag: "Refused"; readonly answer: PreviewAnswer }
  | {
      readonly _tag: "Start";
      readonly from: StartFrom;
      readonly workspaceId: PreviewBoundAttempt["workspaceId"] | null;
    };

export interface StartFrom {
  readonly revision: number;
  readonly sourceAttemptId: PreviewBoundAttempt["attemptId"] | null;
}

export type WaveOutcome = Exclude<PreviewRoute, { readonly _tag: "Start" }>;

const refused = (answer: PreviewAnswer): WaveOutcome => ({ _tag: "Refused", answer });

const MAX_SETTLED_WAVES = 1024;

const NOT_FOUND = refusalAnswer(new PreviewNotFound());

export const routeOf = (
  serviceName: string,
  resolution: PreviewGatewayResolution | null,
  back: string | null,
): PreviewRoute => {
  if (resolution === null) return refused(NOT_FOUND);
  switch (resolution._tag) {
    case "Stopped":
      return refused(
        undeliveredAnswer(serviceName, { _tag: "Stopped", by: resolution.control.byName }, back),
      );
    case "Refused": {
      const reason = REFUSED[resolution.reason];
      return refused(gatewayPage(reason.status, notDelivered(serviceName, reason.fact), back));
    }
    case "Bound":
      return { _tag: "Bound", resolution };
    case "Starting":
      return {
        _tag: "Start",
        from: { revision: resolution.revision, sourceAttemptId: resolution.attemptId },
        workspaceId: resolution.workspaceId,
      };
    case "Dormant":
      return {
        _tag: "Start",
        from: { revision: resolution.revision, sourceAttemptId: resolution.source.sourceAttemptId },
        workspaceId: resolution.workspaceId,
      };
  }
};

type Settled =
  | WaveOutcome
  | { readonly _tag: "ClaimerDeclined"; readonly by: string; readonly answer: PreviewAnswer }
  | { readonly _tag: "ElsewhereDeclined" };

interface Wave {
  keepResult: boolean;
  readonly revision: number;
  readonly sourceAttemptId: StartFrom["sourceAttemptId"];
  readonly deadline: number;
  readonly done: Deferred.Deferred<Settled>;
}

export interface PreviewToStart {
  readonly id: PreviewId;
  readonly serviceName: string;
  /** Where in Mend its project is, for the pages the gateway answers itself. */
  readonly back: string | null;
}

export interface StartWaves {
  /** Starts or joins a wave without holding a browser request. */
  readonly poll: (
    preview: PreviewToStart,
    from: StartFrom,
    viewerId: string,
  ) => Effect.Effect<WaveOutcome | null>;
  readonly join: (
    preview: PreviewToStart,
    from: StartFrom,
    viewerId: string,
  ) => Effect.Effect<WaveOutcome>;
}

const logged = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }));

export const makeStartWaves = (startHoldMs: number) =>
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;
    const budgets = yield* Budgets;
    const clock = yield* Clock.Clock;
    const scope = yield* Effect.scope;
    const waves = new Map<PreviewId, Wave>();
    const { limits } = budgets;

    const didNotStart = (preview: PreviewToStart, reason: PreviewStartReason): WaveOutcome =>
      refused(
        undeliveredAnswer(
          preview.serviceName,
          { _tag: "DidNotStart", holdMs: startHoldMs, reason },
          preview.back,
        ),
      );

    const startedOutcome = (
      preview: PreviewToStart,
      resolution: PreviewGatewayResolution | null,
    ): WaveOutcome => {
      const route = routeOf(preview.serviceName, resolution, preview.back);
      return route._tag === "Start" ? didNotStart(preview, "process exited") : route;
    };

    const claimFor = (viewerId: string, declined: { answer: PreviewAnswer | null }) =>
      Effect.gen(function* () {
        const wait = budgets.previewStarts.take(
          viewerId,
          limits.accountPreviewStartsPerMinute,
          clock.currentTimeMillisUnsafe(),
        );
        if (wait !== null) {
          declined.answer = budgetPage(
            budgetMessage("accountPreviewStartsPerMinute", limits.accountPreviewStartsPerMinute),
            wait,
          );
          return yield* new PreviewStartDeclined();
        }
        if (!(yield* budgets.previewStartSlot(viewerId))) {
          declined.answer = budgetPage(
            budgetMessage("accountPreviewStartsInFlight", limits.accountPreviewStartsInFlight),
            CEILING_RETRY_SECONDS,
          );
          return yield* new PreviewStartDeclined();
        }
      });

    const runWave = (
      preview: PreviewToStart,
      wave: Wave,
      from: StartFrom,
      viewerId: string,
    ): Effect.Effect<void> => {
      const declined: { answer: PreviewAnswer | null } = { answer: null };
      const waiting = Effect.gen(function* () {
        for (;;) {
          const read = yield* targets.snapshot(preview.id);
          if (read?._tag !== "Starting") return startedOutcome(preview, read);
          if (read.revision !== from.revision)
            return didNotStart(preview, "preview is unavailable");
          yield* Effect.sleep("50 millis");
        }
      });
      const started: Effect.Effect<Settled> =
        from.sourceAttemptId === null
          ? waiting
          : targets
              .ensureRunning(
                {
                  previewId: preview.id,
                  revision: from.revision,
                  sourceAttemptId: from.sourceAttemptId,
                  deadline: wave.deadline,
                },
                claimFor(viewerId, declined),
              )
              .pipe(
                Effect.andThen(targets.snapshot(preview.id)),
                Effect.map((read): Settled => startedOutcome(preview, read)),
                Effect.catchTags({
                  PreviewStartFailed: (failed) =>
                    failed.reason === "stopped"
                      ? Effect.map(targets.snapshot(preview.id), (read) =>
                          startedOutcome(preview, read),
                        )
                      : Effect.succeed(didNotStart(preview, previewStartReasonOf(failed.reason))),
                  PreviewStartDeclined: () =>
                    Effect.succeed<Settled>(
                      declined.answer === null
                        ? { _tag: "ElsewhereDeclined" }
                        : { _tag: "ClaimerDeclined", by: viewerId, answer: declined.answer },
                    ),
                }),
              );
      const bounded = Effect.suspend(() =>
        started.pipe(
          Effect.timeoutOption(
            Duration.millis(Math.max(0, wave.deadline - clock.currentTimeMillisUnsafe())),
          ),
          Effect.map(Option.getOrElse((): Settled => didNotStart(preview, "start timed out"))),
        ),
      );
      return bounded.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : logged("preview gateway: a start failed", cause).pipe(
                Effect.as(didNotStart(preview, "preview is unavailable")),
              ),
        ),
        Effect.flatMap((settled) => {
          if ((!wave.keepResult || settled._tag === "Bound") && waves.get(preview.id) === wave)
            waves.delete(preview.id);
          return Deferred.succeed(wave.done, settled);
        }),
        Effect.ensuring(
          Effect.suspend(() => {
            // Browser polls retain a failure for this revision and source attempt.
            // Requests using the hold keep their existing retry behavior.
            if (!Deferred.isDoneUnsafe(wave.done) && waves.get(preview.id) === wave)
              waves.delete(preview.id);
            return Deferred.succeed(wave.done, didNotStart(preview, "preview is unavailable"));
          }),
        ),
        Effect.asVoid,
      );
    };

    const awaitWave = (
      preview: PreviewToStart,
      from: StartFrom,
      viewerId: string,
      response: "wait" | "poll",
    ): Effect.Effect<Settled | null> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let wave = waves.get(preview.id);
          if (
            wave !== undefined &&
            (wave.revision !== from.revision || wave.sourceAttemptId !== from.sourceAttemptId) &&
            Deferred.isDoneUnsafe(wave.done)
          ) {
            waves.delete(preview.id);
            wave = undefined;
          }
          if (wave === undefined) {
            // Retain only a bounded number of completed browser results. The engine also
            // deduplicates failed wakes, so evicting one never forces another launch.
            for (const [id, kept] of waves) {
              if (waves.size < MAX_SETTLED_WAVES) break;
              if (Deferred.isDoneUnsafe(kept.done)) waves.delete(id);
            }
            wave = {
              keepResult: response === "poll",
              revision: from.revision,
              sourceAttemptId: from.sourceAttemptId,
              deadline: clock.currentTimeMillisUnsafe() + startHoldMs,
              done: Deferred.makeUnsafe<Settled>(),
            };
            waves.set(preview.id, wave);
            yield* Effect.forkIn(runWave(preview, wave, from, viewerId), scope);
          }
          if (response === "poll") wave.keepResult = true;
          if (response === "poll" && !Deferred.isDoneUnsafe(wave.done)) return null;
          const settled = yield* restore(Deferred.await(wave.done));
          if (settled._tag === "ClaimerDeclined" || settled._tag === "ElsewhereDeclined") {
            if (waves.get(preview.id) === wave) waves.delete(preview.id);
          }
          return settled;
        }),
      );

    const join = (
      preview: PreviewToStart,
      from: StartFrom,
      viewerId: string,
    ): Effect.Effect<WaveOutcome> =>
      Effect.gen(function* () {
        for (;;) {
          const settled = yield* awaitWave(preview, from, viewerId, "wait");
          if (settled === null) continue;
          if (settled._tag === "ElsewhereDeclined") continue;
          if (settled._tag !== "ClaimerDeclined") return settled;
          if (settled.by === viewerId) return refused(settled.answer);
        }
      });

    const poll: StartWaves["poll"] = (preview, from, viewerId) =>
      Effect.map(awaitWave(preview, from, viewerId, "poll"), (settled) => {
        if (settled === null || settled._tag === "ElsewhereDeclined") return null;
        if (settled._tag === "ClaimerDeclined")
          return settled.by === viewerId ? refused(settled.answer) : null;
        return settled;
      });

    return { join, poll } satisfies StartWaves;
  });
