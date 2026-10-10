import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeDirectory = path.join(root, "deploy/docker");
const composeFixtureDirectory = path.join(root, "apps/cli/test-fixtures/docker");

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

test("the bundle pins published Sealant 0.39.0-next.714 artifacts and its official migrator", async () => {
  const [dockerfile, supervisor, contract, contractFixture, composeTemplate, composeFixture] =
    await Promise.all([
      readFile(path.join(root, "Dockerfile"), "utf8"),
      readFile(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
      readFile(path.join(composeDirectory, "setup-contract.v2.json"), "utf8").then(JSON.parse),
      readFile(path.join(composeFixtureDirectory, "setup-contract.v2.json"), "utf8").then(
        JSON.parse,
      ),
      readFile(path.join(composeDirectory, "compose.v2.yaml"), "utf8"),
      readFile(path.join(composeFixtureDirectory, "compose.v2.yaml"), "utf8"),
    ]);
  assert.equal(contract.sealantVersion, "0.39.0-next.714");
  assert.equal(
    contract.bootstrap.sealantMigrations,
    "node /opt/sealant/api/dist/migrate.js from sealant-api 0.39.0-next.714",
  );
  assert.match(contract.captureStore.workspaceNetwork, /Sealant 0\.39\.0-next\.714 runtime/);
  assert.deepEqual(contractFixture, contract);
  assert.equal(composeFixture, composeTemplate);
  assert.match(composeTemplate, /Sealant 0\.39\.0-next\.714 API/);
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(contract.runtimeContainers, ["mend", "postgres", "garage"]);
  assert.equal(contract.captureStore.image, "dxflrs/garage:v2.4.1");
  assert.equal(contract.registry, undefined);
  assert.match(dockerfile, /MEND_VERSION=\$\{MEND_VERSION\}/);
  // A release build passes no image arguments, so these defaults are the release pins. Only a
  // preview build (.github/workflows/preview.yml) overrides them.
  assert.match(
    dockerfile,
    /^ARG SEALANT_API_IMAGE=ghcr\.io\/sealant-sh\/sealant-api-next@sha256:3fb496ee05ee9c4f2c39ebfc2d09767a022c5f8f7906f119c781ab5ec398e997$/m,
  );
  assert.match(
    dockerfile,
    /^ARG SEALANT_WORKER_IMAGE=ghcr\.io\/sealant-sh\/sealant-worker-next@sha256:a0548b4ce47e715de910796c10078a7fc9ba33e38ccd458650801997f38c895a$/m,
  );
  assert.match(
    dockerfile,
    /^ARG SEALANT_SSH_GATEWAY_IMAGE=ghcr\.io\/sealant-sh\/sealant-ssh-gateway-next@sha256:84fa5bd9b9f269311ce895dd1e213139e312a8794603d9786893aaf106a3f97d$/m,
  );
  // Declared before the first FROM, so the FROM lines can read them.
  const firstFrom = dockerfile.search(/^FROM /m);
  for (const [argument, stage] of [
    ["SEALANT_API_IMAGE", "sealant-api"],
    ["SEALANT_WORKER_IMAGE", "sealant-worker"],
    ["SEALANT_SSH_GATEWAY_IMAGE", "sealant-ssh-gateway"],
  ]) {
    assert.ok(dockerfile.search(new RegExp(`^ARG ${argument}=`, "m")) < firstFrom, argument);
    assert.match(dockerfile, new RegExp(`^FROM \\$\\{${argument}\\} AS ${stage}$`, "m"));
  }
  assert.equal(dockerfile.match(/^FROM .*sealant-sh\/sealant-/gm), null);
  assert.match(dockerfile, /dev\.sealant\.mend\.sealant-version="0\.39\.0-next\.714"/);
  // The image lists every migration it carries, for `mend server upgrade --from-preview`.
  assert.match(dockerfile, /RUN node scripts\/mend-migrations\.mjs > \/app\/mend-migrations\.txt/);
  assert.match(dockerfile, /> \/app\/migrations\.txt/);
  assert.match(supervisor, /applying Sealant 0\.39\.0-next\.714 migrations/);
  assert.doesNotMatch(
    [dockerfile, supervisor, JSON.stringify(contract), composeTemplate].join("\n"),
    /0\.32\.0/,
  );
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

test("the Sealant worker runs four launches at once unless the operator says otherwise", async () => {
  const [supervisor, { workerQueueEnvironment }] = await Promise.all([
    readFile(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
    import("./bundle-supervisor.mjs"),
  ]);
  assert.match(
    supervisor,
    /\.\.\.previewSealantdEnvironment\(process\.env\),\n\s+\.\.\.workerQueueEnvironment\(process\.env\),/,
  );
  assert.deepEqual(workerQueueEnvironment({}), { WORKSPACE_BUILD_QUEUE_PREFETCH: "4" });
  assert.deepEqual(workerQueueEnvironment({ WORKSPACE_BUILD_QUEUE_PREFETCH: " " }), {
    WORKSPACE_BUILD_QUEUE_PREFETCH: "4",
  });
  assert.deepEqual(workerQueueEnvironment({ WORKSPACE_BUILD_QUEUE_PREFETCH: "2" }), {
    WORKSPACE_BUILD_QUEUE_PREFETCH: "2",
  });
});

test("a preview sealantd image reaches only the Sealant worker, and a release adds nothing", async () => {
  const [dockerfile, supervisor, { previewSealantdEnvironment }] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
    import("./bundle-supervisor.mjs"),
  ]);
  assert.match(dockerfile, /^ARG MEND_PREVIEW_SEALANTD_IMAGE=""$/m);
  assert.match(dockerfile, /MEND_PREVIEW_SEALANTD_IMAGE=\$\{MEND_PREVIEW_SEALANTD_IMAGE\}/);
  assert.equal(supervisor.match(/previewSealantdEnvironment\(process\.env\)/g)?.length, 1);
  assert.match(
    supervisor,
    /WORKSPACE_CONTROL_SOCKET_HOST_DIR: SOCKET_ROOT,\n\s+\.\.\.previewSealantdEnvironment\(process\.env\),/,
  );

  assert.deepEqual(previewSealantdEnvironment({}), {});
  assert.deepEqual(previewSealantdEnvironment({ MEND_PREVIEW_SEALANTD_IMAGE: "" }), {});
  assert.deepEqual(
    previewSealantdEnvironment({
      MEND_PREVIEW_SEALANTD_IMAGE: "  ",
      SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: "example.invalid/sealantd:dev",
    }),
    {},
  );

  const image = `ghcr.io/sealant-sh/mend-preview-sealantd@sha256:${"a".repeat(64)}`;
  assert.deepEqual(previewSealantdEnvironment({ MEND_PREVIEW_SEALANTD_IMAGE: image }), {
    SEALANT_SEALANTD_IMAGE: image,
    SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: image,
  });
  assert.deepEqual(
    previewSealantdEnvironment({
      MEND_PREVIEW_SEALANTD_IMAGE: image,
      SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: ` example.invalid/sealantd:dev ,,${image}`,
    }),
    {
      SEALANT_SEALANTD_IMAGE: image,
      SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: `example.invalid/sealantd:dev,${image}`,
    },
  );
});

test("the t3code gateway is in the bundle, and runs only when the operator turned it on", async () => {
  const [dockerfile, supervisor, { t3GatewayEnvironment }] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
    import("./bundle-supervisor.mjs"),
  ]);
  assert.match(dockerfile, /pnpm --filter @mend\/t3-gateway build/);
  assert.match(
    dockerfile,
    /COPY --from=mend-build \/app\/apps\/t3-gateway\/dist \.\/apps\/t3-gateway\/dist/,
  );
  // Kept running on its own: its exit never stops Mend.
  assert.match(supervisor, /keepRunning\(\s*baseSpecification\("mend-t3-gateway"/);
  assert.doesNotMatch(supervisor, /supervisor\.start\(\s*baseSpecification\("mend-t3-gateway"/);

  assert.equal(t3GatewayEnvironment({}), null);
  assert.equal(t3GatewayEnvironment({ MEND_T3_GATEWAY_ENABLED: "0" }), null);
  assert.equal(t3GatewayEnvironment({ MEND_T3_GATEWAY_ENABLED: "" }), null);
  assert.deepEqual(t3GatewayEnvironment({ MEND_T3_GATEWAY_ENABLED: "true" }), {
    MEND_T3_GATEWAY_HOST: "0.0.0.0",
    MEND_T3_GATEWAY_PORT: "3120",
    MEND_T3_GATEWAY_MEND_URL: "http://127.0.0.1:3101",
    MEND_T3_GATEWAY_STATE_PATH: "/var/lib/mend/config/t3-gateway/state.sqlite",
    MEND_T3_GATEWAY_LABEL: "Mend",
  });
  assert.equal(
    t3GatewayEnvironment({ MEND_T3_GATEWAY_ENABLED: "1", MEND_T3_GATEWAY_LABEL: "Box" })
      ?.MEND_T3_GATEWAY_LABEL,
    "Box",
  );
});
