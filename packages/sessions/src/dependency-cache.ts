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
 * timeout, never a total one, in every pnpm checked (7.33.7, 8.15.9, 9.15.9, 10.32.1, 11.28.2,
 * 12.9.0): a 1 MiB tarball trickling at 31 KiB/s with a 5 s timeout downloaded in 32 s on each.
 * pnpm 10 and earlier set it as the socket inactivity timeout (`@pnpm/network.agent` →
 * agentkeepalive) and clear it once the response headers arrive, so a stall in the middle of a
 * body waits for the registry whatever this says; pnpm 11 and 12 time that out too.
 *
 * A registry or proxy that is slower than this to answer on every attempt fails the shortened
 * install; `runInstallCommand` then runs the command once more with pnpm's defaults.
 */
export const INSTALL_FETCH_TIMEOUT_MS = 15_000;
/** The first retry's wait (pnpm's default 10 s); the factor stays pnpm's 10. */
export const INSTALL_FETCH_RETRY_MINTIMEOUT_MS = 2_000;
/** The longest wait between retries (pnpm's default 60 s). */
export const INSTALL_FETCH_RETRY_MAXTIMEOUT_MS = 10_000;

/**
 * A plain `pnpm install` (or `pnpm i`) with simple arguments, on one line: what `detectInstall`
 * names, or a saved command of the same shape. Anything else (another package manager, `&&`, a
 * pipe, quotes, a variable, a second line) runs exactly as written.
 */
const PNPM_INSTALL = /^pnpm[ \t]+(?:install|i)(?:[ \t]+[\w@./=:+,-]+)*$/;

/**
 * The files where a project, the person running the install or the image may set a fetch setting:
 * the install's working directory, the user config (`$NPM_CONFIG_USERCONFIG`, else `~/.npmrc`),
 * pnpm's own config, and the global npmrc (`$NPM_CONFIG_GLOBALCONFIG`, the npm prefix's
 * `etc/npmrc`, node's prefix's, `/usr/local/etc/npmrc` and `/etc/npmrc`). A key set in any of them,
 * or in the environment already, wins: Mend sets only what nobody set. A path that does not exist
 * is skipped (`grep -s`); `$mend_node_prefix` is set by the script's first line.
 */
const FETCH_SETTING_FILES = [
  ".npmrc",
  "pnpm-workspace.yaml",
  '"${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-$HOME/.npmrc}}"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm/rc"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm/config.yaml"',
  '"${NPM_CONFIG_GLOBALCONFIG:-${npm_config_globalconfig:-/etc/npmrc}}"',
  '"${NPM_CONFIG_PREFIX:-${npm_config_prefix:-/usr/local}}/etc/npmrc"',
  '"$mend_node_prefix/etc/npmrc"',
  "/usr/local/etc/npmrc",
  "/etc/npmrc",
].join(" ");

/**
 * `["']?` inside a single-quoted grep pattern: npm and pnpm's ini parser take a quoted key too
 * (`"registry"=…`). The single quote closes the pattern, is given in double quotes, and reopens it.
 */
const OPTIONAL_QUOTE = `["'"'"']?`;

/** One setting: its `.npmrc` and `pnpm-workspace.yaml` spellings and its environment names. */
const fetchSettingUnset = (kebab: string, camel: string): string => {
  const snake = kebab.replaceAll("-", "_");
  const env = [`npm_config_${snake}`, `pnpm_config_${snake}`]
    .flatMap((name) => [name, name.toUpperCase()])
    .map((name) => `\${${name}-}`)
    .join("");
  // npm and pnpm's ini parser take a quoted key too (`"fetch-timeout"=…`).
  return `[ -z "${env}" ] && ! grep -Eqs '^[[:space:]]*${OPTIONAL_QUOTE}(${kebab}|${camel})${OPTIONAL_QUOTE}[[:space:]]*[=:]' ${FETCH_SETTING_FILES}`;
};

// ─── The npm mirror ─────────────────────────────────────────────────────────

/**
 * The server's npm mirror (`MEND_NPM_MIRROR_URL`, `mend server setup`'s npm-mirror): a read-through
 * cache of registry.npmjs.org on the Compose network. Read as an http(s) origin with its trailing
 * slash, the form `--registry` takes; null for anything else, and then no install uses a mirror.
 */
export const parseNpmMirrorUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^[a-z0-9.-]+$/.test(url.hostname)
  ) {
    return null;
  }
  return `${url.origin}/`;
};

