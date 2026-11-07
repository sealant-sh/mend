import { Context, Effect, Layer, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";

import { OrganizationExecutor } from "../executor/executor.ts";
import { asCaller } from "./caller.ts";

const Call = Schema.Struct({ path: Schema.String, input: Schema.Json });
/** Executor v2's six discovery/call tools, with Mend owning the approval response. */
export const EXECUTOR_MCP_TOOLS = [
  {
    name: "skills",
    description:
      "Read Executor service instructions. Start with {app:'executor',name:'executor'}. {} lists visible skills. Accounts and tools use this session caller's link, or Mend's member.",
    schema: Schema.Struct({
      app: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      file: Schema.optionalKey(Schema.String),
      version: Schema.optionalKey(Schema.String),
      revision: Schema.optionalKey(Schema.String),
    }),
  },
  {
    name: "search",
    description:
      "Find service tool paths in the organization's Executor. Use these exact paths with executor_describe, executor_call or executor_execute.",
    schema: Schema.Struct({
      query: Schema.optionalKey(Schema.String),
      namespace: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int),
      offset: Schema.optionalKey(Schema.Int),
    }),
  },
  {
    name: "describe",
    description:
      "Read full input and output signatures for exact Executor tool paths returned by executor_search.",
    schema: Schema.Struct({ paths: Schema.Array(Schema.String) }),
  },
  {
    name: "call",
    description:
      "Call one or several independent service tools through Executor. A held call waits for a person in Mend. Read it with executor_resume; never submit an approval response or repeat a mutation to continue it.",
    schema: Schema.Struct({ calls: Schema.Union([Call, Schema.Array(Call)]) }),
  },
  {
    name: "execute",
    description:
      "Run an Executor JavaScript program where one service result feeds another. Read its code-mode skill first. A program cannot approve calls. Mend holds approvals for a person; use executor_resume with requestId alone to read the answer.",
    schema: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(65_536)) }),
  },
  {
    name: "resume",
    description:
      "Read the saved outcome of a held Executor call in this session. Pass only the Mend requestId. Approval and denial happen in Mend, by a person. A call expires after 15 minutes; do not rerun a mutation without checking its service.",
    schema: Schema.Struct({ requestId: Schema.String }),
  },
] as const;

export const ExecutorToolsLive: Layer.Layer<never, never, OrganizationExecutor> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const executor = yield* OrganizationExecutor;
      for (const entry of EXECUTOR_MCP_TOOLS) {
        const json = Schema.toJsonSchemaDocument(entry.schema);
        const inputSchema = Schema.decodeUnknownSync(McpSchema.ToolJson)(
          Object.keys(json.definitions).length === 0
            ? json.schema
            : { ...json.schema, $defs: json.definitions },
        );
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: `executor_${entry.name}`,
            title: `Executor ${entry.name}`,
            description: entry.description,
            inputSchema,
            annotations: {
              readOnlyHint: ["skills", "search", "describe", "resume"].includes(entry.name),
              openWorldHint: true,
            },
          }),
          annotations: Context.empty(),
          // Keep resume's raw response field visible here so an agent's attempted approval is refused,
          // rather than stripped by decoding into the collector-only advertised schema.
          handle: asCaller((input: unknown, caller) =>
            Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(input).pipe(
              Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
              Effect.flatMap((params) => executor.relay(caller, entry.name, params)),
            ),
          ),
        });
      }
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
