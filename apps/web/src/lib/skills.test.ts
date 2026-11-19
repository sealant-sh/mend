import { describe, expect, it } from "vitest";

import {
  bundleIssue,
  changedFiles,
  changedLines,
  descriptionIssue,
  fileIssue,
  fileMark,
  highlighted,
  listCountWords,
  matchesSearch,
  nameIssue,
  newFileIssue,
  orderedFiles,
  panelWhen,
  previewBlocks,
  projectTwins,
  rowWhen,
  shownFile,
  skillFilesLine,
  skillSize,
  unsavedWords,
  usedInWords,
  withFrontMatter,
} from "./skills";

const sized = (path: string, kb: number) => ({ path, contents: "x".repeat(kb * 1024) });
const day = (iso: string) => new Date(iso);

describe("a skill's size", () => {
  it("is said the way the pages list it", () => {
    expect(skillSize(812)).toBe("812 B");
    expect(skillSize(22 * 1024 + 300)).toBe("22 KB");
    expect(skillSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(skillFilesLine({ fileCount: 1, bytes: 900 })).toBe("SKILL.md, 900 B");
    expect(skillFilesLine({ fileCount: 6, bytes: 38 * 1024 })).toBe("6 files, 38 KB");
  });
});

describe("a skill draft", () => {
  const saved = [
    { path: "SKILL.md", contents: "a\nb\nc" },
    { path: "notes.md", contents: "x" },
  ];

  it("counts edited, added and removed files once each", () => {
    expect(changedFiles(saved, saved)).toEqual([]);
    expect(
      changedFiles(saved, [
        { path: "SKILL.md", contents: "a\nb\nc\nd" },
        { path: "more.md", contents: "" },
      ]),
    ).toEqual(["SKILL.md", "notes.md", "more.md"]);
  });

  it("marks each file new, edited or unchanged", () => {
    expect(fileMark(saved, { path: "more.md", contents: "" })).toBe("new");
    expect(fileMark(saved, { path: "SKILL.md", contents: "a" })).toBe("edited");
    expect(fileMark(saved, { path: "notes.md", contents: "x" })).toBeNull();
  });

  it("says what is unsaved", () => {
    expect(unsavedWords(2, false)).toBe("2 files changed, not saved");
    expect(unsavedWords(1, true)).toBe("1 file changed and the description, not saved");
    expect(unsavedWords(0, true)).toBe("Description changed, not saved");
    expect(unsavedWords(0, false)).toBe("No changes");
  });

  it("marks only an inserted line, not the lines after it", () => {
    expect([...changedLines("a\nb\nc", "a\nnew\nb\nc")]).toEqual([1]);
    expect([...changedLines("a\nb\nc", "a\nb\nc\nd")]).toEqual([3]);
    expect([...changedLines("a\nb", "a\nb")]).toEqual([]);
  });

  it("shows the requested file, else SKILL.md, and lists SKILL.md first", () => {
    expect(shownFile(saved, "notes.md")?.path).toBe("notes.md");
    expect(shownFile(saved, "gone.md")?.path).toBe("SKILL.md");
    expect(shownFile(saved, undefined)?.path).toBe("SKILL.md");
    const files = orderedFiles([
      { path: "scripts/a.sh", contents: "" },
      { path: "SKILL.md", contents: "" },
      { path: "references/b.md", contents: "" },
    ]);
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "references/b.md", "scripts/a.sh"]);
  });
});

describe("each field's rule", () => {
  it("refuses a name the server would, and one already in the list", () => {
    expect(nameIssue("pr-descriptions", ["commit-messages"])).toBeNull();
    expect(nameIssue("commit-messages", ["commit-messages"])).toBe(
      "You already have a skill named commit-messages. Pick another name.",
    );
    expect(nameIssue("", [])).toBe("Give the skill a name.");
    expect(nameIssue("-notes", [])).toBe("Start the name with a lowercase letter or a digit.");
    expect(nameIssue("pr notes", [])).toBe(
      "Use only lowercase letters, digits, dots, dashes and underscores.",
    );
    expect(nameIssue("a".repeat(65), [])).toBe(
      "A name can be 64 characters at most. This one has 65.",
    );
  });

  it("refuses a description over 1,024 characters, and not one at the limit", () => {
    expect(descriptionIssue("x".repeat(1024))).toBeNull();
    expect(descriptionIssue("x".repeat(1310))).toBe(
      "A description can be 1,024 characters at most. This one has 1,310.",
    );
  });

  it("refuses a file over 512 KB, counted in bytes", () => {
    expect(fileIssue({ path: "SKILL.md", contents: "x".repeat(512 * 1024) })).toBeNull();
    expect(fileIssue({ path: "SKILL.md", contents: "x".repeat(640 * 1024) })).toBe(
      "SKILL.md is 640 KB. A file in a skill can be 512 KB at most, so trim it.",
    );
    // Two bytes a letter: 300K letters are 600 KB.
    expect(fileIssue({ path: "a.md", contents: "é".repeat(300 * 1024) })).not.toBeNull();
  });

  it("refuses a skill over 64 files or 2 MB in all", () => {
    expect(bundleIssue([sized("SKILL.md", 500), sized("a.md", 500)])).toBeNull();
    expect(
      bundleIssue([
        sized("SKILL.md", 500),
        sized("a", 500),
        sized("b", 500),
        sized("c", 500),
        sized("d", 100),
      ]),
    ).toBe("This skill is 2.1 MB in all. A skill can be 2 MB at most, so trim a file.");
    expect(bundleIssue(Array.from({ length: 65 }, (_, index) => sized(`f${index}`, 0)))).toBe(
      "This skill has 65 files. A skill can have 64 at most.",
    );
  });

  it("refuses a new file's path that escapes the skill or is already there", () => {
    const draft = [{ path: "SKILL.md", contents: "" }];
    expect(newFileIssue("references/box.md", draft)).toBeNull();
    expect(newFileIssue("SKILL.md", draft)).toBe("SKILL.md is already in this skill.");
    expect(newFileIssue("../x.md", draft)).toBe('A path can\'t have empty, "." or ".." parts.');
    expect(newFileIssue("/etc/x", draft)).toBe(
      "Use a path inside the skill, with forward slashes, such as references/notes.md.",
    );
    expect(newFileIssue("", draft)).toBe("Type a path, such as references/notes.md.");
  });
});

