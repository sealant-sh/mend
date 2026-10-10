import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  HOST_USER_NAMESPACE_FILES,
  hostUserNamespacesFix,
  hostUserNamespacesOf,
} from "@mend/domain/host-user-namespaces";

import {
  type DockerDaemonFacts,
  dockerShutdownSetupLine,
  hostDockerDaemonFacts,
  readShutdownTimeout,
} from "./docker-shutdown.ts";
import { renderExposure, renderGate } from "./organization.ts";
import {
  claimServerDockerVolumes,
  MEND_DOCKER_NAMESPACE,
  MEND_DOCKER_NAMESPACE_WITH_GARAGE,
  type ServerDockerNamespace,
  verifyServerDockerVolumes,
} from "./server-docker-volumes.ts";
import {
  composeOverlays,
  declaredPostureLines,
  DEFAULT_T3_GATEWAY_PORT,
  EDGE_CADDYFILE,
  EDGE_COMPOSE_OVERLAY,
  type EdgeCertificate,
  EXPOSURES,
  type Exposure,
  healthPosture,
  DECLARABLE_ITEMS,
  type DeclarableItem,
  isDeclarableItem,
  isExposure,
  isTenancy,
  observedEdgeLine,
  observedPostureLines,
  parseEdgeHost,
  postureEnvLines,
  publishedAddress,
  renderPostureOverlay,
  renderT3GatewayOverlay,
  T3_GATEWAY_IMAGE_LABEL,
  T3_GATEWAY_VOLUME,
  type Tenancy,
  TENANCIES,
} from "./server-edge.ts";
import {
  DEFAULT_MIRRORS,
  DEFAULT_NPM_MIRROR_MAX_SIZE,
  DOCKER_MIRROR_CONTAINER,
  dockerMirrorTraffic,
  DEFAULT_DOCKER_MIRROR_MAX_SIZE,
  DOCKER_MIRROR_GUARD,
  DOCKER_MIRROR_GUARD_NAME,
  dockerMirrorLogin,
  mirrorDiskOf,
  mirrorDiskProbe,
  isDockerHubCredential,
  mirrorImagesOf,
  mirrorServices,
  mirrorsEnvLines,
  MIRRORS_COMPOSE_FILE,
  NPM_MIRROR_CONF,
  NPM_MIRROR_CONF_NAME,
  npmMirrorTraffic,
  observedDockerMirrorLine,
  observedNpmMirrorLine,
  parseMirrorSize,
  renderMirrorsOverlay,
  runsMirrors,
  type ServerMirrors,
} from "./server-mirrors.ts";
import {
  runServerProcess,
  serverComposeArgs,
  serverProcessDeadlines,
  type ServerProcessOptions,
} from "./server-runtime.ts";
import {
  withServerStore,
  ServerStoreError,
  type ServerFiles,
  type HeldBackup,
  type ServerBackup,
  type ServerStore,
  type ServerStoreResult,
  type ServerGeneration,
} from "./server-store.ts";
import { redactCredentials } from "./shared.ts";
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
  /** Fetch text with a bounded request timeout, and the headers given, when any. */
  fetchText(
    url: string,
    timeoutMs: number,
    headers?: Readonly<Record<string, string>>,
  ): Promise<FetchOutput>;
  /** Generate installation credentials once. */
  randomBytes(size: number): Buffer;
  /** Wait between advertised health probes. */
  sleep(milliseconds: number): Promise<void>;
  /** Print one progress or result line. */
  writeLine(line: string): void;
  /**
   * This machine's saved sign-in (`cli.json` under the config directory given, or `MEND_URL` and
   * `MEND_TOKEN`), when there is one: `mend server status` reads the operator's gate reports with
   * it. Absent: status reads health alone.
   */
  readonly readLogin?: (
    configDir: string,
  ) => { readonly url: string; readonly token: string } | null;
  /**
   * This host's Docker daemon facts beside `docker info`'s JSON (null when it did not answer):
   * its dockerd argv and daemon.json (`docker-shutdown.ts`). Absent: setup does not read them.
   */
  readonly dockerDaemonFacts?: (infoStdout: string | null) => DockerDaemonFacts;
  /**
   * Try workspace SSH where `--ssh-bind` published it, from this machine: the bind itself, or each
   * of this machine's addresses for an unspecified bind. Each answer is the SSH banner read, or null
   * when nothing answered. Absent: setup says where it is published and observes nothing.
   */
  readonly probeSsh?: (bind: string, port: number) => Promise<ReadonlyArray<SshProbe>>;
  /**
   * Whether something on this machine already listens on `127.0.0.1:<port>` (the t3code gateway's
   * port, before it is first published there). Absent, nothing is checked.
   */
  readonly portTaken?: (port: number) => Promise<boolean>;
  /** How long setup waits for `probeSsh` altogether; `SSH_PROBE_BOUND_MS` when absent. */
  readonly sshProbeBoundMs?: number;
  /** Read standard input to its end: `--docker-hub-token-stdin` takes the token from here. */
  readonly readStdin?: () => Promise<string>;
}

/** One address workspace SSH was tried at, and what answered there. */
export interface SshProbe {
  readonly address: string;
  /** The first line the gateway sent (`SSH-2.0-…`), or null when nothing answered in time. */
  readonly banner: string | null;
}

/** Observable result of a server command. Expected lifecycle failures do not reject. */
export type ServerCommandResult =
  | { readonly _tag: "ok" }
  | { readonly _tag: "error"; readonly message: string };

interface SetupOptions {
  readonly context: string | undefined;
  readonly version: string | undefined;
  readonly bind: string | undefined;
  /** `--ssh-bind <ip>`: where the SSH gateway is published, when not on `--bind`. */
  readonly sshBind: string | undefined;
  readonly url: string | undefined;
  readonly origins: ReadonlyArray<string> | undefined;
  readonly appPort: number | undefined;
  readonly sshPort: number | undefined;
  readonly dockerSocket: string | undefined;
  readonly assetsDir: string | undefined;
  readonly offline: boolean;
  /** `--edge <host>`: run the TLS edge for this name. Omitted keeps the saved one. */
  readonly edge: string | undefined;
  /** `--no-edge`: take a saved edge away. */
  readonly noEdge: boolean;
  /** `--exposure`, `--tenancy`: the posture declared; omitted keeps the saved one. */
  readonly exposure: Exposure | undefined;
  readonly tenancy: Tenancy | undefined;
  /** `--declare <item>`, repeatable: gate items verified from outside. `none` clears; omitted keeps. */
  readonly declared: ReadonlyArray<DeclarableItem> | undefined;
  /** `--npm-mirror` (true), `--no-npm-mirror` (false); omitted keeps the saved choice. */
  readonly npmMirror: boolean | undefined;
  /** `--npm-mirror-max-size`: the npm mirror's cap; omitted keeps the saved one. */
  readonly npmMirrorMaxSize: string | undefined;
  /** `--docker-mirror` (true), `--no-docker-mirror` (false); omitted keeps the saved choice. */
  readonly dockerMirror: boolean | undefined;
  /** `--docker-mirror-max-size`: the Docker mirror's cap; omitted keeps the saved one. */
  readonly dockerMirrorMaxSize: string | undefined;
  /** `--docker-hub-username` with `--docker-hub-token-stdin`: the Docker mirror's upstream login. */
  readonly dockerHubUsername: string | undefined;
  readonly dockerHubTokenStdin: boolean;
  /** `--no-docker-hub-login`: the Docker mirror pulls anonymously again. */
  readonly noDockerHubLogin: boolean;
  /** `--t3-gateway`: run the t3code gateway (docs/adr/0012). Omitted keeps the saved choice. */
  readonly t3Gateway: boolean;
  /** `--t3-gateway-port <port>`: its loopback port; implies `--t3-gateway`. */
  readonly t3GatewayPort: number | undefined;
  /** `--no-t3-gateway`: turn it off. */
  readonly noT3Gateway: boolean;
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
  /**
   * Where the workspace SSH gateway is published, when it is not `bind`. An edge keeps the web port
   * on loopback, but Remote-SSH from another machine needs the gateway's port reachable: the edge
   * proxies HTTPS only. Absent: the gateway is published on `bind`, as before.
   */
  readonly sshBind?: string;
  readonly appUrl: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly appPort: number;
  readonly sshPort: number;
  /** Only on generations written under the v1 contract, which published a loopback registry. */
  readonly registryPort?: number;
  /**
   * The capture store's bucket, present when the generation's compose asset carries the Garage
   * service (every release since the capture store). Derived from the validated asset, never
   * from the CLI's own version: a generation pinned to an older release has no bucket, renders
   * no Garage values and owns no Garage volume.
   */
  readonly bucket?: "garage";
  /**
   * The TLS edge's host (docs/adr/0004): Caddy terminates TLS for this name on 80 and 443 and
   * proxies to Mend's web tier, whose own port stays on loopback. `APP_URL` is then exactly
   * `https://<edgeHost>`. Absent, no edge runs and nothing is published beyond `bind`.
   */
  readonly edgeHost?: string;
  /** `MEND_EXPOSURE` as declared on this install; absent, the server's default (`private`). */
  readonly exposure?: Exposure;
  /** `MEND_TENANCY` as declared on this install; absent, the server's default (`single`). */
  readonly tenancy?: Tenancy;
  /**
   * `MEND_EXPOSURE_DECLARED`: the gate items the operator states they verified from outside
   * (`--declare`). Absent when none.
   */
  readonly declared?: ReadonlyArray<DeclarableItem>;
  /**
   * The package and image mirrors (server-mirrors.ts). Absent only on a config written before
   * them: setup and upgrade then write the default, both on.
   */
  readonly mirrors?: ServerMirrors;
  /**
   * The t3code gateway's port on 127.0.0.1 (docs/adr/0012), when the operator turned it on with
   * `--t3-gateway`; absent, it does not run.
   */
  readonly t3GatewayPort?: number;
}

/** The Garage image the bundle pins; `checkLocalImages` preloads it like Postgres's. */
const GARAGE_IMAGE = "dxflrs/garage:v2.4.1";
/** The bucket every install uses; `MEND_BLOB_STORE` in the compose names it. */
const GARAGE_BUCKET = "mend";

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
  /**
   * The Docker mirror's Docker Hub access token, when the operator gave one. Kept in `server.env`
   * only, never in the identity: the identity's bytes anchor volume ownership and never change.
   */
  readonly dockerHubToken?: string;
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

const requiredBucket = (fields: ReadonlyMap<string, unknown>): "garage" => {
  const value = fields.get("bucket");
  if (value !== "garage")
    throw setupError("Server config is corrupt: bucket must be garage when present.");
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
  "--ssh-bind",
  "--url",
  "--origin",
  "--port",
  "--ssh-port",
  "--docker-socket",
  "--assets-dir",
  "--offline",
  "--edge",
  "--no-edge",
  "--exposure",
  "--tenancy",
  "--declare",
  "--npm-mirror",
  "--no-npm-mirror",
  "--npm-mirror-max-size",
  "--docker-mirror",
  "--no-docker-mirror",
  "--docker-mirror-max-size",
  "--docker-hub-username",
  "--docker-hub-token-stdin",
  "--docker-hub-public-only",
  "--no-docker-hub-login",
  "--t3-gateway",
  "--t3-gateway-port",
  "--no-t3-gateway",
]);

/** Setup flags that take no value. */
const SWITCHES: ReadonlySet<string> = new Set([
  "--offline",
  "--no-edge",
  "--npm-mirror",
  "--no-npm-mirror",
  "--docker-mirror",
  "--no-docker-mirror",
  "--docker-hub-token-stdin",
  "--docker-hub-public-only",
  "--no-docker-hub-login",
  "--t3-gateway",
  "--no-t3-gateway",
]);

const parseExposure = (value: string): Exposure => {
  if (!isExposure(value))
    throw setupError(`--exposure must be one of ${EXPOSURES.join(", ")}, not "${value}".`);
  return value;
};

const parseTenancy = (value: string): Tenancy => {
  if (!isTenancy(value))
    throw setupError(`--tenancy must be one of ${TENANCIES.join(", ")}, not "${value}".`);
  return value;
};

/** `--declare` values: each a declarable gate item, or `none` alone, which clears the list. */
const parseDeclared = (values: ReadonlyArray<string>): ReadonlyArray<DeclarableItem> => {
  if (values.length === 1 && values[0] === "none") return [];
  return [
    ...new Set(
      values.map((value) => {
        if (!isDeclarableItem(value)) {
          throw setupError(
            `--declare takes ${DECLARABLE_ITEMS.join(", ")} or none, not "${value}". Every other gate item is observed by the server, never stated.`,
          );
        }
        return value;
      }),
    ),
  ];
};

const parseEdge = (value: string): string => {
  const host = parseEdgeHost(value);
  if (host === null) {
    throw setupError(
      `--edge must be a DNS name a certificate can be issued for, such as mend.example.com, not "${value}". An IP address or a single label cannot carry a public certificate.`,
    );
  }
  return host;
};

