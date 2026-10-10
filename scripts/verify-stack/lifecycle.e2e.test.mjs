// The stack's processes (`serve`, `up`, `down`, the watchdog) against a fake Docker daemon
// (fixtures/fake-docker.mjs): each case of a generation's lifecycle, with real processes, signals,
// pauses, the real kernel lock (flock) and real timing, and no daemon. Builds fail on the fake (or
// hang, when a case needs a start that holds its claim), so a start that gets past its claim goes
// no further.
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

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME, digestOf } from "./lib.mjs";
import { CLAIM_LABEL } from "./lifecycle.mjs";

const stack = fileURLToPath(new URL("stack.mjs", import.meta.url));
const fake = fileURLToPath(new URL("fixtures/fake-docker.mjs", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pinned = ["--no-check", "--sealant", "pinned", "--sealantd", "pinned"];

/** Every fake daemon's directory: their watchdogs are stopped when the file's tests end. */
const roots = [];
after(() => {
  // Each fake daemon's lock file (stack.mjs `daemonLockPath`: its id is `FAKE:<state file>`).
  for (const root of roots)
    rmSync(
      `/tmp/mend-verify-stack-${digestOf(`FAKE:${join(root, "state.json")}`).slice(0, 16)}.lock`,
      {
        force: true,
      },
    );
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
      `export FAKE_DOCKER_PAUSE_RM='${file("pause-rm")}'`,
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
  assert.equal(fakeDaemon.watchdogLog().match(/teardown failed \(teardown exited 1\)/g)?.length, 3);
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
});

/** The calls the fake daemon received, in order. */
const callsOf = (fakeDaemon) =>
  readFileSync(`${join(fakeDaemon.root, "state.json")}.calls`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const indexOfCall = (calls, match, from = 0) =>
  calls.findIndex((args, index) => index >= from && match(args));
const ownerCreate = (args) => args[0] === "create" && args.includes(OWNER_CONTAINER);
const claimsMade = (fakeDaemon) => callsOf(fakeDaemon).filter(ownerCreate).length;

test("a teardown paused after its check holds the daemon: down is refused, a start waits (N4)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  fakeDaemon.seed("verify-stack-relay", { [STACK_LABEL]: "1" }, STATE_VOLUME);
  // The watchdog's teardown stops in its enumeration, holding the lock exclusively.
  writeFileSync(fakeDaemon.file("pause-list"), "1");
  serve.child.kill("SIGKILL");
  await until("the teardown to pause", () => existsSync(`${fakeDaemon.file("pause-list")}.paused`));
  const down = fakeDaemon.run(["down"]);
  assert.notEqual(await down.done, 0);
  assert.match(down.output(), /stack is busy/);
  // A new start waits for the lock rather than being admitted beside the teardown.
  const before = claimsMade(fakeDaemon);
  const replacement = fakeDaemon.run(["up", ...pinned]);
  await sleep(3000);
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
  await sleep(3000);
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

test("down while a serve builds is refused, and the serve's watchdog later takes it all down (N8)", async () => {
  const fakeDaemon = daemon({ build: "hang" });
  const serve = await servingStart(fakeDaemon);
  const down = fakeDaemon.run(["down"]);
  assert.notEqual(await down.done, 0);
  assert.match(down.output(), /Stop serve to cancel it/);
  assert.ok(ownerOf(fakeDaemon.read()), "the building generation is untouched");
  serve.child.kill("SIGKILL");
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.deepEqual(names(fakeDaemon.read()), []);
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
  await sleep(3000);
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
  await sleep(3000);
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
