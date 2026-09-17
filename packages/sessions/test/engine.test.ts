import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentConversationRepo,
  CaptureStoreRepo,
  CheckpointOrdinalTakenError,
  CheckpointsRepo,
  HotWorkspacesRepo,
  ProjectNotFoundError,
  ProjectEnvironmentRepo,
  ProjectMountNotFoundError,
  ProjectClusterBindingsRepo,
  ProjectMountsRepo,
  ProjectLinksRepo,
  OrganizationsRepo,
  FoldersRepo,
  ProjectLinkNotFoundError,
  ProjectSecretsRepo,
  ProjectServiceRecipesRepo,
  ProjectsRepo,
  ReferenceNotFoundError,
  ReferencesRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
  SessionGitOpsRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionRunsRepo,
  SessionsRepo,
  SettingsRepo,
  SkillsRepo,
  UserDotfilesRepo,
  type NewCheckpoint,
  type NewSession,
  type NewSessionProcess,
  type NewSessionRun,
  SessionChannelTokensRepoMemory,
  WorktreeNotFoundError,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  ProjectClusterBindingId,
  ProjectEnvironmentVariableId,
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionGitOpId,
  SkillId,
  SessionId,
  SessionProcessId,
  Sha,
  MendSettings,
  WorktreeId,
  defaultSettings,
  type DotfilesRepository,
} from "@mend/domain";
import {
  AgentTurn,
  Change,
  Checkpoint,
  HotWorkspace,
  Organization,
  Project,
  ProjectClusterBinding,
  ProjectClusterBindingsSnapshot,
  ProjectEnvironmentSnapshot,
  ProjectEnvironmentVariable,
  ProjectSecretsSnapshot,
  RepositoryCloneUrl,
  Service,
  ServiceForward,
  ServiceObservation,
  Session,
  SessionProcess,
  SessionRun,
  Skill,
  SkillWithFiles,
  Worktree,
  type SessionExtraMount,
  type SessionReferenceMount,
} from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  CaptureChannelLive,
  CaptureGitVerifierOff,
  CaptureRuntimeLive,
  CaptureRuntimeOff,
  CaptureUploadPolicyDefault,
  HARNESS_HOME_MOUNT_PATH,
  HarnessStateNotFoundError,
  LegacyBenchReadOnlyError,
  ProtocolHost,
  ServiceHost,
  SessionEngine,
  SessionEngineLive,
  SessionRepositoryCapturedLive,
  SessionRepositoryLocalLive,
  SessionNotLiveError,
  type SessionSocketApi,
  SessionSocketHost,
} from "@mend/sessions";
import {
  AgentBridge,
  BlobStoreFsLive,
  captureKeys,
  DeploymentConfig,
  DotfilesStore,
  type GitSection,
  GitOpsRunnerLive,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
  DeploymentConfigColocated,
  decodeManifest,
  harnessHomePathOf,
  listCaptureFiles,
  materialize,
  processStatePathOf,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import type {
  CreateOptions,
  InteractiveSession,
  InteractiveSessionStatus,
  Run,
  SessionOptions,
  Workspace,
  WorkspaceCaptureReplanned,
  WorkspaceCaptureStatus,
} from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Stream, type Scope } from "effect";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { memoryStoreRefs } from "./capture-world.ts";

/** Every platform method dies — these tests exercise the platform-free paths. */
const sealantDeadLayer = Layer.succeed(SealantClient, {
  createWorkspace: () => Effect.die("not in test"),
  getWorkspace: () => Effect.die("not in test"),
  // Some lifecycle tests only need supervision to remain attached while they inspect the index.
  getRun: () => Effect.never,
  recordCommands: () => Effect.die("not in test"),
  recordScrollback: () => Effect.die("not in test"),
  runHarness: () => Effect.die("not in test"),
  startHarness: () => Effect.die("not in test"),
  startHarnessInWorkspace: () => Effect.die("not in test"),
  waitRun: () => Effect.die("not in test"),
  openSession: () => Effect.die("not in test"),
  forward: () => Effect.die("not in test"),
  stopWorkspace: () => Effect.die("not in test"),
  captureFlush: () => Effect.die("not in test"),
  captureReplan: () => Effect.die("not in test"),
  expireWorkspace: () => Effect.die("not in test"),
  getSession: () => Effect.die("not in test"),
  sessionOutput: () => Effect.die("not in test"),
  exec: () => Effect.die("not in test"),
  bindWorkspace: () => Effect.succeed([]),
  diffCommits: () => Effect.die("not in test"),
  inferenceRespond: () => Effect.die("not in test"),
  recordStream: () => Stream.fromEffect(Effect.die("not in test")),
  recordTimeline: () => Stream.fromEffect(Effect.die("not in test")),
  runChanges: () => Effect.die("not in test"),
  connectionCheck: () => Effect.die("not in test"),
  resolveWorkspacePackage: () => Effect.die("not in test"),
});

/** No pool in these worlds — claims miss and the boot sweep sees nothing. */
const hotWorkspacesEmptyLayer = Layer.succeed(HotWorkspacesRepo, {
  create: () => Effect.die("not in test"),
  byId: () => Effect.succeed(null),
  listForProject: () => Effect.succeed([]),
  listAll: () => Effect.succeed([]),
  setReady: () => Effect.void,
  setBaseSha: () => Effect.void,
  setFailed: () => Effect.void,
  claim: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const settingsLayer = (workspaceImage = defaultSettings.workspaceImage) =>
  Layer.succeed(SettingsRepo, {
    get: () => Effect.succeed(new MendSettings({ ...defaultSettings, workspaceImage })),
    modify: () => Effect.die("not in test"),
  });

/** The evidence side of a recorded exec — inert, only there to satisfy the SDK shape. */
const fakeExecRun: Run = {
  id: "run-exec",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: async () => "" },
  artifacts: { list: async () => [], get: async () => new Uint8Array() },
  record: {
    runId: "run-exec",
    replay: async () => {
      throw new Error("not in test");
    },
    commands: async () => [],
    transcript: async () => "",
    stream: async function* () {},
    timeline: async function* () {},
    scrollback: async function* () {},
    loss: async () => {
      throw new Error("not in test");
    },
    summary: async () => {
      throw new Error("not in test");
    },
    fileTreeAt: async () => {
      throw new Error("not in test");
    },
    processTreeAt: async () => {
      throw new Error("not in test");
    },
  },
  wait: async function () {
    return this;
  },
};

const sealantLaunchLayer = (
  created: Array<CreateOptions>,
  rejectCredentials: (credentials: CreateOptions["credentials"]) => boolean = () => false,
  stopped?: string[],
  spawned?: ReadonlyArray<string>[],
  rejectWorkspaceLookup: () => boolean = () => false,
  renewWorkspace: (
    workspaceId: string,
    ttlSeconds: number,
  ) => Effect.Effect<Date | null, SealantPlatformError> = () =>
    Effect.succeed(new Date("2030-01-01T00:00:00.000Z")),
  /** Per-PTY observed state a test flips to simulate an exit the watcher must notice. */
  ptyStates?: Map<string, InteractiveSessionStatus>,
  openedOptions?: SessionOptions[],
  createWorkspaceOverride?: (
    options: CreateOptions,
  ) => Effect.Effect<Workspace, SealantPlatformError>,
  /** When provided, workspace execs succeed (exit 0, empty output) and land here. */
  execCalls?: ReadonlyArray<string>[],
  /** Every `bindWorkspace` subpath, so a test can assert capture mode binds nothing. */
  binds?: string[],
  /**
   * Capture mode (SDK 0.31.0): `flushed` collects `flush:<workspace id>` for every flush Mend asked
   * for before a planned stop or a checkpoint (the report is inert) — the same array as `stopped`
   * proves the order; `replan` stands in for sealantd's `capture.replan` when a claimed standby is
   * launched.
   */
  captureOps?: {
    readonly flushed?: string[];
    /** Map the capture root into a temporary directory and execute the engine's real shell script. */
    readonly relocation?: {
      homePath: string;
      executorRoot: string;
      readonly observed?: string[];
    };
    /** A faithful workspace hook: Core has created the executor but no process has started yet. */
    readonly beforeCreate?: (options: CreateOptions) => Effect.Effect<void>;
    /** A faithful process hook: the harness writes through HOME after relocation. */
    readonly beforeOpen?: (argv: ReadonlyArray<string>) => void;
    /** Stands in for the executor's flush itself — what it ships and registers before answering. */
    readonly flush?: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceCaptureStatus, SealantPlatformError>;
    readonly replan?: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceCaptureReplanned, SealantPlatformError>;
  },
) => {
  let nextPty = 0;
  const ptys = new Map<string, InteractiveSession>();
  const openPty = (mode: "pty" | "pipe" = "pty"): InteractiveSession => {
    nextPty += 1;
    const pty: InteractiveSession = {
      id: `pty-${nextPty}`,
      workspaceId: "workspace-1",
      runId: `run-${nextPty}`,
      mode,
      send: async () => undefined,
      output: async function* () {},
      resize: async () => undefined,
      signal: async () => undefined,
      status: async () => ptyStates?.get(pty.id) ?? { status: "running", outputHighWater: 0n },
      close: async () => undefined,
      attach: async () => new Promise(() => undefined),
    };
    ptys.set(pty.id, pty);
    return pty;
  };
  const initialPty = openPty();
  const workspace: Workspace = {
    id: "workspace-1",
    name: "test workspace",
    status: async () => "ready",
    ready: async function () {
      return this;
    },
    harness: {
      run: async () => new Promise(() => undefined),
      start: async () => new Promise(() => undefined),
      session: async () => initialPty,
    },
    exec: async () => new Promise(() => undefined),
    bind: async () => [],
    capture: {
      flush: async () => {
        throw new Error("not in test");
      },
      replan: async () => {
        throw new Error("not in test");
      },
    },
    sessions: {
      open: async (_argv, options) => {
        if (options !== undefined) openedOptions?.push(options);
        return openPty(options?.mode ?? "pty");
      },
      get: async (id) => ptys.get(id) ?? initialPty,
      list: async () => [...ptys.values()],
    },
    events: async function* () {},
    forward: async () => {
      throw new Error("not in test");
    },
    stop: async () => undefined,
    restart: async function () {
      return this;
    },
    expire: async () => undefined,
  };
  return Layer.succeed(SealantClient, {
    createWorkspace: (options) =>
      Effect.suspend(() => {
        created.push(options);
        const beforeCreate = captureOps?.beforeCreate?.(options) ?? Effect.void;
        return beforeCreate.pipe(
          Effect.andThen(
            createWorkspaceOverride === undefined
              ? rejectCredentials(options.credentials)
                ? Effect.fail(
                    new SealantPlatformError({
                      code: "connected-account-not-found",
                      status: 400,
                      message: "connected account was not found",
                      cause: null,
                    }),
                  )
                : Effect.succeed(workspace)
              : createWorkspaceOverride(options),
          ),
        );
      }),
    bindWorkspace: (_workspace, options) =>
      Effect.sync(() => {
        binds?.push(options.subpath);
        return [];
      }),
    getWorkspace: () =>
      rejectWorkspaceLookup()
        ? Effect.fail(
            new SealantPlatformError({
              code: "workspace_lookup_failed",
              status: null,
              message: "workspace lookup failed",
              cause: null,
            }),
          )
        : Effect.succeed(workspace),
    getRun: () => Effect.never,
    sessionOutput: () => Effect.die("not in test"),
    recordCommands: () => Effect.die("not in test"),
    recordScrollback: () => Effect.die("not in test"),
    runHarness: () => Effect.die("not in test"),
    startHarness: () => Effect.die("not in test"),
    startHarnessInWorkspace: () => Effect.die("not in test"),
    waitRun: () => Effect.die("not in test"),
    openSession: (_workspace, argv, options) =>
      Effect.sync(() => {
        captureOps?.beforeOpen?.(argv);
        spawned?.push(argv);
        if (options !== undefined) openedOptions?.push(options);
        return openPty(options?.mode ?? "pty");
      }),
    forward: () => Effect.die("not in test"),
    stopWorkspace: (target) =>
      Effect.sync(() => {
        stopped?.push(target.id);
      }),
    captureFlush: (target) =>
      Effect.gen(function* () {
        captureOps?.flushed?.push(`flush:${target.id}`);
        if (captureOps?.flush !== undefined) return yield* captureOps.flush(target);
        return {
          epoch: 0,
          worktreeId: "",
          pending: 0,
          stagedBytes: 0,
          uploadedObjects: 0,
          uploadedBytes: 0,
          registered: 0,
          fenced: false,
          paused: false,
        } satisfies WorkspaceCaptureStatus;
      }),
    captureReplan: (target) =>
      captureOps?.replan === undefined
        ? Effect.die("capture.replan not in this test world")
        : captureOps.replan(target),
    expireWorkspace: renewWorkspace,
    getSession: (_workspace, id) => Effect.succeed(ptys.get(id) ?? initialPty),
    // Typed failure, not a defect: the settle-path harvest must degrade
    // quietly and still reach the workspace reap.
    exec: (_workspace, argv) =>
      Effect.suspend(() => {
        execCalls?.push(argv);
        const script = argv[0] === "sh" && argv[1] === "-c" ? argv[2] : undefined;
        const relocation = captureOps?.relocation;
        if (script !== undefined && script.includes(HARNESS_HOME_MOUNT_PATH)) {
          if (relocation === undefined) {
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "", run: fakeExecRun });
          }
          const request = created.at(-1);
          const source = request?.source;
          if (source?.kind !== "capture" || source.harnessHome === undefined) {
            return Effect.fail(
              new SealantPlatformError({
                code: "capture_harness_home_missing",
                status: null,
                message: "capture source did not configure a harness root",
                cause: null,
              }),
            );
          }
          const harnessHomePath = path.join(relocation.executorRoot, source.harnessHome.slice(1));
          const mapped = script.replaceAll(source.harnessHome, harnessHomePath);
          return Effect.sync(() => {
            fs.mkdirSync(relocation.homePath, { recursive: true });
            const result = spawnSync("sh", ["-c", mapped], {
              env: { ...process.env, HOME: relocation.homePath },
              encoding: "utf8",
            });
            if (result.status === 0) relocation.observed?.push("relocate");
            return {
              exitCode: result.status ?? 1,
              stdout: result.stdout,
              stderr: result.stderr,
              run: fakeExecRun,
            };
          });
        }
        if (execCalls !== undefined) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "", run: fakeExecRun });
        }
        return Effect.fail(
          new SealantPlatformError({
            code: "exec-not-in-test",
            status: null,
            message: "exec not available in this test world",
            cause: null,
          }),
        );
      }),
    diffCommits: () => Effect.die("not in test"),
    inferenceRespond: () => Effect.die("not in test"),
    recordStream: () => Stream.fromEffect(Effect.never),
    recordTimeline: () => Stream.fromEffect(Effect.never),
    runChanges: () => Effect.die("not in test"),
    connectionCheck: () => Effect.die("not in test"),
    resolveWorkspacePackage: () => Effect.die("not in test"),
  });
};

/** PTY-only engine tests never persist structured conversations. */
const agentConversationStubLayer = Layer.succeed(AgentConversationRepo, {
  submitTurn: () => Effect.die("not in test"),
  byTurnId: () => Effect.succeed(null),
  byLaunchCorrelation: () => Effect.succeed(null),
  byProviderTurnId: () => Effect.succeed(null),
  listTurns: () => Effect.succeed([]),
  openTurns: () => Effect.succeed([]),
  claimNextTurn: () => Effect.succeed(null),
  setProviderTurnId: () => Effect.die("not in test"),
  bindRunningProviderTurn: () => Effect.succeed(null),
  failTurn: () => Effect.die("not in test"),
  completeTurn: () => Effect.succeed(null),
  upsertItem: () => Effect.die("not in test"),
  listItems: () => Effect.succeed([]),
  openRequest: () => Effect.die("not in test"),
  byRequestId: () => Effect.succeed(null),
  listRequests: () => Effect.succeed([]),
  hasPendingRequests: () => Effect.succeed(false),
  prepareRequestResponse: () => Effect.die("not in test"),
  completeRequestResponse: () => Effect.die("not in test"),
  failRequestResponse: () => Effect.void,
  resolveRequest: () => Effect.die("not in test"),
  resolveProviderRequest: () => Effect.void,
  cancelOpenForTurn: () => Effect.void,
  cancelOpenForProcess: () => Effect.void,
  backfillConversation: () => Effect.succeed(0),
  resetSendingResponses: () => Effect.void,
  requeueQueuedTurns: () => Effect.void,
  protocolCursor: () => Effect.succeed({ nextSequence: 0n }),
  saveProtocolCursor: () => Effect.void,
});

const protocolHostStubLayer = Layer.succeed(ProtocolHost, {
  attach: () => Effect.die("not in test"),
  rehydrate: () => Effect.die("not in test"),
  submitTurn: () => Effect.die("not in test"),
  interruptTurn: () => Effect.die("not in test"),
  respondRequest: () => Effect.die("not in test"),
  detach: () => Effect.void,
  has: () => Effect.succeed(false),
});

