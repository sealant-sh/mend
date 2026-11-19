import { PgClient } from "@effect/sql-pg";
import { type ChangeId, ReviewCommentId, type SessionId } from "@mend/domain";
import { RecordLink, ReviewCommentAnchor } from "@mend/domain/workbench";
import {
  ReviewComment,
  ReviewReply,
  type CommentAuthor,
  type CommentKind,
  type CommentState,
} from "@mend/domain/workbench";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { reviewComments, worktreeChanges } from "../schema/workbench.ts";

export class ReviewCommentNotFoundError extends Schema.TaggedError<ReviewCommentNotFoundError>()(
  "ReviewCommentNotFoundError",
  {
    commentId: Schema.String,
  },
) {}

const decodeComment = Schema.decodeUnknownEffect(Schema.Struct(ReviewComment.fields));
const decodeReply = Schema.decodeUnknownEffect(Schema.Struct(ReviewReply.fields));

export interface NewReviewComment {
  readonly changeId: ChangeId;
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  /** Null/omitted only for comments created by the retired live-diff contract. */
  readonly anchor?: ReviewCommentAnchor | null;
  readonly authorKind: CommentAuthor;
  readonly authorName: string;
  readonly body: string;
  /** Defaults to `note`; the suggestion pass writes `suggestion` + the replacement text. */
  readonly kind?: CommentKind;
  readonly suggestion?: string | null;
  /** Reviewer comments are born `open`; Mend's findings are born `draft` (§7.3). */
  readonly state: CommentState;
  /** Links into the session record — required on record-grounded Mend findings. */
  readonly evidence?: ReadonlyArray<RecordLink>;
}

const encodeEvidence = Schema.encodeEffect(Schema.Array(RecordLink));
const encodeAnchor = Schema.encodeEffect(ReviewCommentAnchor);

/** Review comments on a session change (plan §5.7) — reviewer's and Mend's, one pipeline. */
export class ReviewCommentsRepo extends Context.Service<
  ReviewCommentsRepo,
  {
    readonly create: (comment: NewReviewComment) => Effect.Effect<ReviewComment>;
    readonly byId: (
      id: ReviewCommentId,
    ) => Effect.Effect<ReviewComment, ReviewCommentNotFoundError>;
    /** The change's comments, oldest first: never its replies. */
    readonly listForChange: (changeId: ChangeId) => Effect.Effect<ReadonlyArray<ReviewComment>>;
    /** Every reply on the change, oldest first. */
    readonly listReplies: (changeId: ChangeId) => Effect.Effect<ReadonlyArray<ReviewReply>>;
    /**
     * A person's reply under `parent`, at its place: born `open` and unsent. The caller has
     * checked that `parent` is a comment (not a reply) a reply may hang under.
     */
    readonly createReply: (
      parent: ReviewComment,
      reply: { readonly authorName: string; readonly body: string },
    ) => Effect.Effect<ReviewReply>;
    readonly setState: (id: ReviewCommentId, state: CommentState) => Effect.Effect<void>;
    /** Records which session a bundled follow-up carrying this comment went to. */
    readonly markSent: (id: ReviewCommentId, sessionId: SessionId) => Effect.Effect<void>;
    /** Marks only selected unsent comments after process membership is durable. */
    readonly markSelectedSent: (
      ids: ReadonlyArray<ReviewCommentId>,
      sessionId: SessionId,
    ) => Effect.Effect<number>;
  }
>()("@mend/db/ReviewCommentsRepo") {}

const decodeRow = (row: unknown) =>
  decodeComment(row).pipe(
    Effect.map((decoded) => new ReviewComment(decoded)),
    Effect.orDie,
  );

