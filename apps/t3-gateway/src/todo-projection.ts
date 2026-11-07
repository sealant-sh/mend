import {
  PlanId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MendItem } from "./mend-workbench.ts";

const Step = Schema.Struct({
  id: Schema.optional(Schema.String),
  step: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  status: Schema.Literals(["pending", "in_progress", "inProgress", "running", "completed"]),
});
const decode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    explanation: Schema.optional(Schema.NullOr(Schema.String)),
    plan: Schema.optional(Schema.Array(Step)),
    steps: Schema.optional(Schema.Array(Step)),
    input: Schema.optional(Schema.Struct({ todos: Schema.Array(Step) })),
  }),
);

/** Recorded native plan updates and Claude TodoWrite calls share T3's checklist shape. */
export const todoListOf = (
  item: MendItem,
): Pick<
  Extract<OrchestrationV2TurnItem, { type: "todo_list" }>,
  "planId" | "steps" | "explanation"
> | null => {
  const parsed = decode(item.data);
  if (Option.isNone(parsed)) return null;
  const data = parsed.value;
  const native = data.type === "todoList" || (item.kind === "plan" && data.type !== "plan");
  const claude = data.name === "TodoWrite";
  if (!native && !claude) return null;
  const entries = claude ? data.input?.todos : (data.plan ?? data.steps);
  if (entries === undefined) return null;
  const steps: Array<OrchestrationV2PlanStep> = [];
  for (const [index, step] of entries.entries()) {
    const text = (step.step ?? step.content ?? step.text)?.trim();
    if (text === undefined || text.length === 0) return null;
    steps.push({
      id: step.id?.trim() || `step-${index + 1}`,
      text,
      status:
        step.status === "completed"
          ? "completed"
          : step.status === "pending"
            ? "pending"
            : "running",
    });
  }
  return {
    planId: PlanId.make(`todo:${item.id}`),
    steps,
    ...(data.explanation == null ? {} : { explanation: data.explanation }),
  };
};

/** Plan artifacts accompany checklist timeline items so T3 can show its progress badge. */
export const todoPlansOf = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2PlanArtifact> =>
  items.flatMap(
    (item): ReadonlyArray<OrchestrationV2PlanArtifact> =>
      item.type !== "todo_list" || item.nodeId === null
        ? []
        : [
            {
              id: item.planId,
              threadId: item.threadId,
              runId: item.runId,
              nodeId: item.nodeId,
              kind: "todo_list",
              status:
                item.steps.length > 0 && item.steps.every((step) => step.status === "completed")
                  ? "completed"
                  : "active",
              steps: item.steps,
              ...(item.explanation === undefined ? {} : { explanation: item.explanation }),
            },
          ],
  );
