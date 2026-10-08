import {
  MessageId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type ProviderThreadId,
  type ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalOption,
} from "@mend/t3-contracts";
import type * as DateTime from "effect/DateTime";

import type { MendItem, MendRequest, MendTurn } from "./mend-workbench.ts";
import { harnessProvider } from "./server-config.ts";
import {
  appThreadOf,
  byOrdinal,
  isActiveRunStatus,
  providerSessionIdOf,
  providerThreadIdOf,
  requestKindOf,
  runIdOf,
  runsOf,
  runtimeRequestsOf,
  threadIdOf,
  userMessageIdOf,
  utc,
  worktreePathOf,
  type ThreadSource,
} from "./shell.ts";

/**
 * One thread in full (ADR 0012, "Concepts"): the session, a run per turn, the turn's input as a
 * user message, every agent item as a turn item, and every request as a runtime request with the
 * item that shows it. Items are ordered by turn, then by when Mend recorded them: each turn owns a
 * block of ordinals, its input first.
 *
 * Mend's items carry the harness's own item in `data` (a codex app-server item, a claude
 * `tool_use` block); what t3code needs is read from there with care, and anything unrecognised is
 * shown as a generic tool row rather than dropped.
 */

/** The ordinals one turn owns. Far more than any turn records. */
export const TURN_ORDINAL_STRIDE = 100_000;

/** What Mend's protocol sessions can do, in t3code's capability vocabulary. */
export const MEND_PROVIDER_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    // A turn cannot be steered once it runs; a follow-up waits for it (the gateway's queue).
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
};

/** The approval choices Mend can pass on (`AgentApprovalDecision` in @mend/domain/workbench). */
const APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for this session" },
  { decision: "decline", label: "Decline" },
];

// ─── Reading the harness's item ──────────────────────────────────────────────

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a path through nested objects, or undefined. */
const at = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const commandText = (value: unknown): string | undefined => {
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return text(value);
};

const nonEmpty = (value: string | null | undefined, fallback: string): string => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
};

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const itemStatusOf = (status: string): OrchestrationV2TurnItemStatus => {
  switch (status) {
    case "in-progress":
      return "running";
    case "completed":
      return "completed";
    case "declined":
      return "cancelled";
    default:
      return "failed";
  }
};

/** What a request's detail says, in a line a person can read. */
const detailText = (detail: unknown): string | undefined => {
  if (detail === null || detail === undefined) return undefined;
  if (typeof detail === "string") return text(detail);
  const command = commandText(at(detail, "command")) ?? commandText(at(detail, "input", "command"));
  if (command !== undefined) return command;
  // Claude's permission request: the tool and what it touches (`{ toolName, input }`).
  const path = text(at(detail, "input", "file_path")) ?? text(at(detail, "input", "path"));
  const tool = text(at(detail, "toolName"));
  if (path !== undefined) return tool === undefined ? path : `${tool} ${path}`;
  const url = text(at(detail, "input", "url"));
  if (url !== undefined) return tool === undefined ? url : `${tool} ${url}`;
  const reason = text(at(detail, "reason"));
  if (reason !== undefined) return reason;
  return truncate(JSON.stringify(detail), 2_000);
};

// ─── Entities ────────────────────────────────────────────────────────────────

/** The fields every turn item carries (`OrchestrationV2TurnItemBaseFields`). */
interface Base {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: null;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: null;
  readonly nativeItemRef: null;
  readonly parentItemId: null;
  readonly ordinal: number;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly title: string | null;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
}

const userItemIdOf = (runId: RunId): TurnItemId => TurnItemId.make(`input:${runId}`);