export const ReviewCommentsRepoLive: Layer.Layer<
  ReviewCommentsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ReviewCommentsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const notify = Effect.fn("ReviewCommentsRepo.notify")(function* (
      id: ReviewCommentId,
      changeId: ChangeId,
    ) {
      const [row] = yield* db
        .select({ projectId: worktreeChanges.projectId, worktreeId: worktreeChanges.worktreeId })
        .from(worktreeChanges)
        .where(eq(worktreeChanges.id, changeId))
        .limit(1)
        .pipe(Effect.orDie);
      yield* notifyEvent(sql, {
        type: "review-comment",
        commentId: id,
        changeId,
        worktreeId: row?.worktreeId ?? "",
        projectId: row?.projectId ?? "",
      });
    });

    const create = Effect.fn("ReviewCommentsRepo.create")(function* (comment: NewReviewComment) {
      // Sequences ride JSONB as decimal strings — the RecordLink codec's wire shape.
      const evidence = yield* encodeEvidence(comment.evidence ?? []).pipe(Effect.orDie);
      const anchor =
        comment.anchor === undefined || comment.anchor === null
          ? null
          : yield* encodeAnchor(comment.anchor).pipe(Effect.orDie);
      const [row] = yield* db
        .insert(reviewComments)
        .values({
          id: ReviewCommentId.make(crypto.randomUUID()),
          changeId: comment.changeId,
          file: comment.file,
          line: comment.line,
          endLine: comment.endLine,
          anchor,
          authorKind: comment.authorKind,
          authorName: comment.authorName,
          body: comment.body,
          kind: comment.kind ?? "note",
          suggestion: comment.suggestion ?? null,
          state: comment.state,
          evidence,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("review comment insert returned no row");
      const created = yield* decodeRow(row);
      yield* notify(created.id, comment.changeId);
      return created;
    });

    const byId = Effect.fn("ReviewCommentsRepo.byId")(function* (id: ReviewCommentId) {
      const [row] = yield* db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ReviewCommentNotFoundError({ commentId: id });
      return yield* decodeRow(row);
    });

    const listForChange = Effect.fn("ReviewCommentsRepo.listForChange")(function* (
      changeId: ChangeId,
    ) {
      const rows = yield* db
        .select()
        .from(reviewComments)
        .where(and(eq(reviewComments.changeId, changeId), isNull(reviewComments.parentId)))
        .orderBy(asc(reviewComments.createdAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, decodeRow);
    });

    const decodeReplyRow = (row: unknown) =>
      decodeReply(row).pipe(
        Effect.map((decoded) => new ReviewReply(decoded)),
        Effect.orDie,
      );

    const listReplies = Effect.fn("ReviewCommentsRepo.listReplies")(function* (changeId: ChangeId) {
      const rows = yield* db
        .select()
        .from(reviewComments)
        .where(and(eq(reviewComments.changeId, changeId), isNotNull(reviewComments.parentId)))
        .orderBy(asc(reviewComments.createdAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, decodeReplyRow);
    });

    const createReply = Effect.fn("ReviewCommentsRepo.createReply")(function* (
      parent: ReviewComment,
      reply: { readonly authorName: string; readonly body: string },
    ) {
      const anchor =
        parent.anchor === null ? null : yield* encodeAnchor(parent.anchor).pipe(Effect.orDie);
      const [row] = yield* db
        .insert(reviewComments)
        .values({
          id: ReviewCommentId.make(crypto.randomUUID()),
          changeId: parent.changeId,
          parentId: parent.id,
          file: parent.file,
          line: parent.line,
          endLine: parent.endLine,
          anchor,
          authorKind: "reviewer",
          authorName: reply.authorName,
          body: reply.body,
          kind: "note",
          state: "open",
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("review reply insert returned no row");
      const created = yield* decodeReplyRow(row);
      yield* notify(created.id, parent.changeId);
      return created;
    });

    const setState = Effect.fn("ReviewCommentsRepo.setState")(function* (
      id: ReviewCommentId,
      state: CommentState,
    ) {
      const [row] = yield* db
        .update(reviewComments)
        .set({ state, updatedAt: yield* DateTime.nowAsDate })
        .where(eq(reviewComments.id, id))
        .returning({ changeId: reviewComments.changeId })
        .pipe(Effect.orDie);
      if (row !== undefined) yield* notify(id, row.changeId);
    });

    const markSent = Effect.fn("ReviewCommentsRepo.markSent")(function* (
      id: ReviewCommentId,
      sessionId: SessionId,
    ) {
      yield* db
        .update(reviewComments)
        .set({ sentToSessionId: sessionId, updatedAt: yield* DateTime.nowAsDate })
        .where(eq(reviewComments.id, id))
        .pipe(Effect.orDie);
    });

    const markSelectedSent = Effect.fn("ReviewCommentsRepo.markSelectedSent")(function* (
      ids: ReadonlyArray<ReviewCommentId>,
      sessionId: SessionId,
    ) {
      if (ids.length === 0) return 0;
      const rows = yield* db
        .update(reviewComments)
        .set({ sentToSessionId: sessionId, updatedAt: yield* DateTime.nowAsDate })
        .where(and(inArray(reviewComments.id, ids), isNull(reviewComments.sentToSessionId)))
        .returning({ id: reviewComments.id, changeId: reviewComments.changeId })
        .pipe(Effect.orDie);
      yield* Effect.forEach(rows, (row) => notify(row.id, row.changeId));
      return rows.length;
    });

    return {
      create,
      byId,
      listForChange,
      listReplies,
      createReply,
      setState,
      markSent,
      markSelectedSent,
    };
  }),
);
