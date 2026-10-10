import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import { serverProcessDeadlines, type ServerProcessOptions } from "./server-runtime.ts";
import {
  isPreviewToNext,
  nodeServerRuntime,
  serverCommand,
  type ServerSetupRuntime,
} from "./server-setup.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";
import { describeUninstall, executeUninstall, planLines } from "./uninstall.ts";

interface DaemonState {
  readonly appRunning: boolean;
  readonly postgresRunning: boolean;
  /** The edge's container, when a generation runs one (lifecycle-docker.mjs sets it on `up`). */
  readonly edgeRunning?: boolean;
  /** The certificate path Caddy's data holds for the edge host; absent, none yet. */
  readonly certificate?: string;
  /** How many times the CLI removed a stray edge container by its labels. */
  readonly removedEdge?: number;
  /** The generation directory the edge was started from, as Compose would label it. */
  readonly edgeDirectory?: string;
  readonly version: string;
  readonly images: Readonly<Record<string, string>>;
  /** The versions whose image carries the t3code gateway (its label). */
  readonly gatewayImages?: ReadonlyArray<string>;
  readonly fail: string;
  readonly healthVersion: string | null;
  /** Fields the health body carries beside status and version: tenancy, its gate, exposure. */
  readonly health?: Readonly<Record<string, unknown>>;
  /** Each mirror's container, by service, with the generation it was started from. */
  readonly mirrorContainers?: Readonly<Record<string, string>>;
  /** What the Docker mirror's guard reports, and the KiB free under the mirrors. */
  readonly mirrorGuard?: string;
  readonly mirrorFreeKiB?: number;
  /** The compose files the last `up` and `down` ran with, by name. */
  readonly upFiles?: ReadonlyArray<string>;
  readonly downFiles?: ReadonlyArray<string>;
  /** Each image's /app/migrations.txt, by version. */
  readonly manifests?: Readonly<Record<string, string>>;
  /** The migrations each database applied, as psql prints them, by database. */
  readonly applied?: Readonly<Record<string, ReadonlyArray<string>>>;
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
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    const current = state();
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    // The operator's reports, for a bearer; `/api/health` for everyone.
    if (request.url === "/api/operator/gate" || request.url === "/api/operator/exposure") {
      if (request.headers.authorization !== "Bearer operator-token") {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      response.writeHead(200);
      response.end(
        JSON.stringify(
          request.url === "/api/operator/gate"
            ? [
                { id: "source-policy", ok: false, detail: "operator policy", fix: "set it" },
                { id: "operator-present", ok: true, detail: "1 operator account(s)", fix: null },
              ]
            : {
                declared: "private",
                items: [
                  {
                    id: "https-origin",
                    established: "observed",
                    detail: "every browser origin is https (1)",
                    fix: null,
                    blocksStart: true,
                  },
                  {
                    id: "edge-tls",
                    established: "open",
                    detail: "this process cannot observe the edge's certificate",
                    fix: "what would verify it: mend doctor from another network",
                    blocksStart: false,
                  },
                ],
              },
        ),
      );
      return;
    }
    response.writeHead(current.appRunning ? 200 : 503);
    response.end(
      JSON.stringify({
        status: "ok",
        version: current.healthVersion ?? current.version,
        ...current.health,
      }),
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
  // This machine's own sign-in never reaches the fixture: status reads cli.json under configDir.
  delete process.env["MEND_URL"];
  delete process.env["MEND_TOKEN"];
  const base = nodeServerRuntime();
  for (const key of [
    "PATH",
    "MEND_VERSION",
    "COMPOSE_PROJECT_NAME",
    "DOCKER_HOST",
    "MEND_URL",
    "MEND_TOKEN",
  ]) {
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
    fetchText: async (request, timeout, headers) => {
      fetched.push(request);
      if (!request.startsWith(url)) throw new Error("Unexpected network request");
      return base.fetchText(request, timeout, headers);
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
  const volumes = (): ReadonlyMap<string, Readonly<Record<string, string>> | null> =>
    new Map(JSON.parse(fs.readFileSync(path.join(root, "docker-protocol.json"), "utf8")).volumes);
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
  /** Setup behind the edge: Mend's port stays on loopback, where the fixture's health answers. */
  /** The edge on a fresh box, which setup refuses: the plain install first, the edge on a rerun. */
  const freshEdge = (host: string, ...more: ReadonlyArray<string>) =>
    serverCommand(
      [
        "setup",
        "--context",
        "saved-local",
        "--version",
        "0.23.0",
        "--port",
        String(address.port),
        "--assets-dir",
        assets,
        "--offline",
        "--edge",
        host,
        ...more,
      ],
      runtime,
    );
  const setupEdge = async (host: string, ...more: ReadonlyArray<string>) => {
    const first = await setup();
    if (first._tag !== "ok") return first;
    return serverCommand(["setup", "--offline", "--edge", host, ...more], runtime);
  };
  return {
    root,
    configDir,
    runtime,
    lines,
    fetched,
    requests,
    state,
    update,
    calls,
    active,
    volumes,
    files,
    setup,
    setupEdge,
    freshEdge,
    upgrade,
    assets,
    runCalls,
    port: address.port,
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

  describe("from a preview numbered before the next channel", () => {
    const preview = "0.36.0-preview.17";
    const next = "0.36.0-next.60";
    const ledgerHash = "a".repeat(64);
    const stopHash = "b".repeat(64);
    const manifest = [
      "mend 0001_init",
      "mend 0107_turn_payer",
      `sealant 20260901120000_capture_ledger ${ledgerHash}`,
      `sealant 20261003093819_stop_remains_removed ${stopHash}`,
    ].join("\n");
    const onPreview = async (applied: Readonly<Record<string, ReadonlyArray<string>>>) => {
      const f = await fixture();
      f.update({
        images: { [preview]: preview, [next]: next, "0.36.0-next.61": "0.36.0-next.61" },
        manifests: { [next]: manifest },
        applied,
      });
      expect(await f.setup(preview)).toEqual({ _tag: "ok" });
      return f;
    };
    // As psql prints the real tables: Effect's mend_migrations keeps the id and the name apart
    // (key 0107_turn_payer is stored as 107 | turn_payer); drizzle keeps name, time and hash.
    const everything = {
      mend: ["1|init", "107|turn_payer"],
      // An old drizzle row without a name is matched by its folder time (2026-09-01 12:00:00 UTC).
      sealant_control_plane: [
        `|${Date.UTC(2026, 8, 1, 12, 0, 0)}|${ledgerHash}`,
        `20261003093819_stop_remains_removed|1759484299000|${stopHash}`,
      ],
    };

    it("refuses the move as a downgrade and names the one-time way", async () => {
      const f = await onPreview(everything);
      expect(await f.upgrade(next)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(`mend server upgrade --version ${next} --from-preview`),
      });
      expect(f.state().version).toBe(preview);
    });

    it("moves once with --from-preview when the target carries every applied migration", async () => {
      const f = await onPreview(everything);
      const old = f.active();
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toEqual({ _tag: "ok" });
      expect(f.state().version).toBe(next);
      expect(f.active()).not.toBe(old);
      expect(f.lines).toContain(
        `ghcr.io/sealant-sh/mend:${next} carries all 4 migrations this server applied.`,
      );
      // Read before anything stops.
      const calls = f.calls();
      const stop = calls.findIndex((call) => call.command[0] === "stop");
      const reads = calls.filter(
        (call) => call.command.includes("psql") || call.args.includes("/app/migrations.txt"),
      );
      expect(reads).toHaveLength(3);
      expect(calls.findIndex((call) => call.command.includes("psql"))).toBeLessThan(stop);
      // After the move, ordinary upgrades follow the next channel.
      expect(await f.upgrade("0.36.0-next.61")).toEqual({ _tag: "ok" });
    });

    it("refuses, naming them, when the target lacks a migration the server applied", async () => {
      const f = await onPreview({
        mend: ["1|init", "107|turn_payer", "108|opencode_models"],
        sealant_control_plane: [
          ...everything.sealant_control_plane,
          `20261004000000_unmerged|1|${"c".repeat(64)}`,
        ],
      });
      const old = f.active();
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(
          "cannot take this server's databases (2): mend 0108_opencode_models is applied here and not in the target; sealant 20261004000000_unmerged is applied here and not in the target",
        ),
      });
      expect(f.active()).toBe(old);
      expect(f.state().version).toBe(preview);
      expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    });

    it("recovers the preview's own image when the backup fails", async () => {
      const f = await onPreview(everything);
      const old = f.active();
      f.update({ fail: "backup" });
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({ _tag: "error", message: expect.stringContaining("app recovered") });
      expect(f.active()).toBe(old);
      expect(f.state()).toMatchObject({ version: preview, appRunning: true });
    });

    it("refuses a target that does not list its migrations", async () => {
      const f = await onPreview(everything);
      f.update({ manifests: {} });
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("does not list its migrations"),
      });
      expect(f.state().version).toBe(preview);
    });

    it("refuses --from-preview for anything but X.Y.Z-preview.K to X.Y.Z-next.N", async () => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      expect(
        await serverCommand(
          [
            "upgrade",
            "--version",
            "0.24.0",
            "--from-preview",
            "--assets-dir",
            f.assets,
            "--offline",
          ],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("--from-preview moves a server"),
      });
      expect(isPreviewToNext("0.36.0-preview.17", "0.36.0-next.1")).toBe(true);
      // A new-style preview is a way off the old numbering too.
      expect(isPreviewToNext("0.36.0-preview.17", "0.36.0-next.584.preview.40")).toBe(true);
      expect(isPreviewToNext("0.36.0-preview.17", "0.37.0-next.1")).toBe(false);
      expect(isPreviewToNext("0.36.0-next.5.preview.17", "0.36.0-next.6")).toBe(false);
      expect(isPreviewToNext("0.36.0", "0.36.0-next.1")).toBe(false);
    });
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

  describe("upgrade backups", () => {
    const versions = ["0.24.0", "0.25.0", "0.26.0", "0.27.0"] as const;
    const withVersions = async () => {
      const f = await fixture();
      f.update({
        images: Object.fromEntries(["0.23.0", ...versions].map((version) => [version, version])),
      });
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const backups = () => fs.readdirSync(path.join(f.configDir, "backups")).toSorted();
      const upgradeKeeping = (version: string, keep: string) =>
        serverCommand(
          [
            "upgrade",
            "--version",
            version,
            "--keep-backups",
            keep,
            "--assets-dir",
            f.assets,
            "--offline",
          ],
          f.runtime,
        );
      return { ...f, backups, upgradeKeeping };
    };

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

    it.each(["backup", "target-start"])(
      "prunes nothing when the upgrade fails at %s, and keeps that backup on the next healthy one",
      async (failure) => {
        const f = await withVersions();
        for (const version of versions.slice(0, 2))
          expect(await f.upgradeKeeping(version, "0")).toEqual({ _tag: "ok" });
        const healthy = f.backups();
        f.update({ fail: failure });
        expect((await f.upgradeKeeping(versions[2], "1"))._tag).toBe("error");
        const failed = f.backups().filter((name) => !healthy.includes(name));
        expect(failed).toHaveLength(1);
        expect(f.backups()).toHaveLength(3);
        expect(f.lines.some((line) => line.startsWith("Removed upgrade backup "))).toBe(false);
        f.update({ fail: "" });
        // After a failed target start the target pin stays; start it, then upgrade past it.
        if (failure === "target-start")
          expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
        expect(await f.upgradeKeeping(versions[3], "1")).toEqual({ _tag: "ok" });
        // The healthy ones went; the failed upgrade's record says pending or unfinished, and stays.
        expect(f.backups()).toHaveLength(2);
        expect(f.backups()).toContain(failed[0]);
        expect(f.lines).toContain(
          `Kept upgrade backup ${path.join(f.configDir, "backups", failed[0] ?? "")} · ${
            failure === "backup"
              ? "unfinished: no complete database dump"
              : "pending: its upgrade never recorded a healthy target"
          }`,
        );
      },
    );
  });

  it("an upgrade from a generation without Garage claims mend-garage under the unchanged identity and lays the bucket out", async () => {
    const f = await fixture();
    const composeWithGarage = fs.readFileSync(path.join(f.assets, "compose.v2.yaml"), "utf8");
    fs.copyFileSync(
      new URL("../test-fixtures/docker/compose.v2.before-garage.yaml", import.meta.url),
      path.join(f.assets, "compose.v2.yaml"),
    );
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(JSON.parse(before["server.json"] ?? "{}")).not.toHaveProperty("bucket");
    expect([...f.volumes().keys()]).toEqual(["mend-store", "mend-control"]);
    expect(f.calls().some((call) => call.command.includes("garage"))).toBe(false);
    // Lifecycle commands verify the two volumes the generation owns; none asks for the bucket.
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    fs.writeFileSync(path.join(f.assets, "compose.v2.yaml"), composeWithGarage);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const after = f.files();
    expect(after["identity.env"]).toBe(before["identity.env"]);
    expect(JSON.parse(after["server.json"] ?? "{}")).toMatchObject({
      serverVersion: "0.24.0",
      bucket: "garage",
    });
    const owner = createHash("sha256")
      .update(before["identity.env"] ?? "")
      .digest("hex");
    expect([...f.volumes()]).toEqual([
      ["mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
      ["mend-control", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
      ["mend-garage", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
    ]);
    const calls = f.calls();
    const claim = f.runCalls.findIndex(
      (call) =>
        call.args[2] === "volume" &&
        call.args[3] === "create" &&
        call.args.at(-1) === "mend-garage",
    );
    const stop = f.runCalls.findIndex((call) => call.args.includes("stop"));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(stop);
    const garageInit = calls
      .filter((call) => call.command[0] === "exec" && call.command.includes("garage"))
      .map((call) =>
        call.command
          .slice(
            call.command.indexOf("/etc/garage.toml") + 1,
            call.command.indexOf("/etc/garage.toml") + 3,
          )
          .join(" "),
      );
    expect(garageInit).toEqual([
      "status",
      "layout assign",
      "layout apply",
      "bucket create",
      "key import",
      "bucket allow",
      "bucket info",
    ]);
    expect(f.lines).toContain("Capture store bucket mend is laid out in Garage");
    // The upgraded generation verifies all three; a rerun claims nothing again.
    const mutations = f.runCalls.filter((call) => call.args[3] === "create").length;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.runCalls.filter((call) => call.args[3] === "create")).toHaveLength(mutations);
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
            (call.args[2] === "volume" ||
              ["ps", "logs"].includes(call.command[0] ?? "") ||
              // The mirrors are read, never changed: their volume's size and the registry's counters.
              (call.command[0] === "exec" &&
                (call.command.some((arg) => arg.startsWith("du -sk ")) ||
                  call.command.includes("wget"))) ||
              (call.args[2] === "container" && call.args[3] === "inspect")),
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

/** A file of deploy/docker, the source the CLI's embedded edge files are held to. */
const repositoryFile = (name: string): string =>
  fs.readFileSync(new URL(`../../../deploy/docker/${name}`, import.meta.url), "utf8");

/** Turn the active generation into one written before the mirrors: no field, no files, no size. */
const withoutMirrors = (directory: string): void => {
  const configFile = path.join(directory, "server.json");
  const { mirrors: _mirrors, ...config } = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const envFile = path.join(directory, "server.env");
  fs.writeFileSync(
    envFile,
    fs
      .readFileSync(envFile, "utf8")
      .split("\n")
      .filter((line) => !/^MEND_(NPM|DOCKER)_MIRROR_MAX_SIZE=/.test(line))
      .join("\n"),
  );
  for (const file of ["compose.mirrors.yaml", "npm-mirror.conf", "docker-mirror-guard.sh"])
    fs.rmSync(path.join(directory, file));
};

describe("the mirrors", { timeout: 120_000 }, () => {
  it("runs both on a new install, and status reports each as observed", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").mirrors).toEqual({
      npm: { maxSize: "10g" },
      docker: { maxSize: "20g" },
    });
    expect(files["compose.mirrors.yaml"]).toContain("\n  npm-mirror:\n");
    expect(files["compose.mirrors.yaml"]).toContain("\n  docker-mirror:\n");
    expect(files["npm-mirror.conf"]).toContain("proxy_cache npm;");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    // Both images are checked beside the bundle's.
    expect(f.runCalls.some((call) => call.args.includes("nginx:1.29-alpine"))).toBe(true);
    expect(f.runCalls.some((call) => call.args.includes("registry:3.1"))).toBe(true);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "npm mirror · running · 2.0 MiB cached of 10 GiB · 1.0 GiB free on its disk · last 24 h: 2 tarball requests · 1 served from the cache (50%) · 1 fetched from registry.npmjs.org · observed",
    );
    expect(f.lines).toContain(
      "docker mirror · running · 2.0 MiB cached of 20 GiB · 1.0 GiB free on its disk · layers evicted 7 days after each fetch · since 2026-10-10T08:00:00Z: layers 4 requested · 3 from the cache (75%) · manifests 4 · 2 from the cache · pulls from Docker Hub anonymously · observed",
    );
  });

  it("an upgrade adds them to an install from before them, and says so", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    withoutMirrors(f.active());
    f.update({ mirrorContainers: {} });
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").mirrors).toEqual({
      npm: { maxSize: "10g" },
      docker: { maxSize: "20g" },
    });
    expect(f.files()["server.env"]).toContain("MEND_NPM_MIRROR_MAX_SIZE=10g\n");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    expect(f.lines).toContain(
      "The npm mirror runs on this install. New sessions install npm packages through it, capped at 10g.",
    );
    expect(f.lines).toContain(
      "The Docker mirror runs on this install. New sessions' Docker daemons pull Docker Hub images through it (mend-docker-mirror).",
    );
  });

