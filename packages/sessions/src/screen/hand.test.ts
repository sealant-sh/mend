import type { ForwardBytes, ForwardRead } from "@mend/sealant";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Fiber, Redacted, Ref } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { decodePng } from "../../test/png.ts";
import {
  type Connection,
  XVNC_PASSWORD,
  type Xvnc,
  connect,
  dockerReady,
  startXvnc,
} from "../../test/xvnc.ts";
import { planActions } from "./hand-steps.ts";
import { type Hand, openHand } from "./hand.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";

const scriptedDisplay = (...lines: ReadonlyArray<Uint8Array>): ForwardBytes => {
  const left = [...lines];
  return {
    read: () =>
      Effect.sync((): ForwardRead => {
        const bytes = left.shift();
        return bytes === undefined ? { kind: "eof" } : { kind: "bytes", bytes };
      }),
    write: () => Effect.void,
    finish: () => Effect.void,
    close: () => Effect.void,
  };
};

const VERSION = Buffer.from("RFB 003.008\n");
const VNC_AUTH = Uint8Array.of(1, 2, ...Array.from({ length: 16 }, (_, at) => at));
const signedIn = Uint8Array.of(0, 0, 0, 0);
const serverInit = (width: number, height: number) => {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  return init;
};

const steps = (...actions: Parameters<typeof planActions>[0]) => {
  const plan = planActions(actions);
  if (plan._tag === "Unsupported") throw new Error(`unsupported key ${plan.key}`);
  return plan.steps;
};

describe("a hand whose display misbehaves", () => {
  const endedWith = (...lines: ReadonlyArray<Uint8Array>) =>
    openHand({
      bytes: scriptedDisplay(...lines),
      password: Redacted.make(XVNC_PASSWORD),
      currentEpoch: Effect.succeed(1),
    }).pipe(
      Effect.flip,
      Effect.map((error) => error.reason),
      Effect.scoped,
      Effect.provide(screenWorkersLayer(SCREEN_WORKER)),
    );

  it.live("ends with a typed reason: a screen of another size, a refused password, a hang-up", () =>
    Effect.gen(function* () {
      expect(
        yield* endedWith(Buffer.concat([VERSION, VNC_AUTH, signedIn, serverInit(1024, 768)])),
      ).toBe("screen-size");
      expect(yield* endedWith(VERSION, VNC_AUTH, Uint8Array.of(0, 0, 0, 1))).toBe("auth-failed");
      expect(yield* endedWith(VERSION, Uint8Array.of(1, 1))).toBe("no-vnc-auth");
      expect(yield* endedWith(VERSION, VNC_AUTH)).toBe("closed");
    }),
  );
});

