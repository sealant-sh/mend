import { execFile } from "node:child_process";
import {
  chmod,
  lchown,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import { supervise } from "./process-supervisor.mjs";

const READY_FILE = "/run/mend-bundle/ready";
const STORE_ROOT = "/var/lib/mend/store";
const SOCKET_ROOT = "/run/sealant/sockets";
/** Where the host VM runtime keeps its base disks and each VM's data disk (compose.host-vm.yaml). */
export const VM_IMAGES_ROOT = "/var/lib/mend/vm-images";
export const VM_DATA_ROOT = "/var/lib/mend/vm-data";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const parseConfiguration = async () => {
  const appUrl = required("APP_URL");
  const parsedAppUrl = URL.parse(appUrl);
  if (parsedAppUrl === null || parsedAppUrl.origin !== appUrl) {
    throw new Error("APP_URL must be an exact URL origin without a path or trailing slash");
  }

  const allowedOriginsText = process.env.MEND_ALLOWED_ORIGINS ?? "[]";
  let allowedOrigins;
  try {
    allowedOrigins = JSON.parse(allowedOriginsText);
  } catch {
    throw new Error("MEND_ALLOWED_ORIGINS must be a JSON array of exact origins");
  }
  if (
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.some((origin) => {
      if (typeof origin !== "string") return true;
      const parsed = URL.parse(origin);
      return parsed === null || parsed.origin !== origin;
    })
  ) {
    throw new Error("MEND_ALLOWED_ORIGINS must be a JSON array of exact URL origins");
  }

  const { vmRoots } = volumeMappingRoots(required("SEALANT_DOCKER_VOLUME_MAPPINGS"));
  // Before anything starts: a host-vm runtime named without its disks or its networks never boots.
  hostVmEnvironment(process.env, vmRoots);
  if (required("SEALANT_MOUNT_ALLOWED_STORE_ROOTS") !== STORE_ROOT) {
    throw new Error(`SEALANT_MOUNT_ALLOWED_STORE_ROOTS must be exactly ${STORE_ROOT}`);
  }

  // Sealant's Docker runtime and its host image builder drive the host's Docker through this
  // socket. A deployment whose sessions run elsewhere (deploy/docker/compose.aws.yaml: Lambda
  // MicroVMs) turns that runtime off and mounts no socket, because the socket is root on the host.
  if (process.env.DOCKER_RUNTIME_ENABLED?.trim() !== "false") {
    const dockerSocket = await stat("/var/run/docker.sock").catch(() => undefined);
    if (!dockerSocket?.isSocket()) {
      throw new Error("/var/run/docker.sock must be the Docker daemon socket");
    }
  }

  await Promise.all([
    mkdir(STORE_ROOT, { recursive: true }),
    mkdir(SOCKET_ROOT, { recursive: true }),
    ...(vmRoots
      ? [VM_IMAGES_ROOT, VM_DATA_ROOT].map((root) => mkdir(root, { recursive: true }))
      : []),
    mkdir("/var/lib/mend/config", { recursive: true }),
    mkdir("/var/lib/mend/ssh", { recursive: true }),
    mkdir("/run/mend-bundle", { recursive: true }),
    rm(READY_FILE, { force: true }),
  ]);

  return {
    appUrl,
    mendDatabaseUrl: required("DATABASE_URL"),
    sealantDatabaseUrl: required("SEALANT_DATABASE_URL"),
    betterAuthSecret: required("BETTER_AUTH_SECRET"),
    serviceKey: required("SEALANT_SERVICE_KEY"),
    credentialsKey: required("SEALANT_CREDENTIALS_KEY"),
    gatewayToken: required("WORKSPACE_SSH_GATEWAY_TOKEN"),
    vmRoots,
  };
};

/**
 * The roots `SEALANT_DOCKER_VOLUME_MAPPINGS` lowers to named volumes: exactly the store and the
 * control sockets, or those two and both of the host VM runtime's roots. `vmRoots` says which.
 * Anything else, one VM root without the other included, is refused with what it must be.
 *
 * @param {string} mappingsText
 * @returns {{ vmRoots: boolean }}
 */
export const volumeMappingRoots = (mappingsText) => {
  let mappings;
  try {
    mappings = JSON.parse(mappingsText);
  } catch {
    throw new Error("SEALANT_DOCKER_VOLUME_MAPPINGS must be valid JSON");
  }
  const named = Array.isArray(mappings)
    ? mappings.map((mapping) =>
        typeof mapping?.volumeName === "string" && mapping.volumeName !== ""
          ? mapping?.logicalRoot
          : undefined,
      )
    : [];
  const matches = (roots) =>
    named.length === roots.length &&
    new Set(named).size === roots.length &&
    roots.every((root) => named.includes(root));
  if (matches([STORE_ROOT, SOCKET_ROOT])) return { vmRoots: false };
  if (matches([STORE_ROOT, SOCKET_ROOT, VM_IMAGES_ROOT, VM_DATA_ROOT])) return { vmRoots: true };
  throw new Error(
    `SEALANT_DOCKER_VOLUME_MAPPINGS must map ${STORE_ROOT} and ${SOCKET_ROOT} to named volumes, and nothing else but both ${VM_IMAGES_ROOT} and ${VM_DATA_ROOT} (never one of them alone)`,
  );
};

/**
 * Whether `MEND_SESSION_RUNTIMES` (a comma-separated list) or `MEND_SESSION_RUNTIME` names
 * `host-vm`, the runtime that boots each workspace in a microVM on this server's KVM.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 */
export const namesHostVm = (environment) =>
  [environment.MEND_SESSION_RUNTIMES, environment.MEND_SESSION_RUNTIME]
    .flatMap((value) => (value ?? "").split(","))
    .some((runtime) => runtime.trim() === "host-vm");

/**
 * The worker's host VM directories, only when this install runs `host-vm` sessions: Mend names the
 * runtime (`MEND_SESSION_RUNTIMES` or `MEND_SESSION_RUNTIME`) and the compose file maps both VM
 * roots. An install that names no host-vm stays on Docker alone, its VM volumes unused, until an
 * owner opts in. Naming host-vm without the VM roots mapped, or without per-workspace networks
 * (`SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS`, which each VM's egress proxy needs), is refused.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {boolean} vmRoots whether SEALANT_DOCKER_VOLUME_MAPPINGS maps both VM roots
 * @returns {Record<string, string>}
 */
export const hostVmEnvironment = (environment, vmRoots) => {
  if (!namesHostVm(environment)) return {};
  if (!vmRoots)
    throw new Error(
      `host-vm sessions are on (MEND_SESSION_RUNTIMES or MEND_SESSION_RUNTIME), but SEALANT_DOCKER_VOLUME_MAPPINGS maps no ${VM_IMAGES_ROOT} and ${VM_DATA_ROOT}. Add compose.host-vm.yaml after compose.v2.yaml, or take host-vm out of the session runtimes.`,
    );
  if ((environment.SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS?.trim() ?? "") === "")
    throw new Error(
      "host-vm sessions are on (MEND_SESSION_RUNTIMES or MEND_SESSION_RUNTIME), but SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS is unset: each VM boots behind an egress proxy on a network of its own. Set MEND_WORKSPACE_EGRESS_SUBNETS, or take host-vm out of the session runtimes.",
    );
  return { SEALANT_HOST_VM_IMAGE_DIR: VM_IMAGES_ROOT, SEALANT_HOST_VM_DATA_DIR: VM_DATA_ROOT };
};

/**
 * The private-range guard's two operator settings, for the worker: `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS`
 * (what workspaces may still reach, which Mend's API also reads as the ceiling of an Access policy)
 * and `MEND_HOST_PUBLIC_IPS` (the host's public addresses the guard refuses), under sealant's
 * names. Only a value that is set, and only with per-workspace networks: sealant refuses either
 * without `SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS`.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {Record<string, string>}
 */
export const workspaceEgressEnvironment = (environment) => {
  if ((environment.SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS?.trim() ?? "") === "") return {};
  const allowed = environment.MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS?.trim() ?? "";
  const hostIps = environment.MEND_HOST_PUBLIC_IPS?.trim() ?? "";
  return {
    ...(allowed === "" ? {} : { SEALANT_OPERATOR_ALLOWED_PRIVATE_EGRESS: allowed }),
    ...(hostIps === "" ? {} : { SEALANT_HOST_PUBLIC_IPS: hostIps }),
  };
};

const commandSucceeds = (command, arguments_) =>
  new Promise((resolve) => {
    execFile(command, arguments_, { timeout: 5_000 }, (error) => resolve(error === null));
  });

const httpResponds = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  return response.status < 500;
};

