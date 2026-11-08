import type { AgentEventItem } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

const taskCallOf = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.Literals(["TaskCreate", "TaskUpdate", "TaskList"]) }),
);
const textBlocksOf = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
);

/** Keep executed Claude task results, including child calls, for durable checklist replay. */
export const withClaudeTaskToolResult = (
  item: AgentEventItem,
  output: unknown,
  failed: boolean,
  structured?: unknown,
): AgentEventItem | null => {
  if (Option.isNone(taskCallOf(item.data))) return null;
  const data = item.data;
  if (typeof data !== "object" || data === null) return null;
  const blocks = textBlocksOf(output);
  const result =
    structured ??
    (Option.isSome(blocks)
      ? blocks.value
          .flatMap((block) =>
            block.type === "text" && block.text !== undefined ? [block.text] : [],
          )
          .join("\n")
      : output);
  return { ...item, status: failed ? "failed" : "completed", data: { ...data, result } };
};
