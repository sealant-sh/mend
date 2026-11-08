import type { AgentEventItem } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

const Streams = Schema.Struct({
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  interrupted: Schema.optionalKey(Schema.Boolean),
});
const streamsOf = Schema.decodeUnknownOption(Streams);
const TextBlocks = Schema.Array(
  Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
);
const blocksOf = Schema.decodeUnknownOption(TextBlocks);

const textOf = (output: unknown): string => {
  if (typeof output === "string") return output;
  const blocks = blocksOf(output);
  return Option.isNone(blocks)
    ? ""
    : blocks.value
        .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
        .join("\n");
};

/** Claude sends Bash/Shell output with the result, after its tool-input block has ended. */
export const withClaudeCommandResult = (
  item: AgentEventItem,
  output: unknown,
  failed: boolean,
  structured?: unknown,
): AgentEventItem | null => {
  if (item.kind !== "command-execution") return null;
  const parsed = streamsOf(structured ?? output);
  const streams = Option.isSome(parsed) ? parsed.value : null;
  const stdout = streams?.stdout?.trim() ? streams.stdout : "";
  const stderr = streams?.stderr?.trim() ? streams.stderr : "";
  const text =
    stdout.length > 0 && stderr.length > 0 && !stdout.endsWith("\n")
      ? `${stdout}\n${stderr}`
      : stdout + stderr;
  return {
    ...item,
    status: failed || streams?.interrupted === true ? "failed" : "completed",
    text: text.length > 0 ? text : textOf(output),
  };
};
