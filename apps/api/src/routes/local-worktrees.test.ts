import { Worktree } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { CAROL_WORKTREE_IN_SHARED_A, ids } from "../../test/support/tenancy-harness.ts";

const decodeWorktree = Schema.decodeUnknownSync(Schema.toCodecJson(Worktree));

describe("shared Local worktree HTTP API", () => {
  it("reads without creating and starts the same default-branch worktree for different project viewers", async () => {
    let created: Worktree | null = null;
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            ensureWorktree: (projectId, input) =>
              Effect.sync(() => {
                if (input.start.kind !== "local")
                  throw new Error("Local start must name its stable allocation");
                if (created !== null) return created;
                const template = api.world.worktrees.get(CAROL_WORKTREE_IN_SHARED_A);
                const project = api.world.projects.get(projectId);
                if (template === undefined || project === undefined)
                  throw new Error("fixture project missing");
                created = new Worktree({
                  ...template,
                  id: input.start.worktreeId,
                  projectId,
                  name: "local",
                  directory: `local-${input.start.worktreeId}`,
                  branch: project.defaultBranch,
                  baseRef: project.defaultBranch,
                });
                api.world.addWorktree(created);
                return created;
              }),
          },
        },
      },
    );
    const url = `/api/projects/${ids("shared-a").project}/local-worktree`;
    try {
      const before = await api.request("alice", "GET", url);
      expect(before.status).toBe(200);
      expect(await before.json()).toBeNull();
      expect(created).toBeNull();
      const started = await api.request("alice", "POST", url, {});
      expect(started.status).toBe(200);
      const first = decodeWorktree(await started.json());
      const second = await api.request("carol", "POST", url, {});
      expect(second.status).toBe(200);
      expect(decodeWorktree(await second.json()).id).toBe(first.id);
      const after = await api.request("carol", "GET", url);
      expect(decodeWorktree(await after.json()).id).toBe(first.id);
      const hidden = await api.request("bob", "POST", url, {});
      expect(hidden.status).toBe(404);
    } finally {
      await api.dispose();
    }
  });
});
