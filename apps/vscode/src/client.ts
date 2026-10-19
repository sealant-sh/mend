import { setTimeout as wait } from "node:timers/promises";

import * as vscode from "vscode";

import type { ConnectionStore, MendConnection } from "./config.js";
import { requestMend } from "./mend-http.js";
import {
  parseLivePeople,
  parseRetirementState,
  parseMembers,
  parseRetirement,
  parseWaitLine,
  type MemberName,
  type RetirementView,
} from "./session-lines.js";
import type { LandingFact } from "./session-model.js";
import {
  SESSION_STATUSES,
  type Effort,
  type HarnessModelCatalog,
  type LaunchStart,
  type Project,
  type ProjectDetail,
  type Session,
  type SessionDetail,
  type SessionProcess,
  type SessionStatus,
  type AgentWaitView,
  type WorkspaceSshView,
  type Worktree,
  type ProjectResolution,
  type RepositoryFacts,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: Record<string, unknown>, field: string): string => {
  const found = value[field];
  if (typeof found !== "string") throw new Error(`Mend returned an invalid ${field}.`);
  return found;
};

const nullableStringField = (value: Record<string, unknown>, field: string): string | null => {
  const found = value[field];
  if (found === null) return null;
  if (typeof found !== "string") throw new Error(`Mend returned an invalid ${field}.`);
  return found;
};

const parseProject = (value: unknown): Project => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid project.");
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    originUrl: nullableStringField(value, "originUrl"),
    storePath: stringField(value, "storePath"),
    defaultBranch: stringField(value, "defaultBranch"),
  };
};

const parseSessionStatus = (value: unknown): SessionStatus => {
  const status = SESSION_STATUSES.find((candidate) => candidate === value);
  if (status !== undefined) return status;
  throw new Error("Mend returned an invalid session status.");
};

const parseSession = (value: unknown): Session => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session.");
  return {
    id: stringField(value, "id"),
    projectId: stringField(value, "projectId"),
    // Present once the server is worktree-aware; older servers omit it.
    ...(typeof value["worktreeId"] === "string" ? { worktreeId: value["worktreeId"] } : {}),
    harness: stringField(value, "harness"),
    // Recorded since the server owns the model catalog; older servers omit it.
    model: typeof value["model"] === "string" ? value["model"] : null,
    label: nullableStringField(value, "label"),
    worktree: stringField(value, "worktree"),
    branch: stringField(value, "branch"),
    status: parseSessionStatus(value["status"]),
    // Tolerant: an older server may omit the field; editor open can resume to obtain an id.
    sealantWorkspaceId:
      typeof value["sealantWorkspaceId"] === "string" ? value["sealantWorkspaceId"] : null,
    summary: typeof value["summary"] === "string" ? value["summary"] : null,
    createdAt: stringField(value, "createdAt"),
    settledAt: typeof value["settledAt"] === "string" ? value["settledAt"] : null,
    ownerUserId: typeof value["ownerUserId"] === "string" ? value["ownerUserId"] : null,
    livePeople: parseLivePeople(value["livePeople"]),
    sharedControlEnabledAt:
      typeof value["sharedControlEnabledAt"] === "string" ? value["sharedControlEnabledAt"] : null,
    workspaceRetirement: parseRetirementState(value["workspaceRetirement"]),
    workspaceLauncherUserId:
      typeof value["workspaceLauncherUserId"] === "string"
        ? value["workspaceLauncherUserId"]
        : null,
  };
};

const parseArray = <T>(
  value: unknown,
  parse: (item: unknown) => T,
  label: string,
): ReadonlyArray<T> => {
  if (!Array.isArray(value)) throw new Error(`Mend returned invalid ${label}.`);
  return value.map(parse);
};

const EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max", "ultra"];

const parseEfforts = (value: unknown): ReadonlyArray<Effort> => {
  if (!Array.isArray(value)) throw new Error("Mend returned invalid efforts.");
  return value.map((item) => {
    const effort = EFFORTS.find((candidate) => candidate === item);
    if (effort === undefined) throw new Error("Mend returned an invalid effort.");
    return effort;
  });
};

const parseHarnessModelCatalog = (value: unknown): HarnessModelCatalog => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid model catalog.");
  return {
    harness: stringField(value, "harness"),
    models: parseArray(
      value["models"],
      (item) => {
        if (!isRecord(item)) throw new Error("Mend returned an invalid model.");
        return {
          id: stringField(item, "id"),
          label: stringField(item, "label"),
          isDefault: item["isDefault"] === true,
          efforts: item["efforts"] === null ? null : parseEfforts(item["efforts"]),
        };
      },
      "models",
    ),
    defaultModel: nullableStringField(value, "defaultModel"),
    efforts: parseEfforts(value["efforts"]),
    fastCapable: value["fastCapable"] === true,
  };
};

