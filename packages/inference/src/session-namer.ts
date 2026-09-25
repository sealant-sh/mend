import { SessionId } from "@mend/domain";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";

/**
 * The `name-session` job's payload. Two enqueue shapes share one idempotency
 * key (`name-session:{sessionId}`), so while one is queued or running the
 * other is dropped:
 * - launch-time, no prompt: the worker polls the harness's native transcript
 *   (delayed first attempt + spaced retries until the first prompt exists);
 * - send-time, prompt inline (`firstUserTurn`): a Mend-owned composer saw the
 *   prompt on its way to the session — the worker names immediately, with no
 *   transcript read and no harness-parseability gate.
 */
/**
 * What a naming pass does when the transcript has no first prompt: wait for one (the job retries)
 * while the session can still receive it, and stop once the session settled without one — it
 * stays unnamed, and the job completes instead of retrying into the dead letter.
 */
export const withoutFirstPrompt = (session: {
  readonly settledAt: Date | null;
}): "retry" | "leave-unnamed" => (session.settledAt === null ? "retry" : "leave-unnamed");

export class NameSessionJob extends Schema.Class<NameSessionJob>("NameSessionJob")({
  sessionId: SessionId,
  firstUserTurn: Schema.optional(Schema.String),
}) {}

/**
 * Cheap models per subscription arm. The naming pass is mechanical, so it runs
 * on the cheapest model the user's connected account offers (haiku · GPT-5.6 Luna); overridable per
 * arm via env. Note the codex arm resolves only once the platform serves codex
 * inference (sealant#181) — until then the fallback fails like any other
 * account-less attempt and the session simply stays unnamed.
 */
const CLAUDE_NAMING_MODEL = "claude-haiku-4-5";
const CODEX_NAMING_MODEL = "gpt-5.6-luna";

const SYSTEM = `You name coding sessions. Given the session's first prompt, answer with a short label a developer can pick out of a list of sessions.

Rules:
- 2-5 words, lowercase, plain nouns — like "reaper retry storm" or "flaky login test". No title case, no punctuation, no quotes.
- Name the subject of the work, not the activity ("dark mode toggle", never "fixing the dark mode toggle bug").
- No verdict or status words (fixed, done, broken); the label describes what the session is about, not how it went.
- Answer with JSON: {"label": "..."}.`;

const NameAnswer = Schema.Struct({ label: Schema.String });

const MAX_LABEL_LENGTH = 60;
const MAX_PROMPT_CHARS = 2_000;
const MAX_REPLY_CHARS = 1_000;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/**
 * Boundary enforcement, not prompt hope: whatever the model answers is
 * normalized to the house label style — trimmed, unquoted, single-spaced,
 * lowercase, capped. An empty result is a pass failure, never a blank label.
 */
export const normalizeLabel = (raw: string): string | undefined => {
  const collapsed = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (collapsed.length === 0) {
    return undefined;
  }
  return collapsed.length <= MAX_LABEL_LENGTH
    ? collapsed
    : collapsed.slice(0, MAX_LABEL_LENGTH).trimEnd();
};

/**
 * Fallback predicate: the claude arm is retried on codex only when the failure
 * says the claude account itself is missing or unusable (the platform's 404
 * "No claude connected account matches …", the 400 "requires a connected
 * account", and the 409 "… reconnect it" all match) — an engine hiccup must
 * not silently switch subscriptions.
 */
const isUnusableAccountError = (error: InferenceError): boolean =>
  /connected account|reconnect/i.test(error.message);

export interface SessionNamingInput {
  readonly harness: string;
  readonly projectName: string;
  /** The session's first user turn, from the harness's native transcript. */
  readonly firstUserTurn: string;
  /** The first assistant reply, when one exists yet — context, not required. */
  readonly assistantReply?: string;
}

const prompt = (input: SessionNamingInput) =>
  [
    `Project: ${input.projectName}. Harness: ${input.harness}.`,
    `The session's first prompt:\n${truncate(input.firstUserTurn, MAX_PROMPT_CHARS)}`,
    ...(input.assistantReply === undefined
      ? []
      : [`The agent's first reply began:\n${truncate(input.assistantReply, MAX_REPLY_CHARS)}`]),
  ].join("\n\n");

/**
 * Names a session from its first prompt — the `name-session` job's pass. Runs
 * on the cheap model of whichever subscription the user has: claude first,
 * codex when no usable claude account exists.
 */
export class SessionNamer extends Context.Service<
  SessionNamer,
  {
    readonly name: (input: SessionNamingInput) => Effect.Effect<string, InferenceError>;
  }
>()("@mend/inference/SessionNamer") {}

export const SessionNamerLive: Layer.Layer<SessionNamer, Config.ConfigError, InferenceProvider> =
  Layer.effect(
    SessionNamer,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const claudeModel = yield* Config.string("MEND_INFERENCE_NAMING_MODEL_CLAUDE").pipe(
        Config.orElse(() => Config.succeed(CLAUDE_NAMING_MODEL)),
      );
      const codexModel = yield* Config.string("MEND_INFERENCE_NAMING_MODEL_CODEX").pipe(
        Config.orElse(() => Config.succeed(CODEX_NAMING_MODEL)),
      );

      const outputDocument = Schema.toJsonSchemaDocument(NameAnswer);
      const outputSchema: Record<string, unknown> = { ...outputDocument.schema };

      const name = Effect.fn("SessionNamer.name")(function* (input: SessionNamingInput) {
        const attempt = (arm: { readonly provider: "claude" | "codex"; readonly model: string }) =>
          provider.respond({
            context: "session-naming",
            system: SYSTEM,
            prompt: prompt(input),
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

        const decoded = yield* Schema.decodeUnknownEffect(NameAnswer)(answer).pipe(
          Effect.mapError(
            (error) =>
              new InferenceError({
                message: `the session name did not match its schema: ${error.message}`,
                cause: error,
              }),
          ),
        );

        const label = normalizeLabel(decoded.label);
        if (label === undefined) {
          return yield* new InferenceError({
            message: "the session name came back empty after normalization",
            cause: null,
          });
        }
        return label;
      });

      return { name };
    }),
  );
