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
  /** The lease epoch the answering executor ships under; absent or null when not read. */
  readonly epoch?: number | null;
  /**
   * Each class's snaps as sealantd reports them (`snaps`): whether its last snap failed. Absent
   * or null from a daemon that reports only the summed fields above.
   */
  readonly snaps?: ReadonlyArray<CaptureClassSnaps> | null;
  /** The classes the byte quota refused, when the answer names them; null otherwise. */
  readonly refusedClasses?: ReadonlyArray<CaptureClass> | null;
  /** A refused register is being rebuilt from disk: nothing behind it registers first. */
  readonly repairing?: boolean | null;
  /**
   * A capture step still running past its bound (`CaptureStatusReport.overdue`, sealantd e2e8):
   * the innermost such step. Not a failure — the step may still end — but nothing it would have
   * captured is saved while it runs, however empty the queue reads. Absent or null: none
   * reported (an older daemon, a Core that does not forward it, or nothing overdue).
   */
  readonly overdue?: CaptureOverdue | null;
  /**
   * Where in its own history the executor made this answer (`CapturePosition`, cross-repo
   * decision 17): what orders it against the executor's other answers and its seal. Absent or
   * null when the answer carried no epoch.
   */
  readonly position?: CapturePosition | null;
}

/**
 * A capture step past its bound, as sealantd reports it (`CaptureOverdue`, status report field
 * 31): what it is (`small snap › git cat-file --batch-check`), when it started, how long it had
 * run when the answer was made, and the bound it passed (a git is reported at 120 s and killed at
 * 900 s, a snap reported at 600 s).
 */
export interface CaptureOverdue {
  readonly step: string;
  readonly startedAt: Date | null;
  readonly runningMs: number;
  readonly boundMs: number | null;
}

/**
 * Where in its own history an executor made an answer, or sealed (cross-repo decision 17, review
 * 2026-09-28 (6) #6), as sealantd stamps it (`CaptureStatusReport` fields 27–30, `final_seal`):
 * the lease epoch it held, the launch it runs as (`launch`), the daemon process that answered
 * (`boot_id`), which of the processes that opened this disk's staging that was
 * (`boot_generation`, 0 when it could not persist it), and the number the answer or seal took
 * (`observation`, strictly increasing within one boot over every answer and every seal). Evidence
 * is ordered by this and never by the wall clocks of whoever read it: a seal stamped by the
 * store's clock and an answer stamped by a session worker's say nothing about which came first.
 * Fields the executor did not report are null.
 */
export interface CapturePosition {
  readonly epoch: number | null;
  readonly launchId: string | null;
  readonly bootId: string | null;
  readonly bootGeneration: number | null;
  readonly observation: number | null;
  /** The executor's head (an answer's `headN`, a seal's `n`): for display, never an order. */
  readonly headN: number | null;
}

/**
 * `a` relative to `b`, by sealantd's rule (its README, decision 17):
 * - the same epoch, launch and boot: by `observation` (the same number is the same answer; two
 *   heads under one number are contradictory: incomparable);
 * - the same epoch and launch, two boots with generations above 0 that differ: by
 *   `(boot_generation, observation)` — a recovery boot of the same disk counts up;
 * - anything else — a field absent, a generation of 0, one generation under two boots, another
 *   epoch or launch — is incomparable, and incomparable evidence fails closed.
 */
export type CaptureOrder = "before" | "same" | "after" | "incomparable";