/**
 * The worker environment a preview build's sealantd image needs (see .github/workflows/preview.yml).
 * Sealant's worker bakes `SEALANT_SEALANTD_IMAGE` into every workspace image it builds, and trusts
 * the recovery boot of an image that is not a released `ghcr.io/sealant-sh/sealantd:X.Y.Z` only
 * when `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES` lists it. A release bundle carries no preview image
 * and this adds nothing.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {Record<string, string>}
 */
export const previewSealantdEnvironment = (environment) => {
  const image = environment.MEND_PREVIEW_SEALANTD_IMAGE?.trim() ?? "";
  if (image === "") return {};
  const declared = (environment.SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== image);
  return {
    SEALANT_SEALANTD_IMAGE: image,
    SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: [...declared, image].join(","),
  };
};

/**
 * How many workspace launches (and stops) the bundled Sealant worker runs at once. Sealant's
 * default is one, and a launch holds that slot until its executor is ready, the restore of a large
 * capture included: on the box, where several people and agents start sessions, a session waited
 * 33 s behind another's 32 s restore before its own began (2026-10-04). An operator's value wins.
 */
export const workerQueueEnvironment = (environment) => ({
  WORKSPACE_BUILD_QUEUE_PREFETCH: environment.WORKSPACE_BUILD_QUEUE_PREFETCH?.trim() || "4",
});

