import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  captureKeys,
  decodeManifest,
  digestOfKey,
  materialize,
  readChunk,
  readPackIndex,
  sha256Hex,
  verifyGitPack,
} from "../src/captures.ts";
import {
  buildManifest,
  chunkBytes,
  snapshotDirectory,
  uploadObjects,
  writeCdcPack,
} from "./capture-fixture.ts";

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const failureTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

describe("CDC pack container", () => {
  const chunks = [utf8("alpha"), utf8("beta".repeat(1000)), new Uint8Array(0), utf8("γάμμα")];
  const pack = writeCdcPack(chunks);
  const key = captureKeys("wt", 1).pack(sha256Hex(pack.bytes));

  it("reads back the index and every chunk, verified", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const index = yield* readPackIndex(key, pack.bytes);
        const decoded = yield* Effect.forEach(index, (entry) => readChunk(key, pack.bytes, entry));
        return { index, decoded };
      }),
    );
    expect(result.index).toEqual(pack.index);
    expect(result.index.map((entry) => entry.size)).toEqual([5, 4000, 0, 10]);
    expect(result.decoded.map((chunk) => Buffer.from(chunk).toString("utf8"))).toEqual([
      "alpha",
      "beta".repeat(1000),
      "",
      "γάμμα",
    ]);
  });

  it("refuses a bad magic, a runaway index length and a chunk outside the data", async () => {
    const badMagic = new Uint8Array(pack.bytes);
    badMagic.set(Buffer.from("SLCP0002"), badMagic.length - 8);
    const runaway = new Uint8Array(pack.bytes);
    Buffer.from(runaway.buffer).writeBigUInt64LE(BigInt(runaway.length * 2), runaway.length - 16);
    const outside = writeCdcPack([utf8("x")]);
    const forged = (() => {
      const index = JSON.stringify([
        { hash: sha256Hex(utf8("x")), offset: 0, length: 1 << 20, size: 1 },
      ]);
      const trailer = Buffer.alloc(8);
      trailer.writeBigUInt64LE(BigInt(index.length));
      return new Uint8Array(
        Buffer.concat([
          Buffer.from(outside.bytes.subarray(0, outside.index[0]?.length ?? 0)),
          Buffer.from(index),
          trailer,
          Buffer.from("SLCP0001"),
        ]),
      );
    })();
    const tags = await Effect.runPromise(
      Effect.forEach([badMagic, runaway, forged, new Uint8Array(3)], (bytes) =>
        failureTag(readPackIndex(key, bytes)),
      ),
    );
    expect(tags).toEqual(Array<string>(4).fill("CaptureFormatError"));
  });

  it("detects a chunk whose bytes no longer hash to the index entry", async () => {
    // Recompress a different payload under the original entry's hash.
    const tampered = writeCdcPack([utf8("alphA")]);
    const entry = { ...pack.index[0]!, length: tampered.index[0]!.length };
    const tag = await Effect.runPromise(failureTag(readChunk(key, tampered.bytes, entry)));
    expect(tag).toBe("CaptureIntegrityError");
  });

  it("chunks a byte string at the writer's size and leaves nothing behind", () => {
    const bytes = new Uint8Array(10_001).fill(7);
    const parts = chunkBytes(bytes, 4000);
    expect(parts.map((part) => part.byteLength)).toEqual([4000, 4000, 2001]);
    expect(chunkBytes(new Uint8Array(0), 4000)).toEqual([]);
  });
});

