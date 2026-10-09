#!/usr/bin/env node
// The performance benchmark of docs/adr/0016 ("Performance"). It drives a Mend server through its
// API and CLI, takes each step's time from the session record and the server's log, and writes a
// JSON record and a table (median, p90, worst per measure).
//
//   node scripts/bench/bench.mjs run [options]            run the scenarios, write the record
//   node scripts/bench/bench.mjs table <record.json>      print a record's table
//   node scripts/bench/bench.mjs compare <before> <after> check after against before and the budgets
//   node scripts/bench/bench.mjs merge <base> <extra>     fold a later run of some scenarios in
//   node scripts/bench/bench.mjs companion <main> <other> keep a run on another project inside main
//   node scripts/bench/bench.mjs cleanup --run <id>|--all  remove one run's st-bench- worktrees, or all
//
// `node scripts/bench/bench.mjs help` lists the options. Everything the benchmark creates is named
// `st-bench-<run id>-…` and removed when it ends, whatever happened: its own run's worktrees only,
// so a bench run beside another (a gate run) leaves that one alone. `cleanup --run <id>` removes
// what one run left; `cleanup --all` sweeps every st-bench worktree of the project.
//
// Gate P1 (docs/adr/0016, "Method"): `person` launches against `shared` launches at one commit, each
// on a fresh worktree, the layout picked per launch with the operator's `harnessLayout` (never by
// flipping MEND_HARNESS_LAYOUT). `run --layout shared` and `run --layout person` take the two
// records; `compare <shared> <person>` checks the second against the first and says which
// comparison it is. With `--layout person` three more scenarios run on person worktrees of their own:
// - `handover`: a protocol session of the first account, its conversation grown first to a bounded,
//   realistic size (turns reading two files of 8 to 32 KB each, named by a fixed command, until the
//   last request's prompt reaches `--handover-context-tokens`, default 45,000, in at most
//   `--handover-seed-turns`, default 8; that prompt size, read from the transcript, is recorded),
//   shared control on; each round the second account sends a turn (the hand-over to their process),
//   the owner sends one back, and the owner sends one more (no hand-over). Each turn is timed on the
//   server's clock from its submit to its start, its first output and its end. The ADR's row,
//   "send to first output … under 5 s more than the same turn sent by the process's own person",
//   is budgeted per round as `first_output_over_own` (the steered turn's first output less the own
//   turn's). Sizes are read from this session's own transcript (its harness's conversation id). A
//   shrink of more than a quarter at a steered turn with no compaction in the transcript fails
//   (conversation lost at the hand-over); a recorded compaction, or a shrink at the own turn,
//   discards the round. A seed whose size cannot be read fails. Each turn is checked: billed to its
//   sender, on a process that runs as its sender, one agent live at a time (polled). It runs on
//   claude and codex among the second person's harnesses.
// - `growth`: `--runs` rounds per second-person harness of the second account's own session in the first one's
//   worktree; their saved directory sized, machine state left out, against their conversation state
//   and memory (budget: at most 64 KB beyond them). A round whose second person held no
//   conversation (no ChatGPT login of their own, or no answer) goes under
//   `growth.<harness>.no_conversation.*`, unbudgeted.
// - `person-checks`: per harness, a person launch whose agent runs as a uid of the person range with
//   its own home and answers; a process of the harness runs as them; pi's profile is the person's
//   own, pi's and opencode's ChatGPT login is in their home; for pi, the second account joins and
//   its pi has its own profile, not the first one's. Probed in the executor as that person (its own
//   processes left out), without printing a file's contents. A person with no ChatGPT login is
//   watched for 150 s, not waited on: an answer then fails.
// The second person's harnesses (`--second-person-harnesses`, default all) are the ones their
// connected accounts can run: pi and opencode need a Codex account.
// Checks are observations, not timings: they are tallied in the record's `checks` (held, failed,
// skipped), and a failed one fails `run` and `compare`. `run` exits 1 on an error, a failed check,
// or, in a person run, a per-person scenario or join-other that could not run (no second account)
// or person-checks without the host. `compare` exits 1 unless everything passed: under gate P1 it
// asks for the whole set whatever the records' --only/--harnesses said (see "gate P1" below), a
// budgeted measure either side lacks, an error on either side, or anything that makes it "not the
// gate" fails it.
//
// What the record keeps apart, so one run's accident does not read as a regression:
// - An executor's size (`executor.<harness>.*_bytes`) is taken at the launch's first output, a fixed
//   point; `memory_after_answer_bytes` is what it holds once the answer is in. Records before
//   `method.executorResources` took it after the answer wait, so `compare` calls the two not
//   comparable instead of checking one against the other.
// - A launch whose executor runs a workspace image Docker made during that launch waited for the
//   build: its numbers go under `new.<harness>.image_built.*` (or `resume.image_built.*`),
//   unbudgeted, with a note. Every image made during the run is listed in `imageBuilds`. Needs the
//   host.
// - A harness that says its account hit a usage limit until it resets ("You've hit your weekly
//   limit", "Usage limit reached", "5-hour limit reached") will not answer: the wait ends there, the
//   run gets a note, and `first_turn` is recorded as not run with that reason, which `compare`
//   prints in place of MISSING. A rate limit the harness retries by itself is not one.
// - A launch's dependency install fetches every tarball from the public npm registry, whose stalls
//   swing it 14–78 s in either layout. The install's window is exactly one engine "dependency
//   install · running" line and one "· completed"/"· exited" line (else its measures are not run,
//   with why). Its time is `<prefix>.install` for every install; the engine's count of fetches pnpm
//   retried (`install_fetch_retries`) splits clean installs (`install_clean`, none retried) from
//   stalled ones. An install the engine ran again with pnpm's defaults ("retried with defaults",
//   between the two lines) is one install over both runs, counted in `install_reruns` and kept out
//   of `install_clean`. A clean install holds the person's own cost (the install runs as the launcher,
//   with their login profile, the store under /var/cache, default ACLs on each new file), so it is
//   budgeted (+5% or +1 s), and gate P1 needs at least 5 per harness per layout; stalled installs
//   are counted per layout and reported. With no count in the line (older builds) `install_clean`
//   is not run. A failed install is a failed check (`<launch>.install_succeeded`). The start budget
//   of a new launch is on `first_output_excl_install` and `first_turn_excl_install`, the launch's
//   time less its install; the raw `first_output`/`first_turn` are kept, unbudgeted.
// - A resume is kept apart by kind: `resume.tree_restored.*` (the saved dependency tree restored)
//   and `resume.installed.*` (reinstalled; its start budget less the install), each budgeted
//   against the same kind, with `resume.unclassified.*` when the log cannot tell. Gate P1 fails when
//   the person layout reinstalls at a share of resumes more than 2 per 10 over shared's (scaled),
//   or at every resume while shared restored at least one, or either side tells too few apart; both
//   shares are printed either way. Each reinstall keeps why the engine said it ran
//   (`resumeReinstalls`, tallied per layout in the comparison). These need the host; `compare`
//   reads raw measures an older record budgeted as unbudgeted (docs/adr/0016, decision log
//   2026-10-09).
// - `new.<harness>.launch_call` is capped: the server answers the launch after its 30 s answer
//   window at the latest and the launch goes on. It is unbudgeted (`cappedAtMs` on the measure),
//   with `launch_call_capped` (1 when the call took the whole window) and a note per capped call.
// - The answer is watched for from the first output on, while the executor is sized beside it.
// - A merge stamps each executor size with the point its own record sampled it at (`sampledAt`).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeApi, makeHost, mendImageCommit } from "./host.mjs";
import {
  compareResults,
  comparisonFails,
  failedChecks,
  formatComparison,
  formatTable,
  mergeResults,
  parseOptions,
  scenarioOf,
  RESOURCES_AT_FIRST_OUTPUT,
  settleNotRun,
  withCompanion,
} from "./lib.mjs";
import { HARNESSES, cleanupAll, makeRecorder, runAll } from "./scenarios.mjs";

