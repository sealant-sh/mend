import * as vscode from "vscode";

import { MendApiError, matchProject, type MendClient, type StreamSignal } from "./client.js";
import { repositoryFacts } from "./git.js";
import type { MemberName } from "./session-lines.js";
import {
  mergeLastSeen,
  seen,
  sessionModel,
  type Connection,
  type LandingFact,
  type LastSeen,
  type WaitFact,
  type WindowModel,
} from "./session-model.js";
import {
  conversationWait,
  limited,
  readPlan,
  readsAnything,
  terminalWait,
  type ReadPlan,
} from "./session-reads.js";
import type { Project, ProjectDetail, Session, SessionDetail } from "./types.js";
import { sessionOfWorkspace, type WindowRole } from "./window-role.js";

/** `globalState` key: `LastSeen` per server URL, on this machine only. */
const LAST_SEEN_KEY = "mend.lastSeen";
const DEBOUNCE_MS = 150;
/** However busy the stream, what it announced is read within this long of its first frame. */
export const MAX_WAIT_MS = 1_000;
/** Reads start in batches at least this far apart, however fast Mend answers. */
export const MIN_GAP_MS = 250;
/** At most this many reads at once: a full read fans out per project and per session. */
export const FAN_OUT = 6;
/**
 * A full read asks for the landings of sessions settled within this long; a session's own frame
 * asks whatever its age. The reads stay the size of a week's work, not of every session ever run.
 */
export const LANDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** While offline, `last seen 2 min ago` is said again each half minute. */
const OFFLINE_TICK_MS = 30_000;
/** A read that failed is tried again after this long: no frame may ever come to retry it. */
const RETRY_MS = 5_000;

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);

/** What the store reads from Mend. */
export type StoreClient = Pick<
  MendClient,
  | "connection"
  | "listProjects"
  | "projectDetail"
  | "viewerId"
  | "memberNames"
  | "sessionDetail"
  | "pendingRequests"
  | "landing"
  | "subscribe"
>;

/** Where the store keeps what this VS Code last looked at: the extension's `globalState`. */
export interface LastSeenMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** The window's own session, and the session whose agent terminal is in front here. */
export interface WindowSessions {
  session(): { readonly session: Session } | null;
  /** The session whose agent tab is this window's active terminal (Answer shows it there). */
  terminalSession(): string | null;
  readonly onDidLocate: vscode.Event<void>;
}

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

type Facts = {
  readonly id: string;
  readonly wait: WaitFact | null;
  readonly landing: LandingFact | null;
};

export interface StoreChange {
  readonly prev: WindowModel | null;
  readonly next: WindowModel;
}

const isLastSeen = (value: unknown): value is LastSeen => {
  if (typeof value !== "object" || value === null) return false;
  const sessions: unknown = Reflect.get(value, "sessions");
  return (
    typeof Reflect.get(value, "baseline") === "string" &&
    typeof sessions === "object" &&
    sessions !== null &&
    Object.values(sessions).every((at) => typeof at === "string")
  );
};

