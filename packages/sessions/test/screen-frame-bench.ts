/**
 * What one frame costs the hand (ADR 0020, delivery 8), on a busy 1280x800 screen and on the worst
 * one a display can send. Starts TigerVNC Xvnc in a Docker container it names and removes, fills
 * the screen with text, records Xvnc's full ZRLE update, and prints one JSON line per series:
 *
 *   decode        that update decoded on one thread, from a fresh framebuffer
 *   encode        the decoded frame encoded as the hand's PNG
 *   worst-decode  a full update of random pixels in ZRLE run-length tiles, every run one pixel long:
 *                 the most decoding a display can ask of the hand for one update
 *   worst-encode  that frame's PNG
 *   look          `hand.look` end to end: the 300 ms quiet window, the copy and the encode
 *
 *   node packages/sessions/test/screen-frame-bench.ts [--runs 15]
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { deflateSync, constants } from "node:zlib";

import { Effect, Redacted } from "effect";

import { openHand } from "../src/screen/hand.ts";
import { encodePng } from "../src/screen/png.ts";
import { ENCODING } from "../src/screen/rfb-client.ts";
import {
  Framebuffer,
  HAND_SETUP,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "../src/screen/rfb-framebuffer.ts";
import { ByteQueue } from "../src/screen/rfb-queue.ts";
import { VncSignIn } from "../src/screen/rfb-sign-in.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "../src/screen/screen-workers.ts";
import { XVNC_PASSWORD, connect, startXvnc } from "./xvnc.ts";

const { values } = parseArgs({ options: { runs: { type: "string", default: "15" } } });
const runs = Number(values.runs);

const serverInit = () => {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(SCREEN_WIDTH, 0);
  init.writeUInt16BE(SCREEN_HEIGHT, 2);
  return init;
};

/** One rectangle over the whole screen, every tile plain run-length with a random colour per pixel. */
const worstUpdate = () => {
  const tiles: Array<Uint8Array> = [];
  for (let y = 0; y < SCREEN_HEIGHT; y += 64) {
    for (let x = 0; x < SCREEN_WIDTH; x += 64) {
      const pixels = Math.min(64, SCREEN_WIDTH - x) * Math.min(64, SCREEN_HEIGHT - y);
      const tile = randomBytes(pixels * 4);
      for (let length = 3; length < tile.length; length += 4) tile[length] = 0;
      tiles.push(Uint8Array.of(128), tile);
    }
  }
  const compressed = deflateSync(Buffer.concat(tiles), { finishFlush: constants.Z_SYNC_FLUSH });
  const header = Buffer.alloc(4 + 12 + 4);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(SCREEN_WIDTH, 8);
  header.writeUInt16BE(SCREEN_HEIGHT, 10);
  header.writeInt32BE(ENCODING.zrle, 12);
  header.writeUInt32BE(compressed.length, 16);
  return Buffer.concat([serverInit(), header, compressed]);
};

/** Signs in, asks for the whole screen, and answers every byte from ServerInit to the first update. */
const captureUpdate = async (port: number): Promise<Buffer> => {
  const connection = await connect(port);
  const signIn = new VncSignIn(XVNC_PASSWORD);
  const handshake = new ByteQueue();
  const decoding = new ByteQueue();
  const framebuffer = new Framebuffer();
  const recorded: Array<Uint8Array> = [];
  let signedIn = false;
  for (;;) {
    const read = await Effect.runPromise(connection.bytes.read());
    if (read.kind === "eof") throw new Error("Xvnc hung up");
    let chunk = read.bytes;
    if (!signedIn) {
      handshake.push(chunk);
      const step = signIn.read(handshake);
      if (step._tag === "Refused") throw new Error(step.reason);
      for (const bytes of step.send) await Effect.runPromise(connection.bytes.write(bytes));
      if (step._tag === "Pending") continue;
      signedIn = true;
      chunk = handshake.take(handshake.length);
    }
    recorded.push(chunk);
    decoding.push(chunk);
    const decoded = framebuffer.read(decoding);
    if (decoded._tag === "Refused") throw new Error(decoded.reason);
    for (const event of decoded.events) {
      if (event._tag === "Ready") {
        await Effect.runPromise(connection.bytes.write(Buffer.concat([...HAND_SETUP])));
      }
      if (event._tag === "Updated") {
        connection.cut();
        return Buffer.concat(recorded);
      }
    }
  }
};

