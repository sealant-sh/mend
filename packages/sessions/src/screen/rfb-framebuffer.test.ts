import { createHash } from "node:crypto";
import * as zlib from "node:zlib";

import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CLIENT_HANDSHAKE,
  PASSWORD,
  RELAYED_CANVAS,
  RELAYED_SERVER,
  RELAYED_VIEWER,
  queueOf,
} from "../../test/rfb-fixtures.ts";
import {
  FRAMEBUFFER_BYTES,
  Framebuffer,
  HAND_SETUP,
  type FramebufferRead,
  MESSAGE_CEILING,
  SERVER_TEXT_CEILING,
} from "./rfb-framebuffer.ts";
import { ByteQueue } from "./rfb-queue.ts";
import { VncSignIn } from "./rfb-sign-in.ts";

const RAW = 0;
const COPY_RECT = 1;
const TIGHT = 7;
const ZRLE = 16;
const DESKTOP_SIZE = -223;

const bytes = (...fields: ReadonlyArray<readonly [size: 1 | 2 | 4, value: number]>) => {
  const out = Buffer.alloc(fields.reduce((sum, [size]) => sum + size, 0));
  let at = 0;
  for (const [size, value] of fields) {
    if (size === 4) out.writeInt32BE(value | 0, at);
    else out.writeUIntBE(value, at, size);
    at += size;
  }
  return out;
};

const serverInit = (width: number, height: number) =>
  Buffer.concat([
    bytes([2, width], [2, height], [4, 0], [4, 0], [4, 0], [4, 0], [4, 4]),
    Buffer.from("mend"),
  ]);

const update = (...rects: ReadonlyArray<Uint8Array>) =>
  Buffer.concat([bytes([1, 0], [1, 0], [2, rects.length]), ...rects]);

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  encoding: number,
  body = Buffer.alloc(0),
) => Buffer.concat([bytes([2, x], [2, y], [2, width], [2, height], [4, encoding]), body]);

