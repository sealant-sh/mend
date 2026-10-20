import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DRIVE_STALE_MS,
  KEPT_REVIEW_TTL_MS,
  KeptReviews,
  NODE_FILES,
  type ReviewPlace,
} from "./kept-reviews.js";
import { addPending, type SessionReview } from "./pending.js";
import { keptIn, pending, slowFiles, storage } from "./test-fixtures.js";

const DANA: ReviewPlace = { url: "http://mend", viewer: "dana", sessionId: "s1" };

const addOne = (review: SessionReview): SessionReview =>
  addPending(review, pending({ body: "kept?" }));

const bodies = async (kept: KeptReviews, place: ReviewPlace = DANA): Promise<Array<string>> =>
  (await kept.read(place)).review.pending.map(({ body }) => body);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Her review's lock file, once a first write has made her folder. */
const lockOf = async (directory: string): Promise<string> => {
  await keptIn(directory).update(DANA, (review) => review);
  const [folder] = await readdir(directory);
  if (folder === undefined) throw new Error("no folder was made for her reviews");
  return join(directory, folder, "s1.json.lock");
};

/**
 * A window that looks at the lock once, its holder or its age, then is held back until another
 * window has taken the lock since, before it acts on what it saw.
 */
const lateOnTheLock = (
  files: typeof NODE_FILES,
): { readonly files: typeof NODE_FILES; readonly looked: Promise<void> } => {
  const { promise: looked, resolve: look } = Promise.withResolvers<void>();
  let first = true;
  const late = async <T>(path: string, seen: () => Promise<T>): Promise<T> => {
    if (!first || !path.endsWith(".lock")) return seen();
    first = false;
    const text = (): Promise<string | null> => NODE_FILES.readFile(path).catch(() => null);
    const before = await text();
    const saw = await seen();
    look();
    for (let waited = 0; waited < 2_000; waited += 5) {
      const now = await text();
      if (now !== null && now !== before) break;
      await pause(5);
    }
    return saw;
  };
  return {
    files: {
      ...files,
      readFile: (path) => late(path, () => files.readFile(path)),
      modified: (path) => late(path, () => files.modified(path)),
    },
    looked,
  };
};

/** A window whose write of a new review waits until the test lets it go on. */
const heldWrite = (): {
  readonly files: typeof NODE_FILES;
  readonly writing: Promise<void>;
  readonly go: () => void;
} => {
  const { promise: writing, resolve: reached } = Promise.withResolvers<void>();
  const { promise: allowed, resolve: go } = Promise.withResolvers<void>();
  return {
    files: {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (path.endsWith(".tmp") && !/\.(lock|drive)\./.test(path)) {
          reached();
          await allowed;
        } else if (!path.endsWith(".tmp")) {
          // A write in place is truncated before it is written; another window can read between.
          await NODE_FILES.writeFile(path, "");
          await pause(40);
        }
        await NODE_FILES.writeFile(path, text);
      },
    },
    writing,
    go: () => go(),
  };
};

