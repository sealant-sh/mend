import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Cache, Clock, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";

import {
  parseImmutableTree,
  parseBlobId,
  type BlobId,
  RawCacheLimits,
  RawPreparationWait,
  RawReadError,
  readRawDescriptor,
  revisionFingerprint,
  type ImmutableTree,
  type OpenRawFile,
  type RawBlobTarget,
} from "./raw-file.ts";

interface Blob {
  readonly oid: BlobId;
  readonly size: number;
}
interface Entry {
  readonly size: number;
  readers: number;
}
interface Lookup {
  readonly repository: string;
  readonly tree: ImmutableTree;
  readonly path: string;
}

const io = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new RawReadError({ reason: "io" }) });
const validPath = (path: string) =>
  path.length > 0 &&
  Buffer.byteLength(path) <= 4096 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");

const lookupBlob = (input: Lookup): Effect.Effect<Blob, RawReadError> =>
  Effect.gen(function* () {
    const output = yield* Effect.callback<string, RawReadError>((resume) => {
      const child = execFile(
        "git",
        ["--literal-pathspecs", "ls-tree", "-l", "-z", input.tree, "--", input.path],
        { cwd: input.repository, maxBuffer: 16 * 1024, encoding: "utf8" },
        (error, stdout) =>
          resume(
            error === null
              ? Effect.succeed(stdout)
              : Effect.fail(new RawReadError({ reason: "missing" })),
          ),
      );
      return Effect.sync(() => {
        child.kill();
      });
    });
    const end = output.indexOf("\0");
    const tab = output.indexOf("\t");
    const match = /^(100644|100755) blob ([a-f0-9]+) +(\d+)$/.exec(output.slice(0, tab));
    if (
      end !== output.length - 1 ||
      tab < 0 ||
      match === null ||
      output.slice(tab + 1, end) !== input.path
    )
      return yield* new RawReadError({ reason: "missing" });
    const oid = yield* parseBlobId(match[2] ?? "");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0)
      return yield* new RawReadError({ reason: "too-large" });
    return { oid, size };
  });

