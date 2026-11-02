import { queryOptions } from "@tanstack/react-query";

import { openReview } from "./api.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * Opening a review is an idempotent MUTATION used as a query: it runs once per per-tab
 * idempotency key and pins the result (staleTime ∞), so a revisit reuses the same slice instead of
 * opening a new one.
 */
export const openReviewQuery = (changeId: string) =>
  queryOptions({
    queryKey: ["change", changeId, "review-open", reviewOpenKey(changeId)],
    queryFn: () => openReview(changeId, reviewOpenKey(changeId)),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** This browser tab's key for opening the change's review, kept for the tab's life. */
export const reviewOpenKey = (changeId: string): string => {
  const storageKey = `mend.review.${changeId}.open-key`;
  const current = sessionStorage.getItem(storageKey);
  if (current !== null) return current;
  const created = uuidV4();
  sessionStorage.setItem(storageKey, created);
  return created;
};

/** A fresh key, so the next open reads the change as it is now rather than the pinned slice. */
export const renewReviewOpenKey = (changeId: string): void => {
  sessionStorage.setItem(`mend.review.${changeId}.open-key`, uuidV4());
};
