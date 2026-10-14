import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverProcessDeadlines } from "./server-runtime.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  it("retains target, completed backup and owner lock when a process is killed during target startup", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    f.update({ fail: "target-pause" });
    const script = `import { serverCommand, nodeServerRuntime } from ${JSON.stringify(new URL("./server-setup.ts", import.meta.url).href)};
      const result = await serverCommand(["upgrade", "--version", "0.24.0", "--assets-dir", ${JSON.stringify(f.assets)}, "--offline"], { ...nodeServerRuntime(), configDir: ${JSON.stringify(f.configDir)} });
      process.exitCode = result._tag === "ok" ? 0 : 1;`;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        env: { ...process.env, PATH: `${f.root}:${process.env["PATH"] ?? ""}` },
        detached: true,
        stdio: "ignore",
      },
    );
    const settled = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    try {
      await expect
        .poll(() => fs.existsSync(path.join(f.root, "target-started")), { timeout: 5000 })
        .toBe(true);
      expect(f.active()).not.toBe(old);
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Process group already exited. */
        }
      }
      await settled;
      // The killed CLI cannot run cleanup. Terminate its separate Docker group explicitly.
      const marker = path.join(f.root, "target-started");
      if (fs.existsSync(marker)) {
        const dockerPid = Number(fs.readFileSync(marker, "utf8"));
        try {
          process.kill(-dockerPid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    }
    const target = f.active();
    expect(f.files()["server.env"]).toContain("MEND_VERSION=0.24.0");
    const backupName = fs.readdirSync(path.join(f.configDir, "backups"))[0];
    if (backupName === undefined) throw new Error("Missing backup");
    expect(fs.existsSync(path.join(f.configDir, "backups", backupName, "database.sql"))).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "server.lock", "owner.json"))).toBe(true);
    const count = f.calls().length;
    expect(await serverCommand(["start"], f.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Server is busy"),
    });
    expect(f.calls()).toHaveLength(count);
    expect(f.active()).toBe(target);
  });

  it("terminates a real stalled dump and its descendant before old-app recovery or lock release", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    f.update({ fail: "backup-stall" });
    const pidsFile = path.join(f.root, "dump-pids.json");
    let terminated = false;
    const runtime: ServerSetupRuntime = {
      ...f.runtime,
      run: async (command, args, options) => {
        if (!args.includes("pg_dumpall")) return f.runtime.run(command, args, options);
        expect(options?.timeoutMs).toBe(serverProcessDeadlines.dump);
        const output = await f.runtime.run(command, args, { ...options, timeoutMs: 1000 });
        const pids: { parent: number; child: number } = JSON.parse(
          fs.readFileSync(pidsFile, "utf8"),
        );
        expect(() => process.kill(pids.parent, 0)).toThrow();
        const state = spawnSync("ps", ["-o", "stat=", "-p", String(pids.child)], {
          encoding: "utf8",
        }).stdout.trim();
        expect(state === "" || state.startsWith("Z")).toBe(true);
        expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(true);
        expect(f.state().appRunning).toBe(false);
        expect(output).toMatchObject({
          status: null,
          stdout: "",
          error: "Process timed out after 1000ms",
        });
        terminated = true;
        return output;
      },
    };
    const running = serverCommand(
      ["upgrade", "--version", "0.24.0", "--assets-dir", f.assets, "--offline"],
      runtime,
    );
    try {
      await expect.poll(() => fs.existsSync(pidsFile), { timeout: 5000 }).toBe(true);
      expect(await serverCommand(["status"], f.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("busy"),
      });
      expect(await running).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("Previous pin and app recovered"),
      });
    } finally {
      await running;
    }
    expect(terminated).toBe(true);
    expect(f.active()).toBe(old);
    expect(f.state().appRunning).toBe(true);
    expect(
      f
        .calls()
        .filter((call) => call.command[0] === "up")
        .every((call) => call.directory === old),
    ).toBe(true);
    const backups = path.join(f.configDir, "backups");
    const backup = path.join(backups, fs.readdirSync(backups)[0] ?? "missing");
    expect(fs.statSync(path.join(backup, "database.sql.partial")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(backup, "database.sql.partial"), "utf8")).toContain(
      "CREATE DATABASE",
    );
    expect(fs.existsSync(path.join(backup, "database.sql"))).toBe(false);
    expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(false);
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
  });

  it("retains the target after a real startup timeout instead of rolling back across migrations", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    f.update({ fail: "target-pause" });
    const runtime: ServerSetupRuntime = {
      ...f.runtime,
      run: (command, args, options) => {
        if (args.includes("up") && f.active() !== old) {
          expect(options?.timeoutMs).toBe(serverProcessDeadlines.startup);
          return f.runtime.run(command, args, { ...options, timeoutMs: 1000 });
        }
        return f.runtime.run(command, args, options);
      },
    };
    expect(
      await serverCommand(
        ["upgrade", "--version", "0.24.0", "--assets-dir", f.assets, "--offline"],
        runtime,
      ),
    ).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("migrations may have begun"),
    });
    const target = f.active();
    expect(target).not.toBe(old);
    const pid = Number(fs.readFileSync(path.join(f.root, "target-started"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const calls = f.calls();
    const attempted = calls.findIndex(
      (call) => call.directory === target && call.command[0] === "up",
    );
    expect(calls.slice(attempted).every((call) => call.directory !== old)).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(false);
  });
});
