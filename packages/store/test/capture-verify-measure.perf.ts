import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type DirEntry,
  captureKeys,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  sha256Hex,
  verifySectionRestorable,
  type WorkspaceSection,
} from "../src/captures.ts";
import { uploadObjects, writeCdcPack } from "./capture-fixture.ts";

// Explicit measurement entrypoint; normal correctness tests never select this file.
it("measures a node_modules-sized format-2 section", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-verify-measure-"));
  try {
    const DIRS = 21_000;
    const FILES_PER_DIR = 6;
    const keys = captureKeys("wt-measure", 1);
    const chunks: Array<Uint8Array> = [];
    const dirBytes: Array<Uint8Array> = [];
    // A three-level fan-out tree: leaves hold the files, every level lists its children.
    const leaf = (at: number): string => {
      const entries: Array<DirEntry> = [];
      for (let file = 0; file < FILES_PER_DIR; file += 1) {
        const bytes = new Uint8Array(Buffer.from(`module ${at} file ${file} `.repeat(20)));
        chunks.push(bytes);
        entries.push({
          name: `f${file}.js`,
          kind: "file",
          mode: 0o100644,
          size: bytes.byteLength,
          mtime: 1,
          chunks: [sha256Hex(bytes)],
        });
      }
      const encoded = encodeDirObject(entries);
      dirBytes.push(encoded);
      return sha256Hex(encoded);
    };
    const level = (children: ReadonlyArray<string>): string => {
      const entries: Array<DirEntry> = children.map((child, at) => ({
        name: `d${String(at).padStart(5, "0")}`,
        kind: "dir",
        mode: 0o40755,
        size: 0,
        mtime: 1,
        child,
      }));
      const encoded = encodeDirObject(entries);
      dirBytes.push(encoded);
      return sha256Hex(encoded);
    };
    const leaves = Array.from({ length: DIRS }, (_, at) => leaf(at));
    const groups: Array<string> = [];
    for (let at = 0; at < leaves.length; at += 100) groups.push(level(leaves.slice(at, at + 100)));
    const root = level(groups);
    const objects = new Map<string, Uint8Array>();
    const contentPacks: Array<string> = [];
    for (let at = 0; at < chunks.length; at += 4_000) {
      const pack = writeCdcPack(chunks.slice(at, at + 4_000));
      const key = keys.pack(sha256Hex(pack.bytes));
      objects.set(key, pack.bytes);
      contentPacks.push(key);
    }
    const dirPacks: Array<string> = [];
    for (let at = 0; at < dirBytes.length; at += 8_000) {
      const pack = writeCdcPack(dirBytes.slice(at, at + 8_000));
      const key = keys.pack(sha256Hex(pack.bytes));
      objects.set(key, pack.bytes);
      dirPacks.push(key);
    }
    const section: WorkspaceSection = {
      root,
      packs: contentPacks,
      format: FORMAT_DIR_PACKS,
      dir_packs: dirPacks,
    };
    const layer = BlobStoreFsLive(path.join(scratch, "blobs"));
    await Effect.runPromise(uploadObjects(objects).pipe(Effect.provide(layer)));
    const timed = async () => {
      const started = performance.now();
      const check = await Effect.runPromise(
        verifySectionRestorable(section).pipe(Effect.provide(layer)),
      );
      return { check, ms: performance.now() - started };
    };
    const loadBefore = os.loadavg();
    const first = await timed();
    const repeat = await timed();
    const report = {
      measuredAt: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpus: os.cpus().length,
        loadBefore,
        loadAfter: os.loadavg(),
        temporaryFilesystemType: fs.statfsSync(scratch).type,
      },
      fixture: { files: 126_000, dirs: 21_211, contentPacks: 32, dirPacks: 3 },
      first,
      repeat,
      limits:
        "Two measurements, no latency budget. Fixture upload warms filesystem caches; first does not mean an OS cold cache. Local filesystem blobs, not a remote blob store or whole session startup.",
    };
    const output = process.env["MEND_VERIFY_BENCH_REPORT"];
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output !== undefined) fs.writeFileSync(output, json);
    console.log(json);
    expect(contentPacks).toHaveLength(32);
    expect(dirPacks).toHaveLength(3);
    for (const measured of [first, repeat]) {
      expect(measured.check.files).toBe(126_000);
      expect(measured.check.dirs).toBe(21_211);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
