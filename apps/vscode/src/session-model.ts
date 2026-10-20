import type { RequestView } from "./request-answer.js";
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
export type WaitFact =
  | {
      readonly via: "terminal";
      /** The same for one wait: the agent's reported kind and `since`. */
      readonly key: string;
      /** `claude needs your permission to use Bash`. */
      readonly words: string;
      readonly since: string;
    }
  | {
      readonly via: "conversation";
      /** The request's id. */
      readonly key: string;
      /** The request's question: `run pnpm db:migrate?`. */
      readonly words: string;
      readonly since: string;
      readonly request: RequestView;
      /** Who the asking process runs as: only they may answer it. Null when anyone steering may. */
      readonly answerer: string | null;
    };

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

/** The server refused a launch over HTTP (`POST /sessions/:id/launch`) with `line`, at `at`. */
export interface Refusal {
  readonly line: string;
  readonly at: string;
  /**
   * A read after the refusal found the server had not settled it, so only this window can say it.
   * False when that read failed: whether the server settled it is unknown, so it raises nothing of
   * its own, and a settlement read later is its one toast in every window.
   */
  readonly confirmed: boolean;
}

/**
 * The latest launch this window sent of a session: the first, or a Retry. Each is told apart from
 * the one before by the server's own `settledAt`, never by comparing clocks, so a Retry that fails
 * before any read sees it `starting` is still its own failure.
 */
export interface LaunchAttempt {
  /** 1 for the first launch, one more per Retry. */
  readonly n: number;
  /** The session's `settledAt` when this attempt was sent: a failure settled since is this one's. */
  readonly after: string | null;
  /**
   * The server refused this attempt over HTTP. Until a read shows the server settled it, the
   * session reads `failed · <line>`.
   */
  readonly refusal: Refusal | null;
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
  /** Launches this window sent, by session: their latest attempt. */
  readonly launches: ReadonlyMap<string, LaunchAttempt>;
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
  /** This window launched it: which attempt is the latest, and how it ended. */
  readonly launch: { readonly attempt: number; readonly outcome: LaunchOutcome } | null;
}

/**
 * `failed`: the server settled it failed since it was sent. `refused`: the server answered it
 * with a refusal a read found it had not settled (`Launches` reads it first), whatever it settles
 * later. `pending`: neither yet, or it ran.
 */
export type LaunchOutcome =
  | { readonly kind: "pending" }
  /** `at`: when it settled failed, or was refused; how old its toast's claim is. */
  | { readonly kind: "refused" | "failed"; readonly at: string };

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

/** What the session itself says beside its word: its summary, after `observed` once completed. */
const ownFact = (session: Pick<Session, "status" | "summary">): string | null => {
  const summary = firstLine(session.summary);
  return session.status === "completed"
    ? ["observed", ...(summary === null ? [] : [summary])].join(" · ")
    : summary;
};

/**
 * How a session reads before a read of its wait or landing: `completed · observed · 4 files`,
 * `running · reading src/auth`, or the word alone where the session says nothing more.
 */
export const ownLine = (session: Pick<Session, "status" | "summary">): string => {
  const fact = ownFact(session);
  return fact === null ? session.status : `${session.status} · ${fact}`;
};

/** The read has not settled since the attempt was sent: the server has said nothing of it yet. */
const unsettledSince = (session: Session, attempt: LaunchAttempt): boolean =>
  session.status === "starting" ||
  (session.status === "failed" && session.settledAt === attempt.after);

/**
 * The session as it reads: its status is the server's, and a refused attempt the server has said
 * nothing of since gives its words (`starting · launch refused · …`).
 */
const withRefusal = (session: Session, attempt: LaunchAttempt | undefined): Session =>
  attempt === undefined || attempt.refusal === null || !unsettledSince(session, attempt)
    ? session
    : { ...session, summary: attempt.refusal.line };

/** How this window's latest attempt ended, as far as the reads and its answer say. */
const attemptOutcome = (read: Session, attempt: LaunchAttempt): LaunchOutcome =>
  attempt.refusal?.confirmed === true && (read.status === "starting" || read.status === "failed")
    ? { kind: "refused", at: attempt.refusal.at }
    : read.status === "failed" && read.settledAt !== attempt.after
      ? { kind: "failed", at: settledFailureAt(read) }
      : { kind: "pending" };

const settledFailureAt = (session: Session): string => session.settledAt ?? session.createdAt;

/** A failure the server settled: one key in every window, the launching one included. */
const settledFailureKey = (session: Session): string =>
  `${session.id}:launchFailed:${settledFailureAt(session)}`;

