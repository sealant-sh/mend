import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { isRecord, runFixture } from "./fixture.ts";

const preamble = `import { it, expect } from "vitest";
import { it as effectIt, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Context, Duration, Effect, Fiber, Layer, Logger, References } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
`;

/** Runner-independent cases import only Vitest; the Effect entrypoint pairs with Vitest 3 here. */
const plainTest = (name: string, body: string): string =>
  `import { it } from "vitest";\nit(${JSON.stringify(name)}, async () => { ${body} });`;

const effectTest = (name: string, body: string): string =>
  `effectIt.effect(${JSON.stringify(name)}, () => ${body});`;

const runGuard = async (options: {
  readonly source: string;
  readonly budgetMs?: number;
  readonly json?: boolean;
  readonly runner?: string;
}) => {
  const result = await runFixture({
    runner: options.runner ?? "vitest",
    budgetMs: options.budgetMs ?? 10_000,
    json: options.json ?? true,
    modules: ["effect"],
    source: options.source,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.signal, null, output);
  return { code: result.code, output, json: result.json };
};

const numPassedTests = (json: unknown): unknown => (isRecord(json) ? json["numPassedTests"] : json);

const assertClockFailure = (
  result: Awaited<ReturnType<typeof runGuard>>,
  location: string,
): void => {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /@mend\/fixture Clock warning:/);
  assert.ok(result.output.includes(location), result.output);
  // Vitest's JSON success omits unhandled errors; the runner's exit is the failure oracle.
  assert.equal(numPassedTests(result.json), 1, JSON.stringify(result.json));
};

const assertPassed = (result: Awaited<ReturnType<typeof runGuard>>): void => {
  assert.equal(result.code, 0, result.output);
  assert.ok(isRecord(result.json) && result.json["success"] === true, result.output);
  assert.equal(numPassedTests(result.json), 1);
};

for (const runner of ["vitest", "vitest-v5"]) {
  test(`${runner}: fails the runner on file execution budget even with a JSON reporter override`, async () => {
    const result = await runGuard({
      runner,
      budgetMs: 40,
      source: plainTest("slow file", "await new Promise((resolve) => setTimeout(resolve, 120));"),
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /CI file execution budget exceeded:/);
    assert.match(result.output, /guard\.test\.ts/);
    assert.equal(numPassedTests(result.json), 1);
  });

  test(`${runner}: fails the runner on a Clock warning and identifies its package, file and test`, async () => {
    const result = await runGuard({
      runner,
      source: plainTest(
        "clock warning owner",
        'console.warn("Warning: A test is using time, but is not advancing the test clock.");',
      ),
    });
    assertClockFailure(result, "guard.test.ts > clock warning owner");
    const json = result.json;
    assert.ok(isRecord(json) && Array.isArray(json["testResults"]));
    const [file]: ReadonlyArray<unknown> = json["testResults"];
    assert.ok(isRecord(file) && Array.isArray(file["assertionResults"]));
    assert.deepEqual(
      file["assertionResults"].map((entry: unknown) => (isRecord(entry) ? entry["status"] : entry)),
      ["passed"],
    );
  });

  test(`${runner}: passes a below-budget file with an unrelated warning and retains JSON output`, async () => {
    const result = await runGuard({
      runner,
      source: plainTest("ordinary warning", 'console.warn("ordinary fixture warning");'),
    });
    assertPassed(result);
  });

  test(`${runner}: retains the default reporter for a passing file`, async () => {
    const result = await runGuard({
      runner,
      json: false,
      source: plainTest("default reporter control", ""),
    });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes("\u001b["));
    assert.match(stripVTControlCharacters(result.output), /Test Files\s+1 passed/);
  });
}

