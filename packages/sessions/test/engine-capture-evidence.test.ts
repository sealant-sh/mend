import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Project, Session, withUnsavedAnswer, executorEndOf } from "@mend/domain/workbench";
import { type HostUserNamespaces, hostUserNamespacesRefusal } from "@mend/domain/workbench";
import { SealantPlatformError, type WorkspaceStopOptions } from "@mend/sealant";
import {
  type CaptureCompletionSeal,
  SessionEngine,
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  SessionSocketHost,
  WorkspaceHostUserNamespaces,
} from "@mend/sessions";
import { captureKeys, DeploymentConfig, SHALLOW_REPOSITORY_REASON } from "@mend/store";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Clock, Context, Deferred, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import {
  CUSTOM_BASE,
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
  type World,
  withEngine,
  withEngineEffect,
} from "./engine/fixture.ts";

/**
 * An answer the executor gave after `seal`, kept as the repository keeps it: the next number in
 * the seal's boot (cross-repo decision 17 orders it, not `at`).
 */
const unsavedAfterSeal = (
  world: World,
  workspaceId: string,
  seal: CaptureCompletionSeal,
  answer: { readonly at: Date; readonly words: string },
) => {
  const kept = world.executorEvidence.get(workspaceId);
  world.executorEvidence.set(workspaceId, {
    workspaceId,
    launchId: kept?.launchId ?? seal.executorId,
    saved: kept?.saved ?? null,
    unsaved: withUnsavedAnswer(kept?.unsaved ?? [], {
      workspaceId,
      ...answer,
      position: {
        epoch: seal.epoch,
        launchId: seal.executorId,
        bootId: seal.bootId ?? null,
        bootGeneration: seal.bootGeneration ?? null,
        observation: (seal.observation ?? 0) + 1,
        headN: seal.n,
      },
    }),
    version: (kept?.version ?? 0) + 1,
  });
};

/** Where sealantd stamps the fixtures' seals in its own order (boot `boot-1`, observation 100). */
const SEAL_STAMP = { bootId: "boot-1", bootGeneration: 1, observation: 100 } as const;

