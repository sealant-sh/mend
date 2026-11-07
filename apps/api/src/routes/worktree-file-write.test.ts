import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

describe("PUT worktree contents", () => {
  it("lets the change owner write and grants teammates the first session's shared control", async () => {
    const writes: Array<{ path: string; contents: string; sender: string }> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            writeWorktreeFile: (_session, path, contents, sender) =>
              Effect.sync(() => {
                writes.push({ path, contents, sender });
              }),
          },
        },
      },
    );
    try {
      const work = ids("shared-a");
      const route = `/api/worktrees/${work.worktree}/contents`;
      const payload = { path: "docs/plan.md", contents: "# Plan\n" };
      expect((await api.request("carol", "PUT", route, payload)).status).toBe(403);
      expect((await api.request("bob", "PUT", route, payload)).status).toBe(404);
      expect(writes).toEqual([]);
      expect((await api.request("alice", "PUT", route, payload)).status).toBe(200);
      expect(
        (
          await api.request("alice", "PUT", `/api/sessions/${work.session}/shared-control`, {
            enabled: true,
          })
        ).status,
      ).toBe(200);
      expect((await api.request("carol", "PUT", route, payload)).status).toBe(200);
      expect(writes).toEqual([
        { ...payload, sender: "alice" },
        { ...payload, sender: "carol" },
      ]);
      for (const path of ["../outside", "/etc/passwd", ".git/config", "dir/.git/config"]) {
        expect((await api.request("alice", "PUT", route, { ...payload, path })).status).toBe(422);
      }
      expect(writes).toHaveLength(2);
    } finally {
      await api.dispose();
    }
  });
});
