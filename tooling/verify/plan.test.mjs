import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { full } from "../../scripts/ci-scope.mjs";
import { loadAllowedSkips } from "./check.mjs";
import { ciPlan, loadMap, matchObligations, readCiJobs, validateMap } from "./plan.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const map = loadMap(root);
const ids = (files) => matchObligations(map, files).map((obligation) => obligation.id);

test("the obligations map is well formed and names files that exist", () => {
  assert.deepEqual(validateMap(map), []);
  // A rename would otherwise leave an obligation that never matches again.
  for (const entry of map.obligations)
    for (const path of [...entry.paths, ...(entry.exclude ?? [])].filter((p) => !/[*?[{]/.test(p)))
      assert.ok(existsSync(new URL(path, `file://${root}`)), `${entry.id} names missing ${path}`);
  for (const skip of loadAllowedSkips(root)) {
    assert.ok(existsSync(new URL(skip.file, `file://${root}`)), `allowed skip ${skip.file}`);
    assert.ok(skip.gate && skip.reason, `${skip.file} names its gate and a reason`);
  }
});

test("CI's lanes, ci.yml's scoped jobs and the map's lanes are the same set", () => {
  const scoped = readCiJobs(root).filter((job) => job.lane !== null);
  assert.deepEqual(
    map.ciLanes.map((lane) => [lane.lane, lane.job]).toSorted(),
    scoped.map((job) => [job.lane, job.job]).toSorted(),
    "every job ci.yml scopes by a changes output has a map lane with its local command",
  );
  assert.deepEqual(
    map.ciLanes.map((lane) => lane.lane).toSorted(),
    Object.keys(full).toSorted(),
    "every lane scripts/ci-scope.mjs decides is named in the map",
  );
});

test("the plan's CI jobs are CI's own decision for the same paths", () => {
  const runs = (files) =>
    ciPlan(root, files, map)
      .filter((job) => job.runs)
      .map((job) => job.job);
  // A docs change skips every scoped lane; the unscoped jobs always run.
  assert.deepEqual(runs(["docs/x.md"]), ["changes", "static", ...unscopedTests(), "checks"]);
  assert.ok(runs(["packages/store/src/a.ts"]).includes("store-image-git"));
  assert.ok(!runs(["apps/web/src/a.tsx"]).includes("mobile-web"));
  assert.ok(runs(["apps/mobile/src/a.tsx"]).includes("mobile-web"));
});

const unscopedTests = () =>
  readCiJobs(root)
    .filter((job) => job.lane === null && !["changes", "static", "checks"].includes(job.job))
    .map((job) => job.job);

test("product source owes a box check and screenshots; its tests and docs do not", () => {
  assert.deepEqual(ids(["apps/web/src/routes/index.tsx"]), [
    "pre-pr-checks",
    "box-check",
    "screenshots",
  ]);
  assert.deepEqual(ids(["packages/db/src/repos/sessions.ts"]), ["pre-pr-checks", "box-check"]);
  assert.deepEqual(ids(["packages/db/test/sessions.test.ts", "apps/web/src/a.test.tsx"]), [
    "pre-pr-checks",
  ]);
  assert.deepEqual(ids(["docs/operations/ci.md", "AGENTS.md"]), ["pre-pr-checks"]);
});

test("code a model covers owes that model, and gated suites name their gate", () => {
  const formal = matchObligations(map, ["packages/sessions/src/engine.ts"]).find(
    (obligation) => obligation.kind === "formal",
  );
  assert.equal(formal?.model, "standby-discard");
  const gated = matchObligations(map, ["apps/cli/src/server-docker-volumes.ts"]).find(
    (obligation) => obligation.gate !== undefined,
  );
  assert.equal(gated?.gate, "MEND_DOCKER_TEST_CONTEXT");
  assert.equal(gated?.verb, "check");
});
