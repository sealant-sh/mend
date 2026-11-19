import type { SetupStepKey } from "./onboarding.ts";

/**
 * What this browser remembers about a person's setup, per account, that the server doesn't hold.
 *
 * The setup steps a person skipped that the server can't tell from what it holds: only Command
 * line. A computer that never signed in looks the same whether the person skipped the step or left
 * before finishing it, so this browser remembers the skip, per account (as the First project step
 * keeps its clone). Storage that can't be read or written counts as no skip.
 */

const keyOf = (userId: string): string => `mend-setup-skipped-command-line:${userId}`;

export const skippedCommandLine = (userId: string): boolean => {
  try {
    return localStorage.getItem(keyOf(userId)) === "1";
  } catch {
    return false;
  }
};

export const skipCommandLine = (userId: string): void => {
  try {
    localStorage.setItem(keyOf(userId), "1");
  } catch {
    // Not remembered: signing in again before Git access asks for the command line again.
  }
};

/**
 * The furthest setup step the person opened in this browser, so the steps beside the sheet keep
 * the steps after the current one as links when they go back to an earlier step. Storage that
 * can't be read counts as nothing reached beyond the page they are on.
 */
const reachedKeyOf = (userId: string): string => `mend-setup-reached:${userId}`;

export const reachedStep = (userId: string): string | null => {
  try {
    return localStorage.getItem(reachedKeyOf(userId));
  } catch {
    return null;
  }
};

/** Remembers `step` as reached, unless the person has already reached a later one. */
export const rememberReached = (
  userId: string,
  steps: ReadonlyArray<SetupStepKey>,
  step: SetupStepKey,
): void => {
  const stored = reachedStep(userId);
  const before = steps.findIndex((key) => key === stored);
  if (steps.indexOf(step) <= before) return;
  try {
    localStorage.setItem(reachedKeyOf(userId), step);
  } catch {
    // Not remembered: going back shows the steps after that page as not reached yet.
  }
};
