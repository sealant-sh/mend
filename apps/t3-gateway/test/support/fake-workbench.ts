import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The workbench half of the fake Mend: projects, sessions, protocol turns, items and requests,
 * served in Mend's shapes (`ProjectDetail`, `AgentTurn`, `AgentItem`, `AgentRequest` in
 * @mend/api-contracts and @mend/domain), and `GET /api/events` pushing Mend's pointers. Every
 * change made through it emits the pointer Mend would, so a test reads like Mend's own behaviour.
 */

export interface FakeProcess {
  readonly id: string;
  readonly kind: "agent-protocol" | "agent-pty" | "shell";
  readonly harness: string | null;
  status: "starting" | "running" | "exited" | "stopped";
  readonly providerSessionId: string | null;
  readonly protocolOptions: {
    readonly model: string | null;
    readonly effort: string | null;
    readonly permissionMode: "bypass" | "ask";
  } | null;
  readonly createdAt: string;
  exitedAt: string | null;
}

export interface FakeSession {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly harness: string;
  readonly model: string | null;
  label: string | null;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef: string | null;
  status: string;
  readonly ownerUserId: string | null;
  summary: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface FakeTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly author: string | null;
  readonly origin: "request" | "harness";
  readonly input: string;
  status: "queued" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
  error: string | null;
  readonly createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface FakeItem {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  seq: number;
  readonly providerItemId: string;
  readonly kind: string;
  status: "in-progress" | "completed" | "failed" | "declined";
  title: string | null;
  text: string | null;
  data: unknown;
  readonly createdAt: string;
  updatedAt: string;
}

export interface FakeRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: string;
  readonly title: string | null;
  readonly detail: unknown;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string | null;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string | null;
    }>;
    readonly multiSelect: boolean;
  }> | null;
  status: "pending" | "resolved" | "cancelled";
  decision: string | null;
  answers: Record<string, ReadonlyArray<string>> | null;
  readonly createdAt: string;
  decidedAt: string | null;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

let clock = Date.parse("2026-10-04T09:00:00.000Z");
/** Strictly increasing timestamps, so ordering by time is ordering by creation. */
export const tick = (): string => new Date((clock += 1_000)).toISOString();

export class FakeWorkbench {
  readonly projects = new Map<string, { id: string; name: string; storePath: string }>();
  readonly sessions = new Map<string, FakeSession>();
  readonly agents = new Map<string, FakeProcess>();
  readonly changes = new Map<string, string>();
  readonly control = new Map<string, boolean>();
  readonly turns = new Map<string, Array<FakeTurn>>();
  readonly items = new Map<string, Array<FakeItem>>();
  readonly requests = new Map<string, Array<FakeRequest>>();
  readonly diffs = new Map<
    string,
    {
      readonly diff: string;
      readonly files: ReadonlyArray<{ path: string; additions: number; deletions: number }>;
    }
  >();
  readonly calls: Array<FakeCall> = [];
  private readonly streams = new Set<ServerResponse>();
  private seq = 0;
  private ids = 0;
  /** How long `GET /api/sessions/:id/requests` takes, to hold a read in flight. */
  requestsDelayMs = 0;
  /** `GET /api/projects` answers 502, as Mend does while it comes back from a restart. */
  projectsDown = false;
  /** Whether a launch brings the agent up at all (false: provisioning stalls, to fail it later). */
  launchBringsAgentUp = true;
  /** How long after a launch answers its new agent is running. */
  launchLiveDelayMs = 50;
  /** `POST /api/sessions/:id/turns` answers 401, as for a device revoked mid-flight. */
  turnsUnauthorized = false;
  /** `POST /turns` answers 409 though the row reads running (idle stop claimed, host not attached). */
  turnsNotLive = false;
  /**
   * Another client's launch is under way: `POST /launch` answers Mend's 422 with these words, the
   * session reads `starting`, and the agent comes up `launchLiveDelayMs` later.
   */
  launchRefusal: string | null = null;
  /** How long `POST /launch` takes to answer, and a status it then refuses with (null: it launches). */
  launchAnswerDelayMs = 0;
  launchFailStatus: number | null = null;

