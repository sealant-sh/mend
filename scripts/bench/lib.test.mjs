import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  agentIdentityOf,
  asPersonCommand,
  chatGptLoginSkipOf,
  comparisonFails,
  inCleanupScope,
  overOwn,
  personVerdictsSkipped,
  requiredOf,
  classifySavedFiles,
  describeComparison,
  failedChecks,
  layoutOf,
  liveAgents,
  parsePersonProbe,
  PERSON_PROBE_SH,
  PERSON_STATE_PATHS,
  personVerdicts,
  PROFILE_DIGEST_SH,
  profileDigestOf,
  SAVED_SIZES_SH,
  tallyCheck,
  turnTimes,
  turnVerdicts,
  allowance,
  builtWithin,
  deliveryWindow,
  harnessVersionOf,
  compareResults,
  execCount,
  firstExecAt,
  formatComparison,
  formatTable,
  formatValue,
  harnessOf,
  mergeResults,
  milestoneName,
  milestonesOf,
  parseContainerDisk,
  parseDockerSize,
  parseDockerTime,
  parseDrainLine,
  parseFields,
  parseImageLine,
  parseMemUsage,
  parseMendLog,
  parseOptions,
  parseSealantdLog,
  quantile,
  RESOURCES_AT_FIRST_OUTPUT,
  restoreOf,
  scenarioOf,
  settleNotRun,
  sshRemoteOf,
  withCompanion,
  stagedBytesOf,
  stepsOf,
  stripAnsi,
  summarize,
  usageLimitOf,
} from "./lib.mjs";

// ─── statistics ─────────────────────────────────────────────────────────────

test("quantiles interpolate between neighbours, as numpy does by default", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  // (10 - 1) * 0.9 = 8.1 → 9 + 0.1 * (10 - 9)
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

test("a summary reads median, p90 and worst from unsorted samples and skips what is not a number", () => {
  const summary = summarize([30, 10, null, 20, Number.NaN, 40]);
  assert.equal(summary.n, 4);
  assert.equal(summary.median, 25);
  assert.equal(summary.worst, 40);
  assert.equal(summary.best, 10);
  assert.equal(summary.spread, 15);
  assert.ok(Math.abs(summary.p90 - 37) < 1e-9);
  assert.deepEqual(summarize([]), {
    n: 0,
    median: null,
    p90: null,
    worst: null,
    best: null,
    mean: null,
    spread: null,
  });
});

// ─── text ───────────────────────────────────────────────────────────────────

test("terminal output loses its escape sequences", () => {
  assert.equal(stripAnsi("\x1b[1;32mok\x1b[0m \x1b]0;title\x07done\x1b(B"), "ok done");
});

test("docker sizes and stats read as bytes", () => {
  assert.equal(parseDockerSize("3.59GB"), 3_590_000_000);
  assert.equal(parseDockerSize("1.5GiB"), 1_610_612_736);
  assert.equal(parseDockerSize("102kB"), 102_000);
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("lots"), null);
  assert.equal(parseContainerDisk("3.59GB (virtual 6.69GB)"), 3_590_000_000);
  assert.equal(parseMemUsage("1.094GiB / 39.17GiB"), Math.round(1.094 * 1024 ** 3));
});

// ─── Mend's log ─────────────────────────────────────────────────────────────

const SESSION = "5d129924-ce93-4873-9338-abb54fee2863";
const WORKSPACE = "04f0800c-5d7b-4716-b494-11aa67a0a24c";

const MEND_LOG = [
  "2026-10-05T22:05:31.000000000Z mend bundle: starting",
  "2026-10-05T22:05:31.500000000Z [22:05:31.500] INFO (#81830) http.span=4ms: Sent HTTP response {",
  "2026-10-05T22:05:31.500100000Z   'http.method': 'POST',",
  `2026-10-05T22:05:31.500200000Z   'http.url': '/v1/workspaces/${WORKSPACE}/exec',`,
  "2026-10-05T22:05:31.500300000Z   'http.status': 200",
  "2026-10-05T22:05:31.500400000Z }",
  "2026-10-05T22:05:36.750000000Z [22:05:36.750] INFO (#81901): session engine: harness warm-up · read {",
  `2026-10-05T22:05:36.750100000Z   sessionId: '${SESSION}',`,
  "2026-10-05T22:05:36.750200000Z   harness: 'claude',",
  "2026-10-05T22:05:36.750300000Z   exitCode: 0,",
  "2026-10-05T22:05:36.750400000Z   elapsedMs: 423",
  "2026-10-05T22:05:36.750500000Z }",
  "2026-10-05T22:05:37.000000000Z [22:05:37.000] INFO (#81830) http.span=3ms: Sent HTTP response {",
  "2026-10-05T22:05:37.000100000Z   'http.method': 'POST',",
  `2026-10-05T22:05:37.000200000Z   'http.url': '/v1/workspaces/${WORKSPACE}/exec',`,
  "2026-10-05T22:05:37.000300000Z   'http.status': 200",
  "2026-10-05T22:05:37.000400000Z }",
  "2026-10-05T22:05:39.700000000Z [22:05:39.700] INFO (#81902): session engine: agent memory · delivered {",
  `2026-10-05T22:05:39.700100000Z   sessionId: '${SESSION}',`,
  "2026-10-05T22:05:39.700200000Z   written: 146,",
  "2026-10-05T22:05:39.700300000Z   errors: ''",
  "2026-10-05T22:05:39.700400000Z }",
  "2026-10-05T22:05:40.100000000Z [22:05:40.100] INFO (#81903): session engine: workspace note · created {",
  `2026-10-05T22:05:40.100100000Z   workspaceId: '${WORKSPACE}',`,
  "2026-10-05T22:05:40.100200000Z   file: '/root/.claude/CLAUDE.md'",
  "2026-10-05T22:05:40.100300000Z }",
  "2026-10-05T22:05:40.200000000Z [22:05:40.200] INFO (#81904): session engine: workspace note · created {",
  `2026-10-05T22:05:40.200100000Z   workspaceId: '${WORKSPACE}',`,
  "2026-10-05T22:05:40.200200000Z   file: '/root/.codex/AGENTS.md'",
  "2026-10-05T22:05:40.200300000Z }",
  "2026-10-05T22:05:54.170000000Z [22:05:54.170] INFO (#81905): session engine: dependency install · completed · exit 0 {",
  `2026-10-05T22:05:54.170100000Z   sessionId: '${SESSION}',`,
  "2026-10-05T22:05:54.170200000Z   command: 'pnpm install --frozen-lockfile'",
  "2026-10-05T22:05:54.170300000Z }",
  "2026-10-05T22:05:55.000000000Z [22:05:55.000] INFO (#81906): session engine: dependency install · completed {",
  "2026-10-05T22:05:55.000100000Z   sessionId: 'someone-else'",
  "2026-10-05T22:05:55.000200000Z }",
].join("\n");

const at = (iso) => Date.parse(iso);

test("Mend's log parses into entries with their docker time, span and fields", () => {
  const blocks = parseMendLog(MEND_LOG);
  assert.equal(blocks.length, 8);
  assert.equal(blocks[0].spanMs, 4);
  assert.equal(blocks[0].fields["http.url"], `/v1/workspaces/${WORKSPACE}/exec`);
  assert.equal(blocks[1].message, "session engine: harness warm-up · read");
  assert.equal(blocks[1].at, at("2026-10-05T22:05:36.750Z"));
  assert.deepEqual(blocks[1].fields, {
    sessionId: SESSION,
    harness: "claude",
    exitCode: 0,
    elapsedMs: 423,
  });
});

test("fields keep quoted text whole and read numbers, booleans and null", () => {
  assert.deepEqual(parseFields("{ a: 'x, y', 'b.c': 2, d: true, e: null, f: \"q\" }"), {
    a: "x, y",
    "b.c": 2,
    d: true,
    e: null,
    f: "q",
  });
});

test("the executor's commands are counted and its first one found", () => {
  const blocks = parseMendLog(MEND_LOG);
  const from = at("2026-10-05T22:05:31Z");
  assert.equal(execCount(blocks, WORKSPACE, from, at("2026-10-05T22:06:00Z")), 2);
  assert.equal(
    execCount(blocks, WORKSPACE, at("2026-10-05T22:05:32Z"), at("2026-10-05T22:06:00Z")),
    1,
  );
  assert.equal(firstExecAt(blocks, WORKSPACE, from), at("2026-10-05T22:05:31.5Z"));
  assert.equal(firstExecAt(blocks, "other", from), null);
});

