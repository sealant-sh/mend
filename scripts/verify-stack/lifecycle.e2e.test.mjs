// The stack's processes (`serve`, `up`, `down`, the watchdog) against a fake Docker daemon
// (fixtures/fake-docker.mjs): each case of a generation's lifecycle, with real processes, signals,
// pauses, the real kernel lock (flock) and real timing, and no daemon. Builds fail on the fake (or
// hang, when a case needs a start that holds its claim), so a start that gets past its claim goes
// no further. Explicit orchestration cases opt into successful fake builds and stop at a local
// first-account HTTP refusal after observing offline setup; no real inner installation is run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME, digestOf } from "./lib.mjs";
import { CLAIM_LABEL } from "./lifecycle.mjs";

const stack = fileURLToPath(new URL("stack.mjs", import.meta.url));
const fake = fileURLToPath(new URL("fixtures/fake-docker.mjs", import.meta.url));
const watchdogClock = new URL("fixtures/watchdog-clock.mjs", import.meta.url).href;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pinned = ["--no-check", "--sealant", "pinned", "--sealantd", "pinned"];

/**
 * Every fake daemon's directory (its state, its `docker`, the stack's cache and lock): when the
 * file's tests end, their watchdogs and stalled commands are stopped and the directories removed.
 */
const roots = [];
after(() => {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (roots.some((root) => environ.includes(root))) process.kill(Number(pid), "SIGKILL");
    } catch {
      // Gone, or not ours to read.
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A volume as `docker volume inspect` shows it. A name alone is one the stack made, labelled as it
 * labels its own; anything else passes `labels`.
 */
const volume = (
  name,
  labels = name.startsWith("verify-stack-") ? { [STACK_LABEL]: "1" } : {},
  createdAt = "2026-10-10T00:00:00Z",
) => ({
  Name: name,
  Labels: labels,
  Mountpoint: `/fake/volumes/${name}/_data`,
  CreatedAt: createdAt,
});
const asVolume = (item) => (typeof item === "string" ? volume(item) : item);
/** A container as `docker inspect` shows it; `rest` adds its mounts and networks. */
const container = (id, name, labels, rest = {}) => ({
  Id: id,
  Name: `/${name}`,
  Config: { Labels: labels },
  ...rest,
});

/**
 * A fake daemon holding `containers` (`[name, labels, rest]`), `volumes` (names or `volume(…)`)
 * and `networks` (`{ Id, Name }`), and a `docker` on PATH that speaks to it.
 */
function daemon({
  containers = [],
  volumes = [],
  networks = [],
  files = {},
  cache = null,
  failLookups = 0,
  pauseCreate = false,
  clock = false,
  build = "fail",
  orchestration = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-stack-e2e-"));
  roots.push(root);
  const state = join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      next: 1,
      containers: containers.map(([name, labels, rest], index) =>
        container(`${String(9000 + index)}${"f".repeat(60)}`, name, labels, rest),
      ),
      volumes: volumes.map(asVolume),
      networks,
      files,
      ...(orchestration === null ? {} : { orchestration, images: {} }),
    }),
  );
  const file = (name) => join(root, name);
  writeFileSync(file("fail-lookups"), String(failLookups));
  if (pauseCreate) writeFileSync(file("pause-create"), "1");
  if (build === "hang") writeFileSync(file("pause-build"), "1");
  const bin = file("bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      // Whether this call carries the stack's lock: fd 9, inherited from the process that holds it.
      "if [ -e /proc/$$/fd/9 ]; then export FAKE_DOCKER_LOCK=1; else export FAKE_DOCKER_LOCK=0; fi",
      `export FAKE_DOCKER_STATE='${state}'`,
      `export FAKE_DOCKER_FAIL_LOOKUPS='${file("fail-lookups")}'`,
      `export FAKE_DOCKER_PAUSE_CREATE='${file("pause-create")}'`,
      `export FAKE_DOCKER_CREATING='${file("creating")}'`,
      `export FAKE_DOCKER_PAUSE_BUILD='${file("pause-build")}'`,
      `export FAKE_DOCKER_PAUSE_LIST='${file("pause-list")}'`,
      `export FAKE_DOCKER_PAUSE_RM='${file("pause-rm")}'`,
      `export FAKE_DOCKER_FAIL_RM='${file("fail-rm")}'`,
      `export FAKE_DOCKER_FAIL_LEDGER_READ='${file("fail-ledger-read")}'`,
      `export FAKE_DOCKER_PAUSE_PULL='${file("pause-pull")}'`,
      `export FAKE_DOCKER_RUN='${file("run")}'`,
      `export FAKE_DOCKER_PAUSE_RUN='${file("pause-run")}'`,
      `export FAKE_DOCKER_BUILD='${build}'`,
      `exec '${process.execPath}' '${fake}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: file("home"),
    MEND_VERIFY_STACK_CACHE: cache ?? file("cache"),
    ...(clock
      ? { NODE_OPTIONS: `--import=${watchdogClock}`, MEND_VERIFY_STACK_TEST_CLOCK: root }
      : {}),
  };
  let sequence = 0;
  let clockTime = 0;
  const advanceClock = async (elapsedMs) => {
    assert.equal(clock, true, "this daemon must opt into the watchdog clock");
    sequence += 1;
    clockTime += elapsedMs;
    writeFileSync(file("request.json.next"), JSON.stringify({ sequence, elapsedMs }));
    renameSync(file("request.json.next"), file("request.json"));
    const acknowledgment = await until(
      "the watchdog clock acknowledgment",
      () => {
        if (!existsSync(file("acknowledgment.json"))) return false;
        const value = JSON.parse(readFileSync(file("acknowledgment.json"), "utf8"));
        return value.sequence === sequence ? value : false;
      },
      10_000,
    );
    assert.equal(acknowledgment.now, clockTime, "the watchdog crossed the requested time");
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
  const seed = (name, labels, volumeName) => {
    const current = read();
    current.containers.push(
      container(`${String(8000 + current.containers.length)}${"e".repeat(60)}`, name, labels),
    );
    if (volumeName && !current.volumes.some((item) => item.Name === volumeName))
      current.volumes.push(asVolume(volumeName));
    writeFileSync(state, JSON.stringify(current));
  };
  const docker = (args) => spawnSync(join(bin, "docker"), args, { env, encoding: "utf8" });
  return { root, env, file, read, run, watchdogLog, seed, docker, advanceClock };
}

const ownerOf = (state) => state.containers.find((item) => item.Name === `/${OWNER_CONTAINER}`);
const names = (state) => state.containers.map((item) => item.Name.slice(1)).toSorted();
const volumeNames = (state) => state.volumes.map((item) => item.Name).toSorted();
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

/** The kernel has blocked this start's flock child behind the teardown's exclusive lock. */
async function waitingForDaemonLock(start) {
  await until(
    "the start's shared flock to wait behind the teardown",
    () => {
      assert.equal(start.child.exitCode, null, start.output());
      assert.equal(start.child.signalCode, null, start.output());
      const blocked = [
        ...readFileSync("/proc/locks", "utf8").matchAll(
          /^\d+: -> FLOCK\s+ADVISORY\s+READ\s+(\d+)\s+/gm,
        ),
      ];
      return blocked.some(([, pid]) => {
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
          return parent === String(start.child.pid);
        } catch {
          // The blocked process may have exited between the two /proc reads.
          return false;
        }
      });
    },
    10_000,
  );
}

/** A `serve` that claims through its watchdog and then holds (its build hangs). */
async function servingStart(fakeDaemon) {
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the watchdog's claim", () => /claimed the daemon/.test(fakeDaemon.watchdogLog()));
  await until("the build to pause", () => existsSync(`${fakeDaemon.file("pause-build")}.paused`));
  return serve;
}

test("a refused serve leaves the generation that holds the daemon alone, and its watchdog goes (N1)", async () => {
  const fakeDaemon = daemon({ containers: generation("first-start") });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  assert.notEqual(await serve.done, 0);
  assert.match(serve.output(), /already starting or up/);
  await until(
    "the refused serve's watchdog to exit",
    () => watchdogsOf(serve.child.pid).length === 0,
  );
  assert.deepEqual(names(fakeDaemon.read()), [OWNER_CONTAINER, "verify-stack-relay"].toSorted());
  assert.equal(ownerOf(fakeDaemon.read()).Config.Labels[CLAIM_LABEL], "first-start");
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve refused before claiming (a stack already up) leaves it alone too (N1)", async () => {
  const fakeDaemon = daemon({ containers: generation("first-start"), volumes: [STATE_VOLUME] });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  assert.notEqual(await serve.done, 0);
  assert.match(serve.output(), /already up/);
  await until(
    "the refused serve's watchdog to exit",
    () => watchdogsOf(serve.child.pid).length === 0,
  );
  assert.equal(names(fakeDaemon.read()).length, 2);
  assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME]);
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve killed while its claim is being created is reaped once the claim lands (N2)", async () => {
  const fakeDaemon = daemon({ pauseCreate: true });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the create in flight", () => existsSync(fakeDaemon.file("creating")));
  serve.child.kill("SIGKILL");
  await serve.done;
  rmSync(fakeDaemon.file("pause-create"));
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
});

test("a claim held past 65 s on its watchdog's clock after serve dies still gets reaped (N5)", async () => {
  const fakeDaemon = daemon({ pauseCreate: true, clock: true });
  const serve = fakeDaemon.run(["serve", ...pinned]);
  await until("the create in flight", () => existsSync(fakeDaemon.file("creating")));
  serve.child.kill("SIGKILL");
  await serve.done;
  await fakeDaemon.advanceClock(2000);
  // The create stays in flight through the actual supervisor-death observation. No guessed
  // deadline decides that this start never claimed, and no second slow create delays re-admission.
  await until("the watchdog to observe its supervisor's death", () =>
    /the supervisor ended/.test(fakeDaemon.watchdogLog()),
  );
  // Cross the historical sixty-second abandonment threshold while create is still held.
  // The acknowledgment follows timer continuations, so a deadline cannot settle unnoticed.
  await fakeDaemon.advanceClock(65_000);
  assert.equal(ownerOf(fakeDaemon.read()), undefined, "the held claim has not landed");
  assert.equal(watchdogsOf(serve.child.pid).length, 1, "the pending claim still has its watchdog");
  assert.doesNotMatch(
    fakeDaemon.watchdogLog(),
    /this start never held a claim|nothing to take down|the stack is down/,
    "crossing 65 seconds must not settle a claim whose create is still held",
  );
  assert.equal(
    callsOf(fakeDaemon).some((args) => args[0] === "rm"),
    false,
  );
  rmSync(fakeDaemon.file("pause-create"));
  await until(
    "the watchdog to take the late claim down",
    () => /the stack is down/.test(fakeDaemon.watchdogLog()),
    10_000,
  );
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  assert.match(
    fakeDaemon.watchdogLog(),
    /the supervisor ended[\s\S]*claimed the daemon[\s\S]*the stack is down/,
  );
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
  rmSync(fakeDaemon.file("pause-build"));
  await serve.done;
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
  rmSync(fakeDaemon.file("pause-build"));
  await serve.done;
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

test("a broken cache symlink does not prevent failed-start cleanup or re-admission (N3)", async () => {
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

// ─── what a teardown may remove: the ledger; the private lock; what carries it ─

const COMPOSE = "com.docker.compose.project";
const WORKING_DIR = "com.docker.compose.project.working_dir";
const STATE_MOUNT = `/fake/volumes/${STATE_VOLUME}/_data`;
const on = (...networks) => ({
  NetworkSettings: {
    Networks: Object.fromEntries(networks.map(([name, id]) => [name, { NetworkID: id }])),
  },
});
const mounts = (...volumes) => ({
  Mounts: volumes.map((name) => ({ Type: "volume", Name: name, Destination: `/${name}` })),
});
/** An inner session as the inner Sealant makes it: its executor and its Docker sidecar. */
const EXECUTOR = ["sealant-5e55", {}, ["mend-control"]];
const SIDECAR = ["sealant-5e55-docker", { "sealant.workspace": "sealant-5e55" }];
/** A Mend server of the machine's own on the daemon: the product's names, none of the stack's. */
const product = {
  containers: [
    [
      "mend-mend-1",
      { [COMPOSE]: "mend", [WORKING_DIR]: "/home/someone/.config/mend/generations/3" },
      { ...mounts("mend-store", "mend_mend-postgres"), ...on(["mend_default", "net-product"]) },
    ],
    ["sealant-0a1b2c", {}, { ...mounts("mend-control"), ...on(["bridge", "net-bridge"]) }],
  ],
  volumes: [
    volume("mend-store"),
    volume("mend-control"),
    volume("mend-garage"),
    volume("mend_mend-postgres", { [COMPOSE]: "mend" }),
  ],
  networks: [{ Name: "mend_default", Id: "net-product" }],
};
const productNames = names({
  containers: product.containers.map(([name]) => ({ Name: `/${name}` })),
});
/** The fake daemon's ledger directory (stack.mjs `ledgerDirectory`: its id is `FAKE:<state>`). */
const ledgerDirOf = (fakeDaemon) =>
  join(
    fakeDaemon.env.MEND_VERIFY_STACK_CACHE,
    "ledger",
    digestOf(`FAKE:${join(fakeDaemon.root, "state.json")}`).slice(0, 16),
  );
/** Write a recording window's ledger file into the stack's cache, as `recording` does. */
function ledger(fakeDaemon, entries, { closed = true, window = "window" } = {}) {
  const dir = ledgerDirOf(fakeDaemon);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${window}.json`),
    JSON.stringify({
      window,
      startedAt: "2026-10-10T00:00:00Z",
      closed,
      containers: [],
      networks: [],
      volumes: [],
      ...entries,
    }),
    { mode: 0o600 },
  );
}
const ledgerWindows = (fakeDaemon) => {
  const dir = ledgerDirOf(fakeDaemon);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    : [];
};

