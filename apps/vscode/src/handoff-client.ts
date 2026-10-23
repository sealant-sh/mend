import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type { AgentRequestResponse } from "@mend/agent-conversation";
import {
  GitAuthMode,
  HANDOFF_PROBE_PROJECT,
  readReceiveAnswer,
  readTermsAnswer,
  takesHandoffs,
  type WireAnswer,
} from "@mend/domain/workbench";
import { startAgentShare, type AgentShareHandle } from "@mend/local-git/agent-share";
import { Schema } from "effect";

import {
  isRecord,
  parseArray,
  parsePendingRequests,
  parseProject,
  parseSession,
  parseSessionDetail,
  parseWorktree,
  type PendingRequest,
} from "./client-data.js";
import type { HeldConnection, MendConnection } from "./config.js";
import { failureWords } from "./failure-words.js";
import type { HandoffBundle } from "./handoff-worker.js";
import { ConnectionChanged } from "./launches.js";
import { MendApiError, requestMend, uploadMendBundle } from "./mend-http.js";
import type { CreateRequest, LaunchRequest } from "./new-session.js";
import type { LaunchExpected, Project, ReceivedHandoff, Session, SessionDetail } from "./types.js";

export type HandoffProject = Project & { readonly gitAuthMode: GitAuthMode };
export type HandoffSupport = "checking" | "supported" | "unsupported" | "unavailable";
export interface HandoffTerms {
  readonly bundleBytes: number;
  readonly fileBytes: number;
}
export type HandoffIssue =
  | {
      readonly kind:
        | "unsupported"
        | "adoption-terms-unsupported"
        | "signed-out"
        | "server-changed"
        | "bridge-unavailable";
    }
  | { readonly kind: "bundle-too-large"; readonly bytes: number; readonly limit: number }
  | { readonly kind: "proxy-too-small"; readonly bytes: number }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly reason: string | null;
      readonly budget: string | null;
      readonly limit: number | null;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly kind: "unavailable"; readonly message: string };
export type HandoffReceipt = ReceivedHandoff & {
  readonly replayed: boolean;
  readonly previous: string | null;
};
export type ReceiveOutcome =
  | { readonly kind: "received"; readonly receipt: HandoffReceipt }
  | { readonly kind: "refused"; readonly issue: HandoffIssue }
  | { readonly kind: "unconfirmed" };
export type TermsOutcome =
  | { readonly kind: "terms"; readonly terms: HandoffTerms }
  | { readonly kind: "refused"; readonly issue: HandoffIssue };

const textField = (body: unknown, key: string): string | null =>
  isRecord(body) && typeof body[key] === "string" ? body[key] : null;
const isGitAuthMode = Schema.is(GitAuthMode);
const parseHandoffProject = (value: unknown): HandoffProject => {
  const gitAuthMode = isRecord(value) ? value["gitAuthMode"] : null;
  if (!isGitAuthMode(gitAuthMode))
    throw new Error("Mend returned a project without its Git access mode.");
  return { ...parseProject(value), gitAuthMode };
};
const refusal = (answer: WireAnswer, retryAfterSeconds: number | null = null): HandoffIssue => {
  if (answer.status === 401) return { kind: "signed-out" };
  if (answer.status === null)
    return { kind: "unavailable", message: "Mend did not answer. Try again when it is connected." };
  const limit = isRecord(answer.body) ? answer.body["limit"] : null;
  return {
    kind: "refused",
    message: failureWords(answer.status, answer.body).words,
    reason: textField(answer.body, "reason"),
    budget: textField(answer.body, "budget"),
    limit: typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : null,
    retryAfterSeconds,
  };
};

