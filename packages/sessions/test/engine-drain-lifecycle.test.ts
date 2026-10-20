import { SessionId } from "@mend/domain";
import {
  type HostUserNamespaces,
  Session,
  SessionProcess,
  captureStatusLine,
} from "@mend/domain/workbench";
import { LAUNCH_WAITING_PREFIX, LAUNCH_WAITING_SAVING } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
} from "@mend/sealant";
import {
  captureHoldWords,
  NoLiveAgent,
  ProtocolHost,
  ProtocolHostNotLiveError,
  Restart,
  SessionEngine,
  WorkspaceHostUserNamespaces,
} from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, InteractiveSession, InteractiveSessionStatus } from "@sealant/sdk";
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Queue } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  flushReport,
  launchOnce,
  provisionIn,
  leaseHeld,
  lifecycleLayer,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import {
  driveRegistration,
  drivingUntilChanged,
  registrationWaits,
  signalledFixture,
} from "./engine/clock-fixture.ts";
import {
  drawnLine,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

const sessionSettled = (world: World, sessionId: SessionId) =>
  world.sessions.get(sessionId)?.settledAt != null;

/** The reaper's word as it takes up a drain, said in the tick itself, before the drain is forked. */
const DRAIN_TAKEN_UP = "session engine: capture mode · a drain no fiber runs · taken up";

/** The session's agent processes the store still has live. */
const liveAgents = (world: World, sessionId: SessionId) =>
  [...world.processes.values()].filter(
    (process) =>
      process.sessionId === sessionId &&
      (process.kind === "agent-pty" || process.kind === "agent-protocol") &&
      process.exitedAt === null,
  );

/**
 * One step a case holds: armed, the pass after `skip` more waits there (`reached`) until `release`;
 * unarmed, every pass goes at once. The wait is interruptible, as the call it stands in for is.
 */
const heldStep = (changed: () => void) => {
  let skips: number | null = null;
  let reached = false;
  const open = Promise.withResolvers<void>();
  return {
    arm: (skip = 0) => {
      skips = skip;
    },
    reached: () => reached,
    release: () => open.resolve(),
    pass: Effect.suspend(() => {
      if (skips === null) return Effect.void;
      if (skips > 0) {
        skips -= 1;
        return Effect.void;
      }
      skips = null;
      reached = true;
      changed();
      return Effect.promise(() => open.promise);
    }),
  };
};

/**
 * `launchOnce` for the TestClock cases: `setup` runs as `withPreparedEngineEffect`'s `before`,
 * over the store alone, and this provisions in the engine built after it.
 */
/**
 * The engine's own word on a step that writes no row of its own: `seen` once it logs `message`
 * (the layer goes around the engine, as `withPreparedEngineEffect(...).pipe(Effect.provide(layer))`).
 */
const logged = (message: string) =>
  Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const layer = Logger.layer([
      Logger.make((options) => {
        if (String(options.message) === message) Deferred.doneUnsafe(seen, Effect.void);
      }),
    ]);
    return { seen, layer };
  });

/**
 * A world whose session rows signal every write (`signalledFixture`), and a client whose stops
 * and flushes signal too: `untilChanged` wakes on those instead of polling in real time, so a
 * case runs on the TestClock and drives every engine timer it waits on with `TestClock.adjust`.
 * A checkpoint taken while an executor holds the worktree waits `CHECKPOINT_WAIT` (2 s) for the
 * executor's own checkpoint capture, which these fakes never register: `untilChanged` drives
 * such a wait when a forked flow opens one, and `drivingCheckpointWaits` runs an operation
 * forked and drives each of its own to its end.
 */
const signalledWorld = () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const { world, tmp, changes, changed } = yield* signalledFixture("mend-drain-test-");
    // The store's clock follows the engine's: a lease, a capture and a reading share one time.
    const memory = makeMemoryCaptureStore();
    memory.clock.now = () => clock.currentTimeMillisUnsafe();
    const { registrations, wrapCaptureChannel } = yield* registrationWaits;
    const untilChanged = drivingUntilChanged(changes, registrations);
    const drivingCheckpointWaits = <A, E, R>(
      self: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(self);
        while (true) {
          const next = yield* Effect.race(
            Fiber.await(fiber).pipe(Effect.map((exit) => ({ kind: "done" as const, exit }))),
            Queue.take(registrations).pipe(Effect.map((wait) => ({ kind: "wait" as const, wait }))),
          );
          if (next.kind === "done") return yield* next.exit;
          yield* driveRegistration(next.wait);
        }
      });
    const signalling = (layer: Layer.Layer<SealantClient>): Layer.Layer<SealantClient> =>
      Layer.effect(
        SealantClient,
        Effect.map(
          SealantClient,
          (client): SealantClientShape => ({
            ...client,
            stopWorkspace: (workspace, options) =>
              client.stopWorkspace(workspace, options).pipe(Effect.tap(() => Effect.sync(changed))),
            captureFlush: (workspace, kind) =>
              client.captureFlush(workspace, kind).pipe(Effect.tap(() => Effect.sync(changed))),
          }),
        ),
      ).pipe(Layer.provide(layer));
    return {
      world,
      memory,
      tmp,
      untilChanged,
      changed,
      signalling,
      wrapCaptureChannel,
      drivingCheckpointWaits,
    };
  });

/** The relaunch plan the session's row holds, as stored. */
const storedPlan = (world: World, session: Session): unknown => {
  const stored = world.relaunches.get(session.id);
  return stored === undefined ? null : JSON.parse(stored);
};
const planId = (plan: unknown): unknown =>
  typeof plan === "object" && plan !== null && "id" in plan ? plan.id : null;
const owesPickup = (world: World, session: Session) =>
  (world.relaunches.get(session.id) ?? "").includes('"pickup":"codex"');

