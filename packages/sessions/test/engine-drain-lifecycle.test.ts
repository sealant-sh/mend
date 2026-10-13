import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionId } from "@mend/domain";
import { Session, captureStatusLine } from "@mend/domain/workbench";
import { LAUNCH_WAITING_SAVING } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
} from "@mend/sealant";
import { captureHoldWords, SessionEngine } from "@mend/sessions";
import type { CreateOptions, InteractiveSession, InteractiveSessionStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, Logger } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { it, TestClock } from "./effect-vitest.ts";
import {
  flushReport,
  launchOnce,
  leaseHeld,
  lifecycleLayer,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import {
  drawnLine,
  makeWorld,
  sealantLaunchLayer,
  servedSocketApis,
  type World,
  withEngine,
  withEngineEffect,
} from "./engine/fixture.ts";

describe("SessionEngine capture drain (no loss of work product)", () => {
  it("a stop drains before the workspace goes: it answers at once reading `saving`, the drain flushes until nothing is pending, and the lease is released only once the platform reports the workspace gone", async () => {
    const world = makeWorld();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    const answers = [3, 2, 1, 0];
    const lines: Array<string | null> = [];
    let sessionId: SessionId | null = null;
    let platformReportsStopped = false;
    let leaseHeldAtStop: boolean | null = null;
    await withEngine(
      (_world, dir) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, dir);
          yield* engine.launch(session.id, ["codex"]);
          sessionId = session.id;
          yield* engine.stop(session.id);
          // The stop answers before the drain: the session reads `saving` from this answer on.
          const answered = world.sessions.get(session.id);
          expect(answered?.captureDrain).toBe("stop");
          expect(answered === undefined ? null : captureStatusLine(answered)).toMatch(/^saving/);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
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
          expect(leaseHeldAtStop).toBe(true);
          yield* Effect.sleep(Duration.millis(100));
          expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
          platformReportsStopped = true;
          yield* until(
            () => !leaseHeld(memory, session.worktreeId, session.id),
            "the lease release after the termination",
          );
          yield* until(
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
        drainPolicy: { terminationWait: Duration.seconds(10) },
        sealantLayer: sealantLaunchLayer(
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
              }
              return stopAsked && platformReportsStopped ? "stopped" : "ready";
            },
            flush: () =>
              Effect.sync(() => {
                const current = sessionId === null ? undefined : world.sessions.get(sessionId);
                lines.push(current === undefined ? null : captureStatusLine(current));
                const pending = answers.shift() ?? 0;
                return flushReport(pending, 3 - pending);
              }),
          },
        ),
      },
    );
  });

  it(
    "a discard asked while the save is still moving says nothing was discarded once that save ends the workspace (RC 0.36.0-next.761)",
    { timeout: 20_000 },
    async () => {
      // RC 2 client pass: the discard waited 82 s for the drain's final flush, which saved every
      // file and ended the workspace, and the session line then read `unsaved work discarded`.
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
      const finalAsked = await Effect.runPromise(Deferred.make<void>());
      const finishSave = await Effect.runPromise(Deferred.make<void>());
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* Deferred.await(finalAsked);
            const discarding = yield* engine
              .discardUnsavedAndStop(session.id, "Ada Lovelace")
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.sleep(Duration.millis(100));
            yield* Deferred.succeed(finishSave, undefined);
            const result = yield* Fiber.join(discarding);
            expect(result.discardedAt).toBeNull();
            expect(events).toContain("workspace-1");
            yield* until(
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
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
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
        },
      );
    },
  );

  it(
    "a drain that stops moving keeps the workspace and reads `not saved · N pending · workspace kept`; only the owner's discard ends it",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            // Nothing unsaved before a drain: a plain stop is the verb.
            const early = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
            expect(early._tag).toBe("NothingUnsavedError");
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
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
            yield* Effect.sleep(Duration.millis(200));
            expect(events).not.toContain("workspace-1");
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            // A relaunch behind it is refused: the old workspace holds what is not saved.
            const relaunch = yield* engine.resumeSession(session.id, "shell").pipe(Effect.flip);
            expect(relaunch._tag === "SealantPlatformError" && relaunch.code).toBe(
              "capture_not_saved",
            );
            expect(created).toHaveLength(1);
            expect(events).not.toContain("workspace-1");
            // The owner's discard is the one way the workspace goes with captures pending.
            const { session: discarded } = yield* engine.discardUnsavedAndStop(session.id);
            expect(discarded.captureDrain).toBeNull();
            expect(discarded.captureNotSavedAt).toBeNull();
            expect(events).toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(false);
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          drainPolicy: { stallSeconds: 1 },
          sealantLayer: sealantLaunchLayer(
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
        },
      );
    },
  );

  it(
    "a stopped session reads `stopping` and is not settled until the platform reports its workspace terminated; a kept one stays `stopping`",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let pending = 2;
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            // The agent ended; its container still runs and holds what is not saved.
            const answered = world.sessions.get(session.id);
            expect(answered?.status).toBe("stopping");
            expect(answered?.settledAt).toBeNull();
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept its workspace",
            );
            const kept = world.sessions.get(session.id);
            expect(kept?.status).toBe("stopping");
            expect(kept?.settledAt).toBeNull();
            expect(events).not.toContain("workspace-1");
            // The next sweep: still kept, still not settled.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(100));
            expect(world.sessions.get(session.id)?.status).toBe("stopping");
            expect(world.sessions.get(session.id)?.settledAt).toBeNull();
            // It saves after all; the stop is asked, and only the observed termination settles.
            pending = 0;
            yield* engine.stop(session.id);
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
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
          drainPolicy: { stallSeconds: 1, terminationWait: Duration.seconds(5) },
          sealantLayer: sealantLaunchLayer(
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
        },
      );
    },
  );

  it(
    "saved but its termination not observed: the session stays `stopping` until the platform reports the workspace gone",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let gone = false;
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
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
            // record does (longer on a loaded runner), so it sweeps as the reaper's interval would.
            gone = true;
            for (let i = 0; i < 500 && world.sessions.get(session.id)?.status !== "stopped"; i++) {
              yield* engine.reapCaptureLeases();
              yield* Effect.sleep(Duration.millis(10));
            }
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("stopped");
            expect(settled?.settledAt).not.toBeNull();
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          sealantLayer: sealantLaunchLayer(
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
        },
      );
    },
  );

  it(
    "a kept drain backs off while nothing changes — 10 s doubling to its cap — and looks again at once when something does",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const flushed: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept its workspace",
            );
            yield* Effect.sleep(Duration.millis(50));
            const rounds = () => flushed.length;
            const quiet = (label: string) =>
              Effect.gen(function* () {
                const before = rounds();
                yield* engine.reapCaptureLeases();
                yield* Effect.sleep(Duration.millis(60));
                expect(rounds(), label).toBe(before);
              });
            const looks = (label: string) =>
              Effect.gen(function* () {
                const before = rounds();
                yield* engine.reapCaptureLeases();
                yield* until(() => rounds() > before, label);
                yield* until(
                  () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                  `${label} · kept again`,
                );
                yield* Effect.sleep(Duration.millis(50));
              });
            // Nothing changed: every sweep inside the first wait leaves it alone.
            yield* quiet("a sweep right after the drain was kept");
            yield* quiet("a second sweep inside the first wait");
            // The first wait (300 ms here) has passed: one more round.
            yield* Effect.sleep(Duration.millis(300));
            yield* looks("the round after the first wait");
            // Still nothing changed: the wait doubled, so the first wait is no longer enough.
            yield* Effect.sleep(Duration.millis(320));
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
          drainPolicy: {
            stallSeconds: 1,
            keptRetryFirst: Duration.millis(300),
            keptRetryMax: Duration.seconds(5),
          },
          sealantLayer: sealantLaunchLayer(
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
        },
      );
    },
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

  it("removal waits for the workspace: asked mid-drain the row stays until the workspace is saved and stopped; with no workspace it goes at once", async () => {
    const world = makeWorld();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    let saveNow = false;
    let removedWhileUp: boolean | null = null;
    await withEngine(
      (_world, dir) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, dir);
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
          yield* Effect.sleep(Duration.millis(100));
          expect(world.sessions.has(session.id)).toBe(true);
          expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
          expect(events).not.toContain("workspace-1");
          saveNow = true;
          yield* until(() => !world.sessions.has(session.id), "the removal");
          expect(events).toContain("workspace-1");
          expect(removedWhileUp).toBe(false);
        }),
      {
        fixture: { world, tmp },
        captured: memory,
        sealantLayer: sealantLaunchLayer(
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
      },
    );
  });

  it("plans against the platform's cap: with MEND_EXECUTOR_MAX_SECONDS the drain starts at deadline − (estimate + margin), counted from the executor's own start, then a replacement launches", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const before = Date.now();
          yield* engine.launch(session.id, ["codex"]);
          const startedAt = world.sessions.get(session.id)?.executorStartedAt;
          expect(startedAt?.getTime()).toBeGreaterThanOrEqual(before - 1);
          yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            crypto.randomUUID(),
          );
          // 1000 s cap, 600 s estimate + 400 s margin: due from the executor's start.
          yield* engine.reapCaptureLeases();
          yield* until(() => created.length === 2, "the replacement launch");
          const stopAt = events.indexOf("workspace-1");
          expect(stopAt).toBeGreaterThan(0);
          expect(events[stopAt - 1]).toBe("flush:workspace-1");
        }),
      {
        captured: memory,
        drainPolicy: {
          executorMaxSeconds: 1000,
          drainEstimateSeconds: 600,
          deadlineMarginSeconds: 400,
        },
        sealantLayer: sealantLaunchLayer(
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
      },
    );
  });

  it("with the cap unknown an executor younger than the fallback age is left alone", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.reapCaptureLeases();
          yield* Effect.sleep(Duration.millis(200));
          expect(created).toHaveLength(1);
          expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created) },
    );
  });
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

