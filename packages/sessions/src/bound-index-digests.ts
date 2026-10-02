/**
 * The SHA-256 every bytes-bound upload URL of a key whose name does not say its digest (a pack
 * index, `packs/<sha>.idx`) was signed for, and until when one of them could still be used by
 * the bucket's clock (ADR 0002 decision 48). One registry per process, shared by the channel
 * that reserves (`upload.urls`) and the seals that check (`sealStandingOf`): a seal never stands
 * over an index that a live URL bound to other bytes could replace. Mend serves the channel from
 * one process (the engine holds live state; Helm pins one replica). A process before this one is
 * covered by the startup window the seals wait out.
 */

interface Binding {
  readonly sha256: string;
  readonly until: number;
}

const bindings = new Map<string, Binding>();

/** How many keys the registry holds at most; past it, a pack index is not bound. */
export const BOUND_INDEX_KEYS_REMEMBERED = 200_000;

/** The live binding of `key`, if any. */
export const boundIndexDigest = (key: string, now: number): Binding | null => {
  const binding = bindings.get(key);
  return binding !== undefined && binding.until > now ? binding : null;
};

/**
 * Reserve `key` for `sha256` until `until`, in one synchronous step: refused (`conflict`) while a
 * live binding names other bytes, `full` when no room is left once dead entries go. A binding for
 * the same bytes is extended, never shortened. `fresh` says no live binding was there before: one
 * the caller may give back (`releaseBoundIndex`) if it hands out no URL after all.
 */
export const reserveBoundIndex = (
  key: string,
  sha256: string,
  now: number,
  until: number,
):
  | { readonly outcome: "reserved"; readonly fresh: boolean }
  | { readonly outcome: "conflict" | "full" } => {
  const live = boundIndexDigest(key, now);
  if (live !== null && live.sha256 !== sha256) return { outcome: "conflict" };
  if (live === null && bindings.size >= BOUND_INDEX_KEYS_REMEMBERED) {
    for (const [known, binding] of bindings) if (binding.until <= now) bindings.delete(known);
    if (bindings.size >= BOUND_INDEX_KEYS_REMEMBERED) return { outcome: "full" };
  }
  bindings.set(key, { sha256, until: Math.max(until, live?.until ?? 0) });
  return { outcome: "reserved", fresh: live === null };
};

/**
 * Give back a fresh reservation no URL was handed out for: only while it is still exactly the
 * one the caller made (same bytes, not extended since).
 */
export const releaseBoundIndex = (key: string, sha256: string, until: number): void => {
  const binding = bindings.get(key);
  if (binding !== undefined && binding.sha256 === sha256 && binding.until === until) {
    bindings.delete(key);
  }
};

/** Extend `key`'s binding to `until` (after signing: a URL is good from when it was signed). */
export const extendBoundIndex = (key: string, sha256: string, until: number): void => {
  const binding = bindings.get(key);
  if (binding !== undefined && binding.sha256 === sha256 && binding.until < until) {
    bindings.set(key, { sha256, until });
  }
};
