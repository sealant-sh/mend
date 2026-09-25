import { servicesHoldLine } from "@mend/domain/workbench";

import {
  agentIsLive,
  agentOutcome,
  HARNESS_COMMANDS,
  isPendingId,
  LIVE_STATUSES,
  type AgentProcessLike,
} from "./shared.ts";

/**
 * The dashboard's pure data layer: DTOs as the server sends them, the
 * worktree grouping (real containers on a worktree-aware server, one pseudo
 * group per session on an older one), the column plan the keyboard moves
 * through, and what each verb may do with the current selection. No
 * rendering, no opentui — testable on any Node.
 */

export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
}

export interface SessionDto {
  readonly id: string;
  /** Present once the server is worktree-aware; absent on older servers. */
  readonly worktreeId?: string;
  readonly harness: string;
  readonly label: string | null;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly status: string;
  readonly summary: string | null;
  /** False = settled without a conversation: nothing to resume; hidden. Absent on older servers. */
  readonly hasTranscript?: boolean | null;
  readonly createdAt: string;
}

export interface WorktreeDto {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
}

export interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly changeId: string | null;
  readonly openComments: number;
  readonly pendingFollowUp: boolean;
  /** The session's agent process; absent on older servers. */
  readonly currentAgent?: AgentProcessLike | null;
  /** Services that keep the workspace up; absent on older servers. */
  readonly liveServices?: number;
}

export interface ProjectDetailDto {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
  readonly annotations: ReadonlyArray<SessionAnnotationDto>;
  /** Present when the server is worktree-aware — the capability signal. */
  readonly worktrees?: ReadonlyArray<WorktreeDto>;
}

export interface SessionProcessDto {
  readonly id: string;
  readonly kind: string;
  readonly harness: string | null;
  readonly label: string | null;
  readonly status: string;
  readonly exitedAt: string | null;
}

export interface SessionDetailDto {
  readonly session: SessionDto;
  readonly processes: ReadonlyArray<SessionProcessDto>;
}

export interface ServiceDto {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string | null;
  readonly status: string;
  readonly workspacePort: number | null;
  readonly protocol: "tcp" | "udp";
  readonly hostPort: number | null;
}

/**
 * The worktree IS the session's identity (one worktree per session): its
 * branch, with the noisy default prefix receded. What you are working on
 * leads every row; the harness is a fact about it, not its name.
 */
export const worktreeName = (branch: string): string =>
  branch.startsWith("mend/") ? branch.slice("mend/".length) : branch;

/**
 * What to call an UNNAMED worktree: its branch is `mend/session/<uuid>` —
 * noise nobody recognizes — so the auto-name label stands in, and before one
 * lands, the short session id. A named worktree is always its own name.
 */
export const worktreeDisplayName = (session: SessionDto): string => {
  const name = worktreeName(session.branch);
  if (!name.startsWith("session/")) return name;
  return session.label ?? `session ${session.id.slice(0, 8)}`;
};

/** True when the label already IS the row's identity — don't repeat it. */
export const labelIsIdentity = (session: SessionDto): boolean =>
  worktreeName(session.branch).startsWith("session/") && session.label !== null;

// ─── server state: one cache entry, invalidated by the event stream ─────────

export interface Workbench {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly details: ReadonlyMap<string, ProjectDetailDto>;
  /** Live Services grouped by session — what is running right now. */
  readonly servicesBySession: ReadonlyMap<string, ReadonlyArray<ServiceDto>>;
  /** Live agent + shell processes per LIVE session — what lives in each worktree. */
  readonly processesBySession: ReadonlyMap<string, ReadonlyArray<SessionProcessDto>>;
}

export const WORKBENCH_KEY = ["workbench"];

/** The one server call surface the model needs — the dashboard's ctx.api. */
export type WorkbenchApi = <T>(
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown,
) => Promise<T>;

