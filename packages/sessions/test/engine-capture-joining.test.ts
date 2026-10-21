import * as fs from "node:fs";
import * as path from "node:path";

import { AgentMemoryRepo, type AgentMemoryHomes } from "@mend/db";
import {
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  SecretFileId,
  WorktreeId,
} from "@mend/domain";
import { Project, Session, SessionProcess, SecretFile } from "@mend/domain/workbench";
import {
  CaptureGitVerifier,
  type GitVerification,
  planBlockedWords,
  planWaitingWords,
  HARNESS_HOME_MOUNT_PATH,
  SessionEngine,
  secretFilesRecordExec,
} from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { restoreConfiguredHarnessHome } from "./engine-capture-launch-fixtures.ts";
import {
  configuredHarnessHomePath,
  headFlush,
  headReport,
  memoryHotPool,
  shipCapturedHarnessHome,
  shipHarnessCapture,
} from "./engine/capture-fixture.ts";
import { makeEngineClock, signalled, signallingPool } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  captureAnswer,
  drawnLine,
  isPickupExec,
  now,
  recordingProtocolHostLayer,
  redeemPickupExec,
  sealantLaunchLayer,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/**
 * What an executor ships in these worlds: a capture whose workspace class carries the codex
 * rollout under `harness/`, registered under the epoch Mend claimed at launch. Packs and
 * manifests follow ADR-0015's rules through the same writer the store tests prove.
 */
/** A capture's place on its chain, as a test's fake git verifier keys its answers. */
const keyOf = (manifest: { readonly n: number }) => `n=${manifest.n}`;

/**
 * What the platform answers a workspace lookup once a test has killed the executor: gone (404)
 * for the dead one, found for the replacement its pickup creates. The fixture serves every create
 * under the one workspace id, so the replacement's create is the line. A platform that refused the
 * replacement's lookups too had the replacement's process watcher judge it lost in turn, and
 * `executor lost · last capture 1 at … · changes after it were not saved` written over the
 * reaper's `executor lost · lease expired at …` whenever that watcher ran before the test's next
 * read of the session (mend#1037).
 */
const goneUntilReplaced = (dead: () => boolean, created: ReadonlyArray<CreateOptions>) => () =>
  dead() && created.length < 2;

/**
 * The fibers a launch forks start on the scheduler's next task, the replacement's process watcher
 * among them, and its first look at the platform is the one mend#1037 raced: a loaded CI box ran
 * it before the test read the session again. Taken on purpose after every pickup here, so the
 * reads that follow come after that look, never before it.
 */
const afterTheWatcherLooks = Effect.yieldNow;

/** How long a launch waits for a worktree's previous executor, and between its looks (`testDrainPolicy`). */
const LEASE_WAIT = Duration.millis(300);
const LEASE_WAIT_INTERVAL = Duration.millis(10);

/**
 * What these scenarios wait on, beyond the shared clock's signals (`world.sessions`, the waiting
 * line a launch says among them; the channel's checkpoint waits): every look a waiting launch
 * takes at an unreachable holder, and every pool row a warm writes.
 */
const makeJoiningClock = Effect.gen(function* () {
  const clock = yield* makeEngineClock(["sessions"]);
  /** The holder looked up: by a waiting launch once per `LEASE_WAIT_INTERVAL`, and before its wait. */
  const probes = yield* Queue.make<void>();
  const probed = () => void Queue.offerUnsafe(probes, undefined);
  /** `window` of a waiting launch's looks at its holder, one per `LEASE_WAIT_INTERVAL`. */
  const leaseLooks = (window: Duration.Duration) =>
    Effect.gen(function* () {
      const looks = Duration.toMillis(window) / Duration.toMillis(LEASE_WAIT_INTERVAL);
      for (let look = 0; look < looks; look++) {
        yield* TestClock.adjust(LEASE_WAIT_INTERVAL);
        yield* Queue.take(probes);
      }
    });
  /** A parked launch's next look at its holder: what it finds there decides it. */
  const nextLeaseLook = Effect.gen(function* () {
    yield* Queue.clear(probes);
    yield* TestClock.adjust(LEASE_WAIT_INTERVAL);
    yield* Queue.take(probes);
  });
  /**
   * `launch` waits `LEASE_WAIT` out on an unreachable holder, looking at it every
   * `LEASE_WAIT_INTERVAL`. Its deadline is fixed just before its first look, which writes the
   * session's waiting line (`waiting` reads it): the clock moves only from there, and the looks
   * before it count for nothing.
   */
  const leaseWaitOut = <A, E, R>(launch: Effect.Effect<A, E, R>, waiting: () => boolean) =>
    Effect.gen(function* () {
      const fiber = yield* launch.pipe(Effect.forkChild);
      yield* clock.untilChanged(waiting, "the launch's waiting line");
      yield* Queue.clear(probes);
      yield* leaseLooks(Duration.subtract(LEASE_WAIT, LEASE_WAIT_INTERVAL));
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(waiting()).toBe(true);
      yield* TestClock.adjust(LEASE_WAIT_INTERVAL);
      return yield* Fiber.join(fiber);
    });
  /** A pool row changed: ready, failed, or gone. */
  const rows = yield* Queue.make<void>();
  const poolLayer = (pool: ReturnType<typeof memoryHotPool>) => signallingPool(pool, rows);
  /** Waits for `condition`, woken by every pool row change. */
  const untilReady = signalled(rows);
  return { ...clock, probed, leaseLooks, nextLeaseLook, leaseWaitOut, poolLayer, untilReady };
});

