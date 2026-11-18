import { describe, expect, it } from "vitest";

import { leavePlan, liveSessionsOf, refusedName } from "./organization-membership.ts";
import { refusedWith } from "./refusal-fixture.ts";

describe("where a refused organization name is shown", () => {
  it("beside the field, for a refusal about the name", () => {
    expect(refusedName(refusedWith("OrganizationNameTaken", "There's already one."))).toBe(true);
    expect(refusedName(refusedWith("OrganizationNameEmpty", "Give it a name."))).toBe(true);
  });

  it("in the dialog's alert, for any other refusal or a failure with no tag", () => {
    expect(refusedName(refusedWith("OrganizationRejected", "Ask the operator."))).toBe(false);
    expect(refusedName(new Error("Failed to fetch"))).toBe(false);
  });
});

describe("the sessions Mend stops when someone leaves", () => {
  it("counts only the person's own sessions that still run something", () => {
    const sessions = [
      { ownerUserId: "ada", status: "running" },
      { ownerUserId: "ada", status: "idle" },
      { ownerUserId: "ada", status: "completed" },
      { ownerUserId: "grace", status: "running" },
      { ownerUserId: null, status: "running" },
    ];
    expect(liveSessionsOf(sessions, "ada")).toBe(2);
  });
});

const owner = (userId: string, name: string) => ({ userId, name, role: "owner" as const });
const member = (userId: string, name: string) => ({ userId, name, role: "member" as const });

const base = {
  organization: "Northwind",
  viewerId: "ada",
  others: ["Acme Labs"],
  liveSessions: 2,
};

describe("what the Leave dialog says", () => {
  it("stops the only owner, who has to make someone else an owner first", () => {
    const plan = leavePlan({ ...base, roster: [owner("ada", "Ada"), member("grace", "Grace")] });
    expect(plan).toEqual({ kind: "only-owner" });
  });

  it("names the owner who stays when an owner leaves", () => {
    const plan = leavePlan({ ...base, roster: [owner("ada", "Ada"), owner("mae", "Mae Jemison")] });
    expect(plan.kind === "leave" && plan.losses).toContain(
      "Mae Jemison stays as Northwind's owner.",
    );
  });

  it("says nothing about owners when a member leaves, and counts their running sessions", () => {
    const plan = leavePlan({ ...base, roster: [owner("mae", "Mae"), member("ada", "Ada")] });
    expect(plan).toEqual({
      kind: "leave",
      losses: [
        "Your 2 running sessions in Northwind stop. Their work so far is kept.",
        "Your access keys for Northwind stop working.",
        "Projects only you can see stay in Northwind, and its owners can take them over.",
      ],
      destination: "You'll go to Acme Labs, your other organization.",
    });
  });

  it("offers Leave while the roster and the sessions are still unknown", () => {
    const plan = leavePlan({ ...base, roster: null, liveSessions: null, others: ["A", "B"] });
    expect(plan.kind).toBe("leave");
    expect(plan.kind === "leave" && plan.losses[0]).toBe(
      "Mend stops any session you have running in Northwind. Its work so far is kept.",
    );
    expect(plan.kind === "leave" && plan.destination).toBe(
      "You'll go to the organization you used before Northwind.",
    );
  });
});
