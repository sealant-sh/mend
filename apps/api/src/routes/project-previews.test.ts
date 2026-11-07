import type { ProjectPreviewView } from "@mend/api-contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const read: ProjectPreviewView = {
  configured: true,
  fixed: null,
  url: null,
  target: null,
  status: ["Not started"],
  open: null,
  canManage: false,
};

it("refuses a target from another project even when the manager can see that worktree", async () => {
  const api = await createTenancyApi();
  const worktreeId = ids("private-alice").worktree;
  try {
    const response = await api.request(
      "alice",
      "PUT",
      `/api/projects/${ids("shared-a").project}/preview/target`,
      { _tag: "Worktree", worktreeId },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ _tag: "NotFound", id: worktreeId });
    expect(api.world.calls).toEqual([]);
  } finally {
    await api.dispose();
  }
});

it("shares the preview read with project viewers but restricts target changes and Start to project managers", async () => {
  const effects: string[] = [];
  const api = await createTenancyApi(
    {},
    {
      implement: {
        projectPreviews: {
          read: () => Effect.succeed(read),
          start: (_id, user) =>
            Effect.sync(() => {
              effects.push(`start:${user}`);
              return read;
            }),
          use: (_id, target) =>
            Effect.sync(() => {
              effects.push(`use:${target._tag}`);
              return read;
            }),
        },
      },
    },
  );
  const path = `/api/projects/${ids("shared-a").project}/preview`;
  try {
    const shared = await api.request("carol", "GET", path);
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ canManage: false, configured: true });
    expect((await api.request("bob", "GET", path)).status).toBe(404);
    expect((await api.request("carol", "POST", `${path}/start`, {})).status).toBe(404);
    expect((await api.request("carol", "PUT", `${path}/target`, { _tag: "Default" })).status).toBe(
      404,
    );
    expect(effects).toEqual([]);
    expect(
      (
        await api.request("alice", "PUT", `${path}/target`, {
          _tag: "Worktree",
          worktreeId: ids("shared-b").worktree,
        })
      ).status,
    ).toBe(404);
    expect(effects).toEqual([]);
    expect((await api.request("alice", "PUT", `${path}/target`, { _tag: "Default" })).status).toBe(
      200,
    );
    expect(
      (
        await api.request("alice", "PUT", `${path}/target`, {
          _tag: "Worktree",
          worktreeId: ids("shared-a").worktree,
        })
      ).status,
    ).toBe(200);
    expect((await api.request("alice", "POST", `${path}/start`, {})).status).toBe(200);
    expect(effects).toEqual(["use:Default", "use:Worktree", "start:alice"]);
  } finally {
    await api.dispose();
  }
});
