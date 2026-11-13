import {
  agentProcessOutcome,
  CONVERSATION_HARNESSES,
  captureStatusLine,
  servicesHoldLine,
} from "@mend/domain/workbench";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { browserTrpcClient, orLogin, type TrpcClient } from "./trpc.ts";

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
export type WorkspaceSshDto = Outputs["platform"]["workspaceSsh"];
export type WorkspaceSshKeyDto = WorkspaceSshDto["keys"][number];
export type ConnectedAccountProviderDto = ConnectedAccountDto["provider"];
export type AgentLoginsDto = Outputs["platform"]["agentLogins"];
export type MessageSettingsDto = Outputs["platform"]["messageSettings"];
export type SettleSettingsDto = Outputs["platform"]["settleSettings"];
export type PersonAutomationDto = Outputs["platform"]["automation"];
export type PersonSettingsDto = PersonAutomationDto["own"];
export type SessionDefaultsDto = Outputs["platform"]["sessionDefaults"];
export type MachineDto = Outputs["platform"]["machine"];
export type InstanceDto = Outputs["platform"]["instance"];

export type ProjectDto = Outputs["projects"]["list"][number];
export type ProjectInstallDetectionDto = Outputs["projects"]["installDetection"];
export type WorkspaceImageDto = NonNullable<ProjectDto["workspaceImage"]>;
export type AutomationChoiceDto = ProjectDto["autoTour"];
export type GitAuthModeDto = ProjectDto["gitAuthMode"];
export type ProjectDetailDto = Outputs["projects"]["detail"];
export type SessionDto = Outputs["sessions"]["listActive"][number];
/** Where one person keeps a session in their inbox: snoozed until a time, or settled. */
export type SessionInboxMarkDto = Outputs["sessions"]["inboxMarks"][number];
/** One row of the Sessions inbox: the session, its project's name, its title, why it waits. */
export type SessionInboxRowDto = Outputs["sessions"]["inbox"][number];
export type SessionAskDto = NonNullable<SessionInboxRowDto["ask"]>;
export type WorktreeDto = Outputs["projects"]["detail"]["worktrees"][number];
export type WorktreeAnnotationDto = Outputs["projects"]["detail"]["worktreeAnnotations"][number];
export type SessionStatusDto = SessionDto["status"];
export type SessionAnnotationDto = ProjectDetailDto["annotations"][number];
export type ChangeStatsDto = Outputs["changes"]["stats"];
export type RemovalReportDto = Outputs["projects"]["remove"];
export type SessionDetailDto = Outputs["sessions"]["detail"];
/** A session's screen (docs/adr/0020-guis-in-sessions.md): its life and who holds its input. */
export type ScreenReadDto = Outputs["screens"]["read"];
export type LiveScreenDto = Extract<ScreenReadDto, { readonly _tag: "Screen" }>;
export type ScreenControlDto = Outputs["screens"]["take"];
/** What Mend did with a sent message, with its own sentence for it (`explanation`). */
export type SessionMessageReceiptDto = Outputs["sessions"]["sendMessage"];
export type CheckpointDto = SessionDetailDto["checkpoints"][number];
/** A repository the session holds beside its worktree (docs/adr/0010). */
export type SessionRepositoryDto = SessionDetailDto["repositories"][number];
export type SessionChangeDto = NonNullable<SessionDetailDto["change"]>;
export type FollowUpDto = NonNullable<Outputs["sessions"]["pendingFollowUp"]>;
export type ConversationWaitDto = NonNullable<Outputs["sessions"]["conversationWait"]>;
export type ConversationWaitWorkDto = ConversationWaitDto["work"][number];
export type WorkspaceRetirementDto = NonNullable<Outputs["sessions"]["workspaceRetirement"]>;
export type PreReleaseMemoryDto = NonNullable<SessionDetailDto["preReleaseMemory"]>;

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
export type SecretFilesDto = Outputs["settings"]["secretFiles"];
export type SecretFileDto = SecretFilesDto["files"][number];
export type SecretFileSavedDto = Outputs["settings"]["putSecretFile"];
export type DopplerDto = Outputs["doppler"]["status"];