const USAGE = `usage: node scripts/bench/bench.mjs <run|table|compare|merge|companion|cleanup|help> [args] [options]

server
  --url <url>                 the Mend server (default: the url in --token-file)
  --token-file <path>         the CLI's cli.json or a file holding a bearer (default ~/.config/mend/cli.json)
  --second-token-file <path>  a second account's token: the different-person join, the hand-over and
                              growth
  --project <name|id>         the project to run in (default: mend)
  --ssh "<ssh args>"          reach the server's host for its logs and docker stats
                              (e.g. "-J root@100.94.101.28 root@10.0.0.40"); omit to run on the host
  --no-host                   never read the host: log-derived steps are reported as not run
  --mend-container <name>     the Mend server's container (default: mend-mend-1)
  --cli "<command>"           the mend CLI to time (e.g. "node apps/cli/dist/main.js"); off by default

what runs
  --only <a,b,…>              scenarios: new,stop,resume,join-same,join-other,interactive,api,
                              handover,growth,person-checks (default: all)
  --layout <person|shared>    the harnessLayout of every start that makes a new worktree (the
                              operator's, docs/adr/0016 decision 14); omitted, the server's flag
                              decides. handover, growth and person-checks need --layout person
  --harnesses <a,b,…>         launch harnesses, the first carries the other scenarios; person-checks
                              runs on each (default: claude,codex,pi,opencode)
  --second-person-harnesses <a,b,…>
                              run: the harnesses the second person runs: the hand-over (claude, codex
                              among them), growth and the joined pi (default: --harnesses). Their
                              connected accounts decide it: pi and opencode need a Codex account.
                              compare: the explicit opt-in to a partial gate P1 that asks the second
                              person for these only, said in the verdict. Never empty, and always
                              holds claude or codex (the hand-over runs on them)
  --runs <n>                  runs of each launch scenario, rounds of the hand-over and of growth
                              (default: 10, the ADR's gate)
  --joins-per-run <n>         joins of each kind per run (default: 1)
  --resumes-per-run <n>       resume-and-Stop cycles per run (default: 1)
  --interactive-runs <n>      shell opens, attaches, git fetches and pushes, checkpoints (default: 10)
  --typing-runs <n>           keystrokes timed (default: 30)
  --api-runs <n>              reads of the session list and a session view (default: 20)
  --secret-file               put an st-bench secret file in place to time its delivery (removed after)
  --handover-context-tokens <n>
                              the hand-over's conversation is grown until its last request's prompt
                              is this many tokens (default: 45000)
  --handover-seed-turns <n>   at most this many turns grow it, each reading two files of 8 to 32 KB
                              (default: 8)
  --run <id>                  cleanup: the run whose worktrees to remove (its log's "bench <id>")
  --all                       cleanup: every st-bench worktree of the project, any run's
  --flag <text>               the harness layout under test (default: read from the server's env).
                              Run against MEND_MODE=all: with MEND_MODE=api beside MEND_MODE=worker,
                              the worker's engine sees an operator's harnessLayout request made
                              through the api only after the worker restarts

output and comparison
  --out <path>                where the record goes (default: /tmp/st-bench-<id>.json)
  --stats <a,b>               compared statistics (default: median,p90)
  --rerun                     compare: run each missed measure's scenario once more (needs the server
                              options) and fail only on a repeated miss; the re-run takes the layout
                              of the record under test unless --layout says otherwise

gate P1 (docs/adr/0016): person launches against shared launches at one commit
  run --layout shared … --out shared.json; run --layout person … --out person.json;
  compare shared.json person.json [--second-person-harnesses <a,b>]. Under the gate compare asks
  for the whole set whatever the records' --only/--harnesses said: every launch scenario for the
  four harnesses in both records, and the hand-over, growth, the different-person join and the
  person checks for the harnesses the second person runs (all four unless
  --second-person-harnesses opts into a partial gate, which the verdict line says). A record that
  ran less, another Mend image (its id, else its commit), instance, project, workspace image or
  harness version make it "not the gate", and that fails. A budgeted measure either side lacks is
  a miss, and the baseline's errors fail it too. A per-round series (launches and Stops, the
  hand-over's differences, growth, joins, resumes) that kept fewer than 80% of its rounds, or
  fewer than 5, is a miss (SHORT), and a record of fewer than 10 rounds is not the gate. A
  companion record's failed checks and errors count, on either side. Ceiling budgets (the hand-over's 5 s over the own
  turn, growth's 64 KB) are checked on the record under test alone. It also fails on a failed or
  unverified check and on an error in the record under test. It says what it does not cover: P1's
  restore wall time on the box's largest worktree, interleaved between the layouts. The last line
  is the verdict; exit 0 only when it says passed

what the record keeps apart
  executor sizes              taken at each launch's first output; memory_after_answer_bytes is what
                              the executor holds once the answer is in. compare calls a record that took
                              them after the answer wait (before method.executorResources) not comparable
  image builds                a launch whose workspace image was built during it (Docker's Created, read
                              on the host) goes under new.<harness>.image_built.*, unbudgeted; every
                              image built during the run is listed in imageBuilds
  usage limits                a harness that says its account hit a usage limit until it resets is not
                              waited on: first_turn is not run, with its words as the reason. A rate
                              limit the harness retries by itself is waited out like any other delay
  layouts                     the record keeps the layout asked for (options.layout, target.layout); a
                              launch whose agent ran in the other one (runsAs says) goes under
                              new.<harness>.other_layout.*, unbudgeted, and its layout check fails
  checks                      correctness observations (who a process runs as, who a turn billed, one
                              agent at a time, homes, logins, pi profiles) are tallied under checks,
                              never as timings; a failed one fails run and compare`;

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

