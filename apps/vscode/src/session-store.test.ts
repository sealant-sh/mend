import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import type { EventPointer, PendingRequest, StreamSignal } from "./client.js";
import { MendApiError } from "./mend-http.js";
import type { MemberName } from "./session-lines.js";
import type { LandingFact } from "./session-model.js";
import {
  FAN_OUT,
  MAX_WAIT_MS,
  MIN_GAP_MS,
  SessionStore,
  type StoreClient,
  type WindowSessions,
} from "./session-store.js";
import { Notifier } from "./session-surfaces.js";
import { pendingRequest } from "./test-requests.js";
import { EventEmitter, fake, window } from "./test-vscode.js";
import { layoutOf } from "./tree-layout.js";
import {
  HandoffProvenance,
  type Project,
  type ProjectDetail,
  type Session,
  type SessionDetail,
  type SessionProcess,
  type Worktree,
} from "./types.js";

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
): EventPointer => ({ type, sessionId, projectId: newsroom.id, changeId: null, facet });

/** A Mend server in memory: what it holds now, what it was asked, and reads held back on demand. */
class FakeMend implements StoreClient {
  projects: Array<Project> = [newsroom];
  readonly sessions = new Map<string, Session>();
  readonly requests = new Map<string, ReadonlyArray<PendingRequest>>();
  readonly landings = new Map<string, LandingFact>();
  readonly processes = new Map<string, ReadonlyArray<SessionProcess>>();
  readonly worktrees = new Map<string, ReadonlyArray<Worktree>>();
  /** Every read refuses this sign-in. */
  refusing = false;
  /** Pending-request reads fail. */
  requestsFail = false;
  readonly failing = new Set<string>();
  readonly calls: Array<string> = [];
  /** When each call was made, on the test's clock. */
  readonly made: Array<{ readonly call: string; readonly at: number }> = [];
  /** How long reads of a kind take, on the test's clock. */
  readonly latency = new Map<string, number>();
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
    this.made.push({ call, at: Date.now() });
    this.#running.set(kind, (this.#running.get(kind) ?? 0) + 1);
    this.most.set(kind, Math.max(this.most.get(kind) ?? 0, this.#running.get(kind) ?? 0));
    try {
      if (this.#holding.has(call) || this.#holding.has(kind))
        await new Promise<void>((resume) => {
          const key = this.#holding.has(call) ? call : kind;
          this.#held.set(key, [...(this.#held.get(key) ?? []), resume]);
        });
      const takes = this.latency.get(kind);
      if (takes !== undefined) await new Promise((resume) => setTimeout(resume, takes));
      if (this.refusing) throw new MendApiError("Signed out — sign in again.", 401);
      if (this.failing.has(call)) throw new MendApiError("Mend failed.", 500);
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
        worktrees: this.worktrees.get(id) ?? [],
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
  const notifier = new Notifier(
    store,
    { claim: async () => true, release: async () => undefined },
    { offer: async () => ({ kind: "none" }), relaunch: async () => ({ kind: "held" }) },
    { chose: async () => {} },
  );
  store.onDidChange((change) => notifier.changed(change));
  return { mend, here, store };
};

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const wordOf = (store: SessionStore, id: string) => store.model()?.sessions.get(id)?.word;

const lineOf = (store: SessionStore, id: string) => store.model()?.sessions.get(id)?.line;

const emissions = (store: SessionStore) => {
  const seen: Array<unknown> = [];
  store.onDidChange((change) => seen.push(change));
  return seen;
};

const toasts = () => window.showInformationMessage.mock.calls.map(([text]) => text);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  fake.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what this VS Code last looked at (Decided 3)", () => {
  it("is written only when a session she looks at holds news she has not seen", async () => {
    const saved = memento();
    let writes = 0;
    const counted = {
      get: saved.get,
      update: async (key: string, value: unknown) => {
        if (key === "mend.lastSeen") writes += 1;
        await saved.update(key, value);
      },
    };
    const mend = new FakeMend();
    const store = new SessionStore(
      { globalState: counted },
      mend,
      { kind: "local" },
      new FakeWindow(),
    );
    mend.add(session({ id: "done", status: "completed", settledAt: "2026-10-19T08:00:00.000Z" }));
    store.start();
    await tick(200);
    store.setVisible(true);
    store.select(["done"]);
    const before = writes;
    for (let emit = 0; emit < 5; emit += 1) {
      await tick(1_000);
      store.setVisible(true);
    }
    expect(writes).toBe(before);
    expect(store.model()?.sessions.get("done")?.sinceYouLastLooked).toBe(false);
  });
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

describe("how fast the store reads (B3, round 3)", () => {
  it("reads a session streaming a frame every 10 ms at most once per MAX_WAIT_MS", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "busy" }));
    mend.latency.set("detail", 20);
    store.start();
    await tick(300);
    const from = Date.now();
    for (let elapsed = 0; elapsed < 2_000; elapsed += 10) {
      mend.signal({ kind: "event", event: event("session-process", "busy") });
      await tick(10);
    }
    const reads = mend.made.filter(({ call, at }) => call === "detail:busy" && at >= from);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.length).toBeLessThanOrEqual(Math.ceil(2_000 / MAX_WAIT_MS));
    for (const [index, read] of reads.entries()) {
      const before = reads[index - 1];
      if (before !== undefined) expect(read.at - before.at).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
  });

  it("reads another session within MAX_WAIT_MS while one session's read is held", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "slow" }), session({ id: "other" }));
    store.start();
    await tick(300);
    mend.hold("detail:slow");
    mend.signal({ kind: "event", event: event("session", "slow") });
    await tick(300);
    expect(mend.count("detail:slow")).toBe(1);
    mend.add(
      session({ id: "other", status: "completed", settledAt: new Date(Date.now()).toISOString() }),
    );
    mend.signal({ kind: "event", event: event("session", "other") });
    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 10) {
      mend.signal({ kind: "event", event: event("session-process", "slow") });
      await tick(10);
    }
    expect(wordOf(store, "other")).toBe("completed");
    expect(mend.count("detail:slow")).toBe(1);
  });

  it("keeps both of two sessions read side by side in one project", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "a" }), session({ id: "b" }));
    store.start();
    await tick(300);
    mend.add(session({ id: "a", status: "waiting" }), session({ id: "b", status: "failed" }));
    mend.requests.set("a", [pendingRequest({ sessionId: "a", createdAt: START.toISOString() })]);
    mend.hold("requests:a");
    mend.signal({ kind: "event", event: event("session", "a") });
    mend.signal({ kind: "event", event: event("session", "b") });
    await tick(300);
    expect(wordOf(store, "b")).toBe("failed");
    mend.release("requests:a");
    await tick(300);
    expect([wordOf(store, "a"), wordOf(store, "b")]).toEqual(["waiting", "failed"]);
  });

  it("reads at most FAN_OUT sessions at once", async () => {
    const { mend, store } = world();
    const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
    mend.add(...ids.map((id) => session({ id })));
    store.start();
    await tick(300);
    mend.hold("detail");
    for (const id of ids) mend.signal({ kind: "event", event: event("session", id) });
    await tick(300);
    expect(mend.most.get("detail")).toBe(FAN_OUT);
    mend.release("detail");
    await tick(300);
    expect(ids.every((id) => mend.count(`detail:${id}`) === 1)).toBe(true);
  });
});

