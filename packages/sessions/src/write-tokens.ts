/**
 * The Mend tokens of one-off writes (a pasted image) in a person-layout executor (docs/adr/0016;
 * mend#615 review 2, findings 615-r2-2 and 615-r2-3).
 *
 * A person who has run nothing in the executor needs their own Mend token for the write's pickup.
 * Each write gets one of its own: minted when its identity ticket is redeemed, written to a file of
 * its own, and revoked, exactly that token, when that write ends, whatever else of the person's is
 * running or writing. A write that ends before its ticket is redeemed leaves a redemption still in
 * flight to revoke what it mints. A revocation that fails is tried again at once, then kept and
 * tried again every `sweepEvery` until it is done, so no token a write made outlives it unless the
 * store stays down.
 *
 * Nothing here holds a token longer than its write, or logs one.
 */

import { Duration, Effect, Exit } from "effect";

/** How long an ended write waits for a redemption that already took its ticket (the ticket TTL). */
const ENDED_KEPT_MS = 10 * 60_000;

export interface WriteTokens {
  /** A write's identity ticket (by its key): the token its redemption mints is that write's. */
  readonly track: (key: string) => void;
  /**
   * What a ticket's redemption minted. A write still running keeps it until it ends; one that
   * already ended has it revoked now. A ticket that is no write's is left alone.
   */
  readonly minted: (key: string, token: string) => Effect.Effect<void>;
  /**
   * The write ended, on any path: its token, once minted, is revoked; a redemption still in flight
   * revokes its own when it finishes.
   */
  readonly end: (key: string) => Effect.Effect<void>;
  /** How many tokens are waiting for a revocation that failed: retried until done. */
  readonly unrevoked: () => number;
}

export const makeWriteTokens = (deps: {
  /** Revokes exactly this token (`SessionChannelTokensRepo.revokeToken`). */
  readonly revoke: (token: string) => Effect.Effect<void>;
  /** Starts the retry of what could not be revoked, outliving the write that asked. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** Tries at once before a token waits for the sweep; 3 unless a test says. */
  readonly attempts?: number;
  readonly backoff?: Duration.Duration;
  readonly sweepEvery?: Duration.Duration;
}): WriteTokens => {
  const attempts = deps.attempts ?? 3;
  const backoff = deps.backoff ?? Duration.millis(100);
  const sweepEvery = deps.sweepEvery ?? Duration.seconds(30);
  const writes = new Map<string, { token: string | null; ended: boolean }>();
  const unrevoked = new Set<string>();
  let sweeping = false;

  /** One try; a failure or a defect alike reads as not revoked. */
  const tryRevoke = (token: string) =>
    deps.revoke(token).pipe(Effect.exit, Effect.map(Exit.isSuccess));

  const sweep: Effect.Effect<void> = Effect.gen(function* () {
    while (unrevoked.size > 0) {
      yield* Effect.sleep(sweepEvery);
      // Deleting the token a `for…of` over a Set is at is safe: the walk goes on to the next.
      for (const token of unrevoked) {
        if (yield* tryRevoke(token)) unrevoked.delete(token);
      }
    }
    sweeping = false;
  });

  const revokeReliably = (token: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (yield* tryRevoke(token)) return;
        if (attempt + 1 < attempts) {
          yield* Effect.sleep(Duration.times(backoff, 2 ** attempt));
        }
      }
      unrevoked.add(token);
      yield* Effect.logWarning(
        "session engine: a one-off write's Mend token could not be revoked; retried until it is",
      ).pipe(Effect.annotateLogs({ waiting: unrevoked.size }));
      if (!sweeping) {
        sweeping = true;
        yield* deps.fork(sweep);
      }
    });

  return {
    track: (key) => {
      writes.set(key, { token: null, ended: false });
    },
    minted: (key, token) =>
      Effect.suspend(() => {
        const write = writes.get(key);
        if (write === undefined) return Effect.void;
        if (!write.ended) {
          write.token = token;
          return Effect.void;
        }
        writes.delete(key);
        return revokeReliably(token);
      }),
    end: (key) =>
      Effect.suspend(() => {
        const write = writes.get(key);
        if (write === undefined || write.ended) return Effect.void;
        write.ended = true;
        const token = write.token;
        if (token === null) {
          // A redemption that already took the ticket may still mint: it finds the write ended.
          setTimeout(() => {
            if (writes.get(key) === write) writes.delete(key);
          }, ENDED_KEPT_MS).unref();
          return Effect.void;
        }
        writes.delete(key);
        return revokeReliably(token);
      }),
    unrevoked: () => unrevoked.size,
  };
};