/**
 * The IPv4 gateway of this container's default route, from `/proc/net/route` (its hex fields are
 * little-endian): the Docker host as the container reaches it. Null when there is none.
 *
 * @param {string} routes
 * @returns {string | null}
 */
export const defaultGatewayAddress = (routes) => {
  for (const line of routes.split("\n").slice(1)) {
    const [, destination, gateway, flags] = line.trim().split(/\s+/);
    if (destination !== "00000000" || gateway === undefined || flags === undefined) continue;
    // RTF_UP and RTF_GATEWAY.
    if ((Number.parseInt(flags, 16) & 0x3) !== 0x3 || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;
    const octets = [6, 4, 2, 0].map((at) => Number.parseInt(gateway.slice(at, at + 2), 16));
    if (octets.every((octet) => octet === 0)) continue;
    return octets.join(".");
  }
  return null;
};

/**
 * Boat's resource gateway, for the worker, when `mend server setup` turned it on (it sets
 * SEALANT_BOAT_GATEWAY_HOST_ID; compose.boat.yaml). sealant needs two more settings, which are this
 * image's and this container's own, never the operator's: the gateway image, which the image pins
 * by digest (MEND_BOAT_GATEWAY_IMAGE, the Dockerfile's, which setup preloaded), and the address the
 * worker reaches the Docker host at, where each gateway's port is published: the container's
 * default route. An operator's own value wins. Nothing when the gateway is off.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string | null} routes the container's `/proc/net/route`, null when unreadable
 * @returns {Record<string, string>}
 */
export const boatGatewayEnvironment = (environment, routes) => {
  if ((environment.SEALANT_BOAT_GATEWAY_HOST_ID?.trim() ?? "") === "") return {};
  const image =
    environment.SEALANT_BOAT_GATEWAY_IMAGE?.trim() || environment.MEND_BOAT_GATEWAY_IMAGE?.trim();
  if (image === undefined || image === "")
    throw new Error(
      "Boat project resources are on, but this Mend image pins no Boat resource gateway image. Run mend server setup --no-boat-resources, or upgrade Mend.",
    );
  const relay =
    environment.SEALANT_BOAT_GATEWAY_RELAY_HOST?.trim() ||
    (routes === null ? null : defaultGatewayAddress(routes));
  if (relay === null || relay === "")
    throw new Error(
      "Boat project resources are on, but the container has no default route to the Docker host that runs their gateways.",
    );
  return { SEALANT_BOAT_GATEWAY_IMAGE: image, SEALANT_BOAT_GATEWAY_RELAY_HOST: relay };
};

/**
 * The t3code gateway's own root in the image (Dockerfile): node and its libraries, `setpriv`, the
 * gateway's bundle in `/app`, and its state in `/state`. Nothing else of the container is in it:
 * not Mend's store, its config or SSH keys, the control sockets or the Docker socket.
 */
export const T3_GATEWAY_ROOT = "/opt/mend-t3-gateway";
/** The gateway's own uid and gid: no other process of the bundle runs as it. */
export const T3_GATEWAY_UID = 10120;
/**
 * Its bounds: a 256 MiB heap and 2 GiB of data, 1,024 descriptors, 256 processes of its uid,
 * and a lower CPU priority (nice 10). RLIMIT_DATA also counts V8's worker address reservations;
 * the data allowance leaves room for find and regex-highlight isolates beside the loaded parent.
 */
export const T3_GATEWAY_LIMITS = {
  heapMiB: 256,
  dataBytes: 2 * 1024 * 1024 * 1024,
  openFiles: 1024,
  processes: 256,
  nice: 10,
};

/**
 * The t3code gateway's environment (ADR 0012, phase 4) when the operator turned it on (`mend
 * server setup --t3-gateway`, which sets MEND_T3_GATEWAY_ENABLED); null when off. Exactly this,
 * never the bundle's own (review 643-1): Mend's API on loopback, where it listens, its state, and
 * its label. No database URL, no Sealant or Better Auth secret, no capture-store key: the gateway
 * reaches Mend only over HTTP, with each paired person's own device token. It listens on every
 * address of the container; the host publishes it on loopback only, so who reaches it is the
 * operator's to widen (ADR 0004).
 */
export const t3GatewayEnvironment = (environment) => {
  const switch_ = environment.MEND_T3_GATEWAY_ENABLED?.trim().toLowerCase() ?? "";
  if (switch_ !== "1" && switch_ !== "true") return null;
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    HOME: "/state",
    SQLITE_TMPDIR: "/state",
    MEND_T3_GATEWAY_HOST: "0.0.0.0",
    MEND_T3_GATEWAY_PORT: "3120",
    MEND_T3_GATEWAY_MEND_URL: "http://127.0.0.1:3101",
    MEND_T3_GATEWAY_STATE_PATH: "/state/state.sqlite",
    MEND_T3_GATEWAY_LABEL: environment.MEND_T3_GATEWAY_LABEL?.trim() || "Mend",
  };
};

