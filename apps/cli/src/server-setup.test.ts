import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DockerProtocol } from "../test-fixtures/docker-protocol.ts";
import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const composeAsset = fs.readFileSync(
  new URL("../test-fixtures/docker/compose.v2.yaml", import.meta.url),
  "utf8",
);
const postgresAsset = fs.readFileSync(
  new URL("../test-fixtures/docker/postgres-init.sh", import.meta.url),
  "utf8",
);

const temporaryDirectories: Array<string> = [];

const temporaryDirectory = (suffix = "server"): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mend ${suffix} `));
  temporaryDirectories.push(root);
  return path.join(root, "config with spaces");
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface RuntimeControl {
  readonly runtime: ServerSetupRuntime;
  readonly commands: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
  readonly fetched: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
  readonly randomSizes: ReadonlyArray<number>;
  readonly daemon: DockerProtocol;
  readonly randomCalls: () => number;
}

const makeRuntime = (
  options: {
    readonly configDir?: string;
    readonly daemon?: DockerProtocol;
    readonly composeAsset?: string;
    readonly platform?: "linux" | "darwin";
    readonly contextList?: string;
    readonly contextListStatus?: number;
    readonly inspectedEndpoint?: string;
    readonly dockerVersion?: string;
    readonly dockerVersionStatus?: number;
    readonly composeVersionStatus?: number;
    readonly composeUpStatus?: number;
    readonly assetFailure?: string;
    readonly healthStatus?: number;
    readonly healthBody?: string;
    readonly operatingSystem?: string;
    readonly imageVersion?: string;
    readonly imageStatus?: number;
  } = {},
): RuntimeControl => {
  const commands: Array<readonly [string, ReadonlyArray<string>]> = [];
  const fetched: Array<string> = [];
  const lines: Array<string> = [];
  const randomSizes: number[] = [];
  const daemon = options.daemon ?? new DockerProtocol();
  const contextList =
    options.contextList ??
    `${JSON.stringify({ Name: "default", DockerEndpoint: "unix:///var/run/docker.sock", Current: true })}\n`;

  const runtime: ServerSetupRuntime = {
    configDir: options.configDir ?? temporaryDirectory(),
    platform: options.platform ?? "linux",
    cliVersion: "0.23.0",
    run: async (command, args, processOptions) => {
      commands.push([command, args]);
      const protocol = daemon.run(command, args, processOptions);
      if (protocol !== undefined) return protocol;
      if (args[0] === "context" && args[1] === "ls") {
        return {
          status: options.contextListStatus ?? 0,
          stdout: options.contextListStatus === 1 ? "" : contextList,
          stderr: options.contextListStatus === 1 ? "docker is not installed" : "",
        };
      }
      if (args[0] === "context" && args[1] === "inspect") {
        return {
          status: 0,
          stdout: `${options.inspectedEndpoint ?? "unix:///var/run/docker.sock"}\n`,
          stderr: "",
        };
      }
      if (
        args.includes("version") &&
        args.includes("{{.Client.APIVersion}} {{.Server.APIVersion}}")
      ) {
        return {
          status: options.dockerVersionStatus ?? 0,
          stdout:
            options.dockerVersionStatus === 1 ? "" : `${options.dockerVersion ?? "1.45 1.47"}\n`,
          stderr: options.dockerVersionStatus === 1 ? "Cannot connect to the Docker daemon" : "",
        };
      }
      if (args.includes("compose") && args.includes("version")) {
        return {
          status: options.composeVersionStatus ?? 0,
          stdout: options.composeVersionStatus === 1 ? "" : "2.35.0\n",
          stderr: options.composeVersionStatus === 1 ? "compose unavailable" : "",
        };
      }
      if (args.includes("compose") && args.includes("config")) {
        const envFile = args[args.indexOf("--env-file") + 1];
        if (envFile === undefined) throw new Error("missing Compose env file");
        const version = readEnv(envFile).get("MEND_VERSION");
        return {
          status: 0,
          stdout: `ghcr.io/sealant-sh/mend:${version}\npostgres:17-alpine\n`,
          stderr: "",
        };
      }
      if (args.includes("image")) {
        const image = args[args.indexOf("inspect") + 1];
        return {
          status: options.imageStatus ?? 0,
          stdout: options.imageVersion ?? image?.split(":").at(-1) ?? "",
          stderr: "",
        };
      }
      if (args.includes("info")) {
        return {
          status: 0,
          stdout: options.operatingSystem ?? "Docker Engine - Community",
          stderr: "",
        };
      }
      if (args.includes("compose") && args.includes("up")) {
        return {
          status: options.composeUpStatus ?? 0,
          stdout: "",
          stderr: options.composeUpStatus === 1 ? "container failed" : "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    },
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith("/api/health")) {
        return {
          status: options.healthStatus ?? 200,
          body: options.healthBody ?? JSON.stringify({ status: "ok", version: "0.23.0" }),
        };
      }
      if (url.endsWith("/compose.v2.yaml")) {
        return options.assetFailure === "compose"
          ? { status: 0, body: "", error: "connection interrupted" }
          : { status: 200, body: options.composeAsset ?? composeAsset };
      }
      if (url.endsWith("/postgres-init.sh")) {
        return options.assetFailure === "postgres"
          ? { status: 0, body: "", error: "connection interrupted" }
          : { status: 200, body: postgresAsset };
      }
      if (url.endsWith("/releases/latest")) {
        return { status: 200, body: JSON.stringify({ tag_name: "v0.24.0" }) };
      }
      return { status: 404, body: "" };
    },
    randomBytes: (size) => {
      randomSizes.push(size);
      return randomBytes(size);
    },
    sleep: async () => undefined,
    writeLine: (line) => lines.push(line),
  };
  return {
    runtime,
    commands,
    fetched,
    lines,
    randomSizes,
    daemon,
    randomCalls: () => randomSizes.length,
  };
};

const readEnv = (file: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const separator = line.indexOf("=");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
};

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;
const activeDirectory = (configDir: string): string =>
  path.join(configDir, fs.readlinkSync(path.join(configDir, "active")));
const activeFile = (configDir: string, name: string): string =>
  path.join(activeDirectory(configDir), name);

describe("mend server setup", () => {
  it("persists the complete generation before claiming daemon data; retries retain identity and use fresh probes", async () => {
    const control = makeRuntime();
    const { configDir } = control.runtime;
    const events: string[] = [];
    let preparedDirectory: string | undefined;
    const runtime: ServerSetupRuntime = {
      ...control.runtime,
      run: async (command, args, options) => {
        if (args.includes("config") && args.includes("--images")) {
          preparedDirectory = args[args.indexOf("--project-directory") + 1];
        }
        const mutation =
          args[3] === "create" || ["import", "push", "pull", "rm"].includes(args[3] ?? "");
        const compose = args.includes("up");
        if (mutation || compose) {
          if (preparedDirectory === undefined) throw new Error("Expected a prepared generation");
          const directory = preparedDirectory;
          if (args[2] === "volume") {
            expect(fs.existsSync(path.join(configDir, "active"))).toBe(false);
          } else {
            expect(activeDirectory(configDir)).toBe(directory);
          }
          const identity = fs.readFileSync(path.join(configDir, "identity.env"));
          expect(fs.readFileSync(path.join(directory, "identity.env"))).toEqual(identity);
          expect(fs.readdirSync(directory).toSorted()).toEqual([
            "compose.yaml",
            "identity.env",
            "postgres-init.sh",
            "server.env",
            "server.json",
          ]);
          if (compose || args[2] === "image") {
            const owner = createHash("sha256").update(identity).digest("hex");
            expect(control.daemon.volumes.get("mend-store")).toEqual({
              [SERVER_VOLUME_OWNER_LABEL]: owner,
            });
            expect(control.daemon.volumes.get("mend-control")).toEqual({
              [SERVER_VOLUME_OWNER_LABEL]: owner,
            });
          }
          events.push(compose ? "compose" : (args[3] ?? ""));
        }
        return control.runtime.run(command, args, options);
      },
      fetchText: async (url, timeout) => {
        if (url.endsWith("/api/health")) events.push("health");
        return control.runtime.fetchText(url, timeout);
      },
    };
    expect(await serverCommand(["setup"], runtime)).toEqual({ _tag: "ok" });
    const identity = fs.readFileSync(path.join(configDir, "identity.env"));
    const generation = activeDirectory(configDir);
    const env = fs.readFileSync(path.join(generation, "server.env"));
    expect(events).toEqual(["create", "create", "compose", "health"]);
    events.length = 0;
    expect(await serverCommand(["setup"], runtime)).toEqual({ _tag: "ok" });
    expect(events).toEqual(["compose", "health"]);
    expect(fs.readFileSync(path.join(configDir, "identity.env"))).toEqual(identity);
    expect(fs.readFileSync(path.join(generation, "server.env"))).toEqual(env);
    expect(activeDirectory(configDir)).toBe(generation);
    // Credentials are generated exactly once; nothing else draws randomness (no registry probe).
    expect(control.randomSizes).toEqual([256]);
    expect(control.daemon.remote.size).toBe(0);
    expect(control.daemon.local.size).toBe(0);
    expect(control.daemon.archives).toEqual([]);
  });

  it("setup completes beside mend-dev and leaves its resources unchanged", async () => {
    const daemon = new DockerProtocol();
    const labels = { "com.docker.compose.project": "mend-dev" };
    daemon.containers.set("mend-dev-postgres-1", labels);
    daemon.networks.set("mend-dev_default", labels);
    daemon.volumes.set("mend-dev_postgres", labels);
    const containers = [...daemon.containers];
    const networks = [...daemon.networks];
    const control = makeRuntime({ daemon });
    expect(await serverCommand(["setup"], control.runtime)).toEqual({ _tag: "ok" });
    expect([...daemon.containers]).toEqual(containers);
    expect([...daemon.networks]).toEqual(networks);
    expect(daemon.volumes.get("mend-dev_postgres")).toEqual(labels);
    const identity = fs.readFileSync(path.join(control.runtime.configDir, "identity.env"));
    const owner = createHash("sha256").update(identity).digest("hex");
    expect(daemon.volumes.get("mend-store")).toEqual({ [SERVER_VOLUME_OWNER_LABEL]: owner });
    expect(daemon.volumes.get("mend-control")).toEqual({ [SERVER_VOLUME_OWNER_LABEL]: owner });
    expect(
      control.commands.some(([, args]) => args.includes("compose") && args.includes("up")),
    ).toBe(true);
    expect(
      control.commands.some(
        ([, args]) => args.includes("down") || args.includes("--remove-orphans"),
      ),
    ).toBe(false);
  });

  it.each(["unlabelled", "mismatched", "reserved", "inspection-failure"])(
    "setup refuses %s container evidence before Compose or allocation",
    async (scenario) => {
      const daemon = new DockerProtocol();
      const name = scenario === "reserved" ? "mend-postgres-1" : "mend-dev-postgres-1";
      const project =
        scenario === "reserved"
          ? "mend-postgres"
          : scenario === "mismatched"
            ? "other"
            : "mend-dev";
      daemon.containers.set(
        name,
        scenario === "unlabelled" ? null : { "com.docker.compose.project": project },
      );
      if (scenario === "inspection-failure")
        daemon.response = (args) =>
          args[2] === "container" && args[3] === "inspect"
            ? { status: 1, stdout: "", stderr: "permission denied" }
            : undefined;
      const before = [...daemon.containers];
      const control = makeRuntime({ daemon });
      expect(await serverCommand(["setup"], control.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("Docker volume ownership check failed"),
      });
      expect([...daemon.containers]).toEqual(before);
      expect(daemon.volumes.size).toBe(0);
      expect(
        control.commands.some(
          ([, args]) => args.includes("up") || args.includes("create") || args[2] === "image",
        ),
      ).toBe(false);
    },
  );

  it("a different configDir identity cannot operate an existing daemon's data", async () => {
    const daemon = new DockerProtocol();
    const first = makeRuntime({ daemon });
    expect(await serverCommand(["setup"], first.runtime)).toEqual({ _tag: "ok" });
    const identity = fs.readFileSync(path.join(first.runtime.configDir, "identity.env"));
    const volumes = [...daemon.volumes];
    const manifests = [...daemon.remote];
    const second = makeRuntime({ daemon });
    const result = await serverCommand(["setup"], second.runtime);
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Restore the original Mend identity/configuration"),
    });
    expect(fs.readFileSync(path.join(second.runtime.configDir, "identity.env"))).not.toEqual(
      identity,
    );
    expect(fs.readFileSync(path.join(first.runtime.configDir, "identity.env"))).toEqual(identity);
    expect([...daemon.volumes]).toEqual(volumes);
    expect([...daemon.remote]).toEqual(manifests);
    expect(
      second.commands.some(
        ([, args]) => args.includes("up") || args.includes("create") || args[2] === "image",
      ),
    ).toBe(false);
    expect(second.randomSizes).toEqual([256]);
    expect(
      second.lines.some(
        (line) =>
          line.startsWith("Pulling") ||
          line.startsWith("Starting") ||
          line.includes("is reachable"),
      ),
    ).toBe(false);
    expect(await serverCommand(["setup"], first.runtime)).toEqual({ _tag: "ok" });
  });

  it("matches the packaging ownership contract", () => {
    const contract: unknown = JSON.parse(
      fs.readFileSync(
        new URL("../test-fixtures/docker/setup-contract.v2.json", import.meta.url),
        "utf8",
      ),
    );
    expect(contract).toMatchObject({
      canonicalVolumes: { store: "mend-store", control: "mend-control" },
      volumeOwnership: {
        anchor: "mend-store",
        label: SERVER_VOLUME_OWNER_LABEL,
        identity: "SHA-256 of the persisted identity.env bytes",
        externalVolumes: ["mend-store", "mend-control"],
      },
    });
  });

  it.each(["missing-identity", "corrupt-identity", "corrupt-env", "corrupt-compose"])(
    "refuses %s without replacing credentials or touching daemon data",
    async (damage) => {
      const first = makeRuntime();
      expect(await serverCommand(["setup"], first.runtime)).toEqual({ _tag: "ok" });
      const { configDir } = first.runtime;
      const identityFile = path.join(configDir, "identity.env");
      const identity = fs.readFileSync(identityFile);
      const generation = activeDirectory(configDir);
      const envFile = path.join(generation, "server.env");
      if (damage === "missing-identity") fs.unlinkSync(identityFile);
      if (damage === "corrupt-identity") fs.writeFileSync(identityFile, "truncated\n");
      if (damage === "corrupt-env") fs.writeFileSync(envFile, "truncated\n");
      if (damage === "corrupt-compose")
        fs.writeFileSync(
          path.join(generation, "compose.yaml"),
          composeAsset.replace("external: true", "external: false"),
        );
      const before = [...first.daemon.volumes];
      const retry = makeRuntime({ configDir, daemon: first.daemon });
      expect((await serverCommand(["setup"], retry.runtime))._tag).toBe("error");
      expect(retry.randomSizes).toEqual([]);
      expect(retry.commands).toEqual([]);
      expect([...first.daemon.volumes]).toEqual(before);
      expect(fs.readFileSync(path.join(generation, "identity.env"))).toEqual(identity);
      if (damage === "missing-identity") expect(fs.existsSync(identityFile)).toBe(false);
      else
        expect(fs.readFileSync(identityFile)).toEqual(
          damage === "corrupt-identity" ? Buffer.from("truncated\n") : identity,
        );
      if (damage === "corrupt-env") expect(fs.readFileSync(envFile, "utf8")).toBe("truncated\n");
    },
  );

  it("retains the committed identity after a failed volume claim and retries without regeneration", async () => {
    const control = makeRuntime();
    control.daemon.response = (args) =>
      args[3] === "inspect" ? { status: 1, stdout: "", stderr: "permission denied" } : undefined;
    expect(await serverCommand(["setup"], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Docker volume ownership check failed"),
    });
    expect([...control.daemon.volumes.keys()]).toEqual(["mend-store"]);
    expect(control.commands.some(([, args]) => args.includes("up") || args[2] === "image")).toBe(
      false,
    );
    const identity = fs.readFileSync(path.join(control.runtime.configDir, "identity.env"));
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    const prepared = fs.readdirSync(path.join(control.runtime.configDir, "generations"));
    expect(prepared).toHaveLength(1);
    const preparedName = prepared[0];
    if (preparedName === undefined) throw new Error("Expected a retained prepared generation");
    const generation = path.join(control.runtime.configDir, "generations", preparedName);
    control.daemon.response = () => undefined;
    expect(await serverCommand(["setup"], control.runtime)).toEqual({ _tag: "ok" });
    expect(control.randomSizes).toEqual([256]);
    expect(fs.readFileSync(path.join(control.runtime.configDir, "identity.env"))).toEqual(identity);
    expect(activeDirectory(control.runtime.configDir)).not.toBe(generation);
    expect(fs.readFileSync(path.join(generation, "identity.env"))).toEqual(identity);
  });

  it("checks the same external volume contract on locally supplied assets", async () => {
    const assets = temporaryDirectory("invalid-assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(
      path.join(assets, "compose.v2.yaml"),
      composeAsset.replace("external: true", "external: false"),
    );
    fs.writeFileSync(path.join(assets, "postgres-init.sh"), postgresAsset);
    const control = makeRuntime();
    expect(
      await serverCommand(
        ["setup", "--version", "0.23.0", "--assets-dir", assets],
        control.runtime,
      ),
    ).toMatchObject({ _tag: "error", message: expect.stringContaining("external: true") });
    expect(control.daemon.calls).toEqual([]);
    expect(control.randomSizes).toEqual([]);
    expect(control.fetched).toEqual([]);
  });

  it("copies offline assets and no longer needs the source", async () => {
    const control = makeRuntime();
    const assets = temporaryDirectory("assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "compose.v2.yaml"), composeAsset);
    fs.writeFileSync(path.join(assets, "postgres-init.sh"), postgresAsset);
    expect(
      await serverCommand(
        ["setup", "--assets-dir", assets, "--offline", "--version", "0.23.0"],
        control.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const generation = activeDirectory(control.runtime.configDir);
    fs.rmSync(assets, { recursive: true });
    expect(await serverCommand(["setup", "--offline"], control.runtime)).toEqual({ _tag: "ok" });
    expect(activeDirectory(control.runtime.configDir)).toBe(generation);
    expect(
      readEnv(activeFile(control.runtime.configDir, "server.env")).has("MEND_REGISTRY_PORT"),
    ).toBe(false);
    expect(control.fetched.every((url) => url.endsWith("/api/health"))).toBe(true);
    for (const [, args] of control.commands.filter(([, commandArgs]) =>
      commandArgs.includes("up"),
    )) {
      expect(args.slice(-3)).toEqual(["--pull", "never", "--no-build"]);
    }
    // Offline never pulls anything.
    expect(control.commands.filter(([, args]) => args.includes("pull"))).toHaveLength(0);
  });

  it.each([
    ["--offline", "--version", "latest"],
    ["--assets-dir", "/missing"],
    ["--offline", "--version", "0.23.0"],
    ["--registry-port", "5000"],
    ["--port", "2222"],
    ["--ssh-port", "3105"],
  ])("rejects invalid/offline inputs before activation: %j", async (...flags) => {
    const control = makeRuntime();
    expect((await serverCommand(["setup", ...flags], control.runtime))._tag).toBe("error");
    expect(control.fetched).toEqual([]);
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
  });

  it.each([
    { imageVersion: "0.24.0" },
    { imageStatus: 1 },
    { healthBody: '{"status":"ok","version":"0.24.0"}' },
  ])("refuses offline image/readiness mismatches: %j", async (options) => {
    const control = makeRuntime(options);
    const result = await serverCommand(
      [
        "setup",
        "--version",
        "0.23.0",
        "--offline",
        "--assets-dir",
        path.resolve(import.meta.dirname, "../test-fixtures/docker"),
      ],
      control.runtime,
    );
    expect(result._tag).toBe("error");
    expect(control.fetched.every((url) => url.endsWith("/api/health"))).toBe(true);
    expect(control.lines.some((line) => line.includes("is reachable"))).toBe(false);
  });

  it("reports the health wait while it lasts, then fails with the last observation", async () => {
    const control = makeRuntime({ healthStatus: 503, healthBody: "" });
    expect(await serverCommand(["setup"], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("HTTP 503"),
    });
    expect(control.lines.filter((line) => line.startsWith("Waiting for"))).toEqual(
      Array.from({ length: 3 }, () => "Waiting for http://localhost:3105/api/health (HTTP 503)"),
    );
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
  });

  it.each([
    "{}",
    "<html>OK</html>",
    "{",
    "null",
    '{"status":"ok","version":"0.99.0"}',
    '{"status":"failed","version":"0.23.0"}',
  ])("rejects false health success: %s", async (healthBody) => {
    const control = makeRuntime({ healthBody });
    expect(await serverCommand(["setup"], control.runtime)).toMatchObject({ _tag: "error" });
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
  });

  it("uses the daemon-side socket on Linux Docker Desktop, including renamed contexts", async () => {
    const control = makeRuntime({
      operatingSystem: "Docker Desktop",
      inspectedEndpoint: "unix:///home/alice/.docker/desktop/docker.sock",
    });
    expect(await serverCommand(["setup", "--context", "my-desktop"], control.runtime)).toEqual({
      _tag: "ok",
    });
    expect(
      readEnv(activeFile(control.runtime.configDir, "server.env")).get("DOCKER_SOCKET_PATH"),
    ).toBe("/var/run/docker.sock");
  });
  it("creates a pinned localhost installation and starts compose through the selected context", async () => {
    const control = makeRuntime();

    const result = await serverCommand(["setup"], control.runtime);

    expect(result).toEqual({ _tag: "ok" });
    expect(control.randomSizes).toEqual([256]);
    expect(modeOf(control.runtime.configDir)).toBe(0o700);
    expect(modeOf(activeDirectory(control.runtime.configDir))).toBe(0o700);
    expect(modeOf(activeFile(control.runtime.configDir, "server.json"))).toBe(0o600);
    expect(modeOf(activeFile(control.runtime.configDir, "server.env"))).toBe(0o600);
    expect(modeOf(activeFile(control.runtime.configDir, "postgres-init.sh"))).toBe(0o755);
    expect(
      JSON.parse(fs.readFileSync(activeFile(control.runtime.configDir, "server.json"), "utf8")),
    ).toMatchObject({
      serverVersion: "0.23.0",
      dockerContext: "default",
      dockerSocket: "/var/run/docker.sock",
      bind: "127.0.0.1",
      appUrl: "http://localhost:3105",
      allowedOrigins: [],
      appPort: 3105,
      sshPort: 2222,
    });
    const env = readEnv(activeFile(control.runtime.configDir, "server.env"));
    expect(env.get("MEND_IMAGE_REPOSITORY")).toBe("ghcr.io/sealant-sh/mend");
    expect(env.get("MEND_VERSION")).toBe("0.23.0");
    expect(env.get("MEND_STORE_VOLUME_NAME")).toBe("mend-store");
    expect(env.get("DOCKER_SOCKET_PATH")).toBe("/var/run/docker.sock");
    expect(env.get("MEND_ALLOWED_ORIGINS")).toBe("[]");
    expect([...env.keys()].toSorted()).toEqual(
      [
        "APP_URL",
        "BETTER_AUTH_SECRET",
        "DOCKER_SOCKET_PATH",
        "MEND_ALLOWED_ORIGINS",
        "MEND_BIND_HOST",
        "MEND_CONTROL_VOLUME_NAME",
        "MEND_DB_PASSWORD",
        "MEND_IMAGE_REPOSITORY",
        "MEND_PORT",
        "MEND_POSTGRES_ADMIN_PASSWORD",
        "MEND_SSH_PORT",
        "MEND_STORE_VOLUME_NAME",
        "MEND_VERSION",
        "SEALANT_CREDENTIALS_KEY",
        "SEALANT_DB_PASSWORD",
        "SEALANT_SERVICE_KEY",
        "SEALANT_SSH_HOST",
        "WORKSPACE_SSH_GATEWAY_TOKEN",
      ].toSorted(),
    );
    expect(
      fs.readFileSync(activeFile(control.runtime.configDir, "compose.yaml"), "utf8"),
    ).toContain("mend-postgres");
    // Each slow phase announces itself before it starts, so a long pull or wait never looks like a hang.
    expect(control.lines).toEqual([
      'Using Docker context "default" (unix:///var/run/docker.sock)',
      "Downloading release assets for Mend 0.23.0",
      "Starting Mend 0.23.0 containers; Docker waits up to 120s for them to report healthy",
      "Mend 0.23.0 is reachable at http://localhost:3105",
      "Open http://localhost:3105, create the first account, then run: mend login --url http://localhost:3105",
    ]);

    const up = control.commands.find(([, args]) => args.includes("up"));
    expect(up?.[1]).toEqual([
      "--context",
      "default",
      "compose",
      "--project-name",
      "mend",
      "--project-directory",
      activeDirectory(control.runtime.configDir),
      "--env-file",
      activeFile(control.runtime.configDir, "server.env"),
      "-f",
      activeFile(control.runtime.configDir, "compose.yaml"),
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "--pull",
      "never",
      "--no-build",
    ]);
    expect(up?.[1]).not.toContain("down");
    expect(control.commands.some(([, args]) => args[0] === "context" && args[1] === "use")).toBe(
      false,
    );
  });

  it("preserves the server pin, context, ports, assets, and secrets on a rerun", async () => {
    const configDir = temporaryDirectory("rerun");
    const first = makeRuntime({ configDir });
    expect(
      await serverCommand(["setup", "--port", "4111", "--ssh-port", "2333"], first.runtime),
    ).toEqual({
      _tag: "ok",
    });
    const generationBefore = activeDirectory(configDir);
    const envBefore = fs.readFileSync(activeFile(configDir, "server.env"), "utf8");
    const identityBefore = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");

    const second = makeRuntime({
      configDir,
      daemon: first.daemon,
      contextList: `${JSON.stringify({ Name: "other", DockerEndpoint: "unix:///tmp/other.sock", Current: true })}\n`,
      inspectedEndpoint: "unix:///var/run/docker.sock",
    });
    expect(await serverCommand(["setup"], second.runtime)).toEqual({ _tag: "ok" });

    expect(second.randomSizes).toEqual([]);
    expect(second.fetched.filter((url) => !url.endsWith("/api/health"))).toEqual([]);
    expect(activeDirectory(configDir)).toBe(generationBefore);
    expect(fs.readdirSync(path.join(configDir, "generations"))).toHaveLength(1);
    expect(fs.readFileSync(activeFile(configDir, "server.env"), "utf8")).toBe(envBefore);
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identityBefore);
    expect(JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"))).toMatchObject(
      {
        serverVersion: "0.23.0",
        dockerContext: "default",
        appUrl: "http://localhost:4111",
        appPort: 4111,
        sshPort: 2333,
      },
    );
    expect(second.commands[0]?.[1]).toContain("inspect");
    expect(
      second.commands.some(([, args]) => args.includes("context") && args.includes("ls")),
    ).toBe(false);
  });

  it("directs changed setup pins to upgrade without changing the installation", async () => {
    const configDir = temporaryDirectory("upgrade");
    const first = makeRuntime({ configDir });
    expect(await serverCommand(["setup"], first.runtime)).toEqual({ _tag: "ok" });
    const secrets = readEnv(activeFile(configDir, "server.env"));
    const previous = activeDirectory(configDir);

    const identity = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");
    const upgraded = makeRuntime({
      configDir,
      daemon: first.daemon,
      healthBody: '{"status":"ok","version":"0.24.0"}',
    });
    expect(await serverCommand(["setup", "--version", "latest"], upgraded.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("mend server upgrade --version latest"),
    });
    const next = readEnv(activeFile(configDir, "server.env"));
    expect(activeDirectory(configDir)).toBe(previous);
    expect(readEnv(path.join(previous, "server.env"))).toEqual(secrets);

    expect(next.get("MEND_VERSION")).toBe("0.23.0");
    expect(next.get("MEND_IMAGE_REPOSITORY")).toBe("ghcr.io/sealant-sh/mend");
    expect(next.get("SEALANT_SERVICE_KEY")).toBe(secrets.get("SEALANT_SERVICE_KEY"));
    expect(next.get("SEALANT_DB_PASSWORD")).toBe(secrets.get("SEALANT_DB_PASSWORD"));
    expect(upgraded.randomSizes).toEqual([]);
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identity);
    expect(upgraded.fetched).toEqual([]);
    expect(upgraded.commands).toEqual([]);
    expect([...next.keys()].some((key) => key.includes("SEALANT_VERSION"))).toBe(false);
  });

  it("requires explicit, matching non-local bind and URL settings", async () => {
    const missingUrl = makeRuntime();
    const missingResult = await serverCommand(["setup", "--bind", "0.0.0.0"], missingUrl.runtime);
    expect(missingResult).toMatchObject({ _tag: "error" });
    if (missingResult._tag === "error") expect(missingResult.message).toContain("explicit --url");
    expect(fs.existsSync(path.join(missingUrl.runtime.configDir, "active"))).toBe(false);

    const mismatched = makeRuntime();
    const mismatchResult = await serverCommand(
      ["setup", "--bind", "0.0.0.0", "--url", "http://localhost:3105"],
      mismatched.runtime,
    );
    expect(mismatchResult).toMatchObject({ _tag: "error" });
    if (mismatchResult._tag === "error")
      expect(mismatchResult.message).toContain("must both describe");

    const exposed = makeRuntime();
    expect(
      await serverCommand(
        [
          "setup",
          "--bind",
          "0.0.0.0",
          "--url",
          "http://100.70.80.90:3105",
          "--origin",
          "https://mend.example.test",
        ],
        exposed.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const env = readEnv(activeFile(exposed.runtime.configDir, "server.env"));
    expect(env.get("MEND_ALLOWED_ORIGINS")).toBe('["https://mend.example.test"]');
  });

  it("rejects invalid origins and corrupt or truncated persisted state", async () => {
    const invalid = makeRuntime();
    const invalidResult = await serverCommand(
      ["setup", "--origin", "https://example.test/path"],
      invalid.runtime,
    );
    expect(invalidResult).toMatchObject({ _tag: "error" });
    if (invalidResult._tag === "error")
      expect(invalidResult.message).toContain("no credentials, path");
    expect(fs.existsSync(path.join(invalid.runtime.configDir, "active"))).toBe(false);

    const configDir = temporaryDirectory("corrupt");
    expect(await serverCommand(["setup"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    fs.writeFileSync(activeFile(configDir, "server.json"), '{"schemaVersion":');
    const corrupt = makeRuntime({ configDir });
    const corruptResult = await serverCommand(["setup"], corrupt.runtime);
    expect(corruptResult).toMatchObject({ _tag: "error" });
    if (corruptResult._tag === "error") expect(corruptResult.message).toContain("not valid JSON");
    expect(corrupt.commands).toEqual([]);
  });

  it("rejects truncated secrets instead of replacing them", async () => {
    const configDir = temporaryDirectory("truncated-secrets");
    const first = makeRuntime({ configDir });
    expect(await serverCommand(["setup"], first.runtime)).toEqual({ _tag: "ok" });
    const envFile = activeFile(configDir, "server.env");
    fs.writeFileSync(
      envFile,
      fs
        .readFileSync(envFile, "utf8")
        .replace(/SEALANT_SERVICE_KEY=.*/, "SEALANT_SERVICE_KEY=short"),
    );

    const rerun = makeRuntime({ configDir });
    const result = await serverCommand(["setup"], rerun.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error")
      expect(result.message).toContain("SEALANT_SERVICE_KEY has an invalid value");
    expect(rerun.randomCalls()).toBe(0);
    expect(rerun.commands).toEqual([]);
  });

  it("selects OrbStack when no context is current and uses the daemon-side macOS socket", async () => {
    const contexts = [
      { Name: "remote", DockerEndpoint: "ssh://builder", Current: true },
      {
        Name: "desktop-linux",
        DockerEndpoint: "unix:///Users/alice/.docker/run/docker.sock",
        Current: false,
      },
      {
        Name: "orbstack",
        DockerEndpoint: "unix:///Users/alice/.orbstack/run/docker.sock",
        Current: false,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    const control = makeRuntime({ platform: "darwin", contextList: `${contexts}\n` });

    expect(await serverCommand(["setup"], control.runtime)).toEqual({ _tag: "ok" });

    expect(
      JSON.parse(fs.readFileSync(activeFile(control.runtime.configDir, "server.json"), "utf8")),
    ).toMatchObject({
      dockerContext: "orbstack",
      dockerEndpoint: "unix:///Users/alice/.orbstack/run/docker.sock",
      dockerSocket: "/var/run/docker.sock",
    });
    expect(
      control.commands
        .filter(([, args]) => args[0] === "--context")
        .every(([, args]) => args[1] === "orbstack"),
    ).toBe(true);
  });

  it("uses the daemon-side socket for an explicit Docker Desktop context on macOS", async () => {
    const control = makeRuntime({
      platform: "darwin",
      inspectedEndpoint:
        "unix:///Users/alice/Library/Containers/com.docker.docker/Data/docker-cli.sock",
    });

    expect(await serverCommand(["setup", "--context", "desktop-linux"], control.runtime)).toEqual({
      _tag: "ok",
    });

    const env = readEnv(activeFile(control.runtime.configDir, "server.env"));
    expect(env.get("DOCKER_SOCKET_PATH")).toBe("/var/run/docker.sock");
    expect(
      control.commands
        .filter(([, args]) => args[0] === "--context")
        .every(([, args]) => args[1] === "desktop-linux"),
    ).toBe(true);
  });

  it("persists an explicit local socket override", async () => {
    const control = makeRuntime();
    const socket = "/custom docker/socket with spaces.sock";

    expect(
      await serverCommand(
        ["setup", "--context", "default", "--docker-socket", socket],
        control.runtime,
      ),
    ).toEqual({ _tag: "ok" });

    const env = readEnv(activeFile(control.runtime.configDir, "server.env"));
    expect(env.get("DOCKER_SOCKET_PATH")).toBe(socket);
  });

  it("rejects a requested remote daemon before writing state", async () => {
    const control = makeRuntime({ inspectedEndpoint: "ssh://docker@example.test" });

    const result = await serverCommand(["setup", "--context", "remote"], control.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error") expect(result.message).toContain("remote SSH/TCP daemons");
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    expect(control.commands).toHaveLength(1);
  });

  it("fails Docker availability and capability checks before generating secrets or files", async () => {
    const missing = makeRuntime({ contextListStatus: 1 });
    const missingResult = await serverCommand(["setup"], missing.runtime);
    expect(missingResult).toMatchObject({ _tag: "error" });
    if (missingResult._tag === "error")
      expect(missingResult.message).toContain("docker is not installed");
    expect(fs.existsSync(path.join(missing.runtime.configDir, "active"))).toBe(false);

    const stopped = makeRuntime({ dockerVersionStatus: 1 });
    const stoppedResult = await serverCommand(["setup"], stopped.runtime);
    expect(stoppedResult).toMatchObject({ _tag: "error" });
    if (stoppedResult._tag === "error")
      expect(stoppedResult.message).toContain("Cannot connect to the Docker daemon");
    expect(fs.existsSync(path.join(stopped.runtime.configDir, "active"))).toBe(false);

    const oldApi = makeRuntime({ dockerVersion: "1.44 1.44" });
    const oldResult = await serverCommand(["setup"], oldApi.runtime);
    expect(oldResult).toMatchObject({ _tag: "error" });
    if (oldResult._tag === "error") expect(oldResult.message).toContain("Docker API >= 1.45");
    expect(oldApi.randomCalls()).toBe(0);
    expect(fs.existsSync(path.join(oldApi.runtime.configDir, "active"))).toBe(false);

    const noCompose = makeRuntime({ composeVersionStatus: 1 });
    const composeResult = await serverCommand(["setup"], noCompose.runtime);
    expect(composeResult).toMatchObject({ _tag: "error" });
    if (composeResult._tag === "error")
      expect(composeResult.message).toContain("Compose v2 plugin");
    expect(noCompose.randomCalls()).toBe(0);
    expect(fs.existsSync(path.join(noCompose.runtime.configDir, "active"))).toBe(false);
  });

  it("leaves no state when release download is interrupted", async () => {
    const control = makeRuntime({ assetFailure: "postgres" });

    const result = await serverCommand(["setup"], control.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error") expect(result.message).toContain("connection interrupted");
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    expect(control.randomCalls()).toBe(0);
    expect(fs.existsSync(path.join(control.runtime.configDir, "server.lock"))).toBe(false);
    expect(control.commands.some(([, args]) => args.includes("up"))).toBe(false);
  });

  it.each([false, true])(
    "retains an unactivated identity after image rejection, offline=%s",
    async (offline) => {
      const configDir = temporaryDirectory("image-rejection");
      const first = makeRuntime({ configDir, imageVersion: "0.22.0" });
      const flags = [
        "setup",
        "--version",
        "0.23.0",
        "--assets-dir",
        path.resolve(import.meta.dirname, "../test-fixtures/docker"),
        ...(offline ? ["--offline"] : []),
      ];
      expect(await serverCommand(flags, first.runtime)).toMatchObject({ _tag: "error" });
      const identity = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");
      expect(first.randomCalls()).toBe(1);
      expect(fs.existsSync(path.join(configDir, "active"))).toBe(false);
      expect(fs.readdirSync(path.join(configDir, "generations"))).toHaveLength(1);
      expect(first.commands.some(([, args]) => args.includes("up") || args.includes("pull"))).toBe(
        false,
      );
      const second = makeRuntime({ configDir, daemon: first.daemon });
      expect(await serverCommand(flags, second.runtime)).toEqual({ _tag: "ok" });
      expect(second.randomSizes).toEqual([]);
      expect(fs.readFileSync(activeFile(configDir, "identity.env"), "utf8")).toBe(identity);
    },
  );

  it("reuses the first identity after a filesystem failure before activating a generation", async () => {
    const configDir = temporaryDirectory("first-write-failure");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(configDir, "generations"), { mode: 0o500 });
    const first = makeRuntime({ configDir });
    const result = await serverCommand(["setup"], first.runtime);
    expect(result._tag).toBe("error");
    expect(first.randomCalls()).toBe(1);
    const identity = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");
    expect(fs.existsSync(path.join(configDir, "active"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "server.lock"))).toBe(false);
    expect(first.commands.some(([, args]) => args.includes("up"))).toBe(false);
    fs.chmodSync(path.join(configDir, "generations"), 0o700);
    const second = makeRuntime({ configDir });
    expect(await serverCommand(["setup"], second.runtime)).toEqual({ _tag: "ok" });
    expect(second.randomSizes).toEqual([]);
    expect(fs.readFileSync(activeFile(configDir, "identity.env"), "utf8")).toBe(identity);
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identity);
  });

  it("refuses an unrecognised flat installation instead of generating another identity", async () => {
    const control = makeRuntime();
    fs.mkdirSync(control.runtime.configDir, { recursive: true });
    const original = "existing unreleased credentials\n";
    fs.writeFileSync(path.join(control.runtime.configDir, "server.env"), original);
    const result = await serverCommand(["setup"], control.runtime);
    expect(result._tag).toBe("error");
    expect(control.randomCalls()).toBe(0);
    expect(control.commands).toEqual([]);
    expect(fs.readFileSync(path.join(control.runtime.configDir, "server.env"), "utf8")).toBe(
      original,
    );
  });

  it("redetects daemon sockets but retains explicit overrides on reruns", async () => {
    const configDir = temporaryDirectory("socket-rerun");
    const first = makeRuntime({
      configDir,
      inspectedEndpoint: "unix:///run/user/1000/docker.sock",
    });
    expect(await serverCommand(["setup", "--context", "local"], first.runtime)).toEqual({
      _tag: "ok",
    });
    expect(readEnv(activeFile(configDir, "server.env")).get("DOCKER_SOCKET_PATH")).toBe(
      "/run/user/1000/docker.sock",
    );
    const identity = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");
    const desktop = makeRuntime({
      configDir,
      operatingSystem: "Docker Desktop",
      inspectedEndpoint: "unix:///home/alice/.docker/desktop/docker.sock",
    });
    expect(await serverCommand(["setup"], desktop.runtime)).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).get("DOCKER_SOCKET_PATH")).toBe(
      "/var/run/docker.sock",
    );
    expect(
      await serverCommand(["setup", "--docker-socket", "/custom/socket"], desktop.runtime),
    ).toEqual({ _tag: "ok" });
    expect(await serverCommand(["setup"], desktop.runtime)).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).get("DOCKER_SOCKET_PATH")).toBe(
      "/custom/socket",
    );
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identity);
  });

  it("does not report the advertised URL reachable when every health request fails", async () => {
    const control = makeRuntime({ healthStatus: 503 });

    const result = await serverCommand(["setup"], control.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error")
      expect(result.message).toContain("did not answer successfully (HTTP 503)");
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
    expect(control.fetched.filter((url) => url.endsWith("/api/health"))).toHaveLength(30);
    expect(control.daemon.calls.some(({ args }) => args[2] === "image")).toBe(false);
    expect(control.randomSizes).toEqual([256]);
  });
});
