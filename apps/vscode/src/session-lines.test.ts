import { JOIN_SHARED_HOME_LINE, joinWorktreeLine } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  joinLine,
  joinLineOf,
  launcherName,
  liveSessionLines,
  othersInWorktree,
  parseLivePeople,
  parseMembers,
  parseRetirement,
  parseRetirementState,
  parseWaitLine,
  readProjects,
  sessionLines,
  workspaceReads,
  worktreeJoinLine,
} from "./session-lines.js";
import type { Session } from "./types.js";

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
          { kind: "unchecked", label: "" },
          { kind: "later", label: "?" },
        ],
      }),
    ).toEqual({
      state: "marked",
      preRelease: true,
      launcher: "anna",
      reason: null,
      stops: [
        { kind: "shell", label: "shell 1" },
        { kind: "unchecked", label: "" },
      ],
    });
    expect(parseRetirement(null)).toBeNull();
    expect(parseRetirement({ state: "gone" })).toBeNull();
  });

  it("reads a session's retirement state, and none from an older server", () => {
    expect(parseRetirementState("marked")).toBe("marked");
    expect(parseRetirementState("retiring")).toBe("retiring");
    expect(parseRetirementState(undefined)).toBeNull();
    expect(parseRetirementState("gone")).toBeNull();
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

describe("which workspace reads are worth a request", () => {
  const row: Parameters<typeof workspaceReads>[0] = {
    livePeople: [anna],
    sharedControlEnabledAt: "2026-10-08T12:00:00.000Z",
    workspaceRetirement: null,
  };

  it("asks for the waiting line only with someone live and shared control on", () => {
    expect(workspaceReads(row)).toEqual({ waiting: true, retirement: false });
    expect(workspaceReads({ ...row, livePeople: [] }).waiting).toBe(false);
    expect(workspaceReads({ ...row, sharedControlEnabledAt: null }).waiting).toBe(false);
  });

  it("asks for the retirement only while one is under way", () => {
    expect(workspaceReads({ ...row, workspaceRetirement: "marked" }).retirement).toBe(true);
    expect(workspaceReads({ ...row, workspaceRetirement: "retiring" }).retirement).toBe(true);
    expect(workspaceReads({ ...row, livePeople: [], sharedControlEnabledAt: null })).toEqual({
      waiting: false,
      retirement: false,
    });
  });
});

describe("the join line", () => {
  const row: Pick<Session, "worktreeId" | "status" | "ownerUserId" | "livePeople"> = {
    worktreeId: "wt-1",
    status: "running",
    ownerUserId: "anna",
    livePeople: [],
  };

  it("names the others live in the worktree, from the project view's rows", () => {
    const sessions = [{ ...row, livePeople: [anna, bob] }];
    expect(othersInWorktree(sessions, "wt-1", "bob")).toEqual(["Anna"]);
    expect(worktreeJoinLine(sessions, "wt-1", "bob")).toBe(joinWorktreeLine(["Anna"]));
    expect(joinLine([])).toBeNull();
  });

  it("says the shared-home line where another person's session is live and nobody is listed", () => {
    expect(worktreeJoinLine([row], "wt-1", "bob")).toBe(JOIN_SHARED_HOME_LINE);
  });

  it("says nothing for an unknown viewer, your own session, a settled one, or only you listed", () => {
    expect(worktreeJoinLine([row], "wt-1", null)).toBeNull();
    expect(worktreeJoinLine([row], "wt-1", "anna")).toBeNull();
    expect(worktreeJoinLine([row], "wt-2", "bob")).toBeNull();
    expect(worktreeJoinLine([{ ...row, status: "completed" }], "wt-1", "bob")).toBeNull();
    expect(worktreeJoinLine([{ ...row, livePeople: [bob] }], "wt-1", "bob")).toBeNull();
  });
});

/** A client that answers every read and records which it was asked for. */
const countingClient = (viewer: string | null = "bob") => {
  const asked: Array<string> = [];
  return {
    asked,
    viewerId: async () => {
      asked.push("/organization");
      return viewer;
    },
    memberNames: async () => {
      asked.push("/organization/members");
      return [];
    },
    waitLine: async (id: string) => {
      asked.push(`/sessions/${id}/waiting`);
      return null;
    },
    workspaceRetirement: async (id: string) => {
      asked.push(`/sessions/${id}/workspace-retirement`);
      return null;
    },
  };
};

describe("with per-person homes off, no request beyond the project view", () => {
  const project = {
    id: "p1",
    name: "auth",
    originUrl: null,
    storePath: "/store/auth",
    defaultBranch: "main",
  };
  const session = (over: Partial<Session> = {}): Session => ({
    id: "s1",
    projectId: project.id,
    worktreeId: "wt-1",
    harness: "codex",
    model: null,
    label: null,
    worktree: "fix-auth",
    branch: "mend/fix-auth",
    status: "running",
    sealantWorkspaceId: null,
    summary: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    ownerUserId: "anna",
    livePeople: [],
    sharedControlEnabledAt: "2026-10-08T12:00:00.000Z",
    workspaceRetirement: null,
    ...over,
  });
  const reading = (sessions: ReadonlyArray<Session>) => {
    const client = countingClient();
    return {
      ...client,
      listProjects: async () => {
        client.asked.push("/projects");
        return [project];
      },
      projectDetail: async (id: string) => {
        client.asked.push(`/projects/${id}`);
        return { project, sessions };
      },
    };
  };

  it("reads the tree's projects without asking who reads them", async () => {
    const client = reading([session()]);
    expect((await readProjects(client)).viewer).toBeNull();
    expect(client.asked).toEqual(["/projects", "/projects/p1"]);
  });

  it("asks who reads them once a row lists someone live or a retirement", async () => {
    const live = reading([session({ livePeople: [anna] })]);
    expect((await readProjects(live)).viewer).toBe("bob");
    expect(live.asked).toContain("/organization");
    const retiring = reading([session({ workspaceRetirement: "marked" })]);
    await readProjects(retiring);
    expect(retiring.asked).toContain("/organization");
  });

  it("says a live session's lines without a request", async () => {
    const client = countingClient();
    expect(await liveSessionLines(session(), client)).toEqual([]);
    expect(client.asked).toEqual([]);
  });

  it("asks for the viewer and the waiting line only once the row lists people", async () => {
    const client = countingClient();
    await liveSessionLines(session({ livePeople: [anna, bob] }), client);
    expect(client.asked).toEqual(["/organization", "/sessions/s1/waiting"]);
  });

  it("checks the join without asking who you are, and says the shared-home line only for a known viewer", async () => {
    const client = countingClient();
    expect(await joinLineOf([session()], "wt-1", null, client)).toBeNull();
    expect(client.asked).toEqual([]);
    expect(await joinLineOf([session()], "wt-1", "bob", client)).toBe(JOIN_SHARED_HOME_LINE);
    expect(client.asked).toEqual([]);
  });

  it("asks who you are where the worktree lists someone live, then names them", async () => {
    const client = countingClient();
    expect(await joinLineOf([session({ livePeople: [anna] })], "wt-1", null, client)).toBe(
      joinWorktreeLine(["Anna"]),
    );
    expect(client.asked).toEqual(["/organization"]);
  });
});
