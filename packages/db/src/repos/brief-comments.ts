import { PgClient } from "@effect/sql-pg";
import {
  BriefComment,
  BriefCommentId,
  type BriefId,
  type CommentAuthorKind,
  type RoutedAction,
  type RunId,
} from "@mend/domain";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { briefComments, briefs, changes } from "../schema/workbench.ts";

export class BriefCommentNotFoundError extends Schema.TaggedError<BriefCommentNotFoundError>()(
  "BriefCommentNotFoundError",
  {
    commentId: Schema.String,
  },
) {}

/** The review conversation on a brief — reviewer entries and Mend's replies. */
export class BriefCommentsRepo extends Context.Service<
  BriefCommentsRepo,
  {
    readonly create: (input: {
      readonly briefId: BriefId;
      readonly thread: string;
      readonly authorKind: CommentAuthorKind;
      readonly authorName: string;
      readonly body: string;
    }) => Effect.Effect<BriefComment>;
    readonly byId: (id: BriefCommentId) => Effect.Effect<BriefComment, BriefCommentNotFoundError>;
    readonly listForBrief: (briefId: BriefId) => Effect.Effect<ReadonlyArray<BriefComment>>;
    /** Records what Mend decided the comment asks for — the routing, as evidence. */
    readonly setRouted: (
      id: BriefCommentId,
      action: RoutedAction,
      runId: RunId | null,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/BriefCommentsRepo") {}

const toComment = (row: typeof briefComments.$inferSelect): BriefComment => new BriefComment(row);

export const BriefCommentsRepoLive: Layer.Layer<
  BriefCommentsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  BriefCommentsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const notify = Effect.fn("BriefCommentsRepo.notify")(function* (briefId: BriefId) {
      const [row] = yield* db
        .select({ issueId: changes.issueId })
        .from(changes)
        .innerJoin(briefs, eq(briefs.changeId, changes.id))
        .where(eq(briefs.id, briefId))
        .limit(1)
        .pipe(Effect.orDie);
      yield* notifyEvent(sql, {
        type: "brief-comment",
        briefId,
        issueId: row?.issueId ?? "",
      });
    });

    const create = Effect.fn("BriefCommentsRepo.create")(function* (input: {
      readonly briefId: BriefId;
      readonly thread: string;
      readonly authorKind: CommentAuthorKind;
      readonly authorName: string;
      readonly body: string;
    }) {
      const [row] = yield* db
        .insert(briefComments)
        .values({ id: BriefCommentId.make(crypto.randomUUID()), ...input })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("brief comment insert returned no row");
      const comment = toComment(row);
      yield* notify(input.briefId);
      return comment;
    });

    const byId = Effect.fn("BriefCommentsRepo.byId")(function* (id: BriefCommentId) {
      const [row] = yield* db
        .select()
        .from(briefComments)
        .where(eq(briefComments.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new BriefCommentNotFoundError({ commentId: id });
      return toComment(row);
    });

    const listForBrief = Effect.fn("BriefCommentsRepo.listForBrief")(function* (briefId: BriefId) {
      const rows = yield* db
        .select()
        .from(briefComments)
        .where(eq(briefComments.briefId, briefId))
        .orderBy(asc(briefComments.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toComment);
    });

    const setRouted = Effect.fn("BriefCommentsRepo.setRouted")(function* (
      id: BriefCommentId,
      action: RoutedAction,
      runId: RunId | null,
    ) {
      const [row] = yield* db
        .update(briefComments)
        .set({ routedAction: action, routedRunId: runId })
        .where(eq(briefComments.id, id))
        .returning({ briefId: briefComments.briefId })
        .pipe(Effect.orDie);
      if (row !== undefined) yield* notify(row.briefId);
    });

    return { create, byId, listForBrief, setRouted };
  }),
);
