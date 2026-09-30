import { CaptureStoreRepo } from "@mend/db";
import {
  type CaptureClass,
  type CaptureClassSnaps,
  type CapturePosition,
  type CaptureOverdue,
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

import { HARNESS_WARMUP_TIMEOUT } from "./agent-start.ts";
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
  /**
   * How often the reaper reads a running executor's capture status (nothing flushed): what shows
   * a failing snap while it fails. MEND_CAPTURE_STATUS_SECONDS.
   */
  readonly statusInterval: Duration.Duration;
  /** The least time between two status reads a client's view asks for, per session. */
  readonly statusMinInterval: Duration.Duration;
  /**
   * How long a launch waits for the worktree's previous executor to end (saving, unreachable or
   * lapsed) before it is refused. A save takes 10–60 s on S3 and ~10–20 min on Garage.
   * MEND_LAUNCH_LEASE_WAIT_SECONDS.
   */
  readonly leaseWait: Duration.Duration;
  /** Between two looks at the previous executor while a launch waits for it. */
  readonly leaseWaitInterval: Duration.Duration;
  /**
   * How long a create may go with no executor on the platform before the session line says the
   * workspace image is being built (SDK 0.38.0 reports no build state; Core builds or finds the
   * image before it launches a runtime).
   */
  readonly imageBuildAfter: Duration.Duration;
  /** Between two looks at a create's executor while it gets ready. */
  readonly createPhaseInterval: Duration.Duration;
  /** How long a launch's harness warm-up may run before it is abandoned (`harnessWarmupArgv`). */
  readonly harnessWarmupTimeout: Duration.Duration;
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
  statusInterval: Duration.seconds(45),
  statusMinInterval: Duration.seconds(10),
  leaseWait: Duration.minutes(30),
  leaseWaitInterval: Duration.seconds(5),
  imageBuildAfter: Duration.seconds(20),
  createPhaseInterval: Duration.seconds(5),
  harnessWarmupTimeout: HARNESS_WARMUP_TIMEOUT,
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
      const statusSeconds = yield* Config.int("MEND_CAPTURE_STATUS_SECONDS").pipe(
        Config.withDefault(Duration.toSeconds(DEFAULT_DRAIN_POLICY.statusInterval)),
      );
      const leaseWaitSeconds = yield* Config.int("MEND_LAUNCH_LEASE_WAIT_SECONDS").pipe(
        Config.withDefault(Duration.toSeconds(DEFAULT_DRAIN_POLICY.leaseWait)),
      );
      return {
        ...DEFAULT_DRAIN_POLICY,
        leaseWait: Duration.seconds(Math.max(0, leaseWaitSeconds)),
        statusInterval: Duration.seconds(Math.max(5, statusSeconds)),
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

/** The unreadable paths sealantd names (the first 20); anything else reads none. */
const unreadablePathsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((path): path is string => typeof path === "string" && path !== "")
    : [];

/** A time sealantd may report as unix milliseconds (or Core as ISO-8601); null otherwise. */
const reportedTime = (value: unknown): Date | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value);
  if (typeof value === "string" && value !== "") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
};

/** A string field sealantd may report; absent, empty or malformed reads null. */
const reportedText = (report: object, key: string): string | null => {
  const value: unknown = Reflect.get(report, key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/** A duration or time in ms as the wire may carry a 64-bit number: a number, a bigint, digits. */
const reportedMillis = (value: unknown): number | null => {
  const ms =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : value;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/**
 * A capture step past its bound (`CaptureStatusReport.overdue`, field 31, sealantd e2e8): `{ step,
 * startedUnixMs, runningMs, boundMs }` as Core's SDK surfaces it in camelCase (the protobuf's
 * `started_unix_ms`, `running_ms`, `bound_ms` read too). Null when the answer carries none or no
 * step: absent from an older daemon and from a Core that does not forward it.
 */
const overdueOf = (value: unknown): CaptureOverdue | null => {
  if (typeof value !== "object" || value === null) return null;
  const step = textOf(fieldOf(value, "step"));
  if (step === null) return null;
  const started = reportedMillis(
    fieldOf(value, "startedUnixMs") ?? fieldOf(value, "started_unix_ms"),
  );
  return {
    step,
    startedAt: started === null || started === 0 ? null : new Date(started),
    runningMs: reportedMillis(fieldOf(value, "runningMs") ?? fieldOf(value, "running_ms")) ?? 0,
    boundMs: reportedMillis(fieldOf(value, "boundMs") ?? fieldOf(value, "bound_ms")),
  };
};

const captureClassOf = (value: unknown): CaptureClass | null =>
  value === "small" || value === "bulk" ? value : null;

/** The classes a `refused` answer names (`["bulk"]`, or one class); null when it names none. */
const refusedClassesOf = (value: unknown): ReadonlyArray<CaptureClass> | null => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const known = captureClassOf(entry);
      return known === null ? [] : [known];
    });
  }
  const one = captureClassOf(value);
  return one === null ? null : [one];
};

