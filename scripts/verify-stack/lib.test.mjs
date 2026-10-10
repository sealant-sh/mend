import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  composeImages,
  defaultSpec,
  describeSource,
  dockerClientEnvironment,
  fetchRefspec,
  formatKb,
  formatSeconds,
  SHAPES,
  madeSince,
  manualRemoval,
  mergeLedgers,
  planTeardown,
  imageNames,
  innerOrigins,
  insideCaptureRoot,
  isolationFindings,
  mendBuildArgs,
  parseMemory,
  parseSource,
  relayEndpoint,
  beyondRetention,
  FIXTURE_CONTAINER,
  FIXTURE_VOLUME,
  OWNER_CONTAINER,
  RELAY_CONTAINER,
  STACK_LABEL,
  STATE_VOLUME,
  verifyVersion,
} from "./lib.mjs";

const tree = (c) => c.repeat(40);

test("a spec names a path, a pull request, a ref or the pins", () => {
  assert.deepEqual(parseSource("mend", "."), { repository: "mend", kind: "worktree", path: "." });
  assert.deepEqual(parseSource("sealant", "/workspace/repos/sealant"), {
    repository: "sealant",
    kind: "worktree",
    path: "/workspace/repos/sealant",
  });
  assert.deepEqual(parseSource("sealant", "#345"), {
    repository: "sealant",
    kind: "pr",
    number: 345,
  });
  assert.deepEqual(parseSource("sealantd", "pr:152"), {
    repository: "sealantd",
    kind: "pr",
    number: 152,
  });
  assert.deepEqual(parseSource("sealantd", "feat/plan-sources"), {
    repository: "sealantd",
    kind: "ref",
    ref: "feat/plan-sources",
  });
  assert.deepEqual(parseSource("sealant", "pinned"), { repository: "sealant", kind: "pinned" });
});

test("a spec git or a shell could misread is refused", () => {
  assert.throws(() => parseSource("mend", "pinned"), /builds Mend from source/);
  for (const bad of ["--upload-pack=x", "a..b", "main;rm", "", "ref with space"])
    assert.throws(() => parseSource("sealant", bad));
  assert.throws(() => parseSource("core", "main"), /unknown repository/);
});

test("defaults: this checkout, then the session's added repository, then main", () => {
  const context = { mendRoot: "/workspace/repo", sessionRepos: ["sealant"] };
  assert.equal(defaultSpec("mend", context), "/workspace/repo");
  assert.equal(defaultSpec("sealant", context), "/workspace/repos/sealant");
  assert.equal(defaultSpec("sealantd", context), "main");
});

test("a pull request is fetched by its head ref, a ref as itself", () => {
  assert.equal(fetchRefspec({ kind: "pr", number: 600 }), "refs/pull/600/head");
  assert.equal(fetchRefspec({ kind: "ref", ref: tree("a") }), tree("a"));
  assert.equal(fetchRefspec({ kind: "ref", ref: "main" }), "main");
  assert.throws(() => fetchRefspec({ kind: "worktree", path: "." }));
});

test("a source reads as what was asked for and what was built", () => {
  assert.equal(
    describeSource({
      repository: "sealant",
      kind: "pr",
      number: 345,
      commit: tree("1"),
      tree: tree("9"),
    }),
    "sealant #345 @ 111111111111 (tree 999999999999)",
  );
  assert.match(
    describeSource({
      repository: "mend",
      kind: "worktree",
      path: "/workspace/repo",
      dirty: true,
      commit: tree("2"),
      tree: tree("3"),
    }),
    /uncommitted changes included/,
  );
});

test("images are named by their trees; the bundle by its tree and every upstream image", () => {
  const sources = {
    mend: { kind: "worktree", tree: tree("a") },
    sealant: { kind: "pr", tree: tree("b") },
    sealantd: { kind: "ref", tree: tree("c") },
  };
  const one = imageNames(sources, { cliVersion: "0.35.1", upstreamIds: ["x", "y"] });
  assert.equal(one.sealantd, "mend-verify/sealantd:cccccccccccc");
  assert.equal(one.sealantApi, "mend-verify/sealant-api:bbbbbbbbbbbb");
  assert.equal(one.cli, "mend-verify/mend-cli:aaaaaaaaaaaa");
  assert.match(one.version, /^0\.35\.1-verify\.t[0-9a-f]{12}$/);
  assert.equal(one.mend, `ghcr.io/sealant-sh/mend:${one.version}`);
  const rebuiltUpstream = imageNames(sources, { cliVersion: "0.35.1", upstreamIds: ["x", "z"] });
  assert.notEqual(rebuiltUpstream.version, one.version, "a new upstream image is a new bundle");
  const pinned = imageNames(
    { ...sources, sealant: { kind: "pinned" }, sealantd: { kind: "pinned" } },
    { cliVersion: "0.36.0-next.656", upstreamIds: [] },
  );
  assert.equal(pinned.sealantApi, null);
  assert.equal(pinned.sealantd, null);
  assert.match(pinned.version, /^0\.36\.0-verify\.t/);
  assert.deepEqual(Object.keys(mendBuildArgs(pinned)), ["MEND_VERSION"]);
  assert.deepEqual(Object.keys(mendBuildArgs(one)).toSorted(), [
    "MEND_PREVIEW_SEALANTD_IMAGE",
    "MEND_VERSION",
    "SEALANT_API_IMAGE",
    "SEALANT_SSH_GATEWAY_IMAGE",
    "SEALANT_WORKER_IMAGE",
  ]);
});

