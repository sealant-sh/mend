import { ChangeId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionAnnotationDto, SessionDto, SessionInboxMarkDto } from "./api.ts";
import {
  askWords,
  DEFAULT_INBOX_FILTERS,
  groupRows,
  inboxRows,
  matchesFilters,
  needsYouCount,
  rowStatus,
  snoozeChoices,
  sourcesOfProject,
  whenAhead,
} from "./inbox.ts";

const projectId = ProjectId.make("inbox-test");
const project = { id: projectId, name: "mend" };
const now = new Date("2026-11-02T14:00:00");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const session = (
  id: string,
  status: SessionDto["status"],
  overrides: Partial<SessionDto> = {},
): SessionDto => ({
  id: SessionId.make(id),
  projectId,
  worktreeId: WorktreeId.make(`wt-${id}`),
  harness: "codex",
  purpose: null,
  model: null,
  effort: null,
  providerSessionId: null,
  historyRevision: 0,
  label: `Session ${id}`,
  worktree: `/store/worktrees/${id}`,
  branch: `mend/${id}`,
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: null,
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  boatKey: null,
  ownerUserId: "anna",
  origin: "mend",
  autoLand: null,
  sharedControlEnabledByUserId: null,
  sharedControlEnabledAt: null,
  sharedControlEverAt: null,
  livePeople: [],
  resourceStatusLines: [],
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  hasTranscript: null,
  idleStoppedAt: null,
  capturePending: null,
  capturePendingBytes: null,
  captureRefused: null,
  captureRegisteredAt: null,
  captureObservedAt: null,
  captureDrain: null,
  captureDrainRequestedAt: null,
  captureDrainProgressAt: null,
  captureNotSavedAt: null,
  captureIncompleteReason: null,
  captureIncompleteDetail: null,
  captureFailingSince: null,
  captureFailingError: null,
  captureOverdueStep: null,
  captureOverdueSince: null,
  captureOverdueRunningMs: null,
  captureOverdueBoundMs: null,
  captureDiscardedAt: null,
  captureDiscardedBy: null,
  executorStartedAt: null,
  removalRequestedAt: null,
  status,
  liveMark: 0,
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: true,
  startedAt: minutesAgo(6),
  settledAt: null,
  createdAt: minutesAgo(10),
  updatedAt: minutesAgo(1),
  ...overrides,
});

const annotation = (
  sessionId: string,
  overrides: Partial<SessionAnnotationDto> = {},
): SessionAnnotationDto => ({
  sessionId,
  changeId: ChangeId.make(`change-${sessionId}`),
  openComments: 0,
  totalComments: 0,
  pendingFollowUp: false,
  currentAgent: null,
  liveServices: 0,
  pullRequest: null,
  ...overrides,
});

const mark = (
  id: string,
  state: SessionInboxMarkDto["state"],
  snoozedUntil: Date | null = null,
): SessionInboxMarkDto => ({
  sessionId: SessionId.make(id),
  state,
  snoozedUntil,
  markedAt: minutesAgo(3),
});

const place = (
  sessions: ReadonlyArray<SessionDto>,
  annotations: ReadonlyArray<SessionAnnotationDto> = [],
  marks: ReadonlyArray<SessionInboxMarkDto> = [],
) =>
  inboxRows({
    sources: sourcesOfProject(project, { sessions, annotations, worktrees: [] }),
    marks,
    now,
  });

