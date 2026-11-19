import { describe, expect, it } from "vitest";

import {
  capturedNote,
  folderSize,
  linkCandidates,
  linkRequest,
  nextFolderSelection,
  nextReferenceIds,
  referenceVersion,
  shownAccess,
  shownSelected,
} from "./project-folders.ts";

const picks = [
  { folder: { id: "runbooks" }, name: "runbooks", readOnly: true },
  { folder: { id: "fixtures" }, name: "stripe", readOnly: false },
];

describe("nextFolderSelection", () => {
  it("keeps every other folder as the server confirmed it and adds the one turned on", () => {
    expect(
      nextFolderSelection(picks, { folderId: "tokens", name: "design-tokens", access: "read" }),
    ).toEqual([
      { folderId: "runbooks", name: "runbooks", readOnly: true },
      { folderId: "fixtures", name: "stripe", readOnly: false },
      { folderId: "tokens", name: "design-tokens", readOnly: true },
    ]);
  });

  it("leaves out a folder turned off", () => {
    expect(
      nextFolderSelection(picks, { folderId: "runbooks", name: "runbooks", access: "off" }),
    ).toEqual([{ folderId: "fixtures", name: "stripe", readOnly: false }]);
  });

  it("keeps the directory a picked folder already mounts at when its access changes", () => {
    expect(
      nextFolderSelection(picks, { folderId: "fixtures", name: "stripe-fixtures", access: "read" }),
    ).toContainEqual({ folderId: "fixtures", name: "stripe", readOnly: true });
  });
});

describe("shownAccess", () => {
  it("shows the newest change still on its way over what the server holds", () => {
    const pending = [
      { folderId: "runbooks", access: "write" as const },
      { folderId: "runbooks", access: "off" as const },
    ];
    expect(shownAccess(picks, pending, "runbooks")).toBe("off");
  });

  it("reads the server's access when nothing is on its way", () => {
    expect(shownAccess(picks, [], "runbooks")).toBe("read");
    expect(shownAccess(picks, [], "fixtures")).toBe("write");
    expect(shownAccess(picks, [], "tokens")).toBe("off");
  });
});

describe("references", () => {
  it("adds or removes one reference from the confirmed selection", () => {
    const confirmed = [{ id: "stripe-node" }, { id: "router" }];
    expect(nextReferenceIds(confirmed, { referenceId: "guide", selected: true })).toEqual([
      "stripe-node",
      "router",
      "guide",
    ]);
    expect(nextReferenceIds(confirmed, { referenceId: "router", selected: false })).toEqual([
      "stripe-node",
    ]);
    // Turning on one already on doesn't send it twice.
    expect(nextReferenceIds(confirmed, { referenceId: "router", selected: true })).toEqual([
      "stripe-node",
      "router",
    ]);
  });

  it("shows a pending switch before the server's answer", () => {
    expect(shownSelected([{ id: "a" }], [{ referenceId: "a", selected: false }], "a")).toBe(false);
    expect(shownSelected([{ id: "a" }], [], "a")).toBe(true);
    expect(shownSelected([], [], "a")).toBe(false);
  });

  it("names the version by its pinned ref, else the fetched commit, else the default branch", () => {
    expect(referenceVersion({ pinnedRef: "v17.4.0", headSha: "abcdef1234" })).toBe("v17.4.0");
    expect(referenceVersion({ pinnedRef: null, headSha: "abcdef1234" })).toBe("abcdef1");
    expect(referenceVersion({ pinnedRef: null, headSha: null })).toBe("default branch");
  });
});

describe("folderSize", () => {
  it("counts the files and adds up their size", () => {
    expect(folderSize({ files: [{ bytes: 120_000 }, { bytes: 60_000 }], truncated: false })).toBe(
      "2 files · 180 KB",
    );
    expect(folderSize({ files: [{ bytes: 512 }], truncated: false })).toBe("1 file · 512 B");
  });

  it("says when the listing was cut short, and when the folder is empty", () => {
    expect(folderSize({ files: [{ bytes: 2_000_000 }], truncated: true })).toBe(
      "1+ files · over 2.0 MB",
    );
    expect(folderSize({ files: [], truncated: false })).toBe("Empty");
  });
});

describe("capturedNote", () => {
  it("says nothing where everything is mounted as it is", () => {
    expect(capturedNote("folders", "bind", "checkout-api")).toBeNull();
    expect(capturedNote("links", "bind", "checkout-api")).toBeNull();
  });

  it("says what a captured deployment does to each kind", () => {
    expect(capturedNote("folders", "sources", "checkout-api")).toMatch(/copy of each folder/);
    expect(capturedNote("server-folders", "sources", "checkout-api")).toMatch(
      /sessions in checkout-api start without them/,
    );
    expect(capturedNote("links", "sources", "checkout-api")).toMatch(/don't get linked projects/);
  });
});

describe("linking a project", () => {
  const projects = [
    { id: "p1", name: "checkout-api" },
    { id: "p3", name: "web" },
    { id: "p2", name: "billing" },
  ];

  it("offers every other project not linked yet, by name", () => {
    expect(linkCandidates(projects, "p1", [{ linkedProjectId: "p3" }])).toEqual([
      { id: "p2", name: "billing" },
    ]);
    expect(linkCandidates(projects, "p1", []).map((project) => project.name)).toEqual([
      "billing",
      "web",
    ]);
  });

  it("names the directory after the project and takes a blank worktree as the default branch's", () => {
    expect(linkRequest({ id: "p3", name: "web" }, " ", "")).toEqual({
      linkedProjectId: "p3",
      name: "web",
      worktreeName: null,
    });
    expect(linkRequest({ id: "p3", name: "web" }, " frontend ", " feature ")).toEqual({
      linkedProjectId: "p3",
      name: "frontend",
      worktreeName: "feature",
    });
    expect(linkRequest(null, "web", "")).toBeNull();
  });
});
