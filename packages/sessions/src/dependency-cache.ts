import type { ProjectId } from "@mend/domain";
import {
  BlobStore,
  type BlobNotFoundError,
  type BlobStoreError,
  type BulkSectionReady,
  type CaptureFormatError,
  type CaptureManifest,
  type DirObject,
  decodeDirObject,
  dirPacksOf,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  SectionFormat,
  sectionFormatOf,
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
 * Reader: only a standby executor's plan (`hot-pool.ts` "Capture-mode standby", through
 * `prepareStandby`), which falls back to running the install command in the workspace when the
 * cache has nothing for that platform. A record is served only for the platform it names.
 *
 * A cold launch never reads the cache: its capture 0 is always `bulk: "pending"`, and
 * `installDependenciesIfNeeded` runs the install command when the head carries no tree for the
 * executor's platform. That is on purpose: on the box, restoring a 2.4 GB tree from the cache took
 * about 20 s, against about 14 s for `pnpm install`.
 *
 * A bulk section in either section format promotes (sealantd PR #99): format 1 names its dir
 * objects by key, so they are re-keyed under the cache prefix; format 2 names them by digest
 * inside its dir packs, so the dir packs are copied like the content packs and the root is kept.
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
  /** Format 1: the root dir object's key under the cache prefix. Format 2: its digest. */
  root: Schema.String,
  packs: Schema.Array(Schema.String),
  platform: Schema.String,
  /** The section format promoted; absent = 1 (every record before dir packs). */
  format: Schema.optionalKey(SectionFormat),
  /** Format 2: the dir packs under the cache prefix. */
  dir_packs: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The capture whose bulk section was promoted — the install session's final capture. */
  capture_id: Schema.String,
  promoted_at: Schema.String,
});
export type DependencyCacheRecord = typeof DependencyCacheRecord.Type;

const decodeRecord = Schema.decodeUnknownEffect(DependencyCacheRecord);

const recordKey = (prefix: string) => `${prefix}root.json`;
const digestOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/** The bulk section a plan splices in from a cache record, in the record's format. */
export const bulkSectionOfCache = (record: DependencyCacheRecord): BulkSectionReady =>
  record.format === FORMAT_DIR_PACKS
    ? {
        root: record.root,
        packs: record.packs,
        platform: record.platform,
        format: FORMAT_DIR_PACKS,
        dir_packs: record.dir_packs ?? [],
      }
    : { root: record.root, packs: record.packs, platform: record.platform };

/**
 * The cache for a platform, or null when no install job has filled it — or when the record
 * under that platform's prefix names another platform's tree, which is never served: a tree
 * built for one platform does not run on another, and a standby would restore it as its own.
 */
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
    const record = yield* Effect.try(() => JSON.parse(Buffer.from(bytes).toString("utf8"))).pipe(
      Effect.flatMap(decodeRecord),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (record === null || record.platform === platform) return record;
    yield* Effect.logWarning(
      "dependency cache: the record under this platform names another platform's tree · not served",
    ).pipe(Effect.annotateLogs({ projectId, platform, recorded: record.platform }));
    return null;
  });

export type PromoteError = BlobNotFoundError | BlobStoreError | CaptureFormatError;

/**
 * Promote a capture's bulk section into the project's cache for its platform — `bulk` only,
 * the tree this capture's own executor built, into the prefix of the platform it is stamped
 * with. A section `other_bulk` carries (sealantd PR #101) was built by another executor on
 * another platform and never promotes: each platform's cache is filled by an install job that
 * ran on it. Packs are copied
 * server-side under the cache prefix by their digest. In format 1 dir objects name their
 * children by full key, so every tree is re-encoded bottom-up with the moved child keys and
 * lands under its new digest; in format 2 they name them by digest, so the dir packs are copied
 * as they are, like the content packs. The record is written last, so a reader never sees a
 * cache whose objects are still arriving.
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
    const copyPacks = (keys: ReadonlyArray<string>) =>
      Effect.forEach(keys, (from) =>
        Effect.gen(function* () {
          const to = `${prefix}packs/${digestOf(from)}`;
          const present = yield* blobs.head(to);
          if (present === null) yield* blobs.copy(from, to);
          return to;
        }),
      );
    const packs = yield* copyPacks(bulk.packs);
    if (sectionFormatOf(bulk) === FORMAT_DIR_PACKS) {
      const dirPacks = yield* copyPacks(dirPacksOf(bulk));
      const record: DependencyCacheRecord = {
        root: bulk.root,
        packs,
        platform: bulk.platform,
        format: FORMAT_DIR_PACKS,
        dir_packs: dirPacks,
        capture_id: captureId,
        promoted_at: new Date().toISOString(),
      };
      yield* blobs.put(
        recordKey(prefix),
        new Uint8Array(Buffer.from(JSON.stringify(record), "utf8")),
      );
      return record;
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
 * The default install command for a project, from the lockfiles at the root of its base tree,
 * with the file that decided it (the setup page says "detected: <command> from <file>").
 * Frozen/immutable variants: an install that would rewrite the lockfile is a change, and a
 * cache must be reproducible from the tree it was built for. Null when nothing is recognised —
 * the project setting (`projects.install_command`) is the explicit answer, and an agent can
 * always install by hand.
 */
