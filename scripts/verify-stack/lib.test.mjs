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
  generationOf,
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
const inspected = (Id, name, labels, networks = {}, mounts = []) => ({
  Id,
  Name: `/${name}`,
  Config: { Labels: labels },
  NetworkSettings: { Networks: networks },
  Mounts: mounts.map((Name) => ({ Type: "volume", Name })),
});

test("a generation is what the stack's provenance names, and never Docker's own networks (N13)", () => {
  const own = { [STACK_LABEL]: "1" };
  const containers = [
    inspected("owner", OWNER_CONTAINER, own),
    inspected("relay", RELAY_CONTAINER, own, { bridge: { NetworkID: "bridge" } }, [STATE_VOLUME]),
    // On the default bridge, beside the relay: Docker's network names nobody's container.
    inspected("web", "web-1", {}, { bridge: { NetworkID: "bridge" } }, ["data"]),
    inspected("sealant", "sealant-12ab", {}, { bridge: { NetworkID: "bridge" } }),
    inspected("named", "verify-stack-named", {}),
  ];
  const volumes = [
    { Name: STATE_VOLUME, Labels: own },
    { Name: "data", Labels: {} },
    { Name: "mend-store", Labels: {} },
  ];
  // Without the stack's state, its own resources only.
  assert.deepEqual(
    generationOf({ containers, volumes, stateMountpoint: null, installation: null }),
    { containers: ["relay"], volumes: [STATE_VOLUME], networks: [] },
  );
  // The owner is never in it; an unlabelled name or a product name never is either.
  const withState = generationOf({
    containers,
    volumes,
    stateMountpoint: "/var/lib/docker/volumes/verify-stack-state/_data",
    installation: "f".repeat(64),
  });
  assert.deepEqual(withState.containers, ["relay"]);
  assert.deepEqual(withState.volumes, [STATE_VOLUME]);
});
