#!/usr/bin/env node
// The performance benchmark of docs/adr/0016 ("Performance"). It drives a Mend server through its
// API and CLI, takes each step's time from the session record and the server's log, and writes a
// JSON record and a table (median, p90, worst per measure).
//
//   node scripts/bench/bench.mjs run [options]            run the scenarios, write the record
//   node scripts/bench/bench.mjs table <record.json>      print a record's table
//   node scripts/bench/bench.mjs compare <before> <after> check after against before and the budgets
//   node scripts/bench/bench.mjs merge <base> <extra>     fold a later run of some scenarios in
//   node scripts/bench/bench.mjs cleanup [options]        remove every st-bench- resource
//
// `node scripts/bench/bench.mjs help` lists the options. Everything the benchmark creates is named
// `st-bench-…` and removed when it ends, whatever happened, and by `cleanup`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeApi, makeHost } from "./host.mjs";
import {
  compareResults,
  formatComparison,
  formatTable,
  mergeResults,
  parseOptions,
  scenarioOf,
  settleNotRun,
} from "./lib.mjs";
import { HARNESSES, cleanupAll, makeRecorder, runAll } from "./scenarios.mjs";

const USAGE = `usage: node scripts/bench/bench.mjs <run|table|compare|merge|cleanup|help> [args] [options]

server
  --url <url>                 the Mend server (default: the url in --token-file)
  --token-file <path>         the CLI's cli.json or a file holding a bearer (default ~/.config/mend/cli.json)
  --second-token-file <path>  a second account's token, for the different-person join
  --project <name|id>         the project to run in (default: mend)
  --ssh "<ssh args>"          reach the server's host for its logs and docker stats
                              (e.g. "-J root@100.94.101.28 root@10.0.0.40"); omit to run on the host
  --no-host                   never read the host: log-derived steps are reported as not run
  --mend-container <name>     the Mend server's container (default: mend-mend-1)
  --cli "<command>"           the mend CLI to time (e.g. "node apps/cli/dist/main.js"); off by default

what runs
  --only <a,b,…>              scenarios: new,stop,resume,join-same,join-other,interactive,api,handover,growth
                              (default: all)
  --harnesses <a,b,…>         launch harnesses, the first carries the other scenarios
                              (default: claude,codex,pi,opencode)
  --runs <n>                  runs of each launch scenario (default: 10, the ADR's gate)
  --joins-per-run <n>         joins of each kind per run (default: 1)
  --resumes-per-run <n>       resume-and-Stop cycles per run (default: 1)
  --interactive-runs <n>      shell opens, attaches, git fetches and pushes, checkpoints (default: 10)
  --typing-runs <n>           keystrokes timed (default: 30)
  --api-runs <n>              reads of the session list and a session view (default: 20)
  --secret-file               put an st-bench secret file in place to time its delivery (removed after)
  --flag <text>               the harness layout under test (default: read from the server's env)

output and comparison
  --out <path>                where the record goes (default: /tmp/st-bench-<id>.json)
  --stats <a,b>               compared statistics (default: median,p90)
  --rerun                     compare: run each missed measure's scenario once more (needs the server
                              options) and fail only on a repeated miss`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const log = (text) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${text}\n`);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** A bearer from the CLI's cli.json ({ url, token }) or a file that holds only the token. */
const readCredential = (file) => {
  const text = readFileSync(file.replace(/^~(?=\/)/, homedir()), "utf8").trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    return { url: parsed.url ?? null, token: parsed.token };
  }
  return { url: null, token: text };
};

/** Server minus local clock, from the host's `date` with the shortest round trip of five. */
const measureClockOffset = async (host) => {
  if (host === null) return { offsetMs: 0, uncertaintyMs: null };
  let best = null;
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const out = await host.shell("date +%s%N");
    const after = Date.now();
    const serverMs = Number(BigInt(out.trim()) / 1_000_000n);
    const rtt = after - before;
    if (best === null || rtt < best.rtt) best = { rtt, offset: serverMs - (before + after) / 2 };
  }
  return { offsetMs: best.offset, uncertaintyMs: best.rtt / 2 };
};

const gitCommitOf = (version) => {
  try {
    return execFileSync("git", ["rev-parse", `v${version}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const connect = async (opts) => {
  const first = readCredential(opts.tokenFile);
  const url = opts.url ?? first.url;
  if (url === null) throw new Error("no server: pass --url or a cli.json with one");
  const api = makeApi({ url, token: first.token });
  const api2 =
    opts.secondTokenFile === null
      ? null
      : makeApi({ url, token: readCredential(opts.secondTokenFile).token });
  const host = opts.noHost ? null : await makeHost({ ssh: opts.ssh });
  if (host === null && !opts.noHost) {
    log("the server's host is out of reach: log-derived steps will be reported as not run");
  }
  const projects = await api.get("/projects");
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  const project = list.find((entry) => entry.id === opts.project || entry.name === opts.project);
  if (project === undefined) throw new Error(`no project ${opts.project} on ${url}`);
  return { url, api, api2, host, project };
};

const describeTarget = async ({ url, api, host, project }, opts) => {
  const health = await api.get("/health");
  let flag = opts.flag;
  let mendImage = null;
  if (host !== null) {
    if (flag === null) {
      const out = await host
        .shell(`docker exec ${opts.mendContainer} printenv MEND_HARNESS_LAYOUT; true`)
        .catch(() => "");
      flag = out.trim() === "" ? "shared (MEND_HARNESS_LAYOUT unset)" : out.trim();
    }
    mendImage =
      (
        await host
          .shell(`docker inspect ${opts.mendContainer} --format '{{.Config.Image}} {{.Image}}'`)
          .catch(() => "")
      ).trim() || null;
  }
  return {
    url,
    version: health.version ?? null,
    commit: health.version === undefined ? null : gitCommitOf(health.version),
    flag: flag ?? "unknown (no host access)",
    project: { id: project.id, name: project.name },
    mendImage,
    workspaceImage: null,
    harnessVersions: {},
  };
};

