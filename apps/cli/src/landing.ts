import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type LandingFact, landingFactLine, landingFactsFromWire } from "@mend/domain/workbench";

import type { ApiCall } from "./pair.ts";
import { gitCurrentBranch, gitTopLevel, normalizeRemoteUrl } from "./shared.ts";

/**
 * Landing from a terminal (docs/adr/0007-landing.md): `mend land` pushes a session's change to
 * origin and opens or updates its pull request, then prints what Mend observed; `mend pull`
 * fetches the change into a local clone from a git bundle, without origin. The server decides
 * who may land and what a landing does; these commands say what it answered, in its words.
 */

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `[${code}m${text}[0m` : text;
const dim = paint("2");
const green = paint("32");
const amber = paint("33");
const say = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`mend: ${message}\n`);
  process.exit(1);
};

// ─── wire shapes (the server validates; the CLI renders) ────────────────────

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
}

interface SessionDto {
  readonly id: string;
  readonly projectId: string;
  readonly harness: string;
  readonly label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly createdAt: string;
}

interface ProjectDetailDto {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
}

export interface LandedPullRequestDto {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly observedAt: string;
}

export interface ChangeLandingDto {
  readonly remoteBranch: string;
  readonly pushedSha: string | null;
  readonly commitSha: string | null;
  readonly checkpointSha: string | null;
  readonly outcome: "pushed" | "pull-request" | "refused" | "failed";
  readonly message: string | null;
  readonly pullRequest: LandedPullRequestDto | null;
}

export type PullRequestStepDto =
  | { readonly _tag: "opened" | "updated"; readonly pullRequest: LandedPullRequestDto }
  | { readonly _tag: "off" | "not-reached" }
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "failed"; readonly message: string };

export interface LandingReportDto {
  readonly landing: ChangeLandingDto;
  readonly pullRequest: PullRequestStepDto;
}

interface ChangeLandingsDto {
  readonly changeId: string | null;
  readonly facts: unknown;
}

/** One raw download: the bundle is bytes with its facts in headers, not JSON. */
export interface Downloaded {
  readonly status: number;
  readonly header: (name: string) => string | null;
  readonly bytes: Uint8Array;
}

export type Download = (route: string) => Promise<Downloaded>;

/** Response headers the bundle carries (`BUNDLE_HEADERS` in @mend/api-contracts). */
const BUNDLE_HEADERS = {
  branch: "x-mend-bundle-branch",
  base: "x-mend-bundle-base",
  tip: "x-mend-bundle-tip",
  commits: "x-mend-bundle-commits",
};

// ─── arguments ──────────────────────────────────────────────────────────────

export interface LandArgs {
  readonly session: string;
  /** Null keeps the branch the change landed on before, else `mend/<name>`. */
  readonly branch: string | null;
  readonly pullRequest: boolean;
  readonly title: string | null;
  readonly project: string | null;
}

export interface PullArgs {
  readonly session: string;
  readonly force: boolean;
  readonly project: string | null;
}

type Parsed<T> = { readonly args: T } | { readonly error: string };

