#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  AGENT_MEMORY_FILES,
  AGENT_MEMORY_ROOTS,
  agentStartingFacts,
  type AgentStartingProcess,
  claudeGrantFacts,
  narrowCredential,
  repositoryCloneUrlIssue,
  sameGrant,
  validatePiProfile,
} from "@mend/domain/workbench";

import {
  claudeMemoryDirFor,
  importReportCounts,
  importReportLines,
  type ImportReport,
  importSourceFor,
  scanClaudeMemory,
  scanCodexMemory,
} from "./agent-memory.ts";
import { type AgentShareHandle, shareAgent, startAgentShare } from "./agent-share.ts";
import { type FirstOutputGate, firstOutputGate, startingLabelOf } from "./attach-starting.ts";
import {
  ownerNameOf,
  type TerminalControlFacts,
  watchesTerminal,
  watchKey,
  watchNotice,
} from "./attach-watch.ts";
import {
  claudeCli,
  claudeGrantDir,
  forgetGrant,
  grantStatus,
  personalClaudeDir,
  readGrant,
  runClaudeLogin,
} from "./claude-grant.ts";
import { readClipboardImage } from "./clipboard.ts";
import { codexCli, codexGrant, personalCodexHome } from "./codex-grant.ts";
import { bundleCollectors, pathOf } from "./doctor-bundle-collectors.ts";
import { doctorBundleCommand } from "./doctor-bundle.ts";
import { doctorCommand, formatCheck, onPath, runChecks } from "./doctor.ts";
import {
  dotfilesRepositoryFacts,
  parseDotfilesRepoArgs,
  readSyncFiles,
  scanDotfileCandidates,
  type DotfilesRepositoryBody,
} from "./dotfiles.ts";
import { formatLoadReport, type EnvironmentLoadReportDto } from "./env.ts";
import { gitAuthorLine, parseGitAuthorArgs, type GitAuthorDto } from "./git-author.ts";
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
import { useHttp1 } from "./http-client.ts";
import { type Download, landCommand, pickSession, pullCommand } from "./landing.ts";
import { followStart, startingLineOf, type StartOutcome } from "./launch-follow.ts";
import { throwawayLoginDir } from "./login-dir.ts";
import { loginCommand } from "./login.ts";
import { modelCatalogJson, modelCatalogLines, type HarnessModelCatalogDto } from "./models.ts";
import {
  folderCommand,
  inviteCommand,
  membersCommand,
  operatorCommand,
  sessionShareCommand,
} from "./organization.ts";
import { type ApiCall, pairCommand, qrCommand } from "./pair.ts";
import { piAgentDir, piProfileLines, scanPiProfile } from "./pi-profile.ts";
import {
  beforeDeadline,
  type CommandDetail,
  type CommandEnd,
  commandEndOf,
  endLine,
  exitStatusOf,
  followLogs,
  isSessionId,
  parseLogsArgs,
  parseWaitArgs,
  pickProcess,
  processRowOf,
  runArgvIssue,
  WAIT_TIMED_OUT,
  waitForCommand,
} from "./run-scripts.ts";
import {
  secretFileLines,
  secretFilePathOf,
  secretFileUploadOf,
  type SecretFileDto,
} from "./secret-files.ts";
import { MendRequestError, noAnswerError, spoken } from "./server-request.ts";
import { runServerProcess } from "./server-runtime.ts";
import { nodeServerRuntime, readServerInstallationFacts, serverCommand } from "./server-setup.ts";
import {
  isComposeFile,
  proposeFromCompose,
  proposeFromPackageJson,
  proposeFromWorkspacePackage,
  renderMendToml,
  workspaceGlobs,
} from "./service-init.ts";
import {
  createServiceTunnels,
  listenLocal,
  pumpConnection,
  serverEvents,
  type ServiceTunnels,
} from "./service-tunnels.ts";
import {
  hasPersonFacts,
  sessionWorkspaceLines,
  workspaceLineList,
  workspaceReadsOf,
  worktreeJoinLine,
  worktreeListsPeople,
  type ConversationWaitDto,
  type LivePersonDto,
  type MemberNameDto,
  type WorkspaceRetirementDto,
} from "./shared-workspace.ts";
import {
  agentIsLive,
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
  servicesHoldOf,
  captureLineOf,
  type SessionCaptureLike,
  firstPositional,
} from "./shared.ts";
import { type AttachOutcome } from "./shared.ts";
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
import {
  MINT_REFUSED_IN_TRANSIT,
  type MintTicket,
  mintRefusedInTransit,
  type UpgradeParams,
  type UpgradeTarget,
  upgradeUrl,
} from "./upgrade-url.ts";
import { cliVersion, fetchServerVersion, versionLines } from "./version.ts";
import { workspaceCommand } from "./workspace-replace.ts";
import { worktreesRmCommand } from "./worktree-remove.ts";

/**
 * The mend CLI (plan §7.2): the terminal-first entry into the workbench.
 *
 *   mend                                  the dashboard: projects + sessions, live
 *   mend adopt [source] [--name <name>]   clone a repo into the store
 *   mend codex|claude|opencode|pi [...]   session worktree + launch the harness there
 *   mend run -- <command...>              same, arbitrary command
 *   mend projects                         adopted projects
 *   mend sessions [--all]                 sessions with their review facts
 *   mend land <session>                   push the change to origin, open its pull request
 *   mend pull <session>                   fetch the change into this clone as mend/<name>
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
  /** "Land when a turn completes"; optional: an older server predates landing. */
  readonly autoLand?: "inherit" | "on" | "off";
}

/** The account's dotfiles: repository knob + store snapshot (see `mend dotfiles`). */
interface DotfilesDto {
  readonly repository: DotfilesRepositoryBody | null;
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

interface SessionDto extends SessionCaptureLike {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  readonly harness: string;
  /**
   * The model and effort the session was started with, as the server resolved them
   * (docs/models-audit.md). Null when not recorded; absent on older servers.
   */
  readonly model?: string | null;
  readonly effort?: string | null;
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
  /**
   * The people with a process live in its executor (docs/adr/0016, decision 13): filled by
   * `GET /sessions` and the session view only; absent on older servers.
   */
  readonly livePeople?: ReadonlyArray<LivePersonDto>;
  /** When shared control was turned on; null while it is off. Absent on older servers. */
  readonly sharedControlEnabledAt?: string | null;
  /**
   * The executor waits to be replaced (docs/adr/0016, decision 14): read with `livePeople`, so
   * the retirement's detail is asked for only when there is one. Absent on older servers.
   */
  readonly workspaceRetirement?: "marked" | "retiring" | null;
}

/** The DB-cheap review facts the server decorates a project's sessions with. */
interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
  /** The session's current agent process; null before the first launch. */
  readonly currentAgent: AgentProcessLike | null;
  /** Services that keep the workspace up; absent on older servers. */
  readonly liveServices?: number;
}

