import { SCREEN_LIMITS, type ScreenActionResult } from "@mend/domain/workbench";
import type { ForwardBytes } from "@mend/sealant";
import { Clock, Data, Deferred, Duration, Effect, Fiber, Queue, Redacted, Semaphore } from "effect";

import type { Step } from "./hand-steps.ts";
import {
  type Held,
  type Input,
  NOTHING_HELD,
  encodeInput,
  framebufferUpdateRequest,
  hold,
  releaseAll,
} from "./rfb-client.ts";
import {
  type FramebufferRefusal,
  HAND_SETUP,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./rfb-framebuffer.ts";
import { ByteQueue } from "./rfb-queue.ts";
import { type SignInRefusal, VncSignIn } from "./rfb-sign-in.ts";
import { ScreenWorkers, type WorkerStopped } from "./screen-workers.ts";

const SETTLE_QUIET_MS = 300;
const SETTLE_MOST_MS = 2_000;
const SLICE_MS = 100;
const PACE_MS = 20;
const QUEUED_AT_MOST = 256;
const SIGN_IN_DEADLINE = Duration.seconds(10);
const RELEASE_DEADLINE = Duration.seconds(1);
/** Shift, Control, Caps Lock, Shift Lock, Meta, Alt, Super and Hyper, then AltGr. */
const MODIFIERS = [...Array.from({ length: 14 }, (_, at) => 0xffe1 + at), 0xfe03];
const BOOT_RESET = [
  encodeInput({ _tag: "Pointer", buttons: 0, x: 0, y: 0 }),
  ...MODIFIERS.map((keysym) => encodeInput({ _tag: "Key", down: false, keysym })),
];

/**
 * Xvnc binds a keysym its keymap lacks to a spare keycode and, once none is spare, rebinds one, so
 * an X client must have read each such key before the next is sent.
 */
const rebound = (input: Input | undefined) =>
  input?._tag === "Key" &&
  !input.down &&
  ((input.keysym >= 0xa0 && input.keysym <= 0xff) || input.keysym >= 0x01000000);

/**
 * X copies a keyboard's keymap into the master keyboard when that keyboard sends a key after
 * another one did, which drops a keysym Xvnc had just added to the master. A Shift tap first makes
 * Xvnc's keyboard the master's current one.
 */
const SHIFT_TAP: ReadonlyArray<Input> = [
  { _tag: "Key", down: true, keysym: 0xffe1 },
  { _tag: "Key", down: false, keysym: 0xffe1 },
];

export type HandEndReason =
  | SignInRefusal
  | FramebufferRefusal
  | "sign-in-deadline"
  | "decode-deadline"
  | "decoder-failed"
  | "connection-failed"
  | "closed";

export class HandEnded extends Data.TaggedError("HandEnded")<{ readonly reason: HandEndReason }> {}

export interface Answer {
  readonly results: ReadonlyArray<ScreenActionResult>;
  readonly png: Uint8Array;
}

export interface Hand {
  /** Runs each step while `epoch` is current and the batch is within its limit, then answers the settled frame. */
  readonly act: (
    steps: ReadonlyArray<Step>,
    epoch: number,
  ) => Effect.Effect<Answer, HandEnded | WorkerStopped>;
  readonly look: Effect.Effect<Uint8Array, HandEnded | WorkerStopped>;
  /** A holder's input, sent only while `epoch` is current. */
  readonly relay: (inputs: ReadonlyArray<Input>, epoch: number) => Effect.Effect<void, HandEnded>;
  /** A key-up and a button-up for everything held, at each change of holder. */
  readonly release: Effect.Effect<void, HandEnded>;
  readonly ended: Effect.Effect<never, HandEnded>;
}

export interface HandOptions {
  readonly bytes: ForwardBytes;
  readonly password: Redacted.Redacted<string>;
  readonly currentEpoch: Effect.Effect<number>;
}

const ended = (reason: HandEndReason) => new HandEnded({ reason });
const decoderEnded = (stopped: WorkerStopped) =>
  ended(stopped.reason === "deadline" ? "decode-deadline" : "decoder-failed");

/** The screen's one input connection: signs in, keeps the framebuffer current, and runs one queue. */
export const openHand = Effect.fn("openHand")(function* (options: HandOptions) {
  const { bytes, currentEpoch } = options;
  const workers = yield* ScreenWorkers;
  const decoder = yield* workers.decoder;
  const end = yield* Deferred.make<never, HandEnded>();
  const ready = yield* Deferred.make<void>();
  const writing = yield* Semaphore.make(1);
  const tasks = yield* Queue.bounded<Effect.Effect<void>>(QUEUED_AT_MOST);
  let held: Held = NOTHING_HELD;
  let lastUpdate = 0;

  const send = (messages: ReadonlyArray<Uint8Array>) =>
    writing
      .withPermit(bytes.write(Buffer.concat(messages)))
      .pipe(Effect.mapError(() => ended("connection-failed")));
  const press = (inputs: ReadonlyArray<Input>) =>
    Effect.suspend(() => {
      held = inputs.reduce(hold, held);
      return send(inputs.map(encodeInput));
    });
  const pressPaced = (inputs: ReadonlyArray<Input>) =>
    Effect.gen(function* () {
      const sent = inputs.some(rebound) ? [...SHIFT_TAP, ...inputs] : inputs;
      let from = 0;
      for (let at = 0; at < sent.length - 1; at++) {
        if (!rebound(sent[at])) continue;
        yield* press(sent.slice(from, at + 1));
        yield* Effect.sleep(PACE_MS);
        from = at + 1;
      }
      yield* press(sent.slice(from));
    });
  const current = (epoch: number) => Effect.map(currentEpoch, (now) => now === epoch);
  const sleepUntil = (until: () => number, epoch: number | undefined) =>
    Effect.gen(function* () {
      for (;;) {
        const left = until() - (yield* Clock.currentTimeMillis);
        if (left <= 0 || (epoch !== undefined && !(yield* current(epoch)))) return;
        yield* Effect.sleep(Math.min(left, SLICE_MS));
      }
    });
  const settledFrame = (epoch?: number) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const quietAt = () => Math.max(lastUpdate, start) + SETTLE_QUIET_MS;
      yield* sleepUntil(() => Math.min(quietAt(), start + SETTLE_MOST_MS), epoch);
      return yield* decoder.copy.pipe(Effect.mapError(decoderEnded));
    });
  const skipped = (epoch: number, limit: number): Effect.Effect<ScreenActionResult | undefined> =>
    Effect.gen(function* () {
      if (!(yield* current(epoch))) return "skipped: taken over";
      if ((yield* Clock.currentTimeMillis) >= limit) return "skipped: time limit";
      return undefined;
    });
  const perform = (step: Step, epoch: number, limit: number) =>
    step._tag === "Inputs"
      ? pressPaced(step.inputs)
      : Effect.flatMap(Clock.currentTimeMillis, (now) =>
          sleepUntil(() => Math.min(now + step.ms, limit), epoch),
        );
  const run = <A, E>(task: Effect.Effect<A, E>): Effect.Effect<A, E | HandEnded> =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<A, E>();
      yield* Queue.offer(tasks, Deferred.into(task, done).pipe(Effect.asVoid));
      return yield* Deferred.await(done);
    }).pipe(Effect.raceFirst(Deferred.await(end)));

  const reader = Effect.gen(function* () {
    const signIn = new VncSignIn(Redacted.value(options.password));
    const handshake = new ByteQueue();
    let signedIn = false;
    for (;;) {
      const read = yield* bytes.read().pipe(Effect.mapError(() => ended("connection-failed")));
      if (read.kind === "eof") return yield* ended("closed");
      let chunk = read.bytes;
      if (!signedIn) {
        handshake.push(chunk);
        const step = signIn.read(handshake);
        if (step._tag === "Refused") return yield* ended(step.reason);
        yield* send(step.send);
        if (step._tag === "Pending") continue;
        signedIn = true;
        chunk = handshake.take(handshake.length);
        if (chunk.length === 0) continue;
      }
      const decoded = yield* decoder.decode(chunk).pipe(Effect.mapError(decoderEnded));
      if (decoded._tag === "Refused") return yield* ended(decoded.reason);
      for (const event of decoded.events) {
        if (event._tag === "Ready") {
          yield* send([...HAND_SETUP, ...BOOT_RESET]);
          yield* Deferred.succeed(ready, undefined);
        } else if (event._tag === "Updated") {
          lastUpdate = yield* Clock.currentTimeMillis;
          yield* send([framebufferUpdateRequest(true, SCREEN_WIDTH, SCREEN_HEIGHT)]);
        }
      }
    }
  });

  const consumer = yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(tasks))));
  yield* Effect.forkScoped(Deferred.into(reader, end));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.fail(end, ended("closed"));
      yield* Fiber.interrupt(consumer);
      yield* Effect.suspend(() => press(releaseAll(held))).pipe(
        Effect.timeout(RELEASE_DEADLINE),
        Effect.ignore,
      );
      yield* bytes.close();
    }),
  );
  yield* Deferred.await(ready).pipe(
    Effect.raceFirst(Deferred.await(end)),
    Effect.timeoutOrElse({
      duration: SIGN_IN_DEADLINE,
      orElse: () => Effect.fail(ended("sign-in-deadline")),
    }),
  );

  const act = (steps: ReadonlyArray<Step>, epoch: number) =>
    run(
      Effect.gen(function* () {
        const limit = (yield* Clock.currentTimeMillis) + SCREEN_LIMITS.batchMs;
        const results: Array<ScreenActionResult> = [];
        for (const step of steps) {
          const skip =
            results.find((result) => result !== "done") ?? (yield* skipped(epoch, limit));
          if (skip === undefined) yield* perform(step, epoch, limit);
          results.push(skip ?? "done");
        }
        return { results, pixels: yield* settledFrame(epoch) };
      }),
    ).pipe(
      Effect.flatMap(({ results, pixels }) =>
        Effect.map(workers.encodePng(pixels), (png) => ({ results, png })),
      ),
    );

  return {
    act,
    look: run(settledFrame()).pipe(Effect.flatMap(workers.encodePng)),
    relay: (inputs, epoch) =>
      run(Effect.flatMap(current(epoch), (now) => (now ? press(inputs) : Effect.void))),
    release: run(Effect.suspend(() => press(releaseAll(held)))),
    ended: Deferred.await(end),
  } satisfies Hand;
});
