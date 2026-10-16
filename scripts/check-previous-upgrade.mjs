#!/usr/bin/env node
/**
 * Upgrade from a real published release to the candidate (image.yml's previous-upgrade jobs;
 * docs/operations/next-channel.md, "The upgrade window"). Everything of the old release comes from
 * its public artifacts and is checked before anything is set up:
 *
 * - a stable release by the pins committed in release/upgrade-from.json: its CLI by npm integrity,
 *   installed by `npm ci` against the lockfile committed beside the pins; its setup assets by
 *   sha256; its mend image and the images its setup starts beside Mend by digest, tagged locally
 *   so its offline setup pulls nothing;
 * - a next build by pins read live (it is not committed): the integrity and publish time npm
 *   records, the index digest ghcr serves for mend:<version>, the sha256 GitHub recorded for each
 *   release asset on upload; its CLI installed as npm resolved it when it was published
 *   (`npm install --before`); its setup allowed to pull the images it starts beside Mend.
 *
 * Then the old CLI sets up the old server from the old assets; an account, an adopted project, a
 * session that leaves checkpoints, a Review slice and a comment are seeded through it; the candidate
 * CLI upgrades it; and the candidate is checked twice, after the upgrade and again after a restart:
 * health and the running image are the candidate's, the same account signs in, and the seeded
 * project, session, checkpoints, Review slice and comment are intact. A new session runs and Mend's
 * migrations are exactly the candidate's.
 *
 * Each failure says whose it is: HARNESS FAILURE when this script or the artifacts it fetches went
 * wrong, PRODUCT FAILURE when Mend's own setup, upgrade or data did. On a failure the server's logs
 * and `mend server status` are written to MEND_UPGRADE_ARTIFACTS (default <scratch>/artifacts).
 *
 * Environment:
 *   MEND_UPGRADE_FROM                 the release to upgrade from
 *   MEND_TEST_UPGRADE_IMAGE/_VERSION  the candidate, loaded and tagged locally by the job
 *   MEND_TEST_UPGRADE_IMAGE_ID        the image ID CI verified by digest
 *   MEND_TEST_CLI_TARBALL             the candidate CLI tarball
 *   MEND_UPGRADE_CANDIDATE_ASSETS     the candidate's setup assets (default deploy/docker)
 *   MEND_TEST_OFFLINE=1               the candidate's upgrade pulls nothing (archive mode)
 *   MEND_UPGRADE_DERIVED=1            the candidate is a dev or acceptance build: see below
 *
 * A dev or acceptance build is stamped 0.0.0-*, which orders below every release, so the CLI refuses
 * that upgrade as a downgrade: such a run proves everything up to the upgrade and reports the
 * upgrade as NOT TESTED. A dry run is stamped above the window and runs the whole scenario.
 *
 * It leaves the installation it made in place, and cleans up nothing, on success or failure: run it
 * on a fresh runner only, never on a workstation's Docker daemon.
 *
 *   MEND_UPGRADE_FROM=<stable release> node scripts/check-previous-upgrade.mjs --prepare-only
 * checks a stable release's committed pins against its artifacts and stops before setup.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFreshDocker,
  assertHealth,
  isolatedClientEnvironment,
  reviewDiffEvidence,
  runPackagedUpgrade,
} from "./packaged-server-assertions.mjs";
import { checkPins, isStable } from "./upgrade-window.mjs";

export const RELEASES = "https://github.com/sealant-sh/Mend/releases/download";
export const ASSETS = [
  "compose.v2.yaml",
  "setup-contract.v2.json",
  "install.sh",
  "postgres-init.sh",
];
const FIXTURE_LABEL = "sh.sealant.mend.previous-upgrade";

/** Why the lockfile cannot install exactly the pinned CLI; empty when it can. */
export function lockfileProblems(lock, version, integrity) {
  const mend = lock?.packages?.["node_modules/@sealant/mend"];
  return [
    lock?.lockfileVersion !== 3 && `lockfileVersion ${lock?.lockfileVersion}, not 3`,
    lock?.packages?.[""]?.dependencies?.["@sealant/mend"] !== version &&
      `the root does not depend on exactly @sealant/mend@${version}`,
    mend?.version !== version && `it locks @sealant/mend ${mend?.version}, not ${version}`,
    mend?.integrity !== integrity && `its @sealant/mend integrity is not the pinned ${integrity}`,
    ...Object.entries(lock?.packages ?? {})
      .filter(
        ([name, entry]) =>
          name !== "" && !entry.link && !(entry.integrity ?? "").startsWith("sha512-"),
      )
      .map(([name]) => `${name} has no sha512 integrity`),
  ].filter(Boolean);
}

