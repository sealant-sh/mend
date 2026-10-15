import * as http from "node:http";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Session, withUnsavedAnswer } from "@mend/domain/workbench";
import { SealantPlatformError, type WorkspaceStopOptions } from "@mend/sealant";
import {
  type CaptureCompletionSeal,
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  SessionSocketHost,
} from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Clock, Context, Duration, Effect, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { SEAL_STAMP } from "./engine-capture-evidence-fixtures.ts";
import {
  CUSTOM_BASE,
  flushReport,
  launchOnce,
  lifecycleLayer,
  memorySeals,
  provisionIn,
  shipHarnessCapture,
} from "./engine/capture-fixture.ts";
import {
  EXECUTOR_END_LOOKS,
  POLL_INTERVAL,
  makeEngineClock,
  statusLooks,
} from "./engine/clock-fixture.ts";
import {
  drawnLine,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withEngine,
  withPreparedEngineEffect,
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
      sealedAt: new Date((yield* Clock.currentTimeMillis) - 5_000),
      ...SEAL_STAMP,
    };
    records.set(`${session.worktreeId}:${epoch}`, seal);
    return seal;
  });

/**
 * What these scenarios wait on, beyond the shared clock's signals (`world.sessions`, the PTY
 * watcher's looks, the channel's checkpoint waits): every look at the executor's capture status
 * (the last ask of each of `executorLostOnEnd`'s looks) and every final flush the executor is asked.
 */
const makeEvidenceClock = Effect.gen(function* () {
  const clock = yield* makeEngineClock(["sessions"]);
  const { looks, captureStatus } = yield* statusLooks;
  /** When (on the test clock) each final flush was asked, and what `answer` said to it. */
  const flushedAt: Array<number> = [];
  const flush =
    <A, E>(answer: () => Effect.Effect<A, E>) =>
    () =>
      Clock.currentTimeMillis.pipe(
        Effect.tap((at) => Effect.sync(() => flushedAt.push(at))),
        Effect.andThen(answer()),
      );
  /**
   * `EXECUTOR_END_LOOKS` looks at an ended agent's executor, a poll apart: each asks its capture
   * status last and sleeps the poll, and `notYet` holds until the last look's silence.
   */
  const executorLooks = (notYet: () => boolean) =>
    Effect.gen(function* () {
      for (let look = 1; look < EXECUTOR_END_LOOKS; look += 1) {
        yield* Queue.take(looks);
        expect(notYet()).toBe(true);
        yield* TestClock.adjust(POLL_INTERVAL);
      }
      yield* Queue.take(looks);
    });
  return { ...clock, captureStatus, flush, flushedAt, executorLooks };
});

