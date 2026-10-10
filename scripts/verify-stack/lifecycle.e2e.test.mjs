// The stack's processes (`serve`, `up`, `down`, the watchdog) against a fake Docker daemon
// (fixtures/fake-docker.mjs): each case of a generation's lifecycle, with real processes, signals,
// pauses and timing, and no daemon. Builds fail on the fake (or hang, when a case needs a start
// that holds its claim), so a start that gets past its claim goes no further.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME } from "./lib.mjs";
import { CLAIM_LABEL } from "./lifecycle.mjs";

const stack = fileURLToPath(new URL("stack.mjs", import.meta.url));
const fake = fileURLToPath(new URL("fixtures/fake-docker.mjs", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pinned = ["--no-check", "--sealant", "pinned", "--sealantd", "pinned"];

/** Every fake daemon's directory: their watchdogs are stopped when the file's tests end. */
const roots = [];
after(() => {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (roots.some((root) => environ.includes(`MEND_VERIFY_STACK_CACHE=${join(root, "cache")}`)))
        process.kill(Number(pid), "SIGKILL");
    } catch {
      // Gone, or not ours to read.
    }
  }
});

/** A fake daemon holding `containers` and `volumes`, and a `docker` on PATH that speaks to it. */
function daemon({
  containers = [],
  volumes = [],
  failLookups = 0,
  createDelayMs = 0,
  build = "fail",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-stack-e2e-"));
  roots.push(root);
  const state = join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      next: 1,
      containers: containers.map(([name, labels], index) => ({
        Id: `${String(9000 + index)}${"f".repeat(60)}`,
        Name: `/${name}`,
        Config: { Labels: labels },
      })),
      volumes,
      networks: [],
    }),
  );
  const file = (name) => join(root, name);
  writeFileSync(file("fail-lookups"), String(failLookups));
  const bin = file("bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      `export FAKE_DOCKER_STATE='${state}'`,
      `export FAKE_DOCKER_FAIL_LOOKUPS='${file("fail-lookups")}'`,
      `export FAKE_DOCKER_CREATE_DELAY_MS='${createDelayMs}'`,
      `export FAKE_DOCKER_CREATING='${file("creating")}'`,
      `export FAKE_DOCKER_PAUSE_LIST='${file("pause-list")}'`,
      `export FAKE_DOCKER_PAUSE_LOCK='${file("pause-lock")}'`,
      `export FAKE_DOCKER_BUILD='${build}'`,
      `exec '${process.execPath}' '${fake}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: file("home"),
    MEND_VERIFY_STACK_CACHE: file("cache"),
  };
  const read = () => JSON.parse(readFileSync(state, "utf8"));
  const run = (args) => {
    const child = spawn(process.execPath, [stack, ...args], { env, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const done = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    return { child, done, output: () => output };
  };
  const watchdogLog = () => {
    try {
      return readFileSync(join(env.MEND_VERIFY_STACK_CACHE, "logs/watchdog.log"), "utf8");
    } catch {
      return "";
    }
  };
  /** Add a container (and a volume) to the daemon, as another process would. */
  const seed = (name, labels, volume) => {
    const current = read();
    current.containers.push({
      Id: `${String(8000 + current.containers.length)}${"e".repeat(60)}`,
      Name: `/${name}`,
      Config: { Labels: labels },
    });
    if (volume && !current.volumes.includes(volume)) current.volumes.push(volume);
    writeFileSync(state, JSON.stringify(current));
  };
  return { root, env, file, read, run, watchdogLog, seed };
}

const ownerOf = (state) => state.containers.find((item) => item.Name === `/${OWNER_CONTAINER}`);
const names = (state) => state.containers.map((item) => item.Name.slice(1)).toSorted();
const generation = (claim) => [
  [OWNER_CONTAINER, { [STACK_LABEL]: "1", [CLAIM_LABEL]: claim }],
  ["verify-stack-relay", { [STACK_LABEL]: "1" }],
];

async function until(what, probe, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Process ids of the watchdogs a supervisor `pid` started, from /proc. */
function watchdogsOf(pid) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
        return argv.includes("watchdog") && argv.includes(String(pid));
      } catch {
        return false;
      }
    });
}

/** A `serve` that claims through its watchdog and then holds (its build hangs). */
async function servingStart(fakeDaemon) {
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the watchdog's claim", () => /claimed the daemon/.test(fakeDaemon.watchdogLog()));
  return serve;
}

test("a refused serve leaves the generation that holds the daemon alone, and its watchdog goes (N1)", async () => {
  const fakeDaemon = daemon({ containers: generation("first-start") });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  assert.notEqual(await serve.done, 0);
  assert.match(serve.output(), /already starting or up/);
  await sleep(3000);
  assert.deepEqual(names(fakeDaemon.read()), [OWNER_CONTAINER, "verify-stack-relay"].toSorted());
  assert.equal(ownerOf(fakeDaemon.read()).Config.Labels[CLAIM_LABEL], "first-start");
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve refused before claiming (a stack already up) leaves it alone too (N1)", async () => {
  const fakeDaemon = daemon({ containers: generation("first-start"), volumes: [STATE_VOLUME] });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  assert.notEqual(await serve.done, 0);
  assert.match(serve.output(), /already up/);
  await sleep(3000);
  assert.equal(names(fakeDaemon.read()).length, 2);
  assert.deepEqual(fakeDaemon.read().volumes, [STATE_VOLUME]);
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve killed while its claim is being created is reaped once the claim lands (N2)", async () => {
  const fakeDaemon = daemon({ createDelayMs: 3000 });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the create in flight", () => existsSync(fakeDaemon.file("creating")));
  serve.child.kill("SIGKILL");
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
});

test("a claim that lands 65 s after its serve was killed still gets its watchdog (N5)", async () => {
  const fakeDaemon = daemon({ createDelayMs: 65_000 });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the create in flight", () => existsSync(fakeDaemon.file("creating")));
  serve.child.kill("SIGKILL");
  await until(
    "the watchdog to take the late claim down",
    () => /the stack is down/.test(fakeDaemon.watchdogLog()),
    150_000,
  );
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  // The daemon is free: the next start is not refused by an orphaned claim.
  const next = fakeDaemon.run(["up", ...pinned]);
  await next.done;
  assert.doesNotMatch(next.output(), /already starting or up/);
});

test("a watchdog retries a daemon that does not answer, and still takes its generation down (N2)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  writeFileSync(fakeDaemon.file("fail-lookups"), "3");
  serve.child.kill("SIGKILL");
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.equal(fakeDaemon.watchdogLog().match(/teardown failed \(docker ps failed/g)?.length, 3);
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
});

test("a teardown paused after its check keeps the generation: no down, no replacement meanwhile (N4)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  fakeDaemon.seed("verify-stack-relay", { [STACK_LABEL]: "1" }, STATE_VOLUME);
  // The watchdog stops in its enumeration, after it took its lock and checked its claim.
  writeFileSync(fakeDaemon.file("pause-list"), "1");
  serve.child.kill("SIGKILL");
  await until("the watchdog's teardown to pause", () =>
    existsSync(`${fakeDaemon.file("pause-list")}.paused`),
  );
  // An ordinary down meets the teardown under way and touches nothing.
  const down = fakeDaemon.run(["down"]);
  assert.notEqual(await down.done, 0);
  assert.match(down.output(), /teardown of this stack is under way/);
  // A replacement cannot be admitted: the generation still holds the daemon.
  const replacement = fakeDaemon.run(["up", ...pinned]);
  assert.notEqual(await replacement.done, 0);
  assert.match(replacement.output(), /already (starting or )?up/);
  rmSync(fakeDaemon.file("pause-list"));
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.deepEqual(fakeDaemon.read().volumes, []);
});

test("a teardown that gets its lock after a down and a replacement touches nothing (N4)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  // The watchdog stops before it holds its lock.
  writeFileSync(fakeDaemon.file("pause-lock"), "1");
  serve.child.kill("SIGKILL");
  await until("the watchdog to pause before its lock", () =>
    existsSync(`${fakeDaemon.file("pause-lock")}.paused`),
  );
  // An ordinary down takes the generation down; a replacement is admitted and builds.
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  fakeDaemon.seed(OWNER_CONTAINER, { [STACK_LABEL]: "1", [CLAIM_LABEL]: "replacement" });
  fakeDaemon.seed("verify-stack-relay", { [STACK_LABEL]: "1" }, STATE_VOLUME);
  writeFileSync(`${fakeDaemon.file("pause-lock")}.release`, "1");
  await until("the stale watchdog to finish", () =>
    /another start's; nothing touched/.test(fakeDaemon.watchdogLog()),
  );
  assert.equal(ownerOf(fakeDaemon.read()).Config.Labels[CLAIM_LABEL], "replacement");
  assert.deepEqual(names(fakeDaemon.read()), [OWNER_CONTAINER, "verify-stack-relay"].toSorted());
  assert.deepEqual(fakeDaemon.read().volumes, [STATE_VOLUME]);
});

test("a cache entry that cannot be read is skipped, and a start failing after its claim removes it (N3)", async () => {
  const fakeDaemon = daemon();
  const contexts = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "contexts");
  mkdirSync(contexts, { recursive: true });
  symlinkSync(join(fakeDaemon.root, "nowhere"), join(contexts, "broken"));
  const up = fakeDaemon.run(["up", ...pinned]);
  assert.notEqual(await up.done, 0);
  assert.match(up.output(), /up failed; removing what it made/);
  const calls = readFileSync(`${join(fakeDaemon.root, "state.json")}.calls`, "utf8");
  assert.match(calls, /"create","--name","verify-stack-owner"/);
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  const again = fakeDaemon.run(["up", ...pinned]);
  await again.done;
  assert.doesNotMatch(again.output(), /already starting or up/);
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
  assert.equal(JSON.parse(report.output()).phase, "ready");
  assert.equal(readFileSync(stateFile, "utf8"), written);
});