const decode = (update: Buffer) => {
  const framebuffer = new Framebuffer();
  const queue = new ByteQueue();
  queue.push(update);
  const started = performance.now();
  const read = framebuffer.read(queue);
  const ms = performance.now() - started;
  const updated = read._tag === "Read" && read.events.some((event) => event._tag === "Updated");
  if (!updated) throw new Error("the update did not decode");
  return { ms, pixels: framebuffer.pixels };
};

const encode = (pixels: Uint8Array) => {
  const started = performance.now();
  const png = encodePng(pixels, SCREEN_WIDTH, SCREEN_HEIGHT);
  return { ms: performance.now() - started, bytes: png.length };
};

const bright = (pixels: Uint8Array) =>
  pixels.filter((value, index) => index % 4 !== 3 && value > 0x80).length;

const summary = (series: string, samples: ReadonlyArray<number>, extra: object = {}) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (share: number) =>
    Number((sorted[Math.floor(share * (sorted.length - 1))] ?? 0).toFixed(1));
  console.log(
    JSON.stringify({
      series,
      runs: sorted.length,
      medianMs: at(0.5),
      minMs: at(0),
      maxMs: at(1),
      ...extra,
    }),
  );
};

const xvnc = startXvnc(`mend-hand-bench-${process.pid}-${Date.now()}`);
try {
  xvnc.x("xsetroot -solid '#2e3440'");
  const terminals: ReadonlyArray<readonly [string, string]> = [
    ["+0+0", "#ffffff"],
    ["+640+0", "#fdf6e3"],
    ["+0+400", "#1e1e1e"],
    ["+640+400", "#ffffff"],
  ];
  for (const [at, colour] of terminals) {
    xvnc.start(
      "xterm",
      "-geometry",
      `104x29${at}`,
      "-fa",
      "DejaVu Sans Mono",
      "-fs",
      "9",
      "-bg",
      colour,
      "-e",
      "sh",
      "-c",
      "ls --color=always -lR /usr/share | head -n 400; sleep 600",
    );
  }
  xvnc.x("sleep 2");
  const busy = await captureUpdate(xvnc.port);
  const worst = worstUpdate();
  const series: Record<"decode" | "encode" | "worstDecode" | "worstEncode", Array<number>> = {
    decode: [],
    encode: [],
    worstDecode: [],
    worstEncode: [],
  };
  let pngBytes = 0;
  let worstPngBytes = 0;
  let brightChannels = 0;
  for (let run = 0; run < runs; run++) {
    const decoded = decode(busy);
    series.decode.push(decoded.ms);
    brightChannels = bright(decoded.pixels);
    const encoded = encode(decoded.pixels);
    series.encode.push(encoded.ms);
    pngBytes = encoded.bytes;
    const worstDecoded = decode(worst);
    series.worstDecode.push(worstDecoded.ms);
    const worstEncoded = encode(worstDecoded.pixels);
    series.worstEncode.push(worstEncoded.ms);
    worstPngBytes = worstEncoded.bytes;
  }
  summary("decode", series.decode, { updateBytes: busy.length, brightChannels });
  summary("encode", series.encode, { pngBytes });
  summary("worst-decode", series.worstDecode, { updateBytes: worst.length });
  summary("worst-encode", series.worstEncode, { pngBytes: worstPngBytes });

  const looks = await Effect.runPromise(
    Effect.gen(function* () {
      const connection = yield* Effect.promise(() => connect(xvnc.port));
      const hand = yield* openHand({
        bytes: connection.bytes,
        password: Redacted.make(XVNC_PASSWORD),
        currentEpoch: Effect.succeed(1),
      });
      const samples: Array<number> = [];
      for (let run = 0; run < runs; run++) {
        const started = performance.now();
        const png = yield* hand.look;
        if (png.length < 1_000) return yield* Effect.die(new Error("an empty frame"));
        samples.push(performance.now() - started);
      }
      return samples;
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );
  summary("look", looks);
} finally {
  xvnc.remove();
}