export type SkillDto = Outputs["skills"]["list"][number];
export type SkillDetailDto = Outputs["skills"]["detail"];
export type SkillFileDto = SkillDetailDto["files"][number];
export type SkillScopeDto = SkillDto["scope"];
export type ProjectHotSessionsStatusDto = Outputs["projects"]["hotSessionsStatus"];
export type HostEnvironmentSuggestionsDto = Outputs["settings"]["environmentSuggestions"];

export type GitKeyDto = Outputs["git"]["key"];
export type GitAccessDto = Outputs["git"]["access"];
export type GitAccessModeDto = GitAccessDto["mode"];
export type GitAuthorDto = Outputs["git"]["author"];
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
export type WorktreePreviewsDto = Outputs["worktrees"]["previews"];
export type WorktreePreviewDto = WorktreePreviewsDto["previews"][number];
export type SessionTranscriptDto = Outputs["sessions"]["transcript"];
export type TranscriptEventDto = SessionTranscriptDto["events"][number];

export type OrganizationViewDto = Outputs["organization"]["current"];
export type OrganizationRoleDto = OrganizationViewDto["role"];
export type OrganizationMemberDto = Outputs["organization"]["members"][number];
export type InvitationDto = Outputs["organization"]["invitations"][number];
export type InvitationCreatedDto = Outputs["organization"]["createInvitation"];
export type InvitationPreviewDto = Outputs["organization"]["invitationPreview"];
export type AccountOrganizationDto = Outputs["organizations"]["list"][number];
export type AuditEntryDto = Outputs["organization"]["audit"][number];
export type OrganizationSettingsViewDto = Outputs["organization"]["settings"];
export type OrganizationSettingsDto = OrganizationSettingsViewDto["organization"];
export type OrganizationRuntimeSwitchDto = Outputs["organization"]["runtimeSwitch"];
export type OrganizationWorkspaceEnvironmentSaveResultDto =
  Outputs["organization"]["setWorkspaceEnvironment"];
export type BoatKeyStatusDto = Outputs["boatKey"]["status"];
export type BoatKeyDetailsDto = NonNullable<BoatKeyStatusDto["details"]>;
export type BoatKeyCheckDto = Outputs["boatKey"]["check"];
export type BoatKeyReportDto = NonNullable<BoatKeyCheckDto["report"]>;
export type PersonBoatKeyStatusDto = Outputs["personBoatKey"]["status"];
export type SlackAppStatusDto = Outputs["slack"]["app"];
export type SlackAppDto = NonNullable<SlackAppStatusDto["app"]>;
export type SlackSettingsDto = SlackAppDto["settings"];
export type SlackLinkDto = Outputs["slack"]["links"][number];
export type SlackMeDto = Outputs["slack"]["me"];
export type SlackLinkPreviewDto = Outputs["slack"]["previewLink"];
export type SlackLinkConfirmedDto = Outputs["slack"]["confirmLink"];
export type FolderDto = Outputs["folders"]["list"][number];
export type FolderListingDto = Outputs["folders"]["files"];
export type ProjectFolderViewDto = Outputs["projects"]["folders"][number];

export type ChangeLandingsDto = Outputs["landings"]["forChange"];
export type ChangeLandingDto = ChangeLandingsDto["landings"][number];
export type LandingFactDto = ChangeLandingsDto["facts"][number];
export type LandingReportDto = Outputs["landings"]["land"];
export type PullRequestCheckDto = Outputs["landings"]["checkGitHub"];
export type PullRequestStepDto = LandingReportDto["pullRequest"];

export type DeviceDto = Outputs["devices"]["list"][number];
export type PairingDto = Outputs["devices"]["createPairing"];
export type MintedDeviceDto = Outputs["devices"]["create"];