const recordingProtocolHostLayer = (
  attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
  submitted: string[],
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, mode: input.pipe.mode });
      }),
    rehydrate: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, mode: input.pipe.mode });
      }),
    submitTurn: (sessionId, input, author) =>
      Effect.sync(() => {
        submitted.push(input);
        return new AgentTurn({
          id: AgentTurnId.make(`turn-${submitted.length}`),
          sessionId,
          processId: attached.at(-1)?.process.id ?? SessionProcessId.make("missing-process"),
          ordinal: submitted.length - 1,
          author,
          input,
          status: "queued",
          providerTurnId: null,
          error: null,
          usage: null,
          createdAt: now(),
          startedAt: null,
          endedAt: null,
        });
      }),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(true),
  });

/** Services bind no real sockets in these worlds. */
const serviceHostStubLayer = Layer.succeed(ServiceHost, {
  bindAddresses: () => Effect.succeed(["127.0.0.1"]),
  start: () => Effect.succeed({ hostPort: 43127, boundAddresses: ["127.0.0.1"] }),
  stop: () => Effect.void,
  probe: () => Effect.succeed(true),
});

/**
 * Session sockets bind nothing in these worlds; the api each session would serve is kept so a
 * test can play the executor (its capture routes) without a listener.
 */
const servedSocketApis = new Map<SessionId, SessionSocketApi>();
const sessionSocketStubLayer = Layer.succeed(SessionSocketHost, {
  start: (sessionId, api) =>
    Effect.sync(() => {
      servedSocketApis.set(sessionId, api);
      return "/tmp/mend-test-socket-dir";
    }),
  stop: () => Effect.void,
});

/** No machine key and no transport log in these worlds. */
// Dotfiles resolve per owner; the engine fixtures run without any configured, so launches
// carry no archives and stamp an empty record.
const userDotfilesStubLayer = Layer.succeed(UserDotfilesRepo, {
  repository: () => Effect.succeed(null),
  setRepository: (_userId: string, value: DotfilesRepository | null) => Effect.succeed(value),
});
const dotfilesStoreStubLayer = Layer.succeed(DotfilesStore, {
  snapshot: () => Effect.die("not in test"),
  current: () => Effect.succeed(null),
  archive: () => Effect.succeed(null),
  clear: () => Effect.void,
});
const skillsStubLayer = Layer.succeed(SkillsRepo, {
  listForUser: () => Effect.succeed([]),
  listForProject: () => Effect.succeed([]),
  byId: () => Effect.die("not in test"),
  create: () => Effect.die("not in test"),
  update: () => Effect.die("not in test"),
  remove: () => Effect.die("not in test"),
  sync: () => Effect.die("not in test"),
  forLaunch: () => Effect.succeed({ user: [], project: [] }),
});

const skillsForLaunchLayer = (
  forLaunch: SkillsRepo["Service"]["forLaunch"],
): Layer.Layer<SkillsRepo> =>
  Layer.succeed(SkillsRepo, {
    listForUser: () => Effect.succeed([]),
    listForProject: () => Effect.succeed([]),
    byId: () => Effect.die("not in test"),
    create: () => Effect.die("not in test"),
    update: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
    sync: () => Effect.die("not in test"),
    forLaunch,
  });

const mendKeysStubLayer = Layer.succeed(MendKeys, {
  ensure: () =>
    Effect.succeed({
      publicKey: "ssh-ed25519 TEST",
      fingerprint: "256 SHA256:test",
      privateKeyPath: "/tmp/mend-test-key",
    }),
  read: () => Effect.succeed(null),
});

/** No signer is ever connected in these worlds. */
const agentBridgeStubLayer = Layer.succeed(AgentBridge, {
  attach: () => Effect.die("not in test"),
  status: () => Effect.succeed({ connected: false, clientName: null, since: null }),
  socketPath: () => "/tmp/mend-test-bridge.sock",
  begin: () => Effect.succeed(() => {}),
});

const gitOpsStubLayer = Layer.succeed(SessionGitOpsRepo, {
  record: (op) =>
    Effect.succeed({
      ...op,
      id: SessionGitOpId.make(crypto.randomUUID()),
      refUpdates: null,
      exitCode: null,
      startedAt: now(),
      finishedAt: null,
    }),
  finish: () => Effect.void,
  listForSession: () => Effect.succeed([]),
});

const now = () => new Date();

const launchSkill = (
  name: string,
  contents: string,
  owner:
    | { readonly scope: "user"; readonly userId: string }
    | { readonly scope: "project"; readonly projectId: ProjectId },
): SkillWithFiles =>
  new SkillWithFiles({
    skill: new Skill({
      id: SkillId.make(`${owner.scope}-${name}`),
      scope: owner.scope,
      ownerUserId: owner.scope === "user" ? owner.userId : null,
      projectId: owner.scope === "project" ? owner.projectId : null,
      name,
      description: "",
      fileCount: 1,
      bytes: contents.length,
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    }),
    files: [{ path: "SKILL.md", contents }],
  });

interface World {
  readonly projects: Map<string, Project>;
  readonly sessions: Map<string, Session>;
  readonly sessionRuns: Map<string, SessionRun>;
  readonly processes: Map<string, SessionProcess>;
  readonly services: Map<string, Service>;
  readonly serviceForwards: Map<string, ServiceForward>;
  readonly serviceObservations: Map<string, ServiceObservation>;
  readonly changes: Map<string, Change>;
  readonly checkpoints: Array<Checkpoint>;
  /** What `CheckpointsRepo.create` was given as the capture each row was observed from. */
  readonly checkpointCaptureIds: Map<string, string | null>;
  /** Inserts refused by the unique `(worktree_id, ordinal)` index — the fake counts them. */
  readonly checkpointConflicts: { count: number };
  /** Keyed by worktree id. */
  readonly worktrees: Map<string, Worktree>;
  /** Members of the fixture organization (`org-test`), by account. */
  readonly members: Map<string, "owner" | "member">;
  /** What `SessionsRepo.recentOwnersForProject` answers: the accounts the hot pool may warm for. */
  recentOwners: ReadonlyArray<string>;
}

const makeWorld = (): World => ({
  projects: new Map(),
  sessions: new Map(),
  sessionRuns: new Map(),
  processes: new Map(),
  services: new Map(),
  serviceForwards: new Map(),
  serviceObservations: new Map(),
  changes: new Map(),
  checkpoints: [],
  checkpointCaptureIds: new Map(),
  checkpointConflicts: { count: 0 },
  worktrees: new Map(),
  members: new Map([["user-fixture", "member"]]),
  recentOwners: ["user-fixture"],
});

const sessionProcessesLayer = (world: World) => {
  const endLive = (
    process: SessionProcess,
    outcome: "exited" | "stopped",
    exitCode: number | null,
  ) => {
    if (process.exitedAt !== null) return;
    world.processes.set(
      process.id,
      new SessionProcess({
        ...process,
        status: outcome,
        exitCode,
        exitedAt: now(),
        updatedAt: now(),
      }),
    );
  };
  return Layer.succeed(SessionProcessesRepo, {
    create: (input: NewSessionProcess) =>
      Effect.sync(() => {
        const process = new SessionProcess({
          ...input,
          id: input.id ?? SessionProcessId.make(crypto.randomUUID()),
          status: input.status ?? "running",
          exitCode: null,
          harness: input.harness ?? null,
          providerSessionId: input.providerSessionId ?? null,
          sealantRunId: input.sealantRunId ?? null,
          launchCorrelationId: input.launchCorrelationId ?? null,
          serviceId: input.serviceId ?? null,
          attemptOrdinal: input.attemptOrdinal ?? null,
          protocolOptions: input.protocolOptions ?? null,
          workspacePort: input.workspacePort ?? null,
          protocol: input.protocol ?? "tcp",
          hostPort: input.hostPort ?? null,
          createdAt: now(),
          exitedAt: null,
          updatedAt: now(),
        });
        world.processes.set(process.id, process);
        return process;
      }),
    byId: (id) => Effect.succeed(world.processes.get(id) ?? null),
    byLaunchCorrelation: (correlationId) =>
      Effect.succeed(
        [...world.processes.values()].find(
          (process) => process.launchCorrelationId === correlationId,
        ) ?? null,
      ),
    listForSession: (sessionId) =>
      Effect.succeed(
        [...world.processes.values()].filter((process) => process.sessionId === sessionId),
      ),
    listForSessions: (sessionIds) =>
      Effect.succeed(
        [...world.processes.values()].filter((process) => sessionIds.includes(process.sessionId)),
      ),
    listForService: (serviceId) =>
      Effect.succeed(
        [...world.processes.values()]
          .filter((process) => process.serviceId === serviceId)
          .toSorted((left, right) => (left.attemptOrdinal ?? 0) - (right.attemptOrdinal ?? 0)),
      ),
    listLiveForWorkspace: (workspaceId) =>
      Effect.succeed(
        [...world.processes.values()].filter(
          (process) => process.sealantWorkspaceId === workspaceId && process.exitedAt === null,
        ),
      ),
    listLive: () =>
      Effect.succeed([...world.processes.values()].filter((process) => process.exitedAt === null)),
    setStatus: (id, status) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(id, new SessionProcess({ ...process, status, updatedAt: now() }));
        }
      }),
    setLabel: (id, label) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(id, new SessionProcess({ ...process, label, updatedAt: now() }));
        }
      }),
    setProviderSessionId: (id, providerSessionId) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined) {
          world.processes.set(
            id,
            new SessionProcess({ ...process, providerSessionId, updatedAt: now() }),
          );
        }
      }),
    setHostPort: (id, hostPort) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(id, new SessionProcess({ ...process, hostPort, updatedAt: now() }));
        }
      }),
    setSealantSessionId: (id, sealantSessionId, sealantRunId) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(
            id,
            new SessionProcess({ ...process, sealantSessionId, sealantRunId, updatedAt: now() }),
          );
        }
      }),
    listRecentServices: () =>
      Effect.succeed([...world.processes.values()].filter((process) => process.kind === "service")),
    markExited: (id, outcome, exitCode) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined) endLive(process, outcome, exitCode);
      }),
    reapLiveForWorkspace: (workspaceId, kinds) =>
      Effect.sync(() => {
        for (const process of world.processes.values()) {
          if (process.sealantWorkspaceId !== workspaceId) continue;
          if (kinds !== undefined && !kinds.includes(process.kind)) continue;
          endLive(process, "exited", null);
        }
      }),
  });
};

const servicesLayer = (world: World) =>
  Layer.succeed(ServicesRepo, {
    create: (input) =>
      Effect.sync(() => {
        const service = new Service({
          id: input.id ?? ServiceId.make(crypto.randomUUID()),
          sessionId: input.sessionId,
          name: input.name,
          declarationSource: input.declarationSource,
          workspacePort: input.workspacePort,
          transport: input.transport,
          browserScheme: input.browserScheme ?? null,
          bindAddresses: input.bindAddresses ?? null,
          preferredHostPort: input.preferredHostPort ?? null,
          currentAttemptId: null,
          currentForwardId: null,
          attemptHistoryComplete: input.attemptHistoryComplete ?? true,
          forwardHistoryComplete: input.forwardHistoryComplete ?? true,
          observationHistoryComplete: input.observationHistoryComplete ?? true,
          createdAt: now(),
          updatedAt: now(),
        });
        world.services.set(service.id, service);
        return service;
      }),
    byId: (id) => Effect.succeed(world.services.get(id) ?? null),
    byReference: (id) =>
      Effect.succeed(
        world.services.get(id) ??
          (() => {
            const serviceId = world.processes.get(id)?.serviceId;
            return serviceId === null || serviceId === undefined
              ? null
              : (world.services.get(serviceId) ?? null);
          })(),
      ),
    byName: (sessionId, name) =>
      Effect.succeed(
        [...world.services.values()]
          .filter((service) => service.sessionId === sessionId && service.name === name)
          .at(-1) ?? null,
      ),
    listForSession: (sessionId) =>
      Effect.succeed(
        [...world.services.values()].filter((service) => service.sessionId === sessionId),
      ),
    listAll: () => Effect.succeed([...world.services.values()]),
    setCurrentAttempt: (id, currentAttemptId) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service !== undefined) {
          world.services.set(id, new Service({ ...service, currentAttemptId, updatedAt: now() }));
        }
      }),
    setCurrentForward: (id, currentForwardId) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service !== undefined) {
          world.services.set(id, new Service({ ...service, currentForwardId, updatedAt: now() }));
        }
      }),
    compareAndSetCurrentAttempt: (id, expected, next) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service === undefined || service.currentAttemptId !== expected) return false;
        world.services.set(
          id,
          new Service({ ...service, currentAttemptId: next, updatedAt: now() }),
        );
        return true;
      }),
    compareAndSetCurrentForward: (id, expected, next) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service === undefined || service.currentForwardId !== expected) return false;
        world.services.set(
          id,
          new Service({ ...service, currentForwardId: next, updatedAt: now() }),
        );
        return true;
      }),
  });

const serviceForwardsLayer = (world: World) =>
  Layer.succeed(ServiceForwardsRepo, {
    create: (input) =>
      Effect.sync(() => {
        const forward = new ServiceForward({
          id: input.id ?? ServiceForwardId.make(crypto.randomUUID()),
          serviceId: input.serviceId,
          sealantWorkspaceId: input.sealantWorkspaceId,
          preferredHostPort: input.preferredHostPort ?? null,
          hostPort: null,
          boundAddresses: null,
          state: "binding",
          error: null,
          supersedesForwardId: input.supersedesForwardId ?? null,
          createdAt: now(),
          boundAt: null,
          closedAt: null,
          updatedAt: now(),
        });
        world.serviceForwards.set(forward.id, forward);
        return forward;
      }),
    createAndSelect: (input) =>
      Effect.sync(() => {
        const forward = new ServiceForward({
          id: input.id ?? ServiceForwardId.make(crypto.randomUUID()),
          serviceId: input.serviceId,
          sealantWorkspaceId: input.sealantWorkspaceId,
          preferredHostPort: input.preferredHostPort ?? null,
          hostPort: null,
          boundAddresses: null,
          state: "binding",
          error: null,
          supersedesForwardId: input.supersedesForwardId ?? null,
          createdAt: now(),
          boundAt: null,
          closedAt: null,
          updatedAt: now(),
        });
        world.serviceForwards.set(forward.id, forward);
        const service = world.services.get(input.serviceId);
        if (service !== undefined) {
          world.services.set(
            service.id,
            new Service({ ...service, currentForwardId: forward.id, updatedAt: now() }),
          );
        }
        return forward;
      }),
    byId: (id) => Effect.succeed(world.serviceForwards.get(id) ?? null),
    listForService: (serviceId) =>
      Effect.succeed(
        [...world.serviceForwards.values()].filter((forward) => forward.serviceId === serviceId),
      ),
    listOpen: () =>
      Effect.succeed(
        [...world.serviceForwards.values()].filter(
          (forward) => forward.state === "binding" || forward.state === "bound",
        ),
      ),
    markBound: (id, hostPort, boundAddresses) =>
      Effect.sync(() => {
        const forward = world.serviceForwards.get(id);
        if (forward !== undefined) {
          world.serviceForwards.set(
            id,
            new ServiceForward({
              ...forward,
              hostPort,
              boundAddresses,
              state: "bound",
              error: null,
              boundAt: now(),
              updatedAt: now(),
            }),
          );
        }
      }),
    markFailed: (id, error) =>
      Effect.sync(() => {
        const forward = world.serviceForwards.get(id);
        if (forward !== undefined) {
          world.serviceForwards.set(
            id,
            new ServiceForward({
              ...forward,
              state: "failed",
              error,
              closedAt: now(),
              updatedAt: now(),
            }),
          );
        }
      }),
    markClosed: (id) =>
      Effect.sync(() => {
        const forward = world.serviceForwards.get(id);
        if (forward !== undefined) {
          world.serviceForwards.set(
            id,
            new ServiceForward({
              ...forward,
              state: "closed",
              closedAt: now(),
              updatedAt: now(),
            }),
          );
        }
      }),
  });

const serviceObservationsLayer = (world: World) =>
  Layer.succeed(ServiceObservationsRepo, {
    record: (input) =>
      Effect.sync(() => {
        const observation = new ServiceObservation({
          id: ServiceObservationId.make(crypto.randomUUID()),
          ...input,
          error: input.error ?? null,
          firstObservedAt: now(),
          lastObservedAt: now(),
        });
        world.serviceObservations.set(observation.id, observation);
        return observation;
      }),
    latestForService: (serviceId) =>
      Effect.succeed(
        [...world.serviceObservations.values()]
          .filter((observation) => observation.serviceId === serviceId)
          .at(-1) ?? null,
      ),
    listForService: (serviceId) =>
      Effect.succeed(
        [...world.serviceObservations.values()].filter(
          (observation) => observation.serviceId === serviceId,
        ),
      ),
  });

const serviceStateLayer = (world: World) =>
  Layer.mergeAll(
    servicesLayer(world),
    serviceForwardsLayer(world),
    serviceObservationsLayer(world),
  );

/** One organization, `org-test`, whose members the world names. */
const organizationsLayer = (world: World) =>
  Layer.mock(OrganizationsRepo, {
    membershipOf: (userId) =>
      Effect.sync(() => {
        const role = world.members.get(userId);
        return role === undefined
          ? null
          : {
              organization: new Organization({
                id: OrganizationId.make("org-test"),
                name: "Test",
                createdByUserId: null,
                createdAt: now(),
                updatedAt: now(),
              }),
              role,
              joinedAt: now(),
            };
      }),
  });

