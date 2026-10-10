import {
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { describe, expect, it } from "vitest";

import type {
  SessionAnnotationDto,
  SessionDto,
  SessionProcessDto,
  WorktreeAnnotationDto,
  WorktreeDto,
} from "#/lib/api";

import { settledGroups, worktreeGroups } from "./model";

const projectId = ProjectId.make("project-detail-test");

const worktree = (name: string, createdAt: string): WorktreeDto => ({
  id: WorktreeId.make(name),
  projectId,
  name,
  directory: `/store/worktrees/${name}`,
  branch: `mend/${name}`,
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
  baseRef: "main",
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

const session = (
  id: string,
  worktreeName: string,
  status: SessionDto["status"],
  createdAt: string,
): SessionDto => ({
  id: SessionId.make(id),
  projectId,
  worktreeId: WorktreeId.make(worktreeName),
  harness: "claude",
  model: null,
  effort: null,
  providerSessionId: null,
  label: null,
  worktree: `/store/worktrees/${worktreeName}`,
  branch: `mend/${worktreeName}`,
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
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
  ownerUserId: null,
  origin: "mend",
  autoLand: null,
  sharedControlEnabledByUserId: null,
  sharedControlEnabledAt: null,
  sharedControlEverAt: null,
  livePeople: [],
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  hasTranscript: null,
  idleStoppedAt: null,
  capturePending: null,
  capturePendingBytes: null,
  captureRefused: null,
  captureRegisteredAt: null,
  captureObservedAt: null,
  captureDrain: null,
  captureDrainRequestedAt: null,
  captureDrainProgressAt: null,
  captureNotSavedAt: null,
  captureIncompleteReason: null,
  captureIncompleteDetail: null,
  captureFailingSince: null,
  captureFailingError: null,
  captureOverdueStep: null,
  captureOverdueSince: null,
  captureOverdueRunningMs: null,
  captureOverdueBoundMs: null,
  captureDiscardedAt: null,
  captureDiscardedBy: null,
  executorStartedAt: null,
  removalRequestedAt: null,
  status,
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: true,
  startedAt: null,
  settledAt: null,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

const annotations: ReadonlyArray<WorktreeAnnotationDto> = [];

describe("Project detail worktree groups", () => {
  const older = worktree("older", "2026-09-01T00:00:00Z");
  const newer = worktree("newer", "2026-09-03T00:00:00Z");
  const live = worktree("live", "2026-08-01T00:00:00Z");
  const sessions = [
    session("s-live", "live", "running", "2026-08-01T00:00:00Z"),
    session("s-newer", "newer", "completed", "2026-09-03T00:00:00Z"),
    session("s-older", "older", "stopped", "2026-09-01T00:00:00Z"),
  ];

  it("puts live worktrees first, then the newest activity", () => {
    const groups = worktreeGroups([older, newer, live], sessions, annotations);
    expect(groups.map((group) => group.worktree.name)).toEqual(["live", "newer", "older"]);
    expect(groups[0]?.live).toBe(1);
    expect(groups[0]?.members.map((member) => member.id)).toEqual(["s-live"]);
  });

  it("counts a worktree with no live conversation as settled", () => {
    const groups = worktreeGroups([older, newer, live], sessions, annotations);
    expect(settledGroups(groups).map((group) => group.worktree.name)).toEqual(["newer", "older"]);
  });

  it("keeps many sessions under their own worktree and retains empty worktrees", () => {
    const empty = worktree("empty", "2026-09-04T00:00:00Z");
    const sibling = session("s-sibling", "live", "waiting", "2026-09-02T00:00:00Z");
    const groups = worktreeGroups([older, live, empty], [...sessions, sibling], annotations);
    expect(
      groups.find((group) => group.worktree.id === live.id)?.members.map((member) => member.id),
    ).toEqual(["s-live", "s-sibling"]);
    expect(
      groups.find((group) => group.worktree.id === older.id)?.members.map((member) => member.id),
    ).toEqual(["s-older"]);
    expect(groups.find((group) => group.worktree.id === empty.id)?.members).toEqual([]);
    expect(groups.flatMap((group) => group.members).some((member) => member.id === "s-newer")).toBe(
      false,
    );
  });

  it("keeps a stopped agent's worktree live while its Services keep the workspace up", () => {
    const stoppedAgent: SessionProcessDto = {
      id: SessionProcessId.make("agent-1"),
      sessionId: SessionId.make("s-older"),
      sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
      sealantSessionId: "pty-1",
      sealantRunId: null,
      launchCorrelationId: null,
      serviceId: null,
      attemptOrdinal: null,
      kind: "agent-pty",
      harness: "claude",
      providerSessionId: null,
      protocolOptions: null,
      label: "claude",
      argv: ["claude"],
      status: "stopped",
      exitCode: null,
      workspacePort: null,
      protocol: "tcp",
      hostPort: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      firstOutputAt: null,
      exitedAt: new Date("2026-09-01T01:00:00Z"),
      updatedAt: new Date("2026-09-01T01:00:00Z"),
      runsAs: null,
    };
    const facts: ReadonlyArray<SessionAnnotationDto> = [
      {
        sessionId: "s-older",
        changeId: null,
        openComments: 0,
        totalComments: 0,
        pendingFollowUp: false,
        currentAgent: stoppedAgent,
        liveServices: 3,
        pullRequest: null,
      },
    ];
    const groups = worktreeGroups([older, newer, live], sessions, annotations, facts);
    const held = groups.find((group) => group.worktree.id === older.id);
    expect(held?.holds.get("s-older")).toBe("agent stopped · 3 services keep the workspace up");
    expect(held?.live).toBe(1);
    expect(settledGroups(groups).map((group) => group.worktree.name)).toEqual(["newer"]);
  });

  it("keeps a worktree live while a stop is saving its workspace, and says what is left", () => {
    const at = new Date("2026-09-27T10:00:00Z");
    const saving = sessions.map((row) =>
      row.id === "s-older"
        ? {
            ...row,
            capturePending: 3,
            captureDrain: "stop" as const,
            captureDrainRequestedAt: at,
            captureDrainProgressAt: at,
          }
        : row,
    );
    const groups = worktreeGroups([older, newer, live], saving, annotations, []);
    const held = groups.find((group) => group.worktree.id === older.id);
    expect(held?.holds.get("s-older")).toBe("saving · 3 left");
    expect(held?.live).toBe(1);
  });
});
