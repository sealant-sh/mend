import { describe, expect, it } from "vitest";

import { sessionModel, type WaitFact } from "./session-model.js";
import { layoutOf, redraws, ROOT, type Layout } from "./tree-layout.js";
import type { Project, Session } from "./types.js";

const NOW = new Date("2026-10-19T09:00:00.000Z");

const newsroom: Project = {
  id: "p1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (overrides: Partial<Session> & Pick<Session, "id">): Session => ({
  projectId: newsroom.id,
  harness: "claude",
  model: null,
  label: overrides.id,
  worktree: overrides.id,
  branch: `mend/${overrides.id}`,
  status: "running",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-18T20:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  ...overrides,
});

const layout = (
  sessions: ReadonlyArray<Session>,
  options: {
    readonly window?: { readonly kind: "workspace"; readonly sessionId: string };
    readonly waits?: ReadonlyMap<string, WaitFact>;
  } = {},
): Layout =>
  layoutOf({
    model: sessionModel({
      projects: [newsroom],
      details: [{ project: newsroom, sessions }],
      viewer: "dana",
      members: [],
      waits: options.waits ?? new Map(),
      landings: new Map(),
      lastSeen: { baseline: NOW.toISOString(), sessions: {} },
      connection: { state: "online", lastHeardAt: NOW.toISOString() },
      window: options.window ?? { kind: "local" },
      now: NOW,
    }),
    hasRead: true,
    error: null,
    viewer: "dana",
  });

const top = (tree: Layout) => (tree.get(ROOT) ?? []).map((placed) => placed.id);

describe("what the view redraws (SLNT-143)", () => {
  const fresh = session({ id: "fresh-worktree" });
  const other = session({ id: "other" });

  it("redraws only the row whose words changed, never the whole tree", () => {
    const before = layout([{ ...fresh, status: "stopping" }, other]);
    const after = layout([{ ...fresh, status: "stopping", summary: "saving" }, other]);
    expect(redraws(before, after)).toEqual([
      "running:fresh-worktree",
      "projects:p1:fresh-worktree",
    ]);
  });

  it("redraws the groups a stopped session left and joined, and keeps every other row", () => {
    const before = layout([{ ...fresh, status: "stopping" }, other]);
    const after = layout([{ ...fresh, status: "stopped" }, other]);
    const redrawn = redraws(before, after);
    expect(redrawn).toEqual(["group:running", "projects:p1:fresh-worktree"]);
  });

  it("redraws a group whose rows changed even when it holds as many as before", () => {
    const before = layout([{ ...fresh, status: "stopped" }, other]);
    const after = layout([fresh, { ...other, status: "stopped" }]);
    expect(redraws(before, after)).toContain("group:running");
  });

  it("keeps the top level when the last running session stops, so no row is forgotten", () => {
    const before = layout([{ ...fresh, status: "stopping" }]);
    const after = layout([{ ...fresh, status: "stopped" }]);
    expect(top(after)).toEqual(["group:needs", "group:since", "group:running", "group:projects"]);
    expect(redraws(before, after)).not.toBe("all");
  });

  it("keeps a workspace window's own row in place when it starts to wait", () => {
    const window: { readonly kind: "workspace"; readonly sessionId: string } = {
      kind: "workspace",
      sessionId: fresh.id,
    };
    const before = layout([fresh, other], { window });
    const wait: WaitFact = {
      key: "k",
      words: "claude needs your permission to use Bash",
      since: NOW.toISOString(),
      via: "terminal",
    };
    const after = layout([{ ...fresh, status: "waiting" }, other], {
      window,
      waits: new Map([[fresh.id, wait]]),
    });
    expect(top(after)).toEqual(["own:fresh-worktree", "others"]);
    expect(redraws(before, after)).toEqual(["own:fresh-worktree"]);
  });

  it("draws everything on the first read", () => {
    expect(redraws(null, layout([fresh]))).toBe("all");
  });
});
