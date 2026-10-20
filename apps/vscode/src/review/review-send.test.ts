import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail, SessionProcess } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import { DRAFT_GONE } from "./delivery.js";
import type { KeptReviews } from "./kept-reviews.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { textToSend } from "./instruction.js";
import { fake, window as vscodeWindow } from "../test-vscode.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import { reviewToast } from "./review-toast.js";
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
    await vi.waitFor(() => expect(pastes).toHaveLength(1));
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

  it("pastes nothing, and says why, when she changed the part already in claude's terminal", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const { store, pastes } = await window(keptIn(await storage()), mend);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await store.send(first, first.text);
    await vi.waitFor(() => expect(pastes).toHaveLength(1));
    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await store.send(second, second.text.replace("Use the shared limiter", "Use guard.ts"));
    await vi.waitFor(() => expect(told.map(({ words }) => words)).toHaveLength(1));
    expect(pastes).toHaveLength(1);
    expect(told[0]).toMatchObject({
      tone: "warning",
      words: expect.stringMatching(/already in claude's terminal, so VS Code pasted nothing/),
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
    await vi.waitFor(() => expect(pastes).toHaveLength(1));

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await store.send(second, second.text.replace("Use the shared limiter", "Use guard.ts"));
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(pastes).toHaveLength(1);
    // Mend holds "Name the constant", and claude's input does not: its thread says so.
    const read = store.ready();
    if (read === null) throw new Error("not read");
    const named = threadsOf(read, store.review(), "Dana").find(({ body }) =>
      body.includes("Name the constant"),
    );
    expect(named?.label).toBe("follow-up pending · not in claude's terminal");

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
    await vi.waitFor(() => expect(pastes).toHaveLength(1));
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
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1));
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
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1));
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

describe("a second window sends a review composed before the first window's went out", () => {
  it("sends nothing once the first is held in claude's terminal, and a new review with more still goes", async () => {
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
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1));
    await vi.waitFor(() =>
      expect(a.store.review().sends.at(-1)?.phase).toMatchObject({ paste: { kind: "done" } }),
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
    await vi.waitFor(() => expect(b.pastes).toHaveLength(1));
    expect(b.pastes[0]).toContain("Name the constant");
    expect(b.pastes[0]).not.toContain(fromA.text.split("\n")[0]);
  });
});
