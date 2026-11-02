import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { DopplerRepo } from "@mend/db";
import {
  AgentConversationRepo,
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
  type PreviewGatewaySnapshot,
  PreviewsRepo,
  ProjectLinkNotFoundError,
  SessionRepositoriesRepoMemory,
  ProjectSecretsRepo,
  ProjectServiceRecipesRepo,
  ProjectsRepo,
  ReferenceNotFoundError,
  ReferencesRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  decideSetupClaim,
  SetupRunsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
  SessionGitOpsRepo,
  SessionNotFoundError,
  SessionPagesRepo,
  SessionProcessesRepo,
  SessionRunActiveError,
  SessionRunsRepo,
  SessionsRepo,
  SettingsRepo,
  AgentMemoryRepo,
  AuditEventsRepo,
  type NewAuditEvent,
  PiProfilesRepo,
  SecretFilesRepo,
  SkillsRepo,
  UserDotfilesRepo,
  UserAgentLoginsRepo,
  MessageSettingsRepo,
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
  HarnessLayoutsRepo,
  type HarnessLayoutsMemoryState,
  harnessLayoutsRepoMemory,
  WorktreeNotFoundError,
  type ExecutorCaptureEvidence,
  type AgentMemoryHomes,
  makeScreensMemory,
  ScreensRepo,
  RemovalFenced,
  RemovalFencesRepo,
  SessionAdmissionId,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  ProjectClusterBindingId,
  ProjectEnvironmentVariableId,
  OrganizationId,
  ProjectId,
  PreviewId,
  PreviewLabel,
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
import { DEFAULT_MESSAGE_SETTINGS, type MessageSettings } from "@mend/domain/workbench";
import {
  AgentTurn,
  Change,
  Checkpoint,
  Organization,
  OrganizationMember,
  Project,
  ProjectClusterBinding,
  ProjectClusterBindingsSnapshot,
  ProjectEnvironmentSnapshot,
  ProjectEnvironmentVariable,
  ProjectSecretsSnapshot,
  RepositoryCloneUrl,
  ResolvedGitAuthor,
  AgentLogins,
  changePreviewControl,
  type Preview,
  PREVIEW_CONTROL_INITIAL,
  type PreviewControl,
  type PreviewControlRead,
  previewGatewayResolution,
  previewResumeCandidate,
  type PreviewTarget,
  resolvePreviewBinding,
  selectPreviewTarget,
  Service,
  ServiceForward,
  ServiceObservation,
  Session,
  SessionProcess,
  SessionRun,
  Skill,
  SkillWithFiles,
  Worktree,
  type PageRef,
  type SessionExtraMount,
  type SessionReferenceMount,
  captureAnswerReplaces,
  withUnsavedAnswer,
  type CapturePosition,
  withoutAgentStarting,
} from "@mend/domain/workbench";
import type { AgentWait, HarnessLayout, ServiceLaunch } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  PersonLayoutPlatform,
  PersonLayoutPlatformNone,
  type PersonExecOptions,
  type PersonSessionOptions,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
  type WorkspaceByKey,
  type WorkspaceCreateFence,
  type LaunchedRuntime,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureDrainPolicy,
  type CaptureDrainPolicyShape,
  CaptureGitVerifier,
  CaptureGitVerifierOff,
  CaptureRemotesOff,
  CaptureSourcesOff,
  CaptureRuntimeLive,
  CaptureSeals,
  CaptureSealsNone,
  type PreviewUrls,
  PreviewUrlsNone,
  CaptureRuntimeOff,
  CaptureUploadPolicyDefault,
  DotfilesCloner,
  makeDotfilesClonerLayer,
  HARNESS_HOME_MOUNT_PATH,
  HARNESS_STATE,
  harvestHarnessStateScript,
  ProtocolHost,
  ForwardAdapter,
  ServiceHost,
  SessionEngine,
  SessionEngineLive,
  ResourceRuntimeNone,
  type ResourceRuntime,
  SealantClientByWorkspaceCreator,
  SessionRepositoryCapturedLive,
  SessionRepositoryLocalLive,
  type LaunchSlot,
  type SessionSocketApi,
  SessionSocketHost,
  WorkspaceCaller,
  WorkspaceCallerLive,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
  WorkspaceHostUserNamespaces,
  WorkspaceHostUserNamespacesUnobserved,
  secretFilesDeliveredExec,
} from "@mend/sessions";
import {
  AgentBridge,
  BlobStore,
  BlobStoreFsLive,
  DeploymentConfig,
  type ExecutorTransport,
  DotfilesStore,
  GitOpsRunnerLive,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
  DeploymentConfigColocated,
  harnessHomePathOf,
  makeSourcePolicy,
  SourcePolicy,
} from "@mend/store";
import type {
  CreateOptions,
  InteractiveSession,
  InteractiveSessionStatus,
  Run,
  SessionOptions,
  TimelineEntry,
  Workspace,
  WorkspaceCaptureDrain,
  WorkspaceCaptureOwnerMap,
  WorkspaceCaptureReplanned,
  WorkspaceCaptureStatus,
  WorkspacePhase,
  WorkspaceStatus,
} from "@sealant/sdk";
import { Clock, Duration, Effect, Fiber, Layer, Logger, Stream, type Scope } from "effect";

import { HarnessLayoutConfig } from "../../src/harness-layout-steps.ts";
import { ResourceStatusReads, ResourceStatusReadsNone } from "../../src/resources/status-reads.ts";
import { type MemoryCaptureStore } from ".././capture-store-memory.ts";
import { memoryStoreRefs } from ".././capture-world.ts";
import { adapterLayer, echo, fakeForward, scriptedSealant } from "../forward-fixture.ts";

/** What a daemon that reports snapshot health says when every path read (sealantd `Some(0)`). */
const readEverything: object = { unreadable: 0, carried: 0 };

/**
 * A daemon's capture answer with every field SDK 0.38.0 requires: an empty queue the registrar
 * refused nothing of, every path read, and whatever `fields` says over it.
 */
export const captureAnswer = (
  fields: Partial<WorkspaceCaptureStatus> = {},
): WorkspaceCaptureStatus => ({
  epoch: 0,
  worktreeId: "",
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 0,
  uploadedBytes: 0,
  registered: 0,
  fenced: false,
  paused: false,
  refused: [],
  ...readEverything,
  ...fields,
});

