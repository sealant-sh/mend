import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Cache, Deferred, Effect, Exit, Scope, Semaphore } from "effect";

import {
  parseBlobId,
  type BlobId,
  RawCacheLimits,
  RawReadError,
  readRawDescriptor,
  revisionFingerprint,
  type ImmutableTree,
  type OpenRawFile,
  type RawBlobTarget,
  type RawTreeSource,
} from "./raw-file.ts";

interface Blob {
  readonly oid: BlobId;
  readonly size: number;
}
interface Lookup {
  readonly repository: string;
  readonly tree: ImmutableTree;
  readonly path: string;
}

const io = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new RawReadError({ reason: "io" }) });
const isErrno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;
/** Cache files are shared with other processes, so their times follow the wall clock. */
const wallClock = () => Date.now();
const unlock = (file: string) => Effect.sync(() => fs.rmSync(file, { force: true }));
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
            fs.createWriteStream(temporary, { flags: "r+", mode: 0o600 }),
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

/**
 * The directory every process on the store shares. Its listing is the only accounting:
 *
 * - `<key>.blob` a published file; its mtime is its lease, refreshed while any process reads it;
 * - `<key>.tmp-<size>-<id>` a file being unpacked, its size reserved, refreshed while it is;
 * - `<key>.lock` the one preparation of a blob, across processes;
 * - `<key>.evict-<id>` a file being evicted;
 * - `<path key>.path` the blob a named tree holds at a path, so a later open needs no Git;
 * - `admit.lock` held while one process counts the directory and reserves room.
 *
 * A file left behind by a crashed process stops being refreshed and goes stale after the lease.
 */
const BLOB = /^([a-f0-9]{64})\.blob$/;
const TEMPORARY = /^[a-f0-9]{64}\.tmp-(\d+)-[a-f0-9-]+$/;
const ABANDONABLE = /^[a-f0-9]{64}\.(?:lock|evict-[a-f0-9-]+|path-[a-f0-9-]+)$/;
const PATH = /^[a-f0-9]{64}\.path$/;

const digest = (...parts: ReadonlyArray<string>) =>
  createHash("sha256").update(parts.join("\0")).digest("hex");
const blobKey = (project: string, oid: BlobId) => digest(project, oid);
const pathKey = (target: RawBlobTarget) =>
  digest(
    target.project,
    target.name.kind === "capture"
      ? `capture:${target.name.captureId}`
      : `commit:${target.name.commit}`,
    target.path,
  );
const contained = (target: RawBlobTarget) =>
  validPath(target.path) &&
  (target.within === "" ||
    (validPath(target.within) && target.path.startsWith(`${target.within}/`)));

interface RawBlobCache {
  readonly open: (
    target: RawBlobTarget,
  ) => Effect.Effect<OpenRawFile | null, RawReadError, Scope.Scope>;
  readonly prepare: (
    target: RawBlobTarget,
    source: RawTreeSource,
  ) => Effect.Effect<void, RawReadError>;
}