for (const capture of ["test console", "private logger"]) {
  test(`fails on a real unadvanced TestClock warning captured by ${capture}`, async () => {
    const name = `unadvanced clock with ${capture}`;
    const result = await runGuard({
      source:
        preamble +
        effectTest(
          name,
          `Effect.gen(function* () {
        const logs = [];
        const program = Effect.gen(function* () {
          const sleeper = yield* Effect.sleep("10 seconds").pipe(Effect.forkScoped);
          yield* TestClock.withLive(Effect.sleep("1200 millis"));
          ${capture === "test console" ? 'const captured = yield* TestConsole.logLines; expect(JSON.stringify(captured)).toContain("not advancing the test clock");' : 'expect(JSON.stringify(logs)).toContain("not advancing the test clock");'}
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(sleeper);
        });
        yield* ${capture === "private logger" ? "program.pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])))" : "program"};
      })`,
        ),
    });
    assertClockFailure(result, `guard.test.ts > ${name}`);
  });
}

test("fails on a real warning from a clock captured during shared-layer construction", async () => {
  const result = await runGuard({
    source: `${preamble}
      class Sleeper extends Context.Service()("guard/Sleeper") {}
      const sleeperLayer = Layer.effect(Sleeper, Clock.clockWith(clock =>
        Effect.succeed({ sleep: clock.sleep(Duration.seconds(10)) })));
      effectIt.layer(sleeperLayer)("shared", it => {
        it.layer(Layer.empty)("nested", it => {
          it.effect("captured clock", () => Effect.gen(function* () {
            const sleeper = yield* Sleeper;
            const fiber = yield* sleeper.sleep.pipe(Effect.forkScoped);
            yield* TestClock.withLive(Effect.sleep("1200 millis"));
            yield* TestClock.adjust("10 seconds");
            yield* Fiber.join(fiber);
          }).pipe(Effect.provide(Logger.layer([Logger.make(() => {})]))));
        });
      });`,
  });
  assertClockFailure(result, "shared > nested > captured clock");
});

test("retains virtual boundaries, scoped cancellation and the live-clock escape", async () => {
  const result = await runGuard({
    source:
      preamble +
      effectTest(
        "clock controls",
        `Effect.gen(function* () {
      const ticks = [];
      yield* TestClock.setTime(100);
      const sleeper = yield* Effect.sleep("10 millis").pipe(
        Effect.andThen(Clock.currentTimeMillis), Effect.tap(time => Effect.sync(() => ticks.push(time))), Effect.forkScoped);
      yield* TestClock.adjust("9 millis");
      expect(ticks).toEqual([]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(sleeper);
      expect(ticks).toEqual([110]);
      expect(yield* Clock.currentTimeNanos).toBe(110000000n);
      yield* Effect.scoped(Effect.sleep("1 hour").pipe(Effect.andThen(Effect.sync(() => ticks.push("late"))), Effect.forkScoped));
      yield* TestClock.adjust("1 hour");
      expect(ticks).toEqual([110]);
      const virtual = yield* Clock.currentTimeMillis;
      const live = yield* TestClock.withLive(Clock.currentTimeMillis);
      expect(live).toBeGreaterThan(virtual);
    })`,
      ),
  });
  assertPassed(result);
});

test("preserves the live Clock in a shared layer that excludes test services", async () => {
  const result = await runGuard({
    source: `${preamble}effectIt.layer(Layer.empty, { excludeTestServices: true })("live shared", it => {
      it.effect("prototype clock methods", () => Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        expect(clock.currentTimeMillisUnsafe()).toBeGreaterThan(0);
        expect(clock.currentTimeNanosUnsafe()).toBeGreaterThan(0n);
        yield* Effect.logInfo("live clock logging still works");
        yield* Effect.sleep("1 millis");
      }));
    });`,
  });
  assertPassed(result);
});

const unadvancedSleeper = `Effect.gen(function* () {
  const sleeper = yield* Effect.sleep("10 seconds").pipe(Effect.forkScoped);
  yield* TestClock.withLive(Effect.sleep("1200 millis"));
  yield* TestClock.adjust("10 seconds");
  yield* Fiber.join(sleeper);
})`;