/** Every platform method dies — these tests exercise the platform-free paths. */
export const sealantDeadLayer = Layer.succeed(SealantClient, {
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
  forwardUdp: () => Effect.die("not in test"),
  openForward: () => Effect.die("not in test"),
  stopWorkspace: () => Effect.die("not in test"),
  captureFlush: () => Effect.die("not in test"),
  captureStatus: () => Effect.succeed(null),
  runtimeDeadline: () => Effect.succeed(null),
  bootedImage: () => Effect.succeed(null),
  runtimeResourceId: () => Effect.succeed(null),
  launchedRuntime: () => Effect.succeed("unknown" as const),
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

export const sessionPagesLayerOf = (
  pages: ReadonlyArray<PageRef> = [],
): Layer.Layer<SessionPagesRepo> =>
  Layer.succeed(SessionPagesRepo, {
    publish: () => Effect.die("not in test"),
    byId: () => Effect.succeed(null),
    refById: (id) => Effect.sync(() => pages.find((page) => page.id === id) ?? null),
    listForSession: (sessionId) =>
      Effect.sync(() => pages.filter((page) => page.sessionId === sessionId)),
  });

/** No pool in these worlds — claims miss and the boot sweep sees nothing. */
export const hotWorkspacesEmptyLayer = Layer.succeed(HotWorkspacesRepo, {
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

/** Shared settingsLayer fixture for engine scenarios. */
export const settingsLayer = (workspaceImage = defaultSettings.workspaceImage) =>
  Layer.succeed(SettingsRepo, {
    // Launches read what the project inherits (its organization's defaults over the instance's),
    // never the instance document alone.
    get: () => Effect.die("a launch read the instance settings instead of its organization's"),
    forOrganization: () => Effect.succeed(new MendSettings({ ...defaultSettings, workspaceImage })),
    modify: () => Effect.die("not in test"),
  });

/** The evidence side of a recorded exec — inert, only there to satisfy the SDK shape. */
export const fakeExecRun: Run = {
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

/** Shared sealantLaunchLayer fixture for engine scenarios. */
/** A launch slot always free: what the API's per-account slot is with room to spare. */
export const freeLaunchSlot: LaunchSlot = {
  take: (effect) => effect,
  refused: "no launch slot is free",
};

export const sealantLaunchLayer = (
  created: Array<CreateOptions>,
  /** A create refused for its accounts: `true` with the old words, or Core's own refusal. */
  rejectCredentials: (
    credentials: CreateOptions["credentials"],
  ) => boolean | SealantPlatformError = () => false,
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
  /** What the platform's `sessions.open` and Mend's `openSession` were each given. */
  openedOptions?: Array<SessionOptions | PersonSessionOptions>,
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
    /** Holds the platform's answer to a stop until it completes (a Core slow to stop the executor). */
    readonly aroundStop?: () => Effect.Effect<void>;
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
     * Holds an open of `argv` on the platform until it completes (a slow PTY start); `openFails`
     * is read once it does, so a held open can still fail.
     */
    readonly aroundOpen?: (
      argv: ReadonlyArray<string>,
      options: SessionOptions | PersonSessionOptions | undefined,
    ) => Effect.Effect<void>;
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
    /** Every create's `credentialsHome` (docs/adr/0016), as Mend sent it (`undefined`: none). */
    readonly createHomes?: Array<string | undefined>;
    /**
     * Every create's SSH user (docs/adr/0016, decision 10): with `sshAsOwner`, the home whose
     * owner's uid Core runs the sessions as (`credentialsHome`'s path); `undefined`: root.
     */
    readonly createSshUsers?: Array<string | undefined>;
    /** Every exec's user (docs/adr/0016): the login name it ran as, null for root. */
    readonly execUsers?: Array<string | null>;
    /** While true, a create's answer is lost (503) as if the control plane never answered. */
    readonly loseCreateAnswer?: () => boolean;
    /** `launch.runtime.resourceId` / `runtime()` (Core's next SDK); absent answers null, as on 0.37.2. */
    readonly resourceId?: () => string | null;
    /** Whether an executor ever ran (`launchedRuntime`); absent answers `unknown`, as on 0.37.2. */
    readonly launchedRuntime?: () => LaunchedRuntime;
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
    /** What a process opened with `argv` prints, line by line; nothing unless a test says. */
    readonly ptyOutput?: (argv: ReadonlyArray<string>) => ReadonlyArray<string>;
    /** A process opened with `argv` that prints its lines and then never ends. */
    readonly ptyKeepsRunning?: (argv: ReadonlyArray<string>) => boolean;
    /** The argv of each opened process whose terminal was closed, in order. */
    readonly closed?: Array<ReadonlyArray<string>>;
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
      options?: { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null },
    ) => Effect.Effect<WorkspaceCaptureReplanned, SealantPlatformError>;
    /** The image digest the workspace booted; absent: the platform cannot say. */
    readonly bootedImage?: () => string | null;
    /** While true, every workspace lookup fails the way an unreachable Core does (503). */
    readonly unreachablePlatform?: () => boolean;
    /** What the platform reports of the workspace, given whether a stop was asked of it. */
    readonly status?: (stopAsked: boolean) => WorkspaceStatus | undefined;
    /**
     * `workspace.captureDrain()` (SDK 0.38.0): what Core last observed of the drain. Absent, Core
     * recorded none (the engine reads that as it read a 0.37.2 handle without the method: kept).
     */
    readonly captureDrain?: () => WorkspaceCaptureDrain | null;
    /**
     * Stands in for a command inside the executor: an answer here wins over the defaults below
     * (undefined falls through), so a test can put files where only the workspace has them.
     */
    readonly exec?: (
      argv: ReadonlyArray<string>,
    ) =>
      | { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
      | undefined;
    /**
     * A command inside the executor as an effect, asked before `exec`: one that never answers, or
     * fails the way the platform does. Undefined falls through.
     */
    /** A workspace lookup by id as an effect, asked first: undefined falls through. */
    readonly getWorkspaceEffect?: (
      id: string,
    ) => Effect.Effect<Workspace, SealantPlatformError> | undefined;
    readonly execEffect?: (
      argv: ReadonlyArray<string>,
      options?: PersonExecOptions,
    ) =>
      | Effect.Effect<
          { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
          SealantPlatformError
        >
      | undefined;
    /**
     * The run's record as supervision streams it. Absent, supervision never gets the run (its
     * lookup never answers), as in every world that does not ask for it.
     */
    readonly record?: () => Stream.Stream<TimelineEntry, SealantPlatformError>;
    /** The run as the platform settles it once its record ends. */
    readonly waitRun?: () => Effect.Effect<Run, SealantPlatformError>;
    /** Core's launch phase while the create gets ready (sealant#342); null: none reported. */
    readonly phase?: () => WorkspacePhase | null;
    /**
     * A run's full timeline (`recordTimeline`), by run id: what sealantd recorded, its
     * `processStarted` pid included. Absent, a timeline never answers.
     */
    readonly timeline?: (runId: string) => ReadonlyArray<TimelineEntry>;
  },
) => {
  let nextPty = 0;
  const ptys = new Map<string, InteractiveSession>();
  const argvOfPty = new Map<string, ReadonlyArray<string>>();
  const openPty = (
    mode: "pty" | "pipe" = "pty",
    printed: ReadonlyArray<string> = [],
    keepsRunning = false,
  ): InteractiveSession => {
    nextPty += 1;
    const pty: InteractiveSession = {
      id: `pty-${nextPty}`,
      workspaceId: "workspace-1",
      runId: `run-${nextPty}`,
      mode,
      send: async () => undefined,
      output: async function* () {
        for (const [at, line] of printed.entries()) {
          yield { sequence: BigInt(at), data: new TextEncoder().encode(`${line}\n`) };
        }
        if (keepsRunning) await new Promise(() => undefined);
      },
      resize: async () => undefined,
      signal: async () => undefined,
      status: async () => ptyStates?.get(pty.id) ?? { status: "running", outputHighWater: 0n },
      close: async () => void captureOps?.closed?.push(argvOfPty.get(pty.id) ?? []),
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
    // The engine reads the deadline, the executor and the drain through the fake client below.
    runtimeDeadline: async () => null,
    runtime: async () => null,
    processUser: async () => "supported",
    sshAsRoot: async () => {},
    phase: async () => captureOps?.phase?.() ?? null,
    launch: undefined,
    recover: async () => {
      throw new Error("not in test");
    },
    captureDrain: async () => captureOps?.captureDrain?.() ?? null,
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
      status: async () => {
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
    // The engine stops through `stopWorkspace` below; the handle's own stop is not in test.
    stop: async () => ({ state: "stopped" }),
    restart: async function () {
      return this;
    },
    expire: async () => undefined,
    image: async () => null,
    dotfiles: { apply: async () => new Promise(() => {}) },
    credentials: {
      put: async () => {
        throw new Error("not in test");
      },
      release: async () => {
        throw new Error("not in test");
      },
      list: async () => [],
      prune: async () => {
        throw new Error("not in test");
      },
    },
  };
  return Layer.succeed(SealantClient, {
    createWorkspace: (options, launch) =>
      Effect.suspend(() => {
        created.push(options);
        captureOps?.createKeys?.push(launch?.idempotencyKey);
        captureOps?.createLaunches?.push(launch?.launchId);
        captureOps?.createSshUsers?.push(
          launch?.sshAsOwner === true ? launch.credentialsHome?.path : undefined,
        );
        captureOps?.createHomes?.push(
          launch?.credentialsHome === undefined
            ? undefined
            : `${launch.credentialsHome.path} ${launch.credentialsHome.uid}:${launch.credentialsHome.gid}`,
        );
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
              ? Effect.suspend(() => {
                  const rejected = rejectCredentials(options.credentials);
                  if (rejected === false) return Effect.succeed(workspace);
                  return Effect.fail(
                    rejected === true
                      ? new SealantPlatformError({
                          code: "connected-account-not-found",
                          status: 400,
                          message: "connected account was not found",
                          cause: null,
                        })
                      : rejected,
                  );
                })
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
    getWorkspace: (id) =>
      captureOps?.getWorkspaceEffect?.(id) ??
      (rejectWorkspaceLookup()
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
          : Effect.succeed(workspace)),
    getRun: (runId) =>
      captureOps?.timeline !== undefined
        ? Effect.succeed({ ...fakeExecRun, id: runId })
        : captureOps?.record === undefined
          ? Effect.never
          : Effect.succeed(fakeExecRun),
    sessionOutput: () => Effect.die("not in test"),
    recordCommands: () => Effect.die("not in test"),
    recordScrollback: () => Effect.die("not in test"),
    runHarness: () => Effect.die("not in test"),
    startHarness: () => Effect.die("not in test"),
    startHarnessInWorkspace: () => Effect.die("not in test"),
    waitRun: () => captureOps?.waitRun?.() ?? Effect.die("not in test"),
    openSession: (_workspace, argv, options) =>
      (captureOps?.aroundOpen?.(argv, options) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.suspend(() =>
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
                  assertAgentNamesMendMcpOnce(argv);
                  captureOps?.beforeOpen?.(argv);
                  spawned?.push(argv);
                  if (options !== undefined) openedOptions?.push(options);
                  const pty = openPty(
                    options?.mode ?? "pty",
                    captureOps?.ptyOutput?.(argv),
                    captureOps?.ptyKeepsRunning?.(argv) === true,
                  );
                  argvOfPty.set(pty.id, argv);
                  return pty;
                }),
          ),
        ),
      ),
    forwardUdp: () => Effect.die("not in test"),
    openForward: () => Effect.die("not in test"),
    stopWorkspace: (target, options) =>
      (captureOps?.aroundStop?.() ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            stopped?.push(target.id);
            captureOps?.stops?.push(options?.discardUnsaved === true ? "discard" : "drain");
            captureOps?.stopOptions?.push(options);
            const answer =
              captureOps?.stopAnswer?.(options?.discardUnsaved === true) ?? "requested";
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
        ),
      ),
    captureFlush: (target, kind) =>
      Effect.gen(function* () {
        captureOps?.flushed?.push(`flush:${target.id}`);
        captureOps?.flushKinds?.push(kind);
        const answer: WorkspaceCaptureStatus =
          captureOps?.flush !== undefined ? yield* captureOps.flush(target) : captureAnswer();
        if (kind !== "final" || captureOps?.finalCompletion === "unreported") return answer;
        return { ...answer, ...finalCompletionOf(answer) };
      }),
    captureStatus: (target) =>
      captureOps?.captureStatus === undefined
        ? Effect.succeed(null)
        : captureOps.captureStatus(target),
    runtimeDeadline: () => Effect.sync(() => captureOps?.runtimeDeadline?.() ?? null),
    bootedImage: () => Effect.sync(() => captureOps?.bootedImage?.() ?? null),
    runtimeResourceId: () => Effect.sync(() => captureOps?.resourceId?.() ?? null),
    launchedRuntime: () => Effect.sync(() => captureOps?.launchedRuntime?.() ?? "unknown"),
    findWorkspaceByKey: (key) =>
      Effect.sync(() => captureOps?.findByKey?.(key) ?? { kind: "unsupported" as const }),
    fenceWorkspaceCreate: (key) =>
      Effect.sync(() => captureOps?.fenceCreate?.(key) ?? { kind: "unsupported" as const }),
    captureReplan: (target, options) =>
      captureOps?.replan === undefined
        ? Effect.die("capture.replan not in this test world")
        : captureOps.replan(target, options),
    expireWorkspace: renewWorkspace,
    getSession: (_workspace, id) => Effect.succeed(ptys.get(id) ?? initialPty),
    // Typed failure, not a defect: the settle-path harvest must degrade
    // quietly and still reach the workspace reap.
    exec: (_workspace, argv, options) =>
      Effect.suspend(() => {
        execCalls?.push(argv);
        captureOps?.execUsers?.push(options?.user?.name ?? null);
        const effect = captureOps?.execEffect?.(argv, options);
        if (effect !== undefined) {
          return effect.pipe(Effect.map((answer) => ({ ...answer, run: fakeExecRun })));
        }
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
        // The workspace file writer (`writeFilesPickupExec`): the executor redeems its ticket over
        // the channel its env names, as a real one does, and what it got is kept for the test.
        if (isPickupExec(argv) && argv[3] === "mend-write") {
          const channel = created.at(-1)?.env?.["MEND_SESSION_ID"];
          return redeemPickupExec(
            argv,
            channel === undefined ? null : SessionId.make(channel),
          ).pipe(
            Effect.map((answer) => {
              pickedUpWrites.set(argv, answer.files);
              return { exitCode: 0, stdout: "", stderr: "", run: fakeExecRun };
            }),
            Effect.catch((error) =>
              Effect.succeed({
                exitCode: 3,
                stdout: "",
                stderr: `mend-write: ${error.message}\n`,
                run: fakeExecRun,
              }),
            ),
          );
        }
        if (execCalls !== undefined) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "", run: fakeExecRun });
        }
        // A test executor's home holds no record of delivered secret files: the read every launch
        // makes before the harness home relocation (`evictReservedSecretFiles`) finds none.
        if (argv.join(" ") === secretFilesDeliveredExec.join(" ")) {
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
    recordStream: () => captureOps?.record?.() ?? Stream.fromEffect(Effect.never),
    recordTimeline: (run) =>
      captureOps?.timeline === undefined
        ? Stream.fromEffect(Effect.never)
        : Stream.fromIterable(captureOps.timeline(run.id)),
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
export const agentConversationStub: AgentConversationRepo["Service"] = {
  messageByClientId: () => Effect.succeed(null),
  messageById: () => Effect.die("message read not in this test"),
  admitSteerMessage: () => Effect.die("message admission not in this test"),
  admitTurnMessage: () => Effect.die("message admission not in this test"),
  withdrawMessageTurn: () => Effect.succeed(false),
  submitTurn: () => Effect.die("not in test"),
  byTurnId: () => Effect.succeed(null),
  byLaunchCorrelation: () => Effect.succeed(null),
  byProviderTurnId: () => Effect.succeed(null),
  listTurns: () => Effect.succeed([]),
  listConversationTurns: () => Effect.succeed([]),
  admitTurnSteer: () => Effect.die("not in test"),
  steerByClientId: () => Effect.succeed(null),
  settleTurnSteer: () => Effect.die("not in test"),
  queueTurnSteer: () => Effect.die("not in test"),
  withdrawTurnSteer: () => Effect.die("not in test"),
  recoverSendingSteers: () => Effect.void,
  recordProtocolControl: () => Effect.void,
  protocolControls: () => Effect.succeed([]),
  openTurns: () => Effect.succeed([]),
  claimNextTurn: () => Effect.succeed(null),
  openHarnessTurn: () => Effect.succeed({ _tag: "SlotHeld" }),
  unsentClaim: () => Effect.succeed(null),
  bindOwnSend: () => Effect.succeed(null),
  putBackOwn: () => Effect.succeed(null),
  failOwn: () => Effect.succeed(null),
  setTurnPayer: () => Effect.die("not in test"),
  failTurn: () => Effect.die("not in test"),
  failUnconfirmedTurn: () => Effect.die("not in test"),
  setTurnIntent: () => Effect.die("not in test"),
  claimTurnLanding: () => Effect.die("not in test"),
  decideTurnLanding: () => Effect.die("not in test"),
  completeTurn: () => Effect.succeed(null),
  upsertItem: () => Effect.die("not in test"),
  listItems: () => Effect.succeed([]),
  turnMessages: () => Effect.succeed([]),
  turnItems: () => Effect.succeed([]),
  openRequest: () => Effect.die("not in test"),
  byRequestId: () => Effect.succeed(null),
  listRequests: () => Effect.succeed([]),
  hasPendingRequests: () => Effect.succeed(false),
  taskActivity: () => Effect.succeed({ running: 0, lastUpdatedAt: null }),
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
};

export const recordedTurnsLayer = (
  turns: Array<AgentTurn>,
  beforeList: () => Effect.Effect<void> = () => Effect.void,
) =>
  Layer.succeed(AgentConversationRepo, {
    ...agentConversationStub,
    listTurns: (sessionId) =>
      beforeList().pipe(
        Effect.andThen(Effect.sync(() => turns.filter((turn) => turn.sessionId === sessionId))),
      ),
  });

export const completedTurnOf = (conversation: SessionProcess, input = "say hi") =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-completed-${conversation.id}`),
    sessionId: conversation.sessionId,
    processId: conversation.id,
    ordinal: 0,
    author: null,
    input,
    status: "completed",
    providerTurnId: `provider-turn-${conversation.id}`,
    error: null,
    usage: null,
    createdAt: now(),
    startedAt: now(),
    endedAt: now(),
  });

export const transcriptIn = (harness: "claude" | "codex", providerSessionId: string) =>
  harness === "claude"
    ? `.claude/projects/-workspace-repo/${providerSessionId}.jsonl`
    : `.codex/sessions/2026/10/24/rollout-2026-10-24T10-00-00-${providerSessionId}.jsonl`;

export const transcriptLine = (harness: "claude" | "codex", providerSessionId: string) =>
  `${JSON.stringify(
    harness === "claude"
      ? { type: "user", sessionId: providerSessionId, message: { role: "user", content: "say hi" } }
      : {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "text", text: "say hi" }] },
        },
  )}\n`;

export const writeHomeTranscript = (
  storePath: string,
  sessionId: string,
  harness: "claude" | "codex",
  providerSessionId: string,
) => {
  const file = path.join(
    harnessHomePathOf(storePath, sessionId),
    transcriptIn(harness, providerSessionId),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, transcriptLine(harness, providerSessionId));
};

export const harvestExecOf =
  (harness: "claude" | "codex", providerSessionId: string) => (argv: ReadonlyArray<string>) => {
    const shape = HARNESS_STATE[harness];
    if (shape === undefined) return undefined;
    if (argv[2] === harvestHarnessStateScript(shape.paths)) {
      return { exitCode: 0, stdout: "eA==", stderr: "" };
    }
    if (argv[2] === shape.latestTranscript) {
      return {
        exitCode: 0,
        stdout: `/home/agent/${transcriptIn(harness, providerSessionId)}\n`,
        stderr: "",
      };
    }
    if (argv[3] === "mend-read") {
      return { exitCode: 0, stdout: transcriptLine(harness, providerSessionId), stderr: "" };
    }
    return undefined;
  };

/** Shared agentConversationStubLayer fixture for engine scenarios. */
export const agentConversationStubLayer = Layer.succeed(
  AgentConversationRepo,
  agentConversationStub,
);

/** Shared protocolHostStubLayer fixture for engine scenarios. */
export const protocolHostStubLayer = Layer.succeed(ProtocolHost, {
  attach: () => Effect.die("not in test"),
  rehydrate: () => Effect.die("not in test"),
  submitTurn: () => Effect.die("not in test"),
  sendMessage: () => Effect.die("message send not in this test"),
  steerTurn: () => Effect.die("not in test"),
  interruptTurn: () => Effect.die("not in test"),
  respondRequest: () => Effect.die("not in test"),
  detach: () => Effect.void,
  has: () => Effect.succeed(false),
  quiescence: () => Effect.succeed(null),
  awaitQuiescent: () => Effect.void,
  endWork: () => Effect.void,
  detachForHandOver: () => Effect.void,
});

/** Shared recordingProtocolHostLayer fixture for engine scenarios. */
export const recordingProtocolHostLayer = (
  attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
  submitted: string[],
  authors: Array<string | null> = [],
  permissionModes: Array<"bypass" | "ask"> = [],
  /** Whose login each attached process's workspace launched with (docs/adr/0013). */
  launchLogins: Array<string | null> = [],
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, mode: input.pipe.mode });
        permissionModes.push(input.permissionMode);
        launchLogins.push(input.launchedWithLoginOf);
      }),
    rehydrate: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, mode: input.pipe.mode });
        launchLogins.push(input.launchedWithLoginOf);
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
    sendMessage: () => Effect.die("message send not in this test"),
    steerTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(true),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: () => Effect.void,
  });

/** Services bind no real sockets in these worlds. */
export const serviceHostStubLayer = Layer.succeed(ServiceHost, {
  bindAddresses: () => Effect.succeed(["127.0.0.1"]),
  start: () => Effect.succeed({ hostPort: 43127, boundAddresses: ["127.0.0.1"] }),
  hold: () => Effect.void,
  sever: () => Effect.void,
  stop: () => Effect.void,
});

export const forwardAdapterReadyLayer: Layer.Layer<ForwardAdapter> = adapterLayer(
  scriptedSealant(async () => fakeForward(echo).forward).layer,
);

/**
 * Session sockets bind nothing in these worlds; the api each session would serve is kept so a
 * test can play the executor (its capture routes) without a listener.
 */
export const servedSocketApis = new Map<SessionId, SessionSocketApi>();

/** Shared sessionSocketStubLayer fixture for engine scenarios. */
export const sessionSocketStubLayer = Layer.succeed(SessionSocketHost, {
  start: (sessionId, api) =>
    Effect.sync(() => {
      servedSocketApis.set(sessionId, api);
      return "/tmp/mend-test-socket-dir";
    }),
  stop: () => Effect.void,
});

/** What each pickup write exec redeemed, by the argv the platform was handed. */
export const pickedUpWrites = new WeakMap<
  ReadonlyArray<string>,
  ReadonlyArray<{ readonly path: string; readonly base64: string }>
>();

/** Whether an exec is one that redeems a pickup ticket (`pickup-tickets.ts`), its ticket at `argv[4]`. */
export const isPickupExec = (argv: ReadonlyArray<string>): boolean =>
  argv[0] === "sh" && (argv[2] ?? "").includes('"/pickup"');

/**
 * Redeem a pickup exec's ticket as the workspace would: over the channel of the session whose
 * socket (or token) the workspace holds, for `launchId` when the network channel names one.
 */
export const redeemPickupExec = (
  argv: ReadonlyArray<string>,
  channelSession: SessionId | null,
  launchId: string | null = null,
  accountId: string | null = null,
) => {
  const api = channelSession === null ? undefined : servedSocketApis.get(channelSession);
  const redeem = launchId === null ? api?.pickup : api?.pickupAs?.({ launchId, accountId });
  return redeem === undefined
    ? Effect.die(new Error("no pickup on this channel"))
    : redeem(argv[4] ?? "");
};

/** Which of their own logins each person's sessions get: every one, unless a test says. */
export const agentLoginsLayerOf = (selectedOnly: ReadonlySet<string> = new Set()) =>
  Layer.succeed(UserAgentLoginsRepo, {
    forUser: (userId) =>
      Effect.succeed(new AgentLogins({ selectedOnly: selectedOnly.has(userId) })),
    set: (_userId, setting) => Effect.succeed(setting),
  });

/** Core's refusal of a named account that needs reconnecting (`connected-account-invalid`). */
export const invalidAccount = (provider: "claude" | "codex") =>
  new SealantPlatformError({
    code: "connected-account-invalid",
    status: 409,
    message: `Connected ${provider} account "default" is invalid — reconnect it.`,
    provider,
    cause: null,
  });

/** Every account's git author is its registration name and email unless a test says. */
export const gitAuthorStubLayer = Layer.succeed(UserGitAuthorRepo, {
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

/** Shared userDotfilesStubLayer fixture for engine scenarios. */
export const userDotfilesStubLayer = Layer.succeed(UserDotfilesRepo, {
  repository: () => Effect.succeed(null),
  setRepository: (_userId: string, value: DotfilesRepository | null) => Effect.succeed(value),
  startAgentsAfterInstall: () => Effect.succeed(false),
  setStartAgentsAfterInstall: (_userId: string, value: boolean) => Effect.succeed(value),
});

/** Shared dotfilesStoreStubLayer fixture for engine scenarios. */
export const dotfilesStoreStubLayer = Layer.succeed(DotfilesStore, {
  snapshot: () => Effect.die("not in test"),
  current: () => Effect.succeed(null),
  archive: () => Effect.succeed(null),
  clear: () => Effect.void,
});

/** Shared skillsStubLayer fixture for engine scenarios. */
export const skillsStubLayer = Layer.succeed(SkillsRepo, {
  listForUser: () => Effect.succeed([]),
  listForProject: () => Effect.succeed([]),
  byId: () => Effect.die("not in test"),
  create: () => Effect.die("not in test"),
  update: () => Effect.die("not in test"),
  remove: () => Effect.die("not in test"),
  sync: () => Effect.die("not in test"),
  forLaunch: () => Effect.succeed({ user: [], project: [] }),
});

/** Shared piProfilesLayerOf fixture for engine scenarios. */
export const piProfilesLayerOf = (
  saved: PiProfilesRepo["Service"]["forUser"] = () => Effect.succeed(null),
): Layer.Layer<PiProfilesRepo> =>
  Layer.succeed(PiProfilesRepo, {
    forUser: saved,
    save: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
  });

/** The owner's secret files (docs/adr/0010); none unless a test brings some, sealed as the stub cipher seals. */
export const secretFilesLayerOf = (
  sealedForLaunch: SecretFilesRepo["Service"]["sealedForLaunch"] = () => Effect.succeed([]),
  list: SecretFilesRepo["Service"]["list"] = () => Effect.succeed([]),
): Layer.Layer<SecretFilesRepo> =>
  Layer.succeed(SecretFilesRepo, {
    sealedForLaunch,
    list,
    save: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
  });

/** The owner's agent memory; none stored, and every read-back recorded, unless a test says. */
export const agentMemoryLayerOf = (
  implement: Partial<AgentMemoryRepo["Service"]> = {},
  /** Whose memory each worktree's home holds, as the server records it (`agent_memory_homes`). */
  homes: Map<string, AgentMemoryHomes> = new Map(),
): Layer.Layer<AgentMemoryRepo> =>
  Layer.succeed(AgentMemoryRepo, {
    homeOf: (worktreeId) => Effect.sync(() => homes.get(worktreeId) ?? null),
    recordPendingHome: (worktreeId, home, epoch) =>
      Effect.sync(
        () =>
          void homes.set(worktreeId, {
            settled: homes.get(worktreeId)?.settled ?? null,
            pending: { ...home, epoch, n: null },
          }),
      ),
    notePendingHomePosition: (worktreeId, workspaceId, epoch, n) =>
      Effect.sync(() => {
        const current = homes.get(worktreeId);
        const pending = current?.pending ?? null;
        if (
          current === undefined ||
          pending === null ||
          pending.workspaceId !== workspaceId ||
          pending.epoch !== epoch ||
          pending.n !== null
        ) {
          return;
        }
        homes.set(worktreeId, { ...current, pending: { ...pending, n } });
      }),
    settleHome: (worktreeId, epoch) =>
      Effect.sync(() => {
        const pending = homes.get(worktreeId)?.pending ?? null;
        if (pending === null || pending.epoch !== epoch) return;
        homes.set(worktreeId, {
          settled: {
            userId: pending.userId,
            sessionId: pending.sessionId,
            workspaceId: pending.workspaceId,
          },
          pending: null,
        });
      }),
    forLaunch: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    read: () => Effect.succeed(null),
    remove: () => Effect.succeed(false),
    readBack: () => Effect.succeed({ saved: [], merged: [], deleted: [], skipped: [] }),
    importFiles: () =>
      Effect.succeed({
        added: [],
        unchanged: [],
        updated: [],
        merged: [],
        keptStored: [],
        removedInMend: [],
        conflicting: [],
        skipped: [],
      }),
    ...implement,
  });

/** Shared skillsForLaunchLayer fixture for engine scenarios. */
export const skillsForLaunchLayer = (
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

/** Shared mendKeysStubLayer fixture for engine scenarios. */
export const mendKeysStubLayer = Layer.succeed(MendKeys, {
  ensure: () =>
    Effect.succeed({
      publicKey: "ssh-ed25519 TEST",
      fingerprint: "256 SHA256:test",
      privateKeyPath: "/tmp/mend-test-key",
    }),
  read: () => Effect.succeed(null),
});

/** No signer is ever connected in these worlds. */
export const agentBridgeStubLayer = Layer.succeed(AgentBridge, {
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
export const dotfilesClonerLayer = (
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

export const assertAgentNamesMendMcpOnce = (argv: ReadonlyArray<string>): void => {
  const agent = argv.some(
    (arg) => arg === "claude" || arg === "codex" || /\bexec (?:claude|codex) /.test(arg),
  );
  if (!agent) return;
  const named =
    argv.join("\n").split(/"mcpServers":\{"mend"|mcp_servers\.mend\.command=/).length - 1;
  if (named !== 1 || argv.some((arg) => arg.includes("--strict-mcp-config"))) {
    throw new Error(
      `an agent started naming Mend's MCP server ${named} times: ${JSON.stringify(argv)}`,
    );
  }
};

/** Shared gitOpsStubLayer fixture for engine scenarios. */
export const gitOpsStubLayer = Layer.succeed(SessionGitOpsRepo, {
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

/** Host timestamp used by the fixture repository rows. */
export const now = () => new Date();

/** Shared launchSkill fixture for engine scenarios. */
export const launchSkill = (
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

/** Mutable repository state retained by one engine fixture. */
export interface World {
  readonly removedProjects: Set<ProjectId>;
  /** Repository timestamps follow the Clock of the engine scope that owns this world. */
  readonly clock: { now: () => Date };
  readonly projects: Map<string, Project>;
  readonly sessions: Map<string, Session>;
  readonly sessionRuns: Map<string, SessionRun>;
  readonly processes: Map<string, SessionProcess>;
  readonly services: Map<string, Service>;
  /** Who started each Service, as a person executor records it (docs/adr/0016). */
  readonly serviceStarters: Map<string, string>;
  readonly serviceForwards: Map<string, ServiceForward>;
  readonly serviceObservations: Map<string, ServiceObservation>;
  readonly reachedAttempts: Set<string>;
  /** Sessions a removal's mark covers: their starts are not admitted (`RemovalFencesRepo.admit`). */
  readonly removalMarkedSessions: Set<string>;
  /** Starts admitted and not yet ended, by admission id: the session each is for. */
  readonly admissions: Map<string, string>;
  /** Each Service attempt's recorded launch (`launch_cwd`, `launch_env`, `launch_ready`). */
  readonly launches: Map<string, ServiceLaunch>;
  readonly setupRuns: Array<WorldSetupRun>;
  /** Runs before a setup stamp is written, so a test can hold the write. */
  setupFinishing: (() => Effect.Effect<void>) | undefined;
  /** Runs after a setup stamp is written, before its answer, so a test can hold the reply. */
  setupFinished: (() => Effect.Effect<void>) | undefined;
  /** Screens and their displays (ADR 0020), as the store keeps them. */
  readonly screens: ScreensRepo["Service"];
  controlSeq: number;
  readonly previewActivity: Map<
    PreviewId,
    {
      previewId: PreviewId;
      lastAdmittedAt: Date | null;
      idleStoppedAttemptId: SessionProcessId | null;
      idleStoppedAt: Date | null;
      idleMinutes: number | null;
    }
  >;
  readonly previews: Map<string, Preview>;
  readonly previewControls: Map<string, PreviewControl>;
  readonly changes: Map<string, Change>;
  readonly checkpoints: Array<Checkpoint>;
  /** What `CheckpointsRepo.create` was given as the capture each row was observed from. */
  readonly checkpointCaptureIds: Map<string, string | null>;
  /** When set, `CheckpointsRepo.create` waits on it first: a store that does not answer. */
  readonly checkpointHold: { current: Promise<void> | null };
  /** When set, `setWaiting` awaits it first: whatever lands between a reader and its move. */
  readonly beforeWaitingMove: { current: (() => Promise<void>) | null };
  /** Inserts refused by the unique `(worktree_id, ordinal)` index — the fake counts them. */
  readonly checkpointConflicts: { count: number };
  /** Keyed by worktree id. */
  readonly worktrees: Map<string, Worktree>;
  /** Members of the fixture organization (`org-test`), by account. */
  readonly members: Map<string, "owner" | "member">;
  /** What Mend recorded in the organization's audit log, in order. */
  readonly audit: Array<NewAuditEvent>;
  /** Recent owners beyond the world's own sessions, as `recentOwnersForProject` adds them. */
  recentOwners: ReadonlyArray<string>;
  /** A planned relaunch's harness, by session (`planRelaunch`): bookkeeping off the row. */
  readonly relaunches: Map<string, string>;
  /** When set, `swapRelaunch` awaits it first, with the plan it is about to write. */
  readonly beforeRelaunchSwap: { current: ((next: string | null) => Promise<void>) | null };
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
/** The overdue step an observation reports, as the session's columns hold it (0093). */
const overdueFields = (observation: CaptureObservation) =>
  observation.overdue === undefined
    ? {}
    : {
        captureOverdueStep: observation.overdue?.step ?? null,
        captureOverdueSince: observation.overdue?.since ?? null,
        captureOverdueRunningMs: observation.overdue?.runningMs ?? null,
        captureOverdueBoundMs: observation.overdue?.boundMs ?? null,
      };

const newerObservation = <T extends { readonly position?: CapturePosition | null }>(
  next: T | undefined,
  prior: T | null,
) =>
  next !== undefined && (prior === null || captureAnswerReplaces(next.position, prior.position))
    ? next
    : prior;

/** Create an isolated in-memory engine repository world. */
export const makeWorld = (): World => ({
  removedProjects: new Set(),
  clock: { now },
  projects: new Map(),
  sessions: new Map(),
  sessionRuns: new Map(),
  processes: new Map(),
  services: new Map(),
  serviceStarters: new Map(),
  serviceForwards: new Map(),
  serviceObservations: new Map(),
  reachedAttempts: new Set(),
  removalMarkedSessions: new Set(),
  admissions: new Map(),
  launches: new Map(),
  setupRuns: [],
  setupFinishing: undefined,
  setupFinished: undefined,
  screens: makeScreensMemory(),
  controlSeq: 0,
  previewActivity: new Map(),
  previews: new Map(),
  previewControls: new Map(),
  changes: new Map(),
  checkpoints: [],
  checkpointCaptureIds: new Map(),
  checkpointHold: { current: null },
  beforeWaitingMove: { current: null },
  checkpointConflicts: { count: 0 },
  worktrees: new Map(),
  // Maria joins other people's executors in many worlds: a member, as only a member can be.
  audit: [],
  members: new Map([
    ["user-fixture", "member"],
    ["user-maria", "member"],
  ]),
  recentOwners: ["user-fixture"],
  relaunches: new Map(),
  beforeRelaunchSwap: { current: null },
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

/**
 * A session line as it reads once its agent has drawn: these worlds' records carry no output, so a
 * launched agent's starting words (`agentStartingWords`) stay on the line until something replaces
 * it; assertions about the rest of the line read it without them.
 */
export const drawnLine = (summary: string | null | undefined): string | null =>
  withoutAgentStarting(summary ?? null);

/** The repository's identity of a wait: its kind, tool and `since`. */
const sameWait = (held: AgentWait | null, expected: AgentWait | null) =>
  held === null || expected === null
    ? held === expected
    : held.kind === expected.kind &&
      held.tool === expected.tool &&
      held.since.getTime() === expected.since.getTime();

/** Shared sessionProcessesLayer fixture for engine scenarios. */
export const sessionProcessesLayer = (world: World) => {
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
        exitedAt: world.clock.now(),
        updatedAt: world.clock.now(),
        waiting: null,
      }),
    );
  };
  const { launches } = world;
  return Layer.succeed(SessionProcessesRepo, {
    create: ({ launch, ...input }: NewSessionProcess) =>
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
          createdAt: world.clock.now(),
          exitedAt: null,
          updatedAt: world.clock.now(),
        });
        world.processes.set(process.id, process);
        if (launch !== undefined && launch !== null) launches.set(process.id, launch);
        return process;
      }),
    byId: (id) => Effect.succeed(world.processes.get(id) ?? null),
    launchOf: (id) => Effect.succeed(launches.get(id) ?? null),
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
          world.processes.set(
            id,
            new SessionProcess({ ...process, status, updatedAt: world.clock.now() }),
          );
        }
      }),
    setLabel: (id, label) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(
            id,
            new SessionProcess({ ...process, label, updatedAt: world.clock.now() }),
          );
        }
      }),
    setProviderSessionId: (id, providerSessionId) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined) {
          world.processes.set(
            id,
            new SessionProcess({ ...process, providerSessionId, updatedAt: world.clock.now() }),
          );
        }
      }),
    markReached: (id) =>
      Effect.sync(() => {
        world.reachedAttempts.add(id);
      }),
    reached: (id) => Effect.sync(() => world.reachedAttempts.has(id)),
    markFirstOutput: (id, at) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process === undefined || process.firstOutputAt !== null) return false;
        world.processes.set(
          id,
          new SessionProcess({ ...process, firstOutputAt: at, updatedAt: world.clock.now() }),
        );
        return true;
      }),
    setHostPort: (id, hostPort) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(
            id,
            new SessionProcess({ ...process, hostPort, updatedAt: world.clock.now() }),
          );
        }
      }),
    setSealantSessionId: (id, sealantSessionId, sealantRunId) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (process !== undefined && process.exitedAt === null) {
          world.processes.set(
            id,
            new SessionProcess({
              ...process,
              sealantSessionId,
              sealantRunId,
              updatedAt: world.clock.now(),
            }),
          );
        }
      }),
    listRecentServices: () =>
      Effect.succeed([...world.processes.values()].filter((process) => process.kind === "service")),
    claimProviderSessionId: (id, sessionId, providerSessionId) =>
      Effect.sync(() => {
        const process = world.processes.get(id);
        if (
          process === undefined ||
          process.sessionId !== sessionId ||
          process.kind !== "agent-pty" ||
          process.providerSessionId !== null ||
          process.exitedAt !== null
        ) {
          return false;
        }
        world.processes.set(
          id,
          new SessionProcess({ ...process, providerSessionId, updatedAt: world.clock.now() }),
        );
        return true;
      }),
    setWaiting: (id, sessionId, from, to) =>
      Effect.promise(() => world.beforeWaitingMove.current?.() ?? Promise.resolve()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const process = world.processes.get(id);
            if (
              process === undefined ||
              process.sessionId !== sessionId ||
              process.kind !== "agent-pty" ||
              process.exitedAt !== null ||
              !sameWait(process.waiting, from)
            ) {
              return false;
            }
            world.processes.set(
              id,
              new SessionProcess({ ...process, waiting: to, updatedAt: world.clock.now() }),
            );
            return true;
          }),
        ),
      ),
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
          hostPolicy: input.hostPolicy ?? "rewrite",
          address: input.address ?? "loopback",
          currentAttemptId: null,
          currentForwardId: null,
          attemptHistoryComplete: input.attemptHistoryComplete ?? true,
          forwardHistoryComplete: input.forwardHistoryComplete ?? true,
          observationHistoryComplete: input.observationHistoryComplete ?? true,
          createdAt: world.clock.now(),
          updatedAt: world.clock.now(),
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
    listAll: () =>
      Effect.succeed(
        [...world.services.values()].filter((service) => {
          const session = world.sessions.get(service.sessionId);
          return session !== undefined && !world.removedProjects.has(session.projectId);
        }),
      ),
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
          world.services.set(
            id,
            new Service({ ...service, currentAttemptId, updatedAt: world.clock.now() }),
          );
        }
      }),
    setCurrentForward: (id, currentForwardId) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service !== undefined) {
          world.services.set(
            id,
            new Service({ ...service, currentForwardId, updatedAt: world.clock.now() }),
          );
        }
      }),
    compareAndSetCurrentAttempt: (id, expected, next) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service === undefined || service.currentAttemptId !== expected) return false;
        world.services.set(
          id,
          new Service({ ...service, currentAttemptId: next, updatedAt: world.clock.now() }),
        );
        return true;
      }),
    compareAndSetCurrentForward: (id, expected, next) =>
      Effect.sync(() => {
        const service = world.services.get(id);
        if (service === undefined || service.currentForwardId !== expected) return false;
        world.services.set(
          id,
          new Service({ ...service, currentForwardId: next, updatedAt: world.clock.now() }),
        );
        return true;
      }),
    setStartedBy: (id, accountId) =>
      Effect.sync(() => {
        world.serviceStarters.set(id, accountId);
      }),
    startedByOf: (id) => Effect.sync(() => world.serviceStarters.get(id) ?? null),
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
          createdAt: world.clock.now(),
          boundAt: null,
          closedAt: null,
          updatedAt: world.clock.now(),
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
          createdAt: world.clock.now(),
          boundAt: null,
          closedAt: null,
          updatedAt: world.clock.now(),
        });
        world.serviceForwards.set(forward.id, forward);
        const service = world.services.get(input.serviceId);
        if (service !== undefined) {
          world.services.set(
            service.id,
            new Service({ ...service, currentForwardId: forward.id, updatedAt: world.clock.now() }),
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
              boundAt: world.clock.now(),
              updatedAt: world.clock.now(),
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
              closedAt: world.clock.now(),
              updatedAt: world.clock.now(),
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
              closedAt: world.clock.now(),
              updatedAt: world.clock.now(),
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
          firstObservedAt: world.clock.now(),
          lastObservedAt: world.clock.now(),
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

const serviceAttemptsIn = (world: World, service: Service) =>
  [...world.processes.values()].filter(
    (process) =>
      process.serviceId === service.id &&
      process.sessionId === service.sessionId &&
      process.kind === "service",
  );

export const previewsRepoOf = (world: World) => {
  const activity = world.previewActivity;
  const targetsOf = (worktreeId: string): ReadonlyArray<PreviewTarget> => {
    const sessionIds = new Set(
      [...world.sessions.values()]
        .filter((session) => session.worktreeId === worktreeId)
        .map((session) => session.id),
    );
    return [...world.services.values()]
      .filter((service) => sessionIds.has(service.sessionId))
      .map((service) => {
        const attempts = serviceAttemptsIn(world, service);
        return {
          service,
          liveAttempt: attempts.find((attempt) => attempt.exitedAt === null) ?? null,
          recordedCommand: attempts.some((attempt) => attempt.argv.length > 0),
          workspaceId: world.sessions.get(service.sessionId)?.sealantWorkspaceId ?? null,
        };
      });
  };
  const snapshotOf = (id: PreviewId): PreviewGatewaySnapshot | null => {
    const preview = world.previews.get(id);
    if (preview === undefined) return null;
    const selected = selectPreviewTarget(
      preview,
      preview.worktreeId === null ? [] : targetsOf(preview.worktreeId),
    );
    const candidate = previewResumeCandidate(selected);
    const history =
      candidate === null
        ? []
        : serviceAttemptsIn(world, candidate).map((attempt) => ({
            attempt,
            reachable: world.reachedAttempts.has(attempt.id),
          }));
    const control = world.previewControls.get(id) ?? PREVIEW_CONTROL_INITIAL;
    const read: PreviewControlRead =
      control._tag === "Stopped" ? { ...control, byName: control.by } : control;
    return { preview, resolution: previewGatewayResolution(read, selected, history) };
  };
  const keptIn = (worktreeId: string) =>
    [...world.previews.values()].filter((preview) => preview.worktreeId === worktreeId);
  return Layer.mock(PreviewsRepo, {
    activityOf: (id) => Effect.sync(() => activity.get(id) ?? null),
    recordIdleStop: (id, attemptId, minutes, at) =>
      Effect.sync(() => {
        activity.set(id, {
          previewId: id,
          lastAdmittedAt: activity.get(id)?.lastAdmittedAt ?? null,
          idleStoppedAttemptId: attemptId,
          idleStoppedAt: at,
          idleMinutes: minutes,
        });
      }),
    touchActivity: (stamps) =>
      Effect.sync(() => {
        for (const [id, at] of stamps) {
          const previous = activity.get(id);
          activity.set(id, {
            previewId: id,
            lastAdmittedAt: new Date(
              Math.max(at.getTime(), previous?.lastAdmittedAt?.getTime() ?? 0),
            ),
            idleStoppedAttemptId: previous?.idleStoppedAttemptId ?? null,
            idleStoppedAt: previous?.idleStoppedAt ?? null,
            idleMinutes: previous?.idleMinutes ?? null,
          });
        }
      }),
    ensureForWorktree: (worktreeId) =>
      Effect.sync(() => {
        const targets = targetsOf(worktreeId);
        const named = new Set(keptIn(worktreeId).map((preview) => preview.serviceName));
        for (const { service } of targets) {
          const session = world.sessions.get(service.sessionId);
          if (service.browserScheme === null || named.has(service.name) || session === undefined)
            continue;
          named.add(service.name);
          const id = PreviewId.make(`preview-${service.name}`);
          world.previews.set(id, {
            id,
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            serviceName: service.name,
            label: PreviewLabel.make(service.name.padEnd(26, "a").slice(0, 26)),
            state: "kept",
          });
        }
        return keptIn(worktreeId).map((preview) => ({
          preview,
          binding: resolvePreviewBinding(preview, targets),
        }));
      }),
    ensureNamed: (worktreeId, serviceName) =>
      Effect.sync(() => {
        const kept = keptIn(worktreeId).find((preview) => preview.serviceName === serviceName);
        if (kept !== undefined) return kept.id;
        const session = [...world.sessions.values()].find(
          (candidate) => candidate.worktreeId === worktreeId,
        );
        const id = PreviewId.make(`preview-${serviceName}`);
        world.previews.set(id, {
          id,
          projectId: session?.projectId ?? ProjectId.make("project-fixture"),
          worktreeId: WorktreeId.make(worktreeId),
          serviceName,
          label: PreviewLabel.make(serviceName.padEnd(26, "a").slice(0, 26)),
          state: "kept",
        });
        return id;
      }),
    controlOf: (id) => Effect.sync(() => world.previewControls.get(id) ?? PREVIEW_CONTROL_INITIAL),
    changeControl: (id, request) =>
      Effect.sync(() => {
        const next = changePreviewControl(
          world.previewControls.get(id) ?? PREVIEW_CONTROL_INITIAL,
          request._tag === "Stop" ? { ...request, seq: (world.controlSeq += 1) } : request,
        );
        world.previewControls.set(id, next);
        return next;
      }),
    nextControlSeq: () => Effect.sync(() => (world.controlSeq += 1)),
    previewOfService: (serviceId) =>
      Effect.sync(() => {
        const service = world.services.get(serviceId);
        const session = service === undefined ? undefined : world.sessions.get(service.sessionId);
        if (service === undefined || session === undefined) return null;
        const kept = [...world.previews.values()].find(
          (preview) =>
            preview.worktreeId === session.worktreeId && preview.serviceName === service.name,
        );
        if (kept === undefined) return null;
        const selected = selectPreviewTarget(kept, targetsOf(session.worktreeId));
        return selected.service?.id === serviceId ? kept.id : null;
      }),
    resolveById: (id) =>
      Effect.sync(() => {
        const preview = world.previews.get(id);
        if (preview === undefined) return null;
        return {
          preview,
          binding: resolvePreviewBinding(
            preview,
            preview.worktreeId === null ? [] : targetsOf(preview.worktreeId),
          ),
        };
      }),
    gatewaySnapshot: (id) => Effect.sync(() => snapshotOf(id)),
    gatewaySnapshots: (ids) =>
      Effect.sync(() => {
        const read = new Map<PreviewId, PreviewGatewaySnapshot>();
        for (const id of ids) {
          const found = snapshotOf(id);
          if (found !== null) read.set(id, found);
        }
        return read;
      }),
  });
};

/** A `setup_runs` row as the test world keeps it; `leaseUntil` is the world clock's millis. */
export interface WorldSetupRun {
  readonly siteKey: string;
  readonly fingerprint: string;
  readonly worktreeId: string;
  state: "running" | "done" | "failed";
  readonly claimId: string;
  readonly workspaceId: string;
  readonly runsAs: string | null;
  leaseUntil: number;
  finishedAt: Date | null;
  exitCode: number | null;
  outputTail: string | null;
}

/** The store's claim rules (`decideSetupClaim`) over the world's rows, on the world's clock. */
export const setupRunsLayer = (world: World) => {
  const at = () => world.clock.now().getTime();
  const held = (claimId: string) =>
    world.setupRuns.find(
      (row) => row.claimId === claimId && row.state === "running" && row.leaseUntil > at(),
    );
  const drop = (keep: (row: WorldSetupRun) => boolean) => {
    const kept = world.setupRuns.filter(keep);
    world.setupRuns.splice(0, world.setupRuns.length, ...kept);
  };
  const live = (row: WorldSetupRun) => row.state === "running" && row.leaseUntil > at();
  return Layer.succeed(SetupRunsRepo, {
    claim: (request) =>
      Effect.sync(() => {
        const site = world.setupRuns.filter((row) => row.siteKey === request.siteKey);
        const decided = decideSetupClaim(
          site.map((row) => ({ ...row, lapsedMs: at() - row.leaseUntil })),
          request,
        );
        if (decided._tag !== "Claim") return decided;
        drop((row) => row.siteKey !== request.siteKey);
        const claimId = crypto.randomUUID();
        world.setupRuns.push({
          siteKey: request.siteKey,
          fingerprint: request.fingerprint,
          worktreeId: request.worktreeId,
          state: "running",
          claimId,
          workspaceId: request.workspaceId,
          runsAs: request.runsAs,
          leaseUntil: at() + request.leaseMs,
          finishedAt: null,
          exitCode: null,
          outputTail: null,
        });
        return { _tag: "Claimed", claimId } as const;
      }),
    busy: (siteKey) =>
      Effect.sync(() => world.setupRuns.some((row) => row.siteKey === siteKey && live(row))),
    runningIn: (workspaceId) =>
      Effect.sync(
        () => world.setupRuns.filter((row) => row.workspaceId === workspaceId && live(row)).length,
      ),
    unendedInWorktree: (worktreeId) =>
      Effect.sync(() =>
        world.setupRuns.some((row) => row.worktreeId === worktreeId && row.state === "running"),
      ),
    renew: (claimId, leaseMs) =>
      Effect.sync(() => {
        const row = held(claimId);
        if (row !== undefined) row.leaseUntil = at() + leaseMs;
        return row !== undefined;
      }),
    finish: (claimId, outcome) =>
      Effect.suspend(() => world.setupFinishing?.() ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const row = held(claimId);
            if (row === undefined) return false;
            row.state = outcome.state;
            row.finishedAt = world.clock.now();
            row.exitCode = outcome.exitCode;
            row.outputTail = outcome.outputTail;
            return true;
          }),
        ),
        Effect.tap((written) => (written ? (world.setupFinished?.() ?? Effect.void) : Effect.void)),
      ),
    release: (claimId) =>
      Effect.sync(() => drop((row) => !(row.claimId === claimId && row.state === "running"))),
    discard: (claimId) => Effect.sync(() => drop((row) => row.claimId !== claimId)),
    stampAt: (siteKey) =>
      Effect.sync(
        () =>
          world.setupRuns.find((row) => row.siteKey === siteKey && row.state !== "running")
            ?.fingerprint ?? null,
      ),
  });
};

