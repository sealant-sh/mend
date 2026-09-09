import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";

import { supervise } from "./process-supervisor.mjs";

const READY_FILE = "/run/mend-bundle/ready";
const STORE_ROOT = "/var/lib/mend/store";
const SOCKET_ROOT = "/run/sealant/sockets";

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

  const mappingsText = required("SEALANT_DOCKER_VOLUME_MAPPINGS");
  let mappings;
  try {
    mappings = JSON.parse(mappingsText);
  } catch {
    throw new Error("SEALANT_DOCKER_VOLUME_MAPPINGS must be valid JSON");
  }
  const roots = new Map(
    Array.isArray(mappings)
      ? mappings.map((mapping) => [mapping?.logicalRoot, mapping?.volumeName])
      : [],
  );
  if (
    mappings?.length !== 2 ||
    typeof roots.get(STORE_ROOT) !== "string" ||
    typeof roots.get(SOCKET_ROOT) !== "string"
  ) {
    throw new Error(
      `SEALANT_DOCKER_VOLUME_MAPPINGS must map only ${STORE_ROOT} and ${SOCKET_ROOT} to named volumes`,
    );
  }
  if (required("SEALANT_MOUNT_ALLOWED_STORE_ROOTS") !== STORE_ROOT) {
    throw new Error(`SEALANT_MOUNT_ALLOWED_STORE_ROOTS must be exactly ${STORE_ROOT}`);
  }

  const dockerSocket = await stat("/var/run/docker.sock").catch(() => undefined);
  if (!dockerSocket?.isSocket()) {
    throw new Error("/var/run/docker.sock must be the Docker daemon socket");
  }

  await Promise.all([
    mkdir(STORE_ROOT, { recursive: true }),
    mkdir(SOCKET_ROOT, { recursive: true }),
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

const baseSpecification = (name, command, environment = {}) => ({
  name,
  command,
  env: { ...process.env, ...environment },
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

  console.log("[bundle] applying Sealant 0.29.0 migrations from its published API image");
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
    }),
  );
  await supervisor.start(
    baseSpecification("sealant-worker", ["node", "/opt/sealant/worker/dist/index.js"], {
      ...sealantEnvironment,
      DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY: "container-network",
      WORKSPACE_CONTROL_SOCKET_HOST_DIR: SOCKET_ROOT,
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
    baseSpecification("mend-api", ["node", "/app/apps/api/src/main.ts"], {
      PORT: "3101",
      MEND_WEB_PORT: "3105",
      MEND_MODE: "all",
      MEND_STORE_ROOT: STORE_ROOT,
      DATABASE_URL: configuration.mendDatabaseUrl,
      SEALANT_BASE_URL: "http://127.0.0.1:4000",
      SEALANT_SERVICE_KEY: configuration.serviceKey,
      APP_URL: configuration.appUrl,
      BETTER_AUTH_SECRET: configuration.betterAuthSecret,
    }),
  );
  await supervisor.waitFor("Mend API", () => httpResponds("http://127.0.0.1:3101/api/health"));
  await supervisor.start(
    baseSpecification("mend-web", ["node", "/app/apps/web/src/entry/main.ts"], {
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
};

await supervise(startBundle, { shutdownGraceMs: 20_000 });
