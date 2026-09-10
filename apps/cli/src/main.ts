#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { repositoryCloneUrlIssue } from "@mend/domain/workbench";

import { type AgentShareHandle, bridgeUrlOf, shareAgent, startAgentShare } from "./agent-share.ts";
import { readClipboardImage } from "./clipboard.ts";
import { doctorCommand } from "./doctor.ts";
import { readSyncFiles, scanDotfileCandidates } from "./dotfiles.ts";
import { formatLoadReport, type EnvironmentLoadReportDto } from "./env.ts";
import {
  findCommand,
  manFileName,
  renderCommand,
  renderGroup,
  renderIndex,
  renderManIndex,
  renderManPage,
  usageOf,
} from "./help.ts";
import { loginCommand } from "./login.ts";
import { type ApiCall, pairCommand, qrCommand } from "./pair.ts";
import { nodeServerRuntime, serverCommand } from "./server-setup.ts";
import {
  isComposeFile,
  proposeFromCompose,
  proposeFromPackageJson,
  proposeFromWorkspacePackage,
  renderMendToml,
  workspaceGlobs,
} from "./service-init.ts";
import {
  agentIsLive,
  agentOutcome,
  type AgentProcessLike,
  cwdFacts,
  gitOriginUrl,
  gitTopLevel,
  HARNESS_COMMANDS,
  isDetachChunk,
  isPasteChunk,
  LIVE_STATUSES,
  pasteBytes,
  trackBracketedPaste,
  sessionDisplayName,
  matchProjectByCwd,
  normalizeProjectName,
  gitCurrentBranch,
  parseLaunchArgs,
} from "./shared.ts";
import { DEFAULT_SKILLS_DIR, scanSkillLibrary } from "./skills.ts";
import { sshCommand } from "./ssh-setup.ts";
import {
  describeUninstall,
  executeUninstall,
  parseUninstallArgs,
  planDeletesData,
  planLines,
  UNINSTALL_USAGE,
  type UninstallScope,
} from "./uninstall.ts";
import { cliVersion, fetchServerVersion, versionLines } from "./version.ts";

/**
 * The mend CLI (plan §7.2): the terminal-first entry into the workbench.
 *
 *   mend                                  the dashboard: projects + sessions, live
 *   mend adopt [source] [--name <name>]   clone a repo into the store
 *   mend codex|claude|opencode [...]      session worktree + launch the harness there
 *   mend run -- <command...>              same, arbitrary command
 *   mend projects                         adopted projects
 *   mend sessions [--all]                 sessions with their review facts
 *
 * The CLI talks to the Mend server API; the server owns the store, the
 * engine, and the database. Every launch — including `mend continue` — runs
 * supervised: a platform workspace mounts the session's worktree, a platform
 * PTY runs the harness, and the terminal here is one held WebSocket through
 * the Mend server (attachTty). Worktree isolation, checkpoints, the record,
 * the diff, and review all hang off that one path.
 *
 * Commands stay deliberately dependency-light: plain fetch + WebSocket, wire
 * DTOs as plain types (the server validates; the CLI renders). The one
 * exception is the dashboard, which lazy-loads @opentui/core and therefore
 * needs node:ffi (Node 26) — main gates and re-execs with the flag, so
 * everything else keeps running dependency-free on Node >= 22.
 */

interface CliConfig {
  readonly url: string;
  /** The url as the user actually set it (MEND_URL or the config file); null on a fresh machine. */
  readonly configuredUrl: string | null;
  readonly token: string | null;
  /** The device row the token belongs to — lets `mend logout` revoke it server-side. */
  readonly deviceId: string | null;
}

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly gitAuthMode: "ambient" | "mend-key" | "bridge";
  /** Optional: an older server predates the background-sessions cascade. */
  readonly backgroundSessions?: "inherit" | "on" | "off";
}

/** The account's dotfiles: repository knob + store snapshot (see `mend dotfiles`). */
interface DotfilesDto {
  readonly repository: {
    readonly url: string;
    readonly ref: string | null;
    readonly subdirectory: string | null;
    readonly bootstrap: boolean;
  } | null;
  readonly snapshot: {
    readonly sha: string;
    readonly source: string;
    readonly committedAt: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  } | null;
}

/** The machine's Mend deploy key — public half only; the server never sends more. */
interface GitKeyDto {
  readonly exists: boolean;
  readonly publicKey: string | null;
  readonly fingerprint: string | null;
}

interface WorktreeDto {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
}

interface SessionDto {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  readonly harness: string;
  readonly label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly status: string;
  readonly summary: string | null;
  /** False = settled without a conversation: nothing to resume, hidden by the dashboard. */
  readonly hasTranscript?: boolean | null;
  readonly createdAt: string;
}

/** The DB-cheap review facts the server decorates a project's sessions with. */
interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
  /** The session's current agent process; null before the first launch. */
  readonly currentAgent: AgentProcessLike | null;
}

/** The slice of /sessions/:id the CLI reads: the row plus the agent process it currently means. */
interface SessionDetailLiteDto {
  readonly session: SessionDto;
  readonly currentAgent: AgentProcessLike | null;
}

// `$XDG_CONFIG_HOME/mend`, default `~/.config/mend`; a pre-XDG `~/.mend` stays authoritative
// when it is the only one present (mirrors @mend/store's resolver — the CLI stays dependency-light).
const mendCliHome = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const preferred = path.join(
    xdg === undefined || xdg === "" ? path.join(os.homedir(), ".config") : xdg,
    "mend",
  );
  const legacy = path.join(os.homedir(), ".mend");
  return !fs.existsSync(preferred) && fs.existsSync(legacy) ? legacy : preferred;
};

const CONFIG_PATH = path.join(mendCliHome(), "cli.json");

const loadConfig = (): CliConfig => {
  let fileConfig: Partial<CliConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<CliConfig>;
    } catch {
      fail(`could not parse ${CONFIG_PATH}`);
    }
  }
  const configuredUrl = process.env["MEND_URL"] ?? fileConfig.url ?? null;
  return {
    url: configuredUrl ?? "http://localhost:3105",
    configuredUrl,
    token: process.env["MEND_TOKEN"] ?? fileConfig.token ?? null,
    deviceId: fileConfig.deviceId ?? null,
  };
};

const fail = (message: string): never => {
  process.stderr.write(`mend: ${message}\n`);
  process.exit(1);
};

const parseMendUrl = (value: string): URL => {
  try {
    return new URL(value);
  } catch {
    return fail(`"${value}" is not a valid Mend URL`);
  }
};

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY ? `[${code}m${text}[0m` : text;
const dim = paint("2");
const green = paint("32");
const amber = paint("33");
const cobalt = paint("34");
const say = (line: string) => process.stdout.write(`${line}\n`);
const detachKeyEnabled = process.env["MEND_DETACH_KEY"] !== "none";
const detachHint = () => (detachKeyEnabled ? ` · detach: ${dim("Ctrl+]")}` : "");

type HerdrAgent = "codex" | "claude" | "opencode";

const herdrAgentOf = (harness: string): HerdrAgent | null => {
  if (harness === "codex" || harness === "claude" || harness === "opencode") return harness;
  return null;
};

const hintHerdrAttachment = (harness: string): (() => void) => {
  const agent = herdrAgentOf(harness);
  if (process.env["HERDR_ENV"] !== "1" || agent === null) return () => undefined;

  // Herdr deliberately reads HERDR_AGENT from any member of the foreground
  // process group. A pipe-tethered child carries the hint while Mend owns the
  // pane, without claiming lifecycle authority: Herdr's native screen rules
  // still derive working, idle, and blocked from the bridged agent UI.
  const carrier = spawn(
    process.execPath,
    ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"],
    {
      env: { ...process.env, HERDR_AGENT: agent },
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    carrier.stdin?.end();
    carrier.kill();
  };
  process.once("exit", stop);
  return () => {
    process.off("exit", stop);
    stop();
  };
};

/** The raw server call — THROWS with a human message; the dashboard renders it. */
const request = async <T>(
  config: CliConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
): Promise<T> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
  let response: Response;
  try {
    response = await fetch(`${config.url}/api${route}`, {
      method,
      headers,
      // Spread, not `body: null` — fresh oxlint rejects a body key on GETs.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`cannot reach the Mend server at ${config.url} — is it running?`);
  }
  if (response.status === 401) {
    throw new Error(
      config.token === null
        ? `not signed in to ${config.url} — run: mend login`
        : `unauthorized at ${config.url} — the saved token was rejected; run: mend login`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `${method} ${route} → ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { readonly message?: string };
      message = parsed.message ?? message;
    } catch {
      // not JSON — keep the status line
    }
    throw new Error(message);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${route} returned invalid JSON from ${config.url}`);
  }
};

/** The same call for one-shot commands: any failure prints and exits. */
const api = async <T>(
  config: CliConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
): Promise<T> => {
  try {
    return await request<T>(config, method, route, body);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
};

/** The same call bound to one config — the dependency ./pair.ts takes. */
const boundApi =
  (config: CliConfig): ApiCall =>
  <T>(method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown): Promise<T> =>
    api<T>(config, method, route, body);

/** A live elapsed-time spinner around a slow await — provisioning is not a hang. */
const withSpinner = async <T>(label: string, work: Promise<T>): Promise<T> => {
  if (process.stdout.isTTY !== true) return work;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r  ${frames[frame % frames.length]} ${label} ${dim(`${seconds}s`)} `);
    frame += 1;
  }, 120);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    process.stdout.write("\r[2K");
  }
};

// ─── adopt ──────────────────────────────────────────────────────────────────

const adopt = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const nameFlag = args.indexOf("--name");
  const name =
    nameFlag !== -1 && args[nameFlag + 1] !== undefined ? String(args[nameFlag + 1]) : null;
  const authFlagIndex = args.indexOf("--auth");
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      (nameFlag === -1 || i !== nameFlag + 1) &&
      (authFlagIndex === -1 || i !== authFlagIndex + 1),
  );
  const source = positional[0] ?? gitOriginUrl(process.cwd());
  if (source === null) {
    return fail(
      "No Git URL was given and this repository has no origin. Run mend adopt <git-url>.",
    );
  }
  const sourceIssue = repositoryCloneUrlIssue(source);
  if (sourceIssue !== null) return fail(sourceIssue);
  // Derived defaults are normalized ("Mend" → "mend"); explicit --name is sent as typed.
  const projectName = name ?? normalizeProjectName(path.basename(source, ".git"));

  const auth =
    authFlagIndex !== -1 && args[authFlagIndex + 1] !== undefined
      ? String(args[authFlagIndex + 1])
      : null;
  if (auth !== null && auth !== "ambient" && auth !== "mend-key" && auth !== "bridge") {
    return fail(`--auth takes "ambient", "mend-key", or "bridge", not "${auth}"`);
  }

  const project = await api<ProjectDto>(config, "POST", "/projects", {
    name: projectName,
    source,
    ...(auth === null ? {} : { gitAuthMode: auth }),
  });
  say(`${green("✓")} adopted · ${project.name} · ${dim(project.storePath)}`);
  say(`${dim("  default branch")} ${project.defaultBranch}`);
  // Say which signer did the work — the clone already proved it answers.
  if (project.gitAuthMode === "mend-key") {
    say(`${dim("  git auth")} mend key ${dim("(your Mend key signed this clone)")}`);
  } else if (project.gitAuthMode === "bridge") {
    say(`${dim("  git auth")} bridge ${dim("(signed through the connected `mend keys share`)")}`);
  }
  say(
    `${dim("  sessions start with:")} mend codex ${dim("(from anywhere —")} --project ${project.name}${dim(")")}`,
  );
};

// ─── session launch ─────────────────────────────────────────────────────────

const findProject = async (config: CliConfig, explicit: string | null, adoptCwd = false) => {
  const projects = await api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects");
  if (explicit !== null) {
    const named = projects.find((p) => p.name === explicit);
    if (named === undefined) return fail(`no adopted project named "${explicit}"`);
    return named;
  }
  const cwd = process.cwd();
  const project = matchProjectByCwd(projects, cwdFacts(cwd));
  if (project !== undefined) return project;
  if (!adoptCwd) {
    return fail(
      `no adopted project matches ${cwd} — run "mend adopt" here first, or name one with --project`,
    );
  }
  // Launching from an un-adopted checkout may adopt its origin. The server never receives a
  // client filesystem path, even when client and server happen to be the same machine.
  const facts = cwdFacts(cwd);
  if (facts.repoRoot === null || facts.originUrl === null) {
    return fail(
      `${cwd} does not match an adopted project with a Git origin — run "mend adopt <git-url>" first`,
    );
  }
  const sourceIssue = repositoryCloneUrlIssue(facts.originUrl);
  if (sourceIssue !== null) return fail(sourceIssue);
  const adopted = await api<ProjectDto>(config, "POST", "/projects", {
    name: normalizeProjectName(path.basename(facts.repoRoot)),
    source: facts.originUrl,
  });
  say(`${green("✓")} adopted · ${adopted.name} · ${dim(adopted.storePath)}`);
  return adopted;
};

/**
 * Cascade for the launch lifecycle: per-launch flag → project stance → global
 * setting. Any read failure (an older server, a blip) stays background — a
 * network hiccup must never flip launch semantics to foreground.
 */
const resolvedBackgroundSessions = async (
  config: CliConfig,
  project: ProjectDto,
): Promise<boolean> => {
  if (project.backgroundSessions === "on") return true;
  if (project.backgroundSessions === "off") return false;
  try {
    const settings = await request<{ readonly backgroundSessions?: boolean }>(
      config,
      "GET",
      "/settings",
    );
    return settings.backgroundSessions !== false;
  } catch {
    return true;
  }
};

/** One-line TTY ask: the worktree's name comes first — it is the identity being created. */
const askWorktreeName = async (): Promise<string | null> => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  worktree name ${dim("(enter for auto)")}: `)).trim();
    return answer === "" ? null : normalizeProjectName(answer);
  } finally {
    rl.close();
  }
};

