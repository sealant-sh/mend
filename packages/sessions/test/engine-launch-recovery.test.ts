import { CaptureStoreRepo } from "@mend/db";
import {
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Session, SessionProcess, SessionRun, captureStatusLine } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  SealantPlatformError,
  SealantPrincipal,
  toPlatformError,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import { type CaptureCompletionSeal, SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { type CreateOptions, SealantError } from "@sealant/sdk";
import { Clock, Duration, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { makeLaunchClock } from "./engine-launch-recovery-fixtures.ts";
import {
  CUSTOM_BASE,
  flushReport,
  launchOnce,
  lifecycleLayer,
  memorySeals,
  provisionIn,
  seedStoppedBeforeRestart,
  shipHarnessCapture,
} from "./engine/capture-fixture.ts";
import {
  now,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/** A create the platform took and whose answer never came back. */
const lostAnswer = () =>
  Effect.fail(
    new SealantPlatformError({
      code: "control_plane_unavailable",
      status: 503,
      message: "the control plane did not answer",
      cause: null,
    }),
  );

/**
 * RC 3 (2026-10-11): an image build that failed launches no executor. Core reports the
 * workspace `failed`, with no runtime and no drain, and refused every stop of it as "still
 * launching". Read as kept, the drain asked that stop forever, and the session read
 * `stopping · saving` until the machine was wiped.
 */
const buildFailed = () =>
  Effect.fail(
    toPlatformError(
      new SealantError(
        "The image build for workspace workspace-1 reported no progress for 12 min; it was at step 4/4.",
        { code: "workspace_image_build_stalled" },
      ),
    ),
  );

/** The store, with every lease release waking `untilChanged` (the lease is mutated in place). */
const releasing = (memory: MemoryCaptureStore, changed: () => void): MemoryCaptureStore => ({
  ...memory,
  layer: Layer.effect(
    CaptureStoreRepo,
    Effect.map(CaptureStoreRepo, (inner) => ({
      ...inner,
      release: (worktreeId, epoch) =>
        inner.release(worktreeId, epoch).pipe(Effect.tap(() => Effect.sync(changed))),
    })),
  ).pipe(Layer.provide(memory.layer)),
});

describe("SessionEngine against the Docker e2e run 5 (2026-09-28)", () => {
  it.effect(
    "an executor that ended on its runtime and that the platform keeps is not dead: its lease and its token stay, and it reads `not saved · executor kept for recovery`",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const tokenEvents: Array<string> = [];
        const stops: Array<"drain" | "discard"> = [];
        const clock = yield* makeLaunchClock;
        let killed = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
              // `docker kill`: the container is gone, Core marks the workspace failed and keeps
              // it for recovery; the heartbeat stops and the lease lapses.
              killed = true;
              const afterExpiry = Date.now() + 1_000_000;
              memory.clock.now = () => afterExpiry;
              yield* engine.reapCaptureLeases();
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept executor",
              );
              const kept = world.sessions.get(session.id);
              expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
                "not saved · executor kept for recovery · exited before its final flush completed · 0 pending",
              );
              // Nothing released and nothing revoked: Core's recovery boot plans and ships with it.
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              expect(tokenEvents.filter((event) => event.startsWith("revoke"))).toEqual([]);
              expect(tokenEvents).toContain(`issue:${launch}`);
              expect(stops.length).toBeGreaterThan(0);
              // Nothing else was started over it.
              expect(created).toHaveLength(1);
            }),
          {
            captured: memory,
            tokenEvents,
            drainPolicy: { terminationWait: Duration.millis(200) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stops,
                status: () => (killed ? "failed" : "ready"),
                stopAnswer: () => "kept",
                retained: () => ({
                  reason: "exited before its final flush completed",
                  recoverable: true,
                }),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "the owner's discard of a kept executor is asked of the platform, never read from its status",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const stops: Array<"drain" | "discard"> = [];
        const tokenEvents: Array<string> = [];
        const clock = yield* makeLaunchClock;
        let killed = false;
        let discarding = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              killed = true;
              const afterExpiry = Date.now() + 1_000_000;
              memory.clock.now = () => afterExpiry;
              yield* engine.reapCaptureLeases();
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept executor",
              );
              expect(tokenEvents.some((event) => event.startsWith("revoke"))).toBe(false);
              discarding = true;
              yield* engine.discardUnsavedAndStop(session.id, "owner@example.com");
              expect(stops).toContain("discard");
              expect(tokenEvents.some((event) => event.startsWith("revoke"))).toBe(true);
            }),
          {
            captured: memory,
            tokenEvents,
            drainPolicy: { terminationWait: Duration.millis(200) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stops,
                status: (stopAsked) => (!killed ? "ready" : stopAsked ? "stopped" : "failed"),
                stopAnswer: (discard) => (discard ? "stopped" : "kept"),
                // Retained until the owner discards: then the platform ends it.
                retained: () =>
                  discarding
                    ? null
                    : { reason: "exited before its final flush completed", recoverable: true },
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a final flush the executor runs on its own (a `docker stop`) reads `stopping · saving`, not `running`",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        let ending = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              ending = true;
              yield* engine.refreshCaptureStatus(session.id);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureDrain === "stop",
                "the stop drain",
              );
              const stopping = world.sessions.get(session.id);
              expect(stopping?.status).toBe("stopping");
              expect(stopping === undefined ? null : captureStatusLine(stopping)).toMatch(
                /^saving/,
              );
            }),
          {
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                // The executor's own final flush is still running; nothing answers complete yet.
                finalCompletion: "unreported",
                flush: () =>
                  Effect.succeed({
                    ...flushReport(1, 1),
                    complete: false,
                    incompleteReason: "in-progress",
                  }),
                captureStatus: () =>
                  Effect.succeed(
                    ending
                      ? { ...flushReport(1, 1), complete: false, incompleteReason: "in-progress" }
                      : flushReport(0, 1),
                  ),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a runtime that is not ready (a launch whose worker died after it started) is kept and looked at on the kept backoff, never flushed every poll",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const kinds: CaptureFlushKind[] = [];
        const clock = yield* makeLaunchClock;
        let pending = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              pending = true;
              yield* engine.stop(session.id);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept drain",
              );
              // The kept drain's next look is on its backoff (`keptRetryFirst`, 10 s): 200 ms of
              // polls pass with no FINAL asked.
              yield* TestClock.adjust(Duration.millis(200));
              expect(kinds.filter((kind) => kind === "final")).toEqual([]);
              const kept = world.sessions.get(session.id);
              expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
                "not saved · executor not ready · running · 0 pending · workspace kept",
              );
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds,
                status: () => (pending ? "running" : "ready"),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine idempotent executor creates (Core's next SDK, 2026-09-28)", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const layerWith = (
    created: Array<CreateOptions>,
    captureOps: Parameters<typeof sealantLaunchLayer>[11],
    createOverride?: Parameters<typeof sealantLaunchLayer>[8],
  ) =>
    sealantLaunchLayer(
      created,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createOverride,
      undefined,
      undefined,
      captureOps,
    );

  it(
    "every executor is created under a key written on the row before the create is asked; its answer clears it and names the runtime",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const createKeys: Array<string | undefined> = [];
      const onRowAtCreate: Array<string | undefined> = [];
      let worldRef: World | null = null;
      let sessionRef: SessionId | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            worldRef = world;
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionRef = session.id;
            yield* engine.launch(session.id, ["codex"]);
            expect(createKeys).toHaveLength(1);
            expect(createKeys[0]).toMatch(new RegExp(`^launch:${session.id}:\\d+:`));
            expect(onRowAtCreate).toEqual(createKeys);
            expect(world.executorCreates.has(session.id)).toBe(false);
            expect(world.executorResources.get(session.id)?.resourceId).toBe("container-1");
          }),
        {
          captured: memory,
          sealantLayer: layerWith(created, {
            createKeys,
            resourceId: () => "container-1",
            findByKey: () => ({ kind: "none" }),
            beforeCreate: () =>
              Effect.sync(() => {
                if (worldRef !== null && sessionRef !== null) {
                  onRowAtCreate.push(worldRef.executorCreates.get(sessionRef));
                }
              }),
          }),
        },
      );
    },
  );

  it.effect(
    "a create whose answer was lost finds the executor it made by its key: on the row, draining, holding the worktree",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        const stops = clock.watched<"drain" | "discard">();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              expect(failed._tag).toBe("SealantPlatformError");
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(world.executorCreates.has(session.id)).toBe(false);
              yield* clock.untilChanged(() => stops.length > 0, "the drain's stop");
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            }),
          {
            captured: memory,
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: layerWith(
              created,
              {
                stops,
                stopAnswer: () => "kept",
                status: () => "ready",
                findByKey: () => ({ kind: "found", workspaceId: "workspace-1" }),
              },
              lostAnswer,
            ),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a launch whose image build failed ends `failed` with its reason, asks no stop and frees the worktree: no executor ever ran",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        const stops: Array<"drain" | "discard"> = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              yield* clock.untilChanged(
                () => memory.leases.get(session.worktreeId)?.executorId === null,
                "the worktree freed",
              );
              const read = world.sessions.get(session.id);
              expect(read?.status).toBe("failed");
              expect(read?.settledAt).not.toBeNull();
              expect(read?.summary ?? "").toContain("reported no progress");
              expect(read?.captureDrain ?? null).toBeNull();
              expect(stops).toEqual([]);
            }),
          {
            captured: releasing(memory, clock.changed),
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: layerWith(
              created,
              {
                stops,
                status: () => "failed",
                launchedRuntime: () => "never",
                findByKey: () => ({ kind: "found", workspaceId: "workspace-1" }),
              },
              buildFailed,
            ),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a failed workspace whose executor ran is still kept for what its disk may hold",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        const stops = clock.watched<"drain" | "discard">();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              yield* clock.untilChanged(() => stops.length > 0, "the drain's stop");
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: layerWith(
              created,
              {
                stops,
                stopAnswer: () => "kept",
                status: () => "failed",
                launchedRuntime: () => "launched",
                findByKey: () => ({ kind: "found", workspaceId: "workspace-1" }),
              },
              buildFailed,
            ),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it(
    "a create whose answer was lost, whose key found nothing and that Core fenced made no executor: the key clears and the worktree is free",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const fenced: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(fenced).toHaveLength(1);
            expect(world.executorCreates.has(session.id)).toBe(false);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([]);
          }),
        {
          captured: memory,
          sealantLayer: layerWith(
            created,
            {
              findByKey: () => ({ kind: "none" }),
              fenceCreate: (key) => {
                fenced.push(key);
                return { kind: "cancelled" };
              },
            },
            lostAnswer,
          ),
        },
      );
    },
  );

  it(
    "review 3 #21 a lookup that finds nothing is not proof: without Core's fence the key stays reserved and the worktree held; the next launch asks the same create again under it",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const createKeys: Array<string | undefined> = [];
      let lose = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            const original = world.executorCreates.get(session.id);
            expect(original).toBeDefined();
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            // The reaper looks again: still nothing on record, still reserved.
            yield* engine.reapCaptureLeases();
            expect(world.executorCreates.get(session.id)).toBe(original);
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([
              { sessionId: session.id, kind: "lease" },
            ]);
            // The next launch asks the very same create: one launch, one executor, whichever
            // request the platform commits.
            lose = false;
            yield* engine.launch(session.id, ["codex"]);
            expect(createKeys).toEqual([original, original]);
            expect(world.executorLaunches.get(session.id)?.launchId).toBe(original);
            expect(world.executorCreates.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          sealantLayer: layerWith(created, {
            createKeys,
            findByKey: () => ({ kind: "none" }),
            loseCreateAnswer: () => lose,
          }),
        },
      );
    },
  );

  it(
    "review 4 #14 a reserved create asked again after its claim lapsed keeps the original epoch: the delayed original executor, planned under it, is never fenced",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const createKeys: Array<string | undefined> = [];
      let lose = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            const original = world.executorCreates.get(session.id);
            if (original === undefined) throw new Error("no reserved create");
            const originalEpoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            // The original create commits late, after the lookup found nothing: its executor
            // boots with its own launch's token and plans under the launch's claim.
            const executor = servedSocketApis.get(session.id)?.captureAs?.(original);
            if (executor === undefined) throw new Error("no launch-bound capture routes");
            const plan = yield* executor.planGet({ worktree_id: null, epoch: 0 });
            expect(plan.epoch).toBe(originalEpoch);
            expect(plan.executor).toBe(original);
            // Its claim lapses before its first heartbeat (a slow boot), and the next launch asks
            // the very same create again.
            const later = Date.now() + 1_000_000;
            memory.clock.now = () => later;
            lose = false;
            yield* engine.launch(session.id, ["codex"]);
            expect(createKeys).toEqual([original, original]);
            // Ownership was never resolved: the same launch, the same epoch, renewed.
            expect(memory.leases.get(session.worktreeId)?.epoch).toBe(originalEpoch);
            expect(memory.leases.get(session.worktreeId)?.launchId).toBe(original);
            const beat = yield* executor.heartbeat({
              worktree_id: session.worktreeId,
              epoch: originalEpoch,
            });
            expect(beat.expires_in_secs).toBeGreaterThan(0);
            expect(world.executorLaunches.get(session.id)?.launchId).toBe(original);
          }),
        {
          captured: memory,
          sealantLayer: layerWith(created, {
            createKeys,
            findByKey: () => ({ kind: "none" }),
            loseCreateAnswer: () => lose,
          }),
        },
      );
    },
  );

  it(
    "review 3 #21 a lookup answer Mend does not read is unknown, never none: the key and the lease stay",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const fenced: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(fenced).toEqual([]);
            expect(world.executorCreates.has(session.id)).toBe(true);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          sealantLayer: layerWith(
            created,
            {
              findByKey: () => ({ kind: "unknown", detail: "object with workspace" }),
              fenceCreate: (key) => {
                fenced.push(key);
                return { kind: "cancelled" };
              },
            },
            lostAnswer,
          ),
        },
      );
    },
  );

  it(
    "on SDK 0.37.2 (no key lookup) a lost create answer leaves ownership unresolved: the lease, the key and the row stay",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(world.executorCreates.has(session.id)).toBe(true);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            yield* engine.reapCaptureLeases();
            expect(world.executorCreates.has(session.id)).toBe(true);
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([
              { sessionId: session.id, kind: "lease" },
            ]);
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
          }),
        { captured: memory, sealantLayer: layerWith(created, {}, lostAnswer) },
      );
    },
  );

  it(
    "review 3 #5 a create whose answer was lost holds even its own session's relaunch: no new key, no new epoch, the old epoch still heartbeats",
    { timeout: 20_000 },
    async () => {
      const memory = makeMemoryCaptureStore();
      const keys: Array<string | undefined> = [];
      const created: Array<CreateOptions> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            const originalKey = world.executorCreates.get(session.id);
            const originalEpoch = memory.leases.get(session.worktreeId)?.epoch;
            expect(originalKey).toBeDefined();
            // The executor exists, its create answer was lost and its heartbeat is partitioned.
            const afterExpiry = Date.now() + 1_000_000;
            memory.clock.now = () => afterExpiry;
            const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect("code" in refused ? refused.code : null).toBe("executor_create_unresolved");
            expect(keys).toEqual([originalKey]);
            expect(world.executorCreates.get(session.id)).toBe(originalKey);
            expect(memory.leases.get(session.worktreeId)?.epoch).toBe(originalEpoch);
            const canStillHeartbeat = yield* Effect.gen(function* () {
              const repo = yield* CaptureStoreRepo;
              return yield* repo.heartbeat(session.worktreeId, originalEpoch ?? 0, 30);
            }).pipe(Effect.provide(memory.layer));
            expect(canStillHeartbeat).toBe(true);
          }),
        {
          captured: memory,
          sealantLayer: layerWith(created, { createKeys: keys }, lostAnswer),
        },
      );
    },
  );

  it(
    "review 3 #5 the relaunch reconciles the key first: the executor it finds is drained like any, and kept, nothing else starts",
    { timeout: 20_000 },
    async () => {
      const memory = makeMemoryCaptureStore();
      const keys: Array<string | undefined> = [];
      const created: Array<CreateOptions> = [];
      const stops: Array<"drain" | "discard"> = [];
      let lose = true;
      let found = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            const originalKey = world.executorCreates.get(session.id);
            lose = false;
            found = true;
            const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect("code" in refused ? refused.code : null).toBe("capture_not_saved");
            // The executor the key made is the session's, under that key as its launch.
            expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
            expect(world.executorLaunches.get(session.id)?.launchId).toBe(originalKey);
            expect(stops.length).toBeGreaterThan(0);
            expect(keys).toEqual([originalKey]);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.millis(300) },
          sealantLayer: layerWith(created, {
            createKeys: keys,
            stops,
            stopAnswer: () => "kept",
            status: () => "ready",
            retained: () => ({ reason: "not confirmed saved", recoverable: true }),
            loseCreateAnswer: () => lose,
            findByKey: () =>
              found ? { kind: "found", workspaceId: "workspace-1" } : { kind: "unsupported" },
          }),
        },
      );
    },
  );

  it(
    "a refused create (4xx) made nothing: the key clears and the claim is released at once",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(world.executorCreates.has(session.id)).toBe(false);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
          }),
        {
          captured: memory,
          sealantLayer: layerWith(created, {}, () =>
            Effect.fail(
              new SealantPlatformError({
                code: "workspace-docker-unsupported",
                status: 422,
                message: "refused",
                cause: null,
              }),
            ),
          ),
        },
      );
    },
  );

  it.effect(
    "after a restart mid-create, the reaper finds the executor by the key on the row and drains it",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        const stops = clock.watched<"drain" | "discard">();
        const looked: string[] = [];
        /**
         * When the create was asked, as its key says: the key carries an epoch time the engine
         * reads back as `executorStartedAt`, which is what this case checks, so the clock is set a
         * minute after it rather than the key built from a clock at 1970. (`setTime` settles
         * Effect's one-shot unadvanced-clock warning; the engine fixture settles it for every
         * engine case anyway and keeps the test's own sleeps guarded: nothing is lost here.)
         */
        const createAskedAt = 1790000000000;
        yield* withPreparedEngineEffect(
          (world, tmp) =>
            TestClock.setTime(createAskedAt + 60_000).pipe(Effect.andThen(setup(tmp, world))),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              // The crash point: the claim and the key are durable; the create's answer is not.
              yield* Effect.gen(function* () {
                const repo = yield* CaptureStoreRepo;
                yield* repo.init(session.worktreeId);
                yield* repo.claim(session.worktreeId, session.id, 30);
              }).pipe(Effect.provide(memory.layer));
              const key = `launch:${session.id}:${createAskedAt}:nonce`;
              world.executorCreates.set(session.id, key);
              yield* engine.reapCaptureLeases();
              expect(looked).toEqual([key]);
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(world.sessions.get(session.id)?.executorStartedAt?.getTime()).toBe(
                1790000000000,
              );
              yield* clock.untilChanged(() => stops.length > 0, "the drain's stop");
              expect(world.executorResources.get(session.id)?.resourceId).toBe("vm-7");
            }),
          {
            captured: memory,
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: layerWith(created, {
              stops,
              stopAnswer: () => "kept",
              status: () => "ready",
              resourceId: () => "vm-7",
              findByKey: (key) => {
                looked.push(key);
                return { kind: "found", workspaceId: "workspace-1" };
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine status words after end-to-end run 9", () => {
  it.effect(
    "RD: a failed launch whose kept executor the platform ends after it sealed reads `launch failed: … · saved at … · capture n`, not the launch's words alone",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const clock = yield* makeLaunchClock;
        let recovered = false;
        /** Records the executor's seal: the recovery boot's FINAL, landing while Core ends it. */
        let sealOnStop: (() => void) | null = null;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain kept",
              );
              expect(world.sessions.get(session.id)?.summary).toMatch(/^launch failed: /);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const built = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                crypto.randomUUID(),
                "final",
              );
              const sealedAt = new Date((yield* Clock.currentTimeMillis) + 1_000);
              sealOnStop = () => {
                records.set(`${session.worktreeId}:${epoch}`, {
                  worktreeId: session.worktreeId,
                  epoch,
                  executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                  captureId: built.id,
                  n: built.manifest.n,
                  sealedAt,
                });
              };
              // Core retained it and boots it for recovery; the next stop ends it.
              recovered = true;
              for (let round = 0; round < 50; round += 1) {
                if (world.sessions.get(session.id)?.summary?.includes("saved at ") === true) break;
                yield* engine.reapCaptureLeases();
                // The kept drain's backoff (`keptRetryFirst`, 100 ms) runs out before the next look.
                yield* TestClock.adjust(Duration.millis(100));
              }
              // The stop that ended it attested nothing: the seal landed after it was sent.
              expect(records.size).toBe(1);
              expect(stopOptions.some((o) => o?.completion !== undefined)).toBe(false);
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toBe(
                `launch failed: setup command failed (exit 1): exit 1 · saved at ${sealedAt.toISOString().slice(11, 19)} UTC · capture ${built.manifest.n}`,
              );
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            drainPolicy: {
              stallSeconds: 0,
              terminationWait: Duration.millis(500),
              keptRetryFirst: Duration.millis(100),
              keptRetryMax: Duration.millis(200),
            },
            workspaceImage: { ...CUSTOM_BASE, setupCommands: ["exit 1"] },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopOptions,
                status: (stopAsked) => (!recovered ? "ready" : stopAsked ? "stopped" : "failed"),
                stopAnswer: () => {
                  if (!recovered) return "kept";
                  sealOnStop?.();
                  return "requested";
                },
                exec: (argv) =>
                  argv.includes("exit 1") ? { exitCode: 1, stdout: "", stderr: "" } : undefined,
                flush: () =>
                  Effect.fail(
                    new SealantPlatformError({
                      code: "connection_closed",
                      status: null,
                      message: "the executor did not answer",
                      cause: null,
                    }),
                  ),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "D9: a session Mend stopped because its executor ran a final flush of its own reads `stopped outside Mend · saved at … · capture n` once saved, as its siblings do; the owner's Stop still reads a bare `stopped`",
    () =>
      Effect.gen(function* () {
        const clock = yield* makeLaunchClock;
        for (const who of ["executor", "owner"] as const) {
          const created: Array<CreateOptions> = [];
          const memory = makeMemoryCaptureStore();
          let ending = false;
          /** Where the executor answered, in its own order: its FINAL after its status. */
          let stamp: ((observation: number) => object) | null = null;
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, _tmp, project) =>
              Effect.gen(function* () {
                const { engine, session } = yield* provisionIn(project);
                yield* engine.launch(session.id, ["codex"]);
                const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
                const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
                stamp = (observation) => ({
                  epoch,
                  origin: {
                    epoch,
                    launch,
                    bootId: "boot-1",
                    bootGeneration: 1,
                    observation,
                    headN: 1,
                  },
                });
                if (who === "executor") {
                  ending = true;
                  yield* engine.refreshCaptureStatus(session.id);
                } else {
                  yield* engine.stop(session.id);
                }
                yield* clock.untilChanged(
                  () =>
                    world.sessions.get(session.id)?.status === "stopped" &&
                    world.sessions.get(session.id)?.captureDrain === null,
                  `the saved end (${who}: ${JSON.stringify([world.sessions.get(session.id)?.status, world.sessions.get(session.id)?.captureDrain, world.sessions.get(session.id)?.summary])})`,
                );
                const summary = world.sessions.get(session.id)?.summary ?? null;
                if (who === "executor") {
                  expect(summary).toMatch(
                    /^stopped outside Mend · saved at \d\d:\d\d:\d\d UTC( · capture \d+)?$/,
                  );
                } else {
                  expect(summary).toBeNull();
                }
              }),
            {
              captured: memory,
              sealantLayer: lifecycleLayer(created, {
                captureOps: {
                  stopAnswer: () => "stopped",
                  // The executor's own final flush is under way; Mend's FINAL then completes.
                  captureStatus: () =>
                    Effect.succeed(
                      ending
                        ? {
                            ...flushReport(1, 1),
                            ...stamp?.(1),
                            complete: false,
                            incompleteReason: "in-progress",
                          }
                        : { ...flushReport(0, 1), ...stamp?.(1) },
                    ),
                  flush: () => Effect.succeed({ ...flushReport(0, 1), ...stamp?.(2) }),
                },
              }),
              prepareWorld: clock.prepareWorld,
            },
          );
        }
      }),
    { timeout: 20_000 },
  );
});

