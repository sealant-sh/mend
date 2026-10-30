import { inflateSync } from "node:zlib";

/** Every pixel's RGB, unfiltered as the PNG spec says, so an encoder is checked by a reader of its own. */
export const decodePng = (png: Uint8Array) => {
  const file = Buffer.from(png);
  if (file.subarray(1, 4).toString() !== "PNG") throw new Error("not a PNG");
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const idat: Array<Buffer> = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    if (file.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(file.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const filtered = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const raw = filtered[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= 3 ? (rgb[y * stride + x - 3] ?? 0) : 0;
      const up = y > 0 ? (rgb[(y - 1) * stride + x] ?? 0) : 0;
      const corner = x >= 3 && y > 0 ? (rgb[(y - 1) * stride + x - 3] ?? 0) : 0;
      const estimate = left + up - corner;
      const paeth = [left, up, corner].reduce((best, candidate) =>
        Math.abs(estimate - candidate) < Math.abs(estimate - best) ? candidate : best,
      );
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter] ?? 0;
      rgb[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return {
    width,
    height,
    rgb,
    at: (x: number, y: number) => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)],
  };
};
