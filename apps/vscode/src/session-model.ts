import { mayAnswer, rowCapability, type RowCapability } from "./session-capability.js";
import { displaySession, type MemberName } from "./session-lines.js";
import type { Project, ProjectDetail, Session, SessionStatus } from "./types.js";

/**
 * The Mend view's one model (stories a, b and f; rules 9, 10 and 12-16): what every session reads
 * as, which group it sits in for this window, the badge, the status bar, and the notifications a
 * change between two reads raises. Pure: the store reads Mend and the view, status bar, badge and
 * notifier only map what this returns.
 */

/** Why a session waits for a person, as Mend observed it. */
export interface WaitFact {
  /** The same for one wait: a terminal agent's `since`, or a conversation's request id. */
  readonly key: string;
  /** `claude needs your permission to use Bash`, or the request's own title. */
  readonly words: string;
  readonly since: string;
  readonly via: "terminal" | "conversation";
}

/** A session's newest landing that reached origin, as `GET /sessions/:id/landings` reports it. */
export interface LandingFact {
  readonly id: string;
  /** Who landed it: the change's owner. */
  readonly userId: string;
  readonly createdAt: string;
  readonly remoteBranch: string;
  readonly pullRequest: {
    readonly number: number;
    readonly state: "open" | "closed" | "merged";
  } | null;
}

/** What `globalState` keeps per server URL, on this machine only (Decided 3). */
export interface LastSeen {
  /** When this VS Code first read the server: what settled before it is not news. */
  readonly baseline: string;
  /** Per session, when this VS Code last showed it: selected, or its workspace window focused. */
  readonly sessions: Readonly<Record<string, string>>;
}

export type Connection =
  | { readonly state: "connecting" }
  | { readonly state: "online"; readonly lastHeardAt: string }
  | { readonly state: "offline"; readonly lastHeardAt: string | null };

/** This window, as the model needs it: a session's workspace (and which session), or any other. */
export type WindowFacts =
  | { readonly kind: "local" }
  | { readonly kind: "workspace"; readonly sessionId: string | null };

export interface ModelInput {
  readonly projects: ReadonlyArray<Project>;
  readonly details: ReadonlyArray<ProjectDetail>;
  readonly viewer: string | null;
  readonly members: ReadonlyArray<MemberName>;
  readonly waits: ReadonlyMap<string, WaitFact>;
  readonly landings: ReadonlyMap<string, LandingFact>;
  readonly lastSeen: LastSeen;
  readonly connection: Connection;
  readonly window: WindowFacts;
  readonly now: Date;
}

export type Word = SessionStatus | "landed";

export interface SessionView {
  readonly project: Project;
  readonly session: Session;
  readonly name: string;
  readonly word: Word;
  /** Who did what the word says, when it was someone else: `landed by Ana`. */
  readonly by: string | null;
  readonly fact: string | null;
  /** `<word> · <fact>`, then `since` for a wait and `last seen` while Mend is unreachable. */
  readonly line: string;
  readonly wait: WaitFact | null;
  /** Waiting for a reason Mend observed, and Answer lets her answer it (`mayAnswer`). */
  readonly needsYou: boolean;
  readonly sinceYouLastLooked: boolean;
  readonly live: boolean;
  /** She started it; false when Mend cannot say who she is. */
  readonly mine: boolean;
  /** When it settled or landed; null while it is live. */
  readonly settledAt: string | null;
  readonly capability: RowCapability;
}

export interface ProjectRows {
  readonly project: Project;
  readonly rows: ReadonlyArray<SessionView>;
}

export type ViewGroup =
  | { readonly kind: "needs"; readonly rows: ReadonlyArray<SessionView> }
  | {
      readonly kind: "since";
      readonly rows: ReadonlyArray<SessionView>;
      /** Past `SINCE_GROUPS_AFTER` rows, the same rows by project. */
      readonly byProject: ReadonlyArray<ProjectRows> | null;
    }
  | { readonly kind: "running"; readonly rows: ReadonlyArray<SessionView> }
  | { readonly kind: "projects"; readonly projects: ReadonlyArray<ProjectRows> };

export interface StatusBarView {
  readonly text: string;
  readonly tooltip: string;
  /** The session's word whose dot leads the item, in a workspace window. */
  readonly dot: Word | null;
}