/**
 * How the gateway is started, null when off: bounded (`prlimit`, `nice`), in its own root
 * (`chroot`, the one capability it is started with), then as its own uid with no supplementary
 * groups, no capabilities left (none effective, permitted, inherited or in the bounding set) and
 * no way to gain any (`no_new_privs`), before node runs. `entry` is the script node runs in the
 * root (`/app/bin.js`); `root` where that root is.
 */
export const t3GatewaySpecification = (
  environment,
  { root = T3_GATEWAY_ROOT, entry = "/app/bin.js" } = {},
) => {
  const env = t3GatewayEnvironment(environment);
  if (env === null) return null;
  const limits = T3_GATEWAY_LIMITS;
  return {
    name: "mend-t3-gateway",
    // Each by its path: the chain runs with the gateway's own PATH, which has no sbin.
    command: [
      "/usr/bin/prlimit",
      `--nofile=${limits.openFiles}`,
      `--nproc=${limits.processes}`,
      `--data=${limits.dataBytes}`,
      "--",
      "/usr/bin/nice",
      "-n",
      String(limits.nice),
      "/usr/sbin/chroot",
      root,
      "/usr/bin/setpriv",
      `--reuid=${T3_GATEWAY_UID}`,
      `--regid=${T3_GATEWAY_UID}`,
      "--clear-groups",
      "--no-new-privs",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--",
      "/usr/local/bin/node",
      `--max-old-space-size=${limits.heapMiB}`,
      entry,
    ],
    env,
  };
};