const launch = async (config: CliConfig, harness: string, args: ReadonlyArray<string>) => {
  const parsed = parseLaunchArgs(args);
  if (parsed.error !== null) return fail(parsed.error);
  const structured =
    parsed.prompt !== null ||
    parsed.model !== null ||
    parsed.effort !== null ||
    parsed.ask ||
    parsed.fast;
  if (harness === "run" && structured) {
    return fail(`mend run takes no prompt or harness flags · ${usageOf("run")}`);
  }
  if (harness === "run" && (parsed.detach || parsed.foreground)) {
    return fail(
      "mend run takes no lifecycle flags — it tails the record; Ctrl+C stops watching, not the command",
    );
  }
  const argv = harness === "run" ? parsed.custom : (HARNESS_COMMANDS[harness] ?? []);
  if (argv.length === 0) {
    return fail(harness === "run" ? usageOf("run") : `unknown harness ${harness}`);
  }

  const project = await findProject(config, parsed.project, true);
  // Say which project the cwd resolved to before anything is created — a
  // wrong guess should be visible here, not discovered in the tree later.
  say(
    `${green("✓")} project ${project.name} ${dim(`· ${project.defaultBranch}${parsed.project === null ? " · from cwd" : ""}`)}`,
  );
  // The worktree's name comes first, then the session details — it is the
  // identity every list leads with. `mend run` stays scriptable: flag only.
  // `--worktree` insists on joining: the name must already exist here.
  let worktreeName: string | null;
  if (parsed.worktree !== null) {
    const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`);
    const existing = detail.worktrees ?? [];
    if (detail.worktrees === undefined) {
      return fail("this server predates shared worktrees — use --name instead");
    }
    const match =
      existing.find((worktree) => worktree.name === parsed.worktree) ??
      (existing.filter((worktree) => worktree.name.startsWith(parsed.worktree ?? "")).length === 1
        ? existing.find((worktree) => worktree.name.startsWith(parsed.worktree ?? ""))
        : undefined);
    if (match === undefined) {
      const names = existing.map((worktree) => worktree.name).join(", ");
      return fail(
        `no worktree matches "${parsed.worktree}" in ${project.name}${names === "" ? "" : ` — have: ${names}`}`,
      );
    }
    worktreeName = match.name;
  } else {
    worktreeName = harness === "run" ? parsed.name : (parsed.name ?? (await askWorktreeName()));
  }
  // Say when the name joins an existing worktree — a join is a fact worth
  // stating before the session exists, not a surprise in the tree later.
  if (worktreeName !== null) {
    const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`).catch(
      () => null,
    );
    const joined = detail?.worktrees?.find((worktree) => worktree.name === worktreeName);
    if (joined !== undefined) {
      const members = (detail?.sessions ?? []).filter(
        (candidate) => candidate.worktreeId === joined.id,
      ).length;
      say(
        `${green("✓")} joins worktree ${joined.name} ${dim(`· ${members} session${members === 1 ? "" : "s"} · branch ${joined.branch}`)}`,
      );
    }
  }
  const lifecycle: "detach" | LifecycleMode =
    harness === "run"
      ? "background"
      : parsed.detach
        ? "detach"
        : parsed.foreground
          ? "foreground"
          : (await resolvedBackgroundSessions(config, project))
            ? "background"
            : "foreground";
  // Foreground holds from the moment the session exists: a signal between
  // create and attach stops it too. attachTty owns signals while attached.
  let createdSessionId: string | null = null;
  let attachOwnsSignals = false;
  const onLaunchSignal = () => {
    if (attachOwnsSignals) return;
    const id = createdSessionId;
    if (id === null) process.exit(1);
    void stopSessionQuickly(config, id).then((stopped) => process.exit(stopped ? 0 : 1));
  };
  if (lifecycle === "foreground") {
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
      process.on(signal, onLaunchSignal);
    }
  }
  const session = await api<SessionDto>(config, "POST", `/projects/${project.id}/sessions`, {
    harness,
    label: null,
    name: worktreeName,
    base: parsed.base,
  });
  createdSessionId = session.id;
  say(`${green("✓")} worktree ${session.worktree} ${dim(`· branch ${session.branch}`)}`);
  const baseWord = session.baseRef === null ? "" : `${session.baseRef} `;
  say(
    `${green("✓")} base ${baseWord}${dim(session.baseSha.slice(0, 12))} · session ${dim(session.id.slice(0, 8))}`,
  );
  say(`${cobalt("  watch")} · ${config.url}/sessions/${session.id}`);

  // Everything runs SUPERVISED (SDK 0.7.0): a workspace mounts the worktree,
  // a platform PTY runs argv, the record begins. Commands tail the record;
  // interactive harnesses get the full terminal bridge.
  if (harness === "run") {
    return supervisedRun(config, session, argv);
  }
  // A structured start sends no argv: the server composes the harness flags
  // (one shared mapping) and names the session from the prompt immediately.
  const launchBody = structured
    ? {
        ...(parsed.prompt === null ? {} : { prompt: parsed.prompt }),
        ...(parsed.model === null ? {} : { model: parsed.model }),
        ...(parsed.effort === null ? {} : { effort: parsed.effort }),
        ...(parsed.ask ? { permissionMode: "ask" } : {}),
        ...(parsed.fast ? { speed: "fast" } : {}),
      }
    : { argv };
  await withSpinner(
    "provisioning workspace — a first launch builds the harness image (can take minutes)…",
    api<SessionDto>(config, "POST", `/sessions/${session.id}/launch`, launchBody),
  );
  if (lifecycle === "detach") {
    say(`${green("✓ recording")} · running detached`);
    say(`${cobalt("  attach")} · mend attach ${session.id.slice(0, 8)}`);
    return;
  }
  say(`${green("✓ recording")} · workspace mounts the worktree${detachHint()}`);
  say("");
  attachOwnsSignals = true;
  await attachOrExit(config, session.id, session.harness, lifecycle);
  exitAfterSessionEnd(config, session.id);
};

// ─── the terminal bridge: raw stdin/stdout against the platform PTY ─────────

/**
 * Every way an attach can come back, told apart because the caller's answer
 * differs: `ended` is the server's end frame (the session settled); `dropped`
 * is a close without one (network, server restart — the session may still
 * run); `interrupted` is this CLI being told to die (SIGHUP/SIGINT/SIGTERM).
 */
type AttachOutcome = "detached" | "ended" | "dropped" | "interrupted" | "unavailable";

/**
 * Attach this terminal to the session's PTY through the Mend server over ONE
 * WebSocket: binary frames are PTY bytes both ways, text frames carry control
 * JSON (resize up, end down). Auth happens once at connect (?token=); after
 * that a keystroke is a frame on an open socket — nothing else on the path.
 * Ctrl+] detaches — the session keeps running and can be reattached from
 * anywhere. Resolves when the session settles or the user detaches; the
 * caller decides what each outcome means (commands exit, the dashboard
 * resumes). With `handleSignals`, a terminal-window close (SIGHUP) or kill
 * resolves `interrupted` through the same restore path instead of leaving
 * raw mode pushed — the handler never exits the process itself.
 */
const attachTty = async (
  config: CliConfig,
  sessionId: string,
  harness: string,
  from: bigint,
  processId?: string,
  options?: { readonly readOnly?: boolean; readonly handleSignals?: boolean },
): Promise<AttachOutcome> => {
  const url = parseMendUrl(`${config.url}/api/tty`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Process addressing reaches any PTY in the workspace (a shell); the
  // session form remains the agent's PTY.
  if (processId === undefined) url.searchParams.set("session", sessionId);
  else url.searchParams.set("process", processId);
  url.searchParams.set("from", from.toString());
  if (config.token !== null) url.searchParams.set("token", config.token);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect")), { once: true });
    });
  } catch {
    return "unavailable";
  }
  const stopHerdrHint = hintHerdrAttachment(harness);
  let finishAttachment: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finishAttachment = resolve;
  });
  const onClose = () => finishAttachment?.();
  if (ws.readyState === WebSocket.CLOSED) finishAttachment?.();
  else ws.addEventListener("close", onClose, { once: true });
  const sendResize = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        t: "resize",
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      }),
    );
  };
  const onWinch = () => sendResize();
  const rawTty = process.stdin.isTTY === true;
  let rawModeEnabled = false;
  let detached = false;
  let sawEnd = false;
  let interrupted = false;
  const onSignal = () => {
    // Resolve the attach instead of exiting: the shared `finally` restores raw
    // mode and closes the socket, then the caller decides what the signal means.
    interrupted = true;
    ws.close();
    finishAttachment?.();
  };
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
  let bracketedPaste = false;
  const onTtyFrame = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      const bytes = Buffer.from(event.data);
      bracketedPaste = trackBracketedPaste(bytes, bracketedPaste);
      process.stdout.write(bytes);
      return;
    }
    try {
      const frame: unknown = JSON.parse(event.data);
      if (typeof frame !== "object" || frame === null || !("t" in frame) || frame.t !== "end") {
        return;
      }
      // Session lifecycle is authoritative. Start detaching immediately instead
      // of holding the user's terminal for the later close handshake and Mend's
      // settle/checkpoint/harvest work.
      sawEnd = true;
      ws.close();
      finishAttachment?.();
    } catch {
      // Unknown text control frame — ignore.
    }
  };
  const onKeys = (data: Buffer) => {
    if (detachKeyEnabled && isDetachChunk(data)) {
      // Ctrl+] — detach, leave the session running. Matched in both its
      // encodings: the inner TUI may have switched the user's terminal onto
      // the kitty keyboard protocol, where the key arrives as CSI-u.
      detached = true;
      ws.close();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (isPasteChunk(data)) {
      // Ctrl+V — the agent's own clipboard is empty (the workspace has no
      // display), so an image on THIS machine's clipboard goes up to Mend and
      // its workspace path is pasted instead; codex and claude read the path.
      // No image, or no way to ask: the keystroke goes through untouched.
      void pasteClipboardImage(data);
      return;
    }
    // Copy into a plain ArrayBuffer (WebSocket.send rejects pooled Buffer views).
    ws.send(new Uint8Array(data).buffer);
  };
  const forward = (bytes: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(bytes).buffer);
  };
  const pasteClipboardImage = async (keystroke: Buffer): Promise<void> => {
    const image = await readClipboardImage();
    if (image === null) {
      forward(keystroke);
      return;
    }
    try {
      const stored = await request<{ readonly path: string }>(
        config,
        "POST",
        `/sessions/${sessionId}/images`,
        { contentsBase64: image.bytes.toString("base64") },
      );
      forward(pasteBytes(stored.path, bracketedPaste));
    } catch {
      // The TUI owns the screen; a bell is the only honest signal left.
      process.stdout.write("\x07");
    }
  };
  try {
    sendResize();
    process.stdout.on("resize", onWinch);
    if (options?.handleSignals === true) for (const signal of signals) process.on(signal, onSignal);
    // Read-only (logs): never forward stdin — Ctrl+C exits the CLI, the
    // socket drops, and the process inside keeps running untouched.
    if (options?.readOnly !== true) {
      if (rawTty) {
        process.stdin.setRawMode(true);
        rawModeEnabled = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onKeys);
    }
    ws.addEventListener("message", onTtyFrame);
    await finished;
    return detached ? "detached" : interrupted ? "interrupted" : sawEnd ? "ended" : "dropped";
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    process.stdin.off("data", onKeys);
    process.stdout.off("resize", onWinch);
    ws.removeEventListener("message", onTtyFrame);
    ws.removeEventListener("close", onClose);
    if (rawModeEnabled) process.stdin.setRawMode(false);
    if (options?.readOnly !== true && process.stdout.isTTY === true) {
      // The inner TUI's terminal modes leaked onto OUR terminal through the
      // byte bridge — kitty keyboard protocol, bracketed paste, mouse
      // reporting, alternate screen, hidden cursor. The TUI keeps running
      // remotely; the local terminal must come back to shell sanity, or every
      // keystroke after a detach arrives as CSI-u junk. A reattach replays
      // the session from 0, which re-establishes whatever the TUI had set.
      process.stdout.write(
        "\x1b[<u\x1b[=0;1u" + // pop the kitty keyboard stack, then force flags 0
          "\x1b[?2004l" + // bracketed paste off
          "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse reporting off
          "\x1b[?1049l" + // leave the alternate screen (no-op when already left)
          "\x1b[?25h", // show the cursor
      );
    }
    process.stdin.pause();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    stopHerdrHint();
  }
};

/**
 * Which lifecycle the launching CLI enforces. Background (the default): every
 * way this CLI goes away leaves the session running. Foreground: the session
 * stops when this CLI exits for any reason other than the explicit detach key.
 */
type LifecycleMode = "background" | "foreground";

/**
 * Best-effort stop under a signal's short grace window — a SIGHUP handler
 * cannot afford the ordinary retry path. True when the server accepted.
 */
