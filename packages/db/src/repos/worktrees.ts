import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { SessionId, WorktreeId, type ProjectId, type Sha } from "@mend/domain";
import {
  type AccessPolicySource,
  type AccessPolicyRules,
  canonicalAccessPolicyJson,
  ProjectAccessPolicy,
  Worktree,
  WorktreeAccessPolicyPin,
  WorktreeHandoff,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projects, agentSessions, worktrees } from "../schema/workbench.ts";
import { checkHistoryFence } from "./history-fence.ts";
import { projectListed } from "./projects.ts";

export class WorktreeNotFoundError extends Schema.TaggedError<WorktreeNotFoundError>()(
  "WorktreeNotFoundError",
  {
    id: Schema.String,
  },
) {}

export interface NewWorktreeRow {
  /** Caller-supplied: the engine derives the anonymous directory/branch from it. */
  readonly id: WorktreeId;
  readonly projectId: ProjectId;
  readonly name: string;
  /** Fixed when the worktree is created; omitted preserves the pre-choice runtime path. */
  readonly sessionRuntime?: "docker" | "host-vm" | "boat" | null;
  /**
   * The Access policy the worktree pins. Omitted, it pins a copy of its project's own policy as
   * the insert reads it.
   */
  readonly accessPolicy?: WorktreeAccessPolicyPin;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: Sha;
  readonly baseRef: string | null;
  readonly handoff: WorktreeHandoff | null;
}

/** Session states that count as live for removal guards and follow-up targeting. */
const LIVE_SESSION_STATUSES = ["starting", "running", "waiting", "idle"] as const;

/**
 * The index of durable worktree containers (plan §5.5/§5.6) — table `worktrees`.
 * The git worktree itself lives in the project store; this row carries identity
 * (display name vs immutable directory), the base facts, and the membership key
 * sessions/changes/checkpoints hang off.
 */