export type AccessKeyDto = Outputs["accessKeys"]["list"][number];
export type CreatedAccessKeyDto = Outputs["accessKeys"]["create"];

export type McpServerDto = Outputs["mcpServers"]["list"]["servers"][number];

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
  readonly worktreeId?: string;
  readonly sequence?: string;
  readonly line?: string;
  /** `user` events: whose facts moved, and which facet (accounts · devices · git-access · access). */
  readonly userId?: string;
  readonly facet?: string;
  readonly organizationId?: string;
}

// ─── Queue-era actions ──────────────────────────────────────────────────────

export const postBriefComment = (issueId: string, thread: string, body: string) =>
  orLogin(
    browserTrpcClient().queue.postBriefComment.mutate({ issueId, comment: { thread, body } }),
  );
export const createIssue = (input: {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}) =>
  orLogin(
    browserTrpcClient().queue.createIssue.mutate({ source: "manual", externalRef: null, ...input }),
  );
export const moveIssue = (id: string, stage: "triage" | "queued", position: number | null) =>
  orLogin(browserTrpcClient().queue.moveIssue.mutate({ id, move: { stage, position } }));

// ─── Platform · identity ────────────────────────────────────────────────────

// ─── Projects ───────────────────────────────────────────────────────────────

export const adoptProject = (
  name: string,
  source: string,
  gitAuthMode?: GitAuthModeDto,
  visibility?: ProjectDto["visibility"],
  /** A key to read the clone's progress by (`projects.adoption`). */
  adoptionId?: string,
) =>
  orLogin(
    browserTrpcClient().projects.adopt.mutate({
      name,
      source,
      ...(gitAuthMode === undefined ? {} : { gitAuthMode }),
      ...(visibility === undefined ? {} : { visibility }),
      ...(adoptionId === undefined ? {} : { adoptionId }),
    }),
  );
export type AdoptionProgressDto = Outputs["projects"]["adoption"];
export const setProjectVisibility = (id: ProjectDto["id"], visibility: ProjectDto["visibility"]) =>
  orLogin(browserTrpcClient().projects.setVisibility.mutate({ id, visibility }));
export const setNewWorktreesUseProjectResources = (
  id: ProjectDto["id"],
  newWorktreesUseProjectResources: boolean,
) =>
  orLogin(
    browserTrpcClient().projects.setNewWorktreesUseProjectResources.mutate({
      id,
      newWorktreesUseProjectResources,
    }),
  );
export const setProjectFolders = (
  id: ProjectDto["id"],
  selections: ReadonlyArray<{
    readonly folderId: FolderDto["id"];
    readonly name: string;
    readonly readOnly: boolean;
  }>,
) => orLogin(browserTrpcClient().projects.setFolders.mutate({ id, selections }));
export const removeProject = (id: string) =>
  orLogin(browserTrpcClient().projects.remove.mutate({ id }));
export const setProjectAutomation = (
  projectId: string,
  choices: {
    readonly autoTour: AutomationChoiceDto;
    readonly autoSuggest: AutomationChoiceDto;
    readonly autoName: AutomationChoiceDto;
    readonly backgroundSessions: AutomationChoiceDto;
    /** "Land when a turn completes"; left out, the project keeps its stance. */
    readonly autoLand?: AutomationChoiceDto;
  },
) => orLogin(browserTrpcClient().projects.setAutomation.mutate({ id: projectId, choices }));
export const setProjectWorkspaceImage = (
  projectId: string,
  workspaceImage: WorkspaceImageDto | null,
) =>
  orLogin(
    browserTrpcClient().projects.setWorkspaceImage.mutate({
      id: projectId,
      request: { workspaceImage },
    }),
  );
export const setProjectApplyDotfiles = (projectId: string, applyDotfiles: boolean) =>
  orLogin(
    browserTrpcClient().projects.setApplyDotfiles.mutate({
      id: projectId,
      request: { applyDotfiles },
    }),
  );