const stopSessionQuickly = async (config: CliConfig, sessionId: string): Promise<boolean> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
  try {
    const response = await fetch(`${config.url}/api/sessions/${sessionId}/stop`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/** Foreground exit: stop the session, or say honestly that it may still run. */
const stopAndExit = async (config: CliConfig, sessionId: string): Promise<never> => {
  const id8 = sessionId.slice(0, 8);
  if (await stopSessionQuickly(config, sessionId)) {
    say(`${green("✓")} stopped · ${id8}`);
    say(`${cobalt("  review")} · ${config.url}/sessions/${sessionId}`);
    process.exit(0);
  }
  say(`${amber("could not stop")} — the session may still run · mend stop ${id8}`);
  process.exit(1);
};

/**
 * How every one-shot command handles an attach outcome: detach says so and
 * always leaves the session running; a signal or a dropped socket answers to
 * the lifecycle mode; a settled session returns so the caller prints its facts.
 */
const finishAttach = async (
  config: CliConfig,
  sessionId: string,
  outcome: AttachOutcome,
  mode: LifecycleMode = "background",
): Promise<void> => {
  const id8 = sessionId.slice(0, 8);
  if (outcome === "unavailable") {
    return fail(`tty attach unavailable: could not connect to ${config.url}`);
  }
  if (outcome === "detached") {
    say("");
    say(`${amber("detached")} — the session keeps running; reattach: mend attach ${id8}`);
    process.exit(0);
  }
  if (outcome === "interrupted") {
    say("");
    if (mode === "foreground") return stopAndExit(config, sessionId);
    say(`${amber("detached")} — the session keeps running; reattach: mend attach ${id8}`);
    process.exit(0);
  }
  if (outcome === "dropped") {
    say("");
    if (mode === "foreground") {
      // The drop may be the server settling the session — verify before stopping.
      let live: boolean;
      try {
        const detail = await request<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`);
        live = agentIsLive(detail.session, detail.currentAgent);
      } catch {
        say(`${amber("could not stop")} — the session may still run · mend stop ${id8}`);
        process.exit(1);
      }
      if (!live) return; // settled as the socket closed — the caller prints the end facts
      return stopAndExit(config, sessionId);
    }
    say(`${amber("disconnected")} — the session keeps running; reattach: mend attach ${id8}`);
    process.exit(0);
  }
};

const attachOrExit = async (
  config: CliConfig,
  sessionId: string,
  harness: string,
  mode: LifecycleMode = "background",
) =>
  finishAttach(
    config,
    sessionId,
    await attachTty(config, sessionId, harness, 0n, undefined, { handleSignals: true }),
    mode,
  );

/** Return terminal control as soon as the terminal reports the observed end. */
const exitAfterSessionEnd = (config: CliConfig, sessionId: string): never => {
  say("");
  say(`${green("✓")} session ended`);
  say(`${cobalt("  review")} · ${config.url}/sessions/${sessionId}`);
  process.exit(0);
};

/** Reattach a terminal to a running session (full scrollback replay, then live). */
const attach = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const prefix = args.find((a) => !a.startsWith("--"));
  // No id: the picker IS the selection surface (the resolution `mend shell`
  // already uses), so attaching never demands an id the user must go look up.
  if (prefix === undefined) {
    const picked = await resolveLiveSession(config, undefined, "attach");
    return attachPicked(config, picked);
  }
  const sessions = await api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions");
  const match = sessions.find((s) => s.id.startsWith(prefix));
  if (match === undefined) return fail(`no active session matches "${prefix}"`);
  return attachPicked(config, match);
};

/** Attach to one resolved session — the tail both `mend attach` paths share. */
const attachPicked = async (config: CliConfig, session: SessionDto): Promise<never> => {
  say(
    `${green("✓")} attaching to ${sessionDisplayName(session)} · ${session.harness} ${dim(session.id.slice(0, 8))}${detachHint()}`,
  );
  say("");
  const outcome = await attachTty(config, session.id, session.harness, 0n, undefined, {
    handleSignals: true,
  });
  // A live protocol agent (a phone pickup) has no PTY behind it — the attach
  // reports "unavailable" with nothing wrong. Take the session over: end the
  // protocol agent, resume the same conversation as a TUI, then attach to it.
  if (outcome === "unavailable") {
    const detail = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${session.id}`);
    if (
      detail.currentAgent?.kind === "agent-protocol" &&
      agentIsLive(detail.session, detail.currentAgent)
    ) {
      say(`${amber("taking over")} from the protocol session`);
      await withSpinner(
        "reopening as a terminal — same conversation…",
        api<SessionDto>(config, "POST", `/sessions/${session.id}/handoff`, { to: "pty" }),
      );
      say("");
      await attachOrExit(config, session.id, session.harness);
      return exitAfterSessionEnd(config, session.id);
    }
  }
  await finishAttach(config, session.id, outcome);
  return exitAfterSessionEnd(config, session.id);
};

/**
 * Explicit stop — the one intent detaching never carries. Ends the agent; the
 * workspace harvests and closes; the record and review remain.
 */
const stopCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const all = args.includes("--all");
  const projectFlag = args.indexOf("--project");
  const projectName =
    projectFlag !== -1 && args[projectFlag + 1] !== undefined
      ? String(args[projectFlag + 1])
      : null;
  const prefix = args.find((arg, index) => !arg.startsWith("--") && index !== projectFlag + 1);
  // Neither an id nor --all: pick the session to close, the same resolution
  // `mend attach` uses. --all and --project keep their bulk meaning.
  if (!all && prefix === undefined && projectName === null) {
    const picked = await resolveLiveSession(config, undefined, "stop");
    await stopSessions(config, [picked], false);
    return;
  }
  if (!all && prefix === undefined) {
    return fail(usageOf("stop"));
  }
  const [sessions, projects] = await Promise.all([
    api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions"),
    api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects"),
  ]);
  let scoped = sessions;
  if (projectName !== null) {
    const project = projects.find((p) => p.name === projectName);
    if (project === undefined) return fail(`no project named "${projectName}"`);
    scoped = sessions.filter((s) => s.projectId === project.id);
  }
  let targets: ReadonlyArray<SessionDto>;
  if (all) {
    targets = scoped;
    if (targets.length === 0) {
      say("no active sessions");
      return;
    }
  } else {
    const matches = scoped.filter((s) => s.id.startsWith(prefix ?? ""));
    if (matches.length === 0) return fail(`no active session matches "${prefix}"`);
    if (matches.length > 1) {
      return fail(`session prefix "${prefix}" is ambiguous — use more of the id`);
    }
    targets = matches;
  }
  await stopSessions(config, targets, all);
};

/** Stop each target and print its record link — the tail every stop path shares. */
const stopSessions = async (
  config: CliConfig,
  targets: ReadonlyArray<SessionDto>,
  summarise: boolean,
): Promise<void> => {
  for (const session of targets) {
    await api<SessionDto>(config, "POST", `/sessions/${session.id}/stop`);
    say(
      `${green("✓")} stopped · ${session.harness} · ${dim(session.id.slice(0, 8))} · ${session.branch}`,
    );
    say(`${cobalt("  review")} · ${config.url}/sessions/${session.id}`);
  }
  if (summarise) {
    say(`${green("✓")} stopped ${targets.length} session${targets.length === 1 ? "" : "s"}`);
  }
};

// ─── shell: the second pane — a real shell in the session's workspace ───────

interface SessionProcessDto {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly label: string | null;
  readonly status: string;
}

/** Compact picker: numbered live sessions, one keystroke of typing. */
const pickSessionInteractively = async (
  rows: ReadonlyArray<{ readonly session: SessionDto; readonly projectName: string }>,
): Promise<SessionDto> => {
  say(dim("more than one live session — pick one:"));
  rows.forEach((row, index) => {
    say(
      `  ${index + 1}. ${row.session.harness.padEnd(8)} ${dim(row.session.id.slice(0, 8))}  ${row.projectName}  ${dim(row.session.branch)}  ${dim(row.session.status)}`,
    );
  });
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("  session #: ");
  rl.close();
  const chosen = rows[Number(answer.trim()) - 1];
  if (chosen === undefined) return fail(`"${answer.trim()}" is not one of the choices`);
  return chosen.session;
};

/**
 * The resolution order (docs/SESSION-SERVICES.md): an explicit id wins, then
 * the cwd's project narrows, one candidate is taken, several go to the
 * picker, and a non-interactive caller never gets a silent guess.
 */
const resolveLiveSession = async (
  config: CliConfig,
  prefix: string | undefined,
  command: string,
): Promise<SessionDto> => {
  const sessions = await api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions?retained=1");
  if (prefix !== undefined) {
    const matches = sessions.filter((s) => s.id.startsWith(prefix));
    if (matches.length === 0) return fail(`no live or retained session matches "${prefix}"`);
    const exact = matches[0];
    if (matches.length > 1 || exact === undefined) {
      return fail(`session prefix "${prefix}" is ambiguous — use more of the id`);
    }
    return exact;
  }
  const projects = await api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects");
  const project = matchProjectByCwd(projects, cwdFacts(process.cwd()));
  const candidates =
    project === undefined ? sessions : sessions.filter((s) => s.projectId === project.id);
  const only = candidates[0];
  if (only === undefined) {
    return fail("no live or retained session — start one with mend codex|claude|opencode");
  }
  if (candidates.length === 1) return only;
  if (process.stdin.isTTY !== true) {
    return fail(`several live sessions — name one: mend ${command} <session-id-prefix>`);
  }
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  return pickSessionInteractively(
    candidates.map((session) => ({
      session,
      projectName: nameById.get(session.projectId) ?? session.projectId.slice(0, 8),
    })),
  );
};

/**
 * A real interactive shell in the session's CURRENT workspace — same
 * /workspace/repo the agent is editing, same dependencies, same network. Not
 * a shell in the host checkout. The shell holds a workspace lease, so the
 * container survives the agent settling while the shell lives.
 */
const shellCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const prefix = args.find((a) => !a.startsWith("--"));
  const session = await resolveLiveSession(config, prefix, "shell");
  say(
    `${green("✓")} shell in ${session.harness} session ${dim(session.id.slice(0, 8))} · ${dim(session.branch)}${detachHint()}`,
  );
  const shellProcess = await withSpinner(
    "opening a shell in the session workspace…",
    api<SessionProcessDto>(config, "POST", `/sessions/${session.id}/shell`),
  );
  say("");
  const outcome = await attachTty(config, session.id, "shell", 0n, shellProcess.id, {
    handleSignals: true,
  });
  if (outcome === "unavailable") {
    return fail(`tty attach unavailable: could not connect to ${config.url}`);
  }
  say("");
  if (outcome === "detached" || outcome === "interrupted" || outcome === "dropped") {
    say(`${amber("detached")} — the shell keeps running and holds the workspace open`);
    process.exit(0);
  }
  say(`${green("✓")} shell ended`);
  process.exit(0);
};

// ─── services: reachable ports, everywhere the session is ───────────────────

interface ServiceRecipeDto {
  readonly name: string;
  readonly command: string | null;
  readonly port: number;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
  readonly shadowedBy: "file" | "project" | null;
}

interface ServiceEndpointDto {
  readonly authority: string;
  readonly hostPort: number;
  readonly scope: "loopback" | "private";
  readonly browserUrl: string | null;
  readonly mendAuthentication: "none";
}

interface ServiceViewDto {
  readonly service: {
    readonly id: string;
    readonly sessionId: string;
    readonly name: string;
    readonly workspacePort: number;
    readonly transport: "tcp" | "udp";
    readonly currentAttemptId: string | null;
  };
  readonly attempts: ReadonlyArray<{
    readonly id: string;
    readonly argv: ReadonlyArray<string>;
    readonly status: string;
    readonly exitedAt: string | null;
    readonly sealantSessionId: string | null;
  }>;
  readonly currentForward: {
    readonly id: string;
    readonly hostPort: number | null;
    readonly state: "binding" | "bound" | "closed" | "failed";
  } | null;
  readonly latestObservation: {
    readonly forwardId: string;
    readonly state: "reachable" | "unreachable";
  } | null;
  readonly workspaceExpiresAt: string | null;
  readonly workspaceTtlRenewedAt: string | null;
  readonly workspaceTtlRenewalFailedAt: string | null;
  readonly workspaceTtlRenewalError: string | null;
  readonly endpoints: ReadonlyArray<ServiceEndpointDto>;
}

interface ProcessLogPageDto {
  readonly processId: string;
  readonly sealantSessionId: string;
  readonly sealantRunId: string | null;
  readonly requestedFrom: string;
  readonly firstSequence: string | null;
  readonly lastSequence: string | null;
  readonly nextFrom: string;
  readonly status: "exited" | "failed" | "running" | "starting";
  readonly chunks: ReadonlyArray<{
    readonly sequence: string;
    readonly dataBase64: string;
  }>;
  readonly telemetryLoss: "unknown";
  readonly telemetryNote: string;
}

interface ServiceDto {
  readonly id: string;
  readonly processId: string | null;
  readonly sessionId: string;
  readonly label: string;
  readonly status: string;
  readonly workspacePort: number;
  readonly hostPort: number | null;
  readonly authority: string | null;
  readonly browserUrl: string | null;
  readonly exposureScope: "loopback" | "private" | null;
  readonly mendAuthentication: "none" | null;
  readonly protocol: "tcp" | "udp";
  readonly sealantSessionId: string | null;
  readonly attemptExitedAt: string | null;
  readonly argv: ReadonlyArray<string>;
  readonly workspaceExpiresAt: string | null;
  readonly workspaceTtlRenewedAt: string | null;
  readonly workspaceTtlRenewalFailedAt: string | null;
  readonly workspaceTtlRenewalError: string | null;
}

const flattenService = (view: ServiceViewDto): ServiceDto => {
  const attempt =
    view.service.currentAttemptId === null
      ? null
      : (view.attempts.find((candidate) => candidate.id === view.service.currentAttemptId) ?? null);
  const observation =
    view.currentForward !== null && view.latestObservation?.forwardId === view.currentForward.id
      ? view.latestObservation
      : null;
  const endpoint =
    view.endpoints.find((candidate) => candidate.scope === "private") ?? view.endpoints[0] ?? null;
  const browserUrl =
    view.endpoints.find((candidate) => candidate.browserUrl !== null)?.browserUrl ?? null;
  return {
    id: view.service.id,
    processId: attempt?.id ?? null,
    sessionId: view.service.sessionId,
    label: view.service.name,
    status: observation?.state ?? view.currentForward?.state ?? attempt?.status ?? "stopped",
    workspacePort: view.service.workspacePort,
    hostPort: endpoint?.hostPort ?? null,
    authority: endpoint?.authority ?? null,
    browserUrl,
    exposureScope: endpoint?.scope ?? null,
    mendAuthentication: endpoint?.mendAuthentication ?? null,
    protocol: view.service.transport,
    sealantSessionId: attempt?.sealantSessionId ?? null,
    attemptExitedAt: attempt?.exitedAt ?? null,
    argv: attempt?.argv ?? [],
    workspaceExpiresAt: view.workspaceExpiresAt,
    workspaceTtlRenewedAt: view.workspaceTtlRenewedAt,
    workspaceTtlRenewalFailedAt: view.workspaceTtlRenewalFailedAt,
    workspaceTtlRenewalError: view.workspaceTtlRenewalError,
  };
};

const fetchServiceViews = (config: CliConfig, all = false) =>
  api<ReadonlyArray<ServiceViewDto>>(config, "GET", `/services${all ? "?all=1" : ""}`);

const fetchServices = async (config: CliConfig, all = false): Promise<ReadonlyArray<ServiceDto>> =>
  (await fetchServiceViews(config, all)).map(flattenService);

const mutateService = async (
  config: CliConfig,
  method: "POST",
  endpointPath: string,
  body?: unknown,
): Promise<ServiceDto> =>
  flattenService(await api<ServiceViewDto>(config, method, endpointPath, body));

/** Is the configured server this machine? Only then is its bind authority OUR address. */
const serverIsLocal = (config: CliConfig): boolean => {
  const host = parseMendUrl(config.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
};

const serviceUrl = (service: ServiceDto): string =>
  service.browserUrl ??
  (service.authority === null
    ? "unbound"
    : `${service.authority}${service.protocol === "udp" ? " (udp)" : ""}`);

/**
 * Where THIS terminal reaches the Service. On a local server the bind
 * authority is our own address; on a remote one it is an address on the
 * server's network — the honest client path is the authenticated tunnel.
 */
const printServiceAccess = (config: CliConfig, service: ServiceDto, tunneling = false): void => {
  const gate = "no Mend sign-in on this port — network reach is the only gate";
  if (serverIsLocal(config)) {
    if (service.authority !== null) say(`  ${cobalt(serviceUrl(service))}  ${dim(gate)}`);
    return;
  }
  if (service.protocol === "udp") {
    // No tunnel for UDP: the server-side listener is the only path.
    if (service.authority !== null) {
      say(`  ${cobalt(serviceUrl(service))} ${dim(`on the server's network · ${gate}`)}`);
    }
    return;
  }
  if (!tunneling) {
    // Suggest the tunnel only when this command is not about to open it.
    const local = service.hostPort ?? service.workspacePort;
    say(
      `  ${cobalt(`mend service connect ${service.label}`)} ${dim(`→ 127.0.0.1:${local} on this machine, authenticated as you`)}`,
    );
  }
  if (service.authority !== null) {
    say(`  ${dim(`server-side listener ${service.authority} · ${gate}`)}`);
  }
};

const printWorkspaceTtlFailure = (service: ServiceDto): void => {
  if (service.workspaceTtlRenewalError === null) return;
  say(amber(`  workspace TTL renewal failed · ${service.workspaceTtlRenewalError}`));
  say(
    dim(
      `  last renewed ${service.workspaceTtlRenewedAt ?? "unknown"} · known expiry ${service.workspaceExpiresAt ?? "unknown"} · failed ${service.workspaceTtlRenewalFailedAt ?? "unknown"}`,
    ),
  );
};

const printServiceEndpoint = (config: CliConfig, service: ServiceDto, tunneling = false): void => {
  printServiceAccess(config, service, tunneling);
  printWorkspaceTtlFailure(service);
};

const printService = (config: CliConfig, service: ServiceDto) => {
  const status = service.status === "reachable" ? green(service.status) : amber(service.status);
  const port = `:${service.workspacePort ?? "?"}${service.protocol === "udp" ? "/udp" : ""}`;
  // Pad around the colored status by its bare length — ANSI codes break padEnd.
  const statusPad = " ".repeat(Math.max(1, 12 - service.status.length));
  say(
    `${(service.label ?? service.id.slice(0, 8)).padEnd(14)} ${status}${statusPad}${dim(port.padEnd(7))} ${dim(service.id.slice(0, 8))}`,
  );
  printServiceAccess(config, service);
  printWorkspaceTtlFailure(service);
};

/**
 * Adopt an already-listening workspace port as a Service: Mend binds a host
 * port on its private interfaces and pumps every connection into the
 * session's workspace. No supervision — reachability is the observation.
 */
const serviceAdd = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const nameFlag = args.indexOf("--name");
  const name =
    nameFlag !== -1 && args[nameFlag + 1] !== undefined ? String(args[nameFlag + 1]) : null;
  const protocol = args.includes("--udp") ? ("udp" as const) : ("tcp" as const);
  const http = args.includes("--http");
  const https = args.includes("--https");
  if (http && https) return fail("Choose either --http or --https, not both.");
  const browserScheme = https ? ("https" as const) : http ? ("http" as const) : null;
  if (protocol === "udp" && browserScheme !== null) {
    return fail("UDP Services cannot use --http or --https");
  }
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && (nameFlag === -1 || i !== nameFlag + 1),
  );
  const portRaw = positional.find((a) => /^\d+$/.test(a));
  if (portRaw === undefined) {
    return fail(usageOf("service add"));
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail(`"${portRaw}" is not a port`);
  }
  const prefix = positional.find((a) => a !== portRaw);
  const session = await resolveLiveSession(config, prefix, "service add");

  const service = await mutateService(config, "POST", `/sessions/${session.id}/services`, {
    port,
    name,
    protocol,
    browserScheme,
  });
  say(`${green("✓")} Service ${service.label ?? ""} · ${service.status}`);
  printServiceEndpoint(config, service);
  if (protocol === "udp") {
    say(dim(`  udp — a reply is the only reachability signal; silence just relays`));
  } else if (service.status !== "reachable") {
    say(dim(`  nothing answered on :${port} yet — the URL goes live when something listens`));
  }
};

const serviceList = async (config: CliConfig) => {
  const services = await fetchServices(config);
  if (services.length === 0) {
    say(dim("no live services — mend service add <port> adopts a listening one"));
    return;
  }
  for (const service of services) printService(config, service);
};

const serviceStop = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const needle = args.find((a) => !a.startsWith("--"));
  if (needle === undefined) return fail(usageOf("service stop"));
  const services = await fetchServices(config);
  const matches = services.filter(
    (service) => service.label === needle || service.id.startsWith(needle),
  );
  if (matches.length === 0) return fail(`no live service matches "${needle}"`);
  const match = matches[0];
  if (matches.length > 1 || match === undefined) {
    return fail(`"${needle}" is ambiguous — use more of the id`);
  }
  const stoppedService = await mutateService(config, "POST", `/services/${match.id}/stop`);
  say(`${green("✓")} stopped · ${stoppedService.label ?? stoppedService.id.slice(0, 8)}`);
};

