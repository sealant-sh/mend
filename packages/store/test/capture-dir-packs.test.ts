import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type CaptureClass,
  type CaptureManifest,
  captureIdOf,
  captureKeys,
  collectTreeKeys,
  decodeDirObject,
  decodeManifest,
  keysNeededBy,
  listCaptureDir,
  listCaptureFiles,
  materialize,
  readCaptureFileBytes,
  readChunk,
  readPackIndex,
  sha256Hex,
  statCaptureEntry,
  type WorkspaceSection,
} from "../src/captures.ts";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "./capture-fixture.ts";

/**
 * Section formats (sealantd PR #99 "Dir packs"): format 1 keeps one object per directory, named
 * by key; format 2 packs the dir objects into dir packs and names them by digest; one manifest
 * can hold one section of each. Every reader is run over every combination, and the last block
 * reads a store written by sealant-capture itself (`fixtures/sealantd-dir-packs`).
 */

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const failureTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** A blob store that counts its GETs by key, over a directory. */
const countingStore = (root: string) => {
  const gets: Array<string> = [];
  const layer = Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const inner = yield* BlobStore;
      return {
        ...inner,
        get: (key: string) => {
          gets.push(key);
          return inner.get(key);
        },
      };
    }),
  ).pipe(Layer.provide(BlobStoreFsLive(root)));
  return { gets, layer };
};

const describeTree = (root: string) => {
  const out: Array<string> = [];
  const walk = (at: string, rel: string) => {
    for (const name of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        out.push(`dir ${relPath} ${(stat.mode & 0o7777).toString(8)} ${Math.round(stat.mtimeMs)}`);
        walk(full, relPath);
      } else if (stat.isSymbolicLink()) {
        out.push(`symlink ${relPath} -> ${fs.readlinkSync(full)}`);
      } else {
        out.push(
          `file ${relPath} ${(stat.mode & 0o7777).toString(8)} ${Math.round(stat.mtimeMs)} ${sha256Hex(fs.readFileSync(full))}`,
        );
      }
    }
  };
  walk(root, "");
  return out;
};

const filesUnder = (root: string): Array<string> =>
  describeTree(root)
    .filter((line) => line.startsWith("file "))
    .map((line) => line.split(" ")[1] ?? "")
    .toSorted();

