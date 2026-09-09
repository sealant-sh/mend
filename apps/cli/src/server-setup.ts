import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { claimServerDockerVolumes, verifyServerDockerVolumes } from "./server-docker-volumes.ts";
import {
  runServerProcess,
  serverComposeArgs,
  serverProcessDeadlines,
  type ServerProcessOptions,
} from "./server-runtime.ts";
import {
  withServerStore,
  ServerStoreError,
  type ServerStore,
  type ServerStoreResult,
  type ServerGeneration,
} from "./server-store.ts";
import { cliVersion } from "./version.ts";

const CONFIG_SCHEMA_VERSION = 1;
const ASSET_CONTRACT = "mend-docker-v2";
/**
 * Contracts an existing installation may still be on. v1 bundles ran RabbitMQ and a loopback
 * registry (`MEND_RABBITMQ_PASSWORD`, `MEND_REGISTRY_PORT`); v2 bundles need neither. A v1
 * generation stays readable so `mend server upgrade` can move it to v2 without touching the
 * volume-ownership identity.
 */
const LEGACY_ASSET_CONTRACTS: ReadonlySet<string> = new Set(["mend-docker-v1"]);
const MINIMUM_DOCKER_API = "1.45";
const DEFAULT_APP_PORT = 3105;
const DEFAULT_SSH_PORT = 2222;
const DEFAULT_BIND = "127.0.0.1";
const COMPOSE_ASSET = "compose.v2.yaml";
const POSTGRES_INIT_ASSET = "postgres-init.sh";
const RELEASE_BASE = "https://github.com/sealant-sh/Mend/releases/download";
const LATEST_RELEASE_URL = "https://api.github.com/repos/sealant-sh/Mend/releases/latest";

interface CommandOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface FetchOutput {
  readonly status: number;
  readonly body: string;
  readonly error?: string;
}

/** Runtime operations for local server management; the historical name remains compatible. */
export interface ServerSetupRuntime {
  /** Directory where setup persists compose, configuration, and secrets. */
  readonly configDir: string;
  /** Host operating system reported by Node. */
  readonly platform: NodeJS.Platform;
  /** Version of this CLI, used for a fresh server pin. */
  readonly cliVersion: string;
  /** Run without a shell; enforce deadlines and await group termination; capture bounded output or stream stdout to an exclusive private file. */
  run(
    command: string,
    args: ReadonlyArray<string>,
    options?: ServerProcessOptions,
  ): Promise<CommandOutput>;
  /** Fetch text with a bounded request timeout. */
  fetchText(url: string, timeoutMs: number): Promise<FetchOutput>;
  /** Generate installation credentials once. */
  randomBytes(size: number): Buffer;
  /** Wait between advertised health probes. */
  sleep(milliseconds: number): Promise<void>;
  /** Print one progress or result line. */
  writeLine(line: string): void;
}

/** Observable result of a server command. Expected lifecycle failures do not reject. */
export type ServerCommandResult =
  | { readonly _tag: "ok" }
  | { readonly _tag: "error"; readonly message: string };

interface SetupOptions {
  readonly context: string | undefined;
  readonly version: string | undefined;
  readonly bind: string | undefined;
  readonly url: string | undefined;
  readonly origins: ReadonlyArray<string> | undefined;
  readonly appPort: number | undefined;
  readonly sshPort: number | undefined;
  readonly dockerSocket: string | undefined;
  readonly assetsDir: string | undefined;
  readonly offline: boolean;
}

/** Parsed server configuration shared by setup and lifecycle commands. */
export interface ServerConfig {
  readonly schemaVersion: number;
  readonly assetContract: string;
  readonly serverVersion: string;
  readonly dockerContext: string;
  readonly dockerEndpoint: string;
  readonly dockerSocket: string;
  readonly dockerSocketSource: "detected" | "override";
  readonly bind: string;
  readonly appUrl: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly appPort: number;
  readonly sshPort: number;
  /** Only on generations written under the v1 contract, which published a loopback registry. */
  readonly registryPort?: number;
}

interface ServerSecrets {
  readonly postgresAdminPassword: string;
  readonly mendDatabasePassword: string;
  readonly sealantDatabasePassword: string;
  /**
   * Only on installations created under the v1 contract. The identity file's bytes anchor
   * Docker volume ownership, so a value that exists is carried forward forever; new
   * installations never generate one.
   */
  readonly queuePassword?: string;
  readonly betterAuthSecret: string;
  readonly sealantCredentialsKey: string;
  readonly sealantServiceKey: string;
  readonly workspaceSshGatewayToken: string;
}

interface DockerContextRow {
  readonly name: string;
  readonly endpoint: string;
  readonly current: boolean;
}

class ServerSetupError extends Error {
  readonly _tag = "ServerSetupError" as const;
}

const setupError = (message: string): ServerSetupError => new ServerSetupError(message);

const ownFields = (value: unknown): ReadonlyMap<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return new Map(Object.entries(value));
};

const requiredString = (fields: ReadonlyMap<string, unknown>, key: string): string => {
  const value = fields.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw setupError(`Server config is corrupt: ${key} must be a non-empty string.`);
  }
  return value;
};

const requiredInteger = (fields: ReadonlyMap<string, unknown>, key: string): number => {
  const value = fields.get(key);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw setupError(`Server config is corrupt: ${key} must be an integer.`);
  }
  return value;
};

const parsePort = (value: string, flag: string): number => {
  if (!/^\d+$/.test(value)) throw setupError(`${flag} must be an integer from 1 to 65535.`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw setupError(`${flag} must be an integer from 1 to 65535.`);
  }
  return port;
};

const parseVersion = (value: string): string => {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (normalized === "latest") return normalized;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  const prerelease = match?.[4]?.split(".") ?? [];
  if (
    match === null ||
    prerelease.some((part) => !/^[0-9A-Za-z-]+$/.test(part) || /^0\d+$/.test(part))
  ) {
    throw setupError('--version must be "latest" or an exact Mend version such as 0.23.0.');
  }
  return normalized;
};

const nextFlagValue = (
  args: ReadonlyArray<string>,
  index: number,
  flag: string,
): readonly [string, number] => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw setupError(`${flag} needs a value.`);
  }
  return [value, index + 1];
};

const SETUP_FLAGS = new Set([
  "--context",
  "--version",
  "--bind",
  "--url",
  "--origin",
  "--port",
  "--ssh-port",
  "--docker-socket",
  "--assets-dir",
  "--offline",
]);

