// The split-tier smoke (scripts/check-split-tier.mjs, image.yml's split-tier jobs): its Compose file
// against the Helm chart it stands for, its inputs, and the jobs that run it. The smoke itself needs
// the images and Docker; image.yml runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse, parseAllDocuments } from "yaml";

import {
  AGENT_ANSWER,
  AGENT_REQUEST,
  COMPOSE_FILE,
  ORIGIN,
  bridgeSocket,
  readInputs,
} from "./check-split-tier.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const compose = parse(readFileSync(COMPOSE_FILE, "utf8"));
const image = parse(readFileSync(path.join(root, ".github/workflows/image.yml"), "utf8"));
const helmAvailable = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;

// The chart's own values, with the three the brief sets: an allowed origin, the session channel's
// advertised URL as Compose names the API, and the private executor network (from the fixture).
const renderChart = () => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "mend",
      path.join(root, "deploy/helm/mend"),
      "-n",
      "mend",
      "-f",
      path.join(root, "deploy/helm/mend/ci/plain-url-values.yaml"),
      "--set",
      "image.tag=1.2.3",
      "--set",
      "web.allowedOrigins={http://127.0.0.1:3105}",
      "--set",
      "sessionChannel.advertisedUrl=http://mend-api:3106",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const deployments = {};
  for (const document of parseAllDocuments(result.stdout)) {
    const resource = document.toJS();
    if (resource?.kind !== "Deployment" && resource?.kind !== "StatefulSet") continue;
    deployments[resource.metadata.name] = resource.spec.template.spec;
  }
  return deployments;
};
const envOf = (spec) =>
  Object.fromEntries(
    spec.containers[0].env.map(({ name, value, valueFrom }) => [
      name,
      valueFrom === undefined ? value : { secret: valueFrom.secretKeyRef?.key ?? "field" },
    ]),
  );

// Where Compose cannot be the cluster, and how; anything else must be the chart's value exactly.
const BUCKET = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "MEND_BLOB_STORE",
  "MEND_BLOB_STORE_PUBLIC_URL",
  "MEND_CAPTURE_MULTIPART_THRESHOLD",
  "MEND_CAPTURE_MULTIPART_PART_SIZE",
  "MEND_CAPTURE_BYTE_QUOTA_FLOOR",
];
const asCompose = (env, { drop = [], replace = {} }) => {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (drop.includes(name)) continue;
    if (name in replace) out[name] = replace[name];
    else if (typeof value === "object") out[name] = `\${${value.secret}:?}`;
    else out[name] = value;
  }
  return out;
};

test(
  "the Compose file runs the tiers with the chart's environment",
  { skip: helmAvailable ? false : "helm is not on PATH" },
  () => {
    const chart = renderChart();
    const api = envOf(chart["mend-api"]);
    assert.equal(api.DATABASE_URL, "postgres://mend:$(MEND_DB_PASSWORD)@mend-postgres:5432/mend");
    assert.deepEqual(
      compose.services["mend-api"].environment,
      asCompose(api, {
        drop: BUCKET,
        replace: {
          MEND_VERSION: "${MEND_SPLIT_VERSION:?}",
          DATABASE_URL: "postgres://mend:${MEND_DB_PASSWORD:?}@postgres:5432/mend",
        },
      }),
    );
    const web = envOf(chart["mend-web"]);
    assert.equal(web.MEND_API_URL, "http://mend-api.mend.svc:3101");
    assert.deepEqual(
      compose.services["mend-web"].environment,
      asCompose(web, { replace: { MEND_API_URL: "http://mend-api:3101" } }),
    );
    const postgres = chart["mend-postgres"];
    assert.equal(postgres.containers[0].image, "postgres:17-alpine");
    assert.deepEqual(
      compose.services.postgres.environment,
      asCompose(envOf(postgres), { replace: { POSTGRES_PASSWORD: "${MEND_DB_PASSWORD:?}" } }),
    );
    // Both tiers run as 1000: the API by Compose's user, the web tier by its image's `node`.
    for (const tier of ["mend-api", "mend-web"])
      assert.equal(chart[tier].securityContext.runAsUser, 1000, tier);
    assert.equal(compose.services["mend-api"].user, "1000:1000");
    assert.equal(compose.services["mend-web"].user, undefined);
    // The chart's proxy CIDR is the Compose network's.
    assert.equal(api.MEND_TRUSTED_PROXIES, "10.244.0.0/16");
    assert.equal(compose.networks.default.ipam.config[0].subnet, "10.244.0.0/16");
  },
);

test("the Compose file runs only the images it is handed, and Postgres by digest", () => {
  for (const [service, variable] of [
    ["mend-api", "MEND_SPLIT_API_IMAGE"],
    ["mend-web", "MEND_SPLIT_WEB_IMAGE"],
    ["volume-owner", "MEND_SPLIT_API_IMAGE"],
  ]) {
    assert.equal(compose.services[service].image, `\${${variable}:?}`, service);
    assert.equal(compose.services[service].pull_policy, "never", service);
  }
  assert.match(
    compose.services.postgres.image,
    /^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    readFileSync(fileURLToPath(new URL("./check-split-tier.mjs", import.meta.url)), "utf8"),
    new RegExp(compose.services.postgres.image.replaceAll(".", "\\.")),
  );
  // Only the web tier is published, on the address the checks use.
  assert.deepEqual(compose.services["mend-web"].ports, [`${new URL(ORIGIN).host}:3105`]);
  for (const service of ["postgres", "mend-api", "volume-owner"])
    assert.equal(compose.services[service].ports, undefined, service);
});

