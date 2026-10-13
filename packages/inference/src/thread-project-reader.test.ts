import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { InferenceError, InferenceProvider, type InferenceRequest } from "./provider.ts";
import {
  checkThreadProjectAnswer,
  ThreadProjectReader,
  ThreadProjectReaderLive,
  type ThreadProjectInput,
} from "./thread-project-reader.ts";

interface RawOptions {
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly branch: string | null;
}

const input: ThreadProjectInput = {
  request: "make the retry limit configurable, use codex with high effort on release/2.3",
  thread: [
    { author: "Bob", text: "invoices time out when the ledger retries" },
    { author: "Carol", text: "harness=claude please, and on main" },
  ],
  candidates: [
    {
      id: "p-billing",
      name: "billing-api",
      originUrl: "git@github.com:acme/billing-api.git",
      defaultBranch: "main",
      topLevel: ["README.md", "ledger/", "invoices/"],
    },
    {
      id: "p-web",
      name: "web",
      originUrl: "https://github.com/acme/web.git",
      defaultBranch: "main",
      topLevel: ["app/", "package.json"],
    },
  ],
  settled: { harness: null, model: false, effort: false, branch: false },
  harnesses: { claude: ["opus", "sonnet"], codex: ["gpt-5.6"] },
};

const none: RawOptions = { harness: null, model: null, effort: null, branch: null };

/** Runs the reader against a scripted provider; each call shifts the next scripted outcome. */
const readWith = (
  outcomes: Array<Effect.Effect<unknown, InferenceError>>,
  requests: Array<InferenceRequest>,
  over: ThreadProjectInput = input,
  configuration: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const reader = yield* ThreadProjectReader;
    return yield* reader.read(over);
  }).pipe(
    Effect.provide(
      ThreadProjectReaderLive.pipe(
        Layer.provide(
          Layer.succeed(InferenceProvider, {
            respond: (request) => {
              requests.push(request);
              return outcomes.shift() ?? Effect.die("scripted provider exhausted");
            },
          }),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
      ),
    ),
  );

describe("ThreadProjectReader", () => {
  for (const [requestLength, threadTextLength, expectedThread] of [
    [3999, 11996, `a: ${"t".repeat(11996)}`],
    [4000, 11997, `a: ${"t".repeat(11997)}`],
    [4001, 11998, `…: ${"t".repeat(11998)}`],
  ] as const) {
    it.effect(
      `bounds request/thread text at ${requestLength}/${threadTextLength} characters`,
      () => {
        const requests: Array<InferenceRequest> = [];
        return Effect.gen(function* () {
          yield* readWith(
            [Effect.succeed({ projectId: "p-web", likeliest: [], options: none })],
            requests,
            {
              ...input,
              request: "r".repeat(requestLength),
              thread: [{ author: "a", text: "t".repeat(threadTextLength) }],
            },
          );
          const prompt = requests[0]?.prompt;
          expect(prompt?.split("The Slack thread:\n")[1]?.split("\n\nThe request:")[0]).toBe(
            expectedThread,
          );
          expect(prompt?.split("The request:\n")[1]?.split("\n\nHarnesses:")[0]).toBe(
            "r".repeat(Math.min(requestLength, 4000)),
          );
        });
      },
    );
  }

  it.effect("uses explicit model overrides on both provider arms", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      yield* readWith(
        [
          Effect.fail(
            new InferenceError({ message: "Reconnect the claude connected account", cause: null }),
          ),
          Effect.succeed({ projectId: "p-web", likeliest: [], options: none }),
        ],
        requests,
        input,
        {
          MEND_INFERENCE_SLACK_MODEL_CLAUDE: "custom-claude",
          MEND_INFERENCE_SLACK_MODEL_CODEX: "custom-codex",
        },
      );
      expect(requests.map((request) => [request.provider, request.model])).toEqual([
        ["claude", "custom-claude"],
        ["codex", "custom-codex"],
      ]);
    });
  });

  it.effect("preserves the fallback failure after exactly two provider calls", () => {
    const requests: Array<InferenceRequest> = [];
    const failure = new InferenceError({ message: "Codex inference unavailable", cause: null });
    return Effect.gen(function* () {
      const result = yield* readWith(
        [
          Effect.fail(new InferenceError({ message: "No claude connected account", cause: null })),
          Effect.fail(failure),
        ],
        requests,
      ).pipe(Effect.flip);
      expect(result).toBe(failure);
      expect(requests.map((request) => request.provider)).toEqual(["claude", "codex"]);
    });
  });

  it.effect(
    "asks the cheap model with the candidates and the thread, and checks the answer",
    () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        const answer = yield* readWith(
          [
            Effect.succeed({
              projectId: "p-billing",
              likeliest: ["p-web", "p-billing"],
              options: { harness: "codex", model: null, effort: "high", branch: "release/2.3" },
              intent: "change",
            }),
          ],
          requests,
        );

        expect(answer).toEqual({
          projectId: "p-billing",
          likeliest: ["p-billing", "p-web"],
          options: { harness: "codex", model: null, effort: "high", branch: "release/2.3" },
          intent: "change",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toEqual(
          expect.objectContaining({
            context: "slack-project",
            provider: "claude",
            model: "claude-haiku-4-5",
            maxRounds: 1,
          }),
        );
        expect(requests[0]?.outputSchema).toBeDefined();
        const prompt = requests[0]?.prompt ?? "";
        expect(prompt).toContain("id: p-billing");
        expect(prompt).toContain("origin: git@github.com:acme/billing-api.git");
        expect(prompt).toContain("root: README.md, ledger/, invoices/");
        expect(prompt).toContain("Bob: invoices time out when the ledger retries");
        expect(prompt).toContain("make the retry limit configurable");
      });
    },
  );

  it.effect("never answers with a project that is not a candidate", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const answer = yield* readWith(
        [
          Effect.succeed({
            projectId: "p-secret",
            likeliest: ["p-secret", "p-web"],
            options: none,
          }),
        ],
        requests,
      );
      expect(answer).toEqual({
        projectId: null,
        likeliest: ["p-web"],
        options: none,
        intent: null,
      });
    });
  });

  it.effect("reads the request's intent in the same call, and drops one it cannot use", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const question = yield* readWith(
        [Effect.succeed({ projectId: "p-web", likeliest: [], options: none, intent: "question" })],
        requests,
      );
      expect(question.intent).toBe("question");
      expect(requests[0]?.system).toContain('"intent"');
      const odd = yield* readWith(
        [Effect.succeed({ projectId: "p-web", likeliest: [], options: none, intent: "both" })],
        [],
      );
      expect(odd).toMatchObject({ projectId: "p-web", intent: null });
    });
  });

  it.effect("asks nothing when there are no candidates", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const answer = yield* readWith([], requests, { ...input, candidates: [] });
      expect(answer.projectId).toBeNull();
      expect(requests).toEqual([]);
    });
  });

  it.effect("falls back to the codex arm when the claude account is missing", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const answer = yield* readWith(
        [
          Effect.fail(
            new InferenceError({ message: "No claude connected account matches", cause: null }),
          ),
          Effect.succeed({ projectId: "p-web", likeliest: [], options: none }),
        ],
        requests,
      );
      expect(answer.projectId).toBe("p-web");
      expect(requests[1]).toEqual(
        expect.objectContaining({ provider: "codex", model: "gpt-5.6-luna" }),
      );
    });
  });

  it.effect("fails on an answer that is not the schema, and on any other provider failure", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const malformed = yield* Effect.flip(
        readWith([Effect.succeed({ project: "p-web" })], requests),
      );
      expect(malformed.message).toContain("schema");
      const overloaded = yield* Effect.flip(
        readWith(
          [Effect.fail(new InferenceError({ message: "model overloaded", cause: null }))],
          requests,
        ),
      );
      expect(overloaded.message).toBe("model overloaded");
    });
  });
});

