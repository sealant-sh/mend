import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "./support/tenancy-api.ts";
import { ids } from "./support/tenancy-harness.ts";

describe("owner worktree pull API", () => {
  it("uses the authenticated owner and refuses another person before Git", async () => {
    const calls: unknown[] = [];
    const api = await createTenancyApi({}, { implement: { engine: {
      pullWorktree: (sessionId, actor) => Effect.sync(() => {
        calls.push({ sessionId, actor });
        return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
      }),
    } } });
    try {
      const response = await api.request("alice", "POST", `/api/worktrees/${ids("private-alice").worktree}/pull`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "pulled", refName: "main" });
      expect(calls).toEqual([{ sessionId: ids("private-alice").session, actor: "alice" }]);
      expect((await api.request("carol", "POST", `/api/worktrees/${ids("shared-a").worktree}/pull`, {})).status).toBe(409);
      expect((await api.request("bob", "POST", `/api/worktrees/${ids("private-alice").worktree}/pull`, {})).status).toBe(404);
      expect(calls).toHaveLength(1);
    } finally { await api.dispose(); }
  });
});