/** Shared serviceStateLayer fixture for engine scenarios. */
export const serviceStateLayer = (world: World) =>
  Layer.mergeAll(
    setupRunsLayer(world),
    servicesLayer(world),
    serviceForwardsLayer(world),
    serviceObservationsLayer(world),
    previewsRepoOf(world),
  );

/** Every remote in these worlds is public: the policy's own tests cover refusals and pinning. */
export const sourcePolicyLayer = Layer.succeed(
  SourcePolicy,
  makeSourcePolicy({
    profile: "operator",
    allowedHosts: [],
    resolve: async () => ["140.82.112.3"],
  }),
);

/** The organization's audit log, kept in the world. */
export const auditLayer = (world: World) =>
  Layer.mock(AuditEventsRepo, {
    record: (event) => Effect.sync(() => void world.audit.push(event)),
  });

/** One organization, `org-test`, whose members the world names. */
export const organizationsLayer = (world: World) =>
  Layer.mock(OrganizationsRepo, {
    roleOf: (_organizationId, userId) => Effect.sync(() => world.members.get(userId) ?? null),
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
                createdAt: world.clock.now(),
                updatedAt: world.clock.now(),
              }),
              role,
              joinedAt: world.clock.now(),
            };
      }),
    members: () =>
      Effect.sync(() =>
        [...world.members.entries()].map(
          ([userId, role]) =>
            new OrganizationMember({
              organizationId: OrganizationId.make("org-test"),
              userId,
              name: userId,
              email: `${userId}@example.com`,
              role,
              joinedAt: world.clock.now(),
            }),
        ),
      ),
  });

