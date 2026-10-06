import assert from "node:assert/strict";
import test from "node:test";

import {
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
