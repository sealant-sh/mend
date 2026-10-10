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
  statSync,
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
      containers: containers.map(([name, labels, rest], index) =>
        container(`${String(9000 + index)}${"f".repeat(60)}`, name, labels, rest),
      ),
      volumes: volumes.map(asVolume),
      networks,
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
      // Whether this call carries the stack's lock: fd 9, inherited from the process that holds it.
      "if [ -e /proc/$$/fd/9 ]; then export FAKE_DOCKER_LOCK=1; else export FAKE_DOCKER_LOCK=0; fi",
      `export FAKE_DOCKER_STATE='${state}'`,
      `export FAKE_DOCKER_FAIL_LOOKUPS='${file("fail-lookups")}'`,
      `export FAKE_DOCKER_CREATE_DELAY_MS='${createDelayMs}'`,
      `export FAKE_DOCKER_CREATING='${file("creating")}'`,
      `export FAKE_DOCKER_PAUSE_LIST='${file("pause-list")}'`,
      `export FAKE_DOCKER_PAUSE_RM='${file("pause-rm")}'`,
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
  const seed = (name, labels, volumeName) => {
    const current = read();
    current.containers.push(
      container(`${String(8000 + current.containers.length)}${"e".repeat(60)}`, name, labels),
    );
    if (volumeName && !current.volumes.some((item) => item.Name === volumeName))
      current.volumes.push(asVolume(volumeName));
    writeFileSync(state, JSON.stringify(current));
  };
  return { root, env, file, read, run, watchdogLog, seed };
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
  assert.deepEqual(volumeNames(fakeDaemon.read()), [STATE_VOLUME]);
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
/** Write a recording window's ledger file into the stack's cache, as `recording` does. */
function ledger(fakeDaemon, entries, { closed = true } = {}) {
  const dir = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "ledger");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "window.json"),
    JSON.stringify({
      window: "window",
      startedAt: "2026-10-10T00:00:00Z",
      closed,
      containers: [],
      networks: [],
      volumes: [],
      ...entries,
    }),
  );
}
const ledgerWindows = (fakeDaemon) => {
  const dir = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "ledger");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    : [];
};

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
  assert.match(sweep.output(), /left alone, not recorded as the stack's: .*container mend-mend-1/);
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
    networks: [{ Name: "mend_default", Id: "net-inner" }],
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
  assert.match(down.output(), /volume mend-garage was made again after the stack recorded it/);
  assert.deepEqual(ledgerWindows(fakeDaemon), [], "the ledger goes with the stack");
});

test("an inner session made while `mend` runs is recorded, and a teardown removes it", async () => {
  const fakeDaemon = daemon({
    containers: generation("a"),
    volumes: [STATE_VOLUME, ...product.volumes.slice(2)],
  });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  writeFileSync(
    fakeDaemon.file("run"),
    JSON.stringify({
      containers: ["sealant-5e55", "sealant-5e55-docker"],
      volumes: ["sealant-5e55-home"],
      networks: ["sealant-5e55-network"],
    }),
  );
  const inner = fakeDaemon.run(["mend", "run", "--", "true"]);
  assert.equal(await inner.done, 0, inner.output());
  const [window] = ledgerWindows(fakeDaemon);
  assert.equal(window.closed, true);
  assert.equal(window.containers.length, 2);
  assert.deepEqual(
    window.volumes.map((item) => item.name),
    ["sealant-5e55-home"],
  );
  assert.equal(window.networks.length, 1);
  const down = fakeDaemon.run(["down"]);
  assert.equal(await down.done, 0, down.output());
  const left = fakeDaemon.read();
  assert.deepEqual(names(left), []);
  // What was there before the window, unrecorded and not the stack's own, stays.
  assert.deepEqual(volumeNames(left), volumeNames({ volumes: product.volumes.slice(2) }));
  assert.deepEqual(left.networks, []);
});

test("a recording cut short by a kill keeps what it saw, and says so", async () => {
  const fakeDaemon = daemon({ containers: generation("a"), volumes: [STATE_VOLUME] });
  const cache = fakeDaemon.env.MEND_VERIFY_STACK_CACHE;
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stack.json"), JSON.stringify({ images: { cli: "c" } }));
  writeFileSync(fakeDaemon.file("run"), JSON.stringify({ containers: ["sealant-5e55"] }));
  writeFileSync(fakeDaemon.file("pause-run"), "1");
  const inner = fakeDaemon.run(["mend", "run", "--", "sleep", "60"]);
  await until("the session to be recorded", () =>
    ledgerWindows(fakeDaemon).some((window) => window.containers.length === 1),
  );
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