export const captureOrderOf = (
  a: CapturePosition | null | undefined,
  b: CapturePosition | null | undefined,
): CaptureOrder => {
  if (a === null || a === undefined || b === null || b === undefined) return "incomparable";
  if (a.epoch === null || a.epoch !== b.epoch) return "incomparable";
  if (a.launchId === null || a.launchId !== b.launchId) return "incomparable";
  if (a.bootId === null || b.bootId === null) return "incomparable";
  if (a.observation === null || b.observation === null) return "incomparable";
  if (a.bootId === b.bootId) {
    if (a.observation !== b.observation) return a.observation < b.observation ? "before" : "after";
    return a.headN !== null && b.headN !== null && a.headN !== b.headN ? "incomparable" : "same";
  }
  const genA = a.bootGeneration ?? 0;
  const genB = b.bootGeneration ?? 0;
  if (genA === 0 || genB === 0 || genA === genB) return "incomparable";
  return genA < genB ? "before" : "after";
};

/**
 * Whether an answer at `incoming` replaces the one of its kind kept at `stored` (an executor's
 * latest completed final flush): unless the executor made it strictly before the kept one. An
 * answer nothing orders against the kept one replaces it. Unsaved answers are never replaced this
 * way: see `withUnsavedAnswer`.
 */
export const captureAnswerReplaces = (
  incoming: CapturePosition | null | undefined,
  stored: CapturePosition | null | undefined,
): boolean => captureOrderOf(incoming, stored) !== "before";

/** Whether anything can be ordered against `position`: every field the order reads is known. */
const capturePositionOrderable = (position: CapturePosition | null | undefined): boolean =>
  position !== null &&
  position !== undefined &&
  position.epoch !== null &&
  position.launchId !== null &&
  position.bootId !== null &&
  position.observation !== null;

/**
 * The most unsaved answers an executor's evidence keeps apart. Past it they are folded into one
 * answer nothing orders (`withUnsavedAnswer`), which no save ever covers: fail closed.
 */
export const CAPTURE_UNSAVED_ANSWERS_KEPT = 64;

/**
 * The unsaved answers an executor's evidence keeps once `incoming` is added (cross-repo decision
 * 25, review 2026-09-28 (9) #4): every answer no other kept answer was made strictly after, in
 * the executor's own order (`captureOrderOf`) — an antichain. A save stands only over all of them
 * (`saveCoversUnsaved`, each); an answer merely incomparable with a kept one never erases it,
 * however late it arrives.
 * - `incoming` made strictly before a kept answer adds nothing: a save that covers the later one
 *   covers it too;
 * - a kept answer made strictly before `incoming`, or the same answer, gives way to it;
 * - answers nothing can be ordered against (a field of their position unknown) are covered by no
 *   save and dominated by no answer: one of them stands for all, the latest received.
 * Past `CAPTURE_UNSAVED_ANSWERS_KEPT`, everything is folded into `incoming` with no position,
 * which no save covers. The latest received is last.
 */
export const withUnsavedAnswer = <
  T extends { readonly words: string; readonly position?: CapturePosition | null },
>(
  kept: ReadonlyArray<T>,
  incoming: T,
): ReadonlyArray<T> => {
  if (kept.some((answer) => captureOrderOf(incoming.position, answer.position) === "before")) {
    return kept;
  }
  const unorderable = !capturePositionOrderable(incoming.position);
  const standing = kept.filter((answer) => {
    const order = captureOrderOf(answer.position, incoming.position);
    if (order === "before" || order === "same") return false;
    return !(unorderable && !capturePositionOrderable(answer.position));
  });
  if (standing.length + 1 <= CAPTURE_UNSAVED_ANSWERS_KEPT) return [...standing, incoming];
  return [
    {
      ...incoming,
      words: `${incoming.words} · ${standing.length + 1} unsaved answers kept as one`,
      position: null,
    },
  ];
};

/**
 * Whether a save (a completed final flush, a seal) at `save` stands over an answer at `unsaved`
 * that said the executor held unsaved work: only when that answer was made strictly before it
 * (cross-repo decisions 10 and 17). An answer after it, at the same head, or one nothing orders
 * against it revokes it — contradictory or incomparable evidence fails closed.
 */
export const saveCoversUnsaved = (
  save: CapturePosition | null | undefined,
  unsaved: CapturePosition | null | undefined,
): boolean => captureOrderOf(unsaved, save) === "before";

