import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCoverage, readCoverages } from "../../scripts/formal-coverage.mjs";
import { checkerMissing, drift, formalSteps, guard, runBudgeted } from "./formal.mjs";

// A repository with one model, `demo`, that covers src/covered.ts, synced at its first commit.
const repo = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-formal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "f",
    GIT_AUTHOR_EMAIL: "f@example.invalid",
    GIT_COMMITTER_NAME: "f",
    GIT_COMMITTER_EMAIL: "f@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const write = (path, text = "x\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message = "c") => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const coverage = (sync) =>
    write(
      "docs/formal/demo/COVERAGE",
      `sync ${sync}\nmodel Demo.tla\nmodel check.sh\npath src/covered.ts\n`,
    );
  git("init", "-qb", "main");
  write("src/covered.ts", "one\n");
  write("src/other.ts");
  write("docs/formal/demo/Demo.tla");
  write("docs/formal/demo/check.sh");
  write("docs/formal/demo/README.md");
  const first = commit("first");
  coverage(first);
  const base = commit("coverage");
  const demo = () => readCoverages(root)[0];
  return { root, git, write, commit, coverage, first, base, demo };
};

test("COVERAGE is read strictly: a sync commit, the model's files and the code it covers", () => {
  const area = parseCoverage(`# note\nsync ${"a".repeat(40)}\nmodel M.tla\npath p.ts\n`, "demo");
  assert.deepEqual(area.model, ["docs/formal/demo/M.tla"]);
  assert.deepEqual(area.paths, ["p.ts"]);
  assert.throws(
    () => parseCoverage("sync abc\nmodel M.tla\npath p.ts\n", "demo"),
    /full commit id/,
  );
  assert.throws(
    () => parseCoverage(`sync ${"a".repeat(40)}\npath p.ts\n`, "demo"),
    /needs a sync, a model and a path/,
  );
  const real = readCoverages(fileURLToPath(new URL("../../", import.meta.url)));
  assert.deepEqual(real.map((coverage) => coverage.area).toSorted(), [
    "standby-discard",
    "turn-dispatch",
  ]);
});

test("the guard fails covered code that moved neither the model nor the sync commit", (t) => {
  const r = repo(t);
  assert.equal(guard(r.root, r.demo(), { files: ["src/other.ts"], base: r.base }).status, "passed");
  const alone = guard(r.root, r.demo(), { files: ["src/covered.ts"], base: r.base });
  assert.equal(alone.status, "failed");
  assert.match(alone.detail, /\.agents\/skills\/demo step 1/);
  assert.equal(
    guard(r.root, r.demo(), {
      files: ["src/covered.ts", "docs/formal/demo/Demo.tla"],
      base: r.base,
    }).status,
    "passed",
  );
  assert.equal(
    guard(r.root, r.demo(), {
      files: ["src/covered.ts", "docs/formal/demo/README.md"],
      base: r.base,
    }).status,
    "failed",
    "the model's prose is not the model",
  );
  r.write("src/covered.ts", "two\n");
  const changed = r.commit("code");
  r.coverage(changed);
  r.commit("sync");
  const synced = guard(r.root, r.demo(), {
    files: ["src/covered.ts", "docs/formal/demo/COVERAGE"],
    base: r.base,
  });
  assert.equal(synced.status, "passed");
  assert.match(synced.detail, /sync commit moved/);
});

test("drift names the covered files changed since the sync commit, or says it cannot tell", (t) => {
  const r = repo(t);
  assert.deepEqual(drift(r.root, r.demo(), "HEAD").files, []);
  r.write("src/covered.ts", "two\n");
  r.write("src/other.ts", "two\n");
  r.commit("code");
  assert.deepEqual(drift(r.root, r.demo(), "HEAD"), { known: true, files: ["src/covered.ts"] });
  r.coverage("f".repeat(40));
  assert.equal(drift(r.root, r.demo(), "HEAD").known, false);
});

