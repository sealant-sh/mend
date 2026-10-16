#!/usr/bin/env node
/**
 * Upgrade from a real published release to the candidate (image.yml's previous-upgrade jobs;
 * docs/operations/next-channel.md, "The upgrade window"). Everything of the old release comes from
 * its public artifacts and must match release/upgrade-from.json: the CLI by npm integrity,
 * installed by `npm ci` against the lockfile committed beside the pins; its setup assets by
 * sha256; its mend image and the images its setup runs beside Mend by digest, tagged locally so
 * the old setup pulls nothing. Then:
 *
 *   1. the old CLI sets up the old server, offline, from the old assets;
 *   2. an account, an adopted project, a session that leaves a checkpoint, an open Review slice and
 *      a comment on it are seeded through the old server;
 *   3. the candidate CLI upgrades the server to the candidate;
 *   4. health reports the candidate's version, the running image is the one CI verified, the same
 *      account signs in, the seeded project, session, checkpoints and comment are intact, a new
 *      session runs, a restart is clean, and Mend's migrations are exactly the candidate's.
 *
 * A missing or mismatched artifact fails, by name; nothing is skipped. Environment:
 *   MEND_UPGRADE_FROM                 the release to upgrade from, pinned in release/upgrade-from.json
 *   MEND_TEST_UPGRADE_IMAGE/_VERSION  the candidate, loaded and tagged locally by the job
 *   MEND_TEST_UPGRADE_IMAGE_ID        the image ID CI verified by digest
 *   MEND_TEST_CLI_TARBALL             the candidate CLI tarball
 *   MEND_TEST_OFFLINE=1               the candidate's upgrade pulls nothing (archive mode)
 *   MEND_UPGRADE_DERIVED=1            the candidate is no release (0.0.0-*): see below
 *
 * A candidate that is no release (a dry run, a dev or acceptance build) is stamped 0.0.0-*, which
 * orders below every published release: the CLI refuses that upgrade as a downgrade. Such a run
 * proves everything up to the upgrade and says, as NOT TESTED, that the upgrade itself is proven
 * only on a release candidate.
 * Linux only, against a fresh local Docker daemon, as scripts/check-packaged-server.mjs.
 *
 *   MEND_UPGRADE_FROM=<release> node scripts/check-previous-upgrade.mjs --prepare-only
 * checks a release's pins against its public artifacts (the CLI installed from its lockfile, its
 * assets, its images pulled by digest) and stops before anything is set up: run it when adding a
 * release to release/upgrade-from.json.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFreshDocker,
  assertHealth,
  isolatedClientEnvironment,
  runPackagedUpgrade,
} from "./packaged-server-assertions.mjs";
import { checkPins } from "./upgrade-window.mjs";

export const RELEASES = "https://github.com/sealant-sh/Mend/releases/download";

/** Why the committed lockfile cannot install exactly the pinned CLI; empty when it can. */
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

/** What of the seeded state did not survive the upgrade; empty when all of it did. */
export function seededStateProblems(before, after) {
  const problems = [];
  if (!after.projects.some((project) => project.id === before.projectId))
    problems.push(`project ${before.projectId} is gone`);
  if (after.sessionId !== before.sessionId) problems.push(`session ${before.sessionId} is gone`);
  const kept = new Set(after.checkpoints);
  for (const sha of before.checkpoints)
    if (!kept.has(sha)) problems.push(`checkpoint ${sha} is gone`);
  const comment = after.comments.find((item) => item.id === before.commentId);
  if (comment === undefined) problems.push(`comment ${before.commentId} is gone`);
  else if (comment.body !== before.commentBody)
    problems.push(`comment ${before.commentId} changed`);
  if (!after.patch.includes(before.marker))
    problems.push("the Review slice no longer shows the change");
  return problems;
}

// --- the run ---

/** A Review diff as text, for finding the seeded marker in it. */
const patchOf = (view) => JSON.stringify(view);