/** sealantd's capture classes: `small` (the worktree, `.git`, the harness home) and `bulk`. */
export type CaptureClass = "small" | "bulk";

/** One class's snaps: whether its last snap failed (an error or a failing-since time). */
export interface CaptureClassSnaps {
  readonly class: CaptureClass;
  readonly failing: boolean;
}

/**
 * sealantd's reasons for an incomplete final flush. `not-final`: the executor did not run a final
 * flush (an older daemon answers every flush this way); `sealing`: everything registered but the
 * capture that seals the completed flush on the chain (`final_seal`; the flush returned at its
 * deadline first) — the final flush asked again stages it, so a drain keeps asking; `changed`:
 * the flush completed but the disk changed after it (a change the watcher saw, or its overflow;
 * cross-repo decision 7) — nothing is saved until a final flush asked again completes, so a drain
 * keeps asking; `store-fidelity`: the store's `plan.get` answer did not list every manifest
 * feature this executor writes, so it cannot keep what was captured byte for byte (cross-repo
 * decision 12) — no wait fixes it, so a drain reads `not saved` at once and keeps the workspace;
 * the rest name the step that failed.
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
  "sealing",
  "changed",
  "unwatched",
  "store-fidelity",
  "internal",
] as const;

/**
 * What Mend records when the platform keeps an executor for recovery (Core's `drain.retained`):
 * its disk holds work the platform cannot confirm saved.
 */
export const CAPTURE_EXECUTOR_RETAINED = "retained";

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
  (reading.refused ?? 0) === 0 &&
  // A capture step still running past its bound (e2e8): whatever the answer says of the queue, a
  // step that has not ended has not captured what it was reading.
  (reading.overdue ?? null) === null;

/** `45 s`, `17 min`, `1 h 5 min`: how long a capture step has run, as a status line words it. */
export const captureDurationWords = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
};

/**
 * A capture step past its bound, as one clause: `capture step overdue · small snap › git cat-file
 * --batch-check · running 17 min · bound 2 min`. What was observed when the answer was made.
 */
export const captureOverdueWords = (overdue: {
  readonly step: string;
  readonly runningMs: number | null;
  readonly boundMs: number | null;
}): string =>
  [
    "capture step overdue",
    overdue.step.trim() === "" ? "a capture step" : clipped(overdue.step),
    ...(overdue.runningMs === null ? [] : [`running ${captureDurationWords(overdue.runningMs)}`]),
    ...(overdue.boundMs === null ? [] : [`bound ${captureDurationWords(overdue.boundMs)}`]),
  ].join(" · ");

/**
 * What an answer says the executor holds that its last completed final flush did not save, in
 * terse words (`4.1 KB pending`, `unreadable tree/a.txt`, `incomplete · changed`); null when it
 * says nothing against a save. Received evidence beats stored evidence (cross-repo decision 10):
 * such an answer, taken after a `complete: true` Mend observed or a seal the store holds, revokes
 * it — whatever registered since, the executor held unsaved work at that moment. An answer that
 * leaves a field out says nothing with it: only what was reported counts.
 */
export const captureUnsavedWordsOf = (reading: CaptureReading): string | null => {
  if (captureSaved(reading)) return null;
  if (reading.fenced) return "fenced";
  if (reading.pending > 0) {
    return `${reading.pendingBytes === null ? `${reading.pending}` : captureBytesWords(reading.pendingBytes)} pending`;
  }
  if ((reading.refused ?? 0) > 0) return "refused";
  const overdue = reading.overdue ?? null;
  if (overdue !== null) return captureOverdueWords(overdue);
  const snap = captureSnapDetailOf(reading);
  if (snap !== null) return snap;
  if (reading.complete === false)
    return `incomplete · ${reading.incompleteReason ?? "no reason given"}`;
  if (reading.bulkDirty === true) return "bulk changed since its last snapshot";
  return null;
};

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
    reason === "store-fidelity" ||
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

