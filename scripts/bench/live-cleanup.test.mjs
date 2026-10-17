import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  cleanupFixture,
  sessionCalls,
  assertNeighbors,
  expectedStops,
} from "./live-cleanup.helpers.mjs";

test("public cleanup stops live owners with actual 403 fallback, retries transient reads/removals, and clears only its own obligation", async (t) => {
  const fixture = await cleanupFixture(t, { mode: "retry" });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sessionCalls(fixture.requests), expectedStops);
  assert.equal(
    fixture.requests.filter(
      ({ method, route }) => method === "GET" && route === "/api/worktrees/owned",
    ).length,
    2,
  );
  assert.equal(
    fixture.requests.filter(
      ({ method, route }) => method === "DELETE" && route === "/api/worktrees/owned",
    ).length,
    2,
  );
  assert.equal(
    fixture.requests.filter(({ route }) => route === "/api/projects/project/worktrees").length,
    2,
    "actual final reconciliation sweep",
  );
  const finalDelete = fixture.requests
    .filter(({ method, route }) => method === "DELETE" && route === "/api/worktrees/owned")
    .at(-1);
  const finalListing = fixture.requests
    .filter(({ route }) => route === "/api/projects/project/worktrees")
    .at(-1);
  assert.ok(
    finalListing.at - finalDelete.at >= 9500,
    "native 10-second grace separates successful removal from final reconciliation",
  );
  assert.deepEqual(
    [...fixture.polls],
    [
      ["first-session", 2],
      ["second-session", 2],
    ],
  );
  assert.equal(fixture.worktrees.has("owned"), false);
  assert.equal(existsSync(fixture.obligation), false);
  assert.match(result.stderr, /nothing more appeared, its unresolved requests are settled/);
  assertNeighbors(fixture);
});

test("public cleanup never stops or deletes foreign or unknown-owned sessions and retains its exact obligation", async (t) => {
  const fixture = await cleanupFixture(t, { mode: "foreign" });
  const result = await fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(sessionCalls(fixture.requests), []);
  assert.deepEqual(
    fixture.requests.filter(
      ({ method, route }) => method === "DELETE" && route.startsWith("/api/worktrees/"),
    ),
    [],
  );
  for (const id of ["foreign", "unknown", "no-session"]) {
    assert.equal(fixture.worktrees.has(id), true);
    assert.equal(
      fixture.requests.filter(
        ({ method, route }) => method === "GET" && route === `/api/worktrees/${id}`,
      ).length,
      2,
    );
  }
  assert.match(result.stderr, /owned by outsider, not a bench account/);
  assert.match(result.stderr, /whose it is cannot be told/);
  assert.equal(readFileSync(fixture.obligation, "utf8"), fixture.initial);
  assertNeighbors(fixture);
});
