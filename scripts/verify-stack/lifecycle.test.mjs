import assert from "node:assert/strict";
import { test } from "node:test";

import { OWNER_CONTAINER } from "./lib.mjs";
import { CLAIM_LABEL, claim, currentClaim, watch } from "./lifecycle.mjs";

/**
 * A daemon in memory: containers by name, and the commands lifecycle.mjs sends. `failures` makes
 * the next N commands fail as an unreachable daemon would; `onCreate` runs before a create lands.
 */
function fakeDocker({ failures = 0 } = {}) {
  const containers = new Map();
  let next = 1;
  const state = { failures, calls: [], onCreate: null };
  const add = (name, labels) => {
    const id = String(next++).padStart(64, "0");
    containers.set(name, { Id: id, Name: `/${name}`, Config: { Labels: labels } });
    return id;
  };
  const docker = async (args) => {
    state.calls.push(args);
    if (state.failures > 0) {
      state.failures -= 1;
      throw new Error("Cannot connect to the Docker daemon");
    }
    const [verb] = args;
    if (verb === "ps") {
      const filter = args[args.indexOf("--filter") + 1];
      const name = /^name=\^(.*)\$$/.exec(filter)?.[1];
      const item = containers.get(name);
      return item ? `${item.Id}\n` : "";
    }
    if (verb === "inspect")
      return JSON.stringify([...containers.values()].filter((item) => item.Id === args[1]));
    if (verb === "create") {
      if (state.onCreate) await state.onCreate();
      const name = args[args.indexOf("--name") + 1];
      if (containers.has(name))
        throw new Error(`Conflict. The container name "/${name}" is in use`);
      const labels = {};
      args.forEach((arg, index) => {
        if (args[index - 1] === "--label") {
          const [key, value] = arg.split("=");
          labels[key] = value;
        }
      });
      return add(name, labels);
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return {
    docker,
    state,
    containers,
    claimAs: (claimId) => add(OWNER_CONTAINER, { [CLAIM_LABEL]: claimId }),
  };
}

/** A clock that only moves when someone waits. */
function fakeClock() {
  let t = 0;
  return { now: () => t, pause: async (ms) => void (t += ms) };
}

const watching = (daemon, clock, overrides) => {
  const removed = [];
  const run = watch({
    docker: daemon.docker,
    alive: () => false,
    claimId: "mine",
    takeDown: async (owner) => {
      removed.push(owner.claim);
      daemon.containers.delete(OWNER_CONTAINER);
    },
    pause: clock.pause,
    now: clock.now,
    ...overrides,
  });
  return { run, removed };
};

test("the current claim: absent, present with its id and claim, and a failed lookup rejects", async () => {
  const daemon = fakeDocker();
  assert.deepEqual(await currentClaim(daemon.docker), { state: "absent" });
  const id = daemon.claimAs("start-a");
  assert.deepEqual(await currentClaim(daemon.docker), { state: "present", id, claim: "start-a" });
  daemon.state.failures = 1;
  await assert.rejects(currentClaim(daemon.docker), /Cannot connect/);
});

test("a claim is this start's, refused when another holds it, and never guessed after a failure", async () => {
  const daemon = fakeDocker();
  assert.equal(await claim(daemon.docker, { claimId: "a", image: "node" }), true);
  assert.equal(await claim(daemon.docker, { claimId: "b", image: "node" }), false);

  // A create that landed but whose reply was lost: the claim is there, and it is this start's.
  const lost = fakeDocker();
  const dropReply = async (args) => {
    const out = await lost.docker(args);
    if (args[0] === "create") throw new Error("connection reset");
    return out;
  };
  assert.equal(await claim(dropReply, { claimId: "c", image: "node" }), true);

  // A create that failed and left nothing behind is a failure, not a refusal.
  const down = fakeDocker({ failures: 1 });
  await assert.rejects(claim(down.docker, { claimId: "d", image: "node" }), /Cannot connect/);
});

test("a refused start's watchdog leaves the stack that holds the claim alone (N1)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("first-start");
  const clock = fakeClock();
  const { run, removed } = watching(daemon, clock);
  assert.equal(await run, "not-ours");
  assert.deepEqual(removed, []);
  assert.equal(daemon.containers.has(OWNER_CONTAINER), true);
});

test("an old watchdog leaves a replacement start's stack alone (N1)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("replacement");
  const clock = fakeClock();
  const { run, removed } = watching(daemon, clock, { claimId: "earlier-start" });
  assert.equal(await run, "not-ours");
  assert.deepEqual(removed, []);
});

test("a lookup that fails is retried, never taken for no claim (N2)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("mine");
  daemon.state.failures = 3;
  const clock = fakeClock();
  const logs = [];
  const { run, removed } = watching(daemon, clock, { log: (line) => logs.push(line) });
  assert.equal(await run, "taken-down");
  assert.deepEqual(removed, ["mine"]);
  assert.equal(logs.filter((line) => /lookup failed/.test(line)).length, 3);
});

test("a lookup that keeps failing past the wait for a claim still does not give up (N2)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("mine");
  daemon.state.failures = 20; // longer than appearWithinMs at the retry delays
  const clock = fakeClock();
  const { run, removed } = watching(daemon, clock, { appearWithinMs: 5000 });
  assert.equal(await run, "taken-down");
  assert.deepEqual(removed, ["mine"]);
});

test("a claim still in flight when the supervisor died is waited for, then reaped (N2)", async () => {
  const daemon = fakeDocker();
  const clock = fakeClock();
  let lookups = 0;
  const docker = async (args) => {
    // The create lands on the third look, after the supervisor is gone.
    if (args[0] === "ps" && ++lookups === 3) daemon.claimAs("mine");
    return daemon.docker(args);
  };
  const { run, removed } = watching(daemon, clock, { docker });
  assert.equal(await run, "taken-down");
  assert.deepEqual(removed, ["mine"]);
});

test("a start that never got a claim ends its watchdog after the bounded wait", async () => {
  const daemon = fakeDocker();
  const clock = fakeClock();
  const { run, removed } = watching(daemon, clock, { appearWithinMs: 10_000 });
  assert.equal(await run, "never-claimed");
  assert.deepEqual(removed, []);
  assert.ok(clock.now() >= 10_000);
});

test("a teardown that fails is retried until it is done", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("mine");
  const clock = fakeClock();
  let attempts = 0;
  const outcome = await watch({
    docker: daemon.docker,
    alive: () => false,
    claimId: "mine",
    takeDown: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("volume in use");
      daemon.containers.delete(OWNER_CONTAINER);
    },
    pause: clock.pause,
    now: clock.now,
  });
  assert.equal(outcome, "taken-down");
  assert.equal(attempts, 3);
});

test("nothing is looked at while the supervisor lives", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("mine");
  const clock = fakeClock();
  let checks = 0;
  const { run } = watching(daemon, clock, { alive: () => ++checks < 4 });
  assert.equal(await run, "taken-down");
  assert.equal(daemon.state.calls.filter((args) => args[0] === "ps").length, 1);
});