/** The PTY agent exits on its own while its executor drains for the replacement. */
const agentExitsOnItsOwn = (world: World) => {
  for (const process of world.processes.values()) {
    if (process.kind !== "agent-pty" || process.exitedAt !== null) continue;
    world.processes.set(
      process.id,
      new SessionProcess({
        ...process,
        status: "exited",
        exitCode: 0,
        exitedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  }
};

/** Time and turns for whatever the scenario set going to run its course. */
const settleFor = (steps: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step += 1) {
      yield* TestClock.adjust(Duration.millis(100));
      yield* Effect.yieldNow;
    }
  });

describe("SessionEngine capture drain (no loss of work product)", () => {
  it.effect(
    "a stop drains before the workspace goes: it answers at once reading `saving`, the drain flushes until nothing is pending, and the lease is released only once the platform reports the workspace gone",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const answers = [3, 2, 1, 0];
        const lines: Array<string | null> = [];
        let sessionId: SessionId | null = null;
        let platformReportsStopped = false;
        let leaseHeldAtStop: boolean | null = null;
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              sessionId = session.id;
              yield* engine.stop(session.id);
              // The stop answers before the drain: the session reads `saving` from this answer on.
              const answered = world.sessions.get(session.id);
              expect(answered?.captureDrain).toBe("stop");
              expect(answered === undefined ? null : captureStatusLine(answered)).toMatch(
                /^saving/,
              );
              // Four flushes a poll apart: 3, 2 and 1 pending, then nothing.
              for (const left of [3, 2, 1]) {
                yield* untilChanged(
                  () => answers.length <= left,
                  `the flush with ${left} answers left`,
                );
                yield* TestClock.adjust(pollInterval);
              }
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              // Every flush before the stop, the last one answering nothing pending.
              const stopAt = events.indexOf("workspace-1");
              expect(events.slice(0, stopAt).every((event) => event === "flush:workspace-1")).toBe(
                true,
              );
              expect(answers).toEqual([]);
              // What every surface read while it drained.
              expect(lines).toContain("saving · 2 left");
              expect(lines).toContain("saving · 1 left");
              // Stop asked, termination not yet reported: the executor keeps its lease.
              yield* untilChanged(
                () => leaseHeldAtStop !== null,
                "the platform's first look after the stop",
              );
              expect(leaseHeldAtStop).toBe(true);
              yield* TestClock.adjust(Duration.millis(100));
              expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
              platformReportsStopped = true;
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(
                () => !leaseHeld(memory, session.worktreeId, session.id),
                "the lease release after the termination",
              );
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.capturePending).toBe(0);
              expect(settled?.captureNotSavedAt).toBeNull();
              expect(settled === undefined ? "gone" : captureStatusLine(settled)).toBeNull();
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { pollInterval, terminationWait: Duration.seconds(10) },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  flushed: events,
                  status: (stopAsked) => {
                    if (stopAsked && leaseHeldAtStop === null && sessionId !== null) {
                      const session = world.sessions.get(sessionId);
                      leaseHeldAtStop =
                        session !== undefined && leaseHeld(memory, session.worktreeId, session.id);
                      changed();
                    }
                    return stopAsked && platformReportsStopped ? "stopped" : "ready";
                  },
                  flush: () =>
                    Effect.sync(() => {
                      const current =
                        sessionId === null ? undefined : world.sessions.get(sessionId);
                      lines.push(current === undefined ? null : captureStatusLine(current));
                      const pending = answers.shift() ?? 0;
                      return flushReport(pending, 3 - pending);
                    }),
                },
              ),
            ),
          },
        );
      }),
  );

  it.effect(
    "a discard asked while the save is still moving says nothing was discarded once that save ends the workspace (RC 0.36.0-next.761)",
    () =>
      Effect.gen(function* () {
        // RC 2 client pass: the discard waited 82 s for the drain's final flush, which saved every
        // file and ended the workspace, and the session line then read `unsaved work discarded`.
        const {
          world,
          memory,
          tmp,
          untilChanged,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const kinds: CaptureFlushKind[] = [];
        const finalAsked = yield* Deferred.make<void>();
        const finishSave = yield* Deferred.make<void>();
        // The discard is asked (its intent recorded, before anything ends): the engine says so.
        const discardAsked = yield* Deferred.make<void>();
        const asked = Logger.layer([
          Logger.make(({ message }) => {
            if (
              String(message) ===
              "session engine: discard of unsaved captures requested by the owner · stopping"
            ) {
              Deferred.doneUnsafe(discardAsked, Effect.void);
            }
          }),
        ]);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* Deferred.await(finalAsked);
              const discarding = yield* engine
                .discardUnsavedAndStop(session.id, "Ada Lovelace")
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Deferred.await(discardAsked);
              yield* Deferred.succeed(finishSave, undefined);
              // The Stop's mark looks for the drain's word every `DRAIN_WORD_LOOK` (50 ms); the
              // final flush's answer is that word.
              yield* TestClock.adjust(Duration.millis(50));
              const result = yield* drivingCheckpointWaits(Fiber.join(discarding));
              expect(result.discardedAt).toBeNull();
              expect(events).toContain("workspace-1");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.captureDrain).toBeNull();
              expect(settled?.captureDiscardedAt ?? null).toBeNull();
              expect(settled === undefined ? null : captureStatusLine(settled)).toBeNull();
              expect(settled?.status).toBe("stopped");
              // RC 0.36.0-next.768: the discard the owner asked for says what became of it.
              expect(settled?.summary).toBe(
                "the save finished before the discard, so nothing was discarded",
              );
              expect(result.session.summary).toBe(settled?.summary);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: {
                  flushed: events,
                  flushKinds: kinds,
                  flush: () =>
                    kinds.at(-1) === "final"
                      ? Deferred.succeed(finalAsked, undefined).pipe(
                          Effect.andThen(Deferred.await(finishSave)),
                          Effect.as(flushReport(0, 1, { headN: 1 })),
                        )
                      : Effect.succeed(flushReport(0, 1, { headN: 1 })),
                },
              }),
            ),
          },
        ).pipe(Effect.provide(asked));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a drain that stops moving keeps the workspace and reads `not saved · N pending · workspace kept`; only the owner's discard ends it",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              // Nothing unsaved before a drain: a plain stop is the verb.
              const early = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
              expect(early._tag).toBe("NothingUnsavedError");
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              // Nothing moves for the stall window (1 s): saving until it, kept at it.
              yield* TestClock.adjust(Duration.millis(999));
              expect(world.sessions.get(session.id)?.captureNotSavedAt).toBeNull();
              yield* TestClock.adjust(Duration.millis(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt !== null,
                "the stall",
              );
              const stalled = world.sessions.get(session.id);
              expect(stalled === undefined ? null : captureStatusLine(stalled)).toBe(
                "not saved · 2 pending · workspace kept",
              );
              expect(events).not.toContain("workspace-1");
              expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
              // The next sweep tries again; still nothing moves, still nothing is stopped.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(200));
              expect(events).not.toContain("workspace-1");
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              // A relaunch behind it is refused: the old workspace holds what is not saved. Its
              // own drain saves for the stall window first, then reads the same kept executor.
              const relaunching = yield* engine
                .resumeSession(session.id, "shell")
                .pipe(Effect.flip, Effect.forkChild);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "relaunch",
                "the relaunch's drain",
              );
              yield* TestClock.adjust(Duration.millis(999));
              expect(relaunching.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const relaunch = yield* Fiber.join(relaunching);
              expect(relaunch._tag === "SealantPlatformError" && relaunch.code).toBe(
                "capture_not_saved",
              );
              expect(created).toHaveLength(1);
              expect(events).not.toContain("workspace-1");
              // The owner's discard is the one way the workspace goes with captures pending.
              const { session: discarded } = yield* drivingCheckpointWaits(
                engine.discardUnsavedAndStop(session.id),
              );
              expect(discarded.captureDrain).toBeNull();
              expect(discarded.captureNotSavedAt).toBeNull();
              expect(events).toContain("workspace-1");
              expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(false);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { stallSeconds: 1 },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { flush: () => Effect.succeed(flushReport(2, 1)) },
              ),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a reaper tick while a Stop still closes its agent leaves the drain to that Stop: the session settles `stopped` (SLNT-111)",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        const takenUp = yield* logged(DRAIN_TAKEN_UP);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              yield* engine.reapCaptureLeases();
              expect(yield* Deferred.isDone(takenUp.seen)).toBe(false);
              close.resolve();
              yield* Fiber.join(stopping);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              const after = world.sessions.get(session.id);
              expect(after?.status).toBe("stopped");
              expect(after?.captureDrain).toBeNull();
              expect(liveAgents(world, session.id)).toEqual([]);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(
              signalling(
                lifecycleLayer(created, {
                  events,
                  captureOps: {
                    status: (stopAsked) => (stopAsked ? "stopped" : "ready"),
                    flush: () => Effect.succeed(flushReport(0, 1)),
                  },
                }),
              ),
              () => {
                closeReached = true;
                changed();
                return close.promise;
              },
            ),
          },
        ).pipe(Effect.provide(takenUp.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "once that Stop is over, its kept drain is the reaper's again: a later tick saves it and the session settles `stopped` (SLNT-111)",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        let pending = 2;
        const takenUp = yield* logged(DRAIN_TAKEN_UP);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              yield* engine.reapCaptureLeases();
              expect(yield* Deferred.isDone(takenUp.seen)).toBe(false);
              close.resolve();
              yield* Fiber.join(stopping);
              // Nothing moves for the stall window (1 s): the Stop's drain keeps the workspace.
              yield* TestClock.adjust(Duration.seconds(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain kept its workspace",
              );
              expect(world.sessions.get(session.id)?.status).toBe("stopping");
              expect(events).not.toContain("workspace-1");
              // It saves after all; only the reaper is left to take the drain up.
              pending = 0;
              yield* TestClock.adjust(Duration.seconds(10));
              yield* engine.reapCaptureLeases();
              expect(yield* Deferred.isDone(takenUp.seen)).toBe(true);
              yield* untilChanged(
                () => events.includes("workspace-1"),
                "the reaper's workspace stop",
              );
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              const after = world.sessions.get(session.id);
              expect(after?.status).toBe("stopped");
              expect(after?.captureDrain).toBeNull();
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              stallSeconds: 1,
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(
              signalling(
                lifecycleLayer(created, {
                  events,
                  captureOps: {
                    status: (stopAsked) => (stopAsked ? "stopped" : "ready"),
                    flush: () => Effect.succeed(flushReport(pending, 1)),
                  },
                }),
              ),
              () => {
                closeReached = true;
                changed();
                return close.promise;
              },
            ),
          },
        ).pipe(Effect.provide(takenUp.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a stopped session reads `stopping` and is not settled until the platform reports its workspace terminated; a kept one stays `stopping`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let pending = 2;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              // The agent ended; its container still runs and holds what is not saved.
              const answered = world.sessions.get(session.id);
              expect(answered?.status).toBe("stopping");
              expect(answered?.settledAt).toBeNull();
              // Nothing moves for the stall window (1 s): kept at it.
              yield* TestClock.adjust(Duration.millis(999));
              expect(world.sessions.get(session.id)?.captureNotSavedAt).toBeNull();
              yield* TestClock.adjust(Duration.millis(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain kept its workspace",
              );
              const kept = world.sessions.get(session.id);
              expect(kept?.status).toBe("stopping");
              expect(kept?.settledAt).toBeNull();
              expect(events).not.toContain("workspace-1");
              // The next sweep: still kept, still not settled.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(100));
              expect(world.sessions.get(session.id)?.status).toBe("stopping");
              expect(world.sessions.get(session.id)?.settledAt).toBeNull();
              // It saves after all; the stop is asked, and only the observed termination settles.
              pending = 0;
              yield* engine.stop(session.id);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the settle after the termination",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.captureDrain).toBeNull();
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { stallSeconds: 1, terminationWait: Duration.seconds(5) },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  status: (stopAsked) => (stopAsked ? "stopped" : "ready"),
                  flush: () => Effect.succeed(flushReport(pending, 1)),
                },
              ),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "saved but its termination not observed: the session stays `stopping` until the platform reports the workspace gone",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let gone = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              // The platform keeps reporting it up: the drain watches for the termination for
              // `terminationWait` (300 ms), then records itself over with the stop unobserved.
              yield* TestClock.adjust(Duration.millis(299));
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              yield* TestClock.adjust(Duration.millis(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              // Stop asked, the platform still reports it up: not settled.
              expect(world.sessions.get(session.id)?.status).toBe("stopping");
              expect(world.sessions.get(session.id)?.settledAt).toBeNull();
              yield* engine.reapCaptureLeases();
              expect(world.sessions.get(session.id)?.settledAt).toBeNull();
              // The platform reports it gone: a sweep settles it. A sweep passes over a session
              // whose stop tail or drain is still running, and those end a moment after the drain's
              // record does, so it sweeps as the reaper's interval would, on the test clock.
              gone = true;
              for (
                let i = 0;
                i < 500 && world.sessions.get(session.id)?.status !== "stopped";
                i++
              ) {
                yield* engine.reapCaptureLeases();
                yield* TestClock.adjust(Duration.millis(10));
              }
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.settledAt).not.toBeNull();
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                () => gone,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { status: () => "ready", flush: () => Effect.succeed(flushReport(0, 1)) },
              ),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a kept drain backs off while nothing changes — 10 s doubling to its cap — and looks again at once when something does",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const flushed: string[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain kept its workspace",
              );
              yield* TestClock.adjust(Duration.millis(50));
              const rounds = () => flushed.length;
              const quiet = (label: string) =>
                Effect.gen(function* () {
                  const before = rounds();
                  yield* engine.reapCaptureLeases();
                  yield* TestClock.adjust(Duration.millis(60));
                  expect(rounds(), label).toBe(before);
                });
              const looks = (label: string) =>
                Effect.gen(function* () {
                  const before = rounds();
                  yield* engine.reapCaptureLeases();
                  yield* untilChanged(() => rounds() > before, label);
                  yield* untilChanged(
                    () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                    `${label} · kept again`,
                  );
                  yield* TestClock.adjust(Duration.millis(50));
                });
              // Nothing changed: every sweep inside the first wait leaves it alone.
              yield* quiet("a sweep right after the drain was kept");
              yield* quiet("a second sweep inside the first wait");
              // The first wait (300 ms here) has passed: one more round.
              yield* TestClock.adjust(Duration.millis(300));
              yield* looks("the round after the first wait");
              // Still nothing changed: the wait doubled, so the first wait is no longer enough.
              yield* TestClock.adjust(Duration.millis(320));
              yield* quiet("a sweep after one first-wait into the doubled wait");
              // Something changed (the executor registered a capture on its own): looked at once.
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* looks("the round after the head moved");
              yield* quiet("a sweep right after that round");
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              stallSeconds: 1,
              keptRetryFirst: Duration.millis(300),
              keptRetryMax: Duration.seconds(5),
            },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  flushed,
                  // An executor that cannot report `complete`: every round is kept at once.
                  finalCompletion: "unreported",
                  flush: () => Effect.succeed(flushReport(2, 1)),
                },
              ),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it("an executor the platform does not answer for is unknown, never dead: no pickup, no stop; one that answers is paused and left alone; only a 404 is a pickup", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    let unreachable = false;
    let dead = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            crypto.randomUUID(),
          );
          const realNow = memory.clock.now;
          memory.clock.now = () => realNow() + 10 * 60 * 1000;
          // Expired lease, Core down: nothing is settled, nothing picked up, nothing stopped.
          unreachable = true;
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("running");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          const unknown = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
          expect(unknown._tag === "SealantPlatformError" && unknown.code).toBe("executor_unknown");
          // Expired lease, the executor answers: paused, never killed.
          unreachable = false;
          const paused = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
          expect(paused._tag === "SealantPlatformError" && paused.code).toBe("executor_paused");
          expect(created).toHaveLength(1);
          expect(events).toEqual([]);
          // The platform says it is gone (404): that, and only that, is a pickup.
          dead = true;
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          memory.clock.now = realNow;
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          events,
          undefined,
          () => dead,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { unreachablePlatform: () => unreachable },
        ),
      },
    );
  });

  it.effect(
    "removal waits for the workspace: asked mid-drain the row stays until the workspace is saved and stopped; with no workspace it goes at once",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let saveNow = false;
        let removedWhileUp: boolean | null = null;
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              const never = yield* engine.provision({
                projectId: session.projectId,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                base: null,
              });
              expect(yield* engine.removeWhenStopped(never.id)).toBe("removed");
              expect(world.sessions.has(never.id)).toBe(false);

              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              yield* TestClock.adjust(Duration.millis(100));
              expect(world.sessions.has(session.id)).toBe(true);
              expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
              expect(events).not.toContain("workspace-1");
              saveNow = true;
              // The drain's next round reads it saved.
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(() => !world.sessions.has(session.id), "the removal");
              expect(events).toContain("workspace-1");
              expect(removedWhileUp).toBe(false);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { pollInterval },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  status: (stopAsked) => {
                    // The row must still be there when the platform is asked about the stop.
                    if (stopAsked && removedWhileUp === null) {
                      removedWhileUp = ![...world.sessions.values()].some(
                        (candidate) => candidate.removalRequestedAt !== null,
                      );
                    }
                    return stopAsked ? "stopped" : "ready";
                  },
                  flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                },
              ),
            ),
          },
        );
      }),
  );

  it.effect(
    "plans against the platform's cap: with MEND_EXECUTOR_MAX_SECONDS the drain starts at deadline − (estimate + margin), counted from the executor's own start, then a replacement launches",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              const before = yield* Clock.currentTimeMillis;
              yield* engine.launch(session.id, ["codex"]);
              const startedAt = world.sessions.get(session.id)?.executorStartedAt;
              expect(startedAt?.getTime()).toBeGreaterThanOrEqual(before - 1);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              // 1000 s cap, 600 s estimate + 400 s margin: due from the executor's start.
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => created.length === 2, "the replacement launch");
              const stopAt = events.indexOf("workspace-1");
              expect(stopAt).toBeGreaterThan(0);
              expect(events[stopAt - 1]).toBe("flush:workspace-1");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
            },
            sealantLayer: signalling(
              sealantLaunchLayer(
                created,
                undefined,
                events,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { flushed: events },
              ),
            ),
          },
        );
      }),
  );

  it.effect("with the cap unknown an executor younger than the fallback age is left alone", () =>
    Effect.gen(function* () {
      const { world, memory, tmp, wrapCaptureChannel } = yield* signalledWorld();
      const created: Array<CreateOptions> = [];
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, _dir, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.reapCaptureLeases();
            yield* TestClock.adjust(Duration.millis(200));
            expect(created).toHaveLength(1);
            expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          wrapCaptureChannel,
          sealantLayer: sealantLaunchLayer(created),
        },
      );
    }),
  );
});

