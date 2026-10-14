import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";
import { describeUninstall, executeUninstall, planLines } from "./uninstall.ts";

const { cleanups, fixture, host } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it("--no-edge takes the edge away, removes its container by label and returns to the localhost origin", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    expect(f.state().edgeRunning).toBe(true);
    // Without --url the origin would return to http://localhost; the fixture's health answers on
    // 127.0.0.1, so the loopback origin is stated.
    expect(
      await serverCommand(["setup", "--no-edge", "--url", `http://127.0.0.1:${f.port}`], f.runtime),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files["compose.edge.yaml"]).toBeUndefined();
    expect(files["Caddyfile"]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}")).not.toHaveProperty("edgeHost");
    expect(files["server.env"]).toContain(`APP_URL=http://127.0.0.1:${f.port}\n`);
    expect(files["server.env"]).not.toContain("MEND_EDGE_HOST");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    // The edge's container went by its labels, before the edge-less `up`; nothing else was removed.
    const removal = f.runCalls.findIndex(
      (call) => call.args[2] === "container" && call.args[3] === "rm",
    );
    expect(f.runCalls[removal]?.args.slice(2)).toEqual([
      "container",
      "rm",
      "--force",
      "mend-edge-1",
    ]);
    expect(removal).toBeLessThan(
      f.runCalls.findIndex((call, index) => index > removal && call.args.includes("up")),
    );
    expect(f.state().edgeRunning).toBe(false);
    expect(f.state().removedEdge).toBe(1);
    expect(f.lines).toContain(
      "Removed the edge container mend-edge-1, which this generation does not run.",
    );
    expect(
      f.lines.some((line) =>
        line.startsWith(`The edge for ${host} is gone. Its certificate volumes stay`),
      ),
    ).toBe(true);
    // Without a stray edge, a start lists and removes nothing; nothing ever passes --remove-orphans.
    expect(await serverCommand(["setup", "--yes"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    expect(f.runCalls.some((call) => call.args.includes("--remove-orphans"))).toBe(false);
  });

  it("an edge of another compose directory stays, and a refused listing never keeps Mend down", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--no-edge", "--url", `http://127.0.0.1:${f.port}`], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    // A project of the same name run by hand from another directory has an edge of its own.
    f.update({ edgeRunning: true, edgeDirectory: "/opt/other-mend" });
    f.lines.length = 0;
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    expect(f.state().edgeRunning).toBe(true);
    expect(f.lines).toContain(
      "Edge container mend-edge-1 was started from /opt/other-mend, not from this installation's generations. It stays.",
    );
    expect(f.runCalls.some((call) => call.args[2] === "container" && call.args[3] === "rm")).toBe(
      true,
    );
    // The daemon refuses the listing: Mend restarts all the same, and the line says what was not done.
    f.update({ fail: "container-ls" });
    f.lines.length = 0;
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().appRunning).toBe(true);
    expect(
      f.lines.some((line) => line.startsWith("Could not list this project's containers:")),
    ).toBe(true);
    expect(f.lines.some((line) => line.includes("stays until the next start"))).toBe(true);
  });

  it("an edge left behind by a failed edge-less start goes on the next start", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    // The `up` that drops the edge fails before Compose did anything. The new generation is
    // active and declares no edge; the edge's container went by label just before the `up`.
    f.update({ fail: "no-edge-up" });
    const result = await serverCommand(
      ["setup", "--no-edge", "--url", `http://127.0.0.1:${f.port}`],
      f.runtime,
    );
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Mend containers did not start"),
    });
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).not.toHaveProperty("edgeHost");
    expect(f.state().removedEdge).toBe(1);
    // A crash between that removal and the `up`, or a Caddy someone started again by hand, leaves
    // an edge listening on 80 and 443 under a config that declares none. The next start of the
    // edge-less generation finds it by its labels and removes it, then starts.
    f.update({ edgeRunning: true, fail: "" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(2);
    expect(f.state().edgeRunning).toBe(false);
    expect(f.state().appRunning).toBe(true);
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines.some((line) => line.startsWith("edge ·"))).toBe(false);
  });

  it("uninstall takes the edge down with the overlays it was started with", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
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
    const plan = await describeUninstall(runtime, "server");
    expect(plan.server).toMatchObject({ edgeHost: host });
    // What this daemon holds: the fixture's Compose keeps no volumes of its own.
    expect(planLines(plan, f.configDir).join("\n")).toContain(
      `containers mend, postgres, garage, edge, npm-mirror, docker-mirror · volumes mend-store, mend-control, mend-garage · image ghcr.io/sealant-sh/mend:0.23.0 · the edge for ${host}`,
    );
    // Docker not asked: everything an install with an edge and mirrors has.
    if (plan.server === null || plan.server === "none" || "kind" in plan.server)
      throw new Error("expected an installation");
    const { present: _present, ...unobserved } = plan.server;
    expect(planLines({ ...plan, server: unobserved }, f.configDir).join("\n")).toContain(
      `containers mend, postgres, garage, edge, npm-mirror, docker-mirror · volumes mend-store, mend-control, mend-garage, mend-config, mend-ssh, mend-postgres, mend-edge-data, mend-edge-config, mend-npm-mirror, mend-docker-mirror · image ghcr.io/sealant-sh/mend:0.23.0 · the edge for ${host}`,
    );
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    expect(f.state().downFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.mirrors.yaml",
    ]);
    expect(f.state().edgeRunning).toBe(false);
  });
});
