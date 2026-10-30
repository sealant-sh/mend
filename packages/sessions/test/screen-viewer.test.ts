import { SessionId, ViewerConnectionId } from "@mend/domain";
import { it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Option, Queue, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { setEncodings } from "../src/screen/rfb-client.ts";
import { ByteQueue, view } from "../src/screen/rfb-queue.ts";
import { relayViewer, type ViewerBytes, VIEWER_UNSENT_CEILING } from "../src/screen/viewer.ts";
import { eventually } from "./screen-world.ts";
import { type Connection, type Xvnc, connect, dockerReady, startXvnc } from "./xvnc.ts";

const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const CLIENT_INIT = Uint8Array.of(1);
/** 32 bits per pixel, as noVNC asks. */
const PIXEL_FORMAT = Uint8Array.from([
  0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
]);
const UNKNOWN = Uint8Array.of(250);
const updateRequest = (w: number, h: number) =>
  Uint8Array.of(3, 0, 0, 0, 0, 0, w >> 8, w & 0xff, h >> 8, h & 0xff);
const SMALL_REQUEST = updateRequest(1, 1);
const FULL_REQUEST = updateRequest(1280, 800);
const WATCHER = {
  sessionId: SessionId.make("screen-viewer"),
  connection: ViewerConnectionId.make("vc-screen-viewer"),
  mayTakeInput: false,
};

/** How long the relay may take to act on bytes it already holds. */
const PROMPTLY = "2 seconds";

/**
 * A viewer's side as the API's socket gives it, written chunk by chunk. `stall` makes every later
 * write wait for good, as a writer behind a socket that no longer drains.
 */
const makeViewer = Effect.gen(function* () {
  const toRelay = yield* Queue.unbounded<Uint8Array | null>();
  const fromRelay = yield* Queue.unbounded<Uint8Array>();
  const received = new ByteQueue();
  const stalled = yield* Deferred.make<void>();
  let stall = false;
  let written = 0;
  let taken = 0;
  let readers = 0;
  const bytes: ViewerBytes = {
    read: Effect.acquireUseRelease(
      Effect.sync(() => void readers++),
      () => Queue.take(toRelay),
      () => Effect.sync(() => void readers--),
    ),
    write: (chunk) =>
      Effect.gen(function* () {
        written += chunk.length;
        yield* Queue.offer(fromRelay, chunk);
        if (stall) yield* Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never));
      }),
    unsent: Effect.sync(() => written - taken),
  };
  const take = (count: number) =>
    Effect.gen(function* () {
      while (received.length < count) received.push(yield* Queue.take(fromRelay));
      taken += count;
      return received.take(count);
    });
  const send = (...chunks: ReadonlyArray<Uint8Array>) =>
    Queue.offer(toRelay, Buffer.concat(chunks));
  return {
    bytes,
    send,
    leave: Queue.offer(toRelay, null),
    readers: () => readers,
    unsent: () => written - taken,
    stalled,
    stallWrites: Effect.sync(() => {
      stall = true;
    }),
    /** Through the security result; ClientInit, and anything with it, is the caller's. */
    security: Effect.gen(function* () {
      expect(Buffer.from(yield* take(12)).equals(VERSION)).toBe(true);
      yield* send(VERSION);
      expect([...(yield* take(2))]).toEqual([1, 1]);
      yield* send(Uint8Array.of(1));
      expect([...(yield* take(4))]).toEqual([0, 0, 0, 0]);
    }),
    serverInit: Effect.gen(function* () {
      const init = view(yield* take(24));
      expect([init.getUint16(0), init.getUint16(2)]).toEqual([1280, 800]);
      yield* take(init.getUint32(20));
    }),
    /** The type of the next message from the screen: 0 for a FramebufferUpdate. */
    update: Effect.map(take(4), (header) => view(header).getUint8(0)),
  };
});