const parseWorktree = (value: unknown): Worktree => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid worktree.");
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    directory: stringField(value, "directory"),
    branch: stringField(value, "branch"),
    baseSha: stringField(value, "baseSha"),
    baseRef: nullableStringField(value, "baseRef"),
    createdAt: stringField(value, "createdAt"),
  };
};

const parseProjectDetail = (value: unknown): ProjectDetail => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid project detail.");
  return {
    project: parseProject(value["project"]),
    sessions: parseArray(value["sessions"], parseSession, "sessions"),
    // The worktree tier is the capability signal: absent on a pre-worktree server.
    ...(Array.isArray(value["worktrees"])
      ? { worktrees: parseArray(value["worktrees"], parseWorktree, "worktrees") }
      : {}),
  };
};

const parseSessionProcess = (value: unknown): SessionProcess => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session process.");
  const exitedAt = value["exitedAt"];
  return {
    id: stringField(value, "id"),
    kind: stringField(value, "kind"),
    harness: nullableStringField(value, "harness"),
    status: stringField(value, "status"),
    exitedAt: exitedAt === null || exitedAt === undefined ? null : String(exitedAt),
    providerSessionId: nullableStringField(value, "providerSessionId"),
    label: typeof value["label"] === "string" ? value["label"] : null,
    waiting: parseAgentWait(value["waiting"]),
  };
};

const WAIT_KINDS: ReadonlyArray<AgentWaitView["kind"]> = ["permission", "question", "prompt"];

/** A terminal agent's reported wait (G4); absent, malformed and older servers read as none. */
const parseAgentWait = (value: unknown): AgentWaitView | null => {
  if (!isRecord(value) || typeof value["since"] !== "string") return null;
  const kind = WAIT_KINDS.find((candidate) => candidate === value["kind"]);
  if (kind === undefined) return null;
  return {
    kind,
    tool: typeof value["tool"] === "string" ? value["tool"] : null,
    since: value["since"],
  };
};

/** A conversation's pending request, as much as the view says of it. */
export interface PendingRequest {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
}

const parsePendingRequest = (value: unknown): PendingRequest => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid request.");
  return {
    id: stringField(value, "id"),
    title: typeof value["title"] === "string" ? value["title"] : null,
    createdAt: stringField(value, "createdAt"),
  };
};

const LANDED_OUTCOMES: ReadonlySet<unknown> = new Set(["pushed", "pull-request", "adopted"]);
const PULL_REQUEST_STATES: ReadonlyArray<"open" | "closed" | "merged"> = [
  "open",
  "closed",
  "merged",
];

/** The newest landing that reached origin (or adopted a pull request); null when none did. */
const parseLanding = (value: unknown): LandingFact | null => {
  if (!isRecord(value) || !Array.isArray(value["landings"])) return null;
  for (const landing of value["landings"]) {
    if (!isRecord(landing) || !LANDED_OUTCOMES.has(landing["outcome"])) continue;
    const pullRequest = landing["pullRequest"];
    const state = isRecord(pullRequest)
      ? PULL_REQUEST_STATES.find((candidate) => candidate === pullRequest["state"])
      : undefined;
    return {
      id: stringField(landing, "id"),
      userId: stringField(landing, "userId"),
      createdAt: stringField(landing, "createdAt"),
      remoteBranch: stringField(landing, "remoteBranch"),
      pullRequest:
        isRecord(pullRequest) && typeof pullRequest["number"] === "number" && state !== undefined
          ? { number: pullRequest["number"], state }
          : null,
    };
  }
  return null;
};

/** What `/api/events` says changed: a pointer the store re-reads, never data. */
export interface EventPointer {
  readonly type: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  /** A `user` frame's part of the account: `access` when it was removed or lost its sign-in. */
  readonly facet: string | null;
}

const parseEventPointer = (data: string): EventPointer | null => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return null;
  return {
    type: value["type"],
    sessionId: typeof value["sessionId"] === "string" ? value["sessionId"] : null,
    projectId: typeof value["projectId"] === "string" ? value["projectId"] : null,
    facet: typeof value["facet"] === "string" ? value["facet"] : null,
  };
};

