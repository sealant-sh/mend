import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
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
  UserGitAuthorRepo,
  type GitAccessMode,
  type CaptureObservation,
  type ExecutorCaptureAnswer,
  InstanceRolesRepo,
  UserGitAccessRepo,
  type NewCheckpoint,
  type NewSession,
  type NewSessionProcess,
  type NewSessionRun,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
  WorktreeNotFoundError,
  type ExecutorCaptureEvidence,
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
  ResolvedGitAuthor,
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
  captureAnswerReplaces,
  withUnsavedAnswer,
  type CapturePosition,
  captureDiscardAuditData,
  captureStatusLine,
  executorEndOf,
} from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  SealantPlatformError,
  type WorkspaceByKey,
  type WorkspaceCreateFence,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import {
  CaptureChannelLive,
  CaptureDrainPolicy,
  type CaptureDrainPolicyShape,
  CaptureGitVerifierOff,
  CaptureRemotesOff,
  CaptureSourcesOff,
  CaptureRuntimeLive,
  type CaptureCompletionSeal,
  CaptureSeals,
  CaptureSealsNone,
  captureHoldWords,
  CaptureRuntimeOff,
  CaptureUploadPolicyDefault,
  DotfilesCloner,
  makeDotfilesClonerLayer,
  HARNESS_HOME_MOUNT_PATH,
  HarnessStateNotFoundError,
  LegacyBenchReadOnlyError,
  ProtocolHost,
  ServiceHost,
  SessionEngine,
  SessionEngineLive,
  SessionRepositoryCapturedLive,
  SessionRepositoryLocalLive,
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  SessionNotLiveError,
  type SessionSocketApi,
  SessionSocketHost,
  WORKSPACE_MEND_TOML,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
} from "@mend/sessions";
import {
  AgentBridge,
  BlobStoreFsLive,
  type CaptureKind,
  captureKeys,
  DeploymentConfig,
  type ExecutorTransport,
  DotfilesStore,
  DotfilesStoreError,
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
  makeSourcePolicy,
  SourcePolicy,
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
  WorkspaceStatus,
} from "@sealant/sdk";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Schedule,
  Stream,
  type Scope,
} from "effect";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { memoryStoreRefs } from "./capture-world.ts";

/** What a daemon that reports snapshot health says when every path read (sealantd `Some(0)`). */
const readEverything: object = { unreadable: 0, carried: 0 };

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
  captureStatus: () => Effect.succeed(null),
  runtimeDeadline: () => Effect.succeed(null),
  runtimeResourceId: () => Effect.succeed(null),
  findWorkspaceByKey: () => Effect.succeed({ kind: "unsupported" as const }),
  fenceWorkspaceCreate: () => Effect.succeed({ kind: "unsupported" as const }),
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
    // Launches read what the project inherits (its organization's defaults over the instance's),
    // never the instance document alone.
    get: () => Effect.die("a launch read the instance settings instead of its organization's"),
    forOrganization: () => Effect.succeed(new MendSettings({ ...defaultSettings, workspaceImage })),
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
    /** Every stop asked of the platform: a plain one (`drain`) or the owner's `discard`. */
    readonly stops?: Array<"drain" | "discard">;
    /** Every stop's options as Mend sent them (a discard, the store's completion attestation). */
    readonly stopOptions?: Array<WorkspaceStopOptions | undefined>;
    /** What the platform answers a stop, given whether it discards; `requested` by default. */
    readonly stopAnswer?: (discard: boolean) => "stopped" | "draining" | "kept" | "requested";
    /** Every flush's kind, in order (`suspend` · `final`). */
    readonly flushKinds?: CaptureFlushKind[];
    /**
     * How the stand-in daemon answers a final flush: `reported` (the default) says `complete`
     * — true once nothing is pending — as the quiescing sealantd does; `unreported` answers
     * without it, as SDK 0.37.2 does today.
     */
    readonly finalCompletion?: "reported" | "unreported";
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
    /**
     * `workspaces.findByIdempotencyKey` (Core's next SDK); absent answers `unsupported`, as the
     * 0.37.2 seam does.
     */
    readonly findByKey?: (key: string) => WorkspaceByKey;
    /** What Core's create fence answers for a key (`fenceWorkspaceCreate`); unsupported unless said. */
    readonly fenceCreate?: (key: string) => WorkspaceCreateFence;
    /** Every create's idempotency key, as Mend sent it (`undefined`: none). */
    readonly createKeys?: Array<string | undefined>;
    /** Every create's launch identity, as Mend sent it (`undefined`: none). */
    readonly createLaunches?: Array<string | undefined>;
    /** While true, a create's answer is lost (503) as if the control plane never answered. */
    readonly loseCreateAnswer?: () => boolean;
    /** `launch.runtime.resourceId` / `runtime()` (Core's next SDK); absent answers null, as on 0.37.2. */
    readonly resourceId?: () => string | null;
    /** Core keeps the executor for recovery (`drain.retained` on the stop's answer). */
    readonly retained?: () => {
      readonly reason: string | null;
      readonly recoverable: boolean | null;
    } | null;
    /** What Core says of a completion attestation; `accepted` by default. */
    readonly completionOutcome?: "accepted" | "ignored";
    /** `workspace.runtimeDeadline()` (Core's next SDK); absent answers null, as 0.37.2's seam does. */
    readonly runtimeDeadline?: () => Date | null;
    /** While true, opening the harness's PTY fails the way the platform refuses one. */
    readonly openFails?: () => boolean;
    /** Stands in for the executor's flush itself — what it ships and registers before answering. */
    readonly flush?: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceCaptureStatus, SealantPlatformError>;
    /**
     * Stands in for `capture.status()` (Core's next SDK); absent answers null, as SDK 0.37.2's
     * seam does.
     */
    readonly captureStatus?: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceCaptureStatus | null, SealantPlatformError>;
    readonly replan?: (
      workspace: Workspace,
    ) => Effect.Effect<WorkspaceCaptureReplanned, SealantPlatformError>;
    /** While true, every workspace lookup fails the way an unreachable Core does (503). */
    readonly unreachablePlatform?: () => boolean;
    /** What the platform reports of the workspace, given whether a stop was asked of it. */
    readonly status?: (stopAsked: boolean) => WorkspaceStatus | undefined;
    /**
     * Stands in for a command inside the executor: an answer here wins over the defaults below
     * (undefined falls through), so a test can put files where only the workspace has them.
     */
    readonly exec?: (
      argv: ReadonlyArray<string>,
    ) =>
      | { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
      | undefined;
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
  /** Stopped until the next create: the platform reports what it terminated. */
  let terminated = false;
  const workspace: Workspace = {
    id: "workspace-1",
    name: "test workspace",
    status: async () => captureOps?.status?.(terminated) ?? (terminated ? "stopped" : "ready"),
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
    createWorkspace: (options, launch) =>
      Effect.suspend(() => {
        created.push(options);
        captureOps?.createKeys?.push(launch?.idempotencyKey);
        captureOps?.createLaunches?.push(launch?.launchId);
        terminated = false;
        const beforeCreate = captureOps?.beforeCreate?.(options) ?? Effect.void;
        if (captureOps?.loseCreateAnswer?.() === true) {
          return beforeCreate.pipe(
            Effect.andThen(
              Effect.fail(
                new SealantPlatformError({
                  code: "control_plane_unavailable",
                  status: 503,
                  message: "the control plane did not answer",
                  cause: null,
                }),
              ),
            ),
          );
        }
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
    // A rejected lookup is the platform positively saying the workspace is gone (404): what a
    // dead executor reads as. A Core that does not answer at all is `unreachablePlatform` below.
    getWorkspace: () =>
      rejectWorkspaceLookup()
        ? Effect.fail(
            new SealantPlatformError({
              code: "WorkspaceNotFoundError",
              status: 404,
              message: "workspace not found",
              cause: null,
            }),
          )
        : captureOps?.unreachablePlatform?.() === true
          ? Effect.fail(
              new SealantPlatformError({
                code: "control_plane_unavailable",
                status: 503,
                message: "the control plane did not answer",
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
      captureOps?.openFails?.() === true
        ? Effect.fail(
            new SealantPlatformError({
              code: "session_open_failed",
              status: 500,
              message: "the platform did not open the session",
              cause: null,
            }),
          )
        : Effect.sync(() => {
            captureOps?.beforeOpen?.(argv);
            spawned?.push(argv);
            if (options !== undefined) openedOptions?.push(options);
            return openPty(options?.mode ?? "pty");
          }),
    forward: () => Effect.die("not in test"),
    stopWorkspace: (target, options) =>
      Effect.sync(() => {
        stopped?.push(target.id);
        captureOps?.stops?.push(options?.discardUnsaved === true ? "discard" : "drain");
        captureOps?.stopOptions?.push(options);
        const answer = captureOps?.stopAnswer?.(options?.discardUnsaved === true) ?? "requested";
        // A platform that keeps the workspace (its drain did not move) terminates nothing.
        if (target.id === workspace.id && answer !== "kept") terminated = true;
        // SDK 0.37.2: the stop is accepted and nothing more is said; the status says the rest.
        const retained = captureOps?.retained?.() ?? null;
        return {
          state: answer,
          retained,
          completion:
            options?.completion === undefined
              ? null
              : { outcome: captureOps?.completionOutcome ?? "accepted", detail: null },
        };
      }),
    captureFlush: (target, kind) =>
      Effect.gen(function* () {
        captureOps?.flushed?.push(`flush:${target.id}`);
        captureOps?.flushKinds?.push(kind);
        const answer: WorkspaceCaptureStatus =
          captureOps?.flush !== undefined
            ? yield* captureOps.flush(target)
            : {
                epoch: 0,
                worktreeId: "",
                pending: 0,
                stagedBytes: 0,
                uploadedObjects: 0,
                uploadedBytes: 0,
                registered: 0,
                fenced: false,
                paused: false,
                ...readEverything,
              };
        if (kind !== "final" || captureOps?.finalCompletion === "unreported") return answer;
        return { ...answer, ...finalCompletionOf(answer) };
      }),
    captureStatus: (target) =>
      captureOps?.captureStatus === undefined
        ? Effect.succeed(null)
        : captureOps.captureStatus(target),
    runtimeDeadline: () => Effect.sync(() => captureOps?.runtimeDeadline?.() ?? null),
    runtimeResourceId: () => Effect.sync(() => captureOps?.resourceId?.() ?? null),
    findWorkspaceByKey: (key) =>
      Effect.sync(() => captureOps?.findByKey?.(key) ?? { kind: "unsupported" as const }),
    fenceWorkspaceCreate: (key) =>
      Effect.sync(() => captureOps?.fenceCreate?.(key) ?? { kind: "unsupported" as const }),
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
        const answered = captureOps?.exec?.(argv);
        if (answered !== undefined) return Effect.succeed({ ...answered, run: fakeExecRun });
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

/**
 * What the quiescing sealantd adds to a final flush's answer (fields SDK 0.37.2 does not type):
 * complete once nothing is pending and nobody fenced it, else why not.
 */
const finalCompletionOf = (answer: WorkspaceCaptureStatus) => {
  const complete = answer.pending === 0 && !answer.fenced;
  return {
    complete,
    ...(complete ? {} : { incompleteReason: answer.fenced ? "fenced" : "pending" }),
  };
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
  setTurnIntent: () => Effect.die("not in test"),
  claimTurnLanding: () => Effect.die("not in test"),
  decideTurnLanding: () => Effect.die("not in test"),
  completeTurn: () => Effect.succeed(null),
  upsertItem: () => Effect.die("not in test"),
  listItems: () => Effect.succeed([]),
  turnMessages: () => Effect.succeed([]),
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
  authors: Array<string | null> = [],
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
        authors.push(author);
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
/** The exec that writes the owner's git author as system config (`gitAuthorConfigArgv`). */
const isGitAuthorExec = (argv: ReadonlyArray<string>): boolean => argv[3] === "mend-git-author";

/** Every account's git author is its registration name and email unless a test says. */
const gitAuthorStubLayer = Layer.succeed(UserGitAuthorRepo, {
  resolve: (userId) =>
    Effect.succeed(
      new ResolvedGitAuthor({
        name: `Account ${userId}`,
        email: `${userId}@accounts.example`,
        source: "account",
      }),
    ),
  set: () => Effect.void,
  clear: () => Effect.void,
});
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

/**
 * The dotfiles cloner as production builds it, under `tenancy`, over the stub key and bridge. The
 * default world is a single-tenant install whose session owner is its operator, so a clone uses
 * the host's own git setup, as the fixture's git daemon needs nothing more.
 */
const dotfilesClonerLayer = (
  options: {
    readonly tenancy?: "single" | "multi";
    readonly ownerIsOperator?: boolean;
    readonly gitAccess?: GitAccessMode | null;
    readonly agentBridge?: Layer.Layer<AgentBridge>;
    /** Every account the cloner asked about, and what it asked. */
    readonly asked?: Array<string>;
  } = {},
): Layer.Layer<DotfilesCloner> =>
  makeDotfilesClonerLayer(options.tenancy ?? "single").pipe(
    Layer.provide(
      Layer.mergeAll(
        mendKeysStubLayer,
        options.agentBridge ?? agentBridgeStubLayer,
        Layer.mock(UserGitAccessRepo, {
          mode: (userId) =>
            Effect.sync(() => {
              options.asked?.push(`git access of ${userId}`);
              return options.gitAccess ?? null;
            }),
        }),
        Layer.mock(InstanceRolesRepo, {
          isOperator: (userId) =>
            Effect.sync(() => {
              options.asked?.push(`operator role of ${userId}`);
              return options.ownerIsOperator ?? true;
            }),
        }),
      ),
    ),
  );

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
  /** Recent owners beyond the world's own sessions, as `recentOwnersForProject` adds them. */
  recentOwners: ReadonlyArray<string>;
  /** A planned relaunch's harness, by session (`planRelaunch`): bookkeeping off the row. */
  readonly relaunches: Map<string, string>;
  /** The executor each session sent a final flush to (`markFinalFlush`). */
  readonly finalFlushed: Map<string, string>;
  /** Each session's executor create not yet answered on its row (`recordExecutorCreate`). */
  readonly executorCreates: Map<string, string>;
  /** Each session's current executor's runtime identity (`recordExecutorResource`). */
  readonly executorResources: Map<
    string,
    { readonly workspaceId: string; readonly resourceId: string }
  >;
  /** Each session's current executor's launch identity, with its workspace (0083). */
  readonly executorLaunches: Map<
    string,
    { readonly workspaceId: string; readonly launchId: string }
  >;
  /** The last completed final flush observed per session (`recordCaptureSaved`). */
  readonly captureSaved: Map<
    string,
    {
      readonly workspaceId: string;
      readonly at: Date;
      readonly n: number | null;
      readonly epoch: number | null;
    }
  >;
  /** The latest unsaved answer observed per session (`recordCaptureUnsaved`). */
  readonly captureUnsaved: Map<
    string,
    { readonly workspaceId: string; readonly at: Date; readonly words: string }
  >;
  /** What each executor answered, whoever asked (`recordExecutorEvidence`, 0086). */
  readonly executorEvidence: Map<string, ExecutorCaptureEvidence>;
  /** Answers asked and not yet published, by ticket (`openEvidenceFence`, 0088). */
  readonly evidenceFences: Map<
    number,
    { readonly workspaceId: string; readonly holder: string; unpublished: boolean }
  >;
  /** Where the executor made the answer behind each session's queue reading (0088). */
  readonly observedPositions: Map<string, CapturePosition | null>;
}

/** The newer of two observations of one kind: `next` when it came after `prior`. */
/** The repository's rule (0087): kept unless the executor made it before the kept one. */
const newerObservation = <T extends { readonly position?: CapturePosition | null }>(
  next: T | undefined,
  prior: T | null,
) =>
  next !== undefined && (prior === null || captureAnswerReplaces(next.position, prior.position))
    ? next
    : prior;

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
  relaunches: new Map(),
  finalFlushed: new Map(),
  captureSaved: new Map(),
  captureUnsaved: new Map(),
  executorEvidence: new Map(),
  evidenceFences: new Map(),
  observedPositions: new Map(),
  executorResources: new Map(),
  executorLaunches: new Map(),
  executorCreates: new Map(),
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
    liveCountsForSessions: (sessionIds) =>
      Effect.sync(() => {
        const counts = new Map<SessionId, number>();
        for (const service of world.services.values()) {
          if (!sessionIds.includes(service.sessionId)) continue;
          const attempt =
            service.currentAttemptId === null
              ? undefined
              : world.processes.get(service.currentAttemptId);
          const forward =
            service.currentForwardId === null
              ? undefined
              : world.serviceForwards.get(service.currentForwardId);
          const live =
            (attempt !== undefined && attempt.exitedAt === null) ||
            (forward !== undefined && (forward.state === "binding" || forward.state === "bound"));
          if (live) counts.set(service.sessionId, (counts.get(service.sessionId) ?? 0) + 1);
        }
        return counts;
      }),
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

/** Every remote in these worlds is public: the policy's own tests cover refusals and pinning. */
const sourcePolicyLayer = Layer.succeed(
  SourcePolicy,
  makeSourcePolicy({
    profile: "operator",
    allowedHosts: [],
    resolve: async () => ["140.82.112.3"],
  }),
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
    setCreatedBy: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setApplyDotfiles: () => Effect.die("not in test"),
    setDefaultShellProfile: () => Effect.die("not in test"),
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
    setAutoLand: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
  });

/**
 * Review 2026-09-28 (7) #3: fail the one write that publishes an answer's executor evidence, as a
 * database would. Only for an answer that said the executor held unsaved work.
 */
let failUnsavedEvidenceWrite = false;
let fenceTickets = 0;
const sessionsLayer = (world: World) => {
  const update = (id: string, patch: Partial<Session>) => {
    const current = world.sessions.get(id);
    if (current !== undefined) {
      world.sessions.set(id, new Session({ ...current, ...patch, updatedAt: now() }));
    }
  };
  const observe = (id: string, observation: CaptureObservation) =>
    update(id, {
      capturePending: observation.pending,
      capturePendingBytes: observation.pendingBytes,
      captureRefused: observation.refused,
      captureRegisteredAt: observation.registeredAt,
      captureObservedAt: observation.observedAt,
      ...(observation.incompleteReason === undefined
        ? {}
        : { captureIncompleteReason: observation.incompleteReason }),
      ...(observation.incompleteDetail === undefined
        ? {}
        : { captureIncompleteDetail: observation.incompleteDetail }),
      ...(observation.failing === undefined
        ? {}
        : observation.failing === null
          ? { captureFailingSince: null, captureFailingError: null }
          : {
              captureFailingSince:
                world.sessions.get(id)?.captureFailingSince ?? observation.failing.since,
              captureFailingError: observation.failing.error,
            }),
    });
  const addEvidence = (workspaceId: string, answer: ExecutorCaptureAnswer) => {
    const kept = world.executorEvidence.get(workspaceId);
    const version = (kept?.version ?? 0) + 1;
    world.executorEvidence.set(workspaceId, {
      workspaceId,
      launchId: answer.launchId ?? kept?.launchId ?? null,
      saved: newerObservation(answer.saved, kept?.saved ?? null),
      unsaved:
        answer.unsaved === undefined
          ? (kept?.unsaved ?? [])
          : withUnsavedAnswer(kept?.unsaved ?? [], answer.unsaved),
      version,
    });
    return version;
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
    setSharedControl: () => Effect.die("not in test"),
    disableSharedControlForOwner: () => Effect.succeed([]),
    listUnsettledForOwner: () => Effect.succeed([]),
    countUnsettledForOrganization: () => Effect.succeed(0),
    // Owners of the world's sessions, most recent first, then any the test names on top.
    recentOwnersForProject: (projectId, since, excludeLabel) =>
      Effect.sync(() => {
        const fromSessions = [...world.sessions.values()]
          .filter(
            (session) =>
              session.projectId === projectId &&
              session.label !== excludeLabel &&
              session.createdAt > since,
          )
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .flatMap((session) => (session.ownerUserId === null ? [] : [session.ownerUserId]));
        return [...new Set([...fromSessions, ...world.recentOwners])];
      }),
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
      Effect.sync(() =>
        // A stop drain holds the workspace: `stopping`, not settled (SessionsRepo.settle).
        world.sessions.get(id)?.captureDrain === "stop"
          ? update(id, { status: "stopping", summary, settledAt: null })
          : update(id, { status: outcome, summary, settledAt: now() }),
      ),
    reopen: (id, status) =>
      Effect.sync(() =>
        update(id, {
          status,
          settledAt: null,
          idleStoppedAt: null,
          captureDiscardedAt: null,
          captureDiscardedBy: null,
        }),
      ),
    claimIdleStop: () => Effect.succeed(true),
    releaseIdleStop: () => Effect.void,
    setSummary: (id, summary) => Effect.sync(() => update(id, { summary })),
    restate: (id, outcome, summary) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.settledAt != null) update(id, { status: outcome, summary });
      }),
    setHarness: (id, harness) => Effect.sync(() => update(id, { harness })),
    setLabel: (id, label) => Effect.sync(() => update(id, { label })),
    setLabelIfUnset: (id, label) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.label !== null) return false;
        update(id, { label });
        return true;
      }),
    remove: (id) => Effect.sync(() => void world.sessions.delete(id)),
    recordCaptureObservation: (id, observation) =>
      Effect.sync(() =>
        update(id, {
          capturePending: observation.pending,
          capturePendingBytes: observation.pendingBytes,
          captureRefused: observation.refused,
          captureRegisteredAt: observation.registeredAt,
          captureObservedAt: observation.observedAt,
          ...(observation.incompleteReason === undefined
            ? {}
            : { captureIncompleteReason: observation.incompleteReason }),
          ...(observation.incompleteDetail === undefined
            ? {}
            : { captureIncompleteDetail: observation.incompleteDetail }),
          ...(observation.failing === undefined
            ? {}
            : observation.failing === null
              ? { captureFailingSince: null, captureFailingError: null }
              : {
                  captureFailingSince:
                    world.sessions.get(id)?.captureFailingSince ?? observation.failing.since,
                  captureFailingError: observation.failing.error,
                }),
        }),
      ),
    beginCaptureDrain: (id, reason, at) =>
      Effect.sync(() => {
        const current = world.sessions.get(id);
        const drain = current?.captureDrain ?? reason;
        update(id, {
          captureDrain: drain,
          captureDrainRequestedAt: current?.captureDrainRequestedAt ?? at,
          captureDrainProgressAt: current?.captureDrainProgressAt ?? at,
          ...(drain === "stop" && current?.settledAt != null
            ? { status: "stopping" as const, settledAt: null }
            : {}),
        });
      }),
    planRelaunch: (id, resume, at) =>
      Effect.sync(() => {
        const current = world.sessions.get(id);
        world.relaunches.set(id, resume);
        update(id, {
          captureDrain: "relaunch",
          captureDrainRequestedAt: current?.captureDrainRequestedAt ?? at,
          captureDrainProgressAt: current?.captureDrainProgressAt ?? at,
        });
      }),
    clearRelaunch: (id) => Effect.sync(() => void world.relaunches.delete(id)),
    stopCaptureDrain: (id) =>
      Effect.sync(() => {
        world.relaunches.delete(id);
        const current = world.sessions.get(id);
        if (current?.captureDrain == null) return;
        update(id, {
          captureDrain: "stop",
          ...(current.settledAt !== null ? { status: "stopping" as const, settledAt: null } : {}),
        });
      }),
    relaunchOf: (id) => Effect.sync(() => world.relaunches.get(id) ?? null),
    markFinalFlush: (id, workspaceId) =>
      Effect.sync(() => void world.finalFlushed.set(id, workspaceId)),
    finalFlushedWorkspace: (id) => Effect.sync(() => world.finalFlushed.get(id) ?? null),
    recordCaptureSaved: (id, saved) => Effect.sync(() => void world.captureSaved.set(id, saved)),
    captureSavedOf: (id) => Effect.sync(() => world.captureSaved.get(id) ?? null),
    recordCaptureUnsaved: (id, unsaved) =>
      Effect.sync(() => void world.captureUnsaved.set(id, unsaved)),
    captureUnsavedOf: (id) => Effect.sync(() => world.captureUnsaved.get(id) ?? null),
    recordExecutorEvidence: (workspaceId, answer) =>
      Effect.sync(() => addEvidence(workspaceId, answer)),
    executorEvidenceOf: (workspaceId) =>
      Effect.sync(() => world.executorEvidence.get(workspaceId) ?? null),
    openEvidenceFence: (workspaceId, holder) =>
      Effect.sync(() => {
        fenceTickets += 1;
        world.evidenceFences.set(fenceTickets, { workspaceId, holder, unpublished: false });
        return fenceTickets;
      }),
    closeEvidenceFence: (ticket, outcome) =>
      Effect.sync(() => {
        if (outcome === "unanswered") {
          world.evidenceFences.delete(ticket);
          return;
        }
        const fence = world.evidenceFences.get(ticket);
        if (fence !== undefined) fence.unpublished = true;
      }),
    evidenceFenced: (workspaceId) =>
      Effect.sync(() =>
        [...world.evidenceFences.values()].some((fence) => fence.workspaceId === workspaceId),
      ),
    // One transaction, as the repository's: all of it, or none of it.
    publishExecutorReading: (reading) =>
      Effect.sync(() => {
        if (failUnsavedEvidenceWrite && reading.unsaved !== null) {
          throw new Error("executor evidence write failed");
        }
        observe(reading.sessionId, reading.observation);
        world.observedPositions.set(reading.sessionId, reading.position);
        if (reading.saved !== null) world.captureSaved.set(reading.sessionId, reading.saved);
        if (reading.unsaved !== null) world.captureUnsaved.set(reading.sessionId, reading.unsaved);
        const version = addEvidence(reading.workspaceId, reading.answer);
        for (const [ticket, fence] of world.evidenceFences) {
          if (
            ticket === reading.fence.ticket ||
            (fence.workspaceId === reading.workspaceId &&
              ticket < reading.fence.ticket &&
              (fence.unpublished || fence.holder !== reading.fence.holder))
          ) {
            world.evidenceFences.delete(ticket);
          }
        }
        return version;
      }),
    captureObservedPositionOf: (id) => Effect.sync(() => world.observedPositions.get(id) ?? null),
    recordCaptureDrainProgress: (id, at) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.captureDrain === null) return;
        update(id, { captureDrainProgressAt: at, captureNotSavedAt: null });
      }),
    markCaptureNotSaved: (id, at) =>
      Effect.sync(() => {
        const current = world.sessions.get(id);
        if (current === undefined || current.captureDrain === null) return false;
        if (current.captureNotSavedAt !== null) return false;
        update(id, { captureNotSavedAt: at });
        return true;
      }),
    endCaptureDrain: (id, discarded) =>
      Effect.sync(() =>
        update(id, {
          captureDrain: null,
          captureDrainRequestedAt: null,
          captureDrainProgressAt: null,
          captureNotSavedAt: null,
          captureIncompleteReason: null,
          captureIncompleteDetail: null,
          captureFailingSince: null,
          captureFailingError: null,
          ...(discarded === undefined
            ? {}
            : { captureDiscardedAt: discarded.at, captureDiscardedBy: discarded.by }),
        }),
      ),
    listCaptureDrains: () =>
      Effect.sync(() =>
        [...world.sessions.values()].filter(
          (s) => s.captureDrain !== null || world.relaunches.has(s.id),
        ),
      ),
    setExecutorStartedAt: (id, at) => Effect.sync(() => update(id, { executorStartedAt: at })),
    recordExecutorResource: (id, workspaceId, resourceId) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.sealantWorkspaceId === workspaceId) {
          world.executorResources.set(id, { workspaceId, resourceId });
        }
      }),
    executorResourceOf: (id) =>
      Effect.sync(() => {
        const found = world.executorResources.get(id);
        const current = world.sessions.get(id)?.sealantWorkspaceId ?? null;
        const launch = world.executorLaunches.get(id);
        return found === undefined || current === null || found.workspaceId !== current
          ? null
          : {
              workspaceId: current,
              resourceId: found.resourceId,
              launchId:
                launch !== undefined && launch.workspaceId === current ? launch.launchId : null,
            };
      }),
    executorLaunchOf: (id) =>
      Effect.sync(() => {
        const found = world.executorLaunches.get(id);
        const current = world.sessions.get(id)?.sealantWorkspaceId ?? null;
        return found === undefined || current === null || found.workspaceId !== current
          ? null
          : { workspaceId: current, launchId: found.launchId };
      }),
    recordExecutorCreate: (id, key) => Effect.sync(() => void world.executorCreates.set(id, key)),
    clearExecutorCreate: (id, key) =>
      Effect.sync(() => {
        if (world.executorCreates.get(id) === key) world.executorCreates.delete(id);
      }),
    executorCreateOf: (id) => Effect.sync(() => world.executorCreates.get(id) ?? null),
    listExecutorCreates: () =>
      Effect.sync(() =>
        [...world.executorCreates.entries()].map(([sessionId, key]) => ({
          sessionId: SessionId.make(sessionId),
          key,
        })),
      ),
    recordAcceptedWorkspace: (id, workspaceId, executorStartedAt, launchId) =>
      Effect.sync(() => {
        world.executorCreates.delete(id);
        world.executorResources.delete(id);
        world.executorLaunches.set(id, { workspaceId, launchId });
        update(id, {
          sealantWorkspaceId: workspaceId,
          executorStartedAt,
          workspaceExpiresAt: null,
          workspaceTtlRenewedAt: null,
          workspaceTtlRenewalFailedAt: null,
          workspaceTtlRenewalError: null,
        });
      }),
    requestRemoval: (id, at) =>
      Effect.sync(() =>
        update(id, { removalRequestedAt: world.sessions.get(id)?.removalRequestedAt ?? at }),
      ),
    listRemovalRequested: () =>
      Effect.sync(() => [...world.sessions.values()].filter((s) => s.removalRequestedAt !== null)),
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
      autoLand: "inherit",
      autoSuggest: "inherit",
      backgroundSessions: "inherit",
      gitAuthMode: "ambient",
      workspaceImage: null,
      applyDotfiles: true,
      defaultShellProfile: true,
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

