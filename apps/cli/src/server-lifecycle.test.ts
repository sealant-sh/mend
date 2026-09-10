import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import { serverProcessDeadlines, type ServerProcessOptions } from "./server-runtime.ts";
import { nodeServerRuntime, serverCommand, type ServerSetupRuntime } from "./server-setup.ts";
import { describeUninstall, executeUninstall } from "./uninstall.ts";

interface DaemonState {
  readonly appRunning: boolean;
  readonly postgresRunning: boolean;
  readonly version: string;
  readonly images: Readonly<Record<string, string>>;
  readonly fail: string;
  readonly healthVersion: string | null;
}
interface Call {
  readonly args: ReadonlyArray<string>;
  readonly command: ReadonlyArray<string>;
  readonly directory: string | null;
  readonly active: string | null;
  readonly appRunning: boolean;
  readonly poisoned: boolean;
  readonly locked: boolean;
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend lifecycle "));
  const configDir = path.join(root, "config");
  const stateFile = path.join(root, "daemon.json");
  const state = (): DaemonState => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const update = (patch: Partial<DaemonState>) =>
    fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      appRunning: false,
      postgresRunning: false,
      version: "",
      fail: "",
      images: { "0.23.0": "0.23.0", "0.24.0": "0.24.0" },
      healthVersion: null,
    }),
  );
  fs.copyFileSync(
    new URL("../test-fixtures/lifecycle-docker.mjs", import.meta.url),
    path.join(root, "docker"),
  );
  fs.chmodSync(path.join(root, "docker"), 0o700);
  fs.copyFileSync(
    new URL("../test-fixtures/docker-protocol.ts", import.meta.url),
    path.join(root, "docker-protocol.ts"),
  );
  const server = http.createServer((_request, response) => {
    const current = state();
    response.writeHead(current.appRunning ? 200 : 503);
    response.end(
      JSON.stringify({ status: "ok", version: current.healthVersion ?? current.version }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP listener missing");
  const url = `http://127.0.0.1:${address.port}`;
  const environment = { ...process.env };
  process.env["PATH"] = `${root}:${environment["PATH"] ?? ""}`;
  process.env["MEND_VERSION"] = "poison";
  process.env["COMPOSE_PROJECT_NAME"] = "poison";
  process.env["DOCKER_HOST"] = "tcp://poison:1";
  const base = nodeServerRuntime();
  for (const key of ["PATH", "MEND_VERSION", "COMPOSE_PROJECT_NAME", "DOCKER_HOST"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  const lines: Array<string> = [];
  const fetched: Array<string> = [];
  const runCalls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly options: ServerProcessOptions | undefined;
  }> = [];
  const runtime: ServerSetupRuntime = {
    ...base,
    run: (command, args, options) => {
      runCalls.push({ args, options });
      return base.run(command, args, options);
    },
    configDir,
    cliVersion: "99.0.0",
    sleep: async () => undefined,
    writeLine: (line) => {
      lines.push(line);
    },
    fetchText: async (request, timeout) => {
      fetched.push(request);
      if (!request.startsWith(url)) throw new Error("Unexpected network request");
      return base.fetchText(request, timeout);
    },
  };
  const assets = path.join(root, "release assets");
  fs.mkdirSync(assets);
  for (const name of ["compose.v2.yaml", "postgres-init.sh"]) {
    fs.copyFileSync(
      new URL(`../test-fixtures/docker/${name}`, import.meta.url),
      path.join(assets, name),
    );
  }
  const calls = (): ReadonlyArray<Call> =>
    fs.existsSync(path.join(root, "calls.jsonl"))
      ? fs
          .readFileSync(path.join(root, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const active = () => fs.realpathSync(path.join(configDir, "active"));
  const files = () =>
    Object.fromEntries(
      fs
        .readdirSync(active())
        .map((name) => [name, fs.readFileSync(path.join(active(), name), "utf8")]),
    );
  const setup = (version = "0.23.0") =>
    serverCommand(
      [
        "setup",
        "--context",
        "saved-local",
        "--version",
        version,
        "--url",
        url,
        "--port",
        String(address.port),
        "--assets-dir",
        assets,
        "--offline",
      ],
      runtime,
    );
  const upgrade = (version = "0.24.0") =>
    serverCommand(["upgrade", "--version", version, "--assets-dir", assets, "--offline"], runtime);
  return {
    root,
    configDir,
    runtime,
    lines,
    fetched,
    state,
    update,
    calls,
    active,
    files,
    setup,
    upgrade,
    assets,
    runCalls,
  };
};

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
      expect(f.fetched.every((request) => request.endsWith("/api/health"))).toBe(true);
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

  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.9.0", "1.10.0"],
  ])("orders %s before %s and refuses the reverse", async (oldVersion, targetVersion) => {
    const f = await fixture();
    f.update({ images: { [oldVersion]: oldVersion, [targetVersion]: targetVersion } });
    expect(await f.setup(oldVersion)).toEqual({ _tag: "ok" });
    expect(await f.upgrade(targetVersion)).toEqual({ _tag: "ok" });
    const target = f.active();
    expect(await f.upgrade(oldVersion)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Refusing downgrade"),
    });
    expect(f.active()).toBe(target);
  });

  it("resolves latest only on explicit online upgrade", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ images: { "0.23.0": "0.23.0" } });
    const requests: Array<string> = [];
    const runtime: ServerSetupRuntime = {
      ...f.runtime,
      fetchText: async (url, timeout) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/sealant-sh/Mend/releases/latest") {
          return { status: 200, body: '{"tag_name":"v0.24.0"}' };
        }
        return f.runtime.fetchText(url, timeout);
      },
    };
    expect(
      await serverCommand(["upgrade", "--version", "latest", "--assets-dir", f.assets], runtime),
    ).toEqual({ _tag: "ok" });
    expect(requests.filter((url) => !url.endsWith("/api/health"))).toEqual([
      "https://api.github.com/repos/sealant-sh/Mend/releases/latest",
    ]);
    expect(f.state().version).toBe("0.24.0");
    // The pull shows Docker's own progress on the terminal instead of a captured, silent wait.
    expect(f.runCalls.find((call) => call.args[2] === "pull")?.options).toEqual({
      timeoutMs: serverProcessDeadlines.pull,
      stdout: "inherit",
    });
    expect(f.lines).toContain("Pulling ghcr.io/sealant-sh/mend:0.24.0");
  });

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

  it.each(["assets", "image-missing", "image-label", "compose-config", "backup-directory"])(
    "fails %s preflight without stopping the app or changing the pin",
    async (failure) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const old = f.active();
      if (failure === "assets")
        fs.writeFileSync(path.join(f.assets, "compose.v2.yaml"), "services: invalid");
      if (failure === "image-missing") f.update({ images: { "0.23.0": "0.23.0" } });
      if (failure === "image-label")
        f.update({ images: { "0.23.0": "0.23.0", "0.24.0": "0.99.0" } });
      if (failure === "compose-config") f.update({ fail: failure });
      if (failure === "backup-directory")
        fs.writeFileSync(path.join(f.configDir, "backups"), "blocked");
      expect((await f.upgrade())._tag).toBe("error");
      expect(f.active()).toBe(old);
      expect(f.state().appRunning).toBe(true);
      expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    },
  );

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

  it.each(["start", "restart", "stop", "status", "logs", "upgrade"])(
    "verifies ownership under lock before lifecycle Compose (%s)",
    async (command) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const file = path.join(f.root, "docker-protocol.json");
      const saved: { volumes: Array<[string, Record<string, string>]> } = JSON.parse(
        fs.readFileSync(file, "utf8"),
      );
      for (const [name, labels] of saved.volumes) {
        if (name === "mend-control") labels[SERVER_VOLUME_OWNER_LABEL] = "foreign-identity";
      }
      fs.writeFileSync(file, JSON.stringify(saved));
      const count = f.calls().length;
      const before = f.files();
      const result = await serverCommand(
        command === "upgrade"
          ? [command, "--version", "0.24.0", "--assets-dir", f.assets, "--offline"]
          : [command],
        f.runtime,
      );
      expect(result).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("ownership"),
      });
      expect(
        f
          .calls()
          .slice(count)
          .every(
            (call) =>
              call.locked &&
              call.args[2] === "volume" &&
              ["ls", "inspect"].includes(call.args[3] ?? ""),
          ),
      ).toBe(true);
      expect(f.files()).toEqual(before);
      expect(f.state().appRunning).toBe(true);
      saved.volumes = saved.volumes.filter(([name]) => name !== "mend-control");
      fs.writeFileSync(file, JSON.stringify(saved));
      expect((await serverCommand([command], f.runtime))._tag).toBe("error");
      expect(
        f
          .calls()
          .slice(count)
          .some((call) => call.args[3] === "create" || call.directory !== null),
      ).toBe(false);
    },
  );

  it("status and logs allocate nothing; start and restart draw no randomness and forward deadlines", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const count = f.calls().length;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["logs"], f.runtime)).toEqual({ _tag: "ok" });
    expect(
      f
        .calls()
        .slice(count)
        .every(
          (call) =>
            call.locked &&
            (call.args[2] === "volume" || ["ps", "logs"].includes(call.command[0] ?? "")),
        ),
    ).toBe(true);
    for (const command of ["start", "restart"])
      expect(await serverCommand([command], f.runtime)).toEqual({ _tag: "ok" });
    // No registry probe any more: nothing is imported, pushed, pulled or removed on start.
    expect(
      f.runCalls.some((call) => ["import", "push", "pull", "rm"].includes(call.args[3] ?? "")),
    ).toBe(false);
    const starts = f.runCalls.filter((call) => call.args.includes("up"));
    expect(
      starts.every(
        (call) =>
          call.options?.timeoutMs === serverProcessDeadlines.startup &&
          call.args.includes("--wait-timeout"),
      ),
    ).toBe(true);
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

  it("status and start refuse a health version different from the saved pin without rewriting it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const old = f.active();
    f.update({ healthVersion: "0.99.0" });
    expect((await serverCommand(["status"], f.runtime))._tag).toBe("error");
    expect((await serverCommand(["start"], f.runtime))._tag).toBe("error");
    expect(f.active()).toBe(old);
  });
});

