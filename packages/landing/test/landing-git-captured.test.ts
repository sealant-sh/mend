import { Sha } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { landedRefOf, landingParent } from "../src/landing-git-captured.ts";

const AGENT = Sha.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const LANDED = Sha.make("dddddddddddddddddddddddddddddddddddddddd");

/** Which commit a capture-backed landing builds on (docs/adr/0007-landing.md, step 2). */
describe("landingParent", () => {
  it("is the agent's head before the change was ever landed", () => {
    expect(landingParent({ agentHead: AGENT, lastLanded: null, agentHeadInLanded: false })).toBe(
      AGENT,
    );
  });

  it("is the landed commit while the agent has not committed since, so the push fast-forwards", () => {
    expect(landingParent({ agentHead: AGENT, lastLanded: LANDED, agentHeadInLanded: true })).toBe(
      LANDED,
    );
  });

  it("is the agent's head once the agent committed past the landing, so its commits go as they are", () => {
    expect(landingParent({ agentHead: AGENT, lastLanded: LANDED, agentHeadInLanded: false })).toBe(
      AGENT,
    );
  });
});

describe("landedRefOf", () => {
  it("keeps the latest landing commit under Mend's own namespace, never the agent's branch", () => {
    expect(landedRefOf("wt-1")).toBe("refs/mend/landed/wt-1");
  });
});
