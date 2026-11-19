import { describe, expect, it } from "vitest";

import {
  closedFold,
  closedState,
  createdLine,
  emailProblem,
  expiresLine,
  firstNameOf,
  invitationGroups,
  type InvitationRow,
  isNew,
  isOnlyOwner,
  joinedWithYours,
  linkOf,
  type Member,
  noOpenInvitations,
  refusalWords,
  removalLines,
  removedToast,
  resetOffer,
  roleChanged,
  rosterOrder,
  sentTo,
  shortDay,
  whoCanUse,
} from "./organization-members.ts";
import { refusedWith } from "./refusal-fixture.ts";

const NOW = new Date("2026-11-19T11:20:00");
const person = (userId: string, name: string, role: Member["role"], joinedAt: string): Member => ({
  userId,
  name,
  email: `${userId}@northwind.dev`,
  role,
  joinedAt: new Date(joinedAt),
});
const ada = person("ada", "Ada Lovelace", "owner", "2026-03-02T09:00:00");
const grace = person("grace", "Grace Hopper", "member", "2026-03-02T10:00:00");
const dorothy = person("dorothy", "Dorothy Vaughan", "member", "2026-04-14T09:00:00");
const linus = person("linus", "Linus Pauling", "member", "2026-11-19T11:20:00");
const roster = [linus, dorothy, grace, ada];

const invitation = (over: Partial<InvitationRow>): InvitationRow => ({
  id: "inv-1",
  role: "member",
  email: "linus@northwind.dev",
  createdByUserId: "ada",
  createdAt: new Date("2026-11-19T11:12:00"),
  expiresAt: new Date("2026-11-22T11:12:00"),
  acceptedByUserId: null,
  acceptedAt: null,
  revokedAt: null,
  ...over,
});

describe("the roster", () => {
  it("lists the person looking first, then by when each joined", () => {
    expect(rosterOrder(roster, "dorothy").map((member) => member.userId)).toEqual([
      "dorothy",
      "ada",
      "grace",
      "linus",
    ]);
  });

  it("says when each joined, with the time only for today, and marks the last day's as new", () => {
    expect(shortDay(ada.joinedAt, NOW)).toBe("2 Mar");
    expect(shortDay(linus.joinedAt, NOW)).toBe("Today, 11:20");
    expect(shortDay(new Date("2025-12-24T09:00:00"), NOW)).toBe("24 Dec 2025");
    expect([isNew(linus, NOW), isNew(dorothy, NOW)]).toEqual([true, false]);
  });

  it("locks the role of the organization's only owner", () => {
    expect(isOnlyOwner(roster, "ada")).toBe(true);
    expect(isOnlyOwner(roster, "grace")).toBe(false);
    expect(isOnlyOwner([...roster, { ...grace, role: "owner" }], "ada")).toBe(false);
  });
});

describe("owner actions", () => {
  it("offers a reset link only for someone else who is a member", () => {
    expect(resetOffer(grace, false)).toEqual({ offer: true });
    expect(resetOffer(ada, false)).toEqual({
      offer: false,
      why: "Owners reset their password through this server's operator.",
    });
    expect(resetOffer(ada, true)).toEqual({
      offer: false,
      why: "Change your own password in Profile.",
    });
  });

  it("says a role change in words", () => {
    expect(roleChanged({ name: "Mae Jemison" }, "owner", "Northwind")).toBe(
      "Mae Jemison is now an owner of Northwind.",
    );
    expect(roleChanged({ name: "Mae Jemison" }, "member", "Northwind")).toBe(
      "Mae Jemison is now a member of Northwind.",
    );
  });

  it("uses the server's own refusal, and explains a 404", () => {
    const lastOwner =
      "An organization needs an owner. Make someone else an owner before this one steps down.";
    expect(refusalWords(refusedWith("OrganizationRejected", lastOwner), "x")).toBe(lastOwner);
    expect(refusalWords(refusedWith("NotFound", "Not found"), "x")).toMatch(
      /^Mend couldn't find that person/,
    );
    expect(refusalWords(new Error(""), "Mend didn't change the role. Try again.")).toBe(
      "Mend didn't change the role. Try again.",
    );
  });

  it("says what removing someone does to their sessions before it happens", () => {
    const lines = removalLines(dorothy, "Northwind", {
      total: 3,
      running: ["Bump the Stripe SDK to v19"],
    });
    expect(lines).toEqual({
      access:
        "Dorothy won't be able to open Northwind's projects or sessions, and Mend signs Dorothy's devices out of Northwind straight away.",
      sessions:
        "Dorothy's 3 sessions stay in their projects. Owners can still open them and review their changes. Mend stops the one that's running, Bump the Stripe SDK to v19.",
      again: "To add Dorothy again, create a new invitation.",
    });
    expect(removalLines(dorothy, "Northwind", { total: 0, running: [] }).sessions).toBeNull();
    expect(removalLines(dorothy, "Northwind", { total: null, running: [] }).sessions).toBe(
      "Dorothy's sessions stay in their projects, and Mend stops any that are running.",
    );
    expect(firstNameOf({ name: "", email: "kat@northwind.dev" })).toBe("kat");
  });

  it("says what a removal did, and an SSH key Mend still owes", () => {
    expect(removedToast(dorothy, "Northwind", 1, { sshKeysOutstanding: 0 })).toBe(
      "Removed Dorothy Vaughan from Northwind and stopped Dorothy's running session.",
    );
    expect(removedToast(dorothy, "Northwind", 0, { sshKeysOutstanding: 2 })).toBe(
      "Removed Dorothy Vaughan from Northwind. Mend is still removing 2 of their workspace SSH keys and keeps trying until it's gone.",
    );
  });
});