interface ModelCommon {
  readonly sessions: ReadonlyMap<string, SessionView>;
  readonly badge: number;
  readonly statusBar: StatusBarView;
  /** What the view says above its rows: `last heard from Mend at 23:10`. */
  readonly message: string | null;
  readonly offline: boolean;
}

export interface LocalModel extends ModelCommon {
  readonly kind: "local";
  readonly groups: ReadonlyArray<ViewGroup>;
}

export interface WorkspaceModel extends ModelCommon {
  readonly kind: "workspace";
  readonly session: SessionView | null;
  readonly others: { readonly count: number; readonly needsYou: number };
}

export type WindowModel = LocalModel | WorkspaceModel;

export const SINCE_GROUPS_AFTER = 8;

const LIVE: ReadonlySet<SessionStatus> = new Set([
  "starting",
  "running",
  "waiting",
  "idle",
  "stopping",
]);

const SETTLED_NEWS: ReadonlySet<Word> = new Set(["completed", "failed", "landed"]);

/** `02:14`, in this machine's time. */
export const clockTime = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** `2 min ago`, from the last time Mend was heard. */
export const agoWords = (iso: string, now: Date): string => {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};

const firstLine = (text: string | null): string | null => {
  const line = text?.split("\n")[0]?.trim() ?? "";
  return line === "" ? null : line;
};

const nameOf = (userId: string | null, members: ReadonlyArray<MemberName>): string =>
  members.find((member) => member.userId === userId)?.name ?? "another person";

const landedFact = (landing: LandingFact): string =>
  landing.pullRequest === null
    ? `pushed · ${landing.remoteBranch} · observed`
    : `pull request #${landing.pullRequest.number} · ${landing.pullRequest.state} · observed`;

const sessionView = (
  input: ModelInput,
  project: Project,
  session: Session,
  offline: boolean,
): SessionView => {
  const { viewer, members } = input;
  const live = LIVE.has(session.status);
  const mine = viewer !== null && session.ownerUserId === viewer;
  const waiting = session.status === "waiting";
  const wait = waiting ? (input.waits.get(session.id) ?? null) : null;
  // Only a wait Mend observed needs her, and only one Answer lets her answer.
  const canAnswer = wait !== null && mayAnswer(session, viewer, wait.via);
  const landed = live ? null : (input.landings.get(session.id) ?? null);
  // A landing of an earlier turn says nothing about a turn that settled after it.
  const landing =
    landed !== null &&
    (session.settledAt === null || Date.parse(landed.createdAt) >= Date.parse(session.settledAt))
      ? landed
      : null;
  const word: Word = landing === null ? session.status : "landed";
  const by =
    landing !== null && viewer !== null && landing.userId !== viewer
      ? nameOf(landing.userId, members)
      : null;
  const summary = firstLine(session.summary);
  const someoneElses = viewer !== null && session.ownerUserId !== viewer;
  const fact =
    landing !== null
      ? landedFact(landing)
      : waiting && !canAnswer && someoneElses
        ? `${nameOf(session.ownerUserId, members)}'s session`
        : waiting
          ? (wait?.words ?? summary)
          : session.status === "completed"
            ? ["observed", ...(summary === null ? [] : [summary])].join(" · ")
            : summary;
  const settledAt =
    landing !== null ? landing.createdAt : live ? null : (session.settledAt ?? null);
  const seen = input.lastSeen.sessions[session.id] ?? input.lastSeen.baseline;
  const lastHeardAt = input.connection.state === "offline" ? input.connection.lastHeardAt : null;
  const line = [
    by === null ? word : `${word} by ${by}`,
    ...(fact === null ? [] : [fact]),
    ...(wait !== null && canAnswer ? [`since ${clockTime(wait.since)}`] : []),
    ...(offline && lastHeardAt !== null ? [`last seen ${agoWords(lastHeardAt, input.now)}`] : []),
  ].join(" · ");
  return {
    project,
    session,
    name: displaySession(session),
    word,
    by,
    fact,
    line,
    wait,
    needsYou: waiting && canAnswer,
    sinceYouLastLooked:
      SETTLED_NEWS.has(word) && settledAt !== null && Date.parse(settledAt) > Date.parse(seen),
    live,
    mine,
    settledAt,
    capability: rowCapability({ session, viewer, members }),
  };
};

const newestFirst = (left: SessionView, right: SessionView): number =>
  right.session.createdAt.localeCompare(left.session.createdAt);

