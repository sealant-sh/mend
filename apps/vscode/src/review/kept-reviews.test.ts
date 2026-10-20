import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { KEPT_REVIEW_TTL_MS, KeptReviews, NODE_FILES, type ReviewPlace } from "./kept-reviews.js";
import { addPending, type SessionReview } from "./pending.js";
import { keptIn, pending, slowFiles, storage } from "./test-fixtures.js";

const DANA: ReviewPlace = { url: "http://mend", viewer: "dana", sessionId: "s1" };

const addOne = (review: SessionReview): SessionReview =>
  addPending(review, pending({ body: "kept?" }));

const bodies = async (kept: KeptReviews, place: ReviewPlace = DANA): Promise<Array<string>> =>
  (await kept.read(place)).review.pending.map(({ body }) => body);

describe("her pending comments, kept for every window of one VS Code", () => {
  it("survive a reload: one window writes them, the next window reads them", async () => {
    const directory = await storage();
    await keptIn(directory).update(DANA, (review) => addPending(review, pending({})));
    expect(await bodies(keptIn(directory))).toEqual(["Use the shared limiter from guard.ts"]);
  });

  it("keep both windows' comments when the two write at once", async () => {
    const directory = await storage();
    // Each window holds its own reads back, so both read the review before either writes it.
    const first = keptIn(directory, slowFiles(30));
    const second = keptIn(directory, slowFiles(30));
    await Promise.all([
      first.update(DANA, (review) => addPending(review, pending({ id: "a", body: "first" }))),
      second.update(DANA, (review) => addPending(review, pending({ id: "b", body: "second" }))),
    ]);
    expect((await bodies(keptIn(directory))).toSorted()).toEqual(["first", "second"]);
    expect((await keptIn(directory).read(DANA)).rev).toBe(2);
  });

  it("are kept per person: another account on the same server reads none of them", async () => {
    const directory = await storage();
    await keptIn(directory).update(DANA, (review) => addPending(review, pending({})));
    expect(await bodies(keptIn(directory), { ...DANA, viewer: "ana" })).toEqual([]);
    expect(await bodies(keptIn(directory), { ...DANA, url: "http://other" })).toEqual([]);
    expect(await bodies(keptIn(directory), { ...DANA, sessionId: "s2" })).toEqual([]);
  });

  it("stay as they were when a write fails, and the same write afterwards is kept", async () => {
    const directory = await storage();
    let failing = true;
    const kept = keptIn(directory, {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (failing) throw new Error("the disk is full.");
        await NODE_FILES.writeFile(path, text);
      },
    });
    await expect(kept.update(DANA, addOne)).rejects.toThrow("the disk is full.");
    expect(await bodies(kept)).toEqual([]);
    failing = false;
    await kept.update(DANA, addOne);
    expect(await bodies(keptIn(directory))).toEqual(["kept?"]);
  });

  it("are written by a window after another died holding the session's lock", async () => {
    const directory = await storage();
    const kept = keptIn(directory);
    await kept.update(DANA, (review) => review);
    const [folder] = await readdir(directory);
    if (folder === undefined) throw new Error("no folder was made for her reviews");
    const lock = join(directory, folder, "s1.json.lock");
    await writeFile(lock, "0");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await kept.update(DANA, (review) => addPending(review, pending({})));
    expect(await bodies(kept)).toEqual(["Use the shared limiter from guard.ts"]);
  });

  it("go once untouched past the expiry", async () => {
    const directory = await storage();
    let now = Date.now();
    const kept = new KeptReviews(directory, NODE_FILES, () => now);
    await kept.update(DANA, (review) => addPending(review, pending({})));
    const [folder] = await readdir(directory);
    if (folder === undefined) throw new Error("no folder was made for her reviews");
    const file = join(directory, folder, "s1.json");
    const old = new Date(Date.now() - KEPT_REVIEW_TTL_MS - 1_000);
    await utimes(file, old, old);
    now += 2 * 60 * 60 * 1000;
    await kept.update({ ...DANA, sessionId: "s2" }, (review) => addPending(review, pending({})));
    expect(await bodies(kept)).toEqual([]);
    expect(await bodies(kept, { ...DANA, sessionId: "s2" })).toHaveLength(1);
  });
});
