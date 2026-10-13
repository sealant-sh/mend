import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import {
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  Project,
  Session,
  SessionProcess,
  SessionRun,
  SkillWithFiles,
  captureStatusLine,
  noResumeLine,
} from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  SealantPlatformError,
  SealantPrincipal,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import {
  type CaptureCompletionSeal,
  SessionEngine,
  secretFilesDeliveredExec,
} from "@mend/sessions";
import { BlobStore, BlobStoreError, BlobStoreFsLive, captureKeys } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import type {
  CreateOptions,
  InteractiveSessionStatus,
  TimelineEntry,
  Workspace,
  WorkspaceCaptureReplanned,
} from "@sealant/sdk";
import { ConfigProvider, Deferred, Duration, Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";

import { installScript } from "../src/dependency-cache.ts";
import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import {
  CUSTOM_BASE,
  eventually,
  flushReport,
  isWarmup,
  launchOnce,
  lifecycleLayer,
  memoryHotPool,
  memorySeals,
  seedStoppedBeforeRestart,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import {
  captureAnswer,
  drawnLine,
  fakeExecRun,
  isPickupExec,
  launchSkill,
  now,
  redeemPickupExec,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  skillsForLaunchLayer,
  type World,
  withEngine,
} from "./engine/fixture.ts";

/** What the pickup writer does with what it redeemed: each file 0644, its directory 0755. */
const writePickedUp = (
  files: ReadonlyArray<{ readonly path: string; readonly base64: string }>,
  mapPath: (at: string) => string,
) => {
  for (const file of files) {
    const target = mapPath(file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, Buffer.from(file.base64, "base64"), { mode: 0o644 });
  }
};

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
    new SealantPlatformError({
      code: "workspace_image_build_stalled",
      status: null,
      message:
        "The image build for workspace workspace-1 reported no progress for 12 min; it was at step 4/4.",
      cause: null,
    }),
  );

describe("SessionEngine against the Docker e2e run 5 (2026-09-28)", () => {
  it(
    "an executor that ended on its runtime and that the platform keeps is not dead: its lease and its token stay, and it reads `not saved · executor kept for recovery`",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const tokenEvents: Array<string> = [];
      const stops: Array<"drain" | "discard"> = [];
      let killed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
            // `docker kill`: the container is gone, Core marks the workspace failed and keeps
            // it for recovery; the heartbeat stops and the lease lapses.
            killed = true;
            const afterExpiry = Date.now() + 1_000_000;
            memory.clock.now = () => afterExpiry;
            yield* engine.reapCaptureLeases();
            yield* until(
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
        },
      );
    },
  );

  it(
    "the owner's discard of a kept executor is asked of the platform, never read from its status",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stops: Array<"drain" | "discard"> = [];
      const tokenEvents: Array<string> = [];
      let killed = false;
      let discarding = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            killed = true;
            const afterExpiry = Date.now() + 1_000_000;
            memory.clock.now = () => afterExpiry;
            yield* engine.reapCaptureLeases();
            yield* until(
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
        },
      );
    },
  );

  it(
    "a final flush the executor runs on its own (a `docker stop`) reads `stopping · saving`, not `running`",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let ending = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            ending = true;
            yield* engine.refreshCaptureStatus(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the stop drain",
            );
            const stopping = world.sessions.get(session.id);
            expect(stopping?.status).toBe("stopping");
            expect(stopping === undefined ? null : captureStatusLine(stopping)).toMatch(/^saving/);
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
        },
      );
    },
  );

  it(
    "a runtime that is not ready (a launch whose worker died after it started) is kept and looked at on the kept backoff, never flushed every poll",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const kinds: CaptureFlushKind[] = [];
      let pending = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            pending = true;
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept drain",
            );
            yield* Effect.sleep(Duration.millis(200));
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
        },
      );
    },
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

  it(
    "a create whose answer was lost finds the executor it made by its key: on the row, draining, holding the worktree",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stops: Array<"drain" | "discard"> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(failed._tag).toBe("SealantPlatformError");
            expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
            expect(world.executorCreates.has(session.id)).toBe(false);
            yield* until(() => stops.length > 0, "the drain's stop");
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
        },
      );
    },
  );

  it(
    "a launch whose image build failed ends `failed` with its reason, asks no stop and frees the worktree: no executor ever ran",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stops: Array<"drain" | "discard"> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            yield* until(
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
          captured: memory,
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
        },
      );
    },
  );

  it(
    "a failed workspace whose executor ran is still kept for what its disk may hold",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stops: Array<"drain" | "discard"> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            yield* until(() => stops.length > 0, "the drain's stop");
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
        },
      );
    },
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

  it(
    "after a restart mid-create, the reaper finds the executor by the key on the row and drains it",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stops: Array<"drain" | "discard"> = [];
      const looked: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            // The crash point: the claim and the key are durable; the create's answer is not.
            yield* Effect.gen(function* () {
              const repo = yield* CaptureStoreRepo;
              yield* repo.init(session.worktreeId);
              yield* repo.claim(session.worktreeId, session.id, 30);
            }).pipe(Effect.provide(memory.layer));
            const key = `launch:${session.id}:1790000000000:nonce`;
            world.executorCreates.set(session.id, key);
            yield* engine.reapCaptureLeases();
            expect(looked).toEqual([key]);
            expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
            expect(world.sessions.get(session.id)?.executorStartedAt?.getTime()).toBe(
              1790000000000,
            );
            yield* until(() => stops.length > 0, "the drain's stop");
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
        },
      );
    },
  );
});

