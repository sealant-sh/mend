import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Deferred, Duration, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import * as Context from "effect/Context";

import {
  parseBlobId,
  type BlobId,
  RawCacheLimits,
  RawReadError,
  readRawDescriptor,
  revisionFingerprint,
  type OpenRawFile,
  type RawBlobTarget,
  type RawTreeSource,
} from "./raw-file.ts";
import { StoreConfig } from "./store.ts";

/**
 * Immutable files unpacked for raw reads. Each process keeps its own directory and decides
 * everything about it in memory, so no two processes share a cache file, a lock or a clock.
 */
export class RawBlobCache extends Context.Service<
  RawBlobCache,
  {
    /** A file this process prepared, held by the caller's scope; null when it has not. Runs no Git. */
    readonly open: (
      target: RawBlobTarget,
    ) => Effect.Effect<OpenRawFile | null, RawReadError, Scope.Scope>;
    /** Find `target` in `source`'s tree and unpack it, once however many callers ask. */
    readonly prepare: (
      target: RawBlobTarget,
      source: RawTreeSource,
    ) => Effect.Effect<void, RawReadError>;
  }
>()("@mend/store/RawBlobCache") {}

interface Blob {
  readonly oid: BlobId;
  readonly size: number;
}
interface Lookup {
  readonly repository: string;
  readonly tree: string;
  readonly path: string;
}

const io = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => new RawReadError({ reason: "io" }) });
const isErrno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;
const validPath = (path: string) =>
  path.length > 0 &&
  Buffer.byteLength(path) <= 4096 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
const contained = (target: RawBlobTarget) =>
  validPath(target.path) &&
  (target.within === "" ||
    (validPath(target.within) && target.path.startsWith(`${target.within}/`)));
const deadline =
  (millis: number) =>
  <A, R>(effect: Effect.Effect<A, RawReadError, R>) =>
    Effect.timeoutOrElse(effect, {
      duration: Duration.millis(millis),
      orElse: () => Effect.fail(new RawReadError({ reason: "io" })),
    });

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

/** Stream into `file` and verify; stderr never enters an error or trace. */
const unpack = (repository: string, blob: Blob, file: string): Effect.Effect<void, RawReadError> =>
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
          pipeline(child.stdout, bounded, fs.createWriteStream(file, { flags: "w", mode: 0o600 }), {
            signal,
          }).catch((error: unknown) => {
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
    // Wait for Node to close its streams before a failed file is removed.
    return Effect.promise(async () => {
      controller.abort();
      await done;
    });
  });

/**
 * One blob's file in this process's directory. Only `unpacking` and `ready` hold bytes against the
 * cap: a preparation waiting for a slot reserves nothing.
 */
interface Pending {
  readonly state: "waiting" | "unpacking";
  readonly size: number;
  readonly done: Deferred.Deferred<void, RawReadError>;
}
type Waiting = Pending & { readonly state: "waiting" };
type Entry = Pending | { readonly state: "ready"; readonly size: number };

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const firstLine = (...files: ReadonlyArray<string>) =>
  files
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8").trim();
      } catch {
        return "";
      }
    })
    .find((line) => line !== "") ?? "";
/** No boot id to read (macOS): a beacon is probed only from the same host name. */
const UNKNOWN_BOOT = "00000000";
/** The kernel boot and the machine a directory's process ran on, hashed into its name. */
export const rawCacheOwner = () => {
  const boot = firstLine("/proc/sys/kernel/random/boot_id");
  return {
    boot: boot === "" ? UNKNOWN_BOOT : shortHash(boot),
    host: shortHash(`${hostname()}\0${firstLine("/etc/machine-id", "/var/lib/dbus/machine-id")}`),
  };
};
const INSTANCE = /^([a-f0-9]{8})-([a-f0-9]{8})-[a-f0-9]{12}(?:\.sock)?$/;

/**
 * Whether the process behind a beacon still runs. Only a socket this kernel bound answers
 * `ECONNREFUSED` once its listener is gone, so that is the one answer taken as proof of death.
 */
const probe = (socket: string) =>
  Effect.callback<"live" | "dead" | "unknown">((resume) => {
    const client = connect(socket);
    const timer = setTimeout(() => {
      client.destroy();
      resume(Effect.succeed("unknown"));
    }, 1000);
    client.once("connect", () => {
      clearTimeout(timer);
      client.destroy();
      resume(Effect.succeed("live"));
    });
    client.once("error", (error) => {
      clearTimeout(timer);
      resume(Effect.succeed(isErrno(error, "ECONNREFUSED") ? "dead" : "unknown"));
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      client.destroy();
    });
  });

