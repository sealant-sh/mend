import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";

import { hasProvenOwner, OWNERLESS_OUTSIDE_MEND } from "@mend/domain/workbench";
import {
  EventId,
  OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ArchivedShellStreamItem,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ProjectScript,
  type ServerSettings,
} from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GatewayConfig } from "./config.ts";
import { gateDeviceCalls, type GatedMend } from "./device-gate.ts";
import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import { FindParser } from "./find-parser.ts";
import {
  detectImageType,
  MAX_IMAGE_BYTES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  MEND_IMAGE_MAX_BYTES,
  type MessageImage,
  newAttachmentId,
  parseDataUrl,
  turnInputOf,
} from "./images.ts";
import {
  activityAtOf,
  autoSettledAt,
  changeLifecycle,
  isLifecycleEmpty,
  lifecycleOf,
  sameLifecycle,
  type LifecycleChange,
} from "./lifecycle.ts";
import {
  MendClient,
  MendCommandRefused,
  MendDeviceRefused,
  launchRacedOrLive,
  type MendCommand,
  type MendHarnessCatalog,
  type MendRequestResponse,
  type MendNotFound,
  type MendUnavailable,
} from "./mend-client.ts";
import type {
  MendActiveSession,
  MendCheckpoint,
  MendProcess,
  MendConversationWait,
  MendEventPointer,
  MendItem,
  MendProject,
  MendRequest,
  MendSession,
  MendSessionAnnotation,
  MendTurn,
  MendWorkspaceRetirement,
} from "./mend-workbench.ts";
import {
  effortsTakenBy,
  nextLaunchModelOf,
  optionsChangeOf,
  withEffortTaken,
  type NextChoice,
} from "./model-options.ts";
import {
  applyModelPreferencesPatch,
  boundedModelPreferences,
  keptSettingsOf,
  type KeptSettings,
  type ModelPreferencesPatch,
  type ModelPreferencesTooLarge,
} from "./model-preferences.ts";
import { readsRetirement, readsWaiting, threadNoticesOf } from "./notices.ts";
import { launchWorkspaceOf, projectWorkspaceRootOf } from "./project-paths.ts";
import * as Queueing from "./queue.ts";
import {
  AMBIGUOUS_WORKTREE,
  NOT_A_PROJECT,
  NOT_A_WORKTREE,
  PROJECT_NOT_LISTED,
  projectRemovalWords,
  RemovalKept,
  worktreeDirectoryAt,
  worktreeRemovalWords,
} from "./removal.ts";
import {
  makeReplayLog,
  makeSequencer,
  SHELL_REPLAY_LIMITS,
  type SequenceBlock,
  THREAD_REPLAY_LIMITS,
  type ReplayLog,
} from "./replay.ts";
import {
  byOrdinal,
  isProjectable,
  launchingAgentOf,
  PROJECTION_SCHEMA_VERSION,
  runsOf,
  threadModelOptionsOf,
  projectShellOf,
  settlementCandidateOf,
  threadShellOf,
  type SettlementCandidate,
  type ThreadSource,
  type TurnCheckpoint,
  worktreePathOf,
} from "./shell.ts";
import {
  deliveredSkills,
  mentionsSkill,
  skillInvocationOf,
  type WorkspaceSkills,
} from "./skills.ts";
import {
  GatewayState,
  type GatewayStateError,
  type BearerSession,
  type LaunchedThread,
  type LifecycleReceipt,
  type ImagePlacement,
  type SentImage,
  type StoredImage,
  type ThreadLaunchOptions,
  type ThreadLifecycle,
  type TurnIds,
} from "./state.ts";
import { makeTerminals, type Terminals } from "./terminals.ts";
import { makeThreadFinder, type ThreadFinder } from "./thread-find.ts";
import { backgroundWorkOf, threadProjectionOf } from "./thread-projection.ts";
import {
  checkpointFileOf,
  isSharedChain,
  sliceKey,
  turnSlicesOf,
  type TurnSlice,
} from "./turn-checkpoints.ts";
import { markedUnread, visitedAfter } from "./visits.ts";
import {
  makeWorktreeSetups,
  prepareWorktree,
  setupScriptOf,
  type Preparation,
  type WorktreeSetups,
} from "./worktree-setup.ts";

/**
 * The projection hub (ADR 0012, "Projection"): one per paired person, shared by every socket and
 * request of theirs. It holds one Mend SSE stream, re-reads what each pointer names through Mend's
 * API as that person, rebuilds the t3code entities, diffs them against what it last sent, and
 * stamps each change with its own sequence, from a reservation that no later hub of the person
 * repeats. A client resuming after a sequence the hub still holds gets only what it missed
 * (`replay.ts`); any other gets a fresh snapshot, always a legal reset for a t3code client.
 */

/** A shell change after the snapshot. */
export type ShellDelta = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

/** A change of the archived shell after its snapshot. */
export type ArchivedShellDelta = Exclude<
  OrchestrationV2ArchivedShellStreamItem,
  { readonly kind: "snapshot" }
>;

/** Mend could not be read as the person: their devices are refused, or Mend did not answer. */
export type HubReadError = MendDeviceRefused | MendUnavailable;

/** How much of a branch's name a new worktree's name keeps, before its suffix. */
const WORKTREE_NAME_STEM = 53;
/**
 * How long a worktree removal waits for the worktree's deleted threads to finish their removal in
 * Mend (a stop drains and saves first), and how often it looks. Then Mend is asked anyway.
 */
const REMOVAL_SETTLE_WAIT = "45 seconds";
const REMOVAL_SETTLE_LOOK = "1 second";
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Six random characters of `[a-z0-9]`: what makes a new worktree's name its own. */
const worktreeSuffix = (): string =>
  Array.from(randomBytes(6), (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join("");

export interface ShellSubscription {
  /**
   * The shell as of subscribing, or, for a client resuming after a sequence the hub still covers,
   * only what changed after it (`replay.ts`). Every later change arrives in `changes`.
   */
  readonly start:
    | { readonly kind: "snapshot"; readonly snapshot: OrchestrationV2ShellSnapshot }
    | { readonly kind: "replay"; readonly deltas: ReadonlyArray<ShellDelta> };
  /** Fails with `SubscriberFellBehind` when the subscriber cannot keep up (`fanout.ts`). */
  readonly changes: Stream.Stream<ShellDelta, SubscriberFellBehind>;
}

/** One thread as of a sequence. */
export interface ThreadSnapshot {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
}

/**
 * A thread change after the snapshot: an entity upsert, or a fresh snapshot when something the
 * client holds went away (a snapshot is a legal reset).
 */
export type ThreadChange =
  | {
      readonly kind: "event";
      readonly sequence: number;
      readonly event: OrchestrationV2DomainEvent;
    }
  | ({ readonly kind: "snapshot" } & ThreadSnapshot);

export interface ThreadSubscription {
  /** The thread in full, or what changed after the sequence the client resumed after. */
  readonly start:
    | { readonly kind: "snapshot"; readonly snapshot: ThreadSnapshot }
    | { readonly kind: "replay"; readonly changes: ReadonlyArray<ThreadChange> };
  /** Fails with `SubscriberFellBehind` when the subscriber cannot keep up (`fanout.ts`). */
  readonly changes: Stream.Stream<ThreadChange, SubscriberFellBehind>;
}

export interface PersonHub {
  /** The shell now, once the hub has read Mend at least once. */
  readonly shellSnapshot: Effect.Effect<OrchestrationV2ShellSnapshot, HubReadError>;
  /**
   * The shell now, or what changed after `afterSequence` when the hub still covers it, and its
   * changes from here, for as long as the scope lasts.
   */
  readonly subscribeShell: (
    afterSequence: number | undefined,
  ) => Effect.Effect<ShellSubscription, HubReadError, Scope.Scope>;
  /**
   * A signal each time what t3code shows of the person's providers may have changed: Mend's
   * `accounts` pointer on their event stream, or the stream reconnecting (it may have missed one),
   * so their logins are read again (review R650-3); or a workspace's skills read again (`skills`).
   */
  readonly providerChanges: Effect.Effect<
    Stream.Stream<"accounts" | "skills", SubscriberFellBehind>,
    never,
    Scope.Scope
  >;
  /**
   * Reads again the skills Mend delivers to a session at `cwd` (a thread's worktree or a project's
   * root) and keeps them for the providers t3code is shown; null when the cwd is none of the
   * person's.
   */
  readonly refreshSkillsAt: (
    deviceToken: string,
    cwd: string,
  ) => Effect.Effect<WorkspaceSkills | null, HubReadError>;
  /** Every workspace's skills as last read, for the providers t3code is shown. */
  readonly workspaceSkills: () => ReadonlyArray<WorkspaceSkills>;
  /**
   * The person's t3code server settings: t3code's defaults with the model preferences the gateway
   * keeps for them (`model-preferences.ts`).
   */
  readonly settings: (session: BearerSession) => Effect.Effect<KeptSettings, GatewayStateError>;
  /** Applies a model preferences patch for the person; their sockets hear the settings after it. */
  readonly updateModelPreferences: (
    session: BearerSession,
    patch: ModelPreferencesPatch,
  ) => Effect.Effect<ServerSettings, GatewayStateError | ModelPreferencesTooLarge>;
  /** The person's settings now, then again each time one of their clients changes them. */
  readonly subscribeSettings: (
    session: BearerSession,
  ) => Effect.Effect<
    Stream.Stream<KeptSettings, SubscriberFellBehind>,
    GatewayStateError,
    Scope.Scope
  >;
  /** The person's archived threads, as `orchestration.getArchivedShellSnapshot` answers. */
  readonly archivedShell: Effect.Effect<OrchestrationV2ArchivedShellSnapshot, HubReadError>;
  /** The archived threads now and their changes from here (`subscribeArchivedShell`). */
  readonly subscribeArchivedShell: Effect.Effect<
    {
      readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
      readonly changes: Stream.Stream<ArchivedShellDelta, SubscriberFellBehind>;
    },
    HubReadError,
    Scope.Scope
  >;
  /** Whether Mend has refused this device token: the device was revoked. */
  readonly isRefused: (token: string) => boolean;
  /** Completes once Mend refuses this device token; a socket holding it closes then. */
  readonly refusal: (token: string) => Effect.Effect<void>;
  /** Mend's client for this person's calls, gated: a 401 refuses the token used. */
  readonly mend: GatedMend;
  /** One thread in full, or null when the person has no such thread. */
  readonly threadSnapshot: (threadId: string) => Effect.Effect<ThreadSnapshot | null, HubReadError>;
  readonly threadFinder: ThreadFinder;
  /**
   * One thread in full and its changes from here; the hub keeps its items current while any
   * subscription lasts. Null when the person has no such thread.
   */
  readonly subscribeThread: (
    threadId: string,
    afterSequence?: number,
  ) => Effect.Effect<ThreadSubscription | null, HubReadError, Scope.Scope>;
  /**
   * Publishes the created project into this person's shell before returning; fails, naming the
   * project Mend created, when the shell cannot hold it in time.
   */
  readonly createProject: (
    session: BearerSession,
    request: ProjectCreationRequest,
  ) => Effect.Effect<MendProject, ThreadCommandFailure>;
  /** What a t3code client may do to a thread, each answering the hub's sequence after it. */
  readonly commands: ThreadCommands;
  /**
   * Keeps the images a client attaches to a message (`assets.persistChatAttachments`) until the
   * message is sent; answers each as the message will carry it.
   */
  readonly persistImages: (input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly uploads: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly dataUrl: string;
    }>;
  }) => Effect.Effect<ReadonlyArray<MessageImage>, ThreadCommandRefused>;
  /**
   * The unified diff of a thread from the end of turn `fromTurnCount` (0: where its first turn
   * started) to the end of turn `toTurnCount`, from the worktree's checkpoint chain, read as the
   * person (`turn-checkpoints.ts`).
   */
  readonly turnDiff: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
  }) => Effect.Effect<string, ThreadCommandFailure>;
  /** The person's terminals, Mend's shells reached over `/api/tty` (`terminals.ts`). */
  readonly terminals: Terminals;
  /** How each new worktree's preparation goes, by t3code thread id (`worktree-setup.ts`). */
  readonly worktreeSetups: Pick<WorktreeSetups, "stream" | "cancel">;
  /**
   * Keeps the project actions the person saved for one of their projects (t3code's
   * `projectScriptOverrides`), or lets go of them for null, and shows them as the project's scripts.
   */
  readonly saveProjectScripts: (
    projectId: string,
    scripts: ReadonlyArray<ProjectScript> | null,
  ) => Effect.Effect<void, ThreadCommandFailure>;
  /** One of the person's images, or null when it is not theirs. */
  readonly imageOf: (imageId: string) => MessageImage | null;
  /**
   * The change of the thread whose worktree is at `worktreePath` (what t3code's review calls its
   * `cwd`), or null when no thread of the person's is there or its worktree has no change yet.
   */
  readonly changeOfWorktree: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeChange | null, HubReadError>;
  /**
   * What a t3code `cwd` is in Mend: a thread's worktree (its session), or a project's store path
   * (the project alone, read at its default branch). Null when it is neither of the person's.
   */
  readonly locationOf: (cwd: string) => Effect.Effect<CwdLocation | null, HubReadError>;
  /**
   * Where an absolute path is in one of the person's threads' worktrees, or null when it is in
   * none of them.
   */
  readonly worktreeFileOf: (
    path: string,
    threadId?: string,
  ) => Effect.Effect<WorktreeFile | null, HubReadError>;
  /**
   * Removes the worktree at `path` of the project at `cwd` in Mend (`vcs.removeWorktree`, sent once
   * t3code deleted its last thread), never with force: Mend's refusals stand. A worktree Mend no
   * longer has is removed already.
   */
  readonly removeWorktree: (input: {
    readonly session: BearerSession;
    readonly cwd: string;
    readonly path: string;
  }) => Effect.Effect<void, RemovalKept | HubReadError>;
  /**
   * Removes the project in Mend (`project.delete`), which has no force. Answers the project as
   * t3code's own server does, deleted, once the shell no longer holds it.
   */
  readonly removeProject: (input: {
    readonly session: BearerSession;
    readonly projectId: string;
  }) => Effect.Effect<Project, RemovalKept | HubReadError>;
}

export interface WorktreeFile {
  readonly projectId: string;
  /** A thread working in the worktree, to list its files by. */
  readonly sessionId: string;
  readonly worktreeId: string;
  /** From the worktree's top, `""` for the top itself. */
  readonly relativePath: string;
  /** As on `CwdLocation`: what was read of the worktree's files before it moved is stale. */
  readonly workspaceMutation: string | null;
}

export interface CwdLocation {
  readonly projectId: string;
  /** The thread's session; null for the project's own root. */
  readonly sessionId: string | null;
  /** The thread's worktree's change, when it has one. */
  readonly changeId: string | null;
  /** The thread's branch, or the project's default branch for its root. */
  readonly branch: string;
  readonly defaultBranch: string;
  /** What the worktree is based on, when Mend recorded it. */
  readonly baseRef: string | null;
  /** Whether the project came from a remote (its origin). */
  readonly hasOrigin: boolean;
  /** The thread's worktree; null for the project's root. */
  readonly worktreeId: string | null;
  /**
   * The last command or file change to finish in an open thread of the worktree, as t3code's
   * `workspaceMutationId` marks it: what was read of the worktree's files before it moved is stale.
   */
  readonly workspaceMutation: string | null;
}

export interface WorktreeChange {
  readonly changeId: string;
  /** The ref the worktree was based on, when Mend recorded one. */
  readonly baseRef: string | null;
}

/** A thread command Mend or the gateway did not take; `authorization` when it is not theirs. */
export class ThreadCommandRefused extends Schema.TaggedError<ThreadCommandRefused>()(
  "ThreadCommandRefused",
  { reason: Schema.String, authorization: Schema.Boolean },
) {
  override get message(): string {
    return this.reason;
  }
}

export type ThreadCommandFailure = ThreadCommandRefused | HubReadError;

/** A settle, snooze, pin or order the state file failed on: logged, and refused as not applied. */
const lifecycleKept = <A>(effect: Effect.Effect<A, GatewayStateError>) =>
  effect.pipe(
    Effect.tapError((error) =>
      Effect.logError("t3 gateway could not keep a settle, snooze, pin or order", {
        cause: error.message,
      }),
    ),
    Effect.mapError(
      () =>
        new ThreadCommandRefused({
          reason: "The gateway could not keep this, so nothing changed. Try again.",
          authorization: false,
        }),
    ),
  );

