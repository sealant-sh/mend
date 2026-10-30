import { ProjectHasResourcesError } from "@mend/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const project = ids("private-alice").project;

describe("removing a project that has resources", () => {
  let api: TenancyApi | undefined;
  afterEach(async () => {
    await api?.dispose();
    api = undefined;
  });

  const removeWith = async (names: ReadonlyArray<string>) => {
    api = await createTenancyApi(undefined, {
      implement: {
        resources: {
          fenceProjectRemoval: (projectId) =>
            names.length === 0
              ? Effect.void
              : Effect.fail(new ProjectHasResourcesError({ projectId, names })),
          liftProjectRemovalFence: () => Effect.void,
        },
        store: { removeProjectStore: () => Effect.succeed({ leftover: null }) },
      },
    });
    const response = await api.request("alice", "DELETE", `/api/projects/${project}`);
    return { response, calls: [...api.world.calls] };
  };

  it("is refused with the resources named, before any session stops or the store goes", async () => {
    const { response, calls } = await removeWith(["db", "queue"]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      _tag: "StoreFailure",
      message: "project has resources (@db, @queue) · remove them first",
    });
    expect(calls).toEqual(["resources.fenceProjectRemoval"]);
  });

  it("lifts the fence when the removal stops before the project's row goes", async () => {
    const { calls } = await removeWith([]);
    // The harness leaves session listing unimplemented, so the removal stops there.
    expect(calls).toEqual([
      "resources.fenceProjectRemoval",
      "sessions.listForProject",
      "resources.liftProjectRemovalFence",
    ]);
  });
});
