import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DockerProtocol } from "../test-fixtures/docker-protocol.ts";
import { parseDockerInfo } from "./docker-shutdown.ts";
import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import {
  instanceIdOf,
  nodeServerRuntime,
  reachableAddressesOf,
  serverCommand,
  sshBannerAt,
  type ServerSetupRuntime,
} from "./server-setup.ts";

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
  /** Every `garage …` subcommand the init ran through `docker compose exec`, in order. */
  readonly garageCalls: ReadonlyArray<ReadonlyArray<string>>;
  readonly randomCalls: () => number;
}

/** A TCP listener on loopback that does `onConnection` with each connection. */
const listen = (onConnection: (socket: net.Socket) => void) =>
  new Promise<{ readonly port: number; readonly close: () => Promise<void> }>((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      onConnection(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });

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
    /** The image's t3code gateway label: absent, an image from before the gateway. */
    readonly gatewayLabel?: string;
    /** Whether the gateway answers on its loopback port once started. */
    readonly gatewayAnswers?: boolean;
    /** What the host-kernel probe container prints; absent: the probe fails, as on no image. */
    readonly hostKernel?: string;
    /** The image's cloud metadata guard label: absent, an image from before the guard. */
    readonly guardLabel?: string;
    /** Images `image inspect` does not find until a `pull` brings them. */
    readonly missingImages?: ReadonlyArray<string>;
    /** Whether a `pull` of a missing image fails. */
    readonly pullFails?: boolean;
    /** What the probe prints once the privileged helper ran; absent: what it printed before. */
    readonly hostKernelAllowed?: string;
    /** The privileged helper's exit status; absent: 0. */
    readonly allowStatus?: number;
    /** `docker info`'s SecurityOptions as JSON; absent: none. */
    readonly securityOptions?: string;
    /** What `GET /api/instance` answers; absent: 404, as a server that does not say. */
    readonly instanceBody?: string;
    /** Origins whose health does not answer from this machine. */
    readonly unreachable?: ReadonlyArray<string>;
    /** Health bodies by origin, where another server answers; elsewhere `healthBody`. */
    readonly healthAt?: Readonly<Record<string, string>>;
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

  const garageCalls: ReadonlyArray<string>[] = [];
  const missing = new Set(options.missingImages ?? []);
  let allowed = false;
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
        const composeFile = args[args.indexOf("-f") + 1];
        const withGarage =
          composeFile !== undefined && fs.readFileSync(composeFile, "utf8").includes("\n  garage:");
        // The edge overlay, when the generation has one, brings Caddy's image into the project.
        const withEdge = args.some((arg) => arg.endsWith("/compose.edge.yaml"));
        // So does the mirrors overlay, with each mirror's image.
        const mirrorsFile = args.find((arg) => arg.endsWith("/compose.mirrors.yaml"));
        const mirrorImages =
          mirrorsFile === undefined
            ? []
            : [...fs.readFileSync(mirrorsFile, "utf8").matchAll(/^ {4}image: (\S+)$/gm)].map(
                (match) => `${match[1]}\n`,
              );
        return {
          status: 0,
          stdout: `ghcr.io/sealant-sh/mend:${version}\npostgres:17-alpine\n${withGarage ? "dxflrs/garage:v2.4.1\n" : ""}${withEdge ? "caddy:2.10-alpine\n" : ""}${mirrorImages.join("")}`,
          stderr: "",
        };
      }
      if (args.includes("compose") && args.includes("exec") && args.includes("garage")) {
        // The Garage init: `status` names the node; `bucket info` shows the imported key.
        const envFile = args[args.indexOf("--env-file") + 1];
        const keyId =
          envFile === undefined ? "" : (readEnv(envFile).get("MEND_GARAGE_KEY_ID") ?? "");
        const sub = args.slice(args.indexOf("/etc/garage.toml") + 1);
        garageCalls.push(sub);
        if (sub[0] === "status")
          return {
            status: 0,
            stdout: "==== HEALTHY NODES ====\n0123456789abcdef  garage  127.0.0.1:3901\n",
            stderr: "",
          };
        if (sub[0] === "bucket" && sub[1] === "info")
          return {
            status: 0,
            stdout: `==== BUCKET INFORMATION ====\nRWO ${keyId} mend\n`,
            stderr: "",
          };
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("image") && args.some((arg) => arg.includes("network-guard-image"))) {
        return { status: options.imageStatus ?? 0, stdout: options.guardLabel ?? "", stderr: "" };
      }
      if (args.includes("pull") && missing.has(args.at(-1) ?? "")) {
        if (options.pullFails === true)
          return { status: 1, stdout: "", stderr: "pull access denied" };
        missing.delete(args.at(-1) ?? "");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("image") && missing.has(args[args.indexOf("inspect") + 1] ?? "")) {
        return { status: 1, stdout: "", stderr: "No such image" };
      }
      if (args.includes("image") && args.some((arg) => arg.includes("t3-gateway"))) {
        return { status: options.imageStatus ?? 0, stdout: options.gatewayLabel ?? "", stderr: "" };
      }
      if (args.includes("image")) {
        const image = args[args.indexOf("inspect") + 1];
        return {
          status: options.imageStatus ?? 0,
          stdout: options.imageVersion ?? image?.split(":").at(-1) ?? "",
          stderr: "",
        };
      }
      if (args.includes("info") && args.includes("{{json .SecurityOptions}}")) {
        return { status: 0, stdout: options.securityOptions ?? "[]", stderr: "" };
      }
      if (args.includes("info")) {
        return {
          status: 0,
          stdout: options.operatingSystem ?? "Docker Engine - Community",
          stderr: "",
        };
      }
      if (args[2] === "run" && args.includes("--privileged")) {
        if ((options.allowStatus ?? 0) === 0) allowed = true;
        return {
          status: options.allowStatus ?? 0,
          stdout: "",
          stderr: options.allowStatus === undefined ? "" : "permission denied",
        };
      }
      if (args[2] === "run" && args.includes("--entrypoint") && options.hostKernel !== undefined) {
        return {
          status: 0,
          stdout: allowed ? (options.hostKernelAllowed ?? options.hostKernel) : options.hostKernel,
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
      if (url.endsWith("/.well-known/t3/environment")) {
        return options.gatewayAnswers === false
          ? { status: 0, body: "", error: "connection refused" }
          : { status: 200, body: "{}" };
      }
      if (options.unreachable?.some((origin) => url.startsWith(origin)) === true) {
        return { status: 0, body: "", error: "connection refused" };
      }
      if (url.endsWith("/api/instance") && options.instanceBody !== undefined) {
        return { status: 200, body: options.instanceBody };
      }
      if (url.endsWith("/api/health")) {
        const elsewhere = Object.entries(options.healthAt ?? {}).find(([origin]) =>
          url.startsWith(`${origin}/`),
        );
        return {
          status: options.healthStatus ?? 200,
          body:
            elsewhere?.[1] ??
            options.healthBody ??
            JSON.stringify({ status: "ok", version: "0.23.0" }),
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
    garageCalls,
    randomCalls: () => randomSizes.length,
  };
};

/**
 * Image work for the install itself. Setup's look at the Docker host's kernel comes first, through
 * postgres:17-alpine, an image every install pulls anyway.
 */
const installImageWork = (args: ReadonlyArray<string>): boolean =>
  args[2] === "image" && !args.includes("postgres:17-alpine");

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

/** This host's daemon facts: docker.service stops after `timeoutStop` s, a workspace running. */
const daemonFacts =
  (timeoutStop: number, workspaceStopTimeout: number | null = null) =>
  (infoStdout: string | null) => ({
    info: infoStdout === null ? null : parseDockerInfo(infoStdout),
    dockerdPid: "840",
    containers:
      workspaceStopTimeout === null
        ? []
        : [{ name: "sealant-run-1", stopTimeout: workspaceStopTimeout }],
    unit: {
      name: "docker.service",
      activeState: "active",
      mainPid: "840",
      timeoutStopSeconds: timeoutStop,
    },
  });

const UBUNTU_REFUSES = "1\n|Y\n|1\n|";
const UBUNTU_ALLOWS = "0\n|Y\n|1\n|";
const USERNS_FIX =
  "echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system";
const USERNS_REMINDER = `No session can start on this Docker host yet: its kernel refuses unprivileged user namespaces, which each workspace's rootless Docker service needs. On the host, run: ${USERNS_FIX}`;
const privilegedRuns = (control: RuntimeControl) =>
  control.commands.filter(([, args]) => args.includes("--privileged"));
const asking = (control: RuntimeControl, answer: string | null) => {
  const prompts: Array<string> = [];
  const runtime: ServerSetupRuntime = {
    ...control.runtime,
    prompter: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
  };
  return { runtime, prompts };
};

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
            "compose.mirrors.yaml",
            "compose.yaml",
            "docker-mirror-guard.sh",
            "identity.env",
            "npm-mirror.conf",
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
            // The bucket's volume is claimed like the other two, before Compose, never by it.
            expect(control.daemon.volumes.get("mend-garage")).toEqual({
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
    expect(await serverCommand(["setup", "--yes"], runtime)).toEqual({ _tag: "ok" });
    const identity = fs.readFileSync(path.join(configDir, "identity.env"));
    const generation = activeDirectory(configDir);
    const env = fs.readFileSync(path.join(generation, "server.env"));
    expect(events).toEqual(["create", "create", "create", "compose", "health"]);
    events.length = 0;
    expect(await serverCommand(["setup", "--yes"], runtime)).toEqual({ _tag: "ok" });
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
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
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
      expect(await serverCommand(["setup", "--yes"], control.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("Docker volume ownership check failed"),
      });
      expect([...daemon.containers]).toEqual(before);
      expect(daemon.volumes.size).toBe(0);
      expect(
        control.commands.some(
          ([, args]) => args.includes("up") || args.includes("create") || installImageWork(args),
        ),
      ).toBe(false);
    },
  );

  it("a different configDir identity cannot operate an existing daemon's data", async () => {
    const daemon = new DockerProtocol();
    const first = makeRuntime({ daemon });
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
    const identity = fs.readFileSync(path.join(first.runtime.configDir, "identity.env"));
    const volumes = [...daemon.volumes];
    const manifests = [...daemon.remote];
    const second = makeRuntime({ daemon });
    const result = await serverCommand(["setup", "--yes"], second.runtime);
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
        ([, args]) => args.includes("up") || args.includes("create") || installImageWork(args),
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
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
  });

  it("keeps the plain refusal for data in the way that carries no Mend label", async () => {
    const daemon = new DockerProtocol();
    daemon.volumes.set("mend-control", null);
    const refused = await serverCommand(["setup", "--yes"], makeRuntime({ daemon }).runtime);
    expect(refused).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Restore the original Mend identity/configuration"),
    });
    expect([...daemon.volumes.keys()]).toEqual(["mend-control"]);
  });

  it.each(["mend-control", "mend-garage"])(
    "refuses a foreign %s volume before and after the anchor exists, pointing at mend uninstall for an earlier install's leftovers",
    async (volume) => {
      // Before any anchor: an unowned volume with a bundle name is existing data, never adopted.
      // It carries Mend's installation label with no anchor beside it: what a partial uninstall
      // left, which mend uninstall removes.
      const orphaned = new DockerProtocol();
      orphaned.volumes.set(volume, { [SERVER_VOLUME_OWNER_LABEL]: "another-installation" });
      const first = makeRuntime({ daemon: orphaned });
      const refused = await serverCommand(["setup", "--yes"], first.runtime);
      expect(refused).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(
          "Docker still holds what an earlier Mend install left behind: volumes with Mend's installation label and no installation to own them. Run mend uninstall --server to remove them, then run setup again.",
        ),
      });
      expect([...orphaned.volumes.keys()]).toEqual([volume]);
      expect(first.commands.some(([, args]) => args.includes("up") || args[3] === "create")).toBe(
        false,
      );
      // Beside an owned anchor: a volume somebody else labelled is a conflict for setup and start.
      const daemon = new DockerProtocol();
      const control = makeRuntime({ daemon });
      expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
      expect([...daemon.volumes.keys()]).toEqual(["mend-store", "mend-control", "mend-garage"]);
      daemon.volumes.set(volume, { [SERVER_VOLUME_OWNER_LABEL]: "another-installation" });
      const ups = control.commands.filter(([, args]) => args.includes("up")).length;
      const conflict = await serverCommand(["setup", "--yes"], control.runtime);
      expect(conflict).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("Restore the original Mend identity/configuration"),
      });
      expect(await serverCommand(["start"], control.runtime)).toEqual(conflict);
      expect(control.commands.filter(([, args]) => args.includes("up"))).toHaveLength(ups);
      expect(daemon.volumes.get(volume)).toEqual({
        [SERVER_VOLUME_OWNER_LABEL]: "another-installation",
      });
      if (volume === "mend-garage") {
        // Word for word the refusal a foreign control volume gets: one ownership rule, three volumes.
        const other = new DockerProtocol();
        other.volumes.set("mend-control", { [SERVER_VOLUME_OWNER_LABEL]: "another-installation" });
        expect(
          await serverCommand(["setup", "--yes"], makeRuntime({ daemon: other }).runtime),
        ).toEqual(refused);
      }
    },
  );

  it("matches the packaging ownership contract", () => {
    const contract: unknown = JSON.parse(
      fs.readFileSync(
        new URL("../test-fixtures/docker/setup-contract.v2.json", import.meta.url),
        "utf8",
      ),
    );
    expect(contract).toMatchObject({
      canonicalVolumes: { store: "mend-store", control: "mend-control", garage: "mend-garage" },
      volumeOwnership: {
        anchor: "mend-store",
        label: SERVER_VOLUME_OWNER_LABEL,
        identity: "SHA-256 of the persisted identity.env bytes",
        externalVolumes: ["mend-store", "mend-control", "mend-garage"],
      },
      captureStore: { bucket: "garage", image: "dxflrs/garage:v2.4.1", bucketName: "mend" },
    });
  });

  it.each(["missing-identity", "corrupt-identity", "corrupt-env", "corrupt-compose"])(
    "refuses %s without replacing credentials or touching daemon data",
    async (damage) => {
      const first = makeRuntime();
      expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
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
      expect((await serverCommand(["setup", "--yes"], retry.runtime))._tag).toBe("error");
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
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Docker volume ownership check failed"),
    });
    expect([...control.daemon.volumes.keys()]).toEqual(["mend-store"]);
    expect(control.commands.some(([, args]) => args.includes("up") || installImageWork(args))).toBe(
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
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
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
    // Only the server itself is asked: its health, and whether it has accounts yet.
    expect(control.fetched.every((url) => /\/api\/(health|instance)$/.test(url))).toBe(true);
    for (const [, args] of control.commands.filter(([, commandArgs]) =>
      commandArgs.includes("up"),
    )) {
      expect(args.slice(-3)).toEqual(["--pull", "never", "--no-build"]);
    }
    // Offline never pulls anything.
    expect(control.commands.filter(([, args]) => args.includes("pull"))).toHaveLength(0);
  });

  it("preloads the cloud metadata guard image the Mend image names, and refuses without it", async () => {
    const guard =
      "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
    const online = makeRuntime({ guardLabel: guard, missingImages: [guard] });
    expect(await serverCommand(["setup", "--yes"], online.runtime)).toEqual({ _tag: "ok" });
    expect(online.lines).toContain(`Pulling ${guard}`);
    const pull = online.commands.findIndex(
      ([, args]) => args.includes("pull") && args.includes(guard),
    );
    const up = online.commands.findIndex(
      ([, args]) => args.includes("compose") && args.includes("up"),
    );
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(up);

    const unreachable = makeRuntime({ guardLabel: guard, missingImages: [guard], pullFails: true });
    const failed = await serverCommand(["setup", "--yes"], unreachable.runtime);
    expect(failed).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(`Could not pull ${guard}`),
    });
    expect(
      unreachable.commands.some(([, args]) => args.includes("compose") && args.includes("up")),
    ).toBe(false);

    const assets = temporaryDirectory("assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "compose.v2.yaml"), composeAsset);
    fs.writeFileSync(path.join(assets, "postgres-init.sh"), postgresAsset);
    const offline = makeRuntime({ guardLabel: guard, missingImages: [guard] });
    expect(
      await serverCommand(
        ["setup", "--assets-dir", assets, "--offline", "--version", "0.23.0"],
        offline.runtime,
      ),
    ).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        `Preload ${guard}, which refuses the cloud metadata address`,
      ),
    });
    expect(offline.commands.filter(([, args]) => args.includes("pull"))).toHaveLength(0);
  });

  it("refuses a guard label that is not an image reference", async () => {
    const control = makeRuntime({ guardLabel: "--privileged" });
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("invalid dev.sealant.mend.network-guard-image"),
    });
  });

  it("warns, before starting, when a Docker stop would outlast docker.service's stop timeout, and says nothing when it fits", async () => {
    const info = JSON.stringify({ OperatingSystem: "Ubuntu 24.04.1 LTS", SecurityOptions: [] });
    // A workspace from before Core bounded its stop timeout, still running on a re-run.
    const old = makeRuntime({ operatingSystem: info });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...old.runtime,
        dockerDaemonFacts: daemonFacts(90, 3600),
      }),
    ).toEqual({ _tag: "ok" });
    const warning = old.lines.findIndex((line) => line.startsWith("A Docker stop waits"));
    expect(old.lines[warning]).toBe(
      "A Docker stop waits up to 3600 s (sealant-run-1's stop timeout), but systemd kills docker.service after 90 s, and Docker's next start waits for what it left running: a restart or upgrade of Docker with a live session leaves Docker down until that workspace ends. To avoid it: stop that session (mend sessions, then mend stop <session>) before you restart or upgrade Docker.",
    );
    expect(warning).toBeLessThan(old.lines.findIndex((line) => line.startsWith("Starting")));
    // A unit too short for the workspaces this starts.
    const short = makeRuntime({ operatingSystem: info });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...short.runtime,
        dockerDaemonFacts: daemonFacts(45),
      }),
    ).toEqual({ _tag: "ok" });
    expect(short.lines.find((line) => line.startsWith("A Docker stop waits"))).toContain(
      "sudo systemctl edit docker.service and set [Service] TimeoutStopSec=95",
    );
    // Ubuntu's stock unit and workspaces with the bounded stop timeout: nothing to say.
    const fits = makeRuntime({ operatingSystem: info });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...fits.runtime,
        dockerDaemonFacts: daemonFacts(90, 60),
      }),
    ).toEqual({ _tag: "ok" });
    expect(fits.lines.some((line) => line.startsWith("A Docker stop waits"))).toBe(false);
    expect(fits.lines.some((line) => line.includes("shutdown-timeout"))).toBe(false);
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
    // Only the server itself is asked: its health, and whether it has accounts yet.
    expect(control.fetched.every((url) => /\/api\/(health|instance)$/.test(url))).toBe(true);
    expect(control.lines.some((line) => line.includes("is reachable"))).toBe(false);
  });

  it("reports the health wait while it lasts, then fails with the last observation", async () => {
    const control = makeRuntime({ healthStatus: 503, healthBody: "" });
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toMatchObject({
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
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toMatchObject({
      _tag: "error",
    });
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
  });

  it("uses the daemon-side socket on Linux Docker Desktop, including renamed contexts", async () => {
    const control = makeRuntime({
      operatingSystem: "Docker Desktop",
      inspectedEndpoint: "unix:///home/alice/.docker/desktop/docker.sock",
    });
    expect(
      await serverCommand(["setup", "--yes", "--context", "my-desktop"], control.runtime),
    ).toEqual({
      _tag: "ok",
    });
    expect(
      readEnv(activeFile(control.runtime.configDir, "server.env")).get("DOCKER_SOCKET_PATH"),
    ).toBe("/var/run/docker.sock");
  });
  it("on a host that refuses user namespaces (Ubuntu 24.04) and no one to ask: the command, before anything is pulled, and again last", async () => {
    const control = makeRuntime({ hostKernel: UBUNTU_REFUSES });
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    expect(privilegedRuns(control)).toEqual([]);
    const said = control.lines.indexOf(
      `Setup changes the host's kernel only when asked: answer the question on a terminal, or pass --allow-userns. On the host, run: ${USERNS_FIX}`,
    );
    expect(said).toBeGreaterThan(0);
    expect(control.lines[said - 1]).toBe(
      "Sessions cannot start on this host yet: Ubuntu blocks the unprivileged user namespaces each workspace's Docker service needs.",
    );
    expect(said).toBeLessThan(control.lines.indexOf("Downloading release assets for Mend 0.23.0"));
    expect(control.lines.at(-1)).toBe(USERNS_REMINDER);
    const probe = control.commands.find(([, args]) => args.includes("--entrypoint"));
    expect(probe?.[1].slice(0, 9)).toEqual([
      "--context",
      "default",
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      "postgres:17-alpine",
    ]);
  });

  it("asks before anything is pulled, and on a yes allows them through Docker and observes it", async () => {
    const control = makeRuntime({ hostKernel: UBUNTU_REFUSES, hostKernelAllowed: UBUNTU_ALLOWS });
    const { runtime, prompts } = asking(control, "");
    expect(await serverCommand(["setup", "--exposure", "loopback"], runtime)).toEqual({
      _tag: "ok",
    });
    expect(prompts).toEqual(["Allow them now? [Y/n] "]);
    expect(control.lines).toContain(
      "Allowing them writes kernel.apparmor_restrict_unprivileged_userns = 0 to /etc/sysctl.d/60-mend-rootless-docker.conf on the Docker host and applies it now. It lifts that restriction for the whole host, not only for Mend.",
    );
    const allowed = control.lines.indexOf(
      "Allowed: /etc/sysctl.d/60-mend-rootless-docker.conf written on the Docker host and applied; observed: its kernel allows them now.",
    );
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(
      control.lines.indexOf("Downloading release assets for Mend 0.23.0"),
    );
    expect(privilegedRuns(control).map(([, args]) => args)).toEqual([
      [
        "--context",
        "default",
        "run",
        "--rm",
        "--privileged",
        "--network",
        "none",
        "--volume",
        "/etc/sysctl.d:/host/sysctl.d",
        "--volume",
        "/proc/sys:/host/proc-sys",
        "--entrypoint",
        "sh",
        "postgres:17-alpine",
        "-c",
        `file="$1"; value="$2"; shift 2; printf '%s\\n' "$@" > /host/sysctl.d/60-mend-rootless-docker.conf && printf '%s\\n' "$value" > "/host/proc-sys/$file"`,
        "mend-allow-userns",
        "kernel/apparmor_restrict_unprivileged_userns",
        "0",
        "# written by mend server setup; mend uninstall removes it",
        "# previous: kernel.apparmor_restrict_unprivileged_userns = 1",
        "kernel.apparmor_restrict_unprivileged_userns = 0",
      ],
    ]);
    expect(control.lines).not.toContain(USERNS_REMINDER);
  });

  it("on a no, changes nothing on the host and prints the command, then repeats it last", async () => {
    const control = makeRuntime({ hostKernel: UBUNTU_REFUSES });
    const { runtime } = asking(control, "n");
    expect(await serverCommand(["setup", "--exposure", "loopback"], runtime)).toEqual({
      _tag: "ok",
    });
    expect(privilegedRuns(control)).toEqual([]);
    expect(control.lines).toContain(
      `Left as it is (--no-allow-userns or your answer). On the host, run: ${USERNS_FIX}`,
    );
    expect(control.lines.at(-1)).toBe(USERNS_REMINDER);
  });

  it("--allow-userns answers for a script; --no-allow-userns leaves it, and neither is a question", async () => {
    const yes = makeRuntime({ hostKernel: UBUNTU_REFUSES, hostKernelAllowed: UBUNTU_ALLOWS });
    expect(await serverCommand(["setup", "--yes", "--allow-userns"], yes.runtime)).toEqual({
      _tag: "ok",
    });
    expect(privilegedRuns(yes)).toHaveLength(1);
    expect(yes.lines).not.toContain(USERNS_REMINDER);

    const no = makeRuntime({ hostKernel: UBUNTU_REFUSES });
    const { runtime, prompts } = asking(no, "y");
    expect(
      await serverCommand(["setup", "--exposure", "loopback", "--no-allow-userns"], runtime),
    ).toEqual({ _tag: "ok" });
    expect(prompts).toEqual([]);
    expect(privilegedRuns(no)).toEqual([]);
    expect(no.lines.at(-1)).toBe(USERNS_REMINDER);
  });

  it("does not try through a rootless daemon, and says the command when the helper fails", async () => {
    const rootless = makeRuntime({
      hostKernel: UBUNTU_REFUSES,
      securityOptions: '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]',
    });
    expect(await serverCommand(["setup", "--yes", "--allow-userns"], rootless.runtime)).toEqual({
      _tag: "ok",
    });
    expect(privilegedRuns(rootless)).toEqual([]);
    expect(rootless.lines).toContain(
      `Docker here runs rootless, so setup cannot change the host's kernel through it. On the host, run: ${USERNS_FIX}`,
    );

    const failed = makeRuntime({ hostKernel: UBUNTU_REFUSES, allowStatus: 1 });
    expect(await serverCommand(["setup", "--yes", "--allow-userns"], failed.runtime)).toEqual({
      _tag: "ok",
    });
    expect(failed.lines).toContain(
      `Setup could not apply it through Docker (permission denied). On the host, run: ${USERNS_FIX}`,
    );
    expect(failed.lines.at(-1)).toBe(USERNS_REMINDER);
  });

  it("a host flag alone is not an answer to how Mend is reached", async () => {
    const control = makeRuntime({ hostKernel: UBUNTU_REFUSES });
    expect(await serverCommand(["setup", "--allow-userns"], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("No terminal to ask on, and no flag says how"),
    });
    expect(privilegedRuns(control)).toEqual([]);
  });

  it("says nothing about user namespaces on a host that allows them", async () => {
    const control = makeRuntime({ hostKernel: "-|-|-|" });
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    expect(control.lines.some((line) => line.includes("user namespaces"))).toBe(false);
  });

  it("creates a pinned localhost installation and starts compose through the selected context", async () => {
    const control = makeRuntime();

    const result = await serverCommand(["setup", "--yes"], control.runtime);

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
        "MEND_DOCKER_MIRROR_MAX_SIZE",
        "MEND_GARAGE_ADMIN_TOKEN",
        "MEND_GARAGE_KEY_ID",
        "MEND_GARAGE_KEY_SECRET",
        "MEND_GARAGE_RPC_SECRET",
        "MEND_GARAGE_VOLUME_NAME",
        "MEND_IMAGE_REPOSITORY",
        "MEND_NPM_MIRROR_MAX_SIZE",
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
    expect(env.get("MEND_NPM_MIRROR_MAX_SIZE")).toBe("10g");
    expect(
      JSON.parse(fs.readFileSync(activeFile(control.runtime.configDir, "server.json"), "utf8"))
        .mirrors,
    ).toEqual({ npm: { maxSize: "10g" }, docker: { maxSize: "20g" } });
    expect(modeOf(activeFile(control.runtime.configDir, "npm-mirror.conf"))).toBe(0o644);
    expect(
      fs.readFileSync(activeFile(control.runtime.configDir, "compose.yaml"), "utf8"),
    ).toContain("mend-postgres");
    // Each slow phase announces itself before it starts, so a long pull or wait never looks like a hang.
    expect(control.lines).toEqual([
      'Using Docker context "default" (unix:///var/run/docker.sock)',
      "Downloading release assets for Mend 0.23.0",
      "Starting Mend 0.23.0 containers; Docker waits up to 120s for them to report healthy",
      "Capture store bucket mend is laid out in Garage",
      "Mend 0.23.0 is reachable at http://localhost:3105",
      "The npm mirror runs on this install. New sessions install npm packages through it, capped at 10g.",
      "The Docker mirror runs on this install. New sessions' Docker daemons pull Docker Hub images through it (mend-docker-mirror).",
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
      "-f",
      activeFile(control.runtime.configDir, "compose.mirrors.yaml"),
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
    expect(await serverCommand(["setup", "--yes"], second.runtime)).toEqual({ _tag: "ok" });

    expect(second.randomSizes).toEqual([]);
    expect(second.fetched.filter((url) => !/\/api\/(health|instance)$/.test(url))).toEqual([]);
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
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
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

  it("a re-run on an install with accounts never says to create the first account", async () => {
    const configDir = temporaryDirectory("accounts");
    const first = makeRuntime({
      configDir,
      instanceBody: '{"users":"none","registration":"open"}',
    });
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
    expect(first.lines.at(-1)).toBe(
      "Open http://localhost:3105, create the first account, then run: mend login --url http://localhost:3105",
    );

    const some = '{"users":"some","registration":"closed"}';
    const signedOut = makeRuntime({ configDir, daemon: first.daemon, instanceBody: some });
    expect(await serverCommand(["setup", "--yes"], signedOut.runtime)).toEqual({ _tag: "ok" });
    expect(signedOut.lines.some((line) => line.includes("first account"))).toBe(false);
    expect(signedOut.lines.at(-1)).toBe(
      "Open http://localhost:3105 to sign in. To sign in this machine's CLI, run: mend login --url http://localhost:3105",
    );

    const signedIn = makeRuntime({ configDir, daemon: first.daemon, instanceBody: some });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...signedIn.runtime,
        savedCliLogin: () => ({ url: "http://localhost:3105", signedIn: true }),
      }),
    ).toEqual({ _tag: "ok" });
    expect(signedIn.lines.some((line) => line.includes("first account"))).toBe(false);
    expect(signedIn.lines.some((line) => line.includes("mend login"))).toBe(false);
  });

  it("a changed URL moves this machine's CLI on a yes, keeping its sign-in, and tells everyone else", async () => {
    const configDir = temporaryDirectory("url-change");
    const first = makeRuntime({ configDir });
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });

    const moved = makeRuntime({
      configDir,
      daemon: first.daemon,
      instanceBody: '{"users":"some","registration":"closed"}',
      unreachable: ["http://localhost:3105"],
    });
    const repointed: Array<string> = [];
    const prompts: Array<string> = [];
    expect(
      await serverCommand(["setup", "--bind", "10.0.0.52", "--url", "http://10.0.0.52:3105"], {
        ...moved.runtime,
        savedCliLogin: () => ({ url: "http://localhost:3105", signedIn: true }),
        repointCliLogin: (_dir, url) => repointed.push(url),
        prompter: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).toEqual({ _tag: "ok" });
    expect(prompts).toEqual([
      "This machine's CLI is signed in at http://localhost:3105, which no longer answers. Point it at http://10.0.0.52:3105? Its sign-in carries over. [Y/n] ",
    ]);
    expect(repointed).toEqual(["http://10.0.0.52:3105"]);
    expect(moved.lines).toContain(
      "Mend's URL changed from http://localhost:3105 to http://10.0.0.52:3105. Browsers open http://10.0.0.52:3105. A CLI signed in at the old URL (another account on this machine, another machine) moves with: mend login --url http://10.0.0.52:3105",
    );
    expect(moved.lines.at(-1)).toBe(
      "This machine's CLI now points at http://10.0.0.52:3105; its sign-in carried over.",
    );

    // No one to ask and no --yes: the command, not a silent change.
    const unasked = makeRuntime({
      configDir,
      daemon: first.daemon,
      instanceBody: '{"users":"some","registration":"closed"}',
      unreachable: ["http://10.0.0.52:3105/api/health"],
    });
    const untouched: Array<string> = [];
    expect(
      await serverCommand(["setup", "--bind", "127.0.0.1", "--url", "http://localhost:3105"], {
        ...unasked.runtime,
        savedCliLogin: () => ({ url: "http://10.0.0.52:3105", signedIn: true }),
        repointCliLogin: (_dir, url) => untouched.push(url),
      }),
    ).toEqual({ _tag: "ok" });
    expect(untouched).toEqual([]);
    expect(unasked.lines).toContain(
      "This machine's CLI still points at http://10.0.0.52:3105, which no longer answers. Move it with: mend login --url http://localhost:3105",
    );
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

  it("a public address on an existing install is said as observed beside the declared exposure, and nothing on a private one", async () => {
    const configDir = temporaryDirectory("public-bind");
    const first = makeRuntime({ configDir });
    expect(
      await serverCommand(
        ["setup", "--bind", "10.0.0.4", "--url", "http://10.0.0.4:3105"],
        first.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(first.lines.some((line) => line.includes("a public address"))).toBe(false);

    const second = makeRuntime({ configDir, daemon: first.daemon });
    expect(
      await serverCommand(
        ["setup", "--bind", "203.0.113.5", "--url", "http://203.0.113.5:3105"],
        second.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(second.lines).toContain(
      "Observed: Mend's port is published on 203.0.113.5:3105, a public address; the exposure is declared private (unset), so the public exposure gate is not evaluated.",
    );
    expect(second.lines).toContain(
      "Observed: workspace SSH is published on 203.0.113.5:2222, a public address; the exposure is declared private (unset).",
    );
  });

  it("moves a saved non-local URL to the port --port publishes, and keeps one on another port", async () => {
    const configDir = temporaryDirectory("port-move");
    expect(
      await serverCommand(
        ["setup", "--bind", "0.0.0.0", "--url", "http://mend-mini.local:3105"],
        makeRuntime({ configDir }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--port", "3205"], makeRuntime({ configDir }).runtime),
    ).toEqual({ _tag: "ok" });
    const moved = readEnv(activeFile(configDir, "server.env"));
    expect(moved.get("APP_URL")).toBe("http://mend-mini.local:3205");
    expect(moved.get("MEND_PORT")).toBe("3205");

    // A URL on a port setup does not publish (a forward in front of it) is the operator's own.
    const forwarded = temporaryDirectory("port-forwarded");
    expect(
      await serverCommand(
        ["setup", "--bind", "0.0.0.0", "--url", "http://mend-mini.local:8080"],
        makeRuntime({ configDir: forwarded }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--port", "3206"],
        makeRuntime({ configDir: forwarded }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(forwarded, "server.env")).get("APP_URL")).toBe(
      "http://mend-mini.local:8080",
    );

    // An https origin is an endpoint in front of Mend (a TLS terminator of the operator's own),
    // which --port does not move: not when it names the old port, not when its port is implicit.
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["--port", "3105", "--url", "https://mini.example:3105"], "https://mini.example:3105"],
      [["--port", "443", "--url", "https://mini.example"], "https://mini.example"],
      [["--port", "80", "--url", "http://mini.example"], "http://mini.example"],
    ];
    for (const [first, kept] of cases) {
      const directory = temporaryDirectory("port-kept");
      expect(
        await serverCommand(
          ["setup", "--bind", "0.0.0.0", ...first],
          makeRuntime({ configDir: directory }).runtime,
        ),
      ).toEqual({ _tag: "ok" });
      expect(
        await serverCommand(
          ["setup", "--port", "3205"],
          makeRuntime({ configDir: directory }).runtime,
        ),
      ).toEqual({ _tag: "ok" });
      const env = readEnv(activeFile(directory, "server.env"));
      expect(env.get("APP_URL")).toBe(kept);
      expect(env.get("MEND_PORT")).toBe("3205");
    }
  });

  it("publishes workspace SSH with --ssh-bind while an edge keeps the web port on loopback", async () => {
    const configDir = temporaryDirectory("ssh-bind");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    const withSsh = makeRuntime({ configDir });
    expect(
      await serverCommand(
        ["setup", "--edge", "mend.example.test", "--ssh-bind", "0.0.0.0"],
        withSsh.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(
      withSsh.lines.some((line) => line.endsWith("Workspace SSH is published on 0.0.0.0:2222.")),
    ).toBe(true);
    const env = readEnv(activeFile(configDir, "server.env"));
    expect(env.get("MEND_BIND_HOST")).toBe("127.0.0.1");
    expect(env.get("MEND_SSH_BIND_HOST")).toBe("0.0.0.0");
    expect(JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"))).toMatchObject(
      { bind: "127.0.0.1", sshBind: "0.0.0.0", edgeHost: "mend.example.test" },
    );
    // The compose asset publishes 2222 on it, and 3105 on --bind.
    const compose = fs.readFileSync(activeFile(configDir, "compose.yaml"), "utf8");
    expect(compose).toContain('"${MEND_BIND_HOST:-127.0.0.1}:${MEND_PORT:-3105}:3105"');
    expect(compose).toContain(
      '"${MEND_SSH_BIND_HOST:-${MEND_BIND_HOST:-127.0.0.1}}:${MEND_SSH_PORT:-2222}:2222"',
    );

    // Kept across a rerun; the --bind address takes it away.
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    expect(readEnv(activeFile(configDir, "server.env")).get("MEND_SSH_BIND_HOST")).toBe("0.0.0.0");
    expect(
      await serverCommand(["setup", "--ssh-bind", "127.0.0.1"], makeRuntime({ configDir }).runtime),
    ).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).has("MEND_SSH_BIND_HOST")).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8")),
    ).not.toHaveProperty("sshBind");

    const refusals: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["--ssh-bind", "mend-mini.local"], "literal IPv4 or IPv6"],
      [["--exposure", "loopback", "--ssh-bind", "0.0.0.0"], "non-loopback --ssh-bind"],
    ];
    for (const [args, message] of refusals) {
      const refused = makeRuntime();
      const result = await serverCommand(["setup", ...args], refused.runtime);
      expect(result).toMatchObject({ _tag: "error", message: expect.stringContaining(message) });
      expect(fs.existsSync(path.join(refused.runtime.configDir, "active"))).toBe(false);
    }
  });

  it("hands workspace SSH published beside a public edge to the exposure gate, and starts public only once it is declared", async () => {
    const configDir = temporaryDirectory("ssh-gate");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    // Public, with SSH on every interface beside the edge, and nobody stated who reaches it.
    const undeclared = makeRuntime({ configDir });
    const refused = await serverCommand(
      ["setup", "--edge", "mend.example.test", "--exposure", "public", "--ssh-bind", "0.0.0.0"],
      undeclared.runtime,
    );
    expect(refused).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("add --declare workspace-ssh"),
    });
    expect(undeclared.commands.some(([, args]) => args.includes("up"))).toBe(false);

    // Declared: the statement and where SSH is published both reach the mend container.
    const declared = makeRuntime({ configDir });
    const probed: Array<string> = [];
    expect(
      await serverCommand(
        [
          "setup",
          "--edge",
          "mend.example.test",
          "--exposure",
          "public",
          "--ssh-bind",
          "0.0.0.0",
          "--declare",
          "workspace-ssh",
          "--declare",
          "core-private",
        ],
        {
          ...declared.runtime,
          probeSsh: async (bind, port) => {
            probed.push(`${bind}:${port}`);
            return [
              { address: "192.168.1.20", banner: "SSH-2.0-sealant-gateway" },
              { address: "100.64.0.7", banner: null },
            ];
          },
        },
      ),
    ).toEqual({ _tag: "ok" });
    const env = readEnv(activeFile(configDir, "server.env"));
    expect(env.get("MEND_SSH_PUBLISHED")).toBe("0.0.0.0:2222");
    expect(env.get("MEND_EXPOSURE_DECLARED")).toBe("workspace-ssh,core-private");
    const overlay = fs.readFileSync(activeFile(configDir, "compose.posture.yaml"), "utf8");
    expect(overlay).toContain("MEND_SSH_PUBLISHED: ${MEND_SSH_PUBLISHED:?");
    expect(overlay).toContain("MEND_EXPOSURE_DECLARED: ${MEND_EXPOSURE_DECLARED:?");
    expect(JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"))).toMatchObject(
      { sshBind: "0.0.0.0", declared: ["workspace-ssh", "core-private"] },
    );
    // What this machine observed, and only that: never a verdict about who else reaches it.
    expect(probed).toEqual(["0.0.0.0:2222"]);
    expect(declared.lines).toContain(
      "Workspace SSH is published on 0.0.0.0:2222. From this machine: 192.168.1.20:2222 answers (SSH-2.0-sealant-gateway), 100.64.0.7:2222 did not answer. Who else reaches it is up to the network and its firewall; mend operator exposure reports it as workspace-ssh.",
    );
    for (const line of declared.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);

    // Kept across a rerun; taking the declaration away while SSH stays published is refused again.
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    expect(readEnv(activeFile(configDir, "server.env")).get("MEND_EXPOSURE_DECLARED")).toBe(
      "workspace-ssh,core-private",
    );
    expect(
      await serverCommand(["setup", "--declare", "none"], makeRuntime({ configDir }).runtime),
    ).toMatchObject({ _tag: "error", message: expect.stringContaining("--declare workspace-ssh") });
    // SSH back on loopback: nothing to declare, and none of it in the environment.
    expect(
      await serverCommand(
        ["setup", "--ssh-bind", "127.0.0.1", "--declare", "none"],
        makeRuntime({ configDir }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const after = readEnv(activeFile(configDir, "server.env"));
    expect(after.has("MEND_SSH_PUBLISHED")).toBe(false);
    expect(after.has("MEND_EXPOSURE_DECLARED")).toBe(false);

    const invalid = makeRuntime();
    expect(await serverCommand(["setup", "--declare", "budgets"], invalid.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        "--declare takes core-private, edge-tls, workspace-ssh, t3code-gateway or none",
      ),
    });
  });

  it("keeps the edge, public exposure, --ssh-bind, every --declare and the t3code gateway together (mend#620 and #644/#645)", async () => {
    const configDir = temporaryDirectory("ssh-gate-gateway");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    const both = makeRuntime({ configDir, gatewayLabel: "1" });
    expect(
      await serverCommand(
        [
          "setup",
          "--edge",
          "mend.example.test",
          "--exposure",
          "public",
          "--ssh-bind",
          "0.0.0.0",
          "--t3-gateway",
          "--declare",
          "workspace-ssh",
          "--declare",
          "core-private",
          "--declare",
          "t3code-gateway",
        ],
        { ...both.runtime, probeSsh: async () => [] },
      ),
    ).toEqual({ _tag: "ok" });
    const env = readEnv(activeFile(configDir, "server.env"));
    expect(env.get("MEND_SSH_PUBLISHED")).toBe("0.0.0.0:2222");
    expect(env.get("MEND_EXPOSURE_DECLARED")).toBe("workspace-ssh,core-private,t3code-gateway");
    expect(env.get("MEND_T3_GATEWAY_PORT")).toBe("3120");
    expect(JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"))).toMatchObject(
      {
        sshBind: "0.0.0.0",
        declared: ["workspace-ssh", "core-private", "t3code-gateway"],
        t3GatewayPort: 3120,
        edgeHost: "mend.example.test",
      },
    );
    const up = both.commands.find(([, args]) => args.includes("up"))?.[1] ?? [];
    for (const overlay of ["compose.edge.yaml", "compose.posture.yaml", "compose.t3.yaml"]) {
      expect(up.some((arg) => arg.endsWith(overlay))).toBe(true);
    }
    // A rerun keeps all of it: the generation reads back as written.
    expect(
      await serverCommand(
        ["setup", "--yes"],
        makeRuntime({ configDir, gatewayLabel: "1" }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).get("MEND_EXPOSURE_DECLARED")).toBe(
      "workspace-ssh,core-private,t3code-gateway",
    );

    // The gateway off: SSH stays published, and every declaration stays.
    expect(
      await serverCommand(["setup", "--no-t3-gateway"], {
        ...makeRuntime({ configDir }).runtime,
        probeSsh: async () => [],
      }),
    ).toEqual({ _tag: "ok" });
    const off = readEnv(activeFile(configDir, "server.env"));
    expect(off.get("MEND_SSH_PUBLISHED")).toBe("0.0.0.0:2222");
    expect(off.get("MEND_EXPOSURE_DECLARED")).toBe("workspace-ssh,core-private,t3code-gateway");
    expect(off.has("MEND_T3_GATEWAY_PORT")).toBe(false);
    expect(fs.existsSync(activeFile(configDir, "compose.t3.yaml"))).toBe(false);
    expect(fs.existsSync(activeFile(configDir, "compose.posture.yaml"))).toBe(true);

    // The gateway on again and SSH back on loopback: the gateway's overlay stays, SSH's goes.
    expect(
      await serverCommand(
        ["setup", "--t3-gateway", "--ssh-bind", "127.0.0.1"],
        makeRuntime({ configDir, gatewayLabel: "1" }).runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const back = readEnv(activeFile(configDir, "server.env"));
    expect(back.has("MEND_SSH_PUBLISHED")).toBe(false);
    expect(back.get("MEND_T3_GATEWAY_PORT")).toBe("3120");
    expect(fs.readFileSync(activeFile(configDir, "compose.t3.yaml"), "utf8")).toContain(
      '"127.0.0.1:${MEND_T3_GATEWAY_PORT',
    );
    // On loopback, SSH is not published apart: mend#620 keeps no override for it.
    const config = JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"));
    expect(config).toMatchObject({ t3GatewayPort: 3120 });
    expect(config).not.toHaveProperty("sshBind");
  });

  it("reads an SSH banner, and settles on silence, a clean close before any bytes, and a refusal", async () => {
    const banner = await listen((socket) => socket.end("SSH-2.0-sealant-gateway\r\n"));
    const silent = await listen(() => undefined);
    // The reviewer's case: accept, then FIN before any bytes (a gateway restarting).
    const closing = await listen((socket) => socket.end());
    try {
      expect(await sshBannerAt("127.0.0.1", banner.port, 2_000)).toBe("SSH-2.0-sealant-gateway");
      const started = Date.now();
      expect(await sshBannerAt("127.0.0.1", silent.port, 300)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await sshBannerAt("127.0.0.1", closing.port, 5_000)).toBeNull();
    } finally {
      await Promise.all([banner.close(), silent.close(), closing.close()]);
    }
    // Nothing listening: refused at once.
    expect(await sshBannerAt("127.0.0.1", banner.port, 2_000)).toBeNull();
  });

  it("finishes setup when its look at workspace SSH never answers", async () => {
    const configDir = temporaryDirectory("ssh-probe-bound");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    const control = makeRuntime({ configDir });
    expect(
      await serverCommand(["setup", "--edge", "mend.example.test", "--ssh-bind", "0.0.0.0"], {
        ...control.runtime,
        probeSsh: () => new Promise(() => undefined),
        sshProbeBoundMs: 50,
      }),
    ).toEqual({ _tag: "ok" });
    expect(control.lines).toContain(
      "Workspace SSH is published on 0.0.0.0:2222. This machine's look at it did not finish within 0.05 s. Who reaches it is up to the network and its firewall; mend operator exposure reports it as workspace-ssh.",
    );
  });

  it("refuses --ssh-bind with a release whose compose publishes SSH on --bind only", async () => {
    const assets = temporaryDirectory("ssh-bind-old-assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(
      path.join(assets, "compose.v2.yaml"),
      composeAsset.replace(
        "${MEND_SSH_BIND_HOST:-${MEND_BIND_HOST:-127.0.0.1}}",
        "${MEND_BIND_HOST:-127.0.0.1}",
      ),
    );
    fs.writeFileSync(path.join(assets, "postgres-init.sh"), postgresAsset);
    const control = makeRuntime();
    const result = await serverCommand(
      ["setup", "--version", "0.23.0", "--assets-dir", assets, "--ssh-bind", "0.0.0.0"],
      control.runtime,
    );
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("cannot honour --ssh-bind 0.0.0.0"),
    });
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
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
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    fs.writeFileSync(activeFile(configDir, "server.json"), '{"schemaVersion":');
    const corrupt = makeRuntime({ configDir });
    const corruptResult = await serverCommand(["setup", "--yes"], corrupt.runtime);
    expect(corruptResult).toMatchObject({ _tag: "error" });
    if (corruptResult._tag === "error") expect(corruptResult.message).toContain("not valid JSON");
    expect(corrupt.commands).toEqual([]);
  });

  it("rejects truncated secrets instead of replacing them", async () => {
    const configDir = temporaryDirectory("truncated-secrets");
    const first = makeRuntime({ configDir });
    expect(await serverCommand(["setup", "--yes"], first.runtime)).toEqual({ _tag: "ok" });
    const envFile = activeFile(configDir, "server.env");
    fs.writeFileSync(
      envFile,
      fs
        .readFileSync(envFile, "utf8")
        .replace(/SEALANT_SERVICE_KEY=.*/, "SEALANT_SERVICE_KEY=short"),
    );

    const rerun = makeRuntime({ configDir });
    const result = await serverCommand(["setup", "--yes"], rerun.runtime);

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

    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });

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

    expect(
      await serverCommand(["setup", "--yes", "--context", "desktop-linux"], control.runtime),
    ).toEqual({
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
        ["setup", "--yes", "--context", "default", "--docker-socket", socket],
        control.runtime,
      ),
    ).toEqual({ _tag: "ok" });

    const env = readEnv(activeFile(control.runtime.configDir, "server.env"));
    expect(env.get("DOCKER_SOCKET_PATH")).toBe(socket);
  });

  it("rejects a requested remote daemon before writing state", async () => {
    const control = makeRuntime({ inspectedEndpoint: "ssh://docker@example.test" });

    const result = await serverCommand(["setup", "--yes", "--context", "remote"], control.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error") expect(result.message).toContain("remote SSH/TCP daemons");
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    expect(control.commands).toHaveLength(1);
  });

  it("fails Docker availability and capability checks before generating secrets or files", async () => {
    const missing = makeRuntime({ contextListStatus: 1 });
    const missingResult = await serverCommand(["setup", "--yes"], missing.runtime);
    expect(missingResult).toMatchObject({ _tag: "error" });
    if (missingResult._tag === "error")
      expect(missingResult.message).toContain("docker is not installed");
    expect(fs.existsSync(path.join(missing.runtime.configDir, "active"))).toBe(false);

    const stopped = makeRuntime({ dockerVersionStatus: 1 });
    const stoppedResult = await serverCommand(["setup", "--yes"], stopped.runtime);
    expect(stoppedResult).toMatchObject({ _tag: "error" });
    if (stoppedResult._tag === "error")
      expect(stoppedResult.message).toContain("Cannot connect to the Docker daemon");
    expect(fs.existsSync(path.join(stopped.runtime.configDir, "active"))).toBe(false);

    const oldApi = makeRuntime({ dockerVersion: "1.44 1.44" });
    const oldResult = await serverCommand(["setup", "--yes"], oldApi.runtime);
    expect(oldResult).toMatchObject({ _tag: "error" });
    if (oldResult._tag === "error") expect(oldResult.message).toContain("Docker API >= 1.45");
    expect(oldApi.randomCalls()).toBe(0);
    expect(fs.existsSync(path.join(oldApi.runtime.configDir, "active"))).toBe(false);

    const noCompose = makeRuntime({ composeVersionStatus: 1 });
    const composeResult = await serverCommand(["setup", "--yes"], noCompose.runtime);
    expect(composeResult).toMatchObject({ _tag: "error" });
    if (composeResult._tag === "error")
      expect(composeResult.message).toContain("Compose v2 plugin");
    expect(noCompose.randomCalls()).toBe(0);
    expect(fs.existsSync(path.join(noCompose.runtime.configDir, "active"))).toBe(false);
  });

  it("leaves no state when release download is interrupted", async () => {
    const control = makeRuntime({ assetFailure: "postgres" });

    const result = await serverCommand(["setup", "--yes"], control.runtime);

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
    const result = await serverCommand(["setup", "--yes"], first.runtime);
    expect(result._tag).toBe("error");
    expect(first.randomCalls()).toBe(1);
    const identity = fs.readFileSync(path.join(configDir, "identity.env"), "utf8");
    expect(fs.existsSync(path.join(configDir, "active"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "server.lock"))).toBe(false);
    expect(first.commands.some(([, args]) => args.includes("up"))).toBe(false);
    fs.chmodSync(path.join(configDir, "generations"), 0o700);
    const second = makeRuntime({ configDir });
    expect(await serverCommand(["setup", "--yes"], second.runtime)).toEqual({ _tag: "ok" });
    expect(second.randomSizes).toEqual([]);
    expect(fs.readFileSync(activeFile(configDir, "identity.env"), "utf8")).toBe(identity);
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identity);
  });

  it("refuses an unrecognised flat installation instead of generating another identity", async () => {
    const control = makeRuntime();
    fs.mkdirSync(control.runtime.configDir, { recursive: true });
    const original = "existing unreleased credentials\n";
    fs.writeFileSync(path.join(control.runtime.configDir, "server.env"), original);
    const result = await serverCommand(["setup", "--yes"], control.runtime);
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
    expect(await serverCommand(["setup", "--yes", "--context", "local"], first.runtime)).toEqual({
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
    expect(await serverCommand(["setup", "--yes"], desktop.runtime)).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).get("DOCKER_SOCKET_PATH")).toBe(
      "/var/run/docker.sock",
    );
    expect(
      await serverCommand(["setup", "--docker-socket", "/custom/socket"], desktop.runtime),
    ).toEqual({ _tag: "ok" });
    expect(await serverCommand(["setup", "--yes"], desktop.runtime)).toEqual({ _tag: "ok" });
    expect(readEnv(activeFile(configDir, "server.env")).get("DOCKER_SOCKET_PATH")).toBe(
      "/custom/socket",
    );
    expect(fs.readFileSync(path.join(configDir, "identity.env"), "utf8")).toBe(identity);
  });

  it.each([
    [["--edge", "10.0.0.4"], "DNS name"],
    [["--edge", "localhost"], "DNS name"],
    [
      ["--edge", "mend.example.test", "--bind", "0.0.0.0", "--url", "https://mend.example.test"],
      "stays on loopback",
    ],
    [
      ["--edge", "mend.example.test", "--url", "http://mend.example.test:3105"],
      "must be https://mend.example.test",
    ],
    [["--edge", "mend.example.test", "--exposure", "loopback"], "contradict"],
    [["--edge", "mend.example.test", "--no-edge"], "contradict"],
    [["--exposure", "public"], "needs the edge"],
    [["--edge", "mend.example.test"], "A fresh install cannot start with the edge or as public"],
    [["--edge", "mend.example.test", "--port", "443"], "must not be 80 or 443"],
    [["--edge", "mend.example.test", "--ssh-port", "80"], "must not be 80 or 443"],
    [
      ["--exposure", "public", "--edge", "mend.example.test"],
      "A fresh install cannot start with the edge or as public",
    ],
    [
      ["--exposure", "loopback", "--bind", "0.0.0.0", "--url", "http://10.0.0.4:3105"],
      "contradicts a non-loopback --bind",
    ],
    [
      ["--bind", "203.0.113.5", "--url", "http://203.0.113.5:3105", "--exposure", "private"],
      "A fresh install is not published on 203.0.113.5, a public address, as private",
    ],
    [
      ["--bind", "2a01:4f8::1", "--url", "http://[2a01:4f8::1]:3105"],
      "A fresh install is not published on 2a01:4f8::1, a public address, as private",
    ],
    [["--exposure", "sideways"], "--exposure must be one of"],
    [["--tenancy", "both"], "--tenancy must be one of"],
  ])(
    "refuses an edge or posture that cannot hold, before anything is written: %j",
    async (flags, reason) => {
      const control = makeRuntime();
      expect(await serverCommand(["setup", ...flags], control.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(reason),
      });
      expect(
        control.fetched.filter(
          (url) => !url.endsWith("/compose.v2.yaml") && !url.endsWith("/postgres-init.sh"),
        ),
      ).toEqual([]);
      expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
      expect(control.commands.some(([, args]) => args.includes("up"))).toBe(false);
    },
  );

  it("an edge host writes the overlay and the Caddyfile, runs them with compose.yaml, and probes Mend on loopback", async () => {
    const control = makeRuntime();
    // The plain install first, where the first account is created; the edge on a rerun.
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    const plainCommands = control.commands.length;
    expect(await serverCommand(["setup", "--edge", "Mend.Example.Test."], control.runtime)).toEqual(
      { _tag: "ok" },
    );
    const { configDir } = control.runtime;
    const generation = activeDirectory(configDir);
    expect(fs.readdirSync(generation).toSorted()).toEqual([
      "Caddyfile",
      "compose.edge.yaml",
      "compose.mirrors.yaml",
      "compose.yaml",
      "docker-mirror-guard.sh",
      "identity.env",
      "npm-mirror.conf",
      "postgres-init.sh",
      "server.env",
      "server.json",
    ]);
    expect(modeOf(path.join(generation, "Caddyfile"))).toBe(0o644);
    expect(modeOf(path.join(generation, "compose.edge.yaml"))).toBe(0o600);
    expect(fs.readFileSync(path.join(generation, "compose.edge.yaml"), "utf8")).toBe(
      fs.readFileSync(new URL("../../../deploy/docker/compose.edge.yaml", import.meta.url), "utf8"),
    );
    expect(fs.readFileSync(path.join(generation, "Caddyfile"), "utf8")).toBe(
      fs.readFileSync(new URL("../../../deploy/docker/Caddyfile", import.meta.url), "utf8"),
    );
    expect(JSON.parse(fs.readFileSync(path.join(generation, "server.json"), "utf8"))).toMatchObject(
      {
        edgeHost: "mend.example.test",
        bind: "127.0.0.1",
        appUrl: "https://mend.example.test",
      },
    );
    const env = readEnv(path.join(generation, "server.env"));
    expect(env.get("MEND_EDGE_HOST")).toBe("mend.example.test");
    expect(env.get("APP_URL")).toBe("https://mend.example.test");
    expect(env.get("MEND_BIND_HOST")).toBe("127.0.0.1");
    expect(env.has("MEND_EXPOSURE")).toBe(false);
    const up = control.commands.slice(plainCommands).find(([, args]) => args.includes("up"));
    expect(up?.[1].slice(0, 16)).toEqual([
      "--context",
      "default",
      "compose",
      "--project-name",
      "mend",
      "--project-directory",
      generation,
      "--env-file",
      path.join(generation, "server.env"),
      "-f",
      path.join(generation, "compose.yaml"),
      "-f",
      path.join(generation, "compose.edge.yaml"),
      "-f",
      path.join(generation, "compose.mirrors.yaml"),
      "up",
    ]);
    expect(up?.[1]).not.toContain("--remove-orphans");
    // Health on Mend's own port, where this machine can reach it; the edge image checked like the rest.
    expect(control.fetched.filter((url) => url.endsWith("/api/health"))).toEqual([
      "http://localhost:3105/api/health",
      "http://127.0.0.1:3105/api/health",
    ]);
    expect(
      control.commands.some(
        ([, args]) =>
          args[2] === "image" && args[3] === "inspect" && args[4] === "caddy:2.10-alpine",
      ),
    ).toBe(true);
    expect(control.lines).toContain(
      "Mend 0.23.0 answers at http://127.0.0.1:3105 on this machine · the edge is set up for https://mend.example.test",
    );
    expect(
      control.lines.some((line) =>
        line.startsWith("The edge for mend.example.test is up on 80 and 443."),
      ),
    ).toBe(true);
    // The edge carries HTTPS only: setup says where workspace SSH stayed.
    expect(
      control.lines.some((line) =>
        line.includes(
          "Workspace SSH is published on 127.0.0.1:2222 only, so Remote-SSH and mend ssh from another machine cannot reach it; --ssh-bind 0.0.0.0 publishes it.",
        ),
      ),
    ).toBe(true);
    for (const line of control.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);
    // A rerun keeps the edge without being told again, and writes nothing new.
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    expect(activeDirectory(configDir)).toBe(generation);
    expect(fs.readdirSync(path.join(configDir, "generations"))).toHaveLength(2);
  });

  it("--t3-gateway writes its loopback overlay, runs it every time, keeps it, and --no-t3-gateway takes it away", async () => {
    const control = makeRuntime({ gatewayLabel: "1" });
    expect(await serverCommand(["setup", "--t3-gateway"], control.runtime)).toEqual({ _tag: "ok" });
    const { configDir } = control.runtime;
    const generation = activeDirectory(configDir);
    expect(fs.readdirSync(generation)).toContain("compose.t3.yaml");
    expect(modeOf(path.join(generation, "compose.t3.yaml"))).toBe(0o600);
    const overlay = fs.readFileSync(path.join(generation, "compose.t3.yaml"), "utf8");
    // Its own listener, on loopback only, and the switch the bundle starts it by.
    expect(overlay).toContain('MEND_T3_GATEWAY_ENABLED: "true"');
    expect(overlay).toContain(
      '- "127.0.0.1:${MEND_T3_GATEWAY_PORT:?set MEND_T3_GATEWAY_PORT in server.env}:3120"',
    );
    expect(overlay).not.toMatch(/0\.0\.0\.0/);
    // Its state in a volume of its own, inside the root it is confined to.
    expect(overlay).toContain("      - mend-t3-gateway:/opt/mend-t3-gateway/state");
    expect(overlay).toMatch(/^volumes:\n {2}mend-t3-gateway:$/m);
    expect(readEnv(path.join(generation, "server.env")).get("MEND_T3_GATEWAY_PORT")).toBe("3120");
    expect(JSON.parse(fs.readFileSync(path.join(generation, "server.json"), "utf8"))).toMatchObject(
      { t3GatewayPort: 3120 },
    );
    const up = control.commands.find(([, args]) => args.includes("up"));
    expect(up?.[1]).toContain(path.join(generation, "compose.t3.yaml"));
    // What was observed at its port, not that it listens because it was asked to.
    expect(
      control.lines.some((line) =>
        line.startsWith(
          "The t3code gateway answered at 127.0.0.1:3120, observed from this machine; it is published there only.",
        ),
      ),
    ).toBe(true);
    for (const line of control.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);
    // A rerun keeps it; another port moves it; --no-t3-gateway takes the overlay away.
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    expect(activeDirectory(configDir)).toBe(generation);
    expect(await serverCommand(["setup", "--t3-gateway-port", "3121"], control.runtime)).toEqual({
      _tag: "ok",
    });
    const moved = activeDirectory(configDir);
    expect(readEnv(path.join(moved, "server.env")).get("MEND_T3_GATEWAY_PORT")).toBe("3121");
    expect(await serverCommand(["setup", "--no-t3-gateway"], control.runtime)).toEqual({
      _tag: "ok",
    });
    const off = activeDirectory(configDir);
    expect(fs.readdirSync(off)).not.toContain("compose.t3.yaml");
    expect(readEnv(path.join(off, "server.env")).has("MEND_T3_GATEWAY_PORT")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(off, "server.json"), "utf8"))).not.toHaveProperty(
      "t3GatewayPort",
    );
    expect(control.lines.some((line) => line.startsWith("The t3code gateway is off."))).toBe(true);
  });

  it("refuses --t3-gateway on an image that has no gateway, before activating anything (644-1)", async () => {
    const control = makeRuntime();
    const result = await serverCommand(["setup", "--t3-gateway"], control.runtime);
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        "Mend 0.23.0 has no t3code gateway (its image carries no dev.sealant.mend.t3-gateway label)",
      ),
    });
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    expect(control.commands.some(([, args]) => args.includes("up"))).toBe(false);
    // Without the gateway, the same image sets up as before.
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
  });

  it("refuses a gateway port something else holds, before anything changes (644 nit)", async () => {
    const control = makeRuntime({ gatewayLabel: "1" });
    const taken: Array<number> = [];
    const result = await serverCommand(["setup", "--t3-gateway"], {
      ...control.runtime,
      portTaken: async (port) => {
        taken.push(port);
        return port === 3120;
      },
    });
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        "127.0.0.1:3120 is already in use on this machine, so the t3code gateway cannot be published there and Mend would not start",
      ),
    });
    // Mend's own ports first, then the gateway's.
    expect(taken).toEqual([3105, 2222, 3120]);
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    expect(control.commands.some(([, args]) => args.includes("up"))).toBe(false);
  });

  it("says the gateway did not answer when it did not, and Mend runs on (644-1)", async () => {
    const control = makeRuntime({ gatewayLabel: "1", gatewayAnswers: false });
    expect(await serverCommand(["setup", "--t3-gateway"], control.runtime)).toEqual({ _tag: "ok" });
    expect(
      control.lines.some((line) =>
        line.startsWith(
          "The t3code gateway did not answer at 127.0.0.1:3120 from this machine within about a minute. Mend runs without it;",
        ),
      ),
    ).toBe(true);
    expect(control.lines.some((line) => line.includes("gateway answered"))).toBe(false);
    expect(
      control.fetched.filter((url) => url.endsWith("/.well-known/t3/environment")),
    ).toHaveLength(15);
  });

  it.each([
    [["--t3-gateway", "--no-t3-gateway"], "contradicts"],
    [["--t3-gateway-port", "3105"], "Mend's own --port or --ssh-port"],
    [["--t3-gateway-port", "70000"], "--t3-gateway-port"],
  ])("refuses a t3code gateway that cannot hold: %j", async (flags, reason) => {
    const control = makeRuntime();
    expect(await serverCommand(["setup", ...flags], control.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(reason),
    });
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
  });

  it("does not report the advertised URL reachable when every health request fails", async () => {
    const control = makeRuntime({ healthStatus: 503 });

    const result = await serverCommand(["setup", "--yes"], control.runtime);

    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error")
      expect(result.message).toContain("did not answer successfully (HTTP 503)");
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
    expect(control.fetched.filter((url) => url.endsWith("/api/health"))).toHaveLength(30);
    expect(control.daemon.calls.some(({ args }) => args[2] === "image")).toBe(false);
    expect(control.randomSizes).toEqual([256]);
  });
});

