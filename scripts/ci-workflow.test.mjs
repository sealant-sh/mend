import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const versionWorkflow = parse(
  readFileSync(new URL("../.github/workflows/version.yml", import.meta.url), "utf8"),
);
const { jobs } = workflow;
const commands = (job) => jobs[job].steps.flatMap((step) => (step.run ? [step.run] : []));
const withoutReporterOptions = (command) =>
  command
    ?.split(/\s+/)
    .filter(
      (argument) =>
        !argument.startsWith("--test-reporter=") &&
        !argument.startsWith("--test-reporter-destination="),
    )
    .join(" ");
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
    const step = owner.steps.find((candidate) => withoutReporterOptions(candidate.run) === command);
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
    commands("static").includes("node scripts/ci-turbo.mjs build typecheck lint"),
    "static tasks use the common affected/cache policy",
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
    withoutReporterOptions(command).startsWith("node --test scripts/bundle-packaging.test.mjs"),
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
    "scripts/verify-stack/lifecycle.resources.e2e.test.mjs",
    "scripts/verify-stack/lifecycle.recording.e2e.test.mjs",
    "scripts/bench/*.test.mjs",
    ".claude/skills/verify/scripts/leaks.test.mjs",
  ])
    assert.ok(suite.split(/\s+/).includes(file), file);
});

// Node pairs each reporter with the destination at the same position.
const reporterPairs = (command, scripts) => {
  const values = (prefix) =>
    command
      .split(/\s+/)
      .filter((value) => value.startsWith(prefix))
      .map((value) => value.slice(prefix.length));
  const destinations = values("--test-reporter-destination=");
  const reporters = values("--test-reporter=");
  assert.equal(reporters.length, destinations.length, command);
  assert.deepEqual(
    reporters.map((reporter, index) => [reporter, destinations[index]]),
    [
      ["spec", "stdout"],
      [`${scripts}/ci-node-reporter.mjs`, "stderr"],
      [`${scripts}/ci-test-report.mjs`, "stdout"],
    ],
    command,
  );
};

test("native commands keep ordinary assertion output beside the CI file guard and test report", () => {
  for (const name of Object.keys(jobs)) {
    for (const command of commands(name).filter((value) => value.startsWith("node --test "))) {
      reporterPairs(command, "./scripts");
    }
  }
  const packageScripts = globSync("{apps,packages,tooling}/*/package.json", { cwd: root })
    .flatMap((manifest) =>
      Object.values(JSON.parse(readFileSync(new URL(manifest, root), "utf8")).scripts ?? {}),
    )
    .filter((script) => script.includes("ci-node-reporter.mjs"));
  assert.ok(packageScripts.length >= 2, "web and test-ci run native suites");
  for (const script of packageScripts) {
    reporterPairs(script.slice(script.indexOf("node --")).split(" && ")[0], "../../scripts");
  }
});

const testReportDir = "${{ github.workspace }}/.ci-reports/test";
const runsTests = (name) =>
  commands(name).some((command) =>
    /^node --test |^node scripts\/ci-shards\.mjs (engines|clients-a|clients-b)$|^pnpm --filter \S+ test:integration$/.test(
      command,
    ),
  );

test("every job that runs tests uploads its per-file test timings, even when tests fail", () => {
  assert.deepEqual(Object.keys(jobs).filter(runsTests), [
    "changes",
    "static",
    "test-engines",
    "test-clients-a",
    "test-clients-b",
    "packaging",
  ]);
  const turboUpload = jobs.static.steps.find(
    (step) => step.with?.name === "turbo-${{ github.job }}",
  );
  assert.match(turboUpload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/);
  for (const name of Object.keys(jobs)) {
    const uploads = jobs[name].steps.filter(
      (step) => step.with?.name === "test-report-${{ github.job }}",
    );
    if (!runsTests(name)) {
      assert.deepEqual(uploads, [], name);
      assert.equal(jobs[name].env?.CI_TEST_REPORT_DIR, undefined, name);
      continue;
    }
    assert.equal(jobs[name].env?.CI_TEST_REPORT_DIR, testReportDir, name);
    assert.deepEqual(
      uploads,
      [
        {
          name: "Archive per-file test timings",
          if: "${{ !cancelled() }}",
          uses: turboUpload.uses,
          with: {
            name: "test-report-${{ github.job }}",
            path: ".ci-reports/test/*.json",
            "include-hidden-files": true,
            "if-no-files-found": "ignore",
            "retention-days": 14,
          },
        },
      ],
      `${name} must upload test-report-\${{ github.job }}`,
    );
    assert.equal(jobs[name].steps.at(-1), uploads[0], `${name} uploads after every test step`);
  }
});

test("the test report reaches Turbo tasks without entering hashes, outputs or git", () => {
  const turbo = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
  assert.deepEqual(turbo.tasks.test.passThroughEnv, ["CI_TEST_REPORT_DIR"]);
  const tasks = Object.values(turbo.tasks);
  for (const manifest of globSync("{apps,packages,tooling}/*/turbo.json", { cwd: root })) {
    const { test: packageTest } = JSON.parse(readFileSync(new URL(manifest, root), "utf8")).tasks;
    assert.equal(packageTest?.passThroughEnv, undefined, `${manifest} replaces the report dir`);
    if (packageTest) tasks.push(packageTest);
  }
  for (const pattern of [...turbo.globalEnv, ...tasks.flatMap((task) => task.env ?? [])]) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : undefined;
    assert.ok(
      prefix === undefined
        ? pattern !== "CI_TEST_REPORT_DIR"
        : !"CI_TEST_REPORT_DIR".startsWith(prefix),
      `${pattern} would hash the report directory`,
    );
  }
  for (const task of tasks) {
    assert.ok(!(task.outputs ?? []).some((output) => output.includes(".ci-reports")));
  }
  assert.ok(readFileSync(new URL(".gitignore", root), "utf8").split("\n").includes(".ci-reports/"));
});

