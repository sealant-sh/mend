import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { forcedRemovalFailureOf, keptNote, removalRefusalOf } from "#/lib/worktree-removal";

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

describe("removalRefusalOf", () => {
  it("reads the server's words out of a StoreFailure and keeps them verbatim", () => {
    const refusal = removalRefusalOf(new TRPCClientError(`StoreFailure: ${WORDS}`));
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
      new Error(
        "StoreFailure: not removed · 1 capture saving · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved",
      ),
    );
    expect(refusal?.forceable).toBe(false);
    expect(refusal?.unlanded).toBeNull();
  });

  it("after force, says plainly what force never lifts and offers a retry only for transport", () => {
    expect(forcedRemovalFailureOf(new TRPCClientError(`StoreFailure: ${WORDS}`))).toEqual(
      removalRefusalOf(new Error(`StoreFailure: ${WORDS}`)),
    );
    expect(forcedRemovalFailureOf(new Error("WorktreeActive"))).toEqual({
      words: "A session in this worktree is live. Stop it first.",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(new Error("WorktreeNotFound: gone"))).toEqual({
      words: "This worktree is no longer in the store.",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(new Error("Forbidden: not the owner"))).toEqual({
      words: "Forbidden: not the owner",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(new Error("mend api unreachable"))).toEqual({
      words: "The worktree was not removed · mend api unreachable. Try again.",
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
    expect(removalRefusalOf(new Error("WorktreeActive: 1 live session"))).toBeNull();
    expect(removalRefusalOf(new Error("mend api unreachable"))).toBeNull();
    expect(removalRefusalOf(new Error("StoreFailure: "))).toBeNull();
    expect(removalRefusalOf("StoreFailure: a string, not an Error")).toEqual({
      words: "a string, not an Error",
      forceable: false,
      unlanded: null,
    });
  });
});
