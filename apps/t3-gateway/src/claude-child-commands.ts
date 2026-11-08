import type { OrchestrationV2TurnItem } from "@mend/t3-contracts";
import { DateTime, Option, Schema } from "effect";

import type { MendItem, MendTurn } from "./mend-workbench.ts";
import { utc } from "./shell.ts";

const childOf = Schema.decodeUnknownOption(Schema.Struct({ parentToolUseId: Schema.String }));
const agentOf = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    name: Schema.Literals(["Agent", "Task"]),
    input: Schema.optionalKey(
      Schema.Struct({ run_in_background: Schema.optionalKey(Schema.Boolean) }),
    ),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
);
const taskOf = Schema.decodeUnknownOption(
  Schema.Struct({
    toolUseId: Schema.String,
    status: Schema.Literals(["running", "paused", "completed", "failed", "stopped"]),
  }),
);
type Ending = { readonly status: "failed" | "interrupted"; readonly at: DateTime.Utc };

/**
 * T3 v0.1.2 ends unresolved child calls when their native agent ends. Missing results are
 * failures, even after a successful agent; a stopped agent interrupts them. This is a view of
 * the retained record, so both live reads and reopened threads get the same settlement.
 */
export const settleClaudeChildCommands = (
  items: ReadonlyArray<MendItem>,
  turns: ReadonlyArray<MendTurn>,
  projected: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> => {
  const endings = new Map<string, Ending | null>();
  const agents = new Map<string, MendItem>();
  for (const item of items) {
    if (item.kind === "task") {
      const parsed = taskOf(item.data);
      if (Option.isNone(parsed)) continue;
      const task = parsed.value;
      endings.set(
        task.toolUseId,
        task.status === "running" || task.status === "paused"
          ? null
          : {
              status: task.status === "stopped" ? "interrupted" : "failed",
              at: utc(item.updatedAt),
            },
      );
    } else if (item.kind === "tool-call") {
      const parsed = agentOf(item.data);
      if (Option.isNone(parsed)) continue;
      agents.set(parsed.value.id, item);
      // A background launch's result is an acknowledgement, not the end of the agent.
      if (item.status === "in-progress" || parsed.value.input?.run_in_background === true) continue;
      if (!endings.has(parsed.value.id))
        endings.set(parsed.value.id, {
          status: item.status === "declined" ? "interrupted" : "failed",
          at: utc(item.updatedAt),
        });
    }
  }
  const endingOf = (parent: string): Ending | null => {
    const seen = new Set<string>();
    let current: string | undefined = parent;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const ending = endings.get(current);
      if (ending !== undefined && ending !== null) return ending;
      const ancestor = childOf(agents.get(current)?.data);
      current = Option.isSome(ancestor) ? ancestor.value.parentToolUseId : undefined;
    }
    return null;
  };
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const records = new Map(items.map((item) => [item.id, item]));
  return projected.map((item) => {
    if (item.type !== "command_execution" || item.status !== "running") return item;
    const record = records.get(item.id);
    const child = childOf(record?.data);
    if (record === undefined || Option.isNone(child)) return item;
    const turn = turnsById.get(record.turnId);
    const ending: Ending | null =
      turn?.status === "interrupted" || turn?.status === "failed"
        ? { status: turn.status, at: utc(turn.endedAt ?? turn.createdAt) }
        : endingOf(child.value.parentToolUseId);
    if (ending === null) return item;
    const at = DateTime.max(item.updatedAt, ending.at);
    return { ...item, status: ending.status, completedAt: at, updatedAt: at };
  });
};
