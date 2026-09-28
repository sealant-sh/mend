import { Schema } from "effect";

/**
 * Saving before stopping (docs/adr/0002-session-capture-store.md, "Stop drains, then
 * terminates"). In capture mode an executor holds the only copy of whatever it has not shipped:
 * small captures, and the git-ignored bulk (node_modules, build output) beside them. Mend never
 * lets that compute go while anything is pending. A stop, a replacement before the platform's cap
 * and a relaunch each drain first — flush, read what is left, repeat — and terminate only once
 * nothing is. A drain that stops moving is recorded and shown, and the workspace is kept; only the
 * owner's "discard unsaved and stop" ends it with captures pending.
 */

/** Why Mend is draining an executor before its compute goes. */
export const CaptureDrainReason = Schema.Literals(["stop", "relaunch", "replacement"]);
export type CaptureDrainReason = typeof CaptureDrainReason.Type;

/** How long a drain may go without progress before it reads `not saved`. */
export const DEFAULT_CAPTURE_DRAIN_STALL_SECONDS = 600;
/** How long a drain is assumed to take when planning ahead of the platform's cap. */
export const DEFAULT_CAPTURE_DRAIN_ESTIMATE_SECONDS = 300;
/** Slack between the planned drain's end and the platform's deadline. */
export const DEFAULT_EXECUTOR_DEADLINE_MARGIN_SECONDS = 300;
/**
 * Replacement age when the platform's cap is unknown (no SDK deadline, no
 * MEND_EXECUTOR_MAX_SECONDS): ≈ 7 h 30, under an 8 h cap.
 */
export const FALLBACK_REPLACEMENT_AGE_SECONDS = 7 * 60 * 60 + 30 * 60;

/**
 * One flush answer, read as Mend uses it. `pending` counts every capture staged and not yet
 * registered — bulk included on today's sealantd. The fields sealantd does not report yet are null
 * until it does: `pendingBytes` (what is left to upload), `pendingBulk` (how many of `pending` are
 * bulk) and `refused` (captures the byte quota refused).
 */
export interface CaptureReading {
  readonly pending: number;
  readonly pendingBytes: number | null;
  readonly pendingBulk: number | null;
  readonly refused: number | null;
  /** Highest registered chain position, when any. */
  readonly headN: number | null;
  /** Lifetime counters: any growth is movement. */
  readonly registered: number;
  readonly uploadedBytes: number;
  /** Another executor holds the worktree: nothing this one holds will be accepted. */
  readonly fenced: boolean;
  readonly paused: boolean;
  /** Bulk changed since its last snapshot; null until sealantd reports it. */
  readonly bulkDirty: boolean | null;
}

/** Everything registered, nothing refused, nobody fenced: the compute may go. */
export const captureSaved = (reading: CaptureReading): boolean =>
  reading.pending === 0 && !reading.fenced && (reading.refused ?? 0) === 0;

/**
 * Whether a harvest or a handoff may read the chain head: the small captures are in. Once
 * sealantd reports `pendingBulk`, bulk still uploading no longer holds a handoff up; until then
 * every pending capture does. A stop still waits for all of them (`captureSaved`).
 */
export const captureHarvestReady = (reading: CaptureReading): boolean => {
  if (reading.fenced) return false;
  const small =
    reading.pendingBulk === null ? reading.pending : reading.pending - reading.pendingBulk;
  return small <= 0;
};

/** Whether `next` is closer to saved than `previous`: fewer pending, fewer bytes, more shipped. */
export const captureProgressed = (
  previous: CaptureReading | null,
  next: CaptureReading,
): boolean => {
  if (previous === null) return false;
  if (next.pending < previous.pending) return true;
  if (
    next.pendingBytes !== null &&
    previous.pendingBytes !== null &&
    next.pendingBytes < previous.pendingBytes
  ) {
    return true;
  }
  if ((next.headN ?? -1) > (previous.headN ?? -1)) return true;
  return next.registered > previous.registered || next.uploadedBytes > previous.uploadedBytes;
};

/**
 * One step of a drain, from the latest reading:
 * - `saved`: nothing pending; terminate.
 * - `saving`: something moved within the stall window, or the window has not run out.
 * - `not-saved`: no movement for the whole window, or nothing can move (fenced, refused).
 *   The workspace is kept.
 */
export type CaptureDrainStep =
  | { readonly kind: "saved" }
  | { readonly kind: "saving"; readonly progressAtMs: number }
  | { readonly kind: "not-saved"; readonly progressAtMs: number };

