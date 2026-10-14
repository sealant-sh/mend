import { createHash } from "node:crypto";
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
  it("a re-run's plan and output name only what is still there (RC 761)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    liveWorkspace(f);
    // Something that is not the installation's holds the workspace's network: the first run stops.
    seedDaemon(f, {
      containers: [["someone-else", {}]],
      facts: [["someone-else", { networks: ["sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const first = await describeUninstall(runtime, "server");
    expect(planLines(first, f.configDir)).toContain(
      "         containers mend, postgres, garage, npm-mirror, docker-mirror · volumes mend-store, mend-control, mend-garage · image ghcr.io/sealant-sh/mend:0.23.0",
    );
    expect((await executeUninstall(runtime, first)).failures).toHaveLength(2);
    expect(f.lines).toContain(
      "removed containers mend, postgres, garage, npm-mirror, docker-mirror and the Compose-owned volumes",
    );

    const file = path.join(f.root, "docker-protocol.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.facts = saved.facts.filter(([name]: [string]) => name !== "someone-else");
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = await describeUninstall(runtime, "server");
    const lines = planLines(again, f.configDir);
    expect(lines).toContain("         volumes mend-store");
    expect(lines.join("\n")).not.toContain("containers");
    expect(lines.join("\n")).not.toContain("image ghcr.io");
    const said = f.lines.length;
    expect(await executeUninstall(runtime, again)).toEqual({
      failures: [],
      leftovers: [],
      remaining: [],
    });
    expect(f.lines.slice(said).some((line) => line.startsWith("removed containers"))).toBe(false);
    expect(f.lines.slice(said)).toContain("removed workspace networks sealant-w1-network");
  });

  it("keeps the anchor and identity while anything is left; a reinstall works over it and a second run finishes", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    liveWorkspace(f);
    // Something that is not the installation's still holds the workspace's network.
    seedDaemon(f, {
      containers: [["someone-else", {}]],
      facts: [["someone-else", { networks: ["sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "server"));
    expect(outcome.failures).toEqual([
      expect.stringMatching(
        /^could not remove network sealant-w1-network: .*active endpoints.*To remove it: docker --context saved-local network rm sealant-w1-network$/,
      ),
      `the uninstall is not finished: sealant-w1-network is still there. Volume mend-store and ${f.configDir} (identity, generations) stay so that mend uninstall can finish it; run it again, or reinstall over it with mend server setup.`,
    ]);
    expect(daemonNames(f, "volumes")).toEqual(["mend-store"]);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(f.configDir, "uninstall-left.json"), "utf8")),
    ).toEqual({
      names: ["sealant-w1-network"],
      dockerContext: "saved-local",
      owner: createHash("sha256")
        .update(fs.readFileSync(path.join(f.configDir, "identity.env")))
        .digest("hex"),
    });

    // A reinstall over what is left claims it instead of refusing it (offline, after the
    // release image the uninstall removed is loaded again).
    f.update({ images: { ...f.state().images, "0.23.0": "0.23.0" } });
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(daemonNames(f, "volumes")).toEqual(["mend-store", "mend-control", "mend-garage"]);

    // Once the network is free, a second run finishes, starting with what the first one left.
    seedDaemon(f, {});
    const file = path.join(f.root, "docker-protocol.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.facts = saved.facts.filter(([name]: [string]) => name !== "someone-else");
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = await describeUninstall(runtime, "server");
    expect(planLines(again, f.configDir)).toContain(
      "         left by an earlier mend uninstall: sealant-w1-network",
    );
    expect(await executeUninstall(runtime, again)).toEqual({
      failures: [],
      leftovers: [],
      remaining: [],
    });
    expect(daemonNames(f, "volumes")).toEqual([]);
    expect(daemonNames(f, "networks")).toEqual([]);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(false);
    expect(fs.existsSync(path.join(f.configDir, "uninstall-left.json"))).toBe(false);
  });

  it("rereads names saved by another execution instead of trusting an older plan", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    liveWorkspace(f);
    seedDaemon(f, {
      containers: [["someone-else", {}]],
      facts: [["someone-else", { networks: ["sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const first = await describeUninstall(runtime, "server");
    const second = await describeUninstall(runtime, "server");
    expect((await executeUninstall(runtime, first)).failures).not.toEqual([]);
    expect(daemonNames(f, "volumes")).toEqual(["mend-store"]);
    const identityFile = path.join(f.configDir, "identity.env");
    const ledgerFile = path.join(f.configDir, "uninstall-left.json");
    const identity = fs.readFileSync(identityFile);
    const ledger = fs.readFileSync(ledgerFile);
    expect((await executeUninstall(runtime, second)).failures).not.toEqual([]);
    expect(fs.readFileSync(identityFile)).toEqual(identity);
    expect(fs.readFileSync(ledgerFile)).toEqual(ledger);
    expect(daemonNames(f, "volumes")).toEqual(["mend-store"]);
    expect(daemonNames(f, "networks")).toContain("sealant-w1-network");
    const file = path.join(f.root, "docker-protocol.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.facts = saved.facts.filter(([name]: [string]) => name !== "someone-else");
    fs.writeFileSync(file, JSON.stringify(saved));
    expect(await executeUninstall(runtime, await describeUninstall(runtime, "server"))).toEqual({
      failures: [],
      leftovers: [],
      remaining: [],
    });
    expect(daemonNames(f, "volumes")).toEqual([]);
    expect(daemonNames(f, "networks")).toEqual([]);
  });
});
