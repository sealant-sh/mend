import { readFileSync } from "node:fs";
import * as path from "node:path";

import { ScreensRepo } from "@mend/db";
import { it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vitest";

import { type ScreenCaller, Screens } from "../src/screen/screens.ts";
import { decodePng } from "./png.ts";
import { eventually } from "./screen-world.ts";
import {
  type EndHeld,
  agentOf,
  answered,
  asProcess,
  blobRoot,
  holdNextEndWith,
  logOf,
  movedTo,
  postgres,
  rowOf,
  seedSession,
  sessionWithScreen,
  useXvnc,
  world,
} from "./screens-fixture.ts";
import { dockerReady } from "./xvnc.ts";

describe.skipIf(postgres.skip)("who may call, and on what", () => {
  it.live(
    "refuses a caller that names no current agent process, and a session with no screen",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          const superseded: ScreenCaller = {
            ...agent.call(),
            agentProcess: { _tag: "Superseded", id: agent.id },
          };
          expect(yield* screens.authorize(superseded)).toBe("unattributed_caller");
          expect(yield* screens.look(superseded)).toEqual({
            _tag: "Refused",
            refusal: "unattributed_caller",
          });
          for (const unattributed of [
            { ...agent.call(), agentProcess: null },
            { ...agent.call(), callKey: null },
          ]) {
            expect(yield* screens.look(unattributed)).toEqual({
              _tag: "Refused",
              refusal: "unattributed_caller",
            });
          }

          const bare = yield* seedSession;
          expect(yield* screens.look(agentOf(bare).call())).toEqual({
            _tag: "Refused",
            refusal: "no_screen",
          });
          expect(world.starts).not.toContain(sessionId);
          expect(world.starts).not.toContain(bare);
        }),
      ),
  );

  it.live("refuses a turn someone other than the screen's person sent, claiming nothing", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const sql = yield* SqlClient.SqlClient;
        const { sessionId, screen } = yield* sessionWithScreen;
        const agent = agentOf(sessionId);
        for (const accountId of ["bob", null]) {
          expect(yield* screens.look({ ...agent.call(), accountId })).toEqual({
            _tag: "Refused",
            refusal: "owner_only",
          });
        }
        const [claims] = yield* sql<{ readonly count: number }>`
          SELECT count(*)::int AS count FROM screen_calls WHERE screen_id = ${screen.id}`;
        expect(claims?.count).toBe(0);
        expect(world.starts).not.toContain(sessionId);
      }),
    ),
  );

  it.live("refuses a key no keysym names before it claims or starts anything", () =>
    asProcess(
      Effect.gen(function* () {
        const { sessionId, screen } = yield* sessionWithScreen;
        const answer = yield* (yield* Screens).act(agentOf(sessionId).call(), {
          actions: [{ kind: "key", combo: "ctrl+notakey" }],
        });
        expect(answer).toEqual({ _tag: "UnsupportedKey", key: "notakey" });
        expect(world.starts).not.toContain(sessionId);
        expect((yield* rowOf(screen.id)).life).toEqual({ _tag: "NotStarted" });
      }),
    ),
  );
});

