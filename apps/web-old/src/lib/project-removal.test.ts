import { SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { projectRemovalFailureOf } from "#/lib/project-removal";
import { refusedRemoval, refusedWith } from "#/lib/refusal-fixture";

const WORDS =
  "not removed · Kostas's session in api-v2 is live · fix-auth holds Anna's change, which is not on origin · stop, land or remove those first, then remove the project again.";

describe("projectRemovalFailureOf", () => {
  it("shows Mend's words and names each worktree that stands in the way once", () => {
    const failure = projectRemovalFailureOf(
      refusedRemoval(WORDS, {
        scope: "project",
        forceWouldLift: false,
        blockers: [
          {
            _tag: "SessionLive",
            worktreeId: WorktreeId.make("w-2"),
            worktreeName: "api-v2",
            sessionId: SessionId.make("s-9"),
            owner: { userId: "kostas", name: "Kostas" },
            role: "inhabitant",
            activity: "live",
          },
          {
            _tag: "Unlanded",
            worktreeId: WorktreeId.make("w-1"),
            worktreeName: "fix-auth",
            owner: { userId: "anna", name: "Anna" },
            standing: { _tag: "never-landed", files: [] },
          },
          {
            _tag: "Saving",
            worktreeId: WorktreeId.make("w-2"),
            worktreeName: "api-v2",
            holds: [{ sessionId: null, kind: "saving", via: "own" }],
          },
          { _tag: "ResourcesDeclared", names: ["db"] },
        ],
      }),
    );
    expect(failure).toEqual({ words: WORDS, worktrees: ["api-v2", "fix-auth"] });
  });

  it("shows any other failure in its own words", () => {
    expect(projectRemovalFailureOf(refusedWith("NotFound", "Not found."))).toEqual({
      words: "Not found.",
      worktrees: [],
    });
    expect(projectRemovalFailureOf(new Error(""))).toEqual({
      words: "The project was not removed. Try again.",
      worktrees: [],
    });
  });
});