/** No organization folders selected in these worlds. */
const foldersEmptyLayer = Layer.mock(FoldersRepo, { listForProject: () => Effect.succeed([]) });

const projectLinksEmptyLayer = Layer.succeed(ProjectLinksRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ProjectLinkNotFoundError({ linkId: id })),
  listForProject: () => Effect.succeed([]),
  remove: () => Effect.void,
});

/** No declared mounts in these worlds. */
const projectMountsEmptyLayer = Layer.succeed(ProjectMountsRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ProjectMountNotFoundError({ mountId: id })),
  listForProject: () => Effect.succeed([]),
  remove: () => Effect.void,
});

/** No project-level recipes in these worlds — the file is the only source. */
const projectRecipesEmptyLayer = Layer.succeed(ProjectServiceRecipesRepo, {
  listForProject: () => Effect.succeed([]),
  create: () => Effect.die("not in test"),
  remove: () => Effect.void,
});

/**
 * The project env store as the engine reads it at launch: Configuration rows and sealed
 * secrets, both configurable per test so lifecycle assertions can flip them mid-world. The
 * "cipher" is a reversible marker so a test can prove which plaintext reached createWorkspace.
 */
const projectEnvironmentLayer = (
  read: () => { readonly revision: number; readonly variables: Record<string, string> },
) =>
  Layer.succeed(ProjectEnvironmentRepo, {
    snapshot: (projectId) =>
      Effect.sync(() => {
        const current = read();
        return new ProjectEnvironmentSnapshot({
          revision: current.revision,
          variables: Object.entries(current.variables)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(
              ([name, value]) =>
                new ProjectEnvironmentVariable({
                  id: ProjectEnvironmentVariableId.make(`env-${name}`),
                  projectId,
                  name,
                  value,
                  revision: 1,
                  createdAt: now(),
                  updatedAt: now(),
                }),
            ),
        });
      }),
    create: () => Effect.die("not in test"),
    update: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
    upsertByName: () => Effect.die("not in test"),
  });
const projectSecretsLayer = (
  read: () => { readonly revision: number; readonly secrets: Record<string, string> },
) =>
  Layer.succeed(ProjectSecretsRepo, {
    snapshot: () =>
      Effect.sync(() => new ProjectSecretsSnapshot({ revision: read().revision, secrets: [] })),
    sealedForLaunch: () =>
      Effect.sync(() => {
        const current = read();
        return {
          revision: current.revision,
          secrets: Object.entries(current.secrets)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => ({ name, sealedValue: `sealed:${value}` })),
        };
      }),
    create: () => Effect.die("not in test"),
    update: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
    upsertByName: () => Effect.die("not in test"),
  });
/**
 * Cluster bindings as the engine reads them at launch: names + the service account, never
 * contents. Same read-closure shape as the env/secret fakes so tests can mutate mid-world.
 */
const projectClusterBindingsLayer = (
  read: () => {
    readonly revision: number;
    readonly bindings: ReadonlyArray<{
      readonly kind: "secret" | "configmap";
      readonly objectName: string;
    }>;
    readonly serviceAccount: string | null;
  },
) =>
  Layer.succeed(ProjectClusterBindingsRepo, {
    snapshot: (projectId) =>
      Effect.sync(() => {
        const current = read();
        return new ProjectClusterBindingsSnapshot({
          revision: current.revision,
          bindings: current.bindings.map(
            (binding, index) =>
              new ProjectClusterBinding({
                id: ProjectClusterBindingId.make(`cb-${index}`),
                projectId,
                kind: binding.kind,
                objectName: binding.objectName,
                revision: 1,
                createdAt: now(),
                updatedAt: now(),
              }),
          ),
          serviceAccount: current.serviceAccount,
        });
      }),
    add: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
    setServiceAccount: () => Effect.die("not in test"),
  });
const emptyClusterBindings = () => ({ revision: 0, bindings: [], serviceAccount: null });
const secretCipherStubLayer = Layer.succeed(SecretCipher, {
  encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
  decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
});
const emptyEnvironment = () => ({ revision: 0, variables: {} });
const bigintSafe = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;
const emptySecrets = () => ({ revision: 0, secrets: {} });

/** No references in these worlds — launches mount nothing extra. */
const referencesEmptyLayer = Layer.succeed(ReferencesRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
  byName: () => Effect.succeed(null),
  listForOrganization: () => Effect.succeed([]),
  byIdsInOrganization: () => Effect.succeed([]),
  remove: () => Effect.void,
  setHead: () => Effect.void,
  listForProject: () => Effect.succeed([]),
  setForProject: () => Effect.void,
});

const projectsLayer = (world: World) =>
  Layer.succeed(ProjectsRepo, {
    create: () => Effect.die("not in test"),
    setGitAuthMode: () => Effect.die("not in test"),
    listForOrganization: () => Effect.die("not in test"),
    setVisibility: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setApplyDotfiles: () => Effect.die("not in test"),
    setInheritUserSkills: () => Effect.die("not in test"),
    setHotSessions: () => Effect.die("not in test"),
    setInstallCommand: () => Effect.die("not in test"),
    byId: (id) => {
      const found = world.projects.get(id);
      return found === undefined
        ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
        : Effect.succeed(found);
    },
    byName: () => Effect.succeed(null),
    listAll: () => Effect.succeed([...world.projects.values()]),
    setAutomation: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
  });

const sessionsLayer = (world: World) => {
  const update = (id: string, patch: Partial<Session>) => {
    const current = world.sessions.get(id);
    if (current !== undefined) {
      world.sessions.set(id, new Session({ ...current, ...patch, updatedAt: now() }));
    }
  };
  return Layer.succeed(SessionsRepo, {
    create: (input: NewSession) =>
      Effect.sync(() => {
        const session = new Session({
          id: input.id,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          harness: input.harness,
          providerSessionId: null,
          label: input.label,
          worktree: input.worktree,
          branch: input.branch,
          baseSha: input.baseSha,
          baseRef: input.baseRef,
          contextSnapshotId: input.contextSnapshotId,
          referenceMounts: [],
          extraMounts: [],
          sealantRunId: null,
          sealantWorkspaceId: null,
          sealantSessionId: null,
          workspaceExpiresAt: null,
          workspaceTtlRenewedAt: null,
          workspaceTtlRenewalFailedAt: null,
          workspaceTtlRenewalError: null,
          workspaceImage: null,
          dotfiles: null,
          ownerUserId: input.ownerUserId,
          hasTranscript: null,
          status: "starting",
          summary: null,
          lastSeenSequence: 0n,
          recordHistoryComplete: true,
          startedAt: null,
          settledAt: null,
          createdAt: now(),
          updatedAt: now(),
        });
        world.sessions.set(session.id, session);
        return session;
      }),
    byId: (id) => {
      const found = world.sessions.get(id);
      return found === undefined
        ? Effect.fail(new SessionNotFoundError({ sessionId: id }))
        : Effect.succeed(found);
    },
    listForProject: () => Effect.succeed([...world.sessions.values()]),
    listForWorktree: (worktreeId) =>
      Effect.succeed([...world.sessions.values()].filter((s) => s.worktreeId === worktreeId)),
    listActive: () => Effect.succeed([]),
    listUnsettled: () =>
      Effect.succeed([...world.sessions.values()].filter((s) => s.settledAt === null)),
    recentOwnersForProject: () => Effect.sync(() => world.recentOwners),
    listRecentlySettled: () =>
      Effect.succeed(
        [...world.sessions.values()].filter(
          (s) => s.settledAt !== null && s.sealantWorkspaceId !== null,
        ),
      ),
    setSealantIds: (id, sealantRunId, sealantWorkspaceId) =>
      Effect.sync(() =>
        update(id, {
          sealantRunId,
          sealantWorkspaceId,
          workspaceExpiresAt: null,
          workspaceTtlRenewedAt: null,
          workspaceTtlRenewalFailedAt: null,
          workspaceTtlRenewalError: null,
          lastSeenSequence: 0n,
        }),
      ),
    recordWorkspaceTtlRenewal: (id, workspaceId, expiresAt, renewedAt) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.sealantWorkspaceId !== workspaceId) return;
        update(id, {
          workspaceExpiresAt: expiresAt,
          workspaceTtlRenewedAt: renewedAt,
          workspaceTtlRenewalFailedAt: null,
          workspaceTtlRenewalError: null,
        });
      }),
    recordWorkspaceTtlRenewalFailure: (id, workspaceId, error, failedAt) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.sealantWorkspaceId !== workspaceId) return;
        update(id, {
          workspaceTtlRenewalFailedAt: failedAt,
          workspaceTtlRenewalError: error,
        });
      }),
    setSealantSessionId: (id, sealantSessionId) =>
      Effect.sync(() => update(id, { sealantSessionId })),
    setWorkspaceImage: (id, image) => Effect.sync(() => update(id, { workspaceImage: image })),
    setDotfiles: (id, dotfiles) => Effect.sync(() => update(id, { dotfiles })),
    setHasTranscript: (id, hasTranscript) => Effect.sync(() => update(id, { hasTranscript })),
    listSettledUnclassified: (limit) =>
      Effect.succeed(
        [...world.sessions.values()]
          .filter((session) => session.settledAt !== null && session.hasTranscript === null)
          .slice(0, limit),
      ),
    setReferenceMounts: (id: string, mounts: ReadonlyArray<SessionReferenceMount>) =>
      Effect.sync(() => update(id, { referenceMounts: mounts })),
    setExtraMounts: (id: string, mounts: ReadonlyArray<SessionExtraMount>) =>
      Effect.sync(() => update(id, { extraMounts: mounts })),
    setProviderSessionId: (id, providerSessionId) =>
      Effect.sync(() => update(id, { providerSessionId })),
    setStatus: (id, status) => Effect.sync(() => update(id, { status })),
    nativeIngestCursor: () => Effect.succeed(null),
    setNativeIngestCursor: () => Effect.void,
    saveLastSeenSequence: (id, sequence) =>
      Effect.sync(() => update(id, { lastSeenSequence: sequence })),
    notifyProgress: () => Effect.void,
    settle: (id, outcome, summary) =>
      Effect.sync(() => update(id, { status: outcome, summary, settledAt: now() })),
    reopen: (id, status) => Effect.sync(() => update(id, { status, settledAt: null })),
    setSummary: (id, summary) => Effect.sync(() => update(id, { summary })),
    setHarness: (id, harness) => Effect.sync(() => update(id, { harness })),
    setLabel: (id, label) => Effect.sync(() => update(id, { label })),
    setLabelIfUnset: (id, label) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.label !== null) return false;
        update(id, { label });
        return true;
      }),
    remove: () => Effect.die("not in test"),
  });
};

const changesLayer = (world: World) =>
  Layer.succeed(WorktreeChangesRepo, {
    ensureForWorktree: (projectId, worktreeId, branch, baseSha) =>
      Effect.sync(() => {
        const existing = world.changes.get(worktreeId);
        if (existing !== undefined) return existing;
        const change = new Change({
          id: ChangeId.make(crypto.randomUUID()),
          projectId,
          worktreeId,
          sessionId: null,
          branch,
          baseSha,
          headSha: null,
          createdAt: now(),
          updatedAt: now(),
        });
        world.changes.set(worktreeId, change);
        return change;
      }),
    byId: () => Effect.die("not in test"),
    byWorktree: (worktreeId) => Effect.succeed(world.changes.get(worktreeId) ?? null),
    bySession: (sessionId) =>
      Effect.sync(() => {
        const session = world.sessions.get(sessionId);
        if (session === undefined) return null;
        return world.changes.get(session.worktreeId) ?? null;
      }),
    refreshHead: (id, headSha, viaSessionId) =>
      Effect.sync(() => {
        for (const [key, change] of world.changes) {
          if (change.id === id) {
            world.changes.set(
              key,
              new Change({
                ...change,
                headSha,
                sessionId: viaSessionId ?? change.sessionId,
                updatedAt: now(),
              }),
            );
          }
        }
      }),
    annotationsForProject: () => Effect.succeed([]),
  });

const worktreesLayer = (world: World) =>
  Layer.succeed(WorktreesRepo, {
    create: (input) =>
      Effect.sync(() => {
        const worktree = new Worktree({ ...input, createdAt: now(), updatedAt: now() });
        world.worktrees.set(worktree.id, worktree);
        return worktree;
      }),
    byId: (id) => {
      const found = world.worktrees.get(id);
      return found === undefined
        ? Effect.fail(new WorktreeNotFoundError({ id }))
        : Effect.succeed(found);
    },
    byName: (projectId, name) =>
      Effect.succeed(
        [...world.worktrees.values()].find(
          (worktree) => worktree.projectId === projectId && worktree.name === name,
        ) ?? null,
      ),
    byDirectory: (projectId, directory) =>
      Effect.succeed(
        [...world.worktrees.values()].find(
          (worktree) => worktree.projectId === projectId && worktree.directory === directory,
        ) ?? null,
      ),
    listForProject: (projectId) =>
      Effect.succeed(
        [...world.worktrees.values()].filter((worktree) => worktree.projectId === projectId),
      ),
    setBase: (id, baseSha, baseRef) =>
      Effect.sync(() => {
        const current = world.worktrees.get(id);
        if (current !== undefined) {
          world.worktrees.set(id, new Worktree({ ...current, baseSha, baseRef, updatedAt: now() }));
        }
      }),
    rename: (id, name, branch) =>
      Effect.sync(() => {
        const current = world.worktrees.get(id);
        if (current !== undefined) {
          world.worktrees.set(id, new Worktree({ ...current, name, branch, updatedAt: now() }));
        }
      }),
    remove: (id) =>
      Effect.sync(() => {
        world.worktrees.delete(id);
      }),
    newestLiveSessionId: (id) =>
      Effect.succeed(
        [...world.sessions.values()]
          .filter(
            (session) =>
              session.worktreeId === id &&
              ["starting", "running", "waiting", "idle"].includes(session.status),
          )
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id ?? null,
      ),
  });

const sessionRunsLayer = (world: World) => {
  const listForSession = (sessionId: string) =>
    [...world.sessionRuns.values()]
      .filter((run) => run.sessionId === sessionId)
      .toSorted((left, right) => left.ordinal - right.ordinal);
  const update = (id: string, patch: Partial<SessionRun>) => {
    const current = world.sessionRuns.get(id);
    if (current !== undefined) {
      world.sessionRuns.set(id, new SessionRun({ ...current, ...patch, updatedAt: now() }));
    }
  };
  return Layer.succeed(SessionRunsRepo, {
    create: (input: NewSessionRun) =>
      Effect.sync(() => {
        const run = new SessionRun({
          ...input,
          ordinal: listForSession(input.sessionId).length,
          status: "running",
          summary: null,
          lastSeenSequence: 0n,
          environmentRevision: input.environmentRevision ?? null,
          environmentVariableNames: input.environmentVariableNames ?? null,
          secretRevision: input.secretRevision ?? null,
          secretNames: input.secretNames ?? null,
          clusterBindingRevision: input.clusterBindingRevision ?? null,
          clusterBindingNames: input.clusterBindingNames ?? null,
          clusterServiceAccount: input.clusterServiceAccount ?? null,
          startedAt: now(),
          settledAt: null,
          createdAt: now(),
          updatedAt: now(),
        });
        world.sessionRuns.set(run.sealantRunId, run);
        return run;
      }),
    bySealantRunId: (id) => Effect.succeed(world.sessionRuns.get(id) ?? null),
    listForSession: (sessionId) => Effect.succeed(listForSession(sessionId)),
    latestForSession: (sessionId) => Effect.succeed(listForSession(sessionId).at(-1) ?? null),
    activeForSession: (sessionId) =>
      Effect.succeed(listForSession(sessionId).findLast((run) => run.settledAt === null) ?? null),
    listActive: () =>
      Effect.succeed([...world.sessionRuns.values()].filter((run) => run.settledAt === null)),
    saveLastSeenSequence: (id, sequence) =>
      Effect.sync(() => update(id, { lastSeenSequence: sequence })),
    settle: (id, status, summary) =>
      Effect.sync(() => update(id, { status, summary, settledAt: now() })),
  });
};

const checkpointsLayer = (world: World) =>
  Layer.succeed(CheckpointsRepo, {
    // The unique `(worktree_id, ordinal)` index, as Postgres enforces it: a taken ordinal is
    // the typed conflict carrying the row that got there first, never a second row.
    create: (input: NewCheckpoint) =>
      Effect.suspend(() => {
        const existing = world.checkpoints.find(
          (c) => c.worktreeId === input.worktreeId && c.ordinal === input.ordinal,
        );
        if (existing !== undefined) {
          world.checkpointConflicts.count += 1;
          return Effect.fail(
            new CheckpointOrdinalTakenError({
              worktreeId: input.worktreeId,
              ordinal: input.ordinal,
              existing,
            }),
          );
        }
        const checkpoint = new Checkpoint({
          id: CheckpointId.make(crypto.randomUUID()),
          worktreeId: input.worktreeId,
          sessionId: input.sessionId,
          ordinal: input.ordinal,
          ref: input.ref,
          sha: input.sha,
          sealantRunId: input.sealantRunId,
          seq: input.seq,
          trigger: input.trigger,
          createdAt: now(),
        });
        world.checkpoints.push(checkpoint);
        world.checkpointCaptureIds.set(checkpoint.id, input.captureId ?? null);
        return Effect.succeed(checkpoint);
      }),
    byId: (id) =>
      Effect.succeed(world.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null),
    byOrdinal: (worktreeId, ordinal) =>
      Effect.succeed(
        world.checkpoints.find((c) => c.worktreeId === worktreeId && c.ordinal === ordinal) ?? null,
      ),
    listForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId)),
    latestForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId).at(-1) ?? null),
    countForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId).length),
    listForSession: (sessionId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.sessionId === sessionId)),
    withWorktreeLock: (_worktreeId, effect) => effect,
  });

