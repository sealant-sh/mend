import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  it.each(["status", "start", "stop", "restart", "logs", "upgrade"])(
    "keeps unconfigured %s readable without creating state",
    async (command) => {
      const f = await fixture();
      expect(await serverCommand([command], f.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("No Mend server is configured"),
      });
      expect(fs.existsSync(f.configDir)).toBe(false);
      expect(f.calls()).toEqual([]);
    },
  );

  // This sequence combines setup, reruns, and lifecycle commands, each spawning real protocol
  // processes. Its aggregate CI budget is separate from the unchanged per-command deadlines.
  it(
    "preserves the generation and pin across CLI updates, setup reruns, status/logs and stop/start/restart",
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const before = f.files();
      const directory = f.active();
      fs.rmSync(f.assets, { recursive: true });
      expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
      expect(await serverCommand(["setup", "--version", "0.24.0"], f.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("upgrade"),
      });
      fs.chmodSync(f.configDir, 0o750);
      for (const command of [
        ["status"],
        ["logs", "--tail", "37"],
        ["stop"],
        ["status"],
        ["start", "--offline"],
        ["restart"],
      ]) {
        expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
        expect(f.files()).toEqual(before);
        expect(f.active()).toBe(directory);
      }
      expect(fs.statSync(f.configDir).mode & 0o777).toBe(0o750);
      expect(f.state()).toMatchObject({
        version: "0.23.0",
        appRunning: true,
        postgresRunning: true,
      });
      expect(f.lines).toContain("Mend is stopped. No health claim was made.");
      expect(f.lines.some((line) => line.includes("active work can lose connectivity"))).toBe(true);
      expect(f.calls().some((call) => call.command.join(" ") === "logs --no-color --tail 37")).toBe(
        true,
      );
      expect(
        f
          .calls()
          .filter((call) => call.directory !== null)
          .every((call) => call.directory === directory),
      ).toBe(true);
      expect(
        f
          .calls()
          .every(
            (call) =>
              !call.poisoned &&
              !call.args.includes("down") &&
              !call.args.includes("prune") &&
              !call.args.includes("pull"),
          ),
      ).toBe(true);
      expect(fs.readdirSync(path.join(f.configDir, "generations"))).toHaveLength(1);
      // Only Mend itself is asked: its health, and whether it has accounts yet.
      expect(f.fetched.every((request) => /\/api\/(health|instance)$/.test(request))).toBe(true);
    },
  );

  it.each([
    ["logs", "--follow"],
    ["logs", "--tail", "0"],
    ["logs", "--tail", "1001"],
    ["logs", "--tail", "1e2"],
    ["start", "--version", "0.24.0"],
    ["upgrade"],
    ["upgrade", "--version", "latest", "--offline"],
    ["upgrade", "--version", "0.24.0", "--context", "other"],
  ])("rejects unsupported controls: %j", async (...command) => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const before = f.files();
    const count = f.calls().length;
    expect((await serverCommand(command, f.runtime))._tag).toBe("error");
    expect(
      f
        .calls()
        .slice(count)
        .every(
          (call) => call.args[2] === "volume" && ["ls", "inspect"].includes(call.args[3] ?? ""),
        ),
    ).toBe(true);
    expect(f.files()).toEqual(before);
  });
});