const parseSetupOptions = (args: ReadonlyArray<string>): SetupOptions => {
  const values = new Map<string, Array<string>>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (!flag.startsWith("--")) throw setupError(`Unexpected server setup argument "${flag}".`);
    if (!SETUP_FLAGS.has(flag)) throw setupError(`Unknown server setup option "${flag}".`);
    if (SWITCHES.has(flag)) {
      if (values.has(flag)) throw setupError(`${flag} may be supplied only once.`);
      values.set(flag, ["true"]);
      continue;
    }
    const [value, valueIndex] = nextFlagValue(args, index, flag);
    index = valueIndex;
    const previous = values.get(flag) ?? [];
    if (flag !== "--origin" && flag !== "--declare" && previous.length > 0) {
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
  const edge = flagValue("--edge");
  const exposure = flagValue("--exposure");
  const tenancy = flagValue("--tenancy");
  const declared = values.get("--declare");
  if (edge !== undefined && values.has("--no-edge"))
    throw setupError("--edge and --no-edge contradict each other.");
  const pair = (on: string, off: string): boolean | undefined => {
    if (values.has(on) && values.has(off))
      throw setupError(`${on} and ${off} contradict each other.`);
    return values.has(on) ? true : values.has(off) ? false : undefined;
  };
  const npmMirror = pair("--npm-mirror", "--no-npm-mirror");
  const dockerMirror = pair("--docker-mirror", "--no-docker-mirror");
  const maxSize = flagValue("--npm-mirror-max-size");
  const npmMirrorMaxSize = maxSize === undefined ? undefined : parseMirrorSize(maxSize);
  if (npmMirrorMaxSize === null)
    throw setupError(
      `--npm-mirror-max-size must be a whole number of gibibytes or mebibytes, at least 1g, such as 20g or 1536m, not "${maxSize ?? ""}".`,
    );
  if (npmMirrorMaxSize !== undefined && npmMirror === false)
    throw setupError("--npm-mirror-max-size and --no-npm-mirror contradict each other.");
  const dockerMaxSize = flagValue("--docker-mirror-max-size");
  const dockerMirrorMaxSize =
    dockerMaxSize === undefined ? undefined : parseMirrorSize(dockerMaxSize);
  if (dockerMirrorMaxSize === null)
    throw setupError(
      `--docker-mirror-max-size must be a whole number of gibibytes or mebibytes, at least 1g, such as 40g, not "${dockerMaxSize ?? ""}".`,
    );
  if (dockerMirrorMaxSize !== undefined && dockerMirror === false)
    throw setupError("--docker-mirror-max-size and --no-docker-mirror contradict each other.");
  const dockerHubUsername = flagValue("--docker-hub-username");
  const dockerHubTokenStdin = values.has("--docker-hub-token-stdin");
  const noDockerHubLogin = values.has("--no-docker-hub-login");
  if ((dockerHubUsername === undefined) !== !dockerHubTokenStdin)
    throw setupError(
      "--docker-hub-username and --docker-hub-token-stdin go together: the user name, and the access token on standard input.",
    );
  if (dockerHubUsername !== undefined && !isDockerHubCredential(dockerHubUsername))
    throw setupError(`--docker-hub-username "${dockerHubUsername}" is not a Docker Hub user name.`);
  const dockerHubPublicOnly = values.has("--docker-hub-public-only");
  if (dockerHubPublicOnly && dockerHubUsername === undefined)
    throw setupError(
      "--docker-hub-public-only goes with --docker-hub-username and --docker-hub-token-stdin: it states what the token you give can read.",
    );
  if (dockerHubUsername !== undefined && !dockerHubPublicOnly)
    throw setupError(
      'A Docker Hub login needs --docker-hub-public-only. The Docker mirror has no login of its own: every session that reaches it can pull whatever the token can read, private repositories included. Create a Docker Hub personal access token with the access permission "Public Repo Read-only", pipe it on standard input, and add --docker-hub-public-only to state that it is one. Mend cannot check a token\'s scope.',
    );
  if (dockerHubUsername !== undefined && (noDockerHubLogin || dockerMirror === false))
    throw setupError(
      `--docker-hub-username and ${noDockerHubLogin ? "--no-docker-hub-login" : "--no-docker-mirror"} contradict each other.`,
    );
  const t3GatewayPort = flagValue("--t3-gateway-port");
  if (
    values.has("--no-t3-gateway") &&
    (values.has("--t3-gateway") || t3GatewayPort !== undefined)
  ) {
    throw setupError("--no-t3-gateway contradicts --t3-gateway and --t3-gateway-port.");
  }
  return {
    context: flagValue("--context"),
    version: version === undefined ? undefined : parseVersion(version),
    bind: flagValue("--bind"),
    sshBind: flagValue("--ssh-bind"),
    url: flagValue("--url"),
    origins: origins === undefined ? undefined : origins,
    appPort: appPort === undefined ? undefined : parsePort(appPort, "--port"),
    sshPort: sshPort === undefined ? undefined : parsePort(sshPort, "--ssh-port"),
    dockerSocket: flagValue("--docker-socket"),
    assetsDir: flagValue("--assets-dir"),
    offline: values.has("--offline"),
    edge: edge === undefined ? undefined : parseEdge(edge),
    noEdge: values.has("--no-edge"),
    exposure: exposure === undefined ? undefined : parseExposure(exposure),
    tenancy: tenancy === undefined ? undefined : parseTenancy(tenancy),
    declared: declared === undefined ? undefined : parseDeclared(declared),
    npmMirror,
    npmMirrorMaxSize,
    dockerMirror,
    dockerMirrorMaxSize,
    dockerHubUsername,
    dockerHubTokenStdin,
    noDockerHubLogin,
    t3Gateway: values.has("--t3-gateway"),
    t3GatewayPort:
      t3GatewayPort === undefined ? undefined : parsePort(t3GatewayPort, "--t3-gateway-port"),
    noT3Gateway: values.has("--no-t3-gateway"),
  };
};

/**
 * The mirrors a setup writes: each flag given, else what the install saved, else on. A config from
 * before the mirrors gains both here, on setup and on upgrade alike. A Docker Hub login stays until
 * `--no-docker-hub-login` or `--no-docker-mirror` takes it away.
 */
const resolveMirrors = (
  saved: ServerMirrors | undefined,
  options: Pick<
    SetupOptions,
    | "npmMirror"
    | "npmMirrorMaxSize"
    | "dockerMirror"
    | "dockerMirrorMaxSize"
    | "dockerHubUsername"
    | "noDockerHubLogin"
  >,
): ServerMirrors => {
  const base = saved ?? DEFAULT_MIRRORS;
  const npmOn = options.npmMirror ?? (options.npmMirrorMaxSize !== undefined || base.npm !== null);
  const dockerOn =
    options.dockerMirror ??
    (options.dockerHubUsername !== undefined ||
      options.dockerMirrorMaxSize !== undefined ||
      base.docker !== null);
  // A login is taken only with --docker-hub-public-only (parseSetupOptions), so one carried here
  // was declared Public Repo Read-only when it was given.
  const upstreamUser =
    options.dockerHubUsername ??
    (options.noDockerHubLogin ? undefined : dockerMirrorLogin(base.docker));
  const dockerMaxSize =
    options.dockerMirrorMaxSize ?? base.docker?.maxSize ?? DEFAULT_DOCKER_MIRROR_MAX_SIZE;
  return {
    npm: npmOn
      ? {
          maxSize: options.npmMirrorMaxSize ?? base.npm?.maxSize ?? DEFAULT_NPM_MIRROR_MAX_SIZE,
        }
      : null,
    docker: !dockerOn
      ? null
      : upstreamUser === undefined
        ? { maxSize: dockerMaxSize }
        : { maxSize: dockerMaxSize, upstreamUser, upstreamPublicOnly: true },
  };
};

const parseMirrorsField = (value: unknown): ServerMirrors => {
  const fields = ownFields(value);
  const corrupt = () =>
    setupError(
      "Server config is corrupt: mirrors must hold npm and docker, each an object or null.",
    );
  if (fields === null || !fields.has("npm") || !fields.has("docker")) throw corrupt();
  const npm = fields.get("npm");
  const docker = fields.get("docker");
  let parsedNpm: ServerMirrors["npm"] = null;
  if (npm !== null) {
    const maxSize = ownFields(npm)?.get("maxSize");
    if (typeof maxSize !== "string" || parseMirrorSize(maxSize) !== maxSize) throw corrupt();
    parsedNpm = { maxSize };
  }
  let parsedDocker: ServerMirrors["docker"] = null;
  if (docker !== null) {
    const dockerFields = ownFields(docker);
    if (dockerFields === null) throw corrupt();
    const maxSize = dockerFields.get("maxSize");
    if (typeof maxSize !== "string" || parseMirrorSize(maxSize) !== maxSize) throw corrupt();
    const user = dockerFields.get("upstreamUser");
    if (user !== undefined && (typeof user !== "string" || !isDockerHubCredential(user)))
      throw corrupt();
    // A login without the operator's public-only statement is never rendered.
    if (user !== undefined && dockerFields.get("upstreamPublicOnly") !== true)
      throw setupError(
        "Server config is corrupt: the Docker mirror's login lacks upstreamPublicOnly. Run mend server setup with --docker-hub-public-only and a Public Repo Read-only token, or --no-docker-hub-login.",
      );
    parsedDocker =
      user === undefined ? { maxSize } : { maxSize, upstreamUser: user, upstreamPublicOnly: true };
  }
  return { npm: parsedNpm, docker: parsedDocker };
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
  edgeHost: string | undefined,
): string => {
  if (edgeHost !== undefined) {
    // The edge serves exactly one origin (compose.edge.yaml: APP_URL is https://<MEND_EDGE_HOST>).
    const origin = parseHttpOrigin(options.url ?? `https://${edgeHost}`, "--url");
    if (origin !== `https://${edgeHost}`) {
      throw setupError(
        `With --edge ${edgeHost}, --url must be https://${edgeHost}, the origin the edge serves.`,
      );
    }
    return origin;
  }
  // An edge taken away leaves its https origin behind; the localhost default returns unless
  // --url says otherwise.
  if (existing?.edgeHost !== undefined) {
    return parseHttpOrigin(options.url ?? `http://localhost:${appPort}`, "--url");
  }
  // A saved URL that points at the app port directly (plain http, the port written out: the LAN or
  // tailnet case) moves with --port, on any host: left behind, it would send every client (the
  // browser, `mend login`, VS Code) to a port nothing publishes. An https origin, or one whose port
  // is implicit, is an endpoint in front of Mend that --port does not move, so it stays.
  const saved = existing === null ? null : new URL(existing.appUrl);
  const savedPointsAtOldPort =
    saved !== null &&
    existing !== null &&
    options.appPort !== undefined &&
    saved.protocol === "http:" &&
    saved.port !== "" &&
    Number(saved.port) === existing.appPort;
  if (saved !== null && savedPointsAtOldPort) saved.port = String(appPort);
  const fallback = saved === null ? `http://localhost:${appPort}` : saved.origin;
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

/**
 * The posture the edge and the declarations must agree on. The server would refuse some of these
 * at start; said here instead, before a generation is written. None is a verdict about the install:
 * each names two settings that cannot both hold.
 */
const checkPosture = (
  bind: string,
  sshBind: string,
  ports: { readonly appPort: number; readonly sshPort: number },
  edgeHost: string | undefined,
  exposure: Exposure | undefined,
  declared: ReadonlyArray<DeclarableItem>,
): void => {
  if (edgeHost !== undefined && [ports.appPort, ports.sshPort].some((p) => p === 80 || p === 443)) {
    throw setupError(
      "With an edge, --port and --ssh-port must not be 80 or 443: the edge publishes both on every interface.",
    );
  }
  if (edgeHost !== undefined && !isLoopbackBind(bind)) {
    throw setupError(
      `With an edge, --bind stays on loopback, ${DEFAULT_BIND}: the edge publishes 80 and 443, and Mend's own port is reached through it alone.`,
    );
  }
  if (edgeHost !== undefined && exposure === "loopback") {
    throw setupError(
      "--exposure loopback and an edge contradict each other: the edge publishes 80 and 443 on every interface.",
    );
  }
  if (exposure === "loopback" && !isLoopbackBind(bind)) {
    throw setupError(
      "--exposure loopback contradicts a non-loopback --bind: the port is published beyond this machine.",
    );
  }
  if (exposure === "loopback" && !isLoopbackBind(sshBind)) {
    throw setupError(
      "--exposure loopback contradicts a non-loopback --ssh-bind: the SSH port is published beyond this machine.",
    );
  }
  // The server refuses a public start while the gate's workspace-ssh item is open: say so here.
  if (exposure === "public" && !isLoopbackBind(sshBind) && !declared.includes("workspace-ssh")) {
    throw setupError(
      `--exposure public with workspace SSH published on ${publishedAddress(sshBind, ports.sshPort)} beside the edge needs a statement Mend cannot observe: who reaches that port. Check it from each network that should not reach it, then add --declare workspace-ssh; or publish SSH on loopback.`,
    );
  }
  if (exposure === "public" && edgeHost === undefined) {
    throw setupError(
      "--exposure public needs the edge: add --edge <host>. Without it nothing sets MEND_TRUSTED_PROXIES or an https origin, and the server refuses to start as public.",
    );
  }
};

const validateExposure = (
  existing: ServerConfig | null,
  options: SetupOptions,
): Pick<
  ServerConfig,
  | "bind"
  | "sshBind"
  | "appUrl"
  | "allowedOrigins"
  | "appPort"
  | "sshPort"
  | "edgeHost"
  | "exposure"
  | "tenancy"
  | "declared"
  | "t3GatewayPort"
> => {
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
  // Kept across reruns like --bind; naming the same address as --bind takes it away.
  const requestedSshBind = options.sshBind ?? existing?.sshBind;
  if (requestedSshBind !== undefined && net.isIP(requestedSshBind) === 0) {
    throw setupError(
      "--ssh-bind must be a literal IPv4 or IPv6 address, such as 127.0.0.1 or 0.0.0.0.",
    );
  }
  const sshBind = requestedSshBind === bind ? undefined : requestedSshBind;
  // The edge and the posture are kept across reruns and upgrades; only a flag changes them.
  const edgeHost = options.noEdge ? undefined : (options.edge ?? existing?.edgeHost);
  const exposure = options.exposure ?? existing?.exposure;
  const tenancy = options.tenancy ?? existing?.tenancy;
  // The t3code gateway, like the edge, is kept across reruns and upgrades until a flag changes it.
  const t3GatewayPort = options.noT3Gateway
    ? undefined
    : (options.t3GatewayPort ??
      existing?.t3GatewayPort ??
      (options.t3Gateway ? DEFAULT_T3_GATEWAY_PORT : undefined));
  if (t3GatewayPort !== undefined && [appPort, sshPort].includes(t3GatewayPort)) {
    throw setupError(
      `--t3-gateway-port ${t3GatewayPort} is Mend's own --port or --ssh-port: the gateway needs a port of its own.`,
    );
  }
  if (t3GatewayPort !== undefined && edgeHost !== undefined && [80, 443].includes(t3GatewayPort)) {
    throw setupError("With an edge, --t3-gateway-port must not be 80 or 443: the edge has them.");
  }
  const declared = options.declared ?? existing?.declared ?? [];
  checkPosture(bind, sshBind ?? bind, { appPort, sshPort }, edgeHost, exposure, declared);
  const appUrl = resolveAppUrl(existing, options, appPort, edgeHost);
  // Behind the edge, loopback bind and https origin is the pair; everywhere else both must agree.
  if (edgeHost === undefined)
    checkExposurePair(bind, appUrl, options.url === undefined && existing === null);

  const requestedOrigins = options.origins?.map((origin) => parseHttpOrigin(origin, "--origin"));
  const inheritedOrigins = existing?.allowedOrigins ?? [];
  const allowedOrigins = [
    ...new Set((requestedOrigins ?? inheritedOrigins).filter((origin) => origin !== appUrl)),
  ];
  return {
    bind,
    ...(sshBind === undefined ? {} : { sshBind }),
    appUrl,
    allowedOrigins,
    appPort,
    sshPort,
    ...(edgeHost === undefined ? {} : { edgeHost }),
    ...(exposure === undefined ? {} : { exposure }),
    ...(tenancy === undefined ? {} : { tenancy }),
    ...(declared.length === 0 ? {} : { declared }),
    ...(t3GatewayPort === undefined ? {} : { t3GatewayPort }),
  };
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
  const edgeHost = fields.has("edgeHost") ? requiredString(fields, "edgeHost") : undefined;
  if (edgeHost !== undefined && parseEdgeHost(edgeHost) !== edgeHost) {
    throw setupError("Server config is corrupt: edgeHost must be a lowercase DNS name.");
  }
  const exposure = fields.has("exposure") ? requiredString(fields, "exposure") : undefined;
  if (exposure !== undefined && !isExposure(exposure)) {
    throw setupError(`Server config is corrupt: exposure must be one of ${EXPOSURES.join(", ")}.`);
  }
  const tenancy = fields.has("tenancy") ? requiredString(fields, "tenancy") : undefined;
  if (tenancy !== undefined && !isTenancy(tenancy)) {
    throw setupError(`Server config is corrupt: tenancy must be one of ${TENANCIES.join(", ")}.`);
  }
  const declaredField = fields.get("declared");
  if (
    declaredField !== undefined &&
    (!Array.isArray(declaredField) ||
      !declaredField.every((item) => typeof item === "string" && isDeclarableItem(item)))
  ) {
    throw setupError(
      `Server config is corrupt: declared must be an array of ${DECLARABLE_ITEMS.join(", ")}.`,
    );
  }
  const declared = Array.isArray(declaredField)
    ? declaredField.filter((item): item is DeclarableItem => isDeclarableItem(String(item)))
    : [];
  const t3GatewayPort = fields.has("t3GatewayPort")
    ? requiredInteger(fields, "t3GatewayPort")
    : undefined;
  const config: ServerConfig = {
    schemaVersion: requiredInteger(fields, "schemaVersion"),
    assetContract: requiredString(fields, "assetContract"),
    serverVersion,
    dockerContext: requiredString(fields, "dockerContext"),
    dockerEndpoint: requiredString(fields, "dockerEndpoint"),
    dockerSocket: parseDockerSocketPath(requiredString(fields, "dockerSocket")),
    dockerSocketSource,
    bind: requiredString(fields, "bind"),
    ...(fields.has("sshBind") ? { sshBind: requiredString(fields, "sshBind") } : {}),
    appUrl: parseHttpOrigin(requiredString(fields, "appUrl"), "Server config appUrl"),
    allowedOrigins: origins.map((origin) =>
      parseHttpOrigin(origin, "Server config allowedOrigins"),
    ),
    appPort: requiredInteger(fields, "appPort"),
    sshPort: requiredInteger(fields, "sshPort"),
    ...(fields.has("registryPort")
      ? { registryPort: requiredInteger(fields, "registryPort") }
      : {}),
    ...(fields.has("bucket") ? { bucket: requiredBucket(fields) } : {}),
    ...(edgeHost === undefined ? {} : { edgeHost }),
    ...(exposure === undefined ? {} : { exposure }),
    ...(tenancy === undefined ? {} : { tenancy }),
    ...(declared.length === 0 ? {} : { declared }),
    ...(fields.has("mirrors") ? { mirrors: parseMirrorsField(fields.get("mirrors")) } : {}),
    ...(t3GatewayPort === undefined ? {} : { t3GatewayPort }),
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
  if (config.t3GatewayPort !== undefined)
    parsePort(String(config.t3GatewayPort), "Server config t3GatewayPort");
  validateExposure(null, {
    context: undefined,
    version: undefined,
    bind: config.bind,
    sshBind: config.sshBind,
    url: config.appUrl,
    origins: config.allowedOrigins,
    appPort: config.appPort,
    sshPort: config.sshPort,
    dockerSocket: undefined,
    assetsDir: undefined,
    offline: false,
    edge: config.edgeHost,
    noEdge: false,
    exposure: config.exposure,
    tenancy: config.tenancy,
    declared: config.declared,
    npmMirror: undefined,
    npmMirrorMaxSize: undefined,
    dockerMirror: undefined,
    dockerMirrorMaxSize: undefined,
    dockerHubUsername: undefined,
    dockerHubTokenStdin: false,
    noDockerHubLogin: false,
    t3Gateway: false,
    t3GatewayPort: config.t3GatewayPort,
    noT3Gateway: false,
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
    ...(fields.has("MEND_DOCKER_HUB_TOKEN")
      ? { dockerHubToken: envValue(fields, "MEND_DOCKER_HUB_TOKEN") }
      : {}),
  };
  if (secrets.dockerHubToken !== undefined && !isDockerHubCredential(secrets.dockerHubToken)) {
    throw setupError("Server secrets are corrupt: MEND_DOCKER_HUB_TOKEN has an invalid value.");
  }
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

/** What a failed command said: its stderr, else the runtime's failure, else its exit status. */
const outputDetail = (output: CommandOutput): string =>
  output.stderr.trim() || output.error || `exit ${output.status ?? "unknown"}`;

const commandFailure = (label: string, output: CommandOutput): ServerSetupError =>
  setupError(`${label}: ${outputDetail(output)}`);

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

/**
 * What setup says when the Docker host's kernel refuses unprivileged user namespaces: every
 * workspace's Docker service is a rootless Docker daemon that needs them, so no session could start
 * (Ubuntu 23.10 and later refuse them by default). Read from the Docker host's own kernel through a
 * throwaway container of the Mend image, so it holds for a remote context too. Null when the host
 * allows them, or when the container could not answer: nothing observed, nothing said.
 */
const hostUserNamespacesLine = async (
  runtime: ServerSetupRuntime,
  context: string,
  image: string,
): Promise<string | null> => {
  const read = HOST_USER_NAMESPACE_FILES.map(
    (file) => `printf '%s|' "$(cat ${file} 2>/dev/null || echo -)"`,
  ).join("; ");
  const probe = await runtime.run("docker", [
    "--context",
    context,
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "sh",
    image,
    "-c",
    read,
  ]);
  if (probe.status !== 0) return null;
  const [restrict, apparmor, clone] = probe.stdout
    .trim()
    .split("|")
    .map((value) => (value.trim() === "-" ? null : value));
  const observed = hostUserNamespacesOf({
    apparmorRestrictUnprivilegedUserns: restrict ?? null,
    apparmorEnabled: apparmor ?? null,
    unprivilegedUsernsClone: clone ?? null,
  });
  return observed.allowed
    ? null
    : `No session can start on this Docker host yet: its kernel refuses unprivileged user namespaces, which each workspace's rootless Docker service needs. On the host, run: ${hostUserNamespacesFix(observed.setting)}`;
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

/** The service names a compose asset declares, sorted; the shape check and the bucket flag read it. */
const composeServiceNames = (body: string): ReadonlyArray<string> => {
  const [, afterServices = ""] = body.split(/^services:\s*$/m);
  const [servicesBlock = ""] = afterServices.split(/^\S/m);
  return [...servicesBlock.matchAll(/^ {2}([0-9A-Za-z_-]+):\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== undefined)
    .toSorted((left, right) => left.localeCompare(right));
};

/** Whether a validated compose asset carries the capture store's bucket. */
const composeBucket = (body: string): "garage" | undefined =>
  composeServiceNames(body).includes("garage") ? "garage" : undefined;

const validateComposeAsset = (body: string): void => {
  const serviceNames = composeServiceNames(body);
  const withGarage = serviceNames.includes("garage");
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
    ...(withGarage ? [["mend-garage", "MEND_GARAGE_VOLUME_NAME"]] : []),
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
    // The capture store's bucket (a release since the capture store); an older release's asset
    // has none and is still a valid v2 bundle.
    ...(withGarage
      ? [
          `image: ${GARAGE_IMAGE}`,
          "  garage:",
          "mend-garage:",
          "MEND_GARAGE_RPC_SECRET",
          "MEND_GARAGE_ADMIN_TOKEN",
          "MEND_GARAGE_KEY_ID",
          "MEND_GARAGE_KEY_SECRET",
          "MEND_BLOB_STORE",
          "MEND_SESSION_ENDPOINT_URL",
        ]
      : []),
  ];
  if (
    requiredFragments.some((fragment) => !body.includes(fragment)) ||
    (serviceNames.join(",") !== "mend,postgres" &&
      serviceNames.join(",") !== "garage,mend,postgres")
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

/**
 * The Garage values a generation's compose reads, derived from the identity at render time
 * (setup-contract "derivedSecrets"): the identity file anchors Docker volume ownership byte for
 * byte, so the bucket's arrival must not change it, and an upgrade across the capture store must
 * reproduce the same values from the same identity. HMAC-SHA256 under distinct labels.
 */
const garageSecrets = (secrets: ServerSecrets) => {
  const derive = (label: string): string =>
    createHmac("sha256", Buffer.from(secrets.betterAuthSecret, "hex")).update(label).digest("hex");
  return {
    rpcSecret: derive("mend-garage-rpc-secret"),
    adminToken: derive("mend-garage-admin-token"),
    keyId: `GK${derive("mend-garage-key-id").slice(0, 24)}`,
    keySecret: derive("mend-garage-key-secret"),
  };
};

const renderGarage = (secrets: ServerSecrets, config: ServerConfig): ReadonlyArray<string> => {
  if (config.bucket !== "garage") return [];
  const garage = garageSecrets(secrets);
  return [
    `MEND_GARAGE_RPC_SECRET=${garage.rpcSecret}`,
    `MEND_GARAGE_ADMIN_TOKEN=${garage.adminToken}`,
    `MEND_GARAGE_KEY_ID=${garage.keyId}`,
    `MEND_GARAGE_KEY_SECRET=${garage.keySecret}`,
    "MEND_GARAGE_VOLUME_NAME=mend-garage",
  ];
};

/** The volumes a generation owns: the Garage volume only where its bundle carries Garage. */
const namespaceOf = (config: ServerConfig): ServerDockerNamespace =>
  config.bucket === "garage" ? MEND_DOCKER_NAMESPACE_WITH_GARAGE : MEND_DOCKER_NAMESPACE;

/** An address as Compose's `ports` needs it: IPv6 in brackets. */
const composeHost = (address: string): string =>
  net.isIP(address) === 6 ? `[${address}]` : address;

const renderSecrets = (secrets: ServerSecrets, config: ServerConfig): string => {
  const sshHost = parseUrl(config.appUrl, "Server config appUrl").hostname.replace(/^\[|\]$/g, "");
  const composeBind = composeHost(config.bind);
  return [
    `MEND_VERSION=${config.serverVersion}`,
    "MEND_IMAGE_REPOSITORY=ghcr.io/sealant-sh/mend",
    ...renderIdentity(secrets).trimEnd().split("\n"),
    `APP_URL=${config.appUrl}`,
    `MEND_ALLOWED_ORIGINS=${JSON.stringify(config.allowedOrigins)}`,
    `MEND_BIND_HOST=${composeBind}`,
    ...(config.sshBind === undefined ? [] : [`MEND_SSH_BIND_HOST=${composeHost(config.sshBind)}`]),
    `MEND_PORT=${config.appPort}`,
    `MEND_SSH_PORT=${config.sshPort}`,
    ...(config.registryPort === undefined ? [] : [`MEND_REGISTRY_PORT=${config.registryPort}`]),
    `SEALANT_SSH_HOST=${sshHost}`,
    // The edge's host and the posture (server-edge.ts): compose.edge.yaml and
    // compose.posture.yaml read them from here, and only from here.
    ...postureEnvLines(config),
    "MEND_STORE_VOLUME_NAME=mend-store",
    "MEND_CONTROL_VOLUME_NAME=mend-control",
    ...renderGarage(secrets, config),
    // The mirrors' size cap and Docker Hub login (server-mirrors.ts); the token reaches only the
    // Docker mirror's container.
    ...mirrorsEnvLines(config.mirrors, secrets.dockerHubToken),
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
  /**
   * The edge image this generation's overlay pins, when it has one. Read from the generation, not
   * from this CLI: a newer CLI starting an older generation checks the image that generation runs.
   */
  readonly edgeImage?: string;
  /** The images this generation's mirrors overlay pins, read from the generation like the edge's. */
  readonly mirrorImages?: ReadonlyArray<string>;
}

/** The generation's Compose target: its directory, context and the overlays its config declares. */
const composeTarget = (
  installation: ServerInstallation,
): {
  readonly directory: string;
  readonly dockerContext: string;
  readonly overlays: ReadonlyArray<string>;
} => ({
  directory: installation.directory,
  dockerContext: installation.config.dockerContext,
  overlays: composeOverlays(installation.config),
});

/** The image the edge overlay pins; the overlay is not an edge overlay without one. */
const edgeImageOf = (overlay: string): string => {
  const image = /^ {4}image:[ \t]*(caddy:[^\s#]+)[ \t]*$/m.exec(overlay)?.[1];
  if (image === undefined)
    throw setupError("Server generation is corrupt: compose.edge.yaml pins no Caddy image.");
  return image;
};

/**
 * The generation's overlays agree with its config: an edge host has the edge overlay and its
 * Caddyfile, a posture has an overlay naming each of its variables, and neither is there otherwise.
 * Content is the generation's own snapshot (an upgrade writes the CLI's current copy), so this reads
 * shape, not bytes, like the compose asset.
 */
const validateOverlays = (
  config: ServerConfig,
  files: ServerGeneration["files"],
): string | undefined => {
  const posture = renderPostureOverlay(config);
  if ((posture === undefined) !== (files.posture === undefined)) {
    throw setupError(
      "Server generation is corrupt: compose.posture.yaml does not match the persisted server config.",
    );
  }
  for (const line of postureEnvLines(config)) {
    const key = line.slice(0, line.indexOf("="));
    // The edge's host and the gateway's port are read by their own overlays.
    if (
      key !== "MEND_EDGE_HOST" &&
      key !== "MEND_T3_GATEWAY_PORT" &&
      !(files.posture ?? "").includes(`      ${key}: \${${key}`)
    ) {
      throw setupError(
        `Server generation is corrupt: compose.posture.yaml does not hand ${key} to Mend.`,
      );
    }
  }
  if ((config.t3GatewayPort === undefined) !== (files.t3Gateway === undefined)) {
    throw setupError(
      "Server generation is corrupt: compose.t3.yaml does not match the persisted server config.",
    );
  }
  if (
    files.t3Gateway !== undefined &&
    (!files.t3Gateway.includes('MEND_T3_GATEWAY_ENABLED: "true"') ||
      !files.t3Gateway.includes('"127.0.0.1:${MEND_T3_GATEWAY_PORT'))
  ) {
    throw setupError(
      "Server generation is corrupt: compose.t3.yaml is not the gateway overlay on loopback.",
    );
  }
  if (
    (config.edgeHost === undefined) !== (files.edge === undefined) ||
    (config.edgeHost === undefined) !== (files.caddyfile === undefined)
  ) {
    throw setupError(
      "Server generation is corrupt: compose.edge.yaml and Caddyfile do not match the persisted server config.",
    );
  }
  if (files.edge === undefined || files.caddyfile === undefined) return undefined;
  if (
    !files.edge.includes("\n  edge:") ||
    !files.edge.includes("MEND_EDGE_HOST") ||
    !files.edge.includes("./Caddyfile:/etc/caddy/Caddyfile")
  ) {
    throw setupError("Server generation is corrupt: compose.edge.yaml is not the edge overlay.");
  }
  if (
    !files.caddyfile.includes("{$MEND_EDGE_HOST}") ||
    !files.caddyfile.includes("reverse_proxy mend:3105")
  ) {
    throw setupError(
      "Server generation is corrupt: the Caddyfile does not route the edge host to Mend.",
    );
  }
  return edgeImageOf(files.edge);
};

/**
 * The generation's mirror files agree with its config: the overlay names each mirror it runs and
 * Mend's addresses for them, the npm mirror has its nginx configuration, and a Docker Hub login has
 * both its user name and its token in `server.env`. Returns the images the overlay pins.
 */
const validateMirrors = (
  config: ServerConfig,
  secrets: ServerSecrets,
  files: ServerGeneration["files"],
): ReadonlyArray<string> => {
  const mirrors = config.mirrors;
  if (runsMirrors(mirrors) !== (files.mirrors !== undefined)) {
    throw setupError(
      `Server generation is corrupt: ${MIRRORS_COMPOSE_FILE} does not match the persisted server config.`,
    );
  }
  if ((mirrors !== undefined && mirrors.npm !== null) !== (files.npmMirrorConf !== undefined)) {
    throw setupError(
      `Server generation is corrupt: ${NPM_MIRROR_CONF_NAME} does not match the persisted server config.`,
    );
  }
  if (
    (dockerMirrorLogin(mirrors?.docker ?? null) === undefined) !==
    (secrets.dockerHubToken === undefined)
  ) {
    throw setupError(
      "Server secrets are corrupt: a Docker Hub login needs both MEND_DOCKER_HUB_USERNAME and MEND_DOCKER_HUB_TOKEN.",
    );
  }
  if (files.mirrors === undefined) return [];
  for (const service of mirrorServices(mirrors)) {
    if (!files.mirrors.includes(`\n  ${service}:\n`))
      throw setupError(
        `Server generation is corrupt: ${MIRRORS_COMPOSE_FILE} does not run the ${service} its config declares.`,
      );
  }
  if (
    (mirrors !== undefined && mirrors.docker !== null) !==
    (files.dockerMirrorGuard !== undefined)
  ) {
    throw setupError(
      `Server generation is corrupt: ${DOCKER_MIRROR_GUARD_NAME} does not match the persisted server config.`,
    );
  }
  if (
    files.dockerMirrorGuard !== undefined &&
    !files.dockerMirrorGuard.includes("registry serve /etc/distribution/config.yml")
  )
    throw setupError(
      `Server generation is corrupt: ${DOCKER_MIRROR_GUARD_NAME} is not the Docker mirror's guard.`,
    );
  if (files.npmMirrorConf !== undefined && !files.npmMirrorConf.includes("proxy_cache npm;"))
    throw setupError(
      `Server generation is corrupt: ${NPM_MIRROR_CONF_NAME} is not the npm mirror's configuration.`,
    );
  return mirrorImagesOf(files.mirrors);
};

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
    const edgeImage = validateOverlays(config, generation.files);
    const mirrorImages = validateMirrors(config, secrets, generation.files);
    return {
      _tag: "ok",
      value: {
        config,
        directory: generation.directory,
        ...(edgeImage === undefined ? {} : { edgeImage }),
        ...(mirrorImages.length === 0 ? {} : { mirrorImages }),
      },
    };
  } catch (cause) {
    return {
      _tag: "error",
      error: new ServerStoreError(
        cause instanceof Error ? cause.message : "Could not read server installation.",
      ),
    };
  }
};

/** The active generation as `mend doctor --bundle` reports it: config, compose, `.env` KEYS only. */
export interface ServerInstallationFacts {
  readonly directory: string;
  readonly config: ServerConfig;
  readonly compose: string;
  /** The generation's overlays beside compose.yaml, by file name; none carries a value. */
  readonly overlays: ReadonlyArray<{ readonly name: string; readonly content: string }>;
  readonly envKeys: ReadonlyArray<string>;
}

/** The KEY of every `KEY=value` line; comments and blanks are not keys. */
export const envKeyNames = (env: string): ReadonlyArray<string> =>
  env.split("\n").flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });

/**
 * Read the active generation under the same lock every lifecycle command holds, then let go: the
 * bundle's Docker reads run unlocked. Null when this machine has a store but no active
 * generation; a missing store or a busy lock throws with the store's own words.
 */
export const readServerInstallationFacts = async (
  configDir: string,
): Promise<ServerInstallationFacts | null> => {
  const result = await withServerStore(
    configDir,
    async (store) => {
      const installation = storeValue(readServerInstallation(store));
      if (installation === null) return null;
      const generation = storeValue(store.readActive());
      if (generation === null) return null;
      return {
        directory: installation.directory,
        config: installation.config,
        compose: generation.files.compose,
        overlays: [
          ...(generation.files.edge === undefined
            ? []
            : [{ name: "compose.edge.yaml", content: generation.files.edge }]),
          ...(generation.files.caddyfile === undefined
            ? []
            : [{ name: "Caddyfile", content: generation.files.caddyfile }]),
          ...(generation.files.posture === undefined
            ? []
            : [{ name: "compose.posture.yaml", content: generation.files.posture }]),
          ...(generation.files.mirrors === undefined
            ? []
            : [{ name: MIRRORS_COMPOSE_FILE, content: generation.files.mirrors }]),
          ...(generation.files.npmMirrorConf === undefined
            ? []
            : [{ name: NPM_MIRROR_CONF_NAME, content: generation.files.npmMirrorConf }]),
          ...(generation.files.dockerMirrorGuard === undefined
            ? []
            : [{ name: DOCKER_MIRROR_GUARD_NAME, content: generation.files.dockerMirrorGuard }]),
          ...(generation.files.t3Gateway === undefined
            ? []
            : [{ name: "compose.t3.yaml", content: generation.files.t3Gateway }]),
        ],
        envKeys: envKeyNames(generation.files.env),
      };
    },
    { create: false },
  );
  if (result._tag === "error") throw result.error;
  return result.value;
};

/**
 * Every file of a generation, from one config: the release assets, `server.env`, and the overlays
 * the config declares. Setup and upgrade both render through here, so whatever a config carries
 * (the edge, the posture, the mirrors) reaches every generation written from it.
 */
const generationFiles = (
  config: ServerConfig,
  secrets: ServerSecrets,
  assets: { readonly compose: string; readonly postgresInit: string },
  identity: string = renderIdentity(secrets),
): ServerFiles => {
  const posture = renderPostureOverlay(config);
  const mirrors = renderMirrorsOverlay(config.mirrors);
  const t3Gateway = renderT3GatewayOverlay(config);
  return {
    identity,
    config: `${JSON.stringify(config, null, 2)}\n`,
    env: renderSecrets(secrets, config),
    ...assets,
    ...(posture === undefined ? {} : { posture }),
    ...(t3Gateway === undefined ? {} : { t3Gateway }),
    ...(config.edgeHost === undefined
      ? {}
      : { edge: EDGE_COMPOSE_OVERLAY, caddyfile: EDGE_CADDYFILE }),
    ...(mirrors === undefined ? {} : { mirrors }),
    ...(config.mirrors === undefined || config.mirrors.npm === null
      ? {}
      : { npmMirrorConf: NPM_MIRROR_CONF }),
    ...(config.mirrors === undefined || config.mirrors.docker === null
      ? {}
      : { dockerMirrorGuard: DOCKER_MIRROR_GUARD }),
  };
};

const persistSetup = (
  store: ServerStore,
  config: ServerConfig,
  secrets: ServerSecrets,
  assets: { readonly compose: string; readonly postgresInit: string },
): ServerGeneration => storeValue(store.prepare(generationFiles(config, secrets, assets)));

/**
 * Where this machine reads Mend's health: the advertised origin, or, behind the edge, Mend's own
 * port on loopback. The edge's name resolves to a public address that may not route back to this
 * host, and what the probe asks is whether the Mend container answers with the pinned version.
 */
const healthOrigin = (config: ServerConfig): string => {
  if (config.edgeHost === undefined) return config.appUrl;
  const host = net.isIP(config.bind) === 6 ? `[${config.bind}]` : config.bind;
  return `http://${host}:${config.appPort}`;
};

/** What setup and start say once health answered: where it answered, and the edge's origin. */
const reachableLine = (config: ServerConfig): string =>
  config.edgeHost === undefined
    ? `Mend ${config.serverVersion} is reachable at ${config.appUrl}`
    : `Mend ${config.serverVersion} answers at ${healthOrigin(config)} on this machine · the edge is set up for ${config.appUrl}`;

/** How long setup watches for the gateway after Mend answered: it starts once Mend is ready. */
const T3_GATEWAY_OBSERVE_ATTEMPTS = 15;

/**
 * Whether the t3code gateway answers on its loopback port, from this machine, within about 30 s
 * of Mend answering (review 644-1): what was observed, never that it listens because it was
 * asked to. Its absence never fails setup; Mend runs without it.
 */
const observeT3Gateway = async (runtime: ServerSetupRuntime, port: number): Promise<string> => {
  const url = `http://127.0.0.1:${port}/.well-known/t3/environment`;
  for (let attempt = 0; attempt < T3_GATEWAY_OBSERVE_ATTEMPTS; attempt += 1) {
    const response = await runtime.fetchText(url, 2_000);
    if (response.error === undefined && response.status === 200) {
      return `The t3code gateway answered at 127.0.0.1:${port}, observed from this machine; it is published there only. In t3code, add it as an environment at http://127.0.0.1:${port} and pair with a code from mend pair; reaching it from elsewhere is an exposure you put in front of it and declare (docs/adr/0004).`;
    }
    if (attempt < T3_GATEWAY_OBSERVE_ATTEMPTS - 1) await runtime.sleep(2_000);
  }
  return `The t3code gateway did not answer at 127.0.0.1:${port} from this machine within about a minute. Mend runs without it; mend server logs shows what it said, and mend server status looks again.`;
};

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

/**
 * A release's compose asset from before `--ssh-bind` publishes SSH on `--bind` and would ignore
 * `MEND_SSH_BIND_HOST`: refused, rather than a gateway quietly left where the operator moved it from.
 */
const checkSshBindAsset = (
  config: Pick<ServerConfig, "sshBind" | "serverVersion">,
  compose: string,
): void => {
  if (config.sshBind !== undefined && !compose.includes("MEND_SSH_BIND_HOST")) {
    throw setupError(
      `Mend ${config.serverVersion}'s ${COMPOSE_ASSET} publishes workspace SSH on --bind and cannot honour --ssh-bind ${config.sshBind}. Use a release that supports --ssh-bind, or pass --ssh-bind with the --bind address.`,
    );
  }
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
  installation: Pick<ServerInstallation, "config" | "edgeImage" | "mirrorImages">,
  policy: "local" | "pull-missing" = "local",
): Promise<void> => {
  const { config } = installation;
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
  if (config.t3GatewayPort !== undefined) {
    // The overlay is the CLI's, the gateway the image's: an image from before it would take the
    // overlay and run no gateway (review 644-1). Refused before the generation is activated.
    const gateway = await runtime.run("docker", [
      "--context",
      config.dockerContext,
      "image",
      "inspect",
      image,
      "--format",
      `{{index .Config.Labels "${T3_GATEWAY_IMAGE_LABEL}"}}`,
    ]);
    if (gateway.status !== 0 || gateway.stdout.trim() !== "1") {
      throw setupError(
        `Mend ${config.serverVersion} has no t3code gateway (its image carries no ${T3_GATEWAY_IMAGE_LABEL} label). Upgrade to a version that has one with mend server upgrade --version <version>, then turn it on; or run mend server setup --no-t3-gateway`,
      );
    }
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
  if (config.bucket === "garage") {
    const garage = await inspectImage(
      runtime,
      config.dockerContext,
      GARAGE_IMAGE,
      "{{.Id}}",
      policy,
    );
    if (garage.status !== 0)
      throw commandFailure(`Preload ${GARAGE_IMAGE} before continuing`, garage);
  }
  if (installation.edgeImage !== undefined) {
    const edge = await inspectImage(
      runtime,
      config.dockerContext,
      installation.edgeImage,
      "{{.Id}}",
      policy,
    );
    if (edge.status !== 0)
      throw commandFailure(`Preload ${installation.edgeImage} before continuing`, edge);
  }
  for (const mirrorImage of installation.mirrorImages ?? []) {
    const mirror = await inspectImage(
      runtime,
      config.dockerContext,
      mirrorImage,
      "{{.Id}}",
      policy,
    );
    if (mirror.status !== 0)
      throw commandFailure(`Preload ${mirrorImage} before continuing`, mirror);
  }
};

const checkComposeImages = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  const output = await runtime.run(
    "docker",
    serverComposeArgs(composeTarget(installation), ["config", "--images"]),
  );
  if (output.status !== 0) throw commandFailure("Docker Compose config failed", output);
  const images = output.stdout.trim().split(/\s+/).toSorted();
  const expected = [
    `ghcr.io/sealant-sh/mend:${installation.config.serverVersion}`,
    "postgres:17-alpine",
    ...(installation.config.bucket === "garage" ? [GARAGE_IMAGE] : []),
    ...(installation.edgeImage === undefined ? [] : [installation.edgeImage]),
    ...(installation.mirrorImages ?? []),
  ].toSorted();
  if (images.join("\n") !== expected.join("\n")) {
    throw setupError(
      `Compose must use only the canonical pinned Mend image, official postgres:17-alpine${installation.config.bucket === "garage" ? ` and ${GARAGE_IMAGE}` : ""}${installation.edgeImage === undefined ? "" : ` and the edge's ${installation.edgeImage}`}${installation.mirrorImages === undefined ? "" : ` and the mirrors' ${installation.mirrorImages.join(", ")}`}.`,
    );
  }
};

/**
 * Lay the bucket out once the containers report healthy: the single node's layout, bucket
 * `mend`, the key the compose hands Mend as AWS credentials, and the grant. Every step but the
 * last tolerates "already exists" (Garage answers 409 on a rerun), so setup, start and upgrade
 * all run it; `bucket info` is the observation that it holds. The garage image ships no shell,
 * so each step is one `docker compose exec` of the garage binary.
 */
const initGarage = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  secrets: ServerSecrets,
): Promise<void> => {
  if (installation.config.bucket !== "garage") return;
  const garage = garageSecrets(secrets);
  const exec = (args: ReadonlyArray<string>) =>
    runtime.run(
      "docker",
      serverComposeArgs(composeTarget(installation), [
        "exec",
        "-T",
        "garage",
        "/garage",
        "-c",
        "/etc/garage.toml",
        ...args,
      ]),
      { timeoutMs: serverProcessDeadlines.ordinary },
    );
  const status = await exec(["status"]);
  if (status.status !== 0 || status.error !== undefined)
    throw commandFailure("Garage did not answer its status", status);
  const node = status.stdout.match(/^([0-9a-f]{16})\s/m)?.[1];
  if (node === undefined) throw setupError("Garage reported no node in `garage status`.");
  // Tolerated: a layout already applied, a bucket or key that already exists.
  await exec(["layout", "assign", "-z", "mend", "-c", "1GB", node]);
  await exec(["layout", "apply", "--version", "1"]);
  await exec(["bucket", "create", GARAGE_BUCKET]);
  await exec(["key", "import", "--yes", "-n", GARAGE_BUCKET, garage.keyId, garage.keySecret]);
  await exec([
    "bucket",
    "allow",
    "--read",
    "--write",
    "--owner",
    GARAGE_BUCKET,
    "--key",
    GARAGE_BUCKET,
  ]);
  const info = await exec(["bucket", "info", GARAGE_BUCKET]);
  if (info.status !== 0 || info.error !== undefined || !info.stdout.includes(garage.keyId))
    throw commandFailure(`Garage bucket ${GARAGE_BUCKET} is not readable by Mend's key`, info);
  runtime.writeLine(`Capture store bucket ${GARAGE_BUCKET} is laid out in Garage`);
};

const startingNotice = (runtime: ServerSetupRuntime, version: string): void =>
  runtime.writeLine(
    `Starting Mend ${version} containers; Docker waits up to ${serverProcessDeadlines.composeWaitSeconds}s for them to report healthy`,
  );

/** A service this project may still have a container of after its config stopped running it. */
interface StrayService {
  readonly service: string;
  /** How the container is named in what the operator reads. */
  readonly label: string;
  /** What it may still hold while it runs, said when it could not be removed. */
  readonly holds: string;
}

/** The optional services this generation does not run: the edge, and each mirror turned off. */
const strayServices = (config: ServerConfig): ReadonlyArray<StrayService> => [
  ...(config.edgeHost === undefined
    ? [{ service: "edge", label: "edge", holds: "It may still hold 80 and 443." }]
    : []),
  ...(config.mirrors?.npm === null
    ? [{ service: "npm-mirror", label: "npm mirror", holds: "It keeps running beside Mend." }]
    : []),
  ...(config.mirrors?.docker === null
    ? [{ service: "docker-mirror", label: "Docker mirror", holds: "It keeps running beside Mend." }]
    : []),
];

/**
 * A container this project still has for a service its config no longer runs: the edge, or a
 * mirror turned off. The `up` that drops the service does not know it any more, so Compose leaves
 * its container running, and Caddy keeps 80 and 443 until something removes it. Every start looks
 * for one, by this project's and this service's labels and nothing wider, and removes it, so a start
 * that failed part-way is set right by the next one. A service the config runs, or one without a
 * stray container, changes nothing here.
 */
const removeStrayServices = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  for (const stray of strayServices(installation.config))
    await removeStrayService(runtime, installation, stray);
};

const removeStrayService = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  stray: StrayService,
): Promise<void> => {
  const context = installation.config.dockerContext;
  // Never fatal: this runs after a restart or an upgrade stopped Mend, and a listing the daemon
  // refuses must not keep Mend down. What could not be done is said, and status shows the rest.
  const listed = await runtime.run("docker", [
    "--context",
    context,
    "container",
    "ls",
    "--all",
    "--filter",
    "label=com.docker.compose.project=mend",
    "--filter",
    `label=com.docker.compose.service=${stray.service}`,
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  if (listed.status !== 0 || listed.error !== undefined) {
    runtime.writeLine(
      `Could not list this project's containers: ${outputDetail(listed)}. An ${stray.label} container left by an earlier generation, if any, stays until the next start. mend server status shows it.`,
    );
    return;
  }
  // Only a container Compose started from one of this installation's generations is this
  // installation's: the working directory label names the generation it ran from. A project of the
  // same name run from somewhere else keeps its container.
  const generations = path.dirname(installation.directory);
  let resolvedGenerations = generations;
  try {
    resolvedGenerations = fs.realpathSync(generations);
  } catch {
    resolvedGenerations = generations;
  }
  const own = (workingDir: string): boolean =>
    [generations, resolvedGenerations].some((root) => workingDir.startsWith(`${root}${path.sep}`));
  const rows = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", workingDir = ""] = line.split("\t");
      return { name, workingDir };
    })
    .filter((row) => row.name !== "");
  const label = stray.label.charAt(0).toUpperCase() + stray.label.slice(1);
  for (const row of rows.filter((candidate) => !own(candidate.workingDir))) {
    runtime.writeLine(
      `${label} container ${row.name} was started from ${row.workingDir || "an unknown directory"}, not from this installation's generations. It stays.`,
    );
  }
  const names = rows.filter((row) => own(row.workingDir)).map((row) => row.name);
  if (names.length === 0) return;
  const removed = await runtime.run("docker", [
    "--context",
    context,
    "container",
    "rm",
    "--force",
    ...names,
  ]);
  if (removed.status !== 0 || removed.error !== undefined) {
    runtime.writeLine(
      `Could not remove the ${stray.label} container ${names.join(", ")}: ${outputDetail(removed)}. ${stray.holds} To remove it: docker --context ${context} container rm --force ${names.join(" ")}`,
    );
    return;
  }
  runtime.writeLine(
    `Removed the ${stray.label} container ${names.join(", ")}, which this generation does not run.`,
  );
};

const startCompose = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  await removeStrayServices(runtime, installation);
  startingNotice(runtime, installation.config.serverVersion);
  const compose = await runtime.run(
    "docker",
    serverComposeArgs(composeTarget(installation), [
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

/** How long setup waits for its look at workspace SSH, all addresses together. */
export const SSH_PROBE_BOUND_MS = 10_000;

/**
 * What this machine observed of workspace SSH published apart from the web port: where it was
 * tried and what answered. It says nothing about who else can reach it; that is the network's, and
 * the gate's workspace-ssh item reports it as declared or open.
 */
const sshPublicationLine = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
): Promise<string | null> => {
  if (config.sshBind === undefined || isLoopbackBind(config.sshBind)) return null;
  const published = publishedAddress(config.sshBind, config.sshPort);
  if (runtime.probeSsh === undefined) return null;
  // Bounded as a whole: setup must finish whatever a probe does.
  const boundMs = runtime.sshProbeBoundMs ?? SSH_PROBE_BOUND_MS;
  let bound: ReturnType<typeof setTimeout> | undefined;
  const probes = await Promise.race([
    runtime.probeSsh(config.sshBind, config.sshPort),
    new Promise<null>((resolve) => {
      bound = setTimeout(() => resolve(null), boundMs);
    }),
  ]).finally(() => clearTimeout(bound));
  if (probes === null) {
    return `Workspace SSH is published on ${published}. This machine's look at it did not finish within ${boundMs / 1000} s. Who reaches it is up to the network and its firewall; mend operator exposure reports it as workspace-ssh.`;
  }
  const observed =
    probes.length === 0
      ? "this machine has no address to try it at"
      : probes
          .map((probe) =>
            probe.banner === null
              ? `${publishedAddress(probe.address, config.sshPort)} did not answer`
              : `${publishedAddress(probe.address, config.sshPort)} answers (${probe.banner})`,
          )
          .join(", ");
  return `Workspace SSH is published on ${published}. From this machine: ${observed}. Who else reaches it is up to the network and its firewall; mend operator exposure reports it as workspace-ssh.`;
};

/** What setup says once the edge's container is up: what Caddy does next, and where to read it. */
const edgeStartedLine = (config: ServerConfig): string | null =>
  config.edgeHost === undefined
    ? null
    : `The edge for ${config.edgeHost} is up on 80 and 443. Caddy asks for its certificate once ${config.edgeHost} resolves to this machine and both ports reach it from the Internet. mend server status says whether it holds one, and mend server logs shows what Caddy tried.${
        config.sshBind === undefined
          ? ` Workspace SSH is published on ${config.bind}:${config.sshPort} only, so Remote-SSH and mend ssh from another machine cannot reach it; --ssh-bind 0.0.0.0 publishes it.`
          : ` Workspace SSH is published on ${config.sshBind}:${config.sshPort}.`
      }`;

/**
 * The Docker mirror's Docker Hub token: read from standard input with `--docker-hub-token-stdin`,
 * else the one this install keeps in `server.env` while its login stays, else none. Never taken
 * from argv or the environment, and never written anywhere but `server.env`.
 */
const resolveDockerHubToken = async (
  runtime: ServerSetupRuntime,
  options: SetupOptions,
  mirrors: ServerMirrors,
  store: ServerStore,
): Promise<string | undefined> => {
  if (dockerMirrorLogin(mirrors.docker) === undefined) return undefined;
  if (options.dockerHubTokenStdin) {
    if (runtime.readStdin === undefined)
      throw setupError("--docker-hub-token-stdin needs standard input, and none is available.");
    const token = (await runtime.readStdin()).trim();
    if (!isDockerHubCredential(token))
      throw setupError(
        "--docker-hub-token-stdin read no Docker Hub access token: pipe the token alone, such as a personal access token (dckr_pat_…).",
      );
    return token;
  }
  const active = storeValue(store.readActive());
  return active === null ? undefined : parseSecrets(active.files.env).dockerHubToken;
};

/** What setup says when a mirror was turned on or off, and where an off mirror's cache stays. */
const mirrorsChangedLines = (
  before: ServerMirrors | undefined,
  config: ServerConfig,
): ReadonlyArray<string> => {
  const after = config.mirrors;
  if (after === undefined) return [];
  const lines: Array<string> = [];
  const said = (name: string, was: boolean, is: boolean, volume: string, reach: string): void => {
    if (is && !was) lines.push(`The ${name} runs on this install. ${reach}`);
    if (was && !is)
      lines.push(
        `The ${name} is off. Its cache stays until you remove it: docker --context ${config.dockerContext} volume rm ${volume}`,
      );
  };
  // A config from before the mirrors had neither.
  said(
    "npm mirror",
    before !== undefined && before.npm !== null,
    after.npm !== null,
    "mend_mend-npm-mirror",
    `New sessions install npm packages through it, capped at ${after.npm?.maxSize ?? ""}.`,
  );
  said(
    "Docker mirror",
    before !== undefined && before.docker !== null,
    after.docker !== null,
    "mend_mend-docker-mirror",
    `New sessions' Docker daemons pull Docker Hub images through it (${DOCKER_MIRROR_CONTAINER}).`,
  );
  return lines;
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
  const mirrors = resolveMirrors(existing?.config.mirrors, options);
  const configWithoutBucket: ServerConfig = {
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
    mirrors,
  };
  const dockerHubToken = await resolveDockerHubToken(runtime, options, mirrors, store);
  const assets = await resolveAssets(runtime, serverVersion, existing, store, options);
  checkSshBindAsset(configWithoutBucket, assets.compose);
  const bucket = composeBucket(assets.compose);
  // Capture workspaces save on a stop within their long stop grace; a daemon shutdown gives them
  // only the daemon's own timeout. Said once here, where the operator can still raise it.
  if (bucket !== undefined && runtime.dockerDaemonFacts !== undefined) {
    const info = await runtime.run("docker", [
      "--context",
      selectedContext.name,
      "info",
      "--format",
      "{{json .}}",
    ]);
    const line = dockerShutdownSetupLine(
      readShutdownTimeout(runtime.dockerDaemonFacts(info.status === 0 ? info.stdout : null)),
    );
    if (line !== null) runtime.writeLine(line);
  }
  const config: ServerConfig = {
    ...configWithoutBucket,
    ...(bucket === undefined ? {} : { bucket }),
  };
  // Until the first account exists, registration is open to whoever arrives first, and the
  // server refuses `public` without an operator (ADR 0004, decision 16). Said before anything
  // is written, with the order that works.
  if (existing === null && (config.edgeHost !== undefined || config.exposure === "public")) {
    throw setupError(
      `A fresh install cannot start with the edge or as public: until the first account exists, registration is open to whoever reaches the origin first, and the server refuses MEND_EXPOSURE=public without an operator account. Run mend server setup without --edge and --exposure public, create the first account at http://localhost:${config.appPort}, then run mend server setup --edge <host> and declare the posture.`,
    );
  }
  const secrets: ServerSecrets = {
    ...(savedSecrets ?? createSecrets(runtime)),
    ...(dockerHubToken === undefined ? {} : { dockerHubToken }),
  };
  // A port something else holds would keep the whole mend container from starting, gateway and
  // all: refused here, before anything changes, rather than Mend not coming up (review nit).
  // Checked on this machine's daemon only, and only for a port the gateway does not have yet.
  if (
    config.t3GatewayPort !== undefined &&
    config.t3GatewayPort !== existing?.config.t3GatewayPort &&
    config.dockerEndpoint.startsWith("unix://") &&
    runtime.portTaken !== undefined &&
    (await runtime.portTaken(config.t3GatewayPort))
  ) {
    throw setupError(
      `127.0.0.1:${config.t3GatewayPort} is already in use on this machine, so the t3code gateway cannot be published there and Mend would not start. Free it, or pick another with --t3-gateway-port <n>`,
    );
  }
  const generation = persistSetup(store, config, secrets, assets);
  const installation: ServerInstallation = {
    directory: generation.directory,
    config,
    ...(generation.files.edge === undefined
      ? {}
      : { edgeImage: edgeImageOf(generation.files.edge) }),
    ...(generation.files.mirrors === undefined
      ? {}
      : { mirrorImages: mirrorImagesOf(generation.files.mirrors) }),
  };
  await checkComposeImages(runtime, installation);
  const ownership = await claimServerDockerVolumes(runtime, {
    dockerContext: config.dockerContext,
    identityBytes: Buffer.from(generation.files.identity),
    namespace: namespaceOf(config),
  });
  if (ownership._tag === "error") throw setupError(ownership.error.message);
  await checkLocalImages(runtime, installation, options.offline ? "local" : "pull-missing");
  const userNamespaces = await hostUserNamespacesLine(
    runtime,
    config.dockerContext,
    `ghcr.io/sealant-sh/mend:${config.serverVersion}`,
  );
  storeValue(store.activate(generation));
  await startCompose(runtime, installation);
  await initGarage(runtime, installation, secrets);
  await probeHealth(runtime, healthOrigin(config), config.serverVersion);
  runtime.writeLine(reachableLine(config));
  const edgeStarted = edgeStartedLine(config);
  if (edgeStarted !== null) runtime.writeLine(edgeStarted);
  const sshPublication = await sshPublicationLine(runtime, config);
  if (sshPublication !== null) runtime.writeLine(sshPublication);
  if (config.t3GatewayPort !== undefined) {
    runtime.writeLine(await observeT3Gateway(runtime, config.t3GatewayPort));
  }
  if (existing?.config.t3GatewayPort !== undefined && config.t3GatewayPort === undefined) {
    runtime.writeLine(
      `The t3code gateway is off. Its state (pairings and the device tokens they hold, queued messages) stays in its volume and comes back if you turn it on again; to remove it: docker --context ${config.dockerContext} volume rm mend_${T3_GATEWAY_VOLUME}`,
    );
  }
  if (existing?.config.edgeHost !== undefined && config.edgeHost === undefined) {
    runtime.writeLine(
      `The edge for ${existing.config.edgeHost} is gone. Its certificate volumes stay until you remove them: docker --context ${config.dockerContext} volume rm mend_mend-edge-data mend_mend-edge-config`,
    );
  }
  for (const line of mirrorsChangedLines(existing?.config.mirrors, config)) runtime.writeLine(line);
  runtime.writeLine(
    `Open ${config.appUrl}, create the first account, then run: mend login --url ${config.appUrl}`,
  );
  // Last, where it is read: the server runs, but its sessions cannot until this is changed.
  if (userNamespaces !== null) runtime.writeLine(userNamespaces);
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
      composeTarget(installation),
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
  secrets: ServerSecrets,
): Promise<void> => {
  await removeStrayServices(runtime, installation);
  startingNotice(runtime, installation.config.serverVersion);
  await composeCommand(runtime, installation, [
    "up",
    "-d",
    "--wait",
    "--pull",
    "never",
    "--no-build",
  ]);
  await initGarage(runtime, installation, secrets);
  await probeHealth(runtime, healthOrigin(installation.config), installation.config.serverVersion);
  runtime.writeLine(reachableLine(installation.config));
};

/** How many completed upgrade backups an upgrade keeps, its own included, unless told otherwise. */
const DEFAULT_KEEP_BACKUPS = 2;

const parseUpgradeOptions = (
  args: ReadonlyArray<string>,
): SetupOptions & { readonly fromPreview: boolean; readonly keepBackups: number } => {
  const fromPreview = args.includes("--from-preview");
  const rest: Array<string> = [];
  let keepBackups = DEFAULT_KEEP_BACKUPS;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || flag === "--from-preview") continue;
    if (flag === "--keep-backups") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw setupError(
          "--keep-backups takes a whole number: how many upgrade backups to keep, 0 for all.",
        );
      keepBackups = Number(value);
      index += 1;
      continue;
    }
    rest.push(flag);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--offline") continue;
    if (flag !== "--version" && flag !== "--assets-dir")
      throw setupError(`Unknown server upgrade option "${flag}".`);
    index += 1;
  }
  const options = parseSetupOptions(rest);
  if (options.version === undefined)
    throw setupError(
      "Upgrade requires --version TARGET. Use --version latest only to request the latest release explicitly.",
    );
  return { ...options, fromPreview, keepBackups };
};

/** Bytes as people read them, in binary units. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

/** Why a backup stayed, in the words the operator reads. */
const heldReason = (entry: HeldBackup): string => {
  switch (entry.reason) {
    case "pending":
      return "pending: its upgrade never recorded a healthy target";
    case "unfinished":
      return "unfinished: no complete database dump";
    case "no-outcome":
      return "no recorded outcome: written after a 0.36 backup by a CLI that records none";
    case "unreadable":
      return `unreadable: ${entry.detail ?? "not read"}`;
  }
};

/**
 * After a healthy upgrade: record it, then keep the newest `keep` completed backups (0 keeps all).
 * The upgrade already succeeded, so a pruning failure is reported and never fails the command.
 */
const pruneUpgradeBackups = (
  runtime: ServerSetupRuntime,
  store: ServerStore,
  backup: ServerBackup,
  keep: number,
): void => {
  const marked = backup.markCompleted();
  if (marked._tag === "error") {
    runtime.writeLine(
      `Could not record the upgrade as completed in ${backup.directory}/recovery.json; no backups were removed. ${marked.error.message}`,
    );
    return;
  }
  if (keep === 0) {
    runtime.writeLine("Upgrade backups · all kept (--keep-backups 0)");
    return;
  }
  const pruned = store.pruneBackups(keep, backup, upgradeOrder);
  if (pruned._tag === "error") {
    runtime.writeLine(`Upgrade backups · not pruned: ${pruned.error.message}`);
    return;
  }
  const { removed, kept, held, failed, unsynced } = pruned.value;
  for (const entry of removed)
    runtime.writeLine(
      `Removed upgrade backup ${entry.directory} · ${formatBytes(entry.bytes)}${
        entry.interrupted
          ? " · finishing a removal a crash cut short"
          : entry.legacy
            ? " · from before 0.36, no recorded outcome"
            : ""
      }`,
    );
  const freed = removed.reduce((total, entry) => total + entry.bytes, 0);
  runtime.writeLine(
    `Upgrade backups · removed ${removed.length}${removed.length > 0 ? ` · ${formatBytes(freed)} freed` : ""} · kept ${kept.length} (--keep-backups ${keep})`,
  );
  for (const entry of failed)
    runtime.writeLine(`Could not remove upgrade backup ${entry.directory}: ${entry.message}`);
  if (unsynced !== undefined)
    runtime.writeLine(`Upgrade backups · removals made but not fsynced: ${unsynced}`);
  for (const entry of held)
    runtime.writeLine(`Kept upgrade backup ${entry.directory} · ${heldReason(entry)}`);
};

/**
 * Previews built before the `next` channel (ADR 0015) were numbered X.Y.Z-preview.K, which sorts
 * above every X.Y.Z-next.N and every new-style X.Y.Z-next.N.preview.R: `preview` comes after
 * `next`. A server on one could take neither until X.Y.Z itself. `--from-preview` moves it once, to
 * either, of the same X.Y.Z, after checking the target against every migration the server applied.
 */
const LEGACY_PREVIEW = /^(\d+\.\d+\.\d+)-preview\.(0|[1-9]\d*)$/;
const NEXT_BUILD = /^(\d+\.\d+\.\d+)-next\.(0|[1-9]\d*)(\.preview\.[1-9]\d*)?$/;

export const isPreviewToNext = (from: string, to: string): boolean => {
  const preview = LEGACY_PREVIEW.exec(from);
  const next = NEXT_BUILD.exec(to);
  return preview !== null && next !== null && preview[1] === next[1];
};

/** The order upgrades move in: by version, except that X.Y.Z-preview.K comes before X.Y.Z-next.N. */
const upgradeOrder = (a: string, b: string): number => {
  if (isPreviewToNext(a, b)) return -1;
  if (isPreviewToNext(b, a)) return 1;
  return compareServerVersions(a, b);
};

/**
 * A Mend migration as Effect's migrator stores it: the record key `0107_turn_payer` becomes
 * migration_id 107 and name `turn_payer` in `mend_migrations`.
 */
interface MendMigration {
  readonly id: number;
  readonly name: string;
}

/** A row of Sealant's drizzle journal: its folder name (empty on old rows), folder time and hash. */
interface SealantMigration {
  readonly name: string;
  readonly createdAt: string;
  readonly hash: string;
}

/** Drizzle's folder time: the first 14 digits of the folder name, read as UTC. */
const drizzleMillis = (folder: string): string => {
  const at = (start: number, end: number) => Number(folder.slice(start, end));
  return String(Date.UTC(at(0, 4), at(4, 6) - 1, at(6, 8), at(8, 10), at(10, 12), at(12, 14)));
};

const mendKey = (migration: MendMigration): string =>
  `${String(migration.id).padStart(4, "0")}_${migration.name}`;

/**
 * Why the target image cannot take this server's databases, one line per migration. `manifest` is
 * the image's /app/migrations.txt: `mend <id>_<name>` and `sealant <folder> <sha256>` lines.
 *
 * - A Mend migration the server applied that the target lacks, by id and name.
 * - A Mend migration the target has at or below the highest id applied that the server never ran:
 *   Effect's migrator runs only ids above the highest applied, so it would be skipped for good.
 * - A Sealant migration the server applied that the target lacks (by folder, or by folder time on
 *   an old row without a name), or whose SQL changed since (drizzle's hash).
 *
 * Not detectable: a Mend migration whose code changed under the same id and name. Mend stores no
 * hash of it.
 */
export const migrationProblems = (
  applied: {
    readonly mend: ReadonlyArray<MendMigration>;
    readonly sealant: ReadonlyArray<SealantMigration>;
  },
  manifest: string,
): ReadonlyArray<string> => {
  const mend = new Map<number, string>();
  const sealant = new Map<string, string>();
  const sealantTimes = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    const [kind, entry, hash = ""] = line.trim().split(/\s+/);
    if (entry === undefined) continue;
    if (kind === "mend") {
      const match = /^(\d+)_(.+)$/.exec(entry);
      if (match?.[1] !== undefined && match[2] !== undefined) mend.set(Number(match[1]), match[2]);
    }
    if (kind === "sealant") {
      sealant.set(entry, hash);
      sealantTimes.set(drizzleMillis(entry), hash);
    }
  }
  const problems: Array<string> = [];
  for (const migration of applied.mend) {
    if (mend.get(migration.id) !== migration.name)
      problems.push(`mend ${mendKey(migration)} is applied here and not in the target`);
  }
  const appliedIds = new Set(applied.mend.map((migration) => migration.id));
  const highest = Math.max(0, ...appliedIds);
  for (const [id, name] of [...mend].toSorted(([a], [b]) => a - b)) {
    if (id <= highest && !appliedIds.has(id))
      problems.push(
        `mend ${mendKey({ id, name })} would never run: this server already applied ${highest}`,
      );
  }
  for (const row of applied.sealant) {
    const label = row.name === "" ? `(created ${row.createdAt})` : row.name;
    const hash = row.name === "" ? sealantTimes.get(row.createdAt) : sealant.get(row.name);
    if (hash === undefined) problems.push(`sealant ${label} is applied here and not in the target`);
    else if (hash !== row.hash)
      problems.push(`sealant ${label} changed after this server applied it`);
  }
  return problems;
};

const psqlRows = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  database: string,
  query: string,
): Promise<ReadonlyArray<string>> => {
  const output = await composeCommand(runtime, installation, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username=postgres",
    `--dbname=${database}`,
    "--no-align",
    "--tuples-only",
    "--field-separator=|",
    "--command",
    query,
  ]);
  return output.stdout.split("\n").filter((line) => line.trim().length > 0);
};