/** No organization folders selected in these worlds. */
export const foldersEmptyLayer = Layer.mock(FoldersRepo, {
  listForProject: () => Effect.succeed([]),
});

/** Shared projectLinksEmptyLayer fixture for engine scenarios. */
export const projectLinksEmptyLayer = Layer.succeed(ProjectLinksRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ProjectLinkNotFoundError({ linkId: id })),
  listForProject: () => Effect.succeed([]),
  listAllForProject: () => Effect.succeed([]),
  remove: () => Effect.void,
});

/** No declared mounts in these worlds. */
export const projectMountsEmptyLayer = Layer.succeed(ProjectMountsRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ProjectMountNotFoundError({ mountId: id })),
  listForProject: () => Effect.succeed([]),
  remove: () => Effect.void,
});

/** No project-level recipes in these worlds — the file is the only source. */
export const projectRecipesEmptyLayer = Layer.succeed(ProjectServiceRecipesRepo, {
  listForProject: () => Effect.succeed([]),
  create: () => Effect.die("not in test"),
  remove: () => Effect.void,
});

/**
 * The project env store as the engine reads it at launch: Configuration rows and sealed
 * secrets, both configurable per test so lifecycle assertions can flip them mid-world. The
 * "cipher" is a reversible marker so a test can prove which plaintext reached createWorkspace.
 */
