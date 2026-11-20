import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { groupRows, inboxRows, type InboxGroup } from "./inbox.ts";
import { type MoveState, movesBetween, NO_MOVES, placesOf, shownGroups } from "./sidebar-moves.ts";

const now = new Date("2026-11-20T12:00:00Z");

const row = (id: string, status: SessionInboxRowDto["session"]["status"]): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("web"),
    worktreeId: WorktreeId.make(`wt-${id}`),
    harness: "codex",
    label: null,
    branch: `mend/${id}`,
    status,
    ownerUserId: "ada",
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: now,
    settledAt: null,
    createdAt: now,
    updatedAt: new Date(now.getTime() - Number(id.replace(/\D/g, "")) * 60_000),
    importedConversationWaiting: false,
  },
  projectName: "web",
  title: id,
  annotation: null,
  ask: null,
  worktreeName: null,
  failure: null,
  activity: null,
});

const grouped = (rows: ReadonlyArray<SessionInboxRowDto>) =>
  groupRows(inboxRows({ rows, marks: [], now }));

const ids = (groups: ReturnType<typeof shownGroups>, group: InboxGroup): ReadonlyArray<string> =>
  groups[group].map(
    (each) => `${each.row.session.id}${each.phase === "still" ? "" : `:${each.phase}`}`,
  );

describe("rows moving between groups", () => {
  it("finds the rows that changed group, and not the ones that came or went", () => {
    const before = placesOf(grouped([row("s1", "running"), row("s2", "running")]));
    const after = grouped([row("s1", "waiting"), row("s3", "running")]);
    expect(movesBetween(before, after)).toEqual([{ id: "s1", from: "running", to: "waiting" }]);
  });

  it("keeps a row in the group it leaves, at its place, until it lands", () => {
    const after = grouped([row("s1", "running"), row("s2", "waiting"), row("s3", "running")]);
    const state: MoveState = {
      ...NO_MOVES,
      pending: new Map([["s2", { from: "running", to: "waiting", index: 1 }]]),
    };
    const shown = shownGroups(after, state, now.getTime());
    expect(ids(shown, "running")).toEqual(["s1", "s2", "s3"]);
    expect(ids(shown, "waiting")).toEqual([]);
  });

  it("closes the place a row left as its new one opens, and lights it there", () => {
    const after = grouped([row("s1", "running"), row("s2", "waiting"), row("s3", "running")]);
    const landed = after.waiting[0];
    if (landed === undefined) throw new Error("no row landed");
    const t = now.getTime();
    const state: MoveState = {
      ...NO_MOVES,
      leaving: [{ row: landed, group: "running", index: 1, until: t + 200 }],
      entering: new Map([["s2", t + 240]]),
      lit: new Map([["s2", t + 1_500]]),
    };
    const shown = shownGroups(after, state, t);
    expect(ids(shown, "running")).toEqual(["s1", "s2:leaving", "s3"]);
    expect(ids(shown, "waiting")).toEqual(["s2:entering"]);
    expect(shown.waiting[0]?.lit).toBe(true);
    // Once each time is over, the marks come off.
    const later = shownGroups(after, state, t + 2_000);
    expect(ids(later, "running")).toEqual(["s1", "s3"]);
    expect(ids(later, "waiting")).toEqual(["s2"]);
    expect(later.waiting[0]?.lit).toBe(false);
  });
});
