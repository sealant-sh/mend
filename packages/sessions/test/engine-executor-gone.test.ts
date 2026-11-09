import type { SessionId } from "@mend/domain";
import { type CaptureCompletionSeal } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureDrain } from "@sealant/sdk";
import { Clock, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  lifecycleLayer,
  memorySeals,
  provisionIn,
  shipHarnessCapture,
} from "./engine/capture-fixture.ts";
import {
  drivingUntilChanged,
  parkingClock,
  POLL_INTERVAL,
  registrationWaits,
  signalledFixture,
} from "./engine/clock-fixture.ts";
import { setup, type World, withPreparedEngineEffect } from "./engine/fixture.ts";

const GONE_DETAIL =
  "The executor's VM was removed before its final flush completed; its work was not confirmed saved.";

const latestRunOf = (world: World, sessionId: SessionId) =>
  [...world.sessionRuns.values()]
    .filter((run) => run.sessionId === sessionId)
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

/**
 * How the session learns its executor ended (sealant-sh/sealant#491: a removed Boat VM reads
 * `stopped`, and Core's drain records what became of its work):
 * - `stop`: the owner presses Stop and Mend's drain finds the workspace already ended;
 * - `stop-transient`: the same, with Core unreachable for the first drain read;
 * - `agent`: the agent's PTY exits while the executor is gone;
 * - `reaper`: the lease lapses and the reaper picks the session up;
 * - `reaper-idle`: the owner opened a shell and stopped the agent before the VM vanished, then
 *   the lease lapses.
 */
type VanishAction = "stop" | "stop-transient" | "agent" | "reaper" | "reaper-idle";

/**
 * An established session whose Boat VM vanished, ended through `action`. `sealed`: the store
 * holds a seal of a final flush, this executor's unless `sealFor` names a stale one.
 */
const afterVanish = (
  drain: WorkspaceCaptureDrain,
  options: {
    readonly sealed: boolean;
    readonly sealFor?: "previous-launch" | "previous-epoch";
    readonly action?: VanishAction;
  },
) =>
  Effect.gen(function* () {
    const action = options.action ?? "stop";
    const created: Array<CreateOptions> = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    const parking = yield* parkingClock;
    const clock = parking.clock;
    const memory = makeMemoryCaptureStore();
    memory.clock.now = () => clock.currentTimeMillisUnsafe();
    const records = new Map<string, CaptureCompletionSeal>();
    const { world: rows, tmp: dir, changes } = yield* signalledFixture("mend-gone-test-");
    const { registrations, wrapCaptureChannel } = yield* registrationWaits;
    const untilChanged = drivingUntilChanged(changes, registrations);
    let vanished = false;
    let drainReads = 0;
    let read: {
      readonly status: string | undefined;
      readonly summary: string | null;
      readonly runStatus: string | undefined;
      readonly runSummary: string | null;
      readonly drainReads: number;
    } = {
      status: undefined,
      summary: null,
      runStatus: undefined,
      runSummary: null,
      drainReads: 0,
    };
    yield* withPreparedEngineEffect(
      (world, tmp) => setup(tmp, world),
      (world, tmp, project) =>
        Effect.gen(function* () {
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          const built = yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            crypto.randomUUID(),
            options.sealed ? "final" : "turn",
          );
          if (options.sealed) {
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch: options.sealFor === "previous-epoch" ? epoch - 1 : epoch,
              executorId:
                options.sealFor === "previous-launch"
                  ? "old-launch"
                  : (world.executorLaunches.get(session.id)?.launchId ?? ""),
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
            });
          }
          if (action === "reaper-idle") {
            yield* engine.openShell(session.id);
            yield* engine.stop(session.id);
            expect(world.sessions.get(session.id)?.status).toBe("idle");
          }
          vanished = true;
          if (action === "stop") yield* engine.stop(session.id);
          if (action === "stop-transient") {
            const stopping = yield* Effect.forkChild(engine.stop(session.id));
            // The drain looks again a poll after Core did not answer for the drain.
            yield* parking.untilParked(POLL_INTERVAL);
            yield* TestClock.adjust(POLL_INTERVAL);
            yield* Fiber.join(stopping);
          }
          if (action === "agent") {
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("the agent has no PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* TestClock.adjust("2 seconds");
          }
          if (action === "reaper" || action === "reaper-idle") {
            const lapsed = memory.clock.now() + 1_000_000;
            memory.clock.now = () => lapsed;
            yield* engine.reapCaptureLeases();
          }
          yield* untilChanged(
            () => world.sessions.get(session.id)?.settledAt != null,
            "the session to settle",
          );
          const settled = world.sessions.get(session.id);
          const run = latestRunOf(world, session.id);
          read = {
            status: settled?.status,
            summary: settled?.summary ?? null,
            runStatus: run?.status,
            runSummary: run?.summary ?? null,
            drainReads,
          };
        }),
      {
        captured: memory,
        fixture: { world: rows, tmp: dir },
        wrapCaptureChannel,
        seals: memorySeals(records),
        sealantLayer: lifecycleLayer(created, {
          ptyStates,
          captureOps: {
            status: () => (vanished ? "stopped" : "ready"),
            captureDrain: () => {
              if (!vanished) return null;
              drainReads += 1;
              if (action === "stop-transient" && drainReads === 1) {
                throw new Error("Core temporarily unreachable");
              }
              return drain;
            },
          },
        }),
      },
    ).pipe(Effect.provideService(Clock.Clock, parking.clock));
    return read;
  });