describe.skipIf(!dockerReady)("the viewer relay, against TigerVNC Xvnc", () => {
  let xvnc: Xvnc | undefined;
  beforeAll(() => {
    xvnc = startXvnc(`mend-screen-viewer-${process.pid}-${Date.now()}`);
    xvnc.signWith("viewer-full", "viewer-view");
  }, 120_000);
  afterAll(() => xvnc?.remove());

  const relay = (viewer: ViewerBytes) =>
    Effect.gen(function* () {
      const port = xvnc?.port;
      if (port === undefined) throw new Error("no Xvnc");
      const connections: Array<Connection> = [];
      let released = 0;
      const dial = Effect.acquireRelease(
        Effect.promise(() => connect(port)),
        (connection) =>
          Effect.andThen(
            connection.bytes.close(),
            Effect.sync(() => void released++),
          ),
      ).pipe(
        Effect.map((connection) => {
          connections.push(connection);
          return { bytes: connection.bytes, password: Redacted.make("viewer-view") };
        }),
      );
      const inputs: Array<unknown> = [];
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          relayViewer(WATCHER, viewer, {
            dial,
            input: (each) => Effect.sync(() => inputs.push(each) > 0),
            paste: (text) => Effect.sync(() => inputs.push(text) > 0),
          }),
        ),
      );
      return {
        fiber,
        connections,
        inputs,
        released: () => released,
        ended: Fiber.join(fiber).pipe(Effect.timeoutOption(PROMPTLY)),
      };
    });

  it.live(
    "answers messages that came in the ClientInit's chunk without waiting for another",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, setEncodings([0]), SMALL_REQUEST);
        yield* viewer.serverInit;
        expect(yield* viewer.update.pipe(Effect.timeoutOption(PROMPTLY))).toEqual(Option.some(0));
      }),
    { timeout: 60_000 },
  );

  it.live(
    "answers every message of one chunk, and ends a viewer whose chunk holds an unknown one behind valid ones",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT);
        yield* viewer.serverInit;
        yield* viewer.send(PIXEL_FORMAT, setEncodings([0]), SMALL_REQUEST);
        expect(yield* viewer.update.pipe(Effect.timeoutOption(PROMPTLY))).toEqual(Option.some(0));
        yield* viewer.send(SMALL_REQUEST, SMALL_REQUEST, UNKNOWN);
        expect(yield* watched.ended).toEqual(
          Option.some({ _tag: "ViewerRefused", reason: "unknown-type" }),
        );
        expect(watched.released(), "the screen's connection is closed").toBe(1);
        expect(viewer.readers(), "nothing still reads the viewer").toBe(0);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "ends a viewer whose unknown message came in the ClientInit's chunk",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, UNKNOWN);
        expect(yield* watched.ended).toEqual(
          Option.some({ _tag: "ViewerRefused", reason: "unknown-type" }),
        );
        expect(watched.released()).toBe(1);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "closes a viewer that reads nothing before a write would take it past the ceiling",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, setEncodings([0]));
        yield* viewer.serverInit;
        // Xvnc answers requests one frame at a time, so they are asked for one after another.
        yield* eventually(
          () =>
            Effect.gen(function* () {
              if (watched.fiber.pollUnsafe() !== undefined) return true;
              yield* viewer.send(FULL_REQUEST);
              return false;
            }),
          "the relay never closed the viewer",
        );
        const ended = yield* Fiber.join(watched.fiber);
        expect(ended._tag).toBe("FellBehind");
        expect(ended._tag === "FellBehind" && ended.unsent).toBeGreaterThan(VIEWER_UNSENT_CEILING);
        expect(viewer.unsent(), "no write went past the ceiling").toBeLessThanOrEqual(
          VIEWER_UNSENT_CEILING,
        );
        expect(watched.released()).toBe(1);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "closes a viewer behind a write that never returns, once the screen sends past the ceiling",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, setEncodings([0]));
        yield* viewer.serverInit;
        yield* viewer.stallWrites;
        yield* eventually(
          () =>
            Effect.gen(function* () {
              if (watched.fiber.pollUnsafe() !== undefined) return true;
              yield* viewer.send(FULL_REQUEST);
              return false;
            }),
          "the relay never closed the viewer",
        );
        expect(yield* Deferred.isDone(viewer.stalled), "a write was waiting").toBe(true);
        expect((yield* Fiber.join(watched.fiber))._tag).toBe("FellBehind");
        expect(watched.released()).toBe(1);
        expect(viewer.readers()).toBe(0);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "ends at once when the screen goes while a write to the viewer waits",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, setEncodings([0]));
        yield* viewer.serverInit;
        yield* viewer.stallWrites;
        yield* viewer.send(SMALL_REQUEST);
        yield* Deferred.await(viewer.stalled);
        watched.connections[0]?.cut();
        expect(yield* watched.ended).toEqual(Option.some({ _tag: "ScreenEnded", how: "closed" }));
        expect(watched.released()).toBe(1);
        expect(viewer.readers()).toBe(0);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "ends at once when the viewer leaves while a write to it waits",
    () =>
      Effect.gen(function* () {
        const viewer = yield* makeViewer;
        const watched = yield* relay(viewer.bytes);
        yield* viewer.security;
        yield* viewer.send(CLIENT_INIT, PIXEL_FORMAT, setEncodings([0]));
        yield* viewer.serverInit;
        yield* viewer.stallWrites;
        yield* viewer.send(SMALL_REQUEST);
        yield* Deferred.await(viewer.stalled);
        yield* viewer.leave;
        expect(yield* watched.ended).toEqual(Option.some({ _tag: "ViewerLeft" }));
        expect(watched.released()).toBe(1);
        expect(viewer.readers()).toBe(0);
        expect(watched.inputs, "a watcher's input reached nothing").toEqual([]);
      }),
    { timeout: 60_000 },
  );
});