const findLiveService = async (config: CliConfig, needle: string): Promise<ServiceDto> => {
  const services = await fetchServices(config);
  const matches = services.filter(
    (service) => service.label === needle || service.id.startsWith(needle),
  );
  if (matches.length === 0) return fail(`no live service matches "${needle}"`);
  const match = matches[0];
  if (matches.length > 1 || match === undefined) {
    return fail(`"${needle}" is ambiguous — use more of the id`);
  }
  return match;
};

/**
 * Start and supervise a Service: the command runs as its own PTY process in
 * the session's workspace (own record = its logs), Mend waits for the
 * declared port to answer, then exposes it like any Service. The command
 * never occupies the agent's terminal or a tool call.
 */
/**
 * The point of starting a Service is reaching it. On a local server the
 * bound authority already answers on this machine, so start-and-return is
 * complete. On a remote server nothing local answers — stay attached and
 * tunnel the port here, exactly what `mend service connect` would do next.
 * Ctrl-C closes the tunnel, never the Service.
 */
const willAutoConnect = (config: CliConfig, service: ServiceDto, optOut: boolean): boolean =>
  !optOut && !serverIsLocal(config) && service.protocol !== "udp";

const autoConnect = async (config: CliConfig, service: ServiceDto): Promise<void> => {
  say(dim("  remote server — tunneling the port here · Ctrl-C stops the tunnel, not the Service"));
  await tunnelServices(config, [service], null);
};

const serviceRun = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const dashdash = args.indexOf("--");
  const usage = usageOf("service run");
  // No explicit command = a DECLARED Service: resolve the name against the
  // session worktree's mend.toml and start (or adopt) its recipe.
  if (dashdash === -1) {
    const positionals = args.filter((a) => !a.startsWith("--"));
    const name = positionals.at(-1);
    if (name === undefined) return fail(usage);
    const prefix = positionals.length > 1 ? positionals[0] : undefined;
    const session = await resolveLiveSession(config, prefix, "service run");
    const recipes = await api<ReadonlyArray<ServiceRecipeDto>>(
      config,
      "GET",
      `/sessions/${session.id}/recipes`,
    );
    const recipe = recipes.find((entry) => entry.name === name);
    if (recipe === undefined) {
      const known = recipes.map((entry) => entry.name).join(", ");
      return fail(
        recipes.length === 0
          ? `no mend.toml recipes in this worktree — declare [service.${name}] first`
          : `no recipe named "${name}" — declared: ${known}`,
      );
    }
    const service = await withSpinner(
      recipe.command === null
        ? `adopting ${recipe.name} on :${recipe.port}…`
        : recipe.protocol === "udp"
          ? `starting ${recipe.name} (udp :${recipe.port})…`
          : `starting ${recipe.name} — waiting for :${recipe.port} to answer…`,
      mutateService(config, "POST", `/sessions/${session.id}/services/recipe`, {
        name: recipe.name,
      }),
    );
    const tunneling = willAutoConnect(config, service, args.includes("--no-connect"));
    say(`${green("✓")} Service ${service.label ?? ""} · ${service.status}`);
    printServiceEndpoint(config, service, tunneling);
    say(dim(`  logs: mend service logs ${service.label ?? service.id.slice(0, 8)}`));
    if (tunneling) await autoConnect(config, service);
    return;
  }
  const argv = args.slice(dashdash + 1);
  if (argv.length === 0) return fail(usage);
  const head = args.slice(0, dashdash);
  const portFlag = head.indexOf("--port");
  const port = portFlag === -1 ? Number.NaN : Number(head[portFlag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(usage);
  const nameFlag = head.indexOf("--name");
  const name =
    nameFlag !== -1 && head[nameFlag + 1] !== undefined ? String(head[nameFlag + 1]) : null;
  const protocol = head.includes("--udp") ? ("udp" as const) : ("tcp" as const);
  const http = head.includes("--http");
  const https = head.includes("--https");
  if (http && https) return fail(usage);
  const browserScheme = https ? ("https" as const) : http ? ("http" as const) : null;
  if (protocol === "udp" && browserScheme !== null) return fail(usage);
  const prefix = head.find(
    (a, i) => !a.startsWith("--") && i !== portFlag + 1 && i !== nameFlag + 1,
  );
  const session = await resolveLiveSession(config, prefix, "service run");

  const service = await withSpinner(
    protocol === "udp"
      ? `starting ${name ?? argv[0]} (udp :${port})…`
      : `starting ${name ?? argv[0]} — waiting for :${port} to answer…`,
    mutateService(config, "POST", `/sessions/${session.id}/services/run`, {
      argv,
      port,
      name,
      protocol,
      browserScheme,
    }),
  );
  const tunneling = willAutoConnect(config, service, head.includes("--no-connect"));
  say(`${green("✓")} Service ${service.label ?? ""} · ${service.status}`);
  printServiceEndpoint(config, service, tunneling);
  say(dim(`  logs: mend service logs ${service.label ?? service.id.slice(0, 8)}`));
  if (tunneling) await autoConnect(config, service);
};

/** Read sequence-addressed PTY output without attaching an input-capable terminal. */
const serviceLogs = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const fromFlag = args.indexOf("--from");
  const from = fromFlag === -1 ? "0" : args[fromFlag + 1];
  const needle = args.find(
    (argument, index) => !argument.startsWith("--") && index !== fromFlag + 1,
  );
  if (needle === undefined || from === undefined || !/^(0|[1-9]\d*)$/.test(from)) {
    return fail(usageOf("service logs"));
  }
  const everything = await fetchServiceViews(config, true);
  const matches = everything.filter(
    (view) =>
      view.service.name === needle ||
      view.service.id.startsWith(needle) ||
      view.attempts.some((attempt) => attempt.id.startsWith(needle)),
  );
  if (matches.length === 0) return fail(`no service matches "${needle}"`);
  const view =
    matches.find((candidate) => {
      const current =
        candidate.service.currentAttemptId === null
          ? null
          : candidate.attempts.find((attempt) => attempt.id === candidate.service.currentAttemptId);
      return current !== null && current !== undefined && current.exitedAt === null;
    }) ?? matches[0];
  if (view === undefined) return fail(`no service matches "${needle}"`);
  const currentAttempt =
    view.service.currentAttemptId === null
      ? null
      : (view.attempts.find((candidate) => candidate.id === view.service.currentAttemptId) ?? null);
  const attempt =
    view.attempts.find((candidate) => candidate.id.startsWith(needle)) ??
    currentAttempt ??
    view.attempts.findLast((candidate) => candidate.sealantSessionId !== null) ??
    null;
  if (attempt?.sealantSessionId === null || attempt === null) {
    return fail(
      `"${needle}" is an adopted port — no process of Mend's, no logs. mend service run supervises.`,
    );
  }
  const label = view.service.name;
  say(
    dim(
      attempt.exitedAt === null
        ? `following ${label} from sequence ${from} — Ctrl+C detaches, the Service keeps running`
        : `${label} · ${attempt.status} — recorded output from sequence ${from}`,
    ),
  );
  say("");

  let cursor = from;
  let telemetryReported = false;
  for (;;) {
    const page = await api<ProcessLogPageDto>(
      config,
      "GET",
      `/processes/${attempt.id}/logs?from=${encodeURIComponent(cursor)}&limit=256`,
    );
    if (!telemetryReported) {
      say(dim(`telemetry loss: ${page.telemetryLoss} · ${page.telemetryNote}`));
      telemetryReported = true;
    }
    for (const chunk of page.chunks) {
      process.stdout.write(Buffer.from(chunk.dataBase64, "base64"));
    }
    const advanced = page.nextFrom !== cursor;
    cursor = page.nextFrom;
    const ended = page.status === "exited" || page.status === "failed";
    if (ended && !advanced) break;
    if (!advanced) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  say("");
  say(dim(`stream ended · next sequence ${cursor}`));
};

const serviceRestart = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const needle = args.find((a) => !a.startsWith("--"));
  if (needle === undefined) return fail(usageOf("service restart"));
  const service = await findLiveService(config, needle);
  const restarted = await withSpinner(
    `restarting ${service.label ?? service.id.slice(0, 8)}…`,
    mutateService(config, "POST", `/services/${service.id}/restart`),
  );
  say(`${green("✓")} restarted · ${restarted.status}`);
  printServiceEndpoint(config, restarted);
};

/**
 * Scaffold mend.toml from the project's own manifests. Static suggestion,
 * not detection: package.json scripts and compose port mappings become
 * recipe proposals the user confirms and commits. Nothing runs.
 */
const serviceInit = async (args: ReadonlyArray<string>) => {
  const root = gitTopLevel(process.cwd()) ?? process.cwd();
  const target = path.join(root, "mend.toml");
  if (fs.existsSync(target)) {
    return fail(`${target} already exists — edit it directly (init never merges)`);
  }
  const rootFiles = fs.readdirSync(root);
  const proposals: Array<ReturnType<typeof proposeFromCompose>[number]> = [];
  const readRoot = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
  if (rootFiles.includes("package.json")) {
    proposals.push(...proposeFromPackageJson(readRoot("package.json"), rootFiles));
  }
  // Monorepo sweep: every workspace package, named after its folder.
  const globs = workspaceGlobs(
    rootFiles.includes("pnpm-workspace.yaml") ? readRoot("pnpm-workspace.yaml") : null,
    rootFiles.includes("package.json") ? readRoot("package.json") : null,
  );
  for (const glob of globs) {
    const parent = glob.replace(/\/?\*+$/, "");
    const dirs = glob.endsWith("*")
      ? fs.existsSync(path.join(root, parent))
        ? fs.readdirSync(path.join(root, parent)).map((dir) => path.join(parent, dir))
        : []
      : [glob];
    for (const dir of dirs) {
      const manifest = path.join(root, dir, "package.json");
      if (!fs.existsSync(manifest)) continue;
      for (const proposal of proposeFromWorkspacePackage(
        path.basename(dir),
        fs.readFileSync(manifest, "utf8"),
        rootFiles,
      )) {
        if (!proposals.some((existing) => existing.name === proposal.name)) {
          proposals.push(proposal);
        }
      }
    }
  }
  // Every compose flavor in the root, aggregated; non-default files need -f.
  for (const composeName of rootFiles.filter(isComposeFile).toSorted()) {
    const isDefault = composeName === "compose.yaml" || composeName === "docker-compose.yml";
    for (const proposal of proposeFromCompose(readRoot(composeName))) {
      if (!proposals.some((existing) => existing.name === proposal.name)) {
        proposals.push({
          ...proposal,
          command: isDefault
            ? proposal.command
            : proposal.command.replace("docker compose ", `docker compose -f ${composeName} `),
          source: `${composeName}: ${proposal.source}`,
        });
      }
    }
  }
  if (proposals.length === 0) {
    return fail(
      "nothing to propose — no server-ish package.json script with a nameable port, no compose ports",
    );
  }
  const toml = renderMendToml(proposals);
  say(dim(`proposed ${target}:`));
  say("");
  process.stdout.write(toml);
  say("");
  if (!args.includes("--yes")) {
    if (process.stdin.isTTY !== true) {
      return fail("non-interactive — pass --yes to write the file");
    }
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("write it? [y/N] ");
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      say(dim("nothing written"));
      return;
    }
  }
  fs.writeFileSync(target, toml);
  say(`${green("✓")} wrote ${target} — commit it, then: mend service run ${proposals[0]?.name}`);
};

/**
 * The location-independent data plane for Services: bind each Service's port
 * on THIS machine's loopback and pump every accepted connection over one
 * authenticated WebSocket to the server, which dials the same workspace
 * forward the server-side listener uses. No ports are opened anywhere but
 * here, and every connection carries the caller's Mend auth. Blocks until
 * interrupted — the listeners keep the process alive.
 */
const tunnelServices = async (
  config: CliConfig,
  services: ReadonlyArray<ServiceDto>,
  portOverride: number | null,
): Promise<void> => {
  const tunnelUrl = (serviceId: string): URL => {
    const url = parseMendUrl(`${config.url}/api/service-tunnel`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("service", serviceId);
    if (config.token !== null) url.searchParams.set("token", config.token);
    return url;
  };

  for (const service of services) {
    const port = portOverride ?? service.hostPort ?? service.workspacePort;
    const server = net.createServer((socket) => {
      // Hold local bytes until the tunnel is open; loopback buffers are tiny.
      socket.pause();
      const ws = new WebSocket(tunnelUrl(service.id));
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => socket.resume(), { once: true });
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") return; // no text frames come down
        socket.write(Buffer.from(event.data as ArrayBuffer));
      });
      ws.addEventListener("close", () => socket.end(), { once: true });
      ws.addEventListener("error", () => socket.destroy(), { once: true });
      // Copy per chunk: the WS client wants an ArrayBuffer-backed view, and
      // Buffer pools share their backing store.
      socket.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
      socket.on("end", () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "eof" }));
      });
      socket.on("close", () => ws.close());
      socket.on("error", () => ws.close());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new Error(
            error.code === "EADDRINUSE"
              ? `127.0.0.1:${port} is already in use here — pick one with: mend service connect ${service.label} --port <n>`
              : error.message,
          ),
        );
      });
      server.listen(port, "127.0.0.1", () => resolve());
    }).catch((error: Error) => fail(error.message));
    say(
      `${green("●")} ${service.label ?? service.id.slice(0, 8)} → 127.0.0.1:${port} ${dim(`(tunnel to ${config.url})`)}`,
    );
  }
  say(dim("  connections are authenticated as you · Ctrl-C stops"));
  // The listeners keep the process alive until the user stops it.
  await new Promise(() => {});
};

/**
 * `mend service connect [name…] [--port <n>]`: the standalone entry to the
 * tunnel. The server's own listener binds the SERVER's interfaces
 * (`MEND_SERVICE_HOSTS`) — exactly right when the server is this machine,
 * unreachable when it is a Pod or a VPS; this brings the port here instead.
 */
const serviceConnect = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const portFlag = args.indexOf("--port");
  const portOverride = portFlag === -1 ? null : Number(args[portFlag + 1]);
  if (portOverride !== null && !Number.isInteger(portOverride)) {
    return fail("--port takes a port number");
  }
  const names = args.filter((a, i) => !a.startsWith("--") && i !== portFlag + 1);
  const live = (await fetchServices(config)).filter((s) => s.protocol === "tcp");
  const picked =
    names.length === 0
      ? live
      : live.filter((s) => names.some((n) => s.label === n || s.id.startsWith(n)));
  if (picked.length === 0) {
    return fail(
      names.length === 0
        ? "no live TCP services — mend service run starts one"
        : `no live TCP service matches "${names.join('", "')}"`,
    );
  }
  if (portOverride !== null && picked.length !== 1) {
    return fail("--port applies to exactly one service — name it");
  }
  await tunnelServices(config, picked, portOverride);
};

const serviceCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  switch (verb) {
    case "run":
      return serviceRun(config, rest);
    case "add":
      return serviceAdd(config, rest);
    case "init":
      return serviceInit(rest);
    case "connect":
      return serviceConnect(config, rest);
    case "list":
    case undefined:
      return serviceList(config);
    case "logs":
      return serviceLogs(config, rest);
    case "restart":
      return serviceRestart(config, rest);
    case "stop":
      return serviceStop(config, rest);
    default:
      // Sugar: `mend service mysql` reads as `mend service run mysql` — a
      // bare word that isn't a verb is a recipe name. A miss still explains
      // itself (declared recipes are listed in the failure).
      return serviceRun(config, [verb, ...rest]);
  }
};

// ─── connect / accounts: the user's own provider credentials ────────────────

type ConnectedAccountProvider = "claude" | "codex" | "github";

