import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readSkips } from "./check.mjs";
import { exitCode, rollUp, saveResult, STATUSES, validateResult } from "./result.mjs";
import { main, runVerb } from "./verify.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// A throwaway repository carrying the real map, allowed-skip list and CI workflow, so verbs run
// against real data without writing into this checkout's .verify/.
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "verify fixture",
    GIT_AUTHOR_EMAIL: "verify@example.invalid",
    GIT_COMMITTER_NAME: "verify fixture",
    GIT_COMMITTER_EMAIL: "verify@example.invalid",
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path, value = "fixture\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  for (const path of [
    "tooling/verify/obligations.json",
    "tooling/verify/allowed-skips.json",
    ".github/workflows/ci.yml",
    "docs/formal/standby-discard/COVERAGE",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  write(".gitignore", ".verify/\n");
  write("apps/web/src/routeTree.gen.ts", "// generated\n");
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "work");
  const commit = (path) => {
    write(path);
    git("add", "-A");
    git("commit", "-m", `change ${path}`);
  };
  return { root, commit, write, git };
};

const options = (extra = {}) => ({ base: "main", files: undefined, all: false, ...extra });

// Stands in for turbo, node --test and oxfmt: each succeeds, and the test run writes the report
// CI_TEST_REPORT_DIR asks for, with the given tests skipped.
const runnerSkipping =
  (root, skipped) =>
  async (_root, command, args, { env }) => {
    if (command === "pnpm" && args.includes("test")) {
      const directory = env.CI_TEST_REPORT_DIR;
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "vitest-apps-cli.json"),
        JSON.stringify({
          testResults: [
            {
              name: join(root, "apps/cli/src/a.test.ts"),
              assertionResults: [{ fullName: "runs", status: "passed" }],
            },
            ...skipped.map((file) => ({
              name: join(root, file),
              assertionResults: [{ fullName: "real engine", status: "skipped" }],
            })),
          ],
        }),
      );
    }
    return 0;
  };

const noPostgres = { ...process.env, MEND_SKIP_POSTGRES_TESTS: "1" };

test("statuses roll up worst first and map to the shared exit codes", () => {
  assert.equal(rollUp(["passed", "skipped", "requires_external_observer"]), "skipped");
  assert.equal(rollUp(["skipped", "blocked_by_prerequisite"]), "blocked_by_prerequisite");
  assert.equal(rollUp(["passed", "failed", "blocked_by_prerequisite"]), "failed");
  assert.equal(rollUp(["evidence_withheld", "passed"]), "evidence_withheld");
  assert.equal(rollUp([]), "passed");
  assert.deepEqual(
    STATUSES.map((status) => [status, exitCode(status)]),
    [
      ["failed", 1],
      ["blocked_by_prerequisite", 3],
      ["skipped", 4],
      ["not_implemented", 4],
      ["requires_external_observer", 4],
      ["evidence_withheld", 4],
      ["passed", 0],
    ],
  );
});

test("plan, status and an unbuilt verb each produce a valid result tied to the commit", async (t) => {
  const { root, commit, git } = fixture(t);
  commit("packages/sessions/src/engine.ts");
  const sha = git("rev-parse", "HEAD");
  for (const verb of ["plan", "status", "db"]) {
    const result = await runVerb(root, verb, options());
    assert.deepEqual(validateResult(result), [], verb);
    assert.equal(result.head.sha, sha);
    assert.equal(result.head.dirty, false);
  }
  assert.equal((await runVerb(root, "db", options())).status, "not_implemented");
  const plan = await runVerb(root, "plan", options());
  assert.equal(plan.status, "passed");
  assert.ok(plan.obligations.every((obligation) => obligation.status === "owed"));
  assert.ok(plan.obligations.some((obligation) => obligation.model === "standby-discard"));
  assert.ok(plan.ci.some((job) => job.job === "store-image-git" && job.runs === false));
});

test("an invalid result is named, not accepted", () => {
  assert.notDeepEqual(validateResult({ schemaVersion: 1, tool: "verify" }), []);
  assert.ok(
    validateResult({
      schemaVersion: 1,
      tool: "verify",
      repo: "mend",
      verb: "check",
      status: "passed",
      head: {
        sha: "a".repeat(40),
        branch: "b",
        dirty: false,
        base: "origin/main",
        mergeBase: null,
      },
      startedAt: "2026-11-14T22:00:00Z",
      durationMs: 1,
      steps: [{ id: "tests", title: "Tests", status: "skipped" }],
      obligations: [],
      evidence: [],
      cleanup: { status: "clean", left: [] },
      next: [],
    }).includes("status must be the worst of the steps' statuses"),
  );
});