describe("invitations", () => {
  const open = invitation({});
  const used = invitation({
    id: "inv-2",
    createdAt: new Date("2026-11-01T09:00:00"),
    acceptedByUserId: "linus",
    acceptedAt: new Date("2026-11-02T09:00:00"),
  });
  const revoked = invitation({
    id: "inv-3",
    email: null,
    createdAt: new Date("2026-11-03T09:00:00"),
    revokedAt: new Date("2026-11-04T09:00:00"),
  });
  const expired = invitation({
    id: "inv-4",
    createdAt: new Date("2026-10-01T09:00:00"),
    expiresAt: new Date("2026-10-08T09:00:00"),
  });

  it("splits open links from used, expired and revoked ones, newest first", () => {
    const groups = invitationGroups([expired, used, open, revoked], NOW);
    expect(groups.open.map((row) => row.id)).toEqual(["inv-1"]);
    expect(groups.closed.map((row) => row.id)).toEqual(["inv-3", "inv-2", "inv-4"]);
    expect(closedFold(3)).toBe("Show 3 used, expired or revoked links");
    expect(closedFold(1)).toBe("Show 1 used, expired or revoked link");
  });

  it("says who each is for, who made it and what became of it", () => {
    expect([sentTo(open), sentTo(revoked)]).toEqual([
      "linus@northwind.dev",
      "Anyone with the link",
    ]);
    expect(createdLine(open, "ada", roster, NOW)).toBe("By you · today, 11:12");
    expect(createdLine(used, "grace", roster, NOW)).toBe("By Ada Lovelace · 1 Nov");
    expect(createdLine({ ...used, createdByUserId: "bob" }, "ada", roster, NOW)).toBe(
      "By someone no longer here · 1 Nov",
    );
    expect(closedState(used, roster, NOW)).toBe("Used by Linus Pauling on 2 November");
    expect(closedState(revoked, roster, NOW)).toBe("Revoked on 4 November");
    expect(closedState(expired, roster, NOW)).toBe("Expired on 8 October");
  });

  it("says which link stopped working after a revoke", () => {
    expect(noOpenInvitations(null)).toBe(
      "No open invitations. Links you create show here until someone uses them or they expire.",
    );
    expect(noOpenInvitations({ email: "linus@northwind.dev" })).toBe(
      "No open invitations. The link you sent to linus@northwind.dev no longer works.",
    );
    expect(noOpenInvitations({ email: null })).toBe(
      "No open invitations. The link you revoked no longer works.",
    );
  });

  it("checks an email before asking, and allows none", () => {
    expect(emailProblem("")).toBeNull();
    expect(emailProblem(" linus@northwind.dev ")).toBeNull();
    expect(emailProblem("linus")).toBe("That doesn't look like an email address.");
  });

  it("makes the link whole and says what it allows", () => {
    expect(linkOf("/join#tok", "https://mend.northwind.dev/")).toBe(
      "https://mend.northwind.dev/join#tok",
    );
    expect(whoCanUse("linus@northwind.dev")).toBe("Only someone signing up as linus@northwind.dev");
    expect(whoCanUse(null)).toBe("Anyone who has the link");
    expect(expiresLine(new Date("2026-11-22T11:12:00"), NOW)).toBe(
      "22 Nov, 11:12, or once it's used",
    );
  });

  it("notices someone joining with one of the viewer's own links", () => {
    const accepted = { ...open, acceptedByUserId: "linus", acceptedAt: NOW };
    expect(joinedWithYours([open], [accepted], roster, "ada")).toEqual([linus]);
    expect(joinedWithYours([open], [accepted], roster, "grace")).toEqual([]);
    expect(joinedWithYours([accepted], [accepted], roster, "ada")).toEqual([]);
  });
});
