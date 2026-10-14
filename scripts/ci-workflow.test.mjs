import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const { jobs } = workflow;
const commands = (job) => jobs[job].steps.flatMap((step) => (step.run ? [step.run] : []));
const runGate = (results) => {
  const step = jobs.checks.steps.find((candidate) => candidate.env?.CI_JOB_RESULTS);
  assert.ok(step, "the required check must consume actual job results");
  return spawnSync("bash", ["-e", "-c", step.run], {
    encoding: "utf8",
    env: { ...process.env, CI_JOB_RESULTS: JSON.stringify(results) },
    timeout: 5_000,
  });
};
const completed = (mobile = "true", packaging = "true") => ({
  changes: { result: "success", outputs: { mobile, packaging } },
  static: { result: "success" },
  "test-engines": { result: "success" },
  "test-clients-a": { result: "success" },
  "test-clients-b": { result: "success" },
  packaging: { result: packaging === "false" ? "skipped" : "success" },
  "mobile-web": { result: mobile === "false" ? "skipped" : "success" },
});

test("the actual required-check command accepts full evidence and intentional scope skips", () => {
  for (const mobile of ["true", "false"]) {
    for (const packaging of ["true", "false"]) {
      const result = runGate(completed(mobile, packaging));
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /All required CI jobs passed/);
    }
  }
});

test("failed, cancelled, absent or skipped required jobs cannot produce a green check", () => {
  for (const name of [
    "changes",
    "static",
    "test-engines",
    "test-clients-a",
    "test-clients-b",
    "packaging",
    "mobile-web",
  ]) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const results = completed();
      if (result === undefined) delete results[name];
      else results[name].result = result;
      const observed = runGate(results);
      assert.equal(observed.error, undefined);
      assert.equal(observed.status, 1, `${name}/${result}: ${observed.stdout}${observed.stderr}`);
      assert.match(observed.stderr, new RegExp(name));
    }
  }
});

test("missing or malformed path classification is not permission to skip evidence", () => {
  for (const output of ["mobile", "packaging"]) {
    for (const selected of [undefined, "", "yes", false]) {
      const results = completed();
      if (selected === undefined) delete results.changes.outputs[output];
      else results.changes.outputs[output] = selected;
      const observed = runGate(results);
      assert.equal(observed.status, 1, observed.stdout + observed.stderr);
      assert.match(observed.stderr, /Missing or invalid/);
    }
  }
  const results = completed("false", "false");
  results.packaging.result = "failure";
  assert.equal(runGate(results).status, 1, "an optional job that ran and failed still fails CI");
});

test("static checks, all test shards and packaging can start without another execution job", () => {
  for (const name of [
    "static",
    "test-engines",
    "test-clients-a",
    "test-clients-b",
    "packaging",
    "mobile-web",
  ]) {
    assert.deepEqual(
      jobs[name].needs,
      "changes",
      `${name} must not wait for static or another shard`,
    );
    assert.match(jobs[name].if, /!cancelled\(\)/, `${name} must run when classification failed`);
    assert.deepEqual(jobs[name]["runs-on"], ["self-hosted", "box", "linux", "x64"]);
  }
  assert.deepEqual(new Set(jobs.checks.needs), new Set(Object.keys(completed())));
  assert.match(
    jobs.checks.if,
    /!cancelled\(\)/,
    "failed dependencies must not skip the required check",
  );
  assert.match(jobs.packaging.if, /needs\.changes\.outputs\.packaging != 'false'/);
  assert.match(jobs["mobile-web"].if, /needs\.changes\.outputs\.mobile != 'false'/);
});

