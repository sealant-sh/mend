/**
 * `mend import t3`: T3 Code's threads on this machine become Mend sessions holding their own
 * Claude or Codex conversations. Each distinct checkout is handed off once, the way `mend handoff`
 * does it, with no workspace held and no agent started; each thread's conversation goes to the
 * server as one archive, and the server rewrites its paths when the session first launches.
 * The command shows its plan first and sends nothing on `--dry-run`.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CONVERSATION_ARCHIVE_CONTENT_TYPE,
  type ConversationArchiveEntry,
  type ConversationArchiveHeader,
  EFFORT_LEVELS,
  encodeConversationArchive,
  HANDOFF_SEND_ATTEMPTS,
  isImportedConversationPath,
  readTermsAnswer,
} from "@mend/domain/workbench";
import { checkoutOf } from "@mend/local-git/handoff";
import { Effect } from "effect";

import { failureWords, noteRefusal } from "./failure-words.ts";
import {
  handOffForImport,
  type HandoffServer,
  type HandoffTarget,
  handoffTargetNeedsAgent,
  handoffTargetOf,
  type ProjectDto,
  SHARE_READY_MS,
} from "./handoff.ts";
import { formatBytes } from "./landing.ts";
import { askYesNo, confirmPlan } from "./shared-workspace.ts";
import { redactCredentials } from "./shared.ts";
import {
  type GoneCandidate,
  type ImportCandidate,
  type ImportHarness,
  readT3ImportCandidates,
  type ReadyCandidate,
  type SkipReason,
  type T3ImportScanInput,
} from "./t3-import.ts";
import { isTerminal } from "./terminal.ts";

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = paint("2");
const green = paint("32");
const amber = paint("33");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);

export interface ImportT3Io {
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<boolean>;
}

export interface ImportT3Args {
  readonly projects: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<string>;
  readonly archived: boolean;
  readonly dryRun: boolean;
}

const USAGE =
  "usage: mend import t3 [--project <p>]... [--thread <id>]... [--archived] [--dry-run] [--yes]";

export const parseImportT3Args = (
  args: ReadonlyArray<string>,
): { readonly args: ImportT3Args } | { readonly error: string } => {
  const projects: Array<string> = [];
  const threads: Array<string> = [];
  let archived = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--project" || arg === "--thread") {
      const value = args[index + 1];
      if (value === undefined || value.trim() === "") return { error: `${arg} needs a value` };
      (arg === "--project" ? projects : threads).push(value);
      index += 1;
    } else if (arg === "--archived") archived = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes" || arg === "-y") continue;
    else
      return {
        error: `${arg.startsWith("-") ? `unknown flag ${arg}` : `unexpected ${arg}`} · ${USAGE}`,
      };
  }
  return { args: { projects, threads, archived, dryRun } };
};

const sizeOf = (bytes: number): string => formatBytes(bytes).replace(/\.0 /u, " ");

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A path as a person reads it here: `~` for their home. */
const shown = (dir: string): string => {
  const home = os.homedir();
  return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
};

const HARNESS_DIR: Readonly<Record<ImportHarness, string>> = {
  claude: ".claude",
  codex: ".codex",
};

/**
 * Words for a thread the reader skipped, or the command left out, saying why it stays behind.
 */
const skipWords = (skip: SkipReason): string => {
  switch (skip.reason) {
    case "no-native-conversation":
      return "T3 Code recorded no Claude or Codex conversation for it";
    case "several-native-conversations":
      return "it switched agents and T3 Code does not say which conversation is the current one";
    case "unsupported-harness":
      return `it ran ${skip.driver === "" ? "an agent T3 Code did not name" : skip.driver}, which Mend cannot import`;
    case "conversation-not-on-machine":
      return `its ${skip.harness} conversation is not on this machine (looked in ${skip.harnessHomes.map(shown).join(", ")})`;
    case "checkout-gone":
      return skip.workingDirectory === null
        ? "T3 Code recorded no checkout for it"
        : `its checkout ${shown(skip.workingDirectory)} is gone, and its project's folder is not a checkout with an origin to start again from`;
    case "not-a-git-checkout":
      return `${shown(skip.workingDirectory)} is not a git checkout`;
    case "checkout-unreadable":
      return `${shown(skip.workingDirectory)} could not be read: ${skip.message}`;
    case "no-origin":
      return `${shown(skip.root)} has no origin, so Mend cannot adopt it`;
  }
};

