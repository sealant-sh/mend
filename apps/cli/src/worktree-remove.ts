import { WORKTREE_REMOVAL_FORCE_HINT } from "@mend/domain/workbench";

import { usageOf } from "./help.ts";
import { MendRequestError } from "./server-request.ts";

/**
 * `mend worktrees rm <name> [--force] [--project <p>]`: the container's one explicit destructive
 * act from a terminal (docs/adr/0007-landing.md, "Worktree removal"). The server decides what
 * stands in the way, a live session or a change not on origin, and says so in words; this command
 * prints them as they are and, when force would lift the refusal, says how to pass it.
 */

export interface WorktreesRmArgs {
  readonly name: string;
  readonly force: boolean;
  readonly project: string | null;
}

export const parseWorktreesRmArgs = (
  args: ReadonlyArray<string>,
): { readonly args: WorktreesRmArgs } | { readonly error: string } => {
  let name: string | null = null;
  let force = false;
  let project: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--project") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: "--project needs a name" };
      project = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--"))
      return { error: `unknown option ${arg} · ${usageOf("worktrees rm")}` };
    if (name !== null) return { error: `one worktree at a time · ${usageOf("worktrees rm")}` };
    name = arg;
  }
  if (name === null) return { error: usageOf("worktrees rm") };
  return { args: { name, force, project } };
};

/** The rows `mend worktrees --json` lists, the parts a removal needs. */
export interface RemovableWorktree {
  /** Null against a server from before worktrees, where a session was the container. */
  readonly id: string | null;
  readonly name: string;
  readonly projectName: string;
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A worktree the server knows by id: the one `DELETE /worktrees/:id` takes. */
export interface PickedWorktree extends RemovableWorktree {
  readonly id: string;
}

/**
 * The one worktree the name picks out, or why none does. A live session is refused here, before
 * the server is asked, with the stop that frees it.
 */
export const pickWorktree = (
  worktrees: ReadonlyArray<RemovableWorktree>,
  name: string,
  liveStatuses: ReadonlySet<string>,
): { readonly worktree: PickedWorktree } | { readonly error: string } => {
  const matches = worktrees.filter((worktree) => worktree.name === name);
  const [worktree] = matches;
  if (worktree === undefined)
    return { error: `no worktree named ${name} · mend worktrees lists them` };
  if (matches.length > 1) {
    return {
      error: `${name} names a worktree in ${matches.length} projects: ${matches.map((match) => match.projectName).join(", ")} · say which with --project`,
    };
  }
  const id = worktree.id;
  if (id === null) {
    return { error: `this server predates worktrees · mend sessions lists what it holds` };
  }
  const live = worktree.sessions.filter((session) => liveStatuses.has(session.status));
  if (live.length > 0) {
    return {
      error: `${plural(live.length, "session", "sessions")} live in ${name} · stop ${live.length === 1 ? "it" : "them"} first: ${live.map((session) => `mend stop ${session.id.slice(0, 8)}`).join(" · ")}`,
    };
  }
  return { worktree: { ...worktree, id } };
};

/** `DELETE /worktrees/:id`, with `force=true` only when asked. */
export const removalRoute = (id: string, force: boolean): string =>
  `/worktrees/${encodeURIComponent(id)}${force ? "?force=true" : ""}`;

/** The server's words as they are, then the override when the words offer one. */
export const refusalLines = (
  words: string,
  args: Pick<WorktreesRmArgs, "name" | "project">,
): ReadonlyArray<string> =>
  words.includes(WORKTREE_REMOVAL_FORCE_HINT)
    ? [
        words,
        `  mend worktrees rm ${args.name}${args.project === null ? "" : ` --project ${args.project}`} --force removes it anyway`,
      ]
    : [words];

export const removedLine = (name: string, sessions: number): string =>
  `removed · ${name} · ${
    sessions === 0
      ? "the change and its checkpoints went with it"
      : `${plural(sessions, "session", "sessions")}, the change and its review went with it`
  }`;

interface RemovalReportDto {
  readonly removed: boolean;
  readonly leftover: string | null;
}

export interface WorktreesRmDeps {
  /** The raw request: a refusal arrives as a MendRequestError with its status and the body's words. */
  readonly request: <T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    route: string,
    body?: unknown,
  ) => Promise<T>;
  readonly listWorktrees: (project: string | null) => Promise<ReadonlyArray<RemovableWorktree>>;
  readonly liveStatuses: ReadonlySet<string>;
  readonly say: (line: string) => void;
  readonly fail: (message: string) => never;
}

export const worktreesRmCommand = async (
  deps: WorktreesRmDeps,
  argv: ReadonlyArray<string>,
): Promise<void> => {
  const parsed = parseWorktreesRmArgs(argv);
  if ("error" in parsed) return deps.fail(parsed.error);
  const { args } = parsed;
  const picked = pickWorktree(await deps.listWorktrees(args.project), args.name, deps.liveStatuses);
  if ("error" in picked) return deps.fail(picked.error);
  const { worktree } = picked;
  let report: RemovalReportDto;
  try {
    report = await deps.request<RemovalReportDto>("DELETE", removalRoute(worktree.id, args.force));
  } catch (error) {
    if (error instanceof MendRequestError && error.status === 422) {
      return deps.fail(refusalLines(error.message, args).join("\n"));
    }
    return deps.fail(error instanceof Error ? error.message : String(error));
  }
  if (!report.removed) {
    return deps.fail(
      `not removed · ${args.name}${report.leftover === null ? "" : ` · ${report.leftover}`}`,
    );
  }
  deps.say(removedLine(args.name, worktree.sessions.length));
  if (report.leftover !== null) deps.say(`left behind · ${report.leftover}`);
};