describe("SessionEngine received evidence beats stored evidence (review 2026-09-28 (4))", () => {
  /** A final seal the store holds for the session's current launch and epoch. */
  const sealCurrent = (
    world: World,
    tmp: string,
    memory: MemoryCaptureStore,
    records: Map<string, CaptureCompletionSeal>,
    session: Session,
  ) =>
    Effect.gen(function* () {
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
        sealedAt: new Date(Date.now() - 5_000),
        ...SEAL_STAMP,
      };
      records.set(`${session.worktreeId}:${epoch}`, seal);
      return seal;
    });

  it(
    "#1 an older seal never stands for a FINAL answer received incomplete: no saved, no terminate, no attestation",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* sealCurrent(world, tmp, memory, records, session);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain's not saved",
            );
            expect(stopOptions).toEqual([]);
            expect(logs.some((line) => line.includes("capture drain · saved · terminating"))).toBe(
              false,
            );
            // The answer is kept: the seal no longer stands for this executor.
            expect(world.captureUnsaved.get(session.id)?.words).toBe(
              "unreadable tree/after-seal.txt",
            );
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          logs,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  complete: false,
                  incompleteReason: "snapshot-failed",
                  unreadable: 1,
                  unreadablePaths: ["tree/after-seal.txt"],
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "#1 an unsaved answer observed after the seal revokes it: a lost FINAL answer then terminates nothing",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const seal = yield* sealCurrent(world, tmp, memory, records, session);
            const workspaceId = world.sessions.get(session.id)?.sealantWorkspaceId ?? "";
            unsavedAfterSeal(world, workspaceId, seal, {
              at: new Date(Date.now() + 1_000),
              words: "incomplete · changed",
            });
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain's not saved",
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
              // Every answer lost on the way.
              flush: () =>
                Effect.fail(
                  new SealantPlatformError({
                    code: "connection_closed",
                    status: null,
                    message: "the relay closed",
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
    "#9 a `docker stop` after the seal and a later unsaved answer reads the last confirmed save and what came after it, never saved",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      let stopped = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const seal = yield* sealCurrent(world, tmp, memory, records, session);
            // Taken a moment after the head registered.
            const unsavedAt = new Date(Date.now() + 1_000);
            unsavedAfterSeal(
              world,
              world.sessions.get(session.id)?.sealantWorkspaceId ?? "",
              seal,
              {
                at: unsavedAt,
                words: "4.1 KB pending",
              },
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
            expect(settled?.summary).toContain("executor lost · last saved");
            expect(settled?.summary).toContain(
              `4.1 KB pending at ${unsavedAt.toISOString().slice(11, 19)} UTC`,
            );
            expect(settled?.summary).not.toContain(
              `saved at ${seal.sealedAt.toISOString().slice(11, 19)} UTC · capture`,
            );
          }),
        {
          captured: memory,
          seals: memorySeals(records),
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
});

/** POST one capture route on the network session channel with a bearer token. */
const channelPost = (
  address: string,
  route: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const [host, port] = address.split(":");
    const request = http.request(
      {
        host,
        port: Number(port),
        method: "POST",
        path: route,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        agent: false,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            json: text === "" ? {} : JSON.parse(text),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });

describe("SessionEngine launch-bound capture routes through the network channel (review 2026-09-28 (4) #10)", () => {
  it(
    "a cold boot planning before its create answers is its launch, over the real engine → registry → HTTP path; another launch's valid token never reads as it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const createKeys: Array<string | undefined> = [];
      const registry = Effect.runSync(
        Effect.scoped(
          Layer.build(SessionChannelRegistryLive).pipe(
            Effect.map((context) => Context.get(context, SessionChannelRegistry)),
          ),
        ),
      );
      const tokens = Effect.runSync(
        Effect.scoped(
          Layer.build(SessionChannelTokensRepoMemory).pipe(
            Effect.map((context) => Context.get(context, SessionChannelTokensRepo)),
          ),
        ),
      );
      const tokensLayer = Layer.succeed(SessionChannelTokensRepo, tokens);
      const channel = { address: "" };
      const answers: Array<{
        readonly phase: string;
        readonly status: number;
        readonly executor: unknown;
      }> = [];
      let sessionRef: SessionId | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const host = yield* Layer.build(
              SessionChannelNetworkHostLive.pipe(
                Layer.provide(Layer.succeed(SessionChannelRegistry, registry)),
                Layer.provide(tokensLayer),
                Layer.provide(
                  Layer.succeed(DeploymentConfig, {
                    mode: "local",
                    sessionEndpoint: { listen: "127.0.0.1:0", url: "http://mend.test:3106" },
                    sessionStore: "captured",
                  }),
                ),
              ),
            ).pipe(Effect.map((context) => Context.get(context, SessionChannelNetworkHost)));
            channel.address = host.address ?? "";
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionRef = session.id;
            yield* engine.launch(session.id, ["codex"]);
            const key = createKeys[0];
            expect(key).toMatch(new RegExp(`^launch:${session.id}:`));
            // Before the create answered: its own launch, never the session id.
            expect(answers[0]).toEqual({ phase: "before-create", status: 200, executor: key });
            // Another launch of the same session holding a valid token of its own never reads
            // as the current launch, and never joins its lease (cross-repo decision 11).
            expect(answers[1]).toEqual({ phase: "other-launch", status: 409, executor: undefined });
            const source = created[0]?.source;
            const token = source?.kind === "capture" ? source.token : "";
            const after = yield* Effect.promise(() =>
              channelPost(channel.address, "/plan.get", token, { worktree_id: null, epoch: 0 }),
            );
            expect(after.status).toBe(200);
            expect(after.json["executor"]).toBe(key);
          }),
        {
          captured: memory,
          tokensLayer,
          socketHostLayer: Layer.succeed(SessionSocketHost, {
            start: (sessionId, api) =>
              Effect.sync(() => {
                servedSocketApis.set(sessionId, api);
                registry.register(sessionId, api);
                return "/tmp/mend-test-socket-dir";
              }),
            stop: (sessionId) => Effect.sync(() => registry.unregister(sessionId)),
          }),
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
              createKeys,
              resourceId: () => "container-1",
              findByKey: () => ({ kind: "none" }),
              beforeCreate: (options) =>
                Effect.gen(function* () {
                  const token = options.source?.kind === "capture" ? options.source.token : "";
                  const booted = yield* Effect.promise(() =>
                    channelPost(channel.address, "/plan.get", token, {
                      worktree_id: null,
                      epoch: 0,
                    }),
                  );
                  answers.push({
                    phase: "before-create",
                    status: booted.status,
                    executor: booted.json["executor"],
                  });
                  if (sessionRef === null) throw new Error("no session");
                  const other = yield* tokens.issue(sessionRef, "launch-other");
                  const otherAnswer = yield* Effect.promise(() =>
                    channelPost(channel.address, "/plan.get", other, {
                      worktree_id: null,
                      epoch: 0,
                    }),
                  );
                  answers.push({
                    phase: "other-launch",
                    status: otherAnswer.status,
                    executor: otherAnswer.json["executor"],
                  });
                }),
            },
          ),
        },
      );
    },
  );
});

