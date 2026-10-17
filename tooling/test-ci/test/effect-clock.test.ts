import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
  assertClockFailure,
  assertPassed,
  effectTest,
  numPassedTests,
  preamble,
  runGuard,
} from "./effect-clock.helpers.ts";
import { isRecord } from "./fixture.ts";

/** Runner-independent cases import only Vitest; the Effect entrypoint pairs with Vitest 3 here. */
const plainTest = (name: string, body: string): string =>
  `import { it } from "vitest";\nit(${JSON.stringify(name)}, async () => { ${body} });`;

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
