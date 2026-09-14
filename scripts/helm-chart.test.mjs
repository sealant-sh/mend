import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Mend chart (deploy/helm/mend) renders the capture store both ways it is pointed at a bucket
// — a Rook ObjectBucketClaim's outputs, or a plain s3:// URL — and nothing of the retired RWX
// co-located store (docs/KUBERNETES.md "The store"). Needs `helm` on PATH; skipped without it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chart = path.join(root, "deploy/helm/mend");
const helmAvailable = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
const skip = helmAvailable ? false : "helm is not on PATH";

const render = (...args) => {
  const result = spawnSync("helm", ["template", "mend", chart, "-n", "mend", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return result;
};

const envOf = (manifest, deployment) => {
  // The container env block of one Deployment, as `name → value | valueFrom source`.
  const doc = manifest
    .split(/^---$/m)
    .find((d) => d.includes("kind: Deployment") && d.includes(`name: ${deployment}\n`));
  assert.ok(doc, `Deployment ${deployment} rendered`);
  const env = new Map();
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const inline = /^\s*- \{ name: ([A-Z_]+), value: (.*) \}$/.exec(lines[i]);
    if (inline) {
      env.set(inline[1], JSON.parse(inline[2].startsWith('"') ? inline[2] : `"${inline[2]}"`));
      continue;
    }
    const named = /^\s*- name: ([A-Z_]+)$/.exec(lines[i]);
    if (named) env.set(named[1], lines[i + 1].trim());
  }
  return env;
};

test("the chart refuses to render without a bucket", { skip }, () => {
  const result = render();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /captureStore\.blobStore: set fromObjectBucketClaim/);
});

test("the chart refuses the deprecated co-located store", { skip }, () => {
  const result = render(
    "-f",
    path.join(chart, "ci/plain-url-values.yaml"),
    "--set",
    "captureStore.sessionStore=colocated",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /co-located store is not rendered by this chart/);
});

test("an ObjectBucketClaim's outputs become the bucket URL and credentials", { skip }, () => {
  const result = render("-f", path.join(chart, "ci/obc-values.yaml"));
  assert.equal(result.status, 0, result.stderr);
  const env = envOf(result.stdout, "mend-api");
  assert.equal(env.get("MEND_SESSION_STORE"), "captured");
  for (const key of ["BUCKET_HOST", "BUCKET_PORT", "BUCKET_NAME"]) {
    assert.equal(
      env.get(key),
      `valueFrom: { configMapKeyRef: { name: "mend-bucket", key: ${key} } }`,
    );
  }
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    assert.equal(env.get(key), `valueFrom: { secretKeyRef: { name: "mend-bucket", key: ${key} } }`);
  }
  assert.equal(
    env.get("MEND_BLOB_STORE"),
    "s3://$(BUCKET_NAME)?endpoint=http://$(BUCKET_HOST):$(BUCKET_PORT)&region=us-east-1&forcePathStyle=true",
  );
  assert.equal(env.get("MEND_BLOB_STORE_PUBLIC_URL"), "http://$(BUCKET_HOST):$(BUCKET_PORT)");
  assert.equal(env.get("MEND_CAPTURE_MULTIPART_THRESHOLD"), undefined);
  // The OBC's outputs are read in order: `$(VAR)` expands only from earlier entries.
  const order = [...env.keys()];
  assert.ok(order.indexOf("BUCKET_NAME") < order.indexOf("MEND_BLOB_STORE"));
  assert.ok(order.indexOf("BUCKET_PORT") < order.indexOf("MEND_BLOB_STORE_PUBLIC_URL"));
  // The API egress rule names the RGW namespace on the POD port (8080 behind the Service's 80):
  // a NetworkPolicy matches after the Service's DNAT.
  assert.match(
    result.stdout,
    /namespaceSelector: \{ matchLabels: \{ kubernetes\.io\/metadata\.name: rook-ceph \} \}\n\s+ports: \[\{ protocol: TCP, port: 8080 \}\]/,
  );
  assert.ok(
    !/ports: \[\{ protocol: TCP, port: 80 \}\]/.test(result.stdout),
    "no rule on the Service port",
  );
});

