#!/usr/bin/env node
/**
 * Linux packaged-product acceptance, destructive ONLY to a fresh default Mend installation.
 * Run after integrating the CLI/setup/bundle branches:
 *   MEND_TEST_IMAGE=ghcr.io/sealant-sh/mend:0.23.0 MEND_TEST_VERSION=0.23.0 \
 *     node scripts/check-packaged-server.mjs
 * The image must already be built/loaded or published. Nothing retags or substitutes it.
 * Set MEND_TEST_OFFLINE=1 for preloaded Mend and Postgres images, with no setup pulls.
 *
 * Required public setup contract: --version, --assets-dir, --offline, --port, --ssh-port,
 * --url. Assets come from deploy/docker, validated by setup exactly
 * like release downloads. Required lifecycle commands: server restart, stop, start.
 * Missing commands/flags FAIL acceptance; there is no direct-Compose fallback.
 *
 * Optional paired MEND_TEST_UPGRADE_IMAGE / MEND_TEST_UPGRADE_VERSION enable the real
 * public two-image upgrade. MEND_TEST_UPGRADE_ASSETS defaults to deploy/docker.
 * CI must build both canonical images from Dockerfile with genuine version stamps, not
 * retag one image or override health ENV. Same-source fixtures prove upgrade mechanics
 * and retention only, not historical schema migration or backup restore compatibility.
 * No macOS claim. SIGKILL cannot clean up; retained resources make the next run refuse.
 * Raw command output, HTTP bodies, credentials and Docker logs are never printed. A failure
 * after the session exists prints DIAGNOSIS lines instead: status words from the public API and
 * the engine's own message heads, with their annotations left out and opaque runs masked.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPackagedDotfilesAcceptance } from "./packaged-dotfiles-acceptance.mjs";
import { preparePackagedGitAccessAcceptance } from "./packaged-git-access-acceptance.mjs";
import {
  assertFreshDocker,
  assertHealth,
  assertImagePin,
  assertInstallDockerEvents,
  assertUpgradeRetention,
  assertCaptureExecutor,
  cleanupOwnedVolumes,
  completedCommandEvidence,
  createVolumeLedger,
  createDiagnosticProbe,
  createFailedCommandDiagnostics,
  dockerFingerprint,
  isolatedClientEnvironment,
  isInside,
  ownsComposeContainer,
  captureRegisteredEvidence,
  checkpointChainEvidence,
  flushAttemptEvidence,
  flushReportEvidence,
  reviewDiffEvidence,
  ownsWorkspaceContainer,
  readPrivateIdentity,
  readUpgradeInputs,
  requestFailureEvidence,
  setupFailureEvidence,
  runPackagedUpgrade,
  privateTreeFingerprint,
  verifyUpgradeBackup,
  engineTimelineEvidence,
  sessionStateEvidence,
} from "./packaged-server-assertions.mjs";
import { preparePackagedSshAcceptance } from "./packaged-ssh-acceptance.mjs";

const repo = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const assets = join(repo, "deploy/docker");
const version = process.env.MEND_TEST_VERSION;
const image = process.env.MEND_TEST_IMAGE;
const offline = process.env.MEND_TEST_OFFLINE === "1";
const originalHome = homedir();
const runId = randomUUID();
const fixtureName = `mend-acceptance-${runId}`;
const fixtureVolume = `${fixtureName}-git`;
const projectName = `acceptance-${runId}`;
const marker = `packaged-proof-${runId}`;
const activeChildren = new Set();
const failedCommands = createFailedCommandDiagnostics();
let interrupted = false;
let stage = "read-only preflight";
let scratch;
let lock;
let context;
let initial;
let configRoot;
let fixtureId;
let gitAccessImage;
let setupAttempted = false;
let cleanupFailed = false;
const containers = new Set();
const networks = new Map();
let volumes;
let upgrade;
// The proof session, once there is one: what a failure in any later stage (capture, dotfiles,
// lifecycle, upgrade) classifies in the CI log (`printDiagnosis`).
let diagnosis;

// Only read-only Docker preflight uses the original home. Every subsequent client gets a
// private HOME/XDG tree, no agent socket, no Git overrides, and no Mend/harness credentials.
// Docker alone retains its context/credential configuration; no login/context-use is run.
const dockerConfig = process.env.DOCKER_CONFIG || join(originalHome, ".docker");
let env = isolatedClientEnvironment(process.env, originalHome, dockerConfig);

function check(condition, message) {
  // Do not let assertion diffs accidentally render identity.env, tokens, or HTTP bodies.
  assert.ok(condition, message);
}

function start(command, args, options = {}) {
  const { timeout = 120_000, cwd = scratch ?? repo, environment = env, diagnostic } = options;
  const probe = createDiagnosticProbe(diagnostic);
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  activeChildren.add(child);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminated = false;
  let spawnError;
  const commandStage = stage;
  const limit = 16 * 1024 * 1024;
  const terminate = () => {
    terminated = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  };
  const timer = setTimeout(terminate, timeout);
  child.stdout.on("data", (chunk) => {
    probe.accept(chunk);
    stdout.push(chunk.subarray(0, Math.max(0, limit - stdoutBytes)));
    stdoutBytes += chunk.length;
    if (stdoutBytes > limit) terminate();
  });
  child.stderr.on("data", (chunk) => {
    probe.accept(chunk);
    stderr.push(chunk.subarray(0, Math.max(0, limit - stderrBytes)));
    stderrBytes += chunk.length;
    if (stderrBytes > limit) terminate();
  });
  const result = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = String(error);
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).then(async ({ code, signal }) => {
    clearTimeout(timer);
    activeChildren.delete(child);
    const ok = code === 0 && !terminated && !spawnError;
    const output = Buffer.concat(stdout);
    if (!ok || options.failureEvidence === true)
      await failedCommands.record(
        {
          stage: commandStage,
          command,
          args,
          code,
          signal,
          spawnError,
          terminated,
          stdoutTruncated: stdoutBytes > limit,
          stderrTruncated: stderrBytes > limit,
        },
        output,
        Buffer.concat(stderr),
      );
    return {
      ok,
      code,
      signal,
      terminated,
      output: output.toString(),
      error: Buffer.concat(stderr).toString(),
      diagnosticMatched: probe.matched(),
    };
  });
  return { result, terminate };
}

async function run(command, args, options) {
  const result = await start(command, args, options).result;
  check(
    result.ok,
    `${stage}: ${command === process.execPath ? "installed mend" : command} failed; output withheld to protect credentials`,
  );
  return result.output;
}

const docker = (args, options) =>
  run("docker", [...(context ? ["--context", context] : []), ...args], options);
const lines = (text) => text.trim().split(/\s+/).filter(Boolean);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How the instance is deployed, not what it found: /health also reports the tenancy and
// exposure gates as evaluated at start, and an installation with an account and a project
// answers those differently from the empty one the baseline was read from.
const deployment = (body) =>
  JSON.stringify([
    body.deploymentMode,
    body.storeRoot,
    body.sessionChannel,
    body.tenancy,
    body.exposure?.declared,
  ]);

async function snapshot() {
  const inspect = async (kind, listing) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ids = lines(await docker(listing));
      if (ids.length === 0) return [];
      const result = await start("docker", ["--context", context, kind, "inspect", ...ids]).result;
      if (result.ok) return JSON.parse(result.output);
      // Normal workspace reclamation can race ps/inspect. Retry only a changed
      // inventory, never hide a permission/daemon error against the same IDs.
      check(
        lines(await docker(listing)).join(",") !== ids.join(","),
        `Cannot inspect Docker ${kind} inventory`,
      );
    }
    check(false, "Docker inventory kept changing; acceptance cannot establish ownership");
  };
  return {
    containers: await inspect("container", ["ps", "-aq", "--no-trunc"]),
    networks: await inspect("network", ["network", "ls", "-q", "--no-trunc"]),
    volumes: await inspect("volume", ["volume", "ls", "-q"]),
    images: lines(await docker(["image", "ls", "-aq", "--no-trunc"])),
  };
}

// `description` may be a function, evaluated only on timeout, so the failure can name what the
// probe did observe instead of the thing it waited for.
async function until(description, probe, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    check(!interrupted, "Acceptance interrupted");
    const value = await probe();
    if (value) return value;
    await pause(500);
  }
  check(
    false,
    `Timed out waiting for ${typeof description === "function" ? description() : description}`,
  );
}

async function freePorts() {
  const listeners = [];
  try {
    for (let i = 0; i < 3; i++) {
      const listener = createServer();
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      listeners.push(listener);
    }
    return listeners.map((listener) => listener.address().port);
  } finally {
    await Promise.all(
      listeners.map((listener) => new Promise((resolve) => listener.close(resolve))),
    );
  }
}

// A request that throws (its deadline, a refused connection) fails the stage with the route it
// was and how long it waited (`requestFailureEvidence`), never the error's own words.
async function request(
  origin,
  route,
  { token, method = "GET", body, headers = {}, timeout = 120_000 } = {},
) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(`${origin}/api${route}`, {
      method,
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    return response;
  } catch (error) {
    check(false, `${stage}: ${requestFailureEvidence(error, method, route, Date.now() - started)}`);
  }
}

async function json(origin, route, options = {}) {
  const started = Date.now();
  const response = await request(origin, route, options);
  check(
    response.ok,
    `${stage}: public API ${route.split("?")[0]} returned HTTP ${response.status}`,
  );
  // The body arrives under the same deadline as the head; a stall in it is named the same way.
  try {
    return await response.json();
  } catch (error) {
    const elapsed = Date.now() - started;
    check(
      false,
      `${stage}: ${requestFailureEvidence(error, options.method ?? "GET", route, elapsed)}`,
    );
  }
}

async function health(origin, expectedVersion = version) {
  return until("exact-version health", async () => {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) return false;
      const body = await response.json();
      assertHealth(body, expectedVersion);
      return body;
    } catch {
      return false;
    }
  });
}

// Learn only new resources linked to this installation, not every resource appearing after t0.
async function collectOwned() {
  if (!initial || !configRoot) return;
  const now = await snapshot();
  const initialIds = new Set(initial.containers.map((item) => item.Id));
  const compose = now.containers.filter((item) =>
    ownsComposeContainer(item, initialIds, configRoot),
  );
  for (const item of compose) containers.add(item.Id);
  for (const item of now.containers) {
    if (initialIds.has(item.Id)) continue;
    const fixture = item.Config?.Labels?.["sh.sealant.mend.acceptance"] === runId;
    const workspace = ownsWorkspaceContainer(item, initialIds);
    if (fixture || workspace) containers.add(item.Id);
  }
  const usedVolumes = new Set(
    compose.flatMap((item) =>
      item.Mounts.filter((mount) => mount.Type === "volume").map((mount) => mount.Name),
    ),
  );
  const usedNetworks = new Set(
    compose.flatMap((item) =>
      Object.values(item.NetworkSettings.Networks).map((network) => network.NetworkID),
    ),
  );
  volumes.collect(now.volumes, usedVolumes, await readPrivateIdentity(configRoot));
  for (const item of now.networks) {
    if (initial.networks.some((old) => old.Id === item.Id)) continue;
    if (usedNetworks.has(item.Id) && item.Labels?.["com.docker.compose.project"] === "mend")
      networks.set(item.Id, item.Name);
  }
  return { now, compose };
}

// The product as setup ships it: Mend, Postgres and Garage, and the npm and Docker mirrors it runs
// by default.
const productServices = ["docker-mirror", "garage", "mend", "npm-mirror", "postgres"];
const mirrorServices = new Set(["docker-mirror", "npm-mirror"]);
const serviceOf = (item) => item.Config.Labels["com.docker.compose.service"];

async function idle() {
  const { now, compose } = await collectOwned();
  check(
    compose.length === productServices.length,
    "Idle product must have exactly five Compose containers",
  );
  check(
    compose.map(serviceOf).toSorted().join(",") === productServices.join(","),
    "Idle services must be Garage, Mend, Postgres and the npm and Docker mirrors",
  );
  check(
    compose.every((item) => item.State.Running && item.State.Health?.Status === "healthy"),
    "Every idle product container must be healthy",
  );
  const identity = await readPrivateIdentity(configRoot);
  check(
    ["mend-store", "mend-control", "mend-garage"].every((name) => {
      const volume = now.volumes.find((item) => item.Name === name);
      return volume && volumes.canRemove(volume, identity);
    }),
    "External store/control/garage volumes must belong to the unchanged private installation identity",
  );
  check(
    compose
      .filter((item) => mirrorServices.has(serviceOf(item)))
      .every((item) => {
        const mounts = item.Mounts.filter((mount) => mount.Type === "volume");
        const volume = now.volumes.find((candidate) => candidate.Name === mounts[0]?.Name);
        return mounts.length === 1 && volume && volumes.canRemove(volume, identity);
      }),
    "Each mirror's cache must be one Compose volume owned by this installation",
  );
  const initialIds = new Set(initial.containers.map((item) => item.Id));
  check(
    now.containers.filter((item) => item.State.Running && !initialIds.has(item.Id)).length ===
      productServices.length,
    "Idle product must not leave workspace or fixture containers running",
  );
  return compose;
}

/**
 * The mirrors as sessions reach them: Mend carries their addresses, neither publishes a host port,
 * and each answers from Mend's container on the Compose network. Online, an npm metadata document
 * comes through the npm mirror and the second fetch is served from its cache, and the Docker mirror
 * answers for a Docker Hub manifest (a HEAD, which Docker Hub does not count as a pull). Offline,
 * only the npm mirror's own ping: the registry asks Docker Hub as it starts. The guard and the
 * cache key run in real containers in scripts/mirrors-runtime.test.mjs.
 */
