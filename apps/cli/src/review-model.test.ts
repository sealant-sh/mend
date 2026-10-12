import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assembleReviewInstruction, buildReviewFiles, visibleWhitespace } from "./review-model.ts";

const PATCH = `diff --git a/src/greet.ts b/src/greet.ts
index 1111111..2222222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@
 export const greet = (name: string) => {
-  return \`Hi \${name}\`;
+  const greeting = \`Hello \${name}\`;
+  return greeting;
 };
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -10 +10 @@ Usage
-Run it.
+Run \`mend review\`.
`;

const gitRowsPatch = () => {
  const cwd = mkdtempSync(join(tmpdir(), "mend-review-rows-"));
  try {
    const file = join(cwd, "rows.txt");
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-c", "core.autocrlf=false", "-c", "color.ui=false", ...args], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env["PATH"],
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          LC_ALL: "C",
        },
      });
    git("init", "--quiet");
    writeFileSync(
      file,
      "before\n-- removed\t tail \nafter\ngap1\ngap2\ngap3\ngap4\ngap5\n-- old second \ntail\n",
    );
    git("add", "rows.txt");
    writeFileSync(
      file,
      "before\n++ added\t tail \n++ extra \nafter\ngap1\ngap2\ngap3\ngap4\ngap5\n++ second \ntail\n",
    );
    return {
      patch: git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=1",
        "--",
        "rows.txt",
      ),
      contents: readFileSync(file, "utf8").split("\n"),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

const EXPECTED_ROWS = [
  {
    kind: "context",
    oldLine: 1,
    newLine: 1,
    unifiedRow: 0,
    splitRow: 0,
    hunk: 0,
    commentable: true,
  },
  {
    kind: "deletion",
    oldLine: 2,
    newLine: null,
    unifiedRow: 1,
    splitRow: 1,
    hunk: 0,
    commentable: false,
  },
  {
    kind: "addition",
    oldLine: null,
    newLine: 2,
    unifiedRow: 2,
    splitRow: 1,
    hunk: 0,
    commentable: true,
  },
  {
    kind: "addition",
    oldLine: null,
    newLine: 3,
    unifiedRow: 3,
    splitRow: 2,
    hunk: 0,
    commentable: true,
  },
  {
    kind: "context",
    oldLine: 3,
    newLine: 4,
    unifiedRow: 4,
    splitRow: 3,
    hunk: 0,
    commentable: true,
  },
  {
    kind: "context",
    oldLine: 8,
    newLine: 9,
    unifiedRow: 5,
    splitRow: 4,
    hunk: 1,
    commentable: true,
  },
  {
    kind: "deletion",
    oldLine: 9,
    newLine: null,
    unifiedRow: 6,
    splitRow: 5,
    hunk: 1,
    commentable: false,
  },
  {
    kind: "addition",
    oldLine: null,
    newLine: 10,
    unifiedRow: 7,
    splitRow: 5,
    hunk: 1,
    commentable: true,
  },
  {
    kind: "context",
    oldLine: 10,
    newLine: 11,
    unifiedRow: 8,
    splitRow: 6,
    hunk: 1,
    commentable: true,
  },
];

