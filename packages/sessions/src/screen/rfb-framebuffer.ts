import { type ZlibOptions, constants, inflateRawSync } from "node:zlib";

import { ENCODING, framebufferUpdateRequest, setEncodings } from "./rfb-client.ts";
import { type ByteQueue, view } from "./rfb-queue.ts";

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const FRAMEBUFFER_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT * 4;
const RECT_HEADER = 12;
export const UPDATE_DECODED_CEILING = FRAMEBUFFER_BYTES;
export const MESSAGE_CEILING = RECT_HEADER + FRAMEBUFFER_BYTES;
export const SERVER_TEXT_CEILING = 65_536;

const ZLIB_WINDOW = 32_768;
const ZRLE_PALETTE_BYTES = 127 * 3;
const { raw: RAW, copyRect: COPY_RECT, zrle: ZRLE, desktopSize: DESKTOP_SIZE } = ENCODING;

/** SetPixelFormat: 32 bits per pixel, depth 24, little-endian true colour, R, G, B, X on the wire. */
const SET_PIXEL_FORMAT = Buffer.from("000000002018000100ff00ff00ff000810000000", "hex");

/** What the hand sends after ServerInit. The decoder reads pixels in this format only. */
export const HAND_SETUP: ReadonlyArray<Uint8Array> = [
  SET_PIXEL_FORMAT,
  setEncodings([ZRLE, COPY_RECT, RAW, DESKTOP_SIZE]),
  framebufferUpdateRequest(false, SCREEN_WIDTH, SCREEN_HEIGHT),
];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FramebufferEvent =
  | { readonly _tag: "Ready"; readonly name: string }
  | { readonly _tag: "Updated"; readonly rects: ReadonlyArray<Rect> }
  | { readonly _tag: "Bell" };

export type FramebufferRefusal =
  | "screen-size"
  | "outside-screen"
  | "message-type"
  | "encoding"
  | "oversized"
  | "malformed";

export type FramebufferRead =
  | { readonly _tag: "Read"; readonly events: ReadonlyArray<FramebufferEvent> }
  | { readonly _tag: "Refused"; readonly reason: FramebufferRefusal };

type Phase =
  | { readonly _tag: "Init" | "Idle" }
  | { readonly _tag: "Update"; remaining: number; decoded: number; readonly rects: Rect[] }
  | { readonly _tag: "Refused"; readonly reason: FramebufferRefusal };

class Refusal extends Error {
  readonly reason: FramebufferRefusal;
  constructor(reason: FramebufferRefusal) {
    super(reason);
    this.reason = reason;
  }
}

const refuse = (reason: FramebufferRefusal): never => {
  throw new Refusal(reason);
};

interface RectLayout {
  readonly head: number;
  readonly payload: (header: DataView, decodedSize: number) => number;
  readonly draw: (rect: Rect, body: Uint8Array) => void;
}

const WAIT = "wait";
type Step = FramebufferEvent | typeof WAIT | undefined;

const inflate = (compressed: Uint8Array, options: ZlibOptions): Buffer => {
  try {
    return inflateRawSync(compressed, options);
  } catch (error) {
    const code = error instanceof RangeError && "code" in error ? error.code : undefined;
    return refuse(code === "ERR_BUFFER_TOO_LARGE" ? "oversized" : "malformed");
  }
};

const within = (x: number, y: number, rect: Rect): boolean =>
  x + rect.width <= SCREEN_WIDTH && y + rect.height <= SCREEN_HEIGHT;

