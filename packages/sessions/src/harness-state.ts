/**
 * The harness session store (plan §5/§7): every settled session's RAW native
 * harness state — conversation transcripts, todo state, rollouts — harvested
 * out of the workspace into the central store, automatically. Nothing here is
 * user-facing: harvest fires at settle, restore + native resume fire at
 * relaunch, and the transcript adapters below are the harness-agnostic seam
 * (text is the interchange format — native state never crosses harnesses).
 *
 * Harness state belongs to one AGENT PROCESS, not to the session: a session
 * holds several agent processes over its life (relaunch, follow-up, resume)
 * and each leaves its own capture. Layout under
 * `~/.config/mend/store/<project>/sessions/<session-id>/processes/<process-id>/`:
 *   harness-state.tar.gz   the raw `$HOME` state dirs, exactly as the harness wrote them
 *   transcript.native      the primary conversation file (claude/codex: JSONL)
 *   manifest.json          { harness, providerSessionId, capturedAt }
 *
 * Sessions harvested before 2026-08-21 kept the same three files at the
 * session root; `locateHarnessState` reads those when no process capture
 * exists. Nothing migrates the tarballs.
 *
 * Since 2026-08-28 the captures are the settle-time snapshot of a LIVE source:
 * `sessions/<session-id>/harness-home/` is mounted read-write into every
 * workspace at `HARNESS_HOME_MOUNT_PATH`, and boot symlinks each harness's
 * `$HOME` state dirs onto it (`relocateHarnessHomeScript`). State survives any
 * workspace death; a relaunch with no committed capture harvests from the live
 * home server-side (`locateLiveTranscript`) instead of refusing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, Schema } from "effect";

import { PI_PROFILE_HOME_DIR, PI_PROFILE_KEPT_DIR, PI_PROFILE_SECRET_FILE } from "./pi-profile.ts";

export const HarnessStateManifest = Schema.Struct({
  harness: Schema.String,
  /** The harness's OWN session id — what a native resume addresses. */
  providerSessionId: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
export type HarnessStateManifest = typeof HarnessStateManifest.Type;

