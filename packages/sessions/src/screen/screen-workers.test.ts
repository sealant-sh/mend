import { createHash } from "node:crypto";

import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { decodePng } from "../../test/png.ts";
import { PASSWORD, RELAYED_CANVAS, RELAYED_SERVER, queueOf } from "../../test/rfb-fixtures.ts";
import { VncSignIn } from "./rfb-sign-in.ts";
import { SCREEN_WORKER, ScreenWorkers, screenWorkersLayer } from "./screen-workers.ts";

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

  it.live("refuse what the codec refuses, on the worker as in process", () =>
    Effect.gen(function* () {
      const decoder = yield* (yield* ScreenWorkers).decoder;
      const tooWide = Buffer.alloc(24);
      tooWide.writeUInt16BE(1281, 0);
      tooWide.writeUInt16BE(800, 2);
      expect(yield* decoder.decode(tooWide)).toEqual({ _tag: "Refused", reason: "screen-size" });
    }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
  );
});
