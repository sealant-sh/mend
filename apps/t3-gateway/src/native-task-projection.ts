import { AgentTaskData } from "@mend/domain/workbench";
import {
  NodeId,
  ProviderDriverKind,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import { Option, Schema } from "effect";

import type { MendItem } from "./mend-workbench.ts";
import { appThreadOf, turnNodeIdOf, utc, type ThreadSource } from "./shell.ts";

const decodeTask = Schema.decodeUnknownOption(AgentTaskData);
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Readonly<Record<string, unknown>> =>
  isObject(value) ? value : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;
/** Missing or invalid provider counters stay absent in T3. */
const count = (value: number | null): number | undefined =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const active = (status: OrchestrationV2Subagent["status"]): boolean =>
  status === "running" || status === "waiting" || status === "pending";

const workflowOf = (task: AgentTaskData): OrchestrationV2SubagentWorkflow => ({
  ...(text(task.workflow) === undefined ? {} : { name: task.workflow ?? undefined }),
  phases: task.phases.filter((phase) => phase.index >= 0 && phase.title.trim().length > 0),
  agents: task.agents
    .filter((agent) => agent.index >= 0)
    .map((agent) => ({
      index: agent.index,
      label: text(agent.label) ?? `Agent ${agent.index}`,
      state:
        agent.state === "done" || agent.state === "completed"
          ? "completed"
          : agent.state === "error" || agent.state === "failed"
            ? "failed"
            : agent.state === "queued"
              ? "queued"
              : agent.state === "running"
                ? "running"
                : "queued",
      phaseIndex: count(agent.phaseIndex),
      model: text(agent.model),
      totalTokens: count(agent.tokens),
      toolCalls: count(agent.toolCalls),
      durationMs: count(agent.durationMs),
      result: text(agent.preview),
    })),
  totalTokens: count(task.totalTokens),
  toolCalls: count(task.toolUses),
  durationMs: count(task.durationMs),
});

const taskStatusOf = (task: AgentTaskData): OrchestrationV2Subagent["status"] =>
  task.status === "stopped" ? "interrupted" : task.status === "paused" ? "waiting" : task.status;

const codexStatusOf = (state: unknown): OrchestrationV2Subagent["status"] => {
  switch (state) {
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "failed";
    case "shutdown":
    case "notFound":
      return "cancelled";
    case "pendingInit":
      return "pending";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
};

/** Native task cards and their graph nodes, with provider lifecycle rows folded into launch rows. */
export interface NativeTaskProjection {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}

/** Project recorded Claude task/workflow updates and Codex collaboration calls without inventing child transcripts. */
export const nativeTaskProjectionOf = (
  source: ThreadSource,
  items: ReadonlyArray<MendItem>,
  rows: ReadonlyArray<OrchestrationV2TurnItem>,
): NativeTaskProjection => {
  const thread = appThreadOf(source);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const launches = new Map(
    items.flatMap((item) => {
      const id = item.providerItemId ?? text(object(item.data)["id"]);
      return id === undefined ? [] : [[id, item] as const];
    }),
  );
  const driver = ProviderDriverKind.make(source.session.harness);
  const hidden = new Set<string>();
  const cards = new Map<
    string,
    { readonly itemId: string; readonly agent: OrchestrationV2Subagent }
  >();
  const pending = new Map<string, OrchestrationV2PendingBackgroundTask>();
  const correlated = new Set<string>();
  const taskRows = new Map<string, OrchestrationV2TurnItem>();
  const tasks = items.flatMap((item) => {
    if (item.kind !== "task") return [];
    const decoded = decodeTask(item.data);
    return Option.isSome(decoded) && decoded.value.taskId.trim().length > 0
      ? [{ item, task: decoded.value }]
      : [];
  });
  const make = (
    item: MendItem,
    anchor: MendItem,
    nativeId: string | null,
    status: OrchestrationV2Subagent["status"],
    prompt: string,
    title: string | null,
    result: string | null,
  ): OrchestrationV2Subagent | null => {
    const row = byId.get(anchor.id);
    if (row === undefined) return null;
    const run = source.turns.find((turn) => turn.id === anchor.turnId);
    const terminal = run?.status;
    const settledStatus =
      active(status) &&
      (source.agent.exitedAt !== null ||
        (nativeId === null &&
          (terminal === "interrupted" || terminal === "cancelled" || terminal === "failed")))
        ? terminal === "failed"
          ? "failed"
          : "interrupted"
        : status;
    return {
      id: NodeId.make(`native-task:${anchor.id}`),
      threadId: thread.id,
      runId: row.runId,
      parentNodeId: turnNodeIdOf(anchor.turnId),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: thread.providerInstanceId,
      providerThreadId: row.providerThreadId ?? null,
      childThreadId: null,
      nativeTaskRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
      prompt,
      title,
      model: text(object(object(anchor.data)["input"])["model"]) ?? null,
      status: settledStatus,
      result,
      startedAt: utc(anchor.createdAt),
      completedAt: active(settledStatus)
        ? null
        : utc(settledStatus === status ? item.updatedAt : (run?.endedAt ?? item.updatedAt)),
      updatedAt: utc(item.updatedAt),
    };
  };

  for (const { item, task } of tasks) {
    if (task.taskType !== "local_workflow" && task.taskType !== "local_agent") {
      const row = byId.get(item.id);
      if (row !== undefined)
        taskRows.set(item.id, {
          ...row,
          nativeItemRef: { driver, nativeId: task.taskId, strength: "strong" },
          status: taskStatusOf(task),
        });
      if (active(taskStatusOf(task)) && source.agent.exitedAt === null)
        pending.set(task.taskId, {
          kind:
            task.taskType === "local_bash"
              ? "command"
              : task.taskType === "local_monitor"
                ? "monitor"
                : "background_task",
          taskId: task.taskId,
          description: text(task.description),
        });
      continue;
    }
    const launch = task.toolUseId == null ? undefined : launches.get(task.toolUseId);
    const anchor = launch ?? item;
    correlated.add(anchor.id);
    if (anchor !== item) hidden.add(item.id);
    const input = object(object(anchor.data)["input"]);
    const agent = make(
      item,
      anchor,
      task.taskId,
      taskStatusOf(task),
      text(input["prompt"]) ?? "",
      text(task.description) ?? anchor.title,
      task.error ?? task.summary,
    );
    if (agent === null) continue;
    cards.set(`claude:${task.taskId}`, {
      itemId: anchor.id,
      agent: {
        ...agent,
        ...(task.taskType === "local_workflow" ? { workflow: workflowOf(task) } : {}),
        ...(text(item.text) === undefined ? {} : { progress: item.text ?? undefined }),
      },
    });
  }
  for (const item of items.toSorted((a, b) => a.seq - b.seq)) {
    const data = object(item.data);
    if (data["parentToolUseId"] != null) continue;
    const name = data["name"] ?? item.title;
    if ((name === "Agent" || name === "Task" || name === "Workflow") && !correlated.has(item.id)) {
      const input = object(data["input"]);
      const status =
        item.status === "in-progress"
          ? "running"
          : item.status === "failed"
            ? "failed"
            : "completed";
      const agent = make(
        item,
        item,
        null,
        status,
        text(input["prompt"]) ?? "",
        text(input["description"]) ?? item.title,
        item.text,
      );
      if (agent !== null) cards.set(`tool:${item.id}`, { itemId: item.id, agent });
    }
    if (data["type"] !== "collabAgentToolCall") continue;
    const states = object(data["agentsStates"]);
    const receivers = Array.isArray(data["receiverThreadIds"])
      ? data["receiverThreadIds"].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : Object.keys(states);
    let folded = false;
    for (const receiver of receivers) {
      const key = `codex:${receiver}`;
      const previous = cards.get(key);
      const state = object(states[receiver]);
      if (previous !== undefined) {
        const anchor = items.find((candidate) => candidate.id === previous.itemId);
        if (anchor === undefined) continue;
        const agent = make(
          item,
          anchor,
          receiver,
          codexStatusOf(state["status"]),
          previous.agent.prompt,
          previous.agent.title,
          text(state["message"]) ?? previous.agent.result,
        );
        if (agent !== null) cards.set(key, { itemId: previous.itemId, agent });
        folded = true;
      } else if (data["tool"] === "spawnAgent") {
        const agent = make(
          item,
          item,
          receiver,
          codexStatusOf(state["status"]),
          text(data["prompt"]) ?? "",
          item.title,
          text(state["message"]) ?? null,
        );
        if (agent !== null) cards.set(key, { itemId: item.id, agent });
      }
    }
    if (folded && data["tool"] !== "spawnAgent") hidden.add(item.id);
  }
  const mapped = new Map<string, OrchestrationV2TurnItem>();
  const nodes: Array<OrchestrationV2ExecutionNode> = [];
  for (const { itemId, agent } of cards.values()) {
    const row = byId.get(itemId);
    if (row === undefined) continue;
    mapped.set(itemId, {
      id: row.id,
      threadId: row.threadId,
      runId: row.runId,
      providerThreadId: row.providerThreadId ?? null,
      providerTurnId: row.providerTurnId ?? null,
      parentItemId: row.parentItemId ?? null,
      ordinal: row.ordinal,
      startedAt: agent.startedAt,
      type: "subagent",
      nodeId: agent.id,
      nativeItemRef: agent.nativeTaskRef,
      status: agent.status,
      title: agent.title,
      completedAt: agent.completedAt,
      updatedAt: agent.updatedAt,
      subagentId: agent.id,
      origin: agent.origin,
      driver: agent.driver,
      providerInstanceId: agent.providerInstanceId,
      childThreadId: null,
      prompt: agent.prompt,
      result: agent.result,
      ...(agent.progress === undefined ? {} : { progress: agent.progress }),
    });
    nodes.push({
      id: agent.id,
      threadId: agent.threadId,
      runId: agent.runId,
      parentNodeId: agent.parentNodeId,
      rootNodeId: agent.parentNodeId,
      kind: "subagent",
      status: agent.status,
      countsForRun: false,
      providerThreadId: agent.providerThreadId,
      providerTurnId: row.providerTurnId ?? null,
      nativeItemRef: agent.nativeTaskRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
    });
    if (active(agent.status) && agent.nativeTaskRef?.nativeId != null)
      pending.set(agent.nativeTaskRef.nativeId, {
        kind: "subagent",
        taskId: agent.nativeTaskRef.nativeId,
        description: text(agent.title),
        providerInstanceId: agent.providerInstanceId,
      });
  }
  return {
    subagents: Array.from(cards.values(), ({ agent }) => agent),
    nodes,
    turnItems: rows
      .filter((row) => !hidden.has(row.id))
      .map((row) => mapped.get(row.id) ?? taskRows.get(row.id) ?? row),
    pendingBackgroundTasks: Array.from(pending.values()),
  };
};
