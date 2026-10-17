// Real processes and kernel locks against the isolated fake Docker daemon: what the daemon's lock
// holds off, and what a start is admitted to.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME } from "./lib.mjs";
import {
  pinned,
  volume,
  daemon,
  names,
  volumeNames,
  generation,
  until,
  waitingForDaemonLock,
  servingStart,
  callsOf,
  indexOfCall,
  ownerCreate,
  claimsMade,
} from "./lifecycle.e2e.helpers.mjs";

test("a teardown paused after its check holds the daemon: down is refused, a start waits (N4)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  fakeDaemon.seed("verify-stack-relay", { [STACK_LABEL]: "1" }, STATE_VOLUME);
  // The watchdog's teardown stops in its enumeration, holding the lock exclusively.
  writeFileSync(fakeDaemon.file("pause-list"), "1");
  serve.child.kill("SIGKILL");
  await until("the teardown to pause", () => existsSync(`${fakeDaemon.file("pause-list")}.paused`));
  // The orphaned build is still stalled when teardown gets its exclusive lock. Once this is
  // observed, let the build release its pipes; the replacement's fake build can then fail at once.
  rmSync(fakeDaemon.file("pause-build"));
  await serve.done;
  const down = fakeDaemon.run(["down"]);
  assert.notEqual(await down.done, 0);
  assert.match(down.output(), /stack is busy/);
  // A new start waits for the lock rather than being admitted beside the teardown.
  const before = claimsMade(fakeDaemon);
  const replacement = fakeDaemon.run(["up", ...pinned]);
  await waitingForDaemonLock(replacement);
  assert.equal(claimsMade(fakeDaemon), before, "no claim while the teardown runs");
  rmSync(fakeDaemon.file("pause-list"));
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  await replacement.done;
  const calls = callsOf(fakeDaemon);
  // The replacement claimed only after the teardown removed the first owner.
  const firstClaim = indexOfCall(calls, ownerCreate);
  const secondClaim = indexOfCall(calls, ownerCreate, firstClaim + 1);
  const lastRemoval = calls.findLastIndex(
    (args, index) => index < secondClaim && args[0] === "rm" && args.includes("--force"),
  );
  assert.ok(secondClaim > lastRemoval && lastRemoval > firstClaim, "teardown, then the new claim");
  assert.doesNotMatch(replacement.output(), /already (starting or )?up/);
});

test("an ownerless sweep holds the daemon: a start waits until it ends (N6)", async () => {
  const fakeDaemon = daemon({ volumes: [STATE_VOLUME] });
  fakeDaemon.seed("verify-stack-relay", { [STACK_LABEL]: "1" });
  writeFileSync(fakeDaemon.file("pause-list"), "1");
  const sweep = fakeDaemon.run(["down", "--force"]);
  await until("the sweep to pause", () => existsSync(`${fakeDaemon.file("pause-list")}.paused`));
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await waitingForDaemonLock(serve);
  assert.equal(indexOfCall(callsOf(fakeDaemon), ownerCreate), -1, "no claim during the sweep");
  rmSync(fakeDaemon.file("pause-list"));
  assert.equal(await sweep.done, 0, sweep.output());
  await serve.done;
  const calls = callsOf(fakeDaemon);
  const claimed = indexOfCall(calls, ownerCreate);
  const swept = calls.findLastIndex(
    (args) => args[0] === "volume" && args[1] === "rm" && args.includes(STATE_VOLUME),
  );
  assert.ok(claimed > swept, "the start claimed only after the sweep");
});

test("the state file goes before the owner, and nothing is admitted until the owner is gone (N9)", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
  mkdirSync(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, { recursive: true });
  writeFileSync(stateFile, "{}\n");
  writeFileSync(fakeDaemon.file("pause-rm"), OWNER_CONTAINER);
  const down = fakeDaemon.run(["down"]);
  await until("the owner's removal to pause", () =>
    existsSync(`${fakeDaemon.file("pause-rm")}.paused`),
  );
  assert.equal(existsSync(stateFile), false, "state removed before the owner");
  const replacement = fakeDaemon.run(["up", ...pinned]);
  await waitingForDaemonLock(replacement);
  assert.equal(indexOfCall(callsOf(fakeDaemon), ownerCreate), -1, "no claim before the owner goes");
  rmSync(fakeDaemon.file("pause-rm"));
  assert.equal(await down.done, 0, down.output());
  await replacement.done;
  assert.ok(indexOfCall(callsOf(fakeDaemon), ownerCreate) > 0);
});