export const detectInstall = (
  topLevelNames: ReadonlyArray<string>,
): { readonly command: string; readonly from: string } | null => {
  const names = new Set(topLevelNames);
  const first = (...files: ReadonlyArray<string>) => files.find((file) => names.has(file));
  const pick = (command: string, ...files: ReadonlyArray<string>) => {
    const from = first(...files);
    return from === undefined ? null : { command, from };
  };
  return (
    pick("pnpm install --frozen-lockfile", "pnpm-lock.yaml") ??
    pick("bun install --frozen-lockfile", "bun.lock", "bun.lockb") ??
    pick("yarn install --immutable", "yarn.lock") ??
    pick("npm ci", "package-lock.json", "npm-shrinkwrap.json") ??
    pick("npm install", "package.json") ??
    pick("cargo fetch --locked", "Cargo.lock") ??
    pick("cargo fetch", "Cargo.toml") ??
    pick("uv sync --frozen", "uv.lock") ??
    pick("poetry install", "poetry.lock") ??
    pick("go mod download", "go.sum", "go.mod")
  );
};

/** `detectInstall`'s command alone: what a launch runs when the project saved none. */
export const detectInstallCommand = (topLevelNames: ReadonlyArray<string>): string | null =>
  detectInstall(topLevelNames)?.command ?? null;

// ─── Fetch timeouts for the install ─────────────────────────────────────────

/**
 * How long pnpm waits on a silent registry connection before it retries, for the install Mend
 * runs. pnpm's own default is 60 s, then a 10 s wait before the retry: on the box one stalled
 * tarball out of 2,003 held first output for about 70 s (2026-10-09 diagnosis). This is an idle
 * timeout in every pnpm checked, never a total one: pnpm 10 sets it as the socket inactivity
 * timeout (`@pnpm/network.agent` → agentkeepalive), pnpm 11 and 12 time out a body that stops
 * flowing, and in each a 1 MiB tarball trickling at 31 KiB/s with a 5 s timeout downloaded in 32 s.
 * A large tarball on a slow link therefore still completes; only silence trips it. pnpm 10 times
 * out only before the response headers: once headers arrive it clears the socket timeout, so a
 * stall in the middle of a body waits for the registry whatever this says.
 */
export const INSTALL_FETCH_TIMEOUT_MS = 15_000;
/** The first retry's wait (pnpm's default 10 s); the factor stays pnpm's 10. */
export const INSTALL_FETCH_RETRY_MINTIMEOUT_MS = 2_000;
/** The longest wait between retries (pnpm's default 60 s). */
export const INSTALL_FETCH_RETRY_MAXTIMEOUT_MS = 10_000;

/**
 * A plain `pnpm install` (or `pnpm i`) with simple arguments: what `detectInstall` names, or a
 * saved command of the same shape. Anything else (another package manager, `&&`, a pipe, quotes, a
 * variable) runs exactly as written.
 */
const PNPM_INSTALL = /^pnpm\s+(?:install|i)(?:\s+[\w@./=:+,-]+)*$/;

/**
 * The files where a project or the person running the install may set a fetch setting, in the
 * install's working directory and its user's home. A key set in any of them, or in the
 * environment already, wins: Mend sets only what nobody set.
 */
const FETCH_SETTING_FILES = [
  ".npmrc",
  "pnpm-workspace.yaml",
  '"$HOME/.npmrc"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm/rc"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm/config.yaml"',
].join(" ");

