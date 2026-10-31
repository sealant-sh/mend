import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RtpPacket } from "werift";

import { ScreenH264 } from "./screen-h264.ts";

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

const unpack = (packets: ReadonlyArray<RtpPacket>) => {
  const units: Array<Buffer> = [];
  let fragments: Array<Buffer> = [];
  for (const { payload } of packets) {
    if (((payload[0] ?? 0) & 31) !== 28) {
      units.push(payload);
      continue;
    }
    if ((payload[1] ?? 0) & 0x80)
      fragments = [Buffer.from([((payload[0] ?? 0) & 0xe0) | ((payload[1] ?? 0) & 31)])];
    fragments.push(payload.subarray(2));
    if ((payload[1] ?? 0) & 0x40) units.push(Buffer.concat(fragments));
  }
  return units;
};

describe("the screen's Annex-B stream", () => {
  it("splits any TCP chunking, including split three/four-byte start codes, into the same access units", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 101 }), { minLength: 1, maxLength: 20 }),
        (sizes) => {
          const parser = new ScreenH264();
          const frames: Array<{ idr: boolean; packets: Array<RtpPacket> }> = [];
          for (let offset = 0, i = 0; offset < sample.length; i++) {
            const size = sizes[i % sizes.length] ?? 1;
            const result = parser.push(sample.subarray(offset, offset + size));
            if (result === null) throw new Error("small stream refused");
            frames.push(...result);
            offset += size;
          }
          expect(frames.map((frame) => frame.idr)).toEqual([true, false]);
          expect(unpack(frames[0]?.packets ?? []).at(-1)).toEqual(slice);
          expect(unpack(frames[1]?.packets ?? [])).toEqual([aud, Buffer.from([0x41, 0xaa])]);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("uses FU-A under the MTU, continuous sequence numbers, 90kHz timestamps, and one marker per frame", () => {
    const frames = new ScreenH264().push(sample);
    if (frames === null) throw new Error("small stream refused");
    const packets = frames.flatMap((frame) => frame.packets);
    expect(packets.some((packet) => ((packet.payload[0] ?? 0) & 31) === 28)).toBe(true);
    expect(packets.every((packet) => packet.payload.length <= 1180)).toBe(true);
    for (let i = 1; i < packets.length; i++)
      expect(packets[i]?.header.sequenceNumber).toBe(
        ((packets[i - 1]?.header.sequenceNumber ?? 0) + 1) & 0xffff,
      );
    expect(frames.map((frame) => frame.packets[0]?.header.timestamp)).toEqual([0, 3000]);
    for (const frame of frames) {
      expect(frame.packets.filter((packet) => packet.header.marker)).toHaveLength(1);
      expect(frame.packets.at(-1)?.header.marker).toBe(true);
    }
  });

  it("refuses a stream that never terminates its NAL instead of retaining it without a bound", () => {
    const parser = new ScreenH264();
    expect(parser.push(Buffer.alloc(8 * 1024 * 1024 + 1))).toBeNull();
  });
});
