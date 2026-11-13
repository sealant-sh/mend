import { afterEach, describe, expect, it } from "vitest";

import {
  DEPLOYMENT,
  ENDPOINTS,
  GATEWAY,
  UUID,
  valueIn,
} from "./server-lifecycle-boat-test-fixtures.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Boat sessions: turning Boat on", { timeout: 120_000 }, () => {
  it("turns Boat on with no key: writes none, and says who connects one", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--session-runtime", "boat", ...ENDPOINTS],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    const env = files["server.env"] ?? "";
    expect(env).not.toContain("SEALANT_BOAT_API_KEY");
    expect(env).not.toContain("SEALANT_BOAT_ORGANIZATION");
    expect(env).toContain("MEND_SESSION_RUNTIME=boat\n");
    // No name given: setup derives one from the install's identity, the same on every rerun.
    expect(valueIn(env, "SEALANT_BOAT_DEPLOYMENT_ID")).toMatch(
      /^mend-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(valueIn(env, "SEALANT_BOAT_BUILDER_OWNER")).toMatch(UUID);
    expect(valueIn(env, "SEALANT_BOAT_GATEWAY_HOST_ID")).toMatch(UUID);
    expect(JSON.parse(files["server.json"] ?? "{}").boat).toEqual({ resources: true });
    // A setting server.env does not carry reaches Core empty, which Core reads as unset: Compose
    // never stops to ask for one.
    const overlay = files["compose.boat.yaml"] ?? "";
    expect(overlay).toContain("SEALANT_BOAT_API_KEY: ${SEALANT_BOAT_API_KEY:-}");
    expect(overlay).not.toContain(":?");
    expect(overlay).toContain("- mend-boat-state:/var/lib/sealant/boat");
    expect(f.state().upFiles?.at(-1)).toBe("compose.boat.yaml");
    const said = f.lines.join("\n");
    expect(said).toContain(
      "an owner connects the organization's Boat key in Settings, Organization, Boat, or with mend boat connect",
    );
    expect(said).toContain(
      "Until an organization's key is connected, its Boat sessions are refused",
    );
    expect(said).not.toContain("API key");
    // The gateway image the Mend image names was preloaded.
    expect(
      f.calls().some((call) => call.args.includes("inspect") && call.args.includes(GATEWAY)),
    ).toBe(true);

    // A rerun keeps it; an upgrade carries it.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
  });

  it("refuses resources on a Mend image that names no gateway, and a key that is not one", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const flags = ["setup", "--offline", "--boat-deployment-id", DEPLOYMENT, ...ENDPOINTS];
    const refused = await serverCommand(flags, f.runtime);
    expect(refused._tag).toBe("error");
    expect(refused._tag === "error" ? refused.message : "").toContain("--no-boat-resources");
    const notAKey = await serverCommand([...flags, "--boat-api-key-stdin"], {
      ...f.runtime,
      readStdin: async () => "not a key\n",
    });
    expect(notAKey._tag === "error" ? notAKey.message : "").toContain(
      "--boat-api-key-stdin read no Boat key",
    );
    // Without resources, the same image runs Boat.
    expect(await serverCommand([...flags, "--no-boat-resources"], f.runtime)).toEqual({
      _tag: "ok",
    });
  });
});