for (const resource of [STATE_VOLUME, "sealant-5e55", "mend-store"]) {
  test(`a removal failure keeps the records for retry: ${resource}`, async () => {
    const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
    const fakeDaemon = daemon({
      containers: [...generation("retry-cleanup"), ["sealant-5e55", {}, mounts("mend-control")]],
      volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z")],
    });
    const owner = ownerOf(fakeDaemon.read());
    const recorded = fakeDaemon.read().containers.find((item) => item.Name === "/sealant-5e55");
    const entries = {
      containers: [recorded.Id],
      volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
      networks: [],
    };
    ledger(fakeDaemon, entries);
    const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
    const localLedger = readFileSync(ledgerFile, "utf8");
    const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
    const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
    writeFileSync(stateFile, savedState, { mode: 0o600 });
    const before = fakeDaemon.read();
    const volumeLedger = JSON.stringify(entries);
    before.files[copyPath] = volumeLedger;
    writeFileSync(fakeDaemon.file("state.json"), JSON.stringify(before));
    writeFileSync(fakeDaemon.file("fail-rm"), resource);

    const failed = fakeDaemon.run(["down"]);
    assert.notEqual(await failed.done, 0, failed.output());
    assert.match(
      failed.output(),
      /could not remove .*the ledger is kept, so the next down tries again/,
    );
    const remaining = fakeDaemon.read();
    assert.deepEqual(ownerOf(remaining), owner, "the same generation still holds the daemon");
    assert.ok(volumeNames(remaining).includes(STATE_VOLUME), "the retry state volume remains");
    if (resource === "sealant-5e55")
      assert.ok(
        remaining.containers.some((item) => item.Id === recorded.Id),
        "failed container remains",
      );
    else assert.ok(volumeNames(remaining).includes(resource), "failed volume remains");
    assert.equal(readFileSync(ledgerFile, "utf8"), localLedger, "the local ledger is unchanged");
    assert.equal(readFileSync(stateFile, "utf8"), savedState, "the local state is unchanged");
    assert.equal(remaining.files[copyPath], volumeLedger, "the volume ledger is unchanged");

    rmSync(fakeDaemon.file("fail-rm"));
    const retried = fakeDaemon.run(["down"]);
    assert.equal(await retried.done, 0, retried.output());
    assert.deepEqual(
      names(fakeDaemon.read()),
      [],
      "retry removed the owner and remaining containers",
    );
    assert.deepEqual(volumeNames(fakeDaemon.read()), [], "retry removed remaining volumes");
    assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false, "retry removed the local ledger");
    assert.equal(existsSync(stateFile), false, "retry removed the local state");
  });
}

