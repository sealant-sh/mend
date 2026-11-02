import {
  captureStatusLine,
  type EffortLevel,
  type HarnessModelCatalogView,
} from "@mend/domain/workbench";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { harnessName } from "@/data/harness-name";
import type { LaunchOptions } from "@/data/harness-options";
import { ApiError, PairingEnded, type Machine, type Upload } from "@/data/machine";
import { pageKey, pagesOf } from "@/data/pages";
import { usePairing } from "@/data/pairing-scope";
import type { ChangeLandingDto, ChangePullRequestDto } from "@/data/pull-requests";
import { Unreachable } from "@/data/reachability";
import type { CheckpointDto } from "@/data/review-state";
import type {
  ConversationWaitDto,
  LivePersonDto,
  ReplaceWorkspaceBody,
  WorkspaceRetirementDto,
} from "@/data/shared-workspace";
import { ACTIVE, toneOf } from "@/data/status-tone";

// ─── wire types (the server's DTOs, minimally) ──────────────────────────────

export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly adoptedSha: string | null;
}

export const PROTOCOL_HARNESSES = ["claude", "codex"] as const;

export interface WorktreeDto {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
}

export interface SessionDto {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  readonly harness: string;
  /**
   * The model and effort the session was started with, as the server resolved them
   * (docs/models-audit.md). Null before launch and for a harness with no catalog; absent on
   * servers from before they were recorded.
   */
  readonly model?: string | null;
  readonly effort?: EffortLevel | null;
  readonly label: string | null;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly sealantRunId: string | null;
  readonly sealantSessionId: string | null;
  readonly settledAt: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string;
  /** What the executor still holds (docs/adr/0002); absent on servers from before it. */
  readonly capturePending?: number | null;
  readonly capturePendingBytes?: number | null;
  readonly captureRefused?: number | null;
  readonly captureDrain?: string | null;
  readonly captureNotSavedAt?: string | null;
  readonly captureIncompleteReason?: string | null;
  readonly captureIncompleteDetail?: string | null;
  readonly captureFailingSince?: string | null;
  readonly captureFailingError?: string | null;
  readonly captureOverdueStep?: string | null;
  readonly captureOverdueSince?: string | null;
  readonly captureOverdueRunningMs?: number | null;
  readonly captureOverdueBoundMs?: number | null;
  readonly captureDiscardedAt?: string | null;
  readonly captureDiscardedBy?: string | null;
  /** Who started the session; null for one from before organizations, absent on older servers. */
  readonly ownerUserId?: string | null;
  /**
   * The people with a process live in its executor (docs/adr/0016, decision 13): filled by the
   * session's own view only; empty in a project's list, absent on older servers.
   */
  readonly livePeople?: ReadonlyArray<LivePersonDto>;
  readonly resourceStatusLines?: ReadonlyArray<string>;
  /** When its owner turned shared control on; null while off, absent on older servers. */
  readonly sharedControlEnabledAt?: string | null;
  /**
   * Its executor waits to be replaced (docs/adr/0016, decision 14): the phone reads the
   * retirement's detail only then. Null otherwise, absent on older servers.
   */
  readonly workspaceRetirement?: "marked" | "retiring" | null;
}

/**
 * The session's status line: its status, then what a stop is still saving when it is
 * (`stopping · saving · 3 left`, `stopping · not saved · 3 pending · workspace kept`).
 */
export const statusLineOf = (dto: SessionDto): string => {
  const drain = dto.captureDrain;
  const capture = captureStatusLine({
    capturePending: dto.capturePending ?? null,
    capturePendingBytes: dto.capturePendingBytes ?? null,
    captureRefused: dto.captureRefused ?? null,
    captureDrain:
      drain === "stop" || drain === "relaunch" || drain === "replacement" ? drain : null,
    captureNotSavedAt: dto.captureNotSavedAt ?? null,
    captureIncompleteReason: dto.captureIncompleteReason ?? null,
    captureIncompleteDetail: dto.captureIncompleteDetail ?? null,
    captureFailingSince: dto.captureFailingSince ?? null,
    captureFailingError: dto.captureFailingError ?? null,
    captureOverdueStep: dto.captureOverdueStep ?? null,
    captureOverdueSince: dto.captureOverdueSince ?? null,
    captureOverdueRunningMs: dto.captureOverdueRunningMs ?? null,
    captureOverdueBoundMs: dto.captureOverdueBoundMs ?? null,
    captureDiscardedAt: dto.captureDiscardedAt ?? null,
    captureDiscardedBy: dto.captureDiscardedBy ?? null,
  });
  return capture === null ? dto.status : `${dto.status} · ${capture}`;
};

