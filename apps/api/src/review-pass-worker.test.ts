import { ChangePassesRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import type { PassKind } from "@mend/domain/workbench";
import { InferenceError } from "@mend/inference";
import { SealantPrincipal } from "@mend/sealant";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result } from "effect";

import { runReviewPass, UNKNOWN_ASKER, type ReviewPassJob } from "./review-pass-worker.ts";

/** The worker records the selected change and runs inference on the asker's own login. */
type Write =
  | { operation: "begin"; args: Parameters<ChangePassesRepo["Service"]["begin"]> }
  | { operation: "complete"; args: Parameters<ChangePassesRepo["Service"]["complete"]> }
  | { operation: "fail"; args: Parameters<ChangePassesRepo["Service"]["fail"]> };

const recordPasses = (writes: Array<Write>) =>
  Layer.mock(ChangePassesRepo, {
    begin: (...args) =>
      Effect.sync(() => {
        writes.push({ operation: "begin", args });
      }),
    complete: (...args) =>
      Effect.sync(() => {
        writes.push({ operation: "complete", args });
      }),
    fail: (...args) =>
      Effect.sync(() => {
        writes.push({ operation: "fail", args });
      }),
  });

const run = async (
  kind: PassKind,
  job: ReviewPassJob,
  outcome: Effect.Effect<unknown, InferenceError>,
  writes: Array<Write> = [],
) => {
  const principals: Array<typeof SealantPrincipal.Service> = [];
  const layer = recordPasses(writes);
  const pass = Effect.gen(function* () {
    principals.push(yield* SealantPrincipal);
    return yield* outcome;
  });
  const result = await Effect.runPromise(
    runReviewPass(kind, job, pass).pipe(Effect.provide(layer), Effect.result),
  );
  return { writes, principals, result };
};

const cases = [
  {
    kind: "tour",
    changeId: ChangeId.make("change-tour"),
    requestedBy: "carol",
    value: { text: "tour" },
    count: null,
  },
  { kind: "read", changeId: ChangeId.make("change-read"), requestedBy: "bob", value: 0, count: 0 },
  {
    kind: "suggest",
    changeId: ChangeId.make("change-suggest"),
    requestedBy: "alice",
    value: 2,
    count: 2,
  },
] satisfies ReadonlyArray<{
  kind: PassKind;
  changeId: ChangeId;
  requestedBy: string;
  value: unknown;
  count: number | null;
}>;

describe("runReviewPass", () => {
  it.effect("ends a tour when inference never answers", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const writes: Array<Write> = [];
      const layer = recordPasses(writes);
      const changeId = ChangeId.make("stalled-tour");
      const fiber = yield* runReviewPass(
        "tour",
        { changeId, requestedBy: "alice" },
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("4 minutes");
      expect(writes).toEqual([{ operation: "begin", args: [changeId, "tour"] }]);
      yield* TestClock.adjust("1 minute");
      expect(writes).toEqual([
        { operation: "begin", args: [changeId, "tour"] },
        {
          operation: "fail",
          args: [changeId, "tour", "The review pass timed out after 5 minutes. Ask for it again."],
        },
      ]);
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(true);
    }),
  );

  it("records a plain failure when the tour defects", async () => {
    const writes: Array<Write> = [];
    const changeId = ChangeId.make("defective-tour");
    await expect(
      run(
        "tour",
        { changeId, requestedBy: "alice" },
        Effect.die("unexpected tour failure"),
        writes,
      ),
    ).rejects.toBeDefined();
    expect(writes).toEqual([
      { operation: "begin", args: [changeId, "tour"] },
      {
        operation: "fail",
        args: [changeId, "tour", "The review pass failed unexpectedly. Ask for it again."],
      },
    ]);
  });

  it.effect("records interruption before the worker stops", () =>
    Effect.gen(function* () {
      const writes: Array<Write> = [];
      const changeId = ChangeId.make("interrupted-tour");
      const started = yield* Deferred.make<void>();
      const fiber = yield* runReviewPass(
        "tour",
        { changeId, requestedBy: "alice" },
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provide(recordPasses(writes)), Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(writes).toEqual([
        { operation: "begin", args: [changeId, "tour"] },
        {
          operation: "fail",
          args: [changeId, "tour", "The review pass was interrupted. Ask for it again."],
        },
      ]);
    }),
  );

  it.effect.each(["begin", "complete"] as const)("records failure if %s defects", (operation) =>
    Effect.gen(function* () {
      const changeId = ChangeId.make("write-defect");
      const details: Array<string> = [];
      const layer = Layer.mock(ChangePassesRepo, {
        begin: () => (operation === "begin" ? Effect.die("notification failed") : Effect.void),
        complete: () =>
          operation === "complete" ? Effect.die("result write failed") : Effect.void,
        fail: (_id, _kind, detail) =>
          Effect.sync(() => {
            details.push(detail);
          }),
      });
      const exit = yield* runReviewPass(
        "tour",
        { changeId, requestedBy: "alice" },
        Effect.succeed("tour"),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(details).toEqual(["The review pass failed unexpectedly. Ask for it again."]);
    }),
  );

  it.each(cases)(
    "records successful $kind on its change and asker's login",
    async ({ kind, changeId, requestedBy, value, count }) => {
      const { writes, principals, result } = await run(
        kind,
        { changeId, requestedBy },
        Effect.succeed(value),
      );
      expect(result).toEqual(Result.succeed(undefined));
      expect(principals).toEqual([{ kind: "user", userId: requestedBy }]);
      expect(writes).toEqual([
        { operation: "begin", args: [changeId, kind] },
        { operation: "complete", args: [changeId, kind, count] },
      ]);
    },
  );

  it.each(cases)(
    "records failed $kind on its change and propagates the inference failure",
    async ({ kind, changeId, requestedBy }) => {
      const failure = new InferenceError({
        message: "owned inference refusal",
        cause: new Error("synthetic provider refusal"),
      });
      const { writes, principals, result } = await run(
        kind,
        { changeId, requestedBy },
        Effect.fail(failure),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Worker swallowed inference failure");
      expect(result.failure).toBe(failure);
      expect(principals).toEqual([{ kind: "user", userId: requestedBy }]);
      expect(writes).toEqual([
        { operation: "begin", args: [changeId, kind] },
        { operation: "fail", args: [changeId, kind, "owned inference refusal"] },
      ]);
    },
  );

  it.each(cases)(
    "refuses $kind without a requester before running inference",
    async ({ kind, changeId }) => {
      const { writes, principals, result } = await run(
        kind,
        { changeId },
        Effect.die("must not run without an asker"),
      );
      expect(result).toEqual(Result.succeed(undefined));
      expect(principals).toEqual([]);
      expect(writes).toEqual([{ operation: "fail", args: [changeId, kind, UNKNOWN_ASKER] }]);
    },
  );
});
