/**
 * The workbench API as the cockpit reads it. Wire shapes are the server's
 * DTOs, minimally (the authoritative schemas live in @mend/api's contract —
 * the client reads, it does not re-validate). Every call rides the preload
 * bridge: main holds the URL and the bearer, this module holds the paths.
 */

export type SessionStatusDto =
  | "starting"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export const LIVE_STATUSES: ReadonlySet<SessionStatusDto> = new Set<SessionStatusDto>([
  "starting",
  "running",
  "waiting",
  "idle",
]);

/** Only what the client needs: the login shell a family image bakes. */
export interface WorkspaceImageDto {
  readonly mode: string;
  readonly shell?: string;
}

export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly adoptedSha: string | null;
  readonly workspaceImage: WorkspaceImageDto | null;
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

export interface SessionDto {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  readonly harness: string;
  readonly label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly sealantRunId: string | null;
  readonly sealantSessionId: string | null;
  readonly status: SessionStatusDto;
  readonly summary: string | null;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly createdAt: string;
}

/** List decoration for one session — DB-cheap review facts, no git involved. */
export interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly changeId: string | null;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
  /** The session's current agent process; null before the first launch. */
  readonly currentAgent: SessionProcessDto | null;
}

export interface ProjectDetailDto {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
  readonly annotations: ReadonlyArray<SessionAnnotationDto>;
  /** Present when the server is worktree-aware — the capability signal. */
  readonly worktrees?: ReadonlyArray<WorktreeDto>;
}

export interface CheckpointDto {
  readonly id: string;
  readonly sessionId: string;
  readonly ref: string;
  readonly sha: string;
  /** The coding-agent record active when this checkpoint was observed. */
  readonly sealantRunId: string | null;
  /** Record sequence at the checkpoint — bigint on the wire, string here. */
  readonly seq: string;
  readonly trigger: string;
  readonly createdAt: string;
}

export interface SessionChangeDto {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string | null;
}

export interface SessionDetailDto {
  readonly session: SessionDto;
  readonly checkpoints: ReadonlyArray<CheckpointDto>;
  readonly change: SessionChangeDto | null;
  /** Every process the session has held, oldest first. */
  readonly processes: ReadonlyArray<SessionProcessDto>;
  /** The agent process "the session's agent" means right now; null before the first launch. */
  readonly currentAgent: SessionProcessDto | null;
}

export interface ReviewSliceDto {
  readonly id: string;
  readonly changeId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly createdAt: string;
}

export interface OpenReviewDto {
  readonly slice: ReviewSliceDto;
  readonly checkpointA: CheckpointDto;
  readonly checkpointB: CheckpointDto;
  readonly reused: boolean;
}

export interface ReviewDiffHunkDto {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextHash: string;
  readonly patch: string;
}

export interface ReviewDiffFileDto {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type-changed"
    | "unmerged"
    | "unknown";
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly patch: string;
  readonly hunks: ReadonlyArray<ReviewDiffHunkDto>;
}

export interface ReviewDiffDto {
  readonly change: SessionChangeDto;
  readonly slice: ReviewSliceDto;
  readonly checkpointA: CheckpointDto;
  readonly checkpointB: CheckpointDto;
  readonly patch: string;
  readonly files: ReadonlyArray<ReviewDiffFileDto>;
  readonly anchorFiles: ReadonlyArray<ReviewDiffFileDto>;
  readonly worktreeChangedSinceSnapshot: boolean;
}

export interface RecordLinkDto {
  readonly sealantRunId: string;
  readonly sequence: string;
  readonly excerpt: string;
}

export interface ReviewCommentAnchorDto {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "old" | "new" | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
  readonly mapping: "anchored" | "moved" | "not-found";
}