/** How long after `from` the first read of session `id` began; infinite if none did. */
const firstRead = (mend: FakeMend, id: string, from: number) =>
  (mend.made.find(({ call, at }) => call === `detail:${id}` && at >= from)?.at ??
    Number.POSITIVE_INFINITY) - from;

describe("a session this window created (flow 3)", () => {
  it("shows its row at once and reads it within MIN_GAP_MS", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    const created = session({ id: "new", status: "starting" });
    mend.add(created);
    const from = Date.now();
    store.showCreated(created);
    expect(wordOf(store, "new")).toBe("starting");
    mend.add(session({ id: "new", status: "running" }));
    await tick(MIN_GAP_MS);
    expect(firstRead(mend, "new", from)).toBeLessThanOrEqual(MIN_GAP_MS);
    expect(wordOf(store, "new")).toBe("running");
  });

  it("reads it within MAX_WAIT_MS while another session streams a frame every 10 ms", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "busy" }));
    store.start();
    await tick(300);
    const busy = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        mend.signal({ kind: "event", event: event("session-process", "busy") });
        await tick(10);
      }
    };
    await busy(500);
    const created = session({ id: "new", status: "starting" });
    mend.add(created);
    const from = Date.now();
    store.showCreated(created);
    await busy(MAX_WAIT_MS);
    expect(firstRead(mend, "new", from)).toBeLessThanOrEqual(MAX_WAIT_MS);
  });
});