/** A launch layer for the lifecycle tests: the positional knobs they use, by name. */
/** `inner`, whose PTY closes wait on `held` before the platform closes them. */
const slowCloses = (
  inner: Layer.Layer<SealantClient>,
  held: () => Promise<void>,
  /** Once released, the close is refused the way a platform that does not answer refuses it. */
  refused: () => boolean = () => false,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(
      SealantClient,
      (client): SealantClientShape => ({
        ...client,
        getSession: (workspace, sessionId) =>
          client.getSession(workspace, sessionId).pipe(
            Effect.map(
              (pty): InteractiveSession => ({
                ...pty,
                close: async () => {
                  await held();
                  if (refused()) {
                    throw new SealantPlatformError({
                      code: "control_plane_unavailable",
                      status: 503,
                      message: "the control plane did not answer",
                      cause: null,
                    });
                  }
                  await pty.close();
                },
              }),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provide(inner));

/** `inner`, whose PTY lookups pass `step` first: a close asked of the platform starts with one. */
const heldPtyLookups = (
  inner: Layer.Layer<SealantClient>,
  step: Effect.Effect<void>,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(
      SealantClient,
      (client): SealantClientShape => ({
        ...client,
        getSession: (workspace, sessionId) =>
          step.pipe(Effect.andThen(client.getSession(workspace, sessionId))),
      }),
    ),
  ).pipe(Layer.provide(inner));

describe("SessionEngine lifecycle safety (review 2026-09-27)", () => {
  it.effect(
    "every planned end asks the executor for a final flush; a checkpoint asks for a suspend one",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const kinds: CaptureFlushKind[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* drivingCheckpointWaits(engine.checkpointNow(session.id, "user-mark"));
              expect(kinds.length).toBeGreaterThan(0);
              expect(kinds.every((kind) => kind === "suspend")).toBe(true);
              const before = kinds.length;
              yield* engine.stop(session.id);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              const stopAt = events.indexOf("workspace-1");
              // The flush right before the stop is final.
              const flushesBeforeStop = events
                .slice(0, stopAt)
                .filter((event) => event.startsWith("flush:")).length;
              expect(kinds[flushesBeforeStop - 1]).toBe("final");
              expect(kinds.slice(before)).toContain("final");
              expect(world.finalFlushed.get(session.id)).toBe("workspace-1");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { terminationWait: Duration.seconds(5) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: { flushed: events, flushKinds: kinds },
              }),
            ),
          },
        );
      }),
  );

  it.effect(
    "a replacement is saved only by a completed final flush: an executor that cannot say `complete` keeps its workspace and nothing relaunches",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const postponed = yield* logged(
          "session engine: capture mode · replacement postponed · kept",
        );
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
              yield* engine.reapCaptureLeases();
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              // The queue read empty, but nothing said the executor quiesced and snapshotted both
              // classes: the workspace stays, and no second executor was made. The replacement
              // says so itself once its drain has answered it.
              yield* Deferred.await(postponed.seen);
              expect(events).not.toContain("workspace-1");
              expect(created).toHaveLength(1);
              const kept = world.sessions.get(session.id);
              expect(kept?.captureDrain).toBe("replacement");
              expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
                "not saved · final flush not reported · 0 pending · workspace kept",
              );
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
            },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: { flushed: events, finalCompletion: "unreported" },
              }),
            ),
          },
        ).pipe(Effect.provide(postponed.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "an executor sent a final flush is never reused: a second session is refused instead of joining it",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              const spawnedBefore = spawned.length;
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              const launching = yield* engine
                .launch(second.id, ["claude"])
                .pipe(Effect.flip, Effect.forkChild);
              // The launch waits on the ending executor for `leaseWait` (300 ms here, 30 min
              // live), looking every `leaseWaitInterval`, and says so while it waits.
              yield* untilChanged(
                () => world.sessions.get(second.id)?.summary === LAUNCH_WAITING_SAVING,
                "the waiting line",
              );
              yield* TestClock.adjust(Duration.millis(299));
              expect(launching.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const refused = yield* Fiber.join(launching);
              expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                "worktree_leased",
              );
              expect(refused._tag === "SealantPlatformError" && refused.message).toContain(
                "saving before it ends",
              );
              // Refused only once the wait's bound (300 ms here, 30 min live) has passed.
              expect(world.sessions.get(second.id)?.status).toBe("failed");
              // Nothing was started in the ending executor, and no second executor was made.
              expect(spawned).toHaveLength(spawnedBefore);
              expect(created).toHaveLength(1);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: signalling(
              lifecycleLayer(created, {
                spawned,
                captureOps: { finalCompletion: "unreported" },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a launch behind an executor that is saving waits for its end, says so, and then starts cold (alpha 2026-09-30)",
    () =>
      Effect.gen(function* () {
        // Alpha: b729dd35 was started 15 s after cc05cb8a exited in the same worktree and failed at
        // once, `worktree leased · … saving before it ends · start again once it has`; the save
        // finished 15 s later. The launch now waits for that end and goes on by itself.
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        let firstEnded = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                  "the first executor, saving",
                ),
              );
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              const launching = yield* engine
                .launch(second.id, ["claude"])
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(second.id)?.summary === LAUNCH_WAITING_SAVING,
                  "the waiting line after native launch preparation",
                ),
              );
              const waiting = yield* Effect.sleep(Duration.millis(100)).pipe(Effect.forkChild);
              yield* TestClock.adjust(Duration.millis(100));
              yield* Fiber.join(waiting);
              // Waiting, not refused, and nothing else started over the saving executor.
              expect(world.sessions.get(second.id)?.status).toBe("starting");
              expect(world.sessions.get(second.id)?.settledAt).toBeNull();
              expect(created).toHaveLength(1);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);

              // The first executor ends: the platform reports it gone and its lease lapses.
              const epochBefore = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const realNow = memory.clock.now;
              memory.clock.now = () => realNow() + 10 * 60 * 1000;
              firstEnded = true;
              yield* TestClock.adjust(Duration.seconds(10));
              const launched = yield* Fiber.join(launching).pipe(
                Effect.ensuring(Effect.sync(() => (memory.clock.now = realNow))),
              );
              expect(launched.status).toBe("running");
              expect(created).toHaveLength(2);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(second.id);
              expect(memory.leases.get(session.worktreeId)?.epoch).toBe(epochBefore + 1);
              // The waiting words end with the wait.
              expect(drawnLine(world.sessions.get(second.id)?.summary)).toBeNull();
            }),
          {
            captured: memory,
            drainPolicy: { leaseWait: Duration.seconds(15) },
            sealantLayer: lifecycleLayer(created, {
              dead: () => firstEnded,
              captureOps: {
                finalCompletion: "unreported",
                // The fake has one workspace: the second executor is alive once it is created.
                beforeCreate: () =>
                  Effect.sync(() => {
                    if (created.length > 1) firstEnded = false;
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a join under way keeps the holder's Stop from flushing the executor shut under it (RC 0.36.0-next.761)",
    () =>
      Effect.gen(function* () {
        // RC 2 client pass: back-to-back `mend run` in a worktree with 1.5 GB untracked. The first
        // run's settle tail harvested for seconds before its drain began; the second run looked at
        // the holder meanwhile, read it live and joined, and the drain then found no process in the
        // executor, sent its final flush, and the join's PTY was refused ("the executor is ending: a
        // final capture flush closed admission"), the second session recorded failed.
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const kinds: CaptureFlushKind[] = [];
        const joinOpening = yield* Deferred.make<void>();
        const releaseJoin = yield* Deferred.make<void>();
        let opens = 0;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "run",
                label: null,
                ownerUserId: "user-fixture",
              });
              const launching = yield* engine
                .launch(second.id, ["bash", "-c", "true"])
                .pipe(Effect.forkChild({ startImmediately: true }));
              // The join looked at its holder and is opening its process there.
              yield* Deferred.await(joinOpening);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the first session, stopped",
              );
              yield* TestClock.adjust(Duration.millis(200));
              // Its Stop found the join in the executor: nothing flushed it shut, nothing stopped it.
              expect(kinds).not.toContain("final");
              expect(events).not.toContain("workspace-1");
              yield* Deferred.succeed(releaseJoin, undefined);
              const launched = yield* Fiber.join(launching);
              expect(launched.status).toBe("running");
              expect(created).toHaveLength(1);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: {
                  flushed: events,
                  flushKinds: kinds,
                  aroundOpen: () => {
                    opens += 1;
                    return opens === 1
                      ? Effect.void
                      : Deferred.succeed(joinOpening, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseJoin)),
                        );
                  },
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a resume never creates over a lease of the session's earlier launch whose end nothing confirms (alpha 2026-10-03)",
    () =>
      Effect.gen(function* () {
        // Alpha 8fe91d79: an earlier executor of the session kept its lease, bound to its launch,
        // and each relaunch read the session's own lease as free. And the row's workspace is not
        // that executor: a replacement that overwrote the row and then stopped says nothing of
        // the lease's launch, which may still hold work it has not shipped (review of #516).
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        // A settled session's resume writes no waiting line on its row: the engine's log is its word.
        const waiting = yield* logged(
          "session engine: capture mode · the worktree's previous executor has not ended · the launch waits",
        );
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the row's executor, stopped",
              );
              // The lease names a launch the row does not: its end is unknown.
              const epoch = (memory.leases.get(session.worktreeId)?.epoch ?? 0) + 1;
              memory.leases.set(session.worktreeId, {
                executorId: session.id,
                epoch,
                expiresAt: memory.clock.now() - 1,
                launchId: "launch:unresolved-predecessor",
              });
              const resuming = yield* engine
                .resumeSession(session.id, "shell")
                .pipe(Effect.exit, Effect.forkChild);
              // The resume waits on the unconfirmed launch for `leaseWait` (300 ms here), looking
              // every `leaseWaitInterval`, and says so once it waits.
              yield* Deferred.await(waiting.seen);
              yield* TestClock.adjust(Duration.millis(299));
              expect(resuming.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const outcome = yield* Fiber.join(resuming);
              expect(outcome._tag).toBe("Failure");
              expect(created).toHaveLength(1);
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.launchId).toBe("launch:unresolved-predecessor");
              expect(lease?.epoch).toBe(epoch);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              leaseWait: Duration.millis(300),
              leaseWaitInterval: Duration.millis(20),
            },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                captureOps: {
                  status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
                },
              }),
            ),
          },
        ).pipe(Effect.provide(waiting.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "another session's lease of a launch its row no longer names is a hold: no launch, no release, no removal (review of #516)",
    () =>
      Effect.gen(function* () {
        // A/B: session one's lease is bound to launch A, whose end nothing confirms, while its row
        // names a later executor B that has stopped. B's end says nothing of A: a sibling's launch
        // waits and is refused, and a removal is held, with A's lease kept.
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "executor B, stopped",
              );
              const epoch = (memory.leases.get(session.worktreeId)?.epoch ?? 0) + 1;
              memory.leases.set(session.worktreeId, {
                executorId: session.id,
                epoch,
                expiresAt: memory.clock.now() - 1,
                launchId: "launch:a-unconfirmed",
              });
              const sibling = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              const launching = yield* engine
                .launch(sibling.id, ["claude"])
                .pipe(Effect.flip, Effect.forkChild);
              // The launch waits on launch A for `leaseWait` (300 ms here), looking every
              // `leaseWaitInterval`, and says so while it waits.
              yield* untilChanged(
                () =>
                  world.sessions.get(sibling.id)?.summary?.startsWith(LAUNCH_WAITING_PREFIX) ===
                  true,
                "the waiting line",
              );
              yield* TestClock.adjust(Duration.millis(299));
              expect(launching.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const refused = yield* Fiber.join(launching);
              expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                "worktree_leased",
              );
              expect(created).toHaveLength(1);
              const holds = yield* engine.captureHolds(session.worktreeId);
              expect(holds).toContainEqual({ sessionId: session.id, kind: "lease" });
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.launchId).toBe("launch:a-unconfirmed");
              expect(lease?.epoch).toBe(epoch);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              leaseWait: Duration.millis(300),
              leaseWaitInterval: Duration.millis(20),
            },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                captureOps: {
                  status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  /**
   * A stopped session whose worktree lease is bound to `launchId`, a launch its row does not
   * name, lapsed: what Mend's own launch leaves when a restart cuts it between its claim and its
   * create (review round 3, F4), or an earlier executor whose row was overwritten.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const unnamedLaunchLease = (
    captureOps: Parameters<typeof sealantLaunchLayer>[11],
    body: (at: {
      readonly world: World;
      readonly engine: SessionEngine["Service"];
      readonly session: Session;
      readonly memory: MemoryCaptureStore;
      readonly created: Array<CreateOptions>;
      readonly epoch: number;
      readonly launchId: string;
    }) => Effect.Effect<void, unknown, SessionEngine>,
    dead: () => boolean = () => false,
  ) =>
    Effect.gen(function* () {
      const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
        yield* signalledWorld();
      const created: Array<CreateOptions> = [];
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, _dir, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* untilChanged(
              () => world.sessions.get(session.id)?.status === "stopped",
              "stopped",
            );
            const epoch = (memory.leases.get(session.worktreeId)?.epoch ?? 0) + 1;
            const launchId = `launch:${session.id}:1791000000000:interrupted`;
            memory.leases.set(session.worktreeId, {
              executorId: session.id,
              epoch,
              expiresAt: memory.clock.now() - 1,
              launchId,
            });
            yield* body({ world, engine, session, memory, created, epoch, launchId });
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          wrapCaptureChannel,
          drainPolicy: { leaseWait: Duration.millis(300), leaseWaitInterval: Duration.millis(20) },
          sealantLayer: signalling(
            lifecycleLayer(created, {
              dead,
              captureOps: {
                status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
                ...captureOps,
              },
            }),
          ),
        },
      );
    });

  it.effect(
    "a restart between a launch's claim and its create leaves a lease the platform resolves: the next resume goes on",
    () =>
      Effect.gen(function* () {
        const fenced: string[] = [];
        yield* unnamedLaunchLease(
          {
            findByKey: () => ({ kind: "none" }),
            fenceCreate: (key) => {
              fenced.push(key);
              return { kind: "cancelled" };
            },
          },
          ({ engine, session, memory, created, epoch, launchId }) =>
            Effect.gen(function* () {
              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(resumed.status).toBe("running");
              // Fenced on the platform first: nothing is ever made under that key.
              expect(fenced).toEqual([launchId]);
              expect(created).toHaveLength(2);
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.epoch).toBe(epoch + 1);
              expect(lease?.launchId).not.toBe(launchId);
            }),
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "an unnamed launch the platform finds ended is released, and its worktree can be removed",
    () =>
      Effect.gen(function* () {
        const looked: string[] = [];
        yield* unnamedLaunchLease(
          {
            // The key finds the stopped workspace that launch made.
            findByKey: (key) => {
              looked.push(key);
              return { kind: "found", workspaceId: "workspace-1" };
            },
          },
          ({ engine, session, memory, launchId }) =>
            Effect.gen(function* () {
              expect(yield* engine.captureHolds(session.worktreeId)).toEqual([]);
              expect(looked).toEqual([launchId]);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            }),
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a fenced create's own lease is released even while the previous executor cannot be read",
    () =>
      Effect.gen(function* () {
        let unreachable = false;
        yield* unnamedLaunchLease(
          {
            findByKey: () => ({ kind: "none" }),
            fenceCreate: () => ({ kind: "cancelled" }),
            unreachablePlatform: () => unreachable,
          },
          ({ world, engine, session, memory, launchId }) =>
            Effect.gen(function* () {
              // The create was asked under the lease's key and its answer lost; the platform then
              // stops answering for the previous executor.
              world.executorCreates.set(session.id, launchId);
              unreachable = true;
              yield* engine.reapCaptureLeases();
              expect(world.executorCreates.has(session.id)).toBe(false);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            }),
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a relaunch's claim cut short by a restart does not hold up a landing: the flush asks the platform",
    () =>
      Effect.gen(function* () {
        yield* unnamedLaunchLease(
          {
            findByKey: () => ({ kind: "none" }),
            fenceCreate: () => ({ kind: "cancelled" }),
          },
          ({ engine, session }) =>
            Effect.gen(function* () {
              // Nothing holds anything more: the registered head is everything (review round 4).
              expect(yield* engine.flushCaptures(session.id, "landing")).toBe("none");
              const taken = yield* engine.landingCheckpoint(session.id, "user-mark");
              expect(taken.checkpoint).toBeDefined();
            }),
        );
      }),
    { timeout: 20_000 },
  );

  it(
    "removing a session whose first launch was cut short after its claim goes once the platform fences the launch",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            // Never launched: its row names no workspace, and its claim lapsed.
            memory.leases.set(session.worktreeId, {
              executorId: session.id,
              epoch: (memory.leases.get(session.worktreeId)?.epoch ?? 0) + 1,
              expiresAt: memory.clock.now() - 1,
              launchId: `launch:${session.id}:1791000000000:interrupted`,
            });
            expect(yield* engine.removeWhenStopped(session.id)).toBe("removed");
            expect(world.sessions.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              findByKey: () => ({ kind: "none" }),
              fenceCreate: () => ({ kind: "cancelled" }),
            },
          }),
        },
      );
    },
  );

  it.effect(
    "an unnamed launch the platform cannot resolve stays held: nothing created, nothing released",
    () =>
      Effect.gen(function* () {
        // A settled session's resume writes no waiting line on its row: the engine's log is its word.
        const waiting = yield* logged(
          "session engine: capture mode · the worktree's previous executor has not ended · the launch waits",
        );
        yield* unnamedLaunchLease(
          {
            findByKey: () => ({ kind: "none" }),
            fenceCreate: () => ({ kind: "open", state: "pending" }),
          },
          ({ engine, session, memory, created, epoch, launchId }) =>
            Effect.gen(function* () {
              const resuming = yield* engine
                .resumeSession(session.id, "shell")
                .pipe(Effect.exit, Effect.forkChild);
              // The resume waits on the unresolved launch for `leaseWait` (300 ms here), looking
              // every `leaseWaitInterval`, and says so once it waits.
              yield* Deferred.await(waiting.seen);
              yield* TestClock.adjust(Duration.millis(299));
              expect(resuming.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const outcome = yield* Fiber.join(resuming);
              expect(outcome._tag).toBe("Failure");
              expect(created).toHaveLength(1);
              expect(memory.leases.get(session.worktreeId)).toMatchObject({ epoch, launchId });
              expect(yield* engine.captureHolds(session.worktreeId)).toContainEqual({
                sessionId: session.id,
                kind: "lease",
              });
            }),
        ).pipe(Effect.provide(waiting.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a launch waiting for the worktree's previous executor launches nothing once its owner stops it",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the first executor, saving",
              );
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              const launching = yield* engine
                .launch(second.id, ["claude"])
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* untilChanged(
                () => world.sessions.get(second.id)?.summary === LAUNCH_WAITING_SAVING,
                "the waiting line",
              );
              yield* engine.stop(second.id);
              // The waiting launch reads the stop on its next look (`leaseWaitInterval`, 10 ms).
              yield* TestClock.adjust(Duration.millis(10));
              const refused = yield* Fiber.join(launching).pipe(Effect.flip);
              expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                "launch_cancelled",
              );
              expect(world.sessions.get(second.id)?.status).toBe("stopped");
              expect(created).toHaveLength(1);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { leaseWait: Duration.seconds(15) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                captureOps: { finalCompletion: "unreported" },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the lead grows with what is pending at the observed rate: captures registering slowly start the replacement early, past halfway",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const kinds: CaptureFlushKind[] = [];
        let registered = 0;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // Two readings a second apart: one capture registered, 5000 still pending.
              yield* engine.readCaptures(session.id);
              yield* TestClock.adjust(Duration.millis(1100));
              registered = 1;
              yield* engine.readCaptures(session.id);
              const reading = world.sessions.get(session.id);
              expect(reading?.capturePending).toBe(5000);
              // A one-hour cap, no configured lead, and an executor 40 minutes in: 5000 captures at
              // the planning floor (one a second) need longer than the 20 minutes left, so the
              // planned drain is due now, not at the hour. What is pending moves a drain no earlier
              // than halfway through the executor's life, which 40 minutes is past.
              const now = yield* Clock.currentTimeMillis;
              if (reading !== undefined) {
                world.sessions.set(
                  session.id,
                  new Session({ ...reading, executorStartedAt: new Date(now - 40 * 60_000) }),
                );
              }
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => kinds.includes("final"), "the planned drain's final flush");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              executorMaxSeconds: 3600,
              drainEstimateSeconds: 0,
              deadlineMarginSeconds: 0,
              stallSeconds: 1,
            },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                captureOps: {
                  flushKinds: kinds,
                  flush: () =>
                    Effect.sync(() =>
                      kinds.at(-1) === "final"
                        ? flushReport(0, registered + 5000)
                        : flushReport(5000, registered),
                    ),
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it(
    "a lapsed lease is not an end: a second session is refused while the first executor may still run, and takes the worktree once its end is confirmed",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let firstDead = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // A partition: the first executor's heartbeats stop reaching Mend.
            const realNow = memory.clock.now;
            memory.clock.now = () => realNow() + 10 * 60 * 1000;
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(second.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
            expect(refused._tag === "SealantPlatformError" && refused.message).toContain(
              "lease lapsed",
            );
            expect(created).toHaveLength(1);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            // The platform says the first executor is gone: its lease is released and the next
            // session claims a new epoch.
            const third = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const epochBefore = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            firstDead = true;
            // Past the claim, the fake's one workspace also reads gone: only the claim matters.
            yield* engine.launch(third.id, ["claude"]).pipe(Effect.ignore);
            expect(created).toHaveLength(2);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(third.id);
            expect(memory.leases.get(session.worktreeId)?.epoch).toBe(epochBefore + 1);
            memory.clock.now = realNow;
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, { dead: () => firstDead }),
        },
      );
    },
  );

  it.effect(
    "the session that owns the executor stays while another works in it: its removal waits for the workspace",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              yield* engine.launch(second.id, ["claude"]);
              expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");
              yield* engine.stop(session.id);
              // The joined session holds the workspace: no drain, and the stop settles the row.
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the owner's session, stopped",
              );
              // The joined session still works in the executor this row identifies.
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              expect(world.sessions.has(session.id)).toBe(true);
              expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
              // Its capture identity still resolves: the executor's plan is answered as before.
              const holds = yield* engine.captureHolds(session.worktreeId);
              expect(holds.map((hold) => hold.kind)).toContain("executor");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: signalling(lifecycleLayer(created, { spawned })),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "removal holds: a drain under way holds the worktree's identity, and nothing does once the workspace saved and ended",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let saveNow = false;
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // Up and holding its lease: an executor nobody observed end.
              expect((yield* engine.captureHolds(session.worktreeId)).length).toBeGreaterThan(0);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "stop",
                "the drain",
              );
              const saving = yield* engine.captureHolds(session.worktreeId);
              expect(saving).toContainEqual({ sessionId: session.id, kind: "saving" });
              expect(captureHoldWords(saving)).toContain("saving · 1 session");
              saveNow = true;
              // The drain's next round reads it saved.
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              expect(yield* engine.captureHolds(session.worktreeId)).toEqual([]);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { pollInterval, terminationWait: Duration.seconds(5) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: {
                  flushed: events,
                  flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a removal waits for the workspace's end, not only its save: a stop the platform has not carried out keeps the row",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              yield* untilChanged(() => events.includes("workspace-1"), "the stop asked");
              // The platform keeps reporting it up: the drain watches for the termination for
              // `terminationWait` (300 ms), then records itself over with the stop unobserved.
              yield* TestClock.adjust(Duration.millis(299));
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              yield* TestClock.adjust(Duration.millis(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              yield* TestClock.adjust(Duration.millis(200));
              // Saved and asked to stop, but the platform still reports it up: the row the
              // executor registers under stays, and so does its lease.
              expect(world.sessions.has(session.id)).toBe(true);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: { flushed: events, status: () => "ready" },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a landing waits for the executor's captures: a lapsed lease whose executor may still run is not caught up",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const attempts = yield* Effect.all([
          Deferred.make<void>(),
          Deferred.make<void>(),
          Deferred.make<void>(),
        ]);
        let pauses = 0;
        const retries = Logger.layer([
          Logger.make(({ message }) => {
            if (
              String(message) !==
              "session engine: landing checkpoint · the captures have not caught up"
            )
              return;
            const acknowledged = attempts[pauses++];
            if (acknowledged !== undefined) Deferred.doneUnsafe(acknowledged, Effect.void);
          }),
        ]);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const checkpointsBefore = world.checkpoints.length;
              const realNow = memory.clock.now;
              memory.clock.now = () => realNow() + 10 * 60 * 1000;
              // Unknown is never `none`: the executor was not answered for.
              expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
              const landing = yield* engine
                .landingCheckpoint(session.id, "user-mark")
                .pipe(Effect.flip, Effect.forkChild);
              for (const [index, attempted] of attempts.entries()) {
                yield* Deferred.await(attempted);
                yield* TestClock.adjust(1999);
                expect(pauses).toBe(index + 1);
                yield* TestClock.adjust(1);
              }
              const behind = yield* Fiber.join(landing);
              expect(behind._tag === "CapturesBehindError" && behind.attempts).toBe(4);
              expect(behind._tag).toBe("CapturesBehindError");
              expect(world.checkpoints.length).toBe(checkpointsBefore);
              memory.clock.now = realNow;
              // Caught up: the checkpoint names the capture it was derived from, the chain head.
              const taken = yield* engine.landingCheckpoint(session.id, "user-mark");
              expect(taken.captureId).toBe(memory.chains.get(session.worktreeId)?.headCapture);
            }),
          { captured: memory, sealantLayer: lifecycleLayer(created) },
        ).pipe(Effect.provide(retries));
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a relaunch interrupted by a restart finishes: the old executor drains and ends, then the session launches again",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              // What a restart finds: the relaunch planned, its drain not yet run in this process.
              const current = world.sessions.get(session.id);
              if (current === undefined) throw new Error("the session is gone");
              world.relaunches.set(session.id, "codex");
              world.sessions.set(
                session.id,
                new Session({
                  ...current,
                  captureDrain: "relaunch",
                  captureDrainRequestedAt: new Date(),
                  captureDrainProgressAt: new Date(),
                }),
              );
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => created.length === 2, "the relaunch");
              const stopAt = events.indexOf("workspace-1");
              expect(stopAt).toBeGreaterThan(0);
              expect(events[stopAt - 1]).toBe("flush:workspace-1");
              yield* untilChanged(() => !world.relaunches.has(session.id), "the plan's end");
              expect(world.relaunches.has(session.id)).toBe(false);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { terminationWait: Duration.seconds(5) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: { flushed: events },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a relaunch taken up after a restart waits for a launch under way, and starts nothing over it (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const waits = yield* logged(
          "session engine: capture mode · the relaunch waits · a launch of the session is under way",
        );
        const launchHeld = yield* Deferred.make<void>();
        const releaseLaunch = yield* Deferred.make<void>();
        let holding = false;
        /** Holds the next launch past its admission, before it replaces anything. */
        const heldLaunch = Layer.succeed(WorkspaceHostUserNamespaces, {
          observe: () =>
            Effect.suspend(() => {
              if (!holding) return Effect.succeed(null);
              holding = false;
              return Deferred.succeed(launchHeld, undefined).pipe(
                Effect.andThen(Deferred.await(releaseLaunch)),
                Effect.as(null),
              );
            }),
        });
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the stop",
              );
              // What a restart finds: a planned resume whose old executor is already gone.
              const current = world.sessions.get(session.id);
              if (current === undefined) throw new Error("the session is gone");
              world.relaunches.set(session.id, "codex");
              world.sessions.set(
                session.id,
                new Session({
                  ...current,
                  sealantWorkspaceId: null,
                  captureDrain: "relaunch",
                  captureDrainRequestedAt: new Date(),
                  captureDrainProgressAt: new Date(),
                }),
              );
              holding = true;
              const launching = yield* engine
                .launch(session.id, ["codex"], { over: NoLiveAgent })
                .pipe(Effect.forkChild);
              yield* Deferred.await(launchHeld);
              const createdWhileHeld = created.length;

              yield* engine.reapCaptureLeases();
              const first = yield* Effect.raceFirst(
                Deferred.await(waits.seen).pipe(Effect.as("the relaunch waited")),
                untilChanged(() => created.length > createdWhileHeld, "a create").pipe(
                  Effect.as("the relaunch created an executor"),
                ),
              );

              expect(first).toBe("the relaunch waited");
              expect(created).toHaveLength(createdWhileHeld);
              expect(world.relaunches.has(session.id)).toBe(true);
              yield* Deferred.succeed(releaseLaunch, undefined);
              yield* Fiber.join(launching);
              expect(created).toHaveLength(createdWhileHeld + 1);
              // The next pass reads the plan again and finds the agent the launch started.
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => !world.relaunches.has(session.id), "the plan's end");
              expect(created).toHaveLength(createdWhileHeld + 1);
              expect(world.sessions.get(session.id)?.status).toBe("running");
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            hostUserNamespaces: heldLaunch,
            sealantLayer: signalling(lifecycleLayer(created)),
          },
        ).pipe(Effect.provide(waits.layer));
      }),
    { timeout: 20_000 },
  );

  /**
   * A session whose executor is replaced ahead of the platform's cap, its drain under way. The
   * scenario saves it (`save`: the executor terminates and the pickup follows), and can hold the
   * next launch past its admission (`holdNextLaunch`), answering it as the host would, hold the
   * next executor create (`holdNextCreate`: a launch past its relaunch plan), and fail the next
   * agent open (`failNextOpen`). `endExecutor`: the platform reports the current executor stopped
   * until the next create, as Core does for one it ended.
   */
  const capReplacement = (
    scenario: (run: {
      readonly engine: typeof SessionEngine.Service;
      readonly session: Session;
      readonly world: World;
      readonly created: ReadonlyArray<CreateOptions>;
      readonly untilChanged: (condition: () => boolean, label: string) => Effect.Effect<void>;
      readonly drivingCheckpointWaits: <A, E>(
        self: Effect.Effect<A, E, SessionEngine>,
      ) => Effect.Effect<A, E, SessionEngine>;
      readonly save: Effect.Effect<void>;
      readonly holdNextLaunch: Effect.Effect<{
        readonly held: Effect.Effect<void>;
        readonly answer: (observed: HostUserNamespaces | null) => Effect.Effect<void>;
      }>;
      readonly holdNextCreate: Effect.Effect<{
        readonly held: Effect.Effect<void>;
        readonly release: Effect.Effect<void>;
      }>;
      readonly failNextOpen: Effect.Effect<void>;
      readonly endExecutor: Effect.Effect<void>;
      /** The host refuses the next turn it is given: a protocol agent that took no opening turn. */
      readonly refuseNextTurn: Effect.Effect<void>;
    }) => Effect.Effect<void, never, SessionEngine>,
  ) =>
    Effect.gen(function* () {
      const {
        world,
        memory,
        tmp,
        untilChanged,
        signalling,
        wrapCaptureChannel,
        drivingCheckpointWaits,
      } = yield* signalledWorld();
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      let saveNow = false;
      const pollInterval = Duration.millis(10);
      let hold: {
        readonly held: Deferred.Deferred<void>;
        readonly answer: Deferred.Deferred<HostUserNamespaces | null>;
      } | null = null;
      let createHold: {
        readonly held: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      let failNextOpen = false;
      let endedUntilCreate = false;
      let refuseNextTurn = false;
      const heldLaunch = Layer.succeed(WorkspaceHostUserNamespaces, {
        observe: () =>
          Effect.suspend(() => {
            const current = hold;
            if (current === null) return Effect.succeed(null);
            hold = null;
            return Deferred.succeed(current.held, undefined).pipe(
              Effect.andThen(Deferred.await(current.answer)),
            );
          }),
      });
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, dir, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              dir,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
            yield* engine.reapCaptureLeases();
            yield* untilChanged(
              () => world.sessions.get(session.id)?.captureDrain === "replacement",
              "the replacement's drain",
            );
            yield* scenario({
              engine,
              session,
              world,
              created,
              // A wait that never ends fails with what it waited for, not the test's timeout.
              untilChanged: (condition, label) =>
                Effect.raceFirst(
                  untilChanged(condition, label),
                  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10_000))).pipe(
                    Effect.andThen(Effect.die(new Error(`never observed: ${label}`))),
                  ),
                ),
              drivingCheckpointWaits,
              save: Effect.gen(function* () {
                saveNow = true;
                yield* TestClock.adjust(pollInterval);
                yield* untilChanged(() => events.includes("workspace-1"), "the terminate");
              }),
              holdNextLaunch: Effect.gen(function* () {
                const held = yield* Deferred.make<void>();
                const answer = yield* Deferred.make<HostUserNamespaces | null>();
                hold = { held, answer };
                return {
                  held: Deferred.await(held),
                  answer: (observed) => Deferred.succeed(answer, observed).pipe(Effect.asVoid),
                };
              }),
              holdNextCreate: Effect.gen(function* () {
                const held = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                createHold = { held, release };
                return {
                  held: Deferred.await(held),
                  release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
                };
              }),
              failNextOpen: Effect.sync(() => {
                failNextOpen = true;
              }),
              endExecutor: Effect.sync(() => {
                endedUntilCreate = true;
              }),
              refuseNextTurn: Effect.sync(() => {
                refuseNextTurn = true;
              }),
            });
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          wrapCaptureChannel,
          hostUserNamespaces: heldLaunch,
          protocolHostLayer: Layer.effect(
            ProtocolHost,
            Effect.map(ProtocolHost, (host) => ({
              ...host,
              submitTurn: (sessionId, input, author, correlation) =>
                Effect.suspend(() => {
                  if (!refuseNextTurn)
                    return host.submitTurn(sessionId, input, author, correlation);
                  refuseNextTurn = false;
                  return Effect.fail(new ProtocolHostNotLiveError({ processId: "refused" }));
                }),
            })),
          ).pipe(Layer.provide(recordingProtocolHostLayer([], []))),
          drainPolicy: {
            pollInterval,
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
            terminationWait: Duration.seconds(5),
          },
          sealantLayer: signalling(
            lifecycleLayer(created, {
              events,
              captureOps: {
                flushed: events,
                flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                status: (stopAsked) => (endedUntilCreate || stopAsked ? "stopped" : undefined),
                beforeCreate: () =>
                  Effect.suspend(() => {
                    endedUntilCreate = false;
                    const current = createHold;
                    if (current === null) return Effect.void;
                    createHold = null;
                    return Deferred.succeed(current.held, undefined).pipe(
                      Effect.andThen(Deferred.await(current.release)),
                    );
                  }),
                openFails: () => {
                  const fails = failNextOpen;
                  failNextOpen = false;
                  return fails;
                },
              },
            }),
          ),
        },
      );
    });

  it.effect(
    "a launch while a cap-time replacement's pickup holds the gate is refused, and the pickup starts the one agent (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { during: "", created: 0, status: "" };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const pickup = yield* run.holdNextLaunch;
            yield* run.save;
            yield* pickup.held;
            const during = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result);
            seen.during = during._tag === "Failure" ? during.failure._tag : "launched";
            yield* pickup.answer(null);
            yield* run.untilChanged(() => run.created.length === 2, "the pickup's executor");
            seen.created = run.created.length;
            seen.status = run.world.sessions.get(run.session.id)?.status ?? "";
          }),
        );
        expect(seen).toEqual({ during: "SessionAgentLiveError", created: 2, status: "running" });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a cap-time replacement's pickup that a launch held off is kept as a plan, and resumes the agent when that launch starts nothing (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { planned: false, createdWhileHeld: 0, holder: "", created: 0, status: "" };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const holder = yield* run.holdNextLaunch;
            const restarting = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result, Effect.forkChild);
            yield* holder.held;
            yield* run.save;
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the pickup's plan",
            );
            seen.planned = true;
            seen.createdWhileHeld = run.created.length;
            // The launch holding the gate is refused before it starts anything.
            yield* holder.answer({ allowed: false, setting: "kernel.unprivileged_userns_clone=1" });
            const refused = yield* Fiber.join(restarting);
            seen.holder = refused._tag;
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () =>
                !run.world.relaunches.has(run.session.id) &&
                run.world.sessions.get(run.session.id)?.status === "running",
              "the plan's resume",
            );
            seen.created = run.created.length;
            seen.status = run.world.sessions.get(run.session.id)?.status ?? "";
          }),
        );
        expect(seen).toEqual({
          planned: true,
          createdWhileHeld: 1,
          holder: "Failure",
          created: 2,
          status: "running",
        });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a cap-time replacement's plan does nothing once the launch that held it off started the agent (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { holder: "", createdByHolder: 0, created: 0, planLeft: true };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const holder = yield* run.holdNextLaunch;
            const restarting = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result, Effect.forkChild);
            yield* holder.held;
            yield* run.save;
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the pickup's plan",
            );
            yield* holder.answer(null);
            seen.holder = (yield* Fiber.join(restarting))._tag;
            seen.createdByHolder = run.created.length;
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () => !run.world.relaunches.has(run.session.id),
              "the plan's end",
            );
            seen.created = run.created.length;
            seen.planLeft = run.world.relaunches.has(run.session.id);
          }),
        );
        expect(seen).toEqual({
          holder: "Success",
          createdByHolder: 2,
          created: 2,
          planLeft: false,
        });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the owner's Stop that finishes while a held-off pickup's plan is on its way leaves nothing to resume: no agent starts again (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { atStop: "", holder: "", planLeft: true, created: 0, status: "" };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const holder = yield* run.holdNextLaunch;
            const restarting = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result, Effect.forkChild);
            yield* holder.held;
            const writing = yield* Deferred.make<void>();
            const written = yield* Deferred.make<void>();
            run.world.beforeRelaunchSwap.current = (next) => {
              if (next === null || !next.includes('"pickup"')) return Promise.resolve();
              run.world.beforeRelaunchSwap.current = null;
              Deferred.doneUnsafe(writing, Exit.void);
              return Effect.runPromise(Deferred.await(written));
            };
            yield* run.save;
            yield* Deferred.await(writing);
            // The launch that held the pickup off is over before the Stop, so no Stop it owes
            // runs after it: the Stop runs to its end while the pickup's write is on its way.
            yield* holder.answer({ allowed: false, setting: "kernel.unprivileged_userns_clone=1" });
            seen.holder = (yield* Fiber.join(restarting))._tag;
            yield* run.drivingCheckpointWaits(run.engine.stop(run.session.id).pipe(Effect.orDie));
            seen.atStop = run.world.relaunches.has(run.session.id) ? "planned" : "cleared";
            yield* Deferred.succeed(written, undefined);
            yield* settleFor(20);
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () => run.world.sessions.get(run.session.id)?.status !== "stopping",
              "the Stop's settle",
            );
            yield* settleFor(50);
            seen.planLeft = run.world.relaunches.has(run.session.id);
            seen.created = run.created.length;
            seen.status = run.world.sessions.get(run.session.id)?.status ?? "";
          }),
        );
        expect(seen).toEqual({
          atStop: "cleared",
          holder: "Failure",
          planLeft: false,
          created: 1,
          status: "failed",
        });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a pickup's plan still there once the launch that held it off started the agent is consumed by the live-agent refusal, with nothing started (SLNT-167)",
    () =>
      Effect.gen(function* () {
        let present: unknown = null;
        const seen = { holder: "", agentLive: false, created: 0, planLeft: true };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            // A protocol launch whose agent starts and then takes no opening turn: it fails with
            // its agent live, and leaves the pickup its plan owed.
            agentExitsOnItsOwn(run.world);
            const create = yield* run.holdNextCreate;
            yield* run.refuseNextTurn;
            const launching = yield* run.engine
              .launchProtocol(
                run.session.id,
                { mode: "protocol", prompt: "fix the login form" },
                "user-fixture",
                null,
                false,
                { over: Restart },
              )
              .pipe(Effect.result, Effect.forkChild);
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the launch's relaunch plan",
            );
            yield* run.save;
            yield* TestClock.adjust(Duration.seconds(61));
            yield* run.untilChanged(
              () => owesPickup(run.world, run.session),
              "the pickup owed by the launch's plan",
            );
            yield* create.held;
            yield* create.release;
            seen.holder = (yield* Fiber.join(launching))._tag;
            present = storedPlan(run.world, run.session);
            seen.agentLive = [...run.world.processes.values()].some(
              (process) => process.kind === "agent-protocol" && process.exitedAt === null,
            );
            const createdBefore = run.created.length;
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () => !run.world.relaunches.has(run.session.id),
              "the plan consumed",
            );
            seen.created = run.created.length - createdBefore;
            seen.planLeft = run.world.relaunches.has(run.session.id);
          }),
        );
        expect(present).toMatchObject({ kind: "pickup", harness: "codex" });
        expect(seen).toEqual({ holder: "Failure", agentLive: true, created: 0, planLeft: false });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a pickup held off by a protocol launch keeps that launch's plan, its opening prompt and its correlation (SLNT-167)",
    () =>
      Effect.gen(function* () {
        let planned: unknown = null;
        let owed: unknown = null;
        const seen = { holder: "", left: true };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            // A protocol launch, which never starts over a live agent, is admitted once the agent
            // exits, and plans its launch over the drain.
            agentExitsOnItsOwn(run.world);
            const create = yield* run.holdNextCreate;
            const launching = yield* run.engine
              .launchProtocol(
                run.session.id,
                { mode: "protocol", prompt: "fix the login form" },
                "user-fixture",
                null,
                false,
                { over: Restart },
              )
              .pipe(Effect.result, Effect.forkChild);
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the launch's relaunch plan",
            );
            planned = storedPlan(run.world, run.session);
            const asPlanned = run.world.relaunches.get(run.session.id);
            yield* run.save;
            yield* TestClock.adjust(Duration.seconds(61));
            yield* run.untilChanged(
              () => run.world.relaunches.get(run.session.id) !== asPlanned,
              "the pickup's write to the column",
            );
            owed = storedPlan(run.world, run.session);
            yield* create.held;
            yield* create.release;
            seen.holder = (yield* Fiber.join(launching))._tag;
            seen.left = run.world.relaunches.has(run.session.id);
          }),
        );
        expect(planned).toMatchObject({
          kind: "launch",
          start: { mode: "protocol", prompt: "fix the login form" },
          author: "user-fixture",
        });
        expect(owed).toEqual({
          ...(typeof planned === "object" ? planned : {}),
          pickup: "codex",
        });
        expect(seen).toEqual({ holder: "Success", left: false });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a pickup held off by a launch past its relaunch plan is owed by that plan, and outlives the launch failing to start: the reaper resumes it (SLNT-167)",
    () =>
      Effect.gen(function* () {
        let planned: unknown = null;
        let owed: unknown = null;
        let left: unknown = null;
        const seen = { holder: "", createdByHolder: 0, created: 0, status: "" };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const create = yield* run.holdNextCreate;
            yield* run.failNextOpen;
            const restarting = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result, Effect.forkChild);
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the launch's relaunch plan",
            );
            planned = storedPlan(run.world, run.session);
            yield* run.save;
            // The launch's new executor holds the worktree's lease: the replacement's wait for
            // the old one's runs out before its pickup.
            yield* TestClock.adjust(Duration.seconds(61));
            yield* run.untilChanged(
              () => owesPickup(run.world, run.session),
              "the pickup owed by the launch's plan",
            );
            owed = storedPlan(run.world, run.session);
            yield* create.held;
            yield* create.release;
            seen.holder = (yield* Fiber.join(restarting))._tag;
            seen.createdByHolder = run.created.length;
            left = storedPlan(run.world, run.session);
            yield* run.endExecutor;
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () =>
                !run.world.relaunches.has(run.session.id) &&
                run.world.sessions.get(run.session.id)?.status === "running",
              "the pickup's resume",
            );
            seen.created = run.created.length;
            seen.status = run.world.sessions.get(run.session.id)?.status ?? "";
          }),
        );
        expect(planned).toMatchObject({ kind: "resume", harness: "codex" });
        expect(owed).toMatchObject({ kind: "resume", harness: "codex", pickup: "codex" });
        expect(planId(owed)).toBe(planId(planned));
        expect(left).toMatchObject({ kind: "pickup", harness: "codex" });
        expect(seen).toEqual({
          holder: "Failure",
          createdByHolder: 2,
          created: 3,
          status: "running",
        });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a pickup's plan that a launch's own plan replaces is owed by it, and outlives that launch failing to start (SLNT-167)",
    () =>
      Effect.gen(function* () {
        let pickup: unknown = null;
        let taken: unknown = null;
        let left: unknown = null;
        const seen = { holder: "", created: 0, status: "" };
        yield* capReplacement((run) =>
          Effect.gen(function* () {
            const holder = yield* run.holdNextLaunch;
            const restarting = yield* run.engine
              .launch(run.session.id, ["codex"], { over: Restart })
              .pipe(Effect.result, Effect.forkChild);
            yield* holder.held;
            yield* run.save;
            yield* run.untilChanged(
              () => run.world.relaunches.has(run.session.id),
              "the pickup's plan",
            );
            pickup = storedPlan(run.world, run.session);
            const create = yield* run.holdNextCreate;
            yield* run.failNextOpen;
            yield* holder.answer(null);
            yield* create.held;
            taken = storedPlan(run.world, run.session);
            yield* create.release;
            seen.holder = (yield* Fiber.join(restarting))._tag;
            left = storedPlan(run.world, run.session);
            yield* run.endExecutor;
            yield* run.engine.reapCaptureLeases();
            yield* run.untilChanged(
              () =>
                !run.world.relaunches.has(run.session.id) &&
                run.world.sessions.get(run.session.id)?.status === "running",
              "the pickup's resume",
            );
            seen.created = run.created.length;
            seen.status = run.world.sessions.get(run.session.id)?.status ?? "";
          }),
        );
        expect(pickup).toMatchObject({ kind: "pickup", harness: "codex" });
        expect(taken).toMatchObject({ kind: "resume", harness: "codex", pickup: "codex" });
        expect(planId(taken)).not.toBe(planId(pickup));
        expect(left).toMatchObject({ kind: "pickup", harness: "codex" });
        expect(seen).toEqual({ holder: "Failure", created: 3, status: "running" });
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the owner's stop wins over a replacement under way: the drain finishes, the executor ends, and no new one starts",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let saveNow = false;
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // A resumable session: without the owner's stop, the replacement relaunches it.
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
              yield* engine.reapCaptureLeases();
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "replacement",
                "the replacement's drain",
              );
              yield* drivingCheckpointWaits(engine.stop(session.id));
              // Durable: after a restart the drain ends in a stop, not a relaunch.
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              saveNow = true;
              // The replacement's next round reads it saved.
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(() => events.includes("workspace-1"), "the terminate");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              yield* TestClock.adjust(Duration.millis(500));
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(300));
              expect(created).toHaveLength(1);
              expect(world.sessions.get(session.id)?.status).toBe("stopped");
              expect(world.relaunches.has(session.id)).toBe(false);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval,
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                events,
                captureOps: {
                  flushed: events,
                  flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the owner's stop wins over a replacement even while its close is slow: one executor, nothing relaunched (review 4 of mend#558)",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          changed,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let saveNow = false;
        const close = Promise.withResolvers<void>();
        const closeHeld = close.promise;
        const releaseClose = close.resolve;
        let closeReached = false;
        let state: Record<string, unknown> = {};
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* engine.reapCaptureLeases();
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "replacement",
                "the replacement's drain",
              );
              // The owner presses Stop; the platform takes its time closing the agent.
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              // Meanwhile the replacement saves and ends the executor, and looks to relaunch.
              saveNow = true;
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(() => events.includes("workspace-1"), "the terminate");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the replacement's drain end",
              );
              // The lease goes once the end is observed; the replacement then looks to relaunch.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.seconds(3));
              const createdWhileClosing = created.length;
              releaseClose();
              yield* drivingCheckpointWaits(Fiber.join(stopping));
              yield* TestClock.adjust(Duration.seconds(1));
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(300));
              state = {
                createdWhileClosing,
                created: created.length,
                status: world.sessions.get(session.id)?.status,
                relaunch: world.relaunches.has(session.id),
              };
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval,
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(
              signalling(
                lifecycleLayer(created, {
                  events,
                  captureOps: {
                    flushed: events,
                    flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                  },
                }),
              ),
              () => {
                closeReached = true;
                changed();
                return closeHeld;
              },
            ),
          },
        );
        expect(state).toEqual({
          createdWhileClosing: 1,
          created: 1,
          status: "stopped",
          relaunch: false,
        });
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a refused Stop whose agent the finishing replacement ended anyway is a stop: nothing stranded, nothing relaunched (review 5 of mend#558)",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          changed,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let saveNow = false;
        const close = Promise.withResolvers<void>();
        const closeHeld = close.promise;
        const releaseClose = close.resolve;
        let closeReached = false;
        let state: Record<string, unknown> = {};
        const pollInterval = Duration.millis(10);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* engine.reapCaptureLeases();
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "replacement",
                "the replacement's drain",
              );
              // The owner presses Stop; the platform takes its time closing the agent.
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              // Meanwhile the replacement saves and ends the executor, and looks to relaunch.
              saveNow = true;
              yield* TestClock.adjust(pollInterval);
              yield* untilChanged(() => events.includes("workspace-1"), "the terminate");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the replacement's drain end",
              );
              // The lease goes once the end is observed; the replacement then looks to relaunch.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.seconds(3));
              const createdWhileClosing = created.length;
              releaseClose();
              // The refused close is tried again on `PTY_CLOSE_RETRY` (250 ms, then 500 ms)
              // before the stop gives up on it.
              yield* TestClock.adjust(Duration.millis(250));
              yield* TestClock.adjust(Duration.millis(500));
              yield* drivingCheckpointWaits(Fiber.join(stopping));
              yield* TestClock.adjust(Duration.seconds(1));
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(300));
              state = {
                createdWhileClosing,
                created: created.length,
                status: world.sessions.get(session.id)?.status,
                relaunch: world.relaunches.has(session.id),
                summary: world.sessions.get(session.id)?.summary ?? "",
              };
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval,
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(
              signalling(
                lifecycleLayer(created, {
                  events,
                  captureOps: {
                    flushed: events,
                    flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
                  },
                }),
              ),
              () => {
                closeReached = true;
                changed();
                return closeHeld;
              },
              () => true,
            ),
          },
        );
        expect(state).toEqual({
          createdWhileClosing: 1,
          created: 1,
          status: "stopped",
          relaunch: false,
          // No "stop again" for an agent that has already ended, and nothing "starting".
          summary: expect.not.stringMatching(/could not be stopped|starting/),
        });
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a follow-up whose relaunch a restart interrupted is delivered once, with its prompt, after the old executor saved and ended",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const events: string[] = [];
        const PROMPT = "fix the flaky retry test";
        const CORRELATION = "follow-up:f-1";
        let saveNow = false;
        const layerFor = () =>
          signalling(
            lifecycleLayer(created, {
              events,
              spawned,
              captureOps: {
                flushed: events,
                flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
              },
            }),
          );
        // Before the restart: the session is stopped while its executor still saves, and a
        // follow-up relaunches it — the relaunch waits on that drain when Mend goes down.
        const sessionId = yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "stop",
                "the stop's drain",
              );
              yield* Effect.forkChild(
                engine.launchFollowUp(session.id, PROMPT, CORRELATION, "user-fixture"),
              );
              yield* untilChanged(() => world.relaunches.has(session.id), "the planned relaunch");
              expect(created).toHaveLength(1);
              return session.id;
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: layerFor(),
          },
        );
        // After it: the plan is still there, the old executor saves and ends, and the follow-up
        // launches with its prompt, once.
        const planned = world.relaunches.get(sessionId);
        expect(planned).toContain(CORRELATION);
        saveNow = true;
        const flushes = () => events.filter((event) => event === "flush:workspace-1").length;
        const flushesBefore = flushes();
        yield* withPreparedEngineEffect(
          () => Effect.void,
          () =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const id = sessionId;
              // The boot's own sweep takes the relaunch's drain up: its first round's final flush
              // answers complete, and the executor's evidence of it is read by the next round
              // (`pollInterval`, 10 ms), which saves and ends the old executor, then launches again.
              yield* untilChanged(
                () => flushes() > flushesBefore,
                "the relaunch drain's first flush",
              );
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(10));
              yield* untilChanged(() => created.length === 2, "the relaunch");
              const stopAt = events.lastIndexOf("workspace-1");
              expect(stopAt).toBeGreaterThan(0);
              expect(events[stopAt - 1]).toBe("flush:workspace-1");
              // The prompt rides base64-encoded to the harness (`promptArgv`).
              expect(spawned.at(-1)).toContain(Buffer.from(PROMPT).toString("base64"));
              yield* untilChanged(() => !world.relaunches.has(id), "the plan's end");
              // A restart after the launch but before the plan was cleared: the process already
              // carries the correlation id, so nothing launches a second time.
              if (planned !== undefined) world.relaunches.set(id, planned);
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => !world.relaunches.has(id), "the replayed plan's end");
              yield* TestClock.adjust(Duration.millis(300));
              expect(created).toHaveLength(2);
              const correlated = [...world.processes.values()].filter(
                (process) => process.launchCorrelationId === CORRELATION,
              );
              expect(correlated).toHaveLength(1);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: layerFor(),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a restart mid-drain gives the draining session its channel back, so its executor can still ship",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, wrapCaptureChannel } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const layer = () =>
          lifecycleLayer(created, {
            captureOps: { flush: () => Effect.succeed(flushReport(1, 1)) },
          });
        const id = yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "stop",
                "the stop's drain",
              );
              return session.id;
            }),
          { fixture: { world, tmp }, captured: memory, wrapCaptureChannel, sealantLayer: layer() },
        );
        // The channel registry is this process's memory: a restart starts it empty.
        servedSocketApis.delete(id);
        yield* withPreparedEngineEffect(
          () => Effect.void,
          () =>
            Effect.sync(() => {
              // Stopping, still draining (not settled while its container runs): its executor
              // calls in all the same.
              expect(world.sessions.get(id)?.status).toBe("stopping");
              expect(world.sessions.get(id)?.settledAt).toBeNull();
              expect(servedSocketApis.has(id)).toBe(true);
            }),
          { fixture: { world, tmp }, captured: memory, wrapCaptureChannel, sealantLayer: layer() },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the owner's discard asks the platform for a stop that does not drain, and says so when the platform keeps the workspace",
    () =>
      Effect.gen(function* () {
        const {
          world,
          memory,
          tmp,
          untilChanged,
          signalling,
          wrapCaptureChannel,
          drivingCheckpointWaits,
        } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const stops: Array<"drain" | "discard"> = [];
        let platformKeeps = true;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              // Nothing moves for the stall window (1 s): kept at it.
              yield* TestClock.adjust(Duration.millis(999));
              expect(world.sessions.get(session.id)?.captureNotSavedAt).toBeNull();
              yield* TestClock.adjust(Duration.millis(1));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              // The platform keeps it: nothing discarded, and the session still reads its captures.
              // The discard watches for the termination for `terminationWait` (300 ms) first.
              const refusing = yield* engine
                .discardUnsavedAndStop(session.id)
                .pipe(Effect.flip, Effect.forkChild);
              yield* untilChanged(() => stops.length === 1, "the discard's stop");
              yield* TestClock.adjust(Duration.millis(299));
              expect(refusing.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const refused = yield* Fiber.join(refusing);
              expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                "workspace_not_ended",
              );
              expect(stops).toEqual(["discard"]);
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              platformKeeps = false;
              const { session: discarded } = yield* drivingCheckpointWaits(
                engine.discardUnsavedAndStop(session.id),
              );
              expect(discarded.captureDrain).toBeNull();
              expect(stops).toEqual(["discard", "discard"]);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: { stallSeconds: 1, terminationWait: Duration.millis(300) },
            sealantLayer: signalling(
              lifecycleLayer(created, {
                captureOps: {
                  stops,
                  stopAnswer: (discard) => (discard && !platformKeeps ? "stopped" : "kept"),
                  flush: () => Effect.succeed(flushReport(2, 1)),
                },
              }),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "an agent whose executor the host's Docker killed, and Core restarted on its own disk to save it, says the host stopped it, never `completed` (RC 0.36.0-next.768)",
    () =>
      // `systemctl restart docker` with a live session: Docker killed the workspace at its stop
      // timeout (137), Core restarted the executor on its own disk to save it, and that boot
      // answered Mend's look. The session read `completed`, with nothing saying the host ended it.
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, wrapCaptureChannel } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        let killed = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              // The PTY ended with no exit code: SIGKILL, as the platform reports it.
              killed = true;
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitSignal: 9,
                outputHighWater: 0n,
              });
              // The process watcher looks at the PTY every 2 s.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).not.toBe("completed");
              expect(settled?.summary).toMatch(
                /^ended · the host's Docker stopped it · (last capture (\d+ )?at \d\d:\d\d:\d\d UTC · not confirmed|saved at )/,
              );
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              ptyStates,
              undefined,
              undefined,
              // The restarted boot answers Mend's look.
              [],
              undefined,
              {
                captureDrain: () =>
                  killed
                    ? {
                        state: "draining",
                        retained: {
                          since: "2026-10-11T00:50:35Z",
                          reason: "ended without a complete final flush",
                          recoverable: true,
                          recoveryAttempts: 1,
                        },
                      }
                    : null,
              },
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "an agent whose executor went away without Mend asking reads `executor lost`, never `completed`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, wrapCaptureChannel } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        let killed = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              // docker kill: the platform reports the workspace gone and the PTY ended clean.
              killed = true;
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The process watcher looks at the PTY every 2 s.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toMatch(
                /^executor lost · last capture (\d+ )?at \d\d:\d\d:\d\d UTC/,
              );
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              () => killed,
              undefined,
              ptyStates,
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a `docker stop` whose final capture registered last, with no completed word from it and no seal, names that capture as not confirmed — never saved (review 2026-09-28 #13)",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, wrapCaptureChannel } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        let stopped = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // sealantd's SIGTERM path: admission closed, processes ended, then the final captures.
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
                "final",
              );
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              stopped = true;
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The process watcher looks at the PTY every 2 s.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toMatch(
                /^stopped outside Mend · last capture \d+ at \d\d:\d\d:\d\d UTC · not confirmed$/,
              );
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              () => stopped,
              undefined,
              ptyStates,
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a kill -9 says when it last saved, that later changes were not saved, and what Mend last read pending — only when it read it after that save",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, wrapCaptureChannel } = yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        let killed = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
                "auto",
              );
              yield* TestClock.adjust(Duration.millis(20));
              // A reading after that save: 3 captures still queued in the executor.
              const reading = yield* engine.readCaptures(session.id);
              expect(reading?.pending).toBe(3);
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              killed = true;
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The process watcher looks at the PTY every 2 s.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toMatch(
                /^executor lost · last capture (\d+ )?at \d\d:\d\d:\d\d UTC · changes after it were not saved · 3 pending at \d\d:\d\d:\d\d UTC$/,
              );
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              () => killed,
              undefined,
              ptyStates,
              undefined,
              undefined,
              undefined,
              undefined,
              { flush: () => Effect.succeed(flushReport(3, 1)) },
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it(
    "a launch that failed before any executor existed leaves the worktree free for the next one",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let refuse = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(failed._tag).toBe("SealantPlatformError");
            // Nothing ran: the launch's own claim is released.
            expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            refuse = false;
            yield* engine.launch(session.id, ["codex"]);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            expect(world.sessions.get(session.id)?.status).toBe("running");
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(created, () => refuse),
        },
      );
    },
  );
});

