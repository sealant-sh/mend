import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { changedFiles, computePlan } from "./plan.mjs";
import {
  ALLOWED_SKIPS,
  installHint,
  judgeSkips,
  loadAllowedSkips,
  localGates,
  readSkips,
  summarizeSkips,
} from "./skips.mjs";
import { atRisk, readFileTimes, summarizeRisk } from "./timing.mjs";

// The pre-PR gate: exactly what AGENTS.md lists before a PR (forced typecheck and lint, the tests
// of the packages the change affects, formatting), each a step. Tests run with
// CI_TEST_REPORT_DIR set, so every Vitest package and node --test suite writes the JSON report CI
// reads (tooling/test-ci, scripts/ci-test-report.mjs); skipped tests are read from those reports.

// Agent skills: the verify skill (recipes, feature notes, its scripts), the box run's flows.md and
// the model-checking skills. turbo.json makes the verify skill an input of every package's test
// task, so CI's shared cache never serves a test result from before a verify script changed. No
// package's tests read a file here, so the gate leaves these files out when it asks turbo which
// packages a change reaches; otherwise every route PR's recipe ran every package's tests.
const AGENTS = ".agents/";

/** The node --test files a change asks for: changed tests, and the tests beside changed scripts. */
export const scriptTests = (root, files) => {
  const tests = new Set();
  // .agents/ holds the verify skill's scripts and recipes; a test beside any of them runs.
  const roots = ["scripts/", "tooling/verify/", AGENTS];
  for (const file of files) {
    if (!roots.some((prefix) => file.startsWith(prefix)) || !file.endsWith(".mjs")) continue;
    if (file.startsWith("tooling/verify/")) {
      for (const name of readdirSync(join(root, "tooling/verify")))
        if (name.endsWith(".test.mjs")) tests.add(`tooling/verify/${name}`);
      continue;
    }
    const test = file.endsWith(".test.mjs") ? file : file.replace(/\.mjs$/, ".test.mjs");
    if (existsSync(join(root, test))) tests.add(test);
  }
  return [...tests].toSorted();
};

const postgresUrl = (env) =>
  env.MEND_TEST_DATABASE_URL ?? "postgres://mend:mend@localhost:5434/mend";