/** Drains in tests: polls every few milliseconds, a stall only when a test shortens the window. */
const testDrainPolicy = (overrides: Partial<CaptureDrainPolicyShape> = {}) =>
  Layer.succeed(CaptureDrainPolicy, {
    stallSeconds: 600,
    pollInterval: Duration.millis(10),
    flushTimeout: Duration.seconds(5),
    terminationWait: Duration.millis(300),
    executorMaxSeconds: null,
    deadlineMarginSeconds: 300,
    drainEstimateSeconds: 300,
    keptRetryFirst: Duration.seconds(10),
    keptRetryMax: Duration.minutes(5),
    statusInterval: Duration.seconds(45),
    statusMinInterval: Duration.seconds(10),
    ...overrides,
  });

/** The in-memory channel tokens, with every issue and revocation written to `events`. */
const recordingTokens = (events: Array<string>): Layer.Layer<SessionChannelTokensRepo> =>
  Layer.effect(
    SessionChannelTokensRepo,
    Effect.map(SessionChannelTokensRepo, (inner) => ({
      ...inner,
      issue: (sessionId: string, launchId: string) =>
        Effect.sync(() => events.push(`issue:${launchId}`)).pipe(
          Effect.andThen(inner.issue(sessionId, launchId)),
        ),
      revoke: (sessionId: string) =>
        Effect.sync(() => events.push(`revoke:${sessionId}`)).pipe(
          Effect.andThen(inner.revoke(sessionId)),
        ),
      revokeLaunch: (launchId: string) =>
        Effect.sync(() => events.push(`revokeLaunch:${launchId}`)).pipe(
          Effect.andThen(inner.revokeLaunch(launchId)),
        ),
    })),
  ).pipe(Layer.provide(SessionChannelTokensRepoMemory));

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
    /** The owner's dotfiles; none configured unless a test brings its own. */
    readonly userDotfilesLayer?: Layer.Layer<UserDotfilesRepo>;
    /** The owner's git author; `Account <id>` <`<id>@accounts.example`> unless a test says. */
    readonly gitAuthorLayer?: Layer.Layer<UserGitAuthorRepo>;
    /** Who hears about pushes and ended agents; nobody unless a test says. */
    readonly gitHooksLayer?: Layer.Layer<WorkspaceGitHooks>;
    readonly dotfilesStoreLayer?: Layer.Layer<DotfilesStore>;
    /** Whose git access a dotfiles clone uses; the operator's host setup unless a test says. */
    readonly dotfilesClonerLayer?: Layer.Layer<DotfilesCloner>;
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
    /** What the deployment states about the executor's transport (capture mode only). */
    readonly executorTransport?: ExecutorTransport;
    /** How drains pace themselves; fast polls and a long stall window unless a test says. */
    readonly drainPolicy?: Partial<CaptureDrainPolicyShape>;
    /** The store's sealed records of completed final flushes; none unless a test says. */
    readonly seals?: Layer.Layer<CaptureSeals>;
    /** Every log line the engine writes, in order, when a test reads them. */
    readonly logs?: Array<string>;
    /** Every channel token issue and revocation (`issue:<launch>`, `revoke:<session>`, `revokeLaunch:<launch>`). */
    readonly tokenEvents?: Array<string>;
    /** The channel tokens, when a test shares them with a network channel of its own. */
    readonly tokensLayer?: Layer.Layer<SessionChannelTokensRepo>;
    /** Where session sockets go; kept in `servedSocketApis` unless a test says. */
    readonly socketHostLayer?: Layer.Layer<SessionSocketHost>;
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
            Layer.provide(CaptureSourcesOff),
            Layer.provide(CaptureRemotesOff),
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
          ...(options.executorTransport === undefined
            ? {}
            : { executorTransport: options.executorTransport }),
        });
  const engineLayer = SessionEngineLive.pipe(
    Layer.provide(testDrainPolicy(options.drainPolicy)),
    Layer.provide(sessionRepositoryLayer),
    Layer.provide(storeLayer),
    Layer.provide(
      options.captured === undefined || options.sealantLayer === undefined
        ? (options.sealantLayer ?? sealantDeadLayer)
        : stampedAnswers(options.sealantLayer, options.captured, world),
    ),
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
    Layer.provide(options.socketHostLayer ?? sessionSocketStubLayer),
    Layer.provide(
      options.tokensLayer ??
        (options.tokenEvents === undefined
          ? SessionChannelTokensRepoMemory
          : recordingTokens(options.tokenEvents)),
    ),
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
        sourcePolicyLayer,
        foldersEmptyLayer,
        projectRecipesEmptyLayer,
        options.hotWorkspacesLayer ?? hotWorkspacesEmptyLayer,
        options.seals ?? CaptureSealsNone,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        projectEnvironmentLayer(options.environment ?? emptyEnvironment),
        projectSecretsLayer(options.secrets ?? emptySecrets),
        projectClusterBindingsLayer(options.clusterBindings ?? emptyClusterBindings),
        secretCipherStubLayer,
        options.userDotfilesLayer ?? userDotfilesStubLayer,
        options.gitAuthorLayer ?? gitAuthorStubLayer,
        options.gitHooksLayer ?? WorkspaceGitHooksLive,
        options.dotfilesStoreLayer ?? dotfilesStoreStubLayer,
        options.dotfilesClonerLayer ?? dotfilesClonerLayer(),
        options.skillsLayer ?? skillsStubLayer,
      ),
    ),
  );
  const logs = options.logs;
  const loggerLayer =
    logs === undefined
      ? Layer.empty
      : Logger.layer([
          Logger.make(({ message }) => {
            logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
          }),
        ]);
  return Effect.runPromise(
    work(world, tmp).pipe(
      Effect.provide(Layer.mergeAll(engineLayer, storeLayer, worktreesLayer(world))),
      Effect.provide(loggerLayer),
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
    const authors: Array<string | null> = [];
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
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");
          expect(attached[2]?.process.kind).toBe("agent-protocol");
          expect(attached[2]?.process.launchCorrelationId).toBe("follow-up-1");
          expect(submitted).toEqual(["inspect replay", "address the review"]);
          // The follow-up turn is the reviewer's, never an anonymous one.
          expect(authors).toEqual(["user-1", "user-2"]);
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
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, authors),
      },
    );
  });

  it("settles a stop with the summary it was given: the idle stop's words", async () => {
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
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "inspect replay", permissionMode: "bypass" },
            "user-1",
          );

          yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");

          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.summary).toBe("idle · stopped after 15 min · reply to resume");
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-protocol",
          );
          expect(agent?.status).toBe("stopped");
          expect(agent?.exitedAt).not.toBeNull();

          // Resume works as after any stop.
          yield* engine.resumeSession(session.id, null);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
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
            "user-fixture",
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
              "user-fixture",
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
            .launchFollowUp(session.id, "Address the comments.", "follow-up:while-live", null)
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

  it("stopServices stops every live Service a stopped agent left behind, then the workspace", async () => {
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
          const web = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          const db = yield* engine.addService(session.id, 5432, "db");
          const ended = yield* engine.runService(session.id, ["pnpm", "worker"], 4000, "worker");
          yield* engine.stopService(ended.service.id);

          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          // The stop ended the agent; two Services still hold the workspace.
          expect(stopped).toEqual([]);

          expect(yield* engine.stopServices(session.id)).toBe(2);
          expect(world.services.get(web.service.id)?.currentAttemptId).toBeNull();
          expect(world.services.get(db.service.id)?.currentForwardId).toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          // Nothing left: a second press stops nothing and says so.
          expect(yield* engine.stopServices(session.id)).toBe(0);
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
          // The default image's login shell (zsh), not the `bash` request sentinel.
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
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
          // The default image's login shell (zsh), not the `bash` request sentinel.
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
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
        // Beside Mend there is nothing to flush: the worktree is the head.
        expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe("none");
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
      Layer.provide(testDrainPolicy()),
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
          sourcePolicyLayer,
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
          gitAuthorStubLayer,
          WorkspaceGitHooksLive,
          dotfilesStoreStubLayer,
          dotfilesClonerLayer(),
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

describe("SessionEngine workspace git hooks", () => {
  it("reports an ended agent while its workspace is still up, before the sweep stops it", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const heard: Array<{ readonly sessionId: string; readonly stoppedYet: number }> = [];
    const hooks = Layer.succeed(WorkspaceGitHooks, {
      branchesPushed: () => Effect.void,
      agentEnded: (event) =>
        Effect.sync(
          () => void heard.push({ sessionId: event.sessionId, stoppedYet: stopped.length }),
        ),
      register: () => Effect.void,
      landRequested: () => Effect.succeed({ landed: false, lines: [] }),
      registerLanding: () => Effect.void,
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
          yield* engine.stop(session.id);
          for (let i = 0; i < 300 && stopped.length === 0; i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(heard).toEqual([{ sessionId: session.id, stoppedYet: 0 }]);
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped), gitHooksLayer: hooks },
    );
  });
});

describe("SessionEngine workspace git hooks: pushes", () => {
  it("reports a push through the transport that moved a branch, and nothing else", async () => {
    const created: CreateOptions[] = [];
    const pushed: Array<string> = [];
    const hooks = Layer.succeed(WorkspaceGitHooks, {
      branchesPushed: (event) => Effect.sync(() => void pushed.push(event.worktreeId)),
      agentEnded: () => Effect.void,
      register: () => Effect.void,
      landRequested: () => Effect.succeed({ landed: false, lines: [] }),
      registerLanding: () => Effect.void,
    });
    const zero = "0".repeat(40);
    const next = "a".repeat(40);
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
          const api = servedSocketApis.get(session.id);
          if (api === undefined) return yield* Effect.die("no socket api served");
          yield* api.gitTransportDone("op-tag", 0, [`${zero} ${next} refs/tags/v1`]);
          yield* api.gitTransportDone("op-failed", 1, [`${zero} ${next} refs/heads/wip`]);
          yield* api.gitTransportDone("op-fetch", 0, null);
          expect(pushed).toEqual([]);
          yield* api.gitTransportDone("op-push", 0, [`${zero} ${next} refs/heads/chore/bump`]);
          expect(pushed).toEqual([session.worktreeId]);
        }),
      { sealantLayer: sealantLaunchLayer(created), gitHooksLayer: hooks },
    );
  });
});

