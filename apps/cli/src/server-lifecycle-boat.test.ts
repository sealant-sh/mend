import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const KEY = "boat_live_0123456789abcdefABCDEF";
const DEPLOYMENT = "1a2b3c4d-0000-4000-8000-00000000abcd";
const GATEWAY =
  "ghcr.io/sealant-sh/sealant-boat-gateway-next@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ENDPOINTS = [
  "--session-endpoint-url",
  "https://mend.example.com:8443",
  "--blob-store-public-url",
  "https://mend.example.com:10000",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Boat sessions", { timeout: 120_000 }, () => {
  it("sets Boat up from flags and the key on standard input, and keeps it across reruns and upgrades", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const withKey: ServerSetupRuntime = { ...f.runtime, readStdin: async () => `${KEY}\n` };
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--session-runtime",
          "boat",
          "--boat-deployment-id",
          DEPLOYMENT,
          "--boat-api-key-stdin",
          ...ENDPOINTS,
        ],
        withKey,
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    const env = files["server.env"] ?? "";
    expect(env).toContain(`SEALANT_BOAT_API_KEY=${KEY}\n`);
    expect(env).toContain(`SEALANT_BOAT_DEPLOYMENT_ID=${DEPLOYMENT}\n`);
    expect(env).toContain("MEND_SESSION_RUNTIME=boat\n");
    const owner = /^SEALANT_BOAT_BUILDER_OWNER=(.+)$/m.exec(env)?.[1] ?? "";
    const host = /^SEALANT_BOAT_GATEWAY_HOST_ID=(.+)$/m.exec(env)?.[1] ?? "";
    expect(owner).toMatch(UUID);
    expect(host).toMatch(UUID);
    expect(owner).not.toBe(host);
    // The key is in server.env alone: never the config, an overlay, the identity or a command line.
    for (const name of ["server.json", "compose.boat.yaml", "identity.env"])
      expect(files[name]).not.toContain(KEY);
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes(KEY)))).toBe(false);
    expect(JSON.parse(files["server.json"] ?? "{}").boat).toEqual({
      deploymentId: DEPLOYMENT,
      resources: true,
    });
    const overlay = files["compose.boat.yaml"] ?? "";
    expect(overlay).toContain("SEALANT_BOAT_GATEWAY_HOST_ID: ${SEALANT_BOAT_GATEWAY_HOST_ID");
    expect(overlay).toContain("- mend-boat-state:/var/lib/sealant/boat");
    expect(f.state().upFiles?.at(-1)).toBe("compose.boat.yaml");
    // Setup says whether the two addresses Boat VMs dial answered from here.
    expect(f.lines.join("\n")).toMatch(
      /Boat VMs reach this server for session traffic at https:\/\/mend\.example\.com:8443/,
    );
    // The gateway image the Mend image names was preloaded.
    expect(
      f.calls().some((call) => call.args.includes("inspect") && call.args.includes(GATEWAY)),
    ).toBe(true);

    // A rerun with no Boat flag keeps the key and the same derived IDs; an upgrade carries them.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    // Core adopts the deployment name and builder owner into its own record the first time it
    // starts with them set (sealant#637); an install that dropped them in that same upgrade would no
    // longer recognise its VMs and saved images. So the upgrade keeps handing both to `mend`.
    const upgraded = f.files();
    expect(upgraded["server.env"]).toContain(`SEALANT_BOAT_DEPLOYMENT_ID=${DEPLOYMENT}\n`);
    expect(upgraded["server.env"]).toContain(`SEALANT_BOAT_BUILDER_OWNER=${owner}\n`);
    expect(upgraded["compose.boat.yaml"]).toContain(
      "SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID",
    );
    expect(upgraded["compose.boat.yaml"]).toContain(
      "SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER",
    );

    // Resources off: no gateway host, and the overlay says nothing of one.
    expect(await serverCommand(["setup", "--offline", "--no-boat-resources"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.files()["server.env"]).not.toContain("SEALANT_BOAT_GATEWAY_HOST_ID");
    expect(f.files()["compose.boat.yaml"]).not.toContain("GATEWAY");

    // And forgotten: back to Docker, nothing of Boat left in the generation.
    expect(
      await serverCommand(
        ["setup", "--offline", "--no-boat", "--session-runtime", "docker"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).not.toContain("SEALANT_BOAT_");
    expect(f.files()["compose.boat.yaml"]).toBeUndefined();
  });

  it("names the Boat VMs itself when no name is given, the same on every rerun", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const withKey: ServerSetupRuntime = { ...f.runtime, readStdin: async () => KEY };
    expect(
      await serverCommand(
        ["setup", "--offline", "--session-runtime", "boat", "--boat-api-key-stdin", ...ENDPOINTS],
        withKey,
      ),
    ).toEqual({ _tag: "ok" });
    const named = () =>
      /^SEALANT_BOAT_DEPLOYMENT_ID=(.+)$/m.exec(f.files()["server.env"] ?? "")?.[1] ?? "";
    const first = named();
    expect(first).toMatch(
      /^mend-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(f.files()["server.json"] ?? "{}").boat).toEqual({ resources: true });
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(named()).toBe(first);
  });

  it("refuses resources on a Mend image that names no gateway, and a key that is not one", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const flags = [
      "setup",
      "--offline",
      "--boat-deployment-id",
      DEPLOYMENT,
      "--boat-api-key-stdin",
      ...ENDPOINTS,
    ];
    const refused = await serverCommand(flags, { ...f.runtime, readStdin: async () => KEY });
    expect(refused._tag).toBe("error");
    expect(refused._tag === "error" ? refused.message : "").toContain("--no-boat-resources");
    const notAKey = await serverCommand(flags, {
      ...f.runtime,
      readStdin: async () => "not a key\n",
    });
    expect(notAKey._tag === "error" ? notAKey.message : "").toContain(
      "--boat-api-key-stdin read no Boat API key",
    );
    // Without resources, the same image runs Boat.
    expect(
      await serverCommand([...flags, "--no-boat-resources"], {
        ...f.runtime,
        readStdin: async () => KEY,
      }),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain(`SEALANT_BOAT_API_KEY=${KEY}\n`);
  });
});
