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
import {
  SESSION_STATUSES,
  type Effort,
  type HarnessModelCatalog,
  type LaunchStart,
  type Project,
  type ProjectDetail,
  type ProjectResolution,
  type RepositoryFacts,
  type Session,
  type SessionDetail,
  type SessionProcess,
  type SessionStatus,
  type WorkspaceSshView,
  type Worktree,
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
    ownerUserId: typeof value["ownerUserId"] === "string" ? value["ownerUserId"] : null,
    livePeople: parseLivePeople(value["livePeople"]),
    sharedControlEnabledAt:
      typeof value["sharedControlEnabledAt"] === "string" ? value["sharedControlEnabledAt"] : null,
    workspaceRetirement: parseRetirementState(value["workspaceRetirement"]),
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
  };
};

const parseSessionDetail = (value: unknown): SessionDetail => {
  if (!isRecord(value)) throw new Error("Mend returned an invalid session detail.");
  const currentAgent = value["currentAgent"];
  return {
    session: parseSession(value["session"]),
    processes: parseArray(value["processes"], parseSessionProcess, "processes"),
    currentAgent:
      currentAgent === null || currentAgent === undefined
        ? null
        : parseSessionProcess(currentAgent),
  };
};

export { MendApiError } from "./mend-http.js";

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

  async resolveProject(facts: RepositoryFacts): Promise<ProjectResolution> {
    const projects = await this.listProjects();
    const normalizedOrigin = normalizeRemoteUrl(facts.originUrl);
    const byRemote =
      normalizedOrigin === null
        ? undefined
        : projects.find((project) => normalizeRemoteUrl(project.originUrl) === normalizedOrigin);
    if (byRemote !== undefined)
      return { status: "matched", project: byRemote, matchedBy: "origin" };

    const normalizedName = normalizeProjectName(facts.folder);
    const byName = projects.find((project) => project.name === normalizedName);
    if (byName !== undefined)
      return { status: "matched", project: byName, matchedBy: "folder-name" };

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
   * Open a shell in the live workspace. Its process row holds the workspace lease, which is
   * what lets a takeover stop the agent without the workspace closing under the editor.
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

  async findSession(
    sessionId: string,
  ): Promise<{ readonly project: Project; readonly session: Session } | null> {
    for (const project of await this.listProjects()) {
      const detail = await this.projectDetail(project.id);
      const session = detail.sessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) return { project, session };
    }
    return null;
  }

  subscribe(onEvent: () => void): vscode.Disposable {
    const controller = new AbortController();
    void this.eventLoop(controller.signal, onEvent);
    return new vscode.Disposable(() => controller.abort());
  }

  private async eventLoop(signal: AbortSignal, onEvent: () => void): Promise<void> {
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        const connection = await this.connections.get();
        const headers = new Headers({ accept: "text/event-stream" });
        if (connection.token !== null) headers.set("authorization", `Bearer ${connection.token}`);
        const response = await fetch(`${connection.url}/api/events`, { headers, signal });
        if (!response.ok || response.body === null)
          throw new Error(`events responded ${response.status}`);
        delay = 1_000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (message.split("\n").some((line) => line.startsWith("data:"))) onEvent();
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) return;
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
