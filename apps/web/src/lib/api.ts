import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { orLogin, trpcClient } from "./trpc.ts";

/**
 * The UI's imperative surface: MUTATIONS (menus, drags, composers — places
 * that act, not render) plus the shared view types. Reads live in TanStack
 * Query through the tRPC options proxy (`useTRPC()` in components,
 * `context.trpc` in loaders) — nothing here duplicates a query.
 *
 * Every type is the contract's Type side, verbatim: superjson carries real
 * Dates, bigint sequence counters and branded ids from the server's derived
 * client to the browser. A wire change breaks compilation here, not runtime
 * behavior in a view.
 */

type Outputs = inferRouterOutputs<AppRouter>;

// ─── View types (the contract's Type side, named for the UI) ────────────────

export type IssueDto = Outputs["queue"]["listIssues"][number];
export type IssueStage = IssueDto["stage"];
export type IssueDetailDto = Outputs["queue"]["issueDetail"];
export type RunDto = IssueDetailDto["runs"][number];
export type RunStatus = RunDto["status"];
export type FailureBriefDto = NonNullable<RunDto["failureBrief"]>;
export type EvidencePointerDto = FailureBriefDto["evidence"][number];
export type RunDetailDto = Outputs["queue"]["runDetail"];
export type RunCommandDto = RunDetailDto["commands"][number];
export type LossReportDto = NonNullable<RunDetailDto["loss"]>;
export type TracePageDto = Outputs["queue"]["runTrace"];
export type TraceEntryDto = TracePageDto["entries"][number];
export type RunSourceDto = Outputs["queue"]["runSources"][number];

export type BriefDetailDto = NonNullable<Outputs["queue"]["briefByIssue"]>;
export type BriefDto = BriefDetailDto["brief"];
export type ChangeDto = BriefDetailDto["change"];
export type BriefDocumentDto = BriefDto["document"];
export type BriefQuestionDto = BriefDocumentDto["questions"][number];
export type BriefCalloutDto = BriefDocumentDto["attention"][number];
export type BriefEvidenceSourceDto = BriefDocumentDto["evidenceUsed"][number];
export type DispositionDto = BriefQuestionDto["disposition"];
export type BriefCommentDto = Outputs["queue"]["listBriefComments"][number];
export type RoutedActionDto = NonNullable<BriefCommentDto["routedAction"]>;
export type BriefVersionDto = Outputs["queue"]["briefVersions"][number];

export type SealantConnectionDto = Outputs["platform"]["sealantConnection"];
export type SealantIdentityDto = Outputs["platform"]["sealantIdentity"];
export type ConnectedAccountDto = SealantIdentityDto["accounts"][number];
export type ConnectedAccountProviderDto = ConnectedAccountDto["provider"];
export type MachineDto = Outputs["platform"]["machine"];
export type InstanceDto = Outputs["platform"]["instance"];

export type ProjectDto = Outputs["projects"]["list"][number];
export type WorkspaceImageDto = NonNullable<ProjectDto["workspaceImage"]>;
export type AutomationChoiceDto = ProjectDto["autoTour"];
export type GitAuthModeDto = ProjectDto["gitAuthMode"];
export type ProjectDetailDto = Outputs["projects"]["detail"];
export type SessionDto = Outputs["sessions"]["listActive"][number];
export type WorktreeDto = Outputs["projects"]["detail"]["worktrees"][number];
export type WorktreeAnnotationDto = Outputs["projects"]["detail"]["worktreeAnnotations"][number];
export type SessionStatusDto = SessionDto["status"];
export type SessionAnnotationDto = ProjectDetailDto["annotations"][number];
export type ChangeStatsDto = Outputs["changes"]["stats"];
export type RemovalReportDto = Outputs["projects"]["remove"];
export type SessionDetailDto = Outputs["sessions"]["detail"];
export type CheckpointDto = SessionDetailDto["checkpoints"][number];
export type SessionChangeDto = NonNullable<SessionDetailDto["change"]>;
export type FollowUpDto = NonNullable<Outputs["sessions"]["pendingFollowUp"]>;

export type ChangeDiffDto = Outputs["changes"]["diff"];
export type ChangedFileDto = ChangeDiffDto["files"][number];
export type OpenReviewResultDto = Outputs["changes"]["openReview"];
export type ReviewSliceDto = OpenReviewResultDto["slice"];
export type ReviewDiffDto = Outputs["changes"]["reviewDiff"];
export type ReviewDiffFileDto = ReviewDiffDto["files"][number];
export type ReviewDiffHunkDto = ReviewDiffFileDto["hunks"][number];
export type ReviewCommentDto = Outputs["changes"]["comments"][number];
export type ReviewCommentAnchorDto = NonNullable<ReviewCommentDto["anchor"]>;
export type RecordLinkDto = ReviewCommentDto["evidence"][number];
export type ChangeTourDto = NonNullable<Outputs["changes"]["tour"]>;
export type TourStopDto = ChangeTourDto["stops"][number];
export type ChangePassDto = Outputs["changes"]["passes"][number];

