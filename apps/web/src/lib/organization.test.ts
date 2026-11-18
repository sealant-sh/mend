import { describe, expect, it } from "vitest";

import { dayOf, initialsOf, joinState, spentReason } from "./organization.ts";

const membership = (id: string, active: boolean) => ({ organization: { id }, active });

describe("joinState", () => {
  const open = { state: "open" as const, organizationId: "org-acme" };

  it("tells a spent link apart by what spent it", () => {
    expect(joinState({ ...open, state: "revoked" }, null)).toEqual({
      kind: "spent",
      state: "revoked",
    });
  });

  it("asks a visitor who isn't signed in to create an account or sign in", () => {
    expect(joinState(open, null)).toEqual({ kind: "register" });
  });

  it("joins a signed-in account of another organization as one more", () => {
    expect(joinState(open, [membership("org-acme-2", true)])).toEqual({ kind: "join" });
  });

  it("knows an account that is already in the organization, and whether it acts there", () => {
    expect(joinState(open, [membership("org-acme", false)])).toEqual({
      kind: "member",
      active: false,
    });
  });

  it("lets a member reopen the spent link they joined with", () => {
    expect(joinState({ ...open, state: "accepted" }, [membership("org-acme", true)])).toEqual({
      kind: "member",
      active: true,
    });
  });

  it("refuses a spent link to a signed-in account that isn't a member", () => {
    expect(joinState({ ...open, state: "expired" }, [membership("org-beta", true)])).toEqual({
      kind: "spent",
      state: "expired",
    });
  });
});

describe("dayOf", () => {
  const now = new Date(2026, 10, 18, 9, 0);

  it("leaves the year out within this year", () => {
    expect(dayOf(new Date(2026, 10, 20, 10, 42), now)).toBe("20 November");
  });

  it("names the year when it isn't this one", () => {
    expect(dayOf(new Date(2027, 0, 3, 10, 42), now)).toBe("3 January 2027");
  });
});

describe("spentReason", () => {
  it("names the day and time an expired link stopped working", () => {
    const now = new Date(2026, 10, 21, 9, 0);
    expect(spentReason("expired", new Date(2026, 10, 20, 10, 42), now)).toBe(
      "It expired on 20 November at 10:42.",
    );
  });
});

describe("initialsOf", () => {
  it("takes the first and last name's first letters", () => {
    expect(initialsOf("Linus Carl Pauling", "linus@example.com")).toBe("LP");
  });

  it("falls back to the email when the account has no name of its own", () => {
    // An account created without a name is named by its email.
    expect(initialsOf("linus@example.com", "linus@example.com")).toBe("L");
  });
});