/** A class's source: nested directories, a symlink, a hardlink pair, an executable, a big file. */
const buildSource = (at: string, label: string) => {
  fs.mkdirSync(path.join(at, "src", "deep", "deeper"), { recursive: true });
  fs.mkdirSync(path.join(at, "empty"));
  fs.writeFileSync(path.join(at, "README.md"), `# ${label}\n`);
  fs.writeFileSync(path.join(at, "src", "index.ts"), `export const x = "${label}";\n`);
  fs.writeFileSync(path.join(at, "src", "deep", "big.bin"), Buffer.alloc(9_000, label.length));
  fs.writeFileSync(path.join(at, "src", "deep", "deeper", "leaf.txt"), `${label} leaf\n`);
  fs.writeFileSync(path.join(at, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.writeFileSync(path.join(at, "empty.txt"), "");
  fs.symlinkSync("src/index.ts", path.join(at, "link.ts"));
  fs.linkSync(path.join(at, "README.md"), path.join(at, "src", "README-link.md"));
  fs.chmodSync(path.join(at, "src", "deep"), 0o700);
  const old = new Date("2024-03-04T05:06:07.250Z");
  fs.utimesSync(path.join(at, "README.md"), old, old);
  fs.utimesSync(path.join(at, "src", "deep"), old, old);
};

const COMBINATIONS = [
  { name: "format 1", workspace: 1, bulk: 1 },
  { name: "format 2", workspace: 2, bulk: 2 },
  { name: "a mixed manifest (format-2 workspace, format-1 bulk)", workspace: 2, bulk: 1 },
  { name: "a mixed manifest (format-1 workspace, format-2 bulk)", workspace: 1, bulk: 2 },
] as const;

describe.each(COMBINATIONS)("every reader over $name", ({ workspace, bulk }) => {
  let scratch = "";
  let blobRoot = "";
  let manifest: CaptureManifest;
  let counting: ReturnType<typeof countingStore>;
  const sources: Record<CaptureClass, string> = { workspace: "", bulk: "" };
  const snapshots: Record<CaptureClass, ReturnType<typeof snapshotDirectory> | null> = {
    workspace: null,
    bulk: null,
  };
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(counting.layer)));

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dir-packs-"));
    blobRoot = path.join(scratch, "blobs");
    counting = countingStore(blobRoot);
    const keys = captureKeys("wt-f", 3);
    for (const cls of ["workspace", "bulk"] as const) {
      sources[cls] = path.join(scratch, `source-${cls}`);
      buildSource(sources[cls], `${cls}-${workspace}-${bulk}`);
      snapshots[cls] = snapshotDirectory(sources[cls], keys, {
        chunkSize: 4000,
        packBudget: 4096,
        format: cls === "workspace" ? workspace : bulk,
        // Two dir objects per pack: a walk crosses packs.
        dirPackBudget: 2,
      });
    }
    const ws = snapshots.workspace;
    const bk = snapshots.bulk;
    if (ws === null || bk === null) throw new Error("fixture snapshots missing");
    manifest = buildManifest({
      worktreeId: "wt-f",
      n: 1,
      parent: null,
      epoch: 3,
      workspace: sectionOf(ws),
      bulk: { ...sectionOf(bk), platform: "linux-x86_64-gnu" },
    }).manifest;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(ws.objects);
        yield* uploadObjects(bk.objects);
      }).pipe(Effect.provide(BlobStoreFsLive(blobRoot))),
    );
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const snapshotOf = (cls: CaptureClass) => {
    const snapshot = snapshots[cls];
    if (snapshot === null) throw new Error(`no ${cls} snapshot`);
    return snapshot;
  };

  it("names the dir objects the way its format says", () => {
    for (const cls of ["workspace", "bulk"] as const) {
      const snapshot = snapshotOf(cls);
      if (snapshot.format === 2) {
        expect(snapshot.root).toMatch(/^[0-9a-f]{64}$/);
        expect(snapshot.dirPacks.length).toBeGreaterThan(1);
      } else {
        expect(snapshot.root).toContain("/trees/");
        expect(snapshot.dirPacks).toEqual([]);
      }
    }
  });

  it("materializes each class byte for byte", async () => {
    for (const cls of ["workspace", "bulk"] as const) {
      const target = path.join(scratch, `target-${cls}`);
      const before = counting.gets.length;
      const stats = await run(materialize(manifest, cls, target));
      expect(stats.files).toBe(6);
      expect(stats.hardlinks).toBe(1);
      expect(describeTree(target)).toEqual(describeTree(sources[cls]));
      const snapshot = snapshotOf(cls);
      const trees = counting.gets.slice(before).filter((key) => key.includes("/trees/"));
      // Format 1 fetches every dir object on its own; format 2 fetches none.
      expect(trees.length).toBe(snapshot.format === 2 ? 0 : 5);
    }
  });

  it("collects what a plan presigns: every dir object key in format 1, the dir packs in format 2", async () => {
    for (const cls of ["workspace", "bulk"] as const) {
      const snapshot = snapshotOf(cls);
      const keys = await run(collectTreeKeys(manifest, cls));
      if (snapshot.format === 2) {
        expect(keys).toEqual(snapshot.dirPacks);
      } else {
        expect(keys[0]).toBe(snapshot.root);
        expect(keys.toSorted()).toEqual(
          [...snapshot.objects.keys()].filter((key) => key.includes("/trees/")).toSorted(),
        );
      }
    }
    const needed = await run(keysNeededBy(manifest));
    // Two classes can share a dir object (both hold an empty directory): one key, listed once.
    expect(needed.toSorted()).toEqual(
      [
        ...new Set([
          ...snapshotOf("workspace").objects.keys(),
          ...snapshotOf("bulk").objects.keys(),
        ]),
      ].toSorted(),
    );
  });

  it("lists a directory, stats an entry, walks the files and reads one back", async () => {
    for (const cls of ["workspace", "bulk"] as const) {
      const result = await run(
        Effect.gen(function* () {
          const root = yield* listCaptureDir(manifest, cls, "");
          const deep = yield* listCaptureDir(manifest, cls, "src/deep");
          const notADir = yield* listCaptureDir(manifest, cls, "README.md");
          const missing = yield* listCaptureDir(manifest, cls, "src/nope");
          const big = yield* statCaptureEntry(manifest, cls, "src/deep/big.bin");
          const leaf = yield* statCaptureEntry(manifest, cls, "src/deep/deeper/leaf.txt");
          const files = yield* listCaptureFiles(manifest, cls, "");
          const under = yield* listCaptureFiles(manifest, cls, "src/deep");
          const bytes = yield* readCaptureFileBytes(manifest, cls, "src/deep/deeper/leaf.txt");
          const bigBytes = yield* readCaptureFileBytes(manifest, cls, "src/deep/big.bin");
          return { root, deep, notADir, missing, big, leaf, files, under, bytes, bigBytes };
        }),
      );
      expect(result.root?.map((entry) => entry.name)).toEqual([
        "README.md",
        "empty",
        "empty.txt",
        "link.ts",
        "run.sh",
        "src",
      ]);
      expect(result.deep?.map((entry) => entry.name)).toEqual(["big.bin", "deeper"]);
      expect(result.notADir).toBeNull();
      expect(result.missing).toBeNull();
      expect(result.big?.size).toBe(9_000);
      expect(result.big?.chunks?.length).toBe(3);
      expect(result.leaf?.kind).toBe("file");
      expect(result.files.map((file) => file.path).toSorted()).toEqual(filesUnder(sources[cls]));
      expect(result.under.map((file) => file.path).toSorted()).toEqual([
        "src/deep/big.bin",
        "src/deep/deeper/leaf.txt",
      ]);
      expect(Buffer.from(result.bytes).toString("utf8")).toBe(
        fs.readFileSync(path.join(sources[cls], "src/deep/deeper/leaf.txt"), "utf8"),
      );
      expect(
        Buffer.from(result.bigBytes).equals(
          fs.readFileSync(path.join(sources[cls], "src/deep/big.bin")),
        ),
      ).toBe(true);
    }
  });
});

