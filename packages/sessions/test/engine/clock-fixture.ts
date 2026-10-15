import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { HotWorkspacesRepo } from "@mend/db";
import type { CaptureChannel } from "@mend/sessions";
import { TestClock } from "@mend/test-ci/effect-vitest";
import type { InteractiveSessionStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, Queue } from "effect";
import { expect } from "vitest";

import type { memoryHotPool } from "./capture-fixture.ts";
import { makeWorld, type World } from "./fixture.ts";

/**
 * What a TestClock case waits on, signalled by the fakes that change it so the case drives the
 * clock instead of polling. Every signal comes from the thing that changes state (a row written,
 * a list appended to, a PTY handle polled, a channel wait opened), never from the clock.
 */

/** `effect`, then a wake-up on `queue` for whoever waits on the state it changed. */
export const signal =
  (queue: Queue.Queue<void>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.tap(() => Queue.offer(queue, undefined)));

/** Waits for `condition`, woken by every signal on `queue`. */
export const signalled =
  (queue: Queue.Queue<void>) =>
  (condition: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (!condition()) yield* Queue.take(queue);
    }).pipe(Effect.withSpan(label));

/** Every write to `rows` (`set`, `delete`) wakes whoever waits on `queue`. */
export const signalWrites = <K, V>(rows: Map<K, V>, queue: Queue.Queue<void>): Map<K, V> => {
  const set = rows.set.bind(rows);
  const remove = rows.delete.bind(rows);
  rows.set = (key, value) => {
    set(key, value);
    Queue.offerUnsafe(queue, undefined);
    return rows;
  };
  rows.delete = (key) => {
    const removed = remove(key);
    Queue.offerUnsafe(queue, undefined);
    return removed;
  };
  return rows;
};

/**
 * `items`, every push waking whoever waits on `queue`. `push` is not an own enumerable key, so
 * `toEqual` still reads the items alone.
 */
export const watched = <T>(queue: Queue.Queue<void>, items: Array<T> = []): Array<T> =>
  Object.defineProperty(items, "push", {
    enumerable: false,
    value: (...entries: Array<T>) => {
      const length = Array.prototype.push.apply(items, entries);
      Queue.offerUnsafe(queue, undefined);
      return length;
    },
  });

/** A checkpoint's wait for the executor's own capture (`CaptureChannel.awaitRegister`). */
export interface Registration {
  readonly completed: Deferred.Deferred<void>;
  readonly timeoutMs: number;
}

/**
 * The channel's registration waits, each on `registrations` as it opens: `wrapCaptureChannel`
 * observes the real wait and its timeout without replacing either.
 */
export const registrationWaits = Effect.gen(function* () {
  const registrations = yield* Queue.make<Registration>();
  const wrapCaptureChannel = (inner: CaptureChannel["Service"]): CaptureChannel["Service"] => ({
    ...inner,
    awaitRegister: (worktreeId, accept, timeout) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        yield* Queue.offer(registrations, { completed, timeoutMs: Duration.toMillis(timeout) });
        return yield* inner
          .awaitRegister(worktreeId, accept, timeout)
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)));
      }),
  });
  return { registrations, wrapCaptureChannel };
});

/**
 * Nothing registers: `wait` runs its whole window (`CHECKPOINT_WAIT`, 2 s), and `running`, when
 * given, is still going one millisecond short of it.
 */
export const driveRegistration = (
  wait: Registration,
  running?: Pick<Fiber.Fiber<unknown, unknown>, "pollUnsafe">,
) =>
  Effect.gen(function* () {
    expect(wait.timeoutMs).toBe(2_000);
    yield* TestClock.adjust(1_999);
    expect(yield* Deferred.isDone(wait.completed)).toBe(false);
    if (running !== undefined) expect(running.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(1);
    yield* Deferred.await(wait.completed);
  });

/** The next registration wait runs out: nothing registers under it. */
export const expireRegistration = (registrations: Queue.Queue<Registration>) =>
  Effect.flatMap(Queue.take(registrations), (wait) => driveRegistration(wait));

/**
 * `operation` waits out `count` registration waits, one after the other: its own, and any it
 * queues behind on the worktree's writer.
 */
export const drivingRegistrations = <A, E, R>(
  registrations: Queue.Queue<Registration>,
  operation: Effect.Effect<A, E, R>,
  count = 1,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* operation.pipe(Effect.forkChild);
    for (let wait = 0; wait < count; wait++) {
      yield* driveRegistration(yield* Queue.take(registrations), fiber);
    }
    return yield* Fiber.join(fiber);
  });

