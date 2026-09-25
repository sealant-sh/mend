import { EFFORT_LEVELS, RequestIntent, type EffortLevel } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";

/**
 * Which project a Slack thread is about (docs/adr/0006-slack.md, "Which project a mention runs
 * in"): the step after the thread's own links, when neither the request nor the thread names a
 * project. It is given each candidate's name, `originUrl`, default branch and the root of that
 * branch's tree, and the thread's text. It answers one candidate or none, never anything else:
 * the answer is checked against the list here, so a project that is not a candidate cannot come
 * back however the model answers.
 *
 * It also reads the natural options the deterministic parser left in the request (`use codex`,
 * `with high effort` mid-sentence). Those are read from the requester's own words only, and each
 * value must appear in them: text another person wrote in the thread cannot pick a harness or a
 * base branch that runs with the requester's credentials.
 *
 * The same call reads the request's intent (docs/adr/0007-landing.md, "Questions do not open pull
 * requests"): `change` or `question`, from the request with the thread as context. A Slack
 * session lands automatically only after a request that read as a change, so this reading costs
 * no call of its own.
 */

/** A project inference may answer with. */
export interface ThreadProjectCandidate {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly defaultBranch: string;
  /** The root of the default branch's tree; a directory ends in `/`. */
  readonly topLevel: ReadonlyArray<string>;
}

export interface ThreadProjectInput {
  /** The request as plain text, with the mention and the options Mend already read taken out. */
  readonly request: string;
  /** The thread before the request, oldest first, each message with its author. */
  readonly thread: ReadonlyArray<{ readonly author: string; readonly text: string }>;
  readonly candidates: ReadonlyArray<ThreadProjectCandidate>;
  /** The options the request already set; inference fills only the others. */
  readonly settled: {
    readonly harness: string | null;
    readonly model: boolean;
    readonly effort: boolean;
    readonly branch: boolean;
  };
  /** The harnesses a request may name, each with its models. */
  readonly harnesses: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface ThreadProjectOptions {
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly branch: string | null;
}

export interface ThreadProjectAnswer {
  /** The one candidate the thread is about, or null when inference cannot choose. */
  readonly projectId: string | null;
  /** Candidates, likeliest first, for the picker when nothing else answers. */
  readonly likeliest: ReadonlyArray<string>;
  readonly options: ThreadProjectOptions;
  /** What the request asked for; null when the call did not answer it, or did not run. */
  readonly intent: RequestIntent | null;
}

export const NO_THREAD_PROJECT: ThreadProjectAnswer = {
  projectId: null,
  likeliest: [],
  options: { harness: null, model: null, effort: null, branch: null },
  intent: null,
};

/** Cheap models, as for session naming: the choice is a lookup, not a reading of code. */
const CLAUDE_MODEL = "claude-haiku-4-5";
const CODEX_MODEL = "gpt-5.6-luna";

/** How many candidates the model is shown; past this many, the first ones by name. */
export const THREAD_PROJECT_CANDIDATE_LIMIT = 50;
/** Root entries per candidate. */
export const THREAD_PROJECT_ENTRY_LIMIT = 40;
/** The thread's text, keeping the newest. */
const THREAD_CHARACTER_LIMIT = 12_000;
const REQUEST_CHARACTER_LIMIT = 4_000;
/** The picker's buttons. */
const LIKELIEST_LIMIT = 5;

const SYSTEM = `You pick which software project a Slack thread is about, so a coding session can start in it. You are given candidate projects (each with an id, name, Git origin, default branch and the entries at the root of that branch) and a Slack thread, then the request that mentioned Mend.

Rules:
- Answer "projectId" only when the thread or the request clearly points at exactly one candidate: by the product, service or repository it discusses, by file or directory names that appear in one candidate's root, by an error or stack trace that names its code. Otherwise answer null. Never guess between close candidates; a wrong project costs the person a workspace.
- "likeliest" lists up to 5 candidate ids that could be meant, likeliest first. Empty when none could.
- Use only ids from the candidate list.
- "options" reads only the REQUEST, never the thread: fill a field only when the request's own words ask for it ("use codex", "on the release/2.3 branch", "with high effort", "with opus"). A field the request does not ask for is null. Fields listed as already set are always null.
- "intent" says what the REQUEST asks for, with the thread as context: "change" when it asks for code, files or configuration to be changed (fix, add, remove, rename, update, refactor, write tests), "question" when it asks only to explain, investigate, review or answer something. When a request asks for both, answer "change".
- Answer with JSON: {"projectId": string|null, "likeliest": [string], "options": {"harness": string|null, "model": string|null, "effort": string|null, "branch": string|null}, "intent": "change"|"question"}.`;

const Answer = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  likeliest: Schema.Array(Schema.String),
  options: Schema.Struct({
    harness: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
  }),
  // A string, not the literals, and optional: a reading Mend cannot use is dropped, and the
  // project the call chose stays.
  intent: Schema.optional(Schema.NullOr(Schema.String)),
});
type Answer = typeof Answer.Type;