/** Flags with a value, and the switches, a command takes; anything else is refused. */
const parseFlags = (
  args: ReadonlyArray<string>,
  valued: ReadonlyArray<string>,
  switches: ReadonlyArray<string>,
):
  | {
      readonly positional: ReadonlyArray<string>;
      readonly values: ReadonlyMap<string, string>;
      readonly on: ReadonlySet<string>;
    }
  | { readonly error: string } => {
  const positional: Array<string> = [];
  const values = new Map<string, string>();
  const on = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (valued.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      values.set(arg, value);
      index += 1;
    } else if (switches.includes(arg)) {
      on.add(arg);
    } else if (arg.startsWith("-")) {
      return { error: `unknown flag ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, on };
};

/** `mend land <session> [--branch <name>] [--no-pr] [--title <text>] [--project <p>]`. */
export const parseLandArgs = (args: ReadonlyArray<string>): Parsed<LandArgs> => {
  const flags = parseFlags(args, ["--branch", "--title", "--project"], ["--no-pr"]);
  if ("error" in flags) return flags;
  const [session, extra] = flags.positional;
  if (session === undefined) return { error: "name the session to land" };
  if (extra !== undefined) return { error: `one session only; "${extra}" is extra` };
  const branch = flags.values.get("--branch")?.trim() ?? null;
  if (branch === "") return { error: "--branch needs a name" };
  const title = flags.values.get("--title")?.trim() ?? null;
  return {
    args: {
      session,
      branch,
      pullRequest: !flags.on.has("--no-pr"),
      title: title === "" ? null : title,
      project: flags.values.get("--project") ?? null,
    },
  };
};

/** `mend pull <session> [--force] [--project <p>]`. */
export const parsePullArgs = (args: ReadonlyArray<string>): Parsed<PullArgs> => {
  const flags = parseFlags(args, ["--project"], ["--force"]);
  if ("error" in flags) return flags;
  const [session, extra] = flags.positional;
  if (session === undefined) return { error: "name the session to pull" };
  if (extra !== undefined) return { error: `one session only; "${extra}" is extra` };
  return {
    args: {
      session,
      force: flags.on.has("--force"),
      project: flags.values.get("--project") ?? null,
    },
  };
};

// ─── which session ──────────────────────────────────────────────────────────

/**
 * The session a word names: a prefix of its id, else the worktree it works in (its name, or its
 * branch `mend/<name>`), where the newest session in that worktree answers. Settled sessions
 * count: a change is landed or pulled long after its agent stopped.
 */
export const pickSession = <S extends SessionDto>(
  sessions: ReadonlyArray<S>,
  word: string,
): { readonly session: S } | { readonly error: string } => {
  const byId = sessions.filter((session) => session.id.startsWith(word));
  if (byId.length > 1)
    return { error: `"${word}" matches ${byId.length} sessions; type more of the id` };
  const [only] = byId;
  if (only !== undefined) return { session: only };
  const inWorktree = sessions
    .filter(
      (session) =>
        session.worktree === word || session.branch === word || session.branch === `mend/${word}`,
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const projects = new Set(inWorktree.map((session) => session.projectId));
  if (projects.size > 1) {
    return { error: `"${word}" names a worktree in ${projects.size} projects; pass --project` };
  }
  const [newest] = inWorktree;
  if (newest !== undefined) return { session: newest };
  return { error: `no session or worktree matches "${word}" · mend sessions --all lists them` };
};

const findSession = async (
  api: ApiCall,
  word: string,
  projectName: string | null,
): Promise<{ readonly session: SessionDto; readonly project: ProjectDto }> => {
  const projects = await api<ReadonlyArray<ProjectDto>>("GET", "/projects");
  const scope = projectName === null ? projects : projects.filter((p) => p.name === projectName);
  if (projectName !== null && scope.length === 0) {
    return fail(`no adopted project named "${projectName}"`);
  }
  const details = await Promise.all(
    scope.map((project) =>
      api<ProjectDetailDto>("GET", `/projects/${project.id}?deadEnds=include`),
    ),
  );
  const picked = pickSession(
    details.flatMap((detail) => detail.sessions),
    word,
  );
  if ("error" in picked) return fail(picked.error);
  const project = details.find((detail) => detail.project.id === picked.session.projectId)?.project;
  if (project === undefined) return fail(`no project holds session ${picked.session.id}`);
  return { session: picked.session, project };
};

// ─── mend land ──────────────────────────────────────────────────────────────

const short = (sha: string): string => sha.slice(0, 7);

/** The landing as one status line, the way the Land panel says it after a landing. */
export const landingReportLine = (report: LandingReportDto): string => {
  const { landing, pullRequest } = report;
  const why = landing.message ?? "no reason given";
  if (landing.outcome === "refused") return `push refused · ${landing.remoteBranch} · ${why}`;
  if (landing.pushedSha === null) return `landing failed · ${why}`;
  const pushed = `pushed · ${landing.remoteBranch} · ${short(landing.pushedSha)}`;
  switch (pullRequest._tag) {
    case "opened":
    case "updated":
      return `${pushed} · pull request #${pullRequest.pullRequest.number} · ${pullRequest._tag}`;
    case "unavailable":
      return `${pushed} · ${pullRequest.reason}`;
    case "failed":
      return `${pushed} · pull request step failed · ${pullRequest.message}`;
    case "off":
    case "not-reached":
      return pushed;
  }
};

/** Whether the landing reached what it set out to: a refusal or a failed step exits 1. */
export const landingSucceeded = (report: LandingReportDto): boolean =>
  report.landing.outcome === "pushed" || report.landing.outcome === "pull-request";

/** What `mend land` prints: the landing, what it wrote, then every fact Mend observed. */
export const landedLines = (
  report: LandingReportDto,
  facts: ReadonlyArray<LandingFact>,
  now: Date,
): ReadonlyArray<string> => {
  const { landing, pullRequest } = report;
  const lines = [
    `${landingSucceeded(report) ? green("✓") : amber("·")} ${landingReportLine(report)}`,
  ];
  if (landing.checkpointSha !== null) {
    lines.push(`${dim("  checkpoint")} ${short(landing.checkpointSha)}`);
  }
  if (landing.commitSha !== null) {
    lines.push(
      `${dim("  commit")} ${short(landing.commitSha)} ${dim("· Mend's, for the work left uncommitted")}`,
    );
  }
  if (pullRequest._tag === "opened" || pullRequest._tag === "updated") {
    lines.push(`${dim("  pull request")} ${pullRequest.pullRequest.url}`);
  }
  if (facts.length > 0) {
    lines.push(dim("  observed"));
    for (const fact of facts) lines.push(`    ${landingFactLine(fact, now)}`);
  }
  return lines;
};

const readFacts = (wire: unknown): ReadonlyArray<LandingFact> => {
  try {
    return landingFactsFromWire(wire);
  } catch {
    return fail("the server's landing facts are in a shape this CLI cannot read · update mend");
  }
};

export const landCommand = async (api: ApiCall, args: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseLandArgs(args);
  if ("error" in parsed) return fail(parsed.error);
  const { session, project } = await findSession(api, parsed.args.session, parsed.args.project);
  const steps = parsed.args.pullRequest
    ? "checkpoint · commit · push · pull request"
    : "checkpoint · commit · push";
  say(
    dim(
      `  landing ${session.branch} · ${project.name} · session ${session.id.slice(0, 8)} · ${steps}`,
    ),
  );
  const report = await api<LandingReportDto>("POST", `/sessions/${session.id}/land`, {
    branch: parsed.args.branch,
    pullRequest: parsed.args.pullRequest,
    title: parsed.args.title,
    body: null,
  });
  const view = await api<ChangeLandingsDto>("GET", `/sessions/${session.id}/landings`);
  for (const line of landedLines(report, readFacts(view.facts), new Date())) say(line);
  if (!landingSucceeded(report)) process.exitCode = 1;
};

// ─── mend pull ──────────────────────────────────────────────────────────────

interface GitRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const git = (cwd: string, args: ReadonlyArray<string>): GitRun => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

/** Git's own words for a failure, without its hint lines. */
const gitWords = (run: GitRun): string =>
  run.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("hint:"))
    .join(" · ") || `git exited ${run.status}`;