export interface ThreadCommands {
  /**
   * A message for the thread. The gateway queues it and sends it once no turn is open: as a turn
   * of the live agent, or, when the agent has stopped (the idle stop), as the opening turn of a
   * protocol launch on the options the session last recorded, so it comes back as it was.
   */
  readonly send: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly text: string;
    /** Images kept with `persistImages`, by id. */
    readonly imageIds: ReadonlyArray<string>;
    /**
     * The model selection the message carries: a model or effort changed on the picker is kept
     * for the agent's next start, the Fast tier or another provider is refused (`model-options.ts`).
     */
    readonly modelSelection?: ModelSelection | undefined;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /** Interrupts a running run, or takes back a queued one; `holdQueue` holds what is queued. */
  readonly interrupt: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly runId: string;
    readonly holdQueue: boolean;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  readonly cancelQueued: (
    threadId: string,
    runId: string,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  /** Resumes a held queue (`queue.resume`). */
  readonly resumeQueue: (threadId: string) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Sends a waiting message first and resumes the queue (`queued-run.start`), refused unless the
   * thread is stopped, as on t3code's server.
   */
  readonly startQueued: (
    threadId: string,
    runId: string,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  /** New text for a message still waiting in the gateway's queue (`queued-run.edit`). */
  readonly editQueued: (
    threadId: string,
    runId: string,
    text: string,
    imageIds?: ReadonlyArray<string>,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  /** Moves a waiting message before another, or last (`queued-run.reorder`). */
  readonly reorderQueued: (
    threadId: string,
    runId: string,
    beforeRunId: string | null,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  readonly respond: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly requestId: string;
    readonly response: MendRequestResponse;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * A new thread (`orchestration.launchThread`): a Mend session the sender owns, in a new
   * worktree or one they join, launched in protocol mode on what the launch names. Its opening
   * message goes through the queue like any other, so it is sent as an exact turn once the agent
   * runs. A retry of the same command is the same thread.
   */
  readonly launch: (input: ThreadLaunch) => Effect.Effect<LaunchedThreadId, ThreadCommandFailure>;
  /**
   * `prepared-run.retry`: prepares again the worktree of an opening message whose preparation
   * failed, then sends the message as a launch's would be.
   */
  readonly retryPreparation: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly runId: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /** The session's name in Mend (`thread.metadata.update` with a title). Mend lets only its owner. */
  readonly rename: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly title: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Stops the session (`provider-session.detach`, which t3code sends before a delete): its agent
   * and workspace stop; what is still queued is held, so nothing relaunches it unasked.
   */
  readonly stop: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Deletes the session in Mend (`thread.delete`), stopping it first when Mend says it is live.
   * Its worktree and change stay, as they do for every session Mend removes.
   */
  readonly remove: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * The permission mode for the agent's next start (`thread.runtime-mode.set`): Mend sets it per
   * launch, so the running agent keeps its own until it next starts, and the thread says so.
   */
  readonly setNextMode: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly mode: "bypass" | "ask";
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * The model and options picked for the thread (`thread.model-selection.set`), weighed as a
   * message's are: a model or effort waits for the agent's next start, and the thread says so.
   */
  readonly setNextSelection: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Archives the thread in the person's view, or takes it out of the archive (`thread.archive`,
   * `thread.unarchive`). Mend has no archive: the session is not touched. What is still queued for
   * an archived thread is held, never sent while it is archived, and still there when it is not.
   */
  readonly setArchived: (input: {
    readonly threadId: string;
    readonly archived: boolean;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Settles, snoozes, pins or orders the thread in the person's view, or undoes one
   * (`thread.settle`, `thread.snooze`, `thread.pin`, `thread.active.reorder`,
   * `thread.auto-settle.set` and their kin; `lifecycle.ts`). Mend has none of them: the session is
   * not touched.
   */
  readonly setLifecycle: (input: {
    /**
     * The client's command: one sent again (a retry of one it saw no answer to) is answered as it
     * first was, never applied twice, as t3code's own server answers from its command receipts.
     */
    readonly commandId: string;
    readonly threadId: string;
    readonly change: LifecycleChange;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Records that the person saw the thread as it stood at `visitedAt` (`thread.visit`), or marks
   * it unread (`thread.mark-unread`; `visits.ts`). Mend has no read state: the session is not
   * touched.
   */
  readonly setVisited: (input: {
    readonly threadId: string;
    readonly change: { readonly kind: "visit"; readonly at: string } | { readonly kind: "unread" };
  }) => Effect.Effect<number, ThreadCommandFailure>;
}

/** A project by name (`name`, then `name-2` on), or the person's scratch project. */
export type ProjectCreationRequest =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "scratch" };

/**
 * Where a launched thread works: a new worktree made and prepared as t3code's strategy asks
 * (`worktree-setup.ts`), or an existing one it joins.
 */
export type ThreadWorkspace =
  | {
      readonly kind: "new";
      readonly strategy: Queueing.WorkspacePreparation;
      readonly name: string | null;
    }
  | { readonly kind: "join"; readonly worktreePath: string }
  | { readonly kind: "root" };

export interface ThreadLaunch {
  readonly session: BearerSession;
  readonly commandId: string;
  /** The client's id for the thread, or null for the session's own. */
  readonly threadId: string | null;
  readonly projectId: string;
  readonly harness: string;
  /** The session's label in Mend, or null to leave it unnamed (named from its first message). */
  readonly label: string | null;
  readonly workspace: ThreadWorkspace;
  readonly options: ThreadLaunchOptions;
  readonly message: {
    readonly messageId: string;
    readonly text: string;
    readonly imageIds: ReadonlyArray<string>;
  } | null;
}

export interface LaunchedThreadId {
  readonly threadId: string;
  /** The command was launched before: this is that thread. */
  readonly resumed: boolean;
}

/**
 * The person's device tokens the hub reads with: any of them speaks for the same person. A token
 * Mend refuses (a 401, or a revocation the hub checks for) ends everything held with it.
 */
export interface PersonTokens {
  /** A token Mend has not refused yet, or null when every known one was refused. */
  readonly current: () => string | null;
  /** Every token of the person the gateway holds and Mend has not refused. */
  readonly live: () => ReadonlyArray<string>;
  /** Mend refused this token: the device was revoked. Ends its sockets and bearer sessions. */
  readonly refuse: (token: string) => Effect.Effect<void>;
  readonly isRefused: (token: string) => boolean;
  /** Completes once the token is refused. */
  readonly refusal: (token: string) => Effect.Effect<void>;
  /** Completes once every token of the person the gateway holds was refused. */
  readonly noneLeft: Effect.Effect<void>;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface ProjectEntry {
  readonly project: MendProject;
  readonly sessions: ReadonlyArray<MendSession>;
  readonly annotations: ReadonlyMap<string, MendSessionAnnotation>;
}

interface Conversation {
  readonly turns: ReadonlyArray<MendTurn>;
  readonly requests: ReadonlyArray<MendRequest>;
  /** What holds the next sender's turn (docs/adr/0016, decision 6); null when nothing waits. */
  readonly wait: MendConversationWait | null;
}

interface Printed<A> {
  readonly value: A;
  /** The entity as t3code reads it, encoded: what changed, and proof that it encodes. */
  readonly print: string;
}

/** A thread someone is watching: its items, kept current, and what was last sent of it. */
interface Watch {
  count: number;
  /** Counts the times its subscribers all left: only the latest such time's grace may end it. */
  idle: number;
  readonly items: Map<string, MendItem>;
  /** The highest item change-feed cursor read so far. */
  cursor: number;
  /** Entity key → its print as last sent; null until the first subscriber's snapshot. */
  prints: Map<string, string> | null;
  /** The thread as last sent, for the `thread.deleted` event if it goes. */
  thread: OrchestrationV2AppThread | null;
  /** What was published for it since its baseline, for a client resuming after a sequence. */
  log: ReplayLog<ThreadChange> | null;
  /** The worktree's checkpoint chain as last read; null until it is (`turn-checkpoints.ts`). */
  chain: ReadonlyArray<MendCheckpoint> | null;
  /** How many of its turns had ended when the chain was last read: a new end reads it again. */
  endedTurns: number;
  /** When the chain was last read (epoch ms): a turn still waiting for its checkpoint reads again. */
  chainReadAt: number;
  /** How many times the chain was read again for a turn's missing checkpoint since a turn ended. */
  chainRetries: number;
  /** A read again is already set for when the last one is `CHAIN_REREAD_MS` old. */
  chainRecheck: boolean;
}

/**
 * A quiet thread's items still in progress, as last read from Mend: a background agent can outlast
 * its turn by days, so the settlement sweep reads them before it settles a thread on its own.
 */
interface QuietWork {
  /** The highest item change-feed cursor read so far. */
  cursor: number;
  readonly open: Map<string, MendItem>;
  /** When the last read began (epoch ms): one from before the thread's latest turn is stale. */
  readAt: number;
}

/** The thread's shell, when the sweep would settle it but for the work its items hold. */
const settleableShellOf = (source: ThreadSource, nowMs: number) => {
  const { lifecycle } = source;
  // Passed over before its shell is built: most threads are settled, and this runs on every read.
  if (
    source.archivedAt !== null ||
    lifecycle.settledOverride !== null ||
    lifecycle.pinnedAt !== null ||
    lifecycle.autoSettleDisabledAt !== null
  ) {
    return null;
  }
  const shell = settlementCandidateOf(source);
  return autoSettledAt(shell, nowMs) === null ? null : shell;
};

const isCurrent = (work: QuietWork, shell: SettlementCandidate) =>
  work.readAt > (activityAtOf(shell) ?? Number.NEGATIVE_INFINITY);

/** A refusal Mend gave a command, in the words t3code shows. */
const commandRefusalOf = (error: MendCommandRefused | MendNotFound): ThreadCommandRefused =>
  error._tag === "MendNotFound"
    ? new ThreadCommandRefused({ reason: error.message, authorization: false })
    : new ThreadCommandRefused({
        reason: error.message,
        authorization: error.status === 403,
      });

/** What a message is told when Mend refused the call that carried it. */
const reasonOf = (error: { readonly _tag: string; readonly message: string }) =>
  error._tag === "MendDeviceRefused"
    ? "Mend no longer accepts the device that sent this message."
    : error.message;

/** How many items one `GET /api/sessions/:id/items` page asks for. */
const ITEM_PAGE = 500;

const EMPTY_CONVERSATION: Conversation = { turns: [], requests: [], wait: null };
const NO_IDS: ReadonlyMap<string, string> = new Map();

/** Encodes through the vendored schema, so a mapping bug is caught here and never sent. */
const printer = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const encode = Schema.encodeUnknownExit(Schema.toCodecJson(schema));
  return (value: S["Type"]): string | Error => {
    const exit = encode(value);
    return Exit.isSuccess(exit) ? JSON.stringify(exit.value) : new Error(String(exit.cause));
  };
};
const printProject = printer(OrchestrationProjectShell);
const printThreadShell = printer(OrchestrationV2ThreadShell);
const printAppThread = printer(OrchestrationV2AppThread);
const printRun = printer(OrchestrationV2Run);
const printRequest = printer(OrchestrationV2RuntimeRequest);
const printMessage = printer(OrchestrationV2ConversationMessage);
const printTurnItem = printer(OrchestrationV2TurnItem);
const printProviderSession = printer(OrchestrationV2ProviderSession);
const printProviderThread = printer(OrchestrationV2ProviderThread);
const printCheckpointScope = printer(OrchestrationV2CheckpointScope);
const printCheckpoint = printer(OrchestrationV2Checkpoint);

/** One entity of a thread projection, the event that upserts it, and its print. */
interface ThreadEntity {
  readonly key: string;
  readonly print: string;
  readonly event: (base: {
    readonly id: EventId;
    readonly threadId: ThreadId;
    readonly occurredAt: DateTime.Utc;
  }) => OrchestrationV2DomainEvent;
}

/**
 * A projection's entities, each encoded through its vendored schema. One that does not encode is
 * logged and left out, of the events and of the snapshot alike: a mapping bug never reaches a
 * client as a defect.
 */
const printProjection = (
  projection: OrchestrationV2ThreadProjection,
): Effect.Effect<{
  readonly projection: OrchestrationV2ThreadProjection;
  readonly entities: ReadonlyArray<ThreadEntity>;
}> =>
  Effect.gen(function* () {
    const entities: Array<ThreadEntity> = [];
    const failed = new Set<string>();
    const add = (key: string, print: string | Error, event: ThreadEntity["event"]) => {
      if (print instanceof Error) {
        failed.add(key);
        return Effect.logError("t3 gateway could not encode a thread entity", {
          threadId: projection.thread.id,
          key,
          cause: print.message,
        });
      }
      entities.push({ key, print, event });
      return Effect.void;
    };
    const thread = projection.thread;
    yield* add("thread", printAppThread(thread), (base) => ({
      ...base,
      type: "thread.metadata-updated",
      payload: thread,
    }));
    for (const session of projection.providerSessions) {
      yield* add(`provider-session:${session.id}`, printProviderSession(session), (base) => ({
        ...base,
        type: "provider-session.updated",
        payload: session,
      }));
    }
    for (const providerThread of projection.providerThreads) {
      yield* add(
        `provider-thread:${providerThread.id}`,
        printProviderThread(providerThread),
        (base) => ({ ...base, type: "provider-thread.updated", payload: providerThread }),
      );
    }
    for (const run of projection.runs) {
      yield* add(`run:${run.id}`, printRun(run), (base) => ({
        ...base,
        runId: run.id,
        type: "run.updated",
        payload: run,
      }));
    }
    for (const request of projection.runtimeRequests) {
      yield* add(`request:${request.id}`, printRequest(request), (base) => ({
        ...base,
        type: "runtime-request.updated",
        payload: request,
      }));
    }
    for (const message of projection.messages) {
      yield* add(`message:${message.id}`, printMessage(message), (base) => ({
        ...base,
        type: "message.updated",
        payload: message,
      }));
    }
    for (const scope of projection.checkpointScopes) {
      yield* add(`checkpoint-scope:${scope.id}`, printCheckpointScope(scope), (base) => ({
        ...base,
        type: "checkpoint-scope.created",
        payload: scope,
      }));
    }
    for (const checkpoint of projection.checkpoints) {
      yield* add(`checkpoint:${checkpoint.id}`, printCheckpoint(checkpoint), (base) => ({
        ...base,
        type: "checkpoint.captured",
        payload: checkpoint,
      }));
    }
    for (const item of projection.turnItems) {
      yield* add(`item:${item.id}`, printTurnItem(item), (base) => ({
        ...base,
        type: "turn-item.updated",
        payload: item,
      }));
    }
    if (failed.size === 0) return { projection, entities };
    const kept = <A extends { readonly id: string }>(prefix: string, values: ReadonlyArray<A>) =>
      values.filter((value) => !failed.has(`${prefix}:${value.id}`));
    return {
      projection: {
        ...projection,
        runs: kept("run", projection.runs),
        checkpointScopes: kept("checkpoint-scope", projection.checkpointScopes),
        checkpoints: kept("checkpoint", projection.checkpoints),
        runtimeRequests: kept("request", projection.runtimeRequests),
        messages: kept("message", projection.messages),
        turnItems: kept("item", projection.turnItems),
        visibleTurnItems: projection.visibleTurnItems
          .filter((row) => !failed.has(`item:${row.item.id}`))
          .map((row, position) => ({ ...row, position })),
      },
      entities,
    };
  });

/**
 * Which pointers move what (`MendEvent` in @mend/db). Record lines (`session-progress`) and
 * review comments change nothing t3code shows; membership and resyncs may move anything.
 */
export const refreshKeyOf = (pointer: MendEventPointer): string | null => {
  switch (pointer.type) {
    case "project":
    case "session":
    case "session-process":
    case "worktree":
    case "session-change":
    case "shared-control-off":
      return pointer.projectId === undefined ? null : `project:${pointer.projectId}`;
    case "agent-conversation":
      return pointer.sessionId === undefined ? null : `conversation:${pointer.sessionId}`;
    // A device revoked, or the account removed from its organization.
    case "user":
      return pointer.facet === "devices" ? "devices" : pointer.facet === "access" ? "all" : null;
    case "organization":
    case "resync":
      return "all";
    default:
      return null;
  }
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/**
 * How often every device token of the person is checked against Mend, pointer or not. Mend
 * publishes a `devices` pointer when a device is revoked, which checks at once; this bounds how
 * long an open socket of a revoked device is served when that pointer is missed.
 */
const DEVICE_CHECK_INTERVAL = "15 seconds";
/** How long a failed full read waits before it is tried again. */
const FULL_READ_RETRY = "3 seconds";
/** A stream that lasted this long resets the backoff: it was a drop, not a refusal loop. */
const HEALTHY_STREAM_MS = 30_000;

const projectableSessionIds = (
  entry: ProjectEntry,
  launched: ReadonlyMap<string, LaunchedThread>,
): ReadonlyArray<string> =>
  entry.sessions
    .filter((session) =>
      isProjectable(
        session,
        entry.annotations.get(session.id)?.currentAgent ?? null,
        launched.has(session.id),
      ),
    )
    .map((session) => session.id);

const entryOf = (detail: {
  readonly project: MendProject;
  readonly sessions: ReadonlyArray<MendSession>;
  readonly annotations: ReadonlyArray<MendSessionAnnotation>;
}): ProjectEntry => ({
  project: detail.project,
  sessions: detail.sessions,
  annotations: new Map(detail.annotations.map((annotation) => [annotation.sessionId, annotation])),
});

/**
 * A read that only adds a line (docs/adr/0016, decisions 6 and 13): a server from before it
 * answers 404, and a failed read leaves the line out rather than the thread. A refused device
 * still fails it.
 */
const optionalRead = <A>(
  read: Effect.Effect<A, MendDeviceRefused | MendNotFound | MendUnavailable>,
): Effect.Effect<A | null, MendDeviceRefused> =>
  read.pipe(
    Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
    Effect.catchTag("MendUnavailable", (error) =>
      Effect.logWarning("t3 gateway could not read a line from Mend", {
        cause: error.message,
      }).pipe(Effect.as(null)),
    ),
  );

const mergeItems = (watch: Watch, read: ReadonlyArray<MendItem>) => {
  for (const item of read) {
    const known = watch.items.get(item.id);
    if (known === undefined || known.seq <= item.seq) watch.items.set(item.id, item);
    watch.cursor = Math.max(watch.cursor, item.seq);
  }
};

export const makePersonHub = (input: {
  /** The only way the hub reaches Mend (`device-gate.ts`). */
  readonly mend: GatedMend;
  /**
   * The person the hub reads for: the shared-workspace line names everyone else live in an
   * executor (docs/adr/0016, decision 13). Null reads as someone who runs nothing there.
   */
  readonly viewer: { readonly id: string; readonly name: string } | null;
  readonly state: GatewayState["Service"];
  readonly tokens: PersonTokens;
  readonly parser: FindParser["Service"];
  /** Lets go of the hub in the registry, once it has torn itself down. */
  readonly dispose?: Effect.Effect<void>;
  /**
   * Holds the hub (true) or lets it go (false) independently of sockets: while a message the
   * gateway accepted is queued or on its way, the hub must outlive every client.
   */
  readonly retain?: (busy: boolean) => Effect.Effect<void>;
  /** The queue's waits (`queue.ts`); Mend-sized defaults when unset. */
  readonly queueTimings?: Queueing.QueueTimings;
  /** Mend's API origin, for the terminal socket; terminals answer "not running" without it. */
  readonly mendUrl?: URL;
}): Effect.Effect<PersonHub, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { mend, state, tokens } = input;
    const retain = input.retain ?? (() => Effect.void);
    const timings = input.queueTimings ?? Queueing.DEFAULT_QUEUE_TIMINGS;
    /** Session id → how many reads of it from Mend were applied: fresh evidence for a retry. */
    const evidence = new Map<string, number>();
    const sawSession = (sessionId: string) =>
      evidence.set(sessionId, (evidence.get(sessionId) ?? 0) + 1);
    const hubScope = yield* Scope.Scope;

    /** Mend session id → the t3code ids of the turns the gateway sent (the id map). */
    const turnIds = new Map<
      string,
      { readonly runIds: Map<string, string>; readonly messageIds: Map<string, string> }
    >();
    const rememberIds = (ids: TurnIds) => {
      const known = turnIds.get(ids.sessionId) ?? { runIds: new Map(), messageIds: new Map() };
      known.runIds.set(ids.turnId, ids.runId);
      known.messageIds.set(ids.turnId, ids.messageId);
      turnIds.set(ids.sessionId, known);
    };
    for (const ids of yield* state
      .listTurnIds()
      .pipe(
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not read its id map", { cause: error.message }).pipe(
            Effect.as<ReadonlyArray<TurnIds>>([]),
          ),
        ),
      )) {
      rememberIds(ids);
    }
    /**
     * Session id → the thread a t3code client launched as it, and the client's thread id → its
     * session: a launched thread keeps the id its client gave it (`thread_ids`).
     */
    const launched = new Map<string, LaunchedThread>();
    const sessionOfThread = new Map<string, string>();
    const rememberThread = (thread: LaunchedThread) => {
      launched.set(thread.sessionId, thread);
      sessionOfThread.set(thread.threadId, thread.sessionId);
    };
    // Only the person's own launches: a client thread id names a session for its launcher alone,
    // and everyone else sees the session by its Mend id.
    const launcher = input.viewer?.id ?? null;
    for (const thread of yield* (
      launcher === null
        ? Effect.succeed<ReadonlyArray<LaunchedThread>>([])
        : state.listThreads(launcher)
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("t3 gateway could not read its thread map", {
          cause: error.message,
        }).pipe(Effect.as<ReadonlyArray<LaunchedThread>>([])),
      ),
    )) {
      rememberThread(thread);
    }
    /** A t3code thread id as the Mend session it is. */
    const sessionIdOf = (threadId: string): string => sessionOfThread.get(threadId) ?? threadId;
    /**
     * Sessions deleted through the gateway that Mend keeps until their workspace has stopped
     * (`RemovalReport.leftover`): hidden at once, as t3code's client already dropped them, and kept
     * in the state file so a restart does not bring them back.
     */
    const removing = new Set<string>(
      launcher === null
        ? []
        : yield* state.listRemovals(launcher).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its pending removals", {
                cause: error.message,
              }).pipe(Effect.as<ReadonlyArray<string>>([])),
            ),
          ),
    );
    /** Forgets the removals Mend has finished: it no longer lists the session. */
    const removed = (sessionIds: ReadonlyArray<string>) =>
      launcher === null
        ? Effect.void
        : Effect.forEach(
            sessionIds,
            (sessionId) =>
              state.dropRemoval(launcher, sessionId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("t3 gateway could not forget a finished removal", {
                    cause: error.message,
                  }),
                ),
              ),
            { discard: true },
          );
    /**
     * Sessions just created for a launch that no project read has shown yet: hidden, and their
     * queue left alone, until one does, so the client never sees the thread without its message
     * and the message is never failed as "gone" for a session not read yet.
     */
    const opening = new Set<string>();
    /** A launched session a project read showed: it is a thread from here. */
    const seen = (sessionIds: Iterable<string>) => {
      for (const sessionId of sessionIds) opening.delete(sessionId);
    };
    const queues = new Map<string, Queueing.ThreadQueue>();
    /**
     * Session id → its queue as the state file last kept it (ADR 0012, "State"): a queue is written
     * when it changed, and a restart brings back what was kept for this person.
     */
    const keptQueues = new Map<string, string>();
    const keeper = input.viewer;
    if (keeper !== null) {
      for (const restored of yield* state.loadQueues(keeper.id).pipe(
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not read its kept queues", {
            cause: error.message,
          }).pipe(Effect.as([])),
        ),
      )) {
        const queue = Queueing.restoredQueue(
          restored.queue,
          (sender) => restored.senders.get(sender) ?? null,
        );
        queues.set(restored.sessionId, queue);
        keptQueues.set(restored.sessionId, JSON.stringify(restored.queue));
      }
    }
    /**
     * Messages Mend took whose turn ids the state file refused (review 593-R2-2): each is still
     * kept as being sent, so after a restart it comes back as sent-before-restart and a retry of
     * it is not taken as new. Every later write of the queue tries the ids again first.
     */
    const unrecorded = new Map<
      string,
      Array<{ readonly stored: Queueing.StoredEntry; readonly ids: TurnIds }>
    >();
    const recordUnrecorded = (sessionId: string) =>
      Effect.gen(function* () {
        const waiting = unrecorded.get(sessionId) ?? [];
        const still: typeof waiting = [];
        for (const item of waiting) {
          const recorded = yield* state
            .recordTurnIds(item.ids, yield* Clock.currentTimeMillis)
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          if (!recorded) still.push(item);
        }
        if (still.length === 0) unrecorded.delete(sessionId);
        else unrecorded.set(sessionId, still);
        return still.map((item) => item.stored);
      });
    /** Writes one queue if it changed since it was last kept: whether the state file has it now. */
    const keepQueue = (sessionId: string, queue: Queueing.ThreadQueue): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (keeper === null) return true;
        const tombstones = unrecorded.has(sessionId) ? yield* recordUnrecorded(sessionId) : [];
        const live = Queueing.storedOf(queue);
        const stored = { ...live, entries: [...tombstones, ...live.entries] };
        const print = JSON.stringify(stored);
        if (keptQueues.get(sessionId) === print) return true;
        return yield* state.saveQueue(keeper.id, sessionId, stored).pipe(
          Effect.tap(() => Effect.sync(() => keptQueues.set(sessionId, print))),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("t3 gateway could not keep a queue", { cause: error.message }).pipe(
              Effect.as(false),
            ),
          ),
        );
      });

    /**
     * The person's images (`images.ts`), without their bytes: by id, and by the message that
     * carries them. Bytes are read from the state file only to place an image in Mend or to serve
     * it to the person.
     */
    const images = new Map<string, StoredImage>();
    if (keeper !== null) {
      for (const image of yield* state.listImages(keeper.id).pipe(
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not read its kept images", {
            cause: error.message,
          }).pipe(Effect.as([])),
        ),
      )) {
        images.set(image.id, image);
      }
    }
    /** Message id → the images it carried when Mend took its turn: the final selection. */
    const sentImages = new Map<string, ReadonlyArray<SentImage>>(
      keeper === null
        ? []
        : yield* state.listSentImages(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read which images its messages carried", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, ReadonlyArray<SentImage>>())),
            ),
          ),
    );
    const imagesOfMessage = (messageId: string) =>
      (sentImages.get(messageId) ?? []).flatMap((sent) => {
        const image = images.get(sent.imageId);
        return image === undefined ? [] : [{ image, path: sent.path }];
      });
    const imagesOfIds = (ids: ReadonlyArray<string>): ReadonlyArray<StoredImage> =>
      ids.flatMap((id) => {
        const image = images.get(id);
        return image === undefined ? [] : [image];
      });

    /** Session id → the permission mode the person chose for its agent's next start. */
    const nextModes = new Map<string, "bypass" | "ask">(
      keeper === null
        ? []
        : yield* state.listNextModes(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its next-start modes", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, "bypass" | "ask">())),
            ),
          ),
    );
    /** Session id → when the person archived its thread (`archived_threads`). */
    const archived = new Map<string, string>(
      keeper === null
        ? []
        : yield* state.listArchived(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its archive", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, string>())),
            ),
          ),
    );
    /** Session id → the person's settle and snooze of its thread (`thread_lifecycles`), as kept. */
    const lifecycles = new Map<string, ThreadLifecycle>(
      keeper === null
        ? []
        : yield* state.listLifecycles(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its settled, snoozed and pinned threads", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, ThreadLifecycle>())),
            ),
          ),
    );
    /** Session id → when the person last saw its thread (`thread_visits`). */
    const visited = new Map<string, string>(
      keeper === null
        ? []
        : yield* state.listVisited(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read when threads were last seen", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, string>())),
            ),
          ),
    );
    /** Session id → the reasoning effort the person chose for its agent's next start. */
    const nextEfforts = new Map<string, string>(
      keeper === null
        ? []
        : yield* state.listNextEfforts(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its next-start efforts", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, string>())),
            ),
          ),
    );
    const nextModels = new Map<string, string>(
      keeper === null
        ? []
        : yield* state.listNextModels(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its next-start models", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, string>())),
            ),
          ),
    );
    const projectScripts = new Map<string, ReadonlyArray<ProjectScript>>(
      keeper === null
        ? []
        : yield* state.listProjectScripts(keeper.id).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its project actions", {
                cause: error.message,
              }).pipe(Effect.as(new Map<string, ReadonlyArray<ProjectScript>>())),
            ),
          ),
    );
    /**
     * Keeps each settle and snooze as it stands now: one a later turn or message ended is let go of
     * in the state file too, so it never comes back when that message leaves the queue's history.
     * Kept in memory until written, and tried again on the next read.
     */
    const settleLifecycles = Effect.suspend(() => {
      if (keeper === null || lifecycles.size === 0) return Effect.void;
      return Effect.forEach(
        Array.from(lifecycles),
        ([sessionId, kept]) => {
          const now = lifecycleOf(kept, {
            turns: conversations.get(sessionId)?.turns ?? [],
            pending: (queues.get(sessionId)?.entries ?? []).map((queued) => ({
              state: Queueing.pendingStateOf(queued),
              requestedAt: queued.requestedAt,
            })),
          });
          if (sameLifecycle(kept, now)) return Effect.void;
          return state.setLifecycle(keeper.id, sessionId, isLifecycleEmpty(now) ? null : now).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (isLifecycleEmpty(now)) lifecycles.delete(sessionId);
                else lifecycles.set(sessionId, now);
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not let go of a settle or a snooze", {
                cause: error.message,
              }),
            ),
          );
        },
        { discard: true },
      );
    });
    const settleNext = <A>(
      what: string,
      chosen: Map<string, A>,
      runsWith: (agent: MendProcess, value: A) => boolean,
      letGo: (mendUserId: string, sessionId: string) => Effect.Effect<void, GatewayStateError>,
    ) =>
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(chosen),
          ([sessionId, value]) => {
            const source = sourceOf(sessionId);
            const applied =
              source !== null && isLive(source.agent) && runsWith(source.agent, value);
            if (!applied || keeper === null) return Effect.void;
            return letGo(keeper.id, sessionId).pipe(
              Effect.tap(() => Effect.sync(() => chosen.delete(sessionId))),
              Effect.catch((error) =>
                Effect.logWarning(`t3 gateway could not let go of a next-start ${what}`, {
                  cause: error.message,
                }),
              ),
            );
          },
          { discard: true },
        ),
      );
    const settleNextModes = settleNext(
      "mode",
      nextModes,
      (agent, mode) => modeOf(agent) === mode,
      (user, session) => state.setNextMode(user, session, null),
    );
    const settleNextEfforts = settleNext(
      "effort",
      nextEfforts,
      (agent, effort) => agent.protocolOptions?.effort === effort,
      (user, session) => state.setNextChoices(user, session, { effort: null }),
    );
    const settleNextModels = settleNext(
      "model",
      nextModels,
      (agent, model) => agent.protocolOptions?.model === model,
      (user, session) => state.setNextChoices(user, session, { model: null }),
    );

    /** Writes every queue that changed since it was last kept. */
    const keepQueues = Effect.suspend(() =>
      Effect.forEach(Array.from(queues), ([sessionId, queue]) => keepQueue(sessionId, queue), {
        discard: true,
      }),
    );
    const handledCommands = new Set<string>();

    const projects = new Map<string, ProjectEntry>();
    /** Projects removed from here: a read that began before the removal never brings one back. */
    const removedProjects = new Set<string>();
    const conversations = new Map<string, Conversation>();
    /**
     * Session id → the turns Mend answered `POST /turns` with that no read of Mend has shown yet. A
     * read that started before Mend took the turn can land after it was adopted; applied as it is,
     * it would drop the turn, and the queue would send the next message while this one runs.
     */
    const adoptedTurns = new Map<string, Map<string, MendTurn>>();
    /** A conversation as read, with the adopted turns it does not show yet; one it shows is let go. */
    const withAdopted = (sessionId: string, conversation: Conversation): Conversation => {
      const adopted = adoptedTurns.get(sessionId);
      if (adopted === undefined) return conversation;
      const missing: Array<MendTurn> = [];
      for (const [turnId, turn] of adopted) {
        if (conversation.turns.some((known) => known.id === turnId)) adopted.delete(turnId);
        else missing.push(turn);
      }
      if (adopted.size === 0) adoptedTurns.delete(sessionId);
      return missing.length === 0
        ? conversation
        : { ...conversation, turns: [...conversation.turns, ...missing] };
    };
    /**
     * Session id → its row of `GET /api/sessions` (docs/adr/0016, decisions 6, 13 and 14): the
     * people live in its executor, whether control is shared, whether its executor waits to be
     * replaced. The project read's sessions carry none of it. What it says decides whether the
     * waiting line and the retirement are read at all (`readsWaiting`, `readsRetirement`).
     */
    let active = new Map<string, MendActiveSession>();
    /**
     * Session id → its executor's retirement (decision 14), read only for watched threads whose
     * row says one is under way: only the full thread has a place to say it.
     */
    const retirements = new Map<string, MendWorkspaceRetirement | null>();
    /**
     * The hub's sequences come in blocks reserved from the state file (`reserveSequences`): one
     * high-water mark for the whole gateway, seeded from the clock, so no hub ever stamps a
     * sequence a client was given by another (an earlier hub of this person's, another person's,
     * or a gateway before replay, which counted from 0). A resume is answered by replay only after
     * a sequence in one of this hub's blocks. Without a reservation, nothing is replayed.
     */
    const reserveBlock = (from: number) =>
      state.reserveSequences(from, SEQUENCE_BLOCK).pipe(
        Effect.map((start): SequenceBlock => ({ start, end: start + SEQUENCE_BLOCK })),
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not reserve sequences", {
            cause: error.message,
          }).pipe(Effect.as(null)),
        ),
      );
    const sequencer = makeSequencer(input.viewer === null ? null : yield* reserveBlock(0));
    let sequence = sequencer.current();
    /** The next sequence: the next in this block, or the first of the next one. */
    const nextSequence = (): number => {
      sequence = sequencer.next();
      return sequence;
    };
    /** Reserves the next block once half of this one is used, and says when it could not. */
    const extendSequences = Effect.suspend(() => {
      if (sequencer.overran()) {
        return Effect.logError(
          "t3 gateway ran out of reserved sequences: resumes get a snapshot until the hub restarts",
        );
      }
      const from = sequencer.wants();
      if (from === null) return Effect.void;
      return reserveBlock(from).pipe(
        Effect.tap((block) =>
          Effect.sync(() => {
            if (block !== null) sequencer.add(block);
          }),
        ),
        Effect.asVoid,
      );
    });
    const shellLog = makeReplayLog<ShellDelta>(SHELL_REPLAY_LIMITS, sequence);
    let shellProjects = new Map<string, Printed<OrchestrationProjectShell>>();
    let shellThreads = new Map<string, Printed<OrchestrationV2ThreadShell>>();
    let shellArchived = new Map<string, Printed<OrchestrationV2ThreadShell>>();
    const archivedChanges = makeFanout<ArchivedShellDelta>();
    const providerSignals = makeFanout<"accounts" | "skills">();
    const settingsChanges = makeFanout<KeptSettings>();
    const shellChanges = makeFanout<ShellDelta>();
    const watches = new Map<string, Watch>();
    const threadChanges = makeFanout<{
      readonly threadId: string;
      readonly change: ThreadChange;
    }>();
    /** Every read of state and every publication happens under it, in order. */
    const lock = Semaphore.makeUnsafe(1);
    const locked = lock.withPermits(1);
    /** Set once every device of the person was refused: nothing reads Mend for them any more. */
    let dead = false;

    /** Calls Mend with one of the person's tokens, and with another when Mend refuses it. */
    const asPerson = <A, E>(
      call: (token: string) => Effect.Effect<A, E | MendDeviceRefused>,
    ): Effect.Effect<A, E | MendDeviceRefused> =>
      Effect.suspend(() => {
        const token = tokens.current();
        if (token === null) {
          return Effect.fail(new MendDeviceRefused({ operation: "every paired device" }));
        }
        // The gate refused the token on a 401; another of the person's devices may still read.
        return call(token).pipe(
          Effect.catch((error) =>
            error instanceof MendDeviceRefused && tokens.current() !== null
              ? asPerson(call)
              : Effect.fail(error),
          ),
        );
      });

    // ─── Building ──────────────────────────────────────────────────────────

    /** Account id → name: the person who paired, and everyone live anywhere they can see. */
    const knownNames = (): ReadonlyMap<string, string> => {
      const names = new Map<string, string>();
      for (const session of active.values()) {
        for (const person of session.livePeople ?? []) names.set(person.accountId, person.name);
      }
      if (input.viewer !== null) names.set(input.viewer.id, input.viewer.name);
      return names;
    };

    const threadSources = (): ReadonlyArray<ThreadSource> => {
      const sources: Array<ThreadSource> = [];
      const names = knownNames();
      for (const entry of projects.values()) {
        for (const session of entry.sessions) {
          if (removing.has(session.id) || opening.has(session.id)) continue;
          const annotation = entry.annotations.get(session.id);
          const thread = launched.get(session.id);
          const current = annotation?.currentAgent ?? null;
          if (!isProjectable(session, current, thread !== undefined)) continue;
          const agent = current ?? launchingAgentOf(session, thread?.options ?? {});
          const conversation = conversations.get(session.id) ?? EMPTY_CONVERSATION;
          const ids = turnIds.get(session.id);
          const queue = queues.get(session.id);
          const pending = (queue?.entries ?? []).map((queued) => ({
            runId: queued.runId,
            messageId: queued.messageId,
            text: queued.text,
            images: imagesOfIds(queued.imageIds),
            requestedAt: queued.requestedAt,
            state: Queueing.pendingStateOf(queued),
            error: queued.error,
            workspacePreparation: queued.workspacePreparation,
            preparationFailed: queued.preparationFailed,
          }));
          sources.push({
            threadId: ThreadId.make(thread?.threadId ?? session.id),
            project: entry.project,
            session,
            agent,
            changeId: annotation?.changeId ?? null,
            turns: conversation.turns,
            requests: conversation.requests,
            runIds: ids?.runIds ?? NO_IDS,
            messageIds: ids?.messageIds ?? NO_IDS,
            imagesOf: imagesOfMessage,
            archivedAt: archived.get(session.id) ?? null,
            lifecycle: lifecycleOf(lifecycles.get(session.id), {
              turns: conversation.turns,
              pending,
            }),
            lastVisitedAt: visited.get(session.id) ?? null,
            nextMode: (() => {
              const next = nextModes.get(session.id);
              return next === undefined || next === modeOf(agent) ? null : next;
            })(),
            nextEffort: (() => {
              const next = nextEfforts.get(session.id);
              return next === undefined || next === agent.protocolOptions?.effort ? null : next;
            })(),
            nextModel: (() => {
              const next = nextModels.get(session.id);
              return next === undefined || (isLive(agent) && agent.protocolOptions?.model === next)
                ? null
                : next;
            })(),
            ...turnCheckpointsOf(session.id, conversation.turns),
            pending,
            queueHeld: queue?.held ?? false,
            notices: threadNoticesOf({
              livePeople: active.get(session.id)?.livePeople ?? [],
              viewerId: input.viewer?.id ?? null,
              wait: conversation.wait,
              retirement: retirements.get(session.id) ?? null,
              names,
            }),
          });
        }
      }
      return sources;
    };

    const sourceOf = (sessionId: string): ThreadSource | null =>
      threadSources().find((source) => source.session.id === sessionId) ?? null;

    /**
     * Slice key → the files of that slice of a worktree's chain, as t3code's checkpoint card lists
     * them. Both ends of a slice are immutable, so an entry never goes stale; the oldest go first.
     */
    const sliceFiles = new Map<string, ReadonlyArray<ReturnType<typeof checkpointFileOf>>>();
    const keepSliceFiles = (
      key: string,
      files: ReadonlyArray<ReturnType<typeof checkpointFileOf>>,
    ) => {
      sliceFiles.set(key, files);
      for (const oldest of sliceFiles.keys()) {
        if (sliceFiles.size <= SLICE_FILES_KEPT) break;
        sliceFiles.delete(oldest);
      }
    };

    /**
     * Whether another session works in this session's worktree, as the person reads the project:
     * one whose checkpoints failed adds to the chain's checkpoints all the same.
     */
    const othersInWorktree = (sessionId: string): boolean => {
      for (const entry of projects.values()) {
        const session = entry.sessions.find((candidate) => candidate.id === sessionId);
        if (session === undefined) continue;
        return entry.sessions.some(
          (candidate) => candidate.id !== sessionId && candidate.worktreeId === session.worktreeId,
        );
      }
      return false;
    };

    /** A watched thread's turns, each with the checkpoint Mend took when it ended. */
    const turnCheckpointsOf = (sessionId: string, turns: ReadonlyArray<MendTurn>) => {
      const chain = watches.get(sessionId)?.chain ?? null;
      if (chain === null) return { turnCheckpoints: NO_TURN_CHECKPOINTS, sharedWorktree: false };
      const turnCheckpoints = new Map<string, TurnCheckpoint>();
      for (const [turnId, slice] of turnSlicesOf(sessionId, turns, chain)) {
        const files = sliceFiles.get(sliceKey(slice));
        if (files === undefined) continue;
        turnCheckpoints.set(turnId, {
          id: slice.to.id,
          ref: slice.to.ref,
          capturedAt: slice.to.createdAt,
          files,
        });
      }
      return {
        turnCheckpoints,
        sharedWorktree: isSharedChain(sessionId, chain) || othersInWorktree(sessionId),
      };
    };

    const itemsOf = (sessionId: string): ReadonlyArray<MendItem> =>
      Array.from(watches.get(sessionId)?.items.values() ?? []);

    const workspaceMutationOf = (worktreeId: string): string | null => {
      const marks: Array<string> = [];
      for (const source of threadSources()) {
        if (source.session.worktreeId !== worktreeId) continue;
        let latest: MendItem | null = null;
        for (const item of itemsOf(source.session.id)) {
          if (item.kind !== "file-change" && item.kind !== "command-execution") continue;
          if (item.status === "in-progress") continue;
          if (latest === null || item.seq > latest.seq) latest = item;
        }
        if (latest !== null) marks.push(`${latest.id}@${latest.seq}`);
      }
      return marks.length === 0 ? null : marks.join(",");
    };

    // ─── Publishing ────────────────────────────────────────────────────────

    /** Diffs the shell against what was last sent and publishes the changes, sequenced. */
    const publishShell = Effect.gen(function* () {
      const deltas: Array<ShellDelta> = [];
      /** Each delta's encoded size, for the replay log's budget. */
      const sizes: Array<number> = [];
      const nextProjects = new Map<string, Printed<OrchestrationProjectShell>>();
      for (const entry of projects.values()) {
        const value = projectShellOf(
          entry.project,
          projectScripts.get(entry.project.id) ?? [],
          keeper?.id ?? "",
        );
        const print = printProject(value);
        if (print instanceof Error) {
          yield* Effect.logError("t3 gateway could not encode a project", {
            projectId: entry.project.id,
            cause: print.message,
          });
          continue;
        }
        nextProjects.set(value.id, { value, print });
      }
      const nextThreads = new Map<string, Printed<OrchestrationV2ThreadShell>>();
      const nextArchived = new Map<string, Printed<OrchestrationV2ThreadShell>>();
      for (const source of threadSources()) {
        const value = threadShellOf(source, {
          itemCount: source.turns.length,
          visibleItemCount: source.turns.length,
        });
        const print = printThreadShell(value);
        if (print instanceof Error) {
          yield* Effect.logError("t3 gateway could not encode a thread", {
            sessionId: source.session.id,
            cause: print.message,
          });
          continue;
        }
        // An archived thread leaves the active shell for the archived one, as in t3code.
        (source.archivedAt === null ? nextThreads : nextArchived).set(value.id, { value, print });
      }

      const archivedDeltas: Array<ArchivedShellDelta> = [];
      for (const [id, next] of nextArchived) {
        if (shellArchived.get(id)?.print === next.print) continue;
        archivedDeltas.push({
          kind: "thread.updated",
          sequence: nextSequence(),
          thread: next.value,
        });
      }
      for (const [id, previous] of shellArchived) {
        if (nextArchived.has(id)) continue;
        archivedDeltas.push({
          kind: "thread.removed",
          sequence: nextSequence(),
          threadId: previous.value.id,
        });
      }
      shellArchived = nextArchived;
      if (archivedDeltas.length > 0) yield* archivedChanges.publish(archivedDeltas);

      for (const [id, next] of nextProjects) {
        if (shellProjects.get(id)?.print === next.print) continue;
        deltas.push({ kind: "project.updated", sequence: nextSequence(), project: next.value });
        sizes.push(replayBytes(next.print));
      }
      for (const [id, next] of nextThreads) {
        if (shellThreads.get(id)?.print === next.print) continue;
        deltas.push({
          kind: "thread.updated",
          sequence: nextSequence(),
          location: "active",
          thread: next.value,
        });
        sizes.push(replayBytes(next.print));
      }
      for (const [id, previous] of shellThreads) {
        if (nextThreads.has(id)) continue;
        deltas.push({
          kind: "thread.removed",
          sequence: nextSequence(),
          location: "active",
          threadId: previous.value.id,
        });
        sizes.push(REMOVAL_BYTES);
      }
      for (const [id, previous] of shellProjects) {
        if (nextProjects.has(id)) continue;
        deltas.push({
          kind: "project.removed",
          sequence: nextSequence(),
          projectId: previous.value.id,
        });
        sizes.push(REMOVAL_BYTES);
      }
      shellProjects = nextProjects;
      shellThreads = nextThreads;
      deltas.forEach((delta, index) => shellLog.push(delta.sequence, delta, sizes[index] ?? 0));
      if (deltas.length > 0) yield* shellChanges.publish(deltas);
    });

    const currentArchivedShell = (): OrchestrationV2ArchivedShellSnapshot => ({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      snapshotSequence: sequence,
      projects: Array.from(shellProjects.values(), (printed) => printed.value),
      threads: Array.from(shellArchived.values(), (printed) => printed.value),
    });

    const currentShell = (): OrchestrationV2ShellSnapshot => ({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      snapshotSequence: sequence,
      projects: Array.from(shellProjects.values(), (printed) => printed.value),
      threads: Array.from(shellThreads.values(), (printed) => printed.value),
      archivedThreads: [],
    });

    const eventBase = (occurredAt: DateTime.Utc) => ({
      id: EventId.make(`event:${nextSequence()}`),
      occurredAt,
    });

    /**
     * Diffs one watched thread against what was last sent and publishes its changes, sequenced.
     * The first time, nothing has been sent: what is built is the baseline the first subscriber's
     * snapshot shows. Returns the thread as it stands, or null once it is gone.
     */
    const publishThread = (sessionId: string) =>
      Effect.gen(function* () {
        const watch = watches.get(sessionId);
        /** Publishes the thread's changes, and keeps them for a client that resumes. */
        const publish = (changes: ReadonlyArray<readonly [ThreadChange, number]>) => {
          for (const [change, bytes] of changes) {
            watch?.log?.push(
              change.kind === "event" ? change.sequence : change.snapshotSequence,
              change,
              bytes,
            );
          }
          return threadChanges.publish(
            changes.map(([change]) => ({ threadId: sessionId, change })),
          );
        };
        const source = sourceOf(sessionId);
        if (source === null) {
          if (watch?.prints !== null && watch?.thread !== null && watch !== undefined) {
            const base = eventBase(yield* DateTime.now);
            const thread = watch.thread;
            yield* publish([
              [
                {
                  kind: "event",
                  sequence,
                  event: {
                    ...base,
                    threadId: thread.id,
                    type: "thread.deleted",
                    payload: { ...thread, deletedAt: base.occurredAt },
                  },
                },
                REMOVAL_BYTES,
              ],
            ]);
            watch.prints = null;
            watch.thread = null;
            watch.log = null;
          }
          return null;
        }
        const built = yield* printProjection(threadProjectionOf(source, itemsOf(sessionId)));
        const occurredAt = yield* DateTime.now;
        if (watch === undefined) return built.projection;
        const previous = watch.prints;
        const prints = new Map(built.entities.map((entity) => [entity.key, entity.print]));
        watch.prints = prints;
        watch.thread = built.projection.thread;
        // The baseline a first subscriber's snapshot shows: what follows it is kept for replay.
        if (previous === null) {
          watch.log = sequencer.owns(sequence)
            ? makeReplayLog(THREAD_REPLAY_LIMITS, sequence)
            : null;
          return built.projection;
        }

        // Something the client holds went away: a fresh snapshot replaces it.
        if (Array.from(previous.keys()).some((key) => !prints.has(key))) {
          yield* publish([
            [
              { kind: "snapshot", snapshotSequence: nextSequence(), projection: built.projection },
              built.entities.reduce((total, entity) => total + replayBytes(entity.print), 0),
            ],
          ]);
          return built.projection;
        }
        const changes: Array<readonly [ThreadChange, number]> = [];
        for (const entity of built.entities) {
          if (previous.get(entity.key) === entity.print) continue;
          const base = eventBase(occurredAt);
          changes.push([
            {
              kind: "event",
              sequence,
              event: entity.event({ ...base, threadId: built.projection.thread.id }),
            },
            replayBytes(entity.print),
          ]);
        }
        if (changes.length > 0) yield* publish(changes);
        return built.projection;
      });

    /** Every watched thread, after a read that may have moved any of them. */
    const publishThreads = Effect.suspend(() =>
      Effect.forEach(Array.from(watches.keys()), publishThread, { discard: true }),
    );

    /** Session id → its quiet work, for a thread the sweep would settle but for that work. */
    const quietWork = new Map<string, QuietWork>();
    /** Threads whose work Mend did not answer for: they wait for the sweep's timer to ask again. */
    const quietWorkUnread = new Set<string>();
    let readingQuietWork = false;

    /**
     * Settles each quiet thread whose work is read and done; a thread whose work is not read yet
     * waits for `readQuietWork`, which this starts.
     */
    const autoSettle: Effect.Effect<boolean> = Effect.gen(function* () {
      if (keeper === null) return false;
      const now = yield* DateTime.nowAsDate;
      let settled = false;
      let unread = false;
      for (const source of threadSources()) {
        const sessionId = source.session.id;
        const shell = settleableShellOf(source, now.getTime());
        if (shell === null) continue;
        const work = quietWork.get(sessionId);
        if (work === undefined || !isCurrent(work, shell)) {
          unread ||= !quietWorkUnread.has(sessionId);
          continue;
        }
        const settledAt = autoSettledAt(
          {
            ...shell,
            pendingBackgroundTasks: [
              ...(shell.pendingBackgroundTasks ?? []),
              ...backgroundWorkOf(source, Array.from(work.open.values())),
            ],
          },
          now.getTime(),
        );
        if (settledAt === null) continue;
        const result = changeLifecycle(source, { kind: "auto-settle", settledAt }, now);
        if (result._tag === "Refused") continue;
        const kept = yield* state.setLifecycle(keeper.id, sessionId, result.lifecycle).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("t3 gateway could not keep a thread it settled on its own", {
              cause: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!kept) continue;
        lifecycles.set(sessionId, result.lifecycle);
        quietWork.delete(sessionId);
        settled = true;
      }
      if (unread && !readingQuietWork) {
        yield* Effect.forkIn(readQuietWork({ onTimer: false }), hubScope);
      }
      return settled;
    });

    /**
     * What `readQuietWork` reads, each from its cursor: a thread never read or read before its
     * latest turn, and, on the timer, one whose work was still in progress.
     */
    const quietWorkDue = (nowMs: number, onTimer: boolean) => {
      if (onTimer) quietWorkUnread.clear();
      const due: Array<{ readonly sessionId: string; readonly after: number }> = [];
      const settleable = new Set<string>();
      for (const source of threadSources()) {
        const sessionId = source.session.id;
        const shell = settleableShellOf(source, nowMs);
        if (shell === null) continue;
        settleable.add(sessionId);
        const work = quietWork.get(sessionId);
        if (work === undefined) {
          if (!quietWorkUnread.has(sessionId)) due.push({ sessionId, after: 0 });
        } else if (!isCurrent(work, shell) || (onTimer && work.open.size > 0)) {
          due.push({ sessionId, after: work.cursor });
        }
      }
      if (onTimer) {
        for (const sessionId of quietWork.keys()) {
          if (!settleable.has(sessionId)) quietWork.delete(sessionId);
        }
      }
      return due;
    };

    /**
     * Reads the quiet threads' work from Mend and settles each whose work is done, round after
     * round while a thread came due during the last.
     */
    const readQuietWork = (options: { readonly onTimer: boolean }): Effect.Effect<void> => {
      const round = (onTimer: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const readAt = yield* Clock.currentTimeMillis;
          const due = yield* locked(Effect.sync(() => quietWorkDue(readAt, onTimer)));
          if (due.length === 0 && !onTimer) return;
          const reads = yield* Effect.forEach(
            due,
            ({ sessionId, after }) =>
              readItemsAfter(sessionId, after).pipe(
                Effect.map((items) => ({ sessionId, after, items })),
                Effect.catch((error) =>
                  Effect.logWarning("t3 gateway could not read a quiet thread's work", {
                    sessionId,
                    cause: error.message,
                  }).pipe(Effect.as({ sessionId, after, items: null })),
                ),
              ),
            { concurrency: QUIET_WORK_READS },
          );
          yield* locked(
            Effect.gen(function* () {
              for (const { sessionId, after, items } of reads) {
                if (items === null) {
                  quietWorkUnread.add(sessionId);
                  continue;
                }
                const work: QuietWork | undefined =
                  after === 0
                    ? { cursor: 0, open: new Map<string, MendItem>(), readAt }
                    : quietWork.get(sessionId);
                if (work === undefined) continue;
                for (const item of items.toSorted((left, right) => left.seq - right.seq)) {
                  work.cursor = Math.max(work.cursor, item.seq);
                  if (item.status === "in-progress") work.open.set(item.id, item);
                  else work.open.delete(item.id);
                }
                work.readAt = readAt;
                quietWork.set(sessionId, work);
              }
              if (yield* autoSettle) yield* publishAll;
            }),
          );
          if (due.length > 0) yield* round(false);
        });
      return Effect.suspend(() => {
        if (readingQuietWork) return Effect.void;
        readingQuietWork = true;
        return round(options.onTimer).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              readingQuietWork = false;
            }),
          ),
        );
      });
    };

    /** Moves every queue on after a read (set below, once the queue's machinery exists). */
    let settleQueues: Effect.Effect<void> = Effect.void;
    /** Whether a message the gateway accepted can still reach Mend: what holds the hub alive. */
    let busy = false;
    const holdWhileBusy = Effect.suspend(() => {
      const now = !dead && Queueing.anyProgress(queues.values());
      if (now === busy) return Effect.void;
      busy = now;
      return retain(now);
    });
    const publishAll = Effect.suspend(() => settleQueues).pipe(
      Effect.andThen(settleNextModes),
      Effect.andThen(settleNextEfforts),
      Effect.andThen(settleNextModels),
      Effect.andThen(settleLifecycles),
      Effect.andThen(autoSettle),
      Effect.andThen(keepQueues),
      Effect.andThen(publishShell),
      Effect.andThen(publishThreads),
      Effect.andThen(extendSequences),
      Effect.andThen(holdWhileBusy),
    );

    // ─── Reading Mend ──────────────────────────────────────────────────────

    /** Every item whose change-feed cursor is past `after`, page by page. */
    const readItemsAfter = (sessionId: string, after: number) =>
      Effect.gen(function* () {
        const read: Array<MendItem> = [];
        let cursor = after;
        for (;;) {
          const page = yield* asPerson((token) =>
            mend.listItems(token, sessionId, cursor, ITEM_PAGE),
          );
          read.push(...page);
          if (page.length < ITEM_PAGE) return read;
          cursor = page.reduce((highest, item) => Math.max(highest, item.seq), cursor);
        }
      }).pipe(
        Effect.catchTag(
          "MendNotFound",
          (): Effect.Effect<ReadonlyArray<MendItem>> => Effect.succeed([]),
        ),
      );

    /**
     * What holds the session's next turn; read only while `readsWaiting` (someone live in its
     * executor, control shared), null otherwise without asking Mend.
     */
    const readWait = (sessionId: string, facts: ReadonlyMap<string, MendActiveSession>) =>
      readsWaiting(facts.get(sessionId))
        ? optionalRead(asPerson((token) => mend.conversationWait(token, sessionId)))
        : Effect.succeed(null);

    const readConversation = (sessionId: string, facts: ReadonlyMap<string, MendActiveSession>) =>
      Effect.all(
        {
          turns: asPerson((token) => mend.listTurns(token, sessionId)),
          requests: asPerson((token) => mend.listRequests(token, sessionId)),
          wait: readWait(sessionId, facts),
        },
        { concurrency: 3 },
      ).pipe(
        Effect.map((conversation): Conversation | null => conversation),
        // The session went between the list and this read; the next project read drops it.
        Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
      );

    const readConversations = (
      sessionIds: ReadonlyArray<string>,
      facts: ReadonlyMap<string, MendActiveSession>,
    ) =>
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          readConversation(sessionId, facts).pipe(
            Effect.map((conversation) => [sessionId, conversation] as const),
          ),
        { concurrency: 4 },
      );

    /**
     * Each live session's row (`GET /api/sessions`): who is live in its executor, whether control
     * is shared, whether its executor waits to be replaced. Null when Mend did not say.
     */
    const readActive = optionalRead(asPerson((token) => mend.listActiveSessions(token))).pipe(
      Effect.map((sessions) =>
        sessions === null
          ? null
          : new Map(sessions.map((session) => [session.id, session] as const)),
      ),
    );

    /**
     * The retirement of each watched thread among `sessionIds`: read only where its row says one is
     * under way (`readsRetirement`), null elsewhere without asking Mend; undefined where Mend did
     * not say.
     */
    const readRetirements = (
      sessionIds: ReadonlyArray<string>,
      facts: ReadonlyMap<string, MendActiveSession>,
    ) =>
      Effect.forEach(
        sessionIds.filter((sessionId) => watches.has(sessionId)),
        (sessionId) =>
          (readsRetirement(facts.get(sessionId))
            ? asPerson((token) => mend.workspaceRetirement(token, sessionId)).pipe(
                Effect.map((retirement): MendWorkspaceRetirement | null | undefined => retirement),
                Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
                Effect.catchTag("MendUnavailable", () => Effect.succeed(undefined)),
              )
            : Effect.succeed(null)
          ).pipe(Effect.map((retirement) => [sessionId, retirement] as const)),
        { concurrency: 4 },
      );

    const applyRetirements = (
      read: ReadonlyArray<readonly [string, MendWorkspaceRetirement | null | undefined]>,
    ) => {
      for (const [sessionId, retirement] of read) {
        if (retirement !== undefined) retirements.set(sessionId, retirement);
      }
      for (const sessionId of retirements.keys()) {
        if (!watches.has(sessionId)) retirements.delete(sessionId);
      }
    };

    /** Everything again: every project the person sees, and every thread's turns and requests. */
    const refreshAll: Effect.Effect<void, HubReadError> = Effect.gen(function* () {
      const listed = yield* asPerson((token) => mend.listProjects(token)).pipe(
        Effect.catchTag(
          "MendNotFound",
          (): Effect.Effect<ReadonlyArray<MendProject>> => Effect.succeed([]),
        ),
      );
      const [details, people] = yield* Effect.all(
        [
          Effect.forEach(
            listed,
            (project) =>
              asPerson((token) => mend.projectDetail(token, project.id)).pipe(
                Effect.map(entryOf),
                Effect.catchTag("MendNotFound", (_: MendNotFound) => Effect.succeed(null)),
              ),
            { concurrency: 4 },
          ),
          readActive,
        ],
        { concurrency: 2 },
      );
      const facts = people ?? active;
      const entries = details.filter(
        (entry): entry is ProjectEntry => entry !== null && !removedProjects.has(entry.project.id),
      );
      const sessionIds = entries.flatMap((entry) => projectableSessionIds(entry, launched));
      const [read, retired] = yield* Effect.all(
        [readConversations(sessionIds, facts), readRetirements(sessionIds, facts)],
        { concurrency: 2 },
      );
      // A watched thread's items that moved while pointers could be missed (a reconnect).
      const caughtUp = yield* Effect.forEach(
        Array.from(watches, ([sessionId, watch]) => [sessionId, watch.cursor] as const),
        ([sessionId, cursor]) =>
          readItemsAfter(sessionId, cursor).pipe(
            Effect.map((items) => [sessionId, items] as const),
          ),
        { concurrency: 4 },
      );
      yield* locked(
        Effect.gen(function* () {
          projects.clear();
          for (const entry of entries) projects.set(entry.project.id, entry);
          const present = new Set(entries.flatMap((entry) => entry.sessions.map((s) => s.id)));
          seen(present);
          const finished = Array.from(removing).filter((sessionId) => !present.has(sessionId));
          for (const sessionId of finished) removing.delete(sessionId);
          yield* removed(finished);
          active = facts;
          applyRetirements(retired);
          conversations.clear();
          for (const [sessionId, conversation] of read) {
            if (conversation !== null) {
              conversations.set(sessionId, withAdopted(sessionId, conversation));
            }
          }
          for (const [sessionId, items] of caughtUp) {
            const watch = watches.get(sessionId);
            if (watch !== undefined) mergeItems(watch, items);
          }
          for (const entry of entries) {
            for (const session of entry.sessions) sawSession(session.id);
          }
          yield* publishAll;
        }),
      );
    });

    /** One project again, and the turns of any thread that is new in it. */
    /**
     * `applied` runs with what was read, under the lock and before anything is published: a
     * launched thread's opening message joins its queue in the same publication as its session.
     */
    const refreshProject = (
      projectId: string,
      applied: () => void = () => {},
    ): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        // A process starting or ending re-reads the project: who is live in each executor with it.
        const [entry, people] = yield* Effect.all(
          [
            asPerson((token) => mend.projectDetail(token, projectId)).pipe(
              Effect.map(entryOf),
              Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
            ),
            readActive,
          ],
          { concurrency: 2 },
        );
        const facts = people ?? active;
        const sessionIds = entry === null ? [] : projectableSessionIds(entry, launched);
        const fresh = sessionIds.filter((sessionId) => !conversations.has(sessionId));
        // A thread already read whose owner just shared control with someone live: its waiting
        // line, now worth reading (later ones come with its conversation's pointers).
        const waitStarts = sessionIds.filter(
          (sessionId) =>
            conversations.has(sessionId) &&
            readsWaiting(facts.get(sessionId)) &&
            !readsWaiting(active.get(sessionId)),
        );
        const [read, retired, waits] = yield* Effect.all(
          [
            readConversations(fresh, facts),
            readRetirements(sessionIds, facts),
            Effect.forEach(
              waitStarts,
              (sessionId) =>
                readWait(sessionId, facts).pipe(Effect.map((wait) => [sessionId, wait] as const)),
              { concurrency: 4 },
            ),
          ],
          { concurrency: 3 },
        );
        yield* locked(
          Effect.gen(function* () {
            if (removedProjects.has(projectId)) return;
            const previous = projects.get(projectId);
            if (entry === null) {
              projects.delete(projectId);
            } else {
              projects.set(projectId, entry);
              seen(entry.sessions.map((session) => session.id));
            }
            const kept = new Set(entry?.sessions.map((session) => session.id) ?? []);
            const finished: Array<string> = [];
            for (const session of previous?.sessions ?? []) {
              if (kept.has(session.id)) continue;
              conversations.delete(session.id);
              adoptedTurns.delete(session.id);
              if (removing.delete(session.id)) finished.push(session.id);
            }
            yield* removed(finished);
            for (const [sessionId, conversation] of read) {
              if (conversation !== null) {
                conversations.set(sessionId, withAdopted(sessionId, conversation));
              }
            }
            for (const [sessionId, wait] of waits) {
              const conversation = conversations.get(sessionId);
              if (conversation !== undefined)
                conversations.set(sessionId, { ...conversation, wait });
            }
            // Control no longer shared, or nobody live: no turn waits, and the line goes.
            for (const sessionId of sessionIds) {
              const conversation = conversations.get(sessionId);
              if (
                conversation !== undefined &&
                conversation.wait !== null &&
                !readsWaiting(facts.get(sessionId))
              ) {
                conversations.set(sessionId, { ...conversation, wait: null });
              }
            }
            active = facts;
            applyRetirements(retired);
            for (const session of entry?.sessions ?? []) sawSession(session.id);
            applied();
            yield* publishAll;
          }),
        );
        // A checkpoint landing moves the project, not the conversation: a watched thread waiting
        // for one reads its chain again (`readTurnCheckpoints` reads only when one is due).
        yield* Effect.forEach(
          (entry?.sessions ?? []).filter((session) => watches.has(session.id)),
          (session) => Effect.forkIn(readTurnCheckpoints(session.id), hubScope),
          { discard: true },
        );
      });

    const isKnownThread = (sessionId: string): boolean => {
      for (const entry of projects.values()) {
        if (projectableSessionIds(entry, launched).includes(sessionId)) return true;
      }
      return false;
    };

    /** One thread's turns and requests again, and its new items while someone watches it. */
    const refreshConversation = (sessionId: string): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        // A session that is not a thread yet becomes one through its project's read.
        if (!isKnownThread(sessionId)) return;
        const watch = watches.get(sessionId);
        const [conversation, items] = yield* Effect.all(
          [
            readConversation(sessionId, active),
            watch === undefined ? Effect.succeed([]) : readItemsAfter(sessionId, watch.cursor),
          ],
          { concurrency: 2 },
        );
        yield* locked(
          Effect.gen(function* () {
            if (conversation === null) {
              conversations.delete(sessionId);
              adoptedTurns.delete(sessionId);
            } else if (isKnownThread(sessionId)) {
              conversations.set(sessionId, withAdopted(sessionId, conversation));
            }
            const current = watches.get(sessionId);
            if (current !== undefined) mergeItems(current, items);
            sawSession(sessionId);
            yield* publishAll;
          }),
        );
        if (watch !== undefined) yield* Effect.forkIn(readTurnCheckpoints(sessionId), hubScope);
      });

    /**
     * A watched thread's checkpoint chain, read when it opens and again whenever another of its
     * turns ended, and the files of each new turn's slice (at most the last `TURN_SLICES_READ`
     * turns), one read each. In the background: a thread never waits for it to open.
     */
    const readTurnCheckpoints = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const plan = yield* locked(
          Effect.map(Clock.currentTimeMillis, (now) => {
            const watch = watches.get(sessionId);
            const source = sourceOf(sessionId);
            if (watch === undefined || source === null) return null;
            const ended = source.turns.filter((turn) => turn.endedAt !== null).length;
            // Mend tells of a turn's end before it takes the turn's checkpoint: a chain read in
            // between lacks it, so a turn that ended lately with no checkpoint reads it again.
            if (ended !== watch.endedTurns) watch.chainRetries = 0;
            const missing =
              watch.chain !== null &&
              watch.chainRetries < CHAIN_REREADS &&
              awaitsCheckpoint(sessionId, source.turns, watch.chain);
            const waiting = missing && now - watch.chainReadAt >= CHAIN_REREAD_MS;
            if (missing && !waiting && !watch.chainRecheck) {
              // Too soon after the last read: once more when it is old enough.
              watch.chainRecheck = true;
              return { kind: "later" as const };
            }
            if (watch.chain !== null && ended === watch.endedTurns && !waiting) return null;
            if (waiting) watch.chainRetries += 1;
            watch.endedTurns = ended;
            watch.chainReadAt = now;
            return {
              kind: "now" as const,
              worktreeId: source.session.worktreeId,
              turns: source.turns,
            };
          }),
        );
        if (plan === null) return;
        if (plan.kind === "later") {
          return yield* Effect.forkIn(
            Effect.sleep(CHAIN_REREAD_MS).pipe(
              Effect.andThen(
                locked(
                  Effect.sync(() => {
                    const watch = watches.get(sessionId);
                    if (watch !== undefined) watch.chainRecheck = false;
                  }),
                ),
              ),
              Effect.andThen(Effect.suspend(() => readTurnCheckpoints(sessionId))),
            ),
            hubScope,
          ).pipe(Effect.asVoid);
        }
        const chain = yield* asPerson((token) =>
          mend.worktreeCheckpoints(token, plan.worktreeId),
        ).pipe(Effect.catchTag("MendNotFound", () => Effect.succeed([])));
        const wanted = Array.from(turnSlicesOf(sessionId, plan.turns, chain).values())
          .slice(-TURN_SLICES_READ)
          .filter((slice) => !sliceFiles.has(sliceKey(slice)));
        yield* Effect.forEach(
          wanted,
          (slice: TurnSlice) =>
            asPerson((token) =>
              mend.worktreeDiff(token, plan.worktreeId, {
                from: slice.from?.id ?? null,
                to: slice.to.id,
                ignoreWhitespace: false,
              }),
            ).pipe(
              Effect.map((range) =>
                keepSliceFiles(sliceKey(slice), range.files.map(checkpointFileOf)),
              ),
              // A Mend without the slice read shows no per-turn cards.
              Effect.catchTag("MendNotFound", () => Effect.void),
            ),
          { concurrency: 2, discard: true },
        );
        yield* locked(
          Effect.gen(function* () {
            const watch = watches.get(sessionId);
            if (watch !== undefined) watch.chain = chain;
            yield* publishThread(sessionId);
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("t3 gateway could not read a thread's checkpoints", {
            cause: error.message,
          }),
        ),
      );

    let loaded = false;
    /** Refreshes asked for before the first full read finished: run once it has. */
    const deferredKeys = new Set<string>();
    /** The first full read is done: what arrived during it is read again. */
    const markLoaded = Effect.suspend(() => {
      const first = !loaded;
      loaded = true;
      const keys = Array.from(deferredKeys);
      deferredKeys.clear();
      return Effect.forEach(keys, (key) => requestRefresh(key), { discard: true }).pipe(
        // A queue kept across a restart waited for this read: it moves now.
        Effect.andThen(first && queues.size > 0 ? locked(publishAll) : Effect.void),
      );
    });
    const loadLock = Semaphore.makeUnsafe(1);
    /** The first full read, made once by whoever needs it first; a failure is theirs to see. */
    const ensureLoaded = loadLock.withPermits(1)(
      Effect.suspend(() =>
        dead
          ? Effect.fail(new MendDeviceRefused({ operation: "every paired device" }))
          : loaded
            ? Effect.void
            : refreshAll.pipe(Effect.tap(() => markLoaded)),
      ),
    );

    // ─── Refreshing ────────────────────────────────────────────────────────

    /**
     * Every device token of the person, checked against Mend: one it refuses (revoked) ends its
     * sockets, even while the hub reads with another device's token.
     */
    const checkDevices = Effect.suspend(() =>
      Effect.forEach(
        tokens.live(),
        (token) =>
          mend.checkDevice(token).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not check a device with Mend", {
                cause: error.message,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      ),
    );

    /** Pending refreshes, each queued once: a burst of pointers for one key is one read. */
    const pendingKeys = new Set<string>();
    const keys = yield* Queue.unbounded<string>();
    const requestRefresh = (key: string) =>
      Effect.suspend(() => {
        if (pendingKeys.has(key)) return Effect.void;
        pendingKeys.add(key);
        return Queue.offer(keys, key).pipe(Effect.asVoid);
      });

    const refreshOf = (key: string): Effect.Effect<void, HubReadError> => {
      if (key === "all") {
        return loadLock.withPermits(1)(refreshAll.pipe(Effect.tap(() => markLoaded)));
      }
      if (key.startsWith("project:")) return refreshProject(key.slice("project:".length));
      if (key.startsWith("conversation:")) {
        return refreshConversation(key.slice("conversation:".length));
      }
      if (key === "devices") return checkDevices;
      return Effect.void;
    };

    const worker = yield* Effect.forever(
      Queue.take(keys).pipe(
        Effect.flatMap((key) =>
          Effect.suspend(() => {
            pendingKeys.delete(key);
            // Before the first full read ends, a pointer may concern what it already read: keep
            // it for after. Device checks need nothing loaded.
            if (!loaded && key !== "devices") {
              deferredKeys.add(key);
              return Effect.void;
            }
            return refreshOf(key).pipe(
              Effect.catch((error) =>
                Effect.logWarning("t3 gateway could not refresh from Mend", {
                  key,
                  cause: error.message,
                }).pipe(
                  // Mend coming back after a restart answers 502 for a while; the event stream
                  // may reconnect before the full read succeeds, so that read is tried again.
                  Effect.andThen(
                    key === "all"
                      ? Effect.sleep(FULL_READ_RETRY).pipe(
                          Effect.andThen(requestRefresh("all")),
                          Effect.forkScoped,
                          Effect.asVoid,
                        )
                      : Effect.void,
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);

    // ─── Mend's SSE ────────────────────────────────────────────────────────

    const onPointer = (pointer: MendEventPointer) => {
      if (pointer.type === "user" && pointer.facet === "accounts") {
        return providerSignals.publish(["accounts"]);
      }
      const key = refreshKeyOf(pointer);
      return key === null ? Effect.void : requestRefresh(key);
    };

    const sse = yield* Effect.gen(function* () {
      let failures = 0;
      for (let attempt = 0; ; attempt++) {
        // A reconnect may have missed pointers: read everything again, the logins too.
        if (attempt > 0) {
          yield* requestRefresh("all");
          yield* providerSignals.publish(["accounts"]);
        }
        const startedAt = yield* Clock.currentTimeMillis;
        const outcome = yield* asPerson((token) =>
          mend.events(token).pipe(Stream.runForEach(onPointer)),
        ).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning("t3 gateway lost Mend's event stream", {
            cause: outcome.failure.message,
          });
        }
        const endedAt = yield* Clock.currentTimeMillis;
        failures = endedAt - startedAt > HEALTHY_STREAM_MS ? 0 : failures + 1;
        yield* Effect.sleep(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** failures));
      }
    }).pipe(Effect.forkScoped);

    const deviceChecks = yield* requestRefresh("devices").pipe(
      Effect.delay(DEVICE_CHECK_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );

    // ─── Teardown ──────────────────────────────────────────────────────────

    /** What else must end with the hub (set by later parts: the queue). */
    let onTeardown: Effect.Effect<void> = Effect.void;
    /**
     * Every device of the person was revoked: Mend keeps the event stream open (it closes it only
     * when the account goes), so the hub stops it itself, stops reading, and lets go of itself.
     */
    const teardown = Effect.gen(function* () {
      dead = true;
      yield* Fiber.interruptAll([sse, worker, deviceChecks]);
      yield* Effect.suspend(() => onTeardown);
      yield* input.dispose ?? Effect.void;
    });
    yield* tokens.noneLeft.pipe(Effect.andThen(teardown), Effect.forkScoped);
    // ─── The queue ─────────────────────────────────────────────────────────

    const queueOf = (sessionId: string): Queueing.ThreadQueue => {
      const existing = queues.get(sessionId);
      if (existing !== undefined) return existing;
      const created = Queueing.emptyQueue();
      queues.set(sessionId, created);
      return created;
    };

    /** What Mend says of the session now, for the queue's rules (`queue.ts`). */
    const viewOf = (sessionId: string): Queueing.SessionView => {
      const source = sourceOf(sessionId);
      if (source === null) {
        return {
          known: false,
          agentLive: false,
          turnOpen: false,
          status: null,
          updatedAt: null,
          summary: null,
          evidence: evidence.get(sessionId) ?? 0,
        };
      }
      const turns = conversations.get(sessionId)?.turns ?? [];
      return {
        known: true,
        agentLive: source.agent.exitedAt === null && source.agent.status === "running",
        turnOpen: turns.some((turn) => turn.status === "queued" || turn.status === "running"),
        status: source.session.status,
        updatedAt: source.session.updatedAt,
        summary: source.session.summary ?? null,
        evidence: evidence.get(sessionId) ?? 0,
      };
    };

    /** The message is its Mend turn, by the id `POST /turns` answered; it keeps the client's ids. */
    const adopt = (sessionId: string, entry: Queueing.QueueEntry, turn: MendTurn) =>
      Effect.gen(function* () {
        const ids: TurnIds = {
          sessionId,
          turnId: turn.id,
          runId: entry.runId,
          messageId: entry.messageId,
        };
        rememberIds(ids);
        // The ids first: until they are kept, the message stays kept as being sent (593-R2-2).
        const recorded = yield* state.recordTurnIds(ids, yield* Clock.currentTimeMillis).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("t3 gateway could not record a turn's ids", {
              cause: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!recorded && keeper !== null) {
          const [stored] = Queueing.storedOf({
            held: false,
            preparation: null,
            entries: [entry],
          }).entries;
          if (stored !== undefined) {
            const waiting = unrecorded.get(sessionId) ?? [];
            waiting.push({ stored: { ...stored, state: "sending" }, ids });
            unrecorded.set(sessionId, waiting);
          }
        }
        Queueing.adopted(queueOf(sessionId), entry);
        const conversation = conversations.get(sessionId) ?? EMPTY_CONVERSATION;
        if (!conversation.turns.some((known) => known.id === turn.id)) {
          conversations.set(sessionId, { ...conversation, turns: [...conversation.turns, turn] });
          // Kept until a read shows it: a read from before Mend took it may still land.
          const adopted = adoptedTurns.get(sessionId) ?? new Map<string, MendTurn>();
          adopted.set(turn.id, turn);
          adoptedTurns.set(sessionId, adopted);
        }
        // Taken back while it was being sent: its own turn, by id, is interrupted.
        if (entry.takenBack) {
          yield* Effect.forkIn(
            mend.interruptTurn(entry.token, turn.id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("t3 gateway could not interrupt a taken-back turn", {
                  cause: error.message,
                }),
              ),
            ),
            hubScope,
          );
        }
      });

    const workspaceSkills = new Map<string, WorkspaceSkills>();

    const deliveredSkillsOf = (deviceToken: string, project: MendProject) =>
      Effect.all(
        [
          project.inheritUserSkills === false ? Effect.succeed([]) : mend.listSkills(deviceToken),
          mend.projectSkills(deviceToken, project.id),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([user, ofProject]) => deliveredSkills(user, ofProject)));

    const invocationOf = (sessionId: string, entry: Queueing.QueueEntry) =>
      Effect.gen(function* () {
        const source = sourceOf(sessionId);
        if (source === null || !mentionsSkill(entry.text)) return entry.text;
        const harness = source.session.harness;
        if (harness !== "claude") return skillInvocationOf(harness, entry.text, new Set());
        const skills = yield* deliveredSkillsOf(entry.token, source.project).pipe(
          Effect.catch((error) =>
            Effect.logWarning("t3 gateway could not read the skills a message names", {
              cause: error.message,
            }).pipe(Effect.as([])),
          ),
        );
        return skillInvocationOf(harness, entry.text, new Set(skills.map((skill) => skill.name)));
      });

    /**
     * The message's images placed in the session's workspace (`POST /api/sessions/:id/images`).
     * A placement holds for the session and the agent it was made for: a retry after "not live"
     * places only what is not placed yet, and a new agent, whose workspace may be another, gets
     * each image placed again.
     */
    const placeImages = (sessionId: string, entry: Queueing.QueueEntry) =>
      Effect.forEach(
        entry.imageIds,
        (imageId) =>
          Effect.gen(function* () {
            const processId = sourceOf(sessionId)?.agent.id ?? null;
            const known = images.get(imageId);
            const placement = known?.placement ?? null;
            if (
              known !== undefined &&
              placement !== null &&
              placement.sessionId === sessionId &&
              placement.processId === processId
            ) {
              return { imageId, name: known.name, path: placement.path };
            }
            const kept =
              keeper === null
                ? null
                : yield* state
                    .imageBytes(keeper.id, imageId)
                    .pipe(Effect.orElseSucceed(() => null));
            if (kept === null || keeper === null) {
              return yield* new MendCommandRefused({
                operation: "POST /api/sessions/:id/images",
                status: 410,
                tag: "ImageGone",
                detail: "An image of this message is no longer kept by the gateway.",
              });
            }
            const placed = yield* mend.pasteImage(entry.token, sessionId, kept.bytes);
            if (processId !== null) {
              const next: ImagePlacement = { sessionId, processId, path: placed.path };
              images.set(imageId, { ...kept.image, placement: next });
              yield* state.recordImagePlacement(keeper.id, imageId, next).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("t3 gateway could not record where Mend placed an image", {
                    cause: error.message,
                  }),
                ),
              );
            }
            return { imageId, name: kept.image.name, path: placed.path };
          }),
        { concurrency: PLACEMENTS_AT_ONCE },
      );

    /** `POST /turns` with the message: Mend answers its turn. */
    /** The images a message carried when Mend took its turn: what its turn named, in order. */
    const keepSentImages = (
      messageId: string,
      placed: ReadonlyArray<{ readonly imageId: string; readonly path: string }>,
    ) =>
      Effect.suspend(() => {
        if (placed.length === 0 || keeper === null) return Effect.void;
        const sent = placed.map(({ imageId, path }): SentImage => ({ imageId, path }));
        sentImages.set(messageId, sent);
        return state.recordSentImages(keeper.id, messageId, sent).pipe(
          Effect.catch((error) =>
            Effect.logWarning("t3 gateway could not record a message's images", {
              cause: error.message,
            }),
          ),
        );
      });

    const sendTurn = (sessionId: string, entry: Queueing.QueueEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        const text = yield* invocationOf(sessionId, entry);
        const sent = yield* placeImages(sessionId, entry).pipe(
          Effect.flatMap((placed) =>
            mend
              .submitTurn(entry.token, sessionId, turnInputOf(text, placed))
              .pipe(Effect.map((turn) => ({ turn, placed }))),
          ),
          Effect.result,
        );
        yield* locked(
          Effect.gen(function* () {
            const queue = queueOf(sessionId);
            if (sent._tag === "Success") {
              yield* keepSentImages(entry.messageId, sent.success.placed);
              yield* adopt(sessionId, entry, sent.success.turn);
            } else if (
              sent.failure._tag === "MendCommandRefused" &&
              (sent.failure.tag === "ProtocolSessionNotLive" ||
                // An image needs the live workspace too.
                sent.failure.tag === "SessionNotLive")
            ) {
              // Mend says the agent is not live though the row may still read it running: retry
              // only after a backoff and a fresh read, until the send deadline.
              Queueing.notLive(queue, entry, {
                now: yield* queueNow,
                evidence: evidence.get(sessionId) ?? 0,
                refusal: sent.failure.message,
                timings,
              });
            } else {
              Queueing.fail(queue, entry, reasonOf(sent.failure));
            }
            yield* publishAll;
          }),
        );
        yield* requestRefresh(`conversation:${sessionId}`);
      });

    /**
     * What a launch of the session names. A launched thread's options go with its launches only
     * until Mend has recorded a protocol agent for it; from then on Mend reuses what that agent
     * recorded (mend#493), as for every session, so a mode or model changed in Mend is never undone
     * from here. The mode, effort and model chosen for the next start go over either.
     */
    const launchOptionsOf = (sessionId: string): ThreadLaunchOptions => {
      const next = nextModes.get(sessionId);
      const nextEffort = nextEfforts.get(sessionId);
      const nextModel = nextModels.get(sessionId);
      const named =
        recordedAgentOf(sessionId) === null ? launched.get(sessionId)?.options : undefined;
      return {
        ...named,
        ...(next === undefined ? {} : { permissionMode: next }),
        ...(nextEffort === undefined ? {} : { effort: nextEffort }),
        ...(nextModel === undefined ? {} : { model: nextModel }),
      };
    };

    /**
     * Launches the stopped session again with no prompt: the message goes out by `POST /turns`
     * once Mend reports the agent live. Naming no options, Mend reuses what the session's last
     * protocol agent recorded (mend#493), so an ask session comes back asking. A thread a t3code
     * client launched names what its launch named every time: its first launch may not have
     * brought an agent up, and then Mend has nothing recorded to reuse.
     */
    const launchAgain = (sessionId: string, entry: Queueing.QueueEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        const options = launchOptionsOf(sessionId);
        const answer = yield* mend
          .launchProtocol(entry.token, sessionId, "", options)
          .pipe(Effect.result);
        const underWay =
          answer._tag === "Failure" &&
          answer.failure._tag === "MendCommandRefused" &&
          launchRacedOrLive(answer.failure)
            ? yield* launchUnderWay(entry.token, sessionId)
            : null;
        yield* locked(
          Effect.gen(function* () {
            if (answer._tag === "Success") {
              Queueing.launchAnswered(entry, answer.success.updatedAt);
            } else if (underWay !== null) {
              Queueing.launchAnswered(entry, underWay);
            } else {
              Queueing.fail(queueOf(sessionId), entry, reasonOf(answer.failure));
            }
            yield* publishAll;
          }),
        );
        const projectId = sourceOf(sessionId)?.project.id;
        if (projectId !== undefined) yield* requestRefresh(`project:${projectId}`);
      });

    /** The protocol agent Mend has recorded for a session, or null when it has none yet. */
    const recordedAgentOf = (sessionId: string): MendProcess | null => {
      for (const entry of projects.values()) {
        const agent = entry.annotations.get(sessionId)?.currentAgent ?? null;
        if (agent !== null && agent.kind === "agent-protocol") return agent;
      }
      return null;
    };

    /** Session id → when its queue is next looked at without a read (a retry, a deadline). */
    const wakes = new Map<string, number>();
    /**
     * Looks at a thread's queue again when it next needs it: a fresh read of its project, which is
     * the evidence a retry waits for, and moves a launch past its deadline.
     */
    const scheduleWake = (sessionId: string, queue: Queueing.ThreadQueue) =>
      Effect.flatMap(queueNow, (now) => {
        const at = Queueing.nextWake(queue);
        const scheduled = wakes.get(sessionId);
        if (at === null || (scheduled !== undefined && scheduled <= at)) return Effect.void;
        wakes.set(sessionId, at);
        const projectId = sourceOf(sessionId)?.project.id;
        return Effect.sleep(Math.max(0, at - now)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (wakes.get(sessionId) === at) wakes.delete(sessionId);
            }),
          ),
          Effect.andThen(
            projectId === undefined ? locked(publishAll) : requestRefresh(`project:${projectId}`),
          ),
          Effect.forkIn(hubScope),
          Effect.asVoid,
        );
      });

    /** Each thread's next step, after any read (`queue.ts` decides; this carries it out). */
    settleQueues = Effect.suspend(() =>
      Effect.forEach(
        Array.from(queues),
        ([sessionId, queue]) => {
          // Before the first full read, nothing is known of any session yet; a launched session no
          // read has shown yet is not gone either. An archived thread's queue never moves, held or
          // not, by the archive the state file keeps (review 613-R2-1).
          if (!loaded || opening.has(sessionId) || archived.has(sessionId)) return Effect.void;
          return Effect.flatMap(queueNow, (now) => {
            const step = Queueing.nextStep(queue, viewOf(sessionId), now, timings);
            const work =
              step === null
                ? Effect.void
                : Effect.gen(function* () {
                    // The step is kept before it is taken: a message the state file still reads as
                    // queued would be sent again after a restart. A send it cannot keep never goes.
                    const kept = yield* keepQueue(sessionId, queue);
                    if (!kept && step.kind === "send") {
                      Queueing.fail(queue, step.entry, NOT_KEPT);
                      yield* keepQueue(sessionId, queue);
                      return;
                    }
                    yield* Effect.forkIn(
                      step.kind === "send"
                        ? sendTurn(sessionId, step.entry)
                        : launchAgain(sessionId, step.entry),
                      hubScope,
                    );
                  });
            return Effect.andThen(work, scheduleWake(sessionId, queue));
          });
        },
        { discard: true },
      ),
    );

    /** Every device of the person was revoked: what was queued for them fails, the lease goes. */
    onTeardown = locked(
      Effect.gen(function* () {
        for (const queue of queues.values()) {
          Queueing.failAll(queue, "Every device of this person was revoked in Mend.");
        }
        yield* keepQueues;
        yield* publishShell;
        yield* publishThreads;
        busy = false;
        yield* retain(false);
      }),
    );

    const refused = (reason: string, authorization = false) =>
      Effect.fail(new ThreadCommandRefused({ reason, authorization }));

    /** Mend's steering rule, read as the sender: refuses one who may not steer the session. */
    const steerableBy = (session: BearerSession, sessionId: string, threadId: string) =>
      Effect.gen(function* () {
        const detail = yield* mend
          .sessionDetail(session.deviceToken, sessionId)
          .pipe(Effect.catchTag("MendNotFound", () => Effect.succeed(null)));
        if (detail === null)
          return yield* refused(`Thread ${threadId} is not in this environment.`);
        if (detail.control?.steer === false) {
          return yield* refused(
            "This session is not yours to steer. Its owner can turn on shared control in Mend.",
            true,
          );
        }
      });

    /**
     * Changes a thread's queue and keeps it before anything is acknowledged (review 593-R2-1, the
     * write-first rule): when the state file refuses the change, the queue is put back as it was,
     * and the command fails rather than be acknowledged and lost on a restart. `change` answers
     * false when there was nothing to change; then nothing is written either.
     */
    const changeKept = (sessionId: string, change: (queue: Queueing.ThreadQueue) => boolean) =>
      Effect.gen(function* () {
        const queue = queueOf(sessionId);
        const held = queue.held;
        const preparation = queue.preparation === null ? null : { ...queue.preparation };
        const entries = [...queue.entries];
        const fields = queue.entries.map((entry) => [entry, { ...entry }] as const);
        if (!change(queue)) return false;
        if (yield* keepQueue(sessionId, queue)) return true;
        queue.held = held;
        queue.preparation = preparation;
        queue.entries = entries;
        for (const [entry, before] of fields) Object.assign(entry, before);
        return yield* refused(QUEUE_NOT_KEPT);
      });

    const send: ThreadCommands["send"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        // Reserved before anything is read, so a copy sent concurrently is one message; released
        // again if this one is refused, so a retry is taken.
        if (handledCommands.has(command.commandId)) return sequence;
        handledCommands.add(command.commandId);
        const release = Effect.sync(() => {
          handledCommands.delete(command.commandId);
        });
        return yield* sendReserved(command).pipe(Effect.onError(() => release));
      });

    const sendReserved: ThreadCommands["send"] = (command) =>
      Effect.gen(function* () {
        // Only those who may steer queue a message.
        yield* steerableBy(command.session, command.threadId, command.threadId);
        const catalog = yield* catalogFor(
          command.session,
          command.threadId,
          command.modelSelection,
        );
        const selection = selectionRefusal(
          command.imageIds,
          (image) => sessionIdOf(image.threadId) === command.threadId,
        );
        if (selection !== null) return yield* refused(selection);
        return yield* locked(
          Effect.gen(function* () {
            if (sourceOf(command.threadId) === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            // A client re-sends a command it saw no answer to, a restart of the gateway in between
            // too: a message already kept or sent is the same message.
            if (
              queueOf(command.threadId).entries.some(
                (entry) => entry.messageId === command.messageId,
              ) ||
              Array.from(turnIds.get(command.threadId)?.messageIds.values() ?? []).includes(
                command.messageId,
              )
            ) {
              return sequence;
            }
            yield* keepNextChoices(command.threadId, command.modelSelection, catalog);
            const requestedAt = DateTime.formatIso(yield* DateTime.now);
            yield* changeKept(command.threadId, (queue) => {
              queue.entries.push(
                Queueing.newEntry({
                  runId: `t3-run:${randomUUID()}`,
                  messageId: command.messageId,
                  text: command.text,
                  requestedAt,
                  token: command.session.deviceToken,
                  sender: command.session.sessionId,
                  imageIds: command.imageIds,
                }),
              );
              return true;
            });
            yield* publishAll;
            return sequence;
          }),
        );
      });

    const catalogFor = (
      session: BearerSession,
      sessionId: string,
      selection: ModelSelection | undefined,
    ): Effect.Effect<CatalogRead> =>
      Effect.suspend(() => {
        const source = sourceOf(sessionId);
        return selection === undefined ||
          source === null ||
          selection.model === threadModelOptionsOf(source).runningModel
          ? Effect.succeed(null)
          : Effect.exit(mend.listHarnessModels(session.deviceToken));
      });

    const keepNextChoices = (
      sessionId: string,
      selection: ModelSelection | undefined,
      catalog: CatalogRead,
    ) =>
      Effect.gen(function* () {
        const source = sourceOf(sessionId);
        if (source === null) return;
        const thread = threadModelOptionsOf(source);
        const asked = optionsChangeOf(thread, selection);
        if (asked._tag === "Refused") return yield* refused(asked.reason);
        if (asked.model._tag === "Unchanged" && asked.effort._tag === "Unchanged") return;
        let change = asked;
        const model = nextLaunchModelOf(thread, asked);
        if (model !== thread.runningModel) {
          if (catalog === null || Exit.isFailure(catalog)) {
            return yield* refused(
              "The gateway could not read Mend's model catalog, so nothing changed. Try again.",
            );
          }
          change = withEffortTaken(
            thread,
            asked,
            effortsTakenBy(catalog.value, thread.harness, model),
          );
        }
        if (keeper === null) {
          return yield* refused(
            "A choice for the next start needs a paired person to keep it for.",
          );
        }
        const nextModel = keptValueOf(change.model);
        const nextEffort = keptValueOf(change.effort);
        yield* state
          .setNextChoices(keeper.id, sessionId, {
            ...(nextModel === undefined ? {} : { model: nextModel }),
            ...(nextEffort === undefined ? {} : { effort: nextEffort }),
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logError("t3 gateway could not keep a next-start choice", {
                cause: error.message,
              }),
            ),
            Effect.mapError(
              () =>
                new ThreadCommandRefused({
                  reason:
                    "The gateway could not keep this choice for the agent's next start, so nothing changed. Try again.",
                  authorization: false,
                }),
            ),
          );
        remember(nextModels, sessionId, nextModel);
        remember(nextEfforts, sessionId, nextEffort);
      });

    /** The Mend turn a run is: the turn the gateway sent it as, or the turn of that id. */
    const turnOfRun = (sessionId: string, runId: string): MendTurn | null => {
      const runIds = turnIds.get(sessionId)?.runIds ?? NO_IDS;
      let turnId = runId;
      for (const [candidate, minted] of runIds) {
        if (minted === runId) turnId = candidate;
      }
      return conversations.get(sessionId)?.turns.find((turn) => turn.id === turnId) ?? null;
    };

    /** Takes a message back wherever it is on its way, holding the queue if asked. */
    const takeBack = (threadId: string, runId: string, holdQueue: boolean) =>
      locked(
        Effect.gen(function* () {
          const taken = yield* changeKept(threadId, (queue) =>
            Queueing.takeBack(queue, runId, holdQueue),
          );
          if (!taken) return yield* refused("That message is not queued any more.");
          yield* publishAll;
          return sequence;
        }),
      );

    const cancelQueued: ThreadCommands["cancelQueued"] = (threadId, runId) =>
      takeBack(threadId, runId, false);

    const interrupt: ThreadCommands["interrupt"] = (command) =>
      Effect.gen(function* () {
        const target = yield* locked(
          Effect.gen(function* () {
            const queue = queueOf(command.threadId);
            if (queue.entries.some((entry) => entry.runId === command.runId)) {
              return { kind: "queued" as const };
            }
            const turn = turnOfRun(command.threadId, command.runId);
            if (turn === null) return yield* refused(`Run ${command.runId} is not in this thread.`);
            const wasHeld = queue.held;
            // Held before the turn ends, so the next message does not go out behind it.
            yield* changeKept(command.threadId, (held) => {
              Queueing.holdIfQueued(held, command.holdQueue);
              return true;
            });
            yield* publishAll;
            return { kind: "turn" as const, turn, wasHeld };
          }),
        );
        // A message still in the queue or on its way: taken back, honouring holdQueue too.
        if (target.kind === "queued") {
          return yield* takeBack(command.threadId, command.runId, command.holdQueue);
        }
        yield* mend.interruptTurn(command.session.deviceToken, target.turn.id).pipe(
          Effect.catchTags({
            MendCommandRefused: (e) => Effect.fail(commandRefusalOf(e)),
            MendNotFound: (e) => Effect.fail(commandRefusalOf(e)),
          }),
          Effect.tapError(() =>
            locked(
              Effect.gen(function* () {
                queueOf(command.threadId).held = target.wasHeld;
                yield* publishAll;
              }),
            ),
          ),
        );
        yield* requestRefresh(`conversation:${command.threadId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    const resumeQueue: ThreadCommands["resumeQueue"] = (threadId) =>
      locked(
        Effect.gen(function* () {
          if (archived.has(threadId)) {
            return yield* refused(
              "The thread is archived: nothing in its queue is sent until it is unarchived. Unarchive it, then resume.",
            );
          }
          yield* changeKept(threadId, (queue) => {
            Queueing.resume(queue);
            return true;
          });
          yield* publishAll;
          return sequence;
        }),
      );

    const startQueued: ThreadCommands["startQueued"] = (threadId, runId) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        return yield* locked(
          Effect.gen(function* () {
            if (archived.has(threadId)) {
              return yield* refused(
                "The thread is archived: nothing in its queue is sent until it is unarchived. Unarchive it, then send the message.",
              );
            }
            let outcome: Queueing.StartQueued = "unknown";
            const started = yield* changeKept(threadId, (queue) => {
              outcome = Queueing.startQueued(queue, viewOf(threadId), runId);
              return outcome === "started";
            });
            if (!started) return yield* refused(START_QUEUED_REFUSALS[outcome]);
            yield* publishAll;
            return sequence;
          }),
        );
      });

    /** A change to what is still waiting in a thread's queue, published at once. */
    /** An edit or a reorder, kept before it is acknowledged (594-R2-1): refused, nothing changed. */
    const changeQueue = (sessionId: string, change: (queue: Queueing.ThreadQueue) => boolean) =>
      locked(
        Effect.gen(function* () {
          if (!(yield* changeKept(sessionId, change))) {
            return yield* refused("That message is not waiting in the queue any more.");
          }
          yield* publishAll;
          return sequence;
        }),
      );

    const respond: ThreadCommands["respond"] = (command) =>
      Effect.gen(function* () {
        const known = yield* locked(
          Effect.sync(
            () =>
              conversations
                .get(command.threadId)
                ?.requests.some((request) => request.id === command.requestId) ?? false,
          ),
        );
        if (!known) return yield* refused(`Request ${command.requestId} is not in this thread.`);
        yield* mend
          .respondRequest(command.session.deviceToken, command.requestId, command.response)
          .pipe(
            Effect.catchTags({
              MendCommandRefused: (e) => Effect.fail(commandRefusalOf(e)),
              MendNotFound: (e) => Effect.fail(commandRefusalOf(e)),
            }),
          );
        yield* requestRefresh(`conversation:${command.threadId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    /** Mend's refusal of a command as the thread command's. */
    const asCommandRefusal = <A>(
      effect: MendCommand<A>,
    ): Effect.Effect<A, ThreadCommandRefused | MendDeviceRefused | MendUnavailable> =>
      effect.pipe(
        Effect.catchTags({
          MendCommandRefused: (error) => Effect.fail(commandRefusalOf(error)),
          MendNotFound: (error) => Effect.fail(commandRefusalOf(error)),
        }),
      );

    const createProject = Effect.fn("PersonHub.createProject")(function* (
      session: BearerSession,
      request: ProjectCreationRequest,
    ) {
      if (tokens.isRefused(session.deviceToken))
        return yield* new MendDeviceRefused({ operation: "project creation" });
      if (session.mendUser.id !== keeper?.id || !session.scopes.includes("orchestration:operate"))
        return yield* refused("Project creation requires the paired person's operate scope.", true);
      yield* ensureLoaded;
      const created = yield* asCommandRefusal(
        request.kind === "scratch"
          ? mend.ensureScratchProject(session.deviceToken)
          : mend.createProject(session.deviceToken, request.name),
      );
      if (request.kind === "scratch" && created.scratchOwnerUserId !== session.mendUser.id)
        return yield* refused("Mend did not return this person's scratch project.");
      const shown = yield* loadLock
        .withPermits(1)(
          refreshProject(created.id).pipe(
            Effect.map(() => projects.get(created.id)?.project ?? null),
          ),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning("t3 gateway could not read a created project", {
                cause: error.message,
              }),
              null,
            ),
          ),
          Effect.repeat({
            until: (project) => project !== null,
            schedule: Schedule.spaced(CREATED_READ_RETRY).pipe(
              Schedule.upTo({ duration: CREATED_SHOWN_WITHIN }),
            ),
          }),
        );
      if (shown !== null) return shown;
      // The full read is tried again until Mend answers, which brings the project into the shell.
      yield* requestRefresh("all");
      return yield* refused(
        `Mend created the project ${created.name}, but this window cannot show it yet. It appears when the window refreshes, so there is no need to create it again.`,
      );
    });

    /**
     * `wanted` with a random suffix (`health-check-k3x9qa`) no worktree of the project has; null
     * when unsure, and Mend names it. Mend joins an existing worktree of the same name, and a
     * lookup alone reserves nothing: two launches, or another Mend client, could take a name both
     * saw free (review 590-R2-1). The suffix makes the name its own whoever creates at once.
     */
    const freeWorktreeName = (token: string, projectId: string, wanted: string) =>
      mend.listWorktrees(token, projectId).pipe(
        Effect.map((worktrees) => {
          const taken = new Set(worktrees.map((worktree) => worktree.name));
          for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = `${wanted.slice(0, WORKTREE_NAME_STEM)}-${worktreeSuffix()}`;
            if (!taken.has(candidate)) return candidate;
          }
          return null;
        }),
        Effect.orElseSucceed(() => null),
      );

    /**
     * Launch commands and client thread ids under way, so a retry sent while the first runs is not
     * a second thread, and two launches never take one thread id.
     */
    const launching = new Set<string>();

    // ─── Preparing a new worktree (`worktree-setup.ts`) ────────────────────

    const setups = makeWorktreeSetups(hubScope);

    /**
     * Mend refused a launch because it races another or finds the agent up (`launchRacedOrLive`),
     * so the session itself is read. The session's `updatedAt` when its launch is under way or done,
     * else null.
     */
    const launchUnderWay = (token: string, sessionId: string) =>
      mend.sessionDetail(token, sessionId).pipe(
        Effect.map((detail) => {
          const agent = detail.currentAgent;
          const agentUp =
            agent !== null &&
            agent.exitedAt === null &&
            (agent.status === "running" || agent.status === "starting");
          return detail.session.status === "starting" || agentUp ? detail.session.updatedAt : null;
        }),
        Effect.orElseSucceed(() => null),
      );

    const settlePreparation = (preparation: Preparation, failure: string | null) =>
      Effect.gen(function* () {
        const { runId, sessionId } = preparation;
        yield* locked(
          Effect.gen(function* () {
            const queue = queueOf(sessionId);
            if (failure === null) Queueing.prepared(queue, runId);
            else Queueing.preparationFailed(queue, runId, failure);
            yield* keepQueue(sessionId, queue);
            yield* publishAll;
          }),
        );
        yield* requestRefresh(`project:${preparation.projectId}`);
      });

    const startPreparation = (preparation: Preparation) =>
      prepareWorktree(
        {
          mend,
          terminals,
          setups,
          worktreeOf: (sessionId) =>
            locked(
              Effect.sync(() => {
                const source = sourceOf(sessionId);
                return source === null
                  ? null
                  : {
                      worktreeId: source.session.worktreeId,
                      worktreePath: worktreePathOf(source.project, source.session),
                    };
              }),
            ),
          setupScriptOf: (projectId) =>
            locked(Effect.sync(() => setupScriptOf(projectScripts.get(projectId) ?? []))),
          launchUnderWay,
          refresh: (projectId) => requestRefresh(`project:${projectId}`),
          setupProcessOpened: (sessionId, processId) =>
            locked(
              Effect.gen(function* () {
                const queue = queueOf(sessionId);
                Queueing.setupProcessOpened(queue, processId);
                yield* keepQueue(sessionId, queue);
              }),
            ),
          settle: settlePreparation,
        },
        preparation,
      ).pipe(Effect.forkIn(hubScope), Effect.asVoid);

    const launchReserved = (request: ThreadLaunch) =>
      Effect.gen(function* () {
        const token = request.session.deviceToken;
        const target = yield* locked(
          Effect.sync(() => {
            if (
              request.threadId !== null &&
              (sessionOfThread.has(request.threadId) || isKnownThread(request.threadId))
            ) {
              return { kind: "taken" as const };
            }
            const entry = projects.get(request.projectId);
            if (entry === undefined) return { kind: "no-project" as const };
            const workspace = launchWorkspaceOf(
              entry.project,
              request.session.mendUser.id,
              request.workspace,
            );
            if (workspace.kind === "refused")
              return { kind: "refused" as const, reason: workspace.reason };
            if (workspace.kind === "new") {
              return {
                kind: "new" as const,
                name: workspace.name,
                base: workspace.strategy.baseRef,
                strategy: workspace.strategy,
                hasOrigin: (entry.project.originUrl ?? null) !== null,
              };
            }
            // A worktree is known by the path of a session in it: the same directory.
            const joined = entry.sessions.find(
              (session) => worktreePathOf(entry.project, session) === workspace.worktreePath,
            );
            return joined === undefined
              ? { kind: "no-worktree" as const }
              : { kind: "join" as const, worktreeId: joined.worktreeId };
          }),
        );
        if (target.kind === "taken") {
          return yield* refused(`Thread ${request.threadId ?? ""} is already in this environment.`);
        }
        if (target.kind === "no-project") {
          return yield* refused(`Project ${request.projectId} is not in this environment.`);
        }
        if (target.kind === "refused") return yield* refused(target.reason);
        if (target.kind === "no-worktree") {
          return yield* refused(
            request.workspace.kind === "join"
              ? `No session of this project works in ${request.workspace.worktreePath}.`
              : "No such worktree.",
          );
        }
        const strategy = target.kind === "new" ? target.strategy : null;
        // The setup card is the client's, keyed by the thread id it subscribes with from the moment
        // it sends; a launch that names no thread has none, and its worktree is prepared all the same.
        const card = strategy === null ? null : request.threadId;
        if (strategy !== null && card !== null) {
          yield* setups.begin({
            threadId: card,
            branch: strategy.branch ?? null,
            baseRef: strategy.baseRef,
            stages: ["fetch", "checkout", "setup-script", "agent"],
          });
        }
        const stage = (stageId: "fetch" | "checkout", status: "running" | "done" | "skipped") =>
          card === null ? Effect.void : setups.stageStatus(card, stageId, status);
        const created = yield* Effect.gen(function* () {
          if (target.kind === "join") {
            return yield* asCommandRefusal(
              mend.joinWorktree(token, target.worktreeId, {
                harness: request.harness,
                label: request.label,
              }),
            );
          }
          const fetchOrigin = strategy?.startFromOrigin === true && target.hasOrigin;
          yield* stage("fetch", fetchOrigin ? "running" : "skipped");
          if (fetchOrigin) {
            yield* asCommandRefusal(mend.refreshProject(token, request.projectId));
            yield* stage("fetch", "done");
          }
          // Mend joins an existing worktree of the same name: a new worktree takes a name no
          // worktree of the project has, or none, and Mend names it.
          const name =
            target.name === null
              ? null
              : yield* freeWorktreeName(token, request.projectId, target.name);
          yield* stage("checkout", "running");
          const made = yield* asCommandRefusal(
            mend.createSession(token, request.projectId, {
              harness: request.harness,
              label: request.label,
              name,
              base: target.base,
            }),
          );
          yield* stage("checkout", "done");
          return made;
        }).pipe(
          Effect.tapError((error) =>
            card === null ? Effect.void : setups.finish(card, "failed", error.message),
          ),
        );
        const thread: LaunchedThread = {
          threadId: request.threadId ?? created.id,
          sessionId: created.id,
          commandId: request.commandId,
          options: request.options,
        };
        yield* state
          .recordThread(request.session.mendUser.id, thread, yield* Clock.currentTimeMillis)
          .pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not record a launched thread", {
                cause: error.message,
              }),
            ),
          );
        yield* locked(
          Effect.sync(() => {
            rememberThread(thread);
            opening.add(created.id);
          }),
        );
        const { message } = request;
        const openingRunId = message === null ? null : `t3-run:${randomUUID()}`;
        // The opening message is queued like any other: the queue launches the session on what
        // the launch named and sends the message as an exact turn once the agent runs.
        const queueOpening = (requestedAt: string) => {
          const queue = queueOf(created.id);
          const entry =
            message === null ||
            openingRunId === null ||
            queue.entries.some((queued) => queued.messageId === message.messageId)
              ? null
              : Queueing.newEntry({
                  runId: openingRunId,
                  messageId: message.messageId,
                  text: message.text,
                  requestedAt,
                  token,
                  sender: request.session.sessionId,
                  imageIds: message.imageIds,
                  workspacePreparation: strategy,
                });
          if (entry !== null) queue.entries.push(entry);
          if (strategy !== null) Queueing.beginPreparation(queue, entry);
        };
        const preparation: Preparation | null =
          strategy === null
            ? null
            : {
                session: request.session,
                threadId: thread.threadId,
                sessionId: created.id,
                projectId: request.projectId,
                runId: openingRunId,
                options: request.options,
                staleProcessId: null,
              };
        // The message is queued at once, whatever the reads below find: it is never dropped.
        // Until a project read shows the session, it stays hidden and its queue waits.
        yield* locked(Effect.map(DateTime.now, (now) => queueOpening(DateTime.formatIso(now))));
        // The session as Mend has it now, so the thread is in the shell, with its message, before
        // the launch answers: t3code's client opens a launched thread only once its shell shows it.
        const read = (attempts: number) =>
          refreshProject(request.projectId).pipe(
            Effect.retry({ times: attempts, schedule: Schedule.spaced(OPENING_READ_RETRY) }),
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not read a launched thread's project", {
                cause: error.message,
              }),
            ),
          );
        yield* read(OPENING_READ_ATTEMPTS);
        if (message === null) {
          // Nothing to send: the agent comes up now, and a refusal is the launch's.
          yield* asCommandRefusal(mend.launchProtocol(token, created.id, "", request.options)).pipe(
            Effect.tap(() => requestRefresh(`project:${request.projectId}`)),
            Effect.tapError((error) =>
              preparation === null
                ? Effect.void
                : setups.finish(preparation.threadId, "failed", error.message),
            ),
          );
        }
        // The worktree is prepared once a read shows the session: its shell needs the thread.
        const prepare = preparation === null ? Effect.void : startPreparation(preparation);
        if (yield* locked(Effect.sync(() => opening.has(created.id)))) {
          // Mend not answering yet: keep reading in the background; the message waits for it.
          const unread =
            "Mend created the session, but the gateway could not read it to send this message.";
          yield* Effect.forkIn(
            read(OPENING_READ_BACKGROUND_ATTEMPTS).pipe(
              Effect.andThen(
                locked(
                  Effect.gen(function* () {
                    if (!opening.has(created.id)) return true;
                    opening.delete(created.id);
                    const queue = queueOf(created.id);
                    Queueing.preparationFailed(queue, openingRunId, unread);
                    Queueing.failAll(queue, unread);
                    yield* publishAll;
                    return false;
                  }),
                ),
              ),
              Effect.flatMap((shown) =>
                shown
                  ? prepare
                  : preparation === null
                    ? Effect.void
                    : setups.finish(preparation.threadId, "failed", unread),
              ),
            ),
            hubScope,
          );
        } else {
          yield* prepare;
        }
        const launchedId: LaunchedThreadId = { threadId: thread.threadId, resumed: false };
        return launchedId;
      });

    const launch: ThreadCommands["launch"] = (request) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const selection = selectionRefusal(
          request.message?.imageIds ?? [],
          (image) => image.threadId === request.threadId,
        );
        if (selection !== null) return yield* refused(selection);
        const known = Array.from(launched.values()).find(
          (thread) => thread.commandId === request.commandId,
        );
        if (known !== undefined) {
          const resumed: LaunchedThreadId = { threadId: known.threadId, resumed: true };
          return resumed;
        }
        if (request.session.mendUser.id !== launcher) {
          return yield* refused("A launch is the paired person's own.", true);
        }
        const reserved = [
          `command:${request.commandId}`,
          ...(request.threadId === null ? [] : [`thread:${request.threadId}`]),
        ];
        if (reserved.some((key) => launching.has(key))) {
          return yield* refused("This launch is already under way.");
        }
        for (const key of reserved) launching.add(key);
        return yield* launchReserved(request).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of reserved) launching.delete(key);
            }),
          ),
        );
      });

    const retryPreparation: ThreadCommands["retryPreparation"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        const entry = yield* locked(
          Effect.gen(function* () {
            if (archived.has(sessionId)) {
              return yield* refused("The thread is archived. Unarchive it, then retry.");
            }
            let staleProcessId: string | null = null;
            const retried = yield* changeKept(sessionId, (queue) => {
              const retry = Queueing.retryPreparation(queue, command.runId);
              staleProcessId = retry?.staleProcessId ?? null;
              return retry !== null;
            });
            if (!retried) {
              return yield* refused(
                `Run ${command.runId} has no failed worktree preparation to retry.`,
              );
            }
            yield* publishAll;
            return {
              staleProcessId,
              baseRef:
                queueOf(sessionId).entries.find((candidate) => candidate.runId === command.runId)
                  ?.workspacePreparation?.baseRef ?? null,
              branch: sourceOf(sessionId)?.session.branch ?? null,
            };
          }),
        );
        // The worktree is there already: what is prepared again is its setup, and the hand-off.
        yield* setups.begin({
          threadId: command.threadId,
          branch: entry.branch,
          baseRef: entry.baseRef,
          stages: ["setup-script", "agent"],
        });
        yield* startPreparation({
          session: command.session,
          threadId: command.threadId,
          sessionId,
          projectId,
          runId: command.runId,
          options: launchOptionsOf(sessionId),
          staleProcessId: entry.staleProcessId,
        });
        return yield* locked(Effect.sync(() => sequence));
      });

    const saveProjectScripts: PersonHub["saveProjectScripts"] = (projectId, scripts) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (keeper === null) {
          return yield* refused("Project actions need a paired person to keep them for.");
        }
        if (!(yield* locked(Effect.sync(() => projects.has(projectId))))) {
          return yield* refused(`No project ${projectId} in this environment.`);
        }
        yield* state.setProjectScripts(keeper.id, projectId, scripts).pipe(
          Effect.tapError((error) =>
            Effect.logError("t3 gateway could not keep project actions", {
              cause: error.message,
            }),
          ),
          Effect.catch(() =>
            refused("The gateway could not keep these project actions. Try again."),
          ),
        );
        yield* locked(
          Effect.gen(function* () {
            if (scripts === null) projectScripts.delete(projectId);
            else projectScripts.set(projectId, scripts);
            yield* publishAll;
          }),
        );
      });

    /** The project of a thread the person has, or a refusal naming the thread. */
    const projectOfThread = (threadId: string, sessionId: string) =>
      locked(Effect.sync(() => sourceOf(sessionId)?.project.id ?? null)).pipe(
        Effect.flatMap((projectId) =>
          projectId === null
            ? refused(`Thread ${threadId} is not in this environment.`)
            : Effect.succeed(projectId),
        ),
      );

    const rename: ThreadCommands["rename"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        yield* asCommandRefusal(
          mend.labelSession(command.session.deviceToken, sessionId, command.title),
        );
        yield* refreshProject(projectId).pipe(Effect.catch(() => requestRefresh("all")));
        return yield* locked(Effect.sync(() => sequence));
      });

    const stop: ThreadCommands["stop"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        yield* asCommandRefusal(mend.stopSession(command.session.deviceToken, sessionId));
        // A stopped session is not launched again for what was already queued; resuming is.
        yield* locked(
          Effect.gen(function* () {
            Queueing.holdIfQueued(queueOf(sessionId), true);
            yield* publishAll;
          }),
        );
        yield* requestRefresh(`project:${projectId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    const remove: ThreadCommands["remove"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const token = command.session.deviceToken;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        // Mend removes only a settled session; a live one is stopped first, once.
        const report = yield* asCommandRefusal(
          mend
            .removeSession(token, sessionId)
            .pipe(
              Effect.catch((error) =>
                error._tag === "MendCommandRefused" && error.tag === "SessionActive"
                  ? mend
                      .stopSession(token, sessionId)
                      .pipe(Effect.andThen(mend.removeSession(token, sessionId)))
                  : Effect.fail(error),
              ),
            ),
        );
        if (!report.removed && launcher !== null) {
          // Kept before the thread goes, so a restart never brings it back.
          yield* state.keepRemoval(launcher, sessionId, yield* Clock.currentTimeMillis).pipe(
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not keep a pending removal", {
                cause: error.message,
              }),
            ),
          );
        }
        yield* locked(
          Effect.gen(function* () {
            // Mend keeps the row until its workspace has stopped; t3code's client has let it go.
            if (!report.removed) removing.add(sessionId);
            Queueing.failAll(queueOf(sessionId), "The thread was deleted.");
            yield* publishAll;
          }),
        );
        // The client's id for the thread goes with it, removed now or once its workspace stops.
        if (launcher !== null) {
          yield* state.forgetThread(launcher, sessionId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not forget a deleted thread", {
                cause: error.message,
              }),
            ),
          );
        }
        yield* requestRefresh(`project:${projectId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    // ─── Images ────────────────────────────────────────────────────────────

    const imageOf = (imageId: string): MessageImage | null => {
      const image = images.get(imageId);
      return image === undefined ? null : messageImageOf(image);
    };

    const persistImages: PersonHub["persistImages"] = (request) =>
      Effect.gen(function* () {
        if (keeper === null) return yield* refused("Images need a paired person to keep them for.");
        if (request.uploads.length > MAX_IMAGES_PER_MESSAGE) {
          return yield* refused(`A message carries at most ${MAX_IMAGES_PER_MESSAGE} images.`);
        }
        if (
          request.uploads.reduce((bytes, upload) => bytes + upload.sizeBytes, 0) >
          MAX_IMAGE_BYTES_PER_MESSAGE
        ) {
          return yield* refused(TOO_MANY_IMAGE_BYTES);
        }
        const kept: Array<StoredImage & { readonly bytes: Uint8Array }> = [];
        for (const [position, upload] of request.uploads.entries()) {
          const parsed = parseDataUrl(upload.dataUrl);
          if (parsed === null || parsed.mimeType !== upload.mimeType.toLowerCase()) {
            return yield* refused(`${upload.name} is not an image payload.`);
          }
          if (parsed.bytes.byteLength !== upload.sizeBytes) {
            return yield* refused(`${upload.name}'s size does not match its payload.`);
          }
          if (parsed.bytes.byteLength > MEND_IMAGE_MAX_BYTES) {
            return yield* refused(`${upload.name} is larger than Mend's 8 MiB for an image.`);
          }
          // Mend reads the format from the bytes, as here: a PNG, JPEG, GIF or WebP.
          const mimeType = detectImageType(parsed.bytes);
          if (mimeType === null) {
            return yield* refused(`${upload.name} is not a PNG, JPEG, GIF or WebP image.`);
          }
          kept.push({
            id: newAttachmentId(),
            threadId: request.threadId,
            messageId: request.messageId,
            position,
            name: upload.name,
            mimeType,
            sizeBytes: parsed.bytes.byteLength,
            placement: null,
            bytes: parsed.bytes,
          });
        }
        yield* state.saveImages(keeper.id, kept, yield* Clock.currentTimeMillis).pipe(
          Effect.mapError(
            () =>
              new ThreadCommandRefused({
                reason: "The gateway could not keep the images.",
                authorization: false,
              }),
          ),
        );
        for (const { bytes: _bytes, ...image } of kept) images.set(image.id, image);
        return kept.map(messageImageOf);
      });

    const selectionRefusal = (
      imageIds: ReadonlyArray<string>,
      inThread: (image: StoredImage) => boolean,
    ): string | null => {
      if (imageIds.length > MAX_IMAGES_PER_MESSAGE) {
        return `A message carries at most ${MAX_IMAGES_PER_MESSAGE} images.`;
      }
      if (new Set(imageIds).size !== imageIds.length) return "A message names each image once.";
      let bytes = 0;
      for (const imageId of imageIds) {
        const image = images.get(imageId);
        if (image === undefined) return `Image ${imageId} is not kept by this environment.`;
        if (!inThread(image)) return `Image ${imageId} was attached in another thread.`;
        bytes += image.sizeBytes;
      }
      if (bytes > MAX_IMAGE_BYTES_PER_MESSAGE) return TOO_MANY_IMAGE_BYTES;
      return null;
    };

    const setNextMode: ThreadCommands["setNextMode"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        // Only those who may steer choose a mode.
        yield* steerableBy(command.session, sessionId, command.threadId);
        if (keeper === null) return yield* refused("A mode needs a paired person to keep it for.");
        return yield* locked(
          Effect.gen(function* () {
            const source = sourceOf(sessionId);
            if (source === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            // The mode it already runs with is nothing to wait for.
            const next = command.mode === modeOf(source.agent) ? null : command.mode;
            // Kept first: a choice the state file did not take is refused, never acknowledged and
            // then lost to a restart (an `ask` that came back as full access).
            yield* state.setNextMode(keeper.id, sessionId, next).pipe(
              Effect.tapError((error) =>
                Effect.logError("t3 gateway could not keep a next-start mode", {
                  cause: error.message,
                }),
              ),
              Effect.mapError(
                () =>
                  new ThreadCommandRefused({
                    reason:
                      "The gateway could not keep this mode for the agent's next start, so it did not change it. Try again.",
                    authorization: false,
                  }),
              ),
            );
            if (next === null) nextModes.delete(sessionId);
            else nextModes.set(sessionId, next);
            yield* publishAll;
            return sequence;
          }),
        );
      });

    const setNextSelection: ThreadCommands["setNextSelection"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        yield* steerableBy(command.session, sessionId, command.threadId);
        const catalog = yield* catalogFor(command.session, sessionId, command.modelSelection);
        return yield* locked(
          Effect.gen(function* () {
            if (sourceOf(sessionId) === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            yield* keepNextChoices(sessionId, command.modelSelection, catalog);
            yield* publishAll;
            return sequence;
          }),
        );
      });

    const setArchived: ThreadCommands["setArchived"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (keeper === null)
          return yield* refused("An archive needs a paired person to keep it for.");
        const sessionId = sessionIdOf(command.threadId);
        return yield* locked(
          Effect.gen(function* () {
            if (sourceOf(sessionId) === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            if (archived.has(sessionId) === command.archived) {
              return yield* refused(
                command.archived
                  ? "The thread is archived already."
                  : "The thread is not archived.",
              );
            }
            const at = command.archived ? DateTime.formatIso(yield* DateTime.now) : null;
            // Archived, what is still queued waits held, kept first: nothing is sent while the
            // thread is archived (the archive itself guards that too), and nothing is lost (a
            // message taken back is history, and history is capped). Unarchived, it stays held
            // until the person resumes it.
            const wasHeld = queueOf(sessionId).held;
            if (at !== null) {
              yield* changeKept(sessionId, (queue) => {
                Queueing.holdIfQueued(queue, true);
                return true;
              });
            }
            yield* state.setArchived(keeper.id, sessionId, at).pipe(
              Effect.tapError(() =>
                at === null
                  ? Effect.void
                  : changeKept(sessionId, (queue) => {
                      queue.held = wasHeld;
                      return true;
                    }).pipe(Effect.ignore),
              ),
              Effect.mapError(
                () =>
                  new ThreadCommandRefused({
                    reason: "The gateway could not keep the archive.",
                    authorization: false,
                  }),
              ),
            );
            if (at === null) archived.delete(sessionId);
            else archived.set(sessionId, at);
            yield* publishAll;
            return sequence;
          }),
        );
      });

    const setLifecycle: ThreadCommands["setLifecycle"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (keeper === null) {
          return yield* refused(
            "A settle, snooze, pin or order needs a paired person to keep it for.",
          );
        }
        const sessionId = sessionIdOf(command.threadId);
        return yield* locked(
          Effect.gen(function* () {
            // Applied again, a snooze would be stamped past a failure that arrived since and hide
            // it: a command already answered is answered the same way.
            const kept = yield* state
              .lifecycleReceipt(keeper.id, command.commandId)
              .pipe(lifecycleKept);
            if (Option.isSome(kept)) {
              const { sessionId: keptFor, answer } = kept.value;
              if (keptFor !== sessionId) {
                return yield* refused(
                  `Command ${command.commandId} was already handled for another thread and cannot be replayed for ${command.threadId}.`,
                );
              }
              return answer._tag === "Applied" ? answer.sequence : yield* refused(answer.reason);
            }
            const receiptOf = (answer: LifecycleReceipt["answer"]): LifecycleReceipt => ({
              commandId: command.commandId,
              sessionId,
              answer,
            });
            const refuse = (reason: string) =>
              state.keepLifecycleReceipt(keeper.id, receiptOf({ _tag: "Refused", reason })).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("t3 gateway could not keep a refused settle or snooze", {
                    cause: error.message,
                  }),
                ),
                Effect.andThen(refused(reason)),
              );
            const source = sourceOf(sessionId);
            if (source === null) {
              return yield* refuse(`Thread ${command.threadId} is not in this environment.`);
            }
            if (source.archivedAt !== null) {
              return yield* refuse("The thread is archived. Unarchive it first.");
            }
            const result = changeLifecycle(source, command.change, yield* DateTime.nowAsDate);
            if (result._tag === "Refused") return yield* refuse(result.reason);
            const next = result.lifecycle;
            const before = sequence;
            const applied = receiptOf({ _tag: "Applied", sequence: before });
            if (sameLifecycle(next, source.lifecycle)) {
              yield* state.keepLifecycleReceipt(keeper.id, applied).pipe(lifecycleKept);
              return sequence;
            }
            yield* state
              .setLifecycle(keeper.id, sessionId, isLifecycleEmpty(next) ? null : next, applied)
              .pipe(lifecycleKept);
            if (isLifecycleEmpty(next)) lifecycles.delete(sessionId);
            else lifecycles.set(sessionId, next);
            yield* publishAll;
            // The receipt was kept with the change, before the sequence that published it was
            // known. Should this second write fail, a replay is answered with the earlier one, and
            // the client's shell has carried the change since.
            if (sequence !== before) {
              yield* state
                .keepLifecycleReceipt(keeper.id, receiptOf({ _tag: "Applied", sequence }))
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("t3 gateway could not update a settle or snooze receipt", {
                      cause: error.message,
                    }),
                  ),
                );
            }
            return sequence;
          }),
        );
      });

    const setVisited: ThreadCommands["setVisited"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (keeper === null) {
          return yield* refused("Read state needs a paired person to keep it for.");
        }
        const sessionId = sessionIdOf(command.threadId);
        return yield* locked(
          Effect.gen(function* () {
            const source = sourceOf(sessionId);
            if (source === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            const completedAt = runsOf(source).at(-1)?.completedAt ?? null;
            const result =
              command.change.kind === "visit"
                ? visitedAfter(source.lastVisitedAt, command.change.at)
                : markedUnread(completedAt === null ? null : DateTime.formatIso(completedAt));
            if (result._tag === "Refused") return yield* refused(result.reason);
            if (result.lastVisitedAt !== source.lastVisitedAt) {
              yield* state.setVisited(keeper.id, sessionId, result.lastVisitedAt).pipe(
                Effect.tapError((error) =>
                  Effect.logError("t3 gateway could not keep when a thread was seen", {
                    cause: error.message,
                  }),
                ),
                Effect.mapError(
                  () =>
                    new ThreadCommandRefused({
                      reason: "The gateway could not keep this, so nothing changed. Try again.",
                      authorization: false,
                    }),
                ),
              );
              visited.set(sessionId, result.lastVisitedAt);
              yield* publishAll;
            }
            return sequence;
          }),
        );
      });

    // A thread a t3code client launched is addressed by the client's id; everything inside the
    // hub is keyed by the Mend session.
    const commands: ThreadCommands = {
      send: (command) => send({ ...command, threadId: sessionIdOf(command.threadId) }),
      interrupt: (command) => interrupt({ ...command, threadId: sessionIdOf(command.threadId) }),
      cancelQueued: (threadId, runId) => cancelQueued(sessionIdOf(threadId), runId),
      resumeQueue: (threadId) => resumeQueue(sessionIdOf(threadId)),
      startQueued: (threadId, runId) => startQueued(sessionIdOf(threadId), runId),
      editQueued: (threadId, runId, text, imageIds) => {
        const sessionId = sessionIdOf(threadId);
        const selection =
          imageIds === undefined
            ? null
            : selectionRefusal(imageIds, (image) => sessionIdOf(image.threadId) === sessionId);
        return selection !== null
          ? refused(selection)
          : changeQueue(sessionId, (queue) => Queueing.edit(queue, runId, text, imageIds));
      },
      reorderQueued: (threadId, runId, beforeRunId) =>
        changeQueue(sessionIdOf(threadId), (queue) => Queueing.reorder(queue, runId, beforeRunId)),
      respond: (command) => respond({ ...command, threadId: sessionIdOf(command.threadId) }),
      launch,
      retryPreparation,
      rename,
      stop,
      remove,
      setNextMode,
      setNextSelection,
      setArchived,
      setLifecycle,
      setVisited,
    };

    // ─── The hub ───────────────────────────────────────────────────────────

    const shellSnapshot = ensureLoaded.pipe(Effect.andThen(locked(Effect.sync(currentShell))));

    const subscribeShell = (afterSequence: number | undefined) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        // Subscribed before the snapshot or the replay is taken: nothing published after it is
        // missed, and what both carry has a sequence the client already holds, which it drops.
        const changes = yield* shellChanges.subscribe(() => true);
        const start = yield* locked(
          Effect.sync((): ShellSubscription["start"] => {
            const deltas =
              afterSequence === undefined || !sequencer.owns(afterSequence)
                ? null
                : shellLog.since(afterSequence, sequence);
            return deltas === null
              ? { kind: "snapshot", snapshot: currentShell() }
              : { kind: "replay", deltas };
          }),
        );
        const subscribed: ShellSubscription = { start, changes };
        return subscribed;
      });

    const threadSnapshot = (threadId: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const watched = watches.has(threadId);
        if (!watched && !(yield* locked(Effect.sync(() => isKnownThread(threadId))))) return null;
        // An unwatched thread's items are read for this snapshot alone.
        const items = watched ? null : yield* readItemsAfter(threadId, 0);
        return yield* locked(
          Effect.gen(function* () {
            const source = sourceOf(threadId);
            if (source === null) return null;
            const built =
              items === null
                ? yield* publishThread(threadId)
                : (yield* printProjection(threadProjectionOf(source, items))).projection;
            if (built === null) return null;
            const snapshot: ThreadSnapshot = { snapshotSequence: sequence, projection: built };
            return snapshot;
          }),
        );
      });

    const subscribeThread = (threadId: string, afterSequence?: number) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (!(yield* locked(Effect.sync(() => isKnownThread(threadId))))) return null;
        const watch = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const existing = watches.get(threadId);
            if (existing !== undefined) {
              existing.count += 1;
              return existing;
            }
            const fresh: Watch = {
              count: 1,
              idle: 0,
              items: new Map(),
              cursor: 0,
              prints: null,
              thread: null,
              log: null,
              chain: null,
              endedTurns: -1,
              chainReadAt: 0,
              chainRetries: 0,
              chainRecheck: false,
            };
            watches.set(threadId, fresh);
            return fresh;
          }),
          // Kept a while after its last subscriber, so a client that reconnects resumes it.
          (held) =>
            Effect.suspend(() => {
              held.count -= 1;
              if (held.count > 0) return Effect.void;
              // A subscriber that came and went since leaves its own full grace.
              const idle = ++held.idle;
              return Effect.sleep(WATCH_GRACE).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (held.count === 0 && held.idle === idle && watches.get(threadId) === held)
                      watches.delete(threadId);
                  }),
                ),
                Effect.forkIn(hubScope),
                Effect.asVoid,
              );
            }),
        );
        const [read, retired] = yield* Effect.all(
          [readItemsAfter(threadId, watch.cursor), readRetirements([threadId], active)],
          { concurrency: 2 },
        );
        // Subscribed before the snapshot is taken: nothing published after it is missed.
        // Only this thread's changes are buffered for it.
        const published = yield* threadChanges.subscribe((change) => change.threadId === threadId);
        const opened = yield* locked(
          Effect.gen(function* () {
            // What the client missed is taken before catching up: the catch-up's own changes
            // reach it through `published`.
            const missed =
              afterSequence === undefined || watch.log === null || !sequencer.owns(afterSequence)
                ? null
                : watch.log.since(afterSequence, sequence);
            mergeItems(watch, read);
            applyRetirements(retired);
            const projection = yield* publishThread(threadId);
            return { missed, projection, at: sequence };
          }),
        );
        if (opened.projection === null) return null;
        yield* Effect.forkIn(readTurnCheckpoints(threadId), hubScope);
        const changes = published.pipe(Stream.map((change) => change.change));
        const subscribed: ThreadSubscription = {
          start:
            opened.missed === null
              ? {
                  kind: "snapshot",
                  snapshot: { snapshotSequence: opened.at, projection: opened.projection },
                }
              : { kind: "replay", changes: opened.missed },
          changes,
        };
        return subscribed;
      });

    const changeOfWorktree = (worktreePath: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        return yield* locked(
          Effect.sync((): WorktreeChange | null => {
            const source = threadSources().find(
              (candidate) => worktreePathOf(candidate.project, candidate.session) === worktreePath,
            );
            if (source === undefined || source.changeId === null) return null;
            return { changeId: source.changeId, baseRef: source.session.baseRef };
          }),
        );
      });

    // Images the person attached to a message never sent (a dropped draft) go after a week; the
    // hub looks once it starts and then every hour, and forgets what went.
    if (keeper !== null) {
      const pruneDrafts = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        state.pruneImages(now - UNSENT_IMAGE_TTL_MS, keeper.id),
      ).pipe(
        Effect.flatMap((gone) =>
          locked(
            Effect.sync(() => {
              for (const imageId of gone) images.delete(imageId);
            }),
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("t3 gateway could not let go of unsent images", {
            cause: error.message,
          }),
        ),
      );
      yield* Effect.forkIn(
        pruneDrafts.pipe(Effect.repeat(Schedule.spaced(IMAGE_PRUNE_INTERVAL))),
        hubScope,
      );
      yield* Effect.forkIn(
        // A hub nothing has read yet has no threads to settle: its first read settles them.
        Effect.suspend(() => (loaded ? readQuietWork({ onTimer: true }) : Effect.void)).pipe(
          Effect.repeat(Schedule.spaced(AUTO_SETTLE_SWEEP_INTERVAL)),
        ),
        hubScope,
      );
    }

    const turnDiff: PersonHub["turnDiff"] = (request) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(request.threadId);
        const found = yield* locked(
          Effect.sync(() => {
            const source = sourceOf(sessionId);
            return source === null
              ? null
              : {
                  worktreeId: source.session.worktreeId,
                  turns: source.turns.toSorted(byOrdinal),
                  chain: watches.get(sessionId)?.chain ?? null,
                };
          }),
        );
        if (found === null) {
          return yield* refused(`Thread ${request.threadId} is not in this environment.`);
        }
        const token = request.session.deviceToken;
        const readChain = mend
          .worktreeCheckpoints(token, found.worktreeId)
          .pipe(Effect.catchTag("MendNotFound", () => Effect.succeed([])));
        const cached = found.chain ?? (yield* readChain);
        const turnTo = found.turns[request.toTurnCount - 1];
        // The kept chain may predate the asked turn's checkpoint: read it again for that turn.
        const chain =
          turnTo !== undefined &&
          !turnSlicesOf(sessionId, found.turns, cached).has(turnTo.id) &&
          found.chain !== null
            ? yield* readChain
            : cached;
        const slices = turnSlicesOf(sessionId, found.turns, chain);
        const sliceOf = (count: number) => {
          const turn = found.turns[count - 1];
          return turn === undefined ? undefined : slices.get(turn.id);
        };
        const to = sliceOf(request.toTurnCount);
        if (to === undefined) {
          return yield* refused(
            `Mend has no checkpoint for turn ${request.toTurnCount} of this thread yet.`,
          );
        }
        // From the start: where the thread's first turn with a checkpoint started.
        const from =
          request.fromTurnCount === 0
            ? {
                checkpoint:
                  found.turns
                    .map((turn) => slices.get(turn.id))
                    .find((slice) => slice !== undefined)?.from ?? null,
              }
            : { checkpoint: sliceOf(request.fromTurnCount)?.to };
        if (from.checkpoint === undefined) {
          return yield* refused(
            `Mend has no checkpoint for turn ${request.fromTurnCount} of this thread.`,
          );
        }
        const range = yield* mend
          .worktreeDiff(token, found.worktreeId, {
            from: from.checkpoint?.id ?? null,
            to: to.to.id,
            ignoreWhitespace: request.ignoreWhitespace,
          })
          .pipe(
            Effect.catchTag("MendNotFound", (error) =>
              Effect.fail(
                new ThreadCommandRefused({ reason: error.message, authorization: false }),
              ),
            ),
          );
        // Mend renders a large slice's first files only; the client is told as t3code's own
        // server tells it of output it cut.
        return range.truncated ? `${range.diff}${TRUNCATED_MARKER}` : range.diff;
      });

    const locationOf = (cwd: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        return yield* locked(
          Effect.sync((): CwdLocation | null => {
            const thread = threadSources().find(
              (candidate) => worktreePathOf(candidate.project, candidate.session) === cwd,
            );
            if (thread !== undefined) {
              return {
                projectId: thread.project.id,
                sessionId: thread.session.id,
                changeId: thread.changeId,
                branch: thread.session.branch,
                defaultBranch: thread.project.defaultBranch,
                baseRef: thread.session.baseRef,
                hasOrigin: (thread.project.originUrl ?? null) !== null,
                worktreeId: thread.session.worktreeId,
                workspaceMutation: workspaceMutationOf(thread.session.worktreeId),
              };
            }
            const project = Array.from(projects.values()).find(
              (entry) => projectWorkspaceRootOf(entry.project, keeper?.id ?? "") === cwd,
            )?.project;
            return project === undefined
              ? null
              : {
                  projectId: project.id,
                  sessionId: null,
                  changeId: null,
                  branch: project.defaultBranch,
                  defaultBranch: project.defaultBranch,
                  baseRef: null,
                  hasOrigin: (project.originUrl ?? null) !== null,
                  worktreeId: null,
                  workspaceMutation: null,
                };
          }),
        );
      });

    // ─── Removing a worktree or a project (decision 11) ────────────────────

    /** Sessions of the worktree whose removal Mend has not finished: deleted, still saving. */
    const removalsUnderWay = (worktreeId: string) =>
      locked(
        Effect.sync(() =>
          Array.from(projects.values()).some((entry) =>
            entry.sessions.some(
              (session) => session.worktreeId === worktreeId && removing.has(session.id),
            ),
          ),
        ),
      );

    /**
     * Waits, at most `REMOVAL_SETTLE_WAIT`, for the worktree's deleted sessions to finish their
     * removal. t3code asks to remove the worktree right after deleting its last thread, whose stop
     * may still be saving; asked now, Mend would refuse every such yes as saving.
     */
    const settledRemovals = (worktreeId: string) =>
      Effect.gen(function* () {
        while (yield* removalsUnderWay(worktreeId)) yield* Effect.sleep(REMOVAL_SETTLE_LOOK);
      }).pipe(Effect.timeoutOrElse({ duration: REMOVAL_SETTLE_WAIT, orElse: () => Effect.void }));

    const removeWorktree: PersonHub["removeWorktree"] = (request) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const token = request.session.deviceToken;
        const project = yield* locked(
          Effect.sync(
            () =>
              Array.from(projects.values()).find((entry) => entry.project.storePath === request.cwd)
                ?.project ?? null,
          ),
        );
        if (project === null) return yield* new RemovalKept({ reason: NOT_A_PROJECT });
        const directory = worktreeDirectoryAt(project, request.path);
        if (directory === null) return yield* new RemovalKept({ reason: NOT_A_WORKTREE });
        const listed = yield* mend
          .listWorktrees(token, project.id)
          .pipe(
            Effect.catchTag("MendNotFound", () =>
              Effect.fail(new RemovalKept({ reason: PROJECT_NOT_LISTED })),
            ),
          );
        const [worktree, ...others] = listed.filter(
          (candidate) => candidate.directory === directory,
        );
        // Gone already: removed, as t3code's own server answers for a path that is not there.
        if (worktree === undefined) return;
        if (others.length > 0) return yield* new RemovalKept({ reason: AMBIGUOUS_WORKTREE });
        // Decision Q8: a recorded owner never changes, so one proven here is the one Mend checks.
        if (!hasProvenOwner(worktree)) {
          return yield* new RemovalKept({ reason: OWNERLESS_OUTSIDE_MEND });
        }
        yield* settledRemovals(worktree.id);
        const refusal = worktreeRemovalWords(yield* mend.removeWorktree(token, worktree.id));
        if (refusal !== null) return yield* new RemovalKept({ reason: refusal });
        yield* requestRefresh(`project:${project.id}`);
      });

    const removeProject: PersonHub["removeProject"] = (request) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const shown = yield* locked(
          Effect.sync(() => {
            const entry = projects.get(request.projectId);
            return entry === undefined
              ? null
              : projectShellOf(
                  entry.project,
                  projectScripts.get(entry.project.id) ?? [],
                  keeper?.id ?? "",
                );
          }),
        );
        if (shown === null) return yield* new RemovalKept({ reason: PROJECT_NOT_LISTED });
        const refusal = projectRemovalWords(
          yield* mend.removeProject(request.session.deviceToken, request.projectId),
        );
        if (refusal !== null) return yield* new RemovalKept({ reason: refusal });
        yield* projectRemoved(request.projectId);
        return { ...shown, deletedAt: DateTime.formatIso(yield* DateTime.now) };
      });

    /**
     * Mend removed the project: it and its threads leave the shell now, from Mend's answer alone,
     * and no read that began before it puts them back.
     */
    const projectRemoved = (projectId: string) =>
      locked(
        Effect.gen(function* () {
          removedProjects.add(projectId);
          const previous = projects.get(projectId);
          projects.delete(projectId);
          const finished: Array<string> = [];
          for (const session of previous?.sessions ?? []) {
            conversations.delete(session.id);
            adoptedTurns.delete(session.id);
            if (removing.delete(session.id)) finished.push(session.id);
          }
          yield* removed(finished);
          yield* publishAll;
        }),
      );

    const terminals = makeTerminals({
      mend,
      mendUrl: input.mendUrl ?? new URL("http://127.0.0.1:0"),
      threadSession: (threadId) =>
        ensureLoaded.pipe(
          Effect.andThen(
            locked(Effect.sync(() => sourceOf(sessionIdOf(threadId))?.session.id ?? null)),
          ),
          Effect.orElseSucceed(() => null),
        ),
    });
    // A hub that goes ends its terminals' sockets.
    yield* Effect.addFinalizer(() => terminals.closeAll);

    const worktreeFileOf = (path: string, threadId?: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const normalized = posix.normalize(path).replace(/(?<=.)\/+$/, "");
        return yield* locked(
          Effect.sync((): WorktreeFile | null => {
            for (const thread of threadSources()) {
              if (threadId !== undefined && thread.session.id !== sessionIdOf(threadId)) continue;
              const top = worktreePathOf(thread.project, thread.session);
              if (normalized !== top && !normalized.startsWith(`${top}/`)) continue;
              return {
                projectId: thread.project.id,
                sessionId: thread.session.id,
                worktreeId: thread.session.worktreeId,
                relativePath: normalized.slice(top.length + 1),
                workspaceMutation: workspaceMutationOf(thread.session.worktreeId),
              };
            }
            return null;
          }),
        );
      });

    const refreshSkillsAt: PersonHub["refreshSkillsAt"] = (deviceToken, cwd) =>
      Effect.gen(function* () {
        const location = yield* locationOf(cwd);
        const project = location === null ? undefined : projects.get(location.projectId)?.project;
        if (project === undefined) return null;
        const skills = yield* deliveredSkillsOf(deviceToken, project).pipe(
          Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
        );
        if (skills === null) return null;
        const workspace: WorkspaceSkills = {
          cwd,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          skills,
        };
        workspaceSkills.set(cwd, workspace);
        yield* providerSignals.publish(["skills"]);
        return workspace;
      });

    const archivedShell = ensureLoaded.pipe(
      Effect.andThen(locked(Effect.sync(currentArchivedShell))),
    );
    const subscribeArchivedShell = Effect.gen(function* () {
      yield* ensureLoaded;
      const changes = yield* archivedChanges.subscribe(() => true);
      const snapshot = yield* locked(Effect.sync(currentArchivedShell));
      return { snapshot, changes };
    });

    const settings = (session: BearerSession) =>
      state.modelPreferences(session.mendUser.id).pipe(Effect.map(keptSettingsOf));
    const updateModelPreferences = (session: BearerSession, patch: ModelPreferencesPatch) =>
      state
        .updateModelPreferences(session.mendUser.id, (current) =>
          boundedModelPreferences(applyModelPreferencesPatch(current, patch)),
        )
        .pipe(
          Effect.map(keptSettingsOf),
          Effect.tap((next) => settingsChanges.publish([next])),
          Effect.map((next) => next.settings),
        );
    const subscribeSettings = (session: BearerSession) =>
      Effect.gen(function* () {
        const changes = yield* settingsChanges.subscribe(() => true);
        const now = yield* settings(session);
        return Stream.concat(Stream.make(now), changes);
      });

    return {
      providerChanges: providerSignals.subscribe(() => true),
      refreshSkillsAt,
      workspaceSkills: () => Array.from(workspaceSkills.values()),
      settings,
      updateModelPreferences,
      subscribeSettings,
      archivedShell,
      subscribeArchivedShell,
      terminals,
      worktreeSetups: setups,
      saveProjectScripts,
      turnDiff,
      locationOf,
      worktreeFileOf,
      shellSnapshot,
      subscribeShell,
      threadSnapshot: (threadId: string) => threadSnapshot(sessionIdOf(threadId)),
      threadFinder: makeThreadFinder(input.parser),
      subscribeThread: (threadId: string, afterSequence?: number) =>
        subscribeThread(sessionIdOf(threadId), afterSequence),
      isRefused: tokens.isRefused,
      persistImages,
      imageOf,
      refusal: tokens.refusal,
      mend,
      commands,
      createProject,
      changeOfWorktree,
      removeWorktree,
      removeProject,
    };
  });

