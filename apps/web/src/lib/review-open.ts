import { queryOptions } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { openReview } from "./api.ts";
import { draftKeys, readDraft } from "./drafts.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * Opening a review is an idempotent MUTATION used as a query: it runs once per per-tab
 * idempotency key and pins the result (staleTime ∞), so a revisit reuses the same slice instead of
 * opening a new one. Every view of the change reads the same key, so the diff and the review panel
 * always show one slice.
 */
export const openReviewQuery = (changeId: string, key: string = reviewOpenKey(changeId)) =>
  queryOptions({
    queryKey: ["change", changeId, "review-open", key],
    queryFn: () => openReview(changeId, key),
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

/**
 * Whether entering the Change tab should open the change as it is now instead of the slice this
 * tab pinned on an earlier visit: the worktree moved on since, and nothing unsent was written on
 * the pinned slice (its comments would be left behind on it). A slice pinned while it still
 * matches stays, so a reviewer reading it is never moved.
 */
export const opensCurrentChange = (
  pinned: { readonly worktreeChangedSinceSnapshot: boolean },
  changeId: string,
  sliceId: string,
): boolean => pinned.worktreeChangedSinceSnapshot && !hasReviewDrafts(changeId, sliceId);