describe("SessionEngine received evidence beats stored evidence (review 2026-09-28 (4))", () => {
  it.effect(
    "#1 an older seal never stands for a FINAL answer received incomplete: no saved, no terminate, no attestation",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const logs: Array<string> = [];
        const clock = yield* makeEvidenceClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* sealCurrent(world, tmp, memory, records, session);
              yield* engine.stop(session.id);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain's not saved",
              );
              expect(stopOptions).toEqual([]);
              expect(
                logs.some((line) => line.includes("capture drain · saved · terminating")),
              ).toBe(false);
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
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#1 an unsaved answer observed after the seal revokes it: a lost FINAL answer then terminates nothing",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const clock = yield* makeEvidenceClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const seal = yield* sealCurrent(world, tmp, memory, records, session);
              const workspaceId = world.sessions.get(session.id)?.sealantWorkspaceId ?? "";
              unsavedAfterSeal(world, workspaceId, seal, {
                at: new Date((yield* Clock.currentTimeMillis) + 1_000),
                words: "incomplete · changed",
              });
              yield* engine.stop(session.id);
              yield* clock.untilChanged(
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
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#9 a `docker stop` after the seal and a later unsaved answer reads the last confirmed save and what came after it, never saved",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const clock = yield* makeEvidenceClock;
        const { ptyStates } = clock;
        let stopped = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const seal = yield* sealCurrent(world, tmp, memory, records, session);
              // Taken a moment after the head registered.
              const unsavedAt = new Date((yield* Clock.currentTimeMillis) + 1_000);
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
              const settled = () => world.sessions.get(session.id)?.settledAt != null;
              // The platform answers the executor's lookup 404 from here on: the harness's end is
              // read from that with no timer in the way (the PTY watcher's 2 s look never comes on
              // the test clock), and the executor's first look reads it gone.
              yield* clock.untilChanged(settled, "the session's settle");
              const settledRow = world.sessions.get(session.id);
              expect(settledRow?.status).toBe("failed");
              expect(settledRow?.summary).toContain("executor lost · last saved");
              expect(settledRow?.summary).toContain(
                `4.1 KB pending at ${unsavedAt.toISOString().slice(11, 19)} UTC`,
              );
              expect(settledRow?.summary).not.toContain(
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
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );
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

describe("SessionEngine status words from the latest observation (e2e run 6 #7)", () => {
  it.effect(
    "a session settled `executor not answering · … · completion unknown` whose executor later saves and ends reads `stopped · saved at …`",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeEvidenceClock;
        const { ptyStates } = clock;
        const keptRetryFirst = Duration.millis(100);
        let answering = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
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
              const settled = () => world.sessions.get(session.id)?.settledAt != null;
              // The exit is read at the PTY watcher's next look; six looks at the executor, a poll
              // apart, go unanswered before its fate is read as unknown.
              yield* clock.nextLook(agent.sealantSessionId, () => !settled());
              yield* clock.executorLooks(() => !settled());
              yield* clock.untilChanged(settled, "the session's settle");
              expect(world.sessions.get(session.id)?.summary).toMatch(/^executor not answering · /);
              // The settle's checkpoint waits for a capture no executor registers; the drain after
              // it is answered nothing and keeps the executor.
              yield* clock.expireCheckpointWait;
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the drain kept",
              );
              const keptAt = yield* Clock.currentTimeMillis;
              const saved = () =>
                world.sessions.get(session.id)?.summary?.startsWith("saved at ") === true;
              // Recovered: it answers its final flush complete, and the kept drain's next round
              // (`keptRetryFirst` on, not before) terminates it.
              answering = true;
              yield* TestClock.adjust(Duration.subtract(keptRetryFirst, Duration.millis(1)));
              yield* engine.reapCaptureLeases();
              expect(saved()).toBe(false);
              yield* TestClock.adjust(Duration.millis(1));
              yield* engine.reapCaptureLeases();
              yield* clock.untilChanged(saved, "the recovered executor's save");
              // Every ask of the recovered executor came with the round, at the wait's end.
              const asked = clock.flushedAt.filter((at) => at > keptAt);
              expect(asked).not.toEqual([]);
              expect(new Set(asked)).toEqual(new Set([keptAt + Duration.toMillis(keptRetryFirst)]));
              const settledRow = world.sessions.get(session.id);
              expect(settledRow?.status).toBe("stopped");
              expect(settledRow?.summary).toMatch(/^saved at \d\d:\d\d:\d\d UTC( · capture \d+)?$/);
            }),
          {
            captured: memory,
            drainPolicy: {
              stallSeconds: 0,
              pollInterval: POLL_INTERVAL,
              keptRetryFirst,
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
                captureStatus: clock.captureStatus,
                flush: clock.flush(() =>
                  answering ? Effect.succeed(flushReport(0, 1)) : notAnswering(),
                ),
              },
            ),
            prepareWorld: clock.prepareWorld,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    { timeout: 30_000 },
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
  it.effect(
    "a lost create whose executor the reaper finds and drains to its end settles `stopped · launch interrupted · …` — never `starting` with no executor",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeEvidenceClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              world.executorCreates.set(
                session.id,
                `launch:${session.id}:${yield* Clock.currentTimeMillis}:k`,
              );
              expect(world.sessions.get(session.id)?.status).toBe("starting");
              yield* engine.reapCaptureLeases();
              // The reaper forks the found executor's drain; it reads the executor gone and
              // settles the launch.
              yield* clock.untilChanged(
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
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine a failed launch's words follow its executor (e2e run 6 #7)", () => {
  it.effect(
    "a launch that failed at a setup command and whose kept executor is then killed reads the loss beside the launch's words, never the launch's words alone",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeEvidenceClock;
        let killed = false;
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
              // `docker kill`: the platform reports it gone. A sweep passes over the session while
              // the drain that kept it still holds its slot, and that ends a moment after the kept
              // record does, so it sweeps as the reaper's interval would, on the test clock.
              killed = true;
              for (let round = 0; round < 50; round += 1) {
                if (world.sessions.get(session.id)?.summary?.includes("executor lost") === true)
                  break;
                yield* engine.reapCaptureLeases();
                yield* TestClock.adjust(Duration.millis(100));
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
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
    { timeout: 30_000 },
  );
});

describe("SessionEngine a recovered executor's accepted seal is the session's word (e2e run 6 #7)", () => {
  it.effect(
    "`executor not answering · … · not confirmed`, then Core ends the kept executor on the seal Mend attested and it accepted: `stopped · saved at … · capture N`",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const clock = yield* makeEvidenceClock;
        const { ptyStates } = clock;
        let ended = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
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
              const settled = () => world.sessions.get(session.id)?.settledAt != null;
              // The exit is read at the PTY watcher's next look; six looks at the executor, a poll
              // apart, go unanswered before its fate is read as unknown.
              yield* clock.nextLook(agent.sealantSessionId, () => !settled());
              yield* clock.executorLooks(() => !settled());
              yield* clock.untilChanged(settled, "the session's settle");
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
              const sealedAt = new Date((yield* Clock.currentTimeMillis) + 1_000);
              records.set(`${session.worktreeId}:${epoch}`, {
                worktreeId: session.worktreeId,
                epoch,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt,
              });
              ended = true;
              // The settle's checkpoint waits for a capture no executor registers; the drain after
              // it reads the executor ended on the seal, attests it, and the stop ends it.
              yield* clock.expireCheckpointWait;
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.summary?.startsWith("saved at ") === true,
                "the attested seal's save",
              );
              expect(stopOptions.some((o) => o?.completion?.captureN === built.manifest.n)).toBe(
                true,
              );
              const settledRow = world.sessions.get(session.id);
              expect(settledRow?.status).toBe("stopped");
              expect(settledRow?.summary).toBe(
                `saved at ${sealedAt.toISOString().slice(11, 19)} UTC · capture ${built.manifest.n}`,
              );
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            drainPolicy: {
              stallSeconds: 0,
              pollInterval: POLL_INTERVAL,
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
                captureStatus: clock.captureStatus,
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
            prepareWorld: clock.prepareWorld,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    { timeout: 30_000 },
  );
});
