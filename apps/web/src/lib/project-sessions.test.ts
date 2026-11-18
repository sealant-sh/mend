import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { inboxRows } from "./inbox.ts";
import {
  filterChoices,
  filterWords,
  highlightParts,
  matchesSessionFilters,
  matchLine,
  parseProjectSessionsSearch,
  projectSessionRows,
  worktreeChoices,
  worktreeLiveWords,
} from "./project-sessions.ts";
import { worktreeJoin, worktreeJoinLine } from "./shared-workspace.ts";

const now = new Date("2026-11-18T14:00:00");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

type Status = SessionInboxRowDto["session"]["status"];

const session = (
  id: string,
  status: Status,
  extra: { readonly owner?: string; readonly worktree?: string; readonly updated?: Date } = {},
) => ({
  id: SessionId.make(id),
  label: null,
  harness: "claude",
  status,
  worktreeId: WorktreeId.make(extra.worktree ?? `wt-${id}`),
  branch: `mend/${extra.worktree ?? id}`,
  model: "claude-opus-4-5",
  ownerUserId: extra.owner ?? "ada",
  updatedAt: extra.updated ?? minutesAgo(5),
});

const inboxRow = (
  id: string,
  status: Status,
  extra: { readonly files?: number; readonly title?: string } = {},
): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("checkout-api"),
    worktreeId: WorktreeId.make(`wt-${id}`),
    harness: "claude",
    label: null,
    branch: `mend/${id}`,
    status,
    ownerUserId: "ada",
    sharedControlEnabledAt: null,
    startedAt: minutesAgo(30),
    settledAt: null,
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(4),
    importedConversationWaiting: false,
  },
  projectName: "checkout-api",
  title: extra.title ?? `Session ${id}`,
  annotation: {
    changeId: ChangeId.make(`change-${id}`),
    totalComments: 0,
    pendingFollowUp: false,
    liveServices: 0,
    currentAgent: null,
    fileCount: extra.files ?? null,
  },
  ask: null,
  worktreeName: `${id}-tree`,
  failure: null,
  activity: null,
});

const worktree = (id: string, handoff: string | null = null) => ({
  id: `wt-${id}`,
  name: id,
  handoff: handoff === null ? null : { machine: handoff },
});

