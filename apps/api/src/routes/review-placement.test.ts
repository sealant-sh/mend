import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type CarryFile,
  carryLines,
  carryTarget,
  type LineHunk,
  targetChanged,
} from "./review-placement.ts";

// `@@ -31 +31,3 @@`: line 31 rewritten into three lines (the "was line 31" of Second look).
const rewrite31: LineHunk = { oldStart: 31, oldLines: 1, newStart: 31, newLines: 3 };
// `@@ -10,0 +11,2 @@`: two lines put after line 10.
const insertAfter10: LineHunk = { oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 };
// `@@ -20,2 +21,0 @@`: lines 20 and 21 deleted.
const delete20: LineHunk = { oldStart: 20, oldLines: 2, newStart: 21, newLines: 0 };

describe("carryLines", () => {
  it("moves lines no edit touched by the lines added and removed above them", () => {
    expect(carryLines([insertAfter10, delete20], 40, 42)).toEqual({
      kind: "placed",
      startLine: 40,
      endLine: 42,
      linesChanged: false,
    });
    expect(carryLines([insertAfter10], 15, 15)).toEqual({
      kind: "placed",
      startLine: 17,
      endLine: 17,
      linesChanged: false,
    });
    // Line 10 itself sits before the insertion.
    expect(carryLines([insertAfter10], 10, 10)).toMatchObject({ startLine: 10, endLine: 10 });
  });

  it("puts lines an edit rewrote on the lines that replaced them", () => {
    // Git numbers the second hunk's new side after the two lines the first one added.
    const rewrite31Below10 = { ...rewrite31, newStart: 33 };
    expect(carryLines([insertAfter10, rewrite31Below10], 31, 31)).toEqual({
      kind: "placed",
      startLine: 33,
      endLine: 35,
      linesChanged: true,
    });
  });

  it("keeps a range whose middle an edit changed, marked as changed", () => {
    expect(carryLines([delete20], 19, 22)).toEqual({
      kind: "placed",
      startLine: 19,
      endLine: 20,
      linesChanged: true,
    });
    expect(carryLines([insertAfter10], 9, 12)).toEqual({
      kind: "placed",
      startLine: 9,
      endLine: 14,
      linesChanged: true,
    });
  });

  it("says lines an edit only deleted are gone", () => {
    expect(carryLines([delete20], 20, 21)).toEqual({ kind: "gone" });
  });
});

describe("carryTarget", () => {
  const files: ReadonlyArray<CarryFile> = [
    { oldPath: "src/retry.ts", newPath: "src/retry.ts", status: "modified", hunks: [rewrite31] },
    { oldPath: "src/old.ts", newPath: "src/new.ts", status: "renamed", hunks: [] },
    { oldPath: "src/gone.ts", newPath: null, status: "deleted", hunks: [] },
  ];

  it("follows a rename, keeps a file the diff doesn't list, and drops a deleted file", () => {
    expect(carryTarget(files, "src/old.ts", { startLine: 4, endLine: 4 })).toEqual({
      kind: "placed",
      path: "src/new.ts",
      lines: { startLine: 4, endLine: 4 },
      linesChanged: false,
      renamed: true,
    });
    expect(carryTarget(files, "src/other.ts", null)).toEqual({
      kind: "placed",
      path: "src/other.ts",
      lines: null,
      linesChanged: false,
      renamed: false,
    });
    expect(carryTarget(files, "src/gone.ts", null)).toEqual({ kind: "gone" });
  });

  it("always places a comment on the whole change", () => {
    expect(carryTarget(files, null, null)).toMatchObject({ kind: "placed", path: null });
  });
});

describe("targetChanged", () => {
  const files: ReadonlyArray<CarryFile> = [
    { oldPath: "src/retry.ts", newPath: "src/retry.ts", status: "modified", hunks: [rewrite31] },
  ];

  it("reads whether the code a comment points at changed", () => {
    expect(targetChanged(files, "src/retry.ts", { startLine: 31, endLine: 31 })).toBe(true);
    expect(targetChanged(files, "src/retry.ts", { startLine: 5, endLine: 5 })).toBe(false);
    expect(targetChanged(files, "src/retry.ts", null)).toBe(true);
    expect(targetChanged(files, "src/charge.ts", null)).toBe(false);
    // Nothing can be tied to a comment on the whole change.
    expect(targetChanged(files, null, null)).toBeNull();
  });
});

/**
 * The rule: a line no edit touched is carried to the line where that same line now sits; a line
 * an edit deleted with nothing in its place is gone; a line an edit rewrote lands inside what
 * replaced it. Files and edits are generated here, with the hunks git would print for them.
 */
describe("carryLines over generated edits", () => {
  const edits = fc
    .array(
      fc.record({
        gap: fc.integer({ min: 0, max: 4 }),
        remove: fc.integer({ min: 0, max: 3 }),
        add: fc.integer({ min: 0, max: 3 }),
      }),
      { maxLength: 6 },
    )
    .map((list) => list.filter((edit) => edit.remove + edit.add > 0));

  it("carries every line to where it now sits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), edits, (length, plan) => {
        const oldFile = Array.from({ length }, (_, index) => `old-${index + 1}`);
        const newFile: Array<string> = [];
        const hunks: Array<LineHunk> = [];
        const fate = new Map<number, "kept" | "deleted" | { readonly within: [number, number] }>();
        let at = 0; // old lines consumed
        for (const [n, edit] of plan.entries()) {
          const keep = Math.min(edit.gap, length - at);
          for (let index = 0; index < keep; index++) newFile.push(oldFile[at++] ?? "");
          const remove = Math.min(edit.remove, length - at);
          if (remove + edit.add === 0) continue;
          const oldStart = remove > 0 ? at + 1 : at;
          const newStart = edit.add > 0 ? newFile.length + 1 : newFile.length;
          for (let index = 0; index < remove; index++) {
            fate.set(
              at + index + 1,
              edit.add === 0
                ? "deleted"
                : { within: [newFile.length + 1, newFile.length + edit.add] },
            );
          }
          at += remove;
          for (let index = 0; index < edit.add; index++) newFile.push(`new-${n}-${index}`);
          hunks.push({ oldStart, oldLines: remove, newStart, newLines: edit.add });
        }
        while (at < length) newFile.push(oldFile[at++] ?? "");

        for (let line = 1; line <= length; line++) {
          const carried = carryLines(hunks, line, line);
          const known = fate.get(line);
          if (known === undefined) {
            expect(carried).toEqual({
              kind: "placed",
              startLine: newFile.indexOf(`old-${line}`) + 1,
              endLine: newFile.indexOf(`old-${line}`) + 1,
              linesChanged: false,
            });
          } else if (known === "deleted") {
            expect(carried).toEqual({ kind: "gone" });
          } else if (known !== "kept") {
            expect(carried).toMatchObject({ kind: "placed", linesChanged: true });
            if (carried.kind === "placed") {
              expect(carried.startLine).toBeGreaterThanOrEqual(known.within[0]);
              expect(carried.endLine).toBeLessThanOrEqual(known.within[1]);
            }
          }
        }
      }),
      { seed: 1176, numRuns: 400 },
    );
  });
});
