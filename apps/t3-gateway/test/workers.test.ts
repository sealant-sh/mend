import { Worker } from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";

import {
  DEFAULT_FIND_PARSER_POOL,
  FindParser,
  findParserLayer,
  type FindParserPool,
  NESTING_LIMIT,
} from "../src/find-parser.ts";
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
const findRequest = (text: string) => ({
  role: "assistant" as const,
  text,
  streaming: false,
  hasContext: false,
  cwd: undefined,
  skills: [],
});

/** Every worker the process starts while the scope is open, from Node's own `worker` event. */
const startedWorkers = Effect.acquireRelease(
  Effect.sync(() => {
    const started: Array<Worker> = [];
    const record = (worker: Worker) => started.push(worker);
    process.on("worker", record);
    return { started, record };
  }),
  ({ record }) => Effect.sync(() => process.off("worker", record)),
).pipe(Effect.map(({ started }) => started));

const terminateOnStart = (worker: Worker) => void worker.terminate();

/** Nested far past `NESTING_LIMIT`: its parse would run the find worker out of heap. */
const nestedQuotes = `${">".repeat(20_000)} x`;

/** Every permit is free: as many workers as the limit start, and one more does not. */
const assertCapacityFree = Effect.gen(function* () {
  const workers = yield* Effect.forEach(Array.from({ length: GATEWAY_WORKER_LIMIT }), () =>
    acquire.pipe(Effect.timeout("1 second")),
  );
  assert.lengthOf(workers, GATEWAY_WORKER_LIMIT);
  assert.isTrue(Option.isNone(yield* acquire.pipe(Effect.timeoutOption("50 millis"))));
}).pipe(Effect.scoped);

/**
 * A scheduler that makes a fiber yield after every few operations. Once armed with `k`, it lets `k`
 * more tasks run, then holds the rest and calls `onHold` until `open`.
 */
const makeGate = () => {
  const base = new Scheduler.MixedScheduler();
  const held: Array<() => void> = [];
  let armed: { passes: number; readonly onHold: () => void } | undefined;
  let terminated = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: base.executionMode,
    shouldYield: (fiber) => base.shouldYield(fiber),
    makeDispatcher: () => {
      const inner = base.makeDispatcher();
      return {
        scheduleTask: (task, priority) => {
          const run = () => inner.scheduleTask(task, priority);
          if (armed === undefined) return run();
          if (armed.passes > 0) {
            armed.passes -= 1;
            return run();
          }
          held.push(run);
          if (held.length === 1) {
            terminated = true;
            armed.onHold();
          }
        },
        flush: () => inner.flush(),
      };
    },
  };
  return {
    gated: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 3),
        Effect.provideService(Scheduler.Scheduler, scheduler),
      ),
    arm: (passes: number, onHold: () => void) => {
      armed = { passes, onHold };
    },
    open: () => {
      armed = undefined;
      for (const run of held.splice(0)) run();
    },
    terminated: () => terminated,
  };
};

type TerminateAt = "start" | "answer";

/** The default pool, its workers running `body` with `parentPort` in scope. */
const poolOf = (body: string): FindParserPool => ({
  ...DEFAULT_FIND_PARSER_POOL,
  entry: new URL(
    `data:text/javascript,${encodeURIComponent(
      `import { parentPort } from "node:worker_threads"; ${body}`,
    )}`,
  ),
});

/**
 * Its workers read a bold message as the find parse worker does without loading the markdown
 * parser. Loaded from source, that parser costs a loaded CI runner about two seconds per worker,
 * and a sweep starts more than a dozen.
 */
const sweptPool = poolOf(
  'parentPort.on("message", ({ text }) => parentPort.postMessage([text.replaceAll("*", "")]));',
);

/** Its workers throw at a message, as a parse that fails does; the message never answers. */
const crashingPool = poolOf(
  'parentPort.on("message", () => { throw new Error("parse failed"); });',
);

/** Its workers read `**warm**` as the find parse worker does, and never answer anything else. */
const holdingPool = poolOf(
  'parentPort.on("message", ({ text }) => { if (text === "**warm**") parentPort.postMessage(["warm"]); });',
);

/**
 * One find parse on a fresh layer whose worker is terminated at the `k`th scheduler task after it
 * starts or answers. The parse resumes once the parser has seen the exit. Then a second parse runs.
 */
const parseTerminatedAt = (at: TerminateAt, k: number) =>
  Effect.gen(function* () {
    const gate = makeGate();
    const watch = (worker: Worker) => {
      const arm = () =>
        gate.arm(k, () => {
          worker.once("exit", gate.open);
          void worker.terminate();
        });
      if (at === "start") arm();
      else worker.prependOnceListener("message", arm);
    };
    process.once("worker", watch);
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off("worker", watch)));
    const parser = yield* FindParser;
    const first = yield* gate
      .gated(parser.segments(findRequest("**needle**")))
      .pipe(Effect.timeout("5 seconds"));
    const second = yield* parser
      .segments(findRequest("**again**"))
      .pipe(Effect.timeout("5 seconds"));
    return { first, second, terminated: gate.terminated() };
  }).pipe(Effect.provide(findParserLayer(sweptPool)), Effect.scoped);

/**
 * Terminates the first parse's worker at each scheduler task from `at` in turn, until the parse
 * finishes before the task comes. Returns what each terminated first parse answered.
 */