describe("SessionEngine git author", () => {
  const savedAuthor = Layer.succeed(UserGitAuthorRepo, {
    resolve: (userId) =>
      Effect.succeed(
        userId === "user-fixture"
          ? new ResolvedGitAuthor({
              name: "Anna Example",
              email: "anna@example.com",
              source: "setting",
            })
          : null,
      ),
    set: () => Effect.void,
    clear: () => Effect.void,
  });

  /** Launch one codex session; report what ran in the workspace before the harness opened. */
  const launchAndWatch = async (captured: MemoryCaptureStore | undefined) => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
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
        ...(captured === undefined ? {} : { captured }),
        gitAuthorLayer: savedAuthor,
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
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
          },
        ),
      },
    );
    return { created, execCalls, beforeHarness };
  };

  it("writes the owner's author as system git config before the harness starts", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(undefined);
    expect(execCalls.filter(isGitAuthorExec)).toEqual([
      [
        "sh",
        "-c",
        'git config --system user.name "$1" && git config --system user.email "$2"',
        "mend-git-author",
        "Anna Example",
        "anna@example.com",
      ],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
    // Never as env: GIT_AUTHOR_* would override the owner's dotfiles and the repository's config.
    const env = created[0]?.env ?? {};
    expect(Object.keys(env).filter((name) => name.startsWith("GIT_"))).toEqual([]);
  });

  it("writes it in a captured workspace too, where nothing is mounted", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(makeMemoryCaptureStore());
    expect(created[0]?.source?.kind).toBe("capture");
    expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
      ["Anna Example", "anna@example.com"],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
  });
});

/** The exec that writes Mend's default shell profile where no file exists (`shell-profile.ts`). */
const isShellProfileExec = (argv: ReadonlyArray<string>): boolean =>
  argv[3] === "mend-write-absent";

/** A default shell profile file as shipped (`packages/sessions/src/shell-profile/`). */
const shellProfileAsset = (name: string) =>
  fs.readFileSync(new URL(`../src/shell-profile/${name}`, import.meta.url), "utf8");

describe("SessionEngine default shell profile", () => {
  const ZSHRC = shellProfileAsset("zshrc");
  const STARSHIP = shellProfileAsset("starship.toml");
  const DOTFILES_ZSHRC = "# from the owner's dotfiles\n";
  const DOTFILES_STARSHIP = "add_newline = true\n";

  /**
   * Launch one codex session into `image`, with the workspace's `$HOME` a real directory: the
   * profile exec runs its own script there, as the workspace would, and every other exec answers
   * exit 0. `dotfiles` puts what the owner's dotfiles left in `$HOME` before the launch; the
   * result reads both profile paths back after it.
   */
  const launchWithHome = async (options: {
    readonly captured?: MemoryCaptureStore;
    readonly image?: LaunchImage;
    readonly defaultShellProfile?: boolean;
    readonly dotfiles?: { readonly zshrc?: boolean; readonly starship?: boolean };
  }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shell-profile-home-"));
    if (options.dotfiles?.zshrc === true) {
      fs.writeFileSync(path.join(home, ".zshrc"), DOTFILES_ZSHRC);
    }
    if (options.dotfiles?.starship === true) {
      fs.mkdirSync(path.join(home, ".config"));
      fs.writeFileSync(path.join(home, ".config", "starship.toml"), DOTFILES_STARSHIP);
    }
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          if (options.defaultShellProfile !== undefined) {
            world.projects.set(
              project.id,
              new Project({ ...project, defaultShellProfile: options.defaultShellProfile }),
            );
          }
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
        ...(options.captured === undefined ? {} : { captured: options.captured }),
        workspaceImage: options.image ?? ZSH_FAMILY,
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
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
            exec: (argv) => {
              if (!isShellProfileExec(argv)) return undefined;
              const result = spawnSync("sh", argv.slice(1), {
                env: { ...process.env, HOME: home },
                encoding: "utf8",
              });
              return {
                exitCode: result.status ?? 1,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            },
          },
        ),
      },
    );
    const read = (relative: string) => {
      const file = path.join(home, relative);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    };
    const zshrc = read(".zshrc");
    const starship = read(".config/starship.toml");
    fs.rmSync(home, { recursive: true, force: true });
    return {
      created,
      profileExecs: execCalls.filter(isShellProfileExec),
      beforeHarness,
      zshrc,
      starship,
    };
  };

  it("writes ~/.zshrc and ~/.config/starship.toml into a zsh workspace with neither, before the harness starts", async () => {
    const launched = await launchWithHome({});
    expect(launched.profileExecs).toHaveLength(1);
    expect(launched.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(launched.zshrc).toBe(ZSHRC);
    expect(launched.starship).toBe(STARSHIP);
  });

  it("leaves each file the owner's dotfiles put there and writes only the other", async () => {
    const keptZshrc = await launchWithHome({ dotfiles: { zshrc: true } });
    expect(keptZshrc.zshrc).toBe(DOTFILES_ZSHRC);
    expect(keptZshrc.starship).toBe(STARSHIP);

    const keptStarship = await launchWithHome({ dotfiles: { starship: true } });
    expect(keptStarship.zshrc).toBe(ZSHRC);
    expect(keptStarship.starship).toBe(DOTFILES_STARSHIP);
  });

  it("does the same in a captured workspace, where nothing is mounted", async () => {
    const fresh = await launchWithHome({ captured: makeMemoryCaptureStore() });
    expect(fresh.created[0]?.source?.kind).toBe("capture");
    expect(fresh.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(fresh.zshrc).toBe(ZSHRC);
    expect(fresh.starship).toBe(STARSHIP);

    const kept = await launchWithHome({
      captured: makeMemoryCaptureStore(),
      dotfiles: { zshrc: true, starship: true },
    });
    expect(kept.profileExecs).toHaveLength(1);
    expect(kept.zshrc).toBe(DOTFILES_ZSHRC);
    expect(kept.starship).toBe(DOTFILES_STARSHIP);
  });

  it("writes nothing when the project turns it off", async () => {
    for (const captured of [undefined, makeMemoryCaptureStore()]) {
      const launched = await launchWithHome({
        ...(captured === undefined ? {} : { captured }),
        defaultShellProfile: false,
      });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
      expect(launched.starship).toBeNull();
    }
  });

  it("writes nothing into a bash family image or a custom base", async () => {
    for (const image of [{ ...ZSH_FAMILY, shell: "bash" as const }, CUSTOM_BASE]) {
      const launched = await launchWithHome({ image });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
    }
  });
});

/** What the batched write execs put where: absolute workspace path → contents. */
const writtenFiles = (execCalls: ReadonlyArray<ReadonlyArray<string>>): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  for (const argv of execCalls) {
    if (argv[3] !== "mend-write" || argv[2]?.includes("while") !== true) continue;
    const pairs = argv.slice(4);
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      files.set(pairs[index] ?? "", Buffer.from(pairs[index + 1] ?? "", "base64"));
    }
  }
  return files;
};

describe("SessionEngine files into a captured workspace", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

  const captureLayer = (created: CreateOptions[], execCalls: ReadonlyArray<string>[]) =>
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
      execCalls,
    );

  it("places a pasted image in the live workspace's harness home, not on this machine", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
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
          // No workspace yet: nowhere a harness would read the file, so nothing is stored.
          const early = yield* engine.storePastedImage(session.id, PNG).pipe(Effect.flip);
          expect(early._tag).toBe("SessionNotLiveError");

          yield* engine.launch(session.id, ["codex"]);
          const placed = yield* engine.storePastedImage(session.id, PNG);
          expect(placed.path).toMatch(/^\/workspace\/harness-home\/paste\/\d{8}-\d{6}-\w{4}\.png$/);
          expect(placed.mediaType).toBe("image/png");
          expect(new Uint8Array(writtenFiles(execCalls).get(placed.path) ?? [])).toEqual(PNG);
          expect(
            fs.existsSync(path.join(harnessHomePathOf(project.storePath, session.id), "paste")),
          ).toBe(false);

          const refused = yield* engine
            .storePastedImage(session.id, new TextEncoder().encode("not an image"))
            .pipe(Effect.flip);
          expect(refused._tag).toBe("PastedImageError");
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: captureLayer(created, execCalls) },
    );
  });

  it("keeps writing a co-located paste beside the store, launched or not", async () => {
    await withEngine((world, tmp) =>
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
        const placed = yield* engine.storePastedImage(session.id, PNG);
        const hostPath = path.join(
          harnessHomePathOf(project.storePath, session.id),
          "paste",
          path.posix.basename(placed.path),
        );
        expect(new Uint8Array(fs.readFileSync(hostPath))).toEqual(PNG);
      }),
    );
  });

  it("delivers the owner's skills into a captured workspace's harness home", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
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
          const written = writtenFiles(execCalls);
          const text = (file: string) => written.get(file)?.toString("utf8");
          for (const target of [".claude/skills", ".codex/skills"]) {
            expect(text(`/workspace/harness-home/${target}/global/SKILL.md`)).toBe("owner global");
            expect(text(`/workspace/harness-home/${target}/local/SKILL.md`)).toBe("project local");
          }
          expect(
            JSON.parse(text("/workspace/harness-home/.mend-managed-skills.json") ?? "{}"),
          ).toEqual({
            ".claude/skills": ["global", "local"],
            ".codex/skills": ["global", "local"],
          });
          // The bundles are rewritten whole: their old directories go first.
          const prepared = execCalls.find((argv) => argv[3] === "mend-skills");
          expect(prepared).toContain("/workspace/harness-home/.claude/skills/global");
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: captureLayer(created, execCalls),
        skillsLayer,
      },
    );
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
    const execCalls: ReadonlyArray<string>[] = [];
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
              // What the prewarm applied, a source it left out included, is what the claiming
              // session records.
              dotfiles: {
                repository: { url: "https://example.test/dots.git", ref: null },
                snapshotSha: null,
                notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
              },
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
          // The claimed standby receives the owner's git author at claim, as a cold one does.
          expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
            ["Account user-fixture", "user-fixture@accounts.example"],
          ]);
          // …and the default shell profile: the standby's image is the zsh default.
          expect(execCalls.filter(isShellProfileExec)).toHaveLength(1);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
          expect(launched?.dotfiles).toEqual({
            repository: { url: "https://example.test/dots.git", ref: null },
            snapshotSha: null,
            notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
        ),
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
              dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
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
  kind: CaptureKind = "turn",
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
      kind,
      git: {
        packs: parent === null ? [] : (parent.sections as { git: { packs: string[] } }).git.packs,
        refs: {},
        head: "refs/heads/main",
        fsck: "verified",
      },
      workspace: { root: snapshot.root, packs: snapshot.packs },
      // A final flush snapshots the bulk class too (empty here): its section is never pending.
      ...(kind === "final" ? { bulk: { root: "", packs: [], platform: "linux-x86_64" } } : {}),
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
      kind,
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
                ...readEverything,
              } satisfies WorkspaceCaptureStatus;
            });
          },
        },
      ),
    },
  );
};

/** What a failed exit says, for assertions about refusal messages. */
const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

/** The engine's read of the worktree's `mend.toml` inside a workspace. */
const readsToml = (argv: ReadonlyArray<string>) => argv.at(-1) === WORKSPACE_MEND_TOML;

/** What an owner's dotfiles resolve to right now, as a hot-pool test changes them. */
interface DotfilesState {
  repository: DotfilesRepository | null;
  snapshot: { readonly sha: string; readonly data: string };
}

const savedRepository = (state: DotfilesState): DotfilesRepository => {
  if (state.repository === null) throw new Error("no repository to change");
  return state.repository;
};

/** A capture route's refusal reason, or `ok`. */
const routeReason = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catch((error) => Effect.succeed(error.reason)),
  );

