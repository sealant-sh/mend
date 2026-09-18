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

const documentOf = (manifest, kind, name) => {
  const doc = manifest
    .split(/^---$/m)
    .find((d) => d.includes(`kind: ${kind}\n`) && d.includes(`name: ${name}\n`));
  assert.ok(doc, `${kind} ${name} rendered`);
  return doc;
};

const renderFixture = (fixture, ...settings) =>
  render(
    "-f",
    path.join(chart, `ci/${fixture}-values.yaml`),
    ...settings.flatMap((s) => ["--set", s]),
  );

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

// The fixtures under ci/ state a private executor network; a bare render states it here, so these
// tests reach the refusal they are about and not the plain-channel one.
const STATED = ["--set", "exposure.executorNetwork=private"];

test("the chart refuses to render without a bucket", { skip }, () => {
  const result = render(...STATED);
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
  assert.equal(env.get("MEND_CAPTURE_BYTE_QUOTA_FLOOR"), undefined);
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
  "a plain bucket URL renders with its credentials secret, the multipart sizes and the byte quota floor",
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
    assert.equal(env.get("MEND_CAPTURE_BYTE_QUOTA_FLOOR"), "17179869184");
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
  const values = ["--set", "captureStore.blobStore.url=s3://mend?region=eu-west-1", ...STATED];
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

for (const appUrl of ["http://localhost:3105", "https://mend.example.ts.net"]) {
  test(
    `both tiers receive the browser origin ${appUrl} without sharing backend credentials`,
    { skip },
    () => {
      for (const fixture of ["ci/obc-values.yaml", "ci/plain-url-values.yaml"]) {
        const result = render(
          "-f",
          path.join(chart, fixture),
          "--set-string",
          `web.appUrl=${appUrl}`,
        );
        assert.equal(result.status, 0, result.stderr);
        const api = envOf(result.stdout, "mend-api");
        const web = envOf(result.stdout, "mend-web");
        assert.equal(api.get("APP_URL"), appUrl);
        assert.equal(web.get("APP_URL"), appUrl);
        assert.equal(web.get("MEND_API_URL"), "http://mend-api.mend.svc:3101");
        assert.equal(api.get("MEND_ALLOWED_ORIGINS"), undefined);
        assert.equal(web.get("MEND_ALLOWED_ORIGINS"), undefined);
        for (const key of [
          "DATABASE_URL",
          "MEND_DB_PASSWORD",
          "BETTER_AUTH_SECRET",
          "SEALANT_SERVICE_KEY",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "MEND_BLOB_STORE",
        ]) {
          assert.equal(web.get(key), undefined, `${key} must stay out of the web tier`);
        }
      }
    },
  );
}

test("an explicit browser-origin list reaches both tiers", { skip }, () => {
  const origins = ["https://mend.example.ts.net", "https://mend.example.test"];
  const result = render(
    "-f",
    path.join(chart, "ci/obc-values.yaml"),
    "--set-string",
    `web.appUrl=${origins[0]}`,
    "--set-json",
    `web.allowedOrigins=${JSON.stringify(origins)}`,
  );
  assert.equal(result.status, 0, result.stderr);
  for (const deployment of ["mend-api", "mend-web"]) {
    // PublicNetwork decodes this environment variable as a JSON array, not a CSV list.
    assert.deepEqual(
      JSON.parse(envOf(result.stdout, deployment).get("MEND_ALLOWED_ORIGINS")),
      origins,
    );
  }
});

test(
  "default credentials use a precreated API service account without static AWS keys",
  { skip },
  () => {
    const result = renderFixture("default-chain");
    assert.equal(result.status, 0, result.stderr);
    const env = envOf(result.stdout, "mend-api");
    assert.equal(env.get("MEND_BLOB_STORE"), "s3://mend-captures?region=eu-west-1");
    assert.equal(
      env.get("MEND_BLOB_STORE_PUBLIC_URL"),
      "https://mend-captures.s3.eu-west-1.amazonaws.com",
    );
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "BUCKET_HOST",
    ]) {
      assert.equal(env.get(key), undefined, `${key} is not injected by the chart`);
    }
    const api = documentOf(result.stdout, "Deployment", "mend-api");
    assert.match(api, /serviceAccountName: "mend-capture-writer"/);
    assert.match(api, /automountServiceAccountToken: false/);
    const web = documentOf(result.stdout, "Deployment", "mend-web");
    assert.doesNotMatch(web, /serviceAccountName:/);
    assert.doesNotMatch(result.stdout, /kind: (ServiceAccount|Role|RoleBinding)\n/);
    assert.doesNotMatch(web, /AWS_|MEND_BLOB_STORE/);

    // Other default-chain providers need no named service account; opting in remains explicit.
    const unnamed = renderFixture("default-chain", "api.serviceAccountName=");
    assert.equal(unnamed.status, 0, unnamed.stderr);
    assert.doesNotMatch(unnamed.stdout, /serviceAccountName:/);
  },
);