/** One setting: its `.npmrc` and `pnpm-workspace.yaml` spellings and its environment names. */
const fetchSettingUnset = (kebab: string, camel: string): string => {
  const snake = kebab.replaceAll("-", "_");
  const env = [`npm_config_${snake}`, `pnpm_config_${snake}`]
    .flatMap((name) => [name, name.toUpperCase()])
    .map((name) => `\${${name}-}`)
    .join("");
  return `[ -z "${env}" ] && ! grep -Eqs '^[[:space:]]*(${kebab}|${camel})[[:space:]]*[=:]' ${FETCH_SETTING_FILES}`;
};

/**
 * The script `sh -lc` runs for an install command. A plain pnpm install gets shorter fetch
 * timeouts unless the project, the person or the environment set them; every other command is
 * returned unchanged.
 *
 * The timeout goes on the command line, because pnpm 10 reads `npm_config_fetch_timeout` from the
 * environment as a string and then turns the timeout off altogether (`@pnpm/network.agent` keeps it
 * only when it is a number), and pnpm 11 and 12 ignore `npm_config_*`. A command-line flag beats a
 * project's `.npmrc`, so the script checks for the setting first. pnpm 10's update check is turned
 * off: on a fresh executor it has no record of its last check, so `pnpm install` resolves `pnpm`
 * from the registry first, and that request makes the HTTPS agent every later request reuses with
 * the default 60 s timeout, whatever `--fetch-timeout` says (`@pnpm/network.agent` caches agents by
 * TLS settings, not by timeout). The retry waits go in the environment under both prefixes:
 * pnpm 10 reads `npm_config_*`, pnpm 11 and later `pnpm_config_*`, and pnpm 12 has no
 * command-line flag for them (an unknown flag fails the install). npm is left alone: npm does not retry a body that times out, so a shorter timeout would
 * turn a stall npm survives today into a failed install.
 */
export const installScript = (command: string): string => {
  const trimmed = command.trim();
  if (!PNPM_INSTALL.test(trimmed)) return command;
  const retryWait = (kebab: string, camel: string, ms: number) => {
    const snake = kebab.replaceAll("-", "_");
    return `if ${fetchSettingUnset(kebab, camel)}; then export npm_config_${snake}=${ms} pnpm_config_${snake}=${ms}; fi`;
  };
  return [
    "mend_fetch_timeout=",
    `if ${fetchSettingUnset("fetch-timeout", "fetchTimeout")}; then mend_fetch_timeout=--fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}; fi`,
    `if ${fetchSettingUnset("update-notifier", "updateNotifier")}; then export npm_config_update_notifier=false; fi`,
    retryWait("fetch-retry-mintimeout", "fetchRetryMintimeout", INSTALL_FETCH_RETRY_MINTIMEOUT_MS),
    retryWait("fetch-retry-maxtimeout", "fetchRetryMaxtimeout", INSTALL_FETCH_RETRY_MAXTIMEOUT_MS),
    `${trimmed} $mend_fetch_timeout`,
  ].join("\n");
};

/**
 * A line a package manager prints when a download timed out, was reset, or will be retried:
 * pnpm 10 (`ERR_SOCKET_TIMEOUT … Will retry in 10 seconds`), pnpm 11 (`ERR_PNPM_FETCH_TIMEOUT`),
 * pnpm 12 (`Will retry in 10s`), npm (`EIDLETIMEOUT`, `ETIMEDOUT`, `ECONNRESET`), and yarn and
 * bun where they name the same socket errors. A line counts once, whatever it matches.
 */
const FETCH_RETRY_LINE =
  /ERR_SOCKET_TIMEOUT|ECONNRESET|ETIMEDOUT|EIDLETIMEOUT|Will retry in|ERR_PNPM_FETCH/;

/** How many fetch retries or stalls an install's output reports, from its stdout and stderr. */
export const countFetchRetries = (...outputs: ReadonlyArray<string>): number =>
  outputs.flatMap((output) => output.split("\n")).filter((line) => FETCH_RETRY_LINE.test(line))
    .length;

/**
 * The engine's log line once the install has run, e.g.
 * `session engine: dependency install · completed · exit 0 · fetch retries 2`. The benchmark
 * reads the last field to set stalled samples apart; it is always there, `fetch retries 0` when
 * the output reported none.
 */
export const dependencyInstallDoneLine = (exitCode: number, fetchRetries: number): string =>
  `session engine: dependency install · ${exitCode === 0 ? "completed" : "exited"} · exit ${exitCode} · fetch retries ${fetchRetries}`;

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
