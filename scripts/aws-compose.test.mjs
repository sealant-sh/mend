import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The single-instance AWS shape (deploy/docker/compose.aws.yaml). It stands alone instead of
// layering over compose.v2.yaml, so these tests are what keeps the two `mend` services from
// drifting: every setting of the bundle's service is either carried over or listed below with the
// reason it is absent. Needs `docker compose` on PATH; skipped without it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "deploy/docker");
const composeAvailable =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const skip = composeAvailable ? false : "docker compose is not on PATH";

const BUNDLE_REQUIRED = [
  "MEND_POSTGRES_ADMIN_PASSWORD",
  "MEND_DB_PASSWORD",
  "SEALANT_DB_PASSWORD",
  "BETTER_AUTH_SECRET",
  "WORKSPACE_SSH_GATEWAY_TOKEN",
  "SEALANT_SERVICE_KEY",
  "SEALANT_CREDENTIALS_KEY",
  "MEND_GARAGE_RPC_SECRET",
  "MEND_GARAGE_ADMIN_TOKEN",
  "MEND_GARAGE_KEY_ID",
  "MEND_GARAGE_KEY_SECRET",
];

const AWS_ENVIRONMENT = {
  MEND_VERSION: "0.0.0",
  APP_URL: "https://alpha.example.com",
  MEND_EDGE_HOST: "alpha.example.com",
  SEALANT_SSH_HOST: "alpha.example.com",
  MEND_SESSION_BIND_HOST: "10.42.0.10",
  MEND_SESSION_ENDPOINT_URL: "http://10.42.0.10:3106",
  MEND_DATABASE_URL: "postgresql://mend:synthetic@db.example.invalid:5432/mend?sslmode=verify-full",
  SEALANT_DATABASE_URL:
    "postgresql://sealant:synthetic@db.example.invalid:5432/sealant_control_plane?sslmode=verify-full",
  MEND_BLOB_STORE: "s3://captures-example?region=eu-central-1",
  AWS_REGION: "eu-central-1",
  BETTER_AUTH_SECRET: "synthetic",
  WORKSPACE_SSH_GATEWAY_TOKEN: "synthetic",
  SEALANT_SERVICE_KEY: "synthetic",
  SEALANT_CREDENTIALS_KEY: "synthetic",
  SEALANT_CONTROL_BEARER_TOKEN: "synthetic",
  SEALANT_MICROVM_BUILD_ROLE_ARN: "arn:aws:iam::000000000000:role/example-build",
  SEALANT_MICROVM_ARTIFACT_BUCKET: "example-artifacts",
  SEALANT_MICROVM_ARTIFACT_PREFIX: "sealant/workspace-images",
  SEALANT_MICROVM_IMAGE_NAME_PREFIX: "example-ws",
  SEALANT_MICROVM_BUILD_LOG_GROUP: "/aws/lambda/microvms/example-build",
  SEALANT_MICROVM_EXEC_ROLE_ARN: "arn:aws:iam::000000000000:role/example-exec",
  SEALANT_MICROVM_EGRESS_CONNECTOR: "arn:aws:lambda:eu-central-1:000000000000:connector:egress",
  SEALANT_MICROVM_INGRESS_CONNECTOR: "arn:aws:lambda:eu-central-1:000000000000:connector:ingress",
  SEALANT_MICROVM_LOG_GROUP: "/aws/lambda/microvms/example-runtime",
};

const render = (files, environment) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      directory,
      ...files.flatMap((file) => ["-f", path.join(directory, file)]),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const aws = (extra = {}) =>
  render(["compose.aws.yaml", "compose.edge.yaml"], { ...AWS_ENVIRONMENT, ...extra });

// Settings of the bundle's `mend` service that this shape leaves out, and why.
const ABSENT_ON_PURPOSE = {
  AWS_ACCESS_KEY_ID: "the instance role signs; a static key would shadow it",
  AWS_SECRET_ACCESS_KEY: "the instance role signs; a static key would shadow it",
  MEND_BLOB_STORE_PUBLIC_URL: "S3's own endpoint is what presigned URLs name",
  SEALANT_DOCKER_WORKSPACE_NETWORK: "no workspace container is ever attached to a network here",
};

test(
  "every setting of the bundle's mend service is carried, or absent with a reason",
  { skip },
  () => {
    const bundle = render(["compose.v2.yaml"], {
      MEND_VERSION: "0.0.0",
      APP_URL: "http://localhost:3105",
      ...Object.fromEntries(BUNDLE_REQUIRED.map((name) => [name, "synthetic"])),
    }).services.mend;
    const instance = aws().services.mend;
    const missing = Object.keys(bundle.environment).filter(
      (name) => !(name in instance.environment) && !(name in ABSENT_ON_PURPOSE),
    );
    assert.deepEqual(
      missing,
      [],
      "compose.v2.yaml gained a setting compose.aws.yaml does not carry",
    );
    for (const name of Object.keys(ABSENT_ON_PURPOSE))
      assert.ok(
        !(name in instance.environment),
        `${name} must stay absent: ${ABSENT_ON_PURPOSE[name]}`,
      );
    for (const key of ["image", "hostname", "init", "restart", "stop_grace_period"])
      assert.deepEqual(instance[key], bundle[key], `mend.${key} must match the bundle`);
  },
);