/** A terminal that answers from a script, keeping every prompt with its answer echoed. */
const scriptedPrompter = (answers: ReadonlyArray<string>, transcript: Array<string>) => {
  const queue = [...answers];
  return async (prompt: string): Promise<string | null> => {
    const given = queue.shift();
    transcript.push(`${prompt}${given ?? "^D"}`);
    return given ?? null;
  };
};

const serverJson = (configDir: string) =>
  JSON.parse(fs.readFileSync(activeFile(configDir, "server.json"), "utf8"));

describe("mend server setup, guided and unasked", () => {
  it("refuses a fresh install with no terminal and no flags, naming the flags, before anything", async () => {
    const control = makeRuntime();
    const result = await serverCommand(["setup"], control.runtime);
    expect(result).toMatchObject({ _tag: "error" });
    if (result._tag === "error") {
      // Setup's own words, not a storage failure: nothing is wrong with the filesystem.
      expect(result.message).toMatch(/^No terminal to ask on/);
      for (const flag of [
        "--yes",
        "--bind <address> --url <origin>",
        "--edge <host> --exposure public",
      ])
        expect(result.message).toContain(flag);
    }
    expect(control.commands).toEqual([]);
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
    // An install to keep needs no answer: a rerun with no flags repairs it as before.
    expect(await serverCommand(["setup", "--yes"], control.runtime)).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup"], makeRuntime({ configDir: control.runtime.configDir }).runtime),
    ).toEqual({
      _tag: "ok",
    });
  });

  it("--declare adds to what is saved, --undeclare takes one back, and flags say what they change", async () => {
    const configDir = temporaryDirectory("declare-additive");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    const run = (flags: ReadonlyArray<string>) => {
      const control = makeRuntime({ configDir });
      return serverCommand(["setup", ...flags], {
        ...control.runtime,
        probeSsh: async () => [],
      }).then((result) => ({ result, lines: control.lines }));
    };
    expect(
      (
        await run([
          "--edge",
          "mend.example.test",
          "--exposure",
          "public",
          "--ssh-bind",
          "0.0.0.0",
          "--declare",
          "workspace-ssh",
          "--declare",
          "core-private",
        ])
      ).result,
    ).toEqual({ _tag: "ok" });
    // One more statement, alone: the saved ones stay (it used to replace them, and a public
    // install then refused to start for the workspace-ssh it dropped).
    const added = await run(["--declare", "edge-tls"]);
    expect(added.result).toEqual({ _tag: "ok" });
    expect(serverJson(configDir).declared).toEqual(["workspace-ssh", "core-private", "edge-tls"]);
    expect(added.lines).toContain("This run changes:");
    expect(added.lines).toContain(
      "  you declared: workspace-ssh, core-private → workspace-ssh, core-private, edge-tls",
    );
    expect((await run(["--undeclare", "core-private"])).result).toEqual({ _tag: "ok" });
    expect(serverJson(configDir).declared).toEqual(["workspace-ssh", "edge-tls"]);
    // One flag on an existing install keeps everything else.
    const gateway = makeRuntime({ configDir, gatewayLabel: "1" });
    expect(
      await serverCommand(["setup", "--t3-gateway"], {
        ...gateway.runtime,
        probeSsh: async () => [],
      }),
    ).toEqual({ _tag: "ok" });
    expect(serverJson(configDir)).toMatchObject({
      edgeHost: "mend.example.test",
      exposure: "public",
      sshBind: "0.0.0.0",
      declared: ["workspace-ssh", "edge-tls"],
      t3GatewayPort: 3120,
    });
    expect(gateway.lines).toContain("  T3 Code gateway: off → on, at 127.0.0.1:3120");
    for (const [flags, reason] of [
      [["--declare", "edge-tls", "--undeclare", "edge-tls"], "both name edge-tls"],
      [["--declare", "none", "--undeclare", "edge-tls"], "drop --undeclare"],
      [["--undeclare", "none"], "--undeclare takes"],
      [["--origin", "none", "--origin", "https://a.example"], "goes alone"],
    ] as const)
      expect((await run(flags)).result).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(reason),
      });
  });

  it("guides a fresh install on a terminal and runs the flags its answers became", async () => {
    const control = makeRuntime();
    const transcript: Array<string> = [];
    const result = await serverCommand(["setup"], {
      ...control.runtime,
      // reach: this machine · T3: no · mirrors: keep · one organization · apply
      prompter: scriptedPrompter(["1", "", "", "", ""], transcript),
    });
    expect(result).toEqual({ _tag: "ok" });
    expect(serverJson(control.runtime.configDir)).toMatchObject({
      bind: "127.0.0.1",
      appUrl: "http://localhost:3105",
      exposure: "loopback",
    });
    expect(control.lines).toContain("Same as: mend server setup --exposure loopback");
    expect(control.lines).toContain("Mend 0.23.0 is reachable at http://localhost:3105");
    expect(control.lines).not.toContain("This run changes:");
    expect(transcript.at(-1)).toBe("Apply? [Y/n] ");
  });

  it("guides a rerun: shows what is saved, changes one thing, keeps the rest and every declaration", async () => {
    const configDir = temporaryDirectory("guided-rerun");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    expect(
      await serverCommand(
        [
          "setup",
          "--edge",
          "mend.example.test",
          "--exposure",
          "public",
          "--tenancy",
          "multi",
          "--ssh-bind",
          "0.0.0.0",
          "--origin",
          "https://box.tail1234.ts.net:8443",
          "--declare",
          "workspace-ssh",
          "--declare",
          "core-private",
        ],
        { ...makeRuntime({ configDir }).runtime, probeSsh: async () => [] },
      ),
    ).toEqual({ _tag: "ok" });
    const before = serverJson(configDir);
    const control = makeRuntime({ configDir, gatewayLabel: "1" });
    const transcript: Array<string> = [];
    // change something · the T3 Code gateway (3rd) · yes · nothing else · apply
    expect(
      await serverCommand(["setup"], {
        ...control.runtime,
        probeSsh: async () => [],
        prompter: scriptedPrompter(["2", "3", "y", "", ""], transcript),
      }),
    ).toEqual({ _tag: "ok" });
    expect(control.lines).toContain(
      "Currently: public HTTPS at mend.example.test, VS Code SSH from other machines on, T3 gateway off.",
    );
    expect(control.lines).toContain("Same as: mend server setup --t3-gateway");
    expect(serverJson(configDir)).toEqual({ ...before, t3GatewayPort: 3120 });
  });

  it("refuses to apply answers when another setup changed the install meanwhile", async () => {
    const configDir = temporaryDirectory("guided-race");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    // keep it as it is · apply
    const answers = ["1", ""];
    const control = makeRuntime({ configDir });
    const result = await serverCommand(["setup"], {
      ...control.runtime,
      prompter: async () => {
        // While the person answers, a script changes the install: the lock is not held here.
        if (answers.length === 1)
          expect(
            await serverCommand(
              ["setup", "--tenancy", "multi"],
              makeRuntime({ configDir }).runtime,
            ),
          ).toEqual({ _tag: "ok" });
        return answers.shift() ?? null;
      },
    });
    expect(result).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("The install changed while you answered"),
    });
    expect(serverJson(configDir)).toMatchObject({ tenancy: "multi" });
  });

  it("changing a private install's URL keeps SSH on loopback, in the files too (review 664-1)", async () => {
    const control = makeRuntime();
    const { configDir } = control.runtime;
    const runtime = {
      ...control.runtime,
      probeSsh: async () => [],
      localAddresses: () => ["192.168.1.20"],
    };
    expect(
      await serverCommand(
        [
          "setup",
          "--bind",
          "192.168.1.20",
          "--url",
          "http://192.168.1.20:3105",
          "--ssh-bind",
          "127.0.0.1",
          "--exposure",
          "private",
        ],
        runtime,
      ),
    ).toEqual({ _tag: "ok" });
    // change · reach · network · the same address · a new URL · SSH: enter keeps it on this
    // machine · nothing else · apply
    const lines: Array<string> = [];
    expect(
      await serverCommand(["setup"], {
        ...runtime,
        writeLine: (line) => lines.push(line),
        prompter: scriptedPrompter(["2", "1", "2", "", "http://mend.lan:3105", "", "", ""], []),
      }),
    ).toEqual({ _tag: "ok" });
    expect(lines).toContain("Same as: mend server setup --url http://mend.lan:3105");
    expect(serverJson(configDir)).toMatchObject({
      appUrl: "http://mend.lan:3105",
      bind: "192.168.1.20",
      sshBind: "127.0.0.1",
    });
    expect(readEnv(activeFile(configDir, "server.env")).get("MEND_SSH_BIND_HOST")).toBe(
      "127.0.0.1",
    );
  });

  it("the documented extra localhost origin does not block going back to this machine (review 664-2)", async () => {
    const control = makeRuntime();
    const { configDir } = control.runtime;
    const runtime = { ...control.runtime, probeSsh: async () => [] };
    expect(
      await serverCommand(
        [
          "setup",
          "--bind",
          "0.0.0.0",
          "--url",
          "http://mend-host:3105",
          "--origin",
          "http://localhost:3105",
        ],
        runtime,
      ),
    ).toEqual({ _tag: "ok" });
    // change · reach · just this machine · nothing else · apply
    expect(
      await serverCommand(["setup"], {
        ...runtime,
        prompter: scriptedPrompter(["2", "1", "1", "", ""], []),
      }),
    ).toEqual({ _tag: "ok" });
    expect(serverJson(configDir)).toMatchObject({
      bind: "127.0.0.1",
      appUrl: "http://localhost:3105",
      allowedOrigins: [],
      exposure: "loopback",
    });
  });

  it("stopping the guide changes nothing", async () => {
    const control = makeRuntime();
    expect(
      await serverCommand(["setup"], {
        ...control.runtime,
        prompter: scriptedPrompter(["2"], []),
      }),
    ).toEqual({ _tag: "ok" });
    expect(control.lines.at(-1)).toBe("Nothing changed.");
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
  });
});

