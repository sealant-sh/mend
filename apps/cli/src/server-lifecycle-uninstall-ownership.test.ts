import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { describeUninstall, executeUninstall, type UninstallRuntime } from "./uninstall.ts";

const { cleanups, fixture, daemonNames, uninstallRuntime } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall when final ownership is unknown", { timeout: 60_000 }, () => {
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