describe("inbox places", () => {
  it("puts a waiting session under Needs you, a live one under Running, a fresh change under Ready to review", () => {
    const groups = groupRows(
      place(
        [
          session("ask", "waiting"),
          session("run", "running"),
          session("done", "completed", { settledAt: minutesAgo(30) }),
        ],
        [annotation("done")],
      ),
    );
    expect(groups["needs-you"].map((row) => row.title)).toEqual(["Session ask"]);
    expect(groups.running.map((row) => row.title)).toEqual(["Session run"]);
    expect(groups.review.map((row) => row.title)).toEqual(["Session done"]);
    expect(groups.settled).toEqual([]);
  });

  it("settles an ended session with nothing to read, and a change someone already commented on", () => {
    const rows = place(
      [
        session("stopped", "stopped", { settledAt: minutesAgo(120) }),
        session("read", "completed", { settledAt: minutesAgo(60) }),
      ],
      [annotation("read", { totalComments: 2 })],
    );
    expect(rows.map((row) => [row.title, row.place, row.settledByHand])).toEqual([
      ["Session read", "settled", false],
      ["Session stopped", "settled", false],
    ]);
  });

  it("puts a stopped or failed session's unread change under Ready to review, as a completed one's", () => {
    const groups = groupRows(
      place(
        [
          session("stopped", "stopped", { updatedAt: minutesAgo(20) }),
          session("idle-stopped", "stopped", { updatedAt: minutesAgo(15) }),
          session("failed", "failed", { updatedAt: minutesAgo(10) }),
        ],
        [annotation("stopped"), annotation("idle-stopped"), annotation("failed")],
      ),
    );
    expect(groups.review.map((row) => row.title)).toEqual([
      "Session failed",
      "Session idle-stopped",
      "Session stopped",
    ]);
    expect(groups.settled).toEqual([]);
  });

  it("settles an unread change on its own a week after its session ended", () => {
    const week = 7 * 24 * 60;
    const rows = place(
      [
        session("this-week", "stopped", { updatedAt: minutesAgo(week - 1) }),
        session("last-week", "stopped", { updatedAt: minutesAgo(week + 1) }),
      ],
      [annotation("this-week"), annotation("last-week")],
    );
    expect(rows.map((row) => [row.title, row.place])).toEqual([
      ["Session this-week", "review"],
      ["Session last-week", "settled"],
    ]);
  });

  it("keeps a review follow-up that was not sent under Ready to review", () => {
    const [row] = place(
      [session("follow", "completed")],
      [annotation("follow", { totalComments: 1, pendingFollowUp: true })],
    );
    expect(row?.place).toBe("review");
    expect(row === undefined ? null : rowStatus(row, now)).toEqual({
      tone: "wait",
      word: "follow-up not sent",
    });
  });

  it("lists one review row per change, the newest session's", () => {
    const shared = ChangeId.make("one-change");
    const rows = place(
      [
        session("older", "completed", { updatedAt: minutesAgo(40) }),
        session("newer", "completed", { updatedAt: minutesAgo(5) }),
      ],
      [annotation("older", { changeId: shared }), annotation("newer", { changeId: shared })],
    );
    expect(rows.filter((row) => row.place === "review").map((row) => row.title)).toEqual([
      "Session newer",
    ]);
  });

  it("follows the person's marks: settled stays settled, a snooze holds until its time", () => {
    const until = new Date(now.getTime() + 2 * 60 * 60_000);
    const rows = place(
      [session("ask", "waiting"), session("run", "running"), session("over", "waiting")],
      [],
      [
        mark("ask", "snoozed", until),
        mark("run", "settled"),
        mark("over", "snoozed", minutesAgo(1)),
      ],
    );
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get("Session ask")?.place).toBe("snoozed");
    expect(byTitle.get("Session run")?.place).toBe("settled");
    expect(byTitle.get("Session run")?.settledByHand).toBe(true);
    expect(byTitle.get("Session over")?.place).toBe("needs-you");
  });

  it("keeps a session the person returned to the inbox, though its status would settle it", () => {
    const sessions = [
      session("stopped", "stopped", { settledAt: minutesAgo(90) }),
      session("read", "completed", { settledAt: minutesAgo(60) }),
    ];
    const notes = [annotation("read", { totalComments: 2 })];
    expect(place(sessions, notes).map((row) => row.place)).toEqual(["settled", "settled"]);
    const kept = place(sessions, notes, [mark("stopped", "inbox"), mark("read", "inbox")]);
    expect(
      kept.toSorted((a, b) => a.title.localeCompare(b.title)).map((row) => [row.title, row.place]),
    ).toEqual([
      ["Session read", "review"],
      ["Session stopped", "review"],
    ]);
    const stopped = kept.find((row) => row.title === "Session stopped");
    expect(stopped === undefined ? null : rowStatus(stopped, now)).toEqual({
      tone: "off",
      word: "stopped",
    });
  });
});

