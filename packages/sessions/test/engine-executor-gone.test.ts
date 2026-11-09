import type { SessionId } from "@mend/domain";
import { type CaptureCompletionSeal } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, WorkspaceCaptureDrain } from "@sealant/sdk";
import { Clock, Effect } from "effect";
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
 * sealant-sh/sealant#491: a Boat VM that was removed reads `stopped`, never `retained`, and Core
 * records what became of its work in the drain (`saved` · `stopped` · `discarded` · `gone`). An
 * established session whose VM vanished is then stopped by its owner: Mend's drain finds the
 * workspace already ended. `sealed`: the store holds the seal of this executor's final flush.
 */
const ownerStopsAfterVanish = (drain: WorkspaceCaptureDrain, options: { sealed: boolean }) =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const clock = yield* Clock.Clock;
    const memory = makeMemoryCaptureStore();
    memory.clock.now = () => clock.currentTimeMillisUnsafe();
    const records = new Map<string, CaptureCompletionSeal>();
    const { world: rows, tmp: dir, changes } = yield* signalledFixture("mend-gone-test-");
    const { registrations, wrapCaptureChannel } = yield* registrationWaits;
    const untilChanged = drivingUntilChanged(changes, registrations);
    let vanished = false;
    let read: {
      readonly status: string | undefined;
      readonly summary: string | null;
      readonly runStatus: string | undefined;
      readonly runSummary: string | null;
      readonly sealedAt: Date | null;
      readonly sealedN: number | null;
    } = {
      status: undefined,
      summary: null,
      runStatus: undefined,
      runSummary: null,
      sealedAt: null,
      sealedN: null,
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
          const sealedAt = new Date();
          if (options.sealed) {
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
              captureId: built.id,
              n: built.manifest.n,
              sealedAt,
            });
          }
          vanished = true;
          yield* engine.stop(session.id);
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
            sealedAt: options.sealed ? sealedAt : null,
            sealedN: options.sealed ? built.manifest.n : null,
          };
        }),
      {
        captured: memory,
        fixture: { world: rows, tmp: dir },
        wrapCaptureChannel,
        seals: memorySeals(records),
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            status: () => (vanished ? "stopped" : "ready"),
            captureDrain: () => (vanished ? drain : null),
          },
        }),
      },
    );
    return read;
  });

describe("an owner's Stop of a session whose Boat VM was removed (sealant#491)", () => {
  it.effect(
    "Core recorded the work gone and Mend holds no save: the session and its run read failed, with Core's cause",
    () =>
      Effect.gen(function* () {
        const read = yield* ownerStopsAfterVanish(
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
          const read = yield* ownerStopsAfterVanish(
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
        const read = yield* ownerStopsAfterVanish(
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
        const read = yield* ownerStopsAfterVanish(
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