export const fetchWorkbench = async (ctx: { readonly api: WorkbenchApi }): Promise<Workbench> => {
  const projects = await ctx.api<ReadonlyArray<ProjectDto>>("GET", "/projects");
  const [fetched, services] = await Promise.all([
    Promise.all(
      projects.map((project) => ctx.api<ProjectDetailDto>("GET", `/projects/${project.id}`)),
    ),
    ctx.api<ReadonlyArray<ServiceDto>>("GET", "/services"),
  ]);
  const servicesBySession = new Map<string, ServiceDto[]>();
  for (const service of services) {
    const bucket = servicesBySession.get(service.sessionId) ?? [];
    bucket.push(service);
    servicesBySession.set(service.sessionId, bucket);
  }
  // What lives in each LIVE worktree: the agent and shells come from the
  // session detail (settled sessions have nothing live — no fetch for them).
  const liveSessions = fetched.flatMap((detail) =>
    detail.sessions.filter((session) => LIVE_STATUSES.has(session.status)),
  );
  const detailed = await Promise.all(
    liveSessions.map(async (session) => {
      try {
        return await ctx.api<SessionDetailDto>("GET", `/sessions/${session.id}`);
      } catch {
        return null;
      }
    }),
  );
  const processesBySession = new Map<string, ReadonlyArray<SessionProcessDto>>();
  for (const detail of detailed) {
    if (detail === null) continue;
    processesBySession.set(
      detail.session.id,
      detail.processes.filter((process) => process.exitedAt === null && process.kind !== "service"),
    );
  }
  return {
    projects,
    details: new Map(fetched.map((detail) => [detail.project.id, detail])),
    servicesBySession,
    processesBySession,
  };
};

// ─── optimistic cache surgery: pure Workbench → Workbench ───────────────────

/** Apply `f` to every session row in every project detail. */
export const mapWorkbenchSessions = (
  data: Workbench,
  f: (session: SessionDto) => SessionDto,
): Workbench => ({
  ...data,
  details: new Map(
    [...data.details].map(([id, detail]) => [id, { ...detail, sessions: detail.sessions.map(f) }]),
  ),
});

export const mapProjectSessions = (
  data: Workbench,
  projectId: string,
  f: (sessions: ReadonlyArray<SessionDto>) => ReadonlyArray<SessionDto>,
): Workbench => {
  const detail = data.details.get(projectId);
  if (detail === undefined) return data;
  const details = new Map(data.details);
  details.set(projectId, { ...detail, sessions: f(detail.sessions) });
  return { ...data, details };
};

export const prependSession = (
  data: Workbench,
  projectId: string,
  session: SessionDto,
): Workbench => mapProjectSessions(data, projectId, (sessions) => [session, ...sessions]);

export const replaceSession = (
  data: Workbench,
  projectId: string,
  oldId: string,
  session: SessionDto,
): Workbench =>
  mapProjectSessions(data, projectId, (sessions) =>
    sessions.map((candidate) => (candidate.id === oldId ? session : candidate)),
  );

export const removeSession = (data: Workbench, projectId: string, sessionId: string): Workbench =>
  mapProjectSessions(data, projectId, (sessions) =>
    sessions.filter((candidate) => candidate.id !== sessionId),
  );

// ─── pane derivations ───────────────────────────────────────────────────────

export interface ProjectItem {
  readonly project: ProjectDto;
  readonly total: number;
  readonly live: number;
  readonly open: number;
}

export interface SessionItem {
  readonly session: SessionDto;
  readonly annotation: SessionAnnotationDto | undefined;
  readonly services: ReadonlyArray<ServiceDto>;
  /** Live agent + shell processes — what lives in this worktree right now. */
  readonly processes: ReadonlyArray<SessionProcessDto>;
}

/**
 * The container tier: one durable worktree and the conversations inside it.
 * Against a worktree-aware server these are real entities (several sessions
 * can share one); against an older server every session is its own pseudo
 * group — exactly today's world, so the UI degrades to what it was.
 */
export interface WorktreeGroup {
  /** Row identity for selection — the worktree id, or the lone session's id. */
  readonly key: string;
  /** Null on pre-worktree servers: no server-side container to address. */
  readonly id: string | null;
  readonly name: string;
  readonly branch: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
  /** Newest-live-first, same ordering the flat list had. */
  readonly sessions: ReadonlyArray<SessionItem>;
  readonly live: number;
  /** Change facts — identical on every member, read off any of them. */
  readonly annotation: SessionAnnotationDto | undefined;
}

export interface HarnessItem {
  /** null = resume with the same harness the session last ran. */
  readonly harness: string | null;
  readonly label: string;
  readonly hint: string;
}

export const deriveProjects = (data: Workbench | undefined): ReadonlyArray<ProjectItem> =>
  (data?.projects ?? []).map((project): ProjectItem => {
    const detail = data?.details.get(project.id);
    const sessions = detail?.sessions ?? [];
    const live = sessions.filter((s) => LIVE_STATUSES.has(s.status)).length;
    const open = (detail?.annotations ?? []).reduce((sum, a) => sum + a.openComments, 0);
    return { project, total: sessions.length, live, open };
  });

export const bySessionRecency = (a: SessionDto, b: SessionDto): number => {
  const aLive = LIVE_STATUSES.has(a.status) ? 1 : 0;
  const bLive = LIVE_STATUSES.has(b.status) ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  return b.createdAt.localeCompare(a.createdAt);
};