const repo = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const from = process.env.MEND_UPGRADE_FROM;
const candidate = process.env.MEND_TEST_UPGRADE_VERSION;
const candidateImage = process.env.MEND_TEST_UPGRADE_IMAGE;
const candidateId = process.env.MEND_TEST_UPGRADE_IMAGE_ID;
const cliTarball = process.env.MEND_TEST_CLI_TARBALL;
const offline = process.env.MEND_TEST_OFFLINE === "1";
const derived = process.env.MEND_UPGRADE_DERIVED === "1";
const runId = randomUUID();
let stage = "preflight";
let scratch;
let env = { ...process.env };

const check = (condition, message) => assert.ok(condition, `${stage}: ${message}`);

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
  // Command output can carry credentials: only its tail, and only on failure.
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
  const inspect = async (kind, listing) => {
    const ids = lines(await docker(listing));
    return ids.length === 0 ? [] : JSON.parse(await docker([kind, "inspect", ...ids]));
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

/** The old release's CLI, installed exactly: npm ci against the committed lockfile. */
async function installOldCli(pin) {
  stage = `the ${from} CLI`;
  const directory = join(scratch, "old-cli");
  await mkdir(directory);
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
  await run(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      "https://registry.npmjs.org/",
    ],
    { cwd: directory, timeout: 300_000 },
  );
  const bin = join(directory, "node_modules/.bin/mend");
  check(
    (await run(process.execPath, [bin, "--version"])).split("\n")[0].trim() === `mend ${from}`,
    `the installed CLI is not mend ${from}`,
  );
  return bin;
}

/** The old release's setup assets, from its GitHub release, each checked against its sha256. */
async function fetchOldAssets(pin) {
  stage = `the ${from} setup assets`;
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

/** The old images by digest, tagged with the names the old setup expects; it then pulls nothing. */
async function loadOldImages(pin) {
  stage = `the ${from} images`;
  const pullTag = async (pinned, tag) => {
    await docker(["pull", pinned], { timeout: 600_000 });
    const id = (await docker(["image", "inspect", pinned, "--format", "{{.Id}}"])).trim();
    if (tag !== undefined) await docker(["tag", id, tag]);
    return id;
  };
  const image = `ghcr.io/sealant-sh/mend:${from}`;
  const id = await pullTag(`ghcr.io/sealant-sh/mend@${pin.images.mend}`, image);
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
      // Already a digest reference: it must be the pinned one, and is pulled as named.
      check(reference.endsWith(pinned.slice(pinned.indexOf("@"))), `${reference} is not ${pinned}`);
      await docker(["pull", reference], { timeout: 600_000 });
    } else await pullTag(pinned, reference);
  }
  return id;
}