/**
 * Review 2026-09-28 (19) #2: the reaper that recovers a create whose answer was lost drains the
 * executor it finds and settles the session `launch interrupted · … · its executor ended`. After a
 * saved final flush Core can take the stop and still report the executor (`requested`, status
 * `ready` past Mend's wait): the drain returned the same outcome as an observed end, and the session
 * read ended while nothing had been seen to end. The reviewer's probe, kept whole: the end never
 * observed (the session reads `stopping · … · stop requested · end not observed yet`, the row and
 * lease stay), observed at once (settled as ended), and observed later (the next reaper pass
 * settles it as ended).
 */
describe("review 19 #2: a lost create's executor reads ended only once its end is observed", () => {
  for (const end of ["never", "at once", "later"] as const) {
    it.effect(
      `AUDIT R19 lost-create recovery only reports observed termination: end ${end}`,
      () =>
        Effect.gen(function* () {
          const memory = makeMemoryCaptureStore();
          const created: Array<CreateOptions> = [];
          const clock = yield* makeLaunchClock;
          const stops = clock.watched<"drain" | "discard">();
          const logs: Array<string> = [];
          let endSeen = end === "at once";
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, _tmp, project) =>
              Effect.gen(function* () {
                const { engine, session } = yield* provisionIn(project);
                const key = `launch:${session.id}:${yield* Clock.currentTimeMillis}:audit`;
                world.executorCreates.set(session.id, key);
                yield* Effect.gen(function* () {
                  const repo = yield* CaptureStoreRepo;
                  yield* repo.init(session.worktreeId);
                  yield* repo.claim(session.worktreeId, session.id, 30, key);
                }).pipe(Effect.provide(memory.layer));
                yield* engine.reapCaptureLeases();
                yield* clock.untilChanged(() => stops.length > 0, "Core stop requested");
                if (end === "at once") {
                  yield* clock.untilChanged(
                    () => world.sessions.get(session.id)?.settledAt !== null,
                    "settled once the end was observed",
                  );
                  const after = world.sessions.get(session.id);
                  expect(after?.status).toBe("stopped");
                  expect(after?.summary).toBe(
                    "launch interrupted · the create's answer was lost · its executor ended",
                  );
                  return;
                }
                // Core reports the executor `ready` through Mend's whole wait for its end
                // (`terminationWait`, 150 ms): nothing is said until that wait runs out.
                yield* TestClock.adjust(Duration.millis(149));
                expect(world.sessions.get(session.id)?.status).not.toBe("stopping");
                yield* TestClock.adjust(Duration.millis(1));
                yield* clock.untilChanged(
                  () => world.sessions.get(session.id)?.status === "stopping",
                  "stopping while the end is not observed",
                );
                const pending = world.sessions.get(session.id);
                expect(pending?.settledAt, "Core still reports ready: no end observed").toBeNull();
                expect(pending?.summary).toBe(
                  "launch interrupted · the create's answer was lost · stop requested · end not observed yet",
                );
                expect(pending?.captureDrain).toBeNull();
                expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
                expect(logs.some((line) => line.includes("its executor ended"))).toBe(false);
                if (end === "never") {
                  // Another pass changes nothing while Core still reports the executor.
                  yield* engine.reapCaptureLeases();
                  expect(world.sessions.get(session.id)?.settledAt).toBeNull();
                  expect(world.sessions.get(session.id)?.summary).toBe(pending?.summary);
                  expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
                  expect(world.sessions.has(session.id)).toBe(true);
                  return;
                }
                endSeen = true;
                yield* engine.reapCaptureLeases();
                const after = world.sessions.get(session.id);
                expect(after?.status).toBe("stopped");
                expect(after?.settledAt).not.toBeNull();
                expect(after?.summary).toBe(
                  "launch interrupted · the create's answer was lost · its executor ended",
                );
              }),
            {
              captured: memory,
              logs,
              prepareWorld: clock.prepareWorld,
              drainPolicy: {
                terminationWait: Duration.millis(150),
                pollInterval: Duration.millis(10),
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
                  findByKey: () => ({ kind: "found", workspaceId: "workspace-1" }),
                  status: (stopAsked) => (endSeen && stopAsked ? "stopped" : "ready"),
                  stopAnswer: () => "requested",
                  stops,
                  flush: () => Effect.succeed(flushReport(0, 1, { headN: 7 })),
                },
              ),
            },
          );
        }),
      { timeout: 20_000 },
    );
  }
});