test("a removal still running after its teardown was killed keeps the daemon until it ends (N12)", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  writeFileSync(fakeDaemon.file("pause-rm"), STATE_VOLUME);
  const first = fakeDaemon.run(["down"]);
  await until("the volume removal to pause", () =>
    existsSync(`${fakeDaemon.file("pause-rm")}.paused`),
  );
  // Kill only the teardown process; its Docker command lives on, and holds the lock.
  first.child.kill("SIGKILL");
  await first.done;
  const second = fakeDaemon.run(["down"]);
  assert.notEqual(await second.done, 0);
  assert.match(second.output(), /stack is busy/);
  const replacement = fakeDaemon.run(["up", ...pinned]);
  await waitingForDaemonLock(replacement);
  assert.equal(indexOfCall(callsOf(fakeDaemon), ownerCreate), -1, "no claim while it runs");
  // The removal ends; only then can anything else hold the daemon.
  rmSync(fakeDaemon.file("pause-rm"));
  await replacement.done;
  const calls = callsOf(fakeDaemon);
  const removed = calls.findIndex(
    (args) => args[0] === "volume" && args[1] === "rm" && args.includes(STATE_VOLUME),
  );
  assert.ok(indexOfCall(calls, ownerCreate) > removed, "the claim came after the removal");
});

test("report reads the stack and writes nothing", async () => {
  const fakeDaemon = daemon();
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  const stateFile = join(cache, "stack.json");
  const written = `${JSON.stringify({
    version: 1,
    phase: "ready",
    sources: {},
    phases: { ready: 1 },
    relay: { host: "127.0.0.1", port: 3305 },
    url: "http://localhost:3305",
    rootless: false,
    images: { mend: "m", cli: "c" },
  })}\n`;
  writeFileSync(stateFile, written);
  const report = fakeDaemon.run(["report", "--json"]);
  assert.equal(await report.done, 0, report.output());
  const json = JSON.parse(report.output());
  assert.equal(json.phase, "ready");
  // What each named image is, recorded even when no container shows it (Core's, the fixture's).
  assert.deepEqual(
    json.ran.map((item) => [item.service, item.image, "hub" in item ? item.hub : "not Hub's"]),
    [
      ["mend", "m", "not Hub's"],
      ["cli", "c", "not Hub's"],
      // MEND_VERIFY_DOCKER_HUB=off: Docker Hub does not answer.
      ["fixture", "node:26-bookworm", null],
    ],
  );
  assert.equal(readFileSync(stateFile, "utf8"), written);
});

test("the lock lives in a private directory of the caller's, in a file only they can open (N14)", async () => {
  const fakeDaemon = daemon();
  const locks = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "locks");
  const first = fakeDaemon.run(["down", "--force"]);
  assert.equal(await first.done, 0, first.output());
  const [lock] = readdirSync(locks);
  assert.equal(statSync(locks).mode & 0o777, 0o700);
  assert.equal(statSync(join(locks, lock)).mode & 0o777, 0o600);

  // A directory others can write to is refused, and so is a symlink in its place.
  chmodSync(locks, 0o777);
  const open = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await open.done, 0);
  assert.match(open.output(), /private to them \(0700\)/);
  rmSync(locks, { recursive: true });
  const elsewhere = join(fakeDaemon.root, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, locks);
  const linked = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await linked.done, 0);
  assert.match(linked.output(), /no symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);

  // A lock file that is a symlink is not followed.
  rmSync(locks);
  mkdirSync(locks, { mode: 0o700 });
  symlinkSync(join(fakeDaemon.root, "target"), join(locks, lock));
  const followed = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await followed.done, 0);
  assert.equal(existsSync(join(fakeDaemon.root, "target")), false);
});

/** Each call the fake daemon received, with whether it carried the stack's lock. */

