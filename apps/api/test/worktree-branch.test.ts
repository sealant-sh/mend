import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "./support/tenancy-api.ts";
import { ids } from "./support/tenancy-harness.ts";

// Someone chooses a branch in an ordinary T3 thread. Visibility and the actor must reach
// the engine before Git runs; the engine independently enforces change ownership.
describe("worktree branch API", () => {
  it("routes the visible worktree and the authenticated person to the engine", async () => {
    const calls: Array<unknown> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            changeWorktreeBranch: (sessionId, actor, action) =>
              Effect.sync(() => {
                calls.push({ sessionId, actor, action });
                return { refName: "feature/chosen", branch: "feature/chosen" };
              }),
          },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "POST",
        `/api/worktrees/${ids("private-alice").worktree}/branch`,
        { kind: "create", refName: "feature/chosen", switchRef: true },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        refName: "feature/chosen",
        branch: "feature/chosen",
      });
      expect(calls).toEqual([
        {
          sessionId: ids("private-alice").session,
          actor: "alice",
          action: { kind: "create", refName: "feature/chosen", switchRef: true },
        },
      ]);
      const invisible = await api.request(
        "bob",
        "POST",
        `/api/worktrees/${ids("private-alice").worktree}/branch`,
        { kind: "switch", refName: "main" },
      );
      expect(invisible.status).toBe(404);
      expect(calls).toHaveLength(1);
      const nonOwner = await api.request(
        "carol",
        "POST",
        `/api/worktrees/${ids("shared-a").worktree}/branch`,
        { kind: "switch", refName: "main" },
      );
      expect(nonOwner.status).toBe(409);
      expect(await nonOwner.json()).toMatchObject({
        _tag: "WorktreeGitRefused",
        code: "forbidden",
      });
      expect(calls).toHaveLength(1);
    } finally {
      await api.dispose();
    }
  });
});
