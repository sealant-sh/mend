import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";
import { describeUninstall, executeUninstall, planLines } from "./uninstall.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall", { timeout: 60_000 }, () => {
  it("names and removes the t3code gateway's volume a turned-off gateway left behind (644-R2-1)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    // What --no-t3-gateway leaves: the generation has no gateway overlay, so Compose's own
    // `down --volumes` does not know the volume that holds paired people's device tokens.
    const protocolFile = path.join(f.root, "docker-protocol.json");
    const saved = fs.existsSync(protocolFile)
      ? JSON.parse(fs.readFileSync(protocolFile, "utf8"))
      : {};
    saved.volumes = [...(saved.volumes ?? []), ["mend_mend-t3-gateway", {}]];
    fs.writeFileSync(protocolFile, JSON.stringify(saved));
    const runtime = {
      server: f.runtime,
      cliHome: path.join(f.root, "home", "mend"),
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => "must not be called",
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: "must not be called",
      }),
    };
    const plan = await describeUninstall(runtime, "server");
    expect(plan.server).toMatchObject({ t3GatewayVolume: true });
    expect(planLines(plan, f.configDir).join("\n")).toContain("mend-t3-gateway");
    const before = f.calls().length;
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    expect(commands).toContain("volume rm mend_mend-t3-gateway");
    expect(f.lines.some((line) => line.includes("removed volume mend_mend-t3-gateway"))).toBe(true);
  });

  it("takes the installation down, removes its volumes, image and files, and releases the lock", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    const home = path.join(f.root, "home", "mend");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "cli.json"), "{}");
    const runtime = {
      server: f.runtime,
      cliHome: home,
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => "must not be called",
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: "must not be called",
      }),
    };

    const plan = await describeUninstall(runtime, "server");
    expect(plan.home).toBeNull();
    expect(plan.server).toEqual({
      version: "0.23.0",
      observedInstallation: {
        owner: createHash("sha256")
          .update(fs.readFileSync(path.join(f.configDir, "identity.env")))
          .digest("hex"),
        directory: f.active(),
      },
      appUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      dockerContext: "saved-local",
      edgeHost: null,
      sshPort: 2222,
      mirrors: ["npm-mirror", "docker-mirror"],
      t3GatewayVolume: false,
      generations: 1,
      backups: 0,
      dockerProblem: null,
      holdings: { workspaces: [], sidecars: [], networks: [], images: [] },
      leftByEarlier: [],
      present: {
        containers: ["mend", "postgres", "garage", "npm-mirror", "docker-mirror"],
        volumes: ["mend-store", "mend-control", "mend-garage"],
        image: true,
      },
    });
    const before = f.calls().length;

    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    expect(commands).toContain("down --volumes --remove-orphans --timeout 30");
    for (const volume of ["mend-control", "mend-garage", "mend-store"]) {
      expect(commands).toContain(`volume rm ${volume}`);
    }
    expect(commands).toContain("image rm ghcr.io/sealant-sh/mend:0.23.0");
    expect(f.state()).toMatchObject({ appRunning: false, postgresRunning: false });
    expect(f.state().images["0.23.0"]).toBeUndefined();
    for (const name of ["identity.env", "active", "generations", "server.lock"]) {
      expect(fs.existsSync(path.join(f.configDir, name)), name).toBe(false);
    }
    // The home scope was not asked for: the laptop-side files stay.
    expect(fs.existsSync(path.join(home, "cli.json"))).toBe(true);
    expect(await serverCommand(["status"], f.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("No Mend server is configured"),
    });
    expect(outcome.leftovers).toEqual([]);
  });

  it("keeps the files when compose down fails, so a retry can still find the installation", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ fail: "down" });
    const runtime = {
      server: f.runtime,
      cliHome: path.join(f.root, "home", "mend"),
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => null,
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: null,
      }),
    };
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "server"));
    expect(outcome.failures).toEqual([
      "Docker did not take the server down (docker compose down: fixture operation failed). Its volumes and files are kept; run mend uninstall again once Docker answers.",
    ]);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(false);
    const volumes = JSON.parse(fs.readFileSync(path.join(f.root, "docker-protocol.json"), "utf8"));
    expect(volumes.volumes.map(([name]: [string]) => name)).toEqual(
      expect.arrayContaining(["mend-store", "mend-control"]),
    );
  });
});
