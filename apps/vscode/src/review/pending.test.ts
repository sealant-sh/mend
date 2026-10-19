import { describe, expect, it } from "vitest";

import {
  addPending,
  editPending,
  EMPTY_REVIEW,
  parseSessionReview,
  removePending,
} from "./pending.js";
import { ReviewMemory, sessionKey, type ReviewMemento } from "./review-memory.js";
import { pending } from "./test-fixtures.js";

/** `globalState` as one VS Code keeps it across a window reload: stored as JSON, read anew. */
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

describe("her pending comments (story d, step 4)", () => {
  it("survive a window reload: written by one window, read back by the next", async () => {
    const kept = memento();
    const own = pending({});
    const accepted = pending({
      id: "a1",
      line: 13,
      endLine: 13,
      origin: {
        kind: "accepted",
        draftId: "d1",
        evidence: [{ sequence: "214", excerpt: "pnpm test auth · never ran" }],
      },
    });
    await new ReviewMemory(kept).updateSession("http://mend", "s1", (stored) =>
      addPending(addPending(stored, own), accepted),
    );
    const afterReload = new ReviewMemory(kept).readSession("http://mend", "s1");
    expect(afterReload.pending).toEqual([own, accepted]);
    expect(kept.saved.has(sessionKey("http://mend", "s1"))).toBe(true);
  });

  it("are kept per server and session", async () => {
    const kept = memento();
    const memory = new ReviewMemory(kept);
    await memory.updateSession("http://mend", "s1", (stored) => addPending(stored, pending({})));
    expect(memory.readSession("http://mend", "s2")).toEqual(EMPTY_REVIEW);
    expect(memory.readSession("http://other", "s1")).toEqual(EMPTY_REVIEW);
  });

  it("are edited and removed until sent (G1)", () => {
    const review = addPending(EMPTY_REVIEW, pending({}));
    expect(editPending(review, "p1", "Use guard.ts").pending[0]?.body).toBe("Use guard.ts");
    expect(removePending(review, "p1").pending).toEqual([]);
  });

  it("drop only a comment that does not read back", () => {
    expect(parseSessionReview({ pending: [pending({}), { id: "broken" }] }).pending).toEqual([
      pending({}),
    ]);
    expect(parseSessionReview("garbage")).toEqual(EMPTY_REVIEW);
  });
});