for (const { args, owned } of [
  { args: ["down"], owned: true },
  { args: ["down", "--force"], owned: true },
  { args: ["down", "--force"], owned: false },
]) {
  test(
    `${args.join(" ")} refuses a failed ledger read before removal, then retries (${owned ? "owned" : "orphaned"})`,
    { timeout: 20_000 },
    async () => {
      const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
      const volumeLedger = JSON.stringify({
        containers: [],
        volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
        networks: ["recorded-network"],
      });
      const fakeDaemon = daemon({
        containers: [
          ...(owned
            ? generation("ledger-read-retry")
            : [["verify-stack-relay", { [STACK_LABEL]: "1" }]]),
          ["sealant-5e55", {}, mounts("mend-control")],
          ["person-database", {}],
        ],
        volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z"), "person-data"],
        networks: [{ Id: "recorded-network", Name: "sealant-5e55-network", Labels: {} }],
        files: { [copyPath]: volumeLedger },
      });
      const before = fakeDaemon.read();
      const recorded = before.containers.find((item) => item.Name === "/sealant-5e55");
      assert.ok(recorded, "fixture has the locally recorded executor");
      ledger(fakeDaemon, { containers: [recorded.Id] });
      const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
      const localLedger = readFileSync(ledgerFile, "utf8");
      const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
      const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
      writeFileSync(stateFile, savedState, { mode: 0o600 });
      writeFileSync(
        fakeDaemon.file("fail-ledger-read"),
        JSON.stringify({
          stdout: "partial-private-ledger-output",
          stderr: "private-ledger-read-error-token",
        }),
      );

      const failed = fakeDaemon.run(args);
      const code = await failed.done;
      const calls = readFileSync(fakeDaemon.file("state.json.calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        calls.filter(
          (call) => call[0] === "run" && call.some((arg) => arg.includes("/state/ledger.json")),
        ).length,
        1,
        "the state-volume read was attempted",
      );
      assert.equal(code, 1, failed.output());
      assert.match(
        failed.output(),
        /the state volume's ledger could not be read; nothing was removed/,
      );
      assert.match(failed.output(), /The ledger and state are kept, so the next down tries again/);
      assert.doesNotMatch(
        failed.output(),
        /partial-private-ledger-output|private-ledger-read-error-token/,
      );
      assert.deepEqual(
        calls.filter(
          (call) =>
            call[0] === "rm" || (["volume", "network"].includes(call[0]) && call[1] === "rm"),
        ),
        [],
        "no stack resource removal was attempted",
      );
      assert.deepEqual(
        fakeDaemon.read(),
        before,
        "every resource, owner and volume ledger remains unchanged",
      );
      assert.equal(readFileSync(ledgerFile, "utf8"), localLedger);
      assert.equal(readFileSync(stateFile, "utf8"), savedState);

      rmSync(fakeDaemon.file("fail-ledger-read"));
      const retried = fakeDaemon.run(args);
      assert.equal(await retried.done, 0, retried.output());
      const remaining = fakeDaemon.read();
      assert.deepEqual(names(remaining), ["person-database"]);
      assert.deepEqual(volumeNames(remaining), ["person-data"]);
      assert.deepEqual(remaining.networks, []);
      assert.equal(ownerOf(remaining), undefined);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
      assert.equal(existsSync(stateFile), false);
    },
  );
}

