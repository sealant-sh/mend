import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { deflateSync } from "node:zlib";

import { Duration, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  DEFAULT_RAW_CACHE_LIMITS,
  parseImmutableTree,
  RawBlobCache,
  RawBlobCacheLive,
  RawBlobCacheOff,
  RawCacheLimits,
  type RawBlobTarget,
  RawReadError,
  StoreConfig,
} from "../src/index.ts";
import { rawCacheOwner } from "../src/raw-blob-cache.ts";

let root: string;
let repository: string;
let trace: string;
let realPath: string;
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
    ["big1.bin", [1, 1, 1, 1, 1, 1, 1, 1]],
    ["big2.bin", [2, 2, 2, 2, 2, 2, 2, 2]],
  ] as const)
    fs.writeFileSync(join(repository, name), Uint8Array.from(bytes));
  fs.symlinkSync("one.bin", join(repository, "link.bin"));
  git("add", ".");
  // A git first on PATH that traces every run and never finishes unpacking a blob named in
  // MEND_TEST_SLOW_BLOBS: how a test holds an unpack open.
  realPath = process.env["PATH"] ?? "";
  trace = join(root, "git-trace");
  const shim = join(root, "bin");
  fs.mkdirSync(shim);
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(
    join(shim, "git"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${trace}"`,
      'for oid in $MEND_TEST_SLOW_BLOBS; do case "$*" in *"cat-file blob $oid"*) exec sleep 600;; esac; done',
      `exec "${real}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(trace, "");
  process.env["PATH"] = `${shim}${delimiter}${realPath}`;
});
afterEach(() => {
  process.env["PATH"] = realPath;
  delete process.env["MEND_TEST_SLOW_BLOBS"];
  fs.rmSync(root, { recursive: true, force: true });
});
const commands = () => fs.readFileSync(trace, "utf8").split("\n").filter(Boolean);
const unpacks = () => commands().filter((line) => line.startsWith("cat-file blob")).length;
const slow = (...names: string[]) => {
  process.env["MEND_TEST_SLOW_BLOBS"] = names.map((name) => git("hash-object", name)).join(" ");
};
type Limits = typeof DEFAULT_RAW_CACHE_LIMITS;
const cacheLayer = (limits: Partial<Limits> = {}) =>
  RawBlobCacheLive.pipe(
    Layer.provide(StoreConfig.layerFor(root)),
    Layer.provide(Layer.succeed(RawCacheLimits, { ...DEFAULT_RAW_CACHE_LIMITS, ...limits })),
  );
const run = <A, E>(body: Effect.Effect<A, E, RawBlobCache>, limits: Partial<Limits> = {}) =>
  Effect.runPromise(body.pipe(Effect.provide(cacheLayer(limits))));
const rawRoot = () => join(root, "_cache/raw");
/** Every file under the raw cache, whichever process's directory holds it. */
const cachedFiles = (): ReadonlyArray<string> =>
  fs.existsSync(rawRoot())
    ? fs
        .readdirSync(rawRoot(), { recursive: true, encoding: "utf8" })
        .map((name) => join(rawRoot(), name))
        .filter((file) => fs.lstatSync(file).isFile())
    : [];
const cachedBytes = () => cachedFiles().reduce((total, file) => total + fs.statSync(file).size, 0);
const target = (tree: string, path: string, within = "") =>
  Effect.map(
    parseImmutableTree(tree),
    (commit): RawBlobTarget => ({
      project: "project",
      name: { kind: "commit", commit },
      path,
      within,
    }),
  );
const openOnly = (tree: string, path: string) =>
  Effect.flatMap(target(tree, path), (file) =>
    Effect.flatMap(RawBlobCache, (cache) => cache.open(file)),
  );
/** What the session layer does: open a prepared file, else prepare it and open it. */
const open = (tree: string, path = "one.bin", within = "") =>
  Effect.gen(function* () {
    const cache = yield* RawBlobCache;
    const file = yield* target(tree, path, within);
    const ready = yield* cache.open(file);
    if (ready !== null) return ready;
    yield* cache.prepare(file, {
      repository,
      tree: yield* parseImmutableTree(tree),
    });
    return (yield* cache.open(file)) ?? (yield* new RawReadError({ reason: "preparing" }));
  });
const read = (tree: string, path = "one.bin") =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* open(tree, path);
      return Buffer.concat(yield* Stream.runCollect(file.read(0, file.size)));
    }),
  );
const promptly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeout(effect, Duration.seconds(3));
const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries++) {
    if (tries > 200) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

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
      expect(yield* Effect.flip(read(tree, "large.bin"))).toMatchObject({
        reason: "too-large",
      });
      expect(unpacks()).toBe(0);
    }),
  );
});

it("evicts the least recently used file no one reads, never an open one, and stays within the cap", async () => {
  expect(DEFAULT_RAW_CACHE_LIMITS.totalBytes).toBe(8 * 1024 ** 3);
  const tree = git("write-tree");
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const held = yield* open(tree);
        yield* read(tree, "two.bin");
        yield* read(tree, "three.bin");
        expect(cachedBytes()).toBeLessThanOrEqual(8);
        expect(Buffer.concat(yield* Stream.runCollect(held.read(0, 4)))).toEqual(
          Buffer.from([0, 255, 1, 2]),
        );
        const count = unpacks();
        yield* read(tree);
        expect(unpacks()).toBe(count);
        yield* read(tree, "two.bin");
        expect(unpacks()).toBe(count + 1);
        expect(cachedBytes()).toBeLessThanOrEqual(8);
      }),
    ),
    { totalBytes: 8 },
  );
});

it("refuses as full while every file is being read, then admits work once a reader closes", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* open(tree);
          yield* open(tree, "two.bin");
          expect(yield* Effect.flip(read(tree, "three.bin"))).toMatchObject({
            reason: "full",
          });
        }),
      );
      expect(yield* read(tree, "three.bin")).toEqual(Buffer.from([7, 8, 9, 10]));
    }),
    { totalBytes: 8 },
  );
});

it("reserves room only while unpacking: a small file prepares while a large unpack runs and another waits", async () => {
  const tree = git("write-tree");
  slow("big1.bin");
  await run(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(read(tree, "big1.bin"));
      yield* Effect.sleep("200 millis");
      const second = yield* Effect.forkChild(read(tree, "big2.bin"));
      yield* Effect.sleep("200 millis");
      expect(yield* promptly(read(tree, "one.bin"))).toEqual(Buffer.from([0, 255, 1, 2]));
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
    }),
    { largeUnpacks: 1, largeBytes: 4, totalBytes: 16 },
  );
});

it("ends an unpack that never finishes at its deadline and frees its room", async () => {
  const tree = git("write-tree");
  slow("big1.bin");
  await run(
    Effect.gen(function* () {
      expect(yield* Effect.flip(promptly(read(tree, "big1.bin")))).toMatchObject({ reason: "io" });
      expect(yield* promptly(read(tree, "big2.bin"))).toEqual(
        Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]),
      );
      expect(cachedBytes()).toBe(8);
    }),
    { totalBytes: 8, gitMillis: 300 },
  );
});

it("remembers at most `paths` prepared paths, even when they share one blob", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* read(tree, "one.bin");
      yield* read(tree, "same.bin");
      expect(yield* Effect.scoped(openOnly(tree, "one.bin"))).toBeNull();
      expect(yield* Effect.scoped(openOnly(tree, "same.bin"))).not.toBeNull();
    }),
    { paths: 1 },
  );
});

it("forgets the least recently opened path first", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* read(tree, "one.bin");
      yield* read(tree, "two.bin");
      expect(yield* Effect.scoped(openOnly(tree, "one.bin"))).not.toBeNull();
      yield* read(tree, "three.bin");
      expect(yield* Effect.scoped(openOnly(tree, "two.bin"))).toBeNull();
      expect(yield* Effect.scoped(openOnly(tree, "one.bin"))).not.toBeNull();
    }),
    { paths: 2 },
  );
});

it("never serves a failed write and can retry", async () => {
  const oid = "b".repeat(40);
  const objectDir = join(repository, ".git/objects/bb");
  fs.mkdirSync(objectDir);
  fs.writeFileSync(join(objectDir, oid.slice(2)), deflateSync(Buffer.from("blob 1024\0partial")));
  const tree = missingTree(oid, "broken.bin");
  await run(
    Effect.gen(function* () {
      expect(yield* Effect.result(read(tree, "broken.bin"))).toMatchObject({
        _tag: "Failure",
      });
      expect(cachedFiles()).toEqual([]);
      expect(yield* Effect.scoped(openOnly(tree, "broken.bin"))).toBeNull();
      expect(yield* read(git("write-tree"))).toEqual(Buffer.from([0, 255, 1, 2]));
    }),
  );
});

it("prepares again a file removed from under it, instead of failing on it", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* read(tree);
      for (const file of cachedFiles()) fs.rmSync(file);
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(unpacks()).toBe(2);
    }),
  );
});

it("refuses mutable revisions, missing files, symlinks and directory escapes", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      for (const rev of ["HEAD", "main", `${tree}:one.bin`, "a".repeat(41)])
        expect(yield* Effect.result(parseImmutableTree(rev))).toMatchObject({
          _tag: "Failure",
        });
      for (const path of ["missing.bin", "link.bin", "../one.bin", ".git/config", "one\\bin"])
        expect(yield* Effect.flip(read(tree, path))).toMatchObject({
          reason: "missing",
        });
      expect(yield* Effect.flip(Effect.scoped(open(tree, "one.bin", "docs")))).toMatchObject({
        reason: "missing",
      });
    }),
  );
});

it("closes promptly while one preparation unpacks and another waits for its slot, leaving nothing on disk", async () => {
  const tree = git("write-tree");
  slow("big1.bin");
  const scope = Scope.makeUnsafe();
  const context = await Effect.runPromise(
    Layer.build(cacheLayer({ largeUnpacks: 1, largeBytes: 4 })).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  for (const name of ["big1.bin", "big2.bin"])
    Effect.runFork(read(tree, name).pipe(Effect.provide(context)));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Effect.runPromise(promptly(Scope.close(scope, Exit.void)));
  expect(fs.readdirSync(rawRoot())).toEqual([]);
});

it("each cache keeps its own directory: a second one shares no file and closes without touching the first", async () => {
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* read(tree);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* Layer.build(Layer.fresh(cacheLayer()));
          expect(
            yield* Effect.scoped(openOnly(tree, "one.bin")).pipe(Effect.provide(second)),
          ).toBeNull();
          expect(yield* read(tree).pipe(Effect.provide(second))).toEqual(
            Buffer.from([0, 255, 1, 2]),
          );
          expect(fs.readdirSync(rawRoot()).filter((name) => !name.endsWith(".sock"))).toHaveLength(
            2,
          );
        }),
      );
      expect(fs.readdirSync(rawRoot()).filter((name) => !name.endsWith(".sock"))).toHaveLength(1);
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(unpacks()).toBe(2);
    }),
  );
});

/** A directory as a process with this name left it, its beacon bound by a child that then died. */
const leftBehind = (name: string, beacon: "dead" | "none") => {
  fs.mkdirSync(join(rawRoot(), name), { recursive: true });
  fs.writeFileSync(join(rawRoot(), name, "a".repeat(64)), "left by a crash");
  if (beacon === "dead") {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
        join(rawRoot(), `${name}.sock`),
      ],
      { stdio: "ignore" },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(fs.existsSync(join(rawRoot(), `${name}.sock`))).toBe(true);
  }
  return join(rawRoot(), name);
};
const instance = (boot: string, host: string) =>
  `${boot}-${host}-${randomBytes(6).toString("hex")}`;

it("removes at start what a crashed process left on this kernel, and keeps a live one's", async () => {
  const owner = rawCacheOwner();
  const crashed = leftBehind(instance(owner.boot, owner.host), "dead");
  const earlierBoot = leftBehind(instance("1".repeat(8), owner.host), "none");
  const otherHost = leftBehind(instance("1".repeat(8), "f".repeat(8)), "none");
  const noBeacon = leftBehind(instance(owner.boot, owner.host), "none");
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      yield* read(tree);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(Layer.fresh(cacheLayer()));
          yield* Effect.promise(() =>
            until(() => !fs.existsSync(crashed) && !fs.existsSync(earlierBoot)),
          );
        }),
      );
      expect(fs.existsSync(`${crashed}.sock`)).toBe(false);
      expect(fs.existsSync(otherHost)).toBe(true);
      expect(fs.existsSync(noBeacon)).toBe(true);
      const count = commands().length;
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(commands()).toHaveLength(count);
    }),
  );
});

it("a process that opens no raw files keeps no cache directory", async () => {
  const tree = git("write-tree");
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* Effect.scoped(openOnly(tree, "one.bin"))).toBeNull();
      expect(yield* Effect.flip(read(tree))).toBeInstanceOf(RawReadError);
    }).pipe(Effect.provide(RawBlobCacheOff)),
  );
  expect(fs.existsSync(rawRoot())).toBe(false);
  expect(unpacks()).toBe(0);
});