  it("turned off, a mirror leaves the generation, its container is removed by label, and its cache stays", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--no-npm-mirror"], f.runtime)).toEqual({
      _tag: "ok",
    });
    const files = f.files();
    expect(files["npm-mirror.conf"]).toBeUndefined();
    expect(files["compose.mirrors.yaml"]).not.toContain("npm-mirror");
    expect(files["server.env"]).not.toContain("MEND_NPM_MIRROR_MAX_SIZE");
    expect(f.state().mirrorContainers).toEqual({ "docker-mirror": expect.any(String) });
    expect(f.lines).toContain(
      "Removed the npm mirror container mend-npm-mirror-1, which this generation does not run.",
    );
    expect(f.lines).toContain(
      "The npm mirror is off. Its cache stays until you remove it: docker --context saved-local volume rm mend_mend-npm-mirror",
    );
    // Kept off across a rerun and an upgrade.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").mirrors).toEqual({
      npm: null,
      docker: { maxSize: "20g" },
    });
    // Both off: no overlay at all, and the generation reads as one from before the mirrors.
    expect(await serverCommand(["setup", "--offline", "--no-docker-mirror"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.files()["compose.mirrors.yaml"]).toBeUndefined();
    expect(f.state().upFiles).toEqual(["compose.yaml"]);
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "npm mirror · off on this install · mend server setup --npm-mirror turns it on",
    );
    // On again, with a cap of its own.
    expect(
      await serverCommand(
        ["setup", "--offline", "--npm-mirror", "--npm-mirror-max-size", "25G"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_NPM_MIRROR_MAX_SIZE=25g\n");
  });

  it("keeps a Docker Hub token in server.env alone, read from standard input, across reruns and upgrades", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const token = "dckr_pat_s3cret-Token";
    const withStdin: ServerSetupRuntime = { ...f.runtime, readStdin: async () => `${token}\n` };
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--docker-hub-username",
          "mendbot",
          "--docker-hub-token-stdin",
          "--docker-hub-public-only",
        ],
        withStdin,
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files["server.env"]).toContain(`MEND_DOCKER_HUB_TOKEN=${token}\n`);
    expect(files["server.env"]).toContain("MEND_DOCKER_HUB_USERNAME=mendbot\n");
    for (const name of ["server.json", "compose.mirrors.yaml", "identity.env"])
      expect(files[name]).not.toContain(token);
    expect(JSON.parse(files["server.json"] ?? "{}").mirrors.docker).toEqual({
      maxSize: "20g",
      upstreamUser: "mendbot",
      upstreamPublicOnly: true,
    });
    // Never on a command line.
    expect(f.calls().some((call) => call.args.some((arg) => arg.includes(token)))).toBe(false);
    // Carried by a rerun and an upgrade, which read it back from server.env.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain(`MEND_DOCKER_HUB_TOKEN=${token}\n`);
    // And gone again.
    expect(await serverCommand(["setup", "--offline", "--no-docker-hub-login"], f.runtime)).toEqual(
      { _tag: "ok" },
    );
    expect(f.files()["server.env"]).not.toContain("MEND_DOCKER_HUB");
    expect(f.files()["compose.mirrors.yaml"]).not.toContain("REGISTRY_PROXY_USERNAME");
  });

  it("caps the Docker mirror, says when its guard paused it, and never renders an undeclared login", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--docker-mirror-max-size", "40G"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_DOCKER_MIRROR_MAX_SIZE=40g\n");
    expect(f.files()["docker-mirror-guard.sh"]).toContain("registry serve");
    f.update({ mirrorGuard: "paused 3072 5120 none", mirrorFreeKiB: 3 * 1024 * 1024 });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "docker mirror · paused by its disk guard · 3.0 GiB free on its disk, below 5.0 GiB · no cache held · session Docker daemons pull from Docker Hub directly until there is room · observed",
    );
    // A saved login without the operator's public-only statement is refused, not rendered.
    const configFile = path.join(f.active(), "server.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.mirrors.docker = { maxSize: "40g", upstreamUser: "mendbot" };
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const refused = await serverCommand(["status"], f.runtime);
    expect(refused._tag).toBe("error");
    expect(refused._tag === "error" ? refused.message : "").toContain(
      "the Docker mirror's login lacks upstreamPublicOnly",
    );
  });

  it.each([
    [
      ["--npm-mirror", "--no-npm-mirror"],
      "--npm-mirror and --no-npm-mirror contradict each other.",
    ],
    [["--npm-mirror-max-size", "512m"], "--npm-mirror-max-size must be"],
    [["--no-npm-mirror", "--npm-mirror-max-size", "20g"], "contradict each other"],
    [["--docker-hub-username", "mendbot"], "go together"],
    [
      ["--docker-hub-username", "mendbot", "--docker-hub-token-stdin"],
      'needs --docker-hub-public-only. The Docker mirror has no login of its own: every session that reaches it can pull whatever the token can read, private repositories included. Create a Docker Hub personal access token with the access permission "Public Repo Read-only"',
    ],
    [["--docker-hub-public-only"], "goes with --docker-hub-username"],
    [["--docker-hub-token-stdin"], "go together"],
    [
      [
        "--docker-hub-username",
        "mendbot",
        "--docker-hub-token-stdin",
        "--docker-hub-public-only",
        "--no-docker-mirror",
      ],
      "--docker-hub-username and --no-docker-mirror contradict each other.",
    ],
    [
      ["--docker-hub-username", "a b", "--docker-hub-token-stdin", "--docker-hub-public-only"],
      "is not a Docker Hub user name",
    ],
  ])("refuses %j before anything is written", async (flags, message) => {
    const f = await fixture();
    const result = await serverCommand(["setup", ...flags], f.runtime);
    expect(result._tag).toBe("error");
    expect(result._tag === "error" ? result.message : "").toContain(message);
    expect(fs.existsSync(path.join(f.configDir, "active"))).toBe(false);
  });

  it("refuses a token that is not one, without writing it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const before = f.files()["server.env"];
    const withStdin: ServerSetupRuntime = { ...f.runtime, readStdin: async () => "two words\n" };
    const result = await serverCommand(
      [
        "setup",
        "--offline",
        "--docker-hub-username",
        "mendbot",
        "--docker-hub-token-stdin",
        "--docker-hub-public-only",
      ],
      withStdin,
    );
    expect(result._tag).toBe("error");
    expect(f.files()["server.env"]).toBe(before);
  });
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  const host = "mend.example.test";

  it("an edge host and the posture travel with every generation: setup, upgrade, start and restart run the overlays", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host, "--exposure", "private", "--tenancy", "single")).toEqual({
      _tag: "ok",
    });
    const before = f.files();
    // The generation holds the repository's edge files byte for byte, and names the posture.
    expect(before["compose.edge.yaml"]).toBe(repositoryFile("compose.edge.yaml"));
    expect(before["Caddyfile"]).toBe(repositoryFile("Caddyfile"));
    expect(fs.statSync(path.join(f.active(), "Caddyfile")).mode & 0o777).toBe(0o644);
    expect(before["compose.posture.yaml"]).toContain(
      "      MEND_EXPOSURE: ${MEND_EXPOSURE:?set MEND_EXPOSURE in server.env}",
    );
    expect(before["compose.posture.yaml"]).toContain("      MEND_TENANCY: ${MEND_TENANCY:?");
    expect(before["compose.posture.yaml"]).not.toContain("MEND_SOURCE_POLICY");
    expect(JSON.parse(before["server.json"] ?? "{}")).toMatchObject({
      edgeHost: host,
      exposure: "private",
      tenancy: "single",
      bind: "127.0.0.1",
      appUrl: `https://${host}`,
    });
    const env = before["server.env"] ?? "";
    expect(env).toContain(`MEND_EDGE_HOST=${host}\n`);
    expect(env).toContain("MEND_EXPOSURE=private\n");
    expect(env).toContain("MEND_TENANCY=single\n");
    expect(env).toContain(`APP_URL=https://${host}\n`);
    expect(env).toContain("MEND_BIND_HOST=127.0.0.1\n");
    expect(env).toContain(`SEALANT_SSH_HOST=${host}\n`);
    expect(env).not.toContain("MEND_SOURCE_POLICY");
    // Compose ran the base file and both overlays, in that order, and the edge came up.
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.posture.yaml",
      "compose.mirrors.yaml",
    ]);
    expect(f.state().edgeRunning).toBe(true);
    // Health was read on Mend's own loopback port, never through the edge's public name.
    expect(f.fetched.every((request) => request === `http://127.0.0.1:${f.port}/api/health`)).toBe(
      true,
    );
    expect(f.fetched.some((request) => request.includes(host))).toBe(false);
    expect(f.lines).toContain(
      `Mend 0.23.0 answers at http://127.0.0.1:${f.port} on this machine · the edge is set up for https://${host}`,
    );
    expect(
      f.lines.some((line) => line.startsWith(`The edge for ${host} is up on 80 and 443.`)),
    ).toBe(true);
    // The edge image is checked beside the bundle's, from the generation's own overlay.
    expect(f.runCalls.some((call) => call.args.includes("caddy:2.10-alpine"))).toBe(true);

    // An upgrade carries all of it: same overlays, same values, the new version.
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const after = f.files();
    expect(after["compose.edge.yaml"]).toBe(before["compose.edge.yaml"]);
    expect(after["Caddyfile"]).toBe(before["Caddyfile"]);
    expect(after["compose.posture.yaml"]).toBe(before["compose.posture.yaml"]);
    expect(after["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    expect(JSON.parse(after["server.json"] ?? "{}")).toMatchObject({
      serverVersion: "0.24.0",
      edgeHost: host,
      exposure: "private",
      tenancy: "single",
    });
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.posture.yaml",
      "compose.mirrors.yaml",
    ]);
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles).toEqual([
        "compose.yaml",
        "compose.edge.yaml",
        "compose.posture.yaml",
        "compose.mirrors.yaml",
      ]);
    }
    expect(f.lines).toContain(
      "Mend, Postgres, Garage, the edge, the npm mirror and the Docker mirror stopped. Volumes, configuration and workspace containers are retained.",
    );
    expect(f.state().edgeRunning).toBe(true);
  });

  it("the t3code gateway's overlay runs with every start, and status says what this machine observed at its port", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    let answering = true;
    const gatewayProbes: Array<string> = [];
    const runtime = {
      ...f.runtime,
      fetchText: async (
        url: string,
        timeout: number,
        headers?: Readonly<Record<string, string>>,
      ) => {
        if (url.startsWith("http://127.0.0.1:3120/")) {
          gatewayProbes.push(url);
          return answering
            ? { status: 200, body: '{"environmentId":"e"}' }
            : { status: 0, body: "", error: "connect ECONNREFUSED" };
        }
        return f.runtime.fetchText(url, timeout, headers);
      },
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toEqual({
      _tag: "ok",
    });
    // Setup looked at the port once Mend answered, and said what it saw.
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    expect(
      f.lines.some((line) => line.startsWith("The t3code gateway answered at 127.0.0.1:3120")),
    ).toBe(true);
    gatewayProbes.length = 0;
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml", "compose.t3.yaml"]);
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles).toEqual([
        "compose.yaml",
        "compose.mirrors.yaml",
        "compose.t3.yaml",
      ]);
    }
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · on · 127.0.0.1:3120 · loopback only · reaching it from elsewhere is an exposure you declare",
    );
    expect(f.lines).toContain(
      "t3code gateway · observed answering at 127.0.0.1:3120 from this machine",
    );
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    answering = false;
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · not observed at 127.0.0.1:3120 from this machine · mend server logs shows what it said",
    );
    for (const line of f.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);
  });

  it("refuses an upgrade that carries the gateway onto an image without it, and keeps the pin (644-1)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    const runtime = {
      ...f.runtime,
      fetchText: async (url: string, timeout: number, headers?: Readonly<Record<string, string>>) =>
        url.startsWith("http://127.0.0.1:3120/")
          ? { status: 200, body: '{"environmentId":"e"}' }
          : f.runtime.fetchText(url, timeout, headers),
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toMatchObject({
      _tag: "ok",
    });
    const old = f.active();
    // 0.24.0's image has no gateway: the carried setting is refused before anything stops.
    expect(await f.upgrade()).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Mend 0.24.0 has no t3code gateway"),
    });
    expect(f.active()).toBe(old);
    expect(f.state().appRunning).toBe(true);
    expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    // An image that carries it upgrades as before.
    f.update({ gatewayImages: ["0.23.0", "0.24.0"] });
    expect(await f.upgrade()).toMatchObject({ _tag: "ok" });
  });

  it("status says what was declared beside what was observed, and never a verdict", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host, "--exposure", "private")).toEqual({ _tag: "ok" });
    // Stopped, the edge's data is not read: the line says so instead of claiming an absence.
    expect(await serverCommand(["stop"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · container not running · certificate not observed · the edge is not running, so its data was not read`,
    );
    expect(f.lines).toContain("Mend is stopped. No health claim was made.");
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · caddy:2.10-alpine on 80 and 443 · Mend's own port on loopback`,
    );
    expect(f.lines).toContain("exposure · declared private");
    expect(f.lines).toContain("tenancy · declared single · the default, not set on this install");
    expect(f.lines).toContain(
      `edge · ${host} · container running · no certificate in Caddy's data yet · mend server logs shows what Caddy tried`,
    );
    // A health body from before the gates reports neither; status says so instead of guessing.
    expect(f.lines).toContain(
      "exposure · observed · this server reports no exposure · it predates the gate",
    );
    expect(
      f.lines.some((line) =>
        line.startsWith("gate items · every item with its detail needs the operator's sign-in"),
      ),
    ).toBe(true);

    const certificate = `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${host}/${host}.crt`;
    f.update({
      certificate,
      health: {
        tenancy: "single",
        tenancyGate: { passed: false, failing: ["source-policy", "upload-length-binding"] },
        exposure: { declared: "private", open: 5, unobservable: 3 },
      },
    });
    fs.writeFileSync(
      path.join(f.configDir, "cli.json"),
      JSON.stringify({ url: `https://${host}`, token: "operator-token" }),
    );
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · container running · certificate observed in Caddy's data · ${certificate}`,
    );
    for (const line of f.lines) expect(line).not.toMatch(/[—–]/);
    expect(f.lines).toContain(
      "exposure · observed private · public exposure gate · 5 items open · 2 this build can observe · 3 no build can · mend operator exposure lists them",
    );
    expect(f.lines).toContain(
      "tenancy · observed single · multi mode gate · open: source-policy, upload-length-binding · mend operator gate lists every item",
    );
    // The operator's reports came through the saved sign-in, as a bearer, on the loopback port.
    expect(f.lines).toContain("multi mode gate, as the server reports each item:");
    expect(f.lines).toContain("public exposure gate, as the server reports each item:");
    expect(
      f.lines.some((line) => line.includes("source-policy") && line.includes("operator policy")),
    ).toBe(true);
    expect(f.lines.some((line) => line.includes("edge-tls") && line.includes("open"))).toBe(true);
    expect(
      f.requests
        .filter((request) => request.url.startsWith("/api/operator/"))
        .map((r) => r.authorization),
    ).toEqual(["Bearer operator-token", "Bearer operator-token"]);
    for (const line of f.lines) {
      expect(line).not.toMatch(/\bsafe\b|gate passed|ready to expose|fit to expose/i);
    }

    // Signed in elsewhere: the reports are not read, and status says where the sign-in points.
    fs.writeFileSync(
      path.join(f.configDir, "cli.json"),
      JSON.stringify({ url: "https://other.example.test", token: "operator-token" }),
    );
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `gate items · this machine is signed in to https://other.example.test, not https://${host} · not read`,
    );
  });

  it("a public, multi install renders the gate's environment, after the first account exists", async () => {
    const f = await fixture();
    // A fresh box takes neither the edge nor public: registration would be open on the origin.
    for (const flags of [["--exposure", "public"], [], ["--exposure", "private"]]) {
      expect(await f.freshEdge(host, ...flags)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("A fresh install cannot start with the edge or as public"),
      });
    }
    expect(fs.existsSync(path.join(f.configDir, "active"))).toBe(false);
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    const plain = f.files();
    expect(plain["compose.posture.yaml"]).toBeUndefined();
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.mirrors.yaml",
    ]);
    expect(
      await serverCommand(["setup", "--exposure", "public", "--tenancy", "multi"], f.runtime),
    ).toEqual({ _tag: "ok" });
    const env = f.files()["server.env"] ?? "";
    for (const line of [
      `MEND_EDGE_HOST=${host}`,
      "MEND_EXPOSURE=public",
      "MEND_TENANCY=multi",
      "MEND_SOURCE_POLICY=tenant",
      "MEND_CAPTURE_REQUIRE_SIZES=true",
      "MEND_URL_BEARERS=refuse",
    ]) {
      expect(env).toContain(`${line}\n`);
    }
    expect(env).not.toContain("MEND_GIT_TRANSPORT_BIND_ORIGIN");
    expect(env).not.toContain("MEND_SERVICE_HOSTS");
    const posture = f.files()["compose.posture.yaml"] ?? "";
    for (const key of [
      "MEND_EXPOSURE",
      "MEND_TENANCY",
      "MEND_SOURCE_POLICY",
      "MEND_CAPTURE_REQUIRE_SIZES",
      "MEND_URL_BEARERS",
    ]) {
      expect(posture).toContain(`      ${key}: \${${key}:?set ${key} in server.env}`);
    }
    expect(posture).not.toContain("=public");
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    expect(f.files()["compose.posture.yaml"]).toBe(posture);
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).toMatchObject({
      exposure: "public",
      tenancy: "multi",
      edgeHost: host,
    });
  });

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
    expect(await serverCommand(["setup"], f.runtime)).toEqual({ _tag: "ok" });
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
    expect(planLines(plan, f.configDir).join("\n")).toContain(
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

describe("server uninstall", { timeout: 60_000 }, () => {
  it("names and removes the t3code gateway's volume a turned-off gateway left behind (644-R2-1)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    // What --no-t3-gateway leaves: the generation has no gateway overlay, so Compose's own
    // `down --volumes` does not know the volume that holds paired people's device tokens.
    const protocolFile = path.join(f.root, "docker-protocol.json");
    const saved = fs.existsSync(protocolFile)
      ? JSON.parse(fs.readFileSync(protocolFile, "utf8"))
      : {};
    saved.volumes = [...(saved.volumes ?? []), ["mend_mend-t3-gateway", {}]];
    fs.writeFileSync(protocolFile, JSON.stringify(saved));
    const runtime = {
      server: f.runtime,
      cliHome: path.join(f.root, "home", "mend"),
      sshConfigFile: path.join(f.root, "home", "ssh-config"),
      signedIn: null,
      revokeDevice: async () => "must not be called",
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: "must not be called",
      }),
    };
    const plan = await describeUninstall(runtime, "server");
    expect(plan.server).toMatchObject({ t3GatewayVolume: true });
    expect(planLines(plan, f.configDir).join("\n")).toContain("mend-t3-gateway");
    const before = f.calls().length;
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    const commands = f
      .calls()
      .slice(before)
      .map((call) => (call.command.length > 0 ? call.command : call.args.slice(2)).join(" "));
    expect(commands).toContain("volume rm mend_mend-t3-gateway");
    expect(f.lines.some((line) => line.includes("removed volume mend_mend-t3-gateway"))).toBe(true);
  });

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
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: "must not be called",
      }),
    };

    const plan = await describeUninstall(runtime, "server");
    expect(plan.home).toBeNull();
    expect(plan.server).toEqual({
      version: "0.23.0",
      appUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      dockerContext: "saved-local",
      edgeHost: null,
      mirrors: ["npm-mirror", "docker-mirror"],
      t3GatewayVolume: false,
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
    expect(commands).toContain("volume rm mend-store mend-control mend-garage");
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
      removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => ({
        removed: [],
        stillActive: [],
        problem: null,
      }),
    };
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "server"));
    expect(outcome.failures).toEqual([
      "Docker did not take the server down (docker compose down: fixture operation failed). Containers, volumes and files are kept; get Docker answering, then run mend uninstall again.",
    ]);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "server.lock"))).toBe(false);
    const volumes = JSON.parse(fs.readFileSync(path.join(f.root, "docker-protocol.json"), "utf8"));
    expect(volumes.volumes.map(([name]: [string]) => name)).toEqual(
      expect.arrayContaining(["mend-store", "mend-control"]),
    );
  });
});