export interface SessionProcessDto {
  readonly id: string;
  readonly kind: "shell" | "agent-pty" | "agent-protocol" | "agent-external" | "service" | "screen";
  readonly status: string;
  readonly exitedAt: string | null;
}

export interface SessionChangeDto {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  /**
   * The change's last contributing conversation — where a review delivers.
   * Null only for a worktree no session ever inhabited (worktree-aware
   * servers); older servers always send it.
   */
  readonly sessionId: string | null;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string | null;
}

/** The outcome of a destructive removal — what went, what would not. */
export interface RemovalReportDto {
  readonly removed: boolean;
  readonly leftover: string | null;
}

// ─── queries ────────────────────────────────────────────────────────────────

/** An image stored beside the session; `path` is what the terminal pastes. */
export interface PastedImageDto {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
}

const pastedImageOf = (value: unknown): PastedImageDto | null =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  "mediaType" in value &&
  "bytes" in value &&
  typeof value.path === "string" &&
  typeof value.mediaType === "string" &&
  typeof value.bytes === "number"
    ? { path: value.path, mediaType: value.mediaType, bytes: value.bytes }
    : null;

export const uploadSessionImage = (
  machine: Machine,
  sessionId: string,
  contentsBase64: string,
  onProgress?: (fraction: number) => void,
): Upload<PastedImageDto> => {
  const upload = machine.upload(`/sessions/${sessionId}/images`, { contentsBase64 }, onProgress);
  const stored = async (): Promise<PastedImageDto> => {
    let answer: unknown;
    try {
      answer = await upload.result;
    } catch (error) {
      // A 409 without a sentence is "no live workspace" (capture mode stores into the running one).
      if (error instanceof ApiError && error.status === 409 && !error.serverWords) {
        throw new ApiError(
          "The session has no live workspace to hold the image. Resume it, then retry.",
          409,
          error.tag,
          false,
        );
      }
      throw error;
    }
    const image = pastedImageOf(answer);
    if (image === null) throw new ApiError("The server returned malformed image data.", 0);
    return image;
  };
  return { result: stored(), abort: upload.abort };
};

export const agentIsActive = (
  session: SessionDto | undefined,
  currentAgent: SessionProcessDto | null,
): boolean =>
  session?.status === "starting" ||
  (currentAgent === null &&
    session !== undefined &&
    (session.status === "running" || session.status === "waiting")) ||
  (currentAgent !== null &&
    currentAgent.exitedAt === null &&
    (currentAgent.status === "starting" || currentAgent.status === "running"));

export { ACTIVE, toneOf };

/** Adapt a server session into the shape the skeleton's components render. */
export const toSession = (dto: SessionDto, projectName: string) => ({
  id: dto.id,
  runId: dto.sealantRunId ?? "",
  harness: harnessName(dto.harness),
  model: dto.model ?? null,
  projectId: projectName,
  title: dto.label ?? `session ${dto.id.slice(0, 8)}`,
  state: (ACTIVE.has(dto.status)
    ? dto.status === "waiting"
      ? "waiting"
      : "running"
    : dto.status === "completed"
      ? "completed"
      : dto.status === "failed"
        ? "failed"
        : "stopped") as "running" | "waiting" | "completed" | "failed" | "stopped",
  statusWord: dto.status,
  statusTone: toneOf(dto.status),
  startedAt: dto.startedAt ?? dto.createdAt,
  eventCount: 0,
  events: [],
});

export const useProjects = () => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => machine.read<ReadonlyArray<ProjectDto>>("/projects"),
    refetchInterval: 15_000,
  });
};

