import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import {
  privateLabel,
  projectChangers,
  type ProjectPeople,
  projectNameDraft,
  readOnlyLine,
  renameRefusal,
  repositoryLine,
  visibilityLine,
  whoRemoves,
} from "./project-settings.ts";

const roster = [
  { userId: "ada", name: "Ada Lovelace", role: "owner" as const },
  { userId: "grace", name: "Grace Hopper", role: "member" as const },
  { userId: "mae", name: "Mae Jemison", role: "member" as const },
];

/** checkout-api, added by Grace, seen by `viewer`. */
const people = (viewer: string, members = roster): ProjectPeople => ({
  projectName: "checkout-api",
  organizationName: "Northwind",
  createdByUserId: "grace",
  viewerUserId: viewer,
  members,
});

const refusal = (tag: string, message: string) =>
  new TRPCClientError(message, { result: { error: { data: { tag } } } });

describe("who may change a project's settings", () => {
  it("names the person who added it beside the owners, and says 'you' to them", () => {
    expect(projectChangers(people("mae"))).toBe(
      "Grace Hopper, who added checkout-api, and Northwind's owners",
    );
    expect(projectChangers(people("grace"))).toBe("You and Northwind's owners");
  });

  it("says it generally until the roster is read", () => {
    expect(readOnlyLine(people("mae", []))).toBe(
      "The person who added checkout-api and Northwind's owners can change these settings. You can read them.",
    );
  });
});

describe("who sees the project", () => {
  it("names the one person who sees a private project, from the viewer's side", () => {
    expect(privateLabel(people("grace"))).toBe("Only you");
    expect(privateLabel(people("ada"))).toBe("Only Grace Hopper");
  });

  it("tells someone who can't change it which owners can", () => {
    expect(visibilityLine("shared", people("mae"), false)).toBe(
      "Everyone in Northwind can see its sessions and start their own. Only Ada Lovelace can change this.",
    );
  });

  it("warns an owner what making a shared project private ends", () => {
    expect(visibilityLine("shared", people("ada"), true)).toContain(
      "Making it private ends other people's ready workspaces",
    );
    expect(visibilityLine("private", people("grace"), false)).toBe(
      "Only you can see it and its sessions. Only Ada Lovelace can change this.",
    );
  });
});

describe("the repository line", () => {
  const now = new Date(2026, 10, 19);
  const added = new Date(2026, 2, 2);

  it("says who added it and that Mend cloned it then", () => {
    expect(
      repositoryLine(
        { originUrl: "git@github.com:northwind/checkout-api.git", createdAt: added },
        people("ada"),
        now,
      ),
    ).toBe("Grace Hopper added the project on 2 March, and Mend cloned it then.");
  });

  it("says a project made in Mend has nothing to clone", () => {
    expect(repositoryLine({ originUrl: null, createdAt: added }, people("grace"), now)).toBe(
      "You created the project in Mend on 2 March. It has no repository to clone.",
    );
  });
});

describe("renaming a project", () => {
  const others = [
    { id: "p-checkout", name: "checkout-api" },
    { id: "p-web", name: "web" },
  ];
  const draft = (typed: string) =>
    projectNameDraft("checkout-api", typed, others, "p-checkout", "Northwind");

  it("offers nothing to save until the name differs", () => {
    expect(draft(" checkout-api ")).toEqual({ changed: false, problem: null });
    expect(draft("payments-api")).toEqual({ changed: true, problem: null });
  });

  it("refuses a name before sending it, in the words adding a project uses", () => {
    expect(draft("web").problem).toBe("Northwind already has a project named web.");
    expect(draft("Checkout API").problem).toMatch(/^Use lowercase letters/);
    expect(draft("").problem).toBe("Give the project a name.");
  });

  it("shows the server's own words for a refused name", () => {
    expect(
      renameRefusal(
        refusal("StoreFailure", 'A project named "web" already exists.'),
        "checkout-api",
      ),
    ).toBe('A project named "web" already exists.');
    expect(renameRefusal(refusal("NotFound", "Not found"), "checkout-api")).toBe(
      "Mend couldn't find checkout-api. Someone may have removed it.",
    );
  });
});

describe("who may remove a project", () => {
  it("is an owner for a shared project", () => {
    expect(whoRemoves("shared", people("mae"))).toBe("Only Ada Lovelace can remove it.");
  });

  it("is also the person who added a private one", () => {
    expect(whoRemoves("private", people("mae"))).toBe(
      "Only Grace Hopper or Ada Lovelace can remove it.",
    );
  });
});
