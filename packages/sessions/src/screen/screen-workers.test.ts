import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Exit } from "effect";
import { describe, expect } from "vitest";

import { decodePng } from "../../test/png.ts";
import { PASSWORD, RELAYED_CANVAS, RELAYED_SERVER, queueOf } from "../../test/rfb-fixtures.ts";
import { SLOW_DECODE_CHANNEL } from "../../test/screen-worker-slow-decode.ts";
import { VncSignIn } from "./rfb-sign-in.ts";
import {
  SCREEN_WORKER,
  ScreenWorkers,
  WorkerStopped,
  screenWorkersLayer,
} from "./screen-workers.ts";

const SLOW_STARTING_WORKER = new URL("../../test/screen-worker-slow-start.ts", import.meta.url);
const SLOW_DECODING_WORKER = new URL("../../test/screen-worker-slow-decode.ts", import.meta.url);
const STOPS_MID_DECODE = fileURLToPath(
  new URL("../../test/screen-worker-stops.ts", import.meta.url),
);

const digest = (pixels: Uint8Array) => createHash("sha256").update(pixels).digest("hex");

const afterSignIn = (() => {
  const queue = queueOf(RELAYED_SERVER);
  new VncSignIn(PASSWORD).read(queue);
  return queue.take(queue.length);
})();

describe("screen frames off the server's thread", () => {
  it.live("decode the captured session to the pixels noVNC showed, and encode them as a PNG", () =>
    Effect.gen(function* () {
      const workers = yield* ScreenWorkers;
      const decoder = yield* workers.decoder;
      const halfway = Math.floor(afterSignIn.length / 2);
      for (const chunk of [afterSignIn.subarray(0, halfway), afterSignIn.subarray(halfway)]) {
        expect((yield* decoder.decode(chunk))._tag).toBe("Read");
      }
      const pixels = yield* decoder.copy;
      expect(digest(pixels)).toBe(digest(RELAYED_CANVAS));
      const png = decodePng(yield* workers.encodePng(pixels));
      const rgb = RELAYED_CANVAS.filter((_, index) => index % 4 !== 3);
      expect([png.width, png.height]).toEqual([1280, 800]);
      expect(digest(png.rgb)).toBe(digest(rgb));
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );

  it.live(
    "answer the first decode and encode of a thread that starts slower than a request may take",
    () =>
      Effect.gen(function* () {
        const workers = yield* ScreenWorkers;
        const decoder = yield* workers.decoder;
        expect((yield* decoder.decode(afterSignIn))._tag).toBe("Read");
        const png = decodePng(yield* workers.encodePng(yield* decoder.copy));
        expect([png.width, png.height]).toEqual([1280, 800]);
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SLOW_STARTING_WORKER))),
    { timeout: 30_000 },
  );

  it.live("refuse what the codec refuses, on the worker as in process", () =>
    Effect.gen(function* () {
      const decoder = yield* (yield* ScreenWorkers).decoder;
      const tooWide = Buffer.alloc(24);
      tooWide.writeUInt16BE(1281, 0);
      tooWide.writeUInt16BE(800, 2);
      expect(yield* decoder.decode(tooWide)).toEqual({ _tag: "Refused", reason: "screen-size" });
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );

  // SLNT-759: terminating a thread inside a zlib call aborts the whole process, the server in production.
  it.live(
    "survive hundreds of decoders stopped mid-decode, as viewers leaving a busy screen stop them",
    () =>
      Effect.gen(function* () {
        const { stdout } = yield* Effect.promise(() =>
          promisify(execFile)(process.execPath, [STOPS_MID_DECODE, "200"]),
        );
        expect(stdout).toContain("stopped 200 decoders mid-decode");
      }),
    { timeout: 120_000 },
  );

  it.live(
    "leave a decode past its deadline to finish, and fail the request at the deadline",
    () =>
      Effect.gen(function* () {
        const channel = new BroadcastChannel(SLOW_DECODE_CHANNEL);
        yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));
        const finished = yield* Deferred.make<void>();
        channel.addEventListener("message", () => Deferred.doneUnsafe(finished, Exit.void));
        const decoder = yield* (yield* ScreenWorkers).decoder;
        const decoded = yield* Effect.exit(decoder.decode(afterSignIn));
        expect(decoded).toEqual(Exit.fail(new WorkerStopped({ reason: "deadline" })));
        yield* Deferred.await(finished).pipe(Effect.timeout("5 seconds"));
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SLOW_DECODING_WORKER))),
    { timeout: 30_000 },
  );
});