for (const { name, registration } of [
  {
    name: "replacement layer",
    registration: `effectIt.effect("replacement layer", () =>
    ${unadvancedSleeper}.pipe(Effect.provide(TestClock.layer()), TestClock.withLive));`,
  },
  {
    name: "constructed replacement",
    registration: `effectIt.effect("constructed replacement", () => Effect.gen(function* () {
    const clock = yield* TestClock.withLive(TestClock.make());
    yield* ${unadvancedSleeper}.pipe(Effect.provideService(Clock.Clock, clock));
  }));`,
  },
  {
    name: "internally supplied shared-layer clock",
    registration: `
    class Sleeper extends Context.Service()("guard/ReplacementSleeper") {}
    const sleeperLayer = Layer.effect(Sleeper, TestClock.testClockWith(clock => Effect.succeed({
      sleep: clock.sleep(Duration.seconds(10)),
      advance: clock.adjust("10 seconds"),
      wait: clock.withLive(Effect.sleep("1200 millis"))
    }))).pipe(Layer.provide(TestClock.layer()));
    effectIt.layer(sleeperLayer, { excludeTestServices: true })("shared replacement", it => {
      it.effect("internally supplied shared-layer clock", () => Effect.gen(function* () {
        const service = yield* Sleeper;
        const fiber = yield* service.sleep.pipe(Effect.forkScoped);
        yield* service.wait;
        yield* service.advance;
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(Logger.layer([Logger.make(() => {})]))));
    });`,
  },
  {
    name: "live test with test services",
    registration: `effectIt.live("live test with test services", () =>
    ${unadvancedSleeper}.pipe(Effect.provide([TestClock.layer(), TestConsole.layer])));`,
  },
  {
    name: "minimum log level Error",
    registration: `effectIt.effect("minimum log level Error", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hidden before");
      yield* Effect.logError("visible before");
      yield* ${unadvancedSleeper};
      yield* Effect.logInfo("hidden after");
      yield* Effect.logError("visible after");
      const captured = JSON.stringify(yield* TestConsole.logLines);
      expect(captured).not.toContain("hidden");
      expect(captured).not.toContain("not advancing the test clock");
      expect(captured).toContain("visible before"); expect(captured).toContain("visible after");
    }).pipe(Effect.provideService(References.MinimumLogLevel, "Error")));`,
  },
  {
    name: "minimum log level None",
    registration: `effectIt.effect("minimum log level None", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hidden before");
      yield* Effect.logError("visible before");
      yield* ${unadvancedSleeper};
      yield* Effect.logInfo("hidden after");
      yield* Effect.logError("visible after");
      const captured = JSON.stringify(yield* TestConsole.logLines);
      expect(captured).not.toContain("hidden");
      expect(captured).not.toContain("not advancing the test clock");
      expect(captured).not.toContain("visible");
    }).pipe(Effect.provideService(References.MinimumLogLevel, "None")));`,
  },
]) {
  test(`fails the runner for ${name}`, async () => {
    assertClockFailure(await runGuard({ source: preamble + registration }), name);
  });
}

test("shares one replacement clock across consumers of the same layer", async () => {
  const result = await runGuard({
    source: `${preamble}
      class First extends Context.Service()("guard/First") {}
      class Second extends Context.Service()("guard/Second") {}
      const clockLayer = TestClock.layer();
      const firstLayer = Layer.effect(First, Clock.clockWith(Effect.succeed)).pipe(Layer.provide(clockLayer));
      const secondLayer = Layer.effect(Second, Clock.clockWith(Effect.succeed)).pipe(Layer.provide(clockLayer));
      effectIt.layer(Layer.merge(firstLayer, secondLayer), { excludeTestServices: true })(it => {
        it.effect("shared replacement identity", () => Effect.gen(function* () {
          const first = yield* First;
          const second = yield* Second;
          expect(first).toBe(second);
          const completed = [];
          const sleeper = yield* first.sleep(Duration.millis(10)).pipe(
            Effect.andThen(Effect.sync(() => completed.push(second.currentTimeMillisUnsafe()))), Effect.forkScoped);
          yield* second.adjust(9);
          expect(completed).toEqual([]);
          yield* second.adjust(1);
          yield* Fiber.join(sleeper);
          expect(completed).toEqual([10]);
        }));
      });`,
  });
  assertPassed(result);
});
