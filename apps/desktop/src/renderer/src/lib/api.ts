import type {
  ConnectedAccount,
  OpenReviewResult,
  PastedImage,
  ProcessLogPage,
  ProjectDetail,
  ProjectFileListing,
  ProjectPullRequests,
  PullRequestView,
  RemovalReport,
  ReviewDiffFileView,
  ReviewDiffHunkView,
  ReviewDiffView,
  SealantIdentity,
  SessionAnnotation,
  SessionControlView,
  SessionDetail,
  SessionTranscript,
  SliceCommentTargetRequest,
  TranscriptEvent,
} from "@mend/api-contracts";
import {
  isAgentProcessKind as isAgentKind,
  LIVE_PROCESS_STATUSES,
  type Change,
  type Checkpoint,
  type FollowUp,
  type Project,
  type RecordLink,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewSlice,
  type ServiceEndpoint,
  type ServiceRecipe,
  type ServiceView,
  type Session,
  type SessionProcess,
  type Worktree,
} from "@mend/domain/workbench";

import {
  fillPath,
  type Answer,
  type InputArgs,
  type Method,
  type PathOf,
  type Payload,
  rawInput,
  type Wire,
} from "#/lib/contract";

/**
 * The workbench API as the cockpit reads it. Every shape here is the contract's
 * (`@mend/api-contracts`, `@mend/domain/workbench`) as JSON carries it — see
 * `lib/contract.ts`; nothing is hand-written. Every call rides the preload
 * bridge: main holds the URL and the bearer, this module holds the paths.
 */

// ─── wire shapes ────────────────────────────────────────────────────────────

export type ProjectDto = Wire<Project>;
export type WorktreeDto = Wire<Worktree>;
export type SessionDto = Wire<Session>;
export type SessionStatusDto = SessionDto["status"];
/** List decoration for one session — DB-cheap review facts, no git involved. */
export type SessionAnnotationDto = Wire<SessionAnnotation>;
export type ProjectDetailDto = Wire<ProjectDetail>;
export type CheckpointDto = Wire<Checkpoint>;
export type SessionChangeDto = Wire<Change>;
export type SessionDetailDto = Wire<SessionDetail>;
/** What the caller may do with a session (docs/adr/0003): only real controls are shown. */
export type SessionControlDto = Wire<SessionControlView>;
export type ReviewSliceDto = Wire<ReviewSlice>;
export type OpenReviewDto = Wire<OpenReviewResult>;
export type ReviewDiffHunkDto = Wire<ReviewDiffHunkView>;
export type ReviewDiffFileDto = Wire<ReviewDiffFileView>;
export type ReviewDiffDto = Wire<ReviewDiffView>;
export type RecordLinkDto = Wire<RecordLink>;
export type ReviewCommentAnchorDto = Wire<ReviewCommentAnchor>;
export type ReviewCommentDto = Wire<ReviewComment>;
export type SliceCommentTargetDto = Wire<SliceCommentTargetRequest>;
export type FollowUpDto = Wire<FollowUp>;
export type DeliverFollowUpInput = Payload<"POST", "/api/sessions/:id/follow-up/deliver">;
/** One workspace process — agent, shell, or Service (docs/SESSION-SERVICES.md). */
export type SessionProcessDto = Wire<SessionProcess>;
export type SessionProcessKind = SessionProcessDto["kind"];
/** Observed lifecycle only — never a judgment about the work. */
export type SessionProcessStatus = SessionProcessDto["status"];
export type ProcessLogPageDto = Wire<ProcessLogPage>;
/** One conversation event of the session's durable record. */
export type TranscriptEventDto = Wire<TranscriptEvent>;
export type SessionTranscriptDto = Wire<SessionTranscript>;
export type ServiceRecipeDto = Wire<ServiceRecipe>;
export type ServiceEndpointDto = Wire<ServiceEndpoint>;
export type ServiceViewDto = Wire<ServiceView>;
/** A project's files, flat and sorted — from a session worktree or the default branch's tree. */
export type ProjectFileListingDto = Wire<ProjectFileListing>;
/** One pull request as gh reported it — a reference attached to work, never its identity. */
export type PullRequestViewDto = Wire<PullRequestView>;
export type ProjectPullRequestsDto = Wire<ProjectPullRequests>;
export type PullRequestAvailability = ProjectPullRequestsDto["availability"];
/** A connected account as the platform reports it — never carries the secret. */
export type ConnectedAccountDto = Wire<ConnectedAccount>;
export type ConnectedAccountProviderDto = ConnectedAccountDto["provider"];
export type SealantIdentityDto = Wire<SealantIdentity>;
/** An image stored beside the session; `path` is what the terminal pastes. */
export type PastedImageDto = Wire<PastedImage>;
/** The outcome of a destructive removal — what went, what would not delete. */
export type RemovalReportDto = Wire<RemovalReport>;
/** A composed start — the server turns this into the harness's own argv. */
export type LaunchStartDto = Omit<Payload<"POST", "/api/sessions/:id/launch">, "argv">;