/**
 * The gateway's state directory, its own: made if missing, then the directory alone owned by its
 * uid and `0700` (review 643-R2-1). Root never touches what is in it, and never follows a link:
 * the gateway writes there, so a link it planted would hand root's chown any file it names (the
 * `setpriv` root runs on the next start). What the gateway creates is its own already.
 */
export const prepareT3GatewayState = async (root = T3_GATEWAY_ROOT) => {
  const state = `${root}/state`;
  await mkdir(state, { recursive: true });
  // The root above it is root's alone (verifyT3GatewayRoot), so this is the directory, not a link.
  if (!(await lstat(state)).isDirectory()) throw new Error(`${state} is not a directory`);
  await lchown(state, T3_GATEWAY_UID, T3_GATEWAY_UID);
  await chmod(state, 0o700);
};

/**
 * Refuses to start the gateway unless everything in its root but `/state` is root's and nobody
 * else may write it (review 643-R2-1): root runs `setpriv` and loads libraries from there before
 * it drops its privileges, so a file the gateway could own or write would be code root runs.
 */
export const verifyT3GatewayRoot = async (root = T3_GATEWAY_ROOT) => {
  const unsafe = [];
  const visit = async (at) => {
    const entry = await lstat(at);
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      unsafe.push(`${at} (${entry.uid}:${entry.gid} ${(entry.mode & 0o7777).toString(8)})`);
    }
    if (!entry.isDirectory()) return;
    for (const name of await readdir(at)) {
      if (at === root && name === "state") continue;
      await visit(`${at}/${name}`);
    }
  };
  await visit(root);
  if (unsafe.length > 0) {
    throw new Error(
      `the t3code gateway's root is not root's alone, so it was not started: ${unsafe.slice(0, 5).join(", ")}`,
    );
  }
};

/** The DSN names a container is given, one per product: each reports to its own Sentry project. */
const SENTRY_DSN_NAMES = [
  "SENTRY_DSN",
  "MEND_SENTRY_DSN",
  "SEALANT_SENTRY_DSN",
  "SEALANTD_SENTRY_DSN",
];

/**
 * The environment a child starts with: the container's, then its own, with the one `SENTRY_DSN`
 * its product reports to (SLNT-1355). Mend's processes take `MEND_SENTRY_DSN` (or a plain
 * `SENTRY_DSN`, Mend being what the container runs) and sealant's take `SEALANT_SENTRY_DSN`
 * alone, so neither reports into the other's project. Sealant's names its own release. Only the
 * web app (`web`) is given `SENTRY_BROWSER_DSN`, which it serves to the browser, and only sealant's
 * worker (`daemons`) `SEALANTD_SENTRY_DSN`, which it hands the sealantd of each workspace it
 * launches (SLNT-1358). No DSN, no telemetry: nothing here is ever a default.
 */
export const childEnvironment = (
  container,
  product,
  own = {},
  { web = false, daemons = false } = {},
) => {
  const env = { ...container, ...own };
  for (const name of SENTRY_DSN_NAMES) delete env[name];
  const dsn = (
    product === "sealant"
      ? container.SEALANT_SENTRY_DSN
      : container.MEND_SENTRY_DSN?.trim() || container.SENTRY_DSN
  )?.trim();
  if (product === "sealant") delete env.SENTRY_RELEASE;
  // The browser's DSN is the web app's to serve to the browser, and no other process's.
  if (!web) delete env.SENTRY_BROWSER_DSN;
  const daemonDsn = daemons ? container.SEALANTD_SENTRY_DSN?.trim() : undefined;
  if (daemonDsn) env.SEALANTD_SENTRY_DSN = daemonDsn;
  return dsn ? { ...env, SENTRY_DSN: dsn } : env;
};