const byProject = (rows: ReadonlyArray<SessionView>): ReadonlyArray<ProjectRows> => {
  const projects = new Map<string, ProjectRows>();
  for (const row of rows) {
    const found = projects.get(row.project.id);
    projects.set(row.project.id, {
      project: row.project,
      rows: [...(found?.rows ?? []), row],
    });
  }
  return [...projects.values()].toSorted((left, right) => right.rows.length - left.rows.length);
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The model for this window, from what the store last read. */
export const sessionModel = (input: ModelInput): WindowModel => {
  const offline = input.connection.state === "offline";
  const views = input.details.flatMap((detail) =>
    detail.sessions.map((session) => sessionView(input, detail.project, session, offline)),
  );
  const sessions = new Map(views.map((view) => [view.session.id, view]));
  const needs = views
    .filter((view) => view.needsYou)
    .toSorted((left, right) =>
      (left.wait?.since ?? left.session.createdAt).localeCompare(
        right.wait?.since ?? right.session.createdAt,
      ),
    );
  const since = views
    .filter((view) => view.sinceYouLastLooked && !view.needsYou)
    .toSorted((left, right) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""));
  const running = views.filter((view) => view.live && !view.needsYou).toSorted(newestFirst);
  const lastHeardAt = input.connection.state === "offline" ? input.connection.lastHeardAt : null;
  const message = !offline
    ? null
    : lastHeardAt === null
      ? "Mend is offline"
      : `last heard from Mend at ${clockTime(lastHeardAt)}`;
  const badge = needs.length;

  if (input.window.kind === "workspace") {
    const sessionId = input.window.sessionId;
    const session = sessionId === null ? null : (sessions.get(sessionId) ?? null);
    const others = [...needs, ...since, ...running].filter((view) => view.session.id !== sessionId);
    const statusBar: StatusBarView =
      session === null
        ? { text: "Mend", tooltip: "Mend sessions", dot: null }
        : {
            text: [
              session.name,
              session.word,
              ...(offline && lastHeardAt !== null
                ? [`last seen ${agoWords(lastHeardAt, input.now)}`]
                : []),
            ].join(" · "),
            tooltip: `${session.name} · ${session.line}\nChoose another session`,
            dot: session.word,
          };
    return {
      kind: "workspace",
      sessions,
      badge,
      statusBar,
      message,
      offline,
      session,
      others: {
        count: others.length,
        needsYou: others.filter((view) => view.needsYou).length,
      },
    };
  }

  const finished = since.filter((view) => view.word !== "landed").length;
  const parts = [
    ...(needs.length > 0 ? [`${needs.length} needs you`] : []),
    ...(finished > 0 ? [`${finished} finished`] : []),
    ...(running.length > 0 ? [`${running.length} running`] : []),
  ];
  const statusBar: StatusBarView = offline
    ? {
        text:
          lastHeardAt === null
            ? "Mend · offline"
            : `Mend · last heard at ${clockTime(lastHeardAt)}`,
        tooltip: message ?? "Mend is offline",
        dot: null,
      }
    : { text: ["Mend", ...parts].join(" · "), tooltip: "Show the Mend view", dot: null };
  const groups: Array<ViewGroup> = [];
  if (needs.length > 0) groups.push({ kind: "needs", rows: needs });
  if (since.length > 0)
    groups.push({
      kind: "since",
      rows: since,
      byProject: since.length > SINCE_GROUPS_AFTER ? byProject(since) : null,
    });
  if (running.length > 0) groups.push({ kind: "running", rows: running });
  if (input.projects.length > 0)
    groups.push({
      kind: "projects",
      projects: input.projects.map((project) => ({
        project,
        rows: views.filter((view) => view.project.id === project.id).toSorted(newestFirst),
      })),
    });
  return { kind: "local", sessions, badge, statusBar, message, offline, groups };
};

/** The others line of a workspace window: `2 other sessions · 1 needs you`. */
export const othersLine = (others: WorkspaceModel["others"]): string =>
  [
    others.count === 0
      ? "no other sessions"
      : plural(others.count, "other session", "other sessions"),
    ...(others.needsYou > 0 ? [`${others.needsYou} needs you`] : []),
  ].join(" · ");

/** Why a notification stays quiet in this window; null when it toasts. */
export type Quiet = "already-there" | "unfocused" | "showing" | null;

