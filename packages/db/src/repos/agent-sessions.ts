import { PgClient } from "@effect/sql-pg";
import {
  type ContextSnapshotId,
  type ProjectId,
  type SealantRunId,
  type SealantWorkspaceId,
  SessionId,
  type Sha,
  type WorktreeId,
  WorkspaceImage,
} from "@mend/domain";
import {
  Session,
  SessionDotfiles,
  type NativeIngestCursor,
  type SessionExtraMount,
  type SessionReferenceMount,
  type SessionStatus,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { agentSessions } from "../schema/workbench.ts";

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
    /** Recently settled sessions — the boot sweep reaps any workspace that outlived them. */
    readonly listRecentlySettled: () => Effect.Effect<ReadonlyArray<Session>>;
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
     * Rewrite the summary of a session without settling it — what was observed since the
     * last settle (a replacement executor answering after "executor lost"). `reopen` touches
     * status alone, so a picked-up session would otherwise keep reading the loss.
     */
    readonly setSummary: (id: SessionId, summary: string | null) => Effect.Effect<void>;
    readonly setLabel: (id: SessionId, label: string | null) => Effect.Effect<void>;
    /** The auto-namer's write: fills the label only while null; true when the write landed. */
    readonly setLabelIfUnset: (id: SessionId, label: string) => Effect.Effect<boolean>;
    /** Hard delete — comments, checkpoints, follow-ups, change and tour cascade. */
    readonly remove: (id: SessionId) => Effect.Effect<void>;
    readonly setHarness: (id: SessionId, harness: string) => Effect.Effect<void>;
  }
>()("@mend/db/SessionsRepo") {}

const decodeWorkspaceImage = Schema.decodeUnknownSync(WorkspaceImage);
const decodeSessionDotfiles = Schema.decodeUnknownSync(SessionDotfiles);

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
 * the mode-handoff ingest cursor is read and written through its own repo
 * methods, never carried on the domain object. Everything else stays exact.
 */
type SessionBookkeepingColumns = "nativeIngestCursor";
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
        yield* db
          .update(agentSessions)
          .set({
            sealantRunId,
            sealantWorkspaceId: workspaceId,
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
        yield* db
          .update(agentSessions)
          .set({ status: outcome, summary, settledAt: now, updatedAt: now })
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

      const reopen = Effect.fn("SessionsRepo.reopen")(function* (
        id: SessionId,
        status: "running" | "idle",
      ) {
        yield* db
          .update(agentSessions)
          .set({ status, settledAt: null, updatedAt: new Date() })
          .where(eq(agentSessions.id, id))
          .pipe(Effect.orDie);
        yield* notify(id);
      });

      return {
        create,
        byId,
        listForProject,
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
        setSummary,
        setLabel,
        setLabelIfUnset,
        remove,
        setHarness,
      };
    }),
  );