/**
 * Mend's migrations the database holds against the candidate image's /app/migrations.txt: every
 * migration the image ships is applied under the same name, and nothing else is.
 */
export function migrationLevelProblems(applied, manifest) {
  const shipped = new Map();
  for (const line of manifest.split("\n")) {
    const [kind, entry] = line.trim().split(/\s+/);
    const match = kind === "mend" ? /^(\d+)_(.+)$/.exec(entry ?? "") : null;
    if (match) shipped.set(Number(match[1]), match[2]);
  }
  const problems = [];
  if (shipped.size === 0) problems.push("the candidate image lists no Mend migration");
  const seen = new Map(applied.map(({ id, name }) => [id, name]));
  for (const [id, name] of shipped)
    if (seen.get(id) !== name) problems.push(`migration ${id}_${name} is not applied`);
  for (const [id, name] of seen)
    if (shipped.get(id) !== name)
      problems.push(`migration ${id}_${name} is applied but not shipped`);
  return problems;
}

/** What of the seeded state did not survive; empty when all of it did. */
export function seededStateProblems(before, after) {
  const problems = [];
  if (!after.projects.some((project) => project.id === before.projectId))
    problems.push(`project ${before.projectId} is gone`);
  if (after.sessionId !== before.sessionId) problems.push(`session ${before.sessionId} is gone`);
  const kept = new Map(after.checkpoints.map(({ ordinal, sha }) => [ordinal, sha]));
  for (const { ordinal, sha } of before.checkpoints)
    if (kept.get(ordinal) !== sha)
      problems.push(`checkpoint ${ordinal} (${sha}) is gone or changed`);
  const comment = after.comments.find((item) => item.id === before.commentId);
  if (comment === undefined) problems.push(`comment ${before.commentId} is gone`);
  else if (comment.body !== before.commentBody)
    problems.push(`comment ${before.commentId} changed`);
  return problems;
}

/**
 * The review comment seeded on the old server: file-level, on the committed file. Both 0.35.1 and
 * 0.36.0-next.792 take a target with a path and every location field null when that file is in
 * the slice; a line target needs the slice's own hunk hash.
 */
export const fileComment = (file, body) => ({
  target: {
    oldPath: null,
    newPath: file,
    side: null,
    startLine: null,
    endLine: null,
    hunkContextHash: null,
  },
  body,
});

/**
 * The Git fixture's container: the old Mend image's node serving a bare repository on the
 * installation's network. Images have no /fixture, so a labelled volume is mounted there, as
 * scripts/check-packaged-server.mjs does, and the repository and server script are copied into it.
 */
export async function prepareFixtureContainer(
  docker,
  {
    name,
    image,
    network,
    bare,
    files,
    entrypoint = "node",
    command = ["/fixture/packaged-git-fixture.mjs"],
  },
) {
  await docker(["volume", "create", "--label", `${FIXTURE_LABEL}=${name}`, name]);
  const id = (
    await docker([
      "create",
      "--name",
      name,
      "--label",
      `${FIXTURE_LABEL}=${name}`,
      "--network",
      network,
      "--mount",
      `type=volume,source=${name},target=/fixture`,
      "--entrypoint",
      entrypoint,
      image,
      ...command,
    ])
  ).trim();
  await docker(["cp", bare, `${id}:/fixture/repo.git`]);
  for (const file of files) await docker(["cp", file, `${id}:/fixture/`]);
  return id;
}

// --- the run ---

const patchOf = (view) => JSON.stringify(view);

