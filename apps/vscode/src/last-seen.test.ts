import { describe, expect, it } from "vitest";

import { LastSeenFile } from "./last-seen.js";
import { keptIn, memoryFiles } from "./review/test-fixtures.js";

const FILE = "/global-storage/reviews/last-seen/http%3A%2F%2Fmend.json";

describe("what this VS Code last looked at, as a file every window shares", () => {
  it("is kept again over a file a crash left empty", async () => {
    const files = memoryFiles();
    await files.writeFile(FILE, "");
    const seen = new LastSeenFile(keptIn("/global-storage/reviews", files));
    const mine = {
      baseline: "2026-10-19T09:00:00.000Z",
      sessions: { s1: "2026-10-19T10:00:00.000Z" },
    };
    expect(await seen.merge("http://mend", mine, [])).toEqual(mine);
    expect(await seen.read("http://mend")).toEqual(mine);
  });

  it("keeps another window's looks, the earlier baseline, and forgets what it is told to", async () => {
    const files = memoryFiles();
    const seen = new LastSeenFile(keptIn("/global-storage/reviews", files));
    await seen.merge(
      "http://mend",
      { baseline: "2026-10-19T08:00:00.000Z", sessions: { s1: "a" } },
      [],
    );
    const kept = await seen.merge(
      "http://mend",
      { baseline: "2026-10-19T09:00:00.000Z", sessions: { s2: "2026-10-19T10:00:00.000Z" } },
      ["s1"],
    );
    expect(kept).toEqual({
      baseline: "2026-10-19T08:00:00.000Z",
      sessions: { s2: "2026-10-19T10:00:00.000Z" },
    });
  });
});
