import { useSyncExternalStore } from "react";

/**
 * Words a person is writing that have not been sent yet: review comments and the Land
 * description. They live in sessionStorage per account, so a tab switch, a layout change or a
 * reload never loses them, and they go at sign-out with the message drafts (`mend.message.`).
 */
const PREFIX = "mend.message.draft.";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** One draft as it is stored now. */
export const readDraft = (key: string): string => {
  try {
    return sessionStorage.getItem(`${PREFIX}${key}`) ?? "";
  } catch {
    return "";
  }
};

/** Store (or, with "", drop) one draft and tell every reader. */
export const writeDraft = (key: string, value: string) => {
  try {
    if (value === "") sessionStorage.removeItem(`${PREFIX}${key}`);
    else sessionStorage.setItem(`${PREFIX}${key}`, value);
  } catch {
    // Private browsing or a full quota: the words stay on screen until the editor closes.
  }
  for (const listener of listeners) listener();
};

/**
 * Clear a draft once what it held was sent, unless it was edited while the send was out: the
 * edited words are still unsent.
 */
export const clearSentDraft = (key: string, sent: string) => {
  if (readDraft(key).trim() === sent.trim()) writeDraft(key, "");
};

/** The draft key of a review comment: one per account, change, review slice and anchor. */
export const reviewDraftKey = (scope: ReviewDraftScope, anchor: string): string =>
  `review.${scope.userId}.${scope.changeId}.${scope.sliceId}.${anchor}`;

export interface ReviewDraftScope {
  /** The signed-in account; drafts written before it is known are kept under "unknown". */
  readonly userId: string;
  readonly changeId: string;
  readonly sliceId: string;
}

/** One draft, read as it changes, and its setter. */
export const useDraft = (key: string): readonly [string, (value: string) => void] => {
  const value = useSyncExternalStore(
    subscribe,
    () => readDraft(key),
    () => "",
  );
  return [value, (next) => writeDraft(key, next)];
};
