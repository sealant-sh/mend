import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { captureStatusLine, servicesHoldLine } from "@mend/domain/workbench";

/**
 * Facts both entry points need: how each harness launches and resumes, which
 * session statuses mean "live", and how a cwd resolves to an adopted project.
 * Kept dependency-free so main.ts stays runnable on plain Node >= 22.
 */

export const HARNESS_COMMANDS: Record<string, ReadonlyArray<string>> = {
  codex: ["codex"],
  claude: ["claude"],
  opencode: ["opencode"],
  pi: ["pi"],
  // Not a coding agent: a plain bash session in its own recorded worktree.
  shell: ["bash"],
};

/** How each harness takes an instruction as its opening prompt. */
export const CONTINUE_COMMANDS: Record<string, (instruction: string) => ReadonlyArray<string>> = {
  codex: (instruction) => ["codex", instruction],
  claude: (instruction) => ["claude", instruction],
  opencode: (instruction) => ["opencode", "--prompt", instruction],
  pi: (instruction) => ["pi", instruction],
};

/** Mirror of @mend/domain/workbench harness-launch.ts — the CLI ships dependency-free. */
/** Every effort the server takes (`@mend/domain`'s scale); a level a model cannot take is clamped there. */
export const EFFORT_LEVELS: ReadonlyArray<string> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/**
 * Ids of optimistic cache rows the server has not named yet — a session still
 * provisioning, a review comment still saving. Anything that would send such
 * an id to the server checks here first and waits instead.
 */
export const PENDING_ID_PREFIX = "pending:";
export const pendingId = (): string => `${PENDING_ID_PREFIX}${crypto.randomUUID()}`;
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_ID_PREFIX);

/** A parsed `mend <harness> …` invocation; `error` set means "print and exit". */
export interface LaunchArgs {
  readonly project: string | null;
  readonly prompt: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly base: string | null;
  /**
   * Names the worktree (branch `mend/<name>`). An existing name JOINS that
   * worktree — a new conversation inside it; null derives an anonymous one.
   */
  readonly name: string | null;
  /** `--worktree`: join an EXISTING worktree by name — fails when absent. */
  readonly worktree: string | null;
  readonly ask: boolean;
  /** Priority processing — codex `service_tier=priority`. */
  readonly fast: boolean;
  /** Launch and return immediately — no attach; the session runs in the background. */
  readonly detach: boolean;
  /** Foreground semantics for this launch — the session stops when this CLI exits. */
  readonly foreground: boolean;
  /** Keep the session's browser Services off this machine's loopback while attached. */
  readonly noTunnel: boolean;
  /**
   * `--land` / `--no-land`: this session's own automatic-landing override (docs/adr/0007);
   * null follows the project's "Land when a turn completes".
   */
  readonly autoLand: boolean | null;
  /** `--json`: mend run prints what it started (and how it ended) as JSON on stdout. */
  readonly json: boolean;
  /** Everything after `--` (mend run's command). */
  readonly custom: ReadonlyArray<string>;
  readonly error: string | null;
}

const LAUNCH_ERROR: Omit<LaunchArgs, "error"> = {
  project: null,
  prompt: null,
  model: null,
  effort: null,
  base: null,
  name: null,
  worktree: null,
  ask: false,
  fast: false,
  detach: false,
  foreground: false,
  noTunnel: false,
  autoLand: null,
  json: false,
  custom: [],
};

/**
 * `mend claude|codex|opencode ["prompt"] [--model <id>] [--effort <level>]
 * [--base <ref>] [--ask] [--detach|-d] [--foreground] [--no-tunnel] [--land|--no-land]
 * [--project <p>]`, plus
 * `mend run [--detach|-d] [--json] … -- <command...>`.
 * The first non-flag positional is the prompt; a second one is an error so a
 * forgotten quote fails loudly instead of launching with half a sentence.
 */
