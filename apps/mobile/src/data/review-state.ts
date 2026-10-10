// What the Review and Diff screens say about the change they show, decided
// without React Native so the rules run under vitest: which slice the screen
// should be pinned to, and whether the body is loading, failed, empty or a
// diff. The rule these exist for: a request that failed never renders as
// "nothing changed", and an empty slice says which checkpoint was empty and
// when it was taken, not that the worktree is clean.

import { checkpointSourceWords, type CheckpointSourceKind } from "@mend/domain/workbench";

/** One checkpoint of the worktree's chain, as `GET /sessions/:id` sends it. */
export interface CheckpointDto {
  readonly id: string;
  /** Position in the worktree's chain, dense from 0. */
  readonly ordinal: number;
  readonly sha: string;
  readonly trigger: string;
  readonly createdAt: string;
  /**
   * Taken during a Stop from the Stop's own flush (`CheckpointSource`): which reading, the capture
   * it reported and when Mend received it. Absent: observed for the checkpoint itself.
   */
  readonly source?: {
    readonly kind: CheckpointSourceKind;
    readonly captureN: number | null;
    readonly observedAt: string;
  };
}

/** Which capture (or the live worktree) a read was observed on. */
export interface ObservationDto {
  readonly state: "claimed" | "observed";
  readonly source: "worktree" | "capture";
  readonly captureN: number | null;
  readonly captureId: string | null;
  readonly seq: string | null;
  readonly partial: boolean;
  /** ISO 8601; null for the worktree source. */
  readonly observedAt: string | null;
  readonly label: string;
}

/** Wall-clock minutes, the way the phone's own clock would say them. */
export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ─── the pinned slice ───────────────────────────────────────────────────────

/**
 * The checkpoint a fresh open would move the review to: the newest one past
 * the pinned slice's second checkpoint. `review-open` checkpoints are left
 * out — opening a review takes one itself, so counting them would make every
 * advance ask for another.
 */
export const newerCheckpoint = (
  chain: ReadonlyArray<CheckpointDto>,
  pinned: Pick<CheckpointDto, "ordinal"> | null,
): CheckpointDto | null => {
  if (pinned === null) return null;
  let newest: CheckpointDto | null = null;
  for (const checkpoint of chain) {
    if (checkpoint.trigger === "review-open" || checkpoint.ordinal <= pinned.ordinal) continue;
    if (newest === null || checkpoint.ordinal > newest.ordinal) newest = checkpoint;
  }
  return newest;
};

/**
 * Whether the screen should reopen its review now, and for which checkpoint.
 * At most one open per newer checkpoint: when the server reuses the pinned
 * slice (the newer checkpoint changed nothing), the same checkpoint does not
 * ask again. While the reviewer is writing (`hold`), the review stays where
 * the draft was started.
 */
export const advanceTarget = (input: {
  readonly chain: ReadonlyArray<CheckpointDto>;
  readonly pinned: Pick<CheckpointDto, "ordinal"> | null;
  /** The checkpoint the screen last reopened for; null before the first advance. */
  readonly advancedFor: string | null;
  readonly hold: boolean;
}): string | null => {
  const newer = newerCheckpoint(input.chain, input.pinned);
  if (newer === null || newer.id === input.advancedFor || input.hold) return null;
  return newer.id;
};

// ─── what the body shows ────────────────────────────────────────────────────

/** A query as the body needs it: React Query's status and its error. */
export interface ReadFacts {
  readonly status: "pending" | "error" | "success";
  readonly error: Error | null;
}

/** The rendered slice as the body needs it; null until one has been read. */
export interface RenderedSlice {
  readonly fileCount: number;
  readonly checkpointB: Pick<CheckpointDto, "ordinal" | "createdAt" | "source">;
}

export type ChangeBody =
  | { readonly kind: "loading"; readonly line: string }
  | {
      readonly kind: "failed";
      /** Which request to retry. */
      readonly step: "open" | "diff";
      readonly line: string;
      readonly detail: string;
    }
  | { readonly kind: "empty"; readonly line: string }
  | { readonly kind: "files" };

