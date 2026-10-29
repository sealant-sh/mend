import type { StoredResourceDefinition } from "@mend/db";
import { ResourceDefinitionId } from "@mend/domain";
import { ResourceDefinitionInput } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const project = ids("private-alice").project;

const definition = (name: string): StoredResourceDefinition => ({
  id: ResourceDefinitionId.make(`rdef_${name}`),
  projectId: project,
  spec: Schema.decodeUnknownSync(ResourceDefinitionInput)({
    name,
    scope: "project",
    preset: null,
    image: "rabbitmq:4",
    command: null,
    ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
    env: {},
    volumes: [],
    ready: { kind: "tcp" },
    exports: {},
  }),
  declaredBy: "alice",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("removing a project that has resources", () => {
  let api: TenancyApi | undefined;
  afterEach(async () => {
    await api?.dispose();
    api = undefined;
  });

  const removeWith = async (resources: ReadonlyArray<StoredResourceDefinition>) => {
    api = await createTenancyApi(undefined, {
      implement: {
        resources: { listForProject: () => Effect.succeed(resources) },
        store: { removeProjectStore: () => Effect.succeed({ leftover: null }) },
      },
    });
    const response = await api.request("alice", "DELETE", `/api/projects/${project}`);
    return { response, calls: [...api.world.calls] };
  };

  it("is refused with the resources named, before any session stops or the store goes", async () => {
    const { response, calls } = await removeWith([definition("db"), definition("queue")]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      _tag: "StoreFailure",
      message: "project has resources (@db, @queue) · remove them first",
    });
    expect(calls).toEqual(["resources.listForProject"]);
  });

  it("goes on past the check when the project has none", async () => {
    const { calls } = await removeWith([]);
    // The harness leaves session listing unimplemented, so the removal stops there.
    expect(calls).toEqual(["resources.listForProject", "sessions.listForProject"]);
  });
});
