import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  bytesOfKey,
  captureIdOf,
  captureKeys,
  decodeManifest,
  keyOfBytes,
  makeDirReader,
  materialize,
  rawOfKey,
  sha256Hex,
  verifySectionRestorable,
} from "../src/captures.ts";
import { buildManifest, uploadObjects, writeCdcPack } from "./capture-fixture.ts";

/**
 * Names and symlink texts that are not UTF-8 (review 2026-09-28 #12). sealantd writes such a
 * name as an escaped key (`U+10FF00 + byte`) and carries the bytes, hex, in `raw_name` /
 * `raw_target`; Mend's reader must lay down the bytes, and its restorability check must refuse a
 * raw field that disagrees with its key — never write the escaped key as the name.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-raw-names-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  dirs += 1;
  return path.join(scratch, `${label}-${dirs}`);
};

const escapeOf = (byte: number) => String.fromCodePoint(0x10_ff00 + byte);

/** One format-2 workspace section holding `entries` at its root, with `body` as the file content. */
const sectionWith = (worktreeId: string, entries: ReadonlyArray<object>, body: Buffer) => {
  const keys = captureKeys(worktreeId, 1);
  const content = writeCdcPack([body]);
  const contentKey = keys.pack(sha256Hex(content.bytes));
  const dir = Buffer.from(JSON.stringify({ entries }));
  const dirPack = writeCdcPack([dir]);
  const dirPackKey = keys.pack(sha256Hex(dirPack.bytes));
  const workspace = {
    root: sha256Hex(dir),
    format: 2 as const,
    packs: [contentKey],
    dir_packs: [dirPackKey],
  };
  return {
    workspace,
    objects: new Map([
      [contentKey, content.bytes],
      [dirPackKey, dirPack.bytes],
    ]),
  };
};

/** A symlink entry whose text is `targetKey`, carrying `raw` as its raw bytes. */
const linkEntry = (targetKey: string, raw: string) => ({
  name: "l",
  kind: "symlink",
  mode: 0o120777,
  size: 1,
  mtime: 1,
  target: targetKey,
  raw_target: raw,
});

/** `parent` + `/` + `name`, as bytes. */
const joinBytes = (parent: Buffer, name: Buffer) => Buffer.concat([parent, Buffer.from("/"), name]);

const runIn = <A, E>(blobRoot: string, effect: Effect.Effect<A, E, BlobStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BlobStoreFsLive(blobRoot))));

describe("keys (sealantd tree.rs key_of / bytes_of)", () => {
  it("round-trips every byte string, escapes only what is not UTF-8 or is in the escape range", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["plain", Buffer.from("plain.txt").toString("hex")],
      ["latin-1 byte", "636166e9"],
      ["lone continuation", "80"],
      ["truncated sequence", "e282"],
      ["overlong", "c0af"],
      ["surrogate", "eda080"],
      ["above U+10FFFF", "f4908080"],
      [
        "escape-range character",
        Buffer.from(`x${String.fromCodePoint(0x10_ffa0)}y`).toString("hex"),
      ],
      ["ordinary non-ASCII", Buffer.from("café ünï 日本").toString("hex")],
      ["U+10FF7F stays", Buffer.from(String.fromCodePoint(0x10_ff7f)).toString("hex")],
    ];
    for (const [label, hex] of cases) {
      const bytes = Buffer.from(hex, "hex");
      const key = keyOfBytes(bytes);
      expect(bytesOfKey(key).toString("hex"), label).toBe(hex);
    }
    expect(keyOfBytes(Buffer.from("636166e9", "hex"))).toBe(`caf${escapeOf(0xe9)}`);
    expect(keyOfBytes(Buffer.from("e282", "hex"))).toBe(`${escapeOf(0xe2)}${escapeOf(0x82)}`);
    expect(keyOfBytes(Buffer.from("café"))).toBe("café");
    expect(rawOfKey("café")).toBeUndefined();
    expect(rawOfKey(`caf${escapeOf(0xe9)}`)).toBe("636166e9");
  });
});