const listen = (socket: string) =>
  Effect.callback<Server | null>((resume) => {
    const server = createServer((connection) => connection.destroy());
    server.once("error", () => resume(Effect.succeed(null)));
    server.listen(socket, () => {
      server.unref();
      resume(Effect.succeed(server));
    });
  });

/**
 * Removes the directories of processes that are provably gone, and nothing else:
 *
 * - from this kernel boot: its beacon refuses connections. A Unix socket answers `ECONNREFUSED`
 *   once the process that bound it has exited, and only this kernel can tell;
 * - from an earlier boot of this machine: no process of that boot still runs.
 *
 * A directory of another machine, or one whose beacon answers or cannot be probed, is left alone.
 * Machines that share one store must have distinct host names or machine ids.
 */
const sweep = (parent: string, own: string, owner: ReturnType<typeof rawCacheOwner>) =>
  Effect.gen(function* () {
    const names = new Set(
      (yield* io(() => fs.readdirSync(parent)))
        .map((name) => name.replace(/\.sock$/, ""))
        .filter((name) => name !== own && INSTANCE.test(name)),
    );
    let kept = 0;
    for (const name of names) {
      const [boot, host] = name.split("-");
      const thisBoot = boot === owner.boot && (boot !== UNKNOWN_BOOT || host === owner.host);
      const gone = thisBoot
        ? (yield* probe(join(parent, `${name}.sock`))) === "dead"
        : host === owner.host;
      if (!gone) {
        kept++;
        continue;
      }
      yield* Effect.tryPromise(() =>
        fs.promises.rm(join(parent, name), { recursive: true, force: true }),
      );
      yield* io(() => fs.rmSync(join(parent, `${name}.sock`), { force: true }));
    }
    if (kept > 0)
      yield* Effect.logInfo("raw cache: directories of other processes left in place").pipe(
        Effect.annotateLogs({ count: kept }),
      );
  }).pipe(Effect.ignore);

const blobKey = (project: string, oid: BlobId) =>
  createHash("sha256").update(`${project}\0${oid}`).digest("hex");
const pathKey = (target: RawBlobTarget) =>
  [
    target.project,
    target.name.kind === "capture" ? target.name.captureId : target.name.commit,
    target.path,
  ].join("\0");
/** Moves `key` to the end of `map`'s insertion order: the most recently used. */
const touch = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
};

