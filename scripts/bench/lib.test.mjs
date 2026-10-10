import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "./host.mjs";
import {
  agentIdentityOf,
  companionMismatchOf,
  seriesHarnessOf,
  stampSeriesIdentity,
  MEMORY_STAT_SH,
  memoryStatCommand,
  credentialWriteCount,
  noDeliveryReasonOf,
  parseMemoryStat,
  PERSON_SCENARIOS,
  compactionsOf,
  expectedSamplesOf,
  roundConversationOf,
  seriesFloorOf,
  compactedBetween,
  GATE_HARNESSES,
  gateScopeGaps,
  lastRequestTokensOf,
  LAST_REQUEST_SH,
  SCENARIOS,
  sumChecks,
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
  budgetOf,
  builtWithin,
  FETCH_RETRIES_UNKNOWN,
  fetchRetriesOf,
  installEndOf,
  installOf,
  installsOf,
  engineLinesOf,
  installWhyOf,
  reinstallReasonsOf,
  reinstallSharesOf,
  NO_HOST,
  resumeKindOf,
  LAUNCH_ANSWER_WINDOW_MS,
  launchCallCapped,
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
import {
  cleanupAll,
  makeRecorder,
  recordExcludingInstall,
  recordInstall,
  runAll,
} from "./scenarios.mjs";

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
    milestoneName("session engine: dependency install · completed · exit 0 · fetch retries 2"),
    "dependency install · completed",
  );
  assert.equal(
    milestoneName("session engine: dependency install · exited · exit 1 · fetch retries 0"),
    "dependency install · exited",
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
    "new.claude.first_output_excl_install": { unit: "ms", budget: "start", samples: tenOf(30_000) },
    "api.session_list": { unit: "ms", budget: "api", samples: tenOf(100) },
    "new.claude.step.x": { unit: "ms", budget: null, samples: tenOf(1) },
  });
  const within = record({
    "new.claude.first_output_excl_install": { unit: "ms", budget: "start", samples: tenOf(31_400) },
    "api.session_list": { unit: "ms", budget: "api", samples: tenOf(119) },
  });
  const ok = compareResults(before, within);
  assert.equal(ok.rows.length, 4);
  assert.equal(ok.misses.length, 0);

  const over = record({
    "new.claude.first_output_excl_install": {
      unit: "ms",
      budget: "start",
      samples: [...tenOf(31_000).slice(0, 8), 40_000, 40_000],
    },
  });
  const result = compareResults(before, over);
  const firstOutput = result.rows.filter(
    (row) => row.measure === "new.claude.first_output_excl_install",
  );
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
    /\| new\.claude\.first_output_excl_install \| p90 \| 30\.0 s \| 40\.0 s \| 31\.5 s \| OVER \|/,
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
      "resume.first_output_excl_install": {
        unit: "ms",
        budget: "start",
        samples: [34_000, 36_000, 35_000],
      },
      empty: { unit: "ms", budget: null, samples: [] },
    },
    notRun: [{ measure: "join.other.first_output", reason: "second account not yet joined" }],
  });
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(
    lines[2],
    "| resume.first_output_excl_install | 3 | 35.0 s | 35.8 s | 36.0 s | +5% or +1 s |",
  );
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
  // Both say the harness their joins rode on and its version (`stampSeriesIdentity`).
  const identity = {
    options: { harnesses: ["claude"] },
    target: { harnessVersions: { claude: "2.1.292" } },
  };
  const base = {
    ...identity,
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
    ...identity,
    startedAt: "b",
    options: { only: ["join-other"], harnesses: ["claude"] },
    measures: {
      "new.claude.first_output": { unit: "ms", budget: "start", samples: [9] },
      "join.other.first_output": { unit: "ms", budget: "join-other", samples: [7, 8] },
    },
    notRun: [],
    notes: ["extra"],
    errors: [],
  };
  const merged = mergeResults(ofWorkload(base), ofWorkload(extra));
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
  const rerun = mergeResults(
    ofWorkload(base),
    ofWorkload(extra),
    (name) => name === "new.claude.first_output",
  );
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
  const versions = { target: { harnessVersions: { claude: "2.1.292", codex: "0.160.1" } } };
  const base = {
    ...versions,
    measures: {
      "stop.claude.save": { unit: "ms", samples: [1] },
      "stop.codex.save": { unit: "ms", samples: [2] },
      "stop.claude.stale": { unit: "ms", samples: [3] },
    },
  };
  const extra = {
    ...versions,
    options: { only: ["stop"], harnesses: ["claude"] },
    measures: { "stop.claude.save": { unit: "ms", samples: [9] } },
  };
  const merged = mergeResults(ofWorkload(base), ofWorkload(extra));
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
    "new.claude.first_turn_excl_install": { unit: "ms", budget: "start", samples: tenOf(30_000) },
    "new.codex.first_turn_excl_install": { unit: "ms", budget: "start", samples: tenOf(20_000) },
  });
  const after = {
    ...record({}),
    notRun: [
      {
        measure: "new.claude.first_turn_excl_install",
        reason: 'the harness\'s account hit its usage limit ("Usage limit reached")',
      },
    ],
  };
  const comparison = compareResults(before, after);
  // Still a miss: a number not taken is not inside its limit.
  assert.equal(comparison.misses.length, 4);
  const table = formatComparison(comparison);
  assert.match(
    table,
    /new\.claude\.first_turn_excl_install \| median .*NOT RUN: the harness's account hit/,
  );
  assert.match(table, /new\.codex\.first_turn_excl_install \| median .*MISSING/);
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
    ofWorkload({ measures: {}, imageBuilds: [imageBuild("sha256:a")] }),
    ofWorkload({
      options: { only: ["new"] },
      measures: {},
      imageBuilds: [imageBuild("sha256:b")],
    }),
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
  const versions = { harnessVersions: { claude: "2.1.292", codex: "0.160.1" } };
  const older = { ...record(memory(1_100_000_000)), target: versions };
  const newer = {
    target: versions,
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
  const merged = mergeResults(ofWorkload(older), ofWorkload(newer));
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
  options: { layout, only: [...SCENARIOS], harnesses: [...GATE_HARNESSES] },
  target: {
    url: "https://alpha.mend.run",
    version,
    commit: "abc1234def",
    flag: "shared (MEND_HARNESS_LAYOUT unset)",
    mendImage: "mend:next sha256:aaaaaaaaaaaa",
    layout,
    project: { id: "p" },
    workspaceImage: "sha256:a",
    harnessVersions: { claude: "2.1.287", codex: "0.160.0", pi: "0.70.0", opencode: "1.18.34" },
  },
  measures,
  notRun: [],
  notes: [],
  errors: [],
  checks: [],
  ...extra,
});

/**
 * A record of one workload (`mergeResults` takes a later run only of the record's): the same
 * layout, instance, build, workspace image and project as `layoutRecord`'s, its own options and
 * harness versions kept.
 */
