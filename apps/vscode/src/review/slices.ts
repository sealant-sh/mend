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

/** Two checkpoints of the chain, fixed when she chose them: a newer checkpoint never moves them. */
export interface Span {
  readonly from: Checkpoint;
  readonly to: Checkpoint;
}

export type SliceChoice =
  | { readonly kind: "pinned" }
  | ({ readonly kind: "since-last-review" } & Span)
  | ({ readonly kind: "last-turn" } & Span)
  | ({ readonly kind: "between" } & Span);

/** A choice resolved against the chain: the two checkpoints the diff compares. */
export interface Slice {
  readonly choice: SliceChoice;
  readonly from: Checkpoint;
  readonly to: Checkpoint;
  /** Comments go only on the pinned slice (G10). */
  readonly commentable: boolean;
}

/** The newest checkpoint Mend knows of: the chain's, or the pinned head when the chain lags. */
const newestCheckpoint = (chain: ReadonlyArray<Checkpoint>, pinned: PinnedSlice): Checkpoint =>
  chain.reduce(
    (best, checkpoint) => (checkpoint.ordinal > best.ordinal ? checkpoint : best),
    pinned.head,
  );

/**
 * The slice a choice reads. A chosen span reads its own two checkpoints; one whose ends are no
 * longer in the chain, or whose start is not before its end, resolves to null.
 */
export const resolveSlice = (
  choice: SliceChoice,
  pinned: PinnedSlice,
  chain: ReadonlyArray<Checkpoint>,
): Slice | null => {
  if (choice.kind === "pinned")
    return { choice, from: pinned.base, to: pinned.head, commentable: true };
  const from = chain.find((checkpoint) => checkpoint.id === choice.from.id);
  const to = chain.find((checkpoint) => checkpoint.id === choice.to.id);
  if (from === undefined || to === undefined || from.ordinal >= to.ordinal) return null;
  return { choice, from, to, commentable: false };
};

/** Whether two choices read the same two checkpoints. */
export const sameChoice = (left: SliceChoice, right: SliceChoice): boolean =>
  left.kind === "pinned" || right.kind === "pinned"
    ? left.kind === right.kind
    : left.kind === right.kind && left.from.id === right.from.id && left.to.id === right.to.id;

/**
 * The agent's last turn. Mend takes a turn boundary when a turn ends (packages/sessions engine,
 * `turn-boundary`) and a session start when a session starts; none when a turn starts. So the last
 * turn ends at the newest turn boundary and starts at the boundary or session start before it,
 * else at the chain's base. Null before any turn ended. The chain is in ordinal order.
 */
export const lastTurn = (chain: ReadonlyArray<Checkpoint>): Span | null => {
  const to = chain.findLast((checkpoint) => checkpoint.trigger === "turn-boundary");
  if (to === undefined) return null;
  const from =
    chain.findLast(
      (checkpoint) =>
        checkpoint.ordinal < to.ordinal &&
        (checkpoint.trigger === "turn-boundary" || checkpoint.trigger === "session-start"),
    ) ?? chain[0];
  return from === undefined || from.ordinal >= to.ordinal ? null : { from, to };
};

/** A review this VS Code sent, and when: what since my last review starts from. */
export interface SentReview {
  readonly headId: string;
  readonly at: string;
}

/**
 * The checkpoint her last sent review was pinned to: the head of her most recently sent review,
 * among the comments Mend sent to a session that carry her name as their reviewer, and the reviews
 * this VS Code sent (`sentHeads`), which include one pasted into a terminal that Mend still holds
 * pending. A comment's time is when it was written: marking it addressed later moves its
 * `updatedAt`, never which review was hers last. Null with no name to match and nothing sent here.
 */
export const lastReviewHead = (
  chain: ReadonlyArray<Checkpoint>,
  comments: ReadonlyArray<ServerComment>,
  author: string | null,
  sentHeads: ReadonlyArray<SentReview>,
): Checkpoint | null => {
  const sent = [
    ...comments.flatMap((comment) =>
      author !== null &&
      comment.author.kind === "reviewer" &&
      comment.author.name === author &&
      comment.sentToSessionId !== null &&
      comment.anchor !== null
        ? [{ headId: comment.anchor.headId, at: comment.createdAt }]
        : [],
    ),
    ...sentHeads,
  ].filter((review) => chain.some((checkpoint) => checkpoint.id === review.headId));
  const last = sent.reduce<SentReview | null>(
    (best, review) =>
      best === null || Date.parse(review.at) > Date.parse(best.at) ? review : best,
    null,
  );
  return last === null ? null : (chain.find((checkpoint) => checkpoint.id === last.headId) ?? null);
};

