import { type WorktreeRemovalRefusal, worktreeRemovalRefusalOf } from "@mend/domain/workbench";

import { failureWords, refusalTagOf } from "#/lib/refusal";

/**
 * A worktree removal the store refused, read from the failure the web tier hands back: only a
 * `StoreFailure` (its tag beside the words, `refusalTagOf`) carries words a person acts on.
 * Anything else, a live conversation or a transport failure, is not a refusal to show here.
 */
export const removalRefusalOf = (cause: unknown): WorktreeRemovalRefusal | null => {
  if (refusalTagOf(cause) !== "StoreFailure") return null;
  const words = failureWords(cause, "");
  return words === "" ? null : worktreeRemovalRefusalOf(words);
};

/** A refusal force never lifts, in the reader's words. */
const notLifted = (words: string): WorktreeRemovalRefusal => ({
  words,
  forceable: false,
  unlanded: null,
});

/**
 * What the second step says when the forced removal itself failed. A `StoreFailure` is the
 * server's words, offered again only when force lifts them. Another contract failure is a refusal
 * force never lifts, said plainly. A transport failure left the removal unknown, so trying again
 * stays offered.
 */
export const forcedRemovalFailureOf = (cause: unknown): WorktreeRemovalRefusal => {
  const refusal = removalRefusalOf(cause);
  if (refusal !== null) return refusal;
  const raw = failureWords(cause, "");
  const tag = refusalTagOf(cause);
  if (tag === "WorktreeActive")
    return notLifted("A session in this worktree is live. Stop it first.");
  if (tag === "WorktreeNotFound") return notLifted("This worktree is no longer in the store.");
  if (tag !== null) return notLifted(raw === "" ? "The worktree was not removed." : raw);
  return {
    words:
      raw === ""
        ? "The worktree was not removed. Try again."
        : `The worktree was not removed · ${raw.replace(/\.$/, "")}. Try again.`,
    forceable: true,
    unlanded: null,
  };
};

/** What Clear settled says about the worktrees the store refused to remove, if any. */
export const keptNote = (kept: number): string | null =>
  kept === 0
    ? null
    : kept === 1
      ? "1 kept · removal refused · remove it from its menu to see why"
      : `${kept} kept · removal refused · remove one from its menu to see why`;
