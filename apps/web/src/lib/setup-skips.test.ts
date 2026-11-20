import { describe, expect, it } from "vitest";

import { KEPT_ACCOUNTS, keptWith, parseSetupKept } from "./setup-skips.ts";

describe("what this browser keeps about setup", () => {
  it("reads anything it can't make sense of as nothing remembered", () => {
    const nothing = { skippedCommandLine: [], ended: [] };
    expect(parseSetupKept(null)).toEqual(nothing);
    expect(parseSetupKept("ended")).toEqual(nothing);
    expect(parseSetupKept({ ended: "u-1", skippedCommandLine: [1, "u-2"] })).toEqual({
      skippedCommandLine: ["u-2"],
      ended: [],
    });
  });

  it("adds an account once, newest last, and forgets the oldest past the limit", () => {
    let kept = parseSetupKept(null);
    kept = keptWith(kept, "ended", "u-1");
    kept = keptWith(kept, "ended", "u-1");
    expect(kept.ended).toEqual(["u-1"]);
    for (let index = 2; index <= KEPT_ACCOUNTS + 1; index += 1)
      kept = keptWith(kept, "ended", `u-${index}`);
    expect(kept.ended).toHaveLength(KEPT_ACCOUNTS);
    expect(kept.ended).not.toContain("u-1");
    expect(kept.ended.at(-1)).toBe(`u-${KEPT_ACCOUNTS + 1}`);
    expect(kept.skippedCommandLine).toEqual([]);
  });
});
