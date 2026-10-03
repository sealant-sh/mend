import { PgClient } from "@effect/sql-pg";
import {
  SessionRepositoryId,
  type ProjectId,
  type SessionId,
  type Sha,
  type WorktreeId,
} from "@mend/domain";
import {
  SessionRepository,
  type SessionRepositoryCapture,
  type SessionRepositorySource,
  type SessionRepositoryState,
} from "@mend/domain/workbench";
import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { agentSessions, sessionRepositories } from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

export class SessionRepositoryNotFoundError extends Schema.TaggedErrorClass<SessionRepositoryNotFoundError>()(
  "SessionRepositoryNotFoundError",
  {
    id: Schema.String,
  },
) {}

/** The session already holds a repository under that name, or that worktree. */
export class SessionRepositoryTakenError extends Schema.TaggedErrorClass<SessionRepositoryTakenError>()(
  "SessionRepositoryTakenError",
  {
    sessionId: Schema.String,
    name: Schema.String,
  },
) {}

export interface NewSessionRepository {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: Sha;
  readonly baseRef: string | null;
  readonly capture: SessionRepositoryCapture;
  readonly source: SessionRepositorySource;
  readonly addedByUserId: string | null;
}

/**
 * The repositories a session holds beside its own worktree (docs/adr/0010): table
 * `session_repositories`. Each row names a worktree of another project; the worktree owns the
 * change and the chain, this row the session's view of it (name, path, state, how it is saved).
 */