// ─── The registry ────────────────────────────────────────────────────────────

/** Every person's hub, one each, kept a while after their last socket closes. */
export class Projections extends Context.Service<
  Projections,
  {
    /** The person's hub, reading with this bearer's device token among theirs. */
    readonly hub: (session: BearerSession) => Effect.Effect<PersonHub, never, Scope.Scope>;
    /**
     * Mend refused a device token outside any hub (the session check): the same refusal the gate
     * makes, closing its sockets and revoking its bearers.
     */
    readonly refuseDevice: (userId: string, deviceToken: string) => Effect.Effect<void>;
    /** Whether Mend refused this device token since the gateway started. */
    readonly isDeviceRefused: (deviceToken: string) => boolean;
  }
>()("@mend/t3-gateway/Projections") {}

/** How often project creation reads the created project before it answers. */
const CREATED_READ_RETRY = "250 millis";
/**
 * How long a creation waits for the shell to hold the project before answering. t3code waits 10 s
 * for the project after the answer, and drops a socket silent for 15 s; half the first leaves room
 * for Mend's own creation call.
 */
const CREATED_SHOWN_WITHIN = "5 seconds";

/** How a launch reads its new session's project before it answers, and then in the background. */
const OPENING_READ_RETRY = "500 millis";
const OPENING_READ_ATTEMPTS = 3;
const OPENING_READ_BACKGROUND_ATTEMPTS = 60;

