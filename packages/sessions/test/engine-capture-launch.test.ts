import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreesRepo, AgentMemoryRepo } from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Project, RepositoryCloneUrl, Session, SessionProcess } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { HARNESS_HOME_MOUNT_PATH, SessionEngine, WORKSPACE_MEND_TOML } from "@mend/sessions";
import {
  BlobStoreFsLive,
  captureKeys,
  type ExecutorTransport,
  decodeManifest,
  harnessHomePathOf,
  listCaptureFiles,
  processStatePathOf,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Tracer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { restoreConfiguredHarnessHome } from "./engine-capture-launch-fixtures.ts";
import {
  configuredHarnessHomePath,
  headReport,
  lifecycleLayer,
  provisionIn,
  shipCapturedHarnessHome,
} from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  captureAnswer,
  makeWorld,
  now,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  setupSibling,
  withEngine,
  withEngineEffect,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/**
 * What the TestClock cases wait on, beyond the shared clock's signals (`world.sessions`, the
 * lists a fake appends to, the PTY watcher's looks, the channel's checkpoint waits, each driven
 * as it opens so a harvest behind one goes on to its end): every read of an executor's capture
 * status (`captureStatus`), and every look the engine takes at a session's saved harness state
 * (`harnessStateFor`, the restart classification's read) as it ends, through `tracer`. A look
 * that finds nothing writes no row and logs nothing, so its span's end is the only sign it
 * happened.
 */
const makeLaunchClock = Effect.gen(function* () {
  const clock = yield* makeEngineClock(["sessions"], { drivesCheckpointWaits: true });
  let harnessStateLooks = 0;
  const base = yield* Effect.tracer;
  const tracer = Tracer.make({
    span: (options) => {
      const span = base.span(options);
      if (options.name !== "SessionEngine.harnessStateFor") return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        harnessStateLooks += 1;
        clock.changed();
      };
      return span;
    },
  });
  let statusReads = 0;
  /** The stand-in platform's `captureStatus`: no answer, as without it, and a signal per read. */
  const captureStatus = () =>
    Effect.sync(() => {
      statusReads += 1;
      clock.changed();
      return null;
    });
  /**
   * The PTY watcher's next 2 s look at `ptyId` finds the harness gone (`notYet` holds right up
   * to it), and Mend looks for the executor's end (`executorLostOnEnd`): `looks` reads of its
   * capture status a `pollInterval` apart, each one unanswered, before the harvest.
   */
  const harnessGone = (
    ptyId: string,
    notYet: () => boolean,
    looks: number,
    pollInterval: Duration.Duration,
  ) =>
    Effect.gen(function* () {
      const read = statusReads;
      yield* clock.nextLook(ptyId, notYet);
      for (let look = 1; look < looks; look++) {
        yield* clock.untilChanged(() => statusReads >= read + look, `the executor's look ${look}`);
        yield* TestClock.adjust(pollInterval);
      }
    });
  return {
    ...clock,
    captureStatus,
    tracer,
    harnessStateLooks: () => harnessStateLooks,
    harnessGone,
  };
});

/** Replace the immutable head with the pre-harness-root shape shipped by older Mend versions. */
const replaceHeadWithRootlessWorkspace = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
) =>
  Effect.gen(function* () {
    const chain = memory.chains.get(worktreeId);
    const oldId = chain?.headCapture ?? null;
    const oldHead = oldId === null ? null : (memory.captures.get(oldId) ?? null);
    if (chain === undefined || oldHead === null) throw new Error("worktree has no head to replace");
    const oldManifest = yield* decodeManifest(
      oldHead.manifestKey,
      new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", oldHead.manifestKey))),
    ).pipe(Effect.orDie);
    const emptyWorkspace = path.join(tmp, `rootless-${worktreeId}`);
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    const snapshot = snapshotDirectory(emptyWorkspace, captureKeys(worktreeId, oldHead.epoch), {
      chunkSize: 64,
    });
    const built = buildManifest({
      worktreeId,
      n: oldHead.n,
      parent: oldHead.parent,
      epoch: oldHead.epoch,
      seq: Number(oldHead.seq),
      kind: oldHead.kind,
      git: oldManifest.sections.git,
      workspace: { root: snapshot.root, packs: snapshot.packs },
      bulk: oldManifest.sections.bulk,
      ...(oldManifest.checkpoint === undefined ? {} : { checkpoint: oldManifest.checkpoint }),
    });
    yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );
    memory.captures.delete(oldHead.id);
    memory.captures.set(built.id, {
      ...oldHead,
      id: built.id,
      manifestKey: built.key,
      sections: built.manifest.sections,
    });
    chain.headCapture = built.id;
  });