export type Notification =
  | {
      readonly kind: "waits";
      readonly key: string;
      readonly sessionId: string;
      readonly text: string;
      readonly quiet: Quiet;
    }
  | {
      readonly kind: "finished";
      readonly key: string;
      readonly sessionId: string;
      readonly text: string;
      readonly quiet: Quiet;
    }
  /** A wait that ended (answered here or elsewhere): its toast, if one shows, no longer holds. */
  | { readonly kind: "withdrawn"; readonly key: string; readonly sessionId: string };

/** What this window is doing when a read lands. */
export interface Attention {
  readonly focused: boolean;
  /** Sessions this window shows: selected in its view, or the window's own. */
  readonly showing: ReadonlySet<string>;
  /** Keys raised before, here: a key never toasts twice. */
  readonly raised: ReadonlySet<string>;
}

/** One key per wait, for as long as it lasts: what it is never toasts twice. */
const waitKey = (view: SessionView): string | null =>
  view.needsYou && view.wait !== null ? `${view.session.id}:wait:${view.wait.key}` : null;

const needsKeys = (model: WindowModel | null): ReadonlySet<string> =>
  new Set(
    model === null ? [] : [...model.sessions.values()].flatMap((view) => waitKey(view) ?? []),
  );

/**
 * What a change from `prev` to `next` raises (rules 12-14): a session that now waits for her, a
 * session she started that finished, and waits that ended. A first read raises its waits as
 * `already-there`, so they never toast later.
 */
export const transitions = (
  prev: WindowModel | null,
  next: WindowModel,
  attention: Attention,
): ReadonlyArray<Notification> => {
  const before = needsKeys(prev);
  const quietFor = (sessionId: string): Quiet =>
    prev === null
      ? "already-there"
      : !attention.focused
        ? "unfocused"
        : attention.showing.has(sessionId)
          ? "showing"
          : null;
  const after = [...next.sessions.values()];
  const waits = after.flatMap((view): ReadonlyArray<Notification> => {
    const key = waitKey(view);
    if (key === null || before.has(key) || attention.raised.has(key)) return [];
    return [
      {
        kind: "waits",
        key,
        sessionId: view.session.id,
        text: [`${view.name} is waiting`, ...(view.fact === null ? [] : [view.fact])].join(" · "),
        quiet: quietFor(view.session.id),
      },
    ];
  });
  const finished = after.flatMap((view): ReadonlyArray<Notification> => {
    if (!view.mine || (view.word !== "completed" && view.word !== "failed")) return [];
    const earlier = prev?.sessions.get(view.session.id);
    if (earlier === undefined || !earlier.live) return [];
    const key = `${view.session.id}:settled:${view.settledAt ?? view.word}`;
    if (attention.raised.has(key)) return [];
    const fact = view.word === "completed" ? firstLine(view.session.summary) : view.fact;
    return [
      {
        kind: "finished",
        key,
        sessionId: view.session.id,
        text: [
          view.word === "completed" ? `${view.name} finished` : `${view.name} failed`,
          ...(fact === null ? [] : [fact]),
        ].join(" · "),
        quiet: quietFor(view.session.id),
      },
    ];
  });
  const now = needsKeys(next);
  const withdrawn = [...before]
    .filter((key) => !now.has(key))
    .map(
      (key): Notification => ({
        kind: "withdrawn",
        key,
        sessionId: key.slice(0, key.indexOf(":wait:")),
      }),
    );
  return [...waits, ...finished, ...withdrawn];
};

/** Two windows' records of one server, as one: the later look per session, the earlier baseline. */
export const mergeLastSeen = (left: LastSeen, right: LastSeen): LastSeen => {
  const sessions: Record<string, string> = { ...left.sessions };
  for (const [id, at] of Object.entries(right.sessions)) {
    const known = sessions[id];
    if (known === undefined || Date.parse(at) > Date.parse(known)) sessions[id] = at;
  }
  return {
    baseline:
      Date.parse(left.baseline) <= Date.parse(right.baseline) ? left.baseline : right.baseline,
    sessions,
  };
};

/** Sessions this VS Code shows now count as seen now (Decided 3). */
export const seen = (lastSeen: LastSeen, sessionIds: ReadonlyArray<string>, now: Date): LastSeen =>
  sessionIds.length === 0
    ? lastSeen
    : {
        ...lastSeen,
        sessions: {
          ...lastSeen.sessions,
          ...Object.fromEntries(sessionIds.map((id) => [id, now.toISOString()])),
        },
      };
