import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { MutationObserver, QueryClient, queryOptions } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { inboxRows } from "./inbox.ts";
import {
  labelOf,
  labelsWriter,
  markBefore,
  refusedWords,
  rowActions,
  snoozeChoices,
} from "./row-actions.ts";

const now = new Date("2026-11-18T14:00:00"); // a Wednesday

const session = (
  id: string,
  status: SessionInboxRowDto["session"]["status"],
  extra: { readonly owner?: string; readonly label?: string | null } = {},
): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("web"),
    worktreeId: WorktreeId.make(`wt-${id}`),
    harness: "codex",
    label: extra.label ?? null,
    branch: `mend/${id}`,
    status,
    ownerUserId: extra.owner ?? "ada",
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: now,
    settledAt: null,
    createdAt: now,
    updatedAt: now,
    importedConversationWaiting: false,
  },
  projectName: "web",
  title: extra.label ?? `fix-${id}`,
  annotation: null,
  ask: null,
  worktreeName: `fix-${id}`,
});

const labels = (at: Date) => snoozeChoices(at).map((choice) => choice.label);
const nextWeek = (at: Date) => snoozeChoices(at).at(-1)?.until;

describe("snooze choices", () => {
  it("offers this evening only while it is more than an hour off, and next week from Monday 09:00", () => {
    expect(labels(now)).toEqual(["In an hour", "This evening", "Tomorrow morning", "Next week"]);
    expect(labels(new Date("2026-11-18T17:30:00"))).toEqual([
      "In an hour",
      "Tomorrow morning",
      "Next week",
    ]);
    expect(nextWeek(now)).toEqual(new Date("2026-11-23T09:00:00"));
    // On a Monday, next week is the Monday after, not today.
    expect(nextWeek(new Date("2026-11-23T08:00:00"))).toEqual(new Date("2026-11-30T09:00:00"));
  });
});

describe("undo", () => {
  it("puts back the mark the change replaced", () => {
    const later = new Date("2026-11-19T09:00:00");
    const marks = [
      { sessionId: SessionId.make("done"), state: "settled" as const, snoozedUntil: null },
      { sessionId: SessionId.make("later"), state: "snoozed" as const, snoozedUntil: later },
      {
        sessionId: SessionId.make("over"),
        state: "snoozed" as const,
        snoozedUntil: new Date("2026-11-18T13:00:00"),
      },
    ];
    expect(markBefore(marks, "done", now)).toEqual({ _tag: "Settled" });
    expect(markBefore(marks, "later", now)).toEqual({ _tag: "Snoozed", until: later });
    // A snooze that is over, or no mark, puts the session back where its status places it.
    expect(markBefore(marks, "over", now)).toEqual({ _tag: "Inbox" });
    expect(markBefore(marks, "unmarked", now)).toEqual({ _tag: "Inbox" });
  });
});

describe("a row's menu", () => {
  it("offers what fits the row's group, and Rename and Stop only to the session's owner", () => {
    const [running, markedDone, ended] = ["running", "marked", "ended"].map((id) => {
      const [placed] = inboxRows({
        rows: [session(id, id === "running" ? "running" : "completed")],
        marks:
          id === "marked"
            ? [{ sessionId: "marked", state: "settled", snoozedUntil: null, markedAt: now }]
            : [],
        now,
      });
      if (placed === undefined) throw new Error("no row");
      return placed;
    });
    if (running === undefined || markedDone === undefined || ended === undefined)
      throw new Error("no rows");
    // Running: no Snooze and no Mark done while the agent works; Stop session… instead.
    expect(rowActions(running, "ada")).toEqual({
      snooze: false,
      unsnooze: false,
      markDone: false,
      markNotDone: false,
      stop: true,
      rename: true,
    });
    expect(rowActions(running, "grace")).toMatchObject({ rename: false, stop: false });
    // Marked done by hand: it can be taken back out of Done.
    expect(rowActions(markedDone, "ada")).toMatchObject({ markDone: false, markNotDone: true });
    // Done because the session ended with nothing changed: no mark to take back.
    expect(ended.group).toBe("done");
    expect(rowActions(ended, "ada")).toMatchObject({
      snooze: false,
      markDone: false,
      markNotDone: false,
      stop: false,
    });
  });
});

describe("renaming", () => {
  it("trims a name, and an empty one clears the label", () => {
    expect(labelOf("  Upgrade to React Router 8 ")).toBe("Upgrade to React Router 8");
    expect(labelOf("   ")).toBeNull();
  });

  it("keeps the server's title when the rename is refused, and shows the worktree's name once a label is cleared", async () => {
    const queryClient = new QueryClient();
    const key = queryOptions<ReadonlyArray<SessionInboxRowDto>>({ queryKey: ["inbox"] }).queryKey;
    queryClient.setQueryData(key, [session("a", "running", { label: "Old name" })]);
    let refuse = true;
    const options = labelsWriter.options({
      queryClient,
      documentKey: key,
      mutationKey: ["setLabel"],
      send: () =>
        refuse
          ? Promise.reject(new Error("Only the session's owner can rename it."))
          : Promise.resolve(null),
    });
    const title = () => queryClient.getQueryData(key)?.[0]?.title;

    const refused = await new MutationObserver(queryClient, options)
      .mutate({ id: SessionId.make("a"), label: "New name" })
      .then(
        () => "saved",
        () => "refused",
      );
    expect(refused).toBe("refused");
    expect(title()).toBe("Old name");
    expect(labelsWriter.pending(queryClient)).toEqual([]);

    refuse = false;
    await new MutationObserver(queryClient, options).mutate({
      id: SessionId.make("a"),
      label: null,
    });
    expect(title()).toBe("fix-a");
  });

  it("says why a change was refused, in a sentence", () => {
    expect(refusedWords("rename", "fix-a", new Error("Only the owner can rename it"))).toBe(
      'Couldn\'t rename "fix-a". Only the owner can rename it.',
    );
    expect(refusedWords("snooze", "fix-a", new Error(""))).toBe(
      'Couldn\'t snooze "fix-a". Try again.',
    );
  });
});