interface ArchiveFile {
  /** Relative to the person's home, as the archive names it (`.claude/projects/…`). */
  readonly archivePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
}

/** What one thread's conversation sends, worked out before a byte of it is read. */
interface ArchivePlan {
  readonly home: string;
  readonly checkout: string;
  readonly files: ReadonlyArray<ArchiveFile>;
  /** Files of the conversation the import does not carry (`tasks/<id>/.lock`, `*.jsonl.zst`). */
  readonly leftBehind: number;
  readonly bytes: number;
}

type Sendable = ReadyCandidate | GoneCandidate;

/**
 * Where a harness home sits so the server's rewrite knows its paths as harness state: the rewrite
 * reads `<home>/.claude/…` and `<home>/.codex/…`, so a home whose folder has that name is mapped
 * with its parent as the home. Any other name (a `CLAUDE_CONFIG_DIR` of `~/.config/claude-work`)
 * is null: its transcript's references to plans, tool results and tasks would not be rewritten.
 */
const homeOf = (harness: ImportHarness, harnessHome: string): string | null => {
  const resolved = path.resolve(harnessHome);
  const parent = path.dirname(resolved);
  return path.basename(resolved) === HARNESS_DIR[harness] && parent !== resolved ? parent : null;
};

/**
 * The checkout as the transcript names it: the directory the thread ran in when that is the
 * checkout's top, else its top in the same spelling.
 */
const sourceCheckoutOf = (candidate: Sendable): string => {
  const recorded = path.resolve(
    candidate._tag === "ready" ? candidate.checkout.workingDirectory : candidate.workingDirectory,
  );
  if (candidate._tag === "gone") return recorded;
  let real: string;
  try {
    real = fs.realpathSync(recorded);
  } catch {
    return recorded;
  }
  const below = path.relative(candidate.checkout.root, real);
  if (below === "") return recorded;
  return recorded.endsWith(`/${below}`)
    ? recorded.slice(0, -below.length - 1)
    : candidate.checkout.root;
};

