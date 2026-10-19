import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import type { EventPointer, PendingRequest, StreamSignal } from "./client.js";
import { MendApiError } from "./mend-http.js";
import type { MemberName } from "./session-lines.js";
import type { LandingFact } from "./session-model.js";
import {
  FAN_OUT,
  MAX_WAIT_MS,
  SessionStore,
  type StoreClient,
  type WindowSessions,
} from "./session-store.js";
import { Notifier } from "./session-surfaces.js";
import { EventEmitter, fake, window } from "./test-vscode.js";
import type { Project, ProjectDetail, Session, SessionDetail, SessionProcess } from "./types.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-10-19T09:00:00.000Z");

const newsroom: Project = {
  id: "p1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (overrides: Partial<Session> & Pick<Session, "id">): Session => ({
  projectId: newsroom.id,
  harness: "claude",
  model: null,
  label: overrides.id,
  worktree: overrides.id,
  branch: `mend/${overrides.id}`,
  status: "running",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-18T20:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  ...overrides,
});

const event = (
  type: string,
  sessionId: string | null,
  facet: string | null = null,
): EventPointer => ({ type, sessionId, projectId: newsroom.id, facet });

/** A Mend server in memory: what it holds now, what it was asked, and reads held back on demand. */
class FakeMend implements StoreClient {
  projects: Array<Project> = [newsroom];
  readonly sessions = new Map<string, Session>();
  readonly requests = new Map<string, ReadonlyArray<PendingRequest>>();
  readonly landings = new Map<string, LandingFact>();
  readonly processes = new Map<string, ReadonlyArray<SessionProcess>>();
  /** Every read refuses this sign-in. */
  refusing = false;
  /** Pending-request reads fail. */
  requestsFail = false;
  readonly calls: Array<string> = [];
  readonly #held = new Map<string, Array<() => void>>();
  readonly #holding = new Set<string>();
  #running = new Map<string, number>();
  readonly most = new Map<string, number>();
  signal: (signal: StreamSignal) => void = () => undefined;

  add(...sessions: ReadonlyArray<Session>): void {
    for (const one of sessions) this.sessions.set(one.id, one);
  }

  hold(call: string): void {
    this.#holding.add(call);
  }

  release(call: string): void {
    this.#holding.delete(call);
    for (const resume of this.#held.get(call) ?? []) resume();
    this.#held.delete(call);
  }

  count(call: string): number {
    return this.calls.filter((made) => made === call).length;
  }

  async #read<T>(call: string, kind: string, answer: () => T): Promise<T> {
    this.calls.push(call);
    this.#running.set(kind, (this.#running.get(kind) ?? 0) + 1);
    this.most.set(kind, Math.max(this.most.get(kind) ?? 0, this.#running.get(kind) ?? 0));
    try {
      if (this.#holding.has(call) || this.#holding.has(kind))
        await new Promise<void>((resume) => {
          const key = this.#holding.has(call) ? call : kind;
          this.#held.set(key, [...(this.#held.get(key) ?? []), resume]);
        });
      if (this.refusing) throw new MendApiError("Signed out — sign in again.", 401);
      return answer();
    } finally {
      this.#running.set(kind, (this.#running.get(kind) ?? 1) - 1);
    }
  }

  async connection(): Promise<{ readonly url: string; readonly token: string | null }> {
    return { url: "http://mend.test", token: "token" };
  }

  listProjects(): Promise<ReadonlyArray<Project>> {
    return this.#read("projects", "projects", () => this.projects);
  }

  projectDetail(id: string): Promise<ProjectDetail> {
    return this.#read(`project:${id}`, "project", () => {
      const project = this.projects.find((candidate) => candidate.id === id);
      if (project === undefined) throw new MendApiError("no project", 404);
      return {
        project,
        sessions: [...this.sessions.values()].filter((one) => one.projectId === id),
      };
    });
  }

  viewerId(): Promise<string | null> {
    return this.#read("viewer", "viewer", () => "dana");
  }

  memberNames(): Promise<ReadonlyArray<MemberName>> {
    return this.#read("members", "members", () => [
      { userId: "dana", name: "Dana" },
      { userId: "ana", name: "Ana" },
    ]);
  }

  sessionDetail(id: string): Promise<SessionDetail> {
    return this.#read(`detail:${id}`, "detail", () => {
      const found = this.sessions.get(id);
      if (found === undefined) throw new MendApiError("no session", 404);
      return {
        session: found,
        processes: this.processes.get(id) ?? [],
        currentAgent: null,
        changeId: null,
      };
    });
  }

  pendingRequests(id: string): Promise<ReadonlyArray<PendingRequest>> {
    return this.#read(`requests:${id}`, "requests", () => {
      if (this.requestsFail) throw new MendApiError("requests failed", 500);
      return this.requests.get(id) ?? [];
    });
  }

  landing(id: string): Promise<LandingFact | null> {
    return this.#read(`landing:${id}`, "landing", () => this.landings.get(id) ?? null);
  }

  subscribe(onSignal: (signal: StreamSignal) => void): vscode.Disposable {
    this.signal = onSignal;
    return { dispose: () => undefined };
  }
}