test(
  "no tenant code can run on the host: no Docker socket, no Docker runtime, no bundled state",
  { skip },
  () => {
    const config = aws();
    assert.deepEqual(Object.keys(config.services).toSorted(), ["edge", "mend"]);
    const mend = config.services.mend;
    assert.ok(
      mend.volumes.every((volume) => !String(volume.source).includes("docker.sock")),
      "the Docker socket must not be mounted",
    );
    // The same value is what lets the bundle's supervisor start without the socket it otherwise
    // requires (scripts/bundle-supervisor.mjs): with the runtime on, a missing socket refuses boot.
    assert.equal(mend.environment.DOCKER_RUNTIME_ENABLED, "false");
    assert.match(
      readFileSync(path.join(root, "scripts/bundle-supervisor.mjs"), "utf8"),
      /DOCKER_RUNTIME_ENABLED\?\.trim\(\) !== "false"/,
      "the supervisor must not require the Docker socket when the Docker runtime is off",
    );
    assert.equal(mend.environment.DEFAULT_RUNTIME_ADAPTER, "microvm");
    assert.equal(mend.depends_on, undefined);
  },
);

test(
  "a project's image is built away from the host, and none of Sealant's retired image settings is set",
  { skip },
  () => {
    const environment = aws().services.mend.environment;
    // Sealant 0.36 refuses to start while one of these is set.
    for (const retired of [
      "SEALANT_MICROVM_IMAGE_ARN",
      "SEALANT_MICROVM_IMAGE_VERSION",
      "SEALANT_MICROVM_DOCKER_IMAGE_ARN",
      "SEALANT_MICROVM_DOCKER_IMAGE_VERSION",
    ])
      assert.ok(!(retired in environment), `${retired} is retired and must not be set`);
    // The build role is what registers the MicroVM runtime, and with it the managed image build.
    for (const required of [
      "SEALANT_MICROVM_BUILD_ROLE_ARN",
      "SEALANT_MICROVM_ARTIFACT_BUCKET",
      "SEALANT_MICROVM_ARTIFACT_PREFIX",
      "SEALANT_MICROVM_IMAGE_NAME_PREFIX",
    ])
      assert.ok(environment[required], `${required} must be set`);
    // An image with every OS capability is an operator's decision, and this deployment says no.
    assert.equal(environment.SEALANT_MICROVM_DOCKER_ENABLED, "false");
    // What tofu grants and what compose asks for have to be the same two prefixes.
    const tofu = readFileSync(path.join(root, "deploy/aws/tofu/application.tf"), "utf8");
    assert.match(tofu, /microvm_artifact_prefix = "sealant\/workspace-images"/);
    assert.match(tofu, /microvm-image:\$\{local\.microvm_image_name_prefix\}-\*/);
  },
);

test(
  "only the edge, workspace SSH and the VPC-side session channel are published",
  { skip },
  () => {
    const published = (service) =>
      (aws().services[service].ports ?? []).map(
        (port) => `${port.host_ip}:${port.published}/${port.protocol}`,
      );
    assert.deepEqual(published("mend").toSorted(), [
      "0.0.0.0:2222/tcp",
      "10.42.0.10:3106/tcp",
      "127.0.0.1:3105/tcp",
    ]);
    assert.deepEqual(published("edge").toSorted(), [
      "0.0.0.0:443/tcp",
      "0.0.0.0:443/udp",
      "0.0.0.0:80/tcp",
    ]);
  },
);

test(
  "the multi mode gate's configuration items are fixed, and tenancy starts single",
  { skip },
  () => {
    const environment = aws().services.mend.environment;
    assert.equal(environment.MEND_SOURCE_POLICY, "tenant");
    assert.equal(environment.MEND_CAPTURE_REQUIRE_SIZES, "true");
    assert.ok(environment.MEND_BLOB_STORE.startsWith("s3://"));
    assert.ok(!("MEND_SERVICE_HOSTS" in environment));
    assert.ok(!("MEND_GIT_TRANSPORT_BIND_ORIGIN" in environment));
    assert.equal(environment.MEND_TENANCY, "single");
    assert.equal(aws({ MEND_TENANCY: "multi" }).services.mend.environment.MEND_TENANCY, "multi");
  },
);