/** The slice of /sessions/:id the CLI reads: the row plus the agent process it currently means. */
interface SessionDetailLiteDto extends TerminalControlFacts {
  readonly session: SessionDto & { readonly ownerUserId?: string | null };
  readonly currentAgent: (AgentProcessLike & AgentStartingProcess) | null;
  /** Every process the session has held, oldest first; read for the starting line's facts. */
  readonly processes?: ReadonlyArray<AgentStartingProcess>;
  /** Services that keep the workspace up; absent on older servers. */
  readonly liveServices?: number;
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

/**
 * Where the CLI's own lines go. stdout, except under `mend run`, `mend logs` and `mend wait`: there
 * stdout carries the command's output (or `--json`) alone, so a script reads it as it is.
 */
let chrome: NodeJS.WriteStream = process.stdout;
const chromeToStderr = (): void => {
  chrome = process.stderr;
};

const paint = (code: string) => (text: string) => (chrome.isTTY ? `[${code}m${text}[0m` : text);
const dim = paint("2");
const green = paint("32");
const amber = paint("33");
const cobalt = paint("34");
const say = (line: string) => chrome.write(`${line}\n`);
const detachKeyEnabled = process.env["MEND_DETACH_KEY"] !== "none";
const detachHint = () => (detachKeyEnabled ? ` · detach: ${dim("Ctrl+]")}` : "");

type HerdrAgent = "codex" | "claude" | "opencode";

const herdrAgentOf = (harness: string): HerdrAgent | null => {
  if (harness === "codex" || harness === "claude" || harness === "opencode") return harness;
  return null;
};

const noHerdrHint = (): void => undefined;

const hintHerdrAttachment = (harness: string): (() => void) => {
  const agent = herdrAgentOf(harness);
  if (process.env["HERDR_ENV"] !== "1" || agent === null) return noHerdrHint;

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
  const started = Date.now();
  const call = `${method} ${route}`;
  try {
    response = await fetch(`${config.url}/api${route}`, {
      method,
      headers,
      // Spread, not `body: null` — fresh oxlint rejects a body key on GETs.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Only a connection that never opened is "cannot reach"; a request the server is still
    // working on (a first launch building an image) or one an edge cut says so instead.
    throw noAnswerError(error, config.url, call, Date.now() - started);
  }
  if (response.status === 401) {
    throw new MendRequestError(
      "http",
      config.token === null
        ? `not signed in to ${config.url} — run: mend login`
        : `unauthorized at ${config.url} — the saved token was rejected; run: mend login`,
      401,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw noAnswerError(error, config.url, call, Date.now() - started);
  }
  if (!response.ok) {
    let message = `${call} → ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { readonly message?: string };
      message = parsed.message ?? message;
    } catch {
      // not JSON — keep the status line
    }
    throw new MendRequestError("http", message, response.status);
  }
  // A route with nothing to return answers 204 with no body (`mend workspace replace`).
  if (text === "") return JSON.parse("null");
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

/**
 * A raw GET for a body that is not JSON (`mend pull`'s git bundle): the status, the headers and
 * the bytes come back for the caller to read. Only an unreachable server or a rejected sign-in
 * fails here, the way `request` words them.
 */
const download =
  (config: CliConfig): Download =>
  async (route) => {
    const headers: Record<string, string> = {};
    if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
    let response: Response;
    const started = Date.now();
    try {
      response = await fetch(`${config.url}/api${route}`, { headers });
    } catch (error) {
      return fail(noAnswerError(error, config.url, `GET ${route}`, Date.now() - started).message);
    }
    if (response.status === 401) {
      return fail(
        config.token === null
          ? `not signed in to ${config.url} — run: mend login`
          : `unauthorized at ${config.url} — the saved token was rejected; run: mend login`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, header: (name) => response.headers.get(name), bytes };
  };

/**
 * One upgrade ticket for a WebSocket this process is about to open (upgrade-url.ts). The saved
 * token travels in this call's Authorization header, never in the socket's URL. A server older
 * than tickets answers 404, which is the only case the token still rides a URL.
 */
let warnedLegacyBearer = false;
const mintTicket =
  (config: CliConfig, signal?: AbortSignal): MintTicket =>
  async (target, params) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
    const response = await fetch(`${config.url}/api/upgrade-tickets`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target, ...params }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) {
      if (await mintRefusedInTransit(config.url)) throw new Error(MINT_REFUSED_IN_TRANSIT);
      if (config.token !== null && !warnedLegacyBearer) {
        warnedLegacyBearer = true;
        console.error(
          "mend: this server predates upgrade tickets, so the saved token rides the socket's URL. Upgrade the server to stop that.",
        );
      }
      return { kind: "unsupported" };
    }
    if (!response.ok) throw new Error(`upgrade ticket refused (${response.status})`);
    const minted = (await response.json()) as { readonly ticket?: unknown };
    if (typeof minted.ticket !== "string")
      throw new Error("upgrade ticket missing from the answer");
    return { kind: "ticket", ticket: minted.ticket };
  };

/** A ready-to-connect WebSocket URL for one data plane, with a fresh ticket. */
const socketUrl = (
  config: CliConfig,
  target: UpgradeTarget,
  params: UpgradeParams,
  extra?: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<URL> =>
  upgradeUrl({
    serverUrl: parseMendUrl(config.url).toString(),
    target,
    params,
    ...(extra === undefined ? {} : { extra }),
    mint: mintTicket(config, signal),
    legacyToken: config.token,
  });

/** The same call bound to one config — the dependency ./pair.ts takes. */
const boundApi =
  (config: CliConfig): ApiCall =>
  <T>(method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown): Promise<T> =>
    api<T>(config, method, route, body);

/** A live elapsed-time spinner around a slow await — provisioning is not a hang. */
const withSpinner = async <T>(label: string | (() => string), work: Promise<T>): Promise<T> => {
  if (chrome.isTTY !== true) return work;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const text = typeof label === "string" ? label : label();
    // Clear first: a status line that got shorter must not leave the old one's tail behind.
    chrome.write(`\r\x1b[2K  ${frames[frame % frames.length]} ${text} ${dim(`${seconds}s`)} `);
    frame += 1;
  }, 120);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    chrome.write("\r\x1b[2K");
  }
};

/**
 * Start a session's agent (a launch, a resume, a handoff) and follow the session until the agent
 * runs (launch-follow.ts). The spinner carries the server's own words for what it is doing
 * (`starting · building the workspace image`), and a start call that times out or is cut by an
 * edge keeps following instead of calling the server unreachable. Null `start` follows a session
 * something else started.
 */
const followStarting = async (
  config: CliConfig,
  sessionId: string,
  label: string,
  start: Promise<SessionDto> | null,
): Promise<StartOutcome<SessionDto>> => {
  let line = label;
  // The poll timers go when the follow ends: a pending one would hold the process open.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  try {
    return await withSpinner(
      () => line,
      followStart<SessionDto>({
        start,
        read: () => request<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`),
        onLine: (next) => {
          // A bare `starting` says less than the label already on screen.
          line = next === "starting" ? label : next;
          if (chrome.isTTY !== true) say(dim(`  ${next}`));
        },
        sleep,
        now: Date.now,
      }),
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
};

/** A followed start's end for one-shot commands: the running session, or a line and exit 1. */
const startedOrExit = (
  config: CliConfig,
  sessionId: string,
  outcome: StartOutcome<SessionDto>,
): SessionDto => {
  const id8 = sessionId.slice(0, 8);
  switch (outcome.kind) {
    case "live":
      return outcome.session;
    case "refused":
      return fail(outcome.message);
    case "settled":
      return fail(
        `session ${id8} · ${startingLineOf(outcome.session)} before its agent ran · ${config.url}/sessions/${sessionId}`,
      );
    case "unreachable":
      return fail(
        `${outcome.message} · the session may still be starting · follow it: mend attach ${id8}`,
      );
  }
};

/** Start and follow, for one-shot commands. */
const startAndFollow = async (
  config: CliConfig,
  sessionId: string,
  label: string,
  start: Promise<SessionDto> | null,
): Promise<SessionDto> =>
  startedOrExit(config, sessionId, await followStarting(config, sessionId, label, start));

// ─── adopt ──────────────────────────────────────────────────────────────────

const adopt = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const nameFlag = args.indexOf("--name");
  const name =
    nameFlag !== -1 && args[nameFlag + 1] !== undefined ? String(args[nameFlag + 1]) : null;
  const authFlagIndex = args.indexOf("--auth");
  if (args.includes("--private") && args.includes("--shared")) {
    return fail("--private and --shared pick one visibility; pass one of them");
  }
  // Default: private. Only the adopter sees it until an owner shares it (docs/adr/0003).
  const visibility = args.includes("--shared") ? "shared" : "private";
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
    visibility,
    ...(auth === null ? {} : { gitAuthMode: auth }),
  });
  say(`${green("✓")} adopted · ${project.name} · ${dim(project.storePath)}`);
  say(`${dim("  default branch")} ${project.defaultBranch}`);
  say(
    `${dim("  visible to")} ${visibility === "private" ? "only you" : "everyone in the organization"}`,
  );
  // Say which signer did the work — the clone already proved it answers.
  if (project.gitAuthMode === "mend-key") {
    say(`${dim("  git auth")} mend key ${dim("(your Mend key signed this clone)")}`);
  } else if (project.gitAuthMode === "bridge") {
    say(`${dim("  git auth")} bridge ${dim("(signed through the connected `mend keys share`)")}`);
  }
  say(
    `${dim("  sessions start with:")} mend codex ${dim("(from anywhere —")} --project ${project.name}${dim(")")}`,
  );
  // Adopted from inside the checkout: say what Claude already learned about it here.
  const repoRoot = positional[0] === undefined ? cwdFacts(process.cwd()).repoRoot : null;
  const memory = repoRoot === null ? null : claudeMemoryDirFor(repoRoot);
  if (memory !== null) {
    const count = scanClaudeMemory(memory).files.length;
    say(
      `${dim("  claude memory")} ${count} file${count === 1 ? "" : "s"} on this machine ${dim("→ mend memory import")}`,
    );
  }
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
 * Cascade for the launch lifecycle: per-launch flag → project stance → the
 * organization's default → the instance's. A server without organization
 * defaults answers the instance's; any other read failure (a blip) stays
 * background — a network hiccup must never flip launch semantics to foreground.
 */
const resolvedBackgroundSessions = async (
  config: CliConfig,
  project: ProjectDto,
): Promise<boolean> => {
  if (project.backgroundSessions === "on") return true;
  if (project.backgroundSessions === "off") return false;
  try {
    const organization = await request<{
      readonly effective?: { readonly backgroundSessions?: boolean };
    }>(config, "GET", "/organization/settings");
    return organization.effective?.backgroundSessions !== false;
  } catch {
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

/** The signed-in account's id, or null from a server that cannot say (before organizations). */
const viewerIdOf = (config: CliConfig): Promise<string | null> =>
  request<{ readonly userId: string }>(config, "GET", "/organization").then(
    (view) => view.userId,
    () => null,
  );

/**
 * What each live session says about its workspace (docs/adr/0016, decisions 13 and 14): the
 * shared workspace line, the waiting line, the retirement line and, for the change's owner, how
 * to replace it. Read from the rows already fetched (the project view carries who is live and the
 * retirement's state when per-person homes are possible): the viewer only where someone is
 * listed live, the waiting line only where someone else is live with shared control on, the
 * retirement only where one is under way. With per-person homes off the rows list nobody and no
 * retirement, so nothing more is asked. An older server's 404 reads as nothing to say.
 */
const workspaceLinesOf = async (
  config: CliConfig,
  sessions: ReadonlyArray<SessionDto>,
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> => {
  const live = sessions.filter((session) => LIVE_STATUSES.has(session.status));
  if (!hasPersonFacts(live)) return new Map();
  const viewerRead = live.some((session) => (session.livePeople ?? []).length > 0)
    ? viewerIdOf(config)
    : Promise.resolve(null);
  const facts = await Promise.all(
    live.map(async (session) => {
      const reads = workspaceReadsOf(session);
      const [wait, retirement] = await Promise.all([
        reads.waiting
          ? request<ConversationWaitDto | null>(
              config,
              "GET",
              `/sessions/${session.id}/waiting`,
            ).catch(() => null)
          : null,
        reads.retirement
          ? request<WorkspaceRetirementDto | null>(
              config,
              "GET",
              `/sessions/${session.id}/workspace-retirement`,
            ).catch(() => null)
          : null,
      ]);
      return { session, wait, retirement };
    }),
  );
  const viewer = await viewerRead;
  const members = facts.some((fact) => fact.retirement !== null)
    ? await request<ReadonlyArray<MemberNameDto>>(config, "GET", "/organization/members").catch(
        () => [],
      )
    : [];
  return new Map(
    facts.map(({ session, wait, retirement }) => [
      session.id,
      workspaceLineList(
        sessionWorkspaceLines({
          sessionId: session.id,
          livePeople: session.livePeople ?? [],
          viewer,
          wait,
          retirement,
          members,
        }),
      ),
    ]),
  );
};

const launch = async (config: CliConfig, harness: string, args: ReadonlyArray<string>) => {
  // A run's stdout is its command's output (or --json); everything the CLI says goes to stderr.
  if (harness === "run") chromeToStderr();
  const parsed = parseLaunchArgs(args);
  if (parsed.error !== null) return fail(parsed.error);
  if (harness !== "run" && parsed.json) {
    return fail(`mend ${harness} takes no --json · mend run --json prints what it started`);
  }
  const structured =
    parsed.prompt !== null ||
    parsed.model !== null ||
    parsed.effort !== null ||
    parsed.ask ||
    parsed.fast;
  if (harness === "run" && structured) {
    return fail(`mend run takes no prompt or harness flags · ${usageOf("run")}`);
  }
  if (harness === "run" && parsed.autoLand !== null) {
    return fail(
      "mend run takes no landing flags — a command has no turns to land after; land it with mend land",
    );
  }
  if (harness === "run" && parsed.foreground) {
    return fail(
      "mend run takes no --foreground — Ctrl+C stops watching, not the command; mend stop ends it",
    );
  }
  const argv = harness === "run" ? parsed.custom : (HARNESS_COMMANDS[harness] ?? []);
  if (argv.length === 0) {
    return fail(harness === "run" ? usageOf("run") : `unknown harness ${harness}`);
  }
  // What the platform would refuse once the session exists, refused here with nothing created.
  const argvIssue = harness === "run" ? runArgvIssue(argv) : null;
  if (argvIssue !== null) return fail(`${argvIssue} · nothing was created`);

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
  // The project view, read once: the join check below reads the same rows.
  let projectView: ProjectDetailDto | null = null;
  if (parsed.worktree !== null) {
    const detail = await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`);
    projectView = detail;
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
    const detail =
      projectView ??
      (await api<ProjectDetailDto>(config, "GET", `/projects/${project.id}`).catch(() => null));
    const joined = detail?.worktrees?.find((worktree) => worktree.name === worktreeName);
    if (joined !== undefined) {
      const members = (detail?.sessions ?? []).filter(
        (candidate) => candidate.worktreeId === joined.id,
      ).length;
      say(
        `${green("✓")} joins worktree ${joined.name} ${dim(`· ${members} session${members === 1 ? "" : "s"} · branch ${joined.branch}`)}`,
      );
      // Where two people meet (docs/adr/0016, decision 13): said before the session starts,
      // from the project view's rows. The viewer is asked for only where the worktree lists
      // someone live; the CLI keeps no account id, so the shared-home line (which needs the
      // viewer where nobody is listed) is not said here.
      const rows = detail?.sessions ?? [];
      const viewer = worktreeListsPeople(rows, joined.id) ? await viewerIdOf(config) : null;
      const joinLine = worktreeJoinLine(rows, joined.id, viewer);
      if (joinLine !== null) say(`${amber("·")} ${joinLine}`);
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
    ...(parsed.autoLand === null ? {} : { autoLand: parsed.autoLand }),
  });
  createdSessionId = session.id;
  say(`${green("✓")} worktree ${session.worktree} ${dim(`· branch ${session.branch}`)}`);
  const landing = autoLandLine(parsed.autoLand, project);
  if (landing !== null) say(landing);
  const baseWord = session.baseRef === null ? "" : `${session.baseRef} `;
  say(
    `${green("✓")} base ${baseWord}${dim(session.baseSha.slice(0, 12))} · session ${dim(session.id.slice(0, 8))}`,
  );
  say(`${cobalt("  watch")} · ${config.url}/sessions/${session.id}`);

  // Everything runs SUPERVISED (SDK 0.7.0): a workspace mounts the worktree,
  // a platform PTY runs argv, the record begins. Commands tail the record;
  // interactive harnesses get the full terminal bridge.
  if (harness === "run") {
    return supervisedRun(config, session, argv, { detach: parsed.detach, json: parsed.json });
  }
  // A harness start sends no argv, flags or not: the server composes the harness's own flags
  // (one shared mapping), applies its default model when none is named and records what runs
  // (docs/models-audit.md), and names the session from the prompt immediately.
  const launchBody = {
    ...(parsed.prompt === null ? {} : { prompt: parsed.prompt }),
    ...(parsed.model === null ? {} : { model: parsed.model }),
    ...(parsed.effort === null ? {} : { effort: parsed.effort }),
    ...(parsed.ask ? { permissionMode: "ask" } : {}),
    ...(parsed.fast ? { speed: "fast" } : {}),
  };
  await startAndFollow(
    config,
    session.id,
    "provisioning workspace — a first launch builds the harness image (can take minutes)…",
    request<SessionDto>(config, "POST", `/sessions/${session.id}/launch`, launchBody),
  );
  if (lifecycle === "detach") {
    say(`${green("✓ recording")} · running detached`);
    say(`${cobalt("  attach")} · mend attach ${session.id.slice(0, 8)}`);
    return;
  }
  say(`${green("✓ recording")} · workspace mounts the worktree${detachHint()}`);
  // A new session has no Services yet; the agent's appear as it starts them.
  const tunnels = attachTunnels(config, parsed.noTunnel);
  await tunnels?.start(session.id);
  say("");
  attachOwnsSignals = true;
  await attachOrExit(config, session.id, session.harness, lifecycle, tunnels);
  exitAfterSessionEnd(config, session.id);
};

/**
 * What `--land` / `--no-land` did, said once at launch; null without either flag. A project set
 * to off wins over the session's own override (docs/adr/0007, "When it is on").
 */
const autoLandLine = (override: boolean | null, project: ProjectDto): string | null => {
  if (override === null) return null;
  if (override && project.autoLand === "off") {
    return `${amber("·")} automatic landing · off for ${project.name} · the project's setting wins over --land`;
  }
  return `${green("✓")} automatic landing · ${override ? "on" : "off"} for this session ${dim("· from this terminal, land with mend land")}`;
};

// ─── the terminal bridge: raw stdin/stdout against the platform PTY ─────────

/**
 * How long an attach waits for the server to open the terminal: the ticket, then the upgrade,
 * which the server answers only once the platform attached the PTY.
 */
const ATTACH_CONNECT_TIMEOUT_MS = (() => {
  const configured = Number(process.env["MEND_ATTACH_TIMEOUT_MS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
})();

/** What an attach says while the server has not opened the terminal yet, once a second. */
const connectingLine = (sessionId: string, elapsedMs: number): string =>
  `\r\x1b[2K  connecting to ${sessionId.slice(0, 8)} · ${Math.round(elapsedMs / 1000)}s · ${detachKeyEnabled ? "Ctrl+] or " : ""}Ctrl+C cancels`;

/**
 * Put this terminal in raw mode for an attach, before anything waits on the server: a terminal
 * left cooked echoes every key locally and sends nothing until Enter. When it cannot be done the
 * attach still runs, and says why on stderr instead of echoing silently.
 */
const takeTerminal = (): { readonly raw: boolean } => {
  if (process.stdin.isTTY !== true) {
    console.error(
      "mend: stdin is not a terminal, so it cannot be put in raw mode — keys reach the session a line at a time and echo here",
    );
    return { raw: false };
  }
  try {
    process.stdin.setRawMode(true);
  } catch (error) {
    console.error(
      `mend: could not put this terminal in raw mode (${error instanceof Error ? error.message : String(error)}) — keys reach the session a line at a time and echo here`,
    );
    return { raw: false };
  }
  if (!process.stdin.isRaw) {
    console.error(
      "mend: this terminal did not accept raw mode — keys reach the session a line at a time and echo here",
    );
    return { raw: false };
  }
  return { raw: true };
};

/** How long an attach waits, once connected, for the detail that says whether the caller types. */
const WATCH_READ_GRACE_MS = 3_000;

/**
 * The terminal's size as the PTY should read it. A pty whose size was never set reads 0×0.
 */
const terminalSize = (): { readonly cols: number; readonly rows: number } => ({
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
});

/**
 * Attach this terminal to the session's PTY through the Mend server over ONE
 * WebSocket: binary frames are PTY bytes both ways, text frames carry control
 * JSON (resize up, end down). Auth happens once at connect (?ticket=); after
 * that a keystroke is a frame on an open socket — nothing else on the path.
 * Ctrl+] detaches — the session keeps running and can be reattached from
 * anywhere. Resolves when the session settles or the user detaches; the
 * caller decides what each outcome means (commands exit, the dashboard
 * resumes). With `handleSignals`, a terminal-window close (SIGHUP) or kill
 * resolves `interrupted` through the same restore path instead of leaving
 * raw mode pushed — the handler never exits the process itself.
 *
 * The terminal goes raw FIRST, then the ticket and the upgrade are asked for,
 * each bounded: a slow server shows `connecting · 12s` and can be cancelled,
 * never a cooked terminal that echoes keys and waits forever. Once open, the
 * size goes up twice (one row short, then the real one) so a full-screen agent
 * that only repaints on SIGWINCH redraws at once.
 *
 * Only the session's owner types in its terminal (docs/adr/0013). Anyone else
 * watches: the CLI says whose terminal it is, sends no keys or resizes, and
 * Ctrl+] or Ctrl+C detach.
 */
const attachTty = async (
  config: CliConfig,
  sessionId: string,
  harness: string,
  from: bigint,
  processId?: string,
  options?: { readonly readOnly?: boolean; readonly handleSignals?: boolean },
): Promise<AttachOutcome> => {
  const interactive = options?.readOnly !== true;
  const rawModeEnabled = interactive ? takeTerminal().raw : false;
  const connecting = new AbortController();
  let abortReason: "detached" | "interrupted" | "no-answer" | null = null;
  const abort = (reason: "detached" | "interrupted" | "no-answer") => {
    abortReason ??= reason;
    connecting.abort();
  };

  let ws: WebSocket | null = null;
  // Read once the session's detail answers: someone else's terminal is watched, not typed in.
  let watching = false;
  let detached = false;
  let sawEnd = false;
  let interrupted = false;
  let finishAttachment: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finishAttachment = resolve;
  });
  const onSignal = () => {
    // Resolve the attach instead of exiting: the shared `finally` restores raw
    // mode and closes the socket, then the caller decides what the signal means.
    interrupted = true;
    abort("interrupted");
    ws?.close();
    finishAttachment?.();
  };
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
  const sendResize = (size = terminalSize()) => {
    if (watching || ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "resize", cols: size.cols, rows: size.rows }));
  };
  const onWinch = () => sendResize();
  let bracketedPaste = false;
  // Until the agent's first bytes: say it is starting instead of a blank screen (`firstOutputGate`).
  let starting: FirstOutputGate | null = null;
  const onTtyFrame = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      const bytes = Buffer.from(event.data);
      if (bytes.length === 0) return;
      starting?.pass();
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
      ws?.close();
      finishAttachment?.();
    } catch {
      // Unknown text control frame — ignore.
    }
  };
  const forward = (bytes: Buffer) => {
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(bytes).buffer);
  };
  const onKeys = (data: Buffer) => {
    if (ws === null) {
      // Still connecting: nothing reads keys yet. Ctrl+] detaches and Ctrl+C interrupts, as they
      // would once attached; any other key is dropped rather than typed blind into an agent that
      // has not drawn yet.
      if (detachKeyEnabled && isDetachChunk(data)) abort("detached");
      else if (data.includes(0x03)) abort("interrupted");
      return;
    }
    if (watching) {
      // The owner's terminal: Ctrl+] or Ctrl+C leave it, and nothing else reaches it.
      if (watchKey(data, detachKeyEnabled) === null) return;
      detached = true;
      ws.close();
      finishAttachment?.();
      return;
    }
    if (detachKeyEnabled && isDetachChunk(data)) {
      // Ctrl+] — detach, leave the session running. Matched in both its
      // encodings: the inner TUI may have switched the user's terminal onto
      // the kitty keyboard protocol, where the key arrives as CSI-u. The
      // terminal comes back now, not after the server's close handshake.
      detached = true;
      ws.close();
      finishAttachment?.();
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

  /** The ticket, then the upgrade — both abandoned on cancel, a signal or the timeout. */
  const connect = async (): Promise<WebSocket | "unavailable" | "aborted"> => {
    // Process addressing reaches any PTY in the workspace (a shell); the
    // session form remains the agent's PTY.
    let url: URL;
    try {
      url = await socketUrl(
        config,
        "tty",
        processId === undefined ? { session: sessionId } : { process: processId },
        { from: from.toString() },
        connecting.signal,
      );
    } catch {
      return connecting.signal.aborted ? "aborted" : "unavailable";
    }
    if (connecting.signal.aborted) return "aborted";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const opened = await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false);
      connecting.signal.addEventListener("abort", onAbort, { once: true });
      const settle = (value: boolean) => {
        connecting.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      socket.addEventListener("open", () => settle(true), { once: true });
      socket.addEventListener("error", () => settle(false), { once: true });
    });
    if (opened && !connecting.signal.aborted) return socket;
    socket.close();
    return connecting.signal.aborted ? "aborted" : "unavailable";
  };

  // Whether this caller types, from the session's detail; read beside the upgrade, never after it.
  const detailRead: Promise<SessionDetailLiteDto | null> = interactive
    ? request<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`).catch(() => null)
    : Promise.resolve(null);

  const started = Date.now();
  let connectingShown = false;
  const connectingTimer = setInterval(() => {
    if (process.stdout.isTTY !== true) return;
    connectingShown = true;
    process.stdout.write(connectingLine(sessionId, Date.now() - started));
  }, 1000);
  const deadline = setTimeout(() => abort("no-answer"), ATTACH_CONNECT_TIMEOUT_MS);
  const stopConnecting = () => {
    // One clear for both (Node's clearTimeout clears an interval too).
    for (const timer of [connectingTimer, deadline]) clearTimeout(timer);
    if (connectingShown) process.stdout.write("\r\x1b[2K");
    connectingShown = false;
  };
  let stopHerdrHint = noHerdrHint;
  try {
    if (options?.handleSignals === true) for (const signal of signals) process.on(signal, onSignal);
    // Read-only (logs): never forward stdin — Ctrl+C exits the CLI, the
    // socket drops, and the process inside keeps running untouched.
    if (interactive) {
      process.stdin.on("data", onKeys);
      process.stdin.resume();
    }
    // Whose terminal this is, before the socket opens: an open socket's output is read from the
    // moment it opens. A detail that has not answered in time is treated as typing; the server
    // drops a watcher's keys whatever this side decides.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const detail = await Promise.race([
      detailRead,
      new Promise<null>((resolve) => {
        graceTimer = setTimeout(() => resolve(null), WATCH_READ_GRACE_MS);
      }),
    ]);
    clearTimeout(graceTimer);
    if (watchesTerminal(detail)) {
      watching = true;
      const members = await request<
        ReadonlyArray<{ readonly userId: string; readonly name: string }>
      >(config, "GET", "/organization/members").catch(() => []);
      process.stdout.write(
        `\r\x1b[2K${dim(watchNotice(ownerNameOf(detail?.session.ownerUserId, members)))}\r\n` +
          `${dim(`read-only · ${detachKeyEnabled ? "Ctrl+] or " : ""}Ctrl+C detaches`)}\r\n\r\n`,
      );
    }
    const connected = await connect();
    stopConnecting();
    if (connected === "unavailable") return "unavailable";
    if (connected === "aborted") return abortReason ?? "interrupted";
    ws = connected;
    // The agent's own terminal, interactive, on a terminal that shows it: an agent that has not
    // drawn yet reads as starting, with the facts from its detail once they answer.
    if (interactive && processId === undefined && process.stdout.isTTY === true) {
      const gate = firstOutputGate({
        label: startingLabelOf(harness),
        write: (text) => process.stdout.write(text),
        now: Date.now,
        cancelHint: detachKeyEnabled ? "Ctrl+] detaches" : "",
      });
      starting = gate;
      void detailRead.then((read) => {
        if (read !== null) {
          gate.update(agentStartingFacts(read.currentAgent, read.processes, Date.now()));
        }
        return null;
      });
    }
    stopHerdrHint = hintHerdrAttachment(harness);
    const onClose = () => finishAttachment?.();
    if (ws.readyState === WebSocket.CLOSED) finishAttachment?.();
    else ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("message", onTtyFrame);
    // One row short, then the real size: the PTY sees a size change either way, so the agent
    // gets SIGWINCH and repaints now instead of on the first key.
    const size = terminalSize();
    if (size.rows > 1) sendResize({ cols: size.cols, rows: size.rows - 1 });
    setTimeout(() => sendResize(), 80);
    process.stdout.on("resize", onWinch);
    await finished;
    return detached ? "detached" : interrupted ? "interrupted" : sawEnd ? "ended" : "dropped";
  } finally {
    stopConnecting();
    starting?.stop();
    for (const signal of signals) process.off(signal, onSignal);
    process.stdin.off("data", onKeys);
    process.stdout.off("resize", onWinch);
    ws?.removeEventListener("message", onTtyFrame);
    if (rawModeEnabled) process.stdin.setRawMode(false);
    if (interactive && ws !== null && process.stdout.isTTY === true) {
      // The inner TUI's terminal modes leaked onto OUR terminal through the
      // byte bridge — kitty keyboard protocol, bracketed paste, mouse
      // reporting, alternate screen, hidden cursor. The TUI keeps running
      // remotely; the local terminal must come back to shell sanity, or every
      // keystroke after a detach arrives as CSI-u junk. A reattach replays
      // the session from 0, which re-establishes whatever the TUI had set.
      process.stdout.write(TERMINAL_MODES_RESET);
    }
    process.stdin.pause();
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
      ws.close();
    stopHerdrHint();
  }
};

/**
 * What brings this terminal back to shell sanity after a remote program's bytes set its modes: the
 * kitty keyboard protocol, bracketed paste, mouse reporting, the alternate screen, a hidden cursor.
 */
const TERMINAL_MODES_RESET =
  "\x1b[<u\x1b[=0;1u" + // pop the kitty keyboard stack, then force flags 0
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse reporting off
  "\x1b[?1049l" + // leave the alternate screen (no-op when already left)
  "\x1b[?25h"; // show the cursor

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

/** What a terminal the server never opened reads as — the session itself is untouched. */
const noAnswerLine = (config: CliConfig, id8: string): string =>
  `${amber("no answer")} — ${config.url} did not open the terminal within ${spoken(ATTACH_CONNECT_TIMEOUT_MS)}; the session keeps running · try again: mend attach ${id8} · check the server: mend doctor`;

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
  if (outcome === "no-answer") {
    say("");
    say(noAnswerLine(config, id8));
    if (mode === "foreground") return stopAndExit(config, sessionId);
    process.exit(1);
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
  tunnels: AttachTunnels | null = null,
) =>
  finishAttach(
    config,
    sessionId,
    await attachWithTunnels(tunnels, () =>
      attachTty(config, sessionId, harness, 0n, undefined, { handleSignals: true }),
    ),
    mode,
  );

/** The attach itself, with the session's tunnels (when any) stated on the bottom row meanwhile. */
const attachWithTunnels = (
  tunnels: AttachTunnels | null,
  work: () => Promise<AttachOutcome>,
): Promise<AttachOutcome> => (tunnels === null ? work() : tunnels.attached(work));

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
  const tunnels = attachTunnels(config, args.includes("--no-tunnel"));
  // No id: the picker IS the selection surface (the resolution `mend shell`
  // already uses), so attaching never demands an id the user must go look up.
  if (prefix === undefined) {
    const picked = await resolveLiveSession(config, undefined, "attach");
    return attachPicked(config, picked, tunnels);
  }
  const sessions = await api<ReadonlyArray<SessionDto>>(config, "GET", "/sessions");
  const match = sessions.find((s) => s.id.startsWith(prefix));
  if (match === undefined) return fail(`no active session matches "${prefix}"`);
  return attachPicked(config, match, tunnels);
};

/** Attach to one resolved session — the tail both `mend attach` paths share. */
const attachPicked = async (
  config: CliConfig,
  session: SessionDto,
  tunnels: AttachTunnels | null,
): Promise<never> => {
  say(
    `${green("✓")} attaching to ${sessionDisplayName(session)} · ${session.harness} ${dim(session.id.slice(0, 8))}${detachHint()}`,
  );
  // A session still starting has no terminal yet: follow it until its agent runs, then attach.
  if (session.status === "starting") {
    await startAndFollow(config, session.id, "starting — attaching once the agent runs…", null);
  }
  await tunnels?.start(session.id);
  say("");
  const outcome = await attachWithTunnels(tunnels, () =>
    attachTty(config, session.id, session.harness, 0n, undefined, {
      handleSignals: true,
    }),
  );
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
      await startAndFollow(
        config,
        session.id,
        "reopening as a terminal — same conversation…",
        request<SessionDto>(config, "POST", `/sessions/${session.id}/handoff`, { to: "pty" }),
      );
      say("");
      await attachOrExit(config, session.id, session.harness, "background", tunnels);
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
  if (args.includes("--services")) {
    const prefix = args.find((arg) => !arg.startsWith("--"));
    const session = await resolveLiveSession(config, prefix, "stop --services");
    await stopServicesOf(config, session);
    return;
  }
  const all = args.includes("--all");
  const projectFlag = args.indexOf("--project");
  const projectName =
    projectFlag !== -1 && args[projectFlag + 1] !== undefined
      ? String(args[projectFlag + 1])
      : null;
  const prefix = firstPositional(args, ["--project"]);
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
    // A stop ends the agent and leaves Services running; say so, with their own stop.
    const after = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${session.id}`).catch(
      () => null,
    );
    const hold =
      after === null
        ? null
        : servicesHoldOf(after.session, after.currentAgent, after.liveServices ?? 0);
    if (hold !== null) {
      say(`${amber("  " + hold)} · mend stop --services ${session.id.slice(0, 8)}`);
    }
    // Capture mode: the workspace goes once it has saved (docs/adr/0002); say what is left.
    const capture = after === null ? null : captureLineOf(after.session);
    if (capture !== null) {
      say(`${amber("  " + capture)} · the workspace stops once nothing is pending`);
    }
    say(`${cobalt("  review")} · ${config.url}/sessions/${session.id}`);
  }
  if (summarise) {
    say(`${green("✓")} stopped ${targets.length} session${targets.length === 1 ? "" : "s"}`);
  }
};

