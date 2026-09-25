import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { git } from "./git.ts";
import { StoreConfig } from "./store.ts";

/**
 * The dotfiles store: one bare git repo per user under `<storeRoot>/_dotfiles/<userId>.git`,
 * holding the home files that user synced from wherever they actually work (`mend dotfiles sync`
 * on their laptop, an upload in the web app). Dotfiles are identity — the Mend server's own home
 * directory is deliberately never read: on a VPS it belongs to a service account, and different
 * accounts on one instance carry different configs.
 *
 * A snapshot is a commit: paths are `~`-relative, the commit subject records the source machine,
 * and the sha is what sessions stamp as the exact content they launched with. Git gives history,
 * dedup, and `git archive` packing for free.
 */

export class DotfilesStoreError extends Schema.TaggedErrorClass<DotfilesStoreError>()(
  "DotfilesStoreError",
  { message: Schema.String },
) {}

export interface DotfilesSnapshotFile {
  /** `~`-relative path (e.g. `.zshrc`, `.config/starship.toml`). */
  readonly path: string;
  readonly contentsBase64: string;
  /** Octal file mode (e.g. "644", "755"); defaults to 644. */
  readonly mode?: string | undefined;
}

export interface DotfilesSnapshotSummary {
  readonly sha: string;
  /** The machine the sync came from, as reported by the caller. */
  readonly source: string;
  readonly committedAt: Date;
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
}

/** One snapshot decoded must fit the platform's per-archive cap; dotfiles are text. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

/** A home-relative path the store accepts: relative, normalized, no escapes. */
export const isSafeHomePath = (value: string): boolean =>
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.split("/").some((segment) => segment === ".." || segment === "" || segment === ".");

const isSafeUserId = (value: string): boolean => /^[A-Za-z0-9_.-]+$/.test(value);

export class DotfilesStore extends Context.Service<
  DotfilesStore,
  {
    /**
     * Commit a set of files as the user's snapshot. `merge: true` overlays onto the current
     * snapshot (the web's add-a-file path); `merge: false` replaces it wholesale (the CLI's
     * sync). A snapshot identical to the current one returns it unchanged.
     */
    readonly snapshot: (
      userId: string,
      files: ReadonlyArray<DotfilesSnapshotFile>,
      options: { readonly source: string; readonly merge: boolean },
    ) => Effect.Effect<DotfilesSnapshotSummary, DotfilesStoreError>;
    /** The current snapshot, or null when the user has never synced. */
    readonly current: (
      userId: string,
    ) => Effect.Effect<DotfilesSnapshotSummary | null, DotfilesStoreError>;
    /** The current snapshot packed as base64 `.tar.gz`, or null when none exists. */
    readonly archive: (
      userId: string,
    ) => Effect.Effect<{ readonly sha: string; readonly data: string } | null, DotfilesStoreError>;
    /** Remove the user's snapshot history entirely. */
    readonly clear: (userId: string) => Effect.Effect<void, DotfilesStoreError>;
  }
>()("@mend/store/DotfilesStore") {}

const toStoreError = (context: string) => (error: { readonly stderr?: string }) =>
  new DotfilesStoreError({
    message: `${context}: ${error.stderr === undefined || error.stderr === "" ? "git failed" : error.stderr}`,
  });

