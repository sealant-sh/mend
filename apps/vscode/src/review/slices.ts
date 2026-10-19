import type {
  ChangeFile,
  Checkpoint,
  Observation,
  PinnedSlice,
  ServerComment,
} from "./review-wire.js";

/**
 * Which part of a change she reads (story d, step 5), decided without reading. Only the pinned
 * slice, base to the checkpoint `reviews/open` took, takes comments: Mend anchors a comment in that
 * slice's hunks, and no route opens a slice between two other checkpoints yet (G10).
 */

export type SliceChoice =
  | { readonly kind: "pinned" }
  | { readonly kind: "since-last-review"; readonly from: Checkpoint }
  | { readonly kind: "last-turn"; readonly from: Checkpoint }
  | { readonly kind: "between"; readonly from: Checkpoint; readonly to: Checkpoint };

/** A choice resolved against the chain: the two checkpoints the diff compares. */
export interface Slice {
  readonly choice: SliceChoice;
  readonly from: Checkpoint;
  readonly to: Checkpoint;
  /** Comments go only on the pinned slice (G10). */
  readonly commentable: boolean;
}

const newest = (chain: ReadonlyArray<Checkpoint>, pinned: PinnedSlice): Checkpoint =>
  chain.reduce(
    (best, checkpoint) => (checkpoint.ordinal > best.ordinal ? checkpoint : best),
    pinned.head,
  );

/**
 * The slice a choice reads. A choice other than the pinned one reads up to the newest checkpoint
 * ("now"); one whose start is not before its end has nothing to read and resolves to null.
 */
export const resolveSlice = (
  choice: SliceChoice,
  pinned: PinnedSlice,
  chain: ReadonlyArray<Checkpoint>,
): Slice | null => {
  switch (choice.kind) {
    case "pinned":
      return { choice, from: pinned.base, to: pinned.head, commentable: true };
    case "since-last-review":
    case "last-turn": {
      const to = newest(chain, pinned);
      return choice.from.ordinal < to.ordinal
        ? { choice, from: choice.from, to, commentable: false }
        : null;
    }
    case "between":
      return choice.from.ordinal < choice.to.ordinal
        ? { choice, from: choice.from, to: choice.to, commentable: false }
        : null;
  }
};

/**
 * Where the agent's last turn started: the newest turn boundary (or the session's start) before
 * the newest checkpoint. Null when the chain has no turn behind it.
 */
export const lastTurnStart = (
  chain: ReadonlyArray<Checkpoint>,
  pinned: PinnedSlice,
): Checkpoint | null => {
  const to = newest(chain, pinned);
  const starts = chain.filter(
    (checkpoint) =>
      checkpoint.ordinal < to.ordinal &&
      (checkpoint.trigger === "turn-boundary" || checkpoint.trigger === "session-start"),
  );
  return starts.at(-1) ?? null;
};

/**
 * The checkpoint her last sent review was pinned to: the newest head among the slices of the
 * comments Mend sent to a session, and of the reviews this VS Code sent (`sentHeads`), which
 * include one pasted into a terminal that Mend still holds pending.
 */
export const lastReviewHead = (
  chain: ReadonlyArray<Checkpoint>,
  comments: ReadonlyArray<ServerComment>,
  sentHeads: ReadonlyArray<string>,
): Checkpoint | null => {
  const heads = new Set([
    ...comments.flatMap((comment) =>
      comment.sentToSessionId !== null && comment.anchor !== null ? [comment.anchor.headId] : [],
    ),
    ...sentHeads,
  ]);
  return chain.filter((checkpoint) => heads.has(checkpoint.id)).at(-1) ?? null;
};

/** `checkpoint 6`, or the base's own name for ordinal 0. */
export const checkpointName = (checkpoint: Checkpoint, base: string): string =>
  checkpoint.ordinal === 0 ? base : `checkpoint ${checkpoint.ordinal}`;

/** The header's name for a slice: `main → now`, `since my last review`, `checkpoint 2 → checkpoint 5`. */
export const sliceName = (slice: Slice, base: string): string => {
  switch (slice.choice.kind) {
    case "pinned":
      return `${base} → now`;
    case "since-last-review":
      return "since my last review";
    case "last-turn":
      return "last turn";
    case "between":
      return `${checkpointName(slice.from, base)} → ${checkpointName(slice.to, base)}`;
  }
};

