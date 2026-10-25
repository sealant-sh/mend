import { createHash } from "node:crypto";

import { PageId, type SessionId } from "@mend/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionPages } from "../schema/workbench.ts";
import { isForeignKeyViolation } from "./unique-violation.ts";

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
  }
>()("@mend/db/SessionPagesRepo") {}

const digestOf = (html: string) => createHash("sha256").update(html, "utf8").digest("hex");

export const SessionPagesRepoLive: Layer.Layer<SessionPagesRepo, never, MendDB> = Layer.effect(
  SessionPagesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

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

    const publish = Effect.fn("SessionPagesRepo.publish")(function* (page: NewSessionPage) {
      const sha256 = digestOf(page.html);
      const [inserted] = yield* db
        .insert(sessionPages)
        .values({
          id: PageId.make(crypto.randomUUID()),
          ...page,
          sha256,
          bytes: Buffer.byteLength(page.html, "utf8"),
        })
        .onConflictDoNothing({ target: [sessionPages.sessionId, sessionPages.callKey] })
        .returning()
        .pipe(
          Effect.mapError((cause) =>
            isForeignKeyViolation(cause)
              ? new SessionPageSessionNotFoundError({ sessionId: page.sessionId })
              : storageFailed(cause),
          ),
        );
      if (inserted !== undefined) return inserted;
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

    return { publish, byId };
  }),
);