export const toSessionItem =
  (data: Workbench, detail: ProjectDetailDto) =>
  (session: SessionDto): SessionItem => ({
    session,
    annotation: detail.annotations.find((a) => a.sessionId === session.id),
    services: data.servicesBySession.get(session.id) ?? [],
    processes: data.processesBySession.get(session.id) ?? [],
  });

/**
 * A settled session that never had a conversation — no transcript captured, none in the harness
 * home — cannot be resumed or handed off. The dashboard hides it; `mend sessions --all` still
 * lists it, and removing the worktree takes it along.
 */
export const isDeadEnd = (session: Pick<SessionDto, "status" | "hasTranscript">): boolean =>
  !LIVE_STATUSES.has(session.status) && session.hasTranscript === false;

export const deriveWorktrees = (
  data: Workbench | undefined,
  projectId: string | null,
): ReadonlyArray<WorktreeGroup> => {
  if (data === undefined || projectId === null) return [];
  const detail = data.details.get(projectId);
  if (detail === undefined) return [];
  const item = toSessionItem(data, detail);
  const sorted = detail.sessions
    .filter((session) => !isDeadEnd(session))
    .toSorted(bySessionRecency);
  const groups: Array<WorktreeGroup> = [];
  if (detail.worktrees === undefined) {
    for (const session of sorted) groups.push(pseudoGroup(session, item));
  } else {
    const claimed = new Set<string>();
    for (const worktree of detail.worktrees) {
      const members = sorted.filter((session) => session.worktreeId === worktree.id);
      for (const member of members) claimed.add(member.id);
      groups.push({
        key: worktree.id,
        id: worktree.id,
        name: worktree.name.startsWith("wt-")
          ? (members.find((m) => m.label !== null)?.label ??
            (members[0] === undefined ? worktree.name : `session ${members[0].id.slice(0, 8)}`))
          : worktree.name,
        branch: worktree.branch,
        baseRef: worktree.baseRef,
        createdAt: worktree.createdAt,
        sessions: members.map(item),
        live: members.filter((session) => LIVE_STATUSES.has(session.status)).length,
        annotation: detail.annotations.find((a) => members.some((m) => m.id === a.sessionId)),
      });
    }
    // Optimistic pending rows have no worktree yet — each is its own group.
    for (const session of sorted) {
      if (claimed.has(session.id)) continue;
      groups.push(pseudoGroup(session, item));
    }
  }
  return groups.toSorted((a, b) => {
    if (a.live > 0 !== b.live > 0) return a.live > 0 ? -1 : 1;
    const aNewest = a.sessions[0]?.session.createdAt ?? a.createdAt;
    const bNewest = b.sessions[0]?.session.createdAt ?? b.createdAt;
    return bNewest.localeCompare(aNewest);
  });
};

export const pseudoGroup = (
  session: SessionDto,
  item: (session: SessionDto) => SessionItem,
): WorktreeGroup => ({
  key: session.id,
  id: null,
  name: worktreeDisplayName(session),
  branch: session.branch,
  baseRef: session.baseRef,
  createdAt: session.createdAt,
  sessions: [item(session)],
  live: LIVE_STATUSES.has(session.status) ? 1 : 0,
  annotation: item(session).annotation,
});

/** The picker's rows: resume offers the same harness first, then the crossings. */
export const deriveHarnesses = (resuming: SessionDto | null): ReadonlyArray<HarnessItem> => {
  if (resuming !== null) {
    const others = Object.keys(HARNESS_COMMANDS).filter((h) => h !== resuming.harness);
    return [
      {
        harness: null,
        label: resuming.harness,
        hint: "same harness — native resume, conversation intact",
      },
      ...others.map(
        (harness): HarnessItem => ({
          harness,
          label: harness,
          hint:
            harness === "shell"
              ? "a bash in the worktree — resume either agent from inside"
              : "the conversation crosses as a distilled prompt",
        }),
      ),
    ];
  }
  return Object.keys(HARNESS_COMMANDS).map(
    (harness): HarnessItem => ({
      harness,
      label: harness,
      hint:
        harness === "shell"
          ? "a plain bash session — new worktree, recorded"
          : `mend ${harness} — new worktree, recorded session`,
    }),
  );
};

/**
 * A conversation's own name: the label it was given, else the harness and the
 * short session id. The machine id is the fallback, never the headline.
 */
export const sessionDisplayName = (session: SessionDto): string => {
  if (session.label !== null && session.label !== "") return session.label;
  if (isPendingId(session.id)) return `${session.harness} · starting`;
  return `${session.harness} ${session.id.slice(0, 8)}`;
};

