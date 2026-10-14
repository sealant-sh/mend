import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionId } from "@mend/domain";
import { Project, Session, executorEndOf } from "@mend/domain/workbench";
import { type HostUserNamespaces, hostUserNamespacesRefusal } from "@mend/domain/workbench";
import { SealantPlatformError, type WorkspaceStopOptions } from "@mend/sealant";
import {
  type CaptureCompletionSeal,
  SessionEngine,
  WorkspaceHostUserNamespaces,
} from "@mend/sessions";
import { captureKeys, SHALLOW_REPOSITORY_REASON } from "@mend/store";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Duration, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
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
  captureAnswer,
  drawnLine,
  unsavedEvidenceWriteFailure,
  makeWorld,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
} from "./engine/fixture.ts";

describe("SessionEngine seventh review (2026-09-28)", () => {
  // Review 2026-09-28 (7) #4 (the reviewer's reproduction): the owner read `pending: 1` at the
  // executor's observation 99; the executor then sealed at observation 100 and ended. The
  // session's own queue reading was added again without the origin the executor gave it, and the
  // seal that covers it read as lost. The reading keeps its origin: the seal stands.
  it(
    "review 7 #4 an old pending reading the seal covers does not make the executor read lost",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      let dead = false;
      let sample: WorkspaceCaptureStatus | null = null;
      let sealed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
            const built = yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              crypto.randomUUID(),
              "final",
            );
            sample = Object.assign(flushReport(1, 0, { epoch }), {
              origin: {
                epoch,
                launch,
                bootId: "boot-1",
                bootGeneration: 1,
                observation: 99,
                headN: built.manifest.n - 1,
              },
            });
            yield* engine.refreshCaptureStatus(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.capturePending === 1,
              "owner pending status persisted",
            );
            expect(
              world.executorEvidence.get("workspace-1")?.unsaved.at(-1)?.position?.observation,
            ).toBe(99);
            sample = null;
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            dead = true;
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("no PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(() => world.sessions.get(session.id)?.settledAt != null, "natural end");
            const ended = world.sessions.get(session.id);
            expect(ended?.summary).not.toContain("executor lost");
            expect(ended?.status).toBe("stopped");
            expect(ended?.summary).toContain("stopped outside Mend · saved at");
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
              captureStatus: () => Effect.succeed(sample),
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
          ),
        },
      );
    },
  );

  // Review 2026-09-28 (7) #4, the rule under it: evidence nothing orders against a seal (a
  // pending answer the executor gave no origin for) cannot say whether the seal covers it. That
  // is completion unknown — never "changes after that were not saved".
  it(
    "review 7 #4 a pending answer nothing orders against the seal reads completion unknown, never lost",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      let dead = false;
      let sample: WorkspaceCaptureStatus | null = null;
      let sealed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
            const built = yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              crypto.randomUUID(),
              "final",
            );
            // No origin: an older daemon's answer.
            sample = flushReport(1, 0, { epoch });
            yield* engine.refreshCaptureStatus(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.capturePending === 1,
              "owner pending status persisted",
            );
            sample = null;
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            dead = true;
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("no PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(() => world.sessions.get(session.id)?.settledAt != null, "natural end");
            const ended = world.sessions.get(session.id);
            expect(ended?.status).toBe("failed");
            expect(ended?.summary).not.toContain("executor lost");
            expect(ended?.summary).not.toContain("were not saved");
            expect(ended?.summary).toContain("completion unknown");
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
              captureStatus: () => Effect.succeed(sample),
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
          ),
        },
      );
    },
  );

  // Review 2026-09-28 (7) #3 (the reviewer's reproduction): an answer that said the executor held
  // unsaved work arrived after its seal and could not be published as the executor's evidence.
  // The fence that said so lived in the engine's memory; a restart dropped it and the old seal
  // read saved. The fence is durable, and the answer is published with it cleared in one write.
  it(
    "review 7 #3 a restart keeps an answer that failed to persist fenced: the old seal does not read saved",
    { timeout: 30_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-review7-fence-")),
      };
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      let sample: WorkspaceCaptureStatus | null = null;
      let dead = false;
      let sealed = false;
      let sessionId: SessionId | undefined;
      const sealantLayer = sealantLaunchLayer(
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
          resourceId: () => "container-r7",
          finalCompletion: "unreported",
          captureStatus: () => Effect.succeed(sample),
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
      );
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              sessionId = session.id;
              yield* engine.launch(session.id, ["codex"]);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
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
                executorId: launch,
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(),
                ...SEAL_STAMP,
              });
              sealed = true;
              sample = Object.assign(flushReport(0, 1, { epoch }), {
                complete: false,
                incompleteReason: "snapshot-failed",
                unreadable: 1,
                unreadablePaths: ["tree/after-seal.txt"],
                origin: {
                  epoch,
                  launch,
                  bootId: "boot-1",
                  bootGeneration: 1,
                  observation: 101,
                  headN: built.manifest.n,
                },
              });
              unsavedEvidenceWriteFailure.enabled = true;
              yield* engine.refreshCaptureStatus(session.id);
              yield* Effect.sleep(Duration.millis(50));
              sample = null;
              expect(world.executorEvidence.get("workspace-1")?.unsaved ?? []).toEqual([]);
            }),
          { fixture, captured: memory, seals: memorySeals(records), sealantLayer },
        );
        unsavedEvidenceWriteFailure.enabled = false;
        dead = true;
        const agent = [...fixture.world.processes.values()].find(
          (process) => process.sessionId === sessionId && process.kind === "agent-pty",
        );
        if (agent?.sealantSessionId == null) throw new Error("no PTY");
        ptyStates.set(agent.sealantSessionId, {
          status: "exited",
          exitCode: 0,
          outputHighWater: 0n,
        });
        // A new engine over the same world: the process-local state is gone.
        await withEngine(
          (world) =>
            Effect.gen(function* () {
              yield* SessionEngine;
              yield* until(
                () => sessionId !== undefined && world.sessions.get(sessionId)?.settledAt != null,
                "the restarted engine settles the ended executor",
              );
              const ended = sessionId === undefined ? undefined : world.sessions.get(sessionId);
              expect(ended?.summary).not.toContain("saved at");
              expect(ended?.status).toBe("failed");
              expect(ended?.summary).toContain("completion unknown");
            }),
          { fixture, captured: memory, seals: memorySeals(records), sealantLayer },
        );
      } finally {
        unsavedEvidenceWriteFailure.enabled = false;
      }
    },
  );

  // Review 2026-09-28 (8) #4 (the reviewer's reproduction): a flush answered that the executor
  // held unsaved work, and the log line written before its publication failed. The fence was
  // marked answered only once publication began, so it closed as `unanswered` and the answer was
  // forgotten; after a restart the old seal read saved. Receipt is marked the moment the answer
  // arrives, it is published before anything is logged, and a log that fails changes no evidence.
  it(
    "review 8 #4 a log that fails after an unsaved answer arrives does not revive the old seal",
    { timeout: 30_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-log-fence-")),
      };
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      let sample: WorkspaceCaptureStatus | null = null;
      let failedLog = false;
      const logs: Array<string> = [];
      logs.push = (...items: Array<string>) => {
        if (
          !failedLog &&
          sample !== null &&
          items.some((line) => line.includes("capture flush · partial"))
        ) {
          failedLog = true;
          throw new Error("log sink unavailable after the unsaved answer arrived");
        }
        return Array.prototype.push.apply(logs, items);
      };
      let dead = false;
      let sealed = false;
      let sessionId: SessionId | undefined;
      const sealantLayer = sealantLaunchLayer(
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
          resourceId: () => "container-r8",
          finalCompletion: "unreported",
          captureStatus: () => Effect.succeed(sample),
          flush: () =>
            sealed
              ? sample !== null
                ? Effect.succeed(sample)
                : Effect.fail(
                    new SealantPlatformError({
                      code: "connection_closed",
                      status: null,
                      message: "relay closed",
                      cause: null,
                    }),
                  )
              : Effect.succeed(flushReport(0, 0)),
        },
      );
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionId = session.id;
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
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
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "snapshot-failed",
              unreadable: 1,
              unreadablePaths: ["tree/after-seal.txt"],
              origin: {
                epoch,
                launch,
                bootId: "boot-1",
                bootGeneration: 1,
                observation: 101,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "review 8 #4").pipe(Effect.exit);
            yield* Effect.sleep(Duration.millis(50));
            sample = null;
            expect(failedLog).toBe(true);
            // The answer is the executor's evidence, however the log after it went.
            expect(world.executorEvidence.get("workspace-1")?.unsaved ?? []).not.toEqual([]);
          }),
        { fixture, captured: memory, seals: memorySeals(records), sealantLayer, logs },
      );
      dead = true;
      const agent = [...fixture.world.processes.values()].find(
        (process) => process.sessionId === sessionId && process.kind === "agent-pty",
      );
      if (agent?.sealantSessionId == null) throw new Error("no PTY");
      ptyStates.set(agent.sealantSessionId, {
        status: "exited",
        exitCode: 0,
        outputHighWater: 0n,
      });
      // A new engine over the same world: the process-local state is gone.
      await withEngine(
        (world) =>
          Effect.gen(function* () {
            yield* SessionEngine;
            yield* until(
              () => sessionId !== undefined && world.sessions.get(sessionId)?.settledAt != null,
              "the restarted engine settles the ended executor",
            );
            const ended = sessionId === undefined ? undefined : world.sessions.get(sessionId);
            expect(ended?.summary).not.toContain("saved at");
            expect(ended?.status).toBe("failed");
          }),
        { fixture, captured: memory, seals: memorySeals(records), sealantLayer, logs },
      );
    },
  );
});

