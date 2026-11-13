import { afterEach, describe, expect, it } from "vitest";

import { ENDPOINTS, GATEWAY } from "./server-lifecycle-boat-test-fixtures.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Boat sessions: taking Boat away", { timeout: 120_000 }, () => {
  it("forgets Boat with --no-boat: sessions run on Docker, and nothing of Boat is left", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--session-runtimes", "boat,docker", ...ENDPOINTS],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_SESSION_RUNTIME=boat\n");

    // Resources off: no gateway host, and the overlay says nothing of one.
    expect(await serverCommand(["setup", "--offline", "--no-boat-resources"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.files()["server.env"]).not.toContain("SEALANT_BOAT_GATEWAY_HOST_ID");
    expect(f.files()["compose.boat.yaml"]).not.toContain("GATEWAY");

    expect(await serverCommand(["setup", "--offline", "--no-boat"], f.runtime)).toEqual({
      _tag: "ok",
    });
    const env = f.files()["server.env"] ?? "";
    expect(env).not.toContain("SEALANT_BOAT_");
    expect(env).toContain("MEND_SESSION_RUNTIME=docker\n");
    expect(env).toContain("MEND_SESSION_RUNTIMES=docker\n");
    expect(f.files()["compose.boat.yaml"]).toBeUndefined();
    const config = JSON.parse(f.files()["server.json"] ?? "{}");
    expect([config.boat, config.sessionRuntime, config.sessionRuntimes]).toEqual([
      undefined,
      "docker",
      ["docker"],
    ]);
  });
});