export interface GitRemote {
  readonly name: string;
  readonly url: string;
}

/** The clone's remotes, from `git remote -v`, one per name. */
export const gitRemotes = (cwd: string): ReadonlyArray<GitRemote> => {
  const run = git(cwd, ["remote", "-v"]);
  if (run.status !== 0) return [];
  const remotes = new Map<string, string>();
  for (const line of run.stdout.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (name !== undefined && url !== undefined && name !== "" && !remotes.has(name)) {
      remotes.set(name, url);
    }
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
};

/**
 * The remote that is the project's origin: the same host and path (ssh, https and scp-style
 * spellings compare equal), or the same directory for an origin on this machine.
 */
export const remoteForOrigin = (
  remotes: ReadonlyArray<GitRemote>,
  originUrl: string | null,
  cwd: string,
): GitRemote | null => {
  if (originUrl === null) return null;
  const origin = normalizeRemoteUrl(originUrl);
  const originPath = origin === null ? path.resolve(originUrl.replace(/^file:\/\//, "")) : null;
  return (
    remotes.find((remote) =>
      origin === null
        ? path.resolve(cwd, remote.url.replace(/^file:\/\//, "")) === originPath
        : normalizeRemoteUrl(remote.url) === origin,
    ) ?? null
  );
};

export interface BundleFacts {
  readonly branch: string;
  readonly base: string;
  readonly tip: string;
  readonly commits: number;
}

export type Fetched =
  | {
      readonly _tag: "fetched";
      readonly branch: string;
      /** The local branch before the fetch; null when this created it. */
      readonly previous: string | null;
      readonly tip: string;
      readonly base: string;
      readonly commits: number;
      /** `<short sha> <subject>`, newest first, at most ten. */
      readonly log: ReadonlyArray<string>;
    }
  | { readonly _tag: "refused"; readonly message: string };

const LOG_LINES = 10;

const refusedWith = (message: string): Fetched => ({ _tag: "refused", message });

/**
 * Fetch a change's bundle into the clone at `cwd` as `refs/heads/<branch>`. Only that branch
 * moves, and only by a fast-forward: the working tree, the index and the checked-out branch are
 * never touched, and no remote-tracking ref or FETCH_HEAD is written.
 */
export const fetchBundle = (
  cwd: string,
  bundle: BundleFacts & { readonly bytes: Uint8Array },
): Fetched => {
  if (git(cwd, ["check-ref-format", "--branch", bundle.branch]).status !== 0) {
    return refusedWith(`the bundle names a branch git does not accept: ${bundle.branch}`);
  }
  if (git(cwd, ["cat-file", "-e", `${bundle.base}^{commit}`]).status !== 0) {
    return refusedWith(
      `this clone lacks the change's base ${short(bundle.base)} · fetch it from origin, then run mend pull again`,
    );
  }
  if (gitCurrentBranch(cwd) === bundle.branch) {
    return refusedWith(
      `${bundle.branch} is checked out here · switch to another branch first; mend pull does not touch the working tree`,
    );
  }
  const ref = `refs/heads/${bundle.branch}`;
  const before = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const previous = before.status === 0 ? before.stdout.trim() : null;
  if (previous !== bundle.tip) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pull-"));
    try {
      const file = path.join(dir, "change.bundle");
      fs.writeFileSync(file, bundle.bytes, { mode: 0o600 });
      const fetched = git(cwd, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        file,
        `${ref}:${ref}`,
      ]);
      if (fetched.status !== 0) return refusedWith(gitWords(fetched));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const after = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout.trim();
  if (after !== bundle.tip) {
    return refusedWith(
      `${bundle.branch} is at ${short(after)} after the fetch, not ${short(bundle.tip)}`,
    );
  }
  const log = git(cwd, [
    "log",
    `--max-count=${LOG_LINES}`,
    "--format=%h %s",
    `${bundle.base}..${bundle.tip}`,
  ]);
  return {
    _tag: "fetched",
    branch: bundle.branch,
    previous,
    tip: bundle.tip,
    base: bundle.base,
    commits: bundle.commits,
    log: log.stdout.split("\n").filter((line) => line !== ""),
  };
};

/** What `mend pull` prints once the branch is here. */
export const fetchedLines = (
  fetched: Extract<Fetched, { _tag: "fetched" }>,
): ReadonlyArray<string> => {
  const moved =
    fetched.previous === null
      ? "created"
      : fetched.previous === fetched.tip
        ? "already here"
        : `moved from ${short(fetched.previous)}`;
  const commits = `${fetched.commits} ${fetched.commits === 1 ? "commit" : "commits"}`;
  const lines = [
    `${green("✓")} fetched ${fetched.branch} · ${short(fetched.tip)} · ${commits} on ${short(fetched.base)} · ${moved}`,
    ...fetched.log.map((line) => dim(`    ${line}`)),
  ];
  if (fetched.commits > fetched.log.length) {
    lines.push(dim(`    … ${fetched.commits - fetched.log.length} more`));
  }
  lines.push(`${dim("  switch to it")} git switch ${fetched.branch}`);
  return lines;
};

/** Bytes as the refusal states them: exact, then in the unit people read. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const numberField = (value: unknown, key: string): number | null => {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "number" ? field : null;
};

const stringField = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/** Why the server did not send the bundle, in its words; the size when it was too large. */
export const bundleRefusal = (downloaded: Downloaded): string => {
  const body = parseJson(downloaded.bytes);
  const size = numberField(body, "size");
  const limit = numberField(body, "limit");
  if (downloaded.status === 413 && size !== null && limit !== null) {
    return `bundle not sent · ${formatBytes(size)} (${size} bytes) · the server's limit is ${formatBytes(limit)} (MEND_BUDGET_BUNDLE_BYTES) · nothing was fetched`;
  }
  return stringField(body, "message") ?? `the bundle request answered ${downloaded.status}`;
};

/** The bundle's own facts, from its headers; null when the server sent none. */
export const bundleFactsOf = (downloaded: Downloaded): BundleFacts | null => {
  const branch = downloaded.header(BUNDLE_HEADERS.branch);
  const base = downloaded.header(BUNDLE_HEADERS.base);
  const tip = downloaded.header(BUNDLE_HEADERS.tip);
  const commits = Number(downloaded.header(BUNDLE_HEADERS.commits));
  if (branch === null || base === null || tip === null || !Number.isInteger(commits)) return null;
  return { branch, base, tip, commits };
};

export const pullCommand = async (
  api: ApiCall,
  download: Download,
  args: ReadonlyArray<string>,
  cwd: string = process.cwd(),
): Promise<void> => {
  const parsed = parsePullArgs(args);
  if ("error" in parsed) return fail(parsed.error);
  const top = gitTopLevel(cwd);
  if (top === null) {
    return fail(`${cwd} is not a git repository · run mend pull inside a clone of the project`);
  }
  const { session, project } = await findSession(api, parsed.args.session, parsed.args.project);
  const remotes = gitRemotes(top);
  const remote = remoteForOrigin(remotes, project.originUrl, top);
  if (remote === null && !parsed.args.force) {
    const here =
      remotes.length === 0
        ? "this clone has no remotes"
        : `this clone's remotes are ${remotes.map((r) => `${r.name} ${r.url}`).join(", ")}`;
    return fail(
      `${project.name}'s origin is ${project.originUrl ?? "not set"} · ${here} · run mend pull in a clone of it, or pass --force`,
    );
  }
  const view = await api<ChangeLandingsDto>("GET", `/sessions/${session.id}/landings`);
  if (view.changeId === null) {
    return fail(`nothing to pull · ${session.branch} holds no change yet`);
  }
  say(
    dim(
      `  pulling ${session.branch} · ${project.name} · session ${session.id.slice(0, 8)}${remote === null ? " · remotes not checked (--force)" : ` · ${remote.name} is the project's origin`}`,
    ),
  );
  const downloaded = await download(`/changes/${view.changeId}/bundle`);
  if (downloaded.status < 200 || downloaded.status >= 300) return fail(bundleRefusal(downloaded));
  const facts = bundleFactsOf(downloaded);
  if (facts === null) return fail("the server sent a bundle without its branch, base and tip");
  const fetched = fetchBundle(top, { ...facts, bytes: downloaded.bytes });
  if (fetched._tag === "refused") return fail(`nothing fetched · ${fetched.message}`);
  for (const line of fetchedLines(fetched)) say(line);
};
