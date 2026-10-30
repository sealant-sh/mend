import { SCREEN_LIMITS } from "@mend/domain/workbench";
import type { ForwardBytes, ForwardRead } from "@mend/sealant";
import { TestClock, it } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Effect, Fiber, Queue, Redacted, Ref } from "effect";
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
import type { Input } from "./rfb-client.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";

const EXITING_WORKER = new URL("../../test/screen-worker-exits.ts", import.meta.url);

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

/** A FramebufferUpdate of one Raw rectangle at the origin, without its pixels. */
const rawUpdate = (width: number, height: number) => {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  return header;
};

const SIGNED_IN = Buffer.concat([VERSION, VNC_AUTH, signedIn, serverInit(1280, 800)]);

/** A display that has signed the hand in and answers each later read only when the test does. */
const heldDisplay = Effect.gen(function* () {
  const asks = yield* Queue.unbounded<Deferred.Deferred<ForwardRead>>();
  const written: Array<Uint8Array> = [];
  let first = true;
  const bytes: ForwardBytes = {
    read: () =>
      Effect.suspend(() => {
        if (first) {
          first = false;
          return Effect.succeed<ForwardRead>({ kind: "bytes", bytes: SIGNED_IN });
        }
        return Effect.flatMap(Deferred.make<ForwardRead>(), (answer) =>
          Effect.andThen(Queue.offer(asks, answer), Deferred.await(answer)),
        );
      }),
    write: (chunk) => Effect.sync(() => void written.push(chunk)),
    finish: () => Effect.void,
    close: () => Effect.void,
  };
  return {
    bytes,
    written,
    /** The hand's next read, once it is waiting on it. */
    asked: Effect.tap(Queue.take(asks), () => Effect.yieldNow),
    answer: (ask: Deferred.Deferred<ForwardRead>, chunk: Uint8Array) =>
      Deferred.succeed(ask, { kind: "bytes", bytes: chunk }),
  };
});

/** The key and pointer events in what the hand wrote. */
const inputsIn = (written: ReadonlyArray<Uint8Array>): ReadonlyArray<Input> => {
  const inputs: Array<Input> = [];
  const bytes = Buffer.concat(written);
  for (let at = 0; at < bytes.length; ) {
    if (bytes[at] === 4) {
      inputs.push({ _tag: "Key", down: bytes[at + 1] === 1, keysym: bytes.readUInt32BE(at + 4) });
      at += 8;
    } else if (bytes[at] === 5) {
      const buttons = bytes[at + 1] ?? 0;
      inputs.push({
        _tag: "Pointer",
        buttons,
        x: bytes.readUInt16BE(at + 2),
        y: bytes.readUInt16BE(at + 4),
      });
      at += 6;
    } else throw new Error(`not an input message: ${bytes.subarray(at).toString("hex")}`);
  }
  return inputs;
};

const key = (down: boolean, keysym: number): Input => ({ _tag: "Key", down, keysym });
const SHIFT = 0xffe1;
const CTRL = 0xffe3;

