import * as vscode from "vscode";

import {
  MendApiError,
  matchProject,
  type EventPointer,
  type MendClient,
  type StreamSignal,
} from "./client.js";
import { repositoryFacts } from "./git.js";
import type { MemberName } from "./session-lines.js";
import {
  seen,
  sessionModel,
  type Connection,
  type LandingFact,
  type LastSeen,
  type WaitFact,
  type WindowModel,
} from "./session-model.js";
import { conversationWait, readPlan, terminalWait, type ReadPlan } from "./session-reads.js";
import type { Project, ProjectDetail, Session, SessionDetail } from "./types.js";
import { sessionOfWorkspace, type WindowRole } from "./window-role.js";

/** `globalState` key: `LastSeen` per server URL, on this machine only. */
const LAST_SEEN_KEY = "mend.lastSeen";
const DEBOUNCE_MS = 150;
/** While offline, `last seen 2 min ago` is said again each half minute. */
const OFFLINE_TICK_MS = 30_000;

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);

interface Snapshot {
  readonly projects: ReadonlyArray<Project>;
  readonly details: ReadonlyMap<string, ProjectDetail>;
  readonly viewer: string | null;
  readonly members: ReadonlyArray<MemberName>;
  readonly waits: ReadonlyMap<string, WaitFact>;
  readonly landings: ReadonlyMap<string, LandingFact>;
}

const EMPTY: Snapshot = {
  projects: [],
  details: new Map(),
  viewer: null,
  members: [],
  waits: new Map(),
  landings: new Map(),
};

export interface StoreChange {
  readonly prev: WindowModel | null;
  readonly next: WindowModel;
}

const isLastSeen = (value: unknown): value is LastSeen =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "baseline") === "string" &&
  typeof Reflect.get(value, "sessions") === "object";

/**
 * Every read the Mend view, status bar, badge and notifier rest on: one snapshot, kept current by
 * the event stream with a targeted re-read per frame, and what this VS Code last looked at. It
 * emits the model; the surfaces only map it.
 */
