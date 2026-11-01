import { ScreenRtcUnavailable } from "@mend/api-contracts";
import type { ForwardRead } from "@mend/sealant";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { expect } from "vitest";

import { streamScreenVideo, type ScreenVideoFrame } from "./screen-video.ts";

type Frame = ScreenVideoFrame;
const annex = (...units: Array<ReadonlyArray<number>>) =>
  Buffer.from(units.flatMap((unit) => [0, 0, 0, 1, ...unit]));
const aud = [9, 0xf0];
const headers = [
  [0x67, 0x42, 0xe0, 0x1f],
  [0x68, 0xce, 0x06],
];
// Each chunk terminates its frame's AUD. The next chunk continues from that delimiter.
const frame = (marker: number, idr = false, complete = true) =>
  Buffer.concat([
    annex(...(idr && complete ? headers : []), [idr ? 0x65 : 0x41, marker], aud),
    Buffer.from([0, 0, 0, 1]),
  ]);

const send = (bytes: Queue.Queue<ForwardRead>, chunk: Buffer) =>
  Queue.offer(bytes, { kind: "bytes", bytes: chunk });

const fixture = (initialPointer = true) =>
  Effect.gen(function* () {
    let pointer = initialPointer;
    const opens = yield* Queue.unbounded<{
      pointer: boolean;
      bytes: Queue.Queue<ForwardRead>;
      closed: Deferred.Deferred<void>;
    }>();
    const emitted = yield* Queue.unbounded<Frame>();
    const packets: Array<Frame> = [];
    const fiber = yield* Effect.forkScoped(
      streamScreenVideo({
        pointer: Effect.sync(() => pointer),
        open: (showPointer) =>
          Effect.gen(function* () {
            const bytes = yield* Queue.unbounded<ForwardRead>();
            const closed = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            yield* Queue.offer(opens, { pointer: showPointer, bytes, closed });
            return { read: () => Queue.take(bytes) };
          }),
        emit: (value) => {
          packets.push(value);
          Queue.offerUnsafe(emitted, value);
        },
      }),
    );
    return {
      fiber,
      opens,
      emitted,
      packets,
      send,
      hold: (person: boolean) =>
        Effect.sync(() => {
          pointer = !person;
        }),
    };
  });

it.effect(
  "keeps the old upstream until the replacement's complete IDR, with arrival timestamps",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const old = yield* Queue.take(f.opens);
      expect(old.pointer).toBe(true);
      yield* f.send(old.bytes, Buffer.concat([annex(aud), frame(10, true)]));
      yield* Queue.take(f.emitted);
      yield* f.hold(true);
      yield* TestClock.adjust("100 millis");
      const next = yield* Queue.take(f.opens);
      expect(next.pointer).toBe(false);
      yield* f.send(next.bytes, Buffer.concat([annex(aud), frame(20), frame(21, true, false)]));
      yield* f.send(old.bytes, frame(11));
      const continuing = yield* Queue.take(f.emitted);
      expect(Buffer.from(continuing.data).includes(annex([0x41, 11]))).toBe(true);
      expect(Deferred.isDoneUnsafe(old.closed)).toBe(false);
      yield* f.send(next.bytes, frame(22, true));
      const switched = yield* Queue.take(f.emitted);
      expect(switched.keyframe).toBe(true);
      expect(Buffer.from(switched.data).includes(annex([0x65, 22]))).toBe(true);
      yield* Deferred.await(old.closed);
      yield* f.send(old.bytes, frame(12));
      yield* f.send(next.bytes, frame(23));
      yield* Queue.take(f.emitted);
      expect(
        f.packets.some((v) =>
          [12, 20, 21].some((marker) =>
            Buffer.from(v.data).includes(annex([marker === 21 ? 0x65 : 0x41, marker])),
          ),
        ),
      ).toBe(false);

      // Hand back selects the pointer encoder again without replacing any viewer track.
      yield* f.hold(false);
      yield* TestClock.adjust("100 millis");
      const back = yield* Queue.take(f.opens);
      expect(back.pointer).toBe(true);
      yield* f.send(back.bytes, Buffer.concat([annex(aud), frame(30, true)]));
      yield* Queue.take(f.emitted);
      yield* Deferred.await(next.closed);
      expect(f.packets).toHaveLength(5);
      expect(f.packets.map((v) => v.receivedAt)).toEqual([0, 100, 100, 100, 200]);
      yield* Fiber.interrupt(f.fiber);
      expect(Deferred.isDoneUnsafe(back.closed)).toBe(true);
    }),
);

it.effect("keeps feeding the current stream if the replacement ends, then retries", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* Queue.take(f.opens);
    yield* f.send(old.bytes, Buffer.concat([annex(aud), frame(10, true)]));
    yield* Queue.take(f.emitted);
    yield* f.hold(true);
    yield* TestClock.adjust("100 millis");
    const failed = yield* Queue.take(f.opens);
    yield* Queue.offer(failed.bytes, { kind: "eof" });
    yield* Deferred.await(failed.closed);
    yield* f.send(old.bytes, frame(11));
    yield* Queue.take(f.emitted);
    yield* TestClock.adjust("100 millis");
    const retry = yield* Queue.take(f.opens);
    expect(retry.pointer).toBe(false);
    yield* Fiber.interrupt(f.fiber);
    expect(Deferred.isDoneUnsafe(old.closed)).toBe(true);
    expect(Deferred.isDoneUnsafe(retry.closed)).toBe(true);
  }),
);

it.effect("reports an initial encoder failure instead of leaving signalling waiting", () =>
  Effect.gen(function* () {
    const result = yield* streamScreenVideo({
      pointer: Effect.succeed(true),
      open: () => Effect.fail(new ScreenRtcUnavailable()),
      emit: () => {},
    }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("starts without the pointer if a person already holds input", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    const first = yield* Queue.take(f.opens);
    expect(first.pointer).toBe(false);
    yield* f.send(first.bytes, Buffer.concat([annex(aud), frame(10, true)]));
    expect((yield* Queue.take(f.emitted)).keyframe).toBe(true);
  }),
);

it.effect("discards a pending replacement if the holder changes back before its IDR", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* Queue.take(f.opens);
    yield* f.send(old.bytes, Buffer.concat([annex(aud), frame(10, true)]));
    yield* Queue.take(f.emitted);
    yield* f.hold(true);
    yield* TestClock.adjust("100 millis");
    const next = yield* Queue.take(f.opens);
    yield* f.hold(false);
    yield* f.send(next.bytes, Buffer.concat([annex(aud), frame(20, true)]));
    yield* Deferred.await(next.closed);
    yield* f.send(old.bytes, frame(11));
    const continued = yield* Queue.take(f.emitted);
    expect(Buffer.from(continued.data).includes(annex([0x41, 11]))).toBe(true);
    expect(Deferred.isDoneUnsafe(old.closed)).toBe(false);
  }),
);