test("milestones are one session's engine lines, named without the evidence word, once each", () => {
  assert.equal(
    milestoneName("session engine: dependency install · completed · exit 0"),
    "dependency install · completed",
  );
  assert.equal(
    milestoneName("session engine: capture flush · final · observed"),
    "capture flush · final",
  );
  assert.equal(milestoneName("capture mode: drain requested"), "capture mode · drain requested");
  const milestones = milestonesOf(parseMendLog(MEND_LOG), {
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    fromMs: at("2026-10-05T22:05:31Z"),
    toMs: at("2026-10-05T22:06:00Z"),
  });
  assert.deepEqual(
    milestones.map((milestone) => milestone.name),
    [
      "harness warm-up · read",
      "agent memory · delivered",
      "workspace note · created",
      "dependency install · completed",
    ],
  );
});

test("steps are the time between consecutive milestones, named for where they end", () => {
  const start = 1000;
  const steps = stepsOf(start, [
    { name: "b", at: 4000 },
    { name: "early", at: 500 },
    { name: "a", at: 1500 },
  ]);
  assert.deepEqual(steps, [
    { name: "a", ms: 500 },
    { name: "b", ms: 2500 },
  ]);
});

test("the worker's drain line and the image line read as numbers", () => {
  assert.deepEqual(
    parseDrainLine(
      "Capture drain (stop) · run 6739589b-b948-4635-83ea-4091d7787bce: saved · pending 0 · 1200 bytes to ship · staged 3400 bytes · uploaded 5600 bytes · registered 3",
    ),
    {
      why: "stop",
      executor: "6739589b-b948-4635-83ea-4091d7787bce",
      pending: 0,
      toShipBytes: 1200,
      stagedBytes: 3400,
      uploadedBytes: 5600,
      registered: 3,
    },
  );
  assert.equal(parseDrainLine("Capture drain (stop) · run x: still going"), null);
  assert.deepEqual(
    parseImageLine(
      "Workspace image plan unchanged (hash 0123abcd); built before, reusing sha256:43ad900d800a",
    ),
    { plan: "unchanged", hash: "0123abcd", image: "sha256:43ad900d800a" },
  );
});

// ─── sealantd's log ─────────────────────────────────────────────────────────

const SEALANTD_LOG = [
  "2026-10-05T22:10:06.000000000Z 2026-10-05T22:10:06.000100Z  INFO sealantd::boot::capture: capture plan fetched worktree=8763c02e epoch=1 head=Some(4) bulk_pending=false",
  "2026-10-05T22:10:25.500000000Z 2026-10-05T22:10:25.500100Z  INFO sealantd::boot::capture: capture head materialized files=41022 bytes=2412345678 files_skipped=0 bytes_skipped=0 removed=0 git_packs=3 fsck=None",
  "2026-10-05T22:11:00.000000000Z 2026-10-05T22:11:00.000100Z  INFO sealant_capture::engine: capture staged n=5 kind=Flush class=Small elapsed_ms=40 staged_bytes=1000 files_read=3 chunks_new=2",
  "2026-10-05T22:11:30.000000000Z 2026-10-05T22:11:30.000100Z  INFO sealant_capture::engine: capture staged n=6 kind=Flush class=Small elapsed_ms=41 staged_bytes=500 files_read=1 chunks_new=1",
  "2026-10-05T22:11:31.000000000Z 2026-10-05T22:11:31.000100Z  INFO sealant_capture::engine: capture staged n=7 kind=Final class=Bulk elapsed_ms=900 staged_bytes=70000 files_read=10 chunks_new=9",
  "2026-10-05T22:11:32.000000000Z not a tracing line",
].join("\n");

test("sealantd's lines parse into message and fields, timed by sealantd's own clock", () => {
  const events = parseSealantdLog(SEALANTD_LOG);
  assert.equal(events.length, 5);
  assert.equal(events[0].message, "capture plan fetched");
  assert.equal(events[0].target, "sealantd::boot::capture");
  assert.equal(events[0].fields.head, "Some(4)");
  assert.equal(events[1].fields.bytes, 2_412_345_678);
});

test("the restore is the plan's arrival to the head on disk, with its bytes and files", () => {
  assert.deepEqual(restoreOf(parseSealantdLog(SEALANTD_LOG)), {
    ms: 19_500,
    bytes: 2_412_345_678,
    files: 41_022,
    head: "Some(4)",
  });
  assert.equal(restoreOf([]), null);
});

test("staged bytes add up per capture class", () => {
  assert.deepEqual(stagedBytesOf(parseSealantdLog(SEALANTD_LOG)), { small: 1500, bulk: 70_000 });
});

// ─── budgets and the comparison ─────────────────────────────────────────────

const record = (measures) => ({ measures, notRun: [], notes: [], errors: [] });
const tenOf = (value) => Array.from({ length: 10 }, () => value);

test("an allowance is the larger of the share and the fixed amount, or the baseline's spread", () => {
  assert.equal(allowance("start", { median: 30_000 }, "median"), 1500);
  assert.equal(allowance("start", { median: 5000 }, "median"), 1000);
  assert.equal(allowance("join-other", { median: 90_000 }, "median"), 3000);
  assert.equal(allowance("bytes", { p90: 1_000_000 }, "p90"), 50_000);
  assert.equal(allowance("api", { median: 100 }, "median"), 20);
  assert.equal(allowance("interactive", { spread: 12 }, "median"), 50);
  assert.equal(allowance("interactive", { spread: 400 }, "p90"), 400);
  assert.equal(allowance("nothing", { median: 1 }, "median"), null);
});

test("the comparison checks the median and the p90 of every budgeted measure", () => {
  const before = record({
    "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(30_000) },
    "api.session_list": { unit: "ms", budget: "api", samples: tenOf(100) },
    "new.claude.step.x": { unit: "ms", budget: null, samples: tenOf(1) },
  });
  const within = record({
    "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(31_400) },
    "api.session_list": { unit: "ms", budget: "api", samples: tenOf(119) },
  });
  const ok = compareResults(before, within);
  assert.equal(ok.rows.length, 4);
  assert.equal(ok.misses.length, 0);

  const over = record({
    "new.claude.first_output": {
      unit: "ms",
      budget: "start",
      samples: [...tenOf(31_000).slice(0, 8), 40_000, 40_000],
    },
  });
  const result = compareResults(before, over);
  const firstOutput = result.rows.filter((row) => row.measure === "new.claude.first_output");
  assert.deepEqual(
    firstOutput.map((row) => [row.stat, row.ok]),
    [
      ["median", true],
      ["p90", false],
    ],
  );
  // A measure the second run lacks cannot be inside its limit.
  const missing = result.rows.filter((row) => row.measure === "api.session_list");
  assert.ok(missing.every((row) => row.missing && !row.ok));
  assert.equal(result.misses.length, 3);
  assert.match(
    formatComparison(result),
    /\| new\.claude\.first_output \| p90 \| 30\.0 s \| 40\.0 s \| 31\.5 s \| OVER \|/,
  );
  assert.match(formatComparison(result), /MISSING/);
});

test("the worst is compared only when asked", () => {
  const before = record({ m: { unit: "ms", budget: "api", samples: tenOf(100) } });
  // One slow sample in twenty moves neither the median nor the p90.
  const after = record({
    m: { unit: "ms", budget: "api", samples: [...tenOf(100), ...tenOf(100).slice(0, 9), 500] },
  });
  assert.equal(compareResults(before, after).misses.length, 0);
  assert.equal(compareResults(before, after, { stats: ["worst"] }).misses.length, 1);
});

// ─── tables ─────────────────────────────────────────────────────────────────

test("values print in their unit", () => {
  assert.equal(formatValue(null, "ms"), "–");
  assert.equal(formatValue(842.4, "ms"), "842 ms");
  assert.equal(formatValue(1234, "ms"), "1.23 s");
  assert.equal(formatValue(27_100, "ms"), "27.1 s");
  assert.equal(formatValue(512, "bytes"), "512 B");
  assert.equal(formatValue(2_412_345_678, "bytes"), "2.41 GB");
  assert.equal(formatValue(146, "count"), "146");
});

test("the table has the median, p90 and worst of each measure, and says what did not run", () => {
  const table = formatTable({
    measures: {
      "resume.first_output": { unit: "ms", budget: "start", samples: [34_000, 36_000, 35_000] },
      empty: { unit: "ms", budget: null, samples: [] },
    },
    notRun: [{ measure: "join.other.first_output", reason: "second account not yet joined" }],
  });
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[2], "| resume.first_output | 3 | 35.0 s | 35.8 s | 36.0 s | +5% or +1 s |");
  assert.equal(
    lines[3],
    "| join.other.first_output | 0 | not run: second account not yet joined | | | |",
  );
});

// ─── results ────────────────────────────────────────────────────────────────

test("every measure maps to the scenario that re-takes it", () => {
  assert.equal(scenarioOf("new.codex.first_output"), "new");
  assert.equal(scenarioOf("executor.pi.disk_bytes"), "new");
  assert.equal(scenarioOf("executor.resumed.disk_bytes"), "resume");
  assert.equal(scenarioOf("stop.claude.save"), "stop");
  assert.equal(scenarioOf("stop.after_resume.save"), "resume");
  assert.equal(scenarioOf("resume.restore_bytes"), "resume");
  assert.equal(scenarioOf("join.same.first_output"), "join-same");
  assert.equal(scenarioOf("join.other.first_output"), "join-other");
  assert.equal(scenarioOf("terminal.echo"), "interactive");
  assert.equal(scenarioOf("git.push"), "interactive");
  assert.equal(scenarioOf("checkpoint.save"), "interactive");
  assert.equal(scenarioOf("cli.sessions"), "api");
  assert.equal(scenarioOf("something.else"), null);
});