const id = (n) => `sha256:${String(n).repeat(64)}`;

test("the inputs name both tiers at the version, each with an image ID", () => {
  const good = {
    MEND_SPLIT_VERSION: "0.36.0-next.792",
    MEND_SPLIT_API_IMAGE: "ghcr.io/sealant-sh/mend-api:0.36.0-next.792",
    MEND_SPLIT_API_IMAGE_ID: id(1),
    MEND_SPLIT_WEB_IMAGE: "ghcr.io/sealant-sh/mend-web:0.36.0-next.792",
    MEND_SPLIT_WEB_IMAGE_ID: id(2),
  };
  assert.deepEqual(readInputs(good).problems, []);
  assert.equal(readInputs(good).api.id, id(1));
  for (const [variable, value, problem] of [
    ["MEND_SPLIT_VERSION", "", /MEND_SPLIT_VERSION/],
    ["MEND_SPLIT_API_IMAGE", "ghcr.io/sealant-sh/mend-api:latest", /MEND_SPLIT_API_IMAGE must be/],
    ["MEND_SPLIT_WEB_IMAGE", "ghcr.io/sealant-sh/mend-api:0.36.0-next.792", /MEND_SPLIT_WEB_IMAGE/],
    ["MEND_SPLIT_WEB_IMAGE_ID", "sha256:abc", /MEND_SPLIT_WEB_IMAGE_ID/],
  ]) {
    const { problems } = readInputs({ ...good, [variable]: value });
    assert.ok(
      problems.some((entry) => problem.test(entry)),
      `${variable}: ${problems}`,
    );
  }
});

test("the bridge frames are ssh-agent's identity request and an empty answer", () => {
  // Length-prefixed: four bytes of length, then the message type.
  assert.equal(AGENT_REQUEST.readUInt32BE(0), AGENT_REQUEST.length - 4);
  assert.equal(AGENT_REQUEST[4], 11); // SSH_AGENTC_REQUEST_IDENTITIES
  assert.equal(AGENT_ANSWER.readUInt32BE(0), AGENT_ANSWER.length - 4);
  assert.equal(AGENT_ANSWER[4], 12); // SSH_AGENT_IDENTITIES_ANSWER
  assert.equal(AGENT_ANSWER.readUInt32BE(5), 0); // no identities
  // @mend/store's bridgeSocketName: the first 16 hex of the account id's sha256.
  assert.equal(bridgeSocket("user-1"), "/var/lib/mend/keys/_bridge/c6c289e49e9c05b2.sock");
});

test("each target's split-tier job runs the manifest's own tiers on both arches", () => {
  for (const [name, target, source] of [
    ["split-tier-smoke", "ghcr", "Pull the tiers by digest"],
    ["archive-split-tier-smoke", "archive", "Load the tiers from their archives"],
  ]) {
    const job = image.jobs[name];
    assert.match(job.if, new RegExp(`inputs\\.target == '${target}'`), name);
    assert.match(job.if, /!cancelled\(\) && /, name);
    assert.match(job.if, /needs\.release-manifest\.result == 'success'/, name);
    assert.deepEqual(job.strategy.matrix.runner, ["ubuntu-24.04", "ubuntu-24.04-arm"], name);
    assert.equal(job.permissions.packages, target === "ghcr" ? "read" : undefined, name);
    const steps = job.steps;
    const images = steps.find((step) => step.name === source);
    assert.ok(images, `${name}: ${source}`);
    assert.match(images.run, /"mend-api api" "mend-web web"/);
    assert.match(
      images.run,
      target === "ghcr"
        ? /release-manifest\.mjs resolve "\$MANIFEST" "\$REGISTRY\/\$image" "\$image" "\$arch"/
        : /release-manifest\.mjs check-archive "\$MANIFEST" "\$image" "\$ARCH" "\$archive"/,
    );
    const smoke = steps.find((step) => step.run === "node scripts/check-split-tier.mjs");
    assert.equal(smoke.env.MEND_SPLIT_API_IMAGE_ID, "${{ steps.images.outputs.api }}");
    assert.equal(smoke.env.MEND_SPLIT_WEB_IMAGE_ID, "${{ steps.images.outputs.web }}");
    const upload = steps.find((step) => step.name === "Keep the logs of a failed smoke");
    assert.equal(upload.if, "failure()");
    assert.equal(upload.with.path, smoke.env.MEND_SPLIT_ARTIFACTS);
    if (target === "archive")
      for (const tier of ["mend-api", "mend-web"])
        assert.ok(
          steps.some(
            (step) => step.with?.name === `archive-${tier}--\${{ steps.platform.outputs.arch }}`,
          ),
          `${name} downloads ${tier}'s archive`,
        );
  }
});