const reserveGitPort = async () => {
  const server = net.createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("No Git fixture port available.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
};

/** Keep the real network origin alive until the engine and its test scope close. */
const serveGitOrigin = (tmp: string) =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(reserveGitPort);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const daemon = spawn(
          "git",
          [
            "daemon",
            "--reuseaddr",
            "--export-all",
            "--verbose",
            `--base-path=${tmp}`,
            "--listen=127.0.0.1",
            `--port=${port}`,
            tmp,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
        const ready = new Promise<void>((resolve, reject) => {
          let stderr = "";
          daemon.once("error", reject);
          daemon.once("exit", (code, signal) => {
            reject(new Error(`Git fixture exited before readiness: ${code ?? signal}\n${stderr}`));
          });
          daemon.stderr.setEncoding("utf8");
          daemon.stderr.on("data", (chunk: string) => {
            stderr += chunk;
            if (stderr.includes("Ready to rumble")) resolve();
          });
        });
        return { daemon, closed, ready };
      }),
      ({ daemon, closed }) =>
        Effect.promise(async () => {
          daemon.kill();
          await closed;
        }),
    );
    yield* Effect.promise(() => server.ready).pipe(Effect.timeout("5 seconds"));
    return RepositoryCloneUrl.make(`git://127.0.0.1:${port}/origin`);
  });

/** A throwaway origin repo with one commit, adopted over Git into a tmp store. */
const setup = (tmp: string, world: World) => {
  const origin = path.join(tmp, "origin");
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: origin,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "origin",
        GIT_AUTHOR_EMAIL: "origin@localhost",
        GIT_COMMITTER_NAME: "origin",
        GIT_COMMITTER_EMAIL: "origin@localhost",
      },
    });
  fs.mkdirSync(origin, { recursive: true });
  run("init", "-b", "main");
  fs.writeFileSync(path.join(origin, "app.ts"), "export const answer = 41\n");
  run("add", "-A");
  run("commit", "-m", "initial");

  return Effect.gen(function* () {
    const source = yield* serveGitOrigin(tmp);
    const store = yield* Store;
    const adopted = yield* store.adopt("fixture", source, { GIT_TERMINAL_PROMPT: "0" });
    const project = new Project({
      id: ProjectId.make("proj-1"),
      name: "fixture",
      organizationId: OrganizationId.make("org-test"),
      visibility: "shared",
      createdByUserId: null,
      originUrl: source,
      storePath: adopted.storePath,
      defaultBranch: adopted.defaultBranch,
      adoptedSha: Sha.make(adopted.headSha),
      autoTour: "inherit",
      autoName: "inherit",
      autoSuggest: "inherit",
      backgroundSessions: "inherit",
      gitAuthMode: "ambient",
      workspaceImage: null,
      applyDotfiles: true,
      inheritUserSkills: true,
      hotSessions: 0,
      installCommand: null,
      createdAt: now(),
      updatedAt: now(),
    });
    world.projects.set(project.id, project);
    return project;
  });
};

const withEngine = <A, E>(
  work: (
    world: World,
    tmp: string,
  ) => Effect.Effect<A, E, SessionEngine | Store | WorktreesRepo | Scope.Scope>,
  options: {
    readonly sealantLayer?: Layer.Layer<SealantClient>;
    readonly protocolHostLayer?: Layer.Layer<ProtocolHost>;
    readonly hotWorkspacesLayer?: Layer.Layer<HotWorkspacesRepo>;
    readonly skillsLayer?: Layer.Layer<SkillsRepo>;
    readonly workspaceImage?: typeof defaultSettings.workspaceImage;
    readonly environment?: () => {
      readonly revision: number;
      readonly variables: Record<string, string>;
    };
    readonly secrets?: () => {
      readonly revision: number;
      readonly secrets: Record<string, string>;
    };
    readonly clusterBindings?: () => {
      readonly revision: number;
      readonly bindings: ReadonlyArray<{
        readonly kind: "secret" | "configmap";
        readonly objectName: string;
      }>;
      readonly serviceAccount: string | null;
    };
    /** Seed crash-recovery facts before the SessionEngine layer runs its boot pass. */
    readonly prepareWorld?: (world: World, tmp: string) => void;
    /** Reuse one persisted test world across engine scopes to exercise process restart. */
    readonly fixture?: { readonly world: World; readonly tmp: string };
    /** Capture mode (ADR-0002): the pointer store the test inspects; the bucket is `<tmp>/blobs`. */
    readonly captured?: MemoryCaptureStore;
  } = {},
): Promise<A> => {
  const tmp = options.fixture?.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-test-"));
  const world = options.fixture?.world ?? makeWorld();
  options.prepareWorld?.(world, tmp);
  const storeConfigLayer = StoreConfig.layerFor(path.join(tmp, "store"));
  const storeLayer = Store.layer.pipe(Layer.provide(storeConfigLayer));
  const blobsLayer = BlobStoreFsLive(path.join(tmp, "blobs"));
  const captureLayers =
    options.captured === undefined
      ? null
      : Layer.mergeAll(
          options.captured.layer,
          memoryStoreRefs(),
          blobsLayer,
          GitOpsRunnerLive.pipe(
            Layer.provide(storeLayer),
            Layer.provide(storeConfigLayer),
            Layer.provide(blobsLayer),
          ),
          CaptureChannelLive.pipe(
            Layer.provide(CaptureGitVerifierOff),
            Layer.provide(options.captured.layer),
            Layer.provide(blobsLayer),
            Layer.provide(CaptureUploadPolicyDefault),
          ),
        );
  const sessionRepositoryLayer =
    captureLayers === null
      ? SessionRepositoryLocalLive.pipe(
          Layer.provide(storeLayer),
          Layer.provide(projectsLayer(world)),
        )
      : SessionRepositoryCapturedLive.pipe(
          Layer.provide(storeLayer),
          Layer.provide(projectsLayer(world)),
          Layer.provide(worktreesLayer(world)),
          Layer.provide(captureLayers),
        );
  const captureRuntimeLayer =
    captureLayers === null
      ? CaptureRuntimeOff
      : CaptureRuntimeLive.pipe(Layer.provide(captureLayers));
  const deploymentLayer =
    captureLayers === null
      ? DeploymentConfigColocated
      : Layer.succeed(DeploymentConfig, {
          mode: "local",
          sessionEndpoint: { listen: "127.0.0.1:0", url: "http://mend.test:3106" },
          sessionStore: "captured",
        });
  const engineLayer = SessionEngineLive.pipe(
    Layer.provide(sessionRepositoryLayer),
    Layer.provide(storeLayer),
    Layer.provide(options.sealantLayer ?? sealantDeadLayer),
    Layer.provide(settingsLayer(options.workspaceImage)),
    Layer.provide(projectsLayer(world)),
    Layer.provide(sessionsLayer(world)),
    Layer.provide(sessionRunsLayer(world)),
    Layer.provide(sessionProcessesLayer(world)),
    Layer.provide(
      Layer.mergeAll(
        agentConversationStubLayer,
        options.protocolHostLayer ?? protocolHostStubLayer,
        serviceStateLayer(world),
      ),
    ),
    Layer.provide(serviceHostStubLayer),
    Layer.provide(sessionSocketStubLayer),
    Layer.provide(SessionChannelTokensRepoMemory),
    Layer.provide(deploymentLayer),
    Layer.provide(captureRuntimeLayer),
    Layer.provide(
      // One merged provide: `pipe` is typed to 20 operators and this list outgrew it.
      Layer.mergeAll(
        mendKeysStubLayer,
        agentBridgeStubLayer,
        gitOpsStubLayer,
        changesLayer(world),
        worktreesLayer(world),
        checkpointsLayer(world),
        referencesEmptyLayer,
        projectMountsEmptyLayer,
        projectLinksEmptyLayer,
        organizationsLayer(world),
        foldersEmptyLayer,
        projectRecipesEmptyLayer,
        options.hotWorkspacesLayer ?? hotWorkspacesEmptyLayer,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        projectEnvironmentLayer(options.environment ?? emptyEnvironment),
        projectSecretsLayer(options.secrets ?? emptySecrets),
        projectClusterBindingsLayer(options.clusterBindings ?? emptyClusterBindings),
        secretCipherStubLayer,
        userDotfilesStubLayer,
        dotfilesStoreStubLayer,
        options.skillsLayer ?? skillsStubLayer,
      ),
    ),
  );
  return Effect.runPromise(
    work(world, tmp).pipe(
      Effect.provide(Layer.mergeAll(engineLayer, storeLayer, worktreesLayer(world))),
      Effect.scoped,
      Effect.ensuring(
        options.fixture === undefined
          ? Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))
          : Effect.void,
      ),
      Effect.orDie,
    ),
  );
};