/** What the worktree forked from, as a word: its base ref, else the base sha. */
export const groupBaseLabel = (group: WorktreeGroup): string => {
  if (group.baseRef !== null && group.baseRef !== "") return group.baseRef;
  const sha = group.sessions[0]?.session.baseSha ?? "";
  return sha === "" ? "base unknown" : sha.slice(0, 7);
};

/** When this worktree last saw a conversation start — its activity fact. */
export const groupActivityAt = (group: WorktreeGroup): string =>
  group.sessions.reduce(
    (newest, item) => (item.session.createdAt > newest ? item.session.createdAt : newest),
    group.createdAt,
  );

/** The worktree's folded status word: waiting wins, then running, then idle. */
export const foldGroupStatus = (group: WorktreeGroup): string => {
  const statuses = group.sessions.map((item) => item.session.status);
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("running") || statuses.includes("starting")) return "running";
  if (statuses.includes("idle")) return "idle";
  return statuses[0] ?? "idle";
};

// ─── attach + verb helpers ──────────────────────────────────────────────────

/**
 * Where "get me in" should land when the session has no live agent terminal:
 * the newest LIVE shell, so repeated attaches rejoin the same one instead of
 * stacking a fresh bash per attempt (the five-orphan-shells failure mode).
 * Null = nothing attachable; opening a new shell is then honest.
 */
export const liveShellOf = (
  processes: ReadonlyArray<SessionProcessDto>,
): SessionProcessDto | null =>
  processes.findLast((process) => process.kind === "shell" && process.exitedAt === null) ?? null;

/**
 * The session's live protocol agent — a phone pickup driving the same
 * conversation over stream-json. It holds the workspace with no PTY behind it,
 * so a terminal "get me in" must take it over (hand back to a TUI) rather than
 * report the attach unavailable or open a bare shell. Null = no pickup to take.
 */
export const liveProtocolOf = (
  processes: ReadonlyArray<SessionProcessDto>,
): SessionProcessDto | null =>
  processes.find((process) => process.kind === "agent-protocol" && process.exitedAt === null) ??
  null;

/**
 * What `a` — attach — may do with the selected conversation. Attach takes the
 * terminal's write authority, so it is only ever offered for a session that is
 * already live: a settled one is reported settled and left alone. Attach NEVER
 * resumes; `r` is the verb that brings a settled session back, and keeping the
 * two apart is why a held `a` can no longer wake a finished session by accident.
 * A `starting` row has no PTY yet — attaching would suspend the dashboard, be
 * refused, and bounce straight back.
 */
export type AttachPlan =
  | { readonly kind: "attach"; readonly session: SessionDto }
  | { readonly kind: "starting"; readonly session: SessionDto }
  | { readonly kind: "settled"; readonly session: SessionDto }
  | { readonly kind: "pending"; readonly session: SessionDto }
  | { readonly kind: "none" };

export const planAttach = (session: SessionDto | null): AttachPlan => {
  if (session === null) return { kind: "none" };
  if (isPendingId(session.id)) return { kind: "pending", session };
  if (!LIVE_STATUSES.has(session.status)) return { kind: "settled", session };
  if (session.status === "starting") return { kind: "starting", session };
  return { kind: "attach", session };
};

/**
 * What `r` — resume — may do with the selected conversation: only a settled
 * session can be resumed, and a live one is reported live rather than being
 * restarted underneath the agent still working in it.
 */
export type ResumePlan =
  | { readonly kind: "resume"; readonly session: SessionDto }
  | { readonly kind: "live"; readonly session: SessionDto }
  | { readonly kind: "pending"; readonly session: SessionDto }
  | { readonly kind: "none" };

export const planResume = (session: SessionDto | null): ResumePlan => {
  if (session === null) return { kind: "none" };
  if (isPendingId(session.id)) return { kind: "pending", session };
  if (LIVE_STATUSES.has(session.status)) return { kind: "live", session };
  return { kind: "resume", session };
};

/**
 * The one-at-a-time guard for the verbs that start work. A key repeat, or a
 * second press while the server is still answering, must not provision a
 * second workspace: the gate is taken SYNCHRONOUSLY in the key handler, before
 * any await or state update, and released when the request settles. React
 * state would be too late — it lands a paint after the second keystroke.
 */
export interface LaunchGate {
  /** True when the caller now holds `key`; false when somebody already does. */
  readonly take: (key: string) => boolean;
  readonly release: (key: string) => void;
  readonly held: (key: string) => boolean;
  /** How many starts are in flight — the chrome says so. */
  readonly count: () => number;
}

