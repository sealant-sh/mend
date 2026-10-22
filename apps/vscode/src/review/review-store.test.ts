import { afterEach, describe, expect, it, vi } from "vitest";

import { MendClient } from "../client.js";
import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import type { Session, SessionDetail } from "../types.js";
import { mendNote } from "./instruction.js";
import { NODE_FILES } from "./kept-reviews.js";
import type { KeptReviews } from "./kept-reviews.js";
import { addPending, MAX_PENDING } from "./pending.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import type { CommentAnchor, ReadPass, ServerComment, TranscriptEntry } from "./review-wire.js";
import {
  checkpoint,
  CHECKPOINTS,
  comment,
  FakeMend,
  keptIn,
  memoryFiles,
  PINNED,
  PROJECT,
  pending,
  session,
  sessionReads,
  settle,
  slowFiles,
  storage,
  noPaste,
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

const DANA_S1 = { url: "http://mend", viewer: "dana", sessionId: "s1" };

/** A window's review store over its own kept reviews, following `s1`, its change read. */
const readyStore = async (
  kept: KeptReviews,
  mend: FakeMend = new FakeMend(),
): Promise<ReviewStore> => {
  const store = new ReviewStore(
    sessionReads("change-1"),
    mend,
    new ReviewMemory(memento()),
    kept,
    noPaste,
  );
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
  return store;
};

const DRAFT = comment({
  id: "d1",
  state: "draft",
  line: 13,
  author: { kind: "mend", name: "Mend" },
  body: "Nothing in this session ran the tests after limit.ts changed.",
  evidence: [{ runId: "run-1", sequence: "214", excerpt: "pnpm test auth · never ran" }],
});

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

describe("the review store, as it follows one session after another", () => {
  it("never shows one session's pending comments under the next, when the first's read lands late", async () => {
    const kept = keptIn(await storage());
    await kept.update({ ...DANA_S1, sessionId: "ana" }, (stored) =>
      addPending(stored, pending({ body: "for Ana" })),
    );
    // Both reads are held, then Ana's lands first, while Dana's is still on its way.
    const held = { ana: Promise.withResolvers<void>(), dana: Promise.withResolvers<void>() };
    const detail = async (sessionId: string): Promise<SessionDetail> => {
      if (sessionId === "ana" || sessionId === "dana") await held[sessionId].promise;
      return { session: session(sessionId), processes: [], currentAgent: null, changeId: null };
    };
    // Neither session has a change: a read ends once it has loaded the session's comments.
    const store = new ReviewStore(
      { ...sessionReads(null), sessionDetail: detail },
      new ReviewClient(
        async () => {
          throw new Error("no review route is read for a session without a change");
        },
        () => undefined,
      ),
      new ReviewMemory(memento()),
      kept,
      noPaste,
    );
    store.follow(PROJECT, session("ana"));
    store.follow(PROJECT, session("dana"));
    held.ana.resolve();
    await settle();
    held.dana.resolve();
    await settle();
    expect(store.followed()?.session.id).toBe("dana");
    expect(store.review().pending).toEqual([]);
  });
});

describe("ReviewStore.forget", () => {
  it("drops what the section showed, and her pending comments stay kept on this machine", async () => {
    const directory = await storage();
    const store = await readyStore(keptIn(directory));
    await store.comment(onLine(3, "Use the shared limiter"));
    store.forget();
    expect(store.state()).toEqual({ kind: "idle" });
    expect(store.review().pending).toEqual([]);
    const stored = (await keptIn(directory).read(DANA_S1)).review.pending;
    expect(stored.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
  });

  it("keeps a read that lands after it from drawing the session again", async () => {
    const held = Promise.withResolvers<void>();
    const reads = sessionReads("change-1");
    const store = new ReviewStore(
      {
        ...reads,
        sessionDetail: async (sessionId) => {
          await held.promise;
          return reads.sessionDetail(sessionId);
        },
      },
      new FakeMend(),
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    store.forget();
    held.resolve();
    await settle();
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("lets the same session be followed again afterwards", async () => {
    const store = await readyStore(keptIn(await storage()));
    store.forget();
    store.follow(PROJECT, session("s1"));
    await settle();
    expect(store.ready()).not.toBeNull();
  });
});

describe("two windows on one session", () => {
  it("each keep the other's pending comments, and a delete takes only its own", async () => {
    const directory = await storage();
    const first = await readyStore(keptIn(directory));
    const second = await readyStore(keptIn(directory));
    await first.comment(onLine(3, "from the first window"));
    await second.comment(onLine(4, "from the second window"));
    const bodies = async () =>
      (await keptIn(directory).read(DANA_S1)).review.pending.map(({ body }) => body);
    expect(await bodies()).toEqual(["from the first window", "from the second window"]);
    const own = second.review().pending.find(({ body }) => body === "from the second window");
    if (own === undefined) throw new Error("the second window lost its own comment");
    await second.remove(own.id);
    expect(await bodies()).toEqual(["from the first window"]);
    // The first window's next write keeps the second's delete: nothing it read earlier comes back.
    const [mine] = first.review().pending;
    if (mine === undefined) throw new Error("the first window lost its own comment");
    await first.edit(mine.id, "edited in the first window");
    expect(await bodies()).toEqual(["edited in the first window"]);
  });

  it("keep both comments when the two windows add theirs at the same moment", async () => {
    const directory = await storage();
    const first = await readyStore(keptIn(directory, slowFiles(30)));
    const second = await readyStore(keptIn(directory, slowFiles(30)));
    const kept = await Promise.all([
      first.comment(onLine(3, "from the first window")),
      second.comment(onLine(4, "from the second window")),
    ]);
    expect(kept).toEqual([{ kept: true }, { kept: true }]);
    await Promise.all([first.reloadReview(), second.reloadReview()]);
    for (const window of [first, second])
      expect(
        window
          .review()
          .pending.map(({ body }) => body)
          .toSorted(),
      ).toEqual(["from the first window", "from the second window"]);
  });

  it("accept one draft once, when both accept it at once", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const first = await readyStore(keptIn(directory, slowFiles(30)), mend);
    const second = await readyStore(keptIn(directory, slowFiles(30)), mend);
    await Promise.all([first.accept("d1", ""), second.accept("d1", ""), first.accept("d1", "")]);
    const kept = (await keptIn(directory).read(DANA_S1)).review.pending;
    expect(kept.map(({ origin }) => origin.kind)).toEqual(["accepted"]);
  });

  it("accept a draft once and keep both replies, when each accepts it with words of its own", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const first = await readyStore(keptIn(directory), mend);
    const second = await readyStore(keptIn(directory), mend);
    await first.accept("d1", "reply from the first window");
    await second.accept("d1", "reply from the second window");
    const kept = (await keptIn(directory).read(DANA_S1)).review.pending;
    expect(kept.map(({ origin, body }) => ({ kind: origin.kind, body }))).toEqual([
      { kind: "accepted", body: DRAFT.body },
      { kind: "own", body: "reply from the first window" },
      { kind: "own", body: "reply from the second window" },
    ]);
  });

  it("accept a draft once, when the other already sent it in a review", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const first = await readyStore(keptIn(directory), mend);
    const second = await readyStore(keptIn(directory), mend);
    await first.accept("d1", "");
    await sendAll(first);
    await second.accept("d1", "");
    const { review } = await keptIn(directory).read(DANA_S1);
    expect(review.pending).toEqual([]);
  });
});

describe("a comment she submits", () => {
  it("says it was not kept, and why, while the change is still being read", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    const kept = await store.comment(onLine(3, "Use the shared limiter"));
    expect(kept).toEqual({ kept: false, words: expect.stringMatching(/not kept/) });
  });

  it("says it was not kept on a slice the section no longer shows", async () => {
    const store = await readyStore(keptIn(await storage()));
    const moved = onLine(3, "Use the shared limiter");
    const kept = await store.comment({ ...moved, at: { ...moved.at, slice: "slice-0" } });
    expect(kept).toEqual({ kept: false, words: expect.stringMatching(/not kept/) });
    expect(store.review().pending).toEqual([]);
  });

  it("says it was kept once it is pending", async () => {
    const store = await readyStore(keptIn(await storage()));
    expect(await store.comment(onLine(3, "Use the shared limiter"))).toEqual({ kept: true });
    expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
  });
});

describe("a call Mend refuses", () => {
  it("fails with the refusal itself, so a refused sign-in toasts as every surface does", async () => {
    const refused = new MendApiError("Signed out — sign in again.", 401);
    class Refusing extends FakeMend {
      override async readChange(): Promise<void> {
        throw refused;
      }
    }
    const store = new ReviewStore(
      sessionReads("change-1"),
      new Refusing(),
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await settle();
    const failures: Array<ReviewFailure> = [];
    store.onDidFail((failure) => failures.push(failure));
    await store.readChange();
    expect(failures.map(({ words, cause }) => ({ words, cause }))).toEqual([
      { words: "Signed out — sign in again.", cause: refused },
    ]);
  });
});

const reads = (sessions: ReadonlyArray<Session>) => ({
  ...sessionReads("change-1"),
  projectDetail: async () => ({ project: PROJECT, sessions }),
});

const failedPass = (startedAt: string): ReadPass => ({
  kind: "failed",
  startedAt,
  at: startedAt,
  words: "authentication_failed",
});

describe("a Mend draft she acts on", () => {
  it("keeps the words of a Dismiss under its own session when she follows another before Mend answers", async () => {
    const directory = await storage();
    const answered = Promise.withResolvers<void>();
    class SlowDismiss extends FakeMend {
      override async setCommentState(): Promise<ServerComment> {
        await answered.promise;
        return { ...DRAFT, state: "dismissed" };
      }
    }
    const mend = new SlowDismiss();
    mend.serverComments = [DRAFT];
    const store = await readyStore(keptIn(directory), mend);
    const dismissed = store.dismiss("d1", "I ran them by hand");
    store.follow(PROJECT, session("s2"));
    await settle();
    answered.resolve();
    await dismissed;
    const bodies = async (sessionId: string) =>
      (await keptIn(directory).read({ ...DANA_S1, sessionId })).review.pending.map(
        ({ body }) => body,
      );
    expect(await bodies("s1")).toEqual(["I ran them by hand"]);
    expect(await bodies("s2")).toEqual([]);
    expect(store.review().pending).toEqual([]);
  });

  it("keeps a draft on a deleted file's old side there, through Accept and her reply", async () => {
    const mend = new FakeMend();
    mend.serverComments = [
      {
        ...DRAFT,
        file: "README",
        line: 3,
        endLine: 3,
        anchor: { sliceId: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, side: "old" },
      },
    ];
    const store = await readyStore(keptIn(await storage()), mend);
    const read = store.ready();
    if (read === null) throw new Error("not read");
    const oldSide = {
      worktreeId: "w1",
      absent: false,
      path: "README",
      at: PINNED.base.id,
      slice: null,
    };
    expect(threadsOf(read, store.review(), "Dana").map(({ at }) => at)).toEqual([oldSide]);
    await store.accept("d1", "and keep the install steps");
    const threads = threadsOf(read, store.review(), "Dana").filter(({ kind }) => kind !== "draft");
    expect(threads.map(({ kind, at, line }) => ({ kind, at, line }))).toEqual([
      { kind: "accepted", at: oldSide, line: 3 },
      { kind: "pending", at: oldSide, line: 3 },
    ]);
  });

  it("accepts a draft about the whole change, with its evidence, as a comment on the whole change", async () => {
    const mend = new FakeMend();
    mend.serverComments = [{ ...DRAFT, file: null, line: null, endLine: null }];
    const store = await readyStore(keptIn(await storage()), mend);
    await store.accept("d1", "and say which tests");
    expect(
      store.review().pending.map(({ path, origin, body }) => ({ path, kind: origin.kind, body })),
    ).toEqual([
      { path: null, kind: "accepted", body: DRAFT.body },
      { path: null, kind: "own", body: "and say which tests" },
    ]);
    const [accepted] = store.review().pending;
    expect(accepted?.origin).toEqual({
      kind: "accepted",
      draftId: "d1",
      evidence: DRAFT.evidence,
      draftBody: DRAFT.body,
    });
  });
});

describe("Show record", () => {
  class Transcripts extends FakeMend {
    readonly asked: Array<string> = [];
    override async transcript(sessionId: string): Promise<ReadonlyArray<TranscriptEntry>> {
      this.asked.push(sessionId);
      return [];
    }
  }

  it("opens the transcript of the session whose run the evidence cites, not the one selected", async () => {
    const mend = new Transcripts();
    const store = new ReviewStore(
      reads([
        { ...session("s1"), sealantRunId: "run-1" },
        { ...session("s2"), sealantRunId: "run-2" },
      ]),
      mend,
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await settle();
    expect(await store.record({ runId: "run-2" })).toMatchObject({
      kind: "found",
      sessionId: "s2",
    });
    expect(mend.asked).toEqual(["s2"]);
    // From the section's menu, with no evidence: the selected session's own record.
    expect(await store.record(null)).toMatchObject({ kind: "found", sessionId: "s1" });
  });

  it("opens nothing, and says why, for a run no session records now", async () => {
    const mend = new Transcripts();
    const store = new ReviewStore(
      reads([{ ...session("s1"), sealantRunId: "run-1" }]),
      mend,
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await settle();
    expect(await store.record({ runId: "run-0" })).toMatchObject({
      kind: "not-found",
      words: expect.stringMatching(/run-0/),
    });
    expect(await store.record({ runId: null })).toMatchObject({ kind: "not-found" });
    expect(mend.asked).toEqual([]);
  });
});

describe("Read this change, refused", () => {
  it("toasts once when the pass it started fails, whatever this machine's clock says", async () => {
    // Mend's clock is an hour behind this one: its pass starts "before" she asked.
    const behind = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    let pass: ReadPass | null = failedPass(earlier);
    class Passes extends FakeMend {
      override async readPass(): Promise<ReadPass | null> {
        return pass;
      }
      override async readChange(): Promise<void> {
        pass = failedPass(behind);
      }
    }
    const store = await readyStore(keptIn(await storage()), new Passes());
    const failures: Array<ReviewFailure> = [];
    store.onDidFail((failure) => failures.push(failure));
    await store.readChange();
    await settle();
    expect(failures.map(({ words }) => words)).toEqual([
      "Mend could not read this change: authentication_failed",
    ]);
  });

  it("says nothing of the failed pass Mend held before she asked", async () => {
    const before = new Date().toISOString();
    class StillOld extends FakeMend {
      override async readPass(): Promise<ReadPass | null> {
        return failedPass(before);
      }
      override async readChange(): Promise<void> {}
    }
    const store = await readyStore(keptIn(await storage()), new StillOld());
    const failures: Array<ReviewFailure> = [];
    store.onDidFail((failure) => failures.push(failure));
    await store.readChange();
    await settle();
    expect(failures).toEqual([]);
  });
});

describe("a comment VS Code could not keep", () => {
  it("is not shown as kept, and the same comment afterwards is", async () => {
    let failing = true;
    const store = await readyStore(
      keptIn(await storage(), {
        ...NODE_FILES,
        writeFile: async (path, text) => {
          if (failing) throw new Error("the disk is full.");
          await NODE_FILES.writeFile(path, text);
        },
      }),
    );
    const first = await store.comment(onLine(3, "Use the shared limiter"));
    expect(first).toEqual({ kept: false, words: expect.stringMatching(/the disk is full/) });
    expect(store.review().pending).toEqual([]);
    failing = false;
    expect(await store.comment(onLine(3, "Use the shared limiter"))).toEqual({ kept: true });
    expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
  });

  it("is refused past the cap, with why", async () => {
    const directory = await storage();
    await keptIn(directory).update(DANA_S1, () => ({
      pending: Array.from({ length: MAX_PENDING }, (_, index) => pending({ id: `p${index}` })),
      sends: [],
      document: null,
    }));
    const store = await readyStore(keptIn(directory));
    expect(await store.comment(onLine(3, "one more"))).toEqual({
      kept: false,
      words: expect.stringMatching(/already holds 200 pending comments/),
    });
    expect(store.review().pending).toHaveLength(MAX_PENDING);
  });

  it("waits, held, past the cap rather than going over it", async () => {
    const directory = await storage();
    let full = true;
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const store = await readyStore(
      keptIn(directory, {
        ...NODE_FILES,
        writeFile: async (path, text) => {
          if (full) throw new Error("the disk is full.");
          await NODE_FILES.writeFile(path, text);
        },
      }),
      mend,
    );
    await store.accept("d1", "I ran them by hand");
    full = false;
    await keptIn(directory).update(DANA_S1, () => ({
      pending: Array.from({ length: MAX_PENDING }, (_, index) => pending({ id: `p${index}` })),
      sends: [],
      document: null,
    }));
    await store.edit("p0", "edited while the review is full");
    expect(store.review().pending).toHaveLength(MAX_PENDING);
    expect(store.held().map((words) => words.comment.body)).toEqual(["I ran them by hand"]);
  });
});

/** Mend with one comment open on the change and not sent: what Send review sends. */
const mendWithOpen = (): FakeMend => {
  const mend = new FakeMend();
  mend.serverComments = [comment({ id: "c1" })];
  return mend;
};

/** Composes and sends the followed session's review as she wrote it. */
const sendAll = async (store: ReviewStore): Promise<string> => {
  const composed = store.compose();
  if (composed === null) throw new Error("nothing composed");
  expect(await sendComposed(store, composed, composed.text)).toEqual({ sent: true });
  const record = store.review().sends.at(-1);
  if (record === undefined) throw new Error("no review kept");
  return record.key;
};

const phaseOf = async (
  kept: KeptReviews,
  key: string,
  sessionId = "s1",
): Promise<string | undefined> =>
  (await kept.read({ ...DANA_S1, sessionId })).review.sends.find((record) => record.key === key)
    ?.phase.kind;

/** One machine's kept reviews in memory, so a test on fake timers drives every read and write. */
const inMemory = (): KeptReviews => keptIn("/global-storage/reviews", memoryFiles());

describe("sending a review from the store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends her held review's comments with her next Send, and Retry relaunches it once the agent is gone", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.answer = "pending";
    const store = await readyStore(kept, mend);
    const key = await sendAll(store);
    await settle();
    expect(await phaseOf(kept, key)).toBe("pending");
    // Held with no live agent: the title offers Retry delivery on it, not a second Send review.
    expect(store.offer()).toEqual({ kind: "retry" });
    expect(store.retryTarget()?.key).toBe(key);
    // Mend supersedes a held follow-up when a new key arrives: its comments are hers to send again.
    expect(store.compose()?.open).toEqual(["c1"]);
    const target = store.retryOf(key);
    if (target === null) throw new Error("no retry target");
    await store.retry(target);
    expect(mend.writes.filter((write) => write === `deliver s1 ${key}`)).toHaveLength(2);
  });

  it("sends nothing when only Mend's note is left, though the session was renamed since she composed it", async () => {
    let label = "add-rate-limit";
    const renamed = {
      ...sessionReads("change-1"),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
        session: { ...session(sessionId), ownerUserId: "dana", label },
        processes: [],
        currentAgent: null,
        changeId: "change-1",
      }),
    };
    const mend = new FakeMend();
    const store = new ReviewStore(renamed, mend, new ReviewMemory(memento()), inMemory(), noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    const { ref, document } = await store.keepDocument(composed);
    const saved = await store.saveDocument(ref, document.revision, mendNote("add-rate-limit"));
    if (saved.kind !== "saved") throw new Error(`not saved: ${saved.kind}`);

    label = "rate-limit-v2";
    store.reread();
    await vi.waitFor(() => expect(store.ready()?.sessionName).toBe("rate-limit-v2"), SETTLE);
    expect(await store.send(ref, saved.revision)).toEqual({
      sent: false,
      words: expect.stringMatching(/empty/),
    });
    await settle();
    expect(mend.writes).toEqual([]);
    expect(store.review().sends).toEqual([]);
  });

  it("sends exactly what it composed, and keeps her text when her comments changed", async () => {
    const store = await readyStore(inMemory());
    await store.comment(onLine(3, "first"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    await store.comment(onLine(4, "written after the editor opened"));
    const refused = await sendComposed(store, composed, composed.text);
    expect(refused).toEqual({ sent: false, words: expect.stringMatching(/changed/) });
    const { ref } = await store.keepDocument(composed);
    const elsewhere = { ...ref, place: { ...ref.place, sessionId: "s2" } };
    expect(await store.send(elsewhere, 1)).toMatchObject({ sent: false });
    expect(store.review().sends).toEqual([]);
    expect(store.review().pending.map(({ body }) => body)).toEqual([
      "first",
      "written after the editor opened",
    ]);
  });

  it.each([
    ["empty", "   \n", /empty/],
    ["longer than Mend takes", "x".repeat(100_001), /100,000/],
  ])(
    "sends nothing, and keeps her text and comments, when the review is %s",
    async (_, text, why) => {
      const mend = new FakeMend();
      const store = await readyStore(inMemory(), mend);
      await store.comment(onLine(3, "Use the shared limiter"));
      const composed = store.compose();
      if (composed === null) throw new Error("nothing composed");
      expect(await sendComposed(store, composed, text)).toEqual({
        sent: false,
        words: expect.stringMatching(why),
      });
      await settle();
      expect(mend.writes).toEqual([]);
      expect(store.review().sends).toEqual([]);
      expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
      expect(store.review().document?.text).toBe(text);
    },
  );

  it("delivers the review she composed on the slice it was composed on, after she repinned", async () => {
    const mend = new FakeMend();
    const store = await readyStore(inMemory(), mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const composed = store.compose();
    if (composed === null) throw new Error("nothing composed");
    const { ref, document } = await store.keepDocument(composed);
    const newer = {
      ...PINNED,
      id: "slice-2",
      diffDigest: "d2",
      head: checkpoint(3, "review-open"),
    };
    mend.chain = async () => ({
      worktreeId: "w1",
      baseName: "main",
      checkpoints: [...CHECKPOINTS, newer.head],
    });
    mend.openReview = async () => newer;
    await store.repin(false);
    await vi.waitFor(() => expect(store.ready()?.pinned.id).toBe("slice-2"), SETTLE);
    expect(await store.send(ref, document.revision)).toEqual({ sent: true });
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.delivered[0]).toMatchObject({
      reviewSliceId: PINNED.id,
      checkpointAId: PINNED.base.id,
      checkpointBId: PINNED.head.id,
      diffDigest: PINNED.diffDigest,
      instruction: expect.stringContaining("Use the shared limiter"),
    });
  });

  it("reads delivered only when Mend reads the comments back as sent", async () => {
    vi.useFakeTimers();
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.answer = "delivered";
    const storeReady = readyStore(kept, mend);
    await vi.advanceTimersByTimeAsync(20);
    const key = await sendAll(await storeReady);
    await vi.advanceTimersByTimeAsync(3_100);
    // Mend lists no follow-up, and the comment is not sent: not delivered.
    expect(await phaseOf(kept, key)).toBe("failed");
  });

  it("goes on watching a launch after a reload, by reads only, until the comments read sent", async () => {
    vi.useFakeTimers();
    const files = memoryFiles();
    const kept = keptIn("/global-storage/reviews", files);
    const mend = mendWithOpen();
    const first = readyStore(kept, mend);
    await vi.advanceTimersByTimeAsync(20);
    const key = await sendAll(await first);
    await vi.advanceTimersByTimeAsync(0);
    expect(await phaseOf(kept, key)).toBe("delivering");
    const writes = mend.writes.length;
    // A second window, as after a reload: it finds the launch and watches it.
    mend.listed = { key, status: "delivering", error: null };
    const reloaded = readyStore(keptIn("/global-storage/reviews", files), mend);
    await vi.advanceTimersByTimeAsync(20);
    await reloaded;
    mend.listed = null;
    mend.markSent("s1");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await phaseOf(kept, key)).toBe("delivered");
    expect(mend.writes).toHaveLength(writes);
  });

  it("ends a launch Mend never finishes as failed, so Retry is offered", async () => {
    vi.useFakeTimers();
    const kept = inMemory();
    const mend = mendWithOpen();
    const store = readyStore(kept, mend);
    await vi.advanceTimersByTimeAsync(20);
    const key = await sendAll(await store);
    mend.listed = { key: "someone-else", status: "pending", error: null };
    await vi.advanceTimersByTimeAsync(400 * 3_000 + 100);
    expect(await phaseOf(kept, key)).toBe("failed");
  });

  it("goes on while she reads another session, and Retry acts only on its own session's review", async () => {
    vi.useFakeTimers();
    const kept = inMemory();
    const mend = mendWithOpen();
    const ready = readyStore(kept, mend);
    await vi.advanceTimersByTimeAsync(20);
    const store = await ready;
    const key = await sendAll(store);
    store.follow(PROJECT, session("s2"));
    await vi.advanceTimersByTimeAsync(20);
    mend.markSent("s1");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await phaseOf(kept, key)).toBe("delivered");
    const writes = mend.writes.length;
    await store.retry({ place: { ...DANA_S1, sessionId: "s2" }, key });
    expect(mend.writes).toHaveLength(writes);
  });

  it("never opens again a draft dismissed after she accepted it", async () => {
    const kept = inMemory();
    const mend = new FakeMend();
    mend.serverComments = [
      comment({ id: "d1", state: "draft", author: { kind: "mend", name: "Mend" } }),
    ];
    const store = await readyStore(kept, mend);
    await store.accept("d1", "");
    // Dismissed on Mend, in another window or on the web, before the review reaches it.
    mend.serverComments = mend.serverComments.map((draft) => ({ ...draft, state: "dismissed" }));
    const key = await sendAll(store);
    await settle();
    expect(mend.writes).not.toContain("state d1 open");
    expect(await phaseOf(kept, key)).toBe("refused");
  });

  it("puts her words on Mend when she edited a draft she accepted, and dismisses the draft once they are there", async () => {
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const store = await readyStore(inMemory(), mend);
    await store.accept("d1", "");
    const [accepted] = store.review().pending;
    if (accepted === undefined) throw new Error("the draft was not accepted");
    const words = "Keep the limiter, and add a test for the burst case.";
    expect(await store.edit(accepted.id, words)).toEqual({ kept: true });
    const key = await sendAll(store);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    const hers = mend.serverComments.find((one) => one.body === words);
    expect(hers).toMatchObject({
      state: "open",
      author: { kind: "reviewer" },
      file: DRAFT.file,
      line: DRAFT.line,
    });
    expect(mend.delivered[0]?.commentIds).toEqual([hers?.id]);
    expect(mend.serverComments.find((one) => one.id === "d1")?.state).toBe("dismissed");
    expect(mend.writes).toEqual([`post ${words}`, "state d1 dismissed", `deliver s1 ${key}`]);
  });

  it("posts her comments on modified, renamed and deleted files where Mend's own check takes them", async () => {
    const oldSide: CommentAnchor = {
      sliceId: PINNED.id,
      baseId: PINNED.base.id,
      headId: PINNED.head.id,
      side: "old",
    };
    const mend = new FakeMend();
    mend.serverComments = [
      comment({
        id: "d1",
        state: "draft",
        author: { kind: "mend", name: "Mend" },
        file: "src/old-name.ts",
        line: 4,
        endLine: 4,
        anchor: oldSide,
        body: "The old name is still imported.",
      }),
      comment({
        id: "d2",
        state: "draft",
        author: { kind: "mend", name: "Mend" },
        file: "README",
        line: null,
        endLine: null,
        body: "The install notes went with it.",
      }),
    ];
    const store = await readyStore(inMemory(), mend);
    const on = (path: string, line: number, body: string): NewComment => ({
      ...onLine(line, body),
      at: { ...onLine(line, body).at, path },
    });
    expect(await store.comment(on("src/app.ts", 11, "On the modified file."))).toEqual({
      kept: true,
    });
    expect(await store.comment(on("src/new-name.ts", 4, "On the renamed file."))).toEqual({
      kept: true,
    });
    expect(await store.dismiss("d1", "On the renamed file's old side.")).toEqual({ kept: true });
    expect(await store.accept("d2", "")).toEqual({ kept: true });
    const readme = store.review().pending.find((one) => one.origin.kind === "accepted");
    if (readme === undefined) throw new Error("the draft was not accepted");
    expect(await store.edit(readme.id, "Keep the install notes.")).toEqual({ kept: true });
    await sendAll(store);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(
      mend.serverComments
        .filter((one) => one.author.kind === "reviewer")
        .map(({ file, line, anchor, body }) => ({ file, line, side: anchor?.side ?? null, body })),
    ).toEqual([
      { file: "src/app.ts", line: 11, side: "new", body: "On the modified file." },
      { file: "src/new-name.ts", line: 4, side: "new", body: "On the renamed file." },
      { file: "src/old-name.ts", line: 4, side: "old", body: "On the renamed file's old side." },
      { file: "README", line: null, side: null, body: "Keep the install notes." },
    ]);
  });

  it("opens the draft she accepted, not her words, when her edits leave its words as they were", async () => {
    const mend = new FakeMend();
    mend.serverComments = [{ ...DRAFT, body: `${DRAFT.body}\n` }];
    const store = await readyStore(inMemory(), mend);
    await store.accept("d1", "");
    const [accepted] = store.review().pending;
    if (accepted === undefined) throw new Error("the draft was not accepted");
    await store.edit(accepted.id, DRAFT.body);
    await store.edit(accepted.id, "Run the burst test too.");
    await store.edit(accepted.id, DRAFT.body);
    const key = await sendAll(store);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.writes).toEqual(["state d1 open", `deliver s1 ${key}`]);
  });

  const rewrite = async (mend: FakeMend, words: string): Promise<ReviewStore> => {
    const store = await readyStore(inMemory(), mend);
    await store.accept("d1", "");
    const [accepted] = store.review().pending;
    if (accepted === undefined) throw new Error("the draft was not accepted");
    expect(await store.edit(accepted.id, words)).toEqual({ kept: true });
    return store;
  };

  it("sends her edited words of a draft that was dismissed on Mend before the review reached it", async () => {
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const words = "Keep the limiter, and add a test for the burst case.";
    const store = await rewrite(mend, words);
    mend.serverComments = [{ ...DRAFT, state: "dismissed" }];
    await sendAll(store);
    await vi.waitFor(
      () => expect(store.review().sends.at(-1)?.phase.kind).not.toBe("sending"),
      SETTLE,
    );
    expect(store.review().sends.at(-1)?.phase.kind).not.toBe("refused");
    const hers = mend.serverComments.find((one) => one.body === words);
    expect(mend.delivered[0]?.commentIds).toEqual([hers?.id]);
    expect(mend.writes).not.toContain("state d1 dismissed");
  });

  it("posts her edited words of a draft about a whole file on that file, with no line", async () => {
    const mend = new FakeMend();
    mend.serverComments = [{ ...DRAFT, line: null, endLine: null }];
    const words = "Keep the file's exports as they are.";
    const store = await rewrite(mend, words);
    await sendAll(store);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.serverComments.find((one) => one.author.kind === "reviewer")).toMatchObject({
      body: words,
      file: DRAFT.file,
      line: null,
      endLine: null,
    });
  });

  it("posts her edited words of a draft on the slice the draft was written on", async () => {
    const mend = new FakeMend();
    const anchor = { sliceId: "slice-0", baseId: "cp0", headId: "cp1", side: "new" as const };
    mend.serverComments = [{ ...DRAFT, line: 3, endLine: 3, anchor }];
    const words = "Name the window, not the count.";
    const store = await rewrite(mend, words);
    await sendAll(store);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.serverComments.find((one) => one.author.kind === "reviewer")).toMatchObject({
      body: words,
      line: 3,
      anchor: { sliceId: "slice-0" },
    });
  });

  it("delivers the review though the draft her edited words replace could not be dismissed, and says that draft is still on Mend", async () => {
    class NoDismiss extends FakeMend {
      override async setCommentState(
        changeId: string,
        commentId: string,
        state: "open" | "addressed" | "dismissed",
      ): Promise<ServerComment> {
        if (state === "dismissed") throw new Error("Mend is restarting.");
        return super.setCommentState(changeId, commentId, state);
      }
    }
    const mend = new NoDismiss();
    mend.serverComments = [DRAFT];
    const words = "Keep the limiter, and add a test for the burst case.";
    const store = await rewrite(mend, words);
    const said: Array<string> = [];
    store.onDidFail((failure) => said.push(failure.words));
    const key = await sendAll(store);
    await vi.waitFor(() => expect(said).toHaveLength(1), SETTLE);
    expect(mend.delivered).toHaveLength(1);
    expect(said[0]).toMatch(/sent the review.*draft .* is still on Mend.*Mend is restarting/);
    expect(store.review().sends.find((record) => record.key === key)?.phase.kind).not.toBe(
      "refused",
    );
    const read = store.ready();
    if (read === null) throw new Error("the change is not read");
    expect(
      threadsOf(read, store.review(), "Dana").filter((thread) => thread.kind === "draft"),
    ).toEqual([]);
  });
});