describe.skipIf(postgres.skip || !dockerReady)("the Screens service, against TigerVNC Xvnc", () => {
  const { x, pointer } = useXvnc();

  it.live(
    "looks: the screen started on demand, its frame stored, the receipt returned, a retry answered from the store",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          x("xsetroot -solid '#3366cc'");
          const look = answered(yield* screens.look(agent.call("look-1")));
          expect(world.starts).toContain(sessionId);
          expect(look.outcome).toBe("applied");
          expect(decodePng(look.png).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          expect(look.receipt).toEqual({ screenId: screen.id, seq: 1, callKey: "look-1" });
          const [entry] = yield* logOf(screen.id);
          expect([entry?.actor._tag, entry?.body._tag]).toEqual(["Agent", "Looked"]);
          expect(entry?.frame?.id).toBe(look.frameId);
          const stored = path.join(
            blobRoot,
            "screen-frames",
            screen.id,
            `${entry?.frame?.digest}.png`,
          );
          expect(decodePng(readFileSync(stored)).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);

          x("xsetroot -solid '#cc3300'");
          const again = answered(yield* screens.look(agent.call("look-1")));
          expect(again.receipt).toEqual(look.receipt);
          expect(decodePng(again.png).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          expect((yield* logOf(screen.id)).length).toBe(1);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "acts: the batch runs on the screen, its notes and receipt answered",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call("look-1"));
          const acted = answered(
            yield* screens.act(agent.call("act-1"), { actions: [movedTo({ x: 321, y: 123 })] }),
          );
          expect(pointer()).toEqual([321, 123]);
          expect(acted.outcome).toBe("applied");
          expect(acted.receipt).toEqual({ screenId: screen.id, seq: 2, callKey: "act-1" });
          expect(acted.actions).toEqual([{ action: movedTo({ x: 321, y: 123 }), result: "done" }]);
          expect(acted.frameId).not.toBeNull();
          const entry = (yield* logOf(screen.id)).at(-1);
          expect(entry?.actor).toEqual({
            _tag: "Agent",
            processId: agent.id,
            turnId: null,
            callKey: "act-1",
            toolCall: { _tag: "Pending" },
          });
          expect(entry?.body._tag).toBe("Acted");
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "refuses an act on a turn someone other than the screen's person sent, sending nothing",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          answered(yield* screens.look(agent.call()));
          x("xdotool mousemove 17 19");
          const seen = (yield* logOf(screen.id)).length;
          const steered = { ...agent.call(), accountId: "bob" };
          expect(yield* screens.act(steered, { actions: [movedTo({ x: 777, y: 555 })] })).toEqual({
            _tag: "Refused",
            refusal: "owner_only",
          });
          expect(pointer()).toEqual([17, 19]);
          expect((yield* logOf(screen.id)).length).toBe(seen);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "resets the input when the hand's connection ends, and dials a new hand at the next call",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          answered(yield* screens.look(agent.call()));
          expect((yield* rowOf(screen.id)).input._tag).toBe("Agent");
          const dialled = world.dials.length;
          world.sockets.at(-1)?.destroy();
          yield* eventually(
            () => Effect.map(rowOf(screen.id), (row) => row.input._tag !== "Agent"),
            "the input never reset",
          );
          expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
          answered(yield* screens.look(agent.call()));
          expect(world.dials.length).toBe(dialled + 1);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live("answers a retry after the screen stopped from its claim, starting nothing", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const repo = yield* ScreensRepo;
        const { sessionId, screen } = yield* sessionWithScreen;
        const caller = agentOf(sessionId).call("before-idle-stop");
        const first = answered(yield* screens.look(caller));
        yield* repo.setLife(screen.id, { life: { _tag: "Ended", reason: "idle" } });
        const starts = world.starts.length;
        expect(answered(yield* screens.look(caller)).receipt).toEqual(first.receipt);
        expect(world.starts.length).toBe(starts);
      }),
    ),
  );

  it.live("keeps a look on a new hand admitted while the old hand's end was still settling", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const { sessionId, screen } = yield* sessionWithScreen;
        const agent = agentOf(sessionId);
        answered(yield* screens.look(agent.call()));
        const held: EndHeld = {
          reached: yield* Deferred.make<void>(),
          go: yield* Deferred.make<void>(),
        };
        holdNextEndWith(held);
        world.sockets.at(-1)?.destroy();
        yield* Deferred.await(held.reached);
        const dialled = yield* Deferred.make<void>();
        world.onDial = () => Deferred.doneUnsafe(dialled, Effect.void);
        const looking = yield* Effect.forkChild(screens.look(agent.call()));
        yield* Deferred.await(dialled);
        world.onDial = null;
        yield* Deferred.succeed(held.go, undefined);
        expect(answered(yield* Fiber.join(looking)).outcome).toBe("applied");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Agent");
      }),
    ),
  );

  it.live(
    "answers a retry from its claim with no input, and refuses its key reused for other arguments",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const params = { actions: [movedTo({ x: 400, y: 300 })] };
          const first = answered(yield* screens.act(agent.call("retried"), params));
          x("xdotool mousemove 5 5");
          const again = answered(yield* screens.act(agent.call("retried"), params));
          expect(pointer()).toEqual([5, 5]);
          expect(again.receipt).toEqual(first.receipt);
          expect(again.actions).toEqual(first.actions);
          expect(decodePng(again.png).width).toBe(1280);
          expect(
            yield* screens.act(agent.call("retried"), { actions: [movedTo({ x: 9, y: 9 })] }),
          ).toEqual({ _tag: "Refused", refusal: "call_reused" });
          expect(pointer()).toEqual([5, 5]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "answers a second batch busy while one runs, and a look waits for it",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const running = yield* Effect.forkChild(
            screens.act(agent.call(), {
              actions: [{ kind: "wait", ms: 1_500 }, movedTo({ x: 600, y: 500 })],
            }),
          );
          yield* Effect.sleep("300 millis");
          expect(
            yield* screens.act(agent.call(), { actions: [movedTo({ x: 10, y: 10 })] }),
          ).toEqual({ _tag: "Refused", refusal: "busy" });
          const looked = answered(yield* screens.look(agent.call()));
          expect(pointer()).toEqual([600, 500]);
          const batch = answered(yield* Fiber.join(running));
          expect(looked.receipt.seq).toBeGreaterThan(batch.receipt.seq);
        }),
      ),
    { timeout: 60_000 },
  );
});