const verifyDeferredFinalHarvest = (pathKind: "stop" | "mode-switch" | "sweep") =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const clock = yield* makeLaunchClock;
    const memory = makeMemoryCaptureStore();
    // What the agent learned, read back from the final capture (docs/adr/0009).
    const readBacks = clock.watched<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]>([]);
    const flushStarted = yield* Deferred.make<void>();
    const releaseFlush = yield* Deferred.make<void>();
    const rolloutId = crypto.randomUUID();
    const transcriptName = `rollout-2026-09-15T10-00-00-${rolloutId}.jsonl`;
    const transcriptContents = `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `${pathKind} final answer` }],
      },
    })}\n`;
    const relocation = { homePath: "", executorRoot: "" };
    let testRoot = "";
    let finalCapture: Effect.Effect<void> = Effect.die("final capture not prepared");
    let flushes = 0;
    let shipped = false;

    yield* withPreparedEngineEffect(
      (world, tmp) => setup(tmp, world),
      (world, tmp, project) =>
        Effect.gen(function* () {
          testRoot = tmp;
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          const request = created[0];
          if (request === undefined) throw new Error("cold launch made no create request");
          finalCapture = shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            request,
            relocation.executorRoot,
          ).pipe(Effect.asVoid, Effect.orDie);
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty" && process.exitedAt === null,
          );
          if (agent === undefined) throw new Error("launch recorded no agent");
          // The flush that ships the final capture: the mode switch's own, or the drain's final,
          // which is a stop's first and only flush (decision 50).
          const flushThatShips = 1;

          if (pathKind === "mode-switch") {
            const switched = yield* engine
              .switchMode(
                session.id,
                "protocol",
                { mode: "protocol", permissionMode: "bypass" },
                "user-1",
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(flushStarted);
            expect(flushes).toBe(flushThatShips);
            expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(true);
            yield* Deferred.succeed(releaseFlush, undefined);
            yield* Fiber.join(switched);
            expect(attached).toHaveLength(1);
            // The successor starts in the workspace the ended agent held: no second create, no
            // save-stop-boot-restore for a process swap (the 2026-10-02 pickup took 2 min 14 s).
            expect(created).toHaveLength(1);
            const successor = [...world.processes.values()].find(
              (process) => process.kind === "agent-protocol",
            );
            expect(successor?.sealantWorkspaceId).toBe(agent.sealantWorkspaceId);
          } else {
            if (pathKind === "sweep") {
              world.processes.set(
                agent.id,
                new SessionProcess({
                  ...agent,
                  status: "exited",
                  exitCode: 0,
                  exitedAt: now(),
                  updatedAt: now(),
                }),
              );
            }
            yield* engine.stop(session.id);
            yield* Deferred.await(flushStarted);
            expect(flushes).toBe(flushThatShips);
            expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(true);
            yield* Deferred.succeed(releaseFlush, undefined);
          }
          yield* clock.untilChanged(
            () => world.sessions.get(session.id)?.hasTranscript === true,
            `${pathKind} final capture harvest`,
          );
          const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
          expect(fs.readFileSync(path.join(stateDir, "transcript.native"), "utf8")).toContain(
            `${pathKind} final answer`,
          );
          if (pathKind !== "mode-switch") {
            yield* clock.untilChanged(
              () => readBacks.length > 0,
              `${pathKind} agent memory read back`,
            );
            expect(readBacks[0]?.session).toEqual([
              {
                path: ".claude/projects/-workspace-repo/memory/learned.md",
                encoding: "utf8",
                contents: `${pathKind}: the API listens on 3101\n`,
              },
            ]);
          }
        }),
      {
        captured: memory,
        prepareWorld: clock.prepareWorld,
        wrapCaptureChannel: clock.wrapCaptureChannel,
        agentMemoryLayer: agentMemoryLayerOf({
          readBack: (input) =>
            Effect.sync(() => {
              readBacks.push(input);
              return { saved: [], merged: [], deleted: [], skipped: [] };
            }),
        }),
        protocolHostLayer: recordingProtocolHostLayer(attached, []),
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
            beforeCreate: (options) =>
              Effect.gen(function* () {
                relocation.executorRoot = path.join(
                  testRoot,
                  `${pathKind}-executor-${created.length}`,
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
            beforeOpen: () => {
              if (spawned.length > 0) return;
              const transcript = path.join(
                relocation.homePath,
                ".codex",
                "sessions",
                "2026",
                "09",
                "15",
                transcriptName,
              );
              fs.mkdirSync(path.dirname(transcript), { recursive: true });
              fs.writeFileSync(transcript, transcriptContents);
              const learned = path.join(
                relocation.homePath,
                ".claude/projects/-workspace-repo/memory/learned.md",
              );
              fs.mkdirSync(path.dirname(learned), { recursive: true });
              fs.writeFileSync(learned, `${pathKind}: the API listens on 3101\n`);
            },
            flush: () => {
              flushes += 1;
              return Effect.gen(function* () {
                if (flushes === 1 && !shipped) {
                  yield* Deferred.succeed(flushStarted, undefined);
                  yield* Deferred.await(releaseFlush);
                  yield* finalCapture;
                  shipped = true;
                }
                return captureAnswer({
                  ...(shipped ? headReport(memory) : {}),
                  epoch: 2,
                  uploadedObjects: shipped ? 1 : 0,
                  uploadedBytes: shipped ? 1 : 0,
                  registered: shipped ? 1 : 0,
                });
              });
            },
          },
        ),
      },
    );
  });

