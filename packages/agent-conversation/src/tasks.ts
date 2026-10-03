import type { AgentItemDto, AgentTurnDto } from "./feed.ts";
import { sortedCopy } from "./order.ts";

/**
 * A background task the agent started — a workflow, a background agent or command — read from a
 * `task` item's `data`. The server records it in one shape whatever the harness (the domain's
 * `AgentTaskData`); this is the reader's side, checked field by field because the phone reads raw
 * JSON. Like the rest of this package it keeps to array methods the phone's runtime has.
 */

export interface AgentTaskAgentView {
  readonly index: number;
  readonly label: string;
  readonly phaseIndex: number | null;
  /** `queued`, `running`, `done` or `error`, as the harness last reported it. */
  readonly state: string;
  readonly model: string | null;
  readonly tokens: number | null;
  readonly toolCalls: number | null;
  readonly durationMs: number | null;
  readonly lastTool: string | null;
  /** The start of the agent's result, or of its error. */
  readonly preview: string | null;
}

export interface AgentTaskPhaseView {
  readonly index: number;
  readonly title: string;
}

export interface AgentTaskView {
  readonly taskId: string;
  readonly taskType: string;
  readonly workflow: string | null;
  readonly description: string;
  /** `running`, `completed`, `failed`, `stopped` or `paused`. */
  readonly status: string;
  readonly summary: string | null;
  readonly error: string | null;
  readonly phases: ReadonlyArray<AgentTaskPhaseView>;
  readonly agents: ReadonlyArray<AgentTaskAgentView>;
  readonly totalTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
}

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};

const count = (row: Row, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const parseAgent = (value: unknown): AgentTaskAgentView | null => {
  if (!isRow(value)) return null;
  const index = count(value, "index");
  const label = text(value, "label");
  const state = text(value, "state");
  if (index === null || label === null || state === null) return null;
  return {
    index,
    label,
    phaseIndex: count(value, "phaseIndex"),
    state,
    model: text(value, "model"),
    tokens: count(value, "tokens"),
    toolCalls: count(value, "toolCalls"),
    durationMs: count(value, "durationMs"),
    lastTool: text(value, "lastTool"),
    preview: text(value, "preview"),
  };
};

const parsePhase = (value: unknown): AgentTaskPhaseView | null => {
  if (!isRow(value)) return null;
  const index = count(value, "index");
  const title = text(value, "title");
  return index === null || title === null ? null : { index, title };
};

const present = <T>(values: ReadonlyArray<T | null>): ReadonlyArray<T> =>
  values.filter((value): value is T => value !== null);

/** The task a `task` item records; null for any other item, or data this reader cannot read. */
export const agentTaskOf = (item: AgentItemDto): AgentTaskView | null => {
  if (item.kind !== "task" || !isRow(item.data)) return null;
  const data = item.data;
  const taskId = text(data, "taskId");
  const taskType = text(data, "taskType");
  const status = text(data, "status");
  if (taskId === null || taskType === null || status === null) return null;
  const phases = Array.isArray(data["phases"]) ? present(data["phases"].map(parsePhase)) : [];
  const agents = Array.isArray(data["agents"]) ? present(data["agents"].map(parseAgent)) : [];
  return {
    taskId,
    taskType,
    workflow: text(data, "workflow"),
    description: text(data, "description") ?? "",
    status,
    summary: text(data, "summary"),
    error: text(data, "error"),
    phases,
    agents,
    totalTokens: count(data, "totalTokens"),
    toolUses: count(data, "toolUses"),
    durationMs: count(data, "durationMs"),
  };
};

/** What kind of task it is, in a word or two. */
export const taskKindName = (task: AgentTaskView): string => {
  switch (task.taskType) {
    case "local_workflow":
      return "Workflow";
    case "local_agent":
      return "Background agent";
    case "local_bash":
      return "Background command";
    default:
      return "Background task";
  }
};

export interface AgentTaskPhaseGroup {
  /** Null for agents no phase claims (a workflow without phases). */
  readonly title: string | null;
  readonly agents: ReadonlyArray<AgentTaskAgentView>;
}

/** The workflow's agents under their phases, in phase order, each phase's agents in order. */
const byIndex = (a: { readonly index: number }, b: { readonly index: number }): number =>
  a.index - b.index;

export const taskPhaseGroups = (task: AgentTaskView): ReadonlyArray<AgentTaskPhaseGroup> => {
  const agents = sortedCopy(task.agents, byIndex);
  const phases = sortedCopy(task.phases, byIndex);
  const known = new Set(phases.map((phase) => phase.index));
  const loose = agents.filter((agent) => agent.phaseIndex === null || !known.has(agent.phaseIndex));
  const groups: Array<AgentTaskPhaseGroup> = [];
  if (loose.length > 0) groups.push({ title: null, agents: loose });
  for (const phase of phases) {
    groups.push({
      title: phase.title,
      agents: agents.filter((agent) => agent.phaseIndex === phase.index),
    });
  }
  return groups;
};

/** `21.6k` for 21,635: a token count at a glance. */
export const compactCount = (value: number): string => {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

/** No-break space: a number and its unit never part at a line end. */
const NB = "\u00a0";

/** `3.1 s`, `4 min 12 s`, `1 h 3 min`, each number held to its unit. */
export const durationWords = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}${NB}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}${NB}min ${Math.floor((ms % 60_000) / 1000)}${NB}s`;
  return `${Math.floor(minutes / 60)}${NB}h ${minutes % 60}${NB}min`;
};

/** `claude-haiku-4-5-20251001` reads as `haiku-4-5`. */
export const shortModel = (model: string): string =>
  model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

/** The facts of the whole task, one mono line: agents done, tokens, tool calls, time. */
export const taskFacts = (task: AgentTaskView): string => {
  const parts: Array<string> = [];
  if (task.agents.length > 0) {
    const done = task.agents.filter((agent) => agent.state === "done").length;
    parts.push(`${done}/${task.agents.length} agents done`);
  }
  if (task.totalTokens !== null && task.totalTokens > 0) {
    parts.push(`${compactCount(task.totalTokens)} tokens`);
  }
  if (task.toolUses !== null && task.toolUses > 0) parts.push(`${task.toolUses} tool calls`);
  if (task.durationMs !== null && task.durationMs > 0) parts.push(durationWords(task.durationMs));
  return parts.join(" · ");
};

/** One agent's facts: model, tokens, tool calls, and what it is doing while it runs. */
export const agentFacts = (agent: AgentTaskAgentView): string => {
  const parts: Array<string> = [];
  if (agent.model !== null) parts.push(shortModel(agent.model));
  if (agent.tokens !== null && agent.tokens > 0) parts.push(`${compactCount(agent.tokens)} tokens`);
  if (agent.toolCalls !== null && agent.toolCalls > 0) parts.push(`${agent.toolCalls} tools`);
  if (agent.state === "running" && agent.lastTool !== null) parts.push(agent.lastTool);
  if (agent.state === "done" && agent.durationMs !== null) {
    parts.push(durationWords(agent.durationMs));
  }
  return parts.join(" · ");
};

/** A turn the agent opened on its own, answering a background task that ended. */
export const isHarnessTurn = (turn: Pick<AgentTurnDto, "origin">): boolean =>
  turn.origin === "harness";