describe.skipIf(!dockerReady)("the hand, against TigerVNC Xvnc in a container", () => {
  let xvnc: Xvnc;
  const x = (command: string) => xvnc.x(command);
  const keysDown = () => (x('xinput query-state "TigerVNC keyboard"').match(/=down/g) ?? []).length;
  const buttonDown = () => x('xinput query-state "TigerVNC pointer"').includes("button[1]=down");
  const pointer = () =>
    x("xdotool getmouselocation")
      .match(/x:(\d+) y:(\d+)/)
      ?.slice(1)
      .map(Number);

  beforeAll(() => {
    xvnc = startXvnc(`mend-hand-${process.pid}-${Date.now()}`);
  }, 660_000);

  afterAll(() => xvnc.remove());

  const withHand = <A, E>(
    use: (hand: Hand, epoch: Ref.Ref<number>, connection: Connection) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const epoch = yield* Ref.make(1);
      const connection = yield* Effect.promise(() => connect(xvnc.port));
      const hand = yield* openHand({
        bytes: connection.bytes,
        password: Redacted.make(XVNC_PASSWORD),
        currentEpoch: Ref.get(epoch),
      });
      return yield* use(hand, epoch, connection);
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER)));

  it.live(
    "answers the screen as Xvnc draws it, and follows it as it changes",
    () =>
      withHand((hand) =>
        Effect.gen(function* () {
          x("xsetroot -solid '#3366cc'");
          const blue = decodePng(yield* hand.look);
          expect([blue.width, blue.height]).toEqual([1280, 800]);
          expect(blue.at(5, 5)).toEqual([0x33, 0x66, 0xcc]);
          expect(blue.at(1279, 799)).toEqual([0x33, 0x66, 0xcc]);
          x("xsetroot -solid '#cc3300'");
          expect(decodePng(yield* hand.look).at(640, 400)).toEqual([0xcc, 0x33, 0x00]);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "clicks where it is told",
    () =>
      withHand((hand) =>
        Effect.gen(function* () {
          const answer = yield* hand.act(steps({ kind: "click", at: { x: 321, y: 123 } }), 1);
          expect(answer.results).toEqual(["done"]);
          expect(pointer()).toEqual([321, 123]);
          expect(buttonDown()).toBe(false);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "types characters beyond Latin-1 into an xterm",
    () =>
      withHand((hand) =>
        Effect.gen(function* () {
          xvnc.start(
            "xterm",
            "-geometry",
            "40x5+0+0",
            "-fa",
            "DejaVu Sans Mono",
            "-e",
            "sh",
            "-c",
            "cat > /tmp/typed",
          );
          for (let tries = 0; x("xdotool search --class xterm || true").trim() === ""; tries++) {
            if (tries > 50) throw new Error("no xterm");
          }
          const answer = yield* hand.act(
            steps(
              { kind: "move", to: { x: 60, y: 30 } },
              { kind: "wait", ms: 300 },
              { kind: "type", text: "é€\n" },
            ),
            1,
          );
          expect(answer.results).toEqual(["done", "done", "done"]);
          expect(x("cat /tmp/typed")).toBe("é€\n");
          expect(keysDown()).toBe(0);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "releases a key the holder held when the holder changes, and drops a former holder's input",
    () =>
      withHand((hand, epoch) =>
        Effect.gen(function* () {
          yield* hand.relay([{ _tag: "Key", down: true, keysym: 0xffe1 }], 1);
          expect(keysDown()).toBe(1);
          yield* Ref.set(epoch, 2);
          yield* hand.release;
          expect(keysDown()).toBe(0);
          yield* hand.relay([{ _tag: "Key", down: true, keysym: 0xffe1 }], 1);
          expect(keysDown()).toBe(0);
        }),
      ),
    { timeout: 30_000 },
  );

  it.live(
    "lets go of a held button and key as its scope closes",
    () =>
      Effect.gen(function* () {
        const written = yield* withHand((hand, _, connection) =>
          Effect.gen(function* () {
            yield* hand.relay([{ _tag: "Pointer", buttons: 1, x: 700, y: 700 }], 1);
            yield* hand.relay([{ _tag: "Key", down: true, keysym: 0x61 }], 1);
            expect([buttonDown(), keysDown()]).toEqual([true, 1]);
            return connection.written;
          }),
        );
        expect(Buffer.concat(written.slice(-1)).toString("hex")).toBe(
          "0400000000000061050002bc02bc",
        );
        expect([buttonDown(), keysDown()]).toEqual([false, 0]);
      }),
    { timeout: 30_000 },
  );

  it.live(
    "finds that Xvnc lets go of what a connection held when that connection drops",
    () =>
      Effect.gen(function* () {
        yield* withHand((hand, _, connection) =>
          Effect.gen(function* () {
            yield* hand.relay([{ _tag: "Pointer", buttons: 1, x: 700, y: 700 }], 1);
            yield* hand.relay([{ _tag: "Key", down: true, keysym: 0x61 }], 1);
            expect([buttonDown(), keysDown()]).toEqual([true, 1]);
            connection.cut();
            yield* Effect.sleep(500);
            expect([buttonDown(), keysDown()]).toEqual([false, 0]);
          }),
        );
      }),
    { timeout: 30_000 },
  );

  it.live(
    "skips the rest of a batch once the epoch moves on between two actions",
    () =>
      withHand((hand, epoch) =>
        Effect.gen(function* () {
          const act = yield* Effect.forkChild(
            hand.act(
              steps(
                { kind: "move", to: { x: 100, y: 100 } },
                { kind: "wait", ms: 2_000 },
                { kind: "move", to: { x: 900, y: 600 } },
                { kind: "click", at: { x: 900, y: 600 } },
              ),
              1,
            ),
          );
          yield* Effect.sleep(300);
          yield* Ref.set(epoch, 2);
          const answer = yield* Fiber.join(act);
          expect(answer.results).toEqual([
            "done",
            "done",
            "skipped: taken over",
            "skipped: taken over",
          ]);
          expect(pointer()).toEqual([100, 100]);
        }),
      ),
    { timeout: 30_000 },
  );
});