/** Stop every live Service of the session; the workspace ends once nothing is live. */
const stopServicesOf = async (config: CliConfig, session: SessionDto): Promise<void> => {
  const result = await api<{ readonly stopped: number }>(
    config,
    "POST",
    `/sessions/${session.id}/services/stop`,
  );
  if (result.stopped === 0) {
    say(`no live services · ${session.harness} · ${dim(session.id.slice(0, 8))}`);
    return;
  }
  say(
    `${green("✓")} stopped ${result.stopped} service${result.stopped === 1 ? "" : "s"} · ${session.harness} · ${dim(session.id.slice(0, 8))} · ${session.branch}`,
  );
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
    return fail("no live or retained session — start one with mend codex|claude|opencode|pi");
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
  if (outcome === "no-answer") {
    say(noAnswerLine(config, session.id.slice(0, 8)));
    process.exit(1);
  }
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
    readonly browserScheme: "http" | "https" | null;
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
  readonly browserScheme: "http" | "https" | null;
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
    browserScheme: view.service.browserScheme,
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
  const needle = firstPositional(args, ["--from"]);
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
  for (const service of services) {
    const port = portOverride ?? service.hostPort ?? service.workspacePort;
    // One ticket per local connection: a ticket opens one tunnel once.
    const server = net.createServer((socket) =>
      pumpConnection(socket, tunnelUrlFor(config, service.id)),
    );
    await listenLocal(server, port, false).catch((error: NodeJS.ErrnoException) =>
      fail(
        error.code === "EADDRINUSE"
          ? `127.0.0.1:${port} is already in use here — pick one with: mend service connect ${service.label} --port <n>`
          : error.message,
      ),
    );
    say(
      `${green("●")} ${service.label ?? service.id.slice(0, 8)} → 127.0.0.1:${port} ${dim(`(tunnel to ${config.url})`)}`,
    );
  }
  say(dim("  connections are authenticated as you · Ctrl-C stops"));
  // The listeners keep the process alive until the user stops it.
  await new Promise(() => {});
};