const sweepTermination = (at: TerminateAt) =>
  Effect.gen(function* () {
    const firsts = new Set<string>();
    for (let k = 0; k < 200; k += 1) {
      const { first, second, terminated } = yield* parseTerminatedAt(at, k);
      assert.deepStrictEqual(second, ["again"], `a parse after termination at task ${k}`);
      yield* assertCapacityFree;
      if (!terminated) return firsts;
      firsts.add(first.join(""));
    }
    assert.fail("the sweep never reached the end of the first parse");
    return firsts;
  });

const crashPooledFindWorker = Effect.gen(function* () {
  const started = yield* startedWorkers;
  const parser = yield* FindParser;
  assert.deepStrictEqual(yield* parser.segments(findRequest("**needle**")), ["needle"]);
  const pooled = started[0];
  assert.lengthOf(started, 1);
  if (pooled === undefined) return parser;
  yield* Effect.promise(() => pooled.terminate());
  return parser;
});

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

  it.live("returns the permit of a pooled find worker that exits while idle", () =>
    Effect.gen(function* () {
      yield* crashPooledFindWorker;
      yield* assertCapacityFree;
    }).pipe(Effect.provide(findParserLayer()), Effect.scoped),
  );

  it.live("parses on a fresh worker after the pooled find worker exits while idle", () =>
    Effect.gen(function* () {
      const parser = yield* crashPooledFindWorker;
      assert.deepStrictEqual(
        yield* parser.segments(findRequest("**again**")).pipe(Effect.timeout("5 seconds")),
        ["again"],
      );
    }).pipe(Effect.provide(findParserLayer()), Effect.scoped, Effect.andThen(assertCapacityFree)),
  );

  it.live(
    "reads a message as written when its find worker exits mid-parse, and returns the permit",
    () =>
      Effect.gen(function* () {
        process.once("worker", terminateOnStart);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => process.off("worker", terminateOnStart)),
        );
        const parser = yield* FindParser;
        assert.deepStrictEqual(
          yield* parser.segments(findRequest("**needle**")).pipe(Effect.timeout("5 seconds")),
          ["**needle**"],
        );
        yield* assertCapacityFree;
      }).pipe(Effect.provide(findParserLayer()), Effect.scoped),
  );

  it.live(
    "reads a message as written when its find worker crashes with an error, and returns the permit once",
    () =>
      Effect.gen(function* () {
        const started = yield* startedWorkers;
        const crashed = new Promise<ReadonlyArray<string>>((resolve) => {
          const watch = (worker: Worker) => {
            const events: Array<string> = [];
            worker.on("error", () => events.push("error"));
            worker.on("exit", () => resolve([...events, "exit"]));
          };
          process.once("worker", watch);
        });
        const parser = yield* FindParser;
        assert.deepStrictEqual(
          yield* parser.segments(findRequest("**needle**")).pipe(Effect.timeout("5 seconds")),
          ["**needle**"],
        );
        assert.deepStrictEqual(yield* Effect.promise(() => crashed), ["error", "exit"]);
        assert.lengthOf(started, 1);
        yield* assertCapacityFree;
      }).pipe(Effect.provide(findParserLayer(crashingPool)), Effect.scoped),
  );

  it.live("reads a message nested deeper than its limit as written, and starts no worker", () =>
    Effect.gen(function* () {
      const started = yield* startedWorkers;
      const parser = yield* FindParser;
      const deep = `${"- ".repeat(NESTING_LIMIT + 1)}**needle**`;
      assert.deepStrictEqual(yield* parser.segments(findRequest(deep)), [deep]);
      assert.deepStrictEqual(yield* parser.segments(findRequest(nestedQuotes)), [nestedQuotes]);
      assert.lengthOf(started, 0);
      const within = `${"- ".repeat(NESTING_LIMIT)}**needle**`;
      assert.deepStrictEqual(yield* parser.segments(findRequest(within)), [
        within.replaceAll("*", ""),
      ]);
      assert.lengthOf(started, 1);
    }).pipe(Effect.provide(findParserLayer(sweptPool)), Effect.scoped),
  );

  it.live(
    "answers every parse whose worker is terminated before its acquisition finishes",
    () =>
      Effect.gen(function* () {
        const firsts = yield* sweepTermination("start");
        assert.isTrue(firsts.has("**needle**"), "some termination read the message as written");
      }),
    30_000,
  );

  it.live(
    "never pools a worker terminated after its answer, before it is put back",
    () =>
      Effect.gen(function* () {
        const firsts = yield* sweepTermination("answer");
        assert.deepStrictEqual([...firsts], ["needle"]);
      }),
    30_000,
  );

  it.live("reads an in-flight message as written when the find layer closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const parser = Context.get(
        yield* Layer.buildWithScope(findParserLayer(holdingPool), scope),
        FindParser,
      );
      assert.deepStrictEqual(yield* parser.segments(findRequest("**warm**")), ["warm"]);
      const parse = yield* Effect.forkChild(parser.segments(findRequest("**held**")));
      yield* Effect.sleep("50 millis");
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(yield* Fiber.join(parse).pipe(Effect.timeout("1 second")), [
        "**held**",
      ]);
      yield* assertCapacityFree;
    }),
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
