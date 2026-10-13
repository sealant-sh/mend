import * as EffectVitest from "@effect/vitest";
import { Clock, Effect, Layer, Logger, LogLevel, References } from "effect";
import { TestClock as RawTestClock } from "effect/testing";

export * from "@effect/vitest";

const clockWarning =
  "A test is using time, but is not advancing the test clock, which may result in the test hanging. Use TestClock.adjust to manually advance the time.";
const hostWarn = console.warn.bind(console);
// Constructors and test boundaries can both see the same clock. Decoration is
// idempotent so one warning retains one diagnostic and one copy in fixture logs.
const guardedClocks = new WeakSet<Clock.Clock>();
const guardClock = <C extends Clock.Clock>(clock: C): C => {
  if (guardedClocks.has(clock)) return clock;
  const guarded = {
    ...clock,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanos: clock.currentTimeNanos,
    sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) =>
      Effect.gen(function* () {
        const loggers = yield* Logger.CurrentLoggers;
        const minimum = yield* References.MinimumLogLevel;
        const diagnostic = Logger.make<unknown, void>((options) => {
          const { message } = options;
          if (
            message === clockWarning ||
            (Array.isArray(message) && message.includes(clockWarning))
          ) {
            hostWarn(clockWarning);
          }
          // Effect filters before invoking loggers. Let the diagnostic reach us,
          // then retain the fixture's original filter for its own loggers.
          if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, minimum)) {
            for (const logger of loggers) logger.log(options);
          }
        });
        return yield* clock
          .sleep(duration)
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([diagnostic])),
            Effect.provideService(References.MinimumLogLevel, "All"),
          );
      }),
  };
  guardedClocks.add(guarded);
  return guarded;
};

const makeTestClock: typeof RawTestClock.make = (options) =>
  RawTestClock.make(options).pipe(Effect.map(guardClock));
const testClockLayer: typeof RawTestClock.layer = (options) => {
  // Each constructor owns a memoized decorator. Reusing this layer must expose
  // the same clock object to every consumer, just like the upstream layer.
  const decorator: Layer.Layer<never> = Layer.effect(
    Clock.Clock,
    Clock.clockWith((clock) => Effect.succeed(guardClock(clock))),
  );
  return decorator.pipe(Layer.provideMerge(RawTestClock.layer(options)));
};

/** TestClock controls and constructors whose unadvanced-time diagnostics cannot be hidden. */
export const TestClock: typeof RawTestClock = {
  ...RawTestClock,
  make: makeTestClock,
  layer: testClockLayer,
};

const guardedClockLayer: Layer.Layer<never> = Layer.effect(
  Clock.Clock,
  Clock.clockWith((clock) => Effect.succeed(guardClock(clock))),
);

const guardEffect = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Clock.clockWith((clock) => self.pipe(Effect.provideService(Clock.Clock, guardClock(clock))));

const guardTest =
  <R>(register: EffectVitest.Vitest.Test<R>): EffectVitest.Vitest.Test<R> =>
  (name, self, timeout) =>
    register(name, (context) => guardEffect(Effect.suspend(() => self(context))), timeout);

const guardTester = <R>(register: EffectVitest.Vitest.Tester<R>): EffectVitest.Vitest.Tester<R> => {
  const each: EffectVitest.Vitest.Tester<R>["each"] = (cases) => {
    const registerCases = register.each(cases);
    return (name, self, timeout) =>
      registerCases(name, (...args) => guardEffect(Effect.suspend(() => self(...args))), timeout);
  };
  const prop: EffectVitest.Vitest.Tester<R>["prop"] = (name, arbitraries, self, timeout) =>
    register.prop(
      name,
      arbitraries,
      (properties, context) => guardEffect(Effect.suspend(() => self(properties, context))),
      timeout,
    );
  return Object.assign(guardTest(register), {
    skip: guardTest(register.skip),
    skipIf: (condition: unknown) => guardTest(register.skipIf(condition)),
    runIf: (condition: unknown) => guardTest(register.runIf(condition)),
    only: guardTest(register.only),
    each,
    fails: guardTest(register.fails),
    prop,
  });
};

type LayerRegistration<R> = {
  (callback: (it: EffectVitest.Vitest.MethodsNonLive<R>) => void): void;
  (name: string, callback: (it: EffectVitest.Vitest.MethodsNonLive<R>) => void): void;
};

const guardRegistration = <R>(register: LayerRegistration<R>): LayerRegistration<R> => {
  function guarded(callback: (it: EffectVitest.Vitest.MethodsNonLive<R>) => void): void;
  function guarded(
    name: string,
    callback: (it: EffectVitest.Vitest.MethodsNonLive<R>) => void,
  ): void;
  function guarded(
    nameOrCallback: string | ((it: EffectVitest.Vitest.MethodsNonLive<R>) => void),
    callback?: (it: EffectVitest.Vitest.MethodsNonLive<R>) => void,
  ): void {
    if (typeof nameOrCallback === "function") {
      register((methods) => nameOrCallback(guardNonLiveMethods(methods)));
    } else if (callback !== undefined) {
      register(nameOrCallback, (methods) => callback(guardNonLiveMethods(methods)));
    } else {
      throw new TypeError("A named Effect test layer requires a registration callback");
    }
  }
  return guarded;
};

const guardNonLiveMethods = <R>(
  methods: EffectVitest.Vitest.MethodsNonLive<R>,
): EffectVitest.Vitest.MethodsNonLive<R> => {
  const effect = guardTester(methods.effect);
  const layer: EffectVitest.Vitest.MethodsNonLive<R>["layer"] = (sharedLayer, options) =>
    guardRegistration(methods.layer(sharedLayer.pipe(Layer.provide(guardedClockLayer)), options));
  return new Proxy(methods, {
    get(target, property, receiver) {
      if (property === "effect") return effect;
      if (property === "layer") return layer;
      return Reflect.get(target, property, receiver);
    },
  });
};

const guardMethods = <R>(
  methods: EffectVitest.Vitest.Methods<R>,
): EffectVitest.Vitest.Methods<R> => {
  const effect = guardTester(methods.effect);
  const layer: EffectVitest.Vitest.Methods<R>["layer"] = (sharedLayer, options) =>
    guardRegistration(methods.layer(sharedLayer.pipe(Layer.provide(guardedClockLayer)), options));
  return new Proxy(methods, {
    get(target, property, receiver) {
      if (property === "effect") return effect;
      if (property === "layer") return layer;
      return Reflect.get(target, property, receiver);
    },
  });
};

/** Effect tests forward unadvanced TestClock warnings to the sessions CI reporter. */
export const it = guardMethods(EffectVitest.it);
export const effect = it.effect;
export const layer = it.layer;

/** Preserve custom Vitest test APIs while guarding their Effect test callbacks. */
export const makeMethods: typeof EffectVitest.makeMethods = (testApi) =>
  guardMethods(EffectVitest.makeMethods(testApi));

/** Wrapped suites receive the same guarded Effect methods as the local entrypoint. */
export const describeWrapped: typeof EffectVitest.describeWrapped = (name, callback) =>
  EffectVitest.describeWrapped(name, (methods) => callback(guardMethods(methods)));