test("PRs have exact history and queue, manual and nightly events retain the full CI graph", () => {
  assert.ok(!Object.hasOwn(workflow.on, "push"), "main is reached only through the merge queue");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.merge_group.types, ["checks_requested"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "23 2 * * *" }]);
  assert.equal(jobs.checks.name, undefined, "the required check context must remain checks");
  assert.equal(workflow.env.TURBO_SCM_BASE, "${{ github.event.pull_request.base.sha }}");
  for (const name of ["static", "test-engines", "test-clients-a", "test-clients-b"]) {
    assert.equal(
      jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout@")).with[
        "fetch-depth"
      ],
      0,
    );
    assert.ok(commands(name).includes('node scripts/ci-turbo.mjs configure >> "$GITHUB_ENV"'));
  }
  assert.match(
    jobs.changes.steps.find((step) => step.id === "scope").run,
    /else\s+node scripts\/ci-scope.mjs --all/,
  );
  for (const name of ["web", "marketing", "desktop"]) {
    const config = JSON.parse(
      readFileSync(new URL(`../apps/${name}/turbo.json`, import.meta.url), "utf8"),
    );
    assert.ok(
      config.tasks.typecheck.dependsOn.includes("build"),
      `${name} must restore generated routes before typechecking`,
    );
  }
});

test("a newer pull request or dispatched head cancels its stale run; main, queue and nightly runs never do", () => {
  const { group, "cancel-in-progress": cancel } = workflow.concurrency;
  assert.equal(
    group,
    "${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'workflow_dispatch' && github.ref) || github.run_id }}",
  );
  assert.equal(
    cancel,
    "${{ github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' }}",
  );
});

test("the Version workflow dispatches required CI, and leaves packaged acceptance to the release", () => {
  assert.equal(versionWorkflow.jobs.version.permissions.actions, "write");
  const dispatches = versionWorkflow.jobs.version.steps.filter((step) =>
    step.run?.startsWith("gh workflow run "),
  );
  assert.deepEqual(
    dispatches.map((step) => step.run),
    ["gh workflow run ci.yml --ref changeset-release/main"],
  );
  for (const step of dispatches) {
    assert.equal(step.if, "steps.changesets.outputs.pullRequestNumber != ''");
    assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
    assert.equal(step.env.GH_REPO, "${{ github.repository }}");
  }
});

const normalize = (job) => ({
  ...job,
  steps: job.steps.filter(
    (step) => !step.uses?.startsWith("actions/checkout@") && step.id !== "scope",
  ),
});

test("dispatch measurements preserve the production jobs and cannot run on PRs or pushes", async () => {
  const { measurementWorkflow } = await import("./ci-measure-workflow.mjs");
  const measured = parse(
    readFileSync(new URL("../.github/workflows/ci-measure.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    measured,
    measurementWorkflow(workflow),
    "regenerate with node scripts/ci-measure-workflow.mjs",
  );
  assert.deepEqual(Object.keys(measured.on), ["workflow_dispatch"]);
  assert.deepEqual(measured.permissions, { contents: "read" });
  assert.equal(measured.jobs.checks.name, "measurement checks");
  delete measured.jobs.checks.name;
  assert.equal(measured.env.CI_MEASUREMENT_CACHE, undefined);
  const policyCommands = [];
  for (const name of Object.keys(jobs)) {
    assert.equal(measured.jobs[name].env?.CI_MEASUREMENT_CACHE, undefined);
    for (const step of measured.jobs[name].steps) {
      if (step.env?.CI_MEASUREMENT_CACHE !== undefined) {
        assert.equal(step.env.CI_MEASUREMENT_CACHE, "${{ inputs.cache }}");
        policyCommands.push(step.run);
        delete step.env.CI_MEASUREMENT_CACHE;
        if (Object.keys(step.env).length === 0) delete step.env;
      }
    }
    assert.deepEqual(normalize(measured.jobs[name]), normalize(jobs[name]), name);
  }
  assert.deepEqual(policyCommands.toSorted(), [
    "node scripts/ci-shards.mjs clients-a",
    "node scripts/ci-shards.mjs clients-b",
    "node scripts/ci-shards.mjs engines",
    "node scripts/ci-turbo.mjs build typecheck lint",
  ]);
});

test("measurement steps do not leak cache policy into the real shard-supervision fixtures", () => {
  const measured = parse(
    readFileSync(new URL("../.github/workflows/ci-measure.yml", import.meta.url), "utf8"),
  );
  const job = measured.jobs["test-clients-a"];
  const step = job.steps.find((candidate) => candidate.run?.includes("scripts/ci-shards.test.mjs"));
  assert.ok(step);
  for (const cache of ["cold", "warm"]) {
    const env = { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch" };
    delete env.CI_MEASUREMENT_CACHE;
    delete env.NODE_TEST_CONTEXT;
    for (const source of [measured.env, job.env, step.env]) {
      for (const [key, value] of Object.entries(source ?? {})) {
        env[key] = value
          .replaceAll("${{ inputs.cache }}", cache)
          .replaceAll("${{ inputs.base_sha }}", "a".repeat(40));
      }
    }
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-name-pattern=all modes preserve", "scripts/ci-shards.test.mjs"],
      {
        cwd: new URL("..", import.meta.url),
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${cache}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /all modes preserve/);
  }
});