  get eventStreams(): number {
    return this.streams.size;
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  /** A Mend pointer to every open `GET /api/events`. */
  emit(pointer: Record<string, string>): void {
    const frame = `data: ${JSON.stringify(pointer)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  /** Ends every open event stream, as a Mend restart would. */
  dropStreams(): void {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  addProject(id: string, name: string): void {
    this.projects.set(id, { id, name, storePath: `/var/lib/mend/store/${id}/repo.git` });
    this.emit({ type: "project", projectId: id });
  }

  addSession(input: {
    readonly id: string;
    readonly projectId: string;
    readonly harness?: string;
    readonly label?: string | null;
    readonly kind?: FakeProcess["kind"];
    readonly permissionMode?: "bypass" | "ask";
    readonly live?: boolean;
    readonly steer?: boolean;
    readonly changeId?: string | null;
  }): FakeSession {
    const harness = input.harness ?? "codex";
    const createdAt = tick();
    const session: FakeSession = {
      id: input.id,
      projectId: input.projectId,
      worktreeId: `worktree-${input.id}`,
      harness,
      model: harness === "claude" ? "fable" : "gpt-6.1-sol",
      label: input.label === undefined ? null : input.label,
      worktree: `wt-${input.id}`,
      branch: `mend/wt-${input.id}`,
      baseSha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
      baseRef: "main",
      status: input.live === false ? "stopped" : "idle",
      ownerUserId: "user-1",
      summary: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.sessions.set(session.id, session);
    const kind = input.kind ?? "agent-protocol";
    this.agents.set(session.id, {
      id: this.nextId("process"),
      kind,
      harness,
      status: input.live === false ? "exited" : "running",
      providerSessionId: `provider-${input.id}`,
      protocolOptions:
        kind === "agent-protocol"
          ? { model: session.model, effort: null, permissionMode: input.permissionMode ?? "bypass" }
          : null,
      createdAt,
      exitedAt: input.live === false ? createdAt : null,
    });
    this.changes.set(
      session.id,
      input.changeId === undefined ? `change-${input.id}` : (input.changeId ?? ""),
    );
    this.control.set(session.id, input.steer ?? true);
    this.turns.set(session.id, []);
    this.items.set(session.id, []);
    this.requests.set(session.id, []);
    this.emit({ type: "session", sessionId: session.id, projectId: session.projectId });
    return session;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.emit({ type: "session", sessionId, projectId: session.projectId });
  }

  /** Provisioning fails after the launch answered, as Mend records it: failed, and why. */
  failSession(sessionId: string, summary: string): void {
    const agent = this.agents.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (agent === undefined || session === undefined) return;
    agent.status = "exited";
    agent.exitedAt = tick();
    session.status = "failed";
    session.summary = summary;
    session.updatedAt = tick();
    this.emit({ type: "session", sessionId, projectId: session.projectId });
  }

  /** The agent process ends, as the 15-minute idle stop ends it. */
  stopAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (agent === undefined || session === undefined) return;
    agent.status = "exited";
    agent.exitedAt = tick();
    session.status = "stopped";
    session.updatedAt = tick();
    this.emit({ type: "session-process", sessionId, projectId: session.projectId });
  }

  private conversationChanged(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.emit({ type: "agent-conversation", sessionId, projectId: session.projectId });
    }
  }

  addTurn(sessionId: string, input: string, status: FakeTurn["status"] = "running"): FakeTurn {
    const turns = this.turns.get(sessionId) ?? [];
    const createdAt = tick();
    const turn: FakeTurn = {
      id: this.nextId("turn"),
      sessionId,
      ordinal: turns.length,
      author: "user-1",
      origin: "request",
      input,
      status,
      error: null,
      createdAt,
      startedAt: status === "queued" ? null : createdAt,
      endedAt: status === "queued" || status === "running" ? null : createdAt,
    };
    turns.push(turn);
    this.turns.set(sessionId, turns);
    this.conversationChanged(sessionId);
    return turn;
  }

  setTurn(turn: FakeTurn, status: FakeTurn["status"], error: string | null = null): void {
    turn.status = status;
    turn.error = error;
    if (status !== "queued" && turn.startedAt === null) turn.startedAt = tick();
    if (status !== "queued" && status !== "running") turn.endedAt = tick();
    this.conversationChanged(turn.sessionId);
  }

  addItem(
    turn: FakeTurn,
    input: {
      readonly kind: string;
      readonly text?: string | null;
      readonly title?: string | null;
      readonly data?: unknown;
      readonly status?: FakeItem["status"];
    },
  ): FakeItem {
    const items = this.items.get(turn.sessionId) ?? [];
    const createdAt = tick();
    const item: FakeItem = {
      id: this.nextId("item"),
      sessionId: turn.sessionId,
      turnId: turn.id,
      seq: ++this.seq,
      providerItemId: this.nextId("provider-item"),
      kind: input.kind,
      status: input.status ?? "completed",
      title: input.title ?? null,
      text: input.text ?? null,
      data: input.data ?? null,
      createdAt,
      updatedAt: createdAt,
    };
    items.push(item);
    this.items.set(turn.sessionId, items);
    this.conversationChanged(turn.sessionId);
    return item;
  }

  updateItem(item: FakeItem, patch: Partial<Pick<FakeItem, "text" | "status" | "title">>): void {
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.title !== undefined) item.title = patch.title;
    item.seq = ++this.seq;
    item.updatedAt = tick();
    this.conversationChanged(item.sessionId);
  }

  addRequest(
    turn: FakeTurn,
    input: {
      readonly kind: string;
      readonly title?: string | null;
      readonly detail?: unknown;
      readonly questions?: FakeRequest["questions"];
    },
  ): FakeRequest {
    const requests = this.requests.get(turn.sessionId) ?? [];
    const request: FakeRequest = {
      id: this.nextId("request"),
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind: input.kind,
      title: input.title ?? null,
      detail: input.detail ?? null,
      questions: input.questions ?? null,
      status: "pending",
      decision: null,
      answers: null,
      createdAt: tick(),
      decidedAt: null,
    };
    requests.push(request);
    this.requests.set(turn.sessionId, requests);
    this.conversationChanged(turn.sessionId);
    return request;
  }

  /** Answers a route of the workbench, or false when the route is not one of them. */
  route(
    request: IncomingMessage,
    response: ServerResponse,
    body: () => Promise<unknown>,
    accepted: boolean,
  ): boolean | Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (!path.startsWith("/api/")) return false;
    const json = (status: number, value: unknown): true => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
      return true;
    };
    const known =
      path === "/api/projects" ||
      path === "/api/events" ||
      /^\/api\/(projects|sessions|turns|requests|changes)\//.test(path);
    if (!known) return false;
    if (!accepted) return json(401, { _tag: "Unauthorized" });

    const record = (value: unknown) => {
      this.calls.push({
        method,
        path,
        query: url.search,
        body: value,
        authorization: request.headers.authorization,
      });
    };

    if (method === "GET") record(undefined);
    if (method === "GET" && path === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(": ping\n\n");
      this.streams.add(response);
      request.on("close", () => this.streams.delete(response));
      return true;
    }
    if (method === "GET" && path === "/api/projects" && this.projectsDown) {
      return json(502, { _tag: "BadGateway" });
    }
    if (method === "GET" && path === "/api/projects") {
      return json(
        200,
        Array.from(this.projects.values(), (project) => this.projectView(project.id)),
      );
    }
    const segments = path.split("/").slice(2);
    const [collection, id, sub] = segments;
    if (collection === undefined || id === undefined) return json(404, { _tag: "NotFound" });

    if (method === "GET" && collection === "projects" && sub === undefined) {
      const project = this.projectView(id);
      if (project === null) return json(404, { _tag: "NotFound" });
      const sessions = Array.from(this.sessions.values()).filter((s) => s.projectId === id);
      return json(200, {
        project,
        sessions,
        hiddenEndedSessions: 0,
        annotations: sessions.map((session) => ({
          sessionId: session.id,
          changeId: this.changes.get(session.id) || null,
          openComments: 0,
          totalComments: 0,
          pendingFollowUp: false,
          currentAgent: this.agents.get(session.id) ?? null,
          liveServices: 0,
          pullRequest: null,
        })),
        worktrees: [],
        worktreeAnnotations: [],
      });
    }
    if (collection === "sessions") {
      const session = this.sessions.get(id);
      if (session === undefined) return json(404, { _tag: "NotFound" });
      if (method === "GET" && sub === undefined) {
        const changeId = this.changes.get(id) || null;
        return json(200, {
          session,
          control: {
            own: true,
            steer: this.control.get(id) ?? true,
            stop: true,
            toggleSharedControl: true,
          },
          checkpoints: [],
          change:
            changeId === null
              ? null
              : {
                  id: changeId,
                  projectId: session.projectId,
                  worktreeId: session.worktreeId,
                  sessionId: session.id,
                  branch: session.branch,
                  baseSha: session.baseSha,
                  headSha: "1111111111111111111111111111111111111111",
                  createdAt: session.createdAt,
                  updatedAt: session.updatedAt,
                },
          processes: [this.agents.get(id)].filter((agent) => agent !== undefined),
          currentAgent: this.agents.get(id) ?? null,
        });
      }
      if (method === "GET" && sub === "turns") return json(200, this.turns.get(id) ?? []);
      if (method === "GET" && sub === "requests") {
        const answer = this.requests.get(id) ?? [];
        if (this.requestsDelayMs === 0) return json(200, answer);
        return new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(json(200, answer)), this.requestsDelayMs),
        );
      }
      if (method === "GET" && sub === "items") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const changed = (this.items.get(id) ?? [])
          .filter((item) => item.seq > after)
          .toSorted((left, right) => left.seq - right.seq)
          .slice(0, limit);
        return json(200, changed);
      }
      if (method === "POST" && sub === "launch" && this.launchAnswerDelayMs > 0) {
        return body().then((value) => {
          record(value);
          return new Promise<boolean>((resolve) =>
            setTimeout(() => {
              const status = this.launchFailStatus;
              resolve(
                status === null
                  ? this.command(sub, session, value, json)
                  : json(status, { _tag: "StoreFailure", message: "launch refused" }),
              );
            }, this.launchAnswerDelayMs),
          );
        });
      }
      if (method === "POST" && (sub === "turns" || sub === "launch")) {
        return body().then((value) => {
          record(value);
          return this.command(sub, session, value, json);
        });
      }
    }
    if (method === "POST" && collection === "turns" && sub === "interrupt") {
      return body().then((value) => {
        record(value);
        for (const turns of this.turns.values()) {
          const turn = turns.find((candidate) => candidate.id === id);
          if (turn === undefined) continue;
          if (this.control.get(turn.sessionId) === false) {
            return json(403, {
              _tag: "SessionNotSteerable",
              sessionId: turn.sessionId,
              message: "not yours",
            });
          }
          this.setTurn(turn, "interrupted");
          return json(204, undefined);
        }
        return json(404, { _tag: "NotFound" });
      });
    }
    if (method === "POST" && collection === "requests" && sub === "respond") {
      return body().then((value) => {
        record(value);
        for (const requests of this.requests.values()) {
          const found = requests.find((candidate) => candidate.id === id);
          if (found === undefined) continue;
          if (found.status !== "pending") {
            return json(409, { _tag: "AgentRequestResolved", requestId: id });
          }
          const payload = typeof value === "object" && value !== null ? value : {};
          found.status = "resolved";
          found.decidedAt = tick();
          if ("decision" in payload && typeof payload.decision === "string") {
            found.decision = payload.decision;
          }
          if (
            "answers" in payload &&
            typeof payload.answers === "object" &&
            payload.answers !== null
          ) {
            found.answers = Object.fromEntries(
              Object.entries(payload.answers).map(([key, answers]) => [
                key,
                Array.isArray(answers) ? answers.map(String) : [],
              ]),
            );
          }
          this.conversationChanged(found.sessionId);
          return json(200, found);
        }
        return json(404, { _tag: "NotFound" });
      });
    }
    if (method === "GET" && collection === "changes" && sub === "diff") {
      const diff = this.diffs.get(id);
      if (diff === undefined) return json(404, { _tag: "NotFound" });
      const session = Array.from(this.sessions.values()).find(
        (candidate) => this.changes.get(candidate.id) === id,
      );
      return json(200, {
        change: {
          id,
          projectId: session?.projectId ?? "project",
          worktreeId: session?.worktreeId ?? "worktree",
          sessionId: session?.id ?? null,
          branch: session?.branch ?? "mend/branch",
          baseSha: session?.baseSha ?? "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
          headSha: "1111111111111111111111111111111111111111",
          createdAt: tick(),
          updatedAt: tick(),
        },
        diff: diff.diff,
        files: diff.files,
      });
    }
    return json(404, { _tag: "NotFound" });
  }

  private command(
    sub: "turns" | "launch",
    session: FakeSession,
    value: unknown,
    json: (status: number, value: unknown) => true,
  ): true {
    if (this.control.get(session.id) === false) {
      return json(403, {
        _tag: "SessionNotSteerable",
        sessionId: session.id,
        message: "not yours",
      });
    }
    const payload = typeof value === "object" && value !== null ? value : {};
    const agent = this.agents.get(session.id);
    if (sub === "turns") {
      if (this.turnsUnauthorized) return json(401, { _tag: "Unauthorized" });
      if (this.turnsNotLive) return json(409, { _tag: "ProtocolSessionNotLive", processId: "p" });
      if (agent === undefined || agent.exitedAt !== null || agent.status !== "running") {
        return json(409, { _tag: "ProtocolSessionNotLive", processId: agent?.id ?? "none" });
      }
      const input = "input" in payload && typeof payload.input === "string" ? payload.input : "";
      const open = (this.turns.get(session.id) ?? []).some(
        (turn) => turn.status === "queued" || turn.status === "running",
      );
      return json(200, this.addTurn(session.id, input, open ? "queued" : "running"));
    }
    // A launch answers at once; a new agent process comes up on the options the last one
    // recorded, and only a prompt would open a turn.
    const refusal = this.launchRefusal;
    if (refusal !== null) {
      this.launchRefusal = null;
      session.status = "starting";
      session.updatedAt = tick();
      setTimeout(() => {
        const previous = this.agents.get(session.id);
        if (previous === undefined) return;
        this.agents.set(session.id, {
          ...previous,
          id: this.nextId("process"),
          status: "running",
          exitedAt: null,
          createdAt: tick(),
        });
        session.status = "running";
        session.updatedAt = tick();
        this.emit({ type: "session-process", sessionId: session.id, projectId: session.projectId });
      }, this.launchLiveDelayMs);
      return json(422, { _tag: "StoreFailure", message: refusal });
    }
    session.status = "starting";
    session.updatedAt = tick();
    const prompt =
      "prompt" in payload && typeof payload.prompt === "string" ? payload.prompt : null;
    if (this.launchBringsAgentUp) {
      setTimeout(() => {
        const previous = this.agents.get(session.id);
        if (previous === undefined) return;
        this.agents.set(session.id, {
          ...previous,
          id: this.nextId("process"),
          status: "running",
          exitedAt: null,
          createdAt: tick(),
        });
        session.status = "running";
        session.updatedAt = tick();
        this.emit({ type: "session-process", sessionId: session.id, projectId: session.projectId });
        if (prompt !== null && prompt !== "") this.addTurn(session.id, prompt, "running");
      }, this.launchLiveDelayMs);
    }
    return json(200, { ...session });
  }

  private projectView(id: string) {
    const project = this.projects.get(id);
    if (project === undefined) return null;
    return {
      id: project.id,
      name: project.name,
      organizationId: "organization-1",
      visibility: "private",
      createdByUserId: "user-1",
      originUrl: "https://github.com/sealant-sh/mend.git",
      storePath: project.storePath,
      defaultBranch: "main",
      adoptedSha: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
  }
}
