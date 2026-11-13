import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "scripts/fixtures/ci-flakes");

// A stand-in for the GitHub CLI that serves recorded API responses and logs every call.
const fakeGh = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [command, path] = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, path + "\\n");
if (command !== "api") process.exit(2);
const zip = /\\/actions\\/artifacts\\/(\\d+)\\/zip$/.exec(path);
if (zip) process.stdout.write(readFileSync(join(process.env.FAKE_GH_ZIPS, zip[1] + ".zip")));
else if (path.includes("/actions/workflows/ci.yml/runs?"))
  process.stdout.write(readFileSync(join(process.env.FAKE_GH_FIXTURES, "runs.json")));
else if (path.includes("/actions/artifacts?"))
  process.stdout.write(readFileSync(join(process.env.FAKE_GH_FIXTURES, "artifacts.json")));
else process.exit(1);
`;

const runs = (...ids) => ids.map((id) => `https://github.com/sealant-sh/mend/actions/runs/${id}`);

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), "mend-ci-flakes-"));
  const bin = join(directory, "bin");
  const zips = join(directory, "zips");
  execFileSync("mkdir", ["-p", bin, zips]);
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  for (const id of readdirSync(join(fixtures, "artifacts"))) {
    // The artifact zip as GitHub serves it: the job's reports at its root, beside other files.
    const files = readdirSync(join(fixtures, "artifacts", id)).map((name) =>
      join(fixtures, "artifacts", id, name),
    );
    execFileSync("zip", [
      "-q",
      "-j",
      join(zips, `${id}.zip`),
      ...files,
      join(fixtures, "runs.json"),
    ]);
  }
  const log = join(directory, "calls.log");
  writeFileSync(log, "");
  const run = (...args) => {
    writeFileSync(log, "");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/ci-flakes.mjs",
        "--repo",
        "sealant-sh/mend",
        "--cache",
        join(directory, "cache"),
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_GH_LOG: log,
          FAKE_GH_ZIPS: zips,
          FAKE_GH_FIXTURES: fixtures,
        },
      },
    );
    return {
      ...result,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  };
  return {
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

test("ranks flaky tests by distinct commits from recorded reports, downloading each once", () => {
  const { run, cleanup } = setup();
  try {
    const first = run("--since", "2026-11-01", "--json");
    assert.equal(first.status, 0, first.stderr);
    // One run list, one artifact list, then only the reports that hold retried tests.
    assert.deepEqual(first.calls, [
      "repos/sealant-sh/mend/actions/workflows/ci.yml/runs?status=completed&per_page=100&page=1&created=%3E%3D2026-11-01T00%3A00%3A00.000Z",
      "repos/sealant-sh/mend/actions/artifacts?per_page=100&page=1",
      "repos/sealant-sh/mend/actions/artifacts/9005/zip",
      "repos/sealant-sh/mend/actions/artifacts/9004/zip",
      "repos/sealant-sh/mend/actions/artifacts/9003/zip",
      "repos/sealant-sh/mend/actions/artifacts/9102/zip",
      "repos/sealant-sh/mend/actions/artifacts/9103/zip",
    ]);
    const ledger = JSON.parse(first.stdout);
    assert.equal(ledger.runs, 4);
    assert.equal(ledger.runsWithReport, 3);
    assert.equal(ledger.runsWithoutReport, 1);
    // The CLI test needed its retry three times, all on commit c2 (one a rerun attempt), so the
    // engine test that flaked on two commits ranks above it.
    assert.deepEqual(ledger.tests, [
      {
        package: "@mend/engine",
        file: "packages/engine/src/host.test.ts",
        name: "protocol host > demotes and recovers from idle refusal",
        commits: 2,
        passedOnRetry: 1,
        failedTwice: 1,
        latestError: "Error: expected idle, got busy (latest)",
        latestOutcome: "passed-on-retry",
        latestAt: "2026-11-12T10:00:00Z",
        runs: runs(104, 102),
      },
      {
        package: "@sealant/mend",
        file: "apps/cli/src/server-setup.test.ts",
        name: "renders real Compose loopback listeners",
        commits: 1,
        passedOnRetry: 3,
        failedTwice: 0,
        latestError: "Test timed out in 5000ms.",
        latestOutcome: "passed-on-retry",
        latestAt: "2026-11-11T10:00:00Z",
        runs: runs(103, 102),
      },
    ]);

    const again = run("--since", "2026-11-01", "--json");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.calls.length, 2, "cached reports are not downloaded again");
    assert.deepEqual(JSON.parse(again.stdout).tests, ledger.tests);
  } finally {
    cleanup();
  }
});

test("--runs limits the ledger to the most recent runs and says what it covered", () => {
  const { run, cleanup } = setup();
  try {
    const result = run("--runs", "1", "--branch", "main");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.calls[0],
      "repos/sealant-sh/mend/actions/workflows/ci.yml/runs?status=completed&per_page=1&page=1&branch=main",
    );
    assert.deepEqual(result.calls.slice(2), ["repos/sealant-sh/mend/actions/artifacts/9004/zip"]);
    assert.match(result.stdout, /^Covered 1 of 1 runs; 0 had no test report/m);
    assert.match(
      result.stdout,
      /^1\. packages\/engine\/src\/host\.test\.ts > protocol host > demotes and recovers from idle refusal\n {3}1 commit; passed on retry 1, failed twice 0 \(@mend\/engine\)$/m,
    );
    assert.doesNotMatch(result.stdout, /server-setup/);
  } finally {
    cleanup();
  }
});
