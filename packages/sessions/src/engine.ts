import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AgentConversationRepo,
  type AgentRequestAlreadyResolvedError,
  AgentRequestNotFoundError,
  CheckpointsRepo,
  HotWorkspacesRepo,
  ProjectEnvironmentRepo,
  ProjectMountsRepo,
  type ProjectNotFoundError,
  ProjectSecretsRepo,
  ProjectsRepo,
  ReferencesRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionChangesRepo,
  SessionGitOpsRepo,
  type SessionNotFoundError,
  type SessionOutcome,
  ProjectServiceRecipesRepo,
  SessionProcessesRepo,
  SessionRunsRepo,
  SessionsRepo,
  SettingsRepo,
  UserDotfilesRepo,
  SessionChannelTokensRepo,
} from "@mend/db";
import {
  type AgentRequestId,
  type AgentTurnId,
  SealantRunId,
  SealantWorkspaceId,
  type ServiceForwardId,
  type ServiceId,
  SessionGitOpId,
  SessionId,
  type SessionProcessId,
  type ProjectId,
  type WorkspaceImage,
} from "@mend/domain";
import type {
  Checkpoint,
  CheckpointTrigger,
  HotWorkspace,
  Project,
  Session,
  SessionProcess,
  SessionRun,
} from "@mend/domain/workbench";
import {
  AGENT_PROCESS_KINDS,
  type AgentApprovalDecision,
  type AgentInputAnswers,
  type AgentRequest,
  type AgentTurn,
  type LaunchStart,
  ProtocolHarnessUnsupportedError,
  composeProtocolArgv,
  agentProcessesOf,
  currentAgentProcess,
  foldSessionLiveness,
  isAgentProcessKind,
  isLiveAgentProcess,
  isLiveProcess,
  agentProcessOutcome,
  type ServiceBrowserScheme,
  type ServiceDeclarationSource,
  resolveServiceEndpoints,
  ServiceView,
  SessionExtraMount,
  SessionReferenceMount,
} from "@mend/domain/workbench";
import { asSealantUser, SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  AgentBridge,
  DotfilesStore,
  type GitError,
  MendKeys,
  NO_SIGNER_MESSAGE,
  SecretCipher,
  Store,
  processStatePathOf,
  sessionStatePathOf,
  sshTransportArgs,
  worktreePathOf,
  DeploymentConfig,
} from "@mend/store";
import type { Harness, Run as SdkRun, Workspace, WorkspaceCredentialsOptions } from "@sealant/sdk";
import { claudeCode, codex, opencode } from "@sealant/sdk";
import { Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

import { DotfilesResolveError, resolveDotfilesArchives } from "./dotfiles.ts";
import { parseGitRemoteCommand } from "./git-transport.ts";
import {
  HARNESS_STATE,
  HarnessStateCommandError,
  type HarnessStateError,
  HarnessStateIOError,
  HarnessStateInvalidError,
  distillOpeningPrompt,
  extractTranscript,
  nativeResumeArgv,
  type HarnessStateManifest,
  type LocatedHarnessState,
  locateHarnessState,
} from "./harness-state.ts";
import { hotFingerprint, type HotFingerprintInputs } from "./hot-pool.ts";
import {
  convertNativeSession,
  ingestNativeSession,
  type ConvertedNativeSession,
} from "./native-convert.ts";
import { ProtocolHost, type ProtocolHostNotLiveError } from "./protocol-host.ts";
import { mergeRecipes, readServiceRecipes } from "./recipes.ts";
import { ServiceBindError, ServiceHost } from "./service-host.ts";
import {
  SESSION_SOCKET_MOUNT_PATH,
  SessionSocketHost,
  type SessionSocketApi,
} from "./session-socket.ts";

/**
 * How a harness takes an opening prompt (the cross-harness handoff). The public SDK rejects argv
 * elements with outer whitespace, so the exact user-approved bytes travel as bounded base64 chunks
 * and are decoded in the workspace. The sentinel preserves trailing newlines through POSIX command
 * substitution.
 */
const promptArgv = (harness: string, prompt: string): ReadonlyArray<string> | null => {
  const command = (() => {
    switch (harness) {
      case "claude":
        return 'exec claude --dangerously-skip-permissions "$prompt"';
      case "codex":
        return 'exec codex --dangerously-bypass-approvals-and-sandbox "$prompt"';
      case "opencode":
        return 'exec opencode run "$prompt"';
      default:
        return null;
    }
  })();
  if (command === null) return null;

  const encoded = Buffer.from(prompt, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 60_000) {
    chunks.push(encoded.slice(offset, offset + 60_000));
  }
  const decode =
    'encoded=; for chunk; do encoded="$encoded$chunk"; done; ' +
    'prompt="$(printf %s "$encoded" | base64 -d; printf x)"; prompt=${prompt%x}; ' +
    command;
  return ["sh", "-c", decode, "sh", ...chunks];
};

/** Credentials ride connected accounts (references only); harness picks image behavior. */
const withGitHubCredentialFallback = (
  harnessCredentials: WorkspaceCredentialsOptions,
): ReadonlyArray<WorkspaceCredentialsOptions | undefined> => [
  { ...harnessCredentials, github: true },
  harnessCredentials,
  { github: true },
  undefined,
];

const platformShape = (
  harness: string,
): {
  harness: Harness;
  credentialAttempts: ReadonlyArray<WorkspaceCredentialsOptions | undefined>;
} => {
  switch (harness) {
    case "codex":
      return {
        harness: codex(),
        credentialAttempts: withGitHubCredentialFallback({ codex: true }),
      };
    case "claude":
      return {
        harness: claudeCode(),
        credentialAttempts: withGitHubCredentialFallback({ claude: true }),
      };
    case "shell":
      // A shell is an open workbench: the unified image carries EVERY baked
      // agent CLI, so a shell session gets every harness's credentials — the
      // user may open either agent from inside (docs/BUGS.md 2026-08-13).
      // The ladder degrades PER PROVIDER, never per bundle: a create that
      // names an account the user has not connected fails whole, so a
      // codex-only user must still reach `{ codex }` — the SDK offers no way
      // to ask which accounts exist, so Mend probes from most to least.
      return {
        harness: codex(),
        credentialAttempts: [
          { claude: true, codex: true, github: true },
          { codex: true, github: true },
          { claude: true, github: true },
          { claude: true, codex: true },
          { codex: true },
          { claude: true },
          { github: true },
          undefined,
        ],
      };
    default:
      return { harness: opencode(), credentialAttempts: [{ github: true }, undefined] };
  }
};

/**
 * The argv an open-workbench PTY actually runs. `["bash"]` is the request
 * sentinel (UI, resume paths, shell tabs), but the process launched is the
 * image's configured login shell — the user's dotfiles only load in their
 * own shell. Custom images keep bash: their contract promises only a POSIX
 * sh, and dotfiles are skipped there anyway.
 */
const interactiveShellArgv = (
  image: WorkspaceImage | null,
  rest: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [
  // Flags ride along untranslated: -i/-l/-c mean the same in bash, zsh, fish.
  image !== null && image.mode === "family" ? image.shell : "bash",
  ...rest,
];

/**
 * Permission prompts are the harness re-asking a question Mend already
 * answers: the session runs in an isolated workspace on its own
 * worktree, every byte is recorded, and nothing lands without review.
 * Default every harness to its bypass mode; a caller that passes the
 * flag itself (or a contrary one) is left alone.
 */
const withPermissionDefaults = (
  harness: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (harness === "claude" && head === "claude" && !argv.includes("--permission-mode")) {
    return argv.includes("--dangerously-skip-permissions")
      ? argv
      : ["claude", "--dangerously-skip-permissions", ...rest];
  }
  if (harness === "codex" && head === "codex" && !argv.includes("--sandbox")) {
    return argv.includes("--dangerously-bypass-approvals-and-sandbox")
      ? argv
      : ["codex", "--dangerously-bypass-approvals-and-sandbox", ...rest];
  }
  return argv;
};

/**
 * "Could not reach the platform" is not "the run is over". Only a
 * control-plane answer that the run no longer exists settles a session from
 * the supervision path; everything else — a wrong SEALANT_BASE_URL, a control
 * plane mid-upgrade, a network blip — leaves the session alone and retries,
 * so a misconfigured or briefly-blind server can never destroy live work it
 * didn't start.
 */
const runIsGone = (error: SealantPlatformError) => error.status === 404 || error.status === 410;

/** A dead command's last words — the PTY record replays after settle. Bounded, best-effort. */
const ptyOutputTail = (pty: {
  output: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<{
    readonly data: string | Uint8Array;
  }>;
}): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      let text = "";
      try {
        for await (const chunk of pty.output({ signal: controller.signal })) {
          text +=
            typeof chunk.data === "string" ? chunk.data : new TextDecoder().decode(chunk.data);
          if (text.length > 4000) {
            text = text.slice(-4000);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      return text.slice(-1500).trim();
    },
    catch: () => new Error("output unavailable"),
  }).pipe(Effect.orElseSucceed(() => ""));

/** How long `mend service run` waits for the declared port before reporting unreachable. */
const SERVICE_START_TIMEOUT_MS = 60_000;

const SUPERVISE_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.min(Duration.fromInputUnsafe(delay), Duration.seconds(30))),
  ),
);

/** Workspace statuses a hot entry can still serve from; anything else drains it. */
const workspaceIsLive = (status: string) =>
  status === "queued" || status === "running" || status === "ready";

/** Hidden shell sessions created by the retired desktop bench path. */
const isLegacyBench = (session: Session): boolean =>
  session.harness === "shell" && session.label === "bench";

export interface ProvisionInput {
  readonly projectId: ProjectId;
  readonly harness: string;
  readonly label: string | null;
  /** Branch or sha to base the worktree on; null = the project's default branch. */
  readonly base: string | null;
  /** Who is provisioning — whose dotfiles apply at launch. Null when the caller is unknown. */
  readonly ownerUserId: string | null;
}

/** A supporting process needs a current reachable workspace. */
export class SessionNotLiveError extends Schema.TaggedErrorClass<SessionNotLiveError>()(
  "SessionNotLiveError",
  {
    sessionId: Schema.String,
  },
) {}

/** A retired hidden bench remains reviewable but cannot start more work. */
export class LegacyBenchReadOnlyError extends Schema.TaggedErrorClass<LegacyBenchReadOnlyError>()(
  "LegacyBenchReadOnlyError",
  { sessionId: Schema.String },
) {}

/** The process id is unknown or does not identify a supporting shell. */
export class ShellProcessNotFoundError extends Schema.TaggedErrorClass<ShellProcessNotFoundError>()(
  "ShellProcessNotFoundError",
  {
    processId: Schema.String,
  },
) {}

/** A supporting shell label is empty, too long, or already used by a live sibling. */
export class ShellLabelError extends Schema.TaggedErrorClass<ShellLabelError>()("ShellLabelError", {
  processId: Schema.String,
  message: Schema.String,
}) {}

/** The process id is unknown, ended, or not a Service. */
export class ServiceNotFoundError extends Schema.TaggedErrorClass<ServiceNotFoundError>()(
  "ServiceNotFoundError",
  {
    processId: Schema.String,
  },
) {}

/** The supervised command ended before its port ever answered. */
export class ServiceStartError extends Schema.TaggedErrorClass<ServiceStartError>()(
  "ServiceStartError",
  {
    message: Schema.String,
  },
) {}

