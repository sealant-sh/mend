import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { managedWorkspaceSshBlock, parseWorkspaceSshTarget } from "@mend/workspace-ssh";
import { expect } from "vitest";

import type { ServerProcessOptions } from "./server-runtime.ts";
import { nodeServerRuntime, serverCommand, type ServerSetupRuntime } from "./server-setup.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";
import type { UninstallRuntime } from "./uninstall.ts";

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
  /** The host's user-namespace sysctl file: absent, written by setup, or written by hand. */
  readonly sysctl?: "absent" | "mend" | "by-hand";
  /** What uninstall's helper set back, after removing the file setup wrote. */
  readonly sysctlRestored?: ReadonlyArray<string>;
  /** Docker's build cache size, as `docker system df` prints it; absent, none. */
  readonly buildCache?: string | null;
  readonly prunedBuildCache?: boolean;
  /** The bundle's other images uninstall removed. */
  readonly removedImages?: ReadonlyArray<string>;
  /** false: the edge's Caddy image was never pulled on this daemon. */
  readonly edgeImage?: boolean;
  /** Images Docker refuses once and removes with another image of the list. */
  readonly imagesRefusedOnce?: ReadonlyArray<string>;
  /** Images a container outside the installation still runs. */
  readonly imagesInUse?: ReadonlyArray<string>;
  /** The metadata guard's busybox is on this daemon, as setup preloads it. */
  readonly guardImagePresent?: boolean;
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

