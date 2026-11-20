import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import {
  groupRows,
  inboxRows,
  type InboxMark,
  type InboxRow,
  isAlive,
  rowLump,
  rowStatus,
  statusWord,
} from "./inbox.ts";
import { projectSessionRows } from "./project-sessions.ts";
import { rowActions } from "./row-actions.ts";

/**
 * The session states model (SLNT-1199) as properties over every combination of a session's facts
 * and the person's mark: the groups follow the session's life, not the agent's turn (Yiannis,
 * 20 Nov 2026). Each `it` is one rule; fast-check looks for sessions that break it.
 */

const now = new Date("2026-11-20T12:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
/** A time within ten days either side of now, by the minute. */
const time = fc.integer({ min: -10 * 24 * 60, max: 10 * 24 * 60 }).map(at);
/** A time in the past. */
const past = fc.integer({ min: -10 * 24 * 60, max: 0 }).map(at);
/** True now and then. */
const rarely = fc.constantFrom(false, false, false, false, true);

const STATUSES = [
  "starting",
  "running",
  "waiting",
  "idle",
  "stopping",
  "completed",
  "failed",
  "stopped",
] as const satisfies ReadonlyArray<SessionInboxRowDto["session"]["status"]>;

const facts = fc.record({
  status: fc.constantFrom(...STATUSES),
  turnOpen: fc.option(fc.boolean(), { nil: undefined }),
  activity: fc.option(
    fc.record({
      kind: fc.constantFrom("command", "edit", "thinking", "writing"),
      subject: fc.constant(null),
    }),
    { nil: null },
  ),
  ask: fc.option(
    fc.record({ kind: fc.constantFrom("question", "command", "edit"), subject: fc.constant(null) }),
    { nil: null },
  ),
  imported: rarely,
  askers: fc.array(past, { maxLength: 2 }),
  annotation: fc.option(
    fc.record({
      // A small pool, so sessions share changes.
      change: fc.option(fc.constantFrom("c-1" as const, "c-2" as const, "c-3" as const), {
        nil: null,
      }),
      comments: fc.constantFrom(0, 0, 1),
      followUp: rarely,
      files: fc.option(fc.constantFrom(0, 1, 4), { nil: null }),
      pullRequest: fc.option(fc.constantFrom("open", "merged", "closed"), { nil: null }),
    }),
    { nil: null },
  ),
  updatedAt: past,
  lastNewAt: fc.option(fc.option(past, { nil: null }), { nil: undefined }),
  label: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  owner: fc.constantFrom("ada", "grace"),
  mark: fc.option(
    fc.record({
      state: fc.constantFrom("settled", "snoozed", "inbox"),
      until: time,
      markedAt: past,
    }),
    { nil: null },
  ),
});

type Facts = typeof facts extends fc.Arbitrary<infer T> ? T : never;

const rowOf = (id: string, f: Facts): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("web"),
    worktreeId: WorktreeId.make(`wt-${f.annotation?.change ?? id}`),
    harness: "codex",
    label: f.label,
    branch: `mend/${id}`,
    status: f.status,
    ownerUserId: f.owner,
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: at(-11 * 24 * 60),
    settledAt: isAlive(f.status) ? null : f.updatedAt,
    createdAt: at(-11 * 24 * 60),
    updatedAt: f.updatedAt,
    importedConversationWaiting: f.imported,
  },
  projectName: "web",
  title: f.label ?? `Session ${id}`,
  annotation:
    f.annotation === null
      ? null
      : {
          changeId: f.annotation.change === null ? null : ChangeId.make(f.annotation.change),
          totalComments: f.annotation.comments,
          pendingFollowUp: f.annotation.followUp,
          liveServices: 0,
          currentAgent: { kind: "agent-protocol" },
          fileCount: f.annotation.files,
          pullRequestState: f.annotation.pullRequest,
        },
  ask: f.status === "waiting" ? f.ask : null,
  worktreeName: null,
  failure: null,
  activity: f.activity,
  ...(f.turnOpen === undefined ? {} : { turnOpen: f.turnOpen }),
  ...(f.lastNewAt === undefined ? {} : { lastNewAt: f.lastNewAt }),
  sharedControlAsks: f.askers.map((askedAt, index) => ({
    userId: `asker-${index}`,
    state: "asked" as const,
    askedAt,
    grantedAt: null,
    grantedByUserId: null,
  })),
});

const markOf = (id: string, f: Facts): ReadonlyArray<InboxMark> =>
  f.mark === null
    ? []
    : [
        {
          sessionId: id,
          state: f.mark.state,
          snoozedUntil: f.mark.state === "snoozed" ? f.mark.until : null,
          markedAt: f.mark.markedAt,
        },
      ];

