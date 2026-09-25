import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { InferenceError, InferenceProvider, type InferenceRequest } from "./provider.ts";
import {
  NameSessionJob,
  normalizeLabel,
  SessionNamer,
  SessionNamerLive,
  withoutFirstPrompt,
} from "./session-namer.ts";

const input = {
  harness: "claude",
  projectName: "mend",
  firstUserTurn: "fix the flaky retry loop in the workspace reaper",
};

/** Runs the namer against a scripted provider; each call shifts the next scripted outcome. */
const nameWith = (
  outcomes: Array<Effect.Effect<unknown, InferenceError>>,
  requests: Array<InferenceRequest>,
) =>
  Effect.gen(function* () {
    const namer = yield* SessionNamer;
    return yield* namer.name(input);
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
      ),
    ),
  );

describe("SessionNamer", () => {
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
      expect(requests[0]?.outputSchema).toBeDefined();
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

  it.effect("fails rather than writing an empty label", () => {
    const requests: Array<InferenceRequest> = [];
    return Effect.gen(function* () {
      const error = yield* Effect.flip(nameWith([Effect.succeed({ label: '  ""  ' })], requests));
      expect(error.message).toContain("empty");
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
