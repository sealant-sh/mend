import { ChangeId, Sha, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ProjectSessionRow } from "./project-sessions.ts";
import { lastActiveWords, phoneLine, worktreeRows } from "./project-worktrees.ts";

const now = new Date("2026-11-18T14:00:00");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const worktree = (name: string, updated: number, baseRef: string | null = "main") => ({
  id: WorktreeId.make(`wt-${name}`),
  name,
  branch: `mend/${name}`,
  directory: name,
  baseRef,
  baseSha: Sha.make("16f4f2d9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"),
  handoff: null,
  updatedAt: minutesAgo(updated),
});

const row = (
  id: string,
  tree: string,
  status: { word: string; tone: ProjectSessionRow["status"]["tone"] },
  extra: { readonly owner?: string; readonly updated?: number } = {},
): ProjectSessionRow => ({
  id,
  title: `Session ${id}`,
  status,
  open: true,
  worktreeId: `wt-${tree}`,
  worktree: tree,
  branch: `mend/${tree}`,
  agent: "claude",
  model: null,
  ownerUserId: extra.owner ?? "ada",
  updatedAt: minutesAgo(extra.updated ?? 10),
  changeId: null,
  fileCount: null,
  handedOffFrom: null,
});

const pullRequest = (state: "open" | "merged") => ({
  number: 412,
  url: "https://github.com/northwind/checkout-api/pull/412",
  state,
  title: null,
  observedAt: now,
  adopted: false,
});

const names = new Map([["grace", "Grace Hopper"]]);

describe("worktreeRows", () => {
  const detail = {
    worktrees: [worktree("fix-retry", 60), worktree("stripe", 60), worktree("spike", 600)],
    sessions: [
      { id: "s1", worktreeId: "wt-fix-retry" },
      { id: "s2", worktreeId: "wt-fix-retry" },
      { id: "s3", worktreeId: "wt-stripe" },
    ],
    worktreeAnnotations: [
      {
        worktreeId: WorktreeId.make("wt-fix-retry"),
        changeId: ChangeId.make("c1"),
        pullRequest: pullRequest("open"),
      },
    ],
  };
  const rows = worktreeRows(
    detail,
    [
      row("s2", "fix-retry", { word: "Running", tone: "run" }, { updated: 4 }),
      row("s1", "fix-retry", { word: "Waiting on you", tone: "wait" }, { updated: 8 }),
      row("s3", "stripe", { word: "Completed", tone: "ok" }, { owner: "grace", updated: 20 }),
    ],
    new Set(["s1", "s2"]),
    names,
    "ada",
  );

  it("lists the most recently active worktree first, a session's activity counting", () => {
    expect(rows.map((r) => r.name)).toEqual(["fix-retry", "stripe", "spike"]);
    expect(rows[0]?.lastActive).toEqual(minutesAgo(4));
  });

  it("gives a worktree the most pressing status of its sessions", () => {
    expect(rows[0]?.status?.word).toBe("Waiting on you");
    expect(rows[2]?.status).toBeNull();
  });

  it("is finished only when none of its sessions still holds it", () => {
    expect(rows.map((r) => r.finished)).toEqual([false, true, true]);
  });

  it("names the owner of a session that isn't the viewer's", () => {
    expect(rows[0]?.sessions.map((s) => s.owner)).toEqual([null, null]);
    expect(rows[1]?.sessions[0]?.owner).toBe("Grace Hopper");
  });

  it("says what landing did with the change", () => {
    expect(rows[0]?.change).toEqual({
      words: "Pull request #412 open",
      url: "https://github.com/northwind/checkout-api/pull/412",
      open: true,
    });
    expect(rows[1]?.change).toEqual({ words: "Not landed", url: null, open: false });
  });

  it("phone line: sessions or the one owner, the change or the base, and the age", () => {
    expect(rows.map((r) => phoneLine(r, "main", now))).toEqual([
      "2 sessions · Pull request #412 open · 4m",
      "Grace Hopper · Not landed · 20m",
      "No sessions yet · Not landed · 10h",
    ]);
    const [fromRelease] = worktreeRows(
      { worktrees: [worktree("grpc", 30, "release/2.4")], sessions: [], worktreeAnnotations: [] },
      [],
      new Set(),
      names,
      "ada",
    );
    if (fromRelease === undefined) throw new Error("expected a row");
    expect(phoneLine(fromRelease, "main", now)).toBe("No sessions yet · from release/2.4 · 30m");
  });
});

describe("lastActiveWords", () => {
  it("reads like the desktop column, with days spelled out", () => {
    expect(lastActiveWords(minutesAgo(0), now)).toBe("Just now");
    expect(lastActiveWords(minutesAgo(4), now)).toBe("4m ago");
    expect(lastActiveWords(minutesAgo(60 * 24), now)).toBe("1 day ago");
    expect(lastActiveWords(minutesAgo(60 * 24 * 3), now)).toBe("3 days ago");
  });
});