describe("New skill's SKILL.md", () => {
  it("sets the name and description in the front matter and keeps the rest", () => {
    const file = "---\nname: old\ndescription: old\nlicense: MIT\n---\n\n# Body\n";
    expect(withFrontMatter(file, "pr-notes", "Write notes.")).toBe(
      "---\nname: pr-notes\ndescription: Write notes.\nlicense: MIT\n---\n\n# Body\n",
    );
  });

  it("adds the front matter, or a missing line, when the file has none", () => {
    expect(withFrontMatter("# Body\n", "a", "b")).toBe(
      "---\nname: a\ndescription: b\n---\n\n# Body\n",
    );
    expect(withFrontMatter("---\nname: a\n---\nx", "a", "b")).toBe(
      "---\nname: a\ndescription: b\n---\nx",
    );
  });

  it("quotes a description YAML would misread", () => {
    expect(withFrontMatter("# Body", "a", "Use it: always")).toContain(
      'description: "Use it: always"',
    );
  });
});

describe("search", () => {
  const skill = { name: "flaky-test-hunting", description: "Repeat a failing test 200 times." };

  it("matches the name or the description, in any case", () => {
    expect(matchesSearch(skill, "TEST")).toBe(true);
    expect(matchesSearch(skill, "200 times")).toBe(true);
    expect(matchesSearch(skill, "deploy")).toBe(false);
    expect(matchesSearch(skill, "  ")).toBe(true);
  });

  it("cuts a text at each match", () => {
    expect(highlighted("flaky-test-hunting", "test")).toEqual([
      { start: 0, text: "flaky-", match: false },
      { start: 6, text: "test", match: true },
      { start: 10, text: "-hunting", match: false },
    ]);
    expect(highlighted("abc", "")).toEqual([{ start: 0, text: "abc", match: false }]);
  });

  it("says how many match", () => {
    expect(listCountWords(4, 4, "")).toBe("4");
    expect(listCountWords(1, 4, "test")).toBe('1 of 4 match "test"');
    expect(listCountWords(0, 4, "deploy ")).toBe('none of 4 match "deploy"');
  });
});

describe("when a skill changed", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("says created for the first revision and edited after", () => {
    expect(
      rowWhen(
        { name: "a", description: "", revision: 1, updatedAt: day("2026-11-18T11:59:30Z") },
        now,
      ),
    ).toBe("Created just now");
    expect(
      rowWhen(
        { name: "a", description: "", revision: 3, updatedAt: day("2026-11-12T09:00:00Z") },
        now,
      ),
    ).toBe("Edited 12 Nov");
    expect(
      rowWhen(
        { name: "a", description: "", revision: 3, updatedAt: day("2025-11-12T09:00:00Z") },
        now,
      ),
    ).toBe("Edited 12 Nov 2025");
  });

  it("names the revision right after a save", () => {
    expect(
      panelWhen(
        { name: "a", description: "", revision: 8, updatedAt: day("2026-11-18T11:59:50Z") },
        now,
      ),
    ).toBe("Your skill, revision 8. You saved it just now.");
    expect(
      panelWhen(
        { name: "a", description: "", revision: 8, updatedAt: day("2026-11-12T09:00:00Z") },
        now,
      ),
    ).toBe("Your skill. You edited it on 12 Nov.");
    expect(
      panelWhen(
        { name: "a", description: "", revision: 1, updatedAt: day("2026-11-18T11:59:50Z") },
        now,
      ),
    ).toBe("Your skill. You created it just now.");
  });
});

describe("a project skill with the same name", () => {
  const twins = projectTwins(
    [{ name: "commit-messages" }, { name: "release-notes" }],
    [
      {
        projectId: "p1",
        projectName: "checkout-api",
        skills: [{ id: "s1", name: "commit-messages" }],
      },
      { projectId: "p2", projectName: "web", skills: [{ id: "s2", name: "lint" }] },
    ],
  );

  it("is found by name, in the project that has it", () => {
    expect(twins.get("commit-messages")).toEqual([
      { projectId: "p1", projectName: "checkout-api", skillId: "s1" },
    ]);
    expect(twins.has("release-notes")).toBe(false);
  });

  it("is named where the skill says where it is used", () => {
    expect(usedInWords("release-notes", [])).toBe("Used in every session you start.");
    expect(usedInWords("commit-messages", twins.get("commit-messages") ?? [])).toBe(
      "Used in every session you start, except in checkout-api: checkout-api has its own commit-messages, and its sessions use that one.",
    );
  });
});

describe("the editor's preview", () => {
  it("shows front matter, headings, lists, code and paragraphs as plain blocks", () => {
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
        start: 0,
        kind: "facts",
        rows: [
          ["name", "verify"],
          ["description", "Drive Mend."],
        ],
      },
      { start: 5, kind: "heading", level: 1, text: "Verify" },
      { start: 7, kind: "paragraph", text: "Build the stack inside one session." },
      {
        start: 10,
        kind: "list",
        ordered: true,
        items: [
          { start: 10, text: "Start it." },
          { start: 11, text: "Open it." },
        ],
      },
      { start: 13, kind: "code", text: "pnpm dev" },
    ]);
  });
});
