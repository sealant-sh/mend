import { ScreensRepo, ScreensRepoMemory } from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import type { Screen } from "@mend/domain/workbench";
import { sealantRequestPriority, withInteractiveSealant } from "@mend/sealant";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { ForwardAdapterLive } from "../src/forward.ts";
import { makeHands } from "../src/screen/hands.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "../src/screen/screen-workers.ts";
import { dialLog } from "./forward-fixture.ts";
import { decodePng } from "./png.ts";
import {
  eventually,
  handSocketOf,
  OWNER,
  makeScreenWorld,
  screenHostLayer,
  screenSealantLayer,
} from "./screen-world.ts";
import { type Xvnc, dockerReady, startXvnc } from "./xvnc.ts";

const UNSIGNABLE = SessionId.make("s-unsignable");
const world = makeScreenWorld((sessionId) => sessionId !== UNSIGNABLE);
const dials = dialLog();

const layer = Layer.mergeAll(
  screenHostLayer(world),
  ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(world))),
  screenWorkersLayer(SCREEN_WORKER),
).pipe(Layer.provideMerge(ScreensRepoMemory));

/** A screen of its own session, Live on a process of its own unless `life` says otherwise. */
const screenOf = (sessionId: SessionId, life: Screen["life"]["_tag"] = "Live") =>
  Effect.gen(function* () {
    const screens = yield* ScreensRepo;
    const reserved = yield* screens.reserve({
      sessionId,
      workspaceId: SealantWorkspaceId.make(`ws-${crypto.randomUUID()}`),
    });
    if (life !== "Live") return reserved;
    return yield* screens.setLife(reserved.id, {
      life: { _tag: "Live", degraded: null, browserSandboxOff: false },
      processId: SessionProcessId.make(`p-${crypto.randomUUID()}`),
    });
  }).pipe(Effect.orDie);

const freshSession = () => SessionId.make(`s-${crypto.randomUUID()}`);

describe.skipIf(!dockerReady)("a screen's hand, against TigerVNC Xvnc", () => {
  let xvnc: Xvnc;

  beforeAll(() => {
    xvnc = startXvnc(`mend-screen-hands-${process.pid}-${Date.now()}`);
    world.xvncPort = xvnc.port;
  }, 660_000);

  afterAll(() => xvnc?.remove());

  it.live(
    "dials the screen's display as its owner, bound to its process's PTY, with the screen purpose",
    () =>
      Effect.gen(function* () {
        const ended: Array<Screen> = [];
        const hands = yield* makeHands((screen) => Effect.sync(() => void ended.push(screen)));
        const screen = yield* screenOf(freshSession());
        const [first, second] = yield* Effect.all([hands.of(screen), hands.of(screen)], {
          concurrency: 2,
        });
        if (first === null) throw new Error("no hand");
        expect(second).toBe(first);
        expect(hands.open(screen.id)).toBe(first);
        xvnc.x("xsetroot -solid '#22aa44'");
        expect(decodePng(yield* first.look).at(10, 10)).toEqual([0x22, 0xaa, 0x44]);
        expect(world.dials.length).toBe(1);
        expect(world.dials[0]).toEqual({
          port: 5900 + screen.display,
          destination: {
            route: "loopback",
            binding: { kind: "session", session: `pty-${screen.processId}` },
          },
          as: { kind: "user", userId: OWNER },
        });
        expect(dials.records.at(-1)?.purpose).toBe("screen");
        expect(ended).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(dials.layer)),
    { timeout: 30_000 },
  );

  it.live(
    "opens a usable control connection after normal owner allowance is exhausted",
    () =>
      Effect.gen(function* () {
        const hands = yield* makeHands(() => Effect.void);
        const screen = yield* screenOf(freshSession());
        const priorities: string[] = [];
        world.onDial = () => {
          const priority = sealantRequestPriority();
          priorities.push(priority);
          if (priority !== "interactive") throw new Error("normal owner allowance exhausted");
        };
        expect(yield* hands.of(screen)).toBeNull();
        const hand = yield* hands.of(screen).pipe(withInteractiveSealant);
        if (hand === null) return yield* Effect.die("the person's control connection was refused");
        xvnc.x("xsetroot -solid '#335577'");
        expect(decodePng(yield* hand.look).at(10, 10)).toEqual([0x33, 0x55, 0x77]);
        expect(priorities).toEqual(["normal", "interactive"]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            world.onDial = null;
          }),
        ),
        Effect.scoped,
        Effect.provide(layer),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "dials nothing for a screen that is not Live, or whose passwords this process does not hold",
    () =>
      Effect.gen(function* () {
        const hands = yield* makeHands(() => Effect.void);
        const before = world.dials.length;
        expect(yield* hands.of(yield* screenOf(freshSession(), "NotStarted"))).toBeNull();
        expect(yield* hands.of(yield* screenOf(UNSIGNABLE))).toBeNull();
        expect(world.dials.length).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    { timeout: 30_000 },
  );

  it.live(
    "tells of a hand whose connection ended, and dials a new one when asked again",
    () =>
      Effect.gen(function* () {
        const ended: Array<Screen> = [];
        const hands = yield* makeHands((screen) => Effect.sync(() => void ended.push(screen)));
        const screen = yield* screenOf(freshSession());
        const first = yield* hands.of(screen);
        handSocketOf(world, screen.processId).destroy();
        yield* eventually(
          () => Effect.sync(() => ended.length > 0),
          "the hand's end was never told",
        );
        expect(ended.map((each) => each.id)).toEqual([screen.id]);
        expect(hands.open(screen.id)).toBeNull();
        const second = yield* hands.of(screen);
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    { timeout: 30_000 },
  );

  it.live(
    "closes its hands with its scope without telling of any end",
    () =>
      Effect.gen(function* () {
        const ended: Array<Screen> = [];
        const scope = yield* Scope.make();
        const hands = yield* makeHands((screen) => Effect.sync(() => void ended.push(screen))).pipe(
          Scope.provide(scope),
        );
        const screen = yield* screenOf(freshSession());
        expect(yield* hands.of(screen)).not.toBeNull();
        const socket = handSocketOf(world, screen.processId);
        yield* Scope.close(scope, Exit.void);
        yield* Effect.sleep("100 millis");
        expect(socket.destroyed).toBe(true);
        expect(ended).toEqual([]);
      }).pipe(Effect.provide(layer)),
    { timeout: 30_000 },
  );
});