export class WorktreesRepo extends Context.Service<
  WorktreesRepo,
  {
    readonly create: (worktree: NewWorktreeRow) => Effect.Effect<Worktree>;
    readonly byId: (id: WorktreeId) => Effect.Effect<Worktree, WorktreeNotFoundError>;
    readonly byName: (projectId: ProjectId, name: string) => Effect.Effect<Worktree | null>;
    readonly byHandoffCheckpoint: (
      projectId: ProjectId,
      checkpoint: Sha,
    ) => Effect.Effect<Worktree | null>;
    /**
     * The delta pack every handoff seed names. Retention keeps each while its row stands: before
     * capture 0 is laid down nothing else names it, and capture 0 keeps it after.
     */
    readonly handoffPacks: (excludingProject?: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
    /** Directory names are the store-path key pre-pivot rows are matched by. */
    readonly byDirectory: (
      projectId: ProjectId,
      directory: string,
    ) => Effect.Effect<Worktree | null>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Worktree>>;
    /** The named worktrees, by their key. */
    readonly listByIds: (ids: ReadonlyArray<WorktreeId>) => Effect.Effect<ReadonlyArray<Worktree>>;
    /**
     * "Apply updated policy": re-pin the worktree to new rules. Revocations still apply on top;
     * nothing here widens what a revocation took away.
     */
    readonly setAccessPolicy: (id: WorktreeId, pin: WorktreeAccessPolicyPin) => Effect.Effect<void>;
    /** Hot-claim reset: the pooled worktree re-bases to what the claim asked for. */
    readonly setBase: (id: WorktreeId, baseSha: Sha, baseRef: string | null) => Effect.Effect<void>;
    /** Display identity rename (name + branch); the directory never moves. */
    readonly rename: (id: WorktreeId, name: string, branch: string) => Effect.Effect<void>;
    /** Mirror an observed checkout on the worktree and all its sessions in one transaction. */
    readonly setBranch: (id: WorktreeId, branch: string) => Effect.Effect<void>;
    readonly remove: (id: WorktreeId) => Effect.Effect<void>;
    /**
     * The change's owner (docs/adr/0007-landing.md, "Who lands"), as the first session's insert
     * stored it; null for a worktree with none, or one that is gone.
     */
    readonly changeOwnerOf: (id: WorktreeId) => Effect.Effect<string | null>;
    /**
     * Repositories added with `mend repo add` whose files are saved only with this worktree, kept
     * after the session that added them is deleted (0166).
     */
    readonly nestedRepositories: (
      id: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly branch: string }>>;
    /**
     * The follow-up target resolver: the newest live conversation in the
     * worktree, or null when none is live.
     */
    readonly newestLiveSessionId: (id: WorktreeId) => Effect.Effect<SessionId | null>;
  }
>()("@mend/db/WorktreesRepo") {}

const decodeHandoff = Schema.decodeUnknownSync(WorktreeHandoff);
const decodePin = Schema.decodeUnknownSync(WorktreeAccessPolicyPin);
const encodePin = Schema.encodeSync(WorktreeAccessPolicyPin);
const decodeProjectPolicy = Schema.decodeUnknownSync(ProjectAccessPolicy);

/** The canonical hash of a policy's rules: what a worktree pins and the hot pool compares. */
export const accessPolicyHash = (rules: AccessPolicyRules): string =>
  `sha256:${createHash("sha256").update(canonicalAccessPolicyJson(rules)).digest("hex")}`;

/** A pin of `rules` from `source`, taken now. */
export const accessPolicyPin = (
  rules: AccessPolicyRules,
  source: AccessPolicySource,
  pinnedAt: Date,
): WorktreeAccessPolicyPin => ({ rules, source, policyHash: accessPolicyHash(rules), pinnedAt });

const toWorktree = ({
  removalPhase: _phase,
  removalId: _id,
  removalSince: _since,
  changeOwnerRecorded: _recorded,
  ...row
}: typeof worktrees.$inferSelect): Worktree =>
  new Worktree({
    ...row,
    handoff: row.handoff === null ? null : decodeHandoff(row.handoff),
    accessPolicy: row.accessPolicy === null ? null : decodePin(row.accessPolicy),
  });

// Compile-time seam tripwire (same discipline as SessionsRepo): a column added
// to `worktrees` must land in @mend/domain's Worktree in the same change. A removal's mark and
// whether the change owner is recorded are the exceptions: only the database's triggers and
// RemovalFencesRepo read them.
type WorktreeRowShape = Omit<
  typeof worktrees.$inferSelect,
  "removalPhase" | "removalId" | "removalSince" | "changeOwnerRecorded"
>;
type ExactKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
  ? true
  : never;
const worktreeSeamIntact: ExactKeys<WorktreeRowShape, Worktree> = true;
void worktreeSeamIntact;

export const WorktreesRepoLive: Layer.Layer<WorktreesRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    WorktreesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;

      const create = Effect.fnUntraced(function* (worktree: NewWorktreeRow) {
        const [project] = yield* db
          .select({
            uses: projects.newWorktreesUseProjectResources,
            accessPolicy: projects.accessPolicy,
          })
          .from(projects)
          .where(and(eq(projects.id, worktree.projectId), projectListed))
          .pipe(Effect.orDie);
        const now = yield* DateTime.nowAsDate;
        const pin =
          worktree.accessPolicy ??
          (project === undefined
            ? null
            : (() => {
                const policy = decodeProjectPolicy(project.accessPolicy);
                return accessPolicyPin(policy.rules, policy.source, now);
              })());
        const [row] = yield* db
          .insert(worktrees)
          .values({
            ...worktree,
            accessPolicy: pin === null ? null : encodePin(pin),
            usesProjectResources: project?.uses ?? true,
          })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("worktree insert returned no row");
        yield* notifyEvent(pg, {
          type: "worktree",
          worktreeId: row.id,
          projectId: row.projectId,
        });
        return toWorktree(row);
      });

      const byId = Effect.fnUntraced(function* (id: WorktreeId) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(eq(worktrees.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new WorktreeNotFoundError({ id });
        return toWorktree(row);
      });

      const byName = Effect.fnUntraced(function* (projectId: ProjectId, name: string) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, projectId), eq(worktrees.name, name)))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const byHandoffCheckpoint = Effect.fnUntraced(function* (
        projectId: ProjectId,
        checkpoint: Sha,
      ) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(
            and(
              eq(worktrees.projectId, projectId),
              sql`${worktrees.handoff}->>'checkpoint' = ${checkpoint}`,
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const handoffPacks = Effect.fnUntraced(function* (excludingProject?: ProjectId) {
        const rows = yield* db
          .select({ deltaPack: sql<string>`${worktrees.handoff}->>'deltaPack'` })
          .from(worktrees)
          .where(
            and(
              isNotNull(worktrees.handoff),
              excludingProject === undefined
                ? undefined
                : ne(worktrees.projectId, excludingProject),
            ),
          )
          .pipe(Effect.orDie);
        return rows.map((row) => row.deltaPack);
      });

      const byDirectory = Effect.fnUntraced(function* (projectId: ProjectId, directory: string) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, projectId), eq(worktrees.directory, directory)))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const listForProject = Effect.fnUntraced(function* (projectId: ProjectId) {
        const rows = yield* db
          .select()
          .from(worktrees)
          .where(eq(worktrees.projectId, projectId))
          .orderBy(desc(worktrees.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toWorktree);
      });

      const listByIds = Effect.fnUntraced(function* (ids: ReadonlyArray<WorktreeId>) {
        if (ids.length === 0) return [];
        const rows = yield* db
          .select()
          .from(worktrees)
          .where(inArray(worktrees.id, [...ids]))
          .pipe(Effect.orDie);
        return rows.map(toWorktree);
      });

      const setBase = Effect.fnUntraced(function* (
        id: WorktreeId,
        baseSha: Sha,
        baseRef: string | null,
      ) {
        yield* db
          .update(worktrees)
          .set({ baseSha, baseRef, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(worktrees.id, id))
          .pipe(Effect.orDie);
      });

      const setAccessPolicy = Effect.fnUntraced(function* (
        id: WorktreeId,
        pin: WorktreeAccessPolicyPin,
      ) {
        const [row] = yield* db
          .update(worktrees)
          .set({ accessPolicy: encodePin(pin), updatedAt: yield* DateTime.nowAsDate })
          .where(eq(worktrees.id, id))
          .returning({ projectId: worktrees.projectId })
          .pipe(Effect.orDie);
        if (row !== undefined) {
          yield* notifyEvent(pg, { type: "worktree", worktreeId: id, projectId: row.projectId });
        }
      });

      const rename = Effect.fnUntraced(function* (id: WorktreeId, name: string, branch: string) {
        const [row] = yield* db
          .update(worktrees)
          .set({ name, branch, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(worktrees.id, id))
          .returning({ projectId: worktrees.projectId })
          .pipe(Effect.orDie);
        if (row !== undefined) {
          yield* notifyEvent(pg, { type: "worktree", worktreeId: id, projectId: row.projectId });
        }
      });

      const setBranch = Effect.fnUntraced(function* (id: WorktreeId, branch: string) {
        yield* pg
          .withTransaction(
            Effect.gen(function* () {
              const at = yield* DateTime.nowAsDate;
              const [row] = yield* db
                .update(worktrees)
                .set({ branch, updatedAt: at })
                .where(eq(worktrees.id, id))
                .returning({ projectId: worktrees.projectId });
              if (row === undefined) return;
              const members = yield* db
                .update(agentSessions)
                .set({ branch, updatedAt: at })
                .where(eq(agentSessions.worktreeId, id))
                .returning({ id: agentSessions.id });
              yield* notifyEvent(pg, {
                type: "worktree",
                worktreeId: id,
                projectId: row.projectId,
              });
              for (const member of members)
                yield* notifyEvent(pg, {
                  type: "session",
                  sessionId: member.id,
                  projectId: row.projectId,
                });
            }),
          )
          .pipe(Effect.orDie);
      });

      const remove = Effect.fnUntraced(function* (id: WorktreeId) {
        return yield* pg
          .withTransaction(
            Effect.gen(function* () {
              const [member] = yield* pg<{
                readonly id: string;
              }>`SELECT id FROM agent_sessions WHERE worktree_id=${id} ORDER BY id LIMIT 1`;
              if (member !== undefined)
                yield* checkHistoryFence(pg, SessionId.make(member.id)).pipe(Effect.orDie);
              const [row] = yield* db
                .delete(worktrees)
                .where(eq(worktrees.id, id))
                .returning({ projectId: worktrees.projectId })
                .pipe(Effect.orDie);
              if (row !== undefined) {
                yield* notifyEvent(pg, {
                  type: "worktree",
                  worktreeId: id,
                  projectId: row.projectId,
                });
              }
            }),
          )
          .pipe(Effect.orDie);
      });

      const changeOwnerOf = Effect.fnUntraced(function* (id: WorktreeId) {
        const [row] = yield* db
          .select({ owner: worktrees.changeOwnerUserId })
          .from(worktrees)
          .where(eq(worktrees.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.owner ?? null;
      });

      const nestedRepositories = Effect.fnUntraced(function* (id: WorktreeId) {
        return yield* pg<{ readonly path: string; readonly branch: string }>`
          SELECT path, branch FROM worktree_nested_repositories
          WHERE worktree_id = ${id} ORDER BY path`.pipe(Effect.orDie);
      });

      const newestLiveSessionId = Effect.fnUntraced(function* (id: WorktreeId) {
        const [row] = yield* db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.worktreeId, id),
              inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
            ),
          )
          .orderBy(desc(agentSessions.createdAt), asc(agentSessions.id))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : SessionId.make(row.id);
      });

      return {
        setBranch,
        create,
        byId,
        byName,
        byHandoffCheckpoint,
        handoffPacks,
        byDirectory,
        listForProject,
        listByIds,
        setBase,
        setAccessPolicy,
        rename,
        remove,
        changeOwnerOf,
        nestedRepositories,
        newestLiveSessionId,
      };
    }),
  );
