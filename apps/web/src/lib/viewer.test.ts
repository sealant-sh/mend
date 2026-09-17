import { OrganizationId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { canRemove, runsAsLine, sessionActions } from "./viewer.ts";

const org = OrganizationId.make("org-1");
const alice = { userId: "alice", organizationId: org, role: "member" as const };
const bob = { userId: "bob", organizationId: org, role: "owner" as const };
const owned = { ownerUserId: "alice", sharedControlEnabledAt: null };
const shared = { ownerUserId: "alice", sharedControlEnabledAt: new Date() };

describe("session rows", () => {
  it("offer steering to the owner, or anyone while control is shared, and stop to owners", () => {
    expect(sessionActions(owned, alice)).toEqual({ steer: true, stop: true });
    expect(sessionActions(owned, bob)).toEqual({ steer: false, stop: true });
    expect(sessionActions(shared, { ...bob, userId: "carol", role: "member" })).toEqual({
      steer: true,
      stop: true,
    });
    expect(sessionActions(owned, null)).toEqual({ steer: false, stop: false });
  });

  it("say whose credentials a session runs on", () => {
    const names = new Map([["alice", "Alice"]]);
    expect(runsAsLine(owned, "alice", names)).toBeNull();
    expect(runsAsLine(shared, "alice", names)).toBe("shared control on");
    expect(runsAsLine(shared, "carol", names)).toBe("runs as Alice · shared control on");
    expect(runsAsLine({ ...owned, ownerUserId: "zed" }, "carol", names)).toBe(
      "runs as another account",
    );
  });
});

describe("project removal", () => {
  it("is for owners, or the creator of a private project", () => {
    const privateToAlice = {
      organizationId: org,
      visibility: "private" as const,
      createdByUserId: "alice",
    };
    expect(canRemove(privateToAlice, alice)).toBe(true);
    expect(canRemove({ ...privateToAlice, visibility: "shared" }, alice)).toBe(false);
    expect(canRemove({ ...privateToAlice, visibility: "shared" }, bob)).toBe(true);
    expect(canRemove(privateToAlice, null)).toBe(false);
  });
});
