import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { InferenceError, InferenceProvider, type InferenceRequest } from "./provider.ts";
import {
  RequestIntentReader,
  RequestIntentReaderLive,
  requestIntentPrompt,
  type RequestIntentInput,
} from "./request-intent-reader.ts";

const input: RequestIntentInput = {
  request: "go ahead and fix it",
  context: [
    { author: "alice", text: "why does the login test flake?" },
    { author: "agent", text: "The fixture shares a port between workers." },
  ],
};

/** Runs the reader against a scripted provider; each call shifts the next scripted outcome. */
const readWith = (
  outcomes: Array<Effect.Effect<unknown, InferenceError>>,
  requests: Array<InferenceRequest>,
  over: RequestIntentInput = input,
  configuration: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const reader = yield* RequestIntentReader;
    return yield* reader.read(over);
  }).pipe(
    Effect.provide(
      RequestIntentReaderLive.pipe(
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

const unusable = new InferenceError({
  message: "No claude connected account matches this user",
  cause: null,
});

describe("RequestIntentReader (docs/adr/0007, Questions do not open pull requests)", () => {
  it.effect("uses explicit model overrides on both provider arms", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      yield* readWith(
        [
          Effect.fail(
            new InferenceError({ message: "Reconnect the claude connected account", cause: null }),
          ),
          Effect.succeed({ intent: "question" }),
        ],
        requests,
        input,
        {
          MEND_INFERENCE_INTENT_MODEL_CLAUDE: "custom-claude",
          MEND_INFERENCE_INTENT_MODEL_CODEX: "custom-codex",
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

  it.effect("asks the cheap model once, with the request and what came before it", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const intent = yield* readWith([Effect.succeed({ intent: "change" })], requests);

      expect(intent).toBe("change");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual(
        expect.objectContaining({
          context: "request-intent",
          provider: "claude",
          model: "claude-haiku-4-5",
          maxRounds: 1,
        }),
      );
      expect(requests[0]?.outputSchema).toBeDefined();
      const prompt = requests[0]?.prompt ?? "";
      expect(prompt).toContain("alice: why does the login test flake?");
      expect(prompt).toContain("The request:\ngo ahead and fix it");
    });
  });

  it.effect("reads a question as a question", () =>
    Effect.gen(function* () {
      const intent = yield* readWith([Effect.succeed({ intent: "question" })], [], {
        request: "why does the login test flake?",
        context: [],
      });
      expect(intent).toBe("question");
    }),
  );

  it.effect("falls back to codex only when the claude account is unusable", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const intent = yield* readWith(
        [Effect.fail(unusable), Effect.succeed({ intent: "question" })],
        requests,
      );
      expect(intent).toBe("question");
      expect(requests.map((request) => [request.provider, request.model])).toEqual([
        ["claude", "claude-haiku-4-5"],
        ["codex", "gpt-5.6-luna"],
      ]);
    });
  });

  it.effect("fails, without a second call, when the engine fails for another reason", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const error = yield* readWith(
        [Effect.fail(new InferenceError({ message: "platform timed out", cause: null }))],
        requests,
      ).pipe(Effect.flip);
      expect(error.message).toBe("platform timed out");
      expect(requests).toHaveLength(1);
    });
  });

  it.effect(
    "reads a request to publish the work as land, and a question about it as a question",
    () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        const land = yield* readWith([Effect.succeed({ intent: "land" })], requests, {
          request: "ok land it",
          context: [{ author: "the owner", text: "did you open a pr ?" }],
        });
        expect(land).toBe("land");
        // The instructions keep the three apart, and keep asking about a landing a question.
        const system = requests[0]?.system ?? "";
        expect(system).toContain('"change", "question" or "land"');
        expect(system).toContain(
          'whether something was done ("did you open a PR?", "is it pushed?")',
        );
        expect(system).toContain('"land": the request asks only to publish the work already done');
        expect(system).toContain("Asking whether it was published is a question");
        expect(system).toContain(
          "A request that asks for a change and to open a pull request is a change.",
        );
        expect(requests[0]?.prompt).toContain("The request:\nok land it");
      });
    },
  );

  it.effect("fails when the answer is not one of the three intents", () =>
    Effect.gen(function* () {
      const error = yield* readWith([Effect.succeed({ intent: "chat" })], []).pipe(Effect.flip);
      expect(error.message).toContain("did not match its schema");
    }),
  );

  it.each([5999, 6000, 6001])(
    "bounds the request at %d characters without dropping its prefix",
    (length) => {
      expect(requestIntentPrompt({ request: "  " + "r".repeat(length) + "  ", context: [] })).toBe(
        `Context, oldest first:\n(none)\n\nThe request:\n${"r".repeat(Math.min(length, 6000))}`,
      );
    },
  );

  it.each([
    [5996, `a: ${"c".repeat(5996)}`],
    [5997, `a: ${"c".repeat(5997)}`],
    [5998, `…: ${"c".repeat(5998)}`],
  ] as const)("keeps the latest context characters for text length %d", (length, expected) => {
    expect(
      requestIntentPrompt({ request: "fix", context: [{ author: "a", text: "c".repeat(length) }] }),
    ).toBe(`Context, oldest first:\n${expected}\n\nThe request:\nfix`);
  });

  it("says so when there is no context, and keeps the newest of a long one", () => {
    expect(requestIntentPrompt({ request: "fix it", context: [] })).toContain(
      "Context, oldest first:\n(none)",
    );
    const long = requestIntentPrompt({
      request: "fix it",
      context: [
        { author: "old", text: "x".repeat(7_000) },
        { author: "new", text: "the last word" },
      ],
    });
    expect(long).toContain("new: the last word");
    expect(long).not.toContain("old:");
  });
});
