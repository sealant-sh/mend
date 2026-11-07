import {
  PlanId,
  TurnItemId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import { Option, Schema } from "effect";

import type { MendItem } from "./mend-workbench.ts";

const TaskCall = Schema.Struct({
  name: Schema.Literals(["TaskCreate", "TaskUpdate", "TaskList"]),
  input: Schema.optional(Schema.Unknown),
  result: Schema.Unknown,
});
const callOf = Schema.decodeUnknownOption(TaskCall);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
const word = (value: unknown, key: string): string | undefined => {
  const text = field(value, key);
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
};
const statusOf = (value: unknown): OrchestrationV2PlanStep["status"] | undefined =>
  value === "pending"
    ? "pending"
    : value === "in_progress"
      ? "running"
      : value === "completed"
        ? "completed"
        : undefined;

const applyTask = (
  tasks: Map<string, OrchestrationV2PlanStep>,
  call: typeof TaskCall.Type,
): boolean => {
  const { name, input, result } = call;
  if (name === "TaskList") {
    const listed = field(result, "tasks");
    if (!Array.isArray(listed)) return false;
    const hadTasks = tasks.size > 0;
    tasks.clear();
    for (const task of listed) {
      const id = word(task, "id");
      const text = word(task, "subject");
      const status = statusOf(field(task, "status"));
      if (id !== undefined && text !== undefined && status !== undefined)
        tasks.set(id, { id, text, status });
    }
    return hadTasks || tasks.size > 0;
  }
  if (name === "TaskCreate") {
    const created = field(result, "task");
    const match =
      typeof result === "string" ? /^Task #(\S+) created successfully: (.+)$/s.exec(result) : null;
    const id = word(created, "id") ?? match?.[1];
    const text = word(created, "subject") ?? match?.[2]?.trim() ?? word(input, "subject");
    if (id === undefined || text === undefined || text.length === 0) return false;
    tasks.set(id, { id, text, status: "pending" });
    return true;
  }
  if (
    field(result, "success") === false ||
    (typeof result === "string" && !result.startsWith("Updated task #"))
  )
    return false;
  const id = word(input, "taskId") ?? word(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return false;
  if (field(input, "status") === "deleted") return tasks.delete(id);
  const text = word(input, "subject") ?? task.text;
  const status = statusOf(field(input, "status")) ?? task.status;
  if (text === task.text && status === task.status) return false;
  tasks.set(id, { id, text, status });
  return true;
};

/** Replay the shared Claude task list into one stable checklist for each turn that changes it. */
export const claudeTaskListsOf = (
  recorded: ReadonlyArray<MendItem>,
  projected: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> => {
  const byId = new Map(recorded.map((item) => [item.id, item]));
  const tasks = new Map<string, OrchestrationV2PlanStep>();
  const lists = new Map<string, Extract<OrchestrationV2TurnItem, { type: "todo_list" }>>();
  for (const base of projected.toSorted((a, b) => a.ordinal - b.ordinal)) {
    if (base.type !== "dynamic_tool") continue;
    const item = byId.get(base.id);
    if (item === undefined || item.status !== "completed") continue;
    const call = callOf(item.data);
    if (Option.isNone(call) || call.value.result === undefined || !applyTask(tasks, call.value))
      continue;
    const previous = lists.get(item.turnId);
    lists.set(item.turnId, {
      ...base,
      type: "todo_list",
      id: TurnItemId.make(`claude-tasks:${item.turnId}`),
      planId: PlanId.make(`todo:claude-tasks:${item.turnId}`),
      title: "Tasks",
      ordinal: previous?.ordinal ?? base.ordinal,
      startedAt: previous?.startedAt ?? base.startedAt,
      steps: [...tasks.values()],
    });
  }
  return [...lists.values()];
};
