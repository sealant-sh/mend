import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  REPLACE_WORKSPACE_ACTION,
  SHARED_CONTROL_LINE,
  SHARED_CONTROL_LINE_OWNER_LOGINS,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  confirmPlan,
  hasPersonFacts,
  joinLineFor,
  launcherNameOf,
  othersLiveInWorktree,
  replaceConfirmLines,
  sessionWorkspaceLines,
  sharedControlConfirmLines,
  sharedControlQuestion,
  workspaceLineList,
  workspaceReadsOf,
  worktreeJoinLine,
  worktreeListsPeople,
  wrapWords,
  type WorkspaceRetirementDto,
} from "./shared-workspace.ts";

const anna = { accountId: "anna", name: "Anna" };
const bob = { accountId: "bob", name: "Bob" };
const cleo = { accountId: "cleo", name: "Cleo" };

const retirement = (over: Partial<WorkspaceRetirementDto> = {}): WorkspaceRetirementDto => ({
  state: "marked",
  preRelease: true,
  launcher: "anna",
  stops: [{ kind: "shell", label: "auth · shell 1" }],
  reason: null,
  checkedAt: null,
  fingerprint: "fp-1",
  canReplace: true,
  ...over,
});

describe("who else is live in a worktree", () => {
  it("names everyone live there but the viewer, once each, from any session of the worktree", () => {
    const sessions = [
      { worktreeId: "wt-1", livePeople: [anna, bob] },
      { worktreeId: "wt-1", livePeople: [anna, cleo] },
      { worktreeId: "wt-2", livePeople: [{ accountId: "dan", name: "Dan" }] },
    ];
    expect(othersLiveInWorktree(sessions, "wt-1", "bob")).toEqual(["Anna", "Cleo"]);
  });

  it("names nobody in a shared executor, from an older server, or for an unknown viewer", () => {
    expect(othersLiveInWorktree([{ worktreeId: "wt-1", livePeople: [] }], "wt-1", "bob")).toEqual(
      [],
    );
    expect(othersLiveInWorktree([{ worktreeId: "wt-1" }], "wt-1", "bob")).toEqual([]);
    expect(
      othersLiveInWorktree([{ worktreeId: "wt-1", livePeople: [anna] }], "wt-1", null),
    ).toEqual([]);
  });

  it("says the join line word for word, and nothing when nobody else runs there", () => {
    expect(joinLineFor(["Anna"])).toBe(joinWorktreeLine(["Anna"]));
    expect(joinLineFor([])).toBeNull();
  });
});

describe("the join line by the workspace's layout", () => {
  const live = { worktreeId: "wt-1", status: "running" };

  it("says the per-person line, by name, where the worktree lists someone else live", () => {
    const sessions = [{ ...live, ownerUserId: "anna", livePeople: [anna, bob] }];
    expect(worktreeJoinLine(sessions, "wt-1", "bob")).toBe(joinWorktreeLine(["Anna"]));
    expect(worktreeListsPeople(sessions, "wt-1")).toBe(true);
  });

  it("says the shared-home line where another person's session is live and nobody is listed", () => {
    const sessions = [{ ...live, ownerUserId: "anna", livePeople: [] }];
    expect(worktreeJoinLine(sessions, "wt-1", "bob")).toBe(JOIN_SHARED_HOME_LINE);
    expect(worktreeListsPeople(sessions, "wt-1")).toBe(false);
  });

  it("says nothing for an unknown viewer, your own session, a settled one, or a listed executor", () => {
    const annas = [{ ...live, ownerUserId: "anna", livePeople: [] }];
    expect(worktreeJoinLine(annas, "wt-1", null)).toBeNull();
    expect(worktreeJoinLine(annas, "wt-1", "anna")).toBeNull();
    expect(worktreeJoinLine(annas, "wt-2", "bob")).toBeNull();
    expect(
      worktreeJoinLine([{ ...live, status: "completed", ownerUserId: "anna" }], "wt-1", "bob"),
    ).toBeNull();
    // A per-person executor where only you are live: nobody else's process runs there.
    expect(
      worktreeJoinLine([{ ...live, ownerUserId: "anna", livePeople: [bob] }], "wt-1", "bob"),
    ).toBeNull();
  });

  it("finds something per-person to say only where a row lists someone live or a retirement", () => {
    expect(hasPersonFacts([{ livePeople: [], workspaceRetirement: null }, {}])).toBe(false);
    expect(hasPersonFacts([{ livePeople: [anna] }])).toBe(true);
    expect(hasPersonFacts([{ workspaceRetirement: "retiring" }])).toBe(true);
  });
});

