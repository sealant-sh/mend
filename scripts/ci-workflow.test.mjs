import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { parse } from "yaml";

import { CI_RUNNER } from "./ci-measure-workflow.mjs";

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
    assert.equal(jobs[name]["runs-on"], CI_RUNNER);
  }
  assert.deepEqual(new Set(jobs.checks.needs), new Set(Object.keys(completed())));
  // Seconds of work each, on GitHub's free arm64 runners (merge-queue.md).
  for (const name of ["changes", "checks"]) assert.equal(jobs[name]["runs-on"], "ubuntu-24.04-arm");
  assert.ok(
    !jobs.checks.steps.some((step) => step.uses),
    "the required gate reads only needs: no checkout or setup to wait on",
  );
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

// The publisher's inline copy of normalize-npm-tarball.mjs --check and the script can drift from
// either side, so their parity test runs in the job every pull request runs, never only with
// packaging scope.
test("the publisher's tarball check is compared with the normalizer on every pull request", () => {
  const run = commands("static").map(withoutReporterOptions);
  assert.ok(
    run.some(
      (command) =>
        command.includes("scripts/republish.test.mjs") &&
        command.includes("scripts/normalize-npm-tarball.test.mjs"),
    ),
    "static runs the parity test",
  );
  assert.equal(jobs.static.if, "${{ !cancelled() }}");
  assert.ok(
    !commands("packaging").some((command) => command.includes("scripts/republish.test.mjs")),
    "the parity test runs once, in static",
  );
  // The rest of the publish block's tests, split from republish.test.mjs by area, run beside it.
  const split = globSync("scripts/republish*.test.mjs", { cwd: root }).toSorted();
  assert.ok(split.length > 1, split.join(", "));
  for (const file of split) {
    assert.ok(
      run.some((command) => command.split(/\s+/).includes(file)),
      `static runs ${file}`,
    );
    assert.ok(
      !commands("packaging").some((command) => command.includes(file)),
      `${file} runs once, in static`,
    );
  }
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
    "scripts/ghcr-staging-cleanup.test.mjs",
    "scripts/upgrade-window.test.mjs",
    "scripts/check-split-tier.test.mjs",
    "scripts/release-manifest.test.mjs",
    "scripts/packaged-ssh-acceptance.test.mjs",
    "scripts/packaged-git-access-acceptance.test.mjs",
    "scripts/packaged-dotfiles-acceptance.test.mjs",
    "scripts/helm-chart.test.mjs",
    "scripts/aws-tofu.test.mjs",
    "scripts/edge-overlay.test.mjs",
    "scripts/mirrors-runtime.test.mjs",
    "scripts/verify-stack/lifecycle.e2e.test.mjs",
    "scripts/verify-stack/lifecycle.locking.e2e.test.mjs",
    "scripts/verify-stack/lifecycle.resources.e2e.test.mjs",
    "scripts/verify-stack/lifecycle.recording.e2e.test.mjs",
    "scripts/bench/*.test.mjs",
    ".claude/skills/verify/scripts/leaks.test.mjs",
    ".claude/skills/verify/scripts/leaks.closed-roots.test.mjs",
    ".claude/skills/verify/scripts/leaks.frames.test.mjs",
    "scripts/next-version.test.mjs",
    "scripts/next-version.histories.test.mjs",
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
  const packageScripts = globSync("{apps,packages,tooling}/*/package.json", {
    cwd: root,
  })
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
  for (const manifest of globSync("{apps,packages,tooling}/*/turbo.json", {
    cwd: root,
  })) {
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

test("PRs and merge groups have exact history; manual and nightly events retain the full CI graph", () => {
  assert.ok(!Object.hasOwn(workflow.on, "push"), "main is reached only through the merge queue");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.merge_group.types, ["checks_requested"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "23 2 * * *" }]);
  assert.equal(jobs.checks.name, undefined, "the required check context must remain checks");
  assert.equal(
    workflow.env.TURBO_SCM_BASE,
    "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
  );
  assert.equal(jobs.changes.outputs.graph, "${{ steps.scope.outputs.graph }}");
  for (const name of ["static", "test-engines", "test-clients-a", "test-clients-b"]) {
    assert.equal(
      jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout@")).with[
        "fetch-depth"
      ],
      0,
    );
    assert.ok(commands(name).includes('node scripts/ci-turbo.mjs configure >> "$GITHUB_ENV"'));
    assert.equal(jobs[name].env.CI_GRAPH, "${{ needs.changes.outputs.graph }}", name);
  }
  const scope = jobs.changes.steps.find((step) => step.id === "scope");
  assert.match(
    scope.run,
    /merge_group \]; then\s+node scripts\/ci-scope.mjs --merge-group "\$QUEUE_BASE_SHA" "\$QUEUE_HEAD_SHA"/,
  );
  assert.equal(scope.env.QUEUE_BASE_SHA, "${{ github.event.merge_group.base_sha }}");
  assert.equal(scope.env.QUEUE_HEAD_SHA, "${{ github.event.merge_group.head_sha }}");
  assert.match(scope.run, /else\s+node scripts\/ci-scope.mjs --all/);
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

test("the Version workflow dispatches nothing: the release runs CI and acceptance on its head", () => {
  assert.equal(versionWorkflow.jobs.version.permissions.actions, undefined);
  assert.deepEqual(
    versionWorkflow.jobs.version.steps.filter((step) => step.run?.includes("gh workflow run")),
    [],
  );
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
  assert.deepEqual(measured.on.workflow_dispatch.inputs.runner.options, ["box", "ubuntu-latest"]);
  const box = ["self-hosted", "box", "linux", "x64"];
  const movable = [];
  const policyCommands = [];
  for (const name of Object.keys(jobs)) {
    assert.equal(measured.jobs[name].env?.CI_MEASUREMENT_CACHE, undefined);
    if (jobs[name]["runs-on"] === CI_RUNNER) {
      movable.push(name);
      assert.equal(
        measured.jobs[name]["runs-on"],
        `\${{ inputs.runner == 'box' && fromJSON('${JSON.stringify(box)}') || inputs.runner }}`,
      );
      measured.jobs[name]["runs-on"] = CI_RUNNER;
      const setup = measured.jobs[name].steps.find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      );
      assert.equal(setup.with.cache, "${{ inputs.runner != 'box' && 'pnpm' || '' }}");
    }
    for (const step of measured.jobs[name].steps) {
      if (step.env?.CI_MEASUREMENT_CACHE !== undefined) {
        assert.equal(step.env.CI_MEASUREMENT_CACHE, "${{ inputs.cache }}");
        assert.equal(step.env.CI_MEASUREMENT_RUNNER, "${{ inputs.runner }}");
        policyCommands.push(step.run);
        delete step.env.CI_MEASUREMENT_CACHE;
        delete step.env.CI_MEASUREMENT_RUNNER;
        if (Object.keys(step.env).length === 0) delete step.env;
      }
    }
    assert.deepEqual(normalize(measured.jobs[name]), normalize(jobs[name]), name);
  }
  // The arm64 scope job and the aggregate gate stay where production runs them.
  assert.deepEqual(movable.toSorted(), [
    "mobile-web",
    "packaging",
    "static",
    "test-clients-a",
    "test-clients-b",
    "test-engines",
  ]);
  assert.doesNotMatch(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    /blacksmith/i,
    "production CI never names a vendor runner",
  );
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

test("a failed or missing nightly opens or updates one issue, with nothing but issue writes", () => {
  const watch = parse(
    readFileSync(new URL("../.github/workflows/nightly-watch.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(watch.on.workflow_run, {
    workflows: ["CI", "Build input probe"],
    types: ["completed"],
    branches: ["main"],
  });
  assert.equal(watch.on.schedule.length, 1);
  assert.deepEqual(watch.permissions, { actions: "read", issues: "write" });
  const job = watch.jobs.alert;
  assert.equal(job["runs-on"], "ubuntu-24.04", "a box outage must not silence the watch");
  assert.equal(job.permissions, undefined, "the job inherits the workflow's two permissions");
  assert.ok(
    !job.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    "the job that can write issues never checks out repository code",
  );
  assert.match(job.if, /github\.event\.workflow_run\.event == 'schedule'/);
  assert.match(job.if, /github\.event\.workflow_run\.conclusion != 'success'/);
  const run = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(run, /for workflow in ci\.yml build-input-probe\.yml; do/);
  assert.match(run, /--workflow "\$workflow" --event schedule --branch main --status success/);
  assert.match(run, /30 \* 3600/);
  assert.match(run, /gh issue list --label nightly-failure --state open/);
  assert.match(run, /gh issue comment "\$open"/);
});

test("the nightly watch comments on its open issue, opens one when none is open, and stays quiet within 30 hours", () => {
  const watch = parse(
    readFileSync(new URL("../.github/workflows/nightly-watch.yml", import.meta.url), "utf8"),
  );
  const script = watch.jobs.alert.steps[0].run;
  const tmp = mkdtempSync(join(tmpdir(), "mend-nightly-watch-"));
  try {
    const log = join(tmp, "gh.log");
    // A fake gh: answers the reads from the environment and records every call.
    writeFileSync(
      join(tmp, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "api repos/"*) echo "test-engines (failure)" ;;
  "run list") case "$*" in
    *ci.yml*) echo "$FAKE_LAST_SUCCESS" ;;
    *build-input-probe.yml*) echo "\${FAKE_PROBE_LAST_SUCCESS-$FAKE_LAST_SUCCESS}" ;;
  esac ;;
  "issue list") echo "$FAKE_OPEN_ISSUE" ;;
esac
`,
      { mode: 0o755 },
    );
    const run = (env) => {
      rmSync(log, { force: true });
      const result = spawnSync("bash", ["-c", script], {
        env: {
          PATH: `${tmp}:${process.env.PATH}`,
          GH_REPO: "sealant-sh/mend",
          ...env,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    };
    const failed = {
      EVENT_NAME: "workflow_run",
      RUN_ID: "1",
      RUN_NAME: "Build input probe",
      RUN_URL: "u",
      RUN_CONCLUSION: "failure",
      RUN_SHA: "s",
    };
    assert.match(run({ ...failed, FAKE_OPEN_ISSUE: "" }), /^issue create --label nightly-failure/m);
    const comment = run({ ...failed, FAKE_OPEN_ISSUE: "42" });
    assert.match(
      comment,
      /^issue comment 42 --body The nightly Build input probe run .*test-engines \(failure\)/m,
    );
    assert.doesNotMatch(comment, /issue create/);
    const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
    assert.doesNotMatch(run({ EVENT_NAME: "schedule", FAKE_LAST_SUCCESS: hoursAgo(1) }), /issue/);
    assert.match(
      run({
        EVENT_NAME: "schedule",
        FAKE_LAST_SUCCESS: hoursAgo(31),
        FAKE_OPEN_ISSUE: "",
      }),
      /^issue create --label nightly-failure .*No scheduled ci\.yml run on main has succeeded in 30 hours/m,
    );
    const probeStale = run({
      EVENT_NAME: "schedule",
      FAKE_LAST_SUCCESS: hoursAgo(1),
      FAKE_PROBE_LAST_SUCCESS: hoursAgo(31),
      FAKE_OPEN_ISSUE: "",
    });
    assert.match(
      probeStale,
      /No scheduled build-input-probe\.yml run on main has succeeded in 30 hours/,
    );
    assert.doesNotMatch(probeStale, /No scheduled ci\.yml run/);
    assert.match(
      run({
        EVENT_NAME: "schedule",
        FAKE_LAST_SUCCESS: "",
        FAKE_OPEN_ISSUE: "",
      }),
      /last success: none/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Box runner VMs keep state between jobs, so a job that publishes, or holds a token that writes to
// the repository, its packages or a registry, runs on a GitHub-hosted runner: a fresh VM. A runner
// is named in runs-on, in a matrix row, or in a matrix a step builds as JSON (preview.yml's plan).
const hosted = (runner) =>
  (Array.isArray(runner) ? runner : [runner]).every(
    (label) => typeof label === "string" && /^ubuntu-(latest|[0-9.]+(-arm)?)$/.test(label),
  );
const runnersIn = (value) => {
  if (typeof value === "string") {
    // Runner selectors written as JSON inside a script: "runner": "…" or "runner": […].
    return [...value.matchAll(/"runner"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)].map((m) => JSON.parse(m[1]));
  }
  if (Array.isArray(value)) return value.flatMap(runnersIn);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      key === "runner" ? [entry, ...runnersIn(entry)] : runnersIn(entry),
    );
  }
  return [];
};
const publishingRunners = (jobs) =>
  Object.entries(jobs).flatMap(([name, job]) => {
    if (job.uses) return [];
    const runsOn = job["runs-on"];
    const named = /^\$\{\{ matrix\.[a-z.]+ \}\}$/.test(runsOn) ? [] : [runsOn];
    return [...named, ...runnersIn(job.strategy), ...runnersIn(job.steps)].map((runner) => ({
      name,
      runner,
    }));
  });

test("jobs that publish or hold a write token never ask for a box runner", () => {
  for (const file of [
    "image.yml",
    "release-cli.yml",
    "release-acceptance.yml",
    "version.yml",
    "preview.yml",
    "publish-vscode.yml",
    "t3code-drift.yml",
    "nightly-watch.yml",
  ]) {
    const { jobs } = parse(
      readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"),
    );
    for (const { name, runner } of publishingRunners(jobs)) {
      assert.ok(hosted(runner), `${file} ${name} asks for ${JSON.stringify(runner)}`);
    }
  }
});

test("the runner guard catches a box label wherever a runner is named", () => {
  const job = (fields) => ({ publish: { steps: [], ...fields } });
  const box = ["self-hosted", "box", "linux", "x64"];
  const caught = (jobs) => publishingRunners(jobs).some(({ runner }) => !hosted(runner));
  assert.ok(caught(job({ "runs-on": box })), "runs-on");
  assert.ok(caught(job({ "runs-on": "box" })), "a scalar label");
  assert.ok(
    caught(
      job({
        "runs-on": "${{ matrix.platform.runner }}",
        strategy: { matrix: { platform: [{ arch: "amd64", runner: box }] } },
      }),
    ),
    "a matrix row",
  );
  // Astra's mutation: preview.yml's plan builds the matrix as JSON, and a selector needs no
  // self-hosted label to land on the box.
  assert.ok(
    caught(
      job({
        "runs-on": "ubuntu-24.04",
        steps: [{ run: `amd64='{"arch":"amd64","runner":["box","linux","x64"]}'` }],
      }),
    ),
    "a matrix a step builds",
  );
  assert.ok(!caught(job({ "runs-on": "ubuntu-24.04-arm" })), "a hosted runner passes");
});

// The mobile-web and packaging lanes are skipped for a change confined to package tests
// (scripts/ci-scope.mjs), so each deletes those tests before any lane step and can write no cache
// from the tree that no longer matches its commit.
const removal = "node scripts/remove-package-tests.mjs";
const setup = [
  (step) => step.uses?.startsWith("actions/checkout@"),
  (step) => step.uses?.startsWith("pnpm/action-setup@"),
  (step) => step.uses?.startsWith("actions/setup-node@"),
  (step) => step.run === "pnpm install --frozen-lockfile",
];
const scopedJobs = (ci) =>
  Object.entries(ci.jobs).filter(([, job]) =>
    /needs\.changes\.outputs\.(mobile|packaging)\b/.test(String(job.if ?? "")),
  );
const laneProblems = (ci) =>
  scopedJobs(ci).flatMap(([name, job]) => {
    const problems = [];
    const at = job.steps.findIndex((step) => step.run === removal);
    if (at < 0) problems.push(`${name}: never removes package tests`);
    else if (at !== setup.length || !setup.every((matches, index) => matches(job.steps[index]))) {
      problems.push(`${name}: removes package tests other than right after checkout and install`);
    }
    if (job.env?.TURBO_CACHE !== "local:r,remote:r") {
      problems.push(`${name}: Turbo cache is not read-only`);
    }
    const credentials = Object.keys({ ...ci.env, ...job.env }).filter((key) =>
      /^TURBO_(API|TOKEN|TEAM)$/.test(key),
    );
    if (credentials.length > 0) problems.push(`${name}: sets ${credentials.join(", ")}`);
    for (const step of job.steps) {
      if (/\bturbo\b|ci-turbo\.mjs|TURBO_CACHE/.test(step.run ?? "")) {
        problems.push(`${name}: runs Turbo or changes its cache in "${step.run}"`);
      }
    }
    return problems;
  });

test("both scoped lanes delete package tests before any lane step and write no Turbo cache", () => {
  assert.deepEqual(
    scopedJobs(workflow).map(([name]) => name),
    ["packaging", "mobile-web"],
  );
  assert.deepEqual(laneProblems(workflow), []);
  const mutated = (job, change) => {
    const copy = structuredClone(workflow);
    change(copy.jobs[job], copy);
    return laneProblems(copy);
  };
  const removalAt = (job) => job.steps.findIndex((step) => step.run === removal);
  for (const job of ["packaging", "mobile-web"]) {
    for (const [description, change] of [
      ["the removal is gone", (lane) => lane.steps.splice(removalAt(lane), 1)],
      [
        "the removal runs after a lane step",
        (lane) => lane.steps.push(...lane.steps.splice(removalAt(lane), 1)),
      ],
      [
        "the removal runs before install",
        (lane) => lane.steps.splice(3, 0, ...lane.steps.splice(removalAt(lane), 1)),
      ],
      ["the cache can be written", (lane) => (lane.env.TURBO_CACHE = "local:rw,remote:rw")],
      ["the cache setting is gone", (lane) => delete lane.env.TURBO_CACHE],
      [
        "the job configures the box cache",
        (lane) => lane.steps.push({ run: 'node scripts/ci-turbo.mjs configure >> "$GITHUB_ENV"' }),
      ],
      ["the job runs Turbo", (lane) => lane.steps.push({ run: "pnpm exec turbo run build" })],
      ["the job holds a cache token", (lane) => (lane.env.TURBO_TOKEN = "box")],
      ["the workflow holds a cache token", (_, copy) => (copy.env.TURBO_API = "http://cache")],
    ]) {
      assert.notDeepEqual(mutated(job, change), [], `${job}: ${description}`);
    }
  }
});

// x86 CI runs on GitHub-hosted runners. The box's runners stay a fallback a person picks by
// dispatching with `runner: box`: no other event may resolve a job's runs-on to the box, and no
// event at all to a Blacksmith runner. runs-on is evaluated per event, dispatch input and matrix
// row with GitHub's own expression library.
const BOX = ["self-hosted", "box", "linux", "x64"];
const toData = (v) => {
  if (typeof v === "string") return new data.StringData(v);
  if (typeof v === "boolean") return new data.BooleanData(v);
  if (typeof v === "number") return new data.NumberData(v);
  if (v === null || v === undefined) return new data.Null();
  if (Array.isArray(v)) return new data.Array(...v.map(toData));
  const dictionary = new data.Dictionary();
  for (const [key, entry] of Object.entries(v)) dictionary.add(key, toData(entry));
  return dictionary;
};
const evaluate = (expression, context) => {
  const tree = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse();
  return JSON.parse(JSON.stringify(new Evaluator(tree, toData(context)).evaluate(), data.replacer));
};
const expressionOf = (value) =>
  typeof value === "string" ? value.match(/^\$\{\{(.+)\}\}$/s)?.[1] : undefined;
/** The labels a runs-on value resolves to in a context. */
const resolveRunner = (runsOn, context) => {
  const whole = expressionOf(runsOn);
  const value = whole ? evaluate(whole, context) : runsOn;
  const labels = typeof value === "string" ? [value] : Array.isArray(value) ? value : value?.labels;
  return [labels].flat().map((label) => {
    const inner = expressionOf(label);
    return inner ? evaluate(inner, context) : label;
  });
};
/** Every matrix row a job runs, or one empty row. A list a step builds at run time is one {} row. */
const matrixRows = (strategy) => {
  const matrix = strategy?.matrix;
  if (matrix === undefined) return [{}];
  const keys = Object.keys(matrix).filter((key) => key !== "include" && key !== "exclude");
  let rows = [{}];
  for (const key of keys) {
    const values = expressionOf(matrix[key]) ? [{}] : matrix[key];
    rows = rows.flatMap((row) => values.map((entry) => ({ ...row, [key]: entry })));
  }
  const include = matrix.include ?? [];
  return keys.length > 0 ? [...rows, ...include] : include;
};
/**
 * Every (event, inputs) a workflow can run with: each dispatch choice and boolean value, every other
 * trigger with none.
 */
const runsOf = (on) => {
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  return events.flatMap((event) => {
    if (event !== "workflow_dispatch") return [{ event, inputs: {} }];
    let choices = [{}];
    for (const [name, input] of Object.entries(on.workflow_dispatch?.inputs ?? {})) {
      const options =
        input.type === "choice"
          ? input.options
          : input.type === "boolean"
            ? [false, true]
            : [input.default ?? ""];
      choices = choices.flatMap((chosen) =>
        options.map((option) => ({ ...chosen, [name]: option })),
      );
    }
    return choices.map((inputs) => ({ event, inputs }));
  });
};
const resolutions = (files = globSync(".github/workflows/*.yml", { cwd: root })) =>
  files.flatMap((file) => {
    const { on, jobs: fileJobs } = parse(readFileSync(new URL(file, root), "utf8"));
    return runsOf(on).flatMap(({ event, inputs }) =>
      Object.entries(fileJobs).flatMap(([job, { "runs-on": runsOn, strategy }]) =>
        runsOn === undefined
          ? []
          : matrixRows(strategy).map((matrix) => ({
              file,
              event,
              inputs,
              job,
              labels: resolveRunner(runsOn, { inputs, matrix, github: { event_name: event } }),
            })),
      ),
    );
  });
const isBox = (labels) => JSON.stringify(labels) === JSON.stringify(BOX);
// A runner read from a matrix a step builds (preview.yml's plan) resolves to null here; the JSON
// that step writes is checked instead.
const builtAtRunTime = ({ labels }) => labels.some((label) => label == null);
const runnerProblems = (all) =>
  all
    .filter((run) => !builtAtRunTime(run))
    .flatMap(({ file, event, inputs, job, labels }) => {
      const where = `${file} ${job} on ${event} ${JSON.stringify(inputs)} -> ${JSON.stringify(labels)}`;
      if (labels.some((label) => /blacksmith/i.test(String(label))))
        return [`Blacksmith: ${where}`];
      if (event === "workflow_dispatch" && inputs.runner === "box" && isBox(labels)) return [];
      return hosted(labels) ? [] : [`not hosted: ${where}`];
    });

test("only a dispatch with runner: box selects the box, and nothing selects Blacksmith", () => {
  const all = resolutions();
  for (const event of ["pull_request", "merge_group", "schedule", "workflow_dispatch"]) {
    assert.ok(
      all.some((run) => run.event === event && run.file.endsWith("/ci.yml")),
      event,
    );
  }
  assert.deepEqual(runnerProblems(all), []);
  // Only preview.yml reads its runners from a matrix a step builds: every runner it writes is hosted.
  const built = all.filter(builtAtRunTime);
  assert.deepEqual([...new Set(built.map((run) => run.file))], [".github/workflows/preview.yml"]);
  const preview = parse(readFileSync(new URL(".github/workflows/preview.yml", root), "utf8")).jobs;
  for (const { job } of built)
    assert.equal(preview[job]["runs-on"], "${{ matrix.platform.runner }}");
  const written = Object.values(preview).flatMap((job) => runnersIn(job.steps ?? []));
  assert.ok(written.length > 0, "preview.yml writes the runners its matrix reads");
  for (const runner of written) assert.ok(hosted(runner), `preview.yml writes ${runner}`);
});

test("CI's x86 lanes run on ubuntu-24.04 and return to the box only when dispatched to it", () => {
  const ci = resolutions([".github/workflows/ci.yml"]);
  const lanes = [
    "static",
    "test-engines",
    "test-clients-a",
    "test-clients-b",
    "packaging",
    "mobile-web",
  ];
  const on = (event, job, inputs = {}) =>
    ci.find(
      (run) =>
        run.event === event &&
        run.job === job &&
        JSON.stringify(run.inputs) === JSON.stringify(inputs),
    )?.labels;
  for (const job of lanes) {
    for (const event of ["pull_request", "merge_group", "schedule"]) {
      assert.deepEqual(on(event, job), ["ubuntu-24.04"], `${job} on ${event}`);
    }
    assert.deepEqual(on("workflow_dispatch", job, { runner: "ubuntu-24.04" }), ["ubuntu-24.04"]);
    assert.deepEqual(on("workflow_dispatch", job, { runner: "box" }), BOX);
  }
  for (const job of ["changes", "checks"]) {
    assert.deepEqual(on("pull_request", job), ["ubuntu-24.04-arm"]);
  }
  // The evaluation itself refuses a default that lands on the box or a Blacksmith label.
  const mutated = (runsOn) =>
    runnerProblems(
      runsOf(workflow.on).map(({ event, inputs }) => ({
        file: "ci.yml",
        event,
        inputs,
        job: "static",
        labels: resolveRunner(runsOn, { inputs, matrix: {}, github: { event_name: event } }),
      })),
    );
  assert.notDeepEqual(mutated(BOX), [], "a literal box lane");
  assert.notDeepEqual(
    mutated(
      '${{ inputs.runner != \'ubuntu-24.04\' && fromJSON(\'["self-hosted","box","linux","x64"]\') || \'ubuntu-24.04\' }}',
    ),
    [],
    "events without inputs defaulting to the box",
  );
  assert.notDeepEqual(
    mutated(
      '${{ inputs.runner == \'box\' && fromJSON(\'["self-hosted","box","linux","x64"]\') || \'blacksmith-4vcpu-ubuntu-2404\' }}',
    ),
    [],
    "a Blacksmith default",
  );
});