for (const args of [["down"], ["down", "--force"]]) {
  test(
    `${args.join(" ")} accepts a successful read with no state-volume ledger file`,
    { timeout: 20_000 },
    async () => {
      const fakeDaemon = daemon({
        containers: [...generation("absent-copy"), ["sealant-5e55", {}, mounts("mend-control")]],
        volumes: [STATE_VOLUME],
      });
      const recorded = fakeDaemon.read().containers.find((item) => item.Name === "/sealant-5e55");
      assert.ok(recorded);
      ledger(fakeDaemon, { containers: [recorded.Id] });
      const down = fakeDaemon.run(args);
      assert.equal(await down.done, 0, down.output());
      assert.deepEqual(names(fakeDaemon.read()), []);
      assert.deepEqual(volumeNames(fakeDaemon.read()), []);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
    },
  );
}

test(
  "the ledger reader's production shell distinguishes real file absence from inaccessible or nonregular paths",
  { timeout: 20_000 },
  async () => {
    const fakeDaemon = daemon({ containers: generation("shell-reader"), volumes: [STATE_VOLUME] });
    const down = fakeDaemon.run(["down"]);
    assert.equal(await down.done, 0, down.output());
    const readers = callsOf(fakeDaemon).filter(
      (args) =>
        args[0] === "run" &&
        args.includes("--entrypoint") &&
        args.some((arg) => arg.includes("/state/ledger.json")),
    );
    assert.equal(readers.length, 1);
    const script = readers[0].at(-1);
    const root = mkdtempSync(join(tmpdir(), "verify-stack-ledger-shell-"));
    roots.push(root);
    chmodSync(root, 0o755);
    const cases = [
      "absent",
      "regular",
      "unreadable-file",
      "unsearchable-directory",
      "unreadable-directory",
      "directory",
      "broken-symlink",
      "symlink",
      "empty",
      "whitespace",
    ];
    const results = [];
    for (const kind of cases) {
      const directory = join(root, kind);
      const file = join(directory, "ledger.json");
      mkdirSync(directory, { mode: 0o755 });
      if (
        ["regular", "unreadable-file", "unsearchable-directory", "unreadable-directory"].includes(
          kind,
        )
      )
        writeFileSync(file, "{}\n", { mode: 0o644 });
      if (kind === "unreadable-file") chmodSync(file, 0o000);
      if (kind === "unsearchable-directory") chmodSync(directory, 0o644);
      if (kind === "unreadable-directory") chmodSync(directory, 0o111);
      if (kind === "directory") mkdirSync(file);
      if (kind === "broken-symlink") symlinkSync(join(directory, "missing"), file);
      if (kind === "symlink") {
        writeFileSync(join(directory, "target"), "{}\n", { mode: 0o644 });
        symlinkSync(join(directory, "target"), file);
      }
      if (kind === "empty") writeFileSync(file, "", { mode: 0o644 });
      if (kind === "whitespace") writeFileSync(file, " \n", { mode: 0o644 });
      try {
        // Only substitute the mount's path. The reader script itself is the real CLI's argv.
        const result = spawnSync(
          "sh",
          ["-c", script.replaceAll("/state", '"$1"'), "ledger-reader", directory],
          {
            encoding: "utf8",
            timeout: 5000,
            env: { PATH: process.env.PATH, LC_ALL: "C" },
            ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
          },
        );
        assert.equal(result.error, undefined);
        results.push({ kind, status: result.status, stdout: result.stdout });
      } finally {
        chmodSync(directory, 0o755);
      }
    }
    assert.deepEqual(
      results,
      cases.map((kind) => ({
        kind,
        status: ["absent", "regular", "empty", "whitespace"].includes(kind) ? 0 : 1,
        stdout:
          kind === "absent"
            ? '{"containers":[],"volumes":[],"networks":[]}\n'
            : kind === "regular"
              ? "{}\n"
              : kind === "whitespace"
                ? " \n"
                : "",
      })),
    );
  },
);

