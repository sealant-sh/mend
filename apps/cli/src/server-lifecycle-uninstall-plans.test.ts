import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { describeUninstall, executeUninstall, planRefusal } from "./uninstall.ts";

const { cleanups, fixture, daemonNames, uninstallRuntime } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it.each(["legacy", "owner", "context"])(
    "refuses a %s retry record before changing an active installation",
    async (failure) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const runtime = uninstallRuntime(f);
      const plan = await describeUninstall(runtime, "all");
      const identityFile = path.join(f.configDir, "identity.env");
      const identity = fs.readFileSync(identityFile);
      const owner = createHash("sha256").update(identity).digest("hex");
      const ledgerFile = path.join(f.configDir, "uninstall-left.json");
      const record = JSON.stringify(
        failure === "legacy"
          ? { names: ["mend-control"] }
          : {
              names: ["mend-control"],
              dockerContext: failure === "context" ? "other-context" : "saved-local",
              owner: failure === "owner" ? "another-installation" : owner,
            },
      );
      fs.writeFileSync(ledgerFile, record);
      const generation = f.active();
      const files = f.files();
      const daemon = fs.readFileSync(path.join(f.root, "docker-protocol.json"));
      const calls = f.calls().length;
      expect((await executeUninstall(runtime, plan)).failures).toContainEqual(
        expect.stringContaining("retry record"),
      );
      expect(planRefusal(await describeUninstall(runtime, "all"))).toContain("retry record");
      expect(fs.readFileSync(identityFile)).toEqual(identity);
      expect(fs.readFileSync(ledgerFile, "utf8")).toBe(record);
      expect(f.active()).toBe(generation);
      expect(f.files()).toEqual(files);
      expect(fs.readFileSync(path.join(f.root, "docker-protocol.json"))).toEqual(daemon);
      expect(f.calls().slice(calls)).toEqual([]);
      expect(fs.existsSync(path.join(runtime.cliHome, "cli.json"))).toBe(true);
      fs.unlinkSync(ledgerFile);
      expect(await executeUninstall(runtime, await describeUninstall(runtime, "server"))).toEqual({
        failures: [],
        leftovers: [],
        remaining: [],
      });
      expect(daemonNames(f, "volumes")).toEqual([]);
    },
  );

  it.each(["generation", "identity"])(
    "refuses a stale active plan after %s replacement and retains the new installation",
    async (replacement) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const runtime = uninstallRuntime(f);
      const plan = await describeUninstall(runtime, "all");
      if (replacement === "generation") {
        expect(await f.upgrade()).toEqual({ _tag: "ok" });
      } else {
        // A complete valid replacement, not a mismatched root identity the store already refuses.
        const other = await fixture();
        expect(await other.setup()).toEqual({ _tag: "ok" });
        fs.rmSync(f.configDir, { recursive: true });
        fs.cpSync(other.configDir, f.configDir, { recursive: true, verbatimSymlinks: true });
        fs.copyFileSync(
          path.join(other.root, "docker-protocol.json"),
          path.join(f.root, "docker-protocol.json"),
        );
      }
      const identityFile = path.join(f.configDir, "identity.env");
      const identity = fs.readFileSync(identityFile);
      const generation = f.active();
      const files = f.files();
      const daemon = fs.readFileSync(path.join(f.root, "docker-protocol.json"));
      const calls = f.calls().length;
      expect((await executeUninstall(runtime, plan)).failures).toContainEqual(
        expect.stringContaining("installation changed"),
      );
      expect(fs.readFileSync(identityFile)).toEqual(identity);
      expect(f.active()).toBe(generation);
      expect(f.files()).toEqual(files);
      expect(fs.readFileSync(path.join(f.root, "docker-protocol.json"))).toEqual(daemon);
      expect(f.calls().slice(calls)).toEqual([]);
      expect(fs.existsSync(path.join(runtime.cliHome, "cli.json"))).toBe(true);
      expect(await executeUninstall(runtime, await describeUninstall(runtime, "server"))).toEqual({
        failures: [],
        leftovers: [],
        remaining: [],
      });
      expect(fs.existsSync(identityFile)).toBe(false);
      expect(daemonNames(f, "volumes")).toEqual([]);
    },
  );
});
