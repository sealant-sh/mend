import { beforeEach, describe, expect, it, vi } from "vitest";

import { MendApiError } from "../mend-http.js";
import { fake, window as vscodeWindow } from "../test-vscode.js";
import type { SessionDetail, SessionProcess } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import { DRAFT_GONE } from "./delivery.js";
import { textToSend } from "./instruction.js";
import { DRIVE_STALE_MS, KeptReviews, NODE_FILES } from "./kept-reviews.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import { reviewToast } from "./review-toast.js";
import type { ReadPass } from "./review-wire.js";
import {
  comment,
  FakeMend,
  keptIn,
  PINNED,
  PROJECT,
  session,
  sessionReads,
  slowFiles,
  storage,
} from "./test-fixtures.js";
import { threadsOf } from "./threads.js";

vi.mock("vscode", () => import("../test-vscode.js"));

const memento = (): ReviewMemento => {
  const saved = new Map<string, unknown>();
  return {
    get: (key: string) => saved.get(key),
    update: async (key: string, value: unknown) => {
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
};

const CLAUDE: SessionProcess = {
  id: "agent-1",
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  label: "claude",
  waiting: null,
  runsAs: null,
};

/** Dana's session `s1`, with claude live in its terminal, or exited. */
const withAgent = (agent: SessionProcess) => ({
  ...sessionReads("change-1"),
  sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
    session: { ...session(sessionId), ownerUserId: "dana" },
    processes: [agent],
    currentAgent: agent,
    changeId: "change-1",
  }),
});

/** A window: its store following `s1`, its pastes recorded, every paste reaching claude. */
const window = async (
  kept: KeptReviews,
  mend: FakeMend,
  reads: ReturnType<typeof withAgent> = withAgent(CLAUDE),
  pasted: Pasted = "pasted",
): Promise<{ readonly store: ReviewStore; readonly pastes: Array<string> }> => {
  const pastes: Array<string> = [];
  const store = new ReviewStore(
    reads,
    mend,
    new ReviewMemory(memento()),
    kept,
    async (_sessionId, processId, text) => {
      expect(processId).toBe("agent-1");
      pastes.push(text);
      return pasted;
    },
  );
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull());
  return { store, pastes };
};

/**
 * A wait on a drive through `slowFiles`: each read and write is held back, so with `slowFiles(20)` a
 * send takes 0.4 to 0.7 s to reach Mend or claude on an idle machine, most of the one-second default
 * before a loaded runner stretches it.
 */
const SLOW_DRIVE = { timeout: 5_000 };

const onLine = (line: number, body: string): NewComment => ({
  at: {
    worktreeId: "w1",
    path: "src/auth/limit.ts",
    at: PINNED.head.id,
    absent: false,
    slice: PINNED.id,
  },
  line,
  endLine: line,
  lineText: "",
  body,
});

beforeEach(() => {
  fake.reset();
});

/**
 * Waits until claude's input got `count` pastes and the store keeps its newest review as pasted, or
 * as one that pasted nothing: a paste lands before the store keeps it, and a review composed between
 * the two is composed onto nothing.
 */
const pastedInto = async (
  store: ReviewStore,
  pastes: ReadonlyArray<unknown>,
  count: number,
): Promise<void> =>
  vi.waitFor(() => {
    expect(pastes).toHaveLength(count);
    expect(store.review().sends.at(-1)?.phase).toMatchObject({ paste: { kind: "done" } });
  });

const failures = (store: ReviewStore): Array<ReviewFailure> => {
  const seen: Array<ReviewFailure> = [];
  store.onDidFail((failure) => seen.push(failure));
  return seen;
};