const newResult = (opts) => ({
  schema: 1,
  kind: "mend-bench",
  adr: "docs/adr/0016-per-person-harness-homes.md",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  target: null,
  clock: null,
  options: {
    only: opts.only,
    harnesses: opts.harnesses,
    runs: opts.runs,
    joinsPerRun: opts.joinsPerRun,
    resumesPerRun: opts.resumesPerRun,
    interactiveRuns: opts.interactiveRuns,
    typingRuns: opts.typingRuns,
    apiRuns: opts.apiRuns,
    secretFile: opts.secretFile,
  },
  measures: {},
  notRun: [],
  notes: [],
  errors: [],
});

/** Runs the selected scenarios and always cleans up; the finished record. */
const runBench = async (opts) => {
  const connection = await connect(opts);
  const result = newResult(opts);
  const rid = Date.now().toString(36).slice(-6);
  const clock = await measureClockOffset(connection.host);
  result.clock = clock;
  result.target = await describeTarget(connection, opts);
  log(
    `bench ${rid} · ${result.target.url} · ${result.target.version} · project ${connection.project.name} · flag ${result.target.flag}`,
  );
  const ctx = {
    ...connection,
    opts,
    result,
    rid,
    log,
    clockOffsetMs: clock.offsetMs,
    rec: makeRecorder(result, log),
    created: {
      sessions: new Set(),
      worktrees: new Map(),
      remoteRefs: new Set(),
      secretFile: false,
    },
  };
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("interrupted: cleaning up (again to quit without it)");
    cleanupAll(ctx)
      .catch((error) => log(`cleanup failed: ${error.message}`))
      .finally(() => {
        writeJson(opts.out, settleNotRun({ ...result, finishedAt: new Date().toISOString() }));
        process.exit(130);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await runAll(ctx);
  } catch (error) {
    ctx.rec.error("run", error);
  } finally {
    await cleanupAll(ctx).catch((error) => ctx.rec.error("cleanup", error));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return settleNotRun({ ...result, finishedAt: new Date().toISOString() });
};

/** The scenarios and harnesses that re-take a set of missed measures. */
const rerunPlan = (missed, opts) => {
  const only = [...new Set(missed.map(scenarioOf).filter((scenario) => scenario !== null))];
  const launchOnly = only.every((scenario) => scenario === "new" || scenario === "stop");
  const named = [
    ...new Set(
      missed
        .map((name) => /^(?:new|stop|executor)\.([a-z]+)\./.exec(name)?.[1])
        .filter((harness) => HARNESSES.includes(harness)),
    ),
  ];
  const harnesses = launchOnly && named.length > 0 ? named : opts.harnesses;
  return { only, harnesses };
};

const main = async () => {
  const opts = parseOptions(process.argv.slice(2));
  switch (opts.command) {
    case "run": {
      const result = await runBench(opts);
      writeJson(opts.out, result);
      process.stdout.write(`${formatTable(result)}\n`);
      log(`record · ${opts.out}`);
      if (result.errors.length > 0) {
        log(`${result.errors.length} error(s), listed in the record`);
        process.exitCode = 1;
      }
      return;
    }
    case "table": {
      process.stdout.write(`${formatTable(readJson(opts.args[0]))}\n`);
      return;
    }
    case "merge": {
      const merged = mergeResults(readJson(opts.args[0]), readJson(opts.args[1]));
      writeJson(opts.out, merged);
      process.stdout.write(`${formatTable(merged)}\n`);
      log(`merged · ${opts.out}`);
      return;
    }
    case "compare": {
      const before = readJson(opts.args[0]);
      let after = readJson(opts.args[1]);
      let comparison = compareResults(before, after, { stats: opts.stats });
      process.stdout.write(`${formatComparison(comparison)}\n`);
      if (comparison.misses.length > 0 && opts.rerun) {
        const missed = [...new Set(comparison.misses.map((row) => row.measure))];
        const plan = rerunPlan(missed, opts);
        log(`re-running ${plan.only.join(", ")} once for: ${missed.join(", ")}`);
        const again = await runBench({ ...opts, ...plan });
        after = mergeResults(after, again, (name) => missed.includes(name));
        writeJson(opts.out, after);
        comparison = compareResults(before, after, { stats: opts.stats });
        process.stdout.write(`\nafter the re-run\n\n${formatComparison(comparison)}\n`);
        log(`record with the re-run · ${opts.out}`);
      }
      if (comparison.misses.length > 0) {
        log(`${comparison.misses.length} statistic(s) over their limit or missing`);
        process.exitCode = 1;
      } else {
        log("every budgeted statistic within its limit");
      }
      return;
    }
    case "cleanup": {
      const connection = await connect(opts);
      const result = newResult(opts);
      const ctx = {
        ...connection,
        opts,
        result,
        rid: "cleanup",
        log,
        clockOffsetMs: 0,
        rec: makeRecorder(result, log),
        created: {
          sessions: new Set(),
          worktrees: new Map(),
          remoteRefs: new Set(),
          secretFile: false,
        },
      };
      await cleanupAll(ctx);
      if (result.errors.length > 0) process.exitCode = 1;
      return;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      if (opts.command !== "help") process.exitCode = 2;
  }
};

main().catch((error) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
