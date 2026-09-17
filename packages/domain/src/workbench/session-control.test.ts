import { describe, expect, it } from "vitest";

import { canSteerSession, canToggleSharedControl } from "./session-control.ts";

const owned = { ownerUserId: "alice", sharedControlEnabledAt: null };
const shared = { ownerUserId: "alice", sharedControlEnabledAt: new Date() };
const ownerless = { ownerUserId: null, sharedControlEnabledAt: new Date() };

describe("steering a visible session (docs/adr/0003)", () => {
  it("the owner always, others only while control is shared, nobody without an owner", () => {
    expect(canSteerSession(owned, "alice")).toBe(true);
    expect(canSteerSession(owned, "carol")).toBe(false);
    expect(canSteerSession(shared, "carol")).toBe(true);
    expect(canSteerSession(ownerless, "alice")).toBe(false);
  });

  it("only the owner shares control; an organization owner may also take it back", () => {
    const carol = { userId: "carol", role: "member" as const };
    const bob = { userId: "bob", role: "owner" as const };
    const alice = { userId: "alice", role: "member" as const };
    expect(canToggleSharedControl(owned, alice, true)).toBe(true);
    expect(canToggleSharedControl(shared, alice, false)).toBe(true);
    expect(canToggleSharedControl(owned, carol, true)).toBe(false);
    expect(canToggleSharedControl(shared, carol, false)).toBe(false);
    expect(canToggleSharedControl(owned, bob, true)).toBe(false);
    expect(canToggleSharedControl(shared, bob, false)).toBe(true);
    expect(canToggleSharedControl(ownerless, bob, false)).toBe(false);
  });
});
