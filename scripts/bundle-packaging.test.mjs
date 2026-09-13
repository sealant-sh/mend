import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeDirectory = path.join(root, "deploy/docker");

const renderCompose = (file = path.join(composeDirectory, "compose.v2.yaml")) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      path.dirname(file),
      "-f",
      file,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: composeDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        MEND_IMAGE_REPOSITORY: "example.invalid/mend",
        MEND_VERSION: "1.2.3",
        APP_URL: "http://localhost:43105",
        MEND_PORT: "43105",
        MEND_SSH_PORT: "42222",
        MEND_POSTGRES_ADMIN_PASSWORD: "a".repeat(64),
        MEND_DB_PASSWORD: "b".repeat(64),
        SEALANT_DB_PASSWORD: "c".repeat(64),
        BETTER_AUTH_SECRET: "e".repeat(64),
        WORKSPACE_SSH_GATEWAY_TOKEN: "f".repeat(64),
        SEALANT_SERVICE_KEY: `slt_svc_${"1".repeat(64)}`,
        SEALANT_CREDENTIALS_KEY: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
        MEND_STORE_VOLUME_NAME: "mend-test-store",
        MEND_CONTROL_VOLUME_NAME: "mend-test-control",
        MEND_GARAGE_VOLUME_NAME: "mend-test-garage",
        MEND_GARAGE_RPC_SECRET: "0".repeat(64),
        MEND_GARAGE_ADMIN_TOKEN: "1".repeat(64),
        MEND_GARAGE_KEY_ID: "GK000000000000000000000000",
        MEND_GARAGE_KEY_SECRET: "2".repeat(64),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("the rendered deployment has Mend, official Postgres and the Garage bucket", () => {
  const compose = renderCompose();
  assert.deepEqual(Object.keys(compose.services).toSorted(), ["garage", "mend", "postgres"]);
  assert.equal(compose.services.mend.image, "example.invalid/mend:1.2.3");
  assert.equal(compose.services.postgres.image, "postgres:17-alpine");
  assert.equal(compose.services.garage.image, "dxflrs/garage:v2.4.1");
  // Garage publishes nothing; Mend reaches it and executors reach both on the Compose network.
  assert.equal(compose.services.garage.ports, undefined);
  const mend = compose.services.mend.environment;
  assert.equal(mend.MEND_BLOB_STORE, "s3://mend?endpoint=http://garage:3900&region=garage");
  assert.equal(mend.MEND_BLOB_STORE_PUBLIC_URL, "http://garage:3900");
  assert.equal(mend.MEND_SESSION_ENDPOINT_URL, "http://mend:3106");
  assert.equal(mend.MEND_SESSION_ENDPOINT_LISTEN, "0.0.0.0:3106");
  assert.equal(mend.AWS_ACCESS_KEY_ID, "GK000000000000000000000000");
  assert.equal(mend.SEALANT_DOCKER_WORKSPACE_NETWORK, "mend_default");
  assert.equal(mend.MEND_SESSION_STORE, undefined);
  assert.equal(compose.services.garage.environment.GARAGE_RPC_SECRET, "0".repeat(64));
  assert.match(compose.configs["garage-config"].content, /replication_factor = 1/);

  const published = compose.services.mend.ports;
  assert.deepEqual(
    published.map((port) => [port.host_ip, Number(port.published), Number(port.target)]),
    [
      ["127.0.0.1", 43105, 3105],
      ["127.0.0.1", 42222, 2222],
    ],
  );
});

test("the root Compose entry point uses the same deployment and project name", () => {
  const compose = renderCompose(path.join(root, "compose.yaml"));
  assert.equal(compose.name, "mend");
  assert.deepEqual(Object.keys(compose.services).toSorted(), ["garage", "mend", "postgres"]);
  assert.equal(compose.services.mend.image, "example.invalid/mend:1.2.3");
});

test("named-volume lowering and persistence paths stay aligned", () => {
  const compose = renderCompose();
  const mend = compose.services.mend;
  assert.deepEqual(JSON.parse(mend.environment.SEALANT_DOCKER_VOLUME_MAPPINGS), [
    { logicalRoot: "/var/lib/mend/store", volumeName: "mend-test-store" },
    { logicalRoot: "/run/sealant/sockets", volumeName: "mend-test-control" },
  ]);
  assert.equal(mend.environment.SEALANT_MOUNT_ALLOWED_STORE_ROOTS, "/var/lib/mend/store");
  assert.equal(compose.volumes["mend-store"].name, "mend-test-store");
  assert.equal(compose.volumes["mend-control"].name, "mend-test-control");
  assert.equal(compose.volumes["mend-garage"].name, "mend-test-garage");
  assert.equal(compose.volumes["mend-store"].external, true);
  assert.equal(compose.volumes["mend-control"].external, true);
  assert.equal(compose.volumes["mend-garage"].external, true);
  const garageMounts = new Map(
    compose.services.garage.volumes.map((volume) => [volume.target, volume.source]),
  );
  assert.equal(garageMounts.get("/var/lib/garage"), "mend-garage");

  const mounts = new Map(mend.volumes.map((volume) => [volume.target, volume.source]));
  assert.equal(mounts.get("/var/lib/mend/store"), "mend-store");
  assert.equal(mounts.get("/run/sealant/sockets"), "mend-control");
  assert.equal(mounts.get("/var/lib/mend/config"), "mend-config");
  assert.equal(mounts.get("/var/lib/mend/ssh"), "mend-ssh");
  assert.equal(mounts.has("/var/lib/rabbitmq"), false);
  assert.equal(mounts.has("/var/lib/registry"), false);
  assert.equal(compose.volumes["mend-rabbitmq"], undefined);
  assert.equal(compose.volumes["mend-registry"], undefined);
});

test("the bundle pins published Sealant 0.31.0 artifacts and its official migrator", async () => {
  const [dockerfile, supervisor, contract] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
    readFile(path.join(composeDirectory, "setup-contract.v2.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(contract.sealantVersion, "0.31.0");
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(contract.runtimeContainers, ["mend", "postgres", "garage"]);
  assert.equal(contract.captureStore.image, "dxflrs/garage:v2.4.1");
  assert.equal(contract.registry, undefined);
  assert.match(dockerfile, /MEND_VERSION=\$\{MEND_VERSION\}/);
  assert.match(dockerfile, /sealant-api@sha256:06457157/);
  assert.match(dockerfile, /sealant-worker@sha256:dff7a11e/);
  assert.match(dockerfile, /sealant-ssh-gateway@sha256:19782141/);
  assert.doesNotMatch(dockerfile, /FROM rabbitmq|zot-minimal|\/opt\/zot|rabbitmq-server/i);
  assert.doesNotMatch(supervisor, /RABBITMQ_URL|REGISTRY_/);
  // Both Mend processes run from bundles; the runtime image carries no workspace or node_modules.
  assert.match(supervisor, /\/app\/apps\/api\/dist\/main\.js/);
  assert.match(supervisor, /\/app\/apps\/web\/\.output\/front\.mjs/);
  assert.doesNotMatch(
    dockerfile,
    /src\/main\.ts|mend-production-dependencies|\/app\/node_modules \.\/node_modules/,
  );
  assert.match(supervisor, /\/opt\/sealant\/api\/dist\/migrate\.js/);
  assert.match(supervisor, /DRIZZLE_MIGRATIONS_DIR: "\/opt\/sealant\/api\/drizzle"/);
  assert.doesNotMatch(dockerfile, /Core-volume-mounts|COPY .*Core/);
});
