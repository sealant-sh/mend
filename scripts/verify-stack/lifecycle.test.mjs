import assert from "node:assert/strict";
import { test } from "node:test";

import { OWNER_CONTAINER } from "./lib.mjs";
import {
  CLAIM_LABEL,
  HOLDER_LABEL,
  TEARDOWN_PREFIX,
  claim,
  currentClaim,
  removeGeneration,
  settleClaim,
  watch,
} from "./lifecycle.mjs";

/**
 * A daemon in memory: containers by name, and the commands lifecycle.mjs sends. `failures` makes
 * the next N commands fail as an unreachable daemon would.
 */
function fakeDocker({ failures = 0 } = {}) {
  const containers = new Map();
  let next = 1;
  const state = { failures, calls: [] };
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
      const name = /^name=\^(.*)\$$/.exec(args[args.indexOf("--filter") + 1])?.[1];
      const item = containers.get(name);
      return item ? `${item.Id}\n` : "";
    }
    if (verb === "inspect")
      return JSON.stringify([...containers.values()].filter((item) => item.Id === args[1]));
    if (verb === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (containers.has(name))
        throw new Error(`Conflict. The container name "/${name}" is in use`);
      const labels = {};
      args.forEach((arg, index) => {
        if (args[index - 1] === "--label") {
          const at = arg.indexOf("=");
          labels[arg.slice(0, at)] = arg.slice(at + 1);
        }
      });
      return add(name, labels);
    }
    if (verb === "rm") {
      for (const [name, item] of containers) if (args.includes(item.Id)) containers.delete(name);
      return "";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return {
    docker,
    state,
    containers,
    claimAs: (claimId) => add(OWNER_CONTAINER, { [CLAIM_LABEL]: claimId }),
    lockAs: (claimId, holder) => add(`${TEARDOWN_PREFIX}${claimId}`, { [HOLDER_LABEL]: holder }),
  };
}

/** A clock that only moves when someone waits. */
function fakeClock() {
  let t = 0;
  return { now: () => t, pause: async (ms) => void (t += ms) };
}

/** A teardown of `claimId` on `daemon` that records what it removed. */
function teardown(daemon, claimId, { holderAlive = () => false, onRemove } = {}) {
  const removed = [];
  const run = () =>
    removeGeneration({
      docker: daemon.docker,
      claimId,
      image: "node",
      holder: "100:1",
      holderAlive,
      removeResources: async (ownerId) => {
        if (onRemove) await onRemove();
        removed.push(ownerId);
        for (const [name, item] of daemon.containers)
          if (item.Id === ownerId) daemon.containers.delete(name);
      },
    });
  return { run, removed };
}

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

test("a teardown removes its own generation, under its lock, and releases the lock", async () => {
  const daemon = fakeDocker();
  const owner = daemon.claimAs("a");
  const { run, removed } = teardown(daemon, "a");
  assert.equal(await run(), "removed");
  assert.deepEqual(removed, [owner]);
  assert.equal(daemon.containers.size, 0, "owner and lock both gone");
});

test("a teardown of another generation touches nothing (N1)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("replacement");
  const { run, removed } = teardown(daemon, "earlier");
  assert.equal(await run(), "not-ours");
  assert.deepEqual(removed, []);
  assert.deepEqual([...daemon.containers.keys()], [OWNER_CONTAINER]);
});

test("two teardowns of one generation never overlap: the second waits its turn (N4)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("a");
  let release;
  const held = new Promise((done) => (release = done));
  const first = teardown(daemon, "a", { onRemove: () => held });
  const firstRun = first.run();
  // Let the first take its lock and reach its removal.
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  const second = teardown(daemon, "a", { holderAlive: (holder) => holder === "100:1" });
  assert.equal(await second.run(), "busy");
  // Meanwhile no replacement can be admitted: the owner still stands.
  assert.equal(await claim(daemon.docker, { claimId: "b", image: "node" }), false);
  release();
  assert.equal(await firstRun, "removed");
  assert.deepEqual(second.removed, []);
});

test("a stale teardown that gets the lock after a replacement was admitted touches nothing (N4)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("a");
  // An earlier teardown of `a` finished; `b` was admitted; then the stale one of `a` runs.
  assert.equal(await teardown(daemon, "a").run(), "removed");
  daemon.claimAs("b");
  const stale = teardown(daemon, "a");
  assert.equal(await stale.run(), "not-ours");
  assert.deepEqual(stale.removed, []);
  assert.deepEqual([...daemon.containers.keys()], [OWNER_CONTAINER]);
});

test("a lock left by a holder that is gone is cleared and taken", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("a");
  daemon.lockAs("a", "999:1");
  const { run, removed } = teardown(daemon, "a", { holderAlive: () => false });
  assert.equal(await run(), "removed");
  assert.equal(removed.length, 1);
  assert.equal(daemon.containers.size, 0);
});

test("a claim's outcome is waited for however long its create takes (N5)", async () => {
  const daemon = fakeDocker();
  const clock = fakeClock();
  let land;
  const attempt = new Promise((done) => (land = done));
  const settling = settleClaim({
    attempt,
    docker: daemon.docker,
    claimId: "a",
    pause: clock.pause,
  });
  // No deadline: the create lands whenever it lands.
  setTimeout(() => land(true), 50);
  assert.equal(await settling, true);
  assert.equal(await settleClaim({ attempt: null, docker: daemon.docker, claimId: "a" }), false);
});

test("a claim whose outcome is unknown is decided by the daemon, asked until it answers (N2)", async () => {
  const daemon = fakeDocker();
  daemon.claimAs("a");
  daemon.state.failures = 4;
  const clock = fakeClock();
  const settled = await settleClaim({
    attempt: Promise.reject(new Error("docker create timed out")),
    docker: daemon.docker,
    claimId: "a",
    pause: clock.pause,
  });
  assert.equal(settled, true);
});

test("a watchdog waits for the supervisor, then for the claim, then tears down until done", async () => {
  const clock = fakeClock();
  let checks = 0;
  const outcomes = ["busy", "failed", "removed"];
  const order = [];
  const outcome = await watch({
    alive: () => ++checks < 3,
    claimed: async () => {
      order.push("claimed");
      return true;
    },
    remove: async () => {
      order.push("remove");
      const next = outcomes.shift();
      if (next === "failed") throw new Error("volume in use");
      return next;
    },
    pause: clock.pause,
  });
  assert.equal(outcome, "taken-down");
  assert.deepEqual(order, ["claimed", "remove", "remove", "remove"]);
});

test("a watchdog whose start never claimed, or whose generation is gone or another's, stops", async () => {
  const clock = fakeClock();
  const base = { alive: () => false, pause: clock.pause };
  assert.equal(
    await watch({ ...base, claimed: async () => false, remove: async () => assert.fail() }),
    "never-claimed",
  );
  assert.equal(
    await watch({ ...base, claimed: async () => true, remove: async () => "gone" }),
    "gone",
  );
  assert.equal(
    await watch({ ...base, claimed: async () => true, remove: async () => "not-ours" }),
    "not-ours",
  );
});