export const createLaunchGate = (): LaunchGate => {
  const taken = new Set<string>();
  return {
    take: (key) => {
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    },
    release: (key) => {
      taken.delete(key);
    },
    held: (key) => taken.has(key),
    count: () => taken.size,
  };
};

/**
 * The optimistic stop: the row settles AND its live process/service fact
 * lines drop in the same paint — the server's refetch only confirms.
 */
export const markSessionStopped = (data: Workbench, sessionId: string): Workbench => {
  const processesBySession = new Map(data.processesBySession);
  processesBySession.delete(sessionId);
  // A stop ends the agent and leaves Services running: their rows stay until their own stop.
  return {
    ...mapWorkbenchSessions(data, (session) =>
      session.id === sessionId ? { ...session, status: "stopped" } : session,
    ),
    processesBySession,
  };
};

/** The optimistic Stop services: the session's Service rows leave before the server answers. */
export const markServicesStopped = (data: Workbench, sessionId: string): Workbench => {
  const servicesBySession = new Map(data.servicesBySession);
  servicesBySession.delete(sessionId);
  return { ...data, servicesBySession };
};

/** Statuses only a live agent (or a launch about to have one) produces. */
const AGENT_WORKING: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

/**
 * What the conversation reads once its agent is no longer live while its Services keep the
 * workspace up — `agent stopped · 3 services keep the workspace up` — else null. A stop leaves
 * Services running, so the status word alone would hide a workspace that is still up.
 */
export const sessionHold = (item: SessionItem): string | null => {
  const agent = item.annotation?.currentAgent ?? null;
  const agentProcessLive = item.processes.some(
    (process) => process.kind !== "shell" && process.exitedAt === null,
  );
  return servicesHoldLine({
    agentLive:
      agent === null
        ? agentProcessLive || AGENT_WORKING.has(item.session.status)
        : agentIsLive(item.session, agent),
    agentOutcome: agentOutcome(agent),
    liveServices: Math.max(item.annotation?.liveServices ?? 0, item.services.length),
  });
};

/** The optimistic removal: the whole group leaves the list before the server answers. */
export const removeWorktreeGroup = (
  data: Workbench,
  projectId: string,
  group: WorktreeGroup,
): Workbench => {
  const memberIds = new Set(group.sessions.map((item) => item.session.id));
  const detail = data.details.get(projectId);
  if (detail === undefined) return data;
  const details = new Map(data.details);
  details.set(projectId, {
    ...detail,
    sessions: detail.sessions.filter((session) => !memberIds.has(session.id)),
    ...(detail.worktrees === undefined
      ? {}
      : { worktrees: detail.worktrees.filter((worktree) => worktree.id !== group.id) }),
  });
  return { ...data, details };
};

// ─── the base picker ────────────────────────────────────────────────────────

export interface BranchDto {
  readonly name: string;
  readonly sha: string;
  readonly committedAt: string;
  readonly isDefault: boolean;
}

/**
 * Subsequence fuzzy score, fzf-flavored: every query character must appear in
 * order; consecutive hits and segment starts (after `/`, `-`, `_`, `.`) score
 * higher; earlier matches beat later ones. Null = no match. Case-insensitive.
 */
export const fuzzyScore = (query: string, candidate: string): number | null => {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let last = -1;
  for (const char of q) {
    const at = c.indexOf(char, last + 1);
    if (at === -1) return null;
    if (at === last + 1) score += 3;
    else if (at === 0 || "/-_.".includes(c[at - 1] ?? "")) score += 2;
    else score += 1;
    score -= (at - last - 1) * 0.01;
    last = at;
  }
  return score;
};

/**
 * The picker's rows for one query: fuzzy-filtered, best score first, ties by
 * most recent commit; an empty query lists everything, default branch on top.
 */
export const filterBranches = (
  branches: ReadonlyArray<BranchDto>,
  query: string,
): ReadonlyArray<BranchDto> => {
  const scored = branches.flatMap((branch) => {
    const score = fuzzyScore(query, branch.name);
    return score === null ? [] : [{ branch, score }];
  });
  return scored
    .toSorted((a, b) => {
      if (query === "" && a.branch.isDefault !== b.branch.isDefault) {
        return a.branch.isDefault ? -1 : 1;
      }
      if (a.score !== b.score) return b.score - a.score;
      return b.branch.committedAt.localeCompare(a.branch.committedAt);
    })
    .map((entry) => entry.branch);
};