const makeRawBlobCache = (
  parent: string,
): Effect.Effect<RawBlobCache["Service"], RawReadError, Scope.Scope> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const limits = yield* RawCacheLimits;
    const owner = rawCacheOwner();
    const own = `${owner.boot}-${owner.host}-${randomBytes(6).toString("hex")}`;
    const directory = join(parent, own);
    yield* io(() => fs.mkdirSync(parent, { recursive: true, mode: 0o700 }));
    // The beacon is bound before the directory exists, so no sweep sees the directory unowned.
    const beacon = join(parent, `${own}.sock`);
    const server = yield* listen(beacon);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server?.close();
        fs.rmSync(beacon, { force: true });
      }),
    );
    if (server === null)
      yield* Effect.logWarning(
        "raw cache: no liveness beacon · a crash leaves this process's directory in place",
      );
    yield* io(() => fs.mkdirSync(directory, { mode: 0o700 }));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.promises.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.forkIn(sweep(parent, own, owner), lifetime);

    const large = yield* Semaphore.make(limits.largeUnpacks);
    const small = yield* Semaphore.make(limits.smallUnpacks);
    /** In least recently used order: a use moves a key to the end. */
    const entries = new Map<string, Entry>();
    const readers = new Map<string, number>();
    const paths = new Map<string, Blob>();
    let used = 0;
    const fileOf = (key: string) => join(directory, key);
    const recall = (target: RawBlobTarget) => {
      const key = pathKey(target);
      const blob = paths.get(key);
      if (blob !== undefined) touch(paths, key, blob);
      return blob ?? null;
    };
    const remember = (target: RawBlobTarget, blob: Blob) => {
      touch(paths, pathKey(target), blob);
      for (const key of paths.keys()) {
        if (paths.size <= limits.paths) break;
        paths.delete(key);
      }
    };
    const drop = (key: string, entry: Entry) => {
      entries.delete(key);
      if (entry.state !== "waiting") used -= entry.size;
      fs.rmSync(fileOf(key), { force: true });
    };
    /** Evicts idle files, oldest use first, until `size` fits; then reserves it. */
    const reserve = (key: string, entry: Waiting) =>
      Effect.flatMap(
        io(() => {
          let files = [...entries.values()].filter((other) => other.state !== "waiting").length;
          const fits = () => used + entry.size <= limits.totalBytes && files < limits.entries;
          for (const [other, held] of entries) {
            if (fits()) break;
            if (held.state !== "ready" || readers.has(other)) continue;
            drop(other, held);
            files--;
          }
          if (!fits()) return false;
          entries.set(key, { ...entry, state: "unpacking" });
          used += entry.size;
          return true;
        }),
        (reserved) => (reserved ? Effect.void : Effect.fail(new RawReadError({ reason: "full" }))),
      );
    const unpackOnce = (repository: string, blob: Blob, key: string) =>
      Effect.suspend(() => {
        const existing = entries.get(key);
        if (existing?.state === "ready") {
          touch(entries, key, existing);
          return Effect.void;
        }
        if (existing !== undefined) return Deferred.await(existing.done);
        const entry: Waiting = {
          state: "waiting",
          size: blob.size,
          done: Deferred.makeUnsafe<void, RawReadError>(),
        };
        entries.set(key, entry);
        const job = (blob.size > limits.largeBytes ? large : small).withPermits(1)(
          reserve(key, entry).pipe(
            Effect.andThen(
              unpack(repository, blob, fileOf(key)).pipe(
                deadline(limits.gitMillis + (blob.size / limits.unpackBytesPerSecond) * 1000),
              ),
            ),
          ),
        );
        return job.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const current = entries.get(key) ?? entry;
              if (Exit.isSuccess(exit)) touch(entries, key, { state: "ready", size: blob.size });
              else drop(key, current);
            }).pipe(Effect.andThen(Deferred.done(entry.done, exit))),
          ),
          Effect.forkIn(lifetime),
          Effect.andThen(Deferred.await(entry.done)),
        );
      });
    const prepare: RawBlobCache["Service"]["prepare"] = (target, source) =>
      Effect.gen(function* () {
        if (!contained(target)) return yield* new RawReadError({ reason: "missing" });
        const blob =
          recall(target) ??
          (yield* lookupBlob({
            repository: source.repository,
            tree: source.tree,
            path: target.path,
          }).pipe(deadline(limits.gitMillis)));
        if (blob.size > limits.fileBytes) return yield* new RawReadError({ reason: "too-large" });
        remember(target, blob);
        yield* unpackOnce(source.repository, blob, blobKey(target.project, blob.oid));
      });
    /** A reader holds its file against eviction from open until its scope closes. */
    const lease = (key: string, entry: Entry) =>
      Effect.acquireRelease(
        io(() => {
          let fd: number;
          try {
            fd = fs.openSync(fileOf(key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
            drop(key, entry);
            return null;
          }
          readers.set(key, (readers.get(key) ?? 0) + 1);
          touch(entries, key, entry);
          return fd;
        }),
        (fd) =>
          Effect.sync(() => {
            if (fd === null) return;
            fs.closeSync(fd);
            const left = (readers.get(key) ?? 1) - 1;
            if (left > 0) readers.set(key, left);
            else readers.delete(key);
          }),
      );
    const open: RawBlobCache["Service"]["open"] = (target) =>
      Effect.gen(function* () {
        if (!contained(target)) return yield* new RawReadError({ reason: "missing" });
        const blob = recall(target);
        if (blob === null) return null;
        const key = blobKey(target.project, blob.oid);
        const entry = entries.get(key);
        if (entry?.state !== "ready") return null;
        const fd = yield* lease(key, entry);
        if (fd === null) return null;
        const revision = revisionFingerprint({ kind: "blob", oid: blob.oid });
        return {
          canonicalPath: target.path,
          size: blob.size,
          revision,
          identity: revision,
          read: readRawDescriptor(fd, blob.size),
        };
      });
    return { open, prepare };
  });

const off: RawBlobCache["Service"] = {
  open: () => Effect.succeed(null),
  prepare: () => Effect.fail(new RawReadError({ reason: "io" })),
};

/** A process that never opens raw files (the worker) keeps no cache and no directory. */
export const RawBlobCacheOff: Layer.Layer<RawBlobCache> = Layer.succeed(RawBlobCache, off);

/**
 * `<store root>/_cache/raw/<boot>-<host>-<id>/`, made empty at start and removed at shutdown,
 * beside the `<id>.sock` beacon that proves its process alive. A directory the store cannot hold
 * leaves this process without a cache: raw reads it would prepare fail, others are unaffected.
 */
export const RawBlobCacheLive: Layer.Layer<RawBlobCache, never, StoreConfig> = Layer.effect(
  RawBlobCache,
  Effect.gen(function* () {
    const config = yield* StoreConfig;
    return yield* makeRawBlobCache(join(config.root, "_cache", "raw")).pipe(
      Effect.catch(() =>
        Effect.logWarning("raw cache: unavailable · its directory could not be made").pipe(
          Effect.as(off),
        ),
      ),
    );
  }),
);