/**
 * "no files changed · checkpoint 3 · observed 10:18" — what was read, not a claim. A checkpoint
 * taken from a Stop's own flush says that instead, with the time of that reading: "no files
 * changed · checkpoint 3 · from the Stop's final save · capture 12 · 10:16". Its own time is when
 * it was recorded, never when the disk was read.
 */
export const emptySliceLine = (
  checkpointB: Pick<CheckpointDto, "ordinal" | "createdAt" | "source">,
  format: (iso: string) => string = clock,
): string =>
  `no files changed · checkpoint ${checkpointB.ordinal} · ${
    checkpointB.source === undefined
      ? `observed ${format(checkpointB.createdAt)}`
      : checkpointSourceWords(checkpointB.source, format(checkpointB.source.observedAt))
  }`;

/**
 * Exactly one body per state. A slice already on screen stays on screen
 * while a newer one opens or fails to — `advanceFailure` says so beside it.
 */
export const changeBody = (input: {
  readonly open: ReadFacts;
  readonly diff: ReadFacts;
  readonly slice: RenderedSlice | null;
  readonly format?: (iso: string) => string;
}): ChangeBody => {
  const { open, diff, slice } = input;
  if (slice !== null) {
    return slice.fileCount === 0
      ? { kind: "empty", line: emptySliceLine(slice.checkpointB, input.format) }
      : { kind: "files" };
  }
  if (open.status === "error") {
    return {
      kind: "failed",
      step: "open",
      line: "review · did not open",
      detail: open.error?.message ?? "no detail reported",
    };
  }
  if (diff.status === "error") {
    return {
      kind: "failed",
      step: "diff",
      line: "review · the slice's diff could not be read",
      detail: diff.error?.message ?? "no detail reported",
    };
  }
  return {
    kind: "loading",
    line: open.status === "success" ? "reading the slice…" : "opening the review…",
  };
};

/** A newer open (or re-read) that failed while an older slice stays on screen. */
export const advanceFailure = (input: {
  readonly open: ReadFacts;
  readonly diff: ReadFacts;
  readonly slice: RenderedSlice | null;
}): { readonly step: "open" | "diff"; readonly line: string } | null => {
  if (input.slice === null) return null;
  if (input.open.status === "error") {
    return {
      step: "open",
      line: `a newer review did not open · ${input.open.error?.message ?? "no detail reported"}`,
    };
  }
  if (input.diff.status === "error") {
    return {
      step: "diff",
      line: `the last re-read failed · ${input.diff.error?.message ?? "no detail reported"}`,
    };
  }
  return null;
};

// ─── observations ───────────────────────────────────────────────────────────

/** Web parity (`ObservedStamp`): "observed · capture 7 · 10:18 · partial". */
export const observationLine = (
  observation: ObservationDto | undefined,
  format: (iso: string) => string = clock,
): string | null => {
  if (observation === undefined) return null;
  if (observation.source !== "capture") return "observed on the worktree";
  return [
    observation.state,
    `capture ${observation.captureN ?? "?"}`,
    ...(observation.observedAt === null ? [] : [format(observation.observedAt)]),
    ...(observation.partial ? ["partial"] : []),
  ].join(" · ");
};

/**
 * The "moved since" line, naming what it was judged against. In capture
 * mode the server compares the slice with the newest capture, not the live
 * worktree, so the line names that capture and when it was taken.
 */
export const movedLine = (
  review: {
    readonly worktreeChangedSinceSnapshot: boolean;
    readonly checkpointB: Pick<CheckpointDto, "ordinal">;
    readonly observation?: ObservationDto;
  },
  format: (iso: string) => string = clock,
): string | null => {
  if (!review.worktreeChangedSinceSnapshot) return null;
  const pinned = `checkpoint ${review.checkpointB.ordinal}`;
  const observation = review.observation;
  if (observation === undefined || observation.source !== "capture") {
    return `the worktree differs from ${pinned} · pull to refresh`;
  }
  const at = observation.observedAt === null ? "" : ` · observed ${format(observation.observedAt)}`;
  return `capture ${observation.captureN ?? "?"}${at} differs from ${pinned} · pull to refresh`;
};