const repo = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const from = process.env.MEND_UPGRADE_FROM;
const candidate = process.env.MEND_TEST_UPGRADE_VERSION;
const candidateImage = process.env.MEND_TEST_UPGRADE_IMAGE;
const candidateId = process.env.MEND_TEST_UPGRADE_IMAGE_ID;
const cliTarball = process.env.MEND_TEST_CLI_TARBALL;
const candidateAssets = process.env.MEND_UPGRADE_CANDIDATE_ASSETS || join(repo, "deploy/docker");
const offline = process.env.MEND_TEST_OFFLINE === "1";
const derived = process.env.MEND_UPGRADE_DERIVED === "1";
const runId = randomUUID();
let stage = "preflight";
let kind = "harness";
let scratch;
let env = { ...process.env };
let lastCli;

class StageFailure extends Error {}

const check = (condition, message) => {
  if (!condition) throw new StageFailure(`${stage}: ${message}`);
};
/** What follows is this script's own work, or the product's. */
const begin = (name, whose) => {
  stage = name;
  kind = whose;
};

function start(
  command,
  args,
  { timeout = 120_000, environment = env, cwd = scratch ?? repo } = {},
) {
  const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const result = once(child, "close").then(([status, signal]) => {
    clearTimeout(timer);
    return { ok: status === 0, status, signal, output, error };
  });
  return { child, result };
}

async function run(command, args, options) {
  const result = await start(command, args, options).result;
  if (!result.ok)
    console.error(`DIAGNOSIS ${command} ${args[0] ?? ""}: ${result.error.slice(-2000)}`);
  check(
    result.ok,
    `${command} ${args.slice(0, 3).join(" ")} failed (${result.status ?? result.signal})`,
  );
  return result.output;
}

const docker = (args, options) => run("docker", args, { environment: process.env, ...options });
const lines = (text) => text.split("\n").filter(Boolean);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, probe, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    check(Date.now() < deadline, `timed out waiting for ${what}`);
    await pause(2000);
  }
}

async function request(origin, route, { token, method = "GET", body, headers = {} } = {}) {
  return fetch(`${origin}/api${route}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
}

async function json(origin, route, options) {
  const response = await request(origin, route, options);
  if (!response.ok)
    console.error(`DIAGNOSIS ${route.split("?")[0]}: ${(await response.text()).slice(0, 500)}`);
  check(response.ok, `${route.split("?")[0]} answered ${response.status}`);
  return response.json();
}

async function health(origin, version) {
  return until(`health at ${version}`, async () => {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return false;
      const body = await response.json();
      if (body.version !== version) return false;
      assertHealth(body, version);
      return body;
    } catch {
      return false;
    }
  });
}

async function snapshot() {
  const inspect = async (what, listing) => {
    const ids = lines(await docker(listing));
    return ids.length === 0 ? [] : JSON.parse(await docker([what, "inspect", ...ids]));
  };
  return {
    containers: await inspect("container", ["ps", "-aq", "--no-trunc"]),
    networks: await inspect("network", ["network", "ls", "-q", "--no-trunc"]),
    volumes: await inspect("volume", ["volume", "ls", "-q"]),
  };
}

async function freePorts(count) {
  const ports = [];
  for (let index = 0; index < count; index += 1)
    ports.push(
      await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          server.close(() => resolve(port));
        });
      }),
    );
  return ports;
}

async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function getJson(url) {
  const headers = { accept: "application/json" };
  if (url.startsWith("https://api.github.com/") && process.env.GH_TOKEN)
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) }).catch(
      () => undefined,
    );
    if (response?.ok) return response.json();
    check(attempt < 4, `${url} answered ${response?.status ?? "nothing"}`);
    await pause(attempt * 1500);
  }
}

const summary = async (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

/**
 * The old release's pins. A stable release's are committed; a next build's are read live from npm,
 * ghcr and the GitHub release, each value from the source that cannot be rewritten as easily as the
 * one it checks.
 */
async function resolvePins() {
  begin(`the ${from} pins`, "harness");
  if (isStable(from)) {
    const pins = JSON.parse(await readFile(join(repo, "release/upgrade-from.json"), "utf8"));
    checkPins(pins, [from]);
    return { ...pins.releases[from], source: "release/upgrade-from.json" };
  }
  const packument = await getJson(`https://registry.npmjs.org/@sealant%2fmend`);
  const manifest = packument.versions?.[from];
  check(manifest !== undefined, `npm has no @sealant/mend@${from}`);
  check(manifest.version === from, `npm's ${from} record says ${manifest.version}`);
  const integrity = manifest.dist?.integrity;
  check(
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? ""),
    `npm's ${from} has no sha512 integrity`,
  );
  const publishedAt = packument.time?.[from];
  check(Number.isFinite(Date.parse(publishedAt)), `npm records no publish time for ${from}`);
  const index = JSON.parse(
    await docker([
      "buildx",
      "imagetools",
      "inspect",
      `ghcr.io/sealant-sh/mend:${from}`,
      "--format",
      "{{json .Manifest}}",
    ]),
  ).digest;
  check(/^sha256:[0-9a-f]{64}$/.test(index ?? ""), `ghcr.io/sealant-sh/mend:${from} has no digest`);
  const release = await getJson(
    `https://api.github.com/repos/sealant-sh/Mend/releases/tags/v${from}`,
  );
  check(release.draft === false, `v${from} is a draft`);
  const assets = {};
  for (const name of ASSETS) {
    const asset = release.assets?.find((item) => item.name === name);
    check(asset !== undefined, `the v${from} release lacks ${name}`);
    check(
      /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? ""),
      `GitHub records no sha256 for v${from} ${name}`,
    );
    assets[name] = asset.digest.slice(7);
  }
  return {
    publishedAt,
    npm: { integrity },
    images: { mend: index },
    assets,
    support: {},
    source: "read live from npm, ghcr and the GitHub release",
  };
}

