import type {
  AgentEventItem,
  AgentItemStatus,
  AgentTaskAgent,
  AgentTaskData,
  AgentTaskStatus,
} from "@mend/domain/workbench";

/**
 * Claude's background tasks as Mend records them. Claude reports each task (a workflow, a
 * background agent or command) on `system` lines: `task_started`, `task_progress` (a workflow's
 * carries its phases and agents), `task_updated` and `task_notification`. They keep arriving after
 * the turn that started the task has ended, so the item stays on that turn and grows there.
 */

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: JsonObject, key: string): string | null => {
  const field = value[key];
  return typeof field === "string" ? field : null;
};

const intOf = (value: JsonObject, key: string): number | null => {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : null;
};

/** Agent previews are for a glance; the record keeps the full result. */
const PREVIEW_LIMIT = 240;

const preview = (text: string | null): string | null =>
  text === null || text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT - 1)}…`;

/** The task subtypes this module folds; every other `system` line is not a task's. */
export const isTaskSubtype = (subtype: string | null): boolean =>
  subtype === "task_started" ||
  subtype === "task_progress" ||
  subtype === "task_updated" ||
  subtype === "task_notification";

const taskStatus = (raw: string | null): AgentTaskStatus | null => {
  switch (raw) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    case "paused":
      return "paused";
    default:
      return null;
  }
};

/**
 * A workflow agent's state, in words a reader needs: queued, running, done or error. Claude says
 * `start` (queued until it has a start time), `progress`, `done` or `error`.
 */
const agentState = (entry: JsonObject): string => {
  if (entry["blocked"] === true) return "error";
  const state = stringOf(entry, "state");
  if (state === "start") return entry["startedAt"] === undefined ? "queued" : "running";
  if (state === "progress" || state === null) return "running";
  return state;
};

const workflowAgent = (entry: JsonObject): AgentTaskAgent | null => {
  const index = intOf(entry, "index");
  if (index === null) return null;
  return {
    index,
    label: stringOf(entry, "label") ?? `agent ${index}`,
    phaseIndex: intOf(entry, "phaseIndex"),
    state: agentState(entry),
    model: stringOf(entry, "model"),
    tokens: intOf(entry, "tokens"),
    toolCalls: intOf(entry, "toolCalls"),
    durationMs: intOf(entry, "durationMs"),
    lastTool: stringOf(entry, "lastToolName"),
    preview: preview(stringOf(entry, "error") ?? stringOf(entry, "resultPreview")),
  };
};

/** Phases and agents from a `workflow_progress` snapshot; null when the line carries none. */
const workflowProgress = (value: unknown): Pick<AgentTaskData, "phases" | "agents"> | null => {
  if (!Array.isArray(value)) return null;
  const phases: Array<AgentTaskData["phases"][number]> = [];
  const agents: Array<AgentTaskAgent> = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const type = stringOf(entry, "type");
    if (type === "workflow_phase") {
      const index = intOf(entry, "index");
      const title = stringOf(entry, "title");
      if (index !== null && title !== null) phases.push({ index, title });
    } else if (type === "workflow_agent") {
      const agent = workflowAgent(entry);
      if (agent !== null) agents.push(agent);
    }
  }
  return {
    phases: phases.toSorted((a, b) => a.index - b.index),
    agents: agents.toSorted((a, b) => a.index - b.index),
  };
};

const withUsage = (data: AgentTaskData, usage: unknown): AgentTaskData =>
  isObject(usage)
    ? {
        ...data,
        totalTokens: intOf(usage, "total_tokens") ?? data.totalTokens,
        toolUses: intOf(usage, "tool_uses") ?? data.toolUses,
        durationMs: intOf(usage, "duration_ms") ?? data.durationMs,
      }
    : data;

const started = (taskId: string, message: JsonObject): AgentTaskData => ({
  taskId,
  taskType: stringOf(message, "task_type") ?? "task",
  workflow: stringOf(message, "workflow_name"),
  description: stringOf(message, "description") ?? "",
  status: "running",
  summary: null,
  error: null,
  phases: [],
  agents: [],
  totalTokens: null,
  toolUses: null,
  durationMs: null,
});

/**
 * Fold one task line into what is known of the task. A line for a task never seen starting (one
 * started before Mend attached) starts it from what the line itself says.
 */
export const foldTaskLine = (
  previous: AgentTaskData | undefined,
  subtype: string,
  message: JsonObject,
): AgentTaskData | null => {
  const taskId = stringOf(message, "task_id");
  if (taskId === null) return null;
  const base = previous ?? started(taskId, message);
  switch (subtype) {
    case "task_started":
      return previous === undefined ? base : { ...previous, status: "running" };
    case "task_progress": {
      const progress = workflowProgress(message["workflow_progress"]);
      return withUsage(progress === null ? base : { ...base, ...progress }, message["usage"]);
    }
    case "task_updated": {
      const patch = message["patch"];
      if (!isObject(patch)) return base;
      return {
        ...base,
        status: taskStatus(stringOf(patch, "status")) ?? base.status,
        description: stringOf(patch, "description") ?? base.description,
        error: stringOf(patch, "error") ?? base.error,
      };
    }
    case "task_notification":
      return withUsage(
        {
          ...base,
          status: taskStatus(stringOf(message, "status")) ?? base.status,
          summary: stringOf(message, "summary") ?? base.summary,
        },
        message["usage"],
      );
    default:
      return null;
  }
};

const itemStatus = (status: AgentTaskStatus): AgentItemStatus => {
  switch (status) {
    case "running":
    case "paused":
      return "in-progress";
    case "failed":
      return "failed";
    case "completed":
    case "stopped":
      return "completed";
  }
};

const taskTitle = (data: AgentTaskData): string => {
  switch (data.taskType) {
    case "local_workflow":
      return data.workflow === null ? "Workflow" : `Workflow ${data.workflow}`;
    case "local_agent":
      return "Background agent";
    case "local_bash":
      return "Background command";
    default:
      return "Background task";
  }
};

/** One line a renderer that knows nothing of tasks can still show. */
const taskText = (data: AgentTaskData): string => {
  const parts = [data.description];
  if (data.agents.length > 0) {
    const done = data.agents.filter((agent) => agent.state === "done").length;
    parts.push(`${done}/${data.agents.length} agents done`);
  }
  if (data.totalTokens !== null) parts.push(`${data.totalTokens} tokens`);
  parts.push(data.summary ?? data.status);
  return parts.filter((part) => part !== "").join(" · ");
};

export const taskItemId = (taskId: string): string => `task:${taskId}`;

/** The task as an item on the turn that started it. */
export const taskItem = (data: AgentTaskData, providerTurnId: string): AgentEventItem => ({
  providerItemId: taskItemId(data.taskId),
  providerTurnId,
  kind: "task",
  status: itemStatus(data.status),
  title: taskTitle(data),
  text: taskText(data),
  data,
});