/** How long a kept queue waits before its person's hub reads Mend again after a failed read. */
const QUEUE_RESTORE_RETRY = "30 seconds";

/**
 * How a start's check of its paired devices waits for a Mend that does not answer: from 30 s,
 * doubling, at most an hour apart.
 */
const DEVICE_RECONCILE_RETRY = Schedule.min([
  Schedule.exponential("30 seconds"),
  Schedule.spaced("1 hour"),
]);

/** Mend not answering at all, or failing: worth asking again. A 4xx other than 401 is an answer. */
const isOutage = (error: MendUnavailable): boolean => error.status === null || error.status >= 500;

/** Why a change to a queue the state file could not keep was refused: nothing changed. */
const QUEUE_NOT_KEPT =
  "The gateway could not write this to its state file, so nothing changed. Try again.";

/** t3code's refusal of `queued-run.start` (`Orchestrator.ts`, v0.1.2), and Mend's for its own. */
const START_QUEUED_REFUSALS: Record<Exclude<Queueing.StartQueued, "started">, string> = {
  unknown: "Mend has not reported this thread's state yet. Try again in a moment.",
  busy: "A queued user message can only be sent now while the thread is stopped.",
  gone: "A queued user message can only be sent now while the thread is stopped.",
};

/** The queue's clock (`queue.ts`): monotonic milliseconds, never wall time. */
const queueNow = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1_000_000);