async function mirrorsServe(compose, mend) {
  stage = "mirrors";
  const environment = new Set(mend.Config.Env);
  check(
    environment.has("MEND_NPM_MIRROR_URL=http://npm-mirror:4873/") &&
      environment.has("SEALANT_DOCKER_REGISTRY_MIRRORS=http://docker-mirror:5000") &&
      environment.has("SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER=mend-docker-mirror"),
    "Mend must point sessions at the npm and Docker mirrors",
  );
  for (const item of compose.filter((candidate) => mirrorServices.has(serviceOf(candidate))))
    check(
      Object.keys(item.HostConfig.PortBindings ?? {}).length === 0 &&
        item.HostConfig.NetworkMode !== "host" &&
        Object.keys(item.NetworkSettings.Networks).every((name) => name.startsWith("mend_")),
      "The mirrors must publish no host port and sit on the installation's Compose network only",
    );
  // Status and the cache header only: no body leaves the container.
  const fetchFromMend = async (url, { method = "GET", headers = {} } = {}) =>
    JSON.parse(
      await docker([
        "exec",
        mend.Id,
        "node",
        "-e",
        "const [url, method, headers] = process.argv.slice(1);" +
          "fetch(url, { method, headers: JSON.parse(headers), signal: AbortSignal.timeout(30000) })" +
          ".then(async (r) => { await r.arrayBuffer(); return { status: r.status, cache: r.headers.get('x-mend-mirror') }; }, () => ({ status: 0, cache: null }))" +
          ".then((result) => console.log(JSON.stringify(result)));",
        url,
        method,
        JSON.stringify(headers),
      ]),
    );
  check(
    (await fetchFromMend("http://npm-mirror:4873/-/ping")).status === 200,
    "The npm mirror must answer its ping from Mend's container",
  );
  if (offline) {
    console.log(
      "PASS mirrors wired and the npm mirror answers; NOT TESTED fetches through the mirrors offline",
    );
    return;
  }
  const first = await fetchFromMend("http://npm-mirror:4873/is-number");
  const second = await fetchFromMend("http://npm-mirror:4873/is-number");
  check(
    first.status === 200 && second.status === 200 && second.cache === "HIT",
    "npm metadata must come through the npm mirror and then from its cache",
  );
  // The guard starts the registry again every 30 s if Docker Hub did not answer it at start.
  await until(
    "the Docker mirror to answer",
    async () => (await fetchFromMend("http://docker-mirror:5000/v2/")).status === 200,
    90_000,
  );
  const manifest = await fetchFromMend(
    "http://docker-mirror:5000/v2/library/busybox/manifests/latest",
    {
      method: "HEAD",
      headers: {
        accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    },
  );
  check(manifest.status === 200, "The Docker mirror must answer for a Docker Hub manifest");
  console.log(
    `PASS mirrors wired, no host port; npm metadata through the mirror (${first.cache}, then ${second.cache}); Docker Hub manifest through the Docker mirror`,
  );
}

async function installation(expectedVersion = version, expectedAssets = assets, selected) {
  const target = selected ?? (await readlink(join(configRoot, "active")));
  const directory = await realpath(join(configRoot, target));
  check(
    target.startsWith("generations/gen-") && isInside(join(configRoot, "generations"), directory),
    "Setup must select an immutable generation",
  );
  for (const path of [configRoot, join(configRoot, "generations"), directory]) {
    check(((await stat(path)).mode & 0o077) === 0, "Installation directories must be private");
  }
  const identity = await readFile(join(configRoot, "identity.env"));
  check(identity.length > 0, "Installation identity is missing");
  const values = {};
  for (const name of [
    "identity.env",
    "server.json",
    "server.env",
    "compose.yaml",
    "postgres-init.sh",
  ]) {
    const file = join(directory, name);
    const mode = (await stat(file)).mode & 0o777;
    check(
      name === "postgres-init.sh" ? mode === 0o755 : (mode & 0o077) === 0,
      "Credentials/config stay private; the public Postgres bootstrap must be readable and executable",
    );
    values[name] = hash(await readFile(file));
  }
  check(values["identity.env"] === hash(identity), "Generation must retain installation identity");
  check(
    ((await stat(join(configRoot, "identity.env"))).mode & 0o077) === 0,
    "Identity file must be private",
  );
  const config = JSON.parse(await readFile(join(directory, "server.json"), "utf8"));
  check(
    config.serverVersion === expectedVersion && config.assetContract === "mend-docker-v2",
    "Saved config must pin the requested version and asset contract",
  );
  check(
    values["compose.yaml"] === hash(await readFile(join(expectedAssets, "compose.v2.yaml"))),
    "Active Compose must be the supplied release asset",
  );
  check(
    values["postgres-init.sh"] === hash(await readFile(join(expectedAssets, "postgres-init.sh"))),
    "Active Postgres init must be the supplied release asset",
  );
  const serverEnv = await readFile(join(directory, "server.env"), "utf8");
  return {
    target,
    directory,
    fingerprint: hash(JSON.stringify(values)),
    identity: hash(identity),
    config,
    serverEnv,
  };
}

async function sshIdentity(port) {
  const keys = await run("ssh-keyscan", ["-T", "5", "-p", String(port), "127.0.0.1"]);
  const publicKeys = keys
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(" ").slice(1).join(" "))
    .toSorted();
  check(publicKeys.length > 0, "SSH gateway must present a host key on the selected port");
  return hash(publicKeys.join("\n"));
}