describe("SessionEngine capture mode", () => {
  it("tells the daemon only what the deployment stated about its transport", async () => {
    // Without a statement the source names no transport: the daemon then requires verified
    // HTTPS, and Mend does not soften that on its own. With one, exactly that statement goes.
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
              autoLand: "inherit",
              autoSuggest: "inherit",
              backgroundSessions: "inherit",
              gitAuthMode: "ambient",
              workspaceImage: null,
              applyDotfiles: true,
              defaultShellProfile: true,
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
                        ...readEverything,
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
          expect(
            pool.entries
              .filter((entry) => entry.ownerUserId !== "user-late")
              .every((entry) => entry.status === "ready"),
          ).toBe(true);

          // Losing access drains that owner's standby on the next pass.
          world.members.delete("user-teammate");
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () =>
              pool.entries.every((entry) => entry.ownerUserId !== "user-teammate") &&
              pool.entries.some(
                (entry) => entry.ownerUserId === "user-late" && entry.status === "ready",
              ),
            "the former member's standby to drain and user-late's to warm",
          );
          // user-late's cold session made them a recent owner; the pool now serves them too.
          expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
            "user-fixture",
            "user-late",
          ]);
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
      },
    );
  });

  it("warms a standby without a dotfiles source that fails, and the row records what was left out", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const repository: DotfilesRepository = {
      url: "git://127.0.0.1:1/dots",
      ref: null,
      subdirectory: null,
      manager: "auto",
      bootstrap: true,
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => pool.entries.some((entry) => entry.status !== "warming"),
            "the standby to settle",
          );
          const entry = pool.entries[0];
          expect(entry?.status).toBe("ready");
          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles).toBeUndefined();
          expect(entry?.dotfiles).toEqual({
            repository: { url: repository.url, ref: null },
            snapshotSha: null,
            notApplied: [
              {
                source: "repository",
                reason: expect.stringMatching(
                  /^dotfiles clone of git:\/\/127\.0\.0\.1:1\/dots failed: /,
                ),
              },
            ],
          });
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
        userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
          repository: () => Effect.succeed(repository),
          setRepository: (_userId, value) => Effect.succeed(value),
        }),
      },
    );
  });

  /**
   * A standby is created with its owner's dotfiles and cannot take new ones, so it is claimable
   * only while the owner's dotfiles resolve to what it was warmed with. A change sends the next
   * session cold, and the next reconcile drains the stale standby and warms one with the change.
   * One world walks every change in turn (a claim costs seconds here; a cold provision does not).
   */
  it("a standby is claimed only while its owner's dotfiles are unchanged", async () => {
    // Nothing listens here: the clone fails fast and the standby records it as left out. The
    // fingerprint is the saved repository, not the clone's outcome.
    const warmedRepository: DotfilesRepository = {
      url: "git://127.0.0.1:1/dots",
      ref: null,
      subdirectory: "dots",
      manager: "stow",
      bootstrap: true,
    };
    // Each change is made to the settings as the one before left them, so exactly one field moves.
    const changes: ReadonlyArray<
      readonly [string, (state: DotfilesState, world: World, project: Project) => void]
    > = [
      [
        "a new snapshot",
        (state) => {
          state.snapshot = NEWER_SNAPSHOT;
        },
      ],
      [
        "another repository",
        (state) => {
          state.repository = { ...savedRepository(state), url: "git://127.0.0.1:1/other-dots" };
        },
      ],
      [
        "another branch",
        (state) => {
          state.repository = { ...savedRepository(state), ref: "laptop" };
        },
      ],
      [
        "another manager",
        (state) => {
          state.repository = { ...savedRepository(state), manager: "chezmoi" };
        },
      ],
      [
        "another subdirectory",
        (state) => {
          state.repository = { ...savedRepository(state), subdirectory: null };
        },
      ],
      [
        "install.sh off",
        (state) => {
          state.repository = { ...savedRepository(state), bootstrap: false };
        },
      ],
      [
        "no repository",
        (state) => {
          state.repository = null;
        },
      ],
      [
        "dotfiles turned off for the project",
        (_state, world, project) => {
          world.projects.set(project.id, new Project({ ...project, applyDotfiles: false }));
        },
      ],
    ];
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const state: DotfilesState = { repository: warmedRepository, snapshot: SNAPSHOT };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = new Project({ ...(yield* setup(tmp, world)), hotSessions: 1 });
          world.projects.set(project.id, project);
          const engine = yield* SessionEngine;
          const provision = engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((entry) => entry.status === "ready"), "a standby");
          expect(created[0]?.dotfiles).toEqual({
            archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });

          for (const [label, change] of changes) {
            const stale = pool.entries.find((entry) => entry.status === "ready");
            if (stale === undefined) throw new Error(`no standby before ${label}`);
            change(state, world, project);
            const session = yield* provision;
            expect(session.id, label).not.toBe(stale.id);

            // The stale standby drains; its replacement carries what the owner has now.
            yield* engine.reconcileHotSessions(project.id);
            yield* until(
              () =>
                pool.entries.every((entry) => entry.id !== stale.id) &&
                pool.entries.some((entry) => entry.status === "ready"),
              `the standby from before ${label} to drain and a fresh one to warm`,
            );
            const applies = world.projects.get(project.id)?.applyDotfiles === true;
            expect(
              pool.entries.find((entry) => entry.status === "ready")?.dotfiles,
              label,
            ).toMatchObject({
              repository:
                !applies || state.repository === null
                  ? null
                  : { url: state.repository.url, ref: state.repository.ref },
              snapshotSha: applies ? state.snapshot.sha : null,
            });
          }

          // Unchanged since it warmed: the owner's next session claims it.
          const fresh = pool.entries.find((entry) => entry.status === "ready");
          const claimed = yield* provision;
          expect(claimed.id).toBe(fresh?.id);
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
        userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
          repository: () => Effect.sync(() => state.repository),
          setRepository: (_userId, value) => Effect.succeed(value),
        }),
        dotfilesStoreLayer: Layer.succeed(DotfilesStore, {
          snapshot: () => Effect.die("not in test"),
          current: () =>
            Effect.sync(() => ({
              sha: state.snapshot.sha,
              source: "laptop",
              committedAt: new Date(0),
              files: [],
            })),
          archive: () => Effect.sync(() => state.snapshot),
          clear: () => Effect.void,
        }),
      },
    );
  });

  it("a person's first session goes cold and starts warming for them; at most four people are warmed for", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          world.recentOwners = [];
          const engine = yield* SessionEngine;
          yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* until(
            () =>
              pool.entries.some(
                (entry) => entry.ownerUserId === "user-fixture" && entry.status === "ready",
              ),
            "a standby for the new owner",
          );

          for (const name of ["a", "b", "c", "d"]) world.members.set(`user-${name}`, "member");
          world.recentOwners = ["user-a", "user-b", "user-c", "user-d"];
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => pool.entries.filter((entry) => entry.status === "ready").length === 4,
            "four owners warmed",
          );
          yield* Effect.sleep("50 millis");
          // user-fixture's session is the most recent; user-d is fifth and gets nothing.
          expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
            "user-a",
            "user-b",
            "user-c",
            "user-fixture",
          ]);
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
      },
    );
  });

  it("a claim rechecks the owner: a standby of someone who lost access is not handed to them", async () => {
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
          const standby = pool.entries[0];
          if (standby === undefined) throw new Error("no standby");
          world.members.delete("user-fixture");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(session.id).not.toBe(standby.id);
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(created),
        hotWorkspacesLayer: pool.layer,
      },
    );
  });

  it("a workspace's git transport reaches only the project's own remote with the owner's signer", async () => {
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
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const api = servedSocketApis.get(session.id);
          if (api === undefined) throw new Error("the session serves no socket api");
          const origin = new URL(project.originUrl ?? "");
          const elsewhere = yield* api
            .gitTransport({
              host: "github.com",
              port: null,
              command: "git-receive-pack 'acme/api.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(elsewhere)).toContain(`bound to ${origin.hostname}`);
          const home = yield* api
            .gitTransport({
              host: origin.hostname,
              port: null,
              command: "git-upload-pack 'fixture.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(home)).not.toContain("bound to");
          // What git really sends: the remote's user rides the destination (`git@host`).
          const asGitSendsIt = yield* api
            .gitTransport({
              host: `git@${origin.hostname}`,
              port: null,
              command: "git-upload-pack 'fixture.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(asGitSendsIt)).not.toContain("bound to");
          const posing = yield* api
            .gitTransport({
              host: `${origin.hostname}@github.com`,
              port: null,
              command: "git-receive-pack 'acme/api.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(posing)).toContain(`bound to ${origin.hostname}`);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
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

  /**
   * Review 2026-09-28 (3) #1: a standby's `capture.replan` answer is lost after it re-planned onto
   * the worktree, registered a final capture and sealed it. The seal names the standby's launch
   * (what its plan answered); it must never be attested for any other executor.
   */
  const standbyWhoseReplanAnswerIsLost = (
    stopAnswer: "kept" | "stopped",
    ran: (
      world: World,
      session: Session,
      standbyLaunch: string,
      epoch: number | undefined,
    ) => Effect.Effect<void, unknown, SessionEngine>,
  ) => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const records = new Map<string, CaptureCompletionSeal>();
    const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
    let executor: SessionId | null = null;
    let root = "";
    let resource = "standby-container";
    return {
      stopOptions,
      created,
      memory,
      records,
      run: () =>
        withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              root = tmp;
              const project = yield* setup(tmp, world);
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* until(() => pool.entries.some((e) => e.status === "ready"), "standby");
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                base: null,
              });
              expect(session.id).toBe(standby.id);
              const epoch = memory.leases.get(session.worktreeId)?.epoch;
              executor = session.id;
              yield* ran(world, session, `standby:${standby.id}`, epoch);
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            hotWorkspacesLayer: pool.layer,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopOptions,
                stopAnswer: () => stopAnswer,
                status: (stopAsked) =>
                  stopAsked && stopAnswer === "stopped" ? "stopped" : "ready",
                // Kept: Core keeps the standby for recovery — its disk may hold work.
                ...(stopAnswer === "kept"
                  ? {
                      retained: () => ({
                        reason: "the platform did not observe its final flush",
                        recoverable: true,
                      }),
                    }
                  : {}),
                // Kept: no final flush answer ever says complete (the relay closed). Ended: the
                // executors answer as a current sealantd does.
                ...(stopAnswer === "kept" ? { finalCompletion: "unreported" as const } : {}),
                resourceId: () => resource,
                beforeCreate: (options) =>
                  Effect.sync(() => {
                    if (
                      options.source?.kind === "capture" &&
                      options.source.worktreeId !== undefined
                    ) {
                      resource = "cold-container";
                    }
                  }),
                replan: () =>
                  Effect.gen(function* () {
                    if (executor === null) throw new Error("no executor");
                    const api = servedSocketApis.get(executor)?.capture;
                    if (api === undefined) throw new Error("no api");
                    const plan = yield* api
                      .planGet({ worktree_id: null, epoch: 0 })
                      .pipe(Effect.orDie);
                    const built = yield* shipHarnessCapture(
                      root,
                      memory,
                      WorktreeId.make(plan.worktree_id),
                      plan.epoch,
                      crypto.randomUUID(),
                      "final",
                    ).pipe(Effect.orDie);
                    // sealantd seals under the executor its plan named, and nothing else.
                    records.set(`${plan.worktree_id}:${plan.epoch}`, {
                      worktreeId: WorktreeId.make(plan.worktree_id),
                      epoch: plan.epoch,
                      executorId: plan.executor,
                      captureId: built.id,
                      n: built.manifest.n,
                      sealedAt: new Date(),
                    });
                    return yield* new SealantPlatformError({
                      code: "lost_replan_ack",
                      status: 503,
                      message: "replan reply lost",
                      cause: null,
                    });
                  }),
              },
            }),
          },
        ),
    };
  };

  it("e2e run 6 #4 shrinking the pool honours Core's stop: a standby still draining keeps its token and its row (failed, never claimed); only a confirmed end takes them", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const tokenEvents: Array<string> = [];
    let answer: "draining" | "stopped" = "draining";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((e) => e.status === "ready"), "standby");
          const standby = pool.entries[0];
          if (standby === undefined) throw new Error("no standby");
          // The pool shrinks while Core is still draining the standby.
          world.projects.set(project.id, new Project({ ...project, hotSessions: 0 }));
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => pool.entries.find((e) => e.id === standby.id)?.status === "failed",
            "the kept standby's row",
          );
          expect(tokenEvents.filter((event) => event.startsWith("revoke"))).toEqual([]);
          // Core confirms the end: the next pass takes the token and the row.
          answer = "stopped";
          yield* engine.reconcileHotSessions(project.id);
          yield* until(
            () => !pool.entries.some((e) => e.id === standby.id),
            "the ended standby's row gone",
          );
          expect(tokenEvents).toContain(`revokeLaunch:standby:${standby.id}`);
        }),
      {
        captured: memory,
        hotWorkspacesLayer: pool.layer,
        tokenEvents,
        drainPolicy: { terminationWait: Duration.millis(50) },
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            stopAnswer: () => answer,
            status: (stopAsked) => (stopAsked && answer === "stopped" ? "stopped" : "ready"),
            resourceId: () => "standby-container",
          },
        }),
      },
    );
  }, 30_000);

  it("e2e run 6 #3 a claimed standby whose replan failed still ships under its placeholder: its launch's routes stay the standby's there, never `wrong-worktree`; the session's worktree stays the session's", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const answers: Record<string, string> = {};
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((e) => e.status === "ready"), "standby");
          const standby = pool.entries[0];
          if (standby === undefined) throw new Error("no standby");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          // The replan failed (the relay paused): the launch drains the standby, which the
          // platform keeps, and nothing else starts.
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          const routes = servedSocketApis.get(session.id)?.captureAs?.(`standby:${standby.id}`);
          if (routes === undefined) throw new Error("no launch-bound routes");
          const alias = `standby-${standby.id}`;
          answers["upload.urls · placeholder"] = yield* routeReason(
            routes.uploadUrls({
              worktree_id: alias,
              epoch: standby.createdAt.getTime(),
              keys: [captureKeys(alias, standby.createdAt.getTime()).pack("a".repeat(64))],
            }),
          );
          answers["heartbeat · placeholder"] = yield* routeReason(
            routes.heartbeat({ worktree_id: alias, epoch: standby.createdAt.getTime() }),
          );
          answers["heartbeat · session"] = yield* routeReason(
            routes.heartbeat({ worktree_id: session.worktreeId, epoch }),
          );
        }),
      {
        captured: memory,
        hotWorkspacesLayer: pool.layer,
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            stopAnswer: () => "kept",
            status: () => "ready",
            retained: () => ({ reason: "kept for recovery", recoverable: true }),
            finalCompletion: "unreported",
            resourceId: () => "standby-container",
            replan: () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "replan_refused",
                  status: 503,
                  message: "capture plan.get failed: transport: timeout",
                  cause: null,
                }),
              ),
          },
        }),
      },
    );
    // The standby's own answer under its placeholder (nothing to ship until claimed), never the
    // session's `wrong-worktree`; the session's worktree is still routed as the session's.
    expect(answers["upload.urls · placeholder"]).toBe("lease-lost");
    expect(answers["heartbeat · placeholder"]).toBe("ok");
    expect(answers["heartbeat · session"]).not.toBe("wrong-worktree");
  }, 30_000);

  it("review 3 #1 a standby whose replan answer was lost is the session's executor: it drains, its seal is attested for it alone, and kept, nothing else starts", async () => {
    const scenario = standbyWhoseReplanAnswerIsLost(
      "kept",
      (world, session, standbyLaunch, epoch) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(refused._tag).toBe("SealantPlatformError");
          expect("code" in refused ? refused.code : null).toBe("capture_not_saved");
          // No second executor: nothing was created for the worktree, the epoch is the claim's.
          expect(
            scenario.created.some(
              (o) => o.source?.kind === "capture" && o.source.worktreeId === session.worktreeId,
            ),
          ).toBe(false);
          expect(scenario.memory.leases.get(session.worktreeId)?.epoch).toBe(epoch);
          // The standby is the session's, under its own launch, and the stop attested its seal
          // for it — its runtime, its launch.
          expect(world.executorLaunches.get(session.id)?.launchId).toBe(standbyLaunch);
          const completions = scenario.stopOptions.flatMap((o) =>
            o?.completion === undefined ? [] : [o.completion],
          );
          expect(completions.length).toBeGreaterThan(0);
          for (const completion of completions) {
            expect(completion).toEqual({
              executorId: "standby-container",
              epoch,
              captureN: scenario.records.get(`${session.worktreeId}:${epoch}`)?.n,
              launchId: standbyLaunch,
              sealedAt: scenario.records
                .get(`${session.worktreeId}:${epoch}`)
                ?.sealedAt.toISOString(),
            });
          }
        }),
    );
    await scenario.run();
  }, 30_000);

  it("review 3 #1 once the standby's end is observed, a cold executor starts under a fresh epoch and its own launch, and the standby's seal is never attested for it", async () => {
    const scenario = standbyWhoseReplanAnswerIsLost(
      "stopped",
      (world, session, standbyLaunch, epoch) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          yield* engine.launch(session.id, ["codex"]);
          const cold = world.executorLaunches.get(session.id)?.launchId ?? "";
          expect(cold).toMatch(new RegExp(`^launch:${session.id}:`));
          expect(cold).not.toBe(standbyLaunch);
          expect(scenario.memory.leases.get(session.worktreeId)?.epoch).toBe((epoch ?? 0) + 1);
          const before = scenario.stopOptions.length;
          yield* engine.stop(session.id);
          yield* until(() => scenario.stopOptions.length > before, "the cold executor's stop");
          // The cold executor sealed nothing under its epoch: its stop, saved on its own word,
          // attests nothing — least of all the standby's seal.
          expect(scenario.stopOptions.slice(before).every((o) => o?.completion === undefined)).toBe(
            true,
          );
          expect(scenario.records.get(`${session.worktreeId}:${epoch}`)?.executorId).toBe(
            standbyLaunch,
          );
        }),
    );
    await scenario.run();
  }, 30_000);

  it("a worktree claims the standby: the session adopts its id, the lease is taken at a fresh epoch with the executor as holder, the launch re-plans it onto the worktree, its first register parents on capture 0, a fresh standby warms, a second worktree claims that one, and a join goes cold", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const flushed: string[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    /** What sealantd's `capture.replan` does: `plan.get` with no worktree named, as the executor. */
    const replans: Array<{ readonly workspaceId: string; readonly executorId: SessionId }> = [];
    /** The executor's flush leaves captures pending (a stalled daemon). */
    let partialFlush = false;
    const flush = () =>
      Effect.succeed({
        epoch: 2,
        worktreeId: "",
        pending: partialFlush ? 3 : 0,
        stagedBytes: 0,
        uploadedObjects: 0,
        uploadedBytes: 0,
        registered: 0,
        fenced: false,
        paused: false,
        ...readEverything,
      } satisfies WorkspaceCaptureStatus);
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
          // The claimed standby gets the default shell profile, as a cold executor does.
          expect(execCalls.filter(isShellProfileExec)).toHaveLength(1);
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
          // Automatic landing asks the same holder before it reads a turn's change, and hears
          // what the flush came to; nothing is checkpointed for it.
          expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe("flushed");
          expect(flushed).toEqual(["flush:workspace-1", "flush:workspace-1"]);
          // A flush that leaves captures pending is not a caught-up head.
          partialFlush = true;
          expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe("incomplete");
          partialFlush = false;

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
          execCalls,
          undefined,
          { flushed, replan, flush },
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
                    ...readEverything,
                  })),
                ),
            },
          ),
        },
      );
    },
  );
});

/** A path on the fixture's git daemon, beside the adopted origin. */
const servedUrl = (project: Project, name: string): string => {
  if (project.originUrl === null) throw new Error("the fixture project has no origin");
  return project.originUrl.replace(/\/origin$/, `/${name}`);
};

/** A dotfiles repo beside the fixture origin, served by the same git daemon. */
const dotfilesOrigin = (tmp: string, project: Project): string => {
  const dots = path.join(tmp, "dots");
  fs.mkdirSync(dots, { recursive: true });
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: dots,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dots",
        GIT_AUTHOR_EMAIL: "dots@localhost",
        GIT_COMMITTER_NAME: "dots",
        GIT_COMMITTER_EMAIL: "dots@localhost",
      },
    });
  run("init", "-b", "main");
  fs.writeFileSync(path.join(dots, ".vimrc"), "set nocompatible\n");
  run("add", "-A");
  run("commit", "-m", "dots");
  return servedUrl(project, "dots");
};

/** The owner's repository knob, read from a cell the test fills once the daemon is up. */
const userDotfilesLayer = (
  cell: { repository: DotfilesRepository | null },
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(userId);
        return cell.repository;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
  });

const dotfilesStoreLayer = (
  archive: DotfilesStore["Service"]["archive"],
): Layer.Layer<DotfilesStore> =>
  Layer.succeed(DotfilesStore, {
    snapshot: () => Effect.die("not in test"),
    current: () => Effect.succeed(null),
    archive,
    clear: () => Effect.void,
  });

const SNAPSHOT = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };

const repositoryOf = (url: string): DotfilesRepository => ({
  url,
  ref: null,
  subdirectory: null,
  manager: "stow",
  bootstrap: false,
});

const launchOnce = (world: World, tmp: string) =>
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
    return { project, engine, session };
  });

/** A flush answer with `pending` left; the lifetime counters grow with every capture shipped. */
/**
 * The stand-in daemon as a current sealantd answers (cross-repo decision 17): every flush answer
 * under the epoch its lease holds, stamped with where the executor made it — that epoch, the
 * launch the lease is bound to, its boot and an observation that only counts up — unless the test
 * stamped it itself. Mend
 * orders evidence by that alone: an answer without it is ordered against nothing, and a save
 * never stands over one.
 */
const stampedAnswers = (
  layer: Layer.Layer<SealantClient>,
  memory: MemoryCaptureStore,
  world: World,
): Layer.Layer<SealantClient> => {
  let observation = 0;
  return Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      captureFlush: (target, kind) =>
        client.captureFlush(target, kind).pipe(
          Effect.map((answer) => {
            if ("origin" in answer) return answer;
            const lease = [...memory.leases.values()].find((held) => held.executorId !== null);
            // The launch the lease is bound to, else the one Mend recorded with this workspace.
            const launch =
              lease?.launchId ??
              [...world.executorLaunches.values()].find(
                (recorded) => recorded.workspaceId === target.id,
              )?.launchId ??
              null;
            if (lease === undefined || launch === null) return answer;
            observation += 1;
            return {
              ...answer,
              epoch: lease.epoch,
              origin: {
                epoch: lease.epoch,
                launch,
                bootId: "stand-in-boot",
                bootGeneration: 1,
                observation,
                headN: answer.headN ?? null,
              },
            };
          }),
        ),
    })),
  ).pipe(Layer.provide(layer));
};

