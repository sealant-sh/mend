import { describe, expect, it } from "vitest";

import {
  changeRows,
  commentsLine,
  fileRow,
  type ChangeRead,
  type ChangeRow,
} from "./change-rows.js";
import type { ChangeFile, Checkpoint, ServerComment } from "./review-wire.js";
import { resolveSlice } from "./slices.js";

const checkpoint = (ordinal: number, trigger: Checkpoint["trigger"] = "user-mark"): Checkpoint => ({
  id: `cp${ordinal}`,
  ordinal,
  trigger,
  createdAt: "2026-10-19T10:00:00.000Z",
});

const checkpoints = [checkpoint(0, "session-start"), checkpoint(1), checkpoint(2, "review-open")];
const base = checkpoints[0] ?? checkpoint(0);
const head = checkpoints[2] ?? checkpoint(2);

const files: ReadonlyArray<ChangeFile> = [
  {
    oldPath: null,
    newPath: "src/auth/limit.ts",
    status: "added",
    additions: 15,
    deletions: 0,
    binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 15, contextHash: "h1" }],
  },
  {
    oldPath: "README",
    newPath: null,
    status: "deleted",
    additions: 0,
    deletions: 1,
    binary: false,
    hunks: [],
  },
];

const observed = { state: "observed", observedAt: "2026-10-19T10:00:00.000Z" } as const;

const read = (
  choice: Parameters<typeof resolveSlice>[0],
  overrides: Partial<ChangeRead> = {},
  chain: ReadonlyArray<Checkpoint> = checkpoints,
): ChangeRead => {
  const pinned = {
    id: "slice-1",
    changeId: "change-1",
    diffDigest: "d",
    base,
    head,
    createdAt: "2026-10-19T10:00:00.000Z",
  };
  const slice = resolveSlice(choice, pinned, chain);
  if (slice === null) throw new Error("the slice did not resolve");
  const diff = {
    files,
    worktreeChangedSinceSnapshot: false,
    observation: observed,
    listingCut: false,
  };
  return {
    sessionId: "s1",
    sessionName: "add-rate-limit",
    changeId: "change-1",
    chain: { worktreeId: "w1", baseName: "main", checkpoints: chain },
    pinned,
    pinnedDiff: diff,
    slice,
    diff,
    comments: [],
    reviewedHead: null,
    drift: null,
    notice: null,
    readAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
};

const sliceRow = (rows: ReadonlyArray<ChangeRow>) => {
  const [slice] = rows;
  if (slice?.kind !== "slice") throw new Error("no slice row");
  return slice;
};

const now = new Date("2026-10-19T10:00:40.000Z");

const comment = (overrides: Partial<ServerComment>): ServerComment => ({
  id: "c1",
  file: "src/auth/limit.ts",
  line: 12,
  endLine: 12,
  anchor: null,
  author: { kind: "reviewer", name: "Dana" },
  body: "Use the shared limiter",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...overrides,
});

describe("the Change section's rows (story d, step 1)", () => {
  it("is the slice's header with its files, then Comments and Checkpoints", () => {
    const rows = changeRows(read({ kind: "pinned" }), new Date("2026-10-19T10:00:40.000Z"));
    expect(rows.map((row) => row.kind)).toEqual(["slice", "comments", "checkpoints"]);
    const [slice] = rows;
    if (slice?.kind !== "slice") throw new Error("no slice row");
    expect(`${slice.label} ${slice.description}`).toBe(
      "main → now ▾ 2 files · +15 −1 · observed · 40 s ago",
    );
    expect(slice.files.map((row) => `${row.name} ${row.folder} ${row.letter}`)).toEqual([
      "limit.ts src/auth A",
      "README  D",
    ]);
  });

  it("says a view-only slice takes no comments (G10)", () => {
    const rows = changeRows(
      read({ kind: "between", from: checkpoint(1), to: head }),
      new Date("2026-10-19T10:00:40.000Z"),
    );
    expect(rows.find((row) => row.kind === "note")).toMatchObject({
      label: "viewing · comments go on main → now",
    });
  });

  it("opens a file between the slice's two checkpoints, empty only on the side its status says", () => {
    const shown = read({ kind: "pinned" });
    const [added, deleted] = files.map((file) => fileRow(file, shown));
    const where = { worktreeId: "w1", path: "src/auth/limit.ts" };
    expect(added?.left).toEqual({ ...where, at: "cp0", absent: true });
    expect(added?.right).toEqual({ ...where, at: "cp2", absent: false });
    expect([deleted?.left.path, deleted?.left.absent, deleted?.right.absent]).toEqual([
      "README",
      false,
      true,
    ]);
    expect(added?.title).toBe("limit.ts (main ↔ checkpoint 2)");
  });

  it("says the worktree moved on, with Review the newer change, while the slice stays pinned", () => {
    const counted = sliceRow(changeRows(read({ kind: "pinned" }, { drift: { files: 3 } }), now));
    expect(counted.above.map((row) => `${row.kind} ${"label" in row ? row.label : ""}`)).toEqual([
      "note worktree changed since this review · 3 new files",
      "action Review the newer change",
    ]);
    expect(counted.above[1]).toMatchObject({ command: "mend.change.repin" });
    expect(counted.files).toHaveLength(2);
    const uncounted = sliceRow(
      changeRows(read({ kind: "pinned" }, { drift: { files: null } }), now),
    );
    expect(uncounted.above[0]).toMatchObject({ label: "worktree changed since this review" });
    expect(sliceRow(changeRows(read({ kind: "pinned" }), now)).above).toEqual([]);
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
    const slice = sliceRow(changeRows(read(chosen, {}, turns), now));
    expect(slice.label).toBe("last turn ▾");
    expect(slice.above).toEqual([
      {
        kind: "action",
        id: "action:read-newer",
        label: "newer checkpoints · read checkpoint 1 → checkpoint 3",
        command: "mend.change.readNewer",
      },
    ]);
    expect(slice.files[0]?.right.at).toBe("cp1");
  });

  it("says the listing was cut in the header, and never observed", () => {
    const cut = {
      files,
      worktreeChangedSinceSnapshot: false,
      observation: observed,
      listingCut: true,
    };
    const slice = sliceRow(changeRows(read({ kind: "pinned" }, { diff: cut }), now));
    expect(slice.description).toBe("listing cut at 2 files · +15 −1 in those · read 40 s ago");
  });

  it("counts comments by what was observed of each", () => {
    expect(commentsLine([])).toBe("none");
    expect(
      commentsLine([
        comment({ id: "1", state: "draft", author: { kind: "mend", name: "Mend" } }),
        comment({ id: "2", sentToSessionId: "s1" }),
        comment({ id: "3", sentToSessionId: "s1" }),
        comment({ id: "4", state: "dismissed" }),
      ]),
    ).toBe("2 sent · 1 Mend draft");
  });
});
