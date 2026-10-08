import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  sharedWorkspaceLine,
  workspaceRetirementLine,
  type WorkspaceRetirementStopKind,
} from "@mend/domain/workbench";

import type { LivePerson, Project, ProjectDetail, Session } from "./types.js";

/**
 * What the extension says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 13 and 14), in `@mend/domain`'s words: the join line before a session starts in a
 * worktree where someone else's session runs, and on a session the shared workspace line, the
 * waiting line and the retirement line. Parsing is tolerant: an older server omits all of it.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STOP_KINDS: ReadonlyArray<WorkspaceRetirementStopKind> = [
  "terminal",
  "shell",
  "service",
  "turn",
  "process",
  "container",
  "unchecked",
];

/** `livePeople` off a session; absent or malformed reads as nobody. */
export const parseLivePeople = (value: unknown): ReadonlyArray<LivePerson> =>
  Array.isArray(value)
    ? value.flatMap((person) =>
        isRecord(person) &&
        typeof person["accountId"] === "string" &&
        typeof person["name"] === "string"
          ? [{ accountId: person["accountId"], name: person["name"] }]
          : [],
      )
    : [];

/** `workspaceRetirement` off a session; absent or anything else reads as none under way. */
export const parseRetirementState = (value: unknown): "marked" | "retiring" | null =>
  value === "marked" || value === "retiring" ? value : null;

/**
 * Which of a session's workspace reads are worth a request, from what the session row already
 * says: the waiting line only where another person is live and shared control is on (only then
 * can a turn wait on someone else's work), the retirement only where one is under way.
 */
export const workspaceReads = (
  session: Pick<Session, "livePeople" | "sharedControlEnabledAt" | "workspaceRetirement">,
): { readonly waiting: boolean; readonly retirement: boolean } => ({
  waiting: session.livePeople.length > 0 && session.sharedControlEnabledAt !== null,
  retirement: session.workspaceRetirement !== null,
});

/** `GET /sessions/:id/waiting` → the waiting line, or null when nothing waits. */
export const parseWaitLine = (value: unknown): string | null =>
  isRecord(value) && typeof value["line"] === "string" ? value["line"] : null;

/** What the extension reads of `GET /sessions/:id/workspace-retirement`. */
export interface RetirementView {
  readonly state: "marked" | "retiring";
  readonly preRelease: boolean;
  readonly launcher: string | null;
  readonly reason: string | null;
  readonly stops: ReadonlyArray<{
    readonly kind: WorkspaceRetirementStopKind;
    readonly label: string;
  }>;
}

export const parseRetirement = (value: unknown): RetirementView | null => {
  if (!isRecord(value)) return null;
  const state = value["state"];
  if (state !== "marked" && state !== "retiring") return null;
  const stops = Array.isArray(value["stops"]) ? value["stops"] : [];
  return {
    state,
    preRelease: value["preRelease"] === true,
    launcher: typeof value["launcher"] === "string" ? value["launcher"] : null,
    reason: typeof value["reason"] === "string" ? value["reason"] : null,
    stops: stops.flatMap((stop) => {
      if (!isRecord(stop) || typeof stop["label"] !== "string") return [];
      const kind = STOP_KINDS.find((candidate) => candidate === stop["kind"]);
      return kind === undefined ? [] : [{ kind, label: stop["label"] }];
    }),
  };
};

/** A member of the organization by id and name. */
export interface MemberName {
  readonly userId: string;
  readonly name: string;
}

export const parseMembers = (value: unknown): ReadonlyArray<MemberName> =>
  Array.isArray(value)
    ? value.flatMap((member) =>
        isRecord(member) &&
        typeof member["userId"] === "string" &&
        typeof member["name"] === "string"
          ? [{ userId: member["userId"], name: member["name"] }]
          : [],
      )
    : [];

/** Whose workspace a retiring executor is: a live person, then the roster, then these words. */
export const launcherName = (
  launcher: string | null,
  livePeople: ReadonlyArray<LivePerson>,
  members: ReadonlyArray<MemberName>,
): string =>
  livePeople.find((person) => person.accountId === launcher)?.name ??
  members.find((member) => member.userId === launcher)?.name ??
  "its launcher";

/** The session's lines in reading order; empty when there is nothing to say. */
export const sessionLines = (facts: {
  readonly session: Pick<Session, "livePeople">;
  readonly viewer: string | null;
  readonly waitLine: string | null;
  readonly retirement: RetirementView | null;
  readonly members: ReadonlyArray<MemberName>;
}): ReadonlyArray<string> => {
  const shared = sharedWorkspaceLine(facts.session.livePeople, facts.viewer);
  const { retirement } = facts;
  return [
    ...(shared === null ? [] : [shared]),
    ...(facts.waitLine === null ? [] : [facts.waitLine]),
    ...(retirement === null
      ? []
      : [
          workspaceRetirementLine(
            retirement,
            launcherName(retirement.launcher, facts.session.livePeople, facts.members),
          ),
        ]),
  ];
};

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/**
 * Whether rows the extension already holds have anything per-person to say: someone live in an
 * executor, or a retirement under way. Only then is the viewer (`GET /organization`) worth a
 * request; with per-person homes off the server lists nobody and no retirement.
 */
