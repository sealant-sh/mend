// The stack's processes (`serve`, `up`, the watchdog) against a fake Docker daemon
// (fixtures/fake-docker.mjs): each case of the claim's lifecycle, with real processes, signals and
// timing, and no daemon. Builds always fail on the fake, so a start that gets past its claim ends
// there, which is what the failure cases need.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER_CONTAINER, STACK_LABEL, STATE_VOLUME } from "./lib.mjs";
import { CLAIM_LABEL } from "./lifecycle.mjs";

const stack = fileURLToPath(new URL("stack.mjs", import.meta.url));
const fake = fileURLToPath(new URL("fixtures/fake-docker.mjs", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A fake daemon holding `containers` and `volumes`, and a `docker` on PATH that speaks to it. */
function daemon({ containers = [], volumes = [], failLookups = 0, createDelayMs = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-stack-e2e-"));
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
  const failures = join(root, "fail-lookups");
  writeFileSync(failures, String(failLookups));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      `export FAKE_DOCKER_STATE='${state}'`,
      `export FAKE_DOCKER_FAIL_LOOKUPS='${failures}'`,
      `export FAKE_DOCKER_CREATE_DELAY_MS='${createDelayMs}'`,
      `export FAKE_DOCKER_CREATING='${join(root, "creating")}'`,
      `exec '${process.execPath}' '${fake}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, "home"),
    MEND_VERIFY_STACK_CACHE: join(root, "cache"),
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
  return { root, env, read, run, creating: join(root, "creating") };
}

const ownerOf = (state) => state.containers.find((item) => item.Name === `/${OWNER_CONTAINER}`);
const names = (state) => state.containers.map((item) => item.Name.slice(1)).toSorted();

async function until(what, probe, ms = 60_000) {
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

const firstStack = (claim) => [
  [OWNER_CONTAINER, { [STACK_LABEL]: "1", [CLAIM_LABEL]: claim }],
  ["verify-stack-relay", { [STACK_LABEL]: "1" }],
];

test("a refused serve leaves the stack that holds the claim alone, and starts no lasting watchdog (N1)", async () => {
  const fakeDaemon = daemon({ containers: firstStack("first-start") });
  const serve = fakeDaemon.run(["serve", "--no-check"]);
  const code = await serve.done;
  assert.notEqual(code, 0);
  assert.match(serve.output(), /already starting or up/);
  await sleep(3000);
  assert.deepEqual(names(fakeDaemon.read()), [OWNER_CONTAINER, "verify-stack-relay"].toSorted());
  assert.equal(ownerOf(fakeDaemon.read()).Config.Labels[CLAIM_LABEL], "first-start");
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve refused before claiming (a stack already up) leaves it alone too (N1)", async () => {
  const fakeDaemon = daemon({ containers: firstStack("first-start"), volumes: [STATE_VOLUME] });
  const serve = fakeDaemon.run(["serve", "--no-check"]);
  assert.notEqual(await serve.done, 0);
  assert.match(serve.output(), /already up/);
  await sleep(3000);
  assert.equal(names(fakeDaemon.read()).length, 2);
  assert.deepEqual(fakeDaemon.read().volumes, [STATE_VOLUME]);
  assert.deepEqual(watchdogsOf(serve.child.pid), []);
});

test("a serve killed while its claim is still being created is reaped once the claim lands (N2)", async () => {
  const fakeDaemon = daemon({ createDelayMs: 3000 });
  const serve = fakeDaemon.run(["serve", "--no-check"]);
  await until("the create in flight", () => {
    try {
      return readFileSync(fakeDaemon.creating, "utf8") === "1";
    } catch {
      return false;
    }
  });
  serve.child.kill("SIGKILL");
  // Judged by outcome, not by catching the claim between two looks: it lands, then goes.
  const log = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "logs/watchdog.log");
  await until("the watchdog to take the stack down", () => {
    try {
      return /the stack is down/.test(readFileSync(log, "utf8"));
    } catch {
      return false;
    }
  });
  assert.equal(fakeDaemon.read().next, 2, "the claim's create landed");
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
});

test("a watchdog retries a daemon that does not answer, and still takes its stack down (N2)", async () => {
  const fakeDaemon = daemon({
    containers: firstStack("mine"),
    volumes: [STATE_VOLUME],
    failLookups: 3,
  });
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const watchdog = fakeDaemon.run(["watchdog", String(supervisor.pid), "", "mine"]);
  supervisor.kill("SIGKILL");
  assert.equal(await watchdog.done, 0);
  assert.match(watchdog.output(), /owner lookup failed/);
  assert.match(watchdog.output(), /the stack is down/);
  assert.deepEqual(names(fakeDaemon.read()), []);
  assert.deepEqual(fakeDaemon.read().volumes, []);
});

test("an earlier start's watchdog leaves a replacement start's stack alone (N1)", async () => {
  const fakeDaemon = daemon({ containers: firstStack("replacement"), volumes: [STATE_VOLUME] });
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const watchdog = fakeDaemon.run(["watchdog", String(supervisor.pid), "", "earlier"]);
  supervisor.kill("SIGKILL");
  assert.equal(await watchdog.done, 0);
  assert.match(watchdog.output(), /another start's; nothing touched/);
  assert.equal(names(fakeDaemon.read()).length, 2);
  assert.deepEqual(fakeDaemon.read().volumes, [STATE_VOLUME]);
});

test("a cache entry that cannot be read is skipped, and a start failing after its claim removes it (N3)", async () => {
  const fakeDaemon = daemon();
  const contexts = join(fakeDaemon.env.MEND_VERIFY_STACK_CACHE, "contexts");
  mkdirSync(contexts, { recursive: true });
  symlinkSync(join(fakeDaemon.root, "nowhere"), join(contexts, "broken"));
  const up = fakeDaemon.run(["up", "--no-check", "--sealant", "pinned", "--sealantd", "pinned"]);
  assert.notEqual(await up.done, 0);
  assert.match(up.output(), /up failed; removing what it made/);
  const calls = readFileSync(`${join(fakeDaemon.root, "state.json")}.calls`, "utf8");
  assert.match(calls, /"create","--name","verify-stack-owner"/);
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  // The daemon is free for the next start.
  const again = fakeDaemon.run(["up", "--no-check", "--sealant", "pinned", "--sealantd", "pinned"]);
  await again.done;
  assert.doesNotMatch(again.output(), /already starting or up/);
});
