import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

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
      ),
    ),
  );

const unusable = new InferenceError({
  message: "No claude connected account matches this user",
  cause: null,
});

describe("RequestIntentReader (docs/adr/0007, Questions do not open pull requests)", () => {
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

  it.effect("fails when the answer is not one of the two intents", () =>
    Effect.gen(function* () {
      const error = yield* readWith([Effect.succeed({ intent: "chat" })], []).pipe(Effect.flip);
      expect(error.message).toContain("did not match its schema");
    }),
  );

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