describe("SessionEngine", () => {
  it("launches with the configured image and the user's GitHub token", async () => {
    const created: CreateOptions[] = [];
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

          expect(created).toHaveLength(1);
          expect(created[0]?.os).toBe("nix");
          expect(created[0]?.packages).toEqual(["bat", "lazygit"]);
          expect(created[0]?.services).toEqual({ docker: true });
          expect(created[0]?.credentials).toEqual({ codex: true, github: true });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        workspaceImage: {
          mode: "family",
          os: "nix",
          packages: ["bat", "lazygit"],
          shell: "bash",
          services: { docker: true },
        },
      },
    );
  });

  it("reports the platform's runtime-specific Docker refusal without Kubernetes-only advice", async () => {
    const created: CreateOptions[] = [];
    const platformCause = new Error("MicroVM capability refusal");
    const platformMessage =
      "This deployment runs workspaces on the 'microvm' runtime, which has no workspace-scoped Docker. Turn Docker off for this workspace.";

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

          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);

          expect(failure).toBeInstanceOf(SealantPlatformError);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("workspace-docker-unsupported");
          expect(platformFailure?.status).toBe(422);
          expect(platformFailure?.cause).toBe(platformCause);
          expect(platformFailure?.message).toBe(`launch refused · Docker · ${platformMessage}`);
          expect(platformFailure?.message).not.toContain("Sealant chart");
          expect(platformFailure?.message).not.toContain("workspaces.docker");
          expect(created).toHaveLength(1);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.summary).toContain(platformMessage);
          expect(settled?.summary).not.toContain("Sealant chart");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.fail(
              new SealantPlatformError({
                code: "workspace-docker-unsupported",
                status: 422,
                message: platformMessage,
                cause: platformCause,
              }),
            ),
        ),
        workspaceImage: {
          mode: "family",
          os: "ubuntu",
          packages: [],
          shell: "bash",
          services: { docker: true },
        },
      },
    );
  });

  it("delivers the launching owner's skills and lets project skills override by name", async () => {
    const created: CreateOptions[] = [];
    const requestedOwners: Array<string | null> = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.sync(() => {
        requestedOwners.push(ownerUserId);
        return {
          user: [
            launchSkill("global", "owner global", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
            launchSkill("shared", "owner shared", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
          ],
          project: [launchSkill("shared", "project shared", { scope: "project", projectId })],
        };
      }),
    );
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
            ownerUserId: "owner-1",
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "global", "SKILL.md"), "utf8")).toBe(
            "owner global",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "shared", "SKILL.md"), "utf8")).toBe(
            "project shared",
          );
          expect(requestedOwners).toEqual(["owner-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("excludes user skills when the project's inheritance setting is off", async () => {
    const created: CreateOptions[] = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.succeed({
        user: [
          launchSkill("global", "owner global", {
            scope: "user",
            userId: ownerUserId ?? "missing-owner",
          }),
        ],
        project: [launchSkill("local", "project local", { scope: "project", projectId })],
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const noInheritance = new Project({ ...project, inheritUserSkills: false });
          world.projects.set(project.id, noInheritance);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "owner-2",
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.existsSync(path.join(skillsRoot, "global"))).toBe(false);
          expect(fs.readFileSync(path.join(skillsRoot, "local", "SKILL.md"), "utf8")).toBe(
            "project local",
          );
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("launches a protocol agent through a pipe and records an agent-protocol process", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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

          yield* engine.launchProtocol(
            session.id,
            {
              mode: "protocol",
              prompt: "inspect replay",
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            },
            "user-1",
          );

          expect(openedOptions).toEqual([{ mode: "pipe" }]);
          expect(spawned[0]?.slice(-2)).toEqual(["codex", "app-server"]);
          expect(attached).toHaveLength(1);
          expect(attached[0]?.mode).toBe("pipe");
          expect(attached[0]?.process.kind).toBe("agent-protocol");
          expect(attached[0]?.process.argv).toEqual(["codex", "app-server"]);
          expect(submitted).toEqual(["inspect replay"]);

          const duplicate = yield* engine
            .launchProtocol(session.id, { mode: "protocol", permissionMode: "bypass" }, null)
            .pipe(Effect.flip);
          expect(duplicate).toBeInstanceOf(SealantPlatformError);
          expect(duplicate instanceof SealantPlatformError ? duplicate.code : null).toBe(
            "session_active",
          );
          expect(attached).toHaveLength(1);

          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          expect(attached[1]?.process.kind).toBe("agent-protocol");

          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1");
          expect(attached[2]?.process.kind).toBe("agent-protocol");
          expect(attached[2]?.process.launchCorrelationId).toBe("follow-up-1");
          expect(submitted).toEqual(["inspect replay", "address the review"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("resumes an idle protocol session in the workspace retained by its shell", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(world.processes.get(shell.id)?.exitedAt).toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.mode).toBe("pipe");
          expect(attached[1]?.process.kind).toBe("agent-protocol");
          expect(attached[1]?.process.sealantWorkspaceId).toBe(shell.sealantWorkspaceId);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("honors a fresh protocol resume while a shell retains the old workspace", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null, true);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.processes.get(shell.id)?.exitedAt).not.toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("restores harvested state into the fresh workspace a protocol resume provisions", async () => {
    // Live failure 2026-08-28 (PoC session 59e473f4): launchProtocol passed an explicit
    // null state to launchInternal, which skips the restore — while the composed argv
    // still resumed by provider id. On a fresh workspace claude then exited 1 with
    // "No conversation found with session ID". The restore must reach the new workspace.
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-protocol",
          );
          if (agent === undefined || agent.providerSessionId === null) {
            throw new Error("the protocol launch recorded no provider session id");
          }
          yield* engine.stop(session.id);
          // The settle-path harvest (forked) clears the manifest before its capture fails
          // against the empty exec output; wait for its pack attempt before planting state.
          const packRan = () =>
            execCalls.some((argv) => argv.join(" ").includes("mend-harness-state.tgz"));
          for (let i = 0; i < 400 && !packRan(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(packRan()).toBe(true);
          const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: agent.providerSessionId,
              capturedAt: new Date().toISOString(),
            }),
          );
          fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          // The saved state was staged into the worktree and unpacked in the NEW workspace
          // before the harness started.
          const restoreExec = execCalls.find((argv) =>
            argv.join(" ").includes(".mend-harness-state-"),
          );
          expect(restoreExec?.join(" ")).toContain("tar -xzf");
          // And the relaunch still resumes the native conversation.
          const resumeArgv = spawned.at(-1) ?? [];
          expect(resumeArgv).toContain("--resume");
          expect(resumeArgv).toContain(agent.providerSessionId);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("falls back to a fresh protocol launch when the retained workspace disappears", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    let simulateDisappearance = false;
    let workspaceLookups = 0;
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");
          simulateDisappearance = true;

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(attached).toHaveLength(2);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped, undefined, () => {
          if (!simulateDisappearance) return false;
          workspaceLookups += 1;
          return workspaceLookups === 2;
        }),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("settles a protocol launch interrupted during workspace provisioning", async () => {
    const created: CreateOptions[] = [];
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
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
          const launch = yield* engine
            .launchProtocol(session.id, { mode: "protocol", permissionMode: "bypass" }, "user-1")
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => started);
          yield* Fiber.interrupt(launch);

          const interrupted = world.sessions.get(session.id);
          expect(interrupted?.status).toBe("failed");
          expect(interrupted?.summary).toContain("interrupted");
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
          () => Effect.sync(() => notifyStarted?.()).pipe(Effect.andThen(Effect.never)),
        ),
      },
    );
  });

  it("launches Claude stream-json with one provider session id", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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

          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );

          const process = attached[0]?.process;
          const sessionFlag = process?.argv.indexOf("--session-id") ?? -1;
          expect(process?.kind).toBe("agent-protocol");
          expect(process?.argv).toContain("stream-json");
          expect(process?.providerSessionId).toBe(process?.argv.at(sessionFlag + 1));
          expect(attached[0]?.mode).toBe("pipe");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("settles and reaps a protocol process when adapter initialization fails", async () => {
    const created: CreateOptions[] = [];
    const failingHost = Layer.succeed(ProtocolHost, {
      rehydrate: () => Effect.die("not in test"),
      attach: () =>
        Effect.fail(
          new SealantPlatformError({
            code: "protocol-init-failed",
            status: null,
            message: "initialize failed",
            cause: null,
          }),
        ),
      submitTurn: () => Effect.die("not in test"),
      interruptTurn: () => Effect.die("not in test"),
      respondRequest: () => Effect.die("not in test"),
      detach: () => Effect.void,
      has: () => Effect.succeed(false),
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

          const error = yield* engine
            .launchProtocol(session.id, { mode: "protocol", permissionMode: "ask" }, "user-1")
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(SealantPlatformError);
          const process = [...world.processes.values()].find(
            (candidate) => candidate.kind === "agent-protocol",
          );
          expect(process?.exitedAt).not.toBeNull();
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          expect([...world.sessionRuns.values()].at(-1)?.status).toBe("failed");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: failingHost,
      },
    );
  });

  it("keeps a legacy bench review-only", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: "bench",
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          const error = yield* engine.launch(session.id, ["bash"]).pipe(Effect.flip);
          expect(error).toBeInstanceOf(LegacyBenchReadOnlyError);
          expect(created).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("launches a shell session in the image's configured login shell", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          // The UI's shell harness always requests ["bash"] — the sentinel for
          // "an interactive shell" — but the PTY must run the image's shell so
          // the owner's dotfiles actually load. Flags ride along.
          yield* engine.launch(session.id, ["bash"]);
          expect(spawned.at(-1)).toEqual(["zsh"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        workspaceImage: {
          mode: "family",
          os: "arch",
          packages: [],
          shell: "zsh",
          services: { docker: false },
        },
      },
    );
  });

  it("keeps the GitHub token when the harness account is unavailable", async () => {
    const created: CreateOptions[] = [];
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

          expect(created.map((options) => options.credentials)).toEqual([
            { codex: true, github: true },
            { codex: true },
            { github: true },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, (credentials) => credentials?.codex === true),
      },
    );
  });

  it("gives a shell session the codex account when only codex is connected", async () => {
    // The shell ladder must degrade per provider: a create naming an
    // unconnected account fails whole, so a codex-only user used to fall all
    // the way to `undefined` and open a shell with no agent auth at all.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          yield* engine.launch(session.id, ["bash", "-i"]);

          const attempts = created.map((options) => options.credentials);
          expect(attempts.at(-1)).toEqual({ codex: true });
          expect(attempts).toEqual([
            { claude: true, codex: true, github: true },
            { codex: true, github: true },
            { claude: true, github: true },
            { claude: true, codex: true },
            { codex: true },
          ]);
        }),
      {
        // Only codex is connected: any bundle naming claude or github is refused.
        sealantLayer: sealantLaunchLayer(
          created,
          (credentials) => credentials?.claude === true || credentials?.github === true,
        ),
      },
    );
  });

  it("delivers the exact follow-up in a workspace retained by a shell lease", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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

          // A live shell in the same workspace holds a lease (docs/SESSION-SERVICES.md).
          const shell = new SessionProcess({
            id: SessionProcessId.make("shell-1"),
            sessionId: session.id,
            sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
            sealantSessionId: "pty-2",
            sealantRunId: null,
            launchCorrelationId: null,
            serviceId: null,
            attemptOrdinal: null,
            kind: "shell",
            harness: null,
            providerSessionId: null,
            protocolOptions: null,
            label: "shell",
            argv: ["bash", "-i"],
            status: "running",
            exitCode: null,
            workspacePort: null,
            protocol: "tcp",
            hostPort: null,
            createdAt: now(),
            exitedAt: null,
            updatedAt: now(),
          });
          world.processes.set(shell.id, shell);

          yield* engine.stop(session.id);
          // The sweep is a forked fiber; wait for it to end the agent's record.
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          expect(agentExited()).toBe(true);
          expect(stopped).toEqual([]);
          const retained = [...world.processes.values()].filter(
            (process) => process.exitedAt === null,
          );
          expect(retained.map((process) => process.kind)).toEqual(["shell"]);

          const instruction =
            "  Address exactly the selected Review comments.\nKeep trailing bytes.  ";
          const resumed = yield* engine.launchFollowUp(
            session.id,
            instruction,
            "follow-up:delivery-1",
          );
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          const afterResume = [...world.processes.values()].filter(
            (process) => process.exitedAt === null,
          );
          expect(afterResume.map((process) => process.kind).toSorted()).toEqual([
            "agent-pty",
            "shell",
          ]);
          const deliveryProcess = afterResume.find(
            (process) => process.launchCorrelationId === "follow-up:delivery-1",
          );
          const transportArgv = deliveryProcess?.argv ?? [];
          expect(transportArgv.slice(0, 2)).toEqual(["sh", "-c"]);
          expect(transportArgv[2]).toContain(
            "exec codex --dangerously-bypass-approvals-and-sandbox",
          );
          expect(Buffer.from(transportArgv.slice(4).join(""), "base64").toString("utf8")).toBe(
            instruction,
          );
          expect(deliveryProcess?.sealantRunId).not.toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stops the workspace when no lease outlives the agent", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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

          yield* engine.stop(session.id);
          for (let i = 0; i < 200 && stopped.length === 0; i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          expect(stopped).toEqual(["workspace-1"]);
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live).toEqual([]);

          const settledBeforeRetry = world.sessions.get(session.id);
          const failure = yield* engine
            .launchFollowUp(
              session.id,
              "This launch cannot restore missing native state.",
              "follow-up:missing-state",
            )
            .pipe(Effect.flip);
          expect(failure).toBeInstanceOf(HarnessStateNotFoundError);
          const settledAfterRetry = world.sessions.get(session.id);
          expect(settledAfterRetry?.status).toBe(settledBeforeRetry?.status);
          expect(settledAfterRetry?.settledAt).toEqual(settledBeforeRetry?.settledAt);
          expect(created).toHaveLength(1);
          expect(
            [...world.processes.values()].some(
              (process) => process.launchCorrelationId === "follow-up:missing-state",
            ),
          ).toBe(false);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("folds status over processes: a shell keeps the session idle after its agent stops", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
          const shell = yield* engine.openShell(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("running");

          // Stop ends the AGENT; the shell's lease keeps the worktree's workspace — and the
          // session reads idle, not settled: nothing here is a judgment about the work.
          yield* engine.stop(session.id);
          const afterStop = world.sessions.get(session.id);
          expect(afterStop?.status).toBe("idle");
          expect(afterStop?.settledAt).toBeNull();
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty",
          );
          expect(agent?.status).toBe("stopped");
          expect(agent?.harness).toBe("codex");
          const agentRunId = agent?.sealantRunId ?? null;
          expect(agentRunId === null ? null : world.sessionRuns.get(agentRunId)?.status).toBe(
            "stopped",
          );
          // Let the forked tail (harvest, fold) run; the workspace must survive it.
          yield* Effect.sleep(Duration.millis(100));
          expect(stopped).toEqual([]);

          // The last lease ends: the fold settles the session from the last agent outcome.
          yield* engine.stopShell(shell.id);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.settledAt).not.toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stop kills a session held open only by an orphan shell (the refuses-to-die case)", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
          yield* engine.openShell(session.id);
          // The agent exits on its own (Ctrl+C out of codex): scaffold the
          // post-exit world directly — process ended, run settled, fold idle.
          for (const [id, process] of world.processes) {
            if (process.kind !== "agent-pty") continue;
            world.processes.set(
              id,
              new SessionProcess({
                ...process,
                status: "exited",
                exitCode: 0,
                exitedAt: now(),
                updatedAt: now(),
              }),
            );
            const runId = process.sealantRunId;
            const run = runId === null ? undefined : world.sessionRuns.get(runId);
            if (runId !== null && run !== undefined) {
              world.sessionRuns.set(
                runId,
                new SessionRun({
                  ...run,
                  status: "completed",
                  settledAt: now(),
                  updatedAt: now(),
                }),
              );
            }
          }
          const before = world.sessions.get(session.id);
          if (before !== undefined) {
            world.sessions.set(session.id, new Session({ ...before, status: "idle" }));
          }

          // A stop with NO live agent is aimed at the session itself: the
          // orphan shell closes and the session settles — a 200 that leaves
          // it idle is the refuses-to-die bug.
          yield* engine.stop(session.id);
          const after = world.sessions.get(session.id);
          expect(after?.status).toBe("stopped");
          expect(after?.settledAt).not.toBeNull();
          expect(
            [...world.processes.values()].filter((process) => process.exitedAt === null),
          ).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("folds an agent exit the watcher observes: idle while a shell holds on, completed after", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
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
          const shell = yield* engine.openShell(session.id);
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty",
          );
          if (agent === undefined || agent.sealantSessionId === null) {
            throw new Error("the launch recorded no agent PTY");
          }
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 0,
            outputHighWater: 0n,
          });
          // The watcher records the end, then the tail harvests and snapshots; wait for the
          // snapshot — it is the last observable step before the fold.
          const snapshotted = () =>
            world.checkpoints.some((checkpoint) => checkpoint.trigger === "turn-boundary");
          for (let i = 0; i < 400 && !snapshotted(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(world.processes.get(agent.id)?.exitedAt).not.toBeNull();
          expect(world.processes.get(agent.id)?.status).toBe("exited");
          expect(world.sessions.get(session.id)?.status).toBe("idle");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          expect(stopped).toEqual([]);
          // The end of an agent process is a turn boundary. Ordinal 0 is the
          // worktree-start snapshot (no session attached), then the session's own start.
          expect(world.checkpoints.map((checkpoint) => checkpoint.trigger)).toEqual([
            "session-start",
            "session-start",
            "turn-boundary",
          ]);
          expect(world.checkpoints[0]?.sessionId).toBeNull();

          yield* engine.stopShell(shell.id);
          expect(world.sessions.get(session.id)?.status).toBe("completed");
          expect(world.sessions.get(session.id)?.settledAt).not.toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          ptyStates,
        ),
      },
    );
  });

  it("a second agent process joins a session its shell keeps idle", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
          yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          yield* Effect.sleep(Duration.millis(100));
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          // Resume as a shell: no saved state needed, and the retained workspace is reused.
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          const agents = [...world.processes.values()]
            .filter((process) => process.kind === "agent-pty")
            .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          expect(agents.map((process) => [process.harness, process.status])).toEqual([
            ["codex", "stopped"],
            ["shell", "running"],
          ]);
          // The session keeps its identity; only the launch ran a shell.
          expect(world.sessions.get(session.id)?.harness).toBe("codex");
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("refuses a follow-up while any agent process is live", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.openShell(session.id);
          const failure = yield* engine
            .launchFollowUp(session.id, "Address the comments.", "follow-up:while-live")
            .pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          expect(failure instanceof SealantPlatformError ? failure.code : null).toBe(
            "session_active",
          );
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-pty"),
          ).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell records a live shell process in the session workspace", async () => {
    const created: CreateOptions[] = [];
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

          const first = yield* engine.openShell(session.id);
          const second = yield* engine.openShell(session.id);
          expect(first.kind).toBe("shell");
          expect(first.label).toBe("shell 1");
          expect(second.label).toBe("shell 2");
          expect(first.sealantWorkspaceId).toBe("workspace-1");

          const renamed = yield* engine.renameShell(first.id, "tests");
          expect(renamed.label).toBe("tests");
          const duplicate = yield* engine.renameShell(second.id, "tests").pipe(Effect.flip);
          expect(duplicate.message).toContain("already exists");

          const stopped = yield* engine.stopShell(first.id);
          expect(stopped.status).toBe("stopped");
          const stoppedAgain = yield* engine.stopShell(first.id);
          expect(stoppedAgain.status).toBe("stopped");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.kind).toSorted()).toEqual(["agent-pty", "shell"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell refuses a session that has no workspace", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });

        const outcome = yield* engine.openShell(session.id).pipe(Effect.flip);
        expect(outcome).toBeInstanceOf(SessionNotLiveError);
      }),
    );
  });

  it("records the exact platform expiry when a new agent lease renews its workspace", async () => {
    const created: CreateOptions[] = [];
    const renewals: Array<{ readonly workspaceId: string; readonly ttlSeconds: number }> = [];
    const exactExpiry = new Date("2031-02-03T04:05:06.000Z");
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

          expect(renewals).toEqual([{ workspaceId: "workspace-1", ttlSeconds: 43_200 }]);
          expect(launched.workspaceExpiresAt).toEqual(exactExpiry);
          expect(launched.workspaceTtlRenewedAt).not.toBeNull();
          expect(launched.workspaceTtlRenewalFailedAt).toBeNull();
          expect(launched.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          (workspaceId, ttlSeconds) =>
            Effect.sync(() => {
              renewals.push({ workspaceId, ttlSeconds });
              return exactExpiry;
            }),
        ),
      },
    );
  });

  it("preserves known expiry on renewal failure and clears the failure after recovery", async () => {
    const created: CreateOptions[] = [];
    const firstExpiry = new Date("2031-02-03T04:05:06.000Z");
    const recoveredExpiry = new Date("2031-02-03T16:05:06.000Z");
    let renewalAttempt = 0;
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
          const afterSuccess = world.sessions.get(session.id);
          const firstRenewedAt = afterSuccess?.workspaceTtlRenewedAt ?? null;
          expect(afterSuccess?.workspaceExpiresAt).toEqual(firstExpiry);

          yield* engine.openShell(session.id);
          const afterFailure = world.sessions.get(session.id);
          expect(afterFailure?.workspaceExpiresAt).toEqual(firstExpiry);
          expect(afterFailure?.workspaceTtlRenewedAt).toEqual(firstRenewedAt);
          expect(afterFailure?.workspaceTtlRenewalFailedAt).not.toBeNull();
          expect(afterFailure?.workspaceTtlRenewalError).toBe("renewal unavailable");

          yield* engine.openShell(session.id);
          const afterRecovery = world.sessions.get(session.id);
          expect(afterRecovery?.workspaceExpiresAt).toEqual(recoveredExpiry);
          expect(afterRecovery?.workspaceTtlRenewalFailedAt).toBeNull();
          expect(afterRecovery?.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          () => {
            renewalAttempt += 1;
            if (renewalAttempt === 2) {
              return Effect.fail(
                new SealantPlatformError({
                  code: "workspace_expiry_failed",
                  status: 503,
                  message: "renewal unavailable",
                  cause: null,
                }),
              );
            }
            return Effect.succeed(renewalAttempt === 1 ? firstExpiry : recoveredExpiry);
          },
        ),
      },
    );
  });

  it("renews a retained shell workspace during boot recovery", async () => {
    const created: CreateOptions[] = [];
    const renewals: string[] = [];
    const sessionId = SessionId.make("session-retained-at-boot");
    const workspaceId = SealantWorkspaceId.make("workspace-1");
    const exactExpiry = new Date("2032-01-01T00:00:00.000Z");
    await withEngine(
      (world) =>
        Effect.gen(function* () {
          yield* Effect.suspend(() => {
            const session = world.sessions.get(sessionId);
            return session?.workspaceExpiresAt?.getTime() === exactExpiry.getTime()
              ? Effect.void
              : Effect.fail(new Error("retained workspace has not renewed yet"));
          }).pipe(Effect.retry({ times: 20, schedule: Schedule.spaced(Duration.millis(10)) }));
          expect(renewals).toContain(workspaceId);
          const renewed = world.sessions.get(sessionId);
          expect(renewed?.workspaceTtlRenewedAt).not.toBeNull();
          expect(renewed?.workspaceTtlRenewalError).toBeNull();
        }),
      {
        prepareWorld: (world) => {
          const timestamp = now();
          world.sessions.set(
            sessionId,
            new Session({
              id: sessionId,
              projectId: ProjectId.make("project-retained-at-boot"),
              worktreeId: WorktreeId.make("wt-retained-at-boot"),
              harness: "codex",
              providerSessionId: null,
              label: null,
              worktree: "session-retained-at-boot",
              branch: "mend/session-retained-at-boot",
              baseSha: Sha.make("base-sha"),
              baseRef: "main",
              contextSnapshotId: null,
              referenceMounts: [],
              extraMounts: [],
              sealantRunId: null,
              sealantWorkspaceId: workspaceId,
              sealantSessionId: null,
              workspaceExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
              workspaceTtlRenewedAt: new Date("2029-12-31T12:00:00.000Z"),
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
          world.processes.set(
            "shell-retained-at-boot",
            new SessionProcess({
              id: SessionProcessId.make("shell-retained-at-boot"),
              sessionId,
              sealantWorkspaceId: workspaceId,
              sealantSessionId: "pty-1",
              sealantRunId: SealantRunId.make("run-shell-retained-at-boot"),
              launchCorrelationId: null,
              serviceId: null,
              attemptOrdinal: null,
              kind: "shell",
              harness: null,
              providerSessionId: null,
              protocolOptions: null,
              label: "shell 1",
              argv: ["sh"],
              status: "running",
              exitCode: null,
              workspacePort: null,
              protocol: "tcp",
              hostPort: null,
              createdAt: timestamp,
              exitedAt: null,
              updatedAt: timestamp,
            }),
          );
        },
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          (candidateWorkspaceId) =>
            Effect.sync(() => {
              renewals.push(candidateWorkspaceId);
              return exactExpiry;
            }),
        ),
      },
    );
  });

  it("addService adopts a port; its lease outlives the agent until stopService", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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

          const service = yield* engine.addService(session.id, 5432, "db");
          expect(service.service.name).toBe("db");
          expect(service.service.workspacePort).toBe(5432);
          expect(service.attempts).toHaveLength(0);
          expect(service.currentForward?.hostPort).toBe(43127);
          expect(service.latestObservation?.state).toBe("reachable");
          const adoptedRestart = yield* engine.restartService(service.service.id).pipe(Effect.flip);
          expect(adoptedRestart.message).toContain("no recorded command");

          // A live name is taken — a second "db" is refused, not duplicated.
          const duplicate = yield* engine.addService(session.id, 5433, "db").pipe(Effect.flip);
          expect(String(duplicate.message)).toContain('named "db" already exists');

          // The agent settles; the Service lease keeps the workspace up.
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(agentExited()).toBe(true);
          expect(stopped).toEqual([]);

          // A completed coding-agent run may open another supporting process
          // while the Service retains the reachable workspace.
          const shell = yield* engine.openShell(session.id);
          expect(shell.label).toBe("shell 1");

          const ended = yield* engine.stopService(service.service.id);
          expect(ended.service.currentAttemptId).toBeNull();
          expect(ended.service.currentForwardId).toBeNull();
          expect(stopped).toEqual([]);
          yield* engine.stopShell(shell.id);
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("reuses a workspace retained only by an adopted Service; fresh resume closes it", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
          const view = yield* engine.addService(session.id, 5432, "db");
          yield* engine.stop(session.id);

          const agentsSettled = () =>
            [...world.processes.values()]
              .filter((process) => process.kind === "agent-pty")
              .every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentsSettled(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          yield* engine.resumeSession(session.id, "shell");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(world.services.get(view.service.id)?.currentForwardId).not.toBeNull();

          yield* engine.stop(session.id);
          for (let i = 0; i < 200 && !agentsSettled(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          yield* engine.resumeSession(session.id, "shell", true);
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.services.get(view.service.id)?.currentForwardId).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("runService restart appends attempts and preserves prior run pointers", async () => {
    const created: CreateOptions[] = [];
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

          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(service.service.name).toBe("web");
          expect(service.attempts).toHaveLength(1);
          expect(service.attempts[0]?.sealantSessionId).not.toBeNull();
          expect(service.attempts[0]?.argv).toEqual(["pnpm", "dev"]);
          expect(service.attempts[0]?.status).toBe("running");
          expect(service.currentForward?.hostPort).toBe(43127);
          expect(service.latestObservation?.state).toBe("reachable");

          const firstAttemptId = service.attempts[0]?.id;
          const firstRunId = service.attempts[0]?.sealantRunId;
          const forwardId = service.currentForward?.id;
          const restarted = yield* engine.restartService(service.service.id);
          expect(restarted.service.id).toBe(service.service.id);
          expect(restarted.attempts).toHaveLength(2);
          expect(restarted.attempts[0]?.id).toBe(firstAttemptId);
          expect(restarted.attempts[0]?.sealantRunId).toBe(firstRunId);
          expect(restarted.attempts[0]?.status).toBe("stopped");
          expect(restarted.attempts[1]?.id).not.toBe(firstAttemptId);
          expect(restarted.attempts[1]?.sealantRunId).not.toBe(firstRunId);
          expect(restarted.attempts[1]?.status).toBe("running");
          expect(restarted.currentForward?.id).toBe(forwardId);

          const stopped = yield* engine.stopService(service.service.id);
          expect(stopped.service.currentAttemptId).toBeNull();
          expect(stopped.service.currentForwardId).toBeNull();
          expect(stopped.attempts.at(-1)?.status).toBe("stopped");

          const rerun = yield* engine.runService(
            session.id,
            stopped.attempts.at(-1)?.argv ?? [],
            stopped.service.workspacePort,
            stopped.service.name,
            stopped.service.transport,
          );
          expect(rerun.service.id).toBe(service.service.id);
          expect(rerun.attempts).toHaveLength(3);
          expect(rerun.service.currentAttemptId).toBe(rerun.attempts.at(-1)?.id);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("stamps server-resolved file recipe provenance", async () => {
    const created: CreateOptions[] = [];
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
          const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
          fs.writeFileSync(
            path.join(worktree, "mend.toml"),
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );

          const service = yield* engine.runServiceRecipe(session.id, "web");
          expect(service.service.name).toBe("web");
          expect(service.service.declarationSource).toBe("recipe-file");
          expect(service.attempts[0]?.argv).toEqual(["sh", "-c", "pnpm dev"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("keeps a Service live across a transient watcher lookup failure", async () => {
    const created: CreateOptions[] = [];
    let workspaceLookups = 0;
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
          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          yield* Effect.sleep(Duration.millis(1_200));

          const attempt = world.processes.get(service.service.currentAttemptId ?? "");
          expect(attempt?.exitedAt).toBeNull();
          expect(world.services.get(service.service.id)?.currentForwardId).not.toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, undefined, () => {
          workspaceLookups += 1;
          return workspaceLookups === 2;
        }),
      },
    );
  });

  it("does not append a restart attempt when the workspace lookup fails", async () => {
    const created: CreateOptions[] = [];
    let rejectWorkspaceLookup = false;
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
          const before = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          rejectWorkspaceLookup = true;
          const failure = yield* engine.restartService(before.service.id).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          const attempts = [...world.processes.values()].filter(
            (process) => process.serviceId === before.service.id,
          );
          expect(attempts).toHaveLength(1);
          expect(world.services.get(before.service.id)?.currentAttemptId).toBe(attempts[0]?.id);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          () => rejectWorkspaceLookup,
        ),
      },
    );
  });

  it("resumes a provisioned-but-never-launched session as a workbench shell", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          // The editor's workbench flow: create only — no launch — then shell-resume.
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(session.status).toBe("starting");

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.argv)).toEqual([["bash"]]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("resumes a settled session with shell — no saved state required", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          // The session keeps its harness identity — only this launch is a shell.
          expect(resumed.harness).toBe("codex");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.argv)).toEqual([["bash"]]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("passes the project env store to createWorkspace ONCE and stamps only names on the run", async () => {
    const created: CreateOptions[] = [];
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

          // Configuration rides `env`, secrets are unsealed into `secretEnv` — exactly once.
          expect(created).toHaveLength(1);
          expect(created[0]?.env).toEqual({ APP_MODE: "review", PORT: "3000" });
          expect(created[0]?.secretEnv).toEqual({
            DATABASE_URL: "postgres://u:hunter2@h/db",
            STRIPE_API_KEY: "sk_live_x",
          });
          // The run's manifest carries revisions + NAMES; no value or sealed value anywhere.
          const [run] = [...world.sessionRuns.values()];
          expect(run?.environmentRevision).toBe(4);
          expect(run?.environmentVariableNames).toEqual(["APP_MODE", "PORT"]);
          expect(run?.secretRevision).toBe(2);
          expect(run?.secretNames).toEqual(["DATABASE_URL", "STRIPE_API_KEY"]);
          expect(JSON.stringify([...world.sessionRuns.values()], bigintSafe)).not.toContain(
            "hunter2",
          );
          expect(JSON.stringify([...world.sessions.values()], bigintSafe)).not.toContain("hunter2");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        environment: () => ({ revision: 4, variables: { PORT: "3000", APP_MODE: "review" } }),
        secrets: () => ({
          revision: 2,
          secrets: { STRIPE_API_KEY: "sk_live_x", DATABASE_URL: "postgres://u:hunter2@h/db" },
        }),
      },
    );
  });

  it("passes cluster bindings + service account to createWorkspace and stamps NAMES on the run", async () => {
    const created: CreateOptions[] = [];
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

          // Bindings ride `envFrom`, the trust grant rides `kubernetes` — exactly once, no
          // Mend-side capability pre-check (the platform's create-time refusal is the check).
          expect(created).toHaveLength(1);
          expect(created[0]?.envFrom).toEqual([
            { kind: "configmap", name: "app-config" },
            { kind: "secret", name: "app-env" },
          ]);
          expect(created[0]?.kubernetes).toEqual({ serviceAccountName: "mend-agent" });
          // The run's manifest carries the revision + `kind/objectName` strings + the SA name.
          const [run] = [...world.sessionRuns.values()];
          expect(run?.clusterBindingRevision).toBe(5);
          expect(run?.clusterBindingNames).toEqual(["configmap/app-config", "secret/app-env"]);
          expect(run?.clusterServiceAccount).toBe("mend-agent");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        clusterBindings: () => ({
          revision: 5,
          bindings: [
            { kind: "configmap", objectName: "app-config" },
            { kind: "secret", objectName: "app-env" },
          ],
          serviceAccount: "mend-agent",
        }),
      },
    );
  });

  it("restates the platform's cluster-reference refusal naming every binding", async () => {
    const created: CreateOptions[] = [];
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
          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          // The typed code survives the restatement — it IS the SDK capability probe.
          expect(platformFailure?.code).toBe("runtime-env-references-unsupported");
          expect(platformFailure?.message).toContain("secret/app-env");
          expect(platformFailure?.message).toContain("service account mend-agent");
          expect(platformFailure?.message).toContain("remove them in project setup");
          // No retry loop: the refusal is synchronous and deterministic.
          expect(created).toHaveLength(1);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.summary).toContain("launch refused");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.fail(
              new SealantPlatformError({
                code: "runtime-env-references-unsupported",
                status: 422,
                message: "the workspace runtime does not support environment references",
                cause: null,
              }),
            ),
        ),
        clusterBindings: () => ({
          revision: 3,
          bindings: [{ kind: "secret", objectName: "app-env" }],
          serviceAccount: "mend-agent",
        }),
      },
    );
  });

  it("omits env/secretEnv from createWorkspace when the project store is empty", async () => {
    const created: CreateOptions[] = [];
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
          expect(created[0]?.env).toBeUndefined();
          expect(created[0]?.secretEnv).toBeUndefined();
          expect(created[0]?.envFrom).toBeUndefined();
          expect(created[0]?.kubernetes).toBeUndefined();
          const [run] = [...world.sessionRuns.values()];
          // An empty store is still a REAL manifest (revision 0, no names) — not legacy/unknown.
          expect(run?.environmentRevision).toBe(0);
          expect(run?.environmentVariableNames).toEqual([]);
          expect(run?.secretRevision).toBe(0);
          expect(run?.secretNames).toEqual([]);
          expect(run?.clusterBindingRevision).toBe(0);
          expect(run?.clusterBindingNames).toEqual([]);
          expect(run?.clusterServiceAccount).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("a live edit never touches the running workspace; resume reads the current store", async () => {
    const created: CreateOptions[] = [];
    const store = { revision: 1, variables: { APP_MODE: "review" } as Record<string, string> };
    const secrets = { revision: 1, secrets: { API_KEY: "old" } as Record<string, string> };
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
          expect(created).toHaveLength(1);
          expect(created[0]?.env).toEqual({ APP_MODE: "review" });
          expect(created[0]?.secretEnv).toEqual({ API_KEY: "old" });

          // Edit while live: a shell in the running workspace triggers no create and no re-read.
          store.revision = 2;
          store.variables = { APP_MODE: "prod", NEW_VAR: "1" };
          secrets.revision = 2;
          secrets.secrets = { API_KEY: "new" };
          yield* engine.openShell(session.id);
          expect(created).toHaveLength(1);

          // Settle, then resume: a FRESH workspace with the CURRENT store, distinct manifest.
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          yield* engine.resumeSession(session.id, "shell", true);
          expect(created).toHaveLength(2);
          expect(created[1]?.env).toEqual({ APP_MODE: "prod", NEW_VAR: "1" });
          expect(created[1]?.secretEnv).toEqual({ API_KEY: "new" });
          // The fake PTY reuses one run id, so the world holds the LATEST run only — enough to
          // prove the resumed launch stamped the current store's manifest, not the original.
          const latest = [...world.sessionRuns.values()].at(-1);
          expect(latest?.environmentRevision).toBe(2);
          expect(latest?.environmentVariableNames).toEqual(["APP_MODE", "NEW_VAR"]);
          expect(latest?.secretRevision).toBe(2);
          expect(latest?.secretNames).toEqual(["API_KEY"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        environment: () => store,
        secrets: () => secrets,
      },
    );
  });

  it("attachRun records the explicit legacy/unknown manifest — never an inferred one", async () => {
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: null,
          });
          const runId = SealantRunId.make("sealant-run-attached");
          yield* engine.attachRun(session.id, runId, SealantWorkspaceId.make("workspace-x"));
          const run = world.sessionRuns.get(runId);
          expect(run?.environmentRevision).toBeNull();
          expect(run?.environmentVariableNames).toBeNull();
          expect(run?.secretRevision).toBeNull();
          expect(run?.secretNames).toBeNull();
          expect(run?.clusterBindingRevision).toBeNull();
          expect(run?.clusterBindingNames).toBeNull();
          expect(run?.clusterServiceAccount).toBeNull();
        }),
      // The store is NOT empty here — attach must still not read it.
      {
        environment: () => ({ revision: 9, variables: { SHOULD_NOT_BE_READ: "x" } }),
        secrets: () => ({ revision: 9, secrets: { SHOULD_NOT_BE_READ_EITHER: "y" } }),
        clusterBindings: () => ({
          revision: 9,
          bindings: [{ kind: "secret", objectName: "should-not-be-read" }],
          serviceAccount: "should-not-be-read",
        }),
      },
    );
  });

  it("provisions: worktree, session row, checkpoint 0, change row", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;

        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: "fix the answer",
          base: null,
        });

        expect(session.branch).toBe(`mend/wt/${session.worktreeId}`);
        expect(session.worktree).toBe(`wt-${session.worktreeId}`);
        expect(session.baseRef).toBe("main");
        expect(session.status).toBe("starting");
        expect(session.recordHistoryComplete).toBe(true);
        const worktreeRow = world.worktrees.get(session.worktreeId);
        expect(worktreeRow?.directory).toBe(session.worktree);
        const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
        expect(fs.existsSync(path.join(worktree, "app.ts"))).toBe(true);

        // Ordinal 0 belongs to the place (no session); the conversation adds its own start.
        const chain = world.checkpoints.filter((c) => c.worktreeId === session.worktreeId);
        expect(chain.map((c) => [c.ordinal, c.trigger, c.sessionId])).toEqual([
          [0, "session-start", null],
          [1, "session-start", session.id],
        ]);
        expect(chain[0]?.sealantRunId).toBeNull();
        expect(chain[0]?.seq).toBe(0n);

        const change = world.changes.get(session.worktreeId);
        expect(change?.baseSha).toBe(session.baseSha);
        expect(change?.worktreeId).toBe(session.worktreeId);
      }),
    );
  });

  it("joins an existing worktree by name: one worktree, one change, two conversations", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;

        const first = yield* engine.provision({
          name: "fix-auth",
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        expect(first.branch).toBe("mend/fix-auth");
        expect(first.worktree).toBe("fix-auth");

        const second = yield* engine.provision({
          name: "fix-auth",
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "claude",
          label: "second opinion",
          base: null,
        });
        expect(second.id).not.toBe(first.id);
        expect(second.worktreeId).toBe(first.worktreeId);
        expect(second.worktree).toBe(first.worktree);
        expect(world.worktrees.size).toBe(1);
        // One change per worktree — both conversations contribute to it.
        expect(world.changes.size).toBe(1);
        expect(world.changes.get(first.worktreeId)).toBeDefined();
        // The chain interleaves: worktree-start, then each session's start.
        const chain = world.checkpoints.filter((c) => c.worktreeId === first.worktreeId);
        expect(chain.map((c) => [c.ordinal, c.sessionId])).toEqual([
          [0, null],
          [1, first.id],
          [2, second.id],
        ]);

        // A conflicting base refuses loudly — never a silent re-base.
        const conflict = yield* engine
          .provision({
            name: "fix-auth",
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: "some-other-branch",
          })
          .pipe(Effect.result);
        expect(conflict._tag).toBe("Failure");
        if (conflict._tag === "Failure") {
          expect(conflict.failure._tag).toBe("WorktreeBaseConflictError");
        }
      }),
    );
  });

  it("provisionSessionIn opens a conversation inside a worktree by id", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const worktree = yield* engine.ensureWorktree(
          project.id,
          { name: "durable-place", base: null },
          null,
        );
        // A worktree with zero sessions is a legal durable place.
        expect(worktree.name).toBe("durable-place");
        expect(world.sessions.size).toBe(0);
        expect(world.changes.get(worktree.id)).toBeDefined();

        const session = yield* engine.provisionSessionIn(worktree.id, {
          harness: "codex",
          label: null,
          ownerUserId: "user-fixture",
        });
        expect(session.worktreeId).toBe(worktree.id);
        expect(session.branch).toBe("mend/durable-place");

        // ensureWorktree on the same name joins, never duplicates.
        const again = yield* engine.ensureWorktree(
          project.id,
          { name: "durable-place", base: null },
          null,
        );
        expect(again.id).toBe(worktree.id);
        expect(world.worktrees.size).toBe(1);
      }),
    );
  });

  it("indexes every attached run with an independent sequence cursor", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        const firstRunId = SealantRunId.make("sealant-run-1");
        const secondRunId = SealantRunId.make("sealant-run-2");

        yield* engine.attachRun(session.id, firstRunId, SealantWorkspaceId.make("workspace-1"));
        const first = world.sessionRuns.get(firstRunId);
        expect(first?.ordinal).toBe(0);
        expect(first?.lastSeenSequence).toBe(0n);

        if (first !== undefined) {
          world.sessionRuns.set(
            firstRunId,
            new SessionRun({
              ...first,
              lastSeenSequence: 47n,
              status: "completed",
              settledAt: now(),
              updatedAt: now(),
            }),
          );
        }
        const afterFirst = world.sessions.get(session.id);
        if (afterFirst !== undefined) {
          world.sessions.set(
            session.id,
            new Session({
              ...afterFirst,
              status: "completed",
              settledAt: now(),
              lastSeenSequence: 47n,
              updatedAt: now(),
            }),
          );
        }

        yield* engine.attachRun(session.id, secondRunId, SealantWorkspaceId.make("workspace-2"));

        const runs = [...world.sessionRuns.values()].toSorted(
          (left, right) => left.ordinal - right.ordinal,
        );
        expect(runs).toHaveLength(2);
        expect(runs.map((run) => run.sealantRunId)).toEqual([firstRunId, secondRunId]);
        expect(runs.map((run) => run.lastSeenSequence)).toEqual([47n, 0n]);
        expect(world.sessions.get(session.id)?.lastSeenSequence).toBe(0n);

        const checkpoint = yield* engine.checkpointNow(session.id, "user-mark");
        expect(checkpoint.sealantRunId).toBe(secondRunId);
        expect(checkpoint.seq).toBe(0n);
      }),
    );
  });

  it("checkpointNow snapshots edits and refreshes the change head", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });

        const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
        fs.writeFileSync(path.join(worktree, "app.ts"), "export const answer = 42\n");

        const checkpoint = yield* engine.checkpointNow(session.id, "user-mark");
        expect(checkpoint.trigger).toBe("user-mark");
        expect(checkpoint.ref).toContain(`refs/mend/checkpoints/${session.worktreeId}/2`);
        // The change stamps this session as its last contributor on refresh.
        const change = world.changes.get(session.worktreeId);
        expect(change?.headSha).toBe(checkpoint.sha);
        expect(change?.sessionId).toBe(session.id);

        // The slice cp0..cp2 carries exactly the edit.
        const store = yield* Store;
        const cp0 = world.checkpoints.find(
          (c) => c.worktreeId === session.worktreeId && c.ordinal === 0,
        );
        const diff = yield* store.diffRange(worktree, String(cp0?.sha), String(checkpoint.sha));
        expect(diff).toContain("+export const answer = 42");
      }),
    );
  });

  it("stop settles the session and leaves a final mark", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "custom",
          label: null,
          base: null,
        });

        yield* engine.stop(session.id);

        const settled = world.sessions.get(session.id);
        expect(settled?.status).toBe("stopped");
        expect(settled?.settledAt).not.toBeNull();
        const marks = world.checkpoints.filter(
          (c) => c.sessionId === session.id && c.trigger === "user-mark",
        );
        expect(marks).toHaveLength(1);
      }),
    );
  });

  it("refuses to resume a settled session without saved harness state", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        world.sessions.set(
          session.id,
          new Session({
            ...session,
            status: "completed",
            settledAt: now(),
            updatedAt: now(),
          }),
        );

        const error = yield* engine.resumeSession(session.id, null).pipe(Effect.flip, Effect.orDie);

        expect(error).toBeInstanceOf(HarnessStateNotFoundError);
        expect(error.message).toContain(String(session.id));
      }),
    );
  });

  it("resumes a crashed session natively from its live harness home", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: null,
          });
          // A crashed agent process: it ran, its workspace died, no capture was harvested.
          const processId = SessionProcessId.make(crypto.randomUUID());
          world.processes.set(
            processId,
            new SessionProcess({
              id: processId,
              sessionId: session.id,
              sealantWorkspaceId: SealantWorkspaceId.make("ws-crashed"),
              sealantSessionId: "pty-crashed",
              sealantRunId: SealantRunId.make("run-crashed"),
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
              exitCode: 137,
              workspacePort: null,
              protocol: "tcp",
              hostPort: null,
              createdAt: now(),
              exitedAt: now(),
              updatedAt: now(),
            }),
          );
          // What the durable harness-home mount kept: the rollout, live on the store.
          const rolloutId = crypto.randomUUID();
          const rolloutDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".codex",
            "sessions",
            "2026",
            "08",
            "28",
          );
          fs.mkdirSync(rolloutDir, { recursive: true });
          fs.writeFileSync(
            path.join(rolloutDir, `rollout-2026-08-28T10-00-00-${rolloutId}.jsonl`),
            `${JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "text", text: "keep going" }],
              },
            })}\n`,
          );
          world.sessions.set(
            session.id,
            new Session({ ...session, status: "failed", settledAt: now(), updatedAt: now() }),
          );

          const resumed = yield* engine.resumeSession(session.id, null);
          expect(resumed.status).toBe("running");
          // The relaunch is a NATIVE resume addressed at the live rollout's own session id.
          const liveAgent = [...world.processes.values()].find(
            (process) => process.exitedAt === null,
          );
          expect(liveAgent?.argv.slice(0, 3)).toEqual(["codex", "resume", rolloutId]);
          expect(liveAgent?.providerSessionId).toBe(rolloutId);
          // The live state became a committed capture for the crashed process.
          const manifest = JSON.parse(
            fs.readFileSync(
              path.join(
                processStatePathOf(project.storePath, session.id, processId),
                "manifest.json",
              ),
              "utf8",
            ),
          ) as { readonly providerSessionId: string | null };
          expect(manifest.providerSessionId).toBe(rolloutId);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("observes an external agent through the harness home and ends it when writes go quiet", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          // The open workbench: a shell holds the workspace; no engine agent runs.
          yield* engine.launch(session.id, ["bash"]);

          // Quiet harness home: nothing to observe.
          yield* engine.observeExternalAgents();
          const externalRows = () =>
            [...world.processes.values()].filter((process) => process.kind === "agent-external");
          expect(externalRows()).toHaveLength(0);

          // A claude run by hand inside the shell writes through the mounted harness home.
          const providerId = crypto.randomUUID();
          const projectDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "projects",
            "-workspace-repo",
          );
          fs.mkdirSync(projectDir, { recursive: true });
          const transcript = path.join(projectDir, `${providerId}.jsonl`);
          fs.writeFileSync(transcript, "{}\n");

          yield* engine.observeExternalAgents();
          expect(externalRows()).toHaveLength(1);
          const observed = externalRows()[0];
          expect(observed?.harness).toBe("claude");
          expect(observed?.providerSessionId).toBe(providerId);
          expect(observed?.exitedAt).toBeNull();
          expect(observed?.sealantSessionId).toBeNull();
          expect(world.sessions.get(session.id)?.status).toBe("running");

          // A second pass while writes stay fresh observes nothing new.
          yield* engine.observeExternalAgents();
          expect(externalRows()).toHaveLength(1);

          // Writes go quiet: the observed agent's end is recorded. The workspace is NOT
          // swept — quiet is an inference, and the agent may just sit between turns.
          const past = new Date(Date.now() - 10 * 60_000);
          fs.utimesSync(transcript, past, past);
          yield* engine.observeExternalAgents();
          expect(externalRows()[0]?.exitedAt).not.toBeNull();
          expect(stopped).toHaveLength(0);

          // The user was only thinking: a new message writes again, and the next pass
          // observes a fresh row — same conversation, session running again.
          fs.utimesSync(transcript, new Date(), new Date());
          yield* engine.observeExternalAgents();
          const revived = externalRows().filter((process) => process.exitedAt === null);
          expect(revived).toHaveLength(1);
          expect(revived[0]?.providerSessionId).toBe(providerId);
          expect(world.sessions.get(session.id)?.status).toBe("running");
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("late-observes a quiet external conversation mend never saw — captured, then ended", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          yield* engine.launch(session.id, ["bash"]);

          // A codex conversation ran and went quiet before any observer tick saw it (an
          // unreadable window, a mend restart) — the transcript is 10 minutes old.
          const rolloutId = crypto.randomUUID();
          const rolloutDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".codex",
            "sessions",
            "2026",
            "08",
            "29",
          );
          fs.mkdirSync(rolloutDir, { recursive: true });
          const rollout = path.join(rolloutDir, `rollout-2026-08-29T18-00-00-${rolloutId}.jsonl`);
          fs.writeFileSync(
            rollout,
            `${JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n`,
          );
          const past = new Date(Date.now() - 10 * 60_000);
          fs.utimesSync(rollout, past, past);

          yield* engine.observeExternalAgents();
          const observed = [...world.processes.values()].filter(
            (process) => process.kind === "agent-external",
          );
          expect(observed).toHaveLength(1);
          expect(observed[0]?.harness).toBe("codex");
          expect(observed[0]?.providerSessionId).toBe(rolloutId);
          // Late observation: the row records that it happened — already ended.
          expect(observed[0]?.exitedAt).not.toBeNull();

          // A second pass does not re-observe history.
          yield* engine.observeExternalAgents();
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-external"),
          ).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("presumes transcript writes belong to a live engine agent — nothing observed", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);

          const projectDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "projects",
            "-workspace-repo",
          );
          fs.mkdirSync(projectDir, { recursive: true });
          fs.writeFileSync(path.join(projectDir, `${crypto.randomUUID()}.jsonl`), "{}\n");

          yield* engine.observeExternalAgents();
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-external"),
          ).toHaveLength(0);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("resume fails sessions that died before the harness started", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-resume-"));
    const world = makeWorld();
    // An unsettled session with no Sealant run — the crash-before-start case.
    const orphan = new Session({
      id: SessionId.make(crypto.randomUUID()),
      projectId: ProjectId.make("proj-1"),
      worktreeId: WorktreeId.make("wt-orphan"),
      harness: "codex",
      providerSessionId: null,
      label: null,
      worktree: "session-x",
      branch: "mend/session/x",
      baseSha: Sha.make("0000000000000000000000000000000000000000"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: null,
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
      status: "running",
      summary: null,
      lastSeenSequence: 0n,
      recordHistoryComplete: false,
      startedAt: now(),
      settledAt: null,
      createdAt: now(),
      updatedAt: now(),
    });
    world.sessions.set(orphan.id, orphan);

    const storeLayer = Store.layer.pipe(
      Layer.provide(StoreConfig.layerFor(path.join(tmp, "store"))),
    );
    const engineLayer = SessionEngineLive.pipe(
      Layer.provide(
        SessionRepositoryLocalLive.pipe(
          Layer.provide(storeLayer),
          Layer.provide(projectsLayer(world)),
        ),
      ),
      Layer.provide(storeLayer),
      Layer.provide(sealantDeadLayer),
      Layer.provide(projectsLayer(world)),
      Layer.provide(sessionsLayer(world)),
      Layer.provide(sessionRunsLayer(world)),
      Layer.provide(sessionProcessesLayer(world)),
      Layer.provide(
        Layer.mergeAll(agentConversationStubLayer, protocolHostStubLayer, serviceStateLayer(world)),
      ),
      Layer.provide(serviceHostStubLayer),
      Layer.provide(sessionSocketStubLayer),
      Layer.provide(SessionChannelTokensRepoMemory),
      Layer.provide(DeploymentConfigColocated),
      Layer.provide(CaptureRuntimeOff),
      Layer.provide(mendKeysStubLayer),
      Layer.provide(
        // One merged provide: `pipe` is typed to 20 operators and this list outgrew it.
        Layer.mergeAll(
          agentBridgeStubLayer,
          gitOpsStubLayer,
          changesLayer(world),
          worktreesLayer(world),
          checkpointsLayer(world),
          referencesEmptyLayer,
          projectMountsEmptyLayer,
          projectLinksEmptyLayer,
          organizationsLayer(world),
          foldersEmptyLayer,
          projectRecipesEmptyLayer,
          hotWorkspacesEmptyLayer,
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          projectEnvironmentLayer(emptyEnvironment),
          projectSecretsLayer(emptySecrets),
          projectClusterBindingsLayer(emptyClusterBindings),
          secretCipherStubLayer,
          settingsLayer(),
          userDotfilesStubLayer,
          dotfilesStoreStubLayer,
          skillsStubLayer,
        ),
      ),
    );
    // Constructing the engine runs resume().
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SessionEngine;
      }).pipe(
        Effect.provide(engineLayer),
        Effect.ensuring(Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))),
        Effect.orDie,
      ),
    );
    const settled = world.sessions.get(orphan.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.summary).toContain("restarted before the harness started");
  });
});