describe("an owner's Stop of a session whose Boat VM was removed (sealant#491)", () => {
  it.effect(
    "Core recorded the work gone and Mend holds no save: the session and its run read failed, with Core's cause",
    () =>
      Effect.gen(function* () {
        const read = yield* afterVanish(
          { state: "gone", detail: GONE_DETAIL, observedAt: "2026-11-09T10:00:00.000Z" },
          { sealed: false },
        );
        expect(read.status).toBe("failed");
        expect(read.summary).toMatch(/^executor gone · work not confirmed saved · /);
        expect(read.summary).toContain(
          "The executor's VM was removed before its final flush completed; its work was not confirmed saved",
        );
        expect(read.runStatus).toBe("failed");
        expect(read.runSummary).toBe(read.summary);
      }),
    { timeout: 20_000 },
  );

  for (const state of ["saved", "stopped"] as const) {
    it.effect(
      `Core recorded the work ${state}: a clean stop, its words unchanged`,
      () =>
        Effect.gen(function* () {
          const read = yield* afterVanish(
            { state, observedAt: "2026-11-09T10:00:00.000Z" },
            { sealed: false },
          );
          expect(read.status).toBe("stopped");
          expect(read.summary).toBeNull();
          expect(read.runStatus).toBe("stopped");
        }),
      { timeout: 20_000 },
    );
  }

  it.effect(
    "Core recorded the owner's discard: not failed, and the session says the unsaved work was discarded",
    () =>
      Effect.gen(function* () {
        const read = yield* afterVanish(
          {
            state: "discarded",
            observedAt: "2026-11-09T10:00:05.000Z",
            discard: { requestedBy: "user-1", requestedAt: "2026-11-09T10:00:00.000Z" },
          },
          { sealed: false },
        );
        expect(read.status).toBe("stopped");
        expect(read.summary).toBe("unsaved work discarded at 10:00:00 UTC");
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "Core recorded the work gone but Mend holds the executor's seal: Mend's own save wins",
    () =>
      Effect.gen(function* () {
        const read = yield* afterVanish(
          { state: "gone", detail: GONE_DETAIL, observedAt: "2026-11-09T10:00:00.000Z" },
          { sealed: true },
        );
        expect(read.status).toBe("stopped");
        expect(read.summary ?? "").not.toContain("executor gone");
        expect(read.runStatus).toBe("stopped");
      }),
    { timeout: 20_000 },
  );
});

describe("every way Mend learns a removed Boat VM ended reads Core's record of its work (sealant#491)", () => {
  for (const state of ["gone", "saved", "stopped", "discarded"] as const) {
    for (const action of ["agent", "reaper", "reaper-idle", "stop-transient"] as const) {
      it.effect(
        `${action}: Core recorded the work ${state} and Mend holds no save: ${state === "gone" ? "failed, executor gone" : "stopped"}`,
        () =>
          Effect.gen(function* () {
            const read = yield* afterVanish(
              {
                state,
                detail: GONE_DETAIL,
                observedAt: "2026-11-09T10:00:00.000Z",
                ...(state === "discarded"
                  ? { discard: { requestedBy: "user-1", requestedAt: "2026-11-09T09:59:00.000Z" } }
                  : {}),
              },
              { sealed: false, action },
            );
            expect(read.status).toBe(state === "gone" ? "failed" : "stopped");
            if (state === "gone") {
              expect(read.summary ?? "").toContain("executor gone");
              expect(read.runStatus).toBe("failed");
              expect(read.runSummary ?? "").toContain("executor gone");
            }
            if (action === "stop-transient") expect(read.drainReads).toBeGreaterThanOrEqual(2);
          }),
        { timeout: 20_000 },
      );
    }
  }
});

describe("a stale seal never stands for the gone executor's work", () => {
  for (const sealFor of ["previous-launch", "previous-epoch"] as const) {
    it.effect(
      `a seal of the ${sealFor}: failed, executor gone`,
      () =>
        Effect.gen(function* () {
          const read = yield* afterVanish(
            { state: "gone", detail: GONE_DETAIL },
            { sealed: true, sealFor },
          );
          expect(read.status).toBe("failed");
          expect(read.summary ?? "").toContain("executor gone");
        }),
      { timeout: 20_000 },
    );
  }
});