/** The old release's CLI, installed exactly, and its integrity bound to the pin. */
async function installOldCli(pin) {
  begin(`the ${from} CLI`, "harness");
  const directory = join(scratch, "old-cli");
  await mkdir(directory);
  const npmArgs = [
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry",
    "https://registry.npmjs.org/",
  ];
  if (isStable(from)) {
    const pinned = join(repo, "release/upgrade-from", from);
    for (const file of ["package.json", "package-lock.json"])
      await copyFile(join(pinned, file), join(directory, file));
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    const problems = lockfileProblems(lock, from, pin.npm.integrity);
    check(
      problems.length === 0,
      `release/upgrade-from/${from}/package-lock.json: ${problems.join("; ")}`,
    );
    // npm ci installs the lockfile or nothing, each tarball checked against its integrity.
    await run("npm", ["ci", ...npmArgs], { cwd: directory, timeout: 300_000 });
  } else {
    // As npm resolved it when the version was published: the same tree on every run.
    const before = new Date(Date.parse(pin.publishedAt) + 1000).toISOString();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies: { "@sealant/mend": from } }),
    );
    await run("npm", ["install", ...npmArgs, `--before=${before}`], {
      cwd: directory,
      timeout: 300_000,
    });
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    const problems = lockfileProblems(lock, from, pin.npm.integrity);
    check(problems.length === 0, `the ${from} install: ${problems.join("; ")}`);
    pin.dependencies = `npm install --before=${before}, ${Object.keys(lock.packages).length - 1} packages`;
  }
  const bin = join(directory, "node_modules/.bin/mend");
  check(
    (await run(process.execPath, [bin, "--version"])).split("\n")[0].trim() === `mend ${from}`,
    `the installed CLI is not mend ${from}`,
  );
  return bin;
}

/** The old release's setup assets, from its GitHub release, each checked against its sha256. */
async function fetchOldAssets(pin) {
  begin(`the ${from} setup assets`, "harness");
  const directory = join(scratch, "old-assets");
  await mkdir(directory);
  for (const [asset, sha256] of Object.entries(pin.assets)) {
    const url = `${RELEASES}/v${from}/${asset}`;
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    check(response.ok, `${url} answered ${response.status}: the release lacks ${asset}`);
    const file = join(directory, asset);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    check(
      (await sha256Of(file)) === sha256,
      `${asset} of v${from} is not the pinned sha256 ${sha256}`,
    );
  }
  return directory;
}

