import { describe, expect, it } from "vitest";

import { changeRows, commentsLine, fileRow, type ChangeRead } from "./change-rows.js";
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

const read = (choice: Parameters<typeof resolveSlice>[0]): ChangeRead => {
  const pinned = {
    id: "slice-1",
    changeId: "change-1",
    diffDigest: "d",
    base,
    head,
    createdAt: "2026-10-19T10:00:00.000Z",
  };
  const slice = resolveSlice(choice, pinned, checkpoints);
  if (slice === null) throw new Error("the slice did not resolve");
  return {
    sessionId: "s1",
    sessionName: "add-rate-limit",
    changeId: "change-1",
    chain: { worktreeId: "w1", baseName: "main", checkpoints },
    pinned,
    pinnedDiff: { files, worktreeChangedSinceSnapshot: false, observation: null },
    slice,
    diff: { files, worktreeChangedSinceSnapshot: false, observation: null },
    comments: [],
    readAt: "2026-10-19T10:00:00.000Z",
  };
};

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

  it("opens a file between the slice's two checkpoints, the added file empty on the left", () => {
    const shown = read({ kind: "pinned" });
    const [added, deleted] = files.map((file) => fileRow(file, shown));
    expect(added?.left).toEqual({ worktreeId: "w1", path: "src/auth/limit.ts", at: "cp0" });
    expect(added?.right).toEqual({ worktreeId: "w1", path: "src/auth/limit.ts", at: "cp2" });
    expect(deleted?.left.path).toBe("README");
    expect(added?.title).toBe("limit.ts (main ↔ checkpoint 2)");
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
