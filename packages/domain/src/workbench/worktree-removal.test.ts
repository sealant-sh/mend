import { describe, expect, it } from "vitest";

import {
  describeUnlanded,
  unlandedFactsOf,
  WORKTREE_REMOVAL_FORCE_HINT,
  worktreeRemovalRefusalOf,
} from "./worktree-removal.ts";

const file = (path: string, additions: number, deletions: number) => ({
  path,
  additions,
  deletions,
});

/** The server's never-landed refusal around what `describeUnlanded` writes for `files`. */
const neverLanded = (
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
): string =>
  `This worktree holds a change that was never landed · ${describeUnlanded(files)}. Land it or discard it before removal, ${WORKTREE_REMOVAL_FORCE_HINT}.`;

const NEVER_LANDED =
  "This worktree holds a change that was never landed · 2 files · +13 −3 · src/login.ts +12 −3, notes.md +1 −0. Land it or discard it before removal, or pass force=true to remove it anyway.";

describe("describeUnlanded", () => {
  it("names up to five files with their line counts and counts the rest", () => {
    const files = Array.from({ length: 7 }, (_, index) => file(`src/f${index}.ts`, index, 1));
    expect(describeUnlanded(files)).toBe(
      "7 files · +21 −7 · src/f0.ts +0 −1, src/f1.ts +1 −1, src/f2.ts +2 −1, src/f3.ts +3 −1, src/f4.ts +4 −1, 2 more",
    );
    expect(describeUnlanded([file("a.ts", 1, 0)])).toBe("1 file · +1 −0 · a.ts +1 −0");
  });
});

describe("unlandedFactsOf", () => {
  it("reads back what describeUnlanded wrote", () => {
    const files = Array.from({ length: 7 }, (_, index) => file(`src/f${index}.ts`, index, 1));
    expect(
      unlandedFactsOf(
        `This worktree holds a change that was never landed · ${describeUnlanded(files)}. Land it or discard it before removal, ${WORKTREE_REMOVAL_FORCE_HINT}.`,
      ),
    ).toEqual({
      files: 7,
      additions: 21,
      deletions: 7,
      named: files.slice(0, 5),
      more: 2,
    });
  });

  it("reads the files of a change that changed since its last landing", () => {
    expect(
      unlandedFactsOf(
        "This worktree changed since its last landing (mend/fix-login · 3f2a1c0) · 1 file · +2 −1 · a.ts +2 −1. Land it again or discard it before removal, or pass force=true to remove it anyway.",
      ),
    ).toEqual({ files: 1, additions: 2, deletions: 1, named: [file("a.ts", 2, 1)], more: 0 });
  });

  it("keeps a path with a dot or a space whole", () => {
    expect(
      unlandedFactsOf(
        "This worktree holds a change that was never landed · 2 files · +1 −1 · docs/v1.2 notes.md +1 −0, src/a b.ts +0 −1. Land it or discard it before removal, or pass force=true to remove it anyway.",
      )?.named,
    ).toEqual([file("docs/v1.2 notes.md", 1, 0), file("src/a b.ts", 0, 1)]);
  });

  it("keeps a path that holds the closing sentence's first words whole", () => {
    expect(
      unlandedFactsOf(
        `This worktree holds a change that was never landed · ${describeUnlanded([file("notes. Draft.md", 1, 0)])}. Land it or discard it before removal, ${WORKTREE_REMOVAL_FORCE_HINT}.`,
      )?.named,
    ).toEqual([file("notes. Draft.md", 1, 0)]);
  });

  it("reads nothing rather than guessing when the words are ambiguous", () => {
    // A comma and space inside a path reads as two items.
    expect(unlandedFactsOf(neverLanded([file("src/a, b.ts", 1, 0)]))).toBeNull();
    // A path that reads like the count of the rest.
    expect(unlandedFactsOf(neverLanded([file("2 more, report.md", 1, 0)]))).toBeNull();
    // Only the last item is the count of the rest: a file named like it is still a file.
    expect(
      unlandedFactsOf(neverLanded([file("2 more", 1, 0), file("report.md", 1, 0)]))?.named,
    ).toEqual([file("2 more", 1, 0), file("report.md", 1, 0)]);
    // Counts that do not agree with the list.
    expect(
      unlandedFactsOf(
        "This worktree holds a change that was never landed · 3 files · +1 −0 · a.ts +1 −0. Land it or discard it before removal, or pass force=true to remove it anyway.",
      ),
    ).toBeNull();
    expect(
      unlandedFactsOf(
        "This worktree holds a change that was never landed · 1 file · +5 −0 · a.ts +1 −0. Land it or discard it before removal, or pass force=true to remove it anyway.",
      ),
    ).toBeNull();
    expect(unlandedFactsOf("")).toBeNull();
  });

  it("reads back every shape describeUnlanded writes for ordinary paths", () => {
    for (const count of [1, 2, 5, 6, 12]) {
      const files = Array.from({ length: count }, (_, index) =>
        file(`src/dir-${index}/file.v${index}.test.ts`, index * 3, index),
      );
      const facts = unlandedFactsOf(
        `This worktree changed since its last landing (mend/x · 3f2a1c0) · ${describeUnlanded(files)}. Land it again or discard it before removal, ${WORKTREE_REMOVAL_FORCE_HINT}.`,
      );
      expect(facts?.files).toBe(count);
      expect(facts?.named).toEqual(files.slice(0, 5));
      expect(facts?.more).toBe(Math.max(0, count - 5));
    }
  });

  it("finds no facts in a refusal that names none", () => {
    expect(
      unlandedFactsOf(
        "origin's mend/fix-login no longer holds the landed commit 3f2a1c0 · the branch is gone. Land it again before removal, or pass force=true to remove it anyway.",
      ),
    ).toBeNull();
    expect(
      unlandedFactsOf("not removed · 1 capture saving · the worktree stays until it has saved"),
    ).toBeNull();
  });
});

describe("worktreeRemovalRefusalOf", () => {
  it("offers force only for a refusal the server says force lifts", () => {
    const unlanded = worktreeRemovalRefusalOf(NEVER_LANDED);
    expect(unlanded.words).toBe(NEVER_LANDED);
    expect(unlanded.forceable).toBe(true);
    expect(unlanded.unlanded?.files).toBe(2);

    const saving = worktreeRemovalRefusalOf(
      "not removed · 1 capture saving · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved",
    );
    expect(saving.forceable).toBe(false);
    expect(saving.unlanded).toBeNull();
  });
});
