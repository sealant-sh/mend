import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  DEFAULT_RAW_CACHE_LIMITS,
  parseImmutableTree,
  RawCacheLimits,
  Store,
  StoreConfig,
} from "../src/index.ts";

let root: string;
let repository: string;
let trace: string;
let priorTrace: string | undefined;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const missingTree = (oid: string, name: string) => {
  const input = join(root, "mktree-input");
  fs.writeFileSync(input, `100644 blob ${oid}\t${name}\n`);
  const fd = fs.openSync(input, "r");
  try {
    return execFileSync("git", ["mktree", "--missing"], {
      cwd: repository,
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } finally {
    fs.closeSync(fd);
  }
};
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "mend-raw-blob-"));
  repository = join(root, "repo");
  fs.mkdirSync(repository);
  git("init", "-q");
  for (const [name, bytes] of [
    ["one.bin", [0, 255, 1, 2]],
    ["same.bin", [0, 255, 1, 2]],
    ["two.bin", [3, 4, 5, 6]],
    ["three.bin", [7, 8, 9, 10]],
  ] as const)
    fs.writeFileSync(join(repository, name), Uint8Array.from(bytes));
  fs.symlinkSync("one.bin", join(repository, "link.bin"));
  git("add", ".");
  trace = join(root, "git-trace");
  priorTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
});
afterEach(() => {
  if (priorTrace === undefined) delete process.env.GIT_TRACE;
  else process.env.GIT_TRACE = priorTrace;
  fs.rmSync(root, { recursive: true, force: true });
});
const commands = () =>
  fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean) : [];
const unpacks = () => commands().filter((line) => line.includes("cat-file blob")).length;
const run = <A, E>(body: Effect.Effect<A, E, Store>, limits = DEFAULT_RAW_CACHE_LIMITS) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provide(StoreConfig.layerFor(root)),
          Layer.provide(Layer.succeed(RawCacheLimits, limits)),
        ),
      ),
    ),
  );
const open = (tree: string, path = "one.bin", within = "") =>
  Effect.gen(function* () {
    return yield* (yield* Store).openRawBlobFile(repository, {
      tree: yield* parseImmutableTree(tree),
      path,
      within,
    });
  });
const read = (tree: string, path = "one.bin") =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* open(tree, path);
      return Buffer.concat(yield* Stream.runCollect(file.read(0, file.size)));
    }),
  );

it("reads exact immutable bytes and serves later opens and ranges without any Git process", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      const count = commands().length;
      fs.writeFileSync(join(repository, "one.bin"), "current bytes");
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* open(tree);
          expect(Buffer.concat(yield* Stream.runCollect(file.read(2, 2)))).toEqual(
            Buffer.from([1, 2]),
          );
        }),
      );
      expect(commands()).toHaveLength(count);
    }),
  );
});

it("concurrent opens of the same blob, including different paths, unpack exactly once", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      const results = yield* Effect.all(
        Array.from({ length: 16 }, (_, i) => read(tree, i % 2 ? "one.bin" : "same.bin")),
        { concurrency: "unbounded" },
      );
      for (const bytes of results) expect(bytes).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(unpacks()).toBe(1);
    }),
  );
});

it("refuses a blob over 2 GiB before unpacking it", async () => {
  const oid = "a".repeat(40);
  fs.mkdirSync(join(repository, ".git/objects/aa"));
  fs.writeFileSync(
    join(repository, ".git/objects/aa", oid.slice(2)),
    deflateSync(Buffer.from(`blob ${2 * 1024 ** 3 + 1}\0`)),
  );
  const tree = missingTree(oid, "large.bin");
  await run(
    Effect.gen(function* () {
      expect(yield* Effect.flip(read(tree, "large.bin"))).toMatchObject({ reason: "too-large" });
      expect(unpacks()).toBe(0);
    }),
  );
});

it("evicts the least recently used idle file and keeps every open file within the disk cap", async () => {
  expect(DEFAULT_RAW_CACHE_LIMITS.totalBytes).toBe(8 * 1024 ** 3);
  const tree = git("write-tree");
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const held = yield* open(tree);
        yield* read(tree, "two.bin");
        yield* read(tree, "three.bin");
        expect(Buffer.concat(yield* Stream.runCollect(held.read(0, 4)))).toEqual(
          Buffer.from([0, 255, 1, 2]),
        );
        const count = unpacks();
        yield* read(tree);
        expect(unpacks()).toBe(count);
        yield* read(tree, "two.bin");
        expect(unpacks()).toBe(count + 1);
        const directory = join(root, "_cache/raw");
        const bytes = fs
          .readdirSync(directory)
          .reduce(
            (total, name) =>
              total + (name.endsWith(".blob") ? fs.statSync(join(directory, name)).size : 0),
            0,
          );
        expect(bytes).toBeLessThanOrEqual(8);
      }),
    ),
    { ...DEFAULT_RAW_CACHE_LIMITS, totalBytes: 8 },
  );
});

it("refuses capacity while all entries are open, then admits work after a reader closes", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* open(tree);
          yield* open(tree, "two.bin");
          expect(yield* Effect.flip(read(tree, "three.bin"))).toMatchObject({
            reason: "preparing",
          });
        }),
      );
      expect(yield* read(tree, "three.bin")).toEqual(Buffer.from([7, 8, 9, 10]));
    }),
    { ...DEFAULT_RAW_CACHE_LIMITS, totalBytes: 8 },
  );
});

it("never publishes a failed write, sweeps crashed temporary files, and can retry", async () => {
  const directory = join(root, "_cache/raw");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(join(directory, `dead.tmp-${process.pid}-crash`), "partial private bytes");
  const oid = "b".repeat(40);
  const objectDir = join(repository, ".git/objects/bb");
  fs.mkdirSync(objectDir);
  fs.writeFileSync(join(objectDir, oid.slice(2)), deflateSync(Buffer.from("blob 1024\0partial")));
  const tree = missingTree(oid, "broken.bin");
  await run(
    Effect.gen(function* () {
      expect(yield* Effect.result(read(tree, "broken.bin"))).toMatchObject({ _tag: "Failure" });
      expect(
        fs
          .readdirSync(directory)
          .filter((name) => name.includes(".tmp-") || name.endsWith(".blob")),
      ).toEqual([]);
      expect(yield* read(git("write-tree"))).toEqual(Buffer.from([0, 255, 1, 2]));
    }),
  );
});

it("refuses mutable revisions, missing files, symlinks and directory escapes", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      for (const rev of ["HEAD", "main", `${tree}:one.bin`, "a".repeat(41)])
        expect(yield* Effect.result(parseImmutableTree(rev))).toMatchObject({ _tag: "Failure" });
      for (const path of ["missing.bin", "link.bin", "../one.bin", ".git/config", "one\\bin"])
        expect(yield* Effect.flip(read(tree, path))).toMatchObject({ reason: "missing" });
      expect(yield* Effect.flip(Effect.scoped(open(tree, "one.bin", "docs")))).toMatchObject({
        reason: "missing",
      });
    }),
  );
});
