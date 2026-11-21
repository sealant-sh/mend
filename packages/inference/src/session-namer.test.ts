import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { InferenceError, InferenceProvider, type InferenceRequest } from "./provider.ts";
import {
  NameSessionJob,
  normalizeLabel,
  SessionNamer,
  SessionNamerLive,
  type SessionNamingInput,
  withoutFirstPrompt,
} from "./session-namer.ts";

const input = {
  harness: "claude",
  projectName: "mend",
  messages: ["fix the flaky retry loop in the workspace reaper"],
};

/** Runs the namer against a scripted provider; each call shifts the next scripted outcome. */
const nameWith = (
  outcomes: Array<Effect.Effect<unknown, InferenceError>>,
  requests: Array<InferenceRequest>,
  over: SessionNamingInput = input,
  configuration: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const namer = yield* SessionNamer;
    return yield* namer.name(over);
  }).pipe(
    Effect.provide(
      SessionNamerLive.pipe(
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

describe("SessionNamer", () => {
  for (const malformed of [{ label: 42 }, { name: "wrong field" }, null]) {
    it.effect(`refuses the malformed label ${JSON.stringify(malformed)} without fallback`, () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        const error = yield* nameWith([Effect.succeed(malformed)], requests).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "InferenceError",
          message: expect.stringContaining("the session name did not match its schema:"),
        });
        expect(requests).toHaveLength(1);
      });
    });
  }

  for (const [promptLength, replyLength, expectedPrompt, expectedReply] of [
    [1999, 999, "p".repeat(1999), "r".repeat(999)],
    [2000, 1000, "p".repeat(2000), "r".repeat(1000)],
    [2001, 1001, `${"p".repeat(2000)}…`, `${"r".repeat(1000)}…`],
  ] as const) {
    it.effect(`bounds provider prompt/reply at ${promptLength}/${replyLength} characters`, () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        yield* nameWith([Effect.succeed({ label: "name" })], requests, {
          ...input,
          messages: ["p".repeat(promptLength)],
          assistantReply: "r".repeat(replyLength),
        });
        expect(requests[0]?.prompt).toBe(
          `Project: mend. Harness: claude.\n\nThe session's first prompt:\n${expectedPrompt}` +
            `\n\nThe agent's first reply began:\n${expectedReply}`,
        );
      });
    });
  }

  it.effect("uses explicit model overrides on both provider arms", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      yield* nameWith(
        [
          Effect.fail(
            new InferenceError({ message: "Reconnect the claude connected account", cause: null }),
          ),
          Effect.succeed({ label: "configured name" }),
        ],
        requests,
        input,
        {
          MEND_INFERENCE_NAMING_MODEL_CLAUDE: "custom-claude",
          MEND_INFERENCE_NAMING_MODEL_CODEX: "custom-codex",
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
      const result = yield* nameWith(
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

  it.effect("names on the claude arm with the cheap model and normalizes the answer", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const label = yield* nameWith(
        [Effect.succeed({ label: '  "Reaper Retry   Storm" ' })],
        requests,
      );

      expect(label).toBe("reaper retry storm");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual(
        expect.objectContaining({
          context: "session-naming",
          provider: "claude",
          model: "claude-haiku-4-5",
          maxRounds: 1,
        }),
      );
      // Strict structured output (Codex's) takes only a closed object.
      expect(requests[0]?.outputSchema).toEqual(
        expect.objectContaining({
          type: "object",
          required: ["label"],
          additionalProperties: false,
        }),
      );
      expect(requests[0]?.prompt).toContain("fix the flaky retry loop");
    });
  });

  it.effect("falls back to the codex arm when the claude account is missing", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const label = yield* nameWith(
        [
          Effect.fail(
            new InferenceError({
              message: 'No claude connected account matches "default".',
              cause: null,
            }),
          ),
          Effect.succeed({ label: "reaper retry storm" }),
        ],
        requests,
      );

      expect(label).toBe("reaper retry storm");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(
        expect.objectContaining({ provider: "codex", model: "gpt-5.6-luna" }),
      );
    });
  });

  it.effect("does not switch subscriptions on a non-account failure", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        nameWith(
          [Effect.fail(new InferenceError({ message: "model overloaded", cause: null }))],
          requests,
        ),
      );

      expect(error.message).toBe("model overloaded");
      expect(requests).toHaveLength(1);
    });
  });

  it.effect("names nothing when the model answers an empty label", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      expect(yield* nameWith([Effect.succeed({ label: '  ""  ' })], requests)).toBeNull();
      expect(requests).toHaveLength(1);
    });
  });

  // SLNT-1230: a session on the owner's server was named "placeholder" by the model.
  for (const standIn of [
    "placeholder",
    "Untitled Session",
    "up-main session",
    "up-main placeholder input",
    "test session",
    "reaper retry storm",
  ]) {
    it.effect(`names nothing when the model answers the stand-in "${standIn}"`, () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        const label = yield* nameWith([Effect.succeed({ label: standIn })], requests, {
          harness: "claude",
          projectName: "up-main",
          messages: ["asdf"],
        });
        expect(label).toBeNull();
      });
    });
  }

  it.effect("keeps a label that names the work beside a stand-in word or the project", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const label = yield* nameWith([Effect.succeed({ label: "up-main login test" })], requests, {
        harness: "claude",
        projectName: "up-main",
        messages: ["the login test fails on ci"],
      });
      expect(label).toBe("up-main login test");
    });
  });

  it.effect("keeps an example label when the messages are about it", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const label = yield* nameWith([Effect.succeed({ label: "dark mode toggle" })], requests, {
        ...input,
        messages: ["the dark mode toggle forgets its state on reload"],
      });
      expect(label).toBe("dark mode toggle");
    });
  });

  for (const messages of [["hi"], ["Hello there!", "test"], ["."], ["   "], ["123"]]) {
    it.effect(`asks no model to name the small talk ${JSON.stringify(messages)}`, () => {
      const requests: Array<InferenceRequest> = [];
      return Effect.gen(function* () {
        expect(yield* nameWith([], requests, { ...input, messages })).toBeNull();
        expect(requests).toEqual([]);
      });
    });
  }

  it.effect("names from the later message after a first one that names nothing", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const label = yield* nameWith([Effect.succeed({ label: "login redirect loop" })], requests, {
        ...input,
        messages: ["hi", "the login page redirects to itself forever"],
      });
      expect(label).toBe("login redirect loop");
      expect(requests[0]?.prompt).toBe(
        "Project: mend. Harness: claude.\n\nThe session's first messages, oldest first:\n" +
          "1. hi\n\n2. the login page redirects to itself forever",
      );
    });
  });
});

