import { RequestIntent } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";

/**
 * Whether a request asked for a change or a question (docs/adr/0007-landing.md, "Questions do not
 * open pull requests"). Automatic landing publishes a completed turn only when its request read
 * as a `change`: an answer is not a pull request.
 *
 * The reading is one small call on the cheap model, per turn, for sessions that land by
 * themselves. Slack reads the intent in the call that reads its thread for a project, and hands
 * the reading to automatic landing precomputed, so it never calls this. When this call fails,
 * the caller records the intent as not read and treats the request as a change: a spurious pull
 * request is easy to close, and a missing one is the failure people notice.
 */

export interface RequestIntentInput {
  /** The request, as the person wrote it: without the guard Mend added to an opening turn. */
  readonly request: string;
  /**
   * What came before it, oldest first, each with who wrote it: the thread a Slack request was
   * made in, or the session's earlier requests. Context for the request, never the request.
   */
  readonly context: ReadonlyArray<{ readonly author: string; readonly text: string }>;
}

/** Cheap models, as for session naming: the reading is a classification, not a reading of code. */
const CLAUDE_MODEL = "claude-haiku-4-5";
const CODEX_MODEL = "gpt-5.6-luna";

const REQUEST_CHARACTER_LIMIT = 6_000;
/** The context's text, keeping the newest. */
const CONTEXT_CHARACTER_LIMIT = 6_000;

const SYSTEM = `You read a request sent to a coding agent working in a software repository, and say what it asks for: "change" or "question".

- "change": the request asks the agent to change the repository: fix, add, remove, rename, refactor, update, write tests or docs, bump a dependency, apply a suggestion. A request that asks for a change and also asks something is a change.
- "question": the request asks for an answer and asks for no change: why something happens, how something works, where something is, what a change would involve, a review or an opinion. "Could you look into why X fails?" is a question unless it also asks for a fix.
- The context shows what came before the request. Use it to understand the request ("do it", "yes, go ahead" after a proposed fix is a change), never as a request of its own.
- Answer with JSON: {"intent": "change" | "question"}.`;

const Answer = Schema.Struct({ intent: RequestIntent });

/** Keep the newest `limit` characters. */
const newest = (text: string, limit: number): string =>
  text.length <= limit ? text : `…${text.slice(text.length - limit)}`;

export const requestIntentPrompt = (input: RequestIntentInput): string => {
  const context = newest(
    input.context.map((entry) => `${entry.author}: ${entry.text}`).join("\n"),
    CONTEXT_CHARACTER_LIMIT,
  );
  const request = input.request.trim().slice(0, REQUEST_CHARACTER_LIMIT);
  return [
    `Context, oldest first:\n${context === "" ? "(none)" : context}`,
    `The request:\n${request === "" ? "(empty)" : request}`,
  ].join("\n\n");
};

/** The claude arm falls back to codex only when the claude account itself is unusable. */
const isUnusableAccountError = (error: InferenceError): boolean =>
  /connected account|reconnect/i.test(error.message);

/**
 * Reads a request's intent. Runs as the session's owner, on the cheap model of whichever
 * subscription they have: claude first, codex when no usable claude account exists. The caller
 * sets the Sealant principal.
 */
export class RequestIntentReader extends Context.Service<
  RequestIntentReader,
  {
    readonly read: (input: RequestIntentInput) => Effect.Effect<RequestIntent, InferenceError>;
  }
>()("@mend/inference/RequestIntentReader") {}

export const RequestIntentReaderLive: Layer.Layer<
  RequestIntentReader,
  Config.ConfigError,
  InferenceProvider
> = Layer.effect(
  RequestIntentReader,
  Effect.gen(function* () {
    const provider = yield* InferenceProvider;
    const claudeModel = yield* Config.string("MEND_INFERENCE_INTENT_MODEL_CLAUDE").pipe(
      Config.orElse(() => Config.succeed(CLAUDE_MODEL)),
    );
    const codexModel = yield* Config.string("MEND_INFERENCE_INTENT_MODEL_CODEX").pipe(
      Config.orElse(() => Config.succeed(CODEX_MODEL)),
    );
    const outputSchema: Record<string, unknown> = {
      ...Schema.toJsonSchemaDocument(Answer).schema,
    };

    const read = Effect.fn("RequestIntentReader.read")(function* (input: RequestIntentInput) {
      const attempt = (arm: { readonly provider: "claude" | "codex"; readonly model: string }) =>
        provider.respond({
          context: "request-intent",
          system: SYSTEM,
          prompt: requestIntentPrompt(input),
          outputSchema,
          provider: arm.provider,
          model: arm.model,
          maxRounds: 1,
        });
      const answer = yield* attempt({ provider: "claude", model: claudeModel }).pipe(
        Effect.catch((error) =>
          isUnusableAccountError(error)
            ? attempt({ provider: "codex", model: codexModel })
            : Effect.fail(error),
        ),
      );
      const decoded = yield* Schema.decodeUnknownEffect(Answer)(answer).pipe(
        Effect.mapError(
          (error) =>
            new InferenceError({
              message: `the request's intent did not match its schema: ${error.message}`,
              cause: error,
            }),
        ),
      );
      return decoded.intent;
    });

    return { read };
  }),
);
