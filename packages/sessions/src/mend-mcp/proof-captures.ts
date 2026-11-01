import { createHash } from "node:crypto";

import type {
  ProofMissingParams,
  ProofScreenshotParams,
  ProofVideoStartParams,
} from "@mend/agent-protocol";
import {
  AgentConversationRepo,
  ProofArtifactsRepo,
  ScreensRepo,
  WorktreeChangesRepo,
} from "@mend/db";
import { ProofArtifactId, type SessionId } from "@mend/domain";
import {
  FrameDigest,
  ProofArtifact,
  type ProofSource,
  proofBlobKey,
  proofLabel,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Context, DateTime, Effect, Fiber, Layer, Semaphore } from "effect";
import { McpSchema } from "effect/ai";

import { SessionEngine } from "../engine.ts";
import { screenFrameBlobKey } from "../screen/frames.ts";
import { cropPng } from "../screen/png.ts";
import {
  ScreenRecorder,
  type RecordingId,
  type RecordedVideo,
  type RecordingUnavailable,
} from "../screen/recorder.ts";
import { Screens } from "../screen/screens.ts";
import type { Caller } from "./caller.ts";

export class ProofCaptures extends Context.Service<
  ProofCaptures,
  {
    readonly screenshot: (
      caller: Caller,
      params: ProofScreenshotParams,
    ) => Effect.Effect<McpSchema.CallToolResult>;
    readonly videoStart: (
      caller: Caller,
      params: ProofVideoStartParams,
    ) => Effect.Effect<McpSchema.CallToolResult>;
    readonly videoStop: (caller: Caller) => Effect.Effect<McpSchema.CallToolResult>;
    readonly missing: (
      caller: Caller,
      params: ProofMissingParams,
    ) => Effect.Effect<McpSchema.CallToolResult>;
  }
>()("@mend/sessions/ProofCaptures") {}

const refused = (refusal: string, message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ artifactId: null, label: null, refusal, message }) },
    ],
  });

const resultOf = (
  artifact: ProofArtifact,
  png: Uint8Array | null,
  tool: "video" | "other" = "other",
) =>
  new McpSchema.CallToolResult({
    ...(tool === "video" && artifact.capture._tag === "NotCaptured" ? { isError: true } : {}),
    content: [
      ...(png === null
        ? []
        : [{ type: "image", data: png, mimeType: "image/png" } satisfies McpSchema.ContentBlock]),
      {
        type: "text",
        text: JSON.stringify({
          ...(tool === "video" && artifact.capture._tag === "NotCaptured"
            ? { refusal: "capture_unavailable" }
            : {}),
          artifactId: artifact.id,
          label: proofLabel(artifact, (at) => `${at.toISOString().slice(11, 16)} UTC`),
          message:
            artifact.capture._tag === "Recording"
              ? "recording · stop with proof_video_stop within 60 s"
              : artifact.capture._tag === "NotCaptured"
                ? "Recorded what could not be captured and why."
                : "Recorded the screen as observed, with the reported source and launch details.",
        }),
      },
    ],
  });

const warn = (sessionId: SessionId | null, message: string) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ sessionId }));

export const ProofCapturesLive: Layer.Layer<
  ProofCaptures,
  never,
  | Screens
  | ScreensRepo
  | ScreenRecorder
  | ProofArtifactsRepo
  | WorktreeChangesRepo
  | AgentConversationRepo
  | BlobStore
  | SessionEngine
