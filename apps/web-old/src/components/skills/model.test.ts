import { describe, expect, it } from "vitest";

import { bundleShape, changedFiles, changedLines, formatBundleSize, shownFile } from "./model";

describe("skill library words", () => {
  it("states a bundle's shape the way the library lists it", () => {
    expect(formatBundleSize(812)).toBe("812 B");
    expect(formatBundleSize(22 * 1024 + 300)).toBe("22 KB");
    expect(formatBundleSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(bundleShape({ fileCount: 1, bytes: 6 * 1024 })).toBe("1 file · 6 KB");
    expect(bundleShape({ fileCount: 6, bytes: 38 * 1024 })).toBe("6 files · 38 KB");
  });
});

describe("a skill draft", () => {
  const saved = [
    { path: "SKILL.md", contents: "a\nb\nc" },
    { path: "notes.md", contents: "x" },
  ];

  it("counts edited, added and removed files", () => {
    expect(changedFiles(saved, saved)).toEqual([]);
    expect(
      changedFiles(saved, [
        { path: "SKILL.md", contents: "a\nb\nc\nd" },
        { path: "more.md", contents: "" },
      ]),
    ).toEqual(["SKILL.md", "notes.md", "more.md"]);
  });

  it("marks only an inserted line, not the lines after it", () => {
    expect([...changedLines("a\nb\nc", "a\nnew\nb\nc")]).toEqual([1]);
    expect([...changedLines("a\nb\nc", "a\nb\nc\nd")]).toEqual([3]);
    expect([...changedLines("a\nb", "a\nb")]).toEqual([]);
  });

  it("shows the requested file, else SKILL.md", () => {
    expect(shownFile(saved, "notes.md")?.path).toBe("notes.md");
    expect(shownFile(saved, "gone.md")?.path).toBe("SKILL.md");
    expect(shownFile(saved, undefined)?.path).toBe("SKILL.md");
  });
});