/** What the event stream tells its subscriber. */
export type StreamSignal =
  /** A stream opened: whatever changed while none was open was never announced. */
  | { readonly kind: "opened" }
  /** Any bytes, the heartbeat included: Mend was heard now. */
  | { readonly kind: "heard" }
  | { readonly kind: "event"; readonly event: EventPointer }
  /** Mend itself refused the stream's sign-in (401 or 403): it answers, but not to this sign-in. */
  | { readonly kind: "refused" }
  /** The stream failed or went quiet past the heartbeat; it is tried again. */
  | { readonly kind: "lost" };

const parseSessionDetail = (value: unknown): SessionDetail => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session detail.");
  const currentAgent = value["currentAgent"];
  const change = value["change"];
  return {
    session: parseSession(value["session"]),
    processes: parseArray(value["processes"], parseSessionProcess, "processes"),
    currentAgent:
      currentAgent === null || currentAgent === undefined
        ? null
        : parseSessionProcess(currentAgent),
    changeId: isRecord(change) && typeof change["id"] === "string" ? change["id"] : null,
  };
};

export { MendApiError } from "./mend-http.js";

/**
 * The event stream sends a comment heartbeat every 25 seconds (apps/api/src/routes/events.ts); a
 * stream silent for longer than two of them is treated as gone and opened again.
 */
export const EVENT_STREAM_STALL_MS = 60_000;

/** Small authenticated client for the extension's project and session jobs. */
export class MendClient {
  constructor(private readonly connections: ConnectionStore) {}

  async connection(): Promise<MendConnection> {
    return this.connections.get();
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    return requestMend(await this.connections.get(), path, init);
  }

