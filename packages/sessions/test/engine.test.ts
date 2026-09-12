import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentConversationRepo,
  CaptureStoreRepo,
  CheckpointsRepo,
  HotWorkspacesRepo,
  ProjectNotFoundError,
  ProjectEnvironmentRepo,
  ProjectMountNotFoundError,
  ProjectClusterBindingsRepo,
  ProjectMountsRepo,
  ProjectLinksRepo,
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
import { type CaptureCreateOptions, SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  CaptureChannelLive,
  CaptureRuntimeLive,
  CaptureRuntimeOff,
  CaptureUploadPolicyDefault,
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
  GitOpsRunnerLive,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
  DeploymentConfigLocal,
  harnessHomePathOf,
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
} from "@sealant/sdk";
import { Duration, Effect, Fiber, Layer, Schedule, Stream, type Scope } from "effect";

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
  created: Array<CreateOptions | CaptureCreateOptions>,
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
    options: CreateOptions | CaptureCreateOptions,
  ) => Effect.Effect<Workspace, SealantPlatformError>,
  /** When provided, workspace execs succeed (exit 0, empty output) and land here. */
  execCalls?: ReadonlyArray<string>[],
  /** Every `bindWorkspace` subpath, so a test can assert capture mode binds nothing. */
  binds?: string[],
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
        if (createWorkspaceOverride !== undefined) {
          return createWorkspaceOverride(options);
        }
        return rejectCredentials(options.credentials)
          ? Effect.fail(
              new SealantPlatformError({
                code: "connected-account-not-found",
                status: 400,
                message: "connected account was not found",
                cause: null,
              }),
            )
          : Effect.succeed(workspace);
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
        spawned?.push(argv);
        if (options !== undefined) openedOptions?.push(options);
        return openPty(options?.mode ?? "pty");
      }),
    forward: () => Effect.die("not in test"),
    stopWorkspace: (target) =>
      Effect.sync(() => {
        stopped?.push(target.id);
      }),
    expireWorkspace: renewWorkspace,
    getSession: (_workspace, id) => Effect.succeed(ptys.get(id) ?? initialPty),
    // Typed failure, not a defect: the settle-path harvest must degrade
    // quietly and still reach the workspace reap.
    exec:
      execCalls === undefined
        ? () =>
            Effect.fail(
              new SealantPlatformError({
                code: "exec-not-in-test",
                status: null,
                message: "exec not available in this test world",
                cause: null,
              }),
            )
        : (_workspace, argv) =>
            Effect.sync(() => {
              execCalls.push(argv);
              return { exitCode: 0, stdout: "", stderr: "", run: fakeExecRun };
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
  firstUserId: () => Effect.succeed<string | null>("user-fixture"),
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
  /** Keyed by worktree id. */
  readonly worktrees: Map<string, Worktree>;
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
  worktrees: new Map(),
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

/** No linked projects in these worlds. */
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
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  setHead: () => Effect.void,
  listForProject: () => Effect.succeed([]),
  setForProject: () => Effect.void,
});

const projectsLayer = (world: World) =>
  Layer.succeed(ProjectsRepo, {
    create: () => Effect.die("not in test"),
    setGitAuthMode: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setApplyDotfiles: () => Effect.die("not in test"),
    setInheritUserSkills: () => Effect.die("not in test"),
    setHotSessions: () => Effect.die("not in test"),
    byId: (id) => {
      const found = world.projects.get(id);
      return found === undefined
        ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
        : Effect.succeed(found);
    },
    byName: () => Effect.succeed(null),
    list: () => Effect.succeed([...world.projects.values()]),
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
    listSettledUnclassified: () => Effect.succeed([]),
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
    create: (input: NewCheckpoint) =>
      Effect.sync(() => {
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
        return checkpoint;
      }),
    byId: (id) =>
      Effect.succeed(world.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null),
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
    readonly prepareWorld?: (world: World) => void;
    /** Capture mode (ADR-0002): the pointer store the test inspects; the bucket is `<tmp>/blobs`. */
    readonly captured?: MemoryCaptureStore;
  } = {},
): Promise<A> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-test-"));
  const world = makeWorld();
  options.prepareWorld?.(world);
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
      ? DeploymentConfigLocal
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
      Effect.ensuring(Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))),
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
          ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
              ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
          ownerUserId: null,
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
          ownerUserId: null,
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        expect(first.branch).toBe("mend/fix-auth");
        expect(first.worktree).toBe("fix-auth");

        const second = yield* engine.provision({
          name: "fix-auth",
          ownerUserId: null,
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
            ownerUserId: null,
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
          ownerUserId: null,
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
          ownerUserId: null,
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
          ownerUserId: null,
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
          ownerUserId: null,
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
          ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
            ownerUserId: null,
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
      ownerUserId: null,
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
      Layer.provide(DeploymentConfigLocal),
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

describe("SessionEngine capture mode", () => {
  it("provisions capture 0 and launches a capture-sourced workspace: no mounts, no bind, a launch-claimed lease", async () => {
    const created: Array<CreateOptions | CaptureCreateOptions> = [];
    const binds: string[] = [];
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
            ownerUserId: null,
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
          expect(request?.source).toEqual({
            kind: "capture",
            endpoint: "http://mend.test:3106",
            worktreeId: session.worktreeId,
          });
          expect(request !== undefined && "captureToken" in request).toBe(true);
          expect(request !== undefined && "mounts" in request).toBe(false);
          expect(binds).toEqual([]);
          const lease = memory.leases.get(session.worktreeId);
          expect(lease?.executorId).toBe(session.id);
          expect(lease?.epoch).toBe(2);
          expect((lease?.expiresAt ?? 0) > memory.clock.now()).toBe(true);
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
          binds,
        ),
      },
    );
  });

  it(
    "a second session in a leased worktree joins the holder's executor; an unreachable holder is refused with worktree_leased",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions | CaptureCreateOptions> = [];
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
              ownerUserId: null,
              base: null,
            });
            yield* engine.launch(first.id, ["codex"]);
            expect(created).toHaveLength(1);

            const second = yield* engine.provisionSessionIn(first.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: null,
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
              ownerUserId: null,
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

  it("resume is lease-aware: a live lease attaches; an expired lease with a dead executor is a pickup that harvests from the head capture", async () => {
    const created: Array<CreateOptions | CaptureCreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
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
            ownerUserId: null,
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
        ),
      },
    );
  });

  it("the reaper settles a session whose executor died: lease expired, platform silent — 'executor lost'", async () => {
    const created: Array<CreateOptions | CaptureCreateOptions> = [];
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
            ownerUserId: null,
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

  it("never claims a hot skeleton in capture mode — a project's hot target is observed and skipped", async () => {
    const created: Array<CreateOptions | CaptureCreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 2 }));
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: null,
            base: null,
          });
          expect(world.sessions.get(session.id)).toBeDefined();
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: Layer.succeed(HotWorkspacesRepo, {
          create: () => Effect.die("must not warm in capture mode"),
          byId: () => Effect.succeed(null),
          listForProject: () => Effect.succeed([]),
          listAll: () => Effect.succeed([]),
          setReady: () => Effect.void,
          setFailed: () => Effect.void,
          claim: () => Effect.die("must not claim in capture mode"),
          remove: () => Effect.void,
        }),
      },
    );
  });
});
