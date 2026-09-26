/**
 * The live workbench API, adapted into the shapes the screens already render
 * (mock.ts defined the visual contract; this feeds it real sessions). Config
 * is a server URL + a token stored on device — minted by pairing, or the
 * CLI bearer token typed in by hand.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import type { StatusTone } from "@/components/status";
import type { LaunchOptions } from "@/data/harness-options";

// ─── config ─────────────────────────────────────────────────────────────────

export interface MendConfig {
  readonly url: string;
  readonly token: string;
  /** The name the machine recorded for this device when it paired. */
  readonly deviceName: string | null;
  /** ISO timestamp of the pairing claim; null for a hand-typed token. */
  readonly pairedAt: string | null;
}

const EMPTY: MendConfig = { url: "", token: "", deviceName: null, pairedAt: null };

const readString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const parseConfig = (raw: string): MendConfig | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("url" in value) ||
      !("token" in value) ||
      typeof value.url !== "string" ||
      typeof value.token !== "string"
    ) {
      return null;
    }
    return {
      url: value.url,
      token: value.token,
      deviceName: "deviceName" in value ? readString(value.deviceName) : null,
      pairedAt: "pairedAt" in value ? readString(value.pairedAt) : null,
    };
  } catch {
    return null;
  }
};

// One store, read two ways: `loadConfig()` for the fetch path (awaits the
// first read off disk) and `useConfig()` for screens (re-renders on save,
// no effect). Hydrated once at import, same pattern as preferences.ts.
//
// null is a third state, not a missing value: "the store has not answered
// yet". Screens that render "not paired" have to wait for it, or a phone that
// is paired flashes the pairing panel on every cold start.
let current: MendConfig | null = null;
const configListeners = new Set<() => void>();
const notifyConfig = (): void => {
  for (const listener of configListeners) listener();
};

const settle = (config: MendConfig): void => {
  current = config;
  notifyConfig();
};

// ─── where the token lives ──────────────────────────────────────────────────
//
// The bearer token is a credential for the machine, so it sits in the OS
// keychain (iOS Keychain, Android Keystore), readable only while the phone is
// unlocked and never carried to another device by a backup — the machine
// recorded THIS device, and a restore onto a new phone should pair again.
// The web build has no keychain: it keeps the browser's storage, as before.
// Phones that paired before this change hold the config in AsyncStorage;
// the first read moves it across and clears the plain copy.

const CONFIG_KEY = "mend-config";
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const keychainUsable = Platform.OS !== "web";

const readStoredConfig = async (): Promise<string | null> => {
  if (!keychainUsable) return AsyncStorage.getItem(CONFIG_KEY);
  const secure = await SecureStore.getItemAsync(CONFIG_KEY, KEYCHAIN);
  if (secure !== null) return secure;
  const legacy = await AsyncStorage.getItem(CONFIG_KEY);
  if (legacy === null) return null;
  await SecureStore.setItemAsync(CONFIG_KEY, legacy, KEYCHAIN);
  await AsyncStorage.removeItem(CONFIG_KEY);
  return legacy;
};

const writeStoredConfig = (raw: string): Promise<void> =>
  keychainUsable
    ? SecureStore.setItemAsync(CONFIG_KEY, raw, KEYCHAIN)
    : AsyncStorage.setItem(CONFIG_KEY, raw);

const removeStoredConfig = async (): Promise<void> => {
  // Both homes, so a pre-keychain copy cannot outlive an unpair.
  if (keychainUsable) await SecureStore.deleteItemAsync(CONFIG_KEY, KEYCHAIN);
  await AsyncStorage.removeItem(CONFIG_KEY);
};

const hydrated: Promise<void> = readStoredConfig()
  .then((raw) => {
    settle((raw === null ? null : parseConfig(raw)) ?? EMPTY);
    return undefined;
  })
  .catch(() => settle(EMPTY));

export const loadConfig = async (): Promise<MendConfig> => {
  await hydrated;
  return current ?? EMPTY;
};

export const saveConfig = async (config: MendConfig): Promise<void> => {
  current = config;
  notifyConfig();
  await writeStoredConfig(JSON.stringify(config));
};

/** Forget the machine on this device. The machine keeps its own record. */
export const clearConfig = async (): Promise<void> => {
  current = EMPTY;
  notifyConfig();
  await removeStoredConfig();
};

/** null until the stored config has been read — see the note on `current`. */
export const useConfig = (): MendConfig | null =>
  useSyncExternalStore(
    (onChange: () => void) => {
      configListeners.add(onChange);
      return () => configListeners.delete(onChange);
    },
    () => current,
    () => null,
  );

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
}

export interface SessionProcessDto {
  readonly id: string;
  readonly kind: "shell" | "agent-pty" | "agent-protocol" | "agent-external" | "service";
  readonly status: string;
  readonly exitedAt: string | null;
}

