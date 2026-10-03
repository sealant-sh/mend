import { PgClient } from "@effect/sql-pg";
import {
  type ContextSnapshotId,
  type OrganizationId,
  type ProjectId,
  type SealantRunId,
  type SealantWorkspaceId,
  SessionId,
  type Sha,
  type WorktreeId,
  WorkspaceImage,
} from "@mend/domain";
import {
  type CaptureDrainReason,
  captureAnswerReplaces,
  type CapturePosition,
  type EffortLevel,
  Session,
  SessionDotfiles,
  type NativeIngestCursor,
  type SessionExtraMount,
  type SessionOrigin,
  type SessionReferenceMount,
  type SessionStatus,
  withUnsavedAnswer,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentRequests,
  agentSessions,
  agentTurns,
  executorCaptureEvidence,
  executorEvidenceFences,
  projects,
  type StoredUnsavedAnswer,
} from "../schema/workbench.ts";
import { agentConversationLockKey } from "./agent-conversation.ts";

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: Schema.String,
  },
) {}

export interface NewSession {
  /** Caller-supplied: the engine mints the id before the row exists (socket dirs use it). */
  readonly id: SessionId;
  readonly projectId: ProjectId;
  /** The container this conversation runs in. */
  readonly worktreeId: WorktreeId;
  readonly harness: string;
  readonly label: string | null;
  /** Mirror of the worktree row's `directory` (pre-worktree readers). */
  readonly worktree: string;
  /** Mirror of the worktree row's `branch`. */
  readonly branch: string;
  /** Mirror of the worktree row's `baseSha`. */
  readonly baseSha: Sha;
  /** Mirror of the worktree row's `baseRef` (default branch when nothing was chosen). */
  readonly baseRef: string;
  readonly contextSnapshotId: ContextSnapshotId | null;
  /** Who provisioned the session — whose dotfiles apply at launch. */
  readonly ownerUserId: string | null;
  /** Where it was started from. */
  readonly origin: SessionOrigin;
  /**
   * Automatic landing for this session alone (docs/adr/0007-landing.md): `--land` / `--no-land`,
   * the composer's override, or a Slack request's `autopr=`. Absent or null follows the project.
   */
  readonly autoLand?: boolean | null;
}

/** One flush answer as a session records it (see `Session.capturePending`). */
export interface CaptureObservation {
  readonly pending: number;
  readonly pendingBytes: number | null;
  readonly refused: number | null;
  readonly registeredAt: Date | null;
  readonly observedAt: Date;
  /**
   * A final flush's answer only: why it did not complete (null once it did). Absent leaves the
   * recorded reason as it was — a suspend flush says nothing about a final one.
   */
  readonly incompleteReason?: string | null;
  /**
   * With `incompleteReason`: what sealantd named behind it (the snap's error, the first path it
   * could not read). Absent leaves it as it was.
   */
  readonly incompleteDetail?: string | null;
  /**
   * Whether the executor's snaps are failing, from any reading (a status read, a flush): since
   * when and sealantd's last error; null once they succeed again. Absent leaves it as it was.
   */
  readonly failing?: { readonly since: Date; readonly error: string | null } | null;
  /**
   * A capture step the executor reported still running past its bound, from any reading; null
   * once a reading reports none. Absent leaves it as it was.
   */
  readonly overdue?: {
    readonly step: string;
    readonly since: Date | null;
    readonly runningMs: number;
    readonly boundMs: number | null;
  } | null;
}

/**
 * The executor's own word that its final flush completed (`captureSaved`): which executor, when
 * Mend observed it, and the chain position it named.
 */
export interface CaptureSavedObservation {
  readonly workspaceId: string;
  readonly at: Date;
  readonly n: number | null;
  /** The lease epoch the answering executor shipped under; null when the answer did not say. */
  readonly epoch: number | null;
  /** Where in its own history the executor answered (0087); what orders it, never `at`. */
  readonly position?: CapturePosition | null;
}

/**
 * An executor's answer that said it held work not saved (`captureUnsavedWordsOf`): which
 * executor, when Mend took it, and in what words. Taken after a completed final flush or a seal,
 * it revokes that save (cross-repo decision 10); the executor's evidence keeps every one no other
 * was made after (`withUnsavedAnswer`, decision 25).
 */
export interface CaptureUnsavedObservation {
  readonly workspaceId: string;
  readonly at: Date;
  readonly words: string;
  /** Where in its own history the executor answered (0087); what orders it, never `at`. */
  readonly position?: CapturePosition | null;
}

/**
 * What one physical executor answered about its capture, whichever session asked (migration
 * 0086, cross-repo decision 14): its latest completed final flush and its latest answer that said
 * it held unsaved work. A joined session's read of the executor it shares is evidence about the
 * same disk as its holder's.
 */
export interface ExecutorCaptureEvidence {
  readonly workspaceId: string;
  /** The launch Mend knew for the executor when it answered, when it knew one. */
  readonly launchId: string | null;
  readonly saved: CaptureSavedObservation | null;
  /**
   * Every answer that said it held unsaved work and that no other kept one was made after, in
   * the executor's own order (0090, cross-repo decision 25, review 2026-09-28 (9) #4): a save
   * stands only over every one. The latest received is last. Empty: none.
   */
  readonly unsaved: ReadonlyArray<CaptureUnsavedObservation>;
  /**
   * Bumped by every answer taken from the executor (0087, cross-repo decision 18): a decision
   * made on what it read commits only while this is still what it read.
   */
  readonly version: number;
}

/**
 * One answer to add to an executor's evidence: a saved one replaces the kept one unless the
 * executor made it before that one (`captureAnswerReplaces`); an unsaved one joins the kept ones
 * (`withUnsavedAnswer`). An answer of neither kind (clean, or saying nothing either way) still
 * counts: the version moves.
 */
export interface ExecutorCaptureAnswer {
  readonly worktreeId: WorktreeId;
  readonly launchId: string | null;
  readonly saved?: CaptureSavedObservation;
  readonly unsaved?: CaptureUnsavedObservation;
}

/**
 * One answer an executor gave, published (migration 0088, review 2026-09-28 (7) #3): the reading on
 * the session that asked, its saved or unsaved word on that session, the answer added to the
 * executor's evidence, and the fence its ask opened cleared — in one transaction, so no restart
 * or failed write leaves one without the others.
 */
export interface ExecutorReading {
  readonly sessionId: SessionId;
  readonly workspaceId: string;
  /** The fence the ask opened (`openEvidenceFence`) and the engine process that holds it. */
  readonly fence: { readonly ticket: number; readonly holder: string };
  readonly observation: CaptureObservation;
  /** Where in its own history the executor made the answer; null when it did not say. */
  readonly position: CapturePosition | null;
  readonly saved: CaptureSavedObservation | null;
  readonly unsaved: CaptureUnsavedObservation | null;
  readonly answer: ExecutorCaptureAnswer;
}

/**
 * The executor's evidence once `answer` is weighed against what it keeps: a saved answer replaces
 * the kept one unless the executor made it before (`captureAnswerReplaces`); an unsaved one is
 * added to the kept ones, and only an answer made strictly after one ever removes it
 * (`withUnsavedAnswer`, cross-repo decision 25).
 */
const mergedEvidence = (
  kept: ExecutorCaptureEvidence | null,
  answer: ExecutorCaptureAnswer,
): {
  readonly saved: CaptureSavedObservation | null;
  readonly unsaved: ReadonlyArray<CaptureUnsavedObservation>;
} => ({
  saved:
    answer.saved !== undefined &&
    (kept?.saved === null ||
      kept === null ||
      captureAnswerReplaces(answer.saved.position, kept.saved?.position))
      ? answer.saved
      : (kept?.saved ?? null),
  unsaved:
    answer.unsaved === undefined
      ? (kept?.unsaved ?? [])
      : withUnsavedAnswer(kept?.unsaved ?? [], answer.unsaved),
});

/**
 * The columns that keep an executor's unsaved answers: all of them (`unsaved_answers`), and the
 * latest received again in `unsaved_*` for display.
 */
const unsavedColumns = (unsaved: ReadonlyArray<CaptureUnsavedObservation>) => {
  const latest = unsaved.at(-1) ?? null;
  return {
    unsavedAt: latest?.at ?? null,
    unsavedDetail: latest?.words ?? null,
    unsavedPosition: latest?.position ?? null,
    unsavedAnswers: unsaved.map(
      (answer): StoredUnsavedAnswer => ({
        at: answer.at.toISOString(),
        words: answer.words,
        position: answer.position ?? null,
      }),
    ),
  };
};