/** An executor that answers nothing at all. */
const notAnswering = () =>
  Effect.fail(
    new SealantPlatformError({
      code: "connection_closed",
      status: null,
      message: "the executor did not answer",
      cause: null,
    }),
  );

describe("SessionEngine status words from the latest observation (e2e run 6 #7)", () => {
  it(
    "a session settled `executor not answering · … · completion unknown` whose executor later saves and ends reads `stopped · saved at …`",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let answering = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent === undefined || agent.sealantSessionId === null) {
              throw new Error("the launch recorded no agent PTY");
            }
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the session's settle",
            );
            expect(world.sessions.get(session.id)?.summary).toMatch(/^executor not answering · /);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept",
            );
            // Recovered: it answers its final flush complete, and the kept drain's next round
            // terminates it.
            answering = true;
            for (let round = 0; round < 50; round += 1) {
              if (world.sessions.get(session.id)?.summary?.startsWith("saved at ") === true) break;
              yield* engine.reapCaptureLeases();
              yield* Effect.sleep(Duration.millis(100));
            }
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("stopped");
            expect(settled?.summary).toMatch(/^saved at \d\d:\d\d:\d\d UTC( · capture \d+)?$/);
          }),
        {
          captured: memory,
          drainPolicy: {
            stallSeconds: 0,
            keptRetryFirst: Duration.millis(100),
            keptRetryMax: Duration.millis(200),
          },
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
            undefined,
            undefined,
            {
              flush: () => (answering ? Effect.succeed(flushReport(0, 1)) : notAnswering()),
            },
          ),
        },
      );
    },
  );

  it(
    "a create Core fenced before it made anything, found by the reaper, settles `stopped · launch cancelled · nothing was created` — never `starting` with no executor",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            // A launch cut short around its create (Mend restarted mid-create): the key is on the
            // row, the session `starting`, and no launch here asks it again.
            world.executorCreates.set(session.id, `launch:${session.id}:${Date.now()}:k`);
            expect(world.sessions.get(session.id)?.status).toBe("starting");
            yield* engine.reapCaptureLeases();
            const settled = world.sessions.get(session.id);
            expect(world.executorCreates.has(session.id)).toBe(false);
            expect(settled?.sealantWorkspaceId).toBeNull();
            expect(settled?.status).toBe("stopped");
            expect(settled?.summary).toBe("launch cancelled · nothing was created");
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
            undefined,
            undefined,
            undefined,
            {
              loseCreateAnswer: () => true,
              findByKey: () => ({ kind: "none" }),
              fenceCreate: () => ({ kind: "cancelled" }),
            },
          ),
        },
      );
    },
  );

  // e2e8 F7: after a failed standby claim, discard and resume, the session read `running · launch
  // failed · the harness never started` — the words of the launch before, not of this one.
  it(
    "a launch that starts clears what an earlier launch that never started left in the summary",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const current = world.sessions.get(session.id);
            if (current === undefined) throw new Error("no session");
            world.sessions.set(
              session.id,
              new Session({
                ...current,
                status: "failed",
                settledAt: new Date(),
                summary: "launch failed · the harness never started",
              }),
            );
            yield* engine.launch(session.id, ["codex"]);
            const after = world.sessions.get(session.id);
            expect(after?.status).toBe("running");
            expect(drawnLine(after?.summary)).toBeNull();
          }),
        { sealantLayer: sealantLaunchLayer(created) },
      );
    },
  );

  // e2e8 (i), L: Mend SIGKILLed 0.12 s after asking the create. Its executor started, exited, and
  // Core's recovery destroyed it; Mend came back, found it by the key, drained it and released the
  // worktree — and the session read `starting`, summary null, with nothing running, until a resume.
  it(
    "a lost create whose executor the reaper finds and drains to its end settles `stopped · launch interrupted · …` — never `starting` with no executor",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            world.executorCreates.set(session.id, `launch:${session.id}:${Date.now()}:k`);
            expect(world.sessions.get(session.id)?.status).toBe("starting");
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.status === "stopped",
              "the interrupted launch settled",
            );
            const settled = world.sessions.get(session.id);
            expect(settled?.sealantWorkspaceId).toBe("workspace-lost");
            expect(settled?.summary).toBe(
              "launch interrupted · the create's answer was lost · its executor ended",
            );
            expect(world.executorCreates.has(session.id)).toBe(false);
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
            undefined,
            undefined,
            undefined,
            {
              loseCreateAnswer: () => true,
              findByKey: () => ({ kind: "found", workspaceId: "workspace-lost" }),
              // Core's recovery already destroyed it: the platform says it is gone.
              status: () => "stopped",
            },
          ),
        },
      );
    },
  );
});