test("a verify version is a semver prerelease even when the digest is all digits", () => {
  assert.equal(verifyVersion("1.2.3", "012345678901"), "1.2.3-verify.t012345678901");
  assert.throws(() => verifyVersion("dev", "abcdef"));
  assert.throws(() => verifyVersion("1.2.3", "not-hex"));
});

test("the root Dockerfile takes every build argument the bundle is given", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  for (const name of [
    "MEND_VERSION",
    "SEALANT_API_IMAGE",
    "SEALANT_WORKER_IMAGE",
    "SEALANT_SSH_GATEWAY_IMAGE",
    "MEND_PREVIEW_SEALANTD_IMAGE",
  ])
    assert.match(dockerfile, new RegExp(`^ARG ${name}=`, "m"), name);
});

test("the images an offline setup needs are read from the Compose file", async () => {
  const compose = await readFile(
    new URL("../../deploy/docker/compose.v2.yaml", import.meta.url),
    "utf8",
  );
  const images = composeImages(compose);
  assert.ok(images.some((image) => image.startsWith("postgres:")));
  assert.ok(images.some((image) => image.startsWith("dxflrs/garage:")));
  assert.ok(
    images.every((image) => !image.includes("$")),
    "the templated Mend image is built",
  );
  // The mirrors' overlay, which setup adds by default: its images are pulled too.
  const mirrors = await readFile(
    new URL("../../deploy/docker/compose.mirrors.yaml", import.meta.url),
    "utf8",
  ).catch(() => "");
  for (const image of composeImages(mirrors))
    assert.ok(composeImages(`${compose}\n${mirrors}`).includes(image), image);
});

test("a Docker client gets the daemon and nothing of the session", () => {
  const env = dockerClientEnvironment(
    {
      PATH: "/usr/bin",
      DOCKER_HOST: "tcp://docker:2375",
      MEND_SESSION_TOKEN: "outer-secret",
      MEND_SESSION_ID: "s",
      SEALANT_CAPTURE_TOKEN: "outer-secret-2",
      GH_TOKEN: "gh",
      ANTHROPIC_API_KEY: "k",
      SSH_AUTH_SOCK: "/run/agent",
      DOCKER_CONFIG: "/home/p/.docker",
    },
    { home: "/c/home", dockerConfig: "/c/docker" },
  );
  assert.equal(env.DOCKER_HOST, "tcp://docker:2375");
  assert.equal(env.DOCKER_CONFIG, "/c/docker");
  assert.equal(env.SSH_AUTH_SOCK, "");
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /^(MEND_|SEALANT_|GH_|ANTHROPIC)/);
  assert.ok(!Object.values(env).some((value) => value.includes("outer-secret")));
});