describe("a full review of Mend drafts she rewrote", () => {
  it("posts every one, dismisses every draft, and still delivers the review", async () => {
    const kept = inMemory();
    const mend = new FakeMend();
    const drafts = Array.from({ length: MAX_PENDING }, (_, at) =>
      comment({
        id: `d${at}`,
        state: "draft",
        line: 3,
        endLine: 3,
        author: { kind: "mend", name: "Mend" },
        body: `Mend's draft ${at}`,
      }),
    );
    mend.serverComments = drafts;
    await kept.update(DANA_S1, () => ({
      pending: drafts.map((draft, at) =>
        pending({
          id: `p${at}`,
          line: 3,
          endLine: 3,
          body: `Her words in place of draft ${at}`,
          origin: { kind: "accepted", draftId: draft.id, evidence: [], draftBody: draft.body },
        }),
      ),
      sends: [],
      document: null,
    }));
    const store = await readyStore(kept, mend);
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).not.toBe("sending"), {
      timeout: 20_000,
    });
    expect(mend.writes.filter((write) => write.startsWith("post "))).toHaveLength(MAX_PENDING);
    expect(mend.writes.filter((write) => write.endsWith(" dismissed"))).toHaveLength(MAX_PENDING);
    expect(mend.delivered).toHaveLength(1);
  }, 30_000);
});

