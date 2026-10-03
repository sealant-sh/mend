import { Effect, Schema } from "effect";

import {
  ContextSnapshotId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "../ids.ts";
import { WorkspaceImage } from "../settings.ts";
import { SequenceNumber, Timestamp } from "../timestamp.ts";
import { CaptureDrainReason } from "./capture-drain.ts";
import { EFFORT_LEVELS } from "./harness-launch.ts";
import { SessionExtraMount } from "./mount.ts";
import { SessionReferenceMount } from "./reference.ts";

/**
 * A dotfiles source the launch resolved and could not apply. The workspace launched without that
 * archive; `reason` is the resolver's own sentence (the clone that was stopped, the subdirectory
 * that is not there, the policy that refused the host).
 */
export const SessionDotfilesNotApplied = Schema.Struct({
  source: Schema.Literals(["repository", "snapshot"]),
  reason: Schema.String,
});
export type SessionDotfilesNotApplied = typeof SessionDotfilesNotApplied.Type;

/**
 * What a launch actually applied from the owner's dotfiles — recorded facts, never rewritten by
 * a later sync or config change. The snapshot sha names an exact commit in the user's dotfiles
 * store; the repository is the url+ref that was cloned (its content is not pinned — the clone
 * takes the branch tip at launch). A source named in `notApplied` was tried and left out: the
 * repository still names what was tried; a snapshot that could not be packed has no sha.
 */
export const SessionDotfiles = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      ref: Schema.NullOr(Schema.String),
    }),
  ),
  snapshotSha: Schema.NullOr(Schema.String),
  /** Rows stamped before this field decode as nothing left out. */
  notApplied: Schema.Array(SessionDotfilesNotApplied).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type SessionDotfiles = typeof SessionDotfiles.Type;

/**
 * Lifecycle of a supervised coding-agent process (plan §5.5). `waiting` and
 * `idle` are workbench states the queue-era RunStatus never had: waiting means
 * the harness asked for input; idle means the PTY is alive with no activity.
 * `stopping` (capture mode): the agent has ended and its workspace is being
 * saved before it goes (`saving · 3 left`), or was kept because it could not
 * be (`not saved · … · workspace kept`). Not settled: the session settles once
 * the platform reports the workspace terminated.
 */
export const SessionStatus = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "idle",
  "stopping",
  "completed",
  "failed",
  "stopped",
]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * Where a session was started from (docs/adr/0006-slack.md, "Audit"). `mend` is Mend's own
 * surfaces: the web app, the CLI, the phone and Mend's own jobs. `slack` is a mention in Slack.
 * Stamped at provision and never rewritten.
 */
export const SessionOrigin = Schema.Literals(["mend", "slack"]);
export type SessionOrigin = typeof SessionOrigin.Type;

/**
 * How far the session's native transcript has been ingested into the durable
 * conversation (the mode-handoff backfill). Claude entries carry stable uuids
 * and fork-on-resume preserves the copied prefix, so the last ingested uuid
 * addresses the boundary; codex rollouts have no per-entry ids, so the count
 * of ingested lines stands in. Persistence bookkeeping, not part of `Session`.
 */
export const NativeIngestCursor = Schema.Struct({
  providerSessionId: Schema.String,
  lastEntryUuid: Schema.NullOr(Schema.String),
  lineCount: Schema.Int,
});
export type NativeIngestCursor = typeof NativeIngestCursor.Type;

/**
 * One logical coding-agent conversation inside a worktree (plan §5.5). The worktree is the
 * durable container — many sessions may inhabit it over its life, several live at once; the
 * session owns only its conversation, its processes, and its workspace. A settled-session
 * resume starts another Sealant run; SessionRun owns the ordered membership and per-run cursors.
 * The recording stays in Sealant and evidence addresses it by `(sealantRunId, sequence)`.
 */
