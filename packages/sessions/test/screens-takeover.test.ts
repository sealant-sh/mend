import { ScreensRepo } from "@mend/db";
import { ViewerConnectionId } from "@mend/domain";
import type { ScreenInputEvent } from "@mend/domain/workbench";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Effect, Fiber } from "effect";
import { describe, expect } from "vitest";

import { Screens } from "../src/screen/screens.ts";
import { eventually, OWNER } from "./screen-world.ts";
import {
  agentOf,
  answered,
  asProcess,
  CONNECTION,
  logOf,
  movedTo,
  postgres,
  rowOf,
  sessionWithScreen,
  useXvnc,
} from "./screens-fixture.ts";
import { dockerReady } from "./xvnc.ts";

describe.skipIf(postgres.skip)("people's input on a screen with no hand", () => {
  it.live("refuses a take over with no hand for the input, and never reports Person", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const { sessionId, screen } = yield* sessionWithScreen;
        expect(yield* screens.take(sessionId, "bob", CONNECTION)).toEqual({
          _tag: "Refused",
          why: "owner-only",
        });
        expect(yield* screens.take(sessionId, OWNER, CONNECTION)).toEqual({ _tag: "NoHand" });
        expect((yield* rowOf(screen.id)).input).toEqual(screen.input);
        expect(
          yield* screens.input(sessionId, CONNECTION, [
            { _tag: "Pointer", buttons: 0, x: 1, y: 1 },
          ]),
        ).toBe(false);
        expect((yield* logOf(screen.id)).map((entry) => entry.body._tag)).not.toContain("Taken");
      }),
    ),
  );

  /** The row as a take over left it: the timers below run on the row alone, with no hand. */
  const takenByPerson = Effect.gen(function* () {
    const screens = yield* Screens;
    const repo = yield* ScreensRepo;
    const { sessionId, screen } = yield* sessionWithScreen;
    const take: ScreenInputEvent = { _tag: "Take", by: OWNER, connection: CONNECTION };
    const fencing = yield* repo.control(screen.id, take, OWNER);
    if (fencing._tag !== "Changed") throw new Error("the take over was not taken");
    yield* repo.control(screen.id, { _tag: "Fenced", epoch: fencing.next.epoch }, OWNER);
    expect((yield* rowOf(screen.id)).input).toMatchObject({
      _tag: "Person",
      connection: CONNECTION,
    });
    return { screens, sessionId, screen };
  });

  it.effect("hands a paused screen back to the agent once two minutes pass", () =>
    asProcess(
      Effect.gen(function* () {
        const { screens, sessionId, screen } = yield* takenByPerson;
        yield* screens.lapse(sessionId, CONNECTION, "disconnected");
        expect((yield* rowOf(screen.id)).input).toMatchObject({
          _tag: "Paused",
          reason: "disconnected",
        });
        yield* TestClock.adjust("119 seconds");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Paused");
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        for (let turn = 0; (yield* rowOf(screen.id)).input._tag === "Paused"; turn++) {
          if (turn > 100) throw new Error("never handed back");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        }
        expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
        const last = (yield* logOf(screen.id)).at(-1);
        expect([last?.actor, last?.body._tag]).toEqual([{ _tag: "Mend" }, "HandedBack"]);
      }),
    ),
  );

  it.effect("keeps the holder while heartbeats come, and pauses once one is ten seconds late", () =>
    asProcess(
      Effect.gen(function* () {
        const { screens, sessionId, screen } = yield* takenByPerson;
        yield* TestClock.adjust("8 seconds");
        expect(yield* screens.heartbeat(sessionId, CONNECTION)).toBe(true);
        expect(yield* screens.heartbeat(sessionId, ViewerConnectionId.make("other"))).toBe(false);
        yield* TestClock.adjust("8 seconds");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Person");
        yield* TestClock.adjust("3 seconds");
        for (let turn = 0; (yield* rowOf(screen.id)).input._tag === "Person"; turn++) {
          if (turn > 100) throw new Error("never paused");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        }
        expect((yield* rowOf(screen.id)).input).toMatchObject({
          _tag: "Paused",
          reason: "lease-lapsed",
        });
      }),
    ),
  );
});

describe.skipIf(postgres.skip || !dockerReady)("the Screens service, against TigerVNC Xvnc", () => {
  const { keysDown, pointer } = useXvnc();

  it.live(
    "stops a batch at a take, holds no key after it, and makes the agent look first once handed back",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const running = yield* Effect.forkChild(
            screens.act(agent.call(), {
              actions: [
                { kind: "type", text: "a".repeat(400) },
                { kind: "wait", ms: 3_000 },
                movedTo({ x: 700, y: 700 }),
              ],
            }),
          );
          yield* Effect.sleep("200 millis");
          yield* screens.take(sessionId, OWNER, CONNECTION);
          const batch = answered(yield* Fiber.join(running));
          expect(batch.outcome).toBe("interrupted");
          expect(batch.actions.map((note) => note.result).at(-1)).toBe("skipped: taken over");
          expect(keysDown()).toBe(0);
          expect(pointer()).not.toEqual([700, 700]);
          expect((yield* rowOf(screen.id)).input).toMatchObject({
            _tag: "Person",
            connection: CONNECTION,
          });
          expect(yield* screens.look(agent.call())).toEqual({ _tag: "Refused", refusal: "held" });

          yield* screens.handBack(sessionId, OWNER);
          expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
          expect(yield* screens.act(agent.call(), { actions: [movedTo({ x: 1, y: 1 })] })).toEqual({
            _tag: "Refused",
            refusal: "look_first",
          });
          const looked = answered(yield* screens.look(agent.call()));
          expect(looked.sinceLastLook.map((entry) => entry.body._tag)).toEqual([
            "Taken",
            "HandedBack",
          ]);
          for (const entry of looked.sinceLastLook) expect(entry.frame).not.toBeNull();
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "pauses a holder whose heartbeat stops, and releases the key it held",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          yield* screens.look(agentOf(sessionId).call());
          yield* screens.take(sessionId, OWNER, CONNECTION);
          expect(
            yield* screens.input(sessionId, CONNECTION, [
              { _tag: "Key", down: true, keysym: 0xffe1 },
            ]),
          ).toBe(true);
          expect(keysDown()).toBe(1);
          yield* eventually(
            () => Effect.map(rowOf(screen.id), (row) => row.input._tag !== "Person"),
            "never paused",
          );
          expect((yield* rowOf(screen.id)).input).toMatchObject({
            _tag: "Paused",
            reason: "lease-lapsed",
          });
          expect(keysDown()).toBe(0);
          const paused = (yield* logOf(screen.id)).at(-1);
          expect(paused?.body).toEqual({ _tag: "Paused", reason: "lease-lapsed" });
          expect(paused?.frame).not.toBeNull();
          expect(
            yield* screens.input(sessionId, CONNECTION, [
              { _tag: "Key", down: true, keysym: 0xffe1 },
            ]),
          ).toBe(false);
        }),
      ),
    { timeout: 60_000 },
  );
});