describe("inbox filters", () => {
  const [mine, theirs] = place([
    session("mine", "running"),
    session("theirs", "running", { ownerUserId: "ben", harness: "claude" }),
  ]);

  it("shows only the viewer's own sessions by default", () => {
    if (mine === undefined || theirs === undefined) throw new Error("two rows expected");
    expect(matchesFilters(mine, DEFAULT_INBOX_FILTERS, "anna")).toBe(true);
    expect(matchesFilters(theirs, DEFAULT_INBOX_FILTERS, "anna")).toBe(false);
    const anyone = { ...DEFAULT_INBOX_FILTERS, startedBy: "anyone" as const };
    expect(matchesFilters(theirs, anyone, "anna")).toBe(true);
    expect(matchesFilters(theirs, { ...anyone, agent: "codex" }, "anna")).toBe(false);
    expect(matchesFilters(theirs, { ...anyone, projectIds: ["elsewhere"] }, "anna")).toBe(false);
  });
});

describe("needsYouCount", () => {
  it("counts waiting sessions the person has not snoozed or settled", () => {
    const active = [session("a", "waiting"), session("b", "waiting"), session("c", "running")];
    expect(
      needsYouCount(
        active,
        [mark("a", "snoozed", new Date(now.getTime() + 60_000)), mark("b", "inbox")],
        now,
      ),
    ).toBe(1);
  });
});

const labels = (at: Date) => snoozeChoices(at).map((choice) => choice.label);

describe("snooze times", () => {
  it("names the end of a snooze by the clock, the next day, or the weekday", () => {
    expect(whenAhead(new Date("2026-11-02T16:00:00"), now)).toBe("16:00");
    expect(whenAhead(new Date("2026-11-03T09:00:00"), now)).toBe("tomorrow 09:00");
  });

  it("offers this evening only while it is more than an hour away, and next week starts Monday", () => {
    expect(labels(now)).toEqual(["In an hour", "This evening", "Tomorrow morning", "Next week"]);
    expect(labels(new Date("2026-11-02T17:30:00"))).not.toContain("This evening");
    const nextWeek = snoozeChoices(now).at(-1)?.until;
    expect(nextWeek?.getDay()).toBe(1);
    expect(nextWeek?.getDate()).toBe(9);
  });
});

describe("why a waiting session waits, in the row's words", () => {
  it("says what the agent asked for, and only what it named", () => {
    expect(askWords({ kind: "question", subject: "Which cap?" })).toBe("asked a question");
    expect(askWords({ kind: "command", subject: "pnpm test" })).toBe("wants to run pnpm test");
    expect(askWords({ kind: "edit", subject: "worker/retry.ts" })).toBe(
      "wants to edit worker/retry.ts",
    );
    expect(askWords({ kind: "edit", subject: null })).toBe("wants to edit files");
    expect(askWords({ kind: "tool", subject: "WebFetch" })).toBe("wants to use WebFetch");
    expect(askWords({ kind: "decision", subject: null })).toBe("waiting for input");
    expect(askWords(null)).toBe("waiting for input");
  });

  it("is the status a Needs you row shows", () => {
    const [row] = inboxRows({
      sources: [
        {
          session: session("ask", "waiting"),
          project,
          annotation: undefined,
          title: "Ask",
          ask: { kind: "command", subject: "pnpm test" },
        },
      ],
      marks: [],
      now,
    });
    expect(row === undefined ? null : rowStatus(row, now)).toEqual({
      tone: "wait",
      word: "wants to run pnpm test",
    });
  });
});
