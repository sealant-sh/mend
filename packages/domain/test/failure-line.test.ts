import { it } from "@mend/test-ci/effect-vitest";
import { Cause, Effect, Logger, References, Schema } from "effect";
import { describe, expect } from "vitest";

import {
  failureLine,
  failureName,
  lineFailureOf,
  ReaderWords,
  WITHHELD,
} from "../src/failure-line.ts";

const WORDS = "Anna is interviewing at Northwind on Friday, keep it quiet";

class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {
  get [ReaderWords](): string {
    return this.message;
  }
}

class Unreviewed extends Schema.TaggedError<Unreviewed>()("Unreviewed", {
  message: Schema.String,
}) {}

class SometimesSaid extends Schema.TaggedError<SometimesSaid>()("SometimesSaid", {
  message: Schema.String,
  approved: Schema.Boolean,
}) {
  get [ReaderWords](): string | undefined {
    return this.approved ? this.message : undefined;
  }
}

class EffectDrizzleQueryError extends Schema.TaggedError<EffectDrizzleQueryError>()(
  "EffectDrizzleQueryError",
  { query: Schema.String },
) {}

/** The line, and every Error entry logged while it was made. */
const lineOf = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const errors: Array<Record<string, unknown>> = [];
    const logger = Logger.layer([
      Logger.make((options) => {
        if (options.logLevel !== "Error") return;
        errors.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
      }),
    ]);
    const line = yield* failureLine(cause).pipe(Effect.provide(logger));
    return { line, errors };
  });

describe("a failure on a line (SLNT-385)", () => {
  it.effect("says a failure whose class approved its words", () =>
    Effect.gen(function* () {
      const { line, errors } = yield* lineOf(Cause.fail(new Refused({ message: "no login" })));
      expect(line).toBe("no login");
      expect(errors).toEqual([]);
    }),
  );

  it.effect(
    "withholds an Error, a string defect and a typed error that never opted in, each as a logged reference",
    () =>
      Effect.gen(function* () {
        for (const cause of [
          Cause.die(new Error(WORDS)),
          Cause.die(WORDS),
          Cause.fail(new Unreviewed({ message: WORDS })),
          Cause.fail(new SometimesSaid({ message: WORDS, approved: false })),
        ]) {
          const { line, errors } = yield* lineOf(cause);
          expect(line).toMatch(/^internal error · reference [0-9a-f]{16}$/);
          expect(line).toMatch(WITHHELD);
          const reference = line.slice(-16);
          expect(errors).toHaveLength(1);
          expect(errors[0]?.["reference"]).toBe(reference);
          expect(String(errors[0]?.["cause"])).toContain(WORDS);
        }
      }),
  );

  it.effect("names a query error's failure as a database operation, its words withheld", () =>
    Effect.gen(function* () {
      const { line, errors } = yield* lineOf(
        Cause.die(new EffectDrizzleQueryError({ query: `insert … ${WORDS}` })),
      );
      expect(line).toMatch(/^database operation failed · reference [0-9a-f]{16}$/);
      expect(line).toMatch(WITHHELD);
      expect(errors[0]?.["failure"]).toBe("EffectDrizzleQueryError");
    }),
  );

  it.effect("keeps an interruption an interruption", () =>
    Effect.gen(function* () {
      const { line, errors } = yield* lineOf(Cause.interrupt());
      expect(line).toBe("interrupted");
      expect(errors).toEqual([]);
    }),
  );

  it.effect("reads the failure Cause.squash would: the first failure before any defect", () =>
    Effect.gen(function* () {
      const cause = Cause.combine(
        Cause.die(new Error(WORDS)),
        Cause.fail(new Refused({ message: "no login" })),
      );
      expect(lineFailureOf(cause)).toMatchObject({ _tag: "Said", words: "no login" });
      expect(lineFailureOf(Cause.die(new Error(WORDS)))).toEqual({
        _tag: "Withheld",
        name: "Error",
      });
      expect(lineFailureOf(Cause.combine(Cause.interrupt(), Cause.die(WORDS)))).toEqual({
        _tag: "Withheld",
        name: "string",
      });
      expect(lineFailureOf(Cause.interrupt())).toEqual({ _tag: "Interrupted" });
    }),
  );

  it("names a failure for a log, never quoting it", () => {
    expect(failureName(Cause.fail(new Unreviewed({ message: WORDS })))).toBe("Unreviewed");
    expect(failureName(Cause.die(new TypeError(WORDS)))).toBe("TypeError");
    expect(failureName(Cause.die(WORDS))).toBe("string");
    expect(failureName(Cause.die({}))).toBe("unknown");
  });
});