describe("a call Mend refuses while a review is on its way", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads delivery failed, with Retry, when the launch's follow-up read is refused", async () => {
    vi.useFakeTimers();
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.followUp = async () => {
      throw new MendApiError("You cannot read this session's follow-ups.", 403);
    };
    const ready = readyStore(kept, mend);
    await vi.advanceTimersByTimeAsync(20);
    const store = await ready;
    const key = await sendAll(store);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await phaseOf(kept, key)).toBe("failed");
    expect(store.offer()).toEqual({ kind: "retry" });
  });

  it("keeps a comment whose POST may have landed on its way, when the read that checks is refused", async () => {
    const kept = inMemory();
    const mend = new FakeMend();
    const store = await readyStore(kept, mend);
    await store.comment(onLine(3, "Use the shared limiter"));
    const post = mend.postComment.bind(mend);
    mend.postComment = async (changeId, sliceId, target, body) => {
      await post(changeId, sliceId, target, body);
      throw new MendApiError("Bad gateway", 502);
    };
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("failed"), SETTLE);
    mend.comments = async () => {
      throw new MendApiError("Not found", 404);
    };
    await store.retry({ place: DANA_S1, key });
    expect(await phaseOf(kept, key)).toBe("failed");
    expect(store.review().pending).toEqual([]);
  });

  it("reads delivery failed, with Retry, when Mend asks VS Code to deliver later", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.deliver = async () => {
      throw new MendApiError("Too many follow-ups at once. Try again in a minute.", 429);
    };
    const store = await readyStore(kept, mend);
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).not.toBe("sending"), SETTLE);
    expect(await phaseOf(kept, key)).toBe("failed");
  });

  it("reads not sent when Mend refuses to deliver the review", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.deliver = async () => {
      throw new MendApiError("The instruction is empty.", 422);
    };
    const store = await readyStore(kept, mend);
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).not.toBe("sending"), SETTLE);
    expect(await phaseOf(kept, key)).toBe("refused");
  });
});