for (const [kind, copy] of [
  ["empty", ""],
  ["whitespace", " \n"],
  ["malformed-private", "private-data"],
]) {
  test(
    `a present ${kind} ledger copy refuses teardown and retains its records`,
    { timeout: 20_000 },
    async () => {
      const copyPath = `/fake/volumes/${STATE_VOLUME}/_data/ledger.json`;
      const fakeDaemon = daemon({
        containers: generation("invalid-copy"),
        volumes: [STATE_VOLUME],
        files: { [copyPath]: copy },
      });
      ledger(fakeDaemon, {});
      const ledgerFile = join(ledgerDirOf(fakeDaemon), "window.json");
      const beforeLedger = readFileSync(ledgerFile, "utf8");
      const stateFile = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "stack.json");
      const savedState = JSON.stringify({ daemon: ledgerDirOf(fakeDaemon).split("/").at(-1) });
      writeFileSync(stateFile, savedState, { mode: 0o600 });
      const before = fakeDaemon.read();
      const down = fakeDaemon.run(["down", "--force"]);
      assert.equal(await down.done, 1, down.output());
      assert.doesNotMatch(down.output(), /private-data/);
      assert.match(
        down.output(),
        /the state volume's ledger.json cannot be read \(invalid ledger JSON\); nothing was removed/,
      );
      assert.deepEqual(fakeDaemon.read(), before);
      assert.equal(readFileSync(ledgerFile, "utf8"), beforeLedger);
      assert.equal(readFileSync(stateFile, "utf8"), savedState);
      assert.deepEqual(
        callsOf(fakeDaemon).filter(
          (args) =>
            args[0] === "rm" || (["volume", "network"].includes(args[0]) && args[1] === "rm"),
        ),
        [],
      );
      // The printed recovery command moves the invalid copy aside instead of deleting its evidence.
      const repaired = fakeDaemon.read();
      repaired.files[`${copyPath}.bad`] = repaired.files[copyPath];
      delete repaired.files[copyPath];
      writeFileSync(fakeDaemon.file("state.json"), JSON.stringify(repaired));
      const retry = fakeDaemon.run(["down", "--force"]);
      assert.equal(await retry.done, 0, retry.output());
      assert.deepEqual(names(fakeDaemon.read()), []);
      assert.deepEqual(volumeNames(fakeDaemon.read()), []);
      assert.equal(existsSync(ledgerDirOf(fakeDaemon)), false);
      assert.equal(existsSync(stateFile), false);
    },
  );
}

test("down --force on a daemon with no stack of its own removes nothing of a product server (N13)", async () => {
  const fakeDaemon = daemon(product);
  const before = fakeDaemon.read();
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  assert.match(sweep.output(), /removed 0 container\(s\), 0 volume\(s\)/);
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), names(before));
  assert.deepEqual(volumeNames(left), volumeNames(before));
  assert.deepEqual(left.networks, before.networks);
  // Reported, with how to remove them by hand, and never touched.
  assert.match(
    sweep.output(),
    /left alone \(shaped like the stack's, but never recorded as made by it\): container mend-mend-1/,
  );
  assert.match(sweep.output(), /docker volume rm .*mend-store/);
});