/**
 * Review 2026-09-28 (9): evidence nothing orders is kept, never erased by a later answer
 * (cross-repo decision 25), and a report follows the event it names (decision 28).
 */
describe("SessionEngine ninth review (2026-09-28)", () => {
  // #4 (the reviewer's engine sequence): boot A sealed at observation 100; recovery boot B
  // (generation 0, ordered against nothing) answered a failed snapshot; a delayed answer boot A
  // made before its seal replaced B's, the seal covered that one, and a lost FINAL answer then
  // sent Core an attestation for the old seal.
  it(
    "#4 a delayed older answer after a recovery boot's failure never revives the old seal: no attestation",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      let sample: WorkspaceCaptureStatus | null = null;
      let sealed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
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
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            // What sealantd answers beyond the SDK's type (`complete`, `origin`, …), as carried.
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "snapshot-failed",
              unreadable: 1,
              unreadablePaths: ["tree/recovery-work.txt"],
              origin: {
                epoch,
                launch,
                bootId: "recovery-boot",
                bootGeneration: 0,
                observation: 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "recovery boot's failure");
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "in-progress",
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation - 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "delayed pre-seal answer");
            // Every later answer is lost: only what is kept decides.
            sample = null;
            yield* engine.stop(session.id);
            // The drain either reads not saved, or (the defect) attests the old seal and stops.
            yield* until(
              () =>
                world.sessions.get(session.id)?.captureNotSavedAt != null || stopOptions.length > 0,
              "the drain's outcome",
            );
            expect(stopOptions.filter((options) => options?.completion !== undefined)).toEqual([]);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
            // Both answers the seal cannot be ordered after are kept.
            const kept = world.executorEvidence.get("workspace-1")?.unsaved ?? [];
            expect(kept.map((answer) => answer.position?.bootId).toSorted()).toEqual([
              SEAL_STAMP.bootId,
              "recovery-boot",
            ]);
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          drainPolicy: { stallSeconds: 0 },
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
              stopOptions,
              resourceId: () => "r9-container",
              finalCompletion: "unreported",
              flush: () =>
                sealed
                  ? sample !== null
                    ? Effect.succeed(sample)
                    : Effect.fail(
                        new SealantPlatformError({
                          code: "connection_closed",
                          status: null,
                          message: "relay closed",
                          cause: null,
                        }),
                      )
                  : Effect.succeed(flushReport(0, 0)),
            },
          ),
        },
      );
    },
  );

  // #10 (the reviewer's instrumented regression): `unsaved captures discarded by the owner` was
  // logged before the platform was asked, and stood when the platform kept the workspace (409,
  // `nothing discarded yet`). The request is logged before the stop; the discard only once the
  // platform confirmed the end.
  it(
    "#10 a discard the platform refuses logs the request, never `discarded`; a confirmed one logs it after the end",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const stops: Array<"drain" | "discard"> = [];
      const logs: Array<string> = [];
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
            const refused = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
              "workspace_not_ended",
            );
            const discardedLines = () =>
              logs.filter((line) => line.includes("unsaved captures discarded by the owner"));
            expect(discardedLines()).toEqual([]);
            expect(
              logs.filter((line) => line.includes("discard of unsaved captures requested")),
            ).toHaveLength(1);
            expect(
              logs.some((line) => line.includes("the platform has not ended the workspace")),
            ).toBe(true);
            platformKeeps = false;
            yield* engine.discardUnsavedAndStop(session.id);
            expect(stops).toEqual(["discard", "discard"]);
            expect(discardedLines()).toHaveLength(1);
            // Logged after the platform's end, never before its stop was asked.
            const requested = logs.findLastIndex((line) =>
              line.includes("discard of unsaved captures requested"),
            );
            expect(logs.findIndex((line) => discardedLines().includes(line))).toBeGreaterThan(
              requested,
            );
          }),
        {
          captured: memory,
          logs,
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
});