/** The creation modal's state: one record, three visible steps. */
export interface CreatingState {
  readonly projectId: string;
  readonly step: "name" | "base" | "harness";
  readonly name: string;
  /** Null while the fetch is in flight — it starts when the modal opens. */
  readonly branches: ReadonlyArray<BranchDto> | null;
  /**
   * The branch lookup's own failure, in the user's words. A request error is
   * NEVER folded into an empty list: "this repository has no other branches"
   * and "Mend could not read them" are different facts and the modal says which.
   */
  readonly branchError: string | null;
  readonly query: string;
  readonly baseIndex: number;
  /** Chosen base (null = the default branch). */
  readonly base: string | null;
  /** The name joins an existing worktree — base is fixed, step skipped. */
  readonly joins: boolean;
  readonly harnessIndex: number;
}

/**
 * What the base step has to say about its list right now — loading, the error
 * that stopped it, or genuine emptiness. Null = the list speaks for itself.
 */
export const baseStepNotice = (state: CreatingState): string | null => {
  if (state.branchError !== null) {
    return `branches unreadable — ${state.branchError} · enter uses the default`;
  }
  if (state.branches === null) return "reading branches…";
  if (state.branches.length === 0) return "no branches read — enter uses the default branch";
  if (filterBranches(state.branches, state.query).length === 0) {
    return "no branch matches — enter uses the default branch";
  }
  return null;
};

/** Commit the base step: the highlighted branch (default branch = null base). */
export const advanceFromBase = (current: CreatingState): CreatingState => {
  const chosen = filterBranches(current.branches ?? [], current.query)[current.baseIndex];
  return {
    ...current,
    base: chosen === undefined || chosen.isDefault ? null : chosen.name,
    step: "harness",
  };
};

// ─── the layout: a stacked nav sidebar beside the session pane ──────────────

/**
 * The four panes, and also the drill-down order: a project holds worktrees, a
 * worktree holds sessions, a session has a detail. Selecting in one
 * re-populates the ones below it.
 */
export type Column = "projects" | "worktrees" | "sessions" | "detail";

export const COLUMNS: ReadonlyArray<Column> = ["projects", "worktrees", "sessions", "detail"];

/** The three navigation panes — stacked in the sidebar, top to bottom. */
export type NavSection = "projects" | "worktrees" | "sessions";

export const NAV_SECTIONS: ReadonlyArray<NavSection> = ["projects", "worktrees", "sessions"];

export const isNavSection = (column: Column): column is NavSection => column !== "detail";

/**
 * Which nav section stands open. The detail pane is not a nav section, so
 * reading a record leaves the sidebar exactly as it was — sessions by default.
 */
const expandedSection = (focus: Column, lastNav: NavSection): NavSection =>
  isNavSection(focus) ? focus : lastNav;

/** The session pane is the work; the sidebar is how you point at it. */
const SIDEBAR_SHARE = 0.25;
/** Below this the sidebar stops being a list and starts being a rumour. */
const MIN_SIDEBAR_WIDTH = 24;
/** A record pane narrower than this wraps every line into noise. */
const MIN_DETAIL_WIDTH = 48;
/** Under this total width nothing sits side by side: one pane owns the screen. */
const SPLIT_MIN_WIDTH = MIN_SIDEBAR_WIDTH + MIN_DETAIL_WIDTH;
/** Two border rows and one row of content — the least a drawn pane can be. */
const MIN_SECTION_HEIGHT = 3;
/** Header, status and footer: the rows the body never gets. */
const CHROME_ROWS = 3;

export interface SectionLayout {
  readonly section: NavSection;
  /** The open section shows its list; the others show one summary line. */
  readonly expanded: boolean;
  /** Outer rows, the two border rows included. */
  readonly height: number;
  /** Rows the list itself gets. */
  readonly rows: number;
}

export interface DashboardLayout {
  /** Sidebar and session pane side by side; false = one pane owns the screen. */
  readonly split: boolean;
  /** Outer width of the stacked sidebar; 0 when it is off screen. */
  readonly sidebarWidth: number;
  /** The stacked sections, top to bottom; empty when the session pane owns the screen. */
  readonly sections: ReadonlyArray<SectionLayout>;
  /** Inner width and rows of the session pane; 0 when it is off screen. */
  readonly detailWidth: number;
  readonly detailRows: number;
  /** The panes that did not fit — the breadcrumb states their selection. */
  readonly offscreen: ReadonlyArray<Column>;
  /** Whether a breadcrumb row was drawn; a terminal too short spends it on the pane. */
  readonly breadcrumb: boolean;
}