export const projectEnvironmentLayer = (
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

/** Shared projectSecretsLayer fixture for engine scenarios. */
export const projectSecretsLayer = (
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
export const projectClusterBindingsLayer = (
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

/** Shared emptyClusterBindings fixture for engine scenarios. */
export const emptyClusterBindings = () => ({ revision: 0, bindings: [], serviceAccount: null });

/** Shared secretCipherStubLayer fixture for engine scenarios. */
export const secretCipherStubLayer = Layer.succeed(SecretCipher, {
  encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
  decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
});

/** Shared emptyEnvironment fixture for engine scenarios. */
export const emptyEnvironment = () => ({ revision: 0, variables: {} });

/** Shared emptySecrets fixture for engine scenarios. */
export const emptySecrets = () => ({ revision: 0, secrets: {} });

/** No references in these worlds — launches mount nothing extra. */
export const referencesEmptyLayer = Layer.succeed(ReferencesRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
  byName: () => Effect.succeed(null),
  listAll: () => Effect.succeed([]),
  listForOrganization: () => Effect.succeed([]),
  byIdsInOrganization: () => Effect.succeed([]),
  remove: () => Effect.void,
  setHead: () => Effect.void,
  listForProject: () => Effect.succeed([]),
  setForProject: () => Effect.void,
});

/** Shared projectsLayer fixture for engine scenarios. */
export const projectsLayer = (world: World) =>
  Layer.succeed(ProjectsRepo, {
    removedById: () => Effect.succeed(null),
    removedForOrganization: () => Effect.succeed([]),
    storeClaimed: () => Effect.succeed(true),
    byScratchOwner: () => Effect.succeed(null),
    publishInitialized: () => Effect.die("not in test"),
    create: () => Effect.die("not in test"),
    setGitAuthMode: () => Effect.die("not in test"),
    listForOrganization: (organizationId) =>
      Effect.sync(() =>
        [...world.projects.values()].filter((project) => project.organizationId === organizationId),
      ),
    setVisibility: () => Effect.die("not in test"),
    setCreatedBy: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setApplyDotfiles: () => Effect.die("not in test"),
    setNewWorktreesUseProjectResources: () => Effect.die("not in test"),
    setDefaultShellProfile: () => Effect.die("not in test"),
    setInheritUserSkills: () => Effect.die("not in test"),
    setHotSessions: () => Effect.die("not in test"),
    setInstallCommand: () => Effect.die("not in test"),
    setInstallEnabled: () => Effect.die("not in test"),
    byId: (id) => {
      const found = world.projects.get(id);
      return found === undefined || world.removedProjects.has(id)
        ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
        : Effect.succeed(found);
    },
    byName: (organizationId, name) =>
      Effect.sync(
        () =>
          [...world.projects.values()].find(
            (project) => project.organizationId === organizationId && project.name === name,
          ) ?? null,
      ),
    listAll: () =>
      Effect.succeed(
        [...world.projects.values()].filter((project) => !world.removedProjects.has(project.id)),
      ),
    setAutomation: () => Effect.die("not in test"),
    setAutoLand: () => Effect.die("not in test"),
  });

/**
 * Review 2026-09-28 (7) #3: fail the one write that publishes an answer's executor evidence, as a
 * database would. Only for an answer that said the executor held unsaved work.
 */
export const unsavedEvidenceWriteFailure = { enabled: false };

let fenceTickets = 0;

/** Shared sessionsLayer fixture for engine scenarios. */
export const sessionsLayer = (world: World) => {
  const update = (id: string, patch: Partial<Session>) => {
    const current = world.sessions.get(id);
    if (current !== undefined) {
      world.sessions.set(id, new Session({ ...current, ...patch, updatedAt: world.clock.now() }));
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
      ...overdueFields(observation),
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
          purpose: input.purpose ?? null,
          autoLand: input.autoLand ?? null,
          origin: input.origin,
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
          createdAt: world.clock.now(),
          updatedAt: world.clock.now(),
        });
        // Migration 0166's insert trigger: the first session's owner owns the change.
        const worktree = world.worktrees.get(session.worktreeId);
        const first = ![...world.sessions.values()].some(
          (other) => other.worktreeId === session.worktreeId,
        );
        if (worktree !== undefined && worktree.changeOwnerUserId === null && first) {
          world.worktrees.set(
            worktree.id,
            new Worktree({ ...worktree, changeOwnerUserId: session.ownerUserId }),
          );
        }
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
    liveMarkNow: () => Effect.succeed(0),
    listActiveView: () => Effect.die("not in test"),
    listForProjectView: () => Effect.die("not in test"),
    viewById: () => Effect.die("not in test"),
    listUnsettled: () =>
      Effect.succeed(
        [...world.sessions.values()].filter(
          (s) => !world.removedProjects.has(s.projectId) && s.settledAt === null,
        ),
      ),
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
              session.purpose !== "setup" &&
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
          (s) =>
            !world.removedProjects.has(s.projectId) &&
            s.settledAt !== null &&
            s.sealantWorkspaceId !== null,
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
          .filter(
            (session) =>
              !world.removedProjects.has(session.projectId) &&
              session.settledAt !== null &&
              session.hasTranscript === null,
          )
          .slice(0, limit),
      ),
    setReferenceMounts: (id: string, mounts: ReadonlyArray<SessionReferenceMount>) =>
      Effect.sync(() => update(id, { referenceMounts: mounts })),
    setExtraMounts: (id: string, mounts: ReadonlyArray<SessionExtraMount>) =>
      Effect.sync(() => update(id, { extraMounts: mounts })),
    setProviderSessionId: (id, providerSessionId) =>
      Effect.sync(() => update(id, { providerSessionId })),
    // As SessionsRepo: the first `running` stamps `started_at`, whichever verb writes it.
    setStatus: (id, status) =>
      Effect.sync(() =>
        update(id, {
          status,
          ...(status === "running"
            ? { startedAt: world.sessions.get(id)?.startedAt ?? world.clock.now() }
            : {}),
        }),
      ),
    nativeIngestCursor: () => Effect.succeed(null),
    setNativeIngestCursor: () => Effect.void,
    saveLastSeenSequence: (id, sequence) =>
      Effect.sync(() => update(id, { lastSeenSequence: sequence })),
    notifyProgress: () => Effect.void,
    settle: (id, outcome, summary) =>
      Effect.sync(() => {
        const current = world.sessions.get(id);
        // As SessionsRepo.settle: the first settle wins, until `reopen` clears it.
        if (current?.settledAt != null) return;
        // A stop drain holds the workspace: `stopping`, not settled (SessionsRepo.settle).
        if (current?.captureDrain === "stop") {
          update(id, { status: "stopping", summary, settledAt: null });
        } else update(id, { status: outcome, summary, settledAt: world.clock.now() });
      }),
    reopen: (id, status) =>
      Effect.sync(() =>
        update(id, {
          status,
          ...(status === "running"
            ? { startedAt: world.sessions.get(id)?.startedAt ?? world.clock.now() }
            : {}),
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
    setLaunchOptions: (id, options) => Effect.sync(() => update(id, options)),
    setLabel: (id, label) => Effect.sync(() => update(id, { label })),
    setLabelIfUnset: (id, label) =>
      Effect.sync(() => {
        if (world.sessions.get(id)?.label !== null) return false;
        update(id, { label });
        return true;
      }),
    remove: (id) =>
      Effect.sync(() => {
        world.sessions.delete(id);
        world.relaunches.delete(id);
      }),
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
          ...overdueFields(observation),
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
    planRelaunch: (id, expected, resume, at) =>
      Effect.sync(() => {
        if (!world.sessions.has(id)) return "gone";
        if ((world.relaunches.get(id) ?? null) !== expected) return "moved";
        const current = world.sessions.get(id);
        world.relaunches.set(id, resume);
        update(id, {
          captureDrain: "relaunch",
          captureDrainRequestedAt: current?.captureDrainRequestedAt ?? at,
          captureDrainProgressAt: current?.captureDrainProgressAt ?? at,
        });
        return "written";
      }),
    swapRelaunch: (id, expected, next) =>
      Effect.promise(() => world.beforeRelaunchSwap.current?.(next) ?? Promise.resolve()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!world.sessions.has(id)) return "gone";
            if ((world.relaunches.get(id) ?? null) !== expected) return "moved";
            if (next === null) world.relaunches.delete(id);
            else world.relaunches.set(id, next);
            return "written";
          }),
        ),
      ),
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
    relaunchOf: (id) =>
      Effect.sync(() => (world.sessions.has(id) ? (world.relaunches.get(id) ?? null) : null)),
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
        if (unsavedEvidenceWriteFailure.enabled && reading.unsaved !== null) {
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
          captureOverdueStep: null,
          captureOverdueSince: null,
          captureOverdueRunningMs: null,
          captureOverdueBoundMs: null,
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
    executorSessionOf: (workspaceId) => Effect.sync(() => executorSessionIn(world, workspaceId)),
    launchersOf: (workspaceIds) =>
      Effect.sync(() => {
        const launchers = new Map<string, string>();
        for (const workspaceId of workspaceIds) {
          const owner = executorSessionIn(world, workspaceId)?.ownerUserId;
          if (owner !== undefined && owner !== null) launchers.set(workspaceId, owner);
        }
        return launchers;
      }),
    executorAccessOf: (workspaceId, askerUserId) =>
      Effect.sync(() => {
        const creator = executorSessionIn(world, workspaceId);
        const project = creator === null ? undefined : world.projects.get(creator.projectId);
        if (creator === null || creator.ownerUserId === null || project === undefined) return null;
        // One organization in these worlds, `org-test`: a member's role is theirs in it.
        const roleOf = (userId: string) =>
          project.organizationId === "org-test" ? (world.members.get(userId) ?? null) : null;
        return {
          creatorUserId: creator.ownerUserId,
          project,
          creatorRole: roleOf(creator.ownerUserId),
          askerRole: roleOf(askerUserId),
        };
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

/** Shared changesLayer fixture for engine scenarios. */
export const changesLayer = (world: World) =>
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
          createdAt: world.clock.now(),
          updatedAt: world.clock.now(),
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
                updatedAt: world.clock.now(),
              }),
            );
          }
        }
      }),
    annotationsForProject: () => Effect.succeed([]),
  });