/** A change's own facts, which every session of the change carries alike. */
const changeFacts = fc.record({
  comments: fc.constantFrom(0, 0, 1),
  followUp: rarely,
  files: fc.option(fc.constantFrom(0, 1, 4), { nil: null }),
  pullRequest: fc.option(fc.constantFrom("open", "merged", "closed"), { nil: null }),
});

/**
 * Several sessions, each with its facts and the person's mark on it. Sessions of one change
 * share its facts, as the server's annotation does.
 */
const inbox = fc
  .record({
    list: fc.array(facts, { minLength: 1, maxLength: 8 }),
    changes: fc.record({ "c-1": changeFacts, "c-2": changeFacts, "c-3": changeFacts }),
  })
  .map(({ list, changes }) => {
    const shared = list.map(
      (f): Facts =>
        f.annotation?.change == null
          ? f
          : { ...f, annotation: { ...changes[f.annotation.change], change: f.annotation.change } },
    );
    return {
      list: shared,
      rows: shared.map((f, index) => rowOf(`s-${index}`, f)),
      marks: shared.flatMap((f, index) => markOf(`s-${index}`, f)),
    };
  });

const placed = (
  rows: ReadonlyArray<SessionInboxRowDto>,
  marks: ReadonlyArray<InboxMark>,
  when: Date = now,
): ReadonlyMap<string, InboxRow> =>
  new Map(inboxRows({ rows, marks, now: when }).map((row) => [row.session.id, row]));

