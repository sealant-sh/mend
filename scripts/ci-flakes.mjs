import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// The flaky-test ledger. CI retries a failed Vitest test once; the reporter in
// tooling/test-ci/src/vitest.ts writes each retried test to retried-vitest-*.json in the job's
// test report and names that artifact test-report-<job>-retried. This reads those records back
// from GitHub and ranks tests by how many distinct commits they flaked or failed on.

const usage = `Usage: node scripts/ci-flakes.mjs [--runs <n> | --since <date>] [--branch <name>] [--json]
  --runs <n>       the n most recent completed CI runs
  --since <date>   completed CI runs created on or after this date (default: the last 7 days)
  --branch <name>  only runs of this branch (a pull request's head branch, or main)
  --json           print the ledger as JSON
  --repo <o/r>     the GitHub repository (default: the origin remote)
  --cache <dir>    where downloaded records are kept (default: ~/.cache/mend-ci-flakes)`;

const PAGE = 100;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const REPORT = /^test-report-(.+?)(-retried)?$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const options = (() => {
  try {
    return parseArgs({
      options: {
        runs: { type: "string" },
        since: { type: "string" },
        branch: { type: "string" },
        json: { type: "boolean", default: false },
        repo: { type: "string" },
        cache: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  }
})();
if (options.help) {
  console.log(usage);
  process.exit(0);
}
if (options.runs !== undefined && options.since !== undefined)
  fail(`Pass --runs or --since.\n${usage}`);
const runLimit = options.runs === undefined ? undefined : Number(options.runs);
if (runLimit !== undefined && (!Number.isSafeInteger(runLimit) || runLimit < 1))
  fail("--runs takes a positive whole number.");
const since =
  options.since === undefined
    ? runLimit === undefined
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      : undefined
    : new Date(options.since);
if (since !== undefined && Number.isNaN(since.getTime()))
  fail("--since takes a date, such as 2026-11-06.");

const repo =
  options.repo ??
  (() => {
    const remote = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(remote.stdout ?? "");
    return match ? match[1] : fail("No GitHub origin remote; pass --repo <owner>/<name>.");
  })();
const cacheDir =
  options.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mend-ci-flakes");

const calls = { runPages: 0, artifactPages: 0, downloads: 0, cached: 0 };
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: 256 << 20,
    }),
  );

// One run list: the completed CI runs in the window, newest first.
const runs = [];
for (let page = 1; ; page++) {
  const perPage = Math.min(PAGE, runLimit ?? PAGE);
  const query = new URLSearchParams({
    status: "completed",
    per_page: String(perPage),
  });
  query.set("page", String(page));
  if (since !== undefined) query.set("created", `>=${since.toISOString()}`);
  if (options.branch !== undefined) query.set("branch", options.branch);
  calls.runPages++;
  const listed = api(`repos/${repo}/actions/workflows/ci.yml/runs?${query}`).workflow_runs;
  runs.push(...listed);
  if (listed.length < perPage || (runLimit !== undefined && runs.length >= runLimit)) break;
}
runs.splice(runLimit ?? runs.length);
const runsById = new Map(runs.map((run) => [run.id, run]));

// One artifact list: every artifact is newer than its run, so stop below the oldest run.
const oldest = Math.min(...runs.map((run) => Date.parse(run.created_at)));
const reported = new Set();
const retried = [];
for (let page = 1; runs.length > 0; page++) {
  calls.artifactPages++;
  const { artifacts } = api(`repos/${repo}/actions/artifacts?per_page=${PAGE}&page=${page}`);
  for (const artifact of artifacts) {
    const report = REPORT.exec(artifact.name);
    const run = runsById.get(artifact.workflow_run?.id);
    if (!report || !run) continue;
    reported.add(run.id);
    if (report[2]) retried.push({ artifact, run, job: report[1] });
  }
  if (artifacts.length < PAGE || artifacts.every((a) => Date.parse(a.created_at) < oldest)) break;
}

// Download only the reports that hold retried tests, once: an artifact never changes.
const expired = [];
const records = [];
for (const { artifact, run, job } of retried) {
  const directory = join(cacheDir, String(artifact.id));
  const complete = join(directory, ".complete");
  if (existsSync(complete)) calls.cached++;
  else if (artifact.expired) {
    expired.push(artifact);
    continue;
  } else {
    calls.downloads++;
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const zip = join(directory, "artifact.zip");
    writeFileSync(
      zip,
      execFileSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], {
        maxBuffer: 1 << 30,
      }),
    );
    const unzip = spawnSync("unzip", ["-o", "-q", zip, "retried-*.json", "-d", directory]);
    // 11: no file matched, which only a report written before retries existed can do.
    if (unzip.error || (unzip.status !== 0 && unzip.status !== 11))
      fail(`unzip could not read artifact ${artifact.id}: ${unzip.stderr ?? unzip.error}`);
    rmSync(zip);
    writeFileSync(complete, "");
  }
  for (const file of readdirSync(directory).filter((name) => /^retried-.*\.json$/.test(name))) {
    for (const record of JSON.parse(readFileSync(join(directory, file), "utf8"))) {
      records.push({ ...record, job, run });
    }
  }
}