describe("Send review twice before she presses Enter in claude's terminal", () => {
  it("keeps her edited first review, adds only the new comments, and pastes only what is new", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(keptIn(await storage()), mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    const edited = first.text.replace(
      "Address each comment above",
      "Address each comment carefully",
    );
    expect(await store.send(first, edited)).toEqual({ sent: true });
    await pastedInto(store, pastes, 1);
    expect(pastes[0]).toContain("Address each comment carefully");

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    // Her first review, as she edited and sent it, once; then the new comment alone.
    expect(second.text.split("Use the shared limiter")).toHaveLength(2);
    expect(second.text).toContain("Address each comment carefully");
    expect(second.text).toContain("## 2 · src/auth/limit.ts:5");
    expect(await store.send(second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(2));
    // claude's input holds the first review; the second paste adds only what follows it.
    expect(pastes[1]).not.toContain("Use the shared limiter");
    expect(pastes[1]).toContain("Name the constant");
    // Mend holds the whole review under the newer key, her edits in it, for a retry to send.
    const newest = mend.delivered.at(-1);
    expect(newest?.instruction).toContain("Address each comment carefully");
    expect(newest?.instruction).toContain("Name the constant");
    expect(newest?.idempotencyKey).not.toBe(mend.delivered[0]?.idempotencyKey);
  });

  it("pastes nothing, and says why, when she changed the part VS Code already pasted into claude's terminal", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(keptIn(await storage()), mend);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await pastedInto(store, pastes, 1);
    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await store.send(second, second.text.replace("Use the shared limiter", "Use guard.ts"));
    await vi.waitFor(() => expect(told.map(({ words }) => words)).toHaveLength(1));
    expect(pastes).toHaveLength(1);
    expect(told[0]).toMatchObject({
      tone: "warning",
      words: expect.stringMatching(
        /already pasted into claude's terminal, so VS Code pasted nothing there\. Mend holds/,
      ),
    });
  });
});

describe("a third Send after one that pasted nothing", () => {
  it("pastes the comments the skipped Send never put in claude's input, onto what is there", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(keptIn(await storage()), mend);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await pastedInto(store, pastes, 1);

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await store.send(second, second.text.replace("Use the shared limiter", "Use guard.ts"));
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(pastes).toHaveLength(1);
    // Mend holds "Name the constant", and VS Code never pasted it: its thread says so once the
    // store reads the comment Mend posted.
    await vi.waitFor(() => {
      const read = store.ready();
      if (read === null) throw new Error("not read");
      const named = threadsOf(read, store.review(), "Dana").find(({ body }) =>
        body.includes("Name the constant"),
      );
      expect(named?.label).toBe("follow-up pending · not pasted into claude's terminal");
    });

    await store.comment(onLine(9, "Log the limit"));
    const third = store.compose();
    if (third === null) throw new Error("nothing composed");
    // Composed on top of what claude's input holds: the first review as it was pasted.
    expect(third.text).toContain("Use the shared limiter");
    expect(third.text).not.toContain("Use guard.ts");
    await store.send(third, third.text);
    await vi.waitFor(() => expect(pastes).toHaveLength(2));
    const input = pastes.join("");
    expect(input.split("Use the shared limiter")).toHaveLength(2);
    expect(input).toContain("Name the constant");
    expect(input).toContain("Log the limit");
    // What Mend holds is what her input holds once she presses Enter.
    expect(mend.delivered.at(-1)?.instruction).toBe(textToSend(input, "add-rate-limit"));
  });
});

describe("a Send whose earlier part changed only its line endings", () => {
  it("is not an edit: only the new comment is pasted", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(keptIn(await storage()), mend);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await pastedInto(store, pastes, 1);
    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await store.send(second, second.text.replaceAll("\n", "\r\n"));
    await vi.waitFor(() => expect(pastes).toHaveLength(2));
    expect(pastes[1]).toContain("Name the constant");
    expect(pastes[1]).not.toContain("Use the shared limiter");
    expect(told).toEqual([]);
  });
});

describe("the agent exits after Mend holds the review", () => {
  it("pastes nothing, says so, and offers Retry delivery to the stopped session", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(
      keptIn(await storage()),
      mend,
      withAgent(CLAUDE),
      "agent-gone",
    );
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await store.send(composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(pastes).toHaveLength(1);
    expect(told[0]?.words).toMatch(
      /claude exited before the review was pasted, so nothing was pasted/,
    );
    expect(told[0]?.retry).not.toBeNull();
    expect(store.review().sends.at(-1)?.phase).toEqual({ kind: "pending" });
  });
});

