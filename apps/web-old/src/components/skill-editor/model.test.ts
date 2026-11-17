import { describe, expect, it } from "vitest";

import { changedFiles, newFileIssue, orderedFiles, previewBlocks, skillShape } from "./model";

describe("skill editor model", () => {
  it("says a skill's shape the way the lists do", () => {
    expect(skillShape({ fileCount: 6, bytes: 38 * 1024 })).toBe("6 files · 38 KB");
    expect(skillShape({ fileCount: 1, bytes: 300 })).toBe("1 file · 300 B");
  });

  it("counts edited, added and removed files once each", () => {
    const saved = [
      { path: "SKILL.md", contents: "a" },
      { path: "notes.md", contents: "b" },
      { path: "gone.md", contents: "c" },
    ];
    const draft = [
      { path: "SKILL.md", contents: "a2" },
      { path: "notes.md", contents: "b" },
      { path: "new.md", contents: "" },
    ];
    expect(changedFiles(saved, draft)).toBe(3);
    expect(changedFiles(saved, saved)).toBe(0);
  });

  it("refuses a path that escapes the bundle or is already there", () => {
    const draft = [{ path: "SKILL.md", contents: "" }];
    expect(newFileIssue("../x.md", draft)).not.toBeNull();
    expect(newFileIssue("SKILL.md", draft)).toBe("SKILL.md is already in this skill");
    expect(newFileIssue("references/box.md", draft)).toBeNull();
  });

  it("lists SKILL.md first", () => {
    const files = orderedFiles([
      { path: "scripts/a.sh", contents: "" },
      { path: "SKILL.md", contents: "" },
      { path: "references/b.md", contents: "" },
    ]);
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "references/b.md", "scripts/a.sh"]);
  });

  it("previews front matter, headings, lists, code and paragraphs as plain blocks", () => {
    const blocks = previewBlocks(
      [
        "---",
        "name: verify",
        "description: Drive Mend.",
        "---",
        "",
        "# Verify",
        "",
        "Build the stack",
        "inside one session.",
        "",
        "1. Start it.",
        "2. Open it.",
        "",
        "```sh",
        "pnpm dev",
        "```",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      {
        kind: "facts",
        rows: [
          ["name", "verify"],
          ["description", "Drive Mend."],
        ],
      },
      { kind: "heading", level: 1, text: "Verify" },
      { kind: "paragraph", text: "Build the stack inside one session." },
      { kind: "list", ordered: true, items: ["Start it.", "Open it."] },
      { kind: "code", text: "pnpm dev" },
    ]);
  });
});