/** The owner's "discard unsaved and stop", as the session keeps it: when, and who. */
export interface CaptureDiscard {
  readonly at: Date;
  /** The owner's display name. */
  readonly by: string;
}

/** Terminal session states; `stopped` is the user's stop, not a failure. */
export type SessionOutcome = "completed" | "failed" | "stopped";

/**
 * The index of supervised agent sessions (plan §5.5) — table `agent_sessions`
 * (better-auth owns `"session"`). The recording stays in Sealant, addressed by
 * `(sealantRunId, sequence)` through SessionRunsRepo. `lastSeenSequence` is only the latest run's
 * denormalized progress for existing list contracts; it is not a supervision cursor.
 */
export class SessionsRepo extends Context.Service<
  SessionsRepo,
  {
    readonly create: (session: NewSession) => Effect.Effect<Session>;
    readonly byId: (id: SessionId) => Effect.Effect<Session, SessionNotFoundError>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Session>>;
    /** Every conversation in one worktree, newest first. */
    readonly listForWorktree: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<Session>>;
    /** Sessions in a live state, across projects — the Now inbox reads this. */
    readonly listActive: () => Effect.Effect<ReadonlyArray<Session>>;
    /** Sessions to re-attach to after a crash/restart. */
    readonly listUnsettled: () => Effect.Effect<ReadonlyArray<Session>>;
    /** One account's sessions that have not settled, starting ones included: what removal stops. */
    readonly listUnsettledForOwner: (userId: string) => Effect.Effect<ReadonlyArray<Session>>;
    /**
     * How many sessions in one organization's projects have not settled, starting ones included:
     * what the organization's session budget counts (docs/adr/0004, "Budgets").
     */
    readonly countUnsettledForOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<number>;
    /** Recently settled sessions — the boot sweep reaps any workspace that outlived them. */
    readonly listRecentlySettled: () => Effect.Effect<ReadonlyArray<Session>>;
    /**
     * The accounts that started sessions in this project since `since`, most recent first. The
     * hot pool warms for them; sessions labelled `excludeLabel` (Mend's own) do not count.
     */
    readonly recentOwnersForProject: (
      projectId: ProjectId,
      since: Date,
      excludeLabel: string,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly setSealantIds: (
      id: SessionId,
      sealantRunId: SealantRunId,
      workspaceId: SealantWorkspaceId,
    ) => Effect.Effect<void>;
    /** Persist the platform-returned expiry only if this is still the session's workspace. */
    readonly recordWorkspaceTtlRenewal: (
      id: SessionId,
      workspaceId: SealantWorkspaceId,
      expiresAt: Date | null,
      renewedAt: Date,
    ) => Effect.Effect<void>;
    /** Preserve the last known expiry while recording a failed renewal for the same workspace. */
    readonly recordWorkspaceTtlRenewalFailure: (
      id: SessionId,
      workspaceId: SealantWorkspaceId,
      error: string,
      failedAt: Date,
    ) => Effect.Effect<void>;
    /** The PTY session id — how a client reattaches to the live terminal. */
    readonly setSealantSessionId: (id: SessionId, sealantSessionId: string) => Effect.Effect<void>;
    /** The image this session actually launched with — stamped at launch, a recorded fact. */
    readonly setWorkspaceImage: (id: SessionId, image: WorkspaceImage) => Effect.Effect<void>;
    /** The dotfiles this session actually launched with — stamped at launch, a recorded fact. */
    readonly setDotfiles: (id: SessionId, dotfiles: SessionDotfiles) => Effect.Effect<void>;
    /** Record whether the harness left a conversation behind (settle-time classification). */
    readonly setHasTranscript: (id: SessionId, hasTranscript: boolean) => Effect.Effect<void>;
    /** Settled sessions the boot sweep has not classified yet, oldest first, bounded. */
    readonly listSettledUnclassified: (limit: number) => Effect.Effect<ReadonlyArray<Session>>;
    readonly setProviderSessionId: (id: SessionId, providerId: string) => Effect.Effect<void>;
    /** Mode-handoff backfill bookkeeping — not part of the Session surface. */
    readonly nativeIngestCursor: (id: SessionId) => Effect.Effect<NativeIngestCursor | null>;
    readonly setNativeIngestCursor: (
      id: SessionId,
      cursor: NativeIngestCursor,
    ) => Effect.Effect<void>;
    /** What launch actually mounted beside the worktree — recorded once, at launch. */
    readonly setReferenceMounts: (
      id: SessionId,
      mounts: ReadonlyArray<SessionReferenceMount>,
    ) => Effect.Effect<void>;
    /** The project folders launch actually bound — recorded once, at launch. */
    readonly setExtraMounts: (
      id: SessionId,
      mounts: ReadonlyArray<SessionExtraMount>,
    ) => Effect.Effect<void>;
    readonly setStatus: (id: SessionId, status: SessionStatus) => Effect.Effect<void>;
    readonly saveLastSeenSequence: (id: SessionId, sequence: bigint) => Effect.Effect<void>;
    /** Live progress pointer for the Now feed and session page (plan §9.4). */
    readonly notifyProgress: (id: SessionId, sequence: bigint, line: string) => Effect.Effect<void>;
    /**
     * First settle wins. Capture mode: a session whose stop drain still holds its workspace
     * (`captureDrain` `stop`) is not settled — it reads `stopping`, with the summary, until the
     * drain ends on an observed termination and the engine settles it again.
     */
    readonly settle: (
      id: SessionId,
      outcome: SessionOutcome,
      summary: string | null,
    ) => Effect.Effect<void>;
    /**
     * Clear `settledAt` and write a live status: `running` when an agent process starts (a
     * launch, a delivered follow-up, a resume), `idle` when a supporting process rejoins a
     * settled session's workspace. Same row, same worktree, same change.
     */
    readonly reopen: (id: SessionId, status: "running" | "idle") => Effect.Effect<void>;
    /**
     * The idle stop's claim (`protocolIdleReading`): stamps `idleStoppedAt` on an unsettled
     * session with no turn in flight and no pending request, and answers true for the one caller
     * whose stamp landed. A stamp older than `retryBefore` is taken again: its stop never landed.
     * `reopen` clears it.
     */
    readonly claimIdleStop: (id: SessionId, retryBefore: Date) => Effect.Effect<boolean>;
    /** Give the claim back when the stop it was for failed. */
    readonly releaseIdleStop: (id: SessionId) => Effect.Effect<void>;
    /**
     * Rewrite the summary of a session without settling it — what was observed since the
     * last settle (a replacement executor answering after "executor lost"). `reopen` touches
     * status alone, so a picked-up session would otherwise keep reading the loss.
     */
    readonly setSummary: (id: SessionId, summary: string | null) => Effect.Effect<void>;
    /**
     * A settled session's outcome and summary, rewritten from what was observed since it settled
     * (its executor saved after all, ended later, or was never made): the latest observation is
     * what it reads. Only while it stays settled — a session that reopened keeps its live status.
     */
    readonly restate: (
      id: SessionId,
      outcome: SessionOutcome,
      summary: string | null,
    ) => Effect.Effect<void>;
    readonly setLabel: (id: SessionId, label: string | null) => Effect.Effect<void>;
    /** Share control as `enabledByUserId`, or stop sharing with null; answers the updated row. */
    readonly setSharedControl: (
      id: SessionId,
      enabledByUserId: string | null,
    ) => Effect.Effect<Session, SessionNotFoundError>;
    /** Stop sharing every session of one account: what removing them does first. Answers which. */
    readonly disableSharedControlForOwner: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<SessionId>>;
    /** The auto-namer's write: fills the label only while null; true when the write landed. */
    readonly setLabelIfUnset: (id: SessionId, label: string) => Effect.Effect<boolean>;
    /** Hard delete — comments, checkpoints, follow-ups, change and tour cascade. */
    readonly remove: (id: SessionId) => Effect.Effect<void>;
    /**
     * Capture mode: what the session's executor answered to a flush just now (0075). Written on
     * every drain step and every reading an idle stop or a landing takes.
     */
    readonly recordCaptureObservation: (
      id: SessionId,
      observation: CaptureObservation,
    ) => Effect.Effect<void>;
    /**
     * The durable drain intent (docs/adr/0002, "Stop drains, then terminates"). The first reason
     * stands, with the first request and progress times: a restart, or a sweep's stop, does not
     * reset a drain's history or turn a relaunch into a stop. A relaunch is asked with
     * `planRelaunch`. A stop drain unsettles a settled session into `stopping`: its container
     * still runs until the drain ends.
     */
    readonly beginCaptureDrain: (
      id: SessionId,
      reason: CaptureDrainReason,
      at: Date,
    ) => Effect.Effect<void>;
    /**
     * A relaunch drains the old executor, then launches `resume` (a harness, or `shell`): both
     * steps durable, so a restart between them finishes the relaunch.
     */
    readonly planRelaunch: (id: SessionId, resume: string, at: Date) => Effect.Effect<void>;
    /** The relaunch ran its course, or the user's stop cancelled it. */
    readonly clearRelaunch: (id: SessionId) => Effect.Effect<void>;
    /**
     * The user's stop wins over a drain under way for another reason (a replacement, a
     * relaunch): the drain goes on, and what follows it is a stop — here and after a restart.
     * History (request and progress times, `not saved`) stands. A settled session reads
     * `stopping` again, as any stop drain does.
     */
    readonly stopCaptureDrain: (id: SessionId) => Effect.Effect<void>;
    /** The harness a planned relaunch resumes with, or null. */
    readonly relaunchOf: (id: SessionId) => Effect.Effect<string | null>;
    /**
     * A final flush is about to be sent to `workspaceId`: from then on it admits nothing, so
     * nothing is started, joined or resumed in it again.
     */
    readonly markFinalFlush: (id: SessionId, workspaceId: string) => Effect.Effect<void>;
    /** The executor this session sent a final flush to, or null. */
    readonly finalFlushedWorkspace: (id: SessionId) => Effect.Effect<string | null>;
    /**
     * An executor answered `complete: true` with nothing pending: it stopped every writer,
     * snapshotted both classes and registered them. The latest such answer stands; nothing that
     * executor says later takes it back (it admits nothing after its final flush).
     */
    readonly recordCaptureSaved: (
      id: SessionId,
      saved: CaptureSavedObservation,
    ) => Effect.Effect<void>;
    /** The last completed final flush Mend observed for this session's executors, or null. */
    readonly captureSavedOf: (id: SessionId) => Effect.Effect<CaptureSavedObservation | null>;
    /**
     * An executor answered that it held unsaved work (pending, incomplete, unreadable, a failing
     * snap, bulk changed): the latest such answer stands. Nothing takes it back — a newer
     * completed final flush stands over it by being newer.
     */
    readonly recordCaptureUnsaved: (
      id: SessionId,
      unsaved: CaptureUnsavedObservation,
    ) => Effect.Effect<void>;
    /** The latest unsaved answer Mend observed from this session's executors, or null. */
    readonly captureUnsavedOf: (id: SessionId) => Effect.Effect<CaptureUnsavedObservation | null>;
    /**
     * An answer the executor in `workspaceId` gave, whoever asked, added to that executor's
     * evidence (0086): a completed final flush, or unsaved work, each kept unless the executor
     * made it before the kept one (0087); every answer moves the version. Answers the new
     * version.
     */
    readonly recordExecutorEvidence: (
      workspaceId: string,
      answer: ExecutorCaptureAnswer,
    ) => Effect.Effect<number>;
    /** Everything the executor in `workspaceId` answered that Mend kept, or null. */
    readonly executorEvidenceOf: (
      workspaceId: string,
    ) => Effect.Effect<ExecutorCaptureEvidence | null>;
    /**
     * An answer is about to be asked of the executor in `workspaceId` (0088, review 2026-09-28
     * (7) #3): its fence, durable before the ask. Answers the ticket.
     */
    readonly openEvidenceFence: (workspaceId: string, holder: string) => Effect.Effect<number>;
    /**
     * The ask came back without publishing: `unanswered` (nothing arrived) deletes the fence;
     * `unpublished` (an answer arrived and its publication failed) keeps it until an answer
     * asked after it is published.
     */
    readonly closeEvidenceFence: (
      ticket: number,
      outcome: "unanswered" | "unpublished",
    ) => Effect.Effect<void>;
    /** Whether any answer of the executor in `workspaceId` is asked and not yet published. */
    readonly evidenceFenced: (workspaceId: string) => Effect.Effect<boolean>;
    /**
     * Publish one answer (`ExecutorReading`) in one transaction; answers the executor's new
     * evidence version. Clears its own fence, and every earlier one that is unpublished or held
     * by another engine process (one that is gone, or whose answer this one supersedes).
     */
    readonly publishExecutorReading: (reading: ExecutorReading) => Effect.Effect<number>;
    /** Where the executor made the answer behind the session's queue reading, or null (0088). */
    readonly captureObservedPositionOf: (id: SessionId) => Effect.Effect<CapturePosition | null>;
    /** Something moved: the stall window starts again and `not saved` clears. */
    readonly recordCaptureDrainProgress: (id: SessionId, at: Date) => Effect.Effect<void>;
    /** Nothing moved for the stall window: true only for the write that set it (one alert). */
    readonly markCaptureNotSaved: (id: SessionId, at: Date) => Effect.Effect<boolean>;
    /** The workspace is saved and terminated, or discarded: no drain is under way. */
    /**
     * The drain is over. `discarded`: it ended because the owner discarded what the executor had
     * not saved — kept on the session (`unsaved work discarded by … at …`) until it runs again.
     */
    readonly endCaptureDrain: (id: SessionId, discarded?: CaptureDiscard) => Effect.Effect<void>;
    /**
     * Every session with a drain under way or a relaunch not yet launched, oldest first: what the
     * reaper takes up again.
     */
    readonly listCaptureDrains: () => Effect.Effect<ReadonlyArray<Session>>;
    /** Stamp the current executor's start — what the platform's cap counts from. */
    readonly setExecutorStartedAt: (id: SessionId, at: Date) => Effect.Effect<void>;
    /**
     * The platform accepted this session's executor (capture mode): its workspace is the
     * session's from now on, before anything runs in it — a setup command, the harness — so a
     * launch that fails or is cut short after this still names the executor that may hold its
     * work. The run and the PTY follow once the harness starts (`setSealantIds`).
     */
    readonly recordAcceptedWorkspace: (
      id: SessionId,
      workspaceId: SealantWorkspaceId,
      executorStartedAt: Date,
      /** Its launch identity: the create's idempotency key (cross-repo decision 5). */
      launchId: string,
    ) => Effect.Effect<void>;
    /**
     * The runtime identity of the executor in `workspaceId` (`details().runtime.resourceId`),
     * recorded only while that is still the session's workspace.
     */
    readonly recordExecutorResource: (
      id: SessionId,
      workspaceId: SealantWorkspaceId,
      resourceId: string,
    ) => Effect.Effect<void>;
    /**
     * An executor create is about to be asked under `key` (idempotent on the platform): until its
     * answer is on the row (`recordAcceptedWorkspace`) or it was refused (`clearExecutorCreate`),
     * an executor may exist that Mend has not seen.
     */
    readonly recordExecutorCreate: (id: SessionId, key: string) => Effect.Effect<void>;
    /** The create was refused: nothing was made under `key`. Only while `key` still stands. */
    readonly clearExecutorCreate: (id: SessionId, key: string) => Effect.Effect<void>;
    /** The key of the session's create not yet answered on the row, or null. */
    readonly executorCreateOf: (id: SessionId) => Effect.Effect<string | null>;
    /** Every session with a create not yet answered on its row. */
    readonly listExecutorCreates: () => Effect.Effect<
      ReadonlyArray<{ readonly sessionId: SessionId; readonly key: string }>
    >;
    /**
     * The session's current executor's runtime identity, with the workspace and the launch it
     * belongs to.
     */
    readonly executorResourceOf: (id: SessionId) => Effect.Effect<{
      readonly workspaceId: SealantWorkspaceId;
      readonly resourceId: string;
      readonly launchId: string | null;
    } | null>;
    /**
     * The session's current executor's launch identity, with its workspace (0083): what its
     * token and its `final_seal.executor` name. Null while the row names no workspace or no
     * launch was recorded for it.
     */
    readonly executorLaunchOf: (id: SessionId) => Effect.Effect<{
      readonly workspaceId: SealantWorkspaceId;
      readonly launchId: string;
    } | null>;
    /** Removal asked while the workspace was up; the sweep removes the row once it has gone. */
    readonly requestRemoval: (id: SessionId, at: Date) => Effect.Effect<void>;
    /** Sessions whose removal waits on their workspace. */
    readonly listRemovalRequested: () => Effect.Effect<ReadonlyArray<Session>>;
    readonly setHarness: (id: SessionId, harness: string) => Effect.Effect<void>;
    /**
     * The model and effort a launch resolved for the session (docs/models-audit.md): written
     * before the harness starts, so the row says what runs even while the workspace builds.
     */
    readonly setLaunchOptions: (
      id: SessionId,
      options: { readonly model: string | null; readonly effort: EffortLevel | null },
    ) => Effect.Effect<void>;
  }
>()("@mend/db/SessionsRepo") {}

const decodeWorkspaceImage = Schema.decodeUnknownSync(WorkspaceImage);
const decodeSessionDotfiles = Schema.decodeUnknownSync(SessionDotfiles);

/** The overdue step an observation reports, as the session's columns hold it (0093). */
const overdueColumns = (observation: CaptureObservation) =>
  observation.overdue === undefined
    ? {}
    : observation.overdue === null
      ? {
          captureOverdueStep: null,
          captureOverdueSince: null,
          captureOverdueRunningMs: null,
          captureOverdueBoundMs: null,
        }
      : {
          captureOverdueStep: observation.overdue.step,
          captureOverdueSince: observation.overdue.since,
          captureOverdueRunningMs: observation.overdue.runningMs,
          captureOverdueBoundMs: observation.overdue.boundMs,
        };

const toSession = (row: typeof agentSessions.$inferSelect): Session =>
  new Session({
    ...row,
    workspaceImage: row.workspaceImage === null ? null : decodeWorkspaceImage(row.workspaceImage),
    dotfiles: row.dotfiles === null ? null : decodeSessionDotfiles(row.dotfiles),
  });

// Compile-time seam tripwire: the `...row` spread above silently ignores any
// column the Session schema doesn't know, so a column added to (or renamed in)
// agent_sessions MUST land in @mend/domain's Session in the same change — and
// vice versa. This fails to compile the moment either side drifts.
type SessionRow = typeof agentSessions.$inferSelect;
type ExactKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
  ? true
  : never;
/**
 * Persistence-only bookkeeping deliberately absent from the Session surface:
 * the mode-handoff ingest cursor and a relaunch's harness are read and written
 * through their own repo methods, never carried on the domain object.
 * Everything else stays exact.
 */
type SessionBookkeepingColumns =
  | "nativeIngestCursor"
  | "captureDrainResume"
  | "captureFinalWorkspaceId"
  | "captureSavedWorkspaceId"
  | "captureSavedAt"
  | "captureSavedN"
  | "captureSavedEpoch"
  | "captureUnsavedWorkspaceId"
  | "captureUnsavedAt"
  | "captureUnsavedDetail"
  | "captureObservedPosition"
  | "executorResourceId"
  | "executorCreateKey"
  | "executorLaunchId";
const sessionSeamIntact: ExactKeys<Omit<SessionRow, SessionBookkeepingColumns>, Session> = true;
void sessionSeamIntact;

export const SessionsRepoLive: Layer.Layer<SessionsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    SessionsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;

      const projectIdOf = Effect.fn("SessionsRepo.projectIdOf")(function* (id: SessionId) {
        const [row] = yield* db
          .select({ projectId: agentSessions.projectId })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.projectId ?? "";
      });

      const notify = Effect.fn("SessionsRepo.notify")(function* (id: SessionId) {
        const projectId = yield* projectIdOf(id);
        yield* notifyEvent(pg, { type: "session", sessionId: id, projectId });
      });

      const create = Effect.fn("SessionsRepo.create")(function* (session: NewSession) {
        const [row] = yield* db
          .insert(agentSessions)
          .values({ ...session, recordHistoryComplete: true })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("session insert returned no row");
        const created = toSession(row);
        yield* notifyEvent(pg, {
          type: "session",
          sessionId: created.id,
          projectId: session.projectId,
        });
        return created;
      });

      const byId = Effect.fn("SessionsRepo.byId")(function* (id: SessionId) {
        const [row] = yield* db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new SessionNotFoundError({ sessionId: id });
        return toSession(row);
      });

      const listForProject = Effect.fn("SessionsRepo.listForProject")(function* (
        projectId: ProjectId,
      ) {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.projectId, projectId))
          .orderBy(desc(agentSessions.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const listForWorktree = Effect.fn("SessionsRepo.listForWorktree")(function* (
        worktreeId: WorktreeId,
      ) {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.worktreeId, worktreeId))
          .orderBy(desc(agentSessions.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const listActive = Effect.fn("SessionsRepo.listActive")(function* () {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(inArray(agentSessions.status, ["starting", "running", "waiting", "idle"]))
          .orderBy(desc(agentSessions.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const listUnsettled = Effect.fn("SessionsRepo.listUnsettled")(function* () {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(and(isNull(agentSessions.settledAt), ne(agentSessions.status, "starting")))
          .orderBy(asc(agentSessions.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const recentOwnersForProject = Effect.fn("SessionsRepo.recentOwnersForProject")(function* (
        projectId: ProjectId,
        since: Date,
        excludeLabel: string,
      ) {
        const latest = sql<Date>`max(${agentSessions.createdAt})`;
        const rows = yield* db
          .select({ ownerUserId: agentSessions.ownerUserId, latest })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.projectId, projectId),
              isNotNull(agentSessions.ownerUserId),
              gt(agentSessions.createdAt, since),
              sql`${agentSessions.label} IS DISTINCT FROM ${excludeLabel}`,
            ),
          )
          .groupBy(agentSessions.ownerUserId)
          .orderBy(desc(latest))
          .pipe(Effect.orDie);
        return rows.flatMap((row) => (row.ownerUserId === null ? [] : [row.ownerUserId]));
      });

      const listUnsettledForOwner = Effect.fn("SessionsRepo.listUnsettledForOwner")(function* (
        userId: string,
      ) {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(and(eq(agentSessions.ownerUserId, userId), isNull(agentSessions.settledAt)))
          .orderBy(asc(agentSessions.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const countUnsettledForOrganization = Effect.fn("SessionsRepo.countUnsettledForOrganization")(
        function* (organizationId: OrganizationId) {
          const rows = yield* db
            .select({ count: sql<number>`count(*)::int` })
            .from(agentSessions)
            .innerJoin(projects, eq(projects.id, agentSessions.projectId))
            .where(
              and(eq(projects.organizationId, organizationId), isNull(agentSessions.settledAt)),
            )
            .pipe(Effect.orDie);
          return rows[0]?.count ?? 0;
        },
      );

      const listRecentlySettled = Effect.fn("SessionsRepo.listRecentlySettled")(function* () {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(
            and(
              isNotNull(agentSessions.settledAt),
              gt(agentSessions.settledAt, sql`now() - interval '24 hours'`),
              isNotNull(agentSessions.sealantWorkspaceId),
            ),
          )
          .orderBy(desc(agentSessions.settledAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const setSealantIds = Effect.fn("SessionsRepo.setSealantIds")(function* (
        id: SessionId,
        sealantRunId: SealantRunId,
        workspaceId: SealantWorkspaceId,
      ) {
        // The launch and runtime recorded for the executor stay only while the row still names
        // its workspace: a session that joins another's executor names none of its own.
        const sameExecutor = sql`${agentSessions.sealantWorkspaceId} IS NOT DISTINCT FROM ${workspaceId}`;
        yield* db
          .update(agentSessions)
          .set({
            sealantRunId,
            sealantWorkspaceId: workspaceId,
            executorLaunchId: sql`CASE WHEN ${sameExecutor} THEN ${agentSessions.executorLaunchId} END`,
            executorResourceId: sql`CASE WHEN ${sameExecutor} THEN ${agentSessions.executorResourceId} END`,
            workspaceExpiresAt: null,
            workspaceTtlRenewedAt: null,
            workspaceTtlRenewalFailedAt: null,
            workspaceTtlRenewalError: null,
            lastSeenSequence: 0n,
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const recordWorkspaceTtlRenewal = Effect.fn("SessionsRepo.recordWorkspaceTtlRenewal")(
        function* (
          id: SessionId,
          workspaceId: SealantWorkspaceId,
          expiresAt: Date | null,
          renewedAt: Date,
        ) {
          const rows = yield* db
            .update(agentSessions)
            .set({
              workspaceExpiresAt: expiresAt,
              workspaceTtlRenewedAt: renewedAt,
              workspaceTtlRenewalFailedAt: null,
              workspaceTtlRenewalError: null,
              updatedAt: renewedAt,
            })
            .where(and(eq(agentSessions.id, id), eq(agentSessions.sealantWorkspaceId, workspaceId)))
            .returning({ id: agentSessions.id })
            .pipe(Effect.orDie);
          if (rows.length > 0) yield* notify(id);
        },
      );

      const recordWorkspaceTtlRenewalFailure = Effect.fn(
        "SessionsRepo.recordWorkspaceTtlRenewalFailure",
      )(function* (id: SessionId, workspaceId: SealantWorkspaceId, error: string, failedAt: Date) {
        const rows = yield* db
          .update(agentSessions)
          .set({
            workspaceTtlRenewalFailedAt: failedAt,
            workspaceTtlRenewalError: error,
            updatedAt: failedAt,
          })
          .where(and(eq(agentSessions.id, id), eq(agentSessions.sealantWorkspaceId, workspaceId)))
          .returning({ id: agentSessions.id })
          .pipe(Effect.orDie);
        if (rows.length > 0) yield* notify(id);
      });

      const setSealantSessionId = Effect.fn("SessionsRepo.setSealantSessionId")(function* (
        id: SessionId,
        sealantSessionId: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ sealantSessionId, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setWorkspaceImage = Effect.fn("SessionsRepo.setWorkspaceImage")(function* (
        id: SessionId,
        image: WorkspaceImage,
      ) {
        yield* db
          .update(agentSessions)
          .set({ workspaceImage: image, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setDotfiles = Effect.fn("SessionsRepo.setDotfiles")(function* (
        id: SessionId,
        dotfiles: SessionDotfiles,
      ) {
        yield* db
          .update(agentSessions)
          .set({ dotfiles, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setHasTranscript = Effect.fn("SessionsRepo.setHasTranscript")(function* (
        id: SessionId,
        hasTranscript: boolean,
      ) {
        yield* db
          .update(agentSessions)
          .set({ hasTranscript, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const listSettledUnclassified = Effect.fn("SessionsRepo.listSettledUnclassified")(function* (
        limit: number,
      ) {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(and(isNotNull(agentSessions.settledAt), isNull(agentSessions.hasTranscript)))
          .orderBy(asc(agentSessions.settledAt))
          .limit(limit)
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const setProviderSessionId = Effect.fn("SessionsRepo.setProviderSessionId")(function* (
        id: SessionId,
        providerId: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ providerSessionId: providerId, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const nativeIngestCursor = Effect.fn("SessionsRepo.nativeIngestCursor")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({ nativeIngestCursor: agentSessions.nativeIngestCursor })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.nativeIngestCursor ?? null;
      });

      const setNativeIngestCursor = Effect.fn("SessionsRepo.setNativeIngestCursor")(function* (
        id: SessionId,
        cursor: NativeIngestCursor,
      ) {
        yield* db
          .update(agentSessions)
          .set({ nativeIngestCursor: cursor, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setReferenceMounts = Effect.fn("SessionsRepo.setReferenceMounts")(function* (
        id: SessionId,
        mounts: ReadonlyArray<SessionReferenceMount>,
      ) {
        yield* db
          .update(agentSessions)
          .set({ referenceMounts: mounts, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setExtraMounts = Effect.fn("SessionsRepo.setExtraMounts")(function* (
        id: SessionId,
        mounts: ReadonlyArray<SessionExtraMount>,
      ) {
        yield* db
          .update(agentSessions)
          .set({ extraMounts: mounts, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const setStatus = Effect.fn("SessionsRepo.setStatus")(function* (
        id: SessionId,
        status: SessionStatus,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            status,
            updatedAt: new Date(),
            ...(status === "running"
              ? { startedAt: sql`COALESCE(${agentSessions.startedAt}, now())` }
              : {}),
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const saveLastSeenSequence = Effect.fn("SessionsRepo.saveLastSeenSequence")(function* (
        id: SessionId,
        sequence: bigint,
      ) {
        yield* db
          .update(agentSessions)
          .set({ lastSeenSequence: sequence, updatedAt: new Date() })
          .where(and(eq(agentSessions.id, id), lt(agentSessions.lastSeenSequence, sequence)))
          .pipe(Effect.orDie);
      });

      const notifyProgress = Effect.fn("SessionsRepo.notifyProgress")(function* (
        id: SessionId,
        sequence: bigint,
        line: string,
      ) {
        const projectId = yield* projectIdOf(id);
        yield* notifyEvent(pg, {
          type: "session-progress",
          sessionId: id,
          projectId,
          sequence: String(sequence),
          line,
        });
      });

      const settle = Effect.fn("SessionsRepo.settle")(function* (
        id: SessionId,
        outcome: SessionOutcome,
        summary: string | null,
      ) {
        // First settle wins. Two supervisors watch every session (run-wait and
        // the PTY status poll), and the loser used to overwrite a deliberate
        // "stopped" with "failed · harness exited with code -1" — every user
        // stop read as a crash. `reopen` clears settled_at, so a resumed
        // session settles again normally.
        const now = new Date();
        // A stop drain holds the workspace: `stopping`, not settled, until the drain ends.
        const holding = sql`${agentSessions.captureDrain} = 'stop'`;
        yield* db
          .update(agentSessions)
          .set({
            status: sql`CASE WHEN ${holding} THEN 'stopping' ELSE ${outcome}::text END`,
            summary,
            settledAt: sql`CASE WHEN ${holding} THEN NULL ELSE ${now}::timestamptz END`,
            updatedAt: now,
          })
          .where(and(eq(agentSessions.id, id), isNull(agentSessions.settledAt)))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const setSummary = Effect.fn("SessionsRepo.setSummary")(function* (
        id: SessionId,
        summary: string | null,
      ) {
        yield* db
          .update(agentSessions)
          .set({ summary, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const restate = Effect.fn("SessionsRepo.restate")(function* (
        id: SessionId,
        outcome: SessionOutcome,
        summary: string | null,
      ) {
        yield* db
          .update(agentSessions)
          .set({ status: outcome, summary, updatedAt: new Date() })
          .where(and(eq(agentSessions.id, id), isNotNull(agentSessions.settledAt)))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      /** A session is a continuous piece of work; the harness is the tool currently driving it. */
      const setLabel = Effect.fn("SessionsRepo.setLabel")(function* (
        id: SessionId,
        label: string | null,
      ) {
        yield* db
          .update(agentSessions)
          .set({ label, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const setSharedControl = Effect.fn("SessionsRepo.setSharedControl")(function* (
        id: SessionId,
        enabledByUserId: string | null,
      ) {
        const [row] = yield* db
          .update(agentSessions)
          .set({
            sharedControlEnabledByUserId: enabledByUserId,
            sharedControlEnabledAt: enabledByUserId === null ? null : new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new SessionNotFoundError({ sessionId: id });
        yield* notify(id);
        if (enabledByUserId === null) {
          yield* notifyEvent(pg, {
            type: "shared-control-off",
            sessionId: id,
            projectId: row.projectId,
            ownerUserId: row.ownerUserId,
          });
        }
        return toSession(row);
      });

      const disableSharedControlForOwner = Effect.fn("SessionsRepo.disableSharedControlForOwner")(
        function* (userId: string) {
          const rows = yield* db
            .update(agentSessions)
            .set({
              sharedControlEnabledByUserId: null,
              sharedControlEnabledAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(agentSessions.ownerUserId, userId),
                isNotNull(agentSessions.sharedControlEnabledAt),
              ),
            )
            .returning({ id: agentSessions.id, projectId: agentSessions.projectId })
            .pipe(Effect.orDie);
          yield* Effect.forEach(
            rows,
            (row) =>
              notify(row.id).pipe(
                Effect.andThen(
                  notifyEvent(pg, {
                    type: "shared-control-off",
                    sessionId: row.id,
                    projectId: row.projectId,
                    ownerUserId: userId,
                  }),
                ),
              ),
            { discard: true },
          );
          return rows.map((row) => row.id);
        },
      );

      /**
       * The auto-namer's write: fills the label ONLY while it is still null,
       * so a user-typed label (or an earlier naming) always wins the race.
       * Returns whether the write landed.
       */
      const setLabelIfUnset = Effect.fn("SessionsRepo.setLabelIfUnset")(function* (
        id: SessionId,
        label: string,
      ) {
        const rows = yield* db
          .update(agentSessions)
          .set({ label, updatedAt: new Date() })
          .where(and(eq(agentSessions.id, id), isNull(agentSessions.label)))
          .returning({ id: agentSessions.id })
          .pipe(Effect.orDie);
        if (rows.length === 0) return false;
        yield* notify(id);
        return true;
      });

      const remove = Effect.fn("SessionsRepo.remove")(function* (id: SessionId) {
        const [row] = yield* db
          .delete(agentSessions)
          .where(eq(agentSessions.id, id))
          .returning({ projectId: agentSessions.projectId })
          .pipe(Effect.orDie);
        if (row !== undefined) {
          yield* notifyEvent(pg, { type: "session", sessionId: id, projectId: row.projectId });
        }
      });

      const setHarness = Effect.fn("SessionsRepo.setHarness")(function* (
        id: SessionId,
        harness: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ harness, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const setLaunchOptions = Effect.fn("SessionsRepo.setLaunchOptions")(function* (
        id: SessionId,
        options: { readonly model: string | null; readonly effort: EffortLevel | null },
      ) {
        yield* db
          .update(agentSessions)
          .set({ model: options.model, effort: options.effort, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const reopen = Effect.fn("SessionsRepo.reopen")(function* (
        id: SessionId,
        status: "running" | "idle",
      ) {
        yield* db
          .update(agentSessions)
          .set({
            status,
            // Running from here: the first start is stamped once, as `setStatus` does. Every launch
            // reaches `running` through here, so without it a running session read `started_at`
            // null for its whole life (alpha 2026-09-30, cc05cb8a).
            ...(status === "running"
              ? { startedAt: sql`COALESCE(${agentSessions.startedAt}, now())` }
              : {}),
            settledAt: null,
            idleStoppedAt: null,
            // Running again: a discard of an earlier executor's work is history (the audit log).
            captureDiscardedAt: null,
            captureDiscardedBy: null,
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const claimIdleStop = Effect.fn("SessionsRepo.claimIdleStop")(function* (
        id: SessionId,
        retryBefore: Date,
      ) {
        // Turn admission takes the same lock (`AgentConversationRepo.submitTurn`), and each
        // statement here reads after it is held: a turn queued before the claim is seen by the
        // NOT EXISTS below, and one asked after it reads the claim and is refused.
        const claimed = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${agentConversationLockKey(id)}))`,
              );
              return yield* tx
                .update(agentSessions)
                .set({ idleStoppedAt: new Date() })
                .where(
                  and(
                    eq(agentSessions.id, id),
                    isNull(agentSessions.settledAt),
                    or(
                      isNull(agentSessions.idleStoppedAt),
                      lt(agentSessions.idleStoppedAt, retryBefore),
                    ),
                    sql`NOT EXISTS (SELECT 1 FROM ${agentTurns} WHERE ${agentTurns.sessionId} = ${agentSessions.id} AND ${agentTurns.status} IN ('queued', 'running'))`,
                    sql`NOT EXISTS (SELECT 1 FROM ${agentRequests} WHERE ${agentRequests.sessionId} = ${agentSessions.id} AND ${agentRequests.status} = 'pending')`,
                  ),
                )
                .returning({ id: agentSessions.id });
            }),
          )
          .pipe(Effect.orDie);
        return claimed.length > 0;
      });

      const releaseIdleStop = Effect.fn("SessionsRepo.releaseIdleStop")(function* (id: SessionId) {
        yield* db
          .update(agentSessions)
          .set({ idleStoppedAt: null })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const recordCaptureObservation = Effect.fn("SessionsRepo.recordCaptureObservation")(
        function* (id: SessionId, observation: CaptureObservation) {
          yield* db
            .update(agentSessions)
            .set({
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
                      // The first time it was seen failing stays, whatever later readings say.
                      captureFailingSince: sql`COALESCE(${agentSessions.captureFailingSince}, ${observation.failing.since})`,
                      captureFailingError: observation.failing.error,
                    }),
              ...overdueColumns(observation),
            })
            .where(eq(agentSessions.id, id))
            .pipe(Effect.orDie);
          yield* notify(id);
        },
      );

      const beginCaptureDrain = Effect.fn("SessionsRepo.beginCaptureDrain")(function* (
        id: SessionId,
        reason: CaptureDrainReason,
        at: Date,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            captureDrain: sql`COALESCE(${agentSessions.captureDrain}, ${reason})`,
            captureDrainRequestedAt: sql`COALESCE(${agentSessions.captureDrainRequestedAt}, ${at})`,
            captureDrainProgressAt: sql`COALESCE(${agentSessions.captureDrainProgressAt}, ${at})`,
            updatedAt: at,
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* holdSettledForStopDrain(id);
        yield* notify(id);
      });

      /** A settled session under a stop drain reads `stopping` again, unsettled (`settle`). */
      const holdSettledForStopDrain = (id: SessionId) =>
        db
          .update(agentSessions)
          .set({ status: "stopping", settledAt: null })
          .where(
            and(
              eq(agentSessions.id, id),
              eq(agentSessions.captureDrain, "stop"),
              isNotNull(agentSessions.settledAt),
            ),
          )
          .pipe(Effect.orDie);

      const planRelaunch = Effect.fn("SessionsRepo.planRelaunch")(function* (
        id: SessionId,
        resume: string,
        at: Date,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            captureDrain: "relaunch",
            captureDrainResume: resume,
            captureDrainRequestedAt: sql`COALESCE(${agentSessions.captureDrainRequestedAt}, ${at})`,
            captureDrainProgressAt: sql`COALESCE(${agentSessions.captureDrainProgressAt}, ${at})`,
            updatedAt: at,
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const clearRelaunch = Effect.fn("SessionsRepo.clearRelaunch")(function* (id: SessionId) {
        yield* db
          .update(agentSessions)
          .set({ captureDrainResume: null })
          .where(and(eq(agentSessions.id, id), isNotNull(agentSessions.captureDrainResume)))
          .pipe(Effect.orDie);
      });

      const stopCaptureDrain = Effect.fn("SessionsRepo.stopCaptureDrain")(function* (
        id: SessionId,
      ) {
        const rows = yield* db
          .update(agentSessions)
          .set({ captureDrain: "stop", captureDrainResume: null, updatedAt: new Date() })
          .where(and(eq(agentSessions.id, id), isNotNull(agentSessions.captureDrain)))
          .returning({ id: agentSessions.id })
          .pipe(Effect.orDie);
        if (rows.length > 0) {
          yield* holdSettledForStopDrain(id);
          yield* notify(id);
        }
      });

      const relaunchOf = Effect.fn("SessionsRepo.relaunchOf")(function* (id: SessionId) {
        const [row] = yield* db
          .select({ resume: agentSessions.captureDrainResume })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.resume ?? null;
      });

      const markFinalFlush = Effect.fn("SessionsRepo.markFinalFlush")(function* (
        id: SessionId,
        workspaceId: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ captureFinalWorkspaceId: workspaceId })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const finalFlushedWorkspace = Effect.fn("SessionsRepo.finalFlushedWorkspace")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({ workspaceId: agentSessions.captureFinalWorkspaceId })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.workspaceId ?? null;
      });

      const recordCaptureSaved = Effect.fn("SessionsRepo.recordCaptureSaved")(function* (
        id: SessionId,
        saved: CaptureSavedObservation,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            captureSavedWorkspaceId: saved.workspaceId,
            captureSavedAt: saved.at,
            captureSavedN: saved.n,
            captureSavedEpoch: saved.epoch,
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const captureSavedOf = Effect.fn("SessionsRepo.captureSavedOf")(function* (id: SessionId) {
        const [row] = yield* db
          .select({
            workspaceId: agentSessions.captureSavedWorkspaceId,
            at: agentSessions.captureSavedAt,
            n: agentSessions.captureSavedN,
            epoch: agentSessions.captureSavedEpoch,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined || row.workspaceId === null || row.at === null) return null;
        return { workspaceId: row.workspaceId, at: row.at, n: row.n, epoch: row.epoch };
      });

      const recordCaptureUnsaved = Effect.fn("SessionsRepo.recordCaptureUnsaved")(function* (
        id: SessionId,
        unsaved: CaptureUnsavedObservation,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            captureUnsavedWorkspaceId: unsaved.workspaceId,
            captureUnsavedAt: unsaved.at,
            captureUnsavedDetail: unsaved.words,
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const captureUnsavedOf = Effect.fn("SessionsRepo.captureUnsavedOf")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({
            workspaceId: agentSessions.captureUnsavedWorkspaceId,
            at: agentSessions.captureUnsavedAt,
            words: agentSessions.captureUnsavedDetail,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined || row.workspaceId === null || row.at === null) return null;
        return { workspaceId: row.workspaceId, at: row.at, words: row.words ?? "not saved" };
      });

      const recordExecutorEvidence = Effect.fn("SessionsRepo.recordExecutorEvidence")(function* (
        workspaceId: string,
        answer: ExecutorCaptureAnswer,
      ) {
        const t = executorCaptureEvidence;
        // A compare-and-set on the version: the kept answers are weighed against the new one in
        // the executor's own order (`captureAnswerReplaces`), and a writer that lost the race
        // weighs again against what won it.
        while (true) {
          const kept = yield* executorEvidenceOf(workspaceId);
          const { saved, unsaved } = mergedEvidence(kept, answer);
          const columns = {
            launchId: answer.launchId ?? kept?.launchId ?? null,
            savedAt: saved?.at ?? null,
            savedN: saved?.n ?? null,
            savedEpoch: saved?.epoch ?? null,
            savedPosition: saved?.position ?? null,
            ...unsavedColumns(unsaved),
            updatedAt: new Date(),
          };
          if (kept === null) {
            const inserted = yield* db
              .insert(t)
              .values({ workspaceId, worktreeId: answer.worktreeId, ...columns, version: 1 })
              .onConflictDoNothing({ target: t.workspaceId })
              .returning({ version: t.version })
              .pipe(Effect.orDie);
            if (inserted[0] !== undefined) return inserted[0].version;
            continue;
          }
          const updated = yield* db
            .update(t)
            .set({ ...columns, version: kept.version + 1 })
            .where(and(eq(t.workspaceId, workspaceId), eq(t.version, kept.version)))
            .returning({ version: t.version })
            .pipe(Effect.orDie);
          if (updated[0] !== undefined) return updated[0].version;
        }
      });

      const executorEvidenceOf = Effect.fn("SessionsRepo.executorEvidenceOf")(function* (
        workspaceId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(executorCaptureEvidence)
          .where(eq(executorCaptureEvidence.workspaceId, workspaceId))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : evidenceOfRow(workspaceId, row);
      });

      const openEvidenceFence = Effect.fn("SessionsRepo.openEvidenceFence")(function* (
        workspaceId: string,
        holder: string,
      ) {
        const [row] = yield* db
          .insert(executorEvidenceFences)
          .values({ workspaceId, holder })
          .returning({ ticket: executorEvidenceFences.ticket })
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("evidence fence insert returned no row");
        return Number(row.ticket);
      });

      const closeEvidenceFence = Effect.fn("SessionsRepo.closeEvidenceFence")(function* (
        ticket: number,
        outcome: "unanswered" | "unpublished",
      ) {
        if (outcome === "unanswered") {
          yield* db
            .delete(executorEvidenceFences)
            .where(eq(executorEvidenceFences.ticket, ticket))
            .pipe(Effect.orDie);
          return;
        }
        yield* db
          .update(executorEvidenceFences)
          .set({ unpublished: true })
          .where(eq(executorEvidenceFences.ticket, ticket))
          .pipe(Effect.orDie);
      });

      const evidenceFenced = Effect.fn("SessionsRepo.evidenceFenced")(function* (
        workspaceId: string,
      ) {
        const rows = yield* db
          .select({ ticket: executorEvidenceFences.ticket })
          .from(executorEvidenceFences)
          .where(eq(executorEvidenceFences.workspaceId, workspaceId))
          .limit(1)
          .pipe(Effect.orDie);
        return rows.length > 0;
      });

      const publishExecutorReading = Effect.fn("SessionsRepo.publishExecutorReading")(function* (
        reading: ExecutorReading,
      ) {
        const { observation, answer, workspaceId } = reading;
        const t = executorCaptureEvidence;
        const version = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(agentSessions)
                .set({
                  capturePending: observation.pending,
                  capturePendingBytes: observation.pendingBytes,
                  captureRefused: observation.refused,
                  captureRegisteredAt: observation.registeredAt,
                  captureObservedAt: observation.observedAt,
                  captureObservedPosition: reading.position,
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
                          captureFailingSince: sql`COALESCE(${agentSessions.captureFailingSince}, ${observation.failing.since})`,
                          captureFailingError: observation.failing.error,
                        }),
                  ...overdueColumns(observation),
                  ...(reading.saved === null
                    ? {}
                    : {
                        captureSavedWorkspaceId: reading.saved.workspaceId,
                        captureSavedAt: reading.saved.at,
                        captureSavedN: reading.saved.n,
                        captureSavedEpoch: reading.saved.epoch,
                      }),
                  ...(reading.unsaved === null
                    ? {}
                    : {
                        captureUnsavedWorkspaceId: reading.unsaved.workspaceId,
                        captureUnsavedAt: reading.unsaved.at,
                        captureUnsavedDetail: reading.unsaved.words,
                      }),
                })
                .where(eq(agentSessions.id, reading.sessionId));
              // The executor's row, locked for the rest of the transaction: the answer is
              // weighed against what it keeps as it is now, and the version moves once.
              yield* tx
                .insert(t)
                .values({ workspaceId, worktreeId: answer.worktreeId, version: 0 })
                .onConflictDoNothing({ target: t.workspaceId });
              const [row] = yield* tx
                .select()
                .from(t)
                .where(eq(t.workspaceId, workspaceId))
                .limit(1)
                .for("update");
              const kept = row === undefined ? null : evidenceOfRow(workspaceId, row);
              const { saved, unsaved } = mergedEvidence(kept, answer);
              const [updated] = yield* tx
                .update(t)
                .set({
                  launchId: answer.launchId ?? kept?.launchId ?? null,
                  savedAt: saved?.at ?? null,
                  savedN: saved?.n ?? null,
                  savedEpoch: saved?.epoch ?? null,
                  savedPosition: saved?.position ?? null,
                  ...unsavedColumns(unsaved),
                  updatedAt: new Date(),
                  version: sql`${t.version} + 1`,
                })
                .where(eq(t.workspaceId, workspaceId))
                .returning({ version: t.version });
              // Its own fence, and every earlier one of this executor whose answer arrived
              // unpublished or whose engine process is another (gone, or superseded by this
              // answer, asked after it): the evidence now holds an answer asked after them.
              yield* tx
                .delete(executorEvidenceFences)
                .where(
                  or(
                    eq(executorEvidenceFences.ticket, reading.fence.ticket),
                    and(
                      eq(executorEvidenceFences.workspaceId, workspaceId),
                      lt(executorEvidenceFences.ticket, reading.fence.ticket),
                      or(
                        eq(executorEvidenceFences.unpublished, true),
                        ne(executorEvidenceFences.holder, reading.fence.holder),
                      ),
                    ),
                  ),
                );
              return Number(updated?.version ?? 0);
            }),
          )
          .pipe(Effect.orDie);
        yield* notify(reading.sessionId);
        return version;
      });

      const captureObservedPositionOf = Effect.fn("SessionsRepo.captureObservedPositionOf")(
        function* (id: SessionId) {
          const [row] = yield* db
            .select({ position: agentSessions.captureObservedPosition })
            .from(agentSessions)
            .where(eq(agentSessions.id, id))
            .limit(1)
            .pipe(Effect.orDie);
          return row?.position ?? null;
        },
      );

      /** An `executor_capture_evidence` row as the evidence it holds. */
      const evidenceOfRow = (
        workspaceId: string,
        row: typeof executorCaptureEvidence.$inferSelect,
      ): ExecutorCaptureEvidence => {
        return {
          workspaceId: row.workspaceId,
          launchId: row.launchId,
          saved:
            row.savedAt === null
              ? null
              : {
                  workspaceId,
                  at: row.savedAt,
                  n: row.savedN,
                  epoch: row.savedEpoch,
                  position: row.savedPosition,
                },
          unsaved: row.unsavedAnswers.map((answer) => ({
            workspaceId,
            at: new Date(answer.at),
            words: answer.words,
            position: answer.position,
          })),
          version: Number(row.version),
        } satisfies ExecutorCaptureEvidence;
      };

      const recordCaptureDrainProgress = Effect.fn("SessionsRepo.recordCaptureDrainProgress")(
        function* (id: SessionId, at: Date) {
          yield* db
            .update(agentSessions)
            .set({ captureDrainProgressAt: at, captureNotSavedAt: null })
            .where(and(eq(agentSessions.id, id), isNotNull(agentSessions.captureDrain)))
            .pipe(Effect.orDie);
          yield* notify(id);
        },
      );

      const markCaptureNotSaved = Effect.fn("SessionsRepo.markCaptureNotSaved")(function* (
        id: SessionId,
        at: Date,
      ) {
        const rows = yield* db
          .update(agentSessions)
          .set({ captureNotSavedAt: at, updatedAt: at })
          .where(
            and(
              eq(agentSessions.id, id),
              isNotNull(agentSessions.captureDrain),
              isNull(agentSessions.captureNotSavedAt),
            ),
          )
          .returning({ id: agentSessions.id })
          .pipe(Effect.orDie);
        if (rows.length === 0) return false;
        yield* notify(id);
        return true;
      });

      const endCaptureDrain = Effect.fn("SessionsRepo.endCaptureDrain")(function* (
        id: SessionId,
        discarded?: CaptureDiscard,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            captureDrain: null,
            captureDrainRequestedAt: null,
            captureDrainProgressAt: null,
            captureNotSavedAt: null,
            captureIncompleteReason: null,
            captureIncompleteDetail: null,
            // The executor is gone: whatever it was failing at is over.
            captureFailingSince: null,
            captureFailingError: null,
            captureOverdueStep: null,
            captureOverdueSince: null,
            captureOverdueRunningMs: null,
            captureOverdueBoundMs: null,
            ...(discarded === undefined
              ? {}
              : { captureDiscardedAt: discarded.at, captureDiscardedBy: discarded.by }),
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const listCaptureDrains = Effect.fn("SessionsRepo.listCaptureDrains")(function* () {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(
            or(isNotNull(agentSessions.captureDrain), isNotNull(agentSessions.captureDrainResume)),
          )
          .orderBy(asc(agentSessions.captureDrainRequestedAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      const setExecutorStartedAt = Effect.fn("SessionsRepo.setExecutorStartedAt")(function* (
        id: SessionId,
        at: Date,
      ) {
        yield* db
          .update(agentSessions)
          .set({ executorStartedAt: at })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const recordAcceptedWorkspace = Effect.fn("SessionsRepo.recordAcceptedWorkspace")(function* (
        id: SessionId,
        workspaceId: SealantWorkspaceId,
        executorStartedAt: Date,
        launchId: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            sealantWorkspaceId: workspaceId,
            executorStartedAt,
            executorResourceId: null,
            executorCreateKey: null,
            executorLaunchId: launchId,
            workspaceExpiresAt: null,
            workspaceTtlRenewedAt: null,
            workspaceTtlRenewalFailedAt: null,
            workspaceTtlRenewalError: null,
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const recordExecutorResource = Effect.fn("SessionsRepo.recordExecutorResource")(function* (
        id: SessionId,
        workspaceId: SealantWorkspaceId,
        resourceId: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ executorResourceId: resourceId })
          .where(and(eq(agentSessions.id, id), eq(agentSessions.sealantWorkspaceId, workspaceId)))
          .pipe(Effect.orDie);
      });

      const recordExecutorCreate = Effect.fn("SessionsRepo.recordExecutorCreate")(function* (
        id: SessionId,
        key: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ executorCreateKey: key })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
      });

      const clearExecutorCreate = Effect.fn("SessionsRepo.clearExecutorCreate")(function* (
        id: SessionId,
        key: string,
      ) {
        yield* db
          .update(agentSessions)
          .set({ executorCreateKey: null })
          .where(and(eq(agentSessions.id, id), eq(agentSessions.executorCreateKey, key)))
          .pipe(Effect.orDie);
      });

      const executorCreateOf = Effect.fn("SessionsRepo.executorCreateOf")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({ key: agentSessions.executorCreateKey })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.key ?? null;
      });

      const listExecutorCreates = Effect.fn("SessionsRepo.listExecutorCreates")(function* () {
        const rows = yield* db
          .select({ sessionId: agentSessions.id, key: agentSessions.executorCreateKey })
          .from(agentSessions)
          .where(isNotNull(agentSessions.executorCreateKey))
          .pipe(Effect.orDie);
        return rows.flatMap((row) =>
          row.key === null ? [] : [{ sessionId: row.sessionId, key: row.key }],
        );
      });

      const executorResourceOf = Effect.fn("SessionsRepo.executorResourceOf")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({
            workspaceId: agentSessions.sealantWorkspaceId,
            resourceId: agentSessions.executorResourceId,
            launchId: agentSessions.executorLaunchId,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined || row.workspaceId === null || row.resourceId === null) return null;
        return { workspaceId: row.workspaceId, resourceId: row.resourceId, launchId: row.launchId };
      });

      const executorLaunchOf = Effect.fn("SessionsRepo.executorLaunchOf")(function* (
        id: SessionId,
      ) {
        const [row] = yield* db
          .select({
            workspaceId: agentSessions.sealantWorkspaceId,
            launchId: agentSessions.executorLaunchId,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined || row.workspaceId === null || row.launchId === null) return null;
        return { workspaceId: row.workspaceId, launchId: row.launchId };
      });

      const requestRemoval = Effect.fn("SessionsRepo.requestRemoval")(function* (
        id: SessionId,
        at: Date,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            removalRequestedAt: sql`COALESCE(${agentSessions.removalRequestedAt}, ${at})`,
            updatedAt: at,
          })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      const listRemovalRequested = Effect.fn("SessionsRepo.listRemovalRequested")(function* () {
        const rows = yield* db
          .select()
          .from(agentSessions)
          .where(isNotNull(agentSessions.removalRequestedAt))
          .orderBy(asc(agentSessions.removalRequestedAt))
          .pipe(Effect.orDie);
        return rows.map(toSession);
      });

      return {
        create,
        byId,
        listForProject,
        recentOwnersForProject,
        listUnsettledForOwner,
        countUnsettledForOrganization,
        listForWorktree,
        listActive,
        listUnsettled,
        listRecentlySettled,
        setSealantIds,
        recordWorkspaceTtlRenewal,
        recordWorkspaceTtlRenewalFailure,
        setSealantSessionId,
        setWorkspaceImage,
        setDotfiles,
        setHasTranscript,
        listSettledUnclassified,
        setProviderSessionId,
        nativeIngestCursor,
        setNativeIngestCursor,
        setReferenceMounts,
        setExtraMounts,
        setStatus,
        saveLastSeenSequence,
        notifyProgress,
        settle,
        reopen,
        claimIdleStop,
        releaseIdleStop,
        setSummary,
        restate,
        setLabel,
        setSharedControl,
        disableSharedControlForOwner,
        setLabelIfUnset,
        remove,
        setHarness,
        setLaunchOptions,
        recordCaptureObservation,
        beginCaptureDrain,
        planRelaunch,
        clearRelaunch,
        stopCaptureDrain,
        relaunchOf,
        markFinalFlush,
        finalFlushedWorkspace,
        recordCaptureSaved,
        captureSavedOf,
        recordCaptureUnsaved,
        captureUnsavedOf,
        recordExecutorEvidence,
        executorEvidenceOf,
        openEvidenceFence,
        closeEvidenceFence,
        evidenceFenced,
        publishExecutorReading,
        captureObservedPositionOf,
        recordCaptureDrainProgress,
        markCaptureNotSaved,
        endCaptureDrain,
        listCaptureDrains,
        setExecutorStartedAt,
        recordAcceptedWorkspace,
        recordExecutorResource,
        executorResourceOf,
        executorLaunchOf,
        recordExecutorCreate,
        clearExecutorCreate,
        executorCreateOf,
        listExecutorCreates,
        requestRemoval,
        listRemovalRequested,
      };
    }),
  );