// Review 2026-09-28 (10) #7, cross-repo decision 31: the drain's direct FINAL answer reads saved
// only by the decision a seal and an end are read by — bound to this executor and epoch, made
// after every unsaved answer its evidence keeps, every answer published — never by the reading
// alone. Both keep the executor, attest nothing and log no `saved`.
describe("review 10 #7 a direct complete answer", () => {
  it(
    "review 10 #7 a direct complete does not read saved over a retained unsaved answer nothing orders against it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      let sample: WorkspaceCaptureStatus | null = null;
      let sealed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
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
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            // What sealantd answers beyond the SDK's type (`complete`, `origin`, …), as carried.
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "snapshot-failed",
              unreadable: 1,
              unreadablePaths: ["tree/recovery-work.txt"],
              origin: {
                epoch,
                launch,
                bootId: "recovery-boot",
                bootGeneration: 0,
                observation: 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "recovery boot's failure");
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "in-progress",
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation - 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "delayed pre-seal answer");
            // The drain's FINAL is answered by a delayed complete from the old boot.
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: true,
              incompleteReason: null,
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation,
                headN: built.manifest.n,
              },
            });
            yield* engine.stop(session.id);
            yield* until(
              () =>
                world.sessions.get(session.id)?.captureNotSavedAt != null || stopOptions.length > 0,
              "the drain's outcome",
            );
            // The drain reads not saved: no attestation, no stop, no saved line.
            expect(stopOptions.filter((options) => options?.completion !== undefined)).toEqual([]);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
            expect(stopOptions).toEqual([]);
            expect(world.sessions.get(session.id)?.captureNotSavedAt).not.toBeNull();
            expect(
              logs.some((line) =>
                line.includes(
                  "the final flush answered complete, but the executor's evidence does not read saved",
                ),
              ),
            ).toBe(true);
            // Both answers the seal cannot be ordered after are kept.
            const evidence = world.executorEvidence.get("workspace-1");
            const kept = evidence?.unsaved ?? [];
            expect(
              executorEndOf({
                head: null,
                executorStartedAt: null,
                reading: { pending: null, pendingBytes: null, observedAt: null },
                finalSaved: evidence?.saved ?? null,
                unsaved: kept,
              }).kind,
            ).not.toBe("saved");
            expect(kept.map((answer) => answer.position?.bootId).toSorted()).toEqual([
              SEAL_STAMP.bootId,
              "recovery-boot",
            ]);
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          drainPolicy: { stallSeconds: 0 },
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
              stopOptions,
              resourceId: () => "r9-container",
              finalCompletion: "unreported",
              flush: () =>
                sealed
                  ? sample !== null
                    ? Effect.succeed(sample)
                    : Effect.fail(
                        new SealantPlatformError({
                          code: "connection_closed",
                          status: null,
                          message: "relay closed",
                          cause: null,
                        }),
                      )
                  : Effect.succeed(flushReport(0, 0)),
            },
          ),
        },
      );
    },
  );

  it(
    "review 10 #7 a direct complete does not read saved over an unsaved answer the executor made after it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      let sample: WorkspaceCaptureStatus | null = null;
      let sealed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const launch = world.executorLaunches.get(session.id)?.launchId ?? "";
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
              executorId: launch,
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            // What sealantd answers beyond the SDK's type (`complete`, `origin`, …), as carried.
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "snapshot-failed",
              unreadable: 1,
              unreadablePaths: ["tree/recovery-work.txt"],
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation + 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "recovery boot's failure");
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: false,
              incompleteReason: "in-progress",
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation - 1,
                headN: built.manifest.n,
              },
            });
            yield* engine.flushCaptures(session.id, "delayed pre-seal answer");
            // The drain's FINAL is answered by a delayed complete from the old boot.
            sample = Object.assign(flushReport(0, 1, { epoch }), {
              complete: true,
              incompleteReason: null,
              origin: {
                epoch,
                launch,
                bootId: SEAL_STAMP.bootId,
                bootGeneration: SEAL_STAMP.bootGeneration,
                observation: SEAL_STAMP.observation,
                headN: built.manifest.n,
              },
            });
            yield* engine.stop(session.id);
            yield* until(
              () =>
                world.sessions.get(session.id)?.captureNotSavedAt != null || stopOptions.length > 0,
              "the drain's outcome",
            );
            // The drain reads not saved: no attestation, no stop, no saved line.
            expect(stopOptions.filter((options) => options?.completion !== undefined)).toEqual([]);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
            expect(stopOptions).toEqual([]);
            expect(world.sessions.get(session.id)?.captureNotSavedAt).not.toBeNull();
            expect(
              logs.some((line) =>
                line.includes(
                  "the final flush answered complete, but the executor's evidence does not read saved",
                ),
              ),
            ).toBe(true);
            // Both answers the seal cannot be ordered after are kept.
            const evidence = world.executorEvidence.get("workspace-1");
            const kept = evidence?.unsaved ?? [];
            expect(
              executorEndOf({
                head: null,
                executorStartedAt: null,
                reading: { pending: null, pendingBytes: null, observedAt: null },
                finalSaved: evidence?.saved ?? null,
                unsaved: kept,
              }).kind,
            ).not.toBe("saved");
            expect(kept).toHaveLength(1);
            expect(kept[0]?.position?.observation).toBe(SEAL_STAMP.observation + 1);
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          drainPolicy: { stallSeconds: 0 },
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
              stopOptions,
              resourceId: () => "r9-container",
              finalCompletion: "unreported",
              flush: () =>
                sealed
                  ? sample !== null
                    ? Effect.succeed(sample)
                    : Effect.fail(
                        new SealantPlatformError({
                          code: "connection_closed",
                          status: null,
                          message: "relay closed",
                          cause: null,
                        }),
                      )
                  : Effect.succeed(flushReport(0, 0)),
            },
          ),
        },
      );
    },
  );
});

