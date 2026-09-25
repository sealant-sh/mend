import { landedRefOf as storeLandedRefOf } from "@mend/store";
import { describe, expect, it } from "vitest";

import { landedRefOf } from "../src/landing-git-captured.ts";

/**
 * Which commit a capture-backed landing builds on is the store's `planLanding`, tested with real
 * repositories in @mend/store (a fresh runner cache restored from the derived pack and the landed
 * ref, after the agent committed). What this adapter adds is where the landed head is kept.
 */
describe("landedRefOf", () => {
  it("keeps the latest landed head under Mend's own namespace, never the agent's branch", () => {
    expect(landedRefOf("wt-1")).toBe("refs/mend/landed/wt-1");
    expect(landedRefOf).toBe(storeLandedRefOf);
  });
});