/** `git archive` output is binary — the text-mode helper in git.ts would mangle it. */
const gitBuffer = (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Effect.Effect<Buffer, DotfilesStoreError> =>
  Effect.callback((resume) => {
    const child = execFile(
      "git",
      [...args],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout));
          return;
        }
        resume(
          Effect.fail(
            new DotfilesStoreError({
              message: `git ${args[0] ?? ""} failed: ${stderr.toString("utf8").trim()}`,
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

const hasSnapshot = (dir: string): Effect.Effect<boolean> =>
  Effect.sync(() => fs.existsSync(dir)).pipe(
    Effect.flatMap((exists) =>
      exists
        ? git(["rev-parse", "--verify", "HEAD"], dir, { GIT_DIR: dir }).pipe(
            Effect.as(true),
            Effect.catchTag("GitError", () => Effect.succeed(false)),
          )
        : Effect.succeed(false),
    ),
  );

export const DotfilesStoreLive: Layer.Layer<DotfilesStore, never, StoreConfig> = Layer.effect(
  DotfilesStore,
  Effect.gen(function* () {
    const config = yield* StoreConfig;

    const repoDir = (userId: string) =>
      Effect.gen(function* () {
        if (!isSafeUserId(userId)) {
          return yield* Effect.fail(
            new DotfilesStoreError({ message: `invalid user id: ${userId}` }),
          );
        }
        return path.join(config.root, "_dotfiles", `${userId}.git`);
      });

    const summarize = (dir: string): Effect.Effect<DotfilesSnapshotSummary, DotfilesStoreError> =>
      Effect.gen(function* () {
        const env = { GIT_DIR: dir };
        const head = yield* git(["log", "-1", "--format=%H%n%cI%n%s"], dir, env).pipe(
          Effect.mapError(toStoreError("reading snapshot head")),
        );
        const [sha = "", committedAt = "", subject = ""] = head.split("\n");
        const listing = yield* git(["ls-tree", "-r", "-l", "HEAD"], dir, env).pipe(
          Effect.mapError(toStoreError("listing snapshot files")),
        );
        const files = listing
          .split("\n")
          .filter((line) => line !== "")
          .flatMap((line) => {
            // <mode> blob <sha> <size>\t<path>
            const [meta, filePath] = line.split("\t");
            const size = Number(meta?.trim().split(/\s+/).at(-1));
            return filePath === undefined || Number.isNaN(size)
              ? []
              : [{ path: filePath, bytes: size }];
          });
        return {
          sha,
          source: subject.replace(/^sync from /, ""),
          committedAt: new Date(committedAt),
          files,
        };
      });

    const snapshot = Effect.fn("DotfilesStore.snapshot")(function* (
      userId: string,
      files: ReadonlyArray<DotfilesSnapshotFile>,
      options: { readonly source: string; readonly merge: boolean },
    ) {
      const dir = yield* repoDir(userId);
      const unsafe = files.find((file) => !isSafeHomePath(file.path));
      if (unsafe !== undefined) {
        return yield* Effect.fail(
          new DotfilesStoreError({
            message: `snapshot contains a non-home-relative path: ${unsafe.path}`,
          }),
        );
      }
      const decoded = files.map((file) => ({
        ...file,
        contents: Buffer.from(file.contentsBase64, "base64"),
      }));
      const oversized = decoded.find((file) => file.contents.byteLength > MAX_FILE_BYTES);
      if (oversized !== undefined) {
        return yield* Effect.fail(
          new DotfilesStoreError({
            message: `${oversized.path} is over 1MB — dotfiles are text; large blobs do not belong in the snapshot`,
          }),
        );
      }
      const total = decoded.reduce((sum, file) => sum + file.contents.byteLength, 0);
      if (total > MAX_SNAPSHOT_BYTES) {
        return yield* Effect.fail(
          new DotfilesStoreError({
            message: "snapshot exceeds the 4MB cap — trim the selection",
          }),
        );
      }
      // A merge keeps every current file it does not replace, so the cap is on the result:
      // otherwise repeated merges grow a snapshot past what one launch can carry.
      if (options.merge && (yield* hasSnapshot(dir))) {
        const replaced = new Set(decoded.map((file) => file.path));
        const kept = (yield* summarize(dir)).files
          .filter((file) => !replaced.has(file.path))
          .reduce((sum, file) => sum + file.bytes, 0);
        if (total + kept > MAX_SNAPSHOT_BYTES) {
          return yield* Effect.fail(
            new DotfilesStoreError({
              message:
                "snapshot exceeds the 4MB cap with the files it already holds — trim the selection",
            }),
          );
        }
      }

      yield* Effect.sync(() => fs.mkdirSync(path.dirname(dir), { recursive: true }));
      if (!fs.existsSync(dir)) {
        yield* git(["init", "--bare", dir], config.root).pipe(
          Effect.mapError(toStoreError("initializing the dotfiles store")),
        );
      }

      const workTree = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotfiles-store-"));
      const cleanup = Effect.sync(() => {
        fs.rmSync(workTree, { recursive: true, force: true });
      });
      return yield* Effect.gen(function* () {
        const env = { GIT_DIR: dir, GIT_WORK_TREE: workTree };
        const existing = yield* hasSnapshot(dir);
        if (options.merge && existing) {
          yield* git(["checkout", "HEAD", "--", "."], workTree, env).pipe(
            Effect.mapError(toStoreError("materializing the current snapshot")),
          );
        }
        for (const file of decoded) {
          const target = path.join(workTree, file.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.contents);
          if (file.mode !== undefined && /^[0-7]{3,4}$/.test(file.mode)) {
            fs.chmodSync(target, Number.parseInt(file.mode, 8));
          }
        }
        yield* git(["add", "-A"], workTree, env).pipe(
          Effect.mapError(toStoreError("staging the snapshot")),
        );
        const status = yield* git(["status", "--porcelain"], workTree, env).pipe(
          Effect.mapError(toStoreError("checking the snapshot")),
        );
        if (existing && status === "") {
          return yield* summarize(dir);
        }
        yield* git(["commit", "-m", `sync from ${options.source}`], workTree, env).pipe(
          Effect.mapError(toStoreError("committing the snapshot")),
        );
        return yield* summarize(dir);
      }).pipe(Effect.ensuring(cleanup));
    });

    const current = Effect.fn("DotfilesStore.current")(function* (userId: string) {
      const dir = yield* repoDir(userId);
      const existing = yield* hasSnapshot(dir);
      if (!existing) return null;
      return yield* summarize(dir);
    });

    const archive = Effect.fn("DotfilesStore.archive")(function* (userId: string) {
      const dir = yield* repoDir(userId);
      const existing = yield* hasSnapshot(dir);
      if (!existing) return null;
      const summary = yield* summarize(dir);
      const packed = yield* gitBuffer(["archive", "--format=tar.gz", "HEAD"], { GIT_DIR: dir });
      return { sha: summary.sha, data: packed.toString("base64") };
    });

    const clear = Effect.fn("DotfilesStore.clear")(function* (userId: string) {
      const dir = yield* repoDir(userId);
      yield* Effect.sync(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
    });

    return { snapshot, current, archive, clear };
  }),
);