/** The session's agent process, ended in the world as if its end was never recorded. */
const endAgentInWorld = (world: World, sessionId: SessionId, exitCode: number | null) => {
  const agent = [...world.processes.values()].find(
    (process) => process.sessionId === sessionId && process.kind === "agent-pty",
  );
  if (agent === undefined) throw new Error("no agent process");
  world.processes.set(
    agent.id,
    new SessionProcess({
      ...agent,
      status: "exited",
      exitCode,
      exitedAt: now(),
      updatedAt: now(),
    }),
  );
};

/** A session's runs, in launch order. */
const runsOf = (world: World, sessionId: SessionId) =>
  [...world.sessionRuns.values()]
    .filter((run) => run.sessionId === sessionId)
    .toSorted((left, right) => left.ordinal - right.ordinal);

/** How many times the engine said it settled a run left open under a settled session. */
const staleRunsSaid = (logs: ReadonlyArray<string>) =>
  logs.filter((line) => line.includes("a run left open under a settled session")).length;

/**
 * A settled session with one run still `running`, as the owner's box had it. `runCreatedAt` after
 * `settledAt` is the next launch's run, recorded before its reopen was written.
 */
const seedSettledWithOpenRun = (
  world: World,
  input: {
    readonly sessionId: SessionId;
    readonly runId: SealantRunId;
    readonly summary: string;
    readonly settledAt: Date;
    readonly runCreatedAt: Date;
  },
) => {
  const { sessionId, runId } = input;
  world.sessions.set(
    sessionId,
    new Session({
      id: sessionId,
      projectId: ProjectId.make("project-run-left-open"),
      worktreeId: WorktreeId.make(`wt-${sessionId}`),
      harness: "claude",
      providerSessionId: null,
      label: null,
      worktree: `session-${sessionId}`,
      branch: `mend/session-${sessionId}`,
      baseSha: Sha.make("0000000000000000000000000000000000000000"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: runId,
      sealantWorkspaceId: null,
      sealantSessionId: null,
      workspaceExpiresAt: null,
      workspaceTtlRenewedAt: null,
      workspaceTtlRenewalFailedAt: null,
      workspaceTtlRenewalError: null,
      workspaceImage: null,
      dotfiles: null,
      ownerUserId: "user-fixture",
      hasTranscript: true,
      status: "failed",
      summary: input.summary,
      lastSeenSequence: 0n,
      recordHistoryComplete: false,
      startedAt: input.settledAt,
      settledAt: input.settledAt,
      createdAt: input.settledAt,
      updatedAt: input.settledAt,
    }),
  );
  world.sessionRuns.set(
    runId,
    new SessionRun({
      sealantRunId: runId,
      sessionId,
      ordinal: 1,
      harness: "claude",
      sealantWorkspaceId: SealantWorkspaceId.make(`workspace-${runId}`),
      sealantSessionId: `pty-${runId}`,
      status: "running",
      summary: null,
      lastSeenSequence: 0n,
      environmentRevision: null,
      environmentVariableNames: null,
      secretRevision: null,
      secretNames: null,
      clusterBindingRevision: null,
      clusterBindingNames: null,
      clusterServiceAccount: null,
      startedAt: input.runCreatedAt,
      settledAt: null,
      createdAt: input.runCreatedAt,
      updatedAt: input.runCreatedAt,
    }),
  );
};

describe("SessionEngine a session and its run settle together (2026-10-03)", () => {
  // Observed on the owner's box: a replacement launch that never reached its control socket was
  // settled by the leftover sweep (`failed · launch failed · the harness never started · saved at
  // 15:04:33 UTC · capture 36`) while its `session_runs` row stayed `running`, and every resume
  // after that met the one-active-run index as an unhandled 500.
  const LAUNCH_NEVER_RAN = "launch failed · the harness never started";

  it("a launch that fails settles the session and the run an earlier launch left open, with the same words", async () => {
    const created: Array<CreateOptions> = [];
    let loseCreate = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          const [first] = runsOf(world, session.id);
          expect(first?.status).toBe("running");
          // The agent ended and nothing recorded its end: the run stays open under a live row.
          endAgentInWorld(world, session.id, null);
          loseCreate = true;
          const error = yield* engine.resumeSession(session.id, "shell").pipe(Effect.flip);
          expect(error._tag).toBe("SealantPlatformError");
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.settledAt).not.toBeNull();
          expect(settled?.summary).toMatch(/^launch failed: /);
          const runs = runsOf(world, session.id);
          expect(runs).toHaveLength(1);
          expect(runs[0]?.status).toBe("failed");
          expect(runs[0]?.summary).toBe(settled?.summary);
          expect(runs[0]?.settledAt).not.toBeNull();
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
          undefined,
          undefined,
          undefined,
          { loseCreateAnswer: () => loseCreate },
        ),
      },
    );
  });

  it("startup and the reaper settle a run left `running` under a settled session with the session's words, once each; a run recorded after the settle is the next launch's and stays open", async () => {
    const summary = `${LAUNCH_NEVER_RAN} · saved at 15:04:33 UTC · capture 36`;
    const stale = {
      sessionId: SessionId.make(crypto.randomUUID()),
      runId: SealantRunId.make("run-stale"),
    };
    const next = {
      sessionId: SessionId.make(crypto.randomUUID()),
      runId: SealantRunId.make("run-next-launch"),
    };
    const later = {
      sessionId: SessionId.make(crypto.randomUUID()),
      runId: SealantRunId.make("run-stale-later"),
    };
    const logs: Array<string> = [];
    await withEngine(
      (world) =>
        Effect.gen(function* () {
          // Startup: the stale run reads as its session does.
          const staleRun = world.sessionRuns.get(stale.runId);
          expect(staleRun?.status).toBe("failed");
          expect(staleRun?.summary).toBe(summary);
          expect(staleRun?.settledAt).not.toBeNull();
          // The session itself is as it was: settled once, its words untouched.
          expect(world.sessions.get(stale.sessionId)?.status).toBe("failed");
          expect(world.sessions.get(stale.sessionId)?.summary).toBe(summary);
          // The run recorded after its session settled is a launch under way: left open.
          expect(world.sessionRuns.get(next.runId)?.status).toBe("running");
          expect(world.sessionRuns.get(next.runId)?.settledAt).toBeNull();
          expect(staleRunsSaid(logs)).toBe(1);

          // The reaper: a pair that became inconsistent since boot is settled on its tick, said
          // once, and the next tick has nothing left to say.
          const engine = yield* SessionEngine;
          const settledAt = new Date();
          seedSettledWithOpenRun(world, {
            ...later,
            summary: "executor lost · lease expired",
            settledAt,
            runCreatedAt: new Date(settledAt.getTime() - 60_000),
          });
          yield* engine.reapCaptureLeases();
          expect(world.sessionRuns.get(later.runId)?.status).toBe("failed");
          expect(world.sessionRuns.get(later.runId)?.summary).toBe("executor lost · lease expired");
          expect(staleRunsSaid(logs)).toBe(2);
          yield* engine.reapCaptureLeases();
          expect(staleRunsSaid(logs)).toBe(2);
          expect(world.sessionRuns.get(next.runId)?.status).toBe("running");
        }),
      {
        logs,
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => {
          const settledAt = now();
          seedSettledWithOpenRun(world, {
            ...stale,
            summary,
            settledAt,
            runCreatedAt: new Date(settledAt.getTime() - 60_000),
          });
          seedSettledWithOpenRun(world, {
            ...next,
            summary,
            settledAt,
            runCreatedAt: new Date(settledAt.getTime() + 1_000),
          });
        },
      },
    );
  });

  it("an attached run with no process row is live work: a second attach is refused in the log, and the first run is never settled", async () => {
    const created: Array<CreateOptions> = [];
    const logs: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const first = SealantRunId.make("attached-run-1");
          const second = SealantRunId.make("attached-run-2");
          yield* engine.attachRun(session.id, first, SealantWorkspaceId.make("workspace-1"));
          yield* engine.attachRun(session.id, second, SealantWorkspaceId.make("workspace-1"));
          const runs = runsOf(world, session.id);
          expect(runs.map((run) => [run.sealantRunId, run.status])).toEqual([[first, "running"]]);
          expect(world.sessions.get(session.id)?.sealantRunId).toBe(first);
          expect(logs.some((line) => line.includes("attached run not recorded"))).toBe(true);
        }),
      { logs, sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("a resume after a launch failure that left the run open succeeds: the stale run takes the session's words first", async () => {
    const created: Array<CreateOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          const [first] = runsOf(world, session.id);
          if (first === undefined) throw new Error("no run");
          // The owner's box: the session settled through a path that never reached its run.
          endAgentInWorld(world, session.id, null);
          const current = world.sessions.get(session.id);
          if (current === undefined) throw new Error("no session");
          world.sessions.set(
            session.id,
            new Session({
              ...current,
              status: "failed",
              summary: LAUNCH_NEVER_RAN,
              settledAt: now(),
            }),
          );
          expect(world.sessionRuns.get(first.sealantRunId)?.status).toBe("running");

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          const runs = runsOf(world, session.id);
          expect(runs.map((run) => run.status)).toEqual(["failed", "running"]);
          expect(runs[0]?.summary).toBe(LAUNCH_NEVER_RAN);
          expect(runs[0]?.settledAt).not.toBeNull();
          expect(runs[1]?.settledAt).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("a run insert the one-active index refuses settles the stale run from its process and asks once more; nothing live is settled", async () => {
    const created: Array<CreateOptions> = [];
    const logs: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          const [first] = runsOf(world, session.id);
          if (first === undefined) throw new Error("no run");
          // The agent exited 1 and nothing recorded it: the session still reads `running`, so
          // the resume's own look at the settled session finds nothing to settle, and the index
          // refuses the new run.
          endAgentInWorld(world, session.id, 1);

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          const runs = runsOf(world, session.id);
          expect(runs.map((run) => run.status)).toEqual(["failed", "running"]);
          expect(runs[0]?.summary).toBe("exited with code 1");
          expect(runs[0]?.settledAt).not.toBeNull();
          expect(
            logs.some((line) =>
              line.includes("a run left open settled before the next run of its session"),
            ),
          ).toBe(true);
          // The shell that just started is live and its run is open: a stop ends it as ever.
          yield* engine.stop(session.id);
          const afterStop = runsOf(world, session.id);
          expect(afterStop[1]?.status).toBe("stopped");
        }),
      { logs, sealantLayer: sealantLaunchLayer(created) },
    );
  });
});