/** Why a message the state file could not keep was not sent. */
const NOT_KEPT =
  "The gateway could not write this message to its state file, so it did not send it. Send it again.";

/** The mode an agent started with; a launch that named none ran `bypass`. */
const modeOf = (agent: MendProcess): "bypass" | "ask" =>
  agent.protocolOptions?.permissionMode === "ask" ? "ask" : "bypass";

const isLive = (agent: MendProcess): boolean =>
  agent.exitedAt === null && agent.status === "running";

type CatalogRead = Exit.Exit<ReadonlyArray<MendHarnessCatalog>, HubReadError> | null;

const keptValueOf = (choice: NextChoice): string | null | undefined =>
  choice._tag === "Unchanged" ? undefined : choice._tag === "Chosen" ? choice.value : null;

const remember = (
  chosen: Map<string, string>,
  sessionId: string,
  value: string | null | undefined,
) => {
  if (value === null) chosen.delete(sessionId);
  else if (value !== undefined) chosen.set(sessionId, value);
};

const messageImageOf = (image: StoredImage): MessageImage => ({
  id: image.id,
  name: image.name,
  mimeType: image.mimeType,
  sizeBytes: image.sizeBytes,
});

const PLACEMENTS_AT_ONCE = 4;

const TOO_MANY_IMAGE_BYTES =
  "Images can total up to 80 MiB per message. Use smaller images or send fewer at once.";