interface ConnectedAccountDto {
  readonly id: string;
  readonly provider: ConnectedAccountProvider;
  readonly name: string;
  readonly kind: string;
  readonly status: "active" | "invalid" | "archived";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

interface SealantIdentityDto {
  readonly sealantUserId: string;
  readonly accounts: ReadonlyArray<ConnectedAccountDto>;
}

const isProvider = (value: string | undefined): value is ConnectedAccountProvider =>
  value === "claude" || value === "codex" || value === "github";

const readIfExists = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

/** The credential as THIS machine holds it — the same files the agent CLIs wrote at login. */
const localCredential = (provider: ConnectedAccountProvider): string | null => {
  const home = os.homedir();
  switch (provider) {
    case "codex":
      return readIfExists(
        path.join(process.env["CODEX_HOME"] ?? path.join(home, ".codex"), "auth.json"),
      );
    case "claude":
      return readIfExists(
        path.join(
          process.env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude"),
          ".credentials.json",
        ),
      );
    case "github": {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      const token = result.status === 0 ? result.stdout.trim() : "";
      return token === "" ? null : token;
    }
  }
};

const accountLine = (account: ConnectedAccountDto): string => {
  const meta = account.metadata;
  const pick = (key: string) => (typeof meta[key] === "string" ? String(meta[key]) : null);
  const identity = pick("login") ?? pick("email") ?? pick("accountEmail") ?? pick("accountId");
  const suffix = pick("tokenSuffix");
  const facts = [
    account.status === "active" ? "connected" : account.status,
    identity,
    suffix === null ? null : `…${suffix}`,
    `since ${account.connectedAt.slice(0, 10)}`,
  ].filter((fact): fact is string => fact !== null);
  return `${account.provider.padEnd(8)} ${facts.join(" · ")}`;
};

/**
 * `mend accounts`: the signed-in user's own connected accounts on the platform — each person's
 * subscriptions, under their own Sealant user (docs/SEALANT-IDENTITY.md).
 */
const accountsCommand = async (config: CliConfig) => {
  const identity = await api<SealantIdentityDto>(config, "GET", "/me/sealant");
  process.stdout.write(`platform user ${identity.sealantUserId}\n`);
  const providers: ReadonlyArray<ConnectedAccountProvider> = ["claude", "codex", "github"];
  for (const provider of providers) {
    const account =
      identity.accounts.find((row) => row.provider === provider && row.name === "default") ??
      identity.accounts.find((row) => row.provider === provider);
    process.stdout.write(
      `  ${account === undefined ? `${provider.padEnd(8)} not connected` : accountLine(account)}\n`,
    );
  }
};

/**
 * `mend connect claude|codex|github [--from-stdin] [--remove]`: send THIS machine's credential
 * for the provider to the platform under your own user. The file the provider's CLI wrote at
 * login is read verbatim (codex: ~/.codex/auth.json; claude: ~/.claude/.credentials.json;
 * github: `gh auth token`); `--from-stdin` takes a pasted token or file instead. Mend forwards
 * it once and stores nothing.
 */
const connectCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [providerArg, ...flags] = args;
  if (!isProvider(providerArg)) {
    return fail(usageOf("connect"));
  }
  const provider = providerArg;
  if (flags.includes("--remove")) {
    const identity = await api<SealantIdentityDto>(config, "GET", "/me/sealant");
    const account = identity.accounts.find((row) => row.provider === provider);
    if (account === undefined) return fail(`${provider}: nothing connected`);
    await api<ConnectedAccountDto>(config, "DELETE", `/me/sealant/accounts/${account.id}`);
    process.stdout.write(`${provider}: disconnected\n`);
    return;
  }
  let secret: string | null;
  if (flags.includes("--from-stdin")) {
    secret = fs.readFileSync(0, "utf8").trim();
    if (secret === "") return fail("nothing on stdin");
  } else {
    secret = localCredential(provider);
    if (secret === null) {
      const where =
        provider === "github"
          ? "`gh auth login` first, or pipe a token: gh auth token | mend connect github --from-stdin"
          : provider === "codex"
            ? "`codex login` first, or: mend connect codex --from-stdin < auth.json"
            : "`claude setup-token` then: mend connect claude --from-stdin";
      return fail(`${provider}: no credential on this machine — ${where}`);
    }
  }
  const account = await withSpinner(
    `connecting ${provider}`,
    api<ConnectedAccountDto>(config, "POST", "/me/sealant/accounts", { provider, secret }),
  );
  process.stdout.write(`${accountLine(account)}\n`);
};

// ─── login: authorize this terminal through the browser (login.ts) ──────────

const takeFlagValue = (args: ReadonlyArray<string>, flag: string): string | null => {
  const at = args.indexOf(flag);
  return at !== -1 && args[at + 1] !== undefined ? String(args[at + 1]) : null;
};

// Only these three fields persist; `configuredUrl` is derived on every load.
const saveCliConfig = (next: {
  readonly url: string;
  readonly token: string | null;
  readonly deviceId: string | null;
}) => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({ url: next.url, token: next.token, deviceId: next.deviceId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(CONFIG_PATH, 0o600);
};

/** `mend login [--url <server>]` — the browser authorize walk; login.ts owns the flow. */
const login = async (config: CliConfig, args: ReadonlyArray<string>) => {
  await loginCommand(args, {
    configuredUrl: config.configuredUrl,
    defaultUrl: config.url,
    save: (next) => {
      saveCliConfig({ url: next.url, token: next.token, deviceId: next.deviceId });
      say(dim(`  token saved to ${CONFIG_PATH} (0600)`));
    },
  });
};

/**
 * Signing out revokes the device server-side when it can — merely forgetting
 * a live token would leave it valid until someone found it in Settings →
 * Devices. A server that cannot be reached still loses the local copy.
 */
const logout = async (config: CliConfig) => {
  if (!fs.existsSync(CONFIG_PATH) && config.token === null) {
    say(dim("nothing saved — already signed out"));
    return;
  }
  if (config.token !== null && config.deviceId !== null) {
    try {
      await request(config, "DELETE", `/me/devices/${config.deviceId}`);
      say(`${green("✓")} device revoked on ${config.url}`);
    } catch {
      say(dim("  could not revoke on the server — end it under Settings → Devices"));
    }
  }
  saveCliConfig({ ...config, token: null, deviceId: null });
  say(`${green("✓")} signed out · ${dim(`token removed from ${CONFIG_PATH}`)}`);
};

// ─── uninstall: the one command that deletes ────────────────────────────────

const UNINSTALL_CHOICES: ReadonlyArray<{ readonly scope: UninstallScope; readonly text: string }> =
  [
    { scope: "all", text: "everything · the server on this machine and this machine's Mend files" },
    { scope: "server", text: "the server only · containers, volumes, configuration, backups" },
    {
      scope: "home",
      text: "this machine's files only · sign-in, workspace ssh key, ~/.ssh/config block",
    },
  ];

/** One question on a terminal; a script must say what it wants with a flag. */
const askUninstallScope = async (): Promise<UninstallScope> => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return fail(`${UNINSTALL_USAGE} · no terminal to ask on`);
  }
  say("what should go?");
  UNINSTALL_CHOICES.forEach((choice, index) => say(`  ${index + 1}. ${choice.text}`));
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  1, 2 or 3: ")).trim();
  rl.close();
  const chosen = UNINSTALL_CHOICES[Number(answer) - 1];
  if (chosen === undefined) return fail(`"${answer}" is not one of the choices`);
  return chosen.scope;
};

/** The typed word stands in for a second look: data goes, so "y" is not enough. */
const confirmUninstall = async (word: string): Promise<boolean> => {
  if (process.stdin.isTTY !== true) return fail("non-interactive — pass --yes to remove");
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(word === "y" ? "remove? [y/N] " : `type ${word} to remove: `))
    .trim()
    .toLowerCase();
  rl.close();
  return answer === word;
};

const uninstallCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const parsed = parseUninstallArgs(args);
  if ("error" in parsed) return fail(parsed.error);
  const scope = parsed.scope ?? (await askUninstallScope());
  const server = nodeServerRuntime();
  const runtime = {
    server,
    cliHome: mendCliHome(),
    sshConfigFile: path.join(os.homedir(), ".ssh", "config"),
    signedIn:
      config.token === null || !fs.existsSync(CONFIG_PATH)
        ? null
        : { url: config.url, deviceId: config.deviceId },
    revokeDevice: async (): Promise<string | null> => {
      if (config.deviceId === null) return "no device id saved";
      try {
        await request(config, "DELETE", `/me/devices/${config.deviceId}`);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
  const plan = await describeUninstall(runtime, scope);
  say(dim(`mend uninstall · ${scope === "all" ? "everything" : scope}`));
  for (const line of planLines(plan, server.configDir)) say(`  ${line}`);
  const nothing =
    (plan.server === null || plan.server === "none") &&
    (plan.home === null ||
      (plan.home.cliConfig === null &&
        plan.home.sshDirectory === null &&
        plan.home.managedSshBlocks === 0));
  if (nothing) {
    say(dim("nothing to remove"));
    return;
  }
  if (planDeletesData(plan)) {
    say("repositories, worktrees, the database and its backups are deleted with the server");
  }
  if (!parsed.yes && !(await confirmUninstall(planDeletesData(plan) ? "delete" : "y"))) {
    say(dim("nothing removed"));
    return;
  }
  const outcome = await executeUninstall(runtime, plan);
  for (const line of outcome.leftovers) say(dim(`  kept · ${line}`));
  if (outcome.failures.length > 0) {
    return fail(outcome.failures.join("\n"));
  }
  say(
    `${green("✓")} ${scope === "all" ? "Mend is gone from this machine" : scope === "server" ? "the server is gone from this machine" : "this machine no longer holds Mend files"}`,
  );
};

// ─── keys: the machine's Mend deploy key (docs/GIT-ACCESS.md) ───────────────

/** Print the public key with the one instruction that makes it useful. */
const printGitKey = (key: GitKeyDto) => {
  if (key.publicKey === null) return;
  say(key.publicKey);
  if (key.fingerprint !== null) say(dim(`  ${key.fingerprint}`));
  say(dim("  add this to your git account's SSH keys (GitHub: settings → SSH keys) so"));
  say(dim("  every repository you can reach works; for one repository only, add it"));
  say(dim("  as that repository's deploy key instead (grant write if sessions push)"));
};

const keysShow = async (config: CliConfig) => {
  const key = await api<GitKeyDto>(config, "GET", "/keys/git");
  if (!key.exists) {
    say(
      `no Mend key yet ${dim("— mend keys init generates one (ed25519, stays on the server host)")}`,
    );
    return;
  }
  printGitKey(key);
};

const keysInit = async (config: CliConfig) => {
  const key = await api<GitKeyDto>(config, "POST", "/keys/git");
  say(`${green("✓")} Mend key ready ${dim("(private half stays on the server host)")}`);
  printGitKey(key);
};

/**
 * `mend keys share`: the ssh-agent bridge in the foreground (agent-share.ts
 * holds the relay). Prints every connect, drop, and signature; Ctrl-C stops.
 */
const keysShare = async (config: CliConfig) => {
  const agentSock = process.env["SSH_AUTH_SOCK"];
  if (agentSock === undefined || agentSock === "") {
    return fail("SSH_AUTH_SOCK is not set — start (or plug in) your ssh-agent first");
  }
  const url = bridgeUrlOf(
    parseMendUrl(config.url).toString().replace(/\/$/, ""),
    config.token,
    os.hostname(),
  );
  await shareAgent({
    url,
    agentSock,
    signal: new AbortController().signal,
    onEvent: (event) => {
      switch (event.kind) {
        case "connected":
          say(`${green("●")} sharing this machine's ssh-agent with ${config.url}`);
          say(dim(`  agent: ${agentSock} · signature requests print here · Ctrl-C stops sharing`));
          return;
        case "disconnected":
          say(
            dim(`not connected — retrying in ${Math.round(event.retryMs / 1000)}s (Ctrl-C stops)`),
          );
          return;
        case "sign-requested":
          say(`${amber("✎")} signature requested by mend ${dim(`(${event.context})`)}`);
          say(dim("  waiting — touch your key if it blinks (up to 60s)…"));
          return;
        case "identities-requested":
          say(dim(`  identities requested (${event.context})`));
          return;
        case "signed":
          say(`${green("✓")} signed ${dim(`(${event.seconds.toFixed(1)}s)`)}`);
          return;
        case "not-signed":
          say(`${amber("✗")} not signed — ${event.message}`);
          return;
      }
    },
  });
};

interface GitAccessDto {
  readonly mode: "mend-key" | "bridge";
  readonly key: GitKeyDto;
  readonly bridge: { readonly connected: boolean; readonly clientName: string | null };
}

/**
 * `mend keys mode [mend-key|bridge]`: how this user's remotes are reached by
 * default. The Mend key lives on the server and works whenever the server
 * is up — detached sessions, the phone, the hot pool. Bridge signs with this
 * machine's ssh-agent and only works while a mend command is running here.
 */
const keysMode = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [value] = args;
  if (value !== undefined && value !== "mend-key" && value !== "bridge") {
    return fail(`keys mode takes mend-key or bridge, not "${value}"`);
  }
  const access =
    value === undefined
      ? await api<GitAccessDto>(config, "GET", "/me/git-access")
      : await api<GitAccessDto>(config, "PUT", "/me/git-access", { mode: value });
  if (value !== undefined) say(`${green("✓")} git access · ${value}`);
  if (access.mode === "mend-key") {
    say(`mend-key ${dim("— your Mend key on the server signs; works whenever the server is up")}`);
    if (access.key.exists) printGitKey(access.key);
    else say(dim("  no key yet — mend keys init creates it"));
    return;
  }
  say(`bridge ${dim("— this machine's ssh-agent signs; only while a mend command runs here")}`);
  say(
    access.bridge.connected
      ? `${green("●")} signer connected · ${access.bridge.clientName ?? "unknown machine"}`
      : dim("  no signer connected — mend shares the agent whenever it runs (or: mend keys share)"),
  );
};

const keysCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb] = args;
  switch (verb) {
    case "init":
      return keysInit(config);
    case "share":
      return keysShare(config);
    case "mode":
      return keysMode(config, args.slice(1));
    case "show":
    case undefined:
      return keysShow(config);
    default:
      return fail(`unknown keys command "${verb}" · mend help keys lists them`);
  }
};

const formatDotfileBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

const dotfilesShow = async (config: CliConfig) => {
  const dotfiles = await api<DotfilesDto>(config, "GET", "/dotfiles");
  if (dotfiles.repository === null) {
    say(`repo      ${dim("none")}`);
  } else {
    const branch = dotfiles.repository.ref ?? "default branch";
    const subdir =
      dotfiles.repository.subdirectory === null ? [] : [`${dotfiles.repository.subdirectory}/`];
    const bootstrap = dotfiles.repository.bootstrap ? "install.sh on" : "install.sh off";
    say(
      `repo      ${dotfiles.repository.url} ${dim(`(${[branch, ...subdir, bootstrap].join(" · ")})`)}`,
    );
  }
  if (dotfiles.snapshot === null) {
    say(`snapshot  ${dim("none — sync from this machine: mend dotfiles sync --all")}`);
    return;
  }
  const snapshot = dotfiles.snapshot;
  say(
    `snapshot  ${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"} · from ${snapshot.source} · ${dim(snapshot.sha.slice(0, 7))}`,
  );
  for (const file of snapshot.files) {
    say(`  ${file.path.padEnd(36)} ${dim(formatDotfileBytes(file.bytes))}`);
  }
};

/**
 * `mend dotfiles sync` — capture home files ON THIS MACHINE and stream them into the server's
 * per-user dotfiles store. This is the whole point of the store: the server may be a VPS whose
 * home directory belongs to a service account, so contents are read here, where they live.
 */
const dotfilesSync = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const all = args.includes("--all");
  const requestedPaths = args.filter((arg) => !arg.startsWith("--"));
  const home = os.homedir();

  if (!all && requestedPaths.length === 0) {
    const found = scanDotfileCandidates(home);
    if (found.length === 0) {
      say(dim("no known config files found under ~"));
      return;
    }
    let group = "";
    for (const entry of found) {
      if (entry.group !== group) {
        group = entry.group;
        say(dim(group));
      }
      say(`  ${entry.path.padEnd(36)} ${dim(formatDotfileBytes(entry.bytes))}`);
    }
    say("");
    say(
      `sync everything with ${cobalt("mend dotfiles sync --all")}, or pick: ${cobalt("mend dotfiles sync .zshrc .gitconfig")}`,
    );
    return;
  }

  const selected = all ? scanDotfileCandidates(home).map((entry) => entry.path) : requestedPaths;
  if (selected.length === 0) return fail("nothing to sync — no known config files found under ~");
  const read = readSyncFiles(home, selected);
  if ("error" in read) return fail(read.error);

  const result = await api<DotfilesDto>(config, "POST", "/dotfiles/snapshot", {
    files: read.files,
    source: os.hostname(),
    merge: false,
  });
  const snapshot = result.snapshot;
  if (snapshot === null) return fail("the server accepted the sync but reports no snapshot");
  say(
    `${green("synced")} ${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"} from ${os.hostname()} · ${dim(snapshot.sha.slice(0, 7))} ${dim("— applies from the next session launch")}`,
  );
};