describe("SessionEngine a failed launch's words follow its executor (e2e run 6 #7)", () => {
  it(
    "a launch that failed at a setup command and whose kept executor is then killed reads the loss beside the launch's words, never the launch's words alone",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let killed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept",
            );
            // `docker kill`: the platform reports it gone.
            killed = true;
            for (let round = 0; round < 50; round += 1) {
              if (world.sessions.get(session.id)?.summary?.includes("executor lost") === true)
                break;
              yield* engine.reapCaptureLeases();
              yield* Effect.sleep(Duration.millis(100));
            }
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("failed");
            expect(settled?.summary).toMatch(
              /^launch failed: setup command failed \(exit 1\).* · executor lost · /,
            );
          }),
        {
          captured: memory,
          drainPolicy: {
            stallSeconds: 0,
            terminationWait: Duration.millis(100),
            keptRetryFirst: Duration.millis(100),
            keptRetryMax: Duration.millis(200),
          },
          workspaceImage: { ...CUSTOM_BASE, setupCommands: ["exit 1"] },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: () => "kept",
              status: () => (killed ? "stopped" : "ready"),
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
});

describe("SessionEngine a recovered executor's accepted seal is the session's word (e2e run 6 #7)", () => {
  it(
    "`executor not answering · … · not confirmed`, then Core ends the kept executor on the seal Mend attested and it accepted: `stopped · saved at … · capture N`",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      let ended = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent === undefined || agent.sealantSessionId === null) {
              throw new Error("the launch recorded no agent PTY");
            }
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the session's settle",
            );
            expect(world.sessions.get(session.id)?.summary).toMatch(/not confirmed$/);
            // Core recovered it: it drained, sealed, and ended on its runtime (kept by Core).
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
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
              captureId: built.id,
              n: built.manifest.n,
              sealedAt,
            });
            ended = true;
            for (let round = 0; round < 50; round += 1) {
              if (world.sessions.get(session.id)?.summary?.startsWith("saved at ") === true) break;
              yield* engine.reapCaptureLeases();
              yield* Effect.sleep(Duration.millis(100));
            }
            expect(stopOptions.some((o) => o?.completion?.captureN === built.manifest.n)).toBe(
              true,
            );
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("stopped");
            expect(settled?.summary).toBe(
              `saved at ${sealedAt.toISOString().slice(11, 19)} UTC · capture ${built.manifest.n}`,
            );
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          drainPolicy: {
            stallSeconds: 0,
            terminationWait: Duration.millis(100),
            keptRetryFirst: Duration.millis(100),
            keptRetryMax: Duration.millis(200),
          },
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
            undefined,
            undefined,
            {
              stopOptions,
              resourceId: () => "container-7f3a",
              // Ended on its runtime and kept by Core until the stop: then stopped.
              status: (stopAsked) => (!ended ? "ready" : stopAsked ? "stopped" : "failed"),
              stopAnswer: () => "stopped",
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
          ),
        },
      );
    },
  );
});

/**
 * Review 2026-09-28 (5): evidence is per physical executor (cross-repo decision 14) — an answer a
 * joined session took from the executor it shares describes the same disk — and an unresolved
 * create's ownership outlives a later attempt's refusal.
 */
describe("SessionEngine fifth review (2026-09-28)", () => {
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
      yield* until(
        () => world.captureUnsaved.has(joined.id),
        "the joined session's unsaved answer",
      );
      yield* until(
        () => world.sessions.get(joined.id)?.settledAt != null,
        "the joined session's settle",
      );
      // The answer was the joined session's to take; the holder's own row holds none.
      expect(world.captureUnsaved.has(session.id)).toBe(false);
      answer.current = "lost";
      return { engine, session, joined, seal };
    });

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