/** RFC 6143 §7.7.6: one 64x64 tile as packed RGB, from raw, solid, palette or run-length pixels. */
const zrleTile = (take: (size: number) => Uint8Array, width: number, height: number) => {
  const area = width * height;
  const kind = take(1)[0] ?? 0;
  if (kind === 0) return take(area * 3);
  const palette = take(kind === 128 ? 0 : 3 * (kind & 127));
  const colour = (index: number) => palette.subarray(index * 3, index * 3 + 3);
  const tile = new Uint8Array(area * 3);
  const fill = (from: number, count: number, rgb: Uint8Array) => {
    if (from + count > area || rgb.length !== 3) refuse("malformed");
    for (let pixel = from; pixel < from + count; pixel++) tile.set(rgb, pixel * 3);
    return from + count;
  };
  const runLength = () => {
    let run = 1;
    for (let more = 255; more === 255; run += more) more = take(1)[0] ?? 0;
    return run;
  };
  if (kind === 1) fill(0, area, colour(0));
  else if (kind <= 16) {
    const bits = kind === 2 ? 1 : kind <= 4 ? 2 : 4;
    for (let row = 0; row < height; row++) {
      const packed = take(Math.ceil((width * bits) / 8));
      for (let column = 0, bit = 0; column < width; column++, bit += bits) {
        const index = ((packed[bit >> 3] ?? 0) >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        fill(row * width + column, 1, colour(index));
      }
    }
  } else if (kind === 128) {
    for (let filled = 0; filled < area; ) {
      const rgb = take(3);
      filled = fill(filled, runLength(), rgb);
    }
  } else if (kind >= 130) {
    for (let filled = 0; filled < area; ) {
      const index = take(1)[0] ?? 0;
      filled = fill(filled, index & 128 ? runLength() : 1, colour(index & 127));
    }
  } else refuse("malformed");
  return tile;
};

/** The hand's decoder from ServerInit on: bytes in, pixels changed or a refusal out. */
export class Framebuffer {
  readonly pixels = new Uint8Array(FRAMEBUFFER_BYTES);
  private phase: Phase = { _tag: "Init" };
  private history: Uint8Array | undefined;
  private readonly encodings: ReadonlyMap<number, RectLayout> = new Map([
    [RAW, { head: 0, payload: (_, size) => size, draw: (rect, body) => this.paint(rect, body, 4) }],
    [
      COPY_RECT,
      {
        head: 4,
        payload: () => 0,
        draw: (rect, body) => this.copy(rect, view(body).getUint16(0), view(body).getUint16(2)),
      },
    ],
    [
      ZRLE,
      {
        head: 4,
        payload: (header) => header.getUint32(RECT_HEADER),
        draw: (rect, body) => this.zrle(rect, body.subarray(4)),
      },
    ],
  ]);

  read(queue: ByteQueue): FramebufferRead {
    const events: FramebufferEvent[] = [];
    try {
      for (let step = this.step(queue); step !== WAIT; step = this.step(queue)) {
        if (step !== undefined) events.push(step);
      }
      return this.phase._tag === "Refused" ? this.phase : { _tag: "Read", events };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      this.phase = { _tag: "Refused", reason: error.reason };
      return this.phase;
    }
  }

  private step(queue: ByteQueue): Step {
    const phase = this.phase;
    if (phase._tag === "Refused") return WAIT;
    if (phase._tag === "Update") return this.rect(queue, phase);
    if (phase._tag === "Init") return this.serverInit(queue);
    if (queue.length < 1) return WAIT;
    const type = queue.peek(1)[0];
    if (type === 2) {
      queue.take(1);
      return { _tag: "Bell" };
    }
    if (type === 0) {
      if (queue.length < 4) return WAIT;
      const remaining = view(queue.take(4)).getUint16(2);
      this.phase = { _tag: "Update", remaining, decoded: 0, rects: [] };
      return undefined;
    }
    if (type !== 3) return refuse("message-type");
    if (queue.length < 8) return WAIT;
    const length = 8 + view(queue.peek(8)).getUint32(4);
    if (length > 8 + SERVER_TEXT_CEILING) refuse("oversized");
    if (queue.length < length) return WAIT;
    queue.take(length);
    return undefined;
  }

  private serverInit(queue: ByteQueue): Step {
    if (queue.length < 24) return WAIT;
    const init = view(queue.peek(24));
    if (init.getUint16(0) !== SCREEN_WIDTH || init.getUint16(2) !== SCREEN_HEIGHT) {
      refuse("screen-size");
    }
    const length = 24 + init.getUint32(20);
    if (length > 24 + SERVER_TEXT_CEILING) refuse("oversized");
    if (queue.length < length) return WAIT;
    this.phase = { _tag: "Idle" };
    return { _tag: "Ready", name: Buffer.from(queue.take(length).subarray(24)).toString() };
  }

  private rect(queue: ByteQueue, update: Extract<Phase, { _tag: "Update" }>): Step {
    if (update.remaining === 0) {
      this.phase = { _tag: "Idle" };
      return { _tag: "Updated", rects: update.rects };
    }
    if (queue.length < RECT_HEADER) return WAIT;
    const header = view(queue.peek(RECT_HEADER));
    const rect = {
      x: header.getUint16(0),
      y: header.getUint16(2),
      width: header.getUint16(4),
      height: header.getUint16(6),
    };
    const encoding = header.getInt32(8);
    if (encoding === DESKTOP_SIZE) {
      if (rect.width !== SCREEN_WIDTH || rect.height !== SCREEN_HEIGHT) refuse("screen-size");
      queue.take(RECT_HEADER);
      update.remaining--;
      return undefined;
    }
    const layout = this.encodings.get(encoding) ?? refuse("encoding");
    const size = rect.width * rect.height * 4;
    if (!within(rect.x, rect.y, rect)) refuse("outside-screen");
    if (update.decoded + size > UPDATE_DECODED_CEILING) refuse("oversized");
    const head = RECT_HEADER + layout.head;
    if (queue.length < head) return WAIT;
    const length = head + layout.payload(view(queue.peek(head)), size);
    if (length > MESSAGE_CEILING) refuse("oversized");
    if (queue.length < length) return WAIT;
    layout.draw(rect, queue.take(length).subarray(RECT_HEADER));
    update.remaining--;
    update.decoded += size;
    update.rects.push(rect);
    return undefined;
  }

  private paint(rect: Rect, source: Uint8Array, stride: 3 | 4): void {
    let from = 0;
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      let at = (row * SCREEN_WIDTH + rect.x) * 4;
      for (let column = 0; column < rect.width; column++, at += 4, from += stride) {
        this.pixels[at] = source[from] ?? 0;
        this.pixels[at + 1] = source[from + 1] ?? 0;
        this.pixels[at + 2] = source[from + 2] ?? 0;
        this.pixels[at + 3] = 255;
      }
    }
  }

  private copy(rect: Rect, fromX: number, fromY: number): void {
    if (!within(fromX, fromY, rect)) refuse("outside-screen");
    const rows = Array.from({ length: rect.height }, (_, row) => row);
    for (const row of fromY < rect.y ? rows.toReversed() : rows) {
      const from = ((fromY + row) * SCREEN_WIDTH + fromX) * 4;
      this.pixels.copyWithin(
        ((rect.y + row) * SCREEN_WIDTH + rect.x) * 4,
        from,
        from + rect.width * 4,
      );
    }
  }

  /** ZRLE shares one zlib stream across rectangles, so the last 32 KiB of output is the next dictionary. */
  private zrle(rect: Rect, compressed: Uint8Array): void {
    const tiles = Math.ceil(rect.width / 64) * Math.ceil(rect.height / 64);
    const data = inflate(this.history === undefined ? compressed.subarray(2) : compressed, {
      finishFlush: constants.Z_SYNC_FLUSH,
      maxOutputLength: Math.max(1, rect.width * rect.height * 4 + tiles * (1 + ZRLE_PALETTE_BYTES)),
      ...(this.history === undefined ? {} : { dictionary: this.history }),
    });
    this.history = Buffer.concat([this.history ?? new Uint8Array(), data]).subarray(-ZLIB_WINDOW);
    let at = 0;
    const take = (size: number) =>
      at + size > data.length ? refuse("malformed") : data.subarray(at, (at += size));
    for (let y = rect.y; y < rect.y + rect.height; y += 64) {
      for (let x = rect.x; x < rect.x + rect.width; x += 64) {
        const width = Math.min(64, rect.x + rect.width - x);
        const height = Math.min(64, rect.y + rect.height - y);
        this.paint({ x, y, width, height }, zrleTile(take, width, height), 3);
      }
    }
    if (at !== data.length) refuse("malformed");
  }
}
