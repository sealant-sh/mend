import { type SessionId } from "@mend/domain";
import { HotWorkspace, Project } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, Workspace, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Clock, Duration, Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer, memoryHotPool } from "./engine/capture-fixture.ts";
import { makeStandbyClock } from "./engine/clock-fixture.ts";
import {
  captureAnswer,
  servedSocketApis,
  setup,
  type World,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/**
 * SLNT-1044: a status read that lands between a claimed standby's acceptance and its re-plan's
 * answer is answered by the standby under its placeholder epoch, about its `standby-<id>`
 * worktree. Every later save is under the claim's epoch, which nothing orders against the
 * placeholder: the stop's drain looped on "the final flush answered complete, but the executor's
 * evidence does not read saved" until it kept the workspace (4 of 5 claimed sessions on the box,
 * 2026-11-15).
 */

/** What the session's status read is answered with, before its claim's re-plan answers. */
type EarlyWords = "pending" | "not-final";

interface Scenario {
  /** Whether the session claims a standby, or launches cold. */
  readonly hot: boolean;
  /**
   * When the read lands: `before-replan`, between the standby's acceptance and its re-plan's
   * answer; `after-launch`, once the launch returned; `none`, never.
   */
  readonly read: "before-replan" | "after-launch" | "none";
  readonly early: EarlyWords;
  /**
   * The stop's final flush, under the claim's epoch: `saved` (nothing pending, complete),
   * `unsaved` (the person's write still pending: real unsaved work), or `kept-then-saves`
   * (pending at the stop, so the workspace is kept; complete at the capture reaper's next pass).
   */
  readonly final: "saved" | "unsaved" | "kept-then-saves";
}

interface Outcome {
  readonly stops: ReadonlyArray<"drain" | "discard">;
  /** What the stop's drain said when its final flush answered complete and it did not save. */
  readonly drainWords: ReadonlyArray<string>;
  /** What Mend said when it kept an answer the standby gave under its placeholder. */
  readonly placeholderWords: ReadonlyArray<string>;
  readonly notSavedAt: Date | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly unsavedEpochs: ReadonlyArray<number | null>;
  readonly placeholder: number | null;
}

const drain = {
  terminationWait: Duration.millis(50),
  pollInterval: Duration.millis(10),
  // A drain that does not read saved keeps the workspace at once: what a person sees after the
  // box's stall window, without waiting it out.
  stallSeconds: 0,
};

/** Every unsaved answer the executor's evidence keeps, by the epoch it was made under. */
const unsavedEpochsOf = (world: World, workspaceId: string) =>
  (world.executorEvidence.get(workspaceId)?.unsaved ?? []).map(
    (answer) => answer.position?.epoch ?? null,
  );

const run = (scenario: Scenario) =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const stops: Array<"drain" | "discard"> = [];
    const logs: Array<string> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const clock = yield* makeStandbyClock(pool);
    /** The executor's own order: one daemon boot, every answer the next observation. */
    let observation = 0;
    let launch = "";
    let placeholder: number | null = null;
    let claimEpoch = 0;
    /** Set once the re-plan answered: the daemon answers under the claim's epoch from then on. */
    let replanned = false;
    let executor: SessionId | null = null;
    let finalSaves = scenario.final === "saved";
    let engine: SessionEngine["Service"] | null = null;
    let world: World | null = null;
    const stamped = (epoch: number) => ({
      epoch,
      origin: { epoch, launch, bootId: "boot-1", bootGeneration: 1, observation: ++observation },
    });
    /** The status answer, as the daemon gives it now. */
    const statusAnswer = (): WorkspaceCaptureStatus => {
      if (scenario.hot && !replanned && placeholder !== null) {
        // The standby's own: its refused uploads, or a final it never ran.
        return captureAnswer({
          ...stamped(placeholder),
          worktreeId: `standby-${executor ?? ""}`,
          ...(scenario.early === "pending"
            ? { pending: 1, pendingBytes: 3_340 }
            : { complete: false, incompleteReason: "not-final" }),
        });
      }
      // The person's write, not shipped yet.
      return captureAnswer({ ...stamped(claimEpoch), pending: 1, pendingBytes: 2_048 });
    };
    /** A status read asked as a client's view asks it, waited for until it is published. */
    const readStatus = Effect.gen(function* () {
      if (engine === null || executor === null || world === null) throw new Error("no engine");
      const evidenceWorld = world;
      const before = evidenceWorld.executorEvidence.get("workspace-1")?.version ?? 0;
      yield* engine.refreshCaptureStatus(executor);
      for (
        let i = 0;
        i < 2_000 && (evidenceWorld.executorEvidence.get("workspace-1")?.version ?? 0) === before;
        i++
      ) {
        yield* Effect.yieldNow;
      }
      expect(evidenceWorld.executorEvidence.get("workspace-1")?.version ?? 0).toBeGreaterThan(
        before,
      );
    });
    const replan = (_workspace: Workspace) =>
      Effect.gen(function* () {
        if (executor === null) throw new Error("no executor to replan");
        if (scenario.read === "before-replan") yield* readStatus;
        const api = servedSocketApis.get(executor)?.capture;
        if (api === undefined) throw new Error("the executor serves no capture api");
        const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(
          Effect.mapError(
            (error) =>
              new SealantPlatformError({
                code: "replan_refused",
                status: error.status,
                message: `${error.reason}: ${error.message}`,
                cause: error,
              }),
          ),
        );
        claimEpoch = plan.epoch;
        replanned = true;
        return {
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          ...(plan.head === null
            ? {}
            : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
          filesWritten: 0,
          bytesWritten: 0,
          filesSkipped: 0,
          bytesSkipped: 0,
          removed: 0,
          unchanged: false,
        };
      });
    const result: { outcome: Outcome | null } = { outcome: null };
    yield* withPreparedEngineEffect(
      (testWorld, tmp) => setup(tmp, testWorld),
      (testWorld, _tmp, project) =>
        Effect.gen(function* () {
          world = testWorld;
          testWorld.projects.set(
            project.id,
            new Project({ ...project, hotSessions: scenario.hot ? 1 : 0 }),
          );
          const sessions = yield* SessionEngine;
          engine = sessions;
          if (scenario.hot) {
            yield* sessions.reconcileHotSessions(project.id);
            yield* clock.untilReady(
              () => pool.entries.some((entry) => entry.status === "ready"),
              "a standby",
            );
            const warmed = pool.entries[0];
            if (warmed === undefined) throw new Error("no standby");
            // The in-memory pool stamps a standby with the wall clock, the engine reads the test
            // clock: stamped on the engine's, a claimed standby's answers come after its creation,
            // as they do on a server.
            yield* TestClock.adjust(Duration.seconds(1));
            const standby = new HotWorkspace({
              ...warmed,
              createdAt: new Date(yield* Clock.currentTimeMillis),
            });
            pool.entries[0] = standby;
            placeholder = standby.createdAt.getTime();
            launch = `standby:${standby.id}`;
          }
          const provision = sessions.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const session = scenario.hot ? yield* clock.claim(provision) : yield* provision;
          executor = session.id;
          yield* sessions.launch(session.id, ["codex"]);
          if (!scenario.hot) {
            launch = testWorld.executorLaunches.get(session.id)?.launchId ?? "";
            claimEpoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          }
          if (scenario.read === "after-launch") yield* readStatus;
          yield* sessions.stop(session.id);
          const settle = Effect.gen(function* () {
            for (
              let look = 0;
              look < 200 &&
              stops.length === 0 &&
              testWorld.sessions.get(session.id)?.captureNotSavedAt == null;
              look++
            ) {
              yield* TestClock.adjust(drain.pollInterval);
            }
          });
          yield* settle;
          if (scenario.final === "kept-then-saves") {
            // Kept: a person sees `not saved · workspace kept`. The person's write saves; the
            // capture reaper takes the kept drain up again, as it does after an upgrade.
            expect(testWorld.sessions.get(session.id)?.captureNotSavedAt).not.toBeNull();
            expect(stops).toEqual([]);
            finalSaves = true;
            // Past the kept drain's first wait (10 s): what a restart's empty memory skips.
            yield* TestClock.adjust(Duration.seconds(10));
            yield* sessions.reapCaptureLeases();
            for (let look = 0; look < 200 && stops.length === 0; look++) {
              yield* TestClock.adjust(drain.pollInterval);
            }
          }
          const row = testWorld.sessions.get(session.id);
          result.outcome = {
            stops: [...stops],
            drainWords: logs.filter((line) => line.includes("evidence does not read saved")),
            placeholderWords: logs.filter((line) =>
              line.includes("answered under its placeholder"),
            ),
            notSavedAt: row?.captureNotSavedAt ?? null,
            status: row?.status ?? null,
            summary: row?.summary ?? null,
            unsavedEpochs: unsavedEpochsOf(testWorld, "workspace-1"),
            placeholder,
          };
        }),
      {
        captured: memory,
        logs,
        hotWorkspacesLayer: clock.poolLayer,
        wrapCaptureChannel: clock.wrapCaptureChannel,
        drainPolicy: drain,
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            stops,
            replan,
            captureStatus: () => Effect.sync(statusAnswer),
            // A checkpoint's, or the stop's final: the person's write saved, or still pending.
            flush: () =>
              Effect.sync(() =>
                captureAnswer({
                  ...stamped(claimEpoch),
                  ...(finalSaves
                    ? { pending: 0, registered: 1, headN: 1 }
                    : { pending: 1, pendingBytes: 2_048 }),
                }),
              ),
          },
        }),
      },
    );
    if (result.outcome === null) throw new Error("the scenario did not finish");
    return result.outcome;
  });

