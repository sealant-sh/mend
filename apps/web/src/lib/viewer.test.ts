import { OrganizationId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { canRemove, runsAsLine, sessionActions } from "./viewer.ts";

const org = OrganizationId.make("org-1");
const alice = { userId: "alice", organizationId: org, role: "member" as const };
const bob = { userId: "bob", organizationId: org, role: "owner" as const };
const owned = { ownerUserId: "alice", sharedControlEnabledAt: null, origin: "mend" as const };
const shared = { ...owned, sharedControlEnabledAt: new Date() };
const fromSlack = { ...owned, origin: "slack" as const };

describe("session rows", () => {
  it("offer steering to the owner, or anyone while control is shared, and stop to owners", () => {
    expect(sessionActions(owned, alice)).toEqual({ own: true, steer: true, stop: true });
    expect(sessionActions(owned, bob)).toEqual({ own: false, steer: false, stop: true });
    expect(sessionActions(shared, { ...bob, userId: "carol", role: "member" })).toEqual({
      own: false,
      steer: true,
      stop: true,
    });
    expect(sessionActions(owned, null)).toEqual({ own: false, steer: false, stop: false });
  });

  it("say whose credentials a session runs on", () => {
    const names = new Map([["alice", "Alice"]]);
    expect(runsAsLine(owned, "alice", names)).toBeNull();
    expect(runsAsLine(shared, "alice", names)).toBe("shared control on");
    expect(runsAsLine(shared, "carol", names)).toBe("runs as Alice · shared control on");
    expect(runsAsLine({ ...owned, ownerUserId: "zed" }, "carol", names)).toBe(
      "runs as another account",
    );
    expect(runsAsLine({ ...owned, ownerUserId: null }, "carol", names)).toBe(
      "no owner · nobody steers it",
    );
  });

  it("say a session came from Slack, beside its owner", () => {
    const names = new Map([["alice", "Alice"]]);
    expect(runsAsLine(fromSlack, "alice", names)).toBe("from Slack");
    expect(runsAsLine(fromSlack, "carol", names)).toBe("runs as Alice · from Slack");
    expect(runsAsLine({ ...fromSlack, sharedControlEnabledAt: new Date() }, "carol", names)).toBe(
      "runs as Alice · from Slack · shared control on",
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
