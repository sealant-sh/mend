import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEPLOYMENT,
  ENDPOINTS,
  GATEWAY,
  KEY,
  REQUIRED_KEY_OVERLAY,
  UUID,
  valueIn,
} from "./server-lifecycle-boat-test-fixtures.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Boat sessions: the server's own Boat key", { timeout: 120_000 }, () => {
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
});
