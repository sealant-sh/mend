import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_SKILL_FILE_BYTES, readFrontmatterDescription, scanSkillLibrary } from "./skills.ts";

const tmpLibrary = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-skills-"));

const writeSkill = (root: string, name: string, skillMd: string) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "SKILL.md"), skillMd);
};

describe("readFrontmatterDescription", () => {
  it("reads plain and quoted single-line scalars", () => {
    expect(readFrontmatterDescription("---\nname: x\ndescription: Do the thing.\n---\nBody")).toBe(
      "Do the thing.",
    );
    expect(readFrontmatterDescription('---\ndescription: "Quoted, with: colon"\n---\n')).toBe(
      "Quoted, with: colon",
    );
  });

  it("reads absent, foldy, or frontmatter-less descriptions as empty", () => {
    expect(readFrontmatterDescription("No frontmatter at all")).toBe("");
    expect(readFrontmatterDescription("---\nname: x\n---\nBody")).toBe("");
    expect(readFrontmatterDescription("---\ndescription: >-\n  folded\n---\n")).toBe("");
  });
});

describe("scanSkillLibrary", () => {
  it("collects bundles with their support files; non-skill dirs get a note", () => {
    const root = tmpLibrary();
    writeSkill(root, "code-review", "---\ndescription: Review changes.\n---\nHow to review.");
    fs.mkdirSync(path.join(root, "code-review", "references"));
    fs.writeFileSync(path.join(root, "code-review", "references", "notes.md"), "extra\n");
    fs.mkdirSync(path.join(root, "not-a-skill"));
    fs.writeFileSync(path.join(root, "loose-file.md"), "ignored\n");

    const result = scanSkillLibrary(root);
    if ("error" in result) throw new Error(result.error);
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0];
    expect(skill?.name).toBe("code-review");
    expect(skill?.description).toBe("Review changes.");
    expect(skill?.files.map((file) => file.path)).toEqual(["SKILL.md", "references/notes.md"]);
    expect(result.notes).toEqual([{ skill: "not-a-skill", message: "no SKILL.md — skipped" }]);
  });

  it("skips binary and oversized files with a note, keeping the bundle", () => {
    const root = tmpLibrary();
    writeSkill(root, "with-junk", "---\ndescription: d\n---\n");
    fs.writeFileSync(path.join(root, "with-junk", "blob.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(root, "with-junk", "big.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1));

    const result = scanSkillLibrary(root);
    if ("error" in result) throw new Error(result.error);
    expect(result.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(result.notes.map((note) => note.message).toSorted()).toEqual([
      "big.md is over 512KB — skipped",
      "blob.bin is binary — skipped",
    ]);
  });

  it.each(["back", "references/back"])(
    "keeps a valid bundle when %s links to an ancestor directory",
    (link) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-skill-cycle-"));
      try {
        writeSkill(root, "good", "---\ndescription: A small skill.\n---\nUse notes.md.\n");
        const skillDir = path.join(root, "good");
        fs.writeFileSync(path.join(skillDir, "notes.md"), "notes\n");
        fs.mkdirSync(path.dirname(path.join(skillDir, link)), { recursive: true });
        fs.symlinkSync(skillDir, path.join(skillDir, link), "dir");

        const result = scanSkillLibrary(root);
        if ("error" in result) throw new Error(result.error);
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "notes.md"]);
        expect(result.skills[0]?.bytes).toBe(
          Buffer.byteLength("---\ndescription: A small skill.\n---\nUse notes.md.\nnotes\n"),
        );
        expect(result.notes).toEqual([
          { skill: "good", message: `${link} points to an ancestor directory — skipped` },
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("retains separate resource directory aliases and linked files at their bundle paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-skill-cycle-"));
    try {
      writeSkill(root, "good", "Use resources/notes.md or either alias.\n");
      const skillDir = path.join(root, "good");
      fs.mkdirSync(path.join(skillDir, "resources"));
      fs.writeFileSync(path.join(skillDir, "resources", "notes.md"), "resource notes\n");
      fs.symlinkSync("resources", path.join(skillDir, "alias-a"), "dir");
      fs.symlinkSync("resources", path.join(skillDir, "alias-b"), "dir");
      fs.symlinkSync("resources/notes.md", path.join(skillDir, "linked.md"), "file");
      fs.symlinkSync("missing", path.join(skillDir, "dangling"), "dir");

      const result = scanSkillLibrary(root);
      if ("error" in result) throw new Error(result.error);
      expect(result.skills[0]?.files).toEqual([
        { path: "SKILL.md", contents: "Use resources/notes.md or either alias.\n" },
        { path: "alias-a/notes.md", contents: "resource notes\n" },
        { path: "alias-b/notes.md", contents: "resource notes\n" },
        { path: "linked.md", contents: "resource notes\n" },
        { path: "resources/notes.md", contents: "resource notes\n" },
      ]);
      expect(result.notes).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans a top-level linked skill and its linked external resource directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-skill-cycle-"));
    try {
      const library = path.join(root, "library");
      fs.mkdirSync(library);
      writeSkill(root, "source", "Read references/notes.md.\n");
      fs.mkdirSync(path.join(root, "resources"));
      fs.writeFileSync(path.join(root, "resources", "notes.md"), "external notes\n");
      fs.symlinkSync("../resources", path.join(root, "source", "references"), "dir");
      fs.symlinkSync("../source", path.join(library, "linked-skill"), "dir");

      const result = scanSkillLibrary(library);
      if ("error" in result) throw new Error(result.error);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.name).toBe("linked-skill");
      expect(result.skills[0]?.files).toEqual([
        { path: "SKILL.md", contents: "Read references/notes.md.\n" },
        { path: "references/notes.md", contents: "external notes\n" },
      ]);
      expect(result.notes).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unreadable root is an error, not an empty success", () => {
    const result = scanSkillLibrary(path.join(tmpLibrary(), "missing"));
    expect("error" in result).toBe(true);
  });
});
