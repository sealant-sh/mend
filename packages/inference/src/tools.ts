import {
  Brief,
  BriefDocument,
  ChangeId,
  Freshness,
  IssueId,
  Provenance,
  RunId,
  Sha,
} from "@mend/domain";
import { Effect, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceToolError } from "./provider.ts";

/**
 * The tool set from docs/archive/PRODUCT.md — every tool a Mend Effect service with a typed
 * schema. The rules are enforced by omission: no merge, no file write, no
 * shell, no queue tools, no tracker access beyond the issue at hand. A context
 * is given only the tools it needs, never the full set by default.
 *
 * Contracts only in M0; live layers land with M2 (the brief) and M3 (GitHub).
 */

// ─── Read — grounding. No side effects. ─────────────────────────────────────

/** Narrows `read_recording` to a slice — the full trace is large. */
export class RecordingSelector extends Schema.Class<RecordingSelector>("RecordingSelector")({
  // Sequences ride every wire as decimal strings (JSON has no bigint).
  fromSequence: Schema.NullOr(Schema.BigIntFromString),
  toSequence: Schema.NullOr(Schema.BigIntFromString),
  /** Timeline entry kinds to keep, null for all. */
  kinds: Schema.NullOr(Schema.Array(Schema.String)),
  /** Only the source trail. */
  sourcesOnly: Schema.Boolean,
}) {}

export class RecordingEvent extends Schema.Class<RecordingEvent>("RecordingEvent")({
  sequence: Schema.BigIntFromString,
  kind: Schema.String,
  /** Wall-clock time when supplied; a monotonic record counter is not a calendar date. */
  occurredAt: Schema.NullOr(Schema.Date),
  /** sealant's decimal-string ordering clock, preserved verbatim without guessing an epoch. */
  monotonicTimestamp: Schema.optional(Schema.String),
  /** One-line human summary, straight from the record. */
  summary: Schema.String,
  /** `observed` (the runtime saw it) or `inferred` (the harness claimed it). */
  provenance: Provenance,
  data: Schema.Unknown,
}) {}

/**
 * The recording is the only permitted source of claims: a statement that
 * cannot be traced to an event returned here must be written as `inferred`.
 */
export class ReadRecording extends Context.Service<
  ReadRecording,
  {
    readonly read: (
      run: RunId,
      selector?: RecordingSelector,
    ) => Effect.Effect<ReadonlyArray<RecordingEvent>, InferenceToolError>;
  }
>()("@mend/inference/tools/ReadRecording") {}

export class IssueComment extends Schema.Class<IssueComment>("IssueComment")({
  author: Schema.String,
  body: Schema.String,
  postedAt: Schema.Date,
}) {}

/** The tracker issue, normalized across GitHub/Linear/Jira (or manual entry). */
export class IssueView extends Schema.Class<IssueView>("IssueView")({
  title: Schema.String,
  body: Schema.String,
  comments: Schema.Array(IssueComment),
  links: Schema.Array(Schema.String),
}) {}

export class ReadIssue extends Context.Service<
  ReadIssue,
  {
    readonly read: (issue: IssueId) => Effect.Effect<IssueView, InferenceToolError>;
  }
>()("@mend/inference/tools/ReadIssue") {}

export class CheckResult extends Schema.Class<CheckResult>("CheckResult")({
  name: Schema.String,
  status: Schema.String,
}) {}

export class ChangedFile extends Schema.Class<ChangedFile>("ChangedFile")({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
}) {}

/**
 * Machine facts about the branch and PR — the brief's mono facts, the
 * `unrelated change` disposition, and staleness handling.
 */
export class ChangeView extends Schema.Class<ChangeView>("ChangeView")({
  diff: Schema.String,
  baseSha: Schema.NullOr(Sha),
  headSha: Schema.NullOr(Sha),
  files: Schema.Array(ChangedFile),
  checks: Schema.Array(CheckResult),
  freshness: Freshness,
}) {}

export class ReadChange extends Context.Service<
  ReadChange,
  {
    readonly read: (change: ChangeId) => Effect.Effect<ChangeView, InferenceToolError>;
  }
>()("@mend/inference/tools/ReadChange") {}

/**
 * Recompiles must amend the existing living document, not start over; comment
 * routing needs to know what the brief already claims.
 */
export class ReadBrief extends Context.Service<
  ReadBrief,
  {
    readonly read: (change: ChangeId) => Effect.Effect<Brief, InferenceToolError>;
  }
>()("@mend/inference/tools/ReadBrief") {}

// ─── Act — recorded side effects. Each call is itself evidence. ─────────────

export class CommentRef extends Schema.Class<CommentRef>("CommentRef")({
  id: Schema.String,
  url: Schema.NullOr(Schema.String),
}) {}

/**
 * The failure comment (mini-brief) and nothing else unprompted. Bounded to the
 * issue being worked — there is no tool to touch any other issue.
 */
export class PostIssueComment extends Context.Service<
  PostIssueComment,
  {
    readonly post: (issue: IssueId, body: string) => Effect.Effect<CommentRef, InferenceToolError>;
  }
>()("@mend/inference/tools/PostIssueComment") {}

/** The "question back" action — asking is cheaper and safer than guessing. */
export class ReplyOnBrief extends Context.Service<
  ReplyOnBrief,
  {
    readonly reply: (
      change: ChangeId,
      thread: string,
      body: string,
    ) => Effect.Effect<CommentRef, InferenceToolError>;
  }
>()("@mend/inference/tools/ReplyOnBrief") {}

/** `follow-up` alters code in response to review; `verification` executes without changing code. */
export const StartRunKind = Schema.Literals(["follow-up", "verification"]);
export type StartRunKind = typeof StartRunKind.Type;

/**
 * The only path by which inference can cause code to change — and it leads
 * into a workspace, recorded like every other run. It cannot target a new
 * branch or another issue.
 */
export class StartRun extends Context.Service<
  StartRun,
  {
    readonly start: (
      change: ChangeId,
      instruction: string,
      kind: StartRunKind,
    ) => Effect.Effect<RunId, InferenceToolError>;
  }
>()("@mend/inference/tools/StartRun") {}

/**
 * Replaces the living brief and updates the PR description; prior versions
 * stay in history so "what did the brief claim when I approved" is answerable.
 */
export class PublishBrief extends Context.Service<
  PublishBrief,
  {
    readonly publish: (
      change: ChangeId,
      document: BriefDocument,
    ) => Effect.Effect<{ readonly version: number }, InferenceToolError>;
  }
>()("@mend/inference/tools/PublishBrief") {}