/**
 * The small class's last snap failed. From the per-class `snaps` when sealantd reports them, so a
 * failing bulk snap does not hold up what only needs the small class; from the summed fields
 * (`captureSnapFailing`) otherwise.
 */
const smallSnapFailing = (reading: CaptureReading): boolean => {
  const snaps = reading.snaps ?? null;
  if (snaps === null || snaps.length === 0) return captureSnapFailing(reading);
  return snaps.some((snap) => snap.class === "small" && snap.failing);
};

/** The byte quota refused the small class: by name when the answer names classes, else any. */
const smallRefused = (reading: CaptureReading): boolean => {
  const classes = reading.refusedClasses ?? null;
  return classes === null ? (reading.refused ?? 0) > 0 : classes.includes("small");
};

/**
 * The answer does not say how the snapshots read: `unreadable` is absent. sealantd reports it on
 * every flush and status (`Some(n)`, 0 included) since snapshot health; an older daemon, or an SDK
 * facade that rebuilds the answer field by field (`@sealant/sdk` 0.37.2's `capture.flush()`),
 * leaves it out — and leaves out every failure field with it. Nothing is assumed clean.
 */
export const CAPTURE_HEALTH_UNREPORTED = "snapshot health not reported";

/**
 * Why the registered head has not caught up with the executor's small class as of this answer
 * (`captureCaughtUp`), in terse words; null when it has.
 */
export const captureBehindReason = (reading: CaptureReading): string | null => {
  if (reading.fenced) return "fenced";
  if (!captureHarvestReady(reading)) return "pending";
  if (reading.paused) return "paused";
  if (reading.repairing === true) return "repairing";
  if ((reading.overdue ?? null) !== null) return "capture step overdue";
  if (smallRefused(reading)) return "refused";
  if (reading.unreadable === null) return CAPTURE_HEALTH_UNREPORTED;
  if (Math.max(reading.unreadable, reading.unreadablePaths.length) > 0) return "unreadable";
  if (smallSnapFailing(reading)) return "snapshot failed";
  return null;
};

/**
 * Whether the registered head has caught up with the executor's small class as of this answer —
 * the barrier a landing takes before it publishes (`SessionEngine.landingCheckpoint`), and what
 * lets any checkpoint say `flushed`. Harvest-ready (`captureHarvestReady`), and the small snapshot
 * the answer followed succeeded and holds everything: no small snap failing, no path it could not
 * read (sealantd sums `unreadable` over both classes and names no class, so any unreadable path
 * holds it — a carried path would publish its last captured content, not the disk's), no small
 * refusal, no register being repaired and no paused shipping. An empty queue alone is not that:
 * a snap that fails or carries a path forward stages nothing new. An answer that does not report
 * snapshot health at all (`CAPTURE_HEALTH_UNREPORTED`) has not caught up: absence is not a clean
 * snapshot (cross-repo decision 9).
 */
