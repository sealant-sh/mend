import { describe, expect, it } from "vitest";

import { refusedWith } from "#/lib/refusal-fixture";
import { forcedRemovalFailureOf, keptNote, removalRefusalOf } from "#/lib/worktree-removal";

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

describe("removalRefusalOf", () => {
  it("reads the server's words out of a StoreFailure and keeps them verbatim", () => {
    const refusal = removalRefusalOf(refusedWith("StoreFailure", WORDS));
    expect(refusal?.words).toBe(WORDS);
    expect(refusal?.forceable).toBe(true);
    expect(refusal?.unlanded).toEqual({
      files: 10,
      additions: 0,
      deletions: 0,
      named: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => ({
        path,
        additions: 0,
        deletions: 0,
      })),
      more: 5,
    });
  });

  it("offers no override for a refusal force does not lift", () => {
    const refusal = removalRefusalOf(
      refusedWith(
        "StoreFailure",
        "not removed · 1 capture saving · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved",
      ),
    );
    expect(refusal?.forceable).toBe(false);
    expect(refusal?.unlanded).toBeNull();
  });

  it("after force, says plainly what force never lifts and offers a retry only for transport", () => {
    expect(forcedRemovalFailureOf(refusedWith("StoreFailure", WORDS))).toEqual(
      removalRefusalOf(refusedWith("StoreFailure", WORDS)),
    );
    expect(
      forcedRemovalFailureOf(
        refusedWith("WorktreeActive", "A session in this worktree is live. Stop it first."),
      ),
    ).toEqual({
      words: "A session in this worktree is live. Stop it first.",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(refusedWith("WorktreeNotFound", "gone"))).toEqual({
      words: "This worktree is no longer in the store.",
      forceable: false,
      unlanded: null,
    });
    expect(
      forcedRemovalFailureOf(refusedWith("Forbidden", "Only the worktree's owner removes it.")),
    ).toEqual({
      words: "Only the worktree's owner removes it.",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(refusedWith(null, "The Mend server is not answering."))).toEqual({
      words: "The worktree was not removed · The Mend server is not answering. Try again.",
      forceable: true,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(new Error(""))).toEqual({
      words: "The worktree was not removed. Try again.",
      forceable: true,
      unlanded: null,
    });
  });

  it("counts what Clear settled kept without saying why", () => {
    expect(keptNote(0)).toBeNull();
    expect(keptNote(1)).toBe("1 kept · removal refused · remove it from its menu to see why");
    expect(keptNote(3)).toBe("3 kept · removal refused · remove one from its menu to see why");
  });

  it("is not a refusal for any other failure", () => {
    expect(removalRefusalOf(refusedWith("WorktreeActive", "1 live session"))).toBeNull();
    expect(removalRefusalOf(refusedWith(null, "The Mend server is not answering."))).toBeNull();
    expect(removalRefusalOf(refusedWith("StoreFailure", ""))).toBeNull();
    // The words alone never decide: a message that reads like a tag is still no refusal.
    expect(removalRefusalOf(new Error(`StoreFailure: ${WORDS}`))).toBeNull();
  });
});