export const captureDrainStep = (input: {
  readonly previous: CaptureReading | null;
  /** Null when the executor did not answer this time (no movement observed). */
  readonly reading: CaptureReading | null;
  readonly progressAtMs: number;
  readonly nowMs: number;
  readonly stallSeconds: number;
}): CaptureDrainStep => {
  const { reading } = input;
  if (reading !== null && captureSaved(reading)) return { kind: "saved" };
  const moved = reading !== null && captureProgressed(input.previous, reading);
  const progressAtMs = moved ? input.nowMs : input.progressAtMs;
  // A fenced executor's captures are never accepted, and a refusal does not lift on its own:
  // waiting out the window changes nothing.
  if (reading !== null && (reading.fenced || (reading.refused ?? 0) > 0)) {
    return { kind: "not-saved", progressAtMs };
  }
  if (input.nowMs - progressAtMs >= input.stallSeconds * 1000) {
    return { kind: "not-saved", progressAtMs };
  }
  return { kind: "saving", progressAtMs };
};

/** What a session's status line reads of its captures. */
export interface SessionCaptureFacts {
  readonly capturePending: number | null;
  readonly capturePendingBytes: number | null;
  readonly captureRefused: number | null;
  readonly captureDrain: CaptureDrainReason | null;
  /** A Date on the server; the encoded string on clients that read the wire as it is. */
  readonly captureNotSavedAt: Date | string | null;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** `812 B`, `4.2 MB`, `31 GB`: one decimal below ten, none above. */
export const captureBytesWords = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
};

/** What is left: bytes once sealantd reports them, the capture count until then. */
const leftWords = (facts: SessionCaptureFacts): string | null => {
  if (facts.capturePendingBytes !== null) return captureBytesWords(facts.capturePendingBytes);
  if (facts.capturePending !== null) return `${facts.capturePending}`;
  return null;
};

/**
 * The capture line every surface shows beside a session (web, CLI, phone, Slack):
 * - `saving · 3 left` (`saving · 12 MB left` once sealantd reports bytes) while a drain runs;
 * - `not saved · 3 pending · workspace kept` once a drain stalled, or cannot move;
 * - `not saved · 2 refused` when the byte quota refused captures and nothing is draining.
 * Null when there is nothing to say.
 */
export const captureStatusLine = (facts: SessionCaptureFacts): string | null => {
  const left = leftWords(facts);
  if (facts.captureDrain !== null) {
    if (facts.captureNotSavedAt !== null) {
      return left === null
        ? "not saved · workspace kept"
        : `not saved · ${left} pending · workspace kept`;
    }
    return left === null ? "saving" : `saving · ${left} left`;
  }
  if ((facts.captureRefused ?? 0) > 0) return `not saved · ${facts.captureRefused} refused`;
  return null;
};

/**
 * When to start saving ahead of the platform's cap on one executor. The deadline comes from the
 * platform once the SDK reports it; until then from MEND_EXECUTOR_MAX_SECONDS counted from the
 * executor's own start; failing both, the fallback replacement age. The drain starts
 * `drainEstimateSeconds + marginSeconds` before the deadline, and a bytes-based estimate
 * (`pendingBytes / bytesPerSecond`) wins over the configured one when it is larger.
 */
export type ExecutorCapPlan =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "planned";
      readonly source: "platform" | "config" | "fallback";
      /** The platform's cutoff, when known; null under the fallback age. */
      readonly deadline: Date | null;
      readonly drainAt: Date;
    };

export const planExecutorCap = (input: {
  readonly executorStartedAt: Date | null;
  /** The platform's deadline for this executor (SDK), once it reports one. */
  readonly platformDeadline: Date | null;
  /** MEND_EXECUTOR_MAX_SECONDS; null = the operator did not say. */
  readonly maxSeconds: number | null;
  readonly drainEstimateSeconds: number;
  readonly marginSeconds: number;
  readonly fallbackAgeSeconds: number;
  readonly pendingBytes?: number | null;
  readonly bytesPerSecond?: number | null;
}): ExecutorCapPlan => {
  const measured =
    input.pendingBytes !== undefined &&
    input.pendingBytes !== null &&
    input.bytesPerSecond !== undefined &&
    input.bytesPerSecond !== null &&
    input.bytesPerSecond > 0
      ? input.pendingBytes / input.bytesPerSecond
      : 0;
  const leadMs = (Math.max(input.drainEstimateSeconds, measured) + input.marginSeconds) * 1000;
  if (input.platformDeadline !== null) {
    return {
      kind: "planned",
      source: "platform",
      deadline: input.platformDeadline,
      drainAt: new Date(input.platformDeadline.getTime() - leadMs),
    };
  }
  if (input.executorStartedAt === null) return { kind: "unknown" };
  const startedMs = input.executorStartedAt.getTime();
  if (input.maxSeconds !== null && input.maxSeconds > 0) {
    const deadline = new Date(startedMs + input.maxSeconds * 1000);
    return {
      kind: "planned",
      source: "config",
      deadline,
      drainAt: new Date(Math.max(startedMs, deadline.getTime() - leadMs)),
    };
  }
  return {
    kind: "planned",
    source: "fallback",
    deadline: null,
    drainAt: new Date(startedMs + input.fallbackAgeSeconds * 1000),
  };
};

/** Whether the planned drain is due at `nowMs`. */
export const executorCapDue = (plan: ExecutorCapPlan, nowMs: number): boolean =>
  plan.kind === "planned" && nowMs >= plan.drainAt.getTime();