export const captureCaughtUp = (reading: CaptureReading): boolean =>
  captureBehindReason(reading) === null;

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
 * - `saved`: the final flush completed and nothing is pending (`captureSaved`), and the
 *   executor's kept evidence reads saved (`evidenceSaved`); terminate.
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
  /**
   * Whether the executor's kept evidence reads saved — the one decision a seal and an end are
   * read by too (`executorEndOf`; cross-repo decision 31, review 2026-09-28 (10) #7): a completed
   * answer of the executor being drained, under its epoch, made after every unsaved answer it
   * keeps, with every answer asked of it published. A completed reading alone is what the
   * executor said, not that decision: while the evidence does not read saved, the drain goes on
   * as if the reading had not completed — saving while anything moves, kept once nothing did for
   * the window.
   */
  readonly evidenceSaved: boolean;
}): CaptureDrainStep => {
  const { reading } = input;
  if (reading !== null && captureSaved(reading) && input.evidenceSaved) return { kind: "saved" };
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
  /**
   * A capture step the executor reported still running past its bound (`CaptureReading.overdue`):
   * what it is, when it started, how long it had run and its bound when last observed. Absent or
   * null: none reported.
   */
  readonly captureOverdueStep?: string | null;
  readonly captureOverdueSince?: Date | string | null;
  readonly captureOverdueRunningMs?: number | null;
  readonly captureOverdueBoundMs?: number | null;
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
    case "sealing":
      // Not "not registered" (e2e8): since cross-repo decision 22 sealantd also answers `sealing`
      // for a seal the store recorded and withheld — the sealing capture registered, the seal on
      // record, a URL still able to replace what it names. What every case shares is that the
      // registrar has not confirmed a standing seal.
      return "final seal not confirmed";
    case "changed":
      return "changed after the final flush";
    case "unwatched":
      return "a capture class is polled, currency not observed";
    case "store-fidelity":
      return "the store does not read every manifest feature this executor writes";
    case "internal":
      return "executor error";
    case CAPTURE_EXECUTOR_RETAINED:
      return "executor kept for recovery";
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
  const step = facts.captureOverdueStep ?? null;
  const overdue =
    step === null
      ? null
      : captureOverdueWords({
          step,
          runningMs: facts.captureOverdueRunningMs ?? null,
          boundMs: facts.captureOverdueBoundMs ?? null,
        });
  if (facts.captureDrain !== null) {
    if (facts.captureNotSavedAt !== null) {
      const why = captureIncompleteWords(facts.captureIncompleteReason);
      const detail = facts.captureIncompleteDetail ?? null;
      return [
        "not saved",
        ...(why === null ? [] : [why]),
        ...(detail === null || detail === "" ? [] : [detail]),
        ...(overdue === null ? [] : [overdue]),
        ...(left === null ? [] : [`${left} pending`]),
        ...(facts.captureIncompleteReason === CAPTURE_EXECUTOR_RETAINED ? [] : ["workspace kept"]),
      ].join(" · ");
    }
    return [
      left === null ? "saving" : `saving · ${left} left`,
      ...(overdue === null ? [] : [overdue]),
    ].join(" · ");
  }
  // A step past its bound says more than a failing snap (the snap it is inside has not failed
  // yet) and than any queue: nothing it reads is saved until it ends.
  if (overdue !== null) return overdue;
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
   * The chain head as registered when the end was observed: its capture kind, its chain position
   * when known, its registration time, and whether its bulk section was still `pending`. Null
   * when nothing ever registered.
   */
  readonly head: {
    readonly kind: string;
    readonly n?: number | null;
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
    /** Where the executor made that answer; absent or null when unknown. */
    readonly position?: CapturePosition | null;
  };
  /**
   * This executor's own word that its final flush completed (`captureSaved`: `complete: true`,
   * nothing pending), as Mend observed it from this executor under its epoch, and the chain
   * position it named. Null or absent: Mend never observed one.
   */
  readonly finalSaved?: {
    readonly at: Date;
    readonly n: number | null;
    readonly position?: CapturePosition | null;
  } | null;
  /**
   * The store's sealed record for this executor and epoch: sealantd registered its sealing
   * capture with `final_seal: { complete: true }` after a completed final flush. Null or absent:
   * none recorded, or none Mend can bind to this executor and epoch.
   */
  readonly sealed?: {
    readonly at: Date;
    readonly n: number | null;
    readonly position?: CapturePosition | null;
  } | null;
  /**
   * Every answer this executor gave that said it held unsaved work (`captureUnsavedWordsOf`) and
   * that no other such answer was made after (`withUnsavedAnswer`, cross-repo decision 25): when
   * Mend took each and in its words. One made after a completed final flush or a seal revokes that
   * save (cross-repo decision 10), and one nothing orders against it leaves it undecided: a save
   * stands only over every one of them. Null, absent or empty: none observed.
   */
  readonly unsaved?: ReadonlyArray<{
    readonly at: Date;
    readonly words: string;
    readonly position?: CapturePosition | null;
  }> | null;
  /**
   * Whether every answer asked of this executor was published as its evidence (cross-repo
   * decision 18, review 2026-09-28 (7) #3). False: an answer is in flight, or arrived and was
   * not published — it may say anything, so no save reads `saved` and none reads `lost`: the
   * end is `unconfirmed`. Absent: true.
   */
  readonly settled?: boolean;
}