export const parseLaunchArgs = (args: ReadonlyArray<string>): LaunchArgs => {
  const dashdash = args.indexOf("--");
  const custom = dashdash === -1 ? [] : args.slice(dashdash + 1);
  const flagArgs = dashdash === -1 ? args : args.slice(0, dashdash);
  let project: string | null = null;
  let prompt: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let base: string | null = null;
  let workName: string | null = null;
  let joinWorktree: string | null = null;
  let ask = false;
  let fast = false;
  let detach = false;
  let foreground = false;
  let noTunnel = false;
  let land = false;
  let noLand = false;
  let json = false;
  for (let index = 0; index < flagArgs.length; index += 1) {
    const arg = flagArgs[index] ?? "";
    if (arg === "--ask") {
      ask = true;
      continue;
    }
    if (arg === "--fast") {
      fast = true;
      continue;
    }
    if (arg === "--detach" || arg === "-d") {
      detach = true;
      continue;
    }
    if (arg === "--foreground") {
      foreground = true;
      continue;
    }
    if (arg === "--no-tunnel") {
      noTunnel = true;
      continue;
    }
    if (arg === "--land") {
      land = true;
      continue;
    }
    if (arg === "--no-land") {
      noLand = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      arg === "--project" ||
      arg === "--model" ||
      arg === "--effort" ||
      arg === "--base" ||
      arg === "--name" ||
      arg === "--worktree"
    ) {
      const value = flagArgs[index + 1];
      if (value === undefined) return { ...LAUNCH_ERROR, error: `${arg} needs a value` };
      if (arg === "--project") project = value;
      else if (arg === "--model") model = value;
      else if (arg === "--effort") effort = value;
      else if (arg === "--name") workName = normalizeProjectName(value);
      else if (arg === "--worktree") joinWorktree = value;
      else base = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      // Also catches a prompt starting with "-", which the harness would
      // otherwise read as a flag of its own.
      return {
        ...LAUNCH_ERROR,
        error: `unknown flag ${arg} — quote the prompt if it starts with "-"`,
      };
    }
    if (prompt !== null) {
      return {
        ...LAUNCH_ERROR,
        error: 'one prompt only — quote it: mend claude "fix the auth test"',
      };
    }
    prompt = arg;
  }
  if (effort !== null && !EFFORT_LEVELS.includes(effort)) {
    return { ...LAUNCH_ERROR, error: `--effort must be one of ${EFFORT_LEVELS.join(", ")}` };
  }
  if (detach && foreground) {
    return { ...LAUNCH_ERROR, error: "--detach and --foreground contradict — pick one" };
  }
  if (land && noLand) {
    return { ...LAUNCH_ERROR, error: "--land and --no-land contradict — pick one" };
  }
  if (workName !== null && joinWorktree !== null) {
    return {
      ...LAUNCH_ERROR,
      error: "--name and --worktree contradict — --name names (or joins), --worktree only joins",
    };
  }
  return {
    project,
    prompt,
    model,
    effort,
    base,
    name: workName,
    worktree: joinWorktree,
    ask,
    fast,
    detach,
    foreground,
    noTunnel,
    autoLand: land ? true : noLand ? false : null,
    json,
    custom,
    error: null,
  };
};

/**
 * Whether a raw stdin chunk carries the detach key (Ctrl+]). Two encodings
 * reach us: the legacy control byte 0x1d — and, once an inner TUI (claude)
 * pushes the kitty keyboard protocol through the PTY and the user's own
 * terminal honors it, the CSI-u escape `ESC [ 93 ; 5 u` (`]` is code 93,
 * ctrl is modifier 5), optionally with a kitty event-type suffix. Only press
 * (`:1`) and repeat (`:2`) are intent; a release (`:3`) is not.
 */
export const isDetachChunk = (data: Buffer): boolean => {
  if (data.includes(0x1d)) return true;
  return csiUKeysOf(data).some(
    (key) => key.code === 93 && isCtrlChord(key) && isPressOrRepeat(key),
  );
};

/**
 * What to call a session's worktree in banners and rows: a NAMED worktree is
 * its branch minus the `mend/` prefix; an unnamed one (`mend/session/<uuid>`)
 * is called by its auto-name label, or its short id before one lands.
 */
export const sessionDisplayName = (session: {
  readonly id: string;
  readonly branch: string;
  readonly label: string | null;
}): string => {
  if (session.branch.startsWith("mend/") && !session.branch.startsWith("mend/session/")) {
    return session.branch.slice("mend/".length);
  }
  if (!session.branch.startsWith("mend/session/")) return session.branch;
  return session.label ?? `session ${session.id.slice(0, 8)}`;
};

/**
 * Every way an attach can come back, told apart because the caller's answer
 * differs: `ended` is the server's end frame (the session settled); `dropped`
 * is a close without one (network, server restart — the session may still
 * run); `interrupted` is this CLI being told to die (SIGHUP/SIGINT/SIGTERM),
 * or Ctrl+C before the terminal connected (Ctrl+] then is `detached`);
 * `unavailable` is a terminal the server refused to open; `no-answer` is a
 * server that did not open it in time.
 */