/** How often a hub looks for images attached to a message never sent. */
const IMAGE_PRUNE_INTERVAL = "1 hour";
const AUTO_SETTLE_SWEEP_INTERVAL = "1 minute";
/** How many quiet threads' work the sweep reads from Mend at once. */
const QUIET_WORK_READS = 4;

/** How long an image attached to a message that was never sent is kept. */
const UNSENT_IMAGE_TTL_MS = 7 * 24 * 60 * 60_000;

/** How many turns of a thread get their files read for t3code's checkpoint cards. */
const TURN_SLICES_READ = 50;
/** How many slices' files a hub keeps. */
const SLICE_FILES_KEPT = 2_000;
const NO_TURN_CHECKPOINTS: ReadonlyMap<string, TurnCheckpoint> = new Map();

/** What t3code's server appends to output it cut (`OUTPUT_TRUNCATED_MARKER`). */
const TRUNCATED_MARKER = "\n\n[truncated]";

/** How soon a thread waiting for a turn's checkpoint reads its chain again. */
const CHAIN_REREAD_MS = 2_000;
/**
 * How many times, after a turn ends, the chain is read again for a checkpoint still missing: Mend
 * takes it within seconds, and a checkpoint that failed never comes.
 */
const CHAIN_REREADS = 10;

/** Whether the last ended turn has no checkpoint in `chain` yet. */
const awaitsCheckpoint = (
  sessionId: string,
  turns: ReadonlyArray<MendTurn>,
  chain: ReadonlyArray<MendCheckpoint>,
): boolean => {
  const last = turns
    .filter((turn) => turn.endedAt !== null)
    .toSorted(byOrdinal)
    .at(-1);
  return last !== undefined && !turnSlicesOf(sessionId, turns, chain).has(last.id);
};