const principalRequired = (
  inner: Layer.Layer<SealantClient>,
  seen: Array<string>,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      getWorkspace: (id) =>
        Effect.flatMap(SealantPrincipal, (principal) => {
          seen.push(principal.kind === "none" ? "none" : principal.userId);
          return principal.kind === "none"
            ? Effect.fail(
                new SealantPlatformError({
                  code: "NO_PRINCIPAL",
                  status: null,
                  message: "Sealant call made without a principal (docs/SEALANT-IDENTITY.md)",
                  cause: null,
                }),
              )
            : client.getWorkspace(id);
        }),
    })),
  ).pipe(Layer.provide(inner));

describe("SessionEngine startup never waits on an executor (2026-10-03)", () => {
  // Observed on the owner's box: 0.36.0-preview.13 was deployed over a running preview 11 forty
  // seconds after one session was stopped and resumed. The resume had reopened the row to
  // `running`, settled the old run and begun draining the old executor when the deploy killed the
  // process. The new process re-attached five live sessions, then went silent for four minutes
  // and was restarted by the bundle's health check: `resume` had folded that session and gone on
  // to drain its workspace inline, with no principal, so every lookup read `unknown` and the drain
  // idled until its ten-minute stall window. Nothing listened on 3101 meanwhile.
  const sessionId = SessionId.make("session-stopped-before-restart");
  const runId = SealantRunId.make("run-stopped-before-restart");
  const workspaceId = SealantWorkspaceId.make("workspace-1");

  it.effect(
    "finishes while a folded session's executor is still to be drained: the row settles inline, its tail runs forked as the owner",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const clock = yield* makeLaunchClock;
        const flushed = clock.watched<string>();
        const flushKinds = clock.watched<CaptureFlushKind>();
        const seen: Array<string> = [];
        const logs: Array<string> = [];
        const startedAt = Date.now();
        // A build that waits on the executor is the hang: its drain parks on the TestClock, which
        // the clock guard reports before this case's timeout ends it.
        yield* withPreparedEngineEffect(
          () => Effect.void,
          (world) =>
            Effect.gen(function* () {
              // The engine stands: the fold ran, and nothing waited on the executor.
              expect(Date.now() - startedAt).toBeLessThan(5_000);
              const settled = world.sessions.get(sessionId);
              expect(settled?.status).toBe("stopped");
              expect(settled?.settledAt).not.toBeNull();
              // The tail runs after the boot, as the owner: the executor is asked to flush, then
              // asked for its final flush by the drain, within moments — which a fiber with no
              // principal could never do, as it is refused the lookup that comes first.
              yield* clock.untilChanged(
                () => flushed.includes(`flush:${workspaceId}`) && flushKinds.includes("final"),
                "the forked tail drained the executor",
              );
              expect(seen.length).toBeGreaterThan(0);
              expect(seen.every((principal) => principal === "user-fixture")).toBe(true);
              // Nobody else swept it: the boot pass owns this session's tail.
              expect(logs.some((line) => line.includes("reaping leftover workspace"))).toBe(false);
            }),
          {
            logs,
            captured: makeMemoryCaptureStore(),
            prepareWorld: (world, tmp) =>
              seedStoppedBeforeRestart(world, tmp, {
                sessionId,
                runId,
                workspaceId,
                processLive: false,
              }),
            sealantLayer: principalRequired(
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
                { flushed, flushKinds },
              ),
              seen,
            ),
          },
        );
      }),
    10_000,
  );

  it.effect(
    "re-forks the watcher of a live agent process as the session's owner: its exit after the restart settles the session",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const seen: Array<string> = [];
        const clock = yield* makeLaunchClock;
        const { ptyStates } = clock;
        yield* withPreparedEngineEffect(
          () => Effect.void,
          (world) =>
            Effect.gen(function* () {
              expect(world.sessions.get(sessionId)?.settledAt).toBeNull();
              // The agent exits after the restart; the boot watcher polls its PTY every two
              // seconds.
              ptyStates.set("pty-1", { status: "exited", exitCode: 0, outputHighWater: 0n });
              yield* clock.nextLook(
                "pty-1",
                () => world.sessions.get(sessionId)?.settledAt == null,
              );
              yield* clock.untilChanged(() => {
                const session = world.sessions.get(sessionId);
                return session !== undefined && session.settledAt !== null;
              }, "the session settled on its agent's exit");
              const agent = world.processes.get("agent-boot");
              expect(agent).toBeDefined();
              expect(agent?.status).toBe("exited");
              expect(agent?.exitCode).toBe(0);
              expect(agent?.exitedAt).not.toBeNull();
              expect(seen.length).toBeGreaterThan(0);
              expect(seen.every((principal) => principal === "user-fixture")).toBe(true);
            }),
          {
            captured: makeMemoryCaptureStore(),
            prepareWorld: (world, tmp) => {
              clock.prepareWorld(world);
              seedStoppedBeforeRestart(world, tmp, {
                sessionId,
                runId,
                workspaceId,
                processLive: true,
              });
            },
            sealantLayer: principalRequired(
              sealantLaunchLayer(
                created,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                ptyStates,
                undefined,
                undefined,
                [],
              ),
              seen,
            ),
          },
        );
      }),
    15_000,
  );
});
