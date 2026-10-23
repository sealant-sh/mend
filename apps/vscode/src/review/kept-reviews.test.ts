import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { startSend, stepReview, type SendEvent, type SendPhase } from "./delivery.js";
import {
  DRIVE_STALE_MS,
  KEPT_REVIEW_TTL_MS,
  KeptReviews,
  NODE_FILES,
  type ReviewPlace,
} from "./kept-reviews.js";
import {
  acceptedDrafts,
  addPending,
  EMPTY_REVIEW,
  keepComposed,
  saveDocument,
  type Composed,
  type SessionReview,
} from "./pending.js";
import {
  instructionOf,
  keptIn,
  pending,
  PINNED,
  sentReview,
  slowFiles,
  storage,
  SETTLE,
} from "./test-fixtures.js";

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

/**
 * Waits until the hold `name` in her folder reads renewed at `at` or later, by the test's clock: a
 * renewal the timers fired is written some time after.
 */
const renewedBy = async (directory: string, name: string, at: number): Promise<void> => {
  await vi.waitFor(async () => {
    const [folder] = await readdir(directory);
    if (folder === undefined) throw new Error("no folder was made for her reviews");
    const text = await NODE_FILES.readFile(join(directory, folder, name)).catch(() => "");
    expect(Number(text.split(" ")[0])).toBeGreaterThanOrEqual(at);
  }, SETTLE);
};

/** A lock's or a lease's renewal: `<name>.lock.<uuid>.tmp`, `<name>.<key>.drive.<uuid>.tmp`. */
const HOLD_RENEWAL =
  /\.(lock|drive)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** Storage in a folder whose name reads like a hold's: only a hold's own renewal is not held back. */