const ofWorkload = (result, layout = "person") => {
  const target = layoutRecord(layout, "1", {}).target;
  return {
    ...result,
    options: { layout, harnesses: [...GATE_HARNESSES], ...result.options },
    target: {
      ...target,
      ...result.target,
      harnessVersions: { ...target.harnessVersions, ...result.target?.harnessVersions },
    },
  };
};

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
  assert.equal(gate.notCovered.length, 2);
  assert.match(gate.notCovered[0], /largest worktree, interleaved/);
  assert.match(gate.notCovered[1], /dependency install .* not budgeted/);

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
  drifted.target.harnessVersions = { ...drifted.target.harnessVersions, claude: "2.1.300" };
  drifted.target.workspaceImage = "sha256:b";
  const driftedLabel = describeComparison(shared, drifted);
  assert.deepEqual(driftedLabel.differs, [
    "the workspace images differ (sha256:a and sha256:b)",
    "claude ran 2.1.287 before and 2.1.300 after",
  ]);
  assert.match(driftedLabel.kind, /not the gate/);
  // A harness one side has no version for is warned of.
  const noPi = layoutRecord("person", "0.36.0-next.648", {});
  delete noPi.target.harnessVersions.pi;
  assert.deepEqual(describeComparison(shared, noPi).warnings, [
    "pi's version is not in the record under test",
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

const passing = (names) =>
  names.map((check) => ({ check, passed: 1, failed: 0, skipped: 0, detail: null, failures: [] }));
const sampleOf = (budget) =>
  ({ growth: 1000, handover: 1000, "join-other": 20_000, interactive: 40, api: 50 })[budget] ??
  30_000;
/** Ten resumes that restored the saved dependency tree, as both layouts' gate records have. */
const restoredResumes = () => ({
  "resume.tree_restored.first_output": { unit: "ms", budget: "start", samples: tenOf(30_000) },
});
/** A person record carrying all of gate P1 (every required measure and check holding). */
const completePerson = (secondPersonHarnesses = null) => {
  const required = requiredOf(layoutRecord("person", "1", {}), {
    gate: true,
    secondPersonHarnesses,
  });
  const measures = {
    ...Object.fromEntries(
      required.measures.map((entry) => [
        entry.measure,
        { unit: entry.unit, budget: entry.budget, samples: tenOf(sampleOf(entry.budget)) },
      ]),
    ),
    ...restoredResumes(),
  };
  measures["handover.claude.to_other.first_output_over_own"].samples = [
    ...tenOf(3000).slice(0, 9),
    6000,
  ];
  return layoutRecord("person", "1", measures, {
    options: {
      layout: "person",
      only: [...SCENARIOS],
      harnesses: [...GATE_HARNESSES],
      secondPersonHarnesses,
    },
    checks: passing(required.checks),
  });
};
/** The shared record of gate P1: every launch measure, the different-person join included. */
const sharedBaseline = () => {
  const required = requiredOf(layoutRecord("person", "1", {}), { gate: true });
  return layoutRecord("shared", "1", {
    ...Object.fromEntries(
      required.measures
        .filter((entry) => !["handover", "growth"].includes(entry.budget))
        .map((entry) => [
          entry.measure,
          { unit: entry.unit, budget: entry.budget, samples: tenOf(sampleOf(entry.budget)) },
        ]),
    ),
    ...restoredResumes(),
  });
};

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
  const bare = completePerson();
  for (const name of Object.keys(bare.measures)) {
    if (/^(handover|growth)\.|^join\.other\./.test(name)) delete bare.measures[name];
  }
  bare.checks = bare.checks.filter((check) => !check.check.startsWith("handover."));
  bare.notRun = [
    { measure: "handover.*", reason: "second account not yet joined" },
    { measure: "growth.*", reason: "second account not yet joined" },
    { measure: "join.other.first_output", reason: "second account not yet joined" },
  ];
  bare.errors = [{ scenario: "person-checks", message: "boom" }];
  const result = compareResults(sharedBaseline(), bare);
  const missed = [...new Set(result.misses.map((row) => row.measure))];
  assert.equal(missed.filter((name) => name.startsWith("growth.")).length, 4);
  assert.equal(missed.filter((name) => name.startsWith("handover.")).length, 4);
  assert.ok(missed.includes("join.other.first_output"));
  assert.ok(result.misses.every((row) => row.notRun === "second account not yet joined"));
  assert.equal(
    result.checksNotVerified.length,
    requiredOf(bare, { gate: true }).checks.filter((name) => name.startsWith("handover.")).length,
  );
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
  // A check seen only skipped (no host) is not verified.
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
  // A shared record outside the gate, or a person one that asked for none of it, needs none of it.
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

test("a merge adds the two runs' check tallies and never drops a failure", () => {
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
    checks: [
      { check: "handover.claude.to_other.billed", passed: 1, failed: 0, failures: [] },
      { check: "handover.claude.back.billed", passed: 1, failed: 0, failures: [] },
    ],
  };
  const merged = mergeResults(ofWorkload(base), ofWorkload(extra));
  assert.deepEqual(
    merged.checks.map((check) => [check.check, check.passed, check.failed]),
    [
      ["handover.claude.to_other.billed", 1, 1],
      ["person.pi.home", 1, 0],
      ["handover.claude.back.billed", 1, 0],
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
        options: {
          layout: "person",
          only: ["handover"],
          harnesses: [...GATE_HARNESSES],
        },
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
  // The re-run's checks are added to the first run's; the person checks stay.
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
  assert.equal(parseOptions(["run"]).handoverSeedTurns, 8);
  assert.equal(parseOptions(["run"]).handoverContextTokens, 45_000);
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

// ─── review of mend#581, round 2 ────────────────────────────────────────────

test("a clean re-run never washes out a check that failed 1 time in 10 (N1)", () => {
  const first = completePerson();
  first.measures["handover.claude.to_other.first_output_over_own"].samples = tenOf(6000);
  const billed = first.checks.find((check) => check.check === "handover.claude.to_other.billed");
  Object.assign(billed, { passed: 9, failed: 1, failures: ["billed to the owner"] });
  assert.equal(comparisonFails(compareResults(sharedBaseline(), first)), true);
  const again = layoutRecord(
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
      options: { layout: "person", only: ["handover"], harnesses: [...GATE_HARNESSES] },
      checks: passing(
        first.checks.map((check) => check.check).filter((name) => name.startsWith("handover.")),
      ).map((check) => ({ ...check, passed: 10 })),
    },
  );
  const missed = ["handover.claude.to_other.first_output_over_own"];
  const merged = mergeResults(first, again, (name) => missed.includes(name));
  const after = merged.checks.find((check) => check.check === "handover.claude.to_other.billed");
  assert.deepEqual([after.passed, after.failed, after.failures], [19, 1, ["billed to the owner"]]);
  const result = compareResults(sharedBaseline(), merged);
  assert.equal(result.misses.length, 0);
  assert.equal(comparisonFails(result), true);
  assert.deepEqual(sumChecks([], []), []);
});

test("gate P1 asks for the whole set whatever --only and --harnesses said (N2)", () => {
  const shared = sharedBaseline();
  // `run --layout person --only new,stop`: not the gate, and it fails, saying what is missing.
  const narrow = completePerson();
  narrow.options.only = ["new", "stop"];
  const result = compareResults(shared, narrow);
  assert.match(result.label.kind, /not the gate: the person record did not run resume, join-same/);
  assert.equal(comparisonFails(result), true);
  // `--harnesses claude`: the other three are missing, and so is everything they carry.
  const one = completePerson();
  one.options.harnesses = ["claude"];
  for (const name of Object.keys(one.measures)) {
    if (/\.(codex|pi|opencode)\./.test(name)) delete one.measures[name];
  }
  const oneResult = compareResults(shared, one);
  assert.ok(oneResult.label.differs.includes("the person record did not run codex, pi, opencode"));
  assert.ok(oneResult.misses.some((row) => row.measure === "new.pi.first_output_excl_install"));
  assert.equal(comparisonFails(oneResult), true);
  // A second person who ran claude only: missing pieces unless the partial gate is asked for.
  const claudeOnly = completePerson(["claude"]);
  const strict = compareResults(shared, claudeOnly);
  assert.ok(
    strict.label.differs.includes(
      "the person record's second person did not run codex, pi, opencode",
    ),
  );
  assert.ok(
    strict.misses.some((row) => row.measure === "growth.pi.extra_person_beyond_state_bytes"),
  );
  assert.equal(comparisonFails(strict), true);
  const partial = compareResults(shared, claudeOnly, { secondPersonHarnesses: ["claude"] });
  assert.equal(
    partial.label.kind,
    "gate P1: person launches against shared launches (partial: the second person runs claude only, by --second-person-harnesses)",
  );
  assert.deepEqual(partial.misses, []);
  assert.equal(comparisonFails(partial), false);
  // Gaps on the shared side count too.
  const sharedNarrow = sharedBaseline();
  sharedNarrow.options.only = ["new"];
  assert.ok(
    gateScopeGaps(sharedNarrow, completePerson())[0].startsWith(
      "the shared record did not run stop",
    ),
  );
});

test("under gate P1 a measure either side lacks, and the baseline's errors, fail it (N3, N5)", () => {
  // The shared run's pi errored: no baseline for the person record's 99 s pi launch.
  const shared = sharedBaseline();
  delete shared.measures["new.pi.first_output_excl_install"];
  shared.errors = [{ scenario: "new.pi", message: "boom" }];
  shared.notRun = [{ measure: "new.pi.first_output_excl_install", reason: "usage limit" }];
  const person = completePerson();
  person.measures["new.pi.first_output_excl_install"].samples = tenOf(99_000);
  const result = compareResults(shared, person);
  const rows = result.misses.filter((row) => row.measure === "new.pi.first_output_excl_install");
  assert.equal(rows.length, 2);
  assert.match(
    rows[0].notRun,
    /^no baseline: the shared record has no new\.pi\.first_output_excl_install \(usage limit\)/,
  );
  assert.equal(comparisonFails(result), true);
  // The baseline's errors alone fail the gate.
  const errored = sharedBaseline();
  errored.errors = [{ scenario: "interactive", message: "x" }];
  assert.equal(comparisonFails(compareResults(errored, completePerson())), true);
  // "not the gate" never exits 0 (N5).
  const rebuilt = completePerson();
  rebuilt.target.mendImage = "mend:next sha256:bbbbbbbbbbbb";
  const notGate = compareResults(sharedBaseline(), rebuilt);
  assert.equal(notGate.misses.length, 0);
  assert.match(notGate.label.kind, /not the gate/);
  assert.equal(comparisonFails(notGate), true);
  // Outside the gate (person against person) neither rule applies.
  const plain = compareResults(completePerson(), completePerson());
  assert.equal(plain.gate, false);
  assert.equal(comparisonFails(plain), false);
});

test("the conversation's size is its last request's prompt, and a shrink is a compaction (N4)", () => {
  assert.equal(
    lastRequestTokensOf(
      'usage claude "usage":{"input_tokens":3,"cache_creation_input_tokens":1200,"cache_read_input_tokens":44000,"cache_creation":{',
    ),
    45_203,
  );
  // Codex's input already holds the cached input: not added twice.
  assert.equal(
    lastRequestTokensOf(
      'usage codex "last_token_usage":{"input_tokens":46000,"cached_input_tokens":45000,"output_tokens":12}',
    ),
    46_000,
  );
  assert.equal(lastRequestTokensOf("usage none"), null);
  assert.equal(compactedBetween(50_000, 52_000), false);
  assert.equal(compactedBetween(50_000, 12_000), true);
  assert.equal(compactedBetween(null, 12_000), false);
  // The probe reads this conversation's transcript (F2 has its own test) and never a message.
  const root = mkdtempSync(path.join(tmpdir(), "st-bench-usage-"));
  try {
    const conversation = path.join(root, "people", "acc-1", "conversations", "s1");
    mkdirSync(conversation, { recursive: true });
    writeFileSync(
      path.join(conversation, "c0ffee-1.jsonl"),
      [
        '{"type":"assistant","message":{"content":"secret words","usage":{"input_tokens":5,"cache_creation_input_tokens":10,"cache_read_input_tokens":100}}}',
        '{"type":"assistant","message":{"content":"more secret words","usage":{"input_tokens":7,"cache_creation_input_tokens":20,"cache_read_input_tokens":30000,"cache_creation":{"x":1}}}}',
      ].join("\n"),
    );
    writeFileSync(path.join(root, "people", "acc-1", "history.jsonl"), '{"display":"a prompt"}\n');
    const out = execFileSync("sh", ["-c", LAST_REQUEST_SH, "st-bench", "acc-1", "c0ffee-1"], {
      env: { ...process.env, ST_BENCH_PEOPLE: path.join(root, "people") },
    }).toString();
    assert.ok(!out.includes("secret"), out);
    assert.equal(lastRequestTokensOf(out), 30_027);
    assert.equal(compactionsOf(out), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const agentProcessHeld = (names, harness) =>
  personVerdicts({
    probe: parsePersonProbe(
      [
        "probe uid 40002",
        "probe user p /home/p",
        "probe home-stat 40002 700",
        ...names.map((name) => `probe proc ${name}`),
      ].join("\n"),
    ),
    harness,
  }).find((verdict) => verdict.name === "agent_process").ok;

test("a process is the harness's only by its exact name", () => {
  assert.equal(agentProcessHeld(["pip", "ping", "pidof"], "pi"), false);
  assert.equal(agentProcessHeld(["pi"], "pi"), true);
  assert.equal(agentProcessHeld([".opencode"], "opencode"), true);
  assert.equal(agentProcessHeld(["claude-code"], "claude"), false);
});

// ─── review of mend#581, round 3 ────────────────────────────────────────────

test("F1: a gate series shorter than its floor is a miss, however its samples look", () => {
  assert.equal(seriesFloorOf(10), 8);
  assert.equal(seriesFloorOf(3), 5);
  assert.equal(
    expectedSamplesOf({ options: { runs: 10 } }, "growth.pi.extra_person_beyond_state_bytes"),
    10,
  );
  assert.equal(
    expectedSamplesOf({ options: { runs: 10, joinsPerRun: 2 } }, "join.other.first_output"),
    20,
  );
  assert.equal(expectedSamplesOf({ options: { runs: 10 } }, "terminal.echo"), null);
  // 9 of 10 hand-over rounds discarded as compacted: one kept round does not pass the gate.
  const one = completePerson();
  one.measures["handover.claude.to_other.first_output_over_own"].samples = [1000];
  Object.assign(
    one.checks.find((check) => check.check === "handover.claude.round_not_compacted"),
    { passed: 1, skipped: 9 },
  );
  const result = compareResults(sharedBaseline(), one);
  const rows = result.misses.filter(
    (row) => row.measure === "handover.claude.to_other.first_output_over_own",
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].short,
    "the record under test kept 1 of 10 (9 discarded: compacted); at least 8 needed",
  );
  assert.match(formatComparison(result), /SHORT: the record under test kept 1 of 10/);
  assert.equal(comparisonFails(result), true);
  // Growth rounds with no conversation leave the series short the same way.
  const growth = completePerson();
  growth.measures["growth.claude.extra_person_beyond_state_bytes"].samples = tenOf(1000).slice(
    0,
    7,
  );
  growth.measures["growth.claude.no_conversation.extra_person_beyond_state_bytes"] = {
    unit: "bytes",
    budget: null,
    samples: [100, 100, 100],
  };
  const short = compareResults(sharedBaseline(), growth).misses.find(
    (row) => row.measure === "growth.claude.extra_person_beyond_state_bytes",
  );
  assert.equal(
    short.short,
    "the record under test kept 7 of 10 (3 with no conversation); at least 8 needed",
  );
  // 8 of 10 is enough; a short baseline fails too.
  const eight = completePerson();
  eight.measures["growth.claude.extra_person_beyond_state_bytes"].samples = tenOf(1000).slice(0, 8);
  assert.equal(comparisonFails(compareResults(sharedBaseline(), eight)), false);
  const thin = sharedBaseline();
  thin.measures["new.pi.first_output_excl_install"].samples = [30_000, 30_000];
  assert.match(
    compareResults(thin, completePerson()).misses.find(
      (row) => row.measure === "new.pi.first_output_excl_install",
    ).short,
    /^the baseline kept 2 of 10/,
  );
  // A record of fewer than ten rounds is not the gate.
  const five = completePerson();
  five.options.runs = 5;
  assert.ok(
    compareResults(sharedBaseline(), five).label.differs.includes(
      'the person record ran 5 round(s); the gate runs at least 10 (docs/adr/0016, "Method")',
    ),
  );
});

test("F2: the size is read from this session's own transcript, wherever it is, never an older one", () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-bench-own-"));
  try {
    const person = path.join(root, "people", "acc-1");
    // As in a person executor: `conversations/` exists and holds an earlier shared conversation.
    mkdirSync(path.join(person, "conversations", "older-session", ".claude", "projects", "w"), {
      recursive: true,
    });
    writeFileSync(
      path.join(
        person,
        "conversations",
        "older-session",
        ".claude",
        "projects",
        "w",
        "aaaa-old.jsonl",
      ),
      '{"message":{"usage":{"input_tokens":1,"cache_read_input_tokens":90000}}}\n',
    );
    // This session's transcript, before its first hand-over: under the harness's own directory.
    mkdirSync(path.join(person, ".claude", "projects", "w"), { recursive: true });
    writeFileSync(
      path.join(person, ".claude", "projects", "w", "bbbb-this.jsonl"),
      [
        '{"message":{"usage":{"input_tokens":2,"cache_read_input_tokens":12000}}}',
        '{"type":"system","subtype":"compact_boundary"}',
        '{"message":{"usage":{"input_tokens":3,"cache_read_input_tokens":21000}}}',
      ].join("\n"),
    );
    const read = (conversation) =>
      execFileSync("sh", ["-c", LAST_REQUEST_SH, "st-bench", "acc-1", conversation], {
        env: { ...process.env, ST_BENCH_PEOPLE: path.join(root, "people") },
      }).toString();
    assert.equal(lastRequestTokensOf(read("bbbb-this")), 21_003);
    assert.equal(compactionsOf(read("bbbb-this")), 1);
    // A conversation not on disk is unread, never another's size.
    assert.equal(lastRequestTokensOf(read("cccc-none")), null);
    assert.equal(
      lastRequestTokensOf(
        execFileSync("sh", ["-c", LAST_REQUEST_SH, "st-bench", "acc-1"], {
          env: { ...process.env, ST_BENCH_PEOPLE: path.join(root, "people") },
        }).toString(),
      ),
      null,
    );
    // Codex's rollout names the thread id; a compaction is a "compacted" entry.
    mkdirSync(path.join(person, ".codex", "sessions", "2026"), { recursive: true });
    writeFileSync(
      path.join(person, ".codex", "sessions", "2026", "rollout-2026-10-09-dddd-codex.jsonl"),
      '{"type":"event_msg","payload":{"info":{"last_token_usage":{"input_tokens":48000,"cached_input_tokens":47000}}}}\n',
    );
    assert.equal(lastRequestTokensOf(read("dddd-codex")), 48_000);
    assert.throws(() => asPersonCommand("sealant-1", "acc-1", "true", ["a; rm"]), /not an id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3/F4: a shrink at a steered turn is a lost conversation; an unread size proves nothing", () => {
  // Grown to 50k: a shrink at the hand-over with no compaction in the transcript is a failure.
  assert.deepEqual(roundConversationOf([50_000, 9000, 9500, 10_000], [0, 0, 0, 0]), {
    unread: false,
    lost: ["to_other"],
    compacted: false,
  });
  assert.deepEqual(roundConversationOf([50_000, 51_000, 9000, 9500], [0, 0, 0, 0]).lost, ["back"]);
  // The transcript records a compaction there: the round is discarded, not failed.
  assert.deepEqual(roundConversationOf([50_000, 9000, 9500, 10_000], [0, 1, 1, 1]), {
    unread: false,
    lost: [],
    compacted: true,
  });
  // A shrink at the owner's own turn discards the round.
  assert.deepEqual(roundConversationOf([50_000, 51_000, 52_000, 9000], [0, 0, 0, 0]), {
    unread: false,
    lost: [],
    compacted: true,
  });
  assert.deepEqual(roundConversationOf([50_000, 51_000, 52_000, 53_000], [0, 0, 0, 0]), {
    unread: false,
    lost: [],
    compacted: false,
  });
  // A size not read: nothing can be said, so nothing holds (F4).
  assert.deepEqual(roundConversationOf([50_000, null, 52_000, 53_000], []), {
    unread: true,
    lost: [],
    compacted: false,
  });
  // Under the gate the hand-over's conversation checks are required, so an all-skipped one fails.
  const unread = completePerson();
  const kept = unread.checks.find((check) => check.check === "handover.claude.round_not_compacted");
  Object.assign(kept, { passed: 0, skipped: 10 });
  assert.ok(
    compareResults(sharedBaseline(), unread).checksNotVerified.some(
      (entry) => entry.check === "handover.claude.round_not_compacted",
    ),
  );
});

/** A companion's target: the main record's run, on the configs project. */
const configsTarget = (layout) => ({
  ...layoutRecord(layout, "1", {}).target,
  project: { name: "configs", id: "c" },
});

test("F5: a companion's failed checks, errors and unverified checks count, on either side", () => {
  const companionPerson = () =>
    layoutRecord(
      "person",
      "1",
      { "join.other.first_output": { unit: "ms", budget: "join-other", samples: tenOf(20_000) } },
      {
        target: configsTarget("person"),
        options: { layout: "person", only: ["join-other"], harnesses: ["claude"] },
      },
    );
  const companionShared = () =>
    layoutRecord(
      "shared",
      "1",
      { "join.other.first_output": { unit: "ms", budget: "join-other", samples: tenOf(19_000) } },
      {
        target: configsTarget("shared"),
        options: { layout: "shared", only: ["join-other"], harnesses: ["claude"] },
      },
    );
  const failing = companionPerson();
  failing.checks = [
    {
      check: "join.other.runs_as",
      passed: 0,
      failed: 10,
      skipped: 0,
      detail: null,
      failures: ["root"],
    },
  ];
  failing.errors = [{ scenario: "join.other", message: "boom" }];
  const result = compareResults(
    withCompanion(sharedBaseline(), companionShared()),
    withCompanion(completePerson(), failing),
  );
  assert.deepEqual(
    result.checkFailures.map((check) => check.check),
    ["configs: join.other.runs_as"],
  );
  assert.deepEqual(
    result.errors.map((error) => error.scenario),
    ["configs: join.other"],
  );
  assert.equal(comparisonFails(result), true);
  // A companion only the record under test carries is checked against nothing.
  const oneSided = compareResults(sharedBaseline(), withCompanion(completePerson(), failing));
  assert.equal(oneSided.checkFailures.length, 1);
  assert.equal(comparisonFails(oneSided), true);
  // A clean companion on both sides passes.
  assert.equal(
    comparisonFails(
      compareResults(
        withCompanion(sharedBaseline(), companionShared()),
        withCompanion(completePerson(), companionPerson()),
      ),
    ),
    false,
  );
});

/**
 * Gate P1 as the box runs it: each layout's launches on Mend's own project, and the scenarios that
 * need a project both accounts see (the different-person join; the hand-over, growth and the
 * person checks) on another one, kept as a companion (`withCompanion`).
 */
const isPair = (name) => /^(join\.other|handover|growth|person)\./.test(name);
const pick = (entries, keep) => Object.fromEntries(Object.entries(entries).filter(keep));
const splitGate = (secondPersonHarnesses = null) => {
  const pairScenarios = ["join-other", ...PERSON_SCENARIOS];
  const launchOnly = SCENARIOS.filter((scenario) => !pairScenarios.includes(scenario));
  const person = completePerson(secondPersonHarnesses);
  const shared = sharedBaseline();
  const personMain = {
    ...person,
    measures: pick(person.measures, ([name]) => !isPair(name)),
    checks: person.checks.filter((check) => !isPair(check.check)),
    options: { ...person.options, only: launchOnly },
  };
  const personPair = {
    ...person,
    target: configsTarget("person"),
    measures: pick(person.measures, ([name]) => isPair(name)),
    checks: person.checks.filter((check) => isPair(check.check)),
    options: { ...person.options, only: pairScenarios },
  };
  const sharedMain = {
    ...shared,
    measures: pick(shared.measures, ([name]) => !isPair(name)),
    options: { ...shared.options, only: launchOnly },
  };
  const sharedPair = {
    ...shared,
    target: configsTarget("shared"),
    measures: pick(shared.measures, ([name]) => isPair(name)),
    options: { ...shared.options, only: ["join-other"] },
  };
  return { personMain, personPair, sharedMain, sharedPair };
};

test("gate P1: a companion of the same run counts toward the set, compared there", () => {
  const { personMain, personPair, sharedMain, sharedPair } = splitGate();
  // Without the companions, the records ran less than the gate's set.
  const alone = compareResults(sharedMain, personMain);
  assert.match(alone.label.kind, /not the gate: the shared record did not run join-other/);
  assert.ok(alone.misses.some((row) => row.measure === "join.other.first_output"));
  assert.ok(alone.checksNotVerified.some((entry) => entry.check === "person.claude.runs_as"));
  // With them, it is the gate, and it passes: each held measure is compared on the companion.
  const together = compareResults(
    withCompanion(sharedMain, sharedPair),
    withCompanion(personMain, personPair),
  );
  assert.deepEqual(together.label.differs, []);
  assert.deepEqual(together.misses, []);
  assert.deepEqual(together.checksNotVerified, []);
  assert.equal(comparisonFails(together), false);
  assert.ok(
    together.rows.some((row) => row.measure === "configs: join.other.first_output" && row.ok),
  );
  assert.ok(
    together.rows.some(
      (row) => row.measure === "configs: growth.pi.extra_person_beyond_state_bytes",
    ),
  );
  assert.ok(!together.rows.some((row) => row.measure === "join.other.first_output"));
  // The companion's series are held to the gate's floors.
  const short = structuredClone(personPair);
  short.measures["join.other.first_output"].samples = [20_000, 20_000, 20_000];
  const shortened = compareResults(
    withCompanion(sharedMain, sharedPair),
    withCompanion(personMain, short),
  );
  assert.ok(
    shortened.misses.some((row) => row.measure === "configs: join.other.first_output" && row.short),
  );
  // A measure only the person companion holds, which the shared companion lacks, is a miss there.
  const lacking = compareResults(
    withCompanion(sharedMain, { ...sharedPair, measures: {} }),
    withCompanion(personMain, personPair),
  );
  assert.ok(
    lacking.misses.some((row) => row.measure === "configs: join.other.first_output" && row.missing),
  );
});

test("gate P1: a companion of another run neither counts nor passes", () => {
  const { personMain, personPair, sharedMain, sharedPair } = splitGate();
  const other = structuredClone(personPair);
  other.target.mendImage = "mend:next sha256:bbbbbbbbbbbb";
  assert.deepEqual(companionMismatchOf(personMain, other), [
    "the Mend images differ (sha256:aaaaaaaaaaaa and sha256:bbbbbbbbbbbb)",
  ]);
  assert.deepEqual(companionMismatchOf(personMain, personPair), []);
  const wrongLayout = structuredClone(personPair);
  wrongLayout.options.layout = "shared";
  wrongLayout.target.layout = "shared";
  assert.match(companionMismatchOf(personMain, wrongLayout)[0], /ran the shared layout/);
  const result = compareResults(
    withCompanion(sharedMain, sharedPair),
    withCompanion(personMain, other),
  );
  assert.ok(
    result.label.differs.some((reason) =>
      /the person record's companion on configs is not of its run: the Mend images differ/.test(
        reason,
      ),
    ),
  );
  assert.ok(
    result.label.differs.some((reason) => /the person record did not run join-other/.test(reason)),
  );
  assert.ok(result.misses.some((row) => row.measure === "join.other.first_output"));
  assert.equal(comparisonFails(result), true);
});

test("gate P1: the partial gate's second person may run in the companion alone", () => {
  const { personMain, personPair, sharedMain, sharedPair } = splitGate(["claude"]);
  personMain.options.secondPersonHarnesses = null;
  personPair.options.secondPersonHarnesses = ["claude"];
  const result = compareResults(
    withCompanion(sharedMain, sharedPair),
    withCompanion(personMain, personPair),
    { secondPersonHarnesses: ["claude"] },
  );
  assert.deepEqual(result.label.differs, []);
  assert.equal(comparisonFails(result), false);
  // The full gate asks the companion's second person for all four.
  assert.ok(
    gateScopeGaps(
      withCompanion(sharedMain, sharedPair),
      withCompanion(personMain, personPair),
    ).includes("the person record's second person did not run codex, pi, opencode"),
  );
});

/** The split gate of review 624, mutated: before and after with their companions, compared. */
const splitCase = (mutate) => {
  const pair = splitGate();
  mutate(pair);
  return compareResults(
    withCompanion(pair.sharedMain, pair.sharedPair),
    withCompanion(pair.personMain, pair.personPair),
  );
};

test("review 624 (1): a companion whose build, workspace or harness identity is unknown is not of the run", () => {
  assert.equal(comparisonFails(splitCase(() => {})), false);
  const result = splitCase(({ personPair, sharedPair }) => {
    for (const companion of [personPair, sharedPair]) {
      companion.target.mendImage = null;
      companion.target.commit = "unknown";
      companion.target.workspaceImage = null;
      companion.target.harnessVersions = {};
    }
  });
  assert.equal(comparisonFails(result), true);
  assert.ok(
    result.label.differs.some((reason) =>
      /companion on configs is not of its run: its Mend build cannot be told/.test(reason),
    ),
  );
  assert.ok(result.label.differs.some((reason) => /did not run join-other/.test(reason)));
  const { personMain, personPair } = splitGate();
  const versionOnly = structuredClone(personPair);
  versionOnly.target.mendImage = null;
  versionOnly.target.commit = null;
  assert.match(companionMismatchOf(personMain, versionOnly).join("; "), /build cannot be told/);
  const noWorkspace = structuredClone(personPair);
  noWorkspace.target.workspaceImage = undefined;
  assert.deepEqual(companionMismatchOf(personMain, noWorkspace), [
    "its workspace image or the record's is not known",
  ]);
  // A harness the companion names needs its version on both; one it does not name, not.
  const noCodex = structuredClone(personPair);
  delete noCodex.target.harnessVersions.codex;
  assert.deepEqual(companionMismatchOf(personMain, noCodex), [
    "codex's version is not known on both",
  ]);
  const claudeOnly = {
    ...structuredClone(personPair),
    measures: { "join.other.first_output": personPair.measures["join.other.first_output"] },
    checks: [],
  };
  // A join names no harness: the one it ran on (the run's first) needs its version too (review
  // 2 of 624, N1).
  claudeOnly.target.harnessVersions = {};
  assert.deepEqual(companionMismatchOf(personMain, claudeOnly), [
    "claude's version is not known on both",
  ]);
  claudeOnly.target.harnessVersions = { claude: personMain.target.harnessVersions.claude };
  assert.deepEqual(companionMismatchOf(personMain, claudeOnly), []);
  claudeOnly.method = { firstHarness: "codex" };
  assert.deepEqual(companionMismatchOf(personMain, claudeOnly), [
    "codex's version is not known on both",
  ]);
  const unsaid = { ...claudeOnly, method: {}, options: { ...claudeOnly.options, harnesses: [] } };
  assert.match(companionMismatchOf(personMain, unsaid).join("; "), /joins ran on is not known/);
  // The split gate whose shared companion lacks the joining harness's version is not the gate.
  const joinVersion = splitCase(({ sharedPair }) => {
    delete sharedPair.target.harnessVersions.claude;
  });
  assert.equal(comparisonFails(joinVersion), true);
  assert.ok(
    joinVersion.label.differs.some((reason) =>
      /shared record's companion on configs is not of its run: claude's version is not known/.test(
        reason,
      ),
    ),
  );
  const noUrl = structuredClone(personPair);
  noUrl.target.url = undefined;
  assert.deepEqual(companionMismatchOf(personMain, noUrl), [
    "its instance or the record's is not known",
  ]);
});

test("review 624 (2): an error in the baseline's companion fails the gate like the baseline's own", () => {
  const result = splitCase(({ sharedPair }) => {
    sharedPair.errors = [{ scenario: "join.other", message: "a baseline round failed" }];
  });
  assert.deepEqual(result.misses, []);
  assert.deepEqual(
    result.baselineErrors.map((error) => error.scenario),
    ["configs: join.other"],
  );
  assert.equal(comparisonFails(result), true);
});

test("review 624 (3): a budgeted companion measure the baseline's companion lacks is a miss", () => {
  const result = splitCase(({ personPair }) => {
    personPair.measures["executor.claude.memory_bytes"] = {
      unit: "bytes",
      budget: "resource",
      samples: tenOf(5_000_000_000),
    };
  });
  assert.deepEqual(
    result.misses.map((row) => [row.measure, row.stat, row.missing]),
    [
      ["configs: executor.claude.memory_bytes", "median", true],
      ["configs: executor.claude.memory_bytes", "p90", true],
    ],
  );
  assert.equal(comparisonFails(result), true);
  // Outside the gate a companion is compared by what it was asked, as before.
  const plain = compareResults(
    withCompanion(record({}), splitGate().sharedPair),
    withCompanion(record({}), {
      ...splitGate().personPair,
      measures: {
        ...splitGate().personPair.measures,
        "executor.claude.memory_bytes": {
          unit: "bytes",
          budget: "resource",
          samples: tenOf(5_000_000_000),
        },
      },
    }),
  );
  assert.ok(!plain.rows.some((row) => row.measure === "configs: executor.claude.memory_bytes"));
});

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A cleanup's world: the owner's and the joiner's API, with what the joiner's memory holds. */
const cleanupWorld = ({ worktrees = "ok", memory = "ok", rid = "proof" } = {}) => {
  const seed = `.claude/projects/-workspace-repo/memory/st-bench-${rid}.md`;
  const stored = new Map([[seed, { path: seed }]]);
  const result = { measures: {}, notRun: [], notes: [], errors: [], checks: [] };
  const ctx = {
    rid,
    project: { id: "p" },
    stateDir: mkdtempSync(path.join(tmpdir(), "st-bench-state-")),
    log: () => {},
    rec: makeRecorder(result, () => {}),
    created: { remoteRefs: new Set(), worktrees: new Map(), sessions: new Set() },
    api: {
      get: async (route) => {
        if (route === "/organization") return { userId: "bench-1" };
        if (route.endsWith("/worktrees")) {
          if (worktrees === "fails") throw new Error("worktree listing failed");
          return { worktrees: [] };
        }
        return { files: [] };
      },
    },
    api2: {
      get: async (route) => {
        if (route === "/organization") return { userId: "bench-2" };
        if (route.endsWith("/memory")) {
          if (memory === "fails") throw new Error("memory listing failed");
          return { files: [...stored.values()] };
        }
        return { files: [] };
      },
      post: async () => ({}),
      delete: async (route) => {
        if (memory === "delete fails") throw new Error("memory delete failed");
        const memoryPath = decodeURIComponent(route.split("?path=")[1]);
        // As the route answers (`AgentMemoryRemoved`): whether there was a file, never a 404.
        return { removed: stored.delete(memoryPath) };
      },
    },
  };
  return { ctx, stored, result };
};

test("review 624 (4): cleanup removes the joiner's memory whatever else failed, and fails loudly", async () => {
  for (const [world, errors] of [
    [{}, []],
    [{ worktrees: "fails" }, ["cleanup · worktrees"]],
    [{ memory: "fails" }, []],
  ]) {
    const { ctx, stored, result } = cleanupWorld(world);
    await cleanupAll(ctx);
    assert.equal(stored.size, 0, JSON.stringify(world));
    assert.deepEqual(
      result.errors.map((error) => error.scenario),
      errors,
    );
  }
  // Gone already is fine; a removal that fails is an error, so `cleanup` exits 1.
  const gone = cleanupWorld();
  gone.stored.clear();
  await cleanupAll(gone.ctx);
  assert.deepEqual(gone.result.errors, []);
  const failing = cleanupWorld({ memory: "delete fails" });
  await cleanupAll(failing.ctx);
  assert.deepEqual(
    failing.result.errors.map((error) => error.scenario),
    ["cleanup · joiner memory"],
  );
  // `--all` lists, and a list that fails is an error, never "nothing to remove".
  const all = cleanupWorld({ memory: "fails" });
  await cleanupAll(all.ctx, { all: true });
  assert.equal(all.stored.size, 1);
  assert.deepEqual(
    all.result.errors.map((error) => error.scenario),
    ["cleanup · joiner memory"],
  );
});

test("review 624 (5): cleanup waits for an import in flight, and nothing new starts once stopping", async () => {
  const { ctx, stored } = cleanupWorld({ rid: "race" });
  stored.clear();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let importing;
  const started = new Promise((resolve) => {
    importing = resolve;
  });
  ctx.opts = { only: ["join-other"], layout: "person", secretFile: false, runs: 1 };
  ctx.result = { target: { harnessVersions: {} }, blocked: [] };
  ctx.api.call = async () => {
    throw new Error("no sessions in this test");
  };
  ctx.api2.post = async (_route, payload) => {
    importing();
    await gate;
    for (const file of payload.files) stored.set(file.path, file);
    return {};
  };
  const run = runAll(ctx).catch(() => null);
  await started;
  // The signal: nothing new starts, and cleanup waits for the import before it decides.
  ctx.stopping = true;
  const cleaning = cleanupAll(ctx);
  setTimeout(release, 50);
  await cleaning;
  await run;
  assert.equal(stored.size, 0);
  // An import asked for after the signal is refused.
  const late = cleanupWorld({ rid: "late" });
  late.stored.clear();
  late.ctx.stopping = true;
  late.ctx.opts = ctx.opts;
  late.ctx.result = ctx.result;
  late.ctx.api.call = ctx.api.call;
  await runAll(late.ctx).catch(() => null);
  assert.equal(late.stored.size, 0);
});

test("review 624 r2 (N4-N6): the executor's cgroup is found by its mount, its id and a whole read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "st-bench-cgroup-"));
  const id = "a".repeat(64);
  const v2Stat = "anon 1000\nactive_file 2000\nshmem 3000\nkernel 4000\n";
  const v1Stat =
    "total_rss 1000\ntotal_active_file 2000\ntotal_shmem 3000\nactive_file 2\nshmem 3\n";
  const parentV2 = { anon: 1000, activeFile: 2000, shmem: 3000, kernel: 4000, reason: null };
  const parentV1 = { ...parentV2, kernel: null };
  const run = ({ name, membership, mounts, files, inspect = `4242 ${id}`, catFails = false }) => {
    const dir = path.join(root, name);
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(dir, "proc", "4242"), { recursive: true });
    mkdirSync(path.join(dir, "proc", "self"), { recursive: true });
    writeFileSync(path.join(dir, "proc", "4242", "cgroup"), membership);
    writeFileSync(
      path.join(dir, "proc", "self", "mountinfo"),
      mounts
        .map(
          ([mountRoot, mountedAt, type, options], index) =>
            `${100 + index} 1 0:${index} ${mountRoot} ${dir}${mountedAt} rw shared:1 - ${type} cgroup ${options}\n`,
        )
        .join(""),
    );
    for (const [cgroupAt, text] of Object.entries(files)) {
      mkdirSync(path.join(dir, cgroupAt), { recursive: true });
      writeFileSync(path.join(dir, cgroupAt, "memory.stat"), text);
    }
    const stub = (tool, text) =>
      writeFileSync(path.join(bin, tool), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
    stub("docker", `printf '%s\\n' '${inspect}'`);
    if (catFails) stub("cat", "exit 1");
    const script = MEMORY_STAT_SH.replaceAll("/proc/", `${dir}/proc/`);
    const out = execFileSync("sh", ["-c", script, "st-bench", "fixture"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    return parseMemoryStat(out);
  };
  const child = "anon 10\nactive_file 20\nshmem 30\nkernel 40\n";
  const scope = `/system.slice/docker-${id}.scope`;
  // Plain v2, the first process in a child: the container's own cgroup, not the child's.
  assert.deepEqual(
    run({
      name: "v2",
      membership: `0::${scope}/init\n`,
      mounts: [["/", "/cg", "cgroup2", "rw"]],
      files: { [`/cg${scope}`]: v2Stat, [`/cg${scope}/init`]: child },
    }),
    parentV2,
  );
  // v1, the memory controller co-mounted with cpu: found by its mount, not assumed.
  assert.deepEqual(
    run({
      name: "v1-comounted",
      membership: `7:cpu,memory:/docker/${id}/init\n4:pids:/docker/${id}\n`,
      mounts: [
        ["/", "/cg/pids", "cgroup", "rw,pids"],
        ["/", "/cg/memory,cpu", "cgroup", "rw,cpu,memory"],
      ],
      files: { [`/cg/memory,cpu/docker/${id}`]: v1Stat },
    }),
    parentV1,
  );
  // Hybrid with memory on v2 (the unified hierarchy at /cg/unified), and with memory on v1.
  assert.deepEqual(
    run({
      name: "hybrid-v2-memory",
      membership: `4:pids:/docker/${id}\n0::${scope}/init\n`,
      mounts: [
        ["/", "/cg/pids", "cgroup", "rw,pids"],
        ["/", "/cg/unified", "cgroup2", "rw"],
      ],
      files: { [`/cg/unified${scope}`]: v2Stat },
    }),
    parentV2,
  );
  assert.deepEqual(
    run({
      name: "hybrid-v1-memory",
      membership: `5:memory:/docker/${id}\n0::${scope}\n`,
      mounts: [
        ["/", "/cg/unified", "cgroup2", "rw"],
        ["/", "/cg/memory", "cgroup", "rw,memory"],
      ],
      files: { [`/cg/memory/docker/${id}`]: v1Stat, [`/cg/unified${scope}`]: child },
    }),
    parentV1,
  );
  // A hierarchy mounted from below its root: the path is taken relative to that root.
  assert.deepEqual(
    run({
      name: "mounted-subtree",
      membership: `5:memory:/docker/${id}\n`,
      mounts: [["/docker", "/cg/memory", "cgroup", "rw,memory"]],
      files: { [`/cg/memory/${id}`]: v1Stat },
    }),
    parentV1,
  );
  // An id that cannot be read is no cgroup at all, never the child's (N5).
  assert.match(
    run({
      name: "no-id",
      membership: `0::${scope}/init\n`,
      mounts: [["/", "/cg", "cgroup2", "rw"]],
      files: { [`/cg${scope}`]: v2Stat, [`/cg${scope}/init`]: child },
      inspect: "4242",
    }).reason,
    /container id could not be read/,
  );
  // A read that fails after the cgroup was found says so (N6).
  assert.match(
    run({
      name: "cat-fails",
      membership: `0::${scope}\n`,
      mounts: [["/", "/cg", "cgroup2", "rw"]],
      files: { [`/cg${scope}`]: v2Stat },
      catFails: true,
    }).reason,
    /could not be read/,
  );
  assert.match(
    run({
      name: "no-mount",
      membership: `0::${scope}\n`,
      mounts: [["/", "/cg/pids", "cgroup", "rw,pids"]],
      files: {},
    }).reason,
    /no v2 memory hierarchy is mounted/,
  );
  assert.equal(parseMemoryStat(`cgroup v2 ${scope}\n`).reason, "its memory.stat held no counters");
  rmSync(root, { recursive: true, force: true });
});

test('review 624 r2 (N3): a worktree that cannot be read is a cleanup failure, retried, never "removed"', async () => {
  const world = cleanupWorld();
  const calls = [];
  const logged = [];
  world.ctx.cleanupWaits = { retry: 1 };
  world.ctx.log = (line) => logged.push(line);
  world.ctx.api.get = async (route) => {
    calls.push(`GET ${route}`);
    if (route === "/organization") return { userId: "bench-1" };
    if (route.endsWith("/worktrees")) {
      return { worktrees: [{ id: "w1", name: "st-bench-proof-claude-1" }] };
    }
    if (route === "/worktrees/w1") throw new ApiError("GET", route, 503, "unavailable");
    return { files: [] };
  };
  world.ctx.api.delete = async (route) => {
    calls.push(`DELETE ${route}`);
    return {};
  };
  await cleanupAll(world.ctx);
  assert.deepEqual(
    world.result.errors.map((error) => error.scenario),
    ["cleanup · worktree st-bench-proof-claude-1"],
  );
  assert.equal(calls.filter((call) => call === "GET /worktrees/w1").length, 3);
  assert.ok(!calls.some((call) => call.startsWith("DELETE /worktrees")));
  assert.ok(!logged.some((line) => /removed worktree/.test(line)));
  // Gone already (404) is done, and said so.
  const gone = cleanupWorld();
  gone.ctx.cleanupWaits = { retry: 1 };
  const goneLog = [];
  gone.ctx.log = (line) => goneLog.push(line);
  gone.ctx.api.get = async (route) => {
    if (route === "/organization") return { userId: "bench-1" };
    if (route.endsWith("/worktrees"))
      return { worktrees: [{ id: "w2", name: "st-bench-proof-pi-1" }] };
    if (route === "/worktrees/w2") throw new ApiError("GET", route, 404, "{}");
    return { files: [] };
  };
  await cleanupAll(gone.ctx);
  assert.deepEqual(gone.result.errors, []);
  assert.ok(goneLog.some((line) => /st-bench-proof-pi-1 was gone already/.test(line)));
});

test("review 624 r2 (N2): what may commit after cleanup is swept again, and nothing launches after a signal", async () => {
  const waits = { pending: 300, final: 1500, grace: 200, retry: 1 };
  // An import whose connection broke: the server commits it 100 ms later.
  const broken = cleanupWorld({ rid: "broken" });
  broken.stored.clear();
  broken.ctx.cleanupWaits = waits;
  broken.ctx.opts = { only: ["join-other"], layout: "person", secretFile: false, runs: 1 };
  broken.ctx.result = { target: { harnessVersions: {} }, blocked: [], method: {} };
  broken.ctx.api.call = async () => {
    throw new ApiError("POST", "/sessions", 400, "no sessions in this test");
  };
  broken.ctx.api2.post = async (_route, payload) => {
    setTimeout(() => {
      for (const file of payload.files) broken.stored.set(file.path, file);
    }, 100);
    throw new TypeError("fetch failed");
  };
  await runAll(broken.ctx).catch(() => null);
  await cleanupAll(broken.ctx);
  assert.equal(broken.stored.size, 0);
  assert.match(
    broken.result.errors.map((error) => error.message).join("\n"),
    /1 request\(s\) ended with no answer: swept again .*cleanup --run broken/,
  );
  // An import still in flight when the first wait ends: swept once it commits.
  const slow = cleanupWorld({ rid: "slow" });
  slow.stored.clear();
  slow.ctx.cleanupWaits = waits;
  slow.ctx.opts = broken.ctx.opts;
  slow.ctx.result = broken.ctx.result;
  slow.ctx.api.call = broken.ctx.api.call;
  slow.ctx.api2.post = (_route, payload) =>
    new Promise((resolve) => {
      setTimeout(() => {
        for (const file of payload.files) slow.stored.set(file.path, file);
        resolve({});
      }, 800);
    });
  const running = runAll(slow.ctx).catch(() => null);
  await sleepMs(50);
  slow.ctx.stopping = true;
  await cleanupAll(slow.ctx);
  await running;
  assert.equal(slow.stored.size, 0);
  assert.match(
    slow.result.errors.map((error) => error.message).join("\n"),
    /a request ran past 0.3 s: swept again once it settled/,
  );
  // A session created as the signal came: its launch is never sent.
  const fenced = cleanupWorld({ rid: "fenced" });
  fenced.ctx.cleanupWaits = waits;
  fenced.ctx.opts = {
    only: ["new"],
    layout: "person",
    secretFile: false,
    runs: 1,
    harnesses: ["claude"],
  };
  fenced.ctx.result = { target: { harnessVersions: {} }, blocked: [], method: {} };
  const posts = [];
  fenced.ctx.api.call = async (method, route) => {
    posts.push(`${method} ${route}`);
    if (route.endsWith("/sessions")) {
      fenced.ctx.stopping = true;
      return { value: { id: "s1", worktree: "st-bench-fenced-claude-1", worktreeId: "w1" }, ms: 1 };
    }
    return { value: {}, ms: 1 };
  };
  await runAll(fenced.ctx).catch(() => null);
  assert.deepEqual(posts, ["POST /projects/p/sessions"]);
});

test("review 624 r3 (N9): a series that ran on another harness in the other layout is not one workload", () => {
  const result = splitCase(({ personPair }) => {
    personPair.method = { firstHarness: "codex" };
    personPair.options = {
      ...personPair.options,
      harnesses: ["codex", "claude", "pi", "opencode"],
    };
  });
  assert.deepEqual(result.label.differs, []);
  assert.deepEqual(
    result.misses.map((row) => [row.measure, row.stat, row.identity]),
    [
      [
        "configs: join.other.first_output",
        "median",
        "the shared series ran on claude, the person series on codex",
      ],
      [
        "configs: join.other.first_output",
        "p90",
        "the shared series ran on claude, the person series on codex",
      ],
    ],
  );
  assert.equal(comparisonFails(result), true);
  assert.match(formatComparison(result), /NOT ONE WORKLOAD: the shared series ran on claude/);
  // A series stamped with another version than its counterpart's is not one workload either.
  const versions = splitCase(({ personPair }) => {
    personPair.measures["join.other.first_output"] = {
      ...personPair.measures["join.other.first_output"],
      harness: "claude",
      harnessVersion: "2.1.999",
    };
    personPair.target.harnessVersions.claude = "2.1.999";
  });
  assert.equal(comparisonFails(versions), true);
});

test("review 624 r3 (N8): a merge keeps each series' own harness and version, and refuses unknown or other ones", () => {
  const { sharedPair } = splitGate();
  const base = stampSeriesIdentity(sharedPair);
  assert.equal(base.measures["join.other.first_output"].harness, "claude");
  assert.equal(base.measures["join.other.first_output"].harnessVersion, "2.1.287");
  const rerun = (harness, versions) => ({
    ...structuredClone(sharedPair),
    options: { ...sharedPair.options, only: ["join-other"], harnesses: [harness] },
    method: { firstHarness: harness },
    target: { ...sharedPair.target, harnessVersions: versions },
    measures: {
      "join.other.first_output": { unit: "ms", budget: "join-other", samples: tenOf(40_000) },
    },
  });
  // The reviewer's case: a Codex re-run whose version is unknown.
  assert.throws(
    () => mergeResults(sharedPair, rerun("codex", { claude: "2.1.287" })),
    /not merged: the later run is not of the record's workload: codex's version is not known on both/,
  );
  // A Codex re-run with its version known is still another series than the record's Claude one.
  assert.throws(
    () => mergeResults(sharedPair, rerun("codex", { codex: "0.160.0" })),
    /join.other.first_output ran on claude 2.1.287 in the record and on codex 0.160.0/,
  );
  // The same harness at the same version merges, and the series says where it ran.
  const merged = mergeResults(sharedPair, rerun("claude", { claude: "2.1.287" }));
  assert.deepEqual(merged.measures["join.other.first_output"].samples, tenOf(40_000));
  assert.equal(merged.measures["join.other.first_output"].harness, "claude");
  assert.equal(merged.measures["join.other.first_output"].harnessVersion, "2.1.287");
  // A stamp wins over the record's first harness: a merged record is read series by series.
  const stamped = {
    ...sharedPair,
    measures: {
      "join.other.first_output": {
        ...sharedPair.measures["join.other.first_output"],
        harness: "codex",
        harnessVersion: null,
      },
    },
  };
  assert.equal(seriesHarnessOf(stamped, "join.other.first_output"), "codex");
  assert.deepEqual(companionMismatchOf(splitGate().sharedMain, stamped), [
    "codex's version is not known on both",
    "its join.other.first_output ran codex of an unknown version, the record says 0.160.0",
  ]);
});

test("review 624 r3 (N10): a run's unknown requests are waited out on disk before a cleanup calls it clean", async () => {
  const waits = { pending: 100, final: 50, grace: 50, retry: 1, quiet: 600 };
  // The interrupted run: its import's connection broke, the server commits it 300 ms later, after
  // the run's second sweep.
  const run = cleanupWorld({ rid: "late01" });
  run.stored.clear();
  run.ctx.cleanupWaits = waits;
  run.ctx.opts = { only: ["join-other"], layout: "person", secretFile: false, runs: 1 };
  run.ctx.result = { target: { harnessVersions: {} }, blocked: [], method: {}, errors: [] };
  run.ctx.rec = makeRecorder(run.ctx.result, () => {});
  run.ctx.api.call = async () => {
    throw new ApiError("POST", "/sessions", 400, "no sessions in this test");
  };
  run.ctx.api2.post = async (_route, payload) => {
    setTimeout(() => {
      for (const file of payload.files) run.stored.set(file.path, file);
    }, 300);
    throw new TypeError("fetch failed");
  };
  await runAll(run.ctx).catch(() => null);
  await cleanupAll(run.ctx);
  const stateFile = path.join(run.ctx.stateDir, "late01.json");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).rid, "late01");
  assert.match(
    run.ctx.result.errors.map((error) => error.message).join("\n"),
    /`cleanup --run late01`, which waits until/,
  );
  // `cleanup --run late01` at once, in a fresh process: it waits the quiet period out, so the late
  // commit is there to remove, and only a second sweep that finds nothing settles it.
  const later = cleanupWorld({ rid: "late01" });
  later.ctx.stateDir = run.ctx.stateDir;
  later.ctx.cleanupWaits = waits;
  later.stored = run.stored;
  later.ctx.api2 = run.ctx.api2;
  later.ctx.api2.delete = async (route) => ({
    removed: run.stored.delete(decodeURIComponent(route.split("?path=")[1])),
  });
  const started = Date.now();
  await cleanupAll(later.ctx, { reconcile: true });
  assert.ok(Date.now() - started >= 300);
  assert.equal(run.stored.size, 0);
  assert.deepEqual(later.result.errors, []);
  assert.throws(() => readFileSync(stateFile));
  // A cleanup by hand whose second sweep still finds something says so and keeps it owed.
  const appearing = cleanupWorld({ rid: "appear" });
  appearing.ctx.cleanupWaits = waits;
  appearing.stored.clear();
  const seed = ".claude/projects/-workspace-repo/memory/st-bench-appear.md";
  let deletes = 0;
  appearing.ctx.api2.delete = async () => {
    deletes += 1;
    // Gone at the first sweep; committed by the second.
    if (deletes === 1) {
      setTimeout(() => appearing.stored.set(seed, { path: seed }), 10);
      return { removed: false };
    }
    return { removed: appearing.stored.delete(seed) };
  };
  await cleanupAll(appearing.ctx, { reconcile: true });
  assert.match(
    appearing.result.errors.map((error) => error.message).join("\n"),
    /appeared after the first sweep/,
  );
  assert.ok(
    JSON.parse(readFileSync(path.join(appearing.ctx.stateDir, "appear.json"), "utf8")).quietUntil >
      Date.now(),
  );
});

test("review 624 r4 (N12, N13): a merge refuses another layout or harness version, and the gate a series its label does not stand for", () => {
  const person = completePerson();
  const shared = sharedBaseline();
  // N12: a shared rerun of the launches into the person record.
  const sharedRerun = {
    ...shared,
    options: { ...shared.options, only: ["new"], harnesses: ["claude"] },
    measures: {
      "new.claude.first_output_excl_install": {
        unit: "ms",
        budget: "start",
        samples: tenOf(1000),
      },
    },
  };
  assert.throws(
    () => mergeResults(person, sharedRerun),
    /not of the record's workload: it ran the shared layout, the record person/,
  );
  // A person record holding a series stamped with the shared layout is not the gate.
  const relabelled = structuredClone(person);
  relabelled.measures["new.claude.first_output_excl_install"].layout = "shared";
  const compared = compareResults(shared, relabelled);
  assert.ok(
    compared.label.differs.some((reason) =>
      /the person record: it holds series of another layout than its own person: new.claude.first_output_excl_install \(shared\)/.test(
        reason,
      ),
    ),
  );
  assert.equal(comparisonFails(compared), true);
  // N13: a growth series newly filled from Claude 2.1.999 into a 2.1.287 workload.
  const withoutGrowth = structuredClone(person);
  delete withoutGrowth.measures["growth.claude.extra_person_beyond_state_bytes"];
  const growthRerun = {
    ...structuredClone(person),
    options: { ...person.options, only: ["growth"] },
    target: {
      ...person.target,
      harnessVersions: { ...person.target.harnessVersions, claude: "2.1.999" },
    },
    measures: {
      "growth.claude.extra_person_beyond_state_bytes": {
        unit: "bytes",
        budget: "growth",
        samples: tenOf(1000),
      },
    },
  };
  assert.throws(
    () => mergeResults(withoutGrowth, growthRerun),
    /claude ran 2.1.287 in the record and 2.1.999 in it/,
  );
  // A ceiling series stamped with another version than its record's is not the gate either.
  const ceiling = structuredClone(person);
  ceiling.measures["growth.claude.extra_person_beyond_state_bytes"].harnessVersion = "2.1.999";
  const ceilingCompared = compareResults(shared, ceiling);
  assert.ok(
    ceilingCompared.label.differs.some((reason) =>
      /its growth.claude.extra_person_beyond_state_bytes ran claude 2.1.999, the record says 2.1.287/.test(
        reason,
      ),
    ),
  );
  assert.equal(comparisonFails(ceilingCompared), true);
});

test("review 624 r4 (N14): cleanup removes only the bench accounts' worktrees, whatever their names", async () => {
  const world = cleanupWorld({ rid: "abc123" });
  world.ctx.cleanupWaits = { retry: 1 };
  const deleted = [];
  const logged = [];
  world.ctx.log = (line) => logged.push(line);
  const owners = { ours: "bench-2", third: "unrelated-third-account", nobody: null };
  world.ctx.api.get = async (route) => {
    if (route === "/organization") return { userId: "bench-1" };
    if (route.endsWith("/worktrees")) {
      return {
        worktrees: Object.keys(owners).map((id) => ({ id, name: `st-bench-abc123-${id}-1` })),
      };
    }
    const id = route.split("/").at(-1);
    if (route.startsWith("/worktrees/")) {
      return { sessions: [{ id: `s-${id}`, ownerUserId: owners[id], settledAt: "x" }] };
    }
    return { files: [] };
  };
  world.ctx.api.delete = async (route) => {
    deleted.push(route);
    return {};
  };
  await cleanupAll(world.ctx, { all: true });
  assert.deepEqual(deleted, ["/worktrees/ours?force=true"]);
  assert.ok(
    logged.some((line) =>
      /st-bench-abc123-third-1 left alone: owned by unrelated-third-account, not a bench account/.test(
        line,
      ),
    ),
  );
  assert.deepEqual(
    world.result.errors.map((error) => error.scenario),
    ["cleanup · worktree st-bench-abc123-nobody-1"],
  );
  // The accounts cannot be told: no worktree is touched.
  const blind = cleanupWorld({ rid: "abc123" });
  blind.ctx.api.get = async (route) => {
    if (route === "/organization") throw new ApiError("GET", route, 503, "down");
    return { worktrees: [{ id: "ours", name: "st-bench-abc123-ours-1" }], files: [] };
  };
  blind.ctx.api.delete = async (route) => {
    deleted.push(route);
    return {};
  };
  await cleanupAll(blind.ctx);
  assert.deepEqual(deleted, ["/worktrees/ours?force=true"]);
  assert.deepEqual(
    blind.result.errors.map((error) => error.scenario),
    ["cleanup · worktrees"],
  );
});

test("review 624 r4 (N11): unresolved state never names a path, never follows a link, and stays private", async () => {
  const waits = { pending: 50, final: 20, grace: 20, retry: 1, quiet: 400 };
  const world = cleanupWorld({ rid: "proof1" });
  world.ctx.cleanupWaits = waits;
  const dir = world.ctx.stateDir;
  // A hostile entry naming another file: that file is never touched; the entry is cleared as its own.
  const victim = path.join(mkdtempSync(path.join(tmpdir(), "st-bench-victim-")), "ordinary.txt");
  writeFileSync(victim, "keep me\n");
  writeFileSync(
    path.join(dir, "proof1.json"),
    JSON.stringify({
      rid: "proof1",
      projectId: "p",
      quietUntil: 0,
      accounts: ["bench-1"],
      file: victim,
    }),
  );
  await cleanupAll(world.ctx, { reconcile: true });
  assert.equal(readFileSync(victim, "utf8"), "keep me\n");
  assert.equal(existsSync(path.join(dir, "proof1.json")), false);
  // A state file that is a link: read as unknown (kept, a failure), and never written through.
  const linked = cleanupWorld({ rid: "proof2" });
  linked.ctx.cleanupWaits = waits;
  symlinkSync(victim, path.join(linked.ctx.stateDir, "proof2.json"));
  await cleanupAll(linked.ctx, { reconcile: true });
  assert.equal(readFileSync(victim, "utf8"), "keep me\n");
  assert.match(
    linked.result.errors.map((error) => error.message).join("\n"),
    /run proof2's unresolved state cannot be read/,
  );
  // A run id that is not one is never a path.
  const traversal = cleanupWorld({ rid: "../ordinary" });
  traversal.ctx.cleanupWaits = waits;
  traversal.ctx.unanswered = 1;
  await cleanupAll(traversal.ctx);
  assert.match(traversal.result.errors.map((error) => error.message).join("\n"), /not a run id/);
  assert.equal(existsSync(path.join(path.dirname(traversal.ctx.stateDir), "ordinary.json")), false);
  // Written private whatever the umask: the directory 0700, the file 0600.
  const fresh = cleanupWorld({ rid: "proof3" });
  fresh.ctx.cleanupWaits = waits;
  fresh.ctx.stateDir = path.join(fresh.ctx.stateDir, "nested");
  fresh.ctx.unanswered = 1;
  const umask = process.umask(0o002);
  try {
    await cleanupAll(fresh.ctx);
  } finally {
    process.umask(umask);
  }
  assert.equal((statSync(fresh.ctx.stateDir).mode & 0o777).toString(8), "700");
  assert.equal(
    (statSync(path.join(fresh.ctx.stateDir, "proof3.json")).mode & 0o777).toString(8),
    "600",
  );
});

test("review 624 r4 (N15, N17): unreadable state, or state of an account not given, is kept and fails the cleanup", async () => {
  const waits = { pending: 50, final: 20, grace: 20, retry: 1, quiet: 400 };
  const corrupt = cleanupWorld({ rid: "proof4" });
  corrupt.ctx.cleanupWaits = waits;
  writeFileSync(path.join(corrupt.ctx.stateDir, "proof4.json"), '{"rid":"proof4","proj');
  await cleanupAll(corrupt.ctx, { reconcile: true });
  assert.ok(existsSync(path.join(corrupt.ctx.stateDir, "proof4.json")));
  assert.match(
    corrupt.result.errors.map((error) => error.message).join("\n"),
    /run proof4's unresolved state cannot be read \(it is not whole JSON\)/,
  );
  // The state says the second account's artifacts are owed; no second token was given.
  const missing = cleanupWorld({ rid: "proof5" });
  missing.ctx.cleanupWaits = waits;
  missing.ctx.api2 = null;
  writeFileSync(
    path.join(missing.ctx.stateDir, "proof5.json"),
    JSON.stringify({
      rid: "proof5",
      projectId: "p",
      quietUntil: 0,
      accounts: ["bench-1", "bench-2"],
    }),
  );
  await cleanupAll(missing.ctx, { reconcile: true });
  assert.ok(existsSync(path.join(missing.ctx.stateDir, "proof5.json")));
  assert.match(
    missing.result.errors.map((error) => error.message).join("\n"),
    /belong to account\(s\) bench-2, which no token given here is \(bench-1\).*; kept/,
  );
});

const proof6State = (quietUntil) =>
  JSON.stringify({ rid: "proof6", projectId: "p", quietUntil, accounts: ["bench-1", "bench-2"] });

test("review 624 r4 (N16): reconciling cleanups take turns, and a renewed obligation is never cleared", async () => {
  const waits = { pending: 50, final: 20, grace: 100, retry: 1, quiet: 300 };
  const first = cleanupWorld({ rid: "proof6" });
  first.ctx.cleanupWaits = waits;
  const dir = first.ctx.stateDir;
  writeFileSync(path.join(dir, "proof6.json"), proof6State(Date.now() + 200));
  const second = cleanupWorld({ rid: "proof6" });
  second.ctx.cleanupWaits = waits;
  second.ctx.stateDir = dir;
  const order = [];
  first.ctx.log = (line) => order.push(`first: ${line}`);
  second.ctx.log = (line) => order.push(`second: ${line}`);
  // While the first waits, another writer renews the obligation; the first must keep it.
  setTimeout(
    () => writeFileSync(path.join(dir, "proof6.json"), proof6State(Date.now() + 250)),
    250,
  );
  const one = cleanupAll(first.ctx, { reconcile: true });
  await sleepMs(50);
  const two = cleanupAll(second.ctx, { reconcile: true });
  await Promise.all([one, two]);
  assert.ok(
    order.some((line) =>
      line.startsWith("second: cleanup · another cleanup is reconciling: waiting"),
    ),
  );
  // The first found the obligation renewed under it: kept, and its cleanup fails for it.
  assert.match(
    first.result.errors.map((error) => error.message).join("\n"),
    /run proof6's unresolved state was renewed meanwhile: kept/,
  );
  // The second read the renewed state after the first let go, waited it out and settled it.
  assert.equal(existsSync(path.join(dir, "proof6.json")), false);
  assert.ok(order.some((line) => /^second: .*nothing more appeared/.test(line)));
  // The kernel lock went with them: it can be taken at once.
  assert.equal(spawnSync("flock", ["-x", "-n", path.join(dir, ".lock"), "true"]).status, 0);
});

/** A run's unresolved state owing both bench accounts' things. */
const owedBy = (world, rid) =>
  writeFileSync(
    path.join(world.ctx.stateDir, `${rid}.json`),
    JSON.stringify({ rid, projectId: "p", quietUntil: 0, accounts: ["bench-1", "bench-2"] }),
  );

test("review 624 r5 (R5-1): a cleanup acting as other accounts never settles a run, nor leaves its worktree quietly", async () => {
  const waits = { pending: 50, final: 20, grace: 20, retry: 1, quiet: 400 };
  // The second token is of a third account: its memory route answers `removed: false` for the
  // joiner's seed, which is not its own.
  const third = cleanupWorld({ rid: "wt0001" });
  third.ctx.cleanupWaits = waits;
  owedBy(third, "wt0001");
  third.ctx.api2.get = async (route) =>
    route === "/organization" ? { userId: "bench-3" } : { files: [] };
  third.ctx.api2.delete = async () => ({ removed: false });
  await cleanupAll(third.ctx, { reconcile: true });
  assert.ok(existsSync(path.join(third.ctx.stateDir, "wt0001.json")));
  assert.match(
    third.result.errors.map((error) => error.message).join("\n"),
    /run wt0001's unresolved requests belong to account\(s\) bench-2, which no token given here is \(bench-1, bench-3\)/,
  );
  // The first token is of a fourth account: the run's own worktree is left, and that is a failure.
  const fourth = cleanupWorld({ rid: "wt0002" });
  fourth.ctx.cleanupWaits = waits;
  fourth.ctx.api.get = async (route) => {
    if (route === "/organization") return { userId: "bench-4" };
    if (route.endsWith("/worktrees")) {
      return { worktrees: [{ id: "w", name: "st-bench-wt0002-claude-1" }] };
    }
    if (route === "/worktrees/w") {
      return { sessions: [{ id: "s", ownerUserId: "bench-1", settledAt: "x" }] };
    }
    return { files: [] };
  };
  await cleanupAll(fourth.ctx, { reconcile: true });
  assert.match(
    fourth.result.errors.map((error) => `${error.scenario}: ${error.message}`).join("\n"),
    /cleanup · worktree st-bench-wt0002-claude-1: left: owned by bench-1, not a bench account; pass the tokens of the accounts that ran it/,
  );
  // A run records its accounts' user ids, not their roles.
  const run = cleanupWorld({ rid: "wt0003" });
  run.ctx.cleanupWaits = waits;
  run.ctx.unanswered = 1;
  await cleanupAll(run.ctx);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(run.ctx.stateDir, "wt0003.json"), "utf8")).accounts,
    ["bench-1", "bench-2"],
  );
});

test("review 624 r5 (R5-2): `cleanup --all` owes again each run whose things appear late, and the project what it cannot tell", async () => {
  const waits = { pending: 50, final: 20, grace: 100, retry: 1, quiet: 600 };
  const world = cleanupWorld({ rid: null });
  world.ctx.cleanupWaits = waits;
  world.stored.clear();
  const dir = world.ctx.stateDir;
  writeFileSync(
    path.join(dir, "ren001.json"),
    JSON.stringify({
      rid: "ren001",
      projectId: "p",
      quietUntil: 0,
      accounts: ["bench-1", "bench-2"],
    }),
  );
  const seed = ".claude/projects/-workspace-repo/memory/st-bench-ren001.md";
  const stray = ".claude/projects/-workspace-repo/memory/st-bench-stray.md";
  // Both commit between the first sweep and the second.
  setTimeout(() => {
    world.stored.set(seed, { path: seed });
    world.stored.set(stray, { path: stray });
  }, 40);
  await cleanupAll(world.ctx, { all: true, reconcile: true });
  const renewed = JSON.parse(readFileSync(path.join(dir, "ren001.json"), "utf8"));
  assert.ok(renewed.quietUntil > Date.now());
  assert.deepEqual(renewed.accounts, ["bench-1", "bench-2"]);
  const whole = readdirSync(dir).find((name) => /^all-[0-9a-f]{12}\.json$/.test(name));
  assert.notEqual(whole, undefined);
  assert.ok(!world.result.errors.some((error) => /not a run id/.test(error.message)));
  assert.match(
    world.result.errors.map((error) => error.message).join("\n"),
    /2 thing\(s\) of run ren001, the project's st-bench things appeared after the first sweep/,
  );
  // The next `--all` waits the renewed period out before it may call anything settled; a `--run`
  // waits the project's too, and never clears it.
  const next = cleanupWorld({ rid: null });
  next.ctx.cleanupWaits = waits;
  next.ctx.stateDir = dir;
  const started = Date.now();
  await cleanupAll(next.ctx, { all: true, reconcile: true });
  assert.ok(Date.now() - started >= 400);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".json")),
    [],
  );
});

