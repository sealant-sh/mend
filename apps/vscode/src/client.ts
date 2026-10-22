import { setTimeout as wait } from "node:timers/promises";

import type { AgentRequestResponse } from "@mend/agent-conversation";
import * as vscode from "vscode";

import {
  isRecord,
  stringField,
  parseProject,
  parseSession,
  parseArray,
  parseHarnessModelCatalog,
  parseProjectDetail,
  parseSessionProcess,
  parsePendingRequest,
  parseLanding,
  parseEventPointer,
  parseSessionDetail,
  type PendingRequest,
  type StreamSignal,
} from "./client-data.js";
import type { ConnectionStore, HeldConnection, MendConnection } from "./config.js";
import { MendApiError, requestMend } from "./mend-http.js";
import type { CreateRequest } from "./new-session.js";
import {
  parseMembers,
  parseRetirement,
  parseWaitLine,
  type MemberName,
  type RetirementView,
} from "./session-lines.js";
import type { LandingFact } from "./session-model.js";
import type {
  Project,
  ProjectDetail,
  Session,
  SessionDetail,
  SessionProcess,
  HarnessModelCatalog,
  LaunchStart,
  LaunchExpected,
  WorkspaceSshView,
} from "./types.js";
export type { PendingRequest, StreamSignal, EventPointer } from "./client-data.js";
export { MendApiError } from "./mend-http.js";

/**
 * The event stream sends a comment heartbeat every 25 seconds (apps/api/src/routes/events.ts); a
 * stream silent for longer than two of them is treated as gone and opened again.
 */
export const EVENT_STREAM_STALL_MS = 60_000;

/** Small authenticated client for the extension's project and session jobs. */
export class MendClient {
  readonly #accounts = new Map<string, string>();

  constructor(private readonly connections: Pick<ConnectionStore, "get" | "refused" | "held">) {}

  async connection(): Promise<MendConnection> {
    return this.connections.get();
  }

  held(): Promise<HeldConnection> {
    return this.connections.held();
  }

  /** The same client, each request made on the connection `connect` gives when it starts. */
  pinned(connect: () => Promise<MendConnection>): MendClient {
    return new MendClient({
      get: connect,
      refused: (connection) => this.connections.refused(connection),
      held: () => this.connections.held(),
    });
  }

  /** A refused token is dropped wherever it was met, before its caller says so. */
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const connection = await this.connections.get();
    try {
      return await requestMend(connection, path, init);
    } catch (cause) {
      if (cause instanceof MendApiError && cause.status === 401) this.refused(connection);
      throw cause;
    }
  }

  /** Mend refused this connection's token: it is dropped, as every reader of Mend drops it. */
  refused({ url, token }: MendConnection): void {
    if (token !== null) void this.connections.refused({ url, token });
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
  async createSession(projectId: string, request: CreateRequest): Promise<Session> {
    return parseSession(
      await this.post(`/projects/${encodeURIComponent(projectId)}/sessions`, request),
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

  /**
   * The account `connection`'s token belongs to, read through that connection; null when Mend
   * could not say. A token never changes account, so an answer is kept per server and token. Mend's
   * refusal of the token (401) is thrown, the token dropped first: VS Code is signed out.
   */
  async accountOf(connection: MendConnection): Promise<string | null> {
    const key = JSON.stringify([connection.url, connection.token]);
    const known = this.#accounts.get(key);
    if (known !== undefined) return known;
    try {
      const view = await requestMend(connection, "/organization");
      const account = isRecord(view) && typeof view["userId"] === "string" ? view["userId"] : null;
      if (account !== null) this.#accounts.set(key, account);
      return account;
    } catch (cause) {
      if (!(cause instanceof MendApiError && cause.status === 401)) return null;
      this.refused(connection);
      throw cause;
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

  async launchSession(
    sessionId: string,
    start: LaunchStart & { readonly expected?: LaunchExpected },
  ): Promise<Session> {
    return parseSession(
      await this.post(`/sessions/${encodeURIComponent(sessionId)}/launch`, start),
    );
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
   * Mend's mode switch: the same conversation continues in a terminal (`pty`) or as a
   * conversation (`protocol`). A harness that cannot is refused with HTTP 422.
   */
  async switchMode(sessionId: string, to: "pty" | "protocol"): Promise<Session> {
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
    // The server filters only on `pending=1`: any other value lists answered requests too.
    return parseArray(
      await this.request(`/sessions/${encodeURIComponent(sessionId)}/requests?pending=1`),
      parsePendingRequest,
      "requests",
    ).filter((request) => request !== null);
  }

  /** Answers a conversation's request: a decision, or answers to its questions. */
  async respond(requestId: string, response: AgentRequestResponse): Promise<void> {
    await this.post(`/requests/${encodeURIComponent(requestId)}/respond`, response);
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
