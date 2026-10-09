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
  /** Where the project was adopted from; null for one adopted from a local path. */
  originUrl: Schema.optional(Schema.NullOr(Schema.String)),
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

/** `LivePerson` in @mend/domain/workbench: a person with a process live in a session's executor. */
export const MendLivePerson = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
});
export type MendLivePerson = typeof MendLivePerson.Type;

/**
 * One row of `GET /api/sessions` (`Session` in @mend/domain/workbench), read only for what is
 * said about sharing its workspace (docs/adr/0016, decisions 6, 13 and 14): the people live in its
 * executor, whether its owner shares control, and whether its executor waits to be replaced. They
 * decide whether the waiting line and the retirement are read at all; the project read's sessions
 * carry none of them. Servers before per-person homes omit the fields.
 */
export const MendActiveSession = Schema.Struct({
  id: Schema.String,
  livePeople: Schema.optional(Schema.Array(MendLivePerson)),
  sharedControlEnabledAt: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceRetirement: Schema.optional(Schema.NullOr(Schema.Literals(["marked", "retiring"]))),
});
export type MendActiveSession = typeof MendActiveSession.Type;

/**
 * `ConversationWait` in @mend/domain/workbench, from `GET /api/sessions/:id/waiting` (docs/adr/0016,
 * decision 6): the turn that waits for the previous sender's own work, and the waiting line.
 */
export const MendConversationWait = Schema.Struct({
  turnId: Schema.String,
  /** "Waits for Alice's 2 background tasks … before Bob's turn starts." */
  line: Schema.String,
  /** When the turn started waiting. */
  since: Schema.String,
  work: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      id: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
});
export type MendConversationWait = typeof MendConversationWait.Type;

/**
 * `WorkspaceRetirement` in @mend/domain/workbench, from `GET /api/sessions/:id/workspace-retirement`
 * (docs/adr/0016, decision 14): an executor started before per-person homes, waiting to be replaced.
 */
export const MendWorkspaceRetirement = Schema.Struct({
  state: Schema.Literals(["marked", "retiring"]),
  preRelease: Schema.Boolean,
  launcher: Schema.NullOr(Schema.String),
  stops: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "terminal",
        "shell",
        "service",
        "turn",
        "process",
        "container",
        "unchecked",
      ]),
      label: Schema.String,
    }),
  ),
  reason: Schema.NullOr(Schema.String),
  /** When what runs was checked beyond Mend's records; null when only those were read. */
  checkedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** What the viewer was shown, as one token; the gateway replaces nothing, so it only carries it. */
  fingerprint: Schema.optional(Schema.String),
  canReplace: Schema.Boolean,
});
export type MendWorkspaceRetirement = typeof MendWorkspaceRetirement.Type;

/** What the gateway reads of `WorktreeListing` (`GET /api/projects/:id/worktrees`): the names. */
export const MendWorktreeListing = Schema.Struct({
  worktrees: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/**
 * `ProjectFileListing` in @mend/api-contracts, from `GET /api/projects/:id/files`: every file of a
 * session's worktree, or of the project's default branch, flat and sorted.
 */
export const MendFileListing = Schema.Struct({
  files: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type MendFileListing = typeof MendFileListing.Type;

/** `ChangeStats` in @mend/api-contracts, from `GET /api/changes/:id/stats`: the change's totals. */
export const MendChangeStats = Schema.Struct({
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type MendChangeStats = typeof MendChangeStats.Type;

/** `PastedImage` in @mend/api-contracts, from `POST /api/sessions/:id/images`. */
export const MendPastedImage = Schema.Struct({
  /** The file as the session's workspace sees it: what the turn names. */
  path: Schema.String,
});
export type MendPastedImage = typeof MendPastedImage.Type;

/**
 * `Checkpoint` in @mend/domain/workbench: a snapshot of a worktree. The chain is the worktree's,
 * shared by every session in it; a `turn-boundary` one is taken when a turn ends.
 */
export const MendCheckpoint = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  ordinal: Schema.Number,
  ref: Schema.String,
  trigger: Schema.String,
  createdAt: Schema.String,
});
export type MendCheckpoint = typeof MendCheckpoint.Type;

/** What the gateway reads of `WorktreeDetail` (`GET /api/worktrees/:id`): its chain. */
export const MendWorktreeDetail = Schema.Struct({
  checkpoints: Schema.Array(MendCheckpoint),
});

/** One file of a slice (`WorktreeRangeFile` in @mend/api-contracts). */
export const MendRangeFile = Schema.Struct({
  oldPath: Schema.NullOr(Schema.String),
  newPath: Schema.NullOr(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type MendRangeFile = typeof MendRangeFile.Type;

/** `WorktreeRangeDiff` in @mend/api-contracts, from `GET /api/worktrees/:id/diff`. */
export const MendRangeDiff = Schema.Struct({
  diff: Schema.String,
  files: Schema.Array(MendRangeFile),
  /** Mend rendered the patches of only some files (its file cap, byte budget or deadline). */
  truncated: Schema.Boolean,
});
export type MendRangeDiff = typeof MendRangeDiff.Type;

/** `WorktreeContents` in @mend/api-contracts, from `GET /api/worktrees/:id/contents`. */
export const MendWorktreeContents = Schema.Struct({
  file: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      contents: Schema.NullOr(Schema.String),
      size: Schema.Number,
      truncated: Schema.Boolean,
      binary: Schema.Boolean,
    }),
  ),
  search: Schema.NullOr(
    Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String }),
      ),
      truncated: Schema.Boolean,
    }),
  ),
});
export type MendWorktreeContents = typeof MendWorktreeContents.Type;

/** `RemovalReport` in @mend/api-contracts, from `DELETE /api/sessions/:id`. */
export const MendRemovalReport = Schema.Struct({
  removed: Schema.Boolean,
  /** What stays for now, in Mend's words ("… · removed once its workspace has stopped"). */
  leftover: Schema.NullOr(Schema.String),
});
export type MendRemovalReport = typeof MendRemovalReport.Type;

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