describe("a session's frame read together with a full read (S6, round 3)", () => {
  it("still reads the session's landing, however long ago it settled", async () => {
    const { mend, store } = world();
    const settled = new Date(START.getTime() - 30 * DAY).toISOString();
    mend.add(session({ id: "last-month", status: "completed", settledAt: settled }));
    store.start();
    await tick(300);
    mend.landings.set("last-month", {
      id: "l1",
      userId: "ana",
      createdAt: new Date(Date.now()).toISOString(),
      remoteBranch: "mend/last-month",
      pullRequest: { number: 415, state: "merged" },
    });
    store.refresh();
    mend.signal({ kind: "event", event: event("session-change", "last-month") });
    await tick(300);
    expect(mend.count("landing:last-month")).toBe(1);
    expect(store.model()?.sessions.get("last-month")?.line).toBe(
      "landed by Ana · pull request #415 · merged · observed",
    );
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

  it("reads at most FAN_OUT sessions' facts at once in a full read", async () => {
    const { mend, store } = world();
    const ids = Array.from({ length: 20 }, (_, index) => `w${index}`);
    mend.add(...ids.map((id) => session({ id, status: "waiting" })));
    mend.hold("detail");
    store.start();
    await tick(300);
    expect(mend.most.get("detail")).toBe(FAN_OUT);
    mend.release("detail");
    await tick(300);
    expect(ids.every((id) => mend.count(`detail:${id}`) === 1)).toBe(true);
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
  const request = pendingRequest();

  it("toasts a wait once, only when Mend has read why it waits", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }));
    store.start();
    await tick(300);
    mend.add(session({ id: "s", status: "waiting" }));
    mend.requests.set("s", [request]);
    mend.requestsFail = true;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(300);
    expect(toasts()).toEqual([]);
    mend.requestsFail = false;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(300);
    mend.requestsFail = true;
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(300);
    expect(toasts()).toEqual(["s asks: run pnpm db:migrate?"]);
    expect(store.model()?.sessions.get("s")?.needsYou).toBe(true);
  });

  it("toasts only while this window is focused, and not later for the same wait", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s" }), session({ id: "t" }));
    store.start();
    await tick(300);
    fake.focus(false);
    mend.add(session({ id: "s", status: "waiting" }));
    mend.requests.set("s", [request]);
    mend.signal({ kind: "event", event: event("agent-conversation", "s") });
    await tick(300);
    fake.focus(true);
    mend.add(session({ id: "t", status: "waiting" }));
    mend.requests.set("t", [{ ...request, id: "r-t" }]);
    mend.signal({ kind: "event", event: event("agent-conversation", "t") });
    await tick(300);
    expect(toasts()).toEqual(["t asks: run pnpm db:migrate?"]);
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
    expect(toasts()).toEqual(["t asks: run pnpm db:migrate?"]);
  });
});