export interface ChangedFileDto {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
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

/** The server answered and said no — carries its own words when it gave any. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Shared by the review data module — one transport, one error shape. */
export const api = async <T>(
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown,
): Promise<T> => {
  const config = await loadConfig();
  if (config.url === "") throw new ApiError("Set the server URL in Settings first.", 0);
  const response = await fetch(`${config.url}/api${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let message = `${method} ${route} → ${response.status}`;
    try {
      const parsed = (await response.json()) as { readonly message?: unknown };
      if (typeof parsed.message === "string" && parsed.message !== "") message = parsed.message;
    } catch {
      // Not JSON — the status line stands.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
};

// ─── queries ────────────────────────────────────────────────────────────────

/** An image stored beside the session; `path` is what the terminal pastes. */
export interface PastedImageDto {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export const pasteSessionImage = (sessionId: string, contentsBase64: string) =>
  api<PastedImageDto>("POST", `/sessions/${sessionId}/images`, { contentsBase64 });

export const ACTIVE = new Set(["starting", "running", "waiting", "idle"]);

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

export const toneOf = (status: string): StatusTone =>
  status === "completed"
    ? "observed"
    : status === "failed"
      ? "breakage"
      : status === "waiting" || status === "idle"
        ? "waiting"
        : ACTIVE.has(status)
          ? "live"
          : "pending";

/** Adapt a server session into the shape the skeleton's components render. */
export const toSession = (dto: SessionDto, projectName: string) => ({
  id: dto.id,
  runId: dto.sealantRunId ?? "",
  harness: (dto.harness === "claude"
    ? "Claude Code"
    : dto.harness === "codex"
      ? "Codex"
      : "OpenCode") as "Claude Code" | "Codex" | "OpenCode",
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

export const useProjects = () =>
  useQuery({
    queryKey: ["projects"],
    queryFn: () => api<ReadonlyArray<ProjectDto>>("GET", "/projects"),
    refetchInterval: 15_000,
  });

/** List decoration for one session — DB-cheap review facts, no git involved. */
export interface SessionAnnotationDto {
  readonly sessionId: string;
  readonly changeId: string | null;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
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
export const useProjectBranches = (projectId: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ["project-branches", projectId],
    enabled: enabled && projectId !== null,
    queryFn: () => api<ReadonlyArray<ProjectBranchDto>>("GET", `/projects/${projectId}/branches`),
  });

export const useProjectSessions = (projectId: string | null) =>
  useQuery({
    queryKey: ["project", projectId],
    enabled: projectId !== null,
    queryFn: () => api<ProjectDetailDto>("GET", `/projects/${projectId}`),
    refetchInterval: 10_000,
  });

export const useAllSessions = () => {
  const projects = useProjects();
  return useQuery({
    queryKey: ["all-sessions", projects.data?.map((p) => p.id).join(",")],
    enabled: projects.data !== undefined,
    queryFn: async () => {
      const details = await Promise.all(
        (projects.data ?? []).map((project) =>
          api<ProjectDetailDto>("GET", `/projects/${project.id}`).then((detail) =>
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

export const useSession = (id: string | null) =>
  useQuery({
    queryKey: ["session", id],
    enabled: id !== null,
    queryFn: () =>
      api<{
        readonly session: SessionDto;
        readonly checkpoints: ReadonlyArray<{ readonly sha: string; readonly trigger: string }>;
        readonly change: SessionChangeDto | null;
        readonly processes: ReadonlyArray<SessionProcessDto>;
        readonly currentAgent: SessionProcessDto | null;
        /** What this account may do (docs/adr/0003); absent from servers before organizations. */
        readonly control?: {
          readonly own: boolean;
          readonly steer: boolean;
          readonly stop: boolean;
          readonly toggleSharedControl: boolean;
        };
      }>("GET", `/sessions/${id}`),
    refetchInterval: 5_000,
  });

export const useChangeDiff = (changeId: string | null) =>
  useQuery({
    queryKey: ["change", changeId],
    enabled: changeId !== null,
    queryFn: () =>
      api<{
        readonly change: SessionChangeDto;
        readonly diff: string;
        readonly files: ReadonlyArray<ChangedFileDto>;
      }>("GET", `/changes/${changeId}/diff`),
  });

export interface TranscriptEventDto {
  readonly kind: string;
  readonly text: string | null;
  readonly name: string | null;
  readonly command: string | null;
  readonly output: string | null;
}

export const useTranscript = (sessionId: string, live: boolean) =>
  useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: () =>
      api<{ readonly sourceHarness: string; readonly events: ReadonlyArray<TranscriptEventDto> }>(
        "GET",
        `/sessions/${sessionId}/transcript`,
      ),
    refetchInterval: live ? 1_500 : false,
  });

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

export const useGhStatus = () =>
  useQuery({
    queryKey: ["github-status"],
    queryFn: () => api<GhStatusDto>("GET", "/github/status"),
    staleTime: 30_000,
    retry: false,
  });

export const useGhRepos = (query: string, enabled: boolean) =>
  useQuery({
    queryKey: ["github-repos", query],
    enabled,
    queryFn: () =>
      api<ReadonlyArray<GhRepoDto>>(
        "GET",
        query === "" ? "/github/repos" : `/github/repos?query=${encodeURIComponent(query)}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

// ─── actions ────────────────────────────────────────────────────────────────

/** How long to keep watching for a clone whose request dropped mid-flight. */
const ADOPT_WATCH_MS = 180_000;
const ADOPT_POLL_MS = 3_000;

export const useAdoptProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly name: string; readonly source: string }) => {
      try {
        return await api<ProjectDto>("POST", "/projects", input);
      } catch (error) {
        // A big clone can outlive the phone's request while the server keeps
        // cloning. Only on a dropped connection (never on an answered
        // failure), watch the project list for the name instead of failing
        // blind.
        if (!(error instanceof TypeError)) throw error;
        const startedAt = Date.now();
        while (Date.now() - startedAt < ADOPT_WATCH_MS) {
          await new Promise((resolve) => setTimeout(resolve, ADOPT_POLL_MS));
          const projects = await api<ReadonlyArray<ProjectDto>>("GET", "/projects").catch(
            () => null,
          );
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

export const usePendingFollowUp = (sessionId: string | undefined) =>
  useQuery({
    queryKey: ["session", sessionId, "follow-up"],
    enabled: sessionId !== undefined,
    refetchInterval: 10_000,
    queryFn: () => api<FollowUpDto | null>("GET", `/sessions/${sessionId}/follow-up`),
  });

export const useSessionActions = () => {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries();
  const start = useMutation({
    mutationFn: async (input: {
      readonly projectId: string;
      readonly harness: string;
      readonly base?: string | null;
      /** Names the worktree (branch `mend/<name>`); null derives from the session id. */
      readonly name?: string | null;
      readonly options?: LaunchOptions;
    }) => {
      const session = await api<SessionDto>("POST", `/projects/${input.projectId}/sessions`, {
        harness: input.harness,
        mode: "protocol",
        label: null,
        name: input.name ?? null,
        base: input.base ?? null,
      });
      // Fire-and-forget: the server settles the session if provisioning fails.
      // A null option means "the harness's own default" and stays off the wire.
      const launch: Record<string, unknown> = { mode: "protocol" };
      if (input.options !== undefined) {
        if (input.options.model !== null) launch.model = input.options.model;
        if (input.options.effort !== null) launch.effort = input.options.effort;
        if (input.options.speed !== null) launch.speed = input.options.speed;
      }
      void api("POST", `/sessions/${session.id}/launch`, launch).catch(() => undefined);
      return session;
    },
    onSettled: invalidate,
  });
  const resume = useMutation({
    mutationFn: (input: { readonly sessionId: string; readonly harness: string | null }) =>
      api<SessionDto>("POST", `/sessions/${input.sessionId}/resume`, {
        harness: input.harness,
      }),
    onSettled: invalidate,
  });
  const stop = useMutation({
    mutationFn: (sessionId: string) => api<SessionDto>("POST", `/sessions/${sessionId}/stop`, {}),
    onSettled: invalidate,
  });
  // Cross-mode pickup (mode handoff): continue a PTY-born session here in
  // structured mode — one round trip performs takeover, history backfill,
  // protocol launch, and (when given) the first turn.
  const handoff = useMutation({
    mutationFn: (input: {
      readonly sessionId: string;
      readonly to: "protocol" | "pty";
      readonly prompt?: string;
    }) =>
      api<SessionDto>("POST", `/sessions/${input.sessionId}/handoff`, {
        to: input.to,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      }),
    onSettled: invalidate,
  });
  const setLabel = useMutation({
    mutationFn: (input: { readonly sessionId: string; readonly label: string | null }) =>
      api<SessionDto>("POST", `/sessions/${input.sessionId}/label`, { label: input.label }),
    onSettled: invalidate,
  });
  // Settled sessions only — the server answers 409 for a live one. Removes
  // the conversation record only; the worktree stands (worktree-aware servers).
  const remove = useMutation({
    mutationFn: (sessionId: string) => api<RemovalReportDto>("DELETE", `/sessions/${sessionId}`),
    onSettled: invalidate,
  });
  // The container's explicit removal — refused while any conversation is live.
  const removeWorktree = useMutation({
    mutationFn: (worktreeId: string) => api<RemovalReportDto>("DELETE", `/worktrees/${worktreeId}`),
    onSettled: invalidate,
  });
  // No bulk endpoint exists; mirror web's client-side sweep. Partial failure
  // is fine — whatever refused (a session that went live again) stays listed.
  const removeSettled = useMutation({
    mutationFn: async (sessionIds: ReadonlyArray<string>) => {
      const outcomes = await Promise.allSettled(
        sessionIds.map((id) => api<RemovalReportDto>("DELETE", `/sessions/${id}`)),
      );
      return outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    },
    onSettled: invalidate,
  });
  const openShell = useMutation({
    mutationFn: (sessionId: string) =>
      api<SessionProcessDto>("POST", `/sessions/${sessionId}/shell`, {}),
    onSettled: invalidate,
  });
  const stopShell = useMutation({
    mutationFn: (processId: string) =>
      api<SessionProcessDto>("POST", `/processes/${processId}/stop`, {}),
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
      const delivered = await api<FollowUpDto>(
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
    handoff,
    setLabel,
    remove,
    removeWorktree,
    removeSettled,
    openShell,
    stopShell,
    deliverFollowUp,
  };
};
