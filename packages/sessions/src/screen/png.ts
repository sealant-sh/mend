import { crc32, deflateSync } from "node:zlib";

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
