import type { ProjectId } from "@mend/domain";
import {
  BlobStore,
  type BlobNotFoundError,
  type BlobStoreError,
  type CaptureFormatError,
  type CaptureManifest,
  type DirObject,
  decodeDirObject,
  encodeDirObject,
  sha256Hex,
} from "@mend/store";
import { Effect, Schema } from "effect";

/**
 * Dependency trees under the capture store (ADR-0002 amended 2026-09-13, decisions 2 and 9).
 *
 * The bulk class — `node_modules`, `target`, whatever the install command produces — is work
 * product: every session's executor captures its own, keyed by `platform` (`<os>-<arch>-<libc>`,
 * sealantd `engine.rs` `default_platform`), because a tree built on one platform does not run on
 * another. What is shared across sessions is the per-project **cache**,
 * `projects/<project>/cache/<platform>/`, and it has exactly one writer: the Mend-controlled
 * install job (`packages/jobs/src/dependency-install.ts`), which runs the project's install
 * command in an executor Mend launched and promotes that session's final bulk section here by
 * server-side copy. A session capture is never promoted — nothing in the register route knows
 * this prefix — so one agent's `node_modules` can never become another session's supply chain.
 *
 * Readers: a standby executor's plan (`hot-pool.ts` "Capture-mode standby") and a cold launch
 * whose head carries no bulk for the executor's platform; both fall back to running the install
 * command in the workspace when the cache has nothing for that platform.
 *
 * The cache's objects are named by its record (`root.json`), not by `packs` rows: a pack row's
 * id is its digest and the install session's own row already holds that digest under its epoch
 * key. Retention sweeps epoch prefixes by chain reachability and never this prefix; a cache is
 * replaced whole by the next promotion.
 */

/** Where a project's shared cache for one platform lives; only the install job writes under it. */
export const dependencyCachePrefix = (projectId: ProjectId, platform: string): string =>
  `projects/${projectId}/cache/${encodeURIComponent(platform)}/`;

/** The cache's descriptor: the bulk section a plan can splice in, plus where it came from. */
export const DependencyCacheRecord = Schema.Struct({
  root: Schema.String,
  packs: Schema.Array(Schema.String),
  platform: Schema.String,
  /** The capture whose bulk section was promoted — the install session's final capture. */
  capture_id: Schema.String,
  promoted_at: Schema.String,
});
export type DependencyCacheRecord = typeof DependencyCacheRecord.Type;

const decodeRecord = Schema.decodeUnknownEffect(DependencyCacheRecord);

const recordKey = (prefix: string) => `${prefix}root.json`;
const digestOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/** The cache for a platform, or null when no install job has filled it. */
export const readDependencyCache = (
  projectId: ProjectId,
  platform: string,
): Effect.Effect<DependencyCacheRecord | null, BlobStoreError, BlobStore> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const bytes = yield* blobs
      .get(recordKey(dependencyCachePrefix(projectId, platform)))
      .pipe(Effect.catchTag("BlobNotFoundError", () => Effect.succeed(null)));
    if (bytes === null) return null;
    return yield* decodeRecord(JSON.parse(Buffer.from(bytes).toString("utf8"))).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  });

export type PromoteError = BlobNotFoundError | BlobStoreError | CaptureFormatError;

/**
 * Promote a capture's bulk section into the project's cache for its platform. Packs are copied
 * server-side under the cache prefix by their digest; dir objects name their children by full
 * key, so every tree is re-encoded bottom-up with the moved child keys and lands under its new
 * digest. The record is written last, so a reader never sees a cache whose objects are still
 * arriving.
 */
export const promoteBulkToCache = (
  projectId: ProjectId,
  captureId: string,
  manifest: CaptureManifest,
): Effect.Effect<DependencyCacheRecord | null, PromoteError, BlobStore> =>
  Effect.gen(function* () {
    const bulk = manifest.sections.bulk;
    if (bulk === "pending" || bulk.root === "") return null;
    const blobs = yield* BlobStore;
    const prefix = dependencyCachePrefix(projectId, bulk.platform);
    const packs: Array<string> = [];
    for (const from of bulk.packs) {
      const to = `${prefix}packs/${digestOf(from)}`;
      const present = yield* blobs.head(to);
      if (present === null) yield* blobs.copy(from, to);
      packs.push(to);
    }
    const rekey = (key: string): Effect.Effect<string, PromoteError> =>
      Effect.gen(function* () {
        const entries = yield* blobs.get(key).pipe(Effect.flatMap((b) => decodeDirObject(key, b)));
        const moved: Array<DirObject[number]> = [];
        for (const entry of entries) {
          moved.push(
            entry.kind === "dir" && entry.child !== undefined
              ? { ...entry, child: yield* rekey(entry.child) }
              : entry,
          );
        }
        const bytes = encodeDirObject(moved);
        const to = `${prefix}trees/${sha256Hex(bytes)}`;
        yield* blobs.put(to, bytes, { ifAbsent: true });
        return to;
      });
    const root = yield* rekey(bulk.root);
    const record: DependencyCacheRecord = {
      root,
      packs,
      platform: bulk.platform,
      capture_id: captureId,
      promoted_at: new Date().toISOString(),
    };
    yield* blobs.put(
      recordKey(prefix),
      new Uint8Array(Buffer.from(JSON.stringify(record), "utf8")),
    );
    return record;
  });

// ─── The install command ────────────────────────────────────────────────────

/**
 * The default install command for a project, from the lockfiles at the root of its base tree.
 * Frozen/immutable variants: an install that would rewrite the lockfile is a change, and a
 * cache must be reproducible from the tree it was built for. Null when nothing is recognised —
 * the project setting (`projects.install_command`) is the explicit answer, and an agent can
 * always install by hand.
 */
export const detectInstallCommand = (topLevelNames: ReadonlyArray<string>): string | null => {
  const names = new Set(topLevelNames);
  if (names.has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun install --frozen-lockfile";
  if (names.has("yarn.lock")) return "yarn install --immutable";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm ci";
  if (names.has("package.json")) return "npm install";
  if (names.has("Cargo.lock")) return "cargo fetch --locked";
  if (names.has("Cargo.toml")) return "cargo fetch";
  if (names.has("uv.lock")) return "uv sync --frozen";
  if (names.has("poetry.lock")) return "poetry install";
  if (names.has("go.sum") || names.has("go.mod")) return "go mod download";
  return null;
};

/**
 * What an executor answers to learn its platform key, in sealantd's form (`engine.rs`
 * `default_platform`: `<os>-<arch>-<libc>` from Rust's `consts::OS` / `consts::ARCH` and
 * `musl` or `gnu`). One `sh -c`, three lines; `platformKeyOf` reads them and normalises
 * `uname`'s spellings to Rust's (`arm64` → `aarch64`, `Linux` → `linux`).
 */
export const PLATFORM_PROBE_SCRIPT = "uname -s; uname -m; (ldd --version 2>&1 || true) | head -n 1";

export const platformKeyOf = (probeOutput: string): string | null => {
  const [os, arch, ldd] = probeOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (os === undefined || arch === undefined) return null;
  const rustOs = os.toLowerCase() === "darwin" ? "macos" : os.toLowerCase();
  const rustArch =
    arch.toLowerCase() === "arm64"
      ? "aarch64"
      : arch.toLowerCase() === "amd64"
        ? "x86_64"
        : arch.toLowerCase();
  const libc = rustOs !== "linux" ? "system" : /musl/i.test(ldd ?? "") ? "musl" : "gnu";
  return `${rustOs}-${rustArch}-${libc}`;
};