test("a not-run entry goes once its measure has samples", () => {
  const settled = settleNotRun({
    measures: {
      "new.claude.delivery": { unit: "ms", samples: [1] },
      "new.pi.step.x": { unit: "ms", samples: [2] },
    },
    notRun: [
      { measure: "new.claude.delivery", reason: "r" },
      { measure: "new.pi.step.*", reason: "r" },
      { measure: "join.other.first_output", reason: "r" },
    ],
  });
  assert.deepEqual(
    settled.notRun.map((entry) => entry.measure),
    ["join.other.first_output"],
  );
});

test("a later run of one scenario replaces its measures and leaves the launches it needed alone", () => {
  const base = {
    startedAt: "a",
    measures: {
      "new.claude.first_output": { unit: "ms", budget: "start", samples: [1, 2, 3] },
      "api.session_list": { unit: "ms", budget: "api", samples: [5] },
      "join.other.stale": { unit: "ms", budget: null, samples: [1] },
    },
    notRun: [{ measure: "join.other.first_output", reason: "second account not yet joined" }],
    notes: ["base"],
    errors: [],
  };
  const extra = {
    startedAt: "b",
    options: { only: ["join-other"] },
    measures: {
      "new.claude.first_output": { unit: "ms", budget: "start", samples: [9] },
      "join.other.first_output": { unit: "ms", budget: "join-other", samples: [7, 8] },
    },
    notRun: [],
    notes: ["extra"],
    errors: [],
  };
  const merged = mergeResults(base, extra);
  assert.deepEqual(merged.measures["new.claude.first_output"].samples, [1, 2, 3]);
  assert.deepEqual(merged.measures["join.other.first_output"].samples, [7, 8]);
  assert.equal(merged.measures["join.other.stale"], undefined);
  assert.deepEqual(merged.measures["api.session_list"].samples, [5]);
  assert.deepEqual(merged.notRun, []);
  assert.deepEqual(merged.notes, ["base", "extra"]);
  assert.deepEqual(merged.merged, [
    { startedAt: "b", only: ["join-other"], measures: ["join.other.first_output"] },
  ]);
  // A re-run of missed measures takes exactly those.
  const rerun = mergeResults(base, extra, (name) => name === "new.claude.first_output");
  assert.deepEqual(rerun.measures["new.claude.first_output"].samples, [9]);
  assert.deepEqual(rerun.measures["join.other.stale"].samples, [1]);
  assert.equal(rerun.measures["join.other.first_output"], undefined);
});

// ─── options ────────────────────────────────────────────────────────────────

test("options default to the ADR's run counts and check what they name", () => {
  const opts = parseOptions(["run"], 0);
  assert.equal(opts.command, "run");
  assert.equal(opts.runs, 10);
  assert.equal(opts.interactiveRuns, 10);
  assert.deepEqual(opts.harnesses, ["claude", "codex", "pi", "opencode"]);
  assert.ok(opts.only.includes("join-other"));
  assert.equal(opts.out, "/tmp/st-bench-0.json");

  const scoped = parseOptions(
    ["run", "--only", "join-other", "--runs=3", "--second-token-file", "/tmp/t", "--secret-file"],
    0,
  );
  assert.deepEqual(scoped.only, ["join-other"]);
  assert.equal(scoped.runs, 3);
  assert.equal(scoped.secondTokenFile, "/tmp/t");
  assert.equal(scoped.secretFile, true);

  assert.equal(parseOptions(["compare", "a.json", "b.json"]).out, "b.rerun.json");
  assert.throws(() => parseOptions(["run", "--only", "everything"]), /unknown scenario/);
  assert.throws(() => parseOptions(["run", "--harnesses", "vim"]), /unknown harness/);
  assert.throws(() => parseOptions(["run", "--runs", "-1"]), /whole number/);
  assert.throws(() => parseOptions(["run", "--bogus"]), /unknown option/);
  assert.throws(() => parseOptions(["compare", "a.json"]), /needs 2/);
});

test("an origin is addressed in the SSH form the git shim carries", () => {
  assert.equal(
    sshRemoteOf("https://github.com/sealant-sh/mend.git"),
    "git@github.com:sealant-sh/mend.git",
  );
  assert.equal(
    sshRemoteOf("https://github.com/sealant-sh/mend"),
    "git@github.com:sealant-sh/mend.git",
  );
  assert.equal(sshRemoteOf("ssh://git@github.com:22/a/b.git"), "git@github.com:a/b.git");
  assert.equal(sshRemoteOf("git@github.com:a/b.git"), "git@github.com:a/b.git");
  assert.equal(sshRemoteOf("/srv/repo.git"), null);
});

const joinsOn = (median) => ({
  target: { project: { name: "dots" } },
  measures: { "join.other.first_output": { unit: "ms", budget: "join-other", samples: [median] } },
});

test("a run on another project rides inside the main record, in its table and its comparison", () => {
  const main = { measures: { "api.session_list": { unit: "ms", budget: "api", samples: [100] } } };
  const before = withCompanion(main, joinsOn(10_000));
  assert.match(
    formatTable(before),
    /On project dots:[\s\S]*join\.other\.first_output \| 1 \| 10\.0 s/,
  );
  const after = withCompanion(main, joinsOn(14_000));
  const comparison = compareResults(before, after);
  assert.deepEqual(
    comparison.misses.map((row) => [row.measure, row.stat]),
    [
      ["dots: join.other.first_output", "median"],
      ["dots: join.other.first_output", "p90"],
    ],
  );
  // The companion missing from a later record is a miss on both statistics.
  assert.equal(compareResults(before, main).misses.length, 2);
});

const m = (name, when) => ({ name, at: when });

test("delivery runs from the warm-up, or in a join from the step before it, to the last file", () => {
  assert.equal(
    deliveryWindow([
      m("harness warm-up · read", 1000),
      m("default shell profile · written", 1200),
      m("agent memory · delivered", 4000),
      m("secret file · written", 4400),
      m("dependency install · completed", 20_000),
    ]),
    3400,
  );
  assert.equal(
    deliveryWindow([
      m("capture flush · completed", 500),
      m("capture mode · joining the lease holder", 900),
      m("secret file · written", 1600),
    ]),
    700,
  );
  assert.equal(deliveryWindow([m("dependency install · completed", 1)]), null);
});

test("a harness's version is read from its own first screen", () => {
  assert.deepEqual(harnessVersionOf("  Claude Codev2.1.287  Fable 5.1"), {
    harness: "claude",
    version: "2.1.287",
  });
  assert.deepEqual(harnessVersionOf(">_ OpenAI Codex (v0.160.0)"), {
    harness: "codex",
    version: "0.160.0",
  });
  assert.equal(harnessVersionOf("$ "), null);
});

test("a re-run for some harnesses replaces only theirs", () => {
  assert.equal(harnessOf("stop.codex.save"), "codex");
  assert.equal(harnessOf("stop.after_resume.save"), null);
  assert.equal(harnessOf("executor.resumed.disk_bytes"), null);
  const base = {
    measures: {
      "stop.claude.save": { unit: "ms", samples: [1] },
      "stop.codex.save": { unit: "ms", samples: [2] },
      "stop.claude.stale": { unit: "ms", samples: [3] },
    },
  };
  const extra = {
    options: { only: ["stop"], harnesses: ["claude"] },
    measures: { "stop.claude.save": { unit: "ms", samples: [9] } },
  };
  const merged = mergeResults(base, extra);
  assert.deepEqual(Object.keys(merged.measures).toSorted(), [
    "stop.claude.save",
    "stop.codex.save",
  ]);
  assert.deepEqual(merged.measures["stop.claude.save"].samples, [9]);
});

// ─── what the record keeps apart ────────────────────────────────────────────

