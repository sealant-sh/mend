import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// The mirrors' own configuration, run for real: deploy/docker/npm-mirror.conf in nginx in front of a
// stand-in registry (so nothing here reaches the internet), and deploy/docker/docker-mirror-guard.sh
// in the registry image. Needs a Docker daemon; skipped without one.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const dockerAvailable = docker("info", "--format", "{{.ServerVersion}}").status === 0;
const skip = dockerAvailable ? false : "no Docker daemon";
const id = randomBytes(4).toString("hex");
const network = `mend-mirrors-test-${id}`;
const containers = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-mirrors-test-"));

after(() => {
  if (!dockerAvailable) return;
  for (const name of containers) docker("rm", "-f", "-v", name);
  docker("network", "rm", network);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const run = (name, ...args) => {
  const started = docker("run", "-d", "--name", name, "--network", network, ...args);
  assert.equal(started.status, 0, started.stderr);
  containers.push(name);
};

/** A request from inside the network: status, the mirror's cache header, and the body. */
const curl = (...args) => {
  const result = docker(
    "run",
    "--rm",
    "--network",
    network,
    "curlimages/curl:8.16.0",
    "-s",
    "-o",
    "/dev/stdout",
    "-w",
    "\n%{http_code} %header{x-mend-mirror}",
    ...args,
  );
  const lines = result.stdout.trimEnd().split("\n");
  const [code, cache = ""] = (lines.pop() ?? "").split(" ");
  return { code, cache, body: lines.join("\n") };
};

const until = (what, check, tries = 60) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (check()) return;
    spawnSync("sleep", ["1"]);
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("the npm mirror keys metadata by the whole request and caches tarballs", { skip }, () => {
  assert.equal(docker("network", "create", network).status, 0);
  // A stand-in registry that answers with the request it saw, so a cross-served answer shows.
  const upstream = path.join(scratch, "upstream.mjs");
  fs.writeFileSync(
    upstream,
    'import { createServer } from "node:http";\n' +
      "createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url })); }).listen(8080);\n",
  );
  run(
    `mend-mirrors-upstream-${id}`,
    "--network-alias",
    "upstream",
    "-v",
    `${upstream}:/upstream.mjs:ro`,
    "node:24-alpine",
    "node",
    "/upstream.mjs",
  );
  // The shipped configuration, with only its upstream swapped for the stand-in.
  const conf = fs
    .readFileSync(path.join(root, "deploy/docker/npm-mirror.conf"), "utf8")
    .replaceAll("proxy_pass https://$npm_registry;", "proxy_pass http://upstream:8080;");
  assert.ok(conf.includes("proxy_pass http://upstream:8080;"));
  const confFile = path.join(scratch, "npm-mirror.conf");
  fs.writeFileSync(confFile, conf);
  run(
    `mend-mirrors-npm-${id}`,
    "--network-alias",
    "npm-mirror",
    "-e",
    "NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1",
    "-e",
    "NPM_MIRROR_MAX_SIZE=1g",
    "-e",
    "NPM_MIRROR_MIN_FREE=1m",
    "-v",
    `${confFile}:/etc/nginx/templates/default.conf.template:ro`,
    "nginx:1.29-alpine",
  );
  until("the npm mirror", () => curl("http://npm-mirror:4873/-/ping").code === "200");

  const first = curl("http://npm-mirror:4873/-/v1/search?text=is-number&size=1");
  const second = curl("http://npm-mirror:4873/-/v1/search?text=express&size=1");
  assert.equal(first.cache, "MISS");
  assert.equal(second.cache, "MISS");
  assert.match(second.body, /text=express/);
  const again = curl("http://npm-mirror:4873/-/v1/search?text=is-number&size=1");
  assert.equal(again.cache, "HIT");
  assert.match(again.body, /text=is-number/);

  const tarball = "http://npm-mirror:4873/@scope/pkg/-/pkg-1.0.0.tgz";
  assert.equal(curl(tarball).cache, "MISS");
  assert.equal(curl(tarball).cache, "HIT");
  // Nothing is published through it.
  assert.equal(curl("-X", "PUT", "http://npm-mirror:4873/pkg").code, "403");
});

test(
  "the Docker mirror's guard clears the cache over its cap, pauses below its floor, and stops cleanly",
  { skip },
  () => {
    if (docker("network", "inspect", network).status !== 0) docker("network", "create", network);
    const guard = path.join(root, "deploy/docker/docker-mirror-guard.sh");
    const start = (name, maxSize, minFree) =>
      run(
        name,
        "--init",
        "--network-alias",
        name,
        "--entrypoint",
        "/bin/sh",
        "-e",
        `DOCKER_MIRROR_MAX_SIZE=${maxSize}`,
        "-e",
        `DOCKER_MIRROR_MIN_FREE=${minFree}`,
        "-e",
        "DOCKER_MIRROR_GUARD_INTERVAL=1",
        "-v",
        `${guard}:/mend/docker-mirror-guard.sh:ro`,
        "registry:3.1",
        "/mend/docker-mirror-guard.sh",
      );
    const state = (name) => docker("exec", name, "cat", "/tmp/mend-mirror-guard").stdout.trim();

    const capped = `mend-mirrors-cap-${id}`;
    start(capped, "5m", "1m");
    until("the registry", () => curl(`http://${capped}:5000/v2/`).code === "200");
    assert.equal(state(capped), "running");
    // Six MiB in the registry's own tree: over the five MiB cap.
    docker(
      "exec",
      capped,
      "sh",
      "-c",
      "mkdir -p /var/lib/registry/docker && head -c 6291456 /dev/zero > /var/lib/registry/docker/filler",
    );
    until(
      "the cache to be cleared",
      () => docker("exec", capped, "test", "-e", "/var/lib/registry/docker/filler").status !== 0,
    );
    until("the registry again", () => curl(`http://${capped}:5000/v2/`).code === "200");
    assert.match(docker("logs", capped).stderr, /over its 5 MiB cap: cleared/);

    const starved = `mend-mirrors-floor-${id}`;
    start(starved, "20g", "99999999m");
    until("the guard to pause", () => state(starved).startsWith("paused "));
    // Paused: nothing answers, so a session's daemon goes to Docker Hub itself.
    assert.equal(curl("--max-time", "3", `http://${starved}:5000/v2/`).code, "000");

    const stopped = docker("stop", "-t", "10", capped);
    assert.equal(stopped.status, 0);
    assert.equal(docker("inspect", capped, "--format", "{{.State.ExitCode}}").stdout.trim(), "0");
  },
);

test(
  "the Docker mirror's guard, started below its floor with a cache left over, clears it and resumes once there is room",
  { skip },
  () => {
    if (docker("network", "inspect", network).status !== 0) docker("network", "create", network);
    const guard = path.join(root, "deploy/docker/docker-mirror-guard.sh");
    // A volume holding a cache from before the restart, owned like the chart's (uid 1000).
    const volume = `mend-mirrors-retained-${id}`;
    assert.equal(docker("volume", "create", volume).status, 0);
    after(() => docker("volume", "rm", "-f", volume));
    const seeded = docker(
      "run",
      "--rm",
      "-v",
      `${volume}:/r`,
      "alpine:3.20",
      "sh",
      "-c",
      "mkdir -p /r/docker/registry && echo cached > /r/docker/registry/marker && echo '{}' > /r/scheduler-state.json && chown -R 1000:1000 /r",
    );
    assert.equal(seeded.status, 0, seeded.stderr);
    // A stand-in df ahead of busybox's on PATH: the free MiB it reports come from a file the
    // test writes, so the floor is crossed and recovered without filling a disk.
    const fakeDf = path.join(scratch, "df");
    fs.writeFileSync(
      fakeDf,
      '#!/bin/sh\nprintf "Filesystem 1M-blocks Used Available Capacity Mounted\\nfake 10000 0 %s 0%% /var/lib/registry\\n" "$(cat /tmp/fake-free 2>/dev/null || echo 1)"\n',
      { mode: 0o755 },
    );
    const name = `mend-mirrors-restart-${id}`;
    run(
      name,
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network-alias",
      name,
      "--entrypoint",
      "/bin/sh",
      "-e",
      "DOCKER_MIRROR_MAX_SIZE=20g",
      "-e",
      "DOCKER_MIRROR_MIN_FREE=100m",
      "-e",
      "DOCKER_MIRROR_GUARD_INTERVAL=1",
      "-v",
      `${guard}:/mend/docker-mirror-guard.sh:ro`,
      "-v",
      `${fakeDf}:/usr/local/bin/df:ro`,
      "-v",
      `${volume}:/var/lib/registry`,
      "registry:3.1",
      "/mend/docker-mirror-guard.sh",
    );
    const state = () => docker("exec", name, "cat", "/tmp/mend-mirror-guard").stdout.trim();
    // One MiB free, below the hundred MiB floor: the retained cache goes, and nothing serves.
    // Paused, and the second look found no cache left.
    until("the guard to pause with no cache held", () => state() === "paused 1 100 none");
    until(
      "the retained cache to be cleared",
      () =>
        docker(
          "exec",
          name,
          "sh",
          "-c",
          "test -e /var/lib/registry/docker || test -e /var/lib/registry/scheduler-state.json",
        ).status !== 0,
    );
    assert.match(docker("logs", name).stderr, /below 100 MiB: cache cleared, registry paused/);
    assert.equal(curl("--max-time", "3", `http://${name}:5000/v2/`).code, "000");
    // Room again: the registry starts on the next pass.
    docker("exec", name, "sh", "-c", "echo 5000 > /tmp/fake-free");
    until("the registry to resume", () => curl(`http://${name}:5000/v2/`).code === "200");
    assert.equal(state(), "running");
  },
);