/**
 * How such an end reads. Saved is never inferred from a capture's kind: a final-kind head can
 * carry an older bulk section after its final flush failed (review 2026-09-28 #13).
 * - `saved`: Mend observed this executor answer `complete: true` with nothing pending under its
 *   epoch, or the store holds the sealed record of its completed final flush — it had stopped
 *   every writer, snapshotted both classes and registered them, and admits nothing after that,
 *   so captures registered on top of it change nothing;
 * - `unconfirmed`: this executor took a final capture of its own (sealantd ran its final flush,
 *   so something outside Mend stopped it), and neither word says that flush completed. The last
 *   registered capture is named; its completion is unknown. Also a confirmed save that evidence
 *   nothing orders against it (incomparable, contradictory) or an unpublished answer leaves
 *   standing undecided (review 2026-09-28 (7) #4): the save is named, its completion unknown;
 * - `lost`: anything else. `lastSavedAt` is the head's registration.
 * In both of the last two, `pending` is what Mend last observed unsaved on this executor after
 * that registration: an answer that saw something pending, or one that said it held work not
 * saved (`ExecutorEndFacts.unsaved`). Mend never counts what it did not observe.
 *
 * A save that a later answer of this executor contradicted (`unsaved` or a pending reading the
 * executor made strictly after it) is not `saved`: it is `lost`, naming that save as the last one
 * confirmed and what was observed after it (review 2026-09-28 (4) #9). Only an answer ordered
 * after every save says the work after it was not saved; one nothing orders against a save
 * leaves it `unconfirmed` (review 2026-09-28 (7) #4).
 */
export type ExecutorEnd =
  | { readonly kind: "saved"; readonly savedAt: Date; readonly n?: number | null }
  | {
      readonly kind: "unconfirmed";
      readonly lastSavedAt: Date;
      readonly lastSavedN: number | null;
      readonly pending: { readonly words: string; readonly observedAt: Date } | null;
    }
  | {
      readonly kind: "lost";
      readonly lastSavedAt: Date | null;
      /** The chain position of that save, when it was a confirmed one; absent otherwise. */
      readonly lastSavedN?: number | null;
      readonly pending: { readonly words: string; readonly observedAt: Date } | null;
    };

/** The words and time of an unsaved answer, as an end names it. */
const toPending = (answer: { readonly words: string; readonly observedAt: Date } | undefined) =>
  answer === undefined ? null : { words: answer.words, observedAt: answer.observedAt };

