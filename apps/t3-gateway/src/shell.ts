import { dirname, join } from "node:path";

import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  MendProcess,
  MendProject,
  MendRequest,
  MendSession,
  MendTurn,
} from "./mend-workbench.ts";
import type { ThreadNotices } from "./notices.ts";
import { harnessProvider } from "./server-config.ts";
import type { StoredImage } from "./state.ts";

/**
 * Mend's projects and protocol sessions as t3code's shell (ADR 0012, "Concepts"): a project is a
 * t3code project whose `workspaceRoot` is its store path, a protocol-mode codex or claude session
 * is a thread, and an agent turn is a run. Pure functions over what the gateway read from Mend;
 * the projection hub (`hub.ts`) keeps them live.
 *
 * t3code ids are Mend's own ids, so a thread is addressable before the gateway has stored
 * anything. Only a run or a message the gateway minted for a t3code client carries a t3code id,
 * which `runIds` and `messageIds` map back to Mend's turn.
 */

/**
 * The orchestration projection's schema version at the pinned tag
 * (`ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION` in t3:apps/server/src/orchestration-v2/ProjectionStore.ts;
 * the contracts carry only its type).
 */
export const PROJECTION_SCHEMA_VERSION = 2;

/** No projects and no threads: a person who sees nothing in Mend, or a gateway that read nothing. */
export const EMPTY_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  schemaVersion: PROJECTION_SCHEMA_VERSION,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
};

/** What the gateway knows of one protocol session: enough to project it as a thread. */
export interface ThreadSource {
  /**
   * The thread's id: the session's own, or, for a thread a t3code client launched, the id that
   * client gave it (`thread_ids` in the state file).
   */
  readonly threadId: ThreadId;
  readonly project: MendProject;
  readonly session: MendSession;
  /**
   * The session's current agent: a protocol process (`isProjectable`), or, for a launched thread
   * whose agent Mend has not started yet, the agent its launch asked for (`launchingAgentOf`).
   */
  readonly agent: MendProcess;
  /** The change of the session's worktree, when it has one. */
  readonly changeId: string | null;
  /** Oldest first. */
  readonly turns: ReadonlyArray<MendTurn>;
  readonly requests: ReadonlyArray<MendRequest>;
  /** Mend turn id → the t3code run id the gateway minted for it, when it did. */
  readonly runIds: ReadonlyMap<string, string>;
  /** Mend turn id → the t3code message id its input was sent as, when a t3code client sent it. */
  readonly messageIds: ReadonlyMap<string, string>;
  /** Messages a t3code client sent that are not a Mend turn yet: the gateway's queue. */
  readonly pending: ReadonlyArray<PendingRun>;
  /**
   * The images a message the gateway sent carried when Mend took its turn, by the message's
   * t3code id (`images.ts`), each with the path its turn named.
   */
  readonly imagesOf: (
    messageId: string,
  ) => ReadonlyArray<{ readonly image: StoredImage; readonly path: string }>;
  /** An interrupt held the queue; nothing queued is sent until the client resumes it. */
  readonly queueHeld: boolean;
  /**
   * What Mend says about people sharing the session's workspace (docs/adr/0016, decisions 6, 13
   * and 14): the full thread shows each as a notice, the shell the waiting line's work.
   */
  readonly notices: ThreadNotices;
}

/**
 * One message in the gateway's queue (ADR 0012, "The gateway holds the queue"), as a run until
 * Mend opens its turn: `queued` behind an open turn, `starting` while Mend takes it,
 * `preparing` while a stopped session is launched again with it, `failed` when Mend refused it,
 * `cancelled` when the client took it back.
 */
export interface PendingRun {
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly images: ReadonlyArray<StoredImage>;
  readonly requestedAt: string;
  readonly state: "queued" | "starting" | "preparing" | "failed" | "cancelled";
  readonly error: string | null;
}

/**
 * Whether a session is a thread: its current agent is a protocol process of a harness t3code has
 * a driver for, or it has no agent yet and a t3code client launched it (`launched`). PTY and shell
 * sessions are hidden (ADR 0012, "Out of the MVP").
 */
export const isProjectable = (
  session: MendSession,
  agent: MendProcess | null,
  launched = false,
): boolean =>
  harnessProvider(session.harness) !== null &&
  (agent === null ? launched : agent.kind === "agent-protocol");

/**
 * The agent a launched thread asked for while Mend has none for it: starting while the session
 * starts, otherwise not running. The gateway never reports it running; only Mend's own process
 * does.
 */