/** The old images by digest, tagged with the names the old setup expects. */
async function loadOldImages(pin) {
  begin(`the ${from} images`, "harness");
  const pullTag = async (pinned, tag) => {
    await docker(["pull", pinned], { timeout: 600_000 });
    const id = (await docker(["image", "inspect", pinned, "--format", "{{.Id}}"])).trim();
    if (tag !== undefined) await docker(["tag", id, tag]);
    return id;
  };
  const id = await pullTag(
    `ghcr.io/sealant-sh/mend@${pin.images.mend}`,
    `ghcr.io/sealant-sh/mend:${from}`,
  );
  const label = (
    await docker([
      "image",
      "inspect",
      id,
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
    ])
  ).trim();
  check(
    label === from,
    `ghcr.io/sealant-sh/mend@${pin.images.mend} is stamped ${label}, not ${from}`,
  );
  for (const [reference, pinned] of Object.entries(pin.support)) {
    if (reference.includes("@")) {
      check(reference.endsWith(pinned.slice(pinned.indexOf("@"))), `${reference} is not ${pinned}`);
      await docker(["pull", reference], { timeout: 600_000 });
    } else await pullTag(pinned, reference);
  }
  return id;
}

/** Server logs and status, for a failure's artifacts. Never fails itself. */
async function collectArtifacts() {
  const directory = process.env.MEND_UPGRADE_ARTIFACTS || (scratch && join(scratch, "artifacts"));
  if (!directory) return;
  try {
    await mkdir(directory, { recursive: true });
    if (lastCli) {
      for (const [file, args] of [
        ["mend-server-status.txt", ["server", "status"]],
        ["mend-server-logs.txt", ["server", "logs", "--tail", "1000"]],
      ]) {
        const result = await start(process.execPath, [lastCli, ...args], { timeout: 120_000 })
          .result;
        await writeFile(join(directory, file), `${result.output}\n--- stderr ---\n${result.error}`);
      }
    }
    const listed = await start(
      "docker",
      ["ps", "-a", "--format", "{{.ID}} {{.Names}} {{.Image}} {{.Status}}"],
      {
        environment: process.env,
      },
    ).result;
    await writeFile(join(directory, "docker-ps.txt"), listed.output);
    for (const line of lines(listed.output)) {
      const [id, name] = line.split(" ");
      const logs = await start("docker", ["logs", "--tail", "2000", id], {
        environment: process.env,
      }).result;
      await writeFile(
        join(directory, `container-${name}.log`),
        `${logs.output}\n--- stderr ---\n${logs.error}`,
      );
    }
    console.error(`DIAGNOSIS server logs and status written to ${directory}`);
  } catch (error) {
    console.error(`DIAGNOSIS could not collect artifacts: ${error.message}`);
  }
}