class FakeWindow implements WindowSessions {
  terminal: string | null = null;
  readonly #located = new EventEmitter<void>();
  readonly onDidLocate = this.#located.event;

  session(): null {
    return null;
  }

  terminalSession(): string | null {
    return this.terminal;
  }
}

const memento = () => {
  const values = new Map<string, unknown>();
  return {
    get: (key: string): unknown => values.get(key),
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
  };
};

const world = () => {
  const mend = new FakeMend();
  const here = new FakeWindow();
  const store = new SessionStore({ globalState: memento() }, mend, { kind: "local" }, here);
  const notifier = new Notifier(store, { claim: async () => true });
  store.onDidChange((change) => notifier.changed(change));
  return { mend, here, store };
};

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const wordOf = (store: SessionStore, id: string) => store.model()?.sessions.get(id)?.word;

const toasts = () => window.showInformationMessage.mock.calls.map(([text]) => text);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  fake.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frames the view reads (B3)", () => {
  it("reads another session's change within the max wait while one session streams frames", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "busy" }), session({ id: "other" }));
    store.start();
    await tick(200);
    mend.add(
      session({ id: "other", status: "completed", settledAt: new Date(Date.now()).toISOString() }),
    );
    mend.signal({ kind: "event", event: event("session", "other") });
    for (let elapsed = 0; elapsed < MAX_WAIT_MS + 100; elapsed += 50) {
      mend.signal({ kind: "event", event: event("session-process", "busy") });
      mend.signal({ kind: "event", event: event("session-progress", "busy") });
      await tick(50);
    }
    expect(wordOf(store, "other")).toBe("completed");
  });

  it("lets no progress line or comment hold back a read, or read anything itself", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "busy" }), session({ id: "other" }));
    store.start();
    await tick(200);
    const before = mend.calls.length;
    mend.add(session({ id: "other", status: "failed", settledAt: START.toISOString() }));
    mend.signal({ kind: "event", event: event("session", "other") });
    for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
      mend.signal({ kind: "event", event: event("session-progress", "busy") });
      mend.signal({ kind: "event", event: event("review-comment", null) });
      await tick(50);
      if (elapsed === 200) expect(wordOf(store, "other")).toBe("failed");
    }
    expect(mend.calls.slice(before)).toEqual(["detail:other", "landing:other"]);
  });
});

describe("how much the store reads (S5)", () => {
  it("reads a session once after a slow read, however many frames named it meanwhile", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "a" }));
    store.start();
    await tick(200);
    mend.hold("detail:a");
    mend.signal({ kind: "event", event: event("session", "a") });
    await tick(200);
    for (let frame = 0; frame < 4; frame += 1) {
      mend.signal({ kind: "event", event: event("session", "a") });
      await tick(200);
    }
    expect(mend.count("detail:a")).toBe(1);
    mend.release("detail:a");
    await tick(500);
    expect(mend.count("detail:a")).toBe(2);
  });

  it("reads at most FAN_OUT project details at once in a full read", async () => {
    const { mend, store } = world();
    mend.projects = Array.from({ length: 20 }, (_, index) => ({ ...newsroom, id: `p${index}` }));
    mend.hold("project");
    store.start();
    await tick(200);
    expect(mend.most.get("project")).toBe(FAN_OUT);
    mend.release("project");
    await tick(200);
    expect(mend.count("project:p19")).toBe(1);
    expect(store.hasRead()).toBe(true);
  });

  it("asks a full read for the landings of the last week only, and a session's frame for its own", async () => {
    const { mend, store } = world();
    const at = (ago: number) => new Date(START.getTime() - ago).toISOString();
    mend.add(
      session({ id: "yesterday", status: "completed", settledAt: at(DAY) }),
      session({ id: "last-month", status: "completed", settledAt: at(30 * DAY) }),
    );
    mend.landings.set("last-month", {
      id: "l1",
      userId: "ana",
      createdAt: at(0),
      remoteBranch: "mend/last-month",
      pullRequest: { number: 415, state: "merged" },
    });
    store.start();
    await tick(200);
    expect(mend.calls.filter((call) => call.startsWith("landing:"))).toEqual(["landing:yesterday"]);
    mend.signal({ kind: "event", event: event("session-change", "last-month") });
    await tick(200);
    expect(mend.count("landing:last-month")).toBe(1);
    expect(store.model()?.sessions.get("last-month")?.line).toBe(
      "landed by Ana · pull request #415 · merged · observed",
    );
  });
});