export const makeRawBlobCache = (root: string): Effect.Effect<RawBlobCache, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const limits = yield* RawCacheLimits;
    const permits = yield* Semaphore.make(limits.preparations);
    const directory = join(root, "_cache/raw");
    const pending = new Map<string, Deferred.Deferred<void, RawReadError>>();
    const filename = (key: string) => join(directory, `${key}.blob`);
    const touch = (file: string) => {
      const now = new Date(wallClock());
      fs.utimesSync(file, now, now);
    };
    const stale = (file: string) => {
      try {
        return wallClock() - fs.statSync(file).mtimeMs > limits.leaseMillis;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    };
    const removeIfStale = (file: string) => {
      if (stale(file)) fs.rmSync(file, { force: true });
    };
    /** O_EXCL across processes; a holder that stops refreshing it loses it after the lease. */
    const tryLock = (file: string) => {
      try {
        fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if (isErrno(error, "EEXIST")) return false;
        throw error;
      }
    };
    const lock = (file: string, until: () => boolean = () => false) =>
      Effect.gen(function* () {
        while (true) {
          if (yield* io(until)) return false;
          if (yield* io(() => tryLock(file))) return true;
          yield* io(() => removeIfStale(file));
          yield* Effect.sleep(limits.pollMillis);
        }
      });
    /** Keeps a lease, lock or reservation fresh for as long as the caller's scope holds it. */
    const heartbeat = (refresh: () => void) =>
      Effect.forkScoped(
        Effect.ignore(io(refresh)).pipe(Effect.delay(limits.heartbeatMillis), Effect.forever),
      );

    /** Moves an idle file aside, then restores it if a reader leased it in the meantime. */
    const evict = (key: string) => {
      const evicting = join(directory, `${key}.evict-${randomUUID()}`);
      try {
        fs.renameSync(filename(key), evicting);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return true;
        throw error;
      }
      if (wallClock() - fs.statSync(evicting).mtimeMs > limits.leaseMillis) {
        fs.rmSync(evicting, { force: true });
        return true;
      }
      try {
        fs.linkSync(evicting, filename(key));
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      fs.rmSync(evicting, { force: true });
      return false;
    };
    /** Counts the shared directory, evicts idle files to fit, and reserves `size` bytes. */
    const admit = (key: string, size: number) =>
      Effect.acquireUseRelease(
        lock(join(directory, "admit.lock")),
        () =>
          io(() => {
            const now = wallClock();
            const idle: Array<{ key: string; size: number; mtime: number }> = [];
            const paths: Array<{ file: string; mtime: number }> = [];
            let used = 0;
            let files = 0;
            for (const name of fs.readdirSync(directory)) {
              const file = join(directory, name);
              let stat: fs.Stats;
              try {
                stat = fs.lstatSync(file);
              } catch (error) {
                if (isErrno(error, "ENOENT")) continue;
                throw error;
              }
              const age = now - stat.mtimeMs;
              const blob = BLOB.exec(name);
              const temporary = TEMPORARY.exec(name);
              if (blob !== null) {
                used += stat.size;
                files++;
                if (age > limits.leaseMillis)
                  idle.push({ key: blob[1] ?? "", size: stat.size, mtime: stat.mtimeMs });
              } else if (temporary !== null) {
                if (age > limits.leaseMillis) fs.rmSync(file, { force: true });
                else {
                  used += Number(temporary[1]);
                  files++;
                }
              } else if (PATH.test(name)) paths.push({ file, mtime: stat.mtimeMs });
              else if (ABANDONABLE.test(name) && age > limits.leaseMillis)
                fs.rmSync(file, { force: true });
            }
            if (paths.length > limits.paths)
              for (const entry of paths
                .toSorted((a, b) => a.mtime - b.mtime)
                .slice(0, paths.length - limits.paths))
                fs.rmSync(entry.file, { force: true });
            const fits = () => used + size <= limits.totalBytes && files + 1 <= limits.entries;
            for (const entry of idle.toSorted((a, b) => a.mtime - b.mtime)) {
              if (fits()) break;
              if (evict(entry.key)) {
                used -= entry.size;
                files--;
              }
            }
            if (!fits()) return null;
            const temporary = join(directory, `${key}.tmp-${size}-${randomUUID()}`);
            fs.writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
            return temporary;
          }),
        (locked) => (locked ? unlock(join(directory, "admit.lock")) : Effect.void),
      );
    /** One unpack per blob across processes: a loser waits for the winner's published file. */
    const publish = (repository: string, blob: Blob, key: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const published = filename(key);
          const blobLock = join(directory, `${key}.lock`);
          const exists = () => fs.existsSync(published);
          const locked = yield* Effect.acquireRelease(lock(blobLock, exists), (held) =>
            held ? unlock(blobLock) : Effect.void,
          );
          if (!locked || (yield* io(exists))) return;
          const temporary = yield* admit(key, blob.size);
          if (temporary === null) return yield* new RawReadError({ reason: "preparing" });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => fs.rmSync(temporary, { force: true })),
          );
          yield* heartbeat(() => [blobLock, temporary].forEach(touch));
          yield* permits.withPermits(1)(unpack(repository, blob, temporary));
          yield* io(() => {
            const fd = fs.openSync(temporary, "r");
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            fs.renameSync(temporary, published);
          });
        }),
      );
    const initialize = yield* Effect.cached(
      io(() => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
        if (yield* io(() => fs.existsSync(filename(key)))) return;
        const existing = pending.get(key);
        if (existing !== undefined) return yield* Deferred.await(existing);
        if (pending.size >= limits.pending) return yield* new RawReadError({ reason: "preparing" });
        const completion = yield* Deferred.make<void, RawReadError>();
        pending.set(key, completion);
        yield* publish(repository, blob, key).pipe(
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
    const remember = (target: RawBlobTarget, blob: Blob) =>
      io(() => {
        const file = join(directory, `${pathKey(target)}.path`);
        const written = `${file}-${randomUUID()}`;
        fs.writeFileSync(written, `${blob.oid} ${blob.size}`, { flag: "wx", mode: 0o600 });
        fs.renameSync(written, file);
      });
    const recall = (target: RawBlobTarget) =>
      Effect.gen(function* () {
        const file = join(directory, `${pathKey(target)}.path`);
        const text = yield* io(() => {
          try {
            return fs.readFileSync(file, "utf8");
          } catch (error) {
            if (isErrno(error, "ENOENT")) return null;
            throw error;
          }
        });
        const match = /^([a-f0-9]+) (\d+)$/.exec(text ?? "");
        const size = Number(match?.[2]);
        const oid = yield* Effect.option(parseBlobId(match?.[1] ?? ""));
        if (oid._tag === "None" || !Number.isSafeInteger(size)) return null;
        return { oid: oid.value, size };
      });
    const prepareFile: RawBlobCache["prepare"] = (target, source) =>
      Effect.gen(function* () {
        if (!contained(target)) return yield* new RawReadError({ reason: "missing" });
        yield* initialize;
        const blob = yield* Cache.get(metadata, {
          repository: source.repository,
          tree: source.tree,
          path: target.path,
        });
        if (blob.size > limits.fileBytes) return yield* new RawReadError({ reason: "too-large" });
        yield* prepare(source.repository, blob, blobKey(target.project, blob.oid));
        yield* remember(target, blob);
      });
    /**
     * A descriptor of the published file, leased by its refreshed mtime; null when another process
     * evicted it first. The path is checked after the lease, so an eviction that moved the file
     * aside before the lease landed is seen here, not served.
     */
    const lease = (key: string, size: number) =>
      Effect.acquireRelease(
        io(() => {
          let fd: number;
          try {
            fd = fs.openSync(filename(key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          } catch (error) {
            if (isErrno(error, "ENOENT")) return null;
            throw error;
          }
          try {
            const stat = fs.fstatSync(fd);
            const now = new Date(wallClock());
            fs.futimesSync(fd, now, now);
            const named = fs.statSync(filename(key), { throwIfNoEntry: false });
            if (
              stat.isFile() &&
              stat.size === size &&
              named?.ino === stat.ino &&
              named.dev === stat.dev
            )
              return fd;
          } catch (error) {
            fs.closeSync(fd);
            throw error;
          }
          fs.closeSync(fd);
          return null;
        }),
        (fd) =>
          Effect.sync(() => {
            if (fd !== null) fs.closeSync(fd);
          }),
      );
    const open: RawBlobCache["open"] = (target) =>
      Effect.gen(function* () {
        if (!contained(target)) return yield* new RawReadError({ reason: "missing" });
        const blob = yield* recall(target);
        if (blob === null) return null;
        const fd = yield* lease(blobKey(target.project, blob.oid), blob.size);
        if (fd === null) return null;
        yield* heartbeat(() => {
          const now = new Date(wallClock());
          fs.futimesSync(fd, now, now);
        });
        const revision = revisionFingerprint({ kind: "blob", oid: blob.oid });
        return {
          canonicalPath: target.path,
          size: blob.size,
          revision,
          identity: revision,
          read: readRawDescriptor(fd, blob.size),
        };
      });
    return { open, prepare: prepareFile };
  });
