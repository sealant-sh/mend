import { crc32, deflateSync, inflateSync } from "node:zlib";

import { ProofRegion, SCREEN_LIMITS } from "@mend/domain/workbench";
import { Schema } from "effect";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** Opaque RGBA in, an 8-bit RGB PNG out. */
export const encodePng = (rgba: Uint8Array, width: number, height: number): Uint8Array => {
  const stride = 1 + width * 3;
  const rows = Buffer.alloc(stride * height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = Math.floor(pixel / width) + 1 + pixel * 3;
    rows[at] = rgba[pixel * 4] ?? 0;
    rows[at + 1] = rgba[pixel * 4 + 1] ?? 0;
    rows[at + 2] = rgba[pixel * 4 + 2] ?? 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
};

/** Crops only Mend's own bounded RGB PNGs, whose rows use filter zero. */
export const cropPng = (png: Uint8Array, region: ProofRegion): Uint8Array => {
  const source = Buffer.from(png);
  if (!source.subarray(0, 8).equals(SIGNATURE)) throw new Error("invalid Mend PNG signature");
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  if (
    width !== SCREEN_LIMITS.width ||
    height !== SCREEN_LIMITS.height ||
    !Schema.is(ProofRegion)(region) ||
    !source.subarray(24, 29).equals(Buffer.from([8, 2, 0, 0, 0]))
  )
    throw new Error("region must fit inside a Mend 1280×800 RGB PNG");
  const compressed: Array<Uint8Array> = [];
  for (let at = 8; at + 12 <= source.length; ) {
    const size = source.readUInt32BE(at);
    if (at + 12 + size > source.length) throw new Error("invalid Mend PNG chunk");
    if (source.toString("latin1", at + 4, at + 8) === "IDAT")
      compressed.push(source.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const stride = 1 + width * 3;
  const rows = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height });
  if (rows.length !== stride * height) throw new Error("invalid Mend PNG rows");
  const rgba = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const row = (region.y + y) * stride;
    if (rows[row] !== 0) throw new Error("unsupported Mend PNG filter");
    for (let x = 0; x < region.width; x++) {
      const from = row + 1 + (region.x + x) * 3;
      const to = (y * region.width + x) * 4;
      rgba.set(rows.subarray(from, from + 3), to);
      rgba[to + 3] = 255;
    }
  }
  return encodePng(rgba, region.width, region.height);
};