/** Persist whether zsh launches write Mend's default shell profile where no file exists. */
export const setProjectDefaultShellProfile = (projectId: string, defaultShellProfile: boolean) =>
  orLogin(
    browserTrpcClient().projects.setDefaultShellProfile.mutate({
      id: projectId,
      request: { defaultShellProfile },
    }),
  );
/** Persist whether new sessions inherit the user's global skill library. */
export const setProjectInheritUserSkills = (projectId: string, inheritUserSkills: boolean) =>
  orLogin(
    browserTrpcClient().projects.setInheritUserSkills.mutate({
      id: projectId,
      request: { inheritUserSkills },
    }),
  );
export const setProjectGitAuth = (projectId: string, gitAuthMode: GitAuthModeDto) =>
  orLogin(
    browserTrpcClient().projects.setGitAuth.mutate({ id: projectId, request: { gitAuthMode } }),
  );
export const setProjectHotSessions = (projectId: string, hotSessions: number) =>
  orLogin(
    browserTrpcClient().projects.setHotSessions.mutate({ id: projectId, request: { hotSessions } }),
  );
export const setProjectInstallCommand = (projectId: string, installCommand: string | null) =>
  orLogin(
    browserTrpcClient().projects.setInstallCommand.mutate({
      id: projectId,
      request: { installCommand },
    }),
  );
/** "Automatic install": whether Mend runs an install command for this project at all. */
export const setProjectInstallEnabled = (projectId: string, installEnabled: boolean) =>
  orLogin(
    browserTrpcClient().projects.setInstallEnabled.mutate({
      id: projectId,
      request: { installEnabled },
    }),
  );
export const listProjectBranches = (projectId: string) =>
  orLogin(browserTrpcClient().projects.branches.query({ id: projectId }));
export const refreshProjectBranches = (projectId: string) =>
  orLogin(browserTrpcClient().projects.refresh.mutate({ id: projectId }));
export type ProjectBranchDto = Outputs["projects"]["branches"][number];
export const selectProjectReferences = (projectId: string, referenceIds: ReadonlyArray<string>) =>
  orLogin(
    browserTrpcClient().projects.selectReferences.mutate({
      id: projectId,
      selection: { referenceIds },
    }),
  );
export const addProjectMount = (
  projectId: string,
  input: { readonly name: string; readonly hostPath: string; readonly readOnly: boolean },
) => orLogin(browserTrpcClient().projects.addMount.mutate({ id: projectId, mount: input }));
export const removeProjectMount = async (projectId: string, mountId: string): Promise<void> => {
  await orLogin(browserTrpcClient().projects.removeMount.mutate({ id: projectId, mountId }));
};
export const addProjectLink = (
  projectId: string,
  input: {
    readonly linkedProjectId: string;
    readonly name: string;
    readonly worktreeName: string | null;
  },
) => orLogin(browserTrpcClient().projects.addLink.mutate({ id: projectId, link: input }));
export const removeProjectLink = async (projectId: string, linkId: string): Promise<void> => {
  await orLogin(browserTrpcClient().projects.removeLink.mutate({ id: projectId, linkId }));
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
) => orLogin(browserTrpcClient().projects.addRecipe.mutate({ id: projectId, recipe: input }));
export const removeProjectRecipe = async (projectId: string, name: string): Promise<void> => {
  await orLogin(browserTrpcClient().projects.removeRecipe.mutate({ id: projectId, name }));
};

// ─── References · git keys ──────────────────────────────────────────────────

export const addReference = (name: string, source: string, ref: string | null) =>
  orLogin(browserTrpcClient().git.addReference.mutate({ name, source, ref }));
export const removeReference = async (id: string): Promise<void> => {
  await orLogin(browserTrpcClient().git.removeReference.mutate({ id }));
};
export const refreshReference = (id: string) =>
  orLogin(browserTrpcClient().git.refreshReference.mutate({ id }));