/** How many sequences a hub reserves at a time (`reserveSequences`). */
const SEQUENCE_BLOCK = 1_000_000;
/** What a removal costs the replay log: an id and a tag. */
const REMOVAL_BYTES = 128;
/** What a replayed change's envelope (its kind, sequence, ids, event fields) adds, at most. */
const ENVELOPE_BYTES = 512;
/**
 * A replayed change's size as it goes out: its print's UTF-8 bytes and its envelope (review
 * 595-R2-N1), never the print's length in UTF-16 units, which counts a CJK character as one.
 */
const replayBytes = (print: string): number => Buffer.byteLength(print, "utf8") + ENVELOPE_BYTES;
/** How long a thread stays watched after its last subscriber: a reconnect resumes it by replay. */
const WATCH_GRACE = "2 minutes";

/** How long a hub outlives its last user: a client reconnecting finds it warm. */
export const HUB_IDLE_TTL = "2 minutes";

export const ProjectionsLive: Layer.Layer<
  Projections,
  never,
  MendClient | GatewayState | GatewayConfig | FindParser
> = Layer.effect(
  Projections,
  Effect.gen(function* () {
    const mend = yield* MendClient;
    const state = yield* GatewayState;
    const config = yield* GatewayConfig;
    const parser = yield* FindParser;
    /** Mend user id → the device tokens of theirs the gateway holds, in pairing order. */
    const known = new Map<string, Set<string>>();
    /** Mend user id → who they are, as their pairing recorded it: whom a hub reads for. */
    const viewers = new Map<string, { readonly id: string; readonly name: string }>();
    /** Device token → completed once Mend refuses it. */
    const refusals = new Map<string, Deferred.Deferred<void>>();
    const refusalOf = (token: string) => {
      const existing = refusals.get(token);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      refusals.set(token, created);
      return created;
    };
    const isRefused = (token: string) => {
      const refusal = refusals.get(token);
      return refusal !== undefined && Deferred.isDoneUnsafe(refusal);
    };
    /** Mend user id → completed once every token of theirs the gateway holds was refused. */
    const exhausted = new Map<string, Deferred.Deferred<void>>();
    const exhaustedOf = (userId: string) => {
      const existing = exhausted.get(userId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      exhausted.set(userId, created);
      return created;
    };
    const liveOf = (userId: string) =>
      Array.from(known.get(userId) ?? []).filter((token) => !isRefused(token));

    const tokensOf = (userId: string): PersonTokens => ({
      current: () => {
        for (const token of known.get(userId) ?? []) {
          if (!isRefused(token)) return token;
        }
        return null;
      },
      live: () => liveOf(userId),
      refuse: (token) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            if (isRefused(token)) return Effect.void;
            // The bearers standing for the device stop authenticating first. Completing the
            // refusal closes sockets and can tear the hub down, interrupting whoever found it
            // (its event stream or device check): written after, the revocation was lost.
            return Effect.flatMap(Clock.currentTimeMillis, (now) =>
              state.revokeSessionsForDevice(token, now),
            ).pipe(
              Effect.catch((error) =>
                Effect.logError("t3 gateway could not revoke a refused device's bearers", {
                  cause: error.message,
                }),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  Deferred.doneUnsafe(refusalOf(token), Exit.void);
                  // The last device of the person: their hub tears itself down.
                  if (liveOf(userId).length === 0) {
                    Deferred.doneUnsafe(exhaustedOf(userId), Exit.void);
                  }
                }),
              ),
            );
          }),
        ),
      isRefused,
      refusal: (token) => Deferred.await(refusalOf(token)),
      noneLeft: Deferred.await(exhaustedOf(userId)),
    });

    /** Mend user id → the scope holding their hub while a message is in the gateway's hands. */
    const keepers = new Map<string, Scope.Closeable>();
    const retainFor =
      (userId: string) =>
      (busy: boolean): Effect.Effect<void> =>
        Effect.suspend(() => {
          const held = keepers.get(userId);
          if (busy && held === undefined) {
            const scope = Scope.makeUnsafe();
            keepers.set(userId, scope);
            return RcMap.get(hubs, userId).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.asVoid,
            );
          }
          if (!busy && held !== undefined) {
            keepers.delete(userId);
            return Scope.close(held, Exit.void);
          }
          return Effect.void;
        });

    const hubs: RcMap.RcMap<string, PersonHub> = yield* RcMap.make({
      lookup: (userId: string) => {
        const tokens = tokensOf(userId);
        return makePersonHub({
          // Every call the hub makes with a device token goes through the gate.
          mend: gateDeviceCalls(mend, tokens.refuse),
          viewer: viewers.get(userId) ?? null,
          state,
          tokens,
          parser,
          retain: retainFor(userId),
          queueTimings: { ...Queueing.DEFAULT_QUEUE_TIMINGS, ...config.queueTimings },
          mendUrl: config.mendUrl,
          dispose: RcMap.invalidate(hubs, userId),
        });
      },
      idleTimeToLive: config.hubIdleTimeToLive ?? HUB_IDLE_TTL,
    });

    /** Makes the gateway hold a bearer's device token for its person. */
    const know = (session: BearerSession) => {
      const userId = session.mendUser.id;
      viewers.set(userId, { id: userId, name: session.mendUser.name });
      const tokens = known.get(userId) ?? new Set<string>();
      tokens.add(session.deviceToken);
      known.set(userId, tokens);
      // A person who pairs again after every device was revoked gets a fresh hub.
      const done = exhausted.get(userId);
      if (done !== undefined && Deferred.isDoneUnsafe(done) && liveOf(userId).length > 0) {
        exhausted.delete(userId);
      }
      return userId;
    };

    const hub = (session: BearerSession) => Effect.suspend(() => RcMap.get(hubs, know(session)));

    /**
     * After a restart, every person with a kept message that can still reach Mend gets their hub
     * back without waiting for a client: it reads Mend once, and holds itself while the message is
     * on its way (`retain`). Mend not answering yet is tried again; nothing kept is lost meanwhile.
     */
    const restoreQueues = Effect.gen(function* () {
      const senders = yield* state.peopleWithQueuedMessages();
      const people = new Set(senders.map(know));
      yield* Effect.forEach(
        people,
        (userId) =>
          Effect.scoped(
            RcMap.get(hubs, userId).pipe(Effect.flatMap((held) => held.shellSnapshot)),
          ).pipe(
            // A device Mend refused will not come back; only Mend not answering is waited out.
            Effect.retry({
              schedule: Schedule.spaced(QUEUE_RESTORE_RETRY),
              while: (error) => error._tag === "MendUnavailable",
            }),
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not bring a kept queue back", {
                cause: error.message,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("t3 gateway could not read its kept queues", { cause: error.message }),
      ),
    );
    // Dropped drafts of everyone, before any hub holds its images in memory; a hub then looks
    // after its own person's every hour.
    yield* state.pruneImages((yield* Clock.currentTimeMillis) - UNSENT_IMAGE_TTL_MS, null).pipe(
      Effect.catch((error) =>
        Effect.logWarning("t3 gateway could not let go of unsent images", {
          cause: error.message,
        }),
      ),
    );
    yield* Effect.forkScoped(restoreQueues);

    const refuseDevice = (userId: string, deviceToken: string) =>
      tokensOf(userId).refuse(deviceToken);

    /**
     * Every device a live bearer stands for, checked with Mend once on start: one revoked while
     * the gateway was not running gets its bearers revoked now, before any client of it asks.
     * Mend not answering yet is tried again; until then, a bearer is checked when it asks for a
     * ticket.
     */
    const reconcileDevices = Effect.gen(function* () {
      const sessions = yield* state.liveSessions(yield* Clock.currentTimeMillis);
      const devices = new Map(sessions.map((session) => [session.deviceToken, session] as const));
      yield* Effect.forEach(
        devices.values(),
        (session) =>
          mend.checkDevice(session.deviceToken).pipe(
            Effect.retry({ schedule: DEVICE_RECONCILE_RETRY, while: isOutage }),
            Effect.flatMap((verdict) =>
              // A person with no hub yet holds no known token, so this also completes their
              // "none left"; `know` clears it when one of their devices connects or pairs.
              verdict === "refused"
                ? refuseDevice(session.mendUser.id, session.deviceToken)
                : Effect.void,
            ),
            // Any other answer (a 403 or 404 from an older or misconfigured Mend) is not a
            // revocation and will not change by asking again: the device is left as it is, and
            // its tickets still ask Mend.
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not check a paired device with Mend", {
                cause: error.message,
                status: error.status,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("t3 gateway could not check its paired devices with Mend", {
          cause: error.message,
        }),
      ),
    );
    yield* Effect.forkScoped(reconcileDevices);

    return { hub, refuseDevice, isDeviceRefused: isRefused };
  }),
);