/** Shared worktreesLayer fixture for engine scenarios. */
export const worktreesLayer = (world: World) =>
  Layer.succeed(WorktreesRepo, {
    create: (input) =>
      Effect.sync(() => {
        const worktree = new Worktree({
          ...input,
          createdAt: world.clock.now(),
          updatedAt: world.clock.now(),
        });
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
    handoffPacks: () =>
      Effect.succeed(
        [...world.worktrees.values()].flatMap((row) =>
          row.handoff === null ? [] : [row.handoff.deltaPack],
        ),
      ),
    byHandoffCheckpoint: (projectId, checkpoint) =>
      Effect.succeed(
        [...world.worktrees.values()].find(
          (worktree) =>
            worktree.projectId === projectId && worktree.handoff?.checkpoint === checkpoint,
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
          world.worktrees.set(
            id,
            new Worktree({ ...current, baseSha, baseRef, updatedAt: world.clock.now() }),
          );
        }
      }),
    rename: (id, name, branch) =>
      Effect.sync(() => {
        const current = world.worktrees.get(id);
        if (current !== undefined) {
          world.worktrees.set(
            id,
            new Worktree({ ...current, name, branch, updatedAt: world.clock.now() }),
          );
        }
      }),
    remove: (id) =>
      Effect.sync(() => {
        world.worktrees.delete(id);
      }),
    changeOwnerOf: (id) => Effect.succeed(world.worktrees.get(id)?.changeOwnerUserId ?? null),
    nestedRepositories: () => Effect.succeed([]),
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

/** Shared sessionRunsLayer fixture for engine scenarios. */
export const sessionRunsLayer = (world: World) => {
  const listForSession = (sessionId: string) =>
    [...world.sessionRuns.values()]
      .filter((run) => run.sessionId === sessionId)
      .toSorted((left, right) => left.ordinal - right.ordinal);
  const update = (id: string, patch: Partial<SessionRun>) => {
    const current = world.sessionRuns.get(id);
    if (current !== undefined) {
      world.sessionRuns.set(
        id,
        new SessionRun({ ...current, ...patch, updatedAt: world.clock.now() }),
      );
    }
  };
  return Layer.succeed(SessionRunsRepo, {
    // The one-active-run index, as Postgres enforces it: a run of the session still open is the
    // typed refusal naming it, never a second open row. The primary key is not enforced here: the
    // stand-in platform numbers its runs per layer, so a fixture world that outlives an engine
    // restart sees a run id again, which real Sealant never issues twice.
    create: (input: NewSessionRun) =>
      Effect.suspend(() => {
        const activeRun = listForSession(input.sessionId).findLast((run) => run.settledAt === null);
        if (activeRun !== undefined && activeRun.sealantRunId !== input.sealantRunId) {
          return Effect.fail(
            new SessionRunActiveError({
              sessionId: input.sessionId,
              sealantRunId: input.sealantRunId,
              activeRun,
            }),
          );
        }
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
          startedAt: world.clock.now(),
          settledAt: null,
          createdAt: world.clock.now(),
          updatedAt: world.clock.now(),
        });
        world.sessionRuns.set(run.sealantRunId, run);
        return Effect.succeed(run);
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
    // First settle wins, as in Postgres: a run already settled keeps its words.
    settle: (id, status, summary) =>
      Effect.sync(() => {
        if (world.sessionRuns.get(id)?.settledAt === null) {
          update(id, { status, summary, settledAt: world.clock.now() });
        }
      }),
    restate: (id, status, summary) =>
      Effect.sync(() => {
        if (world.sessionRuns.get(id)?.settledAt != null) update(id, { status, summary });
      }),
  });
};

/** Shared checkpointsLayer fixture for engine scenarios. */
export const checkpointsLayer = (world: World) =>
  Layer.succeed(CheckpointsRepo, {
    // The unique `(worktree_id, ordinal)` index, as Postgres enforces it: a taken ordinal is
    // the typed conflict carrying the row that got there first, never a second row.
    create: (input: NewCheckpoint) =>
      Effect.andThen(
        Effect.suspend(() => {
          const hold = world.checkpointHold.current;
          return hold === null ? Effect.void : Effect.promise(() => hold);
        }),
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
            createdAt: world.clock.now(),
            ...(input.source === undefined || input.source === null
              ? {}
              : { source: input.source }),
          });
          world.checkpoints.push(checkpoint);
          world.checkpointCaptureIds.set(checkpoint.id, input.captureId ?? null);
          return Effect.succeed(checkpoint);
        }),
      ),
    byId: (id) =>
      Effect.succeed(world.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null),
    captureIdOf: (id, worktreeId) =>
      Effect.succeed(
        world.checkpoints.some(
          (checkpoint) => checkpoint.id === id && checkpoint.worktreeId === worktreeId,
        )
          ? (world.checkpointCaptureIds.get(id) ?? null)
          : null,
      ),
    byOrdinal: (worktreeId, ordinal) =>
      Effect.succeed(
        world.checkpoints.find((c) => c.worktreeId === worktreeId && c.ordinal === ordinal) ?? null,
      ),
    listForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId)),
    latestForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId).at(-1) ?? null),
    latestForWorktreeAt: (worktreeId, at) =>
      Effect.succeed(
        world.checkpoints.filter((c) => c.worktreeId === worktreeId && c.createdAt <= at).at(-1) ??
          null,
      ),
    countForWorktree: (worktreeId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.worktreeId === worktreeId).length),
    listForSession: (sessionId) =>
      Effect.succeed(world.checkpoints.filter((c) => c.sessionId === sessionId)),
    withWorktreeLock: (_worktreeId, effect) => effect,
  });

const serveGitOrigin = (tmp: string) =>
  Effect.gen(function* () {
    const daemons = new Set<ChildProcess>();
    const listener = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = net.createServer({ pauseOnConnect: true }, (socket) => {
          const daemon = spawn(
            "git",
            ["daemon", "--inetd", "--export-all", `--base-path=${tmp}`, tmp],
            { stdio: [socket, socket, "ignore"] },
          );
          socket.destroy();
          daemons.add(daemon);
          daemon.once("error", (error) => {
            process.stderr.write(`Git fixture could not start: ${error.message}\n`);
          });
          daemon.once("close", () => daemons.delete(daemon));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        return server;
      }),
      (server) =>
        Effect.promise(async () => {
          const closed = once(server, "close");
          server.close();
          await Promise.all(
            [...daemons].map((daemon) => {
              const exited = once(daemon, "close");
              daemon.kill();
              return exited;
            }),
          );
          await closed;
        }),
    );
    const address = listener.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die(new Error("Git fixture has no TCP address."));
    }
    return RepositoryCloneUrl.make(`git://127.0.0.1:${address.port}/origin`);
  });

/** A throwaway origin repo with one commit, adopted over Git into a tmp store. */
export const setup = (tmp: string, world: World) => {
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
      gitAuthMode: "mend-key",
      workspaceImage: null,
      applyDotfiles: true,
      defaultShellProfile: true,
      inheritUserSkills: true,
      hotSessions: 0,
      installCommand: null,
      installEnabled: true,
      createdAt: world.clock.now(),
      updatedAt: world.clock.now(),
    });
    world.projects.set(project.id, project);
    return project;
  });
};

/**
 * A second project of the same organization, adopted from its own origin beside the fixture's
 * (served by the same git daemon, which exports everything under `tmp`): what `mend repo add`
 * brings into a session (docs/adr/0010).
 */
export const setupSibling = (tmp: string, world: World, name: string, fixtureOrigin: string) => {
  const origin = path.join(tmp, `${name}-origin`);
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
  fs.writeFileSync(path.join(origin, "lib.rs"), "fn main() {}\n");
  run("add", "-A");
  run("commit", "-m", "core base");
  return Effect.gen(function* () {
    const source = RepositoryCloneUrl.make(fixtureOrigin.replace(/\/origin$/, `/${name}-origin`));
    const store = yield* Store;
    const adopted = yield* store.adopt(name, source, { GIT_TERMINAL_PROMPT: "0" });
    const project = new Project({
      id: ProjectId.make(`proj-${name}`),
      name,
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
      gitAuthMode: "mend-key",
      workspaceImage: null,
      applyDotfiles: true,
      defaultShellProfile: true,
      inheritUserSkills: true,
      hotSessions: 0,
      installCommand: null,
      installEnabled: true,
      createdAt: world.clock.now(),
      updatedAt: world.clock.now(),
    });
    world.projects.set(project.id, project);
    return project;
  });
};