/**
 * Stack the sections: the open one takes everything the two summaries leave.
 * Too short for three drawn panes and the open one takes the sidebar alone —
 * three two-row lists nobody can navigate is the worse answer.
 */
const stackSections = (body: number, open: NavSection): ReadonlyArray<SectionLayout> => {
  const room = body - (NAV_SECTIONS.length - 1) * MIN_SECTION_HEIGHT;
  if (room < MIN_SECTION_HEIGHT) {
    const height = Math.max(MIN_SECTION_HEIGHT, body);
    return [{ section: open, expanded: true, height, rows: height - 2 }];
  }
  return NAV_SECTIONS.map((section) =>
    section === open
      ? { section, expanded: true, height: room, rows: room - 2 }
      : { section, expanded: false, height: MIN_SECTION_HEIGHT, rows: 1 },
  );
};

/**
 * Where every pane sits. The session pane is the screen — three quarters of a
 * usable terminal — and the sidebar is the quarter that points at it: projects,
 * worktrees and sessions stacked, the focused one open and the other two folded
 * to the line that says what is selected. A terminal too narrow for both gives
 * the whole width to the side the keyboard is on, and the breadcrumb states the
 * rest; a terminal too short for three drawn panes shows the open one alone.
 */
export const planLayout = (
  width: number,
  height: number,
  focus: Column,
  lastNav: NavSection,
): DashboardLayout => {
  const split = width >= SPLIT_MIN_WIDTH;
  const navVisible = split || isNavSection(focus);
  const sidebarOuter = split
    ? Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(width - MIN_DETAIL_WIDTH, Math.round(width * SIDEBAR_SHARE)),
      )
    : navVisible
      ? Math.max(4, width)
      : 0;
  const detailOuter = split ? width - sidebarOuter : navVisible ? 0 : Math.max(4, width);
  const build = (body: number, breadcrumb: boolean): DashboardLayout => {
    const sections = navVisible ? stackSections(body, expandedSection(focus, lastNav)) : [];
    const shown = new Set<Column>(sections.map((section) => section.section));
    if (detailOuter > 0) shown.add("detail");
    return {
      split,
      sidebarWidth: navVisible ? sidebarOuter : 0,
      sections,
      detailWidth: detailOuter === 0 ? 0 : Math.max(1, detailOuter - 2),
      detailRows: detailOuter === 0 ? 0 : Math.max(1, body - 2),
      offscreen: COLUMNS.filter((column) => !shown.has(column)),
      breadcrumb,
    };
  };
  const body = Math.max(MIN_SECTION_HEIGHT, height - CHROME_ROWS);
  const full = build(body, false);
  if (full.offscreen.length === 0) return full;
  // A breadcrumb is a row like any other, and the body pays for it — but only
  // while the body can still draw a pane. On a terminal that short, the pane wins.
  return body - 1 >= MIN_SECTION_HEIGHT ? build(body - 1, true) : full;
};

/**
 * Move through the hierarchy. Every destination is reachable — planLayout
 * opens whatever the focus lands on; only the endpoints stop a step.
 */
export const stepColumn = (focus: Column, delta: number): Column => {
  const at = COLUMNS.indexOf(focus);
  if (at === -1) return "sessions";
  return COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, at + delta))] ?? focus;
};

/**
 * The hints that FIT, joined: a key footer or a row's fact line cut mid-word is
 * one nobody trusts. Hints are ordered most-essential first and drop from the
 * end; an ellipsis then says there is more (the full list is `mend help ui`).
 */
export const fitHints = (hints: ReadonlyArray<string>, width: number): string => {
  const kept: Array<string> = [];
  for (const hint of hints) {
    const candidate = [...kept, hint].join(" · ");
    const wouldTruncate = kept.length + 1 < hints.length;
    if (candidate.length + (wouldTruncate ? 2 : 0) > width) break;
    kept.push(hint);
  }
  if (kept.length === hints.length) return kept.join(" · ");
  return kept.length === 0 ? "…" : `${kept.join(" · ")} …`;
};

/** Keep a list index inside its list after the list itself changed under it. */
export const clampIndex = (length: number, index: number): number =>
  length === 0 ? 0 : Math.max(0, Math.min(length - 1, index));

// ─── the keymap: one table, so the footer cannot drift from the handler ─────

/**
 * Every verb the dashboard's base layer answers to. Modal layers (the harness
 * picker, the creation modal, the adopt offer, the label input) own the
 * keyboard while they are open and are not described here.
 */
export type DashboardVerb =
  | "quit"
  | "moveUp"
  | "moveDown"
  | "pageUp"
  | "pageDown"
  | "columnLeft"
  | "columnRight"
  | "attach"
  | "resume"
  | "newSession"
  | "newWorktree"
  | "rename"
  | "openWeb"
  | "review"
  | "stop"
  | "remove"
  | "refresh";