export class HarnessStateNotFoundError extends Schema.TaggedErrorClass<HarnessStateNotFoundError>()(
  "HarnessStateNotFoundError",
  {
    sessionId: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class HarnessStateIOError extends Schema.TaggedErrorClass<HarnessStateIOError>()(
  "HarnessStateIOError",
  {
    sessionId: Schema.String,
    operation: Schema.Literals([
      "read-manifest",
      "clear-manifest",
      "write-archive",
      "write-transcript",
      "write-canonical",
      "write-manifest",
      "stage-archive",
      "read-transcript",
      "stage-import",
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class HarnessStateInvalidError extends Schema.TaggedErrorClass<HarnessStateInvalidError>()(
  "HarnessStateInvalidError",
  {
    sessionId: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class HarnessStateCommandError extends Schema.TaggedErrorClass<HarnessStateCommandError>()(
  "HarnessStateCommandError",
  {
    sessionId: Schema.String,
    harness: Schema.String,
    operation: Schema.Literals([
      "capture-archive",
      "locate-transcript",
      "read-transcript",
      "identify-session",
      "restore-archive",
      "import-session",
    ]),
    exitCode: Schema.Number,
    stderr: Schema.String,
    message: Schema.String,
  },
) {}

export type HarnessStateError =
  | HarnessStateNotFoundError
  | HarnessStateIOError
  | HarnessStateInvalidError
  | HarnessStateCommandError;

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

/** Read and validate the commit marker for a harvested harness session. */
export const readHarnessStateManifest = (stateDir: string, sessionId: string) => {
  const manifestPath = path.join(stateDir, "manifest.json");
  return Effect.tryPromise({
    try: () => fs.readFile(manifestPath, "utf8"),
    catch: (cause) =>
      isMissingFile(cause)
        ? new HarnessStateNotFoundError({
            sessionId,
            path: manifestPath,
            message: `Saved harness state is missing for session ${sessionId}.`,
          })
        : new HarnessStateIOError({
            sessionId,
            operation: "read-manifest",
            path: manifestPath,
            message: `Could not read the saved harness-state manifest for session ${sessionId}.`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(HarnessStateManifest))(raw).pipe(
        Effect.mapError(
          (cause) =>
            new HarnessStateInvalidError({
              sessionId,
              path: manifestPath,
              message: `Saved harness state is invalid for session ${sessionId}.`,
              cause,
            }),
        ),
      ),
    ),
  );
};

/** A harvested capture: the directory holding the three files, and its commit marker. */
export interface LocatedHarnessState {
  readonly stateDir: string;
  readonly manifest: HarnessStateManifest;
}

/**
 * The session-level "latest" view over per-process captures: the newest agent
 * process with a committed manifest wins; the legacy session-root capture is
 * the last resort. `processStateDirs` is newest first. Fails with
 * `HarnessStateNotFoundError` (naming the session root) when nothing exists.
 */
export const locateHarnessState = (
  sessionStateDir: string,
  processStateDirs: ReadonlyArray<string>,
  sessionId: string,
): Effect.Effect<
  LocatedHarnessState,
  HarnessStateNotFoundError | HarnessStateIOError | HarnessStateInvalidError
> =>
  Effect.gen(function* () {
    for (const stateDir of processStateDirs) {
      const manifest = yield* readHarnessStateManifest(stateDir, sessionId).pipe(
        Effect.catchTag("HarnessStateNotFoundError", () => Effect.succeed(null)),
      );
      if (manifest !== null) return { stateDir, manifest };
    }
    const manifest = yield* readHarnessStateManifest(sessionStateDir, sessionId);
    return { stateDir: sessionStateDir, manifest };
  });

interface HarnessStateShape {
  /** `$HOME`-relative directories/files that hold the harness's session state. */
  readonly paths: ReadonlyArray<string>;
  /**
   * `$HOME`-relative top-level state directories relocated onto the session's durable
   * harness-home mount at boot (`$HOME/<dir>` becomes a symlink into the mount). Everything the
   * harness writes under them — transcripts, todos, skills — lands on the store and survives
   * workspace death. Single files at the `$HOME` root (`.claude.json`) stay ephemeral: an
   * atomic-rename there would replace a symlink with a plain file, so they ride the
   * settle-time harvest only.
   */
  readonly homeDirs: ReadonlyArray<string>;
  /** Shell snippet printing the path of the primary transcript file, newest first. */
  readonly latestTranscript: string;
  /** `harness-home`-relative glob for the primary transcript, matched server-side. */
  readonly liveTranscript: RegExp | null;
  /** Derive the provider session id from the primary transcript's path/name. */
  readonly providerSessionId: (transcriptPath: string) => string | null;
}

/**
 * Where the session's durable harness home is mounted inside every workspace (read-write; the
 * source is `harnessHomePathOf` in the store). Boot symlinks each harness's `homeDirs` here.
 */
export const HARNESS_HOME_MOUNT_PATH = "/workspace/harness-home";

/**
 * Conversations Mend carried into a session's home from the owner's other sessions on the project
 * (docs/adr/0009, "Codex"), one provider session id per line, relative to the harness home. They
 * are there for Codex to learn from; nothing that looks for "this session's conversation" (the
 * harvest, the crash harvest, the transcript reader, the external-agent observer) may take one.
 */
export const CARRIED_TRANSCRIPTS = ".mend/carried-transcripts";

/** The provider session ids a carried-transcripts file lists. */
export const parseCarriedTranscripts = (raw: string | null): ReadonlySet<string> =>
  new Set(
    (raw ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f-]{36}$/.test(line)),
  );

const CLAUDE_JSONL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const CODEX_ROLLOUT =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
/** pi: `<ISO time>_<session id>.jsonl` under `sessions/<encoded working directory>/`. */
const PI_SESSION = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** One path under the harness home where a harness keeps a credential. */
export interface HarnessCredential {
  /** Relative to the harness home. */
  readonly path: string;
  /**
   * A file, with every sibling named after it with a suffix (`<path>.<suffix>`: a write's
   * temporary such as `auth.json.mend-seed-<pid>`, a lock, a backup copy); or a directory and
   * everything under it.
   */
  readonly kind: "file" | "directory";
  /** What it holds, as the provider-logins docs page lists it. */
  readonly holds: string;
}

/**
 * Every credential a harness can write into its home: logins, OAuth and MCP tokens, keys, and
 * files that copy them. The harness home is the worktree's in capture mode, so what one session
 * leaves there reaches the next session in the worktree, whoever's that is. None of these may.
 *
 * sealantd's `HARNESS_CREDENTIALS` (`crates/sealant-capture/src/index.rs`) is what keeps them out
 * of captures and restores, and must list the same paths; a test holds this table to a copy of it.
 * Mend uses this one for the mode keeper (ADR 0005). Made on 2026-10-04 from each harness's source
 * at the version workspace images install (Claude Code 2.1.289, Codex 0.160.0, opencode 1.18.34,
 * pi 1.0.2) and from what each wrote in an unprivileged container with no OS keyring. The list
 * fails open: a credential missing from it is captured.
 *
 * Made both from what each left after a clean exit and from what it left killed in the middle of a
 * turn: a file a harness removes when it exits (Codex's and Claude Code's shell snapshots) is saved
 * while it exists, and stays when the process is killed.
 *
 * Settings that can also hold a secret a person typed in (`.codex/config.toml`,
 * `.claude/settings.json`, pi's `models.json` and `settings.json`) are not listed: they are the
 * person's configuration as much as a secret. pi's `mcp.json` is, because Mend delivers it from the
 * person's pi profile at every launch, so leaving it out loses nothing of theirs.
 */
export const HARNESS_CREDENTIALS: Readonly<Record<string, ReadonlyArray<HarnessCredential>>> = {
  claude: [
    {
      path: ".claude/.credentials.json",
      kind: "file",
      holds: "the Claude login, MCP server OAuth tokens and client secrets, plugin secrets",
    },
    {
      path: ".claude/.device-keys.json",
      kind: "file",
      holds: "device private keys (Remote Control, trusted devices)",
    },
    {
      path: ".claude/backups",
      kind: "directory",
      holds: "copies of `~/.claude.json`: a Console API key, MCP server headers and env",
    },
    {
      path: ".claude/shell-snapshots",
      kind: "directory",
      holds: "the shell's functions and aliases, any secret written in them included",
    },
    { path: ".claude/session-env", kind: "directory", holds: "what hooks export for the session" },
    { path: ".claude/ide", kind: "directory", holds: "IDE connection tokens" },
    {
      path: ".claude/sessions",
      kind: "directory",
      holds: "each running process's local messaging token",
    },
    {
      path: ".claude/file-history",
      kind: "directory",
      holds: "a copy of every file Claude Code edits, a secret file included",
    },
    {
      path: ".claude/remote-settings.json",
      kind: "file",
      holds: "an organization's managed settings, `env` included",
    },
  ],
  codex: [
    { path: ".codex/auth.json", kind: "file", holds: "the ChatGPT login or API key" },
    {
      path: ".codex/.credentials.json",
      kind: "file",
      holds: "MCP server OAuth tokens, where no OS keyring is available (every workspace)",
    },
    {
      path: ".codex/secrets",
      kind: "directory",
      holds: "encrypted logins and MCP tokens (the key is in the OS keyring)",
    },
    {
      path: ".codex/shell_snapshots",
      kind: "directory",
      holds: "every exported environment variable with its value (a token, a dotfile's export)",
    },
  ],
  opencode: [
    {
      path: ".local/share/opencode/auth.json",
      kind: "file",
      holds: "provider logins and API keys",
    },
    {
      path: ".local/share/opencode/mcp-auth.json",
      kind: "file",
      holds: "MCP server OAuth tokens and client secrets",
    },
    {
      path: ".local/share/opencode/repos",
      kind: "directory",
      holds: "reference repositories, a clone URL's credentials in their git config",
    },
    {
      path: ".local/share/opencode/log",
      kind: "directory",
      holds: "logs, a failed clone's URL with its credentials included",
    },
  ],
  pi: [
    { path: ".pi/agent/auth.json", kind: "file", holds: "provider logins and API keys" },
    {
      path: ".pi/agent/mcp-auth.json",
      kind: "file",
      holds: "MCP server OAuth tokens and client secrets",
    },
    {
      path: ".pi/agent/oauth.json",
      kind: "file",
      holds:
        "provider OAuth tokens from before pi moved them to `auth.json`, and its `.migrated` copy",
    },
    {
      path: ".pi/agent/mcp-oauth",
      kind: "directory",
      holds: "MCP OAuth tokens of the pi-mcp-adapter extension",
    },
    {
      path: ".pi/agent/mcp-oauth-encrypted",
      kind: "directory",
      holds: "the same, encrypted with a person's key",
    },
    {
      path: ".pi/agent/mcp.json",
      kind: "file",
      holds: "MCP servers, with the headers, env and client secrets typed into them",
    },
    {
      path: ".pi/agent/tmp",
      kind: "directory",
      holds:
        "packages a launch loads for itself from git, a source URL's credentials in their git config",
    },
    {
      path: ".pi/agent/crashes.json",
      kind: "file",
      holds: "error messages and stacks as they were, a secret in one included",
    },
    {
      path: path.posix.join(PI_PROFILE_HOME_DIR, PI_PROFILE_SECRET_FILE),
      kind: "file",
      holds: "the same, as Mend delivered it from a person's pi profile",
    },
    {
      path: PI_PROFILE_KEPT_DIR,
      kind: "directory",
      holds: "pi profiles Mend set aside, their `mcp.json` included",
    },
  ],
};

/**
 * A harness's own state that belongs to the machine it ran on, not to the work: never saved with
 * the session, though none of it is a credential, and so kept apart from `HARNESS_CREDENTIALS`
 * (the mode keeper leaves it alone). A `codex` typed by hand in a shell unpacks its runtime into
 * `.codex/packages/` (about 427 MB) and starts an app-server daemon that keeps its state and
 * control socket beside it; saved, every later executor of the worktree would restore the runtime
 * and a dead daemon's state. Codex rebuilds each when it next needs it. sealantd's
 * `HARNESS_MACHINE_STATE` keeps them out of captures and restores; a test holds this table to a
 * copy of it, and the provider-logins docs page lists it.
 */
export const HARNESS_MACHINE_STATE: Readonly<Record<string, ReadonlyArray<HarnessCredential>>> = {
  codex: [
    {
      path: ".codex/packages",
      kind: "directory",
      holds: "the Codex runtime a hand-run `codex` unpacks (about 427 MB)",
    },
    {
      path: ".codex/app-server-daemon",
      kind: "directory",
      holds: "the state of an app-server daemon running on that machine",
    },
    {
      path: ".codex/app-server-control",
      kind: "directory",
      holds: "that daemon's control socket",
    },
  ],
};

/**
 * Every path in `HARNESS_CREDENTIALS`, relative to the harness home: the one thing the mode keeper
 * must not open up (ADR 0005). Paths, not globs: a guess here would either miss a credential or
 * tighten a transcript.
 */
export const HARNESS_HOME_CREDENTIALS: ReadonlyArray<string> = Object.values(
  HARNESS_CREDENTIALS,
).flatMap((credentials) => credentials.map((credential) => credential.path));

/**
 * `chmod go-rwx` over every credential that exists and, as the table's rule has it, every sibling
 * named after it with a suffix (`oauth.json.migrated`, a seed's `auth.json.mend-seed-<pid>`); quiet
 * about the ones that do not exist. A directory entry's siblings are tightened too: tightening a
 * path that holds nothing secret only narrows who reads it.
 */
export const tightenCredentials = (mountPath: string): string =>
  `for c in ${HARNESS_HOME_CREDENTIALS.map((file) => `"${file}"`).join(" ")}; ` +
  `do chmod go-rwx "${mountPath}/$c" "${mountPath}/$c".* 2>/dev/null || true; done`;

export const HARNESS_STATE: Record<string, HarnessStateShape> = {
  claude: {
    paths: [".claude/projects", ".claude/todos", ".claude/settings.json", ".claude.json"],
    homeDirs: [".claude"],
    latestTranscript: 'ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1',
    liveTranscript: /^\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/,
    providerSessionId: (file) => CLAUDE_JSONL.exec(file)?.[1] ?? null,
  },
  codex: {
    paths: [".codex/sessions", ".codex/history.jsonl"],
    homeDirs: [".codex"],
    // Newest first, never a conversation Mend carried in (`CARRIED_TRANSCRIPTS`).
    latestTranscript:
      'ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | ' +
      `{ if [ -s "${HARNESS_HOME_MOUNT_PATH}/${CARRIED_TRANSCRIPTS}" ]; ` +
      `then grep -vF -f "${HARNESS_HOME_MOUNT_PATH}/${CARRIED_TRANSCRIPTS}"; else cat; fi; } | head -1`,
    liveTranscript: /^\.codex\/sessions\/[^/]+\/[^/]+\/[^/]+\/rollout-[^/]+\.jsonl$/,
    providerSessionId: (file) => CODEX_ROLLOUT.exec(file)?.[1] ?? null,
  },
  // opencode keeps its sessions in a SQLite database (`opencode.db`), not files: the directory
  // is relocated and harvested whole, and no session id is read from it yet.
  opencode: {
    paths: [".local/share/opencode"],
    homeDirs: [".local/share/opencode"],
    latestTranscript: "true",
    liveTranscript: null,
    providerSessionId: () => null,
  },
  pi: {
    paths: [".pi/agent/sessions", ".pi/agent/settings.json"],
    homeDirs: [".pi"],
    latestTranscript: 'ls -t "$HOME"/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -1',
    liveTranscript: /^\.pi\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/,
    providerSessionId: (file) => PI_SESSION.exec(file)?.[1] ?? null,
  },
};

/**
 * The boot step that makes harness state durable: for every supported harness (a workspace
 * carries them all, and a session can switch mid-life), move whatever `$HOME` already holds —
 * image-baked defaults, injected credentials, a restored capture — into the harness root, then
 * symlink the `$HOME` directory to that root. Root-side entries win on collision: when both a
 * restore and live state exist, the live state is newer by construction. Idempotent; a rerun over
 * existing symlinks does nothing.
 *
 * The merge copies only what the root is missing (`cp -a` of each missing entry, which keeps that
 * entry's own modes), and never writes over an existing root-side directory or file: a restored
 * directory keeps its saved mode and exact time, descendants and the root itself included. A new
 * entry changes its parent's time, so the parent's time is taken before and put back after
 * (review 2026-09-28 (19) #1: `cp -an source/. root/` copied the fresh directory's 0700 and time
 * over a restored `.claude` saved at 0750).
 *
 * Co-located workspaces need the permission keeper because a different host uid reads the mounted
 * directory. Capture workspaces pass `keepStoreReadable: false`: sealantd reads its own local root,
 * and the detached keeper must not become part of captured state.
 */
const checkedDirectoryScript = (target: string, create: boolean) =>
  `[ ! -L "${target}" ] || fail "symlinked directory: ${target}"; ` +
  (create
    ? `if [ ! -e "${target}" ]; then kept_time "${target}" mkdir "${target}" || fail "mkdir: ${target}"; fi; ` +
      `[ -d "${target}" ] || fail "not a directory: ${target}"; ` +
      `[ "$(cd "${target}" && pwd -P)" = "${target}" ] || fail "indirect directory: ${target}"`
    : `if [ -e "${target}" ]; then ` +
      `[ -d "${target}" ] || fail "not a directory: ${target}"; ` +
      `[ "$(cd "${target}" && pwd -P)" = "${target}" ] || fail "indirect directory: ${target}"; fi`);

/**
 * Shell functions for the merge. `kept_time <path> <command…>` runs the command, which creates
 * `<path>`, and puts the time of `<path>`'s parent back as it was. `merge_missing <from> <to>` copies
 * every entry of `<from>` that `<to>` lacks, whole, and descends where both hold a real directory
 * of that name; anything else present on the `<to>` side is left exactly as it is.
 */
const MERGE_FUNCTIONS = [
  `kept_time() { kt_parent="\${1%/*}"; kt_ref="$(mktemp)" || fail "no temporary file for: $kt_parent"; ` +
    `touch -r "$kt_parent" "$kt_ref" || { rm -f "$kt_ref"; fail "time unreadable: $kt_parent"; }; ` +
    `shift; "$@"; kt_status=$?; ` +
    `touch -r "$kt_ref" "$kt_parent" || { rm -f "$kt_ref"; fail "time not restored: $kt_parent"; }; ` +
    `rm -f "$kt_ref"; return $kt_status; }`,
  `merge_missing() ( for mm_from in "$1"/* "$1"/.[!.]* "$1"/..?*; do ` +
    `[ -e "$mm_from" ] || [ -L "$mm_from" ] || continue; ` +
    `mm_to="$2/\${mm_from##*/}"; ` +
    `if [ -e "$mm_to" ] || [ -L "$mm_to" ]; then ` +
    `if [ -d "$mm_from" ] && [ ! -L "$mm_from" ] && [ -d "$mm_to" ] && [ ! -L "$mm_to" ]; then ` +
    `merge_missing "$mm_from" "$mm_to" || exit 1; fi; ` +
    `else kept_time "$mm_to" cp -a "$mm_from" "$mm_to" || exit 1; fi; done )`,
];

/**
 * `physical_root <relative path>`: where a `$HOME`-relative harness path is read from, physically.
 * Walks the path from `$HOME`; the one link taken is the relocation's own, a component that points
 * exactly at the same path under the mount (`~/.claude`, `~/.local/share/opencode`), after which
 * the walk goes on under the mount and no further link is taken. Sets `R` to `$HOME` or the mount,
 * or returns 1 at any other link.
 */
const physicalRootFunction = (mountPath: string) =>
  'physical_root() { pr_rest=$1; pr_rel=""; R="$HOME"; while :; do case "$pr_rest" in ' +
  '*/*) pr_seg=${pr_rest%%/*}; pr_rest=${pr_rest#*/};; *) pr_seg=$pr_rest; pr_rest="";; esac; ' +
  'pr_rel="${pr_rel:+$pr_rel/}$pr_seg"; if [ -L "$R/$pr_rel" ]; then ' +
  `{ [ "$R" = "$HOME" ] && [ "$(readlink "$R/$pr_rel")" = "${mountPath}/$pr_rel" ]; } || return 1; ` +
  `R="${mountPath}"; fi; [ -z "$pr_rest" ] && return 0; done; }; `;

/**
 * The co-located harvest: the harness's state paths, archived from where they physically are
 * (the mount the relocation linked `$HOME/<dir>` onto, or `$HOME` itself when it did not) and
 * never through a link. `tar` follows no symlink: a link an agent left anywhere under the harness
 * home, or put in place of a directory on the way, is archived as a link, so a secret file it
 * points at (docs/adr/0010) or anything else outside the harness home never enters the archive.
 * The relocation's own top-level links are the one indirection taken, by reading under the mount.
 * Conversations Mend carried in from other sessions (docs/adr/0009, "Codex") stay out: restored
 * without their list, one could read as this session's own.
 *
 * Exit 3 when none of the paths is present. Prints the archive, base64, on stdout. The archive and
 * the exclude list go under `$TMPDIR`, `/tmp` by default.
 */
export const harvestHarnessStateScript = (
  paths: ReadonlyArray<string>,
  mountPath: string = HARNESS_HOME_MOUNT_PATH,
): string => {
  const list = paths.map((p) => `"${p}"`).join(" ");
  return (
    'cd "$HOME" || exit 1; O="${TMPDIR:-/tmp}/mend-harness-state"; ' +
    physicalRootFunction(mountPath) +
    `A=""; B=""; for p in ${list}; do [ -e "$p" ] || continue; physical_root "$p" || continue; ` +
    `if [ "$R" = "$HOME" ]; then B="$B $p"; else A="$A $p"; fi; done; ` +
    '[ -n "$A$B" ] || exit 3; X="$O.exclude"; : > "$X"; ' +
    `C="${mountPath}/${CARRIED_TRANSCRIPTS}"; [ -s "$C" ] && sed 's/.*/*&*/' "$C" > "$X"; ` +
    `set --; [ -n "$A" ] && set -- "$@" -C "${mountPath}" $A; [ -n "$B" ] && set -- "$@" -C "$HOME" $B; ` +
    'tar -czf "$O.tgz" -X "$X" "$@" && base64 -w0 "$O.tgz"'
  );
};

/**
 * Read one harness file by its absolute path under `$HOME` (`$1`), never through a link: the
 * relocation's own top-level link is the one indirection taken, and every other component on
 * the way, the file included, must be a plain entry. Exit 4 otherwise, with the reason on stderr.
 */
export const readHarnessFileScript = (mountPath: string = HARNESS_HOME_MOUNT_PATH): string =>
  'case "$1" in "$HOME"/*) ;; *) echo "not under the home directory" >&2; exit 4;; esac; ' +
  'rel=${1#"$HOME"/}; ' +
  physicalRootFunction(mountPath) +
  'physical_root "$rel" || { echo "a symlink is on the way to $1" >&2; exit 4; }; cat "$R/$rel"';

export const relocateHarnessHomeScript = (
  mountPath: string = HARNESS_HOME_MOUNT_PATH,
  options: { readonly keepStoreReadable?: boolean } = {},
): string => {
  const dirs = [...new Set(Object.values(HARNESS_STATE).flatMap((shape) => shape.homeDirs))];
  // The parents of each harness directory are created when missing; the harness directory itself
  // is created by the merge (a copy of the `$HOME` one, with its modes) or, with nothing to copy,
  // as an empty directory.
  const destinationParents = [
    ...new Set(
      dirs.flatMap((dir) => {
        const parts = dir.split("/").slice(0, -1);
        return parts.map((_, index) => `${mountPath}/${parts.slice(0, index + 1).join("/")}`);
      }),
    ),
  ];
  const sourceParents = [
    ...new Set(
      dirs.flatMap((dir) => {
        const parts = dir.split("/").slice(0, -1);
        return parts.map((_, index) => `$HOME/${parts.slice(0, index + 1).join("/")}`);
      }),
    ),
  ];
  const preflight = [
    `fail() { printf '%s\\n' "harness-home relocation failed: $1" >&2; exit 1; }`,
    `[ "${mountPath.slice(0, 1)}" = "/" ] || fail "root is not absolute"`,
    `[ "${mountPath}" != "/" ] || fail "root is filesystem root"`,
    `[ -d "${mountPath}" ] && [ ! -L "${mountPath}" ] || fail "root is missing or linked"`,
    `[ "$(cd "${mountPath}" && pwd -P)" = "${mountPath}" ] || fail "root has a linked parent"`,
    `case "$HOME" in /*) ;; *) fail "HOME is not absolute" ;; esac`,
    `[ "$HOME" != "/" ] || fail "HOME is filesystem root"`,
    `[ -d "$HOME" ] && [ ! -L "$HOME" ] || fail "HOME is missing or linked"`,
    `[ "$(cd "$HOME" && pwd -P)" = "$HOME" ] || fail "HOME has a linked parent"`,
    `case "$HOME/" in "${mountPath}/"*) fail "root contains HOME" ;; esac`,
    `case "${mountPath}/" in "$HOME/"*) fail "HOME contains root" ;; esac`,
    ...MERGE_FUNCTIONS,
    ...destinationParents.map((target) => checkedDirectoryScript(target, true)),
    ...dirs.map((dir) => checkedDirectoryScript(`${mountPath}/${dir}`, false)),
    ...sourceParents.map((target) => checkedDirectoryScript(target, true)),
  ];
  const perDir = dirs.map((dir) => {
    const source = `$HOME/${dir}`;
    const destination = `${mountPath}/${dir}`;
    return (
      `if [ -L "${source}" ]; then ` +
      `[ -d "${source}" ] || fail "dangling source link: ${source}"; ` +
      `[ "$(cd "${source}" && pwd -P)" = "${destination}" ] || fail "unexpected source link: ${source}"; ` +
      `elif [ -e "${source}" ]; then ` +
      `[ -d "${source}" ] || fail "source is not a directory: ${source}"; ` +
      `if [ -e "${destination}" ]; then merge_missing "${source}" "${destination}" || fail "copy: ${source}"; ` +
      `else kept_time "${destination}" cp -a "${source}" "${destination}" || fail "copy: ${source}"; fi; ` +
      `rm -rf "${source}" || fail "remove: ${source}"; ` +
      `fi; ` +
      `if [ ! -L "${source}" ]; then ` +
      `[ ! -e "${source}" ] || fail "source still exists: ${source}"; ` +
      `if [ ! -e "${destination}" ]; then kept_time "${destination}" mkdir "${destination}" || fail "mkdir: ${destination}"; fi; ` +
      `ln -s "${destination}" "${source}" || fail "link: ${source}"; ` +
      `fi; ` +
      `[ -L "${source}" ] && [ -d "${source}" ] || fail "source link is invalid: ${source}"; ` +
      `[ "$(cd "${source}" && pwd -P)" = "${destination}" ] || fail "source link resolves outside root: ${source}"`
    );
  });
  // The mode keeper: workspace processes run as root and some harnesses tighten their state to
  // 0700/0600 (codex does), which blinds the store-side reader (the observer, crash harvest,
  // uid 1000; NFS checks modes server-side, so only opening the modes helps). A detached root
  // loop inside the workspace re-opens read bits every 15s. The pidfile keeps relaunches from
  // stacking keepers. Interim by design: the structural fix is a single uid story for
  // workspace-written store files (PLATFORM-FEEDBACK.md 2026-08-29).
  //
  // Credentials are exempt. The harness home holds the provider credential the platform injected
  // (`.claude/.credentials.json` at 0600, `.codex/auth.json`), and a recursive `go+rX` left it
  // world-readable on the store — a file holding a refresh token good for weeks
  // (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md). Nothing store-side reads it:
  // no harness's `paths` lists a credential, so the harvest never collects one. The widen and the
  // re-tighten are two commands, so a reader inside the workspace has a sub-second window — and
  // inside the workspace the only other reader is root, which modes do not stop anyway.
  const keeper =
    `if ! kill -0 "$(cat "${mountPath}/.mode-keeper.pid" 2>/dev/null)" 2>/dev/null; then ` +
    `setsid sh -c 'echo $$ > "${mountPath}/.mode-keeper.pid"; ` +
    `while sleep 15; do chmod -R go+rX "${mountPath}" 2>/dev/null || exit 0; ` +
    `${tightenCredentials(mountPath)}; done' ` +
    `>/dev/null 2>&1 & fi; ` +
    `chmod -R go+rX "${mountPath}" 2>/dev/null || true; ${tightenCredentials(mountPath)}`;
  return [...preflight, ...perDir, ...(options.keepStoreReadable === false ? [] : [keeper])].join(
    "; ",
  );
};

/**
 * Whether the session's harness home already holds state for `harness` — the signal that a
 * relaunch needs no archive restore: the mounted home carries everything, boot just symlinks
 * it back into `$HOME`. Unreadable or absent reads as false.
 */
export const hasLiveHarnessState = (
  harnessHomePath: string,
  harness: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const dirs = HARNESS_STATE[harness]?.homeDirs ?? [];
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(path.join(harnessHomePath, dir));
        // `skills` is configuration Mend itself materializes into the home
        // before boot (skills.ts), not something the harness wrote — counting
        // it would read every skills-carrying session as live and silently
        // skip archive restores on relaunch.
        if (entries.some((entry) => entry !== "skills")) return true;
      } catch {
        // Missing or unreadable — not live state.
      }
    }
    return false;
  });

/**
 * Find the newest primary transcript in a session's harness home, server-side — no workspace
 * exec, so it works when the workspace is already gone (the crash-recovery path). Returns the
 * transcript's absolute path and the provider session id derived from its name; null when the
 * harness keeps no locatable transcript, none was written, or the harness home is unreadable
 * (a locator, not a validator — absence is an answer, never an error).
 */
export const locateLiveTranscript = (
  harnessHomePath: string,
  harness: string,
): Effect.Effect<{
  readonly path: string;
  readonly providerSessionId: string | null;
  /** Last write to the transcript — the observed "the agent is (still) working" signal. */
  readonly mtimeMs: number;
} | null> =>
  Effect.promise(async () => {
    const shape = HARNESS_STATE[harness];
    if (shape === undefined || shape.liveTranscript === null) return null;
    const pattern = shape.liveTranscript;
    try {
      const carried = parseCarriedTranscripts(
        await fs
          .readFile(path.join(harnessHomePath, CARRIED_TRANSCRIPTS), "utf8")
          .catch(() => null),
      );
      const entries = await fs.readdir(harnessHomePath, { recursive: true, withFileTypes: true });
      let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(harnessHomePath, absolute);
        if (!pattern.test(relative)) continue;
        const id = shape.providerSessionId(relative);
        if (id !== null && carried.has(id)) continue;
        const stat = await fs.stat(absolute);
        if (newest === null || stat.mtimeMs > newest.mtimeMs) {
          newest = { path: absolute, mtimeMs: stat.mtimeMs };
        }
      }
      if (newest === null) return null;
      return {
        path: newest.path,
        providerSessionId: shape.providerSessionId(newest.path),
        mtimeMs: newest.mtimeMs,
      };
    } catch {
      return null;
    }
  });

/** Turn a normal harness launch into that harness's native session resume. */
export const nativeResumeArgv = (
  harness: string,
  providerSessionId: string | null,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (providerSessionId === null) return argv;
  switch (harness) {
    case "claude": {
      if (
        argv[0] !== "claude" ||
        argv.includes("--resume") ||
        argv.includes("-r") ||
        argv.includes("--continue")
      ) {
        return argv;
      }
      const [, ...tail] = argv;
      return ["claude", "--resume", providerSessionId, ...tail];
    }
    case "codex": {
      if (argv[0] !== "codex" || argv[1] === "resume") return argv;
      const [, ...tail] = argv;
      return ["codex", "resume", providerSessionId, ...tail];
    }
    case "pi": {
      if (
        argv[0] !== "pi" ||
        ["--session", "--session-id", "--continue", "-c", "--resume", "-r", "--fork"].some((flag) =>
          argv.includes(flag),
        )
      ) {
        return argv;
      }
      const [, ...tail] = argv;
      return ["pi", "--session", providerSessionId, ...tail];
    }
    default:
      return argv;
  }
};

// ---------------------------------------------------------------------------
// Transcript adapters — native session files → one normalized shape. This is
// the seam that makes a saved session openable anywhere: a target harness
// never reads another harness's state, it reads the distilled conversation.
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { readonly type?: string; readonly text?: string };
        return p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .filter((text) => text !== "")
      .join("\n");
  }
  return "";
};

/** Claude Code session JSONL: `{type: "user"|"assistant", message: {role, content}}` lines. */
const parseClaudeTranscript = (jsonl: string): ReadonlyArray<TranscriptTurn> => {
  const turns: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let entry: {
      readonly type?: string;
      readonly message?: { readonly role?: string; readonly content?: unknown };
      readonly isMeta?: boolean;
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.isMeta === true) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const text = textOfContent(entry.message?.content).trim();
    if (text === "") continue;
    turns.push({ role: entry.type, text });
  }
  return turns;
};

/** Codex rollout JSONL: `{type: "response_item", payload: {type: "message", role, content}}` lines. */
const parseCodexTranscript = (jsonl: string): ReadonlyArray<TranscriptTurn> => {
  const turns: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let entry: {
      readonly type?: string;
      readonly payload?: {
        readonly type?: string;
        readonly role?: string;
        readonly content?: unknown;
      };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "response_item" || entry.payload?.type !== "message") continue;
    const role = entry.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOfContent(entry.payload.content).trim();
    if (text === "") continue;
    turns.push({ role, text });
  }
  return turns;
};

