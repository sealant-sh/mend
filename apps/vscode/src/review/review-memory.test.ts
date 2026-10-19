import { describe, expect, it } from "vitest";

import { addPending } from "./pending.js";
import { parseServerMemory, ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { pending } from "./test-fixtures.js";

/** `globalState` as one VS Code keeps it across window reloads: a value that outlives its readers. */
const memento = (): ReviewMemento & { readonly saved: Map<string, unknown> } => {
  const saved = new Map<string, unknown>();
  return {
    saved,
    get: (key) => saved.get(key),
    update: async (key, value) => {
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
};

describe("the key that pins a change's slice", () => {
  it("is the same after a reload, so reviews/open answers the same slice", async () => {
    const kept = memento();
    const first = await new ReviewMemory(kept).pinKey("http://mend", "change-1");
    const afterReload = await new ReviewMemory(kept).pinKey("http://mend", "change-1");
    expect(afterReload).toBe(first);
  });

  it("is made anew only by a re-pin, and per server", async () => {
    const kept = memento();
    const memory = new ReviewMemory(kept);
    const first = await memory.pinKey("http://mend", "change-1");
    expect(await memory.pinKey("http://other", "change-1")).not.toBe(first);
    const repinned = await memory.repin("http://mend", "change-1");
    expect(repinned).not.toBe(first);
    expect(await memory.pinKey("http://mend", "change-1")).toBe(repinned);
  });

  it("reads anything unreadable as nothing kept", () => {
    expect(parseServerMemory("garbage")).toEqual({ pins: {} });
    expect(parseServerMemory({ pins: { a: "k", b: 3 } })).toEqual({ pins: { a: "k" } });
  });
});

describe("a session's review as this window reads it", () => {
  it("never goes back to an older value VS Code hands back late", async () => {
    const kept = memento();
    const memory = new ReviewMemory(kept);
    await memory.updateSession("http://mend", "s1", (review) =>
      addPending(review, pending({ id: "p1", body: "first" })),
    );
    const key = [...kept.saved.keys()][0];
    if (key === undefined) throw new Error("nothing kept");
    const earlier = kept.saved.get(key);
    await memory.updateSession("http://mend", "s1", (review) =>
      addPending(review, pending({ id: "p2", body: "second" })),
    );
    // The main process sends back the first write after the second: globalState now reads it.
    kept.saved.set(key, earlier);
    const bodies = () => memory.readSession("http://mend", "s1").pending.map(({ body }) => body);
    expect(bodies()).toEqual(["first", "second"]);
    await memory.updateSession("http://mend", "s1", (review) =>
      addPending(review, pending({ id: "p3", body: "third" })),
    );
    expect(bodies()).toEqual(["first", "second", "third"]);
  });

  it("takes another window's newer write", async () => {
    const kept = memento();
    const mine = new ReviewMemory(kept);
    const theirs = new ReviewMemory(kept);
    await mine.updateSession("http://mend", "s1", (review) =>
      addPending(review, pending({ id: "p1", body: "mine" })),
    );
    await theirs.updateSession("http://mend", "s1", (review) =>
      addPending(review, pending({ id: "p2", body: "theirs" })),
    );
    expect(mine.readSession("http://mend", "s1").pending.map(({ body }) => body)).toEqual([
      "mine",
      "theirs",
    ]);
  });
});
