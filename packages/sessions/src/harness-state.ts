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

const CLAUDE_JSONL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const CODEX_ROLLOUT =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export const HARNESS_STATE: Record<string, HarnessStateShape> = {
  claude: {
    paths: [
      ".claude/projects",
      ".claude/todos",
      ".claude/sessions",
      ".claude/settings.json",
      ".claude.json",
    ],
    homeDirs: [".claude"],
    latestTranscript: 'ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1',
    liveTranscript: /^\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/,
    providerSessionId: (file) => CLAUDE_JSONL.exec(file)?.[1] ?? null,
  },
  codex: {
    paths: [".codex/sessions", ".codex/history.jsonl"],
    homeDirs: [".codex"],
    latestTranscript: 'ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1',
    liveTranscript: /^\.codex\/sessions\/[^/]+\/[^/]+\/[^/]+\/rollout-[^/]+\.jsonl$/,
    providerSessionId: (file) => CODEX_ROLLOUT.exec(file)?.[1] ?? null,
  },
  opencode: {
    paths: [".local/share/opencode"],
    homeDirs: [".local/share/opencode"],
    latestTranscript: "true",
    liveTranscript: null,
    providerSessionId: () => null,
  },
};

/**
 * Where the session's durable harness home is mounted inside every workspace (read-write; the
 * source is `harnessHomePathOf` in the store). Boot symlinks each harness's `homeDirs` here.
 */
export const HARNESS_HOME_MOUNT_PATH = "/workspace/harness-home";

/**
 * The boot step that makes harness state durable: for every supported harness (a workspace
 * carries them all, and a session can switch mid-life), move whatever `$HOME` already holds —
 * image-baked defaults, injected credentials, a restored capture — into the harness root, then
 * symlink the `$HOME` directory to that root. `cp -an` keeps root-side files on collision: when
 * both a restore and live state exist, the live state is newer by construction. Idempotent; a
 * rerun over existing symlinks does nothing.
 *
 * Co-located workspaces need the permission keeper because a different host uid reads the mounted
 * directory. Capture workspaces pass `keepStoreReadable: false`: sealantd reads its own local root,
 * and the detached keeper must not become part of captured state.
 */
const checkedDirectoryScript = (target: string) =>
  `[ ! -L "${target}" ] || fail "symlinked directory: ${target}"; ` +
  `if [ ! -e "${target}" ]; then mkdir "${target}" || fail "mkdir: ${target}"; fi; ` +
  `[ -d "${target}" ] || fail "not a directory: ${target}"; ` +
  `[ "$(cd "${target}" && pwd -P)" = "${target}" ] || fail "indirect directory: ${target}"`;

export const relocateHarnessHomeScript = (
  mountPath: string = HARNESS_HOME_MOUNT_PATH,
  options: { readonly keepStoreReadable?: boolean } = {},
): string => {
  const dirs = [...new Set(Object.values(HARNESS_STATE).flatMap((shape) => shape.homeDirs))];
  const destinationDirectories = [
    ...new Set(
      dirs.flatMap((dir) => {
        const parts = dir.split("/");
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
    ...destinationDirectories.map(checkedDirectoryScript),
    ...sourceParents.map(checkedDirectoryScript),
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
      `cp -an "${source}/." "${destination}/" || fail "copy: ${source}"; ` +
      `rm -rf "${source}" || fail "remove: ${source}"; ` +
      `fi; ` +
      `if [ ! -L "${source}" ]; then ` +
      `[ ! -e "${source}" ] || fail "source still exists: ${source}"; ` +
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
  const keeper =
    `if ! kill -0 "$(cat "${mountPath}/.mode-keeper.pid" 2>/dev/null)" 2>/dev/null; then ` +
    `setsid sh -c 'echo $$ > "${mountPath}/.mode-keeper.pid"; ` +
    `while sleep 15; do chmod -R go+rX "${mountPath}" 2>/dev/null || exit 0; done' ` +
    `>/dev/null 2>&1 & fi; ` +
    `chmod -R go+rX "${mountPath}" 2>/dev/null || true`;
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
      const entries = await fs.readdir(harnessHomePath, { recursive: true, withFileTypes: true });
      let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(harnessHomePath, absolute);
        if (!pattern.test(relative)) continue;
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