describe("a project's Sessions tab", () => {
  it("lists every session, naming the ones the inbox carries in its words", () => {
    const rows = projectSessionRows(
      {
        sessions: [
          session("fix", "waiting"),
          session("old", "completed", { updated: minutesAgo(9 * 24 * 60) }),
        ],
        worktrees: [worktree("fix"), worktree("old", "ada-laptop")],
        annotations: [{ sessionId: "old", changeId: "change-old" }],
      },
      inboxRows({
        rows: [inboxRow("fix", "waiting", { title: "Fix flaky checkout retry" })],
        marks: [],
        now,
      }),
      now,
    );
    expect(rows.map((row) => [row.title, row.status.word, row.status.tone, row.open])).toEqual([
      ["Fix flaky checkout retry", "Waiting on you", "wait", true],
      ["claude session old", "Completed", "ok", false],
    ]);
    expect(rows[0]?.worktree).toBe("fix-tree");
    expect(rows[1]).toMatchObject({
      worktree: "old",
      changeId: "change-old",
      handedOffFrom: "ada-laptop",
      model: "claude-opus-4-5",
    });
  });

  it("keeps an ended session with files open, for review, and files one with none as stopped", () => {
    const rows = projectSessionRows(
      {
        sessions: [session("files", "completed"), session("none", "completed")],
        worktrees: [],
        annotations: [],
      },
      inboxRows({
        rows: [
          inboxRow("files", "completed", { files: 3 }),
          inboxRow("none", "failed", { files: 0 }),
        ],
        marks: [],
        now,
      }),
      now,
    );
    expect(rows.map((row) => [row.id, row.open])).toEqual([
      ["files", true],
      ["none", false],
    ]);
    expect(rows[1]?.status).toEqual({ word: "Failed", tone: "bad" });
  });

  it("reads its filters from the address and drops what it doesn't know", () => {
    expect(
      parseProjectSessionsSearch({
        q: "retry",
        who: "mine",
        show: "stopped",
        agent: "codex",
        branch: "",
        page: 2,
      }),
    ).toEqual({ q: "retry", who: "mine", show: "stopped", agent: "codex" });
    expect(parseProjectSessionsSearch({ who: "everyone", show: "open", q: "  " })).toEqual({});
  });

  it("filters by who started it, agent, branch and every word searched", () => {
    const [row] = projectSessionRows(
      {
        sessions: [session("retry", "running", { owner: "grace" })],
        worktrees: [],
        annotations: [],
      },
      [],
      now,
    );
    if (row === undefined) throw new Error("no row");
    expect(matchesSessionFilters(row, {}, "ada")).toBe(true);
    expect(matchesSessionFilters(row, { who: "mine" }, "ada")).toBe(false);
    expect(matchesSessionFilters(row, { who: "mine" }, "grace")).toBe(true);
    expect(matchesSessionFilters(row, { agent: "codex" }, "ada")).toBe(false);
    expect(matchesSessionFilters(row, { branch: "mend/retry" }, "ada")).toBe(true);
    expect(matchesSessionFilters(row, { q: "RETRY claude" }, "ada")).toBe(true);
    expect(matchesSessionFilters(row, { q: "retry webhook" }, "ada")).toBe(false);
  });

  it("offers the agents and branches the sessions used, and says what is picked", () => {
    expect(
      filterChoices([
        { agent: "codex", branch: "mend/b" },
        { agent: "claude", branch: "mend/a" },
        { agent: "codex", branch: "mend/a" },
      ]),
    ).toEqual({ agents: ["claude", "codex"], branches: ["mend/a", "mend/b"] });
    expect(filterWords({})).toBe("Any agent · Any branch");
    expect(filterWords({ agent: "codex" })).toBe("codex · Any branch");
  });

  it("says how many match only when something narrows the list", () => {
    expect(matchLine(6, 6, {})).toBeNull();
    expect(matchLine(6, 6, { show: "stopped" })).toBeNull();
    expect(matchLine(3, 6, { q: "retry" })).toBe('3 of 6 open sessions match "retry".');
    expect(matchLine(1, 4, { who: "mine", show: "stopped" })).toBe(
      "1 of 4 stopped sessions matches these filters.",
    );
  });

  it("sets the searched words apart in a title", () => {
    expect(highlightParts("Retry webhooks with retry", "retry")).toEqual([
      { text: "Retry", match: true },
      { text: " webhooks with ", match: false },
      { text: "retry", match: true },
    ]);
    expect(highlightParts("Bump Stripe", undefined)).toEqual([
      { text: "Bump Stripe", match: false },
    ]);
  });

  it("lists worktrees newest first, with how many of their sessions run", () => {
    const choices = worktreeChoices({
      sessions: [
        { worktreeId: "a", status: "running" },
        { worktreeId: "a", status: "idle" },
        { worktreeId: "b", status: "completed" },
      ],
      worktrees: [
        { id: "b", name: "b", branch: "mend/b", updatedAt: minutesAgo(1) },
        { id: "a", name: "a", branch: "mend/a", updatedAt: minutesAgo(60) },
      ],
    });
    expect(choices.map((choice) => [choice.id, worktreeLiveWords(choice.live)])).toEqual([
      ["b", "Stopped"],
      ["a", "2 sessions"],
    ]);
  });
});

/** A live session in worktree `wt`, owned by `owner`, with `people` live in its executor. */
const live = (owner: string, people: ReadonlyArray<string> = []) => ({
  worktreeId: "wt",
  ownerUserId: owner,
  status: "running",
  livePeople: people.map((name) => ({ accountId: name.toLowerCase(), name })),
});

describe("the join line", () => {
  it("says nothing when only the viewer's sessions run there", () => {
    expect(worktreeJoinLine([live("ada")], "wt", "ada")).toBeNull();
    expect(worktreeJoinLine([{ ...live("grace"), status: "completed" }], "wt", "ada")).toBeNull();
  });

  it("names the others where each runs as themselves", () => {
    expect(worktreeJoin([live("grace", ["Grace", "Ada"])], "wt", "ada")).toEqual({
      kind: "per-person",
      names: ["Grace"],
    });
    expect(worktreeJoinLine([live("grace", ["Grace"])], "wt", "ada")).toContain(
      "Grace's session is running in this worktree.",
    );
  });

  it("warns that a shared home runs on the starter's logins", () => {
    expect(worktreeJoin([live("grace")], "wt", "ada")).toEqual({ kind: "shared-home" });
  });
});
