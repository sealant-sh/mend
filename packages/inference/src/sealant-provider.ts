import { InferenceCallsRepo } from "@mend/db";
import { SealantClient } from "@mend/sealant";
import type { InferenceResponse, InferenceToolResult } from "@sealant/sdk";
import { Config, Effect, Layer, Option } from "effect";

import {
  InferenceError,
  InferenceProvider,
  type InferenceRequest,
  type InferenceTool,
} from "./provider.ts";

const MAX_TOOL_ROUNDS = 12;

/**
 * The shipped default: inference on the AI subscriptions the user connected in
 * Sealant (SDK 0.5.0). The model call runs server-side through the official
 * agent SDKs; the closed tool set executes HERE, and every exchange and tool
 * call lands in `inference_calls`. Mend ships no model keys.
 *
 * MEND_INFERENCE_CLAUDE_ACCOUNT / MEND_INFERENCE_CODEX_ACCOUNT name a specific
 * connected account per provider; unset means the caller's default account.
 */
export const sealantProviderLayer = Layer.effect(
  InferenceProvider,
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    const audit = yield* InferenceCallsRepo;
    const claudeAccount = yield* Config.option(Config.String("MEND_INFERENCE_CLAUDE_ACCOUNT"));
    const codexAccount = yield* Config.option(Config.String("MEND_INFERENCE_CODEX_ACCOUNT"));
    const credentialsFor = (provider: "claude" | "codex") =>
      provider === "codex"
        ? { codex: Option.getOrElse(codexAccount, () => true as const) }
        : { claude: Option.getOrElse(claudeAccount, () => true as const) };

    const respond = Effect.fn("InferenceProvider.respond")(function* (request: InferenceRequest) {
      const toolsByName = new Map<string, InferenceTool>(
        (request.tools ?? []).map((tool) => [tool.name, tool]),
      );

      const exchange = (options: Parameters<typeof sealant.inferenceRespond>[0]) =>
        sealant.inferenceRespond(options).pipe(
          Effect.mapError((error) => new InferenceError({ message: error.message, cause: error })),
          Effect.tap((response) =>
            audit.record({
              context: request.context,
              tool: null,
              input: options,
              output: response,
            }),
          ),
        );

      const runTool = Effect.fn("InferenceProvider.runTool")(function* (call: {
        readonly toolCallId: string;
        readonly name: string;
        readonly input: unknown;
      }) {
        const tool = toolsByName.get(call.name);
        if (tool === undefined) {
          const result: InferenceToolResult = {
            toolCallId: call.toolCallId,
            content: `Unknown tool: ${call.name}`,
            isError: true,
          };
          return result;
        }
        const outcome = yield* tool.handle(call.input).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, value: error.message })),
        );
        yield* audit.record({
          context: request.context,
          tool: tool.name,
          input: call.input,
          output: outcome,
        });
        const result: InferenceToolResult = {
          toolCallId: call.toolCallId,
          content: JSON.stringify(outcome.value),
          ...(outcome.ok ? {} : { isError: true }),
        };
        return result;
      });

      let response: InferenceResponse = yield* exchange({
        prompt: request.prompt,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            }),
        ...(request.outputSchema === undefined
          ? {}
          : { responseFormat: { type: "json", schema: request.outputSchema } }),
        ...(request.model === undefined ? {} : { model: request.model }),
        credentials: credentialsFor(request.provider ?? "claude"),
      });

      const maxRounds = request.maxRounds ?? MAX_TOOL_ROUNDS;
      // The budget counts tool rounds; their last continuation can still be the final answer.
      for (let round = 0; round <= maxRounds; round++) {
        if (response.turn.type === "text") {
          if (request.outputSchema === undefined) return response.turn.text;
          if (response.turn.json !== undefined) return response.turn.json;
          return yield* Effect.try({
            try: (): unknown => JSON.parse(response.turn.type === "text" ? response.turn.text : ""),
            catch: (cause) =>
              new InferenceError({ message: "final answer was not valid JSON", cause }),
          });
        }
        if (round >= maxRounds) break;
        const toolResults = yield* Effect.forEach(response.turn.calls, runTool);
        response = yield* exchange({ sessionId: response.sessionId, toolResults });
      }

      return yield* new InferenceError({
        message: `tool loop did not settle within ${maxRounds} rounds`,
        cause: null,
      });
    });

    return { respond };
  }),
);
