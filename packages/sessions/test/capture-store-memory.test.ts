import { CaptureStoreRepo } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

// Fixture fidelity only. The real PostgreSQL claim/register/heartbeat contract is exercised in
// packages/db/test/capture-store.test.ts, including the launch-bound lease scenario.
describe("memory capture-store fixture", () => {
  it.effect(
    "lease expiry follows the owning Clock while explicit store skew stays independent",
    () => {
      const world = makeMemoryCaptureStore();
      const worktree = WorktreeId.make("memory-clock-worktree");
      return Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(worktree);
        yield* repo.claim(worktree, "session-1", 30, "launch-1");
        expect((yield* repo.leaseOf(worktree))?.expiresAt).toEqual(new Date(30_000));
        yield* TestClock.adjust(29_999);
        expect((yield* repo.leaseOf(worktree))?.live).toBe(true);
        yield* TestClock.adjust(1);
        expect((yield* repo.leaseOf(worktree))?.live).toBe(false);

        world.clock.now = () => clock.currentTimeMillisUnsafe() + 60_000;
        yield* repo.claim(worktree, "session-1", 30, "launch-1");
        expect((yield* repo.leaseOf(worktree))?.expiresAt).toEqual(new Date(120_000));
        expect(yield* Clock.currentTimeMillis).toBe(30_000);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect(
    "rejects another launch's claim and heartbeat, while its own launch can reclaim and renew",
    () => {
      const world = makeMemoryCaptureStore();
      world.clock.now = () => 0;
      const worktree = WorktreeId.make("memory-lease-worktree");
      return Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(worktree);
        yield* repo.claim(worktree, "session-1", 0, "launch-new");
        const refused = yield* repo
          .claim(worktree, "session-1", 30, "launch-old")
          .pipe(Effect.flip);
        expect(refused._tag).toBe("WorktreeLeasedError");
        const claimed = yield* repo.claim(worktree, "session-1", 30, "launch-new");
        expect(claimed.epoch).toBe(2);
        expect(
          yield* repo.heartbeat(worktree, claimed.epoch, 30, {
            executorId: "session-1",
            launchId: "launch-old",
          }),
        ).toBe(false);
        expect(
          yield* repo.heartbeat(worktree, claimed.epoch, 30, {
            executorId: "session-1",
            launchId: "launch-new",
          }),
        ).toBe(true);
        expect((yield* repo.leaseOf(worktree))?.launchId).toBe("launch-new");
      }).pipe(Effect.provide(world.layer));
    },
  );
});