/**
 * Session reads whose sign-in moves: Dana's token, a later sign-in of hers, or Erin's, on one
 * server. Mend says who a token belongs to only while `says` holds; otherwise the read fails.
 */
const signIns = () => {
  const at = { token: "dana-1", says: true };
  const owners: Readonly<Record<string, string>> = {
    "dana-1": "dana",
    "dana-2": "dana",
    erin: "erin",
  };
  const ownerOf = (token: string | null): string | null =>
    at.says && token !== null ? (owners[token] ?? null) : null;
  return {
    at,
    sessions: {
      ...sessionReads("change-1"),
      connection: async () => ({ url: "http://mend", token: at.token }),
      accountOf: async (connection: { readonly token: string | null }): Promise<string | null> =>
        ownerOf(connection.token),
    },
  };
};

/**
 * Dana's sign-ins, whose account MendClient reads from Mend's `/organization` through each
 * sign-in's own token: `dana-1` is Dana's, no token is signed out (401), and any other token gets
 * `failing`, Mend's answer while it cannot say.
 */
const organization = (failing: () => Response) => {
  const at: { token: string | null } = { token: "dana-1" };
  const asked = { count: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      asked.count += 1;
      const token = new Headers(init?.headers).get("authorization");
      if (token === "Bearer dana-1") return new Response(JSON.stringify({ userId: "dana" }));
      if (token === null)
        return new Response(JSON.stringify({ message: "Sign in" }), { status: 401 });
      return failing();
    }),
  );
  const client = new MendClient({
    get: async () => ({ url: "http://mend", token: at.token }),
    refused: async () => undefined,
  });
  return {
    at,
    asked,
    sessions: {
      ...sessionReads("change-1"),
      connection: async () => ({ url: "http://mend", token: at.token }),
      accountOf: (connection: MendConnection) => client.accountOf(connection),
    },
  };
};

