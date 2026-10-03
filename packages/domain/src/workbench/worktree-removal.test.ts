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
