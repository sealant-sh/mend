/**
 * Stops screen decoders while they decode, `STOPS` times, through `ScreenWorkers` as a hand does
 * when its viewer leaves: each round opens a decoder, sends it an update of thousands of small ZRLE
 * rectangles (one `inflateRawSync` each), and closes the decoder's scope 0-5 ms later. Terminating
 * a thread between a zlib handle's construction and its init aborts the whole process
 * (`close before init`, SLNT-759), so this prints a line and exits 0 only if every stop is safe.
 *
 *   node packages/sessions/test/screen-worker-stops.ts [stops]
 */
import { constants, deflateRawSync, deflateSync } from "node:zlib";

import { Duration, Effect } from "effect";

import { ENCODING } from "../src/screen/rfb-client.ts";
import { SCREEN_WORKER, ScreenWorkers, screenWorkersLayer } from "../src/screen/screen-workers.ts";

const STOPS = Number(process.argv[2] ?? 200);
const RECTS = 4000;

/** One ZRLE tile of one colour: subencoding 1, then its single palette entry. */
const SOLID_TILE = Uint8Array.of(1, 255, 0, 0);
const SYNC = { finishFlush: constants.Z_SYNC_FLUSH };

const serverInit = () => {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  return init;
};

const zrleRect = (compressed: Uint8Array) => {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(8, 4);
  header.writeUInt16BE(8, 6);
  header.writeInt32BE(ENCODING.zrle, 8);
  header.writeUInt32BE(compressed.length, 12);
  return Buffer.concat([header, compressed]);
};

const update = (rects: ReadonlyArray<Uint8Array>) => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(rects.length, 2);
  return Buffer.concat([header, ...rects]);
};

/** ServerInit and the stream's first rectangle, which carries the zlib header. */
const opening = Buffer.concat([serverInit(), update([zrleRect(deflateSync(SOLID_TILE, SYNC))])]);
const busy = update(
  Array.from({ length: RECTS }, () => zrleRect(deflateRawSync(SOLID_TILE, SYNC))),
);

const stopMidDecode = (round: number) =>
  Effect.gen(function* () {
    const decoder = yield* (yield* ScreenWorkers).decoder;
    const opened = yield* decoder.decode(opening);
    if (opened._tag !== "Read")
      return yield* Effect.die(new Error(`opening refused: ${opened.reason}`));
    yield* Effect.forkScoped(decoder.decode(busy));
    yield* Effect.sleep(Duration.millis(round % 6));
  }).pipe(Effect.scoped);

await Effect.runPromise(
  Effect.forEach(
    Array.from({ length: STOPS }, (_, round) => round),
    stopMidDecode,
    {
      discard: true,
    },
  ).pipe(Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
);
console.log(`stopped ${STOPS} decoders mid-decode`);
