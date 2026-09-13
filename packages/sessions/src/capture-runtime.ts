import { CaptureStoreRepo } from "@mend/db";
import { BlobStore } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { CaptureChannel } from "./capture-channel.ts";

/**
 * What the session engine needs from the capture store, as ONE optional requirement: off under
 * the co-located default (every capture-mode branch in the engine is dead code then, byte for
 * byte the old behaviour), on under `MEND_SESSION_STORE=captured` where it carries the channel
 * (routes + register hub), the pointer store (leases, chains) and the bucket (harvest reads).
 */
export type CaptureRuntimeShape =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly channel: CaptureChannel["Service"];
      readonly repo: CaptureStoreRepo["Service"];
      readonly blobs: BlobStore["Service"];
    };

export class CaptureRuntime extends Context.Service<CaptureRuntime, CaptureRuntimeShape>()(
  "@mend/sessions/CaptureRuntime",
) {}

export const CaptureRuntimeOff: Layer.Layer<CaptureRuntime> = Layer.succeed(CaptureRuntime, {
  enabled: false,
});

export const CaptureRuntimeLive: Layer.Layer<
  CaptureRuntime,
  never,
  CaptureChannel | CaptureStoreRepo | BlobStore
> = Layer.effect(
  CaptureRuntime,
  Effect.gen(function* () {
    const channel = yield* CaptureChannel;
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    return { enabled: true, channel, repo, blobs };
  }),
);

/** Heartbeat and reaper cadence (ADR-0002 "Decisions made here" 8). */
export const LEASE_REAPER_INTERVAL_SECONDS = 10;
/** Replace an executor before a platform's 8 h cap (MicroVMs): ≈ 7 h 30. */
export const REPLACEMENT_AGE_SECONDS = 7 * 60 * 60 + 30 * 60;