/** Keep the newest `limit` characters, cutting at a line where one is near. */
const newest = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - limit);
  const line = tail.indexOf("\n");
  return `…${line !== -1 && line < limit / 10 ? tail.slice(line) : tail}`;
};

const candidatesShown = (input: ThreadProjectInput): ReadonlyArray<ThreadProjectCandidate> =>
  input.candidates
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, THREAD_PROJECT_CANDIDATE_LIMIT);

const prompt = (input: ThreadProjectInput): string => {
  const candidates = candidatesShown(input).map((candidate) =>
    [
      `- id: ${candidate.id}`,
      `  name: ${candidate.name}`,
      `  origin: ${candidate.originUrl ?? "(none)"}`,
      `  default branch: ${candidate.defaultBranch}`,
      `  root: ${candidate.topLevel.slice(0, THREAD_PROJECT_ENTRY_LIMIT).join(", ") || "(empty)"}`,
    ].join("\n"),
  );
  const thread = newest(
    input.thread.map((message) => `${message.author}: ${message.text}`).join("\n"),
    THREAD_CHARACTER_LIMIT,
  );
  const settled = [
    ...(input.settled.harness === null ? [] : ["harness"]),
    ...(input.settled.model ? ["model"] : []),
    ...(input.settled.effort ? ["effort"] : []),
    ...(input.settled.branch ? ["branch"] : []),
  ];
  const harnesses = Object.entries(input.harnesses).map(
    ([harness, models]) => `${harness} (models: ${models.join(", ")})`,
  );
  return [
    `Candidate projects:\n${candidates.join("\n")}`,
    `The Slack thread:\n${thread === "" ? "(no earlier messages)" : thread}`,
    `The request:\n${input.request.slice(0, REQUEST_CHARACTER_LIMIT) || "(no words besides the mention)"}`,
    `Harnesses: ${harnesses.join("; ")}. Effort levels: ${EFFORT_LEVELS.join(", ")}.`,
    `Options already set: ${settled.length === 0 ? "none" : settled.join(", ")}.`,
  ].join("\n\n");
};

/** A branch name git would take, and nothing that reads as a flag or a path out of the repo. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

const isEffort = (value: string): value is EffortLevel =>
  EFFORT_LEVELS.some((level) => level === value);

const isRequestIntent = Schema.is(RequestIntent);

/**
 * Whether `value` is in the request's own words: a whole word or path, case aside. An option the
 * requester did not write is not theirs.
 */
