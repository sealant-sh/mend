import Anthropic from "@anthropic-ai/sdk";
import { InferenceCallsRepo } from "@mend/db";
import { Config, Effect, Layer, Redacted } from "effect";

import {
  InferenceError,
  InferenceProvider,
  type InferenceRequest,
  type InferenceTool,
} from "./provider.ts";

const MAX_TOOL_TURNS = 12;

/**
 * DEV ONLY — calls a model provider directly on an operator-supplied API key.
 * This is never the shipped default: the product rule is "Mend hosts no
 * inference; every model call runs on the user's Sealant-connected
 * subscriptions" (PRODUCT.md). It exists so the brief pipeline is buildable
 * before the SDK's inference surface ships (see ./sealant-provider.ts).
 *
 * Requires ANTHROPIC_API_KEY; model via MEND_DEV_INFERENCE_MODEL.
 */
export const devDirectProviderLayer = Layer.effect(
  InferenceProvider,
  Effect.gen(function* () {
    const audit = yield* InferenceCallsRepo;
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY");
    const model = yield* Config.String("MEND_DEV_INFERENCE_MODEL").pipe(
      Config.orElse(() => Config.succeed("claude-opus-4-8")),
    );
    const client = new Anthropic({ apiKey: Redacted.value(apiKey) });

    const callModel = (
      request: InferenceRequest,
      tools: ReadonlyArray<Anthropic.Tool>,
      messages: ReadonlyArray<Anthropic.MessageParam>,
    ) =>
      Effect.tryPromise({
        try: () =>
          client.messages.create({
            // Per-request model override wins; the dev arm has no codex path,
            // so a codex-provider request just runs on the same Anthropic key.
            model: request.model ?? model,
            max_tokens: 16000,
            thinking: { type: "adaptive" },
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(tools.length === 0 ? {} : { tools: [...tools] }),
            ...(request.outputSchema === undefined
              ? {}
              : {
                  output_config: {
                    format: {
                      type: "json_schema",
                      schema: { ...request.outputSchema },
                    },
                  },
                }),
            messages: [...messages],
          }),
        catch: (cause) =>
          new InferenceError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const runTool = Effect.fn("InferenceProvider.runTool")(function* (
      request: InferenceRequest,
      tool: InferenceTool,
      use: Anthropic.ToolUseBlock,
    ) {
      const outcome = yield* tool.handle(use.input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, value: error.message })),
      );
      yield* audit.record({
        context: request.context,
        tool: tool.name,
        input: use.input,
        output: outcome,
      });
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(outcome.value),
        ...(outcome.ok ? {} : { is_error: true }),
      };
      return result;
    });

    const respond = Effect.fn("InferenceProvider.respond")(function* (request: InferenceRequest) {
      const toolsByName = new Map<string, InferenceTool>(
        (request.tools ?? []).map((tool) => [tool.name, tool]),
      );
      const apiTools: ReadonlyArray<Anthropic.Tool> = (request.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));

      const messages: Array<Anthropic.MessageParam> = [{ role: "user", content: request.prompt }];

      const maxTurns = request.maxRounds ?? MAX_TOOL_TURNS;
      for (let turn = 0; turn < maxTurns; turn++) {
        const response = yield* callModel(request, apiTools, messages);
        yield* audit.record({
          context: request.context,
          tool: null,
          input: { model, system: request.system ?? null, messages },
          output: { stopReason: response.stop_reason, content: response.content },
        });

        if (response.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: response.content });
          const results: Array<Anthropic.ToolResultBlockParam> = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const tool = toolsByName.get(block.name);
            if (tool === undefined) {
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Unknown tool: ${block.name}`,
                is_error: true,
              });
              continue;
            }
            results.push(yield* runTool(request, tool, block));
          }
          // All tool results go back in ONE user message.
          messages.push({ role: "user", content: results });
          continue;
        }

        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (request.outputSchema === undefined) return text;
        return yield* Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) =>
            new InferenceError({ message: "final answer was not valid JSON", cause }),
        });
      }

      return yield* new InferenceError({
        message: `tool loop did not settle within ${maxTurns} turns`,
        cause: null,
      });
    });

    return { respond };
  }),
);