describe("an explicit session id (B2)", () => {
  it("finds a session a link names before the first read lands", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "linked" }));
    mend.hold("projects");
    store.start();
    await tick(200);
    expect(store.hasRead()).toBe(false);
    const found = await store.locate("linked");
    expect(found?.session.id).toBe("linked");
    expect(found?.project.id).toBe(newsroom.id);
  });

  it("finds a session created after the last read", async () => {
    const { mend, store } = world();
    store.start();
    await tick(200);
    mend.add(session({ id: "just-made", status: "starting" }));
    expect((await store.locate("just-made"))?.session.id).toBe("just-made");
    expect(await store.locate("nobody")).toBeNull();
  });
});

describe("wait facts and toasts (S1, S2)", () => {
  const request: PendingRequest = {
    id: "r1",
    title: "run pnpm db:migrate?",
    createdAt: "2026-10-19T08:59:00.000Z",
  };

  it("toasts a wait once, only when Mend has read why it waits", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }));
    store.start();
    await tick(200);
    mend.add(session({ id: "s", status: "waiting" }));
    mend.requests.set("s", [request]);
    mend.requestsFail = true;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(200);
    expect(toasts()).toEqual([]);
    mend.requestsFail = false;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(200);
    mend.requestsFail = true;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(200);
    expect(toasts()).toEqual(["s is waiting · run pnpm db:migrate?"]);
    expect(store.model()?.sessions.get("s")?.needsYou).toBe(true);
  });

  it("toasts only while this window is focused, and not later for the same wait", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }), session({ id: "t" }));
    store.start();
    await tick(200);
    fake.focus(false);
    mend.add(session({ id: "s", status: "waiting" }));
    mend.requests.set("s", [request]);
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(200);
    fake.focus(true);
    mend.add(session({ id: "t", status: "waiting" }));
    mend.requests.set("t", [{ ...request, id: "r-t" }]);
    mend.signal({ kind: "event", event: event("agent-conversation", "t") });
    await tick(200);
    expect(toasts()).toEqual(["t is waiting · run pnpm db:migrate?"]);
  });

  it("does not toast a wait whose agent terminal is in front in this window", async () => {
    const { mend, here, store } = world();
    mend.add(session({ id: "s" }), session({ id: "t" }));
    store.start();
    await tick(200);
    here.terminal = "s";
    for (const id of ["s", "t"]) {
      mend.add(session({ id, status: "waiting" }));
      mend.requests.set(id, [{ ...request, id: `r-${id}` }]);
      mend.signal({ kind: "event", event: event("agent-conversation", id) });
    }
    await tick(200);
    expect(toasts()).toEqual(["t is waiting · run pnpm db:migrate?"]);
  });
});

describe("a finished terminal turn (idle, #1089)", () => {
  it("reads the idle agent's report, and nothing needs her", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }));
    store.start();
    await tick(200);
    mend.add(session({ id: "s", status: "idle" }));
    mend.processes.set("s", [
      {
        id: "pty",
        kind: "agent-pty",
        harness: "claude",
        status: "running",
        exitedAt: null,
        providerSessionId: null,
        label: null,
        waiting: { kind: "prompt", tool: null, since: START.toISOString() },
      },
    ]);
    mend.signal({ kind: "event", event: event("session-process", "s") });
    await tick(200);
    expect(store.model()?.sessions.get("s")?.line).toBe("idle · claude finished its turn");
    expect(store.model()?.badge).toBe(0);
    expect(toasts()).toEqual([]);
  });
});

describe("access lost (S9)", () => {
  it("re-reads on the account's access event, forgets what it read, and says so once", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }));
    store.start();
    await tick(200);
    expect(store.model()?.sessions.size).toBe(1);
    mend.refusing = true;
    mend.signal({ kind: "event", event: event("user", null, "access") });
    await tick(200);
    expect(store.hasRead()).toBe(false);
    expect(store.model()?.sessions.size).toBe(0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mend.signal({ kind: "refused" });
      await tick(6_000);
    }
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "Signed out — sign in again.",
      "Connect to server",
    );
  });

  it("re-reads when the stream's reconnect is refused", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }));
    store.start();
    await tick(200);
    mend.refusing = true;
    mend.signal({ kind: "refused" });
    await tick(200);
    expect(store.model()?.sessions.size).toBe(0);
    expect(store.model()?.badge).toBe(0);
  });
});
