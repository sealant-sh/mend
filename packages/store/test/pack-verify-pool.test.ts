import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { verifyPackOnWorker, type PackVerifyEntry } from "../src/pack-verify-pool.ts";

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A pack's data region and its index entries, as sealantd writes them. */
const packOf = (chunks: ReadonlyArray<Uint8Array>) => {
  const entries: Array<PackVerifyEntry> = [];
  const frames: Array<Buffer> = [];
  let offset = 0;
  for (const chunk of chunks) {
    const frame = zlib.zstdCompressSync(chunk);
    entries.push({ hash: sha256(chunk), offset, length: frame.byteLength, size: chunk.byteLength });
    frames.push(frame);
    offset += frame.byteLength;
  }
  return { bytes: Buffer.concat(frames), entries };
};
/** A fresh buffer the worker may take. */
const handed = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;

describe("pack verification on worker threads", () => {
  const chunks = [Buffer.from("alpha\n".repeat(500)), Buffer.from("beta"), Buffer.alloc(0)];

  it("passes a pack whose bytes hash to its key and whose chunks are what its index says", async () => {
    const { bytes, entries } = packOf(chunks);
    expect(await verifyPackOnWorker(sha256(bytes), entries, handed(bytes))).toBeNull();
    // A key that names no digest: only the chunks are checked.
    expect(await verifyPackOnWorker(null, entries, handed(bytes))).toBeNull();
  });

  it("says a pack that does not hash to its key is that, before anything about its chunks", async () => {
    const { bytes, entries } = packOf(chunks);
    const named = "0".repeat(64);
    expect(await verifyPackOnWorker(named, entries, handed(bytes))).toEqual({
      tag: "integrity",
      expected: named,
      actual: sha256(bytes),
    });
  });

  it("names the chunk that hashes to another id, is another size, or does not decompress", async () => {
    const { bytes, entries } = packOf(chunks);
    const [first, second, third] = entries;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("setup");
    const wrongHash = [{ ...first, hash: "1".repeat(64) }, second, third];
    expect(await verifyPackOnWorker(null, wrongHash, handed(bytes))).toEqual({
      tag: "integrity",
      expected: "1".repeat(64),
      actual: first.hash,
    });
    const wrongSize = [{ ...first, size: first.size + 1 }, second, third];
    expect(await verifyPackOnWorker(null, wrongSize, handed(bytes))).toEqual({
      tag: "format",
      reason: `chunk ${first.hash}: size ${first.size}, index says ${first.size + 1}`,
    });
    const torn = Uint8Array.from(bytes);
    torn.fill(0xff, second.offset, second.offset + second.length);
    const problem = await verifyPackOnWorker(null, entries, handed(torn));
    expect(problem?.tag).toBe("format");
    expect(problem?.tag === "format" ? problem.reason : "").toContain(`chunk ${second.hash}:`);
  });

  it("verifies many packs at once, each answered for itself", async () => {
    const packs = Array.from({ length: 12 }, (_, n) =>
      packOf([Buffer.from(`pack ${n}\n`.repeat(n + 1)), Buffer.from(String(n))]),
    );
    const answers = await Promise.all(
      packs.map((pack, n) =>
        verifyPackOnWorker(
          n === 7 ? "f".repeat(64) : sha256(pack.bytes),
          pack.entries,
          handed(pack.bytes),
        ),
      ),
    );
    expect(answers.map((answer) => answer?.tag ?? "ok")).toEqual(
      packs.map((_, n) => (n === 7 ? "integrity" : "ok")),
    );
  });
});
