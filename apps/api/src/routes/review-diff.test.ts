import { describe, expect, it } from "vitest";

import { digestReviewPatch, lineAnchorExists, parseReviewDiff } from "./review-diff.ts";

const patch = `diff --git a/old.ts b/new.ts
similarity index 60%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
 tail
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two`;

const typeChangePatch = `diff --git a/t.txt b/t.txt
deleted file mode 100644
index 62e0af5..0000000
--- a/t.txt
+++ /dev/null
@@ -1 +0,0 @@
-target
diff --git a/t.txt b/t.txt
new file mode 120000
index 0000000..1de5659
--- /dev/null
+++ b/t.txt
@@ -0,0 +1 @@
+k.txt
\\ No newline at end of file
diff --git a/z.txt b/z.txt
index 7898192..9bda8c3 100644
--- a/z.txt
+++ b/z.txt
@@ -1 +1 @@
-old
+new`;

describe("immutable Review diff", () => {
  it("builds structured files and stable hunk hashes from exact patch bytes", () => {
    const files = parseReviewDiff(patch, [
      {
        oldPath: "old.ts",
        newPath: "new.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        binary: false,
      },
      {
        oldPath: "gone.ts",
        newPath: null,
        status: "deleted",
        additions: 0,
        deletions: 2,
        binary: false,
      },
    ]);

    expect(digestReviewPatch(patch)).toBe(
      "42c1bcdc6433978ea942f00a569317153bf88c453c1a6eb1ef6aff8a19c6e8bf",
    );
    expect(digestReviewPatch(patch + "\n")).not.toBe(digestReviewPatch(patch));
    expect(files).toHaveLength(2);
    expect(files[0]?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      contextHash: "aaceb34d55fb8dfd7ad87d2182af43d1dfb2eab022c628b7cdbe714779809d56",
    });
    expect(files[1]?.status).toBe("deleted");
  });

  it("folds duplicate type-change sections without shifting later files", () => {
    const files = parseReviewDiff(typeChangePatch, [
      {
        oldPath: "t.txt",
        newPath: "t.txt",
        status: "type-changed",
        additions: 1,
        deletions: 1,
        binary: false,
      },
      {
        oldPath: "z.txt",
        newPath: "z.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ]);

    expect(files[0]?.patch.match(/^diff --git a\/t\.txt b\/t\.txt$/gm)).toHaveLength(2);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[1]?.patch).toContain("diff --git a/z.txt b/z.txt");
    expect(files[1]?.patch).not.toContain("diff --git a/t.txt b/t.txt");
    expect(files[1]?.hunks[0]?.patch).toContain("+new");
  });

  it("accepts only ranges bound to the matching file, side, and hunk context", () => {
    const files = parseReviewDiff(patch, [
      {
        oldPath: "old.ts",
        newPath: "new.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        binary: false,
      },
      {
        oldPath: "gone.ts",
        newPath: null,
        status: "deleted",
        additions: 0,
        deletions: 2,
        binary: false,
      },
    ]);
    const contextHash = files[0]?.hunks[0]?.contextHash ?? "";
    const target = {
      oldPath: "old.ts",
      newPath: "new.ts",
      side: "old" as const,
      startLine: 2,
      endLine: 2,
      hunkContextHash: contextHash,
    };

    expect(lineAnchorExists(files, target)).toBe(true);
    expect(lineAnchorExists(files, { ...target, side: "new" })).toBe(true);
    expect(lineAnchorExists(files, { ...target, startLine: 8, endLine: 8 })).toBe(false);
    expect(lineAnchorExists(files, { ...target, startLine: 0, endLine: 0 })).toBe(false);
    expect(lineAnchorExists(files, { ...target, startLine: 3, endLine: 2 })).toBe(false);
    expect(lineAnchorExists(files, { ...target, startLine: 1, endLine: 3 })).toBe(true);
    expect(lineAnchorExists(files, { ...target, endLine: 4 })).toBe(false);
    expect(lineAnchorExists(files, { ...target, newPath: "wrong.ts" })).toBe(false);
    const deleted = {
      ...target,
      oldPath: "gone.ts",
      newPath: null,
      startLine: 1,
      endLine: 2,
      hunkContextHash: files[1]?.hunks[0]?.contextHash ?? "",
    };
    expect(lineAnchorExists(files, deleted)).toBe(true);
    expect(lineAnchorExists(files, { ...deleted, side: "new" })).toBe(false);
    expect(lineAnchorExists(files, { ...target, hunkContextHash: "stale" })).toBe(false);
  });
});
