import { beforeEach, describe, expect, it } from "vitest";

import type { ReviewCommentDto, ReviewDiffFileDto } from "#/lib/api";
import {
  assembleReviewInstruction,
  commentsForComparison,
  commentsForFile,
  queueReplayCursor,
  reviewOpenKey,
  sliceLineTarget,
  takeReplayCursor,
  terminalEvidenceExcerpt,
} from "#/lib/review";

const memoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const file: ReviewDiffFileDto = {
  oldPath: "src/old.ts",
  newPath: "src/new.ts",
  status: "renamed",
  additions: 2,
  deletions: 2,
  binary: false,
  patch: "",
  hunks: [
    {
      header: "@@ -10,4 +20,4 @@",
      oldStart: 10,
      oldLines: 4,
      newStart: 20,
      newLines: 4,
      contextHash: "hunk-1",
      patch: "",
    },
  ],
};

const comment = (id: string, body: string): ReviewCommentDto => ({
  id,
  changeId: "change-1",
  file: "src/new.ts",
  line: 21,
  endLine: 22,
  anchor: {
    reviewSliceId: "slice-1",
    checkpointAId: "a",
    checkpointBId: "b",
    diffDigest: "digest",
    oldPath: "src/old.ts",
    newPath: "src/new.ts",
    side: "new",
    startLine: 21,
    endLine: 22,
    hunkContextHash: "hunk-1",
    mapping: "anchored",
  },
  authorKind: "reviewer",
  authorName: "Reviewer",
  body,
  kind: "note",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

describe("native Review helpers", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
  });

  it("keeps the Review-open key stable across a desktop restart", () => {
    const first = reviewOpenKey("change-1");
    expect(reviewOpenKey("change-1")).toBe(first);
    expect(reviewOpenKey("change-2")).not.toBe(first);
  });

  it("hands a queued evidence sequence to one terminal reattach", () => {
    queueReplayCursor("session-1", "29");
    expect(takeReplayCursor("session-1")).toBe("29");
    expect(takeReplayCursor("session-1")).toBe("0");
  });

  it("keeps a bounded readable excerpt from recorded terminal output", () => {
    const text = `${String.fromCharCode(27)}[31mcheck failed${String.fromCharCode(27)}[0m\r\ncheck observed\n`;
    expect(terminalEvidenceExcerpt(text)).toBe("check failed\ncheck observed");
  });

  it("keeps equivalent-snapshot and legacy comments visible across slice rows", () => {
    const original = comment("one", "Pinned comment");
    const anchor = original.anchor;
    if (anchor === null) throw new Error("test comment must have a slice anchor");
    const equivalent: ReviewCommentDto = {
      ...comment("two", "Same comparison, later slice row"),
      anchor: {
        ...anchor,
        reviewSliceId: "slice-2",
      },
    };
    const legacy: ReviewCommentDto = {
      ...comment("legacy", "Old readable comment"),
      file: null,
      line: null,
      endLine: null,
      anchor: null,
    };
    const other: ReviewCommentDto = {
      ...comment("other", "Different comparison"),
      anchor: {
        ...anchor,
        diffDigest: "other-digest",
      },
    };
    const matched = commentsForComparison([original, equivalent, legacy, other], "digest");
    expect(matched.map((entry) => entry.id)).toEqual(["one", "two", "legacy"]);
    expect(commentsForFile(matched, "src/new.ts").map((entry) => entry.id)).toEqual([
      "one",
      "two",
      "legacy",
    ]);
  });

  it("anchors additions and deletions to the canonical hunk", () => {
    expect(sliceLineTarget(file, "new", 21, 22)).toMatchObject({
      side: "new",
      startLine: 21,
      endLine: 22,
      hunkContextHash: "hunk-1",
    });
    expect(sliceLineTarget(file, "old", 11, 12)).toMatchObject({
      side: "old",
      startLine: 11,
      endLine: 12,
      hunkContextHash: "hunk-1",
    });
    expect(sliceLineTarget(file, "old", 9, 10)).toBeNull();
  });

  it("assembles only selected comments into editable follow-up text", () => {
    const comments = [
      comment("one", "Keep the retry idempotent."),
      comment("two", "Name the gap."),
    ];
    const instruction = assembleReviewInstruction(comments, new Set(["two"]));
    expect(instruction).toContain("Name the gap.");
    expect(instruction).not.toContain("Keep the retry idempotent.");
    expect(instruction).toContain("src/new.ts · new 21–22");
  });
});