// A failed stage after the session exists says, in the CI log, where the session stood: the
// public API's status words (`sessionStateEvidence`), the executors Docker reports, and the
// engine's message heads for the session since its launch (`engineTimelineEvidence`). Nothing raw:
// no annotation, body, output or credential. The private diagnostics below still hold the rest.
async function printDiagnosis() {
  const { origin, token, sessionId, since } = diagnosis;
  // Whether the server answers at all tells one stuck route from a stuck server.
  const healthStarted = Date.now();
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    await response.body?.cancel();
    console.error(
      `DIAGNOSIS health answered HTTP ${response.status} in ${Date.now() - healthStarted} ms`,
    );
  } catch (error) {
    console.error(
      `DIAGNOSIS ${requestFailureEvidence(error, "GET", "/health", Date.now() - healthStarted)}`,
    );
  }
  let detail;
  try {
    detail = await json(origin, `/sessions/${sessionId}`, {
      token,
      timeout: 10_000,
    });
    console.error(`DIAGNOSIS ${sessionStateEvidence(detail)}`);
  } catch (error) {
    console.error(
      `DIAGNOSIS session detail unavailable: ${error instanceof assert.AssertionError ? error.message : "raw error withheld"}`,
    );
  }
  const owned = await collectOwned();
  if (!owned) return;
  const initialIds = new Set(initial.containers.map((item) => item.Id));
  const executors = owned.now.containers
    .filter((item) => ownsWorkspaceContainer(item, initialIds))
    .map((item) => item.State?.Status ?? "unknown");
  console.error(
    `DIAGNOSIS executors: ${executors.length === 0 ? "none" : executors.toSorted().join(", ")}`,
  );
  const mend = owned.compose.find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "mend",
  );
  if (!mend) return console.error("DIAGNOSIS engine log unavailable: no Mend container");
  const logs = await start("docker", ["--context", context, "logs", "--since", since, mend.Id], {
    timeout: 30_000,
  }).result;
  const ids = [sessionId, detail?.session?.worktreeId, detail?.session?.sealantWorkspaceId];
  const timeline = engineTimelineEvidence(`${logs.output}\n${logs.error}`, ids);
  console.error(
    `DIAGNOSIS engine log for the session, message heads only (${timeline.length}${logs.ok ? "" : ", read incomplete"}):`,
  );
  for (const line of timeline) console.error(`DIAGNOSIS   ${line}`);
}

async function collectFailureLogs() {
  await collectOwned();
  for (const id of containers.keys()) {
    await start("docker", ["--context", context, "logs", "--tail", "200", id], {
      timeout: 10_000,
      failureEvidence: true,
    }).result;
  }
}

async function cleanup() {
  // Do not run lifecycle/down/prune here: those select by project, not immutable ownership.
  for (const child of activeChildren) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  if (activeChildren.size) await pause(1000);
  if (setupAttempted || fixtureId) await collectOwned();
  // Remove the owned control plane first, then learn any last workspace it provisioned
  // between the first inventory and shutdown. Concurrent unrelated containers stay untouched.
  for (let pass = 0; pass < 2; pass++) {
    const current = initial && configRoot ? await snapshot() : null;
    const owned = (current?.containers.filter((item) => containers.has(item.Id)) ?? []).toSorted(
      (a, b) =>
        Number(b.Config?.Labels?.["com.docker.compose.service"] === "mend") -
        Number(a.Config?.Labels?.["com.docker.compose.service"] === "mend"),
    );
    for (const item of owned) {
      const result = await start("docker", ["--context", context, "rm", "-f", item.Id]).result;
      if (!result.ok) cleanupFailed = true;
    }
    if (pass === 0 && (setupAttempted || fixtureId)) await collectOwned();
  }
  if (gitAccessImage) {
    // Built by this run under a run-unique tag; nothing else can reference it. A build that
    // never finished left no tag to remove.
    const listed = await start("docker", [
      "--context",
      context,
      "image",
      "ls",
      "-q",
      "--filter",
      `reference=${gitAccessImage}`,
    ]).result;
    if (!listed.ok) cleanupFailed = true;
    else if (lines(listed.output).length > 0) {
      const result = await start("docker", ["--context", context, "image", "rm", gitAccessImage])
        .result;
      if (!result.ok) cleanupFailed = true;
    }
  }
  const remainingNetworkIds = networks.size
    ? new Set(lines(await docker(["network", "ls", "-q", "--no-trunc"])))
    : new Set();
  for (const id of networks.keys()) {
    if (!remainingNetworkIds.has(id)) continue;
    const result = await start("docker", ["--context", context, "network", "rm", id]).result;
    if (!result.ok) cleanupFailed = true;
  }
  if (
    volumes &&
    !(await cleanupOwnedVolumes(volumes, {
      list: async () => lines(await docker(["volume", "ls", "-q"])),
      identity: () => readPrivateIdentity(configRoot),
      inspect: async (name) => {
        const result = await start("docker", ["--context", context, "volume", "inspect", name])
          .result;
        return result.ok ? JSON.parse(result.output) : undefined;
      },
      remove: async (name) =>
        (await start("docker", ["--context", context, "volume", "rm", name]).result).ok,
    }))
  )
    cleanupFailed = true;
  if (setupAttempted) {
    const remaining = await snapshot();
    try {
      assertFreshDocker(remaining);
    } catch {
      cleanupFailed = true;
    }
    const previous = initial.containers.map((item) => [
      item.Id,
      item.State.Status,
      item.State.StartedAt,
      item.RestartCount,
    ]);
    check(
      previous.every((facts) =>
        remaining.containers.some(
          (item) =>
            JSON.stringify([
              item.Id,
              item.State.Status,
              item.State.StartedAt,
              item.RestartCount,
            ]) === JSON.stringify(facts),
        ),
      ),
      "A pre-existing container changed during acceptance; no repair was attempted",
    );
  }
  if (cleanupFailed) {
    console.error(
      "Cleanup incomplete. Unproven or replaced resources were retained. No prune/down was attempted.",
    );
    if (scratch)
      console.error(`Private installation retained at ${scratch}; do not publish its files.`);
  } else if (scratch) await rm(scratch, { recursive: true, force: true });
  if (lock) {
    const current = await lstat(lock.path);
    check(
      current.dev === lock.dev && current.ino === lock.ino,
      "Acceptance lock was replaced; retaining it",
    );
    await rmdir(lock.path); // Never recursively remove another owner's lock or unexpected files.
  }
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    for (const child of activeChildren) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  });

