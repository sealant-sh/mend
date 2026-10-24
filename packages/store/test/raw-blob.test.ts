import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { Context, Effect, Layer, type Scope, Stream } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  DEFAULT_RAW_CACHE_LIMITS,
  parseImmutableTree,
  RawCacheLimits,
  type RawBlobTarget,
  RawReadError,
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
const storeLayer = (limits: typeof DEFAULT_RAW_CACHE_LIMITS) =>
  Store.layer.pipe(
    Layer.provide(StoreConfig.layerFor(root)),
    Layer.provide(Layer.succeed(RawCacheLimits, limits)),
  );
const run = <A, E>(body: Effect.Effect<A, E, Store>, limits = DEFAULT_RAW_CACHE_LIMITS) =>
  Effect.runPromise(body.pipe(Effect.provide(storeLayer(limits))));
/** Two stores on one root share nothing in memory, as the API and worker processes do. */
const twoProcesses = <A, E>(
  body: (
    first: Context.Context<Store>,
    second: Context.Context<Store>,
  ) => Effect.Effect<A, E, Scope.Scope>,
  limits = DEFAULT_RAW_CACHE_LIMITS,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* body(
          yield* Layer.build(storeLayer(limits)),
          yield* Layer.build(storeLayer(limits)),
        );
      }),
    ),
  );
/** Short leases, so a file a reader closed goes idle within a test. */
const SHORT_LEASE = {
  ...DEFAULT_RAW_CACHE_LIMITS,
  leaseMillis: 400,
  heartbeatMillis: 25,
  pollMillis: 5,
};
const idle = Effect.sleep(SHORT_LEASE.leaseMillis + 100);
const cached = () =>
  fs.existsSync(join(root, "_cache/raw"))
    ? fs.readdirSync(join(root, "_cache/raw")).filter((name) => name.endsWith(".blob"))
    : [];
const cachedBytes = () =>
  cached().reduce((total, name) => total + fs.statSync(join(root, "_cache/raw", name)).size, 0);
/** What the session layer does: open a prepared file, else prepare it and open it. */
const open = (tree: string, path = "one.bin", within = "") =>
  Effect.gen(function* () {
    const store = yield* Store;
    const commit = yield* parseImmutableTree(tree);
    const target: RawBlobTarget = {
      project: "project",
      name: { kind: "commit", commit },
      path,
      within,
    };
    const ready = yield* store.openRawBlobFile(target);
    if (ready !== null) return ready;
    yield* store.prepareRawBlobFile(target, { repository, tree: commit });
    return (
      (yield* store.openRawBlobFile(target)) ?? (yield* new RawReadError({ reason: "preparing" }))
    );
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
        yield* idle;
        yield* read(tree, "three.bin");
        expect(Buffer.concat(yield* Stream.runCollect(held.read(0, 4)))).toEqual(
          Buffer.from([0, 255, 1, 2]),
        );
        const count = unpacks();
        yield* read(tree);
        expect(unpacks()).toBe(count);
        yield* idle;
        yield* read(tree, "two.bin");
        expect(unpacks()).toBe(count + 1);
        expect(cachedBytes()).toBeLessThanOrEqual(8);
      }),
    ),
    { ...SHORT_LEASE, totalBytes: 8 },
  );
});

it("refuses capacity while all entries are leased, then admits work once a closed file goes idle", async () => {
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
      yield* idle;
      expect(yield* read(tree, "three.bin")).toEqual(Buffer.from([7, 8, 9, 10]));
    }),
    { ...SHORT_LEASE, totalBytes: 8 },
  );
});

it("counts a live writer's reservation and sweeps what a crashed process left", async () => {
  const directory = join(root, "_cache/raw");
  fs.mkdirSync(directory, { recursive: true });
  const live = join(directory, `${"d".repeat(64)}.tmp-8-${randomUUID()}`);
  fs.writeFileSync(live, "part");
  const abandoned = [
    `${"e".repeat(64)}.tmp-4-${randomUUID()}`,
    `${"e".repeat(64)}.lock`,
    `${"f".repeat(64)}.evict-${randomUUID()}`,
  ];
  for (const name of abandoned) {
    fs.writeFileSync(join(directory, name), "left by a crash");
    fs.utimesSync(join(directory, name), new Date(0), new Date(0));
  }
  const tree = git("write-tree");
  await run(
    Effect.gen(function* () {
      expect(yield* Effect.flip(read(tree))).toMatchObject({ reason: "preparing" });
      for (const name of abandoned) expect(fs.existsSync(join(directory, name))).toBe(false);
      yield* idle;
      expect(yield* read(tree)).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(fs.existsSync(live)).toBe(false);
    }),
    { ...SHORT_LEASE, totalBytes: 8 },
  );
});

it("never publishes a failed write and can retry", async () => {
  const directory = join(root, "_cache/raw");
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
          .filter(
            (name) => name.includes(".tmp-") || name.endsWith(".blob") || name.endsWith(".lock"),
          ),
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

it("two processes preparing one blob unpack it once; the second waits for the first's file", async () => {
  const tree = git("write-tree");
  await twoProcesses((first, second) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        Array.from({ length: 8 }, (_, i) =>
          read(tree).pipe(Effect.provide(i % 2 ? first : second)),
        ),
        { concurrency: "unbounded" },
      );
      for (const bytes of results) expect(bytes).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(unpacks()).toBe(1);
    }),
  );
});

it("counts every process's files against the cap and evicts only files no process leased", async () => {
  const tree = git("write-tree");
  await twoProcesses(
    (first, second) =>
      Effect.gen(function* () {
        yield* read(tree).pipe(Effect.provide(first));
        yield* read(tree, "two.bin").pipe(Effect.provide(first));
        expect(
          yield* Effect.flip(read(tree, "three.bin").pipe(Effect.provide(second))),
        ).toMatchObject({ reason: "preparing" });
        expect(cachedBytes()).toBe(8);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const held = yield* open(tree).pipe(Effect.provide(first));
            yield* idle;
            expect(yield* read(tree, "three.bin").pipe(Effect.provide(second))).toEqual(
              Buffer.from([7, 8, 9, 10]),
            );
            expect(cachedBytes()).toBe(8);
            expect(Buffer.concat(yield* Stream.runCollect(held.read(0, 4)))).toEqual(
              Buffer.from([0, 255, 1, 2]),
            );
          }),
        );
        const count = unpacks();
        yield* read(tree).pipe(Effect.provide(second));
        expect(unpacks()).toBe(count);
      }),
    { ...SHORT_LEASE, totalBytes: 8 },
  );
});

it("prepares again a file another process evicted, instead of failing on it", async () => {
  const tree = git("write-tree");
  await twoProcesses((first) =>
    Effect.gen(function* () {
      yield* read(tree).pipe(Effect.provide(first));
      for (const name of cached()) fs.rmSync(join(root, "_cache/raw", name));
      expect(yield* read(tree).pipe(Effect.provide(first))).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(yield* read(tree).pipe(Effect.provide(first))).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(unpacks()).toBe(2);
    }),
  );
});

it("opens a file another process prepared without running Git", async () => {
  const tree = git("write-tree");
  await twoProcesses((first, second) =>
    Effect.gen(function* () {
      yield* read(tree, "two.bin").pipe(Effect.provide(first));
      const count = commands().length;
      expect(yield* read(tree, "two.bin").pipe(Effect.provide(second))).toEqual(
        Buffer.from([3, 4, 5, 6]),
      );
      expect(commands()).toHaveLength(count);
    }),
  );
});