describe("a review on its way while VS Code is signed out, or Mend cannot say who signed in", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops once VS Code is signed out: the review reads failed, with Retry, and Mend is asked nothing more", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    const { at, asked, sessions } = organization(() => new Response("{}", { status: 503 }));
    const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);

    at.token = null;
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("failed"), SETTLE);
    const record = (await kept.read(DANA_S1)).review.sends.find(
      (candidate) => candidate.key === key,
    );
    expect(record?.phase).toMatchObject({
      words: "VS Code was signed out of Mend before Mend answered",
    });
    const before = asked.count;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(asked.count).toBe(before);
    expect(mend.delivered).toEqual([]);
  }, 15_000);

  it("reads the review failed, with Retry, once Mend could not say whose a new sign-in is for a while", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    const { at, sessions } = organization(() => new Response("{}", { status: 503 }));
    const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);

    at.token = "dana-2";
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("failed"), {
      timeout: 12_000,
    });
    const record = (await kept.read(DANA_S1)).review.sends.find(
      (candidate) => candidate.key === key,
    );
    expect(record?.phase).toMatchObject({
      words: "Mend could not say which account VS Code is signed in as",
    });
    expect(mend.delivered).toEqual([]);
  }, 20_000);
});

describe("a review on its way while VS Code's sign-in changes on the same server", () => {
  it("sends nothing on Retry while Mend cannot say whose a new sign-in is", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    let asked = 0;
    mend.deliver = async () => {
      asked += 1;
      throw new MendApiError("Mend is restarting.", 503);
    };
    const { at, sessions } = signIns();
    const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("failed"), SETTLE);
    expect(asked).toBe(1);

    at.token = "erin";
    at.says = false;
    expect(await store.retry({ place: DANA_S1, key })).toEqual({
      retried: false,
      words: expect.any(String),
    });
    await settle();
    expect(asked).toBe(1);
    expect(await phaseOf(kept, key)).toBe("failed");
  });

  it("is delivered when she signs in again as herself while Mend takes it", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.answer = "pending";
    const held: { land: (() => void) | null } = { land: null };
    const deliver = mend.deliver.bind(mend);
    mend.deliver = async (sessionId, request) => {
      await new Promise<void>((resolve) => {
        held.land = resolve;
      });
      return deliver(sessionId, request);
    };
    const { at, sessions } = signIns();
    const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const key = await sendAll(store);
    await vi.waitFor(() => expect(held.land).not.toBeNull(), SETTLE);

    at.token = "dana-2";
    held.land?.();
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).not.toBe("sending"), SETTLE);
    expect(await phaseOf(kept, key)).toBe("pending");
    expect(mend.delivered).toHaveLength(1);
  });

  it("waits, sending nothing and reading nothing failed, while Mend cannot say whose a new sign-in is, and goes on once it can", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.answer = "pending";
    const held: { land: (() => void) | null } = { land: null };
    const deliver = mend.deliver.bind(mend);
    mend.deliver = async (sessionId, request) => {
      if (held.land === null)
        await new Promise<void>((resolve) => {
          held.land = resolve;
        });
      return deliver(sessionId, request);
    };
    const { at, sessions } = signIns();
    const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const key = await sendAll(store);
    await vi.waitFor(() => expect(held.land).not.toBeNull(), SETTLE);

    at.token = "erin";
    at.says = false;
    held.land?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await phaseOf(kept, key)).toBe("sending");

    at.token = "dana-1";
    at.says = true;
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("pending"), SETTLE);
    expect(new Set(mend.delivered.map((request) => request.idempotencyKey))).toEqual(
      new Set([key]),
    );
  });

  it("never shows Dana's pending comments once another sign-in Mend cannot name reads the session", async () => {
    const { at, sessions } = signIns();
    const store = new ReviewStore(
      sessions,
      new FakeMend(),
      new ReviewMemory(memento()),
      inMemory(),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    await store.comment(onLine(3, "Dana's own words"));
    expect(store.review().pending).toHaveLength(1);

    at.token = "erin";
    at.says = false;
    const before = store.ready()?.readAt;
    store.reread();
    await vi.waitFor(() => expect(store.ready()?.readAt).not.toBe(before), SETTLE);
    expect(store.review().pending).toEqual([]);
  });

  it("keeps no comment while Mend cannot say whose the sign-in is, so no other sign-in finds it, and says its words stay in the thread", async () => {
    const kept = inMemory();
    const { at, sessions } = signIns();
    at.token = "erin";
    at.says = false;
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const unnamed = async (): Promise<ReviewStore> => {
      const store = new ReviewStore(sessions, mend, new ReviewMemory(memento()), kept, noPaste);
      store.follow(PROJECT, session("s1"));
      await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
      return store;
    };
    const store = await unnamed();
    expect(await store.comment(onLine(3, "Erin's own words"))).toEqual({
      kept: false,
      words: expect.stringMatching(
        /Mend could not say which account VS Code is signed in as.*Its words are still in the thread\.$/,
      ),
    });
    expect(await store.accept("d1", "Erin's reply")).toEqual({
      kept: false,
      words: expect.stringMatching(
        /Mend could not say which account VS Code is signed in as.*Your words are still in the thread\.$/,
      ),
    });
    expect(store.review().pending).toEqual([]);
    expect((await unnamed()).review().pending).toEqual([]);
  });
});

