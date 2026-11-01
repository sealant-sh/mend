import { createHash } from "node:crypto";

import type { ProofMissingParams, ProofScreenshotParams } from "@mend/agent-protocol";
import { AgentConversationRepo, ProofArtifactsRepo, WorktreeChangesRepo } from "@mend/db";
import { ProofArtifactId } from "@mend/domain";
import {
  FrameDigest,
  ProofArtifact,
  type ProofSource,
  proofBlobKey,
  proofLabel,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Context, DateTime, Effect, Layer, Semaphore } from "effect";
import { McpSchema } from "effect/ai";

import { SessionEngine } from "../engine.ts";
import { screenFrameBlobKey } from "../screen/frames.ts";
import { Screens } from "../screen/screens.ts";
import type { Caller } from "./caller.ts";

export class ProofCaptures extends Context.Service<
  ProofCaptures,
  {
    readonly screenshot: (
      caller: Caller,
      params: ProofScreenshotParams,
    ) => Effect.Effect<McpSchema.CallToolResult>;
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

const resultOf = (artifact: ProofArtifact, png: Uint8Array | null) =>
  new McpSchema.CallToolResult({
    content: [
      ...(png === null
        ? []
        : [{ type: "image", data: png, mimeType: "image/png" } satisfies McpSchema.ContentBlock]),
      {
        type: "text",
        text: JSON.stringify({
          artifactId: artifact.id,
          label: proofLabel(artifact, (at) => `${at.toISOString().slice(11, 16)} UTC`),
          message:
            artifact.capture._tag === "NotCaptured"
              ? "Recorded what could not be captured and why."
              : "Recorded the screen as observed, with the reported source and launch details.",
        }),
      },
    ],
  });

export const ProofCapturesLive: Layer.Layer<
  ProofCaptures,
  never,
  | Screens
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

    const sourceOf = (
      caller: Caller,
      side: "before" | "after",
      base: ProofArtifact["source"] & { readonly _tag: "Base" },
    ) =>
      side === "before"
        ? Effect.succeed<ProofSource>(base)
        : engine.checkpointNow(caller.sessionId, "proof-capture").pipe(
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

    const answer = (caller: Caller, params: ProofScreenshotParams | ProofMissingParams) =>
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
            : resultOf(previous, null);
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
        const source = yield* sourceOf(caller, params.side, {
          _tag: "Base",
          commit: change.baseSha,
        });
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
        if ("reason" in params)
          capture = { _tag: "NotCaptured", kind: params.kind, reason: params.reason };
        else {
          const look = yield* screens.look(caller);
          if (look._tag !== "Answered")
            return refused(
              look._tag === "Refused" ? look.refusal : "observation_unavailable",
              "The screen did not return an observation. No proof artifact was recorded.",
            );
          png = look.png;
          observedAt = look.observedAt;
          const digest = createHash("sha256").update(png).digest("hex");
          const key = proofBlobKey(change.id, id, "image/png");
          if (look.frameId === null) yield* blobs.put(key, png, { ifAbsent: true });
          else
            yield* blobs.copy(
              screenFrameBlobKey(look.receipt.screenId, FrameDigest.make(digest)),
              key,
            );
          capture = {
            _tag: "Screenshot",
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
          side: params.side,
          source,
          capture,
          launch: "launch" in params ? (params.launch ?? null) : null,
          differences: "differences" in params ? (params.differences ?? null) : null,
          observedFrom: observedAt,
          observedTo: capture._tag === "Screenshot" ? observedAt : null,
          createdAt: at,
        });
        const saved = yield* artifacts.insert(artifact, callKey);
        return resultOf(saved, png);
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
    return {
      screenshot: (caller, params) => serially(caller, answer(caller, params)),
      missing: (caller, params) => serially(caller, answer(caller, params)),
    };
  }),
);