  private post(path: string, payload: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(payload) });
  }

  async listProjects(): Promise<ReadonlyArray<Project>> {
    return parseArray(await this.request("/projects"), parseProject, "projects");
  }

  /** The server-owned model catalog (docs/models-audit.md): what the new-session picks offer. */
  async harnessModels(): Promise<ReadonlyArray<HarnessModelCatalog>> {
    return parseArray(
      await this.request("/harnesses/models"),
      parseHarnessModelCatalog,
      "model catalogs",
    );
  }

  async projectDetail(id: string): Promise<ProjectDetail> {
    return parseProjectDetail(await this.request(`/projects/${encodeURIComponent(id)}`));
  }

  /**
   * Create a session. `name` joins the worktree of that name when it exists (a new
   * conversation inside it; the server refuses a conflicting base) and otherwise creates it;
   * null derives an anonymous worktree.
   */
  async createSession(
    projectId: string,
    harness: string,
    label: string | null,
    base: string | null,
    name: string | null = null,
  ): Promise<Session> {
    return parseSession(
      await this.post(`/projects/${encodeURIComponent(projectId)}/sessions`, {
        harness,
        label,
        base,
        name,
      }),
    );
  }

  /** The signed-in account's id; null from a server before organizations. */
  async viewerId(): Promise<string | null> {
    try {
      const view = await this.request("/organization");
      return isRecord(view) && typeof view["userId"] === "string" ? view["userId"] : null;
    } catch {
      return null;
    }
  }

  /** The organization's roster by id and name; empty when the server cannot say. */
  async memberNames(): Promise<ReadonlyArray<MemberName>> {
    try {
      return parseMembers(await this.request("/organization/members"));
    } catch {
      return [];
    }
  }

  /** The waiting line while a turn waits for another person's work; null otherwise. */
  async waitLine(sessionId: string): Promise<string | null> {
    try {
      return parseWaitLine(
        await this.request(`/sessions/${encodeURIComponent(sessionId)}/waiting`),
      );
    } catch {
      return null;
    }
  }

  /** The session's executor waiting to be replaced (docs/adr/0016, decision 14); null otherwise. */
  async workspaceRetirement(sessionId: string): Promise<RetirementView | null> {
    try {
      return parseRetirement(
        await this.request(`/sessions/${encodeURIComponent(sessionId)}/workspace-retirement`),
      );
    } catch {
      return null;
    }
  }

  /** The session with every process it has held — agents, shells, Services. */
  async sessionDetail(sessionId: string): Promise<SessionDetail> {
    return parseSessionDetail(await this.request(`/sessions/${encodeURIComponent(sessionId)}`));
  }

  /**
   * Open a shell in the live workspace. Its process row holds the workspace lease, so the
   * workspace stays up while the shell runs.
   */
  async openShell(sessionId: string): Promise<SessionProcess> {
    return parseSessionProcess(
      await this.post(`/sessions/${encodeURIComponent(sessionId)}/shell`, {}),
    );
  }

  async launchSession(sessionId: string, start: LaunchStart): Promise<Session> {
    return parseSession(
      await this.post(`/sessions/${encodeURIComponent(sessionId)}/launch`, start),
    );
  }

  /**
   * Follow a launch the server answered while it was still under way (`starting`: it waits for the
   * worktree's previous session to save, builds the workspace image, boots): each new session
   * line goes to `onLine` until the session runs. A launch that settles instead fails with its
   * own words.
   */
  async untilStarted(
    session: Session,
    onLine: (line: string) => void,
    options: { readonly intervalMs?: number; readonly limitMs?: number } = {},
  ): Promise<Session> {
    const intervalMs = options.intervalMs ?? 3000;
    const deadline = Date.now() + (options.limitMs ?? 40 * 60 * 1000);
    let current = session;
    let said: string | null = null;
    while (current.status === "starting") {
      const line = current.summary === null ? "starting" : `starting · ${current.summary}`;
      if (line !== said) onLine(line);
      said = line;
      if (Date.now() >= deadline) throw new Error(`the session is still ${line}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      current = (await this.sessionDetail(current.id)).session;
    }
    if (current.status === "failed" || current.status === "stopped") {
      throw new Error(current.summary === null ? `the session ${current.status}` : current.summary);
    }
    return current;
  }

  async stopSession(sessionId: string): Promise<Session> {
    return parseSession(await this.post(`/sessions/${encodeURIComponent(sessionId)}/stop`, {}));
  }

  /** Rejoin a settled session. `harness` "shell" opens the workbench without launching an agent. */
  async resumeSession(sessionId: string, harness: string | null): Promise<Session> {
    return parseSession(
      await this.post(`/sessions/${encodeURIComponent(sessionId)}/resume`, { harness }),
    );
  }

  /**
   * Mend's mode handoff: the same conversation continues in a terminal (`pty`) or as a
   * conversation (`protocol`). A harness that cannot is refused with HTTP 422.
   */
  async handoff(sessionId: string, to: "pty" | "protocol"): Promise<Session> {
    return parseSession(
      await this.post(`/sessions/${encodeURIComponent(sessionId)}/handoff`, { to }),
    );
  }

  /** The workspace SSH gateway plus the signed-in user's registered keys. */
  async workspaceSsh(): Promise<WorkspaceSshView> {
    const value = await this.request("/workspace-ssh");
    if (!isRecord(value)) throw new Error("Mend returned an invalid workspace-ssh view.");
    const gateway = value["gateway"];
    const keys = value["keys"];
    if (!Array.isArray(keys)) throw new Error("Mend returned invalid workspace SSH keys.");
    let parsedGateway: WorkspaceSshView["gateway"] = null;
    if (gateway !== null) {
      if (!isRecord(gateway)) {
        throw new Error("Mend returned invalid workspace SSH gateway metadata.");
      }
      const host = gateway["host"];
      const port = gateway["port"];
      const usernamePrefix = gateway["usernamePrefix"];
      if (
        typeof host !== "string" ||
        host === "" ||
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        typeof usernamePrefix !== "string" ||
        !/^[a-zA-Z0-9._-]+$/.test(usernamePrefix)
      ) {
        throw new Error("Mend returned invalid workspace SSH gateway metadata.");
      }
      parsedGateway = { host, port, usernamePrefix };
    }
    return {
      gateway: parsedGateway,
      keys: keys.map((key) => {
        if (!isRecord(key)) throw new Error("Mend returned an invalid workspace SSH key.");
        return {
          sshKeyId: stringField(key, "sshKeyId"),
          name: stringField(key, "name"),
          fingerprint: stringField(key, "fingerprint"),
        };
      }),
    };
  }

  /** Offer this machine's SSH public key under the signed-in user; idempotent per owner. */
  async ensureWorkspaceSshKey(publicKey: string, name: string): Promise<void> {
    await this.post("/workspace-ssh/keys", { publicKey, name });
  }

  async adoptProject(name: string, source: string): Promise<Project> {
    return parseProject(await this.post("/projects", { name, source }));
  }

  /** A conversation's requests still waiting for an answer. */
  async pendingRequests(sessionId: string): Promise<ReadonlyArray<PendingRequest>> {
    return parseArray(
      await this.request(`/sessions/${encodeURIComponent(sessionId)}/requests?pending=true`),
      parsePendingRequest,
      "requests",
    );
  }

  /** The session's newest landing that reached origin; null when none did. */
  async landing(sessionId: string): Promise<LandingFact | null> {
    return parseLanding(await this.request(`/sessions/${encodeURIComponent(sessionId)}/landings`));
  }

  subscribe(onSignal: (signal: StreamSignal) => void): vscode.Disposable {
    const controller = new AbortController();
    void this.eventLoop(controller.signal, onSignal);
    return new vscode.Disposable(() => controller.abort());
  }

  private async eventLoop(
    signal: AbortSignal,
    onSignal: (signal: StreamSignal) => void,
  ): Promise<void> {
    let delay = 1_000;
    while (!signal.aborted) {
      // One stream per attempt. A stream that goes quiet past the heartbeat is dead (a Mac mini
      // asleep, a laptop that changed networks): nothing closes it, so the watchdog does.
      const attempt = new AbortController();
      const abortAttempt = () => attempt.abort();
      signal.addEventListener("abort", abortAttempt, { once: true });
      let watchdog: NodeJS.Timeout | undefined;
      // A server that answers, even with a refusal, is reachable: only silence reads as lost.
      let refused = false;
      const feed = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(abortAttempt, EVENT_STREAM_STALL_MS);
      };
      try {
        const connection = await this.connections.get();
        const headers = new Headers({ accept: "text/event-stream" });
        if (connection.token !== null) headers.set("authorization", `Bearer ${connection.token}`);
        feed();
        const response = await fetch(`${connection.url}/api/events`, {
          headers,
          signal: attempt.signal,
        });
        if (!response.ok || response.body === null) {
          // A refused token comes from Mend itself; a 502 from an edge in front of it does not.
          refused = response.status === 401 || response.status === 403;
          if (refused) onSignal({ kind: "refused" });
          throw new Error(`events responded ${response.status}`);
        }
        delay = 1_000;
        onSignal({ kind: "opened" });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!attempt.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          feed();
          onSignal({ kind: "heard" });
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const data = buffer
              .slice(0, boundary)
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            buffer = buffer.slice(boundary + 2);
            const event = data === "" ? null : parseEventPointer(data);
            if (event !== null) onSignal({ kind: "event", event });
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) return;
      } finally {
        if (!signal.aborted && !refused) onSignal({ kind: "lost" });
        clearTimeout(watchdog);
        signal.removeEventListener("abort", abortAttempt);
        attempt.abort();
      }
      await wait(delay, undefined, { signal }).catch(() => undefined);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

const normalizeRemoteUrl = (raw: string | null): string | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/\s:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const parts = url ?? scp;
  if (parts === null) return null;
  const host = parts[1];
  const rest = parts[2];
  if (host === undefined || rest === undefined) return null;
  return `${host.toLowerCase()}/${rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase()}`;
};

export const normalizeProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug === "" ? "project" : slug.slice(0, 64);
};

const normalizePath = (value: string): string | null => {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return trimmed === "" || trimmed.includes("://") ? null : trimmed;
};

const sameOrInside = (candidate: string, root: string): boolean => {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedCandidate !== null &&
    normalizedRoot !== null &&
    (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`))
  );
};

