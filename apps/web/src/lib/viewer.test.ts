import { OrganizationId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { canRemove, ownerLine, sessionActions } from "./viewer.ts";

const org = OrganizationId.make("org-1");
const alice = { userId: "alice", organizationId: org, role: "member" as const };
const bob = { userId: "bob", organizationId: org, role: "owner" as const };
const owned = { ownerUserId: "alice", sharedControlEnabledAt: null, origin: "mend" as const };
const shared = { ...owned, sharedControlEnabledAt: new Date() };
const fromSlack = { ...owned, origin: "slack" as const };

describe("session rows", () => {
  it("offer steering to the owner, or anyone while control is shared, and stop to owners", () => {
    expect(sessionActions(owned, alice)).toEqual({
      own: true,
      steer: true,
      stop: true,
      terminalInput: true,
    });
    expect(sessionActions(owned, bob)).toEqual({
      own: false,
      steer: false,
      stop: true,
      terminalInput: false,
    });
    expect(sessionActions(shared, { ...bob, userId: "carol", role: "member" })).toEqual({
      own: false,
      steer: true,
      stop: true,
      terminalInput: false,
    });
    expect(sessionActions(shared, alice).terminalInput).toBe(true);
    expect(sessionActions(owned, null)).toEqual({
      own: false,
      steer: false,
      stop: false,
      terminalInput: false,
    });
  });

  it("say whose session it is without claiming runtime credentials", () => {
    const names = new Map([["alice", "Alice"]]);
    expect(ownerLine(owned, true, names)).toBeNull();
    expect(ownerLine(shared, true, names)).toBe("shared control on");
    expect(ownerLine(shared, false, names)).toBe("owned by Alice · shared control on");
    expect(ownerLine({ ...owned, ownerUserId: "zed" }, false, names)).toBe(
      "owned by another account",
    );
    expect(ownerLine({ ...owned, ownerUserId: null }, false, names)).toBe(
      "no owner · nobody steers it",
    );
  });

  it("say nothing about another account while the roster is read", () => {
    expect(ownerLine(shared, false, undefined)).toBeNull();
    expect(ownerLine(fromSlack, false, undefined)).toBeNull();
    // The owner's own line needs no names.
    expect(ownerLine(shared, true, undefined)).toBe("shared control on");
    expect(ownerLine({ ...owned, ownerUserId: null }, false, undefined)).toBe(
      "no owner · nobody steers it",
    );
  });

  it("say a session came from Slack, beside its owner", () => {
    const names = new Map([["alice", "Alice"]]);
    expect(ownerLine(fromSlack, true, names)).toBe("from Slack");
    expect(ownerLine(fromSlack, false, names)).toBe("owned by Alice · from Slack");
    expect(ownerLine({ ...fromSlack, sharedControlEnabledAt: new Date() }, false, names)).toBe(
      "owned by Alice · from Slack · shared control on",
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
