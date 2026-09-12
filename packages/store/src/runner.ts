import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import { Sha } from "@mend/domain";
import { Effect, Layer, Schema, Semaphore } from "effect";
import * as Context from "effect/Context";

import { type BlobNotFoundError, BlobStore, type BlobStoreError } from "./blob-store.ts";
import { type CaptureManifest, digestOfKey, packIdxKeyOf, verifyGitPack } from "./captures.ts";
import { git, type GitError } from "./git.ts";
import {
  type ChangedFile,
  type DiffFileFact,
  type FileListing,
  type StoreBranch,
  Store,
  StoreConfig,
} from "./store.ts";

/**
 * Git operations over captures (ADR-0002 "runner.ts"): a bare-repo cache per project at
 * `<MEND_STORE_ROOT>/_cache/runner/<project>/repo.git`, filled from the git-class packs a
 * manifest lists and pointed at the refs the caller supplies, then today's `Store` bodies run
 * unchanged with the cache as their repository. The cache is never truth: it is rebuilt from the
 * bucket at will, and every pack that enters it is sha256- and `index-pack --verify`-checked.
 */

export class RunnerPackError extends Schema.TaggedErrorClass<RunnerPackError>()("RunnerPackError", {
  key: Schema.String,
  reason: Schema.String,
}) {}

export class RunnerCacheError extends Schema.TaggedErrorClass<RunnerCacheError>()(
  "RunnerCacheError",
  { projectId: Schema.String, cause: Schema.Defect() },
) {}

export type RunnerError =
  | RunnerPackError
  | RunnerCacheError
  | GitError
  | BlobNotFoundError
  | BlobStoreError;

/** A prepared cache: the path git runs in and the refs the operation sees. */
export interface RunnerCache {
  readonly projectId: string;
  readonly path: string;
  /** Merged view: the supplied store refs, overridden by the manifest's own refs. */
  readonly refs: Readonly<Record<string, string>>;
  /** The manifest's `sections.git.head`: a refname or a sha. */
  readonly head: string;
}

export interface EnsureInput {
  readonly projectId: string;
  readonly manifest: CaptureManifest;
  /** Project refs from `store_refs` (`refs/heads/*`, `refs/remotes/origin/*`, `refs/mend/base/*`). */
  readonly storeRefs: Readonly<Record<string, string>>;
}

export interface BlameLine {
  readonly sha: Sha;
  readonly originalLine: number;
  readonly finalLine: number;
  readonly author: string;
  readonly authoredAt: string;
  readonly summary: string;
  readonly content: string;
}

export interface LogEntry {
  readonly sha: Sha;
  readonly author: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export class GitOpsRunner extends Context.Service<
  GitOpsRunner,
  {
    /**
     * Install the manifest's git packs that the cache lacks (verified before they land), write
     * `packed-refs` and `HEAD`, and hand back the cache handle every operation takes. Serialised
     * per project; idempotent.
     */
    readonly ensure: (input: EnsureInput) => Effect.Effect<RunnerCache, RunnerError>;
    /** Resolve a ref or sha through the handle's refs first, then git. */
    readonly resolve: (cache: RunnerCache, ref: string) => Effect.Effect<Sha, GitError>;
    readonly diffRange: (
      cache: RunnerCache,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean; readonly contextLines?: number },
    ) => Effect.Effect<string, GitError>;
    readonly diffFileFacts: (
      cache: RunnerCache,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean },
    ) => Effect.Effect<ReadonlyArray<DiffFileFact>, GitError>;
    readonly changedFiles: (
      cache: RunnerCache,
      a: string,
      b: string,
    ) => Effect.Effect<ReadonlyArray<ChangedFile>, GitError>;
    readonly listTreeFiles: (
      cache: RunnerCache,
      ref: string,
      limit: number,
    ) => Effect.Effect<FileListing, GitError>;
    readonly headSha: (cache: RunnerCache) => Effect.Effect<Sha, GitError>;
    readonly listBranches: (
      cache: RunnerCache,
    ) => Effect.Effect<ReadonlyArray<StoreBranch>, GitError>;
    readonly blame: (
      cache: RunnerCache,
      ref: string,
      file: string,
    ) => Effect.Effect<ReadonlyArray<BlameLine>, GitError>;
    readonly log: (
      cache: RunnerCache,
      ref: string,
      options?: { readonly limit?: number; readonly path?: string },
    ) => Effect.Effect<ReadonlyArray<LogEntry>, GitError>;
  }