export const updateSkill = (
  skillId: string,
  request: {
    readonly name: string;
    readonly description: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
    readonly expectedRevision: number;
  },
) => orLogin(browserTrpcClient().skills.update.mutate({ skillId, request }));
export const removeSkill = (skillId: string) =>
  orLogin(browserTrpcClient().skills.remove.mutate({ skillId }));
export const initGitKey = () => orLogin(browserTrpcClient().git.initKey.mutate());
export const setGitAccess = (mode: GitAccessModeDto) =>
  orLogin(browserTrpcClient().git.setAccess.mutate({ mode }));

// ─── Secret files (docs/adr/0010): content goes in, never comes back ────────

// ─── Sessions · services ────────────────────────────────────────────────────

/**
 * How a session the web starts runs: a conversation for a harness that has one, since the session
 * view is built around it; a terminal for every other (shell, pi, opencode, `mend run`). Starts
 * that name no mode (the CLI's, older clients') keep the server's terminal default.
 */
const startMode = (harness: string) =>
  CONVERSATION_HARNESSES.has(harness) ? ({ mode: "protocol" } as const) : {};

export const createSession = (
  projectId: string,
  harness: string,
  base: string | null = null,
  name: string | null = null,
  autoLand: boolean | null = null,
  purpose?: "setup",
) =>
  orLogin(
    browserTrpcClient().sessions.create.mutate({
      projectId,
      session: {
        harness,
        ...startMode(harness),
        label: null,
        name,
        base,
        ...(autoLand === null ? {} : { autoLand }),
        ...(purpose === undefined ? {} : { purpose }),
      },
    }),
  );
export const launchSession = (id: string, argv: ReadonlyArray<string>) =>
  orLogin(browserTrpcClient().sessions.launch.mutate({ id, request: { argv } }));

/** A composed start — the server turns this into the harness's own argv. */
export type LaunchRequestDto = Parameters<TrpcClient["sessions"]["launch"]["mutate"]>[0]["request"];
export type LaunchStartDto = Omit<LaunchRequestDto, "mode" | "argv">;
/** Launch a session the web started, as `startMode` says for its harness. */
export const launchSessionStart = (id: string, harness: string, start: LaunchStartDto) =>
  orLogin(
    browserTrpcClient().sessions.launch.mutate({
      id,
      request: { ...start, ...startMode(harness) },
    }),
  );
export const stopSession = (id: string) =>
  orLogin(browserTrpcClient().sessions.stop.mutate({ id }));
/** Stop every live Service of the session; the workspace ends once nothing is live. */
export const stopSessionServices = (id: string) =>
  orLogin(browserTrpcClient().sessions.stopServices.mutate({ id }));
export const setSharedControl = (id: string, enabled: boolean) =>
  orLogin(browserTrpcClient().sessions.setSharedControl.mutate({ id, enabled }));
/**
 * "Replace this workspace now" (docs/adr/0016, decision 14): the change's owner, naming the
 * retirement they were shown (`seen`, its fingerprint); refused in words (`WorkspaceReplaceRefused`)
 * while an agent's turn is in flight or when more would stop than was listed.
 */
export const replaceWorkspace = (id: string, request: { readonly seen: string }) =>
  orLogin(browserTrpcClient().sessions.replaceWorkspace.mutate({ id, seen: request.seen }));
/** End one piece of the previous sender's background work from the waiting line (decision 6). */
export const endBackgroundWork = (id: string, work: Pick<ConversationWaitWorkDto, "kind" | "id">) =>
  orLogin(
    browserTrpcClient().sessions.endBackgroundWork.mutate({
      id,
      work: { kind: work.kind, id: work.id },
    }),
  );