const parseSetupOptions = (args: ReadonlyArray<string>): SetupOptions => {
  const values = new Map<string, Array<string>>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (!flag.startsWith("--")) throw setupError(`Unexpected server setup argument "${flag}".`);
    if (!SETUP_FLAGS.has(flag)) throw setupError(`Unknown server setup option "${flag}".`);
    if (flag === "--offline") {
      if (values.has(flag)) throw setupError("--offline may be supplied only once.");
      values.set(flag, ["true"]);
      continue;
    }
    const [value, valueIndex] = nextFlagValue(args, index, flag);
    index = valueIndex;
    const previous = values.get(flag) ?? [];
    if (flag !== "--origin" && previous.length > 0) {
      throw setupError(`${flag} may be supplied only once.`);
    }
    previous.push(value);
    values.set(flag, previous);
  }
  const flagValue = (flag: string): string | undefined => values.get(flag)?.[0];
  const version = flagValue("--version");
  const appPort = flagValue("--port");
  const sshPort = flagValue("--ssh-port");
  const origins = values.get("--origin");
  return {
    context: flagValue("--context"),
    version: version === undefined ? undefined : parseVersion(version),
    bind: flagValue("--bind"),
    url: flagValue("--url"),
    origins: origins === undefined ? undefined : origins,
    appPort: appPort === undefined ? undefined : parsePort(appPort, "--port"),
    sshPort: sshPort === undefined ? undefined : parsePort(sshPort, "--ssh-port"),
    dockerSocket: flagValue("--docker-socket"),
    assetsDir: flagValue("--assets-dir"),
    offline: values.has("--offline"),
  };
};

const parseUrl = (input: string, label: string): URL => {
  try {
    return new URL(input);
  } catch {
    throw setupError(`${label} must be an absolute http:// or https:// URL.`);
  }
};

const parseHttpOrigin = (input: string, label: string): string => {
  if (input.trim() !== input || /[\r\n]/.test(input)) {
    throw setupError(`${label} must not contain whitespace or line breaks.`);
  }
  const parsed = parseUrl(input, label);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw setupError(
      `${label} must be an http:// or https:// origin with no credentials, path, query, or fragment.`,
    );
  }
  return parsed.origin;
};

const isLoopbackBind = (bind: string): boolean =>
  bind === "127.0.0.1" || bind === "::1" || bind.startsWith("127.");

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname.startsWith("127.");

const resolveAppUrl = (
  existing: ServerConfig | null,
  options: SetupOptions,
  appPort: number,
): string => {
  const oldLocalUrl = existing === null ? null : `http://localhost:${existing.appPort}`;
  const portChangedOnLocalhost = options.appPort !== undefined && existing?.appUrl === oldLocalUrl;
  const fallback = portChangedOnLocalhost
    ? `http://localhost:${appPort}`
    : (existing?.appUrl ?? `http://localhost:${appPort}`);
  return parseHttpOrigin(options.url ?? fallback, "--url");
};

const checkExposurePair = (bind: string, appUrl: string, requireExplicitUrl: boolean): void => {
  const bindIsLoopback = isLoopbackBind(bind);
  if (!bindIsLoopback && requireExplicitUrl) {
    throw setupError("A non-loopback --bind also requires an explicit --url.");
  }
  const appHostIsLoopback = isLoopbackHost(parseUrl(appUrl, "--url").hostname);
  if (bindIsLoopback !== appHostIsLoopback) {
    throw setupError(
      "--bind and --url must both describe localhost exposure or both describe non-local exposure.",
    );
  }
};

const validateExposure = (
  existing: ServerConfig | null,
  options: SetupOptions,
): Pick<ServerConfig, "bind" | "appUrl" | "allowedOrigins" | "appPort" | "sshPort"> => {
  const appPort = options.appPort ?? existing?.appPort ?? DEFAULT_APP_PORT;
  const sshPort = options.sshPort ?? existing?.sshPort ?? DEFAULT_SSH_PORT;
  if (appPort === sshPort) {
    throw setupError("--port and --ssh-port must use different ports.");
  }

  const bind = options.bind ?? existing?.bind ?? DEFAULT_BIND;
  if (net.isIP(bind) === 0) {
    throw setupError(
      "--bind must be a literal IPv4 or IPv6 address, such as 127.0.0.1 or 0.0.0.0.",
    );
  }
  const appUrl = resolveAppUrl(existing, options, appPort);
  checkExposurePair(bind, appUrl, options.url === undefined && existing === null);

  const requestedOrigins = options.origins?.map((origin) => parseHttpOrigin(origin, "--origin"));
  const inheritedOrigins = existing?.allowedOrigins ?? [];
  const allowedOrigins = [
    ...new Set((requestedOrigins ?? inheritedOrigins).filter((origin) => origin !== appUrl)),
  ];
  return { bind, appUrl, allowedOrigins, appPort, sshPort };
};

const parseServerConfig = (raw: string): ServerConfig => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw setupError(
      "Server config is corrupt: server.json is not valid JSON. Restore it before setup.",
    );
  }
  const fields = ownFields(decoded);
  if (fields === null)
    throw setupError("Server config is corrupt: server.json must contain an object.");
  const origins = fields.get("allowedOrigins");
  if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === "string")) {
    throw setupError("Server config is corrupt: allowedOrigins must be an array of strings.");
  }
  const serverVersion = parseVersion(requiredString(fields, "serverVersion"));
  if (serverVersion === "latest") {
    throw setupError("Server config is corrupt: serverVersion must be an exact pinned version.");
  }
  const dockerSocketSource = fields.get("dockerSocketSource");
  if (dockerSocketSource !== "detected" && dockerSocketSource !== "override") {
    throw setupError("Server config is corrupt: dockerSocketSource must be detected or override.");
  }
  const config: ServerConfig = {
    schemaVersion: requiredInteger(fields, "schemaVersion"),
    assetContract: requiredString(fields, "assetContract"),
    serverVersion,
    dockerContext: requiredString(fields, "dockerContext"),
    dockerEndpoint: requiredString(fields, "dockerEndpoint"),
    dockerSocket: parseDockerSocketPath(requiredString(fields, "dockerSocket")),
    dockerSocketSource,
    bind: requiredString(fields, "bind"),
    appUrl: parseHttpOrigin(requiredString(fields, "appUrl"), "Server config appUrl"),
    allowedOrigins: origins.map((origin) =>
      parseHttpOrigin(origin, "Server config allowedOrigins"),
    ),
    appPort: requiredInteger(fields, "appPort"),
    sshPort: requiredInteger(fields, "sshPort"),
    ...(fields.has("registryPort")
      ? { registryPort: requiredInteger(fields, "registryPort") }
      : {}),
  };
  if (
    config.schemaVersion !== CONFIG_SCHEMA_VERSION ||
    (config.assetContract !== ASSET_CONTRACT && !LEGACY_ASSET_CONTRACTS.has(config.assetContract))
  ) {
    throw setupError(
      `Server config uses unsupported contract ${config.schemaVersion}/${config.assetContract}. Upgrade the CLI before setup.`,
    );
  }
  parsePort(String(config.appPort), "Server config appPort");
  parsePort(String(config.sshPort), "Server config sshPort");
  if (config.registryPort !== undefined)
    parsePort(String(config.registryPort), "Server config registryPort");
  validateExposure(null, {
    context: undefined,
    version: undefined,
    bind: config.bind,
    url: config.appUrl,
    origins: config.allowedOrigins,
    appPort: config.appPort,
    sshPort: config.sshPort,
    dockerSocket: undefined,
    assetsDir: undefined,
    offline: false,
  });
  return config;
};