/** Which adopted project a local folder is a clone of: its origin URL, then its name, then its path. */
export const matchProject = (
  projects: ReadonlyArray<Project>,
  facts: RepositoryFacts,
): ProjectResolution => {
  const normalizedOrigin = normalizeRemoteUrl(facts.originUrl);
  const byRemote =
    normalizedOrigin === null
      ? undefined
      : projects.find((project) => normalizeRemoteUrl(project.originUrl) === normalizedOrigin);
  if (byRemote !== undefined) return { status: "matched", project: byRemote, matchedBy: "origin" };

  const normalizedName = normalizeProjectName(facts.folder);
  const byName = projects.find((project) => project.name === normalizedName);
  if (byName !== undefined) return { status: "matched", project: byName, matchedBy: "folder-name" };

  const byPath = projects.filter((project) => {
    if (
      project.originUrl !== null &&
      normalizePath(project.originUrl) !== null &&
      sameOrInside(facts.path, project.originUrl)
    ) {
      return true;
    }
    const store = normalizePath(project.storePath);
    if (store === null) return false;
    const separator = store.lastIndexOf("/");
    return separator > 0 && sameOrInside(facts.path, store.slice(0, separator));
  });
  if (byPath.length === 1 && byPath[0] !== undefined) {
    return { status: "matched", project: byPath[0], matchedBy: "path" };
  }
  if (byPath.length > 1) return { status: "ambiguous", candidates: byPath, matchedBy: "path" };
  return { status: "not-found" };
};