/** Store a pasted image beside the session; the reply is the workspace path to paste. */
/** Store an image in the session's workspace; `resume` brings a stopped conversation back first. */
export const pasteSessionImage = (id: string, contentsBase64: string, resume = false) =>
  orLogin(
    browserTrpcClient().sessions.pasteImage.mutate({
      id,
      upload: resume ? { contentsBase64, resume: true } : { contentsBase64 },
    }),
  );
export const resumeSession = (id: string, harness: string | null) =>
  orLogin(browserTrpcClient().sessions.resume.mutate({ id, request: { harness } }));
export const removeSession = (id: string) =>
  orLogin(browserTrpcClient().sessions.remove.mutate({ id }));
/** Take over the screen on this viewer's connection, the one its socket's first frame named. */
export const takeScreen = (id: string, connection: string) =>
  orLogin(browserTrpcClient().screens.take.mutate({ id, connection }));
/** Wake the workspace and screen without sending the agent a message. */
export const wakeScreen = (id: string) => orLogin(browserTrpcClient().screens.wake.mutate({ id }));
export const handBackScreen = (id: string) =>
  orLogin(browserTrpcClient().screens.handBack.mutate({ id }));
/**
 * The owner's "discard unsaved and stop" (docs/adr/0002): ends the workspace while its captures
 * are still pending. What was not saved is gone; the page arms it with a second click.
 */
export const discardUnsavedAndStop = (id: string) =>
  orLogin(browserTrpcClient().sessions.discardUnsaved.mutate({ id }));

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
): Promise<WorktreeDto> =>
  orLogin(browserTrpcClient().worktrees.create.mutate({ projectId, worktree }));

/** The container's own verbs — the one explicit destructive act, and a new conversation inside. */
export const removeWorktree = (id: string, force?: boolean) =>
  orLogin(
    browserTrpcClient().worktrees.remove.mutate(force === true ? { id, force: true } : { id }),
  );

/** `autoLand` is this session's own "Land when a turn completes"; null follows the project. */
export const createSessionInWorktree = (
  id: string,
  harness: string,
  autoLand: boolean | null = null,
) =>
  orLogin(
    browserTrpcClient().worktrees.createSession.mutate({
      id,
      session: {
        harness,
        ...startMode(harness),
        label: null,
        ...(autoLand === null ? {} : { autoLand }),
      },
    }),
  );
export const setSessionLabel = (id: string, label: string | null) =>
  orLogin(browserTrpcClient().sessions.setLabel.mutate({ id, label }));
export const checkpointSession = (id: string, trigger: "review-open" | "user-mark") =>
  orLogin(browserTrpcClient().sessions.checkpoint.mutate({ id, request: { trigger } }));

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
  orLogin(browserTrpcClient().sessions.deliverFollowUp.mutate({ id: sessionId, request: input }));

export const runServiceRecipe = (sessionId: string, name: string) =>
  orLogin(browserTrpcClient().sessions.runServiceRecipe.mutate({ id: sessionId, name }));
export const runService = (
  sessionId: string,
  input: {
    argv: ReadonlyArray<string>;
    port: number;
    name: string | null;
    protocol?: "tcp" | "udp";
    browserScheme?: "http" | "https" | null;
  },
) => orLogin(browserTrpcClient().sessions.runService.mutate({ id: sessionId, ...input }));
export const addService = (
  sessionId: string,
  input: {
    port: number;
    name: string | null;
    protocol?: "tcp" | "udp";
    browserScheme?: "http" | "https" | null;
  },
) => orLogin(browserTrpcClient().sessions.addService.mutate({ id: sessionId, ...input }));
export const restartService = (id: string) =>
  orLogin(browserTrpcClient().services.restart.mutate({ id }));
export const stopService = (id: string) =>
  orLogin(browserTrpcClient().services.stop.mutate({ id }));

// ─── Changes · review ───────────────────────────────────────────────────────

