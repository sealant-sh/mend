import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CI_FILE_BUDGET_MS } from "../test-ci/src/file-budget.ts";
import { floorOf, loadLimits, validateAnswer } from "./judge.mjs";
import { readReceipts } from "./receipt.mjs";
import { createResult, exitCode, rollUp, saveResult, STATUSES, validateResult } from "./result.mjs";
import { ciGateProblems, loadAllowedSkips, readSkips, validateAllowedSkips } from "./skips.mjs";
import { toMarkdown } from "./status.mjs";
import { CI_TO_LOCAL_RATIO } from "./timing.mjs";
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
    "tooling/verify/local-stack-limits.json",
    ".github/workflows/ci.yml",
    "docs/formal/standby-discard/COVERAGE",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  write(".gitignore", ".verify/\n");
  write("apps/web-old/src/routeTree.gen.ts", "// generated\n");
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
// CI_TEST_REPORT_DIR asks for, with the given tests skipped: a file (its test is "real engine"),
// or [file, test full name].
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
            ...skipped.map((skip) => {
              const [file, fullName] = Array.isArray(skip) ? skip : [skip, "real engine"];
              return {
                name: join(root, file),
                assertionResults: [{ fullName, status: "skipped" }],
              };
            }),
          ],
        }),
      );
    }
    return 0;
  };

const noPostgres = { ...process.env, MEND_SKIP_POSTGRES_TESTS: "1" };

test("the pre-PR gate fails when verify recipe lint fails", async (t) => {
  const { root, commit } = fixture(t);
  commit(".agents/skills/verify/recipes/example.mjs");
  const result = await runVerb(
    root,
    "check",
    options({
      env: noPostgres,
      runner: async (...call) =>
        call[2].includes("oxlint") ? 1 : runnerSkipping(root, [])(...call),
    }),
  );
  const lint = result.steps.find((step) => step.id === "recipes-lint");
  assert.equal(lint.status, "failed");
  assert.match(lint.command, /oxlint --deny-warnings \.agents\/skills\/verify\/recipes/);
});

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