const baseSpecification = (name, command, environment = {}) => ({
  name,
  command,
  env: childEnvironment(
    process.env,
    name.startsWith("sealant-") ? "sealant" : "mend",
    environment,
    { web: name === "mend-web", daemons: name === "sealant-worker" },
  ),
});

const startBundle = async (supervisor) => {
  const configuration = await parseConfiguration();
  // Sealant's job queue lives in its Postgres database (pg-boss) and workspace images stay in the
  // host Docker Engine (no registry env means the local Engine store), so the Sealant processes
  // are the only supporting processes here.
  const sealantEnvironment = {
    DATABASE_URL: configuration.sealantDatabaseUrl,
    SEALANT_CREDENTIALS_KEY: configuration.credentialsKey,
  };

  console.log("[bundle] applying Sealant 0.40.0-next.951 migrations from its published API image");
  await supervisor.run(
    baseSpecification("sealant-migrate", ["node", "/opt/sealant/api/dist/migrate.js"], {
      DATABASE_URL: configuration.sealantDatabaseUrl,
      DRIZZLE_MIGRATIONS_DIR: "/opt/sealant/api/drizzle",
    }),
  );

  console.log("[bundle] starting the Sealant API and worker");
  await supervisor.start(
    baseSpecification("sealant-api", ["node", "/opt/sealant/api/dist/index.js"], {
      ...sealantEnvironment,
      PORT: "4000",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3101",
      WORKSPACE_SSH_GATEWAY_TOKEN: configuration.gatewayToken,
      WORKSPACE_SSH_GATEWAY_HOST: process.env.SEALANT_SSH_HOST ?? "localhost",
      WORKSPACE_SSH_GATEWAY_PORT: process.env.MEND_SSH_PORT ?? "2222",
      WORKSPACE_SSH_GATEWAY_USERNAME_PREFIX: "ws",
      SEALANT_SERVICE_KEYS: configuration.serviceKey,
      // Where it reaches each workspace's egress proxy (proxy-admin.sock), to apply a policy change
      // or a revoked secret to a running workspace.
      WORKSPACE_CONTROL_SOCKET_HOST_DIR: SOCKET_ROOT,
    }),
  );
  await supervisor.start(
    baseSpecification("sealant-worker", ["node", "/opt/sealant/worker/dist/index.js"], {
      ...sealantEnvironment,
      DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY: "container-network",
      WORKSPACE_CONTROL_SOCKET_HOST_DIR: SOCKET_ROOT,
      ...previewSealantdEnvironment(process.env),
      ...workerQueueEnvironment(process.env),
      ...workspaceEgressEnvironment(process.env),
      ...hostVmEnvironment(process.env, configuration.vmRoots),
      ...boatGatewayEnvironment(
        process.env,
        await readFile("/proc/net/route", "utf8").catch(() => null),
      ),
    }),
  );
  await supervisor.waitFor("Sealant API", () => httpResponds("http://127.0.0.1:4000/healthz"));

  console.log("[bundle] starting the SSH gateway and Mend");
  await supervisor.start(
    baseSpecification("sealant-ssh-gateway", ["node", "/opt/sealant/ssh-gateway/dist/index.js"], {
      SSH_GATEWAY_HOST: "0.0.0.0",
      SSH_GATEWAY_PORT: "2222",
      SSH_GATEWAY_HOST_KEY_PATH: "/var/lib/mend/ssh/ssh_gateway_host_key",
      SSH_GATEWAY_HOST_KEY_AUTOGENERATE: "true",
      SSH_GATEWAY_ALLOWED_KEYS_FILE: "/var/lib/mend/ssh/gateway_allowed_keys",
      SSH_GATEWAY_WORKSPACE_USERNAME_PREFIX: "ws",
      CORE_API_BASE_URL: "http://127.0.0.1:4000",
      WORKSPACE_SSH_GATEWAY_TOKEN: configuration.gatewayToken,
    }),
  );
  await supervisor.start(
    baseSpecification("mend-api", ["node", "/app/apps/api/dist/main.js"], {
      PORT: "3101",
      MEND_WEB_PORT: "3105",
      MEND_MODE: "all",
      MEND_STORE_ROOT: STORE_ROOT,
      // Mend serves each Docker or host VM executor's capture.sock and session.sock in its own
      // directory of the control root it shares with Sealant's worker (SLNT-1332). A bundle with
      // no Docker runtime (MicroVMs on AWS) has no control root to share.
      ...(process.env.DOCKER_RUNTIME_ENABLED?.trim() === "false"
        ? {}
        : { MEND_EXECUTOR_CONTROL_ROOT: SOCKET_ROOT }),
      // The default Compose endpoints stay on this host. Remote HTTPS endpoints explicitly
      // clear this statement so each workspace verifies TLS instead.
      MEND_EXECUTOR_NETWORK: process.env.MEND_EXECUTOR_NETWORK ?? "private",
      DATABASE_URL: configuration.mendDatabaseUrl,
      SEALANT_BASE_URL: "http://127.0.0.1:4000",
      SEALANT_SERVICE_KEY: configuration.serviceKey,
      APP_URL: configuration.appUrl,
      BETTER_AUTH_SECRET: configuration.betterAuthSecret,
    }),
  );
  // Alpha measured 83 s from Mend's start to its first health answer on 0.30.0, and the 90 s
  // default then restarted the whole bundle before Mend could answer.
  await supervisor.waitFor("Mend API", () => httpResponds("http://127.0.0.1:3101/api/health"), {
    timeoutMs: 240_000,
  });
  await supervisor.start(
    baseSpecification("mend-web", ["node", "/app/apps/web/.output/front.mjs"], {
      PORT: "3105",
      MEND_API_URL: "http://127.0.0.1:3101",
    }),
  );

  await Promise.all([
    supervisor.waitFor("Mend web", () => httpResponds("http://127.0.0.1:3105/api/health")),
    supervisor.waitFor("SSH gateway", () =>
      commandSucceeds("node", [
        "-e",
        "const s=require('node:net').connect(2222,'127.0.0.1');s.setTimeout(2000);s.once('connect',()=>{s.end();process.exit(0)});s.once('timeout',()=>process.exit(1));s.once('error',()=>process.exit(1))",
      ]),
    ),
  ]);
  await writeFile(READY_FILE, `${new Date().toISOString()}\n`, { mode: 0o644 });
  console.log("[bundle] ready: Mend web and the Sealant API, worker and SSH gateway");

  // After Mend is ready, and never in its way: the gateway is kept running on its own, and its
  // exit never stops the bundle.
  const t3Gateway = t3GatewaySpecification(process.env);
  if (t3Gateway !== null) {
    console.log(
      `[bundle] starting the t3code gateway on 3120 (MEND_T3_GATEWAY_ENABLED), as uid ${T3_GATEWAY_UID} in ${T3_GATEWAY_ROOT}`,
    );
    try {
      // Before every start, the restarts too: its root checked, its state directory made its own.
      await supervisor.keepRunning(t3Gateway, {
        beforeStart: async () => {
          await verifyT3GatewayRoot();
          await prepareT3GatewayState();
        },
      });
    } catch (error) {
      // Never in Mend's way: a gateway that cannot even be prepared is reported, and Mend runs on.
      console.error(`[bundle] the t3code gateway was not started: ${String(error)}`);
    }
  }
};

// Imported by the packaging tests for previewSealantdEnvironment; only the entry point supervises.
if (import.meta.main) await supervise(startBundle, { shutdownGraceMs: 20_000 });
