import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreesRepo, AgentMemoryRepo, type AgentMemoryHomes } from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  SecretFileId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  Project,
  RepositoryCloneUrl,
  Session,
  SessionProcess,
  SecretFile,
} from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import {
  CaptureGitVerifier,
  type GitVerification,
  planBlockedWords,
  planWaitingWords,
  HARNESS_HOME_MOUNT_PATH,
  SessionEngine,
  WORKSPACE_MEND_TOML,
  secretFilesRecordExec,
} from "@mend/sessions";
import {
  BlobStoreFsLive,
  captureKeys,
  type ExecutorTransport,
  decodeManifest,
  harnessHomePathOf,
  listCaptureFiles,
  materialize,
  processStatePathOf,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { OPENCODE_CAPTURED_SEED } from "../src/harness-seeds.ts";
import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import {
  configuredHarnessHomePath,
  headFlush,
  headReport,
  lifecycleLayer,
  memoryHotPool,
  shipCapturedHarnessHome,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import {
  agentMemoryLayerOf,
  captureAnswer,
  drawnLine,
  isPickupExec,
  makeWorld,
  now,
  recordingProtocolHostLayer,
  redeemPickupExec,
  sealantLaunchLayer,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  setupSibling,
  withEngine,
} from "./engine/fixture.ts";
import { writeOpencodeDatabase } from "./opencode-db.ts";

/**
 * What an executor ships in these worlds: a capture whose workspace class carries the codex
 * rollout under `harness/`, registered under the epoch Mend claimed at launch. Packs and
 * manifests follow ADR-0015's rules through the same writer the store tests prove.
 */
/** A capture's place on its chain, as a test's fake git verifier keys its answers. */
const keyOf = (manifest: { readonly n: number }) => `n=${manifest.n}`;

/** Apply the head manifest's virtual `workspace/harness` entry to the selected daemon root. */
const restoreConfiguredHarnessHome = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  options: CreateOptions,
  executorRoot: string,
) =>
  Effect.gen(function* () {
    const headId = memory.chains.get(worktreeId)?.headCapture ?? null;
    const head = headId === null ? null : (memory.captures.get(headId) ?? null);
    if (head === null) throw new Error("capture source has no head to materialize");
    const manifest = yield* decodeManifest(
      head.manifestKey,
      new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", head.manifestKey))),
    ).pipe(Effect.orDie);
    const workspace = path.join(executorRoot, "materialized-workspace");
    fs.rmSync(workspace, { recursive: true, force: true });
    yield* materialize(manifest, "workspace", workspace).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
      Effect.orDie,
    );
    const virtualHarness = path.join(workspace, "harness");
    if (!fs.existsSync(virtualHarness)) return;
    const harnessHome = configuredHarnessHomePath(options, executorRoot);
    fs.mkdirSync(path.dirname(harnessHome), { recursive: true });
    fs.renameSync(virtualHarness, harnessHome);
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

const verifyDeferredFinalHarvest = async (pathKind: "stop" | "handoff" | "sweep") => {
  const created: Array<CreateOptions> = [];
  const spawned: ReadonlyArray<string>[] = [];
  const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
  const memory = makeMemoryCaptureStore();
  // What the agent learned, read back from the final capture (docs/adr/0009).
  const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
  const flushStarted = await Effect.runPromise(Deferred.make<void>());
  const releaseFlush = await Effect.runPromise(Deferred.make<void>());
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
        // The flush that ships the final capture: the handoff's own, or the drain's final, which
        // is a stop's first and only flush (decision 50).
        const flushThatShips = 1;

        if (pathKind === "handoff") {
          const handoff = yield* engine
            .handoff(
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
          yield* Fiber.join(handoff);
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
        yield* until(
          () => world.sessions.get(session.id)?.hasTranscript === true,
          `${pathKind} final capture harvest`,
        );
        const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
        expect(fs.readFileSync(path.join(stateDir, "transcript.native"), "utf8")).toContain(
          `${pathKind} final answer`,
        );
        if (pathKind !== "handoff") {
          yield* until(() => readBacks.length > 0, `${pathKind} agent memory read back`);
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
};

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

  it(
    "relocates HOME into the configured capture root before launch, harvests the final flush, and restores it before pickup",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      const flushStarted = await Effect.runPromise(Deferred.make<void>());
      const releaseFlush = await Effect.runPromise(Deferred.make<void>());
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

            // The stop's one flush is the drain's final (decision 50); the harvest waits for its
            // registration before it reads the head.
            yield* Deferred.await(flushStarted);
            expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(true);
            yield* Deferred.succeed(releaseFlush, undefined);
            yield* until(
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
            yield* until(
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
    },
  );

  /**
   * An opencode session in capture mode: its harness home rides the worktree's captures, so the
   * database the harvest reads may hold other sessions' conversations too, and what is its own is
   * what the database did not hold when it launched (the launch snapshot). `own` starts a
   * conversation; `none` leaves an empty database; `unattributed` starts one with no launch
   * snapshot kept, so Mend cannot tell it is the session's; `unprompted` starts none beside one
   * its launch snapshot already held, a provable absence.
   */
  const verifyOpencodeHarvest =
    (kind: "own" | "none" | "unattributed" | "unprompted") => async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      const relocation = { homePath: "", executorRoot: "", observed: [] as string[] };
      let testRoot = "";
      let finalCapture: Effect.Effect<void> = Effect.die("final capture not prepared");
      let shipped = false;
      let opens = 0;
      const databaseOf = () =>
        path.join(relocation.homePath, ".local", "share", "opencode", "opencode.db");

      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            testRoot = tmp;
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "opencode",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(session.id, ["opencode"]);
            const request = created[0];
            if (request === undefined) throw new Error("cold launch made no create request");
            const executorRoot = relocation.executorRoot;
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            finalCapture = shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            ).pipe(Effect.asVoid, Effect.orDie);

            const agent = [...world.processes.values()].find(
              (process) => process.kind === "agent-pty" && process.exitedAt === null,
            );
            if (agent?.sealantSessionId === null || agent?.sealantSessionId === undefined) {
              throw new Error("the launch recorded no agent PTY");
            }
            const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
            if (kind === "unattributed") fs.rmSync(path.join(stateDir, "opencode-launch.json"));
            if (kind === "unprompted") {
              fs.writeFileSync(
                path.join(stateDir, "opencode-launch.json"),
                JSON.stringify(["ses_own"]),
              );
            }
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            if (kind === "unattributed") {
              // A conversation Mend cannot tell is the session's is no answer, not an absence: the
              // session is never hidden as a dead end, and its resume is refused, not guessed.
              yield* until(
                () => world.sessions.get(session.id)?.settledAt !== null,
                "the first process settle",
              );
              yield* Effect.sleep("1 second");
              expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(false);
              expect(fs.existsSync(path.join(stateDir, "manifest.json"))).toBe(false);
              const refusal = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
              expect(String(refusal.message)).toContain(
                "opencode left no conversation Mend can tell is session",
              );
              expect(opens).toBe(1);
              // A shell opens no conversation: the same session resumes as a shell.
              const shell = yield* engine.resumeSession(session.id, "shell");
              expect(shell.status).toBe("running");
              const shellProcess = [...world.processes.values()].findLast(
                (process) => process.exitedAt === null && process.harness === "shell",
              );
              expect(shellProcess).toBeDefined();
              return;
            }
            if (kind === "none" || kind === "unprompted") {
              // Nothing in the database is this session's: no saved state, and the resume says so
              // rather than open the other session's conversation.
              yield* until(
                () => world.sessions.get(session.id)?.hasTranscript === false,
                "the final capture harvest",
              );
              expect(fs.existsSync(path.join(stateDir, "manifest.json"))).toBe(false);
              yield* until(
                () => world.sessions.get(session.id)?.settledAt !== null,
                "the first process settle",
              );
              const refusal = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
              expect(String(refusal.message)).toContain(
                "opencode left no conversation Mend can tell is session",
              );
              expect(opens).toBe(1);
              return;
            }
            // No transcript file, but a conversation of its own: the session is not a dead end.
            yield* until(
              () => world.sessions.get(session.id)?.hasTranscript === true,
              "the final capture harvest",
            );
            expect(
              JSON.parse(fs.readFileSync(path.join(stateDir, "manifest.json"), "utf8")),
            ).toEqual(
              expect.objectContaining({ harness: "opencode", providerSessionId: "ses_own" }),
            );
            expect(fs.existsSync(path.join(stateDir, "transcript.native"))).toBe(false);
            expect(world.sessions.get(session.id)?.providerSessionId).toBe("ses_own");

            yield* until(
              () => world.sessions.get(session.id)?.settledAt !== null,
              "the first process settle",
            );
            const resumed = yield* engine.resumeSession(session.id, null);
            expect(resumed.status).toBe("running");
            const resumedAgent = [...world.processes.values()].findLast(
              (process) => process.kind === "agent-pty" && process.exitedAt === null,
            );
            expect(resumedAgent?.argv).toEqual(["opencode", "--session", "ses_own"]);
            // Both capture launches run behind the seed that keeps MCP logins out of saved state:
            // decided by Mend, not by an environment sealantd never passes on.
            expect(spawned.length).toBe(2);
            for (const argv of spawned)
              expect(argv.slice(0, 3)).toEqual(["sh", "-c", OPENCODE_CAPTURED_SEED]);
            expect(resumedAgent?.providerSessionId).toBe("ses_own");
            expect(opens).toBe(2);
            // Both launches kept what the database held as they started: nothing the first time, the
            // first process's conversation (read from the head capture) the second.
            const kept = (processId: string) =>
              JSON.parse(
                fs.readFileSync(
                  path.join(
                    processStatePathOf(project.storePath, session.id, processId),
                    "opencode-launch.json",
                  ),
                  "utf8",
                ),
              );
            expect(kept(agent.id)).toEqual([]);
            if (resumedAgent === undefined) throw new Error("no resumed agent");
            expect(kept(resumedAgent.id)).toEqual(["ses_own"]);
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
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              relocation,
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
                }),
              beforeOpen: () => {
                opens += 1;
                if (opens === 1) {
                  writeOpencodeDatabase(
                    databaseOf(),
                    kind === "none" ? [] : [{ id: "ses_own", createdAt: Date.now() }],
                  );
                  return;
                }
                // The pickup opens on the materialised database.
                expect(fs.existsSync(databaseOf())).toBe(true);
              },
              flush: () =>
                Effect.gen(function* () {
                  if (!shipped) {
                    yield* finalCapture;
                    shipped = true;
                  }
                  return {
                    epoch: 2,
                    worktreeId: "",
                    pending: 0,
                    stagedBytes: 0,
                    uploadedObjects: 1,
                    uploadedBytes: 1,
                    registered: 1,
                    fenced: false,
                    paused: false,
                    refused: [],
                  } satisfies WorkspaceCaptureStatus;
                }),
            },
          ),
        },
      );
    };

  it(
    "commits the opencode conversation this session started, and a pickup opens it by id, not the newest one",
    { timeout: 20_000 },
    verifyOpencodeHarvest("own"),
  );

  it(
    "refuses to resume an opencode session none of whose conversations it can tell is its own",
    { timeout: 20_000 },
    verifyOpencodeHarvest("none"),
  );

  it(
    "leaves an opencode session whose conversation Mend cannot attribute unclassified, never a dead end",
    { timeout: 20_000 },
    verifyOpencodeHarvest("unattributed"),
  );

  it(
    "reads an opencode session that started no conversation as having none, when its snapshot proves it",
    { timeout: 20_000 },
    verifyOpencodeHarvest("unprompted"),
  );

  it(
    "waits for a deferred final registration before stop trigger=null harvest reads the head",
    { timeout: 20_000 },
    () => verifyDeferredFinalHarvest("stop"),
  );

  it(
    "waits for a deferred final registration before handoff harvest reads the head",
    { timeout: 20_000 },
    () => verifyDeferredFinalHarvest("handoff"),
  );

  it(
    "waits for a deferred final registration before leftover sweep harvest reads the head",
    { timeout: 20_000 },
    () => verifyDeferredFinalHarvest("sweep"),
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

  it("provisions capture 0 and launches a capture-sourced workspace: no mounts, no bind, a launch-claimed lease; a user stop flushes the executor before its workspace goes", async () => {
    const created: Array<CreateOptions> = [];
    const binds: string[] = [];
    /** Flushes and stops in the order the platform saw them. */
    const events: string[] = [];
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
            (pack) => pack.worktreeId === session.worktreeId && pack.key.startsWith("projects/"),
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
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
          expect(events).toEqual(["flush:workspace-1", "workspace-1"]);
          expect(world.sessions.get(session.id)?.hasTranscript).toBe(false);
        }),
      {
        captured: memory,
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
  });

  it("adds a repository of another project to a live session: a worktree of that project, a nested clone of its origin linked at /workspace/repos/<name>, and the refusals in the person's words (docs/adr/0010)", async () => {
    const created: Array<CreateOptions> = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const core = yield* setupSibling(tmp, world, "core", project.originUrl ?? "");
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

          yield* until(
            () =>
              execCalls.some((argv) => argv.join("\n").includes("git clone --quiet --no-checkout")),
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

          // The row settles once the clone answered; the stand-in executor answers at once.
          let listed = yield* engine.listRepositories(session.id);
          for (let i = 0; i < 500 && listed[0]?.state === "adding"; i++) {
            yield* Effect.sleep(Duration.millis(10));
            listed = yield* engine.listRepositories(session.id);
          }
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
      },
    );
  });

  it("clones an origin adopted with a token in it without the token: never in the clone's argv, its log line, nor what `mend repo projects` prints (review of mend#555, P2-2, N-1)", async () => {
    const created: Array<CreateOptions> = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const logs: Array<string> = [];
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const sibling = yield* setupSibling(tmp, world, "core", project.originUrl ?? "");
          world.projects.set(
            sibling.id,
            new Project({ ...sibling, originUrl: `https://${token}@github.com/acme/core.git` }),
          );
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
          yield* engine.addRepository(session.id, { project: "core", name: null, worktree: null });
          yield* until(
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
  });

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

  it("keeps transcript classification unknown when the capture head cannot be read", async () => {
    const created: Array<CreateOptions> = [];
    const stopped: string[] = [];
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

          // Model a damaged/unavailable chain read after launch. It must not become the factual
          // claim that no transcript existed.
          memory.chains.delete(session.worktreeId);
          yield* engine.stop(session.id);
          yield* until(() => stopped.includes("workspace-1"), "the post-harvest workspace stop");
          expect(world.sessions.get(session.id)?.hasTranscript).toBeNull();
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it.each([
    { storage: "missing head", expected: null },
    { storage: "missing manifest", expected: null },
    { storage: "pending workspace", expected: null },
    { storage: "stale final from a prior epoch", expected: null },
    { storage: "final capture without transcript", expected: null },
    { storage: "final capture with transcript", expected: true },
  ])(
    "classifies a transcript at restart when capture storage is $storage",
    async ({ storage, expected }) => {
      const memory = makeMemoryCaptureStore();
      const sessionId = SessionId.make("settled-capture-storage-unavailable");
      const worktreeId = WorktreeId.make("wt-capture-storage-unavailable");
      await withEngine(
        (world) =>
          Effect.gen(function* () {
            yield* SessionEngine;
            // The classification runs forked, after the boot: a reading is waited for; an absent
            // one is given the same time to land before it is read as absent.
            if (expected === null) yield* Effect.sleep(Duration.millis(200));
            else {
              yield* until(
                () => world.sessions.get(sessionId)?.hasTranscript === expected,
                "the restart transcript classification",
              );
            }
            expect(world.sessions.get(sessionId)?.hasTranscript).toBe(expected);
          }),
        {
          captured: memory,
          prepareWorld: (world, tmp) => {
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
            const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, 1), { chunkSize: 64 });
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
      );
    },
  );

  it(
    "keeps a failed final flush unknown after restart with an earlier same-epoch final capture",
    { timeout: 20_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-restart-test-")),
      };
      const memory = makeMemoryCaptureStore();
      const created: Array<CreateOptions> = [];
      const stopped: string[] = [];
      const relocation = { homePath: "", executorRoot: "" };
      let testRoot = "";
      let earlierFinal: Effect.Effect<void> = Effect.die("earlier final capture not prepared");
      let flushes = 0;
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              testRoot = tmp;
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
              // Nothing answers the drain's flushes: the stall window runs out, the session reads
              // `not saved`, and the workspace — the only copy of what it has not shipped — stays.
              yield* until(
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
                    return earlierFinal.pipe(Effect.as(captureAnswer({ epoch: 2, registered: 1 })));
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

        await withEngine(
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
    },
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

  it("refuses a retained rootless executor before opening a resumed agent and preserves HOME state", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const flushed: string[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty" && process.exitedAt === null,
          );
          if (agent === undefined) throw new Error("launch recorded no agent");
          yield* engine.stop(session.id);
          yield* until(
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
          if (createRequest === undefined) throw new Error("cold launch made no create request");
          const selectedRoot = configuredHarnessHomePath(createRequest, relocation.executorRoot);
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
  });

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

  it(
    "a second session in a leased worktree joins the holder's executor; an unreachable holder is refused with worktree_leased",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      let holderDead = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const first = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
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

            // The holder's executor stops answering while its lease is still live: refused.
            holderDead = true;
            const third = yield* engine.provisionSessionIn(first.worktreeId, {
              harness: "codex",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(third.id, ["codex"]).pipe(Effect.flip);
            expect(refused._tag).toBe("SealantPlatformError");
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
            expect(refused._tag === "SealantPlatformError" && refused.status).toBe(409);
            expect(world.sessions.get(third.id)?.status).toBe("failed");
            expect(created).toHaveLength(1);
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            () => holderDead,
          ),
        },
      );
    },
  );

  it(
    "a joined session's later conversation runs in the holder's executor, on the holder's login",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const launchLogins: Array<string | null> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const first = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
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
            yield* engine.stop(second.id);
            yield* converse();
            expect(attached.at(-1)?.process.sealantWorkspaceId).toBe("workspace-1");
            expect(launchLogins.at(-1)).toBeNull();
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(created),
          protocolHostLayer: recordingProtocolHostLayer(attached, [], [], [], launchLogins),
        },
      );
    },
  );

  it(
    "a joined session's later runs in the holder's executor write none of its owner's secret files there, and its session line says so (docs/adr/0010 decision 3)",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
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
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const first = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
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
            yield* engine.stop(second.id);
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
        },
      );
    },
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
              base: null,
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

  it.each([
    ["no owner record", null, "user-fixture"],
    ["the record names the holder", "user-fixture", "user-fixture"],
    // The home's own record is never consulted: whatever it says, the server decides.
    ["the record forged to name the joiner", "user-maria", "user-fixture"],
  ] as const)(
    "agent memory in a joined executor is read back only for the person whose launch made it, as the server knows it (%s; docs/adr/0009)",
    { timeout: 20_000 },
    async (_label, record, credited) => {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: Array<string> = [];
      const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
      const learned = ".claude/projects/-workspace-repo/memory/learned.md";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
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
            yield* until(
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
            yield* until(
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
    },
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
              base: null,
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

  it(
    "a join waits while the holder's launch hands the worktree's home over (docs/adr/0009)",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const homes = new Map<string, AgentMemoryHomes>();
      const handingOver = await Effect.runPromise(Deferred.make<void>());
      const release = await Effect.runPromise(Deferred.make<void>());
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
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
            yield* Effect.sleep(Duration.millis(150));
            // Nothing started while the home still held Maria's memory.
            expect(spawned).toEqual([]);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(launching);
            yield* Fiber.join(joining);
            expect(created).toHaveLength(1);
            expect(world.sessions.get(joined.id)?.sealantWorkspaceId).toBe("workspace-1");
            expect(spawned).toHaveLength(2);
          }),
        {
          captured: memory,
          drainPolicy: { leaseWait: Duration.seconds(10), leaseWaitInterval: Duration.millis(10) },
          agentMemoryLayer: agentMemoryLayerOf({}, homes),
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
    },
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
              base: null,
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

  it.each([
    ["the hand-over finishes", false],
    ["the first hand-over cannot move the memory aside", true],
  ] as const)(
    "a person who launches in a worktree another person used never takes their memory: it is read back for them first, then moved out of the way (%s; docs/adr/0009)",
    { timeout: 30_000 },
    async (_label, firstHandoverFails) => {
      let handoverFails = firstHandoverFails;
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
      const relocation = { homePath: "", executorRoot: "" };
      const root = ".claude/projects/-workspace-repo/memory";
      let testRoot = "";
      // Anna's own read-back never happens: her executor ends with her learning unsaved.
      let annaReadBackFails = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            testRoot = tmp;
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const anna = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(anna.id, ["claude"]);
            const first = created[0];
            if (first === undefined) return yield* Effect.die("Anna's launch made no executor");
            const annaHome = configuredHarnessHomePath(first, relocation.executorRoot);
            fs.mkdirSync(path.join(annaHome, root), { recursive: true });
            fs.writeFileSync(path.join(annaHome, root, "MEMORY.md"), "- [feedback](feedback.md)\n");
            fs.writeFileSync(path.join(annaHome, root, "feedback.md"), "Anna prefers small PRs\n");
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              anna.worktreeId,
              memory.leases.get(anna.worktreeId)?.epoch ?? 0,
              first,
              relocation.executorRoot,
            );
            yield* engine.stop(anna.id);
            yield* until(
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
              fs.readFileSync(path.join(keptRoot, keptSets[0] ?? "", root, "feedback.md"), "utf8"),
            ).toBe("Anna prefers small PRs\n");
            expect(fs.readFileSync(path.join(mariaHome, ".mend/agent-memory-owner"), "utf8")).toBe(
              "user-maria",
            );

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
            yield* until(() => readBacks.length > 1, "Maria's read-back");
            expect(readBacks[1]?.userId).toBe("user-maria");
            expect(readBacks[1]?.session.map((file) => file.path)).toEqual([`${root}/maria.md`]);
          }),
        {
          captured: memory,
          agentMemoryLayer: agentMemoryLayerOf({
            readBack: (input) =>
              input.userId === "user-fixture" && annaReadBackFails
                ? Effect.die("the database did not answer")
                : Effect.sync(() => {
                    readBacks.push(input);
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
    },
  );

  it.each([
    ["nothing of it saved", false],
    ["only a capture staged before the move saved", true],
  ] as const)(
    "an executor lost before it saved its hand-over hands nothing over: the next launch hands the restored memory over again (%s; docs/adr/0009)",
    { timeout: 30_000 },
    async (_label, preMoveCapture) => {
      // Maria's executor is lost: no flush of hers answers under her epoch, so nothing places her
      // hand-over (the stand-in still lets her stop go through).
      let mariaLost = false;
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
      const relocation = { homePath: "", executorRoot: "" };
      const root = ".claude/projects/-workspace-repo/memory";
      let testRoot = "";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            testRoot = tmp;
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const anna = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(anna.id, ["claude"]);
            const first = created.at(-1);
            if (first === undefined) return yield* Effect.die("Anna's launch made none");
            const annaHome = configuredHarnessHomePath(first, relocation.executorRoot);
            fs.mkdirSync(path.join(annaHome, root), { recursive: true });
            fs.writeFileSync(path.join(annaHome, root, "feedback.md"), "Anna prefers small PRs\n");
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              anna.worktreeId,
              memory.leases.get(anna.worktreeId)?.epoch ?? 0,
              first,
              relocation.executorRoot,
            );
            yield* engine.stop(anna.id);
            yield* until(() => readBacks.length > 0, "Anna's read-back");
            yield* until(() => world.sessions.get(anna.id)?.settledAt != null, "Anna settles");

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
              if (lostExecutor === undefined) return yield* Effect.die("Maria's launch made none");
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
            yield* until(() => world.sessions.get(lost.id)?.settledAt != null, "Maria settles");
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
          agentMemoryLayer: agentMemoryLayerOf({
            readBack: (input) =>
              Effect.sync(() => {
                readBacks.push(input);
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
                  relocation.executorRoot = path.join(testRoot, `lost-executor-${created.length}`);
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
              base: null,
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
              base: null,
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

  it(
    "a removed session's executor is still its owner's: the next person's launch hands that memory over, never takes it (docs/adr/0009)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
      const relocation = { homePath: "", executorRoot: "" };
      const root = ".claude/projects/-workspace-repo/memory";
      let testRoot = "";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            testRoot = tmp;
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            // Anna used the worktree once; nothing of her memory is in its home.
            const anna = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(anna.id, ["claude"]);
            yield* engine.stop(anna.id);
            yield* until(() => world.sessions.get(anna.id)?.settledAt != null, "Anna settles");

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
            expect(fs.readFileSync(path.join(mariaHome, ".mend/agent-memory-owner"), "utf8")).toBe(
              "user-maria",
            );
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
            yield* until(() => readBacks.length > 0, "Maria's read-back");
            expect(readBacks.map((input) => input.userId)).toEqual(["user-maria"]);
            yield* until(() => world.sessions.get(maria.id)?.settledAt != null, "Maria settles");

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
            yield* until(() => readBacks.length > 1, "Anna's read-back");
            expect(readBacks[1]?.userId).toBe("user-fixture");
            expect(readBacks[1]?.session.map((file) => file.path)).toEqual([`${root}/a.md`]);
          }),
        {
          captured: memory,
          agentMemoryLayer: agentMemoryLayerOf({
            readBack: (input) =>
              Effect.sync(() => {
                readBacks.push(input);
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
    },
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
            base: null,
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
          () => executorDead,
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
            base: null,
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
          () => executorDead,
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
            base: null,
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
          () => executorDead,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        ),
      },
    );
  });

  it("warms a standby executor with no worktree id; its plan is the project base under a placeholder and the standby's epoch, and nothing is leased", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((entry) => entry.status === "ready"), "a standby");
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
          expect((yield* api.planGet({ worktree_id: alias, epoch: 0 })).worktree_id).toBe(alias);
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
        hotWorkspacesLayer: pool.layer,
      },
    );
  });
});