/** List decoration for one session — DB-cheap review facts, no git involved. */
export interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly changeId: string | null;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
  /** The change's newest pull request; older servers omit it. */
  readonly pullRequest?: ChangePullRequestDto | null;
}

interface ProjectDetailDto {
  readonly project: ProjectDto;
  readonly sessions: ReadonlyArray<SessionDto>;
  readonly annotations: ReadonlyArray<SessionAnnotationDto>;
  /** Present when the server is worktree-aware — the capability signal. */
  readonly worktrees?: ReadonlyArray<WorktreeDto>;
}

/** The row's mono second line, from what the annotation can say cheaply. */
export const annotationDetail = (
  annotation: SessionAnnotationDto | undefined,
  summary: string | null,
): string | null => {
  const parts: Array<string> = [];
  if (annotation !== undefined && annotation.openComments > 0) {
    parts.push(
      `${annotation.openComments} open comment${annotation.openComments === 1 ? "" : "s"}`,
    );
  }
  if (annotation?.pendingFollowUp === true) parts.push("follow-up pending");
  if (parts.length === 0) return summary;
  return parts.join(" · ");
};

export interface ProjectBranchDto {
  readonly name: string;
  readonly sha: string;
  readonly committedAt: string;
  readonly isDefault: boolean;
}

/** Branches a session can base on — what the project store holds right now. */
/** The server-owned model catalog (docs/models-audit.md), as the wire carries it. */
export type HarnessModelCatalogDto = HarnessModelCatalogView;

/**
 * Every harness's models, from the server: the one list the phone's picker draws. Nothing on the
 * phone names a model of its own.
 */
export const useHarnessModels = () => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["harness-models"],
    queryFn: () => machine.read<ReadonlyArray<HarnessModelCatalogDto>>("/harnesses/models"),
    staleTime: 60_000,
  });
};

export const useProjectBranches = (projectId: string | null, enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["project-branches", projectId],
    enabled: enabled && projectId !== null,
    queryFn: () => machine.read<ReadonlyArray<ProjectBranchDto>>(`/projects/${projectId}/branches`),
  });
};

export const useProjectSessions = (projectId: string | null) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["project", projectId],
    enabled: projectId !== null,
    queryFn: () => machine.read<ProjectDetailDto>(`/projects/${projectId}`),
    refetchInterval: 10_000,
  });
};

export const useAllSessions = () => {
  const { machine } = usePairing();
  const projects = useProjects();
  return useQuery({
    queryKey: ["all-sessions", projects.data?.map((p) => p.id).join(",")],
    enabled: projects.data !== undefined,
    queryFn: async () => {
      const details = await Promise.all(
        (projects.data ?? []).map((project) =>
          machine.read<ProjectDetailDto>(`/projects/${project.id}`).then((detail) =>
            detail.sessions.map((s) => ({
              session: s,
              project,
              annotation: detail.annotations.find((row) => row.sessionId === s.id),
            })),
          ),
        ),
      );
      return details.flat();
    },
    refetchInterval: 8_000,
  });
};

export const usePage = (route: { readonly id: string; readonly sessionId: string } | null) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: pageKey(route?.sessionId ?? "", route?.id ?? ""),
    enabled: route !== null,
    queryFn: async () => {
      const pages = await machine.read<unknown>(
        `/sessions/${encodeURIComponent(route?.sessionId ?? "")}/pages`,
      );
      return pagesOf(pages).find((page) => page.id === route?.id) ?? null;
    },
  });
};

