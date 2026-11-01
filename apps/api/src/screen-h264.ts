/** Whole Annex-B access unit before transport packetization. */
export interface ScreenAccessUnit {
  readonly data: Uint8Array;
  readonly keyframe: boolean;
}

const START = Buffer.from([0, 0, 0, 1]);
const MAX_FRAME = 8 * 1024 * 1024;

/** Incremental Annex-B access units, delimited by ffmpeg's AUD NALs, bounded to 8 MiB. */
export class ScreenH264 {
  #bytes = Buffer.alloc(0);
  #units: Array<Buffer> = [];
  #size = 0;

  /** TCP chunks may split any start code or NAL. Null refuses an oversized encoder frame. */
  push(chunk: Uint8Array): Array<ScreenAccessUnit> | null {
    this.#bytes = Buffer.concat([this.#bytes, chunk]);
    if (this.#bytes.length + this.#size > MAX_FRAME) return null;
    const frames: Array<ScreenAccessUnit> = [];
    for (;;) {
      // Both three-byte and four-byte start codes contain 00 00 01.
      const first = this.#bytes.indexOf(Buffer.from([0, 0, 1]));
      if (first < 0) break;
      const next = this.#bytes.indexOf(Buffer.from([0, 0, 1]), first + 3);
      if (next < 0) break;
      const end = this.#bytes[next - 1] === 0 ? next - 1 : next;
      const nal = this.#bytes.subarray(first + 3, end);
      this.#bytes = this.#bytes.subarray(end);
      if (nal.length === 0) continue;
      const type = (nal[0] ?? 0) & 31;
      if (type === 9 && this.#units.length > 0) {
        const units = this.#units;
        this.#units = [];
        this.#size = 0;
        frames.push({
          // A switch or a fresh viewer needs the parameter sets with the IDR.
          keyframe: [5, 7, 8].every((required) =>
            units.some((unit) => ((unit[0] ?? 0) & 31) === required),
          ),
          data: Buffer.concat(units.flatMap((unit) => [START, unit])),
        });
      }
      this.#units.push(nal);
      this.#size += nal.length + 4;
    }
    return frames;
  }
}
