import { landingFactLine } from "@mend/domain/workbench";

import type { ChangeLandingDto, LandingFactDto, SessionDetailDto } from "./api.ts";
import type { ObservedCheck } from "./checks.ts";
import { STATUS_WORDS } from "./session-sheet.ts";
import { harnessName } from "./session-view.ts";

/**
 * What the Details view says (Doop "Details view", T24), line by line, from what the server
 * holds: the workspace (worktree, branch, base, pull request), the checks the record shows, the
 * Services and resources, and the sessions in the workspace with who steers each. Every line is an
 * observation, never a verdict. Session details used to be the header's hover and the right-hand
 * panel; they are this view now (ADR 0026).
 */

type Session = SessionDetailDto["session"];

/** "main · 9c41e07", or the commit alone when the worktree has no base branch. */
export const baseWords = (session: {
  readonly baseRef: string | null;
  readonly baseSha: string;
}): string =>
  session.baseRef === null
    ? session.baseSha.slice(0, 12)
    : `${session.baseRef} · ${session.baseSha.slice(0, 7)}`;

/** The change's pull request, as its latest landing recorded it. */
export interface PullRequestFacts {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  /** "Pull request #412 open". */
  readonly words: string;
}

/** The newest pull request the change's landings recorded (newest first); null before any. */
export const pullRequestOf = (
  landings: ReadonlyArray<Pick<ChangeLandingDto, "pullRequest">>,
): PullRequestFacts | null => {
  const pullRequest = landings.find((landing) => landing.pullRequest !== null)?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) return null;
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state,
    words: `Pull request #${pullRequest.number} ${pullRequest.state}`,
  };
};

/**
 * The one landing fact the session shows (`land-session-line`): what the last attempt or turn said
 * when it did not land, else the pull request, else the push. Null when nothing was ever landed or
 * held back.
 */
const HEADLINE_ORDER: ReadonlyArray<LandingFactDto["_tag"]> = [
  "not-landed",
  "refused",
  "failed",
  "pull-request-failed",
  "pull-request",
  "pushed",
];

export const headlineFact = (facts: ReadonlyArray<LandingFactDto>): LandingFactDto | null => {
  for (const tag of HEADLINE_ORDER) {
    const fact = facts.find((candidate) => candidate._tag === tag);
    if (fact !== undefined) return fact;
  }
  return null;
};

/** The headline fact's line, "pushed · mend/fix · 4f2a91c · observed"; null with none. */
export const landingLine = (facts: ReadonlyArray<LandingFactDto>, now: Date): string | null => {
  const fact = headlineFact(facts);
  return fact === null ? null : landingFactLine(fact, now);
};

/** Whether the headline fact says something went wrong, so the line reads in the danger colour. */
export const landingLineFailed = (facts: ReadonlyArray<LandingFactDto>): boolean => {
  const tag = headlineFact(facts)?._tag;
  return tag === "refused" || tag === "failed" || tag === "pull-request-failed";
};

/** "Shared with 1 other session", null when the session is alone in its workspace. */
export const sharedWithWords = (sessionsInWorkspace: number): string | null => {
  const others = sessionsInWorkspace - 1;
  if (others < 1) return null;
  return `Shared with ${others} other ${others === 1 ? "session" : "sessions"}`;
};

/**
 * Why this workspace runs everyone on one home when an image or runtime forced it
 * (`layout-fallback`, docs/adr/0016): the launch adds the reason to the session's summary, one
 * part of it among others (" · "), always ending "so this workspace takes one person".
 */
export const layoutFallbackLine = (summary: string | null): string | null => {
  if (summary === null) return null;
  const part = summary
    .split(" · ")
    .find((each) => each.includes("so this workspace takes one person"));
  if (part === undefined) return null;
  const trimmed = part.trim();
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
};

/**
 * The session's summary without why its workspace takes one person: that is the Details view's to
 * say (`layoutFallbackLine`), where the workspace is described, not the conversation's
 * (SLNT-1196). Null when nothing else was said.
 */
export const withoutLayoutWords = (summary: string | null): string | null => {
  if (summary === null) return null;
  const kept = summary.split(" · ").filter((part) => !part.includes("takes one person"));
  return kept.length === 0 ? null : kept.join(" · ");
};

/** What a session's line in "Sessions in this workspace" reads of it. */
type BylineFacts = Pick<Session, "ownerUserId" | "harness" | "status"> &
  Partial<Pick<Session, "model" | "effort">>;