test("a harness's usage limit is read from its own words, its spaces drawn or not", () => {
  // Claude Code v2.1.291 at the owner's weekly limit (0.36.0-next.628), ANSI stripped.
  const claude = [
    "❯ What is 2 + 3? Reply with only the number. Do not use any tools.",
    "  ⎿  You've hit your weekly limit · resets 6pm (UTC)",
    "● Usage limit reached · continuing automatically at 6pm · esc to cancel",
  ].join("\n");
  assert.equal(usageLimitOf(claude), "You've hit your weekly limit · resets 6pm (UTC)");
  assert.equal(
    usageLimitOf("■ You’ve hit your usage limit. Upgrade to Pro or try again later."),
    "You’ve hit your usage limit. Upgrade to Pro or try again later.",
  );
  assert.equal(
    usageLimitOf("⚠ Usage limit reached · limit resets 6pm"),
    "Usage limit reached · limit resets 6pm",
  );
  assert.equal(
    usageLimitOf("5-hour limit reached ∙ resets 3am"),
    "5-hour limit reached ∙ resets 3am",
  );
  // A TUI that moves the cursor for its spaces leaves the words run together.
  assert.equal(usageLimitOf("You'vehityourweeklylimit·resets6pm"), "You'vehityourweeklylimit");
  // A request-rate 429 the harness retries by itself is not one: the agent is still in its turn.
  assert.equal(
    usageLimitOf(
      "stream error: Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000. Please try again in 2.1s.; retrying 1/5 in 2.1s…",
    ),
    null,
  );
  assert.equal(usageLimitOf("Rate limit exceeded. Retrying..."), null);
  assert.equal(usageLimitOf("Usage limit reached · retrying in 30s"), null);
  // Nor is ordinary text that names a limit.
  assert.equal(
    usageLimitOf("● The rate limit exceeded the quota, so the job was throttled."),
    null,
  );
  assert.equal(usageLimitOf("This module enforces a session limit of 5 per user."), null);
  // The prompt, an answer and a warning short of the limit are not one.
  assert.equal(usageLimitOf("❯ What is 2 + 3? Reply with only the number.\n● 5"), null);
  assert.equal(usageLimitOf("You've used 90% of your weekly limit · resets 6pm"), null);
});

test("an image made inside a launch's window is a build that launch waited for", () => {
  const created = parseDockerTime("2026-10-06T18:03:20.123456789Z");
  assert.equal(created, Date.parse("2026-10-06T18:03:20.123Z"));
  assert.equal(parseDockerTime("2026-10-06T18:03:20Z"), Date.parse("2026-10-06T18:03:20Z"));
  assert.equal(
    parseDockerTime("2026-10-06T20:03:20.5+02:00"),
    Date.parse("2026-10-06T18:03:20.5Z"),
  );
  // A reproducible build's zero time, or nothing at all, is no time.
  assert.equal(parseDockerTime("0001-01-01T00:00:00Z"), null);
  assert.equal(parseDockerTime(""), null);
  const launch = Date.parse("2026-10-06T18:02:38Z");
  const output = Date.parse("2026-10-06T18:04:05Z");
  assert.equal(builtWithin(created, launch, output), true);
  assert.equal(builtWithin(Date.parse("2026-10-05T17:12:00Z"), launch, output), false);
  assert.equal(builtWithin(null, launch, output), false);
});

