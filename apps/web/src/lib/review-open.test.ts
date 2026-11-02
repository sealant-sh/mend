// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { reviewDraftKey, writeDraft } from "./drafts.ts";
import { opensCurrentChange } from "./review-open.ts";

const scope = { userId: "alice", changeId: "change-1", sliceId: "slice-old" };

beforeEach(() => sessionStorage.clear());

describe("which slice the Change tab opens", () => {
  it("opens the change as it is now when the worktree moved past the pinned slice", () => {
    expect(
      opensCurrentChange({ worktreeChangedSinceSnapshot: true }, "change-1", "slice-old"),
    ).toBe(true);
  });

  it("keeps a pinned slice that still matches the worktree", () => {
    expect(
      opensCurrentChange({ worktreeChangedSinceSnapshot: false }, "change-1", "slice-old"),
    ).toBe(false);
  });

  it("keeps a moved-past slice that holds unsent comments, so they are not left behind", () => {
    writeDraft(reviewDraftKey(scope, "src/a.ts:12"), "rename this");
    expect(
      opensCurrentChange({ worktreeChangedSinceSnapshot: true }, "change-1", "slice-old"),
    ).toBe(false);
    expect(
      opensCurrentChange({ worktreeChangedSinceSnapshot: true }, "change-1", "slice-new"),
    ).toBe(true);
  });
});