describe("raw names in the TypeScript materializer and restorability check", () => {
  it("lays down raw_name and raw_target bytes, not the escaped keys", async () => {
    const worktreeId = "wt-raw-parity";
    const body = Buffer.from("raw file");
    const { workspace, objects } = sectionWith(
      worktreeId,
      [
        {
          name: `caf${escapeOf(0xe9)}`,
          raw_name: "636166e9",
          kind: "file",
          mode: 0o100644,
          size: body.length,
          mtime: 1_700_000_000,
          chunks: [sha256Hex(body)],
        },
        {
          name: "link",
          kind: "symlink",
          mode: 0o120777,
          size: 1,
          mtime: 1_700_000_000,
          target: escapeOf(0xff),
          raw_target: "ff",
        },
      ],
      body,
    );
    const built = buildManifest({ worktreeId, epoch: 1, n: 0, parent: null, workspace });
    const blobRoot = freshDir("blobs");
    const target = freshDir("out");
    await runIn(
      blobRoot,
      Effect.gen(function* () {
        yield* uploadObjects(objects);
        yield* verifySectionRestorable(workspace);
        yield* materialize(built.manifest, "workspace", target);
      }),
    );
    const names = fs
      .readdirSync(Buffer.from(target), { encoding: "buffer" })
      .map((name) => name.toString("hex"))
      .toSorted();
    expect(names).toEqual(["636166e9", Buffer.from("link").toString("hex")]);
    const file = Buffer.concat([
      Buffer.from(target),
      Buffer.from("/"),
      Buffer.from("636166e9", "hex"),
    ]);
    expect(fs.readFileSync(file).toString()).toBe("raw file");
    const link = fs.readlinkSync(path.join(target, "link"), { encoding: "buffer" });
    expect(link.toString("hex")).toBe("ff");
  });

  it("refuses a raw field that disagrees with its key, is not hex, or is not one safe name", async () => {
    const worktreeId = "wt-raw-refused";
    const body = Buffer.from("x");
    const file = (name: string, raw: string | undefined) => ({
      name,
      ...(raw === undefined ? {} : { raw_name: raw }),
      kind: "file",
      mode: 0o100644,
      size: body.length,
      mtime: 1,
      chunks: [sha256Hex(body)],
    });
    const cases: ReadonlyArray<readonly [string, object]> = [
      ["raw bytes of another name", file(`caf${escapeOf(0xe9)}`, "636166e8")],
      ["raw not hex", file(`caf${escapeOf(0xe9)}`, "zz")],
      ["raw holding a slash", file(`a${escapeOf(0x80)}`, "2f80")],
      ["an escaped key that decodes to UTF-8", file(`${escapeOf(0xc3)}${escapeOf(0xa9)}`, "c3a9")],
      ["a lone surrogate in a key", file("a\ud800", undefined)],
      ["raw target of another text", linkEntry(escapeOf(0xff), "fe")],
      ["raw target holding NUL", linkEntry(`${escapeOf(0xff)}`, "00ff")],
    ];
    for (const [label, entry] of cases) {
      const { workspace, objects } = sectionWith(`${worktreeId}-${dirs}`, [entry], body);
      const blobRoot = freshDir("blobs");
      const outcome = await runIn(
        blobRoot,
        Effect.gen(function* () {
          yield* uploadObjects(objects);
          return yield* verifySectionRestorable(workspace).pipe(
            Effect.as("restorable"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
        }),
      );
      expect(outcome, label).toBe("CaptureFormatError");
    }
  });
});

// ─── Cross-check: a store written by sealant-capture ─────────────────────────

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sealantd-raw-names");

interface ExpectedEntry {
  readonly kind: "dir" | "file" | "symlink";
  readonly mode?: number;
  readonly size?: number;
  readonly sha256?: string;
  readonly nlink?: number;
  /** A symlink's text, hex. */
  readonly target?: string;
}

interface ExpectedHead {
  readonly capture_id: string;
  readonly manifest_key: string;
  /** Paths (hex of their bytes) under `ignored/`, carried by the workspace class's `tree/`. */
  readonly tree: Readonly<Record<string, ExpectedEntry>>;
  /** Paths (hex) under `node_modules/`, carried by the bulk class. */
  readonly bulk: Readonly<Record<string, ExpectedEntry>>;
}

/** Every path under `dir` (relative to `base`), keyed by the hex of its bytes, as the generator recorded. */
const observedListing = (base: Buffer, dir: Buffer): Record<string, ExpectedEntry> => {
  const out: Record<string, ExpectedEntry> = {};
  const walk = (at: Buffer) => {
    for (const name of fs.readdirSync(at, { encoding: "buffer" })) {
      const full = joinBytes(at, name);
      const rel = full.subarray(base.length + 1).toString("hex");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        out[rel] = {
          kind: "symlink",
          target: fs.readlinkSync(full, { encoding: "buffer" }).toString("hex"),
        };
      } else if (stat.isDirectory()) {
        out[rel] = { kind: "dir", mode: stat.mode & 0o7777 };
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        out[rel] = {
          kind: "file",
          mode: stat.mode & 0o7777,
          nlink: stat.nlink,
          sha256: sha256Hex(bytes),
          size: bytes.length,
        };
      }
    }
  };
  walk(dir);
  return out;
};

describe("a store sealant-capture wrote with names that are not UTF-8", () => {
  it("verifies, and materializes every name, link text and hardlink as the bytes on the executor's disk", async () => {
    const expected: ExpectedHead = JSON.parse(
      fs.readFileSync(path.join(FIXTURE, "head.json"), "utf8"),
    );
    const blobRoot = freshDir("rust-blobs");
    fs.cpSync(path.join(FIXTURE, "store"), blobRoot, { recursive: true });
    const workspaceOut = freshDir("rust-workspace");
    const bulkOut = freshDir("rust-bulk");
    const escaped = await runIn(
      blobRoot,
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const bytes = yield* store.get(expected.manifest_key);
        expect(captureIdOf(bytes)).toBe(expected.capture_id);
        const manifest = yield* decodeManifest(expected.manifest_key, bytes);
        const bulk = manifest.sections.bulk;
        if (bulk === "pending") throw new Error("bulk pending");
        yield* verifySectionRestorable(manifest.sections.workspace);
        yield* verifySectionRestorable(bulk);
        yield* materialize(manifest, "workspace", workspaceOut);
        yield* materialize(manifest, "bulk", bulkOut);
        // The writer escaped these names: the fixture holds what this test is about.
        const reader = yield* makeDirReader(bulk);
        const root = yield* reader.read(bulk.root);
        const nodeModules = root.find((entry) => entry.name === "node_modules")?.child;
        if (nodeModules === undefined) throw new Error("no node_modules");
        return (yield* reader.read(nodeModules)).filter((entry) => entry.raw_name !== undefined)
          .length;
      }),
    );
    const tree = observedListing(
      Buffer.from(path.join(workspaceOut, "tree")),
      Buffer.from(path.join(workspaceOut, "tree", "ignored")),
    );
    expect(tree).toEqual(expected.tree);
    const bulk = observedListing(
      Buffer.from(bulkOut),
      Buffer.from(path.join(bulkOut, "node_modules")),
    );
    expect(bulk).toEqual(expected.bulk);
    expect(escaped).toBeGreaterThan(0);
  });
});