/** What the slices other than the pinned one read off: the chain, and her last review's head. */
export interface SliceBasis {
  readonly pinned: PinnedSlice;
  readonly chain: ReadonlyArray<Checkpoint>;
  /** The head checkpoint of the last review she sent; null before one. */
  readonly reviewedHead: Checkpoint | null;
}

/** Since my last review or last turn, as the chain reads now; null when it has nothing to read. */
export const freshChoice = (
  kind: "since-last-review" | "last-turn",
  basis: SliceBasis,
): SliceChoice | null => {
  const span =
    kind === "last-turn"
      ? lastTurn(basis.chain)
      : basis.reviewedHead === null
        ? null
        : {
            from: basis.reviewedHead,
            to: newestCheckpoint(basis.chain, basis.pinned),
          };
  if (span === null) return null;
  const choice: SliceChoice = { kind, from: span.from, to: span.to };
  return resolveSlice(choice, basis.pinned, basis.chain) === null ? null : choice;
};

/**
 * The newer read of what she chose: since my last review, or last turn, as the chain reads now,
 * once newer checkpoints moved it. Null when her choice is still the newest.
 */
export const newerChoice = (current: SliceChoice, basis: SliceBasis): SliceChoice | null => {
  if (current.kind !== "since-last-review" && current.kind !== "last-turn") return null;
  const fresh = freshChoice(current.kind, basis);
  return fresh === null || sameChoice(fresh, current) ? null : fresh;
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

/** The slice's span in checkpoint words, as the picker describes it: `checkpoint 3 → checkpoint 6`. */
export const sliceSpan = (slice: Slice, base: string): string =>
  `${slice.from.ordinal === 0 ? "base" : checkpointName(slice.from, base)} → ${checkpointName(slice.to, base)}`;

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

/**
 * The header's fact, in what Mend said of the diff: `4 files · +120 −18 · observed · 40 s ago`.
 * A diff Mend gave no observation for says only when it was read; a listing Mend cut says so, and
 * never `observed`, since the files it lists are not all of the slice.
 */
export const headerFact = (input: {
  readonly files: ReadonlyArray<ChangeFile>;
  readonly observation: Observation | null;
  readonly listingCut: boolean;
  /** When the slice's diff was read: what `ago` counts from when Mend gave no time. */
  readonly readAt: string;
  readonly now: Date;
}): string => {
  const { files, observation, listingCut, readAt, now } = input;
  if (listingCut) {
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return `listing cut at ${files.length} ${files.length === 1 ? "file" : "files"} · +${additions} −${deletions} in those · read ${secondsAgo(readAt, now)}`;
  }
  if (observation === null) return `${filesLine(files)} · read ${secondsAgo(readAt, now)}`;
  return `${filesLine(files)} · ${observation.state} · ${secondsAgo(observation.observedAt ?? readAt, now)}`;
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
 * checkpoint her last sent review was pinned to), last turn, and between two checkpoints. Each reads
 * the chain as it is now: a choice she made before newer checkpoints is offered again, newer.
 */
export const sliceOffers = (
  input: SliceBasis & { readonly base: string; readonly current: SliceChoice },
): ReadonlyArray<SliceOffer> => {
  const { pinned, chain, base, current } = input;
  const offers: Array<SliceOffer> = [];
  const offer = (label: string, choice: SliceChoice | null): void => {
    const slice = choice === null ? null : resolveSlice(choice, pinned, chain);
    if (slice !== null)
      offers.push({
        label,
        choice: slice.choice,
        span: sliceSpan(slice, base),
        current: sameChoice(slice.choice, current),
      });
  };
  offer(`${base} → now`, { kind: "pinned" });
  offer("since my last review", freshChoice("since-last-review", input));
  offer("last turn", freshChoice("last-turn", input));
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
