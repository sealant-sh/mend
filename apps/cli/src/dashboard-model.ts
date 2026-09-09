import { HARNESS_COMMANDS, LIVE_STATUSES } from "./shared.ts";

/**
 * The dashboard's pure data layer: DTOs as the server sends them, the
 * worktree grouping (real containers on a worktree-aware server, one pseudo
 * group per session on an older one), and the flat walkable row list the
 * keyboard moves over. No rendering, no opentui — testable on any Node.
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
export interface WorkbenchApi {
  <T>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T>;
}

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
  if (detail.worktrees !== undefined) {
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
  } else {
    for (const session of sorted) groups.push(pseudoGroup(session, item));
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

/**
 * The flat walkable row list: every worktree is a header row with its session
 * children indented underneath, one session or many — a row always says what
 * it is, so ⇧D on it removes what it names. Process/service lines stay facts,
 * never targets.
 */
export type SelectableRow =
  | { readonly kind: "worktree"; readonly group: WorktreeGroup }
  | { readonly kind: "session"; readonly group: WorktreeGroup; readonly item: SessionItem };

export const deriveRows = (groups: ReadonlyArray<WorktreeGroup>): ReadonlyArray<SelectableRow> =>
  groups.flatMap(
    (group): ReadonlyArray<SelectableRow> => [
      { kind: "worktree", group },
      ...group.sessions.map((item): SelectableRow => ({ kind: "session", group, item })),
    ],
  );

export const rowKeyOf = (row: SelectableRow): string =>
  row.kind === "worktree" ? `wt:${row.group.key}` : `s:${row.item.session.id}`;

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
 * What Enter means for a set of conversations (a session row, or every
 * member of a worktree header): `attach` the newest live one, `wait` because
 * the only live one is still starting, or `none` — nothing live, open the
 * picker. A `starting` row is a launch in flight: the workspace is still
 * booting and has no PTY yet, so attaching would suspend the dashboard, be
 * refused, and bounce straight back — once per Enter when the key is held.
 */
export type EnterTarget =
  | { readonly kind: "attach"; readonly session: SessionDto }
  | { readonly kind: "wait"; readonly session: SessionDto }
  | { readonly kind: "none" };

export const enterTargetOf = (sessions: ReadonlyArray<SessionDto>): EnterTarget => {
  const live = sessions.filter((session) => LIVE_STATUSES.has(session.status));
  const attachable = live.find((session) => session.status !== "starting");
  if (attachable !== undefined) return { kind: "attach", session: attachable };
  const starting = live[0];
  return starting === undefined ? { kind: "none" } : { kind: "wait", session: starting };
};

/**
 * The optimistic stop: the row settles AND its live process/service fact
 * lines drop in the same paint — the server's refetch only confirms.
 */
export const markSessionStopped = (data: Workbench, sessionId: string): Workbench => {
  const processesBySession = new Map(data.processesBySession);
  processesBySession.delete(sessionId);
  const servicesBySession = new Map(data.servicesBySession);
  servicesBySession.delete(sessionId);
  return {
    ...mapWorkbenchSessions(data, (session) =>
      session.id === sessionId ? { ...session, status: "stopped" } : session,
    ),
    processesBySession,
    servicesBySession,
  };
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
  readonly query: string;
  readonly baseIndex: number;
  /** Chosen base (null = the default branch). */
  readonly base: string | null;
  /** The name joins an existing worktree — base is fixed, step skipped. */
  readonly joins: boolean;
  readonly harnessIndex: number;
}

/** Commit the base step: the highlighted branch (default branch = null base). */
export const advanceFromBase = (current: CreatingState): CreatingState => {
  const chosen = filterBranches(current.branches ?? [], current.query)[current.baseIndex];
  return {
    ...current,
    base: chosen === undefined || chosen.isDefault ? null : chosen.name,
    step: "harness",
  };
};