test("down --force with no ledger removes only the stack's own infrastructure (N13)", async () => {
  const fakeDaemon = daemon({
    ...product,
    containers: [...product.containers, ["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [...product.volumes, STATE_VOLUME],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), productNames);
  assert.deepEqual(volumeNames(left), volumeNames(product));
  assert.deepEqual(left.networks, product.networks);
});

test("a Compose path under the state volume's Mountpoint proves nothing (N13a)", async () => {
  // A Compose client with a file system of its own wrote its file under the same path.
  const fakeDaemon = daemon({
    containers: [
      [
        "product-real-compose",
        { [COMPOSE]: "mend", [WORKING_DIR]: `${STATE_MOUNT}/product-generation` },
        mounts("product-real-compose-data"),
      ],
      [
        "product-traversal",
        { [COMPOSE]: "mend", [WORKING_DIR]: `${STATE_MOUNT}/../../product/generation` },
        mounts("product-traversal-data"),
      ],
    ],
    volumes: [STATE_VOLUME, "product-real-compose-data", "product-traversal-data"],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["product-real-compose", "product-traversal"]);
  assert.deepEqual(volumeNames(left), ["product-real-compose-data", "product-traversal-data"]);
});

test("a shared network pulls nothing in: not a product executor, its network or its data (N13b)", async () => {
  const shared = ["shared-product-network", "net-shared"];
  const fakeDaemon = daemon({
    containers: [
      ["verify-stack-relay", { [STACK_LABEL]: "1" }, on(shared)],
      [
        "sealant-22222222-2222-2222-2222-222222222222",
        {},
        { ...mounts("external-executor-data"), ...on(shared, ["product-network", "net-product"]) },
      ],
      ["product-unrelated", {}, on(["product-network", "net-product"])],
    ],
    volumes: ["external-executor-data", "product-shared-data"],
    networks: [
      { Name: "shared-product-network", Id: "net-shared" },
      { Name: "product-network", Id: "net-product" },
    ],
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), [
    "product-unrelated",
    "sealant-22222222-2222-2222-2222-222222222222",
  ]);
  assert.deepEqual(volumeNames(left), ["external-executor-data", "product-shared-data"]);
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["shared-product-network", "product-network"],
  );
});

test("a teardown removes the ledger's entries whose identity still matches, and nothing else (N13)", async () => {
  const fakeDaemon = daemon({
    containers: [
      ...generation("a"),
      ["mend-mend-1", { [COMPOSE]: "mend" }, on(["mend_default", "net-inner"])],
      ["sealant-5e55", {}, mounts("mend-control")],
      // On the inner network, never recorded: a container someone else attached.
      ["attached-later", {}, on(["mend_default", "net-inner"])],
    ],
    volumes: [
      STATE_VOLUME,
      volume("mend-store", {}, "2026-10-10T01:00:00Z"),
      volume("mend-control", {}, "2026-10-10T01:00:01Z"),
      // Recorded once, since removed and made again: another volume.
      volume("mend-garage", {}, "2026-10-10T03:00:00Z"),
      "unrecorded-data",
    ],
    networks: [{ Name: "mend_default", Id: "net-inner", Labels: { [COMPOSE]: "mend" } }],
  });
  const ids = Object.fromEntries(
    fakeDaemon.read().containers.map((item) => [item.Name.slice(1), item.Id]),
  );
  ledger(fakeDaemon, {
    containers: [ids["mend-mend-1"], ids["sealant-5e55"], "0".repeat(64)],
    networks: ["net-inner"],
    volumes: [
      { name: "mend-store", createdAt: "2026-10-10T01:00:00Z" },
      { name: "mend-control", createdAt: "2026-10-10T01:00:01Z" },
      { name: "mend-garage", createdAt: "2026-10-10T01:00:02Z" },
    ],
  });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["attached-later"]);
  assert.deepEqual(volumeNames(left), ["mend-garage", "unrecorded-data"]);
  assert.deepEqual(
    left.networks.map(({ Id, Name }) => ({ Id, Name })),
    [{ Id: "net-inner", Name: "mend_default" }],
  );
  assert.match(
    down.output(),
    /left network mend_default: something the stack did not make uses it/,
  );
  assert.doesNotMatch(down.output(), /removed network mend_default/);
  assert.match(down.output(), /made again after the stack recorded it\): volume mend-garage/);
  assert.match(down.output(), /removed container mend-mend-1/);
  assert.match(down.output(), /removed container sealant-5e55/);
  assert.deepEqual(ledgerWindows(fakeDaemon), [], "the ledger goes with the stack");
});

test("a `mend` window records an inner session, and nothing another client makes meanwhile (R7-1)", async () => {
  const fakeDaemon = daemon({
    containers: generation("a"),
    volumes: [STATE_VOLUME, ...product.volumes.slice(2)],
  });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  // While the window is open: an inner session, and the person's `pnpm dev` database beside it.
  writeFileSync(
    fakeDaemon.file("run"),
    JSON.stringify({
      containers: [EXECUTOR, SIDECAR, ["mend-dev-postgres-1", { [COMPOSE]: "mend-dev" }]],
      volumes: ["mend-dev_mend-dev-pgdata"],
      networks: ["sealant-5e55-network", "mend-dev_default"],
    }),
  );
  const inner = fakeDaemon.run(["mend", "run", "--", "true"]);
  assert.equal(await inner.done, 0, inner.output());
  const [window] = ledgerWindows(fakeDaemon);
  assert.equal(window.closed, true);
  assert.equal(window.containers.length, 2);
  assert.deepEqual(window.volumes, []);
  assert.equal(window.networks.length, 1);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), ["mend-dev-postgres-1"]);
  assert.deepEqual(
    volumeNames(left),
    volumeNames({ volumes: [...product.volumes.slice(2), volume("mend-dev_mend-dev-pgdata")] }),
  );
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["mend-dev_default"],
  );
  assert.match(down.output(), /removed container sealant-5e55 /);
  assert.match(down.output(), /removed network sealant-5e55-network/);
});

test("a recording cut short by a kill keeps what it saw, and says so", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  writeFileSync(fakeDaemon.file("run"), JSON.stringify({ containers: [EXECUTOR] }));
  writeFileSync(fakeDaemon.file("pause-run"), "1");
  const inner = fakeDaemon.run(["mend", "run", "--", "sleep", "60"]);
  await until("the session to be recorded", () =>
    ledgerWindows(fakeDaemon).some((window) => window.containers.length === 1),
  );
  // The window holds the daemon's lock shared: a `down` cannot race it (NIT-5).
  const busy = fakeDaemon.run(["down"]);
  assert.notEqual(await busy.done, 0);
  assert.match(busy.output(), /stack is busy/);
  inner.child.kill("SIGKILL");
  // The inner CLI's run holds the killed process's output open until it ends.
  rmSync(fakeDaemon.file("pause-run"));
  await inner.done;
  assert.equal(ledgerWindows(fakeDaemon)[0].closed, false);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.match(down.output(), /was cut short/);
});

/** An anonymous volume's name, as Docker makes one: 64 hex digits. */
const anonymous = (n) => `${String(n).repeat(8)}${"0".repeat(56)}`;

