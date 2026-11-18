import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import {
  activityDetail,
  age,
  askDetail,
  DEFAULT_INBOX_FILTERS,
  groupRows,
  inboxRows,
  type InboxMark,
  matchesFilters,
  rowStatus,
  sharedWith,
} from "./inbox.ts";
import { parseInboxFilters, parseInboxFolds } from "./ui-prefs.ts";

const now = new Date("2026-11-18T14:00:00");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const DAYS = 24 * 60;

type Status = SessionInboxRowDto["session"]["status"];

const row = (
  id: string,
  status: Status,
  extra: {
    readonly updated?: Date;
    readonly owner?: string;
    readonly project?: string;
    readonly worktree?: string;
    readonly change?: {
      readonly id: string;
      readonly comments?: number;
      readonly followUp?: boolean;
      /** How many files the server counted; unset is a change it hasn't counted. */
      readonly files?: number;
    };
    readonly ask?: SessionInboxRowDto["ask"];
    readonly imported?: boolean;
    readonly activity?: SessionInboxRowDto["activity"];
  } = {},
): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make(extra.project ?? "web"),
    worktreeId: WorktreeId.make(extra.worktree ?? `wt-${id}`),
    harness: "codex",
    label: null,
    branch: `mend/${id}`,
    status,
    ownerUserId: extra.owner ?? "ada",
    sharedControlEnabledAt: null,
    startedAt: minutesAgo(30),
    settledAt: null,
    createdAt: minutesAgo(30),
    updatedAt: extra.updated ?? minutesAgo(5),
    importedConversationWaiting: extra.imported ?? false,
  },
  projectName: extra.project ?? "web",
  title: `Session ${id}`,
  annotation:
    extra.change === undefined
      ? null
      : {
          changeId: ChangeId.make(extra.change.id),
          totalComments: extra.change.comments ?? 0,
          pendingFollowUp: extra.change.followUp ?? false,
          liveServices: 0,
          currentAgent: null,
          fileCount: extra.change.files ?? null,
        },
  ask: extra.ask ?? null,
  worktreeName: null,
  failure: null,
  activity: extra.activity ?? null,
});

const place = (
  rows: ReadonlyArray<SessionInboxRowDto>,
  options: { readonly marks?: ReadonlyArray<InboxMark> } = {},
) =>
  Object.fromEntries(
    inboxRows({ rows, marks: options.marks ?? [], now }).map((each) => [
      each.session.id,
      each.group,
    ]),
  );

