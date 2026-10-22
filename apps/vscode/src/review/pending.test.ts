import { describe, expect, it } from "vitest";

import {
  addPending,
  editPending,
  EMPTY_REVIEW,
  NOTHING_UNREAD,
  parseSessionReview,
  removePending,
} from "./pending.js";
import { pending } from "./test-fixtures.js";

describe("her pending comments (story d, step 4)", () => {
  it("read back as they were written, an accepted draft with its evidence and run", () => {
    const own = pending({});
    const accepted = pending({
      id: "a1",
      line: 13,
      endLine: 13,
      origin: {
        kind: "accepted",
        draftId: "d1",
        evidence: [{ runId: "run-1", sequence: "214", excerpt: "pnpm test auth · never ran" }],
        draftBody: "Use the shared limiter from guard.ts",
      },
    });
    const whole = pending({ id: "w1", path: null, line: 1, endLine: 1 });
    const review = addPending(addPending(addPending(EMPTY_REVIEW, own), accepted), whole);
    expect(parseSessionReview(JSON.parse(JSON.stringify(review)))).toEqual({
      review,
      unread: NOTHING_UNREAD,
    });
  });

  it("are edited and removed until sent (G1)", () => {
    const review = addPending(EMPTY_REVIEW, pending({}));
    expect(editPending(review, "p1", "Use guard.ts").pending[0]?.body).toBe("Use guard.ts");
    expect(removePending(review, "p1").pending).toEqual([]);
  });

  it("read only a comment that reads back, and keep any other as it was", () => {
    expect(parseSessionReview({ pending: [pending({}), { id: "broken" }] })).toEqual({
      review: { ...EMPTY_REVIEW, pending: [pending({})] },
      unread: { ...NOTHING_UNREAD, pending: [{ id: "broken" }] },
    });
    const pathless = { ...pending({}), path: 3 };
    expect(parseSessionReview({ pending: [pathless] }).unread.pending).toEqual([pathless]);
    expect(parseSessionReview("garbage").review).toEqual(EMPTY_REVIEW);
  });
});