/** An `npm ci` or `npm install` with simple arguments, on one line; anything else runs as written. */
const NPM_INSTALL = /^npm[ \t]+(?:ci|install|i)(?:[ \t]+[\w@./=:+,-]+)*$/;

/** What the script says, on stderr, about the mirror: the engine reads it back from the output. */
export const NPM_MIRROR_USED = "mend: npm mirror · used";
export const NPM_MIRROR_NOT_USED = "mend: npm mirror · not used";

/** The public registry, exactly as npm and pnpm print it when nothing else is set. */
const NPMJS_REGISTRY = "https://registry.npmjs.org/";

/**
 * A login for the public registry: `//registry.npmjs.org/:…` or an unscoped `_auth`, `_authToken`,
 * `_password`, `username` or `always-auth`. Packages behind such a login are private, and the mirror
 * never sends a credential, so the install stays on the registry itself. Matched in what
 * `npm config list` prints (every source npm reads, quoted keys normalised, values `(protected)`),
 * and, as a second denial, in the config files themselves, a quoted key included.
 */
const NPMJS_LOGIN_KEY =
  "(//registry\\.npmjs\\.org/:|_auth|_password|username[[:space:]]*=|always-auth)";
const NPMJS_LOGIN = [
  `printf '%s\\n' "$mend_npm_config" | grep -Eq '^"?${NPMJS_LOGIN_KEY}'`,
  `grep -Eqs '^[[:space:]]*${OPTIONAL_QUOTE}${NPMJS_LOGIN_KEY}' ${FETCH_SETTING_FILES}`,
  '[ -n "${npm_config__auth-}${npm_config__authToken-}${NPM_CONFIG__AUTH-}${NPM_CONFIG__AUTHTOKEN-}" ]',
].join(" || ");

/**
 * Ask the package manager, as the person who runs the install, in the project, what it will use:
 * `npm config list` (every source npm reads: the environment, the project, the person, the global
 * and builtin files, quoted keys included; secrets printed as `(protected)`), and `<pm> config get
 * registry`, the default registry the install itself resolves. Each is bounded at 15 s; a missing
 * `timeout`, an error or a timeout leaves `mend_config_read` empty, and then there is no mirror.
 * The update check is off for both, so neither asks the registry anything. `pnpm config get` loads
 * a top-level `.pnpmfile.cjs`: the code the install itself runs next, as the same person. Measured
 * on node 24: npm about 50 ms, pnpm 10 about 180 ms.
 */
const readPackageManagerConfig = (manager: "npm" | "pnpm"): string =>
  [
    "mend_config_read=; mend_npm_config=; mend_pm_registry=",
    "if command -v timeout >/dev/null 2>&1 &&",
    "  mend_npm_config=$(npm_config_update_notifier=false timeout 15 npm config list 2>/dev/null) &&",
    `  mend_pm_registry=$(npm_config_update_notifier=false timeout 15 ${manager} config get registry 2>/dev/null); then mend_config_read=1; fi`,
  ].join("\n");

/**
 * A `registry` or `registries` key, in block or flow form, in the `pnpm-workspace.yaml` of the
 * project or of any directory above it: pnpm reads its workspace's, wherever the root is, and
 * pnpm 10's `config get registry` does not report it. Leaves `mend_workspace_registry` non-empty
 * when one is found.
 */
const PNPM_WORKSPACE_REGISTRY = [
  "mend_workspace_registry=; mend_dir=$PWD",
  "while :; do",
  `  if grep -Eqs '(^|[[:space:]{,])${OPTIONAL_QUOTE}registr(y|ies)${OPTIONAL_QUOTE}[[:space:]]*:' "$mend_dir/pnpm-workspace.yaml"; then mend_workspace_registry=1; break; fi`,
  '  if [ "$mend_dir" = / ]; then break; fi',
  '  mend_dir=$(dirname "$mend_dir")',
  "done",
].join("\n");

/** One line on stderr: what the install script decided about the mirror. */
const said = (words: string) => `echo '${words}' >&2`;

/**
 * The lines that point an install at the mirror, as `$mend_registry`: only when nobody set a
 * registry (the command, the project, the person, the image, the environment), nobody set a login
 * for the public registry, and the mirror answers its ping within three seconds. Scoped registries
 * (`@scope:registry=…`) are untouched: their packages never go to the default registry. Every
 * outcome is said on one stderr line.
 */