// Rank by distinct commits: one bad commit rerun ten times is one commit, not ten flakes.
const tests = new Map();
const seen = new Set();
for (const record of records) {
  const key = JSON.stringify([record.package, record.file, record.name]);
  const occurrence = JSON.stringify([key, record.run.id, record.runAttempt, record.job]);
  if (seen.has(occurrence)) continue;
  seen.add(occurrence);
  let test = tests.get(key);
  if (test === undefined) {
    test = {
      package: record.package,
      file: record.file,
      name: record.name,
      commits: new Set(),
      passedOnRetry: 0,
      failedTwice: 0,
      latest: null,
      runs: new Map(),
    };
    tests.set(key, test);
  }
  test.commits.add(record.run.head_sha);
  if (record.outcome === "passed-on-retry") test.passedOnRetry++;
  else test.failedTwice++;
  test.runs.set(record.run.id, record.run);
  if (
    test.latest === null ||
    Date.parse(record.run.created_at) > Date.parse(test.latest.run.created_at)
  )
    test.latest = record;
}
const ranked = [...tests.values()]
  .map((test) => ({
    package: test.package,
    file: test.file,
    name: test.name,
    commits: test.commits.size,
    passedOnRetry: test.passedOnRetry,
    failedTwice: test.failedTwice,
    latestError: test.latest.firstError,
    latestOutcome: test.latest.outcome,
    latestAt: test.latest.run.created_at,
    runs: [...test.runs.values()]
      .toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((run) => run.html_url),
  }))
  .toSorted(
    (a, b) =>
      b.commits - a.commits ||
      b.passedOnRetry + b.failedTwice - (a.passedOnRetry + a.failedTwice) ||
      Date.parse(b.latestAt) - Date.parse(a.latestAt) ||
      `${a.file} ${a.name}`.localeCompare(`${b.file} ${b.name}`),
  );

const ledger = {
  repo,
  window: {
    since: since?.toISOString() ?? null,
    runs: runLimit ?? null,
    branch: options.branch ?? null,
  },
  runs: runs.length,
  runsWithReport: reported.size,
  runsWithoutReport: runs.length - reported.size,
  reportsWithRetries: retried.length,
  expiredReports: expired.length,
  apiCalls: {
    ...calls,
    total: calls.runPages + calls.artifactPages + calls.downloads,
  },
  tests: ranked,
};

if (options.json) {
  console.log(JSON.stringify(ledger, null, 2));
} else {
  const window =
    runLimit === undefined
      ? `completed CI runs created since ${ledger.window.since}`
      : `the ${runLimit === 1 ? "most recent completed CI run" : `${runLimit} most recent completed CI runs`}`;
  const lines = [
    `Flaky tests in ${repo}: ${window}${options.branch ? ` on ${options.branch}` : ""}.`,
    `Covered ${ledger.runsWithReport} of ${plural(ledger.runs, "run")}; ${ledger.runsWithoutReport} had no test report (stopped before tests, or the report expired after 14 days).`,
    `${plural(ledger.reportsWithRetries, "job report")} had retried tests${ledger.expiredReports ? `, ${ledger.expiredReports} of them expired` : ""}. API calls: ${ledger.apiCalls.total} (${calls.runPages} run list, ${calls.artifactPages} artifact list, ${plural(calls.downloads, "download")}; ${plural(calls.cached, "report")} read from ${cacheDir}).`,
    "",
  ];
  if (ranked.length === 0) lines.push("No test needed its retry in these runs.");
  ranked.forEach((test, index) => {
    lines.push(
      `${index + 1}. ${test.file} > ${test.name}`,
      `   ${test.commits} commit${test.commits === 1 ? "" : "s"}; passed on retry ${test.passedOnRetry}, failed twice ${test.failedTwice} (${test.package})`,
      `   latest (${test.latestOutcome}, ${test.latestAt}): ${test.latestError ?? "no error message"}`,
      ...test.runs.slice(0, 3).map((url) => `   ${url}`),
      ...(test.runs.length > 3 ? [`   and ${test.runs.length - 3} more runs`] : []),
      "",
    );
  });
  console.log(lines.join("\n"));
}