describe("SessionEngine hot sessions", () => {
  /**
   * An in-memory pool with one skeleton. `claim` ignores the fingerprint — the test simulates a
   * project whose inputs still match — and `create` dies so the post-claim rewarm stops before
   * touching the platform (its worktree creation is real and harmless in the tmp store).
   */
  const hotPoolLayer = (pool: { entries: Array<HotWorkspace>; removed: Array<string> }) =>
    Layer.succeed(HotWorkspacesRepo, {
      create: () => Effect.die("not in test"),
      byId: (id) => Effect.sync(() => pool.entries.find((entry) => entry.id === id) ?? null),
      listForProject: (projectId) =>
        Effect.sync(() => pool.entries.filter((entry) => entry.projectId === projectId)),
      listAll: () => Effect.sync(() => [...pool.entries]),
      setReady: () => Effect.void,
      setBaseSha: () => Effect.void,
      setFailed: () => Effect.void,
      claim: (projectId) =>
        Effect.sync(() => {
          const index = pool.entries.findIndex(
            (entry) => entry.projectId === projectId && entry.status === "ready",
          );
          const entry = pool.entries[index];
          if (entry === undefined) return null;
          const claimed = new HotWorkspace({ ...entry, status: "claimed", updatedAt: now() });
          pool.entries[index] = claimed;
          return claimed;
        }),
      remove: (id) =>
        Effect.sync(() => {
          pool.removed.push(id);
          pool.entries = pool.entries.filter((entry) => entry.id !== id);
        }),
    });

  it("claims a ready skeleton: provision adopts its id and launch skips the create", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          // The session adopted the skeleton's id, and brought a worktree of its own.
          expect(session.id).toBe(skeletonId);
          expect(session.worktree).toMatch(/^wt-/);
          expect(session.branch).toBe(`mend/wt/${session.worktreeId}`);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("claims a ready skeleton for a new conversation inside an existing worktree too", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          // The worktree already exists (a durable place, or one holding other sessions): the
          // worktree-scoped verb — "s session here", the web's new conversation — claims too.
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "shared-place", base: null },
            "user-fixture",
          );
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).toBe(skeletonId);
          expect(session.worktreeId).toBe(place.id);
          expect(session.worktree).toBe(place.directory);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });
});