/** A fresh single-use URL for one connection through the Service tunnel. */
const tunnelUrlFor = (config: CliConfig, serviceId: string): Promise<URL> =>
  socketUrl(config, "service-tunnel", { service: serviceId });

/**
 * Attach tunnels: the session's live browser Services on this machine's loopback for as long as
 * this terminal is attached (service-tunnels.ts). Null on a local server — the bound authority
 * already answers here — or when the caller opted out with --no-tunnel.
 */
const attachTunnels = (config: CliConfig, optOut: boolean): AttachTunnels | null => {
  if (optOut || serverIsLocal(config)) return null;
  let attached = false;
  const tell = (line: string): void => {
    if (!attached) {
      say(line);
      return;
    }
    // The agent's TUI owns the screen: state it on the bottom row and put the cursor back,
    // so the TUI's own drawing stays where it left it. Its next repaint of that row wins.
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${line}\x1b8`);
  };
  const tunnels = createServiceTunnels({
    listServices: () => fetchServices(config),
    tunnelUrl: (serviceId) => tunnelUrlFor(config, serviceId),
    events: serverEvents(config),
    onOpen: (tunnel) => tell(`${green("●")} ${tunnel.line} ${dim("· tunnel, closes on detach")}`),
    onClose: (tunnel, reason) => {
      if (reason === "stopped") tell(dim(`○ ${tunnel.service.label} stopped · tunnel closed`));
    },
    onError: (service, message) => tell(amber(`${service.label} not tunneled · ${message}`)),
  });
  return {
    start: async (sessionId) => {
      // A slow server must not hold the terminal: whatever is not open yet opens mid-attach.
      await Promise.race([
        tunnels.focus(sessionId),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    },
    attached: <A>(work: () => Promise<A>): Promise<A> => {
      attached = process.stdout.isTTY === true;
      return work().finally(() => {
        attached = false;
      });
    },
    close: () => tunnels.close(),
  };
};

interface AttachTunnels {
  /** Open the session's tunnels now, printing one line each. */
  readonly start: (sessionId: string) => Promise<void>;
  /** Run an attach; tunnels opening or closing meanwhile are stated on the bottom row. */
  readonly attached: <A>(work: () => Promise<A>) => Promise<A>;
  readonly close: () => void;
}

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

// ─── memory: the agents' memory per person per project (docs/adr/0009) ───────

interface AgentMemoryEntryDto {
  readonly path: string;
  readonly harness: string;
  readonly name: string;
  readonly bytes: number;
  readonly updatedAt: string;
  readonly updatedBySession: string | null;
}

const kilobytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/**
 * A file named as `mend memory` lists it: `MEMORY.md` (Claude's), `codex:MEMORY.md` (another
 * harness's, by the harness column), `memories_1.sqlite` (a single memory file), or its full path.
 */
const memoryPathOf = (name: string): string => {
  if (name.startsWith(".")) return name;
  const single = AGENT_MEMORY_FILES.find((file) => file.path.endsWith(`/${name}`));
  if (single !== undefined) return single.path;
  const qualified = /^([a-z]+):(.+)$/.exec(name);
  const harness = qualified?.[1] ?? "claude";
  const rest = qualified?.[2] ?? name;
  const root = AGENT_MEMORY_ROOTS.find((candidate) => candidate.harness === harness)?.root;
  return root === undefined ? name : `${root}/${rest}`;
};

const memoryImport = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const repoRoot = cwdFacts(process.cwd()).repoRoot;
  if (repoRoot === null) return fail("run mend memory import inside the repository's checkout");
  const claudeDir = claudeMemoryDirFor(repoRoot);
  const claude = claudeDir === null ? null : scanClaudeMemory(claudeDir);
  const codex = await scanCodexMemory(repoRoot);
  for (const note of [...(claude?.notes ?? []), ...codex.notes]) say(dim(`  ${note}`));
  const files = [...(claude?.files ?? []), ...codex.files];
  if (files.length === 0) {
    return fail(`neither claude nor codex keeps memory for ${repoRoot} on this machine`);
  }
  const project = await findProject(config, takeFlagValue(args, "--project"));
  if (claude !== null && claude.files.length > 0) {
    say(
      `claude memory · ${claude.dir} · ${claude.files.length} file${claude.files.length === 1 ? "" : "s"}`,
    );
  }
  if (codex.files.length > 0) {
    say(
      `codex memory · ${codex.home} · ${codex.summaries} conversation summar${codex.summaries === 1 ? "y" : "ies"} of this repository`,
    );
  }
  // The same plan either way: a dry run asks the server what the import would do, and writes
  // nothing. This checkout on this machine is named, so the next import from here merges against
  // what this one sent.
  const dryRun = args.includes("--dry-run");
  // A dry run writes nothing here either: no machine id is made for it.
  const source = importSourceFor(mendCliHome(), repoRoot, { create: !dryRun });
  const report = await withSpinner(
    dryRun ? "planning" : "importing",
    api<ImportReport>(
      config,
      "POST",
      `/projects/${project.id}/memory/import${dryRun ? "/plan" : ""}`,
      source === null ? { files } : { files, source },
    ),
  );
  say(
    `${dryRun ? "would import" : green("imported")} into ${project.name} · ${importReportCounts(report)}`,
  );
  for (const line of importReportLines(report)) say(dim(line));
  say(
    dim(
      dryRun
        ? "--dry-run: nothing written"
        : "every version replaced is kept · sessions in the project receive it from the next launch",
    ),
  );
};

/** `mend memory`: what the agents remember about a project, for you. */
const memoryCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  if (verb === "import") return memoryImport(config, rest);
  const flags = verb === "show" || verb === "rm" ? rest : args;
  const project = await findProject(config, takeFlagValue(flags, "--project"));
  const base = `/projects/${project.id}/memory`;
  if (verb === "show" || verb === "rm") {
    const name = rest.find(
      (arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--project",
    );
    if (name === undefined) return fail(usageOf(`memory ${verb}`));
    const query = `?path=${encodeURIComponent(memoryPathOf(name))}`;
    if (verb === "rm") {
      const removed = await api<{ readonly removed: boolean }>(
        config,
        "DELETE",
        `${base}/file${query}`,
      );
      return say(
        removed.removed ? `removed ${name} · kept as a version` : `${name}: not in memory`,
      );
    }
    const file = await api<{ readonly encoding: string; readonly contents: string }>(
      config,
      "GET",
      `${base}/file${query}`,
    );
    process.stdout.write(
      file.encoding === "utf8" ? file.contents : Buffer.from(file.contents, "base64"),
    );
    return;
  }
  const view = await api<{ readonly files: ReadonlyArray<AgentMemoryEntryDto> }>(
    config,
    "GET",
    base,
  );
  if (view.files.length === 0) {
    say(
      `${project.name}: no agent memory yet ${dim("· mend memory import brings this machine's")}`,
    );
    return;
  }
  const width = Math.max(...view.files.map((file) => file.name.length));
  for (const file of view.files) {
    say(
      `${file.harness.padEnd(7)} ${file.name.padEnd(width)}  ${kilobytes(file.bytes).padStart(8)}  ${dim(
        `${file.updatedAt.slice(0, 16).replace("T", " ")} · ${
          file.updatedBySession === null
            ? "imported"
            : `session ${file.updatedBySession.slice(0, 8)}`
        }`,
      )}`,
    );
  }
};

// ─── secrets: the person's secret files (docs/adr/0010) ───────────────────────

/** `mend secrets`: the files written into every workspace a session of yours launches in. */
const secretsCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [verb, ...rest] = args;
  if (verb === "add" || verb === "rm") {
    const given = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--from");
    if (given === undefined) return fail(usageOf(`secrets ${verb}`));
    const resolved = secretFilePathOf(given, os.homedir());
    if (resolved.issue !== null) return fail(resolved.issue);
    if (verb === "rm") {
      const removed = await api<{ readonly removed: boolean }>(
        config,
        "DELETE",
        `/me/secret-files?path=${encodeURIComponent(resolved.path)}`,
      );
      return say(
        removed.removed
          ? `removed ~/${resolved.path} ${dim("· sessions launched from now on do not receive it")}`
          : `~/${resolved.path}: not kept`,
      );
    }
    const from = takeFlagValue(rest, "--from");
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(from ?? 0);
    } catch (error) {
      return fail(
        from === null
          ? `nothing on stdin: pass --from <file> or pipe the content in`
          : `${from}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bytes.byteLength === 0)
      return fail(from === null ? "nothing on stdin" : `${from} is empty`);
    const saved = await api<{
      readonly file: SecretFileDto;
      readonly action: "created" | "replaced";
    }>(config, "PUT", "/me/secret-files", secretFileUploadOf(resolved.path, bytes));
    say(
      `${green(saved.action)} ~/${saved.file.path} · ${saved.file.bytes} B ${dim(
        "· sessions launched from now on receive it",
      )}`,
    );
    return;
  }
  if (verb !== undefined && verb !== "list") return fail(usageOf("secrets"));
  const view = await api<{ readonly files: ReadonlyArray<SecretFileDto> }>(
    config,
    "GET",
    "/me/secret-files",
  );
  if (view.files.length === 0) {
    say(`no secret files ${dim("· mend secrets add <path> --from <file> keeps one")}`);
    return;
  }
  for (const line of secretFileLines(view.files)) say(line);
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
    account.status === "active"
      ? "connected"
      : account.status === "invalid"
        ? "reconnect needed · the provider refused the login"
        : account.status,
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
const accountsLines = async (config: CliConfig): Promise<ReadonlyArray<string>> => {
  const identity = await request<SealantIdentityDto>(config, "GET", "/me/sealant");
  const providers: ReadonlyArray<ConnectedAccountProvider> = ["claude", "codex", "github"];
  return [
    `platform user ${identity.sealantUserId}`,
    ...providers.map((provider) => {
      const account =
        identity.accounts.find((row) => row.provider === provider && row.name === "default") ??
        identity.accounts.find((row) => row.provider === provider);
      return `  ${account === undefined ? `${provider.padEnd(8)} not connected` : accountLine(account)}`;
    }),
  ];
};

