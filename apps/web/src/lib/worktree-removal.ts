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