const heldStorage = async (): Promise<string> => join(await storage(), "reviews.lock.drive.d");

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
        if (path.endsWith(".tmp") && !HOLD_RENEWAL.test(path)) {
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
    expect(new Set(kept.map(({ rev }) => rev)).size).toBe(2);
    expect((await bodies(keptIn(directory))).toSorted()).toEqual(["first", "second"]);
  });

  it("stays a slow live window's past the stale age: the other window waits for its write", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const directory = await heldStorage();
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
      const renewing = clock();
      vi.advanceTimersByTime(20_000);
      await renewedBy(directory, "s1.json.lock", renewing);
      const waiting = other.update(DANA, (review) =>
        addPending(review, pending({ id: "b", body: "other" })),
      );
      await pause(50);
      slow.go();
      const kept = await Promise.all([held, waiting]);
      const [slowRev, otherRev] = kept.map(({ rev }) => rev);
      expect(otherRev).toBeGreaterThan(slowRev ?? Number.POSITIVE_INFINITY);
      expect((await bodies(keptIn(directory))).toSorted()).toEqual(["other", "slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not removed by a window that stalled holding it once another took it over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const directory = await heldStorage();
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
      const { rev } = await taken;
      expect((await keptIn(directory).read(DANA)).rev).toBe(rev);
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
});

const keptPastExpiry = async (
  review: SessionReview | string,
): Promise<{ readonly kept: boolean; readonly read: SessionReview }> => {
  const directory = await storage();
  let now = Date.now();
  const kept = new KeptReviews(directory, NODE_FILES, () => now);
  await kept.update({ ...DANA, sessionId: "s0" }, addOne);
  const [folder] = await readdir(directory);
  if (folder === undefined) throw new Error("no folder was made for her reviews");
  const file = join(directory, folder, "s1.json");
  if (typeof review === "string") await writeFile(file, review);
  else await kept.update(DANA, () => review);
  const old = new Date(Date.now() - KEPT_REVIEW_TTL_MS - 1_000);
  await utimes(file, old, old);
  now += 2 * 60 * 60 * 1000;
  await kept.update({ ...DANA, sessionId: "s2" }, addOne);
  return {
    kept: (await readdir(join(directory, folder))).includes("s1.json"),
    read: (await kept.read(DANA)).review,
  };
};

const withDocument = (review: SessionReview, text: string | null): SessionReview => {
  const composed: Composed = {
    documentId: "doc-1",
    sessionId: "s1",
    sessionName: "add-rate-limit",
    slice: { id: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, diffDigest: "d" },
    pending: [],
    open: [],
    digest: "digest",
    generation: "generation",
    base: null,
  };
  const written = keepComposed(review, composed, "The review, as composed.").review;
  if (text === null) return written;
  const saved = saveDocument(written, "doc-1", 1, text);
  if (saved.kind !== "saved") throw new Error("the review was not saved");
  return saved.review;
};

const withPhase = (phase: SendPhase): SessionReview => {
  const review = sentReview();
  return { ...review, sends: review.sends.map((record) => ({ ...record, phase })) };
};

const delivered = (): SessionReview =>
  withPhase({ kind: "delivered", at: "2026-10-19T11:00:00.000Z" });

describe("a review untouched past the expiry", () => {
  it("goes once it holds only reviews Mend took", async () => {
    expect((await keptPastExpiry(delivered())).kept).toBe(false);
  });

  it("stays while it holds a comment she has not sent", async () => {
    const { read } = await keptPastExpiry(addPending(delivered(), pending({ body: "unsent" })));
    expect(read.pending.map(({ body }) => body)).toEqual(["unsent"]);
  });

  it("stays while a send is unfinished: Mend has not answered, or it failed and waits for Retry", async () => {
    expect((await keptPastExpiry(sentReview())).read.sends).toHaveLength(1);
    const failed = withPhase({
      kind: "failed",
      words: "Mend did not answer.",
      at: "2026-10-19T11:00:00.000Z",
    });
    expect((await keptPastExpiry(failed)).read.sends).toHaveLength(1);
  });

  it("stays while it holds the words of a review she is writing", async () => {
    const review = withDocument(delivered(), "Her review, as she edited it.");
    expect((await keptPastExpiry(review)).read.document?.text).toBe(
      "Her review, as she edited it.",
    );
  });

  it("stays while it keeps a Mend draft her posted words replace from Accept", async () => {
    expect(
      (await keptPastExpiry({ ...delivered(), replacedDrafts: ["d1"] })).read.replacedDrafts,
    ).toEqual(["d1"]);
  });

  it("stays while a Mend draft her posted words replace is still a draft there", async () => {
    const rewrite = pending({
      id: "a1",
      body: "Run the burst test too.",
      origin: { kind: "accepted", draftId: "d1", evidence: [], draftBody: "Run the tests." },
    });
    const sent = startSend(
      { ...EMPTY_REVIEW, pending: [rewrite] },
      {
        key: "key-1",
        slice: { id: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, diffDigest: "d" },
        instruction: instructionOf("the review"),
        paste: { kind: "all" },
        pending: ["a1"],
        open: [],
        now: "2026-10-19T10:50:00.000Z",
      },
    );
    if (sent === null) throw new Error("the review did not start");
    const now = "2026-10-19T11:00:00.000Z";
    const left: ReadonlyArray<SendEvent> = [
      { kind: "posted", pendingId: "a1", commentId: "c9" },
      { kind: "draft-left", draftId: "d1", words: "Mend refused the dismissal." },
    ];
    const stepped = left.reduce((next, event) => stepReview(next, "key-1", event, now), sent);
    const done: SendPhase = { kind: "delivered", at: now };
    const review = {
      ...stepped,
      sends: stepped.sends.map((record) => ({ ...record, phase: done })),
    };
    expect(acceptedDrafts(review).has("d1")).toBe(true);
    const { read } = await keptPastExpiry(review);
    expect(acceptedDrafts(read).has("d1")).toBe(true);
  });

  it("goes when the review she is writing reads as Send review composed it", async () => {
    expect((await keptPastExpiry(withDocument(delivered(), null))).kept).toBe(false);
  });

  it("is not swept by the write that saves her words into it", async () => {
    const directory = await storage();
    let now = Date.now();
    const kept = new KeptReviews(directory, NODE_FILES, () => now);
    await kept.update(DANA, () => withDocument(delivered(), null));
    const [folder] = await readdir(directory);
    if (folder === undefined) throw new Error("no folder was made for her reviews");
    const old = new Date(Date.now() - KEPT_REVIEW_TTL_MS - 1_000);
    await utimes(join(directory, folder, "s1.json"), old, old);
    now += 2 * 60 * 60 * 1000;
    let saved: string | null = null;
    await kept.update(DANA, (review) => {
      const save = saveDocument(review, "doc-1", 1, "Her words, typed a month on.");
      saved = save.kind;
      return save.kind === "saved" ? save.review : review;
    });
    expect(saved).toBe("saved");
    expect((await kept.read(DANA)).review.document?.text).toBe("Her words, typed a month on.");
  });

  it("keeps her words when she saves the review another session's write swept", async () => {
    const directory = await storage();
    const hers = new KeptReviews(directory);
    await hers.update(DANA, () => withDocument(delivered(), null));
    const [folder] = await readdir(directory);
    if (folder === undefined) throw new Error("no folder was made for her reviews");
    const aMonthOn = Date.now() + KEPT_REVIEW_TTL_MS + 1_000;
    await new KeptReviews(directory, NODE_FILES, () => aMonthOn).update(
      { ...DANA, sessionId: "s2" },
      addOne,
    );
    expect(await readdir(join(directory, folder))).not.toContain("s1.json");
    let saved: string | null = null;
    await hers.update(DANA, (review) => {
      const save = saveDocument(review, "doc-1", 1, "Her words, typed before the sweep.");
      saved = save.kind;
      return save.kind === "saved" ? save.review : review;
    });
    expect(saved).toBe("saved");
    expect((await hers.read(DANA)).review.document?.text).toBe(
      "Her words, typed before the sweep.",
    );
  });

  it("stays when this window cannot read it", async () => {
    expect((await keptPastExpiry('{"rev":3,"review":{"pending":[')).kept).toBe(true);
    const newer = JSON.stringify({ format: 99, rev: 3, review: { pending: [], sends: [] } });
    expect((await keptPastExpiry(newer)).kept).toBe(true);
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
    expect(await other.drivenFor(DANA, "key-1")).not.toBeNull();
    expect(await driver.drivenFor(DANA, "key-1")).toBeNull();
    await driver.releaseDrive(DANA, "key-1");
    expect(await other.drivenFor(DANA, "key-1")).toBeNull();
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
      const renewing = clock();
      vi.advanceTimersByTime(DRIVE_STALE_MS + 1_000);
      await renewedBy(directory, "s1.json.key-1.drive", renewing);
      expect(await other.drivenFor(DANA, "key-1")).not.toBeNull();
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
    expect(await other.drivenFor(DANA, "key-1")).not.toBeNull();
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
    expect(await stalled.drivenFor(DANA, "key-1")).not.toBeNull();
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
    expect(await next.drivenFor(DANA, "key-1")).toBeNull();
    expect(await next.claimDrive(DANA, "key-1")).toBe(true);
  });
});