/** A dependency the setup's `npm ci` installs from a local tarball: no registry, no scripts. */
const npmProject = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r15-setup-"));
  const seed = path.join(root, "seed");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(seed);
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "review15-dep", version: "1.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), 'module.exports = "published baseline";\n');
  execFileSync("npm", ["pack", "--pack-destination", seed, "--ignore-scripts"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  fs.writeFileSync(
    path.join(seed, "package.json"),
    JSON.stringify({
      name: "review15-app",
      version: "1.0.0",
      dependencies: { "review15-dep": "file:review15-dep-1.0.0.tgz" },
    }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: seed,
    stdio: "pipe",
  });
  return { root, seed };
};

const NPM_CI = "npm ci --ignore-scripts --offline --no-audit --no-fund";

const DEP = "node_modules/review15-dep/index.js";

const PATCH = 'module.exports = "my debugging fix, not yet upstream";\n';

describe("custom-image setup commands run only on a worktree laid down fresh (review 2026-09-28 (15) #1)", () => {
  /** The executor registers a turn capture: the worktree's head moves past capture 0. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const registerTurnCapture = (
    memory: MemoryCaptureStore,
    tmp: string,
    session: Session,
    tree: string,
  ) =>
    Effect.gen(function* () {
      const api = servedSocketApis.get(session.id)?.capture;
      if (api === undefined) throw new Error("the session serves no capture api");
      const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
      const chain = memory.chains.get(session.worktreeId);
      const parent = chain?.headCapture ?? null;
      const n = (chain?.headN ?? 0) + 1;
      const snapshot = snapshotDirectory(tree, captureKeys(session.worktreeId, epoch), {
        chunkSize: 64,
      });
      const built = buildManifest({
        worktreeId: session.worktreeId,
        n,
        parent,
        epoch,
        seq: n * 10,
        kind: "turn",
        git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
        workspace: { root: snapshot.root, packs: snapshot.packs },
      });
      yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
        Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
      );
      const registered = yield* api.register({
        worktree_id: session.worktreeId,
        epoch,
        n,
        parent,
        capture_id: built.id,
        manifest_key: built.key,
        manifest: built.manifest,
      });
      expect(registered.head_n).toBe(n);
      return n;
    });

  it(
    "a cold resume restored from a saved capture runs no setup command: npm ci never overwrites the restored node_modules patch, the helper still installs, and the session line says why",
    { timeout: 60_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const { root, seed } = npmProject();
      const saved = path.join(root, "saved");
      let executorRoot = "";
      let setups = 0;
      const restoredReads: string[] = [];
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              yield* engine.launch(session.id, ["codex"]);
              // A worktree's first launch lays it down fresh (capture 0): its setup runs.
              expect(memory.chains.get(session.worktreeId)?.headN).toBe(0);
              expect(setups).toBe(1);
              expect(world.sessions.get(session.id)?.summary ?? "").not.toMatch(/setup skipped/);
              // The user patches a dependency; the executor captures it (n = 1).
              fs.writeFileSync(path.join(executorRoot, DEP), PATCH);
              const n = yield* registerTurnCapture(memory, tmp, session, executorRoot);
              fs.cpSync(executorRoot, saved, { recursive: true, preserveTimestamps: true });
              yield* engine.stop(session.id);
              yield* until(
                () =>
                  world.sessions.get(session.id)?.captureDrain === null &&
                  world.sessions.get(session.id)?.status === "stopped",
                "the saved stop",
              );
              const helperInstalls = execCalls.filter((argv) =>
                (argv[2] ?? "").includes("/usr/local/bin/mend"),
              ).length;

              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(created).toHaveLength(2);
              // The executor restored the patch; no setup command ran over it.
              expect(restoredReads.at(-1)).toBe(PATCH);
              expect(fs.readFileSync(path.join(executorRoot, DEP), "utf8")).toBe(PATCH);
              expect(setups).toBe(1);
              // The helper and the git transport still install: they never touch the worktree.
              expect(
                execCalls.filter((argv) => (argv[2] ?? "").includes("/usr/local/bin/mend")),
              ).toHaveLength(helperInstalls + 1);
              expect(resumed.status).toBe("running");
              expect(world.sessions.get(session.id)?.summary).toBe(
                `setup skipped · restored from capture ${n}`,
              );
            }),
          {
            captured: memory,
            workspaceImage: { ...CUSTOM_BASE, setupCommands: [NPM_CI] },
            sealantLayer: lifecycleLayer(created, {
              execCalls,
              captureOps: {
                stopAnswer: () => "stopped",
                beforeCreate: () =>
                  Effect.sync(() => {
                    executorRoot = path.join(root, `executor-${created.length}`);
                    // The first executor lays capture 0 down; the resume restores the capture.
                    fs.cpSync(created.length === 1 ? seed : saved, executorRoot, {
                      recursive: true,
                      preserveTimestamps: true,
                    });
                    restoredReads.push(fs.readFileSync(path.join(executorRoot, DEP), "utf8"));
                  }),
                exec: (argv) => {
                  if (argv[0] !== "sh" || argv[1] !== "-lc" || argv[2] !== NPM_CI) return undefined;
                  setups += 1;
                  const run = spawnSync("sh", ["-lc", NPM_CI], {
                    cwd: executorRoot,
                    encoding: "utf8",
                  });
                  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
                },
              },
            }),
          },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  for (const head of ["capture 0", "a saved capture"] as const) {
    it(`a standby claimed onto ${head} ${head === "capture 0" ? "runs its setup commands at claim, after the replan" : "runs no setup command after its replan, still installs the helper, and says why"}`, async () => {
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const pool = memoryHotPool();
      const SETUP = "npm ci --offline";
      /** Every exec, in order, with whether the replan had happened yet. */
      const order: string[] = [];
      let executor: SessionId | null = null;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
      const flush = () => Effect.succeed(captureAnswer({ epoch: 2 }));
      const replan = (workspace: Workspace) =>
        Effect.gen(function* () {
          if (executor === null) throw new Error("no executor to replan");
          order.push("replan");
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
          return {
            worktreeId: plan.worktree_id,
            epoch: plan.epoch,
            ...(plan.head === null
              ? {}
              : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
            filesWritten: 1,
            bytesWritten: 14,
            filesSkipped: 0,
            bytesSkipped: 0,
            removed: 0,
            unchanged: workspace.id === "",
          } satisfies WorkspaceCaptureReplanned;
        });
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
            const engine = yield* SessionEngine;
            yield* engine.reconcileHotSessions(project.id);
            yield* until(() => pool.entries.some((entry) => entry.status === "ready"), "a standby");
            const standby = pool.entries[0];
            if (standby === undefined) throw new Error("no standby");
            // Nothing executes in a capture-mode standby before its claim (e2e9 F-B).
            expect(execCalls).toEqual([]);
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            // The session claimed the standby.
            expect(session.id).toBe(standby.id);
            executor = session.id;
            let savedN: number | null = null;
            if (head === "a saved capture") {
              // The worktree's head is past capture 0 when the replan lays it down: capture 1,
              // saved by an earlier executor under an earlier epoch.
              const tree = path.join(tmp, "standby-saved");
              fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
              fs.writeFileSync(path.join(tree, "tree", "edit.txt"), "saved work\n");
              const cap0 = memory.chains.get(session.worktreeId)?.headCapture ?? null;
              const snapshot = snapshotDirectory(tree, captureKeys(session.worktreeId, 1), {
                chunkSize: 64,
              });
              const built = buildManifest({
                worktreeId: session.worktreeId,
                n: 1,
                parent: cap0,
                epoch: 1,
                seq: 10,
                kind: "final",
                git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
                workspace: { root: snapshot.root, packs: snapshot.packs },
              });
              yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
                Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
              );
              memory.captures.set(built.id, {
                id: built.id,
                worktreeId: session.worktreeId,
                n: 1,
                parent: cap0,
                epoch: 1,
                seq: 10n,
                kind: "final",
                manifestKey: built.key,
                sections: built.manifest.sections,
                gitFsck: "verified",
                createdAt: now(),
              });
              memory.chains.set(session.worktreeId, {
                ...(memory.chains.get(session.worktreeId) ?? { headEpoch: 1 }),
                headCapture: built.id,
                headN: 1,
                headEpoch: 1,
              });
              savedN = 1;
            }
            yield* engine.launch(session.id, ["codex"]);
            expect(order[0]).toBe("replan");
            const setups = order.filter((entry) => entry === "setup");
            const helper = order.indexOf("helper");
            expect(helper).toBeGreaterThan(0);
            const summary = drawnLine(world.sessions.get(session.id)?.summary);
            if (savedN === null) {
              expect(setups).toHaveLength(1);
              expect(order.indexOf("setup")).toBeGreaterThan(0);
              expect(order.indexOf("setup")).toBeLessThan(helper);
              expect(summary ?? "").not.toMatch(/setup skipped/);
            } else {
              expect(setups).toEqual([]);
              expect(summary).toBe(`setup skipped · restored from capture ${savedN}`);
            }
          }),
        {
          captured: memory,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: [SETUP] },
          sealantLayer: sealantLaunchLayer(
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            execCalls,
            undefined,
            {
              replan,
              flush,
              exec: (argv) => {
                if (argv[0] === "sh" && argv[1] === "-lc" && argv[2] === SETUP) {
                  order.push("setup");
                } else if ((argv[2] ?? "").includes("/usr/local/bin/mend")) {
                  order.push("helper");
                }
                return undefined;
              },
            },
          ),
          hotWorkspacesLayer: pool.layer,
        },
      );
    });
  }
});