test("a touched model is checked at quick bounds, or full with --full; untouched ones are not run", async (t) => {
  const r = repo(t);
  const runs = [];
  const run = async (command, args) => {
    runs.push([command, ...args].join(" "));
    return 0;
  };
  const env = { TLA2TOOLS_JAR: "/jar" };
  const none = await formalSteps(r.root, {
    files: ["src/other.ts"],
    base: r.base,
    head: "HEAD",
    env,
    run,
    logs: r.root,
  });
  assert.deepEqual(
    none.map((step) => step.detail),
    ["none"],
  );
  assert.equal(runs.length, 0);
  const quick = await formalSteps(r.root, {
    files: ["docs/formal/demo/Demo.tla"],
    base: r.base,
    head: "HEAD",
    env,
    run,
    logs: r.root,
  });
  assert.deepEqual(
    quick.map((step) => [step.id, step.status]),
    [
      ["demo-guard", "passed"],
      ["demo-check", "passed"],
    ],
  );
  await formalSteps(r.root, {
    files: [],
    base: null,
    head: "HEAD",
    all: true,
    full: true,
    env,
    run,
    logs: r.root,
  });
  assert.deepEqual(runs, [
    "bash docs/formal/demo/check.sh --quick",
    "bash docs/formal/demo/check.sh",
  ]);
  const failing = await formalSteps(r.root, {
    files: ["src/covered.ts"],
    base: r.base,
    head: "HEAD",
    env,
    run: async () => 1,
    logs: r.root,
  });
  assert.deepEqual(
    failing.map((step) => step.status),
    ["failed", "failed"],
  );
});

test("COVERAGE's budgets default, and an area may set its own in whole minutes", () => {
  const head = `sync ${"a".repeat(40)}\nmodel M.tla\npath p.ts\n`;
  assert.deepEqual(parseCoverage(head, "demo").budgets, { quick: 10, full: 40 });
  assert.deepEqual(parseCoverage(`${head}budget-full 25\nbudget-quick 3\n`, "demo").budgets, {
    quick: 3,
    full: 25,
  });
  assert.throws(() => parseCoverage(`${head}budget-full 1.5\n`, "demo"), /whole number/);
  for (const coverage of readCoverages(fileURLToPath(new URL("../../", import.meta.url))))
    assert.ok(
      coverage.budgets.full <= 80,
      `${coverage.area}: CI's formal job for one model stops at 90 minutes, setup included`,
    );
});

test("a check that runs past its budget is stopped and fails naming the model and the budget", async (t) => {
  const r = repo(t);
  r.write(
    "docs/formal/demo/COVERAGE",
    `${readFileSync(join(r.root, "docs/formal/demo/COVERAGE"), "utf8")}budget-full 7\n`,
  );
  const budgets = [];
  const steps = await formalSteps(r.root, {
    files: [],
    base: null,
    head: "HEAD",
    all: true,
    full: true,
    env: { TLA2TOOLS_JAR: "/jar" },
    run: async (_command, _args, { budgetMs }) => {
      budgets.push(budgetMs);
      return "timeout";
    },
    logs: r.root,
  });
  assert.deepEqual(budgets, [7 * 60_000]);
  const check = steps.find((step) => step.id === "demo-check");
  assert.equal(check.status, "failed");
  assert.match(check.detail, /^demo ran past its 7-minute budget at full bounds and was stopped/);
  assert.match(check.detail, /budget-full line in docs\/formal\/demo\/COVERAGE/);
});

test("--area keeps a run to one model, and names one that does not exist", async (t) => {
  const r = repo(t);
  r.write("docs/formal/other/COVERAGE", `sync ${r.first}\nmodel O.tla\npath src/other.ts\n`);
  const runs = [];
  const options = {
    files: [],
    base: null,
    head: "HEAD",
    all: true,
    full: true,
    env: { TLA2TOOLS_JAR: "/jar" },
    run: async (_command, args) => {
      runs.push(args[0]);
      return 0;
    },
    logs: r.root,
  };
  await formalSteps(r.root, { ...options, area: "other" });
  assert.deepEqual(runs, ["docs/formal/other/check.sh"]);
  await assert.rejects(formalSteps(r.root, { ...options, area: "nope" }), /no model area nope/);
});

test("the budget stops the whole process group, not only the shell that started it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mend-verify-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "child.pid");
  const started = Date.now();
  // bash starts a long sleep as its child, the way check.sh starts java or tlx.
  const code = await runBudgeted("bash", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
    cwd: dir,
    env: process.env,
    stdio: "ignore",
    budgetMs: 300,
  });
  assert.equal(code, "timeout");
  assert.ok(Date.now() - started < 10_000, "stopped by the budget, not by the sleep ending");
  const child = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(child, 0), /ESRCH/, "the checker under bash is gone too");
  assert.equal(
    await runBudgeted("bash", ["-c", "exit 3"], {
      cwd: dir,
      env: process.env,
      stdio: "ignore",
      budgetMs: 10_000,
    }),
    3,
  );
});

test("without Nix, Java or a jar the check is blocked, not failed", async (t) => {
  assert.match(
    checkerMissing({}, () => false),
    /needs Nix, or java and curl/,
  );
  assert.equal(
    checkerMissing({}, (tool) => tool !== "nix"),
    null,
  );
  assert.equal(
    checkerMissing({ TLA2TOOLS_JAR: "/jar" }, () => false),
    null,
  );
});