describe("buildReviewFiles", () => {
  it("turns a multi-file git patch into navigable new-side review anchors", () => {
    const files = buildReviewFiles(PATCH, [
      { path: "src/greet.ts", additions: 2, deletions: 1 },
      { path: "README.md", additions: 1, deletions: 1 },
    ]);

    expect(files.map((file) => file.path)).toEqual(["src/greet.ts", "README.md"]);
    expect(files[0]).toMatchObject({
      additions: 2,
      deletions: 1,
      filetype: "typescript",
      status: "modified",
      binary: false,
      likelyGenerated: false,
      unifiedRows: 5,
      splitRows: 4,
    });
    expect(files[0]?.hunks).toEqual([
      { index: 0, header: "@@ -1,3 +1,4 @@", unifiedRow: 0, splitRow: 0 },
    ]);
    expect(
      files[0]?.lines.map(({ kind, oldLine, newLine, unifiedRow, splitRow, commentable }) => ({
        kind,
        oldLine,
        newLine,
        unifiedRow,
        splitRow,
        commentable,
      })),
    ).toEqual([
      {
        kind: "context",
        oldLine: 1,
        newLine: 1,
        unifiedRow: 0,
        splitRow: 0,
        commentable: true,
      },
      {
        kind: "deletion",
        oldLine: 2,
        newLine: null,
        unifiedRow: 1,
        splitRow: 1,
        commentable: false,
      },
      {
        kind: "addition",
        oldLine: null,
        newLine: 2,
        unifiedRow: 2,
        splitRow: 1,
        commentable: true,
      },
      {
        kind: "addition",
        oldLine: null,
        newLine: 3,
        unifiedRow: 3,
        splitRow: 2,
        commentable: true,
      },
      {
        kind: "context",
        oldLine: 3,
        newLine: 4,
        unifiedRow: 4,
        splitRow: 3,
        commentable: true,
      },
    ]);
    expect(files[0]?.patch.startsWith("diff --git a/src/greet.ts b/src/greet.ts\n")).toBe(true);
  });

  it("keeps Git's ++/-- source lines and exact anchors across multiple hunks", () => {
    const { patch, contents } = gitRowsPatch();
    const [review] = buildReviewFiles(patch, [{ path: "rows.txt", additions: 3, deletions: 2 }]);
    expect(review?.hunks).toEqual([
      { index: 0, header: "@@ -1,3 +1,4 @@", unifiedRow: 0, splitRow: 0 },
      { index: 1, header: "@@ -8,3 +9,3 @@ gap4", unifiedRow: 5, splitRow: 4 },
    ]);
    expect(review?.lines).toEqual(EXPECTED_ROWS);
    expect({ unified: review?.unifiedRows, split: review?.splitRows }).toEqual({
      unified: 9,
      split: 7,
    });
    // Every commentable row selects exactly the intended source line in the worktree.
    expect(
      review?.lines
        .filter((line) => line.commentable)
        .map((line) => ({
          row: line.unifiedRow,
          splitRow: line.splitRow,
          line: line.newLine,
          text: line.newLine === null ? null : contents[line.newLine - 1],
        })),
    ).toEqual([
      { row: 0, splitRow: 0, line: 1, text: "before" },
      { row: 2, splitRow: 1, line: 2, text: "++ added\t tail " },
      { row: 3, splitRow: 2, line: 3, text: "++ extra " },
      { row: 4, splitRow: 3, line: 4, text: "after" },
      { row: 5, splitRow: 4, line: 9, text: "gap5" },
      { row: 7, splitRow: 5, line: 10, text: "++ second " },
      { row: 8, splitRow: 6, line: 11, text: "tail" },
    ]);
  });

  it("classifies file status and changes that need explicit terminal handling", () => {
    const files = buildReviewFiles(
      `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/client.generated.ts b/src/client.generated.ts
similarity index 98%
rename from src/client.ts
rename to src/client.generated.ts
`,
      [
        { path: "assets/logo.png", additions: 0, deletions: 0 },
        { path: "src/client.generated.ts", additions: 1, deletions: 1 },
      ],
    );

    expect(files[0]).toMatchObject({ status: "added", binary: true, likelyGenerated: false });
    expect(files[1]).toMatchObject({ status: "renamed", binary: false, likelyGenerated: true });
  });
});

describe("visibleWhitespace", () => {
  it("renders whitespace in Git hunk lines starting ++ and -- without changing headers", () => {
    const { patch } = gitRowsPatch();
    const expectedWhitespace = patch
      .replace("--- removed\t tail ", "---·removed→·····tail·")
      .replace("+++ added\t tail ", "+++·added→·····tail·")
      .replace("+++ extra ", "+++·extra·")
      .replace("--- old second ", "---·old·second·")
      .replace("+++ second ", "+++·second·");
    expect(visibleWhitespace(patch)).toBe(expectedWhitespace);
  });

  it("marks spaces and tabs in hunk content without changing git control lines", () => {
    const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const a = 1;
+const\tb = 2;${" "}
`;

    expect(visibleWhitespace(patch)).toContain("+const→····b·=·2;·\n");
    expect(visibleWhitespace(patch)).toContain("+++ b/a.ts\n");
  });
});

describe("assembleReviewInstruction", () => {
  it("preserves file ranges and concrete suggestions in the editable session follow-up", () => {
    const instruction = assembleReviewInstruction({ branch: "mend/session/bright-otter" }, [
      {
        file: "src/greet.ts",
        line: 2,
        endLine: 3,
        body: "Keep the existing greeting contract.",
        suggestion: "  return `Hi ${name}`;",
      },
      {
        file: null,
        line: null,
        endLine: null,
        body: "Add the observed check to the handoff.",
        suggestion: null,
      },
    ]);

    expect(instruction).toContain("The branch mend/session/bright-otter is already checked out");
    expect(instruction).toContain(
      "1. src/greet.ts:2-3 — Keep the existing greeting contract.\n   Proposed replacement:\n     return `Hi ${name}`;",
    );
    expect(instruction).toContain(
      "2. the change as a whole — Add the observed check to the handoff.",
    );
    expect(instruction).toContain("Report honestly what you changed and what you did not");
  });
});
