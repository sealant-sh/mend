import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MendApiError } from "../mend-http.js";
import { fake, window as vscodeWindow } from "../test-vscode.js";
import { ToastClaims } from "../toast-claims.js";
import type { SessionDetail, SessionProcess } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import { DRAFT_GONE } from "./delivery.js";
import { textToSend } from "./instruction.js";
import { DRIVE_STALE_MS, KeptReviews, NODE_FILES, type KeptFiles } from "./kept-reviews.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import { reviewToast } from "./review-toast.js";
import type { ReadPass } from "./review-wire.js";
import {
  comment,
  FakeMend,
  keptIn,
  memoryFiles,
  PINNED,
  PROJECT,
  session,
  sessionReads,
  slowFiles,
  storage,
  SETTLE,
  sendComposed,
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
    async (sessionId, processId, text, bound) => {
      expect(processId).toBe("agent-1");
      // As the paste does: Mend's read of the agent's process right before the paste.
      await bound.sessionDetail(sessionId);
      pastes.push(text);
      return pasted;
    },
  );
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
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
  }, SETTLE);

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
    expect(await sendComposed(store, first, edited)).toEqual({ sent: true });
    await pastedInto(store, pastes, 1);
    expect(pastes[0]).toContain("Address each comment carefully");

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    // Her first review, as she edited and sent it, once; then the new comment alone.
    expect(second.text.split("Use the shared limiter")).toHaveLength(2);
    expect(second.text).toContain("Address each comment carefully");
    expect(second.text).toContain("## 2 · src/auth/limit.ts:5");
    expect(await sendComposed(store, second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
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
    await sendComposed(store, first, first.text);
    await pastedInto(store, pastes, 1);
    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await sendComposed(
      store,
      second,
      second.text.replace("Use the shared limiter", "Use guard.ts"),
    );
    await vi.waitFor(() => expect(told.map(({ words }) => words)).toHaveLength(1), SETTLE);
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
    await sendComposed(store, first, first.text);
    await pastedInto(store, pastes, 1);

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await sendComposed(
      store,
      second,
      second.text.replace("Use the shared limiter", "Use guard.ts"),
    );
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
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
    }, SETTLE);

    await store.comment(onLine(9, "Log the limit"));
    const third = store.compose();
    if (third === null) throw new Error("nothing composed");
    // Composed on top of what claude's input holds: the first review as it was pasted.
    expect(third.text).toContain("Use the shared limiter");
    expect(third.text).not.toContain("Use guard.ts");
    await sendComposed(store, third, third.text);
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
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
    await sendComposed(store, first, first.text);
    await pastedInto(store, pastes, 1);
    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    await sendComposed(store, second, second.text.replaceAll("\n", "\r\n"));
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
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
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    expect(pastes).toHaveLength(1);
    expect(told[0]?.words).toMatch(
      /claude exited before the review was pasted, so nothing was pasted/,
    );
    expect(told[0]?.retry).not.toBeNull();
    expect(store.review().sends.at(-1)?.phase).toEqual({ kind: "pending" });
  });
});

describe("a paste into claude's terminal that never finished", () => {
  it("reads not pasted when the paste throws, says to check claude's input, and Retry delivery pastes it again", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const pastes: Array<string> = [];
    const store = new ReviewStore(
      withAgent(CLAUDE),
      mend,
      new ReviewMemory(memento()),
      keptIn(await storage()),
      async (_sessionId, _processId, text) => {
        pastes.push(text);
        if (pastes.length === 1) throw new Error("the terminal's socket closed");
        return "pasted";
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    expect(told[0]?.words).toMatch(/check claude's input/i);
    expect(told[0]?.retry).not.toBeNull();
    const target = store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");
    expect(await store.retry(target)).toEqual({ retried: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
    expect(pastes[1]).toBe(pastes[0]);
    expect(mend.delivered).toHaveLength(1);
  });

  it("reads not pasted, with Retry delivery, in the window opened after the one pasting closed", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    let late = 0;
    const clock = (): number => Date.now() + late;
    const { promise: pasting, resolve: pasted } = Promise.withResolvers<void>();
    const closing = new ReviewStore(
      withAgent(CLAUDE),
      mend,
      new ReviewMemory(memento()),
      new KeptReviews(directory, NODE_FILES, clock),
      async () => {
        pasted();
        return new Promise<Pasted>(() => undefined);
      },
    );
    closing.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(closing.ready()).not.toBeNull(), SETTLE);
    const composed = closing.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(closing, composed, composed.text);
    await pasting;

    late += DRIVE_STALE_MS + 1_000;
    const opened = await window(new KeptReviews(directory, NODE_FILES, clock), mend);
    await vi.waitFor(() => expect(opened.store.retryTarget()).not.toBeNull(), SETTLE);
    expect(opened.store.review().sends.at(-1)?.phase).toMatchObject({
      kind: "in-terminal",
      paste: { kind: "failed" },
    });
    expect(opened.store.offer()).toEqual({ kind: "retry" });
    expect(opened.pastes).toEqual([]);
  });

  it("pastes into claude's terminal when Mend read the follow-up back pending while claude is live", async () => {
    const mend = new FakeMend();
    mend.answer = "delivering";
    const { store, pastes } = await window(keptIn("/global-storage/reviews", memoryFiles()), mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await sendComposed(store, composed, composed.text);
      await vi.advanceTimersByTimeAsync(0);
      const key = store.review().sends.at(-1)?.key;
      if (key === undefined) throw new Error("no review kept");
      mend.listed = { key, status: "pending", error: null };
      await vi.advanceTimersByTimeAsync(3_100);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(pastes).toHaveLength(1), SETTLE);
    await vi.waitFor(
      () =>
        expect(store.review().sends.at(-1)?.phase).toMatchObject({
          kind: "in-terminal",
          paste: { kind: "done" },
        }),
      SETTLE,
    );
  });

  it("pastes into claude's terminal when claude started while Mend took the follow-up", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const reads = {
      ...withAgent(CLAUDE),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
        session: { ...session(sessionId), ownerUserId: "dana" },
        processes: mend.delivered.length > 0 ? [CLAUDE] : [],
        currentAgent: mend.delivered.length > 0 ? CLAUDE : null,
        changeId: "change-1",
      }),
    };
    const { store, pastes } = await window(keptIn(await storage()), mend, reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(pastes).toHaveLength(1), SETTLE);
    expect(store.review().sends.at(-1)?.phase).toMatchObject({ kind: "in-terminal" });
  });
});