/**
 * Carried review 2026-09-28 (10) #6 (cross-repo decision 35): a final flush Core's deadline or the
 * daemon's own shutdown asked for runs with no Mend drain, so its uploads used to be metered, and a
 * held tree past the byte quota stayed unsaved (413). sealantd now names the flush on the wire
 * (`"flush":"final"`): exempt from the byte and call quotas whether or not Mend drains.
 */
it(
  "exempts an upload.urls call marked flush: final from the byte quota before any Mend drain",
  { timeout: 20_000 },
  async () => {
    const memory = makeMemoryCaptureStore();
    const created: Array<CreateOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          const launch = world.executorLaunches.get(session.id)?.launchId;
          if (launch === undefined) throw new Error("missing launch");
          const api = servedSocketApis.get(session.id)?.captureAs?.(launch);
          if (api === undefined) throw new Error("missing live capture API");
          const epoch = memory.leases.get(session.worktreeId)?.epoch;
          if (epoch === undefined) throw new Error("missing lease");
          const key = captureKeys(session.worktreeId, epoch).pack("e".repeat(64));
          const input = {
            worktree_id: session.worktreeId,
            epoch,
            keys: [key],
            sizes: { [key]: 8 * 1024 * 1024 * 1024 + 1 },
          };
          expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
          // New work over the quota is still refused.
          const refused = yield* api.uploadUrls(input).pipe(Effect.flip);
          expect(refused.status).toBe(413);
          expect(refused.reason).toBe("byte-quota");
          // The same bytes from a final flush Mend did not start: admitted.
          const allowed = yield* api.uploadUrls({ ...input, flush: "final" });
          expect([...Object.keys(allowed.urls), ...Object.keys(allowed.multipart ?? {})]).toContain(
            key,
          );
          expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created) },
    );
  },
);