const written = (request: string, value: string): boolean => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-])`, "i").test(request);
};

/**
 * Boundary enforcement, not prompt hope: whatever the model answers is cut down to what the
 * input allows. The project and the likeliest are candidates only; an option is kept only when it
 * was not set already, is one Mend accepts, and appears in the request.
 */
export const checkThreadProjectAnswer = (
  input: ThreadProjectInput,
  answer: Answer,
): ThreadProjectAnswer => {
  const ids = new Set(input.candidates.map((candidate) => candidate.id));
  const projectId =
    answer.projectId !== null && ids.has(answer.projectId) ? answer.projectId : null;
  const likeliest = [
    ...new Set([
      ...(projectId === null ? [] : [projectId]),
      ...answer.likeliest.filter((id) => ids.has(id)),
    ]),
  ].slice(0, LIKELIEST_LIMIT);

  const raw = answer.options;
  const words = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed !== "" && written(input.request, trimmed) ? trimmed : null;
  };
  const harnessWord =
    input.settled.harness === null ? (words(raw.harness)?.toLowerCase() ?? null) : null;
  const namedHarness =
    harnessWord !== null && Object.hasOwn(input.harnesses, harnessWord) ? harnessWord : null;
  // A model is spelled as the harness lists it, and belongs to the harness the session runs; with
  // no harness named, to the one harness that lists it, which it then names.
  const modelWord = input.settled.model ? null : (words(raw.model)?.toLowerCase() ?? null);
  const owners = Object.entries(input.harnesses).flatMap(([name, models]) => {
    const listed = models.find((listedModel) => listedModel.toLowerCase() === modelWord);
    return listed === undefined ? [] : [{ name, model: listed }];
  });
  const runsOn = input.settled.harness ?? namedHarness;
  const [onlyOwner] = owners;
  const fitting =
    runsOn === null
      ? owners.length === 1
        ? (onlyOwner ?? null)
        : null
      : (owners.find((owner) => owner.name === runsOn) ?? null);
  const effort = input.settled.effort ? null : (words(raw.effort)?.toLowerCase() ?? null);
  const branch = input.settled.branch ? null : words(raw.branch);
  return {
    projectId,
    likeliest,
    options: {
      harness: namedHarness ?? (runsOn === null && fitting !== null ? fitting.name : null),
      model: fitting?.model ?? null,
      effort: effort !== null && isEffort(effort) ? effort : null,
      branch: branch !== null && BRANCH_NAME.test(branch) ? branch : null,
    },
    intent: isRequestIntent(answer.intent) ? answer.intent : null,
  };
};

/** The claude arm falls back to codex only when the claude account itself is unusable. */
const isUnusableAccountError = (error: InferenceError): boolean =>
  /connected account|reconnect/i.test(error.message);

/**
 * Reads a Slack thread for its project. Runs as the requester, on the cheap model of whichever
 * subscription they have: claude first, codex when no usable claude account exists. The caller
 * sets the Sealant principal.
 */
export class ThreadProjectReader extends Context.Service<
  ThreadProjectReader,
  {
    readonly read: (
      input: ThreadProjectInput,
    ) => Effect.Effect<ThreadProjectAnswer, InferenceError>;
  }
>()("@mend/inference/ThreadProjectReader") {}

export const ThreadProjectReaderLive: Layer.Layer<
  ThreadProjectReader,
  Config.ConfigError,
  InferenceProvider
> = Layer.effect(
  ThreadProjectReader,
  Effect.gen(function* () {
    const provider = yield* InferenceProvider;
    const claudeModel = yield* Config.string("MEND_INFERENCE_SLACK_MODEL_CLAUDE").pipe(
      Config.orElse(() => Config.succeed(CLAUDE_MODEL)),
    );
    const codexModel = yield* Config.string("MEND_INFERENCE_SLACK_MODEL_CODEX").pipe(
      Config.orElse(() => Config.succeed(CODEX_MODEL)),
    );
    const outputSchema: Record<string, unknown> = {
      ...Schema.toJsonSchemaDocument(Answer).schema,
    };

    const read = Effect.fn("ThreadProjectReader.read")(function* (input: ThreadProjectInput) {
      if (input.candidates.length === 0) return NO_THREAD_PROJECT;
      const attempt = (arm: { readonly provider: "claude" | "codex"; readonly model: string }) =>
        provider.respond({
          context: "slack-project",
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
      const decoded = yield* Schema.decodeUnknownEffect(Answer)(answer).pipe(
        Effect.mapError(
          (error) =>
            new InferenceError({
              message: `the thread's project did not match its schema: ${error.message}`,
              cause: error,
            }),
        ),
      );
      return checkThreadProjectAnswer(input, decoded);
    });

    return { read };
  }),
);