const get = (rows: ReadonlyMap<string, InboxRow>, id: string): InboxRow => {
  const row = rows.get(id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

/** The session asks the person something: the agent, an imported conversation, or a teammate. */
const asks = (row: SessionInboxRowDto) =>
  row.session.status === "waiting" ||
  row.session.importedConversationWaiting ||
  ((row.sharedControlAsks ?? []).length > 0 && isAlive(row.session.status));

/** When something new last happened, as a mark sees it. */
const newest = (row: SessionInboxRowDto): number =>
  Math.max(
    row.lastNewAt?.getTime() ?? -Infinity,
    ...(row.sharedControlAsks ?? []).map((ask) => ask.askedAt.getTime()),
  );

const RUN_WORDS = new Set([
  "Starting",
  "Saving",
  "Running",
  "Running a command",
  "Editing files",
  "Thinking",
  "Writing a reply",
]);
const ENDED_WORDS = new Set(["Completed", "Failed", "Stopped"]);

const RUNS = { numRuns: 400 };

describe("the session states model, as properties", () => {
  it("puts every session in exactly one group, and each group counts its rows", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        const out = inboxRows({ rows, marks, now });
        expect(out.map((row) => row.session.id).toSorted()).toEqual(
          rows.map((row) => row.session.id).toSorted(),
        );
        const groups = groupRows(out);
        expect(Object.values(groups).reduce((sum, list) => sum + list.length, 0)).toBe(rows.length);
      }),
      RUNS,
    );
  });

  it("keeps a live session out of Done and To review, and in Running unless it asks", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        const out = placed(rows, marks);
        for (const row of rows) {
          if (!isAlive(row.session.status)) continue;
          const group = get(out, row.session.id).group;
          expect(["done", "review"]).not.toContain(group);
          if (!asks(row)) expect(group).toBe("running");
          // Snoozed only while it asks: Snooze is offered in Waiting on you, never in Running.
          if (group === "snoozed") expect(asks(row)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("brings a session that asks something new to Waiting on you, whatever was marked before", () => {
    fc.assert(
      fc.property(inbox, ({ list, rows, marks }) => {
        const out = placed(rows, marks);
        rows.forEach((row, index) => {
          const mark = list[index]?.mark ?? null;
          const askedSinceMark = mark === null || newest(row) > mark.markedAt.getTime();
          if (asks(row) && askedSinceMark) expect(get(out, row.session.id).group).toBe("waiting");
        });
      }),
      RUNS,
    );
  });

  it("never lets a mark outlive a new run or question: an older mark changes nothing", () => {
    fc.assert(
      fc.property(inbox, ({ list, rows, marks }) => {
        const withMarks = placed(rows, marks);
        const without = placed(rows, []);
        rows.forEach((row, index) => {
          const mark = list[index]?.mark ?? null;
          if (mark !== null && mark.markedAt.getTime() < newest(row))
            expect(get(withMarks, row.session.id).group).toBe(get(without, row.session.id).group);
        });
      }),
      RUNS,
    );
  });

  it("says the same word in the sidebar and the project's table, marks or not", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        const sidebar = placed(rows, marks);
        const table = projectSessionRows(
          {
            sessions: rows.map((row) => ({ ...row.session, model: null })),
            worktrees: [],
            annotations: [],
          },
          inboxRows({ rows, marks: [], now }),
        );
        for (const row of table) {
          const shown = get(sidebar, row.id);
          expect(statusWord(shown).word).toBe(row.status.word);
          // The row says that word too, except a snoozed row, which says when it comes back.
          if (shown.group !== "snoozed") expect(rowStatus(shown, now).word).toBe(row.status.word);
        }
      }),
      RUNS,
    );
  });

  it("keeps each group's words in step: no run words outside Running, no ending in it, no Marked done or Idle", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        for (const row of placed(rows, marks).values()) {
          const { word } = rowStatus(row, now);
          if (row.group !== "running") expect(RUN_WORDS.has(word)).toBe(false);
          if (row.group === "running") expect(ENDED_WORDS.has(word)).toBe(false);
          expect(word).not.toBe("Marked done");
          expect(word).not.toBe("Idle");
        }
      }),
      RUNS,
    );
  });

  it("draws a glyph whose shape agrees with the group", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        for (const row of placed(rows, marks).values()) {
          const lump = rowLump(row);
          // The amber point exactly in Waiting on you; the kneading shape only in Running.
          expect(lump === "wait").toBe(row.group === "waiting");
          if (lump === "run") expect(row.group).toBe("running");
          if (row.group === "running") expect(["run", "idle"]).toContain(lump);
          if (row.group === "review" || row.group === "done")
            expect(["done", "fail", "stop"]).toContain(lump);
          if (row.group === "snoozed") expect(["done", "fail", "stop", "idle"]).toContain(lump);
          // In Running, the plain dome is a session that replied.
          if (row.group === "running" && lump === "idle")
            expect(rowStatus(row, now).word).toBe("Replied");
        }
      }),
      RUNS,
    );
  });

  it("offers Mark done only once the session has ended, Snooze only in Waiting on you and To review, Stop only while it runs", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        for (const row of placed(rows, marks).values()) {
          const actions = rowActions(row, row.session.ownerUserId);
          if (actions.markDone) {
            expect(isAlive(row.session.status)).toBe(false);
            expect(["review", "snoozed"]).toContain(row.group);
          }
          if (actions.snooze) expect(["waiting", "review"]).toContain(row.group);
          if (actions.stop) {
            expect(["running", "waiting"]).toContain(row.group);
            expect(isAlive(row.session.status)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("lists one To review row per change, besides the ones the person kept there", () => {
    fc.assert(
      fc.property(inbox, ({ rows, marks }) => {
        // Kept by Mark not done or Unsnooze (an `inbox` mark): the person's choice, row by row.
        const kept = new Set(
          marks.filter((mark) => mark.state === "inbox").map((mark) => mark.sessionId),
        );
        const changes = [...placed(rows, marks).values()]
          .filter(
            (row) =>
              row.group === "review" &&
              row.annotation?.changeId != null &&
              !kept.has(row.session.id),
          )
          .map((row) => row.annotation?.changeId);
        expect(new Set(changes).size).toBe(changes.length);
      }),
      RUNS,
    );
  });

  it("moves a session with time only out of Snoozed and To review, never into Snoozed, and into To review only from Snoozed", () => {
    fc.assert(
      fc.property(inbox, fc.integer({ min: 1, max: 10 * 24 * 60 }), ({ rows, marks }, minutes) => {
        const before = placed(rows, marks);
        const after = placed(rows, marks, at(minutes));
        for (const row of rows) {
          const was = get(before, row.session.id).group;
          const is = get(after, row.session.id).group;
          if (is === "snoozed") expect(was).toBe("snoozed");
          // A snooze that ends sends it back where its facts put it, To review among them.
          if (is === "review") expect(["review", "snoozed"]).toContain(was);
        }
      }),
      RUNS,
    );
  });

  it("never moves a session for a rename", () => {
    fc.assert(
      fc.property(inbox, fc.string({ maxLength: 12 }), ({ rows, marks }, label) => {
        const renamed = rows.map((row) => ({
          ...row,
          title: label,
          session: { ...row.session, label },
        }));
        const before = placed(rows, marks);
        const after = placed(renamed, marks);
        for (const row of rows)
          expect(get(after, row.session.id).group).toBe(get(before, row.session.id).group);
      }),
      RUNS,
    );
  });
});
