export const SESSION_STATUSES = [
  "starting",
  "running",
  "waiting",
  "idle",
  "stopping",
  "completed",
  "failed",
  "stopped",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
}

export interface Worktree {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  readonly createdAt: string;
}

export interface Session {
  readonly id: string;
  readonly projectId: string;
  /** Present once the server is worktree-aware. */
  readonly worktreeId?: string;
  readonly harness: string;
  readonly label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly status: SessionStatus;
  /** The session's current workspace — the SSH-reachable environment its worktree is mounted in. */
  readonly sealantWorkspaceId: string | null;
  /** What the session line says after its status (`building the workspace image …`); older servers omit it. */
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface ProjectDetail {
  readonly project: Project;
  readonly sessions: ReadonlyArray<Session>;
  /** Present when the server is worktree-aware — the capability signal. */
  readonly worktrees?: ReadonlyArray<Worktree>;
}

export interface RepositoryFacts {
  readonly path: string;
  readonly folder: string;
  readonly originUrl: string | null;
}

export type ProjectResolution =
  | { readonly status: "matched"; readonly project: Project; readonly matchedBy: string }
  | {
      readonly status: "ambiguous";
      readonly candidates: ReadonlyArray<Project>;
      readonly matchedBy: string;
    }
  | { readonly status: "not-found" };

export interface LaunchStart {
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  readonly permissionMode?: "ask" | undefined;
  readonly speed?: "fast" | undefined;
}

/** One process a session has held — an agent, a shell, a Service attempt. */
export interface SessionProcess {
  readonly id: string;
  readonly kind: string;
  readonly harness: string | null;
  readonly status: string;
  /** Wire timestamp kept opaque: only its presence matters here. */
  readonly exitedAt: string | null;
  readonly providerSessionId: string | null;
}

/** GET /sessions/:id — the session with every process it has held. */
export interface SessionDetail {
  readonly session: Session;
  readonly processes: ReadonlyArray<SessionProcess>;
  readonly currentAgent: SessionProcess | null;
}

/** Joining an existing worktree: the new session becomes another conversation inside it. */
export interface WorktreeJoin {
  readonly name: string;
}

export interface SessionLocation {
  readonly project: Project;
  readonly session: Session;
  readonly worktreePath: string;
}

/** GET /workspace-ssh — the gateway plus the signed-in user's registered keys. */
export interface WorkspaceSshView {
  readonly gateway: {
    readonly host: string;
    readonly port: number;
    readonly usernamePrefix: string;
  } | null;
  readonly keys: ReadonlyArray<{
    readonly sshKeyId: string;
    readonly name: string;
    readonly fingerprint: string;
  }>;
}