describe("SessionEngine capture mode", () => {
  it.effect(
    "a second session in a leased worktree joins the holder's executor; an unreachable holder is refused with worktree_leased",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeJoiningClock;
        let holderDead = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const first = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(first.id, ["codex"]);
              expect(created).toHaveLength(1);

              const second = yield* engine.provisionSessionIn(first.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              yield* engine.launch(second.id, ["claude"]);
              // One executor per worktree: the join is one more process in the holder's workspace.
              expect(created).toHaveLength(1);
              expect(spawned.at(-1)?.slice(0, 5)).toEqual([
                "sh",
                "-c",
                expect.stringContaining("exec"),
                "sh",
                "claude",
              ]);
              expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(memory.leases.get(first.worktreeId)?.executorId).toBe(first.id);

              // The holder's executor stops answering while its lease is still live: the launch
              // waits `LEASE_WAIT` out on it, saying what the platform answered, then is refused.
              holderDead = true;
              // The join's launch took its checkpoint after it answered: this provision's own
              // checkpoint queues behind it on the worktree's writer, and each waits
              // `CHECKPOINT_WAIT` for the executor's capture, which never lands.
              const third = yield* clock.checkpointWait(
                engine.provisionSessionIn(first.worktreeId, {
                  harness: "codex",
                  label: null,
                  ownerUserId: "user-fixture",
                }),
                2,
              );
              const refused = yield* clock.leaseWaitOut(
                engine.launch(third.id, ["codex"]).pipe(Effect.flip),
                () =>
                  (world.sessions.get(third.id)?.summary ?? "").includes(
                    "the platform did not find its workspace (404)",
                  ),
              );
              expect(refused._tag).toBe("SealantPlatformError");
              expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                "worktree_leased",
              );
              expect(refused._tag === "SealantPlatformError" && refused.status).toBe(409);
              expect(world.sessions.get(third.id)?.status).toBe("failed");
              expect(created).toHaveLength(1);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            drainPolicy: { leaseWait: LEASE_WAIT, leaseWaitInterval: LEASE_WAIT_INTERVAL },
            sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned, () => {
              if (holderDead) clock.probed();
              return holderDead;
            }),
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    20_000,
  );

  it.effect(
    "a joined session's later conversation runs in the holder's executor, on the holder's login",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
        const launchLogins: Array<string | null> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeJoiningClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const first = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(first.id, ["codex"]);
              // The holder's shell keeps its executor retained between the joined session's runs.
              yield* engine.openShell(first.id);

              const second = yield* engine.provisionSessionIn(first.worktreeId, {
                harness: "codex",
                label: null,
                ownerUserId: "user-maria",
              });
              const converse = () =>
                engine.launchProtocol(
                  second.id,
                  { mode: "protocol", permissionMode: "bypass" },
                  "user-maria",
                );
              yield* converse();
              expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");

              // Its next conversation reuses the executor its row now names: still the holder's.
              yield* engine.stop(second.id);
              yield* converse();
              expect(created).toHaveLength(1);
              expect(attached).toHaveLength(2);
              expect(attached.map(({ process }) => process.sealantWorkspaceId)).toEqual([
                "workspace-1",
                "workspace-1",
              ]);
              expect(launchLogins).toEqual(["user-fixture", "user-fixture"]);

              // Once the lease names no session, nothing says whose login that executor holds.
              const lease = memory.leases.get(first.worktreeId);
              if (lease === undefined) return yield* Effect.die("the worktree holds no lease");
              memory.leases.set(first.worktreeId, { ...lease, executorId: null });
              // A lease naming no executor has nobody to flush: the stop's checkpoint waits
              // `CHECKPOINT_WAIT` for a capture to register, and none does.
              yield* clock.checkpointWait(engine.stop(second.id));
              yield* converse();
              expect(attached.at(-1)?.process.sealantWorkspaceId).toBe("workspace-1");
              expect(launchLogins.at(-1)).toBeNull();
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            protocolHostLayer: recordingProtocolHostLayer(attached, [], [], [], launchLogins),
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    20_000,
  );

  it.effect(
    "a joined session's later runs in the holder's executor write none of its owner's secret files there, and its session line says so (docs/adr/0010 decision 3)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeJoiningClock;
        // Each person's `.aws/credentials`, told apart by its bytes; the stub cipher seals as
        // `sealed:<base64>`. The write exec carries a pickup ticket, never the bytes: which person's
        // file reached the home is what its redemption answered.
        const contents: Record<string, string> = {
          "user-fixture": "[default]\naws_access_key_id = AKIAHOLDER\n",
          "user-maria": "[default]\naws_access_key_id = AKIAJOINER\n",
        };
        const base64Of = (userId: string) =>
          Buffer.from(contents[userId] ?? "", "utf8").toString("base64");
        const writes: Array<"holder" | "joiner"> = [];
        const recordWrites: Array<string> = [];
        // The executor's channel is its maker's, the holder's: every pickup in it is redeemed there.
        let holder: SessionId | null = null;
        const fileOf = (userId: string) =>
          new SecretFile({
            id: SecretFileId.make(`secret-${userId}`),
            path: ".aws/credentials",
            name: "credentials",
            bytes: Buffer.byteLength(contents[userId] ?? ""),
            revision: 1,
            createdAt: new Date("2026-10-05T09:12:00.000Z"),
            updatedAt: new Date("2026-10-05T09:12:00.000Z"),
          });
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const first = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              holder = first.id;
              yield* engine.launch(first.id, ["codex"]);
              // The holder's own launch writes the holder's file into the holder's home.
              expect(writes).toEqual(["holder"]);
              // The holder's shell keeps its executor retained between the joined session's runs.
              yield* engine.openShell(first.id);

              const second = yield* engine.provisionSessionIn(first.worktreeId, {
                harness: "codex",
                label: null,
                ownerUserId: "user-maria",
              });
              const converse = () =>
                engine.launchProtocol(
                  second.id,
                  { mode: "protocol", permissionMode: "bypass" },
                  "user-maria",
                );
              // The join, then a later run in the executor its row now names: the holder's.
              yield* converse();
              expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");
              yield* engine.stop(second.id);
              const writtenBefore = recordWrites.length;
              yield* converse();
              expect(created).toHaveLength(1);
              // Nothing of Maria's reached the holder's home, and the holder's record of the files
              // in it was never rewritten: nothing of the holder's was replaced or removed.
              expect(writes).toEqual(["holder"]);
              expect(recordWrites).toHaveLength(writtenBefore);
              expect(world.sessions.get(second.id)?.summary ?? "").toContain(
                "secret files · 1 not written · this workspace is another person's · ~/.aws/credentials",
              );

              // The holder's own later run in that executor still receives the holder's files.
              yield* engine.stop(first.id);
              yield* engine.launchProtocol(
                first.id,
                { mode: "protocol", permissionMode: "bypass" },
                "user-fixture",
              );
              expect(created).toHaveLength(1);
              expect(writes).toEqual(["holder", "holder"]);

              // Once the lease names no session, nothing says whose home that is: still nothing.
              const lease = memory.leases.get(first.worktreeId);
              if (lease === undefined) return yield* Effect.die("the worktree holds no lease");
              memory.leases.set(first.worktreeId, { ...lease, executorId: null });
              // A lease naming no executor has nobody to flush: the stop's checkpoint waits
              // `CHECKPOINT_WAIT` for a capture to register, and none does.
              yield* clock.checkpointWait(engine.stop(second.id));
              yield* converse();
              expect(writes).toEqual(["holder", "holder"]);
              expect(world.sessions.get(second.id)?.summary ?? "").toContain(
                "secret files · 1 not written · Mend cannot say whose workspace this is · ~/.aws/credentials",
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
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                exec: (argv) => {
                  if (argv[3] !== "mend-secret-files") return undefined;
                  // The sealed record of what Mend wrote into this home: rewritten by every
                  // delivery, and the only way one removes a file as stale.
                  if (argv[2] === secretFilesRecordExec(null)[2]) {
                    recordWrites.push(argv.join(" "));
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }
                  return undefined;
                },
                execEffect: (argv) => {
                  if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
                  const joined = argv.join(" ");
                  expect(joined).not.toContain(base64Of("user-fixture"));
                  expect(joined).not.toContain(base64Of("user-maria"));
                  return redeemPickupExec(argv, holder).pipe(
                    Effect.map((answer) => {
                      const sent = answer.files[0]?.base64;
                      if (sent === base64Of("user-fixture")) writes.push("holder");
                      if (sent === base64Of("user-maria")) writes.push("joiner");
                      return { exitCode: 0, stdout: "written\t.aws/credentials\n", stderr: "" };
                    }),
                    Effect.orDie,
                  );
                },
              },
            ),
            secretFilesLayer: secretFilesLayerOf(
              (userId) =>
                Effect.succeed([
                  {
                    path: ".aws/credentials",
                    sealedContents: `sealed:${base64Of(userId)}`,
                  },
                ]),
              (userId) => Effect.succeed([fileOf(userId)]),
            ),
            protocolHostLayer: recordingProtocolHostLayer([], []),
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    20_000,
  );

  it.each([
    ["claude", "11111111-2222-3333-4444-555555555555", ["claude", "--resume"]],
    ["codex", "66666666-7777-8888-9999-aaaaaaaaaaaa", ["codex", "resume"]],
    ["opencode", "ses_joined", ["opencode", "--session"]],
    ["pi", "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", ["pi", "--session"]],
  ] as const)(
    "a %s resume that joins the lease holder's executor opens the conversation its saved state names",
    { timeout: 20_000 },
    async (harness, providerSessionId, resumeFlags) => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(holder.id, ["codex"]);
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness,
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(joined.id, [harness]);
            const agentOf = () =>
              [...world.processes.values()].findLast(
                (process) =>
                  process.sessionId === joined.id &&
                  process.kind === "agent-pty" &&
                  process.exitedAt === null,
              );
            const agent = agentOf();
            if (agent === undefined) throw new Error("the join recorded no agent");
            yield* engine.stop(joined.id);
            const stateDir = processStatePathOf(project.storePath, joined.id, agent.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({ harness, providerSessionId, capturedAt: now().toISOString() }),
            );

            // The holder's agent keeps its executor; nothing of the joined session's retains it.
            yield* engine.resumeSession(joined.id, null);
            const resumed = agentOf();
            expect(created).toHaveLength(1);
            expect(resumed?.sealantWorkspaceId).toBe("workspace-1");
            expect(resumed?.argv.slice(0, 3)).toEqual([...resumeFlags, providerSessionId]);
            expect(resumed?.providerSessionId).toBe(providerSessionId);
          }),
        {
          captured: memory,
          // A pi launch prepares the harness home's pi profile through exec (no live pi there).
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
            harness === "pi" ? [] : undefined,
          ),
        },
      );
    },
  );

  it.effect.each([
    ["no owner record", null, "user-fixture"],
    ["the record names the holder", "user-fixture", "user-fixture"],
    // The home's own record is never consulted: whatever it says, the server decides.
    ["the record forged to name the joiner", "user-maria", "user-fixture"],
  ] as const)(
    "agent memory in a joined executor is read back only for the person whose launch made it, as the server knows it (%s; docs/adr/0009)",
    ([_label, record, credited]) =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const execCalls: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        const learned = ".claude/projects/-workspace-repo/memory/learned.md";
        const clock = yield* makeJoiningClock;
        const logs = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const holder = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(holder.id, ["claude"]);
              const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              yield* engine.launch(joined.id, ["claude"]);
              // One executor: Maria's agent runs in the holder's home.
              expect(created).toHaveLength(1);
              // Only the launch that made the executor delivers, and it records whose memory it is.
              const deliveries = execCalls.filter((argv) => argv[3] === "mend-agent-memory");
              // argv: sh, -c, program, name, home, incoming, kept, list, owner, record.
              expect(deliveries.map((argv) => argv[8])).toEqual(["user-fixture"]);

              // The worktree's one home as the executor saves it: what the agents there learned,
              // in the one memory directory they share.
              const request = created[0];
              if (request === undefined) return yield* Effect.die("the launch made no executor");
              const executorRoot = path.join(tmp, "memory-executor");
              const home = configuredHarnessHomePath(request, executorRoot);
              fs.mkdirSync(path.join(home, path.dirname(learned)), { recursive: true });
              fs.writeFileSync(path.join(home, learned), "the API listens on 3101\n");
              if (record !== null) {
                fs.mkdirSync(path.join(home, ".mend"), { recursive: true });
                fs.writeFileSync(path.join(home, ".mend/agent-memory-owner"), record);
              }
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                holder.worktreeId,
                memory.leases.get(holder.worktreeId)?.epoch ?? 0,
                request,
                executorRoot,
              );

              // Maria's agent ends: none of it is stored as hers, whatever the home's record says.
              yield* engine.stop(joined.id);
              yield* clock.untilChanged(
                () =>
                  readBacks.length > 0 ||
                  logs.some((line) => line.includes("agent memory not read back")),
                "the joined session's read-back",
              );
              expect(readBacks.map((input) => input.userId)).toEqual([]);

              // The holder's agent ends: the home's memory reaches its owner. A record naming
              // someone else only withholds it: it stays in the worktree's capture.
              const refusals = logs.filter((line) => line.includes("agent memory not read back"));
              yield* engine.stop(holder.id);
              yield* clock.untilChanged(
                () =>
                  readBacks.length > 0 ||
                  logs.filter((line) => line.includes("agent memory not read back")).length >
                    refusals.length,
                "the holder's read-back",
              );
              if (credited === null) {
                expect(readBacks).toEqual([]);
                return;
              }
              expect(readBacks.map((input) => [input.userId, input.sessionId])).toEqual([
                [credited, holder.id],
              ]);
              expect(readBacks[0]?.session.map((file) => file.path)).toEqual([learned]);
            }),
          {
            captured: memory,
            logs,
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) =>
                Effect.sync(() => {
                  readBacks.push(input);
                  clock.changed();
                  return { saved: [], merged: [], deleted: [], skipped: [] };
                }),
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
              execCalls,
              undefined,
              { flush: headFlush(memory) },
            ),
          },
        );
      }),
    20_000,
  );

  it.each([
    ["withheld", 0, "withheld 1 restored 0", "features.memories=true"],
    ["no node in the image", 127, "", "features.memories=false"],
  ] as const)(
    "a Codex launch takes other people's conversations in the home out of Codex's memory first, or starts with its memory off (%s; docs/adr/0009, Codex)",
    { timeout: 20_000 },
    async (_label, exitCode, stdout, memoryFlag) => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const withholds: Array<ReadonlyArray<string>> = [];
      const memory = makeMemoryCaptureStore();
      const mine = crypto.randomUUID();
      const theirs = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const earlier = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            const other = yield* engine.provisionSessionIn(earlier.worktreeId, {
              harness: "codex",
              label: null,
              ownerUserId: "user-maria",
            });
            // Each person's earlier Codex conversation in this worktree, ended.
            for (const [sessionId, providerSessionId] of [
              [earlier.id, mine],
              [other.id, theirs],
            ] as const) {
              const processId = SessionProcessId.make(crypto.randomUUID());
              world.processes.set(
                processId,
                new SessionProcess({
                  id: processId,
                  sessionId,
                  sealantWorkspaceId: SealantWorkspaceId.make("ws-earlier"),
                  sealantSessionId: "pty-earlier",
                  sealantRunId: SealantRunId.make("run-earlier"),
                  launchCorrelationId: null,
                  serviceId: null,
                  attemptOrdinal: null,
                  kind: "agent-pty",
                  harness: "codex",
                  providerSessionId,
                  protocolOptions: null,
                  label: "codex",
                  argv: ["codex"],
                  status: "exited",
                  exitCode: 0,
                  workspacePort: null,
                  protocol: "tcp",
                  hostPort: null,
                  createdAt: now(),
                  exitedAt: now(),
                  updatedAt: now(),
                }),
              );
            }
            const session = yield* engine.provisionSessionIn(earlier.worktreeId, {
              harness: "codex",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(session.id, ["codex"]);
            // The launcher's own conversations stay in Codex's memory; Maria's do not.
            expect(withholds).toHaveLength(1);
            expect(JSON.parse(withholds[0]?.at(-1) ?? "[]")).toEqual([mine]);
            const agentArgv = spawned.at(-1) ?? [];
            expect(agentArgv).toContain(memoryFlag);
            expect(agentArgv).not.toContain(
              memoryFlag === "features.memories=true"
                ? "features.memories=false"
                : "features.memories=true",
            );
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              exec: (argv) => {
                if (argv[3]?.includes("memory_mode") !== true) return undefined;
                withholds.push(argv);
                return { exitCode, stdout, stderr: "" };
              },
            },
          ),
        },
      );
    },
  );

  it.effect(
    "a join waits while the holder's launch hands the worktree's home over (docs/adr/0009)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const homes = new Map<string, AgentMemoryHomes>();
        const clock = yield* makeJoiningClock;
        const handingOver = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const holder = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              // The worktree's home was Maria's: the holder's launch hands it over.
              homes.set(holder.worktreeId, {
                settled: { userId: "user-maria", sessionId: null, workspaceId: "ws-earlier" },
                pending: null,
              });
              const launching = yield* engine.launch(holder.id, ["claude"]).pipe(Effect.forkChild);
              yield* Deferred.await(handingOver);
              const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              const joining = yield* engine.launch(joined.id, ["claude"]).pipe(Effect.forkChild);
              // The join looks at the holder every `LEASE_WAIT_INTERVAL` while the home is handed
              // over: 150 ms of looks, as long as the test once slept.
              yield* clock.leaseLooks(Duration.millis(150));
              // Nothing started while the home still held Maria's memory.
              expect(spawned).toEqual([]);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(launching);
              // The join's next look finds the hand-over done, and joins.
              yield* clock.nextLeaseLook;
              yield* Fiber.join(joining);
              expect(created).toHaveLength(1);
              expect(world.sessions.get(joined.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(spawned).toHaveLength(2);
            }),
          {
            captured: memory,
            drainPolicy: {
              leaseWait: Duration.seconds(10),
              leaseWaitInterval: LEASE_WAIT_INTERVAL,
            },
            agentMemoryLayer: agentMemoryLayerOf({}, homes),
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              spawned,
              () => {
                clock.probed();
                return false;
              },
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                execEffect: (argv) =>
                  argv[2]?.includes(".mend/agent-memory-kept") === true
                    ? Deferred.succeed(handingOver, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
                      )
                    : undefined,
              },
            ),
          },
        );
      }),
    20_000,
  );

  it(
    "only an answer that saved the moved home places its hand-over: never one behind, and one unreadable only outside the memory does (docs/adr/0009)",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const homes = new Map<string, AgentMemoryHomes>();
      let answer: Partial<WorkspaceCaptureStatus> = {};
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(session.id, ["claude"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const position = () => homes.get(session.worktreeId)?.pending?.n ?? null;
            expect(homes.get(session.worktreeId)?.pending?.epoch).toBe(epoch);
            const flushWith = (fields: Partial<WorkspaceCaptureStatus>) =>
              Effect.gen(function* () {
                answer = { epoch, headN: 7, ...fields };
                yield* engine.flushCaptures(session.id, "landing");
              });
            // Behind: the small class refused, or a memory path it could not read.
            yield* flushWith({ refused: ["small"] });
            expect(position()).toBeNull();
            yield* flushWith({
              unreadable: 1,
              unreadablePaths: ["harness/.claude/projects/-workspace-repo/memory/notes.md"],
            });
            expect(position()).toBeNull();
            // More unreadable paths than it names: the unnamed ones may be memory.
            yield* flushWith({ unreadable: 3, unreadablePaths: ["tree/locked.bin"] });
            expect(position()).toBeNull();
            // Caught up but for a file outside the memory it may never read: saved.
            yield* flushWith({ unreadable: 1, unreadablePaths: ["tree/locked.bin"] });
            expect(position()).toBe(7);
            // The first such answer is the one that counts.
            yield* flushWith({ headN: 9 });
            expect(position()).toBe(7);
          }),
        {
          captured: memory,
          agentMemoryLayer: agentMemoryLayerOf({}, homes),
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
            { flush: () => Effect.sync(() => captureAnswer(answer)) },
          ),
        },
      );
    },
  );

  it.effect.each([
    ["the hand-over finishes", false],
    ["the first hand-over cannot move the memory aside", true],
  ] as const)(
    "a person who launches in a worktree another person used never takes their memory: it is read back for them first, then moved out of the way (%s; docs/adr/0009)",
    ([_label, firstHandoverFails]) =>
      Effect.gen(function* () {
        let handoverFails = firstHandoverFails;
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        const relocation = { homePath: "", executorRoot: "" };
        const root = ".claude/projects/-workspace-repo/memory";
        let testRoot = "";
        // Anna's own read-back never happens: her executor ends with her learning unsaved.
        let annaReadBackFails = true;
        const clock = yield* makeJoiningClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const engine = yield* SessionEngine;
              const anna = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(anna.id, ["claude"]);
              const first = created[0];
              if (first === undefined) return yield* Effect.die("Anna's launch made no executor");
              const annaHome = configuredHarnessHomePath(first, relocation.executorRoot);
              fs.mkdirSync(path.join(annaHome, root), { recursive: true });
              fs.writeFileSync(
                path.join(annaHome, root, "MEMORY.md"),
                "- [feedback](feedback.md)\n",
              );
              fs.writeFileSync(
                path.join(annaHome, root, "feedback.md"),
                "Anna prefers small PRs\n",
              );
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                first,
                relocation.executorRoot,
              );
              yield* engine.stop(anna.id);
              yield* clock.untilChanged(
                () => world.sessions.get(anna.id)?.settledAt != null,
                "Anna's session settles",
              );
              expect(readBacks).toEqual([]);
              annaReadBackFails = false;

              // Maria starts a session in the same worktree once Anna's executor has ended.
              const startMaria = engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              if (firstHandoverFails) {
                // The memory cannot be moved aside: the launch fails rather than start Maria's agent
                // on Anna's memory, and the failed launch hands nothing to Maria.
                const failed = yield* startMaria;
                const refused = yield* engine.launch(failed.id, ["claude"]).pipe(Effect.flip);
                expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
                  "AGENT_MEMORY_NOT_HANDED_OVER",
                );
                expect(world.sessions.get(failed.id)?.status).toBe("failed");
                handoverFails = false;
              }
              const maria = yield* startMaria;
              yield* engine.launch(maria.id, ["claude"]);
              expect(created).toHaveLength(firstHandoverFails ? 3 : 2);
              // Anna's unsaved memory reached Anna first, credited to her own session, once: a retried
              // hand-over of the same home does not save it over itself again.
              expect(readBacks.map((input) => [input.userId, input.sessionId])).toEqual([
                ["user-fixture", anna.id],
              ]);
              expect(readBacks[0]?.session.map((file) => file.path).toSorted()).toEqual([
                `${root}/MEMORY.md`,
                `${root}/feedback.md`,
              ]);
              // Then it moved aside in Maria's executor: kept, never deleted, and nowhere Maria's
              // agent or read-back looks.
              const second = created.at(-1);
              if (second === undefined) return yield* Effect.die("Maria's launch made no executor");
              const mariaHome = configuredHarnessHomePath(second, relocation.executorRoot);
              expect(fs.existsSync(path.join(mariaHome, root))).toBe(false);
              const keptRoot = path.join(mariaHome, ".mend/agent-memory-kept");
              const keptSets = fs.readdirSync(keptRoot);
              expect(keptSets).toHaveLength(1);
              expect(
                fs.readFileSync(
                  path.join(keptRoot, keptSets[0] ?? "", root, "feedback.md"),
                  "utf8",
                ),
              ).toBe("Anna prefers small PRs\n");
              expect(
                fs.readFileSync(path.join(mariaHome, ".mend/agent-memory-owner"), "utf8"),
              ).toBe("user-maria");

              // Maria's agent learns; her read-back takes hers and nothing of Anna's.
              fs.mkdirSync(path.join(mariaHome, root), { recursive: true });
              fs.writeFileSync(
                path.join(mariaHome, root, "maria.md"),
                "Maria runs the API on 3101\n",
              );
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                second,
                relocation.executorRoot,
              );
              yield* engine.stop(maria.id);
              yield* clock.untilChanged(() => readBacks.length > 1, "Maria's read-back");
              expect(readBacks[1]?.userId).toBe("user-maria");
              expect(readBacks[1]?.session.map((file) => file.path)).toEqual([`${root}/maria.md`]);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) =>
                input.userId === "user-fixture" && annaReadBackFails
                  ? Effect.die("the database did not answer")
                  : Effect.sync(() => {
                      readBacks.push(input);
                      clock.changed();
                      return { saved: [], merged: [], deleted: [], skipped: [] };
                    }),
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
                relocation,
                flush: headFlush(memory),
                exec: (argv) =>
                  handoverFails && argv[2]?.includes(".mend/agent-memory-kept") === true
                    ? { exitCode: 1, stdout: "", stderr: "mv: cannot move" }
                    : undefined,
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(
                      testRoot,
                      `handover-executor-${created.length}`,
                    );
                    relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                    fs.mkdirSync(relocation.executorRoot, { recursive: true });
                    const source = options.source;
                    if (source?.kind !== "capture" || source.worktreeId === undefined) {
                      throw new Error("test executor requires a capture source");
                    }
                    yield* restoreConfiguredHarnessHome(
                      testRoot,
                      memory,
                      WorktreeId.make(source.worktreeId),
                      options,
                      relocation.executorRoot,
                    );
                  }),
              },
            ),
          },
        );
      }),
    30_000,
  );

  it.effect.each([
    ["nothing of it saved", false],
    ["only a capture staged before the move saved", true],
  ] as const)(
    "an executor lost before it saved its hand-over hands nothing over: the next launch hands the restored memory over again (%s; docs/adr/0009)",
    ([_label, preMoveCapture]) =>
      Effect.gen(function* () {
        // Maria's executor is lost: no flush of hers answers under her epoch, so nothing places her
        // hand-over (the stand-in still lets her stop go through).
        let mariaLost = false;
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        const relocation = { homePath: "", executorRoot: "" };
        const root = ".claude/projects/-workspace-repo/memory";
        let testRoot = "";
        const clock = yield* makeJoiningClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const engine = yield* SessionEngine;
              const anna = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(anna.id, ["claude"]);
              const first = created.at(-1);
              if (first === undefined) return yield* Effect.die("Anna's launch made none");
              const annaHome = configuredHarnessHomePath(first, relocation.executorRoot);
              fs.mkdirSync(path.join(annaHome, root), { recursive: true });
              fs.writeFileSync(
                path.join(annaHome, root, "feedback.md"),
                "Anna prefers small PRs\n",
              );
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                first,
                relocation.executorRoot,
              );
              yield* engine.stop(anna.id);
              yield* clock.untilChanged(() => readBacks.length > 0, "Anna's read-back");
              yield* clock.untilChanged(
                () => world.sessions.get(anna.id)?.settledAt != null,
                "Anna settles",
              );

              // Maria's executor hands the home over, then is lost before anything of it is saved.
              const lost = yield* engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              mariaLost = true;
              yield* engine.launch(lost.id, ["claude"]);
              if (preMoveCapture) {
                // A capture of Maria's epoch that sealantd staged before the move, with Anna's
                // memory still in it, registers; the forced one never does.
                const lostExecutor = created.at(-1);
                if (lostExecutor === undefined)
                  return yield* Effect.die("Maria's launch made none");
                const lostHome = configuredHarnessHomePath(lostExecutor, relocation.executorRoot);
                fs.mkdirSync(path.join(lostHome, root), { recursive: true });
                fs.writeFileSync(
                  path.join(lostHome, root, "feedback.md"),
                  "Anna prefers small PRs\n",
                );
                yield* shipCapturedHarnessHome(
                  tmp,
                  memory,
                  anna.worktreeId,
                  memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                  lostExecutor,
                  relocation.executorRoot,
                );
              }
              yield* engine.stop(lost.id);
              yield* clock.untilChanged(
                () => world.sessions.get(lost.id)?.settledAt != null,
                "Maria settles",
              );
              mariaLost = false;

              // The head is still Anna's executor's, with her memory in place: Maria's next launch
              // hands it over again rather than take it as hers.
              const maria = yield* engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              yield* engine.launch(maria.id, ["claude"]);
              const last = created.at(-1);
              if (last === undefined) return yield* Effect.die("Maria's launch made none");
              const mariaHome = configuredHarnessHomePath(last, relocation.executorRoot);
              expect(fs.existsSync(path.join(mariaHome, root, "feedback.md"))).toBe(false);
              expect(readBacks.map((input) => input.userId)).toEqual(["user-fixture"]);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) =>
                Effect.sync(() => {
                  readBacks.push(input);
                  clock.changed();
                  return { saved: [], merged: [], deleted: [], skipped: [] };
                }),
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
                relocation,
                flush: () => Effect.sync(() => captureAnswer(mariaLost ? {} : headReport(memory))),
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(
                      testRoot,
                      `lost-executor-${created.length}`,
                    );
                    relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                    fs.mkdirSync(relocation.executorRoot, { recursive: true });
                    const source = options.source;
                    if (source?.kind !== "capture" || source.worktreeId === undefined) {
                      throw new Error("test executor requires a capture source");
                    }
                    const head = memory.chains.get(WorktreeId.make(source.worktreeId))?.headCapture;
                    if (head === null || head === undefined) return;
                    yield* restoreConfiguredHarnessHome(
                      testRoot,
                      memory,
                      WorktreeId.make(source.worktreeId),
                      options,
                      relocation.executorRoot,
                    );
                  }),
              },
            ),
          },
        );
      }),
    30_000,
  );

  it.each([
    ["a Codex session", "codex"],
    ["`mend run -- codex`", "run"],
  ] as const)(
    "a join leaves every thread's memory mode alone and starts its Codex with memory fully off (%s; docs/adr/0009, Codex)",
    { timeout: 30_000 },
    async (_label, joinerHarness) => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const withholds: Array<ReadonlyArray<string>> = [];
      const memory = makeMemoryCaptureStore();
      const relocation = { homePath: "", executorRoot: "" };
      let testRoot = "";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            testRoot = tmp;
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(holder.id, ["codex"]);
            expect(withholds).toHaveLength(1);
            expect(spawned.at(-1)).toContain("features.memories=true");
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: joinerHarness,
              label: null,
              ownerUserId: "user-maria",
            });
            yield* engine.launch(joined.id, ["codex", "--enable", "memories"]);
            expect(created).toHaveLength(1);
            // The holder's selection stands: the join ran no withholding.
            expect(withholds).toHaveLength(1);
            const argv = spawned.at(-1) ?? [];
            expect(argv).toContain("features.memories=false");
            expect(argv).toContain("memories.generate_memories=false");
            expect(argv).not.toContain("features.memories=true");
            expect(argv).not.toContain("--enable");
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              relocation,
              flush: headFlush(memory),
              exec: (argv) => {
                if (argv[3]?.includes("memory_mode") !== true) return undefined;
                withholds.push(argv);
                return { exitCode: 0, stdout: "withheld 0 restored 0", stderr: "" };
              },
              beforeCreate: (options) =>
                Effect.gen(function* () {
                  relocation.executorRoot = path.join(testRoot, `join-executor-${created.length}`);
                  relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                  fs.mkdirSync(relocation.executorRoot, { recursive: true });
                  const source = options.source;
                  if (source?.kind !== "capture" || source.worktreeId === undefined) {
                    throw new Error("test executor requires a capture source");
                  }
                  const head = memory.chains.get(WorktreeId.make(source.worktreeId))?.headCapture;
                  if (head === null || head === undefined) return;
                  yield* restoreConfiguredHarnessHome(
                    testRoot,
                    memory,
                    WorktreeId.make(source.worktreeId),
                    options,
                    relocation.executorRoot,
                  );
                }),
            },
          ),
        },
      );
    },
  );

  it(
    "the launcher's own second Codex session, before the executor's first save, runs in their own home: withheld, memory on (docs/adr/0009, Codex)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const withholds: Array<ReadonlyArray<string>> = [];
      const memory = makeMemoryCaptureStore();
      const relocation = { homePath: "", executorRoot: "" };
      let testRoot = "";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            testRoot = tmp;
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(holder.id, ["codex"]);
            expect(withholds).toHaveLength(1);
            expect(spawned.at(-1)).toContain("features.memories=true");
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "codex",
              label: null,
              ownerUserId: "user-fixture",
            });
            // Nothing of the executor is saved yet: its hand-over is pending, naming it.
            yield* engine.launch(joined.id, ["codex"]);
            expect(created).toHaveLength(1);
            expect(withholds).toHaveLength(2);
            const argv = spawned.at(-1) ?? [];
            expect(argv).toContain("features.memories=true");
            expect(argv).not.toContain("features.memories=false");
            expect(argv).not.toContain("memories.generate_memories=false");
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              relocation,
              exec: (argv) => {
                if (argv[3]?.includes("memory_mode") !== true) return undefined;
                withholds.push(argv);
                return { exitCode: 0, stdout: "withheld 0 restored 0", stderr: "" };
              },
              beforeCreate: (options) =>
                Effect.gen(function* () {
                  relocation.executorRoot = path.join(testRoot, `join-executor-${created.length}`);
                  relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                  fs.mkdirSync(relocation.executorRoot, { recursive: true });
                  const source = options.source;
                  if (source?.kind !== "capture" || source.worktreeId === undefined) {
                    throw new Error("test executor requires a capture source");
                  }
                  const head = memory.chains.get(WorktreeId.make(source.worktreeId))?.headCapture;
                  if (head === null || head === undefined) return;
                  yield* restoreConfiguredHarnessHome(
                    testRoot,
                    memory,
                    WorktreeId.make(source.worktreeId),
                    options,
                    relocation.executorRoot,
                  );
                }),
            },
          ),
        },
      );
    },
  );

  it.effect(
    "a removed session's executor is still its owner's: the next person's launch hands that memory over, never takes it (docs/adr/0009)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        const relocation = { homePath: "", executorRoot: "" };
        const root = ".claude/projects/-workspace-repo/memory";
        let testRoot = "";
        const clock = yield* makeJoiningClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const engine = yield* SessionEngine;
              // Anna used the worktree once; nothing of her memory is in its home.
              const anna = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(anna.id, ["claude"]);
              yield* engine.stop(anna.id);
              yield* clock.untilChanged(
                () => world.sessions.get(anna.id)?.settledAt != null,
                "Anna settles",
              );

              // Maria is new: nothing stored. Her agent learns, and her read-back saves it.
              const maria = yield* engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              yield* engine.launch(maria.id, ["claude"]);
              const mariaExecutor = created.at(-1);
              if (mariaExecutor === undefined) return yield* Effect.die("Maria's launch made none");
              const mariaHome = configuredHarnessHomePath(mariaExecutor, relocation.executorRoot);
              // Her hand-over wrote the owner record though she had nothing to deliver.
              expect(
                fs.readFileSync(path.join(mariaHome, ".mend/agent-memory-owner"), "utf8"),
              ).toBe("user-maria");
              fs.mkdirSync(path.join(mariaHome, root), { recursive: true });
              fs.writeFileSync(path.join(mariaHome, root, "MEMORY.md"), "- [b](b.md)\n");
              fs.writeFileSync(path.join(mariaHome, root, "b.md"), "Maria deploys on Fridays\n");
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                mariaExecutor,
                relocation.executorRoot,
              );
              yield* engine.stop(maria.id);
              yield* clock.untilChanged(() => readBacks.length > 0, "Maria's read-back");
              expect(readBacks.map((input) => input.userId)).toEqual(["user-maria"]);
              yield* clock.untilChanged(
                () => world.sessions.get(maria.id)?.settledAt != null,
                "Maria settles",
              );

              // Maria removes her session: its row and its processes are gone; the worktree stays.
              world.sessions.delete(maria.id);
              for (const [id, row] of world.processes) {
                if (row.sessionId === maria.id) world.processes.delete(id);
              }

              // Anna starts again in the worktree. The server still knows the home is Maria's.
              const again = yield* engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              yield* engine.launch(again.id, ["claude"]);
              const annaExecutor = created.at(-1);
              if (annaExecutor === undefined) return yield* Effect.die("Anna's launch made none");
              const annaHome = configuredHarnessHomePath(annaExecutor, relocation.executorRoot);
              // Maria's memory is out of Anna's way, and nothing of it was credited to Anna.
              expect(fs.existsSync(path.join(annaHome, root, "b.md"))).toBe(false);
              expect(readBacks.map((input) => input.userId)).toEqual(["user-maria"]);

              // Anna's agent learns; her read-back holds hers alone.
              fs.mkdirSync(path.join(annaHome, root), { recursive: true });
              fs.writeFileSync(path.join(annaHome, root, "a.md"), "Anna reviews on Mondays\n");
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                annaExecutor,
                relocation.executorRoot,
              );
              yield* engine.stop(again.id);
              yield* clock.untilChanged(() => readBacks.length > 1, "Anna's read-back");
              expect(readBacks[1]?.userId).toBe("user-fixture");
              expect(readBacks[1]?.session.map((file) => file.path)).toEqual([`${root}/a.md`]);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) =>
                Effect.sync(() => {
                  readBacks.push(input);
                  clock.changed();
                  return { saved: [], merged: [], deleted: [], skipped: [] };
                }),
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
                relocation,
                flush: headFlush(memory),
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(
                      testRoot,
                      `removed-executor-${created.length}`,
                    );
                    relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                    fs.mkdirSync(relocation.executorRoot, { recursive: true });
                    const source = options.source;
                    if (source?.kind !== "capture" || source.worktreeId === undefined) {
                      throw new Error("test executor requires a capture source");
                    }
                    const head = memory.chains.get(WorktreeId.make(source.worktreeId))?.headCapture;
                    if (head === null || head === undefined) return;
                    yield* restoreConfiguredHarnessHome(
                      testRoot,
                      memory,
                      WorktreeId.make(source.worktreeId),
                      options,
                      relocation.executorRoot,
                    );
                  }),
              },
            ),
          },
        );
      }),
    30_000,
  );

  it("resume is lease-aware: a live lease attaches; an expired lease with a dead executor is a pickup that harvests from the head capture — and asks nothing of the dead executor", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const flushed: string[] = [];
    const memory = makeMemoryCaptureStore();
    let executorDead = false;
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
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          expect(epoch).toBe(2);
          // The executor works and ships a turn capture carrying its rollout.
          const rolloutId = crypto.randomUUID();
          yield* shipHarnessCapture(tmp, memory, session.worktreeId, epoch, rolloutId);

          // Lease live → attach, never a relaunch.
          const active = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
          expect(active._tag === "SealantPlatformError" && active.code).toBe("session_active");
          expect(created).toHaveLength(1);

          // The executor dies: heartbeats stop, the lease lapses, the platform stops answering.
          const realNow = memory.clock.now;
          memory.clock.now = () => realNow() + 10 * 60 * 1000;
          executorDead = true;
          const resumed = yield* engine.resumeSession(session.id, null);
          yield* afterTheWatcherLooks;
          expect(resumed.status).toBe("running");
          // Pickup: a fresh capture-sourced workspace, launched as a NATIVE resume of the
          // rollout harvested from the head capture — streamed, never through exec.
          expect(created).toHaveLength(2);
          expect(created[1]?.source?.kind).toBe("capture");
          const liveAgent = [...world.processes.values()].find(
            (process) => process.exitedAt === null && process.kind === "agent-pty",
          );
          expect(liveAgent?.argv.slice(0, 3)).toEqual(["codex", "resume", rolloutId]);
          expect(liveAgent?.providerSessionId).toBe(rolloutId);
          const lease = memory.leases.get(session.worktreeId);
          expect(lease?.epoch).toBe(3);
          expect(lease?.executorId).toBe(session.id);
          // A pickup after a confirmed termination is not a planned stop: no flush was asked.
          expect(flushed).toEqual([]);
          const harvested = [...world.processes.values()].find(
            (process) => process.exitedAt !== null && process.kind === "agent-pty",
          );
          expect(harvested).toBeDefined();
          const stateDir = processStatePathOf(project.storePath, session.id, harvested?.id ?? "");
          expect(fs.readFileSync(path.join(stateDir, "transcript.native"), "utf8")).toContain(
            "go on",
          );
          memory.clock.now = realNow;
          void spawned;
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          goneUntilReplaced(() => executorDead, created),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { flushed },
        ),
      },
    );
  });

  /**
   * Review 2026-09-28 (14) #1 and #3, from the reviewer's "r14c: a pickup plan that waits once …":
   * an executor killed, the reaper's `executor lost · …`, a resume whose boot plan must wait for
   * Mend to verify the head, then is refused because git rejects it, then goes ahead.
   */
  const pickupAfterLoss = async (
    body: (at: {
      readonly world: Parameters<Parameters<typeof withEngine>[0]>[0];
      readonly session: Session;
      readonly head: { readonly id: string; readonly manifest: { readonly n: number } };
      readonly lost: string;
      readonly answers: Map<string, GitVerification>;
      readonly headKey: string;
    }) => Effect.Effect<void, unknown, SessionEngine>,
  ) => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    let executorDead = false;
    // What Mend's verification answers, by manifest key; verified unless a test says.
    const answers = new Map<string, GitVerification>();
    const verifier = Layer.succeed(CaptureGitVerifier, {
      verify: (_projectId, manifest) =>
        Effect.succeed(
          answers.get(keyOf(manifest)) ??
            ({ outcome: "verified", detail: null } satisfies GitVerification),
        ),
      treePaths: () => Effect.succeed(null),
      treeObjects: () => Effect.succeed(null),
    });
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
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
          const head = yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            crypto.randomUUID(),
          );
          const row = memory.captures.get(head.id);
          if (row === undefined) throw new Error("the head did not register");
          memory.captures.set(head.id, { ...row, gitFsck: "unverified" });
          const realNow = memory.clock.now;
          memory.clock.now = () => realNow() + 10 * 60 * 1000;
          executorDead = true;
          yield* engine.reapCaptureLeases();
          const lost = world.sessions.get(session.id)?.summary ?? "";
          expect(lost).toContain("executor lost · lease expired");
          yield* body({
            world,
            session,
            head,
            lost,
            answers,
            headKey: keyOf(head.manifest),
          }).pipe(Effect.ensuring(Effect.sync(() => (memory.clock.now = realNow))));
        }),
      {
        captured: memory,
        verifier,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          goneUntilReplaced(() => executorDead, created),
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        ),
      },
    );
  };

  it("review 14 #1, #3: a pickup plan that waits, then is refused, says so beside 'executor lost', never over it; once it goes ahead the words go and the replacement's heartbeat reads 'picked up · executor replaced'", async () => {
    await pickupAfterLoss(({ world, session, head, lost, answers, headKey }) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* engine.resumeSession(session.id, null);
        yield* afterTheWatcherLooks;
        expect(drawnLine(world.sessions.get(session.id)?.summary)).toBe(lost);
        const epoch = 0;
        const api = servedSocketApis.get(session.id)?.capture;
        if (api === undefined) throw new Error("the picked-up session serves no capture api");
        // The replacement's boot plan: the Mend host cannot finish the check.
        answers.set(headKey, {
          outcome: "unverified",
          detail: "index-pack --verify did not finish: signal SIGKILL",
          transient: true,
        });
        const waiting = yield* Effect.flip(api.planGet({ worktree_id: session.worktreeId, epoch }));
        expect(waiting.reason).toBe("worktree-leased");
        // Before: the waiting words alone — `executor lost · …` gone for good.
        expect(drawnLine(world.sessions.get(session.id)?.summary)).toBe(
          `${lost} · ${planWaitingWords(head.manifest.n)}`,
        );
        // Git rejects the head's content: the launch is blocked, and the session says so.
        answers.set(headKey, { outcome: "failed", detail: "fatal: bad tree object" });
        const blocked = yield* Effect.flip(api.planGet({ worktree_id: session.worktreeId, epoch }));
        expect([blocked.status, blocked.reason]).toEqual([422, "unrestorable"]);
        expect(drawnLine(world.sessions.get(session.id)?.summary)).toBe(
          `${lost} · ${planBlockedWords(head.manifest.n)}`,
        );
        // The check passes: the plan goes ahead with the head, and the loss report is back as it was.
        answers.delete(headKey);
        const plan = yield* api.planGet({ worktree_id: session.worktreeId, epoch });
        expect(plan.head?.capture_id).toBe(head.id);
        expect(drawnLine(world.sessions.get(session.id)?.summary)).toBe(lost);
        // Its first heartbeat is the observation that ends it.
        yield* api.heartbeat({ worktree_id: session.worktreeId, epoch: plan.epoch });
        expect(drawnLine(world.sessions.get(session.id)?.summary)).toBe(
          "picked up · executor replaced",
        );
      }),
    );
  });

  it("review 14 #1: a plan notice from a launch that is not the session's current one leaves the summary alone", async () => {
    await pickupAfterLoss(({ world, session, head, lost, answers, headKey }) =>
      Effect.gen(function* () {
        const older = servedSocketApis.get(session.id)?.captureAs?.("launch-the-session-left");
        if (older === undefined) throw new Error("the session serves no per-launch capture api");
        answers.set(headKey, {
          outcome: "unverified",
          detail: "index-pack --verify did not finish: signal SIGKILL",
          transient: true,
        });
        const waiting = yield* Effect.flip(
          older.planGet({ worktree_id: session.worktreeId, epoch: 0 }),
        );
        expect(waiting.reason).toBe("worktree-leased");
        // Before: `launch waiting · capture n's …` over the loss report.
        expect(world.sessions.get(session.id)?.summary).toBe(lost);
        expect(head.manifest.n).toBeGreaterThan(0);
      }),
    );
  });

  it("the reaper settles a session whose executor died: lease expired, platform silent — 'executor lost'", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    let executorDead = false;
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
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["codex"]);
          // The executor ships a turn capture carrying its rollout — what a pickup resumes.
          const rolloutId = crypto.randomUUID();
          yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            rolloutId,
          );
          // A live lease is left alone by the tick.
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("running");
          // Expired lease, executor still answering: paused, not killed.
          const realNow = memory.clock.now;
          memory.clock.now = () => realNow() + 10 * 60 * 1000;
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("running");
          // Expired lease, platform silent: the session settles honestly.
          executorDead = true;
          yield* engine.reapCaptureLeases();
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.settledAt).not.toBeNull();
          const run = [...world.sessionRuns.values()].find((row) => row.sessionId === session.id);
          expect(run?.summary).toContain("executor lost · lease expired");
          expect(settled?.summary).toContain("executor lost · lease expired");
          // Its end confirmed, the lease is released: the holder is cleared, so the next claim
          // is a new epoch and nobody reads the lapse as a live partition.
          expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
          // What distinguishes this from a planned stop is what was observed: no exit from
          // the platform, and no `final` capture on the chain (sealantd flushes one on
          // SIGTERM — `kubectl delete pod`, `docker stop` — and the harness then exits, so
          // that path settles through the run's exit, never through the reaper). A forced
          // kill (`--grace-period=0 --force`, `docker kill`) leaves the chain at its last
          // ordinary capture and the platform silent: this path.
          const lastCapture = memory.captures.get(
            memory.chains.get(session.worktreeId)?.headCapture ?? "",
          );
          expect(lastCapture?.kind).toBe("turn");
          // Pickup: the replacement launches and claims epoch + 1. Until it answers, the
          // summary still reads the loss — that is what was last observed.
          yield* engine.resumeSession(session.id, null);
          yield* afterTheWatcherLooks;
          const pickedUp = world.sessions.get(session.id);
          expect(pickedUp?.status).toBe("running");
          expect(pickedUp?.settledAt).toBeNull();
          expect(pickedUp?.summary).toContain("executor lost · lease expired");
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          expect(epoch).toBe(3);
          // Its first heartbeat is the observation that ends it.
          const api = servedSocketApis.get(session.id)?.capture;
          if (api === undefined) throw new Error("the picked-up session serves no capture api");
          yield* api.heartbeat({ worktree_id: session.worktreeId, epoch });
          expect(world.sessions.get(session.id)?.summary).toBe("picked up · executor replaced");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          // A later heartbeat rewrites nothing.
          yield* api.heartbeat({ worktree_id: session.worktreeId, epoch });
          expect(world.sessions.get(session.id)?.summary).toBe("picked up · executor replaced");
          memory.clock.now = realNow;
        }),
      {
        captured: memory,
        // Liveness is an exec probe, not the stored status: while the platform answers, the
        // probe succeeds (`execCalls`); once it is silent, the lookup fails and the probe with it.
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          goneUntilReplaced(() => executorDead, created),
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        ),
      },
    );
  });

  it.effect(
    "warms a standby executor with no worktree id; its plan is the project base under a placeholder and the standby's epoch, and nothing is leased",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makeJoiningClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              const entry = pool.entries[0];
              if (entry === undefined) throw new Error("no standby");
              const alias = `standby-${entry.id}`;
              expect(created).toHaveLength(1);
              // No worktree id on a standby's source: the daemon takes the placeholder from the plan
              // answer, while the harness root stays fixed across the later replan.
              expect(created[0]?.source).toEqual({
                kind: "capture",
                endpoint: "http://mend.test:3106",
                token: expect.stringMatching(/.+/),
                harnessHome: HARNESS_HOME_MOUNT_PATH,
              });
              // The base the standby materialises is fixed on its row.
              expect(entry.baseSha).toBe(project.adoptedSha);
              const api = servedSocketApis.get(entry.id)?.capture;
              if (api === undefined) throw new Error("the standby serves no capture api");
              // A daemon booted without a worktree id asks with none; the answer names the placeholder.
              const plan = yield* api.planGet({ worktree_id: null, epoch: 0 });
              expect(plan.worktree_id).toBe(alias);
              expect((yield* api.planGet({ worktree_id: alias, epoch: 0 })).worktree_id).toBe(
                alias,
              );
              expect(plan.epoch).toBe(entry.createdAt.getTime());
              expect(plan.head?.n).toBe(0);
              expect(plan.head?.manifest.sections.git.packs[0]).toMatch(
                /^projects\/proj-1\/packs\/[0-9a-f]{64}$/,
              );
              expect(plan.head?.manifest.sections.bulk).toBe("pending");
              expect(Object.keys(plan.get_urls)).toContain(plan.head?.manifest_key);
              // No worktree, no lease: heartbeats are acknowledged, writes refused until a claim.
              expect(memory.leases.size).toBe(0);
              expect(yield* api.heartbeat({ worktree_id: alias, epoch: plan.epoch })).toEqual({
                expires_in_secs: 30,
              });
              const refused = yield* api
                .uploadUrls({ worktree_id: alias, epoch: plan.epoch, keys: [] })
                .pipe(Effect.flip);
              expect(refused.reason).toBe("lease-lost");
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            hotWorkspacesLayer: clock.poolLayer(pool),
          },
        );
      }),
  );
});