export const launchingAgentOf = (
  session: MendSession,
  options: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly permissionMode?: "bypass" | "ask" | undefined;
  },
): MendProcess => ({
  id: `launching:${session.id}`,
  kind: "agent-protocol",
  harness: session.harness,
  status: session.status === "starting" ? "starting" : "exited",
  providerSessionId: null,
  protocolOptions: {
    model: options.model ?? session.model ?? null,
    effort: options.effort ?? null,
    permissionMode: options.permissionMode ?? "bypass",
  },
  createdAt: session.createdAt,
  exitedAt: session.status === "starting" ? null : session.updatedAt,
});

// ─── Small conversions ───────────────────────────────────────────────────────

const EPOCH = DateTime.makeUnsafe(0);

/** A Mend timestamp as t3code's; an unreadable one reads as the epoch rather than failing. */
export const utc = (iso: string): DateTime.Utc =>
  Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toUtc), () => EPOCH);

const latestOf = (values: ReadonlyArray<string | null | undefined>): string | null => {
  let latest: string | null = null;
  let latestMillis = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const millis = Date.parse(value);
    if (!Number.isNaN(millis) && millis > latestMillis) {
      latest = value;
      latestMillis = millis;
    }
  }
  return latest;
};

const firstLine = (text: string, limit: number): string | null => {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
};

/** The worktree's directory on Mend's host: beside the bare repository, in `worktrees/`. */
export const worktreePathOf = (project: MendProject, session: MendSession): string =>
  join(dirname(project.storePath), "worktrees", session.worktree);

/** Mend's permission modes are t3code's runtime modes: `ask` asks, `bypass` does not. */
export const runtimeModeOf = (agent: MendProcess): RuntimeMode =>
  agent.protocolOptions?.permissionMode === "ask" ? "approval-required" : "full-access";

// ─── Ids ─────────────────────────────────────────────────────────────────────

export const threadIdOf = (source: ThreadSource): ThreadId => source.threadId;

/** The provider thread and session every thread has one of: the session's agent conversation. */
export const providerThreadIdOf = (session: MendSession): ProviderThreadId =>
  ProviderThreadId.make(`provider-thread:${session.id}`);
export const providerSessionIdOf = (session: MendSession): ProviderSessionId =>
  ProviderSessionId.make(`provider-session:${session.id}`);

export const runIdOf = (source: ThreadSource, turn: MendTurn): RunId =>
  RunId.make(source.runIds.get(turn.id) ?? turn.id);

/** A turn's input as a message: the id its t3code client sent it with, else one from the turn. */
export const userMessageIdOf = (source: ThreadSource, turn: MendTurn): MessageId =>
  MessageId.make(source.messageIds.get(turn.id) ?? `message:${turn.id}`);

// ─── Entities ────────────────────────────────────────────────────────────────

