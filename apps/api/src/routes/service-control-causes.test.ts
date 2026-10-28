import type { ServiceStartCause, ServiceStopCause } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

describe("the Service routes name the person who asked", () => {
  const asked: Array<{ readonly method: string; readonly cause: unknown }> = [];
  const record = (method: string, cause: ServiceStartCause | ServiceStopCause | undefined) =>
    Effect.suspend(() => {
      asked.push({ method, cause });
      return Effect.die("recorded");
    });
  let api: TenancyApi;

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            runService: (_session, _argv, _port, _name, _protocol, _scheme, cause) =>
              record("runService", cause),
            runServiceRecipe: (_session, _name, cause) => record("runServiceRecipe", cause),
            restartService: (_service, cause) => record("restartService", cause),
            stopService: (_service, cause) => record("stopService", cause),
            stopServices: (_session, cause) => record("stopServices", cause),
          },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });

  const { session, service } = ids("shared-a");
  const alice = { kind: "person", userId: "alice" };
  it.each<readonly [string, string, unknown]>([
    [
      "runService",
      `/api/sessions/${session}/services/run`,
      { argv: ["pnpm", "dev"], port: 3000, name: "web" },
    ],
    ["runServiceRecipe", `/api/sessions/${session}/services/recipe`, { name: "web" }],
    ["restartService", `/api/services/${service}/restart`, undefined],
    ["stopService", `/api/services/${service}/stop`, undefined],
    ["stopServices", `/api/sessions/${session}/services/stop`, undefined],
  ])("%s", async (method, path, body) => {
    asked.length = 0;
    await api.request("alice", "POST", path, body);
    expect(asked).toEqual([{ method, cause: alice }]);
  });
});