const accountsCommand = async (config: CliConfig) => {
  let lines: ReadonlyArray<string>;
  try {
    lines = await accountsLines(config);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  for (const line of lines) process.stdout.write(`${line}\n`);
};

/** The Claude grant Mend keeps for itself on this machine, for `mend doctor`. */
const claudeGrantSecret = (): string | null => {
  const read = readGrant(claudeGrantDir(mendCliHome()));
  return read.kind === "missing" ? null : read.secret;
};

/**
 * `mend doctor --bundle`: the collectors, wired to this process's server, credentials and
 * environment. Every read the bundle makes is one an existing command already makes.
 */
const doctorBundle = (config: CliConfig, args: ReadonlyArray<string>) =>
  doctorBundleCommand(args, {
    defaultDir: path.join(mendCliHome(), "bundles"),
    now: () => new Date(),
    say,
    warn: (line) => process.stderr.write(`${line}\n`),
    collectors: (tail) =>
      bundleCollectors({
        cliVersion: cliVersion(),
        serverUrl: config.url,
        configuredUrl: config.configuredUrl,
        deviceId: config.deviceId,
        tokenSaved: config.token !== null,
        env: process.env,
        stdinTty: process.stdin.isTTY === true,
        stdoutTty: process.stdout.isTTY === true,
        get: (route) => request(config, "GET", route),
        doctor: async () => {
          const checks = await runChecks(config, {
            localCredential,
            claudeGrant: claudeGrantSecret,
            onPath,
          });
          return `${checks.map((check) => formatCheck(check)).join("\n")}\n`;
        },
        accounts: async () => `${(await accountsLines(config)).join("\n")}\n`,
        run: (command, commandArgs, timeoutMs) =>
          runServerProcess(command, commandArgs, process.env, { timeoutMs }),
        readServer: () => readServerInstallationFacts(nodeServerRuntime().configDir),
        pathOf,
        tail,
      }),
  });

/** A moment as a person reads it beside a credential, or `unknown` when nothing said. */
const minuteOrUnknown = (at: Date | null): string =>
  at === null ? "unknown" : at.toISOString().slice(0, 16);

/**
 * Why a grant is unusable even though Claude calls it logged in, or null when it is fine. Claude
 * reports `loggedIn` from what it stored, so a cleared refresh token or one past its own expiry
 * still reads healthy (ADR 0005, states 3 and 4).
 */
const staleGrantReason = (secret: string): string | null => {
  const facts = claudeGrantFacts(secret);
  if (facts === null) return null;
  if (!facts.hasRefreshToken) return "signed out";
  return facts.refreshExpiresAt !== null && facts.refreshExpiresAt.getTime() <= Date.now()
    ? `expired ${facts.refreshExpiresAt.toISOString().slice(0, 10)}`
    : null;
};

/**
 * A Claude login of Mend's own (ADR 0005), made fresh on every connect (ADR 0008): the browser
 * login runs against a throwaway directory, the grant is read, and the directory is deleted. The
 * server is the login's only refresher from then on, so a kept copy would soon hold a spent
 * refresh token, and sending it again would replace a good login with a dead one (alpha
 * 2026-10-01). Returns the credential to send, or null after saying why it could not get one.
 *
 * The person's own login is probed before and after, because the one thing nobody has verified is
 * whether Anthropic lets one account hold two live grants. If the second login signs the first one
 * out, this is where a person finds out — from Mend, in plain words, rather than from a failure
 * hours later.
 */
const claudeGrant = async (): Promise<string | null> => {
  const cli = claudeCli();
  const home = mendCliHome();
  const personal = personalClaudeDir();
  const personalBefore = grantStatus(cli, personal);
  const dir = throwawayLoginDir(home, "claude-login-");
  try {
    if (grantStatus(cli, dir) === null) {
      fail(
        "claude: could not run `claude auth status` — install Claude Code, set MEND_CLAUDE_BIN, " +
          "or paste a credential: mend connect claude --from-stdin",
      );
      return null;
    }
    say("  Mend needs its own Claude login; it is sent to your server and not kept here");
    say(dim("  your own Claude login stays as it is"));
    if (!runClaudeLogin(cli, dir)) {
      fail("claude: the login did not complete");
      return null;
    }
    const status = grantStatus(cli, dir);
    if (status === null || !status.loggedIn) {
      fail("claude: the login completed but Claude still reports no grant in Mend's directory");
      return null;
    }
    // Proof the isolation took effect: a Claude that ignored CLAUDE_CONFIG_DIR would report the
    // person's directory here, and Mend would be about to send the very grant it set out to avoid.
    if (
      status.configDirectory !== null &&
      path.resolve(status.configDirectory) !== path.resolve(dir)
    ) {
      fail(
        `claude: this Claude read ${status.configDirectory} instead of ${dir}, so a separate grant is not possible — ` +
          "connect the shared one deliberately with --use-my-login",
      );
      return null;
    }
    const read = readGrant(dir);
    if (read.kind === "missing") {
      const where =
        read.triedService === null
          ? read.triedPath
          : `${read.triedPath} or the Keychain item ${read.triedService}`;
      fail(`claude: logged in, but no credential to read — looked in ${where}`);
      return null;
    }
    const why = staleGrantReason(read.secret);
    if (why !== null) {
      fail(`claude: the new login is already ${why}`);
      return null;
    }
    const mine = localCredential("claude");
    if (mine !== null && sameGrant(read.secret, mine)) {
      fail(
        "claude: that is the same grant this machine's Claude holds, so both sides would race on " +
          "refresh — connect it deliberately with --use-my-login",
      );
      return null;
    }

    const personalAfter = grantStatus(cli, personal);
    if (personalBefore?.loggedIn === true && personalAfter?.loggedIn === false) {
      say(
        `  your own Claude login was signed out by this one — this account allows one grant at a time. ` +
          `Run \`claude auth login\` to get it back, and connect the shared grant with --use-my-login instead.`,
      );
    } else if (personalAfter?.loggedIn === true) {
      say(dim("  your own Claude login still works · verified"));
    }
    // The copy an older CLI kept: never sent again, so nothing of it stays.
    const kept = claudeGrantDir(home);
    if (fs.existsSync(kept)) {
      forgetGrant(kept);
      say(dim(`  removed the copy an older mend kept in ${kept} · the server refreshes the login`));
    }
    return read.secret;
  } finally {
    forgetGrant(dir);
  }
};

/**
 * `mend connect claude|codex|github [--from-stdin] [--remove]`: send THIS machine's credential
 * for the provider to the platform under your own user. The file the provider's CLI wrote at
 * login is read (codex: ~/.codex/auth.json; claude: ~/.claude/.credentials.json; github:
 * `gh auth token`); `--from-stdin` takes a pasted token or file instead. A Claude credential is
 * narrowed to its `claudeAiOauth` grant first, so the MCP refresh tokens in the same file stay
 * here (ADR 0005). Mend forwards it once and stores nothing.
 */
interface PiProfileDto {
  readonly fileCount: number;
  readonly bytes: number;
  readonly revision: number;
  readonly updatedAt: string;
}

/**
 * `mend connect pi`: this machine's pi setup, as the profile every pi session of yours receives
 * (pi-profile.ts). Not a login: pi runs on the ChatGPT login `mend connect codex` makes.
 */
const connectPi = async (config: CliConfig, flags: ReadonlyArray<string>) => {
  if (flags.includes("--remove")) {
    const removed = await api<{ readonly removed: boolean }>(config, "DELETE", "/me/pi-profile");
    process.stdout.write(removed.removed ? "pi: profile removed\n" : "pi: no profile saved\n");
    return;
  }
  const scan = scanPiProfile(takeFlagValue(flags, "--dir") ?? piAgentDir());
  if ("error" in scan) return fail(scan.error);
  for (const line of piProfileLines(scan)) say(line);
  const issue = validatePiProfile(scan.files);
  if (issue !== null) return fail(`pi: ${issue}`);
  if (flags.includes("--dry-run")) {
    say(dim("  --dry-run: nothing sent"));
    return;
  }
  const saved = await withSpinner(
    "saving the pi profile",
    api<{ readonly profile: PiProfileDto; readonly changed: boolean }>(
      config,
      "PUT",
      "/me/pi-profile",
      { files: scan.files },
    ),
  );
  process.stdout.write(
    `pi       profile ${saved.changed ? "saved" : "unchanged"} · revision ${saved.profile.revision} · new pi sessions receive it\n`,
  );
};

const connectCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const [providerArg, ...flags] = args;
  if (providerArg === "pi") return connectPi(config, flags);
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
  } else if (provider === "codex" && !flags.includes("--use-my-login")) {
    // A login of Mend's own, sent and not kept: the server is its only refresher
    // (docs/adr/0008-one-refresher-for-provider-logins.md).
    const grant = codexGrant({
      cli: codexCli(),
      personalAuthJson: readIfExists(path.join(personalCodexHome(), "auth.json")),
      say,
      parent: mendCliHome(),
    });
    if (grant.kind === "failed") return fail(grant.reason);
    secret = grant.secret;
  } else if (provider === "claude" && !flags.includes("--use-my-login")) {
    // A grant of Mend's own, so Mend's scheduled refresh never rotates the token this machine's
    // Claude is holding (ADR 0005), made fresh and not kept (ADR 0008).
    secret = await claudeGrant();
    if (secret === null) return;
  } else {
    secret = localCredential(provider);
    if (secret === null) {
      const where =
        provider === "github"
          ? "`gh auth login` first, or pipe a token: gh auth token | mend connect github --from-stdin"
          : provider === "codex"
            ? "`codex login` first, or: mend connect codex --from-stdin < auth.json"
            : "`claude auth login` first, or: mend connect claude --from-stdin";
      return fail(`${provider}: no credential on this machine — ${where}`);
    }
    if (provider === "claude" || provider === "codex") {
      say(
        dim(
          "  --use-my-login: Mend and this machine will share one login, and whichever refreshes second is signed out",
        ),
      );
    }
  }
  // Only the Claude grant travels; the MCP refresh tokens beside it stay on this machine
  // (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
  const narrowed = narrowCredential(provider, secret);
  if (narrowed.kind === "narrowed" && narrowed.dropped.length > 0) {
    say(dim(`  keeping ${narrowed.dropped.join(", ")} on this machine`));
  }
  const account = await withSpinner(
    `connecting ${provider}`,
    api<ConnectedAccountDto>(config, "POST", "/me/sealant/accounts", {
      provider,
      secret: narrowed.secret,
    }),
  );
  process.stdout.write(`${accountLine(account)}\n`);
  const facts = claudeGrantFacts(narrowed.secret);
  if (facts !== null) {
    say(
      dim(
        `  access expires ${minuteOrUnknown(facts.accessExpiresAt)} · grant expires ${minuteOrUnknown(facts.refreshExpiresAt)}`,
      ),
    );
  }
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
  await shareAgent({
    url: () => socketUrl(config, "keys-bridge", { host: os.hostname() }),
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

/** `mend git-author`: show, set, or clear the name and email this account's workspaces commit as. */
const gitAuthorCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const asked = parseGitAuthorArgs(args);
  switch (asked.kind) {
    case "usage":
      return fail(usageOf("git-author"));
    case "invalid":
      return fail(asked.message);
    case "show":
      say(gitAuthorLine(await api<GitAuthorDto>(config, "GET", "/me/git-author")));
      return;
    case "clear": {
      const author = await api<GitAuthorDto>(config, "DELETE", "/me/git-author");
      say(`${green("✓")} git author · ${gitAuthorLine(author)}`);
      return;
    }
    case "set": {
      const author = await api<GitAuthorDto>(config, "PUT", "/me/git-author", {
        name: asked.name,
        email: asked.email,
      });
      say(`${green("✓")} git author · ${gitAuthorLine(author)}`);
      say(
        dim("  sessions launched from now on commit as this, unless their dotfiles say otherwise"),
      );
      return;
    }
  }
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

const repositoryLine = (repository: DotfilesRepositoryBody | null): string =>
  repository === null
    ? `repo      ${dim("none")}`
    : `repo      ${repository.url} ${dim(`(${dotfilesRepositoryFacts(repository)})`)}`;

const dotfilesShow = async (config: CliConfig) => {
  const dotfiles = await api<DotfilesDto>(config, "GET", "/dotfiles");
  say(repositoryLine(dotfiles.repository));
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
 * `mend dotfiles repo <url> [options] | --clear` — set or clear the repository the server clones at
 * every launch. The server tries the clone before it saves, so a success line means it cloned.
 */
const dotfilesRepo = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const parsed = parseDotfilesRepoArgs(args);
  if (parsed.kind === "error") return fail(`${parsed.error}\n${usageOf("dotfiles repo")}`);
  const repository = parsed.kind === "clear" ? null : parsed.repository;
  if (repository !== null) say(dim(`cloning ${repository.url} on the server to check it…`));
  const result = await api<DotfilesDto>(config, "PUT", "/dotfiles/repository", { repository });
  if (result.repository === null) {
    say(
      `${green("✓")} cleared the dotfiles repository ${dim("— applies from the next session launch")}`,
    );
    return;
  }
  say(`${green("✓")} saved · the server cloned it once to check`);
  say(repositoryLine(result.repository));
  say(dim("applies from the next session launch"));
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
    case "repo":
      return dotfilesRepo(config, rest);
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
    'codex:new session + codex' 'claude:new session + claude' 'opencode:new session + opencode' 'pi:new session + pi'
    'run:new session + arbitrary command'
    'logs:recorded terminal output of a session' 'wait:wait for the command of a session to end'
    'attach:reattach to a running session' 'stop:stop the agent — record and review remain'
    'shell:open a shell in a live session workspace'
    'service:reachable ports — add, list, stop'
    'server:local server setup, lifecycle and upgrades'
    'uninstall:remove the server, local Mend files, or both'
    'keys:the machine Mend deploy key — init, show, share'
    'git-author:the name and email your workspaces commit as'
    'skills:skill libraries — list, push'
    'memory:what the agents remember about a project — list, show, rm, import'
    'accounts:your connected accounts on the platform'
    'pair:pair a phone or a second machine' 'doctor:read-only checklist of this setup'
    'connect:send this machine'"'"'s claude/codex/github credential, or your pi setup'
    'continue:resume with the pending follow-up' 'resume:rejoin a settled session'
    'rejoin:attach if live, otherwise resume'
    'land:push a session change to origin and open its pull request'
    'pull:fetch a session change into this clone'
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
          upgrade) compadd -- --version --assets-dir --offline --from-preview ;;
          start|restart) compadd -- --offline ;;
          logs) compadd -- --tail ;;
        esac
      fi
      ;;
    shell|attach|stop|continue|resume|rejoin|land|pull|logs|wait)
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
    COMPREPLY=( $(compgen -W "adopt codex claude opencode pi run logs wait attach stop shell service server uninstall keys git-author skills memory connect pair doctor continue resume rejoin land pull refresh projects sessions status ui help" -- "$cur") )
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
          upgrade) options="--version --assets-dir --offline --from-preview" ;;
          start|restart) options="--offline" ;;
          logs) options="--tail" ;;
        esac
      fi
      COMPREPLY=( $(compgen -W "$options" -- "$cur") )
      ;;
    shell|attach|stop|continue|resume|rejoin|land|pull|logs|wait)
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

