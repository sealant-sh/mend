import { describe, expect, it } from "vitest";

import { reviewTargetFile, type ReviewCommentTarget } from "./review-target.ts";

const fileLevel = (oldPath: string | null, newPath: string | null): ReviewCommentTarget => ({
  oldPath,
  newPath,
  side: null,
  startLine: null,
  endLine: null,
  hunkContextHash: null,
});

describe("the file a review comment is filed under", () => {
  it("is the new path for a line on the new side, and the old path for one on the old side", () => {
    const renamed = { oldPath: "src/old.ts", newPath: "src/new.ts", hunkContextHash: "h" };
    expect(reviewTargetFile({ ...renamed, side: "new", startLine: 3, endLine: 3 })).toBe(
      "src/new.ts",
    );
    expect(reviewTargetFile({ ...renamed, side: "old", startLine: 3, endLine: 3 })).toBe(
      "src/old.ts",
    );
  });

  it("is the new path of a file comment, or the old path of a deleted file", () => {
    expect(reviewTargetFile(fileLevel("src/old.ts", "src/new.ts"))).toBe("src/new.ts");
    expect(reviewTargetFile(fileLevel("README", null))).toBe("README");
  });

  it("is none for a comment on the change as a whole", () => {
    expect(reviewTargetFile(fileLevel(null, null))).toBeNull();
  });
});
