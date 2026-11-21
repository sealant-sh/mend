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

const SYSTEM = `You name coding sessions. Given the session's first messages, answer with a short label a developer can pick out of a list of sessions.

Rules:
- 2-5 words, lowercase, plain nouns — like "reaper retry storm" or "flaky login test". No title case, no punctuation, no quotes.
- Name the subject of the work, not the activity ("dark mode toggle", never "fixing the dark mode toggle bug").
- No verdict or status words (fixed, done, broken); the label describes what the session is about, not how it went.
- Any request has a subject, coding or not: name it ("tell me a joke about rebase" → "rebase joke"). Only when the messages hold no request at all (a bare greeting, the word test, random characters) answer an empty label; the session stays unnamed until a later message says more. Never answer a stand-in such as "placeholder", "untitled" or "new session", and never the project's name alone.
- Answer with JSON: {"label": "..."}.`;

/** The labels the instructions give as examples: answered back for a session about none of them, an echo. */
const EXAMPLE_LABELS: ReadonlyArray<string> = [
  "reaper retry storm",
  "flaky login test",
  "dark mode toggle",
];

/**
 * Words that say nothing about the work: a label made only of these and the project's name is a
 * stand-in ("placeholder", "up-main session", "test session"), never a name. A real label keeps at
 * least one word outside them ("flaky login test" keeps "flaky" and "login").
 */
const STAND_IN_WORDS: ReadonlySet<string> = new Set([
  "placeholder",
  "untitled",
  "unnamed",
  "unknown",
  "new",
  "session",
  "sessions",
  "chat",
  "conversation",
  "exchange",
  "greeting",
  "greetings",
  "hello",
  "hi",
  "hey",
  "test",
  "testing",
  "general",
  "misc",
  "miscellaneous",
  "work",
  "project",
  "task",
  "input",
  "message",
  "prompt",
  "question",
  "request",
  "help",
  "empty",
  "none",
  "default",
  "sample",
  "example",
  "temp",
  "tbd",
]);

/**
 * Words a first message can be made of without saying what the work is: a person's "hi", "test" or
 * "ok". A message of only these (or of no words at all) gives the namer nothing to name, so Mend
 * doesn't ask a model to invent one.
 */
const SMALL_TALK: ReadonlySet<string> = new Set([
  "hi",
  "hello",
  "hey",
  "yo",
  "hiya",
  "howdy",
  "sup",
  "test",
  "testing",
  "ping",
  "ok",
  "okay",
  "k",
  "yes",
  "no",
  "thanks",
  "thx",
  "please",
  "there",
  "claude",
  "codex",
  "good",
  "morning",
  "afternoon",
  "evening",
]);

/** The words of `text`, lowercase: runs of letters and digits. */
const wordsOf = (text: string): ReadonlyArray<string> =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Whether a message says anything to name a session after: a word that holds a letter and isn't
 * small talk. "hi", "test", "." and "123" don't; "asdf" does, and the model answers it.
 */
export const saysSomething = (message: string): boolean =>
  wordsOf(message).some((word) => /\p{L}/u.test(word) && !SMALL_TALK.has(word));

/**
 * Whether a normalized label is a stand-in rather than a name: only stand-in words and the
 * project's name ("placeholder", "up-main session"), or one of the instructions' own examples that
 * shares no word with the messages (the model echoing its prompt).
 */
export const isStandIn = (
  label: string,
  context: { readonly projectName: string; readonly messages: ReadonlyArray<string> },
): boolean => {
  const project = new Set(wordsOf(context.projectName));
  const subject = wordsOf(label).filter((word) => !STAND_IN_WORDS.has(word) && !project.has(word));
  if (subject.length === 0) return true;
  if (!EXAMPLE_LABELS.includes(label)) return false;
  const said = new Set(context.messages.flatMap(wordsOf));
  return !subject.some((word) => said.has(word));
};

const NameAnswer = Schema.Struct({ label: Schema.String });

const MAX_LABEL_LENGTH = 60;
/** What of the person's messages the model reads, all of them together. */
const MAX_PROMPT_CHARS = 2_000;
const MAX_REPLY_CHARS = 1_000;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/**
 * Boundary enforcement, not prompt hope: whatever the model answers is
 * normalized to the house label style — trimmed, unquoted, single-spaced,
 * lowercase, capped. An empty result is undefined: never a blank label.
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
  /**
   * The person's first messages to the session, oldest first: the first alone when it says what
   * the work is, the next few too when it was a "hi".
   */
  readonly messages: ReadonlyArray<string>;
  /** The first assistant reply, when one exists yet — context, not required. */
  readonly assistantReply?: string;
}

const messagesBlock = (messages: ReadonlyArray<string>): string =>
  messages.length === 1
    ? `The session's first prompt:\n${truncate(messages[0] ?? "", MAX_PROMPT_CHARS)}`
    : `The session's first messages, oldest first:\n${truncate(
        messages.map((message, at) => `${at + 1}. ${message}`).join("\n\n"),
        MAX_PROMPT_CHARS,
      )}`;

const prompt = (input: SessionNamingInput) =>
  [
    `Project: ${input.projectName}. Harness: ${input.harness}.`,
    messagesBlock(input.messages),
    ...(input.assistantReply === undefined
      ? []
      : [`The agent's first reply began:\n${truncate(input.assistantReply, MAX_REPLY_CHARS)}`]),
  ].join("\n\n");

/**
 * Names a session from its first messages — the `name-session` job's pass. Runs
 * on the cheap model of whichever subscription the user has: claude first,
 * codex when no usable claude account exists.
 */
export class SessionNamer extends Context.Service<
  SessionNamer,
  {
    /**
     * The session's label, or null when its messages don't say what the work is yet: messages of
     * small talk only (no model call), the model's empty answer, or a stand-in it answered
     * ("placeholder", SLNT-1230). Null is never written; the caller waits for a later message.
     */
    readonly name: (input: SessionNamingInput) => Effect.Effect<string | null, InferenceError>;
  }
>()("@mend/inference/SessionNamer") {}

export const SessionNamerLive: Layer.Layer<SessionNamer, Config.ConfigError, InferenceProvider> =
  Layer.effect(
    SessionNamer,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const claudeModel = yield* Config.String("MEND_INFERENCE_NAMING_MODEL_CLAUDE").pipe(
        Config.orElse(() => Config.succeed(CLAUDE_NAMING_MODEL)),
      );
      const codexModel = yield* Config.String("MEND_INFERENCE_NAMING_MODEL_CODEX").pipe(
        Config.orElse(() => Config.succeed(CODEX_NAMING_MODEL)),
      );

      const outputDocument = Schema.toJsonSchemaDocument(NameAnswer);
      // Codex's structured output is strict: it refuses an object schema that allows other keys
      // ("'additionalProperties' is required to be supplied and to be false"), and every codex-arm
      // naming pass failed on it (SLNT-1211, seen on the box). Effect writes `true` here.
      const outputSchema: Record<string, unknown> = {
        ...outputDocument.schema,
        additionalProperties: false,
      };

      const name = Effect.fn("SessionNamer.name")(function* (input: SessionNamingInput) {
        if (!input.messages.some(saysSomething)) return null;
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

        // Empty: the model's own "nothing to name yet".
        const label = normalizeLabel(decoded.label);
        if (label === undefined) return null;
        if (isStandIn(label, input)) {
          yield* Effect.logInfo("session namer answered a stand-in · not written").pipe(
            Effect.annotateLogs({ label }),
          );
          return null;
        }
        return label;
      });

      return { name };
    }),
  );