/** Server minus local clock; zero, with no stated uncertainty, when the host is out of reach. */
const measureClockOffset = async (host) =>
  host === null ? { offsetMs: 0, uncertaintyMs: null } : host.clockOffset();

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
  let imageCommit = null;
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
    imageCommit = await mendImageCommit(host, opts.mendContainer).catch(() => null);
  }
  let storeBytes = null;
  if (host !== null && typeof project.storePath === "string") {
    const out = await host
      .shell(`docker exec ${opts.mendContainer} du -sb ${project.storePath}; true`)
      .catch(() => "");
    const bytes = Number(out.trim().split(/\s+/)[0]);
    storeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  }
  return {
    url,
    version: health.version ?? null,
    // The running image's revision label, else a local `v<version>` tag (prereleases have none),
    // else said unknown: `compare` warns, and tells builds apart by the image's id.
    commit:
      imageCommit ??
      (health.version === undefined ? null : gitCommitOf(health.version)) ??
      "unknown",
    flag: flag ?? "unknown (no host access)",
    // What every start that made a worktree asked for; null: the server's flag decided.
    layout: opts.layout,
    project: {
      id: project.id,
      name: project.name,
      visibility: project.visibility ?? null,
      originUrl: project.originUrl ?? null,
      storeBytes,
    },
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
    layout: opts.layout,
    // Whether a second account's token was given: the person-only scenarios need it.
    secondAccount: opts.secondTokenFile !== null,
    handoverSeedTurns: opts.handoverSeedTurns,
    handoverContextTokens: opts.handoverContextTokens,
    // The harnesses the second person ran (hand-over, growth, the joined pi); null: all of them.
    secondPersonHarnesses: opts.secondPersonHarnesses,
  },
  // Where each launch harness's executor size was taken (`compare` reads it).
  method: { executorResources: RESOURCES_AT_FIRST_OUTPUT },
  measures: {},
  notRun: [],
  notes: [],
  // Correctness observations (`rec.check`), tallied per check; never timings.
  checks: [],
  // Workspace images Docker made during the run; a launch that waited for one is kept apart.
  imageBuilds: [],
  errors: [],
});