const locksOf = (fakeDaemon) =>
  readFileSync(`${join(fakeDaemon.root, "state.json")}.locks`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("a pull never carries the lock, so one left stalled does not hold the daemon (N16)", async () => {
  const fakeDaemon = daemon();
  writeFileSync(fakeDaemon.file("pause-pull"), "1");
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the pull to stall", () => existsSync(`${fakeDaemon.file("pause-pull")}.paused`));
  serve.child.kill("SIGKILL");
  await serve.done;
  // The stalled pull lives on; the daemon is free for a teardown all the same.
  const down = fakeDaemon.run(["down", "--force"]);
  assert.equal(await down.done, 0, down.output());
  rmSync(fakeDaemon.file("pause-pull"));
  const calls = locksOf(fakeDaemon);
  const pulls = calls.filter((call) => call.args[0] === "pull");
  assert.ok(pulls.length > 0);
  assert.ok(
    pulls.every((call) => !call.lock),
    "no pull carries the lock",
  );
  const lookups = calls.filter((call) =>
    ["ps", "inspect", "info", "version"].includes(call.args[0]),
  );
  assert.ok(
    lookups.every((call) => !call.lock),
    "no lookup carries the lock",
  );
});

test("every removal a teardown runs carries the lock (N16)", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const removals = locksOf(fakeDaemon).filter(
    (call) => call.args[0] === "rm" || (call.args[0] === "volume" && call.args[1] === "rm"),
  );
  assert.ok(removals.length >= 2);
  assert.ok(
    removals.every((call) => call.lock),
    "every removal carries the lock",
  );
});

// A public up that reaches offline setup. The downstream HTTP refusal is deliberate: this
// fixture verifies orchestration and command boundaries, not a working inner Mend installation.

async function orchestrationRun(t, guardPullFailure, { held = {}, env = {} } = {}) {
  const guard = "example.invalid/guard:fixture";
  const fakeDaemon = daemon({
    build: "success",
    orchestration: { guard, guardPullFailure },
    images: Object.fromEntries(
      Object.entries(held).map(([tag, RepoDigests]) => [
        tag,
        { Id: `sha256:held-${tag}`, Labels: {}, RepoDigests },
      ]),
    ),
    env,
    containers: [["ordinary-container", { purpose: "ordinary" }]],
    volumes: [volume("ordinary-volume", { purpose: "ordinary" })],
    networks: [
      { Id: "ordinary-network-id", Name: "ordinary-network", Labels: { purpose: "ordinary" } },
    ],
  });
  const repository = fakeDaemon.file("mend-source");
  mkdirSync(join(repository, "apps/cli"), { recursive: true });
  mkdirSync(join(repository, "deploy/docker"), { recursive: true });
  writeFileSync(join(repository, "apps/cli/package.json"), '{"version":"1.2.3"}\n');
  for (const file of [
    "Dockerfile",
    "deploy/docker/compose.v2.yaml",
    "deploy/docker/compose.mirrors.yaml",
  ])
    writeFileSync(join(repository, file), readFileSync(new URL(`../../${file}`, import.meta.url)));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    ["add", "."],
    ["commit", "-qm", "owned source"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: repository,
      env: fakeDaemon.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      // Never retain the generated password. The request is synthetic and always refused.
      requests.push({
        method: request.method,
        url: request.url,
        origin: request.headers.origin,
        email: body.email,
        name: body.name,
        passwordValid: /^[0-9a-f]{64}$/.test(body.password),
      });
      response
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":"synthetic downstream account boundary"}');
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500).end();
    }
  });
  let running;
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    if (
      running !== undefined &&
      running.child.exitCode === null &&
      running.child.signalCode === null
    ) {
      assert.ok(Number.isSafeInteger(running.child.pid) && running.child.pid > 0);
      running.child.kill("SIGKILL");
      await running.done;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  // The public option reserves 10,000 above the relay port for the server's port.
  let port = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
    if (port <= 55_535) break;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(server.listening && port > 1024 && port <= 55_535);
  running = fakeDaemon.run([
    "up",
    ...pinned,
    "--mend",
    repository,
    "--packages",
    "npm",
    "--port",
    String(port),
  ]);
  timer = setTimeout(() => {
    assert.ok(Number.isSafeInteger(running.child.pid) && running.child.pid > 0);
    running.child.kill("SIGKILL");
  }, 30_000);
  const code = await running.done;
  clearTimeout(timer);
  assert.equal(running.child.signalCode, null, running.output());
  assert.deepEqual(failures, []);
  return { fakeDaemon, code, output: running.output(), requests, guard, port };
}