/** The slice's span in checkpoint words, as the picker describes it: `checkpoint 3 → now`. */
export const sliceSpan = (slice: Slice, base: string): string => {
  const to =
    slice.choice.kind === "pinned" || slice.choice.kind === "between"
      ? checkpointName(slice.to, base)
      : "now";
  return `${slice.from.ordinal === 0 ? "base" : checkpointName(slice.from, base)} → ${to}`;
};

/** `4 files · +120 −18`. */
export const filesLine = (files: ReadonlyArray<ChangeFile>): string => {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return `${files.length} ${files.length === 1 ? "file" : "files"} · +${additions} −${deletions}`;
};

/** `40 s ago`: the header counts seconds, since a review is read right after it lands. */
export const secondsAgo = (iso: string, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};

/** The header's fact: `4 files · +120 −18 · observed · 40 s ago`, as Mend observed it. */
export const headerFact = (input: {
  readonly files: ReadonlyArray<ChangeFile>;
  readonly observation: Observation | null;
  /** When the slice's diff was read: what `ago` counts from when Mend gave no time. */
  readonly readAt: string;
  readonly now: Date;
}): string => {
  const { files, observation, readAt, now } = input;
  const word = observation?.state ?? "observed";
  return `${filesLine(files)} · ${word} · ${secondsAgo(observation?.observedAt ?? readAt, now)}`;
};

/** A file's path in the slice: its new path, or its old one once deleted. */
export const filePath = (file: ChangeFile): string => file.newPath ?? file.oldPath ?? "";

/** The letter a file row carries, as VS Code's own Source Control marks it. */
export const statusLetter = (file: ChangeFile): string => {
  switch (file.status) {
    case "added":
    case "copied":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "type-changed":
      return "T";
    case "unmerged":
      return "U";
    case "modified":
    case "unknown":
      return "M";
  }
};

/** One choice in `Review which slice?`. A choice with nothing to read is not offered. */
export interface SliceOffer {
  readonly label: string;
  readonly choice: SliceChoice | "between";
  /** The span it reads, filled with its file count once read. */
  readonly span: string;
  readonly current: boolean;
}

/**
 * The picker's choices, in the storyboard's order: main → now, since my last review (from the
 * checkpoint her last sent review was pinned to), last turn, and between two checkpoints.
 */
export const sliceOffers = (input: {
  readonly pinned: PinnedSlice;
  readonly chain: ReadonlyArray<Checkpoint>;
  readonly base: string;
  readonly current: SliceChoice;
  /** The head checkpoint of the last review she sent from this VS Code; null before one. */
  readonly reviewedHead: Checkpoint | null;
}): ReadonlyArray<SliceOffer> => {
  const { pinned, chain, base, current, reviewedHead } = input;
  const offers: Array<SliceOffer> = [];
  const offer = (label: string, choice: SliceChoice): void => {
    const slice = resolveSlice(choice, pinned, chain);
    if (slice !== null)
      offers.push({
        label,
        choice,
        span: sliceSpan(slice, base),
        current: choice.kind === current.kind,
      });
  };
  offer(`${base} → now`, { kind: "pinned" });
  if (reviewedHead !== null)
    offer("since my last review", { kind: "since-last-review", from: reviewedHead });
  const turn = lastTurnStart(chain, pinned);
  if (turn !== null) offer("last turn", { kind: "last-turn", from: turn });
  if (chain.length >= 2)
    offers.push({
      label: "between two checkpoints…",
      choice: "between",
      span: `pick two of ${chain.length} checkpoints`,
      current: current.kind === "between",
    });
  return offers;
};

/** The diff tab's title: `limit.ts (main ↔ checkpoint 6)`. */
export const diffTitle = (path: string, slice: Slice, base: string): string =>
  `${path.split("/").at(-1) ?? path} (${checkpointName(slice.from, base)} ↔ ${checkpointName(slice.to, base)})`;