export const openReview = (id: string, idempotencyKey: string) =>
  orLogin(browserTrpcClient().changes.openReview.mutate({ id, request: { idempotencyKey } }));

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
    browserTrpcClient().changes.postSliceComment.mutate({
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
    browserTrpcClient().changes.setCommentState.mutate({
      id: changeId,
      commentId,
      request: { state },
    }),
  );
export const readChange = (changeId: string) =>
  orLogin(browserTrpcClient().changes.queueRead.mutate({ id: changeId }));
export const composeTour = (changeId: string) =>
  orLogin(browserTrpcClient().changes.queueTour.mutate({ id: changeId }));
export const suggestChange = (changeId: string) =>
  orLogin(browserTrpcClient().changes.queueSuggest.mutate({ id: changeId }));

// ─── Landing (docs/adr/0007-landing.md) ─────────────────────────────────────

/** The owner's land: push the change's branch, and open or update its pull request. */
export const landSession = (
  sessionId: string,
  request: {
    readonly branch: string | null;
    readonly pullRequest: boolean;
    readonly title: string | null;
    readonly body: string | null;
  },
) => orLogin(browserTrpcClient().landings.land.mutate({ id: sessionId, request }));
/**
 * The landing record with one fetch of origin's branch, under the caller's own git access. A
 * plain read never fetches; this runs only when someone asks.
 */
export const probeLandings = (changeId: string) =>
  orLogin(browserTrpcClient().landings.forChange.query({ id: changeId, probe: true }));
/** Ask `gh` for the pull request's state now; Mend does not poll GitHub. */
export const refreshLanding = (landingId: ChangeLandingDto["id"]) =>
  orLogin(browserTrpcClient().landings.refresh.mutate({ id: landingId }));
/** Ask `gh`, as the change's owner, for a pull request opened outside Mend, and record it. */
export const checkGitHub = (changeId: string) =>
  orLogin(browserTrpcClient().landings.checkGitHub.mutate({ id: changeId }));

// ─── Settings · dotfiles · devices ──────────────────────────────────────────

// ─── Skills ─────────────────────────────────────────────────────────────────

export const createSkill = (request: {
  readonly scope: SkillScopeDto;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
}) => orLogin(browserTrpcClient().skills.create.mutate(request));

// ─── Slack (docs/adr/0006-slack.md) ─────────────────────────────────────────

export const confirmSlackLink = (code: string) =>
  orLogin(browserTrpcClient().slack.confirmLink.mutate({ code }));

export const approveCliAuth = (code: string) =>
  orLogin(browserTrpcClient().devices.approveCliAuth.mutate({ code }));
export const denyCliAuth = (code: string) =>
  orLogin(browserTrpcClient().devices.denyCliAuth.mutate({ code }));

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

/**
 * What the session reads once its agent is no longer live while its Services keep the workspace
 * up (`agent stopped · 3 services keep the workspace up`); null otherwise. A stop leaves
 * Services running, so the status alone would hide a workspace that is still up.
 */
export const sessionServicesHold = (
  session: SessionDto,
  currentAgent: SessionProcessDto | null,
  liveServices: number,
): string | null =>
  servicesHoldLine({
    agentLive: agentIsLive(session, currentAgent),
    agentOutcome: currentAgent === null ? null : agentProcessOutcome(currentAgent),
    liveServices,
  });

/**
 * What the session's executor still holds, as every surface words it (`captureStatusLine`):
 * `saving · 3 left` while a stop drains it, `not saved · 3 pending · workspace kept` once the
 * drain stopped moving. Null when there is nothing to say.
 */
export const sessionCaptureLine = (session: SessionDto): string | null =>
  captureStatusLine(session);

const preferredEndpoint = (view: ServiceViewDto): ServiceEndpointDto | null =>
  view.endpoints.find((endpoint) => endpoint.scope === "private") ?? view.endpoints[0] ?? null;

/** What a client would connect to, exactly as the server bound it. */
export const serviceEndpoint = (view: ServiceViewDto) => preferredEndpoint(view)?.authority ?? null;
