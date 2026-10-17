// What effect-clock*.test.ts share: a fixture run of the CI guard, and what each asserts of it.

import assert from "node:assert/strict";

import { isRecord, runFixture } from "./fixture.ts";

export const preamble = `import { it, expect } from "vitest";
import { it as effectIt, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Context, Duration, Effect, Fiber, Layer, Logger, References } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
`;

export const effectTest = (name: string, body: string): string =>
  `effectIt.effect(${JSON.stringify(name)}, () => ${body});`;

export const runGuard = async (options: {
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

export const numPassedTests = (json: unknown): unknown =>
  isRecord(json) ? json["numPassedTests"] : json;

export const assertClockFailure = (
  result: Awaited<ReturnType<typeof runGuard>>,
  location: string,
): void => {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /@mend\/fixture Clock warning:/);
  assert.ok(result.output.includes(location), result.output);
  // Vitest's JSON success omits unhandled errors; the runner's exit is the failure oracle.
  assert.equal(numPassedTests(result.json), 1, JSON.stringify(result.json));
};

export const assertPassed = (result: Awaited<ReturnType<typeof runGuard>>): void => {
  assert.equal(result.code, 0, result.output);
  assert.ok(isRecord(result.json) && result.json["success"] === true, result.output);
  assert.equal(numPassedTests(result.json), 1);
};

export const unadvancedSleeper = `Effect.gen(function* () {
  const sleeper = yield* Effect.sleep("10 seconds").pipe(Effect.forkScoped);
  yield* TestClock.withLive(Effect.sleep("1200 millis"));
  yield* TestClock.adjust("10 seconds");
  yield* Fiber.join(sleeper);
})`;
