import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeHeadPeopleCheck } from "./head-people.ts";

/**
 * The check a launch of a worktree with no layout makes under `MEND_HARNESS_LAYOUT=person`
 * (review of mend#582, finding 6): a worktree that falls back to shared reads its head's manifest
 * and the dir packs under `harness/people/` once per head, not once per launch.
 */
/** A store whose every blob read (a manifest, then two dir packs) takes `latencyMs`. */
const storeOf = (latencyMs: number, people: boolean) => {
  const reads = { db: 0, blobs: 0 };
  let head = { key: "manifests/1", n: 1 };
  const check = makeHeadPeopleCheck({
    head: (_worktreeId: string) => Effect.sync(() => (reads.db++, head)),
    holdsPeople: () =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          reads.blobs++;
          if (latencyMs > 0) yield* Effect.sleep(`${latencyMs} millis`);
        }
        return people;
      }),
  });
  return {
    reads,
    check,
    advance: () => (head = { key: `manifests/${head.n + 1}`, n: head.n + 1 }),
  };
};

describe("whether a worktree's head holds people", () => {
  it("reads a fallback worktree's head once, then no blob at all at that head", async () => {
    const store = storeOf(0, false);
    for (let launch = 0; launch < 5; launch++) {
      expect(await Effect.runPromise(store.check("wt-1"))).toBe(false);
    }
    expect(store.reads).toEqual({ db: 5, blobs: 3 });
    // A new capture is read again.
    store.advance();
    expect(await Effect.runPromise(store.check("wt-1"))).toBe(false);
    expect(store.reads).toEqual({ db: 6, blobs: 6 });
  });

  it("never remembers a yes", async () => {
    const store = storeOf(0, true);
    expect(await Effect.runPromise(store.check("wt-1"))).toBe(true);
    expect(await Effect.runPromise(store.check("wt-1"))).toBe(true);
    expect(store.reads.blobs).toBe(6);
  });

  it("reads nothing at capture 0, and an unreadable head is a no it does not keep", async () => {
    let reads = 0;
    const base = makeHeadPeopleCheck({
      head: (_worktreeId: string) => Effect.succeed({ key: "m/0", n: 0 }),
      holdsPeople: () => Effect.sync(() => (reads++, true)),
    });
    expect(await Effect.runPromise(base("wt-1"))).toBe(false);
    expect(reads).toBe(0);
    const failing = makeHeadPeopleCheck({
      head: (_worktreeId: string) => Effect.succeed({ key: "m/1", n: 1 }),
      holdsPeople: () => Effect.sync(() => reads++).pipe(Effect.andThen(Effect.fail("503"))),
    });
    expect(await Effect.runPromise(failing("wt-1"))).toBe(false);
    expect(await Effect.runPromise(failing("wt-1"))).toBe(false);
    expect(reads).toBe(2);
  });

  it("takes a later launch's check from about three blob reads to none (timed)", async () => {
    // 30 ms a read: Garage on the box answers in about that, remote S3 slower.
    const store = storeOf(30, false);
    const time = async () => {
      const started = performance.now();
      await Effect.runPromise(store.check("wt-1"));
      return performance.now() - started;
    };
    const first = await time();
    const later = await time();
    expect(first).toBeGreaterThanOrEqual(85);
    expect(later).toBeLessThan(10);
  });
});