describe("the session's lock, between windows", () => {
  it("is broken by one window when two find it stale at once, and both comments are kept", async () => {
    const directory = await storage();
    const lock = await lockOf(directory);
    await writeFile(lock, "0");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const late = lateOnTheLock(slowFiles(30));
    const fromSecond = keptIn(directory, late.files).update(DANA, (review) =>
      addPending(review, pending({ id: "b", body: "second" })),
    );
    await late.looked;
    const fromFirst = keptIn(directory, slowFiles(100)).update(DANA, (review) =>
      addPending(review, pending({ id: "a", body: "first" })),
    );
    const kept = await Promise.all([fromFirst, fromSecond]);
    expect(kept.map(({ rev }) => rev).toSorted()).toEqual([1, 2]);
    expect((await bodies(keptIn(directory))).toSorted()).toEqual(["first", "second"]);
  });

  it("stays a slow live window's past the stale age: the other window waits for its write", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const directory = await storage();
      let late = 0;
      const clock = (): number => Date.now() + late;
      const slow = heldWrite();
      const holder = new KeptReviews(directory, slow.files, clock);
      const other = new KeptReviews(directory, NODE_FILES, clock);
      const held = holder.update(DANA, (review) =>
        addPending(review, pending({ id: "a", body: "slow" })),
      );
      await slow.writing;
      late += 20_000;
      vi.advanceTimersByTime(20_000);
      await pause(50);
      const waiting = other.update(DANA, (review) =>
        addPending(review, pending({ id: "b", body: "other" })),
      );
      await pause(50);
      slow.go();
      const kept = await Promise.all([held, waiting]);
      expect(kept.map(({ rev }) => rev)).toEqual([1, 2]);
      expect((await bodies(keptIn(directory))).toSorted()).toEqual(["other", "slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not removed by a window that stalled holding it once another took it over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const directory = await storage();
      const lock = await lockOf(directory);
      let late = 0;
      const clock = (): number => Date.now() + late;
      const stalled = heldWrite();
      const next = heldWrite();
      const holder = new KeptReviews(directory, stalled.files, clock);
      const successor = new KeptReviews(directory, next.files, clock);
      const held = holder.update(DANA, (review) =>
        addPending(review, pending({ id: "a", body: "stalled" })),
      );
      await stalled.writing;
      // No heartbeat fires, as for a window whose event loop is blocked.
      late += 20_000;
      const taken = successor.update(DANA, (review) =>
        addPending(review, pending({ id: "b", body: "next" })),
      );
      await next.writing;
      stalled.go();
      await expect(held).rejects.toThrow(/another window/);
      expect(await NODE_FILES.modified(lock)).not.toBeNull();
      next.go();
      expect((await taken).rev).toBe(1);
      expect(await bodies(keptIn(directory))).toEqual(["next"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe("the window that drives a send", () => {
  it("is one: the other window neither claims it nor ends it while its lease is fresh", async () => {
    const directory = await storage();
    const first = keptIn(directory);
    const second = keptIn(directory);
    const claims = await Promise.all([
      first.claimDrive(DANA, "key-1"),
      second.claimDrive(DANA, "key-1"),
    ]);
    expect(claims.toSorted()).toEqual([false, true]);
    const [driver, other] = claims[0] ? [first, second] : [second, first];
    expect(await other.drivenElsewhere(DANA, "key-1")).toBe(true);
    expect(await driver.drivenElsewhere(DANA, "key-1")).toBe(false);
    await driver.releaseDrive(DANA, "key-1");
    expect(await other.drivenElsewhere(DANA, "key-1")).toBe(false);
    expect(await other.claimDrive(DANA, "key-1")).toBe(true);
  });

  it("stays a slow live driver's past the stale age: no other window takes it over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const directory = await storage();
      let late = 0;
      const clock = (): number => Date.now() + late;
      const driver = new KeptReviews(directory, NODE_FILES, clock);
      const other = new KeptReviews(directory, NODE_FILES, clock);
      expect(await driver.claimDrive(DANA, "key-1")).toBe(true);
      late += DRIVE_STALE_MS + 1_000;
      vi.advanceTimersByTime(DRIVE_STALE_MS + 1_000);
      await pause(50);
      expect(await other.drivenElsewhere(DANA, "key-1")).toBe(true);
      expect(await other.claimDrive(DANA, "key-1")).toBe(false);
      await driver.releaseDrive(DANA, "key-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays a live driver's while it renews it past the stale age: no window reads it empty", async () => {
    const directory = await storage();
    let late = 0;
    const clock = (): number => Date.now() + late;
    const { promise: torn, resolve: tear } = Promise.withResolvers<void>();
    const { promise: mended, resolve: mend } = Promise.withResolvers<void>();
    // A write in place is truncated, then held there until the test lets it finish.
    const driver = new KeptReviews(
      directory,
      {
        ...NODE_FILES,
        writeFile: async (path, text) => {
          if (!path.endsWith(".tmp")) {
            await NODE_FILES.writeFile(path, "");
            tear();
            await mended;
          }
          await NODE_FILES.writeFile(path, text);
        },
      },
      clock,
    );
    const other = new KeptReviews(directory, NODE_FILES, clock);
    expect(await driver.claimDrive(DANA, "key-1")).toBe(true);
    late += DRIVE_STALE_MS + 1_000;
    const renewing = driver.renewDrive(DANA, "key-1");
    await Promise.race([torn, renewing]);
    expect(await other.drivenElsewhere(DANA, "key-1")).toBe(true);
    expect(await other.claimDrive(DANA, "key-1")).toBe(false);
    mend();
    expect(await renewing).toBe(true);
    await driver.releaseDrive(DANA, "key-1");
  });

  it("tells a window that lost it that it drives it no more, and that window leaves it be", async () => {
    const directory = await storage();
    let late = 0;
    const clock = (): number => Date.now() + late;
    const stalled = new KeptReviews(directory, NODE_FILES, clock);
    const next = new KeptReviews(directory, NODE_FILES, clock);
    expect(await stalled.claimDrive(DANA, "key-1")).toBe(true);
    late += DRIVE_STALE_MS + 1_000;
    expect(await next.claimDrive(DANA, "key-1")).toBe(true);
    expect(await stalled.renewDrive(DANA, "key-1")).toBe(false);
    await stalled.releaseDrive(DANA, "key-1");
    expect(await stalled.drivenElsewhere(DANA, "key-1")).toBe(true);
    expect(await next.renewDrive(DANA, "key-1")).toBe(true);
    await next.releaseDrive(DANA, "key-1");
  });

  it("is taken over from a window that closed while driving it", async () => {
    const directory = await storage();
    let now = Date.now();
    const closed = new KeptReviews(directory, NODE_FILES, () => now);
    const next = new KeptReviews(directory, NODE_FILES, () => now);
    expect(await closed.claimDrive(DANA, "key-1")).toBe(true);
    now += DRIVE_STALE_MS + 1_000;
    expect(await next.drivenElsewhere(DANA, "key-1")).toBe(false);
    expect(await next.claimDrive(DANA, "key-1")).toBe(true);
  });
});
