import { randomUUID } from "node:crypto";

import type { ProofRegion, ProofVideoEnding } from "@mend/domain/workbench";
import { PROOF_LIMITS, SCREEN_LIMITS } from "@mend/domain/workbench";
import {
  type RecordedVideo,
  RecorderRefusal,
  RecordingId,
  type RecordingScreen,
  RecordingUnavailable,
  ScreenRecorder,
  Screens,
} from "@mend/sessions";
import { Clock, Deferred, Effect, Exit, Layer, type Scope } from "effect";

import { ProofVideoBuffer } from "./proof-video.ts";
import { ScreenVideoSource } from "./screen-video-source.ts";
import type { ScreenVideoFrame } from "./screen-video.ts";

interface Recording {
  readonly id: RecordingId;
  readonly ready: Deferred.Deferred<RecordingId, RecorderRefusal>;
  readonly ended: Deferred.Deferred<ProofVideoEnding>;
  readonly result: Deferred.Deferred<RecordedVideo, RecordingUnavailable>;
  collected: boolean;
}

const make: Effect.Effect<
  ScreenRecorder["Service"],
  never,
  Screens | ScreenVideoSource | Scope.Scope
> = Effect.gen(function* () {
  const screens = yield* Screens;
  const video = yield* ScreenVideoSource;
  const scope = yield* Effect.scope;
  const recordings = new Map<RecordingId, Recording>();
  const active = new Map<string, Recording>();

  const expire = (id: RecordingId) =>
    Effect.sleep("10 minutes").pipe(Effect.andThen(Effect.sync(() => recordings.delete(id))));

  const run = (input: RecordingScreen, recording: Recording) =>
    Effect.gen(function* () {
      const buffer = new ProofVideoBuffer();
      const firstFrame = yield* Deferred.make<void>();
      let startedAt: number | undefined;
      let region: ProofRegion | null = null;
      const capture = Effect.scoped(
        Effect.gen(function* () {
          const state = yield* screens.state(input.sessionId);
          const screen = state?.screen;
          if (
            screen?.id !== input.screenId ||
            screen.life._tag !== "Live" ||
            screen.processId !== input.processId ||
            screen.display !== input.display
          )
            return yield* new RecorderRefusal({ reason: "no_screen" });
          const subscriber = {
            frame: (frame: ScreenVideoFrame) => {
              if (Deferred.isDoneUnsafe(recording.ended)) return;
              if (startedAt === undefined && !frame.keyframe) return;
              const admitted = buffer.push(frame);
              if (admitted !== true) {
                Deferred.doneUnsafe(recording.ended, Exit.succeed(admitted));
                return;
              }
              if (startedAt === undefined) {
                startedAt = frame.receivedAt;
                Deferred.doneUnsafe(firstFrame, Exit.void);
              }
            },
            ended: () => {
              Deferred.doneUnsafe(recording.ended, Exit.succeed("interrupted"));
            },
          };
          region = yield* video
            .subscribe(screen, subscriber, input.region)
            .pipe(
              Effect.catch(() =>
                input.region === undefined
                  ? Effect.fail(new RecorderRefusal({ reason: "no_encoder" }))
                  : video
                      .subscribe(screen, subscriber)
                      .pipe(Effect.mapError(() => new RecorderRefusal({ reason: "no_encoder" }))),
              ),
            );
          // A shared upstream may already be ready; this subscriber still needs its own IDR.
          if (startedAt === undefined)
            yield* Effect.raceFirst(
              Deferred.await(firstFrame),
              Deferred.await(recording.ended).pipe(
                Effect.andThen(Effect.fail(new RecorderRefusal({ reason: "no_encoder" }))),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: "5 seconds",
                orElse: () => Effect.fail(new RecorderRefusal({ reason: "no_encoder" })),
              }),
            );
          yield* Deferred.succeed(recording.ready, recording.id);
          const ending = yield* Effect.raceFirst(
            Deferred.await(recording.ended),
            Effect.sleep(
              Math.max(
                0,
                PROOF_LIMITS.videoMs - ((yield* Clock.currentTimeMillis) - (startedAt ?? 0)),
              ),
            ).pipe(Effect.as<ProofVideoEnding>("time-limit")),
          );
          yield* Deferred.succeed(recording.ended, ending);
          return ending;
        }),
      );
      const ending = yield* capture.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (active.get(input.screenId) === recording) active.delete(input.screenId);
          }),
        ),
        Effect.result,
      );
      if (ending._tag === "Failure") {
        yield* Deferred.fail(recording.ready, ending.failure);
        yield* Deferred.fail(
          recording.result,
          new RecordingUnavailable({ reason: "invalid_media" }),
        );
        recordings.delete(recording.id);
        return;
      }
      const result = yield* Effect.tryPromise({
        try: () => buffer.finish(region ?? SCREEN_LIMITS),
        catch: () => new RecordingUnavailable({ reason: "invalid_media" }),
      }).pipe(
        Effect.map((media): RecordedVideo => ({ ...media, ending: ending.success, region })),
        Effect.exit,
      );
      yield* Deferred.done(recording.result, result);
      yield* Effect.forkIn(expire(recording.id), scope);
    });

  const lookup = (id: RecordingId) =>
    Effect.suspend(() => {
      const recording = recordings.get(id);
      return recording === undefined
        ? Effect.fail(new RecordingUnavailable({ reason: "not_found" }))
        : Effect.succeed(recording);
    });

  return ScreenRecorder.of({
    start: Effect.fn("ScreenRecorder.start")((input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (active.has(input.screenId))
            return yield* new RecorderRefusal({ reason: "already_recording" });
          const recording: Recording = {
            id: RecordingId.make(randomUUID()),
            ready: Deferred.makeUnsafe<RecordingId, RecorderRefusal>(),
            ended: Deferred.makeUnsafe<ProofVideoEnding>(),
            result: Deferred.makeUnsafe<RecordedVideo, RecordingUnavailable>(),
            collected: false,
          };
          active.set(input.screenId, recording);
          recordings.set(recording.id, recording);
          yield* Effect.forkIn(run(input, recording).pipe(Effect.interruptible), scope);
          return yield* restore(Deferred.await(recording.ready)).pipe(
            Effect.onInterrupt(() => Deferred.succeed(recording.ended, "interrupted")),
          );
        }),
      ),
    ),
    stop: Effect.fn("ScreenRecorder.stop")(function* (id) {
      const recording = yield* lookup(id);
      if (recording.collected) return yield* new RecordingUnavailable({ reason: "not_found" });
      recording.collected = true;
      yield* Deferred.succeed(recording.ended, "stopped");
      return yield* Deferred.await(recording.result).pipe(
        Effect.ensuring(Effect.sync(() => recordings.delete(id))),
      );
    }, Effect.uninterruptible),
    onFinished: Effect.fn("ScreenRecorder.onFinished")(function* (id) {
      return yield* Deferred.await((yield* lookup(id)).result);
    }),
  });
});

/** Recording and RTC consume the same ScreenVideoSource instance in the HTTP process. */
export const ScreenRecorderLive: Layer.Layer<ScreenRecorder, never, Screens | ScreenVideoSource> =
  Layer.effect(ScreenRecorder, make);