const answerFile = (root, answer) => {
  const path = join(root, ".verify/answer.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(answer));
  return path;
};

const LOCAL_ANSWER = {
  where: "local",
  reason: "It changes a web route; nothing in the diff needs Boat, old data or a real agent.",
  mustSee: ["Open Projects and see the new row", "Rename it and see the name change", "Reload"],
  ifBroken: "The row is missing",
};

test("a feature's run is owed until it is judged and verify evidence passes on this commit", async (t) => {
  const { root, commit } = fixture(t);
  commit("apps/web-old/src/routes/a.tsx");
  const line = async (id) =>
    (await runVerb(root, "status", options())).steps.find((step) => step.id === id);
  assert.equal((await line("judge")).status, "skipped");
  const unjudged = await line("run-it");
  assert.equal(unjudged.status, "skipped");
  assert.match(unjudged.detail, /nobody has said where to run it/);

  // The brief is written from the commit; until another agent answers, the line waits on one.
  const asked = await runVerb(root, "judge", options());
  assert.deepEqual(validateResult(asked), []);
  assert.equal(asked.status, "requires_external_observer");
  const brief = readFileSync(join(root, asked.evidence[0].path), "utf8");
  assert.match(brief, /apps\/web-old\/src\/routes\/a\.tsx/);
  assert.match(brief, /`boat`:/);
  saveResult(root, asked);
  assert.equal((await line("judge")).status, "requires_external_observer");

  const judged = await runVerb(root, "judge", options({ record: answerFile(root, LOCAL_ANSWER) }));
  assert.equal(judged.status, "passed");
  assert.equal(judged.judgement.judgedBy, "agent");
  saveResult(root, judged);
  const receipt = await runVerb(root, "status", options());
  assert.match(
    toMarkdown(receipt),
    /`judge`: passed.*Run on a local stack, judged by another agent/,
  );
  assert.equal((await line("run-it")).status, "skipped", "judged, not yet run");

  // Asking again keeps the judgement, and the verdict file asks for what the judge listed.
  assert.equal((await runVerb(root, "judge", options())).status, "passed");
  const undriven = await runVerb(root, "evidence", options());
  assert.equal(undriven.status, "skipped");
  saveResult(
    root,
    createResult({
      verb: "evidence",
      head: undriven.head,
      startedAt: new Date(),
      steps: [{ id: "verdict", title: "Write the verdict file", status: "passed" }],
      next: [],
    }),
  );
  assert.equal((await line("run-it")).status, "passed");

  commit("apps/web-old/src/routes/b.tsx");
  assert.equal((await line("judge")).status, "skipped", "a later commit is judged again");
  assert.equal((await line("run-it")).status, "skipped");
});

test("the receipt carries the judgement in a block a script reads back exactly", async (t) => {
  const { root, commit, write, git } = fixture(t);
  commit("apps/web-old/src/routes/a.tsx");
  // Text that would close the block or open HTML if it were not escaped.
  const answer = {
    ...LOCAL_ANSWER,
    reason: "It renders ```code``` and </details> <b>as text</b>.\nSecond line.",
  };
  saveResult(
    root,
    await runVerb(root, "judge", options({ record: answerFile(root, answer), self: true })),
  );
  const status = await runVerb(root, "status", options());
  const body = `Intro.\n\n${toMarkdown(status)}\nMade by a test.\n`;
  assert.match(body, /\*\*Where:\*\* a local stack/);
  assert.match(body, /\*\*Judged by:\*\* the author/);
  assert.match(body, /1\. Open Projects and see the new row/);

  const [read, ...more] = readReceipts(body);
  assert.deepEqual(more, []);
  assert.deepEqual(read.receipt.judgement, {
    ...answer,
    reason: answer.reason.trim(),
    judgedBy: "self",
  });
  assert.equal(read.receipt.sha, git("rev-parse", "HEAD"));
  assert.deepEqual(
    read.receipt.lines.map((line) => [line.id, line.status]),
    [
      ["pre-pr-checks", "skipped"],
      ["judge", "passed"],
      ["run-it", "skipped"],
      ["screenshots", "skipped"],
    ],
  );

  // The product patch id survives a commit of tests and docs only, and changes with product source.
  const first = read.receipt.productPatchId;
  assert.match(first, /^[0-9a-f]{40}$/);
  const patchOf = async () => (await runVerb(root, "status", options())).productPatchId;
  commit("apps/web-old/src/routes/a.test.tsx");
  commit("docs/notes.md");
  assert.equal(await patchOf(), first);
  commit("apps/web-old/src/routes/b.tsx");
  assert.notEqual(await patchOf(), first);

  // `verify receipt` reads a body from a file; a damaged block is named, an absent one skipped.
  write(".verify/body.md", body);
  const verb = await runVerb(root, "receipt", options({ body: join(root, ".verify/body.md") }));
  assert.deepEqual(validateResult(verb), []);
  assert.equal(verb.status, "passed");
  assert.deepEqual(verb.receipts, [read.receipt]);
  const damaged = body.replace('"judgedBy": "self"', '"judgedBy": "nobody"');
  assert.match(readReceipts(damaged)[0].errors.join(), /judgement is null or/);
  write(".verify/body.md", "No receipt here.\n");
  const none = await runVerb(root, "receipt", options({ body: join(root, ".verify/body.md") }));
  assert.equal(none.status, "skipped");
});

test("a judgement for the box is discharged by the box running this change", async (t) => {
  const { root, commit } = fixture(t);
  commit("packages/sessions/src/boat-resume.ts");
  const box = {
    ...LOCAL_ANSWER,
    where: "box",
    limit: "boat",
    reason: "It changes what a Boat guest does on resume; only Boat shows that.",
  };
  const judged = await runVerb(
    root,
    "judge",
    options({ record: answerFile(root, box), self: true }),
  );
  assert.equal(judged.status, "passed");
  saveResult(root, judged);
  const receipt = await runVerb(root, "status", options());
  const run = receipt.steps.find((step) => step.id === "run-it");
  assert.equal(run.status, "skipped");
  assert.match(run.detail, /sent this to the box \(boat\)/);
  assert.ok(receipt.next.includes("pnpm verify box plan"));
  assert.match(toMarkdown(receipt), /judged by the author/);

  saveResult(
    root,
    createResult({
      verb: "box identity",
      head: judged.head,
      startedAt: new Date(),
      steps: [{ id: "identity", title: "The box runs this change", status: "passed" }],
      next: [],
    }),
  );
  const after = await runVerb(root, "status", options());
  assert.equal(after.steps.find((step) => step.id === "run-it").status, "passed");
});

test("an answer the brief did not ask for is refused, and the deploy script only goes to the box", async (t) => {
  const { root, commit, write } = fixture(t);
  commit("apps/web-old/src/routes/a.tsx");
  const refused = async (answer) => {
    const result = await runVerb(root, "judge", options({ record: answerFile(root, answer) }));
    assert.equal(result.status, "failed");
    assert.equal(result.judgement, undefined);
    return result.steps[0].detail;
  };
  assert.match(await refused({ ...LOCAL_ANSWER, where: "box" }), /names its limit/);
  assert.match(await refused({ ...LOCAL_ANSWER, limit: "boat" }), /names no limit/);
  assert.match(await refused({ ...LOCAL_ANSWER, mustSee: ["one"] }), /three to five/);
  assert.match(await refused({ ...LOCAL_ANSWER, reason: " " }), /reason is required/);

  write("apps/web-old/src/routes/a.tsx", "edited\n");
  assert.equal((await runVerb(root, "judge", options())).status, "blocked_by_prerequisite");

  const limits = loadLimits(repo);
  const floor = floorOf(limits, ["scripts/preview-deploy.sh", "apps/web-old/src/a.tsx"]);
  assert.deepEqual(floor, [{ id: "preview-deploy", files: ["scripts/preview-deploy.sh"] }]);
  assert.match(validateAnswer(LOCAL_ANSWER, { limits, floor }).join(), /only be shown on the box/);
  assert.deepEqual(
    validateAnswer({ ...LOCAL_ANSWER, where: "box", limit: "preview-deploy" }, { limits, floor }),
    [],
  );
  for (const limit of limits)
    for (const path of limit.paths ?? [])
      assert.ok(existsSync(join(repo, path)), `${limit.id} names missing ${path}`);
});

test("a change that owes no run has nothing to judge", async (t) => {
  const { root, commit } = fixture(t);
  commit("docs/a.md");
  const result = await runVerb(root, "judge", options());
  assert.equal(result.status, "passed");
  assert.match(result.steps[0].detail, /nothing to judge/);
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
    {
      name: "packages/db/test/b.test.ts > gated",
      file: "packages/db/test/b.test.ts",
      test: "gated",
    },
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

// SLNT-1004: the skips a change to a file every package reads (pnpm-lock.yaml) met on the dev
// machine, each named in allowed-skips.json with where it does run.
const S3 = "packages/store/test/blob-store.test.ts";
const S3_CAPTURE = [
  "packages/sessions/test/capture-verify.test.ts",
  "review 7 #8 on a real bucket (MEND_TEST_S3_URL) a recorded seal's stored pack is never handed an upload URL",
];
const MOUNTED = "packages/sessions/test/rollback-mounted-layout.test.ts";
const DOCKER = "apps/cli/src/server-docker-protocol.test.ts";
const CORPUS = [
  "packages/sessions/src/native-convert.test.ts",
  "corpus: real harvested claude session survives claude → codex → canonical",
];

test("a lockfile-only change passes when every skip is allowed, and the receipt says where each runs", async (t) => {
  const { root, commit } = fixture(t);
  commit("pnpm-lock.yaml");
  const check = await runVerb(
    root,
    "check",
    options({
      env: noPostgres,
      runner: runnerSkipping(root, [S3, S3, S3_CAPTURE, MOUNTED, DOCKER, CORPUS]),
    }),
  );
  assert.deepEqual(validateResult(check), []);
  assert.equal(check.status, "passed");
  const tests = check.steps.find((step) => step.id === "tests");
  assert.ok(tests.skipped.every((skip) => skip.allowed));
  assert.equal(
    tests.skipped.find((skip) => skip.name.startsWith(CORPUS[0])).kind,
    "local-only",
    "the corpus is never counted as run by CI",
  );

  saveResult(root, check);
  const receipt = toMarkdown(await runVerb(root, "status", options()));
  const line = receipt.split("\n").find((text) => text.includes("`pre-pr-checks`"));
  assert.match(line, /^- \[x\] `pre-pr-checks`: passed/);
  assert.match(line, /6 tests skipped here, all allowed: /);
  assert.match(
    line,
    /3 in CI test-clients-a \(Live S3 contracts on disposable Garage and strict MinIO fixtures\)/,
  );
  assert.match(line, /2 in CI docker-suites \(Server Docker setup and mounted Undo/);
  assert.match(line, /1 in no CI job, only on a machine whose Mend store holds a harvested claude/);
});

test("an entry naming a test covers only that test, and an unlisted skip still makes check skipped", async (t) => {
  const { root, commit } = fixture(t);
  commit("pnpm-lock.yaml");
  const result = await runVerb(
    root,
    "check",
    options({
      env: noPostgres,
      runner: runnerSkipping(root, [
        S3,
        ["packages/sessions/src/native-convert.test.ts", "converts a fixture"],
        ["packages/sessions/test/capture-verify.test.ts", "review 3 a local pack"],
      ]),
    }),
  );
  assert.equal(result.status, "skipped");
  const tests = result.steps.find((step) => step.id === "tests");
  assert.deepEqual(
    tests.skipped.filter((skip) => !skip.allowed).map((skip) => skip.name),
    [
      "packages/sessions/src/native-convert.test.ts > converts a fixture",
      "packages/sessions/test/capture-verify.test.ts > review 3 a local pack",
    ],
  );
  assert.match(tests.skipSummary, /^3 tests skipped here, 2 not allowed: 1 in CI test-clients-a/);
});

test("check sets the Doppler gate from a doppler on PATH, and names what to install without one", async (t) => {
  const { root, commit, write } = fixture(t);
  commit("pnpm-lock.yaml");
  const bin = join(root, "fake-bin");
  write("fake-bin/doppler", "#!/bin/sh\n");
  chmodSync(join(bin, "doppler"), 0o755);
  const seen = [];
  const recording =
    (skipped) =>
    async (...call) => {
      if (call[1] === "pnpm" && call[2].includes("test"))
        seen.push(call[3].env.MEND_TEST_DOPPLER_BINARY);
      return runnerSkipping(root, skipped)(...call);
    };
  const withPath = (path) => {
    const env = { ...noPostgres, PATH: path };
    delete env.MEND_TEST_DOPPLER_BINARY;
    return env;
  };

  const found = await runVerb(
    root,
    "check",
    options({ env: withPath(`${bin}${delimiter}/usr/bin`), runner: recording([]) }),
  );
  assert.equal(found.status, "passed");
  assert.equal(seen.at(-1), join(bin, "doppler"));

  const missing = await runVerb(
    root,
    "check",
    options({
      env: withPath("/nonexistent"),
      runner: recording(["packages/sessions/test/doppler-helper.test.ts"]),
    }),
  );
  assert.equal(seen.at(-1), undefined);
  assert.equal(missing.status, "skipped");
  assert.ok(
    missing.next.some((command) => command.startsWith("nix profile install nixpkgs#doppler")),
  );
});

test("every allowed skip names where it runs, and each CI step named still sets its gate", () => {
  const allowed = loadAllowedSkips(repo);
  assert.deepEqual(validateAllowedSkips(allowed), []);
  assert.deepEqual(ciGateProblems(repo, allowed), []);
});

test("an allowed skip whose CI step stopped setting its gate is named", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("package.json", JSON.stringify({ scripts: { "test:s3": "node scripts/s3.mjs" } }));
  put(
    ".github/workflows/ci.yml",
    [
      "jobs:",
      "  clients:",
      "    steps:",
      "      - name: S3 by script",
      "        run: pnpm run test:s3",
      "      - name: Mount by env",
      "        env: { MEND_TEST_ROLLBACK_MOUNT: '1' }",
      "        run: pnpm --filter @mend/sessions exec vitest run",
      "",
    ].join("\n"),
  );
  const entry = (extra) => ({ kind: "ci", job: "clients", reason: "r", ...extra });
  const s3 = entry({
    file: "packages/store/test/blob-store.test.ts",
    gate: "MEND_TEST_S3_URL",
    step: "S3 by script",
  });
  const mount = entry({
    file: "packages/sessions/test/rollback-mounted-layout.test.ts",
    gate: "MEND_TEST_ROLLBACK_MOUNT",
    step: "Mount by env",
  });

  put("scripts/s3.mjs", 'run("test/blob-store.test.ts", { MEND_TEST_S3_URL: url });\n');
  assert.deepEqual(ciGateProblems(root, [s3, mount]), []);

  put("scripts/s3.mjs", 'run("test/blob-store.test.ts", { MEND_TEST_S3_ENDPOINT: url });\n');
  assert.match(ciGateProblems(root, [s3])[0], /no longer sets the gate/);
  assert.match(ciGateProblems(root, [{ ...s3, step: "Renamed" }])[0], /has no step "Renamed"/);
  assert.match(ciGateProblems(root, [{ ...mount, job: "gone" }])[0], /has no job gone/);
  assert.deepEqual(validateAllowedSkips([{ ...s3, job: undefined }]).length, 1);
  assert.deepEqual(
    validateAllowedSkips([{ file: "a", gate: "g", reason: "r", kind: "local-only" }]).length,
    1,
    "a local-only skip says where it runs",
  );
});

// SLNT-1032: a file whose time here puts it at risk of CI's per-file limit is named, not failed.
const runnerTiming =
  (root, files) =>
  async (_root, command, args, { env }) => {
    if (command === "pnpm" && args.includes("test")) {
      mkdirSync(env.CI_TEST_REPORT_DIR, { recursive: true });
      writeFileSync(
        join(env.CI_TEST_REPORT_DIR, "vitest-apps-t3-gateway.json"),
        JSON.stringify({
          testResults: files.map(([file, ms]) => ({
            name: join(root, file),
            startTime: 1_000_000,
            endTime: 1_000_000 + ms,
            assertionResults: [{ fullName: "explores", status: "passed" }],
          })),
        }),
      );
    }
    return 0;
  };

test("a file on course to break CI's per-file limit is a named warning, and a fast run has none", async (t) => {
  const { root, commit } = fixture(t);
  commit("apps/t3-gateway/src/queue.ts");
  const threshold = CI_FILE_BUDGET_MS / CI_TO_LOCAL_RATIO;
  const slow = "apps/t3-gateway/test/queue-explore.test.ts";
  const run = (files) =>
    runVerb(root, "check", options({ env: noPostgres, runner: runnerTiming(root, files) }));

  const fast = await run([[slow, threshold - 1]]);
  assert.equal(fast.status, "passed");
  assert.deepEqual(fast.warnings, []);
  saveResult(root, fast);
  assert.doesNotMatch(toMarkdown(await runVerb(root, "status", options())), /Warning/);

  const risky = await run([
    ["apps/t3-gateway/test/quick.test.ts", 2000],
    [slow, threshold],
  ]);
  assert.deepEqual(validateResult(risky), []);
  assert.equal(risky.status, "passed", "a warning never fails a run that passed");
  assert.equal(risky.warnings.length, 1);
  assert.match(
    risky.warnings[0],
    new RegExp(`^${slow} took ${(threshold / 1000).toFixed(1)} s here`),
  );
  saveResult(root, risky);
  const line = toMarkdown(await runVerb(root, "status", options()))
    .split("\n")
    .find((text) => text.includes("`pre-pr-checks`"));
  assert.match(line, /^- \[x\] `pre-pr-checks`: passed/);
  assert.match(line, /Warning: 1 test file at risk of CI's 60 s per-file limit: apps\/t3-gateway/);
  assert.match(line, /stress-ng/);
});