> = Layer.effect(
  ProofCaptures,
  Effect.gen(function* () {
    const screens = yield* Screens;
    const artifacts = yield* ProofArtifactsRepo;
    const changes = yield* WorktreeChangesRepo;
    const conversation = yield* AgentConversationRepo;
    const blobs = yield* BlobStore;
    const engine = yield* SessionEngine;
    const screenLog = yield* ScreensRepo;
    const recorder = yield* ScreenRecorder;
    const scope = yield* Effect.scope;
    const recordings = new Map<
      SessionId,
      {
        readonly artifact: ProofArtifact;
        readonly id: RecordingId;
        readonly lock: Semaphore.Semaphore;
      }
    >();
    const stoppedCalls = new Map<string, ProofArtifactId>();
    const lastSeq = (screenId: Parameters<typeof screenLog.log>[0]) =>
      screenLog.log(screenId).pipe(Effect.map((entries) => entries.at(-1)?.seq ?? 0));
    const unavailable = (artifact: ProofArtifact, reason: string) =>
      artifacts.settleVideo(artifact.id, { _tag: "NotCaptured", kind: "video", reason });

    const finish = (
      recording: { readonly artifact: ProofArtifact; readonly lock: Semaphore.Semaphore },
      media: Effect.Effect<RecordedVideo, RecordingUnavailable>,
    ) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(media);
        return yield* recording.lock.withPermit(
          Effect.gen(function* () {
            const current = yield* artifacts.byId(recording.artifact.id);
            if (current === null || current.capture._tag !== "Recording") return current;
            if (result._tag === "Failure") {
              yield* warn(current.sessionId, "proof video media unavailable");
              return yield* unavailable(
                current,
                result.failure.reason === "invalid_media"
                  ? "The screen video could not produce playable media"
                  : "The screen video is no longer available",
              );
            }
            const video = result.success;
            const capture = current.capture;
            return yield* Effect.gen(function* () {
              const key = proofBlobKey(current.changeId, current.id, "video/mp4");
              yield* blobs.put(key, video.mp4, { ifAbsent: true });
              return yield* artifacts.settleVideo(current.id, {
                _tag: "Video",
                span: {
                  screenId: capture.screenId,
                  fromSeq: capture.fromSeq,
                  toSeq: yield* lastSeq(capture.screenId),
                },
                media: {
                  blobKey: key,
                  mimeType: "video/mp4",
                  bytes: video.mp4.length,
                  sha256: createHash("sha256").update(video.mp4).digest("hex"),
                },
                durationMs: video.durationMs,
                ending: video.ending,
                region: video.region ?? null,
              });
            }).pipe(
              Effect.catchCause(() =>
                Effect.logWarning("proof video could not be stored").pipe(
                  Effect.andThen(unavailable(current, "Mend could not store the screen video")),
                ),
              ),
            );
          }),
        );
      }).pipe(
        Effect.catchCause(() =>
          warn(recording.artifact.sessionId, "proof video finalization unavailable").pipe(
            Effect.andThen(
              unavailable(recording.artifact, "Mend could not finish the screen video"),
            ),
          ),
        ),
      );
    // A retry waits for this process's first insert before asking the screen for another frame.
    const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; pending: number }>();
    const serially = <A>(caller: Caller, effect: Effect.Effect<A>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = locks.get(caller.sessionId) ?? {
            semaphore: Semaphore.makeUnsafe(1),
            pending: 0,
          };
          lock.pending += 1;
          locks.set(caller.sessionId, lock);
          return lock;
        }),
        (lock) => lock.semaphore.withPermit(effect),
        (lock) =>
          Effect.sync(() => {
            lock.pending -= 1;
            if (lock.pending === 0) locks.delete(caller.sessionId);
          }),
      );

    const sourceOf = (caller: Caller) =>
      engine.checkpointNow(caller.sessionId, "proof-capture").pipe(
        Effect.map(
          (checkpoint): ProofSource => ({
            _tag: "Checkpoint",
            checkpointId: checkpoint.id,
            ordinal: checkpoint.ordinal,
            commit: checkpoint.sha,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed<ProofSource>({
            _tag: "Unknown",
            reason: `Checkpoint unavailable (${error._tag})`,
          }),
        ),
      );

    const answer = (
      caller: Caller,
      params:
        | ProofScreenshotParams
        | ProofMissingParams
        | (ProofVideoStartParams & { readonly video: true }),
    ) =>
      Effect.gen(function* () {
        const refusal = yield* screens.authorize(caller);
        if (refusal !== null)
          return refused(
            refusal,
            `The screen refused this caller: ${refusal}. No proof artifact was recorded.`,
          );
        const callKey = caller.callKey;
        if (callKey === null)
          return refused(
            "unattributed_caller",
            "This call has no key. No proof artifact was recorded.",
          );
        const previous = yield* artifacts.byCall(caller.sessionId, callKey);
        if (previous !== null) {
          const capture = previous.capture;
          return capture._tag === "Screenshot"
            ? resultOf(previous, yield* blobs.get(capture.media.blobKey))
            : resultOf(previous, null, "video" in params ? "video" : "other");
        }
        const state = yield* screens.state(caller.sessionId);
        if (state === null)
          return refused(
            "no_screen",
            "This session has no screen. No proof artifact was recorded.",
          );
        if (state.screen.input._tag !== "Agent" && state.screen.input._tag !== "AwaitingAgent")
          return refused("held", "A person holds the screen. No proof artifact was recorded.");
        const change = yield* changes.bySession(caller.sessionId);
        if (change === null)
          return refused("no_change", "This session has no change to attach proof to.");
        const source = yield* sourceOf(caller);
        const turns = yield* conversation.listTurns(caller.sessionId);
        const processId = caller.agentProcess?.id;
        const turn = turns
          .filter(
            (candidate) =>
              candidate.processId === processId &&
              candidate.status !== "queued" &&
              candidate.status !== "cancelled",
          )
          .toSorted((a, b) => b.ordinal - a.ordinal)[0];
        const id = ProofArtifactId.make(crypto.randomUUID());
        let png: Uint8Array | null = null;
        let observedAt = yield* DateTime.nowAsDate;
        let capture: ProofArtifact["capture"];
        let recordingId: RecordingId | undefined;
        if ("video" in params) {
          const screen = state.screen;
          if (screen.life._tag !== "Live" || screen.processId === null)
            return refused(
              "no_screen",
              "This session has no live screen. No proof artifact was recorded.",
            );
          const started = yield* Effect.result(
            recorder.start({
              screenId: screen.id,
              sessionId: caller.sessionId,
              processId: screen.processId,
              display: screen.display,
              ...(params.region === undefined ? {} : { region: params.region }),
            }),
          );
          if (started._tag === "Failure") {
            if (started.failure.reason !== "no_encoder")
              return refused(
                started.failure.reason,
                `The screen refused recording: ${started.failure.reason}. No proof artifact was recorded.`,
              );
            capture = {
              _tag: "NotCaptured",
              kind: "video",
              reason: "this workspace has no screen video encoder",
            };
          } else {
            recordingId = started.success;
            capture = {
              _tag: "Recording",
              region: params.region ?? null,
              screenId: screen.id,
              fromSeq: yield* lastSeq(screen.id).pipe(
                Effect.onError(() => recorder.stop(started.success).pipe(Effect.ignore)),
              ),
            };
          }
        } else if ("reason" in params)
          capture = { _tag: "NotCaptured", kind: params.kind, reason: params.reason };
        else {
          const look = yield* screens.look(caller);
          if (look._tag !== "Answered")
            return refused(
              look._tag === "Refused" ? look.refusal : "observation_unavailable",
              "The screen did not return an observation. No proof artifact was recorded.",
            );
          const region = params.region;
          png =
            region === undefined ? look.png : yield* Effect.try(() => cropPng(look.png, region));
          observedAt = look.observedAt;
          const digest = createHash("sha256").update(png).digest("hex");
          const key = proofBlobKey(change.id, id, "image/png");
          if (look.frameId === null || params.region !== undefined)
            yield* blobs.put(key, png, { ifAbsent: true });
          else
            yield* blobs.copy(
              screenFrameBlobKey(look.receipt.screenId, FrameDigest.make(digest)),
              key,
            );
          capture = {
            _tag: "Screenshot",
            region: params.region ?? null,
            moment: { screenId: look.receipt.screenId, seq: look.receipt.seq },
            media: { blobKey: key, mimeType: "image/png", bytes: png.length, sha256: digest },
          };
        }
        const at = yield* DateTime.nowAsDate;
        const artifact = new ProofArtifact({
          id,
          changeId: change.id,
          projectId: change.projectId,
          worktreeId: change.worktreeId,
          sessionId: caller.sessionId,
          turnId: turn?.id ?? null,
          title: params.title,
          caption: "caption" in params ? params.caption : "",
          source,
          capture,
          launch: "launch" in params ? (params.launch ?? null) : null,
          differences: "differences" in params ? (params.differences ?? null) : null,
          observedFrom: observedAt,
          observedTo: capture._tag === "Screenshot" ? observedAt : null,
          createdAt: at,
        });
        const save = Effect.gen(function* () {
          const saved = yield* artifacts.insert(artifact, callKey);
          if (recordingId !== undefined) {
            const recording = { artifact: saved, id: recordingId, lock: Semaphore.makeUnsafe(1) };
            recordings.set(caller.sessionId, recording);
            yield* Effect.forkIn(
              finish(recording, recorder.onFinished(recording.id)).pipe(
                Effect.catchCause(() =>
                  warn(caller.sessionId, "proof video finalization unavailable"),
                ),
              ),
              scope,
            );
          }
          return saved;
        });
        const saved = yield* save.pipe(
          Effect.onError(() =>
            recordingId === undefined
              ? Effect.void
              : recorder
                  .stop(recordingId)
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      unavailable(artifact, "Mend could not store the screen video").pipe(
                        Effect.ignore,
                      ),
                    ),
                  ),
          ),
        );
        return resultOf(saved, png, "video" in params ? "video" : "other");
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("proof capture unavailable").pipe(
            Effect.annotateLogs({ sessionId: caller.sessionId, error: error._tag }),
            Effect.as(
              refused(
                "capture_unavailable",
                "Mend could not store this proof artifact. The session and change remain available; retry the call.",
              ),
            ),
          ),
        ),
      );
    const stop = (caller: Caller) =>
      Effect.gen(function* () {
        const refusal = yield* screens.authorize(caller);
        if (refusal !== null)
          return refused(refusal, `The screen refused this caller: ${refusal}.`);
        if (caller.callKey === null) return refused("unattributed_caller", "This call has no key.");
        const key = JSON.stringify([caller.sessionId, caller.callKey]);
        const previous = stoppedCalls.get(key);
        if (previous !== undefined) {
          const artifact = yield* artifacts.byId(previous);
          if (artifact !== null) return resultOf(artifact, null, "video");
        }
        const recording = recordings.get(caller.sessionId);
        if (recording === undefined)
          return refused("not_recording", "This session has no proof video recording to stop.");
        const current = yield* artifacts.byId(recording.artifact.id);
        const settled =
          current?.capture._tag === "Recording"
            ? yield* finish(recording, recorder.stop(recording.id))
            : current;
        if (settled === null)
          return refused("capture_unavailable", "This proof artifact is no longer available.");
        stoppedCalls.set(key, settled.id);
        return resultOf(settled, null, "video");
      });
    const videoCall = (caller: Caller, effect: Effect.Effect<McpSchema.CallToolResult, unknown>) =>
      serially(
        caller,
        effect.pipe(
          Effect.catchCause(() =>
            warn(caller.sessionId, "proof video capture unavailable").pipe(
              Effect.as(
                refused(
                  "capture_unavailable",
                  "Mend could not capture this video. The session and change remain available; retry the call.",
                ),
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));
    return {
      videoStart: (caller, params) => videoCall(caller, answer(caller, { ...params, video: true })),
      videoStop: (caller) => videoCall(caller, stop(caller)),
      screenshot: (caller, params) => serially(caller, answer(caller, params)),
      missing: (caller, params) => serially(caller, answer(caller, params)),
    };
  }),
);