/**
 * Before `--from-preview` touches anything: read what the server applied, from both databases, and
 * what the target image carries. Refuses, with the names, when the target lacks any of them.
 */
const checkPreviewMigrations = async (
  runtime: ServerSetupRuntime,
  existing: ServerInstallation,
  target: ServerConfig,
): Promise<void> => {
  const image = `ghcr.io/sealant-sh/mend:${target.serverVersion}`;
  const listed = await runtime.run(
    "docker",
    [
      "--context",
      target.dockerContext,
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      image,
      "/app/migrations.txt",
    ],
    { timeoutMs: serverProcessDeadlines.ordinary },
  );
  if (listed.status !== 0 || listed.error !== undefined || listed.stdout.trim() === "")
    throw setupError(
      `${image} does not list its migrations (/app/migrations.txt), so --from-preview cannot check them. Nothing was changed.`,
    );
  await composeCommand(runtime, existing, [
    "up",
    "-d",
    "--wait",
    "--pull",
    "never",
    "--no-build",
    "postgres",
  ]);
  const mend = (
    await psqlRows(
      runtime,
      existing,
      "mend",
      "select migration_id, name from mend_migrations order by migration_id",
    )
  ).map((line) => {
    const [id = "", name = ""] = line.split("|");
    return { id: Number(id), name };
  });
  const sealant = (
    await psqlRows(
      runtime,
      existing,
      "sealant_control_plane",
      "select coalesce(name, ''), created_at, hash from drizzle.__drizzle_migrations order by id",
    )
  ).map((line) => {
    const [name = "", createdAt = "", hash = ""] = line.split("|");
    return { name, createdAt, hash };
  });
  const problems = migrationProblems({ mend, sealant }, listed.stdout);
  if (problems.length > 0)
    throw setupError(
      `${image} cannot take this server's databases (${problems.length}): ${problems.join("; ")}. Choose a build that contains every migration this server applied. Nothing was changed.`,
    );
  runtime.writeLine(
    `${image} carries all ${mend.length + sealant.length} migrations this server applied.`,
  );
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
  const previewToNext = isPreviewToNext(existing.config.serverVersion, version);
  if (options.fromPreview && !previewToNext)
    throw setupError(
      "--from-preview moves a server on X.Y.Z-preview.K to a next build or a new-style preview of the same version (X.Y.Z-next.N, X.Y.Z-next.N.preview.R), and nothing else.",
    );
  if (order < 0 && !options.fromPreview)
    throw setupError(
      `Refusing downgrade from ${existing.config.serverVersion} to ${version}. Database migrations may not be reversible.${
        previewToNext
          ? ` ${existing.config.serverVersion} is a preview numbered before the next channel. To move to the next channel once, run mend server upgrade --version ${version} --from-preview; it first checks that ${version} carries every migration this server applied.`
          : ""
      }`,
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
  checkSshBindAsset({ ...existing.config, serverVersion: version }, assets.compose);
  // The target generation is always on the current contract: a v1 install loses its registry
  // port here (v2 bundles publish none) while its identity, and so its volume ownership, is
  // carried over byte for byte. The bucket follows the target's compose asset: an upgrade
  // across the capture store gains Garage here and claims its volume below.
  const {
    registryPort: _legacyRegistryPort,
    bucket: _previousBucket,
    ...carried
  } = existing.config;
  const bucket = composeBucket(assets.compose);
  const config: ServerConfig = {
    ...carried,
    assetContract: ASSET_CONTRACT,
    serverVersion: version,
    ...(bucket === undefined ? {} : { bucket }),
    // An install from before the mirrors gains both here; one that turned a mirror off keeps it off.
    mirrors: carried.mirrors ?? DEFAULT_MIRRORS,
  };
  // The identity has no Docker Hub token; a login the install keeps is read from its server.env.
  const previousToken = parseSecrets(previous.files.env).dockerHubToken;
  const secrets: ServerSecrets = {
    ...parseSecrets(previous.files.identity),
    ...(previousToken === undefined ? {} : { dockerHubToken: previousToken }),
  };
  // The edge and the posture are in `carried`, so the target renders the same overlays from the
  // same config, with this CLI's copy of the edge files. Identity bytes come only from the old
  // generation.
  const files = generationFiles(config, secrets, assets, previous.files.identity);
  // Parse the proposed pair before publication.
  const parsed = parseServerConfig(files.config);
  if (renderSecrets(parseSecrets(files.env), parsed) !== files.env)
    throw setupError("Invalid upgrade configuration.");
  const edgeImage = {
    ...(files.edge === undefined ? {} : { edgeImage: edgeImageOf(files.edge) }),
    ...(files.mirrors === undefined ? {} : { mirrorImages: mirrorImagesOf(files.mirrors) }),
  };
  await checkLocalImages(
    runtime,
    { config, ...edgeImage },
    options.offline ? "local" : "pull-missing",
  );
  await checkComposeImages(runtime, existing);
  // The previous generation stays the real preview, so a failure before activation recovers it.
  if (options.fromPreview) await checkPreviewMigrations(runtime, existing, config);
  const target = storeValue(store.prepare(files));
  const installation: ServerInstallation = { directory: target.directory, config, ...edgeImage };
  await checkComposeImages(runtime, installation);
  // The Garage volume arrives with the bundle that carries it: claim it under the unchanged
  // identity before anything starts. Claiming is idempotent for the volumes that already exist.
  if (config.bucket === "garage" && existing.config.bucket !== "garage") {
    const ownership = await claimServerDockerVolumes(runtime, {
      dockerContext: config.dockerContext,
      identityBytes: Buffer.from(previous.files.identity),
      namespace: namespaceOf(config),
    });
    if (ownership._tag === "error") throw setupError(ownership.error.message);
  }
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
      serverComposeArgs(composeTarget(existing), [
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
        await startInstallation(runtime, existing, secrets);
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
    await startInstallation(runtime, installation, secrets);
  } catch {
    throw setupError(
      `Mend ${version} startup, exact-version health or registry verification failed; migrations may have begun. The target pin remains active. Do NOT downgrade or restore the database automatically. Run mend server logs --tail 100 and mend server status; fix the target, then mend server start --offline. Previous generation: ${previous.directory}. Target generation: ${target.directory}. Database backup and recovery record: ${backup.directory}.`,
    );
  }
  runtime.writeLine(`Upgraded to ${version}. Retained database backup: ${backup.directory}`);
  for (const line of mirrorsChangedLines(existing.config.mirrors, config)) runtime.writeLine(line);
  pruneUpgradeBackups(runtime, store, backup, options.keepBackups);
};

/**
 * Caddy's data volume holds one directory per issuer, and under it `<host>/<host>.crt` once a
 * certificate was obtained. The path, or null when Caddy holds none for the host yet. The edge
 * image ships BusyBox, so one `sh -c` with a glob is the whole question.
 */
const observeEdgeCertificate = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  host: string,
): Promise<EdgeCertificate> => {
  const listed = await runtime.run(
    "docker",
    serverComposeArgs(composeTarget(installation), [
      "exec",
      "-T",
      "edge",
      "sh",
      "-c",
      `ls /data/caddy/certificates/*/${host}/${host}.crt`,
    ]),
    { timeoutMs: serverProcessDeadlines.ordinary },
  );
  if (listed.error !== undefined) return { kind: "unavailable", reason: listed.error };
  if (listed.status !== 0) {
    // `ls` on a glob that matched nothing: the file is not there. Anything else was not a look.
    return /No such file or directory/.test(listed.stderr)
      ? { kind: "none" }
      : {
          kind: "unavailable",
          reason: listed.stderr.trim() || `exit ${listed.status ?? "unknown"}`,
        };
  }
  const file = listed.stdout.trim().split("\n")[0];
  return file === undefined || file === "" ? { kind: "none" } : { kind: "observed", file };
};

/**
 * The operator's two gate reports, through this machine's saved sign-in when it is to this
 * install. Read over Mend's own port with the bearer, the way the health probe reads. Lines to
 * print, or the reason they could not be read, as a fact.
 */
const operatorReportLines = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<ReadonlyArray<string>> => {
  const login = runtime.readLogin?.(runtime.configDir) ?? null;
  if (login === null) {
    return [
      `gate items · every item with its detail needs the operator's sign-in on this machine: mend login --url ${installation.config.appUrl}, then mend server status again, or mend operator gate and mend operator exposure`,
    ];
  }
  let loginOrigin: string;
  try {
    loginOrigin = new URL(login.url).origin;
  } catch {
    return [`gate items · the saved sign-in's URL "${login.url}" is not a URL · not read`];
  }
  if (loginOrigin !== installation.config.appUrl) {
    return [
      `gate items · this machine is signed in to ${loginOrigin}, not ${installation.config.appUrl} · not read`,
    ];
  }
  const headers = { Authorization: `Bearer ${login.token}` };
  const read = async (route: string): Promise<unknown | string> => {
    const response = await runtime.fetchText(
      `${healthOrigin(installation.config)}/api${route}`,
      5_000,
      headers,
    );
    if (response.error !== undefined) return `${route} · not read: ${response.error}`;
    if (response.status === 404)
      return `${route} · 404: the signed-in account does not hold the operator role`;
    if (response.status < 200 || response.status >= 300)
      return `${route} · not read: HTTP ${response.status}`;
    try {
      return JSON.parse(response.body);
    } catch {
      return `${route} · not read: the answer is not JSON`;
    }
  };
  const lines: Array<string> = [];
  const gate = await read("/operator/gate");
  const gateItems = Array.isArray(gate) ? gate.flatMap(gateItemOf) : null;
  if (typeof gate === "string") lines.push(`gate items · ${gate}`);
  else if (gateItems === null || gateItems.length === 0)
    lines.push("gate items · /operator/gate answered in a shape this CLI does not read");
  else lines.push("multi mode gate, as the server reports each item:", ...renderGate(gateItems));
  const exposure = await read("/operator/exposure");
  const report = exposureReportOf(exposure);
  if (typeof exposure === "string") lines.push(`gate items · ${exposure}`);
  else if (report === null)
    lines.push("gate items · /operator/exposure answered in a shape this CLI does not read");
  else
    lines.push("public exposure gate, as the server reports each item:", ...renderExposure(report));
  return lines;
};

const gateItemOf = (
  value: unknown,
): ReadonlyArray<{
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fix: string | null;
}> => {
  const fields = ownFields(value);
  const id = fields?.get("id");
  const ok = fields?.get("ok");
  const detail = fields?.get("detail");
  const fix = fields?.get("fix");
  return typeof id === "string" &&
    typeof ok === "boolean" &&
    typeof detail === "string" &&
    (fix === null || typeof fix === "string")
    ? [{ id, ok, detail, fix: fix ?? null }]
    : [];
};

type ExposureReport = Parameters<typeof renderExposure>[0];
type ExposureItem = ExposureReport["items"][number];

const isEstablished = (value: unknown): value is ExposureItem["established"] =>
  value === "observed" || value === "carried" || value === "declared" || value === "open";

const exposureItemOf = (value: unknown): ReadonlyArray<ExposureItem> => {
  const fields = ownFields(value);
  const id = fields?.get("id");
  const established = fields?.get("established");
  const detail = fields?.get("detail");
  const fix = fields?.get("fix");
  const blocksStart = fields?.get("blocksStart");
  return typeof id === "string" &&
    isEstablished(established) &&
    typeof detail === "string" &&
    (fix === null || typeof fix === "string") &&
    typeof blocksStart === "boolean"
    ? [{ id, established, detail, fix: fix ?? null, blocksStart }]
    : [];
};

const exposureReportOf = (value: unknown): ExposureReport | null => {
  const fields = ownFields(value);
  const declared = fields?.get("declared");
  const items = fields?.get("items");
  if (typeof declared !== "string" || !isExposure(declared) || !Array.isArray(items)) return null;
  const parsed = items.flatMap(exposureItemOf);
  return parsed.length === items.length && parsed.length > 0 ? { declared, items: parsed } : null;
};

/**
 * One look at each mirror the install runs: whether its container runs, the bytes on its volume
 * (`du` inside the container), and its traffic. The npm mirror's comes from its own log of the last
 * 24 hours, one line per request; the Docker mirror's from the registry's proxy counters, which
 * count from the container's start. Every read is bounded and none is fatal: what could not be
 * read is said, never guessed.
 */
const mirrorStatusLines = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
  runningServices: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const mirrors = installation.config.mirrors;
  if (mirrors === undefined) return [];
  const run = (args: ReadonlyArray<string>) =>
    runtime.run("docker", serverComposeArgs(composeTarget(installation), args), {
      timeoutMs: serverProcessDeadlines.ordinary,
    });
  const failed = (output: CommandOutput): string | null =>
    output.status !== 0 || output.error !== undefined ? outputDetail(output) : null;
  const diskOf = async (service: string, directory: string) => {
    const probe = await run(["exec", "-T", service, "sh", "-c", mirrorDiskProbe(directory)]);
    return failed(probe) ?? mirrorDiskOf(probe.stdout) ?? "du and df answered nothing readable";
  };
  const lines: Array<string> = [];
  const npmRunning = runningServices.includes("npm-mirror");
  if (mirrors.npm === null || !npmRunning) {
    lines.push(observedNpmMirrorLine(mirrors, { running: false, disk: "", traffic: "" }));
  } else {
    const log = await run([
      "logs",
      "--no-color",
      "--no-log-prefix",
      "--since",
      "24h",
      "npm-mirror",
    ]);
    lines.push(
      observedNpmMirrorLine(mirrors, {
        running: true,
        disk: await diskOf("npm-mirror", "/var/cache/npm-mirror"),
        traffic: failed(log) ?? npmMirrorTraffic(log.stdout),
      }),
    );
  }
  const dockerRunning = runningServices.includes("docker-mirror");
  if (mirrors.docker === null || !dockerRunning) {
    lines.push(
      observedDockerMirrorLine(mirrors, { running: false, disk: "", traffic: "", startedAt: null }),
    );
  } else {
    const metrics = await run([
      "exec",
      "-T",
      "docker-mirror",
      "wget",
      "-q",
      "-O",
      "-",
      "http://127.0.0.1:5001/metrics",
    ]);
    const started = await runtime.run("docker", [
      "--context",
      installation.config.dockerContext,
      "container",
      "inspect",
      "--format",
      "{{.State.StartedAt}}",
      DOCKER_MIRROR_CONTAINER,
    ]);
    const startedAt = failed(started) === null ? started.stdout.trim().replace(/\.\d+Z$/, "Z") : "";
    lines.push(
      observedDockerMirrorLine(mirrors, {
        running: true,
        disk: await diskOf("docker-mirror", "/var/lib/registry"),
        traffic:
          failed(metrics) ??
          dockerMirrorTraffic(metrics.stdout) ??
          "the registry reported no proxy counters",
        startedAt: startedAt === "" ? null : startedAt,
      }),
    );
  }
  return lines;
};