/** A window whose first paste into claude's terminal waits until the test lets it land. */
const pastingWindow = async (kept: KeptReviews, mend: FakeMend) => {
  const pastes: Array<string> = [];
  const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
  const { promise: landed, resolve: land } = Promise.withResolvers<Pasted>();
  const store = new ReviewStore(
    withAgent(CLAUDE),
    mend,
    new ReviewMemory(memento()),
    kept,
    async (_sessionId, _processId, text) => {
      pastes.push(text);
      reach();
      return pastes.length === 1 ? landed : "pasted";
    },
  );
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
  return { store, pastes, reached, land: () => land("pasted") };
};

describe("a second Send while the first review is being pasted into claude's terminal", () => {
  it("is not offered in another window, records nothing, and claude's input gets the first review once", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    const a = await pastingWindow(keptIn(directory), mend);
    await a.store.comment(onLine(3, "Use the shared limiter"));
    const first = a.store.compose();
    if (first === null) throw new Error("nothing composed");
    expect(await sendComposed(a.store, first, first.text)).toEqual({ sent: true });
    await a.reached;

    const b = await window(keptIn(directory), mend);
    await b.store.comment(onLine(5, "Name the constant"));
    await vi.waitFor(
      () =>
        expect(b.store.review().sends.at(-1)?.phase).toMatchObject({
          paste: { kind: "pasting" },
        }),
      SETTLE,
    );
    expect(b.store.offer()).toEqual({ kind: "busy" });
    const second = b.store.compose();
    if (second === null) throw new Error("nothing composed");
    expect((await sendComposed(b.store, second, second.text)).sent).toBe(false);

    a.land();
    await vi.waitFor(
      () => expect(a.store.review().sends.at(-1)?.phase).toMatchObject({ paste: { kind: "done" } }),
      SETTLE,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([...a.pastes, ...b.pastes]).toHaveLength(1);
    expect(mend.delivered).toHaveLength(1);
    expect(a.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["in-terminal"]);
    expect(a.store.review().pending.map(({ body }) => body)).toEqual(["Name the constant"]);
  });

  it("pastes nothing when another window's newer review replaced it before its paste began", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    const other = keptIn(directory);
    const place = { url: "http://mend", viewer: "dana", sessionId: "s1" };
    let due = false;
    const files: KeptFiles = {
      ...NODE_FILES,
      readFile: async (path) => {
        const text = await NODE_FILES.readFile(path);
        if (path.endsWith(".json") && text.includes('"paste":{"kind":"due"}')) due = true;
        return text;
      },
      create: async (path, text) => {
        // The drive read its review due to paste: before it keeps the paste as started, a newer
        // review of hers reaches Mend from another window, which replaces this one.
        if (due && path.endsWith(".json.lock")) {
          due = false;
          await other.update(place, (review) => ({
            ...review,
            sends: review.sends.map((record) => ({
              ...record,
              phase: {
                kind: "refused",
                words: "Mend replaced this follow-up with a newer review.",
              },
            })),
          }));
        }
        await NODE_FILES.create(path, text);
      },
    };
    const { store, pastes } = await window(keptIn(directory, files), mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(
      () => expect(store.review().sends.map(({ phase }) => phase.kind)).toEqual(["refused"]),
      SETTLE,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pastes).toEqual([]);
  });
});

/** Mend whose answer to the `held`th follow-up waits until `land`. */
class HeldDelivery extends FakeMend {
  held = 0;
  readonly #landed = Promise.withResolvers<void>();
  readonly #asked = Promise.withResolvers<void>();
  /** Settles once the held follow-up reaches Mend. */
  readonly asked = this.#asked.promise;

  override async deliver(
    ...args: Parameters<FakeMend["deliver"]>
  ): ReturnType<FakeMend["deliver"]> {
    this.held -= 1;
    if (this.held === 0) {
      this.#asked.resolve();
      await this.#landed.promise;
    }
    return super.deliver(...args);
  }

  land(): void {
    this.#landed.resolve();
  }
}

