import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PROOF_LIMITS } from "@mend/domain/workbench";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";

import { ProofVideoBuffer, PROOF_VIDEO_BYTES } from "./proof-video.ts";
import { ScreenH264 } from "./screen-h264.ts";

const fixture = readFileSync(new URL("./test-fixtures/proof-baseline.h264", import.meta.url));
const frames = () => {
  const units = new ScreenH264().push(
    Buffer.concat([fixture, Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1])]),
  );
  if (units === null || units.length === 0) throw new Error("invalid fixture");
  return units.map((frame, index) => ({ ...frame, receivedAt: 1000 + (index * 1000) / 30 }));
};

const capture = async () => {
  const buffer = new ProofVideoBuffer();
  for (const frame of frames()) expect(buffer.push(frame)).toBe(true);
  return buffer.finish();
};

it("muxes real baseline Annex-B into a non-fragmented faststart MP4 without losing samples", async () => {
  const { mp4, durationMs } = await capture();
  const bytes = Buffer.from(mp4);
  expect(bytes.indexOf("moov")).toBeGreaterThan(0);
  expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  expect(bytes.indexOf("moof")).toBe(-1);
  const input = new Input({ formats: [MP4], source: new BufferSource(mp4) });
  try {
    const track = await input.getPrimaryVideoTrack();
    expect(track?.codec).toBe("avc");
    expect(track?.codedWidth).toBe(1280);
    expect(track?.codedHeight).toBe(800);
    expect(await input.computeDuration()).toBeCloseTo(2, 1);
    expect(durationMs).toBeCloseTo(2000, -1);
    if (track === null) throw new Error("missing video");
    const packets = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
    expect(packets).toHaveLength(frames().length);
    expect(packets[0]?.type).toBe("key");
    expect(packets[0]?.timestamp).toBe(0);
  } finally {
    input.dispose();
  }
});

it("ignores leading deltas and bounds bytes, sample count, and elapsed time", async () => {
  const first = frames()[0];
  if (first === undefined) throw new Error("missing IDR");
  const buffer = new ProofVideoBuffer();
  expect(buffer.push({ ...first, keyframe: false })).toBe(true);
  expect(buffer.push(first)).toBe(true);
  expect(buffer.push({ ...first, data: new Uint8Array(PROOF_VIDEO_BYTES) })).toBe("interrupted");
  expect(buffer.push({ ...first, receivedAt: first.receivedAt + PROOF_LIMITS.videoMs })).toBe(
    "time-limit",
  );
  for (let i = 1; i < 3600; i++) expect(buffer.push(first)).toBe(true);
  expect(buffer.push(first)).toBe("interrupted");
  const result = await buffer.finish();
  expect(result.durationMs).toBeLessThanOrEqual(PROOF_LIMITS.videoMs);
});

const cache = join(homedir(), ".cache/ms-playwright");
const shell =
  process.env["CHROMIUM_PATH"] ??
  (existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => name.startsWith("chromium_headless_shell-"))
        .toSorted()
        .toReversed()
        .map((name) => join(cache, name, "chrome-headless-shell-linux64/chrome-headless-shell"))
        .find((path) => existsSync(path))
    : undefined);
it.skipIf(shell === undefined)("plays the resulting MP4 in cached headless Chromium", async () => {
  if (shell === undefined) throw new Error("cached Chromium is unavailable");
  const browser = await chromium.launch({ executablePath: shell, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const { mp4 } = await capture();
    const duration = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true;
      video.src = url;
      document.body.append(video);
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener(
            "error",
            () => reject(new Error(video.error?.message ?? "video error")),
            { once: true },
          );
        });
        await video.play();
        return video.duration;
      } finally {
        video.pause();
        URL.revokeObjectURL(url);
      }
    }, Buffer.from(mp4).toString("base64"));
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeCloseTo(2, 1);
  } finally {
    await browser.close();
  }
});