const refusalManifest = (workspace: WorkspaceSection) =>
  buildManifest({ worktreeId: "wt-r", n: 1, parent: null, epoch: 1, workspace }).manifest;

describe("format-2 refusals", () => {
  let scratch = "";
  let blobRoot = "";
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dir-packs-refusals-"));
    blobRoot = path.join(scratch, "blobs");
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BlobStoreFsLive(blobRoot))));

  it("refuses a section format above 2 (or below 1) before anything is read", async () => {
    const built = buildManifest({ worktreeId: "wt-r", n: 0, parent: null, epoch: 1 });
    const parsed = JSON.parse(Buffer.from(built.bytes).toString("utf8"));
    const withFormat = (section: "workspace" | "bulk", format: number) =>
      utf8(
        JSON.stringify({
          ...parsed,
          sections: {
            ...parsed.sections,
            [section]: {
              root: "0".repeat(64),
              packs: [],
              platform: "linux-x86_64-gnu",
              format,
              dir_packs: [],
            },
          },
        }),
      );
    const tags = await Effect.runPromise(
      Effect.forEach(
        [withFormat("workspace", 3), withFormat("bulk", 3), withFormat("workspace", 0)],
        (bytes) => failureTag(decodeManifest("k", bytes)),
      ),
    );
    expect(tags).toEqual(["CaptureFormatError", "CaptureFormatError", "CaptureFormatError"]);
    // Formats 1 and 2 decode, and an absent format reads as format 1.
    const two = await Effect.runPromise(decodeManifest("k", withFormat("bulk", 2)));
    expect(two.sections.bulk).toMatchObject({ format: 2, dir_packs: [] });
    const one = await Effect.runPromise(decodeManifest("k", built.bytes));
    expect(one.sections.workspace).toEqual({ root: "", packs: [] });
  });

  it("refuses a key where a digest belongs, a digest no listed pack holds, and a pack that is not its key", async () => {
    const source = path.join(scratch, "source");
    buildSource(source, "refusals");
    const keys = captureKeys("wt-r", 1);
    const snapshot = snapshotDirectory(source, keys, { chunkSize: 4000, format: 2 });
    await run(uploadObjects(snapshot.objects));
    const section = sectionOf(snapshot);
    const dirPack = snapshot.dirPacks[0];
    if (dirPack === undefined) throw new Error("no dir pack");
    // A dir pack under a key its bytes do not hash to.
    const forgedKey = keys.pack("f".repeat(64));
    await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put(forgedKey, yield* store.get(dirPack));
      }),
    );
    const tags = await run(
      Effect.forEach(
        [
          refusalManifest({ ...section, root: keys.tree(snapshot.root) }),
          refusalManifest({ ...section, dir_packs: [] }),
          refusalManifest({ ...section, dir_packs: [forgedKey] }),
        ],
        (manifest) => failureTag(listCaptureDir(manifest, "workspace", "")),
      ),
    );
    expect(tags).toEqual(["CaptureFormatError", "CaptureFormatError", "CaptureIntegrityError"]);
    // Nothing was written for a refused materialize.
    const target = path.join(scratch, "never");
    const tag = await run(
      failureTag(
        materialize(refusalManifest({ ...section, dir_packs: [forgedKey] }), "workspace", target),
      ),
    );
    expect(tag).toBe("CaptureIntegrityError");
    expect(fs.existsSync(target)).toBe(false);
  });
});

