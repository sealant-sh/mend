import { useSyncExternalStore } from "react";

/**
 * The one store of words a person is writing and has not sent: the session composer's message
 * and its send key, review comments, and the Land description. They live in sessionStorage per
 * account, so a tab switch, a layout change or a reload never loses them, and every one goes at
 * sign-out (`dropAllDrafts`). Keys name what they hold; this prefix is added here.
 */
const PREFIX = "mend.message.";

const listeners = new Set<() => void>();

/** Hear every change to any draft. */
export const subscribeDrafts = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const notify = () => {
  for (const listener of listeners) listener();
};

/** One draft as it is stored now; "" when there is none. */
export const readDraft = (key: string): string => {
  try {
    return sessionStorage.getItem(`${PREFIX}${key}`) ?? "";
  } catch {
    return "";
  }
};

/** Store (or, with "", drop) one draft; false when the browser refused it. */
const store = (key: string, value: string): boolean => {
  try {
    if (value === "") sessionStorage.removeItem(`${PREFIX}${key}`);
    else sessionStorage.setItem(`${PREFIX}${key}`, value);
    return true;
  } catch {
    // Private browsing or a full quota: the words stay on screen until the editor closes.
    return false;
  }
};

/**
 * Store (or, with "", drop) several drafts at once, then tell every reader once. False when the
 * browser refused any of them (a full quota): a caller that must not lose what it wrote keeps it
 * elsewhere.
 */
export const writeDrafts = (
  entries: ReadonlyArray<readonly [key: string, value: string]>,
): boolean => {
  let stored = true;
  for (const [key, value] of entries) stored = store(key, value) && stored;
  notify();
  return stored;
};

/** The keys of every draft stored now (without the store's prefix). */
export const draftKeys = (): ReadonlyArray<string> => {
  try {
    return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => key?.startsWith(PREFIX) === true)
      .map((key) => key.slice(PREFIX.length));
  } catch {
    return [];
  }
};

/** Store (or, with "", drop) one draft and tell every reader; false when the browser refused it. */
export const writeDraft = (key: string, value: string): boolean => writeDrafts([[key, value]]);

/** Every draft of every account goes: run at sign-out, here or in another tab. */
export const dropAllDrafts = () => {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    );
    for (const key of keys) if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch {
    // Nothing stored that can be read is nothing to drop.
  }
  notify();
};

/**
 * Clear a draft once what it held was sent, unless it was edited while the send was out: the
 * edited words are still unsent.
 */
export const clearSentDraft = (key: string, sent: string) => {
  if (readDraft(key).trim() === sent.trim()) writeDraft(key, "");
};

export interface ReviewDraftScope {
  /** The signed-in account; drafts written before it is known are kept under "unknown". */
  readonly userId: string;
  readonly changeId: string;
  readonly sliceId: string;
}

/** The draft key of a review comment: one per account, change, review slice and anchor. */
export const reviewDraftKey = (scope: ReviewDraftScope, anchor: string): string =>
  `review.${scope.userId}.${scope.changeId}.${scope.sliceId}.${anchor}`;

/** One draft, read as it changes, and its setter. */
export const useDraft = (key: string): readonly [string, (value: string) => void] => {
  const value = useSyncExternalStore(
    subscribeDrafts,
    () => readDraft(key),
    () => "",
  );
  return [value, (next) => writeDraft(key, next)];
};
