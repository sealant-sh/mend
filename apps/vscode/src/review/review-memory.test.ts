import { describe, expect, it } from "vitest";

import { parseServerMemory, ReviewMemory, type ReviewMemento } from "./review-memory.js";

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
