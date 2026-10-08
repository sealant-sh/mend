import type { PreReleaseMemory, WorkspaceRetirement } from "./harness-layout.ts";

/**
 * What the product says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decision 13), word for word in every client: everything a person runs runs as them, on their own
 * logins, but with `sudo` anyone can read and change anyone's files. Evidence, never a verdict.
 */

/** "a", "a and b", "a, b and c". */
const listed = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;

/**
 * Where two people meet in a worktree ("join a worktree" in the CLI, the composer's Worktree
 * picker, the worktree's New session menu): said before a person starts a session in a worktree
 * where someone else's session runs. `others` are the names of the people whose sessions run there.
 */
export const joinWorktreeLine = (others: ReadonlyArray<string>): string =>
  others.length <= 1
    ? `${others[0] ?? "Another person"}'s session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.`
    : `${listed(others)}'s sessions are running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but any of you can read the others' files, logins included.`;

/**
 * On a session while another person's process is live in its executor: "Shared workspace with
 * Anna · each of you runs as yourself · either of you can read the other's files." The people are
 * the session view's `livePeople`; `viewer` is whoever reads it. Null when nobody else is live
 * there (one person, or a shared executor, which lists nobody).
 */
export const sharedWorkspaceLine = (
  livePeople: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
  viewer: string | null,
): string | null => {
  if (livePeople.length < 2) return null;
  const others = livePeople.filter((person) => person.accountId !== viewer).map((p) => p.name);
  // Someone who runs nothing there reads who does.
  if (others.length === livePeople.length) {
    return `Shared workspace: ${listed(others)} · each runs as themselves · ${others.length === 2 ? "either can read the other's files" : "any of them can read the others' files"}.`;
  }
  return others.length === 1 && livePeople.length === 2
    ? `Shared workspace with ${others[0]} · each of you runs as yourself · either of you can read the other's files.`
    : `Shared workspace with ${listed(others)} · each of you runs as yourself · any of you can read the others' files.`;
};

/** Beside the Shared control switch, in place of "using your provider logins and Git access". */
export const SHARED_CONTROL_LINE =
  "Each turn runs on its sender's login. From now until this session ends, the agent uses no one's personal memory or instructions. The conversation so far, including what your agent loaded before, becomes visible to whoever steers.";

/**
 * Beside the switch where a steered turn still spends the owner's logins (a worktree that does not
 * run each person as themselves, `turnsOnSendersLogin` false): what it said before per-person homes.
 */
export const SHARED_CONTROL_LINE_OWNER_LOGINS =
  "Each turn runs on your provider logins and Git access, whoever sends it.";

/** The line beside the Shared control switch, by whose login a steered turn runs on. */
export const sharedControlLine = (turnsOnSendersLogin: boolean): string =>
  turnsOnSendersLogin ? SHARED_CONTROL_LINE : SHARED_CONTROL_LINE_OWNER_LOGINS;

/** The confirmation the switch asks before it turns shared control on. */
export const SHARED_CONTROL_CONFIRM = {
  title: "Turn on shared control?",
  body: SHARED_CONTROL_LINE,
  confirm: "Turn on",
  cancel: "Keep it off",
} as const;

/**
 * What a session says while its executor waits to be replaced (decision 14), as observed: whose
 * workspace it is, who it takes, and why the last replacement did not go ahead.
 */
export const workspaceRetirementLine = (
  retirement: Pick<WorkspaceRetirement, "state" | "preRelease" | "reason">,
  launcherName: string,
): string => {
  if (retirement.state === "retiring") {
    return "Replacing this workspace so that each person runs as themselves · nothing new starts until it has been saved and replaced";
  }
  const started = retirement.preRelease
    ? "This workspace started before Mend 0.36 and shares one home"
    : "This workspace shares one home";
  const reason = retirement.reason === null ? "" : ` · ${retirement.reason}`;
  return `${started} · it takes only ${launcherName}'s sessions and turns until it is replaced${reason}`;
};

const STOP_WORDS: Readonly<Record<WorkspaceRetirement["stops"][number]["kind"], string>> = {
  terminal: "terminal session (ends resumable)",
  shell: "shell",
  service: "Service started by hand",
  turn: "agent turn in flight",
  process: "process Mend did not start",
  container: "running container",
};

/** "Replace this workspace now" and what would stop, one line each. */
export const REPLACE_WORKSPACE_ACTION = "Replace this workspace now";

/** What would stop if the workspace were replaced now, one line per item. */
export const retirementStopLines = (
  retirement: Pick<WorkspaceRetirement, "stops">,
): ReadonlyArray<string> =>
  retirement.stops.length === 0
    ? ["Nothing would stop. mend.toml Services start again."]
    : [
        ...retirement.stops.map((stop) => `${STOP_WORDS[stop.kind]} · ${stop.label}`),
        "mend.toml Services start again.",
      ];

/**
 * The worktree's line about memory from before per-person homes (decision 14); null when the
 * migration credited everything it read or never ran.
 */
export const preReleaseMemoryLine = (memory: PreReleaseMemory | null): string | null =>
  memory === null || memory.notCredited.length === 0
    ? null
    : `memory from before 0.36, not credited · ${memory.notCredited.length} file${memory.notCredited.length === 1 ? "" : "s"}${memory.provisional ? " · read again when this worktree runs each person as themselves" : ""}`;

/** Known issues' line, which the owner required in every place the limits are listed. */
export const PER_PERSON_ROOT_NOTE =
  "Everyone in a per-person workspace has passwordless sudo, which runs as root: anyone working there, and their agents, can read and change each other's files, logins included.";
