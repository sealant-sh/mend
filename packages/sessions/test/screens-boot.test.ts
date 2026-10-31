import { readFileSync } from "node:fs";
import * as path from "node:path";

import { ScreensRepo } from "@mend/db";
import { ViewerConnectionId } from "@mend/domain";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { Screens } from "../src/screen/screens.ts";
import { decodePng } from "./png.ts";
import { OWNER } from "./screen-world.ts";
import {
  agentOf,
  answered,
  asProcess,
  blobRoot,
  CONNECTION,
  logOf,
  movedTo,
  postgres,
  rowOf,
  sessionWithScreen,
  useXvnc,
  world,
} from "./screens-fixture.ts";
import { dockerReady } from "./xvnc.ts";

describe.skipIf(postgres.skip || !dockerReady)("the Screens service, against TigerVNC Xvnc", () => {
  const { x, keysDown, pointer } = useXvnc();

  it.live(
    "boots a claim stored without its outcome into outcome_unknown, sending its input never again",
    () =>
      Effect.gen(function* () {
        const crashed = yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            const { sessionId, screen } = yield* sessionWithScreen;
            const agent = agentOf(sessionId);
            yield* screens.look(agent.call());
            const params = { actions: [movedTo({ x: 222, y: 111 })] };
            yield* (yield* ScreensRepo).claim({
              screenId: screen.id,
              callKey: "crashed",
              args: { tool: "screen_act", params },
            });
            return { sessionId, screen, agent, params };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            x("xdotool mousemove 7 7");
            expect(yield* screens.act(crashed.agent.call("crashed"), crashed.params)).toEqual({
              _tag: "NoEntry",
              outcome: "outcome_unknown",
            });
            expect(pointer()).toEqual([7, 7]);
            expect(
              yield* screens.act(crashed.agent.call(), { actions: [movedTo({ x: 1, y: 1 })] }),
            ).toEqual({ _tag: "Refused", refusal: "look_first" });
            expect((yield* rowOf(crashed.screen.id)).input._tag).toBe("AwaitingAgent");
            expect(world.starts.filter((started) => started === crashed.sessionId).length).toBe(1);
          }),
        );
      }),
    { timeout: 60_000 },
  );

  it.live(
    "boots a fence committed without its acknowledgement into Paused",
    () =>
      Effect.gen(function* () {
        const fenced = yield* asProcess(
          Effect.gen(function* () {
            const { sessionId, screen } = yield* sessionWithScreen;
            yield* (yield* Screens).look(agentOf(sessionId).call());
            yield* (yield* ScreensRepo).control(
              screen.id,
              { _tag: "Take", by: OWNER, connection: CONNECTION },
              OWNER,
            );
            expect((yield* rowOf(screen.id)).input._tag).toBe("Fencing");
            return { sessionId, screen };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            x("xsetroot -solid '#55aa33'");
            expect(yield* screens.heartbeat(fenced.sessionId, CONNECTION)).toBe(false);
            const row = yield* rowOf(fenced.screen.id);
            expect(row.input).toMatchObject({ _tag: "Paused", reason: "restart" });
            expect(row.input.epoch).toBe(3);
            const last = (yield* logOf(fenced.screen.id)).at(-1);
            expect(last?.body).toEqual({ _tag: "Paused", reason: "restart" });
            if (last?.frame == null) throw new Error("the restart's pause kept no frame");
            const stored = path.join(
              blobRoot,
              "screen-frames",
              fenced.screen.id,
              `${last.frame.digest}.png`,
            );
            expect(decodePng(readFileSync(stored)).at(640, 400)).toEqual([0x55, 0xaa, 0x33]);
            expect(keysDown()).toBe(0);
          }),
        );
      }),
    { timeout: 60_000 },
  );

  it.live(
    "starts a screen over when its rekey after Mend restarted fails: the log says why, with a frame, and a take over moves its pointer",
    () =>
      Effect.gen(function* () {
        const before = yield* asProcess(
          Effect.gen(function* () {
            const { sessionId, screen } = yield* sessionWithScreen;
            answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
            return { sessionId, screen };
          }),
        );
        world.rekeyFails.add(before.sessionId);
        x("xsetroot -solid '#3366cc'");
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            const viewer = ViewerConnectionId.make("viewer-after-failed-rekey");
            yield* screens.take(before.sessionId, OWNER, viewer);
            expect((yield* rowOf(before.screen.id)).input).toMatchObject({
              _tag: "Person",
              connection: viewer,
            });
            const moved = yield* screens.input(before.sessionId, viewer, [
              { _tag: "Pointer", buttons: 0, x: 555, y: 222 },
            ]);
            expect(moved).toBe(true);
            expect(pointer()).toEqual([555, 222]);
            expect(world.starts.filter((started) => started === before.sessionId)).toHaveLength(2);

            const restarted = (yield* logOf(before.screen.id)).find(
              (entry) => entry.body._tag === "Restarted",
            );
            expect(restarted).toMatchObject({
              actor: { _tag: "Mend" },
              body: { _tag: "Restarted", reason: "rekey-failed" },
            });
            if (restarted?.frame == null) throw new Error("the restart kept no frame");
            const stored = path.join(
              blobRoot,
              "screen-frames",
              before.screen.id,
              `${restarted.frame.digest}.png`,
            );
            expect(decodePng(readFileSync(stored)).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => world.rekeyFails.clear()))),
    { timeout: 60_000 },
  );

  it.live(
    "takes over a screen that outlived Mend, signed for again rather than started over, and moves its pointer",
    () =>
      Effect.gen(function* () {
        const before = yield* asProcess(
          Effect.gen(function* () {
            const { sessionId, screen } = yield* sessionWithScreen;
            answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
            return { sessionId, screen };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            const viewer = ViewerConnectionId.make("viewer-after-restart");
            yield* screens.take(before.sessionId, OWNER, viewer);
            expect((yield* rowOf(before.screen.id)).input).toMatchObject({
              _tag: "Person",
              connection: viewer,
            });
            const moved = yield* screens.input(before.sessionId, viewer, [
              { _tag: "Pointer", buttons: 0, x: 444, y: 333 },
            ]);
            expect(moved).toBe(true);
            expect(pointer()).toEqual([444, 333]);
            expect(world.rekeys).toContain(before.sessionId);
            expect(world.starts.filter((started) => started === before.sessionId)).toHaveLength(1);
          }),
        );
      }),
    { timeout: 60_000 },
  );
});