describe("normalizeLabel", () => {
  it("strips quotes, collapses whitespace, and lowercases", () => {
    expect(normalizeLabel('"Dark  Mode\n Toggle"')).toBe("dark mode toggle");
  });

  it("caps overlong labels without a trailing space", () => {
    const normalized = normalizeLabel(`${"a".repeat(59)} ${"b".repeat(30)}`);
    expect(normalized).toBe("a".repeat(59));
  });

  it("returns undefined for effectively empty answers", () => {
    expect(normalizeLabel("   ")).toBeUndefined();
    expect(normalizeLabel('""')).toBeUndefined();
  });
});

describe("NameSessionJob", () => {
  const sessionId = "55555555-5555-5555-5555-555555555555";

  it("decodes the launch-time shape (no prompt) and the send-time shape (prompt inline)", () => {
    const launch = Schema.decodeUnknownSync(NameSessionJob)({ sessionId });
    expect(launch.firstUserTurn).toBeUndefined();

    const send = Schema.decodeUnknownSync(NameSessionJob)({
      sessionId,
      firstUserTurn: "fix the flaky retry loop",
    });
    expect(send.firstUserTurn).toBe("fix the flaky retry loop");
  });
});

describe("withoutFirstPrompt", () => {
  it("waits for a first prompt while the session can still get one, and stops once it settled", () => {
    expect(withoutFirstPrompt({ settledAt: null })).toBe("retry");
    expect(withoutFirstPrompt({ settledAt: new Date("2026-09-25T10:00:00.000Z") })).toBe(
      "leave-unnamed",
    );
  });
});