// ─── Cross-check: a store written by sealant-capture ─────────────────────────

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sealantd-dir-packs");

interface ExpectedEntry {
  readonly kind: "dir" | "file" | "symlink";
  readonly mode?: number;
  readonly size?: number;
  readonly sha256?: string;
  readonly nlink?: number;
  readonly target?: string;
}

interface ExpectedHead {
  readonly capture_id: string;
  readonly manifest_key: string;
  readonly bulk: Readonly<Record<string, ExpectedEntry>>;
  readonly env_sha256: string;
}

const expectedHeads = (): Readonly<Record<"v1" | "mixed" | "v2", ExpectedHead>> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE, "heads.json"), "utf8"));

/** Every path under `dir` in the shape the generator recorded (`heads.json`). */
const observedListing = (base: string, dir: string): Record<string, ExpectedEntry> => {
  const out: Record<string, ExpectedEntry> = {};
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, name);
      const rel = path.relative(base, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        out[rel] = { kind: "symlink", target: fs.readlinkSync(full) };
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

describe("a store written by sealant-capture (sealantd PR #99)", () => {
  let scratch = "";
  let blobRoot = "";
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dir-packs-rust-"));
    blobRoot = path.join(scratch, "blobs");
    fs.cpSync(path.join(FIXTURE, "store"), blobRoot, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BlobStoreFsLive(blobRoot))));
  const manifestOf = (head: ExpectedHead) =>
    run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const bytes = yield* store.get(head.manifest_key);
        expect(captureIdOf(bytes)).toBe(head.capture_id);
        return yield* decodeManifest(head.manifest_key, bytes);
      }),
    );

  it("decodes each head with the formats the daemon wrote", async () => {
    const heads = expectedHeads();
    const formats = async (head: ExpectedHead) => {
      const manifest = await manifestOf(head);
      const bulk = manifest.sections.bulk;
      if (bulk === "pending") throw new Error("bulk pending");
      return {
        workspace: manifest.sections.workspace.format ?? 1,
        bulk: bulk.format ?? 1,
        workspaceDirPacks: manifest.sections.workspace.dir_packs?.length ?? 0,
        bulkDirPacks: bulk.dir_packs?.length ?? 0,
      };
    };
    expect(await formats(heads.v1)).toEqual({
      workspace: 1,
      bulk: 1,
      workspaceDirPacks: 0,
      bulkDirPacks: 0,
    });
    expect(await formats(heads.mixed)).toEqual({
      workspace: 2,
      bulk: 1,
      workspaceDirPacks: 1,
      bulkDirPacks: 0,
    });
    expect(await formats(heads.v2)).toEqual({
      workspace: 2,
      bulk: 2,
      workspaceDirPacks: 1,
      bulkDirPacks: 2,
    });
  });

  it("reads every entry of every Rust dir pack with readPackIndex and readChunk", async () => {
    const v2 = await manifestOf(expectedHeads().v2);
    const bulk = v2.sections.bulk;
    if (bulk === "pending") throw new Error("bulk pending");
    const dirPacks = [...(v2.sections.workspace.dir_packs ?? []), ...(bulk.dir_packs ?? [])];
    const read = await run(
      Effect.forEach(dirPacks, (key) =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const bytes = yield* store.get(key);
          expect(`${path.dirname(key)}/${sha256Hex(bytes)}`).toBe(key);
          const index = yield* readPackIndex(key, bytes);
          return yield* Effect.forEach(index, (entry) =>
            Effect.gen(function* () {
              const dir = yield* readChunk(key, bytes, entry);
              expect(sha256Hex(dir)).toBe(entry.hash);
              return yield* decodeDirObject(entry.hash, dir);
            }),
          );
        }),
      ),
    );
    expect(read.flat().length).toBeGreaterThan(10);
    // The root of each section is one of the entries.
    const roots = [v2.sections.workspace.root, bulk.root];
    const hashes = await run(
      Effect.forEach(dirPacks, (key) =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          return yield* readPackIndex(key, yield* store.get(key));
        }),
      ),
    );
    const all = new Set(hashes.flat().map((entry) => entry.hash));
    for (const root of roots) expect(all.has(root)).toBe(true);
  });

  it.each(["v1", "mixed", "v2"] as const)(
    "materializes the %s head as the daemon captured it",
    async (name) => {
      const head = expectedHeads()[name];
      const manifest = await manifestOf(head);
      const bulkTarget = path.join(scratch, `${name}-bulk`);
      const workspaceTarget = path.join(scratch, `${name}-workspace`);
      await run(materialize(manifest, "bulk", bulkTarget));
      await run(materialize(manifest, "workspace", workspaceTarget));
      const observed = observedListing(bulkTarget, path.join(bulkTarget, "node_modules"));
      expect(observed).toEqual(head.bulk);
      // The hardlink pair is one inode again.
      expect(fs.statSync(path.join(bulkTarget, "node_modules/.pnpm/lock-copy.json")).ino).toBe(
        fs.statSync(
          path.join(bulkTarget, "node_modules/.pnpm/pkg0@1.0.0/node_modules/pkg0/package.json"),
        ).ino,
      );
      // The workspace class carries the ignored `.env` under `tree/`.
      expect(sha256Hex(fs.readFileSync(path.join(workspaceTarget, "tree", ".env")))).toBe(
        head.env_sha256,
      );
    },
  );

  it("walks, stats and reads the daemon's format-2 bulk without materializing it", async () => {
    const head = expectedHeads().v2;
    const manifest = await manifestOf(head);
    const blob = "node_modules/.pnpm/pkg1@1.0.0/node_modules/pkg1/dist/blob.bin";
    const result = await run(
      Effect.gen(function* () {
        const files = yield* listCaptureFiles(manifest, "bulk", "node_modules");
        const entry = yield* statCaptureEntry(manifest, "bulk", blob);
        const bytes = yield* readCaptureFileBytes(manifest, "bulk", blob);
        const keys = yield* keysNeededBy(manifest);
        return { files, entry, bytes, keys };
      }),
    );
    // The hardlink member is listed beside the files: the walk names every file-like entry.
    expect(result.files.map((file) => file.path).toSorted()).toEqual(
      Object.entries(head.bulk)
        .filter(([, entry]) => entry.kind === "file")
        .map(([at]) => at)
        .toSorted(),
    );
    expect(result.entry?.chunks?.length ?? 0).toBeGreaterThan(1);
    expect(sha256Hex(result.bytes)).toBe(head.bulk[blob]?.sha256);
    const bulk = manifest.sections.bulk;
    if (bulk === "pending") throw new Error("bulk pending");
    expect(result.keys.some((key) => key.includes("/trees/"))).toBe(false);
    for (const key of [
      ...(manifest.sections.workspace.dir_packs ?? []),
      ...(bulk.dir_packs ?? []),
    ]) {
      expect(result.keys).toContain(key);
    }
  });
});
