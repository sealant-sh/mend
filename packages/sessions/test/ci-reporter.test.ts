import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const vitestCli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const effectTestPath = fileURLToPath(new URL("./effect-vitest.ts", import.meta.url));
const reporterPath = fileURLToPath(new URL("./ci-reporter.ts", import.meta.url));
const modulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));

const runFixture = async (options: {
  readonly budgetMs: number;
  readonly testName: string;
  readonly body: string;
  readonly effectBody?: string;
  readonly registration?: string;
  readonly jsonReporter: boolean;
}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-sessions-ci-guard-"));
  try {
    await symlink(modulesPath, path.join(directory, "node_modules"), "dir");
    await writeFile(
      path.join(directory, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";
import { sessionsCiGuard } from ${JSON.stringify(reporterPath)};
export default defineConfig({ plugins: [sessionsCiGuard({ fileBudgetMs: ${options.budgetMs} })] });
`,
    );
    await writeFile(
      path.join(directory, "guard.test.ts"),
      `import { it, expect } from "vitest";
import { it as effectIt, TestClock } from ${JSON.stringify(effectTestPath)};
import { Clock, Context, Duration, Effect, Fiber, Layer, Logger, References } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
${options.registration ?? (options.effectBody === undefined ? `it(${JSON.stringify(options.testName)}, async () => { ${options.body} });` : `effectIt.effect(${JSON.stringify(options.testName)}, () => ${options.effectBody});`)}
`,
    );
    const outputFile = path.join(directory, "report.json");
    const args = [vitestCli, "run", "guard.test.ts"];
    if (options.jsonReporter) args.push("--reporter=json", `--outputFile=${outputFile}`);
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }>((resolve, reject) => {
      // This bounds only the isolated runner's startup and shutdown, not any sessions test.
      const child = spawn(process.execPath, args, {
        cwd: directory,
        env: { ...process.env, CI: "true", FORCE_COLOR: "1", NO_COLOR: undefined },
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, output }));
    });
    const json: unknown = options.jsonReporter
      ? JSON.parse(await readFile(outputFile, "utf8"))
      : undefined;
    return { ...result, json };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Each case starts a real isolated Vitest process; allow its bounded startup and shutdown.
it(
  "fails the runner on file execution budget even with a JSON reporter override",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 40,
      testName: "slow file",
      body: "await new Promise((resolve) => setTimeout(resolve, 120));",
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sessions file execution budget exceeded:");
    expect(result.output).toContain("guard.test.ts");
    // Vitest 3's JSON success omits unhandled errors; the runner's exit is the failure oracle.
    expect(result.json).toMatchObject({
      numPassedTests: 1,
      testResults: [{ assertionResults: [{ status: "passed" }] }],
    });
  },
);

it(
  "fails the runner on a Clock warning and identifies its file and test with JSON output",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "clock warning owner",
      body: 'console.warn("Warning: A test is using time, but is not advancing the test clock.");',
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sessions Clock warning:");
    expect(result.output).toContain("guard.test.ts > clock warning owner");
    expect(result.json).toMatchObject({
      numPassedTests: 1,
      testResults: [{ assertionResults: [{ status: "passed" }] }],
    });
  },
);

it(
  "passes a below-budget file with an unrelated warning and retains JSON output",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "ordinary warning",
      body: 'console.warn("ordinary fixture warning");',
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
  },
);

it("retains the default reporter for a passing file", { timeout: 30_000 }, async () => {
  const result = await runFixture({
    budgetMs: 10_000,
    testName: "default reporter control",
    body: "",
    jsonReporter: false,
  });
  expect(result.signal).toBeNull();
  expect(result.code).toBe(0);
  expect(result.output).toContain("\u001b[");
  expect(stripVTControlCharacters(result.output)).toMatch(/Test Files\s+1 passed/);
});

for (const capture of ["test console", "private logger"]) {
  it(
    `fails on a real unadvanced TestClock warning captured by ${capture}`,
    { timeout: 30_000 },
    async () => {
      const result = await runFixture({
        budgetMs: 10_000,
        testName: `unadvanced clock with ${capture}`,
        body: "",
        effectBody: `Effect.gen(function* () {
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
        jsonReporter: true,
      });
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(result.output).toContain("sessions Clock warning:");
      expect(result.output).toContain(`guard.test.ts > unadvanced clock with ${capture}`);
      expect(result.json).toMatchObject({ numPassedTests: 1 });
    },
  );
}

it(
  "fails on a real warning from a clock captured during shared-layer construction",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "shared layer clock",
      body: "",
      registration: `
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
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sessions Clock warning:");
    expect(result.output).toContain("shared > nested > captured clock");
    expect(result.json).toMatchObject({ numPassedTests: 1 });
  },
);

it(
  "retains virtual boundaries, scoped cancellation and the live-clock escape",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "clock controls",
      body: "",
      effectBody: `Effect.gen(function* () {
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
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
  },
);

it(
  "preserves the live Clock in a shared layer that excludes test services",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "live shared layer",
      body: "",
      registration: `effectIt.layer(Layer.empty, { excludeTestServices: true })("live shared", it => {
      it.effect("prototype clock methods", () => Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        expect(clock.currentTimeMillisUnsafe()).toBeGreaterThan(0);
        expect(clock.currentTimeNanosUnsafe()).toBeGreaterThan(0n);
        yield* Effect.logInfo("live clock logging still works");
        yield* Effect.sleep("1 millis");
      }));
    });`,
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
  },
);

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
  it(`fails the runner for ${name}`, { timeout: 30_000 }, async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: name,
      body: "",
      registration,
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output, JSON.stringify(result.json)).toContain("sessions Clock warning:");
    expect(result.output).toContain(name);
    expect(result.json).toMatchObject({ numPassedTests: 1 });
  });
}

it(
  "shares one replacement clock across consumers of the same layer",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "shared replacement identity",
      body: "",
      registration: `
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
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code, JSON.stringify(result.json)).toBe(0);
    expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
  },
);