describe("SessionEngine lifecycle safety (review 2026-09-27)", () => {
  it("every planned end asks the executor for a final flush; a checkpoint asks for a suspend one", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const kinds: CaptureFlushKind[] = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.checkpointNow(session.id, "user-mark");
          expect(kinds.length).toBeGreaterThan(0);
          expect(kinds.every((kind) => kind === "suspend")).toBe(true);
          const before = kinds.length;
          yield* engine.stop(session.id);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
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
        captured: memory,
        drainPolicy: { terminationWait: Duration.seconds(5) },
        sealantLayer: lifecycleLayer(created, {
          events,
          captureOps: { flushed: events, flushKinds: kinds },
        }),
      },
    );
  });

  it(
    "a replacement is saved only by a completed final flush: an executor that cannot say `complete` keeps its workspace and nothing relaunches",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
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
            // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            // The queue read empty, but nothing said the executor quiesced and snapshotted both
            // classes: the workspace stays, and no second executor was made.
            yield* Effect.sleep(Duration.millis(200));
            expect(events).not.toContain("workspace-1");
            expect(created).toHaveLength(1);
            const kept = world.sessions.get(session.id);
            expect(kept?.captureDrain).toBe("replacement");
            expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
              "not saved · final flush not reported · 0 pending · workspace kept",
            );
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events, finalCompletion: "unreported" },
          }),
        },
      );
    },
  );

  it(
    "an executor sent a final flush is never reused: a second session is refused instead of joining it",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            const spawnedBefore = spawned.length;
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(second.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
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
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            spawned,
            captureOps: { finalCompletion: "unreported" },
          }),
        },
      );
    },
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
        yield* withEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
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

  it(
    "a join under way keeps the holder's Stop from flushing the executor shut under it (RC 0.36.0-next.761)",
    { timeout: 20_000 },
    async () => {
      // RC 2 client pass: back-to-back `mend run` in a worktree with 1.5 GB untracked. The first
      // run's settle tail harvested for seconds before its drain began; the second run looked at
      // the holder meanwhile, read it live and joined, and the drain then found no process in the
      // executor, sent its final flush, and the join's PTY was refused ("the executor is ending: a
      // final capture flush closed admission"), the second session recorded failed.
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
      const joinOpening = await Effect.runPromise(Deferred.make<void>());
      const releaseJoin = await Effect.runPromise(Deferred.make<void>());
      let opens = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
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
            yield* until(
              () => world.sessions.get(session.id)?.status === "stopped",
              "the first session, stopped",
            );
            yield* Effect.sleep(Duration.millis(200));
            // Its Stop found the join in the executor: nothing flushed it shut, nothing stopped it.
            expect(kinds).not.toContain("final");
            expect(events).not.toContain("workspace-1");
            yield* Deferred.succeed(releaseJoin, undefined);
            const launched = yield* Fiber.join(launching);
            expect(launched.status).toBe("running");
            expect(created).toHaveLength(1);
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
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
        },
      );
    },
  );

  it(
    "a resume never creates over a lease of the session's earlier launch whose end nothing confirms (alpha 2026-10-03)",
    { timeout: 20_000 },
    async () => {
      // Alpha 8fe91d79: an earlier executor of the session kept its lease, bound to its launch,
      // and each relaunch read the session's own lease as free. And the row's workspace is not
      // that executor: a replacement that overwrote the row and then stopped says nothing of
      // the lease's launch, which may still hold work it has not shipped (review of #516).
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
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
            const outcome = yield* engine.resumeSession(session.id, "shell").pipe(Effect.exit);
            expect(outcome._tag).toBe("Failure");
            expect(created).toHaveLength(1);
            const lease = memory.leases.get(session.worktreeId);
            expect(lease?.launchId).toBe("launch:unresolved-predecessor");
            expect(lease?.epoch).toBe(epoch);
          }),
        {
          captured: memory,
          drainPolicy: { leaseWait: Duration.millis(300), leaseWaitInterval: Duration.millis(20) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
            },
          }),
        },
      );
    },
  );

  it(
    "another session's lease of a launch its row no longer names is a hold: no launch, no release, no removal (review of #516)",
    { timeout: 20_000 },
    async () => {
      // A/B: session one's lease is bound to launch A, whose end nothing confirms, while its row
      // names a later executor B that has stopped. B's end says nothing of A: a sibling's launch
      // waits and is refused, and a removal is held, with A's lease kept.
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
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
            const refused = yield* engine.launch(sibling.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
            expect(created).toHaveLength(1);
            const holds = yield* engine.captureHolds(session.worktreeId);
            expect(holds).toContainEqual({ sessionId: session.id, kind: "lease" });
            const lease = memory.leases.get(session.worktreeId);
            expect(lease?.launchId).toBe("launch:a-unconfirmed");
            expect(lease?.epoch).toBe(epoch);
          }),
        {
          captured: memory,
          drainPolicy: { leaseWait: Duration.millis(300), leaseWaitInterval: Duration.millis(20) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
            },
          }),
        },
      );
    },
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
  ) => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    return withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          yield* until(() => world.sessions.get(session.id)?.status === "stopped", "stopped");
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
        captured: memory,
        drainPolicy: { leaseWait: Duration.millis(300), leaseWaitInterval: Duration.millis(20) },
        sealantLayer: lifecycleLayer(created, {
          dead,
          captureOps: {
            status: (stopAsked) => (stopAsked && created.length === 1 ? "stopped" : "ready"),
            ...captureOps,
          },
        }),
      },
    );
  };

  it(
    "a restart between a launch's claim and its create leaves a lease the platform resolves: the next resume goes on",
    { timeout: 20_000 },
    async () => {
      const fenced: string[] = [];
      await unnamedLaunchLease(
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
    },
  );

  it(
    "an unnamed launch the platform finds ended is released, and its worktree can be removed",
    { timeout: 20_000 },
    async () => {
      const looked: string[] = [];
      await unnamedLaunchLease(
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
    },
  );

  it(
    "a fenced create's own lease is released even while the previous executor cannot be read",
    { timeout: 20_000 },
    async () => {
      let unreachable = false;
      await unnamedLaunchLease(
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
    },
  );

  it(
    "a relaunch's claim cut short by a restart does not hold up a landing: the flush asks the platform",
    { timeout: 20_000 },
    async () => {
      await unnamedLaunchLease(
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
    },
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

  it(
    "an unnamed launch the platform cannot resolve stays held: nothing created, nothing released",
    { timeout: 20_000 },
    async () => {
      await unnamedLaunchLease(
        {
          findByKey: () => ({ kind: "none" }),
          fenceCreate: () => ({ kind: "open", state: "pending" }),
        },
        ({ engine, session, memory, created, epoch, launchId }) =>
          Effect.gen(function* () {
            const outcome = yield* engine.resumeSession(session.id, "shell").pipe(Effect.exit);
            expect(outcome._tag).toBe("Failure");
            expect(created).toHaveLength(1);
            expect(memory.leases.get(session.worktreeId)).toMatchObject({ epoch, launchId });
            expect(yield* engine.captureHolds(session.worktreeId)).toContainEqual({
              sessionId: session.id,
              kind: "lease",
            });
          }),
      );
    },
  );

  it(
    "a launch waiting for the worktree's previous executor launches nothing once its owner stops it",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
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
            yield* until(
              () => world.sessions.get(second.id)?.summary === LAUNCH_WAITING_SAVING,
              "the waiting line",
            );
            yield* engine.stop(second.id);
            const refused = yield* Fiber.join(launching).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
              "launch_cancelled",
            );
            expect(world.sessions.get(second.id)?.status).toBe("stopped");
            expect(created).toHaveLength(1);
          }),
        {
          captured: memory,
          drainPolicy: { leaseWait: Duration.seconds(15) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: { finalCompletion: "unreported" },
          }),
        },
      );
    },
  );

  it(
    "the lead grows with what is pending at the observed rate: captures registering slowly start the replacement early, past halfway",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
      let registered = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // Two readings a second apart: one capture registered, 5000 still pending.
            yield* engine.readCaptures(session.id);
            yield* Effect.sleep(Duration.millis(1100));
            registered = 1;
            yield* engine.readCaptures(session.id);
            const reading = world.sessions.get(session.id);
            expect(reading?.capturePending).toBe(5000);
            // A one-hour cap, no configured lead, and an executor 40 minutes in: 5000 captures at
            // the planning floor (one a second) need longer than the 20 minutes left, so the
            // planned drain is due now, not at the hour. What is pending moves a drain no earlier
            // than halfway through the executor's life, which 40 minutes is past.
            if (reading !== undefined) {
              world.sessions.set(
                session.id,
                new Session({ ...reading, executorStartedAt: new Date(Date.now() - 40 * 60_000) }),
              );
            }
            yield* engine.reapCaptureLeases();
            yield* until(() => kinds.includes("final"), "the planned drain's final flush");
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 3600,
            drainEstimateSeconds: 0,
            deadlineMarginSeconds: 0,
            stallSeconds: 1,
          },
          sealantLayer: lifecycleLayer(created, {
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
        },
      );
    },
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

  it(
    "the session that owns the executor stays while another works in it: its removal waits for the workspace",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(second.id, ["claude"]);
            expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");
            yield* engine.stop(session.id);
            yield* Effect.sleep(Duration.millis(300));
            // The joined session still works in the executor this row identifies.
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            expect(world.sessions.has(session.id)).toBe(true);
            expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
            // Its capture identity still resolves: the executor's plan is answered as before.
            const holds = yield* engine.captureHolds(session.worktreeId);
            expect(holds.map((hold) => hold.kind)).toContain("executor");
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, { spawned }),
        },
      );
    },
  );

  it(
    "removal holds: a drain under way holds the worktree's identity, and nothing does once the workspace saved and ended",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // Up and holding its lease: an executor nobody observed end.
            expect((yield* engine.captureHolds(session.worktreeId)).length).toBeGreaterThan(0);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the drain",
            );
            const saving = yield* engine.captureHolds(session.worktreeId);
            expect(saving).toContainEqual({ sessionId: session.id, kind: "saving" });
            expect(captureHoldWords(saving)).toContain("saving · 1 session");
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([]);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.seconds(5) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushed: events,
              flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
            },
          }),
        },
      );
    },
  );

  it(
    "a removal waits for the workspace's end, not only its save: a stop the platform has not carried out keeps the row",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            yield* until(() => events.includes("workspace-1"), "the stop asked");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            yield* Effect.sleep(Duration.millis(200));
            // Saved and asked to stop, but the platform still reports it up: the row the
            // executor registers under stays, and so does its lease.
            expect(world.sessions.has(session.id)).toBe(true);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.millis(300) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events, status: () => "ready" },
          }),
        },
      );
    },
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
        yield* withEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
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

  it(
    "a relaunch interrupted by a restart finishes: the old executor drains and ends, then the session launches again",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
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
            yield* until(() => created.length === 2, "the relaunch");
            const stopAt = events.indexOf("workspace-1");
            expect(stopAt).toBeGreaterThan(0);
            expect(events[stopAt - 1]).toBe("flush:workspace-1");
            expect(world.relaunches.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.seconds(5) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events },
          }),
        },
      );
    },
  );

  it(
    "the owner's stop wins over a replacement under way: the drain finishes, the executor ends, and no new one starts",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // A resumable session: without the owner's stop, the replacement relaunches it.
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "replacement",
              "the replacement's drain",
            );
            yield* engine.stop(session.id);
            // Durable: after a restart the drain ends in a stop, not a relaunch.
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the terminate");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            yield* Effect.sleep(Duration.millis(500));
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(300));
            expect(created).toHaveLength(1);
            expect(world.sessions.get(session.id)?.status).toBe("stopped");
            expect(world.relaunches.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
            terminationWait: Duration.seconds(5),
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushed: events,
              flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
            },
          }),
        },
      );
    },
  );

  it(
    "the owner's stop wins over a replacement even while its close is slow: one executor, nothing relaunched (review 4 of mend#558)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      const close = Promise.withResolvers<void>();
      const closeHeld = close.promise;
      const releaseClose = close.resolve;
      let state: Record<string, unknown> = {};
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
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "replacement",
              "the replacement's drain",
            );
            // The owner presses Stop; the platform takes its time closing the agent.
            const stopping = yield* Effect.forkChild(engine.stop(session.id));
            yield* Effect.sleep(Duration.millis(200));
            // Meanwhile the replacement saves and ends the executor, and looks to relaunch.
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the terminate");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the replacement's drain end",
            );
            // The lease goes once the end is observed; the replacement then looks to relaunch.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.seconds(3));
            const createdWhileClosing = created.length;
            releaseClose();
            yield* Fiber.join(stopping);
            yield* Effect.sleep(Duration.seconds(1));
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(300));
            state = {
              createdWhileClosing,
              created: created.length,
              status: world.sessions.get(session.id)?.status,
              relaunch: world.relaunches.has(session.id),
            };
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
            terminationWait: Duration.seconds(5),
          },
          sealantLayer: slowCloses(
            lifecycleLayer(created, {
              events,
              captureOps: {
                flushed: events,
                flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
              },
            }),
            () => closeHeld,
          ),
        },
      );
      expect(state).toEqual({
        createdWhileClosing: 1,
        created: 1,
        status: "stopped",
        relaunch: false,
      });
    },
  );

  it(
    "a refused Stop whose agent the finishing replacement ended anyway is a stop: nothing stranded, nothing relaunched (review 5 of mend#558)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      const close = Promise.withResolvers<void>();
      const closeHeld = close.promise;
      const releaseClose = close.resolve;
      let state: Record<string, unknown> = {};
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
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "replacement",
              "the replacement's drain",
            );
            // The owner presses Stop; the platform takes its time closing the agent.
            const stopping = yield* Effect.forkChild(engine.stop(session.id));
            yield* Effect.sleep(Duration.millis(200));
            // Meanwhile the replacement saves and ends the executor, and looks to relaunch.
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the terminate");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the replacement's drain end",
            );
            // The lease goes once the end is observed; the replacement then looks to relaunch.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.seconds(3));
            const createdWhileClosing = created.length;
            releaseClose();
            yield* Fiber.join(stopping);
            yield* Effect.sleep(Duration.seconds(1));
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(300));
            state = {
              createdWhileClosing,
              created: created.length,
              status: world.sessions.get(session.id)?.status,
              relaunch: world.relaunches.has(session.id),
              summary: world.sessions.get(session.id)?.summary ?? "",
            };
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
            terminationWait: Duration.seconds(5),
          },
          sealantLayer: slowCloses(
            lifecycleLayer(created, {
              events,
              captureOps: {
                flushed: events,
                flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
              },
            }),
            () => closeHeld,
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
    },
  );

  it(
    "a follow-up whose relaunch a restart interrupted is delivered once, with its prompt, after the old executor saved and ended",
    { timeout: 30_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-relaunch-restart-test-")),
      };
      const memory = makeMemoryCaptureStore();
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const events: string[] = [];
      const PROMPT = "fix the flaky retry test";
      const CORRELATION = "follow-up:f-1";
      let saveNow = false;
      let sessionId: SessionId | null = null;
      const layerFor = () =>
        lifecycleLayer(created, {
          events,
          spawned,
          captureOps: {
            flushed: events,
            flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
          },
        });
      // Before the restart: the session is stopped while its executor still saves, and a
      // follow-up relaunches it — the relaunch waits on that drain when Mend goes down.
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionId = session.id;
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the stop's drain",
            );
            yield* Effect.forkChild(
              engine.launchFollowUp(session.id, PROMPT, CORRELATION, "user-fixture"),
            );
            yield* until(() => world.relaunches.has(session.id), "the planned relaunch");
            expect(created).toHaveLength(1);
          }),
        { fixture, captured: memory, sealantLayer: layerFor() },
      );
      // After it: the plan is still there, the old executor saves and ends, and the follow-up
      // launches with its prompt, once.
      const planned = sessionId === null ? undefined : fixture.world.relaunches.get(sessionId);
      expect(planned).toContain(CORRELATION);
      saveNow = true;
      await withEngine(
        (world) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            if (sessionId === null) throw new Error("no session");
            const id = sessionId;
            yield* engine.reapCaptureLeases();
            yield* until(() => created.length === 2, "the relaunch");
            const stopAt = events.lastIndexOf("workspace-1");
            expect(stopAt).toBeGreaterThan(0);
            expect(events[stopAt - 1]).toBe("flush:workspace-1");
            // The prompt rides base64-encoded to the harness (`promptArgv`).
            expect(spawned.at(-1)).toContain(Buffer.from(PROMPT).toString("base64"));
            yield* until(() => !world.relaunches.has(id), "the plan's end");
            // A restart after the launch but before the plan was cleared: the process already
            // carries the correlation id, so nothing launches a second time.
            if (planned !== undefined) world.relaunches.set(id, planned);
            yield* engine.reapCaptureLeases();
            yield* until(() => !world.relaunches.has(id), "the replayed plan's end");
            yield* Effect.sleep(Duration.millis(300));
            expect(created).toHaveLength(2);
            const correlated = [...world.processes.values()].filter(
              (process) => process.launchCorrelationId === CORRELATION,
            );
            expect(correlated).toHaveLength(1);
          }),
        { fixture, captured: memory, sealantLayer: layerFor() },
      );
    },
  );

  it(
    "a restart mid-drain gives the draining session its channel back, so its executor can still ship",
    { timeout: 20_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-channel-restart-test-")),
      };
      const memory = makeMemoryCaptureStore();
      const created: Array<CreateOptions> = [];
      let sessionId: SessionId | null = null;
      const layer = () =>
        lifecycleLayer(created, {
          captureOps: { flush: () => Effect.succeed(flushReport(1, 1)) },
        });
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionId = session.id;
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the stop's drain",
            );
          }),
        { fixture, captured: memory, sealantLayer: layer() },
      );
      if (sessionId === null) throw new Error("no session");
      const id: SessionId = sessionId;
      // The channel registry is this process's memory: a restart starts it empty.
      servedSocketApis.delete(id);
      await withEngine(
        (world) =>
          Effect.sync(() => {
            // Stopping, still draining (not settled while its container runs): its executor
            // calls in all the same.
            expect(world.sessions.get(id)?.status).toBe("stopping");
            expect(world.sessions.get(id)?.settledAt).toBeNull();
            expect(servedSocketApis.has(id)).toBe(true);
          }),
        { fixture, captured: memory, sealantLayer: layer() },
      );
    },
  );

  it(
    "the owner's discard asks the platform for a stop that does not drain, and says so when the platform keeps the workspace",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const stops: Array<"drain" | "discard"> = [];
      const memory = makeMemoryCaptureStore();
      let platformKeeps = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            // The platform keeps it: nothing discarded, and the session still reads its captures.
            const refused = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
              "workspace_not_ended",
            );
            expect(stops).toEqual(["discard"]);
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            platformKeeps = false;
            const { session: discarded } = yield* engine.discardUnsavedAndStop(session.id);
            expect(discarded.captureDrain).toBeNull();
            expect(stops).toEqual(["discard", "discard"]);
          }),
        {
          captured: memory,
          drainPolicy: { stallSeconds: 1, terminationWait: Duration.millis(300) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stops,
              stopAnswer: (discard) => (discard && !platformKeeps ? "stopped" : "kept"),
              flush: () => Effect.succeed(flushReport(2, 1)),
            },
          }),
        },
      );
    },
  );

  it(
    "an agent whose executor the host's Docker killed, and Core restarted on its own disk to save it, says the host stopped it, never `completed` (RC 0.36.0-next.768)",
    { timeout: 20_000 },
    async () => {
      // `systemctl restart docker` with a live session: Docker killed the workspace at its stop
      // timeout (137), Core restarted the executor on its own disk to save it, and that boot
      // answered Mend's look. The session read `completed`, with nothing saying the host ended it.
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let killed = false;
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
            yield* until(
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
          captured: memory,
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
    },
  );

  it(
    "an agent whose executor went away without Mend asking reads `executor lost`, never `completed`",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let killed = false;
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
            yield* until(
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
          captured: memory,
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
    },
  );

  it(
    "a `docker stop` whose final capture registered last, with no completed word from it and no seal, names that capture as not confirmed — never saved (review 2026-09-28 #13)",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let stopped = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // sealantd's SIGTERM path: admission closed, processes ended, then the final captures.
            yield* shipHarnessCapture(
              tmp,
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
            yield* until(
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
          captured: memory,
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
    },
  );

  it(
    "a kill -9 says when it last saved, that later changes were not saved, and what Mend last read pending — only when it read it after that save",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let killed = false;
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
              "auto",
            );
            yield* Effect.sleep(Duration.millis(20));
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
            yield* until(
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
          captured: memory,
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
    },
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