async function main() {
  const prepareOnly = process.argv.slice(2).join(" ") === "--prepare-only";
  check(
    process.argv.length === 2 || prepareOnly,
    "usage: check-previous-upgrade.mjs [--prepare-only]",
  );
  check(process.platform === "linux", "Linux only");
  check(/^\d+\.\d+\.\d+(-next\.\d+)?$/.test(from ?? ""), "set MEND_UPGRADE_FROM to a release");
  if (prepareOnly) {
    const pins = JSON.parse(await readFile(join(repo, "release/upgrade-from.json"), "utf8"));
    checkPins(pins, [from]);
    scratch = await mkdtemp(join(tmpdir(), "mend-previous-upgrade-"));
    env.npm_config_cache = join(scratch, "npm-cache");
    await installOldCli(pins.releases[from]);
    await fetchOldAssets(pins.releases[from]);
    await loadOldImages(pins.releases[from]);
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
  const pins = JSON.parse(await readFile(join(repo, "release/upgrade-from.json"), "utf8"));
  checkPins(pins, [from]);
  const pin = pins.releases[from];
  const context = (await docker(["context", "show"])).trim();
  assertFreshDocker(await snapshot());

  scratch = await mkdtemp(join(tmpdir(), "mend-previous-upgrade-"));
  const home = join(scratch, "home");
  await mkdir(home, { mode: 0o700 });
  env = isolatedClientEnvironment(process.env, home, process.env.DOCKER_CONFIG);
  env.npm_config_cache = join(scratch, "npm-cache");
  const oldBin = await installOldCli(pin);
  const oldAssets = await fetchOldAssets(pin);
  const oldImage = await loadOldImages(pin);
  console.log(`PASS ${from}: CLI, setup assets and images match release/upgrade-from.json`);

  stage = `${from} setup`;
  const [port, sshPort] = await freePorts(2);
  const origin = `http://127.0.0.1:${port}`;
  const oldCli = (args, options) =>
    run(process.execPath, [oldBin, ...args], { timeout: 600_000, ...options });
  // The old release's own flags (its scripts/check-packaged-server.mjs at its tag drove it so).
  await oldCli([
    "server",
    "setup",
    "--context",
    context,
    "--offline",
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
  console.log(`PASS ${from} set up offline by its own CLI from its own assets and images`);

  stage = `seed on ${from}`;
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
  // A Git fixture on the installation's network, served by the old Mend image's node.
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
  const mend = JSON.parse(
    await docker([
      "ps",
      "--filter",
      "label=com.docker.compose.service=mend",
      "--format",
      "{{json .}}",
    ]),
  );
  const network = lines(
    await docker([
      "inspect",
      mend.ID,
      "--format",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
    ]),
  )[0];
  const fixture = `mend-previous-upgrade-${runId}`;
  await docker([
    "create",
    "--name",
    fixture,
    "--network",
    network,
    "--entrypoint",
    "node",
    oldImage,
    "/fixture/packaged-git-fixture.mjs",
  ]);
  await docker(["cp", bare, `${fixture}:/fixture/repo.git`]);
  for (const name of ["packaged-git-fixture.mjs", "packaged-server-assertions.mjs"])
    await docker(["cp", join(repo, "scripts", name), `${fixture}:/fixture/${name}`]);
  await docker(["start", fixture]);
  const sourceUrl = `http://${fixture}:9080/repo.git`;
  await until(
    "the Git fixture",
    async () =>
      (
        await start(
          "docker",
          [
            "exec",
            fixture,
            "node",
            "-e",
            "fetch('http://127.0.0.1:9080/repo.git/HEAD').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          { environment: process.env },
        ).result
      ).ok,
  );
  const projectName = `upgrade-${runId.slice(0, 8)}`;
  await oldCli(["adopt", sourceUrl, "--name", projectName], { timeout: 180_000 });
  const project = (await api("/projects")).find((item) => item.name === projectName);
  check(project !== undefined, "the adopted project is not listed");
  // A plain base keeps the first session from building the default workspace image.
  await docker(["pull", "node:26-bookworm"], { timeout: 600_000 });
  const base = `${fixture}-base:latest`;
  await docker(["tag", "node:26-bookworm", base]);
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
  const command = `set -eu; git config user.name Upgrade; git config user.email upgrade@example.invalid; printf '%s\\n' '${marker}' > upgrade-proof.txt; git add upgrade-proof.txt; git commit -m 'upgrade proof'; sleep 20; printf '%s\\n' '${marker}'`;
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
      const shas = (worktree.checkpoints ?? []).map((item) => item.sha);
      return shas.some((sha) => sha !== baseSha) ? { ...current, shas } : false;
    },
    600_000,
  );
  check((await launched.result).ok, "mend run of the seeded session failed");
  const changeId = detail.change.id;
  const review = await api(`/changes/${changeId}/reviews/open`, {
    method: "POST",
    body: { idempotencyKey: `previous-upgrade-${runId}` },
  });
  const sliceId = review.slice?.id;
  check(typeof sliceId === "string", "opening Review returned no slice");
  const diff = await api(`/changes/${changeId}/reviews/${sliceId}/diff`);
  check(patchOf(diff).includes(marker), "the Review slice does not show the seeded change");
  const commentBody = `kept across the upgrade from ${from} (${runId})`;
  const comment = await api(`/changes/${changeId}/reviews/${sliceId}/comments`, {
    method: "POST",
    body: {
      target: {
        oldPath: null,
        newPath: "upgrade-proof.txt",
        side: "new",
        startLine: 1,
        endLine: 1,
        hunkContextHash: null,
      },
      body: commentBody,
    },
  });
  check(typeof comment.id === "string", "the comment was not recorded");
  const worktreeAfterReview = await api(`/worktrees/${detail.session.worktreeId}`);
  const before = {
    projectId: project.id,
    sessionId: session.id,
    checkpoints: (worktreeAfterReview.checkpoints ?? []).map((item) => item.sha),
    commentId: comment.id,
    commentBody,
    marker,
  };
  console.log(
    `PASS seeded on ${from}: account, project, session ${session.id}, ${before.checkpoints.length} checkpoints, a Review slice and a comment`,
  );

  if (derived) {
    console.log(
      `NOT TESTED the upgrade from ${from} to ${candidate}: ${candidate} is no release and orders below ${from}, so the CLI refuses it as a downgrade. The upgrade itself runs on a release candidate only.`,
    );
    return;
  }

  stage = `upgrade ${from} → ${candidate}`;
  const candidateDir = join(scratch, "candidate");
  await mkdir(candidateDir);
  await writeFile(join(candidateDir, "package.json"), JSON.stringify({ private: true }));
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", cliTarball], {
    cwd: candidateDir,
    timeout: 300_000,
  });
  const candidateBin = join(candidateDir, "node_modules/.bin/mend");
  const candidateCli = (args, options = {}) =>
    run(process.execPath, [candidateBin, ...args], { timeout: options.timeout ?? 600_000 });
  await runPackagedUpgrade(
    { version: candidate, assets: join(repo, "deploy/docker") },
    offline,
    candidateCli,
    async () => {},
  );
  await health(origin, candidate);
  const running = JSON.parse(
    await docker([
      "ps",
      "--filter",
      "label=com.docker.compose.service=mend",
      "--format",
      "{{json .}}",
    ]),
  );
  const inspected = JSON.parse(await docker(["inspect", running.ID]))[0];
  check(
    inspected.Image === candidateId,
    `the running server is ${inspected.Image}, not ${candidateId}`,
  );
  console.log(
    `PASS ${from} → ${candidate} by the candidate CLI; health and image are the candidate's`,
  );

  stage = `after the upgrade from ${from}`;
  const signin = await request(origin, "/auth/sign-in/email", {
    method: "POST",
    headers: { origin },
    body: { email, password },
  });
  check(signin.ok, `the seeded account cannot sign in (${signin.status})`);
  token = signin.headers.get("set-auth-token");
  check(typeof token === "string" && token.length > 0, "sign-in returned no bearer token");
  env.MEND_TOKEN = token;
  const after = {
    projects: await api("/projects"),
    sessionId: (await api(`/sessions/${session.id}`)).session?.id,
    checkpoints: ((await api(`/worktrees/${detail.session.worktreeId}`)).checkpoints ?? []).map(
      (item) => item.sha,
    ),
    comments: await api(`/changes/${changeId}/comments`),
    patch: patchOf(await api(`/changes/${changeId}/reviews/${sliceId}/diff`)),
  };
  const lost = seededStateProblems(before, {
    ...after,
    comments: Array.isArray(after.comments) ? after.comments : (after.comments.comments ?? []),
  });
  check(lost.length === 0, lost.join("; "));
  console.log(
    "PASS the seeded account, project, session, checkpoints and comment survived the upgrade",
  );
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
  await candidateCli(["server", "restart", ...(offline ? ["--offline"] : [])]);
  await health(origin, candidate);
  console.log("PASS a clean restart on the candidate");
  const manifest = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    candidateImage,
    "/app/migrations.txt",
  ]);
  const postgres = JSON.parse(
    await docker([
      "ps",
      "--filter",
      "label=com.docker.compose.service=postgres",
      "--format",
      "{{json .}}",
    ]),
  );
  const applied = lines(
    await docker([
      "exec",
      postgres.ID,
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
  console.log(`PASS Mend's ${applied.length} migrations are exactly the candidate's`);
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
