import type { IncomingMessage, ServerResponse } from "node:http";

import { PageId, SessionId } from "@mend/domain";
import { PageRef } from "@mend/domain/workbench";
import * as Schema from "effect/Schema";

import type { MendTurnSteer } from "../../src/mend-workbench.ts";

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

export interface FakeSkill {
  readonly scope: "user" | "project";
  readonly name: string;
  readonly description: string;
}

const skillView = (skill: FakeSkill) => ({
  id: `skill-${skill.scope}-${skill.name}`,
  scope: skill.scope,
  ownerUserId: skill.scope === "user" ? "user-1" : null,
  projectId: skill.scope === "project" ? "project-1" : null,
  name: skill.name,
  description: skill.description,
  fileCount: 1,
  bytes: 64,
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

export interface FakeSession {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly harness: string;
  model: string | null;
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
  steers: Array<MendTurnSteer>;
  steerSender?: string | null;
  providerTurnId: string | null;
  fromSteer: string | null;
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  author: string | null;
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

/** A `page` item as Mend's `pageItemRow` (@mend/db) writes it: no text, its `PageRef` as data. */
export const pageItem = (page: {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly height: number;
}) => ({
  kind: "page",
  title: page.title,
  text: null,
  data: Schema.encodeSync(PageRef)(
    new PageRef({
      id: PageId.make(page.id),
      sessionId: SessionId.make(page.sessionId),
      title: page.title,
      height: page.height,
      publishedAt: new Date("2026-10-04T09:00:02.000Z"),
    }),
  ),
});

/** `LandedPullRequest` in @mend/domain/workbench. */
export interface FakePullRequest {
  readonly number: number;
  readonly url: string;
  state: "open" | "closed" | "merged";
  readonly title: string | null;
  observedAt: string;
}

/** `ChangeLanding` in @mend/domain/workbench, with every field Mend sends. */
export interface FakeLanding {
  readonly id: string;
  readonly changeId: string;
  readonly sessionId: string | null;
  readonly projectId: string;
  readonly checkpointId: string | null;
  readonly checkpointRef: string | null;
  readonly checkpointSha: string | null;
  readonly commitSha: string | null;
  readonly remoteBranch: string;
  readonly pushedSha: string | null;
  readonly trigger: "manual" | "automatic" | "adopted";
  readonly pullRequest: FakePullRequest | null;
  readonly pullRequestCrossRepository: boolean;
  readonly pullRequestHeadOwner: string | null;
  readonly outcome: "pushed" | "pull-request" | "refused" | "failed" | "adopted";
  readonly message: string | null;
  readonly userId: string;
  readonly createdAt: string;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
  /** Every header the request carried, by lower-case name. */
  readonly headerNames: ReadonlyArray<string>;
}

/** A worktree as Mend lists it (`Worktree` in @mend/domain/workbench). */
export interface FakeWorktree {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  /** The owner of its first session; null when it had none. */
  changeOwnerUserId: string | null;
  /** Whether Mend's history proves that owner started it. */
  changeOwnerProven: boolean;
}

/** An answer the fake gives in place of its own behaviour. */
export interface FakeAnswer {
  readonly status: number;
  readonly body: unknown;
}

let clock = Date.parse("2026-10-04T09:00:00.000Z");
/** Strictly increasing timestamps, so ordering by time is ordering by creation. */
export const tick = (): string => new Date((clock += 1_000)).toISOString();
/** Moves the clock on to `at` (never back), for a test that compares Mend's times with the gateway's. */
export const advanceClock = (at: number): void => {
  clock = Math.max(clock, at);
};

/** Where a held stats answer stops until it is released. */
export type StatsStall = "before-headers" | "mid-body";

export class FakeWorkbench {
  readonly projects = new Map<string, { id: string; name: string; storePath: string }>();
  /** Explicit access fixtures; unconfigured projects retain the older unrestricted fake. */
  readonly projectVisibility = new Map<string, "private" | "shared">();
  readonly sessions = new Map<string, FakeSession>();
  readonly agents = new Map<string, FakeProcess>();
  readonly changes = new Map<string, string>();
  readonly control = new Map<string, boolean>();
  /**
   * Session id → whether the person owns it. Mend gives the label and the delete to the owner
   * only; a shared-control steerer may stop the session but not rename or delete it.
   */
  readonly ownership = new Map<string, boolean>();
  readonly turns = new Map<string, Array<FakeTurn>>();
  readonly items = new Map<string, Array<FakeItem>>();
  readonly requests = new Map<string, Array<FakeRequest>>();
  readonly diffs = new Map<
    string,
    {
      readonly diff: string;
      readonly files: ReadonlyArray<{
        path: string;
        additions: number;
        deletions: number;
      }>;
    }
  >();
  /** Session id → the people live in its executor, as `GET /api/sessions` lists them. */
  readonly livePeople = new Map<string, ReadonlyArray<{ accountId: string; name: string }>>();
  /** Session id → what `GET /api/sessions/:id/waiting` answers (`ConversationWait`). */
  readonly waits = new Map<string, unknown>();
  /**
   * Session id → what `GET /api/sessions/:id/workspace-retirement` answers; `GET /api/sessions`
   * says its `state` as the session's `workspaceRetirement`.
   */
  readonly retirements = new Map<
    string,
    { readonly state: "marked" | "retiring"; readonly [field: string]: unknown }
  >();
  /** Session id → when its owner shared control (`sharedControlEnabledAt` in `GET /api/sessions`). */
  readonly sharedControl = new Map<string, string>();
  readonly calls: Array<FakeCall> = [];
  private readonly streams = new Set<ServerResponse>();
  private readonly firstEventStream = Promise.withResolvers<void>();
  private seq = 0;
  private ids = 0;
  /** How long `GET /api/sessions/:id/requests` takes, to hold a read in flight. */
  requestsDelayMs = 0;
  /** Sessions whose items Mend does not answer for (503). */
  readonly itemsUnavailable = new Set<string>();
  /** How long `GET /api/sessions/:id/turns` takes to answer what it read when asked. */
  turnsReadDelayMs = 0;
  /** `GET /api/projects` answers 502, as Mend does while it comes back from a restart. */
  projectsDown = false;
  /** How many `GET /api/projects/:id` reads answer 502 before they answer again. */
  projectDetailFailures = 0;
  /**
   * The next `GET /api/projects/:id` reads now and answers once `until` settles: a read that began
   * before something changed and lands after it. `reached` runs as it reads.
   */
  holdProjectDetail: {
    readonly until: Promise<void>;
    readonly reached: () => void;
  } | null = null;
  /**
   * The same, each for the next request of `method` whose path `path` matches. `before`: the
   * request is not even handled until `until` settles (Mend busy before it acts).
   */
  readonly holds: Array<{
    readonly method: string;
    readonly path: RegExp;
    readonly until: Promise<void>;
    readonly reached: () => void;
    readonly before?: boolean;
  }> = [];
  /** Whether a launch brings the agent up at all (false: provisioning stalls, to fail it later). */
  launchBringsAgentUp = true;
  /** How long after a launch answers its new agent is running. */
  launchLiveDelayMs = 50;
  steerDelivery: MendTurnSteer["delivery"] = {
    _tag: "Accepted",
    evidence: "provider-acknowledged",
  };
  /** A real adapter may take admitted input in a protocol integration test. */
  onSteer: ((steer: MendTurnSteer) => Promise<void>) | null = null;
  steerRefusal: { readonly status: number; readonly tag: string } | null = null;
  /** How many of the next steer POSTs answer 503 before anything is stored. */
  steerOutages = 0;
  interruptUnavailable = false;
  steerResponse: "normal" | "lost" | "malformed" | "mismatched" | "unavailable" = "normal";
  queuedDestination:
    | "own-fresh-turn"
    | "steered-turn"
    | "turn-not-from-steer"
    | "turn-by-another-author"
    | "turn-with-edited-input" = "own-fresh-turn";
  readonly hiddenTurns = new Set<string>();
  /** A Queued answer's new turn stays out of reads until a test lets it show. */
  hideDestinations = false;
  private nextImage: { readonly entered: () => void; readonly answer: Promise<void> } | null = null;
  holdNextImage() {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    this.nextImage = { entered: () => entered.resolve(), answer: answer.promise };
    return { entered: entered.promise, release: () => answer.resolve() };
  }
  private nextSteer: {
    readonly stage: "admission" | "response" | "late";
    readonly entered: () => void;
    readonly answer: Promise<void>;
  } | null = null;

  /** `late`: the gateway loses the answer at once, and Mend admits the steer only on release. */
  holdNextSteer(stage: "admission" | "response" | "late"): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    this.nextSteer = { stage, entered: () => entered.resolve(), answer: answer.promise };
    return { entered: entered.promise, release: () => answer.resolve() };
  }

  /** Mend's carry at a turn's end: a steer still Sending becomes its own queued turn. */
  carrySteer(turn: FakeTurn, id: string): FakeTurn {
    const steer = turn.steers.find((candidate) => candidate.id === id);
    if (steer === undefined) throw new Error(`No steer ${id}`);
    const destination = this.addTurn(turn.sessionId, steer.input, "queued");
    destination.fromSteer = steer.id;
    destination.author = steer.author;
    destination.steerSender = steer.author;
    Object.assign(steer, {
      delivery: { _tag: "Queued", turnId: destination.id, reason: "turn-ended" },
      queuedTurnId: destination.id,
      updatedAt: tick(),
    });
    this.conversationChanged(turn.sessionId);
    return destination;
  }

  /** Mend's carry withdrawal, in place: a held POST answers what it now reads. */
  withdrawSteer(turn: FakeTurn, id: string): void {
    const steer = turn.steers.find((candidate) => candidate.id === id);
    if (steer === undefined || steer.delivery._tag !== "Queued") return;
    const destination = (this.turns.get(turn.sessionId) ?? []).find(
      (candidate) => candidate.id === steer.queuedTurnId,
    );
    if (destination !== undefined) {
      destination.status = "cancelled";
      destination.endedAt = tick();
      destination.error = "The conversation's process ended before taking this turn.";
      destination.fromSteer = null;
    }
    Object.assign(steer, {
      delivery: { _tag: "NotSent", reason: steer.delivery.reason },
      queuedTurnId: null,
      updatedAt: tick(),
    });
    this.conversationChanged(turn.sessionId);
  }

  settleSteer(turn: FakeTurn, id: string, delivery: MendTurnSteer["delivery"]): void {
    turn.steers = turn.steers.map((steer) =>
      steer.id === id ? { ...steer, delivery, updatedAt: tick() } : steer,
    );
    this.conversationChanged(turn.sessionId);
  }

  /** `POST /api/sessions/:id/turns` answers 401, as for a device revoked mid-flight. */
  turnsUnauthorized = false;
  /** `POST /turns` answers 409 though the row reads running (idle stop claimed, host not attached). */
  turnsNotLive = false;
  /**
   * Another client's launch got there first. `under way`: `POST /launch` answers an older Mend's
   * 422 with these words, the session reads `starting`, and the agent comes up `launchLiveDelayMs`
   * later. `agent live`: it answers the 409 `SessionAgentLive` (SLNT-167), the agent already up.
   */
  launchRefusal:
    | { readonly kind: "under way"; readonly words: string }
    | { readonly kind: "agent live" }
    | null = null;
  /** How long `POST /launch` takes to answer, and a status it then refuses with (null: it launches). */
  launchAnswerDelayMs = 0;
  launchFailStatus: number | null = null;
  private nextLaunchAnswer: {
    readonly entered: () => void;
    readonly answer: Promise<number>;
  } | null = null;
  private nextRequestsRead: {
    readonly sessionId: string;
    readonly entered: () => void;
    readonly answer: Promise<void>;
  } | null = null;
  private nextStatsRead: {
    readonly stall: StatsStall;
    readonly entered: () => void;
    readonly answer: Promise<void>;
  } | null = null;
  private nextTurnsRead: {
    readonly sessionId: string;
    readonly entered: () => void;
  } | null = null;

  /** Holds one request-list answer and observes the concurrent turn-list data capture. */
  holdNextRequestsRead(sessionId: string): {
    readonly entered: Promise<void>;
    readonly turnsRead: Promise<void>;
    readonly release: () => void;
  } {
    const entered = Promise.withResolvers<void>();
    const turnsRead = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    this.nextRequestsRead = {
      sessionId,
      entered: () => entered.resolve(),
      answer: answer.promise,
    };
    this.nextTurnsRead = { sessionId, entered: () => turnsRead.resolve() };
    return {
      entered: entered.promise,
      turnsRead: turnsRead.promise,
      release: () => answer.resolve(),
    };
  }

  /**
   * Holds the next `GET /api/changes/:id/stats` answer, read when it arrived, until `release`:
   * before its headers, or with its 200 sent and its body begun.
   */
  holdNextStatsRead(stall: StatsStall = "before-headers"): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    this.nextStatsRead = {
      stall,
      entered: () => entered.resolve(),
      answer: answer.promise,
    };
    return { entered: entered.promise, release: () => answer.resolve() };
  }

  /** Holds the next real HTTP launch request until the test chooses its refusal status. */
  holdNextLaunch(): {
    readonly entered: Promise<void>;
    readonly release: (status: number) => void;
  } {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<number>();
    this.nextLaunchAnswer = {
      entered: () => entered.resolve(),
      answer: answer.promise,
    };
    return { entered: entered.promise, release: answer.resolve };
  }
  private nextAgent: Promise<void> | null = null;

  /** The next launch's agent comes up on `release`, instead of `launchLiveDelayMs` after it. */
  holdNextAgent(): { readonly release: () => void } {
    const up = Promise.withResolvers<void>();
    this.nextAgent = up.promise;
    return { release: () => up.resolve() };
  }
  /** `DELETE /api/sessions/:id` keeps the row until the workspace stops (`removed: false`). */
  removalLeavesWorkspace = false;
  /** Sessions Mend answered `removed: false` for: listed, and saving, until `removeSession`. */
  private readonly leaving = new Set<string>();
  /**
   * Every worktree, by id, as `GET /api/projects/:id/worktrees` lists it: made with its first
   * session and kept after its sessions go, until the worktree or its project is removed.
   */
  readonly worktrees = new Map<string, FakeWorktree>();
  /**
   * Worktree id → Mend's answer to `DELETE /api/worktrees/:id`. Without one, the fake removes a
   * worktree whose sessions have all settled, and refuses one that is saving or has a live agent.
   */
  readonly worktreeRemovalAnswers = new Map<string, FakeAnswer>();
  /** Project id → Mend's answer to `DELETE /api/projects/:id`; without one, the project goes. */
  readonly projectRemovalAnswers = new Map<string, FakeAnswer>();

  get eventStreams(): number {
    return this.streams.size;
  }

  /** Resolves when the first real HTTP event stream is registered to receive pointers. */
  waitForEventStream(): Promise<void> {
    return this.firstEventStream.promise;
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
    this.projects.set(id, {
      id,
      name,
      storePath: `/var/lib/mend/store/${id}/repo.git`,
    });
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
    /** Defaults to `steer`: a session the person can't steer is not theirs. */
    readonly own?: boolean;
    readonly changeId?: string | null;
    /** A session whose worktree this one joins: the same worktree, branch and change. */
    readonly joins?: string;
    /** The Mend account that owns it; the first session's owner owns its change. */
    readonly ownerUserId?: string;
  }): FakeSession {
    const harness = input.harness ?? "codex";
    const createdAt = tick();
    const joined = input.joins === undefined ? undefined : this.sessions.get(input.joins);
    const session: FakeSession = {
      id: input.id,
      projectId: input.projectId,
      worktreeId: joined?.worktreeId ?? `worktree-${input.id}`,
      harness,
      model: harness === "claude" ? "fable" : "gpt-6.1-sol",
      label: input.label === undefined ? null : input.label,
      worktree: joined?.worktree ?? `wt-${input.id}`,
      branch: joined?.branch ?? `mend/wt-${input.id}`,
      baseSha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
      baseRef: "main",
      status: input.live === false ? "stopped" : "idle",
      ownerUserId: input.ownerUserId ?? "user-1",
      summary: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.sessions.set(session.id, session);
    this.keepWorktree(session);
    const kind = input.kind ?? "agent-protocol";
    this.agents.set(session.id, {
      id: this.nextId("process"),
      kind,
      harness,
      status: input.live === false ? "exited" : "running",
      providerSessionId: `provider-${input.id}`,
      protocolOptions:
        kind === "agent-protocol"
          ? {
              model: session.model,
              effort: null,
              permissionMode: input.permissionMode ?? "bypass",
            }
          : null,
      createdAt,
      exitedAt: input.live === false ? createdAt : null,
    });
    this.changes.set(
      session.id,
      joined !== undefined
        ? (this.changes.get(joined.id) ?? "")
        : input.changeId === undefined
          ? `change-${input.id}`
          : (input.changeId ?? ""),
    );
    this.control.set(session.id, input.steer ?? true);
    this.ownership.set(session.id, input.own ?? input.steer ?? true);
    this.turns.set(session.id, []);
    this.items.set(session.id, []);
    this.requests.set(session.id, []);
    this.emit({
      type: "session",
      sessionId: session.id,
      projectId: session.projectId,
    });
    return session;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.leaving.delete(sessionId);
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
    this.emit({
      type: "session-process",
      sessionId,
      projectId: session.projectId,
    });
  }

  startAgentOn(sessionId: string, model: string): void {
    const agent = this.agents.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (agent === undefined || session === undefined || agent.protocolOptions === null) return;
    this.agents.set(sessionId, {
      ...agent,
      id: this.nextId("process"),
      protocolOptions: { ...agent.protocolOptions, model },
      status: "running",
      exitedAt: null,
      createdAt: tick(),
    });
    session.model = model;
    session.status = "running";
    session.updatedAt = tick();
    this.emit({
      type: "session-process",
      sessionId,
      projectId: session.projectId,
    });
  }

  conversationChanged(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.emit({
        type: "agent-conversation",
        sessionId,
        projectId: session.projectId,
      });
    }
  }

  addTurn(sessionId: string, input: string, status: FakeTurn["status"] = "running"): FakeTurn {
    const turns = this.turns.get(sessionId) ?? [];
    const createdAt = tick();
    const turn: FakeTurn = {
      steers: [],
      steerSender: "user-1",
      providerTurnId: status === "queued" ? null : this.nextId("native-turn"),
      fromSteer: null,
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
    if (status === "running" && turn.providerTurnId === null)
      turn.providerTurnId = this.nextId("native-turn");
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

  updateItem(
    item: FakeItem,
    patch: Partial<Pick<FakeItem, "text" | "status" | "title" | "data">>,
  ): void {
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.data !== undefined) item.data = patch.data;
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
    const holdAt = this.holds.findIndex(
      (candidate) => candidate.method === method && candidate.path.test(path),
    );
    const matched = holdAt === -1 ? null : (this.holds.splice(holdAt, 1)[0] ?? null);
    if (matched?.before === true) {
      matched.reached();
      return matched.until.then(() => this.route(request, response, body, accepted));
    }
    const projectHold =
      /^\/api\/projects\/[^/]+$/.test(path) && method === "GET" ? this.holdProjectDetail : null;
    if (projectHold !== null) this.holdProjectDetail = null;
    const hold = projectHold ?? matched;
    hold?.reached();
    const json = (status: number, value: unknown): true => {
      const text = value === undefined ? "" : JSON.stringify(value);
      const write = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(text);
      };
      if (hold === null) write();
      else void hold.until.then(write);
      return true;
    };
    const known =
      path === "/api/projects" ||
      path === "/api/sessions" ||
      path === "/api/events" ||
      path === "/api/skills" ||
      /^\/api\/(projects|sessions|turns|requests|changes|worktrees|landings)\//.test(path);
    if (!known) return false;
    if (!accepted) return json(401, { _tag: "Unauthorized" });

    const record = (value: unknown) => {
      this.calls.push({
        method,
        path,
        query: url.search,
        body: value,
        authorization: request.headers.authorization,
        headerNames: Object.keys(request.headers),
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
      this.firstEventStream.resolve();
      request.on("close", () => this.streams.delete(response));
      return true;
    }
    if (method === "GET" && path === "/api/projects" && this.projectsDown) {
      return json(502, { _tag: "BadGateway" });
    }
    const canReadProject = (projectId: string) => {
      const visibility = this.projectVisibility.get(projectId);
      return (
        visibility === undefined ||
        visibility === "shared" ||
        this.accountOf(request.headers.authorization) === "user-1"
      );
    };
    if (method === "GET" && path === "/api/projects") {
      return json(
        200,
        Array.from(this.projects.values())
          .filter((project) => canReadProject(project.id))
          .map((project) => this.projectView(project.id)),
      );
    }
    if (method === "GET" && path === "/api/sessions") {
      return json(
        200,
        Array.from(this.sessions.values())
          .filter((session) => canReadProject(session.projectId))
          .map((session) => ({
            ...session,
            livePeople: this.livePeople.get(session.id) ?? [],
            sharedControlEnabledAt: this.sharedControl.get(session.id) ?? null,
            workspaceRetirement: this.retirements.get(session.id)?.state ?? null,
          })),
      );
    }
    if (method === "GET" && path === "/api/skills") {
      const account = this.accountOf(request.headers.authorization);
      return json(
        200,
        (account === null ? [] : (this.userSkills.get(account) ?? [])).map(skillView),
      );
    }
    const segments = path.split("/").slice(2);
    const [collection, id, sub] = segments;
    if (collection === undefined || id === undefined) return json(404, { _tag: "NotFound" });

    if (method === "POST" && collection === "projects" && sub === "sessions") {
      return body().then((value) => {
        record(value);
        if (!this.projects.has(id)) return json(404, { _tag: "NotFound", id });
        const payload = typeof value === "object" && value !== null ? value : {};
        const name = "name" in payload && typeof payload.name === "string" ? payload.name : null;
        const base = "base" in payload && typeof payload.base === "string" ? payload.base : null;
        if (base === "no-such-branch") {
          return json(422, {
            _tag: "StoreFailure",
            message: "fatal: invalid reference",
          });
        }
        return json(200, this.createSession(id, payload, { name, base, worktreeId: null }));
      });
    }
    if (method === "GET" && collection === "worktrees" && sub === undefined) {
      if (!Array.from(this.sessions.values()).some((s) => s.worktreeId === id)) {
        return json(404, { _tag: "WorktreeNotFound", id });
      }
      return json(200, { checkpoints: this.checkpoints.get(id) ?? [] });
    }
    if (method === "GET" && collection === "worktrees" && sub === "contents") {
      if (this.goneWorktrees.has(id)) return json(404, { _tag: "WorktreeNotFound", id });
      const asked = url.searchParams.get("path");
      const query = url.searchParams.get("query");
      if (asked !== null) {
        if (asked.includes("..")) return json(422, { _tag: "StoreFailure", message: "outside" });
        const contents = this.fileContents.get(url.searchParams.get("at") ?? id)?.get(asked);
        if (contents === undefined) return json(404, { _tag: "NotFound", id: asked });
        return json(200, {
          worktreeId: id,
          file: {
            path: asked,
            at: url.searchParams.get("at"),
            contents,
            size: Buffer.byteLength(contents),
            truncated: false,
            binary: false,
          },
          search: null,
        });
      }
      if (query === null) return json(422, { _tag: "StoreFailure", message: "no question" });
      let pattern: RegExp;
      try {
        const source =
          url.searchParams.get("regex") === "true"
            ? query
            : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pattern = new RegExp(source, url.searchParams.get("caseSensitive") === "true" ? "" : "i");
      } catch {
        return json(422, {
          _tag: "StoreFailure",
          message: "fatal: invalid regular expression",
        });
      }
      const matches = Array.from(this.fileContents.get(id) ?? new Map<string, string>()).flatMap(
        ([file, contents]) =>
          contents
            .split("\n")
            .flatMap((text, index) =>
              pattern.test(text) ? [{ path: file, line: index + 1, text }] : [],
            ),
      );
      return json(200, {
        worktreeId: id,
        file: null,
        search: { matches, truncated: false },
      });
    }
    if (method === "GET" && collection === "worktrees" && sub === "diff") {
      const key = `${url.searchParams.get("from") ?? "base"}..${url.searchParams.get("to") ?? ""}`;
      const range = this.ranges.get(key);
      if (range === undefined) return json(404, { _tag: "NotFound", id: key });
      return json(200, {
        diff: range.diff,
        files: range.files.map((file) => ({
          oldPath: file.path,
          newPath: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          binary: false,
        })),
        truncated: range.truncated === true,
        omitted: [],
      });
    }
    if (method === "POST" && collection === "worktrees" && sub === "sessions") {
      return body().then((value) => {
        record(value);
        const member = Array.from(this.sessions.values()).find((s) => s.worktreeId === id);
        if (member === undefined) return json(404, { _tag: "WorktreeNotFound", id });
        const payload = typeof value === "object" && value !== null ? value : {};
        return json(
          200,
          this.createSession(member.projectId, payload, {
            name: null,
            base: null,
            worktreeId: member.worktreeId,
          }),
        );
      });
    }

    if (method === "GET" && collection === "projects" && sub === "branches") {
      if (this.projectView(id) === null) return json(404, { _tag: "NotFound" });
      const branches = this.branches.get(id) ?? [{ name: "main", isDefault: true }];
      return json(
        200,
        branches.map((branch) => ({
          ...branch,
          sha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
          committedAt: "2026-10-04T12:00:00.000Z",
        })),
      );
    }
    if (method === "POST" && collection === "projects" && sub === "refresh") {
      return body().then((value) => {
        record(value);
        if (this.projectView(id) === null) return json(404, { _tag: "NotFound" });
        const branches = this.branches.get(id) ?? [{ name: "main", isDefault: true }];
        return json(
          200,
          branches.map((branch) => ({
            ...branch,
            sha: "9d3c1f0a2b4e6d8f0a1c3e5b7d9f1a3c5e7b9d1f",
            committedAt: "2026-10-17T12:00:00.000Z",
          })),
        );
      });
    }
    if (method === "GET" && collection === "projects" && sub === "worktrees") {
      if (this.projectView(id) === null) return json(404, { _tag: "NotFound" });
      return json(200, {
        worktrees: Array.from(this.worktrees.values()).filter(
          (worktree) => worktree.projectId === id,
        ),
      });
    }
    if (method === "DELETE" && collection === "projects" && sub === undefined) {
      record(undefined);
      const answer = this.projectRemovalAnswers.get(id);
      if (answer !== undefined) return json(answer.status, answer.body);
      if (this.projectView(id) === null) return json(404, { _tag: "NotFound", id });
      this.projects.delete(id);
      for (const session of Array.from(this.sessions.values())) {
        if (session.projectId === id) this.sessions.delete(session.id);
      }
      for (const worktree of Array.from(this.worktrees.values())) {
        if (worktree.projectId === id) this.worktrees.delete(worktree.id);
      }
      this.emit({ type: "project", projectId: id });
      return json(200, { removed: true, leftover: null });
    }
    if (method === "DELETE" && collection === "worktrees" && sub === undefined) {
      record(undefined);
      const answer = this.worktreeRemovalAnswers.get(id);
      if (answer !== undefined) return json(answer.status, answer.body);
      const worktree = this.worktrees.get(id);
      if (worktree === undefined) return json(404, { _tag: "WorktreeNotFound", id });
      const inside = Array.from(this.sessions.values()).filter((s) => s.worktreeId === id);
      const saving = inside.filter((session) => this.leaving.has(session.id));
      if (saving.length > 0) {
        return json(409, {
          _tag: "RemovalRefused",
          scope: "worktree",
          blockers: [
            {
              _tag: "Saving",
              worktreeId: id,
              worktreeName: worktree.name,
              holds: saving.map((session) => ({
                sessionId: session.id,
                kind: "saving",
                via: "own",
              })),
            },
          ],
          forceWouldLift: false,
          message: "not removed · saving",
        });
      }
      for (const session of inside) this.sessions.delete(session.id);
      this.worktrees.delete(id);
      this.emit({ type: "worktree", projectId: worktree.projectId });
      return json(200, { removed: true, leftover: null });
    }
    if (
      method === "GET" &&
      collection === "projects" &&
      sub === undefined &&
      this.projectDetailFailures > 0
    ) {
      this.projectDetailFailures -= 1;
      return json(502, { _tag: "BadGateway" });
    }
    if (method === "GET" && collection === "projects" && sub === "skills") {
      if (!canReadProject(id) || this.projectView(id) === null)
        return json(404, { _tag: "NotFound" });
      return json(200, (this.projectSkills.get(id) ?? []).map(skillView));
    }
    if (method === "GET" && collection === "projects" && sub === "files") {
      if (this.projectView(id) === null) return json(404, { _tag: "NotFound" });
      const sessionId = url.searchParams.get("session");
      if (sessionId !== null && this.sessions.get(sessionId)?.projectId !== id) {
        return json(404, { _tag: "NotFound" });
      }
      // Mend's own cap: the sorted list, cut at its limit.
      const all = (this.files.get(sessionId ?? id) ?? []).toSorted();
      return json(200, {
        source: sessionId === null ? "branch" : "worktree",
        label: sessionId === null ? "main" : sessionId,
        rootPath: null,
        files: all.slice(0, this.fileListingLimit),
        truncated: all.length > this.fileListingLimit,
      });
    }
    if (method === "GET" && collection === "projects" && sub === undefined) {
      if (!canReadProject(id)) return json(404, { _tag: "NotFound" });
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
      if (session === undefined || !canReadProject(session.projectId))
        return json(404, { _tag: "NotFound" });
      const notOwner = () =>
        json(403, {
          _tag: "SessionNotSteerable",
          sessionId: id,
          message: "not yours",
        });
      if (method === "POST" && sub === "label") {
        return body().then((value) => {
          record(value);
          if (this.ownership.get(id) === false) return notOwner();
          const payload = typeof value === "object" && value !== null ? value : {};
          const label =
            "label" in payload && typeof payload.label === "string" ? payload.label.trim() : "";
          session.label = label.length === 0 ? null : label;
          session.updatedAt = tick();
          this.emit({
            type: "session",
            sessionId: id,
            projectId: session.projectId,
          });
          return json(200, session);
        });
      }
      if (method === "POST" && sub === "land") {
        return body().then((value) => {
          record(value);
          const held = this.nextLandingAnswer;
          this.nextLandingAnswer = null;
          const pullRequest =
            typeof value === "object" &&
            value !== null &&
            "pullRequest" in value &&
            value.pullRequest === true;
          const answer =
            held ?? this.land(session, this.accountOf(request.headers.authorization), pullRequest);
          return json(answer.status, answer.body);
        });
      }
      if (method === "POST" && sub === "stop") {
        return body().then((value) => {
          record(value);
          if (this.control.get(id) === false) return notOwner();
          this.stopAgent(id);
          return json(200, session);
        });
      }
      if (method === "DELETE" && sub === undefined) {
        record(undefined);
        if (this.ownership.get(id) === false) return notOwner();
        const agent = this.agents.get(id);
        if (agent !== undefined && agent.exitedAt === null) {
          return json(409, { _tag: "SessionActive", id });
        }
        if (this.removalLeavesWorkspace) {
          this.leaving.add(id);
          return json(200, {
            removed: false,
            leftover: "workspace · removed once its workspace has stopped",
          });
        }
        this.removeSession(id);
        return json(200, { removed: true, leftover: null });
      }
      if (method === "GET" && sub === undefined) {
        const changeId = this.changes.get(id) || null;
        return json(200, {
          session,
          control: {
            own: this.ownership.get(id) ?? true,
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
      if (method === "GET" && sub === "turns") {
        // As Mend reads them when the request arrives; a delayed answer is that read, late.
        const answer = structuredClone(
          (this.turns.get(id) ?? []).filter((turn) => !this.hiddenTurns.has(turn.id)),
        );
        const observed = this.nextTurnsRead;
        if (observed?.sessionId === id) {
          this.nextTurnsRead = null;
          observed.entered();
        }
        if (this.turnsReadDelayMs === 0) return json(200, answer);
        return new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(json(200, answer)), this.turnsReadDelayMs),
        );
      }
      if (method === "GET" && sub === "waiting") return json(200, this.waits.get(id) ?? null);
      if (method === "GET" && sub === "workspace-retirement") {
        return json(200, this.retirements.get(id) ?? null);
      }
      if (method === "GET" && sub === "requests") {
        const answer = this.requests.get(id) ?? [];
        const held = this.nextRequestsRead;
        if (held?.sessionId === id) {
          const captured = structuredClone(answer);
          this.nextRequestsRead = null;
          held.entered();
          return held.answer.then(() => json(200, captured));
        }
        if (this.requestsDelayMs === 0) return json(200, answer);
        return new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(json(200, answer)), this.requestsDelayMs),
        );
      }
      if (method === "GET" && sub === "items") {
        if (this.itemsUnavailable.has(id)) return json(503, { _tag: "Unavailable" });
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const changed = (this.items.get(id) ?? [])
          .filter((item) => item.seq > after)
          .toSorted((left, right) => left.seq - right.seq)
          .slice(0, limit);
        return json(200, changed);
      }
      if (method === "POST" && sub === "launch" && this.nextLaunchAnswer !== null) {
        const held = this.nextLaunchAnswer;
        this.nextLaunchAnswer = null;
        return body().then(async (value) => {
          record(value);
          held.entered();
          const status = await held.answer;
          return json(status, {
            _tag: "StoreFailure",
            message: "launch refused",
          });
        });
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
                  : json(status, {
                      _tag: "StoreFailure",
                      message: "launch refused",
                    }),
              );
            }, this.launchAnswerDelayMs),
          );
        });
      }
      if (method === "POST" && sub === "images") {
        return body().then(async (value) => {
          record(value);
          const barrier = this.nextImage;
          this.nextImage = null;
          if (barrier !== null) {
            barrier.entered();
            await barrier.answer;
          }
          if (this.control.get(id) === false) return notOwner();
          const agent = this.agents.get(id);
          if (agent === undefined || agent.exitedAt !== null) {
            return json(409, { _tag: "SessionNotLive", id });
          }
          const payload = typeof value === "object" && value !== null ? value : {};
          const encoded = Object.entries(payload).find(([key]) => key === "contentsBase64")?.[1];
          const bytes = Buffer.from(typeof encoded === "string" ? encoded : "", "base64");
          if (bytes.byteLength === 0) {
            return json(422, {
              _tag: "PastedImageRejected",
              message: "not an image",
            });
          }
          this.pastedImages += 1;
          // As mend#615 places a paste: in a per-person executor, in the sender's own directory;
          // in a shared one, in the shared paste directory.
          const account = this.accountOf(request.headers.authorization);
          const directory =
            this.sharedExecutor || account === null
              ? "/workspace/harness-home/paste"
              : `/workspace/harness-home/people/${account}/paste`;
          const placed = `${directory}/20261010-090000-${this.pastedImages}.png`;
          return json(200, {
            path: placed,
            mediaType: "image/png",
            bytes: bytes.byteLength,
          });
        });
      }
      if (method === "POST" && (sub === "turns" || sub === "launch")) {
        return body().then((value) => {
          record(value);
          return this.command(sub, session, value, json);
        });
      }
    }
    if (method === "POST" && collection === "landings" && sub === "refresh") {
      return body().then((value) => {
        record(value);
        for (const [changeId, landings] of this.landings) {
          const index = landings.findIndex((landing) => landing.id === id);
          const landing = landings[index];
          if (landing === undefined) continue;
          if (this.changeOwnerOf(changeId) !== this.accountOf(request.headers.authorization)) {
            return json(403, {
              _tag: "LandingNotAllowed",
              message: "only the change's owner lands it",
            });
          }
          if (landing.pullRequest === null) return json(404, { _tag: "NotFound" });
          const refreshed: FakeLanding = {
            ...landing,
            pullRequest: {
              ...landing.pullRequest,
              state: this.github.get(landing.pullRequest.number) ?? landing.pullRequest.state,
              observedAt: tick(),
            },
          };
          landings[index] = refreshed;
          return json(200, refreshed);
        }
        return json(404, { _tag: "NotFound" });
      });
    }
    if (method === "POST" && collection === "turns" && sub === "steer") {
      return body().then(async (value) => {
        record(value);
        const barrier = this.nextSteer;
        this.nextSteer = null;
        if (barrier?.stage === "late") response.destroy();
        if (barrier?.stage === "admission" || barrier?.stage === "late") {
          barrier.entered();
          await barrier.answer;
        }
        const turn = Array.from(this.turns.values())
          .flat()
          .find((candidate) => candidate.id === id);
        if (turn === undefined) return json(404, { _tag: "NotFound" });
        if (this.steerOutages > 0) {
          this.steerOutages -= 1;
          return json(503, { _tag: "Unavailable" });
        }
        if (this.steerRefusal !== null)
          return json(this.steerRefusal.status, {
            _tag: this.steerRefusal.tag,
            message: this.steerRefusal.tag,
          });
        if (this.control.get(turn.sessionId) === false)
          return json(403, { _tag: "SessionNotSteerable", message: "not yours" });
        const author = this.accountOf(request.headers.authorization);
        if (author === null || turn.steerSender !== author)
          return json(403, {
            _tag: "TurnSteerForbidden",
            message: "Only the turn's sender can steer it.",
          });
        const payload = typeof value === "object" && value !== null ? value : {};
        const input = "input" in payload && typeof payload.input === "string" ? payload.input : "";
        const key =
          "clientSteerId" in payload && typeof payload.clientSteerId === "string"
            ? payload.clientSteerId
            : "";
        if (
          !input.trim() ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
        )
          return json(400, { _tag: "InvalidInput" });
        const previous = Array.from(this.turns.values())
          .flatMap((item) => item.flatMap((candidate) => candidate.steers))
          .find((steer) => steer.author === author && steer.clientSteerId === key);
        if (previous !== undefined)
          return previous.turnId === turn.id && previous.input === input
            ? json(200, previous)
            : json(409, { _tag: "TurnSteerKeyConflict" });
        const createdAt = tick();
        const steerId = this.nextId("steer");
        let delivery = this.steerDelivery;
        if (
          delivery._tag === "Queued" ||
          (turn.status !== "running" && delivery._tag === "Accepted")
        ) {
          const kind = this.queuedDestination;
          const destination =
            kind === "steered-turn"
              ? turn
              : this.addTurn(
                  turn.sessionId,
                  kind === "turn-with-edited-input" ? `${input} (edited)` : input,
                  "queued",
                );
          if (this.hideDestinations) this.hiddenTurns.add(destination.id);
          if (kind !== "steered-turn") {
            destination.fromSteer = kind === "turn-not-from-steer" ? null : steerId;
            destination.author = kind === "turn-by-another-author" ? "someone-else" : author;
            destination.steerSender = author;
          }
          delivery = { _tag: "Queued", turnId: destination.id, reason: "turn-ended" };
        }
        const steer: MendTurnSteer = {
          id: steerId,
          sessionId: turn.sessionId,
          turnId: turn.id,
          processId: this.agents.get(turn.sessionId)?.id ?? "process",
          author,
          ordinal: turn.steers.length,
          input,
          clientSteerId: key,
          delivery,
          queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
          createdAt,
          updatedAt: createdAt,
        };
        turn.steers.push(steer);
        await this.onSteer?.(steer);
        this.conversationChanged(turn.sessionId);
        if (barrier?.stage === "response") {
          barrier.entered();
          await barrier.answer;
        }
        if (barrier?.stage === "late") return true;
        switch (this.steerResponse) {
          case "lost":
            response.destroy();
            return true;
          case "unavailable":
            return json(503, { _tag: "Unavailable" });
          case "malformed":
            return json(200, { ...steer, delivery: { _tag: "Future" } });
          case "mismatched":
            return json(200, { ...steer, clientSteerId: "another-message" });
        }
        return json(200, steer);
      });
    }
    if (method === "POST" && collection === "turns" && sub === "interrupt") {
      return body().then((value) => {
        record(value);
        for (const turns of this.turns.values()) {
          const turn = turns.find((candidate) => candidate.id === id);
          if (turn === undefined) continue;
          if (this.interruptUnavailable) return json(503, { _tag: "Unavailable" });
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
    if (method === "GET" && collection === "changes" && sub === "landings") {
      const visible = Array.from(this.sessions.values()).some(
        (session) => this.changes.get(session.id) === id && canReadProject(session.projectId),
      );
      if (!visible) return json(404, { _tag: "NotFound" });
      return json(200, this.landingsView(id, this.accountOf(request.headers.authorization)));
    }
    if (method === "GET" && collection === "changes" && sub === "stats") {
      const stats = structuredClone(this.stats.get(id));
      const answer = () =>
        stats === undefined ? json(404, { _tag: "NotFound" }) : json(200, stats);
      const held = this.nextStatsRead;
      if (held === null) return answer();
      // As Mend reads them when the request arrives; the held answer is that read, late.
      this.nextStatsRead = null;
      held.entered();
      if (held.stall === "mid-body" && stats !== undefined) {
        const text = JSON.stringify(stats);
        response.writeHead(200, { "content-type": "application/json" });
        response.write(text.slice(0, 1));
        return held.answer.then((): true => {
          response.end(text.slice(1));
          return true;
        });
      }
      return held.answer.then(answer);
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
        observation: {
          state: "observed",
          source: "capture",
          label: "observed at capture 3 · seq 7",
        },
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
        return json(409, {
          _tag: "ProtocolSessionNotLive",
          processId: agent?.id ?? "none",
        });
      }
      const input = "input" in payload && typeof payload.input === "string" ? payload.input : "";
      const open = (this.turns.get(session.id) ?? []).some(
        (turn) => turn.status === "queued" || turn.status === "running",
      );
      return json(200, this.addTurn(session.id, input, open ? "queued" : "running"));
    }
    // A launch answers at once; a new agent process comes up on the options the launch names,
    // else those the last one recorded, and only a prompt would open a turn.
    const named = (key: string): string | null => {
      const found = Object.entries(payload).find(([name]) => name === key)?.[1];
      return typeof found === "string" ? found : null;
    };
    if (this.agents.get(session.id) === undefined) {
      const permissionMode = named("permissionMode") === "ask" ? "ask" : "bypass";
      this.agents.set(session.id, {
        id: this.nextId("process"),
        kind: "agent-protocol",
        harness: session.harness,
        status: "exited",
        providerSessionId: `provider-${session.id}`,
        protocolOptions: {
          model: named("model"),
          effort: named("effort"),
          permissionMode,
        },
        createdAt: tick(),
        exitedAt: tick(),
      });
    }
    this.launches.push({ sessionId: session.id, body: payload });
    const refusal = this.launchRefusal;
    if (refusal?.kind === "agent live") {
      this.launchRefusal = null;
      const previous = this.agents.get(session.id);
      if (previous !== undefined) {
        this.agents.set(session.id, {
          ...previous,
          id: this.nextId("process"),
          status: "running",
          exitedAt: null,
          createdAt: tick(),
        });
      }
      session.status = "running";
      session.updatedAt = tick();
      return json(409, {
        _tag: "SessionAgentLive",
        sessionId: session.id,
        status: "running",
        settledAt: null,
        message:
          "the session's agent is live · nothing restarted · attach to it, or stop it and launch again",
      });
    }
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
        this.emit({
          type: "session-process",
          sessionId: session.id,
          projectId: session.projectId,
        });
      }, this.launchLiveDelayMs);
      return json(422, { _tag: "StoreFailure", message: refusal.words });
    }
    session.model = named("model") ?? session.model;
    session.status = "starting";
    session.updatedAt = tick();
    const prompt =
      "prompt" in payload && typeof payload.prompt === "string" ? payload.prompt : null;
    if (this.launchBringsAgentUp) {
      const bringUp = () => {
        const previous = this.agents.get(session.id);
        if (previous === undefined) return;
        const recorded = previous.protocolOptions;
        const mode = named("permissionMode");
        this.agents.set(session.id, {
          ...previous,
          protocolOptions:
            recorded === null
              ? null
              : {
                  model: named("model") ?? recorded.model,
                  effort: named("effort") ?? recorded.effort,
                  permissionMode:
                    mode === "ask" || mode === "bypass" ? mode : recorded.permissionMode,
                },
          id: this.nextId("process"),
          status: "running",
          exitedAt: null,
          createdAt: tick(),
        });
        session.status = "running";
        session.updatedAt = tick();
        this.emit({
          type: "session-process",
          sessionId: session.id,
          projectId: session.projectId,
        });
        if (prompt !== null && prompt !== "") this.addTurn(session.id, prompt, "running");
      };
      const held = this.nextAgent;
      this.nextAgent = null;
      if (held === null) setTimeout(bringUp, this.launchLiveDelayMs);
      else void held.then(bringUp);
    }
    return json(200, { ...session });
  }

  /**
   * `GET /api/projects/:id/files`: a session's worktree files by session id, and the default
   * branch's by project id.
   */
  readonly files = new Map<string, ReadonlyArray<string>>();
  /** How many files `GET /api/projects/:id/files` lists before it cuts (Mend's is 20,000). */
  fileListingLimit = 20_000;

  /** `GET /api/projects/:id/branches` by project; absent, the project has `main` alone. */
  readonly branches = new Map<string, ReadonlyArray<{ name: string; isDefault: boolean }>>();

  /** Each worktree's checkpoint chain (`GET /api/worktrees/:id`), oldest first. */
  readonly checkpoints = new Map<
    string,
    Array<{
      id: string;
      sessionId: string | null;
      ordinal: number;
      ref: string;
      trigger: string;
      createdAt: string;
    }>
  >();
  /** `GET /api/worktrees/:id/diff`, by `<from or base>..<to>`. */
  readonly ranges = new Map<
    string,
    {
      diff: string;
      files: ReadonlyArray<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }>;
      /** Mend rendered only some of the files' patches. */
      truncated?: boolean;
    }
  >();
  /**
   * `GET /api/worktrees/:id/contents`: files by path, as the worktree stands (keyed by worktree id)
   * or at a checkpoint (keyed by checkpoint id).
   */
  readonly fileContents = new Map<string, Map<string, string>>();
  /** Worktrees `GET /api/worktrees/:id/contents` answers 404 `WorktreeNotFound` for. */
  readonly goneWorktrees = new Set<string>();
  /** Files every new worktree starts with (its t3.json, say), by path. */
  readonly newWorktreeFiles = new Map<string, string>();
  /** `GET /api/changes/:id/stats`, by change id. */
  readonly stats = new Map<string, { files: number; additions: number; deletions: number }>();
  /** Change id → its landings, newest first (`GET /api/changes/:id/landings`). */
  readonly landings = new Map<string, Array<FakeLanding>>();
  /** Change id → files that differ from the last landing (the `changed-since-landing` fact). */
  readonly sinceLanding = new Map<string, number>();
  /**
   * Changes whose agent committed since the last landing, which lands even when no file differs
   * (the agent committed the tree the landing pushed).
   */
  readonly agentCommitted = new Set<string>();
  /** Pull request number → its state on GitHub now, which `POST /api/landings/:id/refresh` reads. */
  readonly github = new Map<number, "open" | "closed" | "merged">();
  /** Project id → whether Mend can open a pull request for it; unset is available. */
  readonly pullRequestAvailability = new Map<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >();
  /** The next landing's pull request step fails with `gh`'s words, after its push. */
  nextPullRequestFailure: string | null = null;
  /** The next `POST /api/sessions/:id/land` answers this instead of landing. */
  nextLandingAnswer: {
    readonly status: number;
    readonly body: unknown;
  } | null = null;
  private pullRequestNumbers = 0;
  private shas = 0;

  private nextSha(): string {
    this.shas += 1;
    return this.shas.toString(16).padStart(40, "a");
  }

  private changeOwnerOf(changeId: string): string | null {
    const first = Array.from(this.sessions.values())
      .filter((session) => this.changes.get(session.id) === changeId)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return first?.ownerUserId ?? null;
  }

  private availabilityOf(projectId: string) {
    return (
      this.pullRequestAvailability.get(projectId) ?? {
        available: true,
        reason: null,
      }
    );
  }

  /** `ChangeLandingsView` for a change, as the caller reads it. */
  private landingsView(changeId: string, caller: string | null) {
    const landings = this.landings.get(changeId) ?? [];
    const session = Array.from(this.sessions.values()).find(
      (candidate) => this.changes.get(candidate.id) === changeId,
    );
    const owner = this.changeOwnerOf(changeId);
    const lastPush = landings.find((landing) => landing.pushedSha !== null);
    const lastPullRequest = landings.find((landing) => landing.pullRequest !== null);
    const since = this.sinceLanding.get(changeId) ?? 0;
    const facts: Array<Record<string, unknown>> = [];
    if (lastPush?.pushedSha != null) {
      facts.push({
        _tag: "pushed",
        branch: lastPush.remoteBranch,
        sha: lastPush.pushedSha,
      });
    }
    if (lastPullRequest?.pullRequest != null) {
      const { number, state, observedAt } = lastPullRequest.pullRequest;
      facts.push({
        _tag: "pull-request",
        number,
        state,
        observedAt,
        outside: false,
        fork: null,
      });
    }
    if (lastPush !== undefined && since > 0) {
      facts.push({ _tag: "changed-since-landing", files: since });
    }
    return {
      changeId,
      sessionId: session?.id ?? null,
      land: owner !== null && owner === caller,
      landings,
      facts,
      remote: null,
      remoteFailure: null,
      pullRequest: this.availabilityOf(session?.projectId ?? ""),
      nextBranch: lastPush?.remoteBranch ?? session?.branch ?? null,
    };
  }

  /** `POST /api/sessions/:id/land`, as Mend's landing answers it (docs/adr/0007-landing.md). */
  private land(
    session: FakeSession,
    caller: string | null,
    pullRequest: boolean,
  ): { readonly status: number; readonly body: unknown } {
    const changeId = this.changes.get(session.id) ?? "";
    const owner = changeId === "" ? null : this.changeOwnerOf(changeId);
    if (owner === null || owner !== caller) {
      return {
        status: 403,
        body: {
          _tag: "LandingNotAllowed",
          message: "only the change's owner lands it",
        },
      };
    }
    const history = this.landings.get(changeId) ?? [];
    const lastPush = history.find((landing) => landing.pushedSha !== null);
    const latest = history[0];
    const recorded = history.find((landing) => landing.pullRequest !== null)?.pullRequest ?? null;
    const previous = recorded?.state === "open" ? recorded : null;
    const availability = this.availabilityOf(session.projectId);
    const wantsPullRequest = pullRequest && availability.available;
    const nothingNew =
      lastPush !== undefined &&
      (this.sinceLanding.get(changeId) ?? 0) === 0 &&
      !this.agentCommitted.has(changeId);
    if (
      nothingNew &&
      latest !== undefined &&
      (latest.outcome === "pull-request" || (latest.outcome === "pushed" && !wantsPullRequest))
    ) {
      return {
        status: 409,
        body: {
          _tag: "LandingNotStarted",
          message: "landing not started · nothing new since the last landing",
        },
      };
    }
    const observedAt = tick();
    const stepFailure = wantsPullRequest ? this.nextPullRequestFailure : null;
    this.nextPullRequestFailure = null;
    const opened: FakePullRequest | null =
      !wantsPullRequest || stepFailure !== null
        ? null
        : previous === null
          ? {
              number: (this.pullRequestNumbers += 1),
              url: `https://github.com/sealant-sh/mend/pull/${this.pullRequestNumbers}`,
              state: "open",
              title: session.label ?? session.id,
              observedAt,
            }
          : { ...previous, observedAt };
    const landing: FakeLanding = {
      id: this.nextId("landing"),
      changeId,
      sessionId: session.id,
      projectId: session.projectId,
      checkpointId: this.nextId("checkpoint"),
      checkpointRef: `refs/mend/landed/${changeId}`,
      checkpointSha: this.nextSha(),
      commitSha: this.nextSha(),
      remoteBranch: lastPush?.remoteBranch ?? session.branch,
      pushedSha: this.nextSha(),
      trigger: "manual",
      pullRequest: opened,
      pullRequestCrossRepository: false,
      pullRequestHeadOwner: null,
      outcome: stepFailure !== null ? "failed" : opened === null ? "pushed" : "pull-request",
      message: stepFailure,
      userId: owner,
      createdAt: observedAt,
    };
    this.landings.set(changeId, [landing, ...history]);
    this.sinceLanding.set(changeId, 0);
    this.agentCommitted.delete(changeId);
    const step =
      stepFailure !== null
        ? { _tag: "failed", message: stepFailure }
        : opened !== null
          ? {
              _tag: previous === null ? "opened" : "updated",
              pullRequest: opened,
            }
          : !pullRequest
            ? { _tag: "off" }
            : {
                _tag: "unavailable",
                reason: availability.reason ?? "pull request unavailable",
              };
    return { status: 200, body: { landing, pullRequest: step } };
  }
  /** How many images were pasted into workspaces. */
  pastedImages = 0;
  readonly userSkills = new Map<string, ReadonlyArray<FakeSkill>>();
  readonly projectSkills = new Map<string, ReadonlyArray<FakeSkill>>();
  readonly skillsNotInherited = new Set<string>();
  /** The Mend account a request's bearer belongs to (set by the fake Mend that pairs devices). */
  accountOf: (authorization: string | undefined) => string | null = () => null;
  /** The session's executor is shared (ADR 0016's shared layout), not per person. */
  sharedExecutor = false;

  /** A checkpoint of the session's worktree, as Mend takes one when a turn ends. */
  addCheckpoint(sessionId: string, trigger = "turn-boundary"): string {
    const session = this.sessions.get(sessionId);
    const worktreeId = session?.worktreeId ?? "worktree";
    const chain = this.checkpoints.get(worktreeId) ?? [];
    const ordinal = chain.length;
    const id = `checkpoint-${worktreeId}-${ordinal}`;
    chain.push({
      id,
      sessionId,
      ordinal,
      ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
      trigger,
      createdAt: tick(),
    });
    this.checkpoints.set(worktreeId, chain);
    return id;
  }

  /** Every launch Mend took, with what it named. */
  readonly launches: Array<{
    readonly sessionId: string;
    readonly body: object;
  }> = [];

  /** A session the caller owns, in a new worktree or one it joins; no agent until it launches. */
  private createSession(
    projectId: string,
    payload: object,
    where: {
      readonly name: string | null;
      readonly base: string | null;
      readonly worktreeId: string | null;
    },
  ): FakeSession {
    const id = this.nextId("session");
    const harness =
      "harness" in payload && typeof payload.harness === "string" ? payload.harness : "codex";
    const label = "label" in payload && typeof payload.label === "string" ? payload.label : null;
    const createdAt = tick();
    const joined =
      where.worktreeId === null
        ? undefined
        : Array.from(this.sessions.values()).find((s) => s.worktreeId === where.worktreeId);
    const directory = joined?.worktree ?? where.name ?? `wt-${id}`;
    const session: FakeSession = {
      id,
      projectId,
      worktreeId: joined?.worktreeId ?? `worktree-${id}`,
      harness,
      model: null,
      label,
      worktree: directory,
      branch: joined?.branch ?? `mend/${directory}`,
      baseSha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
      baseRef: joined?.baseRef ?? where.base ?? "main",
      status: "idle",
      ownerUserId: "user-1",
      summary: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.sessions.set(id, session);
    this.keepWorktree(session);
    this.changes.set(
      id,
      joined === undefined ? `change-${id}` : (this.changes.get(joined.id) ?? ""),
    );
    this.control.set(id, true);
    this.ownership.set(id, true);
    this.turns.set(id, []);
    this.items.set(id, []);
    this.requests.set(id, []);
    if (joined === undefined && this.newWorktreeFiles.size > 0) {
      this.fileContents.set(session.worktreeId, new Map(this.newWorktreeFiles));
    }
    this.emit({ type: "session", sessionId: id, projectId });
    return session;
  }

  /** The session's worktree, made with it when it is the first there. */
  private keepWorktree(session: FakeSession): void {
    if (this.worktrees.has(session.worktreeId)) return;
    this.worktrees.set(session.worktreeId, {
      id: session.worktreeId,
      projectId: session.projectId,
      name: session.worktree,
      directory: session.worktree,
      branch: session.branch,
      changeOwnerUserId: session.ownerUserId,
      changeOwnerProven: session.ownerUserId !== null,
    });
  }

  private projectView(id: string) {
    const project = this.projects.get(id);
    if (project === undefined) return null;
    return {
      id: project.id,
      name: project.name,
      organizationId: "organization-1",
      visibility: this.projectVisibility.get(id) ?? "private",
      createdByUserId: "user-1",
      originUrl: "https://github.com/sealant-sh/mend.git",
      storePath: project.storePath,
      defaultBranch: "main",
      inheritUserSkills: !this.skillsNotInherited.has(id),
      adoptedSha: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
  }
}