/** Parse a saved native transcript into normalized turns. Unknown harness → empty. */
export const extractTranscript = (
  harness: string,
  native: string,
): ReadonlyArray<TranscriptTurn> => {
  switch (harness) {
    case "claude":
      return parseClaudeTranscript(native);
    case "codex":
      return parseCodexTranscript(native);
    default:
      return [];
  }
};

const TURN_LIMIT = 40;
const TURN_CHARS = 2_000;

/**
 * Distill a transcript into the opening prompt a DIFFERENT harness receives —
 * the cross-harness open. Mechanical, no inference: recent turns verbatim
 * (truncated per turn), oldest elided with an honest marker.
 */
export const distillOpeningPrompt = (
  sourceHarness: string,
  turns: ReadonlyArray<TranscriptTurn>,
): string => {
  const recent = turns.slice(-TURN_LIMIT);
  const elided = turns.length - recent.length;
  const body = recent
    .map((turn) => {
      const text =
        turn.text.length > TURN_CHARS
          ? `${turn.text.slice(0, TURN_CHARS)}\n[…truncated]`
          : turn.text;
      return `${turn.role === "user" ? "User" : "Assistant"}:\n${text}`;
    })
    .join("\n\n");
  return [
    `You are resuming a coding session that was previously driven by ${sourceHarness}.`,
    `The working tree already contains that session's work — read it before changing anything.`,
    elided > 0 ? `(${elided} earlier turns elided.)` : null,
    ``,
    `Conversation so far:`,
    ``,
    body,
    ``,
    `Continue from where the conversation left off.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};