// ─── what the wire says about liveness ──────────────────────────────────────

export const LIVE_STATUSES: ReadonlySet<SessionStatusDto> = new Set<SessionStatusDto>([
  "starting",
  "running",
  "waiting",
  "idle",
]);

export const LIVE_PROCESS: ReadonlySet<SessionProcessStatus> = LIVE_PROCESS_STATUSES;

export const isAgentProcessKind = (kind: SessionProcessKind): boolean => isAgentKind(kind);

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

const stringField = (body: object, key: string): string | null => {
  const value: unknown = Reflect.get(body, key);
  return typeof value === "string" ? value : null;
};

const describe = (body: unknown): string | null => {
  if (typeof body === "string" && body !== "") return body;
  if (typeof body === "object" && body !== null) {
    const message = stringField(body, "message") ?? stringField(body, "error");
    if (message !== null) return message;
    const tag = stringField(body, "_tag");
    if (tag !== null) return TAGGED[tag] ?? tag;
  }
  return null;
};

/**
 * One contract call. `method` and `path` must name an endpoint the contract declares (the path
 * template, not a filled path); params, query and body are typed off that endpoint, and so is
 * the answer.
 */
const call = async <M extends Method, P extends PathOf<M>>(
  method: M,
  path: P,
  ...args: InputArgs<M, P>
): Promise<Answer<M, P>> => {
  const raw = rawInput(args[0]);
  const filled = fillPath(path, raw);
  const response = await window.mend.api.request(
    raw.body === undefined ? { method, path: filled } : { method, path: filled, body: raw.body },
  );
  if (!response.ok) {
    const detail = describe(response.body);
    throw new ApiError(
      response.status === 0
        ? (detail ?? "the Mend server did not answer")
        : `${method} ${filled} responded ${response.status}${detail === null ? "" : ` — ${detail}`}`,
      response.status,
    );
  }
  // The bridge hands back the parsed JSON; its shape is the contract's promise (lib/contract.ts).
  return response.body as Answer<M, P>;
};

// ─── the signed-in user's platform identity ─────────────────────────────────

export const getSealantIdentity = () => call("GET", "/api/me/sealant");

/** Forwards the credential to the platform under the user's own identity; Mend keeps nothing. */
export const connectAccount = (input: {
  readonly provider: ConnectedAccountProviderDto;
  readonly secret: string;
}) => call("POST", "/api/me/sealant/accounts", { body: input });

export const disconnectAccount = (id: string) =>
  call("DELETE", "/api/me/sealant/accounts/:id", { params: { id } });

// ─── reads ──────────────────────────────────────────────────────────────────

export const listProjects = () => call("GET", "/api/projects");

export const projectDetail = (id: string) => call("GET", "/api/projects/:id", { params: { id } });

export const sessionDetail = (id: string) => call("GET", "/api/sessions/:id", { params: { id } });

export const listSessionProcesses = (id: string) =>
  call("GET", "/api/sessions/:id/processes", { params: { id } });

export const processLogPage = (
  id: string,
  options: { readonly from: string; readonly limit: string },
) => call("GET", "/api/processes/:id/logs", { params: { id }, query: options });

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
  call("GET", "/api/sessions/:id/transcript", { params: { id } });

export const reviewDiff = (
  changeId: string,
  sliceId: string,
  options: { readonly whitespace: "include" | "ignore"; readonly context: number },
) =>
  call("GET", "/api/changes/:id/reviews/:sliceId/diff", {
    params: { id: changeId, sliceId },
    query: { whitespace: options.whitespace, context: String(options.context) },
  });

export const changeComments = (changeId: string) =>
  call("GET", "/api/changes/:id/comments", { params: { id: changeId } });

/** `sessionId` roots the listing at that session's live worktree; null reads the default branch. */
export const projectFiles = (projectId: string, sessionId: string | null) =>
  call("GET", "/api/projects/:id/files", {
    params: { id: projectId },
    query: sessionId === null ? {} : { session: sessionId },
  });

export const projectPullRequests = (projectId: string) =>
  call("GET", "/api/projects/:id/pull-requests", { params: { id: projectId } });

export const listServices = () => call("GET", "/api/services", { query: { all: "1" } });

export const listSessionRecipes = (sessionId: string) =>
  call("GET", "/api/sessions/:id/recipes", { params: { id: sessionId } });

// ─── writes ─────────────────────────────────────────────────────────────────

export const createSession = (
  projectId: string,
  harness: string,
  label: string | null,
  base: string | null = null,
  name: string | null = null,
) =>
  call("POST", "/api/projects/:id/sessions", {
    params: { id: projectId },
    body: { harness, label, name, base },
  });