export type SettingsDto = Outputs["settings"]["get"];
export type WorkspaceEnvironmentSaveResultDto = Outputs["settings"]["saveWorkspaceEnvironment"];
export type WorkspacePackageResolutionDto =
  WorkspaceEnvironmentSaveResultDto["resolutions"][number];
export type ProjectWorkspaceImageSaveResultDto = Outputs["projects"]["setWorkspaceImage"];
export type DotfilesDto = Outputs["settings"]["dotfiles"];
export type DotfilesRepositoryDto = NonNullable<DotfilesDto["repository"]>;
export type DotfilesSnapshotDto = NonNullable<DotfilesDto["snapshot"]>;

export type SkillDto = Outputs["skills"]["list"][number];
export type SkillDetailDto = Outputs["skills"]["detail"];
export type SkillFileDto = SkillDetailDto["files"][number];
export type SkillScopeDto = SkillDto["scope"];
export type ProjectHotSessionsStatusDto = Outputs["projects"]["hotSessionsStatus"];
export type HostEnvironmentSuggestionsDto = Outputs["settings"]["environmentSuggestions"];

export type GitKeyDto = Outputs["git"]["key"];
export type GitAccessDto = Outputs["git"]["access"];
export type GitAccessModeDto = GitAccessDto["mode"];
export type GitBridgeStatusDto = Outputs["git"]["bridgeStatus"];
export type ReferenceDto = Outputs["git"]["references"][number];
export type ProjectMountDto = Outputs["projects"]["mounts"][number];

export type SessionProcessDto = Outputs["sessions"]["processes"][number];
export type ServiceRecipeDto = Outputs["projects"]["recipes"][number];
export type ServiceViewDto = Outputs["services"]["list"][number];
export type StableServiceDto = ServiceViewDto["service"];
export type ServiceForwardDto = NonNullable<ServiceViewDto["currentForward"]>;
export type ServiceObservationDto = NonNullable<ServiceViewDto["latestObservation"]>;
export type ServiceEndpointDto = ServiceViewDto["endpoints"][number];
export type SessionTranscriptDto = Outputs["sessions"]["transcript"];
export type TranscriptEventDto = SessionTranscriptDto["events"][number];

export type DeviceDto = Outputs["devices"]["list"][number];
export type PairingDto = Outputs["devices"]["createPairing"];

/** The SSE payloads from /api/events — pointers, never data (outside the typed contract). */
export type MendEventDto =
  | { readonly type: "issue"; readonly issueId: string }
  | { readonly type: "run"; readonly runId: string; readonly issueId: string }
  | {
      readonly type: "run-progress";
      readonly runId: string;
      readonly issueId: string;
      readonly sequence: string;
      readonly line: string;
    }
  | { readonly type: "brief"; readonly changeId: string; readonly issueId: string }
  | { readonly type: "brief-comment"; readonly briefId: string; readonly issueId: string };

/** A workbench SSE event — pointers only; clients re-read through the API. */
export interface WorkbenchEventDto {
  readonly type: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly changeId?: string;
  readonly sequence?: string;
  readonly line?: string;
  /** `user` events: whose facts moved, and which facet (accounts · devices · git-access). */
  readonly userId?: string;
  readonly facet?: string;
}

// ─── Queue-era actions ──────────────────────────────────────────────────────

export const postBriefComment = (issueId: string, thread: string, body: string) =>
  orLogin(trpcClient.queue.postBriefComment.mutate({ issueId, comment: { thread, body } }));
export const createIssue = (input: {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}) =>
  orLogin(trpcClient.queue.createIssue.mutate({ source: "manual", externalRef: null, ...input }));
export const moveIssue = (id: string, stage: "triage" | "queued", position: number | null) =>
  orLogin(trpcClient.queue.moveIssue.mutate({ id, move: { stage, position } }));

// ─── Platform · identity ────────────────────────────────────────────────────

export const connectAccount = (input: {
  readonly provider: ConnectedAccountProviderDto;
  readonly secret: string;
}) => orLogin(trpcClient.platform.connectAccount.mutate(input));
export const disconnectAccount = (id: string) =>
  orLogin(trpcClient.platform.disconnectAccount.mutate({ id }));

