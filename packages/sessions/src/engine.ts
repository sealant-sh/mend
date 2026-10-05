import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  AgentConversationRepo,
  type AgentRequestAlreadyResolvedError,
  AgentRequestNotFoundError,
  CheckpointsRepo,
  HotWorkspacesRepo,
  ProjectClusterBindingsRepo,
  ProjectEnvironmentRepo,
  ProjectMountsRepo,
  ProjectLinksRepo,
  OrganizationsRepo,
  FoldersRepo,
  type ProjectNotFoundError,
  SessionRepositoriesRepo,
  ProjectSecretsRepo,
  ProjectsRepo,
  ReferencesRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionGitOpsRepo,
  WorktreeChangesRepo,
  type WorktreeNotFoundError,
  WorktreesRepo,
  type SessionNotFoundError,
  type SessionOutcome,
  ProjectServiceRecipesRepo,
  SessionProcessesRepo,
  type NewSessionRun,
  SessionRunsRepo,
  SessionsRepo,
  AgentMemoryRepo,
  agentMemoryDigest,
  PiProfilesRepo,
  SecretFilesRepo,
  SettingsRepo,
  SkillsRepo,
  UserDotfilesRepo,
  UserGitAuthorRepo,
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
  WorktreeId,
} from "@mend/domain";
import type {
  Checkpoint,
  CheckpointTrigger,
  HotWorkspace,
  Project,
  Service,
  ServiceRecipe,
  Session,
  SessionDotfilesNotApplied,
  SessionOrigin,
  SessionProcess,
  SessionRun,
  SessionStatus,
  Worktree,
} from "@mend/domain/workbench";
import {
  LAUNCH_BOOTING,
  LAUNCH_PREPARING,
  leaseWaitWords,
  reservedSecretFileRoot,
  withoutLaunchPhase,
} from "@mend/domain/workbench";
import {
  agentPushedBranches,
  agentStartingWords,
  withoutAgentStarting,
  gitRemoteLocation,
  isSameGitRemote,
  type ProjectLink,
  AGENT_PROCESS_KINDS,
  type AgentApprovalDecision,
  type AgentInputAnswers,
  type AgentRequest,
  type AgentTurn,
  EFFORT_LEVELS,
  HARNESS_EFFORTS,
  type EffortLevel,
  type LaunchStart,
  PERMISSION_MODES,
  SPEED_MODES,
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
  type SessionRepository as SessionRepositoryRow,
  canUseLink,
  isRepositoryName,
  nestedRepositoryPath,
  repositoryPath,
  type CaptureDiscardFacts,
  type CaptureDrainReason,
  type CaptureDrainStep,
  type CaptureReading,
  captureDrainStep,
  captureBehindReason,
  CAPTURE_HEALTH_UNREPORTED,
  captureCaughtUp,
  captureHarvestReady,
  captureIncompleteReasonOf,
  captureSaved,
  type CapturePosition,
  captureUnsavedWordsOf,
  saveCoversUnsaved,
  captureSnapDetailOf,
  captureSnapFailing,
  captureStatusLine,
  CAPTURE_EXECUTOR_RETAINED,
  type CaptureThroughput,
  executorCapDue,
  executorEndOf,
  executorEndWords,
  executorSavedWords,
  restatedSummary,
  executorUnansweredWords,
  observeCaptureThroughput,
  OPENCODE_PERMISSION_ALLOW,
  planExecutorCap,
  AGENT_MEMORY_FILES,
  AGENT_MEMORY_ROOTS,
  agentMemoryMaxFileBytes,
} from "@mend/domain/workbench";
import {
  asSealantUser,
  captureDrainOf,
  type CaptureFlushKind,
  SealantClient,
  SealantPlatformError,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import {
  AgentBridge,
  DotfilesStore,
  GitError,
  MendKeys,
  NO_SIGNER_MESSAGE,
  SecretCipher,
  bulkSectionFor,
  bulkSectionsByPlatform,
  decodeManifest,
  git,
  harnessHomePathOf,
  listCaptureFiles,
  processStatePathOf,
  readCaptureFile,
  readCaptureFileBytes,
  withCaptureReadPass,
  sessionStatePathOf,
  resolveRemoteEnv,
  sshTransportArgs,
  unsupportedRepositoryReason,
  worktreePathOf,
  worktreesRootOf,
  BlobStore,
  DeploymentConfig,
  SourcePolicy,
} from "@mend/store";
import type {
  Harness,
  Run as SdkRun,
  Workspace,
  WorkspaceCaptureSource,
  WorkspaceCredentialsOptions,
} from "@sealant/sdk";
import { claudeCode, codex, opencode } from "@sealant/sdk";
import {
  Cause,
  Config,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

import {
  AGENT_MEMORY_DELIVERED,
  type AgentMemoryRead,
  agentMemoryHandoverKeptDir,
  unreadableOutsideMemory,
  asMemoryFile,
  deliverAgentMemoryExec,
  handOverAgentMemoryExec,
  materializeAgentMemory,
  mergeTextUnion,
  parseAgentMemoryDelivered,
  parseAgentMemoryOutcomes,
  planAgentMemory,
  readAgentMemoryFromHome,
  withoutSkipped,
} from "./agent-memory.ts";
import { harnessWarmupArgv, isOutputEntry } from "./agent-start.ts";
import {
  type CapturePlanNotice,
  type CaptureRouteError,
  LAUNCH_CLAIM_TTL_SECONDS,
  PLAN_BLOCKED_PREFIX,
  PLAN_WAITING_PREFIX,
  type SessionCaptureApi,
} from "./capture-channel.ts";
import {
  CaptureDrainPolicy,
  CaptureRuntime,
  LEASE_REAPER_INTERVAL_SECONDS,
  readCaptureReport,
  REPLACEMENT_AGE_SECONDS,
} from "./capture-runtime.ts";
import { CaptureSeals } from "./capture-seals.ts";
import {
  carryConversationsExec,
  codexDatabaseHolds,
  codexMemoryMayStayOn,
  consolidateCodexDatabase,
  materializeCarriedConversations,
  parseCarryOutcomes,
  planCodexCarry,
  prepareCarriedConversations,
  readRolloutFacts,
  storedCodexDatabase,
  storedCodexThreadLines,
  summarisedThreads,
  type CodexRevision,
  type RolloutFacts,
  withholdCodexThreadsExec,
} from "./codex-memory.ts";
import { detectInstallCommand, PLATFORM_PROBE_SCRIPT, platformKeyOf } from "./dependency-cache.ts";
import { DotfilesCloner, DotfilesResolveError, snapshotArchive } from "./dotfiles.ts";
import { gitAuthorConfigArgv } from "./git-author.ts";
import { parseGitRemoteCommand } from "./git-transport.ts";
import {
  CODEX_DAEMON_OFF,
  launchesCodex,
  withCodexMemoryOff,
  withHarnessSetup,
} from "./harness-seeds.ts";
import {
  HARNESS_HOME_MOUNT_PATH,
  HARNESS_STATE,
  HarnessStateCommandError,
  type HarnessStateError,
  HarnessStateIOError,
  HarnessStateInvalidError,
  distillOpeningPrompt,
  readHarnessStateManifest,
  extractTranscript,
  hasLiveHarnessState,
  hasLiveConversation,
  CARRIED_TRANSCRIPTS,
  harvestHarnessStateScript,
  locateLiveTranscript,
  parseCarriedTranscripts,
  nativeResumeArgv,
  readHarnessFileScript,
  relocateHarnessHomeScript,
  type HarnessStateManifest,
  type LocatedHarnessState,
  locateHarnessState,
} from "./harness-state.ts";
import {
  hotFingerprint,
  type HotFingerprintInputs,
  standbyEpochOf,
  standbyWorktreeAlias,
} from "./hot-pool.ts";
import { makeLaunchGate } from "./launch-gate.ts";
import { backfillFromNative, cursorAtEndOf } from "./native-backfill.ts";
import {
  convertNativeSession,
  ingestNativeSession,
  type ConvertedNativeSession,
} from "./native-convert.ts";
import {
  type OpencodeConversation,
  opencodeConversationOf,
  opencodeSpanOf,
  readOpencodeLaunchSnapshot,
  snapshotOpencodeHome,
  writeOpencodeLaunchSnapshot,
  OPENCODE_DATABASE,
  readOpencodeConversations,
  readOpencodeHome,
} from "./opencode-state.ts";
import {
  checkPastedImage,
  PastedImageError,
  pastedImageWorkspacePath,
  type PlacedPastedImage,
  storePastedImage as storePastedImageOnHost,
} from "./pasted-images.ts";
import {
  materializePiProfile,
  piProfileFilesToWrite,
  piProfileKeptDir,
  planPiProfile,
  vacatePiProfileExec,
} from "./pi-profile.ts";
import {
  ProtocolHost,
  type ProtocolHostHooks,
  type ProtocolHostNotLiveError,
} from "./protocol-host.ts";
import {
  mergeRecipes,
  parseServiceRecipes,
  readServiceRecipes,
  RecipeFileError,
} from "./recipes.ts";
import {
  HOT_POOL_MAX_OWNERS,
  HOT_POOL_RECENT_OWNER_WINDOW,
  INSTALL_SESSION_LABEL,
  mayRunIn,
} from "./run-eligibility.ts";
import {
  decodeSecretFilesRecord,
  encodeSecretFilesRecord,
  foldSecretFileOutcomes,
  parseSecretFileOutcomes,
  planSecretFiles,
  secretFilesCleanupExec,
  secretFilesDeliveredExec,
  secretFilesExecs,
  secretFilesRecordExec,
  secretFilesRemoveExec,
  secretFilesSetAsideExec,
  SECRET_FILES_SET_ASIDE,
  type SecretFileOutcome,
  type SecretFilesRecord,
} from "./secret-files.ts";
import { ServiceBindError, ServiceHost, validateServiceBindAddresses } from "./service-host.ts";
import {
  type AddableProject,
  failureReason,
  parseRelinkReport,
  REPOSITORY_EXISTS_EXIT,
  REPOSITORY_OUTSIDE_EXIT,
  REPOSITORY_PATH_OCCUPIED_EXIT,
  repositoryCloneScript,
  repositoryRelinkScript,
} from "./session-repositories.ts";
import { SessionRepository, type SessionRepositoryError } from "./session-repository.ts";
import {
  SESSION_SOCKET_MOUNT_PATH,
  SessionSocketHost,
  workspaceScriptStaging,
  type SessionSocketApi,
} from "./session-socket.ts";
import { loadShellProfile, shellProfileApplies } from "./shell-profile.ts";
import {
  MANAGED_SKILLS_DIGESTS,
  MANAGED_SKILLS_MANIFEST,
  materializeSkills,
  mergeSkillLibraries,
  parseManagedSkillDigests,
  parseManagedSkills,
  parseSkillsVacateOutcomes,
  planSkills,
  skillFilesToWrite,
  type SkillsVacateOutcome,
  skillsKeptDir,
  vacateSkillsExec,
} from "./skills.ts";
import {
  parseHomeFileOutcomes,
  type WorkspaceFile,
  WorkspaceFileError,
  writeAbsentHomeFilesExecs,
  writeFilesExecs,
} from "./workspace-files.ts";
import { WorkspaceGitHooks } from "./workspace-git-hooks.ts";
import {
  parseWorkspaceNoteOutcomes,
  WORKSPACE_NOTE_NOT_WRITTEN,
  workspaceNoteExec,
} from "./workspace-note.ts";

/** Whether a push's ref commands created or moved a branch (not a tag, not a delete). */
const pushedBranches = (refUpdates: ReadonlyArray<string> | null): boolean =>
  agentPushedBranches(refUpdates ?? []).length > 0;

/**
 * How a harness takes an opening prompt (the cross-harness handoff). The public SDK rejects argv
 * elements with outer whitespace, so the exact user-approved bytes travel as bounded base64 chunks
 * and are decoded in the workspace. The sentinel preserves trailing newlines through POSIX command
 * substitution.
 */
/** A word for `sh -c`, in single quotes, whatever it holds. */
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * A harness opened on a prompt, with the model and effort the session was started with
 * (docs/models-audit.md): the follow-up a stopped PTY session gets runs on the model the session
 * reports, not on whatever the harness would pick today. Flags the harness does not take are left
 * out, as `composeLaunchArgv` leaves them out.
 */
/**
 * opencode's database in a capture: absent, torn (sealantd read it changing every time), or
 * the conversations it lists (null: it does not open as opencode's).
 */
const capturedOpencode = (
  manifest: Parameters<typeof listCaptureFiles>[0],
  files: ReadonlyArray<{
    readonly path: string;
    readonly entry: { readonly kind: string; readonly torn?: boolean };
  }>,
) =>
  Effect.gen(function* () {
    const stateFile = `harness/${OPENCODE_DATABASE}`;
    const database = files.find((file) => file.path === stateFile);
    if (database === undefined || database.entry.kind !== "file") {
      return { state: "absent" } as const;
    }
    const wal = files.find((file) => file.path === `${stateFile}-wal`);
    if (database.entry.torn === true || wal?.entry.torn === true) {
      return { state: "torn" } as const;
    }
    const bytes = yield* readCaptureFileBytes(manifest, "workspace", stateFile);
    // A log that is there but cannot be read fails the read: the database without it can be
    // missing conversations, and a snapshot short of them would hand them to the next process.
    if (wal !== undefined && wal.entry.kind !== "file") {
      return yield* Effect.fail(new Error(`${wal.path} is not a file`));
    }
    const walBytes =
      wal === undefined ? null : yield* readCaptureFileBytes(manifest, "workspace", wal.path);
    return {
      state: "read",
      conversations: yield* readOpencodeConversations(bytes, walBytes),
    } as const;
  });

/**
 * The session line when an opencode launch could not read what its database held before it
 * started (`opencodeLaunchSnapshot`): nothing it starts can be told apart from what was there, so
 * resuming its conversation will be refused.
 */
const OPENCODE_SNAPSHOT_MISSING =
  "opencode · could not read its conversations before it started · this session's conversation may not be resumable";

/** Why a launch stops before the harness home relocation (`evictReservedSecretFiles`). */
const secretFilesNotSetAside = (why: string) =>
  new SealantPlatformError({
    code: "secret_files_not_set_aside",
    status: null,
    message: `a secret file under a directory sessions now save could not be taken out of it (${why}); the harness home was not moved, so nothing of it is saved`,
    cause: null,
  });

const promptArgv = (
  harness: string,
  prompt: string,
  options: { readonly model: string | null; readonly effort: EffortLevel | null } = {
    model: null,
    effort: null,
  },
): ReadonlyArray<string> | null => {
  const model = options.model === null ? "" : ` --model ${shellWord(options.model)}`;
  const effort =
    options.effort === null || !(HARNESS_EFFORTS[harness] ?? []).includes(options.effort)
      ? null
      : options.effort;
  const command = (() => {
    switch (harness) {
      case "claude":
        return `exec claude --dangerously-skip-permissions${model}${effort === null ? "" : ` --effort ${effort}`} "$prompt"`;
      case "codex":
        return `exec codex ${CODEX_DAEMON_OFF.join(" ")} -c features.memories=true --dangerously-bypass-approvals-and-sandbox${model}${effort === null ? "" : ` -c model_reasoning_effort=${effort}`} "$prompt"`;
      case "opencode":
        return `exec env '${OPENCODE_PERMISSION_ALLOW}' opencode${model} --prompt "$prompt"`;
      case "pi":
        return `exec pi --approve${model}${effort === null ? "" : ` --thinking ${effort}`} "$prompt"`;
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
    case "opencode":
    case "pi":
      // Baked into the unified image with every other agent CLI (Core 0.39): the shell's shape,
      // its credential ladder included, until each brings logins of its own.
      return platformShape("shell");
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
 * A terminal launch of a session whose saved state is its own harness's continues the
 * conversation that state names. One rule for every executor a launch can land in — a fresh one
 * or a lease holder's it joins — so the process row and the harness name the same conversation.
 * A protocol launch resumes through its own handshake and is left alone.
 */
const savedConversationArgv = (
  harness: string,
  manifest: HarnessStateManifest | null,
  protocolStart: LaunchStart | null,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  manifest !== null && manifest.harness === harness && protocolStart === null
    ? nativeResumeArgv(harness, manifest.providerSessionId, argv)
    : argv;

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
  // opencode reads its permissions from the environment; an argv that sets them itself (`env …`,
  // the composed `ask`) is left alone.
  if (harness === "opencode" && head === "opencode") {
    return ["env", OPENCODE_PERMISSION_ALLOW, ...argv];
  }
  // pi asks nothing per tool call; it does ask whether to trust the repository's own `.pi`
  // resources, which the user decided when they adopted it.
  if (
    harness === "pi" &&
    head === "pi" &&
    !argv.includes("--approve") &&
    !argv.includes("--no-approve")
  ) {
    return ["pi", "--approve", ...rest];
  }
  return argv;
};

/**
 * The harness's argv with its permission defaults, behind its first-run seed (`harness-seeds.ts`:
 * the seeds merge into the harness's own files and leave a file they cannot read as it is).
 */
const withHarnessBootstrap = (
  harness: string,
  argv: ReadonlyArray<string>,
  options: { readonly captured?: boolean } = {},
): ReadonlyArray<string> =>
  withHarnessSetup(harness, withPermissionDefaults(harness, argv), options);

/** What one memory delivery did, counted; a file it could not place is said by name. */
const logAgentMemoryDelivered = (
  sessionId: SessionId,
  outcomes: ReadonlyArray<{ readonly outcome: string; readonly path: string }>,
) => {
  const count = (outcome: string) => outcomes.filter((item) => item.outcome === outcome).length;
  return outcomes.length === 0
    ? Effect.void
    : Effect.logInfo("session engine: agent memory · delivered").pipe(
        Effect.annotateLogs({
          sessionId,
          written: count("written"),
          unchanged: count("unchanged"),
          leftAsTheSessionHasIt: count("left"),
          keptAside: count("kept"),
          errors: outcomes
            .filter((item) => item.outcome === "error")
            .map((item) => item.path)
            .join(", "),
        }),
      );
};

/**
 * Whether a flush answer says the home a memory hand-over moved is saved: caught up
 * (`captureCaughtUp`), a saved final, or caught up but for paths it could not read that all
 * lie outside the harness home's memory, every one of them named. A path that stays
 * unreadable for an executor's life (a file it may not open) would otherwise leave its
 * hand-over unsettled for good, and the launcher's memory credited to the previous person.
 */
const placesMemoryHome = (reading: CaptureReading, kind: CaptureFlushKind): boolean => {
  if (captureCaughtUp(reading) || (kind === "final" && captureSaved(reading))) return true;
  if (reading.unreadable === null || reading.unreadablePaths.length < reading.unreadable) {
    return false;
  }
  return (
    captureCaughtUp({ ...reading, unreadable: 0, unreadablePaths: [] }) &&
    unreadableOutsideMemory(reading.unreadablePaths)
  );
};

/** A hand-over that could not finish: the launch fails rather than start on another's memory. */
const notHandedOver = (message: string, cause: unknown) =>
  new SealantPlatformError({ code: "AGENT_MEMORY_NOT_HANDED_OVER", status: null, message, cause });

/** A pi profile directory kept aside, or one that could not be cleared, is said once. */
const logPiProfileVacated = (sessionId: SessionId, outcomes: ReadonlyArray<SkillsVacateOutcome>) =>
  Effect.forEach(
    outcomes,
    (outcome) => {
      switch (outcome.outcome) {
        case "kept":
          return Effect.logInfo(
            "session engine: pi profile · the directory held something else and was kept aside",
          ).pipe(Effect.annotateLogs({ sessionId, dir: outcome.dir, keptAt: outcome.detail }));
        case "error":
          return Effect.logWarning(
            "session engine: pi profile · the directory could not be cleared",
          ).pipe(Effect.annotateLogs({ sessionId, dir: outcome.dir, code: outcome.detail }));
        default:
          return Effect.void;
      }
    },
    { discard: true },
  );

/** A skill directory kept aside, or one that could not be cleared, is said once. */
const logSkillsVacated = (sessionId: SessionId, outcomes: ReadonlyArray<SkillsVacateOutcome>) =>
  Effect.forEach(
    outcomes,
    (outcome) => {
      switch (outcome.outcome) {
        case "kept":
          return Effect.logInfo(
            "session engine: skills · a replaced or retired skill directory was kept aside",
          ).pipe(Effect.annotateLogs({ sessionId, dir: outcome.dir, keptAt: outcome.detail }));
        case "error":
          return Effect.logWarning(
            "session engine: skills · a directory could not be cleared",
          ).pipe(Effect.annotateLogs({ sessionId, dir: outcome.dir, code: outcome.detail }));
        default:
          return Effect.void;
      }
    },
    { discard: true },
  );

/**
 * A project whose repository Mend does not support — SHA-256 objects (`unsupportedRepositoryReason`;
 * owner, 2026-09-28) — starts no session: one adopted before adoption refused it is refused here,
 * as a `GitError` whose `stderr` is the reason. A store git could not read is left to the step that
 * needs it, which says why.
 */
const refuseUnsupportedProject = (project: Project) =>
  unsupportedRepositoryReason(project.storePath).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.flatMap((reason) =>
      reason === null
        ? Effect.void
        : Effect.fail(
            new GitError({
              args: ["mend", "repository-format"],
              cwd: project.storePath,
              exitCode: null,
              stderr: reason,
            }),
          ),
    ),
  );

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
/** What the reaper writes when a lease lapsed and the platform no longer answers. */
const EXECUTOR_LOST_SUMMARY = "executor lost · lease expired";
/** The key an executor create is asked under: the session, when it was asked, a nonce. */
const executorCreateKeyFor = (sessionId: SessionId, askedAt: Date) =>
  `launch:${sessionId}:${askedAt.getTime()}:${crypto.randomUUID()}`;

/**
 * A standby executor's launch identity (cross-repo decision 5): minted with its pool row, before
 * its create, and asked as that create's idempotency key. One per physical standby: a pooled id
 * is never provisioned twice.
 */
const standbyLaunchIdOf = (entryId: string) => `standby:${entryId}`;
/** A platform lookup that failed answers nothing: the caller reads that as undecided. */
const noAnswer = () => Effect.succeed(null);

/** When a create under `key` was asked (`executorCreateKeyFor`); null for any other key. */
const createAskedAtOf = (key: string): Date | null => {
  const ms = Number(key.split(":")[2]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
};

/** A planned launch's opening prompt no process accepted yet: its plan stays. */
const OPENING_PROMPT_NOT_DELIVERED = "opening prompt not delivered";
/** How many launches a planned relaunch tries in one process before it only keeps its plan. */
const PLANNED_LAUNCH_ATTEMPTS = 3;
/** A launch whose executor was created but never reached its harness, with no words of its own. */
const LAUNCH_NEVER_RAN_SUMMARY = "launch failed · the harness never started";
/**
 * What a run left open under a session that moved on reads once the next run of the session
 * starts: its end was never recorded, and nothing of it is live (`createSessionRun`).
 */
const RUN_SUPERSEDED_SUMMARY = "end not recorded · superseded by the next run";
/** A settled session's status is one of the three outcomes; anything else is not settled. */
const settledOutcomeOfStatus = (status: SessionStatus): SessionOutcome | null =>
  status === "completed" || status === "failed" || status === "stopped" ? status : null;
/** A run insert refused over a run of the session that is still live (`createSessionRun`). */
const runActiveRefusal = (activeRun: SessionRun) =>
  new SealantPlatformError({
    code: "run_active",
    status: 409,
    message: `a run of this session is still open · ${activeRun.sealantRunId} · nothing started`,
    cause: null,
  });
/** Every summary a launch that did not start leaves begins with this. */
const LAUNCH_SUMMARY_PREFIX = "launch ";
/**
 * Summaries about an earlier executor that a launch which starts clears (e2e8 (i): B, U, WU, G,
 * G34 read `running` beside them after a resume): what an earlier launch that never started left,
 * and Mend's verdict on how an earlier executor ended (`stopped outside Mend · saved at …`,
 * `saved at …`, `executor not answering · …`). `executor lost · …` stays: a replacement's first
 * register turns it into `picked up · executor replaced` (`observeReplacement`).
 */
/**
 * The custom image's setup commands were not run: the executor laid the worktree down from saved
 * capture `n`, which already holds what they produced (review 2026-09-28 (15) #1).
 */
const SETUP_SKIPPED_PREFIX = "setup skipped";
const setupSkippedWords = (n: number) => `${SETUP_SKIPPED_PREFIX} · restored from capture ${n}`;
/**
 * No dependency install ran: the head's manifest could not be read, so nothing says this
 * executor's platform lacks a restored tree (review 2026-09-28 (16) #1). A read that observed
 * nothing is not evidence that nothing was restored.
 */
const DEPENDENCY_INSTALL_SKIPPED_PREFIX = "dependency install skipped";
const dependencyInstallSkippedWords = (n: number) =>
  `${DEPENDENCY_INSTALL_SKIPPED_PREFIX} · capture ${n} manifest unavailable`;

/**
 * Said once, as the launch starts, when a secret file (docs/adr/0010) was not written: the path
 * and the reason the workspace gave, so a session that then lacks `~/.aws/credentials` says why.
 */
const SECRET_FILES_SUMMARY_PREFIX = "secret files";
const secretFilesRefusedWords = (refused: ReadonlyArray<SecretFileOutcome>) =>
  `${SECRET_FILES_SUMMARY_PREFIX} · ${refused.length} not written · ${refused
    .map((outcome) => `~/${outcome.path} · ${outcome.reason ?? "refused"}`)
    .join(" · ")}`;

const STALE_ON_START_PREFIXES = [
  LAUNCH_SUMMARY_PREFIX,
  "stopped outside Mend",
  "saved at ",
  "executor not answering",
  SETUP_SKIPPED_PREFIX,
  DEPENDENCY_INSTALL_SKIPPED_PREFIX,
  SECRET_FILES_SUMMARY_PREFIX,
] as const;

/** A create Core fenced before it made anything, found with no launch asking again. */
const LAUNCH_CANCELLED_SUMMARY = "launch cancelled · nothing was created";
/**
 * A launch whose create answer was lost, whose executor Mend found by its key and drained, and
 * which then ended (terminated, or found gone): nothing runs and nothing launches (e2e8 (i)).
 */
const LAUNCH_INTERRUPTED_SUMMARY =
  "launch interrupted · the create's answer was lost · its executor ended";
/**
 * The same launch while its executor's end is not observed: the platform took the stop and still
 * reports the executor (review 2026-09-28 (19) #2). The session reads `stopping` with these words
 * and keeps its row and lease; the reaper settles it `LAUNCH_INTERRUPTED_SUMMARY` once the platform
 * reports the executor gone.
 */
const LAUNCH_STOP_UNOBSERVED_SUMMARY =
  "launch interrupted · the create's answer was lost · stop requested · end not observed yet";
/**
 * A summary without the plan notice appended to it (`noteCapturePlan`): what it said before a plan
 * waited or was refused; null when the notice was all it said.
 */
const withoutPlanNotice = (summary: string | null): string | null => {
  if (summary === null) return null;
  for (const prefix of [PLAN_WAITING_PREFIX, PLAN_BLOCKED_PREFIX]) {
    if (summary.startsWith(prefix)) return null;
    const at = summary.indexOf(` · ${prefix}`);
    if (at >= 0) return summary.slice(0, at);
  }
  return summary;
};

/** Every "executor lost" summary starts with this; a replacement's first word ends it. */
const EXECUTOR_LOST_PREFIX = "executor lost";
/** How many looks an agent's end gets at an executor that stops answering before it is judged. */
const EXECUTOR_END_LOOKS = 6;
/**
 * How old a FINAL answer may be and still stand for a new one (`recentFinals`): an executor sent a
 * final flush admits nothing, so nothing on its disk moves in between.
 */
const FINAL_ANSWER_REUSE_MS = 5_000;

/**
 * What a drain said of its executor, for the work a Stop put off until the drain's final flush
 * (ADR 0002 decision 50): its last reading; `refused` when the executor answered nothing;
 * `sealed` when the store's seal stood for a lost answer; `none` when nothing drained.
 */
type DrainWord = CaptureReading | "refused" | "none" | "sealed";

/** What a drain's word says for a checkpoint put off until it; undefined asks a flush. */
const observedOf = (reading: DrainWord): CaptureFlushObservation | undefined =>
  reading === "none"
    ? undefined
    : reading === "sealed" || (reading !== "refused" && captureCaughtUp(reading))
      ? "flushed"
      : "incomplete";

/** Whether a harvest put off until the drain may read the head; null asks a flush. */
const harvestReadyOf = (reading: DrainWord): boolean | null =>
  reading === "none"
    ? null
    : reading === "sealed" || (reading !== "refused" && captureHarvestReady(reading));

/** What a round of a kept drain read: the reason, what was pending, what was refused. */
const keptDrainReading = (session: Session) =>
  JSON.stringify([
    session.captureDrain,
    session.sealantWorkspaceId,
    session.captureIncompleteReason,
    session.capturePending,
    session.capturePendingBytes,
    session.captureRefused,
  ]);
/** What replaces it once the replacement executor's first heartbeat or register lands. */
const EXECUTOR_REPLACED_SUMMARY = "picked up · executor replaced";
/**
 * How long a checkpoint waits for the lease holder's `capture.flush` before it observes whatever
 * head is registered: a full ship of a large small-class delta, not a cadence window.
 */
const CHECKPOINT_FLUSH_TIMEOUT = Duration.seconds(20);
/** A status read reads a counter; it never waits on a ship. */
const CAPTURE_STATUS_TIMEOUT = Duration.seconds(10);
/** A landing asks the executor this many times for its captures before it says they are behind. */
const LANDING_FLUSH_ATTEMPTS = 4;
const LANDING_FLUSH_PAUSE = Duration.seconds(2);
/**
 * How long a claimed standby's `capture.replan` may take before the launch goes cold: a delta
 * materialise of the head over the project base (the base itself is already on disk).
 */
const STANDBY_REPLAN_TIMEOUT = Duration.minutes(3);

const SUPERVISE_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.min(Duration.fromInputUnsafe(delay), Duration.seconds(30))),
  ),
);

/** Workspace statuses a hot entry can still serve from; anything else drains it. */
/** What the platform says of one workspace (`lookupWorkspace`). */
type WorkspaceLookup =
  | { readonly kind: "found"; readonly workspace: Workspace; readonly status: string }
  | { readonly kind: "kept"; readonly workspace: Workspace; readonly status: string }
  | { readonly kind: "gone"; readonly status: string }
  | { readonly kind: "unknown"; readonly error: string };

/**
 * The drain states Core records once a capture executor's drain is over and nothing of it is kept
 * (`WorkspaceCaptureDrain.state`, Core's next SDK): removed after its drain, saved, gone, or its
 * unsaved captures discarded by the owner.
 */
const ENDED_DRAIN_STATES: ReadonlySet<string> = new Set(["stopped", "saved", "gone", "discarded"]);

const workspaceIsLive = (status: string) =>
  status === "queued" || status === "running" || status === "ready";

/**
 * The platform positively says there is no such workspace (a 404, or the contract's
 * `WorkspaceNotFoundError`). Every other failure is only a failure to answer.
 */
const workspaceMissing = (error: unknown): boolean => {
  if (error instanceof SealantPlatformError) {
    return error.status === 404 || error.code === "WorkspaceNotFoundError";
  }
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
};

/** Hidden shell sessions created by the retired desktop bench path. */
const isLegacyBench = (session: Session): boolean =>
  session.harness === "shell" && session.label === "bench";

/**
 * An ENGINE-launched agent row — one whose transcript writes are the engine's own work. An
 * open-workbench shell (kind agent-pty, harness "shell") writes no transcripts itself; it is
 * where external agents run, never a reason for the observer to look away.
 */
const isEngineAgentProcess = (row: SessionProcess): boolean =>
  row.kind !== "agent-external" && isAgentProcessKind(row.kind) && row.harness !== "shell";

export interface ProvisionInput {
  readonly projectId: ProjectId;
  readonly harness: string;
  readonly label: string | null;
  /**
   * Names the worktree. An existing name JOINS that worktree — a new
   * conversation inside it; an unused name creates it (branch `mend/<name>`);
   * null derives an anonymous worktree identity.
   */
  readonly name: string | null;
  /** Branch or sha to base the worktree on; null = the project's default branch. */
  readonly base: string | null;
  /** Who is provisioning — whose dotfiles apply at launch. Null when the caller is unknown. */
  readonly ownerUserId: string | null;
  /** Where the session was started from (docs/adr/0006-slack.md); absent is `mend`. */
  readonly origin?: SessionOrigin;
  /**
   * The session's own "Land when a turn completes" (docs/adr/0007-landing.md); absent or null
   * follows the project.
   */
  readonly autoLand?: boolean | null;
}

/** Anonymous worktrees are keyed by their own id, named ones by the name. */
/** Where a linked project is bound inside the workspace (ADR-0001). */
export const linkedProjectMountPath = (name: string) => `/workspace/repos/${name}`;
/** The worktree's `mend.toml` as a workspace sees it. */
export const WORKSPACE_MEND_TOML = "/workspace/repo/mend.toml";
/** The read script's exit code for "no mend.toml": distinct from `cat`'s own failures. */
const WORKSPACE_MEND_TOML_ABSENT = 44;
const isLinkedProjectMountPath = (mountPath: string) => mountPath.startsWith("/workspace/repos/");

const worktreeIdentityFor = (worktreeId: WorktreeId, name: string | null) =>
  name === null
    ? { directory: `wt-${worktreeId}`, branch: `mend/wt/${worktreeId}` }
    : { directory: name, branch: `mend/${name}` };

/** A supporting process needs a current reachable workspace. */
export class SessionNotLiveError extends Schema.TaggedErrorClass<SessionNotLiveError>()(
  "SessionNotLiveError",
  {
    sessionId: Schema.String,
  },
) {}

/**
 * "Discard unsaved and stop" asked of a session with no drain under way: there is nothing
 * unsaved Mend is holding a workspace for. A plain stop is the verb.
 */
/**
 * A discard, as it went: the session after it, what Mend knew when it was asked
 * (`CaptureDiscardFacts`, the audit's substance), and when the workspace's end was observed.
 */
export interface CaptureDiscardResult {
  readonly session: Session;
  readonly facts: CaptureDiscardFacts;
  readonly discardedAt: Date;
}

export class NothingUnsavedError extends Schema.TaggedErrorClass<NothingUnsavedError>()(
  "NothingUnsavedError",
  { sessionId: Schema.String },
) {}

/**
 * What a relaunch launches once its old executor has drained, kept beside the drain so a restart
 * in between finishes it (`SessionsRepo.planRelaunch`):
 * - `resume`: a plain resume with the harness (or `shell`); nothing was asked of the agent;
 * - `launch`: the exact launch that was asked — its argv (a PTY follow-up's prompt rides in it),
 *   the protocol start with its opening prompt, who asked, and the correlation id the process and
 *   the opening turn carry, so the launch and its opening turn happen exactly once.
 */
const RelaunchStart = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["pty", "protocol"])),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.optional(Schema.Literals(PERMISSION_MODES)),
  speed: Schema.optional(Schema.Literals(SPEED_MODES)),
});
const RelaunchPlan = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("resume"), harness: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("launch"),
    argv: Schema.Array(Schema.String),
    launchCorrelationId: Schema.String,
    start: Schema.NullOr(RelaunchStart),
    author: Schema.NullOr(Schema.String),
    resumeId: Schema.NullOr(Schema.String),
  }),
]);
type RelaunchPlan = typeof RelaunchPlan.Type;
const RelaunchPlanJson = Schema.fromJsonString(RelaunchPlan);
const encodeRelaunchPlan = Schema.encodeSync(RelaunchPlanJson);
const decodeRelaunchPlan = Schema.decodeUnknownOption(RelaunchPlanJson);

/** An exit that is nothing but an interruption: a shutdown, not an outcome. */
const interruptedOnly = <A, E>(exit: Exit.Exit<A, E>): boolean =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

/**
 * A launch asked while a previous executor still has to drain: a `launch` plan when anything was
 * asked of the agent (a correlation id, a protocol start), else a plain `resume`.
 */
const relaunchPlanOf = (input: {
  readonly harness: string;
  readonly argv: ReadonlyArray<string>;
  readonly hasNativeImport: boolean;
  readonly launchCorrelationId: string | null;
  readonly start: LaunchStart | null;
  readonly author: string | null;
  readonly resumeId: string | null;
}): RelaunchPlan => {
  const resume: RelaunchPlan = {
    kind: "resume",
    harness: input.argv[0] === "bash" ? "shell" : input.harness,
  };
  if (input.hasNativeImport) return resume;
  if (input.launchCorrelationId === null && input.start === null) return resume;
  return {
    kind: "launch",
    argv: [...input.argv],
    launchCorrelationId: input.launchCorrelationId ?? `relaunch:${crypto.randomUUID()}`,
    start: input.start,
    author: input.author,
    resumeId: input.resumeId,
  };
};

/** A stored plan; a bare harness is a `resume` of it (the first shape 0077 stored). */
const readRelaunchPlan = (stored: string): RelaunchPlan =>
  Option.getOrElse(
    decodeRelaunchPlan(stored),
    (): RelaunchPlan => ({
      kind: "resume",
      harness: stored,
    }),
  );

/**
 * A landing asked for the worktree as its executor holds it now, and the registered captures did
 * not catch up (`SessionEngine.landingCheckpoint`): the flush was refused, timed out or partial,
 * or nobody could say whether an executor still holds work. Nothing was checkpointed or landed.
 */
export class CapturesBehindError extends Schema.TaggedErrorClass<CapturesBehindError>()(
  "CapturesBehindError",
  { worktreeId: Schema.String, attempts: Schema.Int },
) {}

/**
 * Joining an existing worktree with a different base is refused — a durable
 * worktree is never silently re-based. Drop the base to join as it stands.
 */
export class WorktreeBaseConflictError extends Schema.TaggedErrorClass<WorktreeBaseConflictError>()(
  "WorktreeBaseConflictError",
  {
    worktreeId: Schema.String,
    name: Schema.String,
    requestedBase: Schema.String,
    baseRef: Schema.NullOr(Schema.String),
  },
) {}

/** A retired hidden bench remains reviewable but cannot start more work. */
export class LegacyBenchReadOnlyError extends Schema.TaggedErrorClass<LegacyBenchReadOnlyError>()(
  "LegacyBenchReadOnlyError",
  { sessionId: Schema.String },
) {}

/** The session's harness cannot continue in the requested mode (claude and codex only). */
export class HandoffUnsupportedError extends Schema.TaggedErrorClass<HandoffUnsupportedError>()(
  "HandoffUnsupportedError",
  {
    sessionId: Schema.String,
    harness: Schema.String,
    to: Schema.String,
  },
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
 * the queue-era run starter (docs/archive/M0-INVENTORY.md), rewired onto sessions and
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
/**
 * What a capture flush came to (`SessionEngine.flushCaptures`): `flushed` when the executor
 * shipped and registered everything it held; `none` when it is known that no executor holds
 * anything more (the store is co-located, the worktree was never claimed, its holder was released
 * after it ended, or the platform confirmed the holder ended), so the registered head is all there
 * is; `incomplete` when the flush was refused, timed out or was partial — and whenever nobody can
 * say (a lapsed lease whose executor may still run, a holder being launched, a lookup that failed).
 * Unknown is never `none`.
 */
export type CaptureFlushObservation = "flushed" | "none" | "incomplete";

/**
 * What keeps a worktree's durable identity (its rows, lease and chain) from being removed in
 * capture mode (`SessionEngine.captureHolds`): an executor that may still hold work not yet saved.
 * `saving` a drain is under way; `not-saved` a drain stopped moving and kept its workspace;
 * `executor` a workspace the platform still reports up, or did not answer for; `lease` an
 * executor's lease, live or lapsed without a confirmed end.
 */
export interface CaptureHold {
  readonly sessionId: SessionId | null;
  readonly kind: "saving" | "not-saved" | "executor" | "lease";
}

const sessionsWord = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/** `saving · 2 sessions · not saved · 1 session`: what holds a removal, in the status words. */
export const captureHoldWords = (holds: ReadonlyArray<CaptureHold>): string => {
  const count = (kind: CaptureHold["kind"]) => holds.filter((hold) => hold.kind === kind).length;
  const parts: Array<string> = [];
  if (count("saving") > 0) parts.push(`saving · ${sessionsWord(count("saving"))}`);
  if (count("not-saved") > 0) {
    parts.push(`not saved · ${sessionsWord(count("not-saved"))} · workspace kept`);
  }
  if (count("executor") > 0) {
    parts.push(`executor not ended · ${sessionsWord(count("executor"))}`);
  }
  if (count("lease") > 0) parts.push("executor lease held");
  return parts.join(" · ");
};

/** Why a repository was not added; `message` is what the person reads. */
export class RepositoryAddError extends Schema.TaggedErrorClass<RepositoryAddError>()(
  "RepositoryAddError",
  {
    sessionId: SessionId,
    reason: Schema.Literals([
      "own-project",
      "unknown-project",
      "not-visible",
      "bad-name",
      "name-taken",
      "worktree-taken",
      "no-origin",
      "not-live",
    ]),
    message: Schema.String,
  },
) {}

export class SessionEngine extends Context.Service<
  SessionEngine,
  {
    readonly provision: (
      input: ProvisionInput,
    ) => Effect.Effect<Session, ProjectNotFoundError | GitError | WorktreeBaseConflictError>;
    /**
     * The container half of provisioning: return the named worktree (join) or
     * create it — git worktree, row, ordinal-0 checkpoint, change row. A
     * worktree with zero sessions is a legal durable place.
     */
    readonly ensureWorktree: (
      projectId: ProjectId,
      input: { readonly name: string | null; readonly base: string | null },
      /** Whose git credential freshens the base (their Mend key, or their bridge). */
      ownerUserId: string | null,
    ) => Effect.Effect<Worktree, ProjectNotFoundError | GitError | WorktreeBaseConflictError>;
    /** A new conversation inside an existing worktree. */
    readonly provisionSessionIn: (
      worktreeId: WorktreeId,
      input: {
        readonly harness: string;
        readonly label: string | null;
        readonly ownerUserId: string | null;
        readonly origin?: SessionOrigin;
        readonly autoLand?: boolean | null;
      },
    ) => Effect.Effect<Session, WorktreeNotFoundError | ProjectNotFoundError | GitError>;
    readonly attachRun: (
      sessionId: SessionId,
      sealantRunId: SealantRunId,
      workspaceId: SealantWorkspaceId,
    ) => Effect.Effect<void, SessionNotFoundError>;
    /**
     * Run `effect` for as long as the engine runs, not as long as its caller: a caller that goes
     * away (a client that disconnected, an answer window that passed) leaves it running, and the
     * engine's shutdown interrupts it. The fiber is returned to join or to leave.
     */
    readonly detach: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>>;
    /**
     * Whether a launch verb (launch, resume, handoff, follow-up) is under way for the session in
     * this process. A resumed session keeps its settled row until its agent runs; the API reads
     * it as `starting` meanwhile, and a second launch verb is refused (`session_starting`).
     */
    readonly launchUnderWay: (sessionId: SessionId) => boolean;
    /**
     * The supervised launch (SDK 0.7.0): a workspace mounting the session's
     * worktree, an interactive PTY session running `argv` inside it, and
     * supervision attached — the record begins here. Every launch verb runs detached from its
     * caller (`detach`): a caller that goes away mid-launch never cuts it between the agent's
     * start and its process row (alpha 2026-09-30: a session whose agent ran read `starting`).
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
    /**
     * Cross-mode pickup (mode handoff): end the live agent in the OTHER mode,
     * backfill PTY-era history from the native transcript into the durable
     * conversation, and continue the same provider session in the requested
     * mode. Idempotent when already live in that mode; a settled session
     * degrades to a mode-aware resume.
     */
    readonly handoff: (
      sessionId: SessionId,
      to: "protocol" | "pty",
      start: LaunchStart,
      author: string | null,
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
      | ProtocolHarnessUnsupportedError
      | HandoffUnsupportedError
    >;
    /**
     * Put one pasted image where the session's harness reads it, and answer the path the terminal
     * pastes. Co-located: into the mounted harness home on this machine (before a launch too).
     * Capture mode mounts nothing, so the bytes go into the live workspace's harness home through
     * exec; with no live workspace the answer is `SessionNotLiveError`.
     */
    readonly storePastedImage: (
      sessionId: SessionId,
      bytes: Uint8Array,
    ) => Effect.Effect<
      PlacedPastedImage,
      | SessionNotFoundError
      | SessionNotLiveError
      | ProjectNotFoundError
      | PastedImageError
      | SealantPlatformError
    >;
    /** The repositories the session holds beside its own worktree (docs/adr/0010). */
    readonly listRepositories: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionRepositoryRow>, SessionNotFoundError>;
    /**
     * The projects the session may add as repositories: its organization's projects its owner can
     * see, less its own project and the ones it already holds.
     */
    readonly addableProjects: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<AddableProject>, SessionNotFoundError | ProjectNotFoundError>;
    /**
     * Add a project of the store as a repository of the session (docs/adr/0010): a worktree of
     * that project, named after the session's own worktree unless `worktree` says, at
     * `/workspace/repos/<name>`. The row answers at once in state `adding`; the files are brought
     * into the live workspace in the engine's lifetime, and the row reads `ready` or `failed`
     * with the reason once that is done. Refusals name their reason in the person's words.
     */
    readonly addRepository: (
      sessionId: SessionId,
      input: {
        readonly project: string;
        /** The directory name under `/workspace/repos/`; the project's name when null. */
        readonly name: string | null;
        /** The worktree to make in the project; the session's own worktree name when null. */
        readonly worktree: string | null;
      },
    ) => Effect.Effect<
      SessionRepositoryRow,
      | SessionNotFoundError
      | ProjectNotFoundError
      | RepositoryAddError
      | GitError
      | WorktreeBaseConflictError
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
    /**
     * Launch the exact approved Review instruction with a durable process correlation. `author`
     * is who sent the review comments: the turn is theirs, so automatic landing (docs/adr/0007)
     * never takes it for the owner's unless it is.
     */
    readonly launchFollowUp: (
      sessionId: SessionId,
      instruction: string,
      launchCorrelationId: string,
      author: string | null,
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
     * hot-sessions count itself, the image, dotfiles, skills, env, secrets, references, or mounts.
     */
    readonly reconcileHotSessions: (projectId: ProjectId) => Effect.Effect<void>;
    /** Snapshot the worktree now — review-open and user-mark come through here. */
    readonly checkpointNow: (
      sessionId: SessionId,
      trigger: CheckpointTrigger,
    ) => Effect.Effect<Checkpoint, SessionNotFoundError | ProjectNotFoundError | GitError>;
    /**
     * A landing's checkpoint (docs/adr/0007-landing.md, step 1): in capture mode taken only once
     * the executor's captures caught up — a flush that registered what it holds, or a known
     * absence of anything more — and refused with `CapturesBehindError` otherwise, never taken
     * from a stale head. `captureId` is the capture it was derived from (null co-located): the
     * landing reads that capture and nothing newer.
     */
    readonly landingCheckpoint: (
      sessionId: SessionId,
      trigger: CheckpointTrigger,
    ) => Effect.Effect<
      { readonly checkpoint: Checkpoint; readonly captureId: string | null },
      SessionNotFoundError | ProjectNotFoundError | GitError | CapturesBehindError
    >;
    /**
     * Ask the executor holding the session's worktree to ship and register what its disk holds
     * (`capture.flush`), once any checkpoint under way has finished, and say what was observed.
     * Automatic landing asks before it reads a turn's change, so a stale head is neither landed
     * nor called empty (docs/adr/0007-landing.md, "When a completed turn lands").
     */
    readonly flushCaptures: (
      sessionId: SessionId,
      why: string,
    ) => Effect.Effect<CaptureFlushObservation, SessionNotFoundError>;
    /**
     * The user's stop: end every live agent process (close its PTY, settle its run). Shells
     * survive a stop that ended a live agent — you may be sitting in one — and the session
     * reads `idle` while they hold the workspace; a stop with NO live agent left is aimed at
     * the session itself and closes the shells too, so an orphan shell can never hold a
     * stopped session open. Services keep their own lifecycle; `stopServices` is their verb.
     * `summary` is what the settled session reads instead of the harness's own; the idle stop
     * passes `idle · stopped after 15 min · reply to resume`.
     */
    readonly stop: (
      sessionId: SessionId,
      summary?: string | null,
    ) => Effect.Effect<void, SessionNotFoundError>;
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
    /**
     * The session's declared Services: its worktree's `mend.toml` plus the project's recipes.
     * The file is read beside the worktree when this deployment co-locates it, else from the
     * session's live workspace (capture mode); with no live workspace there the file is not
     * observable and only the project's recipes answer.
     */
    readonly listServiceRecipes: (
      sessionId: SessionId,
    ) => Effect.Effect<
      ReadonlyArray<ServiceRecipe>,
      SessionNotFoundError | ProjectNotFoundError | RecipeFileError | SealantPlatformError
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
     * Stop every live Service of the session — the action beside a stopped agent whose Services
     * keep the workspace up (docs/SESSION-SERVICES.md). Each goes as `stopService` goes; once
     * nothing is live the workspace ends as after any last lease. Answers how many it stopped.
     */
    readonly stopServices: (sessionId: SessionId) => Effect.Effect<number, SessionNotFoundError>;
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
     * One observation pass for external agents: a coding agent the user runs by hand (mend
     * shell, SSH, editor terminal) writes through the mounted harness home, and fresh
     * transcript writes become observed `agent-external` process rows — ended again when the
     * writes go quiet. Runs on its own heartbeat; exposed for deterministic ticks.
     */
    readonly observeExternalAgents: () => Effect.Effect<void>;
    /**
     * Capture mode's lease reaper tick (ADR-0002 "Replacement and pickup"): an expired lease
     * whose executor the platform no longer answers for settles its session honestly; a live
     * lease past the replacement age is replaced. A no-op under the co-located store; runs on
     * its own 10 s heartbeat, exposed for deterministic ticks.
     */
    readonly reapCaptureLeases: () => Effect.Effect<void>;
    /**
     * The owner's "discard unsaved and stop" (docs/adr/0002, "Stop drains, then terminates"):
     * the one act that ends a workspace while captures are still pending. Only for a session
     * with a drain under way (`NothingUnsavedError` otherwise); the caller confirms and audits.
     */
    readonly discardUnsavedAndStop: (
      sessionId: SessionId,
      /** Who discarded it (the owner's display name), kept on the session's line. */
      discardedBy?: string | null,
    ) => Effect.Effect<
      CaptureDiscardResult,
      SessionNotFoundError | NothingUnsavedError | SealantPlatformError
    >;
    /**
     * Capture mode: read the session's running executor's capture status (nothing flushed) and
     * record it — a snap that is failing reads `capture failing since … · <error>` on every
     * surface. At most once per `statusMinInterval` per session; skipped outside capture mode,
     * for a session that does not hold its worktree, and while a drain runs. The reaper does the
     * same on its own every `statusInterval`; this is the read a client's view asks for. Returns
     * at once; the read runs in the engine's scope.
     */
    readonly refreshCaptureStatus: (sessionId: SessionId) => Effect.Effect<void>;
    /**
     * Capture mode: flush the session's own executor and answer what it still holds, recorded on
     * the session. Null outside capture mode, when the session does not hold its worktree, or
     * when nobody answered.
     */
    readonly readCaptures: (
      sessionId: SessionId,
    ) => Effect.Effect<CaptureReading | null, SessionNotFoundError>;
    /**
     * Remove the session row once its workspace has gone: at once when it has no workspace or
     * the platform already ended it (`removed`); otherwise the request is recorded and the sweep
     * removes the row after the workspace goes — after its drain, in capture mode (`pending`).
     */
    readonly removeWhenStopped: (
      sessionId: SessionId,
    ) => Effect.Effect<"removed" | "pending", SessionNotFoundError>;
    /**
     * Capture mode: what still holds the worktree's durable identity (`CaptureHold`). A removal
     * that deletes rows goes only when this is empty — once every drain saved and every executor
     * was observed ended — or after the owner's "discard unsaved and stop". Empty co-located.
     */
    readonly captureHolds: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<CaptureHold>>;
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
  | CaptureRuntime
  | CaptureDrainPolicy
  | SessionChannelTokensRepo
  | DeploymentConfig
  | AgentConversationRepo
  | ProtocolHost
  | SessionsRepo
  | HotWorkspacesRepo
  | UserDotfilesRepo
  | UserGitAuthorRepo
  | DotfilesStore
  | DotfilesCloner
  | SkillsRepo
  | PiProfilesRepo
  | AgentMemoryRepo
  | SecretFilesRepo
  | SessionRunsRepo
  | SessionProcessesRepo
  | ServicesRepo
  | ServiceForwardsRepo
  | ServiceObservationsRepo
  | ServiceHost
  | SessionSocketHost
  | ProjectsRepo
  | WorktreeChangesRepo
  | WorktreesRepo
  | CheckpointsRepo
  | ReferencesRepo
  | ProjectMountsRepo
  | ProjectLinksRepo
  | SessionRepositoriesRepo
  | OrganizationsRepo
  | FoldersRepo
  | ProjectClusterBindingsRepo
  | ProjectEnvironmentRepo
  | ProjectSecretsRepo
  | SecretCipher
  | ProjectServiceRecipesRepo
  | SettingsRepo
  | SessionRepository
  | SessionGitOpsRepo
  | MendKeys
  | AgentBridge
  | SourcePolicy
  | WorkspaceGitHooks;

/**
 * The executor answered an ask: its evidence fence now clears only with a publication (review
 * 2026-09-28 (8) #4).
 */
const markAnswered = (fence: { answered: boolean }) =>
  Effect.sync(() => {
    fence.answered = true;
  });

/** A log about evidence: its failure is its own, never the evidence's. */
const evidenceLog = (log: Effect.Effect<void>) => log.pipe(Effect.catchCause(() => Effect.void));

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
        runService: (argv, port, name, protocol, browserScheme) =>
          owned(sessionId)(api.runService(argv, port, name, protocol, browserScheme)),
        addService: (port, name, protocol, browserScheme) =>
          owned(sessionId)(api.addService(port, name, protocol, browserScheme)),
        stopService: (reference) => owned(sessionId)(api.stopService(reference)),
        restartService: (reference) => owned(sessionId)(api.restartService(reference)),
        stopSession: () => owned(sessionId)(api.stopSession()),
        land: () => owned(sessionId)(api.land()),
        listRepositories: () => owned(sessionId)(api.listRepositories()),
        addableProjects: () => owned(sessionId)(api.addableProjects()),
        addRepository: (input) => owned(sessionId)(api.addRepository(input)),
        gitTransport: (input) => owned(sessionId)(api.gitTransport(input)),
        gitTransportDone: (opId, exitCode, refUpdates) =>
          owned(sessionId)(api.gitTransportDone(opId, exitCode, refUpdates)),
        // The capture routes pass through as they are, the launch-bound ones included: the
        // network channel serves a token only the routes of the launch it was issued for
        // (cross-repo decision 5, review 2026-09-28 (4) #10).
        ...(api.capture === undefined ? {} : { capture: api.capture }),
        ...(api.captureAs === undefined ? {} : { captureAs: api.captureAs }),
      });
      const conversations = yield* AgentConversationRepo;
      const channelTokens = yield* SessionChannelTokensRepo;
      const deployment = yield* DeploymentConfig;
      if (deployment.mode === "kubernetes" && deployment.sessionEndpoint === undefined) {
        return yield* Effect.die(
          "MEND_DEPLOYMENT_MODE=kubernetes requires MEND_SESSION_ENDPOINT_LISTEN / _URL on the session worker — a workspace Pod on another node cannot reach a Unix socket, so without the network channel every session would be unreachable.",
        );
      }
      // The capture store (ADR-0002, the default since decision 8): the executor materialises
      // the worktree from the bucket and ships captures back over the network channel, so the
      // channel must exist. `capture === null` is the deprecated co-located store.
      const captureRuntime = yield* CaptureRuntime;
      const captureStoreOn = deployment.sessionStore === "captured";
      if (captureStoreOn && deployment.sessionEndpoint === undefined) {
        return yield* Effect.die(
          "The capture store (the default; MEND_SESSION_STORE unset or `captured`) requires MEND_SESSION_ENDPOINT_LISTEN / _URL — the executor reaches the capture routes over the network session channel, never a socket. DEVELOPMENT.md §Environment names the values for this machine.",
        );
      }
      if (captureStoreOn && !captureRuntime.enabled) {
        return yield* Effect.die(
          "The capture store is selected but the capture runtime was not provided to the session engine.",
        );
      }
      const capture = captureStoreOn && captureRuntime.enabled ? captureRuntime : null;
      const drainPolicy = yield* CaptureDrainPolicy;
      // The store's sealed record of a completed final flush (`CaptureSeals`). Nothing provided
      // reads as no seal recorded: nothing is ever saved on a seal Mend cannot read.
      const seals: CaptureSeals["Service"] = Option.getOrElse(
        yield* Effect.serviceOption(CaptureSeals),
        () => ({ sealedCompletion: () => Effect.succeed(null) }),
      );

      // ── Capture mode (ADR-0002) ─────────────────────────────────────────────────
      /**
       * The create-request half of a capture launch: the `capture` source carrying the session
       * channel token (sealed by Core into the boot env file as `SEALANT_CAPTURE_TOKEN`). Null
       * under the co-located store.
       */
      /**
       * What the daemon is told about dialling the channel and the object store (sealantd
       * ADR-0015 "Transport"). Only what the operator stated goes over: without a statement the
       * daemon requires verified HTTPS and refuses to boot otherwise, and Mend does not soften
       * that on its own. `MEND_EXECUTOR_NETWORK=private` is the statement for a plain-HTTP channel.
       */
      const captureTransport = (): Pick<WorkspaceCaptureSource, "transport"> => {
        const stated = deployment.executorTransport;
        if (stated === undefined) return {};
        const transport = {
          ...(stated.plaintext ? { plaintext: true } : {}),
          ...(stated.channelCaPem === undefined ? {} : { channelCaPem: stated.channelCaPem }),
          ...(stated.objectCaPem === undefined ? {} : { objectCaPem: stated.objectCaPem }),
        };
        return Object.keys(transport).length === 0 ? {} : { transport };
      };

      const captureSourceFor = (
        sessionId: SessionId,
        secretEnv: Record<string, string>,
      ): Effect.Effect<{ readonly source: WorkspaceCaptureSource } | null> =>
        Effect.gen(function* () {
          if (capture === null) return null;
          const endpoint = deployment.sessionEndpoint;
          const token = secretEnv["MEND_SESSION_TOKEN"];
          if (endpoint === undefined || token === undefined) {
            return yield* Effect.die("capture mode: a launch needs the session channel token");
          }
          const session = yield* sessions.byId(sessionId).pipe(Effect.option);
          if (Option.isNone(session)) {
            // A standby executor: no worktree yet, so none is named — the daemon takes the
            // placeholder from the channel's plan answer, and its replan at claim takes the
            // worktree (`hot-pool.ts` "Capture-mode standby").
            const entry = yield* hotWorkspaces.byId(sessionId);
            if (entry === null) {
              return yield* Effect.die(
                "capture mode: a workspace needs its session row or its standby row",
              );
            }
            return {
              source: {
                kind: "capture",
                endpoint: endpoint.url,
                token,
                harnessHome: HARNESS_HOME_MOUNT_PATH,
                ...captureTransport(),
              },
            };
          }
          return {
            source: {
              kind: "capture",
              endpoint: endpoint.url,
              worktreeId: session.value.worktreeId,
              token,
              harnessHome: HARNESS_HOME_MOUNT_PATH,
              ...captureTransport(),
            },
          };
        });

      /**
       * Capture 0 for a worktree that has no chain yet: one made before captures (the deprecated
       * co-located store, or an install upgraded across decision 8) is attached now, so capture 0
       * carries its directory's current files (ADR-0002 "Consequences", amended). A no-op once
       * the chain has a head, and under the co-located store.
       */
      const ensureCaptureZero = Effect.fn("SessionEngine.ensureCaptureZero")(function* (
        projectId: ProjectId,
        worktreeId: WorktreeId,
      ) {
        if (capture === null || sessionRepo.attachWorktree === undefined) return;
        const chain = yield* capture.repo.headOf(worktreeId);
        if (chain?.head !== null && chain?.head !== undefined) return;
        yield* sessionRepo.attachWorktree(projectId, worktreeId);
      });

      /**
       * The saved capture a new executor lays the worktree down from (review 2026-09-28 (15) #1):
       * the head once the chain is past capture 0; null when the worktree is laid down fresh
       * (capture 0, no chain yet) and outside capture mode. Read under the launch's own lease
       * claim, so nothing registers between this read and the executor's plan.
       */
      const restoredCaptureOf = (worktreeId: WorktreeId): Effect.Effect<number | null> =>
        capture === null
          ? Effect.succeed(null)
          : capture.repo
              .headOf(worktreeId)
              .pipe(
                Effect.map((chain) => (chain !== null && chain.headN >= 1 ? chain.headN : null)),
              );

      /**
       * Dependency trees (ADR-0002 amended 2026-09-13, decisions 2 and 9): the head the executor
       * materialised carries a bulk section only for the platform it was captured on. Observe
       * this executor's platform with one exec; when the head has no tree for it, run the
       * project's install command (the setting, else the lockfile's) in the workspace before the
       * harness starts. Lines, never verdicts: a failing install is the agent's to see next.
       *
       * Only a manifest that was read can say the platform has no tree (review 2026-09-28 (16)
       * #1). A failed or undecodable read runs no installer: the executor may have restored a
       * tree for this platform, with the user's edits in it, and `npm ci` would replace them.
       * The words for the session line are returned. With the manifest read, the install runs
       * only on a fresh worktree (no head) or when no tree for this platform was restored:
       * sealantd carries the restored `bulk` forward into every capture it registers after the
       * restore, so a later head still names it.
       *
       * "Automatic install" off: no install command runs, detected or saved. This decides only
       * what runs here; the tree the executor restored from the head or the shared cache (its
       * plan, before this launch) is laid down either way.
       */
      const installDependenciesIfNeeded = Effect.fn("SessionEngine.installDependenciesIfNeeded")(
        function* (session: Session, project: Project, workspace: Workspace) {
          if (capture === null) return null;
          if (!project.installEnabled) {
            yield* Effect.logInfo(
              "session engine: dependency install skipped · automatic install off",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, projectId: project.id }));
            return null;
          }
          const probe = yield* sealant.exec(workspace, ["sh", "-c", PLATFORM_PROBE_SCRIPT]);
          const platform = platformKeyOf(probe.stdout);
          if (platform === null) {
            yield* Effect.logInfo(
              "session engine: dependency install skipped · platform unknown",
            ).pipe(
              Effect.annotateLogs({ sessionId: session.id, probe: probe.stdout.slice(0, 80) }),
            );
            return null;
          }
          const head = (yield* capture.repo.headOf(session.worktreeId))?.head ?? null;
          const read =
            head === null
              ? null
              : yield* capture.blobs.get(head.manifestKey).pipe(
                  Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)),
                  Effect.map((manifest) => manifest.sections),
                  Effect.result,
                );
          if (head !== null && read !== null && Result.isFailure(read)) {
            yield* Effect.logWarning(
              "session engine: dependency install skipped · manifest unavailable",
            ).pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                platform,
                captureN: head.n,
                error: String(read.failure),
              }),
            );
            return dependencyInstallSkippedWords(head.n);
          }
          const sections = read === null || Result.isFailure(read) ? null : read.success;
          // What `plan.get` answered this executor: the head's tree for its platform, the head's
          // `bulk` or one its `other_bulk` carries (sealantd PR #101), else nothing to restore.
          const bulk = sections === null ? "pending" : bulkSectionFor(sections, platform);
          if (bulk !== "pending") {
            yield* Effect.logInfo(
              "session engine: dependency tree observed for this platform",
            ).pipe(
              Effect.annotateLogs({ sessionId: session.id, platform, captureN: head?.n ?? null }),
            );
            return null;
          }
          const command =
            project.installCommand ??
            detectInstallCommand(
              (yield* git(["ls-tree", "--name-only", session.baseSha], project.storePath))
                .split("\n")
                .filter((name) => name !== ""),
            );
          if (command === null) {
            yield* Effect.logInfo(
              "session engine: dependency install skipped · no install command",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, platform }));
            return null;
          }
          yield* Effect.logInfo("session engine: dependency install · running").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              platform,
              capturedFor: sections === null ? [] : [...bulkSectionsByPlatform(sections).keys()],
              command,
            }),
          );
          const result = yield* sealant.exec(workspace, ["sh", "-lc", command], {
            cwd: "/workspace/repo",
          });
          yield* Effect.logInfo(
            `session engine: dependency install · ${result.exitCode === 0 ? "completed" : "exited"} · exit ${result.exitCode}`,
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              platform,
              command,
              stderr: result.exitCode === 0 ? "" : result.stderr.slice(-400),
            }),
          );
          return null;
        },
      );

      /** The project's compressed footprint (its base packs) prices the session's byte budget. */
      const footprintCache = new Map<SessionId, number>();
      const footprintFor = (sessionId: SessionId, projectId: ProjectId) =>
        Effect.gen(function* () {
          if (capture === null) return 0;
          const cached = footprintCache.get(sessionId);
          if (cached !== undefined) return cached;
          const bytes = (yield* capture.repo.listPacks())
            .filter(
              (pack) =>
                pack.class === "git" &&
                pack.worktreeId === null &&
                pack.key.startsWith(`projects/${projectId}/packs/`),
            )
            .reduce((sum, pack) => sum + pack.bytes, 0);
          footprintCache.set(sessionId, bytes);
          return bytes;
        });

      /**
       * A picked-up session still reads the loss after `reopen` ("executor lost · lease
       * expired at …" — `reopen` touches status alone). The replacement's first heartbeat or
       * register is the observation that ends it; the summary then says what was seen and
       * nothing more.
       */
      const observeReplacement = (sessionId: SessionId) =>
        Effect.gen(function* () {
          const found = yield* sessions.byId(sessionId).pipe(Effect.option);
          if (Option.isNone(found)) return;
          const session = found.value;
          if (
            session.settledAt !== null ||
            session.summary === null ||
            !session.summary.startsWith(EXECUTOR_LOST_PREFIX)
          ) {
            return;
          }
          yield* sessions.setSummary(sessionId, EXECUTOR_REPLACED_SUMMARY);
          yield* Effect.logInfo(
            "session engine: capture mode · picked up · executor replaced",
          ).pipe(Effect.annotateLogs({ sessionId, worktreeId: session.worktreeId }));
        });

      /**
       * The capture routes for one session, scoped to its worktree on every call — so a
       * standby executor (a pooled id with no session row yet) is answered as a standby until a
       * claim gives its id a session, after which the same routes serve the claimed worktree:
       * the executor's replan asks `plan.get` with no worktree named and is answered with it
       * (`hot-pool.ts` "Capture-mode standby").
       */
      /**
       * What a plan told the session (review 2026-09-28 (13) #1, (14) #1, #3), beside its summary:
       * a plan waiting for Mend to verify the head's git section (`launch waiting · …`) or refused
       * because git rejected it (`launch blocked · …`). The words are appended to what the summary
       * already says — never written over it: `executor lost · …` stays, for
       * `observeReplacement` to turn into `picked up · executor replaced` — and taken off again
       * once a plan goes ahead. Only the session's current launch is heard: a launch the session
       * moved on from (one whose readiness wait failed, still asking) says nothing here. Said once
       * per words: the executor asks again while it waits.
       */
      const noteCapturePlan = (sessionId: SessionId, notice: CapturePlanNotice) =>
        Effect.gen(function* () {
          const current = yield* sessions
            .byId(sessionId)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
          if (current === null) return;
          const currentLaunch =
            (yield* sessions.executorCreateOf(sessionId)) ??
            (yield* sessions.executorLaunchOf(sessionId))?.launchId ??
            sessionId;
          if (notice.launchId !== currentLaunch) {
            yield* Effect.logInfo(
              "session engine: a plan notice from a launch that is not the session's current one · not said",
            ).pipe(Effect.annotateLogs({ sessionId, launchId: notice.launchId, currentLaunch }));
            return;
          }
          const base = withoutPlanNotice(current.summary);
          const next =
            notice.kind === "planned"
              ? base
              : base === null
                ? notice.words
                : `${base} · ${notice.words}`;
          if (next === current.summary) return;
          if (notice.kind !== "planned") {
            yield* Effect.logWarning(`session engine: ${notice.words}`).pipe(
              Effect.annotateLogs({ sessionId }),
            );
          }
          yield* sessions.setSummary(sessionId, next);
        });

      const captureApiFor = (sessionId: SessionId, launchId?: string): SessionCaptureApi => {
        /**
         * `named`: the worktree the request names (`worktree_id`), when it names one. A claimed
         * standby whose replan did not take still ships under its placeholder (`standby-<id>`):
         * its launch's routes stay the standby's — the worktree that launch actually holds — until
         * its replan succeeds and it names the session's worktree (e2e run 6: routed to the
         * session's, every upload of its drain was refused `wrong-worktree` and the drain wedged
         * for 686 s).
         */
        const scoped = <A>(
          call: (api: SessionCaptureApi) => Effect.Effect<A, CaptureRouteError>,
          named?: string | null,
        ): Effect.Effect<A, CaptureRouteError> =>
          Effect.gen(function* () {
            if (capture === null) return yield* Effect.die("capture routes outside capture mode");
            const found = yield* sessions.byId(sessionId).pipe(Effect.option);
            if (Option.isNone(found)) {
              const entry = yield* hotWorkspaces.byId(sessionId);
              const prepare = sessionRepo.prepareStandby;
              if (entry === null || prepare === undefined) {
                return yield* Effect.die("capture routes: no session and no standby for this id");
              }
              const alias = standbyWorktreeAlias(sessionId);
              const epoch = standbyEpochOf(entry.createdAt);
              return yield* call(
                capture.channel.standbyApiFor({
                  alias,
                  projectId: entry.projectId,
                  executorId: sessionId,
                  launchId: launchId ?? standbyLaunchIdOf(entry.id),
                  epoch,
                  plan: (platform) =>
                    prepare(entry.projectId, alias, epoch, entry.baseSha, platform),
                }),
              );
            }
            const session = found.value;
            const standbyLaunch = standbyLaunchIdOf(sessionId);
            if (
              capture !== null &&
              launchId === standbyLaunch &&
              named === standbyWorktreeAlias(sessionId)
            ) {
              return yield* call(
                capture.channel.standbyApiFor({
                  alias: standbyWorktreeAlias(sessionId),
                  projectId: session.projectId,
                  executorId: sessionId,
                  launchId: standbyLaunch,
                  epoch:
                    session.executorStartedAt === null
                      ? 0
                      : standbyEpochOf(session.executorStartedAt),
                  // Never asked: `plan.get` is routed to the session's worktree.
                  plan: () => Effect.fail("the standby was claimed"),
                }),
              );
            }
            // The physical executor asking (cross-repo decision 5): the launch its token names
            // (what the network channel always passes). In-process callers without one read the
            // launch whose create is being asked (reserved on the row before the create, so a
            // cold boot planning before its create answers is that launch, never the session —
            // review 2026-09-28 (4) #10), else the session's current one, else the session id:
            // an executor launched before launch identities was planned as its session.
            const launch =
              launchId ??
              (yield* sessions.executorCreateOf(sessionId)) ??
              (yield* sessions.executorLaunchOf(sessionId))?.launchId ??
              sessionId;
            const api = capture.channel.apiFor({
              worktreeId: session.worktreeId,
              projectId: session.projectId,
              executorId: sessionId,
              launchId: launch,
              // Drained, kept or recovered: its uploads are what saves it (e2e run 5).
              unmetered: session.captureDrain !== null,
              planNotice: (notice) => noteCapturePlan(sessionId, notice),
              footprintBytes: yield* footprintFor(sessionId, session.projectId),
            });
            return yield* call(api);
          });
        const observed = <A>(
          call: (api: SessionCaptureApi) => Effect.Effect<A, CaptureRouteError>,
          named?: string | null,
        ): Effect.Effect<A, CaptureRouteError> =>
          scoped(call, named).pipe(Effect.tap(() => observeReplacement(sessionId)));
        return {
          // A plan is always the session's: a replan names no worktree, and a plan under the
          // placeholder is never handed out once the standby was claimed.
          planGet: (input) => scoped((api) => api.planGet(input)),
          uploadUrls: (input) => scoped((api) => api.uploadUrls(input), input.worktree_id),
          uploadComplete: (input) => scoped((api) => api.uploadComplete(input), input.worktree_id),
          register: (input) => observed((api) => api.register(input), input.worktree_id),
          changeSummary: (input) => scoped((api) => api.changeSummary(input), input.worktree_id),
          heartbeat: (input) => observed((api) => api.heartbeat(input), input.worktree_id),
        };
      };

      /** What each executor was observed to ship, per workspace (`observeCaptureThroughput`). */
      const throughputs = new Map<string, CaptureThroughput>();

      /**
       * The last FINAL flush answer per workspace, and when. An executor sent a final flush admits
       * nothing new, so an answer a moment old is as good as a new one: a drain that starts right
       * after a harvest's FINAL (a kept round: `settle harvest`, then `drain · stop`) reads it
       * instead of asking again (`FINAL_ANSWER_REUSE`).
       */
      const recentFinals = new Map<
        string,
        { readonly reading: CaptureReading; readonly atMs: number }
      >();

      // ── An executor's evidence, one decision at a time (cross-repo decision 18) ──────────
      // Every answer asked of an executor is fenced from the moment it is asked until it is
      // published: while one is in flight, or one arrived and could not be published, the
      // executor's evidence is unknown — no seal stands for it and nothing reads it saved. The
      // fence is durable (0088, review 2026-09-28 (7) #3): written before the ask, and deleted
      // in the very transaction that publishes the answer — the session's reading, its saved or
      // unsaved word and the executor's evidence — so neither a restart nor another engine
      // process nor a failed write reads the executor settled on less than it answered. An ask
      // that comes back with no answer deletes its fence; one whose answer arrived and was not
      // published keeps it until an answer asked after it is published. Publication, and every
      // decision that attests or reads "saved" on the evidence, run under one permit per
      // executor, and a decision commits only while the evidence version it read is still the
      // current one.
      const evidenceLocks = new Map<string, Semaphore.Semaphore>();
      const withEvidenceLock = <A, E, R>(
        workspaceId: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => {
        const existing = evidenceLocks.get(workspaceId);
        const lock = existing ?? Semaphore.makeUnsafe(1);
        if (existing === undefined) evidenceLocks.set(workspaceId, lock);
        return lock.withPermit(effect);
      };
      /** This engine process, as the fences it opens name it. */
      const fenceHolder = `engine:${crypto.randomUUID()}`;
      /** One ask's fence: its ticket, and how far its answer got. */
      interface EvidenceFence {
        readonly ticket: number;
        readonly holder: string;
        answered: boolean;
        published: boolean;
      }
      /** Nothing asked and unpublished: the evidence kept is all that was received. */
      const evidenceSettled = (workspaceId: string) =>
        sessions.evidenceFenced(workspaceId).pipe(Effect.map((fenced) => !fenced));
      /**
       * Ask `ask` of the executor fenced: the fence is written before it and closed after it —
       * deleted when nothing arrived, kept (`unpublished`) when an answer arrived and was not
       * published. Null when the fence could not be written: nothing is asked unfenced.
       */
      const fencedObservation = <A, E, R>(
        workspaceId: string,
        ask: (fence: EvidenceFence) => Effect.Effect<A | null, E, R>,
      ): Effect.Effect<A | null, E, R> =>
        Effect.acquireUseRelease(
          sessions.openEvidenceFence(workspaceId, fenceHolder).pipe(
            Effect.map((ticket): EvidenceFence | null => ({
              ticket,
              holder: fenceHolder,
              answered: false,
              published: false,
            })),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "session engine: capture evidence · the fence could not be written · not asked",
              ).pipe(
                Effect.annotateLogs({ workspaceId, cause: Cause.pretty(cause) }),
                Effect.as(null),
              ),
            ),
          ),
          (fence) => (fence === null ? Effect.succeed(null) : ask(fence)),
          (fence) =>
            fence === null || fence.published
              ? Effect.void
              : sessions
                  .closeEvidenceFence(fence.ticket, fence.answered ? "unpublished" : "unanswered")
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "session engine: capture evidence · the fence could not be closed · the executor's evidence stays unknown",
                      ).pipe(Effect.annotateLogs({ workspaceId, cause: Cause.pretty(cause) })),
                    ),
                  ),
        );
      /**
       * The executor's evidence as a decision reads it: what is kept, the version it read, and
       * whether it is settled. Null when nothing is kept.
       */
      const evidenceToken = Effect.fn("SessionEngine.evidenceToken")(function* (
        workspaceId: string,
      ) {
        const evidence = yield* sessions.executorEvidenceOf(workspaceId);
        return {
          workspaceId,
          version: evidence?.version ?? 0,
          settled: yield* evidenceSettled(workspaceId),
        };
      });
      /** Whether the evidence a decision read is still the current one, and settled. */
      const evidenceStillCurrent = Effect.fn("SessionEngine.evidenceStillCurrent")(
        function* (token: {
          readonly workspaceId: string;
          readonly version: number;
          readonly settled: boolean;
        }) {
          if (!token.settled || !(yield* evidenceSettled(token.workspaceId))) return false;
          const now = yield* sessions.executorEvidenceOf(token.workspaceId);
          return (now?.version ?? 0) === token.version;
        },
      );

      /**
       * `workspace.capture.flush()` (SDK 0.31.0, sealantd ADR-0015) on one executor. `suspend`: a
       * small-class capture, then everything staged is shipped and registered; processes keep
       * running (checkpoints, handoffs, readings). `final`: the executor is ending — it stops
       * admitting processes, ends the running ones, snapshots both classes and ships everything;
       * only its `complete: true` is saved (`captureSaved`). Bounded by the daemon and by `timeout`
       * here. The answer is recorded on `session` as observed (pending, bytes and refusals once
       * sealantd reports them, the head's registration time), folded into the executor's
       * throughput, and logged — null when the flush was refused or timed out. Runs as the
       * executor's owner, whatever the caller's principal.
       */
      const observeCaptureFlush = (
        session: Session,
        workspace: Workspace,
        why: string,
        timeout: Duration.Duration,
        kind: CaptureFlushKind,
      ) =>
        fencedObservation(workspace.id, (fence) =>
          observeCaptureFlushFenced(session, workspace, why, timeout, kind, fence),
        );
      const observeCaptureFlushFenced = Effect.fn("SessionEngine.observeCaptureFlush")(function* (
        session: Session,
        workspace: Workspace,
        why: string,
        timeout: Duration.Duration,
        kind: CaptureFlushKind,
        fence: EvidenceFence,
      ) {
        // A memory hand-over this executor recorded before this flush was asked, its position not
        // known yet: a caught-up answer under its epoch says where the moved home is saved.
        const pendingHome =
          capture === null
            ? null
            : ((yield* agentMemory.homeOf(session.worktreeId))?.pending ?? null);
        const unplacedHome =
          pendingHome !== null && pendingHome.n === null && pendingHome.workspaceId === workspace.id
            ? pendingHome
            : null;
        // Receipt is marked as the answer arrives (review 2026-09-28 (8) #4): from here its fence
        // clears only with its publication, whatever fails between.
        const outcome = yield* sealant.captureFlush(workspace, kind).pipe(
          Effect.tap(() => markAnswered(fence)),
          Effect.timeoutOption(timeout),
          Effect.result,
          asSealantUser(session.ownerUserId),
        );
        const annotations = {
          sessionId: session.id,
          worktreeId: session.worktreeId,
          workspaceId: workspace.id,
          why,
        };
        if (Result.isFailure(outcome)) {
          yield* Effect.logWarning("session engine: capture flush · refused").pipe(
            Effect.annotateLogs({ ...annotations, error: outcome.failure.message }),
          );
          return null;
        }
        if (Option.isNone(outcome.success)) {
          yield* Effect.logWarning("session engine: capture flush · timed out").pipe(
            Effect.annotateLogs({ ...annotations, timeoutMs: Duration.toMillis(timeout) }),
          );
          return null;
        }
        const report = outcome.success.value;
        const reading = readCaptureReport(report);
        // Published before anything else is done with it: a log is never what decides whether a
        // received answer becomes the executor's evidence.
        yield* recordReading(session, workspace.id, reading, kind, fence);
        if (
          unplacedHome !== null &&
          reading.headN !== null &&
          reading.epoch === unplacedHome.epoch &&
          placesMemoryHome(reading, kind)
        ) {
          yield* agentMemory.notePendingHomePosition(
            session.worktreeId,
            workspace.id,
            unplacedHome.epoch,
            reading.headN,
          );
        }
        if (kind === "final") recentFinals.set(workspace.id, { reading, atMs: Date.now() });
        throughputs.set(
          workspace.id,
          observeCaptureThroughput(throughputs.get(workspace.id) ?? null, {
            atMs: Date.now(),
            uploadedBytes: reading.uploadedBytes,
            registered: reading.registered,
          }),
        );
        // A suspend flush reads completed only when the head caught up with it — the same
        // predicate a landing takes (`captureCaughtUp`), never the queue alone.
        const behind = captureBehindReason(reading);
        const words =
          kind === "final"
            ? captureSaved(reading)
              ? "final · completed"
              : reading.complete === null
                ? "final · completion not reported"
                : "final · incomplete"
            : behind === null
              ? "completed"
              : `partial · ${behind}`;
        yield* evidenceLog(
          Effect.logInfo(`session engine: capture flush · ${words} · observed`).pipe(
            Effect.annotateLogs({
              ...annotations,
              kind,
              complete: reading.complete,
              incompleteReason: reading.incompleteReason,
              behind,
              epoch: report.epoch,
              headN: report.headN ?? null,
              pending: report.pending,
              pendingBytes: reading.pendingBytes,
              pendingBulk: reading.pendingBulk,
              refused: reading.refused,
              stagedBytes: report.stagedBytes,
              uploadedObjects: report.uploadedObjects,
              uploadedBytes: report.uploadedBytes,
              registered: report.registered,
              fenced: report.fenced,
              paused: report.paused,
            }),
          ),
        );
        return reading;
      });

      /**
       * Record one reading on the session (a flush's or a status read's): what is pending, and
       * whether a snap is failing (`capture failing since … · <error>`, logged once when it
       * starts). A final flush's answer also leaves why it did not complete, with what sealantd
       * named behind it.
       */
      const recordReading = Effect.fn("SessionEngine.recordReading")(function* (
        session: Session,
        workspaceId: string,
        reading: CaptureReading,
        kind: CaptureFlushKind | "status",
        fence: EvidenceFence,
      ) {
        if (capture === null) return;
        // An answer arrived: from here its fence clears only with its publication (or with a
        // later answer's), never because the ask returned.
        fence.answered = true;
        yield* withEvidenceLock(
          workspaceId,
          persistReading(session, workspaceId, reading, kind, fence),
        );
      });
      const persistReading = Effect.fn("SessionEngine.persistReading")(function* (
        session: Session,
        workspaceId: string,
        reading: CaptureReading,
        kind: CaptureFlushKind | "status",
        fence: EvidenceFence,
      ) {
        if (capture === null) return;
        const head = yield* capture.repo.headOf(session.worktreeId);
        const observedAt = new Date();
        const failing = captureSnapFailing(reading)
          ? {
              since: reading.snapFailingSince ?? observedAt,
              error: reading.snapError ?? captureSnapDetailOf(reading),
            }
          : null;
        const incompleteReason = kind === "final" ? captureIncompleteReasonOf(reading) : undefined;
        const overdue = reading.overdue ?? null;
        const before = yield* sessions
          .byId(session.id)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        // Where the executor made this answer (cross-repo decision 17): what orders it against
        // its other answers and its seal. `observedAt` is for display.
        const position = reading.position ?? null;
        // The executor's own word that its final flush completed: it stopped every writer,
        // snapshotted both classes and registered them, and admits nothing after that. How its
        // end reads from here on (`executorEndOf`), whatever registers on top of it.
        const saved = captureSaved(reading)
          ? {
              workspaceId,
              at: observedAt,
              n: reading.headN,
              epoch: reading.epoch ?? null,
              position,
            }
          : null;
        // The executor's own word that it holds work not saved (cross-repo decision 10): kept, so
        // an older save — a `complete: true` above, or the store's seal — reads revoked from here
        // on (`executorSealOf`, `executorEndOf`), whatever registers later without a new one.
        const unsavedWords = captureUnsavedWordsOf(reading);
        const unsaved =
          unsavedWords === null
            ? null
            : { workspaceId, at: observedAt, words: unsavedWords, position };
        // One transaction (review 2026-09-28 (7) #3): the session's reading and word, the answer
        // added to the executor's evidence — the executor's whoever asked (cross-repo decision
        // 14): a joined session's read describes the holder's disk too, and it outlives the
        // session that asked — and the fence cleared. Every answer moves the executor's evidence
        // version (cross-repo decision 18), whatever it said: a decision that read an older
        // version does not commit.
        yield* sessions.publishExecutorReading({
          sessionId: session.id,
          workspaceId,
          fence: { ticket: fence.ticket, holder: fence.holder },
          observation: {
            pending: reading.pending,
            pendingBytes: reading.pendingBytes,
            refused: reading.refused,
            registeredAt: head?.head?.createdAt ?? null,
            observedAt,
            failing,
            // A capture step past its bound (e2e8): recorded as observed, cleared once a reading
            // reports none — never idle, never saved while it lasts (`captureSaved`).
            overdue:
              overdue === null
                ? null
                : {
                    step: overdue.step,
                    since: overdue.startedAt,
                    runningMs: overdue.runningMs,
                    boundMs: overdue.boundMs,
                  },
            ...(incompleteReason === undefined
              ? {}
              : {
                  incompleteReason,
                  incompleteDetail: incompleteReason === null ? null : captureSnapDetailOf(reading),
                }),
          },
          position,
          saved,
          unsaved,
          answer: {
            worktreeId: session.worktreeId,
            launchId: yield* executorLaunchIdOf(session, SealantWorkspaceId.make(workspaceId)),
            ...(saved === null ? {} : { saved }),
            ...(unsaved === null ? {} : { unsaved }),
          },
        });
        // Published with its fence cleared in the same write: nothing after this reopens it.
        fence.published = true;
        if (overdue !== null && before !== null && before.captureOverdueStep !== overdue.step) {
          yield* evidenceLog(
            Effect.logWarning("session engine: capture step overdue · observed").pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                worktreeId: session.worktreeId,
                workspaceId,
                step: overdue.step,
                startedAt: overdue.startedAt?.toISOString() ?? null,
                runningMs: overdue.runningMs,
                boundMs: overdue.boundMs,
                via: kind,
              }),
            ),
          );
        }
        if (failing !== null && before !== null && before.captureFailingSince === null) {
          yield* evidenceLog(
            Effect.logWarning("session engine: capture failing · observed").pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                worktreeId: session.worktreeId,
                workspaceId,
                since: failing.since.toISOString(),
                error: failing.error,
                snapsFailed: reading.snapsFailed,
                unreadable: reading.unreadable,
                unreadablePaths: reading.unreadablePaths.slice(0, 5).join(" "),
                via: kind,
              }),
            ),
          );
        }
      });

      /** When each session's executor was last asked for its capture status (ms). */
      const statusReads = new Map<SessionId, number>();
      /**
       * Executors whose own final flush (a `docker stop`, the platform saving ahead of its cap) Mend
       * followed with a stop: their saved end reads `stopped outside Mend · saved at …`.
       */
      const endedOutsideMend = new Set<SealantWorkspaceId>();

      /**
       * `workspace.capture.status()` on the session's running executor: nothing flushed, nothing
       * snapped. Recorded like a flush answer. Null when the SDK cannot ask (SDK 0.37.2), the
       * daemon refused or did not answer in time.
       */
      const observeCaptureStatus = (session: Session, workspace: Workspace) =>
        fencedObservation(workspace.id, (fence) =>
          observeCaptureStatusFenced(session, workspace, fence),
        );
      const observeCaptureStatusFenced = Effect.fn("SessionEngine.observeCaptureStatus")(function* (
        session: Session,
        workspace: Workspace,
        fence: EvidenceFence,
      ) {
        const outcome = yield* sealant.captureStatus(workspace).pipe(
          // A status the SDK could not ask for (null) is no answer.
          Effect.tap((status) => (status === null ? Effect.void : markAnswered(fence))),
          Effect.timeoutOption(CAPTURE_STATUS_TIMEOUT),
          Effect.result,
          asSealantUser(session.ownerUserId),
        );
        if (Result.isFailure(outcome)) {
          yield* Effect.logDebug("session engine: capture status · refused").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              workspaceId: workspace.id,
              error: outcome.failure.message,
            }),
          );
          return null;
        }
        if (Option.isNone(outcome.success) || outcome.success.value === null) return null;
        const reading = readCaptureReport(outcome.success.value);
        yield* recordReading(session, workspace.id, reading, "status", fence);
        return reading;
      });

      /**
       * A status read of a running session's own executor, at most once per `minIntervalMs`:
       * the executor holds the worktree's live lease and nothing is draining it.
       */
      const readCaptureStatusOf = Effect.fn("SessionEngine.readCaptureStatusOf")(function* (
        sessionId: SessionId,
        minIntervalMs: number,
      ) {
        if (capture === null) return;
        const last = statusReads.get(sessionId);
        const nowMs = Date.now();
        if (last !== undefined && nowMs - last < minIntervalMs) return;
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.sealantWorkspaceId === null) return;
        if (session.captureDrain !== null || drains.has(session.sealantWorkspaceId)) return;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || !lease.live || lease.executorId !== session.id) return;
        statusReads.set(sessionId, nowMs);
        const workspace = yield* sealant
          .getWorkspace(session.sealantWorkspaceId)
          .pipe(Effect.option, asSealantUser(session.ownerUserId));
        if (Option.isNone(workspace)) return;
        const reading = yield* observeCaptureStatus(session, workspace.value);
        // The executor runs a final flush Mend did not ask for (a `docker stop`, the platform
        // saving ahead of its cap): it is ending, and that flush has already ended every process
        // in it. The session stops as a stop would — its agent recorded ended, a stop drain
        // following the executor to its end — and reads `stopping · saving` from now on (e2e
        // run 5: it read `running` for the whole flush).
        if (
          reading !== null &&
          reading.complete === false &&
          reading.incompleteReason === "in-progress"
        ) {
          yield* Effect.logInfo(
            "session engine: capture mode · the executor is running a final flush Mend did not ask for · stopping",
          ).pipe(Effect.annotateLogs({ sessionId, workspaceId: session.sealantWorkspaceId }));
          // Not the owner's stop: once saved it reads as the executor's own end does
          // (`stopped outside Mend · saved at …`), never a bare `stopped` (e2e run 9, D9).
          endedOutsideMend.add(session.sealantWorkspaceId);
          yield* Effect.forkIn(
            stop(sessionId).pipe(
              asSealantUser(session.ownerUserId),
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "session engine: stop after the executor's final flush failed",
                ).pipe(Effect.annotateLogs({ sessionId, cause: String(cause) })),
              ),
            ),
            scope,
          );
        }
      });

      /** Asked by a client's view: the read runs in the engine's scope, and the caller goes on. */
      const refreshCaptureStatus = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.forkIn(
          readCaptureStatusOf(sessionId, Duration.toMillis(drainPolicy.statusMinInterval)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session engine: capture status read failed").pipe(
                Effect.annotateLogs({ sessionId, cause: String(cause) }),
              ),
            ),
          ),
          scope,
        ).pipe(Effect.asVoid);

      /**
       * Flush whoever holds a worktree's lease, when that is a session's live executor: the
       * head a checkpoint is observed from is then the disk as of now, not the last cadence
       * tick. `none` only when it is known that no executor holds anything more
       * (`CaptureFlushObservation`); `incomplete` when the flush was refused, timed out or left
       * small captures behind, and whenever that cannot be known — the caller then observes
       * whatever head is registered, or waits (`flushCaptures`, `landingCheckpoint`). Bulk still
       * uploading does not hold a checkpoint up once sealantd says which pending captures are bulk;
       * a small snap that failed, a path it could not read or a small refusal does, however empty
       * the queue (`captureCaughtUp`).
       */
      const flushLeaseHolder = Effect.fn("SessionEngine.flushLeaseHolder")(function* (
        worktreeId: WorktreeId,
        why: string,
      ) {
        if (capture === null) return "none" satisfies CaptureFlushObservation;
        const lease = yield* capture.repo.leaseOf(worktreeId);
        // Never claimed, or released after its holder ended: the registered head is everything.
        if (lease === null || lease.executorId === null) {
          return "none" satisfies CaptureFlushObservation;
        }
        // Mend's own short claim (capture 0 registering): nothing of an executor, but the chain is
        // moving under it right now.
        if (lease.executorId.startsWith("mend:")) {
          return (lease.live ? "incomplete" : "none") satisfies CaptureFlushObservation;
        }
        const holder = yield* sessions
          .byId(SessionId.make(lease.executorId))
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (!lease.live) {
          // A lapse is not an end. With no row nothing of that executor can register any more; a
          // row with no workspace is a launch cut short around its create, whose executor may
          // still hold work (`launchUnresolved`); otherwise only the platform's word that it
          // ended says so.
          const judged = yield* judgeLapsedLease(holder, lease, null);
          return (
            judged.state === "dead" ? "none" : "incomplete"
          ) satisfies CaptureFlushObservation;
        }
        if (holder === null || holder.sealantWorkspaceId === null) {
          return "incomplete" satisfies CaptureFlushObservation;
        }
        const workspace = yield* sealant
          .getWorkspace(holder.sealantWorkspaceId)
          .pipe(Effect.option, asSealantUser(holder.ownerUserId));
        if (Option.isNone(workspace)) return "incomplete" satisfies CaptureFlushObservation;
        // An executor already sent a final flush takes nothing else; asking the final kind again
        // ships what it holds.
        const ending = yield* workspaceFinalFlushed(worktreeId, holder.sealantWorkspaceId);
        const reading = yield* observeCaptureFlush(
          holder,
          workspace.value,
          why,
          CHECKPOINT_FLUSH_TIMEOUT,
          ending ? "final" : "suspend",
        );
        return (
          reading !== null && captureCaughtUp(reading) ? "flushed" : "incomplete"
        ) satisfies CaptureFlushObservation;
      });

      /**
       * What the platform says of one workspace, without running anything in it: `found` (live:
       * queued · running · ready, with its status), `gone` (stopped, or no such workspace),
       * `unknown` (no answer). Capture mode: any other terminal status (`retained`, `failed`,
       * `cancelled`) is `kept` — Core retains a capture executor that ended without a completed
       * final flush (cross-repo decision 2), so its disk may hold work only it has, and Core may
       * boot it again to save it; until Core says otherwise its lease and its token stay (e2e run
       * 5). What Core last observed of its drain says otherwise (e2e9 F-A: a `docker stop` outside
       * Mend that saved read `stopping` for good, Core reporting it `failed` with its container
       * removed): a `failed` or `cancelled` executor whose drain ended (`stopped` — removed after
       * it — `saved`, `gone`, `discarded`) and that Core does not retain is `gone`. Retained, still
       * draining or kept, or a drain Core cannot be asked about (SDK 0.37.2), stays `kept`.
       */
      const lookupWorkspace = (workspaceId: SealantWorkspaceId): Effect.Effect<WorkspaceLookup> =>
        sealant.getWorkspace(workspaceId).pipe(
          Effect.flatMap((workspace) =>
            Effect.tryPromise({
              try: () => workspace.status(),
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap((status): Effect.Effect<WorkspaceLookup> => {
                if (workspaceIsLive(status)) {
                  return Effect.succeed({ kind: "found", workspace, status } as const);
                }
                if (capture === null || status === "stopped") {
                  return Effect.succeed({ kind: "gone", status } as const);
                }
                const kept: WorkspaceLookup = { kind: "kept", workspace, status };
                if (status !== "failed" && status !== "cancelled") return Effect.succeed(kept);
                return captureDrainOf(workspace).pipe(
                  Effect.map(
                    (drain): WorkspaceLookup =>
                      drain.kind === "drain" &&
                      !drain.retained &&
                      ENDED_DRAIN_STATES.has(drain.state)
                        ? { kind: "gone", status }
                        : kept,
                  ),
                  Effect.orElseSucceed(() => kept),
                );
              }),
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              workspaceMissing(error)
                ? ({ kind: "gone", status: "missing" } as const)
                : ({ kind: "unknown", error: String(error) } as const),
            ),
          ),
          Effect.catchDefect((defect) =>
            Effect.succeed({ kind: "unknown", error: String(defect) } as const),
          ),
        );

      /**
       * Does the executor still answer? `dead` only on what the platform positively says: a
       * terminal status (stopped · failed · cancelled) or no such workspace. A live status is
       * confirmed with a one-shot exec, because a killed container stays `ready` on the control
       * plane until something touches it (observed three minutes after `docker kill` in the local
       * proof). Anything else — a Core error, a timeout, an exec that did not answer — is
       * `unknown`: no pickup, no fence, look again on the next tick (ADR-0002 "Replacement and
       * pickup": confirm termination through the platform first).
       */
      const workspaceState = (workspaceId: SealantWorkspaceId) =>
        lookupWorkspace(workspaceId).pipe(
          Effect.flatMap((lookup) => {
            if (lookup.kind === "gone") return Effect.succeed("dead" as const);
            if (lookup.kind === "unknown") return Effect.succeed("unknown" as const);
            // Ended on its runtime, kept by the platform for recovery: never dead to Mend.
            if (lookup.kind === "kept") return Effect.succeed("kept" as const);
            return sealant.exec(lookup.workspace, ["true"]).pipe(
              Effect.map((result) => (result.exitCode === 0 ? "answering" : "unknown")),
              Effect.timeoutOption(Duration.seconds(30)),
              Effect.map(Option.getOrElse(() => "unknown" as const)),
              Effect.catch(() => Effect.succeed("unknown" as const)),
              Effect.catchDefect(() => Effect.succeed("unknown" as const)),
            );
          }),
        );

      /**
       * Whether a final flush was sent to `workspaceId` by any session of the worktree: such an
       * executor admits nothing more (no exec, no session, no replan), so nothing is started,
       * joined or resumed in it — the next run is a fresh executor.
       */
      const workspaceFinalFlushed = Effect.fn("SessionEngine.workspaceFinalFlushed")(function* (
        worktreeId: WorktreeId,
        workspaceId: SealantWorkspaceId,
      ) {
        if (capture === null) return false;
        for (const member of yield* sessions.listForWorktree(worktreeId)) {
          if ((yield* sessions.finalFlushedWorkspace(member.id)) === workspaceId) return true;
        }
        return false;
      });

      /**
       * The executor in `workspaceId` as the worktree's lease still names it — the session its
       * channel token was issued for, and its epoch: held by `session`, or by the session whose
       * workspace it is. Null once released, or when another executor holds the worktree.
       */
      const leasedExecutorOf = Effect.fn("SessionEngine.leasedExecutorOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        if (capture === null) return null;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || lease.executorId === null || lease.executorId.startsWith("mend:")) {
          return null;
        }
        const held = { executorId: lease.executorId, epoch: lease.epoch };
        if (lease.executorId === session.id) {
          return session.sealantWorkspaceId === null || session.sealantWorkspaceId === workspaceId
            ? held
            : null;
        }
        const holder = yield* sessions
          .byId(SessionId.make(lease.executorId))
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        return holder !== null && holder.sealantWorkspaceId === workspaceId ? held : null;
      });

      /**
       * The launch of the executor in `workspaceId`, as Mend knows it: the session's own when its
       * row names that workspace, else the lease holder's whose workspace it is. Null when
       * neither names one.
       */
      const executorLaunchIdOf = Effect.fn("SessionEngine.executorLaunchIdOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const own = yield* sessions.executorLaunchOf(session.id);
        if (own !== null && own.workspaceId === workspaceId) return own.launchId;
        const leased = yield* leasedExecutorOf(session, workspaceId);
        if (leased === null) return null;
        const held = yield* sessions.executorLaunchOf(SessionId.make(leased.executorId));
        return held !== null && held.workspaceId === workspaceId ? held.launchId : null;
      });

      /**
       * Everything the executor in `workspaceId` answered about its capture, whoever asked
       * (cross-repo decision 14, review 2026-09-28 (5) #3): its own evidence — the latest
       * completed final flush and the latest answer that said it held unsaved work, as the
       * executor ordered them (0087, decision 17) — and the version read (decision 18). A
       * session's own row repeats answers the executor's row already holds, without the position
       * that orders them, so it is not consulted.
       */
      const executorAnswersOf = Effect.fn("SessionEngine.executorAnswersOf")(function* (
        _session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const evidence = yield* sessions.executorEvidenceOf(workspaceId);
        return {
          saved: evidence?.saved ?? null,
          unsaved: evidence?.unsaved ?? [],
          version: evidence?.version ?? 0,
        };
      });

      /**
       * The store's sealed record (`CaptureSeals`) of the executor in `workspaceId`'s completed
       * final flush, bound to that executor and its epoch, with no capture registered after it
       * under that epoch. Null otherwise.
       */
      const executorSealRecordOf = Effect.fn("SessionEngine.executorSealRecordOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        if (capture === null) return null;
        const executor = yield* leasedExecutorOf(session, workspaceId);
        if (executor === null) return null;
        // The seal names one physical executor — its launch (cross-repo decision 5) — and only
        // the launch recorded with this very workspace is the executor being asked about. No
        // launch recorded with it: nothing to attest.
        const launch = yield* sessions.executorLaunchOf(SessionId.make(executor.executorId));
        if (launch === null || launch.workspaceId !== workspaceId) return null;
        const seal = yield* seals.sealedCompletion(
          session.worktreeId,
          launch.launchId,
          executor.epoch,
        );
        if (seal === null || seal.epoch !== executor.epoch) return null;
        if (seal.executorId !== launch.launchId) return null;
        const chain = yield* capture.repo.headOf(session.worktreeId);
        if (chain !== null && chain.headEpoch === executor.epoch && chain.headN > seal.n) {
          return null;
        }
        // Where the executor sealed, in its own order (`final_seal.boot_id`, `.boot_generation`,
        // `.observation`); a seal without that stamp is ordered against nothing.
        const position: CapturePosition = {
          epoch: seal.epoch,
          launchId: seal.executorId,
          bootId: seal.bootId ?? null,
          bootGeneration: seal.bootGeneration ?? null,
          observation: seal.observation ?? null,
          headN: seal.n,
        };
        return { seal, position, holder: SessionId.make(executor.executorId) };
      });

      /**
       * The sealed record (`executorSealRecordOf`) while it still stands: received evidence beats
       * stored evidence (cross-repo decision 10, review 2026-09-28 (4) #1) — an answer this
       * executor gave after the seal that said it held unsaved work (changed, unreadable, a
       * snapshot that failed, pending) revokes it. Whoever asked — the holder, the session
       * stopping, or any joined session of the same executor — the answer is the executor's
       * (`executorAnswersOf`, review 2026-09-28 (5) #3). Null otherwise.
       */
      const executorSealOf = Effect.fn("SessionEngine.executorSealOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const record = yield* executorSealRecordOf(session, workspaceId);
        if (record === null) return null;
        const { seal } = record;
        // An answer asked and not yet persisted may say anything: nothing stands for it
        // (cross-repo decision 18).
        if (!(yield* evidenceSettled(workspaceId))) {
          yield* Effect.logWarning(
            "session engine: capture mode · sealed, but an answer of the executor is not recorded yet · the seal does not stand",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              workspaceId,
              epoch: seal.epoch,
              n: seal.n,
            }),
          );
          return null;
        }
        const { unsaved: answers } = yield* executorAnswersOf(session, workspaceId);
        // Ordered by the executor, never by the store's clock against a worker's (cross-repo
        // decision 17, review 2026-09-28 (6) #6): the seal stands only over unsaved answers made
        // strictly before it; one after it, at its head, or one nothing orders revokes it — any
        // one the executor's evidence keeps (decision 25, review 2026-09-28 (9) #4).
        const unsaved = answers.find(
          (answer) => !saveCoversUnsaved(record.position, answer.position),
        );
        if (unsaved !== undefined) {
          yield* Effect.logWarning(
            "session engine: capture mode · sealed, but the executor answered unsaved work the seal does not cover · the seal no longer stands",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              workspaceId,
              epoch: seal.epoch,
              n: seal.n,
              sealPosition: JSON.stringify(record.position),
              unsavedPosition: JSON.stringify(unsaved.position ?? null),
              unsaved: unsaved.words,
            }),
          );
          return null;
        }
        return seal;
      });

      /**
       * Capture mode: the session's row names no workspace, yet the worktree's lease still names
       * the session — its launch claimed the worktree and was cut short around the create (a
       * restart, an interruption, a create whose answer was lost). An executor may exist that
       * Mend cannot address, holding work nothing else has: that ownership is unresolved, and
       * nothing reads it as ended — no removal, no release, no new epoch over it.
       */
      const launchUnresolved = Effect.fn("SessionEngine.launchUnresolved")(function* (
        session: Session,
      ) {
        if (capture === null) return false;
        if (session.sealantWorkspaceId !== null && !(yield* createUnanswered(session.id))) {
          return false;
        }
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || lease.executorId !== session.id) return false;
        // A lapsed one is resolved by the one judge: a launch the platform fenced made nothing,
        // and an executor confirmed gone holds nothing.
        if (lease.live) return true;
        return (yield* judgeLapsedLease(session, lease, null)).state !== "dead";
      });

      /**
       * An executor create the session asked for whose answer is not on its row
       * (`executor_create_key`): whatever its row names, the lease that names the session may
       * belong to an executor Mend has not seen (`resolveExecutorCreates` finds it).
       */
      const createUnanswered = (sessionId: SessionId) =>
        capture === null
          ? Effect.succeed(false)
          : sessions.executorCreateOf(sessionId).pipe(Effect.map((key) => key !== null));

      /** Sessions whose executor create is being asked in this process right now. */
      const creatingExecutors = new Set<SessionId>();

      /** Images that ran no memory delivery for want of node: said once each (`deliverAgentMemory`). */
      const nodelessImages = new Set<string>();
      /** Worktrees whose home is being handed over right now: a join waits (`handOverAgentMemory`). */
      const memoryHandovers = new Set<WorktreeId>();
      /** The last read credited per person, project and session (`creditAgentMemory`). */
      const lastCredited = new Map<string, string>();

      /**
       * The workspace of the executor a lease is bound to, as its holder's row names it: a lease
       * bound to a launch is that launch's executor, and the row speaks for it only while it
       * records that very launch with its workspace. A lease bound to no launch (an older one)
       * is the row's workspace's, as before. Null: nothing here addresses that executor, so
       * nothing here can confirm its end — its lease is held, never released (review of #516:
       * a later replacement's end was taken for an earlier executor's, whose unsaved work its
       * released lease fenced off).
       */
      const leaseExecutorWorkspace = Effect.fn("SessionEngine.leaseExecutorWorkspace")(function* (
        holder: Session,
        lease: { readonly launchId?: string | null },
      ) {
        if ((lease.launchId ?? null) === null) return holder.sealantWorkspaceId;
        const named = yield* sessions.executorLaunchOf(holder.id);
        return named !== null && named.launchId === lease.launchId ? named.workspaceId : null;
      });

      /**
       * The executor a lapsed lease is bound to, resolved on the platform's word when the holder's
       * row no longer names its launch: a launch id is the create's idempotency key, so Core
       * finds the workspace the create made (`found`: that workspace's state decides), or fences
       * the key (`none`: nothing was made under it, nor ever will be — Mend's own launch cut
       * short between its claim and its create, by a restart, leaves exactly this). `unknown`
       * while it cannot be decided: a live lease (a launch under way may still create under its
       * key), an unbound one with no workspace, a create of the holder's not yet answered, a
       * launch of the holder's under way in this process other than the one asking, or a
       * platform that does not answer.
       */
      const resolveLeaseExecutor = Effect.fn("SessionEngine.resolveLeaseExecutor")(function* (
        holder: Session,
        lease: { readonly launchId?: string | null; readonly live: boolean },
        asking: SessionId | null,
      ) {
        const named = yield* leaseExecutorWorkspace(holder, lease);
        if (named !== null) return { kind: "workspace" as const, workspaceId: named };
        const launch = lease.launchId ?? null;
        const unknown = { kind: "unknown" as const };
        if (
          capture === null ||
          launch === null ||
          lease.live ||
          creatingExecutors.has(holder.id) ||
          (holder.id !== asking && launchGate.underWay(holder.id)) ||
          (yield* createUnanswered(holder.id))
        ) {
          return unknown;
        }
        const found = yield* sealant
          .findWorkspaceByKey(launch)
          .pipe(asSealantUser(holder.ownerUserId), Effect.catch(noAnswer));
        if (found === null) return unknown;
        if (found.kind === "found") {
          return {
            kind: "workspace" as const,
            workspaceId: SealantWorkspaceId.make(found.workspaceId),
          };
        }
        if (found.kind === "cancelled") return { kind: "none" as const };
        if (found.kind !== "none") return unknown;
        const fence = yield* sealant
          .fenceWorkspaceCreate(launch)
          .pipe(asSealantUser(holder.ownerUserId), Effect.catch(noAnswer));
        if (fence?.kind === "found") {
          return {
            kind: "workspace" as const,
            workspaceId: SealantWorkspaceId.make(fence.workspaceId),
          };
        }
        if (fence?.kind === "cancelled") {
          yield* Effect.logInfo(
            "session engine: capture mode · the lease's launch made no executor · its create is fenced",
          ).pipe(Effect.annotateLogs({ holderSessionId: holder.id, launch }));
          return { kind: "none" as const };
        }
        return unknown;
      });

      /**
       * The one judge of a lapsed lease: what is known of the executor it is bound to. Every path
       * that decides whether a lapsed lease is held or ended asks here — the launch wait, removal
       * holds, the flush before a checkpoint or a landing, an interrupted launch's ownership, the
       * reaper — so none judges it by whatever the holder's row names now (three review rounds
       * found one that did). `dead`: no row (nothing of that executor can register any more), a
       * launch the platform fenced (nothing was made), or its own workspace confirmed gone.
       * `workspaceId` is that executor's when known. Only for a lease that is not live.
       */
      const judgeLapsedLease = Effect.fn("SessionEngine.judgeLapsedLease")(function* (
        holder: Session | null,
        lease: { readonly launchId?: string | null; readonly live: boolean },
        asking: SessionId | null,
      ) {
        if (holder === null) return { state: "dead" as const, workspaceId: null };
        const resolved = yield* resolveLeaseExecutor(holder, lease, asking);
        if (resolved.kind === "none") return { state: "dead" as const, workspaceId: null };
        if (resolved.kind === "unknown") return { state: "unknown" as const, workspaceId: null };
        if (yield* createUnanswered(holder.id)) {
          return { state: "unknown" as const, workspaceId: resolved.workspaceId };
        }
        const state = yield* workspaceState(resolved.workspaceId).pipe(
          asSealantUser(holder.ownerUserId),
        );
        return { state, workspaceId: resolved.workspaceId };
      });

      /**
       * Who holds a worktree in capture mode, for a session that is not the holder:
       * - `free`: nobody (never claimed, released after its holder ended, or Mend's own short
       *   claim), or a holder whose end the platform confirmed — its lapsed lease is released here
       *   so the next claim may take a new epoch;
       * - `held`: another session's executor, reachable and not ending — a join runs inside it;
       * - `ending`: that executor is saving before it ends (a drain under way): nothing new may
       *   start in it, and no other executor may take the worktree until it has ended;
       * - `unreachable`: a live lease whose executor the platform no longer answers for — refused
       *   until the heartbeat lapses and its end is confirmed;
       * - `lapsed`: another executor's lease lapsed without a release (a partition) and the
       *   platform does not say it ended: it may still hold work it has not shipped, so no new
       *   epoch is granted over it (ADR-0002 "Replacement and pickup").
       *
       * The session's own earlier executor is a holder like any other: a lease bound to a launch
       * of this session other than `ownLaunch` (the create this launch asks again, if any) is
       * that executor's, and no claim takes it over until its end is confirmed and the lease
       * released. Its end is read only through that very executor: when the lease's launch is the
       * one the row names, through the row's workspace (a relaunch or a replacement has drained
       * it, so it reads `ending` until it ends; one kept alive by another session's process reads
       * `held`, and the launch joins it). A launch the row no longer names (an earlier replacement
       * whose row was overwritten) has nothing here that can confirm its end: the launch waits,
       * then is refused, and the lease is never released, since that executor may hold work it
       * has not shipped. Read as free, the launch went on to create an executor whose boot waited
       * in `plan.get` for that lease (alpha 2026-10-03, 8fe91d79: four replacements in a row, each
       * past the platform's readiness budget, `launch-retained`).
       */
      const leaseHolderWorkspace = Effect.fn("SessionEngine.leaseHolderWorkspace")(function* (
        session: Session,
        ownLaunch: string | null,
      ) {
        if (capture === null) return { kind: "free" as const };
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        const ownEarlierLaunch =
          lease !== null &&
          lease.executorId === session.id &&
          (lease.launchId ?? null) !== null &&
          lease.launchId !== ownLaunch;
        if (
          lease === null ||
          lease.executorId === null ||
          (lease.executorId === session.id && !ownEarlierLaunch) ||
          lease.executorId.startsWith("mend:")
        ) {
          return { kind: "free" as const };
        }
        const holder = yield* sessions
          .byId(SessionId.make(lease.executorId))
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        // A lapsed lease is judged by `judgeLapsedLease` alone; a live one's executor, to join or
        // to wait on, is the lease's own (`leaseExecutorWorkspace`), never the row's current one.
        const judged = lease.live ? null : yield* judgeLapsedLease(holder, lease, session.id);
        const workspaceId =
          judged !== null
            ? judged.workspaceId
            : holder === null
              ? null
              : yield* leaseExecutorWorkspace(holder, lease);
        if (judged !== null) {
          // Only a positively ended executor is released (`judgeLapsedLease`).
          const state = judged.state;
          if (state === "dead") {
            // Work its Stop put off is still owed: the holder is ending, not free. The drain that
            // ends it runs that work and releases the lease; this launch's own wait keeps its
            // cancellation and deadline instead of waiting here (Astra review, 2026-10-03).
            if (workspaceId !== null && workOwed(workspaceId)) {
              return { kind: "ending" as const, sessionId: lease.executorId, epoch: lease.epoch };
            }
            yield* capture.repo.release(session.worktreeId, lease.epoch);
            yield* Effect.logInfo(
              "session engine: capture mode · the previous holder ended · lease released",
            ).pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                holderSessionId: lease.executorId,
                epoch: lease.epoch,
              }),
            );
            return { kind: "free" as const };
          }
          return {
            kind: "lapsed" as const,
            sessionId: lease.executorId,
            epoch: lease.epoch,
            state,
          };
        }
        if (
          holder !== null &&
          (holder.captureDrain !== null ||
            (workspaceId !== null &&
              (yield* workspaceFinalFlushed(session.worktreeId, workspaceId))))
        ) {
          return { kind: "ending" as const, sessionId: lease.executorId, epoch: lease.epoch };
        }
        const workspace =
          workspaceId === null
            ? null
            : yield* sealant.getWorkspace(workspaceId).pipe(
                Effect.flatMap((candidate) =>
                  Effect.promise(() => candidate.status()).pipe(
                    Effect.map((status) => (workspaceIsLive(status) ? candidate : null)),
                  ),
                ),
                Effect.catch(() => Effect.succeed(null)),
                Effect.catchDefect(() => Effect.succeed(null)),
              );
        if (workspace !== null) {
          return { kind: "held" as const, sessionId: lease.executorId, workspace };
        }
        return {
          kind: "unreachable" as const,
          sessionId: lease.executorId,
          epoch: lease.epoch,
          expiresAt: lease.expiresAt?.toISOString() ?? "never",
        };
      });

      /** One launch verb per session at a time (`launch-gate.ts`). */
      const launchGate = makeLaunchGate();
      /**
       * Launches their owner stopped while they were under way (alpha 2026-10-01, 3c4e991b). The
       * stop came two seconds before the agent's process row: it found no agent to end, settled
       * `stopped` and drained the executor, and the launch went on, started the agent and its row
       * reopened the session as `running`, with nothing behind it once the drain ended the
       * machine. A launch looks here just before it starts the agent
       * (`refuseIfStoppedDuringLaunch`), and one that started it anyway is stopped again as it
       * ends (`oneLaunch`).
       */
      const stoppedDuringLaunch = new Set<SessionId>();
      /** The launch stands down before its agent starts: nothing of it runs after the stop. */
      const refuseIfStoppedDuringLaunch = (sessionId: SessionId) =>
        Effect.suspend(() =>
          stoppedDuringLaunch.has(sessionId)
            ? Effect.fail(
                new SealantPlatformError({
                  code: "launch_cancelled",
                  status: 409,
                  message: "stopped while starting · the agent was not started",
                  cause: null,
                }),
              )
            : Effect.void,
        );

      /** Launches waiting on a worktree's previous executor (`awaitWorktreeHolder`). */
      const waitingLaunches = new Set<SessionId>();
      /** Of those, the ones their owner stopped meanwhile: they launch nothing. */
      const stoppedWhileWaiting = new Set<SessionId>();

      /**
       * One executor per worktree, waited for rather than refused (alpha 2026-09-30: a session
       * started 15 s after another in its worktree ended failed `worktree leased · … saving`, and
       * the save finished 15 s later). While the holder is `ending` (saving before it ends),
       * `unreachable` or `lapsed`, the launch looks again every `leaseWaitInterval` and the session
       * reads `starting · waiting · the previous session in this worktree is saving`. It goes on
       * only on what a retry by hand would have gone on: the lease `free` — released after the
       * holder's end was confirmed (ADR-0002 "Replacement and pickup") — or `held` by a reachable
       * executor it joins. Nothing is stopped and nothing is assumed to have ended. Past
       * `leaseWait` the last reading is answered, and the caller refuses it as before.
       */
      const awaitWorktreeHolder = Effect.fn("SessionEngine.awaitWorktreeHolder")(
        function* (session: Session, ownLaunch: string | null) {
          const deadline = Date.now() + Duration.toMillis(drainPolicy.leaseWait);
          let said: string | null = null;
          while (true) {
            const holder = yield* leaseHolderWorkspace(session, ownLaunch);
            if (stoppedWhileWaiting.has(session.id)) {
              return yield* new SealantPlatformError({
                code: "launch_cancelled",
                status: 409,
                message:
                  "stopped while waiting for the previous session in this worktree · nothing launched",
                cause: null,
              });
            }
            // The holder's launch is still handing its home over: a join would start on the
            // previous person's memory, or have Codex's database moved from under it.
            const handingOver =
              holder.kind === "held" &&
              memoryHandovers.has(session.worktreeId) &&
              Date.now() < deadline;
            if (handingOver) {
              yield* Effect.sleep(drainPolicy.leaseWaitInterval);
              continue;
            }
            if (holder.kind === "free" || holder.kind === "held" || Date.now() >= deadline) {
              if (said !== null) {
                yield* Effect.logInfo(
                  `session engine: capture mode · launch waited for the worktree · ${holder.kind}`,
                ).pipe(Effect.annotateLogs({ sessionId: session.id }));
              }
              return holder;
            }
            const words = leaseWaitWords(holder);
            if (words !== said) {
              yield* Effect.logInfo(
                "session engine: capture mode · the worktree's previous executor has not ended · the launch waits",
              ).pipe(
                Effect.annotateLogs({
                  sessionId: session.id,
                  holderSessionId: holder.sessionId,
                  holder: holder.kind,
                }),
              );
              yield* sayLaunchPhase(session.id, words);
              said = words;
            }
            yield* Effect.sleep(drainPolicy.leaseWaitInterval);
          }
        },
        (effect, session, _ownLaunch) =>
          Effect.suspend(() => {
            waitingLaunches.add(session.id);
            return effect;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                waitingLaunches.delete(session.id);
                stoppedWhileWaiting.delete(session.id);
              }),
            ),
          ),
      );

      /**
       * Pickup, first half: the session reads live but its worktree lease is not. Only a
       * positively dead executor (`workspaceState`) is picked up: its rows are reaped, its token
       * revoked and the lease released; the caller then relaunches and the new executor's first
       * plan claims epoch + 1. An executor that still answers paused itself on the lost heartbeat
       * and holds whatever it has not shipped: nothing is stopped (`answering`). One the platform
       * did not answer for is left alone too (`unknown`). `live-lease`: attach instead.
       */
      const confirmDeadExecutor = Effect.fn("SessionEngine.confirmDeadExecutor")(function* (
        session: Session,
      ) {
        if (capture === null) return "live-lease" as const;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease !== null && lease.live) return "live-lease" as const;
        if (session.sealantWorkspaceId !== null) {
          const state = yield* workspaceState(session.sealantWorkspaceId);
          if (state !== "dead") {
            yield* Effect.logWarning(
              `session engine: capture mode · lease expired · the executor ${state === "answering" ? "answers" : "did not answer"} · nothing stopped`,
            ).pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                worktreeId: session.worktreeId,
                epoch: lease?.epoch ?? null,
              }),
            );
            return state;
          }
        }
        yield* Effect.logWarning(
          "session engine: capture mode · lease expired · termination confirmed · pickup",
        ).pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            worktreeId: session.worktreeId,
            epoch: lease?.epoch ?? null,
            expiresAt: lease?.expiresAt?.toISOString() ?? null,
          }),
        );
        const activeRun = yield* sessionRuns.activeForSession(session.id);
        // Its own final flush registered last (a `docker stop` while Mend was away): saved.
        const end = yield* executorEndOfSession(session, session.sealantWorkspaceId);
        yield* stopWorkspaceQuietly(session.id, { force: true, reason: "relaunch" });
        if (activeRun !== null) {
          const confirmed = yield* confirmedExecutorEnd(session, end);
          yield* sessionRuns.settle(
            activeRun.sealantRunId,
            confirmed.outcome,
            confirmed.outcome === "stopped"
              ? confirmed.summary
              : `${EXECUTOR_LOST_SUMMARY}${lease?.expiresAt === null || lease?.expiresAt === undefined ? "" : ` at ${lease.expiresAt.toISOString()}`}`,
          );
        }
        yield* reconcileSession(session.id, { sweep: false }).pipe(Effect.ignore);
        return "picked-up" as const;
      });

      // ── Drain, then terminate (ADR-0002, "Stop drains, then terminates") ─────────
      /**
       * What a drain came to: `terminated` (saved, stopped, termination observed); `stop-requested`
       * (saved and the stop taken, its end not observed yet: the lease stays until it lapses or the
       * end is seen); `gone` (the platform had already ended it — nothing left to save or stop); `kept`
       * (not saved: the workspace stays up and the intent stays for the next sweep); `in-use`
       * (something reopened the workspace while it drained: nothing stopped); `discarded` (the
       * owner's "discard unsaved and stop" took over).
       */
      type DrainOutcome =
        | "terminated"
        | "stop-requested"
        | "gone"
        | "kept"
        | "in-use"
        | "discarded";
      /** One drain per workspace in this process; a second ask waits on the first. */
      const drains = new Map<SealantWorkspaceId, Deferred.Deferred<DrainOutcome>>();
      /** The last reading each running drain took of its executor (`runDeferred`). */
      const lastReadings = new Map<SealantWorkspaceId, CaptureReading>();
      /**
       * Workspaces whose put-off work a drain holds: from the drain's first look until a round
       * runs the queue to empty (saved, in use, gone). A kept round keeps it held, and the ends
       * that would otherwise run leftovers with a flush of their own leave it to the next round.
       */
      const queueHeld = new Set<SealantWorkspaceId>();
      /**
       * A piece of put-off work that ran past `deferredWorkLimit`: never interrupted (a harvest's
       * writes do not stop with its fiber, and a retry beside them could lose what it wrote), left
       * running with the executor kept, and waited for by the next round before anything else.
       */
      const deferredRunning = new Map<SealantWorkspaceId, Fiber.Fiber<void>>();
      /**
       * The one consumer of each workspace's queue (`runDeferred`) while it runs: a second asks
       * waits for it, bounded by its limit, so no round declares the queue finished while another
       * consumer still runs a piece of it.
       */
      const deferredConsumers = new Map<SealantWorkspaceId, Deferred.Deferred<void>>();
      /**
       * The last reading of each held executor that left a readable head (a FINAL that registered
       * it), kept across kept rounds for the harvest still owed: a later round that cannot read
       * the executor (gone, platform-kept) still knows the head is there to read.
       */
      const deferredEvidence = new Map<SealantWorkspaceId, DrainWord>();
      /**
       * Workspaces whose drain ran the queue to empty and is terminating the executor: an end
       * that arrives now puts nothing off (`endsAtFinal`) and flushes for itself, as before, so
       * nothing is admitted after the drain declared the queue finished. Cleared when the round
       * keeps the executor after all.
       */
      const queueClosed = new Set<SealantWorkspaceId>();
      /** Workspaces whose owner asked to discard what is unsaved: a running drain yields. */
      const discards = new Set<SealantWorkspaceId>();
      /** Sessions whose forked stop tail (harvest, then the sweep) is still running here. */
      const stopTails = new Set<SessionId>();
      /**
       * Each session's Stops in flight, from the Stop's entry to its tail's end, for the discard
       * that must wait for all of them before it releases the lease.
       */
      const stopTailsDone = new Map<SessionId, Set<Deferred.Deferred<void>>>();
      /**
       * Sessions a discard has stopped itself, counted per discard under way: a Stop arriving now
       * is answered and starts nothing, and one discard's end never unseals another's.
       */
      const discardSealed = new Map<SessionId, number>();
      /**
       * Work an end puts off until its drain's final flush, by workspace (ADR 0002 decision 50):
       * the stop's checkpoint and the harvest of each agent that ended. Before 2026-10-03 each
       * asked the executor for a flush of its own (`checkpoint · user-mark`, `process-end
       * harvest`, `settle harvest`), three snapshots and registers before the final one, 8.6 s
       * of a 25 s Stop on the box. The final flush holds everything those did, so when nothing
       * else holds the workspace they wait for it and read its head. Each is given the drain's
       * last reading of the executor: what it says of the head is what the flush of their own
       * would have said, so none is asked (a kept round sends one FINAL, decision 7). `refused`
       * when the drain asked and the executor did not answer: a flush of their own would not be
       * answered either, so the checkpoint is taken unflushed and the harvest waits for a later
       * sweep, as after a refused flush before. `none` when nothing drained (the workspace in use
       * after all): each runs as it ran before, flush and all. Whatever is left when the end's
       * tail is over runs then.
       */
      const deferredToFinal = new Map<
        SealantWorkspaceId,
        Array<(reading: DrainWord) => Effect.Effect<void>>
      >();
      const deferToFinal = (
        workspaceId: SealantWorkspaceId,
        work: (reading: DrainWord) => Effect.Effect<void>,
      ): boolean => {
        // Checked here, at the append, not before an async look: a drain that ran the queue to
        // empty and is terminating admits nothing more (`queueClosed`); the end that asked runs
        // its work itself, flush and all, as before (Astra review, 2026-10-03).
        if (queueClosed.has(workspaceId)) return false;
        const list = deferredToFinal.get(workspaceId);
        if (list === undefined) deferredToFinal.set(workspaceId, [work]);
        else list.push(work);
        return true;
      };
      /** Take what `workspaceId`'s end put off, at once: whoever takes it runs it, once. */
      const takeOneDeferred = (workspaceId: SealantWorkspaceId) => {
        const list = deferredToFinal.get(workspaceId);
        const next = list?.shift();
        if (list !== undefined && list.length === 0) deferredToFinal.delete(workspaceId);
        return next;
      };
      /**
       * Run what `workspaceId`'s end put off on the drain's word: first a piece a previous round
       * left running, then the queue to empty (work put off while a batch ran is taken too). Each
       * failure is said and none is fatal. True when all of it finished and the queue is empty,
       * and the hold on it is released; false when a piece ran past `limit`: it is left running
       * (`deferredRunning`), the rest put back, the hold kept, for the round that follows. With
       * `limit` null every piece is waited for (the executor is gone: there is no later round).
       */
      const runDeferred = (
        workspaceId: SealantWorkspaceId,
        reading: DrainWord,
        limit: Duration.Duration | null = drainPolicy.deferredWorkLimit,
        closeWhenEmpty = false,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const waitFor = (fiber: Fiber.Fiber<void>) =>
            limit === null
              ? Fiber.join(fiber).pipe(Effect.as(true))
              : Fiber.join(fiber).pipe(
                  Effect.as(true),
                  Effect.timeoutOrElse({
                    duration: limit,
                    orElse: () =>
                      Effect.logWarning(
                        "session engine: work deferred to the final flush did not finish in time · left running · executor kept",
                      ).pipe(
                        Effect.annotateLogs({ workspaceId, limit: Duration.format(limit) }),
                        Effect.as(false),
                      ),
                  }),
                );
          while (true) {
            const busy = deferredConsumers.get(workspaceId);
            if (busy !== undefined) {
              const over =
                limit === null
                  ? yield* Deferred.await(busy).pipe(Effect.as(true))
                  : yield* Deferred.await(busy).pipe(
                      Effect.as(true),
                      Effect.timeoutOrElse({
                        duration: limit,
                        orElse: () => Effect.succeed(false),
                      }),
                    );
              if (!over) return false;
              continue;
            }
            // The slot is taken, re-checked, and its release installed in one uninterruptible
            // step: an interruption between them would leave it taken forever (Astra review,
            // 2026-10-03). The consumer itself runs interruptible again.
            const outcome = yield* Effect.uninterruptibleMask((restore) =>
              Effect.suspend(() => {
                if (deferredConsumers.has(workspaceId)) return Effect.succeed(null);
                const mine = Deferred.makeUnsafe<void>();
                deferredConsumers.set(workspaceId, mine);
                return restore(consume(workspaceId, reading, waitFor, closeWhenEmpty)).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      deferredConsumers.delete(workspaceId);
                      Deferred.doneUnsafe(mine, Exit.succeed(undefined));
                    }),
                  ),
                );
              }),
            );
            if (outcome !== null) return outcome;
          }
        });
      /**
       * Run what was put off where no drain is owed to wait for it (a workspace found in use, an
       * end no drain holds): the consumer runs in the engine's scope, unbounded, so an
       * interruption of the caller (a request that gave up) leaves it running and nothing queued
       * without a consumer; the caller waits for it within the limit, then goes on.
       */
      /**
       * Before a lease is released under a workspace, whatever the path (a drain's end, a lapsed
       * holder read dead at a launch or by the reaper, a create cut short): what its Stop put off
       * runs to empty, every piece waited for, on the evidence the drain kept. No successor then
       * registers a head under a harvest still owed (Astra reviews, 2026-10-03). Nothing owed,
       * nothing running: at once.
       */
      const workOwed = (workspaceId: SealantWorkspaceId) =>
        deferredToFinal.has(workspaceId) ||
        deferredRunning.has(workspaceId) ||
        deferredConsumers.has(workspaceId);
      const owedBeforeRelease = (workspaceId: SealantWorkspaceId) =>
        Effect.suspend(() =>
          workOwed(workspaceId)
            ? runDeferred(
                workspaceId,
                deferredEvidence.get(workspaceId) ?? lastReadings.get(workspaceId) ?? "refused",
                null,
                true,
              ).pipe(Effect.asVoid)
            : Effect.void,
        );
      const runDeferredDetached = (
        workspaceId: SealantWorkspaceId,
        reading: DrainWord,
        wait = true,
      ) =>
        Effect.uninterruptible(Effect.forkIn(runDeferred(workspaceId, reading, null), scope)).pipe(
          Effect.flatMap((fiber) =>
            wait
              ? Fiber.join(fiber).pipe(
                  Effect.asVoid,
                  Effect.timeoutOrElse({
                    duration: drainPolicy.deferredWorkLimit,
                    orElse: () => Effect.void,
                  }),
                )
              : Effect.void,
          ),
        );
      /** `runDeferred`'s body, under its consumer slot. */
      const consume = (
        workspaceId: SealantWorkspaceId,
        reading: DrainWord,
        waitFor: (fiber: Fiber.Fiber<void>) => Effect.Effect<boolean>,
        closeWhenEmpty: boolean,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          while (true) {
            // A piece running (left by a round that ran out of time, or by a consumer interrupted
            // while waiting for it) is waited for first, and cleared only once it is over.
            const running = deferredRunning.get(workspaceId);
            if (running !== undefined) {
              if (!(yield* waitFor(running))) return false;
              deferredRunning.delete(workspaceId);
              continue;
            }
            // One piece at a time: taken, forked in the engine's scope and recorded as running in
            // one uninterruptible step, so an interruption (a request that gave up, a shutdown)
            // leaves it running and recorded and the rest still queued. A queue found empty is
            // closed to admission in that same step when the round goes on to terminate: nothing
            // is admitted between the look and the close (Astra reviews, 2026-10-03).
            const started = yield* Effect.uninterruptible(
              Effect.suspend(() => {
                const next = takeOneDeferred(workspaceId);
                if (next === undefined) {
                  if (closeWhenEmpty) queueClosed.add(workspaceId);
                  queueHeld.delete(workspaceId);
                  deferredEvidence.delete(workspaceId);
                  return Effect.succeed(false);
                }
                return Effect.forkIn(
                  next(reading).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "session engine: work deferred to the final flush failed",
                      ).pipe(
                        Effect.annotateLogs({
                          workspaceId,
                          reading: typeof reading === "string" ? reading : "read",
                          cause: Cause.pretty(cause),
                        }),
                      ),
                    ),
                  ),
                  scope,
                ).pipe(
                  Effect.map((fiber) => {
                    deferredRunning.set(workspaceId, fiber);
                    return true;
                  }),
                );
              }),
            );
            if (!started) return true;
          }
        });
      /**
       * Whether an end may put its work off to the drain's final flush: capture mode, and
       * nothing but what is ending holds the workspace (so the sweep that follows drains it).
       */
      const endsAtFinal = Effect.fn("SessionEngine.endsAtFinal")(function* (
        workspaceId: SealantWorkspaceId | null,
      ) {
        if (capture === null || workspaceId === null) return false;
        if (discards.has(workspaceId)) return false;
        if (queueClosed.has(workspaceId)) return false;
        const processLeases = yield* processes.listLiveForWorkspace(workspaceId);
        const forwardLeases = (yield* serviceForwards.listOpen()).filter(
          (forward) => forward.sealantWorkspaceId === workspaceId,
        );
        return processLeases.length + forwardLeases.length === 0;
      });
      /**
       * Drains that kept their workspace, as the reaper last left them: what was observed then
       * (`keptDrainState`), what the last round read (`reading`), how long it waits, and when it
       * looks again. A kept drain is retried with a doubling wait while nothing changes: every
       * round is a final flush, and a final flush registers captures.
       */
      const keptDrains = new Map<
        SessionId,
        {
          readonly state: string;
          readonly reading: string;
          readonly waitMs: number;
          readonly nextAtMs: number;
        }
      >();
      /** Everything whose change between rounds is worth a look at once: that, and the head. */
      const keptDrainState = Effect.fn("SessionEngine.keptDrainState")(function* (
        session: Session,
      ) {
        const chain = capture === null ? null : yield* capture.repo.headOf(session.worktreeId);
        return JSON.stringify([
          keptDrainReading(session),
          session.removalRequestedAt !== null,
          chain?.headN ?? null,
        ]);
      });
      /**
       * Record a round that kept its workspace: the first wait when the round read something new
       * (another reason, fewer pending), else the last wait doubled, up to the cap.
       */
      const noteKeptDrain = Effect.fn("SessionEngine.noteKeptDrain")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.captureDrain === null) {
          keptDrains.delete(sessionId);
          return;
        }
        const previous = keptDrains.get(sessionId);
        const reading = keptDrainReading(session);
        const firstMs = Duration.toMillis(drainPolicy.keptRetryFirst);
        const waitMs =
          previous === undefined || previous.reading !== reading
            ? firstMs
            : Math.min(previous.waitMs * 2, Duration.toMillis(drainPolicy.keptRetryMax));
        keptDrains.set(sessionId, {
          state: yield* keptDrainState(session),
          reading,
          waitMs,
          nextAtMs: Date.now() + waitMs,
        });
      });
      /**
       * Whether the reaper leaves a kept drain alone this tick: its wait has not run out and
       * nothing about it changed — the head, the reason, what is pending, the workspace still up.
       */
      const keptDrainWaits = Effect.fn("SessionEngine.keptDrainWaits")(function* (
        session: Session,
      ) {
        const kept = keptDrains.get(session.id);
        if (kept === undefined || session.captureNotSavedAt === null) return false;
        if (session.sealantWorkspaceId === null || Date.now() >= kept.nextAtMs) return false;
        if ((yield* keptDrainState(session)) !== kept.state) return false;
        const lookup = yield* lookupWorkspace(session.sealantWorkspaceId).pipe(
          asSealantUser(session.ownerUserId),
        );
        return lookup.kind !== "gone";
      });

      /**
       * Release the worktree lease when its holder is the executor in `workspaceId`. A lease of
       * this session bound to a launch is that launch's: released for `workspaceId` only while
       * the row names that executor under that very launch, never for an earlier executor of the
       * session whose end is observed after a later one took the worktree.
       */
      const releaseLeaseOfWorkspace = Effect.fn("SessionEngine.releaseLeaseOfWorkspace")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        if (capture === null) return;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || lease.executorId === null || lease.executorId.startsWith("mend:")) {
          return;
        }
        // The holder asked for an executor whose answer is not on its row: the lease may be that
        // executor's, whatever ended here.
        if (yield* createUnanswered(SessionId.make(lease.executorId))) return;
        const holder =
          lease.executorId === session.id
            ? session
            : yield* sessions
                .byId(SessionId.make(lease.executorId))
                .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (holder === null || (yield* leaseExecutorWorkspace(holder, lease)) !== workspaceId) {
          return;
        }
        yield* owedBeforeRelease(workspaceId);
        const released = yield* capture.repo.release(session.worktreeId, lease.epoch);
        if (released) {
          yield* Effect.logInfo("session engine: worktree lease released").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              worktreeId: session.worktreeId,
              workspaceId,
              epoch: lease.epoch,
            }),
          );
        }
      });

      /** A removal asked while the workspace was up happens once it has gone. */
      const removeIfRequested = Effect.fn("SessionEngine.removeIfRequested")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.removalRequestedAt === null) return;
        yield* sessions.remove(sessionId);
        yield* Effect.logInfo("session engine: session removed after its workspace went").pipe(
          Effect.annotateLogs({ sessionId }),
        );
      });

      /**
       * Watch the platform until it reports the workspace terminated (a terminal status, or no
       * such workspace), bounded. True once observed.
       */
      const awaitTerminated = Effect.fn("SessionEngine.awaitTerminated")(function* (
        workspaceId: SealantWorkspaceId,
      ) {
        const deadline = Date.now() + Duration.toMillis(drainPolicy.terminationWait);
        while (true) {
          const lookup = yield* lookupWorkspace(workspaceId);
          if (lookup.kind === "gone") return true;
          if (Date.now() >= deadline) return false;
          yield* Effect.sleep(drainPolicy.pollInterval);
        }
      });

      /**
       * What a stop Mend asks of the platform carries: the caller's options, and the store's
       * sealed record of the executor's completed final flush when there is one
       * (`executorSealOf`) — Core keeps an executor's disk unless it observed `complete: true`
       * itself or is told this. Nothing is attested that the store did not seal.
       */
      const stopOptionsFor = Effect.fn("SessionEngine.stopOptionsFor")(function* (
        sessionId: SessionId,
        workspace: Workspace,
        options?: { readonly discardUnsaved: boolean },
      ): Effect.fn.Return<WorkspaceStopOptions | undefined> {
        const workspaceId = SealantWorkspaceId.make(workspace.id);
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        // The version of the executor's evidence the attestation is decided on (cross-repo
        // decision 18): it is sent only while that is still the current one.
        const read = yield* evidenceToken(workspaceId);
        const seal = session === null ? null : yield* executorSealOf(session, workspaceId);
        if (seal === null || session === null) return options;
        // Core names an executor by its runtime identity, never by the Sealant workspace id: the
        // one recorded for the very launch the seal names, with this workspace (review
        // 2026-09-28 (3) #1). Never whichever runtime the workspace answers for now — a seal
        // never transfers to another physical executor.
        const holder = yield* leasedExecutorOf(session, workspaceId);
        const recorded =
          holder === null
            ? null
            : yield* sessions.executorResourceOf(SessionId.make(holder.executorId));
        const resourceId =
          recorded !== null &&
          recorded.workspaceId === workspaceId &&
          recorded.launchId === seal.executorId
            ? recorded.resourceId
            : null;
        if (resourceId === null) {
          yield* Effect.logWarning(
            "session engine: capture mode · sealed, but the executor's runtime identity is unknown · no completion sent",
          ).pipe(Effect.annotateLogs({ sessionId, workspaceId, epoch: seal.epoch, n: seal.n }));
          return options;
        }
        if (!(yield* evidenceStillCurrent(read))) {
          yield* Effect.logWarning(
            "session engine: capture mode · sealed, but the executor's evidence moved while the attestation was decided · no completion sent",
          ).pipe(Effect.annotateLogs({ sessionId, workspaceId, epoch: seal.epoch, n: seal.n }));
          return options;
        }
        return {
          ...options,
          completion: {
            captureN: seal.n,
            epoch: seal.epoch,
            executorId: resourceId,
            launchId: seal.executorId,
            sealedAt: seal.sealedAt.toISOString(),
            // The seal's own stamp (cross-repo decision 17): what Core orders the attestation
            // by. A seal without one (an older daemon) sends none.
            ...(seal.bootId === undefined ||
            seal.bootId === null ||
            seal.observation === undefined ||
            seal.observation === null
              ? {}
              : {
                  origin: {
                    epoch: seal.epoch,
                    launch: seal.executorId,
                    bootId: seal.bootId,
                    bootGeneration: seal.bootGeneration ?? 0,
                    observation: seal.observation,
                    headN: seal.n,
                  },
                }),
          },
        };
      });

      /**
       * The channel tokens of the executor in `workspaceId`, once its end was observed: its
       * launch's (cross-repo decision 5), never another launch's — an executor that may still
       * need its own token keeps it. A workspace the row names no launch for was launched before
       * launch identities, as its session.
       */
      const revokeExecutorTokens = (sessionId: SessionId, workspaceId: SealantWorkspaceId) =>
        Effect.gen(function* () {
          const launch = yield* sessions.executorLaunchOf(sessionId);
          yield* channelTokens.revokeLaunch(
            launch !== null && launch.workspaceId === workspaceId ? launch.launchId : sessionId,
          );
        }).pipe(Effect.ignore);

      /**
       * Capture mode: the executor's runtime identity (`details().runtime.resourceId`), recorded
       * on the session beside its workspace once the platform reports it — what a stop's
       * completion attestation names (`stopOptionsFor`). Nothing when the SDK cannot say.
       */
      const noteExecutorResource = Effect.fn("SessionEngine.noteExecutorResource")(function* (
        sessionId: SessionId,
        workspace: Workspace,
      ) {
        if (capture === null) return;
        const workspaceId = SealantWorkspaceId.make(workspace.id);
        const recorded = yield* sessions.executorResourceOf(sessionId);
        if (recorded !== null && recorded.workspaceId === workspaceId) return;
        // Only the runtime of the launch recorded with this workspace: a runtime another launch
        // made is another physical executor (Core's `runtime.launchId`).
        const launch = yield* sessions.executorLaunchOf(sessionId);
        const resourceId = yield* sealant
          .runtimeResourceId(
            workspace,
            launch !== null && launch.workspaceId === workspaceId ? launch.launchId : undefined,
          )
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (resourceId !== null) {
          yield* sessions.recordExecutorResource(sessionId, workspaceId, resourceId);
        }
      });

      /**
       * The terminate half: stop the workspace, watch for the platform to report it gone, reap
       * what ran in it, and only then release the lease — an executor still running under a
       * released lease would be fenced out mid-ship (sealantd registrar: 409 → WrongParent). Only
       * the platform's `stopped` (from the stop itself, or a terminal status or a 404 after it) is
       * a termination; `draining`, `kept` and `requested` are watched like any other answer. If
       * the termination is not observed in time the lease is left to lapse on its own, once the
       * executor's heartbeats stop, and the caller keeps the session's identity. True once
       * observed.
       */
      const terminateWorkspace = Effect.fn("SessionEngine.terminateWorkspace")(function* (
        sessionId: SessionId,
        workspace: Workspace,
        options?: { readonly discardUnsaved: boolean },
      ) {
        const workspaceId = SealantWorkspaceId.make(workspace.id);
        // Decided and sent under the executor's permit (cross-repo decision 18): no answer of it
        // is recorded between reading the evidence and the attestation reaching the platform.
        const { sent, answer } = yield* withEvidenceLock(
          workspaceId,
          Effect.gen(function* () {
            const decided = yield* stopOptionsFor(sessionId, workspace, options);
            return { sent: decided, answer: yield* sealant.stopWorkspace(workspace, decided) };
          }),
        );
        const stopState = answer.state;
        if (answer.completion !== null) {
          yield* Effect.logInfo(
            `session engine: capture mode · completion sent · ${answer.completion.outcome}`,
          ).pipe(
            Effect.annotateLogs({
              sessionId,
              workspaceId,
              detail: answer.completion.detail,
              completion: sent?.completion === undefined ? null : JSON.stringify(sent.completion),
            }),
          );
        }
        // Core keeps the executor for recovery: its disk holds work Core cannot confirm saved.
        // Nothing ended; the drain reads `not saved · executor kept for recovery`.
        if (answer.retained !== null) {
          yield* Effect.logWarning(
            "session engine: capture mode · the platform keeps the executor for recovery",
          ).pipe(
            Effect.annotateLogs({
              sessionId,
              workspaceId,
              reason: answer.retained.reason,
              recoverable: answer.retained.recoverable,
            }),
          );
          return { ended: false, retained: answer.retained, saved: null } as const;
        }
        // The seal Core accepted for this very stop: the executor was saved, as sealed.
        const attested = sent?.completion;
        const saved =
          answer.completion?.outcome === "accepted" &&
          attested !== undefined &&
          attested.sealedAt !== undefined
            ? { at: new Date(attested.sealedAt), n: attested.captureN }
            : null;
        const confirmed = stopState === "stopped" || (yield* awaitTerminated(workspaceId));
        yield* processes.reapLiveForWorkspace(workspaceId);
        const session = yield* sessions.byId(sessionId);
        // Ended with nothing attested on the stop (a launch whose worker died before `ready`:
        // the stop found no seal, and the platform's recovery boot sealed while it ended the
        // executor): the executor's own seal, standing, is the same fact. Read while the lease
        // still names the executor, so a session reads `… · saved at … · capture n` instead of
        // its launch's words alone (e2e run 9, RD).
        const sealedMeanwhile =
          saved === null && confirmed && options?.discardUnsaved !== true
            ? yield* executorSealOf(session, workspaceId)
            : null;
        if (confirmed) {
          // Only an end the platform confirmed takes the executor's channel and its token: one
          // it has not observed end may still ship, or be booted again to (e2e run 5).
          yield* socketHost.stop(sessionId);
          yield* revokeExecutorTokens(sessionId, workspaceId);
          yield* releaseLeaseOfWorkspace(session, workspaceId);
        } else {
          yield* Effect.logWarning(
            `session engine: workspace stop asked · ${stopState} · termination not observed yet · the lease lapses on its own`,
          ).pipe(Effect.annotateLogs({ sessionId, workspaceId, stopState }));
        }
        return {
          ended: confirmed,
          retained: null,
          saved:
            saved ??
            (sealedMeanwhile === null
              ? null
              : { at: sealedMeanwhile.sealedAt, n: sealedMeanwhile.n }),
        } as const;
      });

      /**
       * A `stopping` session whose drain has ended settles now (`SessionsRepo.settle`): its
       * workspace's termination was observed, or something reopened it (the fold reads `idle`).
       */
      const settleIfStopping = Effect.fn("SessionEngine.settleIfStopping")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.status !== "stopping" || session.captureDrain !== null) {
          return;
        }
        yield* reconcileSession(sessionId, { sweep: false }).pipe(
          Effect.catchTag("SessionNotFoundError", () => Effect.void),
        );
      });

      /**
       * The drain is over (saved and terminated, gone, in use, or discarded): settle what it held.
       * A discard stays on the session: `stopped · unsaved work discarded by … at …`.
       */
      const endDrain = Effect.fn("SessionEngine.endDrain")(function* (
        sessionId: SessionId,
        discarded?: { readonly at: Date; readonly by: string },
      ) {
        yield* sessions.endCaptureDrain(sessionId, discarded);
        yield* settleIfStopping(sessionId);
      });

      /**
       * A settled session reads the latest observation of its executor (e2e run 6): one that was
       * saved and ended after all, or ended later, replaces Mend's older word on it — `executor
       * not answering · … · completion unknown`, a failed launch's `retained` — and a failed
       * launch keeps its own words beside it (`restatedSummary`). A harness's own end stands, and
       * a session that is not settled is left to its fold.
       */
      const restateSettled = Effect.fn("SessionEngine.restateSettled")(function* (
        sessionId: SessionId,
        latest: { readonly outcome: SessionOutcome; readonly words: string },
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.settledAt === null || session.status !== "failed") return;
        const summary = restatedSummary(session.summary, latest.words);
        if (summary === null || summary === session.summary) return;
        const launchFailed = session.summary?.startsWith("launch failed") === true;
        const outcome = launchFailed ? "failed" : latest.outcome;
        yield* sessions.restate(sessionId, outcome, summary);
        // The run that settled with the session's earlier words (same outcome, same summary)
        // reads the restated ones with it; one with words of its own (its harness's end) keeps
        // them. A run of it still open reads the restated words too.
        const latestRun = yield* sessionRuns.latestForSession(sessionId);
        if (
          latestRun !== null &&
          latestRun.settledAt !== null &&
          latestRun.status === session.status &&
          latestRun.summary === session.summary
        ) {
          yield* sessionRuns.restate(latestRun.sealantRunId, outcome, summary);
        }
        yield* settleRunsOfSettled(sessionId);
        yield* Effect.logInfo("session engine: capture mode · settled session restated").pipe(
          Effect.annotateLogs({ sessionId, before: session.summary, after: summary }),
        );
      });

      /**
       * A session Mend stopped only because its executor ran a final flush of its own reads what
       * that end was once it is saved — `stopped outside Mend · saved at … · capture n`, as a
       * session whose end Mend observed from outside does — not the bare `stopped` of the owner's
       * Stop (e2e run 9: one of ten deadline-preserved sessions read `stopped`, summary null).
       * Only over a settled `stopped` session with nothing else to say.
       */
      const sayEndedOutsideMend = Effect.fn("SessionEngine.sayEndedOutsideMend")(function* (
        sessionId: SessionId,
        words: string,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (
          session === null ||
          session.settledAt === null ||
          session.status !== "stopped" ||
          session.summary !== null
        ) {
          return;
        }
        yield* sessions.setSummary(sessionId, words);
      });

      /** The platform ended it already: nothing to save or stop; tidy up behind it. */
      const tidyAfterGone = Effect.fn("SessionEngine.tidyAfterGone")(function* (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
      ) {
        yield* processes.reapLiveForWorkspace(workspaceId);
        yield* socketHost.stop(sessionId);
        yield* revokeExecutorTokens(sessionId, workspaceId);
        const session = yield* sessions.byId(sessionId);
        yield* releaseLeaseOfWorkspace(session, workspaceId);
        if (session.captureDrain !== null) yield* sessions.endCaptureDrain(sessionId);
        yield* settleIfStopping(sessionId);
      });

      /**
       * Whether anything Mend placed in the workspace still runs there: a live process or an open
       * Service forward. A drain that is not forced yields to it.
       */
      const workspaceInUse = Effect.fn("SessionEngine.workspaceInUse")(function* (
        workspaceId: SealantWorkspaceId,
      ) {
        return (
          (yield* processes.listLiveForWorkspace(workspaceId)).length +
          (yield* serviceForwards.listOpen()).filter(
            (forward) => forward.sealantWorkspaceId === workspaceId,
          ).length
        );
      });

      /**
       * One drain, start to end: a FINAL flush (the executor stops admitting processes, ends the
       * running ones, then snapshots both classes and ships), read what is left, record it, repeat
       * — no deadline while anything moves. Saved (`complete`, nothing pending) → terminate. No
       * movement for the stall window, or nothing can move (fenced, refused, an executor that
       * cannot report `complete`) → `not saved · workspace kept`, recorded once for the owner and
       * every surface, and the intent stays for the next sweep. The final flush ends whatever runs
       * in the executor, so a drain that is not `force`d yields to anything in use BEFORE its first
       * flush, never after; a relaunch or a replacement is replacing this workspace on purpose.
       */
      /**
       * A drain round that keeps its executor, as the session reads it: not saved, why, and
       * (`retained`, the default) that the platform keeps it for recovery.
       */
      const recordKept = Effect.fn("SessionEngine.recordKept")(function* (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
        detail: string | null,
        retained = true,
      ) {
        const current = yield* sessions.byId(sessionId);
        // The first word follows the executor (e2e8 (i), HSB): one the platform keeps for recovery
        // runs nothing of the session's, so a session whose current executor it is reads
        // `stopping · retained`, never `running` beside it.
        if (
          retained &&
          current.settledAt === null &&
          current.sealantWorkspaceId === workspaceId &&
          (current.status === "running" ||
            current.status === "waiting" ||
            current.status === "idle" ||
            current.status === "starting")
        ) {
          yield* sessions.setStatus(sessionId, "stopping");
        }
        yield* sessions.recordCaptureObservation(sessionId, {
          pending: current.capturePending ?? 0,
          pendingBytes: current.capturePendingBytes,
          refused: current.captureRefused,
          registeredAt: current.captureRegisteredAt,
          observedAt: new Date(),
          incompleteReason: retained ? CAPTURE_EXECUTOR_RETAINED : "in-progress",
          incompleteDetail: detail,
        });
        yield* sessions.markCaptureNotSaved(sessionId, new Date());
      });

      const runDrain = Effect.fn("SessionEngine.runDrain")(function* (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
        reason: CaptureDrainReason,
        force: boolean,
      ) {
        const session = yield* sessions.byId(sessionId);
        let previous: CaptureReading | null = null;
        let progressAtMs = Date.now();
        let begun = false;
        while (true) {
          if (discards.has(workspaceId)) return "discarded" as const;
          const lookup = yield* lookupWorkspace(workspaceId);
          if (lookup.kind === "gone") {
            if (begun) {
              yield* Effect.logWarning(
                "session engine: capture drain · the workspace went while draining",
              ).pipe(
                Effect.annotateLogs({
                  sessionId,
                  workspaceId,
                  reason,
                  status: lookup.status,
                  pending: previous?.pending ?? null,
                }),
              );
            }
            // Ended without Mend: how it ended, as observed (read while its lease still names
            // it), is what a settled session reads.
            const current = yield* sessions
              .byId(sessionId)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
            const end =
              current !== null && current.sealantWorkspaceId === workspaceId
                ? yield* executorEndOfSession(current, workspaceId)
                : null;
            // What the Stop put off runs before the lease goes with the tidy, on the drain's
            // last reading of the executor: a FINAL that registered the head before it went
            // leaves a readable head (`flushed`, the harvest reads it); none leaves an unflushed
            // checkpoint and no harvest (`refused`). There is no later round: every piece is
            // waited for.
            yield* runDeferred(
              workspaceId,
              deferredEvidence.get(workspaceId) ?? lastReadings.get(workspaceId) ?? "refused",
              null,
              true,
            );
            yield* tidyAfterGone(sessionId, workspaceId);
            if (end !== null && current !== null) {
              const confirmed = yield* confirmedExecutorEnd(current, end);
              yield* restateSettled(sessionId, {
                outcome: confirmed.outcome,
                words: confirmed.summary,
              });
              if (endedOutsideMend.delete(workspaceId) && confirmed.outcome === "stopped") {
                yield* sayEndedOutsideMend(sessionId, confirmed.summary);
              }
            }
            yield* removeIfRequested(sessionId);
            return "gone" as const;
          }
          if (!begun) {
            begun = true;
            // Durable first, then the in-use look: a join reads the intent and stays out
            // (`leaseHolderWorkspace`), and whatever started before it is seen here.
            yield* sessions.beginCaptureDrain(sessionId, reason, new Date(progressAtMs));
            // With the intent durable, a next round is owed: from here the drain holds what the
            // Stop put off (a round that saves runs it before the executor goes; a kept round
            // leaves it for the next), and nothing holds it without an intent to come back.
            queueHeld.add(workspaceId);
            // An executor already sent a final flush ended whatever ran in it and admits nothing
            // new: whatever reads live there is stale, and the drain goes on.
            const ending = yield* workspaceFinalFlushed(session.worktreeId, workspaceId);
            if (!force && !ending && lookup.kind === "found") {
              const inUse = yield* workspaceInUse(workspaceId);
              if (inUse > 0) {
                // Not flushed at all: what the Stop put off flushes for itself, as it did
                // (`none`), detached, and before the intent goes, so a request that gives up here
                // leaves nothing queued without a consumer (Astra reviews, 2026-10-03).
                yield* runDeferredDetached(workspaceId, "none");
                yield* endDrain(sessionId);
                yield* Effect.logInfo(
                  "session engine: capture drain · the workspace is in use · nothing stopped",
                ).pipe(Effect.annotateLogs({ sessionId, workspaceId, leases: inUse }));
                return "in-use" as const;
              }
            }
          }
          // Ended on its runtime and kept by the platform (e2e run 5): no daemon answers a final
          // flush. Core's own stop says what it is — ended, or retained for recovery — and only
          // an end it confirms releases the lease and the executor's token; kept, both stay for
          // the recovery boot, and the drain reads `not saved · executor kept for recovery`.
          if (lookup.kind === "kept") {
            // Core's stop below may confirm an end and release the lease: what the Stop put off
            // runs first, on whatever the drain last read of the executor.
            if (
              !(yield* runDeferred(
                workspaceId,
                deferredEvidence.get(workspaceId) ?? lastReadings.get(workspaceId) ?? "refused",
                drainPolicy.deferredWorkLimit,
                true,
              ))
            ) {
              yield* recordKept(
                sessionId,
                workspaceId,
                "the stop's checkpoint or harvest has not finished",
                false,
              );
              return "kept" as const;
            }
            const terminated = yield* terminateWorkspace(sessionId, lookup.workspace);
            if (terminated.ended) {
              yield* endDrain(sessionId);
              // Core ended it on the seal Mend attested and it accepted: saved (e2e run 6).
              if (terminated.saved !== null) {
                yield* restateSettled(sessionId, {
                  outcome: "stopped",
                  words: executorSavedWords(terminated.saved),
                });
                if (endedOutsideMend.delete(workspaceId)) {
                  yield* sayEndedOutsideMend(
                    sessionId,
                    `stopped outside Mend · ${executorSavedWords(terminated.saved)}`,
                  );
                }
              }
              yield* removeIfRequested(sessionId);
              return "gone" as const;
            }
            yield* recordKept(
              sessionId,
              workspaceId,
              terminated.retained?.reason ?? `the platform reports it ${lookup.status}`,
            );
            return "kept" as const;
          }
          // A runtime that is not ready yet (a launch still starting, or one whose worker died
          // after it started — Core adopts it as retained once its launch lease lapses) has no
          // daemon to flush: kept for now, looked at again on the kept drain's backoff, never
          // asked every poll.
          if (capture !== null && lookup.kind === "found" && lookup.status !== "ready") {
            yield* recordKept(
              sessionId,
              workspaceId,
              `executor not ready · ${lookup.status}`,
              false,
            );
            return "kept" as const;
          }
          // Recorded before it is sent: from here on this executor is ending, whatever the
          // answer, and nothing is started in it again.
          if (lookup.kind === "found") yield* sessions.markFinalFlush(sessionId, workspaceId);
          // A FINAL answered a moment ago (the harvest right before this drain) stands for this
          // round's when it did not complete: one FINAL per kept round, not two. A completed one
          // is asked again — complete means current (cross-repo decision 7): the disk may have
          // changed since, and sealantd says so (`changed`) only when asked.
          const recent: { readonly reading: CaptureReading; readonly atMs: number } | undefined =
            previous === null ? recentFinals.get(workspaceId) : undefined;
          const reused: CaptureReading | null =
            recent !== undefined &&
            Date.now() - recent.atMs <= FINAL_ANSWER_REUSE_MS &&
            !captureSaved(recent.reading)
              ? recent.reading
              : null;
          if (reused !== null) recentFinals.delete(workspaceId);
          const reading: CaptureReading | null =
            lookup.kind !== "found"
              ? null
              : reused !== null
                ? reused
                : yield* observeCaptureFlush(
                    session,
                    lookup.workspace,
                    `drain · ${reason}`,
                    drainPolicy.flushTimeout,
                    "final",
                  ).pipe(
                    // The drain's own answer stands for nobody's later round: every kept round
                    // asks (the harvest it once stood beside is put off until it, decision 50).
                    Effect.tap(() => Effect.sync(() => recentFinals.delete(workspaceId))),
                  );
          const nowMs = Date.now();
          // A completed answer is what the executor said; saved is the one decision a seal and an
          // end are read by (cross-repo decision 31, review 2026-09-28 (10) #7): the executor's
          // kept evidence, bound to this executor and its epoch, with every answer asked of it
          // published and a save made after every unsaved answer it keeps — a delayed complete
          // never reads saved over a failure the executor answered after it, or one nothing
          // orders against it. Read from the session as it is now, confirmed against the
          // evidence version it was read at.
          const directEnd =
            reading !== null && captureSaved(reading) && lookup.kind === "found"
              ? yield* Effect.gen(function* () {
                  const current = yield* sessions
                    .byId(sessionId)
                    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(session)));
                  return yield* confirmedExecutorEnd(
                    current,
                    yield* executorEndOfSession(current, workspaceId),
                  );
                })
              : null;
          if (directEnd !== null && directEnd.outcome !== "stopped") {
            yield* Effect.logWarning(
              "session engine: capture drain · the final flush answered complete, but the executor's evidence does not read saved · not saved yet",
            ).pipe(
              Effect.annotateLogs({
                sessionId,
                workspaceId,
                reason,
                headN: reading?.headN ?? null,
                evidence: directEnd.summary,
              }),
            );
          }
          const answered = captureDrainStep({
            previous,
            reading,
            progressAtMs,
            nowMs,
            stallSeconds: drainPolicy.stallSeconds,
            evidenceSaved: directEnd !== null && directEnd.outcome === "stopped",
          });
          // The store's sealed record of this executor's completed final flush stands for an
          // answer that was lost on the way (a relay that closed, a timeout, an SDK that drops
          // the `complete` field): it is the same fact, made durable by the register. Never for
          // an answer received that says otherwise (cross-repo decision 10, review 2026-09-28 (4)
          // #1): an incomplete, changed, unreadable or pending answer is newer evidence than any
          // seal, and a lost answer and a received failure are different facts.
          const answerLost =
            reading === null ||
            (reading.complete === null && captureUnsavedWordsOf(reading) === null);
          const sealed =
            answered.kind !== "saved" &&
            lookup.kind === "found" &&
            answerLost &&
            (yield* executorSealOf(session, workspaceId)) !== null;
          const step: CaptureDrainStep = sealed ? { kind: "saved" } : answered;
          // What saved it: the executor's own completed final flush, or the seal standing for a
          // lost answer.
          const savedBy =
            answered.kind === "saved"
              ? { at: new Date(nowMs), n: reading?.headN ?? null }
              : sealed
                ? yield* executorSealOf(session, workspaceId).pipe(
                    Effect.map((seal) => (seal === null ? null : { at: seal.sealedAt, n: seal.n })),
                  )
                : null;
          if (reading !== null) {
            previous = reading;
            lastReadings.set(workspaceId, reading);
            if (harvestReadyOf(reading) === true) deferredEvidence.set(workspaceId, reading);
          }
          if (step.kind === "saved" && lookup.kind === "found") {
            yield* Effect.logInfo("session engine: capture drain · saved · terminating").pipe(
              Effect.annotateLogs({ sessionId, workspaceId, reason }),
            );
            // What the end put off reads the final head now, before the executor goes and its
            // lease with it: a checkpoint and a harvest read the store, never the workspace, but
            // a successor launched after the release could register a newer head under them
            // (Astra review, 2026-10-03). Saved on the store's seal with no answer from the
            // executor: the head is sealed.
            const word: DrainWord = reading ?? "sealed";
            if (harvestReadyOf(word) === true) deferredEvidence.set(workspaceId, word);
            if (!(yield* runDeferred(workspaceId, word, drainPolicy.deferredWorkLimit, true))) {
              // A piece ran past its limit (a writer lock held, a store not answering): it runs
              // on, the executor stays, saved, and the next round waits for it and runs what is
              // left after its FINAL (which snaps nothing). Nothing a Stop asked for is dropped,
              // and no lease goes under it.
              yield* recordKept(
                sessionId,
                workspaceId,
                "saved · the stop's checkpoint or harvest has not finished",
                false,
              );
              return "kept" as const;
            }
            const terminated = yield* terminateWorkspace(sessionId, lookup.workspace);
            if (terminated.retained !== null) {
              // Mend read it saved; the platform does not confirm it and keeps the executor for
              // recovery. That is its word to keep: the drain stays, kept, and asks again.
              yield* recordKept(sessionId, workspaceId, terminated.retained.reason);
              return "kept" as const;
            }
            const ended = terminated.ended;
            // Saved, but its end not observed: the session stays `stopping` and the row stays
            // until it is (the reaper looks again), so nothing the executor registers under goes
            // early and nothing reads settled while its container may still run.
            if (ended) {
              yield* endDrain(sessionId);
              if (savedBy !== null) {
                yield* restateSettled(sessionId, {
                  outcome: "stopped",
                  words: executorSavedWords(savedBy),
                });
                if (endedOutsideMend.delete(workspaceId)) {
                  yield* sayEndedOutsideMend(
                    sessionId,
                    `stopped outside Mend · ${executorSavedWords(savedBy)}`,
                  );
                }
              }
              yield* removeIfRequested(sessionId);
            } else {
              yield* sessions.endCaptureDrain(sessionId);
            }
            // Only an observed end is `terminated`; a stop the platform took and has not been seen
            // to finish is said as such (review 2026-09-28 (19) #2).
            return ended ? ("terminated" as const) : ("stop-requested" as const);
          }
          if (step.kind !== "saved" && step.progressAtMs !== progressAtMs) {
            progressAtMs = step.progressAtMs;
            yield* sessions.recordCaptureDrainProgress(sessionId, new Date(progressAtMs));
          }
          if (step.kind === "not-saved") {
            const first = yield* sessions.markCaptureNotSaved(sessionId, new Date(nowMs));
            if (first) {
              yield* Effect.logWarning(
                "session engine: capture drain · not saved · workspace kept",
              ).pipe(
                Effect.annotateLogs({
                  sessionId,
                  workspaceId,
                  reason,
                  pending: previous?.pending ?? null,
                  pendingBytes: previous?.pendingBytes ?? null,
                  refused: previous?.refused ?? null,
                  fenced: previous?.fenced ?? null,
                  stallSeconds: drainPolicy.stallSeconds,
                }),
              );
            }
            return "kept" as const;
          }
          yield* Effect.sleep(drainPolicy.pollInterval);
        }
      });

      /**
       * Drain `workspaceId`'s executor, then terminate it — the only way Mend lets compute that
       * holds a session go (docs/adr/0002, "Stop drains, then terminates"). One drain per
       * workspace at a time; a second ask (a relaunch behind a stop) waits for the first and
       * reads its outcome. Never fails: an error keeps the workspace and the durable intent.
       */
      const drainThenTerminate = (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
        reason: CaptureDrainReason,
        force: boolean,
      ): Effect.Effect<DrainOutcome> =>
        // The slot is taken and its release installed in one uninterruptible step (a request
        // that gives up between them would leave the slot taken forever); the drain itself runs
        // interruptible again.
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const running = drains.get(workspaceId);
            if (running !== undefined) return restore(Deferred.await(running));
            const done = Deferred.makeUnsafe<DrainOutcome>();
            drains.set(workspaceId, done);
            return restore(
              runDrain(sessionId, workspaceId, reason, force).pipe(
                Effect.catchCause((cause) =>
                  // A shutdown is not an outcome: whoever waits on this drain (a relaunch) is
                  // interrupted with it, and its durable intent stays for the next start.
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning(
                        "session engine: capture drain failed · workspace kept",
                      ).pipe(
                        Effect.annotateLogs({
                          sessionId,
                          workspaceId,
                          reason,
                          cause: String(cause),
                        }),
                        Effect.as("kept" as const),
                      ),
                ),
                Effect.tap((outcome) =>
                  outcome === "kept"
                    ? Effect.andThen(
                        Effect.sync(() => queueClosed.delete(workspaceId)),
                        noteKeptDrain(sessionId),
                      )
                    : Effect.sync(() => keptDrains.delete(sessionId)),
                ),
              ),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  Deferred.doneUnsafe(done, exit);
                  drains.delete(workspaceId);
                }),
              ),
              Effect.ensuring(Effect.sync(() => lastReadings.delete(workspaceId))),
            );
          }),
        );

      /**
       * "Discard unsaved and stop" (the owner's, confirmed and audited by the caller): the one
       * path that ends a workspace while captures are still pending. The agent stops as any stop
       * stops it; a running drain yields; the workspace is terminated and the lease released
       * once that is observed. What the executor had not shipped is gone.
       */
      const discardUnsavedAndStop = Effect.fn("SessionEngine.discardUnsavedAndStop")(function* (
        sessionId: SessionId,
        discardedBy?: string | null,
      ) {
        const requestedAt = new Date();
        const session = yield* sessions.byId(sessionId);
        const workspaceId = session.sealantWorkspaceId;
        if (session.captureDrain === null || workspaceId === null) {
          return yield* new NothingUnsavedError({ sessionId });
        }
        // What Mend knows now, before anything ends: the audit's substance.
        const head =
          capture === null
            ? null
            : ((yield* capture.repo.headOf(session.worktreeId))?.head ?? null);
        // The executor's completed final flush, whichever session observed it.
        const { saved } = yield* executorAnswersOf(session, workspaceId);
        const facts: CaptureDiscardFacts = {
          requestedAt,
          workspaceId,
          lastSaved: head === null ? null : { n: head.n, at: head.createdAt },
          finalCompleted:
            saved === null || saved.workspaceId !== workspaceId
              ? null
              : { n: saved.n, at: saved.at },
          failingSince: session.captureFailingSince,
          failingError: session.captureFailingError ?? session.captureIncompleteDetail,
          queue:
            session.capturePending === null || session.captureObservedAt === null
              ? null
              : {
                  pending: session.capturePending,
                  pendingBytes: session.capturePendingBytes,
                  observedAt: session.captureObservedAt,
                },
        };
        let discardedAt = requestedAt;
        discards.add(workspaceId);
        let sealed = false;
        // What is logged follows what happened (cross-repo decision 28, review 2026-09-28 (9)
        // #10): the request now; `discarded` only once the platform confirmed the end.
        const annotations = {
          sessionId,
          workspaceId,
          pending: session.capturePending,
          pendingBytes: session.capturePendingBytes,
        };
        yield* Effect.gen(function* () {
          yield* Effect.logWarning(
            "session engine: discard of unsaved captures requested by the owner · stopping",
          ).pipe(Effect.annotateLogs(annotations));
          yield* stop(sessionId, null);
          // From here a Stop is answered and starts nothing: the Stops in flight are waited for
          // below, and none may join them.
          discardSealed.set(sessionId, (discardSealed.get(sessionId) ?? 0) + 1);
          sealed = true;
          // The tail that stop forked harvests inline under a discard: waited for, so it never
          // reads under a successor once the lease below goes (Astra review, 2026-10-03).
          // Every tail, those a Stop meanwhile started included, until none is left.
          while (true) {
            const tails = [...(stopTailsDone.get(sessionId) ?? [])];
            if (tails.length === 0) break;
            yield* Effect.forEach(tails, (tailDone) => Deferred.await(tailDone), { discard: true });
          }
          const running = drains.get(workspaceId);
          if (running !== undefined) yield* Deferred.await(running);
          // What the stop put off runs before the lease goes, on the evidence the drain kept,
          // every piece waited for: a harvest still reading when a successor registers would
          // read the successor's head (Astra review, 2026-10-03).
          yield* runDeferred(
            workspaceId,
            deferredEvidence.get(workspaceId) ?? lastReadings.get(workspaceId) ?? "refused",
            null,
            true,
          );
          const lookup = yield* lookupWorkspace(workspaceId);
          if (lookup.kind === "unknown") {
            // Nothing is known gone and nothing was stopped: the lease stays with the executor.
            return yield* new SealantPlatformError({
              code: "workspace_unknown",
              status: null,
              message: `the platform did not answer for the workspace · nothing stopped · ${lookup.error}`,
              cause: null,
            });
          }
          // The discard asks the platform for a stop that does not drain (an audited force stop
          // on its side): a plain stop would drain, and a queue that does not move keeps the
          // workspace forever.
          // A kept executor (ended on its runtime, retained by the platform) is discarded by the
          // platform too: only its word ends it, never Mend's reading of a status.
          const ended =
            lookup.kind === "found" || lookup.kind === "kept"
              ? (yield* terminateWorkspace(sessionId, lookup.workspace, { discardUnsaved: true }))
                  .ended
              : yield* tidyAfterGone(sessionId, workspaceId).pipe(Effect.as(true));
          if (!ended) {
            // The platform kept it (or has not ended it yet): nothing is discarded, and the
            // session still reads what it holds.
            yield* Effect.logWarning(
              "session engine: discard asked · the platform has not ended the workspace · nothing discarded yet",
            ).pipe(Effect.annotateLogs(annotations));
            return yield* new SealantPlatformError({
              code: "workspace_not_ended",
              status: 409,
              message:
                "discard asked · the platform has not ended the workspace · nothing discarded yet · the lease stays with it",
              cause: null,
            });
          }
          discardedAt = new Date();
          yield* Effect.logWarning(
            "session engine: unsaved captures discarded by the owner · the platform ended the workspace",
          ).pipe(Effect.annotateLogs(annotations));
          // The line says when the owner asked; the audit keeps both times.
          yield* endDrain(sessionId, {
            at: requestedAt,
            by:
              discardedBy === undefined || discardedBy === null || discardedBy.trim() === ""
                ? "the owner"
                : discardedBy.trim(),
          });
          yield* removeIfRequested(sessionId);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              discards.delete(workspaceId);
              if (sealed) {
                const left = (discardSealed.get(sessionId) ?? 1) - 1;
                if (left <= 0) discardSealed.delete(sessionId);
                else discardSealed.set(sessionId, left);
              }
            }),
          ),
        );
        const after = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(session)));
        return { session: after, facts, discardedAt } satisfies CaptureDiscardResult;
      });

      /**
       * What the session's own executor holds right now: a flush, recorded on the session. Null
       * outside capture mode, when the session does not hold its worktree, or when nobody
       * answered. The idle stop reads it before stopping (a `capture` hold).
       */
      const readCaptures = Effect.fn("SessionEngine.readCaptures")(function* (
        sessionId: SessionId,
      ) {
        if (capture === null) return null;
        const session = yield* sessions.byId(sessionId);
        if (session.sealantWorkspaceId === null) return null;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || !lease.live || lease.executorId !== session.id) return null;
        const lookup = yield* lookupWorkspace(session.sealantWorkspaceId);
        if (lookup.kind !== "found") return null;
        return yield* observeCaptureFlush(
          session,
          lookup.workspace,
          "capture reading",
          CHECKPOINT_FLUSH_TIMEOUT,
          (yield* workspaceFinalFlushed(session.worktreeId, session.sealantWorkspaceId))
            ? "final"
            : "suspend",
        );
      });

      /**
       * Removal after the sweep (never before: a session row removed under its own sweep leaves
       * the workspace unaddressable). No workspace, or one the platform already ended → the row
       * goes now. Otherwise the request is recorded and the sweep removes the row once the
       * workspace has gone — after its drain, in capture mode.
       */
      const removeWhenStopped = Effect.fn("SessionEngine.removeWhenStopped")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.byId(sessionId);
        const workspaceId = session.sealantWorkspaceId;
        const inFlight =
          stopTails.has(sessionId) || (workspaceId !== null && drains.has(workspaceId));
        if (!inFlight && session.captureDrain === null) {
          // Co-located: a workspace another session's live process runs in (a joined executor)
          // is theirs — it stays addressable through them, and this row may go. Capture mode:
          // this row IS the executor's identity — every capture call it makes (upload, register,
          // plan, heartbeat) resolves it — so it stays until the workspace has gone, whoever
          // still works in it; the sweep removes it then.
          const othersLive =
            capture === null &&
            workspaceId !== null &&
            (yield* processes.listLiveForWorkspace(workspaceId)).some(
              (process) => process.sessionId !== sessionId,
            );
          // No workspace on the row is gone only when no lease names the session either: a
          // launch cut short around its create may have left an executor (`launchUnresolved`).
          const gone =
            !(yield* launchUnresolved(session)) &&
            (workspaceId === null ||
              othersLive ||
              (yield* lookupWorkspace(workspaceId)).kind === "gone");
          if (gone) {
            yield* sessions.remove(sessionId);
            return "removed" as const;
          }
        }
        yield* sessions.requestRemoval(sessionId, new Date());
        if (!inFlight) {
          yield* Effect.forkIn(stopWorkspaceIfUnleased(sessionId), scope);
        }
        return "pending" as const;
      });

      const captureHolds = Effect.fn("SessionEngine.captureHolds")(function* (
        worktreeId: WorktreeId,
      ) {
        if (capture === null) return [];
        const members = yield* sessions.listForWorktree(worktreeId);
        const holds: Array<CaptureHold> = [];
        const looked = new Set<SealantWorkspaceId>();
        for (const member of members) {
          if (member.captureDrain !== null) {
            holds.push({
              sessionId: member.id,
              kind: member.captureNotSavedAt === null ? "saving" : "not-saved",
            });
            if (member.sealantWorkspaceId !== null) looked.add(member.sealantWorkspaceId);
          }
        }
        for (const member of members) {
          const workspaceId = member.sealantWorkspaceId;
          if (workspaceId === null || looked.has(workspaceId)) continue;
          looked.add(workspaceId);
          const lookup = yield* lookupWorkspace(workspaceId).pipe(
            asSealantUser(member.ownerUserId),
          );
          // Found or not answered for: nobody observed it end, so it may hold what it did not ship.
          if (lookup.kind !== "gone") holds.push({ sessionId: member.id, kind: "executor" });
        }
        const lease = yield* capture.repo.leaseOf(worktreeId);
        if (
          lease !== null &&
          lease.executorId !== null &&
          !lease.executorId.startsWith("mend:") &&
          !holds.some((hold) => hold.sessionId === lease.executorId)
        ) {
          const holder = members.find((member) => member.id === lease.executorId) ?? null;
          // The lease's own executor (`leaseExecutorWorkspace`): none addressable, or a holder
          // with no workspace on its row (a launch cut short around its create,
          // `launchUnresolved`), may exist and hold work — a hold, never an end.
          const judged = lease.live ? null : yield* judgeLapsedLease(holder, lease, null);
          const workspaceId = judged?.workspaceId ?? null;
          const ended = holder === null || judged?.state === "dead";
          if (ended) {
            if (!lease.live) {
              if (workspaceId !== null) yield* owedBeforeRelease(workspaceId);
              yield* capture.repo.release(worktreeId, lease.epoch);
            }
          } else {
            holds.push({ sessionId: holder.id, kind: "lease" });
          }
        }
        return holds;
      });

      /** Each executor's runtime deadline as last read (`runtimeDeadline`), and when. */
      const runtimeDeadlines = new Map<
        SealantWorkspaceId,
        { readonly at: Date | null; readonly readAtMs: number }
      >();
      /** Executors whose deadline is being read right now. */
      const deadlineReading = new Set<SealantWorkspaceId>();
      /**
       * Read when the platform itself ends this executor. A known deadline is kept (it does not
       * move); a null one is asked again on the status cadence (the runtime may not be launched
       * yet). A read that fails leaves what was known.
       */
      const readRuntimeDeadline = (session: Session, workspaceId: SealantWorkspaceId) =>
        Effect.gen(function* () {
          const workspace = yield* sealant.getWorkspace(workspaceId);
          const at = yield* sealant.runtimeDeadline(workspace);
          const previous = runtimeDeadlines.get(workspaceId);
          runtimeDeadlines.set(workspaceId, { at, readAtMs: Date.now() });
          if (at !== null && previous?.at?.getTime() !== at.getTime()) {
            yield* Effect.logInfo(
              "session engine: capture mode · the platform's deadline · observed",
            ).pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                workspaceId,
                deadline: at.toISOString(),
              }),
            );
          }
        }).pipe(
          Effect.timeout(CAPTURE_STATUS_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logDebug("session engine: runtime deadline · not read").pipe(
              Effect.annotateLogs({ sessionId: session.id, workspaceId, cause: String(cause) }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => deadlineReading.delete(workspaceId))),
        );

      /**
       * A session's executor create whose answer is not on its row (`executor_create_key`): a
       * create whose answer was lost (a timeout, a restart mid-create). The key finds what it
       * made (Core's `workspaces.findByIdempotencyKey`):
       * - `adopted`: an executor exists — it goes on the row as the session's under its launch
       *   (the key), and drains unless `drain` is false (the caller drains it itself);
       * - `reserved`: nothing is on record under the key as of the lookup — which is not proof
       *   (review 2026-09-28 (3) #21): the create may still be on its way and commit after it.
       *   The key stays, holding the worktree; a launch of the session asks the same create
       *   again under it, which can only ever make that one executor;
       * - `cancelled`: Core fenced the key (`fenceWorkspaceCreate`): nothing is made under it
       *   now or later — the key clears, and the launch's own claim on the worktree is released
       *   when no other executor of the session can hold it;
       * - `unsupported`: the SDK cannot look (0.37.2) — ownership stays unresolved, holding the
       *   worktree and removal;
       * - `unknown`: the platform did not answer, or answered what Mend does not read — looked at
       *   again next tick.
       */
      const resolveExecutorCreate = (
        sessionId: SessionId,
        key: string,
        options?: { readonly drain?: boolean },
      ) =>
        Effect.gen(function* () {
          if (capture === null) return "gone" as const;
          const lookupFailed = (error: SealantPlatformError) =>
            Effect.logWarning(
              "session engine: capture mode · executor create · lookup failed",
            ).pipe(Effect.annotateLogs({ sessionId, key, error: error.message }), Effect.as(null));
          const found = yield* sealant.findWorkspaceByKey(key).pipe(Effect.catch(lookupFailed));
          if (found === null) return "unknown" as const;
          if (found.kind === "unsupported") return "unsupported" as const;
          if (found.kind === "unknown") {
            yield* Effect.logWarning(
              "session engine: capture mode · executor create · the lookup answered what Mend does not read · unresolved",
            ).pipe(Effect.annotateLogs({ sessionId, key, detail: found.detail }));
            return "unknown" as const;
          }
          const session = yield* sessions.byId(sessionId);
          let workspaceFound = found.kind === "found" ? found.workspaceId : null;
          if (workspaceFound === null) {
            // Nothing on record yet (or a create still open under the key). Only Core's fence
            // makes that final: `cancelCreate` refuses a delayed original create for good.
            const fence =
              found.kind === "cancelled"
                ? ({ kind: "cancelled" } as const)
                : yield* sealant.fenceWorkspaceCreate(key).pipe(Effect.catch(lookupFailed));
            if (fence === null || fence.kind === "unknown" || fence.kind === "open") {
              return "unknown" as const;
            }
            if (fence.kind === "found") {
              workspaceFound = fence.workspaceId;
            } else if (fence.kind === "cancelled") {
              yield* sessions.clearExecutorCreate(sessionId, key);
              const lease = yield* capture.repo.leaseOf(session.worktreeId);
              // A lease bound to this very key is this create's, and the fence says nothing was
              // or will be made under it: released whatever the previous executor reads. The row's
              // own executor's lease (or an unbound one) only once that executor's end is read;
              // another launch's is not this one to free.
              const ofThisCreate = lease !== null && lease.launchId === key;
              const ofTheRowsExecutor =
                lease !== null &&
                !ofThisCreate &&
                ((lease.launchId ?? null) === null ||
                  (session.sealantWorkspaceId !== null &&
                    (yield* leaseExecutorWorkspace(session, lease)) ===
                      session.sealantWorkspaceId));
              const previousEnded =
                !ofTheRowsExecutor ||
                session.sealantWorkspaceId === null ||
                (yield* workspaceState(session.sealantWorkspaceId)) === "dead";
              const releasable =
                lease !== null &&
                lease.executorId === sessionId &&
                (ofThisCreate || (ofTheRowsExecutor && previousEnded));
              if (releasable) {
                if (ofTheRowsExecutor && session.sealantWorkspaceId !== null) {
                  yield* owedBeforeRelease(session.sealantWorkspaceId);
                }
                yield* capture.repo.release(session.worktreeId, lease.epoch);
              }
              yield* Effect.logInfo(
                releasable
                  ? "session engine: capture mode · executor create · fenced · none was made · lease released"
                  : "session engine: capture mode · executor create · fenced · none was made · the lease stays · its holder's end is not confirmed",
              ).pipe(Effect.annotateLogs({ sessionId, key, epoch: lease?.epoch ?? null }));
              // Found by the reaper, with no launch asking again (a launch resolves its own key
              // with `drain: false` and goes on): a session left `starting` with no executor has
              // nothing running and nothing made — it reads so (e2e run 6).
              if (
                options?.drain !== false &&
                session.sealantWorkspaceId === null &&
                session.settledAt === null
              ) {
                yield* settleSession(sessionId, "stopped", LAUNCH_CANCELLED_SUMMARY);
              }
              return "cancelled" as const;
            } else {
              yield* Effect.logInfo(
                "session engine: capture mode · executor create · none on record yet · the key stays reserved",
              ).pipe(Effect.annotateLogs({ sessionId, key }));
              return "reserved" as const;
            }
          }
          const workspaceId = SealantWorkspaceId.make(workspaceFound);
          if (session.sealantWorkspaceId === workspaceId) {
            yield* sessions.clearExecutorCreate(sessionId, key);
            return "adopted" as const;
          }
          yield* sessions.recordAcceptedWorkspace(
            sessionId,
            workspaceId,
            createAskedAtOf(key) ?? new Date(),
            key,
          );
          const workspace = yield* sealant.getWorkspace(workspaceId).pipe(Effect.option);
          if (Option.isSome(workspace)) yield* noteExecutorResource(sessionId, workspace.value);
          yield* Effect.logWarning(
            "session engine: capture mode · executor create · its answer was lost · the executor it made is the session's · draining it",
          ).pipe(Effect.annotateLogs({ sessionId, key, workspaceId }));
          if (options?.drain !== false) {
            yield* Effect.forkIn(
              stopWorkspaceIfUnleased(sessionId, { force: true, reason: "stop" }).pipe(
                Effect.flatMap((outcome) =>
                  settleInterruptedLaunch(sessionId, workspaceId, outcome),
                ),
                asSealantUser(session.ownerUserId),
              ),
              scope,
            );
          }
          return "adopted" as const;
        }).pipe(
          owned(sessionId),
          // No row: nothing of that session can register any more (its row is its identity).
          Effect.catchTag("SessionNotFoundError", () => Effect.succeed("gone" as const)),
        );

      /**
       * Found by the reaper, with no launch asking again: a session left `starting` whose lost
       * create's executor was drained and then ended has nothing running and nothing launching —
       * it reads `stopped · launch interrupted · …`, never `starting` with no executor (e2e8 (i),
       * the case e2e run 6 fixed for a create that made nothing). Only once the executor's end was
       * observed (`terminated`, `gone`); one it kept reads its drain's own words. A stop the
       * platform took whose end was not observed (`stop-requested`) reads `stopping · … · stop
       * requested · end not observed yet`, and the reaper settles it once the executor is gone
       * (review 2026-09-28 (19) #2).
       */
      const settleInterruptedLaunch = (
        sessionId: SessionId,
        workspaceId: SealantWorkspaceId,
        outcome: DrainOutcome | "none",
      ) =>
        Effect.gen(function* () {
          if (outcome !== "terminated" && outcome !== "gone" && outcome !== "stop-requested") {
            return;
          }
          const session = yield* sessions.byId(sessionId);
          const awaitingEnd =
            session.status === "stopping" && session.summary === LAUNCH_STOP_UNOBSERVED_SUMMARY;
          if (
            session.settledAt !== null ||
            (session.status !== "starting" && !awaitingEnd) ||
            session.sealantWorkspaceId !== workspaceId ||
            creatingExecutors.has(sessionId) ||
            (yield* processes.listForSession(sessionId)).some(isLiveProcess)
          ) {
            return;
          }
          if (outcome === "stop-requested") {
            if (awaitingEnd) return;
            // The words first: a restart between the two writes leaves `starting` saying what was
            // observed, never `stopping` with an older run's words.
            yield* sessions.setSummary(sessionId, LAUNCH_STOP_UNOBSERVED_SUMMARY);
            yield* sessions.setStatus(sessionId, "stopping");
            yield* Effect.logWarning(
              "session engine: capture mode · executor create · its answer was lost · stop requested · end not observed yet · stopping",
            ).pipe(Effect.annotateLogs({ sessionId, workspaceId, outcome }));
            return;
          }
          yield* settleSession(sessionId, "stopped", LAUNCH_INTERRUPTED_SUMMARY);
          yield* Effect.logInfo(
            "session engine: capture mode · executor create · its answer was lost · its executor ended · stopped",
          ).pipe(Effect.annotateLogs({ sessionId, workspaceId, outcome }));
        }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void));

      /** Every create whose answer is not on its row and that no launch here is asking. */
      const resolveExecutorCreates = Effect.fn("SessionEngine.resolveExecutorCreates")(
        function* () {
          if (capture === null) return;
          for (const pending of yield* sessions.listExecutorCreates()) {
            if (creatingExecutors.has(pending.sessionId)) continue;
            yield* resolveExecutorCreate(pending.sessionId, pending.key);
          }
        },
      );

      /** Sessions the reaper is already replacing; one replacement at a time per session. */
      const replacing = new Set<SessionId>();
      /** Sessions whose capture status a reaper tick is reading right now. */
      const statusReading = new Set<SessionId>();
      /** Sessions the owner stopped while this process replaced their executor: none relaunches. */
      const stoppedDuringReplacement = new Set<SessionId>();
      /** Sessions whose planned relaunch a launch in this process is carrying out. */
      const relaunching = new Set<SessionId>();

      /**
       * Replacement ahead of the platform's cap (`planExecutorCap`): drain, then terminate, then a
       * pickup that launches anywhere with the head plan. Death, the cap, sandbox replacement and
       * platform moves are one path. A drain that does not save postpones the replacement: the
       * workspace is kept and the next sweep tries again.
       */
      const replaceExecutor = Effect.fn("SessionEngine.replaceExecutor")(function* (
        session: Session,
      ) {
        if (capture === null || replacing.has(session.id)) return;
        replacing.add(session.id);
        const attempt = Effect.gen(function* () {
          yield* Effect.logInfo(
            "session engine: capture mode · replacing the executor before the cap",
          ).pipe(Effect.annotateLogs({ sessionId: session.id, worktreeId: session.worktreeId }));
          if (session.sealantWorkspaceId !== null) {
            const outcome = yield* drainThenTerminate(
              session.id,
              session.sealantWorkspaceId,
              "replacement",
              true,
            );
            // A stop taken whose end is not observed yet goes on too: the wait below is for the
            // lease, released on an observed end or lapsing with the executor's heartbeats.
            if (outcome !== "terminated" && outcome !== "stop-requested" && outcome !== "gone") {
              yield* Effect.logWarning(
                `session engine: capture mode · replacement postponed · ${outcome}`,
              ).pipe(Effect.annotateLogs({ sessionId: session.id }));
              return;
            }
          }
          // The lease is released once the termination is observed; when it was not, it lapses
          // with the executor's heartbeats. Wait for either, bounded.
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline && !stoppedDuringReplacement.has(session.id)) {
            const lease = yield* capture.repo.leaseOf(session.worktreeId);
            if (lease === null || !lease.live) break;
            yield* Effect.sleep(Duration.seconds(2));
          }
          // The owner stopped the session while it was being saved: saved and ended, and that is
          // all — no new executor.
          if (stoppedDuringReplacement.has(session.id)) {
            yield* Effect.logInfo(
              "session engine: capture mode · stopped during the replacement · nothing relaunched",
            ).pipe(Effect.annotateLogs({ sessionId: session.id }));
            return;
          }
          yield* resumeSession(session.id, null).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: replacement pickup failed").pipe(
                Effect.annotateLogs({ sessionId: session.id, error: String(error) }),
              ),
            ),
          );
        });
        yield* attempt.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              replacing.delete(session.id);
              stoppedDuringReplacement.delete(session.id);
            }),
          ),
        );
      });

      /** Launches a planned relaunch has tried in this process, by session: bounded. */
      const plannedLaunchAttempts = new Map<SessionId, number>();

      /**
       * A planned `launch` after a restart (review 2026-09-28 #9). A process carrying its
       * correlation id says the launch ran, not that its opening turn arrived: only a turn with
       * the correlation, durably accepted, does. So:
       * - `done`: that turn exists, the launch had no opening turn and its process ran, or the
       *   opening turn was just accepted — by the correlated process while it is live and hosted,
       *   else by another live, hosted protocol agent of the session;
       * - otherwise, with no agent live, the launch runs again (under a fresh correlation id when
       *   a process already carries the planned one), at most `PLANNED_LAUNCH_ATTEMPTS` times
       *   here;
       * - `retained`: nothing could take the turn now, or the launch failed. The plan stays for
       *   the next try, and the session says `opening prompt not delivered · …`.
       * Only `done` or the owner's stop clears the plan.
       */
      const finishPlannedLaunch = (
        sessionId: SessionId,
        plan: Extract<RelaunchPlan, { readonly kind: "launch" }>,
      ): Effect.Effect<"done" | "retained"> => {
        const retain = (why: string) =>
          Effect.gen(function* () {
            const words = `${OPENING_PROMPT_NOT_DELIVERED} · ${why}`;
            const current = yield* sessions
              .byId(sessionId)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
            // Said once per reason: the reaper asks again every tick.
            if (current !== null && current.summary !== words) {
              yield* Effect.logWarning(`session engine: ${words}`).pipe(
                Effect.annotateLogs({ sessionId, launchCorrelationId: plan.launchCorrelationId }),
              );
              yield* sessions.setSummary(sessionId, words);
            }
            return "retained" as const;
          });
        return Effect.gen(function* () {
          const prompt = plan.start?.prompt?.trim() ?? "";
          if (
            prompt !== "" &&
            (yield* conversations.byLaunchCorrelation(sessionId, plan.launchCorrelationId)) !== null
          ) {
            return "done" as const;
          }
          const correlated = yield* processes.byLaunchCorrelation(plan.launchCorrelationId);
          if (prompt === "" && correlated !== null) return "done" as const;
          if (prompt !== "") {
            // Whoever can take the opening turn now: the correlated process first, then any live
            // protocol agent of the session that is hosted here.
            const candidates = [
              ...(correlated === null ? [] : [correlated]),
              ...(yield* processes.listForSession(sessionId)),
            ];
            for (const candidate of candidates) {
              if (
                candidate.sessionId !== sessionId ||
                candidate.kind !== "agent-protocol" ||
                !isLiveAgentProcess(candidate) ||
                !(yield* protocolHost.has(candidate.id))
              ) {
                continue;
              }
              yield* protocolHost.submitTurn(
                sessionId,
                prompt,
                plan.author,
                plan.launchCorrelationId,
              );
              plannedLaunchAttempts.delete(sessionId);
              return "done" as const;
            }
          }
          if (yield* agentIsLive(yield* sessions.byId(sessionId))) {
            return yield* retain("the agent runs but cannot take it now");
          }
          const attempts = (plannedLaunchAttempts.get(sessionId) ?? 0) + 1;
          if (attempts > PLANNED_LAUNCH_ATTEMPTS) {
            return yield* retain(`${PLANNED_LAUNCH_ATTEMPTS} launches did not take it`);
          }
          plannedLaunchAttempts.set(sessionId, attempts);
          // A correlation id a process already carries is spent (one process per id): the
          // relaunch plan takes the fresh one before the old executor drains (`launchInternal`).
          const correlation =
            correlated === null ? plan.launchCorrelationId : `relaunch:${crypto.randomUUID()}`;
          // The harness's saved state when there is one; a process that ended before anything
          // harvested it leaves none, and the opening prompt still goes (a protocol start resumes
          // by its own id).
          const state = yield* harnessStateFor(yield* sessions.byId(sessionId)).pipe(
            Effect.catchTag("HarnessStateNotFoundError", () => Effect.succeed(null)),
          );
          yield* launchInternalBody(
            sessionId,
            plan.argv,
            null,
            state,
            correlation,
            plan.start,
            plan.author,
            plan.resumeId,
          );
          plannedLaunchAttempts.delete(sessionId);
          return "done" as const;
        }).pipe(Effect.catch((error) => retain(`the launch failed · ${error.message}`)));
      };

      /**
       * Take up a durable drain intent no fiber in this process is running — after a restart, or
       * after a drain that kept its workspace: a stop finishes its tail (harvest, then the
       * drain); a relaunch or a replacement drains and terminates.
       */
      const resumeDrain = (session: Session) =>
        Effect.gen(function* () {
          const workspaceId = session.sealantWorkspaceId;
          // A relaunch's last step: the launch it planned (`RelaunchPlan`). Taken up only when no
          // launch here is carrying it out.
          const finishRelaunch = Effect.gen(function* () {
            const stored = yield* sessions.relaunchOf(session.id);
            if (stored === null || relaunching.has(session.id)) return;
            const plan = readRelaunchPlan(stored);
            relaunching.add(session.id);
            yield* Effect.logInfo(
              "session engine: capture mode · finishing a relaunch after a restart",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, kind: plan.kind }));
            // Kept until the attempt has run its course, so a restart in the middle tries again;
            // the correlation id makes the launch and its opening turn happen once. A launch
            // whose opening turn was not accepted keeps its plan (`finishPlannedLaunch`).
            const attempt: Effect.Effect<"done" | "retained"> =
              plan.kind === "launch"
                ? finishPlannedLaunch(session.id, plan)
                : resumeSession(session.id, plan.harness).pipe(
                    Effect.as("done" as const),
                    Effect.catch((error) =>
                      Effect.logWarning("session engine: the relaunch could not be finished").pipe(
                        Effect.annotateLogs({ sessionId: session.id, error: String(error) }),
                        Effect.as("done" as const),
                      ),
                    ),
                  );
            yield* attempt.pipe(
              Effect.onExit((exit) =>
                Effect.suspend(() => {
                  relaunching.delete(session.id);
                  return Exit.isSuccess(exit) && exit.value === "done"
                    ? sessions.clearRelaunch(session.id)
                    : Effect.void;
                }),
              ),
            );
          });
          if (session.captureDrain === null) {
            yield* finishRelaunch;
            return;
          }
          if (workspaceId === null) {
            yield* endDrain(session.id);
            yield* removeIfRequested(session.id);
            yield* finishRelaunch;
            return;
          }
          if (session.captureDrain === "replacement") {
            yield* replaceExecutor(session);
            return;
          }
          // A relaunch the owner's stop cancelled drains as a stop does: whatever runs in the
          // workspace now is theirs.
          if (
            session.captureDrain === "relaunch" &&
            (yield* sessions.relaunchOf(session.id)) !== null
          ) {
            const outcome = yield* drainThenTerminate(session.id, workspaceId, "relaunch", true);
            if (outcome === "terminated" || outcome === "stop-requested" || outcome === "gone") {
              yield* finishRelaunch;
            }
            return;
          }
          yield* sweepWorkspace(session.id);
        }).pipe(
          asSealantUser(session.ownerUserId),
          Effect.catchCause((cause) =>
            Effect.logWarning("session engine: a drain could not be taken up").pipe(
              Effect.annotateLogs({ sessionId: session.id, cause: String(cause) }),
            ),
          ),
        );

      /**
       * The lease reaper (every 10 s):
       * - drains no fiber here is running are taken up again, and removals whose workspace has
       *   gone happen;
       * - a session that reads live whose lease expired is a dead or paused executor. A positively
       *   dead one (`workspaceState`) settles honestly — "executor lost · lease expired" — and the
       *   next resume is a pickup; an answering one paused itself on the lost heartbeat and resumes
       *   on its own once heartbeats land again, and one the platform did not answer for is looked
       *   at again next tick: nothing is killed either way;
       * - a live lease whose planned drain is due (`planExecutorCap`) is replaced.
       */
      const captureReaper = Effect.fn("SessionEngine.captureReaper")(function* () {
        if (capture === null) return;
        yield* reconcileStaleRuns();
        yield* resolveExecutorCreates();
        const unanswered = new Set(
          (yield* sessions.listExecutorCreates()).map((pending) => pending.sessionId),
        );
        for (const session of yield* sessions.listCaptureDrains()) {
          const workspaceId = session.sealantWorkspaceId;
          if (stopTails.has(session.id) || replacing.has(session.id)) continue;
          if (relaunching.has(session.id)) continue;
          if (workspaceId !== null && drains.has(workspaceId)) continue;
          // Kept, and nothing changed since: wait (10 s doubling to 5 min) rather than flush again.
          if (yield* keptDrainWaits(session)) continue;
          yield* Effect.forkIn(resumeDrain(session), scope);
        }
        for (const session of yield* sessions.listRemovalRequested()) {
          const workspaceId = session.sealantWorkspaceId;
          if (session.captureDrain !== null || stopTails.has(session.id)) continue;
          if (workspaceId !== null && drains.has(workspaceId)) continue;
          yield* Effect.forkIn(
            stopWorkspaceIfUnleased(session.id).pipe(asSealantUser(session.ownerUserId)),
            scope,
          );
        }
        const unsettled = yield* sessions.listUnsettled();
        // Saved and asked to stop, its termination not observed then: `stopping` until the
        // platform reports the workspace gone, and settled then.
        for (const session of unsettled) {
          if (session.status !== "stopping" || session.captureDrain !== null) continue;
          if (stopTails.has(session.id) || investigatingEnds.has(session.id)) continue;
          const workspaceId = session.sealantWorkspaceId;
          if (workspaceId !== null && drains.has(workspaceId)) continue;
          const gone =
            workspaceId === null ||
            (yield* lookupWorkspace(workspaceId).pipe(asSealantUser(session.ownerUserId))).kind ===
              "gone";
          if (!gone) continue;
          // A lost create's executor whose stop was taken and not seen to end: ended now.
          if (workspaceId !== null && session.summary === LAUNCH_STOP_UNOBSERVED_SUMMARY) {
            yield* settleInterruptedLaunch(session.id, workspaceId, "gone");
          } else {
            yield* settleIfStopping(session.id);
          }
        }
        const active = unsettled.filter((session) => ACTIVE_STATUSES.has(session.status));
        for (const session of active) {
          if (session.sealantWorkspaceId === null) continue;
          // Its row names a previous executor while a create's answer is not on it: the lease is
          // the unseen one's (`resolveExecutorCreate`).
          if (unanswered.has(session.id)) continue;
          const lease = yield* capture.repo.leaseOf(session.worktreeId);
          if (lease === null || lease.executorId !== session.id) continue;
          if (lease.live) {
            if (drains.has(session.sealantWorkspaceId) || session.captureDrain !== null) continue;
            // What the executor holds between flushes, and whether its snaps are failing: a
            // status read every `statusInterval` (nothing flushed, nothing snapped).
            const lastRead = statusReads.get(session.id);
            if (
              !statusReading.has(session.id) &&
              (lastRead === undefined ||
                Date.now() - lastRead >= Duration.toMillis(drainPolicy.statusInterval))
            ) {
              statusReading.add(session.id);
              yield* Effect.forkIn(
                readCaptureStatusOf(session.id, Duration.toMillis(drainPolicy.statusInterval)).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("session engine: capture status read failed").pipe(
                      Effect.annotateLogs({ sessionId: session.id, cause: String(cause) }),
                    ),
                  ),
                  Effect.ensuring(Effect.sync(() => statusReading.delete(session.id))),
                ),
                scope,
              );
            }
            // The platform's own deadline for this executor (`runtimeDeadline`), read in the
            // background and kept once known; null until then, or where the runtime has none.
            const deadline = runtimeDeadlines.get(session.sealantWorkspaceId);
            if (
              !deadlineReading.has(session.sealantWorkspaceId) &&
              (deadline === undefined ||
                (deadline.at === null &&
                  Date.now() - deadline.readAtMs >= Duration.toMillis(drainPolicy.statusInterval)))
            ) {
              deadlineReading.add(session.sealantWorkspaceId);
              yield* Effect.forkIn(
                readRuntimeDeadline(session, session.sealantWorkspaceId).pipe(
                  asSealantUser(session.ownerUserId),
                ),
                scope,
              );
            }
            // Rows from before the executor's start was stamped count from their latest run.
            const executorStartedAt =
              session.executorStartedAt ??
              (yield* sessionRuns.latestForSession(session.id))?.startedAt ??
              null;
            // What this executor was observed to ship (`observeCaptureThroughput`), against what
            // it was last seen holding: the lead grows with what is pending at that rate.
            const throughput = throughputs.get(session.sealantWorkspaceId) ?? null;
            const plan = planExecutorCap({
              executorStartedAt,
              // `workspace.runtimeDeadline()` once the SDK reports it (Core's next SDK); SDK
              // 0.37.2 answers null and the configuration or the fallback age plans the drain
              // (PLATFORM-FEEDBACK.md 2026-09-27, "The runtime deadline").
              platformDeadline: deadline?.at ?? null,
              maxSeconds: drainPolicy.executorMaxSeconds,
              drainEstimateSeconds: drainPolicy.drainEstimateSeconds,
              marginSeconds: drainPolicy.deadlineMarginSeconds,
              fallbackAgeSeconds: REPLACEMENT_AGE_SECONDS,
              pendingBytes: session.capturePendingBytes,
              bytesPerSecond: throughput?.bytesPerSecond ?? null,
              pendingObjects: session.capturePending,
              objectsPerSecond: throughput?.objectsPerSecond ?? null,
            });
            if (executorCapDue(plan, Date.now())) {
              yield* Effect.logInfo("session engine: capture mode · planned drain due").pipe(
                Effect.annotateLogs({
                  sessionId: session.id,
                  source: plan.kind === "planned" ? plan.source : null,
                  deadline: plan.kind === "planned" ? (plan.deadline?.toISOString() ?? null) : null,
                }),
              );
              yield* Effect.forkIn(
                replaceExecutor(session).pipe(asSealantUser(session.ownerUserId)),
                scope,
              );
            }
            continue;
          }
          if (lease.expiresAt === null) continue;
          const judged = yield* judgeLapsedLease(session, lease, null);
          if (judged.workspaceId !== session.sealantWorkspaceId) {
            // The lease is an earlier launch's, not the row's executor's: nothing of the row's is
            // picked up over it. Released only once that launch's own executor is judged ended.
            if (judged.state === "dead") {
              // Work put off for that executor runs first, as at every other release.
              if (judged.workspaceId !== null) yield* owedBeforeRelease(judged.workspaceId);
              yield* capture.repo.release(session.worktreeId, lease.epoch);
              yield* Effect.logInfo(
                "session engine: capture mode · a lapsed lease of an earlier launch · its executor ended · released",
              ).pipe(Effect.annotateLogs({ sessionId: session.id, epoch: lease.epoch }));
            }
            continue;
          }
          const state = judged.state;
          if (state === "kept") {
            // Ended on its runtime, kept by the platform for recovery (e2e run 5): not dead, not
            // picked up. Its lease and its token stay; the stop drain asks Core what it is and
            // reads `not saved · executor kept for recovery` until Core confirms an end.
            yield* Effect.logWarning(
              "session engine: capture mode · lease expired · the platform keeps the executor · nothing released",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, epoch: lease.epoch }));
            yield* Effect.forkIn(
              stopWorkspaceQuietly(session.id, { force: true, reason: "stop" }).pipe(
                asSealantUser(session.ownerUserId),
              ),
              scope,
            );
            continue;
          }
          if (state !== "dead") {
            yield* Effect.logInfo(
              state === "answering"
                ? "session engine: capture mode · lease expired but the executor answers · paused until its heartbeat lands"
                : "session engine: capture mode · lease expired · the platform did not answer · looking again next tick",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, epoch: lease.epoch }));
            continue;
          }
          yield* confirmDeadExecutor(session).pipe(
            asSealantUser(session.ownerUserId),
            Effect.catch((error) =>
              Effect.logWarning(
                "session engine: capture reaper could not settle a lost executor",
              ).pipe(Effect.annotateLogs({ sessionId: session.id, error: String(error) })),
            ),
          );
        }
      });
      /**
       * The network session channel (docs/KUBERNETES.md): when configured, every workspace is
       * told where the channel is and handed a per-session bearer token through the SECRET env
       * channel (so the platform's recorder redacts it). The token grants exactly what the
       * socket grants — this session's closures — and is revoked with the workspace.
       */
      const sessionChannelLaunchEnv = (sessionId: SessionId, launchId: string) =>
        Effect.gen(function* () {
          const endpoint = deployment.sessionEndpoint;
          if (endpoint === undefined) {
            return { env: {}, secretEnv: {} };
          }
          // A token for this launch alone (cross-repo decision 5): another launch's stays valid.
          const token = yield* channelTokens.issue(sessionId, launchId);
          return {
            env: { MEND_SESSION_ENDPOINT: endpoint.url, MEND_SESSION_ID: sessionId },
            secretEnv: { MEND_SESSION_TOKEN: token },
          };
        });
      const protocolHost = yield* ProtocolHost;
      const sessions = yield* SessionsRepo;
      const hotWorkspaces = yield* HotWorkspacesRepo;
      const userDotfilesRepo = yield* UserDotfilesRepo;
      const gitAuthors = yield* UserGitAuthorRepo;
      const gitHooks = yield* WorkspaceGitHooks;
      const dotfilesStore = yield* DotfilesStore;
      const dotfilesCloner = yield* DotfilesCloner;
      const skillsRepo = yield* SkillsRepo;
      const piProfiles = yield* PiProfilesRepo;
      const agentMemory = yield* AgentMemoryRepo;
      const secretFiles = yield* SecretFilesRepo;
      const sessionRuns = yield* SessionRunsRepo;
      const processes = yield* SessionProcessesRepo;

      // ── A session and its run never disagree ─────────────────────────────────
      // `session_runs` is Mend's index over the records a session ran as: one open run per
      // session (`session_runs_one_active_idx`). A session settled while its run stayed `running`
      // (2026-10-03: a replacement launch that never reached its control socket, settled by the
      // leftover sweep) met that index at every later resume, as an unhandled 500. So every
      // settle of a session goes through `settleSession`, which settles the run with it; what was
      // left inconsistent before is reconciled by `reconcileStaleRuns` at startup and on every
      // reaper tick; and a run insert the index refuses is answered in words (`createSessionRun`).

      /**
       * A settled session's open run, if any, settles with the session's own outcome and
       * summary. Only over a session that reads settled: one a stop drain holds reads `stopping`,
       * unsettled, and keeps its run until the drain ends and the session settles for real. Never
       * a run a live process row of the session still names: that is live work, and a session
       * settled over it is the fold's to reopen, not this path's to end. Never a run recorded
       * after the session settled: that is the next launch's, inserted before its process row
       * and its reopen are written (a protocol resume records the run first), and this look, a
       * reaper tick that read the session before the launch, has no say over it. Answers the run
       * it settled, or null.
       */
      const settleRunsOfSettled = Effect.fn("SessionEngine.settleRunsOfSettled")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null || session.settledAt === null) return null;
        const outcome = settledOutcomeOfStatus(session.status);
        if (outcome === null) return null;
        const activeRun = yield* sessionRuns.activeForSession(sessionId);
        if (activeRun === null) return null;
        if (activeRun.createdAt.getTime() > session.settledAt.getTime()) return null;
        const rows = yield* processes.listForSession(sessionId);
        if (
          rows.some(
            (process) => isLiveProcess(process) && process.sealantRunId === activeRun.sealantRunId,
          )
        ) {
          yield* Effect.logWarning(
            "session engine: a settled session's run is carried by a live process · left open",
          ).pipe(Effect.annotateLogs({ sessionId, sealantRunId: activeRun.sealantRunId }));
          return null;
        }
        yield* sessionRuns.settle(activeRun.sealantRunId, outcome, session.summary);
        return activeRun;
      });

      /**
       * The one place a session settles (`SessionsRepo.settle`, first settle wins): its open run
       * settles with it, with the words that stood. A path that settled the run first with words
       * of its own (a stop, a lost executor, a run's own end) finds no open run here and keeps
       * them.
       */
      const settleSession = Effect.fn("SessionEngine.settleSession")(function* (
        sessionId: SessionId,
        outcome: SessionOutcome,
        summary: string | null,
      ) {
        yield* sessions.settle(sessionId, outcome, summary);
        yield* settleRunsOfSettled(sessionId);
      });

      /**
       * Runs left `running` under sessions that settled, each settled with its session's outcome
       * and summary and said once. Startup runs it and the lease reaper every tick. A run whose
       * session is not settled is live work, or the fold's to settle: left alone.
       */
      const reconcileStaleRuns = Effect.fn("SessionEngine.reconcileStaleRuns")(function* () {
        for (const run of yield* sessionRuns.listActive()) {
          const session = yield* sessions
            .byId(run.sessionId)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
          if (session === null || session.settledAt === null) continue;
          const settled = yield* settleRunsOfSettled(session.id);
          if (settled === null) continue;
          yield* Effect.logInfo(
            "session engine: a run left open under a settled session · settled with it",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              sealantRunId: settled.sealantRunId,
              outcome: session.status,
              summary: session.summary,
            }),
          );
        }
      });

      /**
       * Record a new run of a session (`SessionRunsRepo.create`). A run of the session still
       * open refuses the insert. One that is stale settles first and the insert is asked once
       * more: a run of a session that reads settled takes the session's words
       * (`settleRunsOfSettled`); one whose process rows all ended, under a session that did not
       * settle, takes its process's end (`exited with code 1`, else `end not recorded`). A run
       * that is live is refused in words, `run_active`, and nothing is settled: one a live process
       * row carries, and one no process row names at all under a session that is not settled (a
       * run attached from outside is supervised without a row, as `agentIsLive` and the fold
       * read it, and so is a run another launch recorded a moment ago).
       */
      const createSessionRun = Effect.fn("SessionEngine.createSessionRun")(function* (
        input: NewSessionRun,
      ) {
        return yield* sessionRuns.create(input).pipe(
          Effect.catchTag("SessionRunActiveError", (error) =>
            Effect.gen(function* () {
              const stale = error.activeRun;
              const rows = yield* processes.listForSession(input.sessionId);
              const carriers = rows.filter(
                (process) => process.sealantRunId === stale.sealantRunId,
              );
              if (carriers.some(isLiveProcess)) return yield* runActiveRefusal(stale);
              const settledWithSession = yield* settleRunsOfSettled(input.sessionId);
              if (settledWithSession === null) {
                const carrier = currentAgentProcess(carriers);
                if (carrier === null) return yield* runActiveRefusal(stale);
                yield* sessionRuns.settle(
                  stale.sealantRunId,
                  agentProcessOutcome(carrier) ?? "failed",
                  carrier.exitCode === null
                    ? RUN_SUPERSEDED_SUMMARY
                    : `exited with code ${carrier.exitCode}`,
                );
              }
              yield* Effect.logWarning(
                "session engine: a run left open settled before the next run of its session",
              ).pipe(
                Effect.annotateLogs({
                  sessionId: input.sessionId,
                  staleRunId: stale.sealantRunId,
                  sealantRunId: input.sealantRunId,
                }),
              );
              return yield* sessionRuns
                .create(input)
                .pipe(
                  Effect.catchTag("SessionRunActiveError", (again) =>
                    runActiveRefusal(again.activeRun),
                  ),
                );
            }),
          ),
        );
      });

      const services = yield* ServicesRepo;
      const serviceForwards = yield* ServiceForwardsRepo;
      const serviceObservations = yield* ServiceObservationsRepo;
      const serviceHost = yield* ServiceHost;
      const socketHost = yield* SessionSocketHost;
      const projects = yield* ProjectsRepo;
      const changes = yield* WorktreeChangesRepo;
      const worktreesRepo = yield* WorktreesRepo;
      const checkpoints = yield* CheckpointsRepo;
      const references = yield* ReferencesRepo;
      const projectMounts = yield* ProjectMountsRepo;
      const projectLinks = yield* ProjectLinksRepo;
      const sessionRepositories = yield* SessionRepositoriesRepo;
      const organizations = yield* OrganizationsRepo;
      const foldersRepo = yield* FoldersRepo;
      const sourcePolicy = yield* SourcePolicy;
      // A workspace's git transport signs with its owner's key, so by default it only reaches the
      // project's own remote (docs/adr/0003, "Multi mode gate"). An operator may turn that off on
      // a machine they alone use, for mirrors and forks.
      const bindTransportToOrigin = yield* Config.boolean("MEND_GIT_TRANSPORT_BIND_ORIGIN").pipe(
        Config.withDefault(true),
        Effect.orElseSucceed(() => true),
      );
      const projectEnvironment = yield* ProjectEnvironmentRepo;
      const projectSecrets = yield* ProjectSecretsRepo;
      const projectClusterBindings = yield* ProjectClusterBindingsRepo;
      const secretCipher = yield* SecretCipher;
      const projectRecipes = yield* ProjectServiceRecipesRepo;
      const settingsRepo = yield* SettingsRepo;
      const sessionRepo = yield* SessionRepository;
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

      /**
       * Capture mode's one writer of a worktree's checkpoint rows: a per-worktree permit in this
       * process (the engine is the only process that allocates ordinals). The advisory lock the
       * co-located store takes is bypassed here — transaction-mode pooling drops it (ADR-0002) —
       * and without a permit a run-end `turn-boundary` checkpoint and a user mark both read
       * `count = N`, both derive on the runner, and the second insert hits the unique
       * `(worktree_id, ordinal)` index (observed: the packaged acceptance's user mark answered
       * 500). Permits are never dropped; one per worktree that took a checkpoint is the cost.
       */
      const checkpointWriters = new Map<WorktreeId, Semaphore.Semaphore>();
      const withCheckpointWriter = <A, E, R>(
        worktreeId: WorktreeId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => {
        const existing = checkpointWriters.get(worktreeId);
        const writer = existing ?? Semaphore.makeUnsafe(1);
        if (existing === undefined) checkpointWriters.set(worktreeId, writer);
        return writer.withPermit(effect);
      };

      /**
       * Snapshot the WORKTREE's chain: the per-worktree advisory lock serializes
       * concurrent writers (two live sessions settling at once) around the
       * read-count/snapshot/insert critical section — it also keeps the two
       * `git add -A` passes over the shared directory from interleaving. In
       * capture mode the writer permit above takes the lock's place. Either way
       * the unique `(worktree_id, ordinal)` index is the backstop, and a taken
       * ordinal is answered, never a defect: the same snapshot already recorded
       * is returned as it stands; a different one re-reads the chain and takes
       * the next ordinal, once.
       */
      const takeWorktreeSnapshot = Effect.fn("SessionEngine.takeWorktreeSnapshot")(function* (
        worktree: Worktree,
        trigger: CheckpointTrigger,
        sessionId: SessionId | null,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
        /**
         * A landing's checkpoint: refused (`CapturesBehindError`) unless the flush caught the
         * registered head up with the executor, or it is known nothing more is held.
         */
        requireCaughtUp: boolean,
        /**
         * What the drain's own final flush observed of the executor, when the checkpoint was put
         * off until it (`deferToFinal`): no flush is asked for, that one stands for it.
         */
        observedByDrain?: CaptureFlushObservation,
      ) {
        const attempt = (
          retry: boolean,
        ): Effect.Effect<
          { readonly checkpoint: Checkpoint; readonly captureId: string | null },
          SessionRepositoryError | CapturesBehindError
        > =>
          Effect.gen(function* () {
            const previous = yield* checkpoints.latestForWorktree(worktree.id);
            const ordinal = yield* checkpoints.countForWorktree(worktree.id);
            // Capture mode: the lease holder flushes first, so the head this checkpoint is
            // observed from is the disk as of now. A flush that does not complete costs nothing
            // but the wait for a capture to land — except for a landing, which needs the disk.
            const observed =
              observedByDrain ?? (yield* flushLeaseHolder(worktree.id, `checkpoint · ${trigger}`));
            if (requireCaughtUp && observed === "incomplete") {
              return yield* new CapturesBehindError({ worktreeId: worktree.id, attempts: 1 });
            }
            const flushed = observed === "flushed";
            const snapshot = yield* sessionRepo.checkpoint({
              projectId: worktree.projectId,
              scope: worktree.id,
              worktreeName: worktree.directory,
              index: ordinal,
              parent: previous?.sha ?? null,
              flushed,
            });
            const captureId = snapshot.captureId ?? null;
            const checkpoint = yield* checkpoints
              .create({
                worktreeId: worktree.id,
                sessionId,
                ordinal,
                ref: snapshot.ref,
                sha: snapshot.sha,
                sealantRunId: cursor.sealantRunId,
                seq: cursor.sequence,
                trigger,
                captureId,
              })
              .pipe(
                Effect.catchTag("CheckpointOrdinalTakenError", (taken) =>
                  Effect.gen(function* () {
                    const annotations = {
                      worktreeId: worktree.id,
                      ordinal,
                      trigger,
                      existingTrigger: taken.existing.trigger,
                      existingSha: taken.existing.sha,
                      sha: snapshot.sha,
                    };
                    if (taken.existing.sha === snapshot.sha) {
                      yield* Effect.logInfo(
                        "session engine: checkpoint ordinal taken · same snapshot · observed",
                      ).pipe(Effect.annotateLogs(annotations));
                      return taken.existing;
                    }
                    if (!retry) {
                      return yield* Effect.die(
                        `checkpoint ordinal ${ordinal} of worktree ${worktree.id} was taken twice underneath the writer`,
                      );
                    }
                    yield* Effect.logWarning(
                      "session engine: checkpoint ordinal taken · re-reading the chain",
                    ).pipe(Effect.annotateLogs(annotations));
                    return (yield* attempt(false)).checkpoint;
                  }),
                ),
              );
            return { checkpoint, captureId };
          });
        return yield* capture === null
          ? checkpoints.withWorktreeLock(worktree.id, attempt(true))
          : withCheckpointWriter(worktree.id, attempt(true));
      });

      const takeWorktreeCheckpoint = (
        worktree: Worktree,
        trigger: CheckpointTrigger,
        sessionId: SessionId | null,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
        observed?: CaptureFlushObservation,
      ): Effect.Effect<Checkpoint, SessionRepositoryError> =>
        takeWorktreeSnapshot(worktree, trigger, sessionId, cursor, false, observed).pipe(
          Effect.map((taken) => taken.checkpoint),
          // Only a landing's snapshot requires the captures caught up.
          Effect.catchTag("CapturesBehindError", (error) => Effect.die(error)),
        );

      const takeCheckpoint = Effect.fn("SessionEngine.takeCheckpoint")(function* (
        session: Session,
        trigger: CheckpointTrigger,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
        observed?: CaptureFlushObservation,
      ) {
        // The FK guarantees the row; a miss here is corruption, not a condition.
        const worktree = yield* worktreesRepo.byId(session.worktreeId).pipe(Effect.orDie);
        return yield* takeWorktreeCheckpoint(worktree, trigger, session.id, cursor, observed);
      });

      /** A checkpoint that cannot be taken is a gap, carried as content — never a crash. */
      const tryCheckpoint = (
        session: Session,
        trigger: CheckpointTrigger,
        cursor: { readonly sealantRunId: SealantRunId | null; readonly sequence: bigint },
        observed?: CaptureFlushObservation,
      ) =>
        takeCheckpoint(session, trigger, cursor, observed).pipe(
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
        const change = yield* changes.byWorktree(session.worktreeId);
        if (change === null) return;
        const latest = yield* checkpoints.latestForWorktree(session.worktreeId);
        // The refresh stamps this session as the change's last contributor.
        if (latest !== null) yield* changes.refreshHead(change.id, latest.sha, session.id);
      });

      const supervise = Effect.fn("SessionEngine.supervise")(function* (
        session: Session,
        sessionRun: SessionRun,
        sdkRun: SdkRun,
      ) {
        // The first output the record carries is when the agent drew its first screen: its
        // process row says so and the session line stops saying it is starting. Stamped before
        // the cursor moves past it, so a restart that resumes after it has nothing to miss.
        let firstOutputSeen = false;
        yield* sealant.recordStream(sdkRun, { from: sessionRun.lastSeenSequence }).pipe(
          Stream.tap((entry) =>
            Effect.gen(function* () {
              if (!firstOutputSeen && isOutputEntry(entry)) {
                firstOutputSeen = true;
                yield* noteFirstOutput(session.id, sessionRun.sealantRunId, entry.occurredAt);
              }
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

      /**
       * The agent process of this run drew its first output at `occurredAt`: stamp its row once,
       * and take the starting words off the session line (`agentStartingWords`). Best-effort: a
       * failed write leaves the words for the next start or the process's end to clear.
       */
      const noteFirstOutput = (
        sessionId: SessionId,
        sealantRunId: SealantRunId,
        occurredAt: string,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const agentProcess = yield* agentProcessForRun(sessionId, sealantRunId);
          if (agentProcess === null || agentProcess.firstOutputAt !== null) return;
          const observed = new Date(occurredAt);
          const at = Number.isNaN(observed.getTime()) ? new Date() : observed;
          const stamped = yield* processes.markFirstOutput(agentProcess.id, at);
          if (stamped) yield* clearAgentStartingWords(sessionId);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session engine: first output not recorded").pipe(
              Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
            ),
          ),
        );

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
            yield* settleSession(
              sessionId,
              "failed",
              `run ${sealantRunId} is missing from the session record index`,
            );
            return;
          }
          // A session with no owner has nobody to read its run as; retrying would never succeed.
          if (current.ownerUserId === null) {
            return yield* failRun(
              sessionId,
              sealantRunId,
              "this session has no owner to run as; start a new session",
            );
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

      /**
       * The credential env for freshening a session's base at provision — BEST-EFFORT by
       * design: provisioning must survive a disconnected bridge or a broken key the way it
       * survives an unreachable remote (the fetch itself is already best-effort). Null means
       * "skip the fetch", with the reason logged, never a refused session.
       */
      const provisionRemoteEnv = Effect.fn("SessionEngine.provisionRemoteEnv")(function* (
        project: Project,
        ownerUserId: string | null,
      ) {
        return yield* resolveRemoteEnv(project.gitAuthMode, ownerUserId).pipe(
          Effect.provideService(MendKeys, mendKeys),
          Effect.provideService(AgentBridge, agentBridge),
          Effect.catch((error) =>
            Effect.logInfo("session engine: base freshen skipped — no credentials").pipe(
              Effect.annotateLogs({
                projectId: project.id,
                gitAuthMode: project.gitAuthMode,
                reason: error.message,
              }),
              Effect.as(null),
            ),
          ),
        );
      });

      /** Join guard: a durable worktree is never silently re-based. */
      const refuseBaseConflict = (worktree: Worktree, base: string | null) =>
        base === null || base === worktree.baseRef || base === worktree.baseSha
          ? Effect.void
          : new WorktreeBaseConflictError({
              worktreeId: worktree.id,
              name: worktree.name,
              requestedBase: base,
              baseRef: worktree.baseRef,
            });

      /**
       * The container half of provisioning: return the named worktree (join)
       * or create it — git worktree, row, ordinal-0 checkpoint (the place's
       * base state, no session attached), change row. A worktree with zero
       * sessions is a legal durable place.
       */
      const ensureWorktreeIn = Effect.fn("SessionEngine.ensureWorktreeIn")(function* (
        project: Project,
        input: { readonly name: string | null; readonly base: string | null },
        ownerUserId: string | null,
      ) {
        yield* refuseUnsupportedProject(project);
        if (input.name !== null) {
          const existing = yield* worktreesRepo.byName(project.id, input.name);
          if (existing !== null) {
            yield* refuseBaseConflict(existing, input.base);
            return existing;
          }
        }
        return yield* createWorktreeIn(project, input, ownerUserId);
      });

      /**
       * The create half of `ensureWorktreeIn`, never a join: a name already taken fails at the
       * worktrees table's unique name (or at the branch ref before it), so a caller that must not
       * join an existing worktree (a repository in a session, docs/adr/0010) cannot be handed one
       * made between its check and its create.
       */
      const createWorktreeIn = Effect.fn("SessionEngine.createWorktreeIn")(function* (
        project: Project,
        input: { readonly name: string | null; readonly base: string | null },
        ownerUserId: string | null,
      ) {
        const remoteEnv = yield* provisionRemoteEnv(project, ownerUserId);
        const worktreeId = WorktreeId.make(crypto.randomUUID());
        const identity = worktreeIdentityFor(worktreeId, input.name);
        const created = yield* sessionRepo.createWorktree(
          project.id,
          identity,
          input.base,
          remoteEnv,
        );
        const row = yield* worktreesRepo.create({
          id: worktreeId,
          projectId: project.id,
          name: input.name ?? identity.directory,
          directory: identity.directory,
          branch: created.branch,
          baseSha: created.baseSha,
          baseRef: created.baseRef,
        });
        // Capture mode: capture 0, the lease and the chain rows follow the worktree row at once
        // (ADR-0002 "Decisions made here" 6); the co-located adapter has nothing to attach.
        if (sessionRepo.attachWorktree !== undefined) {
          yield* sessionRepo.attachWorktree(project.id, row.id);
        }
        yield* takeWorktreeCheckpoint(row, "session-start", null, {
          sealantRunId: null,
          sequence: 0n,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: worktree-start checkpoint failed").pipe(
              Effect.annotateLogs({ worktreeId: row.id, error: String(error) }),
              Effect.as(null),
            ),
          ),
        );
        yield* changes.ensureForWorktree(project.id, row.id, row.branch, row.baseSha);
        return row;
      });

      /** A new conversation inside a worktree: session row + its start checkpoint. */
      const provisionSessionIn = Effect.fn("SessionEngine.provisionSessionIn")(function* (
        project: Project,
        worktree: Worktree,
        input: {
          readonly harness: string;
          readonly label: string | null;
          readonly ownerUserId: string | null;
          readonly origin?: SessionOrigin;
          readonly autoLand?: boolean | null;
        },
      ) {
        const session = yield* sessions.create({
          id: SessionId.make(crypto.randomUUID()),
          projectId: project.id,
          worktreeId: worktree.id,
          harness: input.harness,
          label: input.label,
          ownerUserId: input.ownerUserId,
          origin: input.origin ?? "mend",
          autoLand: input.autoLand ?? null,
          worktree: worktree.directory,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
          // Legacy rows never recorded the human base name; the pinned sha is the honest stand-in.
          baseRef: worktree.baseRef ?? worktree.baseSha,
          contextSnapshotId: null,
        });
        yield* tryCheckpoint(session, "session-start", { sealantRunId: null, sequence: 0n });
        return session;
      });

      /**
       * A new conversation in a worktree, hot when the pool can serve it (ADR-0001): a standby
       * skeleton serves ANY worktree — new, joined, or one that already holds sessions — because
       * the pool mounts the project's worktrees root and the launch binds this one. Any failure
       * here falls back to the cold path; a claim must never cost a session.
       */
      const provisionInWorktree = Effect.fn("SessionEngine.provisionInWorktree")(function* (
        project: Project,
        worktree: Worktree,
        input: {
          readonly harness: string;
          readonly label: string | null;
          readonly ownerUserId: string | null;
          readonly origin?: SessionOrigin;
          readonly autoLand?: boolean | null;
        },
      ) {
        if (project.hotSessions > 0) {
          const claimed = yield* claimHotSession(project, worktree, input).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: hot claim failed — cold provision").pipe(
                Effect.annotateLogs({ projectId: project.id, error: String(error) }),
                Effect.as(null),
              ),
            ),
          );
          if (claimed !== null) return claimed;
          // Nothing of this owner's was ready. Their new session makes them a recent owner, so
          // the pool starts warming for them now instead of at the next heartbeat.
          const session = yield* provisionSessionIn(project, worktree, input);
          yield* requestHotReconcile(project.id);
          return session;
        }
        return yield* provisionSessionIn(project, worktree, input);
      });

      const provisionAs = Effect.fn("SessionEngine.provisionAs")(function* (input: ProvisionInput) {
        const project = yield* projects.byId(input.projectId);
        // The place first: join by name (an existing name IS "a new conversation in that
        // worktree") or create it — git worktree, row, ordinal-0 checkpoint.
        const worktree = yield* ensureWorktreeIn(project, input, input.ownerUserId);
        return yield* provisionInWorktree(project, worktree, input);
      });

      const attachRun = Effect.fn("SessionEngine.attachRun")(function* (
        sessionId: SessionId,
        sealantRunId: SealantRunId,
        workspaceId: SealantWorkspaceId,
      ) {
        const session = yield* sessions.byId(sessionId);
        const existing = yield* sessionRuns.bySealantRunId(sealantRunId);
        if (existing === null) {
          // A run of the session still open and still live refuses this one: the session keeps
          // the run it has, and the attach changes nothing. Said in the log, never raised.
          const recorded = yield* createSessionRun({
            sessionId,
            harness: session.harness,
            sealantRunId,
            sealantWorkspaceId: workspaceId,
            sealantSessionId: null,
          }).pipe(
            Effect.as(true),
            Effect.catchTag("SealantPlatformError", (error) =>
              Effect.logWarning("session engine: attached run not recorded").pipe(
                Effect.annotateLogs({ sessionId, sealantRunId, message: error.message }),
                Effect.as(false),
              ),
            ),
          );
          if (!recorded) return;
        }
        yield* sessions.setSealantIds(sessionId, sealantRunId, workspaceId);
        yield* sessions.setStatus(sessionId, "running");
        yield* forkSupervision(sessionId, sealantRunId);
      });

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
        if (capture !== null) {
          // A missing head is an unavailable observation, not evidence that the head has no
          // transcript. Keep it distinct from a successful listing with no matching file.
          const chain = yield* capture.repo.headOf(session.worktreeId);
          if (chain === null || chain.head === null) {
            return yield* new HarnessStateIOError({
              sessionId,
              operation: "read-transcript",
              path: session.worktreeId,
              message: `Could not read a capture head for session ${sessionId}.`,
              cause: null,
            });
          }
          // The `exec tar | base64` archive path is retired in capture mode: the harness home is
          // the workspace class of the head capture, and it is read there, streamed.
          const located = yield* inOneReadPass(harvestFromCapture(session, agentProcess));
          if (located === null) {
            return yield* new HarnessStateCommandError({
              sessionId,
              harness,
              operation: "capture-archive",
              exitCode: 3,
              stderr: "",
              message: `No ${harness} transcript in the head capture for session ${sessionId}.`,
            });
          }
          return;
        }
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

        // From where the state physically is, through the relocation's own links only and never
        // another (`harvestHarnessStateScript`): a link an agent left under the harness home at
        // `~/.aws/credentials` is archived as a link, not as the secret file it points at
        // (docs/adr/0010; Astra review 2026-10-03).
        const pack = yield* sealant.exec(workspace, [
          "sh",
          "-c",
          harvestHarnessStateScript(shape.paths),
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

        if (shape.liveTranscript === null && shape.stateFile !== undefined) {
          // No transcript file (opencode): the conversation this process held is read out of the
          // database in the durable home the workspace mounts, and the manifest names it. None
          // that can be told is no saved state: a resume is refused rather than open a guess.
          const listed = yield* readOpencodeHome(harnessHomePathOf(project.storePath, session.id));
          const held =
            listed === null ? null : yield* opencodeConversationFor(session, agentProcess, listed);
          if (held === null) {
            return yield* new HarnessStateCommandError({
              sessionId,
              harness,
              operation: "identify-session",
              exitCode: 0,
              stderr: "",
              message: `No ${harness} conversation in the harness home is session ${sessionId}'s.`,
            });
          }
          yield* commitConversationState(session, project, agentProcess, held);
          return;
        }

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
          // Never through a symlink, the file or a directory on the way: a link named like a
          // transcript, or a linked directory holding one, could lead to anything in the home, a
          // secret file included (docs/adr/0010).
          const native = yield* sealant.exec(workspace, [
            "sh",
            "-c",
            readHarnessFileScript(),
            "mend-read",
            transcriptFile,
          ]);
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
          // A protocol process's whole transcript is already durably projected
          // (the live adapter saw every entry) — advance the ingest cursor so
          // a later cross-mode pickup backfills only genuinely PTY-era turns.
          if (agentProcess.kind === "agent-protocol" && providerSessionId !== null) {
            const endCursor = cursorAtEndOf(harness, providerSessionId, native.stdout);
            if (endCursor !== null) {
              yield* sessions.setNativeIngestCursor(sessionId, endCursor);
            }
          }
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

      /**
       * Commit a capture from the session's durable harness home — the crash path. The
       * workspace died before the exec harvest could reach it, but the mounted harness home
       * kept everything the harness wrote. Reads the store directly and writes the same
       * capture the exec harvest would (transcript, canonical, manifest) into the newest
       * matching agent process's directory. No `harness-state.tar.gz`: a session whose harness
       * home holds live state never restores from an archive. Null when nothing is
       * recoverable — an absent home, no transcript yet, a transcript-less harness.
       */
      /**
       * Capture mode's harvest (ADR-0002 "harvestFromHarnessHome"): the harness home rides the
       * workspace class of every capture under `harness/`; the newest transcript there is
       * streamed into the process's state dir — a 76 MB codex rollout is never buffered — and
       * the manifest commits it exactly as the co-located harvest does.
       */
      /**
       * Every read of the head capture `self` makes shares one pass (`withCaptureReadPass`): the
       * section's dir packs, pack indexes and packs are fetched once, not once per file. A Codex
       * memory read-back of 33 small files fetched the same 64 MiB pack 33 times without it: 28 s
       * of a Stop on the box (2026-10-03).
       */
      const inOneReadPass = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        capture === null
          ? self
          : withCaptureReadPass(self).pipe(Effect.provideService(BlobStore, capture.blobs));

      /**
       * The opencode conversation `agent` held, out of the conversations its database lists
       * (`opencodeConversationOf`): the other opencode processes that open the same database are
       * what could have started one of them instead. Null when it cannot be told.
       */
      const opencodeConversationFor = Effect.fn("SessionEngine.opencodeConversationFor")(function* (
        session: Session,
        agent: SessionProcess,
        listed: ReadonlyArray<OpencodeConversation>,
      ) {
        const project = yield* projects.byId(session.projectId);
        // The processes that open the same database: in capture mode the harness home rides the
        // worktree's captures, so every session of the worktree; co-located, each session has a
        // home of its own (`harnessHomePathOf`), so only this session's.
        const sharing =
          capture === null ? [session] : yield* sessions.listForWorktree(session.worktreeId);
        const rows = yield* processes.listForSessions(sharing.map((row) => row.id));
        const spanOf = (row: SessionProcess) =>
          readOpencodeLaunchSnapshot(
            processStatePathOf(project.storePath, row.sessionId, row.id),
          ).pipe(Effect.map((atLaunch) => opencodeSpanOf(row, atLaunch)));
        const others = yield* Effect.forEach(
          rows.filter(
            (row) =>
              row.id !== agent.id && row.harness === "opencode" && isAgentProcessKind(row.kind),
          ),
          spanOf,
        );
        return opencodeConversationOf(listed, yield* spanOf(agent), others, Date.now());
      });

      /**
       * The conversations an opencode launch starts beside (`OpencodeAgentSpan.atLaunch`), read
       * before the harness starts from the database it is about to open. Co-located, that is the
       * session's durable home. In capture mode, a fresh executor opens what it materialised from
       * the head capture; a live one (a retained executor, or another session's it joins) holds
       * whatever it wrote since its last capture, so it is flushed first and the head read once it
       * has caught up with it. Null when that cannot be read, which leaves the launch's own
       * conversations unknown; none on a first launch, with no database yet.
       */
      const opencodeLaunchSnapshot = Effect.fn("SessionEngine.opencodeLaunchSnapshot")(function* (
        session: Session,
        storePath: string,
        liveExecutor: Workspace | null,
      ) {
        if (capture === null)
          return yield* snapshotOpencodeHome(harnessHomePathOf(storePath, session.id));
        if (liveExecutor !== null) {
          // Caught up means the snapshot the flush followed was taken and holds everything: not
          // only nothing pending, but no small snap failing, no quota refusal, no unreadable path.
          // An answer that does not report snapshot health (SDK 0.37.2) is taken on its queue.
          // One wait (`CHECKPOINT_FLUSH_TIMEOUT`), then no snapshot: the launch says so on its
          // session line (`OPENCODE_SNAPSHOT_MISSING`) rather than wait twice as long.
          const caughtUp = observeCaptureFlush(
            session,
            liveExecutor,
            "opencode launch snapshot",
            CHECKPOINT_FLUSH_TIMEOUT,
            "suspend",
          ).pipe(
            Effect.map((reading) => {
              if (reading === null) return false;
              const behind = captureBehindReason(reading);
              return behind === null || behind === CAPTURE_HEALTH_UNREPORTED;
            }),
          );
          if (!(yield* caughtUp)) return null;
        }
        const head = (yield* capture.repo.headOf(session.worktreeId))?.head ?? null;
        if (head === null) return [];
        const manifest = yield* capture.blobs
          .get(head.manifestKey)
          .pipe(Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)));
        const blobs = capture.blobs;
        const found = yield* withCaptureReadPass(
          Effect.gen(function* () {
            const files = yield* listCaptureFiles(manifest, "workspace", "harness");
            return yield* capturedOpencode(manifest, files);
          }),
        ).pipe(Effect.provideService(BlobStore, blobs));
        if (found.state === "absent") return [];
        if (found.state === "torn" || found.conversations === null) return null;
        return found.conversations.map((conversation) => conversation.id);
      });

      /**
       * Commit a transcript-less harness's state (opencode) for `agent`: the manifest naming the
       * conversation it held, which a resume opens by id, and the id on the process and session.
       */
      const commitConversationState = Effect.fn("SessionEngine.commitConversationState")(function* (
        session: Session,
        project: { readonly storePath: string },
        agent: SessionProcess,
        providerSessionId: string,
      ) {
        const harness = agent.harness ?? session.harness;
        const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
        const manifestPath = path.join(stateDir, "manifest.json");
        const manifest: HarnessStateManifest = {
          harness,
          providerSessionId,
          capturedAt: new Date().toISOString(),
        };
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(stateDir, { recursive: true });
            await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
          },
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "write-manifest",
              path: manifestPath,
              message: `Could not commit saved harness state for session ${session.id}.`,
              cause,
            }),
        });
        yield* processes.setProviderSessionId(agent.id, providerSessionId);
        yield* sessions.setProviderSessionId(session.id, providerSessionId);
        return { stateDir, manifest } satisfies LocatedHarnessState;
      });

      /**
       * One harvest of an agent at a time: a deferred harvest left running past its limit and a
       * recovery sweep's harvest of the same agent would each clear and rewrite the other's
       * manifest (Astra review, 2026-10-03).
       */
      const harvestLocks = new Map<string, Semaphore.Semaphore>();
      const harvestFromCapture = (session: Session, agent: SessionProcess) => {
        const existing = harvestLocks.get(agent.id);
        const lock = existing ?? Semaphore.makeUnsafe(1);
        if (existing === undefined) harvestLocks.set(agent.id, lock);
        return lock.withPermit(harvestFromCaptureAlone(session, agent));
      };
      const harvestFromCaptureAlone = Effect.fn("SessionEngine.harvestFromCapture")(function* (
        session: Session,
        agent: SessionProcess,
      ) {
        if (capture === null) return null;
        const harness = agent.harness ?? session.harness;
        const shape = HARNESS_STATE[harness];
        if (shape === undefined) return null;
        if (shape.liveTranscript === null && shape.stateFile === undefined) return null;
        const project = yield* projects.byId(session.projectId);
        const chain = yield* capture.repo.headOf(session.worktreeId);
        const head = chain?.head ?? null;
        if (head === null) {
          return yield* new HarnessStateIOError({
            sessionId: session.id,
            operation: "read-transcript",
            path: session.worktreeId,
            message: `Could not read a capture head for session ${session.id}.`,
            cause: null,
          });
        }
        if (
          typeof head.sections === "object" &&
          head.sections !== null &&
          "workspace" in head.sections &&
          head.sections.workspace === "pending"
        ) {
          return yield* new HarnessStateIOError({
            sessionId: session.id,
            operation: "read-transcript",
            path: head.manifestKey,
            message: `The head capture workspace is pending for session ${session.id}.`,
            cause: null,
          });
        }
        const io = <A>(
          operation: HarnessStateIOError["operation"],
          at: string,
          thunk: () => Promise<A>,
        ) =>
          Effect.tryPromise({
            try: thunk,
            catch: (cause) =>
              new HarnessStateIOError({
                sessionId: session.id,
                operation,
                path: at,
                message: `Could not read the captured ${harness} state for session ${session.id}.`,
                cause,
              }),
          });
        const blobs = capture.blobs;
        const manifest = yield* blobs.get(head.manifestKey).pipe(
          Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)),
          Effect.mapError(
            (cause) =>
              new HarnessStateIOError({
                sessionId: session.id,
                operation: "read-transcript",
                path: head.manifestKey,
                message: `Could not read the head capture for session ${session.id}.`,
                cause,
              }),
          ),
        );
        const files = yield* listCaptureFiles(manifest, "workspace", "harness").pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.mapError(
            (cause) =>
              new HarnessStateIOError({
                sessionId: session.id,
                operation: "read-transcript",
                path: head.manifestKey,
                message: `Could not list the captured harness home for session ${session.id}.`,
                cause,
              }),
          ),
        );
        const pattern = shape.liveTranscript;
        if (pattern === null) {
          // A harness with no transcript file (opencode): its database in the capture holds the
          // conversations, and the one this process held is read out of it by id. The capture
          // itself is what a resume materialises; the manifest names the conversation to open.
          const stateFile = `harness/${shape.stateFile}`;
          const found = yield* capturedOpencode(manifest, files).pipe(
            Effect.provideService(BlobStore, blobs),
            Effect.mapError(
              (cause) =>
                new HarnessStateIOError({
                  sessionId: session.id,
                  operation: "read-transcript",
                  path: stateFile,
                  message: `Could not read the captured ${harness} database for session ${session.id}.`,
                  cause,
                }),
            ),
          );
          if (found.state === "absent") return null;
          // sealantd marks a database (or its log) that changed under every read as torn: what
          // it holds is no answer either way, so the session is left unclassified, not a dead end.
          if (found.state === "torn") {
            return yield* new HarnessStateIOError({
              sessionId: session.id,
              operation: "read-transcript",
              path: stateFile,
              message: `The captured ${harness} database for session ${session.id} was torn.`,
              cause: null,
            });
          }
          // Only a database with no conversation at all is a clean absence. One that does not
          // open, or whose conversations Mend cannot tell are this process's, is no answer: the
          // session is left unclassified (shown, resumable never by guess), as a torn one is.
          const unknown = (message: string) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "read-transcript",
              path: stateFile,
              message,
              cause: null,
            });
          const listed = found.conversations;
          if (listed === null) {
            return yield* unknown(
              `The captured ${harness} database for session ${session.id} does not open.`,
            );
          }
          if (listed.length === 0) return null;
          const providerSessionId = yield* opencodeConversationFor(session, agent, listed);
          if (providerSessionId === null) {
            // A process that named no conversation, and whose launch snapshot holds every one
            // the database lists, started none: a provable absence, not an unknown.
            const atLaunch = yield* readOpencodeLaunchSnapshot(
              processStatePathOf(project.storePath, session.id, agent.id),
            );
            if (
              agent.providerSessionId === null &&
              atLaunch !== null &&
              listed.every((conversation) => atLaunch.includes(conversation.id))
            ) {
              return null;
            }
            return yield* unknown(
              `opencode left no conversation Mend can tell is session ${session.id}'s; refusing to open another one.`,
            );
          }
          const located = yield* commitConversationState(
            session,
            project,
            agent,
            providerSessionId,
          );
          yield* Effect.logInfo("session engine: harness state observed at capture").pipe(
            Effect.annotateLogs({ sessionId: session.id, captureN: head.n, seq: String(head.seq) }),
          );
          return located;
        }
        // Never a conversation Mend carried in from another session (docs/adr/0009, "Codex"),
        // and the newest of the rest: a resumed session's home holds several of its own.
        const carried = parseCarriedTranscripts(
          yield* readCaptureFileBytes(manifest, "workspace", `harness/${CARRIED_TRANSCRIPTS}`).pipe(
            Effect.provideService(BlobStore, blobs),
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.orElseSucceed(() => null),
          ),
        );
        const own = files.filter((file) => {
          const relative = file.path.replace(/^harness\//, "");
          if (file.entry.kind !== "file" || !pattern.test(relative)) return false;
          const id = shape.providerSessionId(relative);
          return id === null || !carried.has(id);
        });
        // The conversation this agent is known to hold first (a resume names it); else the newest.
        const known =
          agent.providerSessionId === null
            ? undefined
            : own.find(
                (file) =>
                  shape.providerSessionId(file.path.replace(/^harness\//, "")) ===
                  agent.providerSessionId,
              );
        const transcript =
          known ??
          own.reduce<(typeof files)[number] | undefined>(
            (newest, file) =>
              newest === undefined ||
              BigInt(String(file.entry.mtime)) > BigInt(String(newest.entry.mtime))
                ? file
                : newest,
            undefined,
          );
        if (transcript === undefined) return null;
        const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
        const manifestPath = path.join(stateDir, "manifest.json");
        const transcriptPath = path.join(stateDir, "transcript.native");
        yield* io("write-transcript", stateDir, async () => {
          await fs.mkdir(stateDir, { recursive: true });
          await fs.rm(manifestPath, { force: true });
        });
        const stream = yield* readCaptureFile(manifest, "workspace", transcript.path).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.mapError(
            (cause) =>
              new HarnessStateIOError({
                sessionId: session.id,
                operation: "read-transcript",
                path: transcript.path,
                message: `Could not open the captured ${harness} transcript for session ${session.id}.`,
                cause,
              }),
          ),
        );
        yield* io("write-transcript", transcriptPath, () =>
          pipeline(stream, createWriteStream(transcriptPath)),
        );
        const providerSessionId = shape.providerSessionId(transcript.path);
        const native = yield* io("read-transcript", transcriptPath, () =>
          fs.readFile(transcriptPath, "utf8"),
        );
        const canonical =
          native === "" ? null : ingestNativeSession(harness, native, "/workspace/repo");
        if (canonical !== null) {
          yield* io("write-canonical", stateDir, () =>
            fs.writeFile(
              path.join(stateDir, "session.canonical.json"),
              JSON.stringify(canonical, null, 2),
            ),
          );
        }
        const stateManifest: HarnessStateManifest = {
          harness,
          providerSessionId,
          capturedAt: new Date().toISOString(),
        };
        yield* io("write-manifest", manifestPath, () =>
          fs.writeFile(manifestPath, JSON.stringify(stateManifest, null, 2)),
        );
        if (providerSessionId !== null) {
          yield* processes.setProviderSessionId(agent.id, providerSessionId);
          yield* sessions.setProviderSessionId(session.id, providerSessionId);
        }
        yield* Effect.logInfo("session engine: harness state observed at capture").pipe(
          Effect.annotateLogs({ sessionId: session.id, captureN: head.n, seq: String(head.seq) }),
        );
        return { stateDir, manifest: stateManifest } satisfies LocatedHarnessState;
      });

      const harvestFromHarnessHome = Effect.fn("SessionEngine.harvestFromHarnessHome")(function* (
        session: Session,
      ) {
        const harness = session.harness;
        if (HARNESS_STATE[harness] === undefined) return null;
        const project = yield* projects.byId(session.projectId);
        const agents = agentProcessesOf(yield* processes.listForSession(session.id));
        const agent = agents.findLast((candidate) => candidate.harness === harness) ?? null;
        if (agent === null) return null;
        if (capture !== null) return yield* inOneReadPass(harvestFromCapture(session, agent));
        const harnessHome = harnessHomePathOf(project.storePath, session.id);
        if (HARNESS_STATE[harness]?.liveTranscript === null) {
          // No transcript file (opencode): the database in the durable home holds the
          // conversations; the one this process held is read out of it by id.
          const listed = yield* readOpencodeHome(harnessHome);
          if (listed === null) return null;
          const providerSessionId = yield* opencodeConversationFor(session, agent, listed);
          if (providerSessionId === null) return null;
          return yield* commitConversationState(session, project, agent, providerSessionId);
        }
        const live = yield* locateLiveTranscript(harnessHome, harness);
        if (live === null) return null;
        const native = yield* Effect.tryPromise({
          try: () => fs.readFile(live.path, "utf8"),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "read-transcript",
              path: live.path,
              message: `Could not read the live ${harness} transcript for session ${session.id}.`,
              cause,
            }),
        });
        if (native === "") return null;
        const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
        const manifestPath = path.join(stateDir, "manifest.json");
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(stateDir, { recursive: true });
            // Commit-marker discipline: never let a half-written capture read as current.
            await fs.rm(manifestPath, { force: true });
            await fs.writeFile(path.join(stateDir, "transcript.native"), native);
            const canonical = ingestNativeSession(harness, native, "/workspace/repo");
            if (canonical !== null) {
              await fs.writeFile(
                path.join(stateDir, "session.canonical.json"),
                JSON.stringify(canonical, null, 2),
              );
            }
          },
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "write-transcript",
              path: stateDir,
              message: `Could not save the live ${harness} capture for session ${session.id}.`,
              cause,
            }),
        });
        const manifest: HarnessStateManifest = {
          harness,
          providerSessionId: live.providerSessionId,
          capturedAt: new Date().toISOString(),
        };
        yield* Effect.tryPromise({
          try: () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)),
          catch: (cause) =>
            new HarnessStateIOError({
              sessionId: session.id,
              operation: "write-manifest",
              path: manifestPath,
              message: `Could not commit saved harness state for session ${session.id}.`,
              cause,
            }),
        });
        if (live.providerSessionId !== null) {
          yield* processes.setProviderSessionId(agent.id, live.providerSessionId);
          yield* sessions.setProviderSessionId(session.id, live.providerSessionId);
        }
        return { stateDir, manifest } satisfies LocatedHarnessState;
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
       * container can be kept running.
       *
       * Capture mode: the executor holds whatever it has not shipped, so the stop is a drain
       * first (`drainThenTerminate`): the workspace goes only once nothing is pending, and a
       * drain that does not save keeps it. The lease is released only after the platform reports
       * the termination. A removal asked meanwhile happens once the workspace has gone.
       */
      const stopWorkspaceIfUnleased = (
        sessionId: SessionId,
        options?: { readonly force?: boolean; readonly reason?: CaptureDrainReason },
      ): Effect.Effect<DrainOutcome | "none"> =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(sessionId);
          if (session.sealantWorkspaceId === null) {
            // Nothing to stop — unless the lease still names the session: then an executor may
            // exist that Mend cannot address, and the row that is its identity stays.
            if (yield* launchUnresolved(session)) {
              yield* Effect.logWarning(
                "session engine: capture mode · the lease names this session and no workspace is recorded · nothing removed",
              ).pipe(Effect.annotateLogs({ sessionId, worktreeId: session.worktreeId }));
              return "kept" as const;
            }
            yield* removeIfRequested(sessionId);
            return "none" as const;
          }
          const workspaceId = session.sealantWorkspaceId;
          const force = options?.force === true;
          if (force) {
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
              // Whatever holds it is in use: no drain is under way, nothing reads `saving`.
              if (session.captureDrain !== null && !drains.has(workspaceId)) {
                // Not flushed at all: what the Stop put off flushes for itself (`none`), detached,
                // before the intent goes, as in `runDrain`, and not waited for here: this look owns no
                // drain slot, and holding it open would widen the window in which its `endDrain`
                // below clears a newer drain's intent (Astra review, 2026-10-03).
                yield* runDeferredDetached(workspaceId, "none", false);
                yield* endDrain(sessionId);
              }
              return "in-use" as const;
            }
          }
          if (capture !== null) {
            return yield* drainThenTerminate(
              sessionId,
              workspaceId,
              options?.reason ?? "stop",
              force,
            );
          }
          const lookup = yield* lookupWorkspace(workspaceId);
          if (lookup.kind === "found") yield* sealant.stopWorkspace(lookup.workspace);
          else if (lookup.kind === "unknown") {
            // Not answered for: nothing is known to be gone, so nothing is tidied or removed.
            yield* sealant.getWorkspace(workspaceId).pipe(Effect.flatMap(sealant.stopWorkspace));
          }
          // The container is gone; no row for it can still be live, and the
          // in-workspace socket has nobody left to serve.
          yield* processes.reapLiveForWorkspace(workspaceId);
          yield* socketHost.stop(sessionId);
          yield* channelTokens.revoke(sessionId).pipe(Effect.ignore);
          yield* removeIfRequested(sessionId);
          return lookup.kind === "gone" ? ("gone" as const) : ("terminated" as const);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: workspace stop failed").pipe(
              Effect.annotateLogs({ sessionId, error: String(error) }),
              Effect.as("kept" as const),
            ),
          ),
        );

      /**
       * The settle-path variant: every caller is the tail of a session settle, so no agent row
       * can still be live in the workspace — end any straggler before the lease check.
       */
      const stopWorkspaceQuietly = (
        sessionId: SessionId,
        options?: { readonly force?: boolean; readonly reason?: CaptureDrainReason },
      ) =>
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

      /** Await one executor's final ship before any capture-backed harvest reads the chain head. */
      const flushBeforeHarvest = Effect.fn("SessionEngine.flushBeforeHarvest")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId | null,
        why: string,
      ) {
        if (capture === null) return true;
        if (workspaceId === null) {
          yield* Effect.logWarning(
            "session engine: pre-harvest capture flush had no workspace",
          ).pipe(Effect.annotateLogs({ sessionId: session.id, why }));
          return false;
        }
        const workspace = yield* sealant
          .getWorkspace(workspaceId)
          .pipe(Effect.option, asSealantUser(session.ownerUserId));
        if (Option.isNone(workspace)) {
          yield* Effect.logWarning("session engine: pre-harvest workspace was unreachable").pipe(
            Effect.annotateLogs({ sessionId: session.id, workspaceId, why }),
          );
          return false;
        }
        // An executor already sent a final flush takes that kind only.
        const reading = yield* observeCaptureFlush(
          session,
          workspace.value,
          why,
          CHECKPOINT_FLUSH_TIMEOUT,
          (yield* workspaceFinalFlushed(session.worktreeId, workspaceId)) ? "final" : "suspend",
        );
        return reading !== null && captureHarvestReady(reading);
      });

      /**
       * Whether a session left a conversation behind, decided once at settle: a harvest that
       * captured a transcript says yes; "nothing to capture" or "no transcript" says no; any
       * other failure (the workspace already gone) asks the durable harness home instead. A
       * false answer is a dead end — nothing to resume — and the dashboard hides such sessions.
       */
      const classifyTranscript = (
        agentProcess: SessionProcess,
        harvest: "captured" | "absent" | "unknown",
      ) =>
        Effect.gen(function* () {
          const harness = agentProcess.harness;
          if (harness === null || HARNESS_STATE[harness] === undefined) return;
          const session = yield* sessions.byId(agentProcess.sessionId);
          if (session.hasTranscript === true) return;
          if (harvest === "captured") {
            yield* sessions.setHasTranscript(session.id, true);
            return;
          }
          if (capture !== null) {
            // A clean head read can prove absence. A failed head read is unknown and must remain
            // nullable so the dashboard does not hide a session whose transcript may still exist.
            if (harvest === "absent") yield* sessions.setHasTranscript(session.id, false);
            return;
          }
          const project = yield* projects.byId(session.projectId);
          const live = yield* hasLiveConversation(
            harnessHomePathOf(project.storePath, session.id),
            harness,
          );
          yield* sessions.setHasTranscript(session.id, live);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: transcript classification failed").pipe(
              Effect.annotateLogs({ sessionId: agentProcess.sessionId, error: String(error) }),
            ),
          ),
        );
      const tryHarvest = (agentProcess: SessionProcess) =>
        harvestHarnessState(agentProcess).pipe(
          Effect.map((): "captured" => "captured"),
          Effect.catch((error) => {
            const harvest: "absent" | "unknown" =
              capture !== null &&
              error._tag === "HarnessStateCommandError" &&
              error.operation === "capture-archive" &&
              error.exitCode === 3
                ? "absent"
                : "unknown";
            return Effect.logWarning("session engine: harness-state harvest failed").pipe(
              Effect.annotateLogs({
                sessionId: agentProcess.sessionId,
                processId: agentProcess.id,
                error: String(error),
              }),
              Effect.as(harvest),
            );
          }),
          Effect.flatMap((harvest) => classifyTranscript(agentProcess, harvest)),
          // Every harvest also reads back what the agent learned (docs/adr/0009), and never in
          // the way of the settle: a memory that could not be read back is said.
          Effect.tap(() =>
            sessions.byId(agentProcess.sessionId).pipe(
              Effect.flatMap(readBackAgentMemory),
              Effect.catchCause((cause) =>
                Effect.logWarning("session engine: agent memory was not read back").pipe(
                  Effect.annotateLogs({
                    sessionId: agentProcess.sessionId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
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
          if (!captured) {
            yield* tryHarvest(agent);
            // The exec harvest needs a live workspace; after a crash there is none. The
            // durable harness home still holds the state — commit the capture from it.
            const landed = yield* Effect.promise(() =>
              fs.access(manifestPath).then(
                () => true,
                () => false,
              ),
            );
            if (!landed) {
              yield* harvestFromHarnessHome(session).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("session engine: live-state harvest failed").pipe(
                    Effect.annotateLogs({ sessionId, error: String(error) }),
                    Effect.as(null),
                  ),
                ),
              );
            }
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: late harvest skipped").pipe(
              Effect.annotateLogs({ sessionId, error: String(error) }),
            ),
          ),
        );

      /** The tail of a settle without a process of its own: final flush, late harvest, then reap. */
      const sweepWorkspace = (sessionId: SessionId, atFinal = false) =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(sessionId);
          const workspaceId = session.sealantWorkspaceId;
          if (
            atFinal &&
            workspaceId !== null &&
            (yield* endsAtFinal(workspaceId)) &&
            // A stop: the sweep below drains the workspace, and the harvest reads that final
            // flush's head (decision 50).
            deferToFinal(workspaceId, (reading) =>
              Effect.gen(function* () {
                const captureReady =
                  harvestReadyOf(reading) ??
                  (yield* flushBeforeHarvest(session, workspaceId, "settle harvest"));
                if (captureReady) yield* harvestLatestIfMissing(sessionId);
              }),
            )
          ) {
            yield* stopWorkspaceQuietly(sessionId);
            if (!queueHeld.has(workspaceId)) yield* runDeferredDetached(workspaceId, "none");
            return;
          }
          const captureReady = yield* flushBeforeHarvest(session, workspaceId, "settle harvest");
          if (captureReady) yield* harvestLatestIfMissing(sessionId);
          yield* stopWorkspaceQuietly(sessionId);
        }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.void));

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
        ).pipe(
          // No committed capture — the settle never harvested (a crashed workspace). The
          // durable harness home may still hold the state; committing a capture from it
          // here is what turns "Saved harness state is missing" into a working resume.
          Effect.catchTag("HarnessStateNotFoundError", (error) => {
            const liveHarvest = harvestFromHarnessHome(session);
            return (
              capture === null ? liveHarvest.pipe(Effect.orElseSucceed(() => null)) : liveHarvest
            ).pipe(
              Effect.flatMap((located) =>
                located === null ? Effect.fail(error) : Effect.succeed(located),
              ),
            );
          }),
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
          // A session that never reached a process is a launch in flight, not settled work; so is
          // a lost create's launch whose executor's end is not observed yet (the reaper settles
          // it once the executor is gone).
          const launchInFlight =
            (session.status === "starting" ||
              (session.status === "stopping" &&
                session.summary === LAUNCH_STOP_UNOBSERVED_SUMMARY)) &&
            !rows.some((process) => isAgentProcessKind(process.kind));
          if (orphanRunLive || launchInFlight) return liveness;
          const { outcome, summary } = (yield* launchNeverRan(session, rows))
            ? { outcome: "failed" as const, summary: session.summary ?? LAUNCH_NEVER_RAN_SUMMARY }
            : yield* settledOutcomeOf(sessionId, rows);
          yield* settleSession(sessionId, outcome, summary);
        }
        if (options.sweep) yield* stopWorkspaceIfUnleased(sessionId);
        return liveness;
      });

      /**
       * Capture mode: the session's executor was created (its workspace is on the row) and
       * nothing of the launch reached a harness in it — no process ran there and no run belongs
       * to it. The launch failed (a setup command, relocation, the PTY) or was cut short, whatever
       * an earlier run of the session said: a drain that ends such an executor settles `failed`
       * with the launch's own words, never an older run's `completed`.
       */
      const launchNeverRan = Effect.fn("SessionEngine.launchNeverRan")(function* (
        session: Session,
        rows: ReadonlyArray<SessionProcess>,
      ) {
        const workspaceId = session.sealantWorkspaceId;
        if (capture === null || workspaceId === null) return false;
        if (rows.some((process) => process.sealantWorkspaceId === workspaceId)) return false;
        const latestRun = yield* sessionRuns.latestForSession(session.id);
        return latestRun?.sealantWorkspaceId !== workspaceId;
      });

      /**
       * An executor the platform confirmed gone without Mend asking, as observed
       * (`executorEndOf`): its own final flush registered last → `stopped` and `stopped outside
       * Mend · saved at …`; anything else → `failed` and `executor lost · last saved … · changes
       * after that were not saved`, with Mend's last reading of its queue when that came after.
       */
      const executorEndOfSession = Effect.fn("SessionEngine.executorEndOfSession")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId | null,
      ) {
        // What the executor answered, whichever session asked (review 2026-09-28 (5) #3): a
        // joined session's later unsaved answer revokes the holder's save as much as its own.
        const answers =
          workspaceId === null
            ? { saved: null, unsaved: [], version: 0 }
            : yield* executorAnswersOf(session, workspaceId);
        // An answer asked and not yet published may revoke any save: until it is, none stands
        // and none is refuted — completion unknown (cross-repo decision 18, review 2026-09-28
        // (7) #3).
        const settled = workspaceId === null || (yield* evidenceSettled(workspaceId));
        const saved = answers.saved;
        const chain = capture === null ? null : yield* capture.repo.headOf(session.worktreeId);
        const head = chain?.head ?? null;
        const sections = head?.sections;
        const epoch =
          workspaceId === null
            ? null
            : ((yield* leasedExecutorOf(session, workspaceId))?.epoch ?? null);
        // The seal as recorded: `executorEndOf` weighs it against the answers after it itself,
        // and names it as the last confirmed save when one revoked it.
        const sealRecord =
          workspaceId === null ? null : yield* executorSealRecordOf(session, workspaceId);
        const unsaved = answers.unsaved;
        const end = executorEndOf({
          head:
            head === null
              ? null
              : {
                  kind: head.kind,
                  n: head.n,
                  registeredAt: head.createdAt,
                  bulkPending:
                    typeof sections === "object" &&
                    sections !== null &&
                    "bulk" in sections &&
                    sections.bulk === "pending",
                },
          executorStartedAt: session.executorStartedAt,
          // The queue reading with where the executor made it (review 2026-09-28 (7) #4): the
          // same answer the executor's evidence keeps, ordered against a seal the same way.
          reading: {
            pending: session.capturePending,
            pendingBytes: session.capturePendingBytes,
            observedAt: session.captureObservedAt,
            position: yield* sessions.captureObservedPositionOf(session.id),
          },
          // This executor's own `complete: true`, under this executor's epoch when both are known.
          finalSaved:
            saved === null ||
            workspaceId === null ||
            saved.workspaceId !== workspaceId ||
            (epoch !== null && saved.epoch !== null && saved.epoch !== epoch)
              ? null
              : { at: saved.at, n: saved.n, position: saved.position ?? null },
          sealed:
            sealRecord === null
              ? null
              : {
                  at: sealRecord.seal.sealedAt,
                  n: sealRecord.seal.n,
                  position: sealRecord.position,
                },
          // Every answer of this executor that said it held unsaved work and no other was made
          // after: a save stands only over all of them (review 2026-09-28 (4) #9, (6) #6, (9) #4).
          unsaved: unsaved
            .filter((answer) => workspaceId !== null && answer.workspaceId === workspaceId)
            .map((answer) => ({
              at: answer.at,
              words: answer.words,
              position: answer.position ?? null,
            })),
          settled,
        });
        const outcome: SessionOutcome = end.kind === "saved" ? "stopped" : "failed";
        return {
          outcome,
          summary: executorEndWords(end),
          // What a "saved" commit is checked against (`confirmedExecutorEnd`).
          evidence:
            workspaceId === null ? null : { workspaceId, version: answers.version, settled },
        };
      });

      /**
       * An end that reads saved, confirmed right before it is committed (cross-repo decision 18):
       * under the executor's permit, the evidence it was read from is still the current version
       * and settled — else it is read again, under the permit, and that is what is committed.
       */
      const confirmedExecutorEnd = Effect.fn("SessionEngine.confirmedExecutorEnd")(function* (
        session: Session,
        end: {
          readonly outcome: SessionOutcome;
          readonly summary: string;
          readonly evidence?: {
            readonly workspaceId: string;
            readonly version: number;
            readonly settled: boolean;
          } | null;
        },
      ) {
        if (end.outcome !== "stopped" || end.evidence === null || end.evidence === undefined) {
          return end;
        }
        const evidence = end.evidence;
        const workspaceId = SealantWorkspaceId.make(evidence.workspaceId);
        return yield* withEvidenceLock(
          workspaceId,
          Effect.gen(function* () {
            if (yield* evidenceStillCurrent(evidence)) return end;
            const again = yield* executorEndOfSession(session, workspaceId);
            yield* Effect.logInfo(
              "session engine: capture mode · the executor's evidence moved while its end was read · read again",
            ).pipe(
              Effect.annotateLogs({
                sessionId: session.id,
                workspaceId,
                before: end.summary,
                after: again.summary,
              }),
            );
            return again;
          }),
        );
      });

      /**
       * Capture mode: how an agent's observed end reads when its executor may be ending too. Every
       * look reads the session again, so a stop that starts its drain while Mend is still looking
       * wins:
       * - `ending`: Mend is ending that executor itself (a drain under way, a final flush it
       *   sent): the harness ended because Mend asked, and nothing is lost by it;
       * - `ended`: the executor ended without Mend asking, as observed (`executorEndOfSession`):
       *   it answered `complete: true` for a final flush of its own (it closed admission, so an
       *   exec there is refused while it waits for its stop), or the platform says it is gone;
       *   An executor that never answered any of the looks is `ended` too, as unknown: `executor
       *   not answering · last saved … · completion unknown` — never the harness's own outcome;
       * - null: not lost — the executor answers (the harness ended on its own).
       * `onUnanswered` runs once, the first time the executor does not answer: the harness is
       * gone, whatever the executor's end turns out to be.
       */
      const executorLostOnEnd = Effect.fn("SessionEngine.executorLostOnEnd")(function* (
        agentProcess: SessionProcess,
        onUnanswered: Effect.Effect<void, SessionNotFoundError>,
      ) {
        if (capture === null) return null;
        const workspaceId = agentProcess.sealantWorkspaceId;
        let unanswered = false;
        for (let look = 1; look <= EXECUTOR_END_LOOKS; look += 1) {
          const session = yield* sessions.byId(agentProcess.sessionId);
          if (
            session.captureDrain !== null ||
            (yield* workspaceFinalFlushed(session.worktreeId, workspaceId))
          ) {
            return { kind: "ending" as const };
          }
          const lookup = yield* lookupWorkspace(workspaceId).pipe(
            asSealantUser(session.ownerUserId),
          );
          if (lookup.kind === "gone") {
            return {
              kind: "ended" as const,
              ...(yield* executorEndOfSession(session, workspaceId)),
            };
          }
          if (lookup.kind === "found") {
            const answers = yield* sealant.exec(lookup.workspace, ["true"]).pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.timeoutOption(Duration.seconds(10)),
              Effect.map(Option.getOrElse(() => false)),
              Effect.catch(() => Effect.succeed(false)),
              Effect.catchDefect(() => Effect.succeed(false)),
              asSealantUser(session.ownerUserId),
            );
            if (answers) return null;
          }
          if (!unanswered) {
            unanswered = true;
            yield* onUnanswered;
          }
          if (lookup.kind === "found") {
            // An executor that refuses an exec may have closed admission for a final flush of
            // its own: its status says whether that completed.
            const reading = yield* observeCaptureStatus(session, lookup.workspace);
            if (reading !== null && captureSaved(reading)) {
              const current = yield* sessions.byId(agentProcess.sessionId);
              return {
                kind: "ended" as const,
                ...(yield* executorEndOfSession(current, workspaceId)),
              };
            }
          }
          if (look < EXECUTOR_END_LOOKS) yield* Effect.sleep(drainPolicy.pollInterval);
        }
        if (!unanswered) return null;
        // Every look went unanswered and nothing said how the executor ended: its fate is
        // unknown, and the harness's own outcome (a `completed`) is not what happened to the work.
        const session = yield* sessions.byId(agentProcess.sessionId);
        const head =
          capture === null
            ? null
            : ((yield* capture.repo.headOf(session.worktreeId))?.head ?? null);
        return {
          kind: "ended" as const,
          outcome: "failed" as const,
          summary: executorUnansweredWords(
            head === null ? null : { n: head.n, at: head.createdAt },
          ),
        };
      });

      /** Sessions whose agent's end is being looked into (`executorLostOnEnd`). */
      const investigatingEnds = new Set<SessionId>();

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
        const sessionId = agentProcess.sessionId;
        // An agent that ended before it drew is not starting any more.
        if (current.firstOutputAt === null) {
          yield* clearAgentStartingWords(sessionId).pipe(Effect.ignore);
        }
        // The harness is gone and its executor does not answer: the row says so at once, and a
        // session with nothing else live reads `stopping` while Mend finds out how the executor
        // ended — never `running` for a harness that is not there.
        let exitedEarly = false;
        const harnessGone = Effect.gen(function* () {
          yield* processes.markExited(agentProcess.id, end.how, end.exitCode);
          exitedEarly = true;
          const session = yield* sessions.byId(sessionId);
          const rows = yield* processes.listForSession(sessionId);
          if (
            session.settledAt === null &&
            (session.status === "running" || session.status === "waiting") &&
            foldSessionLiveness(rows) === "settled"
          ) {
            yield* sessions.setStatus(sessionId, "stopping");
          }
        });
        // Capture mode: an agent that "exited" because its executor went away did not complete
        // anything — it lost whatever the executor had not shipped, unless the executor's own
        // final flush saved it. Say which. One that exited because Mend is ending its executor
        // was stopped.
        const verdict =
          end.how === "exited"
            ? yield* Effect.suspend(() => {
                investigatingEnds.add(sessionId);
                return executorLostOnEnd(agentProcess, harnessGone);
              }).pipe(Effect.ensuring(Effect.sync(() => investigatingEnds.delete(sessionId))))
            : null;
        // A saved end is confirmed against the evidence it was read from right before it is
        // committed (cross-repo decision 18).
        const lost =
          verdict?.kind === "ended"
            ? {
                ...verdict,
                ...(yield* confirmedExecutorEnd(yield* sessions.byId(sessionId), verdict)),
              }
            : null;
        const outcome: SessionOutcome =
          verdict === null
            ? end.outcome
            : verdict.kind === "ending"
              ? "stopped"
              : (lost?.outcome ?? verdict.outcome);
        const summary =
          verdict === null
            ? end.summary
            : verdict.kind === "ending"
              ? null
              : (lost?.summary ?? verdict.summary);
        if (!exitedEarly) yield* processes.markExited(agentProcess.id, end.how, end.exitCode);
        if (agentProcess.sealantRunId !== null) {
          yield* sessionRuns.settle(agentProcess.sealantRunId, outcome, summary);
        }
        yield* reconcileSession(agentProcess.sessionId, { sweep: false });
        if (lost !== null) {
          // The observed end is the session's: `stopped outside Mend · saved at …` when the
          // executor said its final flush completed, `failed · executor lost …` only when it went
          // without that word and without Mend ending it — the looks above yield to any drain.
          const settled = yield* sessions.byId(agentProcess.sessionId);
          if (settled.settledAt !== null && settled.status !== lost.outcome) {
            yield* sessions.setStatus(settled.id, lost.outcome);
          }
          if (settled.settledAt !== null && settled.summary !== lost.summary) {
            yield* sessions.setSummary(settled.id, lost.summary);
          }
          yield* (
            lost.outcome === "failed"
              ? Effect.logWarning(`session engine: capture mode · ${lost.summary}`)
              : Effect.logInfo(`session engine: capture mode · ${lost.summary}`)
          ).pipe(
            Effect.annotateLogs({
              sessionId: agentProcess.sessionId,
              workspaceId: agentProcess.sealantWorkspaceId,
            }),
          );
        }
        return true;
      });

      /**
       * The tail of an agent process's end: flush and snapshot the worktree, harvest harness state
       * from that registered head while the workspace is still warm, then let the fold release the
       * workspace if nothing else holds it. `trigger` null skips the
       * snapshot (the caller took its own). `sweep` false keeps the workspace even when nothing
       * else leases it — the observed-agent path: quiet transcript writes are an inference, not
       * an exit, and reaping on them would kill an agent that is merely between turns.
       */
      const finishAgentProcess = (
        agentProcess: SessionProcess,
        trigger: CheckpointTrigger | null,
        sweep = true,
        /** A stop ends this agent and drains its workspace: nothing flushes before that final. */
        stopping = false,
      ) =>
        Effect.gen(function* () {
          const session = yield* sessions.byId(agentProcess.sessionId);
          const workspaceId = agentProcess.sealantWorkspaceId;
          const cursor = Effect.gen(function* () {
            const run =
              agentProcess.sealantRunId === null
                ? null
                : yield* sessionRuns.bySealantRunId(agentProcess.sealantRunId);
            return {
              sealantRunId: agentProcess.sealantRunId,
              sequence: run?.lastSeenSequence ?? 0n,
            };
          });
          // A stop, and nothing else holds the workspace: the sweep below drains it, and the
          // checkpoint and the harvest read that final flush's head instead of asking for flushes
          // of their own (decision 50). An agent that ended on its own keeps its own flushes: its
          // end is judged, and its executor looked at, before any drain.
          const atFinal =
            stopping &&
            sweep &&
            workspaceId !== null &&
            (yield* endsAtFinal(workspaceId)) &&
            deferToFinal(workspaceId, (reading) =>
              Effect.gen(function* () {
                if (trigger !== null) {
                  yield* tryCheckpoint(session, trigger, yield* cursor, observedOf(reading));
                  yield* refreshChangeHead(session).pipe(Effect.ignore);
                }
                const captureReady =
                  harvestReadyOf(reading) ??
                  (yield* flushBeforeHarvest(session, workspaceId, "process-end harvest"));
                if (captureReady) yield* tryHarvest(agentProcess);
              }),
            );
          if (!atFinal) {
            if (trigger !== null) {
              // Capture checkpoints synchronously flush and register before deriving their
              // snapshot. Harvest must follow that barrier or it can read the previous chain
              // head forever.
              yield* tryCheckpoint(session, trigger, yield* cursor);
              yield* refreshChangeHead(session).pipe(Effect.ignore);
            }
            const captureReady = yield* flushBeforeHarvest(
              session,
              workspaceId,
              "process-end harvest",
            );
            if (captureReady) yield* tryHarvest(agentProcess);
          }
          // The workspace is still up: the last moment `gh` can run in it before the sweep below
          // may stop it (a pull request the agent opened itself is found here). Bounded, and
          // never in the way of the settle.
          yield* gitHooks
            .agentEnded({ sessionId: session.id, worktreeId: session.worktreeId })
            .pipe(Effect.timeout("20 seconds"), Effect.ignore);
          yield* reconcileSession(agentProcess.sessionId, { sweep });
          if (workspaceId !== null && !queueHeld.has(workspaceId)) {
            yield* runDeferredDetached(workspaceId, "none");
          }
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

      // ─── observed external agents (the harness home as a sensor) ──────────
      //
      // A coding agent the user runs by hand — in a mend shell, an SSH session, an editor
      // terminal — writes its state through the mounted harness home like any engine-launched
      // one. That makes it observable server-side: transcript writes are the "an agent is
      // working" signal. Observed agents become `agent-external` process rows, so the session
      // fold reads `running`, the workspace lease holds, and the settle-time harvest captures
      // the conversation. Mend observes; it does not own the process — it cannot steer or
      // stop it, and the row records only what was seen.

      /**
       * A transcript this quiet no longer reads as a live agent. Generous on purpose: a user
       * reading output or composing the next message writes nothing, and an end here is an
       * inference — if the writes come back, the next pass simply observes a new row and the
       * session reopens.
       */
      const EXTERNAL_AGENT_QUIET_MS = 300_000;
      /** Writes older than the engine's own agent exit are its tail, not external work. */
      const EXTERNAL_AGENT_EXIT_SKEW_MS = 2_000;

      /**
       * Blindness is worth a warning, once per session+harness: a harness home the engine
       * cannot read (a root-owned 0700 dir written by the workspace — codex does this) makes
       * every external agent in it invisible, and the observer would otherwise stay silent
       * about it. The mode keeper in the relocate script is the countermeasure; this is the
       * alarm for when it is not enough.
       */
      const observerBlindnessWarned = new Set<string>();
      const warnIfHarnessHomeUnreadable = (
        harnessHome: string,
        harness: string,
        sessionId: SessionId,
      ) =>
        Effect.gen(function* () {
          const key = `${sessionId}:${harness}`;
          if (observerBlindnessWarned.has(key)) return;
          const blocked = yield* Effect.promise(async () => {
            for (const dir of HARNESS_STATE[harness]?.homeDirs ?? []) {
              const target = path.join(harnessHome, dir);
              try {
                await fs.access(target, fsConstants.R_OK | fsConstants.X_OK);
              } catch (cause) {
                const code =
                  typeof cause === "object" && cause !== null && "code" in cause
                    ? cause.code
                    : null;
                if (code === "EACCES" || code === "EPERM") return target;
              }
            }
            return null;
          });
          if (blocked === null) return;
          observerBlindnessWarned.add(key);
          yield* Effect.logWarning(
            "session engine: harness home unreadable — external agents in it are invisible",
          ).pipe(Effect.annotateLogs({ sessionId, harness, path: blocked }));
        });

      const observeSessionExternalAgents = Effect.fn("SessionEngine.observeSessionExternalAgents")(
        function* (sessionId: SessionId) {
          const session = yield* sessions.byId(sessionId);
          if (session.sealantWorkspaceId === null) return;
          const workspaceId = session.sealantWorkspaceId;
          const project = yield* projects.byId(session.projectId);
          const rows = yield* processes.listForSession(sessionId);
          const home = harnessHomePathOf(project.storePath, session.id);
          // While the engine runs its own agent, transcript writes are presumed to be its —
          // observation only fills the gap where mend is otherwise blind.
          const engineAgentLive = rows.some(
            (row) => isLiveAgentProcess(row) && isEngineAgentProcess(row),
          );
          // An engine agent's final writes stay fresh for a while after it exits; only
          // activity that postdates the newest engine-agent exit reads as external.
          const lastEngineExitMs = rows.reduce(
            (latest, row) =>
              isEngineAgentProcess(row) && row.exitedAt !== null && row.exitedAt.getTime() > latest
                ? row.exitedAt.getTime()
                : latest,
            0,
          );
          const now = Date.now();
          for (const harness of Object.keys(HARNESS_STATE)) {
            const observed = rows.find(
              (row) =>
                row.kind === "agent-external" &&
                row.harness === harness &&
                row.exitedAt === null &&
                row.sealantWorkspaceId === workspaceId,
            );
            const transcript = yield* locateLiveTranscript(home, harness);
            const fresh = transcript !== null && now - transcript.mtimeMs < EXTERNAL_AGENT_QUIET_MS;
            if (observed !== undefined) {
              if (!fresh) {
                // The writes went quiet: record the observed end, harvest the conversation,
                // checkpoint the turn boundary — but never sweep the workspace. Quiet is an
                // inference, not an exit: the agent may sit between turns, and its next write
                // revives it as a fresh observed row. The workspace outlives the inference;
                // the platform TTL remains its backstop.
                const recorded = yield* endAgentProcess(observed, {
                  how: "exited",
                  exitCode: null,
                  outcome: "completed",
                  summary: null,
                });
                if (recorded) yield* finishAgentProcess(observed, "turn-boundary", false);
              } else if (
                transcript.providerSessionId !== null &&
                observed.providerSessionId !== transcript.providerSessionId
              ) {
                yield* processes.setProviderSessionId(observed.id, transcript.providerSessionId);
              }
              continue;
            }
            if (engineAgentLive) continue;
            if (transcript === null) {
              yield* warnIfHarnessHomeUnreadable(home, harness, sessionId);
              continue;
            }
            if (transcript.mtimeMs <= lastEngineExitMs + EXTERNAL_AGENT_EXIT_SKEW_MS) continue;
            // A settled session revives only on writes that POSTDATE the settle: its last
            // agent's tail writes stay fresh for a while, and a workspace stopped at settle
            // can never write again — only a genuinely live agent produces newer ones.
            if (
              session.settledAt !== null &&
              transcript.mtimeMs <= session.settledAt.getTime() + EXTERNAL_AGENT_EXIT_SKEW_MS
            ) {
              continue;
            }
            // A conversation some past row already carries needs no new row while quiet —
            // late observation is for work mend never saw, not a re-run of history.
            const alreadyObserved =
              transcript.providerSessionId !== null &&
              rows.some((row) => row.providerSessionId === transcript.providerSessionId);
            if (!fresh && alreadyObserved) continue;
            const created = yield* processes.create({
              sessionId,
              sealantWorkspaceId: workspaceId,
              sealantSessionId: null,
              sealantRunId: null,
              kind: "agent-external",
              harness,
              providerSessionId: transcript.providerSessionId,
              label: `${harness} (observed)`,
              argv: [],
              status: "running",
            });
            yield* reconcileSession(sessionId, { sweep: false });
            if (!fresh) {
              // LATE observation: the conversation happened and went quiet before mend could
              // see it (an unreadable window, a mend restart). It still becomes part of the
              // record — the row is observed and immediately ends, and the end-path harvest
              // captures the conversation.
              const recorded = yield* endAgentProcess(created, {
                how: "exited",
                exitCode: null,
                outcome: "completed",
                summary: null,
              });
              if (recorded) yield* finishAgentProcess(created, "turn-boundary", false);
            }
          }
        },
      );

      /**
       * One observation pass over every session that could host an external agent: any session
       * holding a live process row (a shell keeping the workspace, a Service, an already
       * observed agent), plus recently settled sessions whose workspace pointer survives —
       * a quiet-settled session must revive when its agent writes again. Quiet per session —
       * one broken session never blinds the rest.
       */
      const observeExternalAgents = Effect.fn("SessionEngine.observeExternalAgents")(function* () {
        const live = yield* processes.listLive();
        const sessionIds = new Set(live.map((row) => row.sessionId));
        for (const settled of yield* sessions.listRecentlySettled()) {
          sessionIds.add(settled.id);
        }
        for (const sessionId of sessionIds) {
          yield* observeSessionExternalAgents(sessionId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: external-agent observation failed").pipe(
                Effect.annotateLogs({ sessionId, error: String(error) }),
              ),
            ),
          );
        }
      });

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
       * Read the harness's files on a fresh executor once, in the background, while the rest of
       * the launch's setup runs (`harnessWarmupArgv`): its image disk is fetched lazily, and an
       * agent that reads node and its own files for the first time takes most of a minute to draw
       * (alpha 2026-09-30, fda7180d). Forked and bounded (`harnessWarmupTimeout`): it never
       * holds the launch up, and nothing it answers, or fails to, changes the launch. It writes
       * nothing that is the user's: it runs from `/` with a throwaway HOME.
       *
       * Runs only once the executor may admit writers (`prepareExecutor`): an exec on an
       * unclaimed capture-mode standby clears sealantd's unclaimed marker (e2e9 F-B), so a
       * standby is warmed at its claim, never before.
       */
      const forkHarnessWarmup = (
        sessionId: SessionId,
        workspace: Workspace,
        harness: string,
      ): Effect.Effect<void> => {
        const argv = harnessWarmupArgv(harness);
        if (argv === null) return Effect.void;
        return Effect.gen(function* () {
          const started = Date.now();
          const result = yield* sealant
            .exec(workspace, argv)
            .pipe(Effect.timeout(drainPolicy.harnessWarmupTimeout));
          yield* Effect.logInfo("session engine: harness warm-up · read · observed").pipe(
            Effect.annotateLogs({
              sessionId,
              harness,
              exitCode: result.exitCode,
              elapsedMs: Date.now() - started,
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logInfo("session engine: harness warm-up · not finished").pipe(
              Effect.annotateLogs({ sessionId, harness, cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      };

      /**
       * What runs in an executor before anything else, once it may admit writers: the custom
       * image's setup commands (a failing one fails the launch), then the `mend` helper and git's
       * ssh transport shim. A cold launch runs it right after the create; a capture-mode standby
       * at claim, after its replan (review 2026-09-28 e2e9 F-B): an exec on an unclaimed standby
       * clears sealantd's unclaimed marker.
       *
       * Answers the capture the setup commands were skipped for: an executor that laid the
       * worktree down from a saved capture (`restoredFrom`) runs none of them (review 2026-09-28
       * (15) #1). That capture already holds what setup produced on the worktree's first launch,
       * and whatever was changed since: `npm ci` over a restored `node_modules` put a patched
       * dependency file back to the published bytes before the shell opened.
       */
      const prepareExecutor = Effect.fn("SessionEngine.prepareExecutor")(function* (input: {
        readonly sessionId: SessionId;
        readonly workspace: Workspace;
        readonly workspaceImage: WorkspaceImage;
        /** Capture mode: the socket dir is not mounted, so its scripts are written into it. */
        readonly captured: boolean;
        /**
         * The saved capture the executor laid the worktree down from (`restoredCaptureOf`); null
         * when it was laid down fresh (capture 0, a worktree's first launch) or nothing is
         * captured (the co-located store).
         */
        readonly restoredFrom: number | null;
        readonly onFailure: (message: string) => Effect.Effect<void>;
        readonly abandon?: (workspace: Workspace, message: string) => Effect.Effect<void>;
        /**
         * The harness this executor is about to start: its files are read once in the background
         * while the setup runs (`forkHarnessWarmup`). Absent for a standby, which serves any.
         */
        readonly warmHarness?: string;
      }) {
        const { sessionId, workspace, workspaceImage } = input;
        if (input.warmHarness !== undefined) {
          yield* forkHarnessWarmup(sessionId, workspace, input.warmHarness);
        }
        let setupSkippedFrom: number | null = null;
        if (
          workspaceImage.mode === "custom" &&
          workspaceImage.setupCommands.length > 0 &&
          input.restoredFrom !== null
        ) {
          // Only the workspace-mutating setup commands are skipped: the helper and the git
          // transport below touch /usr/local/bin and system git config, never the worktree.
          setupSkippedFrom = input.restoredFrom;
          yield* Effect.logInfo(`session engine: ${setupSkippedWords(input.restoredFrom)}`).pipe(
            Effect.annotateLogs({
              sessionId,
              workspaceId: workspace.id,
              commands: workspaceImage.setupCommands.length,
            }),
          );
        } else if (workspaceImage.mode === "custom") {
          // Custom-image setup commands run in the fresh workspace BEFORE anything else (the
          // harness launch). They are part of the image contract, so a failing one fails the
          // provision loudly instead of handing the agent a half-prepared environment.
          for (const command of workspaceImage.setupCommands) {
            const result = yield* sealant
              .exec(workspace, ["sh", "-lc", command])
              .pipe(Effect.tapError((error) => input.onFailure(error.message).pipe(Effect.ignore)));
            if (result.exitCode !== 0) {
              const message = `setup command failed (exit ${result.exitCode}): ${command}`;
              yield* input.onFailure(message).pipe(Effect.ignore);
              yield* input.abandon === undefined
                ? sealant.stopWorkspace(workspace).pipe(Effect.ignore)
                : input.abandon(workspace, message);
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
        //
        // A captured workspace mounts nothing (ADR-0002), so the socket dir that carries the two
        // scripts never arrives: they are written into it here instead, and reach this machine
        // over the session endpoint. Without this, both paths above named files that did not
        // exist, and every push, fetch and `mend service` inside a captured session failed.
        const notInstalled = (detail: Record<string, unknown>) =>
          Effect.logWarning(
            "session engine: the mend helper and git transport were not installed in the workspace",
          ).pipe(Effect.annotateLogs({ sessionId, ...detail }));
        // The session still launches: an agent can work without a remote. It must not be
        // silent, though: that is how a workspace with no git transport went unnoticed.
        yield* sealant
          .exec(workspace, [
            "sh",
            "-c",
            `${!input.captured ? "" : `${workspaceScriptStaging(SESSION_SOCKET_MOUNT_PATH)} && `}` +
              `ln -sf ${SESSION_SOCKET_MOUNT_PATH}/bin/mend /usr/local/bin/mend && ` +
              `git config --system core.sshCommand ${SESSION_SOCKET_MOUNT_PATH}/bin/mend-git-ssh && ` +
              `git config --system ssh.variant ssh`,
          ])
          .pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0 ? Effect.void : notInstalled({ exitCode: result.exitCode }),
            ),
            Effect.catch((error) => notInstalled({ message: error.message })),
          );
        return setupSkippedFrom;
      });

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
        /** The session socket dir from `socketHost.start`, mounted at `/run/mend`. */
        readonly socketDir: string;
        readonly shape: ReturnType<typeof platformShape>;
        readonly ownerUserId: string | null;
        readonly onFailure: (message: string) => Effect.Effect<void>;
        /**
         * The platform accepted the create: from here on an executor exists. Runs before anything
         * executes in it, so the caller can make the executor addressable first.
         */
        readonly onCreated?: (workspace: Workspace) => Effect.Effect<void>;
        /**
         * What a setup command's failure does with the executor; a plain stop unless the caller
         * says. A capture-mode launch drains it instead: a setup command may already have written
         * work only that executor holds.
         */
        readonly abandon?: (workspace: Workspace, message: string) => Effect.Effect<void>;
        /**
         * A capture-mode standby: nothing executes in it until it is claimed (`prepareExecutor`
         * runs at claim instead, after the replan).
         */
        readonly deferPreparation?: boolean;
        /** The harness the launch starts: warmed while the setup runs (`forkHarnessWarmup`). */
        readonly warmHarness?: string;
        /**
         * The saved capture this executor lays the worktree down from (`restoredCaptureOf`), read
         * before the create; null or absent when it is laid down fresh.
         */
        readonly restoredFrom?: number | null;
        /**
         * Makes the create idempotent on the platform (Core's next SDK): `onAsking` runs once,
         * right before the first create is asked, so the key is on the row before any executor
         * can exist under it.
         */
        readonly createKey?: {
          readonly key: string;
          readonly onAsking: Effect.Effect<void>;
        };
        /**
         * The physical executor this create makes — its launch identity (cross-repo decision 5):
         * the create's idempotency key, minted before it. Its channel token is issued for it and
         * its `plan.get` names it; no other executor ever shares it.
         */
        readonly launchId: string;
        /**
         * Watches the create while it gets ready (`SealantClient.createWorkspace`): a launch says
         * on the session line whether the platform builds the image or boots the executor.
         */
        readonly watchCreate?: (workspace: Workspace) => Effect.Effect<void>;
      }) {
        const { project, sessionId, socketDir, shape, ownerUserId } = input;
        // What the project inherits: its organization's defaults over the instance's.
        const settings = yield* settingsRepo.forOrganization(project.organizationId);
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
        const declaredMounts = yield* declaredMountsOf(project);
        const linkedProjects = yield* resolveLinkedProjects(project, ownerUserId);
        // The durable harness home (harness-state.ts): a store-backed directory mounted
        // read-write into the workspace; boot symlinks each harness's `$HOME` state dirs into
        // it, so conversation state survives any workspace death. A failed mkdir costs
        // durability for this launch, never the launch itself.
        const harnessHome = harnessHomePathOf(project.storePath, sessionId);
        const harnessHomeReady = yield* Effect.promise(() =>
          fs.mkdir(harnessHome, { recursive: true }).then(
            () => true,
            () => false,
          ),
        );
        if (!harnessHomeReady) {
          yield* Effect.logWarning("session engine: harness home could not be created").pipe(
            Effect.annotateLogs({ sessionId, harnessHome }),
          );
        }
        // Skills ride the harness home: the resolved libraries (optional owner's + the
        // project's, project wins by name) are written server-side before the
        // workspace boots; the boot relocation keeps mount-side files, so the
        // harness discovers them natively. Best-effort by design — a launch
        // never fails over its skills.
        if (harnessHomeReady) {
          const skillLibraries = yield* skillsRepo.forLaunch(ownerUserId, project.id);
          const resolvedSkills = mergeSkillLibraries(skillLibraries, {
            inheritUserSkills: project.inheritUserSkills,
          });
          yield* materializeSkills(harnessHome, resolvedSkills).pipe(
            Effect.flatMap((outcomes) => logSkillsVacated(sessionId, outcomes)),
            Effect.catchTag("SkillMaterializeError", (error) =>
              Effect.logWarning("session engine: skills were not materialized").pipe(
                Effect.annotateLogs({ sessionId, harnessHome, message: error.message }),
              ),
            ),
          );
        }
        const workspaceMounts = [
          // The worktrees' shared git metadata: every worktree's `.git` file points at the bare
          // repository by absolute path, so it must sit at that same path inside the workspace.
          // (The SDK derived this itself for a mount source; a standby root has many worktrees.)
          { hostPath: project.storePath, mountPath: project.storePath, readOnly: false },
          { hostPath: socketDir, mountPath: SESSION_SOCKET_MOUNT_PATH },
          ...(harnessHomeReady
            ? [{ hostPath: harnessHome, mountPath: HARNESS_HOME_MOUNT_PATH, readOnly: false }]
            : []),
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
          // Linked projects (ADR-0001): the linked project's worktrees root as a BINDABLE mount
          // — the launch binds the named worktree at /workspace/repos/<name> — plus its bare
          // repository at its own absolute path, for the worktrees' `.git` pointers.
          ...linkedProjects.flatMap(({ link, linked }) => [
            { hostPath: linked.storePath, mountPath: linked.storePath, readOnly: false },
            {
              hostPath: worktreesRootOf(linked.storePath),
              mountPath: linkedProjectMountPath(link.name),
              readOnly: false,
              bindable: true,
            },
          ]),
        ];
        // The project's workspace-image override wins; null inherits its organization's default,
        // which inherits the instance's (`organizationDefaults`). The caller records whichever one
        // it ACTUALLY provisioned with, so a later settings change never rewrites what a past
        // session ran on.
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
        // A dotfiles source that cannot be resolved never costs the launch (it costs every
        // launch of every project otherwise): the workspace launches without that archive, the
        // other source still applies, and the session records what was left out and why.
        const leftOut = (
          source: SessionDotfilesNotApplied["source"],
          error: { readonly message: string },
        ): Effect.Effect<SessionDotfilesNotApplied> =>
          Effect.logWarning("session engine: dotfiles source not applied").pipe(
            Effect.annotateLogs({ sessionId, source, reason: error.message }),
            Effect.as({ source, reason: error.message }),
          );
        // The repository was checked when it was saved; checked again here, and the clone dials the
        // address just checked, because a name can answer differently at every launch. The owner's
        // actual role was applied at save; this recheck guards the tenant profile's networks.
        // The pin composes over the clone's own defaults, so a pinned ssh keeps BatchMode.
        // The clone runs as the owner, with their own git access (DotfilesCloner).
        const repositoryOutcome =
          dotfilesRepository === null || ownerUserId === null
            ? null
            : yield* sourcePolicy.check(dotfilesRepository.url, { isOperator: true }).pipe(
                Effect.mapError(
                  (refused) =>
                    new DotfilesResolveError({
                      message: `dotfiles repository refused: ${refused.message}`,
                    }),
                ),
                Effect.flatMap((clearance) =>
                  dotfilesCloner.archive(ownerUserId, dotfilesRepository, {
                    pinCloneEnv: (env) => sourcePolicy.pinnedEnv(clearance, env),
                  }),
                ),
                Effect.map((archive) => ({ archive, notApplied: null })),
                Effect.catchTag("DotfilesResolveError", (error) =>
                  leftOut("repository", error).pipe(
                    Effect.map((notApplied) => ({ archive: null, notApplied })),
                  ),
                ),
              );
        const snapshotOutcome =
          dotfilesEnabled && ownerUserId !== null
            ? yield* dotfilesStore.archive(ownerUserId).pipe(
                Effect.map((snapshot) => ({ snapshot, notApplied: null })),
                Effect.catchTag("DotfilesStoreError", (error) =>
                  leftOut("snapshot", error).pipe(
                    Effect.map((notApplied) => ({ snapshot: null, notApplied })),
                  ),
                ),
              )
            : null;
        const dotfilesSnapshot = snapshotOutcome?.snapshot ?? null;
        // Apply order: the repository first, the snapshot after (the synced selection wins).
        const dotfilesArchives = [
          repositoryOutcome?.archive ?? null,
          dotfilesSnapshot === null ? null : snapshotArchive(dotfilesSnapshot),
        ].filter((archive) => archive !== null);
        const dotfilesNotApplied = [
          repositoryOutcome?.notApplied ?? null,
          snapshotOutcome?.notApplied ?? null,
        ].filter((entry) => entry !== null);
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
        // Cluster bindings ride the same one-snapshot-per-launch read: names only — the Sealant
        // worker resolves the bound objects; Mend never sees their contents.
        const clusterBindings = yield* projectClusterBindings.snapshot(project.id).pipe(
          Effect.mapError(
            (error) =>
              new DotfilesResolveError({
                message: `project cluster bindings could not be read: ${String(error)}`,
              }),
          ),
          report,
        );
        const clusterBindingNames = clusterBindings.bindings.map(
          (binding) => `${binding.kind}/${binding.objectName}`,
        );
        const channel = yield* sessionChannelLaunchEnv(sessionId, input.launchId);
        const env = {
          ...Object.fromEntries(
            environment.variables.map((variable) => [variable.name, variable.value] as const),
          ),
          ...channel.env,
        };
        Object.assign(secretEnv, channel.secretEnv);
        // Capture mode (ADR-0002 "provisionWorkspace"): the executor mounts nothing — not the
        // store, the socket dir, the harness home, references, declared folders or linked
        // projects; it materialises the worktree's head capture and ships captures back. The
        // session token is the capture credential (one token, two names) and rides the create
        // request on the source, sealed by Core into the boot env file.
        const captureSource = yield* captureSourceFor(sessionId, channel.secretEnv);
        // The first three mounts are the store, the socket dir and the harness home — never
        // user-facing; anything past them is a reference, a declared folder or a linked project.
        if (captureSource !== null && workspaceMounts.length > 3) {
          yield* Effect.logInfo(
            "session engine: capture mode · host mounts not applied · references, folders and linked projects stay on this machine",
          ).pipe(Effect.annotateLogs({ sessionId, mounts: workspaceMounts.length }));
        }
        const environmentManifest = {
          environmentRevision: environment.revision,
          environmentVariableNames: environment.variables.map((variable) => variable.name),
          secretRevision: sealedSecrets.revision,
          secretNames: sealedSecrets.secrets.map((secret) => secret.name),
          clusterBindingRevision: clusterBindings.revision,
          clusterBindingNames,
          clusterServiceAccount: clusterBindings.serviceAccount,
        };
        let createAsked = false;
        const createWorkspace = (credentials: WorkspaceCredentialsOptions | undefined) =>
          Effect.suspend(() => {
            if (createAsked || input.createKey === undefined) return Effect.void;
            createAsked = true;
            return input.createKey.onAsking;
          }).pipe(
            Effect.andThen(
              sealant.createWorkspace(
                {
                  // Standby (ADR-0001, sealantd ADR-0014): the ROOT is mounted, hidden; /workspace/repo
                  // does not exist until the launch binds it to one worktree. Neither Docker nor
                  // Kubernetes can add a mount later, and this is what lets a pooled workspace serve
                  // any worktree of the project. Capture (ADR-0002): no mounts at all.
                  ...(captureSource === null
                    ? {
                        source: { kind: "standby", rootPath: worktreesRootOf(project.storePath) },
                        ...(workspaceMounts.length === 0 ? {} : { mounts: workspaceMounts }),
                      }
                    : captureSource),
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
                  // Cluster bindings (and the Docker service above) pass through unconditionally — no
                  // Mend-side capability pre-check. The platform validates at create: a runtime that
                  // cannot serve them refuses synchronously with a stable code
                  // (`runtime-env-references-unsupported`, `workspace-docker-unsupported`), mapped to
                  // a readable refusal below.
                  ...(clusterBindings.bindings.length === 0
                    ? {}
                    : {
                        envFrom: clusterBindings.bindings.map((binding) => ({
                          kind: binding.kind,
                          name: binding.objectName,
                        })),
                      }),
                  ...(clusterBindings.serviceAccount === null
                    ? {}
                    : { kubernetes: { serviceAccountName: clusterBindings.serviceAccount } }),
                  // Belt for every path that forgets to stop: the platform reaper.
                  ttl: "12h",
                  // Requires the platform at 0.7.1+ (sealant#114): 0.7.0 dropped every
                  // mount create that carried credentials at the worker's blueprint parse.
                  ...(credentials === undefined ? {} : { credentials }),
                },
                input.createKey === undefined
                  ? undefined
                  : { idempotencyKey: input.createKey.key, launchId: input.launchId },
                input.watchCreate,
              ),
            ),
          );
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
          // The platform's typed code IS Mend's capability check (a config flag could lie): the
          // workspace runtime refused the request synchronously — no workspace exists, no build
          // queued. Restate it naming what was refused, observationally.
          Effect.mapError((error) => {
            if (error.code === "runtime-env-references-unsupported") {
              return new SealantPlatformError({
                code: error.code,
                status: error.status,
                cause: error.cause,
                message:
                  `launch refused · ${clusterBindingNames.join(", ")}` +
                  (clusterBindings.serviceAccount === null
                    ? ""
                    : ` · service account ${clusterBindings.serviceAccount}`) +
                  " · cluster bindings do not resolve on this deployment's workspace runtime — remove them in project setup to launch here",
              });
            }
            if (error.code === "workspace-docker-unsupported") {
              return new SealantPlatformError({
                code: error.code,
                status: error.status,
                cause: error.cause,
                message: `launch refused · Docker · ${error.message}`,
              });
            }
            return error;
          }),
          report,
          Effect.onInterrupt(() =>
            input.onFailure("workspace provisioning was interrupted").pipe(Effect.ignore),
          ),
        );
        if (input.onCreated !== undefined) yield* input.onCreated(workspace);
        // A capture-mode standby admits no writer until it is claimed (review 2026-09-28 e2e9
        // F-B, sealantd#121): an exec clears sealantd's unclaimed marker, and a standby that ran
        // one reads as holding a session's work — a failed replan wedged its launch and a pool
        // shrink never released it. Its setup commands and tools run at claim, after the replan.
        const setupSkippedFrom =
          input.deferPreparation === true
            ? null
            : yield* prepareExecutor({
                sessionId,
                workspace,
                workspaceImage,
                captured: captureSource !== null,
                restoredFrom: input.restoredFrom ?? null,
                onFailure: input.onFailure,
                ...(input.abandon === undefined ? {} : { abandon: input.abandon }),
                ...(input.warmHarness === undefined ? {} : { warmHarness: input.warmHarness }),
              });
        return {
          workspace,
          workspaceImage,
          /** The capture the setup commands were skipped for (`prepareExecutor`); null when they ran. */
          setupSkippedFrom,
          environmentManifest,
          dotfiles: {
            repository:
              dotfilesRepository === null
                ? null
                : { url: dotfilesRepository.url, ref: dotfilesRepository.ref },
            snapshotSha: dotfilesSnapshot?.sha ?? null,
            notApplied: dotfilesNotApplied,
          },
          referenceMounts: selectedReferences.map(
            (reference) =>
              new SessionReferenceMount({
                name: reference.name,
                mountPath: `/workspace/ref/${reference.name}`,
                sha: reference.headSha,
              }),
          ),
          extraMounts: [
            ...declaredMounts.map(
              (mount) =>
                new SessionExtraMount({
                  name: mount.name,
                  hostPath: mount.hostPath,
                  mountPath: `/workspace/home/${mount.name}`,
                  readOnly: mount.readOnly,
                }),
            ),
            // A linked project rides as a read-write extra mount on the record: what the agent
            // could change, and where — the linked project's own worktree. A capture executor
            // mounts nothing, so nothing is recorded there (docs/adr/0010 "Linked projects"):
            // the record and the agent's note name only what the workspace holds.
            ...(captureSource !== null
              ? []
              : linkedProjects.map(
                  ({ link, linked }) =>
                    new SessionExtraMount({
                      name: `repos/${link.name}`,
                      hostPath: worktreePathOf(linked.storePath, link.worktreeName),
                      mountPath: linkedProjectMountPath(link.name),
                      readOnly: false,
                    }),
                )),
          ],
        };
      });

      /**
       * What mounts at `/workspace/home/<name>`: the operator's host mounts, then the organization
       * folders the project selected (docs/adr/0003-organizations-and-tenancy.md). Both share one
       * shape; a folder's host path is its directory in the store.
       */
      const declaredMountsOf = Effect.fn("SessionEngine.declaredMountsOf")(function* (
        project: Project,
      ) {
        const hostMounts = yield* projectMounts
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const selectedFolders = yield* foldersRepo
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        return [
          ...hostMounts.map((mount) => ({
            name: mount.name,
            hostPath: mount.hostPath,
            readOnly: mount.readOnly,
          })),
          ...selectedFolders.map(({ folder, selection }) => ({
            name: selection.name,
            hostPath: folder.path,
            readOnly: selection.readOnly,
          })),
        ];
      });

      /**
       * The project's links with their projects, as the session owner may use them
       * (docs/adr/0003): a link to a vanished project, a project in another organization, or one
       * the owner cannot see (a teammate's private project, say) is skipped with a warning, and
       * the session runs without that mount. Checked at every provision, claim and restore, so
       * access that changed after the link was made is honored.
       */
      const resolveLinkedProjects = Effect.fn("SessionEngine.resolveLinkedProjects")(function* (
        project: Project,
        ownerUserId: string | null,
      ) {
        const links = yield* projectLinks
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        if (links.length === 0) return [];
        const owner = ownerUserId;
        const membership = owner === null ? null : yield* organizations.membershipOf(owner);
        const resolved: Array<{ readonly link: ProjectLink; readonly linked: Project }> = [];
        for (const link of links) {
          const linked = yield* projects
            .byId(link.linkedProjectId)
            .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
          if (linked === null) continue;
          const usable = canUseLink(
            project,
            linked,
            owner === null || membership === null
              ? null
              : {
                  userId: owner,
                  organizationId: membership.organization.id,
                  role: membership.role,
                },
          );
          if (usable) {
            resolved.push({ link, linked });
          } else {
            yield* Effect.logWarning(
              "session engine: linked project skipped · the session owner cannot see it",
            ).pipe(Effect.annotateLogs({ projectId: project.id, link: link.name }));
          }
        }
        return resolved;
      });

      /**
       * Bind every linked project's worktree at its mount path (ADR-0001). Best-effort per
       * link: a worktree that no longer exists leaves that path unbound and a warning, never a
       * failed launch — the session's own repository is unaffected.
       */
      const bindLinkedProjects = Effect.fn("SessionEngine.bindLinkedProjects")(function* (
        workspace: Workspace,
        project: Project,
        ownerUserId: string | null,
      ) {
        for (const { link, linked } of yield* resolveLinkedProjects(project, ownerUserId)) {
          const worktree = yield* worktreesRepo.byName(linked.id, link.worktreeName);
          const outcome: Effect.Effect<unknown, Error | SealantPlatformError> =
            worktree === null
              ? Effect.fail(new Error(`${linked.name} has no worktree named ${link.worktreeName}`))
              : sealant.bindWorkspace(workspace, {
                  mountPath: linkedProjectMountPath(link.name),
                  subpath: worktree.directory,
                });
          yield* outcome.pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: linked project not bound").pipe(
                Effect.annotateLogs({
                  projectId: project.id,
                  link: link.name,
                  error: String(error),
                }),
              ),
            ),
          );
        }
      });

      /**
       * `mend.toml` read from inside a workspace — the worktree sits at `/workspace/repo` in
       * every workspace (the executor's working directory in capture mode, the bound mount
       * otherwise). An absent file is no declarations; an unreadable one is a typed error.
       */
      const readWorkspaceRecipes = Effect.fn("SessionEngine.readWorkspaceRecipes")(function* (
        workspace: Workspace,
      ) {
        const result = yield* sealant.exec(workspace, [
          "sh",
          "-c",
          `[ -e "$1" ] || exit ${WORKSPACE_MEND_TOML_ABSENT}; cat -- "$1"`,
          "sh",
          WORKSPACE_MEND_TOML,
        ]);
        if (result.exitCode === WORKSPACE_MEND_TOML_ABSENT) return [];
        if (result.exitCode !== 0) {
          return yield* new RecipeFileError({
            path: WORKSPACE_MEND_TOML,
            message: `mend.toml could not be read in the session workspace (exit ${result.exitCode}): ${result.stderr.trim()}`,
          });
        }
        return yield* parseServiceRecipes(result.stdout, WORKSPACE_MEND_TOML);
      });

      /**
       * Tell the harness what rides beside the repo — Mend's block in each harness's global
       * memory file in the workspace $HOME (never the worktree: the note is not review content).
       * A cold launch runs this after state restore, which rewrites $HOME; a prewarm runs it at
       * provision time (no restore ever lands in a hot workspace's $HOME). Only the bounded block
       * is Mend's: what the user or the agent wrote around it stays byte for byte, and a file
       * that could not be read is never written (`workspace-note.ts`, review 2026-09-28 (17) #1).
       */
      const appendWorkspaceNote = Effect.fn("SessionEngine.appendWorkspaceNote")(function* (
        workspace: Workspace,
        project: Project,
        /** Null for a standby skeleton: no worktree, so no mend.toml, until it is claimed. */
        worktree: string | null,
        referenceMounts: ReadonlyArray<SessionReferenceMount>,
        extraMounts: ReadonlyArray<SessionExtraMount>,
        /** The session's repositories (docs/adr/0010), as they stand after the relink. */
        repositories: ReadonlyArray<SessionRepositoryRow> = [],
      ) {
        const readyRepositories = repositories.filter((row) => row.state === "ready");
        const repositoriesSection =
          `## Mend repositories\n\n` +
          (readyRepositories.length === 0
            ? ""
            : `Repositories of other projects added to this session, each a worktree of its ` +
              `project on a branch of its own. Commits there are that repository's own change, ` +
              `never part of this session's change:\n\n` +
              readyRepositories.map((row) => `- ${row.path} · branch ${row.branch}`).join("\n") +
              `\n\n`) +
          `Need another repository of the store beside this one? \`mend repo add <project>\` ` +
          `puts it at /workspace/repos/<project> on its own branch. \`mend repo projects\` lists ` +
          `what can be added and \`mend repo list\` what is here. Never clone a sibling by hand ` +
          `outside /workspace/repo: only what Mend adds is saved with the session.\n\n`;
        const referencesSection =
          referenceMounts.length === 0
            ? ""
            : `Read-only clones of dependency sources — read the actual source here ` +
              `before guessing a dependency's API:\n\n` +
              referenceMounts.map((reference) => `- ${reference.mountPath}`).join("\n") +
              `\n\n`;
        const linkedMounts = extraMounts.filter((mount) =>
          isLinkedProjectMountPath(mount.mountPath),
        );
        const folderMounts = extraMounts.filter(
          (mount) => !isLinkedProjectMountPath(mount.mountPath),
        );
        const linkedSection =
          linkedMounts.length === 0
            ? ""
            : `Linked repositories — sibling projects, read-write. Commits there are that ` +
              `repository's own change, reviewed on its side, not part of this session's change:\n\n` +
              linkedMounts.map((mount) => `- ${mount.mountPath}`).join("\n") +
              `\n\n`;
        const foldersSection =
          folderMounts.length === 0
            ? ""
            : `Project folders beside the repository:\n\n` +
              folderMounts
                .map((mount) =>
                  mount.readOnly
                    ? `- ${mount.mountPath} (read-only)`
                    : `- ${mount.mountPath} (read-write — writes land in the ` +
                      `folder directly and are not part of the reviewed change)`,
                )
                .join("\n") +
              `\n\n`;
        const declaredRecipes = mergeRecipes(
          yield* worktree === null
            ? Effect.succeed([])
            : (capture === null
                ? readServiceRecipes(worktree)
                : readWorkspaceRecipes(workspace)
              ).pipe(Effect.orElseSucceed(() => [])),
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
          `\`mend service run --port <port> [--name <n>] [--http|--https] -- <command...>\` — ` +
          `it runs the command supervised in this workspace, waits for the port, and makes it ` +
          `reachable from the user's own machine. Pass \`--http\` (or \`--https\`) when the ` +
          `server is something to open in a browser: the user then gets an Open link, and an ` +
          `attached \`mend\` terminal on their machine tunnels it to their localhost. NEVER ` +
          `background a server inside a tool call. ` +
          `Listen on IPv4 — \`127.0.0.1\` or \`0.0.0.0\`: the forward dials the workspace's ` +
          `\`127.0.0.1\`, so a server bound only to \`::1\` reports healthy and answers ` +
          `nothing (Vite and friends: pass \`--host\`). In a monorepo, run the ONE app's own ` +
          `dev command (\`pnpm --dir apps/<app> dev\`): a root-level dev script fans out to ` +
          `every app and hands each the same \`--port\`, so they collide and drift onto ports ` +
          `nobody asked for. ` +
          `\`mend service add <port> [--http|--https]\` adopts something already listening; ` +
          `\`mend service list\` shows what runs.\n\n` +
          recipesLine;
        const note =
          `## Mend mounts\n\nMounted beside the repo:\n\n` +
          referencesSection +
          linkedSection +
          foldersSection +
          `\n` +
          repositoriesSection +
          servicesSection;
        const notWritten = (detail: Record<string, unknown>) =>
          Effect.logWarning("session engine: the workspace note was not written").pipe(
            Effect.annotateLogs({ workspaceId: workspace.id, ...detail }),
          );
        // Best-effort for the launch, never silent: a file left alone says why.
        yield* sealant.exec(workspace, workspaceNoteExec(note)).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.exitCode !== 0) {
                return yield* notWritten({
                  exitCode: result.exitCode,
                  stderr: result.stderr.trim().slice(-400),
                });
              }
              for (const file of parseWorkspaceNoteOutcomes(result.stdout)) {
                yield* WORKSPACE_NOTE_NOT_WRITTEN.has(file.outcome)
                  ? notWritten({ file: file.file, outcome: file.outcome, detail: file.detail })
                  : Effect.logInfo(`session engine: workspace note · ${file.outcome}`).pipe(
                      Effect.annotateLogs({ workspaceId: workspace.id, file: file.file }),
                    );
              }
            }),
          ),
          Effect.catch((error) => notWritten({ message: error.message })),
        );
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
          dotfiles: entry.dotfiles ?? { repository: null, snapshotSha: null, notApplied: [] },
          environmentManifest: entry.environment,
          referenceMounts: entry.referenceMounts,
          extraMounts: entry.extraMounts,
        };
      });

      /**
       * `workspace.capture.replan()` on a claimed standby (SDK 0.31.0, sealantd 0.15): the saved
       * capture it laid the worktree down from (`restoredFrom`, null when fresh) when the daemon
       * answered with this session's worktree under the lease epoch the claim took, the delta
       * report logged as observed. Anything else is null and the caller goes cold.
       */
      const replanClaimedStandby = Effect.fn("SessionEngine.replanClaimedStandby")(function* (
        session: Session,
        workspace: Workspace,
      ) {
        if (capture === null) return null;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        // Read under the claim's lease: the head this replan plans, unless the daemon names it.
        const headBefore = yield* restoredCaptureOf(session.worktreeId);
        const outcome = yield* sealant
          .captureReplan(workspace)
          .pipe(Effect.timeoutOption(STANDBY_REPLAN_TIMEOUT), Effect.result);
        const annotations = {
          sessionId: session.id,
          worktreeId: session.worktreeId,
          workspaceId: workspace.id,
        };
        if (Result.isFailure(outcome)) {
          yield* Effect.logWarning("session engine: standby replan · refused · cold launch").pipe(
            Effect.annotateLogs({ ...annotations, error: outcome.failure.message }),
          );
          return null;
        }
        if (Option.isNone(outcome.success)) {
          yield* Effect.logWarning("session engine: standby replan · timed out · cold launch").pipe(
            Effect.annotateLogs({
              ...annotations,
              timeoutMs: Duration.toMillis(STANDBY_REPLAN_TIMEOUT),
            }),
          );
          return null;
        }
        const report = outcome.success.value;
        if (
          report.worktreeId !== session.worktreeId ||
          (lease !== null && lease.live && report.epoch !== lease.epoch)
        ) {
          yield* Effect.logWarning(
            "session engine: standby replan · answered another identity · cold launch",
          ).pipe(
            Effect.annotateLogs({
              ...annotations,
              answeredWorktreeId: report.worktreeId,
              answeredEpoch: report.epoch,
              leaseEpoch: lease?.epoch ?? null,
            }),
          );
          return null;
        }
        yield* Effect.logInfo(
          "session engine: capture mode · standby re-planned onto the worktree · observed",
        ).pipe(
          Effect.annotateLogs({
            ...annotations,
            epoch: report.epoch,
            headN: report.headN ?? null,
            headCaptureId: report.headCaptureId ?? null,
            filesWritten: report.filesWritten,
            bytesWritten: report.bytesWritten,
            filesSkipped: report.filesSkipped,
            bytesSkipped: report.bytesSkipped,
            removed: report.removed,
            unchanged: report.unchanged,
          }),
        );
        // The head the plan carried, as the daemon reports it; an SDK that does not say it leaves
        // the head read under the claim.
        return {
          restoredFrom:
            report.headN === undefined ? headBefore : report.headN >= 1 ? report.headN : null,
        };
      });

      /**
       * Put every supported harness directory under the root sealantd captures, or under the
       * co-located store mount. Capture mode treats failure as a launch failure: starting anyway
       * would put the conversation in the executor's disposable HOME.
       */
      const relocateHarnessHome = Effect.fn("SessionEngine.relocateHarnessHome")(function* (
        session: Session,
        workspace: Workspace,
      ) {
        const result = yield* sealant.exec(workspace, [
          "sh",
          "-c",
          relocateHarnessHomeScript(HARNESS_HOME_MOUNT_PATH, {
            keepStoreReadable: capture === null,
            // A capture made before sealantd left opencode's MCP logins out may still hold one.
            dropCapturedLogins: capture !== null,
          }),
        ]);
        if (result.exitCode === 0) return;
        return yield* new SealantPlatformError({
          code: "harness_home_relocation_failed",
          status: null,
          message: `Could not place ${session.harness} state in the durable harness root: ${result.stderr}`,
          cause: null,
        });
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

      /**
       * Write the owner's git author into the workspace as system git config. Best-effort, like
       * the transport install: an agent without it still works, and the warning says why.
       */
      const applyGitAuthor = Effect.fn("SessionEngine.applyGitAuthor")(function* (
        sessionId: SessionId,
        workspace: Workspace,
        ownerUserId: string,
      ) {
        const author = yield* gitAuthors.resolve(ownerUserId);
        if (author === null) return;
        const notWritten = (detail: Record<string, unknown>) =>
          Effect.logWarning("session engine: the git author was not written in the workspace").pipe(
            Effect.annotateLogs({ sessionId, source: author.source, ...detail }),
          );
        yield* sealant.exec(workspace, gitAuthorConfigArgv(author)).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : notWritten({ exitCode: result.exitCode, stderr: result.stderr.trim() }),
          ),
          Effect.catch((error) => notWritten({ message: error.message })),
        );
      });

      /** Write files into a live workspace through exec (`workspace-files.ts`), in order. */
      const writeWorkspaceFiles = Effect.fn("SessionEngine.writeWorkspaceFiles")(function* (
        workspace: Workspace,
        files: ReadonlyArray<WorkspaceFile>,
      ) {
        for (const argv of writeFilesExecs(files)) {
          const result = yield* sealant.exec(workspace, argv);
          if (result.exitCode !== 0) {
            return yield* new WorkspaceFileError({
              path: argv.at(-1) ?? "",
              message: `exit ${result.exitCode}: ${result.stderr.trim()}`,
            });
          }
        }
      });

      /**
       * Mend's default shell profile (`shell-profile.ts`): `~/.zshrc` and
       * `~/.config/starship.toml`, each written only where nothing exists, so a file the owner's
       * dotfiles put there at boot stays. Only for a managed image whose shell is zsh, and only
       * while the project leaves the switch on. Best-effort like the git author: a shell without
       * it still works, and the warning says why.
       */
      const applyDefaultShellProfile = Effect.fn("SessionEngine.applyDefaultShellProfile")(
        function* (
          sessionId: SessionId,
          workspace: Workspace,
          project: Project,
          workspaceImage: WorkspaceImage,
        ) {
          if (!shellProfileApplies(project, workspaceImage)) return;
          yield* Effect.gen(function* () {
            const files = yield* loadShellProfile;
            for (const argv of writeAbsentHomeFilesExecs(files)) {
              const result = yield* sealant.exec(workspace, argv);
              if (result.exitCode !== 0) {
                return yield* new WorkspaceFileError({
                  path: "~",
                  message: `exit ${result.exitCode}: ${result.stderr.trim()}`,
                });
              }
              for (const file of parseHomeFileOutcomes(result.stdout)) {
                yield* Effect.logInfo(
                  file.outcome === "written"
                    ? "session engine: default shell profile · written"
                    : "session engine: default shell profile · a file exists, left as it is",
                ).pipe(Effect.annotateLogs({ sessionId, path: `~/${file.path}` }));
              }
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "session engine: the default shell profile was not written in the workspace",
              ).pipe(Effect.annotateLogs({ sessionId, message: error.message })),
            ),
          );
        },
      );

      /**
       * Capture mode's skills delivery: the same plan the co-located store writes beside the
       * mounted harness home (`skills.ts`), applied inside the live workspace's own. Best-effort
       * like the host write: a launch never fails over its skills. A directory that is not
       * exactly what Mend delivered there is moved aside, never deleted, and said so.
       */
      const deliverSkillsToWorkspace = Effect.fn("SessionEngine.deliverSkillsToWorkspace")(
        function* (session: Session, project: Project, workspace: Workspace) {
          const libraries = yield* skillsRepo.forLaunch(session.ownerUserId, project.id);
          const bundles = mergeSkillLibraries(libraries, {
            inheritUserSkills: project.inheritUserSkills,
          });
          const home = HARNESS_HOME_MOUNT_PATH;
          const manifestPath = path.posix.join(home, MANAGED_SKILLS_MANIFEST);
          const digestsPath = path.posix.join(home, MANAGED_SKILLS_DIGESTS);
          const readText = (file: string) =>
            sealant
              .exec(workspace, ["cat", file])
              .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)));
          const plan = planSkills(
            parseManagedSkills(yield* readText(manifestPath)),
            bundles,
            parseManagedSkillDigests(yield* readText(digestsPath)),
          );
          if (plan === null) return;
          const inHome = (relative: string) => path.posix.join(home, relative);
          const prepared = yield* sealant.exec(
            workspace,
            vacateSkillsExec(home, skillsKeptDir(), plan),
          );
          const vacated = parseSkillsVacateOutcomes(prepared.stdout);
          yield* logSkillsVacated(session.id, vacated);
          if (prepared.exitCode !== 0) {
            return yield* new WorkspaceFileError({
              path: home,
              message: `exit ${prepared.exitCode}: ${prepared.stderr.trim()}`,
            });
          }
          const encoder = new TextEncoder();
          yield* writeWorkspaceFiles(workspace, [
            ...skillFilesToWrite(plan, vacated).map((file) => ({
              path: inHome(file.path),
              bytes: encoder.encode(file.contents),
            })),
            { path: manifestPath, bytes: encoder.encode(plan.manifest) },
            { path: digestsPath, bytes: encoder.encode(plan.digests) },
          ]);
        },
      );

      /**
       * The owner's pi profile (`pi-profile.ts`), into a pi session's harness home, after the
       * relocation so it lands where pi reads: beside the mounted harness home in the co-located
       * store, through exec in capture mode. Best-effort like skills: pi starts without it.
       */
      const deliverPiProfile = Effect.fn("SessionEngine.deliverPiProfile")(function* (
        session: Session,
        project: Project,
        workspace: Workspace,
      ) {
        if (session.harness !== "pi" || session.ownerUserId === null) return;
        const saved = yield* piProfiles.forUser(session.ownerUserId);
        if (saved === null) return;
        const plan = planPiProfile({ digest: saved.profile.digest, files: saved.files });
        if (capture === null) {
          const outcomes = yield* materializePiProfile(
            harnessHomePathOf(project.storePath, session.id),
            plan,
          );
          yield* logPiProfileVacated(session.id, outcomes);
          return;
        }
        const home = HARNESS_HOME_MOUNT_PATH;
        const prepared = yield* sealant.exec(
          workspace,
          vacatePiProfileExec(home, piProfileKeptDir(), plan),
        );
        const vacated = parseSkillsVacateOutcomes(prepared.stdout);
        yield* logPiProfileVacated(session.id, vacated);
        if (prepared.exitCode !== 0) {
          return yield* new WorkspaceFileError({
            path: home,
            message: `exit ${prepared.exitCode}: ${prepared.stderr.trim()}`,
          });
        }
        yield* writeWorkspaceFiles(
          workspace,
          piProfileFilesToWrite(plan, vacated).map((file) => ({
            path: path.posix.join(home, file.path),
            bytes: file.bytes,
          })),
        );
      });

      /**
       * The owner's agent memory for the project (`agent-memory.ts`, docs/adr/0009), into the
       * session's harness home after the relocation: host-side in the co-located store, through
       * exec in capture mode. Best-effort: an agent without it still starts.
       *
       * In capture mode another person's memory never reaches it: `handOverAgentMemory` has
       * already moved it aside. An image without node cannot run the program; that is said once
       * per image, and its later launches stage nothing.
       */
      const deliverAgentMemory = Effect.fn("SessionEngine.deliverAgentMemory")(function* (
        session: Session,
        project: Project,
        workspace: Workspace,
      ) {
        if (session.ownerUserId === null) return;
        const stored = yield* agentMemory.forLaunch(session.ownerUserId, project.id);
        const plan = planAgentMemory(stored);
        if (capture === null) {
          const home = harnessHomePathOf(project.storePath, session.id);
          // Nothing stored and nothing delivered before: nothing to write, not even a record.
          const deliveredBefore = yield* Effect.promise(() =>
            fs.access(path.join(home, AGENT_MEMORY_DELIVERED)).then(
              () => true,
              () => false,
            ),
          );
          if (stored.length === 0 && !deliveredBefore) return;
          yield* logAgentMemoryDelivered(
            session.id,
            yield* materializeAgentMemory(home, plan, session.ownerUserId),
          );
          return;
        }
        const home = HARNESS_HOME_MOUNT_PATH;
        const image =
          session.workspaceImage === null
            ? "the default image"
            : JSON.stringify(session.workspaceImage);
        // Nothing staged where the program cannot run: staged files would stay in the shared home.
        if (nodelessImages.has(image)) return;
        if (stored.length === 0) {
          const before = yield* sealant.exec(workspace, [
            "cat",
            path.posix.join(home, AGENT_MEMORY_DELIVERED),
          ]);
          if (before.exitCode !== 0) return;
        }
        yield* writeWorkspaceFiles(
          workspace,
          plan.staged.map((file) => ({
            path: path.posix.join(home, file.path),
            bytes: file.bytes,
          })),
        );
        const delivered = yield* sealant.exec(
          workspace,
          deliverAgentMemoryExec(home, plan, session.ownerUserId),
        );
        // `sh` says 127 for a command it cannot find: an image without node. What was staged for
        // the program goes, so this person's memory does not stay in the worktree's home.
        if (delivered.exitCode === 127) {
          yield* sealant
            .exec(workspace, ["rm", "-rf", path.posix.join(home, ".mend/agent-memory-incoming")])
            .pipe(Effect.ignore);
          if (!nodelessImages.has(image)) {
            nodelessImages.add(image);
            yield* Effect.logInfo(
              "session engine: agent memory not delivered · the image has no node · said once per image",
            ).pipe(Effect.annotateLogs({ sessionId: session.id, image }));
          }
          return;
        }
        yield* logAgentMemoryDelivered(session.id, parseAgentMemoryOutcomes(delivered.stdout));
        if (delivered.exitCode !== 0) {
          return yield* new WorkspaceFileError({
            path: home,
            message: `exit ${delivered.exitCode}: ${delivered.stderr.trim()}`,
          });
        }
      });

      /**
       * Capture mode: the worktree's home is handed to the person launching this executor before
       * any of their memory goes in (docs/adr/0009). The home holds whatever the worktree's last
       * executor left: the memory of the person the server recorded for it (`agent_memory_homes`,
       * which outlives the session rows). The launcher's own home costs a few database reads and
       * one write, and nothing in the executor. When it was someone else's, or nobody's the server
       * can name:
       * - the home is first read back into the previous person's memory, so what they learned and
       *   had not saved yet reaches them. Nobody the server cannot name is credited;
       * - then every memory path moves to `.mend/agent-memory-kept/<stamp>-handover-…`, never
       *   deleted, and the owner record names the new person, written even when the home held
       *   nothing;
       * - then the server records the home as the launcher's, pending, before any delivery step
       *   that can fail, and forces a capture of the moved home off the launch path. The record
       *   counts once this executor's first caught-up flush after the move has placed it and a
       *   capture of its epoch at that position is on the chain (`recordedHomeOf`). An executor
       *   lost before that leaves the previous home recorded, as the restored head holds it.
       *
       * Load-bearing, as pi's profile is: a hand-over that cannot finish fails the launch rather
       * than start an agent on another person's memory. A join waits while it runs
       * (`awaitWorktreeHolder`). A worktree the server recorded nothing for (executors launched
       * before the record): its latest executor that ran a process, else its other sessions, all
       * the launcher's or all one other person's.
       */
      const handOverAgentMemory = Effect.fn("SessionEngine.handOverAgentMemory")(
        function* (session: Session, workspace: Workspace) {
          if (capture === null) return;
          const owner = session.ownerUserId;
          // Pending until a caught-up flush of this executor places it and its capture is saved.
          const epoch = (yield* capture.repo.leaseOf(session.worktreeId))?.epoch ?? null;
          const recordHome =
            epoch === null
              ? Effect.logWarning(
                  "session engine: agent memory · the hand-over was not recorded · no lease",
                ).pipe(Effect.annotateLogs({ sessionId: session.id }))
              : agentMemory.recordPendingHome(
                  session.worktreeId,
                  { userId: owner, sessionId: session.id, workspaceId: workspace.id },
                  epoch,
                );
          const recorded = yield* recordedHomeOf(session.worktreeId);
          let from: { readonly userId: string | null; readonly sessionId: string | null } | null =
            recorded?.settled ??
            (yield* latestExecutorOf(session.worktreeId, recorded?.pendingWorkspaceId ?? null));
          if (from === null) {
            const others = (yield* sessions.listForWorktree(session.worktreeId)).filter(
              (member) => member.id !== session.id,
            );
            const owners = new Set(others.map((member) => member.ownerUserId));
            const [only] = others;
            from =
              owners.size === 0
                ? { userId: owner, sessionId: session.id }
                : owners.size === 1 && only !== undefined
                  ? { userId: only.ownerUserId, sessionId: only.id }
                  : null;
          }
          if (owner !== null && from?.userId === owner) return yield* recordHome;
          let credited: string | null = null;
          if (from !== null && from.userId !== null) {
            const read = yield* inOneReadPass(agentMemoryFromCapture(session)).pipe(
              Effect.mapError((error) =>
                notHandedOver(
                  `the previous person's memory in this worktree could not be read: ${error.message}`,
                  error,
                ),
              ),
            );
            if (read !== null) {
              yield* creditAgentMemory(
                from.userId,
                from.sessionId ?? `handover:${session.id}`,
                session.projectId,
                read,
              ).pipe(
                Effect.mapError((error) =>
                  notHandedOver(
                    `the previous person's memory in this worktree could not be saved for them: ${String(error)}`,
                    error,
                  ),
                ),
              );
              credited = from.userId;
            }
          }
          const kept = agentMemoryHandoverKeptDir();
          const result = yield* sealant.exec(
            workspace,
            handOverAgentMemoryExec(HARNESS_HOME_MOUNT_PATH, kept, owner ?? ""),
          );
          if (result.exitCode !== 0) {
            return yield* notHandedOver(
              `another person's memory in this worktree could not be moved aside: exit ${result.exitCode}: ${result.stderr.trim()}`,
              null,
            );
          }
          yield* recordHome;
          // A capture of the moved home, forced off the launch path: its caught-up answer places
          // the record (`observeCaptureFlushFenced`), and so does any later one of this executor.
          // Never a capture staged before the move.
          yield* Effect.forkIn(
            workspaceFinalFlushed(session.worktreeId, SealantWorkspaceId.make(workspace.id)).pipe(
              Effect.flatMap((ending) =>
                // An executor sent its final flush admits no other; that final places the record.
                ending
                  ? Effect.void
                  : observeCaptureFlush(
                      session,
                      workspace,
                      "agent memory hand-over",
                      CHECKPOINT_FLUSH_TIMEOUT,
                      "suspend",
                    ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("session engine: agent memory · forced capture failed").pipe(
                  Effect.annotateLogs({ sessionId: session.id, cause: Cause.pretty(cause) }),
                ),
              ),
            ),
            scope,
          );
          yield* Effect.logInfo("session engine: agent memory · handed over").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              credited: credited === null ? "nobody" : "the previous person",
              kept,
              moved: result.stdout.split("\n").filter((line) => line.startsWith("memory moved"))
                .length,
            }),
          );
        },
        (effect, session) =>
          Effect.suspend(() => {
            memoryHandovers.add(session.worktreeId);
            return effect;
          }).pipe(Effect.ensuring(Effect.sync(() => memoryHandovers.delete(session.worktreeId)))),
      );

      /**
       * Capture mode, before a Codex starts in a worktree's home that is the launcher's (a launch,
       * or a later run in their own executor): every conversation there that is not the
       * launcher's comes out of Codex's memory (`CODEX_WITHHOLD_PROGRAM`), or Codex would
       * summarise other people's conversations into the launcher's memory at its next turn. The
       * launcher's own: their sessions' conversations in this worktree and what this launch
       * carried. When that cannot be done (no node, no `node:sqlite`, a renamed state database, a
       * database another Codex held past the wait), this launch's Codex starts with its memory
       * off. Answers whether it may keep it on. A join never comes here.
       */
      const withholdCodexThreads = Effect.fn("SessionEngine.withholdCodexThreads")(function* (
        session: Session,
        workspace: Workspace,
        argv: ReadonlyArray<string>,
        carried: ReadonlyArray<string>,
      ) {
        if (capture === null || !launchesCodex(argv)) return true;
        const members = (yield* sessions.listForWorktree(session.worktreeId)).filter(
          (member) => member.ownerUserId !== null && member.ownerUserId === session.ownerUserId,
        );
        const rows =
          members.length === 0
            ? []
            : yield* processes.listForSessions(members.map((member) => member.id));
        const own = [
          ...new Set([
            ...rows.flatMap((row) =>
              row.harness === "codex" && row.providerSessionId !== null
                ? [row.providerSessionId]
                : [],
            ),
            ...carried,
          ]),
        ];
        const result = yield* sealant
          .exec(workspace, withholdCodexThreadsExec(HARNESS_HOME_MOUNT_PATH, own))
          .pipe(
            Effect.catch((error) =>
              Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
            ),
          );
        const mayStayOn = codexMemoryMayStayOn(result.exitCode, result.stdout);
        if (!mayStayOn) {
          yield* Effect.logInfo(
            "session engine: codex memory off for this launch · other people's conversations in the home could not be withheld",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              exitCode: result.exitCode,
              said: result.stdout.trim() || result.stderr.trim(),
            }),
          );
        }
        return mayStayOn;
      });

      /**
       * Before the harness home relocation runs over a home a secret file was delivered into: a
       * file at a path that has been reserved since (`.local/state/opencode` became a captured
       * directory on 2026-10-04) would otherwise move into the captured root with its directory,
       * and secret files are never captured. The home's own record names what Mend delivered
       * there. Each such file is removed while it still holds the bytes Mend wrote on a plain path;
       * anything else there (edited since, reached through a link) is moved whole to
       * `~/.mend/secret-files-set-aside/` in the executor's own home, never deleted, and the
       * session line says where. The record forgets each one that is gone from the path.
       *
       * Fails, and the caller refuses the relocation, when the record cannot be read or a file
       * cannot be taken out: starting anyway could capture a secret. A record that is another
       * workspace's names nothing here. Nothing to do on a fresh home, which has no record.
       */
      const evictReservedSecretFiles = Effect.fn("SessionEngine.evictReservedSecretFiles")(
        function* (session: Session, workspace: Workspace) {
          const read = yield* sealant
            .exec(workspace, secretFilesDeliveredExec)
            .pipe(
              Effect.mapError((error) =>
                secretFilesNotSetAside(`the home's record: ${error.message}`),
              ),
            );
          if (read.exitCode !== 0)
            return yield* secretFilesNotSetAside(`the home's record: exit ${read.exitCode}`);
          const recordText = read.stdout.trim();
          if (recordText === "") return;
          const json = yield* secretCipher
            .decrypt(recordText)
            .pipe(
              Effect.mapError(() => secretFilesNotSetAside("the home's record does not unseal")),
            );
          const record = decodeSecretFilesRecord(json, workspace.id);
          if (record === null) return;
          const reserved = record.files.filter(
            (file) => reservedSecretFileRoot(file.path) !== null,
          );
          if (reserved.length === 0) return;
          const stamp = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
          const result = yield* sealant
            .exec(workspace, secretFilesSetAsideExec(reserved, stamp))
            .pipe(Effect.mapError((error) => secretFilesNotSetAside(error.message)));
          const outcomes = parseSecretFileOutcomes(result.stdout);
          const done = new Map(
            outcomes
              .filter(
                (outcome) =>
                  outcome.outcome === "removed" ||
                  outcome.outcome === "absent" ||
                  outcome.outcome === "moved",
              )
              .map((outcome) => [outcome.path, outcome] as const),
          );
          const next = record.files.filter((file) => !done.has(file.path));
          const nextRecord =
            next.length === 0
              ? null
              : yield* secretCipher
                  .encrypt(encodeSecretFilesRecord({ workspaceId: workspace.id, files: next }))
                  .pipe(Effect.orElseSucceed(() => null));
          yield* sealant.exec(workspace, secretFilesRecordExec(nextRecord)).pipe(Effect.ignore);
          for (const outcome of done.values()) {
            if (outcome.outcome !== "moved") continue;
            const words = `secret file ~/${outcome.path} · under a directory sessions now save · moved to ${outcome.movedTo ?? `~/${SECRET_FILES_SET_ASIDE}`}`;
            yield* Effect.logWarning(`session engine: ${words}`).pipe(
              Effect.annotateLogs({ sessionId: session.id, path: `~/${outcome.path}` }),
            );
            yield* noteLaunchWords(session.id, words).pipe(Effect.ignore);
          }
          const left = reserved.filter((file) => !done.has(file.path));
          if (result.exitCode !== 0 || left.length > 0) {
            const failed = outcomes.filter((outcome) => outcome.outcome === "failed");
            return yield* secretFilesNotSetAside(
              failed.length > 0
                ? failed
                    .map((outcome) => `~/${outcome.path}: ${outcome.reason ?? "failed"}`)
                    .join("; ")
                : `exit ${result.exitCode}: ${left.map((file) => `~/${file.path}`).join(", ")}`,
            );
          }
        },
      );

      /**
       * The owner's secret files (docs/adr/0010-secret-files.md, `secret-files.ts`), into the
       * workspace's own `$HOME` after the relocation and before the harness starts, in both
       * stores through exec: the home is the executor's disk, which no capture root covers. The
       * sealed set is read once per launch and unsealed here, the only place Mend holds the
       * bytes; the workspace proves each path is still a plain path in the home before writing.
       * Best-effort like skills: an agent without its files still starts, and the session line
       * says which were not written and why.
       */
      const deliverSecretFiles = Effect.fn("SessionEngine.deliverSecretFiles")(function* (
        session: Session,
        workspace: Workspace,
      ) {
        if (session.ownerUserId === null) return;
        const sealed = yield* secretFiles.sealedForLaunch(session.ownerUserId);
        // What an earlier delivery wrote into this home (`~/.mend/secret-files`, sealed with the
        // machine key and bound to this workspace, each file with its digest): a file the person
        // no longer keeps is removed, so a retained executor's next run does not read it. A record
        // that does not unseal, or is another workspace's, is nobody's word and says nothing.
        const recordText = (yield* sealant.exec(workspace, secretFilesDeliveredExec)).stdout.trim();
        const record =
          recordText === ""
            ? null
            : yield* secretCipher.decrypt(recordText).pipe(
                Effect.map((json) => decodeSecretFilesRecord(json, workspace.id)),
                Effect.orElseSucceed(() => null),
              );
        if (recordText !== "" && record === null) {
          yield* Effect.logWarning(
            "session engine: secret files · the home's record is not this workspace's, ignored",
          ).pipe(Effect.annotateLogs({ sessionId: session.id }));
        }
        const before = record?.files ?? [];
        if (sealed.length === 0 && before.length === 0) return;
        const unsealed = yield* Effect.forEach(
          sealed,
          (file) =>
            secretCipher.decrypt(file.sealedContents).pipe(
              Effect.map((base64) => ({
                path: file.path,
                bytes: new Uint8Array(Buffer.from(base64, "base64")),
              })),
              // Named by PATH only: a broken or rotated machine key must never print a file.
              Effect.mapError(
                () =>
                  new WorkspaceFileError({
                    path: file.path,
                    message: `~/${file.path} could not be unsealed with this machine's key`,
                  }),
              ),
            ),
          { concurrency: 1 },
        );
        const plan = planSecretFiles(unsealed);
        const outcomes: Array<SecretFileOutcome> = [...plan.refused];
        // One delivery's own staging names, and its staging files gone whatever ends it early.
        const stamp = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
        const paths = plan.files.map((file) => file.path);
        yield* Effect.gen(function* () {
          for (const argv of secretFilesExecs(plan.files, stamp)) {
            const result = yield* sealant.exec(workspace, argv);
            outcomes.push(...parseSecretFileOutcomes(result.stdout));
            if (result.exitCode !== 0) {
              return yield* new WorkspaceFileError({
                path: "~",
                message: `exit ${result.exitCode}: ${result.stderr.trim()}`,
              });
            }
          }
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || paths.length === 0
              ? Effect.void
              : sealant.exec(workspace, secretFilesCleanupExec(paths, stamp)).pipe(Effect.ignore),
          ),
        );
        // A file delivered before and no longer kept goes, when it still holds the bytes Mend
        // wrote; one still kept but refused this time stays recorded, so a later delivery can
        // still remove it, and so does one whose removal was refused.
        const digests = new Map(
          plan.files.map((file) => [
            file.path,
            createHash("sha256").update(file.bytes).digest("hex"),
          ]),
        );
        const stale = before.filter((file) => !digests.has(file.path));
        if (stale.length > 0) {
          const removed = yield* sealant.exec(workspace, secretFilesRemoveExec(stale));
          outcomes.push(...parseSecretFileOutcomes(removed.stdout));
        }
        const written = new Set(
          outcomes.filter((outcome) => outcome.outcome === "written").map((o) => o.path),
        );
        const removalRefused = new Set(
          outcomes.filter((outcome) => outcome.outcome === "kept").map((o) => o.path),
        );
        const next: SecretFilesRecord["files"] = [
          ...plan.files.flatMap((file) =>
            written.has(file.path)
              ? [{ path: file.path, sha256: digests.get(file.path) ?? "" }]
              : before.filter((old) => old.path === file.path),
          ),
          ...stale.filter((file) => removalRefused.has(file.path)),
        ];
        const nextRecord =
          next.length === 0
            ? null
            : yield* secretCipher
                .encrypt(encodeSecretFilesRecord({ workspaceId: workspace.id, files: next }))
                .pipe(Effect.orElseSucceed(() => null));
        yield* sealant.exec(workspace, secretFilesRecordExec(nextRecord)).pipe(Effect.ignore);
        for (const outcome of foldSecretFileOutcomes(outcomes)) {
          yield* (
            outcome.outcome === "refused"
              ? Effect.logWarning("session engine: secret file · not written")
              : Effect.logInfo(`session engine: secret file · ${outcome.outcome}`)
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              path: `~/${outcome.path}`,
              ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            }),
          );
        }
        const refused = foldSecretFileOutcomes(outcomes).filter(
          (outcome) => outcome.outcome === "refused",
        );
        if (refused.length > 0)
          yield* noteLaunchWords(session.id, secretFilesRefusedWords(refused));
      });

      /**
       * Codex's memory (docs/adr/0009, "Codex"): the person's own Codex conversations on the
       * project, laid into this session's home before Codex starts. In full, the few Codex would
       * summarise and has not; as stubs, the ones it has summarised, so it keeps their summaries.
       * Never a conversation already in the home that Mend did not carry, and never one from this
       * worktree in capture mode, whose sessions share the home.
       */
      const carryCodexConversations = Effect.fn("SessionEngine.carryCodexConversations")(function* (
        session: Session,
        project: Project,
        workspace: Workspace,
      ) {
        if (session.harness !== "codex" || session.ownerUserId === null) return [];
        const owner = session.ownerUserId;
        const stored = yield* agentMemory.forLaunch(owner, project.id);
        const summarised = yield* summarisedThreads(storedCodexDatabase(stored));
        const imported = storedCodexThreadLines(stored);
        const others = (yield* sessions.listForProject(project.id)).filter(
          (other) =>
            other.id !== session.id &&
            other.ownerUserId === owner &&
            other.harness === "codex" &&
            (capture === null || other.worktreeId !== session.worktreeId),
        );
        const revisions: Array<CodexRevision> = [];
        const facts = new Map<string, RolloutFacts>();
        // A conversation an agent holds right now is still going: never carried in full.
        const live = new Set<string>();
        const rows =
          others.length === 0
            ? []
            : yield* processes.listForSessions(others.map((other) => other.id));
        for (const row of rows) {
          if (row.harness !== "codex") continue;
          if (row.exitedAt === null) {
            if (row.providerSessionId !== null) live.add(row.providerSessionId);
            continue;
          }
          const stateDir = processStatePathOf(project.storePath, row.sessionId, row.id);
          const manifest = yield* readHarnessStateManifest(stateDir, row.sessionId).pipe(
            Effect.option,
          );
          if (Option.isNone(manifest) || manifest.value.providerSessionId === null) continue;
          const transcriptPath = path.join(stateDir, "transcript.native");
          const read = yield* readRolloutFacts(transcriptPath);
          if (read === null) continue;
          facts.set(transcriptPath, read);
          revisions.push({
            providerSessionId: manifest.value.providerSessionId,
            transcriptPath,
            capturedAt: new Date(manifest.value.capturedAt),
          });
        }
        const plan = planCodexCarry({
          revisions,
          facts,
          summarised,
          imported,
          live,
          now: Date.now(),
        });
        if (plan.full.length === 0 && plan.stubs.length === 0) return [];
        const files = yield* prepareCarriedConversations(plan);
        if (files.length === 0) return [];
        let outcomes: ReadonlyArray<{ readonly outcome: string; readonly id: string }>;
        if (capture === null) {
          outcomes = yield* materializeCarriedConversations(
            harnessHomePathOf(project.storePath, session.id),
            files,
          );
        } else {
          const carry = carryConversationsExec(HARNESS_HOME_MOUNT_PATH, files);
          yield* writeWorkspaceFiles(workspace, carry.staged);
          const result = yield* sealant.exec(workspace, carry.argv);
          outcomes = parseCarryOutcomes(result.stdout);
        }
        const count = (outcome: string) =>
          outcomes.filter((candidate) => candidate.outcome === outcome).length;
        yield* Effect.logInfo("session engine: codex conversations carried").pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            full: plan.full.length,
            stubs: plan.stubs.length,
            written: count("written"),
            present: count("present"),
            own: count("own"),
            failed: outcomes
              .filter((outcome) => outcome.outcome === "error")
              .map((outcome) => outcome.id)
              .join(", "),
          }),
        );
        return outcomes.flatMap((outcome) =>
          outcome.outcome === "written" || outcome.outcome === "present" ? [outcome.id] : [],
        );
      });

      /** The memory in a session's head capture, and what was delivered there; null without one. */
      const agentMemoryFromCapture = Effect.fn("SessionEngine.agentMemoryFromCapture")(function* (
        session: Session,
      ) {
        if (capture === null) return null;
        const head = (yield* capture.repo.headOf(session.worktreeId))?.head ?? null;
        if (head === null) return null;
        const manifest = yield* capture.blobs
          .get(head.manifestKey)
          .pipe(Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)));
        const read = (relative: string) =>
          readCaptureFileBytes(manifest, "workspace", relative).pipe(
            Effect.provideService(BlobStore, capture.blobs),
          );
        const files: Array<{
          readonly path: string;
          readonly encoding: "utf8" | "base64";
          readonly contents: string;
        }> = [];
        const skipped: Array<string> = [];
        for (const { root } of AGENT_MEMORY_ROOTS) {
          const listed = yield* listCaptureFiles(manifest, "workspace", `harness/${root}`).pipe(
            Effect.provideService(BlobStore, capture.blobs),
          );
          for (const file of listed) {
            const relative = file.path.replace(/^harness\//, "");
            if (file.entry.kind !== "file") continue;
            if (file.entry.size > agentMemoryMaxFileBytes(relative)) {
              skipped.push(relative);
              continue;
            }
            files.push(asMemoryFile(relative, yield* read(file.path)));
          }
        }
        // Single memory files (Codex's summary database): read with the write-ahead log the
        // capture holds beside it, and stored as one consolidated file.
        for (const { path: relative } of AGENT_MEMORY_FILES) {
          const bytes = yield* read(`harness/${relative}`).pipe(Effect.option);
          if (Option.isNone(bytes)) continue;
          const wal = yield* read(`harness/${relative}-wal`).pipe(Effect.option);
          const consolidated = yield* consolidateCodexDatabase(
            bytes.value,
            Option.isNone(wal) ? null : wal.value,
          );
          if (
            consolidated === null ||
            consolidated.byteLength > agentMemoryMaxFileBytes(relative)
          ) {
            skipped.push(relative);
            continue;
          }
          files.push(asMemoryFile(relative, consolidated));
        }
        const text = (relative: string) =>
          read(`harness/${relative}`).pipe(
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.orElseSucceed(() => null),
          );
        return {
          delivered: parseAgentMemoryDelivered(yield* text(AGENT_MEMORY_DELIVERED)),
          files,
          skipped,
        };
      });

      /**
       * Whose memory an executor holds, as the server knows it: the owner of the session whose
       * launch made it, which is the only launch that delivers into it. The lease names that
       * session while the executor runs (as for its login, docs/adr/0013); once released, the
       * session whose row still names the workspace under a launch of its own. Null when neither
       * does: then nobody's read-back takes what it holds.
       */
      const memoryOwnerOfExecutor = Effect.fn("SessionEngine.memoryOwnerOfExecutor")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const leased = yield* launchLoginOfWorkspace(session, workspaceId);
        if (leased !== null) return leased;
        let launcher: Session | null = null;
        for (const member of yield* sessions.listForWorktree(session.worktreeId)) {
          const launch = yield* sessions.executorLaunchOf(member.id);
          if (launch?.workspaceId !== workspaceId) continue;
          if (
            launcher === null ||
            (member.executorStartedAt?.getTime() ?? 0) >
              (launcher.executorStartedAt?.getTime() ?? 0)
          ) {
            launcher = member;
          }
        }
        return launcher?.ownerUserId ?? null;
      });

      /**
       * The worktree's latest executor that started a process, and whose launch made it, before a
       * new launch records its own: whose memory its capture-mode home holds now. A launch that
       * stopped before its first process (a hand-over that could not finish) changed nobody's
       * memory and does not count. Null when no session names one (a new worktree, or executors
       * that are no longer on any row).
       */
      const latestExecutorOf = Effect.fn("SessionEngine.latestExecutorOf")(function* (
        worktreeId: WorktreeId,
        /** A hand-over's executor not saved yet: whatever it did is not in the head. */
        excludedWorkspace: string | null,
      ) {
        let latest: Session | null = null;
        for (const member of yield* sessions.listForWorktree(worktreeId)) {
          const launch = yield* sessions.executorLaunchOf(member.id);
          if (launch === null || launch.workspaceId === excludedWorkspace) continue;
          const ran = (yield* processes.listForSession(member.id)).some(
            (process) => process.sealantWorkspaceId === launch.workspaceId,
          );
          if (!ran) continue;
          if (
            latest === null ||
            (member.executorStartedAt?.getTime() ?? 0) > (latest.executorStartedAt?.getTime() ?? 0)
          ) {
            latest = member;
          }
        }
        return latest === null ? null : { userId: latest.ownerUserId, sessionId: latest.id };
      });

      /**
       * One read of a home's memory, applied to `userId`'s memory for the project. A read exactly
       * like the last one credited for the same person and session is not applied again: a retried
       * hand-over, or a late read-back of the same home, would save the home's copy over a merge
       * the first one made (a session's later read replaces its own earlier save).
       */
      const creditAgentMemory = Effect.fn("SessionEngine.creditAgentMemory")(function* (
        userId: string,
        sessionId: string,
        projectId: ProjectId,
        read: AgentMemoryRead,
      ) {
        if (read.files.length === 0 && Object.keys(read.delivered).length === 0) return null;
        const key = `${userId}\u0000${projectId}\u0000${sessionId}`;
        const fingerprint = JSON.stringify([
          read.files.map((file) => [file.path, agentMemoryDigest(file)]),
          read.delivered,
          read.skipped,
        ]);
        if (lastCredited.get(key) === fingerprint) {
          return { saved: [], merged: [], deleted: [], skipped: [] };
        }
        const report = yield* agentMemory.readBack({
          userId,
          projectId,
          sessionId,
          // A file there that could not be read is not a deleted one: the stored copy stays.
          delivered: withoutSkipped(read),
          session: read.files,
          merge: mergeTextUnion,
          holdsDatabase: codexDatabaseHolds,
        });
        if (
          report.saved.length +
            report.merged.length +
            report.deleted.length +
            report.skipped.length >
          0
        ) {
          yield* Effect.logInfo("session engine: agent memory · read back").pipe(
            Effect.annotateLogs({
              sessionId,
              saved: report.saved.length,
              merged: report.merged.join(", "),
              deleted: report.deleted.join(", "),
              skipped: report.skipped.join(", "),
            }),
          );
        }
        lastCredited.set(key, fingerprint);
        return report;
      });

      /**
       * Whose memory a worktree's capture-mode home holds, as the server recorded it
       * (`agent_memory_homes`): the settled home, and the workspace of a hand-over still pending.
       * A pending hand-over counts once its executor's first caught-up flush after the move placed
       * it (`observeCaptureFlushFenced`) and a capture of its epoch at that position or later is
       * on the worktree's chain, and is settled then. Null: no launch recorded one (executors
       * launched before the record).
       */
      const recordedHomeOf = Effect.fn("SessionEngine.recordedHomeOf")(function* (
        worktreeId: WorktreeId,
      ) {
        const homes = yield* agentMemory.homeOf(worktreeId);
        if (homes === null) return null;
        const pending = homes.pending;
        if (pending !== null && capture !== null) {
          // Saved: a capture of that executor's epoch, taken after its hand-over's move, is on the
          // worktree's chain, which every later executor restores. Mend's own checkpoints
          // register under epochs of their own.
          const chain = yield* capture.repo.listChain(worktreeId);
          if (
            pending.n !== null &&
            chain.some((row) => row.epoch === pending.epoch && row.n >= (pending.n ?? 0))
          ) {
            yield* agentMemory.settleHome(worktreeId, pending.epoch);
            return { settled: pending, pendingWorkspaceId: null };
          }
        }
        return { settled: homes.settled, pendingWorkspaceId: pending?.workspaceId ?? null };
      });

      /**
       * Whose memory a worktree's capture-mode home holds, held by `workspaceId`, as the server
       * knows it (`recordedHomeOf`); null when the recorded home is another executor's. A worktree
       * with no record: the owner of the session whose launch made `workspaceId`, if one still
       * names it.
       */
      const homeOwnerOf = Effect.fn("SessionEngine.homeOwnerOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const recorded = yield* recordedHomeOf(session.worktreeId);
        if (recorded?.settled != null) {
          return recorded.settled.workspaceId === workspaceId ? recorded.settled.userId : null;
        }
        if (recorded !== null) return null;
        const latest = yield* latestExecutorOf(session.worktreeId, null);
        const owner = yield* memoryOwnerOfExecutor(session, workspaceId);
        return latest !== null && latest.userId !== owner ? null : owner;
      });

      /**
       * Whose memory the live executor `workspaceId` holds, for a launch into it: a hand-over still
       * pending names its own executor, whose home it already moved (the record is written only
       * after the move, or after finding the home already the launcher's). Read-backs keep the
       * saved view (`homeOwnerOf`): they read the head, which a lost executor never wrote.
       */
      const liveHomeOwnerOf = Effect.fn("SessionEngine.liveHomeOwnerOf")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        const homes = yield* agentMemory.homeOf(session.worktreeId);
        if (homes?.pending?.workspaceId === workspaceId) return homes.pending.userId;
        return yield* homeOwnerOf(session, workspaceId);
      });

      /**
       * What the session's agent learned, read back into the owner's memory for the project when
       * the agent ends (docs/adr/0009, decision 3): from the harness home in the co-located store,
       * from the flushed head capture in capture mode.
       *
       * In capture mode the head is the worktree's one home, and a session that joined another
       * person's executor ran its agent there, beside theirs, in the same memory files: who wrote
       * which line cannot be told apart. The server decides whose memory the home holds
       * (`homeOwnerOf`), and only that person's sessions read it back. The home's own owner
       * record is never consulted.
       */
      const readBackAgentMemory = Effect.fn("SessionEngine.readBackAgentMemory")(function* (
        session: Session,
      ) {
        if (session.ownerUserId === null) return;
        const project = yield* projects.byId(session.projectId);
        if (capture === null) {
          const read = yield* readAgentMemoryFromHome(
            harnessHomePathOf(project.storePath, session.id),
          );
          return yield* creditAgentMemory(session.ownerUserId, session.id, project.id, read);
        }
        // Decided from the server first; the capture is read only for someone to credit.
        const owner =
          session.sealantWorkspaceId === null
            ? null
            : yield* homeOwnerOf(session, session.sealantWorkspaceId);
        if (owner !== session.ownerUserId) {
          yield* Effect.logInfo(
            `session engine: agent memory not read back · ${owner === null ? "Mend cannot say whose memory the worktree's home holds" : "the worktree's home holds another person's memory"}`,
          ).pipe(Effect.annotateLogs({ sessionId: session.id }));
          return;
        }
        const read = yield* inOneReadPass(agentMemoryFromCapture(session));
        if (read === null) return;
        yield* creditAgentMemory(session.ownerUserId, session.id, project.id, read);
      });

      const storePastedImage = Effect.fn("SessionEngine.storePastedImage")(function* (
        sessionId: SessionId,
        bytes: Uint8Array,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (capture === null) {
          const project = yield* projects.byId(session.projectId);
          const stored = yield* storePastedImageOnHost(
            harnessHomePathOf(project.storePath, session.id),
            bytes,
          );
          return { path: stored.path, mediaType: stored.mediaType, bytes: stored.bytes };
        }
        const checked = yield* checkPastedImage(bytes);
        const workspace = yield* workspaceForSupportingProcess(session);
        const target = pastedImageWorkspacePath(checked.name);
        yield* writeWorkspaceFiles(workspace, [{ path: target, bytes }]).pipe(
          Effect.mapError(
            (error) =>
              new PastedImageError({
                reason: "write-failed",
                message: `Could not place the image in the workspace: ${error.message}`,
              }),
          ),
        );
        return { path: target, mediaType: checked.mediaType, bytes: bytes.byteLength };
      });

      // ─── Repositories in a session (docs/adr/0010) ─────────────────────────────────────────

      /** The session owner as a tenancy viewer, or null when they belong to no organization. */
      const viewerOf = Effect.fn("SessionEngine.viewerOf")(function* (ownerUserId: string | null) {
        if (ownerUserId === null) return null;
        const membership = yield* organizations.membershipOf(ownerUserId);
        if (membership === null) return null;
        return {
          userId: ownerUserId,
          organizationId: membership.organization.id,
          role: membership.role,
        };
      });

      const listRepositories = Effect.fn("SessionEngine.listRepositories")(function* (
        sessionId: SessionId,
      ) {
        yield* sessions.byId(sessionId);
        return yield* sessionRepositories.listForSession(sessionId);
      });

      const addableProjects = Effect.fn("SessionEngine.addableProjects")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.byId(sessionId);
        const project = yield* projects.byId(session.projectId);
        const viewer = yield* viewerOf(session.ownerUserId);
        if (viewer === null) return [];
        const held = new Set(
          (yield* sessionRepositories.listForSession(sessionId)).map((row) => row.projectId),
        );
        const candidates = yield* projects.listForOrganization(project.organizationId);
        return candidates
          .filter(
            (candidate) =>
              candidate.id !== project.id &&
              !held.has(candidate.id) &&
              canUseLink(project, candidate, viewer),
          )
          .map(
            (candidate): AddableProject => ({
              id: candidate.id,
              name: candidate.name,
              defaultBranch: candidate.defaultBranch,
              originUrl: candidate.originUrl,
            }),
          );
      });

      /**
       * Bring the repository's files into the live workspace (ADR 0010 "How the worktree
       * arrives", today): a clone of the project's origin through the workspace's own git
       * transport, checked out on the session's branch at Mend's recorded base, nested inside the
       * main worktree so the main worktree's captures carry it, and linked at its path. The row
       * records what happened; a failure is its reason, never a thrown error.
       */
      const bringRepositoryIn = Effect.fn("SessionEngine.bringRepositoryIn")(function* (
        session: Session,
        workspace: Workspace,
        row: SessionRepositoryRow,
        originUrl: string,
      ) {
        const script = repositoryCloneScript({
          originUrl,
          name: row.name,
          branch: row.branch,
          baseSha: row.baseSha,
        });
        const result = yield* sealant
          .exec(workspace, ["sh", "-c", script])
          .pipe(
            Effect.catch((error) =>
              Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
            ),
          );
        if (result.exitCode === 0) {
          yield* sessionRepositories.setState(row.id, "ready", null);
          yield* Effect.logInfo("session engine: repository added").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              repository: row.name,
              path: row.path,
              branch: row.branch,
            }),
          );
          return;
        }
        const reason =
          result.exitCode === REPOSITORY_EXISTS_EXIT
            ? `${nestedRepositoryPath(row.name)} already holds files that are not this repository`
            : result.exitCode === REPOSITORY_PATH_OCCUPIED_EXIT
              ? `${row.path} is a directory that is not Mend's link · nothing was cloned`
              : result.exitCode === REPOSITORY_OUTSIDE_EXIT
                ? `/workspace/repo/.mend is a link, not a directory inside the worktree · nothing was cloned`
                : failureReason(
                    result.stderr,
                    `the clone of ${originUrl} ended with exit ${String(result.exitCode)}`,
                  );
        yield* sessionRepositories.setState(row.id, "failed", reason);
        yield* Effect.logWarning("session engine: repository not added").pipe(
          Effect.annotateLogs({ sessionId: session.id, repository: row.name, reason }),
        );
      });

      const addRepository = Effect.fn("SessionEngine.addRepository")(function* (
        sessionId: SessionId,
        input: {
          readonly project: string;
          readonly name: string | null;
          readonly worktree: string | null;
        },
      ) {
        const session = yield* sessions.byId(sessionId);
        const project = yield* projects.byId(session.projectId);
        const refuse = (reason: RepositoryAddError["reason"], message: string) =>
          new RepositoryAddError({ sessionId, reason, message });
        const viewer = yield* viewerOf(session.ownerUserId);
        if (viewer === null) {
          return yield* refuse(
            "not-visible",
            "this session has no owner in an organization, so no project can be added",
          );
        }
        const target = yield* projects.byName(project.organizationId, input.project);
        if (target === null) {
          return yield* refuse(
            "unknown-project",
            `no project named "${input.project}" · mend repo projects lists what can be added`,
          );
        }
        if (target.id === project.id) {
          return yield* refuse(
            "own-project",
            `${target.name} is this session's own project · it is at /workspace/repo`,
          );
        }
        if (!canUseLink(project, target, viewer)) {
          return yield* refuse(
            "not-visible",
            `project ${target.name} is not visible to this session's owner`,
          );
        }
        const name = input.name ?? target.name;
        if (!isRepositoryName(name)) {
          return yield* refuse(
            "bad-name",
            `"${name}" is not a directory name · lowercase letters, digits, dots, underscores and dashes · name it with --as`,
          );
        }
        if ((yield* sessionRepositories.byName(sessionId, name)) !== null) {
          return yield* refuse(
            "name-taken",
            `this session already has a repository named ${name} · mend repo list shows it`,
          );
        }
        if (target.originUrl === null) {
          return yield* refuse("no-origin", `project ${target.name} has no origin to clone from`);
        }
        const sessionWorktree = yield* worktreesRepo.byId(session.worktreeId).pipe(Effect.orDie);
        const worktreeName = input.worktree ?? sessionWorktree.name;
        if (!isRepositoryName(worktreeName)) {
          // Checked before anything is made: a bad name must never leave a branch, a worktree row
          // or a capture 0 behind it.
          return yield* refuse(
            "bad-name",
            `"${worktreeName}" is not a worktree name · lowercase letters, digits, dots, underscores and dashes · name it with --worktree`,
          );
        }
        // The files go into the live workspace: without one there is nowhere to put them.
        const workspace = yield* workspaceForSupportingProcess(session).pipe(
          Effect.mapError(() =>
            refuse("not-live", "this session has no live workspace to add a repository to"),
          ),
        );
        // Last before the worktree is made, so the window in which another add could make the
        // same worktree is the one between this read and the create, and the create's unique
        // constraint on the name is the backstop. Joining an existing worktree would clone the
        // base over work its chain already holds (ADR 0010 "Considered options"), so it is
        // refused until the daemon materialises from the chain.
        if ((yield* worktreesRepo.byName(target.id, worktreeName)) !== null) {
          return yield* refuse(
            "worktree-taken",
            `project ${target.name} already has a worktree named ${worktreeName} · pick another with --worktree`,
          );
        }
        // Create only, never join: a worktree made by another add in the same instant fails this
        // create at the table's unique name rather than being handed over.
        yield* refuseUnsupportedProject(target);
        const worktree = yield* createWorktreeIn(
          target,
          { name: worktreeName, base: null },
          session.ownerUserId,
        );
        const row = yield* sessionRepositories
          .create({
            sessionId,
            projectId: target.id,
            worktreeId: worktree.id,
            name,
            path: repositoryPath(name),
            branch: worktree.branch,
            baseSha: worktree.baseSha,
            baseRef: worktree.baseRef,
            capture: "nested",
            source: "origin",
            addedByUserId: session.ownerUserId,
          })
          .pipe(
            Effect.mapError(() =>
              refuse("name-taken", `this session already has a repository named ${name}`),
            ),
          );
        yield* Effect.logInfo("session engine: repository adding").pipe(
          Effect.annotateLogs({
            sessionId,
            repository: name,
            project: target.name,
            worktree: worktree.name,
            origin: target.originUrl,
          }),
        );
        // In the engine's lifetime, as the owner: the channel answers within its timeout, the
        // clone takes what it takes, and the row says where it stands.
        yield* detach(
          bringRepositoryIn(session, workspace, row, target.originUrl).pipe(
            asSealantUser(session.ownerUserId),
          ),
        );
        return row;
      });

      /**
       * After a restore the nested directories are back and the symlinks are not (they sit
       * outside the captured root): relink every repository that is there and mark the ones
       * that are not `missing`, so the record says what the workspace holds.
       */
      const relinkRepositories = Effect.fn("SessionEngine.relinkRepositories")(function* (
        session: Session,
        workspace: Workspace,
      ) {
        // Every row: an add the server did not see end (a restart between the clone and the
        // row's `ready`) is settled by what the workspace holds, never left `adding` for good, and
        // a `failed` row whose files and ready mark are there after all (the clone's answer was
        // lost, not the clone) comes back as `ready`.
        const rows = yield* sessionRepositories.listForSession(session.id);
        if (rows.length === 0) return rows;
        const result = yield* sealant.exec(workspace, [
          "sh",
          "-c",
          repositoryRelinkScript(rows.map((row) => row.name)),
        ]);
        const report = parseRelinkReport(result.stdout);
        if (result.exitCode !== 0 || report.size < rows.length) {
          yield* Effect.logWarning("session engine: repositories relink reported partly").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              exitCode: result.exitCode,
              reported: report.size,
              asked: rows.length,
              stderr: result.stderr.trim().slice(0, 500),
            }),
          );
        }
        // Only an explicit observation moves a row; an unreported row keeps what it said, and a
        // `failed` row moves only to `ready` (its reason stands otherwise).
        for (const row of rows) {
          const nested = nestedRepositoryPath(row.name);
          const observed = report.get(row.name);
          if (row.state === "failed" && observed !== "ready") continue;
          switch (observed) {
            case "ready":
              if (row.state !== "ready") yield* sessionRepositories.setState(row.id, "ready", null);
              break;
            case "outside":
              yield* sessionRepositories.setState(
                row.id,
                row.state === "adding" ? "failed" : "missing",
                `/workspace/repo/.mend is a link, so ${nested} is not inside the captured worktree · kept, not linked`,
              );
              break;
            case "missing":
              yield* sessionRepositories.setState(
                row.id,
                row.state === "adding" ? "failed" : "missing",
                row.state === "adding"
                  ? "the add was interrupted before anything was brought in"
                  : `not found in the restored workspace at ${nested}`,
              );
              break;
            case "partial":
              yield* sessionRepositories.setState(
                row.id,
                row.state === "adding" ? "failed" : "missing",
                row.state === "adding"
                  ? `the add was interrupted · what it brought in is kept at ${nested}`
                  : `its files are at ${nested} without their ready mark · kept, not linked`,
              );
              break;
            case "occupied":
              yield* sessionRepositories.setState(
                row.id,
                "failed",
                `${row.path} is a directory that is not Mend's link · its files are kept at ${nested}`,
              );
              break;
            case "unlinked":
              yield* Effect.logWarning("session engine: repository not linked").pipe(
                Effect.annotateLogs({ sessionId: session.id, repository: row.name }),
              );
              break;
            case undefined:
              break;
          }
        }
        yield* Effect.logInfo("session engine: repositories relinked").pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            ready: rows.filter((row) => report.get(row.name) === "ready").length,
            other: rows.filter((row) => report.get(row.name) !== "ready").length,
          }),
        );
        return yield* sessionRepositories.listForSession(session.id);
      });

      const launchInternalBody = Effect.fn("SessionEngine.launchInternal")(function* (
        sessionId: SessionId,
        argv: ReadonlyArray<string>,
        nativeImport: ConvertedNativeSession | null,
        stateOverride?: LocatedHarnessState | null,
        launchCorrelationId: string | null = null,
        protocolStart: LaunchStart | null = null,
        protocolAuthor: string | null = null,
        protocolResumeId: string | null = null,
      ) {
        // Capture mode: a create of this session whose answer is not on its row holds the
        // session's ownership until it is reconciled (review 2026-09-28 (3) #5) — whoever
        // relaunches, the owning session included. Its key is asked first: an executor it made
        // goes on the row and the relaunch below drains it like any other; nothing on record
        // yet is not proof, so this launch asks the very same create again under that key (its
        // launch identity and its token with it); a platform that cannot say refuses the launch.
        let reusedCreateKey: string | null = null;
        if (capture !== null) {
          const pending = yield* sessions.executorCreateOf(sessionId);
          if (pending !== null) {
            const resolved = creatingExecutors.has(sessionId)
              ? ("in-flight" as const)
              : yield* resolveExecutorCreate(sessionId, pending, { drain: false });
            if (resolved === "reserved") reusedCreateKey = pending;
            else if (resolved !== "adopted" && resolved !== "cancelled" && resolved !== "gone") {
              const error = new SealantPlatformError({
                code: "executor_create_unresolved",
                status: 409,
                message:
                  resolved === "in-flight"
                    ? "executor create in flight · this session's create has not answered yet · nothing started"
                    : `executor create unresolved · the platform ${resolved === "unsupported" ? "cannot say" : "did not say"} whether this session's last create made an executor · nothing started · it may hold work not yet saved`,
                cause: null,
              });
              yield* settleSession(sessionId, "failed", error.message).pipe(Effect.ignore);
              return yield* error;
            }
          }
        }
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        // A launch over a settled row (a failed first attempt retried) records a new run: one
        // the settle left open takes the session's words first.
        yield* settleRunsOfSettled(sessionId);
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
        //
        // The id the process row and the opening turn carry; a relaunch planned below may mint one,
        // so a restart that finishes it launches and asks exactly once.
        let correlationId = launchCorrelationId;
        // Capture mode: the old executor drains first — the relaunch waits until nothing is
        // pending (the session reads `saving`), and a drain that does not save refuses the
        // relaunch and keeps the old workspace. A workspace another session's live process
        // runs in is not this session's to replace: it stays, and this launch goes cold.
        if (session.sealantWorkspaceId !== null) {
          const oldWorkspaceId = session.sealantWorkspaceId;
          const othersLive =
            capture !== null &&
            (yield* processes.listLiveForWorkspace(oldWorkspaceId)).some(
              (process) => process.sessionId !== sessionId,
            );
          if (!othersLive) {
            // Capture mode: the whole transition is durable — drain, terminate, then this launch —
            // so a restart in between finishes it (`resumeDrain`). Cleared when this launch has
            // run its course, whichever way (`launchInternal`).
            if (capture !== null) {
              const plan = relaunchPlanOf({
                harness: session.harness,
                argv,
                hasNativeImport: nativeImport !== null,
                launchCorrelationId,
                start: protocolStart,
                author: protocolAuthor,
                resumeId: protocolResumeId,
              });
              if (plan.kind === "launch") correlationId = plan.launchCorrelationId;
              yield* sessions.planRelaunch(sessionId, encodeRelaunchPlan(plan), new Date());
              relaunching.add(sessionId);
            }
            const outcome = yield* stopWorkspaceQuietly(sessionId, {
              force: true,
              reason: "relaunch",
            });
            if (outcome === "kept" || outcome === "discarded") {
              const drained = yield* sessions.byId(sessionId);
              const error = new SealantPlatformError({
                code: "capture_not_saved",
                status: 409,
                message: `${captureStatusLine(drained) ?? "not saved · workspace kept"} · the previous workspace holds captures not yet saved · resume again once it saves, or discard unsaved and stop`,
                cause: null,
              });
              yield* settleSession(sessionId, "stopped", error.message).pipe(Effect.ignore);
              return yield* error;
            }
            // The owner stopped the session while its old executor saved: nothing relaunches.
            if (capture !== null && (yield* sessions.relaunchOf(sessionId)) === null) {
              return yield* new SealantPlatformError({
                code: "relaunch_cancelled",
                status: 409,
                message: "stopped while the previous workspace saved · nothing relaunched",
                cause: null,
              });
            }
          }
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
              settleSession(sessionId, "failed", `launch failed: ${error.message}`).pipe(
                Effect.ignore,
              ),
            ),
          );
        // Everything runs as the OWNER: the account stamped at provision. A session with no owner
        // has nobody to act as and never borrows another account (docs/adr/0003).
        const ownerUserId = session.ownerUserId;
        if (ownerUserId === null) {
          return yield* settleOnFailure(
            Effect.fail(
              new SealantPlatformError({
                code: "NO_PRINCIPAL",
                status: null,
                message: "this session has no owner to run as; start a new session",
                cause: null,
              }),
            ),
          );
        }
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
        // An unusable standby (dead, half-stamped) was never replanned: nothing of the session's
        // is on it, so its claim is released at once rather than waited out by the cold path.
        if (capture !== null && claimedEntry !== null && adopted === null) {
          const lease = yield* capture.repo.leaseOf(session.worktreeId);
          if (
            lease !== null &&
            lease.executorId === sessionId &&
            lease.launchId === standbyLaunchIdOf(claimedEntry.id)
          ) {
            yield* capture.repo.release(session.worktreeId, lease.epoch);
            yield* Effect.logInfo(
              "session engine: capture mode · claimed standby unusable · its claim released · cold launch",
            ).pipe(Effect.annotateLogs({ sessionId, epoch: lease.epoch }));
          }
        }
        // Capture mode: one executor per worktree (ADR-0002 "The key is the worktree"). A join,
        // a sibling shell or a phone pickup runs as another process inside the lease holder's
        // executor; a launch that would need a second executor for a leased worktree is refused
        // with `worktree_leased`.
        if (capture !== null && adopted === null) {
          const waitStartedAt = Date.now();
          const holder = yield* awaitWorktreeHolder(session, reusedCreateKey);
          if (holder.kind === "held") {
            yield* Effect.logInfo("session engine: capture mode · joining the lease holder").pipe(
              Effect.annotateLogs({ sessionId, holderSessionId: holder.sessionId }),
            );
            // Whose home the join runs in (docs/adr/0010): unknown reads as another person's.
            const holderOwner = yield* sessions.byId(SessionId.make(holder.sessionId)).pipe(
              Effect.map((held) => held.ownerUserId),
              Effect.orElseSucceed(() => null),
            );
            // A resume through a join opens the conversation it names, as a cold one does.
            return yield* launchInRetainedWorkspace(
              sessionId,
              savedConversationArgv(session.harness, manifest, protocolStart, argv),
              null,
              correlationId,
              manifest !== null && manifest.harness === session.harness
                ? manifest.providerSessionId
                : protocolResumeId,
              protocolStart,
              protocolAuthor,
              holder.workspace,
              holderOwner,
            ).pipe(
              Effect.catchTag("SessionNotLiveError", (error) =>
                Effect.fail(
                  new SealantPlatformError({
                    code: "worktree_leased",
                    status: 409,
                    message: `the lease holder's executor went away while joining: ${error.sessionId}`,
                    cause: error,
                  }),
                ),
              ),
            );
          }
          if (holder.kind !== "free") {
            const message =
              holder.kind === "unreachable"
                ? `worktree leased · held by session ${holder.sessionId} under epoch ${holder.epoch} · the lease expires at ${holder.expiresAt} unless its heartbeat continues`
                : holder.kind === "ending"
                  ? `worktree leased · session ${holder.sessionId}'s executor is saving before it ends · start again once it has`
                  : `worktree leased · session ${holder.sessionId}'s lease lapsed under epoch ${holder.epoch} · its executor ${holder.state === "answering" ? "still answers" : "was not answered for"} · nothing stopped · it may hold work not yet saved`;
            const waitedMinutes = Math.round((Date.now() - waitStartedAt) / 60_000);
            const error = new SealantPlatformError({
              code: "worktree_leased",
              status: 409,
              message: waitedMinutes >= 1 ? `${message} · waited ${waitedMinutes} min` : message,
              cause: null,
            });
            yield* settleSession(sessionId, "failed", error.message).pipe(Effect.ignore);
            return yield* error;
          }
        }
        // Capture mode: a worktree without a chain was made before captures — attach it now,
        // so capture 0 carries its directory's current files (a claimed standby did this at
        // claim, before its lease was taken).
        if (capture !== null && adopted === null) {
          yield* ensureCaptureZero(project.id, session.worktreeId).pipe(
            Effect.mapError(
              (error) =>
                new SealantPlatformError({
                  code: "capture_backfill_failed",
                  status: null,
                  message: `capture 0 could not be registered for worktree ${session.worktree}: ${error._tag === "GitError" ? error.stderr : error.message}`,
                  cause: error,
                }),
            ),
            settleOnFailure,
          );
        }
        let launchClaim: { readonly epoch: number } | null = null;
        // The cold executor's launch identity, minted before its lease is claimed: the lease is
        // bound to it (cross-repo decision 11), and so are its token and its create.
        const coldLaunchKey = reusedCreateKey ?? executorCreateKeyFor(sessionId, new Date());
        // Capture mode: Mend claims the lease at launch (epoch + 1, the chain fenced in the
        // same statement) with a boot-sized TTL, bound to the launch; the executor learns the
        // epoch from its first plan and the first heartbeat brings the TTL back to the 30 s
        // cadence. The same create asked again (`reusedCreateKey`) is the same launch and keeps
        // that epoch — the executor it makes, whichever request commits, plans under it — for as
        // long as its ownership is unresolved: a claim that lapsed meanwhile is renewed under
        // its own epoch, never fenced by a new one (review 2026-09-28 (4) #14). Only a confirmed
        // cancellation or end (which releases the lease) lets a new epoch be taken.
        const reusedClaim =
          capture === null || reusedCreateKey === null
            ? null
            : yield* capture.repo.leaseOf(session.worktreeId);
        const reusedHeld =
          reusedClaim !== null &&
          reusedClaim.executorId === sessionId &&
          ((reusedClaim.launchId ?? null) === null || reusedClaim.launchId === reusedCreateKey);
        const renewedReserved =
          capture !== null &&
          adopted === null &&
          reusedClaim !== null &&
          reusedHeld &&
          !reusedClaim.live &&
          (yield* capture.repo.heartbeat(
            session.worktreeId,
            reusedClaim.epoch,
            LAUNCH_CLAIM_TTL_SECONDS,
            { executorId: sessionId, launchId: coldLaunchKey },
          ));
        if (
          capture !== null &&
          adopted === null &&
          reusedClaim !== null &&
          reusedHeld &&
          (reusedClaim.live || renewedReserved)
        ) {
          launchClaim = { epoch: reusedClaim.epoch };
        } else if (capture !== null && adopted === null) {
          launchClaim = yield* capture.repo
            .claim(session.worktreeId, sessionId, LAUNCH_CLAIM_TTL_SECONDS, coldLaunchKey)
            .pipe(
              Effect.mapError(
                () =>
                  new SealantPlatformError({
                    code: "worktree_leased",
                    status: 409,
                    message: "worktree leased · another executor claimed it first",
                    cause: null,
                  }),
              ),
              settleOnFailure,
            );
        }
        // A cold provision that failed before the platform accepted its create ran no executor:
        // the launch's own claim is released, or it would refuse the next launch of this very
        // worktree for its whole TTL. After the create, an executor may exist and keeps the lease.
        let executorCreated = false;
        // Capture mode: the executor the platform accepted is the session's at once — its
        // workspace on the row before any setup command, relocation, install or harness runs in
        // it (review 2026-09-28 #7). Whatever fails after that leaves an addressable executor that
        // holds removal and its worktree until its end is observed, and it is drained, never
        // stopped outright: it may hold work nothing else has.
        // The launch identity of the executor this launch is asking for (cross-repo decision 5):
        // set by each create before it is asked, never shared with another executor.
        let launchId: string | null = null;
        const acceptExecutor = (workspace: Workspace, launch: string) =>
          Effect.gen(function* () {
            executorCreated = true;
            if (capture === null) return;
            yield* sessions.recordAcceptedWorkspace(
              sessionId,
              SealantWorkspaceId.make(workspace.id),
              executorStartedAt,
              launch,
            );
            yield* noteExecutorResource(sessionId, workspace);
          });
        const abandonExecutor = (workspace: Workspace, message: string) =>
          capture === null
            ? sealant.stopWorkspace(workspace).pipe(Effect.ignore)
            : Effect.logWarning(
                "session engine: capture mode · the launch failed after its executor was created · draining it",
              ).pipe(
                Effect.annotateLogs({ sessionId, workspaceId: workspace.id, message }),
                Effect.andThen(
                  Effect.forkIn(
                    owned(sessionId)(
                      stopWorkspaceIfUnleased(sessionId, { force: true, reason: "stop" }),
                    ),
                    scope,
                  ),
                ),
                Effect.asVoid,
              );
        // The key this launch's create is asked under, written on the row right before it is
        // asked (`createKey.onAsking`); null until then.
        let createKey: string | null = null;
        const releaseUnusedClaim = Effect.gen(function* () {
          if (capture === null || launchClaim === null || executorCreated) return;
          // A create asked again under a key whose earlier attempt never answered holds that
          // attempt's claim (review 2026-09-28 (5) #13): this attempt's failure says nothing of
          // the earlier one, which may still commit. The claim stays until the key resolves —
          // an executor found under it, or the platform's fence (`resolveExecutorCreate`).
          if (
            reusedCreateKey !== null &&
            (yield* sessions.executorCreateOf(sessionId)) === reusedCreateKey
          ) {
            return;
          }
          const lease = yield* capture.repo.leaseOf(session.worktreeId);
          if (lease?.executorId !== sessionId || lease.epoch !== launchClaim.epoch) return;
          yield* capture.repo.release(session.worktreeId, launchClaim.epoch);
          yield* Effect.logInfo(
            "session engine: capture mode · launch failed before any executor · lease released",
          ).pipe(Effect.annotateLogs({ sessionId, epoch: launchClaim.epoch }));
        });
        // The capture this launch's setup commands were skipped for (`prepareExecutor`): said on
        // the session line once the launch starts.
        let setupSkippedFrom: number | null = null;
        const provisionCold = (key: string) => {
          // One launch per physical executor: a fresh key, or — for a create whose answer was
          // lost and that nothing is on record for yet — the same key asked again, which can
          // only ever make that one executor. Minted before the lease is claimed for it.
          launchId = key;
          // Read after this launch's lease claim: the head the executor's plan lays down.
          return restoredCaptureOf(session.worktreeId).pipe(
            Effect.flatMap((restoredFrom) => provisionColdFrom(key, restoredFrom)),
            Effect.tap((provisioned) =>
              Effect.sync(() => {
                setupSkippedFrom = provisioned.setupSkippedFrom;
              }),
            ),
          );
        };
        const provisionColdFrom = (key: string, restoredFrom: number | null) => {
          return provisionWorkspace({
            project,
            restoredFrom,
            sessionId,
            socketDir,
            shape,
            ownerUserId,
            onFailure: (message) =>
              settleSession(sessionId, "failed", `launch failed: ${message}`).pipe(Effect.ignore),
            onCreated: (workspace) => acceptExecutor(workspace, key),
            abandon: abandonExecutor,
            launchId: key,
            watchCreate: watchLaunchPhase(sessionId),
            warmHarness: session.harness,
            ...(capture === null
              ? {}
              : {
                  createKey: {
                    key,
                    onAsking: Effect.gen(function* () {
                      creatingExecutors.add(sessionId);
                      yield* sessions.recordExecutorCreate(sessionId, key);
                      createKey = key;
                    }),
                  },
                }),
          }).pipe(
            Effect.tapError((error) =>
              createKey === null || executorCreated
                ? releaseUnusedClaim
                : // The create was asked and did not answer with a workspace. A refusal (4xx)
                  // made none under THIS attempt; anything else may have made one Mend has not
                  // seen. A key asked again after an earlier attempt that never answered stays
                  // reserved whatever this attempt heard (review 2026-09-28 (5) #13): a
                  // refusal — a validation Core runs before its idempotent replay, an access
                  // check — disproves nothing of that earlier request, which may still commit.
                  // Only an executor found under the key or the platform's fence releases it.
                  error._tag === "SealantPlatformError" &&
                    error.status !== null &&
                    error.status >= 400 &&
                    error.status < 500
                  ? createKey === reusedCreateKey
                    ? Effect.logWarning(
                        "session engine: capture mode · executor create · asked again and refused · the earlier attempt is still unresolved · the key stays reserved",
                      ).pipe(
                        Effect.annotateLogs({
                          sessionId,
                          key: createKey,
                          status: error.status,
                          error: error.message,
                        }),
                      )
                    : sessions
                        .clearExecutorCreate(sessionId, createKey)
                        .pipe(Effect.andThen(releaseUnusedClaim))
                  : resolveExecutorCreate(sessionId, createKey).pipe(Effect.asVoid),
            ),
            Effect.ensuring(Effect.sync(() => creatingExecutors.delete(sessionId))),
          );
        };
        // What the platform's cap counts from: a claimed standby's own creation (it has been
        // running since it warmed), else the moment before the create — never later than the
        // executor's real start.
        let executorStartedAt =
          adopted !== null && claimedEntry !== null ? claimedEntry.createdAt : new Date();
        let provisioned = adopted ?? (yield* provisionCold(coldLaunchKey));
        // Capture mode, a claimed standby (`hot-pool.ts` "Capture-mode standby"): its executor
        // booted on the project base under a placeholder; `capture.replan` makes it fetch the
        // plan again — the channel answers this session's worktree, the epoch the claim took
        // and the head — and materialise the head as a delta.
        //
        // The standby is this session's executor before it is asked anything (review 2026-09-28
        // (3) #1): on the row under its own launch, its pool row gone, so it is drained, kept or
        // recovered like any executor and keeps its token while its end is not confirmed. A
        // replan that fails, times out or answers another identity may still have left work on
        // it (a lost answer): it is drained as a relaunch drains, and only once its end is
        // observed does a cold executor start — under a fresh epoch and its own launch, never
        // the standby's. Kept: the launch is refused and nothing else starts.
        if (capture !== null && adopted !== null && claimedEntry !== null) {
          const standbyLaunch = standbyLaunchIdOf(claimedEntry.id);
          launchId = standbyLaunch;
          yield* acceptExecutor(provisioned.workspace, standbyLaunch);
          yield* hotWorkspaces.remove(claimedEntry.id);
          const replanned = yield* replanClaimedStandby(session, provisioned.workspace);
          if (replanned === null) {
            const outcome = yield* stopWorkspaceQuietly(sessionId, {
              force: true,
              reason: "relaunch",
            });
            if (outcome === "kept" || outcome === "discarded") {
              const drained = yield* sessions.byId(sessionId);
              const error = new SealantPlatformError({
                code: "capture_not_saved",
                status: 409,
                message: `${captureStatusLine(drained) ?? "not saved · workspace kept"} · the claimed standby may hold work not yet saved · start again once it saves, or discard unsaved and stop`,
                cause: null,
              });
              yield* settleSession(sessionId, "failed", error.message).pipe(Effect.ignore);
              return yield* error;
            }
            // Only an end the platform confirmed lets another executor start: then its lease is
            // released and the next executor takes a fresh epoch.
            const standbyState = yield* workspaceState(
              SealantWorkspaceId.make(provisioned.workspace.id),
            );
            if (standbyState !== "dead") {
              const error = new SealantPlatformError({
                code: "capture_not_saved",
                status: 409,
                message:
                  "the claimed standby's end is not observed yet · it may hold work not yet saved · nothing else started · start again once it has ended",
                cause: null,
              });
              yield* settleSession(sessionId, "failed", error.message).pipe(Effect.ignore);
              return yield* error;
            }
            executorCreated = false;
            const fallbackKey = executorCreateKeyFor(sessionId, new Date());
            launchClaim = yield* capture.repo
              .claim(session.worktreeId, sessionId, LAUNCH_CLAIM_TTL_SECONDS, fallbackKey)
              .pipe(
                Effect.mapError(
                  () =>
                    new SealantPlatformError({
                      code: "worktree_leased",
                      status: 409,
                      message: "worktree leased · another executor claimed it first",
                      cause: null,
                    }),
                ),
                settleOnFailure,
              );
            executorStartedAt = new Date();
            provisioned = yield* provisionCold(fallbackKey);
          } else {
            // Claimed: what a cold launch runs right after its create runs now, and not before
            // (e2e9 F-B: an exec on an unclaimed standby clears sealantd's unclaimed marker). A
            // replan onto a saved head runs no setup command (review 2026-09-28 (15) #1).
            setupSkippedFrom = yield* prepareExecutor({
              sessionId,
              workspace: provisioned.workspace,
              workspaceImage: provisioned.workspaceImage,
              captured: true,
              restoredFrom: replanned.restoredFrom,
              onFailure: (message) =>
                settleSession(sessionId, "failed", `launch failed: ${message}`).pipe(Effect.ignore),
              abandon: abandonExecutor,
              warmHarness: session.harness,
            });
          }
        }
        const { workspace, workspaceImage, environmentManifest } = provisioned;
        // A standby claimed outside capture mode is the session's from here on, as a cold create
        // is from its accepted create (`acceptExecutor`).
        if (capture !== null && !executorCreated) {
          yield* acceptExecutor(workspace, launchId ?? standbyLaunchIdOf(sessionId));
        }
        // Standby (ADR-0001): the workspace mounted the project's worktrees root; point its
        // working directory at THIS session's worktree before anything looks for the repo. The
        // daemon records the bind and the platform re-applies it on every relaunch. Capture
        // mode binds nothing: sealantd materialised the head capture, claimed the lease, and
        // the harness starts on the executor's own disk.
        if (capture === null) {
          yield* sealant
            .bindWorkspace(workspace, { subpath: session.worktree })
            .pipe(
              Effect.tapError((error) =>
                settleSession(
                  sessionId,
                  "failed",
                  `launch failed: could not bind the worktree — ${error.message}`,
                ).pipe(Effect.ignore),
              ),
            );
          yield* bindLinkedProjects(workspace, project, ownerUserId);
        }
        yield* sessions.setWorkspaceImage(sessionId, workspaceImage);
        // Stamped alongside the image: what this session ACTUALLY launched with — the repo
        // url+ref that was cloned and the exact snapshot sha the store packed (for a hot
        // workspace: whatever the prewarm actually applied).
        yield* sessions.setDotfiles(sessionId, provisioned.dotfiles);
        // The owner's git author (docs/GIT-ACCESS.md, "Git author"), for a cold workspace and a
        // claimed standby alike: system config, written before the harness starts, so dotfiles
        // and repository config still decide over it.
        yield* applyGitAuthor(sessionId, workspace, ownerUserId);
        // Mend's default shell profile, beside it and for the same launches: dotfiles were
        // applied at boot, so only a file they left absent is written.
        yield* applyDefaultShellProfile(sessionId, workspace, project, workspaceImage);

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
          // A live harness home already carries the state this archive would restore — and
          // newer: the harness wrote it up to the moment the last workspace ended. Boot
          // symlinks it back into `$HOME`; untarring an older settle-time capture over it
          // would only roll files back. Restore from the archive only when no live state
          // exists (legacy sessions, a cleared home). Capture mode: the harness home is the
          // workspace class of the head capture, materialised by sealantd — nothing to restore.
          const liveState =
            capture !== null ||
            (yield* hasLiveHarnessState(
              harnessHomePathOf(project.storePath, session.id),
              manifest.harness,
            ));
          if (!liveState) {
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
                  settleSession(sessionId, "failed", `resume failed: ${error.message}`).pipe(
                    Effect.andThen(abandonExecutor(workspace, error.message)),
                    Effect.ignore,
                  ),
                ),
              );
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
          shapedArgv = savedConversationArgv(session.harness, manifest, protocolStart, shapedArgv);
        }

        if (nativeImport !== null && capture !== null) {
          // Staging rides the mounted worktree, which capture mode does not have. SEAM: a
          // converted session is delivered through the executor's own disk once the channel
          // grows a file-drop route; until then the target harness starts fresh.
          yield* Effect.logWarning(
            "session engine: capture mode · converted native session not placed (no mounted worktree)",
          ).pipe(Effect.annotateLogs({ sessionId }));
        } else if (nativeImport !== null) {
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
              settleSession(sessionId, "failed", `resume failed: ${error.message}`).pipe(
                Effect.andThen(abandonExecutor(workspace, error.message)),
                Effect.ignore,
              ),
            ),
          );
        }

        // The conversation lands EVERYWHERE: the workspace image carries every
        // supported harness, so harnesses not already covered — by the
        // original restore or the target import — get the saved conversation
        // converted into their own native format. A mend shell (or the agent
        // itself, switched mid-session) then opens it in place. Best-effort:
        // a missing transcript or failed conversion never fails a launch.
        if (manifest !== null && capture === null) {
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
        // Make harness state durable from the first turn. Restore, connected-account injection and
        // native imports write into $HOME first; this step moves them into the durable root and
        // replaces each harness directory with a symlink before the process starts. Capture mode's
        // root is local to sealantd, so it does not need the co-located permission keeper.
        // A secret file delivered at a path reserved since goes before its directory is captured,
        // or the launch stops here: relocating anyway could save it.
        yield* evictReservedSecretFiles(session, workspace).pipe(
          Effect.tapError((error) =>
            capture === null ? Effect.void : abandonExecutor(workspace, error.message),
          ),
          settleOnFailure,
        );
        const relocation = relocateHarnessHome(session, workspace);
        if (capture === null) {
          // Keep the established co-located policy: report a failed mount relocation but let the
          // launch continue. Capture executors are disposable, so their failure is load-bearing.
          yield* relocation.pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: harness-home relocation failed").pipe(
                Effect.annotateLogs({ sessionId, error: String(error) }),
              ),
            ),
          );
        } else {
          yield* relocation.pipe(
            Effect.tapError((error) => abandonExecutor(workspace, error.message)),
            settleOnFailure,
          );
          // Capture mode mounts nothing: the skills the co-located store writes beside the
          // mounted harness home go into this workspace's own, now that it is in place.
          yield* deliverSkillsToWorkspace(session, project, workspace).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: skills were not delivered to the workspace").pipe(
                Effect.annotateLogs({ sessionId, message: error.message }),
              ),
            ),
          );
        }
        yield* handOverAgentMemory(session, workspace).pipe(
          Effect.tapError((error) => abandonExecutor(workspace, error.message)),
          settleOnFailure,
        );
        yield* deliverAgentMemory(session, project, workspace).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: agent memory was not delivered").pipe(
              Effect.annotateLogs({ sessionId, message: error.message }),
            ),
          ),
        );
        const carried = yield* carryCodexConversations(session, project, workspace).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session engine: codex conversations were not carried").pipe(
              Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
              Effect.as([]),
            ),
          ),
        );
        const codexMemoryOn = yield* withholdCodexThreads(session, workspace, shapedArgv, carried);
        yield* deliverPiProfile(session, project, workspace).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: the pi profile was not delivered").pipe(
              Effect.annotateLogs({ sessionId, message: error.message }),
            ),
          ),
        );
        // The owner's secret files (docs/adr/0010): into the executor's own home, which no capture
        // root covers, before the harness starts.
        yield* deliverSecretFiles(session, workspace).pipe(
          Effect.catch((error) =>
            Effect.logWarning("session engine: secret files were not written").pipe(
              Effect.annotateLogs({ sessionId, message: error.message }),
              Effect.andThen(
                noteLaunchWords(
                  sessionId,
                  `${SECRET_FILES_SUMMARY_PREFIX} · not written · ${error.message}`,
                ),
              ),
            ),
          ),
        );
        // Repositories added in an earlier launch (docs/adr/0010): their files came back with the
        // worktree, their links did not. A relink that cannot run costs the links, never the launch.
        const noRepositories: ReadonlyArray<SessionRepositoryRow> = [];
        const repositories = yield* relinkRepositories(session, workspace).pipe(
          // Every cause but the launch's own interruption: a platform error, a store that did not
          // answer, a defect. None of them is the launch's to fail on.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("session engine: repositories were not relinked").pipe(
                  Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                  Effect.as(noRepositories),
                ),
          ),
        );
        // State restore can rewrite $HOME, while a hot claim can freshen mend.toml after prewarm.
        // Rewrite the managed note after both paths so it reflects the claimed worktree now. It
        // is written through exec in either store, so a captured executor's agent reads the same
        // Mend Services instructions (its mend.toml read from the workspace's own worktree).
        yield* appendWorkspaceNote(
          workspace,
          project,
          worktree,
          provisioned.referenceMounts,
          provisioned.extraMounts,
          repositories,
        );

        // Capture mode: the dependency tree for THIS executor's platform, before the harness.
        // Said on the session line once the launch starts, like `setupSkippedFrom`.
        let dependencyInstallSkipped: string | null = null;
        if (capture !== null) {
          dependencyInstallSkipped = yield* installDependenciesIfNeeded(
            session,
            project,
            workspace,
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: dependency install did not run").pipe(
                Effect.annotateLogs({ sessionId, error: String(error) }),
                Effect.as(null),
              ),
            ),
          );
        }

        const memoryShapedArgv = codexMemoryOn
          ? shapedArgv
          : withCodexMemoryOff(shapedArgv, { join: false });
        // opencode's conversations as they stand before it starts: what it starts afterwards is its
        // own (`opencodeConversationOf`). Read now, before the harness can write a new one.
        const opencodeAtLaunch =
          session.harness === "opencode" && !interactiveShell && protocolStart === null
            ? yield* opencodeLaunchSnapshot(session, project.storePath, null).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("session engine: opencode launch snapshot not read").pipe(
                    Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                    Effect.as(null),
                  ),
                ),
              )
            : null;
        const launchedArgv =
          protocolStart === null
            ? withHarnessBootstrap(session.harness, memoryShapedArgv, {
                captured: capture !== null,
              })
            : withHarnessSetup(session.harness, memoryShapedArgv, { captured: capture !== null });
        const pty = yield* refuseIfStoppedDuringLaunch(sessionId).pipe(
          Effect.andThen(
            sealant.openSession(
              workspace,
              launchedArgv,
              protocolStart === null ? undefined : { mode: "pipe" },
            ),
          ),
          // Co-located: the workspace's id is not on the row yet — reap it here or it burns
          // until the platform TTL. Capture mode: the row names it (`acceptExecutor`), and it
          // drains before it goes. A stop that came first leaves the same executor behind.
          Effect.tapError((error) => abandonExecutor(workspace, error.message)),
          settleOnFailure,
        );
        const sealantRunId = SealantRunId.make(pty.runId);
        // Refused in words only over a run of the session still live, which the gates above
        // rule out: the PTY just opened closes, and its executor goes as after any failed launch.
        yield* createSessionRun({
          sessionId,
          harness: session.harness,
          sealantRunId,
          sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
          sealantSessionId: pty.id,
          ...environmentManifest,
        }).pipe(
          Effect.tapError((error) =>
            closeProcessPty(SealantWorkspaceId.make(workspace.id), pty.id).pipe(
              Effect.andThen(abandonExecutor(workspace, error.message)),
            ),
          ),
        );
        yield* sessions.setSealantIds(
          sessionId,
          sealantRunId,
          SealantWorkspaceId.make(workspace.id),
        );
        yield* sessions.setExecutorStartedAt(sessionId, executorStartedAt);
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
          launchCorrelationId: correlationId,
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
          protocolOptions:
            protocolStart === null
              ? null
              : {
                  model: protocolStart.model ?? null,
                  effort: protocolStart.effort ?? null,
                  permissionMode: protocolStart.permissionMode ?? "bypass",
                },
          label: session.harness,
          argv: shapedArgv,
        });
        if (opencodeAtLaunch !== null) {
          yield* writeOpencodeLaunchSnapshot(
            processStatePathOf(project.storePath, sessionId, agentProcess.id),
            opencodeAtLaunch,
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: opencode launch snapshot not kept").pipe(
                Effect.annotateLogs({ sessionId, error: String(error) }),
              ),
            ),
          );
        }
        if (protocolStart !== null) {
          yield* protocolHost
            .attach({
              process: agentProcess,
              pipe: pty,
              cwd: "/workspace/repo",
              model: protocolStart.model,
              effort: protocolStart.effort,
              permissionMode: protocolStart.permissionMode ?? "bypass",
              hooks: protocolHooksFor(agentProcess),
              // The session's own workspace, created or claimed with its owner's login.
              launchedWithLoginOf: session.ownerUserId,
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
        // The agent runs and its process row exists: the session reads `running` now, before any
        // bookkeeping that asks the platform something (its resource id, its TTL), so a slow or
        // unanswered call there never leaves a running agent reading `starting` (alpha
        // 2026-09-30, cc05cb8a and 48763b65).
        //
        // Always reopen, not only for follow-ups: a plain launch on a row that
        // already settled (a failed first attempt retried) must clear
        // settled_at, or the first-settle-wins guard ignores this run's exit
        // and the row reads "running" forever — unstoppable and undeletable.
        yield* sessions.reopen(sessionId, "running");
        yield* clearStaleStartSummary(sessionId);
        // After the stale words go, as the setup line does: said before, it went with them.
        if (opencodeAtLaunch === null && session.harness === "opencode" && !interactiveShell) {
          yield* noteLaunchWords(sessionId, OPENCODE_SNAPSHOT_MISSING).pipe(Effect.ignore);
        }
        if (setupSkippedFrom !== null) {
          yield* noteLaunchWords(sessionId, setupSkippedWords(setupSkippedFrom));
        }
        if (dependencyInstallSkipped !== null) {
          yield* noteLaunchWords(sessionId, dependencyInstallSkipped);
        }
        // Until its record carries output, the agent reads as starting on its new machine, not
        // as a blank screen; supervision takes the words off at its first output
        // (`noteFirstOutput`). A protocol agent draws nothing until asked: it never says so.
        const startingWords =
          protocolStart === null && !interactiveShell
            ? agentStartingWords(session.harness, true)
            : null;
        if (startingWords !== null) yield* noteLaunchWords(sessionId, startingWords);
        yield* forkSupervision(sessionId, sealantRunId);

        // The agent process ends on its own; the fold over every process decides the session.
        yield* Effect.forkIn(watchProcess(agentProcess), scope);
        // The runtime is launched by now, where it may not have been at the create.
        yield* noteExecutorResource(sessionId, workspace);
        yield* renewWorkspaceLease(sessionId, agentProcess.sealantWorkspaceId);
        if (protocolStart !== null) {
          const openingInput = protocolStart.prompt?.trim() ?? "";
          if (openingInput !== "") {
            yield* protocolHost
              .submitTurn(sessionId, openingInput, protocolAuthor, correlationId)
              .pipe(
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

      /**
       * A launch, and the end of any relaunch it planned: once it has run its course — launched,
       * refused or failed — nothing is left for a restart to finish. A process that dies first
       * leaves the plan for the reaper (`resumeDrain`).
       */
      const launchInternal: typeof launchInternalBody = (sessionId, ...rest) =>
        launchInternalBody(sessionId, ...rest).pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() =>
              // Interrupted (a shutdown, a scope closing): the plan stays for the next start.
              relaunching.delete(sessionId) && !interruptedOnly(exit)
                ? sessions.clearRelaunch(sessionId)
                : Effect.void,
            ),
          ),
        );

      /** The engine-side observations a protocol adapter reports back; both launch paths and rehydrate share them. */
      const protocolHooksFor = (agentProcess: SessionProcess): ProtocolHostHooks => ({
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
      });

      const launchProtocol = Effect.fn("SessionEngine.launchProtocol")(function* (
        sessionId: SessionId,
        requested: LaunchStart,
        author: string | null,
        launchCorrelationId: string | null = null,
        forceFreshWorkspace = false,
        /**
         * A mode handoff's: the agent it just ended held the current workspace, and its
         * successor starts there (one live agent process at a time, same executor).
         */
        handedOver = false,
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
        // A continuation that names neither a model nor an effort (a resume, a stopped session's
        // follow-up) runs on what the session was started with (docs/models-audit.md); a start
        // that names either is taken as given.
        const withModel: LaunchStart =
          requested.model === undefined && requested.effort === undefined
            ? {
                ...requested,
                ...(session.model === null ? {} : { model: session.model }),
                ...(session.effort === null ? {} : { effort: session.effort }),
              }
            : requested;
        // A continuation that names no permission mode keeps the one its last protocol agent
        // recorded: a session that asked for approval comes back asking. A first launch, or one
        // after a terminal agent, has none recorded and runs on the default.
        const recordedPermissionMode =
          previous?.kind === "agent-protocol"
            ? previous.protocolOptions?.permissionMode
            : undefined;
        const start: LaunchStart =
          requested.permissionMode === undefined && recordedPermissionMode !== undefined
            ? { ...withModel, permissionMode: recordedPermissionMode }
            : withModel;
        // Any prior same-harness agent resumes by provider id — a PTY-born
        // session picked up in protocol mode continues the same conversation
        // (mode handoff), not a fresh one.
        const providerSessionId =
          previous !== null && previous.harness === session.harness
            ? (previous.providerSessionId ?? undefined)
            : undefined;
        const composed = composeProtocolArgv(session.harness, start, providerSessionId);
        if (composed instanceof ProtocolHarnessUnsupportedError) {
          return yield* Effect.fail(composed);
        }
        // Admitted and composable: the model and effort this launch runs on are the session's
        // from here, written before the workspace builds so the row says what runs.
        yield* sessions.setLaunchOptions(sessionId, {
          model: start.model ?? null,
          effort: start.effort ?? null,
        });
        // A fresh-workspace relaunch must carry the harvested state with it: the composed
        // argv resumes by provider id, and without the restored transcript the harness
        // refuses the resume ("No conversation found"). A first launch (no prior protocol
        // process) keeps the explicit null, which skips the read and stays hot-claimable.
        const located =
          providerSessionId === undefined
            ? null
            : yield* harnessStateFor(session).pipe(
                Effect.catchTag("HarnessStateNotFoundError", () => Effect.succeed(null)),
              );
        const launchFresh = () =>
          launchInternal(
            sessionId,
            composed,
            null,
            located,
            launchCorrelationId,
            start,
            author,
            providerSessionId ?? null,
          );
        const retainCurrentWorkspace =
          !forceFreshWorkspace && (yield* retainedWorkspaceAvailable(session, handedOver));
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

      /**
       * Bring the worktree's registered captures up to its disk: the lease holder's flush, after
       * any checkpoint under way for the worktree (the checkpoint writer's permit), so a turn's own
       * boundary checkpoint finishes first. Takes no checkpoint and records nothing.
       */
      const flushCaptures = Effect.fn("SessionEngine.flushCaptures")(function* (
        sessionId: SessionId,
        why: string,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (capture === null) return "none" satisfies CaptureFlushObservation;
        return yield* withCheckpointWriter(
          session.worktreeId,
          flushLeaseHolder(session.worktreeId, why),
        );
      });

      /**
       * A landing's step 1 in capture mode: the checkpoint is taken only once the registered head
       * has caught up with the executor (`requireCaughtUp`), asked again after a pause while it has
       * not; `CapturesBehindError` after the last attempt. Answers the capture the checkpoint was
       * derived from, so the landing reads exactly that capture and nothing registered after it.
       */
      const landingCheckpoint = Effect.fn("SessionEngine.landingCheckpoint")(function* (
        sessionId: SessionId,
        trigger: CheckpointTrigger,
      ) {
        const session = yield* sessions.byId(sessionId);
        const worktree = yield* worktreesRepo.byId(session.worktreeId).pipe(Effect.orDie);
        const latestRun = yield* sessionRuns.latestForSession(sessionId);
        const cursor = {
          sealantRunId: latestRun?.sealantRunId ?? null,
          sequence: latestRun?.lastSeenSequence ?? 0n,
        };
        for (let attempt = 1; ; attempt += 1) {
          const taken = yield* takeWorktreeSnapshot(
            worktree,
            trigger,
            session.id,
            cursor,
            capture !== null,
          ).pipe(Effect.result);
          if (Result.isSuccess(taken)) {
            yield* refreshChangeHead(session).pipe(Effect.ignore);
            return taken.success;
          }
          if (taken.failure._tag !== "CapturesBehindError") return yield* taken.failure;
          if (attempt >= LANDING_FLUSH_ATTEMPTS) {
            yield* Effect.logWarning(
              "session engine: landing checkpoint · the captures did not catch up · nothing taken",
            ).pipe(Effect.annotateLogs({ sessionId, worktreeId: worktree.id, attempts: attempt }));
            return yield* new CapturesBehindError({ worktreeId: worktree.id, attempts: attempt });
          }
          yield* Effect.logInfo(
            "session engine: landing checkpoint · the captures have not caught up",
          ).pipe(Effect.annotateLogs({ sessionId, attempt, attempts: LANDING_FLUSH_ATTEMPTS }));
          yield* Effect.sleep(LANDING_FLUSH_PAUSE);
        }
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
        pi: ["pi"],
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

      /**
       * Once a launch has started — in a fresh executor or in the retained one (review 2026-09-28
       * (12) #5) — clear what an earlier launch that never started left (`launch failed · …`,
       * `launch cancelled · …`, `launch interrupted · …`), and Mend's verdict on how an earlier
       * executor, or an earlier look at this one, ended (`stopped outside Mend · saved at …`,
       * `executor not answering · …`): they say nothing of this start, and a session read `running
       * · launch failed · the harness never started`, `running · stopped outside Mend · saved at …
       * · capture 13` after a resume (e2e8 F7, (i)), or `running · executor not answering · …`
       * after a resume into the retained workspace whose executor answered it. `executor lost · …`
       * stays (`STALE_ON_START_PREFIXES`).
       */
      const clearStaleStartSummary = Effect.fn("SessionEngine.clearStaleStartSummary")(function* (
        sessionId: SessionId,
      ) {
        const reopened = yield* sessions.byId(sessionId);
        // What the launch said while it was under way (`sayLaunchPhase`) ends with it, and so do
        // the starting words of an agent that ended before it drew (`agentStartingWords`).
        const priorSummary = withoutLaunchPhase(withoutAgentStarting(reopened.summary));
        if (
          priorSummary !== null &&
          STALE_ON_START_PREFIXES.some((prefix) => priorSummary.startsWith(prefix))
        ) {
          yield* sessions.setSummary(sessionId, null);
        } else if (priorSummary !== reopened.summary) {
          yield* sessions.setSummary(sessionId, priorSummary);
        }
      });

      /** The agent drew, or ended: the session line stops saying it is starting. */
      const clearAgentStartingWords = Effect.fn("SessionEngine.clearAgentStartingWords")(function* (
        sessionId: SessionId,
      ) {
        const current = yield* sessions.byId(sessionId);
        const next = withoutAgentStarting(current.summary);
        if (next !== current.summary) yield* sessions.setSummary(sessionId, next);
      });

      /**
       * Where a launch stands, on the session line of a session that has not started yet: waiting
       * for the worktree's previous executor, building the workspace image, booting. Replaces what
       * the launch said last; whatever else the summary says stays in front of it. A session that
       * reads anything but `starting` (a resume of a settled one, a stop that landed meanwhile)
       * keeps its own words.
       */
      const sayLaunchPhase = Effect.fn("SessionEngine.sayLaunchPhase")(function* (
        sessionId: SessionId,
        words: string,
      ) {
        const current = yield* sessions
          .byId(sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (current === null || current.status !== "starting" || current.settledAt !== null) {
          return;
        }
        const before = withoutLaunchPhase(current.summary);
        const next = before === null ? words : `${before} · ${words}`;
        if (next !== current.summary) yield* sessions.setSummary(sessionId, next);
      });

      /**
       * While a cold create gets ready: `booting` at once, and `building the workspace image …`
       * once the platform has reported no executor for `imageBuildAfter` (Core launches the runtime
       * only after it has built or found the image); `booting` again once an executor exists.
       * Best-effort: a look that fails says nothing new, and the create never waits on it.
       */
      const watchLaunchPhase =
        (sessionId: SessionId) =>
        (workspace: Workspace): Effect.Effect<void> =>
          Effect.gen(function* () {
            const since = Date.now();
            yield* sayLaunchPhase(sessionId, LAUNCH_BOOTING);
            while (true) {
              yield* Effect.sleep(drainPolicy.createPhaseInterval);
              const runtime = yield* Effect.tryPromise(() => workspace.runtime()).pipe(
                Effect.option,
              );
              if (Option.isNone(runtime)) continue;
              const building =
                runtime.value === null &&
                Date.now() - since >= Duration.toMillis(drainPolicy.imageBuildAfter);
              yield* sayLaunchPhase(sessionId, building ? LAUNCH_PREPARING : LAUNCH_BOOTING);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("session engine: launch phase watch ended").pipe(
                    Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                  ),
            ),
          );

      /**
       * Said once, as the launch starts: what this executor did not run before the harness — the
       * custom image's setup commands, because it laid the worktree down from a saved capture
       * (review 2026-09-28 (15) #1), or the dependency install, because the head's manifest was
       * unavailable ((16) #1). Beside what the summary already says (`executor lost · …` stays);
       * the next start clears it (`STALE_ON_START_PREFIXES`).
       */
      const noteLaunchWords = Effect.fn("SessionEngine.noteLaunchWords")(function* (
        sessionId: SessionId,
        words: string,
      ) {
        const current = yield* sessions.byId(sessionId);
        yield* sessions.setSummary(
          sessionId,
          current.summary === null ? words : `${current.summary} · ${words}`,
        );
      });

      /**
       * Whose login a workspace launched with (docs/adr/0013), decided from the workspace a
       * process runs in, never from how the launch reached it. Outside capture mode a session's
       * workspace is its own: its owner's. In capture mode the worktree's one executor is the
       * lease holder's, launched on its owner's login, whichever session's process runs in it: the
       * holder's, a join, or a later run of a joined session. Null when the lease names no
       * session, or one whose workspace is not this one: Mend cannot say whose login it holds.
       */
      const launchLoginOfWorkspace = Effect.fn("SessionEngine.launchLoginOfWorkspace")(function* (
        session: Session,
        workspaceId: SealantWorkspaceId,
      ) {
        if (capture === null) return session.ownerUserId;
        const lease = yield* capture.repo.leaseOf(session.worktreeId);
        if (lease === null || lease.executorId === null || lease.executorId.startsWith("mend:")) {
          return null;
        }
        const holder = yield* sessions
          .byId(SessionId.make(lease.executorId))
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        return holder !== null && holder.sealantWorkspaceId === workspaceId
          ? holder.ownerUserId
          : null;
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
          /** Capture mode: the lease holder's workspace, where a join runs as one more process. */
          workspaceOverride: Workspace | null = null,
          /**
           * With `workspaceOverride`: who owns the lease holder's session, so the home it writes
           * into is known to be theirs (docs/adr/0010): a join into another person's executor
           * receives no secret files of its own there.
           */
          executorOwnerUserId: string | null = null,
        ) {
          const session = yield* sessions.byId(sessionId);
          // As at a cold launch: a run the session's settle left open takes its words first.
          yield* settleRunsOfSettled(sessionId);
          const project = yield* projects.byId(session.projectId);
          const worktree = worktreePathOf(project.storePath, session.worktree);
          const workspace =
            workspaceOverride ??
            (yield* workspaceForSupportingProcess(session).pipe(
              Effect.catchTag("SealantPlatformError", () =>
                Effect.fail(new SessionNotLiveError({ sessionId })),
              ),
            ));
          // Read before this launch writes the workspace onto the session's row: a session that
          // joined another person's executor keeps running there on that person's login.
          const launchedWithLoginOf =
            protocolStart === null
              ? null
              : yield* launchLoginOfWorkspace(session, SealantWorkspaceId.make(workspace.id));
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
          // A secret file delivered at a path reserved since goes before its directory is captured,
          // or the resume stops here: relocating anyway could save it.
          yield* evictReservedSecretFiles(session, workspace).pipe(
            Effect.tapError((error) =>
              settleSession(sessionId, "failed", `resume failed: ${error.message}`).pipe(
                Effect.ignore,
              ),
            ),
          );
          const relocation = relocateHarnessHome(session, workspace);
          if (capture === null) {
            yield* relocation.pipe(
              Effect.catch((error) =>
                Effect.logWarning("session engine: harness-home relocation failed").pipe(
                  Effect.annotateLogs({ sessionId, error: String(error) }),
                ),
              ),
            );
          } else {
            // A retained executor may predate this layout. Re-run the idempotent relocation before
            // every join or resume rather than start another process with an ephemeral HOME.
            yield* relocation.pipe(
              Effect.tapError((error) =>
                settleSession(sessionId, "failed", `resume failed: ${error.message}`).pipe(
                  Effect.ignore,
                ),
              ),
            );
          }
          // The owner's secret files again (docs/adr/0010): a retained executor may predate a
          // file the owner added or replaced since its launch, and this run reads the home as it
          // is now. Only into a home that is the owner's: the session's own executor, or a lease
          // holder's whose session the same person owns. A join into another person's executor
          // writes nothing, and the log says so.
          const homeIsOwners =
            workspaceOverride === null ||
            (executorOwnerUserId !== null && executorOwnerUserId === session.ownerUserId);
          if (homeIsOwners) {
            yield* deliverSecretFiles(session, workspace).pipe(
              Effect.catch((error) =>
                Effect.logWarning("session engine: secret files were not written").pipe(
                  Effect.annotateLogs({ sessionId, message: error.message }),
                ),
              ),
            );
          } else if (session.ownerUserId !== null) {
            yield* Effect.logInfo(
              "session engine: secret files not written · the executor is another person's",
            ).pipe(Effect.annotateLogs({ sessionId }));
          }
          // A retained workspace may hold a repository whose add this server did not see end
          // (docs/adr/0010): settle it from what the workspace holds, as a fresh launch would.
          // Never the launch's to fail on.
          yield* relinkRepositories(session, workspace).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("session engine: repositories were not relinked").pipe(
                    Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                  ),
            ),
          );
          const interactiveShell = argv[0] === "bash";
          const shapedArgv = interactiveShell
            ? interactiveShellArgv(session.workspaceImage, argv.slice(1))
            : argv;
          // A Codex in a home that is not the launcher's (a join) touches no thread's memory mode:
          // the home owner's selection stands. It starts with its memory off and makes no thread
          // anyone's Codex will summarise.
          // Decided on what runs, not the harness's name: a `mend run -- codex` is a Codex too.
          const ownHome =
            capture === null ||
            !launchesCodex(shapedArgv) ||
            (session.ownerUserId !== null &&
              (yield* liveHomeOwnerOf(session, SealantWorkspaceId.make(workspace.id))) ===
                session.ownerUserId);
          const codexMemoryOn =
            ownHome && (yield* withholdCodexThreads(session, workspace, shapedArgv, []));
          const memoryShapedArgv = codexMemoryOn
            ? shapedArgv
            : withCodexMemoryOff(shapedArgv, { join: !ownHome });
          // opencode's conversations as they stand before it starts: what it starts afterwards is its
          // own (`opencodeConversationOf`). Read now, before the harness can write a new one.
          const opencodeAtLaunch =
            session.harness === "opencode" && !interactiveShell && protocolStart === null
              ? yield* opencodeLaunchSnapshot(session, project.storePath, workspace).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("session engine: opencode launch snapshot not read").pipe(
                      Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                      Effect.as(null),
                    ),
                  ),
                )
              : null;
          const launchedArgv =
            protocolStart === null
              ? withHarnessBootstrap(session.harness, memoryShapedArgv, {
                  captured: capture !== null,
                })
              : withHarnessSetup(session.harness, memoryShapedArgv, { captured: capture !== null });
          const pty = yield* refuseIfStoppedDuringLaunch(sessionId).pipe(
            Effect.andThen(
              sealant.openSession(
                workspace,
                launchedArgv,
                protocolStart === null ? undefined : { mode: "pipe" },
              ),
            ),
            Effect.tapError((error) =>
              settleSession(sessionId, "failed", `resume failed: ${error.message}`).pipe(
                Effect.ignore,
              ),
            ),
          );
          const sealantRunId = SealantRunId.make(pty.runId);
          const previousRun = yield* sessionRuns.latestForSession(sessionId);
          // Refused in words only over a run of the session still live: the PTY just opened in
          // the retained workspace closes, and the workspace stays with what holds it.
          yield* createSessionRun({
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
          }).pipe(
            Effect.tapError(() => closeProcessPty(SealantWorkspaceId.make(workspace.id), pty.id)),
          );
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
            protocolOptions:
              protocolStart === null
                ? null
                : {
                    model: protocolStart.model ?? null,
                    effort: protocolStart.effort ?? null,
                    permissionMode: protocolStart.permissionMode ?? "bypass",
                  },
            label: session.harness,
            argv: shapedArgv,
          });
          if (opencodeAtLaunch !== null) {
            yield* writeOpencodeLaunchSnapshot(
              processStatePathOf(project.storePath, sessionId, agentProcess.id),
              opencodeAtLaunch,
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("session engine: opencode launch snapshot not kept").pipe(
                  Effect.annotateLogs({ sessionId, error: String(error) }),
                ),
              ),
            );
          }
          if (protocolStart !== null) {
            yield* protocolHost
              .attach({
                process: agentProcess,
                pipe: pty,
                cwd: "/workspace/repo",
                model: protocolStart.model,
                effort: protocolStart.effort,
                permissionMode: protocolStart.permissionMode ?? "bypass",
                hooks: protocolHooksFor(agentProcess),
                launchedWithLoginOf,
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
          // See launchInternal: reopen unconditionally so a retried row settles again, and before
          // the TTL renewal asks the platform anything.
          yield* sessions.reopen(sessionId, "running");
          // The retained executor answered and started this process: what an earlier look at it
          // concluded (`executor not answering · …`) no longer holds (review 2026-09-28 (12) #5).
          yield* clearStaleStartSummary(sessionId);
          if (opencodeAtLaunch === null && session.harness === "opencode" && !interactiveShell) {
            yield* noteLaunchWords(sessionId, OPENCODE_SNAPSHOT_MISSING).pipe(Effect.ignore);
          }
          // As at a cold launch, on the machine that is already up (`agentStartingWords`).
          const startingWords =
            protocolStart === null && !interactiveShell
              ? agentStartingWords(session.harness, false)
              : null;
          if (startingWords !== null) yield* noteLaunchWords(sessionId, startingWords);
          yield* forkSupervision(sessionId, sealantRunId);
          yield* Effect.forkIn(watchProcess(agentProcess), scope);
          yield* renewWorkspaceLease(sessionId, agentProcess.sealantWorkspaceId);
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

      /**
       * Whether a launch may join the session's current workspace rather than replace it: a shell,
       * a Service or a forward still holds it, or (`handedOver`) a mode handoff just ended the
       * agent that held it and is starting its successor there. Either way the workspace must be
       * live and not final-flushed.
       */
      const retainedWorkspaceAvailable = Effect.fn("SessionEngine.retainedWorkspaceAvailable")(
        function* (session: Session, handedOver = false) {
          if (session.sealantWorkspaceId === null) return false;
          const supportingLeases = (yield* processes.listLiveForWorkspace(
            session.sealantWorkspaceId,
          )).filter((process) => !isAgentProcessKind(process.kind));
          const forwardLeases = (yield* serviceForwards.listOpen()).filter(
            (forward) => forward.sealantWorkspaceId === session.sealantWorkspaceId,
          );
          if (!handedOver && supportingLeases.length === 0 && forwardLeases.length === 0) {
            return false;
          }
          if (yield* workspaceFinalFlushed(session.worktreeId, session.sealantWorkspaceId)) {
            return false;
          }
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
        // "starting" is a launch in flight only when something was actually launched. A
        // provisioned-but-never-launched session carries the same status (the schema default)
        // with nothing behind it — refusing that would dead-end every provision-then-resume
        // flow (the editor's workbench: create → shell resume → open).
        if (session.status === "starting") {
          return session.sealantWorkspaceId !== null || session.sealantRunId !== null;
        }
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
        author: string | null,
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
            yield* protocolHost
              .submitTurn(sessionId, instruction, author, launchCorrelationId)
              .pipe(
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
            // No permission mode named: the relaunch keeps the one recorded (`launchProtocol`).
            { mode: "protocol", prompt: instruction },
            author,
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
        // A terminal started with someone's words is them typing there, on whatever login the
        // workspace holds: only the owner's follow-up starts one (docs/adr/0013).
        if (author !== null && author !== session.ownerUserId) {
          return yield* new SealantPlatformError({
            code: "terminal_owner_only",
            status: 403,
            message:
              "only the session owner starts its agent in a terminal, even while control is shared; the owner can continue it as a conversation",
            cause: null,
          });
        }
        const argv = promptArgv(session.harness, instruction, {
          model: session.model,
          effort: session.effort,
        });
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
        // Mode handoff: a formerly-protocol session picked up from a terminal
        // must come back as a TUI, not re-enter protocol mode.
        forcePty = false,
        // Mode handoff: the agent it ended held the current workspace; the TUI starts there.
        handedOver = false,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        // A settled session resumes with no run of it open: one left `running` when it settled
        // takes the session's words now, before the launch below records the next one.
        yield* settleRunsOfSettled(sessionId);
        if (yield* agentIsLive(session)) {
          // Capture mode: "already live" holds only while the worktree lease does. An expired
          // lease with a dead executor is a PICKUP, never `session_active` — confirm the
          // termination on the platform, fence the old token, and fall through to a relaunch
          // whose first plan claims epoch + 1 (ADR-0002 "Replacement and pickup").
          const pickup = capture === null ? "live-lease" : yield* confirmDeadExecutor(session);
          if (pickup === "live-lease") {
            return yield* new SealantPlatformError({
              code: "session_active",
              status: null,
              message: "The session is already live — attach to it instead of resuming.",
              cause: null,
            });
          }
          // Only a positively dead executor is picked up: one that still answers holds what it
          // has not shipped, and one the platform did not answer for may too. Nothing is stopped.
          if (pickup === "answering") {
            return yield* new SealantPlatformError({
              code: "executor_paused",
              status: 409,
              message:
                "executor paused · lease expired · it still answers · nothing stopped · it resumes once its heartbeat lands",
              cause: null,
            });
          }
          if (pickup === "unknown") {
            return yield* new SealantPlatformError({
              code: "executor_unknown",
              status: 409,
              message:
                "lease expired · the platform did not answer for the executor · nothing stopped · try again",
              cause: null,
            });
          }
          // Ended on its runtime and kept by the platform: its disk may hold work only it has,
          // and the platform may boot it again to save it. Nothing new starts over it.
          if (pickup === "kept") {
            return yield* new SealantPlatformError({
              code: "capture_not_saved",
              status: 409,
              message:
                "not saved · executor kept for recovery · nothing started · resume again once it saves, or discard unsaved and stop",
              cause: null,
            });
          }
        }
        const target = harness ?? session.harness;
        const priorAgent = currentAgentProcess(yield* processes.listForSession(sessionId));
        if (!forcePty && priorAgent?.kind === "agent-protocol" && target === session.harness) {
          return yield* launchProtocol(
            sessionId,
            // No permission mode named: the relaunch keeps the one recorded (`launchProtocol`).
            { mode: "protocol" },
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
        const retainCurrentWorkspace =
          !fresh && (yield* retainedWorkspaceAvailable(session, handedOver));
        // A shell resume reopens the worktree with no agent: saved state
        // restored when it exists — and none required, because the session
        // that died before harvesting is exactly the one worth a shell. The
        // session keeps its harness identity; only this launch runs a shell.
        // launchInternal lays the conversation down for every supported
        // harness, so either agent opens it natively from inside the shell.
        if (target === "shell") {
          // A shell opens no conversation: saved state it cannot read, or a conversation Mend
          // cannot tell is the session's (opencode, review 2026-10-04 round 4), is no state here,
          // never a refusal.
          const located = yield* harnessStateFor(session).pipe(
            Effect.catchTags({
              HarnessStateNotFoundError: () => Effect.succeed(null),
              HarnessStateIOError: () => Effect.succeed(null),
              HarnessStateInvalidError: () => Effect.succeed(null),
            }),
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

        // Resume addresses the LATEST agent process's capture (its provider session id). opencode
        // keeps no file to find: what is missing is a conversation Mend can tell is this
        // session's, and the refusal says so.
        const located = yield* harnessStateFor(session).pipe(
          Effect.mapError((error) =>
            error._tag === "HarnessStateNotFoundError" && session.harness === "opencode"
              ? new HarnessStateInvalidError({
                  sessionId,
                  path: error.path,
                  message: `opencode left no conversation Mend can tell is session ${sessionId}'s; refusing to open another one.`,
                  cause: error,
                })
              : error,
          ),
        );
        const { stateDir, manifest } = located;
        let argv = defaultArgv;
        let nativeImport: ConvertedNativeSession | null = null;
        if (
          manifest.harness === target &&
          (target === "claude" || target === "codex" || target === "opencode") &&
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
        if (retainCurrentWorkspace) argv = savedConversationArgv(target, manifest, null, argv);
        if (target !== session.harness) {
          yield* sessions.setHarness(sessionId, target);
          // The converted launch names no model: the new harness picks its own, and the row
          // says so rather than keeping the old harness's (docs/models-audit.md).
          yield* sessions.setLaunchOptions(sessionId, { model: null, effort: null });
        }
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

      /**
       * A Stop is in flight from its entry to its tail's end (`stopTailsDone`), so a discard can
       * wait for every one of them; under a discard that has stopped the session itself
       * (`discardSealed`) a Stop is already answered and starts nothing that could read under the
       * lease the discard is about to release (Astra review, 2026-10-03). Entry and release are
       * one uninterruptible step; the Stop itself runs interruptible.
       */
      const stop = (
        sessionId: SessionId,
        summary: string | null = null,
      ): Effect.Effect<void, SessionNotFoundError> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            if ((discardSealed.get(sessionId) ?? 0) > 0) return Effect.void;
            const inFlight = { done: Deferred.makeUnsafe<void>(), tail: false };
            const set = stopTailsDone.get(sessionId) ?? new Set<Deferred.Deferred<void>>();
            set.add(inFlight.done);
            stopTailsDone.set(sessionId, set);
            return restore(stopUnguarded(sessionId, summary, inFlight)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (inFlight.tail) return;
                  set.delete(inFlight.done);
                  if (set.size === 0) stopTailsDone.delete(sessionId);
                  Deferred.doneUnsafe(inFlight.done, Exit.succeed(undefined));
                }),
              ),
            );
          }),
        );
      const stopUnguarded = Effect.fn("SessionEngine.stop")(function* (
        sessionId: SessionId,
        summary: string | null,
        inFlight: { readonly done: Deferred.Deferred<void>; tail: boolean },
      ) {
        const session = yield* sessions.byId(sessionId);
        // A launch still waiting for the worktree's previous executor launches nothing now.
        if (waitingLaunches.has(sessionId)) stoppedWhileWaiting.add(sessionId);
        // One further along stands down before its agent starts, or is stopped again as it ends.
        if (launchGate.underWay(sessionId)) stoppedDuringLaunch.add(sessionId);
        const rows = yield* processes.listForSession(sessionId);
        const activeRun = yield* sessionRuns.activeForSession(sessionId);
        // Capture mode: when nothing but what this stop ends holds the workspace, the stop is a
        // drain, and the session reads `stopping · saving` from this answer on — recorded before
        // the agent ends, so the fold never settles a session whose container still runs. The
        // intent is durable: if this process dies before the tail below reaches it, the reaper
        // takes it up after the restart. The owner's stop wins over a relaunch or a replacement
        // still saving the old executor: the drain goes on, and nothing launches after it, here
        // or after a restart.
        if (capture !== null) {
          yield* sessions.clearRelaunch(sessionId);
          yield* sessions.stopCaptureDrain(sessionId);
          if (replacing.has(sessionId)) stoppedDuringReplacement.add(sessionId);
        }
        if (capture !== null && session.sealantWorkspaceId !== null) {
          const workspaceId = session.sealantWorkspaceId;
          const liveAgents = rows.filter(isLiveAgentProcess);
          // A stop that ends a live agent keeps the session's shells; one with no agent to end
          // closes them too (below).
          const ending = new Set(
            (liveAgents.length > 0
              ? liveAgents
              : rows.filter((row) => row.kind === "shell" && isLiveProcess(row))
            ).map((row) => row.id),
          );
          const held =
            (yield* processes.listLiveForWorkspace(workspaceId)).filter(
              (process) => !ending.has(process.id),
            ).length +
            (yield* serviceForwards.listOpen()).filter(
              (forward) => forward.sealantWorkspaceId === workspaceId,
            ).length;
          if (held === 0) yield* sessions.beginCaptureDrain(sessionId, "stop", new Date());
        }
        // Stop = end the agent. Every live agent process closes (the daemon reaps its process
        // group) and is recorded as stopped; the fold then reads `idle` while shells or Services
        // hold the workspace, `stopping` while a drain saves it, or settles `stopped` at once.
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
            summary,
          });
          if (recorded) ended.push(agent);
        }
        if (ended.length === 0) {
          // No agent to close — a run attached without a process, a launch still in flight,
          // or agents that already exited. A stop aimed here means THE SESSION dies (amended
          // 2026-08-31): close the supporting shells too, or an orphan bash from a dropped
          // attach holds the workspace and the session reads idle forever — the
          // refuses-to-die failure mode. A stop that DID end a live agent keeps its shells:
          // you may be sitting in one watching the agent, and a second stop takes them too.
          // Services stay either way — declared infrastructure with its own verb.
          const liveShells = rows.filter((row) => row.kind === "shell" && isLiveProcess(row));
          for (const shell of liveShells) {
            if (shell.sealantSessionId !== null) {
              yield* closeProcessPty(shell.sealantWorkspaceId, shell.sealantSessionId);
            }
            yield* processes.markExited(shell.id, "stopped", null);
          }
          if (activeRun !== null) {
            yield* sessionRuns.settle(activeRun.sealantRunId, "stopped", summary);
          }
          const after = liveShells.length > 0 ? yield* processes.listForSession(sessionId) : rows;
          if (foldSessionLiveness(after) === "settled") {
            yield* settleSession(sessionId, "stopped", summary);
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
        // The settle carries the summary through the agent's run; a stopped session whose run
        // said otherwise (or that had none) still reads the one asked for.
        if (
          summary !== null &&
          afterSettle.status === "stopped" &&
          afterSettle.summary !== summary
        ) {
          yield* sessions.setSummary(sessionId, summary);
        }
        const cursor = {
          sealantRunId: activeRun?.sealantRunId ?? null,
          sequence: activeRun?.lastSeenSequence ?? 0n,
        };
        const workspaceId = session.sealantWorkspaceId;
        // The tail below drains the workspace: the stop's checkpoint reads that final flush's
        // head, and this answer does not wait for a flush of its own (decision 50). Not so (the
        // workspace held by more than what ends): the mark is taken now, flush and all.
        const atFinal = workspaceId !== null && (yield* endsAtFinal(workspaceId));
        const markNow = Effect.gen(function* () {
          yield* tryCheckpoint(session, "user-mark", cursor);
          yield* refreshChangeHead(session).pipe(Effect.ignore);
        });
        if (!atFinal) yield* markNow;
        // The workspace outlives the PTY just long enough to harvest, then
        // dies (unless a lease holds it; in capture mode once it has saved);
        // forked so a stop request answers immediately. If this process dies
        // first, the next boot's leftover sweep (and the capture reaper) finish
        // the job.
        // Marked and forked in one step: marked but never forked, the reaper would skip this
        // session for good (Astra review, 2026-10-03).
        yield* Effect.uninterruptible(
          Effect.suspend(() => {
            // The mark is put off, and the tail marked and forked, in this one step: put off
            // but never forked, nothing would run it. Admission refused (a drain closed the
            // queue meanwhile): the tail takes the mark itself first, flush and all.
            const deferred =
              atFinal &&
              workspaceId !== null &&
              deferToFinal(workspaceId, (reading) =>
                Effect.gen(function* () {
                  yield* tryCheckpoint(session, "user-mark", cursor, observedOf(reading));
                  yield* refreshChangeHead(session).pipe(Effect.ignore);
                }),
              );
            stopTails.add(sessionId);
            inFlight.tail = true;
            const tailDone = inFlight.done;
            const tailsDone = stopTailsDone.get(sessionId) ?? new Set<Deferred.Deferred<void>>();
            const tail = (
              ended.length > 0
                ? Effect.forEach(ended, (agent) => finishAgentProcess(agent, null, true, true), {
                    discard: true,
                  })
                : sweepWorkspace(sessionId, true)
            ).pipe(
              // No drain holds it (none ran, or one ran the queue already): what is still put off
              // runs now, as it would have before. A drain that kept the executor leaves it for the
              // round that saves.
              Effect.ensuring(
                Effect.suspend(() =>
                  workspaceId === null || queueHeld.has(workspaceId)
                    ? Effect.void
                    : runDeferredDetached(workspaceId, "none").pipe(Effect.asVoid),
                ),
              ),
              Effect.ensuring(Effect.sync(() => stopTails.delete(sessionId))),
            );
            return Effect.forkIn(
              (atFinal && !deferred ? Effect.andThen(markNow, tail) : tail).pipe(
                // Around the whole of it, the inline mark included: a mark that dies must not
                // leave the session marked as tailing for good (Astra review, 2026-10-03).
                Effect.ensuring(
                  Effect.sync(() => {
                    stopTails.delete(sessionId);
                    tailsDone.delete(tailDone);
                    if (tailsDone.size === 0) stopTailsDone.delete(sessionId);
                    Deferred.doneUnsafe(tailDone, Exit.succeed(undefined));
                  }),
                ),
              ),
              scope,
            );
          }),
        );
      });

      /**
       * Mode handoff, the history half: land the newest same-harness agent's
       * native transcript (harvested to `transcript.native`) as durable
       * conversation turns past the ingest cursor. Never blocks the handoff —
       * live turns still work with missing history, and the transcript view
       * keeps the full record either way.
       */
      const backfillNativeHistory = Effect.fn("SessionEngine.backfillNativeHistory")(function* (
        session: Session,
        sourceAgent: SessionProcess | null,
      ) {
        if (sourceAgent === null || sourceAgent.harness === null) return;
        const refreshed = yield* processes.byId(sourceAgent.id);
        const providerSessionId =
          refreshed?.providerSessionId ??
          sourceAgent.providerSessionId ??
          session.providerSessionId;
        if (providerSessionId === null) return;
        const project = yield* projects.byId(session.projectId);
        const transcriptPath = path.join(
          processStatePathOf(project.storePath, session.id, sourceAgent.id),
          "transcript.native",
        );
        const native = yield* Effect.promise(() =>
          fs.readFile(transcriptPath, "utf8").catch(() => null),
        );
        if (native === null || native === "") return;
        const cursor = yield* sessions.nativeIngestCursor(session.id);
        const parsed = backfillFromNative(sourceAgent.harness, providerSessionId, native, cursor);
        if (parsed === null) return;
        const landed = yield* conversations.backfillConversation(
          session.id,
          sourceAgent.id,
          parsed.turns,
        );
        yield* sessions.setNativeIngestCursor(session.id, parsed.cursor);
        yield* Effect.logInfo("session engine: native history backfilled").pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            processId: sourceAgent.id,
            turns: landed,
          }),
        );
      });

      /**
       * Cross-mode pickup: one live agent process at a time, the provider
       * session id the durable identity. Ends the other-mode agent gracefully
       * (harvesting synchronously — the relaunch needs the provider id and
       * transcript now), backfills PTY-era history for protocol pickups, and
       * continues the same conversation in the requested mode.
       */
      const handoff = Effect.fn("SessionEngine.handoff")(function* (
        sessionId: SessionId,
        to: "protocol" | "pty",
        start: LaunchStart,
        author: string | null,
      ) {
        const session = yield* sessions.byId(sessionId);
        if (isLegacyBench(session)) {
          return yield* new LegacyBenchReadOnlyError({ sessionId });
        }
        if (session.harness !== "claude" && session.harness !== "codex") {
          return yield* new HandoffUnsupportedError({
            sessionId,
            harness: session.harness,
            to,
          });
        }
        const rows = yield* processes.listForSession(sessionId);
        const liveAgents = rows.filter(isLiveAgentProcess);
        const wantedKind = to === "protocol" ? "agent-protocol" : "agent-pty";
        if (liveAgents.some((agent) => agent.kind === wantedKind)) {
          return session;
        }
        // Graceful takeover: end the other-mode agents. endAgentProcess records
        // without the sweep tail, so the workspace stays leased across the gap.
        let handedOver: SessionProcess | null = null;
        for (const agent of liveAgents) {
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
            summary: `handed off to ${to}`,
          });
          if (recorded) {
            handedOver = agent;
            // Synchronous, not the forked finish tail: the relaunch below needs the harvested
            // provider id and transcript immediately. Capture mode must register the final write
            // first; there is no sleep or cadence guess between process close and harvest.
            const captureReady = yield* flushBeforeHarvest(
              session,
              agent.sealantWorkspaceId,
              "handoff harvest",
            );
            if (!captureReady) {
              return yield* new SealantPlatformError({
                code: "handoff_capture_flush_incomplete",
                status: null,
                message: "The final agent state was not captured; handoff was stopped.",
                cause: null,
              });
            }
            yield* tryHarvest(agent);
          }
        }
        const sourceAgent = handedOver ?? currentAgentProcess(rows);
        if (to === "protocol") {
          // History lands before the opening protocol turn, so the phone's
          // first render is already the full conversation.
          yield* backfillNativeHistory(session, sourceAgent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session engine: native backfill failed").pipe(
                Effect.annotateLogs({ sessionId, cause: String(cause) }),
              ),
            ),
          );
          // The agent it ended held the session's workspace: its successor starts in it, never in
          // a fresh one. A fresh workspace cost the 2026-10-02 pickup 2 min 14 s: the old one's
          // save and stop, then a boot and a restore, for a process swap.
          return yield* launchProtocol(
            sessionId,
            { ...start, mode: "protocol" },
            author,
            null,
            false,
            handedOver !== null && handedOver.sealantWorkspaceId === session.sealantWorkspaceId,
          );
        }
        return yield* resumeSession(
          sessionId,
          null,
          false,
          true,
          handedOver !== null && handedOver.sealantWorkspaceId === session.sealantWorkspaceId,
        ).pipe(
          Effect.catchTag("HarnessStateNotFoundError", () =>
            Effect.fail(
              new SealantPlatformError({
                code: "handoff_state_missing",
                status: null,
                message:
                  "No saved harness state to reopen as a terminal — resume the session instead.",
                cause: null,
              }),
            ),
          ),
        );
      });

      const workspaceForSupportingProcess = Effect.fn(
        "SessionEngine.workspaceForSupportingProcess",
      )(function* (session: Session) {
        const workspaceId = session.sealantWorkspaceId;
        if (workspaceId === null) return yield* new SessionNotLiveError({ sessionId: session.id });
        // A final flush ended it: it admits nothing more.
        if (yield* workspaceFinalFlushed(session.worktreeId, workspaceId)) {
          return yield* new SessionNotLiveError({ sessionId: session.id });
        }
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

      /**
       * The worktree's `mend.toml` recipes, wherever the worktree is: beside this process when
       * the deployment co-locates it, else in the session's live workspace — the only copy
       * capture mode has that includes the agent's latest edit. No live workspace there is a
       * typed `SessionNotLiveError`, never a defect.
       */
      const fileRecipesOf = Effect.fn("SessionEngine.fileRecipesOf")(function* (session: Session) {
        const mount = yield* sessionRepo.worktreeMount(session.projectId, session.worktree);
        if (mount !== undefined) return yield* readServiceRecipes(mount);
        const workspace = yield* workspaceForSupportingProcess(session);
        return yield* readWorkspaceRecipes(workspace);
      });

      const listServiceRecipes = Effect.fn("SessionEngine.listServiceRecipes")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.byId(sessionId);
        const fromFile = yield* fileRecipesOf(session).pipe(
          Effect.catchTag("SessionNotLiveError", () =>
            Effect.succeed<ReadonlyArray<ServiceRecipe>>([]),
          ),
        );
        return mergeRecipes(fromFile, yield* projectRecipes.listForProject(session.projectId));
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
        // The row's snapshot keeps URLs stable, but operator policy can move under it — a
        // Pod gets a new IP on every replacement. A snapshot that no longer validates
        // re-resolves from the CURRENT policy instead of failing the restart.
        const recorded = service.bindAddresses ?? previous?.boundAddresses ?? null;
        const bindAddresses =
          recorded !== null && validateServiceBindAddresses(recorded).ok
            ? recorded
            : yield* serviceHost.bindAddresses();
        const forward = yield* serviceForwards.createAndSelect({
          serviceId,
          sealantWorkspaceId: workspaceId,
          preferredHostPort: previous?.hostPort ?? service.preferredHostPort,
          supersedesForwardId: previous?.id ?? null,
        });
        yield* renewWorkspaceLease(service.sessionId, workspaceId);
        // Captured for the host's detached work (probe timer, connection dials): those run
        // outside any request context and must still act as the session owner.
        const ownerSession = yield* sessions.byId(service.sessionId).pipe(Effect.option);
        const binding = yield* serviceHost
          .start({
            serviceId,
            forwardId: forward.id,
            workspaceId,
            workspacePort,
            protocol,
            bindAddresses,
            ownerUserId: Option.isSome(ownerSession) ? ownerSession.value.ownerUserId : null,
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
        const fromFile = yield* fileRecipesOf(session).pipe(
          Effect.catchTags({
            ProjectNotFoundError: () =>
              Effect.fail(
                new ServiceStartError({ message: "The recipe's project no longer exists." }),
              ),
            SessionNotLiveError: () =>
              Effect.fail(
                new ServiceStartError({
                  message:
                    "This session has no live workspace, so its mend.toml cannot be read. Resume it, then run the recipe.",
                }),
              ),
            RecipeFileError: (error) =>
              Effect.fail(new ServiceStartError({ message: error.message })),
          }),
        );
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
          ...(capture === null
            ? {}
            : {
                capture: captureApiFor(sessionId),
                captureAs: (launchId: string) => captureApiFor(sessionId, launchId),
              }),
          recipes: () =>
            listServiceRecipes(sessionId).pipe(
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
          runService: (argv, port, name, protocol, browserScheme) =>
            runService(sessionId, argv, port, name, protocol, browserScheme ?? null).pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.orDie,
            ),
          addService: (port, name, protocol, browserScheme) =>
            addService(sessionId, port, name, protocol, browserScheme ?? null).pipe(
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
          stopSession: () =>
            stop(sessionId).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          // The landing worker answers (`WorkspaceGitHooks`): it depends on the engine, so it
          // cannot be one of the engine's dependencies.
          land: () => gitHooks.landRequested(sessionId),
          // Repositories in a session (docs/adr/0010): the helper's `mend repo` verbs. A refusal
          // reaches the helper as its message.
          listRepositories: () =>
            listRepositories(sessionId).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          addableProjects: () =>
            addableProjects(sessionId).pipe(
              Effect.mapError((error) => new Error(String(error.message))),
              Effect.orDie,
            ),
          addRepository: (input) =>
            addRepository(sessionId, input).pipe(
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
              const origin =
                project.originUrl === null ? null : gitRemoteLocation(project.originUrl);
              if (
                bindTransportToOrigin &&
                origin !== null &&
                !isSameGitRemote(origin, { host, port })
              ) {
                return yield* Effect.fail(
                  new Error(
                    `this session's Git access is bound to ${origin.host}; pushes and fetches to ${host} run without Mend's signer`,
                  ),
                );
              }
              const mode = project.gitAuthMode;
              // The session's owner signs: their Mend key, never another user's.
              const owner = yield* sessions
                .byId(sessionId)
                .pipe(Effect.map((ownerRow) => ownerRow.ownerUserId));
              const keyPath =
                mode === "mend-key"
                  ? (yield* mendKeys
                      .ensure(owner)
                      .pipe(
                        Effect.mapError(
                          (error) => new Error(`could not create the Mend key: ${error.stderr}`),
                        ),
                      )).privateKeyPath
                  : null;
              // Bridge mode signs on another machine: require the signer NOW —
              // an honest fast refusal in the workspace terminal beats an ssh
              // that hangs against an agent socket nobody serves.
              // The owner's own signer, never another account's (docs/adr/0003).
              let env: Record<string, string> | undefined;
              if (mode === "bridge") {
                if (owner === null) {
                  return yield* Effect.fail(
                    new Error("this session has no owner, so no signer can be chosen"),
                  );
                }
                const bridgeStatus = yield* agentBridge.status(owner);
                if (!bridgeStatus.connected) {
                  return yield* Effect.fail(new Error(NO_SIGNER_MESSAGE));
                }
                env = { SSH_AUTH_SOCK: agentBridge.socketPath(owner) };
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
              if (mode === "bridge" && owner !== null) {
                const end = yield* agentBridge.begin(
                  owner,
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
              // A push that moved branches on origin: a pull request from one may follow.
              if (exitCode === 0 && pushedBranches(refUpdates)) {
                const session = yield* sessions.byId(sessionId);
                yield* gitHooks.branchesPushed({ sessionId, worktreeId: session.worktreeId });
              }
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

      /** A Service holds its workspace while its attempt runs or its forward is open. */
      const serviceIsLive = Effect.fn("SessionEngine.serviceIsLive")(function* (service: Service) {
        const attempt =
          service.currentAttemptId === null
            ? null
            : yield* processes.byId(service.currentAttemptId);
        if (attempt !== null && attempt.exitedAt === null) return true;
        const forward =
          service.currentForwardId === null
            ? null
            : yield* serviceForwards.byId(service.currentForwardId);
        return forward !== null && (forward.state === "binding" || forward.state === "bound");
      });

      const stopServices = Effect.fn("SessionEngine.stopServices")(function* (
        sessionId: SessionId,
      ) {
        yield* sessions.byId(sessionId);
        let stopped = 0;
        for (const service of yield* services.listForSession(sessionId)) {
          if (!(yield* serviceIsLive(service))) continue;
          yield* stopService(service.id).pipe(
            Effect.catchTag("ServiceNotFoundError", () => Effect.void),
          );
          stopped += 1;
        }
        return stopped;
      });

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
        const settings = yield* settingsRepo.forOrganization(project.organizationId);
        const workspaceImage = project.workspaceImage ?? settings.workspaceImage;
        const dotfilesEnabled =
          project.applyDotfiles && workspaceImage.mode !== "custom" && ownerUserId !== null;
        const repository =
          dotfilesEnabled && ownerUserId !== null
            ? yield* userDotfilesRepo.repository(ownerUserId)
            : null;
        // The store snapshot is fingerprinted by its head commit (cheap); the cloned repository
        // only by its saved settings (url, ref, subdirectory, manager, bootstrap) — its content is
        // never pinned, so a push between reconciles rides until the next drain. Cold launches
        // always clone fresh.
        const snapshot =
          dotfilesEnabled && ownerUserId !== null
            ? yield* dotfilesStore.current(ownerUserId).pipe(Effect.orElseSucceed(() => null))
            : null;
        const environment = yield* projectEnvironment.snapshot(project.id);
        const secrets = yield* projectSecrets.snapshot(project.id);
        const clusterBindings = yield* projectClusterBindings.snapshot(project.id);
        const selectedReferences = yield* references
          .listForProject(project.id)
          .pipe(Effect.orElseSucceed(() => []));
        const declaredMounts = yield* declaredMountsOf(project);
        const skillLibraries = yield* skillsRepo.forLaunch(ownerUserId, project.id);
        const resolvedSkills = mergeSkillLibraries(skillLibraries, {
          inheritUserSkills: project.inheritUserSkills,
        });
        const inputs: HotFingerprintInputs = {
          workspaceImage,
          applyDotfiles: project.applyDotfiles,
          inheritUserSkills: project.inheritUserSkills,
          skills: resolvedSkills.map((bundle) => ({
            id: bundle.skill.id,
            name: bundle.skill.name,
            revision: bundle.skill.revision,
          })),
          dotfiles: {
            repository:
              repository === null
                ? null
                : {
                    url: repository.url,
                    ref: repository.ref,
                    subdirectory: repository.subdirectory,
                    manager: repository.manager,
                    bootstrap: repository.bootstrap,
                  },
            snapshotSha: snapshot?.sha ?? null,
          },
          environmentRevision: environment.revision,
          secretRevision: secrets.revision,
          clusterBindingRevision: clusterBindings.revision,
          references: selectedReferences.map((r) => ({ name: r.name, path: r.path })),
          mounts: declaredMounts.map((m) => ({
            name: m.name,
            hostPath: m.hostPath,
            readOnly: m.readOnly,
          })),
          links: (yield* resolveLinkedProjects(project, ownerUserId)).map(({ link, linked }) => ({
            name: link.name,
            rootPath: worktreesRootOf(linked.storePath),
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
          const workspaceId = SealantWorkspaceId.make(entry.sealantWorkspaceId);
          const answer = yield* sealant.getWorkspace(workspaceId).pipe(
            Effect.flatMap((workspace) => sealant.stopWorkspace(workspace)),
            Effect.result,
            asSealantUser(entry.ownerUserId),
          );
          // Capture mode: Core's stop answer is honoured as every other stop's is (e2e run 6).
          // Kept, still draining, or an end not observed: the standby may still be running its
          // final flush, so its token, its socket and its pool row stay — revoked, its flush
          // fails `401` for good — and the row reads failed, so nothing claims it and the next
          // reconcile pass asks again. Only an end the platform confirmed takes them.
          if (capture !== null) {
            const ended =
              Result.isSuccess(answer) && answer.success.retained === null
                ? answer.success.state === "stopped" ||
                  (yield* awaitTerminated(workspaceId).pipe(asSealantUser(entry.ownerUserId)))
                : (yield* lookupWorkspace(workspaceId).pipe(asSealantUser(entry.ownerUserId)))
                    .kind === "gone";
            if (!ended) {
              const why = Result.isFailure(answer)
                ? `stop refused · ${answer.failure.message}`
                : answer.success.retained !== null
                  ? `kept by the platform · ${answer.success.retained.reason ?? "no reason given"}`
                  : `stop ${answer.success.state} · end not observed`;
              yield* Effect.logWarning(
                "session engine: standby drain · end not observed · token and row kept",
              ).pipe(Effect.annotateLogs({ entryId: entry.id, workspaceId, why }));
              yield* hotWorkspaces.setFailed(entry.id, `draining · ${why}`);
              return false;
            }
          }
        }
        // A session that adopted the standby's id owns the id's socket, worktree and every other
        // token of it (a cold launch after an unusable claim): only the standby's own token goes.
        const adopted =
          options?.keepWorktree === true ||
          (yield* sessions.byId(SessionId.make(entry.id)).pipe(
            Effect.as(true),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
          ));
        yield* channelTokens.revokeLaunch(standbyLaunchIdOf(entry.id)).pipe(Effect.ignore);
        if (!adopted) yield* channelTokens.revoke(entry.id).pipe(Effect.ignore);
        if (!adopted) {
          yield* socketHost.stop(entry.id).pipe(Effect.ignore);
          // Only rows from before standby workspaces carry a pre-created worktree.
          if (entry.worktree !== null) {
            yield* sessionRepo
              .removeWorktreeForce(entry.projectId, entry.worktree)
              .pipe(Effect.ignore);
          }
          // The pooled worktree row goes with its directory; a kept worktree
          // was adopted by a session, which owns the row now.
          if (entry.worktreeId !== null) {
            yield* worktreesRepo.remove(entry.worktreeId).pipe(Effect.ignore);
          }
        }
        yield* hotWorkspaces.remove(entry.id);
        return true;
      });

      /** Provision one skeleton: worktree → row → socket → workspace → prewarm note → ready. */
      const provisionHotWorkspace = Effect.fn("SessionEngine.provisionHotWorkspace")(function* (
        project: Project,
        ownerUserId: string,
        fingerprint: string,
      ) {
        const sessionId = SessionId.make(crypto.randomUUID());
        // A skeleton is a STANDBY workspace (ADR-0001): it mounts the project's worktrees root
        // and no worktree of its own. The claiming session brings whichever worktree it needs —
        // brand new or an existing one — and the launch binds it. Only the session id is
        // pre-generated: the harness home and socket dir are keyed by it and mounted here.
        // Capture mode: the standby materialises the project base the channel plans for it;
        // the base it was prepared from is fixed on the row, so a claim can tell a worktree it
        // can serve (capture 0 from that base) from one it cannot (`hot-pool.ts`).
        const entry = yield* hotWorkspaces.create({
          id: sessionId,
          projectId: project.id,
          worktreeId: null,
          ownerUserId,
          fingerprint,
          worktree: null,
          branch: null,
          baseSha: null,
        });
        if (capture !== null && sessionRepo.prepareStandby !== undefined) {
          const prepared = yield* sessionRepo
            .prepareStandby(
              project.id,
              standbyWorktreeAlias(sessionId),
              standbyEpochOf(entry.createdAt),
              null,
              undefined,
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("session engine: standby plan not prepared").pipe(
                  Effect.annotateLogs({ projectId: project.id, error: String(error) }),
                  Effect.as(null),
                ),
              ),
            );
          if (prepared === null) {
            yield* hotWorkspaces.setFailed(
              sessionId,
              "the standby's base plan could not be prepared",
            );
            return false;
          }
          yield* hotWorkspaces.setBaseSha(sessionId, prepared.baseSha);
        }
        const socketDir = yield* socketHost.start(sessionId, socketApiFor(sessionId));
        const provisionAttempt = Effect.gen(function* () {
          const provisioned = yield* provisionWorkspace({
            project,
            sessionId,
            socketDir,
            // The unified image carries EVERY baked agent CLI and the shell shape's credential
            // ladder attaches all connected accounts, so one skeleton serves any harness.
            shape: platformShape("shell"),
            ownerUserId,
            onFailure: (message) => hotWorkspaces.setFailed(sessionId, message),
            // Its own launch (cross-repo decision 5), asked as the create's idempotency key in
            // capture mode; a claim carries it onto the session with the workspace.
            launchId: standbyLaunchIdOf(sessionId),
            ...(capture === null
              ? {}
              : {
                  createKey: { key: standbyLaunchIdOf(sessionId), onAsking: Effect.void },
                  // Nothing executes in a capture-mode standby before its claim (e2e9 F-B).
                  deferPreparation: true,
                }),
          });
          // Capture mode: the note is written at claim, as every launch writes it; an exec here
          // would clear sealantd's unclaimed marker (e2e9 F-B).
          if (capture === null) {
            yield* appendWorkspaceNote(
              provisioned.workspace,
              project,
              null,
              provisioned.referenceMounts,
              provisioned.extraMounts,
            );
          }
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

      /**
       * The accounts a project's pool warms for (docs/adr/0003): owners of its recent sessions,
       * most recent first, who may still run in it. Nobody else's credentials warm a workspace.
       */
      const hotPoolOwners = Effect.fn("SessionEngine.hotPoolOwners")(function* (project: Project) {
        const since = new Date(Date.now() - Duration.toMillis(HOT_POOL_RECENT_OWNER_WINDOW));
        const recent = yield* sessions.recentOwnersForProject(
          project.id,
          since,
          INSTALL_SESSION_LABEL,
        );
        const eligible: Array<string> = [];
        for (const owner of recent) {
          if (eligible.length === HOT_POOL_MAX_OWNERS) break;
          if (yield* mayRunIn(organizations, project, owner)) eligible.push(owner);
        }
        return eligible;
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
        // Cluster bindings only resolve on a Kubernetes workspace runtime: warming here would
        // loop on the platform's create-time refusal. Skip with an observed line instead — a
        // subsequent cold start still refuses readably, naming the bindings.
        const clusterBindings = yield* projectClusterBindings
          .snapshot(projectId)
          .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.die("project row vanished")));
        const warmSkipped =
          deployment.mode !== "kubernetes" &&
          (clusterBindings.bindings.length > 0 || clusterBindings.serviceAccount !== null);
        if (warmSkipped) {
          yield* Effect.logInfo(
            `session engine: warm skipped · ${clusterBindings.bindings.length} cluster binding${clusterBindings.bindings.length === 1 ? "" : "s"}${clusterBindings.serviceAccount === null ? "" : " · service account set"} · local runner`,
          ).pipe(Effect.annotateLogs({ projectId }));
        }
        const target = warmSkipped ? 0 : Math.max(0, project.hotSessions);
        // A hot workspace runs as one account and only that account claims it (docs/adr/0003),
        // so the pool is kept per owner: the recent owners who may still run here, each with the
        // fingerprint the project resolves to for them.
        const owners = target === 0 ? [] : yield* hotPoolOwners(project);
        const fingerprints = new Map<string, string>();
        const unreadable = new Set<string>();
        for (const owner of owners) {
          const inputs = yield* hotInputsFor(project, owner).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session engine: hot pool inputs unreadable").pipe(
                Effect.annotateLogs({ projectId, error: String(error) }),
                Effect.as(null),
              ),
            ),
          );
          if (inputs === null) unreadable.add(owner);
          else fingerprints.set(owner, hotFingerprint(inputs));
        }
        const survivors = new Map<string, Array<HotWorkspace>>();
        for (const entry of entries) {
          // Claimed entries belong to a launch in flight; the boot sweep reaps abandoned ones.
          if (entry.status === "claimed") continue;
          // Unreadable inputs decide nothing: this owner's entries wait for the next pass.
          if (unreadable.has(entry.ownerUserId)) continue;
          const kept = survivors.get(entry.ownerUserId) ?? [];
          if (
            entry.status === "ready" &&
            entry.fingerprint === fingerprints.get(entry.ownerUserId) &&
            kept.length < target
          ) {
            kept.push(entry);
            survivors.set(entry.ownerUserId, kept);
            continue;
          }
          // warming = a crashed provision (this pass is the only live one), failed = retry by
          // rebuild, stale fingerprint, an owner the pool no longer serves, or over-target = drain.
          yield* drainHotWorkspace(entry);
        }
        for (const [owner, fingerprint] of fingerprints) {
          // Probe survivors and keep the platform reaper away; a dead one drains instead.
          let count = 0;
          for (const entry of survivors.get(owner) ?? []) {
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
                    asSealantUser(owner),
                  );
            if (alive) count += 1;
            else yield* drainHotWorkspace(entry);
          }
          while (count < target) {
            const provisioned = yield* provisionHotWorkspace(project, owner, fingerprint).pipe(
              asSealantUser(owner),
            );
            // A failure leaves its row `failed` for the setup page; the next trigger retries.
            if (!provisioned) break;
            count += 1;
          }
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
      /**
       * Claim a ready standby skeleton for a session in `worktree`: the session adopts the
       * pooled id (its harness home and socket dir are already mounted), and the launch binds
       * the worktree. Null means nothing matched the project's current fingerprint.
       */
      const claimHotSession = Effect.fn("SessionEngine.claimHotSession")(function* (
        project: Project,
        worktree: Worktree,
        input: {
          readonly harness: string;
          readonly label: string | null;
          readonly ownerUserId: string | null;
          readonly origin?: SessionOrigin;
          readonly autoLand?: boolean | null;
        },
      ) {
        // Capture mode: one executor per worktree (ADR-0002). A worktree another session's
        // executor holds is a join — it runs inside the holder, which the cold path finds at
        // launch — so no standby is spent on it. Mend's own short claims hold nothing.
        if (capture !== null) {
          // A holder whose lease lapsed without a release may still be running: the cold path
          // confirms its end before any new epoch (`leaseHolderWorkspace`).
          const lease = yield* capture.repo.leaseOf(worktree.id);
          if (
            lease !== null &&
            lease.executorId !== null &&
            !lease.executorId.startsWith("mend:")
          ) {
            return null;
          }
        }
        // Only the owner's own standby serves the session, and only while they may run here.
        const ownerUserId = input.ownerUserId;
        if (ownerUserId === null) return null;
        if (!(yield* mayRunIn(organizations, project, ownerUserId))) return null;
        const inputs = yield* hotInputsFor(project, ownerUserId);
        const entry = yield* hotWorkspaces.claim(project.id, hotFingerprint(inputs), ownerUserId);
        if (entry === null) return null;
        if (capture !== null) {
          // Capture 0 first (a worktree made before captures has no chain yet), then the lease
          // at a fresh epoch with this executor as holder: the launch's `capture.replan` is
          // answered with exactly that worktree, epoch and head (`hot-pool.ts`). A refusal (a
          // lease taken meanwhile, capture 0 not registrable) drains the consumed entry and
          // goes cold.
          const claimed = yield* ensureCaptureZero(project.id, worktree.id).pipe(
            Effect.andThen(
              capture.repo.claim(
                worktree.id,
                entry.id,
                LAUNCH_CLAIM_TTL_SECONDS,
                standbyLaunchIdOf(entry.id),
              ),
            ),
            Effect.result,
          );
          if (Result.isFailure(claimed)) {
            yield* Effect.logInfo(
              "session engine: standby not claimable for this worktree · cold provision",
            ).pipe(
              Effect.annotateLogs({
                projectId: project.id,
                worktreeId: worktree.id,
                reason: String(claimed.failure),
              }),
            );
            yield* drainHotWorkspace(entry);
            yield* requestHotReconcile(project.id);
            return null;
          }
        }
        // The replacement warms in the background while this session launches.
        yield* requestHotReconcile(project.id);
        const session = yield* sessions.create({
          id: entry.id,
          projectId: project.id,
          worktreeId: worktree.id,
          harness: input.harness,
          label: input.label,
          ownerUserId: input.ownerUserId,
          origin: input.origin ?? "mend",
          autoLand: input.autoLand ?? null,
          worktree: worktree.directory,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
          baseRef: worktree.baseRef ?? worktree.baseSha,
          contextSnapshotId: null,
        });
        yield* tryCheckpoint(session, "session-start", { sealantRunId: null, sequence: 0n });
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
        const allProjects = yield* projects.listAll();
        for (const project of allProjects) {
          if (project.hotSessions > 0) projectIds.add(project.id);
        }
        for (const projectId of projectIds) {
          yield* requestHotReconcile(projectId);
        }
      });

      /** Whose login a surviving protocol process's workspace launched with (docs/adr/0013). */
      const launchLoginOfProcess = Effect.fn("SessionEngine.launchLoginOfProcess")(function* (
        protocolProcess: SessionProcess,
      ) {
        const session = yield* sessions
          .byId(protocolProcess.sessionId)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
        if (session === null) return null;
        return yield* launchLoginOfWorkspace(session, protocolProcess.sealantWorkspaceId);
      });

      /**
       * Restart policy v2: the pipe process survives a Mend restart (its stdio
       * terminates at the platform daemon, not at us), so re-attach a fresh
       * adapter to the surviving pipe and let it rebuild correlation state
       * from the durable record plus a full replay. When the pipe is beyond
       * reach or the adapter cannot start, end the row honestly and relaunch
       * by provider id instead of failing the session for our own restart.
       */
      const rehydrateProtocolProcess = Effect.fn("SessionEngine.rehydrateProtocolProcess")(
        function* (protocolProcess: SessionProcess) {
          if (protocolProcess.sealantSessionId === null) return;
          const probed = yield* sealant.getWorkspace(protocolProcess.sealantWorkspaceId).pipe(
            Effect.flatMap((workspace) =>
              sealant.getSession(workspace, protocolProcess.sealantSessionId ?? ""),
            ),
            Effect.flatMap((pipe) =>
              Effect.tryPromise({
                try: async () => ({ pipe, status: await pipe.status() }),
                catch: (cause) =>
                  new SealantPlatformError({
                    code: "session_status_failed",
                    status: null,
                    message: `protocol pipe status failed: ${String(cause)}`,
                    cause,
                  }),
              }),
            ),
            Effect.option,
          );
          if (probed._tag === "None") {
            // Workspace or pipe beyond reach — the boot watcher records the
            // end (and the sweep releases the lease); nothing to rehydrate.
            return;
          }
          const { pipe, status } = probed.value;
          const options = protocolProcess.protocolOptions;
          yield* protocolHost
            .rehydrate({
              process: protocolProcess,
              pipe,
              cwd: "/workspace/repo",
              model: options?.model ?? undefined,
              effort: options?.effort ?? undefined,
              permissionMode: options?.permissionMode ?? "bypass",
              hooks: protocolHooksFor(protocolProcess),
              launchedWithLoginOf: yield* launchLoginOfProcess(protocolProcess),
              highWater: status.outputHighWater,
            })
            .pipe(
              Effect.tapError(() => relaunchProtocolProcess(protocolProcess).pipe(Effect.ignore)),
            );
          if (yield* protocolHost.has(protocolProcess.id)) {
            yield* renewWorkspaceLease(
              protocolProcess.sessionId,
              protocolProcess.sealantWorkspaceId,
            ).pipe(Effect.ignore);
            yield* Effect.logInfo("session engine: protocol process rehydrated").pipe(
              Effect.annotateLogs({
                processId: protocolProcess.id,
                sessionId: protocolProcess.sessionId,
              }),
            );
          }
        },
      );

      /**
       * Rehydrate fallback: end the unrecoverable row (queued turns move to
       * the replacement before the cancel sweep) and start a fresh pipe that
       * resumes by provider id. Only a failed relaunch leaves the session
       * settled — and then with the relaunch's own error, not ours.
       */
      const relaunchProtocolProcess = Effect.fn("SessionEngine.relaunchProtocolProcess")(function* (
        protocolProcess: SessionProcess,
      ) {
        yield* protocolHost.detach(protocolProcess.id);
        if (protocolProcess.sealantSessionId !== null) {
          yield* closeProcessPty(
            protocolProcess.sealantWorkspaceId,
            protocolProcess.sealantSessionId,
          ).pipe(Effect.ignore, owned(protocolProcess.sessionId));
        }
        const recorded = yield* endAgentProcess(protocolProcess, {
          how: "exited",
          exitCode: null,
          outcome: "stopped",
          summary: "Rehydrate failed after a Mend restart — relaunched by provider id.",
        }).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)));
        const options = protocolProcess.protocolOptions;
        const relaunched = yield* launchProtocol(
          protocolProcess.sessionId,
          {
            mode: "protocol",
            model: options?.model ?? undefined,
            effort: options?.effort ?? undefined,
            permissionMode: options?.permissionMode ?? "bypass",
          },
          null,
        ).pipe(Effect.result);
        if (relaunched._tag === "Success") {
          // The replacement exists: still-queued turns follow it, then the
          // cancel sweep closes what remains open on the dead row (the
          // running turn, pending approvals).
          const rows = yield* processes.listForSession(protocolProcess.sessionId);
          const replacement = rows.findLast(
            (row) => row.kind === "agent-protocol" && row.exitedAt === null,
          );
          if (replacement !== undefined) {
            yield* conversations.requeueQueuedTurns(protocolProcess.id, replacement.id);
          }
        }
        yield* conversations.cancelOpenForProcess(protocolProcess.id);
        if (relaunched._tag === "Failure") {
          yield* Effect.logError("session engine: protocol relaunch after rehydrate failed").pipe(
            Effect.annotateLogs({
              processId: protocolProcess.id,
              sessionId: protocolProcess.sessionId,
              error: String(relaunched.failure),
            }),
          );
        }
        if (recorded) yield* finishAgentProcess(protocolProcess, "turn-boundary");
      });

      /** Re-attach to sessions that were live when the last process died. */
      /** One bounded pass over settled-but-unclassified sessions (see classifyTranscript). */
      const classifyUnclassifiedSessions = Effect.gen(function* () {
        const rows = yield* sessions.listSettledUnclassified(500);
        for (const session of rows) {
          const shape = HARNESS_STATE[session.harness];
          if (shape === undefined) {
            // Not a harness Mend can resume (a shell, an arbitrary command): nothing to hide.
            yield* sessions.setHasTranscript(session.id, true);
            continue;
          }
          const project = yield* projects
            .byId(session.projectId)
            .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
          if (project === null) continue;
          const classification = yield* harnessStateFor(session).pipe(
            Effect.map((): "captured" => "captured"),
            Effect.catchTag("HarnessStateNotFoundError", () => Effect.succeed<"absent">("absent")),
            Effect.catch((error) =>
              Effect.logWarning(
                "session engine: restart transcript classification unavailable",
              ).pipe(
                Effect.annotateLogs({ sessionId: session.id, error: String(error) }),
                Effect.map((): "unknown" => "unknown"),
              ),
            ),
          );
          if (classification === "unknown") continue;
          if (classification === "captured") {
            yield* sessions.setHasTranscript(session.id, true);
            continue;
          }
          if (capture !== null) {
            // Startup has no durable proof that a transcript-less capture came from the settle
            // barrier. Checkpoint and manual flushes also register same-epoch final captures.
            continue;
          }
          const live = yield* hasLiveConversation(
            harnessHomePathOf(project.storePath, session.id),
            session.harness,
          );
          yield* sessions.setHasTranscript(session.id, live);
        }
      });
      // Boot runs with no request context, and the platform answers for nobody: every piece of
      // boot work that reaches it runs as its session's owner (`owned`), forked in the engine's
      // scope, and the engine stands as soon as the rows are reconciled. Nothing here waits on an
      // executor — a flush it owes, a pipe that is slow to answer, a drain — because the engine is
      // what the HTTP server, the capture channel every executor ships through and the health check
      // that restarts the process are all built on (2026-10-03: a session stopped and resumed
      // seconds before a deploy, its old executor mid-drain, held `resume` for up to the drain's
      // ten-minute stall window; the bundle restarted Mend at four minutes).
      /** Sessions whose settle tail the boot pass forked itself: not the leftover sweep's. */
      const bootSwept = new Set<SessionId>();
      /** Sessions a protocol recovery holds (the rehydrate, or the relaunch behind it), counted. */
      const recovering = new Map<SessionId, number>();
      const enterRecovery = (sessionId: SessionId) =>
        recovering.set(sessionId, (recovering.get(sessionId) ?? 0) + 1);
      const leaveRecovery = (sessionId: SessionId) => {
        const left = (recovering.get(sessionId) ?? 1) - 1;
        if (left <= 0) recovering.delete(sessionId);
        else recovering.set(sessionId, left);
      };
      const resume = Effect.fn("SessionEngine.resume")(function* () {
        // A run left open under a session that settled is settled with the session's words
        // before anything re-attaches to it: it is not live work, and the next resume of its
        // session would otherwise meet the one-active-run index.
        yield* reconcileStaleRuns();
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
        // gone. Protocol rows are watched once their pipe is rehydrated, at
        // the end of this pass.
        const liveProcesses = yield* processes.listLive();
        const sessionsWithLiveProcesses = new Set(
          liveProcesses.map((liveProcess) => liveProcess.sessionId),
        );

        // Sessions settled before transcripts were classified: read the store once, bounded, so
        // the dashboard can hide dead ends from before this column existed. Forked: it reads
        // harness state under the harvest permit a supervisor forked above may be holding.
        yield* Effect.forkIn(classifyUnclassifiedSessions.pipe(Effect.ignore), scope);
        const unsettled = yield* sessions.listUnsettled();
        for (const session of unsettled) {
          if (reattached.has(session.id)) continue;
          // A stop still saving (or kept) is the capture reaper's: it takes the drain up again,
          // and settles the session once the workspace's termination is observed.
          if (session.status === "stopping" && !sessionsWithLiveProcesses.has(session.id)) {
            continue;
          }
          // Live rows own the verdict: the re-forked watchers end them and the fold follows.
          if (sessionsWithLiveProcesses.has(session.id)) {
            yield* reconcileSession(session.id, { sweep: false }).pipe(Effect.ignore);
            continue;
          }
          // Every process ended but nobody folded (the fiber died mid-tail): fold now — the row
          // inline, its workspace forked. The fold is a few reads and a write; the tail the dead
          // fiber owed (`sweepWorkspace`: a flush, the late harvest, then the drain that asks the
          // executor for its final flush and waits for it, up to the stall window) runs as the
          // owner once the engine stands, and is this pass's alone (`bootSwept`): the leftover
          // sweep leaves it be. A row that never reached a process died before the harness
          // started.
          const hadAgent = (yield* processes.listForSession(session.id)).some((process) =>
            isAgentProcessKind(process.kind),
          );
          if (hadAgent) {
            yield* reconcileSession(session.id, { sweep: false }).pipe(Effect.ignore);
            const folded = yield* sessions.byId(session.id).pipe(Effect.option);
            if (Option.isSome(folded) && folded.value.settledAt !== null) {
              bootSwept.add(session.id);
              const tail: Effect.Effect<void> =
                folded.value.sealantWorkspaceId === null
                  ? // No workspace to drain: a removal asked before, or a lease that still names
                    // the row, as the sweep read them before.
                    stopWorkspaceIfUnleased(session.id).pipe(Effect.asVoid)
                  : sweepWorkspace(session.id);
              yield* Effect.forkIn(
                tail.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "session engine: the boot sweep of a folded session's workspace failed",
                    ).pipe(
                      Effect.annotateLogs({ sessionId: session.id, cause: Cause.pretty(cause) }),
                    ),
                  ),
                  asSealantUser(folded.value.ownerUserId),
                ),
                scope,
              );
            }
            continue;
          }
          yield* settleSession(
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
          // Protocol rows are watched after their rehydrate, below: a watcher that read the pipe
          // the relaunch closes would end the row and cancel the turns the relaunch is moving.
          if (liveProcess.kind === "agent-protocol") continue;
          if (
            isAgentProcessKind(liveProcess.kind) ||
            liveProcess.kind === "shell" ||
            (liveProcess.kind === "service" && liveProcess.serviceId !== null)
          ) {
            // As the owner: a watcher with no principal is refused its first lookup and retries
            // it forever, blind, and the process's end is never recorded.
            yield* Effect.forkIn(
              watchProcess(liveProcess).pipe(owned(liveProcess.sessionId)),
              scope,
            );
          }
        }

        // A host listener is process-local. Commit replacement intent and retire the stale
        // listener record before platform I/O, then retry transient workspace observation while
        // the Service honestly reads `binding`. The shared lifecycle permit prevents Stop or
        // Restart from interleaving with this transition. Forked: the observation retries for
        // seconds and the bind reaches into the workspace, and nothing below reads what it binds.
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
              const recorded = service.bindAddresses ?? previous.boundAddresses;
              const bindAddresses =
                recorded !== null && validateServiceBindAddresses(recorded).ok
                  ? recorded
                  : yield* serviceHost
                      .bindAddresses()
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
              const ownerSession = yield* sessions.byId(service.sessionId).pipe(Effect.option);
              const binding = yield* serviceHost
                .start({
                  serviceId: service.id,
                  forwardId: forward.id,
                  workspaceId: previous.sealantWorkspaceId,
                  workspacePort: service.workspacePort,
                  protocol: service.transport,
                  bindAddresses,
                  ownerUserId: Option.isSome(ownerSession) ? ownerSession.value.ownerUserId : null,
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
            // Boot runs with no request context; the platform calls inside (workspace status,
            // the probe) must act as the Service's session owner.
            ownedByService(serviceStub.id),
            Effect.catch((error) =>
              Effect.logWarning("session engine: Service forward reconcile failed").pipe(
                Effect.annotateLogs({ serviceId: serviceStub.id, error: String(error) }),
              ),
            ),
          );
          yield* Effect.forkIn(reconcileForward, scope);
        }
        // Capture mode: an executor Mend is still saving, or one still holding its worktree's
        // lease, calls in through its session's channel whatever the session's status — a
        // stopped session drains after it settled. Without it every upload, register and
        // heartbeat is refused after a restart, and the drain can only stall.
        if (capture !== null) {
          const holders = [
            ...(yield* sessions.listCaptureDrains()),
            ...(yield* sessions.listRemovalRequested()),
            ...unsettled,
          ];
          for (const holder of holders) {
            if (holder.sealantWorkspaceId === null || socketSessions.has(holder.id)) continue;
            if (holder.captureDrain !== null) {
              socketSessions.add(holder.id);
              continue;
            }
            const lease = yield* capture.repo.leaseOf(holder.worktreeId);
            if (lease?.executorId === holder.id) socketSessions.add(holder.id);
          }
          // Every session a worktree lease still names, whatever the session reads: an owner
          // that stopped and settled while a joined session still works in its executor, or a
          // launch cut short around its create. The executor ships under that session's token
          // (upload, register, heartbeat); without its channel every call is refused and the
          // lease lapses under a live writer (review 2026-09-28 #16).
          for (const chain of yield* capture.repo.listChains()) {
            const lease = yield* capture.repo.leaseOf(chain.worktreeId);
            if (lease === null || lease.executorId === null) continue;
            if (lease.executorId.startsWith("mend:")) continue;
            const owner = SessionId.make(lease.executorId);
            if (socketSessions.has(owner)) continue;
            const row = yield* sessions
              .byId(owner)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
            if (row !== null) socketSessions.add(owner);
          }
        }
        // Expose in-workspace controls once the rows are reconciled; everything that reaches the
        // platform runs forked, after them.
        for (const socketSessionId of socketSessions) {
          yield* socketHost
            .start(socketSessionId, socketApiFor(socketSessionId))
            .pipe(Effect.ignore);
        }
        // Restart policy v2: surviving protocol pipes are rehydrated in place — a Mend restart is
        // never, by itself, the end of a protocol session. Last, once the sockets are up (the
        // relaunch behind a failed rehydrate binds the session's socket itself, and two binds at
        // once leave one listener untracked), each forked and as its owner: the probe and the
        // rehydrate (or the relaunch), then the watch of the row, in that order in one fiber, so
        // no watcher reads the pipe the relaunch closes and cancels the turns it is moving. A row
        // the relaunch retired reads ended by then and is not watched. The session is nobody
        // else's to sweep meanwhile (`recovering`): the relaunch settles it for a moment before it
        // reopens it, and a sweep that read it then would reap its replacement.
        for (const protocolProcess of liveProcesses) {
          if (protocolProcess.kind !== "agent-protocol") continue;
          enterRecovery(protocolProcess.sessionId);
          yield* Effect.forkIn(
            rehydrateProtocolProcess(protocolProcess).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("session engine: protocol rehydrate failed").pipe(
                  Effect.annotateLogs({
                    processId: protocolProcess.id,
                    cause: String(cause),
                  }),
                ),
              ),
              Effect.ensuring(Effect.sync(() => leaveRecovery(protocolProcess.sessionId))),
              Effect.andThen(processes.byId(protocolProcess.id)),
              Effect.flatMap((row) =>
                row === null || row.exitedAt !== null ? Effect.void : watchProcess(row),
              ),
              owned(protocolProcess.sessionId),
            ),
            scope,
          );
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
          // The boot pass forked this session's whole tail itself, or a protocol recovery holds
          // the session: neither is a leftover.
          if (bootSwept.has(session.id) || recovering.has(session.id)) continue;
          const workspaceId = session.sealantWorkspaceId;
          const sweepIfAlive = Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(workspaceId);
            const status = yield* Effect.promise(() => workspace.status());
            // Read again once the platform answered: a session a recovery reopened meanwhile, or
            // whose row moved to another executor, is live work, not a leftover.
            const current = yield* sessions.byId(session.id);
            if (
              current.settledAt === null ||
              current.sealantWorkspaceId !== workspaceId ||
              recovering.has(session.id)
            ) {
              return;
            }
            if (status !== "queued" && status !== "running" && status !== "ready") {
              // The container is gone (stopped externally or reaped by TTL) —
              // no process row for it can still be live. Reconcile the leases.
              yield* processes.reapLiveForWorkspace(workspaceId);
              yield* removeIfRequested(session.id);
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
        // A removal asked before the restart waits on its workspace; the co-located store has no
        // reaper to take it up (capture mode's does, after its drain).
        if (capture === null) {
          for (const session of yield* sessions.listRemovalRequested()) {
            yield* Effect.forkIn(
              stopWorkspaceIfUnleased(session.id).pipe(asSealantUser(session.ownerUserId)),
              scope,
            );
          }
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
      // Capture mode: the lease reaper (expiry → confirmed platform termination → the session
      // settles honestly; the next resume is a pickup) and replacement before the 8 h cap.
      if (capture !== null) {
        yield* Effect.forkIn(
          captureReaper().pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("session engine: capture reaper died").pipe(
                Effect.annotateLogs({ defect: String(defect) }),
              ),
            ),
            Effect.repeat(Schedule.spaced(Duration.seconds(LEASE_REAPER_INTERVAL_SECONDS))),
          ),
          scope,
        );
      }
      // The external-agent sensor: cheap fs stats over mounted harness homes, so a tight
      // cadence — an observed agent should appear well before its first turn completes.
      yield* Effect.forkIn(
        observeExternalAgents().pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("session engine: external-agent observation died").pipe(
              Effect.annotateLogs({ defect: String(defect) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(Duration.seconds(20))),
        ),
        scope,
      );

      const launch = (sessionId: SessionId, argv: ReadonlyArray<string>) =>
        launchInternal(sessionId, argv, null);

      /** Fibers in the engine's lifetime (`SessionEngine.detach`); they inherit the principal. */
      const detach = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(effect, scope);
      /**
       * A launch verb, run detached and joined: the caller waits for it as before, but a caller
       * interrupted meanwhile (an HTTP client that gave up, a phone app sent to the background)
       * interrupts only its wait. Before, it cut the launch wherever it stood — after the agent
       * started and before its process row and `running` were written (alpha 2026-09-30).
       */
      const detached = <A, E>(effect: Effect.Effect<A, E>) =>
        detach(effect).pipe(Effect.flatMap(Fiber.join));

      /**
       * One launch at a time (`launch-gate.ts`), and the second half of a stop during a launch: a
       * stop that came after the launch's last look found no agent to end, and the launch started
       * one anyway. Stopped again as the launch ends, it finds the agent's row and ends it, so the
       * session ends on the stop. A launch the gate refuses leaves the one under way its mark.
       */
      const oneLaunch =
        (sessionId: SessionId) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.suspend(() =>
            launchGate.underWay(sessionId)
              ? launchGate.run(sessionId)(effect)
              : launchGate
                  .run(sessionId)(effect)
                  .pipe(
                    Effect.ensuring(
                      Effect.suspend(() =>
                        stoppedDuringLaunch.delete(sessionId)
                          ? stop(sessionId).pipe(
                              Effect.catchCause((cause) =>
                                Effect.logWarning(
                                  "session engine: the stop after a stopped launch did not finish",
                                ).pipe(
                                  Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                                ),
                              ),
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
          );

      // Every public verb about a session runs AS ITS OWNER (docs/SEALANT-IDENTITY.md): the
      // platform resources belong to the owner's Sealant user, whoever is at the keyboard.
      // Fibers forked underneath inherit the principal.
      return {
        provision,
        ensureWorktree: (projectId, input, ownerUserId) =>
          projects
            .byId(projectId)
            .pipe(Effect.flatMap((project) => ensureWorktreeIn(project, input, ownerUserId))),
        provisionSessionIn: (worktreeId, input) =>
          Effect.gen(function* () {
            const worktree = yield* worktreesRepo.byId(worktreeId);
            const project = yield* projects.byId(worktree.projectId);
            yield* refuseUnsupportedProject(project);
            return yield* provisionInWorktree(project, worktree, input);
          }).pipe(asSealantUser(input.ownerUserId)),
        attachRun: (sessionId, sealantRunId, workspaceId) =>
          owned(sessionId)(attachRun(sessionId, sealantRunId, workspaceId)),
        detach,
        launchUnderWay: launchGate.underWay,
        launch: (sessionId, argv) =>
          detached(owned(sessionId)(oneLaunch(sessionId)(launch(sessionId, argv)))),
        launchProtocol: (sessionId, ...rest) =>
          detached(owned(sessionId)(oneLaunch(sessionId)(launchProtocol(sessionId, ...rest)))),
        submitTurn: (sessionId, input, author) =>
          owned(sessionId)(submitTurn(sessionId, input, author)),
        interruptTurn,
        respondRequest,
        launchFollowUp: (sessionId, instruction, launchCorrelationId, author) =>
          detached(
            owned(sessionId)(
              oneLaunch(sessionId)(
                launchFollowUp(sessionId, instruction, launchCorrelationId, author),
              ),
            ),
          ),
        reconcileHotSessions: requestHotReconcile,
        checkpointNow: (sessionId, trigger) => owned(sessionId)(checkpointNow(sessionId, trigger)),
        landingCheckpoint: (sessionId, trigger) =>
          owned(sessionId)(landingCheckpoint(sessionId, trigger)),
        flushCaptures: (sessionId, why) => owned(sessionId)(flushCaptures(sessionId, why)),
        stop: (sessionId, summary) => owned(sessionId)(stop(sessionId, summary ?? null)),
        openShell: (sessionId) => owned(sessionId)(openShell(sessionId)),
        stopShell: (processId) => ownedByProcess(processId)(stopShell(processId)),
        renameShell: (processId, label) => ownedByProcess(processId)(renameShell(processId, label)),
        addService: (sessionId, ...rest) => owned(sessionId)(addService(sessionId, ...rest)),
        runService: (sessionId, ...rest) => owned(sessionId)(runService(sessionId, ...rest)),
        listServiceRecipes: (sessionId) => owned(sessionId)(listServiceRecipes(sessionId)),
        runServiceRecipe: (sessionId, name) => owned(sessionId)(runServiceRecipe(sessionId, name)),
        restartService: (serviceId) => ownedByService(serviceId)(restartService(serviceId)),
        stopService: (serviceId) => ownedByService(serviceId)(stopService(serviceId)),
        stopServices: (sessionId) => owned(sessionId)(stopServices(sessionId)),
        storePastedImage: (sessionId, bytes) =>
          owned(sessionId)(storePastedImage(sessionId, bytes)),
        listRepositories: (sessionId) => owned(sessionId)(listRepositories(sessionId)),
        addableProjects: (sessionId) => owned(sessionId)(addableProjects(sessionId)),
        addRepository: (sessionId, input) => owned(sessionId)(addRepository(sessionId, input)),
        resumeSession: (sessionId, harness, fresh) =>
          detached(
            owned(sessionId)(oneLaunch(sessionId)(resumeSession(sessionId, harness, fresh))),
          ),
        handoff: (sessionId, to, start, author) =>
          detached(owned(sessionId)(oneLaunch(sessionId)(handoff(sessionId, to, start, author)))),
        observeExternalAgents,
        reapCaptureLeases: captureReaper,
        discardUnsavedAndStop: (sessionId, discardedBy) =>
          owned(sessionId)(discardUnsavedAndStop(sessionId, discardedBy)),
        refreshCaptureStatus,
        readCaptures: (sessionId) => owned(sessionId)(readCaptures(sessionId)),
        removeWhenStopped: (sessionId) => owned(sessionId)(removeWhenStopped(sessionId)),
        captureHolds,
        transcript,
      };
    }),
  );