export class SessionRepositoriesRepo extends Context.Service<
  SessionRepositoriesRepo,
  {
    /** A new row in state `adding`; the name and the worktree are unique per session. */
    readonly create: (
      input: NewSessionRepository,
    ) => Effect.Effect<SessionRepository, SessionRepositoryTakenError>;
    readonly byId: (
      id: SessionRepositoryId,
    ) => Effect.Effect<SessionRepository, SessionRepositoryNotFoundError>;
    readonly byName: (
      sessionId: SessionId,
      name: string,
    ) => Effect.Effect<SessionRepository | null>;
    /** The session's repositories, by name. */
    readonly listForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionRepository>>;
    /** Every session that holds this worktree as a repository (the review's via session). */
    readonly listForWorktree: (
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<SessionRepository>>;
    /** Move the row to a state; `error` is the reason for `failed` or `missing`, null otherwise. */
    readonly setState: (
      id: SessionRepositoryId,
      state: SessionRepositoryState,
      error: string | null,
    ) => Effect.Effect<void>;
    readonly remove: (id: SessionRepositoryId) => Effect.Effect<void>;
  }
>()("@mend/db/SessionRepositoriesRepo") {}

const toSessionRepository = (row: typeof sessionRepositories.$inferSelect): SessionRepository =>
  new SessionRepository(row);

// Compile-time seam tripwire (same discipline as WorktreesRepo): a column added to
// `session_repositories` must land in @mend/domain's SessionRepository in the same change.
type RowShape = typeof sessionRepositories.$inferSelect;
type ExactKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
  ? true
  : never;
const seamIntact: ExactKeys<RowShape, SessionRepository> = true;
void seamIntact;

export const SessionRepositoriesRepoLive: Layer.Layer<
  SessionRepositoriesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  SessionRepositoriesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    // The session changed: its detail lists repositories, so clients re-read it (events.ts).
    const announce = Effect.fn("SessionRepositoriesRepo.announce")(function* (row: {
      readonly sessionId: SessionId;
    }) {
      const [session] = yield* db
        .select({ projectId: agentSessions.projectId })
        .from(agentSessions)
        .where(eq(agentSessions.id, row.sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      if (session === undefined) return;
      yield* notifyEvent(pg, {
        type: "session",
        sessionId: row.sessionId,
        projectId: session.projectId,
      });
    });

    const create = Effect.fn("SessionRepositoriesRepo.create")(function* (
      input: NewSessionRepository,
    ) {
      const [row] = yield* db
        .insert(sessionRepositories)
        .values({ id: SessionRepositoryId.make(crypto.randomUUID()), ...input })
        .returning()
        .pipe(
          Effect.catch((error) =>
            isUniqueViolation(error)
              ? Effect.fail(
                  new SessionRepositoryTakenError({ sessionId: input.sessionId, name: input.name }),
                )
              : Effect.die(error),
          ),
        );
      if (row === undefined) return yield* Effect.die("session repository insert returned no row");
      yield* announce(row);
      return toSessionRepository(row);
    });

    const byId = Effect.fn("SessionRepositoriesRepo.byId")(function* (id: SessionRepositoryId) {
      const [row] = yield* db
        .select()
        .from(sessionRepositories)
        .where(eq(sessionRepositories.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new SessionRepositoryNotFoundError({ id });
      return toSessionRepository(row);
    });

    const byName = Effect.fn("SessionRepositoriesRepo.byName")(function* (
      sessionId: SessionId,
      name: string,
    ) {
      const [row] = yield* db
        .select()
        .from(sessionRepositories)
        .where(
          and(eq(sessionRepositories.sessionId, sessionId), eq(sessionRepositories.name, name)),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toSessionRepository(row);
    });

    const listForSession = Effect.fn("SessionRepositoriesRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select()
        .from(sessionRepositories)
        .where(eq(sessionRepositories.sessionId, sessionId))
        .orderBy(asc(sessionRepositories.name))
        .pipe(Effect.orDie);
      return rows.map(toSessionRepository);
    });

    const listForWorktree = Effect.fn("SessionRepositoriesRepo.listForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const rows = yield* db
        .select()
        .from(sessionRepositories)
        .where(eq(sessionRepositories.worktreeId, worktreeId))
        .orderBy(asc(sessionRepositories.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toSessionRepository);
    });

    const setState = Effect.fn("SessionRepositoriesRepo.setState")(function* (
      id: SessionRepositoryId,
      state: SessionRepositoryState,
      error: string | null,
    ) {
      const now = new Date();
      const [row] = yield* db
        .update(sessionRepositories)
        .set({
          state,
          error,
          updatedAt: now,
          ...(state === "ready" ? { readyAt: now } : {}),
        })
        .where(eq(sessionRepositories.id, id))
        .returning({ sessionId: sessionRepositories.sessionId })
        .pipe(Effect.orDie);
      if (row !== undefined) yield* announce(row);
    });

    const remove = Effect.fn("SessionRepositoriesRepo.remove")(function* (id: SessionRepositoryId) {
      const [row] = yield* db
        .delete(sessionRepositories)
        .where(eq(sessionRepositories.id, id))
        .returning({ sessionId: sessionRepositories.sessionId })
        .pipe(Effect.orDie);
      if (row !== undefined) yield* announce(row);
    });

    return { create, byId, byName, listForSession, listForWorktree, setState, remove };
  }),
);

/** An in-memory store for tests and engines that run without Postgres. */
export const SessionRepositoriesRepoMemory: Layer.Layer<SessionRepositoriesRepo> = Layer.sync(
  SessionRepositoriesRepo,
  () => {
    const rows = new Map<SessionRepositoryId, SessionRepository>();
    const list = () => [...rows.values()];
    return {
      create: (input) =>
        Effect.suspend(() => {
          const taken = list().some(
            (row) =>
              row.sessionId === input.sessionId &&
              (row.name === input.name || row.worktreeId === input.worktreeId),
          );
          if (taken) {
            return Effect.fail(
              new SessionRepositoryTakenError({ sessionId: input.sessionId, name: input.name }),
            );
          }
          const now = new Date();
          const row = new SessionRepository({
            id: SessionRepositoryId.make(crypto.randomUUID()),
            ...input,
            state: "adding",
            error: null,
            createdAt: now,
            updatedAt: now,
            readyAt: null,
          });
          rows.set(row.id, row);
          return Effect.succeed(row);
        }),
      byId: (id) =>
        Effect.suspend(() => {
          const row = rows.get(id);
          return row === undefined
            ? Effect.fail(new SessionRepositoryNotFoundError({ id }))
            : Effect.succeed(row);
        }),
      byName: (sessionId, name) =>
        Effect.sync(
          () => list().find((row) => row.sessionId === sessionId && row.name === name) ?? null,
        ),
      listForSession: (sessionId) =>
        Effect.sync(() =>
          list()
            .filter((row) => row.sessionId === sessionId)
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        ),
      listForWorktree: (worktreeId) =>
        Effect.sync(() => list().filter((row) => row.worktreeId === worktreeId)),
      setState: (id, state, error) =>
        Effect.sync(() => {
          const row = rows.get(id);
          if (row === undefined) return;
          const now = new Date();
          rows.set(
            id,
            new SessionRepository({
              ...row,
              state,
              error,
              updatedAt: now,
              readyAt: state === "ready" ? now : row.readyAt,
            }),
          );
        }),
      remove: (id) =>
        Effect.sync(() => {
          rows.delete(id);
        }),
    };
  },
);