/**
 * `signalled(changes)`, also driving each checkpoint wait that opens meanwhile: nobody registers
 * under it, so what waits behind one (a harvest, a stop) goes on to its end.
 */
export const drivingUntilChanged =
  (changes: Queue.Queue<void>, registrations: Queue.Queue<Registration>) =>
  (condition: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (!condition()) {
        const next = yield* Effect.race(
          Queue.take(changes).pipe(Effect.as({ kind: "changed" as const })),
          Queue.take(registrations).pipe(Effect.map((wait) => ({ kind: "wait" as const, wait }))),
        );
        if (next.kind === "wait") yield* driveRegistration(next.wait);
      }
    }).pipe(Effect.withSpan(label));

/** `testDrainPolicy`'s `pollInterval`: the gap between an ended agent's looks at its executor. */
export const POLL_INTERVAL = Duration.millis(10);
/** `EXECUTOR_END_LOOKS`: how many times the engine asks an ended agent's executor before it gives up. */
export const EXECUTOR_END_LOOKS = 6;

/** The platform's capture status as the fake answers it absent a hook (no answer), every ask on `looks`. */
export const statusLooks = Effect.gen(function* () {
  const looks = yield* Queue.make<void>();
  const captureStatus = () => Queue.offer(looks, undefined).pipe(Effect.as(null));
  return { looks, captureStatus };
});

/**
 * The PTY states the launch fake reads (`sealantLaunchLayer`'s `ptyStates`), every read counted
 * per PTY and waking `changes`, and the watcher's next look driven on the clock.
 */
export const watchedPtyStates = (
  changes: Queue.Queue<void>,
  untilChanged: (condition: () => boolean, label: string) => Effect.Effect<void>,
) => {
  const looks = new Map<string, number>();
  const ptyStates = new Map<string, InteractiveSessionStatus>();
  const get = ptyStates.get.bind(ptyStates);
  ptyStates.get = (id) => {
    looks.set(id, (looks.get(id) ?? 0) + 1);
    Queue.offerUnsafe(changes, undefined);
    return get(id);
  };
  /** The PTY watcher's next 2 s look at `ptyId`; `notYet` holds right up to it. */
  const nextLook = (ptyId: string, notYet: () => boolean) =>
    Effect.gen(function* () {
      const looked = looks.get(ptyId) ?? 0;
      yield* TestClock.adjust(1_999);
      expect(looks.get(ptyId) ?? 0).toBe(looked);
      expect(notYet()).toBe(true);
      yield* TestClock.adjust(1);
      yield* untilChanged(() => (looks.get(ptyId) ?? 0) > looked, `the watcher's look at ${ptyId}`);
    });
  return { ptyStates, nextLook };
};

/** `pool`'s layer, every row change (ready, failed, gone) waking whoever waits on `queue`. */
export const signallingPool = (
  pool: ReturnType<typeof memoryHotPool>,
  queue: Queue.Queue<void>,
): Layer.Layer<HotWorkspacesRepo> =>
  Layer.effect(
    HotWorkspacesRepo,
    Effect.map(HotWorkspacesRepo, (inner) => ({
      ...inner,
      setReady: (id, state) => signal(queue)(inner.setReady(id, state)),
      setFailed: (id, error) => signal(queue)(inner.setFailed(id, error)),
      remove: (id) => signal(queue)(inner.remove(id)),
    })),
  ).pipe(Layer.provide(pool.layer));

/**
 * Real standby readiness and registration waits, both services kept: the pool's rows wake
 * `untilReady`, and `claim` drives a claim's registration wait to its 2 s.
 */
export const makeStandbyClock = (pool: ReturnType<typeof memoryHotPool>) =>
  Effect.gen(function* () {
    /** A pool row changed: ready, failed, or gone. */
    const rows = yield* Queue.make<void>();
    const { registrations, wrapCaptureChannel } = yield* registrationWaits;
    const poolLayer = signallingPool(pool, rows);
    const untilReady = signalled(rows);
    /** A claim's registration wait, driven: nothing completes short of its 2 s, all of it at 2 s. */
    const claim = <A, E, R>(provision: Effect.Effect<A, E, R>) =>
      drivingRegistrations(registrations, provision);
    return { poolLayer, wrapCaptureChannel, untilReady, claim };
  });

