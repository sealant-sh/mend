import { describe, expect, it } from "vitest";

import { isViewed, markViewed, parseViewedMarks } from "./viewed-files.ts";

describe("files marked viewed", () => {
  it("holds a mark only for the version of the file that was marked", () => {
    const marks = markViewed({}, "src/retry.ts", "v1", true);
    expect(isViewed(marks, "src/retry.ts", "v1")).toBe(true);
    // The agent changed the file after the mark: it reads unviewed until marked again.
    expect(isViewed(marks, "src/retry.ts", "v2")).toBe(false);
    expect(isViewed(marks, "src/charge.ts", "v1")).toBe(false);
  });

  it("moves a mark to the version marked again, and drops it when unticked", () => {
    const first = markViewed({}, "a.ts", "v1", true);
    const again = markViewed(first, "a.ts", "v2", true);
    expect(again).toEqual({ "a.ts": "v2" });
    expect(markViewed(again, "a.ts", "v2", false)).toEqual({});
  });

  it("leaves the other files' marks as they were", () => {
    const marks = markViewed({ "a.ts": "v1", "b.ts": "v3" }, "a.ts", "v1", false);
    expect(marks).toEqual({ "b.ts": "v3" });
  });

  it("reads back only path-to-fingerprint pairs", () => {
    expect(parseViewedMarks({ "a.ts": "v1", "b.ts": 3 })).toEqual({ "a.ts": "v1" });
    expect(parseViewedMarks(["a.ts"])).toEqual({});
    expect(parseViewedMarks(null)).toEqual({});
  });
});