const envValue = (fields: ReadonlyMap<string, string>, key: string): string => {
  const value = fields.get(key);
  if (value === undefined || value.length === 0) {
    throw setupError(`Server secrets are corrupt: ${key} is missing or empty.`);
  }
  return value;
};

const parseSecrets = (raw: string): ServerSecrets => {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 1)
      throw setupError("Server secrets are corrupt: server.env has a malformed line.");
    const key = line.slice(0, separator);
    if (fields.has(key))
      throw setupError(`Server secrets are corrupt: ${key} appears more than once.`);
    fields.set(key, line.slice(separator + 1));
  }
  const secrets: ServerSecrets = {
    postgresAdminPassword: envValue(fields, "MEND_POSTGRES_ADMIN_PASSWORD"),
    mendDatabasePassword: envValue(fields, "MEND_DB_PASSWORD"),
    sealantDatabasePassword: envValue(fields, "SEALANT_DB_PASSWORD"),
    ...(fields.has("MEND_RABBITMQ_PASSWORD")
      ? { queuePassword: envValue(fields, "MEND_RABBITMQ_PASSWORD") }
      : {}),
    betterAuthSecret: envValue(fields, "BETTER_AUTH_SECRET"),
    sealantCredentialsKey: envValue(fields, "SEALANT_CREDENTIALS_KEY"),
    sealantServiceKey: envValue(fields, "SEALANT_SERVICE_KEY"),
    workspaceSshGatewayToken: envValue(fields, "WORKSPACE_SSH_GATEWAY_TOKEN"),
  };
  if (!/^slt_svc_[0-9a-f]{64}$/.test(secrets.sealantServiceKey)) {
    throw setupError("Server secrets are corrupt: SEALANT_SERVICE_KEY has an invalid value.");
  }
  const hexSecrets: ReadonlyArray<readonly [string, string]> = [
    ["MEND_POSTGRES_ADMIN_PASSWORD", secrets.postgresAdminPassword],
    ["MEND_DB_PASSWORD", secrets.mendDatabasePassword],
    ["SEALANT_DB_PASSWORD", secrets.sealantDatabasePassword],
    ...(secrets.queuePassword === undefined
      ? []
      : [["MEND_RABBITMQ_PASSWORD", secrets.queuePassword] as const]),
    ["WORKSPACE_SSH_GATEWAY_TOKEN", secrets.workspaceSshGatewayToken],
  ];
  for (const [name, value] of hexSecrets) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw setupError(`Server secrets are corrupt: ${name} has an invalid value.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(secrets.betterAuthSecret)) {
    throw setupError("Server secrets are corrupt: BETTER_AUTH_SECRET has an invalid value.");
  }
  if (!/^[0-9A-Za-z+/]{43}=$/.test(secrets.sealantCredentialsKey)) {
    throw setupError("Server secrets are corrupt: SEALANT_CREDENTIALS_KEY has an invalid value.");
  }
  return secrets;
};

const createSecrets = (runtime: ServerSetupRuntime): ServerSecrets => {
  const bytes = runtime.randomBytes(256);
  if (bytes.length !== 256)
    throw setupError("Secure random source returned the wrong number of bytes.");
  const hex = (offset: number): string => bytes.subarray(offset, offset + 32).toString("hex");
  return {
    postgresAdminPassword: hex(0),
    mendDatabasePassword: hex(32),
    sealantDatabasePassword: hex(64),
    betterAuthSecret: hex(128),
    sealantCredentialsKey: bytes.subarray(160, 192).toString("base64"),
    sealantServiceKey: `slt_svc_${hex(192)}`,
    workspaceSshGatewayToken: hex(224),
  };
};

const parseContextRows = (raw: string): ReadonlyArray<DockerContextRow> => {
  const rows: Array<DockerContextRow> = [];
  for (const line of raw.split("\n").filter((candidate) => candidate.trim() !== "")) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw setupError("Docker returned an unreadable context list.");
    }
    const fields = ownFields(decoded);
    if (fields === null) throw setupError("Docker returned an unreadable context list.");
    const name = fields.get("Name");
    const endpoint = fields.get("DockerEndpoint");
    const current = fields.get("Current");
    if (typeof name !== "string" || typeof endpoint !== "string") {
      throw setupError("Docker returned a context with no name or endpoint.");
    }
    rows.push({ name, endpoint, current: current === true || current === "true" });
  }
  return rows;
};

const localUnixEndpoint = (endpoint: string): boolean => endpoint.startsWith("unix:///");

const commandFailure = (label: string, output: CommandOutput): ServerSetupError => {
  const detail = output.stderr.trim() || output.error || `exit ${output.status ?? "unknown"}`;
  return setupError(`${label}: ${detail}`);
};

const selectDockerContext = async (
  runtime: ServerSetupRuntime,
  requested: string | undefined,
): Promise<{ readonly name: string; readonly endpoint: string }> => {
  if (requested !== undefined) {
    const inspect = await runtime.run("docker", [
      "context",
      "inspect",
      requested,
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
    if (inspect.status !== 0)
      throw commandFailure(`Docker context "${requested}" is unavailable`, inspect);
    const endpoint = inspect.stdout.trim();
    if (!localUnixEndpoint(endpoint)) {
      throw setupError(
        `Docker context "${requested}" uses ${endpoint || "an unknown endpoint"}. Mend server setup supports local Unix-socket contexts only; remote SSH/TCP daemons would make the advertised health check report the wrong machine.`,
      );
    }
    return { name: requested, endpoint };
  }

  const listed = await runtime.run("docker", ["context", "ls", "--format", "{{json .}}"]);
  if (listed.status !== 0) throw commandFailure("Docker contexts are unavailable", listed);
  const local = parseContextRows(listed.stdout).filter((row) => localUnixEndpoint(row.endpoint));
  const selected =
    local.find((row) => row.current) ??
    local.find((row) => row.name === "orbstack") ??
    local.find((row) => row.name === "desktop-linux") ??
    local.find((row) => row.name === "default") ??
    (local.length === 1 ? local[0] : undefined);
  if (selected === undefined) {
    throw setupError(
      local.length === 0
        ? "No local Unix-socket Docker context was found. Start Docker Desktop, OrbStack, or a local Docker Engine, then retry."
        : `Several local Docker contexts are available (${local.map((row) => row.name).join(", ")}). Choose one with --context.`,
    );
  }
  return { name: selected.name, endpoint: selected.endpoint };
};

const compareApiVersions = (left: string, right: string): number => {
  const parts = (value: string): readonly [number, number] => {
    const match = /^(\d+)\.(\d+)$/.exec(value);
    if (match === null) throw setupError(`Docker reported an invalid API version "${value}".`);
    return [Number(match[1]), Number(match[2])];
  };
  const [leftMajor, leftMinor] = parts(left);
  const [rightMajor, rightMinor] = parts(right);
  return leftMajor === rightMajor ? leftMinor - rightMinor : leftMajor - rightMajor;
};

const checkDocker = async (runtime: ServerSetupRuntime, context: string): Promise<string> => {
  const version = await runtime.run("docker", [
    "--context",
    context,
    "version",
    "--format",
    "{{.Client.APIVersion}} {{.Server.APIVersion}}",
  ]);
  if (version.status !== 0) {
    throw commandFailure(`Docker context "${context}" cannot reach its daemon`, version);
  }
  const [clientApi, serverApi, extra] = version.stdout.trim().split(/\s+/);
  if (clientApi === undefined || serverApi === undefined || extra !== undefined) {
    throw setupError("Docker returned unreadable client/server API versions.");
  }
  if (
    compareApiVersions(clientApi, MINIMUM_DOCKER_API) < 0 ||
    compareApiVersions(serverApi, MINIMUM_DOCKER_API) < 0
  ) {
    throw setupError(
      `Docker API >= ${MINIMUM_DOCKER_API} is required (client ${clientApi}, server ${serverApi}). Update Docker before setup.`,
    );
  }
  const compose = await runtime.run("docker", [
    "--context",
    context,
    "compose",
    "version",
    "--short",
  ]);
  if (compose.status !== 0 || compose.stdout.trim() === "") {
    throw commandFailure("Docker Compose v2 plugin is required", compose);
  }
  const info = await runtime.run("docker", [
    "--context",
    context,
    "info",
    "--format",
    "{{.OperatingSystem}}",
  ]);
  if (info.status !== 0 || info.stdout.trim() === "") {
    throw commandFailure("Could not identify the Docker runtime; check the selected context", info);
  }
  return info.stdout.trim();
};

const resolveLatestVersion = async (runtime: ServerSetupRuntime): Promise<string> => {
  runtime.writeLine("Resolving the latest Mend server release");
  const response = await runtime.fetchText(LATEST_RELEASE_URL, 15_000);
  if (response.error !== undefined || response.status !== 200) {
    throw setupError(
      `Could not resolve the latest Mend server release: ${response.error ?? `HTTP ${response.status}`}.`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(response.body);
  } catch {
    throw setupError(
      "Could not resolve the latest Mend server release: GitHub returned invalid JSON.",
    );
  }
  const fields = ownFields(decoded);
  const tag = fields?.get("tag_name");
  if (typeof tag !== "string") {
    throw setupError("Could not resolve the latest Mend server release: tag_name is missing.");
  }
  const version = parseVersion(tag);
  if (version === "latest") throw setupError("GitHub returned an invalid latest release tag.");
  return version;
};

const validateComposeAsset = (body: string): void => {
  const [, afterServices = ""] = body.split(/^services:\s*$/m);
  const [servicesBlock = ""] = afterServices.split(/^\S/m);
  const serviceNames = [...servicesBlock.matchAll(/^ {2}([0-9A-Za-z_-]+):\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== undefined)
    .toSorted((left, right) => left.localeCompare(right));
  // This is the release template contract, not a general YAML parser. Accept only the two
  // explicit external declarations; reject duplicate sections, aliases and extra volume options.
  const volumeSections = body.split(/^volumes:[ \t]*$/m);
  const volumeBlock = (volumeSections[1] ?? "").split(/^\S/m)[0] ?? "";
  const volumeDeclarations = [
    ...volumeBlock.matchAll(/^ {2}([\w-]+):[^\n]*\n((?:(?: {4}[^\n]*|[ \t]*(?:#[^\n]*)?)\n)*)/gm),
  ];
  for (const [name, variable] of [
    ["mend-store", "MEND_STORE_VOLUME_NAME"],
    ["mend-control", "MEND_CONTROL_VOLUME_NAME"],
  ]) {
    const declarations = volumeDeclarations.filter((match) => match[1] === name);
    const properties = (declarations[0]?.[2] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (
      volumeSections.length !== 2 ||
      [...body.matchAll(/^volumes:/gm)].length !== 1 ||
      declarations.length !== 1 ||
      declarations[0]?.[0].split("\n")[0] !== `  ${name}:` ||
      properties.length !== 2 ||
      !properties.includes("external: true") ||
      !properties.includes(`name: \${${variable}:-${name}}`)
    ) {
      throw setupError(
        `Downloaded ${COMPOSE_ASSET} must declare ${name} as external: true with its canonical name. Use release assets with the Docker volume ownership contract.`,
      );
    }
  }
  const requiredFragments = [
    "name: mend",
    "image: postgres:17-alpine",
    "MEND_IMAGE_REPOSITORY",
    "MEND_VERSION",
    "DOCKER_SOCKET_PATH",
    ":/var/run/docker.sock",
    "services:",
    "  mend:",
    "  postgres:",
    "mend-store:",
    "mend-control:",
    "mend-config:",
    "mend-ssh:",
    "mend-postgres:",
    "/var/lib/mend/store",
    "/run/sealant/sockets",
  ];
  if (
    requiredFragments.some((fragment) => !body.includes(fragment)) ||
    serviceNames.join(",") !== "mend,postgres"
  ) {
    throw setupError(`Downloaded ${COMPOSE_ASSET} does not implement ${ASSET_CONTRACT}.`);
  }
};

const validatePostgresAsset = (body: string): void => {
  if (
    !body.startsWith("#!/bin/sh") ||
    !body.includes("MEND_DB_PASSWORD") ||
    !body.includes("SEALANT_DB_PASSWORD") ||
    !body.includes("CREATE ROLE mend") ||
    !body.includes("CREATE ROLE sealant") ||
    !body.includes("CREATE DATABASE mend") ||
    !body.includes("sealant_control_plane")
  ) {
    throw setupError(`Downloaded ${POSTGRES_INIT_ASSET} does not implement ${ASSET_CONTRACT}.`);
  }
};

const downloadAsset = async (
  runtime: ServerSetupRuntime,
  version: string,
  name: string,
): Promise<string> => {
  const url = `${RELEASE_BASE}/v${version}/${name}`;
  const response = await runtime.fetchText(url, 30_000);
  if (response.error !== undefined || response.status !== 200) {
    throw setupError(
      `Could not download ${name} for Mend ${version}: ${response.error ?? `HTTP ${response.status}`}.`,
    );
  }
  return response.body;
};

const renderIdentity = (secrets: ServerSecrets): string =>
  [
    `MEND_POSTGRES_ADMIN_PASSWORD=${secrets.postgresAdminPassword}`,
    `MEND_DB_PASSWORD=${secrets.mendDatabasePassword}`,
    `SEALANT_DB_PASSWORD=${secrets.sealantDatabasePassword}`,
    ...(secrets.queuePassword === undefined
      ? []
      : [`MEND_RABBITMQ_PASSWORD=${secrets.queuePassword}`]),
    `BETTER_AUTH_SECRET=${secrets.betterAuthSecret}`,
    `SEALANT_CREDENTIALS_KEY=${secrets.sealantCredentialsKey}`,
    `SEALANT_SERVICE_KEY=${secrets.sealantServiceKey}`,
    `WORKSPACE_SSH_GATEWAY_TOKEN=${secrets.workspaceSshGatewayToken}`,
    "",
  ].join("\n");

const renderSecrets = (secrets: ServerSecrets, config: ServerConfig): string => {
  const sshHost = parseUrl(config.appUrl, "Server config appUrl").hostname.replace(/^\[|\]$/g, "");
  const composeBind = net.isIP(config.bind) === 6 ? `[${config.bind}]` : config.bind;
  return [
    `MEND_VERSION=${config.serverVersion}`,
    "MEND_IMAGE_REPOSITORY=ghcr.io/sealant-sh/mend",
    ...renderIdentity(secrets).trimEnd().split("\n"),
    `APP_URL=${config.appUrl}`,
    `MEND_ALLOWED_ORIGINS=${JSON.stringify(config.allowedOrigins)}`,
    `MEND_BIND_HOST=${composeBind}`,
    `MEND_PORT=${config.appPort}`,
    `MEND_SSH_PORT=${config.sshPort}`,
    ...(config.registryPort === undefined ? [] : [`MEND_REGISTRY_PORT=${config.registryPort}`]),
    `SEALANT_SSH_HOST=${sshHost}`,
    "MEND_STORE_VOLUME_NAME=mend-store",
    "MEND_CONTROL_VOLUME_NAME=mend-control",
    `DOCKER_SOCKET_PATH=${config.dockerSocket}`,
    "",
  ].join("\n");
};

const storeValue = <T>(result: ServerStoreResult<T>): T => {
  if (result._tag === "error") throw result.error;
  return result.value;
};

/** Parsed active deployment. Credentials remain in private files, not the lifecycle result. */
export interface ServerInstallation {
  readonly config: ServerConfig;
  readonly directory: string;
}

/** Read and validate a complete active generation while holding the lifecycle lock. */
export const readServerInstallation = (
  store: ServerStore,
): ServerStoreResult<ServerInstallation | null> => {
  try {
    const generation = storeValue(store.readActive());
    if (generation === null) return { _tag: "ok", value: null };
    const config = parseServerConfig(generation.files.config);
    const secrets = parseSecrets(generation.files.env);
    if (
      generation.files.env !== renderSecrets(secrets, config) ||
      generation.files.identity !== renderIdentity(secrets)
    ) {
      throw setupError(
        "Server secrets are corrupt: server.env does not match the persisted server config and identity.",
      );
    }
    validateComposeAsset(generation.files.compose);
    validatePostgresAsset(generation.files.postgresInit);
    return { _tag: "ok", value: { config, directory: generation.directory } };
  } catch (cause) {
    return {
      _tag: "error",
      error: new ServerStoreError(
        cause instanceof Error ? cause.message : "Could not read server installation.",
      ),
    };
  }
};

const persistSetup = (
  store: ServerStore,
  config: ServerConfig,
  secrets: ServerSecrets,
  assets: { readonly compose: string; readonly postgresInit: string },
): ServerGeneration =>
  storeValue(
    store.prepare({
      identity: renderIdentity(secrets),
      config: `${JSON.stringify(config, null, 2)}\n`,
      env: renderSecrets(secrets, config),
      ...assets,
    }),
  );

const probeHealth = async (
  runtime: ServerSetupRuntime,
  appUrl: string,
  expectedVersion: string,
): Promise<void> => {
  const healthUrl = `${appUrl}/api/health`;
  let lastFailure = "request did not complete";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await runtime.fetchText(healthUrl, 2_000);
    lastFailure = response.error ?? `HTTP ${response.status}`;
    if (response.error === undefined && response.status >= 200 && response.status < 300) {
      try {
        const decoded: unknown = JSON.parse(response.body);
        const fields = ownFields(decoded);
        if (fields?.get("status") === "ok" && fields.get("version") === expectedVersion) return;
        lastFailure = `health response must report status ok and version ${expectedVersion}`;
      } catch {
        lastFailure = "health response is not valid JSON";
      }
    }
    if (attempt % 10 === 0) runtime.writeLine(`Waiting for ${healthUrl} (${lastFailure})`);
    if (attempt < 29) await runtime.sleep(2_000);
  }
  throw setupError(
    `Mend started, but ${healthUrl} did not answer successfully (${lastFailure}). Check the Mend container logs in Docker, then retry mend server setup.`,
  );
};

const resolveServerVersion = async (
  runtime: ServerSetupRuntime,
  options: SetupOptions,
  existing: ServerConfig | null,
): Promise<string> => {
  if (existing === null && options.assetsDir !== undefined && options.version === undefined) {
    throw setupError("A fresh --assets-dir setup requires an explicit --version.");
  }
  const requested = options.version ?? existing?.serverVersion ?? runtime.cliVersion;
  if (options.offline && requested === "latest") {
    throw setupError("--offline requires an exact --version, not latest.");
  }
  const version =
    requested === "latest" ? await resolveLatestVersion(runtime) : parseVersion(requested);
  if (version === "latest" || version === "unknown") {
    throw setupError("A fresh setup needs a released CLI version or an explicit --version.");
  }
  return version;
};

const parseDockerSocketPath = (socket: string): string => {
  if (!path.isAbsolute(socket) || /[\r\n$'"#:\\]/.test(socket)) {
    throw setupError(
      "--docker-socket must be an absolute path without line breaks or Compose interpolation characters.",
    );
  }
  return socket;
};

const resolveDockerSocket = (
  runtime: ServerSetupRuntime,
  options: SetupOptions,
  existing: ServerConfig | null,
  selectedContext: {
    readonly name: string;
    readonly endpoint: string;
    readonly operatingSystem: string;
  },
): Pick<ServerConfig, "dockerSocket" | "dockerSocketSource"> => {
  const contextWasReplaced =
    options.context !== undefined &&
    existing !== null &&
    options.context !== existing.dockerContext;
  let endpointSocket: string;
  try {
    endpointSocket = decodeURIComponent(new URL(selectedContext.endpoint).pathname);
  } catch {
    throw setupError(`Docker context "${selectedContext.name}" returned an invalid Unix endpoint.`);
  }
  const override =
    options.dockerSocket ??
    (!contextWasReplaced && existing?.dockerSocketSource === "override"
      ? existing.dockerSocket
      : undefined);
  const detected =
    runtime.platform === "darwin" ||
    selectedContext.operatingSystem === "Docker Desktop" ||
    selectedContext.name === "desktop-linux"
      ? "/var/run/docker.sock"
      : endpointSocket;
  return {
    dockerSocket: parseDockerSocketPath(override ?? detected),
    dockerSocketSource: override === undefined ? "detected" : "override",
  };
};

const resolveAssets = async (
  runtime: ServerSetupRuntime,
  serverVersion: string,
  existing: ServerInstallation | null,
  store: ServerStore,
  options: SetupOptions,
): Promise<{ readonly compose: string; readonly postgresInit: string }> => {
  if (options.assetsDir !== undefined) {
    try {
      const [compose, postgresInit] = await Promise.all([
        readFile(path.join(options.assetsDir, COMPOSE_ASSET), "utf8"),
        readFile(path.join(options.assetsDir, POSTGRES_INIT_ASSET), "utf8"),
      ]);
      validateComposeAsset(compose);
      validatePostgresAsset(postgresInit);
      return { compose, postgresInit };
    } catch (cause) {
      if (cause instanceof ServerSetupError) throw cause;
      throw setupError(
        "Could not read release assets from --assets-dir. Supply compose.v2.yaml and postgres-init.sh.",
      );
    }
  }
  if (
    existing?.config.serverVersion === serverVersion &&
    existing.config.assetContract === ASSET_CONTRACT
  ) {
    const generation = storeValue(store.readActive());
    if (generation !== null)
      return { compose: generation.files.compose, postgresInit: generation.files.postgresInit };
  }
  if (options.offline)
    throw setupError("--offline needs --assets-dir or the retained assets for this exact version.");
  runtime.writeLine(`Downloading release assets for Mend ${serverVersion}`);
  const [compose, postgresInit] = await Promise.all([
    downloadAsset(runtime, serverVersion, COMPOSE_ASSET),
    downloadAsset(runtime, serverVersion, POSTGRES_INIT_ASSET),
  ]);
  validateComposeAsset(compose);
  validatePostgresAsset(postgresInit);
  return { compose, postgresInit };
};

const inspectImage = async (
  runtime: ServerSetupRuntime,
  context: string,
  image: string,
  format: string,
  policy: "local" | "pull-missing",
): Promise<CommandOutput> => {
  const args = ["--context", context, "image", "inspect", image, "--format", format];
  const inspected = await runtime.run("docker", args);
  if (inspected.status === 0 || policy === "local") return inspected;
  // Docker renders its own layer progress on the terminal; a silent pull looks like a hang.
  runtime.writeLine(`Pulling ${image}`);
  const pulled = await runtime.run("docker", ["--context", context, "pull", image], {
    timeoutMs: serverProcessDeadlines.pull,
    stdout: "inherit",
  });
  if (pulled.status !== 0) throw commandFailure(`Could not pull ${image}`, pulled);
  return runtime.run("docker", args);
};

const checkLocalImages = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
  policy: "local" | "pull-missing" = "local",
): Promise<void> => {
  const image = `ghcr.io/sealant-sh/mend:${config.serverVersion}`;
  const mend = await inspectImage(
    runtime,
    config.dockerContext,
    image,
    '{{index .Config.Labels "org.opencontainers.image.version"}}',
    policy,
  );
  if (mend.status !== 0) throw commandFailure(`Preload ${image} before continuing`, mend);
  if (mend.stdout.trim() !== config.serverVersion) {
    throw setupError(
      `Image ${image} must carry org.opencontainers.image.version=${config.serverVersion}.`,
    );
  }
  const postgres = await inspectImage(
    runtime,
    config.dockerContext,
    "postgres:17-alpine",
    "{{.Id}}",
    policy,
  );
  if (postgres.status !== 0)
    throw commandFailure("Preload postgres:17-alpine before continuing", postgres);
};

const checkComposeImages = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  const output = await runtime.run(
    "docker",
    serverComposeArgs(
      { directory: installation.directory, dockerContext: installation.config.dockerContext },
      ["config", "--images"],
    ),
  );
  if (output.status !== 0) throw commandFailure("Docker Compose config failed", output);
  const images = output.stdout.trim().split(/\s+/).toSorted();
  const expected = [
    `ghcr.io/sealant-sh/mend:${installation.config.serverVersion}`,
    "postgres:17-alpine",
  ].toSorted();
  if (images.join("\n") !== expected.join("\n")) {
    throw setupError(
      "Compose must use only the canonical pinned Mend image and official postgres:17-alpine.",
    );
  }
};

const startingNotice = (runtime: ServerSetupRuntime, version: string): void =>
  runtime.writeLine(
    `Starting Mend ${version} containers; Docker waits up to ${serverProcessDeadlines.composeWaitSeconds}s for them to report healthy`,
  );

const startCompose = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
  generation: ServerGeneration,
): Promise<void> => {
  startingNotice(runtime, config.serverVersion);
  const compose = await runtime.run(
    "docker",
    serverComposeArgs({ directory: generation.directory, dockerContext: config.dockerContext }, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(serverProcessDeadlines.composeWaitSeconds),
      "--pull",
      "never",
      "--no-build",
    ]),
    { timeoutMs: serverProcessDeadlines.startup },
  );
  if (compose.status !== 0) throw commandFailure("Mend containers did not start", compose);
};

const setupServer = async (
  args: ReadonlyArray<string>,
  runtime: ServerSetupRuntime,
  store: ServerStore,
): Promise<void> => {
  if (runtime.platform !== "linux" && runtime.platform !== "darwin") {
    throw setupError(`mend server setup supports Linux and macOS, not ${runtime.platform}.`);
  }
  const options = parseSetupOptions(args);
  const existing = storeValue(readServerInstallation(store));
  const savedIdentity = storeValue(store.readIdentity());
  const savedSecrets = savedIdentity === null ? null : parseSecrets(savedIdentity);
  if (
    existing !== null &&
    options.version !== undefined &&
    options.version !== existing.config.serverVersion
  ) {
    throw setupError(
      `Setup retains Mend ${existing.config.serverVersion}. Use mend server upgrade --version ${options.version} to change the server pin.`,
    );
  }
  if (existing !== null && existing.config.assetContract !== ASSET_CONTRACT) {
    throw setupError(
      `Mend ${existing.config.serverVersion} was installed under the ${existing.config.assetContract} bundle contract. Use mend server upgrade --version latest to move it to ${ASSET_CONTRACT}; setup cannot repair it in place.`,
    );
  }
  const selectedContext = await selectDockerContext(
    runtime,
    options.context ?? existing?.config.dockerContext,
  );
  const operatingSystem = await checkDocker(runtime, selectedContext.name);
  runtime.writeLine(`Using Docker context "${selectedContext.name}" (${selectedContext.endpoint})`);

  const serverVersion = await resolveServerVersion(runtime, options, existing?.config ?? null);
  const config: ServerConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    assetContract: ASSET_CONTRACT,
    serverVersion,
    dockerContext: selectedContext.name,
    dockerEndpoint: selectedContext.endpoint,
    ...resolveDockerSocket(runtime, options, existing?.config ?? null, {
      ...selectedContext,
      operatingSystem,
    }),
    ...validateExposure(existing?.config ?? null, options),
  };
  const assets = await resolveAssets(runtime, serverVersion, existing, store, options);
  const secrets = savedSecrets ?? createSecrets(runtime);
  const generation = persistSetup(store, config, secrets, assets);
  await checkComposeImages(runtime, { directory: generation.directory, config });
  const ownership = await claimServerDockerVolumes(runtime, {
    dockerContext: config.dockerContext,
    identityBytes: Buffer.from(generation.files.identity),
  });
  if (ownership._tag === "error") throw setupError(ownership.error.message);
  await checkLocalImages(runtime, config, options.offline ? "local" : "pull-missing");
  storeValue(store.activate(generation));
  await startCompose(runtime, config, generation);
  await probeHealth(runtime, config.appUrl, config.serverVersion);
  runtime.writeLine(`Mend ${config.serverVersion} is reachable at ${config.appUrl}`);
  runtime.writeLine(
    `Open ${config.appUrl}, create the first account, then run: mend login --url ${config.appUrl}`,
  );
};

const serverVersionParts = (version: string) => {
  const separator = version.indexOf("-");
  return {
    core: (separator < 0 ? version : version.slice(0, separator)).split("."),
    pre: separator < 0 ? [] : version.slice(separator + 1).split("."),
  };
};

const compareNumericIdentifiers = (x: string, y: string): number => {
  if (BigInt(x) === BigInt(y)) return 0;
  return BigInt(x) < BigInt(y) ? -1 : 1;
};

const compareServerVersions = (left: string, right: string): number => {
  const a = serverVersionParts(left);
  const b = serverVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumericIdentifiers(a.core[index] ?? "0", b.core[index] ?? "0");
    if (order !== 0) return order;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined || y === undefined) {
      if (x === y) return 0;
      return x === undefined ? -1 : 1;
    }
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumericIdentifiers(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

const composeCommand = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  args: ReadonlyArray<string>,
): Promise<CommandOutput> => {
  const output = await runtime.run(
    "docker",
    serverComposeArgs(
      { directory: installation.directory, dockerContext: installation.config.dockerContext },
      args.flatMap((arg) =>
        arg === "--wait"
          ? [arg, "--wait-timeout", String(serverProcessDeadlines.composeWaitSeconds)]
          : [arg],
      ),
    ),
    {
      timeoutMs:
        args[0] === "up"
          ? serverProcessDeadlines.startup
          : args[0] === "stop"
            ? serverProcessDeadlines.stop
            : serverProcessDeadlines.ordinary,
    },
  );
  if (output.status !== 0 || output.error !== undefined)
    throw commandFailure(`Docker Compose ${args[0] ?? "command"} failed`, output);
  return output;
};

const interruptionNotice = (runtime: ServerSetupRuntime): void =>
  runtime.writeLine(
    "Connections will be interrupted. Workspace containers and data are retained, but active work can lose connectivity and may need reconnection. Mend does not stop workspace containers.",
  );

const startInstallation = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  startingNotice(runtime, installation.config.serverVersion);
  await composeCommand(runtime, installation, [
    "up",
    "-d",
    "--wait",
    "--pull",
    "never",
    "--no-build",
  ]);
  await probeHealth(runtime, installation.config.appUrl, installation.config.serverVersion);
  runtime.writeLine(
    `Mend ${installation.config.serverVersion} is reachable at ${installation.config.appUrl}`,
  );
};

const parseUpgradeOptions = (args: ReadonlyArray<string>): SetupOptions => {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--offline") continue;
    if (flag !== "--version" && flag !== "--assets-dir")
      throw setupError(`Unknown server upgrade option "${flag}".`);
    index += 1;
  }
  const options = parseSetupOptions(args);
  if (options.version === undefined)
    throw setupError(
      "Upgrade requires --version TARGET. Use --version latest only to request the latest release explicitly.",
    );
  return options;
};

const upgradeServer = async (
  args: ReadonlyArray<string>,
  runtime: ServerSetupRuntime,
  store: ServerStore,
  existing: ServerInstallation,
): Promise<void> => {
  const options = parseUpgradeOptions(args);
  const version = await resolveServerVersion(runtime, options, existing.config);
  const order = compareServerVersions(version, existing.config.serverVersion);
  if (order < 0)
    throw setupError(
      `Refusing downgrade from ${existing.config.serverVersion} to ${version}. Database migrations may not be reversible.`,
    );
  if (order === 0) {
    runtime.writeLine(
      `Mend is already pinned to ${version}. Use mend server start to retry startup; no upgrade was performed.`,
    );
    return;
  }
  const previous = storeValue(store.readActive());
  if (previous === null) throw setupError("The active server generation is missing.");
  const assets = await resolveAssets(runtime, version, existing, store, options);
  // The target generation is always on the current contract: a v1 install loses its registry
  // port here (v2 bundles publish none) while its identity, and so its volume ownership, is
  // carried over byte for byte.
  const { registryPort: _legacyRegistryPort, ...carried } = existing.config;
  const config: ServerConfig = {
    ...carried,
    assetContract: ASSET_CONTRACT,
    serverVersion: version,
  };
  const secrets = parseSecrets(previous.files.identity);
  const files = {
    identity: previous.files.identity,
    config: `${JSON.stringify(config, null, 2)}\n`,
    env: renderSecrets(secrets, config),
    ...assets,
  };
  // Parse the proposed pair before publication. Identity bytes come only from the old generation.
  const parsed = parseServerConfig(files.config);
  if (renderSecrets(parseSecrets(files.env), parsed) !== files.env)
    throw setupError("Invalid upgrade configuration.");
  await checkLocalImages(runtime, config, options.offline ? "local" : "pull-missing");
  await checkComposeImages(runtime, existing);
  const target = storeValue(store.prepare(files));
  const installation = { directory: target.directory, config };
  await checkComposeImages(runtime, installation);
  const running = await composeCommand(runtime, existing, [
    "ps",
    "--status",
    "running",
    "--services",
  ]);
  const appWasRunning = running.stdout.trim().split(/\s+/).includes("mend");
  const backup = storeValue(store.createBackup(previous, target));
  interruptionNotice(runtime);
  runtime.writeLine(
    `Upgrade recovery files: ${backup.directory}. Keep the previous generation: ${previous.directory}`,
  );
  try {
    await composeCommand(runtime, existing, ["stop", "--timeout", "30", "mend"]);
    await composeCommand(runtime, existing, [
      "up",
      "-d",
      "--wait",
      "--pull",
      "never",
      "--no-build",
      "postgres",
    ]);
    const dumped = await runtime.run(
      "docker",
      serverComposeArgs({ directory: previous.directory, dockerContext: config.dockerContext }, [
        "exec",
        "-T",
        "postgres",
        "pg_dumpall",
        "--username=postgres",
      ]),
      { stdoutFile: backup.partialFile, timeoutMs: serverProcessDeadlines.dump },
    );
    // Dump stderr can include SQL or credentials. Do not put it in a terminal error.
    if (dumped.status !== 0 || dumped.error !== undefined)
      throw setupError(
        "Database backup failed or timed out. The partial dump is not a usable backup.",
      );
    storeValue(backup.complete());
    storeValue(store.activate(target));
  } catch (cause) {
    // No target startup has been attempted. Even a failed activation fsync may have moved active.
    const restored = store.activate(previous);
    let recovery = "Previous pin retained; the app was already stopped.";
    if (restored._tag === "error")
      recovery =
        "Could not reselect the previous generation. Inspect active before retrying any command.";
    else if (appWasRunning) {
      try {
        await startInstallation(runtime, existing);
        recovery = "Previous pin and app recovered.";
      } catch {
        recovery =
          "Previous pin retained, but the old app could not recover. Run mend server start after fixing Docker.";
      }
    }
    const reason = cause instanceof Error ? cause.message : "Upgrade preparation failed.";
    throw setupError(
      `${reason} ${recovery} Recovery files: ${backup.directory}. Target startup was not attempted.`,
    );
  }
  // Activation is the write-ahead boundary: after this point assume migrations may have run.
  // Never select the old generation or restore its database in response to any startup failure.
  try {
    await startInstallation(runtime, installation);
  } catch {
    throw setupError(
      `Mend ${version} startup, exact-version health or registry verification failed; migrations may have begun. The target pin remains active. Do NOT downgrade or restore the database automatically. Run mend server logs --tail 100 and mend server status; fix the target, then mend server start --offline. Previous generation: ${previous.directory}. Target generation: ${target.directory}. Database backup and recovery record: ${backup.directory}.`,
    );
  }
  runtime.writeLine(`Upgraded to ${version}. Retained database backup: ${backup.directory}`);
};

const serverStatus = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  runtime.writeLine(
    `Pinned Mend ${installation.config.serverVersion} at ${installation.config.appUrl}`,
  );
  runtime.writeLine(`Active generation: ${installation.directory}`);
  const state = await composeCommand(runtime, installation, ["ps", "--all"]);
  runtime.writeLine(state.stdout.trim() || "No Compose containers found. Run mend server start.");
  const running = await composeCommand(runtime, installation, [
    "ps",
    "--status",
    "running",
    "--services",
  ]);
  if (!running.stdout.trim().split(/\s+/).includes("mend")) {
    runtime.writeLine("Mend is stopped. No health claim was made.");
    return;
  }
  const response = await runtime.fetchText(`${installation.config.appUrl}/api/health`, 2_000);
  let fields: ReadonlyMap<string, unknown> | null = null;
  try {
    fields = ownFields(JSON.parse(response.body));
  } catch {
    /* Invalid health is not readiness. */
  }
  if (
    response.error !== undefined ||
    response.status < 200 ||
    response.status >= 300 ||
    fields?.get("status") !== "ok" ||
    fields.get("version") !== installation.config.serverVersion
  ) {
    throw setupError(
      `Mend is running but exact-version health for ${installation.config.serverVersion} was not observed. Check mend server logs --tail 100.`,
    );
  }
  runtime.writeLine(
    `Mend ${installation.config.serverVersion} is reachable at ${installation.config.appUrl}`,
  );
};

const manageServer = async (
  command: string,
  args: ReadonlyArray<string>,
  runtime: ServerSetupRuntime,
  store: ServerStore,
): Promise<void> => {
  const installation = storeValue(readServerInstallation(store));
  if (installation === null)
    throw setupError(
      "No Mend server is configured. Run mend server setup explicitly to install one.",
    );
  // Lifecycle commands only verify. Missing volumes must never become allocation permission.
  const identity = storeValue(store.readIdentity());
  if (identity === null) throw setupError("The persisted server identity is missing.");
  const ownership = await verifyServerDockerVolumes(runtime, {
    dockerContext: installation.config.dockerContext,
    identityBytes: Buffer.from(identity),
  });
  if (ownership._tag === "error") throw setupError(ownership.error.message);
  if (command === "upgrade") return upgradeServer(args, runtime, store, installation);
  if (command === "logs") {
    let tail = 100;
    if (args.length > 0) tail = args.length === 2 && args[0] === "--tail" ? Number(args[1]) : NaN;
    if (
      !Number.isInteger(tail) ||
      tail < 1 ||
      tail > 1000 ||
      (args[1] !== undefined && !/^\d+$/.test(args[1]))
    ) {
      throw setupError(
        "usage: mend server logs [--tail N], where N is 1..1000. Follow is not supported.",
      );
    }
    const output = await composeCommand(runtime, installation, [
      "logs",
      "--no-color",
      "--tail",
      String(tail),
    ]);
    runtime.writeLine(output.stdout.trimEnd());
    if (output.stderr !== "") runtime.writeLine(output.stderr.trimEnd());
    return;
  }
  if (
    args.length !== 0 &&
    !(
      (command === "start" || command === "restart") &&
      args.length === 1 &&
      args[0] === "--offline"
    )
  ) {
    throw setupError(
      `usage: mend server ${command}${command === "start" || command === "restart" ? " [--offline]" : ""}`,
    );
  }
  if (command === "status") return serverStatus(runtime, installation);
  if (command === "stop") {
    interruptionNotice(runtime);
    await composeCommand(runtime, installation, ["stop", "--timeout", "30"]);
    runtime.writeLine(
      "Mend and Postgres stopped. Volumes, configuration and workspace containers are retained.",
    );
    return;
  }
  await checkLocalImages(runtime, installation.config);
  if (command === "restart") {
    interruptionNotice(runtime);
    await composeCommand(runtime, installation, ["stop", "--timeout", "30", "mend"]);
  }
  await startInstallation(runtime, installation);
};

/** Capture host configuration once; all child commands use the controlled server environment. */
export const nodeServerRuntime = (): ServerSetupRuntime => {
  const environment = { ...process.env };
  const home = os.homedir();
  const configHome = environment["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
  return {
    configDir: path.join(configHome, "mend"),
    platform: process.platform,
    cliVersion: cliVersion(),
    run: (command, args, options) => runServerProcess(command, args, environment, options),
    fetchText: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return { status: response.status, body: await response.text() };
      } catch (cause) {
        return {
          status: 0,
          body: "",
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    randomBytes,
    sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    writeLine: (line) => process.stdout.write(`${line}\n`),
  };
};

/** Compatibility name for callers predating the lifecycle command family. */
export const nodeServerSetupRuntime = nodeServerRuntime;

/** Run the `mend server` command family through a supplied or real runtime. */
export const serverCommand = async (
  args: ReadonlyArray<string>,
  runtime: ServerSetupRuntime = nodeServerRuntime(),
): Promise<ServerCommandResult> => {
  const [command, ...rest] = args;
  if (
    command === undefined ||
    !["setup", "status", "start", "stop", "restart", "logs", "upgrade"].includes(command)
  ) {
    return {
      _tag: "error",
      message: "usage: mend server <setup|status|start|stop|restart|logs|upgrade> [options]",
    };
  }
  try {
    const result = await withServerStore(
      runtime.configDir,
      async (store) => {
        if (command === "setup") await setupServer(rest, runtime, store);
        else await manageServer(command, rest, runtime, store);
      },
      { create: command === "setup" },
    );
    return result._tag === "error"
      ? { _tag: "error", message: result.error.message }
      : { _tag: "ok" };
  } catch (cause) {
    if (cause instanceof ServerSetupError) return { _tag: "error", message: cause.message };
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { _tag: "error", message: `Server command failed unexpectedly: ${detail}` };
  }
};