// ─── env: the project env store ─────────────────────────────────────────────

interface ProjectEnvironmentDto {
  readonly revision: number;
  readonly variables: ReadonlyArray<{ readonly name: string; readonly updatedAt: string }>;
}
interface ProjectSecretsDto {
  readonly revision: number;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly updatedAt: string }>;
}
interface ProjectClusterBindingsDto {
  readonly revision: number;
  readonly bindings: ReadonlyArray<{
    readonly id: string;
    readonly kind: "secret" | "configmap";
    readonly objectName: string;
  }>;
  readonly serviceAccount: string | null;
  readonly clusterCapable: boolean;
}

const envLoad = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const explicitProject = takeFlagValue(args, "--project");
  // `--secret` alone sends everything to Secrets; `--secret A,B` only those names (for the
  // ordinary-looking ones that embed credentials, like DATABASE_URL). Routing is by NAME.
  const secretFlag = args.indexOf("--secret");
  const secretArg = secretFlag === -1 ? undefined : args[secretFlag + 1];
  const secretNames =
    secretArg !== undefined &&
    !secretArg.startsWith("--") &&
    !secretArg.includes("/") &&
    !secretArg.includes(".")
      ? secretArg
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
  const allSecret = secretFlag !== -1 && secretNames.length === 0;
  const consumed = new Set<number>();
  if (secretFlag !== -1 && secretNames.length > 0) consumed.add(secretFlag + 1);
  const positional = args.filter(
    (arg, i) => !arg.startsWith("--") && args[i - 1] !== "--project" && !consumed.has(i),
  );
  const file = path.resolve(positional[0] ?? ".env");
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return fail(`cannot read ${file} — pass a path: mend env load path/to/.env`);
  }
  if (contents.trim() === "") {
    say(dim(`${file} is empty`));
    return;
  }
  const project = await findProject(config, explicitProject);
  const report = await api<EnvironmentLoadReportDto>(
    config,
    "POST",
    `/projects/${project.id}/environment/load`,
    { contents, allSecret, secretNames },
  );
  if (
    report.loaded.length === 0 &&
    report.rejected.length === 0 &&
    report.malformedLines.length === 0
  ) {
    say(dim(`${path.basename(file)} has no variables`));
    return;
  }
  say(`${green("✓")} loaded ${path.basename(file)} into ${project.name}`);
  for (const line of formatLoadReport(report, { dim, warn: amber })) say(line);
  const plaintextUrls = report.loaded.filter(
    (entry) => entry.lane === "configuration" && /_(URL|URI|DSN)$/.test(entry.name),
  );
  if (plaintextUrls.length > 0) {
    say(
      amber(
        `  ${plaintextUrls.map((entry) => entry.name).join(", ")} stored as plaintext configuration — if a value embeds a password, store it as a secret: mend env load --secret ${plaintextUrls.map((entry) => entry.name).join(",")}`,
      ),
    );
  }
  if (report.malformedLines.length > 0) {
    say(
      amber(
        `  skipped ${report.malformedLines.length} malformed line${report.malformedLines.length === 1 ? "" : "s"}: ${report.malformedLines.join(", ")}`,
      ),
    );
  }
  say(
    dim(
      `  configuration r${report.environmentRevision} · secrets r${report.secretRevision} — applies from the next workspace launch, including resume; running workspaces keep what they started with`,
    ),
  );
};

const envShow = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const project = await findProject(config, takeFlagValue(args, "--project"));
  const [environment, secrets, cluster] = await Promise.all([
    api<ProjectEnvironmentDto>(config, "GET", `/projects/${project.id}/environment`),
    api<ProjectSecretsDto>(config, "GET", `/projects/${project.id}/secrets`),
    api<ProjectClusterBindingsDto>(config, "GET", `/projects/${project.id}/cluster-bindings`),
  ]);
  say(
    `${project.name} ${dim(`· configuration r${environment.revision} · secrets r${secrets.revision} · cluster r${cluster.revision}`)}`,
  );
  if (
    environment.variables.length === 0 &&
    secrets.secrets.length === 0 &&
    cluster.bindings.length === 0 &&
    cluster.serviceAccount === null
  ) {
    say(dim(`  nothing stored — load a file: ${cobalt("mend env load")}`));
    return;
  }
  const bindingNames = cluster.bindings.map((b) => `${b.kind}/${b.objectName}`);
  const width = Math.max(
    0,
    ...environment.variables.map((v) => v.name.length),
    ...secrets.secrets.map((s) => s.name.length),
    ...bindingNames.map((name) => name.length),
  );
  for (const variable of environment.variables) {
    say(`  ${variable.name.padEnd(width)}  configuration ${dim("· plaintext")}`);
  }
  for (const secret of secrets.secrets) {
    say(`  ${secret.name.padEnd(width)}  secret ${dim("· value set, never shown")}`);
  }
  for (const name of bindingNames) {
    say(
      `  ${name.padEnd(width)}  cluster binding ${dim("· resolved by the platform at launch · contents unknown to Mend")}`,
    );
  }
  if (cluster.serviceAccount !== null) {
    say(
      `  ${cluster.serviceAccount.padEnd(width)}  service account ${dim("· workspace pod identity · allowlisted by the operator")}`,
    );
  }
  if (!cluster.clusterCapable && (cluster.bindings.length > 0 || cluster.serviceAccount !== null)) {
    say(
      amber(
        `  ${cluster.bindings.length} cluster binding${cluster.bindings.length === 1 ? "" : "s"}${cluster.serviceAccount === null ? "" : " · service account set"} · local runner — cluster bindings do not resolve here`,
      ),
    );
  }
};

/**
 * Cluster bindings (`.plans/cluster-env-sources.md`): NAMES of Kubernetes Secrets/ConfigMaps the
 * platform resolves at launch — Mend never holds the values. Every verb works on every install
 * (a non-cluster install must be able to remove bindings to launch); only resolution is
 * Kubernetes-only, and the platform refuses launches there, readably.
 */
const envCluster = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const explicitProject = takeFlagValue(args, "--project");
  const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--project");
  const [verb, ...rest] = positional;
  const usage = usageOf("env cluster");
  const project = await findProject(config, explicitProject);
  const route = `/projects/${project.id}/cluster-bindings`;
  const appliesLine = () =>
    say(
      dim(
        "  applies from the next workspace launch; running workspaces keep what they started with",
      ),
    );

  if (verb === "add") {
    const [kind, objectName] = rest;
    if ((kind !== "secret" && kind !== "configmap") || objectName === undefined) {
      return fail(`env cluster add takes a kind and an object name\n${usage}`);
    }
    const result = await api<{ readonly revision: number }>(config, "POST", route, {
      kind,
      objectName,
    });
    say(`${green("✓")} bound ${kind}/${objectName} ${dim(`· cluster r${result.revision}`)}`);
    say(dim("  resolved by the platform at launch · contents unknown to Mend"));
    return appliesLine();
  }
  if (verb === "remove") {
    const [ref] = rest;
    const [kind, objectName] = ref?.split("/", 2) ?? [];
    if ((kind !== "secret" && kind !== "configmap") || objectName === undefined) {
      return fail(`env cluster remove takes <kind>/<name>, e.g. secret/app-env\n${usage}`);
    }
    const snapshot = await api<ProjectClusterBindingsDto>(config, "GET", route);
    const binding = snapshot.bindings.find((b) => b.kind === kind && b.objectName === objectName);
    if (binding === undefined) return fail(`${kind}/${objectName} is not bound on ${project.name}`);
    const result = await api<{ readonly revision: number }>(
      config,
      "DELETE",
      `${route}/${binding.id}`,
    );
    say(`${green("✓")} removed ${kind}/${objectName} ${dim(`· cluster r${result.revision}`)}`);
    return appliesLine();
  }
  if (verb === "sa") {
    const clear = args.includes("--clear");
    const [name] = rest;
    if (!clear && name === undefined)
      return fail(`env cluster sa takes a name or --clear\n${usage}`);
    const result = await api<{ readonly serviceAccount: string | null; readonly revision: number }>(
      config,
      "PUT",
      `${route}/service-account`,
      { serviceAccount: clear ? null : name },
    );
    say(
      result.serviceAccount === null
        ? `${green("✓")} cleared the workspace service account ${dim(`· cluster r${result.revision}`)}`
        : `${green("✓")} service account ${result.serviceAccount} ${dim(`· cluster r${result.revision}`)}`,
    );
    if (result.serviceAccount !== null) {
      say(
        amber(
          "  the session agent holds this role's full permissions for the whole session — bind a least-privilege role intended for untrusted code; names outside the platform allowlist fail the launch",
        ),
      );
    }
    return appliesLine();
  }
  return fail(`unknown env cluster command "${verb ?? ""}"\n${usage}`);
};

const envCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  switch (verb) {
    case "load":
      return envLoad(config, rest);
    case "cluster":
      return envCluster(config, rest);
    case "show":
    case undefined:
      return envShow(config, rest);
    default:
      return fail(`unknown env command "${verb}" · mend help env lists them`);
  }
};

const dotfilesCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  switch (verb) {
    case "sync":
      return dotfilesSync(config, rest);
    case "show":
    case undefined:
      return dotfilesShow(config);
    default:
      return fail(`unknown dotfiles command "${verb}" · mend help dotfiles lists them`);
  }
};

// ─── skills: the user/project skill libraries ───────────────────────────────

interface SkillDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "user" | "project";
  readonly fileCount: number;
  readonly bytes: number;
}
interface SkillsSyncReportDto {
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** With `--project` the project's library; bare, your own. */
const skillsList = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const forProject = args.includes("--project");
  const project = forProject ? await findProject(config, takeFlagValue(args, "--project")) : null;
  const skills = await api<ReadonlyArray<SkillDto>>(
    config,
    "GET",
    project === null ? "/skills" : `/projects/${project.id}/skills`,
  );
  const library = project === null ? "your library" : project.name;
  if (skills.length === 0) {
    say(dim(`no skills in ${library} — push a local one: mend skills push`));
    return;
  }
  for (const skill of skills) {
    say(
      `  ${skill.name.padEnd(28)} ${dim(`${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"} · ${formatDotfileBytes(skill.bytes)}`)}`,
    );
    if (skill.description !== "") say(`    ${dim(skill.description)}`);
  }
};

/**
 * Scan the shared agent-skills directory (`~/.agents/skills` by convention)
 * and upload every bundle. The upload is the intent: same-named skills are
 * replaced, and `--prune` removes what the directory no longer carries.
 */
const skillsPush = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const dirFlag = takeFlagValue(args, "--dir");
  const root =
    dirFlag === null ? path.join(os.homedir(), DEFAULT_SKILLS_DIR) : path.resolve(dirFlag);
  const scanned = scanSkillLibrary(root);
  if ("error" in scanned) return fail(scanned.error);
  for (const note of scanned.notes) say(dim(`  ${note.skill}: ${note.message}`));
  if (scanned.skills.length === 0) return fail(`no skills found under ${root}`);
  const forProject = args.includes("--project");
  const project = forProject ? await findProject(config, takeFlagValue(args, "--project")) : null;
  const report = await api<SkillsSyncReportDto>(config, "POST", "/skills/sync", {
    scope: project === null ? "user" : "project",
    projectId: project?.id ?? null,
    skills: scanned.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      files: skill.files,
    })),
    prune: args.includes("--prune"),
  });
  const library = project === null ? "your library" : project.name;
  const counts = [
    `${report.created.length} new`,
    `${report.updated.length} updated`,
    `${report.unchanged.length} unchanged`,
    ...(report.removed.length > 0 ? [`${report.removed.length} removed`] : []),
  ].join(" · ");
  say(
    `${green("pushed")} ${scanned.skills.length} skill${scanned.skills.length === 1 ? "" : "s"} from ${root} to ${library} · ${dim(counts)}`,
  );
  say(dim("sessions receive them from the next launch"));
};

const skillsCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  switch (verb) {
    case "push":
      return skillsPush(config, rest);
    case "list":
      return skillsList(config, rest);
    case undefined:
      return skillsList(config, args);
    default:
      // Bare flags (`mend skills --project web`) read as the list.
      if (verb.startsWith("--")) return skillsList(config, args);
      return fail(`unknown skills command "${verb}" · mend help skills lists them`);
  }
};

// ─── completions: live sessions under TAB ───────────────────────────────────

/**
 * The data half of shell completion: one live session per line as
 * `id<TAB>description`. Scripts adapt the shape (zsh wants `id:desc`, bash
 * wants bare ids). Never fails — a dead server just completes nothing.
 */
const completeCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  if (args[0] !== "session") return;
  try {
    const [sessions, projects] = await Promise.all([
      request<ReadonlyArray<SessionDto>>(config, "GET", "/sessions"),
      request<ReadonlyArray<ProjectDto>>(config, "GET", "/projects"),
    ]);
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    for (const session of sessions) {
      const project = nameById.get(session.projectId) ?? "";
      process.stdout.write(`${session.id}\t${session.harness} · ${project} · ${session.branch}\n`);
    }
  } catch {
    // Completion must never surface an error into the user's TAB press.
  }
};

const ZSH_COMPLETIONS = `#compdef mend
_mend() {
  local -a commands
  commands=(
    'adopt:adopt a repository into the store'
    'codex:new session + codex' 'claude:new session + claude' 'opencode:new session + opencode'
    'run:new session + arbitrary command'
    'attach:reattach to a running session' 'stop:stop the agent — record and review remain'
    'shell:open a shell in a live session workspace'
    'service:reachable ports — add, list, stop'
    'server:local server setup, lifecycle and upgrades'
    'uninstall:remove the server, local Mend files, or both'
    'keys:the machine Mend deploy key — init, show, share'
    'skills:skill libraries — list, push'
    'accounts:your connected accounts on the platform'
    'pair:pair a phone or a second machine' 'doctor:read-only checklist of this setup'
    'connect:send this machine'"'"'s claude/codex/github credential to the platform'
    'continue:resume with the pending follow-up' 'resume:rejoin a settled session'
    'rejoin:attach if live, otherwise resume'
    'refresh:fetch origin branches into the store' 'projects:adopted projects' 'sessions:sessions with review facts' 'status:active sessions'
    'ui:the dashboard' 'help:help'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[2] in
    server)
      if (( CURRENT == 3 )); then
        compadd setup status start stop restart logs upgrade
      else
        case $words[3] in
          setup) compadd -- --version --assets-dir --offline --context --port --ssh-port --bind --url --origin --docker-socket ;;
          upgrade) compadd -- --version --assets-dir --offline ;;
          start|restart) compadd -- --offline ;;
          logs) compadd -- --tail ;;
        esac
      fi
      ;;
    shell|attach|stop|continue|resume|rejoin)
      local -a sessions
      sessions=(\${(f)"$(command mend __complete session 2>/dev/null | tr '\\t' ':')"})
      (( \${#sessions} )) && _describe 'session' sessions
      ;;
  esac
}
_mend "$@"
`;

const BASH_COMPLETIONS = `_mend() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "adopt codex claude opencode run attach stop shell service server uninstall keys skills pair doctor continue resume rejoin refresh projects sessions status ui help" -- "$cur") )
    return
  fi
  case \${COMP_WORDS[1]} in
    server)
      local options=""
      if [ "$COMP_CWORD" -eq 2 ]; then
        options="setup status start stop restart logs upgrade"
      else
        case \${COMP_WORDS[2]} in
          setup) options="--version --assets-dir --offline --context --port --ssh-port --bind --url --origin --docker-socket" ;;
          upgrade) options="--version --assets-dir --offline" ;;
          start|restart) options="--offline" ;;
          logs) options="--tail" ;;
        esac
      fi
      COMPREPLY=( $(compgen -W "$options" -- "$cur") )
      ;;
    shell|attach|stop|continue|resume|rejoin)
      COMPREPLY=( $(compgen -W "$(command mend __complete session 2>/dev/null | cut -f1)" -- "$cur") )
      ;;
  esac
}
complete -F _mend mend
`;