test("a measure not run says why in the comparison, in place of MISSING", () => {
  const before = record({
    "new.claude.first_turn": { unit: "ms", budget: "start", samples: tenOf(30_000) },
    "new.codex.first_turn": { unit: "ms", budget: "start", samples: tenOf(20_000) },
  });
  const after = {
    ...record({}),
    notRun: [
      {
        measure: "new.claude.first_turn",
        reason: 'the harness\'s account hit its usage limit ("Usage limit reached")',
      },
    ],
  };
  const comparison = compareResults(before, after);
  // Still a miss: a number not taken is not inside its limit.
  assert.equal(comparison.misses.length, 4);
  const table = formatComparison(comparison);
  assert.match(table, /new\.claude\.first_turn \| median .*NOT RUN: the harness's account hit/);
  assert.match(table, /new\.codex\.first_turn \| median .*MISSING/);
});

test("executor sizes taken at another point of the launch are not compared", () => {
  const sizes = (memory) =>
    record({
      "executor.claude.memory_bytes": { unit: "bytes", budget: "resource", samples: tenOf(memory) },
      "executor.resumed.memory_bytes": {
        unit: "bytes",
        budget: "resource",
        samples: tenOf(memory),
      },
    });
  const older = sizes(1_100_000_000);
  const newer = { ...sizes(760_000_000), method: { executorResources: RESOURCES_AT_FIRST_OUTPUT } };
  const across = compareResults(older, newer);
  assert.deepEqual(across.incomparable, [
    {
      measure: "executor.claude.memory_bytes",
      reason: "sampled after the answer before and at first output after",
    },
  ]);
  // The resumed executor was always sized at its first output: still compared.
  assert.deepEqual(
    across.rows.map((row) => row.measure),
    ["executor.resumed.memory_bytes", "executor.resumed.memory_bytes"],
  );
  assert.match(
    formatComparison(across),
    /executor\.claude\.memory_bytes \| \| \| \| \| not comparable/,
  );
  // Two records that took it at the same point compare as before.
  const same = compareResults(newer, { ...newer, measures: sizes(800_000_000).measures });
  assert.equal(same.incomparable.length, 0);
  assert.equal(same.misses.length, 4);
});

const imageBuild = (image) => ({ image, createdAt: "2026-10-06T18:03:20Z", seenBy: "claude #1" });

test("a merge keeps every image built during either run", () => {
  const merged = mergeResults(
    { measures: {}, imageBuilds: [imageBuild("sha256:a")] },
    { options: { only: ["new"] }, measures: {}, imageBuilds: [imageBuild("sha256:b")] },
  );
  assert.deepEqual(
    merged.imageBuilds.map((entry) => entry.image),
    ["sha256:a", "sha256:b"],
  );
});

test("a merge keeps the point each record sampled its executor sizes at", () => {
  const memory = (value) => ({
    "executor.claude.memory_bytes": { unit: "bytes", budget: "resource", samples: tenOf(value) },
    "executor.codex.memory_bytes": { unit: "bytes", budget: "resource", samples: tenOf(value) },
  });
  // An older record (sized after the answer) with a newer run of claude (sized at first output).
  const older = record(memory(1_100_000_000));
  const newer = {
    ...record({
      "executor.claude.memory_bytes": {
        unit: "bytes",
        budget: "resource",
        samples: tenOf(760_000_000),
      },
    }),
    options: { only: ["new"], harnesses: ["claude"] },
    method: { executorResources: RESOURCES_AT_FIRST_OUTPUT },
  };
  const merged = mergeResults(older, newer);
  assert.equal(merged.measures["executor.claude.memory_bytes"].sampledAt, "at first output");
  assert.equal(merged.measures["executor.codex.memory_bytes"].sampledAt, "after the answer");
  // Against the older record, claude's is not comparable and codex's is.
  const compared = compareResults(older, merged);
  assert.deepEqual(
    compared.incomparable.map((entry) => entry.measure),
    ["executor.claude.memory_bytes"],
  );
  assert.deepEqual(
    [...new Set(compared.rows.map((row) => row.measure))],
    ["executor.codex.memory_bytes"],
  );
});

// ─── layouts and gate P1 (docs/adr/0016, "Method") ──────────────────────────

const layoutRecord = (layout, version, measures, extra = {}) => ({
  options: { layout },
  target: {
    url: "https://alpha.mend.run",
    version,
    commit: "abc1234def",
    flag: "shared (MEND_HARNESS_LAYOUT unset)",
    mendImage: "mend:next sha256:aaaaaaaaaaaa",
    layout,
    project: { id: "p" },
    workspaceImage: "sha256:a",
    harnessVersions: { claude: "2.1.287" },
  },
  measures,
  notRun: [],
  notes: [],
  errors: [],
  checks: [],
  ...extra,
});

test("--layout takes person or shared, and the per-person scenarios are scenarios", () => {
  assert.equal(parseOptions(["run"]).layout, null);
  assert.equal(parseOptions(["run", "--layout", "person"]).layout, "person");
  assert.equal(parseOptions(["run", "--layout=shared"]).layout, "shared");
  assert.throws(() => parseOptions(["run", "--layout", "root"]), /person or shared/);
  assert.deepEqual(parseOptions(["run", "--only", "handover,growth,person-checks"]).only, [
    "handover",
    "growth",
    "person-checks",
  ]);
  assert.ok(parseOptions(["run"]).only.includes("person-checks"));
});

test("a record's layout is what its launches asked for, or the server's flag", () => {
  assert.equal(layoutOf(layoutRecord("person", "1")), "person");
  assert.equal(layoutOf({ options: { layout: null }, target: { flag: "person" } }), "person");
  assert.equal(
    layoutOf({ options: { layout: null }, target: { flag: "shared (MEND_HARNESS_LAYOUT unset)" } }),
    "shared",
  );
  assert.equal(layoutOf({ target: { flag: "unknown (no host access)" } }), null);
});

test("a comparison says whether it is gate P1, its named check, or a plain before and after", () => {
  const shared = layoutRecord("shared", "0.36.0-next.648", {});
  const person = layoutRecord("person", "0.36.0-next.648", {});
  const gate = describeComparison(shared, person);
  assert.equal(gate.kind, "gate P1: person launches against shared launches");
  assert.equal(gate.before, "shared · 0.36.0-next.648 (abc1234de) · sha256:aaaaaaaaaaaa");
  assert.deepEqual(gate.differs, []);
  assert.deepEqual(gate.warnings, []);
  // What P1 asks that the benchmark does not take is said, not implied.
  assert.equal(gate.notCovered.length, 1);
  assert.match(gate.notCovered[0], /largest worktree, interleaved/);

  // Any difference of build, instance, project, image or harness version: not the gate.
  const rebuilt = layoutRecord("person", "0.36.0-next.648", {});
  rebuilt.target.mendImage = "mend:next sha256:bbbbbbbbbbbb";
  assert.match(
    describeComparison(shared, rebuilt).kind,
    /^gate P1: person launches against shared launches \(not the gate: the Mend images differ/,
  );
  const elsewhere = layoutRecord("person", "0.36.0-next.648", {});
  elsewhere.target.url = "https://other.example";
  assert.match(describeComparison(shared, elsewhere).kind, /not the gate: different instances/);
  const otherProject = layoutRecord("person", "0.36.0-next.648", {});
  otherProject.target.project = { id: "q" };
  assert.match(describeComparison(shared, otherProject).kind, /not the gate: different projects/);
  const drifted = layoutRecord("person", "0.36.0-next.648", {});
  drifted.target.harnessVersions = { claude: "2.1.300" };
  drifted.target.workspaceImage = "sha256:b";
  const driftedLabel = describeComparison(shared, drifted);
  assert.deepEqual(driftedLabel.differs, [
    "the workspace images differ (sha256:a and sha256:b)",
    "claude ran 2.1.287 before and 2.1.300 after",
  ]);
  assert.match(driftedLabel.kind, /not the gate/);
  // A harness one side has no version for is warned of.
  const withPi = layoutRecord(
    "person",
    "0.36.0-next.648",
    {},
    { options: { layout: "person", harnesses: ["claude", "pi"] } },
  );
  assert.deepEqual(describeComparison(shared, withPi).warnings, [
    "pi's version is not in either record",
  ]);
  // Without the image's id or a commit, the build is told apart by its version only, said so.
  const bare = (layout, version) => {
    const unknown = layoutRecord(layout, version, {});
    unknown.target.mendImage = null;
    unknown.target.commit = "unknown";
    return unknown;
  };
  const versionOnly = describeComparison(bare("shared", "1"), bare("person", "1"));
  assert.equal(versionOnly.kind, "gate P1: person launches against shared launches");
  assert.ok(versionOnly.warnings.some((warning) => /version only/.test(warning)));
  assert.ok(versionOnly.warnings.some((warning) => /baseline's commit is unknown/.test(warning)));
  assert.match(
    describeComparison(bare("shared", "1"), bare("person", "2")).kind,
    /not the gate: the versions differ/,
  );

  const older = layoutRecord("shared", "0.36.0-next.602", {});
  older.target.mendImage = "mend:next sha256:cccccccccccc";
  assert.equal(
    describeComparison(older, shared).kind,
    "gate P1's named check: shared launches against an earlier shared record",
  );
  assert.match(describeComparison(person, shared).kind, /reversed/);
  const formatted = formatComparison(compareResults(shared, person));
  assert.match(formatted, /^gate P1: person launches against shared launches\nbefore: shared/);
  assert.match(formatted, /not covered by this comparison: restore wall time/);
});

const PERSON_OPTIONS = {
  layout: "person",
  only: ["new", "join-other", "handover", "growth", "person-checks"],
  harnesses: ["claude", "pi"],
};
const PERSON_CHECKS = ["runs_as", "uid", "home", "agent_process"];
const passing = (names) =>
  names.map((check) => ({ check, passed: 1, failed: 0, skipped: 0, detail: null, failures: [] }));
const completePerson = () =>
  layoutRecord(
    "person",
    "1",
    {
      "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(30_500) },
      "join.other.first_output": { unit: "ms", budget: "join-other", samples: tenOf(20_000) },
      "handover.claude.to_other.first_output_over_own": {
        unit: "ms",
        budget: "handover",
        samples: [...tenOf(3000).slice(0, 9), 6000],
      },
      "handover.claude.back.first_output_over_own": {
        unit: "ms",
        budget: "handover",
        samples: tenOf(1000),
      },
      "growth.claude.extra_person_beyond_state_bytes": {
        unit: "bytes",
        budget: "growth",
        samples: tenOf(1000),
      },
      "growth.pi.extra_person_beyond_state_bytes": {
        unit: "bytes",
        budget: "growth",
        samples: tenOf(2000),
      },
    },
    {
      options: PERSON_OPTIONS,
      checks: passing([
        ...["to_other", "back"].flatMap((kind) =>
          ["billed", "runs_as", "one_agent", "completed"].map(
            (check) => `handover.claude.${kind}.${check}`,
          ),
        ),
        ...["claude", "pi", "pi.joined"].flatMap((who) =>
          PERSON_CHECKS.map((check) => `person.${who}.${check}`),
        ),
      ]),
    },
  );
const sharedBaseline = () =>
  layoutRecord("shared", "1", {
    "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(30_000) },
    "join.other.first_output": { unit: "ms", budget: "join-other", samples: tenOf(19_000) },
  });

test("a person record that carries everything it was asked for passes, ceilings on itself", () => {
  const result = compareResults(sharedBaseline(), completePerson());
  const row = (measure, stat) =>
    result.rows.find((entry) => entry.measure === measure && entry.stat === stat);
  assert.equal(row("handover.claude.to_other.first_output_over_own", "median").ok, true);
  assert.equal(row("handover.claude.to_other.first_output_over_own", "median").limit, 5000);
  assert.equal(row("handover.claude.to_other.first_output_over_own", "median").before, null);
  // (10 - 1) * 0.9 = 8.1 → 3000 + 0.1 * 3000
  assert.ok(
    Math.abs(row("handover.claude.to_other.first_output_over_own", "p90").after - 3300) < 1e-6,
  );
  assert.equal(row("growth.pi.extra_person_beyond_state_bytes", "median").limit, 65_536);
  assert.equal(row("join.other.first_output", "median").ok, true);
  assert.deepEqual(result.misses, []);
  assert.deepEqual(result.checksNotVerified, []);
  assert.equal(comparisonFails(result), false);
  assert.equal(allowance("handover", { median: 1 }, "median"), null);
  assert.match(
    formatTable(completePerson()),
    /first_output_over_own \| 10 \|.*\| under 5 s over the owner's own turn \|/,
  );
  // Over its ceiling is a miss.
  const over = completePerson();
  over.measures["growth.claude.extra_person_beyond_state_bytes"].samples = tenOf(70_000);
  assert.equal(comparisonFails(compareResults(sharedBaseline(), over)), true);
});

test("gate P1 fails when the person-only measures, checks or the join never ran or crashed", () => {
  // Started without the second token: hand-over, growth and the join not run, an error beside.
  const bare = layoutRecord(
    "person",
    "1",
    { "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(30_000) } },
    {
      options: PERSON_OPTIONS,
      notRun: [
        { measure: "handover.*", reason: "second account not yet joined" },
        { measure: "growth.*", reason: "second account not yet joined" },
        { measure: "join.other.first_output", reason: "second account not yet joined" },
      ],
      errors: [{ scenario: "person-checks", message: "boom" }],
    },
  );
  const result = compareResults(sharedBaseline(), bare);
  assert.deepEqual([...new Set(result.misses.map((row) => row.measure))].toSorted(), [
    "growth.claude.extra_person_beyond_state_bytes",
    "growth.pi.extra_person_beyond_state_bytes",
    "handover.claude.back.first_output_over_own",
    "handover.claude.to_other.first_output_over_own",
    "join.other.first_output",
  ]);
  assert.ok(result.misses.every((row) => row.notRun === "second account not yet joined"));
  assert.equal(result.checksNotVerified.length, 8 + 12);
  assert.equal(result.errors.length, 1);
  assert.equal(comparisonFails(result), true);
  const formatted = formatComparison(result);
  assert.match(formatted, /NOT RUN: second account not yet joined/);
  assert.match(formatted, /Errors in the run under test:\n\n- person-checks: boom/);
  assert.match(formatted, /Not run in the run under test:/);
  assert.match(formatted, /must hold and did not show holding/);
  // An error alone fails it.
  const crashed = completePerson();
  crashed.errors = [{ scenario: "growth.pi #3", message: "find exited 1" }];
  assert.equal(comparisonFails(compareResults(sharedBaseline(), crashed)), true);
  // A check seen only skipped (no host) is not verified; a baseline without the join cannot vouch.
  const noHost = completePerson();
  noHost.checks.find((check) => check.check === "person.pi.home").passed = 0;
  noHost.checks.find((check) => check.check === "person.pi.home").skipped = 1;
  assert.deepEqual(
    compareResults(sharedBaseline(), noHost).checksNotVerified.map((entry) => entry.check),
    ["person.pi.home"],
  );
  assert.match(
    formatComparison(compareResults(sharedBaseline(), noHost)),
    /Skipped checks of the run under test/,
  );
  const noJoin = sharedBaseline();
  delete noJoin.measures["join.other.first_output"];
  const unbaselined = compareResults(noJoin, completePerson()).misses.filter(
    (row) => row.measure === "join.other.first_output",
  );
  assert.ok(
    unbaselined.length === 2 && unbaselined.every((row) => /baseline has no/.test(row.notRun)),
  );
  // A shared record, or a person one that asked for none of it, needs none of it.
  assert.deepEqual(requiredOf(sharedBaseline()), { measures: [], checks: [] });
  assert.deepEqual(
    requiredOf(
      layoutRecord(
        "person",
        "1",
        {},
        { options: { layout: "person", only: ["new"], harnesses: ["claude"] } },
      ),
    ),
    { measures: [], checks: [] },
  );
});

// ─── checks ─────────────────────────────────────────────────────────────────

test("checks are tallied per name, keep a few failures, and fail a comparison", () => {
  const checks = [];
  tallyCheck(checks, "handover.claude.to_other.billed", true, "billed to b");
  tallyCheck(checks, "handover.claude.to_other.billed", true, "billed to b");
  for (let k = 0; k < 7; k += 1) tallyCheck(checks, "person.pi.home", false, `home /root ${k}`);
  assert.deepEqual(
    checks.map((check) => [check.check, check.passed, check.failed, check.failures.length]),
    [
      ["handover.claude.to_other.billed", 2, 0, 0],
      ["person.pi.home", 0, 7, 5],
    ],
  );
  const person = layoutRecord("person", "1", {}, { checks });
  assert.deepEqual(
    failedChecks(person).map((check) => check.check),
    ["person.pi.home"],
  );
  const comparison = compareResults(layoutRecord("shared", "1", {}), person);
  assert.equal(comparison.checkFailures.length, 1);
  assert.match(formatComparison(comparison), /Failed checks of the run under test/);
  const table = formatTable(person);
  assert.match(table, /Checks \(observations, not timings\)/);
  // Failures first.
  assert.match(table, /\| person\.pi\.home \| 0 \| 7 \| 0 \| home \/root 0; [^\n]*\n\| handover/);
});

test("a re-run of a scenario stands for its checks", () => {
  const base = {
    measures: {},
    checks: [
      { check: "handover.claude.to_other.billed", passed: 0, failed: 1, failures: ["x"] },
      { check: "person.pi.home", passed: 1, failed: 0, failures: [] },
    ],
  };
  const extra = {
    options: { only: ["handover"] },
    measures: {},
    checks: [{ check: "handover.claude.to_other.billed", passed: 1, failed: 0, failures: [] }],
  };
  const merged = mergeResults(base, extra);
  assert.deepEqual(
    merged.checks.map((check) => [check.check, check.failed]),
    [
      ["person.pi.home", 0],
      ["handover.claude.to_other.billed", 0],
    ],
  );
  assert.equal(scenarioOf("person.pi.home"), "person-checks");
  assert.equal(scenarioOf("handover.codex.back.started"), "handover");
  assert.equal(scenarioOf("growth.pi.extra_person_bytes"), "growth");
  assert.equal(harnessOf("handover.codex.back.started"), "codex");
  assert.equal(harnessOf("growth.pi.extra_person_bytes"), "pi");
});

// ─── a steered turn ─────────────────────────────────────────────────────────

const TURN = {
  id: "t2",
  processId: "proc-b",
  author: "bob",
  status: "completed",
  error: null,
  billedUserId: "bob",
  billedAccountName: "default",
  createdAt: "2026-10-09T10:00:00.000Z",
  startedAt: "2026-10-09T10:00:03.250Z",
  endedAt: "2026-10-09T10:00:09.000Z",
};
const ITEMS = [
  {
    turnId: "t2",
    kind: "user-message",
    text: "What is 1 + 2?",
    createdAt: "2026-10-09T10:00:00.100Z",
  },
  { turnId: "t2", kind: "assistant-message", text: "9119", createdAt: "2026-10-09T10:00:05.500Z" },
  { turnId: "t2", kind: "reasoning", text: null, createdAt: "2026-10-09T10:00:04.000Z" },
  { turnId: "t1", kind: "assistant-message", text: "9119", createdAt: "2026-10-09T09:59:00.000Z" },
];

test("a turn is timed on the server's clock from its submit", () => {
  assert.deepEqual(turnTimes(TURN, ITEMS), { started: 3250, firstOutput: 4000, completed: 9000 });
  assert.deepEqual(turnTimes({ ...TURN, status: "failed", startedAt: null }, []), {
    started: null,
    firstOutput: null,
    completed: null,
  });
});

test("live agents are the agent processes that have not ended", () => {
  assert.equal(
    liveAgents([
      { kind: "agent-protocol", status: "running", exitedAt: null },
      { kind: "agent-protocol", status: "exited", exitedAt: "2026-10-09T10:00:00Z" },
      { kind: "shell", status: "running", exitedAt: null },
      { kind: "agent-pty", status: "starting", exitedAt: null },
    ]).length,
    2,
  );
});

test("a steered turn bills and runs as its sender, one agent at a time, and answers", () => {
  const verdicts = (overrides) =>
    Object.fromEntries(
      turnVerdicts({
        turn: TURN,
        process: { id: "proc-b", runsAs: "bob" },
        ownerId: "alice",
        fromOwner: false,
        maxLive: 1,
        answer: "9119",
        items: ITEMS,
        ...overrides,
      }).map((verdict) => [verdict.name, verdict.ok]),
    );
  assert.deepEqual(verdicts({}), {
    sender: true,
    billed: true,
    runs_as: true,
    one_agent: true,
    completed: true,
    answers: true,
  });
  const wrong = verdicts({
    turn: { ...TURN, billedUserId: "alice", status: "cancelled" },
    process: { id: "proc-a", runsAs: "alice" },
    maxLive: 2,
    answer: "1234",
  });
  assert.deepEqual(wrong, {
    sender: true,
    billed: false,
    runs_as: false,
    one_agent: false,
    completed: false,
    answers: false,
  });
  assert.equal(verdicts({ fromOwner: true }).sender, false);
  assert.equal(verdicts({ process: null }).runs_as, false);
});

// ─── a person in an executor ────────────────────────────────────────────────

const PROBE = [
  "probe uid 40002",
  "probe user mabcdefgh /home/mabcdefgh",
  "probe home-stat 40002 700",
  "probe proc pi",
  "probe proc node",
  "probe login openai-codex present 40002 600 1 /home/mabcdefgh/.pi/agent/auth.json",
  "probe login openai present 40002 600 1 /home/mabcdefgh/.mend/opencode/auth.json",
  `probe pi-profile present 40002 755 3 ${"b".repeat(64)}`,
].join("\n");

test("the probe's lines read as one person", () => {
  const probe = parsePersonProbe(PROBE);
  assert.equal(probe.uid, 40002);
  assert.equal(probe.home, "/home/mabcdefgh");
  assert.equal(probe.homeMode, "700");
  assert.deepEqual(probe.processes, ["pi", "node"]);
  assert.deepEqual(probe.logins.openai, {
    present: true,
    owner: 40002,
    mode: "600",
    unreadable: false,
    keyLines: 1,
    realPath: "/home/mabcdefgh/.mend/opencode/auth.json",
  });
  assert.equal(probe.piProfile.digest, "b".repeat(64));
  assert.equal(parsePersonProbe("probe saved absent\nsize absent").saved, false);
  assert.deepEqual(parsePersonProbe("probe pi-profile absent").piProfile, { present: false });
});

test("a person launch runs as the person, at home, on their own login and pi profile", () => {
  const said = { uid: 40002, home: "/home/mabcdefgh" };
  const verdicts = (overrides, probeText = PROBE) =>
    Object.fromEntries(
      personVerdicts({
        probe: parsePersonProbe(probeText),
        harness: "pi",
        agentSaid: said,
        piDigest: "b".repeat(64),
        ...overrides,
      }).map((verdict) => [verdict.name, verdict.ok]),
    );
  assert.deepEqual(verdicts({}), {
    uid: true,
    home: true,
    agent_process: true,
    agent_identity: true,
    chatgpt_login: true,
    pi_profile: true,
  });
  // B's pi beside A's: B's own profile, not A's, and another uid.
  assert.deepEqual(verdicts({ otherPiDigest: "a".repeat(64), otherUid: 40001 }), {
    uid: true,
    home: true,
    agent_process: true,
    agent_identity: true,
    chatgpt_login: true,
    pi_profile: true,
    pi_profile_not_other: true,
  });
  const onA = verdicts({
    piDigest: "c".repeat(64),
    otherPiDigest: "b".repeat(64),
    otherUid: 40002,
  });
  assert.equal(onA.pi_profile, false);
  assert.equal(onA.pi_profile_not_other, false);
  assert.equal(onA.uid, false);
  // Root's home, a login saved under the worktree, the agent elsewhere.
  const wrong = verdicts(
    { agentSaid: { uid: 0, home: "/root" } },
    PROBE.replace("home-stat 40002 700", "home-stat 40002 755").replace(
      "/home/mabcdefgh/.pi/agent/auth.json",
      "/workspace/harness-home/people/b/.pi/agent/auth.json",
    ),
  );
  assert.equal(wrong.home, false);
  assert.equal(wrong.chatgpt_login, false);
  assert.equal(wrong.agent_identity, false);
  // A person with no profile has none delivered; one with no saved directory fails at once.
  assert.equal(verdicts({ piDigest: null }).pi_profile, false);
  assert.equal(
    verdicts({ piDigest: null }, PROBE.replace(/probe pi-profile[^\n]*/, "probe pi-profile absent"))
      .pi_profile,
    true,
  );
  assert.deepEqual(verdicts({}, "probe saved absent"), { saved_dir: false });
  // Claude has no ChatGPT login or pi profile to check.
  const claude = personVerdicts({
    probe: parsePersonProbe(PROBE),
    harness: "claude",
    agentSaid: said,
  });
  assert.deepEqual(
    claude.map((verdict) => verdict.name),
    ["uid", "home", "agent_process", "agent_identity"],
  );
});

test("the agent's own uid and HOME are read from its screen, not from the prompt", () => {
  assert.deepEqual(
    agentIdentityOf("> echo ST-BENCH-ID $(id -u) $HOME\n ST-BENCH-ID 40001 /home/m1\n"),
    {
      uid: 40001,
      home: "/home/m1",
    },
  );
  assert.deepEqual(agentIdentityOf("│ST-BENCH-ID40001/home/m1│"), { uid: 40001, home: "/home/m1" });
  assert.equal(agentIdentityOf("echo ST-BENCH-ID $(id -u) $HOME"), null);
});

test("the probe's pi profile digest is Mend's stored digest, node_modules left out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "st-bench-profile-"));
  try {
    const files = [
      { path: "settings.json", bytes: Buffer.from('{"packages":[]}\n') },
      { path: "extensions/a b.ts", bytes: Buffer.from("export {}\n") },
      { path: "root/mcp.json", bytes: Buffer.from("{}") },
      { path: "Z.md", bytes: Buffer.from("upper case sorts first\n") },
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
      writeFileSync(path.join(dir, file.path), file.bytes);
    }
    // What the session installs is not part of it.
    mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/x/index.js"), "1");
    mkdirSync(path.join(dir, "extensions/node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "extensions/node_modules/y.js"), "2");
    const out = execFileSync("sh", [
      "-c",
      `${PROFILE_DIGEST_SH}\nprintf '%s %s\\n' "$(profile_files "$1")" "$(profile_digest "$1")"`,
      "st-bench",
      dir,
    ])
      .toString()
      .trim();
    assert.equal(out, `4 ${profileDigestOf(files)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the probes are shell the executor can parse, and reach it intact through the host", () => {
  execFileSync("sh", ["-n", "-c", PERSON_PROBE_SH]);
  execFileSync("sh", ["-n", "-c", SAVED_SIZES_SH]);
  assert.throws(() => asPersonCommand("sealant-x", "a; rm -rf /", "true"), /not an id/);
  // A docker that runs the command here: `stat` answers a uid, `exec -u <uid> <c> …` runs `…`.
  const bin = mkdtempSync(path.join(tmpdir(), "st-bench-docker-"));
  try {
    writeFileSync(
      path.join(bin, "docker"),
      [
        "#!/bin/sh",
        "shift",
        'if [ "$1" = "-u" ]; then echo "as $2" >&2; shift 2; fi',
        "shift",
        'case "$1" in stat) echo 40003;; *) exec "$@";; esac',
      ].join("\n"),
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    const command = asPersonCommand(
      "sealant-1",
      "acc-1",
      `printf '%s|%s\\n' "$1" "it's \\"quoted\\" $(echo ok)"`,
    );
    const out = execFileSync("sh", ["-c", command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    assert.equal(out, `acc-1|it's "quoted" ok\n`);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// ─── growth per extra person ────────────────────────────────────────────────

test("a saved directory splits into conversation state and the rest, machine state left out", () => {
  const sized = classifySavedFiles(
    [
      "size 120000 ./.claude/projects/-workspace-repo/abc.jsonl",
      "size 4000 ./.claude/history.jsonl",
      "size 900000 ./codex-db/state_5.sqlite",
      "size 30000 ./codex-db/state_5.sqlite-wal",
      "size 32768 ./codex-db/state_5.sqlite-shm",
      "size 5000000 ./codex-db/logs_1.sqlite",
      "size 2000 ./conversations/s1/x.jsonl",
      "size 700 ./.mend-saved/managed-skills.json",
      "size 300 ./.mend-saved/agent-memory-delivered.json",
      "size 10 ./.claude/projects-not-this/x",
      "not a size line",
    ].join("\n"),
  );
  assert.equal(sized.state, 120_000 + 4000 + 900_000 + 30_000 + 2000);
  assert.equal(sized.beyond, 700 + 300 + 10);
  assert.equal(sized.total, sized.state + sized.beyond);
  assert.equal(sized.machine, 32_768 + 5_000_000);
  assert.equal(sized.files, 8);
  assert.deepEqual(sized.largestBeyond[0], { path: ".mend-saved/managed-skills.json", bytes: 700 });
  assert.equal(classifySavedFiles("probe saved absent\nsize absent"), null);
});

test("the conversation state the bench counts is the one the sessions package saves", () => {
  const source = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../packages/sessions/src/harness-layout.ts",
    ),
    "utf8",
  );
  const block = /export const PERSON_SAVED_STATE[\s\S]*?\n\];/.exec(source)?.[0] ?? "";
  const saved = [...block.matchAll(/\{ path: "([^"]+)", kind: "(?:directory|file)" \}/g)].map(
    (match) => match[1],
  );
  assert.ok(saved.length > 10);
  assert.deepEqual(PERSON_STATE_PATHS, saved);
});

// ─── a person with no ChatGPT login ─────────────────────────────────────────

test("a pi or opencode with no ChatGPT login is said, from the session line or the accounts", () => {
  assert.equal(
    chatGptLoginSkipOf({
      summary: "pi's ChatGPT login not written · no Codex account is connected",
      accounts: null,
    }),
    "no ChatGPT login: no Codex account is connected",
  );
  assert.equal(
    chatGptLoginSkipOf({ summary: null, accounts: [{ provider: "claude", status: "active" }] }),
    "no ChatGPT login: no Codex account is connected",
  );
  assert.equal(
    chatGptLoginSkipOf({ accounts: [{ provider: "codex", status: "invalid" }] }),
    "no ChatGPT login: the Codex login needs reconnecting",
  );
  assert.equal(chatGptLoginSkipOf({ accounts: [{ provider: "codex", status: "active" }] }), null);
  assert.equal(chatGptLoginSkipOf({ summary: "running · Claude", accounts: null }), null);
});

test("a skipped check is neither held nor failed", () => {
  const checks = [];
  tallyCheck(checks, "person.pi.joined.answers", null, "skipped: no ChatGPT login");
  tallyCheck(checks, "person.pi.joined.answers", null, "skipped: no ChatGPT login");
  assert.deepEqual(
    [checks[0].passed, checks[0].failed, checks[0].skipped, checks[0].detail],
    [0, 0, 2, "skipped: no ChatGPT login"],
  );
  assert.deepEqual(failedChecks({ checks }), []);
  assert.match(
    formatTable({ measures: {}, checks }),
    /\| person\.pi\.joined\.answers \| 0 \| 0 \| 2 \| skipped: no ChatGPT login \|/,
  );
});

const noLoginVerdicts = (probeText, overrides = {}) =>
  Object.fromEntries(
    personVerdicts({
      probe: parsePersonProbe(probeText),
      harness: "pi",
      agentSaid: null,
      piDigest: "b".repeat(64),
      loginSkipped: "no ChatGPT login: no Codex account is connected",
      ...overrides,
    }).map((verdict) => [verdict.name, verdict.ok]),
  );

test("with no login of their own, a person's pi home must still be theirs and hold nobody's", () => {
  const empty = PROBE.replace(
    "probe login openai-codex present 40002 600 1",
    "probe login openai-codex present 40002 600 0",
  );
  assert.deepEqual(noLoginVerdicts(empty), {
    uid: true,
    home: true,
    agent_process: true,
    agent_identity: null,
    chatgpt_login: null,
    chatgpt_login_nobody_else: true,
    pi_profile: true,
  });
  // An entry there (the owner's, say) or a file in saved state fails it.
  assert.equal(noLoginVerdicts(PROBE).chatgpt_login_nobody_else, false);
  assert.equal(
    noLoginVerdicts(
      empty.replace("/home/mabcdefgh/.pi/agent/auth.json", "/workspace/harness-home/x/auth.json"),
    ).chatgpt_login_nobody_else,
    false,
  );
  assert.equal(
    noLoginVerdicts(
      PROBE.replace(/probe login openai-codex[^\n]*/, "probe login openai-codex absent"),
    ).chatgpt_login_nobody_else,
    true,
  );
});

// ─── review of mend#581 ─────────────────────────────────────────────────────

test("a login file the person cannot read, or a line that does not parse, is never absent", () => {
  const probe = parsePersonProbe(
    [
      "probe uid 40002",
      "probe user p2 /home/p2",
      "probe home-stat 40002 700",
      "probe proc pi",
      "probe login openai-codex present 0 600 unreadable /home/p2/.pi/agent/auth.json",
      "probe login openai present 0 600  /home/p2/.local/share/opencode/auth.json",
      "probe pi-profile absent",
    ].join("\n"),
  );
  assert.equal(probe.logins["openai-codex"].unreadable, true);
  assert.equal(probe.logins.openai.unparsed, true);
  const skipped = Object.fromEntries(
    personVerdicts({
      probe,
      harness: "pi",
      piDigest: null,
      loginSkipped: "no ChatGPT login: no Codex account is connected",
    }).map((verdict) => [verdict.name, verdict.ok]),
  );
  assert.equal(skipped.chatgpt_login_nobody_else, false);
  const opencode = personVerdicts({ probe, harness: "opencode", agentSaid: null });
  assert.equal(opencode.find((verdict) => verdict.name === "chatgpt_login").ok, false);
  assert.match(
    opencode.find((verdict) => verdict.name === "chatgpt_login").detail,
    /did not parse/,
  );
});

test("the agent's process is the harness's, and an answer with no login of its own fails", () => {
  const onlyShell = PROBE.replace("probe proc pi\nprobe proc node", "probe proc sh");
  const verdicts = personVerdicts({ probe: parsePersonProbe(onlyShell), harness: "pi" });
  assert.equal(verdicts.find((verdict) => verdict.name === "agent_process").ok, false);
  const answered = Object.fromEntries(
    personVerdicts({
      probe: parsePersonProbe(
        PROBE.replace(
          "present 40002 600 1 /home/mabcdefgh/.pi",
          "present 40002 600 0 /home/mabcdefgh/.pi",
        ),
      ),
      harness: "pi",
      agentSaid: { uid: 40001, home: "/home/mowner" },
      loginSkipped: "no ChatGPT login: no Codex account is connected",
    }).map((verdict) => [verdict.name, verdict.ok]),
  );
  assert.equal(answered.answered_without_login, false);
  assert.equal(answered.agent_identity, false);
  // Profiles that cannot be told apart are not a pass.
  const same = personVerdicts({
    probe: parsePersonProbe(PROBE),
    harness: "pi",
    agentSaid: { uid: 40002, home: "/home/mabcdefgh" },
    piDigest: null,
    otherPiDigest: null,
  }).find((verdict) => verdict.name === "pi_profile_not_other");
  assert.equal(same.ok, null);
  assert.match(same.detail, /^skipped: cannot be told apart/);
});

test("without the host the executor's checks are recorded as skipped, not dropped", () => {
  assert.deepEqual(
    personVerdictsSkipped({ harness: "pi", joined: true }, "no host").map((v) => [v.name, v.ok]),
    [
      ["uid", null],
      ["home", null],
      ["agent_process", null],
      ["agent_identity", null],
      ["chatgpt_login", null],
      ["pi_profile", null],
      ["pi_profile_not_other", null],
    ],
  );
  assert.deepEqual(
    personVerdictsSkipped({ harness: "claude" }, "no host").map((v) => v.name),
    ["uid", "home", "agent_process", "agent_identity"],
  );
});

test("a re-run's checks and errors come with its faster numbers", () => {
  const shared = sharedBaseline();
  const after = completePerson();
  after.measures["handover.claude.to_other.first_output_over_own"].samples = tenOf(6000);
  const again = {
    ...layoutRecord(
      "person",
      "1",
      {
        "handover.claude.to_other.first_output_over_own": {
          unit: "ms",
          budget: "handover",
          samples: tenOf(3000),
        },
      },
      {
        options: { ...PERSON_OPTIONS, only: ["handover"] },
        checks: [
          {
            check: "handover.claude.to_other.billed",
            passed: 0,
            failed: 10,
            skipped: 0,
            detail: null,
            failures: ["billed to the owner, sent by the other person"],
          },
        ],
        errors: [{ scenario: "handover.claude", message: "late" }],
      },
    ),
  };
  const missed = ["handover.claude.to_other.first_output_over_own"];
  const merged = mergeResults(after, again, (name) => missed.includes(name));
  const result = compareResults(shared, merged);
  assert.equal(
    result.rows.find((row) => row.measure === missed[0] && row.stat === "median").after,
    3000,
  );
  assert.deepEqual(
    result.checkFailures.map((check) => check.check),
    ["handover.claude.to_other.billed"],
  );
  // The re-run's checks replace that scenario's; the person checks stay.
  assert.ok(merged.checks.some((check) => check.check === "person.pi.uid"));
  assert.equal(result.errors.length, 1);
  assert.equal(comparisonFails(result), true);
});

test("cleanup takes one run's worktrees, or every st-bench one only when asked", () => {
  assert.equal(inCleanupScope("st-bench-10hp8n-handover-claude", "10hp8n", false), true);
  assert.equal(inCleanupScope("st-bench-0x2q5q-check-pi", "10hp8n", false), false);
  assert.equal(inCleanupScope("st-bench-0x2q5q-check-pi", null, true), true);
  assert.equal(inCleanupScope("my-work", null, true), false);
  assert.equal(inCleanupScope("st-bench-0x2q5q-x", null, false), false);
  assert.throws(() => parseOptions(["cleanup"]), /--run <id>.*--all/);
  assert.equal(parseOptions(["cleanup", "--run", "10hp8n"]).runId, "10hp8n");
  assert.equal(parseOptions(["cleanup", "--all"]).all, true);
  assert.throws(() => parseOptions(["cleanup", "--run", "st-bench-*"]), /run's id/);
  assert.equal(parseOptions(["run"]).handoverSeedTurns, 4);
  assert.equal(parseOptions(["run", "--handover-seed-turns", "6"]).handoverSeedTurns, 6);
});

test("an error item is not a first output, a turn that did not complete has none, and the hand-over is over the own turn", () => {
  const items = [
    { turnId: "t2", kind: "error", text: "boom", createdAt: "2026-10-09T10:00:00.500Z" },
    ...ITEMS,
  ];
  assert.equal(turnTimes(TURN, items).firstOutput, 4000);
  assert.equal(turnTimes({ ...TURN, status: "failed" }, items).firstOutput, null);
  assert.equal(overOwn(9000, 4000), 5000);
  assert.equal(overOwn(null, 4000), null);
  assert.equal(overOwn(9000, undefined), null);
  // Records name people by role, never by id.
  const details = turnVerdicts({
    turn: TURN,
    process: { id: "proc-b", runsAs: "bob" },
    ownerId: "alice",
    fromOwner: false,
    maxLive: 1,
    answer: "9119",
    items: ITEMS,
  }).map((verdict) => verdict.detail);
  assert.ok(details.every((detail) => !/alice|bob/.test(detail)));
  assert.match(details.join(" "), /billed to the other person, sent by the other person/);
});

test("the probe leaves its own processes out and says when a login cannot be read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-bench-probe-"));
  const sleeper = execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"])
    .toString()
    .trim();
  try {
    const uid = process.getuid();
    const home = path.join(root, "home");
    mkdirSync(path.join(root, "people", "acc-1"), { recursive: true });
    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    chmodSync(home, 0o700);
    writeFileSync(path.join(home, ".pi/agent/auth.json"), '{"openai-codex":{}}', { mode: 0o000 });
    writeFileSync(path.join(root, "passwd"), `me:x:${uid}:${uid}::${home}:/bin/sh\n`);
    const out = execFileSync("sh", ["-c", PERSON_PROBE_SH, "st-bench", "acc-1"], {
      env: {
        ...process.env,
        ST_BENCH_PEOPLE: path.join(root, "people"),
        ST_BENCH_PASSWD: path.join(root, "passwd"),
      },
    }).toString();
    const probe = parsePersonProbe(out);
    assert.equal(probe.uid, uid);
    assert.equal(probe.home, home);
    assert.equal(probe.homeMode, "700");
    assert.ok(probe.processes.includes("sleep"), out);
    // The probe's own `awk`s and subshells never show.
    assert.ok(!probe.processes.includes("awk"), out);
    if (uid !== 0) assert.equal(probe.logins["openai-codex"].unreadable, true, out);
    assert.deepEqual(probe.logins.openai, { present: false });
  } finally {
    execFileSync("sh", ["-c", `kill ${sleeper} 2>/dev/null; true`]);
    rmSync(root, { recursive: true, force: true });
  }
});