>()("@mend/store/GitOpsRunner") {}

// ─── Paths ──────────────────────────────────────────────────────────────────

export const runnerCacheRootOf = (storeRoot: string) => path.join(storeRoot, "_cache", "runner");

export const runnerCachePathOf = (storeRoot: string, projectId: string) =>
  path.join(runnerCacheRootOf(storeRoot), projectId, "repo.git");

/** How many project caches stay on disk; the least recently ensured go first. */
export const RUNNER_CACHE_PROJECTS = 32;

const LAST_USED = "last-used";
const HEX40 = /^[0-9a-f]{40}$/;

// ─── Parsers ────────────────────────────────────────────────────────────────

/** `git blame --line-porcelain`: a header line, attribute lines, then a tab-led content line. */
export const parseLinePorcelain = (raw: string): ReadonlyArray<BlameLine> => {
  const out: Array<BlameLine> = [];
  let current: {
    sha: string;
    originalLine: number;
    finalLine: number;
    author: string;
    authoredAt: string;
    summary: string;
  } | null = null;
  for (const line of raw.split("\n")) {
    if (current === null) {
      const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
      if (header === null) continue;
      current = {
        sha: header[1] ?? "",
        originalLine: Number(header[2]),
        finalLine: Number(header[3]),
        author: "",
        authoredAt: "",
        summary: "",
      };
      continue;
    }
    if (line.startsWith("\t")) {
      out.push({ ...current, sha: Sha.make(current.sha), content: line.slice(1) });
      current = null;
    } else if (line.startsWith("author ")) {
      current.author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      current.authoredAt = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
    }
  }
  return out;
};

const LOG_FORMAT = "%H%x09%an%x09%aI%x09%s";

export const parseLog = (raw: string): ReadonlyArray<LogEntry> =>
  raw === ""
    ? []
    : raw.split("\n").flatMap((line) => {
        const [sha, author = "", authoredAt = "", ...subject] = line.split("\t");
        return sha === undefined || !HEX40.test(sha)
          ? []
          : [{ sha: Sha.make(sha), author, authoredAt, subject: subject.join("\t") }];
      });

/** `packed-refs` in git's sorted, fully-peeled form; refnames are validated by git on read. */
export const renderPackedRefs = (refs: Readonly<Record<string, string>>): string =>
  [
    "# pack-refs with: peeled fully-peeled sorted",
    ...Object.entries(refs)
      .filter(([, sha]) => HEX40.test(sha))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, sha]) => `${sha} ${name}`),
    "",
  ].join("\n");

// ─── Live ───────────────────────────────────────────────────────────────────

