import { queryOptions } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { openReview, type ReviewRangeRequest } from "./api.ts";
import { draftKeys, readDraft } from "./drafts.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * Opening a review is an idempotent MUTATION used as a query: it runs once per per-tab
 * idempotency key and pins the result (staleTime ∞), so a revisit reuses the same slice instead of
 * opening a new one. Every view of the change reads the same key, so the diff and the review panel
 * always show one slice.
 */
export const openReviewQuery = (
  changeId: string,
  key: string = reviewOpenKey(changeId),
  range: ReviewRangeRequest | null = null,
) =>
  queryOptions({
    queryKey: ["change", changeId, "review-open", key, range],
    queryFn: () => openReview(changeId, key, range ?? undefined),
    staleTime: Number.POSITIVE_INFINITY,
  });

const storageKey = (changeId: string) => `mend.review.${changeId}.open-key`;

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** This browser tab's key for opening the change's review, kept for the tab's life. */
export const reviewOpenKey = (changeId: string): string => {
  const current = sessionStorage.getItem(storageKey(changeId));
  if (current !== null) return current;
  const created = uuidV4();
  sessionStorage.setItem(storageKey(changeId), created);
  return created;
};

/** The key, read as it changes: every view of the change follows a renewal at once. */
export const useReviewOpenKey = (changeId: string): string =>
  useSyncExternalStore(
    subscribe,
    () => reviewOpenKey(changeId),
    () => "",
  );

const rangeKey = (changeId: string) => `mend.review.${changeId}.range`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** A stored range, read back; anything not shaped like one is the whole change (null). */
export const parseRange = (stored: string | null): ReviewRangeRequest | null => {
  if (stored === null || stored === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value["from"] !== "string") return null;
  const from = value["from"];
  const to = value["to"];
  return typeof to === "string" && from !== "last-review" ? { from, to } : { from };
};

/**
 * The range this browser tab reviews the change over (Second look), kept for the tab's life like
 * its key; null is the whole change. Read as it changes: every view of the change follows.
 */
export const useReviewRange = (changeId: string): ReviewRangeRequest | null => {
  const stored = useSyncExternalStore(
    subscribe,
    () => sessionStorage.getItem(rangeKey(changeId)),
    () => null,
  );
  return parseRange(stored);
};

/** Review the change over `range` (null: the whole change) from now on in this tab. */
export const setReviewRange = (changeId: string, range: ReviewRangeRequest | null): void => {
  if (range === null || (range.from === "base" && range.to === undefined))
    sessionStorage.removeItem(rangeKey(changeId));
  else sessionStorage.setItem(rangeKey(changeId), JSON.stringify(range));
  renewReviewOpenKey(changeId);
};

/** A fresh key, so every view opens the change as it is now rather than the pinned slice. */
export const renewReviewOpenKey = (changeId: string): void => {
  sessionStorage.setItem(storageKey(changeId), uuidV4());
  for (const listener of listeners) listener();
};

/** Whether this tab holds unsent review comments written on one slice of the change. */
export const hasReviewDrafts = (changeId: string, sliceId: string): boolean =>
  draftKeys().some(
    (key) =>
      key.startsWith("review.") &&
      key.includes(`.${changeId}.${sliceId}.`) &&
      readDraft(key).trim() !== "",
  );

/** What the guard reads of a stored comment: which slice it was written on, and whether it went. */
export interface StoredComment {
  readonly anchor: { readonly reviewSliceId: string } | null;
  readonly state: string;
  readonly sentToSessionId: string | null;
}

/**
 * Whether entering the Change tab should open the change as it is now instead of the slice this
 * tab pinned on an earlier visit: the worktree moved on since, and nothing on the pinned slice is
 * still to send. Comments saved there and not yet sent count as much as words still being
 * written: they belong to that slice's lines. When the comments could not be read (`null`), the
 * pinned slice stays. A slice that still matches stays too, so a reviewer reading it is never
 * moved.
 */
export const opensCurrentChange = (
  pinned: { readonly worktreeChangedSinceSnapshot: boolean },
  changeId: string,
  sliceId: string,
  comments: ReadonlyArray<StoredComment> | null,
): boolean =>
  pinned.worktreeChangedSinceSnapshot &&
  comments !== null &&
  !comments.some(
    (comment) =>
      comment.anchor?.reviewSliceId === sliceId &&
      comment.state === "open" &&
      comment.sentToSessionId === null,
  ) &&
  !hasReviewDrafts(changeId, sliceId);

/**
 * A fresh key, as `renewReviewOpenKey`, only while `opened` is still the tab's key: work that
 * read an older open never moves a review someone has opened since.
 */
export const renewReviewOpenKeyFrom = (changeId: string, opened: string): void => {
  if (reviewOpenKey(changeId) === opened) renewReviewOpenKey(changeId);
};
