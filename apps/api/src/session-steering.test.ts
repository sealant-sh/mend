import { describe, expect, it } from "vitest";

import { canSteerSession } from "./session-steering.ts";

describe("canSteerSession", () => {
  it("allows the owner and refuses anyone else", () => {
    expect(canSteerSession({ ownerUserId: "alice", callerUserId: "alice" })).toBe(true);
    expect(canSteerSession({ ownerUserId: "alice", callerUserId: "bob" })).toBe(false);
  });

  it("refuses everyone for a session with no owner, the first account included", () => {
    expect(canSteerSession({ ownerUserId: null, callerUserId: "alice" })).toBe(false);
  });
});