/**
 * Owner, 2026-09-28 (e2e8 (d)): Mend does not support SHA-256 or reftable repositories yet. A
 * project adopted before adoption refused them starts no session: the start is refused with the
 * reason, before any worktree, row or executor is made.
 */
it("refuses to start a session on a SHA-256 project with the reason", async () => {
  await withEngine((world, tmp) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      // A SHA-256 repository with a main branch, as an adoption before the refusal stored it.
      const work = path.join(tmp, "sha256-work");
      const sha256 = path.join(tmp, "sha256.git");
      execFileSync("git", ["init", "-q", "-b", "main", "--object-format=sha256", work]);
      fs.writeFileSync(path.join(work, "app.ts"), "export const answer = 41\n");
      execFileSync("git", ["add", "-A"], { cwd: work });
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "one"],
        { cwd: work },
      );
      execFileSync("git", ["clone", "-q", "--bare", work, sha256]);
      world.projects.set(project.id, new Project({ ...project, storePath: sha256 }));
      const engine = yield* SessionEngine;
      const refused = yield* engine
        .provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          base: null,
        })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("GitError");
      if (refused._tag === "GitError") {
        expect(refused.stderr).toBe("Mend doesn't support SHA-256 repositories yet.");
      }
      expect(world.sessions.size).toBe(0);
    }),
  );
});