export type AttachOutcome =
  | "detached"
  | "ended"
  | "dropped"
  | "interrupted"
  | "unavailable"
  | "no-answer";

export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting",
  "idle",
]);

/** The slice of a process row the CLI reasons about — the session's current agent process. */
export interface AgentProcessLike {
  readonly status: string;
  readonly exitCode: number | null;
  readonly exitedAt: string | null;
  readonly harness: string | null;
  readonly sealantSessionId: string | null;
  /** `agent-pty` · `agent-protocol` · … — optional: an older server omits it. */
  readonly kind?: string;
  /** When this agent process started; optional: an older server omits it. */
  readonly createdAt?: string;
}

/**
 * Whether the session's AGENT is live. Session status is a fold over every process — a session
 * reads `idle` while a shell holds the workspace after its agent ended — so the agent's own row
 * answers when one exists; `starting` is a launch with no row yet.
 */
export const agentIsLive = (
  session: { readonly status: string },
  currentAgent: AgentProcessLike | null,
): boolean =>
  currentAgent === null
    ? LIVE_STATUSES.has(session.status)
    : session.status === "starting" ||
      (currentAgent.exitedAt === null &&
        (currentAgent.status === "starting" || currentAgent.status === "running"));

/** What an ended agent process's exit says about the work; null while it runs. */
export const agentOutcome = (
  currentAgent: AgentProcessLike | null,
): "completed" | "failed" | "stopped" | null => {
  if (currentAgent === null || currentAgent.exitedAt === null) return null;
  if (currentAgent.status === "stopped") return "stopped";
  if (currentAgent.harness === "shell") return "completed";
  return currentAgent.exitCode === null || currentAgent.exitCode === 0 ? "completed" : "failed";
};

/**
 * What a session reads once its agent is no longer live while its Services keep the workspace up
 * (`agent stopped · 3 services keep the workspace up`); null otherwise. A stop leaves Services
 * running, so the status word alone would hide a workspace that is still up.
 */
export const servicesHoldOf = (
  session: { readonly status: string },
  currentAgent: AgentProcessLike | null,
  liveServices: number,
): string | null =>
  servicesHoldLine({
    agentLive: agentIsLive(session, currentAgent),
    agentOutcome: agentOutcome(currentAgent),
    liveServices,
  });

/** The capture facts a session carries on the wire; absent on servers from before them. */
export interface SessionCaptureLike {
  readonly capturePending?: number | null;
  readonly capturePendingBytes?: number | null;
  readonly captureRefused?: number | null;
  readonly captureDrain?: string | null;
  readonly captureNotSavedAt?: string | null;
  readonly captureIncompleteReason?: string | null;
  readonly captureIncompleteDetail?: string | null;
  readonly captureFailingSince?: string | null;
  readonly captureFailingError?: string | null;
  readonly captureOverdueStep?: string | null;
  readonly captureOverdueSince?: string | null;
  readonly captureOverdueRunningMs?: number | null;
  readonly captureOverdueBoundMs?: number | null;
  readonly captureDiscardedAt?: string | null;
  readonly captureDiscardedBy?: string | null;
}

/**
 * What the session's executor still holds (docs/adr/0002, "Stop drains, then terminates"):
 * `saving · 3 left` while a stop drains it, `not saved · 3 pending · workspace kept` once the
 * drain stopped moving; null when there is nothing to say (or the server says nothing).
 */
export const captureLineOf = (session: SessionCaptureLike): string | null => {
  const drain = session.captureDrain;
  return captureStatusLine({
    capturePending: session.capturePending ?? null,
    capturePendingBytes: session.capturePendingBytes ?? null,
    captureRefused: session.captureRefused ?? null,
    captureDrain:
      drain === "stop" || drain === "relaunch" || drain === "replacement" ? drain : null,
    captureNotSavedAt: session.captureNotSavedAt ?? null,
    captureIncompleteReason: session.captureIncompleteReason ?? null,
    captureIncompleteDetail: session.captureIncompleteDetail ?? null,
    captureFailingSince: session.captureFailingSince ?? null,
    captureFailingError: session.captureFailingError ?? null,
    captureOverdueStep: session.captureOverdueStep ?? null,
    captureOverdueSince: session.captureOverdueSince ?? null,
    captureOverdueRunningMs: session.captureOverdueRunningMs ?? null,
    captureOverdueBoundMs: session.captureOverdueBoundMs ?? null,
    captureDiscardedAt: session.captureDiscardedAt ?? null,
    captureDiscardedBy: session.captureDiscardedBy ?? null,
  });
};

