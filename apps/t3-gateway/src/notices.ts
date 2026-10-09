import type {
  MendActiveSession,
  MendConversationWait,
  MendLivePerson,
  MendWorkspaceRetirement,
} from "./mend-workbench.ts";

/**
 * What Mend says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 6, 13 and 14), carried to t3code's clients. The gateway runs on the `t3` Effect
 * catalog and does not depend on @mend/domain, so the words are mirrored here, exactly, from
 * `packages/domain/src/workbench/shared-workspace.ts` (`sharedWorkspaceLine`,
 * `workspaceRetirementLine`). Never reword them: change them there first, then here.
 */

/** What a thread says beside its turns; each null when there is nothing to say. */
export interface ThreadNotices {
  /** "Shared workspace with Anna · …", for the person who paired; null when nobody else is live. */
  readonly sharedWorkspace: string | null;
  /** The turn that waits for the previous sender's own work, and the waiting line. */
  readonly waiting: MendConversationWait | null;
  /** The executor started before per-person homes, waiting to be replaced. */
  readonly retirement: string | null;
}

export const NO_NOTICES: ThreadNotices = { sharedWorkspace: null, waiting: null, retirement: null };

/**
 * Whether a session's waiting line is worth reading (`GET /api/sessions/:id/waiting`, decision
 * 6): someone is live in its executor and its owner shares control, as `GET /api/sessions` says.
 * Otherwise nobody else's turn can wait, and nothing is read: with `MEND_HARNESS_LAYOUT=shared`,
 * `livePeople` is always empty, and the gateway does no extra work at all.
 */
export const readsWaiting = (session: MendActiveSession | undefined): boolean =>
  (session?.livePeople?.length ?? 0) > 0 && (session?.sharedControlEnabledAt ?? null) !== null;

/**
 * Whether a session's retirement is worth reading (`GET /api/sessions/:id/workspace-retirement`,
 * decision 14): `GET /api/sessions` says its executor waits to be replaced.
 */
export const readsRetirement = (session: MendActiveSession | undefined): boolean =>
  (session?.workspaceRetirement ?? null) !== null;

/** "a", "a and b", "a, b and c". Mirrors `listed` in @mend/domain's shared-workspace.ts. */
const listed = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;

/**
 * Mirrors `sharedWorkspaceLine` in @mend/domain/workbench: on a session while another person's
 * process is live in its executor; null when nobody else is live there.
 */
export const sharedWorkspaceLine = (
  livePeople: ReadonlyArray<MendLivePerson>,
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

/**
 * Mirrors `workspaceRetirementLine` in @mend/domain/workbench: what a session says while its
 * executor waits to be replaced.
 */
export const workspaceRetirementLine = (
  retirement: Pick<MendWorkspaceRetirement, "state" | "preRelease" | "reason">,
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

/**
 * A thread's notices from what the hub read: the people live in the session's executor, what
 * holds its next turn, and its executor's retirement. `names` maps account ids to the names the
 * gateway knows (the person who paired, and everyone live anywhere they can see); a launcher it
 * does not know reads "its launcher", as Mend's own clients say it.
 */
export const threadNoticesOf = (input: {
  readonly livePeople: ReadonlyArray<MendLivePerson>;
  readonly viewerId: string | null;
  readonly wait: MendConversationWait | null;
  readonly retirement: MendWorkspaceRetirement | null;
  readonly names: ReadonlyMap<string, string>;
}): ThreadNotices => ({
  sharedWorkspace: sharedWorkspaceLine(input.livePeople, input.viewerId),
  waiting: input.wait,
  retirement:
    input.retirement === null
      ? null
      : workspaceRetirementLine(
          input.retirement,
          (input.retirement.launcher === null
            ? undefined
            : input.names.get(input.retirement.launcher)) ?? "its launcher",
        ),
});