/**
 * What an executor ships in these worlds: a capture whose workspace class carries the codex
 * rollout under `harness/`, registered under the epoch Mend claimed at launch. Packs and
 * manifests follow ADR-0015's rules through the same writer the store tests prove.
 */
const shipHarnessCapture = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  epoch: number,
  rolloutId: string,
) =>
  Effect.gen(function* () {
    const chain = memory.chains.get(worktreeId);
    const head = chain?.headCapture === null || chain === undefined ? null : chain.headCapture;
    const parent = head === null ? null : (memory.captures.get(head) ?? null);
    const tree = path.join(tmp, `ship-${epoch}`);
    const rolloutDir = path.join(tree, "harness", ".codex", "sessions", "2026", "09", "12");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolloutDir, `rollout-2026-09-12T10-00-00-${rolloutId}.jsonl`),
      `${JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "text", text: "go on" }] },
      })}\n`,
    );
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const built = buildManifest({
      worktreeId,
      n: (parent?.n ?? -1) + 1,
      parent: parent?.id ?? null,
      epoch,
      seq: 100,
      kind: "turn",
      git: {
        packs: parent === null ? [] : (parent.sections as { git: { packs: string[] } }).git.packs,
        refs: {},
        head: "refs/heads/main",
        fsck: "verified",
      },
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );
    const repo = yield* CaptureStoreRepo;
    yield* repo.register({
      worktreeId,
      id: built.id,
      n: built.manifest.n,
      parent: built.manifest.parent,
      epoch,
      seq: 100n,
      kind: "turn",
      manifestKey: built.key,
      sections: built.manifest.sections,
      gitFsck: "verified",
    });
    return built;
  }).pipe(Effect.provide(memory.layer));

/** Map the public executor path selected on the capture source into this test executor's root. */
const configuredHarnessHomePath = (options: CreateOptions, executorRoot: string): string => {
  const source = options.source;
  if (source?.kind !== "capture" || source.harnessHome === undefined) {
    throw new Error("capture source did not select a harness root");
  }
  if (!path.isAbsolute(source.harnessHome)) {
    throw new Error("capture source selected a relative harness root");
  }
  return path.join(executorRoot, source.harnessHome.slice(1));
};

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

