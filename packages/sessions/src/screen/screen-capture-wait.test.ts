import { makeScreensMemory, ScreensRepo } from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { SCREEN_LIMITS } from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer, Queue } from "effect";
import { expect } from "vitest";

import { ForwardAdapter } from "../forward.ts";
import { ScreenHost, ScreenStartError } from "./screen-host.ts";
import { ScreenWorkers } from "./screen-workers.ts";
import { Screens, ScreensLive, type ScreenCaller } from "./screens.ts";

const caller: ScreenCaller = {
  sessionId: SessionId.make("first"),
  accountId: "alice",
  agentProcess: { _tag: "Current", id: SessionProcessId.make("agent") },
  callKey: "act",
};
const world = Effect.gen(function* () {
  const repo = makeScreensMemory();
  const first = yield* repo.reserve({
    sessionId: caller.sessionId,
    workspaceId: SealantWorkspaceId.make("workspace"),
  });
  const second = yield* repo.reserve({
    sessionId: SessionId.make("second"),
    workspaceId: first.workspaceId,
  });
  const starts = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const layer = ScreensLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ScreensRepo, repo),
        Layer.mock(ScreenHost, {
          ownerOf: () => Effect.succeed("alice"),
          start: () =>
            Effect.gen(function* () {
              const proceed = yield* Deferred.make<void>();
              yield* Queue.offer(starts, proceed);
              yield* Deferred.await(proceed);
              return yield* new ScreenStartError({ message: "startup failed" });
            }),
        }),
        Layer.mock(ForwardAdapter, {}),
        Layer.mock(BlobStore, { identity: "unused:screen-wait" }),
        Layer.mock(ScreenWorkers, {}),
      ),
    ),
  );
  return { first, second, starts, layer };
});

it.effect("bounds a wait without cancelling an accepted act, and releases it after failure", () =>
  Effect.gen(function* () {
    const w = yield* world;
    yield* Effect.gen(function* () {
      const screens = yield* Screens;
      const acting = yield* Effect.forkScoped(
        screens.act(caller, { actions: [{ kind: "wait", ms: 1 }] }),
      );
      const proceed = yield* Queue.take(w.starts);
      const waiting = yield* Effect.forkScoped(screens.waitForActs(w.first.id));
      yield* TestClock.adjust(SCREEN_LIMITS.batchMs);
      expect(yield* Fiber.join(waiting)).toBe("timed_out");
      expect(acting.pollUnsafe()).toBeUndefined();
      expect(yield* screens.waitForActs(w.second.id)).toBe("idle");
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.await(acting);
      expect(yield* screens.waitForActs(w.first.id)).toBe("idle");
    }).pipe(Effect.provide(w.layer));
  }),
);

it.effect("waits for the accepted snapshot, excluding later calls on the same screen", () =>
  Effect.gen(function* () {
    const w = yield* world;
    yield* Effect.gen(function* () {
      const screens = yield* Screens;
      const first = yield* Effect.forkScoped(
        screens.act(caller, { actions: [{ kind: "wait", ms: 1 }] }),
      );
      const proceedFirst = yield* Queue.take(w.starts);
      const waiting = yield* Effect.forkScoped(screens.waitForActs(w.first.id));
      yield* Effect.yieldNow;
      const later = yield* Effect.forkScoped(
        screens.act({ ...caller, callKey: "later" }, { actions: [{ kind: "wait", ms: 1 }] }),
      );
      const proceedLater = yield* Queue.take(w.starts);
      yield* Deferred.succeed(proceedFirst, undefined);
      expect(yield* Fiber.join(waiting)).toBe("settled");
      yield* Fiber.await(first);
      expect(later.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(proceedLater, undefined);
      yield* Fiber.await(later);
      expect(yield* screens.waitForActs(w.first.id)).toBe("idle");
    }).pipe(Effect.provide(w.layer));
  }),
);