/** Drains in tests: polls every few milliseconds, a stall only when a test shortens the window. */
export const testDrainPolicy = (overrides: Partial<CaptureDrainPolicyShape> = {}) =>
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
    deferredWorkLimit: Duration.seconds(5),
    landingStopWait: Duration.seconds(10),
    statusInterval: Duration.seconds(45),
    reaperInterval: Duration.seconds(10),
    statusMinInterval: Duration.seconds(10),
    // A launch waits this long for a worktree's previous executor before it is refused.
    leaseWait: Duration.millis(300),
    leaseWaitInterval: Duration.millis(10),
    imageBuildAfter: Duration.millis(40),
    createPhaseInterval: Duration.millis(10),
    harnessWarmupTimeout: Duration.seconds(60),
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
      issuePerson: (launchId: string, accountId: string) =>
        inner
          .issuePerson(launchId, accountId)
          .pipe(
            Effect.tap((token) =>
              Effect.sync(() => events.push(`issuePerson:${launchId}:${accountId}:${token}`)),
            ),
          ),
      issueWrite: (launchId: string, accountId: string) =>
        inner
          .issueWrite(launchId, accountId)
          .pipe(
            Effect.tap((token) =>
              Effect.sync(() => events.push(`issueWrite:${launchId}:${accountId}:${token}`)),
            ),
          ),
      revoke: (sessionId: string) =>
        Effect.sync(() => events.push(`revoke:${sessionId}`)).pipe(
          Effect.andThen(inner.revoke(sessionId)),
        ),
      revokeLaunch: (launchId: string) =>
        Effect.sync(() => events.push(`revokeLaunch:${launchId}`)).pipe(
          Effect.andThen(inner.revokeLaunch(launchId)),
        ),
      revokeToken: (token: string) =>
        Effect.sync(() => events.push(`revokeToken:${token}`)).pipe(
          Effect.andThen(inner.revokeToken(token)),
        ),
      revokePerson: (launchId: string, accountId: string, issuedBefore: Date) =>
        Effect.sync(() => events.push(`revokePerson:${launchId}:${accountId}`)).pipe(
          Effect.andThen(inner.revokePerson(launchId, accountId, issuedBefore)),
        ),
    })),
  ).pipe(Layer.provide(SessionChannelTokensRepoMemory));

/**
 * The in-memory layouts repo, recording every launch and worktree layout it is asked for, and
 * every "is anything recorded" query (`anyRecorded`) in `queries`. `afterRequest` runs once the
 * operator's layout request is written, before the write returns.
 */
const countingLaunchLayoutReads = (
  reads: Array<string>,
  state?: HarnessLayoutsMemoryState,
  queries: Array<string> = [],
  afterRequest: Effect.Effect<void> = Effect.void,
): Layer.Layer<HarnessLayoutsRepo> =>
  Layer.effect(
    HarnessLayoutsRepo,
    Effect.map(HarnessLayoutsRepo, (inner) => ({
      ...inner,
      requestLayout: (worktreeId: WorktreeId, layout: HarnessLayout) =>
        inner.requestLayout(worktreeId, layout).pipe(Effect.andThen(afterRequest)),
      anyRecorded: () =>
        Effect.sync(() => queries.push("anyRecorded")).pipe(Effect.andThen(inner.anyRecorded())),
      launchLayout: (launchId: string) =>
        Effect.sync(() => reads.push(launchId)).pipe(Effect.andThen(inner.launchLayout(launchId))),
      worktreeLayout: (worktreeId: WorktreeId) =>
        Effect.sync(() => reads.push(`worktree:${worktreeId}`)).pipe(
          Effect.andThen(inner.worktreeLayout(worktreeId)),
        ),
    })),
  ).pipe(Layer.provide(harnessLayoutsRepoMemory(state)));

/** The session whose own launch made the executor in `workspaceId` (`executorSessionOf`). */
const executorSessionIn = (world: World, workspaceId: string): Session | null => {
  for (const [id, launch] of world.executorLaunches) {
    const session = world.sessions.get(id);
    if (launch.workspaceId === workspaceId && session?.sealantWorkspaceId === workspaceId) {
      return session;
    }
  }
  return null;
};

/** `SealantClientByWorkspaceCreator` over `inner`, reading the world's sessions and projects. */
export const byWorkspaceCreatorIn = (
  world: World,
  inner: Layer.Layer<SealantClient>,
): Layer.Layer<SealantClient | WorkspaceCaller> =>
  SealantClientByWorkspaceCreator.pipe(
    // One caller for the client and the engine, as on the server: its caches are shared.
    Layer.provideMerge(WorkspaceCallerLive),
    Layer.provide(inner),
    Layer.provide(Layer.mergeAll(sessionsLayer(world), sessionRunsLayer(world))),
  );

/** `layer`, handing the client it builds to `expose` as well. */
const exposing = (
  layer: Layer.Layer<SealantClient | WorkspaceCaller>,
  expose: ((client: SealantClientShape) => void) | undefined,
): Layer.Layer<SealantClient | WorkspaceCaller> =>
  expose === undefined
    ? layer
    : Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (client) => {
          expose(client);
          return client;
        }),
      ).pipe(Layer.provideMerge(layer));

/** The sessions repo given, recording every session read by id in `reads`. */
const countingSessionReads = (
  reads: Array<string>,
  base: Layer.Layer<SessionsRepo>,
): Layer.Layer<SessionsRepo> =>
  Layer.effect(
    SessionsRepo,
    Effect.map(SessionsRepo, (inner) => ({
      ...inner,
      byId: (id: SessionId) =>
        Effect.sync(() => reads.push(id)).pipe(Effect.andThen(inner.byId(id))),
    })),
  ).pipe(Layer.provide(base));

/** The sessions repo given, through `wrap` when a case gives one. */
const wrappedSessions = (
  wrap: ((inner: SessionsRepo["Service"]) => SessionsRepo["Service"]) | undefined,
  base: Layer.Layer<SessionsRepo>,
): Layer.Layer<SessionsRepo> =>
  wrap === undefined
    ? base
    : Layer.effect(SessionsRepo, Effect.map(SessionsRepo, wrap)).pipe(Layer.provide(base));

/** Dependencies and persisted fixture state used by one engine scope. */
interface EngineOptions {
  /** The worktree's resources (ADR 0019); none run unless a test provides a runtime. */
  readonly resourceRuntime?: Layer.Layer<ResourceRuntime>;
  readonly resourceStatus?: Layer.Layer<ResourceStatusReads>;
  /** Observe real channel waits without replacing registration or timeout behavior. */
  readonly wrapCaptureChannel?: (inner: CaptureChannel["Service"]) => CaptureChannel["Service"];
  readonly sealantLayer?: Layer.Layer<SealantClient>;
  /** Hands a test the platform client exactly as the engine reaches it (`WorkspaceCaller` on). */
  readonly exposeSealant?: (client: SealantClientShape) => void;
  readonly protocolHostLayer?: Layer.Layer<ProtocolHost>;
  readonly conversationLayer?: Layer.Layer<AgentConversationRepo>;
  readonly messageSettings?: Map<string, MessageSettings>;
  readonly hotWorkspacesLayer?: Layer.Layer<HotWorkspacesRepo>;
  readonly skillsLayer?: Layer.Layer<SkillsRepo>;
  readonly piProfilesLayer?: Layer.Layer<PiProfilesRepo>;
  readonly agentMemoryLayer?: Layer.Layer<AgentMemoryRepo>;
  readonly secretFilesLayer?: Layer.Layer<SecretFilesRepo>;
  readonly dopplerLayer?: Layer.Layer<DopplerRepo>;
  /** The owner's dotfiles; none configured unless a test brings its own. */
  readonly userDotfilesLayer?: Layer.Layer<UserDotfilesRepo>;
  /** The owner's git author; `Account <id>` <`<id>@accounts.example`> unless a test says. */
  readonly gitAuthorLayer?: Layer.Layer<UserGitAuthorRepo>;
  /** The people who chose their selected agent's login only; nobody unless a test says. */
  readonly selectedOnly?: ReadonlySet<string>;
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
  /** The organization's references and each project's selection; none unless a test says. */
  readonly referencesLayer?: Layer.Layer<ReferencesRepo>;
  /** The project's links; none unless a test says. */
  readonly projectLinksLayer?: Layer.Layer<ProjectLinksRepo>;
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
  /** What the host whose Docker runs the workspaces says of user namespaces; nothing unless a test says. */
  readonly hostUserNamespaces?: Layer.Layer<WorkspaceHostUserNamespaces>;
  readonly pagesLayer?: Layer.Layer<SessionPagesRepo>;
  /** Every log line the engine writes, in order, when a test reads them. */
  readonly logs?: Array<string>;
  /** Every log line with its level, when a test asserts what was warned. */
  readonly leveledLogs?: Array<{ readonly level: string; readonly message: string }>;
  /** Every channel token issue and revocation (`issue:<launch>`, `revoke:<session>`, `revokeLaunch:<launch>`). */
  readonly tokenEvents?: Array<string>;
  /** The channel tokens, when a test shares them with a network channel of its own. */
  readonly tokensLayer?: Layer.Layer<SessionChannelTokensRepo>;
  /** Where session sockets go; kept in `servedSocketApis` unless a test says. */
  readonly socketHostLayer?: Layer.Layer<SessionSocketHost>;
  readonly forwardAdapterLayer?: Layer.Layer<ForwardAdapter>;
  readonly serviceHostLayer?: Layer.Layer<ServiceHost>;
  /** Where previews are reached, for `MEND_PREVIEW_URL`; nowhere unless a test says. */
  readonly previewUrls?: Layer.Layer<PreviewUrls>;
  /** Every account's Mend key; one shared stub path unless a test says. */
  readonly instanceRolesLayer?: Layer.Layer<InstanceRolesRepo>;
  readonly mendKeysLayer?: Layer.Layer<MendKeys>;
  readonly gitOpsLayer?: Layer.Layer<SessionGitOpsRepo>;
  /** Every account's signer; never connected unless a test says. */
  readonly agentBridgeLayer?: Layer.Layer<AgentBridge>;
  /** Mend's git verification of captures (capture mode); off — every capture unverified — unless a test says. */
  readonly verifier?: Layer.Layer<CaptureGitVerifier>;
  readonly transformBlobs?: (base: Layer.Layer<BlobStore>) => Layer.Layer<BlobStore>;
  /**
   * Per-person harness homes (docs/adr/0016): the flag, the layout records and the platform's
   * person-layout surface. Off, with today's platform, unless a test says.
   */
  readonly harnessLayout?: {
    readonly flag?: HarnessLayout;
    readonly state?: HarnessLayoutsMemoryState;
    readonly platform?: Layer.Layer<PersonLayoutPlatform>;
    /** Every launch whose recorded layout was read from the repo, in order. */
    readonly launchLayoutReads?: Array<string>;
    /** Every `anyRecorded` query the engine made, in order. */
    readonly anyRecordedQueries?: Array<string>;
    /** Runs once an operator's layout request is written, before the write returns. */
    readonly afterRequest?: Effect.Effect<void>;
    /** How long a start waits for a person's dotfiles apply; 120 s unless a test says. */
    readonly dotfilesApplyBound?: Duration.Duration;
    /** Wraps the layouts repo the engine reads (Delivery 19's off-path test). */
    readonly wrapRepo?: (inner: HarnessLayoutsRepo["Service"]) => HarnessLayoutsRepo["Service"];
  };
  /** Every session row read by id (`SessionsRepo.byId`), in order. */
  readonly sessionReads?: Array<string>;
  /** Wraps the sessions repo the engine reads, so a case can hold one reader inside its read. */
  readonly wrapSessions?: (inner: SessionsRepo["Service"]) => SessionsRepo["Service"];
  /** Wraps the process rows the engine reads and writes, so a case can hold one write. */
  readonly wrapProcesses?: (
    inner: SessionProcessesRepo["Service"],
  ) => SessionProcessesRepo["Service"];
}

/** Run a live adapter scenario, including AbortSignal-driven interruption. */
export const withEngine = <A, E>(
  work: (
    world: World,
    tmp: string,
  ) => Effect.Effect<A, E, SessionEngine | Store | WorktreesRepo | Scope.Scope>,
  options: EngineOptions & { readonly signal?: AbortSignal } = {},
): Promise<A> =>
  Effect.runPromise(
    withEngineEffect(work, options),
    options.signal === undefined ? undefined : { signal: options.signal },
  );

/** Build and close the engine inside the caller's Clock and Effect context. */
export const withEngineEffect = <A, E>(
  work: (
    world: World,
    tmp: string,
  ) => Effect.Effect<A, E, SessionEngine | Store | WorktreesRepo | Scope.Scope>,
  options: EngineOptions = {},
): Effect.Effect<A> =>
  withPreparedEngineEffect(
    () => Effect.void,
    (world, tmp) => work(world, tmp),
    options,
  );

