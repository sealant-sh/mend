import { describe, expect, it } from "vitest";

import {
  joinedLine,
  leaveRow,
  nameDraft,
  namesList,
  ownersOf,
  renameRefusal,
  type RosterMember,
  whoRenames,
} from "./organization-general.ts";
import { refusedWith } from "./refusal-fixture.ts";

const NOW = new Date("2026-11-19T10:00:00");
const person = (
  userId: string,
  name: string,
  role: RosterMember["role"],
  joinedAt = new Date("2026-03-02T09:00:00"),
): RosterMember => ({ userId, name, email: `${userId}@northwind.dev`, role, joinedAt });

const ada = person("ada", "Ada Lovelace", "owner");
const mae = person("mae", "Mae Jemison", "owner", NOW);
const linus = person("linus", "Linus Pauling", "member");
const grace = person("grace", "Grace Hopper", "owner");

describe("the owners the page lists", () => {
  it("only owners, the person looking first, then by name", () => {
    expect(ownersOf([linus, mae, grace, ada], "mae").map((owner) => owner.userId)).toEqual([
      "mae",
      "ada",
      "grace",
    ]);
  });

  it("says when each joined, never when they became an owner (the server doesn't keep it)", () => {
    expect(joinedLine(mae.joinedAt, NOW)).toBe("Joined today");
    expect(joinedLine(ada.joinedAt, NOW)).toBe("Joined 2 March");
    expect(joinedLine(new Date("2025-12-24T09:00:00"), NOW)).toBe("Joined 24 December 2025");
  });
});

describe("who may rename the organization, told to a member", () => {
  it("names the owners", () => {
    expect(namesList(["Ada"])).toBe("Ada");
    expect(namesList(["Ada", "Mae", "Grace"])).toBe("Ada, Mae and Grace");
    expect(whoRenames("Northwind", ["Ada Lovelace", "Mae Jemison"])).toBe(
      "Only an owner can rename it: Ada Lovelace and Mae Jemison.",
    );
  });

  it("still says who, with an ownerless roster", () => {
    expect(whoRenames("Northwind", [])).toBe("Only an owner of Northwind can rename it.");
  });
});

describe("the name field", () => {
  it("offers Save only for a changed name, and checks it by the server's rules first", () => {
    expect(nameDraft("Northwind", " Northwind ")).toEqual({ changed: false, problem: null });
    expect(nameDraft("Northwind", "Northwind Labs")).toEqual({ changed: true, problem: null });
    expect(nameDraft("Northwind", "  ")).toEqual({
      changed: true,
      problem: "An organization needs a name.",
    });
    expect(nameDraft("Northwind", "n".repeat(65)).problem).toBe(
      "Organization names are at most 64 characters.",
    );
  });

  it("shows a refusal about the name in the server's words, anything else as not saved", () => {
    const taken = "There's already an organization called Globex. Pick another name.";
    expect(renameRefusal(refusedWith("OrganizationNameTaken", taken), "Northwind")).toBe(taken);
    expect(renameRefusal(refusedWith("NotFound", "Not found"), "Northwind")).toBe(
      "Only an owner of Northwind can rename it.",
    );
    expect(renameRefusal(new Error("Failed to fetch"), "Northwind")).toBe(
      "Mend didn't rename Northwind. Failed to fetch",
    );
    expect(renameRefusal(new Error(""), "Northwind")).toBe(
      "Mend didn't rename Northwind. Check your connection and try again.",
    );
  });
});

const row = (viewerId: string, roster: ReadonlyArray<RosterMember>, organizations = 2) =>
  leaveRow({ organization: "Northwind", viewerId, roster, organizations });

describe("the Leave row", () => {
  it("offers nothing in the person's only organization, which the server refuses", () => {
    expect(row("linus", [ada, linus], 1)).toEqual({
      note: "Northwind is your only organization on this server, so you can't leave it. An owner can remove you instead.",
      offer: false,
    });
  });

  it("offers a member Leave with nothing more to say", () => {
    expect(row("linus", [ada, linus])).toEqual({ note: null, offer: true });
  });

  it("tells an owner who else owns it, or that they must make someone else an owner first", () => {
    expect(row("ada", [ada, mae, linus])).toEqual({
      note: "Mae Jemison is also an owner, so you can leave. If you were the only owner, you'd need to make someone else an owner first.",
      offer: true,
    });
    expect(row("ada", [ada, mae, grace]).note).toBe(
      "Northwind has 2 other owners, so you can leave.",
    );
    expect(row("ada", [ada, linus])).toEqual({
      note: "You're Northwind's only owner. Make someone else an owner on the Members page before you leave.",
      offer: true,
    });
  });
});
