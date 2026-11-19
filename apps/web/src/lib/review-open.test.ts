// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { reviewDraftKey, writeDraft } from "./drafts.ts";
import {
  opensCurrentChange,
  parseRange,
  renewReviewOpenKey,
  renewReviewOpenKeyFrom,
  reviewOpenKey,
  setReviewRange,
} from "./review-open.ts";

const scope = { userId: "alice", changeId: "change-1", sliceId: "slice-old" };
const moved = { worktreeChangedSinceSnapshot: true };
const comment = (sliceId: string, state = "open", sentToSessionId: string | null = null) => ({
  anchor: { reviewSliceId: sliceId },
  state,
  sentToSessionId,
});

beforeEach(() => sessionStorage.clear());

describe("which slice the Change tab opens", () => {
  it("opens the change as it is now when the worktree moved past the pinned slice", () => {
    expect(opensCurrentChange(moved, "change-1", "slice-old", [])).toBe(true);
  });

  it("keeps a pinned slice that still matches the worktree", () => {
    expect(
      opensCurrentChange({ worktreeChangedSinceSnapshot: false }, "change-1", "slice-old", []),
    ).toBe(false);
  });

  it("keeps a moved-past slice that holds unsent words, so they are not left behind", () => {
    writeDraft(reviewDraftKey(scope, "src/a.ts:12"), "rename this");
    expect(opensCurrentChange(moved, "change-1", "slice-old", [])).toBe(false);
    expect(opensCurrentChange(moved, "change-1", "slice-new", [])).toBe(true);
  });

  it("keeps a moved-past slice with comments saved there and not yet sent", () => {
    expect(opensCurrentChange(moved, "change-1", "slice-old", [comment("slice-old")])).toBe(false);
  });

  it("moves on from comments already sent, or saved on another slice", () => {
    expect(
      opensCurrentChange(moved, "change-1", "slice-old", [
        comment("slice-old", "open", "session-1"),
        comment("slice-old", "addressed"),
        comment("slice-other"),
      ]),
    ).toBe(true);
  });

  it("keeps the pinned slice when its comments could not be read", () => {
    expect(opensCurrentChange(moved, "change-1", "slice-old", null)).toBe(false);
  });
});

describe("renewing the tab's review key after a read", () => {
  it("renews only while the key that opened the read is still the tab's", () => {
    const opened = reviewOpenKey("change-1");
    // The person opened the change as it is now meanwhile: a newer review, a newer key.
    renewReviewOpenKey("change-1");
    const newer = reviewOpenKey("change-1");
    renewReviewOpenKeyFrom("change-1", opened);
    expect(reviewOpenKey("change-1")).toBe(newer);
    renewReviewOpenKeyFrom("change-1", newer);
    expect(reviewOpenKey("change-1")).not.toBe(newer);
  });
});

describe("the range a tab reviews over", () => {
  it("reads back what was stored, and anything else as the whole change", () => {
    expect(parseRange(JSON.stringify({ from: "last-review" }))).toEqual({ from: "last-review" });
    expect(parseRange(JSON.stringify({ from: "base", to: "cp-5" }))).toEqual({
      from: "base",
      to: "cp-5",
    });
    expect(parseRange(JSON.stringify({ from: "last-review", to: "cp-5" }))).toEqual({
      from: "last-review",
    });
    expect(parseRange("not json")).toBeNull();
    expect(parseRange(null)).toBeNull();
  });

  it("opens a new review when the range changes, and forgets a whole-change range", () => {
    const key = reviewOpenKey("change-1");
    setReviewRange("change-1", { from: "last-review" });
    expect(reviewOpenKey("change-1")).not.toBe(key);
    expect(parseRange(sessionStorage.getItem("mend.review.change-1.range"))).toEqual({
      from: "last-review",
    });
    setReviewRange("change-1", null);
    expect(sessionStorage.getItem("mend.review.change-1.range")).toBeNull();
  });
});
