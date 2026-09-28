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
 * bulk), `refused` (captures the byte quota refused) and `complete`.
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
  /**
   * The executor's own word on a final flush (the `capture.flush` FINAL kind): true only when it
   * stopped admitting processes, ended every managed process, snapshotted the small and the bulk
   * class after that, and registered everything. False: it tried and something failed. Null: the
   * answer did not say — an older sealantd, an SDK that cannot ask for the final kind, or a
   * suspend flush. Only `true` is saved; `pending == 0` alone is not.
   */
  readonly complete: boolean | null;
  /**
   * Why a final flush did not complete, in sealantd's words (`CaptureIncompleteReason`), when it
   * says; null otherwise.
   */
  readonly incompleteReason: string | null;
  /**
   * A snap that is failing, as sealantd reports it (`last_snap_error`, `snap_failing_since`,
   * `snaps_failed`): its last error, since when the class's snaps have failed, and how many
   * have. Null (and 0 paths) until sealantd reports them, and while every class's last snap
   * succeeded.
   */
  readonly snapError: string | null;
  readonly snapFailingSince: Date | null;
  readonly snapsFailed: number | null;
  /** Paths the last snap could not read (`unreadable`), and the first of them sealantd names. */
  readonly unreadable: number | null;
  readonly unreadablePaths: ReadonlyArray<string>;
}

/**
 * sealantd's reasons for an incomplete final flush. `not-final`: the executor did not run a final
 * flush (an older daemon answers every flush this way); the rest name the step that failed.
 */
export const CAPTURE_INCOMPLETE_REASONS = [
  "not-final",
  "in-progress",
  "processes-remain",
  "sweep-unavailable",
  "snapshot-failed",
  "unreadable",
  "fenced",
  "conflict",
  "deadline",
  "ship-failed",
  "pending",
  "internal",
] as const;

/** What Mend records when a final flush's answer carries no `complete` at all. */
export const CAPTURE_COMPLETION_UNREPORTED = "unreported";

/**
 * The reason a final flush's answer leaves on the session: null when it completed; sealantd's own
 * reason when it gave one; `not-final` for an incomplete answer with none (an older daemon);
 * `unreported` when the answer did not say whether it completed.
 */
export const captureIncompleteReasonOf = (reading: CaptureReading): string | null => {
  if (reading.complete === true) return null;
  if (reading.complete === null) return CAPTURE_COMPLETION_UNREPORTED;
  return reading.incompleteReason ?? "not-final";
};

/**
 * The executor said its final flush completed, and nothing is pending, refused or fenced: the
 * compute may go. Nothing else is proof — an empty queue says nothing of bytes written after the
 * last snapshot, or of bulk that was never queued.
 */
export const captureSaved = (reading: CaptureReading): boolean =>
  reading.complete === true &&
  reading.pending === 0 &&
  !reading.fenced &&
  (reading.refused ?? 0) === 0;

/**
 * A snap is failing on the executor: sealantd said why (`last_snap_error`), since when, or that
 * the last snap met paths it could not read. A final flush over such a tree fails again however
 * long a drain waits; only the next retry (after the kept backoff) may find it fixed.
 */
export const captureSnapFailing = (reading: CaptureReading): boolean =>
  reading.snapError !== null || reading.snapFailingSince !== null;

/**
 * An answer that can never become `complete`, however long the drain waits: the executor did not
 * run a final flush (`complete` absent, `not-final`, or incomplete with no reason — an older
 * daemon), it was fenced or conflicted, it cannot vouch that every writer stopped
 * (`sweep-unavailable`), or its final snapshot failed (`snapshot-failed`, `unreadable`, or any
 * answer that reports a failing snap). A drain reads `not saved` at once and
 * keeps the workspace; the kept backoff (10 s doubling to 5 min) asks again.
 */
