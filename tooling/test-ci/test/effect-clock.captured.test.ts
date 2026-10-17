// Real unadvanced-TestClock warnings the guard must fail on, wherever the warning is captured:
// the test console, a private logger, a shared layer's clock, or a log level that hides it.

import { test } from "node:test";

import {
  assertClockFailure,
  effectTest,
  preamble,
  runGuard,
  unadvancedSleeper,
} from "./effect-clock.helpers.ts";

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

for (const { name, registration } of [
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
