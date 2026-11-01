import {
  PROOF_MISSING_DESCRIPTION,
  PROOF_SCREENSHOT_DESCRIPTION,
  ProofMissingParams,
  ProofScreenshotParams,
  ProofVideoStartParams,
  ProofVideoStopParams,
  PROOF_VIDEO_START_DESCRIPTION,
  PROOF_VIDEO_STOP_DESCRIPTION,
} from "@mend/agent-protocol";
import {
  PROOF_MISSING_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
} from "@mend/domain/workbench";
import { Context, Effect, Layer, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";

import { asCaller } from "./caller.ts";
import { ProofCaptures } from "./proof-captures.ts";

const toolJson = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Schema.decodeUnknownSync(McpSchema.ToolJson)(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
};

/** Raw tools preserve image blocks in the answer Codex receives. */
export const ProofToolsLive: Layer.Layer<never, never, ProofCaptures> = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const captures = yield* ProofCaptures;
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: PROOF_SCREENSHOT_TOOL,
        title: "Capture proof screenshot",
        description: PROOF_SCREENSHOT_DESCRIPTION,
        inputSchema: toolJson(ProofScreenshotParams),
        annotations,
      }),
      annotations: Context.empty(),
      handle: asCaller((payload: unknown, caller) =>
        Schema.decodeUnknownEffect(ProofScreenshotParams)(payload).pipe(
          Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          Effect.flatMap((params) => captures.screenshot(caller, params)),
        ),
      ),
    });
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: PROOF_VIDEO_START_TOOL,
        title: "Start proof video",
        description: PROOF_VIDEO_START_DESCRIPTION,
        inputSchema: toolJson(ProofVideoStartParams),
        annotations,
      }),
      annotations: Context.empty(),
      handle: asCaller((payload: unknown, caller) =>
        Schema.decodeUnknownEffect(ProofVideoStartParams)(payload).pipe(
          Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          Effect.flatMap((params) => captures.videoStart(caller, params)),
        ),
      ),
    });
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: PROOF_VIDEO_STOP_TOOL,
        title: "Stop proof video",
        description: PROOF_VIDEO_STOP_DESCRIPTION,
        inputSchema: toolJson(ProofVideoStopParams),
        annotations,
      }),
      annotations: Context.empty(),
      handle: asCaller((payload: unknown, caller) =>
        Schema.decodeUnknownEffect(ProofVideoStopParams)(payload).pipe(
          Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          Effect.flatMap(() => captures.videoStop(caller)),
        ),
      ),
    });
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: PROOF_MISSING_TOOL,
        title: "Record missing proof",
        description: PROOF_MISSING_DESCRIPTION,
        inputSchema: toolJson(ProofMissingParams),
        annotations,
      }),
      annotations: Context.empty(),
      handle: asCaller((payload: unknown, caller) =>
        Schema.decodeUnknownEffect(ProofMissingParams)(payload).pipe(
          Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
          Effect.flatMap((params) => captures.missing(caller, params)),
        ),
      ),
    });
  }),
).pipe(Layer.provide(McpServer.McpServer.layer));