export interface KeyBinding {
  readonly verb: DashboardVerb;
  /** opentui key names this binding answers to. */
  readonly keys: ReadonlyArray<string>;
  /** Whether shift must be held; "any" when the key already encodes it. */
  readonly shift: boolean | "any";
  /**
   * How the footer names this verb, per column. A verb with no entry for a
   * column still works there — it is simply not worth a line of help.
   */
  readonly hints: Partial<Record<Column, string>>;
}

/**
 * The keymap AND the on-screen help, in one table and in footer order (most
 * essential first, because a narrow footer drops from the end). Nothing else
 * in the dashboard may bind a base-layer key: a binding the footer never
 * names, or help naming a key nothing answers to, is the drift this table
 * exists to make impossible — and `dashboard-model.test.ts` proves it.
 */
export const KEY_BINDINGS: ReadonlyArray<KeyBinding> = [
  {
    verb: "moveUp",
    keys: ["up", "k"],
    shift: false,
    hints: {
      projects: "↑↓ move",
      worktrees: "↑↓ move",
      sessions: "↑↓ move",
      detail: "↑↓ scroll",
    },
  },
  { verb: "moveDown", keys: ["down", "j"], shift: false, hints: {} },
  { verb: "pageUp", keys: ["pageup"], shift: false, hints: {} },
  { verb: "pageDown", keys: ["pagedown"], shift: false, hints: {} },
  {
    verb: "columnRight",
    keys: ["return", "linefeed", "l", "right", "tab"],
    shift: false,
    hints: { projects: "→ worktrees", worktrees: "←→ panes", sessions: "←→ panes" },
  },
  {
    verb: "columnLeft",
    keys: ["left", "h", "-", "backspace"],
    shift: false,
    hints: { detail: "← sessions" },
  },
  { verb: "columnLeft", keys: ["backtab"], shift: "any", hints: {} },
  { verb: "columnLeft", keys: ["tab"], shift: true, hints: {} },
  {
    verb: "attach",
    keys: ["a"],
    shift: false,
    hints: { worktrees: "a attach", sessions: "a attach", detail: "a attach" },
  },
  {
    verb: "resume",
    keys: ["r"],
    shift: false,
    hints: { worktrees: "r resume", sessions: "r resume", detail: "r resume" },
  },
  {
    verb: "newSession",
    keys: ["n"],
    shift: false,
    hints: {
      projects: "n/w new worktree",
      worktrees: "n new session",
      sessions: "n new session",
    },
  },
  {
    verb: "newWorktree",
    keys: ["w"],
    shift: false,
    hints: { worktrees: "w new worktree", sessions: "w new worktree" },
  },
  {
    verb: "stop",
    keys: ["k"],
    shift: true,
    hints: { worktrees: "⇧K stop all", sessions: "⇧K stop" },
  },
  { verb: "stop", keys: ["x"], shift: false, hints: {} },
  {
    verb: "remove",
    keys: ["d"],
    shift: true,
    hints: { worktrees: "⇧D remove worktree", sessions: "⇧D remove" },
  },
  {
    verb: "review",
    keys: ["v"],
    shift: false,
    hints: { worktrees: "v review", sessions: "v review", detail: "v review" },
  },
  {
    verb: "rename",
    keys: ["e"],
    shift: false,
    hints: { sessions: "e rename", detail: "e rename" },
  },
  { verb: "openWeb", keys: ["o"], shift: false, hints: { sessions: "o web", detail: "o web" } },
  {
    verb: "refresh",
    keys: ["r"],
    shift: true,
    hints: { projects: "⇧R refresh", worktrees: "⇧R refresh", detail: "⇧R refresh" },
  },
  {
    verb: "quit",
    keys: ["q"],
    shift: false,
    hints: { projects: "q quit", worktrees: "q quit", sessions: "q quit", detail: "q quit" },
  },
];

/** The verb a keystroke means in the base layer; null = the dashboard ignores it. */
export const verbForKey = (name: string, shift: boolean): DashboardVerb | null =>
  KEY_BINDINGS.find(
    (binding) =>
      binding.keys.includes(name) && (binding.shift === "any" || binding.shift === shift),
  )?.verb ?? null;

/** The footer's hints for one column, most essential first. */
export const verbHints = (focus: Column): ReadonlyArray<string> =>
  KEY_BINDINGS.flatMap((binding) => {
    const hint = binding.hints[focus];
    return hint === undefined ? [] : [hint];
  });