describe("SessionEngine status words after end-to-end run 9", () => {
  it(
    "RD: a failed launch whose kept executor the platform ends after it sealed reads `launch failed: … · saved at … · capture n`, not the launch's words alone",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      let recovered = false;
      /** Records the executor's seal: the recovery boot's FINAL, landing while Core ends it. */
      let sealOnStop: (() => void) | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            yield* until(
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
            const sealedAt = new Date(Date.now() + 1_000);
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
              yield* Effect.sleep(Duration.millis(100));
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
        },
      );
    },
  );

  it(
    "D9: a session Mend stopped because its executor ran a final flush of its own reads `stopped outside Mend · saved at … · capture n` once saved, as its siblings do; the owner's Stop still reads a bare `stopped`",
    { timeout: 20_000 },
    async () => {
      for (const who of ["executor", "owner"] as const) {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        let ending = false;
        /** Where the executor answered, in its own order: its FINAL after its status. */
        let stamp: ((observation: number) => object) | null = null;
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
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
              yield* until(
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
          },
        );
      }
    },
  );
});

// Review 2026-09-28 (16) #1: a resume onto a saved head whose tree is this platform's keeps the
// user's patch in `node_modules` whether the manifest read at the install decision succeeds or
// fails once (HTTP 503). A failed read is unavailable, never "no tree here".
for (const fault of [false, true]) {
  it(
    `AUDIT R16 same-platform resume preserves dependency patch with manifest GET fault=${fault}`,
    { timeout: 60000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const { root, seed } = npmProject();
      const saved = path.join(root, "saved");
      let executorRoot = "";
      let failedReads = 0;
      let failRead = false;
      let manifestKey = "";
      let installs = 0;
      const restoredReads: string[] = [];
      const logs: string[] = [];
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              const project = world.projects.get(session.projectId);
              if (project === undefined) throw new Error("project missing");
              world.projects.set(project.id, new Project({ ...project, installCommand: NPM_CI }));
              yield* engine.launch(session.id, ["codex"]);
              expect(installs).toBe(1);
              fs.writeFileSync(path.join(executorRoot, DEP), PATCH);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const chain = memory.chains.get(session.worktreeId);
              const n = (chain?.headN ?? 0) + 1;
              const snapshot = snapshotDirectory(
                executorRoot,
                captureKeys(session.worktreeId, epoch),
                { chunkSize: 64 },
              );
              const bulkRoot = path.join(root, "bulk");
              fs.mkdirSync(path.join(bulkRoot, "tree"), { recursive: true });
              fs.cpSync(
                path.join(executorRoot, "node_modules"),
                path.join(bulkRoot, "tree/node_modules"),
                { recursive: true },
              );
              const bulk = snapshotDirectory(bulkRoot, captureKeys(session.worktreeId, epoch), {
                chunkSize: 64,
              });
              const built = buildManifest({
                worktreeId: session.worktreeId,
                n,
                parent: chain?.headCapture ?? null,
                epoch,
                seq: n * 10,
                kind: "final",
                git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
                workspace: { root: snapshot.root, packs: snapshot.packs },
                bulk: { root: bulk.root, packs: bulk.packs, platform: "linux-x86_64-gnu" },
              });
              yield* uploadObjects(
                new Map([...snapshot.objects, ...bulk.objects, [built.key, built.bytes]]),
              ).pipe(Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))));
              const api = servedSocketApis.get(session.id)?.capture;
              if (api === undefined) throw new Error("capture api missing");
              const registered = yield* api.register({
                worktree_id: session.worktreeId,
                epoch,
                n,
                parent: chain?.headCapture ?? null,
                capture_id: built.id,
                manifest_key: built.key,
                manifest: built.manifest,
              });
              expect(registered.head_n).toBe(n);
              manifestKey = built.key;
              fs.cpSync(executorRoot, saved, { recursive: true, preserveTimestamps: true });
              yield* engine.stop(session.id);
              yield* until(
                () =>
                  world.sessions.get(session.id)?.captureDrain === null &&
                  world.sessions.get(session.id)?.status === "stopped",
                "saved stop",
              );
              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(created).toHaveLength(2);
              expect(restoredReads.at(-1)).toBe(PATCH);
              expect(resumed.status).toBe("running");
              expect(failedReads).toBe(fault ? 1 : 0);
              expect(fs.readFileSync(path.join(executorRoot, DEP), "utf8")).toBe(PATCH);
              // The restored tree is observed on a read; an unavailable read runs no installer.
              expect(installs).toBe(1);
              const summary = world.sessions.get(session.id)?.summary ?? "";
              if (fault) {
                expect(summary).toContain(
                  `dependency install skipped · capture ${n} manifest unavailable`,
                );
                expect(
                  logs.some((line) =>
                    line.includes("dependency install skipped · manifest unavailable"),
                  ),
                ).toBe(true);
              } else {
                expect(summary).not.toMatch(/dependency install skipped/);
              }
            }),
          {
            captured: memory,
            logs,
            transformBlobs: (base) =>
              Layer.effect(
                BlobStore,
                Effect.gen(function* () {
                  const inner = yield* BlobStore;
                  return {
                    ...inner,
                    get: (key: string) =>
                      Effect.suspend(() => {
                        if (failRead && key === manifestKey) {
                          failRead = false;
                          failedReads += 1;
                          return Effect.fail(
                            new BlobStoreError({
                              operation: "get",
                              key,
                              cause: new Error("503 ServiceUnavailable on one manifest read"),
                            }),
                          );
                        }
                        return inner.get(key);
                      }),
                  };
                }),
              ).pipe(Layer.provide(base)),
            workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: () => "stopped",
                beforeCreate: () =>
                  Effect.sync(() => {
                    executorRoot = path.join(root, `executor-${created.length}`);
                    fs.cpSync(
                      created.length === 1 ? seed : (process.env.REVIEW16_RESTORED_ROOT ?? saved),
                      executorRoot,
                      { recursive: true, preserveTimestamps: true },
                    );
                    restoredReads.push(fs.readFileSync(path.join(executorRoot, DEP), "utf8"));
                  }),
                exec: (argv) => {
                  if ((argv[2] ?? "").startsWith("uname -s; uname -m;")) {
                    if (created.length === 2) failRead = fault;
                    return {
                      exitCode: 0,
                      stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n",
                      stderr: "",
                    };
                  }
                  if (argv[0] !== "sh" || argv[1] !== "-lc" || argv[2] !== NPM_CI) return undefined;
                  installs += 1;
                  const run = spawnSync("sh", ["-lc", NPM_CI], {
                    cwd: executorRoot,
                    encoding: "utf8",
                  });
                  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
                },
              },
            }),
          },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