test("a suite that skips makes check skipped, unless the list allows that skip here", async (t) => {
  const { root, commit } = fixture(t);
  commit("apps/cli/src/commands.ts");
  const run = (skipped) =>
    runVerb(root, "check", options({ env: noPostgres, runner: runnerSkipping(root, skipped) }));

  const clean = await run([]);
  assert.deepEqual(validateResult(clean), []);
  assert.equal(clean.status, "passed");

  const unlisted = await run(["apps/cli/src/needs-a-key.test.ts"]);
  assert.equal(unlisted.status, "skipped");
  assert.equal(exitCode(unlisted.status), 4);
  const tests = unlisted.steps.find((step) => step.id === "tests");
  assert.deepEqual(tests.skipped, [
    { name: "apps/cli/src/needs-a-key.test.ts > real engine", allowed: false },
  ]);

  const listed = await run(["apps/cli/src/server-docker-protocol.test.ts"]);
  assert.equal(listed.status, "passed");
  assert.equal(
    listed.steps.find((step) => step.id === "tests").skipped[0].gate,
    "MEND_DOCKER_TEST_CONTEXT",
  );
});

test("an allowed skip stops being allowed when the change owes its gate", async (t) => {
  const { root, commit } = fixture(t);
  commit("apps/cli/src/server-docker-volumes.ts");
  const result = await runVerb(
    root,
    "check",
    options({
      env: noPostgres,
      runner: runnerSkipping(root, ["apps/cli/src/server-docker-protocol.test.ts"]),
    }),
  );
  assert.equal(result.status, "skipped");
  assert.ok(result.next.some((command) => command.startsWith("MEND_DOCKER_TEST_CONTEXT=")));
});

test("check without Postgres is blocked by a prerequisite, not failed", async (t) => {
  const { root, commit } = fixture(t);
  commit("packages/db/src/a.ts");
  const result = await runVerb(
    root,
    "check",
    options({
      env: { ...process.env, MEND_TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" },
      runner: runnerSkipping(root, []),
    }),
  );
  assert.equal(result.status, "blocked_by_prerequisite");
  assert.equal(exitCode(result.status), 3);
  assert.ok(result.next.includes("docker compose -f compose.dev.yaml up -d"));
});

test("status counts a passing check only for this exact commit with a clean tree", async (t) => {
  const { root, commit, write } = fixture(t);
  commit("docs/a.md");
  const check = await runVerb(
    root,
    "check",
    options({ env: noPostgres, runner: runnerSkipping(root, []) }),
  );
  saveResult(root, check);
  const now = await runVerb(root, "status", options());
  assert.deepEqual(validateResult(now), []);
  assert.equal(now.status, "passed");
  assert.equal(now.obligations[0].status, "discharged");

  write("docs/a.md", "edited\n");
  assert.equal((await runVerb(root, "status", options())).status, "skipped", "dirty tree");

  commit("docs/b.md");
  const later = await runVerb(root, "status", options());
  assert.equal(later.status, "skipped");
  assert.match(later.steps[0].detail, /not this head/);
});

test("a feature's box check is reported as needing another observer", async (t) => {
  const { root, commit } = fixture(t);
  commit("apps/web/src/routes/a.tsx");
  const result = await runVerb(root, "status", options());
  const box = result.steps.find((step) => step.id === "box-check");
  assert.equal(box.status, "requires_external_observer");
});

test("wrong usage exits 2 and writes no result", async (t) => {
  const { root } = fixture(t);
  assert.equal(await main(["nonsense"], root), 2);
  assert.equal(await main(["plan", "--base"], root), 2);
  assert.equal(await main(["plan", "--frobnicate"], root), 2);
});

test("tests a failed file's hook skipped are its failure, not skips", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-reports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "vitest-packages-db.json"),
    JSON.stringify({
      testResults: [
        {
          name: join(root, "packages/db/test/a.test.ts"),
          status: "failed",
          assertionResults: [{ fullName: "after a hook timeout", status: "skipped" }],
        },
        {
          name: join(root, "packages/db/test/b.test.ts"),
          status: "passed",
          assertionResults: [{ fullName: "gated", status: "pending" }],
        },
      ],
    }),
  );
  assert.deepEqual(readSkips(root, root), [
    { name: "packages/db/test/b.test.ts > gated", file: "packages/db/test/b.test.ts" },
  ]);
});

test("--concurrency caps every turbo run and each Vitest run's workers", async (t) => {
  const { root, commit } = fixture(t);
  commit("docs/a.md");
  const calls = [];
  await runVerb(
    root,
    "check",
    options({
      concurrency: 2,
      env: noPostgres,
      runner: async (_root, command, args, { env }) => {
        calls.push({ command, args, workers: env.VITEST_MAX_WORKERS });
        return 0;
      },
    }),
  );
  const turbo = calls.filter((call) => call.args.includes("turbo"));
  assert.equal(turbo.length, 3);
  for (const call of turbo) assert.ok(call.args.includes("--concurrency=2"), call.args.join(" "));
  assert.equal(turbo.find((call) => call.args.includes("test")).workers, "2");
});