/** Runs the selected scenarios and always cleans up; the finished record. */
const runBench = async (opts) => {
  const connection = await connect(opts);
  const result = newResult(opts);
  const rid = Date.now().toString(36).slice(-6);
  // The run's id names its worktrees (`st-bench-<rid>-…`); its cleanup takes only those.
  result.rid = rid;
  result.blocked = [];
  const clock = await measureClockOffset(connection.host);
  result.clock = clock;
  result.target = await describeTarget(connection, opts);
  log(
    `bench ${rid} · ${result.target.url} · ${result.target.version} · project ${connection.project.name} · flag ${result.target.flag} · layout ${opts.layout ?? "the server's"}`,
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
      const failed = failedChecks(result);
      if (failed.length > 0) {
        log(`${failed.length} check(s) failed: ${failed.map((check) => check.check).join(", ")}`);
        process.exitCode = 1;
      }
      // Per-person scenarios asked of a person run that could not run (no second account, no host).
      for (const blocked of result.blocked ?? []) {
        log(`${blocked.scenario} was asked for and did not run: ${blocked.reason}`);
        process.exitCode = 1;
      }
      log(`run id ${result.rid} · \`cleanup --run ${result.rid}\` removes what it left`);
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
    case "companion": {
      const joined = withCompanion(readJson(opts.args[0]), readJson(opts.args[1]));
      writeJson(opts.out, joined);
      process.stdout.write(`${formatTable(joined)}\n`);
      log(`with companion · ${opts.out}`);
      return;
    }
    case "compare": {
      const before = readJson(opts.args[0]);
      let after = readJson(opts.args[1]);
      // The partial gate is an explicit choice on this command line, never read from a record.
      const compareOptions = {
        stats: opts.stats,
        secondPersonHarnesses: opts.secondPersonHarnesses,
      };
      let comparison = compareResults(before, after, compareOptions);
      process.stdout.write(`${formatComparison(comparison)}\n`);
      if (comparison.misses.length > 0 && opts.rerun) {
        // The re-run's checks and errors come with its numbers (mergeResults), so a re-run that
        // was fast because it ran as the wrong person fails on its checks.
        const missed = [...new Set(comparison.misses.map((row) => row.measure))];
        const plan = rerunPlan(missed, opts);
        log(`re-running ${plan.only.join(", ")} once for: ${missed.join(", ")}`);
        const layout = opts.layout ?? after.options?.layout ?? null;
        const again = await runBench({ ...opts, ...plan, layout });
        after = mergeResults(after, again, (name) => missed.includes(name));
        writeJson(opts.out, after);
        comparison = compareResults(before, after, compareOptions);
        process.stdout.write(`\nafter the re-run\n\n${formatComparison(comparison)}\n`);
        log(`record with the re-run · ${opts.out}`);
      }
      if (comparison.misses.length > 0) {
        log(`${comparison.misses.length} statistic(s) over their limit or missing`);
      } else {
        log("every budgeted statistic within its limit");
      }
      if (comparison.checkFailures.length > 0) {
        log(`${comparison.checkFailures.length} check(s) of the record under test failed`);
      }
      if (comparison.layoutFailures.length > 0) {
        log(
          `${comparison.layoutFailures.length} failure(s) between the layouts (installs, resumes)`,
        );
      }
      if (comparison.checksNotVerified.length > 0) {
        log(
          `${comparison.checksNotVerified.length} check(s) the record must hold were not seen holding`,
        );
      }
      if (comparison.errors.length > 0) {
        log(`${comparison.errors.length} error(s) in the record under test`);
      }
      if (comparison.gate && comparison.label.differs.length > 0) {
        log(`not the gate: ${comparison.label.differs.join("; ")}`);
      }
      if (comparison.gate && comparison.baselineErrors.length > 0) {
        log(`${comparison.baselineErrors.length} error(s) in the shared baseline`);
      }
      for (const item of comparison.label.notCovered) log(`not covered: ${item}`);
      const fails = comparisonFails(comparison);
      log(`verdict · ${comparison.label.kind} · ${fails ? "FAILED" : "passed"}`);
      if (fails) process.exitCode = 1;
      return;
    }
    case "cleanup": {
      const connection = await connect(opts);
      const result = newResult(opts);
      const ctx = {
        ...connection,
        opts,
        result,
        // `--run <id>` scopes it to one run; `--all` sweeps every st-bench worktree.
        rid: opts.runId,
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
      await cleanupAll(ctx, { all: opts.all });
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
