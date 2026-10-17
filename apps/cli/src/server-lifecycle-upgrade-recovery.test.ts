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
  it.each(["backup", "stop", "old-start"])(
    "keeps the old pin and attempts recovery after %s failure",
    async (failure) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const old = f.active();
      f.update({ fail: failure });
      const result = await f.upgrade();
      expect(result).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("Target startup was not attempted"),
      });
      expect(JSON.stringify(result)).not.toContain("sensitive SQL");
      const backupName = fs.readdirSync(path.join(f.configDir, "backups"))[0];
      if (backupName === undefined) throw new Error("No recovery record");
      const backup = path.join(f.configDir, "backups", backupName);
      expect(fs.existsSync(path.join(backup, "database.sql"))).toBe(false);
      if (failure !== "stop")
        expect(fs.statSync(path.join(backup, "database.sql.partial")).mode & 0o777).toBe(0o600);
      expect(f.active()).toBe(old);
      expect(
        f
          .calls()
          .filter((call) => call.command[0] === "up")
          .every((call) => call.directory === old),
      ).toBe(true);
      expect(result).toMatchObject({
        message: expect.stringContaining(
          failure === "old-start" ? "could not recover" : "app recovered",
        ),
      });
    },
  );

  it("does not restart an already stopped app when backup fails", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["stop"], f.runtime)).toEqual({ _tag: "ok" });
    const count = f.calls().length;
    f.update({ fail: "backup" });
    expect((await f.upgrade())._tag).toBe("error");
    expect(f.state().appRunning).toBe(false);
    expect(
      f
        .calls()
        .slice(count)
        .filter((call) => call.command[0] === "up")
        .every((call) => call.command.at(-1) === "postgres"),
    ).toBe(true);
  });

  it.each(["target-start", "health-mismatch"])(
    "never rolls back after %s once target migrations may have begun",
    async (failure) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const old = f.active();
      f.update(failure === "health-mismatch" ? { healthVersion: "0.23.0" } : { fail: failure });
      expect(await f.upgrade()).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("migrations may have begun"),
      });
      const target = f.active();
      expect(target).not.toBe(old);
      expect(f.files()["server.env"]).toContain("MEND_VERSION=0.24.0");
      const calls = f.calls();
      const attempted = calls.findIndex(
        (call) => call.directory === target && call.command[0] === "up",
      );
      expect(calls.slice(attempted).every((call) => call.directory !== old)).toBe(true);
      expect((await serverCommand(["setup", "--version", "0.23.0"], f.runtime))._tag).toBe("error");
      expect((await f.upgrade("0.23.0"))._tag).toBe("error");
      f.update({ fail: "", healthVersion: null });
      expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
      expect(f.active()).toBe(target);
    },
  );
});