describe("what a session says about its workspace", () => {
  it("names the launcher from the live people, then the roster, then its own words", () => {
    expect(launcherNameOf("anna", [anna], [])).toBe("Anna");
    expect(launcherNameOf("anna", [], [{ userId: "anna", name: "Anna P" }])).toBe("Anna P");
    expect(launcherNameOf(null, [anna], [])).toBe("its launcher");
  });

  it("orders the lines: shared workspace, waiting, retirement, then the owner's action", () => {
    const lines = sessionWorkspaceLines({
      sessionId: "3f2a0001-aaaa",
      livePeople: [anna, bob],
      viewer: "bob",
      wait: { line: "Waits for Anna's 2 background tasks before Bob's turn starts." },
      retirement: retirement(),
      members: [],
    });
    expect(workspaceLineList(lines)).toEqual([
      "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
      "Waits for Anna's 2 background tasks before Bob's turn starts.",
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
      `${REPLACE_WORKSPACE_ACTION} · mend workspace replace 3f2a0001`,
      "  Checked: Mend's records only · processes Mend did not start and running containers not checked yet",
      "  shell · auth · shell 1",
      "  Mend starts the launching session's mend.toml Services again.",
    ]);
  });

  it("offers the replacement only to the change's owner, and only while it is marked", () => {
    const base = {
      sessionId: "3f2a0001",
      livePeople: [],
      viewer: "bob",
      wait: null,
      members: [],
    };
    expect(
      sessionWorkspaceLines({ ...base, retirement: retirement({ canReplace: false }) }).replace,
    ).toBeNull();
    expect(
      sessionWorkspaceLines({ ...base, retirement: retirement({ state: "retiring" }) }).replace,
    ).toBeNull();
    expect(workspaceLineList(sessionWorkspaceLines({ ...base, retirement: null }))).toEqual([]);
  });
});

describe("wrapWords", () => {
  it("keeps every word and stays inside the width", () => {
    const text = joinWorktreeLine(["Anna"]);
    const rows = wrapWords(text, 40);
    expect(rows.join(" ")).toBe(text);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
  });

  it("cuts a word longer than the width instead of dropping it", () => {
    expect(wrapWords("a abcdefghijkl b", 8)).toEqual(["a", "abcdefgh", "ijkl b"]);
  });
});

describe("the confirmations", () => {
  it("asks at a terminal, takes --yes from a script, and refuses a script without it", () => {
    expect(confirmPlan([], true)).toBe("ask");
    expect(confirmPlan(["--yes"], false)).toBe("confirmed");
    expect(confirmPlan([], false)).toBe("refuse");
  });

  it("says the shared control confirmation word for word, in both layouts", () => {
    expect(sharedControlConfirmLines(true)).toEqual([
      "Turn on shared control?",
      SHARED_CONTROL_LINE,
    ]);
    const [title, body] = sharedControlConfirmLines(false);
    expect(title).toBe("Turn on shared control?");
    expect(body).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
    expect(body).not.toContain(SHARED_CONTROL_LINE);
    expect(sharedControlQuestion(false)).toBe("turn on? (n: keep it off)");
  });

  it("lists what was checked and what would stop before a replacement", () => {
    expect(replaceConfirmLines(retirement({ stops: [] }))).toEqual([
      `${REPLACE_WORKSPACE_ACTION}?`,
      "  Checked: Mend's records only · processes Mend did not start and running containers not checked yet",
      "  Found nothing that would stop.",
      "  Mend starts the launching session's mend.toml Services again.",
    ]);
    expect(
      replaceConfirmLines(
        retirement({
          checkedAt: "2026-10-08T12:05:30.000Z",
          stops: [
            { kind: "process", label: "" },
            { kind: "unchecked", label: "running containers" },
          ],
        }),
      ),
    ).toEqual([
      `${REPLACE_WORKSPACE_ACTION}?`,
      "  Checked at 12:05 UTC: Mend's records, the processes in the workspace and its running containers",
      "  process Mend did not start",
      "  could not check · running containers",
      "  Mend starts the launching session's mend.toml Services again.",
    ]);
  });
});

describe("which workspace reads are worth a request", () => {
  it("asks for the waiting line only with someone live and shared control on", () => {
    const on = "2026-10-08T12:00:00.000Z";
    expect(workspaceReadsOf({ livePeople: [anna], sharedControlEnabledAt: on }).waiting).toBe(true);
    expect(workspaceReadsOf({ livePeople: [], sharedControlEnabledAt: on }).waiting).toBe(false);
    expect(workspaceReadsOf({ livePeople: [anna], sharedControlEnabledAt: null }).waiting).toBe(
      false,
    );
  });

  it("asks for the retirement only while one is under way, and nothing from an older server", () => {
    expect(workspaceReadsOf({ workspaceRetirement: "marked" }).retirement).toBe(true);
    expect(workspaceReadsOf({ workspaceRetirement: "retiring" }).retirement).toBe(true);
    expect(workspaceReadsOf({ workspaceRetirement: null }).retirement).toBe(false);
    expect(workspaceReadsOf({})).toEqual({ waiting: false, retirement: false });
  });
});