export const pasteSessionImage = (sessionId: string, contentsBase64: string) =>
  call("POST", "/api/sessions/:id/images", {
    params: { id: sessionId },
    body: { contentsBase64 },
  });

export const runServiceRecipe = (sessionId: string, name: string) =>
  call("POST", "/api/sessions/:id/services/recipe", { params: { id: sessionId }, body: { name } });

export const runService = (
  sessionId: string,
  input: Payload<"POST", "/api/sessions/:id/services/run">,
) => call("POST", "/api/sessions/:id/services/run", { params: { id: sessionId }, body: input });

export const addService = (
  sessionId: string,
  input: Payload<"POST", "/api/sessions/:id/services">,
) => call("POST", "/api/sessions/:id/services", { params: { id: sessionId }, body: input });

export const restartService = (serviceId: string) =>
  call("POST", "/api/services/:id/restart", { params: { id: serviceId } });

export const stopService = (serviceId: string) =>
  call("POST", "/api/services/:id/stop", { params: { id: serviceId } });

/** Launch runs `argv` supervised in the session's fresh workspace. */
export const launchSession = (id: string, argv: ReadonlyArray<string>) =>
  call("POST", "/api/sessions/:id/launch", { params: { id }, body: { argv } });

/** Launch with a structured start; the typed prompt opens the harness and seeds auto-naming. */
export const launchSessionStart = (id: string, start: LaunchStartDto) =>
  call("POST", "/api/sessions/:id/launch", { params: { id }, body: start });

export const checkpointSession = (id: string, trigger: "review-open" | "user-mark") =>
  call("POST", "/api/sessions/:id/checkpoints", { params: { id }, body: { trigger } });

export const openReview = (changeId: string, idempotencyKey: string) =>
  call("POST", "/api/changes/:id/reviews/open", {
    params: { id: changeId },
    body: { idempotencyKey },
  });

export const postSliceReviewComment = (
  changeId: string,
  sliceId: string,
  target: SliceCommentTargetDto,
  body: string,
) =>
  call("POST", "/api/changes/:id/reviews/:sliceId/comments", {
    params: { id: changeId, sliceId },
    body: { target, body },
  });

export const setReviewCommentState = (
  changeId: string,
  commentId: string,
  state: "open" | "addressed" | "dismissed",
) =>
  call("POST", "/api/changes/:id/comments/:commentId/state", {
    params: { id: changeId, commentId },
    body: { state },
  });

export const deliverFollowUp = (sessionId: string, input: DeliverFollowUpInput) =>
  call("POST", "/api/sessions/:id/follow-up/deliver", { params: { id: sessionId }, body: input });

/** Open a supporting shell in the session's current reachable workspace. */
export const openShell = (id: string) =>
  call("POST", "/api/sessions/:id/shell", { params: { id } });

/** Stop one supporting shell process group. Repeating a completed stop is safe. */
export const stopShell = (id: string) =>
  call("POST", "/api/processes/:id/stop", { params: { id } });

/** Rename one live supporting shell. */
export const renameShell = (id: string, label: string) =>
  call("POST", "/api/processes/:id/label", { params: { id }, body: { label } });

export const stopSession = (id: string) =>
  call("POST", "/api/sessions/:id/stop", { params: { id } });

/** The owner's alone: a new label, or null to fall back to the branch. */
export const renameSession = (id: string, label: string | null) =>
  call("POST", "/api/sessions/:id/label", { params: { id }, body: { label } });

/**
 * docs/adr/0003: the owner lends their credentials so everyone who can see the project may
 * steer; an organization owner may turn it off. Every act is recorded with who did it.
 */
export const setSharedControl = (id: string, enabled: boolean) =>
  call("PUT", "/api/sessions/:id/shared-control", { params: { id }, body: { enabled } });

/**
 * Settled sessions only — a live one answers 409. Removes the conversation
 * record and its workspace ONLY; the worktree (change, checkpoints, review)
 * stands, removed by `removeWorktree`.
 */
export const removeSession = (id: string) =>
  call("DELETE", "/api/sessions/:id", { params: { id } });

/**
 * The one explicit destructive act: the worktree goes with its sessions,
 * change, and review. Refused (409) while any conversation is live; a
 * standing unreviewed diff refuses (422) unless forced.
 */
export const removeWorktree = (id: string, force?: boolean) =>
  call("DELETE", "/api/worktrees/:id", {
    params: { id },
    query: force === true ? { force: "true" } : {},
  });

/** A new conversation inside an existing worktree; launching is separate. */
export const createSessionInWorktree = (id: string, harness: string) =>
  call("POST", "/api/worktrees/:id/sessions", { params: { id }, body: { harness, label: null } });