const flushReport = (
  pending: number,
  shipped: number,
  extra: Partial<WorkspaceCaptureStatus> = {},
): WorkspaceCaptureStatus => ({
  epoch: 2,
  worktreeId: "",
  pending,
  stagedBytes: 0,
  uploadedObjects: shipped,
  uploadedBytes: shipped * 1000,
  registered: shipped,
  fenced: false,
  paused: false,
  ...readEverything,
  ...extra,
});

const leaseHeld = (memory: MemoryCaptureStore, worktreeId: string, sessionId: string) => {
  const lease = memory.leases.get(worktreeId);
  return (
    lease !== undefined &&
    lease.executorId === sessionId &&
    lease.expiresAt !== null &&
    lease.expiresAt > memory.clock.now()
  );
};

describe("SessionEngine capture drain (no loss of work product)", () => {
  it("a stop drains before the workspace goes: it answers at once reading `saving`, the drain flushes until nothing is pending, and the lease is released only once the platform reports the workspace gone", async () => {
    const world = makeWorld();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    const answers = [3, 2, 1, 0];
    const lines: Array<string | null> = [];
    let sessionId: SessionId | null = null;
    let platformReportsStopped = false;
    let leaseHeldAtStop: boolean | null = null;
    await withEngine(
      (_world, dir) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, dir);
          yield* engine.launch(session.id, ["codex"]);
          sessionId = session.id;
          yield* engine.stop(session.id);
          // The stop answers before the drain: the session reads `saving` from this answer on.
          const answered = world.sessions.get(session.id);
          expect(answered?.captureDrain).toBe("stop");
          expect(answered === undefined ? null : captureStatusLine(answered)).toMatch(/^saving/);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
          // Every flush before the stop, the last one answering nothing pending.
          const stopAt = events.indexOf("workspace-1");
          expect(events.slice(0, stopAt).every((event) => event === "flush:workspace-1")).toBe(
            true,
          );
          expect(answers).toEqual([]);
          // What every surface read while it drained.
          expect(lines).toContain("saving · 2 left");
          expect(lines).toContain("saving · 1 left");
          // Stop asked, termination not yet reported: the executor keeps its lease.
          expect(leaseHeldAtStop).toBe(true);
          yield* Effect.sleep(Duration.millis(100));
          expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
          platformReportsStopped = true;
          yield* until(
            () => !leaseHeld(memory, session.worktreeId, session.id),
            "the lease release after the termination",
          );
          yield* until(
            () => world.sessions.get(session.id)?.captureDrain === null,
            "the drain's end",
          );
          const settled = world.sessions.get(session.id);
          expect(settled?.capturePending).toBe(0);
          expect(settled?.captureNotSavedAt).toBeNull();
          expect(settled === undefined ? "gone" : captureStatusLine(settled)).toBeNull();
        }),
      {
        fixture: { world, tmp },
        captured: memory,
        drainPolicy: { terminationWait: Duration.seconds(10) },
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
          undefined,
          {
            flushed: events,
            status: (stopAsked) => {
              if (stopAsked && leaseHeldAtStop === null && sessionId !== null) {
                const session = world.sessions.get(sessionId);
                leaseHeldAtStop =
                  session !== undefined && leaseHeld(memory, session.worktreeId, session.id);
              }
              return stopAsked && platformReportsStopped ? "stopped" : "ready";
            },
            flush: () =>
              Effect.sync(() => {
                const current = sessionId === null ? undefined : world.sessions.get(sessionId);
                lines.push(current === undefined ? null : captureStatusLine(current));
                const pending = answers.shift() ?? 0;
                return flushReport(pending, 3 - pending);
              }),
          },
        ),
      },
    );
  });

  it(
    "a drain that stops moving keeps the workspace and reads `not saved · N pending · workspace kept`; only the owner's discard ends it",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            // Nothing unsaved before a drain: a plain stop is the verb.
            const early = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
            expect(early._tag).toBe("NothingUnsavedError");
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt !== null,
              "the stall",
            );
            const stalled = world.sessions.get(session.id);
            expect(stalled === undefined ? null : captureStatusLine(stalled)).toBe(
              "not saved · 2 pending · workspace kept",
            );
            expect(events).not.toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
            // The next sweep tries again; still nothing moves, still nothing is stopped.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(200));
            expect(events).not.toContain("workspace-1");
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            // A relaunch behind it is refused: the old workspace holds what is not saved.
            const relaunch = yield* engine.resumeSession(session.id, "shell").pipe(Effect.flip);
            expect(relaunch._tag === "SealantPlatformError" && relaunch.code).toBe(
              "capture_not_saved",
            );
            expect(created).toHaveLength(1);
            expect(events).not.toContain("workspace-1");
            // The owner's discard is the one way the workspace goes with captures pending.
            const { session: discarded } = yield* engine.discardUnsavedAndStop(session.id);
            expect(discarded.captureDrain).toBeNull();
            expect(discarded.captureNotSavedAt).toBeNull();
            expect(events).toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(false);
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          drainPolicy: { stallSeconds: 1 },
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
            undefined,
            { flush: () => Effect.succeed(flushReport(2, 1)) },
          ),
        },
      );
    },
  );

  it(
    "a stopped session reads `stopping` and is not settled until the platform reports its workspace terminated; a kept one stays `stopping`",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let pending = 2;
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            // The agent ended; its container still runs and holds what is not saved.
            const answered = world.sessions.get(session.id);
            expect(answered?.status).toBe("stopping");
            expect(answered?.settledAt).toBeNull();
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept its workspace",
            );
            const kept = world.sessions.get(session.id);
            expect(kept?.status).toBe("stopping");
            expect(kept?.settledAt).toBeNull();
            expect(events).not.toContain("workspace-1");
            // The next sweep: still kept, still not settled.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(100));
            expect(world.sessions.get(session.id)?.status).toBe("stopping");
            expect(world.sessions.get(session.id)?.settledAt).toBeNull();
            // It saves after all; the stop is asked, and only the observed termination settles.
            pending = 0;
            yield* engine.stop(session.id);
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the settle after the termination",
            );
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("stopped");
            expect(settled?.captureDrain).toBeNull();
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          drainPolicy: { stallSeconds: 1, terminationWait: Duration.seconds(5) },
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
            undefined,
            {
              status: (stopAsked) => (stopAsked ? "stopped" : "ready"),
              flush: () => Effect.succeed(flushReport(pending, 1)),
            },
          ),
        },
      );
    },
  );

  it(
    "saved but its termination not observed: the session stays `stopping` until the platform reports the workspace gone",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let gone = false;
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            // Stop asked, the platform still reports it up: not settled.
            expect(world.sessions.get(session.id)?.status).toBe("stopping");
            expect(world.sessions.get(session.id)?.settledAt).toBeNull();
            yield* engine.reapCaptureLeases();
            expect(world.sessions.get(session.id)?.settledAt).toBeNull();
            // The platform reports it gone: the next sweep settles it.
            gone = true;
            yield* engine.reapCaptureLeases();
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("stopped");
            expect(settled?.settledAt).not.toBeNull();
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            events,
            undefined,
            () => gone,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { status: () => "ready", flush: () => Effect.succeed(flushReport(0, 1)) },
          ),
        },
      );
    },
  );

  it(
    "a kept drain backs off while nothing changes — 10 s doubling to its cap — and looks again at once when something does",
    { timeout: 20_000 },
    async () => {
      const world = makeWorld();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
      const created: Array<CreateOptions> = [];
      const flushed: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (_world, dir) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, dir);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the drain kept its workspace",
            );
            yield* Effect.sleep(Duration.millis(50));
            const rounds = () => flushed.length;
            const quiet = (label: string) =>
              Effect.gen(function* () {
                const before = rounds();
                yield* engine.reapCaptureLeases();
                yield* Effect.sleep(Duration.millis(60));
                expect(rounds(), label).toBe(before);
              });
            const looks = (label: string) =>
              Effect.gen(function* () {
                const before = rounds();
                yield* engine.reapCaptureLeases();
                yield* until(() => rounds() > before, label);
                yield* until(
                  () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                  `${label} · kept again`,
                );
                yield* Effect.sleep(Duration.millis(50));
              });
            // Nothing changed: every sweep inside the first wait leaves it alone.
            yield* quiet("a sweep right after the drain was kept");
            yield* quiet("a second sweep inside the first wait");
            // The first wait (300 ms here) has passed: one more round.
            yield* Effect.sleep(Duration.millis(300));
            yield* looks("the round after the first wait");
            // Still nothing changed: the wait doubled, so the first wait is no longer enough.
            yield* Effect.sleep(Duration.millis(320));
            yield* quiet("a sweep after one first-wait into the doubled wait");
            // Something changed (the executor registered a capture on its own): looked at once.
            yield* shipHarnessCapture(
              dir,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            yield* looks("the round after the head moved");
            yield* quiet("a sweep right after that round");
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
          }),
        {
          fixture: { world, tmp },
          captured: memory,
          drainPolicy: {
            stallSeconds: 1,
            keptRetryFirst: Duration.millis(300),
            keptRetryMax: Duration.seconds(5),
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
              flushed,
              // An executor that cannot report `complete`: every round is kept at once.
              finalCompletion: "unreported",
              flush: () => Effect.succeed(flushReport(2, 1)),
            },
          ),
        },
      );
    },
  );

  it("an executor the platform does not answer for is unknown, never dead: no pickup, no stop; one that answers is paused and left alone; only a 404 is a pickup", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    let unreachable = false;
    let dead = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            crypto.randomUUID(),
          );
          const realNow = memory.clock.now;
          memory.clock.now = () => realNow() + 10 * 60 * 1000;
          // Expired lease, Core down: nothing is settled, nothing picked up, nothing stopped.
          unreachable = true;
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("running");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          const unknown = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
          expect(unknown._tag === "SealantPlatformError" && unknown.code).toBe("executor_unknown");
          // Expired lease, the executor answers: paused, never killed.
          unreachable = false;
          const paused = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
          expect(paused._tag === "SealantPlatformError" && paused.code).toBe("executor_paused");
          expect(created).toHaveLength(1);
          expect(events).toEqual([]);
          // The platform says it is gone (404): that, and only that, is a pickup.
          dead = true;
          yield* engine.reapCaptureLeases();
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          memory.clock.now = realNow;
        }),
      {
        captured: memory,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          events,
          undefined,
          () => dead,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { unreachablePlatform: () => unreachable },
        ),
      },
    );
  });

  it("removal waits for the workspace: asked mid-drain the row stays until the workspace is saved and stopped; with no workspace it goes at once", async () => {
    const world = makeWorld();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-drain-test-"));
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    let saveNow = false;
    let removedWhileUp: boolean | null = null;
    await withEngine(
      (_world, dir) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, dir);
          const never = yield* engine.provision({
            projectId: session.projectId,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(yield* engine.removeWhenStopped(never.id)).toBe("removed");
          expect(world.sessions.has(never.id)).toBe(false);

          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
          yield* Effect.sleep(Duration.millis(100));
          expect(world.sessions.has(session.id)).toBe(true);
          expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
          expect(events).not.toContain("workspace-1");
          saveNow = true;
          yield* until(() => !world.sessions.has(session.id), "the removal");
          expect(events).toContain("workspace-1");
          expect(removedWhileUp).toBe(false);
        }),
      {
        fixture: { world, tmp },
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
          undefined,
          {
            status: (stopAsked) => {
              // The row must still be there when the platform is asked about the stop.
              if (stopAsked && removedWhileUp === null) {
                removedWhileUp = ![...world.sessions.values()].some(
                  (candidate) => candidate.removalRequestedAt !== null,
                );
              }
              return stopAsked ? "stopped" : "ready";
            },
            flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
          },
        ),
      },
    );
  });

  it("plans against the platform's cap: with MEND_EXECUTOR_MAX_SECONDS the drain starts at deadline − (estimate + margin), counted from the executor's own start, then a replacement launches", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const before = Date.now();
          yield* engine.launch(session.id, ["codex"]);
          const startedAt = world.sessions.get(session.id)?.executorStartedAt;
          expect(startedAt?.getTime()).toBeGreaterThanOrEqual(before - 1);
          yield* shipHarnessCapture(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            crypto.randomUUID(),
          );
          // 1000 s cap, 600 s estimate + 400 s margin: due from the executor's start.
          yield* engine.reapCaptureLeases();
          yield* until(() => created.length === 2, "the replacement launch");
          const stopAt = events.indexOf("workspace-1");
          expect(stopAt).toBeGreaterThan(0);
          expect(events[stopAt - 1]).toBe("flush:workspace-1");
        }),
      {
        captured: memory,
        drainPolicy: {
          executorMaxSeconds: 1000,
          drainEstimateSeconds: 600,
          deadlineMarginSeconds: 400,
        },
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
          undefined,
          { flushed: events },
        ),
      },
    );
  });

  it("with the cap unknown an executor younger than the fallback age is left alone", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.reapCaptureLeases();
          yield* Effect.sleep(Duration.millis(200));
          expect(created).toHaveLength(1);
          expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created) },
    );
  });
});

describe("SessionEngine dotfiles", () => {
  it("ships the repository before the snapshot and stamps both as applied", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          // Apply order: the repository with its own manager, then the snapshot as a copy.
          expect(
            created[0]?.dotfiles?.archives?.map(({ manager, bootstrap }) => ({
              manager,
              bootstrap,
            })),
          ).toEqual([
            { manager: "stow", bootstrap: false },
            { manager: "copy", bootstrap: false },
          ]);
          expect(created[0]?.dotfiles?.archives?.[1]?.data).toBe(SNAPSHOT.data);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches without a repository that cannot be cloned, still ships the snapshot, and records why", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          // The daemon serves nothing at this path: the clone fails the way a wrong URL does.
          const url = servedUrl(project, "no-such-dots");
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason: expect.stringMatching(
                  /^dotfiles clone of \S+\/no-such-dots failed: fatal: remote error: /,
                ),
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches with no dotfiles when the only source fails, and records why", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles).toBeUndefined();
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [
              { source: "snapshot", reason: "dotfiles snapshot could not be packed: git failed" },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        dotfilesStoreLayer: dotfilesStoreLayer(() =>
          Effect.fail(
            new DotfilesStoreError({
              message: "dotfiles snapshot could not be packed: git failed",
            }),
          ),
        ),
      },
    );
  });

  it("launches without a repository the source policy refuses at launch, and records the refusal", async () => {
    const created: CreateOptions[] = [];
    // Saved under a policy that let it through; this launch's policy refuses the host.
    const url = "https://metadata.google.internal/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason:
                  "dotfiles repository refused: metadata.google.internal is not a repository host.",
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("clones as the session's owner, with their git access, and never lends the host's", async () => {
    const created: CreateOptions[] = [];
    const asked: Array<string> = [];
    // An ssh remote on a multi-tenant instance, for an owner whose git access is the bridge and
    // who shares no signer: the clone has no signer of theirs, and no other identity to use.
    const url = "ssh://git@127.0.0.1:1/owner/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(asked).toEqual(["git access of user-fixture"]);
          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles?.notApplied).toEqual([
            {
              source: "repository",
              reason:
                "the dotfiles repository signs with your connected signer: no signer connected — run `mend keys share` on the machine that holds your key",
            },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({
          tenancy: "multi",
          gitAccess: "bridge",
          asked,
        }),
      },
    );
  });

  it("clones a public repository on a multi-tenant instance with none of the host's setup", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created[0]?.dotfiles?.archives?.map(({ manager }) => manager)).toEqual([
            "stow",
            "copy",
          ]);
          expect(world.sessions.get(session.id)?.dotfiles?.notApplied).toEqual([]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({ tenancy: "multi", ownerIsOperator: false }),
      },
    );
  });

  it("never resolves dotfiles for a project that turned them off", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, applyDotfiles: false }));
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

          expect(reads).toEqual([]);
          expect(created[0]?.dotfiles).toBeUndefined();
          expect(world.sessions.get(session.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(
          { repository: repositoryOf("git://127.0.0.1:1/dots") },
          reads,
        ),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.die("dotfiles are off here")),
      },
    );
  });
});

type LaunchImage = typeof defaultSettings.workspaceImage;

const ZSH_FAMILY: LaunchImage = {
  mode: "family",
  os: "arch",
  packages: [],
  shell: "zsh",
  services: { docker: false },
};

const CUSTOM_BASE: LaunchImage = {
  mode: "custom",
  baseImage: "ghcr.io/acme/base:1",
  packages: [],
  setupCommands: [],
  services: { docker: false },
};

/** A store whose snapshot per owner is whatever `snapshots` says right now; every read lands in `reads`. */
const ownedSnapshotsLayer = (
  snapshots: Map<string, { readonly sha: string; readonly data: string }>,
  reads: Array<string> = [],
): Layer.Layer<DotfilesStore> =>
  Layer.succeed(DotfilesStore, {
    snapshot: () => Effect.die("not in test"),
    current: (userId) =>
      Effect.sync(() => {
        const snapshot = snapshots.get(userId);
        return snapshot === undefined
          ? null
          : { sha: snapshot.sha, source: "laptop", committedAt: new Date(0), files: [] };
      }),
    archive: (userId) =>
      Effect.sync(() => {
        reads.push(`snapshot of ${userId}`);
        return snapshots.get(userId) ?? null;
      }),
    clear: () => Effect.void,
  });

/** The owner's repository knob per account; every read lands in `reads`. */
const ownedRepositoriesLayer = (
  repositories: Map<string, DotfilesRepository>,
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(`repository of ${userId}`);
        return repositories.get(userId) ?? null;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
  });

const NEWER_SNAPSHOT = { sha: "0dd50dd50dd50dd50dd50dd50dd50dd50dd50dd5", data: "bmV3ZXI=" };