test("the relay publishes on every interface only of a session's sidecar", () => {
  assert.deepEqual(relayEndpoint("tcp://docker:2375", 3105), {
    publish: "0.0.0.0:3105:3105",
    host: "docker",
    port: 3105,
  });
  assert.deepEqual(relayEndpoint(undefined, 3105), {
    publish: "127.0.0.1:3105:3105",
    host: "127.0.0.1",
    port: 3105,
  });
  assert.equal(relayEndpoint("unix:///var/run/docker.sock", 4000).publish, "127.0.0.1:4000:3105");
  // A TCP daemon that is not the session's sidecar: loopback, never every interface.
  assert.deepEqual(relayEndpoint("tcp://127.0.0.1:2375", 3305), {
    publish: "127.0.0.1:3305:3105",
    host: "127.0.0.1",
    port: 3305,
  });
  assert.equal(relayEndpoint("tcp://build-box.lan:2375", 3305).publish, "127.0.0.1:3305:3105");
  assert.throws(() => relayEndpoint("ssh://box", 3105), /tcp:\/\/ or unix:\/\//);
});

test("the stack's own names stay out of the namespace setup claims", () => {
  for (const name of [
    STATE_VOLUME,
    OWNER_CONTAINER,
    RELAY_CONTAINER,
    FIXTURE_CONTAINER,
    FIXTURE_VOLUME,
  ])
    assert.doesNotMatch(name, /^mend[-_]/, name);
});

test("a cache keeps its newest entries", () => {
  const entries = [
    { name: "a", mtimeMs: 1 },
    { name: "c", mtimeMs: 3 },
    { name: "b", mtimeMs: 2 },
    { name: "d", mtimeMs: 4 },
  ];
  assert.deepEqual(beyondRetention(entries, 2).toSorted(), ["a", "b"]);
  assert.deepEqual(beyondRetention(entries, 10), []);
  assert.deepEqual(beyondRetention([], 3), []);
});

test("the inner server trusts the connected port and the session's view of the relay", () => {
  assert.deepEqual(innerOrigins({ host: "docker", port: 3105 }), {
    url: "http://localhost:3105",
    extra: ["http://127.0.0.1:3105", "http://docker:3105"],
  });
  assert.deepEqual(innerOrigins({ host: "127.0.0.1", port: 3200 }).extra, [
    "http://127.0.0.1:3200",
  ]);
});

test("nothing of a stack may live in a capture root", () => {
  assert.equal(insideCaptureRoot("/workspace/repo/.cache/x"), true);
  assert.equal(insideCaptureRoot("/workspace"), true);
  assert.equal(insideCaptureRoot("/workspace/../workspace/repo"), true);
  assert.equal(insideCaptureRoot("/home/m4x2k/.cache/mend-verify-stack"), false);
  assert.equal(insideCaptureRoot("/workspaces-elsewhere"), false);
});

test("an outer credential found in a container is named by place, never by value", () => {
  const containers = [
    { Name: "/mend-mend-1", Config: { Env: ["A=1"], Cmd: ["node"], Labels: {} } },
    {
      Name: "/leaky",
      Config: { Env: ["T=outer-token-value"], Cmd: ["run", "outer-token-value"], Labels: {} },
    },
  ];
  const findings = isolationFindings(containers, ["outer-token-value", "short"]);
  assert.deepEqual(findings, ["leaky env", "leaky command"]);
  assert.ok(!findings.join(" ").includes("outer-token-value"));
  assert.deepEqual(isolationFindings(containers, []), []);
});

test("memory sums the proportional set sizes of every process read", () => {
  const memory = parseMemory(
    "250458 node /app/apps/api/dist/main.js\n\n162516 node /opt/sealant/api/dist/index.js\nnoise\n36432 /garage server\n",
  );
  assert.equal(memory.totalKb, 449406);
  assert.equal(memory.processes[0].command, "node /app/apps/api/dist/main.js");
  assert.equal(memory.processes.length, 3);
  assert.equal(formatKb(1_453_744), "1.39 GiB");
  assert.equal(formatKb(36_432), "36 MiB");
  assert.equal(formatSeconds(42.4), "42 s");
  assert.equal(formatSeconds(125), "2 min 5 s");
});

/** A container as `docker inspect` shows it. */
const inspected = (Id, name, labels = {}) => ({ Id, Name: `/${name}`, Config: { Labels: labels } });
const own = { [STACK_LABEL]: "1" };

test("a recording window records what appeared and has the stack's shape, by identity (R7-1)", () => {
  const before = {
    containers: [{ id: "c1", name: "mend-mend-1", compose: "mend" }],
    networks: [{ id: "n1", name: "mend_default", compose: "mend" }],
    volumes: [{ name: "mend-store", createdAt: "t1" }],
  };
  const after = {
    containers: [
      ...before.containers,
      { id: "c2", name: "sealant-run-5e55", compose: "", mounts: ["mend-control"] },
      { id: "c3", name: "sealant-run-5e55-docker", compose: "", workspace: "sealant-run-5e55" },
      { id: "c4", name: "mend-mend-2", compose: "mend" },
      // Another client on the session's daemon: a dev database, its network and its data.
      { id: "c5", name: "mend-dev-postgres-1", compose: "mend-dev" },
      // The person's Core dev stack (Compose project `sealant`), and a hand-named `sealant-…`
      // container and sidecar lookalike: none is an inner session (R8-1).
      { id: "c6", name: "sealant-postgres-1", compose: "sealant", mounts: ["mend-control"] },
      { id: "c7", name: "sealant-test-redis", compose: "", mounts: ["0f3a"] },
      { id: "c8", name: "sealant-ci-docker", compose: "", workspace: "" },
    ],
    networks: [
      ...before.networks,
      { id: "n2", name: "sealant-run-5e55-network", compose: "" },
      { id: "n3", name: "mend-dev_default", compose: "mend-dev" },
      { id: "n4", name: "sealant-ci-network", compose: "sealant-ci" },
    ],
    volumes: [
      // Removed and made again: another volume.
      { name: "mend-store", createdAt: "t2" },
      { name: "mend-dev_mend-dev-pgdata", createdAt: "t3" },
    ],
  };
  assert.deepEqual(madeSince(before, after, SHAPES.install), {
    containers: ["c2", "c3", "c4"],
    networks: ["n2"],
    volumes: [{ name: "mend-store", createdAt: "t2" }],
  });
  // A `mend` or `check` window takes an inner session's shapes only.
  assert.deepEqual(madeSince(before, after, SHAPES.session), {
    containers: ["c2", "c3"],
    networks: ["n2"],
    volumes: [],
  });
  assert.deepEqual(
    mergeLedgers([madeSince(before, after, SHAPES.session), { containers: ["c3", "c9"] }]),
    { containers: ["c2", "c3", "c9"], networks: ["n2"], volumes: [] },
  );
});

test("a teardown removes what was recorded and has the stack's shape, and follows nothing (R7-1, R7-2)", () => {
  const plan = planTeardown({
    ledger: {
      containers: ["inner", "gone", "dev"],
      networks: ["net-inner", "bridge-id", "net-dev"],
      // One name made twice by the stack: every record counts.
      volumes: [
        { name: "mend-store", createdAt: "t1" },
        { name: "mend-store", createdAt: "t5" },
        { name: "mend-garage", createdAt: "t1" },
        { name: "mend-dev_mend-dev-pgdata", createdAt: "t1" },
      ],
    },
    containers: [
      inspected("owner", OWNER_CONTAINER, own),
      inspected("relay", RELAY_CONTAINER, own),
      inspected("inner", "mend-mend-1", { "com.docker.compose.project": "mend" }),
      // Recorded by an older window, but nothing the stack makes looks like it.
      inspected("dev", "mend-dev-postgres-1", { "com.docker.compose.project": "mend-dev" }),
      // Never recorded: the product's Compose project, an executor, half of the stack's mark.
      inspected("product", "mend-mend-2", { "com.docker.compose.project": "mend" }),
      {
        ...inspected("executor", "sealant-12ab"),
        Mounts: [{ Type: "volume", Name: "mend-control" }],
      },
      inspected("half", "verify-stack-named"),
      inspected("web", "web-1"),
    ],
    volumes: [
      { Name: STATE_VOLUME, Labels: own, CreatedAt: "t0" },
      { Name: "mend-store", Labels: {}, CreatedAt: "t5" },
      { Name: "mend-garage", Labels: {}, CreatedAt: "t9" },
      { Name: "mend-dev_mend-dev-pgdata", Labels: {}, CreatedAt: "t1" },
      { Name: "data", Labels: {}, CreatedAt: "t1" },
    ],
    networks: [
      { Id: "net-inner", Name: "mend_default", Labels: { "com.docker.compose.project": "mend" } },
      { Id: "bridge-id", Name: "bridge" },
      {
        Id: "net-dev",
        Name: "mend-dev_default",
        Labels: { "com.docker.compose.project": "mend-dev" },
      },
      { Id: "net-product", Name: "sealant-12ab-network" },
    ],
  });
  assert.deepEqual(
    plan.containers.map((item) => item.Id),
    ["relay", "inner"],
  );
  assert.deepEqual(
    plan.volumes.map((item) => item.Name),
    [STATE_VOLUME, "mend-store"],
  );
  assert.deepEqual(
    plan.networks.map((item) => item.Id),
    ["net-inner"],
  );
  assert.deepEqual(
    plan.leftAlone.map((item) => `${item.reason}: ${item.kind} ${item.name}`),
    [
      "not the stack's shape: container mend-dev-postgres-1",
      "not recorded: container mend-mend-2",
      "not recorded: container sealant-12ab",
      "not recorded: container verify-stack-named",
      "made again: volume mend-garage",
      "not the stack's shape: volume mend-dev_mend-dev-pgdata",
      "not the stack's shape: network mend-dev_default",
      "not recorded: network sealant-12ab-network",
    ],
  );
  assert.deepEqual(manualRemoval(plan.leftAlone), [
    "docker rm --force dev product executor half",
    "docker volume rm mend-garage mend-dev_mend-dev-pgdata",
    "docker network rm net-dev net-product",
  ]);
  // Without a ledger: the stack's own infrastructure only.
  const bare = planTeardown({
    ledger: { containers: [], networks: [], volumes: [] },
    containers: [inspected("relay", RELAY_CONTAINER, own), inspected("inner", "mend-mend-1")],
    volumes: [{ Name: "mend-store", Labels: {}, CreatedAt: "t1" }],
    networks: [],
  });
  assert.deepEqual(
    bare.containers.map((item) => item.Id),
    ["relay"],
  );
  assert.deepEqual(bare.volumes, []);
});
