import { describe, expect, it } from "vitest";

import {
  containsLines,
  joinFrontmatter,
  lostLines,
  mergeFrontmatterLines,
  splitFrontmatter,
  unionLines,
} from "./agent-memory-merge.ts";

/** 2,001 distinct lines, about 19 KB: past the alignment limit against another such file. */
const file = (side: string) =>
  Array.from({ length: 2001 }, (_, i) => `${side} line ${i}`).join("\n");

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

  // Review round 1, finding 3: past the alignment limit the old fallback kept a set of lines and
  // dropped every repeated one (fences, blank lines, list items) while reporting "merged".
  it("refuses files too different to align instead of dropping a line", () => {
    expect(file("mend").length).toBeGreaterThan(18_000);
    expect(unionLines(file("mend"), file("laptop"))).toBeNull();
    // The same sizes with a shared start and end still merge: only the middle is aligned.
    const shared = Array.from({ length: 3000 }, (_, i) => `shared ${i}`).join("\n");
    expect(unionLines(`${shared}\nmend\n`, `${shared}\nlaptop\n`)).toBe(
      `${shared}\nmend\nlaptop\n`,
    );
  });
});

const note = (front: string, body: string) => `---\n${front}---\n${body}`;
const merging = (
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
  base: ReadonlyArray<string> | null = null,
) => mergeFrontmatterLines({ ours, theirs, base, note: "from laptop, 2026-10-04" });

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
      merging(
        ["name: Build", "description: pnpm, not npm", "type: project"],
        ["name: Build", "description: pnpm 11, not npm", "type: project", "owner: me"],
      ),
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
      merging(
        ["name: Build", "description: old", "type: project"],
        ["name: Build v2", "description: old"],
        ["name: Build", "description: old", "type: project"],
      ),
    ).toEqual(["name: Build v2", "description: old"]);
  });

  it("does not note the same value twice", () => {
    const noted = ["description: mend's", "# from laptop, 2026-10-04: description: laptop's"];
    expect(merging(noted, ["description: laptop's"])).toEqual(noted);
  });

  // Review round 1, finding 2: comments were filtered out of the comparison, so an incoming
  // comment under an equal key was dropped.
  it("keeps a comment theirs added under a key, as content", () => {
    expect(merging(["name: Build"], ["name: Build", "# Production requires --offline"])).toEqual([
      "name: Build",
      "# Production requires --offline",
    ]);
  });

  // Review round 1, findings 2 and 5: a block scalar's indented `# New heading` is content, not a
  // comment, and a quoted key is the same key as a plain one. Neither is in the subset merged by
  // key, so the two do not merge at all, rather than lose a line or write a key twice.
  it("does not merge frontmatter outside the subset it understands", () => {
    expect(
      merging(
        ["name: Build", "description: |", "  pnpm"],
        ["name: Build", "description: |", "  pnpm", "  # New heading"],
      ),
    ).toBeNull();
    expect(merging(["name: Build"], ['"name": Compile'])).toBeNull();
    expect(merging(["name: Build", "name: Again"], ["name: Build"])).toBeNull();
    // The same frontmatter, or only one side changed against the base: no key merge needed.
    expect(merging(['"name": Compile'], ['"name": Compile'])).toEqual(['"name": Compile']);
    expect(merging(["a: |", "  x"], ["a: |", "  y"], ["a: |", "  x"])).toEqual(["a: |", "  y"]);
  });
});

// Review round 3: the check is symmetric, on the final text, with one exemption only: lines the
// other side removed since the base.
describe("what a merge did not keep", () => {
  it("names a line of either side the result lacks, counting repeats and blank lines", () => {
    const merged = "a\n```\nb\n```\n";
    expect(
      lostLines({ side: "```\nb\n```\n```\nc\n```\n", other: "", base: null, merged }),
    ).toEqual(["```", "c"]);
    expect(lostLines({ side: "a\n\nb\n", other: "", base: null, merged: "a\nb\n" })).toEqual([""]);
  });

  it("lets a line go only when the other side removed it since the base", () => {
    const base = "keep\ngone\n";
    expect(lostLines({ side: base, other: "keep\n", base, merged: "keep\n" })).toEqual([]);
    // Without a base, or when the other side still has it, the same line is lost.
    expect(lostLines({ side: base, other: "keep\n", base: null, merged: "keep\n" })).toEqual([
      "gone",
    ]);
    expect(lostLines({ side: base, other: base, base, merged: "keep\n" })).toEqual(["gone"]);
  });

  it("never exempts a repeated index entry, inside a code block or not", () => {
    const entry = "- [E](e.md)";
    for (const side of [
      `${entry}\n${entry}\n`,
      `\`\`\`\`\n\`\`\`\n${entry}\n\`\`\`\n${entry}\n\`\`\`\`\n`,
      `    ${entry}\n    ${entry}\n`,
    ]) {
      const merged = side.replace(`${entry}\n`, "");
      expect(lostLines({ side, other: "", base: null, merged }).length).toBeGreaterThan(0);
    }
  });

  it("holds a frontmatter value the merge kept as a comment, only inside the frontmatter", () => {
    expect(
      lostLines({
        side: "---\nname: b\n---\n",
        other: "---\nname: a\n---\n",
        base: null,
        merged: "---\nname: a\n# from laptop, 2026-10-01: name: b\n---\n",
      }),
    ).toEqual([]);
    expect(
      lostLines({
        side: "name: b\n",
        other: "",
        base: null,
        merged: "body\n# from laptop, 2026-10-04: name: b\n",
      }),
    ).toEqual(["name: b"]);
  });

  it("compares CRLF and LF as the same lines", () => {
    expect(lostLines({ side: "a\r\nb\r\n", other: "", base: null, merged: "a\nb\n" })).toEqual([]);
  });
});

describe("whether a kept version is the only copy of a line", () => {
  it("is not when the current file holds every line as often, with no exemption", () => {
    expect(containsLines("a\nb\nc\n", "b\na\n")).toBe(true);
    expect(containsLines("a\nb\n", "a\na\n")).toBe(false);
    expect(containsLines("base\nB\n", "base\nA\nB\n")).toBe(false);
  });
});
