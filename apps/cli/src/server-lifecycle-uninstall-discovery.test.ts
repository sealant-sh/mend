import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { describeUninstall, executeUninstall, type UninstallRuntime } from "./uninstall.ts";

const { cleanups, fixture, seedDaemon, daemonNames, liveWorkspace, uninstallRuntime } =
  lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it.each(["container", "network", "volume"])(
    "retains partial uninstall records when pending %s discovery fails",
    async (kind) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      liveWorkspace(f);
      seedDaemon(f, {
        containers: [["someone-else", {}]],
        facts: [["someone-else", { networks: ["sealant-w1-network"] }]],
      });
      const base = uninstallRuntime(f);
      expect(
        (await executeUninstall(base, await describeUninstall(base, "server"))).failures,
      ).not.toEqual([]);
      expect(daemonNames(f, "volumes")).toEqual(["mend-store"]);
      const file = path.join(f.root, "docker-protocol.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      saved.facts = saved.facts.filter(([name]: [string]) => name !== "someone-else");
      fs.writeFileSync(file, JSON.stringify(saved));
      const identityFile = path.join(f.configDir, "identity.env");
      const ledgerFile = path.join(f.configDir, "uninstall-left.json");
      const identity = fs.readFileSync(identityFile);
      const ledger = fs.readFileSync(ledgerFile);
      const generation = f.active();
      const files = f.files();
      const plan = await describeUninstall(base, "server");
      let faults = 0;
      const runtime: UninstallRuntime = {
        ...base,
        server: {
          ...base.server,
          run: async (command, args, options) => {
            if (args[2] === kind && args[3] === "ls" && !args.includes("--filter")) {
              faults += 1;
              return { status: null, stdout: "", stderr: "pending resource discovery interrupted" };
            }
            return base.server.run(command, args, options);
          },
        },
      };
      expect((await executeUninstall(runtime, plan)).failures).toContainEqual(
        expect.stringContaining("pending resource discovery interrupted"),
      );
      expect(faults).toBeGreaterThan(0);
      expect(fs.readFileSync(identityFile)).toEqual(identity);
      expect(fs.readFileSync(ledgerFile)).toEqual(ledger);
      expect(f.active()).toBe(generation);
      expect(f.files()).toEqual(files);
      expect(daemonNames(f, "volumes")).toContain("mend-store");
      expect(daemonNames(f, "networks")).toContain("sealant-w1-network");
      expect(await executeUninstall(base, await describeUninstall(base, "server"))).toEqual({
        failures: [],
        leftovers: [],
        remaining: [],
      });
      expect(daemonNames(f, "volumes")).toEqual([]);
      expect(daemonNames(f, "networks")).toEqual([]);
      expect(fs.existsSync(identityFile)).toBe(false);
      expect(fs.existsSync(ledgerFile)).toBe(false);
    },
  );

  it.each(["mend-control", "mend-store"])(
    "retains active installation records when final %s ownership is unknown",
    async (volume) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const base = uninstallRuntime(f);
      const identityFile = path.join(f.configDir, "identity.env");
      const identity = fs.readFileSync(identityFile);
      const plan = await describeUninstall(base, "server");
      let inspections = 0;
      const runtime: UninstallRuntime = {
        ...base,
        server: {
          ...base.server,
          run: async (command, args, options) => {
            if (args[2] === "volume" && args[3] === "inspect" && args[4] === volume) {
              inspections += 1;
              if (volume === "mend-store" || inspections > 2)
                return {
                  status: null,
                  stdout: "",
                  stderr: "active ownership inspection interrupted",
                };
            }
            return base.server.run(command, args, options);
          },
        },
      };
      expect((await executeUninstall(runtime, plan)).failures).toContainEqual(
        expect.stringContaining("active ownership inspection interrupted"),
      );
      expect(fs.readFileSync(identityFile)).toEqual(identity);
      expect(fs.existsSync(path.join(f.configDir, "active"))).toBe(true);
      expect(daemonNames(f, "volumes")).toContain("mend-store");
      expect(await executeUninstall(base, await describeUninstall(base, "server"))).toEqual({
        failures: [],
        leftovers: [],
        remaining: [],
      });
      expect(fs.existsSync(identityFile)).toBe(false);
      expect(daemonNames(f, "volumes")).toEqual([]);
    },
  );
});