// ─── Projects ───────────────────────────────────────────────────────────────

export const adoptProject = (name: string, source: string, gitAuthMode?: GitAuthModeDto) =>
  orLogin(
    trpcClient.projects.adopt.mutate({
      name,
      source,
      ...(gitAuthMode === undefined ? {} : { gitAuthMode }),
    }),
  );
export const removeProject = (id: string) => orLogin(trpcClient.projects.remove.mutate({ id }));
export const setProjectAutomation = (
  projectId: string,
  choices: {
    readonly autoTour: AutomationChoiceDto;
    readonly autoSuggest: AutomationChoiceDto;
    readonly autoName: AutomationChoiceDto;
    readonly backgroundSessions: AutomationChoiceDto;
  },
) => orLogin(trpcClient.projects.setAutomation.mutate({ id: projectId, choices }));
export const setProjectWorkspaceImage = (
  projectId: string,
  workspaceImage: WorkspaceImageDto | null,
) =>
  orLogin(
    trpcClient.projects.setWorkspaceImage.mutate({ id: projectId, request: { workspaceImage } }),
  );
export const setProjectApplyDotfiles = (projectId: string, applyDotfiles: boolean) =>
  orLogin(
    trpcClient.projects.setApplyDotfiles.mutate({ id: projectId, request: { applyDotfiles } }),
  );
/** Persist whether new sessions inherit the user's global skill library. */
export const setProjectInheritUserSkills = (projectId: string, inheritUserSkills: boolean) =>
  orLogin(
    trpcClient.projects.setInheritUserSkills.mutate({
      id: projectId,
      request: { inheritUserSkills },
    }),
  );
export const setProjectGitAuth = (projectId: string, gitAuthMode: GitAuthModeDto) =>
  orLogin(trpcClient.projects.setGitAuth.mutate({ id: projectId, request: { gitAuthMode } }));
export const setProjectHotSessions = (projectId: string, hotSessions: number) =>
  orLogin(trpcClient.projects.setHotSessions.mutate({ id: projectId, request: { hotSessions } }));
export const listProjectBranches = (projectId: string) =>
  orLogin(trpcClient.projects.branches.query({ id: projectId }));
export const refreshProjectBranches = (projectId: string) =>
  orLogin(trpcClient.projects.refresh.mutate({ id: projectId }));
export type ProjectBranchDto = Outputs["projects"]["branches"][number];
export const selectProjectReferences = (projectId: string, referenceIds: ReadonlyArray<string>) =>
  orLogin(
    trpcClient.projects.selectReferences.mutate({ id: projectId, selection: { referenceIds } }),
  );
export const addProjectMount = (
  projectId: string,
  input: { readonly name: string; readonly hostPath: string; readonly readOnly: boolean },
) => orLogin(trpcClient.projects.addMount.mutate({ id: projectId, mount: input }));
export const removeProjectMount = async (projectId: string, mountId: string): Promise<void> => {
  await orLogin(trpcClient.projects.removeMount.mutate({ id: projectId, mountId }));
};
export const addProjectLink = (
  projectId: string,
  input: {
    readonly linkedProjectId: string;
    readonly name: string;
    readonly worktreeName: string | null;
  },
) => orLogin(trpcClient.projects.addLink.mutate({ id: projectId, link: input }));
export const removeProjectLink = async (projectId: string, linkId: string): Promise<void> => {
  await orLogin(trpcClient.projects.removeLink.mutate({ id: projectId, linkId }));
};
export const addProjectRecipe = (
  projectId: string,
  input: {
    readonly name: string;
    readonly command: string | null;
    readonly port: number;
    readonly protocol: "tcp" | "udp";
    readonly browserScheme: "http" | "https" | null;
  },
) => orLogin(trpcClient.projects.addRecipe.mutate({ id: projectId, recipe: input }));
export const removeProjectRecipe = async (projectId: string, name: string): Promise<void> => {
  await orLogin(trpcClient.projects.removeRecipe.mutate({ id: projectId, name }));
};

// ─── References · git keys ──────────────────────────────────────────────────

export const addReference = (name: string, source: string, ref: string | null) =>
  orLogin(trpcClient.git.addReference.mutate({ name, source, ref }));
export const removeReference = async (id: string): Promise<void> => {
  await orLogin(trpcClient.git.removeReference.mutate({ id }));
};
export const refreshReference = (id: string) =>
  orLogin(trpcClient.git.refreshReference.mutate({ id }));