// "Automatic install": on (the default), a fresh worktree's launch runs the project's install
// command before the harness; off, the launch runs none, saved command or detected.
describe("automatic install", () => {
  const INSTALL = "echo automatic-install-ran";
  for (const installEnabled of [true, false]) {
    it(`${installEnabled ? "on" : "off"}: a fresh launch ${installEnabled ? "runs" : "runs no"} install command`, async () => {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(
              project.id,
              new Project({ ...project, installCommand: INSTALL, installEnabled }),
            );
            yield* engine.launch(session.id, ["codex"]);
            const installs = execCalls.filter(
              (argv) => argv[0] === "sh" && argv[1] === "-lc" && argv[2] === INSTALL,
            );
            expect(installs).toHaveLength(installEnabled ? 1 : 0);
            expect(
              logs.some((line) =>
                line.includes("dependency install skipped · automatic install off"),
              ),
            ).toBe(!installEnabled);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : undefined,
            },
          }),
        },
      );
    });
  }

  // A plain pnpm install runs with Mend's fetch timeouts (`installScript`), and the line it logs
  // says how many fetch retries the output reported, counted from the execs' output alone. When
  // the shortened install fails on fetch timeouts (a registry slower than 15 s to answer), the
  // command runs once more as written, with pnpm's defaults, and a line says so.
  const RETRY =
    " WARN  GET https://registry.npmjs.org/a/-/a-1.0.0.tgz error (ERR_SOCKET_TIMEOUT). Will retry in 2 seconds. 2 retries left.";
  const GIVE_UP =
    " ERR_SOCKET_TIMEOUT  request to https://registry.npmjs.org/a/-/a-1.0.0.tgz failed, reason: Socket timeout\n";
  for (const shortened of ["completes", "fails on fetch timeouts"] as const) {
    it(`a detected pnpm install runs with fetch timeouts; ${shortened === "completes" ? "it completes and logs its fetch retries" : "it fails on fetch timeouts, runs again with pnpm's defaults and says so"}`, async () => {
      const PNPM = "pnpm install --frozen-lockfile";
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(project.id, new Project({ ...project, installCommand: PNPM }));
            yield* engine.launch(session.id, ["codex"]);
            const installs = execCalls
              .filter((argv) => argv[0] === "sh" && argv[1] === "-lc")
              .map((argv) => argv[2])
              .filter((script) => script === installScript(PNPM) || script === PNPM);
            const retried = logs.some((line) =>
              line.includes("dependency install · retried with defaults"),
            );
            if (shortened === "completes") {
              expect(installs).toEqual([installScript(PNPM)]);
              expect(retried).toBe(false);
              expect(
                logs.some((line) =>
                  line.includes("dependency install · completed · exit 0 · fetch retries 2"),
                ),
              ).toBe(true);
            } else {
              expect(installs).toEqual([installScript(PNPM), PNPM]);
              expect(retried).toBe(true);
              // The end line keeps its shape: the rerun's exit, the retries of both runs.
              expect(
                logs.some((line) =>
                  line.includes("dependency install · completed · exit 0 · fetch retries 1"),
                ),
              ).toBe(true);
            }
            // Only the count is logged, never the output it was counted from.
            expect(logs.some((line) => line.includes("registry.npmjs.org"))).toBe(false);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : argv[2] === installScript(PNPM)
                    ? shortened === "completes"
                      ? {
                          exitCode: 0,
                          stdout: ["Packages: +2024", RETRY, RETRY, "Done in 31.2s"].join("\n"),
                          stderr: "",
                        }
                      : { exitCode: 1, stdout: `${RETRY}\n`, stderr: GIVE_UP }
                    : argv[2] === PNPM
                      ? { exitCode: 0, stdout: "Done in 20.2s using pnpm v10.32.1\n", stderr: "" }
                      : undefined,
            },
          }),
        },
      );
    });
  }

  // The server's npm mirror (`MEND_NPM_MIRROR_URL`): the install script carries it, and a run that
  // failed on the mirror runs again as written, so it reaches the registry itself.
  for (const mirrored of ["completes", "fails on the mirror"] as const) {
    it(`with the server's npm mirror, the install goes through it; ${mirrored === "completes" ? "it completes" : "it fails on the mirror and runs again without it"}`, async () => {
      const PNPM = "pnpm install --frozen-lockfile";
      const MIRROR = "http://npm-mirror:4873/";
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(project.id, new Project({ ...project, installCommand: PNPM }));
            // What `mend server setup`'s mirrors overlay hands the server.
            yield* engine
              .launch(session.id, ["codex"])
              .pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: { MEND_NPM_MIRROR_URL: MIRROR } }),
                ),
              );
            const installs = execCalls
              .filter((argv) => argv[0] === "sh" && argv[1] === "-lc")
              .map((argv) => argv[2])
              .filter((script) => script === installScript(PNPM, MIRROR) || script === PNPM);
            const fellBack = logs.some((line) =>
              line.includes("dependency install · retried without the npm mirror"),
            );
            expect(installs).toEqual(
              mirrored === "completes"
                ? [installScript(PNPM, MIRROR)]
                : [installScript(PNPM, MIRROR), PNPM],
            );
            expect(fellBack).toBe(mirrored !== "completes");
            expect(
              logs.some((line) => line.includes("dependency install · completed · exit 0")),
            ).toBe(true);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : argv[2] === installScript(PNPM, MIRROR)
                    ? mirrored === "completes"
                      ? {
                          exitCode: 0,
                          stdout: "Done in 6.1s using pnpm v10.32.1\n",
                          stderr: `mend: npm mirror · used · ${MIRROR}\n`,
                        }
                      : {
                          exitCode: 1,
                          stdout: "",
                          stderr: `mend: npm mirror · used · ${MIRROR}\n ERR_PNPM_FETCH_502  GET ${MIRROR}a/-/a-1.0.0.tgz: Bad Gateway - 502\n`,
                        }
                    : argv[2] === PNPM
                      ? { exitCode: 0, stdout: "Done in 20.2s using pnpm v10.32.1\n", stderr: "" }
                      : undefined,
            },
          }),
        },
      );
    });
  }
});

/**
 * Review 2026-09-28 (17) #1: a cold resume rewrote Mend's note in the restored harness memory
 * files by cutting each file at the old `<!-- mend:mounts -->` marker, so whatever the user or
 * the agent wrote below the note was lost. The reviewer's probe, kept whole: the actual engine
 * launches, the note command it emits runs against a real directory standing in for the executor
 * home, the text appended after the note is registered in a sealed capture, and the resume runs
 * the note command again over the restored copy. Three starting points: a fresh home (owner text
 * before, user text after the bounded block), a home holding the note the pre-fix engine wrote
 * with user text after it (`fixtures/workspace-note-legacy.txt`: that engine's output, captured and
 * cold-restored by sealantd), and the same old note with a line the user wrote inside it.
 */
const noteBlockCount = (text: string) => text.split("<!-- mend:workspace-note:begin").length - 1;

