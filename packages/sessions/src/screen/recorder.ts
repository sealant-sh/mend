import type { ScreenId, SessionId, SessionProcessId } from "@mend/domain";
import type { ProofVideoEnding } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import * as Context from "effect/Context";

/** Process-local identity, retained for ten minutes after capture finishes. */
export const RecordingId = Schema.String.pipe(Schema.brand("RecordingId"));
export type RecordingId = typeof RecordingId.Type;

/** Recording observes this existing screen and never starts or keeps it alive. */
export interface RecordingScreen {
  readonly screenId: ScreenId;
  readonly sessionId: SessionId;
  readonly processId: SessionProcessId;
  readonly display: number;
}

/** A playable after video; an interrupted ending must remain visible beside it. */
export interface RecordedVideo {
  readonly mp4: Uint8Array;
  readonly durationMs: number;
  readonly ending: ProofVideoEnding;
}

/** Expected capture admission failures; missing encoders include a five-second IDR timeout. */
export class RecorderRefusal extends Schema.TaggedError<RecorderRefusal>()("RecorderRefusal", {
  reason: Schema.Literals(["no_encoder", "already_recording", "no_screen"]),
}) {}

/** A recording expired, was already collected, or could not produce playable media. */
export class RecordingUnavailable extends Schema.TaggedError<RecordingUnavailable>()(
  "RecordingUnavailable",
  { reason: Schema.Literals(["not_found", "invalid_media"]) },
) {}

/** The HTTP process supplies the recorder beside Screens; no workspace encoder is started here. */
export class ScreenRecorder extends Context.Service<
  ScreenRecorder,
  {
    readonly start: (screen: RecordingScreen) => Effect.Effect<RecordingId, RecorderRefusal>;
    /** Stop also collects an auto-finished recording, once only. */
    readonly stop: (id: RecordingId) => Effect.Effect<RecordedVideo, RecordingUnavailable>;
    /** Wait without stopping or collecting, so auto-finished media can be persisted. */
    readonly onFinished: (id: RecordingId) => Effect.Effect<RecordedVideo, RecordingUnavailable>;
  }
>()("@mend/sessions/ScreenRecorder") {}