const zrle = (x: number, y: number, width: number, height: number, tiles: Uint8Array) => {
  const compressed = zlib.deflateSync(tiles, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  return rect(
    x,
    y,
    width,
    height,
    ZRLE,
    Buffer.concat([bytes([4, compressed.length]), compressed]),
  );
};

const signedIn = () => {
  const framebuffer = new Framebuffer();
  framebuffer.read(queueOf(serverInit(1280, 800)));
  return framebuffer;
};

const refusal = (read: FramebufferRead) => (read._tag === "Refused" ? read.reason : undefined);

const pixelsAt = (framebuffer: Framebuffer, x: number, y: number, count: number) =>
  Array.from({ length: count }, (_, index) => [
    ...framebuffer.pixels.subarray((y * 1280 + x + index) * 4, (y * 1280 + x + index) * 4 + 3),
  ]);

const digest = (pixels: Uint8Array) => createHash("sha256").update(pixels).digest("hex");

const decodeCapture = (chunks: ReadonlyArray<Uint8Array>) => {
  const signIn = new VncSignIn(PASSWORD);
  const framebuffer = new Framebuffer();
  const queue = new ByteQueue();
  const events: string[] = [];
  for (const chunk of chunks) {
    queue.push(chunk);
    if (signIn.read(queue)._tag !== "SignedIn") continue;
    const read = framebuffer.read(queue);
    if (read._tag === "Refused") throw new Error(read.reason);
    events.push(...read.events.map((event) => event._tag));
  }
  return { digest: digest(framebuffer.pixels), events };
};

describe("Framebuffer on the capture", () => {
  const whole = decodeCapture([RELAYED_SERVER]);

  it("reads pixels in the format noVNC asked for", () => {
    const pixelFormat = RELAYED_VIEWER.subarray(CLIENT_HANDSHAKE, CLIENT_HANDSHAKE + 20);
    expect(Buffer.from(HAND_SETUP[0] ?? []).equals(pixelFormat)).toBe(true);
  });

  it("shows the pixels noVNC showed", () => {
    expect(whole.events[0]).toBe("Ready");
    expect(new Set(whole.events.slice(1))).toEqual(new Set(["Updated"]));
    expect(whole.digest).toBe(digest(RELAYED_CANVAS));
  });

  it("decodes the same at any chunk boundaries, one byte at a time included", () => {
    const oneByOne = decodeCapture(
      Array.from(RELAYED_SERVER, (_, at) => RELAYED_SERVER.subarray(at, at + 1)),
    );
    expect(oneByOne).toEqual(whole);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.uniqueArray(FastCheck.integer({ min: 1, max: RELAYED_SERVER.length - 1 }), {
          maxLength: 40,
        }),
        (cuts) => {
          const bounds = [0, ...cuts.toSorted((a, b) => a - b), RELAYED_SERVER.length];
          const chunks = bounds
            .slice(1)
            .map((end, index) => RELAYED_SERVER.subarray(bounds[index], end));
          expect(decodeCapture(chunks)).toEqual(whole);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("Framebuffer", () => {
  it("refuses a screen that is not 1280x800, at ServerInit or by DesktopSize", () => {
    expect(refusal(new Framebuffer().read(queueOf(serverInit(1920, 1080))))).toBe("screen-size");
    expect(
      refusal(signedIn().read(queueOf(update(rect(0, 0, 1280, 800, DESKTOP_SIZE))))),
    ).toBeUndefined();
    expect(refusal(signedIn().read(queueOf(update(rect(0, 0, 1920, 1080, DESKTOP_SIZE)))))).toBe(
      "screen-size",
    );
  });

  it("paints Raw rectangles opaque and copies overlapping CopyRect rows in order", () => {
    const framebuffer = signedIn();
    const raw = Buffer.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    framebuffer.read(
      queueOf(
        update(rect(10, 0, 1, 3, RAW, raw), rect(10, 1, 1, 3, COPY_RECT, bytes([2, 10], [2, 0]))),
      ),
    );
    expect(
      [0, 1, 2, 3].map((y) => [
        ...framebuffer.pixels.subarray((y * 1280 + 10) * 4, (y * 1280 + 10) * 4 + 4),
      ]),
    ).toEqual([
      [1, 2, 3, 255],
      [1, 2, 3, 255],
      [4, 5, 6, 255],
      [7, 8, 9, 255],
    ]);
  });

  it("decodes every ZRLE tile kind: solid, raw, packed palette, RLE and palette RLE", () => {
    const [red, green, blue, black, white, yellow, cyan] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [0, 0, 0],
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
    ];
    const area = 64 * 5;
    const grey = Array.from({ length: area }, (_, index) => [
      index % 256,
      index % 256,
      index % 256,
    ]);
    const tiles = Buffer.from(
      [
        [1, ...red],
        [0, ...grey.flat()],
        [2, ...black, ...white, ...Array.from({ length: 8 * 5 }, () => 0xaa)],
        [128, ...green, 255, 44, ...blue, 19],
        [130, ...yellow, ...cyan, 0x80, 255, 44, ...Array.from({ length: 20 }, () => 1)],
      ].flat(),
    );
    const framebuffer = signedIn();
    expect(framebuffer.read(queueOf(update(zrle(0, 10, 320, 5, tiles))))._tag).toBe("Read");
    const row = (y: number) => pixelsAt(framebuffer, 0, y, 320);
    const expected = (y: number) => [
      ...Array.from({ length: 64 }, () => red),
      ...grey.slice(y * 64, y * 64 + 64),
      ...Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? white : black)),
      ...Array.from({ length: 64 }, (_, index) => (y * 64 + index < 300 ? green : blue)),
      ...Array.from({ length: 64 }, (_, index) => (y * 64 + index < 300 ? yellow : cyan)),
    ];
    for (const y of [0, 1, 2, 3, 4]) expect(row(10 + y)).toEqual(expected(y));
  });

  it("refuses malformed ZRLE tiles and corrupt zlib", () => {
    const tile = (...tileBytes: number[]) => update(zrle(0, 0, 2, 1, Buffer.from(tileBytes)));
    const malformed = [
      tile(17, ...Array.from({ length: 17 * 3 }, () => 0)),
      tile(129, 0, 0, 0),
      tile(3, 0, 0, 0, 1, 1, 1, 2, 2, 2, 0xc0),
      tile(128, 9, 9, 9, 5),
      tile(0, 1, 2, 3),
      tile(1, 1, 2, 3, 0),
      update(
        rect(
          0,
          0,
          2,
          1,
          ZRLE,
          Buffer.concat([bytes([4, 6]), Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff])]),
        ),
      ),
    ];
    for (const stream of malformed)
      expect(refusal(signedIn().read(queueOf(stream)))).toBe("malformed");
  });

  it("refuses a zlib bomb without inflating past the rectangle's ceiling", () => {
    const bomb = zrle(0, 0, 64, 64, Buffer.alloc(64 * 1024 * 1024));
    const before = process.memoryUsage().arrayBuffers;
    expect(refusal(signedIn().read(queueOf(update(bomb))))).toBe("oversized");
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * 1024 * 1024);
  });

  it("refuses oversized lengths from their headers, before buffering the body", () => {
    const zrleHeader = rect(0, 0, 64, 64, ZRLE, bytes([4, MESSAGE_CEILING]));
    expect(refusal(signedIn().read(queueOf(update(zrleHeader))))).toBe("oversized");
    const cutText = bytes([1, 3], [1, 0], [2, 0], [4, SERVER_TEXT_CEILING + 1]);
    expect(refusal(signedIn().read(queueOf(cutText)))).toBe("oversized");
    const screen = rect(0, 0, 1280, 800, RAW, Buffer.alloc(FRAMEBUFFER_BYTES));
    expect(refusal(signedIn().read(queueOf(update(screen))))).toBeUndefined();
    const half = rect(0, 0, 1280, 400, RAW, Buffer.alloc(1280 * 400 * 4));
    expect(refusal(signedIn().read(queueOf(update(half, half, rect(0, 0, 1, 1, RAW)))))).toBe(
      "oversized",
    );
  });

  it("refuses rectangles outside the screen, other encodings and other message types", () => {
    expect(refusal(signedIn().read(queueOf(update(rect(1279, 0, 2, 1, RAW)))))).toBe(
      "outside-screen",
    );
    expect(
      refusal(
        signedIn().read(queueOf(update(rect(0, 0, 1, 1, COPY_RECT, bytes([2, 1280], [2, 0]))))),
      ),
    ).toBe("outside-screen");
    expect(refusal(signedIn().read(queueOf(update(rect(0, 0, 1, 1, TIGHT)))))).toBe("encoding");
    const framebuffer = signedIn();
    expect(refusal(framebuffer.read(queueOf(Uint8Array.of(150))))).toBe("message-type");
    expect(refusal(framebuffer.read(queueOf(update())))).toBe("message-type");
  });

  it("reports Bell and skips ServerCutText", () => {
    const read = signedIn().read(
      queueOf(Uint8Array.of(2), bytes([1, 3], [1, 0], [2, 0], [4, 2]), Buffer.from("hi"), update()),
    );
    expect(read).toEqual({
      _tag: "Read",
      events: [{ _tag: "Bell" }, { _tag: "Updated", rects: [] }],
    });
  });
});