/** The engine's read of the worktree's `mend.toml` inside a workspace. */
const readsToml = (argv: ReadonlyArray<string>) => argv.at(-1) === WORKSPACE_MEND_TOML;
describe("SessionEngine capture mode", () => {
  it("tells the daemon only what the deployment stated about its transport", async () => {
    // Without a statement the source names no transport: the daemon then requires verified
    // HTTPS, and Mend does not soften that on its own. With one, exactly that statement goes.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
    const launchWith = async (executorTransport: ExecutorTransport | undefined) => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
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
            yield* engine.launch(session.id, ["codex"]);
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(created),
          ...(executorTransport === undefined ? {} : { executorTransport }),
        },
      );
      const source = created[0]?.source;
      return source?.kind === "capture" ? source.transport : "not a capture source";
    };
    expect(await launchWith(undefined)).toBeUndefined();
    expect(
      await launchWith({ plaintext: false, channelCaPem: undefined, objectCaPem: undefined }),
    ).toBeUndefined();
    expect(
      await launchWith({ plaintext: true, channelCaPem: undefined, objectCaPem: undefined }),
    ).toEqual({ plaintext: true });
    expect(
      await launchWith({
        plaintext: false,
        channelCaPem: "-----BEGIN CERTIFICATE-----\nchannel\n-----END CERTIFICATE-----\n",
        objectCaPem: "-----BEGIN CERTIFICATE-----\nobjects\n-----END CERTIFICATE-----\n",
      }),
    ).toEqual({
      channelCaPem: "-----BEGIN CERTIFICATE-----\nchannel\n-----END CERTIFICATE-----\n",
      objectCaPem: "-----BEGIN CERTIFICATE-----\nobjects\n-----END CERTIFICATE-----\n",
    });
  });

  it.effect(
    "relocates HOME into the configured capture root before launch, harvests the final flush, and restores it before pickup",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const clock = yield* makeLaunchClock;
        const ptyStates = clock.ptyStates;
        const events: string[] = [];
        const memory = makeMemoryCaptureStore();
        const flushStarted = yield* Deferred.make<void>();
        const releaseFlush = yield* Deferred.make<void>();
        const pollInterval = Duration.millis(10);
        const rolloutId = crypto.randomUUID();
        const transcriptName = `rollout-2026-09-15T10-00-00-${rolloutId}.jsonl`;
        const transcriptContents = `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
          },
        })}\n`;
        const relocation = { homePath: "", executorRoot: "", observed: events };
        let testRoot = "";
        let firstRequest: CreateOptions | undefined;
        let firstExecutorRoot = "";
        let finalCapture: Effect.Effect<void> = Effect.die("final capture not prepared");
        let flushes = 0;
        let shipped = false;
        let opens = 0;

        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              firstRequest = created[0];
              if (firstRequest === undefined) throw new Error("cold launch made no create request");
              firstExecutorRoot = relocation.executorRoot;
              expect(firstRequest.source).toEqual({
                kind: "capture",
                endpoint: "http://mend.test:3106",
                worktreeId: session.worktreeId,
                token: expect.stringMatching(/.+/),
                harnessHome: HARNESS_HOME_MOUNT_PATH,
              });
              const selectedRoot = configuredHarnessHomePath(firstRequest, firstExecutorRoot);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              finalCapture = shipCapturedHarnessHome(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                firstRequest,
                firstExecutorRoot,
              ).pipe(Effect.asVoid, Effect.orDie);
              expect(events.slice(0, 3)).toEqual(["restore", "relocate", "open"]);
              expect(fs.realpathSync(path.join(relocation.homePath, ".codex"))).toBe(
                path.join(selectedRoot, ".codex"),
              );
              expect(fs.readFileSync(path.join(selectedRoot, ".codex", "auth.json"), "utf8")).toBe(
                "fresh credential 1",
              );

              const agent = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty" && process.exitedAt === null,
              );
              if (agent?.sealantSessionId === null || agent?.sealantSessionId === undefined) {
                throw new Error("the launch recorded no agent PTY");
              }
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The watcher's next look (every 2 s) finds the harness gone; Mend then looks for
              // the executor's end (`EXECUTOR_END_LOOKS`, 6, a poll apart), which never answers.
              yield* clock.harnessGone(
                agent.sealantSessionId,
                () => flushes === 0,
                6,
                pollInterval,
              );

              // The stop's one flush is the drain's final (decision 50); the harvest waits for its
              // registration before it reads the head.
              yield* Deferred.await(flushStarted);
              expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(true);
              yield* Deferred.succeed(releaseFlush, undefined);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.hasTranscript === true,
                "the final capture harvest",
              );

              const head = memory.captures.get(
                memory.chains.get(session.worktreeId)?.headCapture ?? "",
              );
              if (head === undefined) throw new Error("the final flush registered no capture");
              const manifest = yield* decodeManifest(
                head.manifestKey,
                new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", head.manifestKey))),
              ).pipe(Effect.orDie);
              const files = yield* listCaptureFiles(manifest, "workspace", "harness").pipe(
                Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
                Effect.orDie,
              );
              expect(files.map((file) => file.path)).toContain(
                `harness/.codex/sessions/2026/09/15/rollout-2026-09-15T10-00-00-${rolloutId}.jsonl`,
              );
              const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
              expect(fs.readFileSync(path.join(stateDir, "transcript.native"), "utf8")).toContain(
                "final answer",
              );

              // A replacement executor starts empty. Its create materializes the captured harness
              // root, then Mend recreates HOME links before opening the resumed process.
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.settledAt !== null,
                "the first process settle",
              );
              const resumed = yield* engine.resumeSession(session.id, null);
              expect(resumed.status).toBe("running");
              expect(created).toHaveLength(2);
              expect(events.slice(-2)).toEqual(["relocate", "open"]);
              const resumedAgent = [...world.processes.values()].findLast(
                (process) => process.kind === "agent-pty" && process.exitedAt === null,
              );
              expect(resumedAgent?.argv.slice(0, 3)).toEqual(["codex", "resume", rolloutId]);
              expect(resumedAgent?.providerSessionId).toBe(rolloutId);
              expect(spawned).toHaveLength(2);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            drainPolicy: { pollInterval },
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              spawned,
              undefined,
              undefined,
              ptyStates,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                relocation,
                captureStatus: clock.captureStatus,
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(testRoot, `executor-${created.length}`);
                    relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                    fs.rmSync(relocation.executorRoot, { recursive: true, force: true });
                    fs.mkdirSync(relocation.executorRoot, { recursive: true });
                    const source = options.source;
                    if (source?.kind !== "capture" || source.worktreeId === undefined) {
                      throw new Error("test executor requires a cold capture source");
                    }
                    yield* restoreConfiguredHarnessHome(
                      testRoot,
                      memory,
                      WorktreeId.make(source.worktreeId),
                      options,
                      relocation.executorRoot,
                    );
                    events.push("restore");
                    fs.mkdirSync(path.join(relocation.homePath, ".codex"), { recursive: true });
                    fs.writeFileSync(
                      path.join(relocation.homePath, ".codex", "auth.json"),
                      `fresh credential ${created.length}`,
                    );
                  }),
                beforeOpen: () => {
                  opens += 1;
                  events.push("open");
                  const transcript = path.join(
                    relocation.homePath,
                    ".codex",
                    "sessions",
                    "2026",
                    "09",
                    "15",
                    transcriptName,
                  );
                  if (opens === 1) {
                    fs.mkdirSync(path.dirname(transcript), { recursive: true });
                    fs.writeFileSync(transcript, transcriptContents);
                    return;
                  }
                  expect(fs.readFileSync(transcript, "utf8")).toBe(transcriptContents);
                  expect(
                    fs.readFileSync(path.join(relocation.homePath, ".codex", "auth.json"), "utf8"),
                  ).toBe("fresh credential 2");
                },
                flush: () =>
                  Effect.gen(function* () {
                    flushes += 1;
                    if (flushes >= 1 && !shipped) {
                      yield* Deferred.succeed(flushStarted, undefined);
                      yield* Deferred.await(releaseFlush);
                      yield* finalCapture;
                      shipped = true;
                    }
                    return {
                      epoch: 2,
                      worktreeId: "",
                      pending: 0,
                      stagedBytes: 0,
                      uploadedObjects: shipped ? 1 : 0,
                      uploadedBytes: shipped ? 1 : 0,
                      registered: shipped ? 1 : 0,
                      fenced: false,
                      paused: false,
                      refused: [],
                    } satisfies WorkspaceCaptureStatus;
                  }),
              },
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "waits for a deferred final registration before stop trigger=null harvest reads the head",
    () => verifyDeferredFinalHarvest("stop"),
    { timeout: 20_000 },
  );

  it.effect(
    "waits for a deferred final registration before mode switch harvest reads the head",
    () => verifyDeferredFinalHarvest("mode-switch"),
    { timeout: 20_000 },
  );

  it.effect(
    "waits for a deferred final registration before leftover sweep harvest reads the head",
    () => verifyDeferredFinalHarvest("sweep"),
    { timeout: 20_000 },
  );

  it("reads mend.toml from the live executor, not the host: lists and runs a recipe, and tells the agent about it", async () => {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const memory = makeMemoryCaptureStore();
    /** The executor's own copy of the worktree file; null is no file. */
    let workspaceToml: string | null =
      '[service.web]\ncommand = "pnpm dev --host"\nport = 5173\nbrowserScheme = "http"\n';
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

          // No workspace yet: the file is unobservable, which is a typed refusal, never a defect.
          expect(yield* engine.listServiceRecipes(session.id)).toEqual([]);
          const refused = yield* engine.runServiceRecipe(session.id, "web").pipe(Effect.flip);
          expect(refused._tag).toBe("ServiceStartError");
          expect(refused.message).toContain("no live workspace");
          expect(execCalls.filter(readsToml)).toHaveLength(0);

          yield* engine.launch(session.id, ["codex"]);

          // The workspace note is written in capture mode too, naming the declared recipe.
          const note = execCalls.find((argv) =>
            argv.some((part) => part.includes("<!-- mend:mounts -->")),
          );
          expect(note?.at(-1)).toContain("## Mend Services");
          expect(note?.at(-1)).toContain("[--http|--https]");
          expect(note?.at(-1)).toContain("Declared Services (mend.toml + project): web");

          const listed = yield* engine.listServiceRecipes(session.id);
          expect(listed.map((recipe) => [recipe.name, recipe.port, recipe.browserScheme])).toEqual([
            ["web", 5173, "http"],
          ]);

          const service = yield* engine.runServiceRecipe(session.id, "web");
          expect(service.service.declarationSource).toBe("recipe-file");
          expect(service.service.browserScheme).toBe("http");
          expect(service.attempts[0]?.argv).toEqual(["sh", "-c", "pnpm dev --host"]);

          // A malformed file is a readable refusal naming the problem.
          workspaceToml = "[service.web\n";
          const malformed = yield* engine.runServiceRecipe(session.id, "web").pipe(Effect.flip);
          expect(malformed._tag).toBe("ServiceStartError");
          expect(malformed.message).toContain("not valid TOML");
          const listFailure = yield* engine.listServiceRecipes(session.id).pipe(Effect.flip);
          expect(listFailure._tag).toBe("RecipeFileError");

          // No file in the executor: no declarations.
          workspaceToml = null;
          expect(yield* engine.listServiceRecipes(session.id)).toEqual([]);
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
          execCalls,
          undefined,
          {
            exec: (argv) =>
              !readsToml(argv)
                ? undefined
                : workspaceToml === null
                  ? { exitCode: 44, stdout: "", stderr: "" }
                  : { exitCode: 0, stdout: workspaceToml, stderr: "" },
          },
        ),
      },
    );
  });

  it.effect(
    "provisions capture 0 and launches a capture-sourced workspace: no mounts, no bind, a launch-claimed lease; a user stop flushes the executor before its workspace goes",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const binds: string[] = [];
        const clock = yield* makeLaunchClock;
        /** Flushes and stops in the order the platform saw them. */
        const events = clock.watched<string>([]);
        const memory = makeMemoryCaptureStore();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              // No directory was made: the authority is the chain, head at capture 0 from the base.
              expect(
                fs.existsSync(path.join(tmp, "store", "fixture", "worktrees", session.worktree)),
              ).toBe(false);
              const chain = memory.chains.get(session.worktreeId);
              expect(chain?.headN).toBe(0);
              const cap0 = memory.captures.get(chain?.headCapture ?? "");
              expect(cap0?.kind).toBe("checkpoint");
              expect(memory.leases.get(session.worktreeId)?.epoch).toBe(1);
              expect(
                (memory.leases.get(session.worktreeId)?.expiresAt ?? 0) <= memory.clock.now(),
              ).toBe(true);
              // Both start checkpoints exist and both are capture 0: no executor has captured
              // anything yet, so the worktree is the base and the session's own checkpoint is the
              // base commit observed at capture 0 — nothing derived on the runner, no pack written.
              const starts = world.checkpoints.filter((c) => c.worktreeId === session.worktreeId);
              expect(starts.map((c) => c.ordinal)).toEqual([0, 1]);
              expect(starts.map((c) => c.sha)).toEqual([session.baseSha, session.baseSha]);
              const derived = [...memory.packs.values()].filter(
                (pack) =>
                  pack.worktreeId === session.worktreeId && pack.key.startsWith("projects/"),
              );
              expect(derived).toHaveLength(0);

              yield* engine.launch(session.id, ["codex"]);

              expect(created).toHaveLength(1);
              const request = created[0];
              // The capture source carries the channel token and the daemon-owned harness root.
              expect(request?.source).toEqual({
                kind: "capture",
                endpoint: "http://mend.test:3106",
                worktreeId: session.worktreeId,
                token: expect.stringMatching(/.+/),
                harnessHome: HARNESS_HOME_MOUNT_PATH,
              });
              expect(request !== undefined && "captureToken" in request).toBe(false);
              expect(request !== undefined && "mounts" in request).toBe(false);
              expect(binds).toEqual([]);
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.executorId).toBe(session.id);
              expect(lease?.epoch).toBe(2);
              expect((lease?.expiresAt ?? 0) > memory.clock.now()).toBe(true);

              // A user stop is a planned stop: one final flush before the workspace goes. The user
              // mark and the harvest read that flush's head (ADR 0002 decision 50); before 2026-10-03
              // each asked for a flush of its own, three before the final one.
              yield* engine.stop(session.id);
              yield* clock.untilChanged(() => events.includes("workspace-1"), "the workspace stop");
              expect(events).toEqual(["flush:workspace-1", "workspace-1"]);
              expect(world.sessions.get(session.id)?.hasTranscript).toBe(false);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              events,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              binds,
              { flushed: events },
            ),
          },
        );
      }),
  );

  it.effect(
    "adds a repository of another project to a live session: a worktree of that project, a nested clone of its origin linked at /workspace/repos/<name>, and the refusals in the person's words (docs/adr/0010)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const clock = yield* makeLaunchClock;
        const execCalls = clock.watched<ReadonlyArray<string>>([]);
        const logs = clock.watched<string>([]);
        const memory = makeMemoryCaptureStore();
        yield* withPreparedEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const project = yield* setup(tmp, world);
              const core = yield* setupSibling(tmp, world, "core", project.originUrl ?? "");
              return { project, core };
            }),
          (world, tmp, { project, core }) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const worktrees = yield* WorktreesRepo;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "fix-login",
                ownerUserId: "user-fixture",
                base: null,
              });
              // Nothing to add into before the workspace is live.
              const early = yield* engine
                .addRepository(session.id, { project: "core", name: null, worktree: null })
                .pipe(Effect.flip);
              expect(early._tag === "RepositoryAddError" ? early.message : early._tag).toContain(
                "no live workspace",
              );

              yield* engine.launch(session.id, ["codex"]);
              expect(created).toHaveLength(1);

              // What may be added: the sibling, never the session's own project.
              const addable = yield* engine.addableProjects(session.id);
              expect(addable.map((candidate) => candidate.name)).toEqual(["core"]);

              const row = yield* engine.addRepository(session.id, {
                project: "core",
                name: null,
                worktree: null,
              });
              expect(row.state).toBe("adding");
              expect(row.name).toBe("core");
              expect(row.path).toBe("/workspace/repos/core");
              expect(row.capture).toBe("nested");
              expect(row.source).toBe("origin");
              // The worktree of the sibling project, named after the session's own worktree.
              const siblingWorktree = yield* worktrees.byName(core.id, "fix-login");
              expect(siblingWorktree?.id).toBe(row.worktreeId);
              expect(siblingWorktree?.branch).toBe("mend/fix-login");
              expect(row.branch).toBe("mend/fix-login");
              expect(row.baseSha).toBe(core.adoptedSha);
              // Its chain starts at capture 0, like any worktree's.
              expect(memory.chains.get(row.worktreeId)?.headN).toBe(0);

              yield* clock.untilChanged(
                () =>
                  execCalls.some((argv) =>
                    argv.join("\n").includes("git clone --quiet --no-checkout"),
                  ),
                "the clone in the workspace",
              );
              const clone = execCalls.find((argv) => argv.join("\n").includes("git clone"));
              const script = clone?.join("\n") ?? "";
              expect(script).toContain(
                `git clone --quiet --no-checkout -- '${core.originUrl}' '/workspace/repo/.mend/repos/core'`,
              );
              expect(script).toContain(`checkout --quiet -B 'mend/fix-login' '${core.adoptedSha}'`);
              expect(script).toContain(
                `ln -sfn '/workspace/repo/.mend/repos/core' '/workspace/repos/core'`,
              );
              expect(script).toContain("info/exclude");

              // The row settles once the clone answered; the stand-in executor answers at once. The
              // engine says so right after it writes the row (`bringRepositoryIn`).
              yield* clock.untilChanged(
                () => logs.some((line) => line.includes("session engine: repository added")),
                "the row to settle",
              );
              const listed = yield* engine.listRepositories(session.id);
              expect(listed.map((entry) => [entry.name, entry.state, entry.error])).toEqual([
                ["core", "ready", null],
              ]);
              expect(yield* engine.addableProjects(session.id)).toEqual([]);

              // Refusals, each in the person's words.
              const refusal = (input: {
                readonly project: string;
                readonly name: string | null;
                readonly worktree: string | null;
              }) =>
                engine
                  .addRepository(session.id, input)
                  .pipe(Effect.flip)
                  .pipe(
                    Effect.map((error) =>
                      error._tag === "RepositoryAddError"
                        ? [error.reason, error.message]
                        : [error._tag, String(error)],
                    ),
                  );
              expect(yield* refusal({ project: "fixture", name: null, worktree: null })).toEqual([
                "own-project",
                "fixture is this session's own project · it is at /workspace/repo",
              ]);
              expect((yield* refusal({ project: "nope", name: null, worktree: null }))[0]).toBe(
                "unknown-project",
              );
              expect(
                (yield* refusal({ project: "core", name: "Bad Name", worktree: "other" }))[0],
              ).toBe("bad-name");
              expect((yield* refusal({ project: "core", name: null, worktree: "other" }))[0]).toBe(
                "name-taken",
              );
              // The sibling worktree exists now: adding under another name would join it.
              expect((yield* refusal({ project: "core", name: "core-2", worktree: null }))[0]).toBe(
                "worktree-taken",
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
              execCalls,
            ),
            logs,
          },
        );
      }),
  );

  it.effect(
    "clones an origin adopted with a token in it without the token: never in the clone's argv, its log line, nor what `mend repo projects` prints (review of mend#555, P2-2, N-1)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const clock = yield* makeLaunchClock;
        const execCalls = clock.watched<ReadonlyArray<string>>([]);
        const logs: Array<string> = [];
        const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        yield* withPreparedEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const project = yield* setup(tmp, world);
              const sibling = yield* setupSibling(tmp, world, "core", project.originUrl ?? "");
              world.projects.set(
                sibling.id,
                new Project({ ...sibling, originUrl: `https://${token}@github.com/acme/core.git` }),
              );
              return project;
            }),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "fix-login",
                ownerUserId: "user-fixture",
                base: null,
              });
              yield* engine.launch(session.id, ["codex"]);
              // What `mend repo projects` prints inside the workspace names the origin without it.
              const addable = yield* engine.addableProjects(session.id);
              expect(addable.map((candidate) => candidate.originUrl)).toEqual([
                "https://github.com/acme/core.git",
              ]);
              yield* engine.addRepository(session.id, {
                project: "core",
                name: null,
                worktree: null,
              });
              yield* clock.untilChanged(
                () => execCalls.some((argv) => argv.join("\n").includes("git clone --quiet")),
                "the clone in the workspace",
              );
              const clone = execCalls.find((argv) => argv.join("\n").includes("git clone")) ?? [];
              expect(clone.join("\n")).toContain(
                "git clone --quiet --no-checkout -- 'https://github.com/acme/core.git'",
              );
              expect(execCalls.map((argv) => argv.join("\n")).join("\n")).not.toContain(token);
              expect(logs.join("\n")).not.toContain(token);
            }),
          {
            captured: makeMemoryCaptureStore(),
            logs,
            sealantLayer: lifecycleLayer(created, { execCalls }),
          },
        );
      }),
  );

  it("refuses to add a private project to a session whose worktree others can open, and lists it only where nobody else can (ADR 0011, decision 14)", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const sibling = yield* setupSibling(tmp, world, "vault", project.originUrl ?? "");
        // The session owner's own private project: only they can see it.
        const vault = new Project({
          ...sibling,
          visibility: "private",
          createdByUserId: "user-fixture",
        });
        world.projects.set(vault.id, vault);
        const engine = yield* SessionEngine;
        const worktrees = yield* WorktreesRepo;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: "fix-login",
          ownerUserId: "user-fixture",
          base: null,
        });

        // `fixture` is shared: every member can open this worktree and would receive vault's
        // files and history with its captures.
        expect(yield* engine.addableProjects(session.id)).toEqual([]);
        const refused = yield* engine
          .addRepository(session.id, { project: "vault", name: null, worktree: null })
          .pipe(Effect.flip);
        expect(
          refused._tag === "RepositoryAddError"
            ? [refused.reason, refused.message]
            : [refused._tag, String(refused)],
        ).toEqual([
          "private-project",
          "vault is private and fixture is shared · its files and history would be saved with this session's worktree, which every member of the organization can open · add it from a session in a private project of yours, or ask an owner to share vault",
        ]);
        // Nothing was made in vault.
        expect(yield* worktrees.byName(vault.id, "fix-login")).toBeNull();

        // Once the session's own project is private to the same person, nobody else can open
        // the worktree: vault is listed, and the add goes on to the next check.
        world.projects.set(
          project.id,
          new Project({ ...project, visibility: "private", createdByUserId: "user-fixture" }),
        );
        expect((yield* engine.addableProjects(session.id)).map((row) => row.name)).toEqual([
          "vault",
        ]);
        const next = yield* engine
          .addRepository(session.id, { project: "vault", name: null, worktree: null })
          .pipe(Effect.flip);
        expect(next._tag === "RepositoryAddError" ? next.reason : next._tag).toBe("not-live");
      }),
    );
  });

  it.effect("keeps transcript classification unknown when the capture head cannot be read", () =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const clock = yield* makeLaunchClock;
      const stopped = clock.watched<string>([]);
      const memory = makeMemoryCaptureStore();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);

            // Model a damaged/unavailable chain read after launch. It must not become the factual
            // claim that no transcript existed.
            memory.chains.delete(session.worktreeId);
            yield* engine.stop(session.id);
            yield* clock.untilChanged(
              () => stopped.includes("workspace-1"),
              "the post-harvest workspace stop",
            );
            expect(world.sessions.get(session.id)?.hasTranscript).toBeNull();
          }),
        {
          captured: memory,
          prepareWorld: clock.prepareWorld,
          wrapCaptureChannel: clock.wrapCaptureChannel,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it.effect.each([
    { storage: "missing head", expected: null },
    { storage: "missing manifest", expected: null },
    { storage: "pending workspace", expected: null },
    { storage: "stale final from a prior epoch", expected: null },
    { storage: "final capture without transcript", expected: null },
    { storage: "final capture with transcript", expected: true },
  ])(
    "classifies a transcript at restart when capture storage is $storage",
    ({ storage, expected }) =>
      Effect.gen(function* () {
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeLaunchClock;
        const sessionId = SessionId.make("settled-capture-storage-unavailable");
        const worktreeId = WorktreeId.make("wt-capture-storage-unavailable");
        yield* withPreparedEngineEffect(
          () => Effect.void,
          (world) =>
            Effect.gen(function* () {
              yield* SessionEngine;
              // The classification runs forked, after the boot: a reading is waited for; an absent
              // one is read once the boot's look at the saved harness state has ended.
              if (expected === null) {
                yield* clock.untilChanged(
                  () => clock.harnessStateLooks() > 0,
                  "the restart's look at the saved harness state",
                );
              } else {
                yield* clock.untilChanged(
                  () => world.sessions.get(sessionId)?.hasTranscript === expected,
                  "the restart transcript classification",
                );
              }
              expect(world.sessions.get(sessionId)?.hasTranscript).toBe(expected);
            }),
          {
            captured: memory,
            prepareWorld: (world, tmp) => {
              clock.prepareWorld(world);
              const timestamp = now();
              const project = new Project({
                id: ProjectId.make("project-capture-storage-unavailable"),
                name: "capture-storage-unavailable",
                organizationId: OrganizationId.make("org-test"),
                visibility: "shared",
                createdByUserId: null,
                originUrl: RepositoryCloneUrl.make("git://capture-storage-unavailable/repo"),
                storePath: path.join(tmp, "store", "capture-storage-unavailable", "repo.git"),
                defaultBranch: "main",
                adoptedSha: Sha.make("base-sha"),
                autoTour: "inherit",
                autoName: "inherit",
                autoLand: "inherit",
                autoSuggest: "inherit",
                backgroundSessions: "inherit",
                gitAuthMode: "mend-key",
                workspaceImage: null,
                applyDotfiles: true,
                defaultShellProfile: true,
                inheritUserSkills: true,
                hotSessions: 0,
                installCommand: null,
                installEnabled: true,
                createdAt: timestamp,
                updatedAt: timestamp,
              });
              world.projects.set(project.id, project);
              world.sessions.set(
                sessionId,
                new Session({
                  id: sessionId,
                  projectId: project.id,
                  worktreeId,
                  harness: "codex",
                  providerSessionId: null,
                  label: null,
                  worktree: worktreeId,
                  branch: `mend/wt/${worktreeId}`,
                  baseSha: Sha.make("base-sha"),
                  baseRef: "main",
                  contextSnapshotId: null,
                  referenceMounts: [],
                  extraMounts: [],
                  sealantRunId: SealantRunId.make("run-capture-storage-unavailable"),
                  sealantWorkspaceId: null,
                  sealantSessionId: null,
                  workspaceExpiresAt: null,
                  workspaceTtlRenewedAt: null,
                  workspaceTtlRenewalFailedAt: null,
                  workspaceTtlRenewalError: null,
                  workspaceImage: null,
                  dotfiles: null,
                  ownerUserId: "user-fixture",
                  hasTranscript: null,
                  status: "completed",
                  summary: null,
                  lastSeenSequence: 0n,
                  recordHistoryComplete: true,
                  startedAt: timestamp,
                  settledAt: timestamp,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                }),
              );
              const processId = SessionProcessId.make("process-capture-storage-unavailable");
              world.processes.set(
                processId,
                new SessionProcess({
                  id: processId,
                  sessionId,
                  sealantWorkspaceId: SealantWorkspaceId.make("workspace-storage-unavailable"),
                  sealantSessionId: "pty-storage-unavailable",
                  sealantRunId: SealantRunId.make("run-capture-storage-unavailable"),
                  launchCorrelationId: null,
                  serviceId: null,
                  attemptOrdinal: null,
                  kind: "agent-pty",
                  harness: "codex",
                  providerSessionId: null,
                  protocolOptions: null,
                  label: "codex",
                  argv: ["codex"],
                  status: "exited",
                  exitCode: 0,
                  workspacePort: null,
                  protocol: "tcp",
                  hostPort: null,
                  createdAt: timestamp,
                  exitedAt: timestamp,
                  updatedAt: timestamp,
                }),
              );
              if (storage === "missing head") {
                memory.chains.set(worktreeId, {
                  headCapture: "missing-capture-row",
                  headN: 0,
                  headEpoch: 1,
                });
                return;
              }

              if (storage === "missing manifest") {
                const captureId = "missing-capture-object";
                memory.chains.set(worktreeId, { headCapture: captureId, headN: 0, headEpoch: 1 });
                memory.captures.set(captureId, {
                  id: captureId,
                  worktreeId,
                  n: 0,
                  parent: null,
                  epoch: 1,
                  seq: 0n,
                  kind: "final",
                  manifestKey: "missing/manifest.json",
                  sections: {
                    git: {
                      packs: [],
                      refs: {},
                      head: "refs/heads/main",
                      fsck: "verified",
                    },
                    workspace: { root: "", packs: [] },
                    bulk: "pending",
                  },
                  gitFsck: "verified",
                  createdAt: timestamp,
                });
                return;
              }

              if (storage === "pending workspace") {
                const built = buildManifest({
                  worktreeId,
                  n: 0,
                  parent: null,
                  epoch: 1,
                  seq: 0,
                  kind: "final",
                });
                const target = path.join(tmp, "blobs", built.key);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, built.bytes);
                memory.chains.set(worktreeId, { headCapture: built.id, headN: 0, headEpoch: 1 });
                memory.captures.set(built.id, {
                  id: built.id,
                  worktreeId,
                  n: 0,
                  parent: null,
                  epoch: 1,
                  seq: 0n,
                  kind: "final",
                  manifestKey: built.key,
                  // Capture rows preserve the section state independently. Keep the blob readable so
                  // removing the pending guard reaches listCaptureFiles and falsely confirms absence.
                  sections: { ...built.manifest.sections, workspace: "pending" },
                  gitFsck: "verified",
                  createdAt: timestamp,
                });
                return;
              }

              const tree = path.join(tmp, "restart-capture-without-transcript");
              fs.mkdirSync(path.join(tree, "harness"), { recursive: true });
              if (storage === "final capture with transcript") {
                const transcript = path.join(
                  tree,
                  "harness",
                  ".codex",
                  "sessions",
                  "2026",
                  "09",
                  "15",
                  "rollout-2026-09-15T10-00-00-11111111-2222-3333-4444-555555555555.jsonl",
                );
                fs.mkdirSync(path.dirname(transcript), { recursive: true });
                fs.writeFileSync(transcript, "{}\n");
              }
              const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, 1), {
                chunkSize: 64,
              });
              const built = buildManifest({
                worktreeId,
                n: 0,
                parent: null,
                epoch: 1,
                seq: 0,
                kind: "final",
                git: {
                  packs: [],
                  refs: {},
                  head: "refs/heads/main",
                  fsck: "verified",
                },
                workspace: { root: snapshot.root, packs: snapshot.packs },
              });
              for (const [key, bytes] of new Map([...snapshot.objects, [built.key, built.bytes]])) {
                const target = path.join(tmp, "blobs", key);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, bytes);
              }
              memory.chains.set(worktreeId, {
                headCapture: built.id,
                headN: 0,
                headEpoch: storage === "stale final from a prior epoch" ? 2 : 1,
              });
              memory.captures.set(built.id, {
                id: built.id,
                worktreeId,
                n: 0,
                parent: null,
                epoch: 1,
                seq: 0n,
                kind: "final",
                manifestKey: built.key,
                sections: built.manifest.sections,
                gitFsck: "verified",
                createdAt: timestamp,
              });
            },
          },
        ).pipe(Effect.withTracer(clock.tracer));
      }),
  );

  it.effect(
    "keeps a failed final flush unknown after restart with an earlier same-epoch final capture",
    () =>
      Effect.gen(function* () {
        const clock = yield* makeLaunchClock;
        const fixture = {
          world: makeWorld(),
          tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-restart-test-")),
        };
        clock.prepareWorld(fixture.world);
        const memory = makeMemoryCaptureStore();
        const created: Array<CreateOptions> = [];
        const stopped: string[] = [];
        const relocation = { homePath: "", executorRoot: "" };
        let testRoot = "";
        let earlierFinal: Effect.Effect<void> = Effect.die("earlier final capture not prepared");
        let flushes = 0;
        try {
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, tmp, project) =>
              Effect.gen(function* () {
                testRoot = tmp;
                const { engine, session } = yield* provisionIn(project);
                yield* engine.launch(session.id, ["codex"]);
                const agent = [...world.processes.values()].find(
                  (process) => process.sessionId === session.id && process.kind === "agent-pty",
                );
                if (agent === undefined) throw new Error("launch recorded no agent process");
                const request = created[0];
                if (request === undefined) throw new Error("cold launch made no create request");
                const epoch = memory.leases.get(session.worktreeId)?.epoch;
                if (epoch === undefined) throw new Error("cold launch claimed no capture lease");
                earlierFinal = shipCapturedHarnessHome(
                  tmp,
                  memory,
                  session.worktreeId,
                  epoch,
                  request,
                  relocation.executorRoot,
                ).pipe(Effect.asVoid, Effect.orDie);

                // A manual checkpoint can leave a final capture while the agent is still running.
                // The later process-end flush fails, so this same-epoch head proves no settle barrier.
                yield* engine.checkpointNow(session.id, "user-mark");
                const earlierHeadId = memory.chains.get(session.worktreeId)?.headCapture;
                const earlierHead = memory.captures.get(earlierHeadId ?? "");
                expect(earlierHead?.kind).toBe("final");
                expect(earlierHead?.epoch).toBe(memory.chains.get(session.worktreeId)?.headEpoch);

                // Capture mode must not fall back to the co-located harness home on restart.
                const hostTranscript = path.join(
                  harnessHomePathOf(project.storePath, session.id),
                  ".codex",
                  "sessions",
                  "2026",
                  "09",
                  "15",
                  "rollout-2026-09-15T10-00-00-11111111-2222-3333-4444-555555555555.jsonl",
                );
                fs.mkdirSync(path.dirname(hostTranscript), { recursive: true });
                fs.writeFileSync(hostTranscript, "{}\n");

                yield* engine.stop(session.id);
                // Nothing answers the drain's flushes: the stall window (1 s) runs out, the session
                // reads `not saved`, and the workspace — the only copy of what it has not shipped —
                // stays.
                yield* TestClock.adjust(Duration.millis(999));
                expect(world.sessions.get(session.id)?.captureNotSavedAt).toBeNull();
                yield* TestClock.adjust(Duration.millis(1));
                yield* clock.untilChanged(
                  () => world.sessions.get(session.id)?.captureNotSavedAt !== null,
                  "the drain keeps the workspace",
                );
                expect(stopped).not.toContain("workspace-1");
                expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");

                expect(memory.chains.get(session.worktreeId)?.headCapture).toBe(earlierHeadId);
                expect(world.sessions.get(session.id)?.hasTranscript).toBeNull();
                expect(fs.existsSync(hostTranscript)).toBe(true);
                expect(
                  fs.existsSync(
                    path.join(
                      processStatePathOf(project.storePath, session.id, agent.id),
                      "manifest.json",
                    ),
                  ),
                ).toBe(false);
              }),
            {
              fixture,
              captured: memory,
              wrapCaptureChannel: clock.wrapCaptureChannel,
              drainPolicy: { stallSeconds: 1 },
              sealantLayer: sealantLaunchLayer(
                created,
                undefined,
                stopped,
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
                  beforeCreate: (options) =>
                    Effect.gen(function* () {
                      relocation.executorRoot = path.join(testRoot, "same-epoch-final-executor");
                      relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                      fs.mkdirSync(relocation.executorRoot, { recursive: true });
                      const source = options.source;
                      if (source?.kind !== "capture" || source.worktreeId === undefined) {
                        throw new Error("test executor requires a cold capture source");
                      }
                      yield* restoreConfiguredHarnessHome(
                        testRoot,
                        memory,
                        WorktreeId.make(source.worktreeId),
                        options,
                        relocation.executorRoot,
                      );
                    }),
                  flush: () => {
                    flushes += 1;
                    if (flushes === 1) {
                      return earlierFinal.pipe(
                        Effect.as(captureAnswer({ epoch: 2, registered: 1 })),
                      );
                    }
                    return Effect.fail(
                      new SealantPlatformError({
                        code: "capture_flush_failed",
                        status: null,
                        message: "capture flush failed in restart regression",
                        cause: null,
                      }),
                    );
                  },
                },
              ),
            },
          );

          yield* withEngineEffect(
            (world) =>
              Effect.gen(function* () {
                yield* SessionEngine;
                const session = [...world.sessions.values()].find(
                  (candidate) => candidate.harness === "codex",
                );
                const agent = [...world.processes.values()].find(
                  (candidate) =>
                    candidate.sessionId === session?.id && candidate.kind === "agent-pty",
                );
                expect(session?.hasTranscript).toBeNull();
                expect(
                  session !== undefined && agent !== undefined
                    ? fs.existsSync(
                        path.join(
                          processStatePathOf(
                            world.projects.get(session.projectId)?.storePath ?? "",
                            session.id,
                            agent.id,
                          ),
                          "manifest.json",
                        ),
                      )
                    : true,
                ).toBe(false);
              }),
            { fixture, captured: memory },
          );
        } finally {
          fs.rmSync(fixture.tmp, { recursive: true, force: true });
        }
      }),
    { timeout: 20_000 },
  );

  it("refuses a legacy rootless capture head before opening an agent and preserves HOME state", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const memory = makeMemoryCaptureStore();
    const relocation = { homePath: "", executorRoot: "" };
    let testRoot = "";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          testRoot = tmp;
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* replaceHeadWithRootlessWorkspace(tmp, memory, session.worktreeId);
          const immutableHead = memory.chains.get(session.worktreeId)?.headCapture;

          const error = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);

          expect(error._tag).toBe("SealantPlatformError");
          expect(error._tag === "SealantPlatformError" && error.code).toBe(
            "harness_home_relocation_failed",
          );
          expect(created).toHaveLength(1);
          expect(spawned).toEqual([]);
          expect(memory.chains.get(session.worktreeId)?.headCapture).toBe(immutableHead);
          expect(
            fs.readFileSync(path.join(relocation.homePath, ".codex", "session.jsonl"), "utf8"),
          ).toBe("legacy source survives\n");
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
            beforeCreate: (options) =>
              Effect.gen(function* () {
                relocation.executorRoot = path.join(testRoot, "legacy-rootless-executor");
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
                fs.mkdirSync(path.join(relocation.homePath, ".codex"), { recursive: true });
                fs.writeFileSync(
                  path.join(relocation.homePath, ".codex", "session.jsonl"),
                  "legacy source survives\n",
                );
              }),
          },
        ),
      },
    );
  });

  it.effect(
    "refuses a retained rootless executor before opening a resumed agent and preserves HOME state",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const flushed: string[] = [];
        const clock = yield* makeLaunchClock;
        const memory = makeMemoryCaptureStore();
        const relocation = { homePath: "", executorRoot: "" };
        let testRoot = "";
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.openShell(session.id);
              const agent = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty" && process.exitedAt === null,
              );
              if (agent === undefined) throw new Error("launch recorded no agent");
              yield* engine.stop(session.id);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.status === "idle",
                "the retained shell to hold the workspace",
              );
              const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
              fs.mkdirSync(stateDir, { recursive: true });
              fs.writeFileSync(
                path.join(stateDir, "manifest.json"),
                JSON.stringify({
                  harness: "codex",
                  providerSessionId: "11111111-2222-3333-4444-555555555555",
                  capturedAt: now().toISOString(),
                }),
              );
              const createRequest = created[0];
              if (createRequest === undefined)
                throw new Error("cold launch made no create request");
              const selectedRoot = configuredHarnessHomePath(
                createRequest,
                relocation.executorRoot,
              );
              fs.rmSync(path.join(relocation.homePath, ".codex"), { force: true });
              fs.rmSync(selectedRoot, { recursive: true, force: true });
              fs.mkdirSync(path.join(relocation.homePath, ".codex"), { recursive: true });
              fs.writeFileSync(
                path.join(relocation.homePath, ".codex", "session.jsonl"),
                "retained source survives\n",
              );

              const error = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);

              expect(error._tag).toBe("SealantPlatformError");
              expect(error._tag === "SealantPlatformError" && error.code).toBe(
                "harness_home_relocation_failed",
              );
              expect(created).toHaveLength(1);
              expect(spawned).toHaveLength(2);
              expect(
                fs.readFileSync(path.join(relocation.homePath, ".codex", "session.jsonl"), "utf8"),
              ).toBe("retained source survives\n");
              expect(flushed.length).toBeGreaterThan(0);
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            wrapCaptureChannel: clock.wrapCaptureChannel,
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
                flushed,
                relocation,
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(testRoot, "retained-rootless-executor");
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
  );

  it("launch attaches a worktree that has no chain yet — made before captures — with capture 0 from its directory's current files", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          // A legacy worktree: the deprecated co-located store made its directory and row;
          // nothing registered a chain for it. It carries an edit nobody committed.
          const worktreeId = WorktreeId.make(`wt-${crypto.randomUUID().slice(0, 8)}`);
          const branch = `mend/wt/${worktreeId}`;
          const dir = path.join(path.dirname(project.storePath), "worktrees", worktreeId);
          const base = project.adoptedSha;
          if (base === null) throw new Error("the fixture project has an adopted sha");
          execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, base], {
            cwd: project.storePath,
          });
          fs.writeFileSync(path.join(dir, "draft.txt"), "still editing\n");
          const worktreesRepo = yield* WorktreesRepo;
          const worktree = yield* worktreesRepo.create({
            id: worktreeId,
            projectId: project.id,
            name: worktreeId,
            directory: worktreeId,
            branch,
            baseSha: base,
            baseRef: "main",
          });
          const engine = yield* SessionEngine;
          const session = yield* engine.provisionSessionIn(worktree.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(memory.chains.get(worktreeId)?.headCapture ?? null).toBeNull();

          yield* engine.launch(session.id, ["codex"]);

          // Capture 0 was registered at launch from the directory, and the launch claimed it.
          const chain = memory.chains.get(worktreeId);
          expect(chain?.headN).toBe(0);
          const cap0 = memory.captures.get(chain?.headCapture ?? "");
          expect(cap0?.kind).toBe("checkpoint");
          const manifest = JSON.parse(
            fs.readFileSync(path.join(tmp, "blobs", cap0?.manifestKey ?? ""), "utf8"),
          );
          expect(manifest.checkpoint.sha).not.toBe(base);
          const tree = execFileSync(
            "git",
            ["ls-tree", "--name-only", `${manifest.checkpoint.sha}^{tree}`],
            { cwd: project.storePath },
          ).toString("utf8");
          expect(tree).toContain("draft.txt");
          expect(created).toHaveLength(1);
          expect(memory.leases.get(worktreeId)?.executorId).toBe(session.id);
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created) },
    );
  });
});