test("required database and live-adapter evidence keeps its preparation and worker caps", () => {
  const engines = jobs["test-engines"];
  assert.equal(engines.services.postgres.image, "postgres:17");
  assert.equal(engines.env.MEND_TEST_DATABASE_URL, "postgres://mend:mend@localhost:5432/mend");
  for (const name of ["test-engines", "test-clients-a", "test-clients-b"]) {
    for (const variable of ["VITEST_MAX_THREADS", "VITEST_MAX_FORKS", "VITEST_MAX_WORKERS"]) {
      assert.equal(jobs[name].env[variable], "3", `${name}/${variable}`);
    }
    assert.equal(jobs[name].env.MEND_SKIP_POSTGRES_TESTS, undefined);
  }
  for (const command of [
    "node scripts/ci-shards.mjs engines",
    "pnpm run test:aws-shell",
    "pnpm run test:s3-contract",
    "node --test scripts/ci-shards.test.mjs",
  ]) {
    const owner = command.startsWith("node scripts/ci-shards") ? engines : jobs["test-clients-a"];
    const step = owner.steps.find((candidate) => candidate.run === command);
    assert.ok(step, command);
    assert.equal(step.if, undefined, `${command} must remain independent of packaging scope`);
  }
  assert.ok(
    commands("test-engines").some((command) =>
      command.includes("mend-shell-profile-test:alpine-3.22"),
    ),
  );
  assert.ok(
    commands("test-clients-a").some((command) =>
      command.includes("playwright-core install --with-deps --only-shell chromium"),
    ),
    "desktop browser evidence needs Chromium in its own job",
  );
  assert.deepEqual(
    Object.keys(jobs).filter((name) =>
      commands(name).some((command) => command.includes("scripts/ci-shards.test.mjs")),
    ),
    ["test-clients-a"],
    "process regressions run once outside the static feedback path",
  );
  assert.ok(commands("test-clients-a").includes("node scripts/ci-shards.mjs clients-a"));
  assert.ok(commands("test-clients-b").includes("node scripts/ci-shards.mjs clients-b"));
  assert.ok(
    commands("test-clients-a").includes("node apps/marketing/scripts/sync-install-script.mjs"),
  );
  assert.ok(
    commands("static").includes(
      "helm lint deploy/helm/mend -f deploy/helm/mend/ci/obc-values.yaml",
    ),
  );
  assert.ok(
    commands("static").includes("pnpm exec turbo build --force"),
    "fresh typechecks need generated route trees",
  );
});

test("packaging retains browser, Docker, OpenTofu and acceptance contracts in its own job", () => {
  const steps = jobs.packaging.steps;
  assert.equal(jobs.packaging.env.MEND_VERIFY_PLAYWRIGHT, "${{ github.workspace }}/apps/mobile");
  assert.ok(
    steps.some((step) => step.with?.tofu_version === "1.12.0" && step.with.tofu_wrapper === false),
  );
  assert.ok(
    commands("packaging").some((command) =>
      command.includes("playwright-core install --with-deps --only-shell chromium"),
    ),
  );
  assert.ok(
    commands("packaging").some(
      (command) =>
        command.includes("compose.edge.yaml") && command.includes('docker pull "$image"'),
    ),
  );
  const suite = commands("packaging").find((command) =>
    command.startsWith("node --test scripts/bundle-packaging.test.mjs"),
  );
  assert.ok(suite, "the native packaging test command is required");
  for (const file of [
    "scripts/check-packaged-server.test.mjs",
    "scripts/release-publication.test.mjs",
    "scripts/packaged-ssh-acceptance.test.mjs",
    "scripts/packaged-git-access-acceptance.test.mjs",
    "scripts/packaged-dotfiles-acceptance.test.mjs",
    "scripts/helm-chart.test.mjs",
    "scripts/aws-tofu.test.mjs",
    "scripts/edge-overlay.test.mjs",
    "scripts/mirrors-runtime.test.mjs",
    "scripts/verify-stack/lifecycle.e2e.test.mjs",
    ".claude/skills/verify/scripts/leaks.test.mjs",
  ])
    assert.ok(suite.split(/\s+/).includes(file), file);
});