describe("server uninstall", { timeout: 60_000 }, () => {
  it("takes the installation down, removes its volumes, image and files, and releases the lock", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    const home = path.join(f.root, "home", "mend");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "cli.json"), "{}");
    const runtime = {
      server: f.runtime,
      cliHome: home,
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => "must not be called",
    };

    const plan = await describeUninstall(runtime, "server");
    expect(plan.home).toBeNull();
    expect(plan.server).toEqual({
      version: "0.23.0",
      appUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      dockerContext: "saved-local",
      generations: 1,
      backups: 0,
    });
    const before = f.calls().length;

    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    expect(commands).toContain("down --volumes --remove-orphans --timeout 30");
    expect(commands).toContain("volume rm mend-store mend-control");
    expect(commands).toContain("image rm ghcr.io/sealant-sh/mend:0.23.0");
    expect(f.state()).toMatchObject({ appRunning: false, postgresRunning: false });
    expect(f.state().images["0.23.0"]).toBeUndefined();
    for (const name of ["identity.env", "active", "generations", "server.lock"]) {
      expect(fs.existsSync(path.join(f.configDir, name)), name).toBe(false);
    }
    // The home scope was not asked for: the laptop-side files stay.
    expect(fs.existsSync(path.join(home, "cli.json"))).toBe(true);
    expect(await serverCommand(["status"], f.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("No Mend server is configured"),
    });
    expect(outcome.leftovers).toEqual([]);
  });

  it("keeps the files when compose down fails, so a retry can still find the installation", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ fail: "down" });
    const runtime = {
      server: f.runtime,
      cliHome: path.join(f.root, "home", "mend"),
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => null,
    };
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "server"));
    expect(outcome.failures).toEqual([expect.stringContaining("docker compose down failed")]);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(false);
    const volumes = JSON.parse(fs.readFileSync(path.join(f.root, "docker-protocol.json"), "utf8"));
    expect(volumes.volumes.map(([name]: [string]) => name)).toEqual(
      expect.arrayContaining(["mend-store", "mend-control"]),
    );
  });
});
