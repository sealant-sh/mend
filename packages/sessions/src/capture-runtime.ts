import { CaptureStoreRepo } from "@mend/db";
import {
  type CaptureReading,
  DEFAULT_CAPTURE_DRAIN_ESTIMATE_SECONDS,
  DEFAULT_CAPTURE_DRAIN_STALL_SECONDS,
  DEFAULT_EXECUTOR_DEADLINE_MARGIN_SECONDS,
  FALLBACK_REPLACEMENT_AGE_SECONDS,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import type { WorkspaceCaptureStatus } from "@sealant/sdk";
import { Config, Duration, Effect, Layer, Option } from "effect";
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
/**
 * Replace an executor before a platform's 8 h cap (MicroVMs): ≈ 7 h 30. Only when the cap is
 * unknown — neither the platform nor MEND_EXECUTOR_MAX_SECONDS says (`planExecutorCap`).
 */
export const REPLACEMENT_AGE_SECONDS = FALLBACK_REPLACEMENT_AGE_SECONDS;

/**
 * How a drain paces itself and plans ahead of the platform's cap (docs/adr/0002, "Stop drains,
 * then terminates"). Numbers only; the engine owns the loop.
 */
export interface CaptureDrainPolicyShape {
  /** No movement for this long reads `not saved · workspace kept`. MEND_CAPTURE_DRAIN_STALL_SECONDS. */
  readonly stallSeconds: number;
  /** Between two flushes of one drain. */
  readonly pollInterval: Duration.Duration;
  /** One flush's own bound; a flush that does not answer is a step with no movement. */
  readonly flushTimeout: Duration.Duration;
  /** How long Mend watches for the platform to report the terminated workspace. */
  readonly terminationWait: Duration.Duration;
  /**
   * The platform's cap on one executor, in seconds from its start (MEND_EXECUTOR_MAX_SECONDS).
   * Null = not stated; the SDK's own deadline replaces it once the platform reports one.
   */
  readonly executorMaxSeconds: number | null;
  /** MEND_EXECUTOR_DEADLINE_MARGIN_SECONDS. */
  readonly deadlineMarginSeconds: number;
  /** MEND_CAPTURE_DRAIN_ESTIMATE_SECONDS: how long a planned drain is given before the deadline. */
  readonly drainEstimateSeconds: number;
  /**
   * A kept drain (`not saved · workspace kept`) is looked at again after this long while nothing
   * about it changes, and each unchanged look doubles the wait up to `keptRetryMax`. Anything that
   * changes (the head, the reason, what is pending, the workspace going) is looked at at once.
   */
  readonly keptRetryFirst: Duration.Duration;
  readonly keptRetryMax: Duration.Duration;
}

export class CaptureDrainPolicy extends Context.Service<
  CaptureDrainPolicy,
  CaptureDrainPolicyShape
>()("@mend/sessions/CaptureDrainPolicy") {}

const DEFAULT_DRAIN_POLICY: CaptureDrainPolicyShape = {
  stallSeconds: DEFAULT_CAPTURE_DRAIN_STALL_SECONDS,
  pollInterval: Duration.seconds(5),
  flushTimeout: Duration.minutes(2),
  terminationWait: Duration.minutes(2),
  executorMaxSeconds: null,
  deadlineMarginSeconds: DEFAULT_EXECUTOR_DEADLINE_MARGIN_SECONDS,
  drainEstimateSeconds: DEFAULT_CAPTURE_DRAIN_ESTIMATE_SECONDS,
  keptRetryFirst: Duration.seconds(10),
  keptRetryMax: Duration.minutes(5),
};

/** The defaults, with nothing read from the environment. */
export const CaptureDrainPolicyDefault: Layer.Layer<CaptureDrainPolicy> = Layer.succeed(
  CaptureDrainPolicy,
  DEFAULT_DRAIN_POLICY,
);

/** The operator's statements, over the defaults. */
export const CaptureDrainPolicyLive: Layer.Layer<CaptureDrainPolicy, Config.ConfigError> =
  Layer.effect(
    CaptureDrainPolicy,
    Effect.gen(function* () {
      const stallSeconds = yield* Config.int("MEND_CAPTURE_DRAIN_STALL_SECONDS").pipe(
        Config.withDefault(DEFAULT_CAPTURE_DRAIN_STALL_SECONDS),
      );
      const executorMaxSeconds = yield* Config.option(Config.int("MEND_EXECUTOR_MAX_SECONDS"));
      const deadlineMarginSeconds = yield* Config.int("MEND_EXECUTOR_DEADLINE_MARGIN_SECONDS").pipe(
        Config.withDefault(DEFAULT_EXECUTOR_DEADLINE_MARGIN_SECONDS),
      );
      const drainEstimateSeconds = yield* Config.int("MEND_CAPTURE_DRAIN_ESTIMATE_SECONDS").pipe(
        Config.withDefault(DEFAULT_CAPTURE_DRAIN_ESTIMATE_SECONDS),
      );
      return {
        ...DEFAULT_DRAIN_POLICY,
        stallSeconds: Math.max(1, stallSeconds),
        executorMaxSeconds: Option.getOrNull(executorMaxSeconds),
        deadlineMarginSeconds: Math.max(0, deadlineMarginSeconds),
        drainEstimateSeconds: Math.max(0, drainEstimateSeconds),
      };
    }),
  );

/** A count sealantd may report and the SDK may not type yet: absent or malformed reads null. */
const reportedCount = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  // sealantd's `refused` is the list of classes its byte quota refused (`["bulk"]`); the next
  // SDK's `capture.status()` names one class (`"small"` · `"bulk"`) or null.
  if (Array.isArray(value)) return value.length;
  if (value === "small" || value === "bulk") return 1;
  return null;
};

/**
 * A flush answer as Mend reads it (`CaptureReading`). The SDK types what sealantd reported when
 * it was cut; `pendingBytes`, `pendingBulk`, `bulkDirty`, `refused`, `complete` and
 * `incompleteReason` (sealantd's `incomplete_reason`) are read when the answer carries them (a newer sealantd behind the same SDK) and are null otherwise
 * (PLATFORM-FEEDBACK.md 2026-09-27).
 */
export const readCaptureReport = (report: WorkspaceCaptureStatus): CaptureReading => ({
  pending: report.pending,
  pendingBytes: "pendingBytes" in report ? reportedCount(report.pendingBytes) : null,
  pendingBulk: "pendingBulk" in report ? reportedCount(report.pendingBulk) : null,
  refused: "refused" in report ? reportedCount(report.refused) : null,
  headN: report.headN ?? null,
  registered: report.registered,
  uploadedBytes: report.uploadedBytes,
  fenced: report.fenced,
  paused: report.paused,
  bulkDirty:
    "bulkDirty" in report && typeof report.bulkDirty === "boolean" ? report.bulkDirty : null,
  // Absent reads null, and null is never saved (`captureSaved`): an answer that does not say a
  // final flush completed is not proof that one did.
  complete: "complete" in report && typeof report.complete === "boolean" ? report.complete : null,
  incompleteReason:
    "incompleteReason" in report && typeof report.incompleteReason === "string"
      ? report.incompleteReason
      : null,
});
