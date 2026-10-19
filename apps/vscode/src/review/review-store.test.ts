import { describe, expect, it, vi } from "vitest";

import { MendApiError } from "../mend-http.js";
import type { SessionDetail } from "../types.js";
import { addPending } from "./pending.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type NewComment, type ReviewFailure } from "./review-store.js";
import {
  FakeMend,
  PINNED,
  PROJECT,
  pending,
  session,
  sessionReads,
  settle,
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

/** A window's review store, following `s1`, its change read. */
const readyStore = async (kept: ReviewMemento): Promise<ReviewStore> => {
  const store = new ReviewStore(sessionReads("change-1"), new FakeMend(), new ReviewMemory(kept));
  store.follow(PROJECT, session("s1"));
  await settle();
  expect(store.ready()).not.toBeNull();
  return store;
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

describe("the review store, as it follows one session after another", () => {
  it("never shows one session's pending comments under the next, when the first's read lands late", async () => {
    const memory = new ReviewMemory(memento());
    await memory.updateSession("http://mend", "ana", (stored) =>
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
      new ReviewClient(async () => {
        throw new Error("no review route is read for a session without a change");
      }),
      memory,
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
    const kept = memento();
    const store = await readyStore(kept);
    await store.comment(onLine(3, "Use the shared limiter"));
    store.forget();
    expect(store.state()).toEqual({ kind: "idle" });
    expect(store.review().pending).toEqual([]);
    const stored = new ReviewMemory(kept).readSession("http://mend", "s1").pending;
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
    );
    store.follow(PROJECT, session("s1"));
    store.forget();
    held.resolve();
    await settle();
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("lets the same session be followed again afterwards", async () => {
    const store = await readyStore(memento());
    store.forget();
    store.follow(PROJECT, session("s1"));
    await settle();
    expect(store.ready()).not.toBeNull();
  });
});

describe("two windows on one session", () => {
  it("each keep the other's pending comments, and a delete takes only its own", async () => {
    const kept = memento();
    const first = await readyStore(kept);
    const second = await readyStore(kept);
    await first.comment(onLine(3, "from the first window"));
    await second.comment(onLine(4, "from the second window"));
    const bodies = () =>
      new ReviewMemory(kept).readSession("http://mend", "s1").pending.map(({ body }) => body);
    expect(bodies()).toEqual(["from the first window", "from the second window"]);
    const own = second.review().pending.find(({ body }) => body === "from the second window");
    if (own === undefined) throw new Error("the second window lost its own comment");
    await second.remove(own.id);
    expect(bodies()).toEqual(["from the first window"]);
    // The first window's next write keeps the second's delete: nothing it read earlier comes back.
    const [mine] = first.review().pending;
    if (mine === undefined) throw new Error("the first window lost its own comment");
    await first.edit(mine.id, "edited in the first window");
    expect(bodies()).toEqual(["edited in the first window"]);
  });
});

describe("a comment she submits", () => {
  it("says it was not kept, and why, while the change is still being read", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
    );
    const kept = await store.comment(onLine(3, "Use the shared limiter"));
    expect(kept).toEqual({ kept: false, words: expect.stringMatching(/not kept/) });
  });

  it("says it was not kept on a slice the section no longer shows", async () => {
    const store = await readyStore(memento());
    const moved = onLine(3, "Use the shared limiter");
    const kept = await store.comment({ ...moved, at: { ...moved.at, slice: "slice-0" } });
    expect(kept).toEqual({ kept: false, words: expect.stringMatching(/not kept/) });
    expect(store.review().pending).toEqual([]);
  });

  it("says it was kept once it is pending", async () => {
    const store = await readyStore(memento());
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
