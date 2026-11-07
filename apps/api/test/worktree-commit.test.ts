import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "./support/tenancy-api.ts";
import { ids } from "./support/tenancy-harness.ts";

// Owners press Commit during ordinary review, with either all files or selected paths.
describe("worktree commit API", () => {
  it("commits as the authenticated owner and refuses invisible or other people's changes", async () => {
    const calls: Array<unknown> = [];
    const api = await createTenancyApi({}, {
      implement: { engine: {
        launchUnderWay: () => false,
        commitWorktree: (sessionId, actor, input) => Effect.sync(() => {
          calls.push({ sessionId, actor, input });
          return { status: "created" as const, commitSha: "a".repeat(40), subject: "Fix parser" };
        }),
      } },
    });
    try {
      const input = { message: "Fix parser\n\nPreserve spaces", filePaths: ["src/parser.ts"] };
      const response = await api.request("alice", "POST", `/api/worktrees/${ids("private-alice").worktree}/commit`, input);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "created", subject: "Fix parser" });
      expect(calls).toEqual([{ sessionId: ids("private-alice").session, actor: "alice", input }]);
      expect((await api.request("bob", "POST", `/api/worktrees/${ids("private-alice").worktree}/commit`, input)).status).toBe(404);
      const refused = await api.request("carol", "POST", `/api/worktrees/${ids("shared-a").worktree}/commit`, input);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ _tag: "WorktreeGitRefused", code: "forbidden" });
      expect(calls).toHaveLength(1);
    } finally { await api.dispose(); }
  });
});