describe("manifest codec", () => {
  it("decodes ADR-0015's fields and passes unknown ones through", async () => {
    const built = buildManifest({
      worktreeId: "wt-1",
      n: 3,
      parent: "abc",
      epoch: 2,
      kind: "checkpoint",
      seq: 41,
      checkpoint: { ordinal: 1, sha: "deadbeef", ref: "refs/mend/checkpoints/wt-1/1" },
      bulk: { root: "captures/wt-1/2/trees/x", packs: [], platform: "linux-x64-glibc" },
    });
    const withExtra = utf8(
      JSON.stringify({ ...JSON.parse(Buffer.from(built.bytes).toString("utf8")), extra: { a: 1 } }),
    );
    const decoded = await Effect.runPromise(decodeManifest(built.key, withExtra));
    expect(decoded.worktree_id).toBe("wt-1");
    expect(decoded.n).toBe(3);
    expect(decoded.parent).toBe("abc");
    expect(decoded.epoch).toBe(2);
    expect(decoded.seq).toBe(41);
    expect(decoded.kind).toBe("checkpoint");
    expect(decoded.checkpoint).toEqual({
      ordinal: 1,
      sha: "deadbeef",
      ref: "refs/mend/checkpoints/wt-1/1",
    });
    expect(decoded.sections.bulk).toEqual({
      root: "captures/wt-1/2/trees/x",
      packs: [],
      platform: "linux-x64-glibc",
    });
    expect(built.key).toBe(`captures/wt-1/2/manifests/${built.id}`);
    expect(digestOfKey(built.key)).toBe(built.id);
  });

  it("rejects a manifest missing a section or with an unknown kind", async () => {
    const built = buildManifest({ worktreeId: "wt-1", n: 0, parent: null, epoch: 1 });
    const parsed = JSON.parse(Buffer.from(built.bytes).toString("utf8"));
    const noGit = utf8(
      JSON.stringify({ ...parsed, sections: { ...parsed.sections, git: undefined } }),
    );
    const badKind = utf8(JSON.stringify({ ...parsed, kind: "snapshot" }));
    const notJson = utf8("{");
    const tags = await Effect.runPromise(
      Effect.forEach([noGit, badKind, notJson], (bytes) => failureTag(decodeManifest("k", bytes))),
    );
    expect(tags).toEqual(["CaptureFormatError", "CaptureFormatError", "CaptureFormatError"]);
  });

  it("names keys by the fixed layout", () => {
    const keys = captureKeys("wt-9", 4);
    expect(keys.pack("aa")).toBe("captures/wt-9/4/packs/aa");
    expect(keys.packIdx("aa")).toBe("captures/wt-9/4/packs/aa.idx");
    expect(keys.tree("bb")).toBe("captures/wt-9/4/trees/bb");
    expect(keys.manifest("cc")).toBe("captures/wt-9/4/manifests/cc");
    expect(digestOfKey("captures/w/1/packs/not-a-digest")).toBeNull();
  });
});

const describeTree = (root: string) => {
  const out: Array<string> = [];
  const walk = (at: string, rel: string) => {
    for (const name of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(full);
      const mtime = Math.round(stat.mtimeMs);
      if (stat.isDirectory()) {
        out.push(`dir ${relPath} ${(stat.mode & 0o7777).toString(8)} ${mtime}`);
        walk(full, relPath);
      } else if (stat.isSymbolicLink()) {
        out.push(`symlink ${relPath} -> ${fs.readlinkSync(full)}`);
      } else {
        out.push(
          `file ${relPath} ${(stat.mode & 0o7777).toString(8)} ${mtime} ${sha256Hex(fs.readFileSync(full))}`,
        );
      }
    }
  };
  walk(root, "");
  return out;
};

