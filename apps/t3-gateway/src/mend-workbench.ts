import * as Schema from "effect/Schema";

/**
 * The Mend workbench shapes the gateway reads, decoded field by field from Mend's public API. Each
 * names the @mend/api-contracts or @mend/domain class it is read from; only the fields the
 * projection uses are decoded, so Mend can add fields freely. Timestamps stay ISO strings.
 */

/** `Project` in @mend/domain/workbench, from `GET /api/projects` and `GET /api/projects/:id`. */
export const MendProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The bare repository in Mend's store; its worktrees sit beside it in `worktrees/`. */
  storePath: Schema.String,
  defaultBranch: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MendProject = typeof MendProject.Type;

/** `ProtocolLaunchOptions` in @mend/domain/workbench: what a protocol launch applied. */
export const MendProtocolOptions = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  permissionMode: Schema.String,
});
export type MendProtocolOptions = typeof MendProtocolOptions.Type;

/** `SessionProcess` in @mend/domain/workbench. */
export const MendProcess = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  harness: Schema.NullOr(Schema.String),
  status: Schema.String,
  providerSessionId: Schema.NullOr(Schema.String),
  protocolOptions: Schema.NullOr(MendProtocolOptions),
  createdAt: Schema.String,
  exitedAt: Schema.NullOr(Schema.String),
});
export type MendProcess = typeof MendProcess.Type;

/** `Session` in @mend/domain/workbench. */
export const MendSession = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  worktreeId: Schema.String,
  harness: Schema.String,
  /** Absent on servers before the column; null for a harness with no catalog. */
  model: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.NullOr(Schema.String),
  /** The worktree's directory, relative to the project's `worktrees/`. */
  worktree: Schema.String,
  branch: Schema.String,
  baseSha: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  status: Schema.String,
  ownerUserId: Schema.NullOr(Schema.String),
  /** What Mend reported when the session settled: a failed launch says why here. */
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MendSession = typeof MendSession.Type;

/** `SessionAnnotation` in @mend/api-contracts: the list facts beside each session. */
export const MendSessionAnnotation = Schema.Struct({
  sessionId: Schema.String,
  changeId: Schema.NullOr(Schema.String),
  currentAgent: Schema.NullOr(MendProcess),
});
export type MendSessionAnnotation = typeof MendSessionAnnotation.Type;

/** `ProjectDetail` in @mend/api-contracts, from `GET /api/projects/:id`. */
export const MendProjectDetail = Schema.Struct({
  project: MendProject,
  sessions: Schema.Array(MendSession),
  annotations: Schema.Array(MendSessionAnnotation),
});
export type MendProjectDetail = typeof MendProjectDetail.Type;

/** `AgentTurn` in @mend/domain/workbench, from `GET /api/sessions/:id/turns`. */
export const MendTurn = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  /** Position in the conversation, from 0. */
  ordinal: Schema.Number,
  author: Schema.NullOr(Schema.String),
  /** `request` (input Mend sent) or `harness` (a turn the agent opened); older servers omit it. */
  origin: Schema.optional(Schema.String),
  input: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
});
export type MendTurn = typeof MendTurn.Type;

/** `AgentItem` in @mend/domain/workbench, from `GET /api/sessions/:id/items`. */
export const MendItem = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  /** The session's change-feed cursor: bumps on every update, so `after=` re-delivers changes. */
  seq: Schema.Number,
  kind: Schema.String,
  status: Schema.String,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  /** The harness's own item, as its adapter recorded it. */
  data: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MendItem = typeof MendItem.Type;

/** `AgentInputQuestion` in @mend/domain/workbench. */
export const MendInputQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.NullOr(Schema.String),
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  multiSelect: Schema.Boolean,
});
export type MendInputQuestion = typeof MendInputQuestion.Type;

/** `AgentRequest` in @mend/domain/workbench, from `GET /api/sessions/:id/requests`. */
export const MendRequest = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  kind: Schema.String,
  title: Schema.NullOr(Schema.String),
  detail: Schema.Unknown,
  questions: Schema.NullOr(Schema.Array(MendInputQuestion)),
  status: Schema.String,
  decision: Schema.NullOr(Schema.String),
  answers: Schema.NullOr(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
});
export type MendRequest = typeof MendRequest.Type;

/** `SessionDetail` in @mend/api-contracts, from `GET /api/sessions/:id`. */
export const MendSessionDetail = Schema.Struct({
  session: MendSession,
  /** What the caller may do; servers before organizations omit it. */
  control: Schema.optional(Schema.Struct({ steer: Schema.Boolean })),
  change: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      branch: Schema.String,
      baseSha: Schema.String,
      headSha: Schema.NullOr(Schema.String),
    }),
  ),
  currentAgent: Schema.NullOr(MendProcess),
});
export type MendSessionDetail = typeof MendSessionDetail.Type;

/** `ChangeDiff` in @mend/api-contracts, from `GET /api/changes/:id/diff`: git's live answer. */
export const MendChangeDiff = Schema.Struct({
  change: Schema.Struct({
    id: Schema.String,
    branch: Schema.String,
    baseSha: Schema.String,
    headSha: Schema.NullOr(Schema.String),
  }),
  diff: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, additions: Schema.Number, deletions: Schema.Number }),
  ),
  /** What the diff was observed on ("observed at capture 18 · seq 22"); older servers omit it. */
  observation: Schema.optional(Schema.Struct({ label: Schema.String })),
});
export type MendChangeDiff = typeof MendChangeDiff.Type;

/**
 * One SSE frame of `GET /api/events` (`MendEvent` in @mend/db): a pointer, never data. The
 * gateway reads which project and session it concerns and re-reads through the API.
 */
export const MendEventPointer = Schema.Struct({
  type: Schema.String,
  projectId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  /** `user` pointers: which of the account's facts moved (`devices`, `access`, …). */
  facet: Schema.optional(Schema.String),
});
export type MendEventPointer = typeof MendEventPointer.Type;
