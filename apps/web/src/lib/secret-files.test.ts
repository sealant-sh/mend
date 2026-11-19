import { describe, expect, it } from "vitest";

import { formatBytes, homeRelative, secretFileProblem } from "./secret-files.ts";

describe("secret file paths", () => {
  it("reads a typed ~/ path as relative to the home folder", () => {
    expect(homeRelative("~/.aws/credentials")).toBe(".aws/credentials");
    expect(homeRelative("  .npmrc ")).toBe(".npmrc");
  });

  it("refuses a path outside the home folder, or one sessions capture, before sending", () => {
    expect(secretFileProblem("", null)).toBeNull();
    expect(secretFileProblem("~/.npmrc", null)).toBeNull();
    expect(secretFileProblem("~/../etc/passwd", null)).toBe(
      "~/../etc/passwd leaves your home folder.",
    );
    expect(secretFileProblem("/etc/passwd", null)).toContain("Mend can't keep a file there");
    expect(secretFileProblem("~/.claude/settings.json", null)).toContain("which sessions capture");
  });

  it("refuses a chosen file over the size limit", () => {
    expect(secretFileProblem("~/.npmrc", { name: "big.bin", bytes: 300 * 1024 })).toBe(
      "big.bin is larger than 256 KB.",
    );
  });

  it("writes sizes as a person reads them", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(4200)).toBe("4.1 KB");
  });
});