export interface CwdProjectLike {
  readonly name: string;
  readonly originUrl: string | null;
}

/**
 * A git remote URL reduced to `host/owner/name` so https, ssh, scp-style, and
 * `.git` spellings of the same repository compare equal. Null for anything
 * that is not a URL-ish remote (a local path stays a path).
 */
export const normalizeRemoteUrl = (raw: string | null): string | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/\s:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const parts = url ?? scp;
  if (parts === null) return null;
  const [, host, rest] = parts;
  if (host === undefined || rest === undefined) return null;
  const repoPath = rest.replace(/\/+$/, "").replace(/\.git$/i, "");
  return `${host.toLowerCase()}/${repoPath.toLowerCase()}`;
};

/** What the cwd says about itself — the inputs the project matcher needs. */
export interface CwdFacts {
  readonly cwd: string;
  /** `git rev-parse --show-toplevel`, or null outside a repository. */
  readonly repoRoot: string | null;
  /** `git remote get-url origin`, or null when there is none. */
  readonly originUrl: string | null;
}

/**
 * The cwd's adopted project, in order: a project adopted from this very
 * path; a project whose origin is the same remote as the cwd repo's origin
 * (normalized, so a GitHub-adopted project matches a clone of it anywhere);
 * a project named like the repository root (through the same normalization
 * adopt uses, so a checkout called "Mend" matches the project "mend").
 */
export const matchProjectByCwd = <P extends CwdProjectLike>(
  projects: ReadonlyArray<P>,
  facts: CwdFacts,
): P | undefined => {
  const root = facts.repoRoot ?? facts.cwd;
  const byPath = projects.find(
    (p) =>
      p.originUrl !== null &&
      !p.originUrl.includes("://") &&
      (root === p.originUrl ||
        facts.cwd === p.originUrl ||
        facts.cwd.startsWith(`${p.originUrl}/`)),
  );
  if (byPath !== undefined) return byPath;
  const remote = normalizeRemoteUrl(facts.originUrl);
  const byRemote =
    remote === null ? undefined : projects.find((p) => normalizeRemoteUrl(p.originUrl) === remote);
  if (byRemote !== undefined) return byRemote;
  const name = normalizeProjectName(path.basename(root));
  return projects.find((p) => p.name === name);
};

/** Read the cwd's facts from git once; callers pass them to the matcher. */
export const cwdFacts = (cwd: string): CwdFacts => ({
  cwd,
  repoRoot: gitTopLevel(cwd),
  originUrl: gitOriginUrl(cwd),
});

/** The branch checked out at `cwd`, or null outside a repo or on a detached HEAD. */
export const gitCurrentBranch = (cwd: string): string | null => {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  const out = result.status === 0 ? result.stdout.trim() : "";
  return out === "" || out === "HEAD" ? null : out;
};

/** The cwd repo's origin remote, or null when there is no repo or no origin. */
export const gitOriginUrl = (cwd: string): string | null => {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  const out = result.status === 0 ? result.stdout.trim() : "";
  return out === "" ? null : out;
};

/** The repository root of `cwd`, or null when it is not inside a git repo. */
export const gitTopLevel = (cwd: string): string | null => {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * The store's name charset is /^[a-z0-9][a-z0-9._-]{0,63}$/ (server-enforced).
 * Derived defaults (a directory called "Mend") get normalized instead of
 * bounced; an explicit --name is sent as typed so the server's rule teaches.
 */
export const normalizeProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug === "" ? "project" : slug.slice(0, 64);
};

/**
 * One kitty-keyboard-protocol key report (`CSI code[:alt...] ; mods[:event] [; text] u`),
 * as the terminal sends it once the inner TUI pushed the protocol. `mods` is
 * the wire value minus one (so 4 = ctrl); lock modifiers (caps 64, num 128)
 * are masked off — a terminal asked to report all keys reports those too,
 * and Ctrl+V with Num Lock on arrives as `ESC [ 118 ; 133 u`. `event` is 1
 * for press (the default when omitted), 2 repeat, 3 release.
 */
export interface CsiUKey {
  readonly code: number;
  readonly mods: number;
  readonly event: number;
}