/** Print the hook for the named shell; the user wires it into their rc file. */
const completionsCommand = (args: ReadonlyArray<string>) => {
  switch (args[0]) {
    case "zsh":
      process.stdout.write(ZSH_COMPLETIONS);
      return;
    case "bash":
      process.stdout.write(BASH_COMPLETIONS);
      return;
    default:
      return fail(`${usageOf("completions")} · e.g. mend completions zsh > "$fpath[1]/_mend"`);
  }
};

// ─── supervised run: platform workspace + PTY + record ──────────────────────

const supervisedRun = async (
  config: CliConfig,
  session: SessionDto,
  argv: ReadonlyArray<string>,
) => {
  const launched = await withSpinner(
    "provisioning workspace — a first launch builds the harness image (can take minutes)…",
    api<SessionDto>(config, "POST", `/sessions/${session.id}/launch`, { argv }),
  );
  say(
    `${green("✓ recording")} · run ${dim(launched.id.slice(0, 8))} · workspace mounts the worktree`,
  );
  say(dim(`  ${argv.join(" ")} — live record:`));
  say("");

  // Tail the record through the server's event stream until the session settles.
  const headers: Record<string, string> = {};
  if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
  const response = await fetch(`${config.url}/api/events`, { headers });
  if (response.body === null) return fail("event stream unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled: string | null = null;
  while (settled === null) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data === "") continue;
      let event: { readonly type?: string; readonly sessionId?: string; readonly line?: string };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      if (event.sessionId !== session.id) continue;
      if (event.type === "session-progress" && event.line !== undefined) {
        say(dim(`  ${event.line}`));
      }
      if (event.type === "session") {
        const detail = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${session.id}`);
        // The agent's own end settles the wait: the session fold may read `idle` while a
        // shell still holds the workspace.
        const ended =
          agentOutcome(detail.currentAgent) ??
          (["completed", "failed", "stopped"].includes(detail.session.status)
            ? detail.session.status
            : null);
        if (ended !== null) settled = ended;
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  say("");
  say(`${green("✓")} session ${settled ?? "settled"} · recorded · checkpoint taken`);
  say(`${cobalt("  review")} · ${config.url}/sessions/${session.id}`);
  process.exit(settled === "failed" ? 1 : 0);
};

// ─── continue: pick up a pending follow-up ──────────────────────────────────

interface FollowUpDto {
  readonly id: string;
  readonly sessionId: string;
  readonly reviewSliceId: string | null;
  readonly checkpointAId: string | null;
  readonly checkpointBId: string | null;
  readonly diffDigest: string | null;
  readonly commentIds: ReadonlyArray<string>;
  readonly idempotencyKey: string | null;
  readonly instruction: string;
  readonly status: "pending" | "delivering" | "delivered" | "delivery_failed" | "superseded";
  readonly deliverySealantRunId: string | null;
  readonly deliveryError: string | null;
}

interface ProjectDetailDto {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
  readonly annotations: ReadonlyArray<SessionAnnotationDto>;
  /** Present when the server is worktree-aware — the capability signal. */
  readonly worktrees?: ReadonlyArray<WorktreeDto>;
}

/**
 * The second half of the review loop (plan §7.3): find the session with a
 * pending follow-up and retry the one server-owned delivery operation. The
 * server persists intent, launches, correlates membership, and finalizes.
 */
const continueSession = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const explicitSession = args.find((a) => !a.startsWith("--")) ?? null;

  let sessionId = explicitSession;
  let followUp: FollowUpDto | null = null;
  if (sessionId === null) {
    // Search the cwd's project, newest sessions first.
    const project = await findProject(config, null);
    const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`);
    for (const candidate of detail.sessions) {
      const pending = await api<FollowUpDto | null>(
        config,
        "GET",
        `/sessions/${candidate.id}/follow-up`,
      );
      if (pending !== null) {
        sessionId = candidate.id;
        followUp = pending;
        break;
      }
    }
    if (sessionId === null || followUp === null) {
      return fail("no session with a pending follow-up — send one from the review first");
    }
  } else {
    followUp = await api<FollowUpDto | null>(config, "GET", `/sessions/${sessionId}/follow-up`);
    if (followUp === null) return fail(`session ${sessionId} has no pending follow-up`);
  }

  const detail = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`);
  const session = detail.session;
  say(`${green("✓")} follow-up for session ${dim(session.id.slice(0, 8))} · ${session.branch}`);
  say(dim("  instruction:"));
  for (const line of followUp.instruction.split("\n").slice(0, 6)) say(dim(`  │ ${line}`));
  if (followUp.instruction.split("\n").length > 6) say(dim("  │ …"));

  if (
    followUp.reviewSliceId === null ||
    followUp.checkpointAId === null ||
    followUp.checkpointBId === null ||
    followUp.diffDigest === null ||
    followUp.idempotencyKey === null
  ) {
    return fail("legacy follow-up — recreate it from a pinned Review before delivery");
  }

  const delivered = await withSpinner(
    "delivering persisted Review bundle — retries reconcile one process…",
    api<FollowUpDto>(config, "POST", `/sessions/${session.id}/follow-up/deliver`, {
      reviewSliceId: followUp.reviewSliceId,
      checkpointAId: followUp.checkpointAId,
      checkpointBId: followUp.checkpointBId,
      diffDigest: followUp.diffDigest,
      commentIds: followUp.commentIds,
      instruction: followUp.instruction,
      idempotencyKey: followUp.idempotencyKey,
    }),
  );
  if (delivered.status === "pending") {
    return fail("the session is active — the follow-up remains pending");
  }
  if (delivered.status === "delivery_failed") {
    return fail(delivered.deliveryError ?? "delivery failed before process membership finalized");
  }
  say(
    `${green("✓ recording")} · delivered to run ${delivered.deliverySealantRunId ?? "unknown"}${detachHint()}`,
  );
  say(`${cobalt("  watch")} · ${config.url}/sessions/${session.id}`);
  say("");
  await attachOrExit(config, session.id, session.harness);
  exitAfterSessionEnd(config, session.id);
};

// ─── resume: rejoin a session — same worktree, restored harness state ───────

const ACTIVE_STATUSES = LIVE_STATUSES;

/** Whether a listed session's AGENT is live — the annotation carries its current agent process. */
const agentLiveIn = (detail: ProjectDetailDto, session: SessionDto): boolean =>
  agentIsLive(
    session,
    detail.annotations.find((annotation) => annotation.sessionId === session.id)?.currentAgent ??
      null,
  );

/**
 * Sessions are continuous work, not runs: `mend resume` rejoins one on a
 * fresh workspace — saved harness state restored, a claude resume is native
 * (conversation intact). `--with <harness>` re-opens the same work in a
 * DIFFERENT harness: the conversation crosses as a distilled opening prompt.
 */
const resumeCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const withFlag = args.indexOf("--with");
  const withHarness =
    withFlag !== -1 && args[withFlag + 1] !== undefined ? String(args[withFlag + 1]) : null;
  const prefix = args.find((a, i) => !a.startsWith("--") && i !== withFlag + 1);

  const project = await findProject(config, null);
  const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`);
  const match =
    prefix === undefined
      ? detail.sessions.find((s) => !agentLiveIn(detail, s))
      : detail.sessions.find((s) => s.id.startsWith(prefix));
  if (match === undefined) {
    return fail(
      prefix === undefined
        ? "no settled session to resume — mend status lists sessions"
        : `no session matches "${prefix}"`,
    );
  }
  if (agentLiveIn(detail, match)) {
    return fail(
      `session ${match.id.slice(0, 8)} is live — attach: mend attach ${match.id.slice(0, 8)}`,
    );
  }

  say(
    `${green("✓")} resuming ${match.harness} · ${dim(match.id.slice(0, 8))}${withHarness === null ? "" : ` ${dim("as")} ${withHarness}`}`,
  );
  say(`${cobalt("  watch")} · ${config.url}/sessions/${match.id}`);
  // A formerly-protocol session (a phone pickup) resumed from a terminal must
  // come back as a TUI — the handoff verb routes it there; a plain resume
  // would re-enter protocol mode with nothing to attach.
  const priorAgent =
    detail.annotations.find((annotation) => annotation.sessionId === match.id)?.currentAgent ??
    null;
  const protocolPrior = priorAgent?.kind === "agent-protocol" && withHarness === null;
  await withSpinner(
    protocolPrior
      ? "reopening as a terminal — same conversation…"
      : "resuming — a fresh workspace restores the saved session state…",
    protocolPrior
      ? api<SessionDto>(config, "POST", `/sessions/${match.id}/handoff`, { to: "pty" })
      : api<SessionDto>(config, "POST", `/sessions/${match.id}/resume`, { harness: withHarness }),
  );
  say(`${green("✓ recording")} · same worktree, conversation restored${detachHint()}`);
  say("");
  await attachOrExit(config, match.id, withHarness ?? match.harness);
  exitAfterSessionEnd(config, match.id);
};

// ─── rejoin: one entrypoint for an outer multiplexer ────────────────────────

/**
 * Idempotent entrypoint for outer multiplexers: attach when the session is
 * live, otherwise restore and resume it before attaching. With no id, the
 * newest live session wins, falling back to the newest settled session;
 * --harness narrows the choice.
 */
const resumeForRejoin = async (config: CliConfig, sessionId: string, label: string) => {
  try {
    await withSpinner(
      label,
      request<SessionDto>(config, "POST", `/sessions/${sessionId}/resume`, { harness: null }),
    );
    return true;
  } catch (error) {
    const refreshed = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`);
    if (agentIsLive(refreshed.session, refreshed.currentAgent)) return false;
    return fail(error instanceof Error ? error.message : String(error));
  }
};

const rejoinCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const harnessFlag = args.indexOf("--harness");
  const harness =
    harnessFlag !== -1 && args[harnessFlag + 1] !== undefined
      ? String(args[harnessFlag + 1])
      : null;
  const prefix = args.find((arg, index) => !arg.startsWith("--") && index !== harnessFlag + 1);

  const project = await findProject(config, null);
  const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`);
  const eligible = detail.sessions
    .filter((session) => harness === null || session.harness === harness)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const newest = eligible.find((session) => agentLiveIn(detail, session)) ?? eligible[0];
  const matches =
    prefix === undefined
      ? newest === undefined
        ? []
        : [newest]
      : eligible.filter((session) => session.id.startsWith(prefix));

  if (matches.length === 0) {
    const harnessDescription = harness === null ? "" : ` ${harness}`;
    return fail(
      prefix === undefined
        ? `no${harnessDescription} session to rejoin in project ${project.name}`
        : `no${harnessDescription} session matches "${prefix}" in project ${project.name}`,
    );
  }
  if (matches.length > 1) {
    return fail(`session prefix "${prefix}" is ambiguous — use more of the id`);
  }

  const session = matches[0];
  if (session === undefined) return fail("session selection failed");
  const alreadyLive = agentLiveIn(detail, session);
  say(
    `${green("✓")} rejoining ${sessionDisplayName(session)} · ${session.harness} ${dim(session.id.slice(0, 8))} · ${alreadyLive ? "already live" : "restoring"}`,
  );
  say(`${cobalt("  watch")} · ${config.url}/sessions/${session.id}`);

  let restored = false;
  const currentAgent =
    detail.annotations.find((annotation) => annotation.sessionId === session.id)?.currentAgent ??
    null;
  if (currentAgent?.kind === "agent-protocol") {
    // A protocol agent (a phone pickup) has no PTY to attach. Hand the session
    // off to a terminal: the TUI resumes the same provider conversation, with
    // the phone-authored turns in its scrollback.
    await withSpinner(
      alreadyLive
        ? "taking over from the protocol session — same conversation…"
        : "reopening as a terminal — same conversation…",
      api<SessionDto>(config, "POST", `/sessions/${session.id}/handoff`, { to: "pty" }),
    );
    restored = true;
  } else if (!alreadyLive) {
    restored = await resumeForRejoin(
      config,
      session.id,
      "resuming — a fresh workspace restores the saved session state…",
    );
  }
  say(
    restored
      ? `${green("✓ recording")} · same worktree, conversation restored${detachHint()}`
      : `${green("✓ recording")} · attached to the live session${detachHint()}`,
  );
  say("");
  let outcome = await attachTty(config, session.id, session.harness, 0n, undefined, {
    handleSignals: true,
  });
  if (outcome === "unavailable") {
    const refreshed = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${session.id}`);
    if (!agentIsLive(refreshed.session, refreshed.currentAgent)) {
      await resumeForRejoin(
        config,
        session.id,
        "session settled while attaching — restoring it once…",
      );
    }
    outcome = await attachTty(config, session.id, session.harness, 0n, undefined, {
      handleSignals: true,
    });
  }
  await finishAttach(config, session.id, outcome);
  exitAfterSessionEnd(config, session.id);
};

// ─── projects · sessions: the workbench at a glance ─────────────────────────

const projectsCommand = async (config: CliConfig) => {
  const [projects, active] = await Promise.all([
    api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects"),
    api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions"),
  ]);
  if (projects.length === 0) {
    say(dim("no adopted projects — mend adopt brings one in"));
    return;
  }
  const liveByProject = new Map<string, number>();
  for (const session of active) {
    liveByProject.set(session.projectId, (liveByProject.get(session.projectId) ?? 0) + 1);
  }
  const nameWidth = Math.max(...projects.map((p) => p.name.length));
  const branchWidth = Math.max(...projects.map((p) => p.defaultBranch.length));
  // The cwd's project is marked — the same resolution mend claude|shell use.
  const here = matchProjectByCwd(projects, cwdFacts(process.cwd()));
  for (const project of projects) {
    const live = liveByProject.get(project.id) ?? 0;
    const liveLabel = live > 0 ? green(`${live} live`) : dim("—");
    const marker = project.id === here?.id ? cobalt("▸ ") : "  ";
    say(
      `${marker}${project.name.padEnd(nameWidth)}  ${dim(project.defaultBranch.padEnd(branchWidth))}  ${liveLabel}  ${dim(project.storePath)}`,
    );
  }
  if (here !== undefined) say(dim(`  ▸ ${here.name} is the cwd's project`));
};

interface ProjectBranchDto {
  readonly name: string;
  readonly sha: string;
  readonly committedAt: string;
  readonly isDefault: boolean;
}

/**
 * `mend refresh [project]`: fetch every origin branch into the project's
 * store (new sessions base on current tips), then show what it holds. The
 * project resolves like the launch commands: named, or the cwd's.
 */
const refreshCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const explicit = args.find((a) => !a.startsWith("--")) ?? takeFlagValue(args, "--project");
  const project = await findProject(config, explicit ?? null);
  const branches = await api<ReadonlyArray<ProjectBranchDto>>(
    config,
    "POST",
    `/projects/${project.id}/refresh`,
  );
  say(`${green("✓")} refreshed ${project.name} ${dim(`· ${branches.length} branches`)}`);
  for (const branch of branches.slice(0, 12)) {
    const marker = branch.isDefault ? cobalt("▸ ") : "  ";
    say(
      `${marker}${branch.name}  ${dim(branch.sha.slice(0, 12))}  ${dim(branch.committedAt.slice(0, 10))}`,
    );
  }
  if (branches.length > 12) say(dim(`  … ${branches.length - 12} more`));
};

interface SessionRow {
  readonly session: SessionDto;
  readonly projectName: string;
  readonly annotation: SessionAnnotationDto | undefined;
}

interface SessionJson {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly harness: string;
  readonly label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly reviewUrl: string;
  readonly review: {
    readonly openComments: number;
    readonly totalComments: number;
    readonly pendingFollowUp: boolean;
  } | null;
}

interface SessionsJson {
  readonly version: 1;
  readonly sessions: ReadonlyArray<SessionJson>;
}