const sessionView = (
  input: ModelInput,
  project: Project,
  read: Session,
  offline: boolean,
): SessionView => {
  const { viewer, members } = input;
  const attempt = input.launches.get(read.id);
  const session = withRefusal(read, attempt);
  const live = LIVE.has(session.status);
  const mine = viewer !== null && session.ownerUserId === viewer;
  const waiting = session.status === "waiting";
  // An idle terminal agent's report is a finished turn: it says so, and asks nobody.
  const reported = waiting || session.status === "idle";
  const wait = reported ? (input.waits.get(session.id) ?? null) : null;
  // Only a wait Mend observed needs her, and only one Answer lets her answer.
  const canAnswer = waiting && wait !== null && mayAnswer(session, viewer, wait);
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
        : reported
          ? (wait?.words ?? summary)
          : ownFact(session);
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
    launch:
      attempt === undefined ? null : { attempt: attempt.n, outcome: attemptOutcome(read, attempt) },
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

/** What every notification carries: which one it is, and when what it says began. */
interface Raised {
  /** One per wait or finish: what it names never toasts twice. */
  readonly key: string;
  readonly sessionId: string;
  /** When the wait began, or the session settled: how old the claim on `key` is. */
  readonly at: string;
}

export type Notification =
  | (Raised & {
      readonly kind: "waits";
      readonly text: string;
      readonly quiet: Quiet;
      readonly name: string;
      /** A conversation's request, which the toast answers itself; null for a terminal agent. */
      readonly request: RequestView | null;
    })
  | (Raised & { readonly kind: "finished"; readonly text: string; readonly quiet: Quiet })
  /**
   * A launch she sent failed, or the server refused it: its error toast may offer Retry, which
   * launches only over `settledAt`, the failure the session read when it was raised. Null when it
   * read `starting`: a refusal the server never settled.
   */
  | (Raised & {
      readonly kind: "launchFailed";
      readonly text: string;
      readonly settledAt: string | null;
      readonly quiet: Quiet;
    })
  /** A wait that ended (answered here or elsewhere): its toast, if one shows, no longer holds. */
  | (Raised & { readonly kind: "withdrawn" });

/** What this window is doing when a read lands. */
export interface Attention {
  readonly focused: boolean;
  /** Sessions this window shows: selected in its view, or the window's own. */
  readonly showing: ReadonlySet<string>;
  /** Keys raised before, here: a key never toasts twice. */
  readonly raised: ReadonlySet<string>;
}

/** The waits that need her in `model`, by key: one key per wait, for as long as it lasts. */
export const waitsOf = (model: WindowModel | null): ReadonlyMap<string, Raised> => {
  const waits = new Map<string, Raised>();
  for (const view of model?.sessions.values() ?? []) {
    if (!view.needsYou || view.wait === null) continue;
    const key = `${view.session.id}:wait:${view.wait.key}`;
    waits.set(key, { key, sessionId: view.session.id, at: view.wait.since });
  }
  return waits;
};

/**
 * What a change from `prev` to `next` raises (rules 12-14): a session that now waits for her, a
 * session she started that finished, one whose launch failed, and waits that ended. A first read raises its waits as
 * `already-there`, so they never toast later.
 */
export const transitions = (
  prev: WindowModel | null,
  next: WindowModel,
  attention: Attention,
): ReadonlyArray<Notification> => {
  const before = waitsOf(prev);
  const now = waitsOf(next);
  const quietFor = (sessionId: string): Quiet =>
    prev === null
      ? "already-there"
      : !attention.focused
        ? "unfocused"
        : attention.showing.has(sessionId)
          ? "showing"
          : null;
  const waits = [...now.values()].flatMap((wait): ReadonlyArray<Notification> => {
    const view = next.sessions.get(wait.sessionId);
    if (view === undefined || before.has(wait.key) || attention.raised.has(wait.key)) return [];
    const request = view.wait?.via === "conversation" ? view.wait.request : null;
    return [
      {
        kind: "waits",
        ...wait,
        name: view.name,
        request,
        text:
          request !== null
            ? `${view.name} asks: ${request.question}`
            : [`${view.name} is waiting`, ...(view.fact === null ? [] : [view.fact])].join(" · "),
        quiet: quietFor(wait.sessionId),
      },
    ];
  });
  const launchFailed = (view: SessionView, key: string, at: string): ReadonlyArray<Notification> =>
    attention.raised.has(key)
      ? []
      : [
          {
            kind: "launchFailed",
            key,
            sessionId: view.session.id,
            at,
            settledAt: view.session.status === "failed" ? view.session.settledAt : null,
            // A refusal the server still reads `starting` is said as the refusal, not as failed.
            text: [
              view.word === "failed" ? `${view.name} failed` : view.name,
              ...(view.fact === null ? [] : [view.fact]),
            ].join(" · "),
            // Rule 14: the toast carries Retry, which the row does not, so a row on screen keeps it.
            quiet: prev === null ? "already-there" : attention.focused ? null : "unfocused",
          },
        ];
  const finished = [...next.sessions.values()].flatMap((view): ReadonlyArray<Notification> => {
    if (!view.mine) return [];
    // Each attempt this window sent ends once, whatever reads came between: failed to failed too.
    // A refusal the server never settled is this window's alone, so only it is keyed by attempt.
    if (view.launch !== null && (view.word === "failed" || view.word === "starting")) {
      const { attempt, outcome } = view.launch;
      if (outcome.kind === "pending") return [];
      return outcome.kind === "refused"
        ? launchFailed(view, `${view.session.id}:launchRefused:${attempt}`, outcome.at)
        : launchFailed(view, settledFailureKey(view.session), outcome.at);
    }
    if (view.word !== "completed" && view.word !== "failed") return [];
    const earlier = prev?.sessions.get(view.session.id);
    if (earlier === undefined || !earlier.live) return [];
    if (earlier.word === "starting" && view.word === "failed")
      return launchFailed(view, settledFailureKey(view.session), settledFailureAt(view.session));
    const key = `${view.session.id}:settled:${view.settledAt ?? view.word}`;
    if (attention.raised.has(key)) return [];
    const fact = view.word === "completed" ? firstLine(view.session.summary) : view.fact;
    return [
      {
        kind: "finished",
        key,
        sessionId: view.session.id,
        at: view.settledAt ?? view.session.createdAt,
        text: [
          view.word === "completed" ? `${view.name} finished` : `${view.name} failed`,
          ...(fact === null ? [] : [fact]),
        ].join(" · "),
        quiet: quietFor(view.session.id),
      },
    ];
  });
  const withdrawn = [...before.values()]
    .filter((wait) => !now.has(wait.key))
    .map((wait): Notification => ({ kind: "withdrawn", ...wait }));
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