const createFixture = async (cleanups: Array<() => Promise<void>>) => {
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
    // The fixture's health listener holds the web port before setup "starts" Mend there, and this
    // machine's own ports say nothing about the fixture.
    portTaken: async () => false,
    sleep: async () => undefined,
    writeLine: (line) => {
      lines.push(line);
    },
    fetchText: async (request, timeout, headers) => {
      fetched.push(request);
      // Where this machine's CLI points by default, nothing answers on the fixture's machine.
      if (request.startsWith("http://localhost:3105/"))
        return { status: 0, body: "", error: "connection refused" };
      if (request === "http://127.0.0.1:3130/") return { status: 404, body: "No such preview.\n" };
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

/** The gateway answers at its port: setup and status look there once Mend does. */
const gatewayAnswers = (f: Fixture): ServerSetupRuntime => ({
  ...f.runtime,
  fetchText: async (url: string, timeout: number, headers?: Readonly<Record<string, string>>) =>
    url.startsWith("http://127.0.0.1:3120/")
      ? { status: 200, body: '{"environmentId":"e"}' }
      : f.runtime.fetchText(url, timeout, headers),
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Add resources to the fixture daemon beside what setup made: a session's workspace, say. */
const seedDaemon = (
  f: Fixture,
  seed: Readonly<Record<string, ReadonlyArray<readonly [string, unknown]>>>,
) => {
  const file = path.join(f.root, "docker-protocol.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [kind, entries] of Object.entries(seed)) {
    saved[kind] = [...(saved[kind] ?? []), ...entries];
  }
  fs.writeFileSync(file, JSON.stringify(saved));
};

const daemonNames = (f: Fixture, kind: "volumes" | "containers" | "networks") =>
  (JSON.parse(fs.readFileSync(path.join(f.root, "docker-protocol.json"), "utf8"))[kind] ?? []).map(
    ([name]: [string]) => name,
  );

/** The block `mend ssh setup` writes for a server. */
const sshBlock = (serverUrl: string, port: number) => {
  const target = parseWorkspaceSshTarget({ serverUrl, publishedPort: port });
  if (!target.ok) throw target.error;
  const text = managedWorkspaceSshBlock(target.value, null);
  if (!text.ok) throw text.error;
  return { alias: target.value.alias, text: text.value };
};

const uninstallRuntime = (
  f: Fixture,
  options: { readonly signedIn?: string; readonly calls?: Array<string> } = {},
): UninstallRuntime => {
  const home = path.join(f.root, "home", "mend");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "cli.json"), "{}");
  const calls = options.calls ?? [];
  return {
    server: f.runtime,
    cliHome: home,
    sshConfigFile: path.join(f.root, "home", "ssh-config"),
    signedIn: options.signedIn === undefined ? null : { url: options.signedIn, deviceId: "dev-1" },
    revokeDevice: async () => {
      calls.push("revokeDevice");
      return null;
    },
    removeWorkspaceSshKey: async (): Promise<ThisMachineKeyRemoval> => {
      calls.push("removeWorkspaceSshKey");
      return { removed: ["SHA256:here"], stillActive: [], problem: null };
    },
    forgetSignIn: () => {
      calls.push("forgetSignIn");
    },
  };
};

const makeTestFixtures = () => {
  const fixture = () => createFixture(cleanups);

  const cleanups: Array<() => Promise<void>> = [];

  /**
   * server.env as 0.36.0-next.773's CLI wrote it on the owner's box (RC 5), its keys in its order,
   * frozen: the values this test's config gives. `{{KEY}}` takes this run's value: the identity's
   * secrets, what derives from them, and what the fixture picks. A later CLI that renders any of
   * the frozen lines differently calls this generation corrupt, which is what broke 773 to 780.
   */
  const FROZEN_773_ENV = [
    "MEND_VERSION=0.23.0",
    "MEND_IMAGE_REPOSITORY=ghcr.io/sealant-sh/mend",
    "MEND_POSTGRES_ADMIN_PASSWORD={{MEND_POSTGRES_ADMIN_PASSWORD}}",
    "MEND_DB_PASSWORD={{MEND_DB_PASSWORD}}",
    "SEALANT_DB_PASSWORD={{SEALANT_DB_PASSWORD}}",
    "BETTER_AUTH_SECRET={{BETTER_AUTH_SECRET}}",
    "SEALANT_CREDENTIALS_KEY={{SEALANT_CREDENTIALS_KEY}}",
    "SEALANT_SERVICE_KEY={{SEALANT_SERVICE_KEY}}",
    "WORKSPACE_SSH_GATEWAY_TOKEN={{WORKSPACE_SSH_GATEWAY_TOKEN}}",
    "APP_URL=https://mend.example.test",
    "MEND_ALLOWED_ORIGINS=[]",
    "MEND_BIND_HOST=127.0.0.1",
    "MEND_SSH_BIND_HOST=0.0.0.0",
    "MEND_PORT={{MEND_PORT}}",
    "MEND_SSH_PORT=2222",
    "SEALANT_SSH_HOST=mend.example.test",
    "MEND_EDGE_HOST=mend.example.test",
    "MEND_T3_GATEWAY_PORT=3120",
    "MEND_EXPOSURE=public",
    "MEND_TENANCY=multi",
    "MEND_SOURCE_POLICY=tenant",
    "MEND_CAPTURE_REQUIRE_SIZES=true",
    "MEND_URL_BEARERS=refuse",
    "MEND_SSH_PUBLISHED=0.0.0.0:2222",
    "MEND_EXPOSURE_DECLARED=edge-tls,workspace-ssh",
    "MEND_STORE_VOLUME_NAME=mend-store",
    "MEND_CONTROL_VOLUME_NAME=mend-control",
    "MEND_GARAGE_RPC_SECRET={{MEND_GARAGE_RPC_SECRET}}",
    "MEND_GARAGE_ADMIN_TOKEN={{MEND_GARAGE_ADMIN_TOKEN}}",
    "MEND_GARAGE_KEY_ID={{MEND_GARAGE_KEY_ID}}",
    "MEND_GARAGE_KEY_SECRET={{MEND_GARAGE_KEY_SECRET}}",
    "MEND_GARAGE_VOLUME_NAME=mend-garage",
    "MEND_NPM_MIRROR_MAX_SIZE=10g",
    "MEND_DOCKER_MIRROR_MAX_SIZE=20g",
    "DOCKER_SOCKET_PATH={{DOCKER_SOCKET_PATH}}",
    "",
  ].join("\n");

  /** compose.t3.yaml as 0.36.0-next.773 wrote it: the gateway on loopback, its port alone. */
  const FROZEN_773_T3_OVERLAY = [
    "# Written by mend server setup --t3-gateway: the t3code gateway (docs/adr/0012), its own",
    "# listener beside Mend's, published on loopback only. Reaching it from elsewhere is an",
    "# exposure the operator declares (docs/adr/0004). mend server setup --no-t3-gateway removes it.",
    "services:",
    "  mend:",
    "    environment:",
    '      MEND_T3_GATEWAY_ENABLED: "true"',
    "    ports:",
    '      - "127.0.0.1:${MEND_T3_GATEWAY_PORT:?set MEND_T3_GATEWAY_PORT in server.env}:3120"',
    "    volumes:",
    "      - mend-t3-gateway:/opt/mend-t3-gateway/state",
    "volumes:",
    "  mend-t3-gateway:",
    "",
  ].join("\n");

  /** The lines every server.env has carried, and the secret ones: never missing (server-setup.ts). */
  const FOUNDING_OR_SECRET =
    /^(MEND_VERSION|MEND_IMAGE_REPOSITORY|MEND_POSTGRES_ADMIN_PASSWORD|MEND_DB_PASSWORD|SEALANT_DB_PASSWORD|BETTER_AUTH_SECRET|SEALANT_CREDENTIALS_KEY|SEALANT_SERVICE_KEY|WORKSPACE_SSH_GATEWAY_TOKEN|APP_URL|MEND_ALLOWED_ORIGINS|MEND_BIND_HOST|MEND_PORT|MEND_SSH_PORT|MEND_REGISTRY_PORT|SEALANT_SSH_HOST|MEND_STORE_VOLUME_NAME|MEND_CONTROL_VOLUME_NAME|DOCKER_SOCKET_PATH|MEND_GARAGE_.*|MEND_DOCKER_HUB_.*)$/;

  /** One live session's workspace: it mounts the control volume and joins the project network. */
  const liveWorkspace = (f: Fixture) =>
    seedDaemon(f, {
      containers: [
        ["sealant-w1", {}],
        ["sealant-w1-docker", { "sealant.workspace": "sealant-w1" }],
      ],
      facts: [
        [
          "sealant-w1",
          {
            mounts: ["mend-control"],
            networks: ["mend_default", "sealant-w1-network"],
            state: "running",
            image: "sealant-workspace-arch:latest",
          },
        ],
        [
          "sealant-w1-docker",
          { networks: ["sealant-w1-network"], image: "docker:27.5.1-dind-rootless" },
        ],
      ],
      networks: [
        ["mend_default", { "com.docker.compose.project": "mend" }],
        ["sealant-w1-network", null],
      ],
    });

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

  const host = "mend.example.test";

  /**
   * Setup as the owner's box ran 0.36.0-next.773 (RC 5): behind the edge, public, multi tenancy,
   * SSH on every address, the gateway on, Garage and both mirrors; then the generation as 773's CLI
   * wrote it, from FROZEN_773_ENV. Returns the server.env this CLI rendered before the rewrite.
   */
  const asBoxOn773 = async (f: Fixture): Promise<string> => {
    f.update({ gatewayImages: ["0.23.0", "0.24.0"] });
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        [
          "setup",
          "--exposure",
          "public",
          "--tenancy",
          "multi",
          "--ssh-bind",
          "0.0.0.0",
          "--declare",
          "edge-tls",
          "--declare",
          "workspace-ssh",
          "--t3-gateway",
        ],
        gatewayAnswers(f),
      ),
    ).toEqual({ _tag: "ok" });
    const rendered = f.files()["server.env"] ?? "";
    const values = new Map(
      rendered
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    fs.writeFileSync(
      path.join(f.active(), "server.env"),
      FROZEN_773_ENV.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values.get(key) ?? ""),
    );
    fs.writeFileSync(path.join(f.active(), "compose.t3.yaml"), FROZEN_773_T3_OVERLAY);
    return rendered;
  };
  return {
    cleanups,
    fixture,
    repositoryFile,
    withoutMirrors,
    gatewayAnswers,
    FOUNDING_OR_SECRET,
    seedDaemon,
    daemonNames,
    liveWorkspace,
    sshBlock,
    uninstallRuntime,
    preview,
    next,
    onPreview,
    everything,
    versions,
    withVersions,
    host,
    asBoxOn773,
  };
};

/** Create the original process fixture helpers and isolated state for one test file. */
export const lifecycleTestFixtures = (): ReturnType<typeof makeTestFixtures> => makeTestFixtures();
