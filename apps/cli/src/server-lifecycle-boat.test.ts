import * as fs from "node:fs";
import * as path from "node:path";

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

/**
 * compose.boat.yaml as setup wrote it while Boat needed the server's own key (the box's today):
 * every setting required. A generation that has it must still read, start and upgrade.
 */
const REQUIRED_KEY_OVERLAY = [
  "# Written by mend server setup: Boat sessions, in the operator's own Boat account.",
  "services:",
  "  mend:",
  "    environment:",
  "      SEALANT_BOAT_API_KEY: ${SEALANT_BOAT_API_KEY:?set SEALANT_BOAT_API_KEY in server.env}",
  "      SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID:?set SEALANT_BOAT_DEPLOYMENT_ID in server.env}",
  "      SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER:?set SEALANT_BOAT_BUILDER_OWNER in server.env}",
  "      SEALANT_BOAT_STATE_DIRECTORY: /var/lib/sealant/boat",
  "      SEALANT_BOAT_GATEWAY_HOST_ID: ${SEALANT_BOAT_GATEWAY_HOST_ID:?set SEALANT_BOAT_GATEWAY_HOST_ID in server.env}",
  "    volumes:",
  "      - mend-boat-state:/var/lib/sealant/boat",
  "volumes:",
  "  mend-boat-state: {}",
  "",
].join("\n");

const valueIn = (env: string, name: string): string | undefined =>
  new RegExp(`^${name}=(.+)$`, "m").exec(env)?.[1];

describe("Boat sessions", { timeout: 120_000 }, () => {
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
    expect(valueIn(env, "SEALANT_BOAT_DEPLOYMENT_ID")).toMatch(/^mend-/);
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

  it("gives the server a key of its own on standard input, pins it to a Boat organization, and drops it", async () => {
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
          "--boat-organization",
          "Acme Labs",
          ...ENDPOINTS,
        ],
        withKey,
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    const env = files["server.env"] ?? "";
    expect(env).toContain(`SEALANT_BOAT_API_KEY=${KEY}\n`);
    expect(env).toContain("SEALANT_BOAT_ORGANIZATION=Acme Labs\n");
    expect(env).toContain(`SEALANT_BOAT_DEPLOYMENT_ID=${DEPLOYMENT}\n`);
    // The key is in server.env alone: never the config, an overlay, the identity or a command line.
    for (const name of ["server.json", "compose.boat.yaml", "identity.env"])
      expect(files[name]).not.toContain(KEY);
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes(KEY)))).toBe(false);
    expect(f.lines.join("\n")).toContain(
      "its Boat sessions run in this server's own Boat key's account (Boat organization Acme Labs), which pays for them",
    );
    const before = f.active();

    // A rerun keeps the key and its organization; --no-boat-organization drops the organization.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env);
    expect(
      await serverCommand(["setup", "--offline", "--no-boat-organization"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).not.toContain("SEALANT_BOAT_ORGANIZATION");
    expect(f.files()["server.env"]).toContain(`SEALANT_BOAT_API_KEY=${KEY}\n`);

    // Dropping the key keeps Boat and its names, and says the earlier generations still hold it.
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--no-boat-api-key"], f.runtime)).toEqual({
      _tag: "ok",
    });
    const dropped = f.files()["server.env"] ?? "";
    expect(dropped).not.toContain("SEALANT_BOAT_API_KEY");
    expect(dropped).toContain(`SEALANT_BOAT_DEPLOYMENT_ID=${DEPLOYMENT}\n`);
    expect(dropped).toContain("MEND_SESSION_RUNTIME=boat\n");
    expect(f.lines.join("\n")).toContain(
      `Its earlier configurations in ${path.dirname(before)} still hold the old key in their server.env, and setup leaves them as they are. Revoke that key in Boat`,
    );
    expect(fs.readFileSync(path.join(before, "server.env"), "utf8")).toContain(KEY);

    // An organization needs the server's own key.
    const refused = await serverCommand(
      ["setup", "--offline", "--boat-organization", "Acme Labs"],
      f.runtime,
    );
    expect(refused._tag === "error" ? refused.message : "").toContain(
      "this server has no key of its own",
    );
  });

  it("upgrades a server set up with its own key and the old overlay, keeping the key and its names", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--session-runtime", "boat", "--boat-api-key-stdin", ...ENDPOINTS],
        { ...f.runtime, readStdin: async () => KEY },
      ),
    ).toEqual({ _tag: "ok" });
    fs.writeFileSync(path.join(f.active(), "compose.boat.yaml"), REQUIRED_KEY_OVERLAY);
    const env = f.files()["server.env"] ?? "";
    const deployment = valueIn(env, "SEALANT_BOAT_DEPLOYMENT_ID");
    const owner = valueIn(env, "SEALANT_BOAT_BUILDER_OWNER");
    expect(deployment).toMatch(/^mend-/);
    expect(owner).toMatch(UUID);

    // Core adopts these two into its own record the first time it starts with them set
    // (sealant#637); an install that dropped them in that same upgrade would no longer recognise
    // its VMs and saved images. So an upgrade keeps handing both, and the key, to `mend`.
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const upgraded = f.files();
    expect(upgraded["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    expect(valueIn(upgraded["server.env"] ?? "", "SEALANT_BOAT_API_KEY")).toBe(KEY);
    expect(upgraded["compose.boat.yaml"]).toContain(
      "SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID:-}",
    );
    expect(upgraded["compose.boat.yaml"]).toContain(
      "SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER:-}",
    );
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
  });

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

  it("names the Boat VMs itself when no name is given, the same on every rerun", async () => {
    const f = await fixture();
    f.update({ boatGatewayImage: GATEWAY });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--session-runtime", "boat", ...ENDPOINTS],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const named = () => valueIn(f.files()["server.env"] ?? "", "SEALANT_BOAT_DEPLOYMENT_ID") ?? "";
    const first = named();
    expect(first).toMatch(
      /^mend-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(named()).toBe(first);
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