describe("a review with a draft dismissed while it is on its way", () => {
  it("stops before it is delivered, and Send review composes it again without that draft", async () => {
    const mend = new FakeMend();
    const draft = comment({
      id: "d1",
      state: "draft",
      author: { kind: "mend", name: "Mend" },
      body: "Nothing ran the tests after limit.ts changed.",
    });
    mend.serverComments = [draft];
    const { store } = await window(
      keptIn(await storage()),
      mend,
      withAgent({ ...CLAUDE, exitedAt: "now", status: "exited" }),
    );
    const told = failures(store);
    await store.accept("d1", "");
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(composed.text).toContain(draft.body);
    // Dismissed on Mend, on the web or in another window, before the review reaches it.
    mend.serverComments = mend.serverComments.map((one) =>
      one.id === "d1" ? { ...one, state: "dismissed" } : one,
    );
    await store.send(composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(mend.delivered).toEqual([]);
    expect(told[0]).toMatchObject({
      words: expect.stringContaining(DRAFT_GONE),
      text: expect.stringContaining(draft.body),
    });
    store.reread();
    await vi.waitFor(() => expect(store.compose()?.text).toContain("Use the shared limiter"));
    expect(store.compose()?.text).not.toContain(draft.body);
  });
});

describe("Ana's stopped terminal session, shared control on", () => {
  it("offers Dana no Send review, and says why", async () => {
    const exited = { ...CLAUDE, status: "exited", exitedAt: "2026-10-19T10:30:00.000Z" };
    const reads = {
      ...withAgent(exited),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
        session: {
          ...session(sessionId),
          ownerUserId: "ana",
          sharedControlEnabledAt: "2026-10-19T10:00:00.000Z",
        },
        processes: [exited],
        currentAgent: exited,
        changeId: "change-1",
      }),
      memberNames: async () => [
        { userId: "dana", name: "Dana" },
        { userId: "ana", name: "Ana" },
      ],
    };
    const mend = new FakeMend();
    mend.serverComments = [comment({ id: "c1" })];
    const { store } = await window(keptIn(await storage()), mend, reads);
    expect(store.offer()).toEqual({
      kind: "disabled",
      why: "Ana's session starts its agent in a terminal with a review · only Ana sends it one",
    });
  });
});

describe("two windows send one review at once", () => {
  it("record one key, and Mend gets one follow-up", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    const a = await window(keptIn(directory, slowFiles(20)), mend);
    const b = await window(keptIn(directory, slowFiles(20)), mend);
    await a.store.comment(onLine(3, "Use the shared limiter"));
    await b.store.reloadReview();
    const fromA = a.store.compose();
    const fromB = b.store.compose();
    if (fromA === null || fromB === null) throw new Error("nothing composed");
    const sent = await Promise.all([
      a.store.send(fromA, fromA.text),
      b.store.send(fromB, fromB.text),
    ]);
    expect(sent.filter((one) => one.sent)).toHaveLength(1);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SLOW_DRIVE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(new Set(mend.delivered.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1);
    expect(mend.writes.filter((write) => write.startsWith("post "))).toHaveLength(1);
  });
});

describe("a comment edited after the review was composed", () => {
  it("reads as changed: nothing is sent, and her text stays", async () => {
    const mend = new FakeMend();
    const { store } = await window(keptIn(await storage()), mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    const [mine] = store.review().pending;
    if (composed === null || mine === undefined) throw new Error("nothing composed");
    await store.edit(mine.id, "Use guard.ts instead");
    expect(await store.send(composed, composed.text)).toEqual({
      sent: false,
      words: expect.stringMatching(/Your comments changed since this review was composed/),
    });
    expect(mend.delivered).toEqual([]);
  });
});

describe("two windows, one review of comments already open on Mend", () => {
  it("record one key when both send it at once", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" }), comment({ id: "c2", line: 13 })];
    const a = await window(keptIn(directory, slowFiles(20)), mend);
    const b = await window(keptIn(directory, slowFiles(20)), mend);
    const fromA = a.store.compose();
    const fromB = b.store.compose();
    if (fromA === null || fromB === null) throw new Error("nothing composed");
    const sent = await Promise.all([
      a.store.send(fromA, fromA.text),
      b.store.send(fromB, fromB.text),
    ]);
    expect(sent.filter((one) => one.sent)).toHaveLength(1);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SLOW_DRIVE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mend.delivered).toHaveLength(1);
  });
});