/**
 * Verify proof run 9 (2026-10-10): a shallow project's Stop never saved. Adoption refuses a shallow
 * repository now; one adopted before that starts no session, with the reason, before any worktree,
 * row or executor is made.
 */
it("refuses to start a session on a shallow project with the reason", async () => {
  await withEngine((world, tmp) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const work = path.join(tmp, "shallow-work");
      const shallow = path.join(tmp, "shallow.git");
      execFileSync("git", ["init", "-q", "-b", "main", work]);
      for (const message of ["one", "two"]) {
        fs.writeFileSync(path.join(work, "app.ts"), `export const answer = "${message}"\n`);
        execFileSync("git", ["add", "-A"], { cwd: work });
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", message],
          { cwd: work },
        );
      }
      // As an adoption before the refusal stored it: history stops at the newest commit.
      execFileSync("git", ["clone", "-q", "--bare", "--depth", "1", `file://${work}`, shallow]);
      world.projects.set(project.id, new Project({ ...project, storePath: shallow }));
      const engine = yield* SessionEngine;
      const refused = yield* engine
        .provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          base: null,
        })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("GitError");
      if (refused._tag === "GitError") expect(refused.stderr).toBe(SHALLOW_REPOSITORY_REASON);
      expect(world.sessions.size).toBe(0);
    }),
  );
});

/**
 * e2e8 (i), HSB: an executor stopped outside Mend that Core keeps for recovery (exit 75) read
 * `running` beside `retained`. The first word follows the executor: a session whose current
 * executor the platform keeps for recovery reads `stopping · retained`, never `running`.
 */
it(
  "a session whose executor the platform keeps for recovery reads stopping, not running",
  { timeout: 20_000 },
  async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const stops: Array<"drain" | "discard"> = [];
    let killed = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(world.sessions.get(session.id)?.status).toBe("running");
          killed = true;
          const afterExpiry = Date.now() + 1_000_000;
          memory.clock.now = () => afterExpiry;
          yield* engine.reapCaptureLeases();
          yield* until(
            () => world.sessions.get(session.id)?.captureNotSavedAt != null,
            "the kept executor",
          );
          const kept = world.sessions.get(session.id);
          expect(kept?.captureIncompleteReason).toBe("retained");
          expect(kept?.status).toBe("stopping");
        }),
      {
        captured: memory,
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

/**
 * Fresh install on Ubuntu 24.04: its kernel refuses unprivileged user namespaces, so every
 * workspace's rootless Docker service failed after minutes of image build, in Docker's words. A
 * launch on such a host now fails before anything is created, with doctor's words and the fix;
 * the host is read at each launch, so once the operator applies the setting the next one goes.
 */
it("a launch on a host that refuses user namespaces fails before any workspace is created, and goes once the host allows them", async () => {
  const created: Array<CreateOptions> = [];
  const setting = "kernel.apparmor_restrict_unprivileged_userns = 0";
  let observed: HostUserNamespaces = { allowed: false, setting };
  let reads = 0;
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const { engine, session } = yield* launchOnce(world, tmp);
        const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
        expect(refused).toBeInstanceOf(SealantPlatformError);
        expect(refused.message).toBe(hostUserNamespacesRefusal(setting));
        expect(created).toHaveLength(0);
        const failed = world.sessions.get(session.id);
        expect(failed?.status).toBe("failed");
        expect(failed?.summary).toBe(`launch failed: ${hostUserNamespacesRefusal(setting)}`);

        // The operator applies the setting: no restart, the next launch reads the host again.
        observed = { allowed: true };
        yield* engine.launch(session.id, ["codex"]);
        expect(created).toHaveLength(1);
        expect(world.sessions.get(session.id)?.status).toBe("running");
        expect(reads).toBe(2);
      }),
    {
      sealantLayer: sealantLaunchLayer(created),
      hostUserNamespaces: Layer.succeed(WorkspaceHostUserNamespaces, {
        observe: () =>
          Effect.sync(() => {
            reads += 1;
            return observed;
          }),
      }),
    },
  );
});