describe("a session read again for an answer (story b)", () => {
  it("resolves once the read landed, so the row says what the server says now", async () => {
    const { mend, store } = world();
    mend.add(session({ id: "s", status: "waiting" }));
    mend.requests.set("s", [pendingRequest()]);
    store.start();
    await tick(300);
    mend.add(session({ id: "s", status: "running", summary: "pnpm db:migrate" }));
    mend.requests.set("s", []);
    mend.hold("detail:s");
    const landed = vi.fn();
    const reread = store.reread("s").then(landed);
    await tick(300);
    expect(landed).not.toHaveBeenCalled();
    mend.release("detail:s");
    await tick(0);
    await reread;
    expect(landed).toHaveBeenCalledTimes(1);
    expect(store.model()?.sessions.get("s")?.line).toBe("running · pnpm db:migrate");
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
        runsAs: null,
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

  it("tells whoever follows the frames to read again when the stream reopens", async () => {
    const { mend, store } = world();
    const heard: Array<string> = [];
    store.onDidHearEvent((frame) => heard.push(frame.type));
    store.start();
    await tick(200);
    mend.signal({ kind: "opened" });
    expect(heard).toEqual(["resync"]);
  });
});

describe("a handoff this window received (story g)", () => {
  const CUT_AT = "2026-10-19T08:42:05.000Z";
  const fixLogin: Worktree = {
    id: "w1",
    name: "fix-login",
    directory: "/store/newsroom-api/worktrees/fix-login",
    branch: "fix-login",
    baseSha: "a".repeat(40),
    baseRef: "refs/heads/main",
    createdAt: CUT_AT,
    handoff: Schema.decodeUnknownSync(HandoffProvenance)({
      machine: "dana-mbp",
      cutAt: CUT_AT,
      checkpoint: "b".repeat(40),
    }),
  };
  const received = session({ id: "1a2b3c4d", label: null, worktreeId: "w1", status: "idle" });
  const receipt = { session: received, worktree: fixLogin };
  const HANDED_OFF = "idle · handed off from dana-mbp";

  const serverHolds = (mend: FakeMend, one: Session = received) => {
    mend.add(one);
    mend.worktrees.set(one.projectId, [fixLogin]);
  };

  it("shows the row in one emission for a project already read, and reads that project", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    const emitted = emissions(store);
    const before = mend.count(`project:${newsroom.id}`);
    serverHolds(mend);
    store.recordHandoff(newsroom, receipt);
    expect(emitted).toHaveLength(1);
    expect(store.model()?.sessions.get(received.id)?.name).toBe("fix-login");
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
    expect(store.find(received.id)?.project.id).toBe(newsroom.id);
    await tick(300);
    expect(mend.count(`project:${newsroom.id}`)).toBe(before + 1);
    expect(mend.count("projects")).toBe(1);
  });

  it("shows the row and its project in one emission for a project not read yet", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    const billing: Project = { ...newsroom, id: "p2", name: "billing" };
    const elsewhere = { ...received, projectId: billing.id };
    const emitted = emissions(store);
    mend.projects = [newsroom, billing];
    serverHolds(mend, elsewhere);
    store.recordHandoff(billing, { session: elsewhere, worktree: fixLogin });
    expect(emitted).toHaveLength(1);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
    expect(store.find(received.id)?.project.id).toBe(billing.id);
    await tick(300);
    expect(mend.count("projects")).toBe(2);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
  });

  it("keeps the row through a read that began before it, and a read begun after confirms it", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    mend.hold(`project:${newsroom.id}`);
    store.refresh();
    await tick(300);
    store.recordHandoff(newsroom, receipt);
    mend.release(`project:${newsroom.id}`);
    mend.hold(`project:${newsroom.id}`);
    await tick(300);
    expect(mend.count("projects")).toBe(2);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
    serverHolds(mend);
    mend.release(`project:${newsroom.id}`);
    await tick(300);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
    mend.sessions.delete(received.id);
    store.refresh();
    await tick(300);
    expect(store.find(received.id)).toBeNull();
  });

  it("keeps the receipt's session over a read of everything begun before it that lands after", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    serverHolds(mend, { ...received, status: "starting" });
    mend.hold(`project:${newsroom.id}`);
    store.refresh();
    await tick(300);
    store.recordHandoff(newsroom, receipt);
    mend.release(`project:${newsroom.id}`);
    mend.hold(`project:${newsroom.id}`);
    await tick(300);
    expect(mend.count("projects")).toBe(2);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
  });

  it("keeps the receipt's session over a read of it alone begun before it that lands after", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    serverHolds(mend, { ...received, status: "starting" });
    mend.hold(`detail:${received.id}`);
    mend.signal({ kind: "event", event: event("session", received.id) });
    await tick(300);
    mend.hold(`project:${newsroom.id}`);
    store.recordHandoff(newsroom, receipt);
    mend.release(`detail:${received.id}`);
    await tick(300);
    expect(mend.count(`detail:${received.id}`)).toBe(1);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
  });

  it("keeps the receipt when a read of the session begun before it finds it gone", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    mend.hold(`detail:${received.id}`);
    mend.signal({ kind: "event", event: event("session", received.id) });
    await tick(300);
    mend.hold(`project:${newsroom.id}`);
    store.recordHandoff(newsroom, receipt);
    mend.release(`detail:${received.id}`);
    await tick(300);
    expect(mend.count(`detail:${received.id}`)).toBe(1);
    expect(store.find(received.id)?.session).toEqual(received);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
  });

  it("draws the row before the first read of everything lands", async () => {
    const { mend, store } = world();
    mend.hold("projects");
    store.start();
    await tick(300);
    store.recordHandoff(newsroom, receipt);
    const tree = layoutOf({
      model: store.model(),
      hasRead: store.hasRead(),
      error: null,
      viewer: store.viewer(),
    });
    const rows = [...tree.values()]
      .flat()
      .flatMap(({ node }) =>
        node.kind === "session" ? [[node.place, node.view.name, node.view.line]] : [],
      );
    expect(rows).toEqual([
      ["running", "fix-login", HANDED_OFF],
      ["projects:p1", "fix-login", HANDED_OFF],
    ]);
  });

  it("takes the session from a read of it begun after the receipt, and keeps where it came from", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    serverHolds(mend, { ...received, status: "running" });
    mend.failing.add(`project:${newsroom.id}`);
    store.recordHandoff(newsroom, receipt);
    await tick(300);
    expect(mend.count(`project:${newsroom.id}`)).toBe(2);
    expect(lineOf(store, received.id)).toBe(HANDED_OFF);
    mend.signal({ kind: "event", event: event("session", received.id) });
    await tick(300);
    expect(mend.count(`detail:${received.id}`)).toBe(1);
    const row = store.model()?.sessions.get(received.id);
    expect(row?.line).toBe("running");
    expect(row?.name).toBe("fix-login");
    expect(row?.provenance).toMatch(/^handed off from dana-mbp at \d\d:\d\d$/u);
  });

  it("forgets it on a new connection: the receipt was the last server's", async () => {
    const { mend, store } = world();
    store.start();
    await tick(300);
    store.recordHandoff(newsroom, receipt);
    expect(store.find(received.id)).not.toBeNull();
    store.stop();
    mend.hold("projects");
    store.start();
    await tick(300);
    expect(store.find(received.id)).toBeNull();
  });
});