describe("the inbox's groups", () => {
  it("puts a waiting session under Waiting on you, a live one under Running, an ended change with files under To review", () => {
    expect(
      place([
        row("asks", "waiting"),
        row("works", "running"),
        row("starts", "starting"),
        row("saves", "stopping"),
        row("ended", "completed", { change: { id: "c-ended", files: 2 } }),
      ]),
    ).toEqual({
      asks: "waiting",
      works: "running",
      starts: "running",
      saves: "running",
      ended: "review",
    });
  });

  it("puts a finished, stopped or failed session under To review when it changed files, and under Done when it changed none", () => {
    expect(
      place([
        row("completed-files", "completed", { change: { id: "c-1", files: 3 } }),
        row("completed-none", "completed", { change: { id: "c-2", files: 0 } }),
        row("stopped-files", "stopped", { change: { id: "c-3", files: 1 } }),
        row("stopped-none", "stopped", { change: { id: "c-4", files: 0 } }),
        row("failed-files", "failed", { change: { id: "c-5", files: 1 } }),
        row("failed-none", "failed", { change: { id: "c-6", files: 0 } }),
      ]),
    ).toEqual({
      "completed-files": "review",
      "completed-none": "done",
      "stopped-files": "review",
      "stopped-none": "done",
      "failed-files": "review",
      "failed-none": "done",
    });
  });

  it("keeps an ended session whose files weren't counted under To review, so no change is hidden", () => {
    expect(place([row("uncounted", "stopped", { change: { id: "c-u" } })])).toEqual({
      uncounted: "review",
    });
  });

  it("says Failed in red", () => {
    const [failed] = inboxRows({
      rows: [row("failed", "failed", { change: { id: "c-f", files: 1 } })],
      marks: [],
      now,
    });
    if (failed === undefined) throw new Error("no failed row");
    expect(rowStatus(failed, now)).toEqual({ word: "Failed", failed: true });
  });

  it("files an ended session under Done once someone commented on its change, or it ended a week ago", () => {
    expect(
      place([
        row("commented", "completed", { change: { id: "c-1", comments: 2, files: 4 } }),
        row("old", "completed", { change: { id: "c-2", files: 4 }, updated: minutesAgo(8 * DAYS) }),
        row("nothing", "stopped"),
      ]),
    ).toEqual({ commented: "done", old: "done", nothing: "done" });
  });

  it("puts an Idle session with changed files under To review, one with none under Done, and one not yet counted under Running", () => {
    const rows = [
      row("changed", "idle", { change: { id: "c-changed", files: 3 } }),
      row("clean", "idle", { change: { id: "c-clean", files: 0 } }),
      row("uncounted", "idle", { change: { id: "c-uncounted" } }),
    ];
    expect(place(rows)).toEqual({ changed: "review", clean: "done", uncounted: "running" });
  });

  it("keeps a follow-up that wasn't sent under To review, and says so", () => {
    const [kept] = inboxRows({
      rows: [row("follow", "completed", { change: { id: "c-1", comments: 1, followUp: true } })],
      marks: [],
      now,
    });
    expect(kept?.group).toBe("review");
    if (kept === undefined) throw new Error("no row");
    expect(rowStatus(kept, now).word).toBe("Follow-up not sent");
  });

  it("lists one To review row per change, the newest session's", () => {
    expect(
      place([
        row("older", "completed", { change: { id: "shared", files: 1 }, updated: minutesAgo(20) }),
        row("newer", "completed", { change: { id: "shared", files: 1 }, updated: minutesAgo(2) }),
      ]),
    ).toEqual({ newer: "review", older: "done" });
  });

  it("follows the person's marks: done stays done, a snooze holds until its time, a kept session stays to review", () => {
    const marks: ReadonlyArray<InboxMark> = [
      { sessionId: "done", state: "settled", snoozedUntil: null, markedAt: minutesAgo(1) },
      { sessionId: "later", state: "snoozed", snoozedUntil: minutesAgo(-60), markedAt: now },
      { sessionId: "back", state: "snoozed", snoozedUntil: minutesAgo(1), markedAt: now },
      { sessionId: "kept", state: "inbox", snoozedUntil: null, markedAt: now },
    ];
    expect(
      place(
        [
          row("done", "waiting"),
          row("later", "running"),
          row("back", "running"),
          row("kept", "stopped"),
        ],
        { marks },
      ),
    ).toEqual({ done: "done", later: "snoozed", back: "running", kept: "review" });
  });

  it("says when a snoozed row comes back, and that a row marked done was marked by hand", () => {
    const rows = inboxRows({
      rows: [row("later", "running"), row("tomorrow", "running"), row("done", "waiting")],
      marks: [
        {
          sessionId: "later",
          state: "snoozed",
          snoozedUntil: new Date("2026-11-18T18:00:00"),
          markedAt: now,
        },
        {
          sessionId: "tomorrow",
          state: "snoozed",
          snoozedUntil: new Date("2026-11-19T09:00:00"),
          markedAt: now,
        },
        { sessionId: "done", state: "settled", snoozedUntil: null, markedAt: now },
      ],
      now,
    });
    const word = (id: string) => {
      const found = rows.find((each) => each.session.id === id);
      if (found === undefined) throw new Error(`no row ${id}`);
      return rowStatus(found, now).word;
    };
    expect(word("later")).toBe("Back today at 18:00");
    expect(word("tomorrow")).toBe("Back tomorrow at 09:00");
    expect(word("done")).toBe("Marked done");
  });
});