/** Mend refused this sign-in: what it read before is no longer hers to see. */
const refusedSignIn = (cause: unknown): boolean =>
  cause instanceof MendApiError && cause.status === 401;

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
  /** A selection shows a session only while the view is on screen. */
  #visible = false;
  /** Bumped by `start()`: a read begun for an earlier sign-in or server is dropped when it lands. */
  #generation = 0;
  #retry: NodeJS.Timeout | null = null;
  #windowProject: { readonly project: Project; readonly folder: vscode.WorkspaceFolder } | null =
    null;
  /** What frames asked for and no read has begun on: each named once, however many frames. */
  #wantAll = false;
  readonly #wantProjects = new Set<string>();
  readonly #wantSessions = new Set<string>();
  /** When the oldest wish not yet read arrived: its read starts by `MAX_WAIT_MS` after it. */
  #wantedSince: number | null = null;
  #lastWantAt = 0;
  #lastBatchAt = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | null = null;
  /** Sessions read now, one read each: a frame meanwhile reads that session again after it. */
  readonly #reading = new Set<string>();
  /**
   * A full or project read runs. It reads alone: it rewrites sessions, and a session read beside
   * it could land older words over newer ones.
   */
  #readingAlone = false;
  /** The stream was refused: its reconnects are refused alike, and are read again only once. */
  #refused = false;
  #ticker: NodeJS.Timeout | null = null;
  #subscription: vscode.Disposable | null = null;
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly context: { readonly globalState: LastSeenMemento },
    private readonly client: StoreClient,
    private readonly role: WindowRole,
    private readonly workspace: WindowSessions,
  ) {
    this.#disposables = [
      this.#changed,
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.#emit();
      }),
      vscode.window.onDidChangeActiveTerminal(() => this.#emit()),
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
    if (this.#retry !== null) clearTimeout(this.#retry);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** Subscribe and read everything; again after a sign-in or a new server. */
  start(): void {
    this.#subscription?.dispose();
    this.#generation += 1;
    this.#invalidate();
    this.#refused = false;
    this.#connection = { state: "connecting" };
    this.#wantProjects.clear();
    this.#wantSessions.clear();
    this.#subscription = this.client.subscribe((signal) => this.#signal(signal));
    this.refresh();
  }

  /** Read everything again (`Mend: Refresh`). */
  refresh(): void {
    this.#want({ all: true, projects: new Set(), sessions: new Set() });
  }

  /** Whether a read has landed: before it, the view says nothing rather than guess. */
  hasRead(): boolean {
    return this.#read;
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

  /**
   * The session an id names, from the last read when it has it, else from Mend: a session just
   * created, or one a link names before the first read lands. Null when Mend has none she sees.
   */
  async locate(
    sessionId: string,
  ): Promise<{ readonly project: Project; readonly session: Session } | null> {
    const known = this.find(sessionId);
    if (known !== null) return known;
    let session: Session;
    try {
      ({ session } = await this.client.sessionDetail(sessionId));
    } catch (cause) {
      if (cause instanceof MendApiError && (cause.status === 404 || cause.status === 403))
        return null;
      throw cause;
    }
    const project =
      this.#snapshot.projects.find((candidate) => candidate.id === session.projectId) ??
      (await this.client.projectDetail(session.projectId)).project;
    this.#want({ all: false, projects: new Set(), sessions: new Set([sessionId]) });
    return { project, session };
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
    // Through window-role's rule with the window's own choice, so the view and the window agree:
    // a session the window asked for that is gone shows nothing, as the window attaches nothing.
    const intended = this.workspace.session()?.session.id ?? null;
    const found = sessionOfWorkspace(this.details(), this.role.workspaceId, intended);
    return found.kind === "found" ? found.session.id : null;
  }

  /**
   * Sessions this window shows now: selected in its view while it is on screen, its own, and the
   * one whose agent terminal is in front here.
   */
  showing(): ReadonlySet<string> {
    return new Set(
      [
        ...(this.#visible ? this.#selected : []),
        this.windowSessionId(),
        this.workspace.terminalSession(),
      ].flatMap((id) => (id === null ? [] : [id])),
    );
  }

  /** The view came on screen or left it. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#emit();
  }

  /** The view's selection changed: a selected session is looked at now. */
  select(sessionIds: ReadonlyArray<string>): void {
    this.#selected = sessionIds;
    this.#emit();
  }

  #signal(signal: StreamSignal): void {
    switch (signal.kind) {
      case "opened":
        this.#refused = false;
        this.#heard();
        this.refresh();
        return;
      case "heard":
        this.#heard();
        return;
      case "event": {
        const plan = readPlan([signal.event]);
        if (readsAnything(plan)) this.#want(plan);
        return;
      }
      case "refused":
        this.#heard();
        if (this.#refused) return;
        this.#refused = true;
        this.refresh();
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

  /** Adds to what the next reads read, and makes sure they come. */
  #want(plan: ReadPlan): void {
    if (plan.all) this.#wantAll = true;
    for (const id of plan.projects) this.#wantProjects.add(id);
    for (const id of plan.sessions) this.#wantSessions.add(id);
    this.#lastWantAt = Date.now();
    this.#wantedSince ??= this.#lastWantAt;
    this.#schedule();
  }

  /** Whether what is wanted needs a read alone: a full read, or a project's. */
  #wantsAlone(): boolean {
    return this.#wantAll || this.#wantProjects.size > 0 || !this.#read;
  }

  /** Whether a read could begin now on what is wanted, or must wait for one running to end. */
  #startable(): boolean {
    if (this.#readingAlone) return false;
    if (!this.#wantAll && this.#wantProjects.size === 0 && this.#wantSessions.size === 0)
      return false;
    if (this.#wantsAlone()) return this.#reading.size === 0;
    return (
      this.#reading.size < FAN_OUT && [...this.#wantSessions].some((id) => !this.#reading.has(id))
    );
  }

  /**
   * Arms the next batch: `DEBOUNCE_MS` after the last frame, by `MAX_WAIT_MS` after the oldest one
   * not yet read, and never within `MIN_GAP_MS` of the last batch. A read that ends arms it again
   * for what it held back.
   */
  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#startable()) return;
    const now = Date.now();
    const due = Math.max(
      this.#lastBatchAt + MIN_GAP_MS,
      Math.min(this.#lastWantAt + DEBOUNCE_MS, (this.#wantedSince ?? now) + MAX_WAIT_MS),
    );
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#startBatch();
      },
      Math.max(0, due - now),
    );
  }

  /**
   * Begins what can begin of what is wanted: a full or project read alone, else a read for each
   * wanted session not read now, up to `FAN_OUT`, side by side so a slow one holds back none.
   */
  #startBatch(): void {
    if (!this.#startable()) return;
    this.#lastBatchAt = Date.now();
    if (this.#wantsAlone()) {
      const whole = this.#wantAll || !this.#read;
      const projects = new Set(this.#wantProjects);
      // A frame's own session keeps its own read inside a full one: a landing however old.
      const targets = whole ? new Set(this.#wantSessions) : new Set<string>();
      this.#wantAll = false;
      this.#wantProjects.clear();
      if (whole) this.#wantSessions.clear();
      this.#readingAlone = true;
      void this.#apply((generation) =>
        whole ? this.#readAll(generation, targets) : this.#readProjects(projects, generation),
      ).finally(() => {
        this.#readingAlone = false;
        this.#schedule();
      });
    } else {
      for (const id of this.#wantSessions) {
        if (this.#reading.size >= FAN_OUT) break;
        if (this.#reading.has(id)) continue;
        this.#wantSessions.delete(id);
        this.#reading.add(id);
        void this.#apply((generation) => this.#readSession(id, generation)).finally(() => {
          this.#reading.delete(id);
          this.#schedule();
        });
      }
    }
    if (!this.#wantAll && this.#wantProjects.size === 0 && this.#wantSessions.size === 0)
      this.#wantedSince = null;
  }

  async #readProjects(projects: ReadonlySet<string>, generation: number): Promise<void> {
    for (const projectId of projects) await this.#readProject(projectId, generation);
  }

  async #apply(read: (generation: number) => Promise<void>): Promise<void> {
    const generation = this.#generation;
    try {
      await read(generation);
      if (generation !== this.#generation) return;
      this.#error = null;
      this.#heard();
    } catch (cause) {
      if (generation !== this.#generation) return;
      if (cause instanceof MendApiError && cause.status === null) this.#offline();
      else this.#error = cause;
      if (refusedSignIn(cause)) this.#invalidate();
      this.#retryLater();
    }
    this.#emit();
  }

  /** Forgets what was read: nothing shows until a read lands, and no change of it toasts. */
  #invalidate(): void {
    this.#snapshot = EMPTY;
    this.#read = false;
    this.#modelRead = false;
  }

  #retryLater(): void {
    this.#retry ??= setTimeout(() => {
      this.#retry = null;
      this.refresh();
    }, RETRY_MS);
  }

  /** Everything again; `targets` are sessions a frame named, read as their own frame reads them. */
  async #readAll(generation: number, targets: ReadonlySet<string>): Promise<void> {
    const connection = await this.client.connection();
    if (connection.url !== this.#serverUrl) {
      this.#serverUrl = connection.url;
      this.#lastSeen = this.#loadLastSeen(connection.url);
    }
    const projects = await this.client.listProjects();
    const details = await limited(projects, FAN_OUT, (project) =>
      this.client.projectDetail(project.id),
    );
    // A failed read of who she is keeps the last answer: it must not make every session hers.
    const viewer = (await this.client.viewerId()) ?? this.#snapshot.viewer;
    const named = viewer === null ? [] : await this.client.memberNames();
    const members = named.length === 0 ? this.#snapshot.members : named;
    const facts = await limited(
      details.flatMap((detail) => detail.sessions),
      FAN_OUT,
      async (session) => ({
        id: session.id,
        ...(await this.#factsOf(session, targets.has(session.id) ? "any" : "recent")),
      }),
    );
    if (generation !== this.#generation) return;
    const waits = new Map<string, WaitFact>();
    const landings = new Map<string, LandingFact>();
    for (const { id, wait, landing } of facts) {
      if (wait !== null) waits.set(id, wait);
      if (landing !== null) landings.set(id, landing);
    }
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

  async #readProject(projectId: string, generation: number): Promise<void> {
    const known = this.#snapshot.details.get(projectId);
    if (known === undefined) {
      this.refresh();
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
    const facts = await limited(changed, FAN_OUT, async (session) => ({
      id: session.id,
      ...(await this.#factsOf(session, "recent")),
    }));
    if (generation !== this.#generation) return;
    const details = new Map(this.#snapshot.details);
    details.set(projectId, detail);
    this.#snapshot = { ...this.#withFacts(facts), details };
  }

  async #readSession(sessionId: string, generation: number): Promise<void> {
    let detail: SessionDetail;
    try {
      detail = await this.client.sessionDetail(sessionId);
    } catch (cause) {
      // A session removed, or one this person no longer sees: it leaves the view.
      if (cause instanceof MendApiError && (cause.status === 404 || cause.status === 403)) {
        if (generation === this.#generation) this.#drop(sessionId);
        return;
      }
      throw cause;
    }
    const { session } = detail;
    if (!this.#snapshot.details.has(session.projectId)) {
      this.refresh();
      return;
    }
    // Its own frame may be a landing, however long ago the session settled.
    const facts = { id: session.id, ...(await this.#factsOf(session, "any", detail)) };
    if (generation !== this.#generation) return;
    // As it is now: other sessions' reads ran beside this one and changed the project meanwhile.
    const project = this.#snapshot.details.get(session.projectId);
    if (project === undefined) return;
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
    const waits = new Map(this.#snapshot.waits);
    const landings = new Map(this.#snapshot.landings);
    waits.delete(sessionId);
    landings.delete(sessionId);
    this.#snapshot = { ...this.#snapshot, details, waits, landings };
  }

  #withFacts(facts: ReadonlyArray<Facts>): Snapshot {
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
   * report, else its conversation's pending request), and the landing of a settled session. A
   * full read asks only sessions settled within `LANDING_WINDOW_MS` (`recent`) and keeps what it
   * knew of older ones; a session's own frame asks whatever its age (`any`). A fact whose read
   * failed keeps what was known, so the same wait is never raised again as new.
   */
  async #factsOf(
    session: Session,
    landings: "recent" | "any",
    known?: SessionDetail,
  ): Promise<{ readonly wait: WaitFact | null; readonly landing: LandingFact | null }> {
    const before = {
      wait: this.#snapshot.waits.get(session.id) ?? null,
      landing: this.#snapshot.landings.get(session.id) ?? null,
    };
    let wait: WaitFact | null = null;
    // An idle terminal agent keeps its finished turn's report: its row says it in G4's words.
    if (session.status === "waiting" || session.status === "idle") {
      wait = terminalWait(known ?? (await this.client.sessionDetail(session.id)));
      if (wait === null && session.status === "waiting") {
        const requests = await this.client.pendingRequests(session.id).catch(() => null);
        wait = requests === null ? before.wait : conversationWait(requests);
      }
    }
    if (!SETTLED.has(session.status) || session.settledAt === null) return { wait, landing: null };
    const recent = Date.now() - Date.parse(session.settledAt) < LANDING_WINDOW_MS;
    if (landings === "recent" && !recent) return { wait, landing: before.landing };
    const landing = await this.client.landing(session.id).then(
      (read) => read,
      () => before.landing,
    );
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

  /**
   * Every window of this VS Code writes the same record (Decided 3: per machine), so each emit
   * merges what the others saved, adds what this window shows while it is focused, and saves only
   * when that moved something.
   */
  #syncLastSeen(url: string, now: Date): LastSeen {
    const stored = this.context.globalState.get(LAST_SEEN_KEY);
    const entry = typeof stored === "object" && stored !== null ? Reflect.get(stored, url) : null;
    const merged = isLastSeen(entry) ? mergeLastSeen(entry, this.#lastSeen) : this.#lastSeen;
    const showing =
      vscode.window.state.focused && this.#read
        ? [...this.showing()].filter((id) => this.find(id) !== null)
        : [];
    const next = seen(merged, showing, now);
    if (!isLastSeen(entry) || JSON.stringify(entry) !== JSON.stringify(next))
      this.#saveLastSeen(url, next);
    return next;
  }

  #loadLastSeen(url: string): LastSeen {
    const stored = this.context.globalState.get(LAST_SEEN_KEY);
    const entry = typeof stored === "object" && stored !== null ? Reflect.get(stored, url) : null;
    if (isLastSeen(entry)) return entry;
    const fresh: LastSeen = { baseline: new Date().toISOString(), sessions: {} };
    this.#saveLastSeen(url, fresh);
    return fresh;
  }

  #saveLastSeen(url: string, lastSeen: LastSeen): void {
    const stored = this.context.globalState.get(LAST_SEEN_KEY);
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
    if (this.#serverUrl !== null) this.#lastSeen = this.#syncLastSeen(this.#serverUrl, now);
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
