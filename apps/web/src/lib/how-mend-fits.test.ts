import { describe, expect, it } from "vitest";

import {
  type FitsNames,
  nestingIntro,
  organizationLine,
  pictureProject,
  sampleInboxView,
  screenOf,
} from "./how-mend-fits.ts";

const names: FitsNames = {
  host: "mend.northwind.dev",
  organization: "Northwind",
  owner: true,
  person: "Ada Lovelace",
  email: "ada@northwind.dev",
  project: "checkout-api",
  ownProject: true,
};

describe("which screen an address opens", () => {
  it("opens the screen asked for, and the first for anything else", () => {
    expect(screenOf("2")).toBe(2);
    expect(screenOf(3)).toBe(3);
    expect(screenOf("4")).toBe(1);
    expect(screenOf("next")).toBe(1);
    expect(screenOf(undefined)).toBe(1);
  });
});

describe("the project the pictures show", () => {
  const older = { name: "web", createdAt: new Date("2026-11-01") };
  const newer = { name: "billing", createdAt: new Date("2026-11-19") };

  it("shows the clone this browser just started, even before it is a project", () => {
    expect(pictureProject("checkout-api", [older, newer])).toEqual({
      name: "checkout-api",
      own: true,
    });
  });

  it("shows the newest project the person can see when no clone is under way", () => {
    expect(pictureProject(null, [older, newer])).toEqual({ name: "billing", own: true });
  });

  it("shows the sample, and says it is one, to someone with no project", () => {
    expect(pictureProject(null, [])).toEqual({ name: "checkout-api", own: false });
    expect(nestingIntro({ ...names, ownProject: false })).toContain("a sample project");
    expect(nestingIntro(names)).toContain("the project you just added");
  });
});

describe("what the organization is, to its reader", () => {
  it("tells an owner they invite its members, and a member that its owners do", () => {
    expect(organizationLine(names)).toContain(
      "You're Northwind's owner, so you invite its members.",
    );
    expect(organizationLine({ ...names, owner: false })).toContain(
      "You're a member of Northwind. Its owners invite people.",
    );
  });
});

describe("the sample sidebar", () => {
  it("falls into the five groups the frame draws, by the inbox's own rules", () => {
    const view = sampleInboxView("checkout-api", new Date("2026-11-20T10:00:00"));
    const titles = (group: keyof typeof view.groups) => view.groups[group].map((row) => row.title);
    expect(titles("waiting")).toEqual([
      "Fix flaky checkout retry",
      "Rotate staging database credentials",
    ]);
    expect(titles("review")).toEqual([
      "Upgrade to React Router 8",
      "Show prices in the shopper's currency",
    ]);
    expect(view.groups.running).toHaveLength(2);
    expect(view.groups.snoozed).toHaveLength(1);
    expect(view.groups.done).toHaveLength(9);
    // The reader's own project names the session the other screens show.
    expect(view.groups.waiting[0]?.project.name).toBe("checkout-api");
  });
});
