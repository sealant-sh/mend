import { type WorktreeRemovalRefusal, worktreeRemovalRefusalOf } from "@mend/domain/workbench";

/**
 * A worktree removal the store refused, read from the failure the web tier hands back. The tier
 * prefixes a contract failure with its tag (server/api/errors.ts); the words after it are the
 * server's own, and only a `StoreFailure` carries words a person acts on. Anything else, a live
 * conversation or a transport failure, is not a refusal to show here.
 */
export const removalRefusalOf = (cause: unknown): WorktreeRemovalRefusal | null => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const prefix = "StoreFailure: ";
  if (!raw.startsWith(prefix)) return null;
  const words = raw.slice(prefix.length);
  return words === "" ? null : worktreeRemovalRefusalOf(words);
};

/** The contract tag the web tier framed a failure with, or null for a transport failure. */
const tagOf = (raw: string): string | null => {
  const match = /^([A-Z][A-Za-z]+)(?::\s|$)/.exec(raw);
  return match?.[1] ?? null;
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
  const raw = cause instanceof Error ? cause.message : String(cause);
  const tag = tagOf(raw);
  if (tag === "WorktreeActive")
    return notLifted("A session in this worktree is live. Stop it first.");
  if (tag === "WorktreeNotFound") return notLifted("This worktree is no longer in the store.");
  if (tag !== null) return notLifted(raw);
  return {
    words:
      raw === ""
        ? "The worktree was not removed. Try again."
        : `The worktree was not removed · ${raw}. Try again.`,
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