/** The turn item one Mend item is shown as, or null for one already shown another way. */
const turnItemOfMendItem = (item: MendItem, base: Base): OrchestrationV2TurnItem | null => {
  const streaming = item.status === "in-progress";
  const data = item.data;
  switch (item.kind) {
    // The turn's input is the user message; codex also records it as an item.
    case "user-message":
      return null;
    case "assistant-message":
      return {
        ...base,
        type: "assistant_message",
        messageId: MessageId.make(`message:${item.id}`),
        text: item.text ?? text(at(data, "text")) ?? "",
        streaming,
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        text: item.text ?? text(at(data, "thinking")) ?? text(at(data, "text")) ?? "",
        streaming,
      };
    case "command-execution": {
      const exitCode = at(data, "exitCode");
      const output = item.text ?? text(at(data, "aggregatedOutput"));
      return {
        ...base,
        type: "command_execution",
        input:
          commandText(at(data, "input", "command")) ??
          commandText(at(data, "command")) ??
          item.title ??
          "",
        ...(output === undefined ? {} : { output }),
        ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
      };
    }
    case "file-change": {
      const changes = at(data, "changes");
      const details = Array.isArray(changes)
        ? changes.flatMap((change) => {
            const path = text(at(change, "path"));
            if (path === undefined) return [];
            const kind = at(change, "kind");
            const operation = text(kind) ?? text(at(kind, "type")) ?? "update";
            return [{ operation, path }];
          })
        : [];
      const diff =
        Array.isArray(changes) && changes.length === 1 ? text(at(changes[0], "diff")) : undefined;
      return {
        ...base,
        type: "file_change",
        fileName: nonEmpty(
          text(at(data, "input", "file_path")) ??
            text(at(data, "path")) ??
            details[0]?.path ??
            item.title,
          "file",
        ),
        ...(diff === undefined ? {} : { diffStr: diff }),
        ...(details.length === 0 ? {} : { changes: details }),
      };
    }
    case "web-search": {
      const query =
        text(at(data, "query")) ??
        text(at(data, "input", "query")) ??
        text(at(data, "input", "url"));
      const pattern = query ?? item.title ?? undefined;
      return {
        ...base,
        type: "web_search",
        ...(pattern === undefined || pattern === null ? {} : { patterns: [pattern] }),
      };
    }
    case "error":
      return {
        ...base,
        type: "error",
        failure: {
          class: "unknown",
          message: truncate(
            nonEmpty(item.text ?? item.title, "The agent reported an error."),
            4_000,
          ),
          code: null,
          retryable: null,
        },
      };
    case "other":
      if (data === null || data === undefined) {
        const message = item.text ?? item.title;
        return message === null || message.trim().length === 0
          ? null
          : { ...base, type: "system_notice", message };
      }
      break;
    default:
      break;
  }
  // A tool call, a plan, a background task: a tool row named by the harness.
  const name = text(item.title) ?? text(at(data, "name")) ?? text(at(data, "type")) ?? item.kind;
  const input = at(data, "input");
  return {
    ...base,
    type: "dynamic_tool",
    toolName: name,
    input: input === undefined ? data : input,
    ...(item.text === null ? {} : { output: item.text }),
  };
};

const questionsOf = (request: MendRequest): ReadonlyArray<OrchestrationV2UserInputQuestion> =>
  (request.questions ?? []).flatMap((question) => {
    const id = question.id.trim();
    const asked = question.question.trim();
    if (id.length === 0 || asked.length === 0) return [];
    return [
      {
        id,
        header: nonEmpty(question.header, "Question"),
        question: asked,
        options: question.options.flatMap((option) => {
          const label = option.label.trim();
          return label.length === 0
            ? []
            : [{ label, description: nonEmpty(option.description, label) }];
        }),
        multiSelect: question.multiSelect,
      },
    ];
  });

const requestItemStatusOf = (status: string): OrchestrationV2TurnItemStatus =>
  status === "pending" ? "waiting" : status === "resolved" ? "completed" : "cancelled";

const turnItemOfRequest = (request: MendRequest, base: Base): OrchestrationV2TurnItem => {
  const requestId = RuntimeRequestId.make(request.id);
  const kind = requestKindOf(request.kind);
  if (kind === "user_input") {
    const questions = questionsOf(request);
    return {
      ...base,
      type: "user_input_request",
      requestId,
      questions,
      ...(request.answers === null
        ? {}
        : {
            questionAnswer: {
              requestId: request.id,
              questionTextById: Object.fromEntries(
                questions.map((question) => [question.id, question.question]),
              ),
              answers: request.answers,
              attachmentsByQuestionId: {},
            },
          }),
    };
  }
  const prompt = [text(request.title), detailText(request.detail)]
    .filter((part): part is string => part !== undefined)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join("\n");
  return {
    ...base,
    type: "approval_request",
    requestId,
    requestKind: kind === "dynamic_tool_call" || kind === "auth_refresh" ? "permission" : kind,
    ...(prompt.length === 0 ? {} : { prompt }),
    options: APPROVAL_OPTIONS,
  };
};