export const initGitKey = () => orLogin(trpcClient.git.initKey.mutate());
export const setGitAccess = (mode: GitAccessModeDto) =>
  orLogin(trpcClient.git.setAccess.mutate({ mode }));

// ─── Sessions · services ────────────────────────────────────────────────────

export const createSession = (
  projectId: string,
  harness: string,
  base: string | null = null,
  name: string | null = null,
) =>
  orLogin(
    trpcClient.sessions.create.mutate({ projectId, session: { harness, label: null, name, base } }),
  );
export const launchSession = (id: string, argv: ReadonlyArray<string>) =>
  orLogin(trpcClient.sessions.launch.mutate({ id, request: { argv } }));

/** A composed start — the server turns this into the harness's own argv. */
export type LaunchRequestDto = Parameters<typeof trpcClient.sessions.launch.mutate>[0]["request"];
export type LaunchStartDto = Omit<LaunchRequestDto, "mode" | "argv">;
export const launchSessionStart = (id: string, start: LaunchStartDto) =>
  orLogin(trpcClient.sessions.launch.mutate({ id, request: { ...start } }));
export const stopSession = (id: string) => orLogin(trpcClient.sessions.stop.mutate({ id }));
/** Store a pasted image beside the session; the reply is the workspace path to paste. */
export const pasteSessionImage = (id: string, contentsBase64: string) =>
  orLogin(trpcClient.sessions.pasteImage.mutate({ id, upload: { contentsBase64 } }));
export const resumeSession = (id: string, harness: string | null) =>
  orLogin(trpcClient.sessions.resume.mutate({ id, request: { harness } }));
export const removeSession = (id: string) => orLogin(trpcClient.sessions.remove.mutate({ id }));

/**
 * Provision the worktree alone — the deliberate "New worktree" flow. No
 * session, no harness, nothing running: conversations join it afterwards.
 * A `name` already used in this project is refused (WorktreeNameTaken);
 * null derives an anonymous identity. Null `base` uses the project's
 * default branch.
 */
export const createWorktree = (
  projectId: string,
  worktree: { readonly name: string | null; readonly base: string | null },
): Promise<WorktreeDto> => orLogin(trpcClient.worktrees.create.mutate({ projectId, worktree }));

/** The container's own verbs — the one explicit destructive act, and a new conversation inside. */
export const removeWorktree = (id: string, force?: boolean) =>
  orLogin(trpcClient.worktrees.remove.mutate(force === true ? { id, force: true } : { id }));

export const createSessionInWorktree = (id: string, harness: string) =>
  orLogin(trpcClient.worktrees.createSession.mutate({ id, session: { harness, label: null } }));
export const setSessionLabel = (id: string, label: string | null) =>
  orLogin(trpcClient.sessions.setLabel.mutate({ id, label }));
export const checkpointSession = (id: string, trigger: "review-open" | "user-mark") =>
  orLogin(trpcClient.sessions.checkpoint.mutate({ id, request: { trigger } }));

export interface DeliverFollowUpInput {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string;
}
export const deliverFollowUp = (sessionId: string, input: DeliverFollowUpInput) =>
  orLogin(trpcClient.sessions.deliverFollowUp.mutate({ id: sessionId, request: input }));

export const runServiceRecipe = (sessionId: string, name: string) =>
  orLogin(trpcClient.sessions.runServiceRecipe.mutate({ id: sessionId, name }));
export const runService = (
  sessionId: string,
  input: {
    argv: ReadonlyArray<string>;
    port: number;
    name: string | null;
    protocol?: "tcp" | "udp";
    browserScheme?: "http" | "https" | null;
  },
) => orLogin(trpcClient.sessions.runService.mutate({ id: sessionId, ...input }));
export const addService = (
  sessionId: string,
  input: {
    port: number;
    name: string | null;
    protocol?: "tcp" | "udp";
    browserScheme?: "http" | "https" | null;
  },
) => orLogin(trpcClient.sessions.addService.mutate({ id: sessionId, ...input }));
export const restartService = (id: string) => orLogin(trpcClient.services.restart.mutate({ id }));
export const stopService = (id: string) => orLogin(trpcClient.services.stop.mutate({ id }));

// ─── Changes · review ───────────────────────────────────────────────────────

export const openReview = (id: string, idempotencyKey: string) =>
  orLogin(trpcClient.changes.openReview.mutate({ id, request: { idempotencyKey } }));

export interface SliceCommentTargetDto {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "old" | "new" | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
}
export const postSliceReviewComment = (
  changeId: string,
  sliceId: string,
  target: SliceCommentTargetDto,
  body: string,
) =>
  orLogin(
    trpcClient.changes.postSliceComment.mutate({
      id: changeId,
      sliceId,
      comment: { target, body },
    }),
  );