export const useSession = (id: string | null) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["session", id],
    enabled: id !== null,
    queryFn: () =>
      machine.read<{
        readonly session: SessionDto;
        /** The worktree's whole chain, every conversation's checkpoints in it. */
        readonly checkpoints: ReadonlyArray<CheckpointDto>;
        readonly change: SessionChangeDto | null;
        /** The change's landings, newest first; older servers omit it. */
        readonly landings?: ReadonlyArray<ChangeLandingDto>;
        readonly processes: ReadonlyArray<SessionProcessDto>;
        readonly currentAgent: SessionProcessDto | null;
        /** What this account may do (docs/adr/0003); absent from servers before organizations. */
        readonly control?: {
          readonly own: boolean;
          readonly steer: boolean;
          readonly stop: boolean;
          readonly toggleSharedControl: boolean;
          /** Type in its terminals, the owner's alone (docs/adr/0013); absent before it. */
          readonly terminalInput?: boolean;
        };
      }>(`/sessions/${id}`),
    refetchInterval: 5_000,
  });
};

/**
 * Whether this account types in the session's terminals: the owner's alone, even while control is
 * shared (docs/adr/0013). A server from before it says nothing and takes every steerer's keys.
 */
export const terminalInputOf = (
  control: { readonly terminalInput?: boolean } | undefined,
): boolean => control?.terminalInput ?? true;

/** The organization's members by name, for saying whose session it is. */
export const useOrganizationMembers = () => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["organization-members"],
    queryFn: () =>
      machine.read<ReadonlyArray<{ readonly userId: string; readonly name: string }>>(
        "/organization/members",
      ),
    staleTime: 60_000,
    retry: false,
  });
};

/** The session's owner by name, else the words every client falls back to. */
export const useOwnerName = (session: SessionDto | undefined): string => {
  const members = useOrganizationMembers().data ?? [];
  const ownerUserId = session?.ownerUserId ?? null;
  return members.find((member) => member.userId === ownerUserId)?.name ?? "its owner";
};

/** Who is looking: their account id, for the lines that name everyone else. */
export const useViewerId = (): string | null => {
  const { machine } = usePairing();
  return (
    useQuery({
      queryKey: ["organization"],
      queryFn: () => machine.read<{ readonly userId: string }>("/organization"),
      staleTime: 60_000,
      retry: false,
    }).data?.userId ?? null
  );
};

/**
 * What holds the next sender's turn in a shared conversation, as both people see it (docs/adr/
 * 0016, decision 6). Under the conversation's key, so a turn sent or answered re-reads it. Read
 * only while `enabled` (`readsWaiting`: someone live in the executor, control shared); re-read on a
 * timer while the composer is live as well. A server from before shared steering answers 404: no
 * line.
 */
export const useConversationWait = (sessionId: string, live: boolean, enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["session", sessionId, "conversation", "waiting"],
    queryFn: () => machine.read<ConversationWaitDto | null>(`/sessions/${sessionId}/waiting`),
    enabled,
    refetchInterval: live && enabled ? 4_000 : false,
    retry: false,
  });
};

/**
 * The session's executor, started before per-person homes, waiting to be replaced (docs/adr/0016,
 * decision 14). Read only while `enabled` (`readsRetirement`: the session's own view says so). A
 * server from before answers 404: no line.
 */
export const useWorkspaceRetirement = (sessionId: string, enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["session", sessionId, "workspace-retirement"],
    queryFn: () =>
      machine.read<WorkspaceRetirementDto | null>(`/sessions/${sessionId}/workspace-retirement`),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
    retry: false,
  });
};

// ─── github discovery (the server host's own gh CLI answers) ────────────────

export interface GhStatusDto {
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly login: string | null;
  readonly detail: string | null;
}

export interface GhRepoDto {
  readonly nameWithOwner: string;
  readonly description: string | null;
  readonly visibility: string;
  readonly isFork: boolean;
  readonly language: string | null;
  readonly stars: number;
  readonly pushedAt: string | null;
  readonly url: string;
}

export const useGhStatus = () => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["github-status"],
    queryFn: () => machine.read<GhStatusDto>("/github/status"),
    staleTime: 30_000,
    retry: false,
  });
};