const serverStatus = async (
  runtime: ServerSetupRuntime,
  installation: ServerInstallation,
): Promise<void> => {
  const { config } = installation;
  runtime.writeLine(`Pinned Mend ${config.serverVersion} at ${config.appUrl}`);
  runtime.writeLine(`Active generation: ${installation.directory}`);
  // What this install declares, from its own config: facts about the generation, whatever runs.
  for (const line of declaredPostureLines(config)) runtime.writeLine(line);
  const state = await composeCommand(runtime, installation, ["ps", "--all"]);
  runtime.writeLine(state.stdout.trim() || "No Compose containers found. Run mend server start.");
  const running = await composeCommand(runtime, installation, [
    "ps",
    "--status",
    "running",
    "--services",
  ]);
  const runningServices = running.stdout.trim().split(/\s+/);
  if (config.edgeHost !== undefined) {
    const edgeRunning = runningServices.includes("edge");
    runtime.writeLine(
      observedEdgeLine(config.edgeHost, {
        running: edgeRunning,
        certificate: edgeRunning
          ? await observeEdgeCertificate(runtime, installation, config.edgeHost)
          : { kind: "unavailable", reason: "the edge is not running, so its data was not read" },
      }),
    );
  }
  for (const line of await mirrorStatusLines(runtime, installation, runningServices))
    runtime.writeLine(line);
  if (config.t3GatewayPort !== undefined && runningServices.includes("mend")) {
    const gateway = await runtime.fetchText(
      `http://127.0.0.1:${config.t3GatewayPort}/.well-known/t3/environment`,
      2_000,
    );
    runtime.writeLine(
      gateway.error === undefined && gateway.status === 200
        ? `t3code gateway · observed answering at 127.0.0.1:${config.t3GatewayPort} from this machine`
        : `t3code gateway · not observed at 127.0.0.1:${config.t3GatewayPort} from this machine · mend server logs shows what it said`,
    );
  }
  if (!runningServices.includes("mend")) {
    runtime.writeLine("Mend is stopped. No health claim was made.");
    return;
  }
  const response = await runtime.fetchText(`${healthOrigin(config)}/api/health`, 2_000);
  let fields: ReadonlyMap<string, unknown> | null = null;
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
    fields = ownFields(body);
  } catch {
    /* Invalid health is not readiness. */
  }
  if (
    response.error !== undefined ||
    response.status < 200 ||
    response.status >= 300 ||
    fields?.get("status") !== "ok" ||
    fields.get("version") !== config.serverVersion
  ) {
    throw setupError(
      `Mend is running but exact-version health for ${config.serverVersion} was not observed. Check mend server logs --tail 100.`,
    );
  }
  runtime.writeLine(reachableLine(config));
  // What the running server reports, beside what was declared above.
  for (const line of observedPostureLines(config, healthPosture(body))) runtime.writeLine(line);
  for (const line of await operatorReportLines(runtime, installation)) runtime.writeLine(line);
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
    namespace: namespaceOf(installation.config),
  });
  if (ownership._tag === "error") throw setupError(ownership.error.message);
  const secrets = parseSecrets(identity);
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
    const stopped = [
      "Mend",
      "Postgres",
      ...(installation.config.bucket === "garage" ? ["Garage"] : []),
      ...(installation.config.edgeHost === undefined ? [] : ["the edge"]),
      ...mirrorServices(installation.config.mirrors).map((service) =>
        service === "npm-mirror" ? "the npm mirror" : "the Docker mirror",
      ),
    ];
    runtime.writeLine(
      `${stopped.slice(0, -1).join(", ")} and ${stopped.at(-1)} stopped. Volumes, configuration and workspace containers are retained.`,
    );
    return;
  }
  await checkLocalImages(runtime, installation);
  if (command === "restart") {
    interruptionNotice(runtime);
    await composeCommand(runtime, installation, ["stop", "--timeout", "30", "mend"]);
  }
  await startInstallation(runtime, installation, secrets);
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
    fetchText: async (url, timeoutMs, headers) => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          ...(headers === undefined ? {} : { headers }),
        });
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
    writeLine: (line) => process.stdout.write(`${redactCredentials(line)}\n`),
    dockerDaemonFacts: hostDockerDaemonFacts,
    readLogin: (configDir) => savedLogin(configDir, environment),
    probeSsh: probeSshFromHere,
    portTaken: portTakenHere,
    readStdin: async () => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of process.stdin)
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
};