/** A sleep for the run, logs and wait loops; an abort ends it early and clears its timer. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
};

const clock = { sleep: pause, now: Date.now };

/** Print one JSON value on stdout, as the other --json commands do. */
const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

// ─── recorded output on this terminal ───────────────────────────────────────

/** Whether recorded bytes reached this terminal, which may have set its modes. */
let outputOnTerminal = false;
let stdoutErrorsHandled = false;

/**
 * Put the terminal back once recorded output may have changed its modes, as an attach does on
 * its way out. Only on a terminal: redirected output gets no bytes of Mend's.
 */
const restoreTerminal = (): void => {
  if (!outputOnTerminal || process.stdout.isTTY !== true) return;
  outputOnTerminal = false;
  process.stdout.write(`${TERMINAL_MODES_RESET}\x1b[0m`);
};
// Every way out, `fail` and an uncaught error included: a terminal write is synchronous here.
process.once("exit", restoreTerminal);

/**
 * Hand recorded bytes to stdout and resolve once they are written: a reader slower than the record
 * holds the next page back, and nothing queues up in memory. A reader that went away (EPIPE)
 * rejects.
 */
const writeOutput = (bytes: Uint8Array): Promise<void> => {
  if (process.stdout.isTTY === true) outputOnTerminal = true;
  // A closed pipe also arrives as an `error` event; the write's callback already reports it.
  if (!stdoutErrorsHandled) {
    stdoutErrorsHandled = true;
    process.stdout.on("error", () => undefined);
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
};

/** Resolves once everything written to `stream` before it has left this process. */
const flushed = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) resolve();
    else stream.write("", () => resolve());
  });