describe("SessionEngine dotfiles gate", () => {
  /**
   * Dotfiles reach a workspace only when the project applies them, the image is a family image
   * (a custom base promises only a POSIX sh) and the session has an owner whose dotfiles they
   * are. Every other combination reads nothing of anyone's and sends no archive.
   */
  it.each([
    { applyDotfiles: true, image: "family", owner: "user-fixture", sent: true },
    { applyDotfiles: false, image: "family", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: false, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "family", owner: null, sent: false },
    { applyDotfiles: false, image: "family", owner: null, sent: false },
    { applyDotfiles: true, image: "custom", owner: null, sent: false },
    { applyDotfiles: false, image: "custom", owner: null, sent: false },
  ] as const)(
    "applyDotfiles $applyDotfiles · $image image · owner $owner → dotfiles sent: $sent",
    async ({ applyDotfiles, image, owner, sent }) => {
      const created: CreateOptions[] = [];
      const reads: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            world.projects.set(project.id, new Project({ ...project, applyDotfiles }));
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: owner,
              base: null,
            });
            const launched = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);

            if (owner === null) {
              // Nobody to run as: the launch settles before anything of anyone's is read.
              expect(Exit.isFailure(launched)).toBe(true);
              expect(reads).toEqual([]);
              expect(created).toHaveLength(0);
              return;
            }
            expect(Exit.isSuccess(launched)).toBe(true);
            expect(created).toHaveLength(1);
            const options = created[0];
            if (image === "family") {
              expect(options?.os).toBe("arch");
              expect(options?.shell).toBe("zsh");
              expect(options?.baseImage).toBeUndefined();
            } else {
              expect(options?.baseImage).toBe("ghcr.io/acme/base:1");
              expect(options?.shell).toBeUndefined();
            }
            if (sent) {
              expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
              expect(options?.dotfiles).toEqual({
                archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
              });
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: SNAPSHOT.sha,
                notApplied: [],
              });
            } else {
              expect(reads).toEqual([]);
              expect(options?.dotfiles).toBeUndefined();
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: null,
                notApplied: [],
              });
            }
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          workspaceImage: image === "family" ? ZSH_FAMILY : CUSTOM_BASE,
          userDotfilesLayer: ownedRepositoriesLayer(new Map(), reads),
          dotfilesStoreLayer: ownedSnapshotsLayer(new Map([["user-fixture", SNAPSHOT]]), reads),
        },
      );
    },
  );

  it("a relaunch into a fresh workspace resolves the owner's dotfiles again", async () => {
    const created: CreateOptions[] = [];
    const snapshots = new Map([["user-fixture", SNAPSHOT]]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(world.sessions.get(session.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          // The owner synced again while the session was stopped.
          snapshots.set("user-fixture", NEWER_SNAPSHOT);
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(created[1]?.shell).toBe("zsh");
          expect(created[1]?.dotfiles).toEqual({
            archives: [{ data: NEWER_SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(session.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: NEWER_SNAPSHOT.sha,
            notApplied: [],
          });
          // The shell is the image's login shell, the one those dotfiles configure.
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        workspaceImage: ZSH_FAMILY,
        dotfilesStoreLayer: ownedSnapshotsLayer(snapshots),
      },
    );
  });

  it("each owner's session launches with that owner's dotfiles and nobody else's", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    const otherSnapshot = { sha: "07e407e407e407e407e407e407e407e407e407e4", data: "b3RoZXI=" };
    // user-fixture keeps a repository this launch's policy refuses (no clone, no network); the
    // other owner has none, and a snapshot of their own.
    const refusedUrl = "https://metadata.google.internal/fixture-dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.members.set("user-other", "member");
          const engine = yield* SessionEngine;
          const launchAs = (ownerUserId: string) =>
            Effect.gen(function* () {
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId,
                base: null,
              });
              yield* engine.launch(session.id, ["codex"]);
              return session;
            });

          const other = yield* launchAs("user-other");
          expect(reads).toEqual(["repository of user-other", "snapshot of user-other"]);
          expect(created[0]?.dotfiles).toEqual({
            archives: [{ data: otherSnapshot.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(other.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: otherSnapshot.sha,
            notApplied: [],
          });

          reads.length = 0;
          const fixture = yield* launchAs("user-fixture");
          expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
          expect(created[1]?.dotfiles).toEqual({
            archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.repository).toEqual({
            url: refusedUrl,
            ref: null,
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: ownedRepositoriesLayer(
          new Map([["user-fixture", repositoryOf(refusedUrl)]]),
          reads,
        ),
        dotfilesStoreLayer: ownedSnapshotsLayer(
          new Map([
            ["user-fixture", SNAPSHOT],
            ["user-other", otherSnapshot],
          ]),
          reads,
        ),
      },
    );
  });
});

/** A launch layer for the lifecycle tests: the positional knobs they use, by name. */
const lifecycleLayer = (
  created: Array<CreateOptions>,
  knobs: {
    readonly events?: string[];
    readonly spawned?: ReadonlyArray<string>[];
    readonly dead?: () => boolean;
    readonly execCalls?: ReadonlyArray<string>[];
    readonly captureOps?: Parameters<typeof sealantLaunchLayer>[11];
  } = {},
) =>
  sealantLaunchLayer(
    created,
    undefined,
    knobs.events,
    knobs.spawned,
    knobs.dead,
    undefined,
    undefined,
    undefined,
    undefined,
    knobs.execCalls,
    undefined,
    knobs.captureOps,
  );

describe("SessionEngine lifecycle safety (review 2026-09-27)", () => {
  it("every planned end asks the executor for a final flush; a checkpoint asks for a suspend one", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const kinds: CaptureFlushKind[] = [];
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.checkpointNow(session.id, "user-mark");
          expect(kinds.length).toBeGreaterThan(0);
          expect(kinds.every((kind) => kind === "suspend")).toBe(true);
          const before = kinds.length;
          yield* engine.stop(session.id);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
          const stopAt = events.indexOf("workspace-1");
          // The flush right before the stop is final.
          const flushesBeforeStop = events
            .slice(0, stopAt)
            .filter((event) => event.startsWith("flush:")).length;
          expect(kinds[flushesBeforeStop - 1]).toBe("final");
          expect(kinds.slice(before)).toContain("final");
          expect(world.finalFlushed.get(session.id)).toBe("workspace-1");
        }),
      {
        captured: memory,
        drainPolicy: { terminationWait: Duration.seconds(5) },
        sealantLayer: lifecycleLayer(created, {
          events,
          captureOps: { flushed: events, flushKinds: kinds },
        }),
      },
    );
  });

  it(
    "a replacement is saved only by a completed final flush: an executor that cannot say `complete` keeps its workspace and nothing relaunches",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            // The queue read empty, but nothing said the executor quiesced and snapshotted both
            // classes: the workspace stays, and no second executor was made.
            yield* Effect.sleep(Duration.millis(200));
            expect(events).not.toContain("workspace-1");
            expect(created).toHaveLength(1);
            const kept = world.sessions.get(session.id);
            expect(kept?.captureDrain).toBe("replacement");
            expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
              "not saved · final flush not reported · 0 pending · workspace kept",
            );
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events, finalCompletion: "unreported" },
          }),
        },
      );
    },
  );

  it(
    "an executor sent a final flush is never reused: a second session is refused instead of joining it",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
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
            const spawnedBefore = spawned.length;
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(second.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
            expect(refused._tag === "SealantPlatformError" && refused.message).toContain(
              "saving before it ends",
            );
            // Nothing was started in the ending executor, and no second executor was made.
            expect(spawned).toHaveLength(spawnedBefore);
            expect(created).toHaveLength(1);
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            spawned,
            captureOps: { finalCompletion: "unreported" },
          }),
        },
      );
    },
  );

  it(
    "the lead grows with what is pending at the observed rate: captures registering slowly start the replacement early",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
      let registered = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // Two readings a second apart: one capture registered, 5000 still pending.
            yield* engine.readCaptures(session.id);
            yield* Effect.sleep(Duration.millis(1100));
            registered = 1;
            yield* engine.readCaptures(session.id);
            expect(world.sessions.get(session.id)?.capturePending).toBe(5000);
            // A one-hour cap and no configured lead: 5000 captures at under one a second need
            // longer than the hour, so the planned drain is due now.
            yield* engine.reapCaptureLeases();
            yield* until(() => kinds.includes("final"), "the planned drain's final flush");
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 3600,
            drainEstimateSeconds: 0,
            deadlineMarginSeconds: 0,
            stallSeconds: 1,
          },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              flushKinds: kinds,
              flush: () =>
                Effect.sync(() =>
                  kinds.at(-1) === "final"
                    ? flushReport(0, registered + 5000)
                    : flushReport(5000, registered),
                ),
            },
          }),
        },
      );
    },
  );

  it(
    "a lapsed lease is not an end: a second session is refused while the first executor may still run, and takes the worktree once its end is confirmed",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let firstDead = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // A partition: the first executor's heartbeats stop reaching Mend.
            const realNow = memory.clock.now;
            memory.clock.now = () => realNow() + 10 * 60 * 1000;
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(second.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe("worktree_leased");
            expect(refused._tag === "SealantPlatformError" && refused.message).toContain(
              "lease lapsed",
            );
            expect(created).toHaveLength(1);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            // The platform says the first executor is gone: its lease is released and the next
            // session claims a new epoch.
            const third = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const epochBefore = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            firstDead = true;
            // Past the claim, the fake's one workspace also reads gone: only the claim matters.
            yield* engine.launch(third.id, ["claude"]).pipe(Effect.ignore);
            expect(created).toHaveLength(2);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(third.id);
            expect(memory.leases.get(session.worktreeId)?.epoch).toBe(epochBefore + 1);
            memory.clock.now = realNow;
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, { dead: () => firstDead }),
        },
      );
    },
  );

  it(
    "the session that owns the executor stays while another works in it: its removal waits for the workspace",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(second.id, ["claude"]);
            expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");
            yield* engine.stop(session.id);
            yield* Effect.sleep(Duration.millis(300));
            // The joined session still works in the executor this row identifies.
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            expect(world.sessions.has(session.id)).toBe(true);
            expect(world.sessions.get(session.id)?.removalRequestedAt).not.toBeNull();
            // Its capture identity still resolves: the executor's plan is answered as before.
            const holds = yield* engine.captureHolds(session.worktreeId);
            expect(holds.map((hold) => hold.kind)).toContain("executor");
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, { spawned }),
        },
      );
    },
  );

  it(
    "removal holds: a drain under way holds the worktree's identity, and nothing does once the workspace saved and ended",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // Up and holding its lease: an executor nobody observed end.
            expect((yield* engine.captureHolds(session.worktreeId)).length).toBeGreaterThan(0);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the drain",
            );
            const saving = yield* engine.captureHolds(session.worktreeId);
            expect(saving).toContainEqual({ sessionId: session.id, kind: "saving" });
            expect(captureHoldWords(saving)).toContain("saving · 1 session");
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the workspace stop");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([]);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.seconds(5) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushed: events,
              flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
            },
          }),
        },
      );
    },
  );

  it(
    "a removal waits for the workspace's end, not only its save: a stop the platform has not carried out keeps the row",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            yield* until(() => events.includes("workspace-1"), "the stop asked");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            yield* Effect.sleep(Duration.millis(200));
            // Saved and asked to stop, but the platform still reports it up: the row the
            // executor registers under stays, and so does its lease.
            expect(world.sessions.has(session.id)).toBe(true);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.millis(300) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events, status: () => "ready" },
          }),
        },
      );
    },
  );

  it(
    "a landing waits for the executor's captures: a lapsed lease whose executor may still run is not caught up",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const checkpointsBefore = world.checkpoints.length;
            const realNow = memory.clock.now;
            memory.clock.now = () => realNow() + 10 * 60 * 1000;
            // Unknown is never `none`: the executor was not answered for.
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
            const behind = yield* engine
              .landingCheckpoint(session.id, "user-mark")
              .pipe(Effect.flip);
            expect(behind._tag).toBe("CapturesBehindError");
            expect(world.checkpoints.length).toBe(checkpointsBefore);
            memory.clock.now = realNow;
            // Caught up: the checkpoint names the capture it was derived from, the chain head.
            const taken = yield* engine.landingCheckpoint(session.id, "user-mark");
            expect(taken.captureId).toBe(memory.chains.get(session.worktreeId)?.headCapture);
          }),
        { captured: memory, sealantLayer: lifecycleLayer(created) },
      );
    },
  );

  it(
    "a relaunch interrupted by a restart finishes: the old executor drains and ends, then the session launches again",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            // What a restart finds: the relaunch planned, its drain not yet run in this process.
            const current = world.sessions.get(session.id);
            if (current === undefined) throw new Error("the session is gone");
            world.relaunches.set(session.id, "codex");
            world.sessions.set(
              session.id,
              new Session({
                ...current,
                captureDrain: "relaunch",
                captureDrainRequestedAt: new Date(),
                captureDrainProgressAt: new Date(),
              }),
            );
            yield* engine.reapCaptureLeases();
            yield* until(() => created.length === 2, "the relaunch");
            const stopAt = events.indexOf("workspace-1");
            expect(stopAt).toBeGreaterThan(0);
            expect(events[stopAt - 1]).toBe("flush:workspace-1");
            expect(world.relaunches.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.seconds(5) },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: { flushed: events },
          }),
        },
      );
    },
  );

  it(
    "the owner's stop wins over a replacement under way: the drain finishes, the executor ends, and no new one starts",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const memory = makeMemoryCaptureStore();
      let saveNow = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // A resumable session: without the owner's stop, the replacement relaunches it.
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            // Due at once: 1000 s cap, 600 s estimate + 400 s margin.
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "replacement",
              "the replacement's drain",
            );
            yield* engine.stop(session.id);
            // Durable: after a restart the drain ends in a stop, not a relaunch.
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            saveNow = true;
            yield* until(() => events.includes("workspace-1"), "the terminate");
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === null,
              "the drain's end",
            );
            yield* Effect.sleep(Duration.millis(500));
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(300));
            expect(created).toHaveLength(1);
            expect(world.sessions.get(session.id)?.status).toBe("stopped");
            expect(world.relaunches.has(session.id)).toBe(false);
          }),
        {
          captured: memory,
          drainPolicy: {
            executorMaxSeconds: 1000,
            drainEstimateSeconds: 600,
            deadlineMarginSeconds: 400,
            terminationWait: Duration.seconds(5),
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushed: events,
              flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
            },
          }),
        },
      );
    },
  );

  it(
    "a follow-up whose relaunch a restart interrupted is delivered once, with its prompt, after the old executor saved and ended",
    { timeout: 30_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-relaunch-restart-test-")),
      };
      const memory = makeMemoryCaptureStore();
      const created: Array<CreateOptions> = [];
      const spawned: ReadonlyArray<string>[] = [];
      const events: string[] = [];
      const PROMPT = "fix the flaky retry test";
      const CORRELATION = "follow-up:f-1";
      let saveNow = false;
      let sessionId: SessionId | null = null;
      const layerFor = () =>
        lifecycleLayer(created, {
          events,
          spawned,
          captureOps: {
            flushed: events,
            flush: () => Effect.succeed(saveNow ? flushReport(0, 2) : flushReport(1, 1)),
          },
        });
      // Before the restart: the session is stopped while its executor still saves, and a
      // follow-up relaunches it — the relaunch waits on that drain when Mend goes down.
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionId = session.id;
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the stop's drain",
            );
            yield* Effect.forkChild(
              engine.launchFollowUp(session.id, PROMPT, CORRELATION, "user-fixture"),
            );
            yield* until(() => world.relaunches.has(session.id), "the planned relaunch");
            expect(created).toHaveLength(1);
          }),
        { fixture, captured: memory, sealantLayer: layerFor() },
      );
      // After it: the plan is still there, the old executor saves and ends, and the follow-up
      // launches with its prompt, once.
      const planned = sessionId === null ? undefined : fixture.world.relaunches.get(sessionId);
      expect(planned).toContain(CORRELATION);
      saveNow = true;
      await withEngine(
        (world) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            if (sessionId === null) throw new Error("no session");
            const id = sessionId;
            yield* engine.reapCaptureLeases();
            yield* until(() => created.length === 2, "the relaunch");
            const stopAt = events.lastIndexOf("workspace-1");
            expect(stopAt).toBeGreaterThan(0);
            expect(events[stopAt - 1]).toBe("flush:workspace-1");
            // The prompt rides base64-encoded to the harness (`promptArgv`).
            expect(spawned.at(-1)).toContain(Buffer.from(PROMPT).toString("base64"));
            yield* until(() => !world.relaunches.has(id), "the plan's end");
            // A restart after the launch but before the plan was cleared: the process already
            // carries the correlation id, so nothing launches a second time.
            if (planned !== undefined) world.relaunches.set(id, planned);
            yield* engine.reapCaptureLeases();
            yield* until(() => !world.relaunches.has(id), "the replayed plan's end");
            yield* Effect.sleep(Duration.millis(300));
            expect(created).toHaveLength(2);
            const correlated = [...world.processes.values()].filter(
              (process) => process.launchCorrelationId === CORRELATION,
            );
            expect(correlated).toHaveLength(1);
          }),
        { fixture, captured: memory, sealantLayer: layerFor() },
      );
    },
  );

  it(
    "a restart mid-drain gives the draining session its channel back, so its executor can still ship",
    { timeout: 20_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-channel-restart-test-")),
      };
      const memory = makeMemoryCaptureStore();
      const created: Array<CreateOptions> = [];
      let sessionId: SessionId | null = null;
      const layer = () =>
        lifecycleLayer(created, {
          captureOps: { flush: () => Effect.succeed(flushReport(1, 1)) },
        });
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            sessionId = session.id;
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureDrain === "stop",
              "the stop's drain",
            );
          }),
        { fixture, captured: memory, sealantLayer: layer() },
      );
      if (sessionId === null) throw new Error("no session");
      const id: SessionId = sessionId;
      // The channel registry is this process's memory: a restart starts it empty.
      servedSocketApis.delete(id);
      await withEngine(
        (world) =>
          Effect.sync(() => {
            // Stopping, still draining (not settled while its container runs): its executor
            // calls in all the same.
            expect(world.sessions.get(id)?.status).toBe("stopping");
            expect(world.sessions.get(id)?.settledAt).toBeNull();
            expect(servedSocketApis.has(id)).toBe(true);
          }),
        { fixture, captured: memory, sealantLayer: layer() },
      );
    },
  );

  it(
    "the owner's discard asks the platform for a stop that does not drain, and says so when the platform keeps the workspace",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const stops: Array<"drain" | "discard"> = [];
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
            // The platform keeps it: nothing discarded, and the session still reads its captures.
            const refused = yield* engine.discardUnsavedAndStop(session.id).pipe(Effect.flip);
            expect(refused._tag === "SealantPlatformError" && refused.code).toBe(
              "workspace_not_ended",
            );
            expect(stops).toEqual(["discard"]);
            expect(world.sessions.get(session.id)?.captureDrain).toBe("stop");
            platformKeeps = false;
            const { session: discarded } = yield* engine.discardUnsavedAndStop(session.id);
            expect(discarded.captureDrain).toBeNull();
            expect(stops).toEqual(["discard", "discard"]);
          }),
        {
          captured: memory,
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

  it(
    "an agent whose executor went away without Mend asking reads `executor lost`, never `completed`",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let killed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent === undefined || agent.sealantSessionId === null) {
              throw new Error("the launch recorded no agent PTY");
            }
            // docker kill: the platform reports the workspace gone and the PTY ended clean.
            killed = true;
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
            expect(settled?.summary).toMatch(/^executor lost · last saved \d\d:\d\d:\d\d UTC/);
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            () => killed,
            undefined,
            ptyStates,
          ),
        },
      );
    },
  );

  it(
    "a `docker stop` whose final capture registered last, with no completed word from it and no seal, names that capture and says completion unknown — never saved (review 2026-09-28 #13)",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let stopped = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            // sealantd's SIGTERM path: admission closed, processes ended, then the final captures.
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
              "final",
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
            expect(settled?.summary).toMatch(
              /^stopped outside Mend · last saved capture \d+ at \d\d:\d\d:\d\d UTC · completion unknown$/,
            );
          }),
        {
          captured: memory,
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

  it(
    "a kill -9 says when it last saved, that later changes were not saved, and what Mend last read pending — only when it read it after that save",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      let killed = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
              "auto",
            );
            yield* Effect.sleep(Duration.millis(20));
            // A reading after that save: 3 captures still queued in the executor.
            const reading = yield* engine.readCaptures(session.id);
            expect(reading?.pending).toBe(3);
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent === undefined || agent.sealantSessionId === null) {
              throw new Error("the launch recorded no agent PTY");
            }
            killed = true;
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
            expect(settled?.summary).toMatch(
              /^executor lost · last saved \d\d:\d\d:\d\d UTC · changes after that were not saved · 3 pending at \d\d:\d\d:\d\d UTC$/,
            );
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            () => killed,
            undefined,
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            { flush: () => Effect.succeed(flushReport(3, 1)) },
          ),
        },
      );
    },
  );

  it(
    "a launch that failed before any executor existed leaves the worktree free for the next one",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let refuse = true;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(failed._tag).toBe("SealantPlatformError");
            // Nothing ran: the launch's own claim is released.
            expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            refuse = false;
            yield* engine.launch(session.id, ["codex"]);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            expect(world.sessions.get(session.id)?.status).toBe("running");
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(created, () => refuse),
        },
      );
    },
  );
});