export class SessionStore implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<StoreChange>();
  readonly onDidChange = this.#changed.event;
  #snapshot: Snapshot = EMPTY;
  #read = false;
  #error: unknown = null;
  #connection: Connection = { state: "connecting" };
  #lastHeardAt: string | null = null;
  #serverUrl: string | null = null;
  #lastSeen: LastSeen = { baseline: new Date().toISOString(), sessions: {} };
  #model: WindowModel | null = null;
  /** Whether `#model` came from a read: the first read's change then raises no toast. */
  #modelRead = false;
  #selected: ReadonlyArray<string> = [];
  #windowProject: { readonly project: Project; readonly folder: vscode.WorkspaceFolder } | null =
    null;
  #pending: Array<EventPointer> = [];
  #pendingAll = false;
  #timer: NodeJS.Timeout | null = null;
  #ticker: NodeJS.Timeout | null = null;
  #subscription: vscode.Disposable | null = null;
  #reading: Promise<void> = Promise.resolve();
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: MendClient,
    private readonly role: WindowRole,
    private readonly workspace: {
      session(): { readonly session: Session } | null;
      readonly onDidLocate: vscode.Event<void>;
    },
  ) {
    this.#disposables = [
      this.#changed,
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.#emit();
      }),
      workspace.onDidLocate(() => this.#emit()),
      vscode.workspace.onDidChangeWorkspaceFolders(
        () => void this.#matchWindow().then(() => this.#emit()),
      ),
    ];
  }

  dispose(): void {
    this.#subscription?.dispose();
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#ticker !== null) clearInterval(this.#ticker);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** Subscribe and read everything; again after a sign-in or a new server. */
  start(): void {
    this.#subscription?.dispose();
    this.#snapshot = EMPTY;
    this.#read = false;
    this.#modelRead = false;
    this.#connection = { state: "connecting" };
    this.#subscription = this.client.subscribe((signal) => this.#signal(signal));
    this.refresh();
  }

  /** Read everything again (`Mend: Refresh`). */
  refresh(): void {
    this.#pendingAll = true;
    this.#schedule();
  }

  model(): WindowModel | null {
    return this.#model;
  }

  /** The last read failure that was not the server being unreachable; null when reads succeed. */
  error(): unknown {
    return this.#error;
  }

  viewer(): string | null {
    return this.#snapshot.viewer;
  }

  details(): ReadonlyArray<ProjectDetail> {
    return [...this.#snapshot.details.values()];
  }

  find(sessionId: string): { readonly project: Project; readonly session: Session } | null {
    for (const detail of this.#snapshot.details.values()) {
      const session = detail.sessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) return { project: detail.project, session };
    }
    return null;
  }

  /** The adopted project this window's folder is a clone of. */
  windowProject(): { readonly project: Project; readonly folder: vscode.WorkspaceFolder } | null {
    return this.#windowProject;
  }

  /**
   * The session this window is the workspace of: the one its Open meant, as the window found it
   * (`open-intent.ts`); until then the workspace's live session. Null in any other window.
   */
  windowSessionId(): string | null {
    if (this.role.kind !== "workspace") return null;
    const found = sessionOfWorkspace(this.details(), this.role.workspaceId);
    return this.workspace.session()?.session.id ?? (found.kind === "found" ? found.session.id : null);
  }

  /** Sessions this window shows now: selected in its view, or the window's own. */
  showing(): ReadonlySet<string> {
    const own = this.windowSessionId();
    return new Set([...this.#selected, ...(own === null ? [] : [own])]);
  }

  /** The view's selection changed: a selected session is looked at now. */
  select(sessionIds: ReadonlyArray<string>): void {
    this.#selected = sessionIds;
    this.#emit();
  }

  #signal(signal: StreamSignal): void {
    switch (signal.kind) {
      case "opened":
        this.#heard();
        this.#pendingAll = true;
        this.#schedule();
        return;
      case "heard":
        this.#heard();
        return;
      case "event":
        this.#pending.push(signal.event);
        this.#schedule();
        return;
      case "lost":
        this.#offline();
        return;
    }
  }

  #heard(): void {
    this.#lastHeardAt = new Date().toISOString();
    const wasOffline = this.#connection.state !== "online";
    this.#connection = { state: "online", lastHeardAt: this.#lastHeardAt };
    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
    if (wasOffline) this.#emit();
  }

  #offline(): void {
    if (this.#connection.state === "offline") return;
    this.#connection = { state: "offline", lastHeardAt: this.#lastHeardAt };
    this.#ticker ??= setInterval(() => this.#emit(), OFFLINE_TICK_MS);
    this.#emit();
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const all = this.#pendingAll || !this.#read;
      const plan = all
        ? { all: true, projects: new Set<string>(), sessions: new Set<string>() }
        : readPlan(this.#pending);
      this.#pendingAll = false;
      this.#pending = [];
      // One read at a time: a frame that lands mid-read is read after it, never beside it.
      this.#reading = this.#reading.then(() => this.#apply(plan));
    }, DEBOUNCE_MS);
  }

  async #apply(plan: ReadPlan): Promise<void> {
    try {
      if (plan.all) await this.#readAll();
      else {
        for (const projectId of plan.projects) await this.#readProject(projectId);
        for (const sessionId of plan.sessions) await this.#readSession(sessionId);
      }
      this.#error = null;
      this.#heard();
    } catch (cause) {
      if (cause instanceof MendApiError && cause.status === null) this.#offline();
      else this.#error = cause;
    }
    this.#emit();
  }

  async #readAll(): Promise<void> {
    const connection = await this.client.connection();
    if (connection.url !== this.#serverUrl) {
      this.#serverUrl = connection.url;
      this.#lastSeen = this.#loadLastSeen(connection.url);
    }
    const projects = await this.client.listProjects();
    const details = await Promise.all(
      projects.map((project) => this.client.projectDetail(project.id)),
    );
    const viewer = await this.client.viewerId();
    const members = viewer === null ? [] : await this.client.memberNames();
    const sessions = details.flatMap((detail) => detail.sessions);
    const waits = new Map<string, WaitFact>();
    const landings = new Map<string, LandingFact>();
    await Promise.all(
      sessions.map(async (session) => {
        const facts = await this.#factsOf(session);
        if (facts.wait !== null) waits.set(session.id, facts.wait);
        if (facts.landing !== null) landings.set(session.id, facts.landing);
      }),
    );
    this.#snapshot = {
      projects,
      details: new Map(details.map((detail) => [detail.project.id, detail])),
      viewer,
      members,
      waits,
      landings,
    };
    this.#read = true;
    await this.#matchWindow();
    this.#prune();
    void vscode.commands.executeCommand("setContext", "mend.hasProjects", projects.length > 0);
  }

  async #readProject(projectId: string): Promise<void> {
    const known = this.#snapshot.details.get(projectId);
    if (known === undefined) {
      this.#pendingAll = true;
      this.#schedule();
      return;
    }
    const detail = await this.client.projectDetail(projectId);
    const changed = detail.sessions.filter((session) => {
      const before = known.sessions.find((candidate) => candidate.id === session.id);
      return (
        before === undefined ||
        before.status !== session.status ||
        before.settledAt !== session.settledAt ||
        session.status === "waiting"
      );
    });
    const facts = await Promise.all(
      changed.map(async (session) => ({ id: session.id, ...(await this.#factsOf(session)) })),
    );
    const details = new Map(this.#snapshot.details);
    details.set(projectId, detail);
    this.#snapshot = { ...this.#withFacts(facts), details };
  }

  async #readSession(sessionId: string): Promise<void> {
    let detail: SessionDetail;
    try {
      detail = await this.client.sessionDetail(sessionId);
    } catch (cause) {
      // A session removed, or one this person no longer sees: it leaves the view.
      if (cause instanceof MendApiError && (cause.status === 404 || cause.status === 403)) {
        this.#drop(sessionId);
        return;
      }
      throw cause;
    }
    const { session } = detail;
    const project = this.#snapshot.details.get(session.projectId);
    if (project === undefined) {
      this.#pendingAll = true;
      this.#schedule();
      return;
    }
    const facts = { id: session.id, ...(await this.#factsOf(session, detail)) };
    const sessions = project.sessions.some((candidate) => candidate.id === session.id)
      ? project.sessions.map((candidate) => (candidate.id === session.id ? session : candidate))
      : [...project.sessions, session];
    const details = new Map(this.#snapshot.details);
    details.set(project.project.id, { ...project, sessions });
    this.#snapshot = { ...this.#withFacts([facts]), details };
  }

  #drop(sessionId: string): void {
    const details = new Map(
      [...this.#snapshot.details].map(([id, detail]) => [
        id,
        { ...detail, sessions: detail.sessions.filter((session) => session.id !== sessionId) },
      ]),
    );
    this.#snapshot = {
      ...this.#withFacts([{ id: sessionId, wait: null, landing: null }]),
      details,
    };
  }

  #withFacts(
    facts: ReadonlyArray<{
      readonly id: string;
      readonly wait: WaitFact | null;
      readonly landing: LandingFact | null;
    }>,
  ): Snapshot {
    const waits = new Map(this.#snapshot.waits);
    const landings = new Map(this.#snapshot.landings);
    for (const { id, wait, landing } of facts) {
      if (wait === null) waits.delete(id);
      else waits.set(id, wait);
      if (landing === null) landings.delete(id);
      else landings.set(id, landing);
    }
    return { ...this.#snapshot, waits, landings };
  }

  /**
   * What a row needs beyond the project view: why a waiting session waits (its terminal agent's
   * report, else its conversation's pending request), and the landing of one that settled since
   * this VS Code first read the server. Older settled sessions read without their landing, so a
   * morning's read costs a request per session that is news, not one per session ever run.
   */
  async #factsOf(
    session: Session,
    known?: SessionDetail,
  ): Promise<{ readonly wait: WaitFact | null; readonly landing: LandingFact | null }> {
    let wait: WaitFact | null = null;
    if (session.status === "waiting") {
      wait = terminalWait(known ?? (await this.client.sessionDetail(session.id)));
      if (wait === null) {
        wait = conversationWait(await this.client.pendingRequests(session.id).catch(() => []));
      }
    }
    const news =
      SETTLED.has(session.status) &&
      session.settledAt !== null &&
      Date.parse(session.settledAt) > Date.parse(this.#lastSeen.baseline);
    const landing = news ? await this.client.landing(session.id).catch(() => null) : null;
    return { wait, landing };
  }

  async #matchWindow(): Promise<void> {
    if (this.role.kind === "workspace") {
      this.#windowProject = null;
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const resolution = matchProject(this.#snapshot.projects, await repositoryFacts(folder));
      if (resolution.status === "matched") {
        this.#windowProject = { project: resolution.project, folder };
        return;
      }
    }
    this.#windowProject = null;
  }

  #loadLastSeen(url: string): LastSeen {
    const stored = this.context.globalState.get<unknown>(LAST_SEEN_KEY);
    const entry = typeof stored === "object" && stored !== null ? Reflect.get(stored, url) : null;
    if (isLastSeen(entry)) return entry;
    const fresh: LastSeen = { baseline: new Date().toISOString(), sessions: {} };
    this.#saveLastSeen(url, fresh);
    return fresh;
  }

  #saveLastSeen(url: string, lastSeen: LastSeen): void {
    const stored = this.context.globalState.get<unknown>(LAST_SEEN_KEY);
    const all = typeof stored === "object" && stored !== null ? { ...stored } : {};
    void this.context.globalState.update(LAST_SEEN_KEY, { ...all, [url]: lastSeen });
  }

  /** Sessions no longer on the server are forgotten, so the record stays the size of the view. */
  #prune(): void {
    const known = new Set(this.details().flatMap((detail) => detail.sessions.map((s) => s.id)));
    const kept = Object.fromEntries(
      Object.entries(this.#lastSeen.sessions).filter(([id]) => known.has(id)),
    );
    if (Object.keys(kept).length === Object.keys(this.#lastSeen.sessions).length) return;
    this.#lastSeen = { ...this.#lastSeen, sessions: kept };
    if (this.#serverUrl !== null) this.#saveLastSeen(this.#serverUrl, this.#lastSeen);
  }

  #emit(): void {
    const now = new Date();
    // What this VS Code shows while it is focused is looked at now (Decided 3).
    if (vscode.window.state.focused && this.#read) {
      const showing = [...this.showing()].filter((id) => this.find(id) !== null);
      const next = seen(this.#lastSeen, showing, now);
      if (next !== this.#lastSeen) {
        this.#lastSeen = next;
        if (this.#serverUrl !== null) this.#saveLastSeen(this.#serverUrl, next);
      }
    }
    const prev = this.#modelRead ? this.#model : null;
    const next = sessionModel({
      projects: this.#snapshot.projects,
      details: this.details(),
      viewer: this.#snapshot.viewer,
      members: this.#snapshot.members,
      waits: this.#snapshot.waits,
      landings: this.#snapshot.landings,
      lastSeen: this.#lastSeen,
      connection: this.#connection,
      window:
        this.role.kind === "workspace"
          ? { kind: "workspace", sessionId: this.windowSessionId() }
          : { kind: "local" },
      now,
    });
    this.#model = next;
    this.#modelRead = this.#read;
    void vscode.commands.executeCommand("setContext", "mend.offline", next.offline);
    this.#changed.fire({ prev, next });
  }
}