/**
 * Exit once stdout and stderr have flushed: `process.exit` drops whatever a pipe has not taken
 * yet, which cut 4 MiB of output to 64 KiB under a slow reader (review of mend#610).
 */
const exitFlushed = async (code: number): Promise<never> => {
  restoreTerminal();
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
};

/** `fail`, after what was written so far has flushed. */
const failFlushed = (message: string): Promise<never> => {
  process.stderr.write(`mend: ${message}\n`);
  return exitFlushed(1);
};

/**
 * While output streams to this CLI, a signal stops watching: the terminal is put back, the line
 * says the command keeps running, and the CLI exits 128 + the signal. Returns the undo.
 */
const stopWatchingOnSignal = (sessionId: string): (() => void) => {
  const signals: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ];
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      say("");
      say(
        `${amber("·")} stopped watching · the command keeps running · mend logs ${sessionId.slice(0, 8)} --follow`,
      );
      void exitFlushed(code);
    };
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => {
    for (const undo of handlers) undo();
  };
};

/** One page of a process's recorded terminal output. */
const readLogPage = (config: CliConfig, processId: string, from: string) =>
  request<ProcessLogPageDto>(
    config,
    "GET",
    `/processes/${processId}/logs?from=${encodeURIComponent(from)}&limit=256`,
  );

/** Write a process's recorded output to stdout from `from`; following, until it has ended. */
const writeProcessLogs = (config: CliConfig, processId: string, from: string, follow: boolean) =>
  followLogs({
    from,
    follow,
    read: (cursor) => readLogPage(config, processId, cursor),
    write: writeOutput,
    ...clock,
  });

/**
 * Read the session until its command has ended, or the deadline passes. `processId` binds the wait
 * to one process: the one `mend run` started, or one a script names.
 */
const waitForSessionCommand = (
  config: CliConfig,
  sessionId: string,
  processId: string | null,
  deadline: number | null,
) =>
  waitForCommand({
    read: () => request<CommandDetail>(config, "GET", `/sessions/${sessionId}`),
    processId,
    deadline,
    ...clock,
  });

/** What `mend run --json` and `mend wait --json` print about a session's command. */
interface RunJson {
  readonly version: 1;
  readonly sessionId: string;
  readonly processId: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly url: string;
  /** The process's status as last observed: `running`, then how it ended (`exited`, `stopped`). */
  readonly status: string;
  /** The command's exit code, once it ended and the platform reported one. */
  readonly exitCode: number | null;
}

const runJsonOf = (
  config: CliConfig,
  session: SessionDto,
  processId: string | null,
  state: { readonly status: string; readonly exitCode: number | null },
): RunJson => ({
  version: 1,
  sessionId: session.id,
  processId,
  worktree: session.worktree,
  branch: session.branch,
  url: `${config.url}/sessions/${session.id}`,
  status: state.status,
  exitCode: state.exitCode,
});

/** A process's state as one read observed it: its row's, else the session's. */
const observedState = (
  detail: CommandDetail | null,
  processId: string | null,
  fallback: string,
): { readonly status: string; readonly exitCode: number | null } => {
  if (detail === null) return { status: fallback, exitCode: null };
  const row =
    (processId === null ? undefined : processRowOf(detail, processId)) ?? detail.currentAgent;
  return row === null
    ? { status: detail.session.status, exitCode: null }
    : { status: row.status, exitCode: row.exitCode };
};

/**
 * Say how the command ended and exit with its code, once stdout has flushed. Output that could not
 * be delivered fails the CLI too (1 when the command itself succeeded): a script must not read an
 * empty or cut stdout as the command's whole output. The command's own code is still said.
 */
const exitWithCommandEnd = (
  config: CliConfig,
  session: SessionDto,
  end: CommandEnd,
  json: boolean,
  undelivered: string | null = null,
): Promise<never> => {
  const commandCode = exitStatusOf(end);
  const code = undelivered !== null && commandCode === 0 ? 1 : commandCode;
  say(`${commandCode === 0 ? green("✓") : amber("·")} ${endLine(end)} · recorded`);
  if (undelivered !== null) {
    say(
      `${amber("·")} output not delivered · ${undelivered} · read it with mend logs ${session.id.slice(0, 8)}`,
    );
  }
  say(`${cobalt("  review")} · ${config.url}/sessions/${session.id}`);
  if (json) printJson(runJsonOf(config, session, end.processId, end));
  return exitFlushed(code);
};

/**
 * `mend run`: the command runs as the session's process in its workspace, and this terminal shows
 * what it prints, as the record has it, then exits with the command's exit code. stdout is the
 * command's output and nothing else (stdout and stderr together: it runs in a terminal). Ctrl+C
 * stops watching; the command keeps running. `--detach` returns once it runs, `--json` prints the
 * session and process ids (and with no `--detach`, how it ended) in place of the output.
 */
const supervisedRun = async (
  config: CliConfig,
  session: SessionDto,
  argv: ReadonlyArray<string>,
  options: { readonly detach: boolean; readonly json: boolean },
) => {
  const outcome = await followStarting(
    config,
    session.id,
    "provisioning workspace — a first launch builds the harness image (can take minutes)…",
    request<SessionDto>(config, "POST", `/sessions/${session.id}/launch`, { argv }),
  );
  // A short command can end before the follower sees it run: the session settled, and its
  // command's process says it ran.
  const ranAndEnded =
    outcome.kind === "settled"
      ? await request<CommandDetail>(config, "GET", `/sessions/${session.id}`).catch(() => null)
      : null;
  if (outcome.kind !== "live" && ranAndEnded?.currentAgent?.id === undefined) {
    startedOrExit(config, session.id, outcome);
    return;
  }
  const detail =
    ranAndEnded ?? (await api<CommandDetail>(config, "GET", `/sessions/${session.id}`));
  // The process this run started: its end, and nothing else, is the run's end.
  const processId = detail.currentAgent?.id ?? null;
  const id8 = session.id.slice(0, 8);
  if (options.detach) {
    // What was observed, a command that already ended included.
    const ended = commandEndOf(detail, processId);
    if (ended === null) {
      say(`${green("✓ recording")} · running detached · session ${dim(id8)}`);
      say(`${cobalt("  output")} · mend logs ${id8} --follow`);
      say(`${cobalt("  wait")} · mend wait ${id8}`);
    } else {
      say(`${amber("·")} ended before detaching · ${endLine(ended)} · session ${dim(id8)}`);
      say(`${cobalt("  output")} · mend logs ${id8}`);
    }
    if (options.json) {
      printJson(
        runJsonOf(
          config,
          session,
          processId,
          ended ?? observedState(detail, processId, detail.session.status),
        ),
      );
    }
    return;
  }
  say(
    `${green("✓ recording")} · ${argv[0] ?? "command"} · workspace mounts the worktree · Ctrl+C stops watching, not the command`,
  );
  say("");
  let undelivered: string | null = null;
  if (!options.json) stopWatchingOnSignal(session.id);
  if (processId !== null && !options.json) {
    try {
      await writeProcessLogs(config, processId, "0", true);
    } catch (error) {
      undelivered = error instanceof Error ? error.message : String(error);
    }
  }
  const waited = await waitForSessionCommand(config, session.id, processId, null).catch(
    (error: unknown) => failFlushed(error instanceof Error ? error.message : String(error)),
  );
  if (waited.kind === "timeout") return failFlushed("the wait ended without a timeout");
  say("");
  await exitWithCommandEnd(config, session, waited.end, options.json, undelivered);
};

/**
 * The session a word names, settled ones included: a full id is read directly; a prefix of the id,
 * or a worktree's name, is looked for in every project, as `mend land` does.
 */
const resolveAnySession = async (config: CliConfig, word: string): Promise<SessionDto> => {
  if (isSessionId(word)) {
    return (await api<SessionDetailLiteDto>(config, "GET", `/sessions/${word}`)).session;
  }
  const projects = await api<ReadonlyArray<ProjectDto>>(config, "GET", "/projects");
  const details = await Promise.all(
    projects.map((project) =>
      api<ProjectDetailDto>(config, "GET", `/projects/${project.id}?deadEnds=include`),
    ),
  );
  const picked = pickSession(
    details.flatMap((detail) => detail.sessions),
    word,
  );
  if ("error" in picked) return fail(picked.error);
  return picked.session;
};

/**
 * `mend logs [session] [--follow] [--from <sequence>] [--process <id>]`: a session's recorded
 * terminal output on stdout, as bytes. The session's command (or agent) by default; another of
 * its processes, a shell or a Service attempt, with --process.
 */
const logsCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  chromeToStderr();
  const parsed = parseLogsArgs(args);
  if ("error" in parsed) return fail(`${parsed.error} · ${usageOf("logs")}`);
  const { session: word, follow, from, process: processPrefix } = parsed.args;
  const session =
    word === null
      ? await resolveLiveSession(config, undefined, "logs")
      : await resolveAnySession(config, word);
  const detail = await api<CommandDetail>(config, "GET", `/sessions/${session.id}`);
  const picked = pickProcess(detail, processPrefix);
  if ("error" in picked) return fail(`session ${session.id.slice(0, 8)} · ${picked.error}`);
  const target = picked.process;
  if (target.id === undefined || target.sealantSessionId === null) {
    return fail(
      `session ${session.id.slice(0, 8)} · this process has no recorded terminal (an adopted port, or a server older than process ids)`,
    );
  }
  if (follow) stopWatchingOnSignal(session.id);
  try {
    const last = await writeProcessLogs(config, target.id, from, follow);
    restoreTerminal();
    if (follow) say(dim(`\nrecord ended · ${last.status} · next sequence ${last.next}`));
  } catch (error) {
    return failFlushed(
      `output not delivered · ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await exitFlushed(0);
};

/**
 * `mend wait [session] [--timeout <seconds>] [--process <id>] [--json]`: return once the session's
 * command has ended, with its exit code; 124 when the timeout passes first, and the command keeps
 * running. The timeout is one deadline over everything: finding the session, every read and retry,
 * and what `--json` prints, which is the last observation and never a further read.
 */
const waitCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  chromeToStderr();
  const parsed = parseWaitArgs(args);
  if ("error" in parsed) return fail(`${parsed.error} · ${usageOf("wait")}`);
  const { session: word, timeoutMs, json, process: processPrefix } = parsed.args;
  const deadline = timeoutMs === null ? null : clock.now() + timeoutMs;
  const after = `${Math.round((timeoutMs ?? 0) / 1000)} s`;
  const timedOut = async (
    session: SessionDto | null,
    processId: string | null,
    last: CommandDetail | null,
  ): Promise<never> => {
    say(
      session === null
        ? `${amber("·")} no session found within ${after}`
        : `${amber("·")} session ${session.id.slice(0, 8)} · still running after ${after} · the command keeps running`,
    );
    if (json && session !== null) {
      // The last observation: the process waited for, else the one that read named.
      const observed = processId ?? last?.currentAgent?.id ?? null;
      printJson(
        runJsonOf(config, session, observed, observedState(last, observed, session.status)),
      );
    }
    return exitFlushed(WAIT_TIMED_OUT);
  };
  const resolved = await beforeDeadline(
    word === null ? resolveLiveSession(config, undefined, "wait") : resolveAnySession(config, word),
    clock,
    deadline,
  );
  if (!resolved.done) return timedOut(null, null, null);
  const session = resolved.value;
  let processId: string | null = null;
  if (processPrefix !== null) {
    const read = await beforeDeadline(
      api<CommandDetail>(config, "GET", `/sessions/${session.id}`),
      clock,
      deadline,
    );
    if (!read.done) return timedOut(session, null, null);
    const picked = pickProcess(read.value, processPrefix);
    if ("error" in picked) return fail(`session ${session.id.slice(0, 8)} · ${picked.error}`);
    processId = picked.process.id ?? null;
  }
  const waited = await waitForSessionCommand(config, session.id, processId, deadline).catch(
    (error: unknown) => failFlushed(error instanceof Error ? error.message : String(error)),
  );
  if (waited.kind === "timeout") return timedOut(session, processId, waited.last);
  await exitWithCommandEnd(config, session, waited.end, json);
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
  const prefix = firstPositional(args, ["--with"]);

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
  await startAndFollow(
    config,
    match.id,
    protocolPrior
      ? "reopening as a terminal — same conversation…"
      : "resuming — a fresh workspace restores the saved session state…",
    protocolPrior
      ? request<SessionDto>(config, "POST", `/sessions/${match.id}/handoff`, { to: "pty" })
      : request<SessionDto>(config, "POST", `/sessions/${match.id}/resume`, {
          harness: withHarness,
        }),
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
  const outcome = await followStarting(
    config,
    sessionId,
    label,
    request<SessionDto>(config, "POST", `/sessions/${sessionId}/resume`, { harness: null }),
  );
  if (outcome.kind === "refused") {
    // Refused because it is live already (another terminal resumed it): attach to that.
    const refreshed = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${sessionId}`);
    if (agentIsLive(refreshed.session, refreshed.currentAgent)) return false;
  }
  startedOrExit(config, sessionId, outcome);
  return true;
};

const rejoinCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const harnessFlag = args.indexOf("--harness");
  const harness =
    harnessFlag !== -1 && args[harnessFlag + 1] !== undefined
      ? String(args[harnessFlag + 1])
      : null;
  const prefix = firstPositional(args, ["--harness"]);
  const tunnels = attachTunnels(config, args.includes("--no-tunnel"));

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
    await startAndFollow(
      config,
      session.id,
      alreadyLive
        ? "taking over from the protocol session — same conversation…"
        : "reopening as a terminal — same conversation…",
      request<SessionDto>(config, "POST", `/sessions/${session.id}/handoff`, { to: "pty" }),
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
  await tunnels?.start(session.id);
  say("");
  let outcome = await attachWithTunnels(tunnels, () =>
    attachTty(config, session.id, session.harness, 0n, undefined, {
      handleSignals: true,
    }),
  );
  if (outcome === "unavailable") {
    const refreshed = await api<SessionDetailLiteDto>(config, "GET", `/sessions/${session.id}`);
    if (!agentIsLive(refreshed.session, refreshed.currentAgent)) {
      await resumeForRejoin(
        config,
        session.id,
        "session settled while attaching — restoring it once…",
      );
    }
    outcome = await attachWithTunnels(tunnels, () =>
      attachTty(config, session.id, session.harness, 0n, undefined, {
        handleSignals: true,
      }),
    );
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
  /**
   * What the executor still holds, when the server says (docs/adr/0002): pending captures,
   * bytes once sealantd reports them, refusals, a drain under way and whether it stopped moving,
   * and the line every surface shows. Null when the server says nothing.
   */
  readonly capture: {
    readonly pending: number | null;
    readonly pendingBytes: number | null;
    readonly refused: number | null;
    readonly drain: string | null;
    readonly notSaved: boolean;
    readonly line: string | null;
  } | null;
}

interface SessionsJson {
  readonly version: 1;
  readonly sessions: ReadonlyArray<SessionJson>;
}

/** The session's Services-hold line from its list facts; null without them or without a hold. */
const rowHold = (row: SessionRow): string | null =>
  // A workspace a stop is still saving (docs/adr/0002) reads what is left, first.
  captureLineOf(row.session) ??
  (row.annotation === undefined
    ? null
    : servicesHoldOf(row.session, row.annotation.currentAgent, row.annotation.liveServices ?? 0));

const printSessionRow = (row: SessionRow, workspaceLines: ReadonlyArray<string> = []) => {
  const { session, annotation } = row;
  const live = ACTIVE_STATUSES.has(session.status);
  const status = session.status.padEnd(9);
  const facts: Array<string> = [];
  // A stop leaves Services running: a held workspace leads the facts, or the row reads as done.
  const hold = rowHold(row);
  if (hold !== null) facts.push(amber(hold));
  if (session.label !== null) facts.push(session.label);
  if (annotation !== undefined && annotation.openComments > 0) {
    facts.push(amber(`${annotation.openComments} open`));
  }
  if (annotation !== undefined && annotation.pendingFollowUp)
    facts.push(amber("follow-up pending"));
  const base = session.baseRef === null ? session.baseSha.slice(0, 12) : session.baseRef;
  // The model the session was started with, as the server recorded it; nothing on older rows.
  const model =
    session.model === null || session.model === undefined
      ? ""
      : ` · ${session.model}${session.effort === null || session.effort === undefined ? "" : ` · ${session.effort}`}`;
  say(
    `${session.harness.padEnd(8)}  ${dim(session.id.slice(0, 8))}  ${live ? green(status) : dim(status)}  ${row.projectName}  ${dim(`${session.branch} · base ${base}${model}`)}${facts.length > 0 ? `  ${facts.join(dim(" · "))}` : ""}`,
  );
  // What the session says about its workspace, one line each under the row.
  for (const line of workspaceLines) say(`          ${dim(line)}`);
};

/** `mend models`: what the server lists per harness, the default marked (docs/models-audit.md). */
const modelsCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  const catalogs = await api<ReadonlyArray<HarnessModelCatalogDto>>(
    config,
    "GET",
    "/harnesses/models",
  );
  if (args.includes("--json")) return say(modelCatalogJson(catalogs));
  for (const line of modelCatalogLines(catalogs, dim)) say(line);
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
  if (all || projectName !== null || !json) {
    // --all means all: dead ends (settled, no conversation) included, which the server hides
    // otherwise for every client. The default human list reads the details too, for the facts
    // a status word cannot carry (a stopped agent's Services keeping its workspace up).
    const details = await Promise.all(
      scope.map((p) =>
        api<ProjectDetailDto>(config, "GET", `/projects/${p.id}${all ? "?deadEnds=include" : ""}`),
      ),
    );
    const detailed = details.flatMap((detail) =>
      detail.sessions.map((session) => ({
        session,
        projectName: detail.project.name,
        annotation: detail.annotations.find((a) => a.sessionId === session.id),
      })),
    );
    rows =
      all || projectName !== null
        ? detailed
        : detailed.filter(
            (row) => ACTIVE_STATUSES.has(row.session.status) || rowHold(row) !== null,
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
        capture:
          session.capturePending === undefined
            ? null
            : {
                pending: session.capturePending ?? null,
                pendingBytes: session.capturePendingBytes ?? null,
                refused: session.captureRefused ?? null,
                drain: session.captureDrain ?? null,
                notSaved: (session.captureNotSavedAt ?? null) !== null,
                line: captureLineOf(session),
              },
      })),
    };
    say(JSON.stringify(payload, null, 2));
    return;
  }
  const workspaceLines = await workspaceLinesOf(
    config,
    rows.map((row) => row.session),
  );
  for (const row of rows) printSessionRow(row, workspaceLines.get(row.session.id));
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

/** `mend worktrees [--project <p>] [--json]` — the container-first listing; `rm` removes one. */
const worktreesCommand = async (config: CliConfig, args: ReadonlyArray<string>) => {
  if (args[0] === "rm") {
    // The raw request, not `api`: a refusal must come back as words to print beside the override.
    return worktreesRmCommand(
      {
        request: (method, route, body) => request(config, method, route, body),
        listWorktrees: async (project) => (await buildWorktreesJson(config, project)).worktrees,
        liveStatuses: ACTIVE_STATUSES,
        say,
        fail,
      },
      args.slice(1),
    );
  }
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
const dashboard = async (
  config: CliConfig,
  options: { readonly openSnake?: boolean; readonly noTunnel?: boolean } = {},
) => {
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
  // The selected session's browser Services, tunneled here while it stays selected. The
  // dashboard renders them in the session pane, so nothing prints.
  const tunnels: ServiceTunnels | null =
    options.noTunnel === true || serverIsLocal(config)
      ? null
      : createServiceTunnels({
          listServices: () => fetchServices(config),
          tunnelUrl: (serviceId) => tunnelUrlFor(config, serviceId),
          events: serverEvents(config),
        });
  try {
    await runDashboard({
      config,
      ...(options.openSnake === true ? { openSnake: true } : {}),
      cwd: process.cwd(),
      cwdBranch: gitCurrentBranch(process.cwd()),
      api: <T>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown) =>
        request<T>(config, method, route, body),
      attachTty: (sessionId: string, harness: string, processId?: string) =>
        attachTty(config, sessionId, harness, 0n, processId),
      agentShare,
      tunnels,
    });
  } finally {
    tunnels?.close();
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
    url: () => socketUrl(config, "keys-bridge", { host: os.hostname() }),
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
  // Before any request: every fetch and WebSocket goes over HTTP/1.1 (`http-client.ts`).
  useHttp1();
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
    case "pi":
    case "run":
      return withAgentShare(config, () => launch(config, command, rest));
    case "logs":
      return logsCommand(config, rest);
    case "wait":
      return waitCommand(config, rest);
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
    case "git-author":
      return gitAuthorCommand(config, rest);
    case "dotfiles":
      return dotfilesCommand(config, rest);
    case "skills":
      return skillsCommand(config, rest);
    case "memory":
      return memoryCommand(config, rest);
    case "secrets":
      return secretsCommand(config, rest);
    case "accounts":
      return accountsCommand(config);
    case "connect":
      return connectCommand(config, rest);
    case "pair":
      return pairCommand(rest, boundApi(config));
    case "invite":
      return inviteCommand(boundApi(config), config.url, rest);
    case "members":
      return membersCommand(boundApi(config));
    case "folder":
      return folderCommand(boundApi(config), rest);
    case "operator":
      return operatorCommand(
        boundApi(config),
        (method, route, body) => request(config, method, route, body),
        config.url,
        rest,
      );
    case "session":
      if (rest[0] === "share") return sessionShareCommand(boundApi(config), rest.slice(1));
      return fail(`unknown session command "${rest[0] ?? ""}" · mend help session share`);
    case "workspace":
      return workspaceCommand(
        boundApi(config),
        (method, route, body) => request(config, method, route, body),
        rest,
      );
    // Hidden in the catalog: the installer renders its own QR through this.
    case "qr":
      return qrCommand(rest);
    case "doctor":
      if (rest.includes("--bundle")) return doctorBundle(config, rest);
      return doctorCommand(config, localCredential, claudeGrantSecret);
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
    case "land":
      // Bridge mode signs the push with this machine's ssh-agent, so the share runs meanwhile.
      return withAgentShare(config, () => landCommand(boundApi(config), rest));
    case "pull":
      return pullCommand(boundApi(config), download(config), rest);
    case "sessions":
    case "status":
      return sessionsCommand(config, rest);
    case "models":
      return modelsCommand(config, rest);
    case "worktrees":
      return worktreesCommand(config, rest);
    case undefined:
    case "ui":
      return dashboard(config, { noTunnel: rest.includes("--no-tunnel") });
    case "snake":
      return dashboard(config, { openSnake: true, noTunnel: rest.includes("--no-tunnel") });
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