/** A custom-image setup command exited nonzero — the launch fails rather than run half-prepared. */
export class SessionLaunchSetupError extends Schema.TaggedErrorClass<SessionLaunchSetupError>()(
  "SessionLaunchSetupError",
  {
    sessionId: Schema.String,
    command: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * The workbench session engine (plan §7.2, M1) — the supervisor extracted from
 * the queue-era run starter (docs/M0-INVENTORY.md), rewired onto sessions and
 * the central store:
 *
 * - `provision` creates the worktree, the session row, checkpoint 0
 *   (`session-start`), and the session's change row.
 * - `attachRun` binds an already-started Sealant run and forks supervision:
 *   record stream → last-seen sequence → progress events → settle →
 *   checkpoint. Launching the run is the caller's job — today that is a
 *   prompt-shaped harness run; when the platform ships store mounts and the
 *   interactive PTY surface (PLATFORM-FEEDBACK.md 2026-07-25) the launcher
 *   changes and supervision does not.
 * - `resume` re-attaches every unsettled session after a crash/restart from
 *   its stored sequence. Runs at layer construction.
 *
 * Fibers fork into the layer scope, so they live as long as the process.
 */
export class SessionEngine extends Context.Service<
  SessionEngine,
  {
    readonly provision: (
      input: ProvisionInput,
    ) => Effect.Effect<Session, ProjectNotFoundError | GitError>;
    readonly attachRun: (
      sessionId: SessionId,
      sealantRunId: SealantRunId,
      workspaceId: SealantWorkspaceId,
    ) => Effect.Effect<void, SessionNotFoundError>;
    /**
     * The supervised launch (SDK 0.7.0): a workspace mounting the session's
     * worktree, an interactive PTY session running `argv` inside it, and
     * supervision attached — the record begins here.
     */
    readonly launch: (
      sessionId: SessionId,
      argv: ReadonlyArray<string>,
    ) => Effect.Effect<
      Session,
      | SessionNotFoundError
      | LegacyBenchReadOnlyError
      | ProjectNotFoundError
      | SealantPlatformError
      | HarnessStateError
      | SessionLaunchSetupError
      | DotfilesResolveError
    >;
    /** Launch a supported harness as a structured byte protocol over a Sealant pipe session. */
    readonly launchProtocol: (
      sessionId: SessionId,
      start: LaunchStart,
      author: string | null,
      launchCorrelationId?: string | null,
      forceFreshWorkspace?: boolean,
    ) => Effect.Effect<
      Session,
      | SessionNotFoundError
      | LegacyBenchReadOnlyError
      | ProjectNotFoundError
      | SealantPlatformError
      | HarnessStateError
      | SessionLaunchSetupError
      | DotfilesResolveError
      | ProtocolHarnessUnsupportedError
    >;
    /** Queue one authored turn on the live protocol process. */
    readonly submitTurn: (
      sessionId: SessionId,
      input: string,
      author: string | null,
    ) => Effect.Effect<AgentTurn, ProtocolHostNotLiveError>;
    /** Interrupt the running protocol turn. */
    readonly interruptTurn: (turnId: AgentTurnId) => Effect.Effect<void, ProtocolHostNotLiveError>;
    /** Route and record one human response to a live provider request. */
    readonly respondRequest: (
      requestId: AgentRequestId,
      response:
        | { readonly decision: AgentApprovalDecision; readonly answers?: never }
        | { readonly answers: AgentInputAnswers; readonly decision?: never },
      decidedBy: string,
    ) => Effect.Effect<
      AgentRequest,
      ProtocolHostNotLiveError | AgentRequestNotFoundError | AgentRequestAlreadyResolvedError
    >;
    /** Launch the exact approved Review instruction with a durable process correlation. */
    readonly launchFollowUp: (
      sessionId: SessionId,
      instruction: string,
      launchCorrelationId: string,
    ) => Effect.Effect<
      Session,
      | SessionNotFoundError
      | SessionNotLiveError
      | LegacyBenchReadOnlyError
      | ProjectNotFoundError
      | SealantPlatformError
      | HarnessStateError
      | SessionLaunchSetupError
      | DotfilesResolveError
    >;
    /**
     * Schedule a hot-pool reconcile for the project (coalesced per project; returns
     * immediately). Call after any change to an input workspaces are created from — the
     * hot-sessions count itself, the image, dotfiles, env, secrets, references, or mounts.
     */
    readonly reconcileHotSessions: (projectId: ProjectId) => Effect.Effect<void>;
    /** Snapshot the worktree now — review-open and user-mark come through here. */
    readonly checkpointNow: (
      sessionId: SessionId,
      trigger: CheckpointTrigger,
    ) => Effect.Effect<Checkpoint, SessionNotFoundError | ProjectNotFoundError | GitError>;
    /**
     * The user's stop: end every live agent process (close its PTY, settle its run). Shells and
     * Services keep their own lifecycle — the session reads `idle` while they hold the workspace
     * and settles `stopped` when the last one ends.
     */
    readonly stop: (sessionId: SessionId) => Effect.Effect<void, SessionNotFoundError>;
    /**
     * The second pane (docs/SESSION-SERVICES.md): a shell PTY in the
     * session's live workspace, beside the agent — same repo, same
     * dependencies, same network. Its process record is a workspace lease;
     * attach through the TTY route with `?process=<id>`.
     */
    readonly openShell: (
      sessionId: SessionId,
    ) => Effect.Effect<
      SessionProcess,
      SessionNotFoundError | SessionNotLiveError | LegacyBenchReadOnlyError | SealantPlatformError
    >;
    /** Stop one supporting shell process group. Repeating a completed stop is idempotent. */
    readonly stopShell: (
      processId: SessionProcessId,
    ) => Effect.Effect<SessionProcess, ShellProcessNotFoundError>;
    /** Rename one live supporting shell inside its owning session. */
    readonly renameShell: (
      processId: SessionProcessId,
      label: string,
    ) => Effect.Effect<SessionProcess, ShellProcessNotFoundError | ShellLabelError>;
    /**
     * Adopt an already-listening workspace port as a Service
     * (docs/SESSION-SERVICES.md): bind a host listener on the private
     * interfaces and pump each accepted connection over a workspace forward.
     * No supervision, no logs — reachability is the whole observation.
     */
    readonly addService: (
      sessionId: SessionId,
      workspacePort: number,
      name: string | null,
      protocol?: "tcp" | "udp",
      browserScheme?: ServiceBrowserScheme,
    ) => Effect.Effect<
      ServiceView,
      | SessionNotFoundError
      | SessionNotLiveError
      | LegacyBenchReadOnlyError
      | SealantPlatformError
      | ServiceBindError
    >;
    /**
     * Start and supervise a Service (docs/SESSION-SERVICES.md): a PTY-backed
     * command in the session's workspace with its own record (= its logs),
     * awaited until the declared port answers, then exposed like an adopted
     * Service. Never occupies an agent tool call.
     */
    readonly runService: (
      sessionId: SessionId,
      argv: ReadonlyArray<string>,
      workspacePort: number,
      name: string | null,
      protocol?: "tcp" | "udp",
      browserScheme?: ServiceBrowserScheme,
    ) => Effect.Effect<
      ServiceView,
      | SessionNotFoundError
      | SessionNotLiveError
      | LegacyBenchReadOnlyError
      | SealantPlatformError
      | ServiceBindError
      | ServiceStartError
    >;
    /** Resolve and launch a declared recipe on the server so its provenance cannot be forged. */
    readonly runServiceRecipe: (
      sessionId: SessionId,
      name: string,
    ) => Effect.Effect<
      ServiceView,
      | SessionNotFoundError
      | SessionNotLiveError
      | LegacyBenchReadOnlyError
      | SealantPlatformError
      | ServiceBindError
      | ServiceStartError
    >;
    /** Append a process attempt while preserving the stable Service and forward. */
    readonly restartService: (
      serviceId: ServiceId,
    ) => Effect.Effect<
      ServiceView,
      ServiceNotFoundError | SealantPlatformError | ServiceStartError | ServiceBindError
    >;
    /** Stop a Service: end its current attempt, close its forward, release its lease. */
    readonly stopService: (
      serviceId: ServiceId,
    ) => Effect.Effect<ServiceView, ServiceNotFoundError>;
    /**
     * Rejoin a session as a continuous piece of work — harness- and
     * machine-agnostic. Same worktree, same change, same conversation: the
     * fresh workspace restores the saved harness state (a claude resume is
     * NATIVE, memory intact); resuming WITH a different harness carries the
     * conversation across as a distilled opening prompt (text is the
     * interchange format — native state never crosses harnesses).
     */
    readonly resumeSession: (
      sessionId: SessionId,
      harness: string | null,
      fresh?: boolean,
    ) => Effect.Effect<
      Session,
      | SessionNotFoundError
      | SessionNotLiveError
      | LegacyBenchReadOnlyError
      | ProjectNotFoundError
      | SealantPlatformError
      | HarnessStateError
      | SessionLaunchSetupError
      | DotfilesResolveError
    >;
    /**
     * The session's conversation as the canonical record — read LIVE from the
     * running workspace's harness state (or from the store once settled).
     * The chat surfaces render this; the terminal stays the raw view.
     */
    readonly transcript: (sessionId: SessionId) => Effect.Effect<
      {
        readonly sourceHarness: string;
        readonly events: ReadonlyArray<import("./native-convert.ts").CanonicalEvent>;
      },
      SessionNotFoundError
    >;
  }
>()("@mend/sessions/SessionEngine") {}

type SessionEngineRequirements =
  | SealantClient
  | SessionChannelTokensRepo
  | DeploymentConfig
  | AgentConversationRepo
  | ProtocolHost
  | SessionsRepo
  | HotWorkspacesRepo
  | UserDotfilesRepo
  | DotfilesStore
  | SessionRunsRepo
  | SessionProcessesRepo
  | ServicesRepo
  | ServiceForwardsRepo
  | ServiceObservationsRepo
  | ServiceHost
  | SessionSocketHost
  | ProjectsRepo
  | SessionChangesRepo
  | CheckpointsRepo
  | ReferencesRepo
  | ProjectMountsRepo
  | ProjectEnvironmentRepo
  | ProjectSecretsRepo
  | SecretCipher
  | ProjectServiceRecipesRepo
  | SettingsRepo
  | Store
  | SessionGitOpsRepo
  | MendKeys
  | AgentBridge;

export const SessionEngineLive: Layer.Layer<SessionEngine, never, SessionEngineRequirements> =
  Layer.effect(
    SessionEngine,
    Effect.gen(function* () {
      const sealant = yield* SealantClient;

      // ── Principals ──────────────────────────────────────────────────────────────
      // A session's platform resources belong to its owner's Sealant user. These
      // resolve the owner (the operator for rows that predate ownership) and run
      // the effect as them; a missing row changes nothing — the effect then fails
      // its own way.
      const owned =
        (sessionId: SessionId) =>
        <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          sessions.byId(sessionId).pipe(
            Effect.option,
            Effect.flatMap((session) =>
              self.pipe(asSealantUser(Option.isSome(session) ? session.value.ownerUserId : null)),
            ),
          );
      const ownedByProcess =
        (processId: SessionProcessId) =>
        <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          processes
            .byId(processId)
            .pipe(
              Effect.flatMap((process) =>
                process === null ? self.pipe(asSealantUser(null)) : owned(process.sessionId)(self),
              ),
            );
      const ownedByService =
        (serviceId: ServiceId) =>
        <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          services
            .byId(serviceId)
            .pipe(
              Effect.flatMap((service) =>
                service === null ? self.pipe(asSealantUser(null)) : owned(service.sessionId)(self),
              ),
            );
      /** The in-workspace socket's closures, each run as the session owner. */
      const ownedSocketApi = (sessionId: SessionId, api: SessionSocketApi): SessionSocketApi => ({
        recipes: () => owned(sessionId)(api.recipes()),
        listServices: () => owned(sessionId)(api.listServices()),
        runServiceRecipe: (name) => owned(sessionId)(api.runServiceRecipe(name)),
        runService: (argv, port, name, protocol) =>
          owned(sessionId)(api.runService(argv, port, name, protocol)),
        addService: (port, name, protocol) =>
          owned(sessionId)(api.addService(port, name, protocol)),
        stopService: (reference) => owned(sessionId)(api.stopService(reference)),
        restartService: (reference) => owned(sessionId)(api.restartService(reference)),
        gitTransport: (input) => owned(sessionId)(api.gitTransport(input)),
        gitTransportDone: (opId, exitCode, refUpdates) =>
          owned(sessionId)(api.gitTransportDone(opId, exitCode, refUpdates)),
      });
      const conversations = yield* AgentConversationRepo;
      const channelTokens = yield* SessionChannelTokensRepo;
      const deployment = yield* DeploymentConfig;
      /**
       * The network session channel (docs/KUBERNETES.md): when configured, every workspace is
       * told where the channel is and handed a per-session bearer token through the SECRET env
       * channel (so the platform's recorder redacts it). The token grants exactly what the
       * socket grants — this session's closures — and is revoked with the workspace.
       */
      const sessionChannelLaunchEnv = (sessionId: SessionId) =>
        Effect.gen(function* () {
          const endpoint = deployment.sessionEndpoint;
          if (endpoint === undefined) {
            return { env: {}, secretEnv: {} };
          }
          const token = yield* channelTokens.issue(sessionId);
          return {
            env: { MEND_SESSION_ENDPOINT: endpoint.url, MEND_SESSION_ID: sessionId },
            secretEnv: { MEND_SESSION_TOKEN: token },
          };
        });
      const protocolHost = yield* ProtocolHost;
      const sessions = yield* SessionsRepo;
      const hotWorkspaces = yield* HotWorkspacesRepo;
      const userDotfilesRepo = yield* UserDotfilesRepo;
      const dotfilesStore = yield* DotfilesStore;
      const sessionRuns = yield* SessionRunsRepo;
      const processes = yield* SessionProcessesRepo;
      const services = yield* ServicesRepo;
      const serviceForwards = yield* ServiceForwardsRepo;
      const serviceObservations = yield* ServiceObservationsRepo;
      const serviceHost = yield* ServiceHost;
      const socketHost = yield* SessionSocketHost;
      const projects = yield* ProjectsRepo;
      const changes = yield* SessionChangesRepo;
      const checkpoints = yield* CheckpointsRepo;
      const references = yield* ReferencesRepo;
      const projectMounts = yield* ProjectMountsRepo;
      const projectEnvironment = yield* ProjectEnvironmentRepo;
      const projectSecrets = yield* ProjectSecretsRepo;
      const secretCipher = yield* SecretCipher;
      const projectRecipes = yield* ProjectServiceRecipesRepo;
      const settingsRepo = yield* SettingsRepo;
      const store = yield* Store;
      const gitOps = yield* SessionGitOpsRepo;
      const mendKeys = yield* MendKeys;
      const agentBridge = yield* AgentBridge;
      /** Open bridge-op attributions, ended when the transport closes. */
      const bridgeContexts = new Map<string, () => void>();
      const scope = yield* Effect.scope;
      // Service lifecycle calls are rare and may span platform I/O. One engine-local permit keeps
      // Stop, Restart, Run, and watcher cleanup ordered without holding a database transaction
      // across that I/O; compare-and-set persistence below protects stale cleanup after crashes.
      const serviceLifecycle = Semaphore.makeUnsafe(1);
      const withServiceLifecycle = serviceLifecycle.withPermit;

      const readServiceView = Effect.fn("SessionEngine.readServiceView")(function* (
        serviceId: ServiceId,
      ) {
        const service = yield* services.byId(serviceId);
        if (service === null) return yield* Effect.die(`Service ${serviceId} disappeared`);
        const attempts = yield* processes.listForService(service.id);
        const currentForward =
          service.currentForwardId === null
            ? null
            : yield* serviceForwards.byId(service.currentForwardId);
        const previousForward =
          currentForward === null || currentForward.supersedesForwardId === null
            ? null
            : yield* serviceForwards.byId(currentForward.supersedesForwardId);
        const latestObservation = yield* serviceObservations.latestForService(service.id);
        const session = yield* sessions.byId(service.sessionId).pipe(Effect.orDie);
        return new ServiceView({
          service,
          attempts,
          currentForward,
          previousForward,
          latestObservation,
          workspaceExpiresAt: session.workspaceExpiresAt,
          workspaceTtlRenewedAt: session.workspaceTtlRenewedAt,
          workspaceTtlRenewalFailedAt: session.workspaceTtlRenewalFailedAt,
          workspaceTtlRenewalError: session.workspaceTtlRenewalError,
          endpoints: resolveServiceEndpoints(service, currentForward),
          previousEndpoints: resolveServiceEndpoints(service, previousForward),
        });
      });

      /** The session's worktree path, derived — never stored twice. */
      const worktreeOf = Effect.fn("SessionEngine.worktreeOf")(function* (session: Session) {
        const project = yield* projects.byId(session.projectId);
        return worktreePathOf(project.storePath, session.worktree);
      });

      const takeCheckpoint = Effect.fn("SessionEngine.takeCheckpoint")(function* (
        session: Session,
        trigger: CheckpointTrigger,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
      ) {
        const worktree = yield* worktreeOf(session);
        const previous = yield* checkpoints.latestForSession(session.id);
        const index = yield* checkpoints.countForSession(session.id);
        const snapshot = yield* store.checkpoint(
          worktree,
          session.id,
          index,
          previous?.sha ?? null,
        );
        return yield* checkpoints.create({
          sessionId: session.id,
          ref: snapshot.ref,
          sha: snapshot.sha,
          sealantRunId: cursor.sealantRunId,
          seq: cursor.sequence,
          trigger,
        });
      });

      /** A checkpoint that cannot be taken is a gap, carried as content — never a crash. */
      const tryCheckpoint = (
        session: Session,
        trigger: CheckpointTrigger,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
      ) =>
        takeCheckpoint(session, trigger, cursor).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: checkpoint failed").pipe(
              Effect.annotateLogs({ sessionId: session.id, trigger, error: String(error) }),
              Effect.as(null),
            ),
          ),
        );

      const refreshChangeHead = Effect.fn("SessionEngine.refreshChangeHead")(function* (
        session: Session,
      ) {
        const change = yield* changes.bySession(session.id);
        if (change === null) return;
        const latest = yield* checkpoints.latestForSession(session.id);
        if (latest !== null) yield* changes.refreshHead(change.id, latest.sha);
      });

      const supervise = Effect.fn("SessionEngine.supervise")(function* (
        session: Session,
        sessionRun: SessionRun,
        sdkRun: SdkRun,
      ) {
        yield* sealant.recordStream(sdkRun, { from: sessionRun.lastSeenSequence }).pipe(
          Stream.tap((entry) =>
            Effect.gen(function* () {
              yield* sessionRuns.saveLastSeenSequence(sessionRun.sealantRunId, entry.sequence);
              // Denormalized latest-run progress for existing list/UI contracts only. Supervision
              // never reads this session-level mirror.
              yield* sessions.saveLastSeenSequence(session.id, entry.sequence);
              yield* sessions.notifyProgress(session.id, entry.sequence, entry.summary);
            }),
          ),
          Stream.runDrain,
          // A broken stream is not a settled session — the wait below decides.
          Effect.catch((error) =>
            Effect.logWarning("session engine: record stream failed").pipe(
              Effect.annotateLogs({ sessionId: session.id, error: error.message }),
            ),
          ),
        );

        const settled = yield* sealant.waitRun(sdkRun);
        const outcome = settled.result.outcome === "completed" ? "completed" : "failed";
        const summary =
          settled.result.summary ??
          (outcome === "failed" ? `harness exited with code ${settled.result.exitCode}` : null);
        // The run ended, so the agent process recording it ended too. The PTY watcher races
        // this path; whichever observes the end first records it, and the other finds the row
        // already ended.
        const agentProcess = yield* agentProcessForRun(session.id, sessionRun.sealantRunId);
        if (agentProcess !== null) {
          const ended = yield* endAgentProcess(agentProcess, {
            how: "exited",
            exitCode: typeof settled.result.exitCode === "number" ? settled.result.exitCode : null,
            outcome,
            summary,
          });
          if (ended) yield* finishAgentProcess(agentProcess, "turn-boundary");
          return;
        }
        // No process row of our own (a run attached from outside): the run record is the
        // only evidence, and the fold settles the session from it.
        yield* sessionRuns.settle(sessionRun.sealantRunId, outcome, summary);
        yield* reconcileSession(session.id, { sweep: false });
        const current = yield* sessions.byId(session.id).pipe(Effect.orElseSucceed(() => session));
        const currentRun = yield* sessionRuns.bySealantRunId(sessionRun.sealantRunId);
        yield* tryCheckpoint(current, "turn-boundary", {
          sealantRunId: sessionRun.sealantRunId,
          sequence: currentRun?.lastSeenSequence ?? sessionRun.lastSeenSequence,
        });
        yield* refreshChangeHead(current).pipe(Effect.ignore);
        yield* sweepWorkspace(session.id);
      });

      /** The agent process whose record is this run, if the launch recorded one. */
      const agentProcessForRun = Effect.fn("SessionEngine.agentProcessForRun")(function* (
        sessionId: SessionId,
        sealantRunId: SealantRunId,
      ) {
        const rows = yield* processes.listForSession(sessionId);
        return (
          rows.find(
            (process) => isAgentProcessKind(process.kind) && process.sealantRunId === sealantRunId,
          ) ?? null
        );
      });

      /**
       * Supervision lost the run for good (the control plane says it no longer exists, or the
       * supervisor died): record the failure on the process that carried it, or on the bare run
       * when no process row exists.
       */
      const failRun = (sessionId: SessionId, sealantRunId: SealantRunId, message: string) =>
        Effect.gen(function* () {
          const agentProcess = yield* agentProcessForRun(sessionId, sealantRunId);
          if (agentProcess !== null) {
            const ended = yield* endAgentProcess(agentProcess, {
              how: "exited",
              exitCode: null,
              outcome: "failed",
              summary: message,
            });
            if (ended) yield* finishAgentProcess(agentProcess, "turn-boundary");
            return;
          }
          yield* sessionRuns.settle(sealantRunId, "failed", message);
          yield* reconcileSession(sessionId, { sweep: false });
          yield* sweepWorkspace(sessionId);
        }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void));

      /** Supervise a session's run for as long as this process lives. */
      const superviseExisting = (sessionId: SessionId, sealantRunId: SealantRunId) =>
        Effect.gen(function* () {
          const current = yield* sessions.byId(sessionId);
          if (current.settledAt !== null) return;
          const sessionRun = yield* sessionRuns.bySealantRunId(sealantRunId);
          if (sessionRun === null) {
            yield* sessions.settle(
              sessionId,
              "failed",
              `run ${sealantRunId} is missing from the session record index`,
            );
            return;
          }
          yield* Effect.gen(function* () {
            const sdkRun = yield* sealant.getRun(sealantRunId);
            yield* supervise(current, sessionRun, sdkRun);
          }).pipe(asSealantUser(current.ownerUserId));
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("session engine: supervision interrupted; retrying").pipe(
              Effect.annotateLogs({ sessionId, error: error.message }),
            ),
          ),
          Effect.retry({
            while: (error) => error instanceof SealantPlatformError && !runIsGone(error),
            schedule: SUPERVISE_RETRY,
          }),
          Effect.catchTag("SealantPlatformError", (error) =>
            failRun(sessionId, sealantRunId, error.message),
          ),
          Effect.catchTag("SessionNotFoundError", () => Effect.void),
          Effect.catchDefect((defect) =>
            failRun(sessionId, sealantRunId, `supervision died: ${String(defect)}`),
          ),
        );

      const forkSupervision = (sessionId: SessionId, sealantRunId: SealantRunId) =>
        Effect.forkIn(superviseExisting(sessionId, sealantRunId), scope);

      const provision = Effect.fn("SessionEngine.provision")(
        function* (input: ProvisionInput) {
          return yield* provisionAs(input);
        },
        (effect, input) => effect.pipe(asSealantUser(input.ownerUserId)),
      );

      const provisionAs = Effect.fn("SessionEngine.provisionAs")(function* (input: ProvisionInput) {
        const project = yield* projects.byId(input.projectId);
        // Hot path: adopt a pre-provisioned skeleton when the project keeps them ready. Any
        // failure here falls back to the cold path — a claim must never cost a session.
        if (project.hotSessions > 0) {
          const claimed = yield* claimHotSession(project, input).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: hot claim failed — cold provision").pipe(
                Effect.annotateLogs({ projectId: project.id, error: String(error) }),
                Effect.as(null),
              ),
            ),
          );
          if (claimed !== null) return claimed;
        }
        const sessionId = SessionId.make(crypto.randomUUID());
        const worktree = yield* store.createWorktree(project.storePath, sessionId, input.base);
        const session = yield* sessions.create({
          id: sessionId,
          projectId: project.id,
          harness: input.harness,
          label: input.label,
          ownerUserId: input.ownerUserId,
          worktree: worktree.name,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
          contextSnapshotId: null,
        });
        yield* tryCheckpoint(session, "session-start", { sealantRunId: null, sequence: 0n });
        yield* changes.ensureForSession(project.id, session.id, worktree.branch, worktree.baseSha);
        return session;
      });

      const attachRun = Effect.fn("SessionEngine.attachRun")(function* (
        sessionId: SessionId,
        sealantRunId: SealantRunId,
        workspaceId: SealantWorkspaceId,
      ) {
        const session = yield* sessions.byId(sessionId);
        const existing = yield* sessionRuns.bySealantRunId(sealantRunId);
        if (existing === null) {
          yield* sessionRuns.create({
            sessionId,
            harness: session.harness,
            sealantRunId,
            sealantWorkspaceId: workspaceId,
            sealantSessionId: null,
          });
        }
        yield* sessions.setSealantIds(sessionId, sealantRunId, workspaceId);
        yield* sessions.setStatus(sessionId, "running");
        yield* forkSupervision(sessionId, sealantRunId);
      });

      /**
       * Interactive Claude Code ignores the platform's env-injected credential
       * during onboarding: `claude -p` honors `CLAUDE_CODE_OAUTH_TOKEN`, but
       * the TUI's first-run flow still demands a login until `~/.claude.json`
       * marks onboarding complete and `~/.claude/.credentials.json` exists.
       * Seed both from the injected env before exec'ing the real argv — only
       * when the token is present and no state file exists yet, so a real
       * login is never clobbered. Filed as platform feedback: the claude
       * injection should be file-kind, like codex's `auth.json`.
       */
      // A MERGE, not an exists-guard: a restored session brings back claude's
      // own rewritten `.claude.json` (which knows nothing of these flags), so
      // the seed must re-assert them on every launch while preserving whatever
      // state came back. Pre-answered dialogs: onboarding, bypass acceptance,
      // and the /workspace/repo trust — the user made the trust decision when
      // they adopted the repo, and bypass is Mend's stance (the workspace is
      // the sandbox).
      const CLAUDE_ONBOARDING_SEED =
        `node -e '` +
        `const fs=require("fs"),os=require("os"),h=os.homedir(),t=process.env.CLAUDE_CODE_OAUTH_TOKEN;` +
        `fs.mkdirSync(h+"/.claude",{recursive:true});` +
        `if(t&&!fs.existsSync(h+"/.claude/.credentials.json")){` +
        `fs.writeFileSync(h+"/.claude/.credentials.json",JSON.stringify({claudeAiOauth:{accessToken:t,refreshToken:"",expiresAt:9999999999999,scopes:["user:inference","user:profile"],subscriptionType:"max"}}),{mode:0o600})}` +
        `let c={};try{c=JSON.parse(fs.readFileSync(h+"/.claude.json","utf8"))}catch{}` +
        `c.hasCompletedOnboarding=true;c.bypassPermissionsModeAccepted=true;` +
        `c.projects=c.projects||{};` +
        `c.projects["/workspace/repo"]=Object.assign({},c.projects["/workspace/repo"],{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true});` +
        `fs.writeFileSync(h+"/.claude.json",JSON.stringify(c));` +
        // The bypass-acceptance dialog is actually gated on settings.json
        // (verified: accepting it writes exactly this key), not .claude.json.
        `let s={};try{s=JSON.parse(fs.readFileSync(h+"/.claude/settings.json","utf8"))}catch{}` +
        `s.skipDangerousModePermissionPrompt=true;` +
        // The workspace image never sees the operator's own ~/.claude
        // settings, so a fresh session silently falls back to the CLI's
        // default model. Default-if-absent only: a restored session's own
        // choice (or a mid-session /model) survives the merge.
        `s.model=s.model||"claude-fable-5";` +
        `fs.writeFileSync(h+"/.claude/settings.json",JSON.stringify(s))' 2>/dev/null; ` +
        // The workspace IS the sandbox: Claude Code refuses bypass-permissions
        // as root unless the environment says so, and it is telling the truth.
        `export IS_SANDBOX=1; ` +
        `exec "$@"`;

      const withHarnessSetup = (
        harness: string,
        argv: ReadonlyArray<string>,
      ): ReadonlyArray<string> => {
        if (harness === "claude") return ["sh", "-c", CLAUDE_ONBOARDING_SEED, "sh", ...argv];
        if (harness === "codex") return ["sh", "-c", CODEX_TRUST_SEED, "sh", ...argv];
        return argv;
      };

      const withHarnessBootstrap = (
        harness: string,
        argv: ReadonlyArray<string>,
      ): ReadonlyArray<string> => withHarnessSetup(harness, withPermissionDefaults(harness, argv));

      // Codex's per-project trust prompt, pre-answered the same way: the user
      // made the trust decision when they adopted the repo.
      const CODEX_TRUST_SEED =
        `mkdir -p "$HOME/.codex"; ` +
        `grep -q 'workspace/repo' "$HOME/.codex/config.toml" 2>/dev/null || ` +
        `printf '[projects."/workspace/repo"]\ntrust_level = "trusted"\n' >> "$HOME/.codex/config.toml"; ` +
        `exec "$@"`;

      // ─── the harness session store (automatic; see harness-state.ts) ──────

      /**
       * Pull ONE agent process's raw native harness state out of the still-warm workspace into
       * the central store, plus the primary transcript and the provider session id a native
       * resume needs. Harness state is per agent process: each capture lands in that process's
       * own directory, and the session-level "latest" view (`harnessStateFor`) reads the newest.
       * Runs when the process ends; must never break that path (callers go through
       * `tryHarvest`).
       */
      const harvestHarnessState = Effect.fn("SessionEngine.harvestHarnessState")(function* (
        agentProcess: SessionProcess,
      ) {
        const harness = agentProcess.harness;
        const shape = harness === null ? undefined : HARNESS_STATE[harness];
        if (harness === null || shape === undefined) return;
        const sessionId = agentProcess.sessionId;
        const session = yield* sessions.byId(sessionId);
        const project = yield* projects.byId(session.projectId);
        const stateDir = processStatePathOf(project.storePath, session.id, agentProcess.id);
        const workspace = yield* sealant.getWorkspace(agentProcess.sealantWorkspaceId);

        yield* Effect.tryPromise({
          try: () => fs.mkdir(stateDir, { recursive: true }),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId,
              operation: "write-archive",
              path: stateDir,
              message: `Could not create the harness-state directory for session ${sessionId}.`,
              cause,
            }),
        });
        // The manifest is the commit marker. Clear it before capture begins so
        // a failed new harvest can never masquerade as the current state by
        // leaving the previous run's provider session id in place.
        const manifestPath = path.join(stateDir, "manifest.json");
        yield* Effect.tryPromise({
          try: () => fs.rm(manifestPath, { force: true }),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId,
              operation: "clear-manifest",
              path: manifestPath,
              message: `Could not prepare saved harness state for session ${sessionId}.`,
              cause,
            }),
        });

        const list = shape.paths.map((p) => `"${p}"`).join(" ");
        const pack = yield* sealant.exec(workspace, [
          "sh",
          "-c",
          `cd "$HOME" || exit 1; L=""; for p in ${list}; do [ -e "$p" ] && L="$L $p"; done; ` +
            `[ -n "$L" ] || exit 3; tar -czf /tmp/mend-harness-state.tgz $L && ` +
            `base64 -w0 /tmp/mend-harness-state.tgz`,
        ]);
        if (pack.exitCode !== 0 || pack.stdout.trim() === "") {
          return yield* new HarnessStateCommandError({
            sessionId,
            harness: harness,
            operation: "capture-archive",
            exitCode: pack.exitCode,
            stderr: pack.stderr,
            message: `Could not capture ${harness} state for session ${sessionId}.`,
          });
        }
        const archivePath = path.join(stateDir, "harness-state.tar.gz");
        yield* Effect.tryPromise({
          try: () => fs.writeFile(archivePath, Buffer.from(pack.stdout.trim(), "base64")),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId,
              operation: "write-archive",
              path: archivePath,
              message: `Could not save ${harness} state for session ${sessionId}.`,
              cause,
            }),
        });

        const located = yield* sealant.exec(workspace, ["sh", "-c", shape.latestTranscript]);
        const transcriptFile = located.stdout.trim().split("\n")[0] ?? "";
        let providerSessionId: string | null = null;
        if (
          (harness === "claude" || harness === "codex") &&
          (located.exitCode !== 0 || transcriptFile === "")
        ) {
          return yield* new HarnessStateCommandError({
            sessionId,
            harness: harness,
            operation: "locate-transcript",
            exitCode: located.exitCode,
            stderr: located.stderr,
            message: `Captured ${harness} state but could not locate its transcript for session ${sessionId}.`,
          });
        }
        if (located.exitCode === 0 && transcriptFile !== "") {
          providerSessionId = shape.providerSessionId(transcriptFile);
          if ((harness === "claude" || harness === "codex") && providerSessionId === null) {
            return yield* new HarnessStateCommandError({
              sessionId,
              harness: harness,
              operation: "identify-session",
              exitCode: 0,
              stderr: "",
              message: `Could not identify the native ${harness} session in ${transcriptFile}.`,
            });
          }
          const native = yield* sealant.exec(workspace, ["cat", transcriptFile]);
          if (native.exitCode !== 0 || native.stdout === "") {
            return yield* new HarnessStateCommandError({
              sessionId,
              harness: harness,
              operation: "read-transcript",
              exitCode: native.exitCode,
              stderr: native.stderr,
              message: `Could not read the ${harness} transcript for session ${sessionId}.`,
            });
          }
          const transcriptPath = path.join(stateDir, "transcript.native");
          yield* Effect.tryPromise({
            try: () => fs.writeFile(transcriptPath, native.stdout),
            catch: (cause) =>
              new HarnessStateIOError({
                sessionId,
                operation: "write-transcript",
                path: transcriptPath,
                message: `Could not save the ${harness} transcript for session ${sessionId}.`,
                cause,
              }),
          });
          // The harness-agnostic record IS the durable artifact; native
          // files are views. Adapters re-emit any supported harness from it.
          const canonical = ingestNativeSession(harness, native.stdout, "/workspace/repo");
          if (canonical !== null) {
            const canonicalPath = path.join(stateDir, "session.canonical.json");
            yield* Effect.tryPromise({
              try: () => fs.writeFile(canonicalPath, JSON.stringify(canonical, null, 2)),
              catch: (cause) =>
                new HarnessStateIOError({
                  sessionId,
                  operation: "write-canonical",
                  path: canonicalPath,
                  message: `Could not save the canonical transcript for session ${sessionId}.`,
                  cause,
                }),
            });
          }
        }

        const manifest: HarnessStateManifest = {
          harness: harness,
          providerSessionId,
          capturedAt: new Date().toISOString(),
        };
        yield* Effect.tryPromise({
          try: () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId,
              operation: "write-manifest",
              path: manifestPath,
              message: `Could not commit saved harness state for session ${sessionId}.`,
              cause,
            }),
        });
        if (providerSessionId !== null) {
          yield* processes.setProviderSessionId(agentProcess.id, providerSessionId);
          // The session-level mirror: what "the session's provider id" means is the latest
          // agent process's.
          yield* sessions.setProviderSessionId(session.id, providerSessionId);
        }
      });

      const closeWorkspaceServiceForwards = Effect.fn(
        "SessionEngine.closeWorkspaceServiceForwards",
      )(function* (workspaceId: SealantWorkspaceId) {
        yield* withServiceLifecycle(
          Effect.gen(function* () {
            const openForwards = (yield* serviceForwards.listOpen()).filter(
              (forward) => forward.sealantWorkspaceId === workspaceId,
            );
            for (const forward of openForwards) {
              yield* serviceHost.stop(forward.serviceId);
              yield* serviceForwards.markClosed(forward.id);
              yield* services.compareAndSetCurrentForward(forward.serviceId, forward.id, null);
            }
          }),
        );
      });

      const WORKSPACE_TTL_SECONDS = 12 * 60 * 60;

      /**
       * Renew one ordinary session workspace without confusing it with the hot pool. The
       * workspace-id guard in SessionsRepo prevents a late result from contaminating a fresh
       * resume. A platform failure is a durable fact, not a reason to end the lease.
       */
      const renewWorkspaceLease = Effect.fn("SessionEngine.renewWorkspaceLease")(function* (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.sealantWorkspaceId !== workspaceId) return;

        yield* sealant.expireWorkspace(workspaceId, WORKSPACE_TTL_SECONDS).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                const failedAt = new Date(
                  yield* Effect.clockWith((clock) => clock.currentTimeMillis),
                );
                yield* sessions.recordWorkspaceTtlRenewalFailure(
                  sessionId,
                  workspaceId,
                  error.message,
                  failedAt,
                );
                yield* Effect.logWarning("session engine: workspace TTL renewal failed").pipe(
                  Effect.annotateLogs({ sessionId, workspaceId, error: error.message }),
                );
              }),
            onSuccess: (expiresAt) =>
              Effect.gen(function* () {
                const renewedAt = new Date(
                  yield* Effect.clockWith((clock) => clock.currentTimeMillis),
                );
                yield* sessions.recordWorkspaceTtlRenewal(
                  sessionId,
                  workspaceId,
                  expiresAt,
                  renewedAt,
                );
              }),
          }),
        );
      });

      /** Renew each current workspace exactly once when any process or selected forward leases it. */
      const retainedWorkspaceSweep = Effect.fn("SessionEngine.retainedWorkspaceSweep")(
        function* () {
          const owners = new Map<SealantWorkspaceId, SessionId>();
          for (const process of yield* processes.listLive()) {
            owners.set(process.sealantWorkspaceId, process.sessionId);
          }

          const allServices = yield* services.listAll();
          const selectedForwardOwners = new Map<ServiceForwardId, SessionId>();
          for (const service of allServices) {
            if (service.currentForwardId !== null) {
              selectedForwardOwners.set(service.currentForwardId, service.sessionId);
            }
          }
          for (const forward of yield* serviceForwards.listOpen()) {
            const sessionId = selectedForwardOwners.get(forward.id);
            if (sessionId !== undefined) owners.set(forward.sealantWorkspaceId, sessionId);
          }

          yield* Effect.forEach(
            owners,
            ([workspaceId, sessionId]) =>
              owned(sessionId)(renewWorkspaceLease(sessionId, workspaceId)),
            { concurrency: 4, discard: true },
          );
        },
      );

      /**
       * Stop the workspace unless a live process still leases it
       * (docs/SESSION-SERVICES.md): the container survives the agent while a
       * shell or Service is live in it, and every path that ends a lease
       * comes back through here. `force` is for replacement: a relaunch is
       * about to overwrite the workspace pointer, so nothing in the old
       * container can be kept.
       */
      const stopWorkspaceIfUnleased = (
        sessionId: SessionId,
        options?: { readonly force?: boolean },
      ) =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(sessionId);
          if (session.sealantWorkspaceId === null) return;
          const workspaceId = session.sealantWorkspaceId;
          if (options?.force === true) {
            // A deliberate fresh resume replaces this workspace. Close the durable leases before
            // the pointer is overwritten so no Service remains advertised against a dead target.
            yield* closeWorkspaceServiceForwards(workspaceId);
          } else {
            const processLeases = yield* processes.listLiveForWorkspace(workspaceId);
            const forwardLeases = (yield* serviceForwards.listOpen()).filter(
              (forward) => forward.sealantWorkspaceId === workspaceId,
            );
            const leaseCount = processLeases.length + forwardLeases.length;
            if (leaseCount > 0) {
              yield* Effect.logInfo("session engine: workspace stop deferred by live leases").pipe(
                Effect.annotateLogs({ sessionId, workspaceId, leases: leaseCount }),
              );
              return;
            }
          }
          const workspace = yield* sealant.getWorkspace(workspaceId);
          yield* sealant.stopWorkspace(workspace);
          // The container is gone; no row for it can still be live, and the
          // in-workspace socket has nobody left to serve.
          yield* processes.reapLiveForWorkspace(workspaceId);
          yield* socketHost.stop(sessionId);
          yield* channelTokens.revoke(sessionId).pipe(Effect.ignore);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: workspace stop failed").pipe(
              Effect.annotateLogs({ sessionId, error: String(error) }),
            ),
          ),
        );

      /**
       * The settle-path variant: every caller is the tail of a session settle, so no agent row
       * can still be live in the workspace — end any straggler before the lease check.
       */
      const stopWorkspaceQuietly = (sessionId: SessionId, options?: { readonly force?: boolean }) =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(sessionId);
          if (session.sealantWorkspaceId === null) return;
          yield* processes.reapLiveForWorkspace(session.sealantWorkspaceId, [
            ...AGENT_PROCESS_KINDS,
          ]);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: agent process reap failed").pipe(
              Effect.annotateLogs({ sessionId, error: String(error) }),
            ),
          ),
          Effect.andThen(stopWorkspaceIfUnleased(sessionId, options)),
        );

      const tryHarvest = (agentProcess: SessionProcess) =>
        harvestHarnessState(agentProcess).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: harness-state harvest failed").pipe(
              Effect.annotateLogs({
                sessionId: agentProcess.sessionId,
                processId: agentProcess.id,
                error: String(error),
              }),
            ),
          ),
        );

      /**
       * A late harvest for the session's newest agent process when its capture never landed
       * (the fiber that should have harvested died with the last process) — only while the
       * workspace it ran in is still the session's current one.
       */
      const harvestLatestIfMissing = (sessionId: SessionId) =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(sessionId);
          const agent = currentAgentProcess(yield* processes.listForSession(sessionId));
          if (agent === null || agent.sealantWorkspaceId !== session.sealantWorkspaceId) return;
          const project = yield* projects.byId(session.projectId);
          const manifestPath = path.join(
            processStatePathOf(project.storePath, sessionId, agent.id),
            "manifest.json",
          );
          const captured = yield* Effect.promise(() =>
            fs.access(manifestPath).then(
              () => true,
              () => false,
            ),
          );
          if (!captured) yield* tryHarvest(agent);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: late harvest skipped").pipe(
              Effect.annotateLogs({ sessionId, error: String(error) }),
            ),
          ),
        );

      /** The tail of a settle without a process of its own: late harvest, then reap. Both quiet. */
      const sweepWorkspace = (sessionId: SessionId) =>
        harvestLatestIfMissing(sessionId).pipe(Effect.andThen(stopWorkspaceQuietly(sessionId)));

      /**
       * The session's harness state as one "latest" view over per-process captures: the newest
       * agent process with a committed manifest, else the pre-2026-08-21 session-root capture.
       */
      const harnessStateFor = Effect.fn("SessionEngine.harnessStateFor")(function* (
        session: Session,
      ) {
        const project = yield* projects.byId(session.projectId);
        const agents = agentProcessesOf(yield* processes.listForSession(session.id));
        const processDirs = agents
          .toReversed()
          .map((agent) => processStatePathOf(project.storePath, session.id, agent.id));
        return yield* locateHarnessState(
          sessionStatePathOf(project.storePath, session.id),
          processDirs,
          session.id,
        );
      });

      /**
       * The settled status of a session whose processes have all ended: what the last agent
       * run reported, else what the last agent process's exit says, else `completed` (nothing
       * ever ran — the caller names the outcome it wants in that case).
       */
      const settledOutcomeOf = Effect.fn("SessionEngine.settledOutcomeOf")(function* (
        sessionId: SessionId,
        rows: ReadonlyArray<SessionProcess>,
      ): Effect.fn.Return<{ readonly outcome: SessionOutcome; readonly summary: string | null }> {
        const latestRun = yield* sessionRuns.latestForSession(sessionId);
        if (
          latestRun !== null &&
          (latestRun.status === "completed" ||
            latestRun.status === "failed" ||
            latestRun.status === "stopped")
        ) {
          return { outcome: latestRun.status, summary: latestRun.summary };
        }
        const agent = currentAgentProcess(rows);
        const outcome = agent === null ? null : agentProcessOutcome(agent);
        if (agent !== null && outcome !== null) {
          return {
            outcome,
            summary: agent.exitCode === null ? null : `exited with code ${agent.exitCode}`,
          };
        }
        return { outcome: "completed", summary: null };
      });

      /**
       * Session status is a FOLD over live processes (decided 2026-08-21), never a property of
       * one process: any agent live → `running`; no agent but shells or Services live → `idle`;
       * nothing live → settled from the last agent outcome. Idempotent — every path that ends
       * or starts a process comes through here. `sweep` additionally releases the workspace
       * once nothing is live (lease-checked: an open Service forward still retains it).
       */
      const reconcileSession = Effect.fn("SessionEngine.reconcileSession")(function* (
        sessionId: SessionId,
        options: { readonly sweep: boolean },
      ) {
        const session = yield* sessions.byId(sessionId);
        const rows = yield* processes.listForSession(sessionId);
        const hasPendingRequest = yield* conversations.hasPendingRequests(sessionId);
        const liveness = foldSessionLiveness(rows, hasPendingRequest);
        if (liveness === "waiting") {
          if (session.settledAt !== null) yield* sessions.reopen(sessionId, "running");
          if (session.status !== "waiting") yield* sessions.setStatus(sessionId, "waiting");
          return liveness;
        }
        if (liveness === "running") {
          if (session.settledAt !== null) yield* sessions.reopen(sessionId, "running");
          else if (session.status !== "running") yield* sessions.setStatus(sessionId, "running");
          return liveness;
        }
        if (liveness === "idle") {
          if (session.settledAt !== null) yield* sessions.reopen(sessionId, "idle");
          else if (session.status !== "idle") yield* sessions.setStatus(sessionId, "idle");
          return liveness;
        }
        if (session.settledAt === null) {
          // A run supervised without a process row of its own (attachRun) is live work.
          const activeRun = yield* sessionRuns.activeForSession(sessionId);
          const orphanRunLive =
            activeRun !== null &&
            !rows.some((process) => process.sealantRunId === activeRun.sealantRunId);
          // A session that never reached a process is a launch in flight, not settled work.
          const launchInFlight =
            session.status === "starting" &&
            !rows.some((process) => isAgentProcessKind(process.kind));
          if (orphanRunLive || launchInFlight) return liveness;
          const { outcome, summary } = yield* settledOutcomeOf(sessionId, rows);
          yield* sessions.settle(sessionId, outcome, summary);
        }
        if (options.sweep) yield* stopWorkspaceIfUnleased(sessionId);
        return liveness;
      });

      /** Ids whose end this process is recording — the run-wait and PTY watchers race. */
      const endingAgentProcesses = new Set<string>();

      /**
       * Record an agent process's end: the row, its run, and the session fold — synchronously,
       * so a caller's next read sees the new status. True when THIS call recorded it; false
       * when another observer already had. The slow tail is `finishAgentProcess`.
       */
      const endAgentProcess = Effect.fn("SessionEngine.endAgentProcess")(function* (
        agentProcess: SessionProcess,
        end: {
          readonly how: "exited" | "stopped";
          readonly exitCode: number | null;
          readonly outcome: SessionOutcome;
          readonly summary: string | null;
        },
      ) {
        if (endingAgentProcesses.has(agentProcess.id)) return false;
        const current = yield* processes.byId(agentProcess.id);
        if (current === null || current.exitedAt !== null) return false;
        endingAgentProcesses.add(agentProcess.id);
        yield* processes.markExited(agentProcess.id, end.how, end.exitCode);
        if (agentProcess.sealantRunId !== null) {
          yield* sessionRuns.settle(agentProcess.sealantRunId, end.outcome, end.summary);
        }
        yield* reconcileSession(agentProcess.sessionId, { sweep: false });
        return true;
      });

      /**
       * The tail of an agent process's end: harvest its harness state while the workspace is
       * still warm, snapshot the worktree (the end of an agent process is a turn boundary), then
       * let the fold release the workspace if nothing else holds it. `trigger` null skips the
       * snapshot (the caller took its own).
       */
      const finishAgentProcess = (
        agentProcess: SessionProcess,
        trigger: CheckpointTrigger | null,
      ) =>
        Effect.gen(function* () {
          yield* tryHarvest(agentProcess);
          if (trigger !== null) {
            const session = yield* sessions.byId(agentProcess.sessionId);
            const run =
              agentProcess.sealantRunId === null
                ? null
                : yield* sessionRuns.bySealantRunId(agentProcess.sealantRunId);
            yield* tryCheckpoint(session, trigger, {
              sealantRunId: agentProcess.sealantRunId,
              sequence: run?.lastSeenSequence ?? 0n,
            });
            yield* refreshChangeHead(session).pipe(Effect.ignore);
          }
          yield* reconcileSession(agentProcess.sessionId, { sweep: true });
        }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void));

      /**
       * Any process's observed end, by kind: an agent process settles its run and the session
       * fold; a shell or Service attempt releases its lease (and a Service closes its forward).
       * Exit code null = the platform reported none (0.13.1 drops it on a clean exit) — for an
       * agent that reads as `completed`, and an open-workbench shell's exit never judges the work.
       */
      const endProcess = (
        ended: SessionProcess,
        how: "exited" | "stopped",
        exitCode: number | null,
      ) =>
        isAgentProcessKind(ended.kind)
          ? Effect.gen(function* () {
              if (ended.kind === "agent-protocol") {
                yield* protocolHost.detach(ended.id);
                yield* conversations.cancelOpenForProcess(ended.id);
              }
              let outcome: SessionOutcome = "failed";
              if (
                ended.kind !== "agent-protocol" &&
                (ended.harness === "shell" || exitCode === null || exitCode === 0)
              ) {
                outcome = "completed";
              }
              const recorded = yield* endAgentProcess(ended, {
                how,
                exitCode,
                outcome,
                summary: exitCode === null ? null : `exited with code ${exitCode}`,
              });
              if (recorded) yield* finishAgentProcess(ended, "turn-boundary");
            }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void))
          : closeCurrentServiceForward(ended).pipe(
              Effect.andThen(processes.markExited(ended.id, how, exitCode)),
              Effect.andThen(
                reconcileSession(ended.sessionId, { sweep: true }).pipe(
                  Effect.catchTag("SessionNotFoundError", () => Effect.void),
                ),
              ),
            );

      const closeCurrentServiceForward = Effect.fn("SessionEngine.closeCurrentServiceForward")(
        (process: SessionProcess) =>
          withServiceLifecycle(
            Effect.gen(function* () {
              if (process.serviceId === null) return;
              const service = yield* services.byId(process.serviceId);
              if (service === null || service.currentAttemptId !== process.id) return;
              yield* serviceHost.stop(service.id);
              if (service.currentForwardId !== null) {
                yield* serviceForwards.markClosed(service.currentForwardId);
                yield* services.compareAndSetCurrentForward(
                  service.id,
                  service.currentForwardId,
                  null,
                );
              }
            }),
          ),
      );

      /**
       * Every PTY-backed process has the same watcher, whatever its kind: poll the PTY until it
       * ends, record the observed exit, and let `endProcess` do what the kind requires — an
       * agent settles its run and the session fold, a shell or Service releases its lease. A
       * status error is blindness, not an exit — but a blind stretch checks the workspace
       * itself, because a reaped container will never answer for its PTYs again.
       */
      const watchProcess = (shellProcess: SessionProcess) =>
        Effect.gen(function* () {
          // Rows without a PTY (adopted Services) have their own supervisor.
          const ptyId = shellProcess.sealantSessionId;
          if (ptyId === null) {
            return;
          }
          const workspace = yield* sealant.getWorkspace(shellProcess.sealantWorkspaceId);
          const pty = yield* sealant.getSession(workspace, ptyId);
          let blindPolls = 0;
          for (;;) {
            yield* Effect.sleep("2 seconds");
            const status = yield* Effect.tryPromise({
              try: () => pty.status(),
              catch: (cause) =>
                new SealantPlatformError({
                  code: "session_status_failed",
                  status: null,
                  message: "session status failed",
                  cause,
                }),
            }).pipe(Effect.catchTag("SealantPlatformError", () => Effect.succeed(null)));
            if (status === null) {
              blindPolls += 1;
              if (blindPolls % 30 === 0) {
                const workspaceStatus = yield* Effect.tryPromise({
                  try: () => workspace.status(),
                  catch: () => new Error("workspace status failed"),
                }).pipe(Effect.catch(() => Effect.succeed(null)));
                if (
                  workspaceStatus !== null &&
                  workspaceStatus !== "queued" &&
                  workspaceStatus !== "running" &&
                  workspaceStatus !== "ready"
                ) {
                  yield* endProcess(shellProcess, "exited", null);
                  return;
                }
                yield* Effect.logWarning("session engine: process status unreachable").pipe(
                  Effect.annotateLogs({
                    processId: shellProcess.id,
                    kind: shellProcess.kind,
                    blindPolls,
                  }),
                );
              }
              continue;
            }
            blindPolls = 0;
            if (status.status === "running" || status.status === "starting") continue;
            const current = yield* processes.byId(shellProcess.id);
            // Superseded (a restart repointed the row at a fresh PTY) or
            // already ended: this watcher's process is history, not news.
            if (
              current === null ||
              current.exitedAt !== null ||
              current.sealantSessionId !== ptyId
            ) {
              return;
            }
            yield* endProcess(shellProcess, "exited", status.exitCode ?? null);
            return;
          }
        }).pipe(
          // A control-plane outage is blindness, not exit evidence. Retry until the platform
          // authoritatively says the workspace or PTY is gone.
          Effect.retry({
            while: (error) => error instanceof SealantPlatformError && !runIsGone(error),
            schedule: SUPERVISE_RETRY,
          }),
          Effect.catchTag("SealantPlatformError", (error) =>
            runIsGone(error)
              ? endProcess(shellProcess, "exited", null)
              : Effect.logWarning(
                  "session engine: process watcher stopped without exit evidence",
                ).pipe(Effect.annotateLogs({ processId: shellProcess.id, error: error.message })),
          ),
        );

      /**
       * Create a live workspace over `worktree` — the create-time half of a launch, shared by
       * the cold launch path and the hot-session prewarm. Resolves every create-fixed input
       * (image, dotfiles, env, secrets, mounts), runs the credential ladder, executes
       * custom-image setup commands, and wires the in-workspace helper + git transport.
       * `onFailure` reports a readable message to the caller's ledger (session settle or pool
       * row) before the error propagates.
       */
      const provisionWorkspace = Effect.fn("SessionEngine.provisionWorkspace")(function* (input: {
        readonly project: Project;
        readonly sessionId: SessionId;
        /** Absolute worktree path — the workspace's mount source. */
        readonly worktree: string;
        /** The session socket dir from `socketHost.start`, mounted at `/run/mend`. */
        readonly socketDir: string;
        readonly shape: ReturnType<typeof platformShape>;
        readonly ownerUserId: string | null;
        readonly onFailure: (message: string) => Effect.Effect<void>;
      }) {
        const { project, sessionId, worktree, socketDir, shape, ownerUserId } = input;
        const settings = yield* settingsRepo.get();
        const report = <A, E extends { readonly message: string }>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.tapError((error) => input.onFailure(error.message).pipe(Effect.ignore)),
          );
        // What rides beside the worktree (plan §17, 2026-08-01): selected
        // references read-only at /workspace/ref/<name>, and the project's
        // declared host folders at /workspace/home/<name> — read-only unless
        // deliberately chosen otherwise. Resolved at provision; the session
        // records exactly what it received.
        const selectedReferences = yield* references
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const declaredMounts = yield* projectMounts
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const workspaceMounts = [
          { hostPath: socketDir, mountPath: SESSION_SOCKET_MOUNT_PATH },
          ...selectedReferences.map((reference) => ({
            hostPath: reference.path,
            mountPath: `/workspace/ref/${reference.name}`,
          })),
          ...declaredMounts.map((mount) => ({
            hostPath: mount.hostPath,
            mountPath: `/workspace/home/${mount.name}`,
            // Omitted = the blueprint default (read-only). Only rw is explicit.
            ...(mount.readOnly ? {} : { readOnly: false }),
          })),
        ];
        // The project's workspace-image override wins; null inherits the global default. The
        // caller records whichever one it ACTUALLY provisioned with, so a later settings change
        // never rewrites what a past session ran on.
        const workspaceImage = project.workspaceImage ?? settings.workspaceImage;
        // Dotfiles are the OWNER's. Both sources resolve server-side — the repo clone at
        // provision, the store snapshot as the exact commit the owner last synced — and the
        // workspace only ever sees file trees, never a URL or credential. Custom images skip
        // dotfiles entirely: the platform rejects them there (POSIX-shell-only contract), and a
        // project that brings its own base brings its own environment.
        const dotfilesEnabled =
          project.applyDotfiles && workspaceImage.mode !== "custom" && ownerUserId !== null;
        const dotfilesRepository =
          dotfilesEnabled && ownerUserId !== null
            ? yield* userDotfilesRepo.repository(ownerUserId)
            : null;
        const dotfilesSnapshot =
          dotfilesEnabled && ownerUserId !== null
            ? yield* dotfilesStore.archive(ownerUserId).pipe(
                Effect.mapError((error) => new DotfilesResolveError({ message: error.message })),
                report,
              )
            : null;
        const dotfilesArchives = yield* resolveDotfilesArchives({
          repository: dotfilesRepository,
          snapshot: dotfilesSnapshot,
        }).pipe(report);
        // The project env store, read ONCE per fresh workspace (plan: one snapshot per launch, a
        // live workspace is never mutated). Configuration rides `env` (plaintext by contract);
        // Secrets are unsealed here — the only place Mend ever holds their plaintext — and ride
        // Sealant's transient secret channel. Only revision + NAMES are stamped on the run.
        const environment = yield* projectEnvironment.snapshot(project.id).pipe(
          Effect.mapError(
            (error) =>
              new DotfilesResolveError({
                message: `project environment could not be read: ${String(error)}`,
              }),
          ),
          report,
        );
        const sealedSecrets = yield* projectSecrets.sealedForLaunch(project.id).pipe(
          Effect.mapError(
            (error) =>
              new DotfilesResolveError({
                message: `project secrets could not be read: ${String(error)}`,
              }),
          ),
          report,
        );
        const secretEnv = yield* Effect.forEach(
          sealedSecrets.secrets,
          (secret) =>
            secretCipher.decrypt(secret.sealedValue).pipe(
              Effect.map((value) => [secret.name, value] as const),
              // Named by KEY only: a broken/rotated machine key must never print a value.
              Effect.mapError(
                () =>
                  new DotfilesResolveError({
                    message: `secret ${secret.name} could not be unsealed with this machine's key`,
                  }),
              ),
            ),
          { concurrency: 1 },
        ).pipe(
          Effect.map((pairs) => Object.fromEntries(pairs)),
          report,
        );
        const channel = yield* sessionChannelLaunchEnv(sessionId);
        const env = {
          ...Object.fromEntries(
            environment.variables.map((variable) => [variable.name, variable.value] as const),
          ),
          ...channel.env,
        };
        Object.assign(secretEnv, channel.secretEnv);
        const environmentManifest = {
          environmentRevision: environment.revision,
          environmentVariableNames: environment.variables.map((variable) => variable.name),
          secretRevision: sealedSecrets.revision,
          secretNames: sealedSecrets.secrets.map((secret) => secret.name),
        };
        const createWorkspace = (credentials: WorkspaceCredentialsOptions | undefined) =>
          sealant.createWorkspace({
            source: { kind: "mount", path: worktree },
            ...(workspaceMounts.length === 0 ? {} : { mounts: workspaceMounts }),
            harness: shape.harness,
            name: `mend-${sessionId.slice(0, 8)}`,
            ...(workspaceImage.mode === "custom"
              ? { baseImage: workspaceImage.baseImage }
              : { os: workspaceImage.os }),
            ...(workspaceImage.mode === "family" && workspaceImage.shell !== "bash"
              ? { shell: workspaceImage.shell }
              : {}),
            ...(dotfilesArchives.length === 0
              ? {}
              : {
                  dotfiles: {
                    archives: dotfilesArchives.map((archive) => ({
                      data: archive.data,
                      manager: archive.manager,
                      bootstrap: archive.bootstrap,
                    })),
                  },
                }),
            packages: workspaceImage.packages,
            services: workspaceImage.services,
            ...(Object.keys(env).length === 0 ? {} : { env }),
            ...(Object.keys(secretEnv).length === 0 ? {} : { secretEnv }),
            // Belt for every path that forgets to stop: the platform reaper.
            ttl: "12h",
            // Requires the platform at 0.7.1+ (sealant#114): 0.7.0 dropped every
            // mount create that carried credentials at the worker's blueprint parse.
            ...(credentials === undefined ? {} : { credentials }),
          });
        const createWithCredentialFallback = (
          attempts: ReadonlyArray<WorkspaceCredentialsOptions | undefined>,
        ): Effect.Effect<Workspace, SealantPlatformError> => {
          const [credentials, ...remaining] = attempts;
          return createWorkspace(credentials).pipe(
            Effect.catchIf(
              (error) =>
                error.message.toLowerCase().includes("connected account") && remaining.length > 0,
              (error) =>
                Effect.logWarning("session engine: retrying with fewer connected accounts").pipe(
                  Effect.annotateLogs({ sessionId, error: error.message }),
                  Effect.andThen(createWithCredentialFallback(remaining)),
                ),
            ),
          );
        };
        // A missing harness account must not discard a valid GitHub account (and vice versa).
        // Try the complete identity first, then each useful subset before interactive auth.
        const workspace = yield* createWithCredentialFallback(shape.credentialAttempts).pipe(
          report,
          Effect.onInterrupt(() =>
            input.onFailure("workspace provisioning was interrupted").pipe(Effect.ignore),
          ),
        );
        // Custom-image setup commands run in the fresh workspace BEFORE anything else (state
        // restore, harness launch). They are part of the image contract, so a failing one fails
        // the provision loudly instead of handing the agent a half-prepared environment.
        if (workspaceImage.mode === "custom") {
          for (const command of workspaceImage.setupCommands) {
            const result = yield* sealant.exec(workspace, ["sh", "-lc", command]).pipe(report);
            if (result.exitCode !== 0) {
              const message = `setup command failed (exit ${result.exitCode}): ${command}`;
              yield* input.onFailure(message).pipe(Effect.ignore);
              yield* sealant.stopWorkspace(workspace).pipe(Effect.ignore);
              return yield* new SessionLaunchSetupError({ sessionId, command, message });
            }
          }
        }
        // The helper reaches everyone through PATH, not prompt engineering.
        // Git's ssh becomes the transport shim the same way: system config, so
        // every process in the workspace — agent, shell, service — pushes and
        // fetches through the host with zero credentials in the container.
        // ssh.variant=ssh keeps ports and protocol v2 working through it.
        // Touches /usr/local/bin and system git config, never $HOME, so it is
        // safe before any state restore.
        yield* sealant
          .exec(workspace, [
            "sh",
            "-c",
            `ln -sf ${SESSION_SOCKET_MOUNT_PATH}/bin/mend /usr/local/bin/mend; ` +
              `git config --system core.sshCommand ${SESSION_SOCKET_MOUNT_PATH}/bin/mend-git-ssh; ` +
              `git config --system ssh.variant ssh`,
          ])
          .pipe(Effect.ignore);
        return {
          workspace,
          workspaceImage,
          environmentManifest,
          dotfiles: {
            repository:
              dotfilesRepository === null
                ? null
                : { url: dotfilesRepository.url, ref: dotfilesRepository.ref },
            snapshotSha: dotfilesSnapshot?.sha ?? null,
          },
          referenceMounts: selectedReferences.map(
            (reference) =>
              new SessionReferenceMount({
                name: reference.name,
                mountPath: `/workspace/ref/${reference.name}`,
                sha: reference.headSha,
              }),
          ),
          extraMounts: declaredMounts.map(
            (mount) =>
              new SessionExtraMount({
                name: mount.name,
                hostPath: mount.hostPath,
                mountPath: `/workspace/home/${mount.name}`,
                readOnly: mount.readOnly,
              }),
          ),
        };
      });

      /**
       * Tell the harness what rides beside the repo — appended to each harness's global memory
       * file in the workspace $HOME (never the worktree: the note is not review content). A cold
       * launch runs this after state restore, which rewrites $HOME; a prewarm runs it at
       * provision time (no restore ever lands in a hot workspace's $HOME).
       */
      const appendWorkspaceNote = Effect.fn("SessionEngine.appendWorkspaceNote")(function* (
        workspace: Workspace,
        project: Project,
        worktree: string,
        referenceMounts: ReadonlyArray<SessionReferenceMount>,
        extraMounts: ReadonlyArray<SessionExtraMount>,
      ) {
        const referencesSection =
          referenceMounts.length === 0
            ? ""
            : `Read-only clones of dependency sources — read the actual source here ` +
              `before guessing a dependency's API:\n\n` +
              referenceMounts.map((reference) => `- ${reference.mountPath}`).join("\n") +
              `\n\n`;
        const foldersSection =
          extraMounts.length === 0
            ? ""
            : `Project folders from the user's machine:\n\n` +
              extraMounts
                .map((mount) =>
                  mount.readOnly
                    ? `- ${mount.mountPath} (read-only)`
                    : `- ${mount.mountPath} (read-write — writes land on the ` +
                      `user's folder directly and are not part of the reviewed change)`,
                )
                .join("\n") +
              `\n\n`;
        const declaredRecipes = mergeRecipes(
          yield* readServiceRecipes(worktree).pipe(Effect.orElseSucceed(() => [])),
          yield* projectRecipes.listForProject(project.id).pipe(Effect.orElseSucceed(() => [])),
        );
        const recipesLine =
          declaredRecipes.length === 0
            ? ""
            : `Declared Services (mend.toml + project): ` +
              declaredRecipes.map((recipe) => recipe.name).join(", ") +
              ` — start one with \`mend service run <name>\`.\n\n`;
        const servicesSection =
          `## Mend Services\n\n` +
          `For any long-running server (dev server, database), use ` +
          `\`mend service run --port <port> [--name <n>] -- <command...>\` — it runs the ` +
          `command supervised in this workspace, waits for the port, and makes it reachable ` +
          `from the user's own machine. NEVER background a server inside a tool call. ` +
          `\`mend service add <port>\` adopts something already listening; ` +
          `\`mend service list\` shows what runs.\n\n` +
          recipesLine;
        const note =
          `\n<!-- mend:mounts -->\n## Mend mounts\n\nMounted beside the repo:\n\n` +
          referencesSection +
          foldersSection +
          `\n` +
          servicesSection;
        yield* sealant
          .exec(workspace, [
            "sh",
            "-c",
            `mkdir -p "$HOME/.claude" "$HOME/.codex"; ` +
              `for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do ` +
              `node -e 'const fs=require("fs"),p=process.argv[1],n=process.argv[2];` +
              `let s="";try{s=fs.readFileSync(p,"utf8")}catch{}` +
              `s=s.replace(/\\n?<!-- mend:mounts -->[\\s\\S]*$/,"");fs.writeFileSync(p,s+n)' ` +
              `"$f" "$1"; done`,
            "sh",
            note,
          ])
          .pipe(Effect.ignore);
      });

      /**
       * Try to adopt a claimed hot workspace for the session that owns its id. Null means the
       * entry was unusable (dead container, half-stamped row): it is drained — keeping the
       * worktree, which the session now owns — and the caller falls through to the cold path.
       */
      const adoptClaimedWorkspace = Effect.fn("SessionEngine.adoptClaimedWorkspace")(function* (
        entry: HotWorkspace,
      ) {
        const unusable = () =>
          drainHotWorkspace(entry, { keepWorktree: true }).pipe(Effect.as(null));
        if (
          entry.sealantWorkspaceId === null ||
          entry.workspaceImage === null ||
          entry.environment === null
        ) {
          return yield* unusable();
        }
        const workspaceId = entry.sealantWorkspaceId;
        const live = yield* Effect.gen(function* () {
          const workspace = yield* sealant.getWorkspace(workspaceId);
          const status = yield* Effect.promise(() => workspace.status());
          return status === "queued" || status === "running" || status === "ready"
            ? workspace
            : null;
        }).pipe(
          Effect.catch(() => Effect.succeed(null)),
          Effect.catchDefect(() => Effect.succeed(null)),
        );
        if (live === null) {
          yield* Effect.logWarning(
            "session engine: claimed hot workspace was dead — cold launch",
          ).pipe(Effect.annotateLogs({ sessionId: entry.id, workspaceId }));
          return yield* unusable();
        }
        return {
          workspace: live,
          workspaceImage: entry.workspaceImage,
          dotfiles: entry.dotfiles ?? { repository: null, snapshotSha: null },
          environmentManifest: entry.environment,
          referenceMounts: entry.referenceMounts,
          extraMounts: entry.extraMounts,
        };
      });

      /** Stage converted harness files through the mounted worktree into one workspace home. */
      const placeConvertedFiles = (
        session: Session,
        workspace: Workspace,
        worktree: string,
        files: ConvertedNativeSession["files"],
        dirName: string,
      ): Effect.Effect<
        void,
        HarnessStateIOError | HarnessStateCommandError | SealantPlatformError
      > => {
        const importDir = path.join(worktree, dirName);
        return Effect.tryPromise({
          try: async () => {
            for (const file of files) {
              const target = path.join(importDir, file.path);
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, file.content);
            }
          },
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "stage-import",
              path: importDir,
              message: `Could not stage the converted session state for session ${session.id}.`,
              cause,
            }),
        }).pipe(
          Effect.andThen(
            sealant.exec(workspace, [
              "sh",
              "-c",
              `cp -a "/workspace/repo/${dirName}/." "$HOME"/ && rm -rf "/workspace/repo/${dirName}"`,
            ]),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  new HarnessStateCommandError({
                    sessionId: session.id,
                    harness: session.harness,
                    operation: "import-session",
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    message: `Could not import converted state for session ${session.id}.`,
                  }),
                ),
          ),
          Effect.ensuring(
            Effect.promise(() => fs.rm(importDir, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
          ),
        );
      };

      const launchInternal = Effect.fn("SessionEngine.launchInternal")(function* (
        sessionId: SessionId,
        argv: ReadonlyArray<string>,
        nativeImport: ConvertedNativeSession | null,
        stateOverride?: LocatedHarnessState | null,
        launchCorrelationId: string | null = null,
        protocolStart: LaunchStart | null = null,
        protocolAuthor: string | null = null,
        protocolResumeId: string | null = null,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        const project = yield* projects.byId(session.projectId);
        const worktree = worktreePathOf(project.storePath, session.worktree);
        // A bash launch (shell session, shell resume) is an open workbench:
        // shape by what actually launches, not the session's harness identity.
        const shape = platformShape(argv[0] === "bash" ? "shell" : session.harness);
        // An explicit null skips both the read and the restore (a shell
        // resume tolerates a session that never harvested state).
        const located =
          stateOverride === undefined
            ? yield* harnessStateFor(session).pipe(
                Effect.catchTag("HarnessStateNotFoundError", (error) =>
                  session.sealantRunId === null ? Effect.succeed(null) : Effect.fail(error),
                ),
              )
            : stateOverride;
        const manifest = located?.manifest ?? null;
        const stateDir = located?.stateDir ?? sessionStatePathOf(project.storePath, session.id);
        // A relaunch is about to overwrite the row's workspace pointer; stop
        // the previous workspace first or it becomes unaddressable and leaks
        // until the platform TTL. Forced: leases cannot hold a workspace that
        // is being replaced. This must precede socket creation because teardown
        // removes the old socket directory.
        if (session.sealantWorkspaceId !== null) {
          yield* stopWorkspaceQuietly(sessionId, { force: true });
        }
        // The in-workspace control surface: the session's socket + helper,
        // bound AFTER old-workspace teardown but before the replacement exists
        // so the newly created directory is the one provisioning mounts.
        const socketDir = yield* socketHost.start(sessionId, socketApiFor(sessionId));
        // A failed provision settles the session — fire-and-forget launchers
        // (the web) must never strand a row in "starting" with no error.
        const settleOnFailure = <A>(effect: Effect.Effect<A, SealantPlatformError>) =>
          effect.pipe(
            Effect.tapError((error) =>
              sessions
                .settle(sessionId, "failed", `launch failed: ${error.message}`)
                .pipe(Effect.ignore),
            ),
          );
        // Dotfiles are the OWNER's: the account stamped at provision; sessions from before
        // ownership existed fall back to the instance's first account (the static-token
        // semantics).
        const ownerUserId = session.ownerUserId ?? (yield* userDotfilesRepo.firstUserId());
        // A brand-new session may have claimed a hot workspace at provision — the
        // pre-provisioned skeleton whose id this session adopted. Adopt its live workspace and
        // skip the create entirely; a dead or half-stamped entry drains (keeping the worktree,
        // which the session owns) and the launch falls through to the cold path.
        const claimedEntry =
          manifest === null && nativeImport === null ? yield* hotWorkspaces.byId(sessionId) : null;
        const adopted =
          claimedEntry !== null && claimedEntry.status === "claimed"
            ? yield* adoptClaimedWorkspace(claimedEntry)
            : null;
        const provisioned =
          adopted ??
          (yield* provisionWorkspace({
            project,
            sessionId,
            worktree,
            socketDir,
            shape,
            ownerUserId,
            onFailure: (message) =>
              sessions.settle(sessionId, "failed", `launch failed: ${message}`).pipe(Effect.ignore),
          }));
        const { workspace, workspaceImage, environmentManifest } = provisioned;
        yield* sessions.setWorkspaceImage(sessionId, workspaceImage);
        // Stamped alongside the image: what this session ACTUALLY launched with — the repo
        // url+ref that was cloned and the exact snapshot sha the store packed (for a hot
        // workspace: whatever the prewarm actually applied).
        yield* sessions.setDotfiles(sessionId, provisioned.dotfiles);

        // A relaunch restores the ORIGINAL harness's saved state into the
        // fresh workspace before anything starts — for a same-harness launch
        // that also turns it into a NATIVE resume (load-bearing: a failure
        // settles the launch); for a cross-harness or shell launch it is
        // best-effort context riding beside the import. Automatic: state was
        // harvested at the previous settle, nothing was asked of the user.
        // The bash sentinel means "an interactive shell", not literally bash:
        // launch the image's login shell so the owner's dotfiles apply to the
        // shell they actually get.
        const interactiveShell = argv[0] === "bash";
        let shapedArgv = interactiveShell
          ? interactiveShellArgv(workspaceImage, argv.slice(1))
          : argv;
        if (manifest !== null) {
          const tarName = `.mend-harness-state-${session.id.slice(0, 8)}.tgz`;
          const archivePath = path.join(stateDir, "harness-state.tar.gz");
          const stagedPath = path.join(worktree, tarName);
          const restore = Effect.tryPromise({
            try: () => fs.copyFile(archivePath, stagedPath),
            catch: (cause) =>
              new HarnessStateIOError({
                sessionId,
                operation: "stage-archive",
                path: archivePath,
                message: `Could not stage saved ${manifest.harness} state for session ${sessionId}.`,
                cause,
              }),
          }).pipe(
            Effect.andThen(
              sealant.exec(workspace, [
                "sh",
                "-c",
                `tar -xzf "/workspace/repo/${tarName}" -C "$HOME"; ` +
                  `code=$?; rm -f "/workspace/repo/${tarName}"; exit $code`,
              ]),
            ),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(
                    new HarnessStateCommandError({
                      sessionId,
                      harness: manifest.harness,
                      operation: "restore-archive",
                      exitCode: result.exitCode,
                      stderr: result.stderr,
                      message: `Could not restore saved ${manifest.harness} state for session ${sessionId}.`,
                    }),
                  ),
            ),
            // Belt: never leave the staging tarball in the worktree.
            Effect.ensuring(
              Effect.promise(() => fs.rm(stagedPath, { force: true })).pipe(Effect.ignore),
            ),
          );
          if (manifest.harness === session.harness) {
            yield* restore.pipe(
              Effect.tapError((error) =>
                sessions
                  .settle(sessionId, "failed", `resume failed: ${error.message}`)
                  .pipe(Effect.andThen(sealant.stopWorkspace(workspace)), Effect.ignore),
              ),
            );
            if (protocolStart === null) {
              shapedArgv = nativeResumeArgv(
                session.harness,
                manifest.providerSessionId,
                shapedArgv,
              );
            }
          } else {
            yield* restore.pipe(
              Effect.catch((error) =>
                Effect.logWarning("session engine: original-state restore failed").pipe(
                  Effect.annotateLogs({
                    sessionId,
                    harness: manifest.harness,
                    error: String(error),
                  }),
                ),
              ),
            );
          }
        }

        if (nativeImport !== null) {
          // Cross-harness open: place the CONVERTED native session into the
          // fresh workspace's $HOME so the target harness resumes it as its
          // own — full history, its own session id, no distillation.
          yield* placeConvertedFiles(
            session,
            workspace,
            worktree,
            nativeImport.files,
            ".mend-native-import",
          ).pipe(
            Effect.tapError((error) =>
              sessions
                .settle(sessionId, "failed", `resume failed: ${error.message}`)
                .pipe(Effect.andThen(sealant.stopWorkspace(workspace)), Effect.ignore),
            ),
          );
        }

        // The conversation lands EVERYWHERE: the workspace image carries every
        // supported harness, so harnesses not already covered — by the
        // original restore or the target import — get the saved conversation
        // converted into their own native format. A mend shell (or the agent
        // itself, switched mid-session) then opens it in place. Best-effort:
        // a missing transcript or failed conversion never fails a launch.
        if (manifest !== null) {
          const covered = new Set<string>([manifest.harness]);
          if (nativeImport !== null) covered.add(session.harness);
          const uncovered = ["claude", "codex"].filter((h) => !covered.has(h));
          if (uncovered.length > 0) {
            const transcriptPath = path.join(stateDir, "transcript.native");
            const native = yield* Effect.tryPromise({
              try: () => fs.readFile(transcriptPath, "utf8"),
              catch: () => new Error("transcript unavailable"),
            }).pipe(Effect.orElseSucceed(() => ""));
            for (const other of uncovered) {
              if (native === "") break;
              const converted = convertNativeSession(manifest.harness, other, native, {
                cwd: "/workspace/repo",
                now: new Date().toISOString(),
              });
              if (converted === null) continue;
              yield* placeConvertedFiles(
                session,
                workspace,
                worktree,
                converted.files,
                `.mend-native-import-${other}`,
              ).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("session engine: sibling-harness import failed").pipe(
                    Effect.annotateLogs({ sessionId, harness: other, error: String(error) }),
                  ),
                ),
              );
            }
          }
        }

        if (provisioned.referenceMounts.length > 0) {
          yield* sessions.setReferenceMounts(sessionId, provisioned.referenceMounts);
        }
        if (provisioned.extraMounts.length > 0) {
          yield* sessions.setExtraMounts(sessionId, provisioned.extraMounts);
        }
        // State restore can rewrite $HOME, while a hot claim can freshen mend.toml after prewarm.
        // Rewrite the managed note after both paths so it reflects the claimed worktree now.
        yield* appendWorkspaceNote(
          workspace,
          project,
          worktree,
          provisioned.referenceMounts,
          provisioned.extraMounts,
        );

        const launchedArgv =
          protocolStart === null
            ? withHarnessBootstrap(session.harness, shapedArgv)
            : withHarnessSetup(session.harness, shapedArgv);
        const pty = yield* sealant
          .openSession(
            workspace,
            launchedArgv,
            protocolStart === null ? undefined : { mode: "pipe" },
          )
          .pipe(
            // The workspace exists but its id is not on the row yet — reap it
            // here or it burns until the platform TTL.
            Effect.tapError(() => sealant.stopWorkspace(workspace).pipe(Effect.ignore)),
            settleOnFailure,
          );
        const sealantRunId = SealantRunId.make(pty.runId);
        yield* sessionRuns.create({
          sessionId,
          harness: session.harness,
          sealantRunId,
          sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
          sealantSessionId: pty.id,
          ...environmentManifest,
        });
        yield* sessions.setSealantIds(
          sessionId,
          sealantRunId,
          SealantWorkspaceId.make(workspace.id),
        );
        yield* sessions.setSealantSessionId(sessionId, pty.id);
        // The skeleton is consumed: the session row now owns the workspace,
        // worktree, and socket, and the pool entry has nothing left to say.
        if (adopted !== null) {
          yield* hotWorkspaces.remove(sessionId);
        }
        // The plural record: the agent is one process in this workspace, not
        // its owner. The singular pointer above is a compatibility mirror of
        // this row's PTY id while list readers migrate to `currentAgent`.
        const claudeSessionFlag = shapedArgv.indexOf("--session-id");
        const protocolProviderSessionId =
          protocolStart !== null && session.harness === "claude" && claudeSessionFlag >= 0
            ? (shapedArgv.at(claudeSessionFlag + 1) ?? null)
            : null;
        const agentProcess = yield* processes.create({
          sessionId,
          sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
          sealantSessionId: pty.id,
          sealantRunId,
          launchCorrelationId,
          kind: protocolStart === null ? "agent-pty" : "agent-protocol",
          harness: interactiveShell ? "shell" : session.harness,
          // Known up front only for a native resume of the same harness; the
          // harvest fills it when the process ends.
          providerSessionId: interactiveShell
            ? null
            : (nativeImport?.providerSessionId ??
              (manifest !== null && manifest.harness === session.harness
                ? manifest.providerSessionId
                : (protocolProviderSessionId ?? protocolResumeId))),
          label: session.harness,
          argv: shapedArgv,
        });
        if (protocolStart !== null) {
          yield* protocolHost
            .attach({
              process: agentProcess,
              pipe: pty,
              cwd: "/workspace/repo",
              model: protocolStart.model,
              effort: protocolStart.effort,
              permissionMode: protocolStart.permissionMode ?? "bypass",
              hooks: {
                onRequestChanged: (changedSessionId) =>
                  reconcileSession(changedSessionId, { sweep: false }).pipe(
                    Effect.catchTag("SessionNotFoundError", () => Effect.void),
                    Effect.asVoid,
                  ),
                onTurnCompleted: (turn) =>
                  Effect.gen(function* () {
                    const currentSession = yield* sessions.byId(turn.sessionId);
                    const run =
                      agentProcess.sealantRunId === null
                        ? null
                        : yield* sessionRuns.bySealantRunId(agentProcess.sealantRunId);
                    yield* tryCheckpoint(currentSession, "turn-boundary", {
                      sealantRunId: agentProcess.sealantRunId,
                      sequence: run?.lastSeenSequence ?? 0n,
                    });
                    yield* refreshChangeHead(currentSession).pipe(Effect.ignore);
                  }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void)),
              },
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  yield* protocolHost.detach(agentProcess.id);
                  yield* conversations.cancelOpenForProcess(agentProcess.id);
                  yield* closeProcessPty(agentProcess.sealantWorkspaceId, pty.id).pipe(
                    Effect.ignore,
                  );
                  const recorded = yield* endAgentProcess(agentProcess, {
                    how: "exited",
                    exitCode: null,
                    outcome: "failed",
                    summary: `protocol initialization failed: ${error.message}`,
                  }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)));
                  if (recorded) yield* finishAgentProcess(agentProcess, "turn-boundary");
                }).pipe(Effect.ignore),
              ),
            );
        }
        yield* renewWorkspaceLease(sessionId, agentProcess.sealantWorkspaceId);
        // Always reopen, not only for follow-ups: a plain launch on a row that
        // already settled (a failed first attempt retried) must clear
        // settled_at, or the first-settle-wins guard ignores this run's exit
        // and the row reads "running" forever — unstoppable and undeletable.
        yield* sessions.reopen(sessionId, "running");
        yield* forkSupervision(sessionId, sealantRunId);

        // The agent process ends on its own; the fold over every process decides the session.
        yield* Effect.forkIn(watchProcess(agentProcess), scope);
        if (protocolStart !== null) {
          const openingInput = protocolStart.prompt?.trim() ?? "";
          if (openingInput !== "") {
            yield* protocolHost.submitTurn(sessionId, openingInput, protocolAuthor).pipe(
              Effect.mapError(
                (error) =>
                  new SealantPlatformError({
                    code: "agent_protocol_not_live",
                    status: null,
                    message: `Protocol process did not accept its opening turn: ${error.processId}`,
                    cause: error,
                  }),
              ),
            );
          }
        }
        return yield* sessions.byId(sessionId);
      });

      const launchProtocol = Effect.fn("SessionEngine.launchProtocol")(function* (
        sessionId: SessionId,
        start: LaunchStart,
        author: string | null,
        launchCorrelationId: string | null = null,
        forceFreshWorkspace = false,
      ) {
        const session = yield* sessions.byId(sessionId);
        const rows = yield* processes.listForSession(sessionId);
        if (rows.some(isLiveAgentProcess)) {
          return yield* new SealantPlatformError({
            code: "session_active",
            status: null,
            message: "The session already has a live agent process.",
            cause: null,
          });
        }
        const previous = currentAgentProcess(rows);
        const providerSessionId =
          previous?.kind === "agent-protocol"
            ? (previous.providerSessionId ?? undefined)
            : undefined;
        const composed = composeProtocolArgv(session.harness, start, providerSessionId);
        if (composed instanceof ProtocolHarnessUnsupportedError) {
          return yield* Effect.fail(composed);
        }
        const launchFresh = () =>
          launchInternal(
            sessionId,
            composed,
            null,
            null,
            launchCorrelationId,
            start,
            author,
            providerSessionId ?? null,
          );
        const retainCurrentWorkspace =
          !forceFreshWorkspace && (yield* retainedWorkspaceAvailable(session));
        if (!retainCurrentWorkspace) {
          return yield* launchFresh();
        }
        return yield* launchInRetainedWorkspace(
          sessionId,
          composed,
          null,
          launchCorrelationId,
          providerSessionId ?? null,
          start,
          author,
        ).pipe(Effect.catchTag("SessionNotLiveError", launchFresh));
      });

      const submitTurn = (sessionId: SessionId, input: string, author: string | null) =>
        protocolHost.submitTurn(sessionId, input, author);

      const interruptTurn = (turnId: AgentTurnId) => protocolHost.interruptTurn(turnId);

      const respondRequest = Effect.fn("SessionEngine.respondRequest")(function* (
        requestId: AgentRequestId,
        response:
          | { readonly decision: AgentApprovalDecision; readonly answers?: never }
          | { readonly answers: AgentInputAnswers; readonly decision?: never },
        decidedBy: string,
      ) {
        const request = yield* conversations.byRequestId(requestId);
        if (request === null) return yield* new AgentRequestNotFoundError({ requestId });
        return yield* protocolHost.respondRequest(request, response, decidedBy);
      });

      const checkpointNow = Effect.fn("SessionEngine.checkpointNow")(function* (
        sessionId: SessionId,
        trigger: CheckpointTrigger,
      ) {
        const session = yield* sessions.byId(sessionId);
        const latestRun = yield* sessionRuns.latestForSession(sessionId);
        const checkpoint = yield* takeCheckpoint(session, trigger, {
          sealantRunId: latestRun?.sealantRunId ?? null,
          sequence: latestRun?.lastSeenSequence ?? 0n,
        });
        yield* refreshChangeHead(session).pipe(Effect.ignore);
        return checkpoint;
      });

      /** Default argv per harness — what a resume launches. */
      const HARNESS_ARGV: Record<string, ReadonlyArray<string>> = {
        claude: ["claude"],
        codex: ["codex"],
        opencode: ["opencode"],
      };

      const ACTIVE_STATUSES = new Set(["starting", "running", "waiting", "idle"]);

      const transcript = Effect.fn("SessionEngine.transcript")(function* (sessionId: SessionId) {
        const session = yield* sessions.byId(sessionId);
        const rows = yield* processes.listForSession(sessionId);
        const agents = agentProcessesOf(rows);
        const agent = currentAgentProcess(rows);
        // The conversation belongs to the agent that drove it; an open-workbench shell launched
        // into an agent session has none of its own, so the session's harness names the record.
        const harness =
          agent !== null && agent.harness !== null && agent.harness !== "shell"
            ? agent.harness
            : session.harness;
        const shape = HARNESS_STATE[harness];
        let native: string | null = null;
        if (shape !== undefined && agent !== null && isLiveProcess(agent)) {
          native = yield* Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(agent.sealantWorkspaceId);
            const located = yield* sealant.exec(workspace, ["sh", "-c", shape.latestTranscript]);
            const file = located.stdout.trim().split("\n")[0] ?? "";
            if (located.exitCode !== 0 || file === "") return null;
            const read = yield* sealant.exec(workspace, ["cat", file]);
            return read.exitCode === 0 && read.stdout !== "" ? read.stdout : null;
          }).pipe(Effect.catch(() => Effect.succeed(null)));
        }
        if (native === null) {
          const project = yield* projects
            .byId(session.projectId)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (project !== null) {
            // Newest agent capture first, then the pre-2026-08-21 session-root capture.
            const candidates = [
              ...agents
                .toReversed()
                .map((candidate) =>
                  processStatePathOf(project.storePath, session.id, candidate.id),
                ),
              sessionStatePathOf(project.storePath, session.id),
            ];
            native = yield* Effect.promise(async () => {
              for (const stateDir of candidates) {
                try {
                  return await fs.readFile(path.join(stateDir, "transcript.native"), "utf8");
                } catch {
                  // keep looking
                }
              }
              return null;
            });
          }
        }
        if (native === null) return { sourceHarness: harness, events: [] };
        const canonical = ingestNativeSession(harness, native, "/workspace/repo");
        return { sourceHarness: harness, events: canonical?.events ?? [] };
      });

      /** Start the next coding-agent run without replacing a workspace retained by live leases. */
      const launchInRetainedWorkspace = Effect.fn("SessionEngine.launchInRetainedWorkspace")(
        function* (
          sessionId: SessionId,
          argv: ReadonlyArray<string>,
          nativeImport: ConvertedNativeSession | null,
          launchCorrelationId: string | null = null,
          providerSessionId: string | null = null,
          protocolStart: LaunchStart | null = null,
          protocolAuthor: string | null = null,
        ) {
          const session = yield* sessions.byId(sessionId);
          const project = yield* projects.byId(session.projectId);
          const worktree = worktreePathOf(project.storePath, session.worktree);
          const workspace = yield* workspaceForSupportingProcess(session).pipe(
            Effect.catchTag("SealantPlatformError", () =>
              Effect.fail(new SessionNotLiveError({ sessionId })),
            ),
          );
          if (nativeImport !== null) {
            yield* placeConvertedFiles(
              session,
              workspace,
              worktree,
              nativeImport.files,
              ".mend-native-import-retained",
            );
          }
          yield* socketHost.start(sessionId, socketApiFor(sessionId)).pipe(Effect.ignore);
          const interactiveShell = argv[0] === "bash";
          const shapedArgv = interactiveShell
            ? interactiveShellArgv(session.workspaceImage, argv.slice(1))
            : argv;
          const launchedArgv =
            protocolStart === null
              ? withHarnessBootstrap(session.harness, shapedArgv)
              : withHarnessSetup(session.harness, shapedArgv);
          const pty = yield* sealant
            .openSession(
              workspace,
              launchedArgv,
              protocolStart === null ? undefined : { mode: "pipe" },
            )
            .pipe(
              Effect.tapError((error) =>
                sessions
                  .settle(sessionId, "failed", `resume failed: ${error.message}`)
                  .pipe(Effect.ignore),
              ),
            );
          const sealantRunId = SealantRunId.make(pty.runId);
          const previousRun = yield* sessionRuns.latestForSession(sessionId);
          yield* sessionRuns.create({
            sessionId,
            harness: session.harness,
            sealantRunId,
            sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
            sealantSessionId: pty.id,
            ...(previousRun === null
              ? {}
              : {
                  environmentRevision: previousRun.environmentRevision,
                  environmentVariableNames: previousRun.environmentVariableNames,
                  secretRevision: previousRun.secretRevision,
                  secretNames: previousRun.secretNames,
                }),
          });
          yield* sessions.setSealantIds(
            sessionId,
            sealantRunId,
            SealantWorkspaceId.make(workspace.id),
          );
          yield* sessions.setSealantSessionId(sessionId, pty.id);
          const claudeSessionFlag = shapedArgv.indexOf("--session-id");
          const protocolProviderSessionId =
            protocolStart !== null && session.harness === "claude" && claudeSessionFlag >= 0
              ? (shapedArgv.at(claudeSessionFlag + 1) ?? null)
              : null;
          const agentProcess = yield* processes.create({
            sessionId,
            sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
            sealantSessionId: pty.id,
            sealantRunId,
            launchCorrelationId,
            kind: protocolStart === null ? "agent-pty" : "agent-protocol",
            harness: interactiveShell ? "shell" : session.harness,
            providerSessionId: interactiveShell
              ? null
              : (nativeImport?.providerSessionId ?? protocolProviderSessionId ?? providerSessionId),
            label: session.harness,
            argv: shapedArgv,
          });
          if (protocolStart !== null) {
            yield* protocolHost
              .attach({
                process: agentProcess,
                pipe: pty,
                cwd: "/workspace/repo",
                model: protocolStart.model,
                effort: protocolStart.effort,
                permissionMode: protocolStart.permissionMode ?? "bypass",
                hooks: {
                  onRequestChanged: (changedSessionId) =>
                    reconcileSession(changedSessionId, { sweep: false }).pipe(
                      Effect.catchTag("SessionNotFoundError", () => Effect.void),
                      Effect.asVoid,
                    ),
                  onTurnCompleted: (turn) =>
                    Effect.gen(function* () {
                      const currentSession = yield* sessions.byId(turn.sessionId);
                      const run =
                        agentProcess.sealantRunId === null
                          ? null
                          : yield* sessionRuns.bySealantRunId(agentProcess.sealantRunId);
                      yield* tryCheckpoint(currentSession, "turn-boundary", {
                        sealantRunId: agentProcess.sealantRunId,
                        sequence: run?.lastSeenSequence ?? 0n,
                      });
                      yield* refreshChangeHead(currentSession).pipe(Effect.ignore);
                    }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void)),
                },
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.gen(function* () {
                    yield* protocolHost.detach(agentProcess.id);
                    yield* conversations.cancelOpenForProcess(agentProcess.id);
                    yield* closeProcessPty(agentProcess.sealantWorkspaceId, pty.id).pipe(
                      Effect.ignore,
                    );
                    const recorded = yield* endAgentProcess(agentProcess, {
                      how: "exited",
                      exitCode: null,
                      outcome: "failed",
                      summary: `protocol initialization failed: ${error.message}`,
                    }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)));
                    if (recorded) yield* finishAgentProcess(agentProcess, "turn-boundary");
                  }).pipe(Effect.ignore),
                ),
              );
          }
          yield* renewWorkspaceLease(sessionId, agentProcess.sealantWorkspaceId);
          // See launchInternal: reopen unconditionally so a retried row settles again.
          yield* sessions.reopen(sessionId, "running");
          yield* forkSupervision(sessionId, sealantRunId);
          yield* Effect.forkIn(watchProcess(agentProcess), scope);
          if (protocolStart !== null) {
            const openingInput = protocolStart.prompt?.trim() ?? "";
            if (openingInput !== "") {
              yield* protocolHost.submitTurn(sessionId, openingInput, protocolAuthor).pipe(
                Effect.mapError(
                  (error) =>
                    new SealantPlatformError({
                      code: "agent_protocol_not_live",
                      status: null,
                      message: `Protocol process did not accept its opening turn: ${error.processId}`,
                      cause: error,
                    }),
                ),
              );
            }
          }
          return yield* sessions.byId(sessionId);
        },
      );

      const retainedWorkspaceAvailable = Effect.fn("SessionEngine.retainedWorkspaceAvailable")(
        function* (session: Session) {
          if (session.sealantWorkspaceId === null) return false;
          const supportingLeases = (yield* processes.listLiveForWorkspace(
            session.sealantWorkspaceId,
          )).filter((process) => !isAgentProcessKind(process.kind));
          const forwardLeases = (yield* serviceForwards.listOpen()).filter(
            (forward) => forward.sealantWorkspaceId === session.sealantWorkspaceId,
          );
          if (supportingLeases.length === 0 && forwardLeases.length === 0) return false;
          return yield* Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(session.sealantWorkspaceId ?? "");
            const status = yield* Effect.promise(() => workspace.status());
            return workspaceIsLive(status);
          }).pipe(
            Effect.catch(() => Effect.succeed(false)),
            Effect.catchDefect(() => Effect.succeed(false)),
          );
        },
      );

      /**
       * Whether the session's AGENT is live — the fold, not the row: a live agent process; a
       * launch in flight (no process row yet); or a run supervised without a process of its own.
       * Shells and Services holding the workspace (`idle`) do not count — a new agent may join
       * them.
       */
      const agentIsLive = Effect.fn("SessionEngine.agentIsLive")(function* (session: Session) {
        if (session.settledAt !== null) return false;
        const rows = yield* processes.listForSession(session.id);
        if (rows.some(isLiveAgentProcess)) return true;
        if (session.status === "starting") return true;
        if (session.status === "running" || session.status === "waiting") {
          const activeRun = yield* sessionRuns.activeForSession(session.id);
          return (
            activeRun !== null &&
            !rows.some((process) => process.sealantRunId === activeRun.sealantRunId)
          );
        }
        return false;
      });

      const launchFollowUp = Effect.fn("SessionEngine.launchFollowUp")(function* (
        sessionId: SessionId,
        instruction: string,
        launchCorrelationId: string,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        if (yield* agentIsLive(session)) {
          const liveProtocol = (yield* processes.listForSession(sessionId)).find(
            (process) => process.kind === "agent-protocol" && isLiveProcess(process),
          );
          if (liveProtocol !== undefined && (yield* protocolHost.has(liveProtocol.id))) {
            yield* protocolHost.submitTurn(sessionId, instruction, null, launchCorrelationId).pipe(
              Effect.mapError(
                (error) =>
                  new SealantPlatformError({
                    code: "agent_protocol_not_live",
                    status: null,
                    message: "The protocol process stopped before the follow-up was queued.",
                    cause: error,
                  }),
              ),
            );
            return yield* sessions.byId(sessionId);
          }
          return yield* new SealantPlatformError({
            code: "session_active",
            status: null,
            message: "The session became active before this follow-up could be delivered.",
            cause: null,
          });
        }
        const priorAgent = currentAgentProcess(yield* processes.listForSession(sessionId));
        if (priorAgent?.kind === "agent-protocol") {
          return yield* launchProtocol(
            sessionId,
            { mode: "protocol", prompt: instruction, permissionMode: "bypass" },
            null,
            launchCorrelationId,
          ).pipe(
            Effect.catchTag("ProtocolHarnessUnsupportedError", (error) =>
              Effect.fail(
                new SealantPlatformError({
                  code: "unknown_protocol_harness",
                  status: null,
                  message: error.message,
                  cause: error,
                }),
              ),
            ),
          );
        }
        const argv = promptArgv(session.harness, instruction);
        if (argv === null) {
          return yield* new SealantPlatformError({
            code: "unknown_harness",
            status: null,
            message: `Harness "${session.harness}" has no known follow-up command.`,
            cause: null,
          });
        }
        const retainCurrentWorkspace = yield* retainedWorkspaceAvailable(session);
        return yield* retainCurrentWorkspace
          ? launchInRetainedWorkspace(sessionId, argv, null, launchCorrelationId)
          : launchInternal(sessionId, argv, null, undefined, launchCorrelationId);
      });

      const resumeSession = Effect.fn("SessionEngine.resumeSession")(function* (
        sessionId: SessionId,
        harness: string | null,
        fresh = false,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        if (yield* agentIsLive(session)) {
          return yield* new SealantPlatformError({
            code: "session_active",
            status: null,
            message: "The session is already live — attach to it instead of resuming.",
            cause: null,
          });
        }
        const target = harness ?? session.harness;
        const priorAgent = currentAgentProcess(yield* processes.listForSession(sessionId));
        if (priorAgent?.kind === "agent-protocol" && target === session.harness) {
          return yield* launchProtocol(
            sessionId,
            { mode: "protocol", permissionMode: "bypass" },
            null,
            null,
            fresh,
          ).pipe(
            Effect.catchTag("ProtocolHarnessUnsupportedError", (error) =>
              Effect.fail(
                new SealantPlatformError({
                  code: "unknown_protocol_harness",
                  status: null,
                  message: error.message,
                  cause: error,
                }),
              ),
            ),
          );
        }
        const retainCurrentWorkspace = !fresh && (yield* retainedWorkspaceAvailable(session));
        // A shell resume reopens the worktree with no agent: saved state
        // restored when it exists — and none required, because the session
        // that died before harvesting is exactly the one worth a shell. The
        // session keeps its harness identity; only this launch runs a shell.
        // launchInternal lays the conversation down for every supported
        // harness, so either agent opens it natively from inside the shell.
        if (target === "shell") {
          const located = yield* harnessStateFor(session).pipe(
            Effect.catchTag("HarnessStateNotFoundError", () => Effect.succeed(null)),
          );
          yield* sessions.reopen(sessionId, "running");
          return yield* retainCurrentWorkspace
            ? launchInRetainedWorkspace(sessionId, ["bash"], null)
            : launchInternal(sessionId, ["bash"], null, located);
        }
        const defaultArgv = HARNESS_ARGV[target];
        if (defaultArgv === undefined) {
          return yield* new SealantPlatformError({
            code: "unknown_harness",
            status: null,
            message: `Unknown harness "${target}" — resumable harnesses: ${Object.keys(HARNESS_ARGV).join(", ")}, shell.`,
            cause: null,
          });
        }

        // Resume addresses the LATEST agent process's capture (its provider session id).
        const located = yield* harnessStateFor(session);
        const { stateDir, manifest } = located;
        let argv = defaultArgv;
        let nativeImport: ConvertedNativeSession | null = null;
        if (
          manifest.harness === target &&
          (target === "claude" || target === "codex") &&
          manifest.providerSessionId === null
        ) {
          return yield* new HarnessStateInvalidError({
            sessionId,
            path: path.join(stateDir, "manifest.json"),
            message: `Saved ${target} state has no native session id; refusing to start session ${sessionId} from scratch.`,
            cause: new Error("providerSessionId is null"),
          });
        }
        if (manifest.harness !== target) {
          const transcriptPath = path.join(stateDir, "transcript.native");
          const native = yield* Effect.tryPromise({
            try: () => fs.readFile(transcriptPath, "utf8"),
            catch: (cause) =>
              new HarnessStateIOError({
                sessionId,
                operation: "read-transcript",
                path: transcriptPath,
                message: `Could not read the saved ${manifest.harness} transcript for session ${sessionId}.`,
                cause,
              }),
          });
          if (native === "") {
            return yield* new HarnessStateInvalidError({
              sessionId,
              path: transcriptPath,
              message: `The saved ${manifest.harness} transcript for session ${sessionId} is empty.`,
              cause: new Error("transcript.native is empty"),
            });
          }
          // TRUE cross-harness open: convert the saved native session into
          // the TARGET harness's own format and resume it natively — full
          // history, as if the target had run it. Distilled-prompt handoff
          // remains only for pairs conversion cannot express.
          nativeImport = convertNativeSession(manifest.harness, target, native, {
            cwd: "/workspace/repo",
            now: new Date().toISOString(),
          });
          if (nativeImport === null) {
            const turns = extractTranscript(manifest.harness, native);
            if (turns.length === 0) {
              return yield* new HarnessStateInvalidError({
                sessionId,
                path: transcriptPath,
                message: `The saved ${manifest.harness} transcript cannot be opened with ${target}; refusing to start session ${sessionId} from scratch.`,
                cause: new Error("no convertible transcript turns"),
              });
            }
            const openingArgv = promptArgv(target, distillOpeningPrompt(manifest.harness, turns));
            if (openingArgv === null) {
              return yield* new HarnessStateInvalidError({
                sessionId,
                path: transcriptPath,
                message: `${target} cannot import the saved ${manifest.harness} conversation; refusing to start session ${sessionId} from scratch.`,
                cause: new Error("target harness has no opening-prompt adapter"),
              });
            }
            argv = openingArgv;
          } else {
            argv = nativeImport.resumeArgv;
            yield* sessions.setProviderSessionId(sessionId, nativeImport.providerSessionId);
          }
        }
        if (retainCurrentWorkspace && manifest.harness === target) {
          argv = nativeResumeArgv(target, manifest.providerSessionId, argv);
        }
        if (target !== session.harness) yield* sessions.setHarness(sessionId, target);
        yield* sessions.reopen(sessionId, "running");
        return yield* retainCurrentWorkspace
          ? launchInRetainedWorkspace(
              sessionId,
              argv,
              nativeImport,
              null,
              manifest.harness === target ? manifest.providerSessionId : null,
            )
          : launchInternal(sessionId, argv, nativeImport, located);
      });

      const stop = Effect.fn("SessionEngine.stop")(function* (sessionId: SessionId) {
        const session = yield* sessions.byId(sessionId);
        const rows = yield* processes.listForSession(sessionId);
        const activeRun = yield* sessionRuns.activeForSession(sessionId);
        // Stop = end the agent. Every live agent process closes (the daemon reaps its process
        // group) and is recorded as stopped; the fold then reads `idle` while shells or Services
        // hold the workspace, or settles `stopped` at once.
        const ended: Array<SessionProcess> = [];
        for (const agent of rows.filter(isLiveAgentProcess)) {
          if (agent.kind === "agent-protocol") {
            yield* protocolHost.detach(agent.id);
            yield* conversations.cancelOpenForProcess(agent.id);
          }
          if (agent.sealantSessionId !== null) {
            yield* closeProcessPty(agent.sealantWorkspaceId, agent.sealantSessionId);
          }
          const recorded = yield* endAgentProcess(agent, {
            how: "stopped",
            exitCode: null,
            outcome: "stopped",
            summary: null,
          });
          if (recorded) ended.push(agent);
        }
        if (ended.length === 0) {
          // Nothing of ours to close: a run attached without a process, a launch still in
          // flight, or a row that outlived its processes. The run record and the row settle.
          if (activeRun !== null) {
            yield* sessionRuns.settle(activeRun.sealantRunId, "stopped", null);
          }
          if (foldSessionLiveness(rows) === "settled") {
            yield* sessions.settle(sessionId, "stopped", null);
          }
        }
        // A row that already carries settled_at but still reads active (rows
        // launched before reopen-on-launch) is a no-op for first-settle-wins;
        // a user stop must still land, so force the status.
        const afterSettle = yield* sessions.byId(sessionId);
        if (afterSettle.settledAt !== null && ACTIVE_STATUSES.has(afterSettle.status)) {
          yield* Effect.logWarning("session engine: stop healed an active-but-settled row").pipe(
            Effect.annotateLogs({ sessionId, settledAt: String(afterSettle.settledAt) }),
          );
          yield* sessions.setStatus(sessionId, "stopped");
        }
        yield* tryCheckpoint(session, "user-mark", {
          sealantRunId: activeRun?.sealantRunId ?? null,
          sequence: activeRun?.lastSeenSequence ?? 0n,
        });
        yield* refreshChangeHead(session).pipe(Effect.ignore);
        // The workspace outlives the PTY just long enough to harvest, then
        // dies (unless a lease holds it); forked so a stop request answers
        // immediately. If this process dies first, the next boot's leftover
        // sweep finishes the job.
        yield* Effect.forkIn(
          ended.length > 0
            ? Effect.forEach(ended, (agent) => finishAgentProcess(agent, null), {
                discard: true,
              })
            : sweepWorkspace(sessionId),
          scope,
        );
      });

      const workspaceForSupportingProcess = Effect.fn(
        "SessionEngine.workspaceForSupportingProcess",
      )(function* (session: Session) {
        const workspaceId = session.sealantWorkspaceId;
        if (workspaceId === null) return yield* new SessionNotLiveError({ sessionId: session.id });
        const workspace = yield* sealant.getWorkspace(workspaceId);
        const status = yield* Effect.tryPromise({
          try: () => workspace.status(),
          catch: (cause) =>
            new SealantPlatformError({
              code: "workspace_status_failed",
              status: null,
              message: "Could not observe the session workspace status.",
              cause,
            }),
        });
        if (!workspaceIsLive(status)) {
          return yield* new SessionNotLiveError({ sessionId: session.id });
        }
        return workspace;
      });

      const openShell = Effect.fn("SessionEngine.openShell")(function* (sessionId: SessionId) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        const workspace = yield* workspaceForSupportingProcess(session);
        const existing = yield* processes.listForSession(sessionId);
        const shellNumber =
          existing.reduce((largest, process) => {
            if (process.kind !== "shell" || process.label === null) return largest;
            const match = /^shell (\d+)$/.exec(process.label);
            const value = match?.[1] === undefined ? 0 : Number(match[1]);
            return Number.isSafeInteger(value) ? Math.max(largest, value) : largest;
          }, 0) + 1;
        // The image stamped at launch names the login shell this tab should run.
        const shellArgv = interactiveShellArgv(session.workspaceImage);
        const pty = yield* sealant.openSession(workspace, shellArgv);
        const shellProcess = yield* processes.create({
          sessionId,
          sealantWorkspaceId: session.sealantWorkspaceId ?? SealantWorkspaceId.make(workspace.id),
          sealantSessionId: pty.id,
          sealantRunId: SealantRunId.make(pty.runId),
          kind: "shell",
          label: `shell ${shellNumber}`,
          argv: shellArgv,
        });
        yield* renewWorkspaceLease(sessionId, shellProcess.sealantWorkspaceId);
        // A shell rejoining a settled session's retained workspace makes it idle again.
        yield* reconcileSession(sessionId, { sweep: false });
        yield* Effect.forkIn(watchProcess(shellProcess), scope);
        return shellProcess;
      });

      const stopShell = Effect.fn("SessionEngine.stopShell")(function* (
        processId: SessionProcessId,
      ) {
        const shell = yield* processes.byId(processId);
        if (shell === null || shell.kind !== "shell") {
          return yield* new ShellProcessNotFoundError({ processId });
        }
        if (shell.exitedAt !== null) return shell;
        if (shell.sealantSessionId === null) {
          return yield* new ShellProcessNotFoundError({ processId });
        }
        yield* closeProcessPty(shell.sealantWorkspaceId, shell.sealantSessionId);
        yield* processes.markExited(processId, "stopped", null);
        yield* reconcileSession(shell.sessionId, { sweep: true }).pipe(
          Effect.catchTag("SessionNotFoundError", () => Effect.void),
        );
        return (yield* processes.byId(processId)) ?? shell;
      });

      const renameShell = Effect.fn("SessionEngine.renameShell")(function* (
        processId: SessionProcessId,
        requestedLabel: string,
      ) {
        const shell = yield* processes.byId(processId);
        if (shell === null || shell.kind !== "shell" || shell.exitedAt !== null) {
          return yield* new ShellProcessNotFoundError({ processId });
        }
        const label = requestedLabel.trim();
        if (label.length === 0 || label.length > 64) {
          return yield* new ShellLabelError({
            processId,
            message: "A shell label must contain between 1 and 64 characters.",
          });
        }
        const siblings = yield* processes.listForSession(shell.sessionId);
        if (
          siblings.some(
            (process) =>
              process.id !== processId &&
              process.kind === "shell" &&
              process.exitedAt === null &&
              process.label === label,
          )
        ) {
          return yield* new ShellLabelError({
            processId,
            message: `A live shell named "${label}" already exists in this session.`,
          });
        }
        yield* processes.setLabel(processId, label);
        return (yield* processes.byId(processId)) ?? shell;
      });

      const getOrCreateService = Effect.fn("SessionEngine.getOrCreateService")(function* (
        sessionId: SessionId,
        name: string,
        workspacePort: number,
        transport: "tcp" | "udp",
        browserScheme: ServiceBrowserScheme,
        declarationSource: ServiceDeclarationSource,
      ) {
        if (transport === "udp" && browserScheme !== null) {
          return yield* new ServiceBindError({
            message: "UDP Services cannot declare an HTTP or HTTPS browser scheme.",
          });
        }
        const bindAddresses = yield* serviceHost.bindAddresses();
        const existing = yield* services.byName(sessionId, name);
        if (existing !== null) {
          const attempt =
            existing.currentAttemptId === null
              ? null
              : yield* processes.byId(existing.currentAttemptId);
          const forward =
            existing.currentForwardId === null
              ? null
              : yield* serviceForwards.byId(existing.currentForwardId);
          if (
            (attempt !== null && attempt.exitedAt === null) ||
            (forward !== null && (forward.state === "binding" || forward.state === "bound"))
          ) {
            return yield* new ServiceBindError({
              message: `A live Service named "${name}" already exists in this session — stop it or pick another name.`,
            });
          }
          if (
            existing.workspacePort === workspacePort &&
            existing.transport === transport &&
            existing.browserScheme === browserScheme &&
            existing.bindAddresses !== null &&
            existing.bindAddresses.length === bindAddresses.length &&
            existing.bindAddresses.every((address, index) => address === bindAddresses[index])
          ) {
            return existing;
          }
        }
        return yield* services.create({
          sessionId,
          name,
          declarationSource,
          workspacePort,
          transport,
          browserScheme,
          bindAddresses,
        });
      });

      const bindServiceForward = Effect.fn("SessionEngine.bindServiceForward")(function* (
        serviceId: ServiceId,
        workspaceId: SealantWorkspaceId,
        workspacePort: number,
        protocol: "tcp" | "udp",
      ) {
        const service = yield* services.byId(serviceId);
        if (service === null) return yield* Effect.die(`Service ${serviceId} disappeared`);
        const previous =
          service.currentForwardId === null
            ? null
            : yield* serviceForwards.byId(service.currentForwardId);
        const bindAddresses = service.bindAddresses ?? previous?.boundAddresses ?? null;
        if (bindAddresses === null) {
          return yield* new ServiceBindError({
            message: "The Service has no recorded bind policy. Start it again explicitly.",
          });
        }
        const forward = yield* serviceForwards.createAndSelect({
          serviceId,
          sealantWorkspaceId: workspaceId,
          preferredHostPort: previous?.hostPort ?? service.preferredHostPort,
          supersedesForwardId: previous?.id ?? null,
        });
        yield* renewWorkspaceLease(service.sessionId, workspaceId);
        const binding = yield* serviceHost
          .start({
            serviceId,
            forwardId: forward.id,
            workspaceId,
            workspacePort,
            protocol,
            bindAddresses,
            ...(forward.preferredHostPort === null
              ? {}
              : { preferredHostPort: forward.preferredHostPort }),
          })
          .pipe(
            Effect.tapError((error) =>
              serviceForwards
                .markFailed(forward.id, error.message)
                .pipe(
                  Effect.andThen(services.compareAndSetCurrentForward(serviceId, forward.id, null)),
                ),
            ),
          );
        yield* serviceForwards.markBound(forward.id, binding.hostPort, binding.boundAddresses);
        return forward.id;
      });

      const recordTcpObservation = Effect.fn("SessionEngine.recordTcpObservation")(function* (
        serviceId: ServiceId,
        forwardId: ServiceForwardId,
        reachable: boolean,
      ) {
        yield* serviceObservations.record({
          serviceId,
          forwardId,
          state: reachable ? "reachable" : "unreachable",
          source: "probe",
        });
      });

      const addServiceUnlocked = Effect.fn("SessionEngine.addService")(function* (
        sessionId: SessionId,
        workspacePort: number,
        name: string | null,
        protocol: "tcp" | "udp" = "tcp",
        browserScheme: ServiceBrowserScheme = null,
        declarationSource: ServiceDeclarationSource = "explicit-adopt",
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        const workspace = yield* workspaceForSupportingProcess(session);
        const workspaceId = SealantWorkspaceId.make(workspace.id);
        const label = name ?? `port-${workspacePort}`;
        const service = yield* getOrCreateService(
          sessionId,
          label,
          workspacePort,
          protocol,
          browserScheme,
          declarationSource,
        );
        const forwardId = yield* bindServiceForward(
          service.id,
          workspaceId,
          workspacePort,
          protocol,
        );
        if (protocol === "tcp") {
          yield* recordTcpObservation(
            service.id,
            forwardId,
            yield* serviceHost.probe(workspaceId, workspacePort),
          );
        }
        return yield* readServiceView(service.id);
      });
      const addService = (
        sessionId: SessionId,
        workspacePort: number,
        name: string | null,
        protocol: "tcp" | "udp" = "tcp",
        browserScheme: ServiceBrowserScheme = null,
        declarationSource: ServiceDeclarationSource = "explicit-adopt",
      ) =>
        withServiceLifecycle(
          addServiceUnlocked(
            sessionId,
            workspacePort,
            name,
            protocol,
            browserScheme,
            declarationSource,
          ),
        );

      /** Close a process PTY; the daemon reaps its foreground process group. */
      const closeProcessPty = (workspaceId: SealantWorkspaceId, ptyId: string) =>
        sealant.getWorkspace(workspaceId).pipe(
          Effect.flatMap((workspace) => sealant.getSession(workspace, ptyId)),
          Effect.flatMap((pty) =>
            Effect.tryPromise({ try: () => pty.close(), catch: () => new Error("close failed") }),
          ),
          Effect.ignore,
        );

      /**
       * A supervised Service is ready when its port answers — poll the
       * forward until it does, and treat the command dying first as the
       * failure it is. A slow starter that outlives the wait is not an
       * error: it surfaces as `unreachable` until it listens.
       */
      const awaitServicePort = (
        pty: {
          status: () => Promise<{ status: string; exitCode?: number }>;
          output: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<{
            readonly data: string | Uint8Array;
          }>;
        },
        workspaceId: SealantWorkspaceId,
        workspacePort: number,
        processId: SessionProcessId,
        sessionId: SessionId,
      ) =>
        Effect.gen(function* () {
          const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
          for (;;) {
            const reachable = yield* serviceHost.probe(workspaceId, workspacePort);
            if (reachable) {
              return true;
            }
            const status = yield* Effect.tryPromise({
              try: () => pty.status(),
              catch: () => new Error("status failed"),
            }).pipe(Effect.orElseSucceed(() => null));
            if (status !== null && status.status !== "running" && status.status !== "starting") {
              yield* processes.markExited(processId, "exited", status.exitCode ?? null);
              yield* reconcileSession(sessionId, { sweep: false }).pipe(
                Effect.catchTag("SessionNotFoundError", () => Effect.void),
              );
              const tail = yield* ptyOutputTail(pty);
              return yield* new ServiceStartError({
                message:
                  `The command exited (code ${status.exitCode ?? "unknown"}) before :${workspacePort} answered.` +
                  (tail === "" ? "" : `\n--- output ---\n${tail}`),
              });
            }
            if (Date.now() >= deadline) {
              return false;
            }
            yield* Effect.sleep("500 millis");
          }
        });

      const runServiceUnlocked = Effect.fn("SessionEngine.runService")(function* (
        sessionId: SessionId,
        argv: ReadonlyArray<string>,
        workspacePort: number,
        name: string | null,
        protocol: "tcp" | "udp" = "tcp",
        browserScheme: ServiceBrowserScheme = null,
        declarationSource: ServiceDeclarationSource = "explicit-run",
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        const workspace = yield* workspaceForSupportingProcess(session);
        const workspaceId = SealantWorkspaceId.make(workspace.id);
        const label = name ?? argv[0] ?? "service";
        const service = yield* getOrCreateService(
          sessionId,
          label,
          workspacePort,
          protocol,
          browserScheme,
          declarationSource,
        );
        const attempts = yield* processes.listForService(service.id);
        const attemptOrdinal =
          attempts.reduce((largest, attempt) => Math.max(largest, attempt.attemptOrdinal ?? 0), 0) +
          1;
        const attempt = yield* processes.create({
          sessionId,
          sealantWorkspaceId: workspaceId,
          sealantSessionId: null,
          sealantRunId: null,
          serviceId: service.id,
          attemptOrdinal,
          kind: "service",
          label,
          argv,
          status: "starting",
        });
        yield* services.setCurrentAttempt(service.id, attempt.id);
        const pty = yield* sealant
          .openSession(workspace, argv)
          .pipe(Effect.tapError(() => processes.markExited(attempt.id, "exited", null)));
        yield* processes.setSealantSessionId(attempt.id, pty.id, SealantRunId.make(pty.runId));
        yield* renewWorkspaceLease(sessionId, workspaceId);
        yield* reconcileSession(sessionId, { sweep: false });
        const runningAttempt = (yield* processes.byId(attempt.id)) ?? attempt;
        yield* Effect.forkIn(watchProcess(runningAttempt), scope);

        let reachable = false;
        if (protocol === "udp") {
          yield* Effect.sleep("1500 millis");
          const early = yield* Effect.tryPromise({
            try: () => pty.status(),
            catch: () => new Error("status failed"),
          }).pipe(Effect.orElseSucceed(() => null));
          if (early !== null && early.status !== "running" && early.status !== "starting") {
            yield* processes.markExited(attempt.id, "exited", early.exitCode ?? null);
            const tail = yield* ptyOutputTail(pty);
            return yield* new ServiceStartError({
              message:
                `The command exited (code ${early.exitCode ?? "unknown"}) immediately.` +
                (tail === "" ? "" : `\n--- output ---\n${tail}`),
            });
          }
        } else {
          reachable = yield* awaitServicePort(
            pty,
            workspaceId,
            workspacePort,
            attempt.id,
            sessionId,
          );
        }
        yield* processes.setStatus(attempt.id, "running");
        const forwardId = yield* bindServiceForward(
          service.id,
          workspaceId,
          workspacePort,
          protocol,
        );
        if (protocol === "tcp") {
          yield* recordTcpObservation(service.id, forwardId, reachable);
        }
        return yield* readServiceView(service.id);
      });
      const runService = (
        sessionId: SessionId,
        argv: ReadonlyArray<string>,
        workspacePort: number,
        name: string | null,
        protocol: "tcp" | "udp" = "tcp",
        browserScheme: ServiceBrowserScheme = null,
        declarationSource: ServiceDeclarationSource = "explicit-run",
      ) =>
        withServiceLifecycle(
          runServiceUnlocked(
            sessionId,
            argv,
            workspacePort,
            name,
            protocol,
            browserScheme,
            declarationSource,
          ),
        );

      const runServiceRecipe = Effect.fn("SessionEngine.runServiceRecipe")(function* (
        sessionId: SessionId,
        name: string,
      ) {
        const session = yield* sessions.byId(sessionId);
        const project = yield* projects
          .byId(session.projectId)
          .pipe(
            Effect.mapError(
              () => new ServiceStartError({ message: "The recipe's project no longer exists." }),
            ),
          );
        const fromFile = yield* readServiceRecipes(
          worktreePathOf(project.storePath, session.worktree),
        ).pipe(Effect.mapError((error) => new ServiceStartError({ message: error.message })));
        const recipes = mergeRecipes(
          fromFile,
          yield* projectRecipes.listForProject(session.projectId),
        );
        const recipe = recipes.find(
          (candidate) => candidate.name === name && candidate.shadowedBy === null,
        );
        if (recipe === undefined) {
          return yield* new ServiceStartError({
            message: `No Service recipe named "${name}" exists in this session.`,
          });
        }
        const declarationSource =
          recipe.source === "file" ? ("recipe-file" as const) : ("recipe-project" as const);
        return yield* recipe.command === null
          ? addService(
              sessionId,
              recipe.port,
              recipe.name,
              recipe.protocol,
              recipe.browserScheme,
              declarationSource,
            )
          : runService(
              sessionId,
              ["sh", "-c", recipe.command],
              recipe.port,
              recipe.name,
              recipe.protocol,
              recipe.browserScheme,
              declarationSource,
            );
      });

      const restartServiceUnlocked = Effect.fn("SessionEngine.restartService")(function* (
        serviceId: ServiceId,
      ) {
        const service = yield* services.byId(serviceId);
        if (service === null) return yield* new ServiceNotFoundError({ processId: serviceId });
        const attempts = yield* processes.listForService(service.id);
        const previous =
          service.currentAttemptId === null
            ? null
            : yield* processes.byId(service.currentAttemptId);
        if (previous === null || previous.argv.length === 0) {
          return yield* new ServiceStartError({
            message: "An adopted Service has no recorded command to restart.",
          });
        }
        // Resolve the retained workspace before committing a new live-attempt row. A failed
        // lookup therefore leaves nothing for boot recovery or the one-live-attempt index.
        const workspace = yield* sealant.getWorkspace(previous.sealantWorkspaceId);
        if (previous.exitedAt === null && previous.sealantSessionId !== null) {
          yield* closeProcessPty(previous.sealantWorkspaceId, previous.sealantSessionId);
          yield* processes.markExited(previous.id, "stopped", null);
        }
        const attemptOrdinal =
          attempts.reduce((largest, attempt) => Math.max(largest, attempt.attemptOrdinal ?? 0), 0) +
          1;
        const attempt = yield* processes.create({
          sessionId: service.sessionId,
          sealantWorkspaceId: previous.sealantWorkspaceId,
          sealantSessionId: null,
          sealantRunId: null,
          serviceId: service.id,
          attemptOrdinal,
          kind: "service",
          label: service.name,
          argv: previous.argv,
          status: "starting",
        });
        yield* services.setCurrentAttempt(service.id, attempt.id);
        const pty = yield* sealant
          .openSession(workspace, previous.argv)
          .pipe(Effect.tapError(() => processes.markExited(attempt.id, "exited", null)));
        yield* processes.setSealantSessionId(attempt.id, pty.id, SealantRunId.make(pty.runId));
        yield* renewWorkspaceLease(service.sessionId, previous.sealantWorkspaceId);
        const runningAttempt = (yield* processes.byId(attempt.id)) ?? attempt;
        yield* Effect.forkIn(watchProcess(runningAttempt), scope);
        let reachable = false;
        if (service.transport === "udp") {
          yield* Effect.sleep("1500 millis");
        } else {
          reachable = yield* awaitServicePort(
            pty,
            previous.sealantWorkspaceId,
            service.workspacePort,
            attempt.id,
            service.sessionId,
          );
        }
        yield* processes.setStatus(attempt.id, "running");
        const currentForward =
          service.currentForwardId === null
            ? null
            : yield* serviceForwards.byId(service.currentForwardId);
        const forwardId =
          currentForward !== null && currentForward.state === "bound"
            ? currentForward.id
            : yield* bindServiceForward(
                service.id,
                previous.sealantWorkspaceId,
                service.workspacePort,
                service.transport,
              );
        if (service.transport === "tcp") {
          yield* recordTcpObservation(service.id, forwardId, reachable);
        }
        return yield* readServiceView(service.id);
      });
      const restartService = (serviceId: ServiceId) =>
        withServiceLifecycle(restartServiceUnlocked(serviceId));

      /**
       * What a session's in-workspace socket serves — every closure scoped to
       * that one session; ownership guards make cross-session ids a 404-shaped
       * error rather than a capability.
       */
      const socketApiFor = (sessionId: SessionId): SessionSocketApi =>
        ownedSocketApi(sessionId, {
          recipes: () =>
            Effect.gen(function* () {
              const session = yield* sessions.byId(sessionId);
              const project = yield* projects.byId(session.projectId);
              const fromFile = yield* readServiceRecipes(
                worktreePathOf(project.storePath, session.worktree),
              );
              return mergeRecipes(
                fromFile,
                yield* projectRecipes.listForProject(session.projectId),
              );
            }).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          listServices: () =>
            services
              .listForSession(sessionId)
              .pipe(
                Effect.flatMap((rows) => Effect.forEach(rows, (row) => readServiceView(row.id))),
              ),
          runServiceRecipe: (name) =>
            runServiceRecipe(sessionId, name).pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.orDie,
            ),
          runService: (argv, port, name, protocol) =>
            runService(sessionId, argv, port, name, protocol).pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.orDie,
            ),
          addService: (port, name, protocol) =>
            addService(sessionId, port, name, protocol).pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.orDie,
            ),
          stopService: (serviceReference) =>
            Effect.gen(function* () {
              const service = yield* services.byReference(serviceReference);
              if (service === null || service.sessionId !== sessionId) {
                return yield* new ServiceNotFoundError({ processId: serviceReference });
              }
              return yield* stopService(service.id);
            }).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          restartService: (serviceReference) =>
            Effect.gen(function* () {
              const service = yield* services.byReference(serviceReference);
              if (service === null || service.sessionId !== sessionId) {
                return yield* new ServiceNotFoundError({ processId: serviceReference });
              }
              return yield* restartService(service.id);
            }).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          // The credential seam (docs/GIT-ACCESS.md): session → project → auth
          // mode, resolved per request so a mode change applies to the next op
          // without touching the workspace. The op is recorded before the
          // connection opens — a transport that dies mid-pump still has a row.
          gitTransport: ({ host, port, command }) =>
            Effect.gen(function* () {
              const session = yield* sessions.byId(sessionId);
              const project = yield* projects.byId(session.projectId);
              const parsed = parseGitRemoteCommand(command);
              if (parsed === null) {
                return yield* Effect.fail(
                  new Error(
                    "this socket carries git transport only (git-upload-pack, git-receive-pack, git-upload-archive)",
                  ),
                );
              }
              if (host.startsWith("-")) {
                return yield* Effect.fail(
                  new Error(`refusing ssh target "${host}" — it reads as an option`),
                );
              }
              const mode = project.gitAuthMode;
              const keyPath =
                mode === "mend-key"
                  ? (yield* mendKeys
                      .ensure()
                      .pipe(
                        Effect.mapError(
                          (error) => new Error(`could not create the Mend key: ${error.stderr}`),
                        ),
                      )).privateKeyPath
                  : null;
              // Bridge mode signs on another machine: require the signer NOW —
              // an honest fast refusal in the workspace terminal beats an ssh
              // that hangs against an agent socket nobody serves.
              let env: Record<string, string> | undefined;
              if (mode === "bridge") {
                const bridgeStatus = yield* agentBridge.status();
                if (!bridgeStatus.connected) {
                  return yield* Effect.fail(new Error(NO_SIGNER_MESSAGE));
                }
                env = { SSH_AUTH_SOCK: agentBridge.socketPath() };
              }
              const op = yield* gitOps.record({
                sessionId,
                projectId: project.id,
                host,
                port,
                kind: parsed.kind,
                command,
                authMode: mode,
              });
              // Attribution for the share CLI: ended in gitTransportDone.
              if (mode === "bridge") {
                const end = yield* agentBridge.begin(
                  `project ${project.name} → ${host} (${parsed.kind})`,
                );
                bridgeContexts.set(op.id, end);
              }
              yield* Effect.logInfo("session git transport").pipe(
                Effect.annotateLogs({
                  sessionId,
                  project: project.name,
                  host,
                  kind: parsed.kind,
                  command,
                  authMode: mode,
                  opId: op.id,
                }),
              );
              return {
                opId: op.id,
                kind: parsed.kind,
                argv: ["ssh", ...sshTransportArgs(mode, keyPath, port), "--", host, command],
                ...(env === undefined ? {} : { env }),
              };
            }).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          gitTransportDone: (opId, exitCode, refUpdates) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                bridgeContexts.get(opId)?.();
                bridgeContexts.delete(opId);
              });
              yield* gitOps.finish(SessionGitOpId.make(opId), exitCode, refUpdates);
              yield* Effect.logInfo("session git transport closed").pipe(
                Effect.annotateLogs({
                  sessionId,
                  opId,
                  exitCode,
                  refUpdates: refUpdates === null ? undefined : refUpdates.join(", "),
                }),
              );
            }).pipe(Effect.ignore),
        });

      const stopServiceUnlocked = Effect.fn("SessionEngine.stopService")(function* (
        serviceId: ServiceId,
      ) {
        const service = yield* services.byId(serviceId);
        if (service === null) return yield* new ServiceNotFoundError({ processId: serviceId });
        const attempt =
          service.currentAttemptId === null
            ? null
            : yield* processes.byId(service.currentAttemptId);
        if (attempt !== null && attempt.exitedAt === null) {
          if (attempt.sealantSessionId !== null) {
            yield* closeProcessPty(attempt.sealantWorkspaceId, attempt.sealantSessionId);
          }
          yield* processes.markExited(attempt.id, "stopped", null);
        }
        yield* serviceHost.stop(service.id);
        if (service.currentForwardId !== null) {
          yield* serviceForwards.markClosed(service.currentForwardId);
          yield* services.compareAndSetCurrentForward(service.id, service.currentForwardId, null);
        }
        if (service.currentAttemptId !== null) {
          yield* services.compareAndSetCurrentAttempt(service.id, service.currentAttemptId, null);
        }
        yield* reconcileSession(service.sessionId, { sweep: true }).pipe(
          Effect.catchTag("SessionNotFoundError", () => Effect.void),
        );
        return yield* readServiceView(service.id);
      });
      const stopService = (serviceId: ServiceId) =>
        withServiceLifecycle(stopServiceUnlocked(serviceId));

      // -----------------------------------------------------------------------------------------
      // Hot sessions — the per-project pool of pre-provisioned session skeletons. A skeleton is a
      // pre-generated session id, its worktree, its socket dir, and a live workspace mounting
      // them; `provision` claims one so the launch skips straight to opening the PTY.
      // -----------------------------------------------------------------------------------------

      /** The create-time-fixed inputs as the project resolves them RIGHT NOW for `ownerUserId`. */
      const hotInputsFor = Effect.fn("SessionEngine.hotInputsFor")(function* (
        project: Project,
        ownerUserId: string | null,
      ) {
        const settings = yield* settingsRepo.get();
        const workspaceImage = project.workspaceImage ?? settings.workspaceImage;
        const dotfilesEnabled =
          project.applyDotfiles && workspaceImage.mode !== "custom" && ownerUserId !== null;
        const repository =
          dotfilesEnabled && ownerUserId !== null
            ? yield* userDotfilesRepo.repository(ownerUserId)
            : null;
        // The store snapshot is fingerprinted by its head commit (cheap); the cloned repository
        // only by url+ref — its content is never pinned, so a push between reconciles rides
        // until the next drain. Cold launches always clone fresh.
        const snapshot =
          dotfilesEnabled && ownerUserId !== null
            ? yield* dotfilesStore.current(ownerUserId).pipe(Effect.orElseSucceed(() => null))
            : null;
        const environment = yield* projectEnvironment.snapshot(project.id);
        const secrets = yield* projectSecrets.snapshot(project.id);
        const selectedReferences = yield* references
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const declaredMounts = yield* projectMounts
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const inputs: HotFingerprintInputs = {
          workspaceImage,
          applyDotfiles: project.applyDotfiles,
          dotfiles: {
            repository: repository === null ? null : { url: repository.url, ref: repository.ref },
            snapshotSha: snapshot?.sha ?? null,
          },
          environmentRevision: environment.revision,
          secretRevision: secrets.revision,
          references: selectedReferences.map((r) => ({ name: r.name, path: r.path })),
          mounts: declaredMounts.map((m) => ({
            name: m.name,
            hostPath: m.hostPath,
            readOnly: m.readOnly,
          })),
        };
        return inputs;
      });

      /**
       * Tear a pool entry down. `keepWorktree` is the claim/adopt path: the session now owns the
       * worktree and socket dir, so only the row (and a dead workspace) go.
       */
      const drainHotWorkspace = Effect.fn("SessionEngine.drainHotWorkspace")(function* (
        entry: HotWorkspace,
        options?: { readonly keepWorktree?: boolean },
      ) {
        if (entry.sealantWorkspaceId !== null) {
          yield* sealant.getWorkspace(entry.sealantWorkspaceId).pipe(
            Effect.flatMap((workspace) => sealant.stopWorkspace(workspace)),
            Effect.ignore,
            asSealantUser(entry.ownerUserId),
          );
        }
        yield* channelTokens.revoke(entry.id).pipe(Effect.ignore);
        if (options?.keepWorktree !== true) {
          yield* socketHost.stop(entry.id).pipe(Effect.ignore);
          yield* projects.byId(entry.projectId).pipe(
            Effect.flatMap((project) =>
              store.removeWorktreeForce(project.storePath, entry.worktree),
            ),
            Effect.ignore,
          );
        }
        yield* hotWorkspaces.remove(entry.id);
      });

      /** Provision one skeleton: worktree → row → socket → workspace → prewarm note → ready. */
      const provisionHotWorkspace = Effect.fn("SessionEngine.provisionHotWorkspace")(function* (
        project: Project,
        ownerUserId: string | null,
        fingerprint: string,
      ) {
        const sessionId = SessionId.make(crypto.randomUUID());
        const worktree = yield* store.createWorktree(project.storePath, sessionId, null);
        const entry = yield* hotWorkspaces.create({
          id: sessionId,
          projectId: project.id,
          ownerUserId,
          fingerprint,
          worktree: worktree.name,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
        });
        const socketDir = yield* socketHost.start(sessionId, socketApiFor(sessionId));
        const provisionAttempt = Effect.gen(function* () {
          const provisioned = yield* provisionWorkspace({
            project,
            sessionId,
            worktree: worktree.path,
            socketDir,
            // The unified image carries EVERY baked agent CLI and the shell shape's credential
            // ladder attaches all connected accounts, so one skeleton serves any harness.
            shape: platformShape("shell"),
            ownerUserId,
            onFailure: (message) => hotWorkspaces.setFailed(sessionId, message),
          });
          yield* appendWorkspaceNote(
            provisioned.workspace,
            project,
            worktree.path,
            provisioned.referenceMounts,
            provisioned.extraMounts,
          );
          yield* hotWorkspaces.setReady(sessionId, {
            sealantWorkspaceId: SealantWorkspaceId.make(provisioned.workspace.id),
            workspaceImage: provisioned.workspaceImage,
            dotfiles: provisioned.dotfiles,
            environment: provisioned.environmentManifest,
            referenceMounts: provisioned.referenceMounts,
            extraMounts: provisioned.extraMounts,
          });
          return true;
        });
        return yield* provisionAttempt.pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: hot workspace provision failed").pipe(
              Effect.annotateLogs({
                projectId: project.id,
                hotWorkspaceId: entry.id,
                error: String(error),
              }),
              Effect.as(false),
            ),
          ),
        );
      });

      /** One reconcile pass; callers serialize through `requestHotReconcile`. */
      const reconcileHotPoolOnce = Effect.fn("SessionEngine.reconcileHotPoolOnce")(function* (
        projectId: ProjectId,
      ) {
        const project = yield* projects
          .byId(projectId)
          .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
        const entries = yield* hotWorkspaces.listForProject(projectId);
        if (project === null) {
          for (const entry of entries) yield* drainHotWorkspace(entry);
          return;
        }
        const ownerUserId = yield* userDotfilesRepo.firstUserId();
        const inputs = yield* hotInputsFor(project, ownerUserId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: hot pool inputs unreadable").pipe(
              Effect.annotateLogs({ projectId, error: String(error) }),
              Effect.as(null),
            ),
          ),
        );
        if (inputs === null) return;
        const fingerprint = hotFingerprint(inputs);
        const target = Math.max(0, project.hotSessions);
        const survivors: Array<HotWorkspace> = [];
        for (const entry of entries) {
          // Claimed entries belong to a launch in flight; the boot sweep reaps abandoned ones.
          if (entry.status === "claimed") continue;
          if (
            entry.status === "ready" &&
            entry.fingerprint === fingerprint &&
            survivors.length < target
          ) {
            survivors.push(entry);
            continue;
          }
          // warming = a crashed provision (this pass is the only live one), failed = retry by
          // rebuild, stale fingerprint or over-target = drain.
          yield* drainHotWorkspace(entry);
        }
        // Probe survivors and keep the platform reaper away; a dead one drains instead.
        let count = 0;
        for (const entry of survivors) {
          const workspaceId = entry.sealantWorkspaceId;
          const alive =
            workspaceId === null
              ? false
              : yield* sealant.getWorkspace(workspaceId).pipe(
                  Effect.flatMap((workspace) =>
                    Effect.promise(() => workspace.status()).pipe(
                      Effect.tap((status) =>
                        workspaceIsLive(status)
                          ? sealant
                              .expireWorkspace(workspace.id, WORKSPACE_TTL_SECONDS)
                              .pipe(Effect.ignore)
                          : Effect.void,
                      ),
                      Effect.map(workspaceIsLive),
                    ),
                  ),
                  Effect.catch(() => Effect.succeed(false)),
                  Effect.catchDefect(() => Effect.succeed(false)),
                );
          if (alive) count += 1;
          else yield* drainHotWorkspace(entry);
        }
        while (count < target) {
          const provisioned = yield* provisionHotWorkspace(project, ownerUserId, fingerprint).pipe(
            asSealantUser(ownerUserId),
          );
          // A failure leaves its row `failed` for the setup page; the next trigger retries.
          if (!provisioned) break;
          count += 1;
        }
      });

      /**
       * Coalesced per-project scheduling: at most one reconcile runs per project, and a trigger
       * landing mid-run re-runs it once more instead of stacking fibers.
       */
      const hotReconcileStates = new Map<ProjectId, { again: boolean }>();
      const requestHotReconcile = Effect.fn("SessionEngine.requestHotReconcile")(function* (
        projectId: ProjectId,
      ) {
        const running = hotReconcileStates.get(projectId);
        if (running !== undefined) {
          running.again = true;
          return;
        }
        const state = { again: false };
        hotReconcileStates.set(projectId, state);
        const loop = Effect.gen(function* () {
          for (;;) {
            yield* reconcileHotPoolOnce(projectId).pipe(
              Effect.catchDefect((defect) =>
                Effect.logWarning("session engine: hot pool reconcile died").pipe(
                  Effect.annotateLogs({ projectId, defect: String(defect) }),
                ),
              ),
            );
            if (!state.again) return;
            state.again = false;
          }
        }).pipe(Effect.ensuring(Effect.sync(() => hotReconcileStates.delete(projectId))));
        yield* Effect.forkIn(loop, scope);
      });

      /**
       * Adopt a ready skeleton for a new session: atomically pop a fingerprint-matching entry,
       * freshen its worktree to the requested base (a bind mount — the running container sees
       * the reset immediately), and create the session row under the POOLED id, which the
       * worktree, branch, and socket dir already carry. Null falls back to the cold path.
       */
      const claimHotSession = Effect.fn("SessionEngine.claimHotSession")(function* (
        project: Project,
        input: ProvisionInput,
      ) {
        const ownerUserId = input.ownerUserId ?? (yield* userDotfilesRepo.firstUserId());
        const inputs = yield* hotInputsFor(project, ownerUserId);
        const entry = yield* hotWorkspaces.claim(project.id, hotFingerprint(inputs), ownerUserId);
        if (entry === null) return null;
        // The replacement warms in the background while this session launches.
        yield* requestHotReconcile(project.id);
        const freshened = yield* store
          .resetWorktree(project.storePath, entry.worktree, input.base)
          .pipe(Effect.tapError(() => drainHotWorkspace(entry)));
        const session = yield* sessions.create({
          id: entry.id,
          projectId: project.id,
          harness: input.harness,
          label: input.label,
          ownerUserId: input.ownerUserId,
          worktree: entry.worktree,
          branch: entry.branch,
          baseSha: freshened.baseSha,
          contextSnapshotId: null,
        });
        yield* tryCheckpoint(session, "session-start", { sealantRunId: null, sequence: 0n });
        yield* changes.ensureForSession(project.id, session.id, entry.branch, freshened.baseSha);
        return session;
      });

      /**
       * Boot-and-heartbeat pass: abandoned claims and dead entries drain, live ready entries get
       * their socket re-bound (deterministic dir — the running container's mount comes back to
       * life untouched), and every project with a target or leftovers reconciles. Doubles as the
       * TTL-refresh heartbeat every 10 minutes.
       */
      const hotPoolSweep = Effect.fn("SessionEngine.hotPoolSweep")(function* () {
        const entries = yield* hotWorkspaces.listAll();
        const projectIds = new Set<ProjectId>();
        for (const entry of entries) {
          projectIds.add(entry.projectId);
          if (entry.status === "claimed") {
            // A claim whose session died before launch consumed it: the settled (or missing)
            // session tells the abandoned claim from one still launching.
            const session = yield* sessions
              .byId(entry.id)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
            if (session === null) yield* drainHotWorkspace(entry);
            else if (session.settledAt !== null) {
              yield* drainHotWorkspace(entry, { keepWorktree: true });
            }
            continue;
          }
          if (entry.status === "ready") {
            yield* socketHost.start(entry.id, socketApiFor(entry.id)).pipe(Effect.ignore);
          }
        }
        const allProjects = yield* projects.list();
        for (const project of allProjects) {
          if (project.hotSessions > 0) projectIds.add(project.id);
        }
        for (const projectId of projectIds) {
          yield* requestHotReconcile(projectId);
        }
      });

      /** Re-attach to sessions that were live when the last process died. */
      const resume = Effect.fn("SessionEngine.resume")(function* () {
        // Restart policy v1: adapter state is process-local. End live protocol rows on boot;
        // an explicit session resume starts a fresh pipe process and resumes by provider id.
        for (const protocolProcess of (yield* processes.listLive()).filter(
          (process) => process.kind === "agent-protocol",
        )) {
          yield* protocolHost.detach(protocolProcess.id);
          yield* conversations.cancelOpenForProcess(protocolProcess.id);
          if (protocolProcess.sealantSessionId !== null) {
            yield* closeProcessPty(
              protocolProcess.sealantWorkspaceId,
              protocolProcess.sealantSessionId,
            ).pipe(Effect.ignore, owned(protocolProcess.sessionId));
          }
          const recorded = yield* endAgentProcess(protocolProcess, {
            how: "exited",
            exitCode: null,
            outcome: "failed",
            summary: "Mend restarted before the protocol process settled.",
          }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)));
          if (recorded) yield* finishAgentProcess(protocolProcess, "turn-boundary");
        }
        const activeRuns = yield* sessionRuns.listActive();
        const reattached = new Set<string>();
        for (const sessionRun of activeRuns) {
          const session = yield* sessions
            .byId(sessionRun.sessionId)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
          if (session === null || session.settledAt !== null) continue;
          reattached.add(session.id);
          yield* forkSupervision(session.id, sessionRun.sealantRunId);
          yield* Effect.logInfo("session engine: re-attached").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              sealantRunId: sessionRun.sealantRunId,
              from: String(sessionRun.lastSeenSequence),
            }),
          );
        }

        // Processes that were live when the last process died: their PTYs
        // kept running (a detached client is not intent to stop), so watch
        // them again — the watcher itself records the end if the workspace is
        // gone.
        const liveProcesses = (yield* processes.listLive()).filter(
          (process) => process.kind !== "agent-protocol",
        );
        const sessionsWithLiveProcesses = new Set(
          liveProcesses.map((liveProcess) => liveProcess.sessionId),
        );

        const unsettled = yield* sessions.listUnsettled();
        for (const session of unsettled) {
          if (reattached.has(session.id)) continue;
          // Live rows own the verdict: the re-forked watchers end them and the fold follows.
          if (sessionsWithLiveProcesses.has(session.id)) {
            yield* reconcileSession(session.id, { sweep: false }).pipe(Effect.ignore);
            continue;
          }
          // Every process ended but nobody folded (the fiber died mid-tail): fold now. A row
          // that never reached a process died before the harness started.
          const hadAgent = (yield* processes.listForSession(session.id)).some((process) =>
            isAgentProcessKind(process.kind),
          );
          if (hadAgent) {
            yield* reconcileSession(session.id, { sweep: true }).pipe(Effect.ignore);
            continue;
          }
          yield* sessions.settle(
            session.id,
            "failed",
            "process restarted before the harness started",
          );
        }

        const allServices = yield* services.listAll();
        // A crash after committing an attempt but before recording PTY acceptance leaves no
        // discoverable platform identity in the public SDK. Settle that row so it cannot hold the
        // one-live-attempt index forever; its command remains as honest retry context.
        for (const liveProcess of liveProcesses) {
          if (
            liveProcess.kind === "service" &&
            liveProcess.serviceId !== null &&
            liveProcess.sealantSessionId === null
          ) {
            yield* processes.markExited(liveProcess.id, "exited", null);
          }
        }
        const selectedForwardIds = new Set(
          allServices.flatMap((service) =>
            service.currentForwardId === null ? [] : [service.currentForwardId],
          ),
        );
        for (const forward of yield* serviceForwards.listOpen()) {
          if (!selectedForwardIds.has(forward.id)) {
            yield* serviceForwards.markClosed(forward.id);
          }
        }
        // Every session with a live workspace gets its socket re-bound: the
        // dir path is deterministic, so the running container's mount comes
        // back to life without touching it.
        const socketSessions = new Set<SessionId>([...reattached].map((id) => SessionId.make(id)));
        for (const liveProcess of liveProcesses) {
          socketSessions.add(liveProcess.sessionId);
        }
        for (const service of allServices) {
          if (service.currentForwardId !== null) socketSessions.add(service.sessionId);
        }
        for (const liveProcess of liveProcesses) {
          if (
            isAgentProcessKind(liveProcess.kind) ||
            liveProcess.kind === "shell" ||
            (liveProcess.kind === "service" && liveProcess.serviceId !== null)
          ) {
            yield* Effect.forkIn(watchProcess(liveProcess), scope);
          }
        }

        // A host listener is process-local. Commit replacement intent and retire the stale
        // listener record before platform I/O, then retry transient workspace observation while
        // the Service honestly reads `binding`. The shared lifecycle permit prevents Stop or
        // Restart from interleaving with this transition.
        for (const serviceStub of allServices) {
          const reconcileForward = withServiceLifecycle(
            Effect.gen(function* () {
              const service = yield* services.byId(serviceStub.id);
              if (service === null || service.currentForwardId === null) return;
              const previous = yield* serviceForwards.byId(service.currentForwardId);
              if (
                previous === null ||
                (previous.state !== "binding" && previous.state !== "bound")
              ) {
                return;
              }
              const forward = yield* serviceForwards.createAndSelect({
                serviceId: service.id,
                sealantWorkspaceId: previous.sealantWorkspaceId,
                preferredHostPort: previous.hostPort ?? previous.preferredHostPort,
                supersedesForwardId: previous.id,
              });
              yield* serviceForwards.markClosed(previous.id);

              const status = yield* Effect.gen(function* () {
                const candidate = yield* sealant.getWorkspace(previous.sealantWorkspaceId);
                return yield* Effect.tryPromise({
                  try: () => candidate.status(),
                  catch: (cause) =>
                    new SealantPlatformError({
                      code: "workspace_status_failed",
                      status: null,
                      message: "Could not observe the Service workspace during boot.",
                      cause,
                    }),
                });
              }).pipe(
                Effect.retry({
                  times: 4,
                  schedule: Schedule.exponential("500 millis"),
                }),
                Effect.tapError((error) =>
                  serviceForwards
                    .markFailed(forward.id, error.message)
                    .pipe(
                      Effect.andThen(
                        services.compareAndSetCurrentForward(service.id, forward.id, null),
                      ),
                    ),
                ),
              );
              if (!workspaceIsLive(status)) {
                yield* serviceForwards.markFailed(forward.id, `workspace observed ${status}`);
                yield* services.compareAndSetCurrentForward(service.id, forward.id, null);
                if (service.currentAttemptId !== null) {
                  yield* processes.markExited(service.currentAttemptId, "exited", null);
                }
                return;
              }
              const bindAddresses = service.bindAddresses ?? previous.boundAddresses;
              if (bindAddresses === null) {
                yield* serviceForwards.markFailed(
                  forward.id,
                  "The Service has no recorded bind policy and cannot be recovered.",
                );
                yield* services.compareAndSetCurrentForward(service.id, forward.id, null);
                return;
              }
              const binding = yield* serviceHost
                .start({
                  serviceId: service.id,
                  forwardId: forward.id,
                  workspaceId: previous.sealantWorkspaceId,
                  workspacePort: service.workspacePort,
                  protocol: service.transport,
                  bindAddresses,
                  ...(forward.preferredHostPort === null
                    ? {}
                    : { preferredHostPort: forward.preferredHostPort }),
                })
                .pipe(
                  Effect.tapError((error) =>
                    serviceForwards
                      .markFailed(forward.id, error.message)
                      .pipe(
                        Effect.andThen(
                          services.compareAndSetCurrentForward(service.id, forward.id, null),
                        ),
                      ),
                  ),
                );
              yield* serviceForwards.markBound(
                forward.id,
                binding.hostPort,
                binding.boundAddresses,
              );
              if (service.transport === "tcp") {
                yield* recordTcpObservation(
                  service.id,
                  forward.id,
                  yield* serviceHost.probe(previous.sealantWorkspaceId, service.workspacePort),
                );
              }
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: Service forward reconcile failed").pipe(
                Effect.annotateLogs({ serviceId: serviceStub.id, error: String(error) }),
              ),
            ),
          );
          yield* reconcileForward;
        }
        // Expose in-workspace controls only after boot reconciliation has reached a stable fact.
        for (const socketSessionId of socketSessions) {
          yield* socketHost
            .start(socketSessionId, socketApiFor(socketSessionId))
            .pipe(Effect.ignore);
        }
      });

      /**
       * Settle-time sweeps are forked fibers; a process restart kills them and
       * the workspace outlives its session. Every boot finishes the job for
       * recently settled sessions whose workspace is still alive — a late
       * harvest rescues any transcript the dead fiber missed, then the reap
       * lands. The platform TTL remains the belt for anything older.
       */
      const sweepLeftovers = Effect.fn("SessionEngine.sweepLeftovers")(function* () {
        const settled = yield* sessions.listRecentlySettled();
        for (const session of settled) {
          if (session.sealantWorkspaceId === null) continue;
          const workspaceId = session.sealantWorkspaceId;
          const sweepIfAlive = Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(workspaceId);
            const status = yield* Effect.promise(() => workspace.status());
            if (status !== "queued" && status !== "running" && status !== "ready") {
              // The container is gone (stopped externally or reaped by TTL) —
              // no process row for it can still be live. Reconcile the leases.
              yield* processes.reapLiveForWorkspace(workspaceId);
              return;
            }
            yield* Effect.logInfo("session engine: reaping leftover workspace").pipe(
              Effect.annotateLogs({ sessionId: session.id, workspaceId }),
            );
            yield* sweepWorkspace(session.id);
          }).pipe(
            asSealantUser(session.ownerUserId),
            Effect.catch(() => Effect.void),
            Effect.catchDefect(() => Effect.void),
          );
          yield* Effect.forkIn(sweepIfAlive, scope);
        }
      });

      yield* resume();
      yield* Effect.forkIn(sweepLeftovers(), scope);
      // Ordinary retained workspaces have their own boot-and-heartbeat renewal. This pass runs
      // immediately, then every ten minutes, independently of hot-pool reconciliation.
      yield* Effect.forkIn(
        retainedWorkspaceSweep().pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("session engine: retained workspace sweep died").pipe(
              Effect.annotateLogs({ defect: String(defect) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(Duration.minutes(10))),
        ),
        scope,
      );
      // The pool's boot pass runs after `resume` has settled stranded sessions (so abandoned
      // claims read as settled), then repeats as the TTL-refresh heartbeat.
      yield* Effect.forkIn(
        hotPoolSweep().pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("session engine: hot pool sweep died").pipe(
              Effect.annotateLogs({ defect: String(defect) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(Duration.minutes(10))),
        ),
        scope,
      );

      const launch = (sessionId: SessionId, argv: ReadonlyArray<string>) =>
        launchInternal(sessionId, argv, null);

      // Every public verb about a session runs AS ITS OWNER (docs/SEALANT-IDENTITY.md): the
      // platform resources belong to the owner's Sealant user, whoever is at the keyboard.
      // Fibers forked underneath inherit the principal.
      return {
        provision,
        attachRun: (sessionId, sealantRunId, workspaceId) =>
          owned(sessionId)(attachRun(sessionId, sealantRunId, workspaceId)),
        launch: (sessionId, argv) => owned(sessionId)(launch(sessionId, argv)),
        launchProtocol: (sessionId, ...rest) =>
          owned(sessionId)(launchProtocol(sessionId, ...rest)),
        submitTurn: (sessionId, input, author) =>
          owned(sessionId)(submitTurn(sessionId, input, author)),
        interruptTurn,
        respondRequest,
        launchFollowUp: (sessionId, instruction, launchCorrelationId) =>
          owned(sessionId)(launchFollowUp(sessionId, instruction, launchCorrelationId)),
        reconcileHotSessions: requestHotReconcile,
        checkpointNow: (sessionId, trigger) => owned(sessionId)(checkpointNow(sessionId, trigger)),
        stop: (sessionId) => owned(sessionId)(stop(sessionId)),
        openShell: (sessionId) => owned(sessionId)(openShell(sessionId)),
        stopShell: (processId) => ownedByProcess(processId)(stopShell(processId)),
        renameShell: (processId, label) => ownedByProcess(processId)(renameShell(processId, label)),
        addService: (sessionId, ...rest) => owned(sessionId)(addService(sessionId, ...rest)),
        runService: (sessionId, ...rest) => owned(sessionId)(runService(sessionId, ...rest)),
        runServiceRecipe: (sessionId, name) => owned(sessionId)(runServiceRecipe(sessionId, name)),
        restartService: (serviceId) => ownedByService(serviceId)(restartService(serviceId)),
        stopService: (serviceId) => ownedByService(serviceId)(stopService(serviceId)),
        resumeSession: (sessionId, harness, fresh) =>
          owned(sessionId)(resumeSession(sessionId, harness, fresh)),
        transcript,
      };
    }),
  );
