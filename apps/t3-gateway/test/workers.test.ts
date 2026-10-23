import { Worker } from "node:worker_threads";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";

import { FindParser, findParserLayer } from "../src/find-parser.ts";
import { highlightLines } from "../src/highlight.ts";
import { GATEWAY_WORKER_LIMIT, startGatewayWorker } from "../src/workers.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";

const waitingWorker = () =>
  new Worker('require("node:worker_threads").parentPort.on("message", () => {});', {
    eval: true,
    resourceLimits: { codeRangeSizeMb: 64 },
  });

const acquire = Effect.acquireRelease(startGatewayWorker(waitingWorker), ({ stop }) => stop);
const query = { query: "n[e]+dle", caseSensitive: true, wholeWord: false, useRegex: true };

describe("gateway worker capacity", () => {
  it.live("preserves every permit when acquisition is canceled at scheduler boundaries", () =>
    Effect.gen(function* () {
      for (const { ops, ticks } of [
        { ops: 9, ticks: 1 },
        { ops: 3, ticks: 7 },
      ]) {
        const fiber = yield* Effect.acquireUseRelease(
          startGatewayWorker(waitingWorker),
          () => Effect.never,
          ({ stop }) => stop,
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, ops), Effect.forkChild);
        for (let i = 0; i < ticks; i += 1) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        yield* Effect.gen(function* () {
          const workers = yield* Effect.forEach(Array.from({ length: GATEWAY_WORKER_LIMIT }), () =>
            acquire.pipe(Effect.timeout("1 second")),
          );
          assert.lengthOf(workers, GATEWAY_WORKER_LIMIT);
        }).pipe(Effect.scoped);
      }
    }),
  );

  it.live(
    "bounds live isolates, includes the highlight queue in its budget, and returns capacity only once after termination",
    () =>
      Effect.gen(function* () {
        const workers = yield* Effect.forEach(
          Array.from({ length: GATEWAY_WORKER_LIMIT }),
          () => acquire,
        );
        let created = false;
        const another = startGatewayWorker(() => {
          created = true;
          return waitingWorker();
        });
        assert.isTrue(Option.isNone(yield* another.pipe(Effect.timeoutOption("20 millis"))));
        assert.isFalse(created);
        assert.deepStrictEqual(yield* highlightLines(["a needle"], query), [[]]);

        const first = workers[0];
        assert.isDefined(first);
        if (first === undefined) return;
        yield* Effect.all([first.stop, first.stop], { concurrency: "unbounded" });
        assert.strictEqual(first.worker.threadId, -1);
        yield* acquire;
        assert.isTrue(Option.isNone(yield* another.pipe(Effect.timeoutOption("20 millis"))));
        assert.isFalse(created);
      }).pipe(Effect.scoped),
  );

  it.live(
    "counts a pooled find worker while idle and shares the remaining capacity with highlights",
    () =>
      Effect.gen(function* () {
        const parser = yield* FindParser;
        assert.deepStrictEqual(
          yield* parser.segments({
            role: "assistant",
            text: "**needle**",
            streaming: false,
            hasContext: false,
            cwd: undefined,
            skills: [],
          }),
          ["needle"],
        );
        yield* Effect.forEach(Array.from({ length: GATEWAY_WORKER_LIMIT - 1 }), () => acquire);
        assert.deepStrictEqual(yield* highlightLines(["a needle"], query), [[]]);
        assert.deepStrictEqual(
          yield* parser.segments({
            role: "assistant",
            text: "**reused**",
            streaming: false,
            hasContext: false,
            cwd: undefined,
            skills: [],
          }),
          ["reused"],
        );
      }).pipe(Effect.provide(findParserLayer()), Effect.scoped),
  );

  it.live("returns a permit when a worker constructor fails", () =>
    Effect.gen(function* () {
      for (let i = 0; i < GATEWAY_WORKER_LIMIT; i += 1) {
        const exit = yield* Effect.exit(
          startGatewayWorker(() => {
            throw new Error("cannot start");
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }
      const workers = yield* Effect.forEach(
        Array.from({ length: GATEWAY_WORKER_LIMIT }),
        () => acquire,
      );
      assert.lengthOf(workers, GATEWAY_WORKER_LIMIT);
    }).pipe(Effect.scoped),
  );
});
