import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { full } from "../../scripts/ci-scope.mjs";
import {
  ciPlan,
  filesOwing,
  formalObligations,
  loadMap,
  matchObligations,
  readCiJobs,
  validateMap,
} from "./plan.mjs";
import { loadAllowedSkips } from "./skips.mjs";

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
  assert.ok(!runs(["apps/web-old/src/a.tsx"]).includes("mobile-web"));
  assert.ok(runs(["apps/mobile/src/a.tsx"]).includes("mobile-web"));
});

const unscopedTests = () =>
  readCiJobs(root)
    .filter((job) => job.lane === null && !["changes", "static", "checks"].includes(job.job))
    .map((job) => job.job);

test("product source owes a judgement, a run and screenshots; its tests and docs do not", () => {
  // Both web apps: the old one, and the new one rebuilt beside it one route at a time.
  for (const route of ["apps/web-old/src/routes/index.tsx", "apps/web/src/routes/index.tsx"]) {
    assert.deepEqual(ids([route]), ["pre-pr-checks", "judge", "run-it", "screenshots"]);
  }
  assert.deepEqual(ids(["packages/db/src/repos/sessions.ts"]), [
    "pre-pr-checks",
    "judge",
    "run-it",
  ]);
  assert.deepEqual(ids(["packages/db/test/sessions.test.ts", "apps/web-old/src/a.test.tsx"]), [
    "pre-pr-checks",
  ]);
  assert.deepEqual(ids(["docs/operations/ci.md", "AGENTS.md"]), ["pre-pr-checks"]);
  assert.deepEqual(ids([".github/workflows/ci.yml"]), ["pre-pr-checks"]);
});

test("code a model covers owes that model, and gated suites name their gate", () => {
  const formal = formalObligations(root, ["packages/sessions/src/engine.ts"]).find(
    (obligation) => obligation.kind === "formal",
  );
  assert.equal(formal?.model, "standby-discard");
  const gated = matchObligations(map, ["apps/cli/src/server-docker-volumes.ts"]).find(
    (obligation) => obligation.gate !== undefined,
  );
  assert.equal(gated?.gate, "MEND_DOCKER_TEST_CONTEXT");
  assert.equal(gated?.verb, "check");
});

test("a test helper, fake or fixture under a product path owes no judge; the code beside it does", () => {
  const helpers = [
    "apps/web-old/src/components/settings/sessions-test-trpc.tsx",
    "apps/web-old/src/test-fixtures/fake-fetch.ts",
    "apps/web-old/src/isomorphic-test-setup.ts",
    "apps/cli/src/server-lifecycle-test-fixtures.ts",
    "apps/cli/src/dashboard.fixture.ts",
    "apps/cli/test-fixtures/docker/compose.v2.yaml",
    "apps/vscode/src/test-servers.ts",
    "packages/inference/src/change-pass.test-fixtures.ts",
    "packages/t3-contracts/types/vite-plus-test.d.ts",
  ];
  for (const file of helpers) assert.ok(existsSync(join(root, file)), `${file} still exists`);
  assert.deepEqual(filesOwing(map, helpers, "judge"), []);
  assert.deepEqual(
    matchObligations(map, helpers).map((obligation) => obligation.id),
    ["pre-pr-checks"],
    "no judge, no run, no screenshots",
  );
  const product = [
    "apps/web-old/src/components/settings/sessions.tsx",
    "apps/cli/src/server-setup.ts",
    "packages/sessions/src/setup.ts",
    "apps/api/src/routes/harness-models.ts",
  ];
  assert.deepEqual(filesOwing(map, product, "judge"), product);
});

// The rule is a name, so it holds only while product code never imports a file named like a test
// helper: such a file would be product code that changes without a judge.
test("no product file imports a file the feature entry excludes as a test helper", () => {
  const feature = map.obligations.find((entry) => entry.id === "feature");
  const files = execFileSync(
    "git",
    ["ls-files", ...feature.paths.map((path) => path.replace("/**", ""))],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
  const known = new Set(files);
  const excluded = (file) => feature.exclude.some((glob) => matchesGlob(file, glob));
  const product = files.filter(
    (file) => /\.(ts|tsx|mts|mjs|js|jsx)$/.test(file) && !excluded(file),
  );
  const resolve = (from, spec) => {
    const base = normalize(join(dirname(from), spec));
    const stem = base.replace(/\.(js|mjs)$/, "");
    return [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mjs`,
      `${base}/index.ts`,
    ].find((candidate) => known.has(candidate));
  };
  const offenders = [];
  for (const file of product) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [, spec] of text.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g,
    )) {
      const target = resolve(file, spec);
      if (target && excluded(target) && !matchesGlob(target, "**/*.md"))
        offenders.push(`${file} imports ${target}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "rename the import's target, or the importer is a test helper too",
  );
});
