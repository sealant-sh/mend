// Replacement TestClocks (a layer, a constructed clock, one a shared layer supplies, a live test's)
// warn through the guard as the default one does, and one replacement serves every consumer.

import { test } from "node:test";

import {
  assertClockFailure,
  assertPassed,
  preamble,
  runGuard,
  unadvancedSleeper,
} from "./effect-clock.helpers.ts";

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