// Built from a string: an escape byte inside a regex literal trips lint.
const CSI_U = new RegExp(
  `${String.fromCharCode(0x1b)}\\[(\\d+)(?::\\d*)*(?:;(\\d+)(?::(\\d+))?)?(?:;[\\d:]+)?u`,
  "g",
);
const LOCK_MODIFIERS = 64 | 128;

/** Every CSI-u key report inside a chunk, in order. */
export const csiUKeysOf = (data: Buffer): ReadonlyArray<CsiUKey> => {
  // latin1 maps bytes 1:1, so the scan sees exactly the wire bytes.
  const text = data.toString("latin1");
  const keys: Array<CsiUKey> = [];
  for (const match of text.matchAll(CSI_U)) {
    const code = Number(match[1]);
    const mods = (match[2] === undefined ? 1 : Number(match[2])) - 1;
    const event = match[3] === undefined ? 1 : Number(match[3]);
    keys.push({ code, mods: mods & ~LOCK_MODIFIERS, event });
  }
  return keys;
};

const CTRL = 4;
const SHIFT = 1;
/** Ctrl held, optionally shift, nothing else (alt/super/hyper/meta make it another chord). */
const isCtrlChord = (key: CsiUKey): boolean => (key.mods & ~SHIFT) === CTRL;
const isPressOrRepeat = (key: CsiUKey): boolean => key.event === 1 || key.event === 2;

/**
 * Whether one stdin chunk is Ctrl+V — the raw 0x16 byte on its own, or one
 * CSI-u report of `v` (118) or `V` (86) with ctrl, on press or repeat. Exact
 * for the raw byte: a paste that happens to carry 0x16 is not a request.
 */
export const isPasteChunk = (data: Buffer): boolean => {
  if (data.length === 1 && data[0] === 0x16) return true;
  const keys = csiUKeysOf(data);
  const key = keys[0];
  return (
    keys.length === 1 &&
    key !== undefined &&
    (key.code === 118 || key.code === 86) &&
    isCtrlChord(key) &&
    isPressOrRepeat(key) &&
    data.toString("latin1").startsWith("\u001b[")
  );
};

/**
 * Follow the remote app's bracketed-paste mode through the bytes it writes:
 * the last `ESC [ ? 2004 h|l` in a chunk wins; a chunk with neither keeps the
 * current state. A pasted image path is wrapped only when the app asked.
 */
export const trackBracketedPaste = (output: Buffer, current: boolean): boolean => {
  const text = output.toString("latin1");
  const on = text.lastIndexOf("\u001b[?2004h");
  const off = text.lastIndexOf("\u001b[?2004l");
  if (on === -1 && off === -1) return current;
  return on > off;
};

/** The bytes that paste `text` into the remote app, bracketed when it asked. */
export const pasteBytes = (text: string, bracketed: boolean): Buffer =>
  Buffer.from(bracketed ? `\u001b[200~${text}\u001b[201~` : text, "utf8");

/**
 * The first positional argument: not a flag, and not the value of one of the `valued` flags (the
 * word after `--project`, `--from`, …). A flag that is absent takes no word with it: the first
 * argument stays a candidate (2026-10-02: `mend stop <id>` skipped index 0 whenever `--project`
 * was absent, and answered "several live sessions").
 */
export const firstPositional = (
  args: ReadonlyArray<string>,
  valued: ReadonlyArray<string>,
): string | undefined =>
  args.find(
    (argument, index) =>
      !argument.startsWith("--") && (index === 0 || !valued.includes(args[index - 1] ?? "")),
  );

/**
 * `text` with the credentials of every URL in it taken out. Adoption accepts a clone URL with a
 * token in it (`https://oauth2:TOKEN@github.com/acme/repo.git`) and the server returns the URL as
 * stored, so anything the CLI prints, a project's origin, a server's message or a JSON field, goes
 * through this. An http(s) (or any other) URL loses its whole userinfo, since a token can sit in
 * the user part alone; an ssh URL keeps its user (`git@`), which is no secret, and loses a password.
 * scp-like `git@host:path` has no password to lose and stays as it is.
 */
export const redactCredentials = (text: string): string =>
  text.replace(
    /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#@]+)@/giu,
    (_whole, scheme: string, userinfo: string) => {
      if (/^(git\+)?ssh$/iu.test(scheme)) {
        const user = userinfo.split(":")[0] ?? "";
        return user === "" ? `${scheme}://` : `${scheme}://${user}@`;
      }
      return `${scheme}://`;
    },
  );