export const setCommentState = (
  changeId: string,
  commentId: string,
  state: "open" | "addressed" | "dismissed",
) =>
  orLogin(
    trpcClient.changes.setCommentState.mutate({ id: changeId, commentId, request: { state } }),
  );
export const readChange = (changeId: string) =>
  orLogin(trpcClient.changes.queueRead.mutate({ id: changeId }));
export const composeTour = (changeId: string) =>
  orLogin(trpcClient.changes.queueTour.mutate({ id: changeId }));
export const suggestChange = (changeId: string) =>
  orLogin(trpcClient.changes.queueSuggest.mutate({ id: changeId }));

// ─── Settings · dotfiles · devices ──────────────────────────────────────────

export const putSettings = (settings: SettingsDto) =>
  orLogin(trpcClient.settings.put.mutate(settings));
export const saveWorkspaceEnvironment = (workspaceImage: WorkspaceImageDto) =>
  orLogin(trpcClient.settings.saveWorkspaceEnvironment.mutate(workspaceImage));
export const putDotfilesRepository = (repository: DotfilesRepositoryDto | null) =>
  orLogin(trpcClient.settings.putDotfilesRepository.mutate({ repository }));
export const postDotfilesSnapshot = (payload: {
  readonly files: ReadonlyArray<{ readonly path: string; readonly contentsBase64: string }>;
  readonly source: string;
  readonly merge: boolean;
}) => orLogin(trpcClient.settings.postDotfilesSnapshot.mutate(payload));
export const deleteDotfilesSnapshot = () =>
  orLogin(trpcClient.settings.deleteDotfilesSnapshot.mutate());

// ─── Skills ─────────────────────────────────────────────────────────────────

export const createSkill = (request: {
  readonly scope: SkillScopeDto;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
}) => orLogin(trpcClient.skills.create.mutate(request));
export const updateSkill = (
  skillId: string,
  request: {
    readonly name: string;
    readonly description: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
    readonly expectedRevision: number;
  },
) => orLogin(trpcClient.skills.update.mutate({ skillId, request }));
export const removeSkill = (skillId: string) =>
  orLogin(trpcClient.skills.remove.mutate({ skillId }));

export const createPairing = () => orLogin(trpcClient.devices.createPairing.mutate());
export const revokeDevice = (id: string) => orLogin(trpcClient.devices.revoke.mutate({ id }));
export const approveCliAuth = (code: string) =>
  orLogin(trpcClient.devices.approveCliAuth.mutate({ code }));
export const denyCliAuth = (code: string) =>
  orLogin(trpcClient.devices.denyCliAuth.mutate({ code }));

// ─── Pure helpers (unchanged behavior) ──────────────────────────────────────

/**
 * Whether the session's AGENT is live. Session status is a fold over every process — a session
 * reads `idle` while a shell holds the workspace after its agent ended — so the agent's own row
 * answers when one exists; `starting` is a launch with no row yet.
 */
const LIVE_SESSION_STATUSES: ReadonlySet<SessionStatusDto> = new Set<SessionStatusDto>([
  "starting",
  "running",
  "waiting",
  "idle",
]);

export const agentIsLive = (session: SessionDto, currentAgent: SessionProcessDto | null): boolean =>
  currentAgent === null
    ? LIVE_SESSION_STATUSES.has(session.status)
    : session.status === "starting" ||
      (currentAgent.exitedAt === null &&
        (currentAgent.status === "starting" || currentAgent.status === "running"));

const preferredEndpoint = (view: ServiceViewDto): ServiceEndpointDto | null =>
  view.endpoints.find((endpoint) => endpoint.scope === "private") ?? view.endpoints[0] ?? null;

/** Browser behavior is declared by the Service and resolved by the server. */
export const serviceUrl = (view: ServiceViewDto) =>
  view.endpoints.find((endpoint) => endpoint.browserUrl !== null)?.browserUrl ?? null;

/** What a client would connect to, exactly as the server bound it. */
export const serviceEndpoint = (view: ServiceViewDto) => preferredEndpoint(view)?.authority ?? null;

/**
 * How each harness takes an instruction as its opening prompt — the same
 * table the CLI's `mend continue` uses. Null: no known resume command.
 */
export const continueArgv = (harness: string, instruction: string): ReadonlyArray<string> | null =>
  harness === "codex"
    ? ["codex", instruction]
    : harness === "claude"
      ? ["claude", instruction]
      : harness === "opencode"
        ? ["opencode", "run", instruction]
        : null;
