import { describe, expect, it } from "vitest";

import type { KeptFiles } from "./kept-reviews.js";
import { parsePins, PIN_UNUSED_MS, ReviewMemory } from "./review-memory.js";
import { keptIn, memoryFiles } from "./test-fixtures.js";

const DAY = 24 * 60 * 60 * 1000;

/** A window of this VS Code: its own pins over the global storage every window shares. */
const windowOn = (files: KeptFiles, now: () => number = Date.now): ReviewMemory =>
  new ReviewMemory(keptIn("/global-storage/reviews", files), now);

/** The machine's disk, and how many files were written to it. */
const counted = (): { readonly files: KeptFiles; readonly writes: () => number } => {
  const files = memoryFiles();
  let writes = 0;
  return {
    files: {
      ...files,
      writeFile: async (path, text) => {
        if (path.includes("/pins/") && !path.includes(".lock")) writes += 1;
        await files.writeFile(path, text);
      },
    },
    writes: () => writes,
  };
};

describe("the key that pins a change's slice", () => {
  it("is the same after a reload, so reviews/open answers the same slice", async () => {
    const files = memoryFiles();
    const first = await windowOn(files).pinKey("http://mend", "change-1");
    const afterReload = await windowOn(files).pinKey("http://mend", "change-1");
    expect(afterReload).toBe(first);
  });

  it("is made anew only by a re-pin, and per server", async () => {
    const memory = windowOn(memoryFiles());
    const first = await memory.pinKey("http://mend", "change-1");
    expect(await memory.pinKey("http://other", "change-1")).not.toBe(first);
    const repinned = await memory.repin("http://mend", "change-1");
    expect(repinned).not.toBe(first);
    expect(await memory.pinKey("http://mend", "change-1")).toBe(repinned);
  });

  it("is one key when two windows first read the change at the same moment", async () => {
    const files = memoryFiles();
    const [first, second] = [windowOn(files), windowOn(files)];
    const keys = await Promise.all([
      first.pinKey("http://mend", "change-1"),
      second.pinKey("http://mend", "change-1"),
    ]);
    expect(keys[1]).toBe(keys[0]);
    expect(await first.pinKey("http://mend", "change-1")).toBe(keys[0]);
  });

  it("is written at most once a day by the reads that use it", async () => {
    const { files, writes } = counted();
    let now = Date.now();
    const memory = windowOn(files, () => now);
    const key = await memory.pinKey("http://mend", "change-1");
    for (let read = 0; read < 5; read += 1)
      expect(await memory.pinKey("http://mend", "change-1")).toBe(key);
    expect(writes()).toBe(1);
    now += DAY;
    expect(await memory.pinKey("http://mend", "change-1")).toBe(key);
    expect(writes()).toBe(2);
  });

  it("goes once no read used it past the expiry, so the pins do not grow forever", async () => {
    let now = Date.now();
    const files = memoryFiles();
    const memory = windowOn(files, () => now);
    const old = await memory.pinKey("http://mend", "change-1");
    const kept = await memory.pinKey("http://mend", "change-2");
    now += PIN_UNUSED_MS - DAY;
    expect(await memory.pinKey("http://mend", "change-2")).toBe(kept);
    now += 2 * DAY;
    await memory.pinKey("http://mend", "change-3");
    const text = await files.readFile("/global-storage/reviews/pins/http%3A%2F%2Fmend.json");
    const stored = parsePins(Reflect.get(JSON.parse(text), "record"));
    expect(Object.keys(stored).toSorted()).toEqual(["change-2", "change-3"]);
    expect(await memory.pinKey("http://mend", "change-1")).not.toBe(old);
  });

  it("reads anything unreadable as nothing kept", () => {
    expect(parsePins("garbage")).toEqual({});
    expect(parsePins({ a: { key: "k", usedAt: 1 }, b: 3, c: { key: 4, usedAt: 1 } })).toEqual({
      a: { key: "k", usedAt: 1 },
    });
  });
});