/** Stream and verify before the atomic rename; stderr never enters an error or trace. */
const unpack = (
  repository: string,
  blob: Blob,
  temporary: string,
): Effect.Effect<void, RawReadError> =>
  Effect.callback<void, RawReadError>((resume) => {
    const controller = new AbortController();
    const write = async (signal: AbortSignal) => {
      const child = spawn("git", ["cat-file", "blob", blob.oid], {
        cwd: repository,
        stdio: ["ignore", "pipe", "ignore"],
        signal,
      });
      const exit = Promise.withResolvers<void>();
      child.once("error", exit.reject);
      child.once("close", (code) => {
        if (code === 0) exit.resolve();
        else exit.reject(new Error("raw unpack failed"));
      });
      const ended = exit.promise;
      let count = 0;
      const hash = createHash(blob.oid.length === 40 ? "sha1" : "sha256").update(
        `blob ${blob.size}\0`,
      );
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          if (count > blob.size) return callback(new Error("raw unpack length"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        const results = await Promise.allSettled([
          ended,
          pipeline(
            child.stdout,
            bounded,
            fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
            { signal },
          ).catch((error: unknown) => {
            child.kill();
            throw error;
          }),
        ]);
        if (
          results.some((result) => result.status === "rejected") ||
          count !== blob.size ||
          hash.digest("hex") !== blob.oid
        )
          throw new Error("raw unpack mismatch");
      } finally {
        child.kill();
        await ended.catch(() => undefined);
      }
    };
    const done = write(controller.signal).then(
      () => resume(Effect.void),
      () => resume(Effect.fail(new RawReadError({ reason: "io" }))),
    );
    // Wait for Node to close its streams before the finalizer removes the temporary file.
    return Effect.promise(async () => {
      controller.abort();
      await done;
    });
  });

interface RawBlobCache {
  readonly open: (
    repository: string,
    target: RawBlobTarget,
  ) => Effect.Effect<OpenRawFile, RawReadError, Scope.Scope>;
  readonly prepare: (
    repository: string,
    target: RawBlobTarget,
  ) => Effect.Effect<void, RawReadError>;
}

/** Store-owned disk state: byte reservations and reader leases require eviction beyond Effect Cache. */
export const makeRawBlobCache = (root: string): Effect.Effect<RawBlobCache, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const clock = yield* Clock.Clock;
    const limits = yield* RawCacheLimits;
    const wait = yield* RawPreparationWait;
    const permits = yield* Semaphore.make(limits.preparations);
    const directory = join(root, "_cache/raw");
    const entries = new Map<string, Entry>();
    const pending = new Map<string, Deferred.Deferred<void, RawReadError>>();
    let used = 0;
    const filename = (key: string) => join(directory, `${key}.blob`);
    const room = (size: number, count = 1) => {
      for (const [key, entry] of entries) {
        if (
          used + size <= limits.totalBytes &&
          entries.size + pending.size + count <= limits.entries
        )
          break;
        if (entry.readers !== 0) continue;
        fs.unlinkSync(filename(key));
        entries.delete(key);
        used -= entry.size;
      }
      return (
        used + size <= limits.totalBytes && entries.size + pending.size + count <= limits.entries
      );
    };
    const initialize = yield* Effect.cached(
      io(() => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const names = fs
          .readdirSync(directory)
          .toSorted(
            (a, b) =>
              fs.lstatSync(join(directory, a)).mtimeMs - fs.lstatSync(join(directory, b)).mtimeMs,
          );
        for (const name of names) {
          const temporary = /\.tmp-(\d+)-/.exec(name);
          if (temporary !== null) {
            let alive = true;
            try {
              process.kill(Number(temporary[1]), 0);
            } catch (error) {
              alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
            }
            if (!alive || Number(temporary[1]) === process.pid)
              fs.rmSync(join(directory, name), { force: true });
          } else if (/^[a-f0-9]{64}\.blob$/.test(name)) {
            const stat = fs.lstatSync(join(directory, name));
            if (!stat.isFile() || stat.size > limits.fileBytes) {
              fs.rmSync(join(directory, name), { force: true });
              continue;
            }
            entries.set(name.slice(0, -5), { size: stat.size, readers: 0 });
            used += stat.size;
          }
        }
        room(0, 0);
      }),
    );
    const metadata = yield* Cache.makeWith(
      (key: Lookup) => permits.withPermits(1)(lookupBlob(key)),
      {
        capacity: 4096,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0),
      },
    );
    const prepare = (repository: string, blob: Blob, key: string) =>
      Effect.gen(function* () {
        const completion = yield* Deferred.make<void, RawReadError>();
        if (entries.has(key)) return;
        const existing = pending.get(key);
        if (existing !== undefined) return yield* Deferred.await(existing);
        if (pending.size >= limits.pending) return yield* new RawReadError({ reason: "preparing" });
        pending.set(key, completion);
        const write = Effect.gen(function* () {
          const admitted = yield* io(() => room(blob.size, 0));
          if (!admitted) return yield* new RawReadError({ reason: "preparing" });
          used += blob.size;
          let published = false;
          const temporary = join(directory, `${key}.tmp-${process.pid}-${randomUUID()}`);
          yield* Effect.gen(function* () {
            yield* unpack(repository, blob, temporary);
            yield* io(() => {
              const fd = fs.openSync(temporary, "r");
              try {
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              fs.renameSync(temporary, filename(key));
              entries.set(key, { size: blob.size, readers: 0 });
              published = true;
            });
          }).pipe(
            Effect.ensuring(
              io(() => {
                fs.rmSync(temporary, { force: true });
                if (!published) used -= blob.size;
              }).pipe(Effect.orDie),
            ),
          );
        }).pipe(permits.withPermits(1));
        yield* write.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(completion, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(key);
            }),
          ),
          Effect.forkIn(lifetime),
        );
        yield* Deferred.await(completion);
      });
    const load = (repository: string, target: RawBlobTarget) =>
      Effect.gen(function* () {
        if (
          !validPath(target.path) ||
          (target.within !== "" &&
            (!validPath(target.within) || !target.path.startsWith(`${target.within}/`)))
        )
          return yield* new RawReadError({ reason: "missing" });
        const immutable = yield* parseImmutableTree(target.tree);
        yield* initialize;
        const location = resolve(repository);
        const blob = yield* Cache.get(metadata, {
          repository: location,
          tree: immutable,
          path: target.path,
        });
        if (blob.size > limits.fileBytes) return yield* new RawReadError({ reason: "too-large" });
        const key = createHash("sha256").update(`${location}\0${blob.oid}`).digest("hex");
        yield* prepare(location, blob, key);
        return { blob, key };
      });
    const open: RawBlobCache["open"] = (repository, target) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(load(repository, target), lifetime);
        const { blob, key } = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () => Effect.fail(new RawReadError({ reason: "preparing" })),
          }),
        );
        const held = yield* Effect.acquireRelease(
          io(() => {
            const entry = entries.get(key);
            if (entry === undefined) throw new Error("raw entry evicted");
            const fd = fs.openSync(filename(key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              const stat = fs.fstatSync(fd);
              if (!stat.isFile() || stat.size !== blob.size) throw new Error("raw entry changed");
              const now = new Date(clock.currentTimeMillisUnsafe());
              fs.futimesSync(fd, now, now);
              entry.readers++;
              entries.delete(key);
              entries.set(key, entry);
              return { fd, entry };
            } catch (error) {
              fs.closeSync(fd);
              throw error;
            }
          }),
          ({ fd, entry }) =>
            Effect.sync(() => {
              fs.closeSync(fd);
              entry.readers--;
            }),
        );
        const revision = revisionFingerprint({ kind: "blob", oid: blob.oid });
        return {
          canonicalPath: target.path,
          size: blob.size,
          revision,
          identity: revision,
          read: readRawDescriptor(held.fd, blob.size),
        };
      });
    return { open, prepare: (repository, target) => load(repository, target).pipe(Effect.asVoid) };
  });
