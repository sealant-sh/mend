import { describe, expect, it } from "vitest";

import { fenceInfoLanguage, fencedPieces, filePieces } from "./code-fences.ts";

const joined = (pieces: ReturnType<typeof fencedPieces>) =>
  pieces.map((piece) => piece.text).join("");

describe("fencedPieces", () => {
  it("cuts out each fenced block's code, by its language, and keeps the rest as text", () => {
    const file = [
      "# Verify",
      "",
      "```ts",
      "const a = 1;",
      "a;",
      "```",
      "",
      "Then:",
      "~~~bash",
      "pnpm dev",
      "~~~",
      "",
    ].join("\n");
    const pieces = fencedPieces(file);
    expect(pieces).toEqual([
      { start: 0, kind: "text", text: "# Verify\n\n```ts\n" },
      { start: 16, kind: "code", language: "ts", text: "const a = 1;\na;" },
      { start: 31, kind: "text", text: "\n```\n\nThen:\n~~~bash\n" },
      { start: 51, kind: "code", language: "bash", text: "pnpm dev" },
      { start: 59, kind: "text", text: "\n~~~\n" },
    ]);
    expect(joined(pieces)).toBe(file);
  });

  it("gives a fence with no language an empty one, and an empty fence no code", () => {
    const file = "```\nplain\n```\n```ts\n```\n";
    const pieces = fencedPieces(file);
    expect(pieces.filter((piece) => piece.kind === "code")).toEqual([
      { start: 4, kind: "code", language: "", text: "plain" },
    ]);
    expect(joined(pieces)).toBe(file);
  });

  it("closes a fence only on as many of its own marks, and runs an unclosed one to the end", () => {
    const file = "````md\n```ts\nx\n```\n````\nafter\n```sh\nls\n";
    const pieces = fencedPieces(file);
    expect(pieces.filter((piece) => piece.kind === "code")).toEqual([
      { start: 7, kind: "code", language: "md", text: "```ts\nx\n```" },
      { start: 36, kind: "code", language: "sh", text: "ls\n" },
    ]);
    expect(joined(pieces)).toBe(file);
  });

  it("reads a line of inline code as text, not a fence", () => {
    expect(fencedPieces("```a` b```\n")).toEqual([
      { start: 0, kind: "text", text: "```a` b```\n" },
    ]);
  });
});

describe("fenceInfoLanguage", () => {
  it("takes the info's first word", () => {
    expect(fenceInfoLanguage(' ts title="x.ts"')).toBe("ts");
    expect(fenceInfoLanguage("{.python}")).toBe("python");
    expect(fenceInfoLanguage("")).toBe("");
  });
});

describe("filePieces", () => {
  it("reads a Markdown file by its fences and any other file as code by its extension", () => {
    expect(filePieces("SKILL.md", "```sh\nls\n```\n")).toEqual(fencedPieces("```sh\nls\n```\n"));
    expect(filePieces("scripts/run.sh", "echo hi\n")).toEqual([
      { start: 0, kind: "code", language: "sh", text: "echo hi\n" },
    ]);
    expect(filePieces("notes", "```ts\nx\n```")).toEqual(fencedPieces("```ts\nx\n```"));
    expect(filePieces("empty.json", "")).toEqual([]);
  });
});