/** The live clock, put forward by `leap` milliseconds. */
const leapingClock = (live: Clock.Clock) => {
  let ahead = 0;
  const millis = () => live.currentTimeMillisUnsafe() + ahead;
  const nanos = () => live.currentTimeNanosUnsafe() + BigInt(ahead) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
  return { clock, leap: (ms: number) => void (ahead += ms) };
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

describe("a hand whose batch or stream runs long", () => {
  it.live("sends no input past the batch's time limit, paced keys included, and holds no key", () =>
    Effect.gen(function* () {
      const { clock, leap } = leapingClock(yield* Clock.Clock);
      const display = yield* heldDisplay;
      let armed = false;
      const bytes: ForwardBytes = {
        ...display.bytes,
        write: (chunk) =>
          Effect.suspend(() => {
            if (armed && chunk[0] === 4) {
              armed = false;
              leap(SCREEN_LIMITS.batchMs);
            }
            return display.bytes.write(chunk);
          }),
      };
      const sentDuring = (
        act: Effect.Effect<{ readonly results: ReadonlyArray<string> }, unknown>,
      ) =>
        Effect.gen(function* () {
          const from = display.written.length;
          armed = true;
          const { results } = yield* act;
          return { results, inputs: inputsIn(display.written.slice(from)) };
        });
      yield* Effect.gen(function* () {
        const hand = yield* openHand({
          bytes,
          password: Redacted.make(XVNC_PASSWORD),
          currentEpoch: Effect.succeed(1),
        });
        const typed = yield* sentDuring(
          hand.act(
            steps({ kind: "type", text: "中日韓" }, { kind: "click", at: { x: 9, y: 9 } }),
            1,
          ),
        );
        expect(typed).toEqual({
          results: ["skipped: time limit", "skipped: time limit"],
          inputs: [
            key(true, SHIFT),
            key(false, SHIFT),
            key(true, 0x01004e2d),
            key(false, 0x01004e2d),
          ],
        });
        const combo = yield* sentDuring(hand.act(steps({ kind: "key", combo: "ctrl+é" }), 1));
        expect(combo).toEqual({
          results: ["skipped: time limit"],
          inputs: [
            key(true, SHIFT),
            key(false, SHIFT),
            key(true, CTRL),
            key(true, 0xe9),
            key(false, 0xe9),
            key(false, CTRL),
          ],
        });
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );

  it.effect(
    "ends with stream-stalled when a frame stops partway, and not while it moves or the screen is quiet",
    () =>
      Effect.gen(function* () {
        const display = yield* heldDisplay;
        const hand = yield* openHand({
          bytes: display.bytes,
          password: Redacted.make(XVNC_PASSWORD),
          currentEpoch: Effect.succeed(1),
        });
        const ending = yield* Effect.forkChild(Effect.flip(hand.ended));
        const header = rawUpdate(10, 10);
        const pixels = Buffer.alloc(400, 0x7f);
        let ask = yield* display.asked;
        yield* display.answer(ask, Buffer.concat([header, pixels.subarray(0, 100)]));
        for (let at = 100; at < pixels.length; at += 100) {
          ask = yield* display.asked;
          yield* TestClock.adjust("9 seconds");
          yield* display.answer(ask, pixels.subarray(at, at + 100));
        }
        ask = yield* display.asked;
        yield* TestClock.adjust("1 minute");
        expect(ending.pollUnsafe()).toBeUndefined();
        yield* display.answer(ask, Buffer.concat([header, pixels.subarray(0, 2)]));
        yield* display.asked;
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(ending)).reason).toBe("stream-stalled");
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );

  it.live("ends when its decoder's thread has gone, once a look finds it", () =>
    Effect.gen(function* () {
      const display = yield* heldDisplay;
      const hand = yield* openHand({
        bytes: display.bytes,
        password: Redacted.make(XVNC_PASSWORD),
        currentEpoch: Effect.succeed(1),
      });
      yield* hand.look;
      expect((yield* Effect.flip(hand.look)).reason).toBe("decoder-failed");
      expect((yield* Effect.flip(hand.ended)).reason).toBe("decoder-failed");
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(EXITING_WORKER))),
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
    "sends nothing once it has ended: not the click left in its batch, a queued look or a new relay",
    () =>
      Effect.gen(function* () {
        const connection = yield* Effect.promise(() => connect(xvnc.port));
        const hand = yield* openHand({
          bytes: connection.bytes,
          password: Redacted.make(XVNC_PASSWORD),
          currentEpoch: Effect.succeed(1),
        });
        yield* hand.look;
        const before = pointer();
        const act = yield* Effect.forkChild(
          Effect.flip(
            hand.act(
              steps({ kind: "wait", ms: 1_200 }, { kind: "click", at: { x: 888, y: 555 } }),
              1,
            ),
          ),
        );
        const look = yield* Effect.forkChild(Effect.flip(hand.look));
        yield* Effect.sleep(100);
        x("xsetroot -solid '#7799aa'");
        const ending = yield* Effect.flip(hand.ended);
        const sent = connection.written.length;
        const relay = yield* Effect.flip(
          hand.relay([{ _tag: "Pointer", buttons: 0, x: 888, y: 555 }], 1),
        );
        expect(
          [ending, yield* Fiber.join(act), yield* Fiber.join(look), relay].map(
            ({ reason }) => reason,
          ),
        ).toEqual(["decoder-failed", "decoder-failed", "decoder-failed", "decoder-failed"]);
        yield* Effect.sleep(1_500);
        expect(connection.written.slice(sent)).toEqual([]);
        expect(pointer()).toEqual(before);
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(EXITING_WORKER))),
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