/**
 * Each class's snaps (`snaps`, sealantd's per-class health): failing while its last snap has an
 * error or a failing-since time. Null when the answer carries none.
 */
const classSnapsOf = (value: unknown): ReadonlyArray<CaptureClassSnaps> | null => {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const known = captureClassOf(Reflect.get(entry, "class"));
    if (known === null) return [];
    const error = Reflect.get(entry, "lastSnapError");
    const failing =
      (typeof error === "string" && error.trim() !== "") ||
      reportedTime(Reflect.get(entry, "snapFailingSinceUnixMs")) !== null;
    return [{ class: known, failing }];
  });
};

/** A field of an object, when it is one. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * Where in its own history the executor made an answer (`CapturePosition`, cross-repo decision
 * 17): sealantd's stamp — `launch`, `boot_id`, `boot_generation`, `observation` (status report
 * fields 27–30), as Core's SDK surfaces them in camelCase under `origin` — with the answer's own
 * `epoch` and `headN`. A field the answer does not carry reads null (an older daemon, an SDK that drops it),
 * and such a position orders nothing. An answer without an epoch has no position.
 */
export const capturePositionOf = (report: object): CapturePosition | null => {
  // Core's SDK carries the stamp as `origin`; a relay that passes sealantd's fields through
  // carries them on the answer itself.
  const origin = fieldOf(report, "origin");
  const stamp = typeof origin === "object" && origin !== null ? origin : report;
  const epoch = countOf(fieldOf(stamp, "epoch")) ?? countOf(fieldOf(report, "epoch"));
  if (epoch === null) return null;
  return {
    epoch,
    launchId: textOf(fieldOf(stamp, "launch")),
    bootId: textOf(fieldOf(stamp, "bootId")),
    bootGeneration: countOf(fieldOf(stamp, "bootGeneration")),
    observation: countOf(fieldOf(stamp, "observation")),
    headN: countOf(fieldOf(report, "headN")) ?? countOf(fieldOf(stamp, "headN")),
  };
};

/**
 * A flush or status answer as Mend reads it (`CaptureReading`). The SDK types what sealantd
 * reported when it was cut; `pendingBytes`, `pendingBulk`, `bulkDirty`, `refused`, `complete`,
 * `incompleteReason` (sealantd's `incomplete_reason`) and a failing snap (`lastSnapError`,
 * `snapFailingSinceUnixMs`, `snapsFailed`, `unreadable`, `unreadablePaths`) are read when the
 * answer carries them (a newer sealantd behind the same SDK) and are null otherwise
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
  snapError: reportedText(report, "lastSnapError"),
  snapFailingSince: reportedTime(
    Reflect.get(report, "snapFailingSinceUnixMs") ?? Reflect.get(report, "snapFailingSince"),
  ),
  snapsFailed: reportedCount(Reflect.get(report, "snapsFailed")),
  unreadable: reportedCount(Reflect.get(report, "unreadable")),
  unreadablePaths: unreadablePathsOf(Reflect.get(report, "unreadablePaths")),
  epoch: report.epoch,
  snaps: classSnapsOf(Reflect.get(report, "snaps")),
  refusedClasses: "refused" in report ? refusedClassesOf(report.refused) : null,
  repairing:
    typeof Reflect.get(report, "repairing") === "boolean"
      ? Reflect.get(report, "repairing") === true
      : null,
  position: capturePositionOf(report),
  overdue: overdueOf(Reflect.get(report, "overdue")),
});