export const useGhRepos = (query: string, enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["github-repos", query],
    enabled,
    queryFn: () =>
      machine.read<ReadonlyArray<GhRepoDto>>(
        query === "" ? "/github/repos" : `/github/repos?query=${encodeURIComponent(query)}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
};

// ─── actions ────────────────────────────────────────────────────────────────

/** How long to keep watching for a clone whose request dropped mid-flight. */
const ADOPT_WATCH_MS = 180_000;
const ADOPT_POLL_MS = 3_000;

export const useAdoptProject = () => {
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly name: string; readonly source: string }) => {
      try {
        return await machine.write<ProjectDto>("POST", "/projects", input);
      } catch (error) {
        // A big clone can outlive the phone's request while the server keeps
        // cloning. Only on a dropped connection (never on an answered
        // failure), watch the project list for the name instead of failing
        // blind.
        if (!(error instanceof Unreachable)) throw error;
        const startedAt = Date.now();
        while (Date.now() - startedAt < ADOPT_WATCH_MS) {
          await new Promise((resolve) => setTimeout(resolve, ADOPT_POLL_MS));
          const projects = await machine
            .read<ReadonlyArray<ProjectDto>>("/projects")
            .catch((failure: unknown) => {
              if (failure instanceof PairingEnded) throw failure;
              return null;
            });
          const adopted = projects?.find((project) => project.name === input.name);
          if (adopted !== undefined) return adopted;
        }
        throw new Error(
          `The connection dropped mid-clone and "${input.name}" has not appeared after 3 minutes — check the server.`,
          { cause: error },
        );
      }
    },
    onSettled: () => queryClient.invalidateQueries(),
  });
};

export interface FollowUpDto {
  readonly id: string;
  readonly sessionId: string;
  readonly reviewSliceId: string | null;
  readonly checkpointAId: string | null;
  readonly checkpointBId: string | null;
  readonly diffDigest: string | null;
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string | null;
  readonly status: string;
  readonly deliveryError: string | null;
}

export const requireFollowUpDelivery = (followUp: FollowUpDto): FollowUpDto => {
  if (followUp.status === "delivery_failed") {
    throw new ApiError(followUp.deliveryError ?? "The follow-up could not be delivered.", 0);
  }
  return followUp;
};

export const canDeliverFollowUp = (followUp: FollowUpDto): boolean =>
  followUp.reviewSliceId !== null &&
  followUp.checkpointAId !== null &&
  followUp.checkpointBId !== null &&
  followUp.diffDigest !== null &&
  followUp.commentIds.length > 0 &&
  followUp.idempotencyKey !== null;

export const usePendingFollowUp = (sessionId: string | undefined) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["session", sessionId, "follow-up"],
    enabled: sessionId !== undefined,
    refetchInterval: 10_000,
    queryFn: () => machine.read<FollowUpDto | null>(`/sessions/${sessionId}/follow-up`),
  });
};

export const useSessionActions = () => {
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries();
  const start = useMutation({
    mutationFn: async (input: {
      readonly projectId: string;
      readonly harness: string;
      readonly purpose?: "setup";
      readonly base?: string | null;
      /** Names the worktree (branch `mend/<name>`); null derives from the session id. */
      readonly name?: string | null;
      readonly options?: LaunchOptions;
    }) => {
      const session = await machine.write<SessionDto>(
        "POST",
        `/projects/${input.projectId}/sessions`,
        {
          harness: input.harness,
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          mode: "protocol",
          label: null,
          name: input.name ?? null,
          base: input.base ?? null,
        },
      );
      // Fire-and-forget: the server settles the session if provisioning fails.
      // A null option means "the harness's own default" and stays off the wire.
      const launch: Record<string, unknown> = { mode: "protocol" };
      if (input.options !== undefined) {
        if (input.options.model !== null) launch.model = input.options.model;
        if (input.options.effort !== null) launch.effort = input.options.effort;
        if (input.options.speed !== null) launch.speed = input.options.speed;
      }
      void machine.write("POST", `/sessions/${session.id}/launch`, launch).catch(() => undefined);
      return session;
    },
    onSettled: invalidate,
  });
  const resume = useMutation({
    mutationFn: (input: { readonly sessionId: string; readonly harness: string | null }) =>
      machine.write<SessionDto>("POST", `/sessions/${input.sessionId}/resume`, {
        harness: input.harness,
      }),
    onSettled: invalidate,
  });
  const stop = useMutation({
    mutationFn: (sessionId: string) =>
      machine.write<SessionDto>("POST", `/sessions/${sessionId}/stop`, {}),
    onSettled: invalidate,
  });
  // Mode switch: continue a PTY-born session here in structured mode — one round trip performs
  // takeover, history backfill, protocol launch, and (when given) the first turn.
  const switchMode = useMutation({
    mutationFn: (input: {
      readonly sessionId: string;
      readonly to: "protocol" | "pty";
      readonly prompt?: string;
    }) =>
      machine.write<SessionDto>("POST", `/sessions/${input.sessionId}/handoff`, {
        to: input.to,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      }),
    onSettled: invalidate,
  });
  const setLabel = useMutation({
    mutationFn: (input: { readonly sessionId: string; readonly label: string | null }) =>
      machine.write<SessionDto>("POST", `/sessions/${input.sessionId}/label`, {
        label: input.label,
      }),
    onSettled: invalidate,
  });
  // Settled sessions only — the server answers 409 for a live one. Removes
  // the conversation record only; the worktree stands (worktree-aware servers).
  const remove = useMutation({
    mutationFn: (sessionId: string) =>
      machine.write<RemovalReportDto>("DELETE", `/sessions/${sessionId}`),
    onSettled: invalidate,
  });
  // The container's explicit removal — refused while any conversation is live.
  const removeWorktree = useMutation({
    mutationFn: (worktreeId: string) =>
      machine.write<RemovalReportDto>("DELETE", `/worktrees/${worktreeId}`),
    onSettled: invalidate,
  });
  // No bulk endpoint exists; mirror web's client-side sweep. Partial failure
  // is fine — whatever refused (a session that went live again) stays listed.
  const removeSettled = useMutation({
    mutationFn: async (sessionIds: ReadonlyArray<string>) => {
      const outcomes = await Promise.allSettled(
        sessionIds.map((id) => machine.write<RemovalReportDto>("DELETE", `/sessions/${id}`)),
      );
      return outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    },
    onSettled: invalidate,
  });
  const openShell = useMutation({
    mutationFn: (sessionId: string) =>
      machine.write<SessionProcessDto>("POST", `/sessions/${sessionId}/shell`, {}),
    onSettled: invalidate,
  });
  // "Replace this workspace now" (docs/adr/0016, decision 14): the change's owner, with the
  // fingerprint of the list they were shown (`seen`). A refusal (409) carries the server's own
  // sentence, which `failureWords` keeps as it is.
  const replaceWorkspace = useMutation({
    mutationFn: (input: { readonly sessionId: string; readonly body: ReplaceWorkspaceBody }) =>
      machine.writeNoContent(
        "POST",
        `/sessions/${input.sessionId}/workspace-retirement/replace`,
        input.body,
      ),
    onSettled: invalidate,
  });
  const stopShell = useMutation({
    mutationFn: (processId: string) =>
      machine.write<SessionProcessDto>("POST", `/processes/${processId}/stop`, {}),
    onSettled: invalidate,
  });
  const deliverFollowUp = useMutation({
    mutationFn: async (followUp: FollowUpDto) => {
      if (!canDeliverFollowUp(followUp)) {
        throw new ApiError(
          "This follow-up predates pinned Review and cannot be delivered here.",
          0,
        );
      }
      const delivered = await machine.write<FollowUpDto>(
        "POST",
        `/sessions/${followUp.sessionId}/follow-up/deliver`,
        {
          reviewSliceId: followUp.reviewSliceId,
          checkpointAId: followUp.checkpointAId,
          checkpointBId: followUp.checkpointBId,
          diffDigest: followUp.diffDigest,
          commentIds: followUp.commentIds,
          instruction: followUp.instruction,
          idempotencyKey: followUp.idempotencyKey,
        },
      );
      return requireFollowUpDelivery(delivered);
    },
    onSettled: invalidate,
  });
  return {
    start,
    resume,
    stop,
    switchMode,
    setLabel,
    remove,
    removeWorktree,
    removeSettled,
    openShell,
    stopShell,
    deliverFollowUp,
    replaceWorkspace,
  };
};
