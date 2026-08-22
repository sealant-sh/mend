import type {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  BriefCommentId,
  BriefDocument,
  EvidencePointer,
  FailureBrief,
  FollowUpId,
  InferenceCallId,
  IssueId,
  MendSettings,
  ReviewQuestionId,
  ReviewCommentId,
  ReviewSliceId,
  BriefId,
  ChangeId,
  CheckpointId,
  CommentAuthorKind,
  ContextSnapshotId,
  Disposition,
  Freshness,
  InferenceContext,
  InferenceToolName,
  IssueSource,
  IssueStage,
  ProjectEnvironmentVariableId,
  ProjectId,
  ProjectSecretId,
  ProjectMountId,
  ReferenceId,
  RoutedAction,
  RunId,
  RunKind,
  RunOutcome,
  RunStatus,
  SealantRunId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionGitOpId,
  SessionId,
  SessionProcessId,
  Sha,
  DotfilesRepository,
  WorkspaceImage,
} from "@mend/domain";
import type {
  AgentApprovalDecision,
  AgentInputAnswers,
  AgentInputQuestion,
  AgentItemKind,
  AgentItemStatus,
  AgentRequestKind,
  AgentRequestStatus,
  AgentTurnStatus,
  AgentTurnUsage,
  AutomationChoice,
  CheckpointTrigger,
  ContextItem,
  FollowUpStatus,
  GitAuthMode,
  GitTransportKind,
  CommentAuthor,
  CommentKind,
  CommentState,
  HotWorkspaceEnvironment,
  HotWorkspaceStatus,
  PassKind,
  PassStatus,
  RecordLink,
  ReviewCommentAnchor,
  DiffDigest,
  TourStop,
  SessionExtraMount,
  ServiceBrowserScheme,
  ServiceDeclarationSource,
  ServiceForwardState,
  ServiceObservationSource,
  ServiceTargetState,
  ServiceTransport,
  SessionProcessKind,
  SessionProcessStatus,
  SessionDotfiles,
  SessionReferenceMount,
  SessionStatus,
} from "@mend/domain/workbench";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  snakeCase,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Runtime schema for Mend-owned product state; the existing migrations remain authoritative. */
/** Keep TypeScript properties idiomatic while matching Mend's existing snake_case schema. */
const pgTable = snakeCase.table;

export const issues = pgTable(
  "issues",
  {
    id: text().$type<IssueId>().primaryKey(),
    source: text().$type<IssueSource>().notNull(),
    externalRef: text(),
    repository: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    stage: text().$type<IssueStage>().notNull().default("triage"),
    position: integer(),
    lastFailureRunId: text().$type<RunId>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("issues_stage_position_idx").on(table.stage, table.position)],
);