describe("a comment edited in another window after this one composed the review", () => {
  it("reads as changed: nothing is sent with the old words", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    const a = await window(keptIn(directory), mend);
    const b = await window(keptIn(directory), mend);
    await a.store.comment(onLine(3, "Use the shared limiter"));
    await b.store.reloadReview();
    const composed = a.store.compose();
    const [theirs] = b.store.review().pending;
    if (composed === null || theirs === undefined) throw new Error("nothing composed");
    await b.store.edit(theirs.id, "Use guard.ts instead");
    expect(await a.store.send(composed, composed.text)).toMatchObject({ sent: false });
    expect(mend.delivered).toEqual([]);
  });
});

describe("Retry from the toast when nothing was pasted", () => {
  const claims = {
    claim: async () => true,
    release: async () => undefined,
  };

  it("delivers the same key to the stopped session once claude exited before the paste", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    let agent: SessionProcess = CLAUDE;
    const reads = {
      ...withAgent(CLAUDE),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
        session: { ...session(sessionId), ownerUserId: "dana" },
        processes: [agent],
        currentAgent: agent,
        changeId: "change-1",
      }),
    };
    const { store } = await window(keptIn(await storage()), mend, reads, "agent-gone");
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await store.send(composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    agent = { ...CLAUDE, status: "exited", exitedAt: "2026-10-20T10:00:00.000Z" };
    mend.answer = "delivering";
    vscodeWindow.showErrorMessage.mockResolvedValueOnce("Retry delivery");
    const [failure] = told;
    if (failure === undefined) throw new Error("no failure");
    await reviewToast(store, claims, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/claude exited before the review was pasted/),
      "Retry delivery",
    );
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(2));
    expect(mend.delivered[1]?.idempotencyKey).toBe(mend.delivered[0]?.idempotencyKey);
  });

  it("pastes again into the live agent when its terminal could not be attached here", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const pastes: Array<string> = [];
    const answers: Array<Pasted> = ["not-attached", "pasted"];
    const store = new ReviewStore(
      withAgent(CLAUDE),
      mend,
      new ReviewMemory(memento()),
      keptIn(await storage()),
      async (_sessionId, _processId, text) => {
        pastes.push(text);
        return answers.shift() ?? "pasted";
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull());
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await store.send(composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]?.retry).not.toBeNull();
    vscodeWindow.showErrorMessage.mockResolvedValueOnce("Retry delivery");
    const [failure] = told;
    if (failure === undefined) throw new Error("no failure");
    await reviewToast(store, claims, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not attach claude's terminal here/),
      "Retry delivery",
    );
    await vi.waitFor(() => expect(pastes).toHaveLength(2));
    expect(pastes[1]).toBe(pastes[0]);
    expect(mend.delivered).toHaveLength(1);
    await vi.waitFor(() =>
      expect(store.review().sends.at(-1)?.phase).toMatchObject({
        kind: "in-terminal",
        paste: { kind: "done" },
      }),
    );
  });

  it("sends nothing, and says so, once the review it offered to retry reads sent", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const directory = await storage();
    const { store } = await window(keptIn(directory), mend, withAgent(CLAUDE), "agent-gone");
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await store.send(composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    const [failure] = told;
    if (failure === undefined || failure.retry === null) throw new Error("no retry offered");
    const { place } = failure.retry;
    // The toast is up; meanwhile Retry from the section delivered it, and Mend reads it sent.
    vscodeWindow.showErrorMessage.mockImplementationOnce(async () => {
      await keptIn(directory).update(place, (review) => ({
        ...review,
        sends: review.sends.map((record) => ({
          ...record,
          phase: { kind: "delivered", at: "2026-10-20T10:05:00.000Z" },
        })),
      }));
      return "Retry delivery";
    });
    await reviewToast(store, claims, () => undefined)(failure);
    expect(mend.delivered).toHaveLength(1);
    expect(vscodeWindow.setStatusBarMessage).toHaveBeenCalledWith(
      "Retry delivery sent nothing: this review already reads sent",
      expect.any(Number),
    );
  });
});

