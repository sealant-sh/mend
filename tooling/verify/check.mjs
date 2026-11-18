import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
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

/** The node --test files a change asks for: changed tests, and the tests beside changed scripts. */
export const scriptTests = (root, files) => {
  const tests = new Set();
  const roots = ["scripts/", "tooling/verify/", ".agents/skills/verify/scripts/"];
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

const timed = async (step, work) => {
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

  // Both web apps' trees: the old app's and the new one's (apps/web, rebuilt beside it).
  if (
    !["apps/web-old", "apps/web"].every((app) =>
      existsSync(join(root, app, "src/routeTree.gen.ts")),
    )
  ) {
    return {
      steps: [
        {
          id: "build",
          title: "Generated route trees",
          status: "blocked_by_prerequisite",
          detail: "Typecheck needs the route trees pnpm build generates",
        },
      ],
      next: ["pnpm build", "pnpm verify check"],
      plan,
    };
  }

  for (const [id, title, args] of [
    ["typecheck", "Typecheck, forced", ["exec", "turbo", "typecheck", "--force", ...cap]],
    ["lint", "Lint, forced", ["exec", "turbo", "lint", "--force", ...cap]],
    [
      "recipes-lint",
      "Verify recipes lint",
      ["exec", "oxlint", "--deny-warnings", ".agents/skills/verify/recipes"],
    ],
  ]) {
    steps.push(
      await timed({ id, title, command: `pnpm ${args.join(" ")}` }, async () => {
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
        const code = await runner(root, "pnpm", testArgs, { env: testEnv, log: logOf("tests") });
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
          detail: [
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
    await timed({ id: "format", title: "Format check", command: "pnpm format:check" }, async () => {
      const code = await runner(root, "pnpm", ["format:check"], { env, log: logOf("format") });
      if (code !== 0) next.push("pnpm format:fix");
      return { status: code === 0 ? "passed" : "failed", log: relLog(root, logOf("format")) };
    }),
  );

  return { steps, next, plan, reportDir: relative(root, reportDir) };
};