export interface HandoffClient {
  readonly label: string;
  readonly account: string;
  isCurrent(): Promise<boolean>;
  support(): Promise<HandoffSupport>;
  listProjects(): Promise<ReadonlyArray<HandoffProject>>;
  adoptProject(name: string, source: string): Promise<HandoffProject>;
  handoffTerms(projectId: string | null): Promise<TermsOutcome>;
  receiveBranchHandoff(
    projectId: string,
    bundle: HandoffBundle,
    finished: () => void,
  ): Promise<ReceiveOutcome>;
  /** Her account's default git mode, the one an adoption gives; null when Mend could not say. */
  accountGitAuthMode(): Promise<GitAuthMode | null>;
  shareAgent(): Promise<AgentShareHandle | null>;
  sessionDetail(id: string): Promise<SessionDetail>;
  launchSession(
    id: string,
    request: LaunchRequest & { readonly expected?: LaunchExpected },
  ): Promise<Session>;
}

export class BoundClient implements HandoffClient {
  readonly url: string;
  readonly label: string;
  readonly account: string;
  private readonly connection: MendConnection;
  #signedOut = false;
  /** Each write checks `held.current()` as it is sent: nothing is posted after a switch or sign-out. */
  constructor(
    private readonly held: HeldConnection,
    private readonly current: () => Promise<MendConnection>,
    private readonly refused: (connection: MendConnection) => void,
  ) {
    const { connection } = held;
    this.connection = connection;
    this.url = connection.url;
    this.label = new URL(connection.url).host;
    this.account = createHash("sha256")
      .update(`${connection.url}\n${connection.token ?? ""}`)
      .digest("hex");
  }