export interface ReviewCommentDto {
  readonly id: string;
  readonly changeId: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly anchor: ReviewCommentAnchorDto | null;
  readonly authorKind: "reviewer" | "mend";
  readonly authorName: string;
  readonly body: string;
  readonly kind: "note" | "suggestion";
  readonly suggestion: string | null;
  readonly state: "draft" | "open" | "addressed" | "dismissed";
  readonly evidence: ReadonlyArray<RecordLinkDto>;
  readonly sentToSessionId: string | null;
  readonly createdAt: string;
}

export interface SliceCommentTargetDto {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "old" | "new" | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
}

export interface FollowUpDto {
  readonly id: string;
  readonly sessionId: string;
  readonly changeId: string;
  readonly reviewSliceId: string | null;
  readonly checkpointAId: string | null;
  readonly checkpointBId: string | null;
  readonly diffDigest: string | null;
  readonly commentIds: ReadonlyArray<string>;
  readonly idempotencyKey: string | null;
  readonly instruction: string;
  readonly status: "pending" | "delivering" | "delivered" | "delivery_failed" | "superseded";
  readonly deliveryProcessId: string | null;
  readonly deliverySealantRunId: string | null;
  readonly deliveryError: string | null;
  readonly deliveryStartedAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface DeliverFollowUpInput {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string;
}

/** `agent-protocol` is reserved — nothing launches one yet. `agent-external` is an agent Mend observed but did not launch (run by hand in a shell/SSH/editor terminal); it has no PTY to attach. */
export type SessionProcessKind =
  | "shell"
  | "agent-pty"
  | "agent-protocol"
  | "agent-external"
  | "service";

export const isAgentProcessKind = (kind: SessionProcessKind): boolean =>
  kind === "agent-pty" || kind === "agent-protocol" || kind === "agent-external";

/** Observed lifecycle only — never a judgment about the work. */
export type SessionProcessStatus =
  | "starting"
  | "running"
  | "reachable"
  | "unreachable"
  | "exited"
  | "stopped";

/** One workspace process — agent, shell, or Service (docs/SESSION-SERVICES.md). */
export interface SessionProcessDto {
  readonly id: string;
  readonly sessionId: string;
  readonly serviceId: string | null;
  readonly attemptOrdinal: number | null;
  readonly launchCorrelationId: string | null;
  readonly sealantWorkspaceId: string;
  readonly sealantSessionId: string | null;
  readonly sealantRunId: string | null;
  readonly kind: SessionProcessKind;
  /** Agent processes: `codex` · `claude` · `opencode` · `shell`; null for shells and Services. */
  readonly harness: string | null;
  /** Agent processes: the harness's own session id once harvested. */
  readonly providerSessionId: string | null;
  readonly label: string | null;
  readonly argv: ReadonlyArray<string>;
  readonly status: SessionProcessStatus;
  readonly exitCode: number | null;
  readonly workspacePort: number | null;
  readonly protocol: "tcp" | "udp";
  readonly hostPort: number | null;
  readonly createdAt: string;
  readonly exitedAt: string | null;
  readonly updatedAt: string;
}

export const LIVE_PROCESS: ReadonlySet<SessionProcessStatus> = new Set<SessionProcessStatus>([
  "starting",
  "running",
  "reachable",
  "unreachable",
]);

export const isLiveProcess = (process: SessionProcessDto): boolean =>
  process.exitedAt === null && LIVE_PROCESS.has(process.status);

/** The newest live agent process, else the newest ever — what "the agent" means for a session. */
export const currentAgentProcess = (
  processes: ReadonlyArray<SessionProcessDto>,
): SessionProcessDto | null => {
  const agents = processes
    .filter((process) => isAgentProcessKind(process.kind))
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return agents.findLast(isLiveProcess) ?? agents.at(-1) ?? null;
};

/** What an ended agent process's exit says about the work; null while it runs. */
export const agentProcessOutcome = (
  process: SessionProcessDto,
): "completed" | "failed" | "stopped" | null => {
  if (process.exitedAt === null) return null;
  if (process.status === "stopped") return "stopped";
  if (process.harness === "shell") return "completed";
  return process.exitCode === null || process.exitCode === 0 ? "completed" : "failed";
};

/**
 * Whether the session's AGENT is live. Session status is a fold over every process (a session
 * reads `idle` while a shell holds the workspace after its agent ended), so the agent's own row
 * answers when one exists; `starting` is a launch with no row yet.
 */
export const agentIsLive = (session: SessionDto, currentAgent: SessionProcessDto | null): boolean =>
  currentAgent === null
    ? LIVE_STATUSES.has(session.status)
    : session.status === "starting" || isLiveProcess(currentAgent);

/**
 * The status and end time the inbox shows for a session: its own, except that an `idle` session
 * whose agent has ended reads as that agent's outcome — shells holding the workspace are you,
 * not the agent.
 */
export const sessionFace = (
  session: SessionDto,
  currentAgent: SessionProcessDto | null,
): { readonly status: SessionStatusDto; readonly endedAt: string | null } => {
  if (session.status === "idle" && currentAgent !== null) {
    const outcome = agentProcessOutcome(currentAgent);
    if (outcome !== null) return { status: outcome, endedAt: currentAgent.exitedAt };
  }
  return { status: session.status, endedAt: session.settledAt };
};

export interface ProcessLogPageDto {
  readonly processId: string;
  readonly sealantSessionId: string;
  readonly sealantRunId: string | null;
  readonly requestedFrom: string;
  readonly firstSequence: string | null;
  readonly lastSequence: string | null;
  readonly nextFrom: string;
  readonly status: "exited" | "failed" | "running" | "starting";
  readonly chunks: ReadonlyArray<{
    readonly sequence: string;
    readonly dataBase64: string;
  }>;
  readonly telemetryLoss: "unknown";
  readonly telemetryNote: string;
}

/** One conversation event of the session's durable record (GET /api/sessions/:id/transcript). */
export interface TranscriptEventDto {
  readonly kind: string;
  readonly text: string | null;
  readonly name: string | null;
  readonly command: string | null;
  readonly output: string | null;
}

export interface SessionTranscriptDto {
  readonly sourceHarness: string;
  readonly events: ReadonlyArray<TranscriptEventDto>;
}

export interface ServiceRecipeDto {
  readonly name: string;
  readonly command: string | null;
  readonly port: number;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
  readonly shadowedBy: "file" | "project" | null;
  readonly source: "file" | "project";
}

export interface ServiceEndpointDto {
  readonly address: string;
  readonly authority: string;
  readonly hostPort: number;
  readonly transport: "tcp" | "udp";
  readonly scope: "loopback" | "private";
  readonly browserUrl: string | null;
  readonly mendAuthentication: "none";
}

export interface ServiceViewDto {
  readonly service: {
    readonly id: string;
    readonly sessionId: string;
    readonly name: string;
    readonly declarationSource: string;
    readonly workspacePort: number;
    readonly transport: "tcp" | "udp";
    readonly browserScheme: "http" | "https" | null;
    readonly currentAttemptId: string | null;
    readonly currentForwardId: string | null;
    readonly attemptHistoryComplete: boolean;
  };
  readonly attempts: ReadonlyArray<SessionProcessDto>;
  readonly currentForward: {
    readonly id: string;
    readonly hostPort: number | null;
    readonly state: "binding" | "bound" | "closed" | "failed";
    readonly error: string | null;
  } | null;
  readonly previousForward: {
    readonly id: string;
    readonly hostPort: number | null;
    readonly state: "binding" | "bound" | "closed" | "failed";
    readonly error: string | null;
  } | null;
  readonly latestObservation: {
    readonly forwardId: string;
    readonly state: "reachable" | "unreachable";
    readonly source: "probe" | "connection" | "udp-reply" | "legacy";
    readonly error: string | null;
    readonly lastObservedAt: string;
  } | null;
  readonly workspaceExpiresAt: string | null;
  readonly workspaceTtlRenewedAt: string | null;
  readonly workspaceTtlRenewalFailedAt: string | null;
  readonly workspaceTtlRenewalError: string | null;
  readonly endpoints: ReadonlyArray<ServiceEndpointDto>;
  readonly previousEndpoints: ReadonlyArray<ServiceEndpointDto>;
}

/** A project's files, flat and sorted — from a session worktree or the default branch's tree. */
export interface ProjectFileListingDto {
  readonly source: "worktree" | "branch";
  readonly label: string;
  readonly rootPath: string | null;
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

/** One pull request as gh reported it — a reference attached to work, never its identity. */
export interface PullRequestViewDto {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly author: string | null;
  readonly reviewDecision: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
}

export type PullRequestAvailability =
  | "ok"
  | "no-origin"
  | "not-github"
  | "gh-missing"
  | "gh-signed-out"
  | "no-identity"
  | "rate-limited"
  | "error";

export interface ProjectPullRequestsDto {
  readonly origin: "none" | "not-github" | "github";
  readonly repo: string | null;
  readonly availability: PullRequestAvailability;
  readonly detail: string | null;
  readonly pullRequests: ReadonlyArray<PullRequestViewDto>;
  readonly fetchedAt: string | null;
}

const decodeProcessLogChunks = (chunks: ReadonlyArray<{ readonly dataBase64: string }>): string => {
  const decoded = chunks.map((chunk) => atob(chunk.dataBase64));
  const byteLength = decoded.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of decoded) {
    for (let index = 0; index < chunk.length; index += 1) {
      bytes[offset + index] = chunk.charCodeAt(index);
    }
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
};

// ─── transport ──────────────────────────────────────────────────────────────

/** The server answered and said no — carries its own words when it gave any. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

/** Tagged errors the contract returns without a sentence of their own. */
const TAGGED: Readonly<Record<string, string>> = {
  SessionActive:
    "the session is still active — it has a live process (a supporting shell, a Service) or an unsettled status; stop those first",
  NotFound: "not found",
};

const describe = (body: unknown): string | null => {
  if (typeof body === "string" && body !== "") return body;
  if (typeof body === "object" && body !== null) {
    const record = body as {
      readonly message?: unknown;
      readonly error?: unknown;
      readonly _tag?: unknown;
    };
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record._tag === "string") return TAGGED[record._tag] ?? record._tag;
  }
  return null;
};

const request = async <A>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<A> => {
  const response = await window.mend.api.request(
    body === undefined ? { method, path } : { method, path, body },
  );
  if (!response.ok) {
    const detail = describe(response.body);
    throw new ApiError(
      response.status === 0
        ? (detail ?? "the Mend server did not answer")
        : `${method} ${path} responded ${response.status}${detail === null ? "" : ` — ${detail}`}`,
      response.status,
    );
  }
  // The bridge returns the decoded JSON; the DTO type is this module's claim.
  return response.body as A;
};

const get = <A>(path: string) => request<A>("GET", path);
const post = <A>(path: string, body: unknown) => request<A>("POST", path, body);
const del = <A>(path: string) => request<A>("DELETE", path);

// ─── the signed-in user's platform identity ─────────────────────────────────

export type ConnectedAccountProviderDto = "claude" | "codex" | "github";

/** A connected account as the platform reports it — never carries the secret. */
export interface ConnectedAccountDto {
  readonly id: string;
  readonly provider: ConnectedAccountProviderDto;
  readonly name: string;
  readonly kind: string;
  readonly status: "active" | "invalid" | "archived";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
}

export interface SealantIdentityDto {
  readonly sealantUserId: string;
  readonly accounts: ReadonlyArray<ConnectedAccountDto>;
}

export const getSealantIdentity = () => get<SealantIdentityDto>("/api/me/sealant");

/** Forwards the credential to the platform under the user's own identity; Mend keeps nothing. */
export const connectAccount = (input: {
  readonly provider: ConnectedAccountProviderDto;
  readonly secret: string;
}) => post<ConnectedAccountDto>("/api/me/sealant/accounts", input);

export const disconnectAccount = (id: string) =>
  del<ConnectedAccountDto>(`/api/me/sealant/accounts/${id}`);

// ─── reads ──────────────────────────────────────────────────────────────────

export const listProjects = () => get<ReadonlyArray<ProjectDto>>("/api/projects");

export const projectDetail = (id: string) => get<ProjectDetailDto>(`/api/projects/${id}`);

export const sessionDetail = (id: string) => get<SessionDetailDto>(`/api/sessions/${id}`);

export const listSessionProcesses = (id: string) =>
  get<ReadonlyArray<SessionProcessDto>>(`/api/sessions/${id}/processes`);

export const processLogPage = (
  id: string,
  options: { readonly from: string; readonly limit: string },
) => {
  const query = new URLSearchParams(options);
  return get<ProcessLogPageDto>(`/api/processes/${id}/logs?${query}`);
};

export const processOutput = async (id: string): Promise<{ readonly text: string }> => {
  const chunks: Array<{ readonly dataBase64: string }> = [];
  let from = "0";
  for (let pageNumber = 0; pageNumber < 128; pageNumber += 1) {
    const page = await processLogPage(id, { from, limit: "1000" });
    chunks.push(...page.chunks);
    if (page.chunks.length === 0 || page.nextFrom === from) {
      return { text: decodeProcessLogChunks(chunks) };
    }
    from = page.nextFrom;
  }
  throw new ApiError("process log snapshot exceeded 128 pages", 0);
};

/** The session's conversation, read from its record — what a settled session said and did. */
export const sessionTranscript = (id: string) =>
  get<SessionTranscriptDto>(`/api/sessions/${id}/transcript`);

export const reviewDiff = (
  changeId: string,
  sliceId: string,
  options: { readonly whitespace: "include" | "ignore"; readonly context: number },
) => {
  const query = new URLSearchParams({
    whitespace: options.whitespace,
    context: String(options.context),
  });
  return get<ReviewDiffDto>(`/api/changes/${changeId}/reviews/${sliceId}/diff?${query}`);
};

export const changeComments = (changeId: string) =>
  get<ReadonlyArray<ReviewCommentDto>>(`/api/changes/${changeId}/comments`);

/** `sessionId` roots the listing at that session's live worktree; null reads the default branch. */
export const projectFiles = (projectId: string, sessionId: string | null) =>
  get<ProjectFileListingDto>(
    sessionId === null
      ? `/api/projects/${projectId}/files`
      : `/api/projects/${projectId}/files?${new URLSearchParams({ session: sessionId })}`,
  );

export const projectPullRequests = (projectId: string) =>
  get<ProjectPullRequestsDto>(`/api/projects/${projectId}/pull-requests`);

export const listServices = () => get<ReadonlyArray<ServiceViewDto>>("/api/services?all=1");

export const listSessionRecipes = (sessionId: string) =>
  get<ReadonlyArray<ServiceRecipeDto>>(`/api/sessions/${sessionId}/recipes`);

// ─── writes ─────────────────────────────────────────────────────────────────

export const createSession = (
  projectId: string,
  harness: string,
  label: string | null,
  base: string | null = null,
  name: string | null = null,
) => post<SessionDto>(`/api/projects/${projectId}/sessions`, { harness, label, name, base });

/** An image stored beside the session; `path` is what the terminal pastes. */
export interface PastedImageDto {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export const pasteSessionImage = (sessionId: string, contentsBase64: string) =>
  post<PastedImageDto>(`/api/sessions/${sessionId}/images`, { contentsBase64 });

export const runServiceRecipe = (sessionId: string, name: string) =>
  post<ServiceViewDto>(`/api/sessions/${sessionId}/services/recipe`, { name });

export const runService = (
  sessionId: string,
  input: {
    readonly argv: ReadonlyArray<string>;
    readonly port: number;
    readonly name: string | null;
    readonly protocol: "tcp" | "udp";
    readonly browserScheme: "http" | "https" | null;
  },
) => post<ServiceViewDto>(`/api/sessions/${sessionId}/services/run`, input);

export const addService = (
  sessionId: string,
  input: {
    readonly port: number;
    readonly name: string | null;
    readonly protocol: "tcp" | "udp";
    readonly browserScheme: "http" | "https" | null;
  },
) => post<ServiceViewDto>(`/api/sessions/${sessionId}/services`, input);

export const restartService = (serviceId: string) =>
  post<ServiceViewDto>(`/api/services/${serviceId}/restart`, {});

export const stopService = (serviceId: string) =>
  post<ServiceViewDto>(`/api/services/${serviceId}/stop`, {});

/** Launch runs `argv` supervised in the session's fresh workspace. */
export const launchSession = (id: string, argv: ReadonlyArray<string>) =>
  post<SessionDto>(`/api/sessions/${id}/launch`, { argv });

/** A composed start — the server turns this into the harness's own argv. */
export interface LaunchStartDto {
  readonly prompt?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly speed?: string;
}

/** Launch with a structured start; the typed prompt opens the harness and seeds auto-naming. */
export const launchSessionStart = (id: string, start: LaunchStartDto) =>
  post<SessionDto>(`/api/sessions/${id}/launch`, start);

export const checkpointSession = (id: string, trigger: "review-open" | "user-mark") =>
  post<CheckpointDto>(`/api/sessions/${id}/checkpoints`, { trigger });

export const openReview = (changeId: string, idempotencyKey: string) =>
  post<OpenReviewDto>(`/api/changes/${changeId}/reviews/open`, { idempotencyKey });

export const postSliceReviewComment = (
  changeId: string,
  sliceId: string,
  target: SliceCommentTargetDto,
  body: string,
) =>
  post<ReviewCommentDto>(`/api/changes/${changeId}/reviews/${sliceId}/comments`, {
    target,
    body,
  });

export const setReviewCommentState = (
  changeId: string,
  commentId: string,
  state: "open" | "addressed" | "dismissed",
) => post<ReviewCommentDto>(`/api/changes/${changeId}/comments/${commentId}/state`, { state });

export const deliverFollowUp = (sessionId: string, input: DeliverFollowUpInput) =>
  post<FollowUpDto>(`/api/sessions/${sessionId}/follow-up/deliver`, input);

/** Open a supporting shell in the session's current reachable workspace. */
export const openShell = (id: string) => post<SessionProcessDto>(`/api/sessions/${id}/shell`, {});

/** Stop one supporting shell process group. Repeating a completed stop is safe. */
export const stopShell = (id: string) => post<SessionProcessDto>(`/api/processes/${id}/stop`, {});

/** Rename one live supporting shell. */
export const renameShell = (id: string, label: string) =>
  post<SessionProcessDto>(`/api/processes/${id}/label`, { label });

export const stopSession = (id: string) => post<SessionDto>(`/api/sessions/${id}/stop`, {});

/** The outcome of a destructive removal — what went, what would not delete. */
export interface RemovalReportDto {
  readonly removed: boolean;
  readonly leftover: string | null;
}

/**
 * Settled sessions only — a live one answers 409. Removes the conversation
 * record and its workspace ONLY; the worktree (change, checkpoints, review)
 * stands, removed by `removeWorktree`.
 */
export const removeSession = (id: string) =>
  request<RemovalReportDto>("DELETE", `/api/sessions/${id}`);

/**
 * The one explicit destructive act: the worktree goes with its sessions,
 * change, and review. Refused (409) while any conversation is live; a
 * standing unreviewed diff refuses (422) unless forced.
 */
export const removeWorktree = (id: string, force?: boolean) =>
  request<RemovalReportDto>("DELETE", `/api/worktrees/${id}${force === true ? "?force=true" : ""}`);

/** A new conversation inside an existing worktree; launching is separate. */
export const createSessionInWorktree = (id: string, harness: string) =>
  request<SessionDto>("POST", `/api/worktrees/${id}/sessions`, { harness, label: null });