/** A Docker Hub that names `digests[repository:tag]` for a tag, and knows no other. */
async function fakeHub(t, digests) {
  const hub = createServer((request, response) => {
    if (request.url.startsWith("/token")) return response.end('{"token":"t"}');
    const match = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(request.url);
    const digest = match && digests[`${match[1]}:${match[2]}`];
    if (!digest) return response.writeHead(404).end();
    response.writeHead(200, { "docker-content-digest": digest }).end();
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  t.after(() => new Promise((resolve) => hub.close(resolve)));
  return `http://127.0.0.1:${hub.address().port}`;
}

const pullsOf = (result) =>
  callsOf(result.fakeDaemon)
    .filter((args) => args[0] === "pull")
    .map((args) => args.at(-1))
    .toSorted();
const others = (result) => [
  "dxflrs/garage:v2.4.1",
  "nginx:1.29-alpine",
  "registry:3.1",
  result.guard,
];

test("a held image is reused, not pulled, and said when Docker Hub cannot confirm it", async (t) => {
  const result = await orchestrationRun(t, false, {
    held: { "node:26-bookworm": [], "postgres:17-alpine": ["postgres@sha256:p"] },
  });
  assert.deepEqual(pullsOf(result), others(result).toSorted());
  assert.match(
    result.output,
    /held node:26-bookworm sha256:held-node:26-bookworm \(loaded, no repo digest\) · Docker Hub did not answer/,
  );
  assert.match(result.output, /held postgres:17-alpine sha256:p · Docker Hub did not answer/);
});

test("a held copy Docker Hub has moved past is said, and pulled only with MEND_VERIFY_REFRESH_IMAGES=1", async (t) => {
  const hub = await fakeHub(t, {
    "library/node:26-bookworm": "sha256:new",
    "library/postgres:17-alpine": "sha256:p",
  });
  const held = {
    "node:26-bookworm": ["node@sha256:old"],
    "postgres:17-alpine": ["postgres@sha256:p"],
  };
  const kept = await orchestrationRun(t, false, { held, env: { MEND_VERIFY_DOCKER_HUB: hub } });
  assert.deepEqual(pullsOf(kept), others(kept).toSorted());
  assert.match(kept.output, /held node:26-bookworm sha256:old · Hub has sha256:new\n/);
  assert.doesNotMatch(kept.output, /held postgres/, "a copy Docker Hub names is reused quietly");

  const refreshed = await orchestrationRun(t, false, {
    held,
    env: { MEND_VERIFY_DOCKER_HUB: hub, MEND_VERIFY_REFRESH_IMAGES: "1" },
  });
  assert.deepEqual(pullsOf(refreshed), [...others(refreshed), "node:26-bookworm"].toSorted());
  assert.match(
    refreshed.output,
    /held node:26-bookworm sha256:old · Hub has sha256:new · pulled \(MEND_VERIFY_REFRESH_IMAGES=1\)/,
  );
});

for (const guardPullFailure of [false, true]) {
  test(`public up accepts builds and ${guardPullFailure ? "refuses offline setup after guard preload failure" : "reaches offline setup before the deliberate downstream HTTP503 boundary"}`, async (t) => {
    const result = await orchestrationRun(t, guardPullFailure);
    assert.equal(result.code, 1, result.output);
    const calls = callsOf(result.fakeDaemon);
    const builds = calls.filter((args) => args[0] === "build");
    assert.equal(builds.length, 2);
    const cliBuild = builds.find((args) =>
      args[args.indexOf("--tag") + 1].startsWith("mend-verify/mend-cli:"),
    );
    const bundleBuild = builds.find((args) =>
      args[args.indexOf("--tag") + 1].startsWith("ghcr.io/sealant-sh/mend:1.2.3-verify.t"),
    );
    assert.ok(cliBuild);
    assert.ok(bundleBuild);
    assert.equal(cliBuild[cliBuild.indexOf("--file") + 1], "-");
    assert.equal(
      bundleBuild[bundleBuild.indexOf("--file") + 1],
      join(bundleBuild.at(-1), "Dockerfile"),
    );
    assert.equal(
      cliBuild.at(-1),
      bundleBuild.at(-1),
      "both builds use the same resolved real Git source context",
    );
    const built = result.fakeDaemon.read().builds;
    assert.equal(built.length, 2);
    assert.ok(
      built
        .find(({ tag }) => tag.startsWith("mend-verify/mend-cli:"))
        .input.includes("COPY --from=mend-build /pack /pack"),
    );
    const version = bundleBuild[bundleBuild.indexOf("--tag") + 1].split(":").at(-1);
    assert.match(version, /^1\.2\.3-verify\.t[0-9a-f]{12}$/);
    assert.ok(bundleBuild.includes(`MEND_VERSION=${version}`));
    // Independent literal shipped image inventory; do not use composeImages to derive this oracle.
    const pulls = calls.filter((args) => args[0] === "pull");
    assert.deepEqual(
      pulls.map((args) => args.at(-1)).toSorted(),
      [
        "node:26-bookworm",
        "dxflrs/garage:v2.4.1",
        "nginx:1.29-alpine",
        "postgres:17-alpine",
        "registry:3.1",
        result.guard,
      ].toSorted(),
    );
    assert.ok(pulls.every((args) => args.length === 3 && args[1] === "--quiet"));
    const label = calls.findIndex(
      (args) =>
        args[0] === "image" &&
        args.at(-1) === bundleBuild[bundleBuild.indexOf("--tag") + 1] &&
        args.includes('{{index .Config.Labels "dev.sealant.mend.network-guard-image"}}'),
    );
    const guardInspect = calls.findIndex(
      (args) => args[0] === "image" && args.at(-1) === result.guard,
    );
    const guardPull = calls.findIndex((args) => args[0] === "pull" && args.at(-1) === result.guard);
    assert.ok(label > calls.indexOf(cliBuild) && label > calls.indexOf(bundleBuild));
    assert.ok(guardInspect > label && guardPull > guardInspect);
    const setup = calls.findIndex(
      (args) =>
        args[0] === "run" &&
        args.includes("server") &&
        args[args.indexOf("server") + 1] === "setup",
    );
    if (guardPullFailure) {
      assert.equal(setup, -1);
      assert.deepEqual(result.requests, []);
      assert.match(result.output, /docker pull failed \(exit 44\)/);
    } else {
      assert.ok(setup > guardPull);
      for (const pull of pulls) assert.ok(calls.indexOf(pull) < setup);
      const args = calls[setup];
      const image = cliBuild[cliBuild.indexOf("--tag") + 1];
      assert.deepEqual(args.slice(args.indexOf(image) + 1), [
        "server",
        "setup",
        "--docker-socket",
        "/var/run/docker.sock",
        "--version",
        version,
        "--assets-dir",
        "/opt/mend-assets",
        "--offline",
        "--port",
        String(result.port + 10_000),
        "--ssh-port",
        "2222",
        "--url",
        `http://localhost:${result.port}`,
        "--origin",
        `http://127.0.0.1:${result.port}`,
      ]);
      assert.ok(args.includes("HOME=/fake/volumes/verify-stack-state/_data/server"));
      assert.ok(
        args.includes("XDG_CONFIG_HOME=/fake/volumes/verify-stack-state/_data/server/.config"),
      );
      assert.ok(args.includes("verify-stack-state:/fake/volumes/verify-stack-state/_data"));
      assert.ok(args.includes("/var/run/docker.sock:/var/run/docker.sock"));
      const relay = calls.findIndex(
        (argv) => argv[0] === "run" && argv.includes("verify-stack-relay"),
      );
      assert.ok(relay > setup);
      assert.deepEqual(result.requests, [
        {
          method: "POST",
          url: "/api/auth/sign-up/email",
          origin: `http://localhost:${result.port}`,
          email: "verifier@verify-stack.invalid",
          name: "Verifier",
          passwordValid: true,
        },
      ]);
      assert.match(result.output, /the inner server refused the first account \(HTTP 503\)/);
    }
    assert.deepEqual(names(result.fakeDaemon.read()), ["ordinary-container"]);
    assert.deepEqual(volumeNames(result.fakeDaemon.read()), ["ordinary-volume"]);
    assert.deepEqual(
      result.fakeDaemon.read().networks.map(({ Name }) => Name),
      ["ordinary-network"],
    );
  });
}
