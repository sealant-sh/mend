import { describe, expect, it } from "vitest";

import {
  agoWords,
  deleteFolderLine,
  folderFacts,
  planUpload,
  repositoryWords,
  stagedPath,
  toBase64,
  uploadedWords,
} from "./organization-folders.ts";

const NOW = new Date(2026, 10, 19, 12);
const before = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

const file = (path: string, size: number) => ({ path, size });

describe("Folders and references", () => {
  it("says how long ago, in words", () => {
    expect(agoWords(before(10_000), NOW)).toBe("just now");
    expect(agoWords(before(5 * HOUR), NOW)).toBe("5 hours ago");
    expect(agoWords(before(2 * 24 * HOUR), NOW)).toBe("2 days ago");
    expect(agoWords(before(21 * 24 * HOUR), NOW)).toBe("3 weeks ago");
    expect(agoWords(new Date(2026, 1, 3), NOW)).toMatch(/3/);
  });

  it("counts a folder's files and size, and says when the listing was cut short", () => {
    expect(
      folderFacts({ files: [{ bytes: 120_000 }, { bytes: 60_000 }], truncated: false }),
    ).toEqual({ count: 2, files: "2", size: "180 KB" });
    expect(folderFacts({ files: [{ bytes: 2_000 }], truncated: true }).files).toBe("5000+");
  });

  it("says what deleting a folder deletes", () => {
    expect(deleteFolderLine({ count: 12, files: "12", size: "180 KB" })).toBe(
      "Mend deletes its 12 files (180 KB). You can't undo this.",
    );
    expect(deleteFolderLine({ count: 0, files: "0", size: "0 B" })).toBe(
      "The folder is empty. You can't undo this.",
    );
    expect(deleteFolderLine(null)).toMatch(/^Mend deletes the folder/);
  });

  it("writes a repository without its scheme", () => {
    expect(repositoryWords("https://github.com/stripe/stripe-node.git")).toBe(
      "github.com/stripe/stripe-node",
    );
    expect(repositoryWords("git@github.com:northwind/api-style-guide.git")).toBe(
      "github.com/northwind/api-style-guide",
    );
  });

  it("packs an upload into requests under the cap and names what it left out", () => {
    const plan = planUpload(
      [file("a.txt", 4), file("b.txt", 4), file(".git/HEAD", 1), file("big.bin", 20), file("c", 3)],
      { file: 10, request: 8 },
    );
    expect(plan.batches.map((batch) => batch.map((entry) => entry.path))).toEqual([
      ["a.txt", "b.txt"],
      ["c"],
    ]);
    expect(plan.rejected).toEqual([
      { path: ".git/HEAD", reason: "skipped" },
      { path: "big.bin", reason: "over 1 MiB" },
    ]);
    expect(uploadedWords("runbooks", 3, plan.rejected)).toBe(
      "Added 3 files to runbooks. Left out 2 (skipped, over 1 MiB).",
    );
    expect(uploadedWords("runbooks", 1, [])).toBe("Added 1 file to runbooks.");
  });

  it("places a picked file inside the folder, and encodes it", () => {
    expect(stagedPath({ name: "x.md", webkitRelativePath: "" })).toBe("x.md");
    expect(stagedPath({ name: "x.md", webkitRelativePath: "docs/guides/x.md" })).toBe(
      "guides/x.md",
    );
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });
});
