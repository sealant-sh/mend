import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";
import { describeUninstall, executeUninstall, planLines } from "./uninstall.ts";

const { cleanups, fixture, seedDaemon, daemonNames, liveWorkspace, uninstallRuntime } =
  lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it("lists the live workspace, stops and removes it with its volumes and network, then everything else", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    liveWorkspace(f);
    const runtime = uninstallRuntime(f);
    const plan = await describeUninstall(runtime, "server");
    expect(plan.server).toMatchObject({
      dockerProblem: null,
      holdings: {
        workspaces: [{ name: "sealant-w1", running: true }],
        sidecars: ["sealant-w1-docker"],
        networks: ["sealant-w1-network"],
      },
      leftByEarlier: [],
    });
    expect(planLines(plan, f.configDir)).toEqual(
      expect.arrayContaining([
        "sessions 1 live session · 1 workspace container on docker context saved-local (sealant-w1)",
        "         uninstall stops them, then removes them with their Docker services, volumes and networks; unsaved work in them is lost",
      ]),
    );
    const before = f.calls().length;
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    // The server stops launching, the workspaces go, and only then does Compose take it down.
    const stop = commands.indexOf("stop --timeout 30 mend");
    const rm = commands.indexOf("container rm -f -v sealant-w1");
    const down = commands.indexOf("down --volumes --remove-orphans --timeout 30");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
    expect(down).toBeGreaterThan(rm);
    expect(daemonNames(f, "containers")).toEqual([]);
    expect(daemonNames(f, "networks")).toEqual([]);
    expect(daemonNames(f, "volumes")).toEqual([]);
    for (const name of ["identity.env", "active", "generations", "uninstall-left.json"]) {
      expect(fs.existsSync(path.join(f.configDir, name)), name).toBe(false);
    }
    expect(f.lines).toEqual(
      expect.arrayContaining([
        "removed 2 workspace containers, 1 of them live, with their volumes (sealant-w1, sealant-w1-docker)",
        "removed workspace networks sealant-w1-network",
        "removed volumes mend-control, mend-garage",
        "removed volume mend-store",
      ]),
    );
  });

  it("finishes in one run while the Docker mirror is attached to a live workspace's network (RC 761)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    liveWorkspace(f);
    // Sealant joins the mirror to every workspace's network; Compose owns its container.
    seedDaemon(f, {
      containers: [["mend-docker-mirror", { "com.docker.compose.project": "mend" }]],
      facts: [["mend-docker-mirror", { networks: ["mend_default", "sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const before = f.calls().length;
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "server"));
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    // Workspace containers, then the server's own (the mirror among them), then the networks.
    const rm = commands.indexOf("container rm -f -v sealant-w1");
    const down = commands.indexOf("down --volumes --remove-orphans --timeout 30");
    const network = commands.indexOf("network rm sealant-w1-network");
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(down).toBeGreaterThan(rm);
    expect(network).toBeGreaterThan(down);
    expect(daemonNames(f, "containers")).toEqual([]);
    expect(daemonNames(f, "networks")).toEqual([]);
    for (const name of ["identity.env", "active", "generations", "uninstall-left.json"]) {
      expect(fs.existsSync(path.join(f.configDir, name)), name).toBe(false);
    }
    expect(f.lines).toContain("removed workspace networks sealant-w1-network");
  });
});
