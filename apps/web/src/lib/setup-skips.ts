/**
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