/** Mend's run statuses are t3code's; a running turn its agent is waiting on a person for is `waiting`. */
const runStatusOf = (
  turn: MendTurn,
  pending: boolean,
  sentByGateway: boolean,
): OrchestrationV2RunStatus => {
  switch (turn.status) {
    // A turn the gateway sent only when nothing was open is about to run, not waiting in line.
    case "queued":
      return sentByGateway ? "starting" : "queued";
    case "running":
      return pending ? "waiting" : "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
};

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export const isActiveRunStatus = (status: OrchestrationV2RunStatus): boolean =>
  ACTIVE_RUN_STATUSES.has(status);

export const modelSelectionOf = (source: ThreadSource): ModelSelection => {
  const provider = harnessProvider(source.session.harness);
  return {
    // Only sessions of a harness with a provider are threads (`isProjectable`).
    instanceId: provider?.instanceId ?? ProviderInstanceId.make(source.session.harness),
    model: source.session.model ?? source.agent.protocolOptions?.model ?? "default",
  };
};

export const projectShellOf = (project: MendProject): OrchestrationProjectShell => ({
  id: ProjectId.make(project.id),
  title: project.name.trim().length > 0 ? project.name : project.id,
  workspaceRoot: project.storePath,
  // Each session keeps the model it was started with; a project has no default of its own here.
  defaultModelSelection: null,
  scripts: [],
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

/**
 * The thread's title: the session's label, else its first message (sent, or still in the
 * gateway's queue), else its harness.
 */
export const threadTitleOf = (source: ThreadSource): string => {
  const label = source.session.label?.trim();
  if (label !== undefined && label.length > 0) return label;
  const first =
    source.turns.toSorted(byOrdinal).find((turn) => turn.origin !== "harness")?.input ??
    source.pending.find((entry) => entry.state !== "cancelled")?.text;
  const fromInput = first === undefined ? null : firstLine(first, 80);
  if (fromInput !== null) return fromInput;
  return `${harnessProvider(source.session.harness)?.displayName ?? source.session.harness} session`;
};

/** When the thread last changed: the session row, or the newest turn or request in it. */
export const threadUpdatedAtOf = (source: ThreadSource): string =>
  latestOf([
    source.session.updatedAt,
    ...source.turns.flatMap((turn) => [turn.createdAt, turn.startedAt, turn.endedAt]),
    ...source.requests.flatMap((request) => [request.createdAt, request.decidedAt]),
  ]) ?? source.session.updatedAt;

export const appThreadOf = (source: ThreadSource): OrchestrationV2AppThread => {
  const id = threadIdOf(source);
  return {
    createdBy: "user",
    creationSource: "server",
    id,
    projectId: ProjectId.make(source.project.id),
    title: threadTitleOf(source),
    providerInstanceId: modelSelectionOf(source).instanceId,
    modelSelection: modelSelectionOf(source),
    runtimeMode: runtimeModeOf(source.agent),
    interactionMode: "default",
    branch: source.session.branch.trim().length > 0 ? source.session.branch : null,
    worktreePath: worktreePathOf(source.project, source.session),
    activeProviderThreadId: providerThreadIdOf(source.session),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: utc(source.session.createdAt),
    updatedAt: utc(threadUpdatedAtOf(source)),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const pendingTurnIds = (source: ThreadSource): ReadonlySet<string> =>
  new Set(source.requests.filter((request) => request.status === "pending").map((r) => r.turnId));

/** One run per Mend turn, in conversation order. */
export const runsOf = (source: ThreadSource): ReadonlyArray<OrchestrationV2Run> => {
  const pending = pendingTurnIds(source);
  const modelSelection = modelSelectionOf(source);
  const providerThreadId = providerThreadIdOf(source.session);
  const turns = source.turns.toSorted(byOrdinal).map(
    (turn, index): OrchestrationV2Run => ({
      id: runIdOf(source, turn),
      threadId: threadIdOf(source),
      ordinal: index + 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: userMessageIdOf(source, turn),
      rootNodeId: null,
      activeAttemptId: null,
      status: runStatusOf(turn, pending.has(turn.id), source.runIds.has(turn.id)),
      requestedAt: utc(turn.createdAt),
      startedAt: turn.startedAt === null ? null : utc(turn.startedAt),
      completedAt: turn.endedAt === null ? null : utc(turn.endedAt),
      checkpointId: null,
      contextHandoffId: null,
    }),
  );
  let queuePosition = 0;
  const queued = source.pending.map((entry, index): OrchestrationV2Run => {
    const requestedAt = utc(entry.requestedAt);
    const settled = entry.state === "failed" || entry.state === "cancelled";
    return {
      id: RunId.make(entry.runId),
      threadId: threadIdOf(source),
      ordinal: turns.length + index + 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make(entry.messageId),
      rootNodeId: null,
      activeAttemptId: null,
      status: pendingStatusOf(entry),
      ...(entry.state === "queued"
        ? { queuePosition: ++queuePosition, queueHeld: source.queueHeld }
        : {}),
      requestedAt,
      startedAt: null,
      completedAt: settled ? requestedAt : null,
      checkpointId: null,
      contextHandoffId: null,
    };
  });
  return [...turns, ...queued];
};

const pendingStatusOf = (entry: PendingRun): OrchestrationV2RunStatus => {
  switch (entry.state) {
    case "queued":
      return "queued";
    case "starting":
      return "starting";
    case "preparing":
      return "preparing";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};

export const byOrdinal = (left: MendTurn, right: MendTurn): number => left.ordinal - right.ordinal;

/** Mend's request kinds are t3code's: approvals of a command, a file change or a tool, or a question. */
export const requestKindOf = (kind: string): OrchestrationV2RuntimeRequest["kind"] => {
  switch (kind) {
    case "command-approval":
      return "command";
    case "file-change-approval":
      return "file-change";
    case "user-input":
      return "user_input";
    default:
      return "permission";
  }
};

const requestStatusOf = (status: string): OrchestrationV2RuntimeRequest["status"] =>
  status === "pending" ? "pending" : status === "resolved" ? "resolved" : "cancelled";

/** Mend's approval decisions in t3code's words. */
const decisionOf = (decision: string | null): OrchestrationV2RuntimeRequest["decision"] => {
  switch (decision) {
    case "accept":
      return "accept";
    case "accept-for-session":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
};

/** The execution node a request hangs from; requests have no turn tree in Mend. */
export const requestNodeIdOf = (request: MendRequest): NodeId =>
  NodeId.make(`request-node:${request.id}`);

export const runtimeRequestsOf = (
  source: ThreadSource,
): ReadonlyArray<OrchestrationV2RuntimeRequest> =>
  source.requests.map((request) => {
    const decision = decisionOf(request.decision);
    return {
      id: RuntimeRequestId.make(request.id),
      nodeId: requestNodeIdOf(request),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: requestKindOf(request.kind),
      status: requestStatusOf(request.status),
      // Answered through Mend while the agent that asked is live.
      responseCapability: { type: "live", providerSessionId: providerSessionIdOf(source.session) },
      createdAt: utc(request.createdAt),
      resolvedAt: request.decidedAt === null ? null : utc(request.decidedAt),
      ...(decision === undefined ? {} : { decision }),
      ...(request.answers === null ? {} : { answers: request.answers }),
    };
  });

const pendingRequestSummaryOf = (
  source: ThreadSource,
): OrchestrationV2PendingRuntimeRequestSummary | null => {
  const pending = source.requests
    .filter((request) => request.status === "pending")
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return pending === undefined
    ? null
    : {
        id: RuntimeRequestId.make(pending.id),
        kind: requestKindOf(pending.kind),
        createdAt: utc(pending.createdAt),
      };
};

/** Mend's kinds of background work in t3code's (`ConversationWaitWork` in @mend/domain). */
const backgroundKindOf = (kind: string): OrchestrationV2PendingBackgroundTask["kind"] => {
  switch (kind) {
    case "sub-agent":
      return "subagent";
    case "terminal":
      return "command";
    case "monitor":
      return "monitor";
    default:
      return "background_task";
  }
};

/**
 * What a waiting turn waits for (docs/adr/0016, decision 6), as t3code's "Waiting" roster: the
 * previous sender's own background work, each named as the harness named it. Empty when nothing
 * waits.
 */
export const waitingTasksOf = (
  notices: ThreadNotices,
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> =>
  (notices.waiting?.work ?? []).map((work, index) => {
    const description = work.description?.trim() ?? "";
    const taskId = work.id.trim();
    return {
      taskId: taskId.length > 0 ? taskId : `${work.kind}:${index}`,
      kind: backgroundKindOf(work.kind),
      ...(description.length === 0 ? {} : { description }),
    };
  });

/**
 * The shell row: the thread and the state of its latest run, as t3code's own server derives it
 * (`latestRun.status ?? "idle"`, the newest active run, the newest pending request). Message
 * bodies stay out of the shell, as they do in t3code's.
 */
export const threadShellOf = (
  source: ThreadSource,
  counts: { readonly itemCount: number; readonly visibleItemCount: number },
): OrchestrationV2ThreadShell => {
  const thread = appThreadOf(source);
  const runs = runsOf(source);
  const latestRun = runs.at(-1);
  const activeRun = runs.findLast((run) => isActiveRunStatus(run.status));
  // A message still in the gateway's queue is the person's latest too: t3code's own server has it
  // as a message the moment it is dispatched, and a launched thread's client waits for it.
  const latestUserMessage = latestOf([
    source.turns.toSorted(byOrdinal).findLast((t) => t.origin !== "harness")?.createdAt,
    ...source.pending
      .filter((entry) => entry.state !== "cancelled")
      .map((entry) => entry.requestedAt),
  ]);
  return {
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStartedAt:
      activeRun === undefined ? null : (activeRun.startedAt ?? activeRun.requestedAt),
    activityRunStatus:
      activeRun !== undefined &&
      (activeRun.status === "preparing" ||
        activeRun.status === "starting" ||
        activeRun.status === "running" ||
        activeRun.status === "waiting")
        ? activeRun.status
        : null,
    status: latestRun?.status ?? "idle",
    lastError: source.turns.toSorted(byOrdinal).at(-1)?.error ?? null,
    pendingRuntimeRequest: pendingRequestSummaryOf(source),
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage === null ? null : utc(latestUserMessage),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: waitingTasksOf(source.notices),
    providerInstanceHistory: [thread.providerInstanceId],
    itemCount: counts.itemCount,
    visibleItemCount: counts.visibleItemCount,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};