describe("the two filters", () => {
  const rows = inboxRows({
    rows: [
      row("mine-web", "running"),
      row("theirs-web", "running", { owner: "grace" }),
      row("mine-infra", "running", { project: "infra" }),
    ],
    marks: [],
    now,
  });
  const ids = (filters: Parameters<typeof matchesFilters>[1]) =>
    rows
      .filter((each) => matchesFilters(each, filters, "ada"))
      .map((each) => each.session.id)
      .toSorted();

  it("show only the person's own sessions in every project by default", () => {
    expect(ids(DEFAULT_INBOX_FILTERS)).toEqual(["mine-infra", "mine-web"]);
  });

  it("show everyone's in one project", () => {
    expect(ids({ projectId: "web", mine: false })).toEqual(["mine-web", "theirs-web"]);
  });

  it("count what they let through in each group", () => {
    const groups = groupRows(
      rows.filter((each) => matchesFilters(each, DEFAULT_INBOX_FILTERS, "ada")),
    );
    expect(groups.running).toHaveLength(2);
    expect(groups.waiting).toHaveLength(0);
  });
});

describe("a row's words", () => {
  it("says why a waiting session waits, naming what the agent named on a phone", () => {
    const [waiting] = inboxRows({
      rows: [row("asks", "waiting", { ask: { kind: "command", subject: "terraform apply" } })],
      marks: [],
      now,
    });
    if (waiting === undefined) throw new Error("no row");
    expect(rowStatus(waiting, now).word).toBe("Wants to run a command");
    expect(askDetail(waiting.ask)).toBe("Wants to run terraform apply");
    expect(askDetail({ kind: "question", subject: "Back off on a 409?" })).toBe(
      "Asked: Back off on a 409?",
    );
    expect(askDetail({ kind: "edit", subject: null })).toBe("Wants to edit a file");
  });

  it("says what a running agent is doing, naming what it named on a phone", () => {
    const [running] = inboxRows({
      rows: [row("works", "running", { activity: { kind: "command", subject: "pnpm test" } })],
      marks: [],
      now,
    });
    if (running === undefined) throw new Error("no row");
    expect(rowStatus(running, now).word).toBe("Running a command");
    expect(activityDetail({ kind: "command", subject: "pnpm test" })).toBe("Running pnpm test");
    expect(activityDetail({ kind: "edit", subject: null })).toBe("Editing files");
  });

  it("calls an imported session waiting for its first message that, whatever its status", () => {
    const [imported] = inboxRows({
      rows: [row("imported", "running", { imported: true })],
      marks: [],
      now,
    });
    if (imported === undefined) throw new Error("no row");
    expect(rowStatus(imported, now).word).toBe("Waiting for a first message");
  });

  it("says how long ago in the row's short form", () => {
    expect(age(new Date(now.getTime() - 59_000), now)).toBe("now");
    expect(age(minutesAgo(4), now)).toBe("4m");
    expect(age(minutesAgo(60), now)).toBe("1h");
    expect(age(minutesAgo(DAYS * 3 + 5), now)).toBe("3d");
  });

  it("counts the live sessions sharing a workspace, not the ones that ended there", () => {
    const rows = inboxRows({
      rows: [
        row("a", "running", { worktree: "shared" }),
        row("b", "waiting", { worktree: "shared" }),
        row("c", "completed", { worktree: "shared" }),
        row("alone", "running"),
      ],
      marks: [],
      now,
    });
    const shared = Object.fromEntries(
      rows.map((each) => [each.session.id, sharedWith(each, rows)]),
    );
    expect(shared).toEqual({ a: 2, b: 2, c: null, alone: null });
  });
});

describe("what this browser keeps", () => {
  it("reads back the filters it kept, and the default for anything else", () => {
    expect(parseInboxFilters({ projectId: "web", mine: false })).toEqual({
      projectId: "web",
      mine: false,
    });
    expect(parseInboxFilters({ projectId: 3 })).toEqual(DEFAULT_INBOX_FILTERS);
    expect(parseInboxFilters("garbage")).toEqual(DEFAULT_INBOX_FILTERS);
  });

  it("keeps each group's fold, and the default for a group it never folded", () => {
    expect(parseInboxFolds({ running: true, waiting: false, review: "yes" })).toEqual({
      waiting: false,
      review: true,
      running: true,
      snoozed: false,
      done: false,
    });
  });
});