const finalFlushCannotComplete = (reading: CaptureReading): boolean => {
  const reason = captureIncompleteReasonOf(reading);
  return (
    reason === CAPTURE_COMPLETION_UNREPORTED ||
    reason === "not-final" ||
    reason === "fenced" ||
    reason === "conflict" ||
    reason === "sweep-unavailable" ||
    reason === "snapshot-failed" ||
    reason === "unreadable" ||
    (reading.complete !== true && captureSnapFailing(reading))
  );
};

/** Longest error Mend keeps from sealantd for a status line. */
const DETAIL_MAX = 200;

const clipped = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= DETAIL_MAX ? flat : `${flat.slice(0, DETAIL_MAX - 1)}…`;
};

/**
 * What sealantd said about a failing snap, as one clause: its error, then the first path it
 * could not read (`unreadable tree/secrets.pem +2 more`). Null when it said nothing.
 */
export const captureSnapDetailOf = (reading: CaptureReading): string | null => {
  const parts: Array<string> = [];
  if (reading.snapError !== null && reading.snapError.trim() !== "") {
    parts.push(clipped(reading.snapError));
  }
  const count = Math.max(reading.unreadable ?? 0, reading.unreadablePaths.length);
  const first = reading.unreadablePaths[0];
  if (count > 0) {
    parts.push(
      first === undefined
        ? `${count} unreadable`
        : `unreadable ${clipped(first)}${count > 1 ? ` +${count - 1} more` : ""}`,
    );
  }
  return parts.length === 0 ? null : parts.join(" · ");
};

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
 * - `saved`: the final flush completed and nothing is pending (`captureSaved`); terminate.
 * - `saving`: something moved within the stall window, or the window has not run out.
 * - `not-saved`: no movement for the whole window, or nothing can move (fenced, refused, or an
 *   executor that cannot complete a final flush: `finalFlushCannotComplete`). The workspace is
 *   kept.
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
  if (
    reading !== null &&
    (reading.fenced || (reading.refused ?? 0) > 0 || finalFlushCannotComplete(reading))
  ) {
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
  /** Why the last final flush did not complete (`captureIncompleteReasonOf`); absent reads none. */
  readonly captureIncompleteReason?: string | null;
  /** sealantd's error or unreadable path behind it (`captureSnapDetailOf`); absent reads none. */
  readonly captureIncompleteDetail?: string | null;
  /**
   * A running executor whose snaps are failing (`captureSnapFailing`): since when, and sealantd's
   * error. Absent or null: none observed.
   */
  readonly captureFailingSince?: Date | string | null;
  readonly captureFailingError?: string | null;
  /** The owner discarded what the executor had not saved: when, and who. */
  readonly captureDiscardedAt?: Date | string | null;
  readonly captureDiscardedBy?: string | null;
}

/** An incomplete final flush's reason, as the status line words it; null says nothing more. */
export const captureIncompleteWords = (reason: string | null | undefined): string | null => {
  switch (reason) {
    case undefined:
    case null:
    case "pending":
    case "in-progress":
      return null;
    case CAPTURE_COMPLETION_UNREPORTED:
      return "final flush not reported";
    case "not-final":
      return "final flush not supported";
    case "processes-remain":
      return "processes remain";
    case "sweep-unavailable":
      return "process sweep unavailable";
    case "snapshot-failed":
      return "snapshot failed";
    case "unreadable":
      return "unreadable paths";
    case "fenced":
      return "fenced";
    case "conflict":
      return "conflict";
    case "deadline":
      return "deadline passed";
    case "ship-failed":
      return "upload failed";
    case "internal":
      return "executor error";
    default:
      return reason;
  }
};

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

/** `16:29:51 UTC`: the time of day every capture line names. */
const utcTime = (at: Date): string => `${at.toISOString().slice(11, 19)} UTC`;

