import { Effect, Queue } from "effect";

import { type Input, clientCutText, encodeInput, setEncodings } from "../src/screen/rfb-client.ts";
import { ByteQueue, view } from "../src/screen/rfb-queue.ts";
import type { ViewerBytes } from "../src/screen/viewer.ts";

const VERSION = "RFB 003.008\n";

const message = (size: number, write: (bytes: DataView) => void): Uint8Array => {
  const bytes = new Uint8Array(size);
  write(view(bytes));
  return bytes;
};

/** 32 bits per pixel, little-endian, red at bit 16, green at 8, blue at 0. */
const SET_PIXEL_FORMAT = message(20, (m) => {
  m.setUint8(4, 32);
  m.setUint8(5, 24);
  m.setUint8(7, 1);
  m.setUint16(8, 255);
  m.setUint16(10, 255);
  m.setUint16(12, 255);
  m.setUint8(14, 16);
  m.setUint8(15, 8);
});

const updateRequest = (at: { x: number; y: number; w: number; h: number }) =>
  message(10, (m) => {
    m.setUint8(0, 3);
    m.setUint16(2, at.x);
    m.setUint16(4, at.y);
    m.setUint16(6, at.w);
    m.setUint16(8, at.h);
  });

/**
 * A hand-written RFB viewer on the far side of the relay, in place of a browser's noVNC. With
 * `drains: false` it reads nothing, so every byte the relay writes stays unsent.
 */
export const makeTestViewer = (options: { readonly drains: boolean } = { drains: true }) =>
  Effect.gen(function* () {
    const toRelay = yield* Queue.unbounded<Uint8Array | null>();
    const fromRelay = yield* Queue.unbounded<Uint8Array>();
    const received = new ByteQueue();
    let written = 0;
    const bytes: ViewerBytes = {
      read: Queue.take(toRelay),
      write: (chunk) =>
        Effect.sync(() => {
          written += chunk.length;
        }).pipe(Effect.andThen(Queue.offer(fromRelay, chunk)), Effect.asVoid),
      unsent: Effect.sync(() => (options.drains ? 0 : written)),
    };
    const take = (count: number) =>
      Effect.gen(function* () {
        while (received.length < count) received.push(yield* Queue.take(fromRelay));
        return received.take(count);
      });
    const send = (...messages: ReadonlyArray<Uint8Array>) =>
      Effect.forEach(messages, (each) => Queue.offer(toRelay, each), { discard: true });

    /** Reads one FramebufferUpdate in Raw, answering the colour at `at` when a rectangle holds it. */
    const readUpdate = (at: { x: number; y: number }) =>
      Effect.gen(function* () {
        const header = view(yield* take(4));
        if (header.getUint8(0) !== 0) throw new Error(`not an update: ${header.getUint8(0)}`);
        let seen: ReadonlyArray<number> | null = null;
        for (let rect = 0; rect < header.getUint16(2); rect++) {
          const head = view(yield* take(12));
          const x = head.getUint16(0);
          const y = head.getUint16(2);
          const w = head.getUint16(4);
          const h = head.getUint16(6);
          if (head.getInt32(8) !== 0) throw new Error("only Raw was asked for");
          const pixels = yield* take(w * h * 4);
          if (at.x < x || at.y < y || at.x >= x + w || at.y >= y + h) continue;
          const offset = ((at.y - y) * w + (at.x - x)) * 4;
          seen = [pixels[offset + 2] ?? -1, pixels[offset + 1] ?? -1, pixels[offset] ?? -1];
        }
        return seen;
      });

    return {
      bytes,
      send,
      /** Through ServerInit, as noVNC signs in; answers the screen's size. */
      hello: Effect.gen(function* () {
        const greeting = Buffer.from(yield* take(12)).toString("latin1");
        if (greeting !== VERSION) throw new Error(`greeted with ${JSON.stringify(greeting)}`);
        yield* send(Buffer.from(VERSION, "latin1"));
        const security = yield* take(2);
        if (security[0] !== 1 || security[1] !== 1) throw new Error("not offered None alone");
        yield* send(Uint8Array.of(1));
        if (view(yield* take(4)).getUint32(0) !== 0) throw new Error("security refused");
        yield* send(Uint8Array.of(1));
        const init = view(yield* take(24));
        yield* take(init.getUint32(20));
        yield* send(SET_PIXEL_FORMAT, setEncodings([0]));
        return { width: init.getUint16(0), height: init.getUint16(2) };
      }),
      /** The colour at one point of a full, fresh frame. */
      colourAt: (at: { x: number; y: number }) =>
        Effect.gen(function* () {
          yield* send(updateRequest({ x: 0, y: 0, w: 1280, h: 800 }));
          return yield* readUpdate(at);
        }),
      /** A one-pixel round trip: everything sent before it has been through the relay. */
      settled: Effect.gen(function* () {
        yield* send(updateRequest({ x: 0, y: 0, w: 1, h: 1 }));
        yield* readUpdate({ x: 0, y: 0 });
      }),
      input: (...inputs: ReadonlyArray<Input>) => send(...inputs.map(encodeInput)),
      paste: (text: string) => send(clientCutText(text)),
      /** Asks for a full frame, and reads nothing. */
      askFullFrame: send(updateRequest({ x: 0, y: 0, w: 1280, h: 800 })),
      leave: Queue.offer(toRelay, null),
    };
  });
