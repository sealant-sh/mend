import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";

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

/**
 * What the register-time restorability check costs on a dependency tree the size of a pnpm
 * `node_modules` (ADR-0002 decision 28 measured ≈ 20,860 dir objects; 134,103 files on the
 * cluster). Opt-in: `MEND_MEASURE_VERIFY=1`; it prints the timings it measured.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-verify-measure-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

it.skipIf(process.env["MEND_MEASURE_VERIFY"] !== "1")(
  "verifies a node_modules-sized format-2 section",
  { timeout: 600_000 },
  async () => {
    const DIRS = 21_000;
    const FILES_PER_DIR = 6;
    const keys = captureKeys("wt-measure", 1);
    const chunks: Array<Uint8Array> = [];
    const dirBytes: Array<Uint8Array> = [];
    // A four-level fan-out tree: leaves hold the files, every level lists its children.
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
      return { check, ms: Math.round(performance.now() - started) };
    };
    const cold = await timed();
    const warm = await timed();
    console.log(
      `verify: ${cold.check.dirs} dirs, ${cold.check.files} files, ${contentPacks.length} packs, ${dirPacks.length} dir packs · cold ${cold.ms} ms · warm ${warm.ms} ms`,
    );
    expect(cold.check.files).toBe(DIRS * FILES_PER_DIR);
  },
);