export const hasPersonFacts = (
  sessions: ReadonlyArray<Pick<Session, "livePeople" | "workspaceRetirement">>,
): boolean =>
  sessions.some((session) => session.livePeople.length > 0 || session.workspaceRetirement !== null);

/** Whether any session of the worktree lists someone live: the join line then needs the viewer. */
export const worktreeListsPeople = (
  sessions: ReadonlyArray<Pick<Session, "worktreeId" | "livePeople">>,
  worktreeId: string,
): boolean =>
  sessions.some((session) => session.worktreeId === worktreeId && session.livePeople.length > 0);

/**
 * The people other than the viewer live in a worktree's workspace, once each, by name. Empty
 * when the viewer is unknown or the executor is shared (which lists nobody).
 */
export const othersInWorktree = (
  sessions: ReadonlyArray<Pick<Session, "worktreeId" | "livePeople">>,
  worktreeId: string,
  viewer: string | null,
): ReadonlyArray<string> => {
  if (viewer === null) return [];
  const names = new Map<string, string>();
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId) continue;
    for (const person of session.livePeople) {
      if (person.accountId !== viewer) names.set(person.accountId, person.name);
    }
  }
  return [...names.values()];
};

/** The join line, or null when nobody else's session runs there. */
export const joinLine = (others: ReadonlyArray<string>): string | null =>
  others.length === 0 ? null : joinWorktreeLine(others);

/**
 * The join line by the workspace's layout (docs/adr/0016, decision 13): the per-person line, by
 * name, where the worktree's sessions list someone other than the viewer live; the shared-home
 * line where another person's session is live there and nobody is listed (a workspace that
 * shares one home lists nobody). Null when the viewer is unknown or nobody else runs there.
 */
export const worktreeJoinLine = (
  sessions: ReadonlyArray<Pick<Session, "worktreeId" | "status" | "ownerUserId" | "livePeople">>,
  worktreeId: string,
  viewer: string | null,
): string | null => {
  const line = joinLine(othersInWorktree(sessions, worktreeId, viewer));
  if (line !== null) return line;
  if (viewer === null || worktreeListsPeople(sessions, worktreeId)) return null;
  const anotherLive = sessions.some(
    (session) =>
      session.worktreeId === worktreeId &&
      LIVE_STATUSES.has(session.status) &&
      session.ownerUserId !== null &&
      session.ownerUserId !== viewer,
  );
  return anotherLive ? JOIN_SHARED_HOME_LINE : null;
};

// ─── the reads, each asked for only when the rows say it is worth a request ──

/** The client's reads the extension's workspace lines use. */
export interface WorkspaceLineReads {
  viewerId(): Promise<string | null>;
  memberNames(): Promise<ReadonlyArray<MemberName>>;
  waitLine(sessionId: string): Promise<string | null>;
  workspaceRetirement(sessionId: string): Promise<RetirementView | null>;
}

/** The projects and their views, and the viewer only when a row has something per-person. */
export const readProjects = async (client: {
  listProjects(): Promise<ReadonlyArray<Project>>;
  projectDetail(projectId: string): Promise<ProjectDetail>;
  viewerId(): Promise<string | null>;
}): Promise<{
  readonly projects: ReadonlyArray<Project>;
  readonly details: ReadonlyArray<ProjectDetail>;
  readonly viewer: string | null;
}> => {
  const projects = await client.listProjects();
  const details = await Promise.all(projects.map((project) => client.projectDetail(project.id)));
  const viewer = hasPersonFacts(details.flatMap((detail) => detail.sessions))
    ? await client.viewerId()
    : null;
  return { projects, details, viewer };
};

/**
 * The join line for a worktree, from the project view's rows: the viewer is asked for only where
 * the worktree lists someone live, unless it is already known (the tree read it for something
 * else). The shared-home line needs a known viewer where nobody is listed.
 */
export const joinLineOf = async (
  sessions: ReadonlyArray<Pick<Session, "worktreeId" | "status" | "ownerUserId" | "livePeople">>,
  worktreeId: string,
  knownViewer: string | null,
  client: Pick<WorkspaceLineReads, "viewerId">,
): Promise<string | null> => {
  const viewer =
    knownViewer ?? (worktreeListsPeople(sessions, worktreeId) ? await client.viewerId() : null);
  return worktreeJoinLine(sessions, worktreeId, viewer);
};

/**
 * A live session's lines from its project view row: the viewer only where someone is listed live,
 * the waiting line and the retirement only where the row says they are worth it, the roster only
 * to name a retirement's launcher. With per-person homes off, no request at all.
 */
export const liveSessionLines = async (
  session: Pick<Session, "id" | "livePeople" | "sharedControlEnabledAt" | "workspaceRetirement">,
  client: WorkspaceLineReads,
): Promise<ReadonlyArray<string>> => {
  if (!hasPersonFacts([session])) return [];
  const reads = workspaceReads(session);
  const [viewer, waitLine, retirement] = await Promise.all([
    session.livePeople.length > 0 ? client.viewerId() : null,
    reads.waiting ? client.waitLine(session.id) : null,
    reads.retirement ? client.workspaceRetirement(session.id) : null,
  ]);
  const members =
    retirement === null || retirement.launcher === null ? [] : await client.memberNames();
  return sessionLines({ session, viewer, waitLine, retirement, members });
};
