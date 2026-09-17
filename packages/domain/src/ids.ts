import { Schema } from "effect";

export const IssueId = Schema.String.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;

export const ChangeId = Schema.String.pipe(Schema.brand("ChangeId"));
export type ChangeId = typeof ChangeId.Type;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const BriefId = Schema.String.pipe(Schema.brand("BriefId"));
export type BriefId = typeof BriefId.Type;

export const ReviewQuestionId = Schema.String.pipe(Schema.brand("ReviewQuestionId"));
export type ReviewQuestionId = typeof ReviewQuestionId.Type;

export const InferenceCallId = Schema.String.pipe(Schema.brand("InferenceCallId"));
export type InferenceCallId = typeof InferenceCallId.Type;

/** The run id on the Sealant platform — evidence pointers address recordings through it. */
export const SealantRunId = Schema.String.pipe(Schema.brand("SealantRunId"));
export type SealantRunId = typeof SealantRunId.Type;

export const SealantWorkspaceId = Schema.String.pipe(Schema.brand("SealantWorkspaceId"));
export type SealantWorkspaceId = typeof SealantWorkspaceId.Type;

export const Sha = Schema.String.pipe(Schema.brand("Sha"));
export type Sha = typeof Sha.Type;

export const BriefCommentId = Schema.String.pipe(Schema.brand("BriefCommentId"));
export type BriefCommentId = typeof BriefCommentId.Type;

// ── Workbench ids (MEND-AGENT-WORKBENCH-PLAN.md §5) ──────────────────────────

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const WorktreeId = Schema.String.pipe(Schema.brand("WorktreeId"));
export type WorktreeId = typeof WorktreeId.Type;

export const CheckpointId = Schema.String.pipe(Schema.brand("CheckpointId"));
export type CheckpointId = typeof CheckpointId.Type;

export const ReviewCommentId = Schema.String.pipe(Schema.brand("ReviewCommentId"));
export type ReviewCommentId = typeof ReviewCommentId.Type;

export const ReviewSliceId = Schema.String.pipe(Schema.brand("ReviewSliceId"));
export type ReviewSliceId = typeof ReviewSliceId.Type;

export const ContextSnapshotId = Schema.String.pipe(Schema.brand("ContextSnapshotId"));
export type ContextSnapshotId = typeof ContextSnapshotId.Type;

export const FollowUpId = Schema.String.pipe(Schema.brand("FollowUpId"));
export type FollowUpId = typeof FollowUpId.Type;

export const ReferenceId = Schema.String.pipe(Schema.brand("ReferenceId"));
export type ReferenceId = typeof ReferenceId.Type;

export const ProjectMountId = Schema.String.pipe(Schema.brand("ProjectMountId"));
export type ProjectMountId = typeof ProjectMountId.Type;

export const ProjectLinkId = Schema.String.pipe(Schema.brand("ProjectLinkId"));
export type ProjectLinkId = typeof ProjectLinkId.Type;

export const SkillId = Schema.String.pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

export const SessionProcessId = Schema.String.pipe(Schema.brand("SessionProcessId"));
export type SessionProcessId = typeof SessionProcessId.Type;

/** One turn in a protocol-mode conversation: a user input and the agent's response to it. */
export const AgentTurnId = Schema.String.pipe(Schema.brand("AgentTurnId"));
export type AgentTurnId = typeof AgentTurnId.Type;

/** One item within a turn — assistant text, a tool call, a file change, a plan. */
export const AgentItemId = Schema.String.pipe(Schema.brand("AgentItemId"));
export type AgentItemId = typeof AgentItemId.Type;

/** One pending agent→human request — an approval or a user-input question — awaiting a decision. */
export const AgentRequestId = Schema.String.pipe(Schema.brand("AgentRequestId"));
export type AgentRequestId = typeof AgentRequestId.Type;

export const ServiceId = Schema.String.pipe(Schema.brand("ServiceId"));
export type ServiceId = typeof ServiceId.Type;

export const ServiceForwardId = Schema.String.pipe(Schema.brand("ServiceForwardId"));
export type ServiceForwardId = typeof ServiceForwardId.Type;

export const ServiceObservationId = Schema.String.pipe(Schema.brand("ServiceObservationId"));
export type ServiceObservationId = typeof ServiceObservationId.Type;

export const SessionGitOpId = Schema.String.pipe(Schema.brand("SessionGitOpId"));
export type SessionGitOpId = typeof SessionGitOpId.Type;

export const ProjectEnvironmentVariableId = Schema.String.pipe(
  Schema.brand("ProjectEnvironmentVariableId"),
);
export type ProjectEnvironmentVariableId = typeof ProjectEnvironmentVariableId.Type;

export const ProjectSecretId = Schema.String.pipe(Schema.brand("ProjectSecretId"));
export type ProjectSecretId = typeof ProjectSecretId.Type;

export const ProjectClusterBindingId = Schema.String.pipe(Schema.brand("ProjectClusterBindingId"));
export type ProjectClusterBindingId = typeof ProjectClusterBindingId.Type;

// ── Organizations (docs/adr/0003-organizations-and-tenancy.md) ───────────────

export const OrganizationId = Schema.String.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;

export const InvitationId = Schema.String.pipe(Schema.brand("InvitationId"));
export type InvitationId = typeof InvitationId.Type;

export const FolderId = Schema.String.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

export const AuditEventId = Schema.String.pipe(Schema.brand("AuditEventId"));
export type AuditEventId = typeof AuditEventId.Type;

export const SessionControlEventId = Schema.String.pipe(Schema.brand("SessionControlEventId"));
export type SessionControlEventId = typeof SessionControlEventId.Type;
