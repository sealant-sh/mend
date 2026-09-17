import {
  Brief,
  BriefComment,
  BriefVersion,
  Change,
  Issue,
  IssueId,
  IssueSource,
  RunId,
} from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { IssueDetail, NotFound, RunDetail, RunSourceView, TracePage } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/** Manual entry is just another intake; tracker layers arrive with M5. */
export class NewIssue extends Schema.Class<NewIssue>("NewIssue")({
  source: IssueSource,
  externalRef: Schema.NullOr(Schema.String),
  repository: Schema.String,
  title: Schema.String,
  body: Schema.String,
}) {}

/**
 * The moves a person can make on the board — Gate 1 and its undo. Everything
 * else (mending, review, merged) is the product's to set, never the drag's.
 */
export class QueueMove extends Schema.Class<QueueMove>("QueueMove")({
  stage: Schema.Literals(["triage", "queued"]),
  /** Target index within queued, 0 = top. Appends when null. */
  position: Schema.NullOr(Schema.Int),
}) {}

export const issuesGroup = HttpApiGroup.make("issues")
  .add(HttpApiEndpoint.get("list", "/issues", { success: Schema.Array(Issue), error: NotFound }))
  .add(
    HttpApiEndpoint.post("create", "/issues", {
      payload: NewIssue,
      success: Issue,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/issues/:id", {
      params: { id: IssueId },
      success: IssueDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("move", "/issues/:id/move", {
      params: { id: IssueId },
      payload: QueueMove,
      success: Issue,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** The living brief with the change it belongs to — one per issue at most. */
export class BriefDetail extends Schema.Class<BriefDetail>("BriefDetail")({
  brief: Brief,
  change: Change,
}) {}

/** A reviewer's comment as posted: the thread it anchors to, and the words. */
export class NewBriefComment extends Schema.Class<NewBriefComment>("NewBriefComment")({
  /** `q<index>` anchors a review question; `general` is the brief-wide thread. */
  thread: Schema.String,
  body: Schema.String,
}) {}

export const briefsGroup = HttpApiGroup.make("briefs")
  .add(
    HttpApiEndpoint.get("byIssue", "/issues/:id/brief", {
      params: { id: IssueId },
      success: BriefDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("comments", "/issues/:id/brief/comments", {
      params: { id: IssueId },
      success: Schema.Array(BriefComment),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("comment", "/issues/:id/brief/comments", {
      params: { id: IssueId },
      payload: NewBriefComment,
      success: BriefComment,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("versions", "/issues/:id/brief/versions", {
      params: { id: IssueId },
      success: Schema.Array(BriefVersion),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

export const runsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("detail", "/runs/:id", {
      params: { id: RunId },
      success: RunDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("trace", "/runs/:id/trace", {
      params: { id: RunId },
      query: { from: Schema.optional(Schema.String) },
      success: TracePage,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("sources", "/runs/:id/sources", {
      params: { id: RunId },
      success: Schema.Array(RunSourceView),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);
