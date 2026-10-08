import { joinWorktreeLine } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  joinLine,
  launcherName,
  othersInWorktree,
  parseLivePeople,
  parseMembers,
  parseRetirement,
  parseWaitLine,
  sessionLines,
  withLivePeople,
} from "./session-lines.js";

const anna = { accountId: "anna", name: "Anna" };
const bob = { accountId: "bob", name: "Bob" };

describe("parsing what the server says", () => {
  it("reads live people, and nobody from an older server or a malformed entry", () => {
    expect(parseLivePeople([anna, { accountId: 3 }, bob])).toEqual([anna, bob]);
    expect(parseLivePeople(undefined)).toEqual([]);
  });

  it("reads the waiting line, and null when nothing waits", () => {
    expect(
      parseWaitLine({ line: "Waits for Anna's background task before Bob's turn starts." }),
    ).toBe("Waits for Anna's background task before Bob's turn starts.");
    expect(parseWaitLine(null)).toBeNull();
  });

  it("reads a retirement, dropping stops of a kind it does not know", () => {
    expect(
      parseRetirement({
        state: "marked",
        preRelease: true,
        launcher: "anna",
        reason: null,
        canReplace: false,
        stops: [
          { kind: "shell", label: "shell 1" },
          { kind: "later", label: "?" },
        ],
      }),
    ).toEqual({
      state: "marked",
      preRelease: true,
      launcher: "anna",
      reason: null,
      stops: [{ kind: "shell", label: "shell 1" }],
    });
    expect(parseRetirement(null)).toBeNull();
    expect(parseRetirement({ state: "gone" })).toBeNull();
  });

  it("reads the roster by id and name", () => {
    expect(parseMembers([{ userId: "anna", name: "Anna", email: "a@x" }, {}])).toEqual([
      { userId: "anna", name: "Anna" },
    ]);
  });
});

describe("a session's lines (docs/adr/0016, decisions 13 and 14)", () => {
  it("says the shared workspace, waiting and retirement lines in that order", () => {
    expect(
      sessionLines({
        session: { livePeople: [anna, bob] },
        viewer: "bob",
        waitLine: "Waits for Anna's background task before Bob's turn starts.",
        retirement: {
          state: "marked",
          preRelease: true,
          launcher: "anna",
          reason: null,
          stops: [],
        },
        members: [],
      }),
    ).toEqual([
      "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
      "Waits for Anna's background task before Bob's turn starts.",
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
    ]);
  });

  it("says nothing with one person live and nothing waiting", () => {
    expect(
      sessionLines({
        session: { livePeople: [bob] },
        viewer: "bob",
        waitLine: null,
        retirement: null,
        members: [],
      }),
    ).toEqual([]);
  });

  it("names the launcher from the roster when they are not live, else in its own words", () => {
    expect(launcherName("anna", [], [{ userId: "anna", name: "Anna" }])).toBe("Anna");
    expect(launcherName("anna", [], [])).toBe("its launcher");
  });
});

describe("the join line", () => {
  const sessions = [
    { id: "s1", worktreeId: "wt-1", livePeople: [] },
    { id: "s2", worktreeId: "wt-2", livePeople: [] },
  ];
  const listed = [{ id: "s1", livePeople: [anna, bob] }];

  it("names the others live in the worktree, from the session list", () => {
    const merged = withLivePeople(sessions, listed);
    expect(othersInWorktree(merged, "wt-1", "bob")).toEqual(["Anna"]);
    expect(joinLine(othersInWorktree(merged, "wt-1", "bob"))).toBe(joinWorktreeLine(["Anna"]));
  });

  it("says nothing in a worktree where only you, or nobody, runs", () => {
    const merged = withLivePeople(sessions, listed);
    expect(joinLine(othersInWorktree(merged, "wt-2", "bob"))).toBeNull();
    expect(othersInWorktree(merged, "wt-1", null)).toEqual([]);
    expect(
      othersInWorktree(withLivePeople(sessions, [{ id: "s1", livePeople: [bob] }]), "wt-1", "bob"),
    ).toEqual([]);
  });
});