describe("SessionEngine capture failures shown while they happen (e2e run 3, 2026-09-27)", () => {
  it(
    "a final flush whose snapshot failed keeps the workspace at once, with sealantd's error and path, and asks again only on the kept backoff",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
      let shipped = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            // The default stall window is 600 s: only a reason that cannot complete keeps it now.
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            const finals = () => kinds.filter((kind) => kind === "final").length;
            expect(finals()).toBe(1);
            const kept = world.sessions.get(session.id);
            expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
              "not saved · snapshot failed · EACCES: permission denied · unreadable tree/secrets.pem · 0 pending · workspace kept",
            );
            expect(events).not.toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
            // Nothing changed: the next sweep inside the first wait sends no FINAL.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(60));
            expect(finals()).toBe(1);
            // The first wait has passed: one more FINAL, kept again at once.
            yield* Effect.sleep(Duration.millis(300));
            yield* engine.reapCaptureLeases();
            yield* until(() => finals() > 1, "the retry after the first wait");
            yield* Effect.sleep(Duration.millis(60));
            const afterRetry = finals();
            // Kept again at once: nothing more until the doubled wait, however many ticks.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(100));
            expect(finals()).toBe(afterRetry);
            expect(world.sessions.get(session.id)?.captureNotSavedAt).not.toBeNull();
            expect(events).not.toContain("workspace-1");
          }),
        {
          captured: memory,
          drainPolicy: {
            keptRetryFirst: Duration.millis(300),
            keptRetryMax: Duration.seconds(5),
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushKinds: kinds,
              // The daemon's own answer, as it gave it: its final snapshot failed.
              finalCompletion: "unreported",
              flush: () =>
                Effect.sync(() => {
                  // Every round ships something (the counters grow): movement is not progress
                  // toward `complete` when the snapshot itself fails.
                  shipped += 1;
                  return {
                    ...flushReport(0, shipped),
                    complete: false,
                    incompleteReason: "snapshot-failed",
                    lastSnapError: "EACCES: permission denied",
                    unreadable: 1,
                    unreadablePaths: ["tree/secrets.pem"],
                  };
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "a running session whose snaps fail reads `capture failing since … · <error>` from a status read, and not once they succeed again",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const since = Date.parse("2026-09-27T16:29:51.000Z");
      let failing = true;
      let reads = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            expect(world.sessions.get(session.id)?.status).toBe("running");
            // Nothing has read it yet: nothing to say.
            const before = world.sessions.get(session.id);
            expect(before === undefined ? "gone" : captureStatusLine(before)).toBeNull();
            // The reaper reads a running executor's status on its own.
            yield* engine.reapCaptureLeases();
            yield* until(
              () => world.sessions.get(session.id)?.captureFailingSince != null,
              "the failing snap on the session",
            );
            const shown = world.sessions.get(session.id);
            expect(shown === undefined ? null : captureStatusLine(shown)).toBe(
              "capture failing since 16:29:51 UTC · EIO: tree/db.sqlite",
            );
            // Within the interval the reaper does not ask again.
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(60));
            expect(reads).toBe(1);
            // A client's view asks (throttled per session); the snaps succeed again.
            failing = false;
            yield* engine.refreshCaptureStatus(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureFailingSince === null,
              "the failure cleared",
            );
            const cleared = world.sessions.get(session.id);
            expect(cleared === undefined ? "gone" : captureStatusLine(cleared)).toBeNull();
            expect(reads).toBe(2);
          }),
        {
          captured: memory,
          drainPolicy: {
            statusInterval: Duration.minutes(1),
            statusMinInterval: Duration.millis(0),
          },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              captureStatus: () =>
                Effect.sync(() => {
                  reads += 1;
                  return failing
                    ? {
                        ...flushReport(1, 1),
                        lastSnapError: "EIO: tree/db.sqlite",
                        snapFailingSinceUnixMs: since,
                        snapsFailed: 4,
                      }
                    : flushReport(0, 2);
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "after the owner's discard the session reads `stopped · unsaved work discarded by <name> at …`",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
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
            yield* engine.discardUnsavedAndStop(session.id, "Ada Lovelace");
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the settle after the discard",
            );
            const settled = world.sessions.get(session.id);
            if (settled === undefined) throw new Error("the session went");
            const line = captureStatusLine(settled);
            expect(`${settled.status} · ${line}`).toMatch(
              /^stopped · unsaved work discarded by Ada Lovelace at \d\d:\d\d:\d\d UTC$/,
            );
          }),
        {
          captured: memory,
          drainPolicy: { stallSeconds: 1, terminationWait: Duration.millis(300) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: (discard) => (discard ? "stopped" : "kept"),
              flush: () => Effect.succeed(flushReport(2, 1)),
            },
          }),
        },
      );
    },
  );
});

describe("SessionEngine lifecycle after a final flush (e2e run 4, 2026-09-27)", () => {
  /** A daemon's status once its final flush completed (sealantd 0.19: `complete` on status). */
  const completedStatus = (headN: number): WorkspaceCaptureStatus => {
    const completion = { complete: true };
    return { ...flushReport(0, headN, { headN }), ...completion };
  };

  /**
   * The M3 sequence: `sealantctl capture flush --final` inside the executor ends the harness and
   * closes admission (an exec there is refused), the daemon waits for its stop; Mend's stop then
   * flushes, and each suspend flush stages a capture on top of the final (the sealantd side is
   * fixed in parallel); the drain's FINAL completes and the workspace is terminated.
   */
  const m3 = (statusAnswers: boolean) => async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const kinds: CaptureFlushKind[] = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    const memory = makeMemoryCaptureStore();
    const seen: Array<string> = [];
    let dir = "";
    let finalRan = false;
    let firstLookAt: number | null = null;
    let worktree: WorktreeId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          dir = tmp;
          const { engine, session } = yield* launchOnce(world, tmp);
          worktree = session.worktreeId;
          yield* engine.launch(session.id, ["codex"]);
          yield* Effect.forkScoped(
            Effect.sync(() => {
              const status = world.sessions.get(session.id)?.status;
              if (status !== undefined && seen.at(-1) !== status) seen.push(status);
            }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(5)))),
          );
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          yield* shipHarnessCapture(tmp, memory, session.worktreeId, epoch, "m3", "final");
          finalRan = true;
          const agent = [...world.processes.values()].find(
            (process) => process.sessionId === session.id && process.kind === "agent-pty",
          );
          if (agent === undefined || agent.sealantSessionId === null) {
            throw new Error("the launch recorded no agent PTY");
          }
          // The final flush terminated the harness.
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 143,
            outputHighWater: 0n,
          });
          yield* until(() => firstLookAt !== null, "the watcher's first look at the executor");
          // The harness is gone: the line leaves `running` at once, not after the looks.
          yield* until(
            () =>
              world.sessions.get(session.id)?.status !== "running" &&
              Date.now() - (firstLookAt ?? 0) < 1000,
            "the session leaving `running` within a second of the harness going",
          );
          if (statusAnswers) {
            // The executor's status says its final flush completed: that is the end reading.
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the settle on the executor's word",
            );
            expect(world.sessions.get(session.id)?.status).toBe("stopped");
            expect(world.sessions.get(session.id)?.summary).toMatch(
              /^stopped outside Mend · saved at \d\d:\d\d:\d\d UTC · capture \d+$/,
            );
          } else {
            // Nothing says yet how the executor ended: `stopping`, never `running`.
            expect(world.sessions.get(session.id)?.status).toBe("stopping");
          }
          // The owner's stop, while the watcher may still be looking.
          yield* engine.stop(session.id);
          yield* until(() => events.includes("workspace-1"), "the workspace stop");
          yield* until(() => {
            const current = world.sessions.get(session.id);
            return current?.settledAt != null && current.captureDrain === null;
          }, "the settle");
          // Past every look the watcher could still take.
          yield* Effect.sleep(Duration.millis(1500));
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.summary ?? "").not.toMatch(/executor lost/);
          expect(seen).not.toContain("failed");
          expect(kinds).toContain("final");
        }),
      {
        captured: memory,
        drainPolicy: { pollInterval: Duration.seconds(1), terminationWait: Duration.seconds(3) },
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          events,
          undefined,
          undefined,
          undefined,
          ptyStates,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            flushKinds: kinds,
            // Admission is closed once the final ran: nothing is exec'd there.
            exec: (argv) => {
              if (argv.length !== 1 || argv[0] !== "true") return undefined;
              if (!finalRan) return { exitCode: 0, stdout: "", stderr: "" };
              firstLookAt ??= Date.now();
              return { exitCode: 1, stdout: "", stderr: "admission closed" };
            },
            flush: () =>
              Effect.gen(function* () {
                // A suspend flush after the final stages a capture on top of it.
                if (kinds.at(-1) === "suspend" && finalRan && worktree !== null) {
                  const epoch = memory.leases.get(worktree)?.epoch ?? 0;
                  yield* shipHarnessCapture(
                    dir,
                    memory,
                    worktree,
                    epoch,
                    crypto.randomUUID(),
                    "suspend",
                  ).pipe(Effect.orDie);
                }
                const headN = worktree === null ? 0 : (memory.chains.get(worktree)?.headN ?? 0);
                return finalRan ? completedStatus(headN) : flushReport(0, headN);
              }),
            ...(statusAnswers
              ? {
                  captureStatus: () =>
                    Effect.sync(() => {
                      const headN =
                        worktree === null ? 0 : (memory.chains.get(worktree)?.headN ?? 0);
                      return finalRan ? completedStatus(headN) : flushReport(0, headN);
                    }),
                }
              : {}),
          },
        ),
      },
    );
  };

  it(
    "a final flush run inside the executor, then Mend's stop: the executor's `complete` is the save, the line leaves `running` at once, and it ends `stopped`, never `failed · executor lost`",
    { timeout: 30_000 },
    m3(true),
  );

  it(
    "the same with no status read (an older SDK): the stop's drain is re-checked on every look, and a settled `stopped` is never overwritten with `failed`",
    { timeout: 30_000 },
    m3(false),
  );

  it(
    "decision 7: a final flush that answers `changed` is not saved; the drain asks again and ends the executor only on a completed answer",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const kinds: CaptureFlushKind[] = [];
      const stops: Array<"drain" | "discard"> = [];
      const memory = makeMemoryCaptureStore();
      let answered = 0;
      let answeredAtStop = -1;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(() => stops.length > 0, "the stop");
            expect(answeredAtStop).toBeGreaterThanOrEqual(2);
            expect(world.sessions.get(session.id)?.captureNotSavedAt ?? null).toBeNull();
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              flushKinds: kinds,
              stops,
              stopAnswer: () => {
                answeredAtStop = answered;
                return "stopped";
              },
              finalCompletion: "unreported",
              flush: () =>
                Effect.sync(() => {
                  answered += 1;
                  return answered === 1
                    ? { ...flushReport(0, 1), complete: false, incompleteReason: "changed" }
                    : { ...flushReport(0, 1), complete: true };
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "decision 7: a completed FINAL answered a moment ago is asked again before the executor ends: complete means current",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const kinds: CaptureFlushKind[] = [];
      const stops: Array<"drain" | "discard"> = [];
      const memory = makeMemoryCaptureStore();
      const finals = () => kinds.filter((kind) => kind === "final").length;
      let round = false;
      let inRound = 0;
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
            // The kept round: its first FINAL (the settle harvest's) completes, then the disk
            // changes. The drain does not end the executor on the harvest's answer: it asks again
            // and hears `changed`.
            round = true;
            const before = finals();
            yield* Effect.sleep(Duration.millis(350));
            yield* engine.reapCaptureLeases();
            yield* until(() => finals() - before >= 2, "the kept round's FINALs");
            yield* Effect.sleep(Duration.millis(200));
            expect(stops).toEqual([]);
          }),
        {
          captured: memory,
          drainPolicy: {
            keptRetryFirst: Duration.millis(300),
            keptRetryMax: Duration.seconds(5),
          },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              flushKinds: kinds,
              stops,
              finalCompletion: "unreported",
              flush: () =>
                Effect.sync(() => {
                  if (!round) {
                    return {
                      ...flushReport(0, 1),
                      complete: false,
                      incompleteReason: "snapshot-failed",
                      lastSnapError: "EACCES: permission denied",
                    };
                  }
                  inRound += 1;
                  return inRound === 1
                    ? { ...flushReport(0, 1), complete: true }
                    : { ...flushReport(0, 1), complete: false, incompleteReason: "changed" };
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "a kept round sends one FINAL: the settle harvest reuses the drain's answer",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const kinds: CaptureFlushKind[] = [];
      const memory = makeMemoryCaptureStore();
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
            yield* Effect.sleep(Duration.millis(100));
            const finals = () => kinds.filter((kind) => kind === "final").length;
            expect(finals()).toBe(1);
            for (const round of [1, 2]) {
              yield* Effect.sleep(Duration.millis(350 * round));
              const before = finals();
              yield* engine.reapCaptureLeases();
              yield* until(() => finals() > before, `kept round ${round}`);
              yield* Effect.sleep(Duration.millis(200));
              expect(finals() - before, `FINALs in kept round ${round}`).toBe(1);
            }
          }),
        {
          captured: memory,
          drainPolicy: {
            keptRetryFirst: Duration.millis(300),
            keptRetryMax: Duration.seconds(5),
          },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              flushKinds: kinds,
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  complete: false,
                  incompleteReason: "snapshot-failed",
                  lastSnapError: "EACCES: permission denied",
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "a discard records what Mend knows — last save, snaps failing since, the error, no completed final — and the line's time is when it was asked",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const failingSince = Date.parse("2026-09-27T19:55:02.000Z");
      let stopAskedAt: number | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const saved = yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
              "auto",
            );
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            const askedAt = Date.now();
            const result = yield* engine.discardUnsavedAndStop(session.id, "Ada Lovelace");
            const { facts } = result;
            expect(facts.requestedAt.getTime()).toBeGreaterThanOrEqual(askedAt);
            expect(result.discardedAt.getTime() - facts.requestedAt.getTime()).toBeGreaterThan(250);
            expect(facts.lastSaved?.n).toBe(saved.manifest.n);
            expect(facts.failingSince?.getTime()).toBe(failingSince);
            expect(facts.failingError).toBe("EACCES: permission denied");
            expect(facts.finalCompleted).toBeNull();
            expect(facts.queue?.pending).toBe(0);
            expect(facts.workspaceId).toBe("workspace-1");
            // What the audit keeps: no `0 pending` for edits a failing snap never staged.
            const data = captureDiscardAuditData(facts, result.discardedAt);
            expect(data["pending"]).toBeNull();
            expect(data["lastSavedN"]).toBe(saved.manifest.n);
            expect(data["finalCompleted"]).toBe(false);
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the settle after the discard",
            );
            // The line says when the discard was asked, not when it was recorded.
            expect(world.sessions.get(session.id)?.captureDiscardedAt?.getTime()).toBe(
              facts.requestedAt.getTime(),
            );
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.seconds(3) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: (discard) => {
                if (discard) stopAskedAt ??= Date.now();
                return discard ? "requested" : "kept";
              },
              // The discarding stop takes a moment to be observed.
              status: () =>
                stopAskedAt !== null && Date.now() - stopAskedAt > 300 ? "stopped" : "ready",
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  complete: false,
                  incompleteReason: "snapshot-failed",
                  lastSnapError: "EACCES: permission denied",
                  snapFailingSinceUnixMs: failingSince,
                }),
            },
          }),
        },
      );
    },
  );
});

/** The store's sealed records, by `<worktree>:<epoch>` (`CaptureSeals`). */
const memorySeals = (records: Map<string, CaptureCompletionSeal>): Layer.Layer<CaptureSeals> =>
  Layer.succeed(CaptureSeals, {
    sealedCompletion: (worktreeId, executorId, epoch) =>
      Effect.sync(() => {
        const seal = records.get(`${worktreeId}:${epoch}`) ?? null;
        return seal !== null && seal.executorId === executorId ? seal : null;
      }),
  });

