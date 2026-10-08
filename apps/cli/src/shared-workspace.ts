import {
  joinWorktreeLine,
  REPLACE_WORKSPACE_ACTION,
  retirementStopLines,
  SHARED_CONTROL_CONFIRM,
  sharedWorkspaceLine,
  workspaceRetirementLine,
  type WorkspaceRetirementStopKind,
} from "@mend/domain/workbench";

/**
 * What the terminal says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 13 and 14), in `@mend/domain`'s words: the join line before a session starts in a
 * worktree where someone else's session runs, the shared workspace line, the waiting line and the
 * retirement line on a session, and "Replace this workspace now" for the change's owner. Pure, so
 * `mend`, `mend sessions` and the dashboard draw the same lines.
 */

/** A person with a process live in the session's executor, as `GET /api/sessions` lists them. */
export interface LivePersonDto {
  readonly accountId: string;
  readonly name: string;
}

/** `GET /api/sessions/:id/waiting`: the slice the terminal reads. */
export interface ConversationWaitDto {
  readonly line: string;
}

/** `GET /api/sessions/:id/workspace-retirement`, as the wire carries it. */
export interface WorkspaceRetirementDto {
  readonly state: "marked" | "retiring";
  readonly preRelease: boolean;
  readonly launcher: string | null;
  readonly stops: ReadonlyArray<{
    readonly kind: WorkspaceRetirementStopKind;
    readonly label: string;
  }>;
  readonly reason: string | null;
  readonly canReplace: boolean;
}

/** A member of the organization by id and name (`GET /api/organization/members`). */
export interface MemberNameDto {
  readonly userId: string;
  readonly name: string;
}

/** A session as the join check reads it: its worktree, its status and who is live in it. */
export interface JoinCandidate {
  readonly worktreeId?: string;
  readonly livePeople?: ReadonlyArray<LivePersonDto>;
}

/**
 * The other people live in a worktree's workspace, by name, once each: everyone `livePeople`
 * lists on the worktree's sessions but the viewer. Empty when the viewer is unknown (nothing
 * can say who "another person" is) or in a shared executor, which lists nobody.
 */
export const othersLiveInWorktree = (
  sessions: ReadonlyArray<JoinCandidate>,
  worktreeId: string,
  viewer: string | null,
): ReadonlyArray<string> => {
  if (viewer === null) return [];
  const names = new Map<string, string>();
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId) continue;
    for (const person of session.livePeople ?? []) {
      if (person.accountId !== viewer) names.set(person.accountId, person.name);
    }
  }
  return [...names.values()];
};

/** The join line, or null when nobody else's session runs in the worktree. */
export const joinLineFor = (others: ReadonlyArray<string>): string | null =>
  others.length === 0 ? null : joinWorktreeLine(others);

/**
 * Whose workspace a retiring executor is, by name: a live person first, then the roster. With
 * neither, the words this client falls back to.
 */
export const launcherNameOf = (
  launcher: string | null,
  livePeople: ReadonlyArray<LivePersonDto>,
  members: ReadonlyArray<MemberNameDto>,
): string =>
  livePeople.find((person) => person.accountId === launcher)?.name ??
  members.find((member) => member.userId === launcher)?.name ??
  "its launcher";

/** What a session says about its workspace, each part null when there is nothing to say. */
export interface SessionWorkspaceLines {
  /** "Shared workspace with Anna · …" while another person's process is live there. */
  readonly shared: string | null;
  /** The waiting line, as the server words it. */
  readonly waiting: string | null;
  /** The retirement line while the executor waits to be replaced. */
  readonly retirement: string | null;
  /** For the change's owner: the action, the command that takes it, and what would stop. */
  readonly replace: {
    readonly action: string;
    readonly command: string;
    readonly stops: ReadonlyArray<string>;
  } | null;
}

export const sessionWorkspaceLines = (facts: {
  readonly sessionId: string;
  readonly livePeople: ReadonlyArray<LivePersonDto>;
  readonly viewer: string | null;
  readonly wait: ConversationWaitDto | null;
  readonly retirement: WorkspaceRetirementDto | null;
  readonly members: ReadonlyArray<MemberNameDto>;
}): SessionWorkspaceLines => {
  const { retirement } = facts;
  return {
    shared: sharedWorkspaceLine(facts.livePeople, facts.viewer),
    waiting: facts.wait?.line ?? null,
    retirement:
      retirement === null
        ? null
        : workspaceRetirementLine(
            retirement,
            launcherNameOf(retirement.launcher, facts.livePeople, facts.members),
          ),
    // Only the change's owner replaces it, and only while it is marked: a retiring one is
    // already being replaced.
    replace:
      retirement === null || !retirement.canReplace || retirement.state !== "marked"
        ? null
        : {
            action: REPLACE_WORKSPACE_ACTION,
            command: `mend workspace replace ${facts.sessionId.slice(0, 8)}`,
            stops: retirementStopLines(retirement),
          },
  };
};

/** The lines in reading order, for a terminal that prints them one under another. */
export const workspaceLineList = (lines: SessionWorkspaceLines): ReadonlyArray<string> => [
  ...(lines.shared === null ? [] : [lines.shared]),
  ...(lines.waiting === null ? [] : [lines.waiting]),
  ...(lines.retirement === null ? [] : [lines.retirement]),
  ...(lines.replace === null
    ? []
    : [
        `${lines.replace.action} · ${lines.replace.command}`,
        ...lines.replace.stops.map((stop) => `  ${stop}`),
      ]),
];

/** Words wrapped to `width` columns; a word longer than the width is cut, never dropped. */
export const wrapWords = (text: string, width: number): ReadonlyArray<string> => {
  const limit = Math.max(8, width);
  const lines: Array<string> = [];
  let current = "";
  for (const raw of text.split(/\s+/)) {
    if (raw === "") continue;
    let word = raw;
    while (word.length > limit) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
};

// ─── the confirmations ──────────────────────────────────────────────────────

/** How a confirmation is answered: the terminal asks, a script passes --yes, or it is refused. */
export type ConfirmPlan = "ask" | "confirmed" | "refuse";

export const confirmPlan = (args: ReadonlyArray<string>, interactive: boolean): ConfirmPlan =>
  args.includes("--yes") || args.includes("-y") ? "confirmed" : interactive ? "ask" : "refuse";

/** What `mend session share <s> on` prints before it asks. */
export const sharedControlConfirmLines = (): ReadonlyArray<string> => [
  SHARED_CONTROL_CONFIRM.title,
  SHARED_CONTROL_CONFIRM.body,
];

/** What `mend workspace replace` prints before it asks: the action and what would stop. */
export const replaceConfirmLines = (retirement: WorkspaceRetirementDto): ReadonlyArray<string> => [
  `${REPLACE_WORKSPACE_ACTION}?`,
  ...retirementStopLines(retirement).map((stop) => `  ${stop}`),
];

/** One `[y/N]` question on the terminal; anything but y or yes is no. */
export const askYesNo = async (question: string): Promise<boolean> => {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};