describe("checkThreadProjectAnswer", () => {
  const answer = (options: Partial<RawOptions>) => ({
    projectId: null,
    likeliest: [],
    options: { ...none, ...options },
  });

  it("keeps only options the requester wrote, not ones from the thread", () => {
    // Carol asked for claude and main in the thread; the request says codex and release/2.3.
    expect(
      checkThreadProjectAnswer(input, answer({ harness: "claude", branch: "main" })).options,
    ).toEqual(none);
    expect(
      checkThreadProjectAnswer(input, answer({ harness: "Codex", effort: "HIGH" })).options,
    ).toEqual({ ...none, harness: "codex", effort: "high" });
  });

  it("leaves options the request already set, and refuses values Mend does not take", () => {
    const settled = {
      ...input,
      settled: { harness: "claude", model: false, effort: true, branch: true },
    };
    expect(
      checkThreadProjectAnswer(
        settled,
        answer({ harness: "codex", effort: "high", branch: "release/2.3" }),
      ).options,
    ).toEqual(none);
    const odd = {
      ...input,
      request: "use gemini with extreme effort from --upload-pack=evil and ../etc",
    };
    expect(
      checkThreadProjectAnswer(
        odd,
        answer({ harness: "gemini", effort: "extreme", branch: "--upload-pack=evil" }),
      ).options,
    ).toEqual(none);
    expect(checkThreadProjectAnswer(odd, answer({ branch: "../etc" })).options).toEqual(none);
  });

  it("takes a model only for the harness the session runs, naming the harness when one lists it", () => {
    const withOpus = { ...input, request: "try it with opus" };
    expect(checkThreadProjectAnswer(withOpus, answer({ model: "Opus" })).options).toEqual({
      ...none,
      harness: "claude",
      model: "opus",
    });
    const onCodex = {
      ...withOpus,
      settled: { harness: "codex", model: false, effort: false, branch: false },
    };
    expect(checkThreadProjectAnswer(onCodex, answer({ model: "opus" })).options).toEqual(none);
  });
});
