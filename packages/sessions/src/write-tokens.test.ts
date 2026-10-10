import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeWriteTokens } from "./write-tokens.ts";

/** A tracker over a revocation log, failing as many times as the test says, on a clock it sets. */
const tracker = (options: { readonly fails?: number; readonly maxPending?: number } = {}) => {
  const revoked: Array<string> = [];
  const forks: Array<Effect.Effect<void>> = [];
  let fails = options.fails ?? 0;
  let clock = 1_000;
  const tokens = makeWriteTokens({
    revoke: (token) =>
      Effect.suspend(() => {
        if (fails > 0) {
          fails--;
          return Effect.die("the store is down");
        }
        revoked.push(token);
        return Effect.void;
      }),
    fork: (effect) => Effect.sync(() => void forks.push(effect)),
    ttl: Duration.minutes(15),
    backoff: Duration.millis(1),
    sweepEvery: Duration.millis(1),
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    now: () => clock,
  });
  return {
    tokens,
    revoked,
    forks,
    advance: (ms: number) => {
      clock += ms;
    },
    recover: () => {
      fails = 0;
    },
  };
};

describe("one-off write tokens (mend#615 reviews 2 and 3)", () => {
  it("mints only while its write is open, once, and revokes exactly its own token when it ends", async () => {
    const t = tracker();
    t.tokens.track("a");
    t.tokens.track("b");
    expect(t.tokens.beginMint("a")).toBe(true);
    // One mint per write: a second redemption mints nothing.
    expect(t.tokens.beginMint("a")).toBe(false);
    await Effect.runPromise(t.tokens.minted("a", "token-a"));
    expect(t.tokens.beginMint("b")).toBe(true);
    await Effect.runPromise(t.tokens.minted("b", "token-b"));
    await Effect.runPromise(t.tokens.end("a"));
    expect(t.revoked).toEqual(["token-a"]);
    await Effect.runPromise(t.tokens.end("b"));
    expect(t.revoked).toEqual(["token-a", "token-b"]);
    expect(t.tokens.open()).toBe(0);
  });

  it("refuses a redemption that comes after its write ended, however late: nothing is minted (615-r3-4)", async () => {
    const t = tracker();
    t.tokens.track("a");
    await Effect.runPromise(t.tokens.end("a"));
    t.advance(60 * 60_000);
    expect(t.tokens.beginMint("a")).toBe(false);
    // A ticket no write tracks never mints either.
    expect(t.tokens.beginMint("never-tracked")).toBe(false);
    expect(t.tokens.open()).toBe(0);
  });

  it("keeps a write whose mint is in flight past its end, however long, and revokes what it mints", async () => {
    const t = tracker();
    t.tokens.track("a");
    expect(t.tokens.beginMint("a")).toBe(true);
    await Effect.runPromise(t.tokens.end("a"));
    expect(t.tokens.open()).toBe(1);
    // No timer forgets it: an hour later the mint settles, and its token goes at once.
    t.advance(60 * 60_000);
    await Effect.runPromise(t.tokens.minted("a", "token-late"));
    expect(t.revoked).toEqual(["token-late"]);
    expect(t.tokens.open()).toBe(0);
  });

  it("forgets a write whose mint failed after its end, and revokes nothing", async () => {
    const t = tracker();
    t.tokens.track("a");
    expect(t.tokens.beginMint("a")).toBe(true);
    await Effect.runPromise(t.tokens.end("a"));
    t.tokens.mintFailed("a");
    expect(t.tokens.open()).toBe(0);
    expect(t.revoked).toEqual([]);
  });

  it("retries a failed revocation, then sweeps it until the store answers", async () => {
    const t = tracker({ fails: 4 });
    t.tokens.track("a");
    t.tokens.beginMint("a");
    await Effect.runPromise(t.tokens.minted("a", "token-a"));
    await Effect.runPromise(t.tokens.end("a"));
    // Three tries at once failed: kept, and the sweep started.
    expect(t.revoked).toEqual([]);
    expect(t.tokens.unrevoked()).toBe(1);
    expect(t.forks).toHaveLength(1);
    t.recover();
    const [sweep] = t.forks;
    if (sweep !== undefined) await Effect.runPromise(sweep);
    expect(t.revoked).toEqual(["token-a"]);
    expect(t.tokens.unrevoked()).toBe(0);
  });

  it("keeps what it cannot revoke only until the store lets it lapse, and no more than its cap (615-r3-3)", async () => {
    const t = tracker({ fails: Number.POSITIVE_INFINITY, maxPending: 2 });
    for (const key of ["a", "b", "c"]) {
      t.tokens.track(key);
      t.tokens.beginMint(key);
      await Effect.runPromise(t.tokens.minted(key, `token-${key}`));
      await Effect.runPromise(t.tokens.end(key));
    }
    // Past the cap the oldest goes: it lapses first, in the store, whatever happens here.
    expect(t.tokens.unrevoked()).toBe(2);
    // Once their time is up in the store, nothing is left to revoke.
    t.advance(15 * 60_000);
    const [sweep] = t.forks;
    if (sweep !== undefined) await Effect.runPromise(sweep);
    expect(t.tokens.unrevoked()).toBe(0);
    expect(t.revoked).toEqual([]);
  });
});