export const GitOpsRunnerLive: Layer.Layer<GitOpsRunner, never, Store | StoreConfig | BlobStore> =
  Layer.effect(
    GitOpsRunner,
    Effect.gen(function* () {
      const config = yield* StoreConfig;
      const store = yield* Store;
      const blobs = yield* BlobStore;
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (projectId: string) =>
        Effect.gen(function* () {
          const existing = locks.get(projectId);
          if (existing !== undefined) return existing;
          const created = yield* Semaphore.make(1);
          locks.set(projectId, created);
          return created;
        });

      const cacheIo = <A>(projectId: string, thunk: () => A) =>
        Effect.try({ try: thunk, catch: (cause) => new RunnerCacheError({ projectId, cause }) });

      /** Fetch pack + idx into a temp dir, verify both ways, then move them under objects/pack. */
      const installPack = (projectId: string, cache: string, key: string) =>
        Effect.gen(function* () {
          const digest = digestOfKey(key);
          if (digest === null) {
            return yield* new RunnerPackError({ key, reason: "pack key carries no sha256" });
          }
          const packDir = path.join(cache, "objects", "pack");
          const finalPack = path.join(packDir, `pack-${digest}.pack`);
          const finalIdx = path.join(packDir, `pack-${digest}.idx`);
          if (fs.existsSync(finalPack) && fs.existsSync(finalIdx)) return false;
          const staging = path.join(cache, "objects", `incoming-${crypto.randomUUID()}`);
          const stagedPack = path.join(staging, `pack-${digest}.pack`);
          const stagedIdx = path.join(staging, `pack-${digest}.idx`);
          const attempt = Effect.gen(function* () {
            yield* cacheIo(projectId, () => fs.mkdirSync(staging, { recursive: true }));
            const stream = yield* blobs.getStream(key);
            const hash = crypto.createHash("sha256");
            yield* Effect.tryPromise({
              try: async () => {
                stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
                await pipeline(stream, fs.createWriteStream(stagedPack));
              },
              catch: (cause) =>
                new RunnerPackError({
                  key,
                  reason: `download: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            });
            const actual = hash.digest("hex");
            if (actual !== digest) {
              return yield* new RunnerPackError({
                key,
                reason: `pack bytes hash to ${actual}, key says ${digest}`,
              });
            }
            const idx = yield* blobs.get(packIdxKeyOf(key));
            yield* cacheIo(projectId, () => fs.writeFileSync(stagedIdx, idx));
            yield* verifyGitPack(stagedPack).pipe(
              Effect.mapError(
                (error) =>
                  new RunnerPackError({ key, reason: `index-pack --verify: ${error.stderr}` }),
              ),
            );
            yield* cacheIo(projectId, () => {
              fs.mkdirSync(packDir, { recursive: true });
              fs.renameSync(stagedIdx, finalIdx);
              fs.renameSync(stagedPack, finalPack);
            });
            return true;
          });
          return yield* attempt.pipe(
            Effect.ensuring(
              Effect.sync(() => fs.rmSync(staging, { recursive: true, force: true })),
            ),
          );
        });

      const pruneCaches = (keep: string) =>
        Effect.sync(() => {
          const root = runnerCacheRootOf(config.root);
          if (!fs.existsSync(root)) return;
          const projects = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== keep)
            .map((entry) => {
              const marker = path.join(root, entry.name, LAST_USED);
              const at = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
              return { name: entry.name, at };
            })
            .toSorted((a, b) => a.at - b.at);
          const excess = projects.length + 1 - RUNNER_CACHE_PROJECTS;
          for (const stale of projects.slice(0, Math.max(0, excess))) {
            fs.rmSync(path.join(root, stale.name), { recursive: true, force: true });
          }
        });

      const ensure = Effect.fn("GitOpsRunner.ensure")(function* (input: EnsureInput) {
        const { projectId, manifest } = input;
        const cache = runnerCachePathOf(config.root, projectId);
        const lock = yield* lockFor(projectId);
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (!fs.existsSync(path.join(cache, "HEAD"))) {
              yield* cacheIo(projectId, () => fs.mkdirSync(cache, { recursive: true }));
              yield* git(["init", "-q", "--bare"], cache);
            }
            for (const key of manifest.sections.git.packs) {
              yield* installPack(projectId, cache, key);
            }
            // The manifest's refs are the worktree's own view (its branch tips, checkpoint
            // refs) and win over the project's store refs inside this cache; `store_refs`
            // stays the only durable authority — nothing here writes back to it.
            const refs: Record<string, string> = {
              ...input.storeRefs,
              ...manifest.sections.git.refs,
            };
            const head = manifest.sections.git.head;
            yield* cacheIo(projectId, () => {
              const tmp = path.join(cache, `packed-refs.${process.pid}.${crypto.randomUUID()}`);
              fs.writeFileSync(tmp, renderPackedRefs(refs));
              fs.renameSync(tmp, path.join(cache, "packed-refs"));
              fs.writeFileSync(
                path.join(cache, "HEAD"),
                head.startsWith("refs/") ? `ref: ${head}\n` : `${head}\n`,
              );
              const marker = path.join(path.dirname(cache), LAST_USED);
              fs.writeFileSync(marker, "");
            });
            yield* pruneCaches(projectId);
            return { projectId, path: cache, refs, head } satisfies RunnerCache;
          }),
        );
      });

      const resolve = Effect.fn("GitOpsRunner.resolve")(function* (
        cache: RunnerCache,
        ref: string,
      ) {
        if (HEX40.test(ref)) return Sha.make(ref);
        const direct = cache.refs[ref];
        if (direct !== undefined) return Sha.make(direct);
        if (ref === "HEAD") {
          const head = cache.refs[cache.head];
          if (head !== undefined) return Sha.make(head);
          if (HEX40.test(cache.head)) return Sha.make(cache.head);
        }
        return Sha.make(yield* git(["rev-parse", "--verify", `${ref}^{commit}`], cache.path));
      });

      // Ref arguments resolve through the handle before git sees them, so an operation is
      // immune to a sibling ensure rewriting packed-refs underneath it.
      const diffRange = Effect.fn("GitOpsRunner.diffRange")(function* (
        cache: RunnerCache,
        a: string,
        b: string,
        options?: { readonly ignoreWhitespace?: boolean; readonly contextLines?: number },
      ) {
        const [shaA, shaB] = yield* Effect.all([resolve(cache, a), resolve(cache, b)]);
        return yield* store.diffRange(cache.path, shaA, shaB, options);
      });

      const diffFileFacts = Effect.fn("GitOpsRunner.diffFileFacts")(function* (
        cache: RunnerCache,
        a: string,
        b: string,
        options?: { readonly ignoreWhitespace?: boolean },
      ) {
        const [shaA, shaB] = yield* Effect.all([resolve(cache, a), resolve(cache, b)]);
        return yield* store.diffFileFacts(cache.path, shaA, shaB, options);
      });

      const changedFiles = Effect.fn("GitOpsRunner.changedFiles")(function* (
        cache: RunnerCache,
        a: string,
        b: string,
      ) {
        const [shaA, shaB] = yield* Effect.all([resolve(cache, a), resolve(cache, b)]);
        return yield* store.changedFiles(cache.path, shaA, shaB);
      });

      const listTreeFiles = Effect.fn("GitOpsRunner.listTreeFiles")(function* (
        cache: RunnerCache,
        ref: string,
        limit: number,
      ) {
        const sha = yield* resolve(cache, ref);
        return yield* store.listTreeFiles(cache.path, sha, limit);
      });

      const headSha = Effect.fn("GitOpsRunner.headSha")(function* (cache: RunnerCache) {
        return yield* resolve(cache, "HEAD");
      });

      const listBranches = Effect.fn("GitOpsRunner.listBranches")(function* (cache: RunnerCache) {
        return yield* store.listBranches(cache.path);
      });

      const blame = Effect.fn("GitOpsRunner.blame")(function* (
        cache: RunnerCache,
        ref: string,
        file: string,
      ) {
        const sha = yield* resolve(cache, ref);
        const raw = yield* git(["blame", "--line-porcelain", sha, "--", file], cache.path);
        return parseLinePorcelain(raw);
      });

      const log = Effect.fn("GitOpsRunner.log")(function* (
        cache: RunnerCache,
        ref: string,
        options?: { readonly limit?: number; readonly path?: string },
      ) {
        const sha = yield* resolve(cache, ref);
        const args = ["log", `--format=${LOG_FORMAT}`];
        if (options?.limit !== undefined) args.push("-n", String(options.limit));
        args.push(sha);
        if (options?.path !== undefined) args.push("--", options.path);
        return parseLog(yield* git(args, cache.path));
      });

      return {
        ensure,
        resolve,
        diffRange,
        diffFileFacts,
        changedFiles,
        listTreeFiles,
        headSha,
        listBranches,
        blame,
        log,
      };
    }),
  );