/**
 * The flags a command may pass and still be offered the mirror: ones that change neither where the
 * package manager reads its configuration nor where it fetches from. Any other flag
 * (`--userconfig`, `--globalconfig`, `--prefix`, `--dir`, `--config.*`, `--registry`, …) may point
 * at a registry or a login the script cannot see, so the command runs as written. Bare words are
 * package names or a flag's value.
 */
const MIRROR_SAFE_FLAG =
  /^(?:--frozen-lockfile|--no-frozen-lockfile|--prefer-frozen-lockfile|--prefer-offline|--ignore-scripts|--prod|--production|-P|--dev|-D|--no-optional|--recursive|-r|--strict-peer-dependencies|--no-strict-peer-dependencies|--shamefully-hoist|--fix-lockfile|--silent|-s|--no-audit|--no-fund|--legacy-peer-deps|--foreground-scripts|--(?:reporter|loglevel|fetch-timeout|fetch-retries|fetch-retry-mintimeout|fetch-retry-maxtimeout|fetch-retry-factor|network-concurrency|child-concurrency|omit|include|filter)=[\w@./:+,*-]+)$/;

/** The first argument after the subcommand that could change the configuration read, or null. */
const unreadFlag = (command: string): string | null =>
  command
    .split(/[ \t]+/)
    .slice(2)
    .find((arg) => arg.startsWith("-") && !MIRROR_SAFE_FLAG.test(arg)) ?? null;

const npmMirrorLines = (command: string, mirror: string): ReadonlyArray<string> => {
  if (/--registry\b|--config\.registry\b/.test(command))
    return ["mend_registry=", said(`${NPM_MIRROR_NOT_USED} · the command names a registry`)];
  const flag = unreadFlag(command);
  if (flag !== null)
    return [
      "mend_registry=",
      said(`${NPM_MIRROR_NOT_USED} · the command passes ${flag}, which may choose its own config`),
    ];
  const ping = `node -e 'fetch(process.argv[1] + "-/ping", { signal: AbortSignal.timeout(3000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' '${mirror}' >/dev/null 2>&1`;
  const manager = command.startsWith("pnpm") ? "pnpm" : "npm";
  // The package manager's answer decides; the file and environment checks can only add a "no"
  // (pnpm 10's `config get` does not read pnpm-workspace.yaml, for one).
  const workspaceRegistry = manager === "pnpm" ? ' || [ -n "$mend_workspace_registry" ]' : "";
  return [
    "mend_registry=",
    readPackageManagerConfig(manager),
    ...(manager === "pnpm" ? [PNPM_WORKSPACE_REGISTRY] : []),
    `if [ -z "$mend_config_read" ]; then ${said(`${NPM_MIRROR_NOT_USED} · the configuration ${manager} reports could not be read`)}`,
    `elif [ "$mend_pm_registry" != "${NPMJS_REGISTRY}" ] || ! { ${fetchSettingUnset("registry", "registries")}; }${workspaceRegistry}; then ${said(`${NPM_MIRROR_NOT_USED} · a registry is set`)}`,
    `elif ${NPMJS_LOGIN}; then ${said(`${NPM_MIRROR_NOT_USED} · a login for registry.npmjs.org is set`)}`,
    `elif ${ping}; then mend_registry='--registry=${mirror}'; ${said(`${NPM_MIRROR_USED} · ${mirror}`)}`,
    `else ${said(`${NPM_MIRROR_NOT_USED} · ${mirror} did not answer`)}; fi`,
  ];
};

/** `if <condition>; then <then>; fi`, or nothing for a setting left to the command. */
const shellIf = (condition: string | null, then: string): ReadonlyArray<string> =>
  condition === null ? [] : [`if ${condition}; then ${then}; fi`];