export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  projectId: ProjectId,
  /** The container this conversation runs in. */
  worktreeId: WorktreeId,
  /** The adapter that launched it: `codex` · `claude` · `opencode` · `custom`. */
  harness: Schema.String,
  /**
   * The model the session was started with, as the server resolved it (docs/models-audit.md): the
   * one the request named, else the harness's catalog default. Null for a harness with no catalog,
   * before launch, and on rows from before the column. A resume keeps it: the harness continues
   * the conversation on its own model.
   */
  model: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The effort the session was started with; null is the harness's own default. */
  effort: Schema.NullOr(Schema.Literals(EFFORT_LEVELS)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Provider-native session/thread id when the adapter can extract one. */
  providerSessionId: Schema.NullOr(Schema.String),
  /** Optional human label ("reaper retry storm"); sessions have no issue titles. */
  label: Schema.NullOr(Schema.String),
  /**
   * Denormalized mirror of the worktree row's `directory` — kept for
   * pre-worktree clients; new readers resolve the worktree by `worktreeId`.
   */
  worktree: Schema.String,
  /** Mirror of the worktree row's `branch` (see `worktree`). */
  branch: Schema.String,
  /** Mirror of the worktree row's `baseSha` (see `worktree`). */
  baseSha: Sha,
  /** Mirror of the worktree row's `baseRef` (see `worktree`). */
  baseRef: Schema.NullOr(Schema.String),
  contextSnapshotId: Schema.NullOr(ContextSnapshotId),
  /** References mounted read-only beside the worktree at launch, SHAs as observed then. */
  referenceMounts: Schema.Array(SessionReferenceMount),
  /** Project folders mounted beside the worktree at launch — what the agent could see. */
  extraMounts: Schema.Array(SessionExtraMount),
  /** Latest run pointer retained for list/API compatibility; SessionRun is authoritative. */
  sealantRunId: Schema.NullOr(SealantRunId),
  /** Latest workspace pointer used for active control and settle-time harvesting. */
  sealantWorkspaceId: Schema.NullOr(SealantWorkspaceId),
  /** Latest platform interactive PTY session id — the live reattach handle. */
  sealantSessionId: Schema.NullOr(Schema.String),
  /** Platform-returned expiry for the current workspace after the last successful TTL renewal. */
  workspaceExpiresAt: Schema.NullOr(Timestamp),
  /** When Mend last successfully renewed the current workspace. */
  workspaceTtlRenewedAt: Schema.NullOr(Timestamp),
  /** When the latest renewal attempt failed; null after the next success. */
  workspaceTtlRenewalFailedAt: Schema.NullOr(Timestamp),
  /** Latest renewal failure for the current workspace; null after the next success. */
  workspaceTtlRenewalError: Schema.NullOr(Schema.String),
  /** The image this session actually launched with; null before launch (or pre-column rows). */
  workspaceImage: Schema.NullOr(WorkspaceImage),
  /** The dotfiles this session actually launched with; null before launch (or none applied). */
  dotfiles: Schema.NullOr(SessionDotfiles),
  /** Who provisioned the session — whose dotfiles apply. Null for pre-column rows. */
  ownerUserId: Schema.NullOr(Schema.String),
  /** Where it was started from (docs/adr/0006-slack.md). */
  origin: SessionOrigin.pipe(Schema.withConstructorDefault(Effect.succeed("mend"))),
  /**
   * The session's own automatic-landing override (docs/adr/0007-landing.md), set at start: the
   * composer's or `mend`'s `--land` / `--no-land`, or a Slack request's `autopr=`. Null follows the
   * project and Settings.
   */
  autoLand: Schema.NullOr(Schema.Boolean).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /**
   * Shared control (docs/adr/0003-organizations-and-tenancy.md): when set, anyone who can see the
   * session may steer it, still on the owner's credentials. Who turned it on, and when.
   */
  sharedControlEnabledByUserId: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  sharedControlEnabledAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Whether the harness left a conversation behind — a transcript Mend captured at settle or
   * found in the live harness home. False is a dead end: nothing to resume, nothing to hand
   * off, so the dashboard hides such settled sessions. Null until settle (or for rows the
   * boot sweep has not classified yet).
   */
  hasTranscript: Schema.NullOr(Schema.Boolean),
  /**
   * When Mend stopped the session's protocol agent for idleness (MEND_PROTOCOL_IDLE_STOP_MINUTES,
   * `protocolIdleReading`), and the claim that stops it once across workers. Null again once the
   * session reopens.
   */
  idleStoppedAt: Schema.NullOr(Timestamp).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /**
   * Capture mode (docs/adr/0002-session-capture-store.md, "Stop drains, then terminates"): what
   * the session's executor last answered to a flush — captures staged and not yet registered
   * (bulk included), the bytes left once sealantd reports them, captures its byte quota refused —
   * when Mend asked, and the chain head's registration time as seen then. Null until asked.
   */
  capturePending: Schema.NullOr(Schema.Int).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  capturePendingBytes: Schema.NullOr(Schema.Number).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureRefused: Schema.NullOr(Schema.Int).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureRegisteredAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureObservedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * A drain under way: why (a stop, a relaunch, a replacement before the platform's cap), since
   * when, the last time anything moved, and when it stopped moving (`not saved · workspace kept`).
   * The intent is durable: a Mend restart takes the drain up again. All null once the workspace
   * is saved and terminated, or discarded by its owner.
   */
  captureDrain: Schema.NullOr(CaptureDrainReason).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureDrainRequestedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureDrainProgressAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureNotSavedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Why the executor's last final flush did not complete, in sealantd's words
   * (`captureIncompleteReasonOf`): what `not saved · … · workspace kept` names. Null once one
   * completed, and outside a drain.
   */
  captureIncompleteReason: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * What sealantd named behind that reason (`captureSnapDetailOf`): the snap's error, the first
   * path it could not read. Null when it named nothing, and outside a drain.
   */
  captureIncompleteDetail: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * A running executor whose snaps are failing (`capture failing since … · <error>`): since when,
   * as sealantd said or as Mend first observed it, and sealantd's last error. Both null once a
   * reading shows its snaps succeed again.
   */
  captureFailingSince: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureFailingError: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * A capture step the executor reported still running past its bound (sealantd `overdue`, e2e8):
   * what it is, when it started, how long it had run and the bound it passed, as last observed.
   * All null once a reading reports none, and once the executor is gone. Not a failure, and never
   * idle or saved while it lasts.
   */
  captureOverdueStep: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureOverdueSince: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureOverdueRunningMs: Schema.NullOr(Schema.Number).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureOverdueBoundMs: Schema.NullOr(Schema.Number).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The owner's "discard unsaved and stop" ended this executor with work not saved: when, and
   * who (their display name). Null until then, and again once the session runs again.
   */
  captureDiscardedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  captureDiscardedBy: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the session's current executor started — what the platform's cap counts from, not the
   * latest run. Null before launch and for rows from before the column.
   */
  executorStartedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Removal asked while the workspace was still up: the row goes once the workspace has. */
  removalRequestedAt: Schema.NullOr(Timestamp).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  status: SessionStatus,
  /** What the harness reported at settle, when anything. */
  summary: Schema.NullOr(Schema.String),
  /** Latest run's progress mirror for list surfaces; supervision reads the per-run cursor. */
  lastSeenSequence: SequenceNumber,
  /** False for migrated sessions whose previously overwritten run ids cannot be recovered. */
  recordHistoryComplete: Schema.Boolean,
  startedAt: Schema.NullOr(Timestamp),
  settledAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
