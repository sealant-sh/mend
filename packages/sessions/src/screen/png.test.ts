import { inflateSync } from "node:zlib";

import { ProofRegion } from "@mend/domain/workbench";
import { Schema } from "effect";
import * as fc from "fast-check";
import { expect, it } from "vitest";

import { cropPng, encodePng } from "./png.ts";

const rgba = new Uint8Array(1280 * 800 * 4);
for (let y = 0; y < 800; y++) {
  for (let x = 0; x < 1280; x++)
    rgba.set([x % 256, y % 256, (x + y) % 256, 255], (y * 1280 + x) * 4);
}
const full = encodePng(rgba, 1280, 800);

it("crops real encoded frames to the selected dimensions and pixels", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 160, max: 1280 }),
      fc.integer({ min: 120, max: 800 }),
      fc.nat(),
      fc.nat(),
      (width, height, dx, dy) => {
        const region = Schema.decodeUnknownSync(ProofRegion)({
          x: dx % (1281 - width),
          y: dy % (801 - height),
          width,
          height,
        });
        const cropped = Buffer.from(cropPng(full, region));
        expect(cropped.readUInt32BE(16)).toBe(width);
        expect(cropped.readUInt32BE(20)).toBe(height);
        const rows = inflateSync(cropped.subarray(41, 41 + cropped.readUInt32BE(33)));
        const expected = Buffer.alloc((1 + width * 3) * height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const at = ((y + region.y) * 1280 + region.x + x) * 4;
            expected.set(rgba.subarray(at, at + 3), y * (1 + width * 3) + 1 + x * 3);
          }
        }
        expect(rows.equals(expected)).toBe(true);
      },
    ),
    { numRuns: 12 },
  );
});

it.each([
  { x: 1200, y: 0, width: 160, height: 120 },
  { x: 0, y: 750, width: 160, height: 120 },
  { x: -1, y: 0, width: 160, height: 120 },
  { x: 0, y: 0, width: 159, height: 120 },
  { x: 0, y: 0, width: 160, height: 119 },
  { x: 0.5, y: 0, width: 160, height: 120 },
])("refuses an invalid region %j", (region) => {
  expect(() => Schema.decodeUnknownSync(ProofRegion)(region)).toThrow();
  expect(() => cropPng(full, region)).toThrow("region must fit");
});

it("explains an out of bounds refusal", () => {
  expect(() =>
    Schema.decodeUnknownSync(ProofRegion)({ x: 1100, y: 0, width: 200, height: 120 }),
  ).toThrow("region must fit inside the 1280×800 screen");
});