test("the chart refuses to render without an explicit store choice", { skip }, () => {
  // An upgrade from chart 0.1.x must keep the old claim mounted: legacy worktrees on it are
  // backfilled at first launch. Defaulting to a new empty claim would silently lose them.
  const result = render(
    "-f",
    path.join(chart, "ci/obc-values.yaml"),
    "--set",
    "store.create.enabled=false",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /store: choose explicitly/);
  assert.match(result.stderr, /store\.existingClaim=<claim>/);
  const upgrade = render(
    "-f",
    path.join(chart, "ci/obc-values.yaml"),
    "--set",
    "store.create.enabled=false",
    "--set",
    "store.existingClaim=mend-store",
  );
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.match(upgrade.stdout, /persistentVolumeClaim: \{ claimName: mend-store \}/);
  assert.ok(!upgrade.stdout.includes("kind: PersistentVolumeClaim\nmetadata:\n  name: mend-store"));
});

test(
  "a plain bucket URL renders with its credentials secret and the multipart sizes",
  { skip },
  () => {
    const result = render("-f", path.join(chart, "ci/plain-url-values.yaml"));
    assert.equal(result.status, 0, result.stderr);
    const env = envOf(result.stdout, "mend-api");
    assert.equal(env.get("MEND_SESSION_STORE"), "captured");
    assert.equal(env.get("MEND_BLOB_STORE"), "s3://mend?endpoint=http://garage:3900&region=garage");
    // Unset publicUrl = the `endpoint=` of the URL.
    assert.equal(env.get("MEND_BLOB_STORE_PUBLIC_URL"), "http://garage:3900");
    assert.equal(
      env.get("AWS_ACCESS_KEY_ID"),
      'valueFrom: { secretKeyRef: { name: "mend-garage", key: AWS_ACCESS_KEY_ID } }',
    );
    assert.equal(env.get("MEND_CAPTURE_MULTIPART_THRESHOLD"), "33554432");
    assert.equal(env.get("MEND_CAPTURE_MULTIPART_PART_SIZE"), "16777216");
    assert.equal(env.get("BUCKET_HOST"), undefined);
    // An existing claim is mounted and no PVC is rendered for it.
    assert.match(result.stdout, /persistentVolumeClaim: \{ claimName: mend-store \}/);
    assert.ok(!result.stdout.includes("name: mend-store\n  labels"), "no chart-owned store PVC");
    // Garage beside Mend: the egress rule targets the release namespace on the pod port 3900.
    assert.match(
      result.stdout,
      /namespaceSelector: \{ matchLabels: \{ kubernetes\.io\/metadata\.name: mend \} \}\n\s+podSelector:\n\s+matchLabels:\s*\n\s+app\.kubernetes\.io\/name: garage\n\s+ports: \[\{ protocol: TCP, port: 3900 \}\]/,
    );
  },
);

test("a plain URL without endpoint= needs an explicit public URL", { skip }, () => {
  const values = ["--set", "captureStore.blobStore.url=s3://mend?region=eu-west-1"];
  const values2 = [
    "--set",
    "captureStore.blobStore.credentialsSecret=aws,store.create.enabled=true",
  ];
  const refused = render(...values, ...values2);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /publicUrl is required/);
  const ok = render(
    ...values,
    ...values2,
    "--set",
    "captureStore.blobStore.publicUrl=https://mend.s3.eu-west-1.amazonaws.com",
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    envOf(ok.stdout, "mend-api").get("MEND_BLOB_STORE_PUBLIC_URL"),
    "https://mend.s3.eu-west-1.amazonaws.com",
  );
});

test("nothing RWX is rendered and the store claim is the API Pod's alone", { skip }, () => {
  for (const values of ["ci/obc-values.yaml", "ci/plain-url-values.yaml"]) {
    const result = render("-f", path.join(chart, values));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("ReadWriteMany"), `${values}: no ReadWriteMany`);
    assert.ok(!/volumeMappings\[|SEALANT_K8S_VOLUME_MAPPINGS/.test(result.stdout), values);
    const web = envOf(result.stdout, "mend-web");
    assert.equal(web.get("MEND_BLOB_STORE"), undefined, "the web tier holds no bucket config");
    assert.equal(web.get("AWS_ACCESS_KEY_ID"), undefined);
  }
  const created = render("-f", path.join(chart, "ci/obc-values.yaml"));
  assert.match(
    created.stdout,
    /kind: PersistentVolumeClaim\nmetadata:\n  name: mend-store\n[\s\S]*?accessModes: \[ReadWriteOnce\]/,
  );
  assert.match(created.stdout, /storage: 50Gi/);
});
