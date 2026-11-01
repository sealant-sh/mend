import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ScreenH264, type ScreenAccessUnit } from "./screen-h264.ts";

const start = Buffer.from([0, 0, 0, 1]);
const aud = Buffer.from([0x09, 0xf0]);
const annex = (...units: Array<Buffer>) => Buffer.concat(units.flatMap((unit) => [start, unit]));
const slice = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(5000, 0x55)]);
const sample = annex(
  aud,
  Buffer.from([0x67, 0x42, 0xe0, 0x1f]),
  Buffer.from([0x68, 0xce, 0x06]),
  slice,
  aud,
  Buffer.from([0x41, 0xaa]),
  aud,
  aud,
);

describe("the screen's Annex-B stream", () => {
  it("splits any TCP chunking, including split three/four-byte start codes, into the same access units", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 101 }), { minLength: 1, maxLength: 20 }),
        (sizes) => {
          const parser = new ScreenH264();
          const frames: Array<ScreenAccessUnit> = [];
          for (let offset = 0, i = 0; offset < sample.length; i++) {
            const size = sizes[i % sizes.length] ?? 1;
            const result = parser.push(sample.subarray(offset, offset + size));
            if (result === null) throw new Error("small stream refused");
            frames.push(...result);
            offset += size;
          }
          expect(frames.map((frame) => frame.keyframe)).toEqual([true, false]);
          expect(Buffer.from(frames[0]?.data ?? []).includes(slice)).toBe(true);
          expect(frames[1]?.data).toEqual(annex(aud, Buffer.from([0x41, 0xaa])));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("refuses a stream that never terminates its NAL instead of retaining it without a bound", () => {
    const parser = new ScreenH264();
    expect(parser.push(Buffer.alloc(8 * 1024 * 1024 + 1))).toBeNull();
  });
});
