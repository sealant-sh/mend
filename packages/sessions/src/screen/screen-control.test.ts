import { ScreensRepo, makeScreensMemory } from "@mend/db";
import { type ScreenId, SealantWorkspaceId, SessionId, ViewerConnectionId } from "@mend/domain";
import type { ScreenInput } from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { TestClock, it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";

import type { Hand } from "./hand.ts";
import type { Hands } from "./hands.ts";
import { makeScreenControl } from "./screen-control.ts";
import { ScreenHost } from "./screen-host.ts";

const OWNER = "alice";
const CONNECTION = ViewerConnectionId.make("viewer-1");

/** A hand whose look waits for the test while `held` is set. */
const handOf = (held: {
  gate: { reached: Deferred.Deferred<void>; go: Deferred.Deferred<void> } | null;
}) => {
  const hand: Hand = {
    act: () => Effect.die("no batch in these tests"),
    look: Effect.gen(function* () {
      const gate = held.gate;
      if (gate !== null) {
        held.gate = null;
        yield* Deferred.succeed(gate.reached, undefined);
        yield* Deferred.await(gate.go);
      }
      return Uint8Array.of(1, 2, 3);
    }),
    relay: () => Effect.void,
    paste: () => Effect.succeed(true),
    release: Effect.void,
    ended: Effect.never,
  };
  return hand;
};

const controlOver = (repo: ScreensRepo["Service"], hands: Hands) =>
  makeScreenControl(hands).pipe(
    Effect.provideService(ScreensRepo, repo),
    Effect.provide(Layer.mock(ScreenHost)({ ownerOf: () => Effect.succeed(OWNER) })),
    Effect.provide(
      Layer.mock(BlobStore)({
        identity: "screen-control-test",
        put: () => Effect.succeed({ written: true }),
      }),
    ),
  );

/** The row once the decisions forked off by a timer have run, without any real time passing. */
const settledInput = (repo: ScreensRepo["Service"], id: ScreenId, until: ScreenInput["_tag"]) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100; turn++) {
      const input = (yield* repo.byId(id))?.input;
      if (input?._tag === until) return input;
      yield* Effect.yieldNow;
    }
    return (yield* repo.byId(id))?.input;
  });

it.effect("keeps a renewed holder when the lease that expired is still taking its frame", () =>
  Effect.gen(function* () {
    const repo = makeScreensMemory();
    const sessionId = SessionId.make("s-renewed");
    const screen = yield* repo.reserve({
      sessionId,
      workspaceId: SealantWorkspaceId.make("ws-renewed"),
    });
    const held: Parameters<typeof handOf>[0] = { gate: null };
    const hand = handOf(held);
    const control = yield* controlOver(repo, { of: () => Effect.succeed(hand), open: () => hand });
    yield* control.take(sessionId, OWNER, CONNECTION);
    expect((yield* repo.byId(screen.id))?.input._tag).toBe("Person");
    const gate = { reached: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() };
    held.gate = gate;
    yield* TestClock.adjust("10 seconds");
    yield* Deferred.await(gate.reached);
    expect(yield* control.heartbeat(sessionId, CONNECTION)).toBe(true);
    yield* Deferred.succeed(gate.go, undefined);
    expect(yield* settledInput(repo, screen.id, "Paused")).toMatchObject({ _tag: "Person" });
    yield* TestClock.adjust("10 seconds");
    expect(yield* settledInput(repo, screen.id, "Paused")).toMatchObject({
      _tag: "Paused",
      reason: "lease-lapsed",
    });
  }),
);

it.effect("keeps the Paused timeout when a heartbeat read the holder before it lapsed", () =>
  Effect.gen(function* () {
    const stored = makeScreensMemory();
    const sessionId = SessionId.make("s-stale-heartbeat");
    const screen = yield* stored.reserve({
      sessionId,
      workspaceId: SealantWorkspaceId.make("ws-stale-heartbeat"),
    });
    const read = { reached: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() };
    let holdNextRead = false;
    const repo: ScreensRepo["Service"] = {
      ...stored,
      ofSession: (id) =>
        Effect.gen(function* () {
          const snapshot = yield* stored.ofSession(id);
          if (holdNextRead) {
            holdNextRead = false;
            yield* Deferred.succeed(read.reached, undefined);
            yield* Deferred.await(read.go);
          }
          return snapshot;
        }),
    };
    const hand = handOf({ gate: null });
    const control = yield* controlOver(repo, { of: () => Effect.succeed(hand), open: () => hand });
    yield* control.take(sessionId, OWNER, CONNECTION);
    holdNextRead = true;
    const heartbeat = yield* Effect.forkChild(control.heartbeat(sessionId, CONNECTION));
    yield* Deferred.await(read.reached);
    yield* control.lapse(sessionId, CONNECTION, "disconnected");
    expect((yield* repo.byId(screen.id))?.input._tag).toBe("Paused");
    yield* Deferred.succeed(read.go, undefined);
    const renewed = yield* Fiber.join(heartbeat);
    yield* TestClock.adjust("2 minutes");
    expect(yield* settledInput(repo, screen.id, "AwaitingAgent")).toMatchObject({
      _tag: "AwaitingAgent",
    });
    expect(renewed).toBe(false);
  }),
);

it.effect(
  "leaves a take over unacknowledged when its hand ended before the fence, never Person",
  () =>
    Effect.gen(function* () {
      const repo = makeScreensMemory();
      const sessionId = SessionId.make("s-hand-gone");
      const screen = yield* repo.reserve({
        sessionId,
        workspaceId: SealantWorkspaceId.make("ws-hand-gone"),
      });
      let ended = false;
      const hand: Hand = {
        ...handOf({ gate: null }),
        release: Effect.sync(() => {
          ended = true;
        }),
      };
      const control = yield* controlOver(repo, {
        of: () => Effect.succeed(ended ? null : hand),
        open: () => (ended ? null : hand),
      });
      const answer = yield* control.take(sessionId, OWNER, CONNECTION);
      expect(answer).toMatchObject({ _tag: "Changed", next: { _tag: "Fencing" } });
      expect((yield* repo.byId(screen.id))?.input._tag).toBe("Fencing");
      expect((yield* repo.log(screen.id)).map((entry) => entry.body._tag)).not.toContain("Taken");
      expect(yield* control.take(sessionId, OWNER, ViewerConnectionId.make("viewer-2"))).toEqual({
        _tag: "NoHand",
      });
    }),
);
