import {
  joinWorktreeLine,
  sharedWorkspaceLine,
  workspaceRetirementLine,
  type WorkspaceRetirementStopKind,
} from "@mend/domain/workbench";

import type { LivePerson, Session } from "./types.js";

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

/** Live people from the session list, laid onto sessions the project view lists without them. */
export const withLivePeople = <S extends Pick<Session, "id" | "livePeople">>(
  sessions: ReadonlyArray<S>,
  listed: ReadonlyArray<Pick<Session, "id" | "livePeople">>,
): ReadonlyArray<S> => {
  const byId = new Map(listed.map((session) => [session.id, session.livePeople]));
  return sessions.map((session) => {
    const livePeople = byId.get(session.id);
    return livePeople === undefined || livePeople.length === 0
      ? session
      : { ...session, livePeople };
  });
};
