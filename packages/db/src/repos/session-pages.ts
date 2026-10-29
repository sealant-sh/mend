import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { PageId, type SessionId } from "@mend/domain";
import { type AgentTurnStatus, type PageRef, currentAgentProcess } from "@mend/domain/workbench";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentItems,
  agentSessions,
  agentTurns,
  sessionPages,
  sessionProcesses,
} from "../schema/workbench.ts";
import {
  lockAgentConversation,
  nextAgentItemSeq,
  notifyAgentConversation,
} from "./agent-conversation.ts";
import { PAGE_REF_COLUMNS, pageItemRow, pageRefOf, pagesWithoutItems } from "./page-items.ts";
import { toSessionProcess } from "./session-processes.ts";
import { isForeignKeyViolation } from "./unique-violation.ts";

export { pageRefOf };

export type SessionPage = typeof sessionPages.$inferSelect;

export interface NewSessionPage {
  readonly sessionId: SessionId;
  readonly callKey: string;
  readonly accountId: string | null;
  readonly title: string;
  readonly height: number;
  readonly html: string;
}

export class SessionPageConflictError extends Schema.TaggedError<SessionPageConflictError>()(
  "SessionPageConflictError",
  {
    sessionId: Schema.String,
    callKey: Schema.String,
  },
) {}

export class SessionPageSessionNotFoundError extends Schema.TaggedError<SessionPageSessionNotFoundError>()(
  "SessionPageSessionNotFoundError",
  { sessionId: Schema.String },
) {}

export class SessionPageStorageError extends Schema.TaggedError<SessionPageStorageError>()(
  "SessionPageStorageError",
  { cause: Schema.Defect() },
) {}

const storageFailed = (cause: unknown) => new SessionPageStorageError({ cause });

export class SessionPagesRepo extends Context.Service<
  SessionPagesRepo,
  {
    readonly publish: (
      page: NewSessionPage,
    ) => Effect.Effect<
      SessionPage,
      SessionPageConflictError | SessionPageSessionNotFoundError | SessionPageStorageError
    >;
    readonly byId: (id: PageId) => Effect.Effect<SessionPage | null, SessionPageStorageError>;
    readonly refById: (id: PageId) => Effect.Effect<PageRef | null, SessionPageStorageError>;
    readonly listForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<PageRef>, SessionPageStorageError>;
  }
>()("@mend/db/SessionPagesRepo") {}

const digestOf = (html: string) => createHash("sha256").update(html, "utf8").digest("hex");

type Tx = Pick<MendDatabase, "select" | "insert" | "execute">;

const NEVER_RAN: Array<AgentTurnStatus> = ["queued", "cancelled"];

const ensurePageItem = Effect.fn("SessionPagesRepo.ensurePageItem")(function* (
  tx: Tx,
  page: SessionPage,
) {
  const rows = yield* tx
    .select()
    .from(sessionProcesses)
    .where(eq(sessionProcesses.sessionId, page.sessionId));
  const agent = currentAgentProcess(rows.map(toSessionProcess));
  if (agent === null) return false;
  yield* lockAgentConversation(tx, page.sessionId);
  const missing = yield* pagesWithoutItems(tx, page.sessionId, [page.id]);
  const ref = missing.get(page.id);
  if (ref === undefined) return false;
  const [turn] = yield* tx
    .select({ id: agentTurns.id })
    .from(agentTurns)
    .where(and(eq(agentTurns.processId, agent.id), notInArray(agentTurns.status, NEVER_RAN)))
    .orderBy(desc(agentTurns.ordinal))
    .limit(1);
  if (turn === undefined) return false;
  const seq = yield* nextAgentItemSeq(tx, page.sessionId);
  yield* tx
    .insert(agentItems)
    .values(pageItemRow(ref, { processId: agent.id, turnId: turn.id, seq, eventIndex: 0 }));
  return true;
});

export const SessionPagesRepoLive: Layer.Layer<
  SessionPagesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  SessionPagesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const byCall = (sessionId: SessionId, callKey: string) =>
      db
        .select()
        .from(sessionPages)
        .where(and(eq(sessionPages.sessionId, sessionId), eq(sessionPages.callKey, callKey)))
        .limit(1)
        .pipe(
          Effect.mapError(storageFailed),
          Effect.map((rows) => rows[0] ?? null),
        );

    const notifyPagePublished = Effect.fn("SessionPagesRepo.notifyPagePublished")(function* (
      sessionId: SessionId,
    ) {
      const [session] = yield* db
        .select({ projectId: agentSessions.projectId })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      if (session === undefined) return;
      yield* notifyEvent(pg, { type: "session", sessionId, projectId: session.projectId });
    });

    const publish = Effect.fn("SessionPagesRepo.publish")(function* (page: NewSessionPage) {
      const sha256 = digestOf(page.html);
      const written = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [inserted] = yield* tx
              .insert(sessionPages)
              .values({
                id: PageId.make(crypto.randomUUID()),
                ...page,
                sha256,
                bytes: Buffer.byteLength(page.html, "utf8"),
              })
              .onConflictDoNothing({ target: [sessionPages.sessionId, sessionPages.callKey] })
              .returning();
            if (inserted === undefined) return null;
            return { row: inserted, itemAdded: yield* ensurePageItem(tx, inserted) };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isForeignKeyViolation(cause)
              ? new SessionPageSessionNotFoundError({ sessionId: page.sessionId })
              : storageFailed(cause),
          ),
        );
      if (written !== null) {
        if (written.itemAdded) yield* notifyAgentConversation(db, pg, page.sessionId);
        yield* notifyPagePublished(page.sessionId);
        return written.row;
      }
      const first = yield* byCall(page.sessionId, page.callKey);
      if (first === null) return yield* Effect.die("session page conflict without a stored row");
      if (
        first.sha256 !== sha256 ||
        first.title !== page.title ||
        first.height !== page.height ||
        first.accountId !== page.accountId
      ) {
        return yield* new SessionPageConflictError({
          sessionId: page.sessionId,
          callKey: page.callKey,
        });
      }
      const repaired = yield* db
        .transaction((tx) => ensurePageItem(tx, first))
        .pipe(Effect.mapError(storageFailed));
      if (repaired) yield* notifyAgentConversation(db, pg, page.sessionId);
      return first;
    });

    const byId = Effect.fn("SessionPagesRepo.byId")(function* (id: PageId) {
      const [row] = yield* db
        .select()
        .from(sessionPages)
        .where(eq(sessionPages.id, id))
        .limit(1)
        .pipe(Effect.mapError(storageFailed));
      return row ?? null;
    });

    const refById = Effect.fn("SessionPagesRepo.refById")(function* (id: PageId) {
      const [row] = yield* db
        .select(PAGE_REF_COLUMNS)
        .from(sessionPages)
        .where(eq(sessionPages.id, id))
        .limit(1)
        .pipe(Effect.mapError(storageFailed));
      return row === undefined ? null : pageRefOf(row);
    });

    const listForSession = Effect.fn("SessionPagesRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select(PAGE_REF_COLUMNS)
        .from(sessionPages)
        .where(eq(sessionPages.sessionId, sessionId))
        .orderBy(asc(sessionPages.publishedAt), asc(sessionPages.id))
        .pipe(Effect.mapError(storageFailed));
      return rows.map(pageRefOf);
    });

    return { publish, byId, refById, listForSession };
  }),
);