describe("review 17 #1: the workspace note never takes the user's text with it", () => {
  const legacyFixture = fs.readFileSync(
    new URL("./fixtures/workspace-note-legacy.txt", import.meta.url),
    "utf8",
  );
  const legacyUserText = "\n## My project notes\nKeep the migration compatibility shim until v3.\n";
  const insideEdit = "Never touch /workspace/ref/api by hand.\n";
  const scenarios = [
    {
      name: "a fresh home: owner text before the block and user text after it survive a resume",
      initial: "# Owner instructions\nUse the local test runner.\n",
      kept: ["# Owner instructions\nUse the local test runner.\n"],
      legacyKept: false,
    },
    {
      name: "the pre-fix engine's open-ended note becomes the block; the text after it stays",
      initial: legacyFixture,
      kept: ["# Owner instructions\nUse the local test runner.\n", legacyUserText],
      legacyKept: false,
    },
    {
      name: "an old note with the user's own line inside it is left whole, and the block is added",
      initial: legacyFixture.replace(
        "Mounted beside the repo:\n\n",
        `Mounted beside the repo:\n\n${insideEdit}`,
      ),
      kept: ["# Owner instructions\nUse the local test runner.\n", insideEdit, legacyUserText],
      legacyKept: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    it(scenario.name, { timeout: 60_000 }, async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r17-notes-"));
      const saved = path.join(root, "saved");
      const notes = [".claude/CLAUDE.md", ".codex/AGENTS.md"];
      const userText = "\n## Appended in the session\nRun the migration check before every push.\n";
      let executorHome = "";
      let noteRuns = 0;
      const beforeResume: string[] = [];
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              yield* engine.launch(session.id, ["codex"]);
              expect(noteRuns).toBe(1);
              const firstLaunch: Array<string> = [];
              for (const note of notes) {
                const target = path.join(executorHome, note);
                const written = fs.readFileSync(target, "utf8");
                for (const text of scenario.kept) expect(written).toContain(text);
                firstLaunch.push(written);
                fs.appendFileSync(target, userText);
              }
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const chain = memory.chains.get(session.worktreeId);
              const n = (chain?.headN ?? 0) + 1;
              const snapshotRoot = path.join(root, "snapshot");
              fs.mkdirSync(snapshotRoot);
              fs.cpSync(executorHome, path.join(snapshotRoot, "harness"), { recursive: true });
              const snapshot = snapshotDirectory(
                snapshotRoot,
                captureKeys(session.worktreeId, epoch),
                { chunkSize: 64 },
              );
              const built = buildManifest({
                worktreeId: session.worktreeId,
                n,
                parent: chain?.headCapture ?? null,
                epoch,
                seq: n * 10,
                kind: "final",
                git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
                workspace: { root: snapshot.root, packs: snapshot.packs },
              });
              yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
                Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
              );
              const api = servedSocketApis.get(session.id)?.capture;
              if (api === undefined) throw new Error("capture api missing");
              const registered = yield* api.register({
                worktree_id: session.worktreeId,
                epoch,
                n,
                parent: chain?.headCapture ?? null,
                capture_id: built.id,
                manifest_key: built.key,
                manifest: built.manifest,
              });
              expect(registered.head_n).toBe(n);
              fs.cpSync(executorHome, saved, { recursive: true, preserveTimestamps: true });
              yield* engine.stop(session.id);
              yield* until(
                () =>
                  world.sessions.get(session.id)?.captureDrain === null &&
                  world.sessions.get(session.id)?.status === "stopped",
                "saved stop",
              );
              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(created).toHaveLength(2);
              expect(noteRuns).toBe(2);
              expect(beforeResume).toHaveLength(2);
              for (const text of beforeResume) expect(text).toContain(userText);
              expect(resumed.status).toBe("running");
              const afterResume = notes.map((note) =>
                fs.readFileSync(path.join(executorHome, note), "utf8"),
              );
              // What the user and the agent wrote comes through the resume.
              for (const after of afterResume) {
                expect(after).toContain(userText);
                for (const text of scenario.kept) expect(after).toContain(text);
              }
              // One bounded block; an old note is gone only where it matched exactly.
              for (const written of firstLaunch) {
                expect(noteBlockCount(written)).toBe(1);
                expect(written.includes("<!-- mend:mounts -->")).toBe(scenario.legacyKept);
              }
              // The restored file was already current: the resume wrote nothing, byte for byte.
              for (const [index, after] of afterResume.entries()) {
                expect(after).toBe(beforeResume[index]);
                expect(noteBlockCount(after)).toBe(1);
              }
            }),
          {
            captured: memory,
            workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: () => "stopped",
                beforeCreate: () =>
                  Effect.sync(() => {
                    executorHome = path.join(root, `home-${created.length}`);
                    if (created.length === 1) {
                      for (const note of notes) {
                        fs.mkdirSync(path.dirname(path.join(executorHome, note)), {
                          recursive: true,
                        });
                        fs.writeFileSync(path.join(executorHome, note), scenario.initial);
                      }
                    } else {
                      fs.cpSync(saved, executorHome, { recursive: true, preserveTimestamps: true });
                      beforeResume.push(
                        ...notes.map((note) =>
                          fs.readFileSync(path.join(executorHome, note), "utf8"),
                        ),
                      );
                    }
                  }),
                exec: (argv) => {
                  if (
                    argv[0] !== "sh" ||
                    argv[1] !== "-c" ||
                    !(argv[2] ?? "").includes("mend:mounts")
                  ) {
                    return undefined;
                  }
                  noteRuns += 1;
                  const run = spawnSync(argv[0], argv.slice(1), {
                    cwd: executorHome,
                    env: { ...process.env, HOME: executorHome },
                    encoding: "utf8",
                  });
                  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
                },
              },
            }),
          },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

/**
 * Review 2026-09-28 (18) #1: skills delivery on resume decided that a skill directory was its own
 * delivery by file contents alone, removed it and wrote it again. A helper script the user made
 * executable came back 0644; an empty directory and a hard link were gone. The reviewer's probe:
 * the actual engine launches and delivers `build-helper`, the user customizes it, the harness home
 * is registered in a sealed capture, and the cold resume runs the emitted `mend-skills` and
 * `mend-write` commands against a `cp -a` copy (the reviewer proved sealantd restores exactly
 * these: mode, nanosecond mtime, empty directory, both link names).
 */
