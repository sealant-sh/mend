import type { SessionEngine } from "@mend/sessions";
type WorktreeStart = Parameters<SessionEngine["Service"]["ensureWorktree"]>[1]["start"];
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

// Creating a standalone worktree must use the selected branch under the requester's identity.
describe("POST /projects/:id/worktrees with a target branch", () => {
  let api: TenancyApi;
  const calls: Array<{ projectId: string; start: WorktreeStart; owner: string | null }> = [];
  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            ensureWorktree: (projectId, input, owner) =>
              Effect.suspend(() => {
                calls.push({ projectId, start: input.start, owner });
                const row = api.world.worktrees.get(ids("shared-a").worktree);
                return row === undefined
                  ? Effect.die("missing fixture worktree")
                  : Effect.succeed(row);
              }),
          },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    calls.length = 0;
  });
  it("forwards the selected target with the sender identity", async () => {
    const response = await api.request(
      "alice",
      "POST",
      `/api/projects/${ids("shared-a").project}/worktrees`,
      { targetBranch: { refName: "main", newRefName: "feature/chosen" } },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        projectId: ids("shared-a").project,
        start: {
          kind: "base",
          base: null,
          targetBranch: { refName: "main", newRefName: "feature/chosen" },
        },
        owner: "alice",
      },
    ]);
  });
  it("keeps old clients working", async () => {
    expect(
      (await api.request("alice", "POST", `/api/projects/${ids("shared-a").project}/worktrees`, {}))
        .status,
    ).toBe(200);
    expect(calls[0]?.start).toEqual({ kind: "base", base: null });
  });
  it("does not provision another person's private project", async () => {
    expect(
      (
        await api.request(
          "bob",
          "POST",
          `/api/projects/${ids("private-alice").project}/worktrees`,
          { targetBranch: { refName: "main" } },
        )
      ).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