const printSessionRow = (row: SessionRow) => {
  const { session, annotation } = row;
  const live = ACTIVE_STATUSES.has(session.status);
  const status = session.status.padEnd(9);
  const facts: Array<string> = [];
  if (session.label !== null) facts.push(session.label);
  if (annotation !== undefined && annotation.openComments > 0) {
    facts.push(amber(`${annotation.openComments} open`));
  }
  if (annotation !== undefined && annotation.pendingFollowUp)
    facts.push(amber("follow-up pending"));
  const base = session.baseRef === null ? session.baseSha.slice(0, 12) : session.baseRef;
  say(
    `${session.harness.padEnd(8)}  ${dim(session.id.slice(0, 8))}  ${live ? green(status) : dim(status)}  ${row.projectName}  ${dim(`${session.branch} · base ${base}`)}${facts.length > 0 ? `  ${facts.join(dim(" · "))}` : ""}`,
  );
};

/**
 * Active sessions by default; --all sweeps every project's detail so settled
 * sessions arrive with their review facts (open comments, pending follow-up).
 */
const sessionsCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const all = args.includes("--all");
  // v1 stays byte-stable for pinned integrations; v2 is the worktree envelope.
  if (args.includes("--json=v2")) {
    const projectFlag = args.indexOf("--project");
    const projectName =
      projectFlag !== -1 && args[projectFlag + 1] !== undefined
        ? String(args[projectFlag + 1])
        : null;
    say(JSON.stringify(await buildWorktreesJson(config, projectName), null, 2));
    return;
  }
  const json = args.includes("--json");
  const projectFlag = args.indexOf("--project");
  const projectName =
    projectFlag !== -1 && args[projectFlag + 1] !== undefined
      ? String(args[projectFlag + 1])
      : null;

  const projects = await api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects");
  const scope = projectName === null ? projects : projects.filter((p) => p.name === projectName);
  if (projectName !== null && scope.length === 0) {
    return fail(`no adopted project named "${projectName}"`);
  }

  let rows: Array<SessionRow>;
  if (all || projectName !== null) {
    // --all means all: dead ends (settled, no conversation) included, which the server hides
    // otherwise for every client.
    const details = await Promise.all(
      scope.map((p) =>
        api<ProjectDetailDto>(config, "GET", `/projects/${p.id}${all ? "?deadEnds=include" : ""}`),
      ),
    );
    rows = details.flatMap((detail) =>
      detail.sessions.map((session) => ({
        session,
        projectName: detail.project.name,
        annotation: detail.annotations.find((a) => a.sessionId === session.id),
      })),
    );
  } else {
    const active = await api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions");
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    rows = active.map((session) => ({
      session,
      projectName: nameById.get(session.projectId) ?? session.projectId.slice(0, 8),
      annotation: undefined,
    }));
  }
  if (rows.length === 0) {
    if (json) {
      say(JSON.stringify({ version: 1, sessions: [] } satisfies SessionsJson, null, 2));
      return;
    }
    say(
      dim(all ? "no sessions" : "no active sessions — mend sessions --all includes settled ones"),
    );
    return;
  }
  rows.sort((a, b) => {
    const aLive = ACTIVE_STATUSES.has(a.session.status) ? 1 : 0;
    const bLive = ACTIVE_STATUSES.has(b.session.status) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return b.session.createdAt.localeCompare(a.session.createdAt);
  });
  if (json) {
    const payload: SessionsJson = {
      version: 1,
      sessions: rows.map(({ session, projectName: rowProjectName, annotation }) => ({
        id: session.id,
        projectId: session.projectId,
        projectName: rowProjectName,
        harness: session.harness,
        label: session.label,
        worktree: session.worktree,
        branch: session.branch,
        baseSha: session.baseSha,
        baseRef: session.baseRef,
        status: session.status,
        summary: session.summary,
        createdAt: session.createdAt,
        reviewUrl: `${config.url.replace(/\/$/, "")}/sessions/${session.id}`,
        review:
          annotation === undefined
            ? null
            : {
                openComments: annotation.openComments,
                totalComments: annotation.totalComments,
                pendingFollowUp: annotation.pendingFollowUp,
              },
      })),
    };
    say(JSON.stringify(payload, null, 2));
    return;
  }
  for (const row of rows) printSessionRow(row);
};

interface WorktreeJsonSession {
  readonly id: string;
  readonly harness: string;
  readonly label: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly createdAt: string;
}

interface WorktreeJson {
  readonly id: string | null;
  readonly name: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
  readonly reviewUrl: string | null;
  readonly review: {
    readonly openComments: number;
    readonly totalComments: number;
    readonly pendingFollowUp: boolean;
  } | null;
  readonly sessions: ReadonlyArray<WorktreeJsonSession>;
}

interface WorktreesJson {
  readonly version: 2;
  readonly worktrees: ReadonlyArray<WorktreeJson>;
}

/**
 * The worktree-grouped view both `mend worktrees --json` and
 * `mend sessions --json=v2` emit. Against a pre-worktree server every session
 * becomes its own pseudo worktree (`id: null`) — the envelope shape is stable
 * either way, so integrations pin on `version`, not server age.
 */
const toWorktreeJsonSession = (session: SessionDto): WorktreeJsonSession => ({
  id: session.id,
  harness: session.harness,
  label: session.label,
  status: session.status,
  summary: session.summary,
  createdAt: session.createdAt,
});

const buildWorktreesJson = async (
  config: CliConfig,
  projectName: string | null,
): Promise<WorktreesJson> => {
  const projects = await api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects");
  const scope = projectName === null ? projects : projects.filter((p) => p.name === projectName);
  const details = await Promise.all(
    scope.map((p) => api<ProjectDetailDto>(config, "GET", `/projects/${p.id}`)),
  );
  const worktrees: Array<WorktreeJson> = [];
  for (const detail of details) {
    const reviewOf = (sessionIds: ReadonlySet<string>) => {
      const facts = detail.annotations.find((a) => sessionIds.has(a.sessionId));
      return facts === undefined
        ? null
        : {
            openComments: facts.openComments,
            totalComments: facts.totalComments,
            pendingFollowUp: detail.annotations.some(
              (a) => sessionIds.has(a.sessionId) && a.pendingFollowUp,
            ),
          };
    };
    const urlOf = (sessionIds: ReadonlySet<string>) => {
      const first = [...sessionIds][0];
      return first === undefined ? null : `${config.url.replace(/\/$/, "")}/sessions/${first}`;
    };
    if (detail.worktrees !== undefined) {
      for (const worktree of detail.worktrees) {
        const members = detail.sessions.filter((session) => session.worktreeId === worktree.id);
        const ids = new Set(members.map((session) => session.id));
        worktrees.push({
          id: worktree.id,
          name: worktree.name,
          projectId: detail.project.id,
          projectName: detail.project.name,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
          baseRef: worktree.baseRef,
          createdAt: worktree.createdAt,
          reviewUrl: urlOf(ids),
          review: reviewOf(ids),
          sessions: members
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(toWorktreeJsonSession),
        });
      }
    } else {
      for (const session of detail.sessions) {
        const ids = new Set([session.id]);
        worktrees.push({
          id: null,
          name: session.worktree,
          projectId: detail.project.id,
          projectName: detail.project.name,
          branch: session.branch,
          baseSha: session.baseSha,
          baseRef: session.baseRef,
          createdAt: session.createdAt,
          reviewUrl: urlOf(ids),
          review: reviewOf(ids),
          sessions: [toWorktreeJsonSession(session)],
        });
      }
    }
  }
  return { version: 2, worktrees };
};

/** `mend worktrees [--project <p>] [--json]` — the container-first listing. */
const worktreesCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const json = args.includes("--json");
  const projectFlag = args.indexOf("--project");
  const projectName =
    projectFlag !== -1 && args[projectFlag + 1] !== undefined
      ? String(args[projectFlag + 1])
      : null;
  const payload = await buildWorktreesJson(config, projectName);
  if (json) {
    say(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.worktrees.length === 0) {
    say(dim("no worktrees yet — mend claude --name <worktree> starts one"));
    return;
  }
  for (const worktree of payload.worktrees) {
    const live = worktree.sessions.filter((session) => ACTIVE_STATUSES.has(session.status)).length;
    const facts: Array<string> = [
      `${worktree.sessions.length} session${worktree.sessions.length === 1 ? "" : "s"}`,
    ];
    if (live > 0) facts.push(green(`${live} live`));
    if (worktree.review !== null && worktree.review.openComments > 0) {
      facts.push(amber(`${worktree.review.openComments} open`));
    }
    const base = worktree.baseRef ?? worktree.baseSha.slice(0, 12);
    say(
      `${worktree.name.padEnd(24)}  ${worktree.projectName}  ${dim(`${worktree.branch} · base ${base}`)}  ${facts.join(dim(" · "))}`,
    );
    for (const session of worktree.sessions) {
      const status = session.status.padEnd(9);
      const name = session.label ?? `session ${session.id.slice(0, 8)}`;
      say(
        `  └ ${session.harness.padEnd(8)}  ${dim(session.id.slice(0, 8))}  ${ACTIVE_STATUSES.has(session.status) ? green(status) : dim(status)}  ${name}`,
      );
    }
  }
};

// ─── dashboard: the live TUI on bare `mend` ─────────────────────────────────

const hasNodeFfi = (): boolean => {
  try {
    createRequire(import.meta.url)("node:ffi");
    return true;
  } catch {
    return false;
  }
};

/**
 * The dashboard needs @opentui/core, whose Node backend binds the native
 * renderer over node:ffi — present from Node 26, and only behind
 * --experimental-ffi. Gate here and re-exec the same argv with the flag so
 * the user never types it; every other command stays on plain Node >= 22.
 */
const dashboard = async (config: CliConfig) => {
  if (process.stdout.isTTY !== true) {
    say(renderIndex());
    return;
  }
  if (!hasNodeFfi()) {
    const major = Number(process.versions.node.split(".")[0]);
    if (Number.isNaN(major) || major < 26) {
      return fail(
        `the dashboard needs Node >= 26 (node:ffi) — this is ${process.version}; every other command still works`,
      );
    }
    const rerun = spawnSync(
      process.execPath,
      ["--experimental-ffi", "--disable-warning=ExperimentalWarning", ...process.argv.slice(1)],
      { stdio: "inherit" },
    );
    process.exit(rerun.status ?? 0);
  }
  const { runDashboard } = await import("./dashboard.tsx");
  const agentShare = await startShareIfBridge(config);
  try {
    await runDashboard({
      config,
      cwd: process.cwd(),
      cwdBranch: gitCurrentBranch(process.cwd()),
      api: <T>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown) =>
        request<T>(config, method, route, body),
      attachTty: (sessionId: string, harness: string, processId?: string) =>
        attachTty(config, sessionId, harness, 0n, processId),
      agentShare,
    });
  } finally {
    agentShare?.stop();
  }
};

// ─── entry ──────────────────────────────────────────────────────────────────

/**
 * Share this machine's ssh-agent for as long as the calling command runs —
 * only when the user's git access is bridge (mend keys mode). Their remotes
 * then sign here, and a base fetch before a worktree is created can't be
 * skipped for want of a signer. Any other mode, no agent, or an unreachable
 * server: nothing is shared. A newer share replaces an older one on the
 * server, so overlapping mend commands hand over rather than fight.
 */
const startShareIfBridge = async (config: CliConfig): Promise<AgentShareHandle | null> => {
  const agentSock = process.env["SSH_AUTH_SOCK"];
  if (agentSock === undefined || agentSock === "") return null;
  let access: GitAccessDto;
  try {
    access = await request<GitAccessDto>(config, "GET", "/me/git-access");
  } catch {
    return null;
  }
  if (access.mode !== "bridge") return null;
  return startAgentShare({
    url: bridgeUrlOf(
      parseMendUrl(config.url).toString().replace(/\/$/, ""),
      config.token,
      os.hostname(),
    ),
    agentSock,
  });
};

/** Run one command under the share (see startShareIfBridge); stop it on the way out. */
const withAgentShare = async <T>(config: CliConfig, work: () => Promise<T>): Promise<T> => {
  const share = await startShareIfBridge(config);
  try {
    return await work();
  } finally {
    share?.stop();
  }
};

/** `mend help [command...]`: the index, a group, or one page. */
const helpCommand = (words: ReadonlyArray<string>) => {
  if (words.length === 0) {
    say(renderIndex());
    return;
  }
  const doc = findCommand(words);
  if (doc !== null && (doc.name.split(" ").length > 1 || words.length === 1)) {
    say(renderCommand(doc));
    return;
  }
  const group = renderGroup(words[0] ?? "");
  if (doc !== null) {
    say(renderCommand(doc));
    return;
  }
  if (group !== null) {
    say(group);
    return;
  }
  return fail(`no command "${words.join(" ")}" · mend help lists them`);
};

/** `mend man [command...]`: the same page through man(1), or the text page without it. */
const manCommand = (words: ReadonlyArray<string>) => {
  const doc = words.length === 0 ? null : findCommand(words);
  if (words.length > 0 && doc === null) {
    return fail(`no command "${words.join(" ")}" · mend help lists them`);
  }
  const version = cliVersion();
  const page = doc === null ? renderManIndex(version) : renderManPage(doc, version);
  const file = path.join(os.tmpdir(), `mend-man-${process.pid}-${manFileName(doc)}`);
  fs.writeFileSync(file, page);
  const result = spawnSync("man", ["-l", file], { stdio: "inherit" });
  fs.rmSync(file, { force: true });
  if (result.error !== undefined || result.status !== 0) {
    say(doc === null ? renderIndex() : renderCommand(doc));
  }
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  // `mend <command> --help` (or -h) before the separator is that command's page,
  // never an argument: `mend run -- cmd --help` keeps its --help for cmd.
  const ownArgs = rest.slice(0, rest.indexOf("--") === -1 ? rest.length : rest.indexOf("--"));
  if (
    command !== undefined &&
    command !== "help" &&
    ownArgs.some((a) => a === "--help" || a === "-h")
  ) {
    return helpCommand([command, ...ownArgs.filter((a) => !a.startsWith("-"))]);
  }
  if (command === "server") {
    const result = await serverCommand(rest);
    if (result._tag === "error") return fail(result.message);
    return;
  }
  const config = loadConfig();
  switch (command) {
    case "adopt":
      return adopt(config, rest);
    case "codex":
    case "claude":
    case "opencode":
    case "run":
      return withAgentShare(config, () => launch(config, command, rest));
    case "attach":
      return withAgentShare(config, () => attach(config, rest));
    case "stop":
      return stopCommand(config, rest);
    case "shell":
      return withAgentShare(config, () => shellCommand(config, rest));
    case "service":
      return serviceCommand(config, rest);
    case "login":
      return login(config, rest);
    case "logout":
      return logout(config);
    case "uninstall":
      return uninstallCommand(config, rest);
    case "keys":
      return keysCommand(config, rest);
    case "dotfiles":
      return dotfilesCommand(config, rest);
    case "skills":
      return skillsCommand(config, rest);
    case "accounts":
      return accountsCommand(config);
    case "connect":
      return connectCommand(config, rest);
    case "pair":
      return pairCommand(rest, boundApi(config));
    // Hidden in the catalog: the installer renders its own QR through this.
    case "qr":
      return qrCommand(rest);
    case "doctor":
      return doctorCommand(config, localCredential);
    case "env":
      return envCommand(config, rest);
    case "ssh":
      return sshCommand(rest, boundApi(config), mendCliHome(), config.url);
    case "completions":
      return completionsCommand(rest);
    case "__complete":
      return completeCommand(config, rest);
    case "continue":
      return continueSession(config, rest);
    case "resume":
      return withAgentShare(config, () => resumeCommand(config, rest));
    case "rejoin":
      return withAgentShare(config, () => rejoinCommand(config, rest));
    case "projects":
      return projectsCommand(config);
    case "refresh":
      return refreshCommand(config, rest);
    case "sessions":
    case "status":
      return sessionsCommand(config, rest);
    case "worktrees":
      return worktreesCommand(config, rest);
    case undefined:
    case "ui":
      return dashboard(config);
    case "help":
    case "--help":
    case "-h":
      return helpCommand(rest);
    case "man":
      return manCommand(rest);
    case "version":
    case "--version":
    case "-v":
      for (const line of versionLines(cliVersion(), await fetchServerVersion(config.url)))
        say(line);
      return;
    default:
      return fail(`unknown command "${command}" · mend help lists them`);
  }
};

await main();