/** A time the wire may carry encoded; null when absent or unreadable. */
const timeOf = (at: Date | string | null | undefined): Date | null => {
  if (at === null || at === undefined) return null;
  const date = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The capture line every surface shows beside a session (web, CLI, phone, Slack):
 * - `saving · 3 left` (`saving · 12 MB left` once sealantd reports bytes) while a drain runs;
 * - `not saved · 3 pending · workspace kept` once a drain stalled, or cannot move, with the
 *   executor's reason when its final flush said why and what sealantd named behind it (`not
 *   saved · snapshot failed · EACCES: tree/secrets.pem · 3 pending · workspace kept`);
 * - `capture failing since 16:29:51 UTC · <error>` while a running executor's snaps fail;
 * - `not saved · 2 refused` when the byte quota refused captures and nothing is draining;
 * - `unsaved work discarded by Ada at 16:40:02 UTC` once the owner discarded it.
 * Null when there is nothing to say.
 */
export const captureStatusLine = (facts: SessionCaptureFacts): string | null => {
  const left = leftWords(facts);
  if (facts.captureDrain !== null) {
    if (facts.captureNotSavedAt !== null) {
      const why = captureIncompleteWords(facts.captureIncompleteReason);
      const detail = facts.captureIncompleteDetail ?? null;
      return [
        "not saved",
        ...(why === null ? [] : [why]),
        ...(detail === null || detail === "" ? [] : [detail]),
        ...(left === null ? [] : [`${left} pending`]),
        "workspace kept",
      ].join(" · ");
    }
    return left === null ? "saving" : `saving · ${left} left`;
  }
  const failingSince = timeOf(facts.captureFailingSince);
  if (failingSince !== null) {
    const error = facts.captureFailingError ?? null;
    return [
      `capture failing since ${utcTime(failingSince)}`,
      ...(error === null || error === "" ? [] : [error]),
    ].join(" · ");
  }
  if ((facts.captureRefused ?? 0) > 0) return `not saved · ${facts.captureRefused} refused`;
  const discardedAt = timeOf(facts.captureDiscardedAt);
  if (discardedAt !== null) {
    const by = facts.captureDiscardedBy ?? null;
    return `unsaved work discarded${by === null || by === "" ? "" : ` by ${by}`} at ${utcTime(discardedAt)}`;
  }
  return null;
};

/**
 * What Mend knows when an executor ended without Mend asking (a `docker stop`, a SIGKILL, a lost
 * machine) and the platform confirmed it gone.
 */
export interface ExecutorEndFacts {
  /**
   * The chain head as registered when the end was observed: its capture kind, its registration
   * time, and whether its bulk section was still `pending`. Null when nothing ever registered.
   */
  readonly head: {
    readonly kind: string;
    readonly registeredAt: Date;
    readonly bulkPending: boolean;
  } | null;
  /** When this executor started; null when not recorded. */
  readonly executorStartedAt: Date | null;
  /** Mend's last reading of the executor's queue (a flush answer) and when it was taken. */
  readonly reading: {
    readonly pending: number | null;
    readonly pendingBytes: number | null;
    readonly observedAt: Date | null;
  };
  /**
   * This executor's own word that its final flush completed (`captureSaved`: `complete: true`,
   * nothing pending), when Mend observed it, and the chain position it named. Null or absent:
   * Mend never observed one.
   */
  readonly finalSaved?: { readonly at: Date; readonly n: number | null } | null;
}

/**
 * How such an end reads:
 * - `saved`: Mend observed this executor answer `complete: true` with nothing pending — it had
 *   stopped every writer, snapshotted both classes and registered them, and it admits nothing
 *   after that, so captures registered on top of it (a later suspend flush) change nothing; or,
 *   with no such answer observed, the executor's own final flush registered last — sealantd
 *   takes a final capture only after it has stopped admitting processes and ended the running
 *   ones — this executor took it, its bulk section is not pending, and nothing Mend read after it
 *   was pending;
 * - `lost`: anything else. `lastSavedAt` is the head's registration; `pending` is Mend's last
 *   reading of the queue, only when it was taken by this executor after that registration and
 *   saw something pending. Mend never counts what it did not observe.
 */
export type ExecutorEnd =
  | { readonly kind: "saved"; readonly savedAt: Date; readonly n?: number | null }
  | {
      readonly kind: "lost";
      readonly lastSavedAt: Date | null;
      readonly pending: { readonly words: string; readonly observedAt: Date } | null;
    };

export const executorEndOf = (facts: ExecutorEndFacts): ExecutorEnd => {
  const { head, reading, executorStartedAt } = facts;
  const byThisExecutor = (at: Date) =>
    executorStartedAt === null || at.getTime() >= executorStartedAt.getTime();
  const pendingAfter = (at: Date | null) =>
    reading.observedAt !== null &&
    reading.pending !== null &&
    reading.pending > 0 &&
    byThisExecutor(reading.observedAt) &&
    (at === null || reading.observedAt.getTime() > at.getTime());
  const finalSaved = facts.finalSaved ?? null;
  if (finalSaved !== null && byThisExecutor(finalSaved.at)) {
    return { kind: "saved", savedAt: finalSaved.at, n: finalSaved.n };
  }
  if (
    head !== null &&
    head.kind === "final" &&
    !head.bulkPending &&
    byThisExecutor(head.registeredAt) &&
    !pendingAfter(head.registeredAt)
  ) {
    return { kind: "saved", savedAt: head.registeredAt };
  }
  const lastSavedAt = head?.registeredAt ?? null;
  const pending =
    reading.observedAt !== null && reading.pending !== null && pendingAfter(lastSavedAt)
      ? {
          words:
            reading.pendingBytes !== null
              ? captureBytesWords(reading.pendingBytes)
              : `${reading.pending}`,
          observedAt: reading.observedAt,
        }
      : null;
  return { kind: "lost", lastSavedAt, pending };
};

/**
 * `stopped outside Mend · saved at 16:29:51 UTC` (`· capture 21` when the executor named its
 * chain position), or `executor lost · last saved 16:32:06 UTC ·
 * changes after that were not saved · 3 pending at 16:32:00 UTC` (the last part only when Mend
 * read the queue after that save). Every "executor lost" line starts with `executor lost`.
 */
export const executorEndWords = (end: ExecutorEnd): string => {
  if (end.kind === "saved") {
    const n = end.n ?? null;
    return `stopped outside Mend · saved at ${utcTime(end.savedAt)}${n === null ? "" : ` · capture ${n}`}`;
  }
  const saved =
    end.lastSavedAt === null
      ? ["nothing saved"]
      : [`last saved ${utcTime(end.lastSavedAt)}`, "changes after that were not saved"];
  const pending =
    end.pending === null
      ? []
      : [`${end.pending.words} pending at ${utcTime(end.pending.observedAt)}`];
  return ["executor lost", ...saved, ...pending].join(" · ");
};

/**
 * What one executor was observed to ship, as rates (`observeCaptureThroughput`): bytes uploaded
 * and captures registered per second, smoothed over the samples seen. Null rates until two samples
 * a known interval apart moved something.
 */
export interface CaptureThroughput {
  readonly atMs: number;
  /** Lifetime counters at `atMs`. */
  readonly uploadedBytes: number;
  readonly registered: number;
  readonly bytesPerSecond: number | null;
  readonly objectsPerSecond: number | null;
}

/** Weight of the newest interval in the smoothed rate. */
const THROUGHPUT_WEIGHT = 0.3;
/** Samples closer than this say nothing reliable about a rate. */
const THROUGHPUT_MIN_INTERVAL_MS = 1000;

const smoothed = (previous: number | null, sample: number): number =>
  previous === null ? sample : previous + THROUGHPUT_WEIGHT * (sample - previous);

/**
 * Fold one observation of an executor's lifetime counters into its throughput. An interval in
 * which nothing moved says nothing about the rate (the executor may simply have had nothing to
 * ship), so it leaves the rates as they were; counters that went backwards (a new executor) start
 * over.
 */
export const observeCaptureThroughput = (
  previous: CaptureThroughput | null,
  sample: { readonly atMs: number; readonly uploadedBytes: number; readonly registered: number },
): CaptureThroughput => {
  const fresh: CaptureThroughput = {
    atMs: sample.atMs,
    uploadedBytes: sample.uploadedBytes,
    registered: sample.registered,
    bytesPerSecond: previous?.bytesPerSecond ?? null,
    objectsPerSecond: previous?.objectsPerSecond ?? null,
  };
  if (previous === null) return fresh;
  if (sample.uploadedBytes < previous.uploadedBytes || sample.registered < previous.registered) {
    return { ...fresh, bytesPerSecond: null, objectsPerSecond: null };
  }
  const intervalMs = sample.atMs - previous.atMs;
  if (intervalMs < THROUGHPUT_MIN_INTERVAL_MS) return previous;
  const seconds = intervalMs / 1000;
  const bytes = sample.uploadedBytes - previous.uploadedBytes;
  const objects = sample.registered - previous.registered;
  return {
    ...fresh,
    bytesPerSecond:
      bytes > 0 ? smoothed(previous.bytesPerSecond, bytes / seconds) : previous.bytesPerSecond,
    objectsPerSecond:
      objects > 0
        ? smoothed(previous.objectsPerSecond, objects / seconds)
        : previous.objectsPerSecond,
  };
};

/**
 * When to start saving ahead of the platform's cap on one executor. The deadline comes from the
 * platform once the SDK reports it; until then from MEND_EXECUTOR_MAX_SECONDS counted from the
 * executor's own start; failing both, the fallback replacement age. The drain starts
 * `drainEstimateSeconds + marginSeconds` before the deadline, and an estimate from what is pending
 * at the observed throughput (`pendingBytes / bytesPerSecond`, `pendingObjects /
 * objectsPerSecond`) wins over the configured one when it is larger.
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

/** How long `amount` takes at `rate` per second; 0 when either is unknown. */
const secondsAt = (amount: number | null | undefined, rate: number | null | undefined): number =>
  amount !== undefined && amount !== null && rate !== undefined && rate !== null && rate > 0
    ? amount / rate
    : 0;

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
  /** Captures staged and not registered. */
  readonly pendingObjects?: number | null;
  readonly objectsPerSecond?: number | null;
}): ExecutorCapPlan => {
  const measured = Math.max(
    secondsAt(input.pendingBytes, input.bytesPerSecond),
    secondsAt(input.pendingObjects, input.objectsPerSecond),
  );
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
  // The fallback age already leaves the configured lead before an assumed cap; what is pending
  // at the observed throughput moves it earlier by whatever that needs beyond the estimate.
  const beyondEstimateMs = Math.max(0, measured - input.drainEstimateSeconds) * 1000;
  return {
    kind: "planned",
    source: "fallback",
    deadline: null,
    drainAt: new Date(
      Math.max(startedMs, startedMs + input.fallbackAgeSeconds * 1000 - beyondEstimateMs),
    ),
  };
};

/** Whether the planned drain is due at `nowMs`. */
export const executorCapDue = (plan: ExecutorCapPlan, nowMs: number): boolean =>
  plan.kind === "planned" && nowMs >= plan.drainAt.getTime();

/**
 * What Mend knew when the owner asked to discard what an executor had not saved, taken at the
 * moment of asking: the last registered capture, this executor's completed final flush if Mend
 * observed one, snaps failing (since when, sealantd's error), and the executor's queue as Mend
 * last read it. Never a count Mend did not observe.
 */
export interface CaptureDiscardFacts {
  readonly requestedAt: Date;
  readonly workspaceId: string | null;
  /** The chain head when the discard was asked: its position and registration. */
  readonly lastSaved: { readonly n: number; readonly at: Date } | null;
  /** This executor answered `complete: true` (`captureSaved`), when observed. */
  readonly finalCompleted: { readonly n: number | null; readonly at: Date } | null;
  /** Snaps failing on the executor: since when, and sealantd's last error. */
  readonly failingSince: Date | null;
  readonly failingError: string | null;
  /** The executor's queue as last read, and when; null when never read. */
  readonly queue: {
    readonly pending: number;
    readonly pendingBytes: number | null;
    readonly observedAt: Date;
  } | null;
}

/**
 * The queue reading that says what was pending: taken after the last save, and while snaps were
 * not failing — a failing snap stages nothing, so an empty queue then counts nothing.
 */
const discardPendingOf = (facts: CaptureDiscardFacts) => {
  const { queue } = facts;
  if (queue === null || facts.failingSince !== null) return null;
  if (facts.lastSaved !== null && queue.observedAt.getTime() <= facts.lastSaved.at.getTime()) {
    return null;
  }
  return queue;
};

/**
 * One line of what was discarded: `asked at 19:57:10 UTC · last saved capture 37 at 19:54:41 UTC
 * · unsaved since 19:55:02 UTC (snaps failing · EACCES: …) · no final flush completed`.
 */
export const captureDiscardWords = (facts: CaptureDiscardFacts): string => {
  const pending = discardPendingOf(facts);
  const parts = [
    `asked at ${utcTime(facts.requestedAt)}`,
    facts.lastSaved === null
      ? "nothing saved"
      : `last saved capture ${facts.lastSaved.n} at ${utcTime(facts.lastSaved.at)}`,
  ];
  if (facts.failingSince !== null) {
    const error = facts.failingError === null ? "" : ` · ${clipped(facts.failingError)}`;
    parts.push(`unsaved since ${utcTime(facts.failingSince)} (snaps failing${error})`);
  } else if (pending !== null && pending.pending > 0) {
    const left =
      pending.pendingBytes === null
        ? `${pending.pending}`
        : captureBytesWords(pending.pendingBytes);
    parts.push(`${left} pending at ${utcTime(pending.observedAt)}`);
  }
  parts.push(
    facts.finalCompleted === null
      ? "no final flush completed"
      : `final flush completed at ${utcTime(facts.finalCompleted.at)}${
          facts.finalCompleted.n === null ? "" : ` · capture ${facts.finalCompleted.n}`
        }`,
  );
  return parts.join(" · ");
};

const isoOrNull = (at: Date | null | undefined): string | null =>
  at === null || at === undefined ? null : at.toISOString();

/**
 * The audit record of a discard (`session.unsaved_discarded`): when it was asked and when the
 * workspace's end was observed, the last save, whether a final flush ever completed, snaps
 * failing, and what was pending only when Mend read it after the last save with snaps working
 * (`pending` null otherwise); the queue as last read stays beside it as `queue*`.
 */
export const captureDiscardAuditData = (
  facts: CaptureDiscardFacts,
  discardedAt: Date,
): Record<string, string | number | boolean | null> => {
  const pending = discardPendingOf(facts);
  return {
    requestedAt: facts.requestedAt.toISOString(),
    discardedAt: discardedAt.toISOString(),
    workspaceId: facts.workspaceId,
    lastSavedN: facts.lastSaved?.n ?? null,
    lastSavedAt: isoOrNull(facts.lastSaved?.at),
    finalCompleted: facts.finalCompleted !== null,
    finalCompletedN: facts.finalCompleted?.n ?? null,
    finalCompletedAt: isoOrNull(facts.finalCompleted?.at),
    snapsFailingSince: isoOrNull(facts.failingSince),
    lastError: facts.failingError,
    pending: pending?.pending ?? null,
    pendingBytes: pending?.pendingBytes ?? null,
    queuePending: facts.queue?.pending ?? null,
    queuePendingBytes: facts.queue?.pendingBytes ?? null,
    queueObservedAt: isoOrNull(facts.queue?.observedAt),
    words: captureDiscardWords(facts),
  };
};