describe("a status read during a claimed standby's re-plan (SLNT-1044)", () => {
  it.effect.each<EarlyWords>(["pending", "not-final"])(
    "a standby's %s answer from before its re-plan answered is not the session's: the stop saves and ends the executor",
    (early) =>
      Effect.gen(function* () {
        const outcome = yield* run({ hot: true, read: "before-replan", early, final: "saved" });
        expect(outcome.drainWords).toEqual([]);
        // The read hit the window: the standby answered under its placeholder, and Mend kept it as
        // received and said so. The row keeps it, as a row written before this rule does: the
        // stop reads saved over it all the same.
        expect(outcome.placeholder).not.toBeNull();
        expect(outcome.unsavedEpochs).toContain(outcome.placeholder);
        expect(outcome.placeholderWords).toHaveLength(1);
        expect(outcome.summary).toBeNull();
        expect(outcome.notSavedAt).toBeNull();
        expect(outcome.stops).toEqual(["drain"]);
      }),
    30_000,
  );

  it.effect.each<EarlyWords>(["pending", "not-final"])(
    "a session kept with the standby's %s answer in its evidence heals at the capture reaper's next pass, with no discard",
    (early) =>
      Effect.gen(function* () {
        const outcome = yield* run({
          hot: true,
          read: "before-replan",
          early,
          final: "kept-then-saves",
        });
        expect(outcome.unsavedEpochs).toContain(outcome.placeholder);
        expect(outcome.stops).toEqual(["drain"]);
      }),
    30_000,
  );

  it.effect(
    "control: the same read after the re-plan answered is under the claim's epoch, and the stop saves",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({
          hot: true,
          read: "after-launch",
          early: "pending",
          final: "saved",
        });
        expect(outcome.unsavedEpochs).not.toContain(outcome.placeholder);
        expect(outcome.placeholderWords).toEqual([]);
        expect(outcome.notSavedAt).toBeNull();
        expect(outcome.stops).toEqual(["drain"]);
      }),
    30_000,
  );

  it.effect(
    "control: a cold launch read after its launch saves at its stop",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({
          hot: false,
          read: "after-launch",
          early: "pending",
          final: "saved",
        });
        expect(outcome.placeholder).toBeNull();
        expect(outcome.notSavedAt).toBeNull();
        expect(outcome.stops).toEqual(["drain"]);
      }),
    30_000,
  );

  it.effect.each<EarlyWords>(["pending", "not-final"])(
    "control: work under the claim's epoch the final flush did not save still reads not saved and keeps the workspace, beside the standby's %s answer",
    (early) =>
      Effect.gen(function* () {
        const outcome = yield* run({ hot: true, read: "before-replan", early, final: "unsaved" });
        expect(outcome.unsavedEpochs).toContain(outcome.placeholder);
        expect(outcome.notSavedAt).not.toBeNull();
        expect(outcome.stops).toEqual([]);
      }),
    30_000,
  );
});
