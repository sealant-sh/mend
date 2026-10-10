/**
 * The Mend tokens of one-off writes (a pasted image) in a person-layout executor (docs/adr/0016;
 * mend#615 reviews 2 and 3).
 *
 * Each write gets a token of its own (`SessionChannelTokensRepo.issueWrite`): minted when its
 * ticket is redeemed, and only while that write is still open; accepted for its pickups alone; and
 * revoked, exactly that token, when the write ends, on any path. Nothing that revokes a person's
 * tokens in bulk reaches it, and the store refuses it `WRITE_TOKEN_TTL_MS` after it was issued
 * whatever happens here, so a revocation this process loses (the store down, a restart) is bounded
 * by design rather than by this bookkeeping.
 *
 * - `track` opens a write; `beginMint` lets its redemption mint only while it is open (a
 *   redemption that comes after its write ended is refused, and mints nothing);
 * - `minted` hands the token to the write, or revokes it at once when the write ended meanwhile;
 *   `mintFailed` says a mint did not happen;
 * - `end` closes the write and revokes its token. A write whose mint is in flight is kept until
 *   that mint settles, however long it takes: no timer forgets it.
 *
 * A revocation that fails is tried again at once, then kept and swept until it succeeds or the
 * token has lapsed in the store anyway; what is kept is bounded by `WRITE_TOKEN_TTL_MS` and by
 * `maxPending` (the oldest lapse first, and lapse regardless). Nothing here logs a token.
 */

import { Duration, Effect, Exit } from "effect";

export interface WriteTokens {
  /** A write's ticket (by its key) opens. */
  readonly track: (key: string) => void;
  /** Whether its redemption may mint now: only while the write is open. */
  readonly beginMint: (key: string) => boolean;
  /** What the redemption minted: the write's, or revoked now if it ended meanwhile. */
  readonly minted: (key: string, token: string) => Effect.Effect<void>;
  /** The redemption minted nothing (it failed). */
  readonly mintFailed: (key: string) => void;
  /** The write ended, on any path: its token, once minted, is revoked. */
  readonly end: (key: string) => Effect.Effect<void>;
  /** How many tokens wait for a revocation that failed, until they lapse in the store. */
  readonly unrevoked: () => number;
  /** How many writes are open or waiting for their mint to settle. */
  readonly open: () => number;
}

export const makeWriteTokens = (deps: {
  /** Revokes exactly this token (`SessionChannelTokensRepo.revokeToken`). */
  readonly revoke: (token: string) => Effect.Effect<void>;
  /** Starts the sweep of what could not be revoked, outliving the write that asked. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** How long the store accepts a write's token after it is issued (`WRITE_TOKEN_TTL_MS`). */
  readonly ttl: Duration.Duration;
  /** Tries at once before a token waits for the sweep; 3 unless a test says. */
  readonly attempts?: number;
  readonly backoff?: Duration.Duration;
  readonly sweepEvery?: Duration.Duration;
  /** The most tokens kept for the sweep; 1000 unless a test says. */
  readonly maxPending?: number;
  /** Now, in milliseconds; `Date.now` unless a test says. */
  readonly now?: () => number;
}): WriteTokens => {
  const attempts = deps.attempts ?? 3;
  const backoff = deps.backoff ?? Duration.millis(100);
  const sweepEvery = deps.sweepEvery ?? Duration.seconds(30);
  const maxPending = deps.maxPending ?? 1000;
  const now = deps.now ?? Date.now;
  const ttlMs = Duration.toMillis(deps.ttl);
  const writes = new Map<
    string,
    { token: string | null; ended: boolean; minting: boolean; mintedAt: number }
  >();
  /** Token → when the store stops accepting it anyway. In insertion order: oldest first. */
  const pending = new Map<string, number>();
  let sweeping = false;

  /** One try; a failure or a defect alike reads as not revoked. */
  const tryRevoke = (token: string) =>
    deps.revoke(token).pipe(Effect.exit, Effect.map(Exit.isSuccess));

  /** Lapsed tokens need nothing more; past the cap, the oldest go first (they lapse first). */
  const prune = () => {
    const at = now();
    for (const [token, lapses] of pending) if (lapses <= at) pending.delete(token);
    for (const token of pending.keys()) {
      if (pending.size <= maxPending) break;
      pending.delete(token);
    }
  };

  const sweep: Effect.Effect<void> = Effect.gen(function* () {
    while (pending.size > 0) {
      yield* Effect.sleep(sweepEvery);
      prune();
      for (const token of pending.keys()) {
        if (yield* tryRevoke(token)) pending.delete(token);
      }
    }
    sweeping = false;
  });

  const revokeReliably = (token: string, mintedAt: number) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (yield* tryRevoke(token)) return;
        if (attempt + 1 < attempts) {
          yield* Effect.sleep(Duration.times(backoff, 2 ** attempt));
        }
      }
      pending.set(token, mintedAt + ttlMs);
      prune();
      yield* Effect.logWarning(
        "session engine: a one-off write's Mend token could not be revoked now; retried until it lapses",
      ).pipe(Effect.annotateLogs({ waiting: pending.size }));
      if (!sweeping && pending.size > 0) {
        sweeping = true;
        yield* deps.fork(sweep);
      }
    });

  return {
    track: (key) => {
      writes.set(key, { token: null, ended: false, minting: false, mintedAt: 0 });
    },
    beginMint: (key) => {
      const write = writes.get(key);
      if (write === undefined || write.ended || write.minting || write.token !== null) return false;
      write.minting = true;
      return true;
    },
    minted: (key, token) =>
      Effect.suspend(() => {
        const write = writes.get(key);
        const mintedAt = now();
        if (write === undefined) return revokeReliably(token, mintedAt);
        write.minting = false;
        write.mintedAt = mintedAt;
        if (!write.ended) {
          write.token = token;
          return Effect.void;
        }
        writes.delete(key);
        return revokeReliably(token, mintedAt);
      }),
    mintFailed: (key) => {
      const write = writes.get(key);
      if (write === undefined) return;
      write.minting = false;
      if (write.ended) writes.delete(key);
    },
    end: (key) =>
      Effect.suspend(() => {
        const write = writes.get(key);
        if (write === undefined || write.ended) return Effect.void;
        write.ended = true;
        // A mint in flight settles into `minted` or `mintFailed`, which finish what this began.
        if (write.minting) return Effect.void;
        writes.delete(key);
        return write.token === null ? Effect.void : revokeReliably(write.token, write.mintedAt);
      }),
    unrevoked: () => pending.size,
    open: () => writes.size,
  };
};