it("AUDIT R18 cold resume preserves a saved skill's metadata", { timeout: 60_000 }, async () => {
  const created: Array<CreateOptions> = [];
  const memory = makeMemoryCaptureStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r18-skills-"));
  const saved = path.join(root, "saved");
  let executorHome = "";
  const base = launchSkill("build-helper", "# Build helper\nRun scripts/check.sh.\n", {
    scope: "user",
    userId: "user-fixture",
  });
  const delivered = new SkillWithFiles({
    ...base,
    files: [...base.files, { path: "scripts/check.sh", contents: "#!/bin/sh\necho checked\n" }],
  });
  const skillsLayer = skillsForLaunchLayer(() =>
    Effect.succeed({ user: [delivered], project: [] }),
  );
  const facts = () => {
    const script = path.join(executorHome, ".claude/skills/build-helper/scripts/check.sh");
    return {
      mode: fs.statSync(script).mode & 0o777,
      empty: fs.existsSync(path.join(executorHome, ".claude/skills/build-helper/scratch/empty")),
      linked: fs.statSync(script).ino === fs.statSync(path.join(executorHome, "my-check.sh")).ino,
      mtime: fs.statSync(script, { bigint: true }).mtimeNs.toString(),
      bytes: fs.readFileSync(script, "utf8"),
    };
  };
  let before: ReturnType<typeof facts> | null = null;
  const ran: Array<string> = [];
  try {
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          const dir = path.join(executorHome, ".claude/skills/build-helper");
          const script = path.join(dir, "scripts/check.sh");
          fs.chmodSync(script, 0o755);
          fs.mkdirSync(path.join(dir, "scratch/empty"), { recursive: true });
          fs.linkSync(script, path.join(executorHome, "my-check.sh"));
          fs.utimesSync(script, 1700000000.123, 1700000000.123);
          fs.mkdirSync(saved);
          expect(spawnSync("cp", ["-a", `${executorHome}/.`, saved]).status).toBe(0);
          const chain = memory.chains.get(session.worktreeId);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          const n = (chain?.headN ?? 0) + 1;
          const snapshotRoot = path.join(root, "snapshot");
          fs.mkdirSync(snapshotRoot);
          fs.cpSync(saved, path.join(snapshotRoot, "harness"), { recursive: true });
          const snapshot = snapshotDirectory(snapshotRoot, captureKeys(session.worktreeId, epoch), {
            chunkSize: 64,
          });
          const built = buildManifest({
            worktreeId: session.worktreeId,
            n,
            parent: chain?.headCapture ?? null,
            epoch,
            seq: n * 10,
            kind: "final",
            git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
            workspace: { root: snapshot.root, packs: snapshot.packs },
          });
          yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
            Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
          );
          const api = servedSocketApis.get(session.id)?.capture;
          if (api === undefined) throw new Error("capture api missing");
          yield* api.register({
            worktree_id: session.worktreeId,
            epoch,
            n,
            parent: chain?.headCapture ?? null,
            capture_id: built.id,
            manifest_key: built.key,
            manifest: built.manifest,
          });
          yield* engine.stop(session.id);
          yield* until(
            () =>
              world.sessions.get(session.id)?.captureDrain === null &&
              world.sessions.get(session.id)?.status === "stopped",
            "saved stop",
          );
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(before).toMatchObject({ mode: 0o755, empty: true, linked: true });
          expect(facts()).toEqual(before);
          // The resume ran the delivery: it found the skill unchanged and wrote none of its files.
          expect(ran.filter((op) => op === "mend-skills").length).toBe(2);
        }),
      {
        captured: memory,
        skillsLayer,
        workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            stopAnswer: () => "stopped",
            beforeCreate: () =>
              Effect.sync(() => {
                executorHome = path.join(root, `home-${created.length}`);
                fs.mkdirSync(executorHome);
                if (created.length > 1) {
                  expect(spawnSync("cp", ["-a", `${saved}/.`, executorHome]).status).toBe(0);
                  before = facts();
                }
              }),
            // The skill files: redeemed over the session's channel and written as the pickup
            // writer writes them, into this executor's home.
            execEffect: (argv) => {
              if (argv[3] !== "mend-write" || !isPickupExec(argv)) return undefined;
              ran.push("mend-write");
              const channel = created.at(-1)?.env?.["MEND_SESSION_ID"];
              return redeemPickupExec(
                argv,
                channel === undefined ? null : SessionId.make(channel),
              ).pipe(
                Effect.map((answer) => {
                  writePickedUp(answer.files, (at) =>
                    at.replaceAll("/workspace/harness-home", executorHome),
                  );
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
                Effect.orDie,
              );
            },
            exec: (argv) => {
              const op = argv[3] ?? "";
              const manifestRead =
                argv[0] === "cat" && (argv[1] ?? "").includes(".mend-managed-skills");
              if (op !== "mend-skills" && !manifestRead) return undefined;
              ran.push(manifestRead ? "cat" : op);
              const mapped = argv.map((arg) =>
                arg.replaceAll("/workspace/harness-home", executorHome),
              );
              const run = spawnSync(mapped[0] ?? "", mapped.slice(1), {
                cwd: executorHome,
                env: { ...process.env, HOME: executorHome },
                encoding: "utf8",
              });
              return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
            },
          },
        }),
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Core's credential writer (`credential-files.ts`), as it runs in a fresh executor. */
const injectCoreCredential = (home: string) =>
  spawnSync(
    "sh",
    [
      "-c",
      'umask 077 && mkdir -p "$(dirname "$HOME/.claude/.credentials.json")" && ' +
        'base64 -d > "$HOME/.claude/.credentials.json" && ' +
        'chmod 600 "$HOME/.claude/.credentials.json"',
    ],
    {
      env: { ...process.env, HOME: home },
      input: Buffer.from("fresh injected credential\n").toString("base64"),
    },
  ).status;

/**
 * Review 2026-09-28 (19) #1: after a correct cold restore, the relocation merged the fresh
 * executor's `$HOME/.claude` (Core writes the connected-account credential under `umask 077`) into
 * the restored harness root with `cp -an source/. root/`, which copied that directory's 0700 and
 * time over the restored `.claude` saved at 0750. The reviewer's probe: the actual engine launches,
 * `.claude` is set to 0750 with an exact time, the harness home is registered in a sealed capture,
 * and the cold resume runs Core's credential write into a fresh home, then the engine's own
 * relocation and skills commands against a `cp -a` copy of what was saved.
 */
