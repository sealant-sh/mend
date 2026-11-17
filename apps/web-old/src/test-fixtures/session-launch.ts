import {
  ProjectCapabilities,
  ProjectDetail,
  SessionInboxRow,
  SessionControlView,
  SessionDetail,
} from "@mend/api-contracts";
import {
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  SealantWorkspaceId,
  SealantRunId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Project, Session, SessionProcess, Worktree } from "@mend/domain/workbench";

import { conversationQuery, type ConversationPage } from "#/lib/conversation";
import { getRouter } from "#/router";

const NOW = new Date("2026-11-02T10:00:00Z");
const PROJECT = ProjectId.make("proj-1");

export const project = new Project({
  id: PROJECT,
  organizationId: OrganizationId.make("org-1"),
  visibility: "shared",
  createdByUserId: "dana",
  storePath: "/store/proj-1/repo.git",
  name: "billing",
  originUrl: null,
  defaultBranch: "main",
  adoptedSha: Sha.make("0123456789abcdef"),
  autoTour: "off",
  autoSuggest: "off",
  autoName: "off",
  autoLand: "inherit",
  backgroundSessions: "off",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: false,
  defaultShellProfile: true,
  inheritUserSkills: false,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const worktree = (name: string) =>
  new Worktree({
    id: WorktreeId.make(`wt-${name}`),
    projectId: PROJECT,
    name,
    directory: name,
    branch: `mend/${name}`,
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    handoff: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const makeSession = (name: string, label: string) =>
  new Session({
    id: SessionId.make(`sess-${name}`),
    projectId: PROJECT,
    worktreeId: WorktreeId.make(`wt-${name}`),
    harness: "claude",
    providerSessionId: null,
    label,
    worktree: name,
    branch: `mend/${name}`,
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
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
    ownerUserId: "dana",
    hasTranscript: true,
    status: "starting",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const detailOf = (row: Session) =>
  new SessionDetail({
    session: row,
    control: new SessionControlView({
      own: true,
      steer: true,
      stop: true,
      toggleSharedControl: true,
      terminalInput: true,
      turnsOnSendersLogin: false,
    }),
    checkpoints: [],
    change: null,
    repositories: [],
    landings: [],
    processes: [],
    currentAgent: null,
    liveServices: 0,
    preReleaseMemory: null,
    launchAdmission: "agentRan",
  });

export const session = structuredClone(makeSession("optimistic", "Improve the session composer"));
export const detail = structuredClone(detailOf(session));

export const emptyPage: ConversationPage = {
  turns: [],
  items: [],
  requests: [],
  next: null,
  feed: 0,
};
export const pageWithTurn = (text: string): ConversationPage => ({
  ...emptyPage,
  turns: [
    {
      id: "turn-opening",
      sessionId: session.id,
      ordinal: 1,
      origin: "human",
      author: "dana",
      billedUserId: "dana",
      billedAccountName: null,
      steerSender: null,
      fromSteer: null,
      clientMessageId: null,
      input: text,
      status: "running",
      startedAt: NOW.toISOString(),
      endedAt: null,
      error: null,
      steers: [],
      createdAt: NOW.toISOString(),
    },
  ],
});

/** A real router with the reads a signed-in browser already holds, without any agent process. */
export const launchFixture = () => {
  const router = getRouter();
  const { queryClient, trpc, trpcClient } = router.options.context;
  queryClient.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  queryClient.setQueryData(trpc.projects.list.queryKey(), structuredClone([project]));
  queryClient.setQueryData(
    trpc.projects.detail.queryKey({ id: PROJECT }),
    structuredClone(
      new ProjectDetail({
        project,
        sessions: [session],
        hiddenEndedSessions: 0,
        annotations: [],
        worktrees: [worktree("optimistic")],
        worktreeAnnotations: [],
        capabilities: new ProjectCapabilities({
          manage: true,
          changeVisibility: true,
          remove: true,
          hostMounts: false,
        }),
        mountDelivery: "sources",
      }),
    ),
  );
  queryClient.setQueryData(trpc.sessions.detail.queryKey({ id: session.id }), detail);
  queryClient.setQueryData(trpc.sessions.inbox.queryKey(), []);
  queryClient.setQueryData(trpc.sessions.inboxMarks.queryKey(), []);
  queryClient.setQueryData(trpc.sessions.listActive.queryKey(), []);
  queryClient.setQueryData(trpc.worktrees.list.queryKey({ projectId: PROJECT }), {
    worktrees: [],
    annotations: [],
  });
  queryClient.setQueryData(trpc.organization.current.queryKey(), {
    userId: "dana",
    organization: {
      id: OrganizationId.make("org-1"),
      name: "Example",
      createdByUserId: "dana",
      createdAt: NOW,
      updatedAt: NOW,
    },
    role: "owner",
    memberCount: 1,
    operator: false,
    tenancy: "single",
    mountDelivery: "sources",
  });
  queryClient.setQueryData(trpc.organization.members.queryKey(), [
    {
      userId: "dana",
      name: "Dana",
      organizationId: OrganizationId.make("org-1"),
      email: "dana@example.test",
      role: "owner",
      joinedAt: NOW,
    },
  ]);
  queryClient.setQueryData(trpc.harnesses.models.queryKey(), []);
  queryClient.setQueryData(trpc.sessions.pendingFollowUp.queryKey({ id: session.id }), null);
  queryClient.setQueryData(conversationQuery(trpc, trpcClient, session.id).queryKey, {
    pages: [emptyPage],
    pageParams: [null],
  });
  return router;
};

/** The server facts once the agent's process is running, in either conversation mode. */
export const runningDetail = (kind: "agent-protocol" | "agent-pty"): SessionDetail =>
  structuredClone({
    ...detail,
    session: { ...session, status: "running", sealantRunId: SealantRunId.make("run-fixture") },
    currentAgent: new SessionProcess({
      id: SessionProcessId.make("process-fixture"),
      sessionId: session.id,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-fixture"),
      sealantSessionId: null,
      sealantRunId: SealantRunId.make("run-fixture"),
      launchCorrelationId: null,
      serviceId: null,
      attemptOrdinal: null,
      kind,
      harness: "claude",
      providerSessionId: null,
      protocolOptions: null,
      label: "claude",
      argv: [],
      status: "running",
      exitCode: null,
      workspacePort: null,
      protocol: "tcp",
      hostPort: null,
      createdAt: NOW,
      exitedAt: null,
      updatedAt: NOW,
    }),
  });

/** The real list row used when the server replaces a pending inbox entry. */
export const inboxRow = (value: SessionDetail): SessionInboxRow =>
  structuredClone(
    new SessionInboxRow({
      session: {
        id: value.session.id,
        projectId: value.session.projectId,
        worktreeId: value.session.worktreeId,
        harness: value.session.harness,
        label: value.session.label,
        branch: value.session.branch,
        status: value.session.status,
        ownerUserId: value.session.ownerUserId,
        sharedControlEnabledAt: null,
        startedAt: value.session.startedAt,
        settledAt: value.session.settledAt,
        createdAt: value.session.createdAt,
        updatedAt: value.session.updatedAt,
      },
      projectName: project.name,
      title: value.session.label ?? "New session",
      annotation: null,
      ask: null,
    }),
  );