const archivePlanOf = (candidate: Sendable): ArchivePlan | { readonly skip: string } => {
  const home = homeOf(candidate.harness, candidate.harnessHome);
  if (home === null) {
    return {
      skip: `its conversation is in ${shown(candidate.harnessHome)}, a ${candidate.harness} home not named ${HARNESS_DIR[candidate.harness]}, whose paths Mend cannot rewrite`,
    };
  }
  const prefix = HARNESS_DIR[candidate.harness];
  const all = candidate.files.map((file) => ({
    archivePath: `${prefix}/${file.relativePath}`,
    absolutePath: path.join(candidate.harnessHome, file.relativePath),
    bytes: file.bytes,
  }));
  const files = all.filter((file) =>
    isImportedConversationPath(candidate.harness, file.archivePath),
  );
  if (!files.some((file) => file.archivePath === `${prefix}/${candidate.transcript}`)) {
    return {
      skip: `its transcript ${candidate.transcript} is not a file Mend takes`,
    };
  }
  return {
    home,
    checkout: sourceCheckoutOf(candidate),
    files,
    leftBehind: all.length - files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
};

const escapeRegExp = (text: string): string => text.replaceAll(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * Claude plan files a Claude conversation names (`~/.claude/plans/<name>.md`, or the same under
 * its home), which the reader does not list. Read from the conversation's text files' bytes as
 * Latin-1, a one-byte view of UTF-8 in which an ASCII plan name matches as it is.
 */
const planFilesNamed = (
  harnessHome: string,
  texts: ReadonlyArray<Uint8Array>,
): ReadonlyArray<ArchiveFile> => {
  const home = escapeRegExp(Buffer.from(harnessHome, "utf8").toString("latin1"));
  const pattern = new RegExp(`(?:${home}|~/\\.claude)/plans/([A-Za-z0-9_-]+)\\.md`, "g");
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of Buffer.from(text.buffer, text.byteOffset, text.byteLength)
      .toString("latin1")
      .matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].toSorted().flatMap((name) => {
    const absolutePath = path.join(harnessHome, "plans", `${name}.md`);
    try {
      const stat = fs.lstatSync(absolutePath);
      return stat.isFile()
        ? [
            {
              archivePath: `.claude/plans/${name}.md`,
              absolutePath,
              bytes: stat.size,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const effortOf = (value: string | null) => EFFORT_LEVELS.find((level) => level === value) ?? null;

/**
 * The conversation's request body, read now: its planned files and, for Claude, the plan files
 * its transcript and subagents name. One conversation's bytes are in memory at a time: these, and
 * the body they are copied into.
 */
const archiveOf = (
  candidate: Sendable,
  plan: ArchivePlan,
): Uint8Array<ArrayBuffer> | { readonly unreadable: string } => {
  const entries: Array<ConversationArchiveEntry> = [];
  for (const file of plan.files) {
    try {
      entries.push({
        relativePath: file.archivePath,
        bytes: fs.readFileSync(file.absolutePath),
      });
    } catch (error) {
      return {
        unreadable: `${file.absolutePath} could not be read: ${String(error)}`,
      };
    }
  }
  if (candidate.harness === "claude") {
    const texts = entries
      .filter((entry) => entry.relativePath.endsWith(".jsonl"))
      .map((entry) => entry.bytes);
    for (const file of planFilesNamed(candidate.harnessHome, texts)) {
      try {
        entries.push({
          relativePath: file.archivePath,
          bytes: fs.readFileSync(file.absolutePath),
        });
      } catch {
        // A plan removed since it was named stays behind; the conversation still resumes.
      }
    }
  }
  const header: ConversationArchiveHeader = {
    format: 1,
    harness: candidate.harness,
    nativeId: candidate.nativeId,
    source: { checkout: plan.checkout, home: plan.home },
    title: candidate.thread.title.trim() === "" ? null : candidate.thread.title.slice(0, 200),
    model: candidate.model === null ? null : candidate.model.slice(0, 200),
    effort: effortOf(candidate.effort),
    permissionMode: candidate.permissionMode,
    files: entries.map((entry) => ({
      relativePath: entry.relativePath,
      byteLength: entry.bytes.byteLength,
      sha256: sha256(entry.bytes),
    })),
  };
  const body = encodeConversationArchive(header, entries);
  // The encoder allocates its body with `new Uint8Array(n)`, always on an ArrayBuffer.
  const buffer = body.buffer;
  if (!(buffer instanceof ArrayBuffer))
    throw new Error("the conversation archive is not on an ArrayBuffer");
  return new Uint8Array(buffer, body.byteOffset, body.byteLength);
};

// ─── the plan ────────────────────────────────────────────────────────────────

type Earlier =
  | { readonly _tag: "new" }
  | { readonly _tag: "imported"; readonly sessionId: string }
  | { readonly _tag: "unknown"; readonly words: string };

interface PlannedThread {
  readonly candidate: Sendable;
  readonly plan: ArchivePlan;
  earlier: Earlier;
}

/** Threads that ran in one checkout, which is handed off once for all of them. */
interface CheckoutGroup {
  readonly _tag: "checkout";
  readonly root: string;
  readonly originUrl: string;
  readonly threads: Array<PlannedThread>;
}

/** Threads whose removed checkout was one directory: one new worktree from origin holds them. */
interface GoneGroup {
  readonly _tag: "gone";
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly root: string;
  readonly originUrl: string;
  readonly threads: Array<PlannedThread>;
}

type Group = CheckoutGroup | GoneGroup;

interface ProjectPlan {
  readonly title: string;
  readonly groups: Array<Group>;
  readonly left: Array<{ readonly title: string; readonly words: string }>;
}

const projectTitleOf = (candidate: ImportCandidate): string =>
  candidate.thread.project.title ?? candidate.thread.project.id;

const planOf = (candidates: ReadonlyArray<ImportCandidate>): ReadonlyArray<ProjectPlan> => {
  const projects = new Map<string, ProjectPlan>();
  for (const candidate of candidates) {
    const key = candidate.thread.project.id;
    const project =
      projects.get(key) ??
      ({
        title: projectTitleOf(candidate),
        groups: [],
        left: [],
      } satisfies ProjectPlan);
    projects.set(key, project);
    const title = candidate.thread.title;
    if (candidate._tag === "skipped") {
      project.left.push({ title, words: skipWords(candidate.skip) });
      continue;
    }
    const plan = archivePlanOf(candidate);
    if ("skip" in plan) {
      project.left.push({ title, words: plan.skip });
      continue;
    }
    const thread: PlannedThread = { candidate, plan, earlier: { _tag: "new" } };
    const group =
      candidate._tag === "ready"
        ? project.groups.find(
            (each) => each._tag === "checkout" && each.root === candidate.checkout.root,
          )
        : project.groups.find(
            (each) => each._tag === "gone" && each.workingDirectory === candidate.workingDirectory,
          );
    if (group !== undefined) group.threads.push(thread);
    else
      project.groups.push(
        candidate._tag === "ready"
          ? {
              _tag: "checkout",
              root: candidate.checkout.root,
              originUrl: candidate.checkout.originUrl,
              threads: [thread],
            }
          : {
              _tag: "gone",
              workingDirectory: candidate.workingDirectory,
              branch: candidate.branch,
              root: candidate.projectCheckout.root,
              originUrl: candidate.projectCheckout.originUrl,
              threads: [thread],
            },
      );
  }
  return [...projects.values()];
};

// ─── the server ──────────────────────────────────────────────────────────────

export type ImportT3Deps = HandoffServer;

class Stop extends Error {
  readonly words: string;
  readonly code: number;
  constructor(words: string, code = 1) {
    super(words);
    this.words = words;
    this.code = code;
  }
}

const wordsOfError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/** The largest conversation the server takes; it refuses the run when it takes none. */
const conversationLimit = async (deps: ImportT3Deps): Promise<number> => {
  const reply = await deps.download("/handoffs");
  const body = parseJson(reply.bytes);
  const terms = readTermsAnswer({ status: reply.status, body });
  if (terms._tag === "refused") {
    const failure = noteRefusal("GET /handoffs", reply.status, failureWords(reply.status, body));
    throw new Stop(`${failure.words} · nothing was imported`);
  }
  const limit = fieldOf(body, "conversationBytes");
  if (
    terms._tag !== "terms" ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    const version = await deps.serverVersion();
    throw new Stop(
      `this Mend server${version === null ? "" : ` (${version})`} takes no imported conversations · upgrade it, then import again · nothing was imported`,
    );
  }
  return limit;
};

interface SessionLike {
  readonly id: string;
  readonly worktreeId?: string;
}

const earlierImport = async (
  deps: ImportT3Deps,
  projectId: string,
  candidate: Sendable,
): Promise<Earlier> => {
  try {
    const found = await deps.api<{ readonly session: SessionLike | null }>(
      "GET",
      `/projects/${projectId}/conversations?harness=${candidate.harness}&nativeId=${encodeURIComponent(candidate.nativeId)}`,
    );
    return found.session === null
      ? { _tag: "new" }
      : { _tag: "imported", sessionId: found.session.id };
  } catch (error) {
    return { _tag: "unknown", words: wordsOfError(error) };
  }
};

type Landing = { readonly session: string } | { readonly worktree: string };

type Sent =
  | {
      readonly _tag: "imported";
      readonly sessionId: string;
      readonly turns: number;
      readonly replayed: boolean;
    }
  | {
      readonly _tag: "refused";
      readonly reason: string | null;
      readonly words: string;
    };

const GATEWAY = new Set([502, 503, 504]);

const sendConversation = async (
  deps: ImportT3Deps,
  projectId: string,
  landing: Landing,
  body: Uint8Array<ArrayBuffer>,
): Promise<Sent> => {
  const query =
    "session" in landing
      ? `session=${encodeURIComponent(landing.session)}`
      : `worktree=${encodeURIComponent(landing.worktree)}`;
  const route = `/projects/${projectId}/conversations?${query}`;
  for (let attempt = 1; ; attempt += 1) {
    const uploaded = await deps.spin(
      `uploading ${sizeOf(body.byteLength)}`,
      deps.upload(route, CONVERSATION_ARCHIVE_CONTENT_TYPE, body),
    );
    const status = uploaded._tag === "answered" ? uploaded.status : null;
    if (status !== null && !GATEWAY.has(status) && uploaded._tag === "answered") {
      const answer = parseJson(uploaded.bytes);
      if (status >= 200 && status < 300) {
        const session = fieldOf(answer, "session");
        const id = fieldOf(session, "id");
        const turns = fieldOf(answer, "turns");
        const replayed = fieldOf(answer, "replayed");
        return typeof id === "string"
          ? {
              _tag: "imported",
              sessionId: id,
              turns: typeof turns === "number" ? turns : 0,
              replayed: replayed === true,
            }
          : {
              _tag: "refused",
              reason: null,
              words:
                "the server's answer to the import is in a shape this CLI cannot read · update mend",
            };
      }
      const failure = noteRefusal(`POST ${route}`, status, failureWords(status, answer));
      const reason = fieldOf(answer, "reason");
      return {
        _tag: "refused",
        reason: typeof reason === "string" ? reason : null,
        words: failure.words,
      };
    }
    const words = uploaded._tag === "answered" ? `HTTP ${uploaded.status}` : uploaded.message;
    // The server recognises the same conversation by its id, so sending it again never makes two.
    if (attempt === HANDOFF_SEND_ATTEMPTS) {
      return {
        _tag: "refused",
        reason: null,
        words: `${words} · sent ${HANDOFF_SEND_ATTEMPTS} times with no answer from Mend · run the import again to find out`,
      };
    }
    say(dim(`    ${words} · sending the same conversation again`));
  }
};

/**
 * The branch a new worktree for a gone checkout is cut from: the thread's own when Mend's copy
 * of origin has it, after a fetch, else the project's default branch (null).
 */
const baseFor = async (
  deps: ImportT3Deps,
  projectId: string,
  branch: string | null,
): Promise<string | null> => {
  if (branch === null) return null;
  const branches = await deps.api<ReadonlyArray<{ readonly name: string }>>(
    "POST",
    `/projects/${projectId}/refresh`,
  );
  return branches.some((each) => each.name === branch) ? branch : null;
};

// ─── printing ────────────────────────────────────────────────────────────────

const threadFacts = (thread: PlannedThread, limit: number, blocked: boolean): string => {
  const { candidate, plan } = thread;
  const facts = [candidate.harness, sizeOf(plan.bytes)];
  if (plan.leftBehind > 0)
    facts.push(`${plural(plan.leftBehind, "file", "files")} Mend does not take left behind`);
  if (candidate.thread.archived) facts.push("archived");
  if (plan.bytes > limit)
    return `${amber("!")} ${candidate.thread.title} · ${facts.join(" · ")} · over the server's ${sizeOf(limit)} limit, so it stays here; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES`;
  switch (thread.earlier._tag) {
    case "imported":
      return `${dim("·")} ${candidate.thread.title} · ${facts.join(" · ")} · already imported as session ${thread.earlier.sessionId.slice(0, 8)}`;
    case "unknown":
      return `${amber("!")} ${candidate.thread.title} · ${facts.join(" · ")} · Mend could not say whether it was imported: ${thread.earlier.words}`;
    case "new":
      return blocked
        ? `${amber("!")} ${candidate.thread.title} · ${facts.join(" · ")} · stays here with its checkout`
        : `${green("✓")} ${candidate.thread.title} · ${facts.join(" · ")}`;
  }
};

const pending = (thread: PlannedThread, limit: number): boolean =>
  thread.earlier._tag === "new" && thread.plan.bytes <= limit;

interface Resolved {
  readonly target: HandoffTarget | { readonly kind: "refused"; readonly words: string };
}

const targetLine = (resolved: Resolved): string =>
  resolved.target.kind === "project"
    ? dim(`into project ${resolved.target.project.name}`)
    : resolved.target.kind === "adopt"
      ? `adopts ${resolved.target.repository} as ${resolved.target.name}`
      : `${amber("!")} ${resolved.target.words}`;

const groupLine = (group: Group, resolved: Resolved, limit: number): string => {
  const sending = group.threads.filter((thread) => pending(thread, limit)).length;
  if (resolved.target.kind === "refused") {
    const where =
      group._tag === "checkout" ? shown(group.root) : `${shown(group.workingDirectory)} is gone`;
    return `  ${where} · ${amber("!")} not imported: ${resolved.target.words}`;
  }
  if (group._tag === "checkout") {
    const how = sending === 0 ? "nothing to hand off" : "handed off once, your checkout unchanged";
    return `  ${shown(group.root)} · ${how} · ${targetLine(resolved)}`;
  }
  const onto =
    group.branch === null
      ? "the default branch"
      : `${group.branch} if origin has it, else the default branch`;
  return `  ${shown(group.workingDirectory)} is gone · a new worktree from origin on ${onto} · ${targetLine(resolved)}`;
};

// ─── the command ─────────────────────────────────────────────────────────────

interface Outcome {
  readonly imported: Array<{
    readonly title: string;
    readonly sessionId: string;
    readonly harness: string;
    readonly turns: number;
  }>;
  readonly failed: Array<{ readonly what: string; readonly words: string }>;
}

const importGroup = async (
  deps: ImportT3Deps,
  group: Group,
  target: HandoffTarget,
  threads: ReadonlyArray<PlannedThread>,
  limit: number,
  outcome: Outcome,
): Promise<ProjectDto | null> => {
  const first = threads[0];
  if (first === undefined) return null;
  const failAll = (words: string) => {
    for (const thread of threads)
      outcome.failed.push({ what: thread.candidate.thread.title, words });
  };
  let project: ProjectDto;
  let landing: {
    readonly session: string | null;
    readonly worktree: string | null;
  };
  if (group._tag === "checkout") {
    const found = checkoutOf(group.root);
    if (found._tag !== "checkout") {
      failAll(`${shown(group.root)}: ${found._tag === "refused" ? found.message : "interrupted"}`);
      return null;
    }
    const handed = await handOffForImport(deps, found.checkout, target, first.candidate.harness);
    if (handed._tag === "interrupted") throw new Stop(handed.words, handed.code);
    if (handed._tag === "refused") {
      outcome.failed.push({
        what: `the handoff of ${shown(group.root)}`,
        words: handed.words,
      });
      failAll(`its checkout's handoff failed`);
      return null;
    }
    project = handed.project;
    landing = {
      session: handed.received.session.id,
      worktree: handed.received.worktree.id,
    };
  } else {
    try {
      project =
        target.kind === "project"
          ? target.project
          : await deps.api<ProjectDto>("POST", "/projects", {
              name: target.name,
              source: target.source,
            });
      if (target.kind === "adopt")
        say(`${green("✓")} adopted · ${project.name} · ${dim(project.storePath)}`);
      const base = await baseFor(deps, project.id, group.branch);
      const session = await deps.api<SessionLike & { readonly worktree?: string }>(
        "POST",
        `/projects/${project.id}/sessions`,
        {
          harness: first.candidate.harness,
          label: null,
          name: null,
          base,
        },
      );
      say(
        `${green("✓")} new worktree ${session.worktree ?? ""} on ${base ?? project.defaultBranch}${group.branch !== null && base === null ? dim(` · origin has no ${group.branch}`) : ""}`,
      );
      landing = { session: session.id, worktree: session.worktreeId ?? null };
    } catch (error) {
      if (error instanceof Stop) throw error;
      failAll(`no worktree was made for ${shown(group.workingDirectory)}: ${wordsOfError(error)}`);
      return null;
    }
  }

  let session = landing.session;
  for (const thread of threads) {
    const { candidate } = thread;
    const body = archiveOf(candidate, thread.plan);
    if ("unreadable" in body) {
      outcome.failed.push({
        what: candidate.thread.title,
        words: body.unreadable,
      });
      continue;
    }
    if (body.byteLength > limit) {
      outcome.failed.push({
        what: candidate.thread.title,
        words: `its conversation is ${sizeOf(body.byteLength)} with the plans it names, over the server's ${sizeOf(limit)} limit; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES`,
      });
      continue;
    }
    const into = (): Landing | null =>
      session !== null
        ? { session }
        : landing.worktree !== null
          ? { worktree: landing.worktree }
          : null;
    let where = into();
    if (where === null) {
      outcome.failed.push({
        what: candidate.thread.title,
        words: "the server named no worktree to put it in · update mend",
      });
      continue;
    }
    let sent = await sendConversation(deps, project.id, where, body);
    // A replayed handoff answers with the session it made then, which may hold another import.
    if (
      sent._tag === "refused" &&
      "session" in where &&
      landing.worktree !== null &&
      ["session-holds-another", "session-launched", "harness-mismatch"].includes(sent.reason ?? "")
    ) {
      session = null;
      where = { worktree: landing.worktree };
      sent = await sendConversation(deps, project.id, where, body);
    }
    // Only the handoff's own session takes a conversation with ?session=; the rest join its worktree.
    session = null;
    if (sent._tag === "refused") {
      outcome.failed.push({ what: candidate.thread.title, words: sent.words });
      say(`    ${amber("!")} ${candidate.thread.title} · not imported · ${sent.words}`);
      continue;
    }
    outcome.imported.push({
      title: candidate.thread.title,
      sessionId: sent.sessionId,
      harness: candidate.harness,
      turns: sent.turns,
    });
    say(
      `    ${green("✓")} ${candidate.thread.title} · session ${sent.sessionId.slice(0, 8)} · ${plural(sent.turns, "turn", "turns")} of history${sent.replayed ? " · it was imported before" : ""}`,
    );
  }
  return target.kind === "adopt" ? project : null;
};

const run = async (
  deps: ImportT3Deps,
  rawArgs: ReadonlyArray<string>,
  scan: Omit<T3ImportScanInput, "filter">,
  io: ImportT3Io,
): Promise<number> => {
  const parsed = parseImportT3Args(rawArgs);
  if ("error" in parsed) {
    process.stderr.write(`mend: ${parsed.error}\n`);
    return 2;
  }
  const { args } = parsed;
  const read = await Effect.runPromise(
    Effect.result(
      readT3ImportCandidates({
        ...scan,
        filter: {
          ...(args.projects.length === 0 ? {} : { projects: args.projects }),
          ...(args.threads.length === 0 ? {} : { threadIds: args.threads }),
        },
      }),
    ),
  );
  if (read._tag === "Failure") throw new Stop(`${read.failure.message} · nothing was imported`);
  const named = new Set(args.threads);
  const leftArchived = read.success.filter(
    (candidate) =>
      candidate.thread.archived && !args.archived && !named.has(candidate.thread.threadId),
  ).length;
  const candidates = read.success.filter(
    (candidate) =>
      !candidate.thread.archived || args.archived || named.has(candidate.thread.threadId),
  );
  const missing = args.threads.filter(
    (id) => !read.success.some((candidate) => candidate.thread.threadId === id),
  );
  for (const id of missing) say(`${amber("!")} no thread ${id} in T3 Code's list`);

  const limit = await conversationLimit(deps);
  const projects: Array<ProjectDto> = [
    ...(await deps.api<ReadonlyArray<ProjectDto>>("GET", "/projects")),
  ];
  const plans = planOf(candidates);

  // Which project each group lands in, and whether each of its threads came across before.
  const resolved = new Map<Group, Resolved>();
  for (const plan of plans) {
    for (const group of plan.groups) {
      const target = handoffTargetOf(projects, null, {
        top: group.root,
        originUrl: group.originUrl,
      });
      resolved.set(group, { target });
      if (target.kind !== "project") continue;
      for (const thread of group.threads)
        thread.earlier = await earlierImport(deps, target.project.id, thread.candidate);
    }
  }

  say(
    `${plural(read.success.length, "thread", "threads")} in T3 Code${args.projects.length + args.threads.length > 0 ? " that you named" : ""} · conversations up to ${sizeOf(limit)} on this server`,
  );
  if (leftArchived > 0)
    say(
      dim(
        `${plural(leftArchived, "archived thread is", "archived threads are")} left out · --archived brings them`,
      ),
    );
  let sendable = 0;
  let handoffs = 0;
  const adoptions = new Set<string>();
  for (const plan of plans) {
    say("");
    say(plan.title);
    for (const group of plan.groups) {
      const target: Resolved = resolved.get(group) ?? {
        target: { kind: "refused", words: "no project was worked out for it" },
      };
      say(groupLine(group, target, limit));
      const sending = group.threads.filter((thread) => pending(thread, limit)).length;
      if (target.target.kind !== "refused" && sending > 0) {
        sendable += sending;
        if (group._tag === "checkout") handoffs += 1;
        if (target.target.kind === "adopt") adoptions.add(target.target.source);
      }
      for (const thread of group.threads)
        say(`    ${threadFacts(thread, limit, target.target.kind === "refused")}`);
    }
    if (plan.left.length > 0) {
      say(dim(`  stays in T3 Code`));
      for (const left of plan.left) say(`    ${dim("·")} ${left.title} · ${left.words}`);
    }
  }
  say("");
  const summary = `${plural(sendable, "thread", "threads")} to import · ${plural(handoffs, "checkout", "checkouts")} to hand off · ${plural(adoptions.size, "project", "projects")} to adopt`;
  if (args.dryRun) {
    say(`dry run · ${summary} · nothing was sent`);
    return 0;
  }
  if (sendable === 0) {
    say("nothing to import");
    return 0;
  }
  const confirm = confirmPlan(rawArgs, io.interactive);
  if (confirm === "refuse")
    throw new Stop(
      `non-interactive · pass --yes to import ${plural(sendable, "thread", "threads")} · nothing was imported`,
    );
  if (confirm === "ask" && !(await io.ask(`${summary}. Import?`))) {
    say(dim("nothing was imported"));
    return 0;
  }

  const outcome: Outcome = { imported: [], failed: [] };
  const groups = plans.flatMap((plan) => plan.groups);
  const needsAgent = await Promise.all(
    groups.map(async (group) => {
      const target = resolved.get(group)?.target;
      return target !== undefined && target.kind !== "refused"
        ? handoffTargetNeedsAgent(deps, target)
        : false;
    }),
  );
  const share = needsAgent.some(Boolean) ? deps.shareAgent() : null;
  try {
    await share?.ready(SHARE_READY_MS);
    for (const group of groups) {
      const threads = group.threads.filter((thread) => pending(thread, limit));
      for (const thread of group.threads) {
        if (thread.plan.bytes > limit)
          outcome.failed.push({
            what: thread.candidate.thread.title,
            words: `its conversation is ${sizeOf(thread.plan.bytes)}, over the server's ${sizeOf(limit)} limit; the server's operator can raise it with MEND_BUDGET_CONVERSATION_BYTES`,
          });
        else if (thread.earlier._tag === "unknown")
          outcome.failed.push({
            what: thread.candidate.thread.title,
            words: thread.earlier.words,
          });
      }
      if (threads.length === 0) continue;
      // An earlier group may have adopted this group's origin.
      const target = handoffTargetOf(projects, null, {
        top: group.root,
        originUrl: group.originUrl,
      });
      if (target.kind === "refused") {
        for (const thread of threads)
          outcome.failed.push({
            what: thread.candidate.thread.title,
            words: target.words,
          });
        continue;
      }
      say("");
      say(
        group._tag === "checkout" ? shown(group.root) : `${shown(group.workingDirectory)} (gone)`,
      );
      const adopted = await importGroup(deps, group, target, threads, limit, outcome);
      if (adopted !== null) projects.push(adopted);
    }
  } finally {
    await share?.close();
  }

  say("");
  say(
    `${plural(outcome.imported.length, "thread", "threads")} imported${outcome.failed.length === 0 ? "" : ` · ${outcome.failed.length} not imported`}`,
  );
  for (const failed of outcome.failed) say(`  ${amber("!")} ${failed.what} · ${failed.words}`);
  if (outcome.imported.length > 0) {
    say("");
    say("Each session starts its agent on the imported conversation with your next message:");
    for (const imported of outcome.imported)
      say(
        `  mend message ${imported.sessionId.slice(0, 8)} --resume "…"  ${dim(`# ${imported.title} · ${imported.harness}`)}`,
      );
    say(dim(`  watch · ${deps.serverUrl}/sessions/<session>`));
  }
  return outcome.failed.length === 0 ? 0 : 1;
};

/** `mend import t3`; resolves with the exit code. */
export const importT3Command = async (
  deps: ImportT3Deps,
  args: ReadonlyArray<string>,
  scan: Omit<T3ImportScanInput, "filter"> = {},
  io: ImportT3Io = {
    interactive: isTerminal(process.stdin) && isTerminal(process.stdout),
    ask: askYesNo,
  },
): Promise<number> => {
  try {
    return await run(deps, args, scan, io);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    process.stderr.write(`mend: ${redactCredentials(error.words)}\n`);
    return error.code;
  }
};