it(
  "AUDIT R19 cold resume preserves directory metadata through actual relocation",
  { timeout: 60_000 },
  async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r19-relocation-"));
    const saved = path.join(root, "saved");
    let executorHome = "";
    let ephemeralHome = "";
    const relocations: Array<{
      readonly before: { readonly mode: number; readonly mtime: string } | null;
      readonly after: { readonly mode: number; readonly mtime: string };
      readonly status: number | null;
    }> = [];
    const dirFacts = () => {
      const stat = fs.statSync(path.join(executorHome, ".claude"), { bigint: true });
      return { mode: Number(stat.mode & 0o777n), mtime: stat.mtimeNs.toString() };
    };
    const base = launchSkill("build-helper", "# Build helper\nRun scripts/check.sh.\n", {
      scope: "user",
      userId: "user-fixture",
    });
    const delivered = new SkillWithFiles({
      ...base,
      files: [...base.files, { path: "scripts/check.sh", contents: "#!/bin/sh\necho checked\n" }],
    });
    const skillsLayer = skillsForLaunchLayer(() =>
      Effect.succeed({ user: [delivered], project: [] }),
    );
    try {
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            fs.chmodSync(path.join(executorHome, ".claude"), 0o750);
            fs.utimesSync(path.join(executorHome, ".claude"), 1700000000.125, 1700000000.125);
            fs.mkdirSync(saved);
            expect(spawnSync("cp", ["-a", `${executorHome}/.`, saved]).status).toBe(0);
            const chain = memory.chains.get(session.worktreeId);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const n = (chain?.headN ?? 0) + 1;
            const snapshotRoot = path.join(root, "snapshot");
            fs.mkdirSync(snapshotRoot);
            fs.cpSync(saved, path.join(snapshotRoot, "harness"), { recursive: true });
            const snapshot = snapshotDirectory(
              snapshotRoot,
              captureKeys(session.worktreeId, epoch),
              { chunkSize: 64 },
            );
            const built = buildManifest({
              worktreeId: session.worktreeId,
              n,
              parent: chain?.headCapture ?? null,
              epoch,
              seq: n * 10,
              kind: "final",
              git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
              workspace: { root: snapshot.root, packs: snapshot.packs },
            });
            yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
              Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
            );
            const api = servedSocketApis.get(session.id)?.capture;
            if (api === undefined) throw new Error("capture api missing");
            yield* api.register({
              worktree_id: session.worktreeId,
              epoch,
              n,
              parent: chain?.headCapture ?? null,
              capture_id: built.id,
              manifest_key: built.key,
              manifest: built.manifest,
            });
            yield* engine.stop(session.id);
            yield* until(
              () =>
                world.sessions.get(session.id)?.captureDrain === null &&
                world.sessions.get(session.id)?.status === "stopped",
              "saved stop",
            );
            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            // Both launches relocated; the resume's ran over the restored `.claude`.
            expect(relocations).toHaveLength(2);
            const last = relocations.at(-1);
            expect(last?.status).toBe(0);
            expect(last?.before).toEqual({ mode: 0o750, mtime: "1700000000125000000" });
            expect(last?.after).toEqual(last?.before);
            // The fresh credential arrived beside it, as Core wrote it.
            const credential = path.join(executorHome, ".claude/.credentials.json");
            expect(fs.readFileSync(credential, "utf8")).toBe("fresh injected credential\n");
            expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
            expect(fs.realpathSync(path.join(ephemeralHome, ".claude"))).toBe(
              path.join(executorHome, ".claude"),
            );
          }),
        {
          captured: memory,
          skillsLayer,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: () => "stopped",
              beforeCreate: () =>
                Effect.sync(() => {
                  executorHome = path.join(root, `capture-${created.length}`);
                  fs.mkdirSync(executorHome);
                  ephemeralHome = path.join(root, `home-${created.length}`);
                  fs.mkdirSync(ephemeralHome);
                  expect(injectCoreCredential(ephemeralHome)).toBe(0);
                  if (created.length > 1) {
                    expect(spawnSync("cp", ["-a", `${saved}/.`, executorHome]).status).toBe(0);
                  }
                }),
              exec: (argv) => {
                const relocation = (argv[2] ?? "").includes("harness-home relocation failed");
                const op = argv[3] ?? "";
                const manifestRead =
                  argv[0] === "cat" && (argv[1] ?? "").includes(".mend-managed-skills");
                if (!relocation && op !== "mend-skills" && op !== "mend-write" && !manifestRead) {
                  return undefined;
                }
                const mapped = argv.map((arg) =>
                  arg.replaceAll("/workspace/harness-home", executorHome),
                );
                const before =
                  relocation && fs.existsSync(path.join(executorHome, ".claude"))
                    ? dirFacts()
                    : null;
                const run = spawnSync(mapped[0] ?? "", mapped.slice(1), {
                  cwd: executorHome,
                  env: { ...process.env, HOME: ephemeralHome },
                  encoding: "utf8",
                });
                if (relocation) relocations.push({ before, after: dirFacts(), status: run.status });
                return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
              },
            },
          }),
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

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
    it(
      `AUDIT R19 lost-create recovery only reports observed termination: end ${end}`,
      { timeout: 20_000 },
      async () => {
        const memory = makeMemoryCaptureStore();
        const created: Array<CreateOptions> = [];
        const stops: Array<"drain" | "discard"> = [];
        const logs: Array<string> = [];
        let endSeen = end === "at once";
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              const key = `launch:${session.id}:${Date.now()}:audit`;
              world.executorCreates.set(session.id, key);
              yield* Effect.gen(function* () {
                const repo = yield* CaptureStoreRepo;
                yield* repo.init(session.worktreeId);
                yield* repo.claim(session.worktreeId, session.id, 30, key);
              }).pipe(Effect.provide(memory.layer));
              yield* engine.reapCaptureLeases();
              yield* until(() => stops.length > 0, "Core stop requested");
              if (end === "at once") {
                yield* until(
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
              yield* until(
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
      },
    );
  }
});

const outputEntry = (sequence: bigint, occurredAt: string, byteCount: string): TimelineEntry => ({
  kind: "ioChunk",
  sequence,
  occurredAt,
  summary: "pty-out",
  data: { stream: 1, byteCount, streamOffset: "0" },
});

/**
 * An agent's first screen on a fresh executor (alpha 2026-09-30, fda7180d): the machine is ready
 * in seconds, and the harness then reads node and its own files from a lazily fetched disk for the
 * first time. The launch reads them once in the background while the rest of its setup runs, and
 * the session line says the agent is starting until its record carries output.
 */
describe("secret files under a directory sessions now save (review 2026-10-04)", () => {
  it("refuses the launch, before the harness home moves, when the home's record of secret files cannot be read", async () => {
    for (const answer of ["exits", "fails"] as const) {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      let opened = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "opencode",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            const refusal = yield* engine.launch(session.id, ["opencode"]).pipe(Effect.flip);
            expect(String(refusal.message), answer).toContain(
              "a secret file under a directory sessions now save could not be taken out of it",
            );
            // Nothing moved the harness home, and no agent started.
            expect(
              execCalls.some((argv) => String(argv[2]).includes("harness-home relocation")),
            ).toBe(false);
            expect(opened).toBe(0);
            expect(world.sessions.get(session.id)?.status).toBe("failed");
            expect(world.sessions.get(session.id)?.summary ?? "").toContain("launch failed:");
          }),
        {
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              execEffect: (argv) =>
                argv.join(" ") === secretFilesDeliveredExec.join(" ")
                  ? answer === "exits"
                    ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "unreadable" })
                    : Effect.fail(
                        new SealantPlatformError({
                          code: "exec-failed",
                          status: null,
                          message: "the workspace did not answer",
                          cause: null,
                        }),
                      )
                  : undefined,
              beforeOpen: () => {
                opened += 1;
              },
            },
          }),
        },
      );
    }
  });
});