const reachable = (url) =>
  new Promise((resolve) => {
    const { hostname, port } = new URL(url);
    const socket = connect({ host: hostname, port: Number(port || 5432) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const run = (root, command, args, { env, log }) =>
  new Promise((resolve) => {
    mkdirSync(dirname(log), { recursive: true });
    const out = createWriteStream(log);
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", (error) => {
      out.end(`\n${String(error)}\n`);
      resolve(127);
    });
    child.once("close", (code) => out.end(() => resolve(code ?? 1)));
  });

/**
 * Every step the gate can report, in order. CI must run each one too, so a commit CI passes also
 * passes this gate: scripts/ci-workflow.test.mjs says which CI job runs each step, or why CI cannot,
 * and fails when this list names a step it does not.
 */
export const GATE_STEPS = [
  { id: "build", title: "Generated route trees" },
  { id: "typecheck", title: "Typecheck, forced", args: ["exec", "turbo", "typecheck", "--force"] },
  { id: "lint", title: "Lint, forced", args: ["exec", "turbo", "lint", "--force"] },
  {
    id: "recipes-lint",
    title: "Verify recipes lint",
    args: ["exec", "oxlint", "--deny-warnings", ".agents/skills/verify/recipes"],
  },
  { id: "tests", title: "Affected packages' tests" },
  { id: "format", title: "Format check", args: ["format:check"] },
];

/** A gate step by id. A step missing from GATE_STEPS throws, so it cannot dodge CI's parity test. */
const gateStep = (id) => {
  const step = GATE_STEPS.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`verify check: ${id} is not in GATE_STEPS`);
  return step;
};

const timed = async ({ id, ...fields }, work) => {
  const { args: _args, ...known } = gateStep(id);
  const step = { ...known, ...fields };
  const started = Date.now();
  process.stderr.write(`verify check: ${step.title}…\n`);
  const result = await work();
  const done = { ...step, ...result, durationMs: Date.now() - started };
  process.stderr.write(`verify check: ${step.title}: ${done.status}\n`);
  return done;
};

const relLog = (root, path) => relative(root, path);

/** Turbo's own count, so a run that tested no package says so. */
const turboTasks = (log) => {
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  const total = /Tasks:\s+(\d+) successful, (\d+) total/.exec(text);
  return total ? `${total[2]} test tasks` : "test task count unknown";
};

/** The packages whose tests turbo ran, read from its task prefixes (`@mend/web:test: …`). */
export const testedPackages = (log) => {
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  return [...new Set([...text.matchAll(/^(\S+):test: /gm)].map((match) => match[1]))].toSorted();
};

/**
 * A commit holding HEAD's tree with everything under .agents/ as it was at the merge base, so the
 * diff turbo reads from the merge base is the change without .agents/. It is written only to the
 * object store (a temporary index, no ref), and git collects it later.
 */
const commitWithoutAgents = (root, { sha, mergeBase }) => {
  const scratch = mkdtempSync(join(tmpdir(), "mend-verify-scope-"));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_AUTHOR_NAME: "verify check",
      GIT_AUTHOR_EMAIL: "verify-check@localhost",
      GIT_COMMITTER_NAME: "verify check",
      GIT_COMMITTER_EMAIL: "verify-check@localhost",
    };
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(["read-tree", sha]);
    git(["reset", "-q", mergeBase, "--", AGENTS]);
    const tree = git(["write-tree"]);
    return git(["commit-tree", "--no-gpg-sign", tree, "-p", mergeBase, "-m", "verify check scope"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * What the test step asks turbo for, and why, in words. Only a change with files under .agents/
 * departs from plain `--affected`, and only when the tree is clean: turbo always adds uncommitted
 * changes to the diff it reads, and a gate on a dirty tree counts for no receipt anyway. Anything
 * that goes wrong keeps plain `--affected`, which runs more, never less.
 */
export const testScope = (root, { head, files, all }) => {
  if (all) return { reason: "--all asks for every package's tests" };
  if (head.mergeBase === null)
    return { reason: `turbo --affected from its default base: no merge base with ${head.base}` };
  const from = `turbo --affected from the merge base ${head.mergeBase.slice(0, 10)}`;
  const agents = files.filter((file) => file.startsWith(AGENTS)).length;
  if (agents === 0) return { reason: from };
  const kept = `${from}, ${agents} files under ${AGENTS} included`;
  if (head.dirty)
    return { reason: `${kept}: the tree has uncommitted changes, which turbo always reads` };
  try {
    return {
      scmHead: commitWithoutAgents(root, head),
      reason: `${from}, leaving out ${agents} files under ${AGENTS} (no package's tests read them)`,
    };
  } catch (error) {
    const why = String(error?.stderr ?? error?.message ?? error)
      .trim()
      .split("\n")[0];
    return { reason: `${kept}: the commit without them could not be built (${why})` };
  }
};

/** The one line the test step's result gives: which packages ran, then why. */
export const scopeLine = (packages, reason) => {
  const ran =
    packages.length === 0
      ? "no package's tests"
      : packages.length <= 6
        ? `tests of ${packages.join(", ")}`
        : `tests of ${packages.length} packages`;
  return `ran ${ran}: ${reason}`;
};

/** Runs the gate. `runner` is injectable so the skip rule can be tested on fixture reports. */
export const runCheck = async (
  root,
  { head, all = false, concurrency, env = process.env, stamp, runner = run },
) => {
  // A shared machine caps turbo's tasks and each Vitest run's workers with the same number.
  const cap = concurrency === undefined ? [] : [`--concurrency=${concurrency}`];
  const logs = join(root, ".verify/logs");
  const reportDir = join(root, ".verify/reports", `check-${stamp}`);
  const files = head.mergeBase === null ? [] : changedFiles(root, head.mergeBase);
  const plan = computePlan(root, { head, files });
  const owedGates = plan.obligations.flatMap((obligation) =>
    obligation.verb === "check" && obligation.gate ? [obligation.gate] : [],
  );
  const steps = [];
  const next = [];
  const logOf = (id) => join(logs, `check-${id}.log`);

  // The web app's route tree.
  if (!existsSync(join(root, "apps/web/src/routeTree.gen.ts"))) {
    return {
      steps: [
        {
          id: gateStep("build").id,
          title: gateStep("build").title,
          status: "blocked_by_prerequisite",
          detail: "Typecheck needs the route trees pnpm build generates",
        },
      ],
      next: ["pnpm build", "pnpm verify check"],
      plan,
    };
  }

  for (const id of ["typecheck", "lint", "recipes-lint"]) {
    // Turbo's steps take the shared machine's cap; oxlint is one process.
    const args = [...gateStep(id).args, ...(id === "recipes-lint" ? [] : cap)];
    steps.push(
      await timed({ id, command: `pnpm ${args.join(" ")}` }, async () => {
        const code = await runner(root, "pnpm", args, { env, log: logOf(id) });
        return { status: code === 0 ? "passed" : "failed", log: relLog(root, logOf(id)) };
      }),
    );
  }

  // --continue: one failing package must not hide the others' failures and skips.
  const testArgs = [
    "exec",
    "turbo",
    "test",
    "--force",
    "--continue",
    ...cap,
    ...(all ? [] : ["--affected"]),
  ];
  // Gates this machine can set safely when the tool is installed (skips.mjs, LOCAL_GATES).
  const gates = localGates(env);
  const testEnv = {
    ...env,
    ...Object.fromEntries(gates.map((gate) => [gate.gate, gate.value])),
    CI_TEST_REPORT_DIR: reportDir,
    ...(concurrency === undefined ? {} : { VITEST_MAX_WORKERS: String(concurrency) }),
    ...(all || head.mergeBase === null ? {} : { TURBO_SCM_BASE: head.mergeBase }),
  };
  const usesPostgres = env.MEND_SKIP_POSTGRES_TESTS !== "1";
  const pg = usesPostgres ? await reachable(postgresUrl(env)) : true;
  const tests = [`pnpm ${testArgs.join(" ")}`];
  const nodeTests = scriptTests(root, files);
  steps.push(
    await timed(
      {
        id: "tests",
        title: all ? "Every package's tests" : "Affected packages' tests",
        command: tests.join(" && "),
      },
      async () => {
        if (!pg) {
          next.push("docker compose -f compose.dev.yaml up -d");
          return {
            status: "blocked_by_prerequisite",
            detail: `No Postgres at ${new URL(postgresUrl(env)).host}; the package tests need one (DEVELOPMENT.md, Tests)`,
          };
        }
        const scope = testScope(root, { head, files, all });
        const code = await runner(root, "pnpm", testArgs, {
          env:
            scope.scmHead === undefined ? testEnv : { ...testEnv, TURBO_SCM_HEAD: scope.scmHead },
          log: logOf("tests"),
        });
        const ran = scopeLine(testedPackages(logOf("tests")), scope.reason);
        process.stderr.write(`verify check: ${ran}\n`);
        let nodeCode = 0;
        if (nodeTests.length > 0) {
          nodeCode = await runner(
            root,
            "node",
            [
              "--test",
              ...(concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`]),
              "--test-reporter=spec",
              "--test-reporter-destination=stdout",
              "--test-reporter=./scripts/ci-test-report.mjs",
              "--test-reporter-destination=stdout",
              ...nodeTests,
            ],
            { env: testEnv, log: logOf("script-tests") },
          );
        }
        const skipped = judgeSkips(
          readSkips(root, reportDir),
          loadAllowedSkips(root),
          owedGates,
          plan.ci,
        );
        const unallowed = skipped.filter((skip) => !skip.allowed);
        const risky = atRisk(readFileTimes(root, reportDir));
        for (const risk of risky) process.stderr.write(`verify check: warning: ${risk.warning}\n`);
        const failed = code !== 0 || nodeCode !== 0;
        if (!failed && unallowed.length > 0) {
          for (const gate of new Set(unallowed.flatMap((skip) => (skip.gate ? [skip.gate] : []))))
            next.push(`${gate}=… pnpm verify check  # see ${ALLOWED_SKIPS}`);
          for (const hint of new Set(unallowed.flatMap((skip) => installHint(skip) ?? [])))
            next.push(hint);
        }
        return {
          status: failed ? "failed" : unallowed.length > 0 ? "skipped" : "passed",
          log: relLog(root, logOf("tests")),
          scope: ran,
          detail: [
            ran,
            `turbo exit ${code}, ${turboTasks(logOf("tests"))}`,
            nodeTests.length > 0 ? `node --test ${nodeTests.length} files exit ${nodeCode}` : null,
            `${skipped.length} skipped, ${unallowed.length} not allowed to skip`,
            ...gates.map((gate) => `set ${gate.gate} to the ${gate.binary} on PATH (${gate.why})`),
          ]
            .filter(Boolean)
            .join("; "),
          skipped: skipped.map(({ file: _file, ...skip }) => skip),
          ...(skipped.length > 0 ? { skipSummary: summarizeSkips(skipped) } : {}),
          // A warning, never a failure: the file passed here and may still pass on CI.
          ...(risky.length > 0 ? { atRisk: risky, riskSummary: summarizeRisk(risky) } : {}),
        };
      },
    ),
  );

  steps.push(
    await timed({ id: "format", command: "pnpm format:check" }, async () => {
      const code = await runner(root, "pnpm", gateStep("format").args, {
        env,
        log: logOf("format"),
      });
      if (code !== 0) next.push("pnpm format:fix");
      return { status: code === 0 ? "passed" : "failed", log: relLog(root, logOf("format")) };
    }),
  );

  return { steps, next, plan, reportDir: relative(root, reportDir) };
};