/**
 * The script `sh -lc` runs for an install command. A plain pnpm install gets shorter fetch
 * timeouts unless the command, the project, the person, the image or the environment set them;
 * every other command is returned unchanged.
 *
 * The timeout goes on the command line, because pnpm 10 reads `npm_config_fetch_timeout` from the
 * environment as a string and then turns the timeout off altogether (`@pnpm/network.agent` keeps it
 * only when it is a number), and pnpm 11 and 12 ignore `npm_config_*`. A command-line flag beats a
 * project's `.npmrc`, so the script checks for the setting first. pnpm 10's update check is turned
 * off: on a fresh executor it has no record of its last check, so `pnpm install` resolves `pnpm`
 * from the registry first, and that request makes the HTTPS agent every later request reuses with
 * the default 60 s timeout, whatever `--fetch-timeout` says (`@pnpm/network.agent` caches agents by
 * TLS settings, not by timeout). The retry waits go in the environment under both prefixes:
 * pnpm 10 and earlier read `npm_config_*`, pnpm 11 and later `pnpm_config_*`, and pnpm 12 has no
 * command-line flag for them (an unknown flag fails the install). npm is left alone: npm does not
 * retry a body that times out, so a shorter timeout would turn a stall npm survives today into a
 * failed install.
 *
 * With the server's npm mirror (`npmMirror`, from `MEND_NPM_MIRROR_URL`), a plain pnpm install,
 * `npm ci` or `npm install` also gets `--registry=<mirror>`, by the rules of `npmMirrorLines`: only
 * where nobody set a registry or a login for the public registry, and only once the mirror answers.
 * Yarn, bun and every other command run as written.
 */
export const installScript = (command: string, npmMirror?: string | null): string => {
  const trimmed = command.trim();
  const mirror = npmMirror ?? null;
  if (mirror !== null && NPM_INSTALL.test(trimmed)) {
    // npm keeps its own timeouts (see above); only the registry changes.
    return [
      "mend_node=$(command -v node 2>/dev/null); mend_node_prefix=${mend_node%/bin/node}",
      ...npmMirrorLines(trimmed, mirror),
      `${trimmed} $mend_registry`,
    ].join("\n");
  }
  if (!PNPM_INSTALL.test(trimmed)) return command;
  // A setting the command itself passes (`--fetch-timeout=…`, `--config.fetch-timeout=…`) is left
  // to it.
  const unset = (kebab: string, camel: string) =>
    trimmed.includes(kebab) ? null : fetchSettingUnset(kebab, camel);
  const retryWait = (kebab: string, camel: string, ms: number) => {
    const snake = kebab.replaceAll("-", "_");
    return shellIf(
      unset(kebab, camel),
      `export npm_config_${snake}=${ms} pnpm_config_${snake}=${ms}`,
    );
  };
  return [
    "mend_fetch_timeout=; mend_node=$(command -v node 2>/dev/null); mend_node_prefix=${mend_node%/bin/node}",
    ...shellIf(
      unset("fetch-timeout", "fetchTimeout"),
      `mend_fetch_timeout=--fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}`,
    ),
    ...shellIf(
      unset("update-notifier", "updateNotifier"),
      "export npm_config_update_notifier=false",
    ),
    ...retryWait(
      "fetch-retry-mintimeout",
      "fetchRetryMintimeout",
      INSTALL_FETCH_RETRY_MINTIMEOUT_MS,
    ),
    ...retryWait(
      "fetch-retry-maxtimeout",
      "fetchRetryMaxtimeout",
      INSTALL_FETCH_RETRY_MAXTIMEOUT_MS,
    ),
    ...(mirror === null ? [] : npmMirrorLines(trimmed, mirror)),
    mirror === null
      ? `${trimmed} $mend_fetch_timeout`
      : `${trimmed} $mend_fetch_timeout $mend_registry`,
  ].join("\n");
};

/**
 * A line that reports a download pnpm is about to try again: `Will retry in …` (pnpm 7 to 12; pnpm
 * 12 prints it on its own line after the error), or a warning that names a timeout or a reset
 * connection. Not counted: the final error once retries ran out (`ERR_SOCKET_TIMEOUT request to …
 * failed`, `npm error code EIDLETIMEOUT`), an HTTP refusal (`ERR_PNPM_FETCH_404`), or a script that
 * happens to print a socket error. A line counts once, whatever it matches.
 */
const RETRY_LINE = /Will retry in/;
const STALL_WARNING =
  /\bwarn\b.*(?:ERR_SOCKET_TIMEOUT|ERR_PNPM_FETCH_TIMEOUT|ECONNRESET|ETIMEDOUT|EIDLETIMEOUT)/i;

/** How many fetch retries an install's output reports, from its stdout and stderr. */
export const countFetchRetries = (...outputs: ReadonlyArray<string>): number =>
  outputs
    .flatMap((output) => output.split("\n"))
    .filter((line) => RETRY_LINE.test(line) || STALL_WARNING.test(line)).length;