test("fake Docker refuses live network endpoints and mounted volumes, then removes released resources", () => {
  const fakeDaemon = daemon({
    containers: [["survivor", {}, { ...mounts("shared-data"), ...on(["shared", "net-shared"]) }]],
    volumes: ["shared-data", "unused-data"],
    networks: [
      { Id: "net-shared", Name: "shared" },
      { Id: "net-unused", Name: "unused" },
    ],
  });
  const inspected = fakeDaemon.docker(["network", "inspect", "net-shared"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(Object.values(JSON.parse(inspected.stdout)[0].Containers), [
    { Name: "survivor" },
  ]);
  const network = fakeDaemon.docker(["network", "rm", "net-shared", "net-unused"]);
  assert.equal(network.status, 1);
  assert.match(network.stderr, /active endpoints/);
  assert.deepEqual(
    fakeDaemon.read().networks.map(({ Id }) => Id),
    ["net-shared"],
  );
  for (const flags of [[], ["--force"]]) {
    const removal = fakeDaemon.docker(["volume", "rm", ...flags, "shared-data", "unused-data"]);
    assert.equal(removal.status, 1);
    assert.match(removal.stderr, /shared-data.*in use/);
    assert.deepEqual(volumeNames(fakeDaemon.read()), ["shared-data"]);
  }
  assert.equal(fakeDaemon.docker(["rm", "--force", "survivor"]).status, 0);
  assert.equal(fakeDaemon.docker(["network", "rm", "net-shared"]).status, 0);
  assert.equal(fakeDaemon.docker(["volume", "rm", "shared-data"]).status, 0);
  assert.deepEqual(fakeDaemon.read().networks, []);
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
});

test("fake Docker rm --volumes removes only unused anonymous mounts, preserving named and shared volumes", () => {
  const orphan = anonymous(3);
  const shared = anonymous(4);
  const namedHex = anonymous(5);
  const retained = anonymous(6);
  const fakeDaemon = daemon({
    containers: [
      ["removed", {}, mounts(orphan, shared, namedHex, "named-data")],
      ["survivor", {}, mounts(shared)],
      ["removed-without-volumes", {}, mounts(retained)],
    ],
    volumes: [
      { ...volume(orphan), Anonymous: true },
      { ...volume(shared), Anonymous: true },
      { ...volume(retained), Anonymous: true },
      namedHex,
      "named-data",
    ],
  });
  assert.equal(fakeDaemon.docker(["rm", "--force", "--volumes", "removed"]).status, 0);
  assert.deepEqual(names(fakeDaemon.read()), ["removed-without-volumes", "survivor"]);
  assert.deepEqual(
    volumeNames(fakeDaemon.read()),
    [shared, retained, namedHex, "named-data"].toSorted(),
  );
  assert.equal(fakeDaemon.docker(["rm", "--force", "removed-without-volumes"]).status, 0);
  assert.ok(volumeNames(fakeDaemon.read()).includes(retained));
});

test("a recorded volume still mounted by an unrecorded survivor keeps the ledger for retry", async () => {
  const fakeDaemon = daemon({
    containers: [
      ...generation("a"),
      ["sealant-5e55", {}, mounts("mend-control")],
      ["attached-later", {}, mounts("mend-control")],
    ],
    volumes: [STATE_VOLUME, volume("mend-control", {}, "2026-10-10T01:00:01Z")],
  });
  const recorded = fakeDaemon.read().containers.find(({ Name }) => Name === "/sealant-5e55");
  ledger(fakeDaemon, {
    containers: [recorded.Id],
    volumes: [{ name: "mend-control", createdAt: "2026-10-10T01:00:01Z" }],
  });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 1, down.output());
  assert.match(
    down.output(),
    /could not remove volume mend-control \(docker volume failed \(exit 1\)\)/,
  );
  assert.match(down.output(), /the ledger is kept, so the next down tries again/);
  assert.match(down.output(), /removed container sealant-5e55/);
  assert.deepEqual(names(fakeDaemon.read()), ["attached-later", OWNER_CONTAINER].toSorted());
  assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME, "mend-control"].toSorted());
  assert.equal(ledgerWindows(fakeDaemon).length, 1);
});

test("a Core dev stack of Compose project `sealant`, made during a `mend` window, survives (R8-1)", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  // While the window is open: an inner session, and the person's `docker compose up -d` in
  // /workspace/repos/sealant (Core's compose.yaml, project `sealant`; compose.selfhost.yaml, `name:
  // sealant`), a `sealant-ci` copy, and a hand-named `docker run --name sealant-test-redis`.
  writeFileSync(
    fakeDaemon.file("run"),
    JSON.stringify({
      containers: [
        EXECUTOR,
        SIDECAR,
        ["sealant-postgres-1", { [COMPOSE]: "sealant" }, ["sealant_postgres-data"]],
        ["sealant-cache-1", { [COMPOSE]: "sealant" }, [anonymous(1)]],
        ["sealant-web-1", { [COMPOSE]: "sealant" }],
        ["sealant-ci-postgres-1", { [COMPOSE]: "sealant-ci" }, ["sealant-ci_postgres-data"]],
        ["sealant-test-redis", {}, [anonymous(2)]],
      ],
      volumes: ["sealant_postgres-data", "sealant-ci_postgres-data", anonymous(1), anonymous(2)],
      networks: ["sealant-5e55-network", "sealant_default"],
    }),
  );
  const inner = fakeDaemon.run(["mend", "run", "--", "true"]);
  assert.equal(await inner.done, 0, inner.output());
  const [window] = ledgerWindows(fakeDaemon);
  assert.equal(window.containers.length, 2, "the executor and its sidecar only");
  assert.equal(window.networks.length, 1);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), [
    "sealant-cache-1",
    "sealant-ci-postgres-1",
    "sealant-postgres-1",
    "sealant-test-redis",
    "sealant-web-1",
  ]);
  assert.deepEqual(
    volumeNames(left),
    [anonymous(1), anonymous(2), "sealant-ci_postgres-data", "sealant_postgres-data"].toSorted(),
  );
  assert.deepEqual(
    left.networks.map((network) => network.Name),
    ["sealant_default"],
  );
  assert.doesNotMatch(down.output(), /removed container sealant-(cache|web|postgres|ci|test)/);
});

