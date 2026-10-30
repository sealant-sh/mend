import { SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { refusedRemoval, refusedWith } from "#/lib/refusal-fixture";
import { forcedRemovalFailureOf, keptNote, removalRefusalOf } from "#/lib/worktree-removal";

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

const files = Array.from({ length: 10 }, (_, index) => ({
  path: `${"abcdefghij"[index] ?? "z"}.ts`,
  additions: 0,
  deletions: 0,
}));

const ref = { worktreeId: WorktreeId.make("worktree-1"), worktreeName: "fix-login" };

const neverLanded = refusedRemoval(WORDS, {
  scope: "worktree",
  forceWouldLift: true,
  blockers: [{ _tag: "Unlanded", ...ref, owner: null, standing: { _tag: "never-landed", files } }],
});

const live = refusedRemoval("not removed · Ada's session 22222222 is live · stop it first.", {
  scope: "worktree",
  forceWouldLift: false,
  blockers: [
    {
      _tag: "SessionLive",
      ...ref,
      sessionId: SessionId.make("22222222"),
      owner: { userId: "ada", name: "Ada" },
      role: "inhabitant",
      activity: "live",
    },
  ],
});

describe("removalRefusalOf", () => {
  it("lays out what is not on origin from the refusal's blockers, and keeps the words verbatim", () => {
    const refusal = removalRefusalOf(neverLanded);
    expect(refusal?.words).toBe(WORDS);
    expect(refusal?.forceable).toBe(true);
    expect(refusal?.unlanded).toEqual({
      files: 10,
      additions: 0,
      deletions: 0,
      named: files.slice(0, 5),
      more: 5,
    });
  });

  it("offers no override when a blocker force does not lift stands", () => {
    const refusal = removalRefusalOf(live);
    expect(refusal?.words).toBe("not removed · Ada's session 22222222 is live · stop it first.");
    expect(refusal?.forceable).toBe(false);
    expect(refusal?.unlanded).toBeNull();
  });

  it("shows whose change it is for a caller who did not start it, with no override", () => {
    expect(
      removalRefusalOf(
        refusedWith(
          "RemovalForbidden",
          "not removed · only Ada, who started this worktree's change, removes it.",
        ),
      ),
    ).toEqual({
      words: "not removed · only Ada, who started this worktree's change, removes it.",
      forceable: false,
      unlanded: null,
    });
  });

  it("is not a refusal for any other failure, nor for blockers that do not decode", () => {
    expect(removalRefusalOf(refusedWith(null, "The Mend server is not answering."))).toBeNull();
    expect(removalRefusalOf(refusedWith("StoreFailure", WORDS))).toBeNull();
    expect(removalRefusalOf(refusedRemoval(WORDS, { scope: "worktree", blockers: [] }))).toBeNull();
    // The words alone never decide: a message that reads like a refusal is still none.
    expect(removalRefusalOf(new Error(`RemovalRefused: ${WORDS}`))).toBeNull();
  });
});

describe("forcedRemovalFailureOf", () => {
  it("after force, says plainly what force never lifts and offers a retry only for transport", () => {
    expect(forcedRemovalFailureOf(live)).toEqual(removalRefusalOf(live));
    expect(forcedRemovalFailureOf(refusedWith("WorktreeNotFound", "gone"))).toEqual({
      words: "This worktree is no longer in the store.",
      forceable: false,
      unlanded: null,
    });
    expect(forcedRemovalFailureOf(refusedWith("StoreFailure", "git said no"))).toEqual({
      words: "git said no",
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
});

describe("keptNote", () => {
  it("counts what Clear settled kept without saying why", () => {
    expect(keptNote(0)).toBeNull();
    expect(keptNote(1)).toBe("1 kept · removal refused · remove it from its menu to see why");
    expect(keptNote(3)).toBe("3 kept · removal refused · remove one from its menu to see why");
  });
});