for (const [name, fixture, settings, message] of [
  [
    "URL without credentials",
    "plain-url",
    ["captureStore.blobStore.credentialsSecret="],
    /credentialsSecret is required/,
  ],
  [
    "default chain and static Secret",
    "plain-url",
    ["captureStore.blobStore.useDefaultCredentials=true"],
    /useDefaultCredentials cannot be combined/,
  ],
  [
    "default chain and OBC",
    "obc",
    ["captureStore.blobStore.useDefaultCredentials=true"],
    /useDefaultCredentials cannot be combined/,
  ],
  [
    "OBC and separate static Secret",
    "obc",
    ["captureStore.blobStore.credentialsSecret=other"],
    /credentialsSecret cannot be combined/,
  ],
  ["OBC and URL", "obc", ["captureStore.blobStore.url=s3://other"], /fromObjectBucketClaim OR url/],
  [
    "OBC without Secret",
    "obc",
    ["captureStore.blobStore.fromObjectBucketClaim.secret="],
    /fromObjectBucketClaim.secret/,
  ],
  [
    "orphan OBC Secret",
    "default-chain",
    [
      "captureStore.blobStore.useDefaultCredentials=false",
      "captureStore.blobStore.fromObjectBucketClaim.secret=orphan",
    ],
    /configMap is required/,
  ],
  [
    "non-boolean credential opt-in",
    "plain-url",
    ["captureStore.blobStore.useDefaultCredentials=yes"],
    /useDefaultCredentials must be a boolean/,
  ],
]) {
  test(`the chart refuses ${name}`, { skip }, () => {
    const result = renderFixture(fixture, ...settings);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

test(
  "existing fixtures keep cluster DNS, ClusterIP, and no extra ingress or service account",
  { skip },
  () => {
    for (const fixture of ["obc", "plain-url"]) {
      const result = renderFixture(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        envOf(result.stdout, "mend-api").get("MEND_SESSION_ENDPOINT_URL"),
        "http://mend-session.mend.svc:3106",
      );
      const service = documentOf(result.stdout, "Service", "mend-session");
      assert.match(service, /type: ClusterIP/);
      assert.doesNotMatch(service, /nodePort:|externalTrafficPolicy:/);
      assert.doesNotMatch(result.stdout, /serviceAccountName:|ipBlock:/);
    }
    const tls = renderFixture(
      "obc",
      "sessionChannel.tls.enabled=true",
      "sessionChannel.tls.secretName=session-tls",
    );
    assert.equal(tls.status, 0, tls.stderr);
    assert.equal(
      envOf(tls.stdout, "mend-api").get("MEND_SESSION_ENDPOINT_URL"),
      "https://mend-session.mend.svc:3106",
    );
  },
);

test("NodePort and advertised URL change only the workspace entry point", { skip }, () => {
  const result = renderFixture("default-chain");
  assert.equal(result.status, 0, result.stderr);
  const env = envOf(result.stdout, "mend-api");
  assert.equal(env.get("MEND_SESSION_ENDPOINT_URL"), "https://mend-session.internal:3106");
  assert.equal(env.get("MEND_SESSION_ENDPOINT_LISTEN"), "0.0.0.0:3106");
  assert.equal(env.get("MEND_SESSION_ENDPOINT_TLS_CERT"), "/etc/mend/session-tls/tls.crt");
  assert.equal(env.get("MEND_SESSION_ENDPOINT_TLS_KEY"), "/etc/mend/session-tls/tls.key");
  const service = documentOf(result.stdout, "Service", "mend-session");
  assert.match(service, /type: NodePort/);
  assert.match(service, /externalTrafficPolicy: Local/);
  assert.match(service, /port: 3106\n\s+targetPort: session\n\s+nodePort: 30106/);
  for (const name of ["mend-api", "mend-web"]) {
    assert.doesNotMatch(documentOf(result.stdout, "Service", name), /NodePort|nodePort:/);
  }
  assert.doesNotMatch(result.stdout, /kind: Ingress\n|type: LoadBalancer/);

  // An advertised address does not itself expose a port or grant ingress.
  const http = renderFixture(
    "plain-url",
    "sessionChannel.advertisedUrl=http://private.example:8443/",
  );
  assert.equal(http.status, 0, http.stderr);
  assert.equal(
    envOf(http.stdout, "mend-api").get("MEND_SESSION_ENDPOINT_URL"),
    "http://private.example:8443/",
  );
  assert.doesNotMatch(http.stdout, /nodePort:|ipBlock:/);
});

test(
  "workspace CIDRs grant only the session pod port, separately from browser and service clients",
  { skip },
  () => {
    const result = renderFixture(
      "default-chain",
      "sessionChannel.port=3206",
      "networkPolicies.sessionChannelCidrs[0]=10.42.16.0/20",
      "networkPolicies.sessionChannelCidrs[1]=10.43.0.0/24",
      "networkPolicies.clientCidrs[0]=192.0.2.0/24",
      "serviceHost.expose.enabled=true",
      "serviceHost.portMax=43110",
    );
    assert.equal(result.status, 0, result.stderr);
    const api = documentOf(result.stdout, "NetworkPolicy", "mend-api");
    const ingress = api.split("  ingress:\n")[1].split("  egress:\n")[0];
    const rules = ingress.split("    - from:\n").slice(1);
    assert.equal(
      rules.length,
      5,
      "existing namespace, workspace Pods, workspace CIDRs, clients, Services",
    );
    const workspace = rules.find((rule) => rule.includes("10.42.16.0/20"));
    assert.ok(workspace);
    assert.match(workspace, /10.43.0.0\/24/);
    assert.match(workspace, /ports: \[\{ protocol: TCP, port: 3206 \}\]/);
    assert.doesNotMatch(workspace, /192\.0\.2|3101|3105|30106|43100|endPort/);
    assert.match(rules[1], /app.kubernetes.io\/managed-by: sealant/);
    assert.match(rules[1], /port: 3206/);
    const clientRules = rules.filter((rule) => rule.includes("192.0.2.0/24"));
    assert.equal(clientRules.length, 2);
    assert.match(clientRules[0], /port: 3101/);
    assert.match(clientRules[1], /port: 43100, endPort: 43110/);
    for (const rule of clientRules) assert.doesNotMatch(rule, /3206|30106|10\.42|10\.43/);
    for (const name of ["mend-web", "mend-postgres"]) {
      assert.doesNotMatch(
        documentOf(result.stdout, "NetworkPolicy", name),
        /10\.42|10\.43|3206|30106/,
      );
    }

    const disabled = renderFixture("default-chain", "networkPolicies.enabled=false");
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.doesNotMatch(disabled.stdout, /kind: NetworkPolicy/);
  },
);

for (const [name, settings, message] of [
  [
    "missing NodePort",
    ["sessionChannel.service.type=NodePort"],
    /explicit integer between 30000 and 32767/,
  ],
  [
    "low NodePort",
    ["sessionChannel.service.type=NodePort", "sessionChannel.service.nodePort=29999"],
    /explicit integer between 30000 and 32767/,
  ],
  [
    "high NodePort",
    ["sessionChannel.service.type=NodePort", "sessionChannel.service.nodePort=32768"],
    /explicit integer between 30000 and 32767/,
  ],
  [
    "fractional NodePort",
    ["sessionChannel.service.type=NodePort", "sessionChannel.service.nodePort=30106.5"],
    /explicit integer between 30000 and 32767/,
  ],
  [
    "NodePort on ClusterIP",
    ["sessionChannel.service.nodePort=30106"],
    /only be set with type=NodePort/,
  ],
  [
    "unsupported service type",
    ["sessionChannel.service.type=LoadBalancer"],
    /type must be ClusterIP or NodePort/,
  ],
  [
    "invalid listen port",
    ["sessionChannel.port=65536"],
    /port must be an integer between 1 and 65535/,
  ],
  [
    "non-HTTP URL",
    ["sessionChannel.advertisedUrl=tcp://mend.internal:3106"],
    /must be an http\(s\) origin/,
  ],
  [
    "relative URL",
    ["sessionChannel.advertisedUrl=mend.internal:3106"],
    /must be an http\(s\) origin/,
  ],
  ["URL without host", ["sessionChannel.advertisedUrl=http:///"], /must be an http\(s\) origin/],
  [
    "URL with path",
    ["sessionChannel.advertisedUrl=http://mend.internal/channel"],
    /must be an http\(s\) origin/,
  ],
  [
    "URL with credentials",
    ["sessionChannel.advertisedUrl=http://user:password@mend.internal"],
    /must be an http\(s\) origin/,
  ],
  [
    "URL with query",
    ["sessionChannel.advertisedUrl=http://mend.internal?token=value"],
    /must be an http\(s\) origin/,
  ],
  [
    "URL with fragment",
    ["sessionChannel.advertisedUrl=http://mend.internal#channel"],
    /must be an http\(s\) origin/,
  ],
  [
    "HTTPS without TLS",
    ["sessionChannel.advertisedUrl=https://mend.internal"],
    /scheme must match sessionChannel.tls.enabled/,
  ],
  [
    "HTTP with TLS",
    [
      "sessionChannel.advertisedUrl=http://mend.internal",
      "sessionChannel.tls.enabled=true",
      "sessionChannel.tls.secretName=session-tls",
    ],
    /scheme must match sessionChannel.tls.enabled/,
  ],
  ["TLS without Secret", ["sessionChannel.tls.enabled=true"], /sessionChannel.tls.secretName/],
]) {
  test(`the chart refuses ${name}`, { skip }, () => {
    const result = renderFixture("plain-url", ...settings);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

for (const nodePort of [30000, 32767]) {
  test(`NodePort boundary ${nodePort} is accepted`, { skip }, () => {
    const result = renderFixture(
      "plain-url",
      "sessionChannel.service.type=NodePort",
      `sessionChannel.service.nodePort=${nodePort}`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      documentOf(result.stdout, "Service", "mend-session"),
      new RegExp(`nodePort: ${nodePort}`),
    );
  });
}

// ─── The edge (docs/adr/0004-access-without-a-private-network.md) ────────────────────────────────

const INGRESS = [
  "ingress.enabled=true",
  "ingress.host=mend.example.com",
  "ingress.tls.secretName=mend-tls",
  "ingress.className=nginx",
  "ingress.controller.namespace=ingress-nginx",
  "ingress.controller.podLabels.app\\.kubernetes\\.io/name=ingress-nginx",
];
const withIngress = (...extra) =>
  render(
    "-f",
    path.join(chart, "ci/obc-values.yaml"),
    "--set-string",
    "web.appUrl=https://mend.example.com",
    ...[...INGRESS, ...extra].flatMap((s) => ["--set", s]),
  );

test("no Ingress is rendered unless asked for, and exposure defaults to private", { skip }, () => {
  const result = renderFixture("obc");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("kind: Ingress"));
  assert.equal(envOf(result.stdout, "mend-api").get("MEND_EXPOSURE"), "private");
  assert.equal(envOf(result.stdout, "mend-api").get("MEND_URL_BEARERS"), undefined);
});

test("the Ingress routes one TLS host to the web Service and nothing else", { skip }, () => {
  const result = withIngress();
  assert.equal(result.status, 0, result.stderr);
  const ingress = documentOf(result.stdout, "Ingress", "mend-web");
  assert.match(ingress, /ingressClassName: "nginx"/);
  assert.match(ingress, /hosts: \["mend\.example\.com"\]\n\s+secretName: "mend-tls"/);
  assert.match(ingress, /name: mend-web\n\s+port: \{ number: 3105 \}/);
  // One rule, one path, one backend: the API, Sealant and the session channel are never routed.
  assert.equal(ingress.match(/backend:/g).length, 1);
  assert.ok(!ingress.includes("mend-api"));
  assert.ok(!ingress.includes("3101") && !ingress.includes("3106"));
  // Exactly one Ingress in the whole render.
  assert.equal(result.stdout.match(/^kind: Ingress$/gm).length, 1);
});

test(
  "the Ingress is refused without TLS, without a host, or with a browser origin that is not it",
  { skip },
  () => {
    const base = ["-f", path.join(chart, "ci/obc-values.yaml")];
    const noTls = render(
      ...base,
      "--set-string",
      "web.appUrl=https://mend.example.com",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.host=mend.example.com",
    );
    assert.notEqual(noTls.status, 0);
    assert.match(noTls.stderr, /never routed without TLS/);

    const noHost = render(
      ...base,
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.tls.secretName=t",
    );
    assert.notEqual(noHost.status, 0);
    assert.match(noHost.stderr, /ingress\.host is required/);

    for (const appUrl of [
      "http://mend.example.com",
      "https://other.example.com",
      "https://mend.example.com/",
    ]) {
      const mismatched = render(
        ...base,
        "--set-string",
        `web.appUrl=${appUrl}`,
        ...INGRESS.flatMap((s) => ["--set", s]),
      );
      assert.notEqual(mismatched.status, 0, appUrl);
      assert.match(mismatched.stderr, /web\.appUrl must be exactly https:\/\/mend\.example\.com/);
    }
  },
);

test(
  "exposure values are held to what the API accepts, so a typo fails at render and not at boot",
  { skip },
  () => {
    const base = ["-f", path.join(chart, "ci/obc-values.yaml")];
    const typo = render(...base, "--set", "exposure.executorNetwork=yes");
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /exposure\.executorNetwork must be empty or "private"/);

    const stated = render(...base, "--set", "exposure.declared={core-private,edge-tls}");
    assert.equal(stated.status, 0, stated.stderr);
    assert.match(stated.stdout, /name: MEND_EXPOSURE_DECLARED, value: "core-private,edge-tls"/);

    // Only what no process can observe may be declared: an observable item is read, not stated.
    const observable = render(...base, "--set", "exposure.declared={budgets}");
    assert.notEqual(observable.status, 0);
    assert.match(observable.stderr, /exposure\.declared takes only core-private and edge-tls/);

    const unset = render(...base);
    assert.equal(unset.status, 0, unset.stderr);
    assert.ok(!unset.stdout.includes("MEND_EXPOSURE_DECLARED"));
  },
);

test(
  "a plain-http session channel renders only on the operator's statement, or under TLS",
  { skip },
  () => {
    // The fixtures state it; without the statement the daemon Sealant 0.34 bakes would refuse to
    // boot every workspace, so the chart refuses to render one.
    const base = ["-f", path.join(chart, "ci/obc-values.yaml")];
    const unstated = render(...base, "--set", "exposure.executorNetwork=");
    assert.notEqual(unstated.status, 0);
    assert.match(unstated.stderr, /set exposure\.executorNetwork: private/);

    const tls = render(
      ...base,
      "--set",
      "exposure.executorNetwork=",
      "--set",
      "sessionChannel.tls.enabled=true",
      "--set",
      "sessionChannel.tls.secretName=session-tls",
      "--set",
      "sessionChannel.tls.ca.secretName=session-tls",
    );
    assert.equal(tls.status, 0, tls.stderr);
    const api = envOf(tls.stdout, "mend-api");
    assert.equal(api.get("MEND_EXECUTOR_NETWORK"), undefined);
    // A private CA's roots reach the API as a file, and from there every capture launch.
    assert.equal(api.get("MEND_SESSION_ENDPOINT_CA_FILE"), "/etc/mend/session-ca/ca.crt");
    assert.match(tls.stdout, /name: session-ca\n\s+secret:\n\s+secretName: session-tls/);

    const stated = render(...base);
    assert.equal(stated.status, 0, stated.stderr);
    assert.equal(envOf(stated.stdout, "mend-api").get("MEND_EXECUTOR_NETWORK"), "private");
    assert.equal(envOf(stated.stdout, "mend-api").get("MEND_SESSION_ENDPOINT_CA_FILE"), undefined);
  },
);

test(
  "NetworkPolicy admits the ingress controller's Pods to web by namespace AND label, and not to the API",
  { skip },
  () => {
    const result = withIngress();
    assert.equal(result.status, 0, result.stderr);
    const web = documentOf(result.stdout, "NetworkPolicy", "mend-web");
    // One `from` entry carrying both selectors: two entries would mean OR.
    assert.match(
      web,
      /- namespaceSelector: \{ matchLabels: \{ kubernetes\.io\/metadata\.name: "ingress-nginx" \} \}\n\s+podSelector:\n\s+matchLabels:\s*\n\s+app\.kubernetes\.io\/name: ingress-nginx\n\s+ports: \[\{ protocol: TCP, port: 3105 \}\]/,
    );
    const api = documentOf(result.stdout, "NetworkPolicy", "mend-api");
    assert.ok(!api.includes("ingress-nginx"));

    const unnamed = render(
      "-f",
      path.join(chart, "ci/obc-values.yaml"),
      "--set-string",
      "web.appUrl=https://mend.example.com",
      ...INGRESS.filter((s) => !s.startsWith("ingress.controller")).flatMap((s) => ["--set", s]),
    );
    assert.notEqual(unnamed.status, 0);
    assert.match(
      unnamed.stderr,
      /ingress\.controller\.namespace and ingress\.controller\.podLabels/,
    );
  },
);

test(
  "the exposure values reach the API as the operator's declaration, and only the API",
  { skip },
  () => {
    const result = withIngress(
      "exposure.mode=public",
      "exposure.executorNetwork=private",
      "exposure.refuseUrlBearers=true",
      "exposure.reassessedVersion=0.29.0",
    );
    assert.equal(result.status, 0, result.stderr);
    const api = envOf(result.stdout, "mend-api");
    assert.equal(api.get("MEND_EXPOSURE"), "public");
    assert.equal(api.get("MEND_EXECUTOR_NETWORK"), "private");
    assert.equal(api.get("MEND_URL_BEARERS"), "refuse");
    assert.equal(api.get("MEND_EXPOSURE_REASSESSED"), "0.29.0");
    assert.equal(envOf(result.stdout, "mend-web").get("MEND_EXPOSURE"), undefined);

    const unknown = renderFixture("obc", "exposure.mode=internet");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /exposure\.mode must be loopback, private or public/);
  },
);
