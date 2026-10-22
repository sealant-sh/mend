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

  it("is one key when two windows first read the change at the same moment", async () => {
    // VS Code's globalState as each window holds it: its own copy, written back whole.
    const stored = new Map<string, unknown>();
    const window = (): ReviewMemento => {
      const copy = new Map(stored);
      return {
        get: (key) => copy.get(key),
        update: async (key, value) => {
          copy.set(key, value);
          stored.set(key, value);
        },
      };
    };
    const [first, second] = [new ReviewMemory(window()), new ReviewMemory(window())];
    const keys = await Promise.all([
      first.pinKey("http://mend", "change-1"),
      second.pinKey("http://mend", "change-1"),
    ]);
    expect(keys[1]).toBe(keys[0]);
    expect(await first.pinKey("http://mend", "change-1")).toBe(keys[0]);
  });

  it("reads anything unreadable as nothing kept", () => {
    expect(parseServerMemory("garbage")).toEqual({ pins: {} });
    expect(parseServerMemory({ pins: { a: "k", b: 3 } })).toEqual({ pins: { a: "k" } });
  });
});