test("review 624 r5 (nits): the lock goes with its process, a bad run id is refused offline, the state stays private, earlier merges are re-run", async () => {
  // A cleanup killed while it holds the lock leaves nothing held.
  const dir = mkdtempSync(path.join(tmpdir(), "st-bench-lock-"));
  const holder = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs=require("node:fs");const {spawnSync}=require("node:child_process");` +
        `const fd=fs.openSync(${JSON.stringify(path.join(dir, ".lock"))},"a");` +
        `const r=spawnSync("flock",["-x","-n","9"],{stdio:["ignore","ignore","ignore",0,0,0,0,0,0,fd]});` +
        `process.stdout.write(String(r.status));process.kill(process.pid,"SIGKILL");`,
    ],
    { encoding: "utf8" },
  );
  // It took the lock, and died holding it.
  assert.equal(holder.stdout, "0");
  assert.equal(holder.signal, "SIGKILL");
  assert.equal(spawnSync("flock", ["-x", "-n", path.join(dir, ".lock"), "true"]).status, 0);
  // A run id that is not one is refused before any connection (the url answers nothing).
  const refused = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("bench.mjs", import.meta.url)),
      "cleanup",
      "--run",
      "../x",
      "--url",
      "http://127.0.0.1:9",
      "--no-host",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--run takes a run's id .*, not \.\.\/x/);
  assert.throws(() => parseOptions(["cleanup", "--run", "proof"]), /--run takes a run's id/);
  // A state directory others may read or write is refused, never changed.
  const open = cleanupWorld({ rid: "ope001" });
  open.ctx.cleanupWaits = { pending: 50, final: 20, grace: 20, retry: 1, quiet: 400 };
  chmodSync(open.ctx.stateDir, 0o755);
  await cleanupAll(open.ctx, { reconcile: true }).catch(() => null);
  assert.equal((statSync(open.ctx.stateDir).mode & 0o777).toString(8), "755");
  assert.match(
    open.result.errors.map((error) => error.message).join("\n"),
    /may be read or written by others \(mode 755\)/,
  );
  // A record merged by a bench before series said their layout is not the gate.
  const person = completePerson();
  for (const measure of Object.values(person.measures)) delete measure.layout;
  person.merged = [{ startedAt: "x", only: ["new"], measures: ["new.claude.first_output"] }];
  const compared = compareResults(sharedBaseline(), person);
  assert.ok(
    compared.label.differs.some((reason) =>
      /the person record: it was merged by an earlier bench, whose series do not say their layout/.test(
        reason,
      ),
    ),
  );
});

test("review 624 (6): memory.stat is the executor's own cgroup, v1 read from hierarchical totals only", () => {
  // v1 with a child cgroup: the hierarchical totals, never the parent's local counters.
  assert.deepEqual(
    parseMemoryStat(
      "cgroup v1 /docker/abc\ntotal_rss 1000\nactive_file 20\ntotal_active_file 2000\nshmem 30\ntotal_shmem 3000\n",
    ),
    { anon: 1000, activeFile: 2000, shmem: 3000, kernel: null, reason: null },
  );
  // A v1 file with no totals has no parts, rather than local ones.
  assert.deepEqual(parseMemoryStat("cgroup v1 /docker/abc\nrss 5\nactive_file 6\n"), {
    anon: null,
    activeFile: null,
    shmem: null,
    kernel: null,
    reason: null,
  });
  assert.deepEqual(
    parseMemoryStat(
      "cgroup v2 /system.slice/docker-abc.scope\nanon 1000\nfile 5000\nactive_file 3000\nshmem 7\nkernel 40\n",
    ),
    { anon: 1000, activeFile: 3000, shmem: 7, kernel: 40, reason: null },
  );
  assert.equal(
    parseMemoryStat("unavailable /sys/fs/cgroup/x/memory.stat cannot be read").reason,
    "/sys/fs/cgroup/x/memory.stat cannot be read",
  );
  assert.equal(parseMemoryStat("").reason, "no memory.stat was read");
  // The host script passes whole, as its own argument list, and takes a container name only.
  const command = memoryStatCommand("sealant-abc_1.x");
  const encoded = /printf %s '([^']+)'/.exec(command)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), MEMORY_STAT_SH);
  assert.match(command, / st-bench sealant-abc_1\.x$/);
  assert.throws(() => memoryStatCommand("a; rm -rf /"), /not a container name/);
  // It reads the container's own cgroup: the first process's path is cut at the container's id.
  assert.ok(!MEMORY_STAT_SH.includes("docker exec"));
});

const milestone = (name) => ({ name, at: 0, level: "INFO", fields: {} });

test("a launch with no delivery says why: in place, another person's home, nothing held", () => {
  assert.match(
    noDeliveryReasonOf([milestone("agent memory · already in place")]),
    /already in place/,
  );
  assert.match(
    noDeliveryReasonOf([milestone("secret files not written · the executor is another person's")]),
    /shares one home writes no memory or secret files for another person's join/,
  );
  assert.match(
    noDeliveryReasonOf([
      milestone("capture mode · joining the lease holder"),
      milestone("pickup redeemed"),
    ]),
    /logged no memory or secret-file delivery/,
  );
  assert.match(
    noDeliveryReasonOf([milestone("agent memory · handed over")]),
    /the delivery milestones were not in the log/,
  );
  assert.match(noDeliveryReasonOf(null), /logged no memory/);
});

const responseLine = (time, url, method = "POST") => ({
  at: time,
  message: "Sent HTTP response",
  fields: { "http.method": method, "http.url": url, "http.status": 200 },
});

test("a person's logins written into a workspace are counted in a window", () => {
  const blocks = [
    responseLine(10, "/v1/workspaces/w/credentials"),
    responseLine(20, "/v1/workspaces/w/exec"),
    responseLine(30, "/v1/workspaces/other/credentials"),
    responseLine(40, "/v1/workspaces/w/credentials", "GET"),
    responseLine(50, "/v1/workspaces/w/credentials"),
  ];
  assert.equal(credentialWriteCount(blocks, "w", 0, 100), 2);
  assert.equal(credentialWriteCount(blocks, "w", 11, 100), 1);
});

test("F6: the second person's harnesses are never empty and always hold the hand-over", () => {
  assert.throws(
    () => parseOptions(["compare", "a", "b", "--second-person-harnesses", ""]),
    /claude or codex/,
  );
  assert.throws(
    () => parseOptions(["compare", "a", "b", "--second-person-harnesses", ","]),
    /claude or codex/,
  );
  assert.throws(
    () => parseOptions(["compare", "a", "b", "--second-person-harnesses", "pi"]),
    /claude or codex/,
  );
  assert.throws(() => parseOptions(["run", "--second-person-harnesses", "vim"]), /unknown harness/);
  assert.deepEqual(
    parseOptions(["compare", "a", "b", "--second-person-harnesses", "codex,pi"])
      .secondPersonHarnesses,
    ["codex", "pi"],
  );
});

// ─── the dependency install and the launch call (decision log 2026-10-09) ───

/** Engine lines of one launch's window, every one, as `engineLinesOf` gives them. */
const launchLines = (lines) =>
  lines.map(([at, message, fields = {}]) => ({
    name: milestoneName(message),
    at,
    level: "INFO",
    fields,
    message,
  }));

test("a launch's install is exactly one running line to one end line, with its retries", () => {
  const ran = launchLines([
    [900, "session engine: workspace note"],
    [1000, "session engine: dependency install · running"],
    [75_000, "session engine: dependency install · completed · exit 0 · fetch retries 2"],
    [76_000, "session engine: harness warm-up"],
  ]);
  assert.deepEqual(installOf(ran), {
    kind: "ran",
    ms: 74_000,
    exited: false,
    exitCode: 0,
    fetchRetries: 2,
    reruns: 0,
    why: null,
  });
  const exited = launchLines([
    [1000, "session engine: dependency install · running"],
    [9000, "session engine: dependency install · exited · exit 1"],
  ]);
  assert.deepEqual(installOf(exited), {
    kind: "ran",
    ms: 8000,
    exited: true,
    exitCode: 1,
    fetchRetries: null,
    reruns: 0,
    why: null,
  });
  // A resume whose head carries a tree for its platform, or an install skipped: none.
  assert.deepEqual(
    installOf(launchLines([[500, "session engine: dependency tree observed for this platform"]])),
    { kind: "none", ms: 0, restored: true },
  );
  for (const line of [
    "session engine: dependency install skipped · automatic install off",
    "session engine: dependency install did not run",
  ]) {
    assert.deepEqual(installOf(launchLines([[500, line]])), {
      kind: "none",
      ms: 0,
      restored: false,
    });
  }
  // The log says neither, or not exactly one install: unknown, with why, never taken as none.
  assert.match(
    installOf(launchLines([[900, "session engine: workspace note"]])).reason,
    /lines were not in the log/,
  );
  assert.match(
    installOf(launchLines([[1000, "session engine: dependency install · running"]])).reason,
    /1 "dependency install · running" and 0 end line\(s\)/,
  );
  // A first attempt that did not run and a second that did: two running lines, not one window.
  const twice = launchLines([
    [1000, "session engine: dependency install · running"],
    [2000, "session engine: dependency install did not run"],
    [30_000, "session engine: dependency install · running"],
    [44_000, "session engine: dependency install · completed · exit 0 · fetch retries 0"],
  ]);
  assert.deepEqual(installOf(twice), {
    kind: "unknown",
    reason:
      '2 "dependency install · running" and 1 end line(s) in the launch\'s window; exactly one of each is needed',
  });
  assert.equal(
    installOf(
      launchLines([
        [5000, "session engine: dependency install · completed · exit 0"],
        [6000, "session engine: dependency install · running"],
      ]),
    ).reason,
    "the install's end line precedes its running line",
  );
  assert.deepEqual(installOf(null), { kind: "unknown", reason: NO_HOST });
});

test("an install's end line is read exactly: its exit code and fetch retries (mend#585)", () => {
  const line = (message, fields = {}) => ({ name: milestoneName(message), message, fields });
  assert.deepEqual(
    installEndOf(line("session engine: dependency install · completed · exit 0 · fetch retries 2")),
    { exitCode: 0, fetchRetries: 2 },
  );
  assert.deepEqual(
    installEndOf(line("session engine: dependency install · exited · exit 1 · fetch retries 0")),
    { exitCode: 1, fetchRetries: 0 },
  );
  // A build before mend#585: the exit code, no retries (unknown, never 0).
  assert.deepEqual(installEndOf(line("session engine: dependency install · completed · exit 0")), {
    exitCode: 0,
    fetchRetries: null,
  });
  // Only the structured field is read loosely; other wordings are not the engine's.
  assert.equal(
    fetchRetriesOf(
      line("session engine: dependency install · completed · exit 0", { fetchRetries: 5 }),
    ),
    5,
  );
  assert.equal(
    fetchRetriesOf(
      line("session engine: dependency install · completed · exit 0", { fetchRetries: "3" }),
    ),
    3,
  );
  for (const message of [
    "session engine: dependency install · completed · fetch retries 3 · exit 0",
    "session engine: dependency install · completed · exit 0 · fetch retries: 1",
    "session engine: dependency install · completed · exit 0 · 4 fetch retries",
  ]) {
    assert.equal(fetchRetriesOf(line(message)), null, message);
  }
  // A non-zero exit fails the install, whatever the line's word.
  const install = installOf(
    [
      line("session engine: dependency install · running"),
      {
        ...line("session engine: dependency install · completed · exit 2 · fetch retries 0"),
        at: 5000,
      },
    ].map((entry, index) => ({ at: index === 0 ? 1000 : entry.at, ...entry })),
  );
  assert.deepEqual(
    [install.exited, install.exitCode, install.fetchRetries, install.ms],
    [true, 2, 0, 4000],
  );
});

/** A recorder and its result, for the scenarios' helpers. */
const recording = () => {
  const result = { measures: {}, notRun: [], notes: [], errors: [], checks: [] };
  return { result, ctx: { rec: makeRecorder(result, () => {}) } };
};

test("every install is recorded; a clean one carries the budget, a stalled one is counted apart", () => {
  const { result, ctx } = recording();
  const ran = (ms, fetchRetries, exited = false, reruns = 0) => ({
    kind: "ran",
    ms,
    exited,
    exitCode: exited ? 1 : 0,
    fetchRetries,
    reruns,
  });
  recordInstall(ctx, "new.codex", ran(12_000, 0), "start", "new.codex", "codex #1");
  recordInstall(ctx, "new.codex", ran(70_000, 2), "start", "new.codex", "codex #2");
  recordInstall(ctx, "new.codex", ran(13_000, 0), "start", "new.codex", "codex #3");
  recordInstall(ctx, "new.codex", ran(4000, 0, true), "start", "new.codex", "codex #4");
  assert.deepEqual(result.measures["new.codex.install"].samples, [12_000, 70_000, 13_000, 4000]);
  assert.equal(result.measures["new.codex.install"].budget, null);
  assert.deepEqual(result.measures["new.codex.install_clean"], {
    unit: "ms",
    budget: "start",
    samples: [12_000, 13_000],
  });
  assert.deepEqual(result.measures["new.codex.install_fetch_retries"].samples, [0, 2, 0, 0]);
  assert.match(
    result.notes[0],
    /codex #2: the install stalled on the registry \(2 fetch retries, 70\.0 s\)/,
  );
  // A failed install is a failed check.
  const check = result.checks.find((entry) => entry.check === "new.codex.install_succeeded");
  assert.deepEqual([check.passed, check.failed], [3, 1]);
  assert.match(check.failures[0], /codex #4: the install exited 1/);
  assert.deepEqual(installsOf(result, "new.codex"), {
    installs: 4,
    clean: 2,
    stalled: 1,
    rerun: 0,
    unknown: 0,
    failed: 1,
  });
  // Run again with pnpm's defaults after a shortened run failed on retries: one install, both
  // runs' time, kept out of install_clean even when the count would read clean.
  recordInstall(ctx, "new.codex", ran(31_000, 3, false, 1), "start", "new.codex", "codex #5");
  recordInstall(ctx, "new.codex", ran(30_000, 0, false, 1), "start", "new.codex", "codex #6");
  assert.deepEqual(result.measures["new.codex.install_clean"].samples, [12_000, 13_000]);
  assert.deepEqual(result.measures["new.codex.install_reruns"].samples, [0, 0, 0, 0, 1, 1]);
  assert.match(result.notes.at(-1), /codex #6: the install was run again with pnpm's defaults/);
  assert.deepEqual(installsOf(result, "new.codex"), {
    installs: 6,
    clean: 2,
    stalled: 2,
    rerun: 2,
    unknown: 0,
    failed: 1,
  });
  // An older build's line has no count: install_clean is not run, with why.
  recordInstall(ctx, "new.pi", ran(14_000, null), "start", "new.pi", "pi #1");
  assert.deepEqual(result.measures["new.pi.install"].samples, [14_000]);
  assert.equal(result.measures["new.pi.install_clean"], undefined);
  assert.deepEqual(
    result.notRun.find((entry) => entry.measure === "new.pi.install_clean").reason,
    FETCH_RETRIES_UNKNOWN,
  );
  assert.equal(installsOf(result, "new.pi").unknown, 1);
  // No install, nothing; an unknown one, not run.
  recordInstall(
    ctx,
    "new.claude",
    { kind: "none", ms: 0, restored: false },
    "start",
    "new.claude",
    "x",
  );
  assert.equal(result.measures["new.claude.install"], undefined);
  recordInstall(
    ctx,
    "new.opencode",
    { kind: "unknown", reason: "why" },
    "start",
    "new.opencode",
    "x",
  );
  assert.deepEqual(
    result.notRun.filter((entry) => entry.measure.startsWith("new.opencode")),
    [
      { measure: "new.opencode.install", reason: "why" },
      { measure: "new.opencode.install_clean", reason: "why" },
    ],
  );
});

test("first output and first turn less the install carry the budget; the raw ones stay, unbudgeted", () => {
  const { result, ctx } = recording();
  const install = { kind: "ran", ms: 64_000, exited: false, exitCode: 0, fetchRetries: 3 };
  recordExcludingInstall(ctx, "new.codex.first_output", 78_000, "start", install);
  recordExcludingInstall(ctx, "new.codex.first_turn", 81_000, "start", install);
  assert.deepEqual(result.measures["new.codex.first_output_excl_install"], {
    unit: "ms",
    budget: "start",
    samples: [14_000],
  });
  assert.deepEqual(result.measures["new.codex.first_turn_excl_install"].samples, [17_000]);
  // A launch that ran no install subtracts nothing.
  recordExcludingInstall(ctx, "resume.installed.first_output", 15_000, "start", {
    kind: "none",
    ms: 0,
    restored: false,
  });
  assert.deepEqual(result.measures["resume.installed.first_output_excl_install"].samples, [15_000]);
  // Unknown install: not run, with why; never the raw number under the budgeted name.
  recordExcludingInstall(ctx, "new.pi.first_output", 30_000, "start", installOf(null));
  assert.equal(result.measures["new.pi.first_output_excl_install"], undefined);
  assert.deepEqual(result.notRun, [
    { measure: "new.pi.first_output_excl_install", reason: NO_HOST },
  ]);
});

test("a resume is told apart by whether it reinstalled or restored the saved tree", () => {
  assert.equal(resumeKindOf({ kind: "ran", ms: 1 }), "installed");
  assert.equal(resumeKindOf({ kind: "none", ms: 0, restored: true }), "tree_restored");
  assert.equal(resumeKindOf({ kind: "none", ms: 0, restored: false }), "unclassified");
  assert.equal(resumeKindOf({ kind: "unknown", reason: "x" }), "unclassified");
});

test("the launch call is capped at the answer window, unbudgeted, and its table says so", () => {
  assert.equal(LAUNCH_ANSWER_WINDOW_MS, 30_000);
  assert.equal(launchCallCapped(30_050), true);
  assert.equal(launchCallCapped(30_000), true);
  assert.equal(launchCallCapped(4200), false);
  const { result, ctx } = recording();
  ctx.rec.sample("new.claude.launch_call", 30_050, "ms", null, {
    cappedAtMs: LAUNCH_ANSWER_WINDOW_MS,
  });
  ctx.rec.sample("new.claude.launch_call", 4200, "ms", null, {
    cappedAtMs: LAUNCH_ANSWER_WINDOW_MS,
  });
  assert.deepEqual(result.measures["new.claude.launch_call"], {
    unit: "ms",
    budget: null,
    cappedAtMs: 30_000,
    samples: [30_050, 4200],
  });
  assert.match(
    formatTable(result),
    /\| new\.claude\.launch_call \| 2 \| .* \| none: capped at 30\.0 s \|/,
  );
});

test("a raw launch time an older record budgeted is read as unbudgeted", () => {
  for (const name of [
    "new.claude.first_output",
    "new.pi.first_turn",
    "resume.first_output",
    "resume.first_turn",
    "resume.restore_ms",
    "resume.restore_bytes",
    "new.codex.launch_call",
  ]) {
    assert.equal(budgetOf(name, { budget: "start" }), null, name);
  }
  for (const name of [
    "new.claude.first_output_excl_install",
    "new.claude.install_clean",
    "resume.installed.first_output_excl_install",
    "resume.tree_restored.first_output",
    "resume.tree_restored.restore_ms",
    "join.same.first_output",
    "new.claude.image_built.first_output",
  ]) {
    assert.equal(budgetOf(name, { budget: "start" }), "start", name);
  }
  // A baseline from before 2026-10-09 budgets the raw first output: not compared, nor shown so.
  const before = record({
    "new.claude.first_output": { unit: "ms", budget: "start", samples: tenOf(14_000) },
    "new.claude.launch_call": { unit: "ms", budget: "api", samples: tenOf(5000) },
    "new.claude.first_output_excl_install": { unit: "ms", budget: "start", samples: tenOf(14_000) },
  });
  const after = record({
    "new.claude.first_output": { unit: "ms", budget: null, samples: tenOf(78_000) },
    "new.claude.launch_call": { unit: "ms", budget: null, samples: tenOf(30_050) },
    "new.claude.first_output_excl_install": { unit: "ms", budget: "start", samples: tenOf(14_500) },
  });
  const result = compareResults(before, after);
  assert.deepEqual(
    [...new Set(result.rows.map((row) => row.measure))],
    ["new.claude.first_output_excl_install"],
  );
  assert.deepEqual(result.misses, []);
  assert.match(formatTable(before), /\| new\.claude\.first_output \| 10 \| .* \| – \|/);
});

test("gate P1 requires launch times less the install and clean installs, never the raw ones", () => {
  const required = requiredOf(layoutRecord("person", "1", {}), { gate: true }).measures.map(
    (entry) => entry.measure,
  );
  for (const harness of GATE_HARNESSES) {
    for (const name of ["first_output_excl_install", "first_turn_excl_install", "install_clean"]) {
      assert.ok(required.includes(`new.${harness}.${name}`), `${harness} ${name}`);
      assert.equal(expectedSamplesOf({ options: { runs: 10 } }, `new.${harness}.${name}`), 10);
    }
    for (const name of ["first_output", "first_turn", "launch_call", "install"]) {
      assert.ok(!required.includes(`new.${harness}.${name}`), `${harness} ${name}`);
    }
  }
  assert.ok(!required.some((name) => name.startsWith("resume.")));
  assert.equal(expectedSamplesOf({ options: { runs: 10 } }, "new.pi.first_output"), null);
  // A registry stall in the person record's raw first output does not fail the gate.
  const stalled = completePerson();
  stalled.measures["new.pi.first_output"] = { unit: "ms", budget: null, samples: tenOf(78_000) };
  stalled.measures["new.pi.install"] = { unit: "ms", budget: null, samples: tenOf(64_000) };
  const passed = compareResults(sharedBaseline(), stalled);
  assert.deepEqual(passed.misses, []);
  assert.deepEqual(passed.layoutFailures, []);
  assert.equal(comparisonFails(passed), false);
  // A person record with only the raw first output (an older bench, or no host) misses the gate.
  const raw = completePerson();
  delete raw.measures["new.pi.first_output_excl_install"];
  raw.measures["new.pi.first_output"] = { unit: "ms", budget: "start", samples: tenOf(14_000) };
  const missed = compareResults(sharedBaseline(), raw);
  assert.deepEqual(
    [...new Set(missed.misses.map((row) => row.measure))],
    ["new.pi.first_output_excl_install"],
  );
  assert.equal(comparisonFails(missed), true);
});

test("clean installs are compared across the layouts, and fewer than 5 per harness is a miss", () => {
  // The person layout's own cost inside the install: +4 s on every clean install fails.
  const slower = completePerson();
  slower.measures["new.codex.install_clean"].samples = tenOf(34_000);
  const over = compareResults(sharedBaseline(), slower);
  assert.deepEqual(
    over.misses.map((row) => [row.measure, row.stat]),
    [
      ["new.codex.install_clean", "median"],
      ["new.codex.install_clean", "p90"],
    ],
  );
  // 4 clean installs of 10 (6 stalled): too few to stand, on either side.
  const few = completePerson();
  few.measures["new.pi.install"] = { unit: "ms", budget: null, samples: tenOf(30_000) };
  few.measures["new.pi.install_clean"].samples = [30_000, 30_000, 30_000, 30_000];
  few.measures["new.pi.install_fetch_retries"] = {
    unit: "count",
    budget: null,
    samples: [0, 0, 0, 0, 1, 2, 1, 3, 1, 1],
  };
  const short = compareResults(sharedBaseline(), few);
  const row = short.misses.find((entry) => entry.measure === "new.pi.install_clean");
  assert.equal(
    row.short,
    "the record under test kept 4 of 10 (6 stalled: a fetch retried); at least 5 needed",
  );
  const five = completePerson();
  five.measures["new.pi.install_clean"].samples = tenOf(30_000).slice(0, 5);
  assert.deepEqual(compareResults(sharedBaseline(), five).misses, []);
  const sharedFew = sharedBaseline();
  sharedFew.measures["new.pi.install_clean"].samples = [30_000, 30_000];
  assert.ok(
    compareResults(sharedFew, completePerson()).misses.some(
      (entry) =>
        entry.measure === "new.pi.install_clean" && /^the baseline kept 2 of 10/.test(entry.short),
    ),
  );
  // An older build on either side: no count, not run with why.
  const unknown = completePerson();
  delete unknown.measures["new.claude.install_clean"];
  unknown.notRun = [{ measure: "new.claude.install_clean", reason: FETCH_RETRIES_UNKNOWN }];
  const notRun = compareResults(sharedBaseline(), unknown).misses.find(
    (entry) => entry.measure === "new.claude.install_clean",
  );
  assert.equal(notRun.notRun, FETCH_RETRIES_UNKNOWN);
});

test("installs are counted per layout and reported; a failed one fails the gate on either side", () => {
  const withInstalls = (record, retries, failed) => {
    record.measures["new.codex.install"] = { unit: "ms", budget: null, samples: tenOf(30_000) };
    record.measures["new.codex.install_fetch_retries"] = {
      unit: "count",
      budget: null,
      samples: retries,
    };
    record.checks = [
      ...(record.checks ?? []),
      {
        check: "new.codex.install_succeeded",
        passed: 10 - failed,
        failed,
        skipped: 0,
        detail: null,
        failures: failed > 0 ? ["codex #3: the install exited 1 after 4.0 s"] : [],
      },
    ];
    return record;
  };
  const shared = withInstalls(sharedBaseline(), [0, 0, 0, 0, 0, 0, 0, 0, 2, 0], 0);
  const person = withInstalls(completePerson(), [0, 0, 0, 1, 1, 0, 0, 0, 0, 0], 0);
  const result = compareResults(shared, person);
  assert.deepEqual(result.installs, [
    {
      prefix: "new.codex",
      before: { installs: 10, clean: 10, stalled: 1, rerun: 0, unknown: 0, failed: 0 },
      after: { installs: 10, clean: 10, stalled: 2, rerun: 0, unknown: 0, failed: 0 },
    },
  ]);
  assert.match(
    formatComparison(result),
    /\| new\.codex \| 10 → 10 \| 10 → 10 \| 1 → 2 \| 0 → 0 \| 0 → 0 \| 0 → 0 \|/,
  );
  assert.equal(comparisonFails(result), false);
  // A failed install in the person record is a failed check; in the shared one, a layout failure.
  const personFailed = compareResults(shared, withInstalls(completePerson(), tenOf(0), 1));
  assert.ok(
    personFailed.checkFailures.some((check) => check.check === "new.codex.install_succeeded"),
  );
  assert.equal(comparisonFails(personFailed), true);
  const sharedFailed = compareResults(withInstalls(sharedBaseline(), tenOf(0), 1), person);
  assert.deepEqual(sharedFailed.layoutFailures, [
    "the shared record: 1 failed install(s) in new.codex",
  ]);
  assert.equal(comparisonFails(sharedFailed), true);
});

test("resumes are budgeted by kind, and the person layout may not reinstall more often", () => {
  const resumes = (record, installed, restored, unclassified = 0) => {
    for (const name of Object.keys(record.measures)) {
      if (name.startsWith("resume.")) delete record.measures[name];
    }
    const add = (name, n, budget, value) => {
      if (n > 0) record.measures[name] = { unit: "ms", budget, samples: tenOf(value).slice(0, n) };
    };
    add("resume.installed.first_output", installed, null, 50_000);
    add("resume.installed.first_output_excl_install", installed, "start", 20_000);
    add("resume.tree_restored.first_output", restored, "start", 25_000);
    add("resume.unclassified.first_output", unclassified, null, 25_000);
    return record;
  };
  // The same mix: each kind compared against itself.
  const same = compareResults(resumes(sharedBaseline(), 3, 7), resumes(completePerson(), 3, 7));
  assert.ok(same.rows.some((row) => row.measure === "resume.installed.first_output_excl_install"));
  assert.ok(same.rows.some((row) => row.measure === "resume.tree_restored.first_output"));
  assert.deepEqual(same.resumes.after, { installed: 3, restored: 7, unclassified: 0 });
  assert.deepEqual(same.layoutFailures, []);
  assert.match(formatComparison(same), /Resumes after: 7 restored the saved tree, 3 reinstalled\./);
  // The person layout reinstalls every time: its saved tree is lost, and it would read as faster.
  const lost = compareResults(resumes(sharedBaseline(), 3, 7), resumes(completePerson(), 10, 0));
  assert.deepEqual(lost.misses, []);
  assert.ok(
    lost.incomparable.some(
      (entry) =>
        entry.measure === "resume.tree_restored.first_output" &&
        entry.reason === "the record under test had no resume of this kind",
    ),
  );
  assert.deepEqual(lost.layoutFailures, [
    "the person layout reinstalled at 10 of 10 resumes, the shared at 3 of 10 (more than 2 per 10 resumes over shared): the person layout's saved dependency tree was not restored as often",
  ]);
  assert.equal(comparisonFails(lost), true);
  // Restoring more often than shared is no failure; a kind only one side had is not compared.
  const better = compareResults(resumes(sharedBaseline(), 5, 5), resumes(completePerson(), 2, 8));
  assert.deepEqual(better.layoutFailures, []);
  assert.equal(comparisonFails(better), false);
  // No kind on both sides: no resume time was compared.
  const apart = compareResults(resumes(sharedBaseline(), 10, 0), resumes(completePerson(), 0, 10));
  assert.deepEqual(apart.layoutFailures, [
    "no kind of resume ran in both records (reinstalled, restored the saved tree): no resume time was compared",
  ]);
  // Too few told apart on one side.
  const blind = compareResults(resumes(sharedBaseline(), 3, 7), resumes(completePerson(), 1, 3, 6));
  assert.deepEqual(blind.layoutFailures, [
    "the person record told 4 of 10 resumes apart (reinstalled or restored the saved tree; 6 could not be told); at least 8 needed",
  ]);
});

test("the reinstall rule allows 2 per 10 resumes over shared, scaled, and both shares are printed", () => {
  const kinds = (installed, restored) => ({
    measures: {
      ...(installed > 0
        ? {
            "resume.installed.first_output": {
              unit: "ms",
              budget: null,
              samples: tenOf(1).concat(tenOf(1)).slice(0, installed),
            },
          }
        : {}),
      ...(restored > 0
        ? {
            "resume.tree_restored.first_output": {
              unit: "ms",
              budget: "start",
              samples: tenOf(1).concat(tenOf(1)).slice(0, restored),
            },
          }
        : {}),
    },
  });
  const tooMany = (shared, person) => reinstallSharesOf(kinds(...shared), kinds(...person)).tooMany;
  // 3 of 10 against 5 of 10: 2 per 10 more, noise. 6 of 10: more than 2.
  assert.equal(tooMany([3, 7], [5, 5]), false);
  assert.equal(tooMany([3, 7], [6, 4]), true);
  // Scaled: 1 of 5 (20%) against 8 of 20 (40%) stands, 9 of 20 (45%) does not.
  assert.equal(tooMany([1, 4], [8, 12]), false);
  assert.equal(tooMany([1, 4], [9, 11]), true);
  // Every person resume reinstalled while shared restored one: fails inside the tolerance too.
  const every = reinstallSharesOf(kinds(9, 1), kinds(10, 0));
  assert.deepEqual(every, {
    shared: { installed: 9, of: 10 },
    person: { installed: 10, of: 10 },
    tooMany: true,
    why: "every person resume reinstalled while shared restored the saved tree",
  });
  // Both reinstalled every time: the same in both layouts, no failure.
  assert.equal(tooMany([10, 0], [10, 0]), false);
  assert.equal(reinstallSharesOf(kinds(0, 0), kinds(3, 7)), null);
  // Printed whether or not it fails.
  const withResumes = (record, installed, restored) => {
    Object.assign(record.measures, kinds(installed, restored).measures);
    return record;
  };
  const passing = compareResults(
    withResumes(sharedBaseline(), 3, 7),
    withResumes(completePerson(), 5, 5),
  );
  assert.deepEqual(passing.layoutFailures, []);
  assert.match(
    formatComparison(passing),
    /Shares of resumes that reinstalled: shared 3 of 10 \(30%\), person 5 of 10 \(50%\); gate P1 allows 2 per 10 more/,
  );
  const failing = compareResults(
    withResumes(sharedBaseline(), 3, 7),
    withResumes(completePerson(), 6, 4),
  );
  assert.equal(failing.layoutFailures.length, 1);
  assert.match(formatComparison(failing), /shared 3 of 10 \(30%\), person 6 of 10 \(60%\)/);
});

test("why a resume reinstalled is what the engine's running line says, tallied per layout", () => {
  const log = (fields) =>
    [
      "2026-10-09T10:00:00.000000000Z [10:00:00.000] INFO (#1): session engine: dependency install · running {",
      ...fields.map((line) => `2026-10-09T10:00:00.000000000Z   ${line}`),
      "2026-10-09T10:00:00.000000000Z }",
    ].join("\n");
  const whyOf = (fields) => installWhyOf({ fields: parseMendLog(log(fields))[0].fields });
  assert.equal(
    whyOf([
      "sessionId: 's1',",
      "platform: 'linux-x64-glibc',",
      "capturedFor: [],",
      "command: 'pnpm install --frozen-lockfile'",
    ]),
    "the saved head held no dependency tree (needed: linux-x64-glibc)",
  );
  assert.equal(
    whyOf([
      "sessionId: 's1',",
      "platform: 'linux-x64-glibc',",
      "capturedFor: [ 'linux-arm64-glibc' ],",
      "command: 'pnpm install'",
    ]),
    "the saved head held a tree for linux-arm64-glibc, not linux-x64-glibc",
  );
  assert.equal(whyOf(["sessionId: 's1',", "reason: 'head pending upload'"]), "head pending upload");
  assert.equal(whyOf(["sessionId: 's1'"]), null);
  // installOf carries it with the install.
  const lines = [
    {
      name: "dependency install · running",
      at: 1000,
      fields: { platform: "linux-x64-glibc", capturedFor: "[]" },
      message: "session engine: dependency install · running",
    },
    {
      name: "dependency install · completed",
      at: 15_000,
      fields: {},
      message: "session engine: dependency install · completed · exit 0 · fetch retries 0",
    },
  ];
  assert.equal(
    installOf(lines).why,
    "the saved head held no dependency tree (needed: linux-x64-glibc)",
  );
  // A record's reinstalls, tallied, merged, and printed beside the other layout's.
  const shared = sharedBaseline();
  const { result, ctx } = recording();
  ctx.rec.reinstall({
    run: 1,
    why: "the saved head held no dependency tree (needed: linux-x64-glibc)",
    ms: 14_000,
  });
  ctx.rec.reinstall({ run: 2, why: null, ms: 15_000 });
  ctx.rec.reinstall({
    run: 3,
    why: "the saved head held no dependency tree (needed: linux-x64-glibc)",
    ms: 14_500,
  });
  shared.resumeReinstalls = result.resumeReinstalls;
  assert.deepEqual(reinstallReasonsOf(shared), [
    ["the saved head held no dependency tree (needed: linux-x64-glibc)", 2],
    ["the engine's line gave no reason", 1],
  ]);
  assert.equal(
    mergeResults(shared, {
      ...ofWorkload({}, layoutOf(shared)),
      target: shared.target,
      resumeReinstalls: [{ run: 4, why: "x", ms: 1 }],
    }).resumeReinstalls.length,
    4,
  );
  shared.measures["resume.installed.first_output"] = {
    unit: "ms",
    budget: null,
    samples: [1, 1, 1],
  };
  assert.match(
    formatComparison(compareResults(shared, completePerson())),
    /Why resumes reinstalled before: 2 × the saved head held no dependency tree \(needed: linux-x64-glibc\); 1 × the engine's line gave no reason\./,
  );
});

test("an install run again with pnpm's defaults is one install from its running line to its end", () => {
  const SESSION_ID = "s-rerun";
  const at = (s) => `2026-10-09T10:00:${String(s).padStart(2, "0")}.000000000Z`;
  const entry = (s, message, fields) => [
    `${at(s)} [10:00:${String(s).padStart(2, "0")}.000] INFO (#7): ${message} {`,
    ...fields.map((line) => `${at(s)}   ${line}`),
    `${at(s)} }`,
  ];
  const blocks = parseMendLog(
    [
      ...entry(1, "session engine: dependency install · running", [
        `sessionId: '${SESSION_ID}',`,
        "platform: 'linux-x64-glibc',",
        "capturedFor: [],",
        "command: 'pnpm install --frozen-lockfile'",
      ]),
      ...entry(18, "session engine: dependency install · retried with defaults", [
        `sessionId: '${SESSION_ID}',`,
        "exit: 1,",
        "fetchRetries: 2",
      ]),
      ...entry(41, "session engine: dependency install · completed · exit 0 · fetch retries 3", [
        `sessionId: '${SESSION_ID}',`,
        "fetchRetries: 3,",
        "retriedWithDefaults: true",
      ]),
    ].join("\n"),
  );
  const window = { sessionId: SESSION_ID, fromMs: 0, toMs: Date.parse(at(59)) };
  const install = installOf(engineLinesOf(blocks, window));
  assert.deepEqual(install, {
    kind: "ran",
    ms: 40_000,
    exited: false,
    exitCode: 0,
    fetchRetries: 3,
    reruns: 1,
    why: "the saved head held no dependency tree (needed: linux-x64-glibc)",
  });
  // The step names: the end line without its exit and its retries (mend#585).
  assert.deepEqual(
    milestonesOf(blocks, window).map((m) => m.name),
    [
      "dependency install · running",
      "dependency install · retried with defaults",
      "dependency install · completed",
    ],
  );
  // The end line's own flag counts a re-run whose line the window missed.
  const flagged = installOf(
    engineLinesOf(blocks, window).filter((line) => !line.name.includes("retried")),
  );
  assert.equal(flagged.reruns, 1);
  // A re-run line outside the install's pair is not this install.
  const late = parseMendLog(
    [
      ...entry(1, "session engine: dependency install · running", [`sessionId: '${SESSION_ID}'`]),
      ...entry(10, "session engine: dependency install · exited · exit 1 · fetch retries 2", [
        `sessionId: '${SESSION_ID}'`,
      ]),
      ...entry(12, "session engine: dependency install · retried with defaults", [
        `sessionId: '${SESSION_ID}'`,
      ]),
    ].join("\n"),
  );
  assert.deepEqual(installOf(engineLinesOf(late, window)), {
    kind: "unknown",
    reason: 'a "retried with defaults" line falls outside the install\'s running and end lines',
  });
});