/**
 * The engine's log line once the install has run, e.g.
 * `session engine: dependency install · completed · exit 0 · fetch retries 2`. The benchmark
 * reads the last field to set stalled samples apart; it is always there, `fetch retries 0` when
 * the output reported none. After a run with pnpm's defaults it says that run's exit and the
 * retries of both runs.
 */
export const dependencyInstallDoneLine = (exitCode: number, fetchRetries: number): string =>
  `session engine: dependency install · ${exitCode === 0 ? "completed" : "exited"} · exit ${exitCode} · fetch retries ${fetchRetries}`;

/** Logged, on its own line, before the command runs again with pnpm's defaults. */
export const DEPENDENCY_INSTALL_RETRIED_LINE =
  "session engine: dependency install · retried with defaults";

/** Logged, on its own line, before a run through the npm mirror that failed on it runs again. */
export const DEPENDENCY_INSTALL_RETRIED_WITHOUT_MIRROR_LINE =
  "session engine: dependency install · retried without the npm mirror";

/**
 * Whether the install went through the npm mirror: `used`, `not used` (the script said why on its
 * stderr), `fell back` (it failed on the mirror and ran again without it), or `off` (no mirror on
 * this server, or a command the mirror is not offered to).
 */
export type NpmMirrorUse = "used" | "not used" | "fell back" | "off";

const npmMirrorUseOf = (stderr: string): NpmMirrorUse =>
  stderr.includes(NPM_MIRROR_USED)
    ? "used"
    : stderr.includes(NPM_MIRROR_NOT_USED)
      ? "not used"
      : "off";

/** What an install exec answers: the exit code and the output, which is only counted. */
export interface InstallExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** An install's outcome: its last run's exit and stderr, and the fetch retries of every run. */
export interface InstallOutcome {
  readonly exitCode: number;
  readonly fetchRetries: number;
  readonly retriedWithDefaults: boolean;
  readonly npmMirror: NpmMirrorUse;
  /** The last run's stderr, for the failure line; never logged whole. */
  readonly stderr: string;
}

/**
 * Run an install command through `exec` (`sh -lc <script>` in the workspace), shortened by
 * `installScript`. When that run exits non-zero and its output reported fetch retries, the
 * shortened timeout may be what failed it (a registry or proxy that takes longer than 15 s to
 * answer, every time), so the command runs once more exactly as written, with pnpm's defaults,
 * and the outcome is that run's. A command `installScript` leaves alone runs once.
 *
 * With the server's npm mirror (`npmMirror`), any run that went through the mirror and failed runs
 * once more exactly as written, so it reaches the registry itself: a mirror that is down, that broke
 * part-way, or that served bytes failing the lockfile's integrity (npm names the URL and the
 * EINTEGRITY on different lines) never fails an install the registry would serve. A project's own
 * failure then fails twice; the outcome is the second run's. Either way there is one rerun at most:
 * the shortened-timeout retry above and this one are the same rerun.
 */
export const runInstallCommand = <E, R>(
  command: string,
  exec: (script: string) => Effect.Effect<InstallExecResult, E, R>,
  npmMirror?: string | null,
): Effect.Effect<InstallOutcome, E, R> =>
  Effect.gen(function* () {
    const mirror = npmMirror ?? null;
    const script = installScript(command, mirror);
    const first = yield* exec(script);
    const firstRetries = countFetchRetries(first.stdout, first.stderr);
    const mirrorUse = npmMirrorUseOf(first.stderr);
    const mirrorFailed = mirror !== null && mirrorUse === "used" && first.exitCode !== 0;
    if (script === command || first.exitCode === 0 || (firstRetries === 0 && !mirrorFailed)) {
      return {
        exitCode: first.exitCode,
        fetchRetries: firstRetries,
        retriedWithDefaults: false,
        npmMirror: mirrorUse,
        stderr: first.stderr,
      };
    }
    yield* Effect.logInfo(
      mirrorFailed
        ? DEPENDENCY_INSTALL_RETRIED_WITHOUT_MIRROR_LINE
        : DEPENDENCY_INSTALL_RETRIED_LINE,
    ).pipe(Effect.annotateLogs({ exit: first.exitCode, fetchRetries: firstRetries }));
    const second = yield* exec(command);
    return {
      exitCode: second.exitCode,
      fetchRetries: firstRetries + countFetchRetries(second.stdout, second.stderr),
      retriedWithDefaults: true,
      npmMirror: mirrorUse === "used" ? "fell back" : mirrorUse,
      stderr: second.stderr,
    };
  });

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