/** A stand-in platform whose executor saves at once and ends when asked. */
const savingPlatform = (
  created: Array<CreateOptions>,
  events: string[],
  status: (stopAsked: boolean) => "ready" | "stopped" | "failed" = (stopAsked) =>
    stopAsked ? "stopped" : "ready",
) =>
  lifecycleLayer(created, {
    events,
    captureOps: { status, flush: () => Effect.succeed(flushReport(0, 1)) },
  });

/** What a session the reaper took over must end as: settled `stopped`, nothing of it live. */
const settledStopped = (world: World, sessionId: SessionId) => {
  const after = world.sessions.get(sessionId);
  expect({
    status: after?.status,
    settled: after?.settledAt != null,
    captureDrain: after?.captureDrain,
    liveAgents: liveAgents(world, sessionId).length,
  }).toEqual({ status: "stopped", settled: true, captureDrain: null, liveAgents: 0 });
};

describe("SessionEngine Stop against every takeover of its drain (SLNT-111)", () => {
  it.effect(
    "a lease that lapses while a Stop still closes its agent, on an executor the platform keeps and then ends: the session settles `stopped`, never `running` without an agent",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        let killed = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              // The executor dies on its runtime and Core keeps it; its heartbeats stop.
              killed = true;
              const lapsed = memory.clock.now() + 1_000_000;
              memory.clock.now = () => lapsed;
              yield* engine.reapCaptureLeases();
              yield* untilChanged(
                () => liveAgents(world, session.id).length === 0,
                "the reaper's reap of the agent",
              );
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === null,
                "the drain's end",
              );
              close.resolve();
              yield* Fiber.join(stopping);
              // The Stop's answer folds what is live now, not the rows it read before its close.
              expect(world.sessions.get(session.id)?.status).not.toBe("running");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(
              signalling(
                savingPlatform(created, events, (stopAsked) =>
                  !killed ? "ready" : stopAsked ? "stopped" : "failed",
                ),
              ),
              () => {
                closeReached = true;
                changed();
                return close.promise;
              },
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "an executor the platform keeps and then ends at the reaper's stop, with no Stop asked: the session settles, never `running` without an agent",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let killed = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              killed = true;
              const lapsed = memory.clock.now() + 1_000_000;
              memory.clock.now = () => lapsed;
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              const after = world.sessions.get(session.id);
              expect(after?.status).not.toBe("running");
              expect(after?.captureDrain).toBeNull();
              expect(liveAgents(world, session.id)).toEqual([]);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: signalling(
              savingPlatform(created, events, (stopAsked) =>
                !killed ? "ready" : stopAsked ? "stopped" : "failed",
              ),
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a planned replacement that a reaper tick starts after the owner's Stop began saves and ends the executor and relaunches nothing: the session settles `stopped`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        // The tick reads the session as it was before the Stop, and decides after it began.
        const unsettledRead = heldStep(changed);
        const stood = yield* logged(
          "session engine: capture mode · stopped during the replacement · nothing relaunched",
        );
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                dir,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              unsettledRead.arm();
              const tick = yield* Effect.forkChild(engine.reapCaptureLeases());
              yield* untilChanged(unsettledRead.reached, "the tick's read of the sessions");
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              unsettledRead.release();
              yield* Fiber.join(tick);
              // The replacement saves, ends the executor, and decides what it relaunches.
              yield* untilChanged(() => events.includes("workspace-1"), "the replacement's stop");
              yield* Effect.raceFirst(
                Deferred.await(stood.seen),
                untilChanged(() => created.length > 1, "a relaunch"),
              );
              expect(created).toHaveLength(1);
              close.resolve();
              yield* Fiber.join(stopping);
              // The Stop's answer folds what is live now, not the rows it read before its close.
              expect(world.sessions.get(session.id)?.status).not.toBe("running");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
              expect(created).toHaveLength(1);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            wrapSessions: (inner) => ({
              ...inner,
              listUnsettled: () => unsettledRead.pass.pipe(Effect.andThen(inner.listUnsettled())),
            }),
            drainPolicy: {
              pollInterval: Duration.millis(10),
              executorMaxSeconds: 1000,
              drainEstimateSeconds: 600,
              deadlineMarginSeconds: 400,
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(signalling(savingPlatform(created, events)), () => {
              closeReached = true;
              changed();
              return close.promise;
            }),
          },
        ).pipe(Effect.provide(stood.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a Stop interrupted after it took the drain and before it asked the close: the reaper takes the drain up and the session settles `stopped`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const ptyLookup = heldStep(changed);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              ptyLookup.arm();
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(ptyLookup.reached, "the stop on its way to the close");
              expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
              // The client hangs up: the request's fiber is interrupted.
              yield* Fiber.interrupt(stopping);
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: heldPtyLookups(
              signalling(savingPlatform(created, events)),
              ptyLookup.pass,
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a Stop interrupted in the middle of its close: the reaper takes the drain up and the session settles `stopped`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              yield* Fiber.interrupt(stopping);
              yield* engine.reapCaptureLeases();
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(signalling(savingPlatform(created, events)), () => {
              closeReached = true;
              changed();
              return close.promise;
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "two Stops overlap and the second is interrupted inside its first read: the first still owns its drain, and the reaper leaves it alone",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const close = Promise.withResolvers<void>();
        let closeReached = false;
        const sessionRead = heldStep(changed);
        const takenUp = yield* logged(DRAIN_TAKEN_UP);
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const first = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the first stop at the agent's close");
              // The first read is the owner's lookup around the Stop; the second is the Stop's own.
              sessionRead.arm(1);
              const second = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(sessionRead.reached, "the second stop inside its read");
              yield* Fiber.interrupt(second);
              yield* engine.reapCaptureLeases();
              expect(yield* Deferred.isDone(takenUp.seen)).toBe(false);
              close.resolve();
              yield* Fiber.join(first);
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            wrapSessions: (inner) => ({
              ...inner,
              byId: (id) => sessionRead.pass.pipe(Effect.andThen(inner.byId(id))),
            }),
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(signalling(savingPlatform(created, events)), () => {
              closeReached = true;
              changed();
              return close.promise;
            }),
          },
        ).pipe(Effect.provide(takenUp.layer));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a close that never returns: past the Stop's close deadline the drain ends the executor, and the session settles `stopped`",
    () =>
      Effect.gen(function* () {
        const { world, memory, tmp, untilChanged, changed, signalling, wrapCaptureChannel } =
          yield* signalledWorld();
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        let closeReached = false;
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const stopping = yield* Effect.forkChild(engine.stop(session.id));
              yield* untilChanged(() => closeReached, "the stop at the agent's close");
              yield* TestClock.adjust(Duration.seconds(29));
              expect(events).not.toContain("workspace-1");
              yield* TestClock.adjust(Duration.seconds(1));
              yield* Fiber.join(stopping);
              yield* untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              yield* untilChanged(() => sessionSettled(world, session.id), "the settle");
              settledStopped(world, session.id);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            wrapCaptureChannel,
            drainPolicy: {
              pollInterval: Duration.millis(10),
              terminationWait: Duration.seconds(5),
            },
            sealantLayer: slowCloses(signalling(savingPlatform(created, events)), () => {
              closeReached = true;
              changed();
              return new Promise<void>(() => {});
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
});