/** One IPv4 interface address, as `os.networkInterfaces()` gives it. */
const v4 = (address: string, cidr: string, internal = false) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr,
});

/** What another Mend's health says: Docker Desktop's 0.27.4 in the RC on a Mac. */
const OTHER_MEND = JSON.stringify({ status: "ok", version: "0.27.4" });

/** A runtime whose random bytes are fixed, so the install's instance id is known before it runs. */
const fixedSecrets = (control: RuntimeControl): ServerSetupRuntime => ({
  ...control.runtime,
  randomBytes: (size) => Buffer.alloc(size, 7),
});
/** `instanceIdOf` of the Better Auth secret `fixedSecrets` gives: bytes 128 to 160, as hex. */
const FIXED_INSTANCE = instanceIdOf("07".repeat(32));

describe("mend server setup beside another server (the RC on a Mac with two Docker engines)", () => {
  // The same vector is in apps/api/src/instance-id.test.ts: setup and the server must agree.
  it("derives the instance id the server reports", () => {
    expect(instanceIdOf("ab".repeat(32))).toBe("95478bc04554a28d7584e2e232e451e0");
  });

  it("refuses a web port another Mend holds, naming it, before anything is pulled or written", async () => {
    const control = makeRuntime({ healthAt: { "http://127.0.0.1:3105": OTHER_MEND } });
    const asked: Array<string> = [];
    const result = await serverCommand(["setup", "--yes"], {
      ...control.runtime,
      portTaken: async (port, address) => {
        asked.push(`${address}:${port}`);
        return port === 3105 || port === 2222;
      },
    });
    expect(result).toEqual({
      _tag: "error",
      message:
        "127.0.0.1:3105, Mend's web port, is taken: another Mend, 0.27.4, answers there. 127.0.0.1:2222, workspace SSH, is taken: something else listens there. Setup changed nothing. Choose other ports with --port <n> --ssh-port <n>, or stop what holds them, then run mend server setup again.",
    });
    expect(asked).toEqual(["127.0.0.1:3105", "127.0.0.1:2222"]);
    expect(control.commands.some(([, args]) => args.includes("pull") || args.includes("up"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(control.runtime.configDir, "active"))).toBe(false);
  });

  it("checks where the ports are published, and leaves the ports its own install publishes", async () => {
    const configDir = temporaryDirectory("ports-own");
    expect(await serverCommand(["setup", "--yes"], makeRuntime({ configDir }).runtime)).toEqual({
      _tag: "ok",
    });
    const asked: Array<string> = [];
    const rerun = makeRuntime({ configDir, unreachable: ["http://10.0.0.52:3115"] });
    const taken = {
      ...rerun.runtime,
      portTaken: async (port: number, address?: string) => {
        asked.push(`${address}:${port}`);
        return true;
      },
    };
    // Its own ports: compose frees them when it recreates Mend.
    expect(await serverCommand(["setup", "--yes"], taken)).toEqual({ _tag: "ok" });
    expect(asked).toEqual([]);
    // A port it does not publish yet is checked where it is to be published.
    const moved = await serverCommand(
      ["setup", "--bind", "10.0.0.52", "--url", "http://10.0.0.52:3115", "--port", "3115"],
      taken,
    );
    expect(moved).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        "10.0.0.52:3115, Mend's web port, is taken: something else listens there.",
      ),
    });
    expect(moved).toMatchObject({ message: expect.stringContaining("with --port <n>,") });
    expect(asked).toEqual(["10.0.0.52:3115"]);
  });

  it("does not take another Mend's health for its own: another version", async () => {
    const control = makeRuntime({ healthBody: OTHER_MEND });
    const result = await serverCommand(["setup", "--yes"], control.runtime);
    expect(result).toEqual({
      _tag: "error",
      message:
        "Mend started, but http://localhost:3105/api/health is not the Mend setup just started: Mend 0.27.4 answers there, not 0.23.0. When another server holds port 3105 on this machine (another Docker engine, an older install), Docker cannot publish this one there. Choose another port with --port <n>, or stop what holds it, then run mend server setup again.",
    });
    expect(control.lines.some((line) => line.includes("is reachable at"))).toBe(false);
  });

  it("does not take another Mend's health for its own: the same version, another install", async () => {
    const other = makeRuntime({
      healthBody: JSON.stringify({ status: "ok", version: "0.23.0", instance: "f".repeat(32) }),
    });
    expect(await serverCommand(["setup", "--yes"], fixedSecrets(other))).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(
        "is not the Mend setup just started: another Mend install, 0.23.0, answers there.",
      ),
    });
    const own = makeRuntime({
      healthBody: JSON.stringify({ status: "ok", version: "0.23.0", instance: FIXED_INSTANCE }),
    });
    expect(await serverCommand(["setup", "--yes"], fixedSecrets(own))).toEqual({ _tag: "ok" });
    expect(own.lines).toContain("Mend 0.23.0 is reachable at http://localhost:3105");
  });

  it("--context chooses the engine and answers no question: the guide still asks", async () => {
    const contexts = [
      {
        Name: "desktop-linux",
        DockerEndpoint: "unix:///Users/a/.docker/run/docker.sock",
        Current: true,
      },
      {
        Name: "orbstack",
        DockerEndpoint: "unix:///Users/a/.orbstack/run/docker.sock",
        Current: false,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    const control = makeRuntime({
      platform: "darwin",
      contextList: `${contexts}\n`,
      inspectedEndpoint: "unix:///Users/a/.orbstack/run/docker.sock",
    });
    const transcript: Array<string> = [];
    const result = await serverCommand(["setup", "--context", "orbstack"], {
      ...control.runtime,
      // reach: this machine · T3: no · mirrors: keep · one organization · apply
      prompter: scriptedPrompter(["1", "", "", "", ""], transcript),
    });
    expect(result).toEqual({ _tag: "ok" });
    expect(transcript[0]).toContain("1-3 [1]: 1");
    expect(transcript.at(-1)).toBe("Apply? [Y/n] ");
    expect(serverJson(control.runtime.configDir)).toMatchObject({ dockerContext: "orbstack" });
    // The equivalent command picks the same engine.
    expect(control.lines).toContain(
      "Same as: mend server setup --exposure loopback --context orbstack",
    );

    // No terminal: refused, as with no flags at all.
    const unasked = makeRuntime();
    expect(
      await serverCommand(
        ["setup", "--context", "orbstack", "--docker-socket", "/s.sock"],
        unasked.runtime,
      ),
    ).toMatchObject({ _tag: "error", message: expect.stringMatching(/^No terminal to ask on/) });
    expect(unasked.commands).toEqual([]);
    // A bad engine flag is said before any question.
    const asked: Array<string> = [];
    expect(
      await serverCommand(["setup", "--context"], {
        ...makeRuntime().runtime,
        prompter: scriptedPrompter([], asked),
      }),
    ).toEqual({ _tag: "error", message: "--context needs a value." });
    expect(asked).toEqual([]);
  });

  it("DOCKER_CONTEXT picks a fresh install's engine; an install stays on its own", async () => {
    const configDir = temporaryDirectory("docker-context");
    const fresh = makeRuntime({ configDir });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...fresh.runtime,
        dockerContextVariable: "orbstack",
      }),
    ).toEqual({ _tag: "ok" });
    expect(serverJson(configDir)).toMatchObject({ dockerContext: "orbstack" });
    expect(fresh.lines).toContain(
      'Using Docker context "orbstack" (unix:///var/run/docker.sock), from DOCKER_CONTEXT',
    );
    const rerun = makeRuntime({ configDir, daemon: fresh.daemon });
    expect(
      await serverCommand(["setup", "--yes"], {
        ...rerun.runtime,
        dockerContextVariable: "desktop-linux",
      }),
    ).toEqual({ _tag: "ok" });
    expect(serverJson(configDir)).toMatchObject({ dockerContext: "orbstack" });
    expect(rerun.lines).toContain(
      'DOCKER_CONTEXT is "desktop-linux"; this install runs on Docker context "orbstack", where its data is, and stays there. --context moves it.',
    );
  });

  it("offers to point this machine's CLI at the server it installed", async () => {
    const control = makeRuntime({
      healthAt: { "http://localhost:3105": OTHER_MEND },
      instanceBody: '{"users":"none","registration":"open"}',
    });
    const repointed: Array<readonly [string, boolean | undefined]> = [];
    const prompts: Array<string> = [];
    expect(
      await serverCommand(
        ["setup", "--port", "3115", "--ssh-port", "2232", "--url", "http://localhost:3115"],
        {
          ...control.runtime,
          savedCliLogin: () => null,
          repointCliLogin: (_dir, url, options) => repointed.push([url, options?.keepSignIn]),
          prompter: async (prompt) => {
            prompts.push(prompt);
            return "";
          },
        },
      ),
    ).toEqual({ _tag: "ok" });
    expect(prompts).toEqual([
      "This machine's CLI points at http://localhost:3105, where another Mend, 0.27.4, answers. Point it at http://localhost:3115? [Y/n] ",
    ]);
    expect(repointed).toEqual([["http://localhost:3115", false]]);
    expect(control.lines.slice(-2)).toEqual([
      "This machine's CLI now points at http://localhost:3115.",
      "Open http://localhost:3115, create the first account, then run: mend login --url http://localhost:3115",
    ]);
  });

  it("leads with no when the CLI is signed in at another server that answers, and keeps it with --yes", async () => {
    const control = makeRuntime({ healthAt: { "http://localhost:3105": OTHER_MEND } });
    const flags = ["--port", "3115", "--ssh-port", "2232", "--url", "http://localhost:3115"];
    const repointed: Array<string> = [];
    const prompts: Array<string> = [];
    const runtime: ServerSetupRuntime = {
      ...control.runtime,
      savedCliLogin: () => ({ url: "http://localhost:3105", signedIn: true }),
      repointCliLogin: (_dir, url) => repointed.push(url),
    };
    expect(
      await serverCommand(["setup", ...flags], {
        ...runtime,
        prompter: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).toEqual({ _tag: "ok" });
    expect(prompts).toEqual([
      "This machine's CLI points at http://localhost:3105, where another Mend, 0.27.4, answers. Point it at http://localhost:3115? Its sign-in at http://localhost:3105 stays behind. [y/N] ",
    ]);
    expect(await serverCommand(["setup", "--yes", ...flags], runtime)).toEqual({ _tag: "ok" });
    expect(repointed).toEqual([]);
    // Nothing answers where it points and nothing is signed in: --yes moves it.
    const quiet = makeRuntime({ unreachable: ["http://localhost:3105"] });
    expect(
      await serverCommand(["setup", "--yes", ...flags], {
        ...quiet.runtime,
        savedCliLogin: () => null,
        repointCliLogin: (_dir, url) => repointed.push(url),
      }),
    ).toEqual({ _tag: "ok" });
    expect(repointed).toEqual(["http://localhost:3115"]);
  });

  it("writes cli.json as mend login does: a new one, or the sign-in left out when it does not carry over", () => {
    const configDir = temporaryDirectory("cli-json");
    const write = nodeServerRuntime().repointCliLogin;
    if (write === undefined) throw new Error("the node runtime points cli.json");
    const file = path.join(configDir, "cli.json");
    write(configDir, "http://localhost:3115", { keepSignIn: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ url: "http://localhost:3115" });
    expect(modeOf(file)).toBe(0o600);
    fs.writeFileSync(
      file,
      JSON.stringify({ url: "http://localhost:3105", token: "t", deviceId: "d", theme: "x" }),
    );
    write(configDir, "http://localhost:3115", { keepSignIn: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      url: "http://localhost:3115",
      theme: "x",
    });
    fs.writeFileSync(file, "{ not json");
    write(configDir, "http://localhost:3116");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("offers neither Docker's, OrbStack's nor vmnet's bridges, nor network addresses, as where people reach Mend", () => {
    expect(
      reachableAddressesOf({
        lo0: [v4("127.0.0.1", "127.0.0.1/8", true)],
        en0: [v4("192.168.1.184", "192.168.1.184/24")],
        utun4: [v4("100.64.135.118", "100.64.135.118/32")],
        bridge100: [v4("192.168.139.3", "192.168.139.3/24")],
        bridge101: [v4("192.168.97.0", "192.168.97.0/24")],
        en9: [v4("192.168.107.0", "192.168.107.0/24"), v4("10.8.0.64", "10.8.0.64/26")],
        docker0: [v4("172.17.0.1", "172.17.0.1/16")],
        vmnet8: [v4("172.16.5.1", "172.16.5.1/24")],
      }),
    ).toEqual(["192.168.1.184", "100.64.135.118"]);
  });
});