const byRecorded = (
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);

interface TurnEntries {
  readonly items: Array<OrchestrationV2TurnItem>;
  readonly messages: Array<OrchestrationV2ConversationMessage>;
}

const turnEntries = (
  source: ThreadSource,
  turn: MendTurn,
  index: number,
  items: ReadonlyArray<MendItem>,
  requests: ReadonlyArray<MendRequest>,
): TurnEntries => {
  const threadId = threadIdOf(source.session);
  const providerThreadId = providerThreadIdOf(source.session);
  const runId = runIdOf(source, turn);
  const ordinalBase = (index + 1) * TURN_ORDINAL_STRIDE;
  const fromHarness = turn.origin === "harness";
  const userMessageId = userMessageIdOf(source, turn);
  const created = utc(turn.createdAt);
  const out: TurnEntries = { items: [], messages: [] };

  out.messages.push({
    createdBy: fromHarness ? "system" : "user",
    creationSource: fromHarness ? "provider" : "web",
    id: userMessageId,
    threadId,
    runId,
    nodeId: null,
    role: fromHarness ? "system" : "user",
    text: turn.input,
    attachments: [],
    streaming: false,
    createdAt: created,
    updatedAt: created,
  });
  out.items.push({
    id: userItemIdOf(runId),
    threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinalBase,
    status: "completed",
    title: null,
    startedAt: created,
    completedAt: created,
    updatedAt: created,
    createdBy: fromHarness ? "system" : "user",
    creationSource: fromHarness ? "provider" : "web",
    type: "user_message",
    messageId: userMessageId,
    inputIntent: "turn_start",
    text: turn.input,
    attachments: [],
  });

  type Entry =
    | {
        readonly kind: "item";
        readonly createdAt: string;
        readonly id: string;
        readonly item: MendItem;
      }
    | {
        readonly kind: "request";
        readonly createdAt: string;
        readonly id: string;
        readonly request: MendRequest;
      };
  const entries: Array<Entry> = [
    ...items.map((item): Entry => ({ kind: "item", createdAt: item.createdAt, id: item.id, item })),
    ...requests.map(
      (request): Entry => ({
        kind: "request",
        createdAt: request.createdAt,
        id: request.id,
        request,
      }),
    ),
  ].toSorted(byRecorded);

  let ordinal = ordinalBase;
  for (const entry of entries) {
    ordinal += 1;
    if (entry.kind === "item") {
      const { item } = entry;
      const updated = utc(item.updatedAt);
      const status = itemStatusOf(item.status);
      const mapped = turnItemOfMendItem(item, {
        id: TurnItemId.make(item.id),
        threadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status,
        title: item.title,
        startedAt: utc(item.createdAt),
        completedAt: status === "running" ? null : updated,
        updatedAt: updated,
      });
      if (mapped === null) continue;
      out.items.push(mapped);
      if (mapped.type === "assistant_message") {
        out.messages.push({
          createdBy: "agent",
          creationSource: "provider",
          id: mapped.messageId,
          threadId,
          runId,
          nodeId: null,
          role: "assistant",
          text: mapped.text,
          attachments: [],
          streaming: mapped.streaming,
          createdAt: utc(item.createdAt),
          updatedAt: updated,
        });
      }
      continue;
    }
    const { request } = entry;
    const decided = request.decidedAt === null ? null : utc(request.decidedAt);
    out.items.push(
      turnItemOfRequest(request, {
        id: TurnItemId.make(`request:${request.id}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: requestItemStatusOf(request.status),
        title: request.title,
        startedAt: utc(request.createdAt),
        completedAt: decided,
        updatedAt: decided ?? utc(request.createdAt),
      }),
    );
  }

  // A turn that failed says why, after everything it did.
  if (turn.status === "failed" && turn.error !== null && turn.error.trim().length > 0) {
    const ended = utc(turn.endedAt ?? turn.createdAt);
    out.items.push({
      id: TurnItemId.make(`turn-error:${turn.id}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal + 1,
      status: "failed",
      title: null,
      startedAt: ended,
      completedAt: ended,
      updatedAt: ended,
      type: "error",
      failure: {
        class: "unknown",
        message: truncate(turn.error.trim(), 4_000),
        code: null,
        retryable: null,
      },
    });
  }
  return out;
};

/** A message in the gateway's queue: its user message, and why Mend refused it if it did. */
const pendingEntries = (
  source: ThreadSource,
  entry: ThreadSource["pending"][number],
  index: number,
): TurnEntries => {
  const threadId = threadIdOf(source.session);
  const providerThreadId = providerThreadIdOf(source.session);
  const runId = RunId.make(entry.runId);
  const messageId = MessageId.make(entry.messageId);
  const ordinalBase = (index + 1) * TURN_ORDINAL_STRIDE;
  const requested = utc(entry.requestedAt);
  const out: TurnEntries = { items: [], messages: [] };
  out.messages.push({
    createdBy: "user",
    creationSource: "web",
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: entry.text,
    attachments: [],
    streaming: false,
    createdAt: requested,
    updatedAt: requested,
  });
  out.items.push({
    id: userItemIdOf(runId),
    threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinalBase,
    status: "completed",
    title: null,
    startedAt: requested,
    completedAt: requested,
    updatedAt: requested,
    createdBy: "user",
    creationSource: "web",
    type: "user_message",
    messageId,
    inputIntent:
      entry.state === "queued" || entry.state === "cancelled" ? "queued_turn" : "turn_start",
    text: entry.text,
    attachments: [],
  });
  if (entry.state === "failed") {
    out.items.push({
      id: TurnItemId.make(`run-error:${entry.runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinalBase + 1,
      status: "failed",
      title: null,
      startedAt: requested,
      completedAt: requested,
      updatedAt: requested,
      type: "error",
      failure: {
        class: "unknown",
        message: truncate(nonEmpty(entry.error, "Mend did not take this message."), 4_000),
        code: null,
        retryable: null,
      },
    });
  }
  return out;
};

/**
 * What Mend says about people sharing the session's workspace (docs/adr/0016, decisions 6, 13 and
 * 14), as system notices: the waiting line right after the input of the turn that waits (it has
 * done nothing yet), and the shared-workspace and retirement lines after everything else, where
 * the thread stands now. A notice that no longer applies goes, and the client gets a snapshot.
 */
const noticeItems = (
  source: ThreadSource,
  turns: ReadonlyArray<MendTurn>,
): ReadonlyArray<OrchestrationV2TurnItem> => {
  const { notices } = source;
  const threadId = threadIdOf(source.session);
  const providerThreadId = providerThreadIdOf(source.session);
  // The block after every turn and every queued message.
  const endBase = (turns.length + source.pending.length + 1) * TURN_ORDINAL_STRIDE;
  const notice = (
    key: string,
    message: string,
    runId: RunId | null,
    ordinal: number,
    when: DateTime.Utc,
  ): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(`notice:${key}:${source.session.id}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: when,
    completedAt: when,
    updatedAt: when,
    type: "system_notice",
    message,
  });
  const out: Array<OrchestrationV2TurnItem> = [];
  const sessionAt = utc(source.session.updatedAt);
  if (notices.sharedWorkspace !== null) {
    out.push(notice("shared-workspace", notices.sharedWorkspace, null, endBase, sessionAt));
  }
  if (notices.retirement !== null) {
    out.push(notice("workspace-retirement", notices.retirement, null, endBase + 1, sessionAt));
  }
  const { waiting } = notices;
  if (waiting !== null) {
    const index = turns.findIndex((turn) => turn.id === waiting.turnId);
    const turn = turns[index];
    out.push(
      turn === undefined
        ? notice("waiting", waiting.line, null, endBase + 2, utc(waiting.since))
        : notice(
            "waiting",
            waiting.line,
            runIdOf(source, turn),
            // The last ordinal of the waiting turn's block: after its input, before anything
            // the turn does once it starts (by then the line is gone).
            (index + 2) * TURN_ORDINAL_STRIDE - 1,
            utc(waiting.since),
          ),
    );
  }
  return out;
};

const providerSessionOf = (
  source: ThreadSource,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2ProviderSession => {
  const provider = harnessProvider(source.session.harness);
  const active = runs.findLast((run) => isActiveRunStatus(run.status));
  const status: OrchestrationV2ProviderSession["status"] =
    source.agent.exitedAt !== null
      ? "stopped"
      : source.agent.status === "starting"
        ? "starting"
        : active?.status === "waiting"
          ? "waiting"
          : active !== undefined
            ? "running"
            : "ready";
  const thread = appThreadOf(source);
  return {
    id: providerSessionIdOf(source.session),
    driver: provider?.driver ?? ProviderDriverKind.make(source.session.harness),
    providerInstanceId: thread.providerInstanceId,
    status,
    cwd: worktreePathOf(source.project, source.session),
    model: thread.modelSelection.model,
    capabilities: MEND_PROVIDER_CAPABILITIES,
    createdAt: utc(source.agent.createdAt),
    updatedAt: thread.updatedAt,
    lastError: null,
  };
};

const providerThreadOf = (
  source: ThreadSource,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2ProviderThread => {
  const provider = harnessProvider(source.session.harness);
  const thread = appThreadOf(source);
  const driver = provider?.driver ?? ProviderDriverKind.make(source.session.harness);
  const nativeId = source.agent.providerSessionId?.trim() ?? "";
  return {
    id: providerThreadIdOf(source.session),
    driver,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: providerSessionIdOf(source.session),
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: nativeId.length === 0 ? null : { driver, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: runs.some((run) => isActiveRunStatus(run.status))
      ? "active"
      : source.agent.exitedAt === null
        ? "idle"
        : "not_loaded",
    firstRunOrdinal: runs.length === 0 ? null : 1,
    lastRunOrdinal: runs.length === 0 ? null : runs.length,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: utc(source.agent.createdAt),
    updatedAt: thread.updatedAt,
  };
};

/** Every turn item in timeline order, as t3code's projection keeps `visibleTurnItems`. */
const visibleOf = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> => {
  const cancelled = new Set(runs.filter((run) => run.status === "cancelled").map((run) => run.id));
  return items
    .filter(
      (item) =>
        !(
          item.type === "user_message" &&
          item.inputIntent === "queued_turn" &&
          item.runId !== null &&
          cancelled.has(item.runId)
        ),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    }));
};

export const threadProjectionOf = (
  source: ThreadSource,
  items: ReadonlyArray<MendItem>,
): OrchestrationV2ThreadProjection => {
  const runs = runsOf(source);
  const itemsByTurn = new Map<string, Array<MendItem>>();
  for (const item of items) {
    const list = itemsByTurn.get(item.turnId) ?? [];
    list.push(item);
    itemsByTurn.set(item.turnId, list);
  }
  const requestsByTurn = new Map<string, Array<MendRequest>>();
  for (const request of source.requests) {
    const list = requestsByTurn.get(request.turnId) ?? [];
    list.push(request);
    requestsByTurn.set(request.turnId, list);
  }
  const turnItems: Array<OrchestrationV2TurnItem> = [];
  const messages: Array<OrchestrationV2ConversationMessage> = [];
  const turns = source.turns.toSorted(byOrdinal);
  turns.forEach((turn, index) => {
    const entries = turnEntries(
      source,
      turn,
      index,
      itemsByTurn.get(turn.id) ?? [],
      requestsByTurn.get(turn.id) ?? [],
    );
    turnItems.push(...entries.items);
    messages.push(...entries.messages);
  });
  source.pending.forEach((entry, index) => {
    const entries = pendingEntries(source, entry, source.turns.length + index);
    turnItems.push(...entries.items);
    messages.push(...entries.messages);
  });
  turnItems.push(...noticeItems(source, turns));
  const thread = appThreadOf(source);
  const latestItem = items.reduce<DateTime.Utc>((latest, item) => {
    const updated = utc(item.updatedAt);
    return updated.epochMilliseconds > latest.epochMilliseconds ? updated : latest;
  }, thread.updatedAt);
  return {
    thread,
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [providerSessionOf(source, runs)],
    providerThreads: [providerThreadOf(source, runs)],
    providerTurns: [],
    runtimeRequests: runtimeRequestsOf(source),
    messages,
    plans: [],
    turnItems,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: visibleOf(turnItems, runs),
    updatedAt: latestItem,
  };
};

/** The newest turn ordinal in a projection: what t3code's bounded snapshot calls its watermark. */
export const latestLocalTurnOrdinalOf = (
  projection: OrchestrationV2ThreadProjection,
): number | null =>
  projection.turnItems.reduce<number | null>(
    (latest, item) => (latest === null || item.ordinal > latest ? item.ordinal : latest),
    null,
  );
