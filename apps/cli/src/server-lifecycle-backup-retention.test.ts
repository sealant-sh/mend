import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverProcessDeadlines } from "./server-runtime.ts";

const { cleanups, fixture, versions, withVersions } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  it("backs up with writers stopped before selecting and starting the exact target", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    const before = f.files();
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const target = f.active();
    expect(target).not.toBe(old);
    const after = f.files();
    expect(after["identity.env"]).toBe(before["identity.env"]);
    expect(after["server.env"]).toBe(
      before["server.env"]?.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"),
    );
    expect(fs.readFileSync(path.join(old, "server.json"), "utf8")).toBe(before["server.json"]);
    expect(f.state().version).toBe("0.24.0");
    const calls = f.calls();
    const stop = calls.findIndex((call) => call.command[0] === "stop");
    const dump = calls.findIndex((call) => call.command.includes("pg_dumpall"));
    const start = calls.findIndex((call) => call.directory === target && call.command[0] === "up");
    expect(
      calls.slice(0, stop).some((call) => call.args.includes("ghcr.io/sealant-sh/mend:0.24.0")),
    ).toBe(true);
    expect(
      calls
        .slice(0, stop)
        .some((call) => call.directory === target && call.command[0] === "config"),
    ).toBe(true);
    expect(stop).toBeLessThan(dump);
    expect(dump).toBeLessThan(start);
    expect(calls[dump]).toMatchObject({
      directory: old,
      appRunning: false,
      active: path.relative(f.configDir, old),
      command: ["exec", "-T", "postgres", "pg_dumpall", "--username=postgres"],
    });
    expect(calls[start]?.active).toBe(path.relative(f.configDir, target));
    expect(f.runCalls.find((call) => call.args.includes("pg_dumpall"))?.options?.timeoutMs).toBe(
      serverProcessDeadlines.dump,
    );
    expect(
      f.runCalls
        .filter((call) => call.args.includes("--wait"))
        .every(
          (call) =>
            call.args.includes("--wait-timeout") &&
            call.options?.timeoutMs === serverProcessDeadlines.startup,
        ),
    ).toBe(true);
    const backupRoot = path.join(f.configDir, "backups");
    const backupName = fs.readdirSync(backupRoot)[0];
    if (backupName === undefined) throw new Error("No backup");
    const backup = path.join(backupRoot, backupName);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(backup, "database.sql")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(backup, "recovery.json")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(backup, "database.sql"), "utf8")).toContain(
      "CREATE DATABASE sealant_control_plane",
    );
    expect(JSON.parse(fs.readFileSync(path.join(backup, "recovery.json"), "utf8"))).toMatchObject({
      previousGeneration: old,
      targetGeneration: target,
    });
    expect(fs.existsSync(path.join(backup, "database.sql.partial"))).toBe(false);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.active()).toBe(target);
    expect(fs.readdirSync(backupRoot)).toHaveLength(1);
    expect((await f.upgrade("0.23.0"))._tag).toBe("error");
    expect(f.active()).toBe(target);
  });

  describe("upgrade backups", () => {
    it("a healthy upgrade keeps the newest two by default and says what it removed", async () => {
      const f = await withVersions();
      for (const version of versions.slice(0, 2))
        expect(await f.upgrade(version)).toEqual({ _tag: "ok" });
      expect(f.backups()).toHaveLength(2);
      expect(f.lines).toContain("Upgrade backups · removed 0 · kept 2 (--keep-backups 2)");
      const before = new Set(f.backups());
      expect(await f.upgrade(versions[2])).toEqual({ _tag: "ok" });
      const after = f.backups();
      expect(after).toHaveLength(2);
      const current = after.find((name) => !before.has(name));
      if (current === undefined) throw new Error("No backup for the last upgrade");
      const recovery = JSON.parse(
        fs.readFileSync(path.join(f.configDir, "backups", current, "recovery.json"), "utf8"),
      );
      expect(recovery).toMatchObject({ state: "completed", targetGeneration: f.active() });
      expect(f.lines.filter((line) => line.startsWith("Removed upgrade backup "))).toHaveLength(1);
      expect(f.lines.at(-1)).toMatch(
        /^Upgrade backups · removed 1 · [\d.]+ (B|KiB) freed · kept 2 \(--keep-backups 2\)$/,
      );
    });

    it("--keep-backups 0 keeps every backup and --keep-backups 1 keeps only this upgrade's", async () => {
      const f = await withVersions();
      for (const version of versions.slice(0, 3))
        expect(await f.upgradeKeeping(version, "0")).toEqual({ _tag: "ok" });
      expect(f.backups()).toHaveLength(3);
      expect(f.lines).toContain("Upgrade backups · all kept (--keep-backups 0)");
      expect(f.lines.some((line) => line.startsWith("Removed upgrade backup "))).toBe(false);
      // The first as a release before 0.36 wrote it: no outcome recorded, and the output says so.
      const legacy =
        f
          .backups()
          .map((name) => path.join(f.configDir, "backups", name, "recovery.json"))
          .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).sequence === 1) ?? "";
      const {
        state: _state,
        sequence: _sequence,
        createdAt: _createdAt,
        ...old
      } = JSON.parse(fs.readFileSync(legacy, "utf8"));
      fs.writeFileSync(legacy, JSON.stringify(old));
      expect(await f.upgradeKeeping(versions[3], "1")).toEqual({ _tag: "ok" });
      expect(f.backups()).toHaveLength(1);
      const removals = f.lines.filter((line) => line.startsWith("Removed upgrade backup "));
      expect(removals).toHaveLength(3);
      expect(
        removals.filter((line) => line.endsWith(" · from before 0.36, no recorded outcome")),
      ).toEqual([expect.stringContaining(path.dirname(legacy))]);
    });

    it.each(["-1", "two", "1.5"])(
      "refuses --keep-backups %s before touching anything",
      async (keep) => {
        const f = await withVersions();
        const count = f.calls().length;
        expect(await f.upgradeKeeping(versions[0], keep)).toMatchObject({
          _tag: "error",
          message: expect.stringContaining("--keep-backups takes a whole number"),
        });
        expect(
          f
            .calls()
            .slice(count)
            .every(
              (call) => call.args[2] === "volume" && ["ls", "inspect"].includes(call.args[3] ?? ""),
            ),
        ).toBe(true);
        expect(fs.existsSync(path.join(f.configDir, "backups"))).toBe(false);
      },
    );
  });
});
