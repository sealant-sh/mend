import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type LandingFact, landingFactLine, landingFactsFromWire } from "@mend/domain/workbench";

import { failureWords, noteRefusal } from "./failure-words.ts";
import type { ApiCall } from "./pair.ts";
import { gitCurrentBranch, gitTopLevel, normalizeRemoteUrl, redactCredentials } from "./shared.ts";

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
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);
const fail = (message: string): never => {
  process.stderr.write(`mend: ${redactCredentials(message)}\n`);
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
  readonly outcome: "pushed" | "pull-request" | "refused" | "failed" | "adopted";
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

/** What `POST /changes/:id/pull-request/check` found. */
export interface PullRequestCheckDto {
  readonly outcome: "adopted" | "observed" | "none" | "skipped";
  readonly reason: string | null;
  readonly landing: ChangeLandingDto | null;
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
  branchEncoded: "x-mend-bundle-branch-encoded",
  base: "x-mend-bundle-base",
  tip: "x-mend-bundle-tip",
  commits: "x-mend-bundle-commits",
  onto: "x-mend-bundle-onto",
};

// ─── arguments ──────────────────────────────────────────────────────────────

export interface LandArgs {
  readonly session: string;
  /** Only look on GitHub for a pull request opened outside Mend; push nothing. */
  readonly check: boolean;
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
  /** The local branch to fetch into; null for the session's own branch name. */
  readonly branch: string | null;
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

/**
 * `mend land <session> [--branch <name>] [--no-pr] [--title <text>] [--project <p>]`, or
 * `mend land <session> --check [--project <p>]`.
 */
export const parseLandArgs = (args: ReadonlyArray<string>): Parsed<LandArgs> => {
  const flags = parseFlags(args, ["--branch", "--title", "--project"], ["--no-pr", "--check"]);
  if ("error" in flags) return flags;
  const [session, extra] = flags.positional;
  if (session === undefined) return { error: "name the session to land" };
  if (extra !== undefined) return { error: `one session only; "${extra}" is extra` };
  const check = flags.on.has("--check");
  if (
    check &&
    (flags.values.has("--branch") || flags.values.has("--title") || flags.on.has("--no-pr"))
  ) {
    return { error: "--check pushes nothing; it takes no --branch, --title or --no-pr" };
  }
  const branch = flags.values.get("--branch")?.trim() ?? null;
  if (branch === "") return { error: "--branch needs a name" };
  const title = flags.values.get("--title")?.trim() ?? null;
  return {
    args: {
      session,
      check,
      branch,
      pullRequest: !flags.on.has("--no-pr"),
      title: title === "" ? null : title,
      project: flags.values.get("--project") ?? null,
    },
  };
};

/** `mend pull <session> [--branch <name>] [--force] [--project <p>]`. */
export const parsePullArgs = (args: ReadonlyArray<string>): Parsed<PullArgs> => {
  const flags = parseFlags(args, ["--project", "--branch"], ["--force"]);
  if ("error" in flags) return flags;
  const [session, extra] = flags.positional;
  if (session === undefined) return { error: "name the session to pull" };
  if (extra !== undefined) return { error: `one session only; "${extra}" is extra` };
  const branch = flags.values.get("--branch")?.trim() ?? null;
  if (branch === "") return { error: "--branch needs a name" };
  return {
    args: {
      session,
      force: flags.on.has("--force"),
      project: flags.values.get("--project") ?? null,
      branch,
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

/** What `mend land --check` found, as one line. */
export const checkLine = (check: PullRequestCheckDto): string => {
  const pullRequest = check.landing?.pullRequest ?? null;
  switch (check.outcome) {
    case "adopted":
      return pullRequest === null
        ? "pull request recorded · opened outside Mend"
        : `pull request #${pullRequest.number} recorded · opened outside Mend · ${pullRequest.url}`;
    case "observed":
      return pullRequest === null
        ? "pull request already recorded"
        : `pull request #${pullRequest.number} already recorded · ${pullRequest.state} · observed`;
    case "none":
      return "no pull request on GitHub for the change's branches or the agent's commit";
    case "skipped":
      return `GitHub not checked · ${check.reason ?? "no reason given"}`;
  }
};

export const landCommand = async (api: ApiCall, args: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseLandArgs(args);
  if ("error" in parsed) return fail(parsed.error);
  const { session, project } = await findSession(api, parsed.args.session, parsed.args.project);
  if (parsed.args.check) {
    const before = await api<ChangeLandingsDto>("GET", `/sessions/${session.id}/landings`);
    if (before.changeId === null) return fail("the session's worktree holds no change yet");
    const check = await api<PullRequestCheckDto>(
      "POST",
      `/changes/${before.changeId}/pull-request/check`,
    );
    const mark =
      check.outcome === "adopted" || check.outcome === "observed" ? green("✓") : dim("·");
    say(`${mark} ${checkLine(check)}`);
    const after = await api<ChangeLandingsDto>("GET", `/sessions/${session.id}/landings`);
    const facts = readFacts(after.facts);
    if (facts.length > 0) {
      say(dim("  observed"));
      for (const fact of facts) say(`    ${landingFactLine(fact, new Date())}`);
    }
    return;
  }
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
  /** Commits the bundle carries; the change's own count (`base..tip`) is taken in the clone. */
  readonly commits: number;
  /** The earlier pull the server built the change on; null when it built on none. */
  readonly onto?: string | null;
}

export type Fetched =
  | {
      readonly _tag: "fetched";
      readonly branch: string;
      /** The local branch before the fetch; null when this created it. */
      readonly previous: string | null;
      readonly tip: string;
      readonly base: string;
      /** The change's commits from its base (`base..tip`), counted in the clone. */
      readonly commits: number;
      /** `<short sha> <subject>`, newest first, at most ten. */
      readonly log: ReadonlyArray<string>;
    }
  | {
      /**
       * The local branch already holds the change: the same tree on the same parents, in a
       * commit Mend wrote at an earlier pull. Nothing moved.
       */
      readonly _tag: "unchanged";
      readonly branch: string;
      /** Where the local branch stays. */
      readonly here: string;
      /** The commit this pull's bundle carried for the same change. */
      readonly tip: string;
    }
  | {
      /**
       * The local branch holds a commit the change does not build on, so it cannot fast-forward.
       * `moved`: the branch is not where the last `mend pull` left it (`pulled`, null when no pull
       * here recorded it). `not-built-on`: it is, but the server did not build on that pull (it
       * no longer holds the commit, or it predates building on one).
       */
      readonly _tag: "diverged";
      readonly branch: string;
      readonly here: string;
      readonly tip: string;
      readonly reason: "moved" | "not-built-on";
      readonly pulled: string | null;
    }
  | { readonly _tag: "refused"; readonly message: string };

const LOG_LINES = 10;

/**
 * Where a clone records the commit `mend pull` last left a branch at, one ref per local branch
 * under Mend's own namespace. The next pull asks the server to build on it.
 */
export const pulledRefOf = (branch: string): string => `refs/mend/pulled/${branch}`;

const commitAt = (cwd: string, ref: string): string | null => {
  const run = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return run.status === 0 ? run.stdout.trim() : null;
};

/**
 * The commit the next bundle should build on: the branch's head, when the last `mend pull` left it
 * there. Null when the branch is new, moved since, or no pull here recorded it.
 */
export const lastPullOf = (cwd: string, branch: string): string | null => {
  const pulled = commitAt(cwd, pulledRefOf(branch));
  return pulled !== null && pulled === commitAt(cwd, `refs/heads/${branch}`) ? pulled : null;
};

/** Why a pull cannot move the branch, and how to go on. */
export const divergedMessage = (
  diverged: Extract<Fetched, { _tag: "diverged" }>,
  session: string,
): string => {
  const { branch, here, tip, pulled } = diverged;
  const why =
    diverged.reason === "not-built-on"
      ? `the server did not build the change on ${branch}'s last pull ${short(here)}: it no longer holds that commit, or it predates building on one`
      : pulled === null
        ? `${branch} here is at ${short(here)}, which no mend pull in this clone left there`
        : `${branch} moved since the last mend pull: it is at ${short(here)}, the pull left ${short(pulled)}`;
  return `${why} · the change's ${short(tip)} does not build on it, so nothing moved · pull into a new branch with mend pull ${session} --branch <name>, or delete ${branch} and pull again`;
};

/** A commit's tree and parents, the parts that make it the same change. */
const treeAndParents = (cwd: string, sha: string): string | null => {
  const run = git(cwd, ["show", "-s", "--format=%T %P", `${sha}^{commit}`]);
  return run.status === 0 ? run.stdout.trim() : null;
};

const refusedWith = (message: string): Fetched => ({ _tag: "refused", message });

/**
 * Fetch a change's bundle into the clone at `cwd` as `refs/heads/<into>` (the bundle's branch by
 * default). Only that branch moves, and only by a fast-forward: the working tree, the index and the
 * checked-out branch are never touched, and no remote-tracking ref or FETCH_HEAD is written. The
 * commit the branch is left at is recorded under `pulledRefOf`, for the next pull to build on.
 */
export const fetchBundle = (
  cwd: string,
  bundle: BundleFacts & { readonly bytes: Uint8Array },
  into: string = bundle.branch,
): Fetched => {
  for (const name of new Set([bundle.branch, into])) {
    if (git(cwd, ["check-ref-format", "--branch", name]).status !== 0) {
      return refusedWith(
        name === bundle.branch
          ? `the bundle names a branch git does not accept: ${name}`
          : `git does not accept ${name} as a branch name`,
      );
    }
  }
  if (git(cwd, ["cat-file", "-e", `${bundle.base}^{commit}`]).status !== 0) {
    return refusedWith(
      `this clone lacks the change's base ${short(bundle.base)} · fetch it from origin, then run mend pull again`,
    );
  }
  if (gitCurrentBranch(cwd) === into) {
    return refusedWith(
      `${into} is checked out here · switch to another branch first; mend pull does not touch the working tree`,
    );
  }
  const ref = `refs/heads/${into}`;
  const source = `refs/heads/${bundle.branch}`;
  const previous = commitAt(cwd, ref);
  const recordAt = (sha: string): void => {
    git(cwd, ["update-ref", pulledRefOf(into), sha]);
  };
  if (previous === bundle.tip) {
    // A server that builds on the last pull answers an unchanged session with that pull's commit.
    recordAt(previous);
    return { _tag: "unchanged", branch: into, here: previous, tip: bundle.tip };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pull-"));
  try {
    const file = path.join(dir, "change.bundle");
    fs.writeFileSync(file, bundle.bytes, { mode: 0o600 });
    if (previous !== null) {
      // Read the bundle's objects without moving any ref, then decide: a fast-forward moves
      // the branch, the same change committed anew leaves it, and anything else says why not.
      const objects = git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", file, source]);
      if (objects.status !== 0) return refusedWith(gitWords(objects));
      if (git(cwd, ["merge-base", "--is-ancestor", previous, bundle.tip]).status !== 0) {
        // Mend commits the checkpoint anew for every bundle, so a session that has not moved
        // since the last pull arrives as a different commit of the same tree on the same
        // parents (from a server that does not build on the last pull).
        const here = treeAndParents(cwd, previous);
        if (here !== null && here === treeAndParents(cwd, bundle.tip)) {
          recordAt(previous);
          return { _tag: "unchanged", branch: into, here: previous, tip: bundle.tip };
        }
        const pulled = commitAt(cwd, pulledRefOf(into));
        return {
          _tag: "diverged",
          branch: into,
          here: previous,
          tip: bundle.tip,
          reason: pulled === previous && bundle.onto !== previous ? "not-built-on" : "moved",
          pulled,
        };
      }
    }
    const fetched = git(cwd, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      file,
      `${source}:${ref}`,
    ]);
    if (fetched.status !== 0) return refusedWith(gitWords(fetched));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const after = commitAt(cwd, ref) ?? "";
  if (after !== bundle.tip) {
    return refusedWith(`${into} is at ${short(after)} after the fetch, not ${short(bundle.tip)}`);
  }
  recordAt(after);
  // Counted here, from the base: a bundle built on the last pull carries only what is new.
  const counted = Number(git(cwd, ["rev-list", "--count", `${bundle.base}..${bundle.tip}`]).stdout);
  const log = git(cwd, [
    "log",
    `--max-count=${LOG_LINES}`,
    "--format=%h %s",
    `${bundle.base}..${bundle.tip}`,
  ]);
  return {
    _tag: "fetched",
    branch: into,
    previous,
    tip: bundle.tip,
    base: bundle.base,
    commits: Number.isInteger(counted) && counted > 0 ? counted : bundle.commits,
    log: log.stdout.split("\n").filter((line) => line !== ""),
  };
};

/** What `mend pull` prints once the branch is here. */
export const fetchedLines = (
  fetched: Extract<Fetched, { _tag: "fetched" | "unchanged" }>,
): ReadonlyArray<string> => {
  if (fetched._tag === "unchanged") {
    return [
      `${green("✓")} ${fetched.branch} · ${short(fetched.here)} · unchanged since the last pull · nothing moved`,
      `${dim("  switch to it")} git switch ${fetched.branch}`,
    ];
  }
  const moved = fetched.previous === null ? "created" : `moved from ${short(fetched.previous)}`;
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
  const call = "GET /changes/:changeId/bundle";
  return noteRefusal(call, downloaded.status, failureWords(downloaded.status, body)).words;
};

/** A percent-encoded header's value; null when absent or not valid percent-encoding. */
const decodedHeader = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** The bundle's own facts, from its headers; null when the server sent none. */
export const bundleFactsOf = (downloaded: Downloaded): BundleFacts | null => {
  // The encoded name first: it carries any branch, where the plain header cannot hold one with
  // characters above U+00FF. A server before it sends only the plain one.
  const branch =
    decodedHeader(downloaded.header(BUNDLE_HEADERS.branchEncoded)) ??
    downloaded.header(BUNDLE_HEADERS.branch);
  const base = downloaded.header(BUNDLE_HEADERS.base);
  const tip = downloaded.header(BUNDLE_HEADERS.tip);
  const commits = Number(downloaded.header(BUNDLE_HEADERS.commits));
  if (branch === null || base === null || tip === null || !Number.isInteger(commits)) return null;
  return { branch, base, tip, commits, onto: downloaded.header(BUNDLE_HEADERS.onto) };
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
  const into = parsed.args.branch ?? session.branch;
  // The commit this clone pulled last: a server that still holds it builds the change on it, so
  // pull, keep working, pull again fast-forwards. An older server ignores the question.
  const onto = lastPullOf(top, into);
  const downloaded = await download(
    `/changes/${view.changeId}/bundle${onto === null ? "" : `?onto=${onto}`}`,
  );
  if (downloaded.status < 200 || downloaded.status >= 300) return fail(bundleRefusal(downloaded));
  const facts = bundleFactsOf(downloaded);
  if (facts === null) return fail("the server sent a bundle without its branch, base and tip");
  const fetched = fetchBundle(top, { ...facts, bytes: downloaded.bytes }, into);
  if (fetched._tag === "refused") return fail(`nothing fetched · ${fetched.message}`);
  if (fetched._tag === "diverged") {
    return fail(`nothing fetched · ${divergedMessage(fetched, parsed.args.session)}`);
  }
  for (const line of fetchedLines(fetched)) say(line);
};
