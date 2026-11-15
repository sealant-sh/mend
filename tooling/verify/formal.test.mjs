import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCoverage, readCoverages } from "../../scripts/formal-coverage.mjs";
import { checkerMissing, drift, formalSteps, guard } from "./formal.mjs";

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
