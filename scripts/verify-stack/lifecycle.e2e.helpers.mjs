// The stack's processes (`serve`, `up`, `down`, the watchdog) against a fake Docker daemon
// (fixtures/fake-docker.mjs): each case of a generation's lifecycle, with real processes, signals,
// pauses, the real kernel lock (flock) and real timing, and no daemon. Builds fail on the fake (or
// hang, when a case needs a start that holds its claim), so a start that gets past its claim goes
// no further. Explicit orchestration cases opt into successful fake builds and stop at a local
// first-account HTTP refusal after observing offline setup; no real inner installation is run.
// Each Node test worker owns its daemon roots and cleanup. This module registers no tests.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
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
  images = {},
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
      ...(orchestration === null ? {} : { orchestration, images }),
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

export {
  pinned,
  volume,
  daemon,
  ownerOf,
  names,
  volumeNames,
  generation,
  until,
  watchdogsOf,
  waitingForDaemonLock,
  servingStart,
  callsOf,
  indexOfCall,
  ownerCreate,
  claimsMade,
  roots,
  COMPOSE,
  WORKING_DIR,
  STATE_MOUNT,
  on,
  mounts,
  product,
  productNames,
  ledgerDirOf,
  ledger,
  ledgerWindows,
  EXECUTOR,
  SIDECAR,
};