describe("Retry delivery of a review another window delivered meanwhile", () => {
  it("says it sent nothing, and what the review reads now", async () => {
    const kept = inMemory();
    const mend = mendWithOpen();
    mend.deliver = async () => {
      throw new MendApiError("Mend is restarting.", 503);
    };
    let meanwhile: (() => Promise<void>) | null = null;
    const delayed = {
      ...sessionReads("change-1"),
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => {
        await meanwhile?.();
        return sessionReads("change-1").sessionDetail(sessionId);
      },
    };
    const store = new ReviewStore(delayed, mend, new ReviewMemory(memento()), kept, noPaste);
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const key = await sendAll(store);
    await vi.waitFor(async () => expect(await phaseOf(kept, key)).toBe("failed"), SETTLE);
    meanwhile = async () => {
      meanwhile = null;
      await kept.update(DANA_S1, (review) => ({
        ...review,
        sends: review.sends.map((record) => ({
          ...record,
          phase: { kind: "delivered", at: "2026-10-20T10:05:00.000Z" },
        })),
      }));
    };
    const writes = mend.writes.length;
    expect(await store.retry({ place: DANA_S1, key })).toEqual({
      retried: false,
      words: "Retry delivery sent nothing: this review already reads sent",
    });
    expect(mend.writes).toHaveLength(writes);
  });
});