export const executorEndOf = (facts: ExecutorEndFacts): ExecutorEnd => {
  const { head, reading, executorStartedAt } = facts;
  // Which executor a session row's reading or a legacy save belongs to (display, and a filter
  // that only ever drops evidence of a save): never an order between answers.
  const byThisExecutor = (at: Date) =>
    executorStartedAt === null || at.getTime() >= executorStartedAt.getTime();
  const queuedReading =
    reading.observedAt !== null &&
    reading.pending !== null &&
    reading.pending > 0 &&
    byThisExecutor(reading.observedAt)
      ? {
          words: `${
            reading.pendingBytes !== null
              ? captureBytesWords(reading.pendingBytes)
              : `${reading.pending}`
          } pending`,
          observedAt: reading.observedAt,
          position: reading.position ?? null,
        }
      : null;
  const stated = (facts.unsaved ?? []).map((answer) => ({
    words: answer.words,
    observedAt: answer.at,
    position: answer.position ?? null,
  }));
  // Every answer that said the executor held unsaved work, as the executor ordered them.
  const unsavedAnswers = [...stated, queuedReading].filter((answer) => answer !== null);
  /** The unsaved answers a save does not cover, the latest first (cross-repo decision 17). */
  const uncoveredBy = (save: CapturePosition | null) =>
    unsavedAnswers
      .filter((answer) => !saveCoversUnsaved(save, answer.position))
      .toSorted((a, b) => (captureOrderOf(a.position, b.position) === "before" ? 1 : -1));
  // Every save this executor's own word or the store confirms: the completed final flush Mend
  // observed, and the seal.
  const finalSaved = facts.finalSaved ?? null;
  const sealed = facts.sealed ?? null;
  const saves = [
    ...(finalSaved !== null && byThisExecutor(finalSaved.at)
      ? [{ at: finalSaved.at, n: finalSaved.n, position: finalSaved.position ?? null }]
      : []),
    ...(sealed !== null ? [{ at: sealed.at, n: sealed.n, position: sealed.position ?? null }] : []),
  ].toSorted((a, b) => {
    const order = captureOrderOf(a.position, b.position);
    if (order === "after") return -1;
    if (order === "before") return 1;
    return (b.n ?? -1) - (a.n ?? -1);
  });
  const latest = saves[0];
  if (latest !== undefined) {
    // An answer asked and not published may say anything (cross-repo decision 18): no save reads
    // saved, and none reads lost on it — the latest confirmed one is named, completion unknown.
    if (facts.settled === false) {
      return {
        kind: "unconfirmed",
        lastSavedAt: latest.at,
        lastSavedN: latest.n,
        pending: toPending(uncoveredBy(latest.position)[0]),
      };
    }
    // Received evidence beats stored evidence (cross-repo decision 10): a save stands only over
    // unsaved answers the executor made strictly before it — never by whose clock said what.
    const covering = saves.find((save) => uncoveredBy(save.position).length === 0);
    if (covering !== undefined) {
      return { kind: "saved", savedAt: covering.at, n: covering.n };
    }
    // Lost only when the executor itself said so after every save: an unsaved answer it made
    // strictly after each one (review 2026-09-28 (7) #4). A save only incomparable or
    // contradictory evidence stands against is undecided — named, its completion unknown.
    const refutedBy = (save: (typeof saves)[number]) =>
      uncoveredBy(save.position).filter(
        (answer) => captureOrderOf(answer.position, save.position) === "after",
      );
    const undecided = saves.find((save) => refutedBy(save).length === 0);
    if (undecided !== undefined) {
      return {
        kind: "unconfirmed",
        lastSavedAt: undecided.at,
        lastSavedN: undecided.n,
        pending: toPending(uncoveredBy(undecided.position)[0]),
      };
    }
    return {
      kind: "lost",
      lastSavedAt: latest.at,
      lastSavedN: latest.n,
      pending: toPending(refutedBy(latest)[0]),
    };
  }
  const lastSavedAt = head?.registeredAt ?? null;
  // Nothing confirmed: what Mend observed pending after the last registration, for the words.
  const after = unsavedAnswers
    .filter(
      (answer) =>
        byThisExecutor(answer.observedAt) &&
        (lastSavedAt === null || answer.observedAt.getTime() > lastSavedAt.getTime()),
    )
    .toSorted((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const pending = toPending(after[0]);
  if (head !== null && head.kind === "final" && byThisExecutor(head.registeredAt)) {
    return {
      kind: "unconfirmed",
      lastSavedAt: head.registeredAt,
      lastSavedN: head.n ?? null,
      pending,
    };
  }
  return { kind: "lost", lastSavedAt, pending };
};

/**
 * `stopped outside Mend · saved at 16:29:51 UTC` (`· capture 21` when the chain position is
 * known); `stopped outside Mend · last saved capture 21 at 16:29:51 UTC · completion unknown`
 * when its own final capture registered without a completed word; or `executor lost · last saved
 * 16:32:06 UTC · changes after that were not saved · 3 pending at 16:32:00 UTC` (the last part
 * only when Mend read the queue after that save). Every "executor lost" line starts with
 * `executor lost`.
 */
export const executorEndWords = (end: ExecutorEnd): string => {
  if (end.kind === "saved") {
    const n = end.n ?? null;
    return `stopped outside Mend · saved at ${utcTime(end.savedAt)}${n === null ? "" : ` · capture ${n}`}`;
  }
  const pending =
    end.pending === null ? [] : [`${end.pending.words} at ${utcTime(end.pending.observedAt)}`];
  if (end.kind === "unconfirmed") {
    const capture = end.lastSavedN === null ? "" : `capture ${end.lastSavedN} at `;
    return [
      "stopped outside Mend",
      `last saved ${capture}${utcTime(end.lastSavedAt)}`,
      "completion unknown",
      ...pending,
    ].join(" · ");
  }
  const lastSavedN = end.lastSavedN ?? null;
  const saved =
    end.lastSavedAt === null
      ? ["nothing saved"]
      : [
          `last saved ${lastSavedN === null ? "" : `capture ${lastSavedN} at `}${utcTime(end.lastSavedAt)}`,
          "changes after that were not saved",
        ];
  return ["executor lost", ...saved, ...pending].join(" · ");
};

/**
 * `saved at 16:29:51 UTC · capture 21`: what a session reads once its executor was saved and
 * ended after all (its seal attested and accepted, or its own completed final flush), whatever
 * it read before.
 */
export const executorSavedWords = (saved: { readonly at: Date; readonly n: number | null }) =>
  `saved at ${utcTime(saved.at)}${saved.n === null ? "" : ` · capture ${saved.n}`}`;

/** Where a verdict on the executor starts in a session's summary (`restatedSummary`). */
const EXECUTOR_VERDICTS = [
  "executor not answering",
  "executor lost",
  "stopped outside Mend",
  "saved at ",
] as const;

/**
 * A settled session's summary rewritten from the latest observation of its executor, or null
 * when the summary is not Mend's word on that executor (a harness's own end stands). A verdict
 * on the executor is replaced; a failed launch keeps its own words and the verdict follows them:
 * `launch failed: setup command exited 1 · saved at 16:29:51 UTC · capture 21`.
 */
export const restatedSummary = (prior: string | null, latest: string): string | null => {
  if (prior === null) return null;
  if (EXECUTOR_VERDICTS.some((verdict) => prior.startsWith(verdict))) return latest;
  if (!prior.startsWith("launch failed")) return null;
  const cut = EXECUTOR_VERDICTS.map((verdict) => prior.indexOf(` · ${verdict}`))
    .filter((at) => at >= 0)
    .toSorted((a, b) => a - b)[0];
  return `${cut === undefined ? prior : prior.slice(0, cut)} · ${latest}`;
};

/**
 * A harness that ended while its executor never answered Mend's looks: the executor's fate is
 * unknown, so the harness's own outcome is not what the session reports. `executor not answering
 * · last saved capture 21 at 16:29:51 UTC · completion unknown`, or `· nothing saved`.
 */
export const executorUnansweredWords = (
  lastSaved: { readonly n: number | null; readonly at: Date } | null,
): string =>
  [
    "executor not answering",
    lastSaved === null
      ? "nothing saved"
      : `last saved ${lastSaved.n === null ? "" : `capture ${lastSaved.n} at `}${utcTime(lastSaved.at)}`,
    "completion unknown",
  ].join(" · ");

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
