import { SessionProcess } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Clock, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import { makeEngineClock, signalledFixture } from "./engine/clock-fixture.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

describe("SessionEngine", () => {
  it.effect(
    "a caller that goes away mid-launch leaves the launch running: the agent starts and the session reads running",
    () =>
      Effect.gen(function* () {
        // Alpha 2026-09-30 (cc05cb8a, 48763b65): a client that gave up on the launch request
        // interrupted the launch wherever it stood — a running agent whose session read `starting`
        // with `started_at` null for good. The caller's interruption now ends only its own wait.
        const created: CreateOptions[] = [];
        const createAsked = yield* Deferred.make<void>();
        const createAnswered = yield* Deferred.make<void>();
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const caller = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
              yield* Deferred.await(createAsked);
              yield* Fiber.interrupt(caller);
              expect(world.sessions.get(session.id)?.status).toBe("starting");

              yield* Deferred.succeed(createAnswered, undefined);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "running",
                "the launch the caller left to reach running",
              );
              const running = world.sessions.get(session.id);
              expect(running?.startedAt).not.toBeNull();
              expect(running?.sealantRunId).not.toBeNull();
              expect(
                [...world.processes.values()].some(
                  (process) => process.sessionId === session.id && process.kind === "agent-pty",
                ),
              ).toBe(true);
            }),
          {
            fixture: { world, tmp },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                beforeCreate: () =>
                  Deferred.succeed(createAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(createAnswered)),
                  ),
              },
            }),
          },
        );
      }),
  );

  for (const retained of [false, true]) {
    for (const seam of ["preparation", "pty-open", "protocol-attach"] as const) {
      if (retained && seam === "preparation") continue;
      for (const stopped of [true, false]) {
        it.effect(
          `${stopped ? "Stop cancels" : "failure fails"} ${retained ? "retained" : "cold"} ${seam} without poisoning the next message`,
          () =>
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const { world, tmp, untilChanged } = yield* signalledFixture("mend-startup-stop-");
              const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> =
                [];
              const submitted: string[] = [];
              let armed = !retained;
              let rejected = false;
              const startup = (phase: typeof seam) =>
                Effect.suspend(() => {
                  if (!armed || rejected || phase !== seam) return Effect.void;
                  rejected = true;
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(
                      Effect.fail(
                        new SealantPlatformError({
                          code: "executor_ending",
                          status: 409,
                          message:
                            phase === "protocol-attach"
                              ? "PTY ended before protocol initialized"
                              : "executor admission is closed",
                          cause: null,
                        }),
                      ),
                    ),
                  );
                });
              yield* withPreparedEngineEffect(
                (_world, dir) => setup(dir, world),
                (_world, _dir, project) =>
                  Effect.gen(function* () {
                    const engine = yield* SessionEngine;
                    const session = yield* engine.provision({
                      projectId: project.id,
                      harness: "codex",
                      label: null,
                      name: null,
                      ownerUserId: "user-fixture",
                      start: { kind: "base", base: null },
                    });
                    if (retained) {
                      yield* engine.launchProtocol(
                        session.id,
                        { mode: "protocol" },
                        "user-fixture",
                      );
                      yield* engine.openShell(session.id);
                      yield* engine.stop(session.id);
                      expect(world.sessions.get(session.id)?.status).toBe("idle");
                      armed = true;
                    }
                    const launching = yield* engine
                      .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                      .pipe(Effect.forkChild);
                    yield* Deferred.await(entered);
                    if (stopped) yield* engine.stop(session.id, "stopped by the person");
                    yield* Deferred.succeed(release, undefined);
                    const result = yield* Fiber.await(launching);
                    expect(Exit.isFailure(result)).toBe(true);
                    const settled = world.sessions.get(session.id);
                    if (stopped) {
                      expect(["idle", "stopped"]).toContain(settled?.status);
                      expect(settled?.summary ?? "").not.toContain(
                        "protocol initialization failed",
                      );
                      expect(JSON.stringify(result)).toContain("launch_cancelled");
                    } else {
                      expect(settled?.status).toBe(
                        retained && seam === "protocol-attach" ? "idle" : "failed",
                      );
                      if (retained && seam === "protocol-attach") {
                        expect(JSON.stringify(result)).toContain(
                          "PTY ended before protocol initialized",
                        );
                      } else {
                        expect(settled?.summary).toContain(
                          seam === "protocol-attach"
                            ? "protocol initialization failed"
                            : "admission is closed",
                        );
                      }
                    }
                    expect(
                      [...world.processes.values()].filter(
                        (process) =>
                          process.sessionId === session.id &&
                          process.kind === "agent-protocol" &&
                          process.exitedAt === null,
                      ),
                    ).toEqual([]);
                    yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
                    yield* engine.submitTurn(session.id, "Please continue", "user-fixture");
                    yield* untilChanged(
                      () => submitted.length === 1,
                      "the follow-up to reach the new agent",
                    );
                    expect(submitted).toEqual(["Please continue"]);
                    expect(world.sessions.get(session.id)?.status).toBe("running");
                  }),
                {
                  fixture: { world, tmp },
                  sealantLayer: lifecycleLayer([], {
                    captureOps: {
                      beforeCreate: () => startup("preparation"),
                      aroundOpen: () => startup("pty-open"),
                    },
                  }),
                  protocolHostLayer: recordingProtocolHostLayer(
                    attached,
                    submitted,
                    [],
                    [],
                    [],
                    () => startup("protocol-attach"),
                  ),
                },
              );
            }),
        );
      }
    }
  }

  for (const captured of [false, true]) {
    for (const action of ["send", "concurrent sends", "Stop again"] as const) {
      it.effect(
        `${captured ? "captured" : "colocated"} ${action} while a cancelled startup finishes tearing down`,
        () =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const { world, tmp } = yield* signalledFixture("mend-stop-followup-");
            const driver = yield* makeEngineClock(["sessions", "processes", "relaunches"], {
              drivesCheckpointWaits: true,
            });
            driver.prepareWorld(world);
            const driven = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const running = yield* effect.pipe(
                  Effect.onExit(() => Effect.sync(driver.changed)),
                  Effect.forkChild,
                );
                yield* driver.untilChanged(
                  () => running.pollUnsafe() !== undefined,
                  "the operation and its checkpoint waits",
                );
                return yield* Fiber.join(running);
              });
            const clock = yield* Clock.Clock;
            const memory = makeMemoryCaptureStore();
            memory.clock.now = () => clock.currentTimeMillisUnsafe();
            const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
            const submitted: string[] = [];
            let first = true;
            yield* withPreparedEngineEffect(
              (_world, dir) => setup(dir, world),
              (_world, _dir, project) =>
                Effect.gen(function* () {
                  const engine = yield* SessionEngine;
                  const session = yield* engine.provision({
                    projectId: project.id,
                    harness: "codex",
                    label: null,
                    name: null,
                    ownerUserId: "user-fixture",
                    start: { kind: "base", base: null },
                  });
                  const launching = yield* engine
                    .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                    .pipe(Effect.forkChild);
                  yield* Deferred.await(entered);
                  yield* driven(engine.stop(session.id));
                  const followUp = yield* engine
                    .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                    .pipe(Effect.forkChild);
                  const concurrent =
                    action === "concurrent sends"
                      ? yield* engine
                          .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                          .pipe(Effect.forkChild)
                      : null;
                  yield* TestClock.adjust(0);
                  const beforeTeardown = followUp.pollUnsafe();
                  const waitingIsStarting = engine.launchUnderWay(session.id);
                  if (action === "Stop again") yield* driven(engine.stop(session.id));
                  const afterStopIsStarting = engine.launchUnderWay(session.id);
                  yield* Deferred.succeed(release, undefined);
                  const stopped = yield* driven(Fiber.await(launching));
                  const resumed = yield* driven(Fiber.await(followUp));
                  expect(JSON.stringify(stopped)).toContain("launch_cancelled");
                  expect(beforeTeardown).toBeUndefined();
                  expect(waitingIsStarting).toBe(true);
                  if (action === "Stop again") {
                    expect(afterStopIsStarting).toBe(false);
                    expect(JSON.stringify(resumed)).toContain("launch_cancelled");
                    expect(attached).toEqual([]);
                    expect(world.sessions.get(session.id)?.status).toBe("stopped");
                    return;
                  }
                  if (concurrent !== null) {
                    const other = yield* driven(Fiber.await(concurrent));
                    expect(Exit.isFailure(other)).toBe(true);
                    expect(JSON.stringify(other)).toContain("already under way");
                  }
                  expect(Exit.isSuccess(resumed)).toBe(true);
                  expect(attached).toHaveLength(1);
                  yield* engine.submitTurn(session.id, "Please continue", "user-fixture");
                  expect(submitted).toEqual(["Please continue"]);
                  expect(world.sessions.get(session.id)?.status).toBe("running");
                  expect(
                    [...world.processes.values()].filter(
                      (process) =>
                        process.sessionId === session.id &&
                        process.kind === "agent-protocol" &&
                        process.exitedAt === null,
                    ),
                  ).toHaveLength(1);
                }),
              {
                fixture: { world, tmp },
                ...(captured ? { captured: memory } : {}),
                wrapCaptureChannel: driver.wrapCaptureChannel,
                sealantLayer: lifecycleLayer([], { execCalls: [] }),
                protocolHostLayer: recordingProtocolHostLayer(attached, submitted, [], [], [], () =>
                  Effect.suspend(() => {
                    if (!first) return Effect.void;
                    first = false;
                    return Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(
                        Effect.fail(
                          new SealantPlatformError({
                            code: "executor_ending",
                            status: 409,
                            message: "executor ended during startup",
                            cause: null,
                          }),
                        ),
                      ),
                    );
                  }),
                ),
              },
            );
          }),
      );
    }
  }

  for (const seam of ["preparation", "pty-open", "protocol-attach"] as const) {
    for (const stopped of [true, false]) {
      it.effect(
        `capture ${stopped ? "Stop cancels" : "failure fails"} ${seam} and leaves no running agent`,
        () =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const { world, tmp } = yield* signalledFixture("mend-capture-startup-stop-");
            const driver = yield* makeEngineClock(["sessions", "processes", "relaunches"], {
              drivesCheckpointWaits: true,
            });
            driver.prepareWorld(world);
            const untilChanged = driver.untilChanged;
            const driven = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const running = yield* effect.pipe(
                  Effect.onExit(() => Effect.sync(driver.changed)),
                  Effect.forkChild,
                );
                yield* untilChanged(
                  () => running.pollUnsafe() !== undefined,
                  "the operation and its checkpoint waits",
                );
                return yield* Fiber.join(running);
              });
            const clock = yield* Clock.Clock;
            const memory = makeMemoryCaptureStore();
            memory.clock.now = () => clock.currentTimeMillisUnsafe();
            let rejected = false;
            const startup = (phase: typeof seam) =>
              Effect.suspend(() => {
                if (rejected || phase !== seam) return Effect.void;
                rejected = true;
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.fail(
                      new SealantPlatformError({
                        code: "executor_ending",
                        status: 409,
                        message: "executor ended during startup",
                        cause: null,
                      }),
                    ),
                  ),
                );
              });
            yield* withPreparedEngineEffect(
              (_world, dir) => setup(dir, world),
              (_world, _dir, project) =>
                Effect.gen(function* () {
                  const engine = yield* SessionEngine;
                  const session = yield* engine.provision({
                    projectId: project.id,
                    harness: "codex",
                    label: null,
                    name: null,
                    ownerUserId: "user-fixture",
                    start: { kind: "base", base: null },
                  });
                  const launching = yield* engine
                    .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                    .pipe(Effect.forkChild);
                  yield* Deferred.await(entered);
                  if (stopped) yield* driven(engine.stop(session.id));
                  yield* Deferred.succeed(release, undefined);
                  const result = yield* driven(Fiber.await(launching));
                  expect(JSON.stringify(result)).toContain(
                    stopped ? "launch_cancelled" : "executor_ending",
                  );
                  yield* untilChanged(
                    () =>
                      world.sessions.get(session.id)?.status === (stopped ? "stopped" : "failed"),
                    "the captured startup outcome to settle",
                  );
                  if (stopped)
                    expect(world.sessions.get(session.id)?.summary ?? "").not.toContain("failed");
                  else expect(world.sessions.get(session.id)?.summary ?? "").toContain("failed");
                  expect(
                    [...world.processes.values()].filter(
                      (process) => process.sessionId === session.id && process.exitedAt === null,
                    ),
                  ).toEqual([]);
                  yield* driven(
                    engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture"),
                  );
                  expect(world.sessions.get(session.id)?.status).toBe("running");
                }),
              {
                fixture: { world, tmp },
                captured: memory,
                wrapCaptureChannel: driver.wrapCaptureChannel,
                sealantLayer: lifecycleLayer([], {
                  execCalls: [],
                  captureOps: {
                    beforeCreate: () => startup("preparation"),
                    aroundOpen: () => startup("pty-open"),
                  },
                }),
                protocolHostLayer: recordingProtocolHostLayer([], [], [], [], [], () =>
                  startup("protocol-attach"),
                ),
              },
            );
          }),
      );
    }
  }

  it("a stop while the launch still sets up its machine: the agent never starts and the session reads stopped", async () => {
    // Alpha 2026-10-01 (3c4e991b): a stop during a launch found no agent to end, and the launch
    // went on and started one. Now the launch looks for the stop just before the agent starts.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const createAsked = await Effect.runPromise(Deferred.make<void>());
    const createAnswered = await Effect.runPromise(Deferred.make<void>());
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(createAsked);

          yield* engine.stop(session.id);
          yield* Deferred.succeed(createAnswered, undefined);
          const launched = yield* Fiber.await(launching);

          expect(Exit.isFailure(launched)).toBe(true);
          expect(JSON.stringify(launched)).toContain("stopped while starting");
          expect(spawned).toEqual([]);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          expect(
            [...world.processes.values()].filter(
              (process) => process.sessionId === session.id && process.exitedAt === null,
            ),
          ).toEqual([]);
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          spawned,
          captureOps: {
            beforeCreate: () =>
              Deferred.succeed(createAsked, undefined).pipe(
                Effect.andThen(Deferred.await(createAnswered)),
              ),
          },
        }),
      },
    );
  });

  it("a stop while the image builds reads stopped from then on, and the build failing after it keeps the stop's words", async () => {
    // RC 3 (2026-10-11): `mend stop` said ✓ stopped, and the session read `starting` for minutes
    // while its image build ran on; the build failing later would have rewritten it `failed`.
    const created: CreateOptions[] = [];
    const createAsked = await Effect.runPromise(Deferred.make<void>());
    const buildEnds = await Effect.runPromise(Deferred.make<void>());
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(createAsked);
          expect(engine.launchUnderWay(session.id)).toBe(true);

          yield* engine.stop(session.id);
          // The launch is still under way, standing down: it is not read as starting.
          expect(engine.launchUnderWay(session.id)).toBe(false);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          const stoppedWords = world.sessions.get(session.id)?.summary ?? null;

          yield* Deferred.succeed(buildEnds, undefined);
          yield* Fiber.await(launching);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          expect(world.sessions.get(session.id)?.summary ?? null).toBe(stoppedWords);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Deferred.succeed(createAsked, undefined).pipe(
              Effect.andThen(Deferred.await(buildEnds)),
              Effect.andThen(
                Effect.fail(
                  new SealantPlatformError({
                    code: "workspace_image_build_stalled",
                    status: null,
                    message: "The image build for workspace workspace-1 reported no progress.",
                    cause: null,
                  }),
                ),
              ),
            ),
        ),
      },
    );
  });

  it("a stop after the launch's last look, before the agent's row: the launch ends and so does the agent", async () => {
    // The alpha case itself: the stop landed while the platform was opening the agent, two
    // seconds before its process row. The launch's agent reopened the stopped session as
    // `running` and nothing ended it. The launch now stops the session again as it ends.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const openAsked = await Effect.runPromise(Deferred.make<void>());
    const openAnswered = await Effect.runPromise(Deferred.make<void>());
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(openAsked);

          yield* engine.stop(session.id);
          yield* Deferred.succeed(openAnswered, undefined);
          yield* Fiber.await(launching);

          expect(spawned).toHaveLength(1);
          const agents = [...world.processes.values()].filter(
            (process) => process.sessionId === session.id && process.kind === "agent-pty",
          );
          expect(agents).toHaveLength(1);
          expect(agents[0]?.exitedAt).not.toBeNull();
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          spawned,
          captureOps: {
            aroundOpen: () =>
              Deferred.succeed(openAsked, undefined).pipe(
                Effect.andThen(Deferred.await(openAnswered)),
              ),
          },
        }),
      },
    );
  });

  it.effect(
    "the same in capture mode: the stop drains the executor and the agent the launch started ends with it",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const spawned: ReadonlyArray<string>[] = [];
        const openAsked = yield* Deferred.make<void>();
        const openAnswered = yield* Deferred.make<void>();
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        const clock = yield* Clock.Clock;
        // The store's clock follows the engine's: a lease and its reading share one time.
        const memory = makeMemoryCaptureStore();
        memory.clock.now = () => clock.currentTimeMillisUnsafe();
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
              yield* Deferred.await(openAsked);

              yield* engine.stop(session.id);
              yield* Deferred.succeed(openAnswered, undefined);
              yield* Fiber.await(launching);
              yield* untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the stopped launch to settle stopped",
              );

              const agents = [...world.processes.values()].filter(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              expect(spawned).toHaveLength(1);
              expect(agents.every((agent) => agent.exitedAt !== null)).toBe(true);
            }),
          {
            fixture: { world, tmp },
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              spawned,
              captureOps: {
                aroundOpen: () =>
                  Deferred.succeed(openAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(openAnswered)),
                  ),
              },
            }),
          },
        );
      }),
  );
});