describe("Retry delivery of an older review while a newer one is on its way to Mend", () => {
  it("sends nothing, says why, and claude's input gets only the newer review", async () => {
    const mend = new HeldDelivery();
    mend.answer = "pending";
    mend.held = 2;
    mend.serverComments = [comment({ id: "c1" })];
    const pastes: Array<string> = [];
    const answers: Array<Pasted> = ["not-attached"];
    const store = new ReviewStore(
      withAgent(CLAUDE),
      mend,
      new ReviewMemory(memento()),
      keptIn(await storage()),
      async (sessionId, _processId, text, bound) => {
        await bound.sessionDetail(sessionId);
        const pasted = answers.shift() ?? "pasted";
        if (pasted === "pasted") pastes.push(text);
        return pasted;
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    expect(await sendComposed(store, first, first.text)).toEqual({ sent: true });
    await vi.waitFor(
      () =>
        expect(store.review().sends.at(-1)?.phase).toMatchObject({
          paste: { kind: "failed", mayHaveLanded: false },
        }),
      SETTLE,
    );
    const older = store.review().sends.at(-1);
    if (older === undefined) throw new Error("no review kept");

    await store.comment(onLine(3, "Use the shared limiter"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    expect(await sendComposed(store, second, second.text)).toEqual({ sent: true });
    await mend.asked;

    const place = { url: "http://mend", viewer: "dana", sessionId: "s1" };
    expect(await store.retry({ place, key: older.key })).toEqual({
      retried: false,
      words: "Retry delivery sent nothing: Mend is still sending your last review",
    });
    mend.land();
    await vi.waitFor(() => expect(pastes).toHaveLength(1), SETTLE);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pastes).toEqual([store.review().sends.at(-1)?.instruction]);
    expect(store.review().sends.map(({ phase }) => phase.kind)).toEqual(["refused", "in-terminal"]);
  });
});

const exitable = () => {
  let agent: SessionProcess = CLAUDE;
  return {
    exit: () => {
      agent = { ...CLAUDE, status: "exited", exitedAt: "2026-10-20T10:00:00.000Z" };
    },
    reads: {
      ...withAgent(CLAUDE),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
        session: { ...session(sessionId), ownerUserId: "dana" },
        processes: [agent],
        currentAgent: agent,
        changeId: "change-1",
      }),
    },
  };
};

describe("claude exits after VS Code pasted the review into its input", () => {
  it("offers no Retry delivery of it, and her next Send carries its comments", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const world = exitable();
    const { store, pastes } = await window(keptIn(await storage()), mend, world.reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await sendComposed(store, first, first.text);
    await pastedInto(store, pastes, 1);
    const [entered] = mend.delivered;
    const pasted = entered?.commentIds ?? [];

    world.exit();
    store.reread();
    await vi.waitFor(() => expect(store.ready()?.facts.agent).toBeNull(), SETTLE);
    expect(store.retryTarget()).toBeNull();
    const read = store.ready();
    if (read === null) throw new Error("not read");
    const limiter = threadsOf(read, store.review(), "Dana").find(({ body }) =>
      body.includes("Use the shared limiter"),
    );
    expect(limiter?.kind).toBe("waiting");

    await store.comment(onLine(5, "Name the constant"));
    expect(store.offer()).toEqual({ kind: "ready", count: 1 });
    const next = store.compose();
    if (next === null) throw new Error("nothing composed");
    expect(next.open).toEqual(pasted);
    expect(await sendComposed(store, next, next.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(2), SETTLE);
    expect(mend.delivered[1]?.idempotencyKey).not.toBe(entered?.idempotencyKey);
    expect(mend.delivered[1]?.commentIds).toEqual(expect.arrayContaining([...pasted]));
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
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    expect(mend.delivered).toEqual([]);
    expect(told[0]).toMatchObject({
      words: expect.stringContaining(DRAFT_GONE),
      text: expect.stringContaining(draft.body),
    });
    store.reread();
    await vi.waitFor(
      () => expect(store.compose()?.text).toContain("Use the shared limiter"),
      SETTLE,
    );
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
      sendComposed(a.store, fromA, fromA.text),
      sendComposed(b.store, fromB, fromB.text),
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
    expect(await sendComposed(store, composed, composed.text)).toEqual({
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
      sendComposed(a.store, fromA, fromA.text),
      sendComposed(b.store, fromB, fromB.text),
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
    expect(await sendComposed(a.store, composed, composed.text)).toMatchObject({ sent: false });
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
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
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
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(2), SETTLE);
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
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const told = failures(store);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    expect(told[0]?.retry).not.toBeNull();
    vscodeWindow.showErrorMessage.mockResolvedValueOnce("Retry delivery");
    const [failure] = told;
    if (failure === undefined) throw new Error("no failure");
    await reviewToast(store, claims, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not attach claude's terminal here/),
      "Retry delivery",
    );
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
    expect(pastes[1]).toBe(pastes[0]);
    expect(mend.delivered).toHaveLength(1);
    await vi.waitFor(
      () =>
        expect(store.review().sends.at(-1)?.phase).toMatchObject({
          kind: "in-terminal",
          paste: { kind: "done" },
        }),
      SETTLE,
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
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
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

describe("two Retry deliveries of one review at once in one window", () => {
  it("paste it once, keep it pasted, and leave no lease behind", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const directory = await storage();
    const kept = keptIn(directory);
    const pastes: Array<string> = [];
    const answers: Array<Pasted> = ["not-attached"];
    const store = new ReviewStore(
      withAgent(CLAUDE),
      mend,
      new ReviewMemory(memento()),
      kept,
      async (sessionId, _processId, text, bound) => {
        await bound.sessionDetail(sessionId);
        const pasted = answers.shift() ?? "pasted";
        if (pasted === "pasted") pastes.push(text);
        return pasted;
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(
      () =>
        expect(store.review().sends.at(-1)?.phase).toMatchObject({
          paste: { kind: "failed", mayHaveLanded: false },
        }),
      SETTLE,
    );
    const target = store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");

    const retried = await Promise.all([store.retry(target), store.retry(target)]);
    expect(retried.filter(({ retried }) => retried)).toHaveLength(1);
    await vi.waitFor(
      () =>
        expect(store.review().sends.at(-1)?.phase).toMatchObject({
          kind: "in-terminal",
          paste: { kind: "done" },
        }),
      SETTLE,
    );
    expect(pastes).toHaveLength(1);
    expect(kept.drives(target.place, target.key)).toBe(false);
    expect(await keptIn(directory).drivenFor(target.place, target.key)).toBeNull();
  }, 15_000);
});

describe("Retry delivery of a review Mend held pending, once claude runs in its terminal again", () => {
  /** Dana's session with no agent until `start`, then claude live in its terminal. */
  const relaunched = () => {
    let agent: SessionProcess | null = null;
    return {
      start: () => {
        agent = CLAUDE;
      },
      reads: {
        ...withAgent(CLAUDE),
        sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
          session: { ...session(sessionId), ownerUserId: "dana" },
          processes: agent === null ? [] : [agent],
          currentAgent: agent,
          changeId: "change-1",
        }),
      },
    };
  };

  const held = async (mend: FakeMend) => {
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const later = relaunched();
    const opened = await window(keptIn(await storage()), mend, later.reads);
    const composed = opened.store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(opened.store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(
      () => expect(opened.store.review().sends.at(-1)?.phase).toEqual({ kind: "pending" }),
      SETTLE,
    );
    return { ...opened, start: later.start };
  };

  it("pastes nothing, and reads sent, once Mend delivered it from elsewhere", async () => {
    const mend = new FakeMend();
    const { store, pastes, start } = await held(mend);
    // Another client delivered it: Mend launched claude on it and reads its comments sent.
    start();
    mend.markSent("s1");
    await sees(store, "agent-1");
    const target = store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");
    expect(await store.retry(target)).toEqual({
      retried: false,
      words: "Retry delivery sent nothing: this review already reads sent",
    });
    expect(pastes).toEqual([]);
    expect(store.review().sends.at(-1)?.phase.kind).toBe("delivered");
  });

  it("pastes nothing, and reads not sent, once a newer review replaced it on Mend", async () => {
    const mend = new FakeMend();
    const { store, pastes, start } = await held(mend);
    start();
    mend.listed = { key: "vscode-follow-up:change-1:newer", status: "pending", error: null };
    await sees(store, "agent-1");
    const target = store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");
    expect(await store.retry(target)).toEqual({
      retried: false,
      words: "Retry delivery sent nothing: this review already reads not sent",
    });
    expect(pastes).toEqual([]);
    expect(store.review().sends.at(-1)?.phase.kind).toBe("refused");
  });

  it("pastes it into claude's terminal while Mend still holds it pending", async () => {
    const mend = new FakeMend();
    const { store, pastes, start } = await held(mend);
    start();
    await sees(store, "agent-1");
    const target = store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");
    expect(await store.retry(target)).toEqual({ retried: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(1), SETTLE);
    expect(mend.delivered).toHaveLength(1);
  });
});

describe("a delivery that fails while she looks at another window", () => {
  const twoWindows = async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.deliver = async () => {
      throw new MendApiError("Mend is restarting.", 503);
    };
    const driving = await window(keptIn(directory), mend);
    const looking = await window(keptIn(directory), mend);
    const claims = new ToastClaims(join(directory, "toasts"));
    return { driving, looking, claims };
  };

  it("toasts nowhere unfocused, and once in the window she then focuses, with Retry delivery", async () => {
    const { driving, looking, claims } = await twoWindows();
    const drove = failures(driving.store);
    const seen = failures(looking.store);
    await driving.store.comment(onLine(3, "Use the shared limiter"));
    const composed = driving.store.compose();
    if (composed === null) throw new Error("nothing composed");
    fake.focus(false);
    await sendComposed(driving.store, composed, composed.text);
    await vi.waitFor(() => expect(drove).toHaveLength(1), SETTLE);
    const [failure] = drove;
    if (failure === undefined) throw new Error("no failure");
    await reviewToast(driving.store, claims, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).not.toHaveBeenCalled();
    fake.focus(true);
    await looking.store.reloadReview();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), SETTLE);
    for (const told of seen) await reviewToast(looking.store, claims, () => undefined)(told);
    await looking.store.reloadReview();
    for (const told of seen) await reviewToast(looking.store, claims, () => undefined)(told);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not deliver the review: Mend is restarting/),
      "Retry delivery",
    );
  });

  it("shows nothing when she looks away while the toast is claimed, and leaves it to be claimed again", async () => {
    const { driving, claims } = await twoWindows();
    const drove = failures(driving.store);
    await driving.store.comment(onLine(3, "Use the shared limiter"));
    const composed = driving.store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(driving.store, composed, composed.text);
    await vi.waitFor(() => expect(drove).toHaveLength(1), SETTLE);
    const [failure] = drove;
    if (failure === undefined) throw new Error("no failure");
    const lookingAway = {
      claim: async (key: string, at: string) => {
        const claimed = await claims.claim(key, at);
        fake.focus(false);
        return claimed;
      },
      release: (key: string, at: string) => claims.release(key, at),
    };
    await reviewToast(driving.store, lookingAway, () => undefined)(failure);
    expect(vscodeWindow.showErrorMessage).not.toHaveBeenCalled();
    expect(await claims.claim(failure.key, failure.at)).toBe(true);
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

/** What one window's send leaves her to be told, and the toast that says it. */
interface WaitsOnHer {
  readonly name: string;
  readonly mend: () => FakeMend;
  readonly agent: SessionProcess;
  readonly paste: (text: string) => Promise<Pasted>;
  /** Before the send: what she does in the window that sends it. */
  readonly before?: (store: ReviewStore, mend: FakeMend) => Promise<void>;
  readonly show: "showErrorMessage" | "showWarningMessage";
  readonly told: RegExp;
  readonly actions: ReadonlyArray<string>;
}

const heldPending = (): FakeMend => {
  const mend = new FakeMend();
  mend.answer = "pending";
  mend.serverComments = [comment({ id: "c1" })];
  return mend;
};

const EXITED: SessionProcess = { ...CLAUDE, exitedAt: "now", status: "exited" };

const WAITS_ON_HER: ReadonlyArray<WaitsOnHer> = [
  {
    name: "a paste VS Code could not attach",
    mend: heldPending,
    agent: CLAUDE,
    paste: async () => "not-attached",
    show: "showErrorMessage",
    told: /could not attach claude's terminal here, so nothing was pasted/,
    actions: ["Retry delivery"],
  },
  {
    name: "a paste cut short",
    mend: heldPending,
    agent: CLAUDE,
    paste: async () => {
      throw new Error("the terminal's socket closed");
    },
    show: "showErrorMessage",
    told: /check claude's input before Retry delivery/,
    actions: ["Retry delivery"],
  },
  {
    name: "a review Mend refused",
    mend: () => {
      const mend = new FakeMend();
      mend.serverComments = [comment({ id: "c1" })];
      mend.deliver = async () => {
        throw new MendApiError("You cannot steer this session.", 403);
      };
      return mend;
    },
    agent: EXITED,
    paste: async () => "pasted",
    show: "showErrorMessage",
    told: /could not deliver the review: You cannot steer this session/,
    actions: [],
  },
  {
    name: "a review whose draft was dismissed on its way",
    mend: () => {
      const mend = new FakeMend();
      mend.serverComments = [
        comment({ id: "d1", state: "draft", author: { kind: "mend", name: "Mend" } }),
      ];
      return mend;
    },
    agent: EXITED,
    paste: async () => "pasted",
    before: async (store, mend) => {
      await store.accept("d1", "");
      mend.serverComments = mend.serverComments.map((one) => ({ ...one, state: "dismissed" }));
    },
    show: "showWarningMessage",
    told: new RegExp(DRAFT_GONE),
    actions: ["Show its text"],
  },
];

describe("a send that leaves her something to know while she looks at another window", () => {
  it.each(WAITS_ON_HER)(
    "$name toasts nowhere unfocused, and once in the window she then focuses",
    async (waits) => {
      const directory = await storage();
      const mend = waits.mend();
      const reads = withAgent(waits.agent);
      const open = async (): Promise<ReviewStore> => {
        const store = new ReviewStore(
          reads,
          mend,
          new ReviewMemory(memento()),
          keptIn(directory),
          (_sessionId, _processId, text) => waits.paste(text),
        );
        store.follow(PROJECT, session("s1"));
        await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
        return store;
      };
      const driving = await open();
      const looking = await open();
      const claims = new ToastClaims(join(directory, "toasts"));
      const drove = failures(driving);
      const seen = failures(looking);
      await waits.before?.(driving, mend);
      await driving.comment(onLine(3, "Use the shared limiter"));
      const composed = driving.compose();
      if (composed === null) throw new Error("nothing composed");
      fake.focus(false);
      await sendComposed(driving, composed, composed.text);
      await vi.waitFor(() => expect(drove.length).toBeGreaterThan(0), SETTLE);
      for (const told of drove) await reviewToast(driving, claims, () => undefined)(told);
      expect(vscodeWindow[waits.show]).not.toHaveBeenCalled();

      fake.focus(true);
      await looking.reloadReview();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), SETTLE);
      for (const told of seen) await reviewToast(looking, claims, () => undefined)(told);
      await looking.reloadReview();
      for (const told of seen) await reviewToast(looking, claims, () => undefined)(told);
      expect(vscodeWindow[waits.show]).toHaveBeenCalledTimes(1);
      expect(vscodeWindow[waits.show]).toHaveBeenCalledWith(
        expect.stringMatching(waits.told),
        ...waits.actions,
      );
    },
    20_000,
  );
});

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
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    const [failure] = told;
    if (failure === undefined) throw new Error("no failure");
    expect(failure.words).toBe("Mend could not read this change: the model timed out");
    // The toast waits on its claim; meanwhile she reads the change again, and Mend is reading it.
    const claims = {
      claim: async () => {
        mend.pass = { kind: "reading", since: "2026-10-20T10:01:00.000Z" };
        store.reread();
        await vi.waitFor(() => expect(store.ready()?.pass?.kind).toBe("reading"), SETTLE);
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
    expect(await sendComposed(a.store, fromA, fromA.text)).toEqual({ sent: true });
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
    const sent = sendComposed(a.store, fromA, fromA.text);
    await claiming;
    const b = await window(keptIn(directory), mend);
    allow();
    expect(await sent).toEqual({ sent: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1), SETTLE);
    expect(told).toEqual([]);
    await b.store.reloadReview();
    expect(b.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["in-terminal"]);
  });

  it("leaves a send that window's Retry claims while this one waits to pick it up", async () => {
    const directory = await storage();
    const mend = new FailsThenHolds();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const a = await window(keptIn(directory), mend);
    const told = failures(a.store);
    const fromA = a.store.compose();
    if (fromA === null) throw new Error("nothing composed");
    await sendComposed(a.store, fromA, fromA.text);
    await mend.asked;

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
    mend.fails();
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    const target = a.store.retryTarget();
    if (target === null) throw new Error("no Retry delivery offered");
    const retried = a.store.retry(target);
    await mend.reached;
    allow();
    await loaded;
    mend.answers();
    expect(await retried).toEqual({ retried: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1), SETTLE);
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
    await sendComposed(closing.store, fromClosing, fromClosing.text);
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
      await vi.waitFor(
        () =>
          expect(reloaded.store.review().sends.map(({ phase }) => phase)).toEqual([
            {
              kind: "failed",
              words: "VS Code closed before Mend answered",
              at: expect.any(String),
            },
          ]),
        SETTLE,
      );
      expect(reloaded.store.offer()).toEqual({ kind: "retry" });
      expect(reloaded.store.retryTarget()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a window already following the session when another window's send is left behind", () => {
  it("reads the send failed, with Retry delivery, once the closed window's lease goes stale", async () => {
    const directory = await storage();
    const mend = new Unanswered();
    mend.serverComments = [comment({ id: "c1" })];
    let late = 0;
    const following = await window(
      new KeptReviews(directory, NODE_FILES, () => Date.now() + late),
      mend,
    );
    const closing = await window(keptIn(directory), mend);
    const fromClosing = closing.store.compose();
    if (fromClosing === null) throw new Error("nothing composed");
    await sendComposed(closing.store, fromClosing, fromClosing.text);
    await mend.asked;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      following.store.reread();
      await vi.waitFor(
        () =>
          expect(following.store.review().sends.map(({ phase }) => phase.kind)).toEqual([
            "sending",
          ]),
        SETTLE,
      );
      late += DRIVE_STALE_MS;
      await vi.advanceTimersByTimeAsync(DRIVE_STALE_MS);
      vi.useRealTimers();
      await vi.waitFor(
        () =>
          expect(following.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
        SETTLE,
      );
      expect(following.store.offer()).toEqual({ kind: "retry" });
      expect(following.store.retryTarget()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on watching a launch the closed window watched, until Mend reads it sent", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.serverComments = [comment({ id: "c1" })];
    const { promise: watching, resolve: watched } = Promise.withResolvers<void>();
    let closed = true;
    mend.followUp = async () => {
      if (!closed) return null;
      watched();
      return new Promise(() => undefined);
    };
    let late = 0;
    const following = await window(
      new KeptReviews(directory, NODE_FILES, () => Date.now() + late),
      mend,
    );
    const closing = await window(keptIn(directory), mend);
    const fromClosing = closing.store.compose();
    if (fromClosing === null) throw new Error("nothing composed");
    await sendComposed(closing.store, fromClosing, fromClosing.text);
    await watching;

    closed = false;
    late += DRIVE_STALE_MS;
    mend.markSent("s1");
    following.store.reread();
    await vi.waitFor(
      () =>
        expect(following.store.review().sends.map(({ phase }) => phase.kind)).toEqual([
          "delivered",
        ]),
      { timeout: 8_000 },
    );
    expect(mend.delivered).toHaveLength(1);
  }, 15_000);

  it("reads the send failed, with Retry delivery, when Send review reads the kept review", async () => {
    const directory = await storage();
    const mend = new Unanswered();
    mend.serverComments = [comment({ id: "c1" })];
    const following = await window(
      new KeptReviews(directory, NODE_FILES, () => Date.now() + DRIVE_STALE_MS),
      mend,
    );
    const closing = await window(keptIn(directory), mend);
    const fromClosing = closing.store.compose();
    if (fromClosing === null) throw new Error("nothing composed");
    await sendComposed(closing.store, fromClosing, fromClosing.text);
    await mend.asked;

    await following.store.comment(onLine(3, "Use the shared limiter"));
    const composed = following.store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect((await sendComposed(following.store, composed, composed.text)).sent).toBe(false);
    await vi.waitFor(
      () =>
        expect(following.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
      { timeout: 3_000 },
    );
    expect(following.store.retryTarget()).not.toBeNull();
  });

  it("takes the send over before it reads it failed, so the window that wakes from sleep stops and says nothing", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    const { promise: asked, resolve: ask } = Promise.withResolvers<void>();
    const { promise: answers, resolve: answer } = Promise.withResolvers<void>();
    const deliver = mend.deliver.bind(mend);
    mend.deliver = async (...args) => {
      ask();
      await answers;
      return deliver(...args);
    };
    const asleep = await window(keptIn(directory), mend);
    const toldAsleep = failures(asleep.store);
    const fromAsleep = asleep.store.compose();
    if (fromAsleep === null) throw new Error("nothing composed");
    await sendComposed(asleep.store, fromAsleep, fromAsleep.text);
    await asked;

    // The other window's clock reads the sleeping window's lease stale, as after a laptop sleep.
    const awake = await window(
      new KeptReviews(directory, NODE_FILES, () => Date.now() + DRIVE_STALE_MS),
      mend,
    );
    await vi.waitFor(
      () => expect(awake.store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
      SETTLE,
    );
    answer();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(toldAsleep).toEqual([]);
    expect(asleep.pastes).toEqual([]);
  });

  it("looks again, and reads its own send failed with Retry delivery, when its first look could not keep it either", async () => {
    const mend = new FakeMend();
    mend.serverComments = [comment({ id: "c1" })];
    let failWrites = 0;
    const files: KeptFiles = {
      ...NODE_FILES,
      rename: async (from, to) => {
        if (failWrites > 0 && to.endsWith(".json")) {
          failWrites -= 1;
          throw new Error("EIO: the disk did not take the write");
        }
        await NODE_FILES.rename(from, to);
      },
    };
    mend.deliver = async () => {
      failWrites = 2;
      throw new MendApiError("Mend is restarting.", 503);
    };
    const { store } = await window(keptIn(await storage(), files), mend);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(failWrites).toBe(0), SETTLE);
    await vi.waitFor(
      () => expect(store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
      { timeout: 6_000 },
    );
    expect(store.offer()).toEqual({ kind: "retry" });
    expect(store.retryTarget()).not.toBeNull();
  }, 15_000);

  it("reads its own send failed, with Retry delivery, when it could not keep the failure", async () => {
    const mend = new FakeMend();
    mend.serverComments = [comment({ id: "c1" })];
    let failWrite = false;
    const files: KeptFiles = {
      ...NODE_FILES,
      rename: async (from, to) => {
        if (failWrite) {
          failWrite = false;
          throw new Error("EIO: the disk did not take the write");
        }
        await NODE_FILES.rename(from, to);
      },
    };
    mend.deliver = async () => {
      failWrite = true;
      throw new MendApiError("Mend is restarting.", 503);
    };
    const { store } = await window(keptIn(await storage(), files), mend);
    const told = failures(store);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await sendComposed(store, composed, composed.text);
    await vi.waitFor(() => expect(told.length).toBeGreaterThan(0), SETTLE);
    await vi.waitFor(
      () => expect(store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
      SETTLE,
    );
    expect(store.offer()).toEqual({ kind: "retry" });
  });
});

class FailsThenHolds extends FakeMend {
  #failing = true;
  readonly #asked = Promise.withResolvers<void>();
  readonly #failed = Promise.withResolvers<void>();
  readonly #reached = Promise.withResolvers<void>();
  readonly #answered = Promise.withResolvers<void>();
  readonly asked = this.#asked.promise;
  /** Settles once a follow-up after the failed one reaches Mend. */
  readonly reached = this.#reached.promise;

  fails(): void {
    this.#failed.resolve();
  }

  answers(): void {
    this.#answered.resolve();
  }

  override async deliver(
    ...args: Parameters<FakeMend["deliver"]>
  ): ReturnType<FakeMend["deliver"]> {
    if (this.#failing) {
      this.#failing = false;
      this.#asked.resolve();
      await this.#failed.promise;
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
    expect(await sendComposed(a.store, fromA, fromA.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(a.pastes).toHaveLength(1), SLOW_DRIVE);
    await vi.waitFor(
      () => expect(a.store.review().sends.at(-1)?.phase).toMatchObject({ paste: { kind: "done" } }),
      SLOW_DRIVE,
    );
    expect(await sendComposed(b.store, fromB, fromB.text)).toMatchObject({ sent: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mend.delivered).toHaveLength(1);
    expect(b.pastes).toEqual([]);

    await b.store.reloadReview();
    await b.store.comment(onLine(5, "Name the constant"));
    const more = b.store.compose();
    if (more === null) throw new Error("nothing composed");
    expect(await sendComposed(b.store, more, more.text)).toEqual({ sent: true });
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

describe("a send on its way when VS Code connects to another Mend server", () => {
  it("sends nothing more to either server, and the review reads failed with Retry once she is back", async () => {
    const directory = await storage();
    const server = new SlowPosts();
    server.answer = "pending";
    server.held = 1;
    let url = "http://mend";
    const reads = { ...withAgent(CLAUDE), connection: async () => ({ url, token: null }) };
    const { store } = await window(keptIn(directory), server, reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    await store.comment(onLine(7, "Name the retry budget"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(server.asked).toHaveLength(1), SETTLE);
    const record = store.review().sends.at(-1);
    if (record === undefined) throw new Error("no review kept");
    const place = { url: "http://mend", viewer: "dana", sessionId: "s1" };

    url = "http://other";
    store.forget();
    server.land();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.asked).toHaveLength(1);
    expect(server.delivered).toEqual([]);
    // The window that stopped keeps why: the review reads failed, with Retry, at once.
    const kept = await keptIn(directory).read(place);
    expect(kept.review.sends.map(({ phase }) => phase)).toEqual([
      {
        kind: "failed",
        words: "VS Code connected to another Mend server or account before Mend answered",
        at: expect.any(String),
      },
    ]);
    expect(await keptIn(directory).drivenFor(place, record.key)).toBeNull();

    url = "http://mend";
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(
      () => expect(store.review().sends.map(({ phase }) => phase.kind)).toEqual(["failed"]),
      SETTLE,
    );
    expect(store.retryTarget()?.key).toBe(record.key);
  });

  it("says VS Code connected elsewhere before it pasted the review, never that VS Code closed", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    let url = "http://mend";
    let switched = false;
    const reads = {
      ...withAgent(CLAUDE),
      connection: async () => ({ url, token: null }),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => {
        // Read right after Mend held the review: VS Code connects elsewhere before the paste.
        if (mend.delivered.length > 0 && !switched) {
          switched = true;
          url = "http://other";
        }
        return {
          session: { ...session(sessionId), ownerUserId: "dana" },
          processes: [CLAUDE],
          currentAgent: CLAUDE,
          changeId: "change-1",
        };
      },
    };
    const { store, pastes } = await window(keptIn(await storage()), mend, reads);
    const told = failures(store);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(switched).toBe(true), SETTLE);
    await new Promise((resolve) => setTimeout(resolve, 150));

    url = "http://mend";
    store.forget();
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.retryTarget()).not.toBeNull(), SETTLE);
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    expect(pastes).toEqual([]);
    expect(told[0]?.words).toBe(
      "VS Code connected to another Mend server or account before it pasted the review into claude's terminal, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it.",
    );
  });
});

describe("VS Code connects to another Mend server while a send waits on a read", () => {
  it("posts nothing once the read before the post lands, and the review reads failed with Retry", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    let url = "http://mend";
    const reads = { ...withAgent(CLAUDE), connection: async () => ({ url, token: null }) };
    const { store } = await window(keptIn(directory), mend, reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const read = mend.comments.bind(mend);
    const held = Promise.withResolvers<void>();
    let holding = false;
    mend.comments = async () => {
      if (holding) {
        await held.promise;
        holding = false;
      }
      return read();
    };
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    holding = true;
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    const record = store.review().sends.at(-1);
    if (record === undefined) throw new Error("no review kept");
    await new Promise((resolve) => setTimeout(resolve, 100));

    url = "http://other";
    held.resolve();
    const place = { url: "http://mend", viewer: "dana", sessionId: "s1" };
    await vi.waitFor(async () => {
      const kept = await keptIn(directory).read(place);
      expect(kept.review.sends.map(({ phase }) => phase)).toEqual([
        {
          kind: "failed",
          words: "VS Code connected to another Mend server or account before Mend answered",
          at: expect.any(String),
        },
      ]);
    }, SETTLE);
    expect(mend.writes).toEqual([]);
  });

  it("pastes nothing once its paste is kept as started, and says so", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    let url = "http://mend";
    const files = memoryFiles();
    const watched: KeptFiles = {
      ...files,
      writeFile: async (path, text) => {
        // VS Code connects elsewhere the moment the paste is kept as started.
        if (text.includes('"pasting"')) url = "http://other";
        await files.writeFile(path, text);
      },
    };
    const pastes: Array<string> = [];
    const store = new ReviewStore(
      { ...withAgent(CLAUDE), connection: async () => ({ url, token: null }) },
      mend,
      new ReviewMemory(memento()),
      keptIn("/global-storage/reviews", watched),
      async (sessionId, _processId, text, bound) => {
        // As the paste does: Mend's read of the agent's process right before the paste.
        await bound.sessionDetail(sessionId);
        pastes.push(text);
        return "pasted";
      },
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    const place = { url: "http://mend", viewer: "dana", sessionId: "s1" };
    await vi.waitFor(async () => {
      const kept = await keptIn("/global-storage/reviews", watched).read(place);
      expect(kept.review.sends.map(({ phase }) => phase)).toEqual([
        expect.objectContaining({
          kind: "in-terminal",
          paste: { kind: "failed", mayHaveLanded: false, stopped: { kind: "switched" } },
        }),
      ]);
    }, SETTLE);
    expect(pastes).toEqual([]);
  });
});

describe("a paste VS Code could not keep as pasted", () => {
  it("says VS Code could not keep it, never that Mend could not deliver, and offers Retry delivery", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    mend.serverComments = [comment({ id: "c1" })];
    let failed = false;
    const files: KeptFiles = {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (!failed && text.includes('"paste":{"kind":"done"')) {
          failed = true;
          throw new Error("EIO: the disk did not take the write");
        }
        await NODE_FILES.writeFile(path, text);
      },
    };
    const { store, pastes } = await window(keptIn(await storage(), files), mend);
    const told = failures(store);
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(told).toHaveLength(1), SETTLE);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pastes).toHaveLength(1);
    expect(told.map(({ words }) => words)).toEqual([
      "VS Code could not keep the review: EIO: the disk did not take the write, so some or all of it may be in claude's input. Mend holds the follow-up pending: check claude's input before Retry delivery pastes it again.",
    ]);
    expect(told[0]?.retry).not.toBeNull();
    expect(store.review().sends.at(-1)?.phase).toMatchObject({
      kind: "in-terminal",
      paste: { kind: "failed", mayHaveLanded: true },
    });
    expect(store.retryTarget()).not.toBeNull();
  });
});

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
    expect(await sendComposed(a.store, composed, composed.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(server.asked).toHaveLength(1), SETTLE);
    // Its POST outlasts its lease, as from a window asleep: a window opened now reads the send as
    // abandoned, and Retry delivery drives it.
    late += DRIVE_STALE_MS + 1_000;
    const b = await window(new KeptReviews(directory, NODE_FILES, clock), server);
    const target = b.store.retryTarget();
    if (target === null) throw new Error("the other window offers no retry");
    const retried = b.store.retry(target);
    await vi.waitFor(() => expect(server.asked).toHaveLength(2), SETTLE);
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
    await vi.waitFor(() => expect(server.delivered).toHaveLength(1), SETTLE);
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
  }, SETTLE);
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
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
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
    await sendComposed(store, first, first.text);
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
    expect(await sendComposed(other.store, second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(other.pastes).toHaveLength(1), SETTLE);
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
    }, SETTLE);
  });

  it("pastes the whole review when claude was replaced after she composed onto the old one", async () => {
    const mend = new FakeMend();
    mend.answer = "pending";
    const world = replaceable();
    const { store, pastes } = await windowOver(await storage(), mend, world.reads);
    await store.comment(onLine(3, "Use the shared limiter"));
    const first = store.compose();
    if (first === null) throw new Error("nothing composed");
    await sendComposed(store, first, first.text);
    await pastedInto(store, pastes, 1);

    await store.comment(onLine(5, "Name the constant"));
    const second = store.compose();
    if (second === null) throw new Error("nothing composed");
    expect(second.base).not.toBeNull();
    world.replace(CLAUDE_2);
    await sees(store, "agent-2");
    expect(await sendComposed(store, second, second.text)).toEqual({ sent: true });
    await vi.waitFor(() => expect(pastes).toHaveLength(2), SETTLE);
    expect(pastes[1]?.processId).toBe("agent-2");
    expect(pastes[1]?.text).toContain("Use the shared limiter");
    expect(pastes[1]?.text).toContain("Name the constant");
    expect(mend.delivered.at(-1)?.instruction).toBe(
      textToSend(pastes[1]?.text ?? "", "add-rate-limit"),
    );
  });
});
