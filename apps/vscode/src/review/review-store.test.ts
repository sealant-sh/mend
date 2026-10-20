import { describe, expect, it, vi } from "vitest";

import { MendApiError } from "../mend-http.js";
import type { Session, SessionDetail } from "../types.js";
import { NODE_FILES } from "./kept-reviews.js";
import type { KeptReviews } from "./kept-reviews.js";
import { addPending, MAX_PENDING } from "./pending.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import type { ReadPass, ServerComment, TranscriptEntry } from "./review-wire.js";
import {
  comment,
  FakeMend,
  keptIn,
  PINNED,
  PROJECT,
  pending,
  session,
  sessionReads,
  settle,
  slowFiles,
  storage,
} from "./test-fixtures.js";

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
  const store = new ReviewStore(sessionReads("change-1"), mend, new ReviewMemory(memento()), kept);
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull());
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
});

describe("a comment she submits", () => {
  it("says it was not kept, and why, while the change is still being read", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
      keptIn(await storage()),
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
    }));
    const store = await readyStore(keptIn(directory));
    expect(await store.comment(onLine(3, "one more"))).toEqual({
      kept: false,
      words: expect.stringMatching(/already holds 200 pending comments/),
    });
    expect(store.review().pending).toHaveLength(MAX_PENDING);
  });
});
