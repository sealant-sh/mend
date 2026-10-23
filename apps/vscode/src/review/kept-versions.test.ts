import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startSend } from "./delivery.js";
import type { ReviewPlace } from "./kept-reviews.js";
import { addPending, type SessionReview } from "./pending.js";
import { instructionOf, keptIn, pending, sentReview, storage } from "./test-fixtures.js";

const DANA: ReviewPlace = { url: "http://mend", viewer: "dana", sessionId: "s1" };

/** Her review's file for `s1`, as every window of this VS Code finds it. */
const fileIn = async (directory: string): Promise<string> => {
  const folder = join(directory, encodeURIComponent("http://mend dana"));
  await mkdir(folder, { recursive: true });
  return join(folder, "s1.json");
};

const addOne = (review: SessionReview): SessionReview =>
  addPending(review, pending({ id: "new", body: "kept?" }));

const stored = async (file: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("the kept file is not an object");
  return Object.fromEntries(Object.entries(value));
};

/** Her next review, of the comment `new`. */
const sendNew = (review: SessionReview): SessionReview => {
  const next = startSend(review, {
    key: "key-2",
    slice: { id: "slice-1", baseId: "cp1", headId: "cp2", diffDigest: "d" },
    instruction: instructionOf("the next review"),
    paste: { kind: "all" },
    pending: ["new"],
    open: [],
    now: "2026-10-19T12:00:00.000Z",
  });
  if (next === null) throw new Error("the review did not start");
  return next;
};

describe("the kept review, across versions of the extension", () => {
  it("is left as it was when a newer version wrote it: this window refuses to change it", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    const newer = JSON.stringify({
      format: 2,
      rev: 7,
      review: { pending: [pending({ id: "hers" })], sends: [], document: null },
    });
    await writeFile(file, newer);
    const kept = keptIn(directory);
    expect((await kept.read(DANA)).review.pending.map(({ id }) => id)).toEqual(["hers"]);
    await expect(kept.update(DANA, addOne)).rejects.toThrow(/newer version/);
    expect(await readFile(file, "utf8")).toBe(newer);
  });

  it("keeps every entry this version cannot read, as it was, when it writes the file", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    const [record] = sentReview().sends;
    const laterPhase = { ...record, key: "key-2", phase: { kind: "needs-edit", why: "later" } };
    const laterOrigin = { ...pending({ id: "later" }), origin: { kind: "suggested", by: "Mend" } };
    await writeFile(
      file,
      JSON.stringify({
        rev: 3,
        review: {
          pending: [pending({ id: "hers" }), laterOrigin],
          sends: [record, laterPhase],
          document: null,
          later: { kept: true },
        },
      }),
    );
    const kept = keptIn(directory);
    const read = await kept.read(DANA);
    expect(read.review.pending.map(({ id }) => id)).toEqual(["hers"]);
    expect(read.review.sends.map(({ key }) => key)).toEqual(["key-1"]);
    await kept.update(DANA, addOne);
    const review = (await stored(file))["review"];
    expect(review).toMatchObject({ later: { kept: true } });
    expect(JSON.stringify(review)).toContain(JSON.stringify(laterOrigin));
    expect(JSON.stringify(review)).toContain(JSON.stringify(laterPhase));
    expect((await keptIn(directory).read(DANA)).review.pending.map(({ id }) => id)).toEqual([
      "hers",
      "new",
    ]);
  });

  it("does not read a send whose paste step it does not know as due, so it never pastes it again", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    const [record] = sentReview().sends;
    const later = {
      ...record,
      phase: { kind: "in-terminal", agent: "claude", processId: "p-1", paste: { kind: "queued" } },
    };
    await writeFile(file, JSON.stringify({ rev: 3, review: { pending: [], sends: [later] } }));
    const kept = keptIn(directory);
    expect((await kept.read(DANA)).review.sends).toEqual([]);
    await kept.update(DANA, addOne);
    expect(JSON.stringify((await stored(file))["review"])).toContain(JSON.stringify(later));
  });

  it("writes back every entry it cannot read where it was, among the ones it reads", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    const [older] = sentReview("key-1").sends;
    const [newer] = sentReview("key-2").sends;
    const unread = { ...older, notices: [{ kind: "later", at: "2026-10-19T11:00:00.000Z" }] };
    const laterOrigin = { ...pending({ id: "later" }), origin: { kind: "suggested" } };
    await writeFile(
      file,
      JSON.stringify({
        format: 1,
        rev: 3,
        review: { pending: [laterOrigin, pending({ id: "hers" })], sends: [unread, newer] },
      }),
    );
    await keptIn(directory).update(DANA, addOne);
    const review = (await stored(file))["review"];
    const ids = (field: string, key: string): ReadonlyArray<unknown> => {
      const entries: unknown = Reflect.get(Object(review), field);
      return Array.isArray(entries) ? entries.map((entry) => Reflect.get(Object(entry), key)) : [];
    };
    expect(ids("sends", "key")).toEqual(["key-1", "key-2"]);
    expect(ids("pending", "id")).toEqual(["later", "hers", "new"]);
  });

  it("sends no review while it holds a send it cannot read: what that send pasted is not known here", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    const [pasted] = sentReview("key-1").sends;
    const unread = { ...pasted, notices: [{ kind: "later", at: "2026-10-19T11:00:00.000Z" }] };
    await writeFile(
      file,
      JSON.stringify({ format: 1, rev: 3, review: { pending: [], sends: [unread] } }),
    );
    const kept = keptIn(directory);
    await kept.update(DANA, addOne);
    await expect(kept.update(DANA, sendNew)).rejects.toThrow(/newer version/);
    expect((await kept.read(DANA)).review.pending.map(({ id }) => id)).toEqual(["new"]);
  });

  it("is never written over when its bytes do not read as JSON", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    await writeFile(file, '{"rev":3,"review":{"pending":[');
    const kept = keptIn(directory);
    await expect(kept.update(DANA, addOne)).rejects.toThrow(/not JSON/);
    expect(await readFile(file, "utf8")).toBe('{"rev":3,"review":{"pending":[');
  });

  it("reads a file an earlier build wrote with no format, and writes it with this format", async () => {
    const directory = await storage();
    const file = await fileIn(directory);
    await writeFile(
      file,
      JSON.stringify({ rev: 2, review: { pending: [pending({ id: "hers" })], sends: [] } }),
    );
    const kept = keptIn(directory);
    await kept.update(DANA, addOne);
    expect(await stored(file)).toMatchObject({ format: 1 });
    expect((await kept.read(DANA)).review.pending.map(({ id }) => id)).toEqual(["hers", "new"]);
  });
});