test("a window file that is a symlink is refused, and nothing is removed (NIT-7)", async () => {
  const fakeDaemon = daemon({
    containers: [["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [STATE_VOLUME],
  });
  ledger(fakeDaemon, {});
  const target = join(fakeDaemon.root, "planted.json");
  writeFileSync(target, "{}", { mode: 0o600 });
  rmSync(join(ledgerDirOf(fakeDaemon), "window.json"));
  symlinkSync(target, join(ledgerDirOf(fakeDaemon), "window.json"));
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await sweep.done, 0);
  assert.match(sweep.output(), /window\.json is a symlink, refused; nothing was removed/);
  assert.deepEqual(names(fakeDaemon.read()), ["verify-stack-relay"]);
});

test("a torn ledger copy in the state volume is refused with the command that moves it aside (NIT-6)", async () => {
  const fakeDaemon = daemon({
    containers: [["verify-stack-relay", { [STACK_LABEL]: "1" }]],
    volumes: [STATE_VOLUME],
    files: { [`/fake/volumes/${STATE_VOLUME}/_data/ledger.json`]: "{" },
  });
  const sweep = fakeDaemon.run(["down", "--force"]);
  assert.notEqual(await sweep.done, 0);
  assert.match(
    sweep.output(),
    /the state volume's ledger.json cannot be read .*nothing was removed/,
  );
  assert.match(
    sweep.output(),
    /docker run --rm --volume verify-stack-state:\/s \S+ mv \/s\/ledger\.json \/s\/ledger\.json\.bad/,
  );
  assert.deepEqual(names(fakeDaemon.read()), ["verify-stack-relay"]);
});

test("a volume the stack made twice under one name is removed whichever record is read first (R7-2)", async () => {
  const fakeDaemon = daemon({
    containers: generation("a"),
    volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T02:00:00Z")],
  });
  for (const [window, createdAt] of [
    ["a", "2026-10-10T01:00:00Z"],
    ["b", "2026-10-10T02:00:00Z"],
    ["c", "2026-10-10T00:30:00Z"],
  ])
    ledger(fakeDaemon, { volumes: [{ name: "mend-store", createdAt }] }, { window });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
});

test("a teardown on one daemon leaves another daemon's ledger alone (R7-3)", async () => {
  const first = daemon({
    containers: [...generation("a"), ["sealant-5e55", {}, mounts("mend-control")]],
    volumes: [STATE_VOLUME],
  });
  const ids = Object.fromEntries(
    first.read().containers.map((item) => [item.Name.slice(1), item.Id]),
  );
  ledger(first, { containers: [ids["sealant-5e55"]] });
  // Another daemon, the same cache directory.
  const second = daemon({ cache: first.env.MEND_VERIFY_STACK_CACHE });
  const sweep = second.run(["down", "--force"]);
  assert.equal(await sweep.done, 0, sweep.output());
  assert.equal(ledgerWindows(first).length, 1, "the first daemon's ledger stays");
  const down = first.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(first.read()), []);
});

test("a ledger that is planted, open to others or unreadable removes nothing (NIT-2, NIT-3)", async () => {
  const setup = () => {
    const fakeDaemon = daemon({
      containers: [
        ["verify-stack-relay", { [STACK_LABEL]: "1" }],
        ["sealant-5e55", {}, mounts("mend-control")],
      ],
      volumes: [STATE_VOLUME],
    });
    const id = fakeDaemon.read().containers[1].Id;
    ledger(fakeDaemon, { containers: [id] });
    return fakeDaemon;
  };
  const untouched = async (fakeDaemon, pattern) => {
    const sweep = fakeDaemon.run(["down", "--force"]);
    assert.notEqual(await sweep.done, 0);
    assert.match(sweep.output(), pattern);
    assert.deepEqual(names(fakeDaemon.read()), ["sealant-5e55", "verify-stack-relay"]);
    assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME]);
  };
  // A directory in the ledger's place that is a symlink.
  const linked = setup();
  const elsewhere = join(linked.root, "elsewhere");
  renameSync(ledgerDirOf(linked), elsewhere);
  symlinkSync(elsewhere, ledgerDirOf(linked));
  await untouched(linked, /no symlink/);
  // A window file others can write.
  const open = setup();
  chmodSync(join(ledgerDirOf(open), "window.json"), 0o666);
  await untouched(open, /window\.json must be this user's own file/);
  // A window file that is not JSON: the error names it.
  const torn = setup();
  writeFileSync(join(ledgerDirOf(torn), "window.json"), "{", { mode: 0o600 });
  await untouched(torn, /the ledger in .*window\.json cannot be read/);
});

test("the ledger is this cache's windows and the state volume's copy, merged (NIT-4)", async () => {
  const fakeDaemon = daemon({
    containers: [...generation("a"), ["sealant-5e55", {}, mounts("mend-control")]],
    volumes: [STATE_VOLUME, volume("mend-store", {}, "2026-10-10T01:00:00Z")],
    files: {
      [`/fake/volumes/${STATE_VOLUME}/_data/ledger.json`]: JSON.stringify({
        containers: [],
        networks: [],
        volumes: [{ name: "mend-store", createdAt: "2026-10-10T01:00:00Z" }],
      }),
    },
  });
  ledger(fakeDaemon, { containers: [fakeDaemon.read().containers.at(-1).Id] });
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.deepEqual(volumeNames(fakeDaemon.read()), []);
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
async function orchestrationRun(t, guardPullFailure) {
  const guard = "example.invalid/guard:fixture";
  const fakeDaemon = daemon({
    build: "success",
    orchestration: { guard, guardPullFailure },
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
