import { PROOF_LIMITS, SCREEN_LIMITS } from "@mend/domain/workbench";
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";

import type { ScreenVideoFrame } from "./screen-video.ts";

/** Raw Annex-B storage per recording; final MP4 allocation is additional, bounded by these samples. */
export const PROOF_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_SAMPLES = 3600;
const FRAME_MS = 1000 / 30;

/** Bounded capture, starting at an IDR with SPS/PPS, before lossless MP4 muxing. */
export class ProofVideoBuffer {
  readonly #frames: Array<ScreenVideoFrame> = [];
  #bytes = 0;

  /** Frames before the first keyframe are ignored; a limit refuses the next sample. */
  push(frame: ScreenVideoFrame): true | "interrupted" | "time-limit" {
    if (this.#frames.length === 0 && !frame.keyframe) return true;
    if (
      this.#bytes + frame.data.byteLength > PROOF_VIDEO_BYTES ||
      this.#frames.length >= MAX_SAMPLES
    )
      return "interrupted";
    const first = this.#frames[0];
    if (first !== undefined && frame.receivedAt - first.receivedAt >= PROOF_LIMITS.videoMs)
      return "time-limit";
    this.#frames.push({ ...frame, data: Uint8Array.from(frame.data) });
    this.#bytes += frame.data.byteLength;
    return true;
  }

  /** No re-encode: mediabunny converts Annex-B to AVCC and writes moov before mdat. */
  async finish(
    size: { readonly width: number; readonly height: number } = SCREEN_LIMITS,
  ): Promise<{ mp4: Uint8Array; durationMs: number }> {
    const frames = this.#frames.splice(0);
    this.#bytes = 0;
    const first = frames[0];
    if (first === undefined) throw new Error("recording has no keyframe");
    const target = new BufferTarget();
    const source = new EncodedVideoPacketSource("avc");
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: "in-memory" }) });
    output.addVideoTrack(source);
    try {
      await output.start();
      let timestamp = 0;
      let durationMs = 0;
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (frame === undefined) continue;
        // TCP can deliver several access units in one read. Keep their arrival order with a
        // one-millisecond minimum step, including if the wall clock moves backwards.
        const next = frames[i + 1];
        const end = Math.min(
          PROOF_LIMITS.videoMs,
          Math.max(
            timestamp + 1,
            next === undefined ? timestamp + FRAME_MS : next.receivedAt - first.receivedAt,
          ),
        );
        await source.add(
          new EncodedPacket(
            frame.data,
            frame.keyframe ? "key" : "delta",
            timestamp / 1000,
            (end - timestamp) / 1000,
          ),
          i === 0
            ? {
                decoderConfig: {
                  codec: "avc1.42e01f",
                  codedWidth: size.width,
                  codedHeight: size.height,
                },
              }
            : undefined,
        );
        durationMs = end;
        timestamp = end;
      }
      await output.finalize();
      if (target.buffer === null) throw new Error("MP4 was not finalized");
      return { mp4: new Uint8Array(target.buffer), durationMs: Math.round(durationMs) };
    } catch (error) {
      await output.cancel();
      throw error;
    }
  }
}