/**
 * The first line a TCP listener sends within `timeoutMs` of the attempt, or null: nothing answered,
 * the connection was refused, or the peer closed before it said anything (a gateway restarting, a
 * listener that drops connections before authentication). It settles exactly once, on every path,
 * and the deadline does not depend on the socket's own idle timer.
 */
export const sshBannerAt = async (
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string | null> => {
  const socket = net.connect({ host, port });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<string | null>((resolve) => {
        socket.once("data", (bytes: Buffer) =>
          resolve(bytes.toString("utf8").split(/\r?\n/)[0]?.trim() ?? ""),
        );
        socket.once("end", () => resolve(null));
        socket.once("close", () => resolve(null));
        socket.once("error", () => resolve(null));
      }),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
};

/** Whether binding `127.0.0.1:<port>` here fails because something holds it. */
const portTakenHere = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });

/** `probeSsh` on this machine: the bind, or this machine's own addresses for an unspecified one. */
const probeSshFromHere = async (bind: string, port: number): Promise<ReadonlyArray<SshProbe>> => {
  const unspecified = bind === "0.0.0.0" || bind === "::";
  const addresses = unspecified
    ? Object.values(os.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter(
          (entry) =>
            !entry.internal &&
            (entry.family === "IPv4" || (bind === "::" && !entry.address.startsWith("fe80"))),
        )
        .map((entry) => entry.address)
        .slice(0, 4)
    : [bind];
  return Promise.all(
    addresses.map(async (address) => ({
      address,
      banner: await sshBannerAt(address, port, 3_000),
    })),
  );
};

/**
 * The sign-in `mend login` saved in `cli.json`, as `loadConfig` reads it: `MEND_URL` and
 * `MEND_TOKEN` first, then the file. Null when there is no token; an unreadable file is none too.
 */
const savedLogin = (
  configDir: string,
  environment: NodeJS.ProcessEnv,
): { readonly url: string; readonly token: string } | null => {
  let saved: ReadonlyMap<string, unknown> | null = null;
  try {
    saved = ownFields(JSON.parse(fs.readFileSync(path.join(configDir, "cli.json"), "utf8")));
  } catch {
    saved = null;
  }
  const savedUrl = saved?.get("url");
  const savedToken = saved?.get("token");
  const url = environment["MEND_URL"] ?? (typeof savedUrl === "string" ? savedUrl : null);
  const token = environment["MEND_TOKEN"] ?? (typeof savedToken === "string" ? savedToken : null);
  return url === null || token === null || token === "" ? null : { url, token };
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