/** Snapshot only the actual daemon-selected root, including daemon credential exclusions. */
const shipCapturedHarnessHome = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  epoch: number,
  options: CreateOptions,
  executorRoot: string,
) =>
  Effect.gen(function* () {
    const chain = memory.chains.get(worktreeId);
    const head = chain?.headCapture === null || chain === undefined ? null : chain.headCapture;
    const parent = head === null ? null : (memory.captures.get(head) ?? null);
    const tree = path.join(tmp, `ship-harness-home-${epoch}`);
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(tree, { recursive: true });
    fs.cpSync(configuredHarnessHomePath(options, executorRoot), path.join(tree, "harness"), {
      recursive: true,
    });
    fs.rmSync(path.join(tree, "harness", ".codex", "auth.json"), { force: true });
    fs.rmSync(path.join(tree, "harness", ".claude", ".credentials.json"), { force: true });
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const previousGit: GitSection =
      parent === null
        ? { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" }
        : (yield* decodeManifest(
            parent.manifestKey,
            new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", parent.manifestKey))),
          ).pipe(Effect.orDie)).sections.git;
    const built = buildManifest({
      worktreeId,
      n: (parent?.n ?? -1) + 1,
      parent: parent?.id ?? null,
      epoch,
      seq: 100,
      kind: "final",
      git: previousGit,
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );
    const repo = yield* CaptureStoreRepo;
    yield* repo.register({
      worktreeId,
      id: built.id,
      n: built.manifest.n,
      parent: built.manifest.parent,
      epoch,
      seq: 100n,
      kind: "final",
      manifestKey: built.key,
      sections: built.manifest.sections,
      gitFsck: "verified",
    });
    return built;
  }).pipe(Effect.provide(memory.layer));

/** Poll a forked side effect (a warm, a replacement) into view; the pool fakes are in memory. */
const until = (condition: () => boolean, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500 && !condition(); i++) yield* Effect.sleep(Duration.millis(10));
    if (!condition()) throw new Error(`timed out waiting for ${label}`);
  });

const verifyDeferredFinalHarvest = async (pathKind: "stop" | "handoff" | "sweep") => {
  const created: Array<CreateOptions> = [];
  const spawned: ReadonlyArray<string>[] = [];
  const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
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
        const flushThatShips = pathKind === "handoff" ? 1 : 2;

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
      }),
    {
      captured: memory,
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
          },
          flush: () => {
            flushes += 1;
            const flushThatShips = pathKind === "handoff" ? 1 : 2;
            return Effect.gen(function* () {
              if (flushes === flushThatShips && !shipped) {
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
              } satisfies WorkspaceCaptureStatus;
            });
          },
        },
      ),
    },
  );
};

describe("SessionEngine capture mode", () => {
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

            // The checkpoint flush observes no new capture. The process-end barrier must request a
            // second flush, then wait for that final registration before harvest reads the head.
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
                  if (flushes > 1 && !shipped) {
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
                  } satisfies WorkspaceCaptureStatus;
                }),
            },
          ),
        },
      );
    },
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

          // A user stop is a planned stop: the user mark, the post-process harvest barrier, and
          // the stop itself each flush before the workspace goes.
          yield* engine.stop(session.id);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
          expect(events).toEqual([
            "flush:workspace-1",
            "flush:workspace-1",
            "flush:workspace-1",
            "workspace-1",
          ]);
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
              autoSuggest: "inherit",
              backgroundSessions: "inherit",
              gitAuthMode: "ambient",
              workspaceImage: null,
              applyDotfiles: true,
              inheritUserSkills: true,
              hotSessions: 0,
              installCommand: null,
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
              yield* until(() => stopped.includes("workspace-1"), "failed-flush workspace stop");

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
                      Effect.as({
                        epoch: 2,
                        worktreeId: "",
                        pending: 0,
                        stagedBytes: 0,
                        uploadedObjects: 0,
                        uploadedBytes: 0,
                        registered: 1,
                        fenced: false,
                        paused: false,
                      }),
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
          expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
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

  /**
   * An in-memory pool with a working `create`: the reconcile warms real standbys here (their
   * capture source lands in `created`), and a claim pops a ready entry whose fingerprint the
   * engine computed from the same inputs.
   */
  const memoryHotPool = () => {
    const entries: Array<HotWorkspace> = [];
    const update = (id: string, patch: Partial<HotWorkspace>) =>
      Effect.sync(() => {
        const index = entries.findIndex((entry) => entry.id === id);
        const current = entries[index];
        if (current !== undefined) {
          entries[index] = new HotWorkspace({ ...current, ...patch, updatedAt: now() });
        }
      });
    const layer = Layer.succeed(HotWorkspacesRepo, {
      create: (input) =>
        Effect.sync(() => {
          const entry = new HotWorkspace({
            ...input,
            status: "warming",
            error: null,
            sealantWorkspaceId: null,
            workspaceImage: null,
            dotfiles: null,
            environment: null,
            referenceMounts: [],
            extraMounts: [],
            createdAt: now(),
            updatedAt: now(),
          });
          entries.push(entry);
          return entry;
        }),
      byId: (id) => Effect.sync(() => entries.find((entry) => entry.id === id) ?? null),
      listForProject: (projectId) =>
        Effect.sync(() => entries.filter((entry) => entry.projectId === projectId)),
      listAll: () => Effect.sync(() => [...entries]),
      setReady: (id, stamps) => update(id, { ...stamps, status: "ready", error: null }),
      setBaseSha: (id, baseSha) => update(id, { baseSha }),
      setFailed: (id, error) => update(id, { status: "failed", error }),
      claim: (projectId, fingerprint, ownerUserId) =>
        Effect.sync(() => {
          const index = entries.findIndex(
            (entry) =>
              entry.projectId === projectId &&
              entry.status === "ready" &&
              entry.fingerprint === fingerprint &&
              entry.ownerUserId === ownerUserId,
          );
          const entry = entries[index];
          if (entry === undefined) return null;
          const claimed = new HotWorkspace({ ...entry, status: "claimed", updatedAt: now() });
          entries[index] = claimed;
          return claimed;
        }),
      remove: (id) =>
        Effect.sync(() => {
          const index = entries.findIndex((entry) => entry.id === id);
          if (index >= 0) entries.splice(index, 1);
        }),
    });
    return { entries, layer };
  };

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

  it("keeps the pool per owner: one standby for each recent owner who may run here, never for anyone else, and another owner's session goes cold", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          world.members.set("user-teammate", "member");
          world.members.set("user-late", "member");
          // user-gone ran sessions here but is no longer a member of the organization.
          world.recentOwners = ["user-teammate", "user-gone", "user-fixture"];
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => pool.entries.filter((entry) => entry.status === "ready").length === 2,
            "a standby per eligible owner",
          );
          expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
            "user-fixture",
            "user-teammate",
          ]);
          expect(created).toHaveLength(2);

          // An owner with no standby of their own is served cold; nobody else's is spent.
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-late",
            base: null,
          });
          expect(pool.entries.map((entry) => entry.id)).not.toContain(session.id);
          expect(pool.entries.every((entry) => entry.status === "ready")).toBe(true);

          // Losing access drains that owner's standby on the next pass.
          world.members.delete("user-teammate");
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => pool.entries.every((entry) => entry.ownerUserId !== "user-teammate"),
            "the former member's standby to drain",
          );
          expect(pool.entries.map((entry) => entry.ownerUserId)).toEqual(["user-fixture"]);
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
      },
    );
  });

  it("a session with no owner launches as nobody: it settles failed before any platform call", async () => {
    const created: Array<CreateOptions> = [];
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
            ownerUserId: null,
            base: null,
          });
          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(failure._tag === "SealantPlatformError" ? failure.code : failure._tag).toBe(
            "NO_PRINCIPAL",
          );
          expect(created).toHaveLength(0);
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("a worktree claims the standby: the session adopts its id, the lease is taken at a fresh epoch with the executor as holder, the launch re-plans it onto the worktree, its first register parents on capture 0, a fresh standby warms, a second worktree claims that one, and a join goes cold", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const flushed: string[] = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    /** What sealantd's `capture.replan` does: `plan.get` with no worktree named, as the executor. */
    const replans: Array<{ readonly workspaceId: string; readonly executorId: SessionId }> = [];
    const answered: Array<{
      readonly worktreeId: string;
      readonly epoch: number;
      readonly headN: number | null;
    }> = [];
    let executor: SessionId | null = null;
    const replan = (workspace: Workspace) =>
      Effect.gen(function* () {
        if (executor === null) throw new Error("no executor to replan");
        replans.push({ workspaceId: workspace.id, executorId: executor });
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
        answered.push({
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          headN: plan.head?.n ?? null,
        });
        return {
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          ...(plan.head === null
            ? {}
            : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
          filesWritten: 0,
          bytesWritten: 0,
          filesSkipped: 1,
          bytesSkipped: 14,
          removed: 0,
          unchanged: false,
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
          const alias = `standby-${standby.id}`;

          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          // The session adopted the standby's id; the worktree's lease is a FRESH epoch (capture
          // 0 went in under Mend's epoch 1) held by the executor, at the launch claim's TTL.
          expect(session.id).toBe(standby.id);
          const lease = memory.leases.get(session.worktreeId);
          expect(lease?.executorId).toBe(session.id);
          expect(lease?.epoch).toBe(2);
          expect((lease?.expiresAt ?? 0) - memory.clock.now()).toBeGreaterThan(60_000);
          expect(memory.chains.get(session.worktreeId)?.headN).toBe(0);
          const cap0 = memory.chains.get(session.worktreeId)?.headCapture ?? null;
          // No replan yet: the claim only takes the lease; the launch re-plans.
          expect(replans).toEqual([]);

          executor = session.id;
          yield* engine.launch(session.id, ["codex"]);
          // The standby's workspace was adopted, not created again, and re-planned exactly once:
          // the channel answered the claimed worktree, the claim's epoch and the head (capture 0).
          expect(spawned.length).toBeGreaterThan(0);
          expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
          expect(replans).toEqual([{ workspaceId: "workspace-1", executorId: session.id }]);
          expect(answered).toEqual([{ worktreeId: session.worktreeId, epoch: 2, headN: 0 }]);
          const epoch = 2;

          // The executor names its worktree from now on; the placeholder is refused.
          const api = servedSocketApis.get(session.id)?.capture;
          if (api === undefined) throw new Error("the session serves no capture api");
          const beat = yield* api.heartbeat({ worktree_id: session.worktreeId, epoch });
          expect(beat).toEqual({ expires_in_secs: 30 });
          const renewedIn =
            (memory.leases.get(session.worktreeId)?.expiresAt ?? 0) - memory.clock.now();
          expect(renewedIn).toBeGreaterThan(25_000);
          expect(renewedIn).toBeLessThanOrEqual(30_000);
          const refused = yield* api.heartbeat({ worktree_id: alias, epoch }).pipe(Effect.flip);
          expect(refused.reason).toBe("wrong-worktree");

          // A checkpoint asks the lease holder to flush before it observes the head.
          yield* engine.checkpointNow(session.id, "user-mark");
          expect(flushed).toEqual(["flush:workspace-1"]);

          // …and its first register parents on capture 0 — the head the replan handed it.
          const tree = path.join(tmp, "standby-ship");
          fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
          fs.writeFileSync(path.join(tree, "tree", "edit.txt"), "from the standby\n");
          const keys = captureKeys(session.worktreeId, epoch);
          const snapshot = snapshotDirectory(tree, keys, { chunkSize: 64 });
          const built = buildManifest({
            worktreeId: session.worktreeId,
            n: 1,
            parent: cap0,
            epoch,
            seq: 5,
            kind: "turn",
            git: {
              packs: [],
              refs: {},
              head: "refs/heads/main",
              fsck: "verified",
            },
            workspace: { root: snapshot.root, packs: snapshot.packs },
          });
          yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
            Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
          );
          const registered = yield* api.register({
            worktree_id: session.worktreeId,
            epoch,
            n: 1,
            parent: cap0,
            capture_id: built.id,
            manifest_key: built.key,
            manifest: built.manifest,
          });
          expect(registered.head_n).toBe(1);
          expect(memory.captures.get(built.id)?.parent).toBe(cap0);
          expect(memory.captures.get(built.id)?.worktreeId).toBe(session.worktreeId);

          // A fresh standby warms behind the claim…
          yield* until(
            () => pool.entries.some((entry) => entry.status === "ready" && entry.id !== standby.id),
            "the replacement standby",
          );
          const replacement = pool.entries.find((entry) => entry.status === "ready");
          if (replacement === undefined) throw new Error("no replacement standby");
          expect(replacement.id).not.toBe(standby.id);
          expect(created.filter((request) => request.source?.kind === "capture")).toHaveLength(2);

          // …and a second worktree claims it the same way: its own lease, at its own fresh epoch.
          const second = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "second",
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(second.id).toBe(replacement.id);
          expect(second.worktreeId).not.toBe(session.worktreeId);
          expect(memory.leases.get(second.worktreeId)?.executorId).toBe(second.id);
          expect(memory.leases.get(second.worktreeId)?.epoch).toBe(2);

          // A join into a worktree whose executor holds the lease runs inside the holder: cold,
          // and no standby is spent on it.
          const joined = yield* engine.provisionSessionIn(session.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(pool.entries.find((entry) => entry.id === joined.id)).toBeUndefined();
          expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
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
          { flushed, replan },
        ),
        hotWorkspacesLayer: pool.layer,
      },
    );
  });
  it(
    "user marks never collide on the worktree's checkpoint ordinal: the executor's checkpoint capture is taken when it carries the ordinal, a stale one is observed and not taken, and concurrent marks allocate distinct ordinals through one writer",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const flushed: string[] = [];
      const memory = makeMemoryCaptureStore();
      /** What the executor ships inside its next flush: nothing, or a checkpoint capture. */
      let onFlush: Effect.Effect<void> = Effect.void;
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
            const worktreeId = session.worktreeId;
            const epoch = memory.leases.get(worktreeId)?.epoch ?? 0;
            expect(memory.leases.get(worktreeId)?.executorId).toBe(session.id);
            const api = servedSocketApis.get(session.id)?.capture;
            if (api === undefined) throw new Error("the session serves no capture api");
            const chain = () => world.checkpoints.filter((c) => c.worktreeId === worktreeId);
            const headOf = () => memory.chains.get(worktreeId)?.headCapture ?? null;
            const cap0 = headOf();
            if (cap0 === null) throw new Error("no capture 0");
            // The executor's captures carry capture 0's git section: the base pack and the
            // worktree tree the runner derives from.
            const cap0Key = memory.captures.get(cap0)?.manifestKey ?? "";
            const cap0Manifest = yield* decodeManifest(
              cap0Key,
              new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", cap0Key))),
            ).pipe(Effect.orDie);
            const registerCheckpointCapture = (ordinal: number) =>
              Effect.gen(function* () {
                const parent = headOf();
                const n = (memory.chains.get(worktreeId)?.headN ?? 0) + 1;
                const built = buildManifest({
                  worktreeId,
                  n,
                  parent,
                  epoch,
                  seq: n * 10,
                  kind: "checkpoint",
                  git: cap0Manifest.sections.git,
                  checkpoint: {
                    ordinal,
                    sha: session.baseSha,
                    ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
                  },
                });
                yield* uploadObjects(new Map([[built.key, built.bytes]])).pipe(
                  Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
                );
                yield* api.register({
                  worktree_id: worktreeId,
                  epoch,
                  n,
                  parent,
                  capture_id: built.id,
                  manifest_key: built.key,
                  manifest: built.manifest,
                });
                return built.id;
              });

            // Ordering 1 — the executor's flush registers a `checkpoint` capture carrying the
            // ordinal the mark is about to allocate: the mark takes it, one row, no derive.
            let shipped: string | null = null;
            onFlush = registerCheckpointCapture(chain().length).pipe(
              Effect.map((id) => {
                shipped = id;
              }),
              Effect.orDie,
            );
            const taken = yield* engine.checkpointNow(session.id, "user-mark");
            expect(flushed).toEqual(["flush:workspace-1"]);
            expect(taken.ordinal).toBe(2);
            expect(taken.sha).toBe(session.baseSha);
            expect(taken.ref).toBe(`refs/mend/checkpoints/${worktreeId}/2`);
            expect(world.checkpointCaptureIds.get(taken.id)).toBe(shipped);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2]);

            // Ordering 2 — the executor's checkpoint capture lands AFTER the mark that used the
            // ordinal it names (a stale 2): the next mark is observed from it but allocates 3,
            // derived on the runner, never a second row at 2.
            onFlush = Effect.void;
            const stale = yield* registerCheckpointCapture(2);
            const next = yield* engine.checkpointNow(session.id, "user-mark");
            expect(next.ordinal).toBe(3);
            expect(next.ref).toBe(`refs/mend/checkpoints/${worktreeId}/3`);
            expect(next.sha).not.toBe(session.baseSha);
            expect(world.checkpointCaptureIds.get(next.id)).toBe(stale);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);

            // The race — a user mark while the run-end checkpoint is in flight (observed in the
            // packaged acceptance as a 500): both succeed with distinct ordinals, and the
            // per-worktree writer means the unique index never had to refuse an insert.
            const [a, b] = yield* Effect.all(
              [
                engine.checkpointNow(session.id, "user-mark"),
                engine.checkpointNow(session.id, "turn-boundary"),
              ],
              { concurrency: "unbounded" },
            );
            expect([a.ordinal, b.ordinal].toSorted()).toEqual([4, 5]);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
            expect(world.checkpointConflicts.count).toBe(0);
            expect(flushed).toHaveLength(4);
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
              flushed,
              flush: () =>
                onFlush.pipe(
                  Effect.map(() => ({
                    epoch: 0,
                    worktreeId: "",
                    pending: 0,
                    stagedBytes: 0,
                    uploadedObjects: 0,
                    uploadedBytes: 0,
                    registered: 1,
                    fenced: false,
                    paused: false,
                  })),
                ),
            },
          ),
        },
      );
    },
  );
});
