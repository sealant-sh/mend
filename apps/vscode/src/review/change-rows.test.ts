import { describe, expect, it } from "vitest";

import { changeRows, fileRow, type ChangeRow } from "./change-rows.js";
import { EMPTY_REVIEW } from "./pending.js";
import { checkpoint, comment, FILES, pending, PINNED, readOf } from "./test-fixtures.js";

const NOW = new Date("2026-10-19T10:00:40.000Z");

const sliceRow = (rows: ReadonlyArray<ChangeRow>) => {
  const slice = rows.find((row) => row.kind === "slice");
  if (slice?.kind !== "slice") throw new Error("no slice row");
  return slice;
};

const rowsOf = (read: Parameters<typeof changeRows>[0]) =>
  changeRows(read, EMPTY_REVIEW, "Dana", NOW);

describe("the Change section's rows (story d, step 1)", () => {
  it("is the slice's header with its files, then Comments and Checkpoints", () => {
    const shown = readOf({ kind: "pinned" });
    const observed = {
      ...shown.diff,
      observation: { state: "observed", observedAt: "2026-10-19T10:00:00.000Z" },
    } as const;
    const rows = changeRows({ ...shown, diff: observed }, EMPTY_REVIEW, "Dana", NOW);
    expect(rows.map((row) => row.kind)).toEqual(["slice", "comments", "checkpoints"]);
    const [slice] = rows;
    if (slice?.kind !== "slice") throw new Error("no slice row");
    expect(`${slice.label} ${slice.description}`).toBe(
      "main → now ▾ 4 files · +18 −3 · observed · 40 s ago",
    );
    expect(slice.files.map((row) => `${row.name} ${row.folder} ${row.letter}`)).toEqual([
      "limit.ts src/auth A",
      "app.ts src M",
      "new-name.ts src R",
      "README  D",
    ]);
  });

  it("says a view-only slice takes no comments (G10)", () => {
    const rows = changeRows(
      readOf({ kind: "between", from: checkpoint(1), to: PINNED.head }),
      EMPTY_REVIEW,
      "Dana",
      NOW,
    );
    expect(rows.find((row) => row.kind === "note")).toMatchObject({
      label: "viewing · comments go on main → now",
    });
  });

  it("opens a file between the slice's two checkpoints, empty only on the side its status says, the pinned new side named", () => {
    const shown = readOf({ kind: "pinned" });
    const rowOf = (status: string) => {
      const file = FILES.find((candidate) => candidate.status === status);
      if (file === undefined) throw new Error(`no ${status} file`);
      return fileRow(file, shown);
    };
    const [added, deleted] = [rowOf("added"), rowOf("deleted")];
    const where = { worktreeId: "w1", path: "src/auth/limit.ts" };
    expect(added?.left).toEqual({ ...where, at: "cp0", absent: true, slice: null });
    expect(added?.right).toEqual({ ...where, at: "cp2", absent: false, slice: "slice-1" });
    expect([deleted?.left.path, deleted?.left.absent, deleted?.right.absent]).toEqual([
      "README",
      false,
      true,
    ]);
    expect(added?.title).toBe("limit.ts (main ↔ checkpoint 2)");
  });

  it("says the worktree moved on, with Review the newer change, while the slice stays pinned", () => {
    const counted = sliceRow(rowsOf(readOf({ kind: "pinned" }, { drift: { files: 3 } })));
    expect(counted.above.map((row) => `${row.kind} ${"label" in row ? row.label : ""}`)).toEqual([
      "note worktree changed since this review · 3 new files",
      "action Review the newer change",
    ]);
    expect(counted.above[1]).toMatchObject({ command: "mend.change.repin" });
    expect(counted.files).toHaveLength(FILES.length);
    const uncounted = sliceRow(rowsOf(readOf({ kind: "pinned" }, { drift: { files: null } })));
    expect(uncounted.above[0]).toMatchObject({ label: "worktree changed since this review" });
    expect(sliceRow(rowsOf(readOf({ kind: "pinned" }))).above).toEqual([]);
  });

  it("offers the newer read of a last turn she chose, once a newer turn ended", () => {
    const turns = [
      checkpoint(0, "session-start"),
      checkpoint(1, "turn-boundary"),
      checkpoint(2, "review-open"),
      checkpoint(3, "turn-boundary"),
    ];
    const chosen = {
      kind: "last-turn",
      from: checkpoint(0, "session-start"),
      to: checkpoint(1, "turn-boundary"),
    } as const;
    const slice = sliceRow(
      rowsOf(readOf(chosen, { chain: { worktreeId: "w1", baseName: "main", checkpoints: turns } })),
    );
    expect(slice.label).toBe("last turn ▾");
    expect(slice.above).toEqual([
      {
        kind: "action",
        id: "action:read-newer",
        label: "newer checkpoints · read checkpoint 1 → checkpoint 3",
        command: "mend.change.readNewer",
        sinceLastReview: false,
      },
    ]);
    expect(slice.files[0]?.right.at).toBe("cp1");
  });

  it("says the listing was cut in the header, and never observed", () => {
    const cut = {
      files: FILES,
      worktreeChangedSinceSnapshot: false,
      observation: { state: "observed", observedAt: "2026-10-19T10:00:00.000Z" },
      listingCut: true,
    } as const;
    const slice = sliceRow(rowsOf(readOf({ kind: "pinned" }, { diff: cut })));
    expect(slice.description).toBe("listing cut at 4 files · +18 −3 in those · read 40 s ago");
  });

  it("names no slice on a view-only slice's documents, so they take no comment", () => {
    const shown = readOf({ kind: "between", from: checkpoint(1), to: PINNED.head });
    expect(FILES.map((file) => fileRow(file, shown).right.slice)).toEqual(FILES.map(() => null));
  });

  it("reads `Mend is reading · 10:42` above the slice while Mend reads the change", () => {
    const since = new Date(2026, 9, 19, 10, 42).toISOString();
    const rows = changeRows(
      readOf({ kind: "pinned" }, { pass: { kind: "reading", since } }),
      EMPTY_REVIEW,
      "Dana",
      NOW,
    );
    expect(rows[0]).toMatchObject({ kind: "note", label: "Mend is reading · 10:42" });
  });

  it("lists each comment under Comments with its file, line and word (story d, step 4)", () => {
    const rows = changeRows(
      readOf(
        { kind: "pinned" },
        {
          comments: [
            comment({
              id: "d1",
              state: "draft",
              line: 6,
              file: "src/auth/login.ts",
              author: { kind: "mend", name: "Mend" },
              body: "On the limit, line 6 returns without a response.",
            }),
          ],
        },
      ),
      { pending: [pending({})], sends: [], document: null },
      "Dana",
      NOW,
    );
    const comments = rows.find((row) => row.kind === "comments");
    if (comments?.kind !== "comments") throw new Error("no Comments row");
    expect(comments.description).toBe("1 pending · 1 Mend draft");
    expect(comments.comments.map((row) => `${row.label} · ${row.description}`)).toEqual([
      "Use the shared limiter from guard.ts · limit.ts:12 · pending",
      "On the limit, line 6 returns without a response. · login.ts:6 · Mend · draft",
    ]);
  });
});
