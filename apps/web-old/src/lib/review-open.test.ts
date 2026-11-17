// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { reviewDraftKey, writeDraft } from "./drafts.ts";
import {
  opensCurrentChange,
  renewReviewOpenKey,
  renewReviewOpenKeyFrom,
  reviewOpenKey,
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