/**
 * e2e8 (i), B and WU: a session resumed after its executor was stopped outside Mend and saved read
 * `running · stopped outside Mend · saved at 07:34:21 UTC · capture 13`, the words of the executor
 * before. A launch that starts clears Mend's verdict on an earlier executor's end.
 */
it.each([
  "stopped outside Mend · saved at 07:34:21 UTC · capture 13",
  "saved at 07:42:59 UTC · capture 5",
  "executor not answering · last capture 10 at 07:33:53 UTC · not confirmed",
  "launch failed: Budget reached: 120 launches per minute",
])("a launch that starts clears the earlier executor's summary %s", async (summary) => {
  const created: Array<CreateOptions> = [];
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const { engine, session } = yield* launchOnce(world, tmp);
        const current = world.sessions.get(session.id);
        if (current === undefined) throw new Error("no session");
        world.sessions.set(
          session.id,
          new Session({ ...current, status: "stopped", settledAt: new Date(), summary }),
        );
        yield* engine.launch(session.id, ["codex"]);
        const after = world.sessions.get(session.id);
        expect(after?.status).toBe("running");
        expect(drawnLine(after?.summary)).toBeNull();
      }),
    { sealantLayer: sealantLaunchLayer(created) },
  );
});

it(
  "review 12 #5: a resume into the retained workspace clears `executor not answering` once that executor answered and started the new process",
  { timeout: 30_000 },
  async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    const memory = makeMemoryCaptureStore();
    let answering = true;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          // A Service's open forward retains the workspace across the agent's end.
          const service = yield* engine.addService(session.id, 5432, "db");
          const agent = [...world.processes.values()].find(
            (p) => p.sessionId === session.id && p.kind === "agent-pty",
          );
          if (agent?.sealantSessionId == null) throw new Error("no agent");
          // The agent ends while exec and capture requests fail: the watcher's real verdict.
          answering = false;
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 0,
            outputHighWater: 0n,
          });
          yield* until(
            () =>
              world.sessions.get(session.id)?.summary?.startsWith("executor not answering") ===
              true,
            "the unanswered verdict",
          );
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          expect(world.services.get(service.service.id)?.currentForwardId).not.toBeNull();
          // The connection recovers and the resume opens a new process in the retained workspace.
          answering = true;
          const resumed = yield* engine.resumeSession(session.id, "shell");
          yield* Effect.sleep(Duration.millis(150));
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(resumed.status).toBe("running");
          expect(resumed.summary ?? "").not.toMatch(/executor not answering/);
          expect(world.sessions.get(session.id)?.summary ?? "").not.toMatch(
            /executor not answering/,
          );
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          ptyStates,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            exec: (argv) =>
              answering && argv[0] === "true" ? { exitCode: 0, stdout: "", stderr: "" } : undefined,
            flush: () =>
              answering
                ? Effect.succeed(captureAnswer())
                : Effect.fail(
                    new SealantPlatformError({
                      code: "connection_closed",
                      status: null,
                      message: "executor briefly unreachable",
                      cause: null,
                    }),
                  ),
          },
        ),
      },
    );
  },
);
