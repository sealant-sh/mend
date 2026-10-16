// Real processes and kernel locks against the isolated fake Docker daemon: each start's watchdog
// and how it takes a generation down.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { OWNER_CONTAINER, STATE_VOLUME } from "./lib.mjs";
import {
  pinned,
  daemon,
  ownerOf,
  names,
  volumeNames,
  generation,
  until,
  watchdogsOf,
  servingStart,
  callsOf,
} from "./lifecycle.e2e.helpers.mjs";
import { CLAIM_LABEL, RETRY_DELAYS_MS } from "./lifecycle.mjs";

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
  const fakeDaemon = daemon({ build: "hang", clock: true });
  const serve = await servingStart(fakeDaemon);
  writeFileSync(fakeDaemon.file("fail-lookups"), "3");
  serve.child.kill("SIGKILL");
  // The orphaned build holds serve's pipes, so wait for its exit rather than its close.
  await until("serve to exit", () => serve.child.signalCode !== null);
  // The watchdog's next supervisor poll observes the death, then each failed teardown waits out
  // its retry delay on the watchdog's clock.
  await fakeDaemon.advanceClock(2000);
  for (const delay of RETRY_DELAYS_MS.slice(0, 3)) {
    await until(`the teardown retry after ${delay} ms`, () =>
      fakeDaemon.watchdogLog().includes(`again in ${delay} ms`),
    );
    await fakeDaemon.advanceClock(delay);
  }
  await until("the watchdog to take the stack down", () =>
    /the stack is down/.test(fakeDaemon.watchdogLog()),
  );
  assert.equal(fakeDaemon.watchdogLog().match(/teardown failed \(teardown exited 1\)/g)?.length, 3);
  assert.equal(ownerOf(fakeDaemon.read()), undefined);
  rmSync(fakeDaemon.file("pause-build"));
  await serve.done;
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