async function main() {
  check(process.platform === "linux", "This acceptance script currently validates Linux only");
  check(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ""),
    "Set MEND_TEST_VERSION to an exact version, never latest",
  );
  check(
    image === `ghcr.io/sealant-sh/mend:${version}`,
    "MEND_TEST_IMAGE must be the official Mend repository tagged with MEND_TEST_VERSION",
  );
  check(
    process.env.MEND_TEST_OFFLINE === undefined ||
      ["0", "1"].includes(process.env.MEND_TEST_OFFLINE),
    "MEND_TEST_OFFLINE must be 0 or 1",
  );
  check(
    !process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
    "Unset DOCKER_HOST/DOCKER_CONTEXT; select the intended local daemon with docker context use first",
  );
  upgrade = readUpgradeInputs(process.env, assets, version);
  context = (await docker(["context", "show"])).trim();
  check(context.length > 0, "Docker context is missing");
  const endpoints = JSON.parse(await docker(["context", "inspect", context]));
  check(
    endpoints[0]?.Endpoints?.docker?.Host?.startsWith("unix://"),
    "Acceptance requires a local Unix Docker context for loopback probes",
  );
  initial = await snapshot();
  volumes = createVolumeLedger(initial.volumes, runId);
  assertFreshDocker(initial); // Nothing above this line mutates Docker or the filesystem.
  console.log(
    "PASS read-only fresh-install gate; existing unrelated Docker resources will not be touched",
  );
  const daemon = (await docker(["info", "--format", "{{.ID}}"])).trim();
  check(daemon.length > 0, "Docker daemon identity is missing");
  const lockPath = join(tmpdir(), `mend-packaged-acceptance-${hash(daemon).slice(0, 20)}.lock`);
  await mkdir(lockPath, { mode: 0o700 }); // Exclusive; never steal another test's lock.
  const lockInfo = await lstat(lockPath);
  lock = { path: lockPath, dev: lockInfo.dev, ino: lockInfo.ino };
  scratch = await mkdtemp(join(tmpdir(), "mend-packaged-acceptance-"));
  check(
    isInside(repo, await realpath(scratch)) === false,
    "npm consumer directory must be outside the checkout",
  );
  const home = join(scratch, "home");
  await mkdir(home, { mode: 0o700 });
  env = isolatedClientEnvironment(process.env, home, dockerConfig);
  env.npm_config_cache = join(scratch, "npm-cache");
  env.npm_config_userconfig = join(scratch, "empty.npmrc");
  await writeFile(env.npm_config_userconfig, "", { mode: 0o600 });
  configRoot = join(env.XDG_CONFIG_HOME, "mend");
  const contract = JSON.parse(await readFile(join(assets, "setup-contract.v2.json"), "utf8"));
  check(
    contract.schemaVersion === 2 &&
      contract.composeTemplate === "compose.v2.yaml" &&
      contract.canonicalVolumes?.store === "mend-store" &&
      contract.canonicalVolumes?.control === "mend-control" &&
      contract.canonicalVolumes?.garage === "mend-garage" &&
      contract.volumeOwnership?.externalVolumes?.join(",") ===
        "mend-store,mend-control,mend-garage" &&
      contract.hostExposure?.ports?.registry === undefined &&
      contract.registry === undefined,
    "Assets must implement the bundle v2 setup contract, which publishes no registry",
  );
  stage = "pack/install";
  const beforeInstall = dockerFingerprint(await snapshot());
  const installStarted = new Date().toISOString();
  const captureStarted = new Date(Date.parse(installStarted) - 60_000).toISOString();
  // pnpm materializes catalog/workspace specifiers; npm packs the resulting release
  // directory itself. No manifest editing, source imports, or dependency substitutions.
  const prepared = join(scratch, "prepared");
  await mkdir(prepared);
  await run("pnpm", ["pack", "--pack-destination", prepared], {
    cwd: join(repo, "apps/cli"),
    timeout: 300_000,
  });
  const tarballs = (await readdir(prepared)).filter((name) => name.endsWith(".tgz"));
  check(tarballs.length === 1, "pnpm must prepare exactly one release tarball");
  await run("tar", ["-xzf", join(prepared, tarballs[0]), "-C", prepared]);
  // prepack was already exercised by pnpm in the source package; published consumers
  // do not receive its build scripts. npm pack must not rerun that source-only hook.
  const npmPack = JSON.parse(
    await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
      cwd: join(prepared, "package"),
    }),
  );
  check(
    npmPack.length === 1 && /^[a-zA-Z0-9._-]+\.tgz$/.test(npmPack[0].filename),
    "npm pack must produce one local tarball",
  );
  await writeFile(join(scratch, "package.json"), JSON.stringify({ private: true }));
  await run(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", join(scratch, npmPack[0].filename)],
    { timeout: 300_000 },
  );
  const installed = join(scratch, "node_modules/@sealant/mend");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  check(manifest.name === "@sealant/mend", "Installed package must be the public CLI");
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    check(
      Object.entries(manifest[section] ?? {}).every(
        ([name, spec]) =>
          !name.startsWith("@mend/") && !/^(workspace|catalog|file|link):/.test(spec),
      ),
      "Installed CLI must have published runtime dependencies",
    );
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "start"])
    check(!manifest.scripts?.[hook], "CLI package must not implicitly install a server");
  const bin = join(scratch, "node_modules/.bin/mend");
  check(
    isInside(installed, await realpath(bin)),
    "npm bin must resolve inside the installed package",
  );
  const cli = (args, options = {}) =>
    run(process.execPath, [bin, ...args], { environment: env, ...options });
  const startCli = (args, options = {}) =>
    start(process.execPath, [bin, ...args], { environment: env, ...options });
  // A server command that fails says why in words the CI log may carry
  // (`setupFailureEvidence`): how it ended, setup's own headline by label, and each product
  // container's state and health. Its output stays in the private diagnostics.
  const serverCli = async (args, { timeout = 600_000 } = {}) => {
    const started = Date.now();
    const result = await startCli(args, { timeout }).result;
    if (!result.ok) {
      let containers = [];
      try {
        containers = (await collectOwned())?.compose ?? [];
      } catch {
        console.error("DIAGNOSIS product containers could not be listed");
      }
      for (const line of setupFailureEvidence({
        ...result,
        elapsedMs: Date.now() - started,
        text: `${result.output}\n${result.error}`,
        containers,
      }))
        console.error(line);
    }
    check(result.ok, `${stage}: installed mend failed; output withheld to protect credentials`);
    return result.output;
  };
  check((await cli(["--help"])).includes("adopt"), "Installed CLI help must work");
  check(
    (await cli([])).includes("adopt"),
    "Fresh non-TTY invocation must show help, not install a server",
  );
  check(
    (await cli(["--version"])).split("\n")[0].trim() === `mend ${manifest.version}`,
    "Installed CLI must report its package version",
  );
  check(
    dockerFingerprint(await snapshot()) === beforeInstall,
    "Packing, npm installation, help and version must not change Docker",
  );
  const installEnded = new Date().toISOString();
  // Bounded context lets a healthcheck cross either edge of the asserted window. Missing
  // context or Docker's 256-event history cap fails inconclusively, never silently passes.
  await pause(5000);
  const captureEnded = new Date().toISOString();
  const installEvents = await docker([
    "events",
    "--since",
    captureStarted,
    "--until",
    captureEnded,
    "--format",
    '{"Type":{{json .Type}},"Action":{{json .Action}},"Actor":{{json .Actor}},"timeNano":"{{.TimeNano}}"}',
  ]);
  const observedEvents = assertInstallDockerEvents(installEvents, initial, {
    since: installStarted,
    until: installEnded,
    captureSince: captureStarted,
    captureUntil: captureEnded,
  });
  if (observedEvents.healthchecks)
    console.log(
      `OBSERVED ${observedEvents.healthchecks} correlated pre-existing declared healthcheck commands; Docker events do not identify their initiator`,
    );
  assertFreshDocker(await snapshot());
  console.log(
    "PASS npm-packed CLI installed outside checkout; help/version/default invocation made no Docker changes",
  );
  stage = "required CLI contract";
  const setupHelp = await cli(["help", "server", "setup"]);
  for (const flag of [
    "--assets-dir",
    "--offline",
    "--context",
    "--port",
    "--ssh-port",
    "--version",
    "--url",
  ])
    check(setupHelp.includes(flag), `Integration required: server setup help must expose ${flag}`);
  for (const command of ["restart", "stop", "start"])
    check(
      (await cli(["help", "server", command])).includes(`server ${command}`),
      `Integration required: mend server ${command}`,
    );
  if (upgrade) {
    const help = await cli(["help", "server", "upgrade"]);
    for (const flag of ["--version", "--assets-dir", "--offline"])
      check(help.includes(flag), `Integration required: server upgrade help must expose ${flag}`);
  }
  const [port, sshPort] = await freePorts();
  const origin = `http://127.0.0.1:${port}`;
  const setupArgs = [
    "server",
    "setup",
    "--context",
    context,
    ...(offline ? ["--offline"] : []),
    "--version",
    version,
    "--assets-dir",
    assets,
    "--port",
    String(port),
    "--ssh-port",
    String(sshPort),
    "--url",
    origin,
  ];
  stage = "server setup";
  assertFreshDocker(await snapshot()); // Recheck immediately before the first product mutation.
  setupAttempted = true;
  try {
    await serverCli(setupArgs);
  } finally {
    await collectOwned();
  }
  const baselineHealth = await health(origin);
  const compose = await idle();
  const mend = compose.find((item) => item.Config.Labels["com.docker.compose.service"] === "mend");
  const postgres = compose.find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "postgres",
  );
  const imageInfo = JSON.parse(await docker(["image", "inspect", image]))[0];
  assertImagePin(mend, imageInfo, image, version);
  check(
    postgres.Config.Image === "postgres:17-alpine",
    "Postgres must be the contract's official image",
  );
  const garage = compose.find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "garage",
  );
  check(
    garage.Config.Image === "dxflrs/garage:v2.4.1",
    "Garage must be the contract's pinned image",
  );
  check(
    Object.keys(garage.HostConfig.PortBindings ?? {}).length === 0,
    "Product Garage must not publish a host port",
  );
  const bindings = mend.HostConfig.PortBindings;
  for (const [internal, external] of [
    ["3105/tcp", port],
    ["2222/tcp", sshPort],
  ])
    check(
      bindings[internal]?.length === 1 &&
        bindings[internal][0].HostIp === "127.0.0.1" &&
        bindings[internal][0].HostPort === String(external),
      "Web and SSH must use the selected loopback ports",
    );
  check(
    Object.keys(bindings).length === 2,
    "The bundle must publish only web and SSH (no registry port)",
  );
  check(
    Object.keys(postgres.HostConfig.PortBindings ?? {}).length === 0,
    "Product Postgres must not publish a host port",
  );
  const saved = await installation();
  check(
    saved.config.appUrl === origin &&
      saved.config.appPort === port &&
      saved.config.sshPort === sshPort &&
      saved.config.registryPort === undefined,
    "Saved setup exposure must include both selected ports and no registry port",
  );
  const sshBefore = await sshIdentity(sshPort);
  const web = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
  check(
    web.ok &&
      web.headers.get("content-type")?.includes("text/html") &&
      (await web.text()).includes("<html"),
    "Published bundle must serve the real web application",
  );
  console.log(
    "PASS exact image/version, official PG, web app, idle five-container product and isolated loopback ports (no registry)",
  );
  await mirrorsServe(compose, mend);

  stage = "real authentication";
  const password = randomBytes(32).toString("hex");
  const email = `${runId}@acceptance.invalid`;
  const signup = await request(origin, "/auth/sign-up/email", {
    method: "POST",
    headers: { origin },
    body: { email, password, name: "Packaged acceptance" },
  });
  check(signup.ok, "BetterAuth signup at the configured Origin must succeed");
  const token = signup.headers.get("set-auth-token");
  check(
    typeof token === "string" && token.length > 0,
    "BetterAuth must expose its public bearer token header",
  );
  const account = await signup.json();
  check(typeof account.user?.id === "string", "BetterAuth signup must return a user identity");
  const api = (route, options = {}) => json(origin, route, { token, ...options });
  env.MEND_URL = origin;
  env.MEND_TOKEN = token;
  check(
    (await cli(["version"])).includes(`server ${version} · ${origin}`),
    "Installed CLI must identify the configured server pin",
  );
  for (const options of [{}, { token: "not-a-real-token" }]) {
    const response = await request(origin, "/projects", options);
    check(response.status === 401, "Unauthenticated and invalid bearer requests must return 401");
    await response.body?.cancel();
  }
  const allowedPreflight = await request(origin, "/projects", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  check(
    allowedPreflight.headers.get("access-control-allow-origin") === origin,
    "Configured Origin must receive an exact CORS grant",
  );
  await allowedPreflight.body?.cancel();
  const rejectedOrigin = "http://untrusted.acceptance.invalid";
  const preflight = await request(origin, "/projects", {
    method: "OPTIONS",
    headers: {
      origin: rejectedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  check(
    !preflight.headers.get("access-control-allow-origin"),
    "Untrusted CORS preflight must not grant access",
  );
  await preflight.body?.cancel();
  const badSignup = await request(origin, "/auth/sign-up/email", {
    method: "POST",
    headers: { origin: rejectedOrigin },
    body: { email: `negative-${email}`, password, name: "Rejected origin" },
  });
  check(badSignup.status === 403, "BetterAuth must reject an untrusted signup Origin");
  await badSignup.body?.cancel();
  console.log("PASS real BetterAuth account/bearer and authentication/Origin negatives");

  stage = "installed CLI SSH setup";
  const { check: checkSsh } = await preparePackagedSshAcceptance({
    cli,
    docker,
    run,
    until,
    api,
    scratch,
    privateHome: home,
    mendContainerId: mend.Id,
  });

  stage = "network Git fixture";
  const source = join(scratch, "source");
  await mkdir(source);
  const git = (args, cwd = source) => run("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await writeFile(join(source, "README.md"), "Packaged product acceptance fixture\n");
  await git(["add", "README.md"]);
  await git([
    "-c",
    "user.name=Acceptance",
    "-c",
    "user.email=acceptance@example.invalid",
    "commit",
    "-m",
    "fixture base",
  ]);
  const baseSha = (await git(["rev-parse", "HEAD"])).trim();
  const bare = join(scratch, "repo.git");
  await git(["clone", "--bare", source, bare]);
  await git(["update-server-info"], bare);
  await docker([
    "volume",
    "create",
    "--label",
    `sh.sealant.mend.acceptance=${runId}`,
    fixtureVolume,
  ]);
  const volumeInfo = JSON.parse(await docker(["volume", "inspect", fixtureVolume]))[0];
  check(
    volumeInfo.Labels?.["sh.sealant.mend.acceptance"] === runId,
    "Fixture volume ownership must match",
  );
  await collectOwned();
  const networkIds = Object.values(mend.NetworkSettings.Networks).map((item) => item.NetworkID);
  check(
    networkIds.length === 1 && networks.has(networkIds[0]),
    "Fixture must join this installation's Compose network",
  );
  fixtureId = (
    await docker([
      "create",
      "--name",
      fixtureName,
      "--label",
      `sh.sealant.mend.acceptance=${runId}`,
      "--network",
      networkIds[0],
      "--mount",
      `type=volume,source=${fixtureVolume},target=/fixture`,
      "--entrypoint",
      "node",
      image,
      "/fixture/packaged-git-fixture.mjs",
    ])
  ).trim();
  check(/^[a-f0-9]{64}$/.test(fixtureId), "Docker must return an immutable fixture container ID");
  containers.add(fixtureId);
  await docker(["cp", bare, `${fixtureId}:/fixture/repo.git`]);
  for (const name of ["packaged-git-fixture.mjs", "packaged-server-assertions.mjs"])
    await docker(["cp", join(repo, "scripts", name), `${fixtureId}:/fixture/${name}`]);
  await docker(["start", fixtureId]);
  const sourceUrl = `http://${fixtureName}:9080/repo.git`;
  await until(
    "fixture HTTP",
    async () =>
      (
        await start("docker", [
          "--context",
          context,
          "exec",
          fixtureId,
          "node",
          "-e",
          "fetch('http://127.0.0.1:9080/repo.git/HEAD').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]).result
      ).ok,
  );
  await cli(["adopt", sourceUrl, "--name", projectName], { timeout: 180_000 });
  const projects = await api("/projects");
  check(
    Array.isArray(projects) && projects.length === 1,
    "Fresh account must have exactly the adopted project",
  );
  const httpProject = projects[0];
  check(
    httpProject.name === projectName &&
      // Stores are laid out by project id: a name is unique only within an organization.
      /^[0-9a-f-]{36}$/.test(httpProject.id) &&
      httpProject.storePath === `/var/lib/mend/store/${httpProject.id}/repo.git` &&
      httpProject.originUrl === sourceUrl &&
      httpProject.adoptedSha === baseSha,
    "CLI adoption must preserve network source and fixture Git identity",
  );
  check(
    (await cli(["projects"])).includes(projectName),
    "Authenticated installed CLI must list the adopted project",
  );
  // Anonymous HTTP above needs no credential, so it cannot notice a broken signer. The session
  // below therefore runs in a project adopted over SSH with the account's Mend key, and pushes.
  let gitAccess;
  if (offline) console.log("NOT TESTED git access; the SSH git remote image needs a registry");
  else {
    stage = "git access over SSH";
    gitAccessImage = `mend-acceptance-git-ssh:${runId}`;
    gitAccess = await preparePackagedGitAccessAcceptance({
      cli,
      startCli,
      docker,
      startDocker: (args, options) => start("docker", ["--context", context, ...args], options),
      run,
      start,
      until,
      api,
      own: (id) => containers.add(id),
      scratch,
      fixtures: join(repo, "scripts/fixtures/git-ssh"),
      runId,
      name: `${fixtureName}-ssh`,
      network: networkIds[0],
      bare,
      baseSha,
      environment: env,
    });
    check(
      gitAccess.image === gitAccessImage,
      "The SSH git remote image must be the one cleanup removes",
    );
  }
  const project = gitAccess?.project ?? httpProject;
  stage = "workspace image fixture";
  // The public custom-base contract checks git/node/npm before setupCommands run.
  // A unique local alias also prevents the platform's build tag from replacing another test's tag.
  const workspaceBase = `${fixtureName}-base:latest`;
  check(
    lines(
      await docker([
        "image",
        "ls",
        "--filter",
        `reference=${workspaceBase}`,
        "--format",
        "{{.ID}}",
      ]),
    ).length === 0,
    "Workspace fixture image alias must be new",
  );
  await docker(["pull", "node:26-bookworm"], { timeout: 600_000 });
  await docker(["tag", "node:26-bookworm", workspaceBase]);
  await docker([
    "run",
    "--rm",
    "--label",
    `sh.sealant.mend.acceptance=${runId}`,
    "--entrypoint",
    "sh",
    workspaceBase,
    "-c",
    "command -v git && command -v node && command -v npm",
  ]);
  console.log("PASS real network Git adoption and custom workspace base prerequisites");
  const workspaceImage = {
    mode: "custom",
    baseImage: workspaceBase,
    packages: [],
    setupCommands: [],
    services: { docker: false },
  };
  const imageSaved = await api(`/projects/${project.id}/workspace-image`, {
    method: "PUT",
    body: { workspaceImage },
  });
  check(imageSaved.saved === true, "Public API must accept the minimal custom workspace base");

  stage = "real CLI session and capture evidence";
  // Keep the real process alive briefly so inspect can observe the executor before normal
  // reclamation. No mock launch or host-store write creates the change: the commit happens in
  // the executor and reaches Mend as a capture (ADR-0002), never through a store mount.
  const command = `set -eu; git config user.name Acceptance; git config user.email acceptance@example.invalid; printf '%s\\n' '${marker}' > packaged-proof.txt; git add packaged-proof.txt; git commit -m 'packaged acceptance'; ${gitAccess?.pushCommand ?? "true"}; sleep 30; printf '%s\\n' '${marker}'`;
  const launchStarted = new Date().toISOString();
  const signaturesBeforeSession = (await gitAccess?.mendKeySignatures()) ?? 0;
  const launched = start(
    process.execPath,
    [bin, "run", "--project", project.name, "--name", "packaged-proof", "--", "sh", "-c", command],
    { timeout: 600_000 },
  );
  const session = await until("CLI-created session", async () => {
    const detail = await api(`/projects/${project.id}?deadEnds=include`);
    return detail.sessions?.find((item) => item.branch === "mend/packaged-proof");
  });
  diagnosis = { origin, token, sessionId: session.id, since: launchStarted };
  const sessionDetail = async () => {
    const current = await api(`/sessions/${session.id}`);
    check(
      current.session.status !== "failed",
      "Session provisioning failed; inspect private owned-container diagnostics",
    );
    return current;
  };
  const initialIds = new Set(initial.containers.map((item) => item.Id));
  // The commit above ships as a capture within seconds of the edit; the same 480s bound the old
  // mount poll used covers image pulls on a cold daemon. Two facts must hold together: the change
  // is observed from a registered capture (n ≥ 1) — per-session proof through the public API —
  // and a store-less Sealant executor is running the session. The hot pool decouples the
  // executor's container id from the session's `sealantWorkspaceId` (a session claims a warm
  // standby), so the container is proven store-less, never pinned to the session by id.
  const evidence = await until(
    "a registered capture for the session and its store-less executor",
    async () => {
      const current = await sessionDetail();
      if (!current.change?.id) return false;
      const stats = await api(`/changes/${current.change.id}/stats`);
      const observation = captureRegisteredEvidence(stats.observation);
      if (!observation) return false;
      const { now } = await collectOwned();
      const executor = now.containers.find(
        (item) =>
          item.State.Running &&
          !initialIds.has(item.Id) &&
          ownsWorkspaceContainer(item, initialIds),
      );
      return executor ? { observation, executor } : false;
    },
    480_000,
  );
  // A store mount at this point would fail ownsWorkspaceContainer above; assert store-absence
  // explicitly so the message names the regression if the executor's shape ever changes.
  assertCaptureExecutor(evidence.executor);
  check(containers.has(evidence.executor.Id), "The store-less executor must be owned for cleanup");
  // A captured workspace mounts nothing, so the helper and the git transport must have been
  // written into it (packages/sessions workspaceScriptStaging). Asserted where they are used,
  // not inferred: git configured with a transport that does not exist fails only at the first
  // push, and `mend` inside the session fails only when someone runs a service.
  const transport = await start(
    "docker",
    [
      "--context",
      context,
      "exec",
      evidence.executor.Id,
      "sh",
      "-c",
      'test -x /run/mend/bin/mend && test -x /run/mend/bin/mend-git-ssh && [ "$(readlink /usr/local/bin/mend)" = /run/mend/bin/mend ] && [ "$(git config --system core.sshCommand)" = /run/mend/bin/mend-git-ssh ] && [ "$(git config --system ssh.variant)" = ssh ]',
    ],
    { timeout: 10_000 },
  ).result;
  check(
    transport.ok,
    "The workspace must hold the mend helper and the git transport its git is configured with",
  );
  if (gitAccess) {
    // What git said about the push, kept beside failed-command diagnostics and never printed.
    // A claimed standby makes "the session's executor" any owned workspace, so each is asked.
    const deadline = Date.now() + 60_000;
    let recorded = false;
    while (!recorded && Date.now() < deadline) {
      const { now } = await collectOwned();
      for (const item of now.containers) {
        if (!item.State.Running || !ownsWorkspaceContainer(item, initialIds)) continue;
        const probe = ["--context", context, "exec", item.Id];
        const done = await start("docker", [
          ...probe,
          "test",
          "-e",
          `${gitAccess.pushEvidence}.done`,
        ]).result;
        if (!done.ok) continue;
        await start("docker", [...probe, "cat", gitAccess.pushEvidence], {
          timeout: 10_000,
          failureEvidence: true,
        }).result;
        recorded = true;
        break;
      }
      if (!recorded) await pause(1000);
    }
  }
  const captured = evidence.observation;
  console.log(
    `OBSERVED store-less capture executor and ${captured.label} (${captured.state}, capture ${captured.captureN})`,
  );
  stage = "authenticated workspace SSH";
  const workspaceId = await until("public workspace identity", async () => {
    const current = await api(`/sessions/${session.id}`);
    const id = current.session.sealantWorkspaceId;
    return id && current.currentAgent?.sealantWorkspaceId === id ? id : false;
  });
  await checkSsh(workspaceId, marker);
  console.log(
    "PASS installed CLI key registration and native workspace SSH with private config and pinned gateway trust",
  );
  stage = "recorded command and change";
  check(
    (await launched.result).ok,
    "mend run must finish successfully through the real record stream",
  );
  if (gitAccess) {
    stage = "git push from inside the session";
    await gitAccess.verifyPush(marker, signaturesBeforeSession);
    console.log(
      "PASS git push from inside the session reached the SSH remote, signed by its owner's Mend key",
    );
    stage = "recorded command and change";
  }
  const detail = await until("completed session and checkpoint", async () =>
    completedCommandEvidence(await sessionDetail()),
  );
  // The flush report the engine logs when the executor's turn ends: every staged object
  // uploaded and registered, nothing pending, the chain not fenced.
  // A session flushes at least twice (turn boundary, planned stop) and one completed report is
  // enough, so a refused or partial report is passed over, never treated as the answer. When none
  // completes, the reports that were logged instead are the cause and ride the failure message.
  let flushAttempts = [];
  const flush = await until(
    () =>
      flushAttempts.length === 0
        ? "a completed capture flush report for the session; the engine logged no flush at all"
        : `a completed capture flush report for the session; the engine logged only: ${flushAttempts.join(" | ")}`,
    async () => {
      const { compose: currentCompose } = await collectOwned();
      const currentMend = currentCompose.find(
        (item) => item.Config.Labels["com.docker.compose.service"] === "mend",
      );
      check(
        currentMend && containers.has(currentMend.Id),
        "Flush evidence requires the owned Mend container",
      );
      const text = await docker(["logs", "--since", launchStarted, currentMend.Id]);
      flushAttempts = flushAttemptEvidence(text, session.id);
      return flushReportEvidence(text, session.id);
    },
  );
  console.log(
    `OBSERVED capture flush · completed · observed for the session: head ${flush.headN}, registered ${flush.registered}, pending ${flush.pending}, why ${flush.why}`,
  );
  if (detail.currentAgent.exitCode === null)
    console.log(
      "OBSERVED completed session and exited PTY; process exit code unavailable, not inferred as zero",
    );
  check(
    detail.session.baseSha === baseSha &&
      detail.change?.id &&
      detail.session.sealantRunId &&
      BigInt(detail.session.lastSeenSequence) > 0n,
    "Session must link base, change and observed run sequence",
  );
  const checkpoint = await api(`/sessions/${session.id}/checkpoints`, {
    method: "POST",
    body: { trigger: "user-mark" },
  });
  check(
    checkpoint.ref?.startsWith("refs/mend/checkpoints/") &&
      checkpoint.sealantRunId === detail.session.sealantRunId &&
      BigInt(checkpoint.seq) > 0n,
    "Checkpoint must link hidden Git ref to the observed run",
  );
  const diff = await api(`/changes/${detail.change.id}/diff`);
  check(
    diff.diff?.includes(marker) && diff.files?.some((file) => file.path === "packaged-proof.txt"),
    "Public change must contain the committed workspace file",
  );
  check(
    captureRegisteredEvidence(diff.observation) !== false,
    "Public change must be read from a registered capture, not a live worktree",
  );
  async function recordText() {
    let from = "0";
    let text = "";
    for (let page = 0; page < 100; page++) {
      const logs = await api(`/processes/${detail.currentAgent.id}/logs?from=${from}&limit=500`);
      check(
        logs.sealantRunId === detail.session.sealantRunId && Array.isArray(logs.chunks),
        "Process logs must identify the session run",
      );
      text += logs.chunks
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
        .join("");
      if (logs.chunks.length === 0) return text;
      check(BigInt(logs.nextFrom) > BigInt(from), "Record cursor must advance");
      from = logs.nextFrom;
    }
    check(false, "Record exceeded acceptance's bounded page budget");
  }
  const recorded = await recordText();
  check(recorded.includes(marker), "Durable process output must contain the command marker");
  // Under captures (decision 8) the branch and worktree live on the executor's own disk; the
  // store volume never names them and the executor is reclaimed after the run. The recorded
  // change is therefore proven from the capture store through the public API: the worktree's
  // checkpoint chain (Postgres) and a Review slice whose base-to-checkpoint patch the git runner
  // serves from the packs in the bucket. No docker exec against the store, no executor disk.
  const worktreeId = detail.session.worktreeId;
  const chainState = async () => {
    const worktree = await api(`/worktrees/${worktreeId}`);
    check(
      worktree.worktree?.id === worktreeId && worktree.change?.id === detail.change.id,
      "Worktree detail must name the session's worktree and change",
    );
    return checkpointChainEvidence(worktree.checkpoints, {
      baseSha,
      checkpoint,
      worktreeId,
    });
  };
  await chainState();
  const review = await api(`/changes/${detail.change.id}/reviews/open`, {
    method: "POST",
    body: { idempotencyKey: `packaged-acceptance-${runId}` },
  });
  check(
    review.slice?.changeId === detail.change.id &&
      review.checkpointA?.ordinal === 0 &&
      review.checkpointA.sha === baseSha &&
      review.checkpointB?.worktreeId === worktreeId,
    "Opening Review must anchor a slice from the worktree's base",
  );
  const reviewDiff = async () =>
    reviewDiffEvidence(await api(`/changes/${detail.change.id}/reviews/${review.slice.id}/diff`), {
      baseSha,
      sliceId: review.slice.id,
      marker,
      file: "packaged-proof.txt",
    });
  const reviewed = await reviewDiff();
  check(
    reviewed.checkpointB.id === review.checkpointB.id &&
      reviewed.checkpointB.sha === review.checkpointB.sha,
    "Review diff must span the opened slice",
  );
  // Lifecycle fingerprint of the recorded change: the chain (now including the review-open
  // checkpoint) and the pack-served patch, both read again after every lifecycle operation.
  const changeState = async () =>
    hash(
      JSON.stringify({
        chain: await chainState(),
        patch: (await reviewDiff()).patch,
      }),
    );
  const changeBefore = await changeState();
  console.log(
    "PASS network adoption, real mend run, store-less executor, registered capture, completed flush, capture-backed checkpoint chain, pack-served Review patch and replayable record",
  );
  if (offline)
    console.log("NOT TESTED dotfiles; the ubuntu family workspace image build needs the network");
  else {
    stage = "dotfiles";
    await runPackagedDotfilesAcceptance({
      cli,
      startCli,
      docker,
      run,
      until,
      api,
      scratch,
      environment: env,
      fixtureId,
      fixtureOrigin: `http://${fixtureName}:9080`,
      sourceUrl,
      runId,
    });
  }
  // Fixture is temporary infrastructure, not a third idle product container.
  await docker(["rm", "-f", fixtureId]);
  fixtureId = undefined;
  if (gitAccess) await docker(["rm", "-f", gitAccess.containerId]);
  // The bundle stores captures on Garage, which ignores conditional writes: a stopped session's
  // executor is kept until its final seal stands, after the last upload URL it was handed expires
  // (about 10.5 minutes; docs reference/known-issues). Wait past that horizon.
  await until(
    "executor reclamation",
    async () => {
      const { now } = await collectOwned();
      return !now.containers.some(
        (item) => item.State.Running && ownsWorkspaceContainer(item, initialIds),
      );
    },
    15 * 60_000,
  );
  await idle();

  async function retained(expected = saved, expectedAssets = assets) {
    const observedHealth = await health(origin, expected.config.serverVersion);
    check(
      deployment(observedHealth) === deployment(baselineHealth),
      "Health deployment mode, store root and session channel must survive unchanged",
    );
    const after = await installation(expected.config.serverVersion, expectedAssets);
    check(
      after.fingerprint === expected.fingerprint &&
        after.identity === saved.identity &&
        after.target === expected.target,
      "Lifecycle must preserve the expected immutable generation, credentials and pin",
    );
    check(
      (await sshIdentity(sshPort)) === sshBefore,
      "SSH host identity must survive lifecycle operations",
    );
    const signin = await request(origin, "/auth/sign-in/email", {
      method: "POST",
      headers: { origin },
      body: { email, password },
    });
    check(
      signin.ok && (await signin.json()).user?.id === account.user.id,
      "Database account identity must survive lifecycle operations",
    );
    const projectAfter = await api(`/projects/${project.id}?deadEnds=include`);
    check(
      projectAfter.project?.id === project.id &&
        projectAfter.project.name === project.name &&
        projectAfter.project.originUrl === project.originUrl &&
        projectAfter.project.storePath === project.storePath &&
        projectAfter.project.adoptedSha === baseSha &&
        projectAfter.worktrees?.some((item) => item.id === detail.session.worktreeId),
      "Project and worktree rows must survive",
    );
    await gitAccess?.assertKeyUnchanged("after a lifecycle operation");
    const sessionAfter = await api(`/sessions/${session.id}`);
    check(
      sessionAfter.session.id === detail.session.id &&
        sessionAfter.session.status === "completed" &&
        sessionAfter.session.sealantRunId === detail.session.sealantRunId &&
        sessionAfter.session.worktreeId === detail.session.worktreeId &&
        sessionAfter.session.baseSha === baseSha &&
        sessionAfter.session.branch === detail.session.branch &&
        sessionAfter.session.worktree === detail.session.worktree &&
        sessionAfter.currentAgent?.id === detail.currentAgent.id &&
        sessionAfter.currentAgent.status === "exited" &&
        sessionAfter.currentAgent.exitedAt === detail.currentAgent.exitedAt &&
        sessionAfter.currentAgent.exitCode === detail.currentAgent.exitCode,
      "Completed session, process and run identities must survive",
    );
    check(
      sessionAfter.checkpoints.some(
        (item) =>
          item.id === checkpoint.id &&
          item.sha === checkpoint.sha &&
          item.ref === checkpoint.ref &&
          item.seq === checkpoint.seq &&
          item.sealantRunId === checkpoint.sealantRunId,
      ),
      "Checkpoint row must survive",
    );
    check(
      (await api(`/changes/${detail.change.id}/diff`)).diff === diff.diff,
      "Change must survive unchanged",
    );
    check((await recordText()) === recorded, "Durable record replay must survive unchanged");
    check(
      (await changeState()) === changeBefore,
      "Checkpoint chain and pack-served Review patch must survive unchanged",
    );
    await idle();
  }
  stage = "CLI-only reads against the baseline server";
  const beforeCliFiles = await privateTreeFingerprint(configRoot);
  const beforeCliDocker = dockerFingerprint(await snapshot());
  await cli(["--help"]);
  await cli(["--version"]);
  check(
    (await cli(["version"])).includes(`server ${version} · ${origin}`),
    "CLI-only version inspection must still report the baseline server",
  );
  check(
    (await privateTreeFingerprint(configRoot)) === beforeCliFiles &&
      dockerFingerprint(await snapshot()) === beforeCliDocker,
    "CLI-only reads must not change the installation or Docker",
  );
  console.log(`PASS CLI ${manifest.version} reads left server ${version} unchanged`);
  stage = "idempotent setup rerun";
  await serverCli(setupArgs);
  await retained();
  stage = "setup with installed CLI version independent of server pin";
  await serverCli(["server", "setup", "--offline"]);
  await retained();
  stage = "public server restart";
  const beforeRestart = (await idle()).find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "mend",
  );
  await serverCli(["server", "restart", "--offline"]);
  await retained();
  const afterRestart = (await idle()).find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "mend",
  );
  check(
    afterRestart.Id !== beforeRestart.Id ||
      afterRestart.State.StartedAt !== beforeRestart.State.StartedAt,
    "server restart must actually restart the product",
  );
  stage = "public server stop/start";
  await cli(["server", "stop"], { timeout: 180_000 });
  const stopped = await collectOwned();
  check(
    !stopped.compose.some((item) => item.State.Running),
    "server stop must stop every product container",
  );
  let reachable = false;
  try {
    reachable = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    /* Stopped listener. */
  }
  check(!reachable, "Stopped server must not answer healthy");
  await serverCli(["server", "start", "--offline"]);
  await retained();
  console.log(
    "PASS setup rerun, actual restart, stop/start retained account, identity, config pin, SSH key, project, worktree, checkpoint chain, Review patch, change and record",
  );
  if (upgrade) {
    stage = "public two-image server upgrade";
    const beforeUpgrade = await privateTreeFingerprint(configRoot);
    const backupNames = await readdir(join(configRoot, "backups")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    check(backupNames.length === 0, "Earlier operations must not create upgrade backups");
    await runPackagedUpgrade(upgrade, offline, serverCli, collectOwned);
    await health(origin, upgrade.version);
    const target = await installation(upgrade.version, upgrade.assets);
    assertUpgradeRetention(saved, target);
    const old = await installation(version, assets, saved.target);
    check(old.fingerprint === saved.fingerprint, "Previous generation must remain byte-identical");
    const upgradedMend = (await idle()).find(
      (item) => item.Config.Labels["com.docker.compose.service"] === "mend",
    );
    const targetImage = JSON.parse(await docker(["image", "inspect", upgrade.image]))[0];
    assertImagePin(upgradedMend, targetImage, upgrade.image, upgrade.version);
    check(targetImage.Id !== imageInfo.Id, "Upgrade requires two distinct version-stamped images");
    await verifyUpgradeBackup(configRoot, saved.directory, target.directory);
    check(
      (await privateTreeFingerprint(configRoot)) !== beforeUpgrade,
      "Upgrade must actually publish a new generation and backup",
    );
    await retained(target, upgrade.assets);
    console.log(
      "PASS public two-image upgrade: target health/OCI/pin, private complete cluster dump with both databases and roles, old generation and application/Git/record data retained; five healthy idle containers",
    );

    async function unchangedCommand(args, expectedOk) {
      const files = await privateTreeFingerprint(configRoot);
      const before = dockerFingerprint(await snapshot());
      const result = await start(process.execPath, [bin, ...args], {
        diagnostic: expectedOk ? undefined : "Refusing downgrade",
      }).result;
      check(result.ok === expectedOk, "Upgrade no-op/refusal must return the expected exit status");
      check(
        expectedOk || result.diagnosticMatched,
        "Downgrade must fail explicitly, not from an unrelated error",
      );
      check(
        (await privateTreeFingerprint(configRoot)) === files &&
          dockerFingerprint(await snapshot()) === before,
        "Upgrade no-op/refusal must not change installation files, backups or Docker state",
      );
      await retained(target, upgrade.assets);
    }
    stage = "explicit downgrade refusal";
    await unchangedCommand(
      ["server", "upgrade", "--version", version, "--assets-dir", assets, "--offline"],
      false,
    );
    stage = "same-version upgrade no-op";
    await unchangedCommand(
      [
        "server",
        "upgrade",
        "--version",
        upgrade.version,
        "--assets-dir",
        upgrade.assets,
        "--offline",
      ],
      true,
    );
    console.log(
      "PASS explicit downgrade refused and same-version upgrade left files/backups/Docker unchanged",
    );
    console.log(
      "EVIDENCE LIMIT: same-source version fixtures exercise upgrade mechanics and retention, not historical migration compatibility, database restore or target-startup failure recovery",
    );
  } else
    console.log("NOT TESTED version upgrade; set paired MEND_TEST_UPGRADE_IMAGE/VERSION to enable");
  console.log(
    "NOT TESTED macOS or CLI updater; downloaded/build image caches are retained, never pruned",
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  // Assertion messages are script-authored. Native errors may include secrets; withhold them.
  console.error(
    `FAIL ${stage}: ${error instanceof assert.AssertionError ? error.message : "operation failed; raw error withheld"}`,
  );
  // A cancelled run goes straight to cleanup: the diagnosis would only delay it.
  if (diagnosis && !interrupted) {
    try {
      await printDiagnosis();
    } catch {
      console.error("DIAGNOSIS incomplete; raw error withheld");
    }
  }
} finally {
  if (process.exitCode === 1 && (setupAttempted || fixtureId)) {
    try {
      await collectFailureLogs();
    } catch {
      console.error("Owned-container failure logs unavailable; cleanup will still run");
    }
  }
  try {
    await cleanup();
  } catch {
    cleanupFailed = true;
    console.error("Cleanup failed; retained resources need manual ownership review");
  }
  if (cleanupFailed || interrupted) process.exitCode = 1;
  try {
    const diagnosticPath = await failedCommands.finish(process.exitCode === 1);
    if (diagnosticPath)
      console.error(
        `Private FAILED command diagnostics retained at ${diagnosticPath}; local inspection only, never upload to CI or publish these files.`,
      );
  } catch {
    process.exitCode = 1;
    console.error("Private command diagnostic storage failed; raw output withheld");
  }
}
