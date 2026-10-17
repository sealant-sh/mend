import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupFixture,
  sessionCalls,
  assertNeighbors,
  expectedStops,
} from "./live-cleanup.helpers.mjs";

// The public CLI's waits, which these children record and take at once (`virtualSleeps`): the
// poll of a Stop it made, and the reconciliation grace before its last sweep.
const STOP_POLL_MS = 500;
const GRACE_MS = 10_000;

test("public cleanup records a Stop refusal while continuing other owned stops and best-effort force removal", async (t) => {
  const fixture = await cleanupFixture(t, { mode: "stop-refusal", virtualSleeps: true });
  const result = await fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.sleeps, [STOP_POLL_MS, GRACE_MS]);
  assert.deepEqual(sessionCalls(fixture.requests), [expectedStops[0], ...expectedStops.slice(3)]);
  assert.equal(
    fixture.requests.filter(
      ({ method, route }) => method === "DELETE" && route === "/api/worktrees/owned",
    ).length,
    1,
  );
  assert.equal(fixture.worktrees.has("owned"), false);
  assert.match(
    result.stderr,
    /error · cleanup · stop first-se · POST \/sessions\/first-session\/stop → 409/,
  );
  assert.equal(readFileSync(fixture.obligation, "utf8"), fixture.initial);
  assertNeighbors(fixture);
});

test("public cleanup does not retry a client removal refusal and a fresh successful retry settles the retained obligation", async (t) => {
  const fixture = await cleanupFixture(t, { mode: "delete-refusal", virtualSleeps: true });
  const refused = await fixture.run();
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.sleeps, [STOP_POLL_MS, STOP_POLL_MS, GRACE_MS], "no retry delay");
  assert.deepEqual(sessionCalls(fixture.requests), expectedStops);
  assert.equal(
    fixture.requests.filter(
      ({ method, route }) => method === "DELETE" && route === "/api/worktrees/owned",
    ).length,
    2,
    "one 403 per sweep, no retries of a client error",
  );
  assert.equal(fixture.worktrees.has("owned"), true);
  assert.equal(readFileSync(fixture.obligation, "utf8"), fixture.initial);
  assert.match(refused.stderr, /synthetic permanent worktree removal refusal/);
  const at = fixture.requests.length;
  fixture.recover();
  const retried = await fixture.run();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(retried.sleeps, [GRACE_MS]);
  assert.deepEqual(
    sessionCalls(fixture.requests.slice(at)),
    [],
    "already-settled sessions are not stopped again",
  );
  assert.equal(
    fixture.requests
      .slice(at)
      .filter(({ method, route }) => method === "DELETE" && route === "/api/worktrees/owned")
      .length,
    1,
  );
  assert.equal(fixture.worktrees.has("owned"), false);
  assert.equal(existsSync(fixture.obligation), false);
  assert.match(retried.stderr, /nothing more appeared, its unresolved requests are settled/);
  assertNeighbors(fixture);
});
