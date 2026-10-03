import { describe, expect, it } from "vitest";

import {
  isAgentMemoryIndex,
  joinFrontmatter,
  mergeFrontmatterLines,
  splitFrontmatter,
  unionLines,
  withoutRepeatedLines,
} from "./agent-memory-merge.ts";

describe("both versions' lines with no shared version", () => {
  it("keeps each shared line once, in place, with ours' own lines before theirs'", () => {
    const ours = "# Memory\n- [a](a.md) — one\n- [mine](m.md) — mend\n- [z](z.md) — last\n";
    const theirs = "# Memory\n- [a](a.md) — one\n- [laptop](l.md) — laptop\n- [z](z.md) — last\n";
    expect(unionLines(ours, theirs)).toBe(
      "# Memory\n- [a](a.md) — one\n- [mine](m.md) — mend\n- [laptop](l.md) — laptop\n- [z](z.md) — last\n",
    );
  });

  it("keeps both versions of a changed line, ours first", () => {
    expect(unionLines("- build with pnpm\n", "- build with pnpm 11\n")).toBe(
      "- build with pnpm\n- build with pnpm 11\n",
    );
  });

  it("keeps a block theirs added whole, fences and blank lines included", () => {
    const ours = "Intro\n\n```sh\npnpm test\n```\n";
    const theirs = "Intro\n\n```sh\npnpm test\n```\n\nThen:\n\n```sh\npnpm lint\n```\n";
    expect(unionLines(ours, theirs)).toBe(theirs);
  });

  it("returns the other side when one is empty, and a newline when either ends with one", () => {
    expect(unionLines("", "a\n")).toBe("a\n");
    expect(unionLines("a\n", "")).toBe("a\n");
    expect(unionLines("a", "a\nb\n")).toBe("a\nb\n");
  });
});

describe("an index keeps each line once", () => {
  it("names MEMORY.md, at any depth, as an index", () => {
    expect(isAgentMemoryIndex(".claude/projects/-workspace-repo/memory/MEMORY.md")).toBe(true);
    expect(isAgentMemoryIndex("MEMORY.md")).toBe(true);
    expect(isAgentMemoryIndex(".claude/projects/-workspace-repo/memory/notes.md")).toBe(false);
  });

  it("drops later copies of a non-blank line and keeps blank lines", () => {
    expect(withoutRepeatedLines("- a\n\n- b\n- a\n\n- b\n- c\n")).toBe("- a\n\n- b\n\n- c\n");
  });
});

const note = (front: string, body: string) => `---\n${front}---\n${body}`;

describe("frontmatter", () => {
  it("splits and joins a note as it was", () => {
    const text = note("name: Build\ndescription: how to build\ntype: project\n", "pnpm\n");
    const split = splitFrontmatter(text);
    expect(split).toEqual({
      lines: ["name: Build", "description: how to build", "type: project"],
      body: "pnpm\n",
    });
    if (split === null) throw new Error("has frontmatter");
    expect(joinFrontmatter(split)).toBe(text);
    expect(splitFrontmatter("no frontmatter\n")).toBeNull();
    expect(splitFrontmatter("---\nname: x\n---")).toEqual({ lines: ["name: x"], body: "" });
  });

  it("with no shared version: a key both set differently keeps ours and notes theirs", () => {
    expect(
      mergeFrontmatterLines({
        ours: ["name: Build", "description: pnpm, not npm", "type: project"],
        theirs: ["name: Build", "description: pnpm 11, not npm", "type: project", "owner: me"],
        base: null,
        note: "from laptop, 2026-10-04",
      }),
    ).toEqual([
      "name: Build",
      "description: pnpm, not npm",
      "# from laptop, 2026-10-04: description: pnpm 11, not npm",
      "type: project",
      "owner: me",
    ]);
  });

  it("against a shared version: takes the side that changed a key, and removals", () => {
    expect(
      mergeFrontmatterLines({
        ours: ["name: Build", "description: old", "type: project"],
        theirs: ["name: Build v2", "description: old"],
        base: ["name: Build", "description: old", "type: project"],
        note: "from laptop, 2026-10-04",
      }),
    ).toEqual(["name: Build v2", "description: old"]);
  });

  it("does not note the same value twice, and keeps ours' notes when theirs is the change", () => {
    const noted = ["description: mend's", "# from laptop, 2026-10-03: description: laptop's"];
    expect(
      mergeFrontmatterLines({
        ours: noted,
        theirs: ["description: laptop's"],
        base: null,
        note: "from laptop, 2026-10-04",
      }),
    ).toEqual([...noted, "# from laptop, 2026-10-04: description: laptop's"]);
    expect(
      mergeFrontmatterLines({
        ours: noted,
        theirs: ["description: newer"],
        base: ["description: mend's"],
        note: "from laptop, 2026-10-04",
      }),
    ).toEqual(["description: newer", "# from laptop, 2026-10-03: description: laptop's"]);
  });
});