async function main() {
  const prepareOnly = process.argv.slice(2).join(" ") === "--prepare-only";
  check(
    process.argv.length === 2 || prepareOnly,
    "usage: check-previous-upgrade.mjs [--prepare-only]",
  );
  check(process.platform === "linux", "Linux only");
  check(/^\d+\.\d+\.\d+(-next\.\d+)?$/.test(from ?? ""), "set MEND_UPGRADE_FROM to a release");
  scratch = await mkdtemp(join(tmpdir(), "mend-previous-upgrade-"));
  if (prepareOnly) {
    check(isStable(from), "--prepare-only checks a stable release's committed pins");
    env.npm_config_cache = join(scratch, "npm-cache");
    const pin = await resolvePins();
    await installOldCli(pin);
    await fetchOldAssets(pin);
    await loadOldImages(pin);
    console.log(
      `PASS ${from}: CLI, setup assets and images match release/upgrade-from.json (${scratch})`,
    );
    return;
  }
  check(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate ?? ""),
    "set MEND_TEST_UPGRADE_VERSION",
  );
  check(candidateImage === `ghcr.io/sealant-sh/mend:${candidate}`, "MEND_TEST_UPGRADE_IMAGE");
  check(/^sha256:[0-9a-f]{64}$/.test(candidateId ?? ""), "MEND_TEST_UPGRADE_IMAGE_ID");
  check(/^\/.+\.tgz$/.test(cliTarball ?? ""), "MEND_TEST_CLI_TARBALL");
  check(
    !process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
    "unset DOCKER_HOST/DOCKER_CONTEXT",
  );
  const context = (await docker(["context", "show"])).trim();
  assertFreshDocker(await snapshot());

  const home = join(scratch, "home");
  await mkdir(home, { mode: 0o700 });
  env = isolatedClientEnvironment(process.env, home, process.env.DOCKER_CONFIG);
  env.npm_config_cache = join(scratch, "npm-cache");
  const pin = await resolvePins();
  const oldBin = await installOldCli(pin);
  const oldAssets = await fetchOldAssets(pin);
  const oldImage = await loadOldImages(pin);
  await summary(
    [
      `#### Upgrade from ${from} to ${candidate}: pins (${pin.source})`,
      "",
      `- npm \`@sealant/mend@${from}\`: \`${pin.npm.integrity}\`${pin.dependencies ? ` (${pin.dependencies})` : ""}`,
      `- \`ghcr.io/sealant-sh/mend:${from}\`: \`${pin.images.mend}\`, labelled ${from}`,
      ...Object.entries(pin.assets).map(([asset, sha]) => `- ${asset}: sha256 \`${sha}\``),
      ...Object.entries(pin.support).map(([reference, pinned]) => `- ${reference}: \`${pinned}\``),
    ].join("\n"),
  );

  begin(`${from} setup`, "product");
  lastCli = oldBin;
  const [port, sshPort] = await freePorts(2);
  const origin = `http://127.0.0.1:${port}`;
  const oldCli = (args, options) =>
    run(process.execPath, [oldBin, ...args], { timeout: 600_000, ...options });
  // The old release's own flags (its scripts/check-packaged-server.mjs at its tag drove it so). A
  // next build's support images are not pinned: its setup pulls them as it would for a user.
  await oldCli([
    "server",
    "setup",
    "--context",
    context,
    ...(isStable(from) ? ["--offline"] : []),
    "--version",
    from,
    "--assets-dir",
    oldAssets,
    "--port",
    String(port),
    "--ssh-port",
    String(sshPort),
    "--url",
    origin,
  ]);
  await health(origin, from);
  console.log(`PASS ${from} set up by its own CLI from its own assets and image`);

  begin(`seed on ${from}`, "product");
  const email = `${runId}@previous-upgrade.invalid`;
  const password = randomBytes(32).toString("hex");
  const signup = await request(origin, "/auth/sign-up/email", {
    method: "POST",
    headers: { origin },
    body: { email, password, name: "Previous release upgrade" },
  });
  check(signup.ok, `sign-up answered ${signup.status}`);
  let token = signup.headers.get("set-auth-token");
  check(typeof token === "string" && token.length > 0, "sign-up returned no bearer token");
  const api = (route, options = {}) => json(origin, route, { token, ...options });
  env.MEND_URL = origin;
  env.MEND_TOKEN = token;

  begin("the Git fixture", "harness");
  const source = join(scratch, "source");
  await mkdir(source);
  const git = (args, cwd = source) => run("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await writeFile(join(source, "README.md"), "Previous release upgrade fixture\n");
  await git(["add", "README.md"]);
  await git([
    "-c",
    "user.name=Upgrade",
    "-c",
    "user.email=upgrade@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const baseSha = (await git(["rev-parse", "HEAD"])).trim();
  const bare = join(scratch, "repo.git");
  await git(["clone", "--bare", source, bare]);
  await git(["update-server-info"], bare);
  const mendContainer = lines(
    await docker(["ps", "-q", "--filter", "label=com.docker.compose.service=mend"]),
  );
  check(mendContainer.length === 1, `expected one mend container, found ${mendContainer.length}`);
  const network = lines(
    await docker([
      "inspect",
      mendContainer[0],
      "--format",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
    ]),
  )[0];
  const fixture = `mend-previous-upgrade-${runId}`;
  const fixtureId = await prepareFixtureContainer(docker, {
    name: fixture,
    image: oldImage,
    network,
    bare,
    files: ["packaged-git-fixture.mjs", "packaged-server-assertions.mjs"].map((name) =>
      join(repo, "scripts", name),
    ),
  });
  await docker(["start", fixtureId]);
  const sourceUrl = `http://${fixture}:9080/repo.git`;
  await until(
    "the Git fixture",
    async () =>
      (
        await start(
          "docker",
          [
            "exec",
            fixtureId,
            "node",
            "-e",
            "fetch('http://127.0.0.1:9080/repo.git/HEAD').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          { environment: process.env },
        ).result
      ).ok,
  );
  await docker(["pull", "node:26-bookworm"], { timeout: 600_000 });
  const base = `${fixture}-base:latest`;
  await docker(["tag", "node:26-bookworm", base]);

  begin(`seed on ${from}`, "product");
  const projectName = `upgrade-${runId.slice(0, 8)}`;
  await oldCli(["adopt", sourceUrl, "--name", projectName], { timeout: 180_000 });
  const project = (await api("/projects")).find((item) => item.name === projectName);
  check(project !== undefined, "the adopted project is not listed");
  // A plain base keeps the first session from building the default workspace image.
  const saved = await api(`/projects/${project.id}/workspace-image`, {
    method: "PUT",
    body: {
      workspaceImage: {
        mode: "custom",
        baseImage: base,
        packages: [],
        setupCommands: [],
        services: { docker: false },
      },
    },
  });
  check(saved.saved === true, "the custom workspace base was not saved");
  const marker = `previous-upgrade-${runId}`;
  const file = "upgrade-proof.txt";
  const command = `set -eu; git config user.name Upgrade; git config user.email upgrade@example.invalid; printf '%s\\n' '${marker}' > ${file}; git add ${file}; git commit -m 'upgrade proof'; sleep 20; printf '%s\\n' '${marker}'`;
  const launched = start(
    process.execPath,
    [oldBin, "run", "--project", projectName, "--name", "upgrade-proof", "--", "sh", "-c", command],
    { timeout: 900_000 },
  );
  const session = await until(
    "the seeded session",
    async () =>
      (await api(`/projects/${project.id}?deadEnds=include`)).sessions?.find(
        (item) => item.branch === "mend/upgrade-proof",
      ),
    600_000,
  );
  const detail = await until(
    "a checkpoint past the base",
    async () => {
      const current = await api(`/sessions/${session.id}`);
      check(current.session.status !== "failed", "the seeded session failed");
      if (!current.change?.id || !current.session.worktreeId) return false;
      const worktree = await api(`/worktrees/${current.session.worktreeId}`);
      return (worktree.checkpoints ?? []).some((item) => item.sha !== baseSha) ? current : false;
    },
    600_000,
  );
  check((await launched.result).ok, "mend run of the seeded session failed");
  const changeId = detail.change.id;
  const worktreeId = detail.session.worktreeId;
  const review = await api(`/changes/${changeId}/reviews/open`, {
    method: "POST",
    body: { idempotencyKey: `previous-upgrade-${runId}` },
  });
  const sliceId = review.slice?.id;
  check(typeof sliceId === "string", "opening Review returned no slice");
  check(
    patchOf(await api(`/changes/${changeId}/reviews/${sliceId}/diff`)).includes(marker),
    "the Review slice does not show the seeded change",
  );
  const commentBody = `kept across the upgrade from ${from} (${runId})`;
  const comment = await api(`/changes/${changeId}/reviews/${sliceId}/comments`, {
    method: "POST",
    body: fileComment(file, commentBody),
  });
  check(typeof comment.id === "string", "the comment was not recorded");
  const chain = async (read) =>
    ((await read(`/worktrees/${worktreeId}`)).checkpoints ?? []).map(({ ordinal, sha }) => ({
      ordinal,
      sha,
    }));
  const before = {
    projectId: project.id,
    sessionId: session.id,
    checkpoints: await chain(api),
    commentId: comment.id,
    commentBody,
  };
  await summary(
    `- seeded on ${from}: project ${project.id}, session ${session.id}, ${before.checkpoints.length} checkpoints, Review slice ${sliceId}, comment ${comment.id}`,
  );

  if (derived) {
    await summary(
      `NOT TESTED the upgrade from ${from} to ${candidate}: a dev or acceptance build is stamped 0.0.0-* and orders below ${from}, so the CLI refuses it as a downgrade. A release or a dry run runs it.`,
    );
    return;
  }

  begin("the candidate CLI", "harness");
  const candidateDir = join(scratch, "candidate");
  await mkdir(candidateDir);
  await writeFile(join(candidateDir, "package.json"), JSON.stringify({ private: true }));
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", cliTarball], {
    cwd: candidateDir,
    timeout: 300_000,
  });
  const candidateBin = join(candidateDir, "node_modules/.bin/mend");
  lastCli = candidateBin;
  const candidateCli = (args, options = {}) =>
    run(process.execPath, [candidateBin, ...args], { timeout: options.timeout ?? 600_000 });

  begin(`upgrade ${from} → ${candidate}`, "product");
  await runPackagedUpgrade(
    { version: candidate, assets: candidateAssets },
    offline,
    candidateCli,
    async () => {},
  );
  // The account, the seeded data and the running image, read again after the upgrade and after a
  // restart: a restart is where a half-applied upgrade shows.
  const intact = async (when) => {
    begin(`the candidate ${when}`, "product");
    await health(origin, candidate);
    const running = lines(
      await docker(["ps", "-q", "--filter", "label=com.docker.compose.service=mend"]),
    );
    check(running.length === 1, `expected one mend container, found ${running.length}`);
    const inspected = JSON.parse(await docker(["inspect", running[0]]))[0];
    check(
      inspected.Image === candidateId,
      `the running server is ${inspected.Image}, not ${candidateId}`,
    );
    const signin = await request(origin, "/auth/sign-in/email", {
      method: "POST",
      headers: { origin },
      body: { email, password },
    });
    check(signin.ok, `the seeded account cannot sign in (${signin.status})`);
    token = signin.headers.get("set-auth-token");
    check(typeof token === "string" && token.length > 0, "sign-in returned no bearer token");
    env.MEND_TOKEN = token;
    const authed = (route) => json(origin, route, { token });
    const lost = seededStateProblems(before, {
      projects: await authed("/projects"),
      sessionId: (await authed(`/sessions/${session.id}`)).session?.id,
      checkpoints: await chain(authed),
      comments: await authed(`/changes/${changeId}/comments`),
    });
    check(lost.length === 0, lost.join("; "));
    try {
      reviewDiffEvidence(await authed(`/changes/${changeId}/reviews/${sliceId}/diff`), {
        baseSha,
        sliceId,
        marker,
        file,
      });
    } catch (error) {
      check(false, `the Review slice ${when}: ${error.message}`);
    }
    console.log(
      `PASS ${when}: health, image, sign-in, project, session, checkpoints, Review and comment`,
    );
  };
  await intact("after the upgrade");
  begin("a new session on the candidate", "product");
  await candidateCli(
    [
      "run",
      "--project",
      projectName,
      "--name",
      "after-upgrade",
      "--",
      "sh",
      "-c",
      "echo after-upgrade",
    ],
    { timeout: 900_000 },
  );
  console.log("PASS a new session ran on the candidate");
  begin("a restart on the candidate", "product");
  await candidateCli(["server", "restart", ...(offline ? ["--offline"] : [])]);
  await intact("after a restart");
  begin("the candidate's migrations", "product");
  const manifest = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    candidateImage,
    "/app/migrations.txt",
  ]);
  const postgres = lines(
    await docker(["ps", "-q", "--filter", "label=com.docker.compose.service=postgres"]),
  );
  check(postgres.length === 1, `expected one postgres container, found ${postgres.length}`);
  const applied = lines(
    await docker([
      "exec",
      postgres[0],
      "psql",
      "-U",
      "postgres",
      "-d",
      "mend",
      "-At",
      "-c",
      "select migration_id, name from mend_migrations order by migration_id",
    ]),
  ).map((line) => {
    const [id, name] = line.split("|");
    return { id: Number(id), name };
  });
  const migrations = migrationLevelProblems(applied, manifest);
  check(migrations.length === 0, migrations.join("; "));
  await summary(
    `PASS ${from} → ${candidate}: data intact after the upgrade and a restart; ${applied.length} migrations are the candidate's`,
  );
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const whose = kind === "product" ? "PRODUCT FAILURE" : "HARNESS FAILURE";
    const message =
      error instanceof StageFailure ? error.message : `${stage}: ${error.stack ?? error.message}`;
    console.error(`::error::${whose} in ${message}`);
    await summary(`**${whose}** in ${message}`).catch(() => {});
    if (scratch && !process.argv.includes("--prepare-only")) await collectArtifacts();
    process.exit(1);
  });
}