  async isCurrent(): Promise<boolean> {
    if (!this.held.current()) return false;
    const current = await this.current();
    return current.url === this.connection.url && current.token === this.connection.token;
  }
  async #available(): Promise<boolean> {
    const current = await this.current();
    if (
      this.connection.token !== null &&
      current.url === this.connection.url &&
      current.token === null
    )
      this.#signedOut = true;
    return !this.#signedOut;
  }
  async #request(route: string, payload?: unknown): Promise<unknown> {
    if (!(await this.#available())) throw new MendApiError("Signed out — sign in again.", 401);
    if (payload !== undefined && !this.held.current()) throw new ConnectionChanged();
    try {
      return await requestMend(
        this.connection,
        route,
        payload === undefined
          ? { redirect: "error" }
          : { method: "POST", body: JSON.stringify(payload), redirect: "error" },
        // An origin URL can carry its owner's credential, and adoption errors quote the origin.
        { logFailure: false },
      );
    } catch (error) {
      if (error instanceof MendApiError && error.status === 401) this.#refuse();
      throw error;
    }
  }
  #refuse(): void {
    this.#signedOut = true;
    this.refused(this.connection);
  }
  async #answer(route: string): Promise<WireAnswer> {
    try {
      return { status: 200, body: await this.#request(route) };
    } catch (cause) {
      return cause instanceof MendApiError
        ? { status: cause.status, body: cause.body }
        : { status: null, body: null };
    }
  }
  async support(): Promise<HandoffSupport> {
    const result = takesHandoffs(await this.#answer(`/projects/${HANDOFF_PROBE_PROJECT}/handoffs`));
    return result === true ? "supported" : result === false ? "unsupported" : "unavailable";
  }
  async listProjects(): Promise<ReadonlyArray<HandoffProject>> {
    return parseArray(await this.#request("/projects"), parseHandoffProject, "projects");
  }
  async adoptProject(name: string, source: string): Promise<HandoffProject> {
    return parseHandoffProject(await this.#request("/projects", { name, source }));
  }
  async handoffTerms(projectId: string | null): Promise<TermsOutcome> {
    const answer = readTermsAnswer(
      await this.#answer(
        projectId === null ? "/handoffs" : `/projects/${encodeURIComponent(projectId)}/handoffs`,
      ),
    );
    switch (answer._tag) {
      case "terms":
        return {
          kind: "terms",
          terms: { bundleBytes: answer.bundleBytes, fileBytes: answer.fileBytes },
        };
      case "oldServer":
        return {
          kind: "refused",
          issue: { kind: projectId === null ? "adoption-terms-unsupported" : "unsupported" },
        };
      case "unreadable":
        return {
          kind: "refused",
          issue: {
            kind: "unavailable",
            message: "Mend did not return readable handoff limits. Try again.",
          },
        };
      case "refused":
        return { kind: "refused", issue: refusal(answer.answer) };
    }
  }
  async receiveBranchHandoff(
    projectId: string,
    bundle: HandoffBundle,
    finished: () => void,
  ): Promise<ReceiveOutcome> {
    if (!(await this.#available())) return { kind: "refused", issue: { kind: "signed-out" } };
    if (!this.held.current()) return { kind: "refused", issue: { kind: "server-changed" } };
    const raw = await uploadMendBundle(
      this.connection,
      `/projects/${encodeURIComponent(projectId)}/handoffs?harness=claude&hold=true`,
      bundle,
      finished,
    );
    if (raw.status === 401) this.#refuse();
    const answer = readReceiveAnswer(raw);
    switch (answer._tag) {
      case "received": {
        try {
          if (!isRecord(answer.body) || typeof answer.body["replayed"] !== "boolean")
            return { kind: "unconfirmed" };
          const session = parseSession(answer.body["session"]);
          const worktree = parseWorktree(answer.body["worktree"]);
          const previous = answer.body["previous"];
          if (
            session.projectId !== projectId ||
            session.worktreeId !== worktree.id ||
            worktree.handoff === null ||
            (previous !== null && (!isRecord(previous) || typeof previous["name"] !== "string"))
          )
            return { kind: "unconfirmed" };
          return {
            kind: "received",
            receipt: {
              session,
              worktree,
              replayed: answer.body["replayed"],
              previous: textField(previous, "name"),
            },
          };
        } catch {
          return { kind: "unconfirmed" };
        }
      }
      case "noAnswer":
        return { kind: "unconfirmed" };
      case "oldServer":
        return { kind: "refused", issue: { kind: "unsupported" } };
      case "tooLarge":
        return {
          kind: "refused",
          issue: { kind: "bundle-too-large", bytes: bundle.bytes, limit: answer.limit },
        };
      case "proxyRefused":
        return { kind: "refused", issue: { kind: "proxy-too-small", bytes: bundle.bytes } };
      case "refused":
        return { kind: "refused", issue: refusal(answer.answer, raw.retryAfterSeconds) };
    }
  }
  async accountGitAuthMode(): Promise<GitAuthMode | null> {
    const mode = textField(await this.#request("/me/git-access"), "mode");
    return isGitAuthMode(mode) ? mode : null;
  }
  async shareAgent(): Promise<AgentShareHandle | null> {
    const agentSock = process.env["SSH_AUTH_SOCK"];
    if (agentSock === undefined || agentSock === "") return null;
    return startAgentShare({
      agentSock,
      url: async () => {
        const ticket = textField(
          await this.#request("/upgrade-tickets", { target: "keys-bridge", host: hostname() }),
          "ticket",
        );
        if (ticket === null) throw new Error("Mend did not issue a ticket for the SSH agent.");
        const url = new URL(`${this.connection.url}/api/keys/bridge/ws`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("host", hostname());
        url.searchParams.set("ticket", ticket);
        return url;
      },
    });
  }
  async sessionDetail(id: string): Promise<SessionDetail> {
    return parseSessionDetail(await this.#request(`/sessions/${encodeURIComponent(id)}`));
  }
  async launchSession(
    id: string,
    request: LaunchRequest & { readonly expected?: LaunchExpected },
  ): Promise<Session> {
    return parseSession(await this.#request(`/sessions/${encodeURIComponent(id)}/launch`, request));
  }
  async createSession(projectId: string, request: CreateRequest): Promise<Session> {
    return parseSession(
      await this.#request(`/projects/${encodeURIComponent(projectId)}/sessions`, request),
    );
  }
  async pendingRequests(sessionId: string): Promise<ReadonlyArray<PendingRequest>> {
    return parsePendingRequests(
      await this.#request(`/sessions/${encodeURIComponent(sessionId)}/requests?pending=1`),
    );
  }
  async respond(requestId: string, response: AgentRequestResponse): Promise<void> {
    await this.#request(`/requests/${encodeURIComponent(requestId)}/respond`, response);
  }
}