/** Mend whose read pass of the change is whatever the test last set. */
class ReadingMend extends FakeMend {
  pass: ReadPass | null = null;

  override async readPass(): Promise<ReadPass | null> {
    return this.pass;
  }

  override async readChange(): Promise<void> {
    this.writes.push("read");
  }
}

describe("a read Mend could not finish, its toast waiting while she starts another", () => {
  it("shows nothing once the newer read is running", async () => {
    const mend = new ReadingMend();
    const { store } = await window(keptIn(await storage()), mend);
    const told = failures(store);
    await store.readChange();
    mend.pass = {
      kind: "failed",
      startedAt: "2026-10-20T10:00:00.000Z",
      at: "2026-10-20T10:00:05.000Z",
      words: "the model timed out",
    };
    store.reread();
    await vi.waitFor(() => expect(told).toHaveLength(1));
    const [failure] = told;
    if (failure === undefined) throw new Error("no failure");
    expect(failure.words).toBe("Mend could not read this change: the model timed out");
    // The toast waits on its claim; meanwhile she reads the change again, and Mend is reading it.
    const claims = {
      claim: async () => {
        mend.pass = { kind: "reading", since: "2026-10-20T10:01:00.000Z" };
        store.reread();
        await vi.waitFor(() => expect(store.ready()?.pass?.kind).toBe("reading"));
        return true;
      },
      release: async () => undefined,
    };
    await reviewToast(store, claims, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe("a window that loads its kept reviews while another window sends one", () => {
  it("leaves that send to the window sending it: Mend gets it, claude's input gets it, and nothing reads failed", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    // Slow files, as a loaded machine's: the second window is still loading when the first sends.
    const a = await window(keptIn(directory, slowFiles(60)), mend);
    const b = await window(keptIn(directory, slowFiles(60)), mend);
    const told = failures(a.store);
    const fromA = a.store.compose();
    if (fromA === null) throw new Error("nothing composed");
    expect(await a.store.send(fromA, fromA.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1), SLOW_DRIVE);
    expect(mend.delivered).toHaveLength(1);
    expect(told).toEqual([]);
    await b.store.reloadReview();
    expect(b.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["in-terminal"]);
  }, 30_000);

  it("leaves a send it reads before that window's drive began to that window", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const { promise: claiming, resolve: claims } = Promise.withResolvers<void>();
    const { promise: allowed, resolve: allow } = Promise.withResolvers<void>();
    // The first window's drive lease waits to be made until the second window has loaded.
    const a = await window(
      keptIn(directory, {
        ...NODE_FILES,
        create: async (path, text) => {
          if (path.endsWith(".drive")) {
            claims();
            await allowed;
          }
          await NODE_FILES.create(path, text);
        },
      }),
      mend,
    );
    const told = failures(a.store);
    const fromA = a.store.compose();
    if (fromA === null) throw new Error("nothing composed");
    const sent = a.store.send(fromA, fromA.text);
    await claiming;
    const { promise: loaded, resolve: load } = Promise.withResolvers<void>();
    const b = await window(
      keptIn(directory, {
        ...NODE_FILES,
        rm: async (path) => {
          await NODE_FILES.rm(path);
          if (path.endsWith(".lock")) load();
        },
      }),
      mend,
    );
    await loaded;
    allow();
    expect(await sent).toEqual({ sent: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1));
    expect(told).toEqual([]);
    await b.store.reloadReview();
    expect(b.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["in-terminal"]);
  });

  it("leaves a failed send that window's Retry claims while this one waits to load it", async () => {
    const directory = await storage();
    const mend = new FailsThenHolds();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const a = await window(keptIn(directory), mend);
    const told = failures(a.store);
    const fromA = a.store.compose();
    if (fromA === null) throw new Error("nothing composed");
    await a.store.send(fromA, fromA.text);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    const target = a.store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");

    // The second window reads the failed send undriven, then waits on the lock to load it.
    const { promise: locking, resolve: lock } = Promise.withResolvers<void>();
    const { promise: allowed, resolve: allow } = Promise.withResolvers<void>();
    const { promise: loaded, resolve: load } = Promise.withResolvers<void>();
    let first = true;
    await window(
      keptIn(directory, {
        ...NODE_FILES,
        create: async (path, text) => {
          if (first && path.endsWith(".lock")) {
            first = false;
            lock();
            await allowed;
          }
          await NODE_FILES.create(path, text);
        },
        rm: async (path) => {
          await NODE_FILES.rm(path);
          if (path.endsWith(".lock")) load();
        },
      }),
      mend,
    );
    await locking;
    // Meanwhile Retry delivery claims the send here, keeps it sending, and asks Mend again.
    const retried = a.store.retry(target);
    await mend.reached;
    allow();
    await loaded;
    mend.answers();
    expect(await retried).toEqual({ retried: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1));
    expect(mend.delivered.map(({ idempotencyKey }) => idempotencyKey)).toEqual([target.key]);
    // The one failure said is the first delivery's; nothing reads VS Code closed.
    expect(told).toHaveLength(1);
    expect(told[0]?.words).toMatch(/^Mend could not deliver the review: .*Mend is restarting/);
    const kept = await keptIn(directory).read(target.place);
    expect(kept.review.sends.map(({ phase }) => phase.kind)).toEqual(["in-terminal"]);
  });
});

/** Mend that never answers a follow-up it was asked to deliver, as one a window closed on. */
class Unanswered extends FakeMend {
  readonly #asked = Promise.withResolvers<void>();
  /** Settles once a follow-up reaches Mend. */
  readonly asked = this.#asked.promise;

  override async deliver(): ReturnType<FakeMend["deliver"]> {
    this.#asked.resolve();
    return new Promise(() => undefined);
  }
}

describe("a window reloaded while its send was on its way to Mend", () => {
  it("reads the send failed, with Retry delivery, once the closed window's lease goes stale", async () => {
    const directory = await storage();
    const mend = new Unanswered();
    mend.serverComments = [comment({ id: "c1" })];
    const closing = await window(keptIn(directory), mend);
    const fromClosing = closing.store.compose();
    if (fromClosing === null) throw new Error("nothing composed");
    await closing.store.send(fromClosing, fromClosing.text);
    await mend.asked;

    // The reloaded window loads while the closed window's lease is still fresh, and leaves it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let late = 0;
      const { promise: loaded, resolve: load } = Promise.withResolvers<void>();
      const reloaded = await window(
        new KeptReviews(
          directory,
          {
            ...NODE_FILES,
            rm: async (path) => {
              await NODE_FILES.rm(path);
              if (path.endsWith(".lock")) load();
            },
          },
          () => Date.now() + late,
        ),
        mend,
      );
      await loaded;
      expect(reloaded.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["sending"]);
      late += DRIVE_STALE_MS;
      await vi.advanceTimersByTimeAsync(DRIVE_STALE_MS);
      vi.useRealTimers();
      await vi.waitFor(() =>
        expect(reloaded.store.review().sends.map(({ phase }) => phase)).toEqual([
          { kind: "failed", words: "VS Code closed before Mend answered" },
        ]),
      );
      expect(reloaded.store.offer()).toEqual({ kind: "retry" });
      expect(reloaded.store.retryTarget()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Mend whose first follow-up fails on its side, and whose next waits until the test answers it. */
class FailsThenHolds extends FakeMend {
  #failing = true;
  readonly #reached = Promise.withResolvers<void>();
  readonly #answered = Promise.withResolvers<void>();
  /** Settles once a follow-up after the failed one reaches Mend. */
  readonly reached = this.#reached.promise;

  answers(): void {
    this.#answered.resolve();
  }

  override async deliver(
    ...args: Parameters<FakeMend["deliver"]>
  ): ReturnType<FakeMend["deliver"]> {
    if (this.#failing) {
      this.#failing = false;
      throw new MendApiError("Mend is restarting", 503);
    }
    this.#reached.resolve();
    await this.#answered.promise;
    return super.deliver(...args);
  }
}

describe("a second window sends a review composed before the first window's went out", () => {
  it("sends nothing once the first was pasted into claude's terminal, and a new review with more still goes", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" }), comment({ id: "c2", line: 13 })];
    const a = await window(keptIn(directory, slowFiles(20)), mend);
    const b = await window(keptIn(directory, slowFiles(20)), mend);
    const fromA = a.store.compose();
    const fromB = b.store.compose();
    if (fromA === null || fromB === null) throw new Error("nothing composed");
    expect(await a.store.send(fromA, fromA.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1), SLOW_DRIVE);
    await vi.waitFor(
      () => expect(a.store.review().sends.at(-1)?.phase).toMatchObject({ paste: { kind: "done" } }),
      SLOW_DRIVE,
    );
    expect(await b.store.send(fromB, fromB.text)).toMatchObject({ sent: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mend.delivered).toHaveLength(1);
    expect(b.pastes).toEqual([]);

    await b.store.reloadReview();
    await b.store.comment(onLine(5, "Name the constant"));
    const more = b.store.compose();
    if (more === null) throw new Error("nothing composed");
    expect(await b.store.send(more, more.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(b.pastes).toHaveLength(1), SLOW_DRIVE);
    expect(b.pastes[0]).toContain("Name the constant");
    expect(b.pastes[0]).not.toContain(fromA.text.split("\n")[0]);
  });
});

/** Mend whose next few comment POSTs, as many as it holds, each wait until the test lets one land. */
class SlowPosts extends FakeMend {
  /** Every comment POST asked for, by body, as it was asked. */
  readonly asked: Array<string> = [];
  held = 0;
  readonly #waiting: Array<() => void> = [];

  override async postComment(
    ...args: Parameters<FakeMend["postComment"]>
  ): ReturnType<FakeMend["postComment"]> {
    this.asked.push(args[3]);
    if (this.held > 0) {
      this.held -= 1;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#waiting.push(resolve);
      await promise;
    }
    return super.postComment(...args);
  }

  /** The oldest waiting POST lands. */
  land(): void {
    this.#waiting.shift()?.();
  }
}

describe("a window whose send another window took over while a POST was on its way", () => {
  it("posts nothing more once that POST lands, and the review is delivered once", async () => {
    const directory = await storage();
    const server = new SlowPosts();
    server.answer = "pending";
    server.held = 2;
    let late = 0;
    const clock = (): number => Date.now() + late;
    const a = await window(new KeptReviews(directory, NODE_FILES, clock), server);
    await a.store.comment(onLine(3, "Use the shared limiter"));
    await a.store.comment(onLine(7, "Name the retry budget"));
    const composed = a.store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await a.store.send(composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(server.asked).toHaveLength(1));
    // Its POST outlasts its lease, as from a window asleep: a window opened now reads the send as
    // abandoned, and Retry delivery drives it.
    late += DRIVE_STALE_MS + 1_000;
    const b = await window(new KeptReviews(directory, NODE_FILES, clock), server);
    const target = b.store.retryTarget();
    if (target === null) throw new Error("the other window offers no retry");
    const retried = b.store.retry(target);
    await vi.waitFor(() => expect(server.asked).toHaveLength(2));
    server.land();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.asked).toHaveLength(2);
    // Nor does it record that POST: the other window records this send now.
    const kept = await keptIn(directory).read(target.place);
    expect(
      kept.review.sends[0]?.items.map((item) => (item.kind === "own" ? item.post.kind : item.kind)),
    ).toEqual(["posting", "unposted"]);
    server.land();
    await retried;
    await vi.waitFor(() => expect(server.delivered).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.asked.filter((body) => body.includes("Name the retry budget"))).toHaveLength(1);
    expect(server.delivered).toHaveLength(1);
  });
});

/** The store reads the session again until it sees this claude process live. */
const sees = async (store: ReviewStore, processId: string): Promise<void> => {
  store.reread();
  await vi.waitFor(() => {
    const agent = store.ready()?.facts.agent;
    expect(agent?.kind === "terminal" ? agent.processId : null).toBe(processId);
  });
};

describe("claude is replaced between two Sends, before she pressed Enter", () => {
  const CLAUDE_2: SessionProcess = { ...CLAUDE, id: "agent-2" };

  /** Dana's session `s1`, its live claude the one last `replace`d in. */
  const replaceable = () => {
    let agent = CLAUDE;
    return {
      replace: (next: SessionProcess) => {
        agent = next;
      },
      reads: {
        ...sessionReads("change-1"),
        sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
          session: { ...session(sessionId), ownerUserId: "dana" },
          processes: [agent],
          currentAgent: agent,
          changeId: "change-1",
        }),
      },
    };
  };

  /** A window with its own kept files over `directory`, each paste kept with its process. */
  const windowOver = async (
    directory: string,
    mend: FakeMend,
    reads: ReturnType<typeof replaceable>["reads"],
  ) => {
    const pastes: Array<{ readonly processId: string; readonly text: string }> = [];
    const store = new ReviewStore(
      reads,
      mend,
      new ReviewMemory(memento()),
      keptIn(directory),
      async (_sessionId, processId, text) => {
        pastes.push({ processId, text });
        return "pasted";
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull());
    return { store, pastes };
  };

  it("pastes the whole review into the new claude, and the first review reads pasted into an earlier claude", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const directory = await storage();
    const world = replaceable();
    const { store, pastes } = await windowOver(directory, mend, world.reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await pastedInto(store, pastes, 1);
    expect(pastes[0]?.processId).toBe("agent-1");

    world.replace(CLAUDE_2);
    await sees(store, "agent-2");
    const read = store.ready();
    if (read === null) throw new Error("not read");
    const limiter = threadsOf(read, store.review(), "Dana").find(({ body }) =>
      body.includes("Use the shared limiter"),
    );
    expect(limiter?.label).toBe("follow-up pending · pasted into an earlier claude");

    // A second window, its own kept files over the same storage, reads what the first kept.
    const other = await windowOver(directory, mend, world.reads);
    await sees(other.store, "agent-2");
    await other.store.comment(onLine(5, "Name the constant"));
    const second = other.store.compose();
    if (second === null) throw new Error("nothing composed");
    // A review on its own: the new claude's input holds nothing it would go on top of.
    expect(second.base).toBeNull();
    expect(second.text).toContain("Use the shared limiter");
    expect(await other.store.send(second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(other.pastes).toHaveLength(1));
    const into = other.pastes[0];
    expect(into?.processId).toBe("agent-2");
    expect(into?.text).toContain("Use the shared limiter");
    expect(into?.text).toContain("Name the constant");
    expect(mend.delivered.at(-1)?.instruction).toBe(textToSend(into?.text ?? "", "add-rate-limit"));
    // Once the store keeps the paste and reads the comment Mend posted.
    await vi.waitFor(() => {
      const after = other.store.ready();
      if (after === null) throw new Error("not read");
      const labels = threadsOf(after, other.store.review(), "Dana")
        .filter(({ body }) => body.includes("limiter") || body.includes("constant"))
        .map(({ label }) => label);
      expect(labels).toEqual([
        "follow-up pending · pasted into claude's terminal",
        "follow-up pending · pasted into claude's terminal",
      ]);
    });
  });

  it("pastes the whole review when claude was replaced after she composed onto the old one", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const world = replaceable();
    const { store, pastes } = await windowOver(await storage(), mend, world.reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await pastedInto(store, pastes, 1);

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    expect(second.base).not.toBeNull();
    world.replace(CLAUDE_2);
    await sees(store, "agent-2");
    expect(await store.send(second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(2));
    expect(pastes[1]?.processId).toBe("agent-2");
    expect(pastes[1]?.text).toContain("Use the shared limiter");
    expect(pastes[1]?.text).toContain("Name the constant");
    expect(mend.delivered.at(-1)?.instruction).toBe(
      textToSend(pastes[1]?.text ?? "", "add-rate-limit"),
    );
  });
});