describe("materialize", () => {
  let scratch = "";
  let blobs = "";
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-captures-"));
    blobs = path.join(scratch, "blobs");
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const layer = () => BlobStoreFsLive(blobs);
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));

  /** A workspace with every entry kind, modes, mtimes, a multi-chunk file and a hardlink pair. */
  const buildSource = () => {
    const source = path.join(scratch, `source-${Date.now()}`);
    fs.mkdirSync(path.join(source, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(source, "empty"));
    fs.writeFileSync(path.join(source, "README.md"), "# fixture\n");
    fs.writeFileSync(path.join(source, "src", "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(source, "src", "deep", "big.bin"), Buffer.alloc(9_000, 0xab));
    fs.writeFileSync(path.join(source, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.writeFileSync(path.join(source, "empty.txt"), "");
    fs.symlinkSync("src/index.ts", path.join(source, "link.ts"));
    fs.linkSync(path.join(source, "README.md"), path.join(source, "src", "README-link.md"));
    fs.chmodSync(path.join(source, "src", "deep"), 0o700);
    const old = new Date("2024-03-04T05:06:07.250Z");
    fs.utimesSync(path.join(source, "README.md"), old, old);
    fs.utimesSync(path.join(source, "src", "deep"), old, old);
    return source;
  };

  it("rebuilds a workspace class byte for byte, with modes, mtimes, symlinks and hardlinks", async () => {
    const source = buildSource();
    const keys = captureKeys("wt-m", 1);
    const snapshot = snapshotDirectory(source, keys, { chunkSize: 4000, packBudget: 4096 });
    expect(snapshot.packs.length).toBeGreaterThan(1);
    const built = buildManifest({
      worktreeId: "wt-m",
      n: 1,
      parent: null,
      epoch: 1,
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    const target = path.join(scratch, "target-1");
    const stats = await run(
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        return yield* materialize(built.manifest, "workspace", target);
      }),
    );
    expect(stats).toEqual({
      dirs: 3,
      files: 5,
      symlinks: 1,
      hardlinks: 1,
      bytes: 9_000 + 10 + 20 + 18,
    });
    expect(describeTree(target)).toEqual(describeTree(source));
    // The hardlink pair is one inode again.
    expect(fs.statSync(path.join(target, "README.md")).ino).toBe(
      fs.statSync(path.join(target, "src", "README-link.md")).ino,
    );
    expect(
      fs
        .readFileSync(path.join(target, "src", "deep", "big.bin"))
        .equals(Buffer.alloc(9_000, 0xab)),
    ).toBe(true);
  });

  it("refuses a pending bulk section, a missing chunk, a tampered tree and an escaping name", async () => {
    const source = buildSource();
    const keys = captureKeys("wt-e", 1);
    const snapshot = snapshotDirectory(source, keys, { chunkSize: 4000 });
    const pending = buildManifest({ worktreeId: "wt-e", n: 1, parent: null, epoch: 1 });
    const missingPack = buildManifest({
      worktreeId: "wt-e",
      n: 1,
      parent: null,
      epoch: 1,
      workspace: { root: snapshot.root, packs: [] },
    });
    // A tree whose bytes were altered after its key was minted.
    const rootBytes = snapshot.objects.get(snapshot.root);
    if (rootBytes === undefined) throw new Error("fixture root missing");
    const tampered = new Map(snapshot.objects);
    tampered.set(
      snapshot.root,
      utf8(Buffer.from(rootBytes).toString("utf8").replace("README", "readme")),
    );
    // A tree with a climbing name, honestly keyed.
    const climbing = utf8(
      JSON.stringify([
        { name: "../escape", kind: "file", mode: 0o644, size: 0, mtime: 0, chunks: [] },
      ]),
    );
    const climbingKey = keys.tree(sha256Hex(climbing));
    const climbingManifest = buildManifest({
      worktreeId: "wt-e",
      n: 2,
      parent: null,
      epoch: 1,
      workspace: { root: climbingKey, packs: [] },
    });
    const tags = await run(
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        yield* uploadObjects(new Map([[climbingKey, climbing]]));
        const tag1 = yield* failureTag(
          materialize(pending.manifest, "bulk", path.join(scratch, "t-a")),
        );
        const tag2 = yield* failureTag(
          materialize(missingPack.manifest, "workspace", path.join(scratch, "t-b")),
        );
        const tag4 = yield* failureTag(
          materialize(climbingManifest.manifest, "workspace", path.join(scratch, "t-d")),
        );
        return [tag1, tag2, tag4];
      }),
    );
    expect(tags).toEqual([
      "CaptureSectionPendingError",
      "ChunkNotFoundError",
      "CaptureFormatError",
    ]);
    // The tampered tree lives in its own store so the honest copy above stays intact.
    const tamperedTag = await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(tampered);
        return yield* failureTag(
          materialize(missingPack.manifest, "workspace", path.join(scratch, "t-c")).pipe(
            Effect.provide(BlobStoreFsLive(path.join(scratch, "blobs-tampered"))),
          ),
        );
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(scratch, "blobs-tampered")))),
    );
    expect(tamperedTag).toBe("CaptureIntegrityError");
  });

  it("serves a chunk from a prior epoch's pack when the manifest lists it", async () => {
    const source = buildSource();
    const first = snapshotDirectory(source, captureKeys("wt-x", 1), { chunkSize: 4000 });
    fs.writeFileSync(path.join(source, "new.txt"), "second epoch\n");
    const second = snapshotDirectory(source, captureKeys("wt-x", 2), { chunkSize: 4000 });
    // Epoch 2 wrote its own copies (never skips an upload); a manifest may still name epoch 1's.
    const manifest = buildManifest({
      worktreeId: "wt-x",
      n: 5,
      parent: null,
      epoch: 2,
      workspace: { root: second.root, packs: [...first.packs, ...second.packs] },
    });
    const target = path.join(scratch, "target-x");
    const stats = await run(
      Effect.gen(function* () {
        yield* uploadObjects(first.objects);
        yield* uploadObjects(second.objects);
        return yield* materialize(manifest.manifest, "workspace", target);
      }),
    );
    expect(stats.files).toBe(6);
    expect(fs.readFileSync(path.join(target, "new.txt"), "utf8")).toBe("second epoch\n");
  });
});

describe("verifyGitPack", () => {
  let scratch = "";
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-gitpack-"));
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  it("accepts a self-contained pack with its index and refuses a corrupted one", async () => {
    const repo = path.join(scratch, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo, env: gitEnv });
    const packDir = path.join(scratch, "packs");
    fs.mkdirSync(packDir);
    const name = execFileSync("git", ["pack-objects", "--revs", path.join(packDir, "pack")], {
      cwd: repo,
      env: gitEnv,
      input: "HEAD\n",
    })
      .toString("utf8")
      .trim();
    const packPath = path.join(packDir, `pack-${name}.pack`);
    await Effect.runPromise(verifyGitPack(packPath));
    const corrupted = fs.readFileSync(packPath);
    const at = corrupted.length - 30;
    corrupted.writeUInt8(corrupted.readUInt8(at) ^ 0xff, at);
    // pack-objects writes packs read-only.
    fs.chmodSync(packPath, 0o644);
    fs.writeFileSync(packPath, corrupted);
    const tag = await Effect.runPromise(failureTag(verifyGitPack(packPath)));
    expect(tag).toBe("GitError");
  });
});