/**
 * `withEngineEffect` whose `before` (a test's git origin and adoption, `setup`) runs over the
 * store alone, before the engine exists: the git daemon and the adoption are real I/O that has no
 * business inside the engine's lifetime, and the engine's boot sweeps then see the adopted project.
 * Under `it.effect` the engine's timers park on the TestClock; see `settledTestClock` for what
 * that means for Effect's unadvanced-clock warning.
 */
export const withPreparedEngineEffect = <B, A, E>(
  before: (
    world: World,
    tmp: string,
  ) => Effect.Effect<B, unknown, Store | WorktreesRepo | Scope.Scope>,
  work: (
    world: World,
    tmp: string,
    prepared: B,
  ) => Effect.Effect<A, E, SessionEngine | Store | WorktreesRepo | Scope.Scope>,
  options: EngineOptions = {},
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const ownerClock = yield* Clock.Clock;
    const caller = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id));
    const tmp = yield* Effect.acquireRelease(
      Effect.sync(
        () => options.fixture?.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-test-")),
      ),
      (directory) =>
        options.fixture === undefined
          ? Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true }))
          : Effect.void,
    );
    const world = options.fixture?.world ?? makeWorld();
    world.clock.now = () => new Date(ownerClock.currentTimeMillisUnsafe());
    options.prepareWorld?.(world, tmp);
    const storeConfigLayer = StoreConfig.layerFor(path.join(tmp, "store"));
    // Built here, once: `before` and the engine share this store instance.
    const storeLayer: Layer.Layer<Store> = Layer.succeedContext(
      yield* Layer.build(Store.layer.pipe(Layer.provide(storeConfigLayer))),
    );
    const prepared = yield* before(world, tmp).pipe(
      Effect.provide(Layer.mergeAll(storeLayer, worktreesLayer(world))),
      Effect.orDie,
    );
    const baseBlobsLayer = BlobStoreFsLive(path.join(tmp, "blobs"));
    const blobsLayer = options.transformBlobs?.(baseBlobsLayer) ?? baseBlobsLayer;
    const observeCaptureChannel = (
      base: Layer.Layer<CaptureChannel>,
    ): Layer.Layer<CaptureChannel> =>
      options.wrapCaptureChannel === undefined
        ? base
        : Layer.effect(CaptureChannel, Effect.map(CaptureChannel, options.wrapCaptureChannel)).pipe(
            Layer.provide(base),
          );
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
            observeCaptureChannel(
              CaptureChannelLive.pipe(
                Layer.provide(options.verifier ?? CaptureGitVerifierOff),
                Layer.provide(CaptureSourcesOff),
                Layer.provide(CaptureRemotesOff),
                Layer.provide(options.captured.layer),
                Layer.provide(blobsLayer),
                Layer.provide(CaptureUploadPolicyDefault),
              ),
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
    const preferences = options.messageSettings ?? new Map<string, MessageSettings>();
    const engineLayer = SessionEngineLive.pipe(
      Layer.provide(
        Layer.mock(RemovalFencesRepo, {
          admit: (sessionId) =>
            Effect.suspend(() => {
              const live = ["starting", "running", "waiting", "idle"].includes(
                world.sessions.get(sessionId)?.status ?? "",
              );
              if (world.removalMarkedSessions.has(sessionId) && !live) {
                return Effect.die(new RemovalFenced(`session ${sessionId} is being removed`));
              }
              const id = SessionAdmissionId.make(`adm_${world.admissions.size + 1}_${sessionId}`);
              world.admissions.set(id, sessionId);
              return Effect.succeed(id);
            }),
          renewAdmission: () => Effect.void,
          endAdmission: (id) => Effect.sync(() => void world.admissions.delete(id)),
        }),
      ),
      Layer.provide(
        Layer.succeed(MessageSettingsRepo, {
          forUser: (id) => Effect.sync(() => preferences.get(id) ?? DEFAULT_MESSAGE_SETTINGS),
          set: (id, value) =>
            Effect.sync(() => {
              preferences.set(id, value);
              return value;
            }),
        }),
      ),
      Layer.provide(testDrainPolicy(options.drainPolicy)),
      Layer.provide(sessionRepositoryLayer),
      Layer.provide(storeLayer),
      // The platform as the server reaches it: through the rule for whose identity a call about a
      // workspace runs as (`WorkspaceCaller`), over the world's own rows.
      Layer.provide(
        exposing(
          byWorkspaceCreatorIn(
            world,
            options.captured === undefined || options.sealantLayer === undefined
              ? (options.sealantLayer ?? sealantDeadLayer)
              : stampedAnswers(options.sealantLayer, options.captured, world),
          ),
          options.exposeSealant,
        ),
      ),
      Layer.provide(settingsLayer(options.workspaceImage)),
      Layer.provide(projectsLayer(world)),
      Layer.provide(
        wrappedSessions(
          options.wrapSessions,
          options.sessionReads === undefined
            ? sessionsLayer(world)
            : countingSessionReads(options.sessionReads, sessionsLayer(world)),
        ),
      ),
      Layer.provide(sessionRunsLayer(world)),
      Layer.provide(
        options.wrapProcesses === undefined
          ? sessionProcessesLayer(world)
          : Layer.effect(
              SessionProcessesRepo,
              Effect.map(SessionProcessesRepo, options.wrapProcesses),
            ).pipe(Layer.provide(sessionProcessesLayer(world))),
      ),
      Layer.provide(
        Layer.mergeAll(
          options.conversationLayer ?? agentConversationStubLayer,
          options.protocolHostLayer ?? protocolHostStubLayer,
          serviceStateLayer(world),
        ),
      ),
      Layer.provide(
        Layer.merge(
          options.serviceHostLayer ?? serviceHostStubLayer,
          options.forwardAdapterLayer ?? forwardAdapterReadyLayer,
        ),
      ),
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
          options.mendKeysLayer ?? mendKeysStubLayer,
          options.agentBridgeLayer ?? agentBridgeStubLayer,
          options.gitOpsLayer ?? gitOpsStubLayer,
          changesLayer(world),
          worktreesLayer(world),
          checkpointsLayer(world),
          options.referencesLayer ?? referencesEmptyLayer,
          projectMountsEmptyLayer,
          options.projectLinksLayer ?? projectLinksEmptyLayer,
          SessionRepositoriesRepoMemory,
          organizationsLayer(world),
          auditLayer(world),
          sourcePolicyLayer,
          options.instanceRolesLayer ??
            Layer.mock(InstanceRolesRepo, { isOperator: () => Effect.succeed(true) }),
          foldersEmptyLayer,
          projectRecipesEmptyLayer,
          options.hotWorkspacesLayer ?? hotWorkspacesEmptyLayer,
          options.seals ?? CaptureSealsNone,
          options.hostUserNamespaces ?? WorkspaceHostUserNamespacesUnobserved,
          options.previewUrls ?? PreviewUrlsNone,
          Layer.succeed(ScreensRepo, world.screens),
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
          agentLoginsLayerOf(options.selectedOnly),
          options.gitHooksLayer ?? WorkspaceGitHooksLive,
          options.dotfilesStoreLayer ?? dotfilesStoreStubLayer,
          options.dotfilesClonerLayer ?? dotfilesClonerLayer(),
          options.skillsLayer ?? skillsStubLayer,
          options.piProfilesLayer ?? piProfilesLayerOf(),
          options.agentMemoryLayer ?? agentMemoryLayerOf(),
          options.secretFilesLayer ?? secretFilesLayerOf(),
          options.dopplerLayer ??
            Layer.mock(DopplerRepo, {
              connection: () => Effect.succeed(null),
              mappings: () => Effect.succeed([]),
            }),
          options.pagesLayer ?? sessionPagesLayerOf(),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          options.harnessLayout?.wrapRepo !== undefined
            ? Layer.effect(
                HarnessLayoutsRepo,
                Effect.map(HarnessLayoutsRepo, options.harnessLayout.wrapRepo),
              ).pipe(Layer.provide(harnessLayoutsRepoMemory(options.harnessLayout.state)))
            : options.harnessLayout?.launchLayoutReads === undefined &&
                options.harnessLayout?.anyRecordedQueries === undefined &&
                options.harnessLayout?.afterRequest === undefined
              ? harnessLayoutsRepoMemory(options.harnessLayout?.state)
              : countingLaunchLayoutReads(
                  options.harnessLayout?.launchLayoutReads ?? [],
                  options.harnessLayout?.state,
                  options.harnessLayout?.anyRecordedQueries,
                  options.harnessLayout?.afterRequest,
                ),
          options.harnessLayout?.platform ?? PersonLayoutPlatformNone,
          options.resourceRuntime ?? ResourceRuntimeNone,
          options.resourceStatus ?? ResourceStatusReadsNone,
          Layer.succeed(HarnessLayoutConfig, {
            flag: options.harnessLayout?.flag ?? "shared",
            loginReleaseGrace: Duration.zero,
            ...(options.harnessLayout?.dotfilesApplyBound === undefined
              ? {}
              : { dotfilesApplyBound: options.harnessLayout.dotfilesApplyBound }),
          }),
        ),
      ),
    );
    const logs = options.logs;
    const leveledLogs = options.leveledLogs;
    const loggerLayer =
      logs === undefined && leveledLogs === undefined
        ? Layer.empty
        : Logger.layer([
            Logger.make(({ message, logLevel }) => {
              const line = Array.isArray(message) ? message.map(String).join(" ") : String(message);
              logs?.push(line);
              leveledLogs?.push({ level: logLevel, message: line });
            }),
          ]);
    // The engine lives in its own scope, closed the moment `work` returns and before anything
    // `work` scoped (as `Effect.provide(layer)` would have it); `work`'s scope is the outer one.
    return yield* Effect.scopedWith((engineScope) =>
      Effect.gen(function* () {
        const engineContext = yield* Layer.buildWithScope(
          Layer.mergeAll(engineLayer, storeLayer, worktreesLayer(world)),
          engineScope,
        );
        const workClock = isTestClock(ownerClock)
          ? yield* settledTestClock(ownerClock, caller)
          : ownerClock;
        return yield* work(world, tmp, prepared).pipe(
          Effect.provide(engineContext),
          Effect.provideService(Clock.Clock, workClock),
        );
      }),
    ).pipe(Effect.provide(loggerLayer), Effect.scoped, Effect.orDie);
  }).pipe(Effect.scoped);

/** A `Clock` a test drives: Effect's `TestClock`, under `it.effect`. */
interface DrivenClock extends Clock.Clock {
  readonly adjust: (duration: Duration.Input) => Effect.Effect<void>;
  readonly setTime: (timestamp: number) => Effect.Effect<void>;
}

const isTestClock = (clock: Clock.Clock): clock is DrivenClock =>
  "adjust" in clock && typeof clock.adjust === "function";

const CLOCK_WARNING =
  "A test is using time, but is not advancing the test clock, which may result in the test hanging. Use TestClock.adjust to manually advance the time.";

/**
 * Effect's unadvanced-clock warning is one-shot per `TestClock`: the first sleep arms it, and the
 * first `adjust` disarms it for good; it fires if a second of real time passes in between. The
 * engine parks its housekeeping timers on the clock the moment it is built, so with a built engine
 * the warning measures the real time a correct test spends in git and the filesystem before it
 * first adjusts, or for a test that drives no deadline at all, the whole case: under a loaded CI
 * box that crosses a second and a passing test is failed. So once the engine is up the clock is
 * settled (an adjust of nothing), and the test's own fiber gets the same warning back, with the
 * same delay and the same words, armed by each sleep it takes itself and cancelled by its next
 * adjust: a case that sleeps on virtual time without driving it is still named, while the engine's
 * timers, and the fibers the engine forks, never are.
 */
const settledTestClock = (clock: DrivenClock, caller: number) =>
  Effect.gen(function* () {
    yield* clock.adjust(Duration.zero);
    let adjusts = 0;
    let warned = false;
    const driven = <A>(drive: Effect.Effect<A>) =>
      Effect.suspend(() => {
        adjusts++;
        return drive;
      });
    const live = Clock.Clock.defaultValue();
    const strict: DrivenClock = {
      ...clock,
      adjust: (duration) => driven(clock.adjust(duration)),
      setTime: (timestamp) => driven(clock.setTime(timestamp)),
      sleep: (duration) =>
        Effect.withFiber((fiber) => {
          if (fiber.id !== caller) return clock.sleep(duration);
          const armed = adjusts;
          return Effect.gen(function* () {
            const watchdog = yield* Effect.sync(() => {
              if (adjusts === armed && !warned) {
                warned = true;
                console.warn(CLOCK_WARNING);
              }
            }).pipe(
              Effect.delay(Duration.seconds(1)),
              Effect.provideService(Clock.Clock, live),
              Effect.forkChild,
            );
            yield* clock.sleep(duration).pipe(Effect.ensuring(Fiber.interrupt(watchdog)));
          });
        }),
    };
    return strict;
  });

/**
 * The stand-in daemon as a current sealantd answers (cross-repo decision 17): every flush answer
 * under the lease held by the requested workspace, stamped with where the executor made it:
 * that epoch, the lease's launch, its boot and an increasing observation. An explicit origin
 * passes through unchanged, including a foreign placeholder identity. Mend
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
            const lease = [...memory.leases.values()].find(
              (held) =>
                held.executorId !== null &&
                (world.sessions.get(held.executorId)?.sealantWorkspaceId === target.id ||
                  world.executorLaunches.get(held.executorId)?.workspaceId === target.id),
            );
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
                ...(answer.headN === undefined ? {} : { headN: answer.headN }),
              },
            };
          }),
        ),
    })),
  ).pipe(Layer.provide(layer));
};