describe("an agent's first screen (alpha 2026-09-30)", () => {
  it("a launch warms the harness's files in the background: asked before the agent starts, never waited for", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          const launched = yield* engine.launch(session.id, ["claude"]);

          // The warm-up never answered, and the agent started anyway.
          expect(launched.status).toBe("running");
          expect(events.indexOf("warm-up asked")).toBeGreaterThanOrEqual(0);
          expect(events.indexOf("warm-up asked")).toBeLessThan(events.indexOf("agent opened"));
          expect(events).not.toContain("warm-up answered");
          const warmups = execCalls.filter(isWarmup);
          expect(warmups).toHaveLength(1);
          // Read-only toward the user's: from `/`, with a throwaway HOME, for this harness.
          const [, , script, , harness] = warmups[0] ?? [];
          expect(harness).toBe("claude");
          expect(script).toContain("cd / ||");
          expect(script).toContain('HOME="$d"');
          expect(script).toContain('rm -rf "$d"');
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          execCalls,
          captureOps: {
            execEffect: (argv) =>
              isWarmup(argv)
                ? Effect.sync(() => events.push("warm-up asked")).pipe(
                    Effect.andThen(Effect.never),
                    Effect.tap(() => Effect.sync(() => events.push("warm-up answered"))),
                  )
                : undefined,
            beforeOpen: () => {
              events.push("agent opened");
            },
          },
        }),
      },
    );
  });

  it("a warm-up that fails, or runs past its bound, changes nothing about the launch", async () => {
    for (const answer of ["fails", "hangs"] as const) {
      const created: Array<CreateOptions> = [];
      const logs: string[] = [];
      const interrupted: string[] = [];
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
              base: null,
            });
            const launched = yield* engine.launch(session.id, ["codex"]);
            expect(launched.status).toBe("running");
            yield* until(
              () => logs.some((line) => line.includes("harness warm-up · not finished")),
              `the ${answer} warm-up to end`,
            );
            const after = world.sessions.get(session.id);
            expect(after?.status).toBe("running");
            expect(after?.settledAt ?? null).toBeNull();
            expect(after?.summary).toBe("codex is starting on the new machine");
            // A warm-up past its bound is abandoned, not left running.
            if (answer === "hangs") expect(interrupted).toEqual(["warm-up"]);
          }),
        {
          logs,
          drainPolicy: { harnessWarmupTimeout: Duration.millis(50) },
          sealantLayer: lifecycleLayer(created, {
            execCalls: [],
            captureOps: {
              execEffect: (argv) =>
                !isWarmup(argv)
                  ? undefined
                  : answer === "fails"
                    ? Effect.fail(
                        new SealantPlatformError({
                          code: "exec_failed",
                          status: 502,
                          message: "the executor did not run the command",
                          cause: null,
                        }),
                      )
                    : Effect.never.pipe(
                        Effect.onInterrupt(() => Effect.sync(() => interrupted.push("warm-up"))),
                      ),
            },
          }),
        },
      );
    }
  });

  it("a shell or a command of the owner's own warms nothing and never reads as starting", async () => {
    const created: Array<CreateOptions> = [];
    const execCalls: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "run",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          const launched = yield* engine.launch(session.id, ["make", "test"]);
          expect(launched.status).toBe("running");
          expect(execCalls.filter(isWarmup)).toEqual([]);
          expect(world.sessions.get(session.id)?.summary ?? null).toBeNull();
        }),
      { sealantLayer: lifecycleLayer(created, { execCalls }) },
    );
  });

  it("refuses to resume a `mend run` command on its own harness, in words, starting nothing", async () => {
    const created: Array<CreateOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "run",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["make", "test"]);
          yield* engine.stop(session.id);
          const launches = created.length;

          for (const harness of [null, "run"]) {
            const refused = yield* engine.resumeSession(session.id, harness).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(SealantPlatformError);
            expect(refused.message).toBe(noResumeLine("run"));
          }
          expect(created).toHaveLength(launches);
        }),
      { sealantLayer: lifecycleLayer(created) },
    );
  });

  it("the agent reads as starting until its record carries output, then its row says when it drew and the words go", async () => {
    const created: Array<CreateOptions> = [];
    const drew = "2026-09-30T17:15:41.000Z";
    const drawn = await Effect.runPromise(Deferred.make<void>());
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);
          const agent = () =>
            [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
          // Before any output: starting, and the row says nothing drew.
          expect(world.sessions.get(session.id)?.summary).toBe(
            "claude is starting on the new machine",
          );
          expect(agent()?.firstOutputAt ?? null).toBeNull();

          yield* Deferred.succeed(drawn, undefined);
          yield* until(() => agent()?.firstOutputAt != null, "the first output to be stamped");
          expect(agent()?.firstOutputAt?.toISOString()).toBe(drew);
          yield* until(
            () => (world.sessions.get(session.id)?.summary ?? null) === null,
            "the starting words to go",
          );
          expect(world.sessions.get(session.id)?.status).toBe("running");
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            // The record opens with a heartbeat and an empty chunk; the first bytes come later.
            record: () =>
              Stream.make(outputEntry(1n, "2026-09-30T17:14:56.000Z", "0")).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.await(drawn)).pipe(
                    Stream.map(() => outputEntry(2n, drew, "312")),
                  ),
                ),
                Stream.concat(Stream.fromEffect(Effect.never)),
              ),
          },
        }),
      },
    );
  });

  it("a launch whose run settles completed but exited non-zero settles failed, as its PTY end reads", async () => {
    // Core settles an interactive session's run `completed` whatever its process exited with.
    // 2026-10-05: two joins whose `claude` could not start read `failed · exited with code 1` and
    // `completed`, depending on whether the PTY watcher or the run's supervision saw the end first.
    const created: Array<CreateOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);
          yield* until(
            () => world.sessions.get(session.id)?.settledAt != null,
            "the session to settle from its run",
          );
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          expect(world.sessions.get(session.id)?.summary).toContain("exited with code 1");
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            record: () => Stream.empty,
            waitRun: () =>
              Effect.succeed({
                ...fakeExecRun,
                result: { status: "completed", outcome: "completed", exitCode: 1 },
              }),
          },
        }),
      },
    );
  });

  it("an agent that ends before it draws takes its starting words with it", async () => {
    const created: Array<CreateOptions> = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);
          yield* engine.openShell(session.id);
          expect(world.sessions.get(session.id)?.summary).toBe(
            "claude is starting on the new machine",
          );
          const agent = [...world.processes.values()].find(
            (process) => process.sessionId === session.id && process.kind === "agent-pty",
          );
          if (agent?.sealantSessionId == null) throw new Error("no agent PTY");
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 1,
            outputHighWater: 0n,
          });
          yield* until(
            () => world.processes.get(agent.id)?.exitedAt != null,
            "the agent's end to be observed",
          );
          // A shell still holds the workspace, so nothing settled over the line: the words went
          // with the agent.
          yield* until(
            () => !(world.sessions.get(session.id)?.summary ?? "").includes("claude is starting"),
            "the starting words to go with the agent",
          );
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ptyStates,
        ),
      },
    );
  });
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

  it("finishes while a folded session's executor is still to be drained: the row settles inline, its tail runs forked as the owner", async () => {
    const created: Array<CreateOptions> = [];
    const flushed: string[] = [];
    const flushKinds: CaptureFlushKind[] = [];
    const seen: Array<string> = [];
    const logs: Array<string> = [];
    const startedAt = Date.now();
    // The bound: a build still running at five seconds is the hang, interrupted here so the
    // world is cleaned up and nothing polls on behind the verdict.
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), 5_000);
    try {
      await withEngine(
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
            yield* eventually(
              "the forked tail drained the executor",
              Duration.seconds(3),
              () => flushed.includes(`flush:${workspaceId}`) && flushKinds.includes("final"),
            );
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every((principal) => principal === "user-fixture")).toBe(true);
            // Nobody else swept it: the boot pass owns this session's tail.
            expect(logs.some((line) => line.includes("reaping leftover workspace"))).toBe(false);
          }),
        {
          logs,
          signal: bound.signal,
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
      ).catch((error: unknown) => {
        throw bound.signal.aborted
          ? new Error(
              "the engine did not finish construction within 5 s · startup waited on a session's executor",
            )
          : error;
      });
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);

  it("re-forks the watcher of a live agent process as the session's owner: its exit after the restart settles the session", async () => {
    const created: Array<CreateOptions> = [];
    const seen: Array<string> = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    await withEngine(
      (world) =>
        Effect.gen(function* () {
          expect(world.sessions.get(sessionId)?.settledAt).toBeNull();
          // The agent exits after the restart; the boot watcher polls its PTY every two seconds.
          ptyStates.set("pty-1", { status: "exited", exitCode: 0, outputHighWater: 0n });
          yield* eventually("the session settled on its agent's exit", Duration.seconds(8), () => {
            const session = world.sessions.get(sessionId);
            return session !== undefined && session.settledAt !== null;
          });
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
        prepareWorld: (world, tmp) =>
          seedStoppedBeforeRestart(world, tmp, {
            sessionId,
            runId,
            workspaceId,
            processLive: true,
          }),
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
  }, 15_000);
});
