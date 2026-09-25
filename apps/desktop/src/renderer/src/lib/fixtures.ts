import type {
  AgentItemDto,
  ChangeLandingDto,
  ChangeLandingsDto,
  AgentRequestDto,
  AgentTurnDto,
  ProjectDto,
  SessionAnnotationDto,
  SessionControlDto,
  SessionDetailDto,
  SessionDto,
  SessionProcessDto,
} from "#/lib/api";

import type { ApiRequest, ApiResponse, MendBridge } from "../../../shared/bridge";

/**
 * Complete wire objects for tests: every field the contract declares, with quiet defaults, so a
 * test names only what it is about. Imported by tests alone; the app bundle never sees it.
 */

const AT = "2026-08-20T00:00:00.000Z";

export const projectFixture = (patch: Partial<ProjectDto> = {}): ProjectDto => ({
  id: "project-1",
  name: "project-1",
  organizationId: "org-1",
  visibility: "private",
  createdByUserId: "user-1",
  originUrl: null,
  storePath: "/store/project-1/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "ambient",
  workspaceImage: null,
  applyDotfiles: false,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

export const sessionFixture = (patch: Partial<SessionDto> = {}): SessionDto => ({
  id: "session-1",
  projectId: "project-1",
  worktreeId: "worktree-1",
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "worktree-1",
  branch: "mend/worktree-1",
  baseSha: "0000000",
  baseRef: null,
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: null,
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "user-1",
  origin: "mend",
  autoLand: null,
  sharedControlEnabledByUserId: null,
  sharedControlEnabledAt: null,
  hasTranscript: null,
  status: "running",
  summary: null,
  lastSeenSequence: "0",
  recordHistoryComplete: true,
  startedAt: null,
  settledAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

export const processFixture = (patch: Partial<SessionProcessDto> = {}): SessionProcessDto => ({
  id: "process-1",
  sessionId: "session-1",
  sealantWorkspaceId: "workspace-1",
  sealantSessionId: "pty-1",
  sealantRunId: "run-1",
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "agent-pty",
  harness: "claude",
  providerSessionId: null,
  protocolOptions: null,
  label: null,
  argv: [],
  status: "running",
  exitCode: null,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: AT,
  exitedAt: null,
  updatedAt: AT,
  ...patch,
});

export const annotationFixture = (
  patch: Partial<SessionAnnotationDto> = {},
): SessionAnnotationDto => ({
  sessionId: "session-1",
  changeId: null,
  openComments: 0,
  totalComments: 0,
  pendingFollowUp: false,
  currentAgent: null,
  liveServices: 0,
  ...patch,
});

/** The owner's view: every control. */
export const OWNER_CONTROL: SessionControlDto = {
  own: true,
  steer: true,
  stop: true,
  toggleSharedControl: true,
};

export const detailFixture = (patch: Partial<SessionDetailDto> = {}): SessionDetailDto => ({
  session: sessionFixture(),
  control: OWNER_CONTROL,
  checkpoints: [],
  change: null,
  landings: [],
  processes: [],
  currentAgent: null,
  liveServices: 0,
  ...patch,
});

/** A landing that pushed and opened its pull request. */
export const landingFixture = (patch: Partial<ChangeLandingDto> = {}): ChangeLandingDto => ({
  id: "landing-1",
  changeId: "change-1",
  sessionId: "session-1",
  projectId: "project-1",
  checkpointId: "checkpoint-1",
  checkpointRef: "refs/mend/checkpoints/worktree-1/1",
  checkpointSha: "a".repeat(40),
  commitSha: "b".repeat(40),
  remoteBranch: "mend/fix-login",
  pushedSha: `3f2a1c0${"c".repeat(33)}`,
  trigger: "manual",
  pullRequest: {
    number: 412,
    url: "https://github.com/acme/app/pull/412",
    state: "open",
    observedAt: AT,
  },
  outcome: "pull-request",
  message: null,
  userId: "user-1",
  createdAt: AT,
  ...patch,
});

/** A change's landing record as its owner reads it, with nothing landed yet. */
export const landingsFixture = (patch: Partial<ChangeLandingsDto> = {}): ChangeLandingsDto => ({
  changeId: "change-1",
  sessionId: "session-1",
  land: true,
  landings: [],
  facts: [],
  remote: null,
  remoteFailure: null,
  pullRequest: { available: true, reason: null },
  ...patch,
});

export const turnFixture = (patch: Partial<AgentTurnDto> = {}): AgentTurnDto => ({
  id: "turn-1",
  sessionId: "session-1",
  processId: "process-1",
  ordinal: 1,
  author: "user-1",
  input: "Fix the flaky login test",
  status: "completed",
  providerTurnId: null,
  error: null,
  usage: null,
  intent: null,
  intentSource: null,
  landing: null,
  landingId: null,
  createdAt: AT,
  startedAt: AT,
  endedAt: AT,
  ...patch,
});

export const itemFixture = (patch: Partial<AgentItemDto> = {}): AgentItemDto => ({
  id: "item-1",
  sessionId: "session-1",
  processId: "process-1",
  turnId: "turn-1",
  seq: 1,
  providerItemId: "provider-item-1",
  kind: "assistant-message",
  status: "completed",
  title: null,
  text: "Done.",
  data: null,
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

export const requestFixture = (patch: Partial<AgentRequestDto> = {}): AgentRequestDto => ({
  id: "request-1",
  sessionId: "session-1",
  processId: "process-1",
  turnId: "turn-1",
  kind: "command-approval",
  providerRequestId: "provider-request-1",
  providerItemId: null,
  title: null,
  detail: null,
  questions: null,
  status: "pending",
  decision: null,
  decidedBy: null,
  answers: null,
  createdAt: AT,
  decidedAt: null,
  ...patch,
});

/** A preload bridge whose every API request answers through `request`; the rest is inert. */
export const bridgeFixture = (
  request: (input: ApiRequest) => Promise<ApiResponse>,
): MendBridge => ({
  platform: "linux",
  connection: {
    get: async () => ({
      url: "http://localhost:3105",
      signedIn: true,
      configPath: "/tmp/cli.json",
    }),
    authorize: async () => ({ ok: false, reason: "not in test" }),
    awaitAuthorize: async () => ({ ok: false, reason: "not in test" }),
    cancelAuthorize: async () => undefined,
    setToken: async () => undefined,
    signOut: async () => ({ revoke: "no-device" }),
    onChange: () => () => {},
  },
  api: { request },
  tty: { url: async () => "ws://localhost/tty" },
  events: {
    onEvent: () => () => {},
    onState: () => () => {},
  },
  shell: { openExternal: async () => undefined },
  window: {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
  },
});