describe("SessionEngine lifecycle, second review (2026-09-28)", () => {
  it(
    "#13 a `docker stop` whose sealed final capture registered last reads saved, from the store's seal for that executor and epoch",
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
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const built = yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              crypto.randomUUID(),
              "final",
            );
            // A seal another epoch holds says nothing of this executor.
            records.set(`${session.worktreeId}:${epoch + 1}`, {
              worktreeId: session.worktreeId,
              epoch: epoch + 1,
              executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
            });
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
              captureId: built.id,
              n: built.manifest.n,
              sealedAt: new Date(),
            });
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
            expect(settled?.status).toBe("stopped");
            expect(settled?.summary).toBe(
              `stopped outside Mend · saved at ${records
                .get(`${session.worktreeId}:${epoch}`)
                ?.sealedAt.toISOString()
                .slice(11, 19)} UTC · capture ${built.manifest.n}`,
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

  it(
    "#13 a stop whose final flush answer was lost terminates on the store's seal, and the stop tells Core the completion it sealed",
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
              sealedAt: new Date(),
            });
            yield* engine.stop(session.id);
            yield* until(() => stopOptions.length > 0, "the stop");
            // Core names the executor by its runtime identity, recorded at launch.
            expect(stopOptions[0]?.completion).toEqual({
              captureN: built.manifest.n,
              epoch,
              executorId: "container-7f3a",
              launchId: world.executorLaunches.get(session.id)?.launchId,
              sealedAt: records.get(`${session.worktreeId}:${epoch}`)?.sealedAt.toISOString(),
            });
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopOptions,
              resourceId: () => "container-7f3a",
              // The answer never says `complete` (the relay closed, SDK 0.37.2).
              finalCompletion: "unreported",
            },
          }),
        },
      );
    },
  );

  it(
    "#13 a seal with no runtime identity to name sends no completion: Core keeps what it cannot bind",
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
              sealedAt: new Date(),
            });
            yield* engine.stop(session.id);
            yield* until(() => stopOptions.length > 0, "the stop");
            expect(stopOptions[0]?.completion).toBeUndefined();
          }),
        {
          captured: memory,
          seals: memorySeals(records),
          // SDK 0.37.2: no `details()`, so no runtime identity.
          sealantLayer: lifecycleLayer(created, {
            captureOps: { stopOptions, finalCompletion: "unreported" },
          }),
        },
      );
    },
  );

  it(
    "a stop the platform answers by keeping the executor for recovery is not an end: `not saved · executor kept for recovery`, the lease stays",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept drain",
            );
            const kept = world.sessions.get(session.id);
            expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
              "not saved · executor kept for recovery · exited before its final flush completed · 0 pending",
            );
            expect(kept?.settledAt).toBeNull();
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
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
    "#13 without a seal, a stop never attests a completion Core did not observe",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            yield* until(() => stopOptions.length > 0, "the stop");
            expect(stopOptions[0]?.completion).toBeUndefined();
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, { captureOps: { stopOptions } }),
        },
      );
    },
  );

  it(
    "#14 a landing is refused while the executor's small snapshot carries an unreadable path, however empty its queue, and taken once it reads again",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let readable = false;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
            const refused = yield* engine
              .landingCheckpoint(session.id, "user-mark")
              .pipe(Effect.flip);
            expect(refused._tag).toBe("CapturesBehindError");
            expect(world.sessions.get(session.id)?.captureFailingError).toContain("unreadable");
            readable = true;
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("flushed");
            const taken = yield* engine.landingCheckpoint(session.id, "user-mark");
            expect(taken.captureId).toBe(memory.chains.get(session.worktreeId)?.headCapture);
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed(
                  readable
                    ? flushReport(0, 1)
                    : {
                        ...flushReport(0, 1),
                        lastSnapError: "unreadable current source file",
                        snapFailingSinceUnixMs: Date.now(),
                        unreadable: 1,
                        carried: 1,
                        unreadablePaths: ["tree/app.ts"],
                      },
                ),
            },
          }),
        },
      );
    },
  );

  it(
    "review 3 #17 a suspend flush whose small snapshot carried an unreadable path logs partial · unreadable, never completed",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const logs: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            logs.length = 0;
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
            const flushed = logs.filter((line) => line.includes("capture flush ·"));
            expect(flushed).toEqual([
              "session engine: capture flush · partial · unreadable · observed",
            ]);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  lastSnapError: "unreadable current source file",
                  snapFailingSinceUnixMs: Date.now(),
                  unreadable: 1,
                  carried: 1,
                  unreadablePaths: ["tree/app.ts"],
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "review 3 #16 a flush answer that does not report snapshot health (SDK 0.37.2's facade) holds a landing: partial · snapshot health not reported",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const logs: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            logs.length = 0;
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
            expect(logs.filter((line) => line.includes("capture flush ·"))).toEqual([
              "session engine: capture flush · partial · snapshot health not reported · observed",
            ]);
            const refused = yield* engine
              .landingCheckpoint(session.id, "user-mark")
              .pipe(Effect.flip);
            expect(refused._tag).toBe("CapturesBehindError");
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              // Exactly the fields `@sealant/sdk` 0.37.2's `capture.flush()` rebuilds.
              flush: () =>
                Effect.succeed({
                  epoch: 2,
                  worktreeId: "",
                  pending: 0,
                  stagedBytes: 0,
                  uploadedObjects: 1,
                  uploadedBytes: 1000,
                  registered: 1,
                  fenced: false,
                  paused: false,
                }),
            },
          }),
        },
      );
    },
  );

  it(
    "#14 a failing bulk snap does not hold up a landing that needs only the small class",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("flushed");
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  lastSnapError: "EACCES: node_modules/.cache",
                  snapFailingSinceUnixMs: Date.now(),
                  snaps: [
                    { class: "small", snapsFailed: 0 },
                    {
                      class: "bulk",
                      snapsFailed: 2,
                      lastSnapError: "EACCES: node_modules/.cache",
                      snapFailingSinceUnixMs: Date.now(),
                    },
                  ],
                }),
            },
          }),
        },
      );
    },
  );
  it(
    "#7 a custom setup that fails after the create leaves the executor on the row: it holds removal, keeps its lease and drains; Core keeping it keeps everything",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const events: string[] = [];
      const stops: Array<"drain" | "discard"> = [];
      const kinds: CaptureFlushKind[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(failed._tag).toBe("SessionLaunchSetupError");
            expect(created).toHaveLength(1);
            // Addressable from the moment the platform accepted it, before the setup ran.
            expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            // Drained (a final flush), never stopped outright; Core keeps it.
            yield* until(() => stops.length > 0, "the drain's stop");
            expect(kinds).toContain("final");
            expect(stops).toEqual(["drain"]);
            const holds = yield* engine.captureHolds(session.worktreeId);
            expect(holds.map((hold) => hold.sessionId)).toContain(session.id);
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            expect(world.sessions.has(session.id)).toBe(true);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.millis(300) },
          workspaceImage: {
            ...CUSTOM_BASE,
            setupCommands: ["printf work > /workspace/repo/valuable.txt; exit 1"],
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              stops,
              flushKinds: kinds,
              stopAnswer: () => "kept",
              status: () => "ready",
              exec: (argv) =>
                argv.includes("printf work > /workspace/repo/valuable.txt; exit 1")
                  ? { exitCode: 1, stdout: "", stderr: "setup failed after writing" }
                  : undefined,
            },
          }),
        },
      );
    },
  );

  it(
    "#7 once that executor saved and ended, the session settles failed with the setup's own words — never an earlier run's outcome",
    { timeout: 30_000 },
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
              () =>
                stops.length > 0 &&
                world.sessions.get(session.id)?.settledAt != null &&
                world.sessions.get(session.id)?.captureDrain === null,
              "the drained session's settle",
            );
            const settled = world.sessions.get(session.id);
            expect(stops).toEqual(["drain"]);
            expect(settled?.status).toBe("failed");
            expect(settled?.summary).toMatch(/^launch failed: setup command failed \(exit 1\)/);
            // It was saved after all, and says so beside the launch's own words (e2e run 6 #7).
            expect(settled?.summary).toMatch(/ · saved at \d\d:\d\d:\d\d UTC( · capture \d+)?$/);
            // Its end observed: the lease is released.
            expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
          }),
        {
          captured: memory,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: ["exit 1"] },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stops,
              stopAnswer: () => "stopped",
              exec: (argv) =>
                argv.includes("exit 1") ? { exitCode: 1, stdout: "", stderr: "" } : undefined,
            },
          }),
        },
      );
    },
  );

  it(
    "#7 a harness PTY the platform refuses after the create leaves the executor on the row, draining",
    { timeout: 30_000 },
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
            yield* until(() => stops.length > 0, "the drain's stop");
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
          }),
        {
          captured: memory,
          drainPolicy: { terminationWait: Duration.millis(300) },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stops,
              stopAnswer: () => "kept",
              status: () => "ready",
              openFails: () => true,
            },
          }),
        },
      );
    },
  );

  it(
    "#7 a lease that names a session with no workspace on its row is unresolved ownership: it holds removal and the worktree, lapsed or not",
    { timeout: 30_000 },
    async () => {
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            // The launch claimed the worktree; the platform's create answer never reached the row.
            yield* Effect.gen(function* () {
              const repo = yield* CaptureStoreRepo;
              yield* repo.init(session.worktreeId);
              yield* repo.claim(session.worktreeId, session.id, 30);
            }).pipe(Effect.provide(memory.layer));
            expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBeNull();
            const holds = yield* engine.captureHolds(session.worktreeId);
            expect(holds).toEqual([{ sessionId: session.id, kind: "lease" }]);
            expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
            expect(world.sessions.has(session.id)).toBe(true);
            // Lapsed: still nobody's end.
            const lease = memory.leases.get(session.worktreeId);
            if (lease !== undefined) lease.expiresAt = memory.clock.now() - 1000;
            expect(yield* engine.captureHolds(session.worktreeId)).toEqual([
              { sessionId: session.id, kind: "lease" },
            ]);
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            const refused = yield* engine.launch(second.id, ["claude"]).pipe(Effect.flip);
            expect(refused._tag).toBe("SealantPlatformError");
            expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            yield* engine.reapCaptureLeases();
            yield* Effect.sleep(Duration.millis(100));
            expect(world.sessions.has(session.id)).toBe(true);
          }),
        { captured: memory, sealantLayer: lifecycleLayer([]) },
      );
    },
  );

  it(
    "#16 a restart serves the channel of every session a lease names: a stopped owner whose joined session still works keeps shipping",
    { timeout: 30_000 },
    async () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-review2-joined-restart-")),
      };
      const memory = makeMemoryCaptureStore();
      let ownerId: SessionId | null = null;
      let joinedId: SessionId | null = null;
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              ownerId = session.id;
              yield* engine.launch(session.id, ["codex"]);
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              joinedId = second.id;
              yield* engine.launch(second.id, ["claude"]);
              yield* engine.stop(session.id);
              yield* until(
                () => world.sessions.get(session.id)?.settledAt != null,
                "owner settles",
              );
              yield* Effect.sleep(Duration.millis(300));
              expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              expect(world.sessions.get(second.id)?.status).toBe("running");
            }),
          { fixture, captured: memory, sealantLayer: lifecycleLayer([]) },
        );
        servedSocketApis.clear();
        await withEngine(
          () =>
            Effect.gen(function* () {
              yield* SessionEngine;
              expect([...servedSocketApis.keys()]).toContain(joinedId);
              expect([...servedSocketApis.keys()]).toContain(ownerId);
            }),
          { fixture, captured: memory, sealantLayer: lifecycleLayer([]) },
        );
      } finally {
        fs.rmSync(fixture.tmp, { recursive: true, force: true });
      }
    },
  );
  it(
    "#9 a recovered opening prompt whose correlated process ended before it took the turn launches again and is delivered; the plan clears only then",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const submitted: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
            if (process === undefined) throw new Error("missing process");
            // The crash point: the relaunched process row carries the correlation, its opening
            // turn was never submitted, and the process has since ended.
            world.processes.set(
              process.id,
              new SessionProcess({
                ...process,
                kind: "agent-protocol",
                launchCorrelationId: "review2-opening-prompt",
                exitedAt: new Date(),
              }),
            );
            world.relaunches.set(
              session.id,
              JSON.stringify({
                kind: "launch",
                argv: ["codex"],
                launchCorrelationId: "review2-opening-prompt",
                start: { mode: "protocol", prompt: "preserve this opening instruction" },
                author: "user-fixture",
                resumeId: null,
              }),
            );
            yield* engine.reapCaptureLeases();
            yield* until(() => submitted.length > 0, "the opening turn");
            yield* until(() => !world.relaunches.has(session.id), "the plan's clear");
            expect(submitted).toEqual(["preserve this opening instruction"]);
            expect(created).toHaveLength(2);
            const live = [...world.processes.values()].filter(
              (p) => p.sessionId === session.id && p.exitedAt === null,
            );
            expect(live).toHaveLength(1);
            expect(live[0]?.launchCorrelationId).toMatch(/^relaunch:/);
          }),
        {
          captured: memory,
          protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
          sealantLayer: lifecycleLayer(created),
        },
      );
    },
  );

  it(
    "#9 an opening prompt its correlated process cannot take now stays planned and the session says so",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
            if (process === undefined) throw new Error("missing process");
            // Live, but nothing here hosts it (not reattached yet): nobody can take the turn.
            world.processes.set(
              process.id,
              new SessionProcess({
                ...process,
                kind: "agent-protocol",
                launchCorrelationId: "review2-unhosted",
              }),
            );
            world.relaunches.set(
              session.id,
              JSON.stringify({
                kind: "launch",
                argv: ["codex"],
                launchCorrelationId: "review2-unhosted",
                start: { mode: "protocol", prompt: "keep me" },
                author: "user-fixture",
                resumeId: null,
              }),
            );
            yield* engine.reapCaptureLeases();
            yield* until(
              () =>
                world.sessions
                  .get(session.id)
                  ?.summary?.startsWith("opening prompt not delivered") === true,
              "the retained plan's words",
            );
            yield* Effect.sleep(Duration.millis(100));
            expect(world.relaunches.has(session.id)).toBe(true);
            expect(created).toHaveLength(1);
          }),
        { captured: memory, sealantLayer: lifecycleLayer(created) },
      );
    },
  );

  it(
    "#9 a live, hosted protocol agent takes the opening turn when the correlated row has ended",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const submitted: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
            if (process === undefined) throw new Error("missing process");
            world.processes.set(
              process.id,
              new SessionProcess({
                ...process,
                kind: "agent-protocol",
                launchCorrelationId: "review2-stale",
                exitedAt: new Date(),
              }),
            );
            const replacement = SessionProcessId.make(crypto.randomUUID());
            world.processes.set(
              replacement,
              new SessionProcess({
                ...process,
                id: replacement,
                kind: "agent-protocol",
                launchCorrelationId: null,
              }),
            );
            world.relaunches.set(
              session.id,
              JSON.stringify({
                kind: "launch",
                argv: ["codex"],
                launchCorrelationId: "review2-stale",
                start: { mode: "protocol", prompt: "to the live one" },
                author: "user-fixture",
                resumeId: null,
              }),
            );
            yield* engine.reapCaptureLeases();
            yield* until(() => !world.relaunches.has(session.id), "the plan's clear");
            expect(submitted).toEqual(["to the live one"]);
            expect(created).toHaveLength(1);
          }),
        {
          captured: memory,
          protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
          sealantLayer: lifecycleLayer(created),
        },
      );
    },
  );
  it(
    "a planned drain counts back from the platform's own deadline once the SDK reports it (review 2026-09-28, `platformDeadline: null`)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      let asked = 0;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              crypto.randomUUID(),
            );
            yield* engine.reapCaptureLeases();
            yield* until(() => asked > 0, "the deadline read");
            yield* Effect.sleep(Duration.millis(50));
            // The cap is 60 s away, inside the 600 s lead: the replacement is due now.
            yield* engine.reapCaptureLeases();
            yield* until(() => created.length === 2, "the replacement launch");
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              runtimeDeadline: () => {
                asked += 1;
                return new Date(Date.now() + 60_000);
              },
            },
          }),
        },
      );
    },
  );

  it(
    "an agent whose executor never answered any look does not report the harness's `completed`: its fate is unknown (review 2026-09-28)",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
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
            // The harness exits 0; the platform still says `ready`, and no exec is answered.
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            yield* until(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the session's settle",
            );
            yield* Effect.sleep(Duration.millis(100));
            const settled = world.sessions.get(session.id);
            expect(settled?.status).toBe("failed");
            expect(settled?.summary).toMatch(
              /^executor not answering · (nothing saved|last saved capture \d+ at \d\d:\d\d:\d\d UTC) · completion unknown$/,
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
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              // The executor answers nothing at all: no exec, no flush.
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
                  lastSnapError: null,
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
    "`executor not answering · … · completion unknown`, then Core ends the kept executor on the seal Mend attested and it accepted: `stopped · saved at … · capture N`",
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
            expect(world.sessions.get(session.id)?.summary).toMatch(/completion unknown$/);
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
  it(
    "review 6 #6 while an answer of the executor is in flight, its seal is not attested; once recorded, it is",
    { timeout: 45_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
      const logs: Array<string> = [];
      const gate = Deferred.makeUnsafe<void>();
      let sealed = false;
      let held = 0;
      await withEngine(
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
              sealedAt: new Date(),
              ...SEAL_STAMP,
            });
            sealed = true;
            // A status read of the executor is asked, and its answer held on the way.
            yield* engine.refreshCaptureStatus(session.id);
            yield* until(() => held > 0, "the status answer in flight");
            yield* Effect.forkChild(engine.stop(session.id));
            yield* until(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the owner's drain reads not saved while the answer is in flight",
            );
            expect(stopOptions.some((options) => options?.completion !== undefined)).toBe(false);
            expect(logs.some((line) => line.includes("is not recorded yet"))).toBe(true);
            // The answer arrives (nothing unsaved) and is recorded: the kept drain, asking again
            // on its backoff (10 s first), attests the seal for its lost FINAL answer.
            yield* Deferred.succeed(gate, undefined);
            for (let i = 0; i < 3_500; i++) {
              if (stopOptions.some((options) => options?.completion !== undefined)) break;
              yield* Effect.sleep(Duration.millis(10));
            }
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
                held += 1;
                return Deferred.await(gate).pipe(Effect.as(flushReport(0, 0)));
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
    },
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
              failUnsavedEvidenceWrite = true;
              yield* engine.refreshCaptureStatus(session.id);
              yield* Effect.sleep(Duration.millis(50));
              sample = null;
              expect(world.executorEvidence.get("workspace-1")?.unsaved ?? []).toEqual([]);
            }),
          { fixture, captured: memory, seals: memorySeals(records), sealantLayer },
        );
        failUnsavedEvidenceWrite = false;
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
        failUnsavedEvidenceWrite = false;
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