export const changes = pgTable("changes", {
  id: text().$type<ChangeId>().primaryKey(),
  issueId: text()
    .$type<IssueId>()
    .notNull()
    .unique()
    .references(() => issues.id, { onDelete: "cascade" }),
  branch: text().notNull(),
  baseSha: text().$type<Sha>(),
  headSha: text().$type<Sha>(),
  prNumber: integer(),
  prUrl: text(),
  freshness: text().$type<Freshness>().notNull().default("current"),
  movedBaseSha: text().$type<Sha>(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable(
  "runs",
  {
    id: text().$type<RunId>().primaryKey(),
    issueId: text()
      .$type<IssueId>()
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    changeId: text()
      .$type<ChangeId>()
      .references(() => changes.id, { onDelete: "set null" }),
    kind: text().$type<RunKind>().notNull(),
    sealantRunId: text().$type<SealantRunId>(),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>(),
    status: text().$type<RunStatus>().notNull().default("queued"),
    outcome: text().$type<RunOutcome>(),
    summary: text(),
    lastSeenSequence: bigint({ mode: "bigint" }).notNull().default(0n),
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    settledAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    failureBrief: jsonb().$type<typeof FailureBrief.Encoded>(),
  },
  (table) => [index("runs_issue_idx").on(table.issueId)],
);

export const briefs = pgTable("briefs", {
  id: text().$type<BriefId>().primaryKey(),
  changeId: text()
    .$type<ChangeId>()
    .notNull()
    .unique()
    .references(() => changes.id, { onDelete: "cascade" }),
  currentVersion: integer().notNull().default(1),
  document: jsonb().$type<typeof BriefDocument.Encoded>().notNull(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const briefVersions = pgTable(
  "brief_versions",
  {
    briefId: text()
      .$type<BriefId>()
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    document: jsonb().$type<typeof BriefDocument.Encoded>().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.briefId, table.version] })],
);

export const reviewQuestions = pgTable(
  "review_questions",
  {
    id: text().$type<ReviewQuestionId>().primaryKey(),
    briefId: text()
      .$type<BriefId>()
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    index: integer().notNull(),
    question: text().notNull(),
    disposition: text().$type<Disposition>().notNull(),
    evidence: jsonb()
      .$type<ReadonlyArray<typeof EvidencePointer.Encoded>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [unique("review_questions_brief_id_index_key").on(table.briefId, table.index)],
);

export const briefComments = pgTable(
  "brief_comments",
  {
    id: text().$type<BriefCommentId>().primaryKey(),
    briefId: text()
      .$type<BriefId>()
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    thread: text().notNull(),
    authorKind: text().$type<CommentAuthorKind>().notNull(),
    authorName: text().notNull(),
    body: text().notNull(),
    routedAction: text().$type<RoutedAction>(),
    routedRunId: text().$type<RunId>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("brief_comments_brief_idx").on(table.briefId, table.createdAt)],
);

export const projects = pgTable("projects", {
  id: text().$type<ProjectId>().primaryKey(),
  name: text().notNull().unique(),
  originUrl: text(),
  storePath: text().notNull().unique(),
  defaultBranch: text().notNull(),
  adoptedSha: text().$type<Sha>(),
  autoTour: text().$type<AutomationChoice>().notNull().default("inherit"),
  autoSuggest: text().$type<AutomationChoice>().notNull().default("inherit"),
  autoName: text().$type<AutomationChoice>().notNull().default("inherit"),
  gitAuthMode: text().$type<GitAuthMode>().notNull().default("ambient"),
  // NULL inherits the global settings.workspaceImage default.
  workspaceImage: jsonb().$type<typeof WorkspaceImage.Encoded>(),
  // Whether sessions here receive the launching user's dotfiles.
  applyDotfiles: boolean().notNull().default(true),
  // Aggregate revision of the project's environment variables; bumped by every mutation under the
  // project row lock, so a launch snapshot can prove it read one coherent state.
  environmentRevision: integer().notNull().default(0),
  // Same discipline for the Secrets set.
  secretRevision: integer().notNull().default(0),
  // How many hot workspaces to keep ready for new sessions (0 = none).
  hotSessions: integer().notNull().default(0),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

/**
 * Pre-provisioned session skeletons kept ready for instant session starts. `id` is the session id
 * the claiming session adopts; the worktree, branch, and session socket dir all derive from it.
 * Claimable only while `fingerprint` (a hash of every create-time-fixed workspace input) still
 * matches the project's current configuration.
 */
export const hotWorkspaces = pgTable(
  "hot_workspaces",
  {
    id: text().$type<SessionId>().primaryKey(),
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerUserId: text(),
    status: text().$type<HotWorkspaceStatus>().notNull().default("warming"),
    error: text(),
    fingerprint: text().notNull(),
    worktree: text().notNull(),
    branch: text().notNull(),
    baseSha: text().$type<Sha>().notNull(),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>(),
    workspaceImage: jsonb().$type<typeof WorkspaceImage.Encoded>(),
    dotfiles: jsonb().$type<typeof SessionDotfiles.Encoded>(),
    environment: jsonb().$type<typeof HotWorkspaceEnvironment.Encoded>(),
    referenceMounts: jsonb()
      .$type<ReadonlyArray<SessionReferenceMount>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    extraMounts: jsonb()
      .$type<ReadonlyArray<SessionExtraMount>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("hot_workspaces_project_status_idx").on(table.projectId, table.status)],
);

/**
 * Per-user dotfiles configuration — the repository knob only. Snapshot CONTENT lives in the
 * dotfiles store (a bare git repo per user under the store root), never in the database.
 */
/** Mend user → Sealant user (docs/SEALANT-IDENTITY.md). `user` is better-auth's table. */
export const userSealantIdentities = pgTable("user_sealant_identities", {
  userId: text().primaryKey(),
  sealantUserId: text().notNull().unique(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const userDotfiles = pgTable("user_dotfiles", {
  userId: text().primaryKey(),
  repository: jsonb().$type<typeof DotfilesRepository.Encoded>(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const projectMounts = pgTable(
  "project_mounts",
  {
    id: text().$type<ProjectMountId>().primaryKey(),
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    hostPath: text().notNull(),
    readOnly: boolean().notNull().default(true),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("project_mounts_project_id_name_key").on(table.projectId, table.name),
    unique("project_mounts_project_id_host_path_key").on(table.projectId, table.hostPath),
  ],
);

/**
 * Project-owned, explicitly NON-SECRET environment variables
 * (`.plans/project-environment-variables.md`): plaintext by design, read as one snapshot at each
 * fresh workspace launch, inherited by every process the platform starts in that workspace. Stable
 * IDs make rename an atomic update; the integer row revision drives stale-write checks.
 */
export const projectEnvironmentVariables = pgTable(
  "project_environment_variables",
  {
    id: text().$type<ProjectEnvironmentVariableId>().primaryKey(),
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    value: text().notNull(),
    revision: integer().notNull().default(1),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("project_environment_variables_project_id_name_key").on(table.projectId, table.name),
  ],
);

/**
 * Project-owned SECRET environment variables (`.plans/project-environment-variables.md`, "Scope
 * expansion"): the value is sealed at rest with the machine's secrets key (`@mend/store`
 * SecretCipher) and never returned by any API; launch decrypts once and hands the set to Sealant's
 * transient secret channel. Same stable-ID / integer-revision discipline as the plaintext set.
 */
export const projectSecrets = pgTable(
  "project_secrets",
  {
    id: text().$type<ProjectSecretId>().primaryKey(),
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    sealedValue: text().notNull(),
    revision: integer().notNull().default(1),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("project_secrets_project_id_name_key").on(table.projectId, table.name)],
);

export const referenceRepos = pgTable("reference_repos", {
  id: text().$type<ReferenceId>().primaryKey(),
  name: text().notNull().unique(),
  originUrl: text().notNull(),
  path: text().notNull().unique(),
  pinnedRef: text(),
  headSha: text().$type<Sha>(),
  refreshedAt: timestamp({ mode: "date", withTimezone: true }),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const projectReferences = pgTable(
  "project_references",
  {
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    referenceId: text()
      .$type<ReferenceId>()
      .notNull()
      .references(() => referenceRepos.id, { onDelete: "cascade" }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.referenceId] })],
);

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().$type<typeof MendSettings.Encoded>().notNull(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const inferenceCalls = pgTable("inference_calls", {
  id: text().$type<InferenceCallId>().primaryKey(),
  context: text().$type<InferenceContext>().notNull(),
  tool: text().$type<InferenceToolName>(),
  input: jsonb().$type<unknown>().notNull(),
  output: jsonb().$type<unknown>().notNull(),
  occurredAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const pushDevices = pgTable("push_devices", {
  token: text().primaryKey(),
  platform: text().notNull(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

/**
 * A paired device's long-lived bearer token. Only the sha256 hex of the token is
 * kept; the token itself is shown to the claimer once and never again. Revoking
 * stamps `revoked_at` — the row stays as the record that the device existed.
 * `user` is better-auth's table, so the reference lives in the migration only.
 */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    name: text().notNull(),
    platform: text().notNull(),
    tokenHash: text().notNull().unique(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ mode: "date", withTimezone: true }),
    revokedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [index("device_tokens_user_created_idx").on(table.userId, table.createdAt)],
);

/**
 * Per-session capability for the NETWORK session channel (Kubernetes): the sha256 of the
 * bearer token a workspace presents instead of opening `/run/mend/mend.sock`. No FK: hot-pool
 * ids are minted before their session row exists and become the session id at claim.
 */
export const sessionChannelTokens = pgTable("session_channel_tokens", {
  sessionId: text().primaryKey(),
  tokenHash: text().notNull(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp({ mode: "date", withTimezone: true }),
});

/**
 * One short-lived pairing code, single use: claiming stamps `claimed_at` and
 * mints a device token for the code's owner.
 */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    code: text().notNull().unique(),
    expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
    claimedAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("pairing_codes_user_created_idx").on(table.userId, table.createdAt)],
);

export const contextSnapshots = pgTable("context_snapshots", {
  id: text().$type<ContextSnapshotId>().primaryKey(),
  packName: text(),
  items: jsonb()
    .$type<ReadonlyArray<ContextItem>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text().$type<SessionId>().primaryKey(),
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    harness: text().notNull(),
    providerSessionId: text(),
    label: text(),
    worktree: text().notNull(),
    branch: text().notNull(),
    baseSha: text().$type<Sha>().notNull(),
    contextSnapshotId: text()
      .$type<ContextSnapshotId>()
      .references(() => contextSnapshots.id, { onDelete: "set null" }),
    referenceMounts: jsonb()
      .$type<ReadonlyArray<SessionReferenceMount>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    extraMounts: jsonb()
      .$type<ReadonlyArray<SessionExtraMount>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sealantRunId: text().$type<SealantRunId>(),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>(),
    sealantSessionId: text(),
    workspaceExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    workspaceTtlRenewedAt: timestamp({ mode: "date", withTimezone: true }),
    workspaceTtlRenewalFailedAt: timestamp({ mode: "date", withTimezone: true }),
    workspaceTtlRenewalError: text(),
    // The image this session actually launched with — stamped at launch, never rewritten by a
    // later project-setting change. NULL for sessions from before the column (or not launched).
    workspaceImage: jsonb().$type<typeof WorkspaceImage.Encoded>(),
    // The dotfiles this session actually launched with — stamped at launch, same contract as
    // workspaceImage above.
    dotfiles: jsonb().$type<typeof SessionDotfiles.Encoded>(),
    // Who provisioned the session — whose dotfiles apply. NULL for pre-column rows.
    ownerUserId: text(),
    status: text().$type<SessionStatus>().notNull().default("starting"),
    summary: text(),
    lastSeenSequence: bigint({ mode: "bigint" }).notNull().default(0n),
    recordHistoryComplete: boolean().notNull().default(false),
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    settledAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_sessions_project_idx").on(table.projectId, table.createdAt),
    index("agent_sessions_status_idx").on(table.status),
  ],
);

export const sessionRuns = pgTable(
  "session_runs",
  {
    sealantRunId: text().$type<SealantRunId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    harness: text().notNull(),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>().notNull(),
    sealantSessionId: text(),
    status: text().$type<SessionStatus>().notNull(),
    summary: text(),
    lastSeenSequence: bigint({ mode: "bigint" }).notNull().default(0n),
    // Safe project-environment launch manifest: aggregate revision + name-sorted variable NAMES
    // (never values, never hashes). Both NULL = explicit legacy/unknown, never inferred.
    environmentRevision: integer(),
    environmentVariableNames: jsonb().$type<ReadonlyArray<string>>(),
    secretRevision: integer(),
    secretNames: jsonb().$type<ReadonlyArray<string>>(),
    startedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("session_runs_session_id_ordinal_key").on(table.sessionId, table.ordinal),
    index("session_runs_session_idx").on(table.sessionId, table.ordinal),
    uniqueIndex("session_runs_one_active_idx")
      .on(table.sessionId)
      .where(sql`${table.settledAt} IS NULL`),
  ],
);

export const services = pgTable(
  "services",
  {
    id: text().$type<ServiceId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    name: text().notNull(),
    declarationSource: text().$type<ServiceDeclarationSource>().notNull(),
    workspacePort: integer().notNull(),
    transport: text().$type<ServiceTransport>().notNull().default("tcp"),
    browserScheme: text().$type<NonNullable<ServiceBrowserScheme>>(),
    bindAddresses: jsonb().$type<ReadonlyArray<string>>(),
    preferredHostPort: integer(),
    currentAttemptId: text().$type<SessionProcessId>(),
    currentForwardId: text().$type<ServiceForwardId>(),
    attemptHistoryComplete: boolean().notNull().default(true),
    forwardHistoryComplete: boolean().notNull().default(true),
    observationHistoryComplete: boolean().notNull().default(true),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("services_session_created_idx").on(table.sessionId, table.createdAt)],
);

export const sessionProcesses = pgTable(
  "session_processes",
  {
    id: text().$type<SessionProcessId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>().notNull(),
    sealantSessionId: text(),
    sealantRunId: text().$type<SealantRunId>(),
    launchCorrelationId: text(),
    serviceId: text()
      .$type<ServiceId>()
      .references(() => services.id, { onDelete: "set null" }),
    attemptOrdinal: integer(),
    kind: text().$type<SessionProcessKind>().notNull(),
    harness: text(),
    providerSessionId: text(),
    /** Next pipe-output sequence after the last newline-boundary projection. */
    protocolOutputSeq: bigint({ mode: "bigint" }).notNull().default(0n),
    label: text(),
    argv: jsonb()
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text().$type<SessionProcessStatus>().notNull().default("starting"),
    exitCode: integer(),
    workspacePort: integer(),
    protocol: text().$type<"tcp" | "udp">().notNull().default("tcp"),
    hostPort: integer(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp({ mode: "date", withTimezone: true }),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("session_processes_session_idx").on(table.sessionId, table.createdAt),
    index("session_processes_service_created_idx").on(table.serviceId, table.createdAt),
    uniqueIndex("session_processes_service_ordinal_idx")
      .on(table.serviceId, table.attemptOrdinal)
      .where(sql`${table.serviceId} IS NOT NULL AND ${table.attemptOrdinal} IS NOT NULL`),
    uniqueIndex("session_processes_one_live_service_attempt_idx")
      .on(table.serviceId)
      .where(
        sql`${table.serviceId} IS NOT NULL AND ${table.attemptOrdinal} IS NOT NULL AND ${table.exitedAt} IS NULL`,
      ),
    uniqueIndex("session_processes_launch_correlation_idx")
      .on(table.launchCorrelationId)
      .where(sql`${table.launchCorrelationId} IS NOT NULL`),
    // Live rows are workspace leases — the reap path queries by workspace.
    index("session_processes_live_idx")
      .on(table.sealantWorkspaceId)
      .where(sql`${table.exitedAt} IS NULL`),
  ],
);

export const agentTurns = pgTable(
  "agent_turns",
  {
    id: text().$type<AgentTurnId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    processId: text()
      .$type<SessionProcessId>()
      .notNull()
      .references(() => sessionProcesses.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    author: text(),
    input: text().notNull(),
    status: text().$type<AgentTurnStatus>().notNull().default("queued"),
    providerTurnId: text(),
    /** Idempotency correlation for a system-authored follow-up turn. */
    launchCorrelationId: text(),
    error: text(),
    usage: jsonb().$type<AgentTurnUsage>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    endedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("agent_turns_session_ordinal_key").on(table.sessionId, table.ordinal),
    uniqueIndex("agent_turns_session_provider_key")
      .on(table.sessionId, table.providerTurnId)
      .where(sql`${table.providerTurnId} IS NOT NULL`),
    uniqueIndex("agent_turns_session_correlation_key")
      .on(table.sessionId, table.launchCorrelationId)
      .where(sql`${table.launchCorrelationId} IS NOT NULL`),
    uniqueIndex("agent_turns_one_running_process_idx")
      .on(table.processId)
      .where(sql`${table.status} = 'running'`),
    index("agent_turns_session_created_idx").on(table.sessionId, table.ordinal),
    index("agent_turns_process_status_idx").on(table.processId, table.status, table.ordinal),
  ],
);

export const agentItems = pgTable(
  "agent_items",
  {
    id: text().$type<AgentItemId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    processId: text()
      .$type<SessionProcessId>()
      .notNull()
      .references(() => sessionProcesses.id, { onDelete: "cascade" }),
    turnId: text()
      .$type<AgentTurnId>()
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    providerItemId: text().notNull(),
    /** Pipe output position of the latest applied provider event for replay deduplication. */
    providerOutputProcessId: text().$type<SessionProcessId>().notNull(),
    providerOutputSeq: bigint({ mode: "bigint" }).notNull(),
    providerEventIndex: integer().notNull(),
    kind: text().$type<AgentItemKind>().notNull(),
    status: text().$type<AgentItemStatus>().notNull(),
    title: text(),
    text: text(),
    data: jsonb().$type<unknown>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_items_session_seq_key").on(table.sessionId, table.seq),
    // Per process, not per session: a fresh process (thread/resume falling back to thread/start)
    // may reuse provider item ids and must not overwrite the previous process's items.
    unique("agent_items_process_provider_key").on(table.processId, table.providerItemId),
    index("agent_items_session_seq_idx").on(table.sessionId, table.seq),
    index("agent_items_turn_seq_idx").on(table.turnId, table.seq),
  ],
);

export const agentRequests = pgTable(
  "agent_requests",
  {
    id: text().$type<AgentRequestId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    processId: text()
      .$type<SessionProcessId>()
      .notNull()
      .references(() => sessionProcesses.id, { onDelete: "cascade" }),
    turnId: text()
      .$type<AgentTurnId>()
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    kind: text().$type<AgentRequestKind>().notNull(),
    providerRequestId: text().notNull(),
    providerItemId: text(),
    title: text(),
    detail: jsonb().$type<unknown>(),
    questions: jsonb().$type<ReadonlyArray<AgentInputQuestion>>(),
    status: text().$type<AgentRequestStatus>().notNull().default("pending"),
    decision: text().$type<AgentApprovalDecision>(),
    decidedBy: text(),
    answers: jsonb().$type<AgentInputAnswers>(),
    /** Internal delivery state for crash-safe provider responses. */
    responseDelivery: text()
      .$type<"none" | "sending" | "delivered" | "failed">()
      .notNull()
      .default("none"),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("agent_requests_process_provider_key").on(table.processId, table.providerRequestId),
    index("agent_requests_session_status_idx").on(table.sessionId, table.status, table.createdAt),
    index("agent_requests_process_status_idx").on(table.processId, table.status),
  ],
);

export const serviceForwards = pgTable(
  "service_forwards",
  {
    id: text().$type<ServiceForwardId>().primaryKey(),
    serviceId: text()
      .$type<ServiceId>()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    sealantWorkspaceId: text().$type<SealantWorkspaceId>().notNull(),
    preferredHostPort: integer(),
    hostPort: integer(),
    boundAddresses: jsonb().$type<ReadonlyArray<string>>(),
    state: text().$type<ServiceForwardState>().notNull().default("binding"),
    error: text(),
    supersedesForwardId: text().$type<ServiceForwardId>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    boundAt: timestamp({ mode: "date", withTimezone: true }),
    closedAt: timestamp({ mode: "date", withTimezone: true }),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_forwards_service_created_idx").on(table.serviceId, table.createdAt),
    index("service_forwards_workspace_state_idx").on(table.sealantWorkspaceId, table.state),
  ],
);

export const serviceObservations = pgTable(
  "service_observations",
  {
    id: text().$type<ServiceObservationId>().primaryKey(),
    serviceId: text()
      .$type<ServiceId>()
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    forwardId: text()
      .$type<ServiceForwardId>()
      .notNull()
      .references(() => serviceForwards.id, { onDelete: "cascade" }),
    state: text().$type<ServiceTargetState>().notNull(),
    source: text().$type<ServiceObservationSource>().notNull(),
    error: text(),
    firstObservedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_observations_service_observed_idx").on(table.serviceId, table.lastObservedAt),
    index("service_observations_forward_observed_idx").on(table.forwardId, table.lastObservedAt),
  ],
);

/**
 * Every remote git operation a workspace routed through the transport shim
 * (docs/GIT-ACCESS.md): the host opened the authenticated connection, so the
 * host records it. `refUpdates` carries the push's ref commands when the
 * pack stream offered them cheaply; a null exit code is an op still running
 * (or one whose end was lost to a restart).
 */
export const sessionGitOps = pgTable(
  "session_git_ops",
  {
    id: text().$type<SessionGitOpId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    projectId: text().$type<ProjectId>().notNull(),
    host: text().notNull(),
    port: integer(),
    kind: text().$type<GitTransportKind>().notNull(),
    command: text().notNull(),
    authMode: text().$type<GitAuthMode>().notNull(),
    refUpdates: jsonb().$type<ReadonlyArray<string>>(),
    exitCode: integer(),
    startedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [index("session_git_ops_session_idx").on(table.sessionId, table.startedAt)],
);

export const projectServiceRecipes = pgTable(
  "project_service_recipes",
  {
    projectId: text()
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    command: text(),
    port: integer().notNull(),
    protocol: text().$type<"tcp" | "udp">().notNull().default("tcp"),
    browserScheme: text().$type<"http" | "https">(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.name] })],
);

export const sessionChanges = pgTable("session_changes", {
  id: text().$type<ChangeId>().primaryKey(),
  projectId: text()
    .$type<ProjectId>()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  sessionId: text()
    .$type<SessionId>()
    .notNull()
    .unique()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  branch: text().notNull(),
  baseSha: text().$type<Sha>().notNull(),
  headSha: text().$type<Sha>(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const followUps = pgTable(
  "follow_ups",
  {
    id: text().$type<FollowUpId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    changeId: text()
      .$type<ChangeId>()
      .notNull()
      .references(() => sessionChanges.id, { onDelete: "cascade" }),
    reviewSliceId: text().$type<ReviewSliceId>(),
    checkpointAId: text().$type<CheckpointId>(),
    checkpointBId: text().$type<CheckpointId>(),
    diffDigest: text().$type<DiffDigest>(),
    commentIds: jsonb()
      .$type<ReadonlyArray<ReviewCommentId>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    idempotencyKey: text(),
    instruction: text().notNull(),
    status: text().$type<FollowUpStatus>().notNull().default("pending"),
    deliveryProcessId: text()
      .$type<SessionProcessId>()
      .references(() => sessionProcesses.id, { onDelete: "set null" }),
    deliverySealantRunId: text().$type<SealantRunId>(),
    deliveryError: text(),
    deliveryStartedAt: timestamp({ mode: "date", withTimezone: true }),
    /** Internal claim token and renewable lease; clients observe status, never ownership. */
    deliveryAttemptId: text(),
    deliveryLeaseExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    index("follow_ups_session_idx").on(table.sessionId, table.createdAt),
    uniqueIndex("follow_ups_session_key_idx")
      .on(table.sessionId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const reviewComments = pgTable(
  "review_comments",
  {
    id: text().$type<ReviewCommentId>().primaryKey(),
    changeId: text()
      .$type<ChangeId>()
      .notNull()
      .references(() => sessionChanges.id, { onDelete: "cascade" }),
    file: text(),
    line: integer(),
    authorKind: text().$type<CommentAuthor>().notNull(),
    authorName: text().notNull(),
    body: text().notNull(),
    state: text().$type<CommentState>().notNull().default("open"),
    sentToSessionId: text()
      .$type<SessionId>()
      .references(() => agentSessions.id, { onDelete: "set null" }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    endLine: integer(),
    evidence: jsonb()
      .$type<ReadonlyArray<typeof RecordLink.Encoded>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    kind: text().$type<CommentKind>().notNull().default("note"),
    suggestion: text(),
    anchor: jsonb().$type<typeof ReviewCommentAnchor.Encoded>(),
  },
  (table) => [index("review_comments_change_idx").on(table.changeId, table.createdAt)],
);

export const changeTours = pgTable("change_tours", {
  id: text().primaryKey(),
  changeId: text()
    .$type<ChangeId>()
    .notNull()
    .unique()
    .references(() => sessionChanges.id, { onDelete: "cascade" }),
  sessionId: text()
    .$type<SessionId>()
    .notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  summary: text().notNull(),
  approach: text(),
  stops: jsonb().$type<ReadonlyArray<typeof TourStop.Encoded>>().notNull(),
  diffDigest: text().notNull(),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const changePasses = pgTable(
  "change_passes",
  {
    changeId: text()
      .$type<ChangeId>()
      .notNull()
      .references(() => sessionChanges.id, { onDelete: "cascade" }),
    kind: text().$type<PassKind>().notNull(),
    status: text().$type<PassStatus>().notNull(),
    detail: text(),
    findings: integer(),
    startedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.changeId, table.kind] })],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: text().$type<CheckpointId>().primaryKey(),
    sessionId: text()
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    ref: text().notNull(),
    sha: text().$type<Sha>().notNull(),
    sealantRunId: text()
      .$type<SealantRunId>()
      .references(() => sessionRuns.sealantRunId, { onDelete: "set null" }),
    seq: bigint({ mode: "bigint" }).notNull().default(0n),
    trigger: text().$type<CheckpointTrigger>().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("checkpoints_session_idx").on(table.sessionId, table.seq),
    index("checkpoints_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

export const reviewSlices = pgTable(
  "review_slices",
  {
    id: text().$type<ReviewSliceId>().primaryKey(),
    changeId: text()
      .$type<ChangeId>()
      .notNull()
      .references(() => sessionChanges.id, { onDelete: "cascade" }),
    checkpointAId: text()
      .$type<CheckpointId>()
      .notNull()
      .references(() => checkpoints.id, { onDelete: "cascade" }),
    checkpointBId: text()
      .$type<CheckpointId>()
      .notNull()
      .references(() => checkpoints.id, { onDelete: "cascade" }),
    diffDigest: text().$type<DiffDigest>().notNull(),
    idempotencyKey: text().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("review_slices_change_key_idx").on(table.changeId, table.idempotencyKey),
    index("review_slices_change_created_idx").on(table.changeId, table.createdAt),
  ],
);

export type AgentTurnRow = typeof agentTurns.$inferSelect;
export type AgentItemRow = typeof agentItems.$inferSelect;
export type AgentRequestRow = typeof agentRequests.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type ChangeRow = typeof changes.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type BriefRow = typeof briefs.$inferSelect;
export type BriefVersionRow = typeof briefVersions.$inferSelect;
export type ReviewQuestionRow = typeof reviewQuestions.$inferSelect;
export type BriefCommentRow = typeof briefComments.$inferSelect;
export type ProjectMountRow = typeof projectMounts.$inferSelect;
export type ReferenceRepoRow = typeof referenceRepos.$inferSelect;
export type ProjectReferenceRow = typeof projectReferences.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type InferenceCallRow = typeof inferenceCalls.$inferSelect;
export type PushDeviceRow = typeof pushDevices.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type PairingCodeRow = typeof pairingCodes.$inferSelect;
export type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type SessionRunRow = typeof sessionRuns.$inferSelect;
export type SessionChangeRow = typeof sessionChanges.$inferSelect;
export type FollowUpRow = typeof followUps.$inferSelect;
export type ReviewCommentRow = typeof reviewComments.$inferSelect;
export type ReviewSliceRow = typeof reviewSlices.$inferSelect;
export type ChangeTourRow = typeof changeTours.$inferSelect;
export type ChangePassRow = typeof changePasses.$inferSelect;
export type CheckpointRow = typeof checkpoints.$inferSelect;