/**
 * "Ada Lovelace · Claude Code, opus, high effort · Running": who owns the session, its agent with
 * the model and effort it recorded (`model-shown`; left out until its detail is read), and its
 * status word. The viewer's own reads
 * "You"; an owner the roster doesn't name reads "Another member".
 */
export const sessionByline = (
  session: BylineFacts,
  viewerId: string,
  nameOf: (userId: string) => string | null,
): string => {
  const owner =
    session.ownerUserId === null
      ? "No owner"
      : session.ownerUserId === viewerId
        ? "You"
        : (nameOf(session.ownerUserId) ?? "Another member");
  const agent = [
    harnessName(session.harness),
    session.model ?? null,
    session.effort == null ? null : `${session.effort} effort`,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return `${owner} · ${agent} · ${STATUS_WORDS[session.status]}`;
};

/** Who steers a session: shared control as it stands, for whoever reads it. */
type ControlFacts = Pick<Session, "ownerUserId" | "sharedControlEnabledAt"> & {
  /** The people granted shared control one by one; missing reads as nobody. */
  readonly sharedControlUserIds?: ReadonlyArray<string>;
};

/** "a", "a and b", "a, b and c". */
const listed = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/** Who holds a grant, by name: "You" first for the viewer, "another member" for a stranger. */
const grantedNames = (
  session: ControlFacts,
  viewerId: string,
  nameOf: (userId: string) => string | null,
): ReadonlyArray<string> => {
  const ids = session.sharedControlUserIds ?? [];
  return [
    ...(ids.includes(viewerId) ? ["You"] : []),
    ...ids.filter((id) => id !== viewerId).map((id) => nameOf(id) ?? "another member"),
  ];
};

/**
 * Whether a session's shared control is on, in the words of each session's line: on for everyone
 * who can see the project (docs/adr/0003), or held by the people the owner granted it to, one by
 * one (docs/adr/0026, decision 7).
 */
export const sharedControlWords = (
  session: ControlFacts,
  viewerId: string,
  nameOf: (userId: string) => string | null,
): string => {
  if (session.ownerUserId === null) return "No owner, so nobody steers it.";
  if (session.sharedControlEnabledAt !== null)
    return "Shared control is on: everyone who can see this project can steer it.";
  const granted = grantedNames(session, viewerId, nameOf);
  if (granted.length === 0) return "Shared control is off.";
  return `${listed(granted)} ${granted.length === 1 && granted[0] !== "You" ? "has" : "have"} shared control.`;
};

/**
 * What the page's own session says of its control, for the person reading it (`viewer-lines`,
 * `org-owner-off`):
 * - `owner`: the session is theirs (the line is `sharedControlWords`);
 * - `can-turn-off`: an organization owner while it's on for everyone;
 * - `line`: everyone else reads who steers.
 * What each may do about it (ask, turn it on for the person who asked, turn it off) comes from the
 * server's `acts`, in the Details row (`SharedControlRow`, components/session/shared-control.tsx).
 */
export type ControlRow =
  | { readonly kind: "owner"; readonly on: boolean }
  | { readonly kind: "can-turn-off"; readonly line: string }
  | { readonly kind: "line"; readonly line: string };

export const controlRow = (
  session: ControlFacts,
  control: Pick<SessionDetailDto["control"], "own" | "toggleSharedControl">,
  viewer: { readonly id: string; readonly nameOf: (userId: string) => string | null },
): ControlRow => {
  const on = session.sharedControlEnabledAt !== null;
  if (control.own) return { kind: "owner", on };
  if (session.ownerUserId === null)
    return { kind: "line", line: sharedControlWords(session, viewer.id, viewer.nameOf) };
  const ownerName = viewer.nameOf(session.ownerUserId);
  if (on) {
    const line = `${ownerName ?? "Its owner"} shares control of this session. Everyone who can see this project can steer it.`;
    return control.toggleSharedControl ? { kind: "can-turn-off", line } : { kind: "line", line };
  }
  const ids = session.sharedControlUserIds ?? [];
  if (ids.includes(viewer.id))
    return {
      kind: "line",
      line: `${ownerName ?? "Its owner"} shares control of this session with you.`,
    };
  const others = grantedNames(session, viewer.id, viewer.nameOf);
  const steerers = listed([ownerName ?? "its owner", ...others]);
  return {
    kind: "line",
    line: `Only ${steerers} ${others.length === 0 ? "steers" : "steer"} this session. You can read the record and review the change.`,
  };
};

/** A check's result, in plain words with when it ended: "Passed 4 min ago." */
export const checkWords = (check: ObservedCheck, now: Date): string => {
  const ago = agoWords(new Date(check.at), now);
  switch (check.result) {
    case "passed":
      return `Passed ${ago}.`;
    case "failed":
      return check.exitCode === null
        ? `Failed ${ago}.`
        : `Failed ${ago}, exit code ${check.exitCode}.`;
    case "running":
      return "Running now.";
    case "unknown":
      return `Ran ${ago}. The record holds no exit code.`;
  }
};

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
const agoWords = (at: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
};

/**
 * "The last 2 edits haven't been tested.": the file edits the record shows after the newest check
 * ended, null when there are none or no check ran. What was observed, not a verdict on the change.
 */
export const untestedWords = (
  edits: ReadonlyArray<{ readonly at: string }>,
  checks: ReadonlyArray<ObservedCheck>,
): string | null => {
  const newest = checks[0];
  if (newest === undefined || newest.result === "running") return null;
  const after = edits.filter((edit) => edit.at > newest.at).length;
  if (after === 0) return null;
  return after === 1
    ? "The last edit hasn't been tested."
    : `The last ${after} edits haven't been tested.`;
};

/** A Service the workspace runs, as its row reads: "web :3000" and "Running". */
export interface ServiceRow {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

/** What a Service's row reads of the list's view. */
interface ServiceFacts {
  readonly service: {
    readonly id: string;
    readonly sessionId: string;
    readonly name: string;
    readonly workspacePort: number;
    readonly currentAttemptId: string | null;
  };
  readonly attempts: ReadonlyArray<{ readonly id: string; readonly exitedAt: Date | null }>;
  readonly currentForward: { readonly id: string; readonly state: string } | null;
  readonly latestObservation: { readonly forwardId: string; readonly state: string } | null;
}

const liveAttempt = (view: ServiceFacts): boolean => {
  const current =
    view.service.currentAttemptId === null
      ? undefined
      : view.attempts.find((attempt) => attempt.id === view.service.currentAttemptId);
  return current !== undefined && current.exitedAt === null;
};

/**
 * The Services running in the workspace (any of its sessions'), each with what Mend observed of
 * its port: answering, not yet, or not reached.
 */
export const workspaceServiceRows = (
  views: ReadonlyArray<ServiceFacts>,
  sessionIds: ReadonlySet<string>,
): ReadonlyArray<ServiceRow> =>
  views
    .filter((view) => sessionIds.has(view.service.sessionId))
    .filter(
      (view) =>
        liveAttempt(view) ||
        view.currentForward?.state === "binding" ||
        view.currentForward?.state === "bound",
    )
    .map((view) => {
      const observation =
        view.currentForward !== null && view.latestObservation?.forwardId === view.currentForward.id
          ? view.latestObservation.state
          : null;
      return {
        id: view.service.id,
        name: `${view.service.name} :${view.service.workspacePort}`,
        state:
          observation === "reachable"
            ? "Running"
            : observation === null
              ? "Running. Its port hasn't answered yet."
              : "Running. Its port doesn't answer.",
      };
    });

/** A repository the session holds beside its worktree (docs/adr/0011, `repo-session-card`). */
export interface RepositoryRow {
  readonly path: string;
  readonly line: string;
  readonly failed: boolean;
  /** Its change, when it has moved past its start: reviewed at `/changes/<id>`. */
  readonly changeId: string | null;
}

/** What a repository's row reads of the session's detail. */
interface RepositoryFacts {
  readonly repository: {
    readonly path: string;
    readonly branch: string;
    readonly error: string | null;
    readonly capture: string;
    readonly state: string;
  };
  readonly projectName: string | null;
  readonly checkpointsBeyondStart: number;
  readonly change: { readonly id: string } | null;
}

export const repositoryRows = (
  repositories: ReadonlyArray<RepositoryFacts>,
): ReadonlyArray<RepositoryRow> =>
  repositories.map((view) => {
    const moved = view.checkpointsBeyondStart;
    const progress =
      view.repository.error ??
      (moved > 0
        ? `${moved} ${moved === 1 ? "checkpoint" : "checkpoints"} beyond start`
        : view.repository.capture === "nested"
          ? "saved with the main repository"
          : "no checkpoints beyond start");
    return {
      path: view.repository.path,
      line: `${view.projectName ?? "project removed"} · ${view.repository.branch} · ${progress}`,
      failed: view.repository.state === "failed",
      changeId: view.change !== null && moved > 0 ? view.change.id : null,
    };
  });
