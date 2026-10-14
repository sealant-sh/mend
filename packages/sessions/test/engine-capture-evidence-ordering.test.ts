import { SealantPlatformError, type WorkspaceStopOptions } from "@mend/sealant";
import { type CaptureCompletionSeal } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, InteractiveSessionStatus } from "@sealant/sdk";
import { Clock, Deferred, Duration, Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { SEAL_STAMP } from "./engine-capture-evidence-fixtures.ts";
import {
  flushReport,
  launchOnce,
  lifecycleLayer,
  memorySeals,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import {
  sealantLaunchLayer,
  servedSocketApis,
  type World,
  withEngine,
  withEngineEffect,
} from "./engine/fixture.ts";
/** A sealed executor A with a joined session B on it; B's settling harvest reads unsaved work. */
const joinedObservesUnsaved = (
  world: World,
  tmp: string,
  memory: ReturnType<typeof makeMemoryCaptureStore>,
  records: Map<string, CaptureCompletionSeal>,
  answer: { current: "clean" | "unsaved" | "lost"; stamp?: object },
  sealOffsetMs = -5_000,
  unsavedHead: "at-seal" | "before-seal" = "at-seal",
) =>
  Effect.gen(function* () {
    const { engine, session } = yield* launchOnce(world, tmp);
    yield* engine.launch(session.id, ["codex"]);
    const joined = yield* engine.provisionSessionIn(session.worktreeId, {
      harness: "claude",
      label: null,
      ownerUserId: "user-fixture",
    });
    yield* engine.launch(joined.id, ["claude"]);
    const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
    const built = yield* shipHarnessCapture(
      tmp,
      memory,
      session.worktreeId,
      epoch,
      crypto.randomUUID(),
      "final",
    );
    const seal: CaptureCompletionSeal = {
      worktreeId: session.worktreeId,
      epoch,
      executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
      captureId: built.id,
      n: built.manifest.n,
      sealedAt: new Date(Date.now() + sealOffsetMs),
      ...SEAL_STAMP,
    };
    records.set(`${session.worktreeId}:${epoch}`, seal);
    // The executor's unsaved answer is stamped in the seal's boot: after the seal, or before it.
    // As Core's SDK carries sealantd's stamp: `origin`.
    answer.stamp = {
      origin: {
        epoch,
        launch: seal.executorId,
        bootId: SEAL_STAMP.bootId,
        bootGeneration: SEAL_STAMP.bootGeneration,
        observation:
          unsavedHead === "at-seal" ? SEAL_STAMP.observation + 1 : SEAL_STAMP.observation - 1,
        headN: unsavedHead === "at-seal" ? seal.n : seal.n - 1,
      },
    };
    answer.current = "unsaved";
    yield* engine.stop(joined.id);
    yield* until(() => world.captureUnsaved.has(joined.id), "the joined session's unsaved answer");
    yield* until(
      () => world.sessions.get(joined.id)?.settledAt != null,
      "the joined session's settle",
    );
    // The answer was the joined session's to take; the holder's own row holds none.
    expect(world.captureUnsaved.has(session.id)).toBe(false);
    answer.current = "lost";
    return { engine, session, joined, seal };
  });

/**
 * Review 2026-09-28 (5): evidence is per physical executor (cross-repo decision 14) — an answer a
 * joined session took from the executor it shares describes the same disk — and an unresolved
 * create's ownership outlives a later attempt's refusal.
 */
describe("SessionEngine fifth review (2026-09-28)", () => {
  /** Only the second call after the seal answers (unsaved); every other answer is lost. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const flushOf = (answer: { current: "clean" | "unsaved" | "lost"; stamp?: object }) => {
    let afterSeal = 0;
    return () =>
      answer.current === "lost" || (answer.current === "unsaved" && ++afterSeal !== 2)
        ? Effect.fail(
            new SealantPlatformError({
              code: "connection_closed",
              status: null,
              message: "relay closed",
              cause: null,
            }),
          )
        : Effect.succeed(
            answer.current === "unsaved"
              ? {
                  ...flushReport(0, 1),
                  ...answer.stamp,
                  complete: false,
                  incompleteReason: "snapshot-failed",
                  unreadable: 1,
                  unreadablePaths: ["tree/after-seal.txt"],
                }
              : flushReport(0, 0),
          );
  };

  it(
    "#3 an owner's lost FINAL never attests an older seal once a joined session observed unsaved work on the same executor",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* joinedObservesUnsaved(
              world,
              tmp,
              memory,
              records,
              answer,
            );
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the owner's drain reads not saved",
            );
            expect(stopOptions).toEqual([]);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          }),
        },
      );
    },
  );

  it(
    "#3 an owner's executor ending outside Mend reads the joined session's later unsaved answer, never saved",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      let dead = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { session } = yield* joinedObservesUnsaved(world, tmp, memory, records, answer);
            dead = true;
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("no agent PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the owner's settle",
            );
            const settled = world.sessions.get(session.id);
            expect(settled?.summary).not.toContain("stopped outside Mend · saved at");
            expect(settled?.summary).toContain("executor lost · last saved");
            expect(settled?.summary).toContain("unreadable tree/after-seal.txt");
            expect(settled?.status).toBe("failed");
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            () => dead,
            undefined,
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          ),
        },
      );
    },
  );

  // Review 2026-09-28 (6) #6, cross-repo decision 17 (the reviewer's reproductions): the store
  // stamped the seal sixty seconds ahead of the worker that took the joined session's later
  // unsaved answer. Ordered by wall clocks, the older seal looked newer: the owner's lost FINAL
  // sent the completion attestation (`saved · terminating`), and a natural end read
  // `stopped outside Mend · saved`. Ordered by the executor — the answer came at the seal's head,
  // after it registered — neither happens.
  it(
    "review 6 #6 a store clock ahead never revives a seal over a later unsaved answer: no attestation, no saved",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, seal } = yield* joinedObservesUnsaved(
              world,
              tmp,
              memory,
              records,
              answer,
              60_000,
            );
            const evidence = world.executorEvidence.get("workspace-1")?.unsaved.at(-1);
            expect(evidence?.words).toContain("unreadable");
            // The wall clocks say the seal came last; the executor says otherwise.
            expect(evidence?.at.getTime()).toBeLessThan(seal.sealedAt.getTime());
            expect(evidence?.position?.observation).toBe(SEAL_STAMP.observation + 1);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the owner's drain reads not saved",
            );
            expect(stopOptions.some((options) => options?.completion !== undefined)).toBe(false);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          }),
        },
      );
    },
  );

  it(
    "review 6 #6 a store clock ahead never reads an executor that ended outside Mend saved over a later unsaved answer",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      let dead = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { session } = yield* joinedObservesUnsaved(
              world,
              tmp,
              memory,
              records,
              answer,
              60_000,
            );
            dead = true;
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("no agent PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the owner's settle",
            );
            const settled = world.sessions.get(session.id);
            expect(settled?.summary).not.toContain("stopped outside Mend · saved at");
            expect(settled?.summary).toContain("executor lost · last saved");
            expect(settled?.summary).toContain("unreadable tree/after-seal.txt");
            expect(settled?.status).toBe("failed");
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            () => dead,
            undefined,
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          ),
        },
      );
    },
  );

  // The other direction of the same order: an unsaved answer the executor made before its seal
  // (an earlier head) is covered by the seal even when the store's clock runs behind the worker's
  // — the seal stands for the lost FINAL answer and is attested.
  it(
    "review 6 #6 a seal the executor made after an unsaved answer stands for a lost FINAL answer, whatever the clocks say",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, seal } = yield* joinedObservesUnsaved(
              world,
              tmp,
              memory,
              records,
              answer,
              -60_000,
              "before-seal",
            );
            const evidence = world.executorEvidence.get("workspace-1")?.unsaved.at(-1);
            expect(evidence?.at.getTime()).toBeGreaterThan(seal.sealedAt.getTime());
            expect(evidence?.position?.observation).toBe(SEAL_STAMP.observation - 1);
            yield* engine.stop(session.id);
            yield* until(
              () => stopOptions.some((options) => options?.completion !== undefined),
              "the owner attests the seal",
            );
            const completion = stopOptions.find((options) => options?.completion)?.completion;
            expect(completion?.captureN).toBe(seal.n);
            // Core orders the attestation by the seal's own stamp, never by `sealedAt`.
            expect(completion?.origin).toEqual({
              epoch: seal.epoch,
              launch: seal.executorId,
              bootId: SEAL_STAMP.bootId,
              bootGeneration: SEAL_STAMP.bootGeneration,
              observation: SEAL_STAMP.observation,
              headN: seal.n,
            });
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          }),
        },
      );
    },
  );

  // Review 2026-09-28 (6) #6, cross-repo decision 18: an answer asked of the executor and not yet
  // recorded may say anything — while one is in flight no seal stands and nothing is attested;
  // once it is recorded (clean here), the kept drain attests.
  it.effect(
    "review 6 #6 while an answer of the executor is in flight, its seal is not attested; once recorded, it is",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const logs: Array<string> = [];
        const gate = yield* Deferred.make<void>();
        const asked = yield* Deferred.make<void>();
        let sealed = false;
        yield* withEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              yield* engine.launch(session.id, ["codex"]);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const built = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                crypto.randomUUID(),
                "final",
              );
              records.set(`${session.worktreeId}:${epoch}`, {
                worktreeId: session.worktreeId,
                epoch,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(yield* Clock.currentTimeMillis),
                ...SEAL_STAMP,
              });
              sealed = true;
              // A status read of the executor is asked, and its answer held on the way.
              yield* engine.refreshCaptureStatus(session.id);
              yield* Deferred.await(asked);
              expect(
                [...world.evidenceFences.values()].some(
                  (fence) => fence.workspaceId === "workspace-1",
                ),
              ).toBe(true);
              yield* Effect.forkChild(engine.stop(session.id));
              yield* TestClock.withLive(
                until(
                  () =>
                    world.sessions.get(session.id)?.captureNotSavedAt != null ||
                    stopOptions.some((options) => options?.completion !== undefined),
                  "the owner's drain records its outcome while the answer is in flight",
                ),
              );
              expect(stopOptions.some((options) => options?.completion !== undefined)).toBe(false);
              expect(world.sessions.get(session.id)?.captureNotSavedAt != null).toBe(true);
              expect(logs.some((line) => line.includes("is not recorded yet"))).toBe(true);
              // No attestation throughout the in-flight window, right up to the status read's
              // 10 s deadline. At the deadline an unanswered read legitimately closes its fence.
              yield* TestClock.adjust(Duration.millis(9_999));
              expect(yield* Deferred.isDone(gate)).toBe(false);
              expect(
                [...world.evidenceFences.values()].some(
                  (fence) => fence.workspaceId === "workspace-1",
                ),
              ).toBe(true);
              expect(stopOptions.some((options) => options?.completion !== undefined)).toBe(false);
              // The answer arrives (nothing unsaved) and is recorded: the kept drain, asking again
              // on its first 10 s backoff, attests the seal for the lost FINAL answer.
              const evidenceVersion = world.executorEvidence.get("workspace-1")?.version ?? 0;
              yield* Deferred.succeed(gate, undefined);
              yield* TestClock.adjust(0);
              expect(
                [...world.evidenceFences.values()].some(
                  (fence) => fence.workspaceId === "workspace-1",
                ),
              ).toBe(false);
              expect(world.executorEvidence.get("workspace-1")?.version).toBeGreaterThan(
                evidenceVersion,
              );
              yield* TestClock.adjust(Duration.millis(1));
              yield* TestClock.withLive(
                until(
                  () => stopOptions.some((options) => options?.completion !== undefined),
                  "the recorded answer permits the kept drain's attestation",
                ),
              );
              expect(stopOptions.some((options) => options?.completion !== undefined)).toBe(true);
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            logs,
            drainPolicy: { stallSeconds: 0 },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopOptions,
                resourceId: () => "container-7f3a",
                finalCompletion: "unreported",
                captureStatus: () => {
                  if (!sealed) return Effect.succeed(null);
                  return Deferred.succeed(asked, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(flushReport(0, 0)),
                  );
                },
                flush: () =>
                  sealed
                    ? Effect.fail(
                        new SealantPlatformError({
                          code: "connection_closed",
                          status: null,
                          message: "relay closed",
                          cause: null,
                        }),
                      )
                    : Effect.succeed(flushReport(0, 0)),
              },
            }),
          },
        );
      }),
    { timeout: 45_000 },
  );

  it(
    "#3 the executor's evidence outlives the session that took it: removing the joined session leaves the owner's seal revoked",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const answer = { current: "clean" as "clean" | "unsaved" | "lost" };
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, joined } = yield* joinedObservesUnsaved(
              world,
              tmp,
              memory,
              records,
              answer,
            );
            // The per-session row goes with the session; the executor's evidence does not.
            world.captureUnsaved.delete(joined.id);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the owner's drain reads not saved",
            );
            expect(stopOptions).toEqual([]);
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          drainPolicy: { stallSeconds: 0 },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: flushOf(answer),
            },
          }),
        },
      );
    },
  );

  it(
    "#13 a retry's 4xx says nothing of the earlier create it repeats: its key, lease and holds stay, and the original launch still heartbeats",
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
            if (original === undefined) throw new Error("missing original reserved create");
            const originalEpoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const api = servedSocketApis.get(session.id)?.captureAs?.(original);
            if (api === undefined) throw new Error("missing launch capture API");
            expect((yield* api.planGet({ worktree_id: null, epoch: 0 })).epoch).toBe(originalEpoch);
            // Lookup still sees nothing, but the original request may commit after it; a 404 from
            // validation before the platform's idempotent replay cannot disprove that executor.
            lose = false;
            const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.status).toBe(404);
            expect(createKeys).toEqual([original, original]);
            expect(world.executorCreates.get(session.id)).toBe(original);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            expect(memory.leases.get(session.worktreeId)?.epoch).toBe(originalEpoch);
            expect(yield* engine.captureHolds(session.worktreeId)).not.toEqual([]);
            yield* api.heartbeat({ worktree_id: session.worktreeId, epoch: originalEpoch });
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
            undefined,
            undefined,
            () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "WorkspaceNotFoundError",
                  status: 404,
                  message: "Unknown registry: prior",
                  cause: null,
                }),
              ),
            undefined,
            undefined,
            { createKeys, findByKey: () => ({ kind: "none" }), loseCreateAnswer: () => lose },
          ),
        },
      );
    },
  );
});