/** The rows of a `World` a case waits on: its maps and its lists. */
export type WorldRows = {
  [K in keyof World]-?: World[K] extends Map<unknown, unknown> | Array<unknown> ? K : never;
}[keyof World];

export interface EngineClock {
  readonly changes: Queue.Queue<void>;
  /** Something a test reads changed: for a fake of the test's own to wake `untilChanged`. */
  readonly changed: () => void;
  readonly untilChanged: (condition: () => boolean, label: string) => Effect.Effect<void>;
  /** Signals every write to the world's rows (`EngineOptions.prepareWorld`). */
  readonly prepareWorld: (world: World) => void;
  /** A list a fake or the engine appends to; every append wakes `untilChanged`. */
  readonly watched: <T>(items?: Array<T>) => Array<T>;
  readonly wrapCaptureChannel: (inner: CaptureChannel["Service"]) => CaptureChannel["Service"];
  /** `operation` waits out `count` checkpoints' `CHECKPOINT_WAIT` (2 s each) for a capture to register. */
  readonly checkpointWait: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
    count?: number,
  ) => Effect.Effect<A, E, R>;
  /** The next checkpoint wait (`CHECKPOINT_WAIT`, 2 s) runs out: nothing registers under it. */
  readonly expireCheckpointWait: Effect.Effect<void>;
  readonly ptyStates: Map<string, InteractiveSessionStatus>;
  /** The PTY watcher's next 2 s look at `ptyId`; `notYet` holds right up to it. */
  readonly nextLook: (ptyId: string, notYet: () => boolean) => Effect.Effect<void>;
}

/**
 * What the engine cases wait on: every write to the world's `rows` (`prepareWorld`), every list
 * a fake appends to (`watched`), every look the PTY watcher takes (`ptyStates` reads) and every
 * checkpoint wait the channel registers (`awaitRegister`). With `drivesCheckpointWaits`,
 * `untilChanged` also drives each checkpoint wait that opens while it waits.
 */
export const makeEngineClock = (
  rows: ReadonlyArray<WorldRows>,
  options: { readonly drivesCheckpointWaits?: boolean } = {},
): Effect.Effect<EngineClock> =>
  Effect.gen(function* () {
    const changes = yield* Queue.make<void>();
    const changed = () => void Queue.offerUnsafe(changes, undefined);
    const { registrations, wrapCaptureChannel } = yield* registrationWaits;
    const untilChanged =
      options.drivesCheckpointWaits === true
        ? drivingUntilChanged(changes, registrations)
        : signalled(changes);
    const prepareWorld = (world: World) => {
      for (const row of rows) {
        const held: Map<unknown, unknown> | Array<unknown> = world[row];
        if (held instanceof Map) signalWrites(held, changes);
        else watched(changes, held);
      }
    };
    return {
      changes,
      changed,
      untilChanged,
      prepareWorld,
      watched: (items = []) => watched(changes, items),
      wrapCaptureChannel,
      checkpointWait: (operation, count) => drivingRegistrations(registrations, operation, count),
      expireCheckpointWait: expireRegistration(registrations),
      ...watchedPtyStates(changes, untilChanged),
    };
  });

/** A directory the case owns, gone with its scope. */
const ownedDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
    (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
  );

/**
 * A world whose session, process and relaunch-plan rows signal every write, in a directory the
 * case owns (`fixture`, for `EngineOptions`: one world serves a restarted engine too). A wait on
 * a row wakes as it lands, never polls; `changed` is for a fake of the test's own to wake
 * `untilChanged` the same way.
 */
export const signalledFixture = (prefix = "mend-engine-test-") =>
  Effect.gen(function* () {
    const changes = yield* Queue.sliding<void>(1);
    const tmp = yield* ownedDirectory(prefix);
    const world = makeWorld();
    signalWrites(world.sessions, changes);
    signalWrites(world.processes, changes);
    signalWrites(world.relaunches, changes);
    return {
      world,
      tmp,
      fixture: { world, tmp },
      changes,
      changed: () => void Queue.offerUnsafe(changes, undefined),
      untilChanged: signalled(changes),
    };
  });
