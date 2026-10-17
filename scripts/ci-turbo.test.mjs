import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ciTurboOptions } from "./ci-turbo.mjs";

const command = fileURLToPath(new URL("ci-turbo.mjs", import.meta.url));
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-ci-turbo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const record = join(root, "args.json");
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.CHILD_EXIT ?? 0));\n`,
  );
  chmodSync(pnpm, 0o700);
  return (args, env = {}) => {
    rmSync(record, { force: true });
    const result = spawnSync(process.execPath, [command, ...args], {
      cwd: root,
      env: { PATH: bin, ARGV_FILE: record, ...env },
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      ...result,
      args:
        result.status === 0 && args[0] !== "configure"
          ? JSON.parse(readFileSync(record, "utf8"))
          : [],
    };
  };
};

for (const runner of ["self-hosted", "github-hosted"]) {
  test(`configuration publishes the actual runtime and only box ${runner} gets the remote endpoint`, (t) => {
    const run = fixture(t);
    const result = run(["configure"], { RUNNER_ENVIRONMENT: runner });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(
      lines[0],
      `MEND_CI_RUNTIME=${process.version}/${process.platform}/${process.arch}`,
    );
    assert.deepEqual(
      lines.slice(1),
      runner === "self-hosted"
        ? ["TURBO_API=http://10.0.1.1:8941", "TURBO_TEAM=mend", "TURBO_TOKEN=box"]
        : [],
    );
  });

  for (const [event, ref, affected, force, writes] of [
    ["pull_request", "refs/pull/979/merge", true, false, false],
    ["push", "refs/heads/main", false, false, true],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-1-abcd", false, false, true],
    ["schedule", "refs/heads/main", false, true, true],
    ["push", "refs/heads/feature", false, false, false],
    ["merge_group", "refs/heads/gh-readonly-queue/other/pr-1", false, false, false],
    ["workflow_dispatch", "refs/heads/main", false, false, false],
  ]) {
    test(`${runner} ${event} ${ref} executes the intended cache and selection policy`, (t) => {
      const run = fixture(t);
      const result = run(["build", "typecheck", "lint"], {
        RUNNER_ENVIRONMENT: runner,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        TURBO_SCM_BASE: "a".repeat(40),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.args.slice(0, 6), [
        "exec",
        "turbo",
        "run",
        "build",
        "typecheck",
        "lint",
      ]);
      assert.equal(result.args.includes("--affected"), affected);
      assert.equal(result.args.includes("--force"), force);
      assert.ok(result.args.includes("--env-mode=strict"));
      assert.equal(
        result.args.includes(
          `--cache=local:rw${runner === "self-hosted" ? (writes ? ",remote:rw" : ",remote:r") : ""}`,
        ),
        !force,
      );
    });
  }
}

test("a missing or malformed PR base refuses to execute rather than omitting tests", (t) => {
  const run = fixture(t);
  for (const base of [undefined, "", "main", "--all", "a".repeat(39), "g".repeat(40)]) {
    const result = run(["lint"], {
      GITHUB_EVENT_NAME: "pull_request",
      ...(base === undefined ? {} : { TURBO_SCM_BASE: base }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exact base SHA/);
  }
});

test("the static wrapper preserves failure and refuses unknown tasks", (t) => {
  const run = fixture(t);
  assert.equal(run(["lint"], { CHILD_EXIT: "37" }).status, 37);
  for (const args of [[], ["test"], ["build", "--force"], ["configure", "lint"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

// Run the wrapper through pnpm and the installed Turbo. An argv recorder cannot detect
// flag combinations rejected by Turbo, nor prove that forced runs still upload artifacts.
test("real Turbo nightly bypasses reads, executes twice and refreshes the remote cache", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-nightly-turbo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url)),
    join(root, "node_modules/.bin/turbo"),
  );
  mkdirSync(join(root, "packages/probe"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "nightly-proof", private: true, packageManager: "pnpm@10.32.1" }),
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/probe: {}\n",
  );
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.turbo/\ndist/\n");
  writeFileSync(
    join(root, "turbo.json"),
    JSON.stringify({ tasks: { lint: { outputs: ["dist/**"] } } }),
  );
  writeFileSync(
    join(root, "packages/probe/package.json"),
    JSON.stringify({ name: "probe", scripts: { lint: "node run.cjs" } }),
  );
  writeFileSync(
    join(root, "packages/probe/run.cjs"),
    "const fs=require('node:fs');fs.mkdirSync('.turbo',{recursive:true});fs.appendFileSync('.turbo/executions','run\\n');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result','artifact');\n",
  );
  const artifacts = new Map();
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url.startsWith("/v8/artifacts/status")) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "enabled" }));
      return;
    }
    if (req.url.startsWith("/v8/artifacts/events")) {
      res.writeHead(200).end();
      return;
    }
    requests.push(req.method);
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      artifacts.set(req.url, Buffer.concat(chunks));
      res.writeHead(200).end();
    } else if (req.method === "GET" && artifacts.has(req.url)) {
      res.writeHead(200).end(artifacts.get(req.url));
    } else res.writeHead(404).end();
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CI: "true",
    TURBO_TELEMETRY_DISABLED: "1",
    RUNNER_ENVIRONMENT: "self-hosted",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
    TURBO_API: `http://127.0.0.1:${server.address().port}`,
    TURBO_TEAM: "fixture",
    TURBO_TOKEN: "fixture",
  };
  const run = (overrides = {}) =>
    promisify(execFile)(process.execPath, [command, "lint"], {
      cwd: root,
      env: { ...env, ...overrides },
      timeout: 15_000,
    });
  await run();
  await run();
  assert.deepEqual(
    requests,
    ["PUT", "PUT"],
    "nightly refreshes artifacts without any remote reads",
  );
  assert.equal(readFileSync(join(root, "packages/probe/.turbo/executions"), "utf8"), "run\nrun\n");
  rmSync(join(root, ".turbo/cache"), { recursive: true, force: true });
  rmSync(join(root, "packages/probe/dist"), { recursive: true });
  await run({ GITHUB_EVENT_NAME: "push" });
  assert.deepEqual(requests, ["PUT", "PUT", "GET"]);
  assert.equal(readFileSync(join(root, "packages/probe/dist/result"), "utf8"), "artifact");
  assert.equal(
    readFileSync(join(root, "packages/probe/.turbo/executions"), "utf8"),
    "run\nrun\n",
    "trusted push restores nightly artifact",
  );
  await run({
    RUNNER_ENVIRONMENT: "github-hosted",
    TURBO_API: "",
    TURBO_TEAM: "",
    TURBO_TOKEN: "",
  });
  assert.equal(requests.length, 3, "hosted nightly does not contact the remote cache");
  assert.equal(
    readFileSync(join(root, "packages/probe/.turbo/executions"), "utf8"),
    "run\nrun\nrun\n",
  );
  // Give affected selection a real Git base, then seed the exact changed task as main.
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const base = git("rev-parse", "HEAD");
  const source = join(root, "packages/probe/run.cjs");
  writeFileSync(source, readFileSync(source, "utf8") + "// scenario change\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "scenario",
  );
  await run();
  const clearLocal = () => {
    rmSync(join(root, ".turbo/cache"), { recursive: true, force: true });
    rmSync(join(root, "packages/probe/dist"), { recursive: true, force: true });
  };
  const measurement = { GITHUB_EVENT_NAME: "workflow_dispatch", TURBO_SCM_BASE: base };
  const executionCount = () =>
    readFileSync(join(root, "packages/probe/.turbo/executions"), "utf8").trim().split("\n").length;
  const beforeCold = executionCount();
  requests.length = 0;
  clearLocal();
  await run({ ...measurement, CI_MEASUREMENT_CACHE: "cold" });
  assert.deepEqual(requests, [], "cold measurement makes no remote artifact requests");
  assert.equal(executionCount(), beforeCold + 1, "cold executes the affected task");
  clearLocal();
  await run({ ...measurement, CI_MEASUREMENT_CACHE: "warm", CI_MEASUREMENT_RUNNER: "box" });
  assert.deepEqual(requests, ["GET"], "warm restores main's entry without any writes");
  assert.equal(executionCount(), beforeCold + 1, "warm replay does not execute the task");
  assert.equal(readFileSync(join(root, "packages/probe/dist/result"), "utf8"), "artifact");
});

test("measurement dispatches are affected-only, cold disables remote, warm never writes", (t) => {
  const run = fixture(t);
  for (const mode of ["cold", "warm"]) {
    const env = {
      CI_MEASUREMENT_CACHE: mode,
      CI_MEASUREMENT_RUNNER: "box",
      RUNNER_ENVIRONMENT: "self-hosted",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      TURBO_SCM_BASE: "a".repeat(40),
    };
    const result = run(["lint"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.args.includes("--affected"));
    assert.ok(
      result.args.includes(mode === "cold" ? "--cache=local:rw" : "--cache=local:rw,remote:r"),
    );
    assert.equal(result.args.includes("--force"), false);
    assert.equal(run(["lint"], { ...env, TURBO_SCM_BASE: "main" }).status, 1);
    for (const event of ["pull_request", "push", "merge_group", "schedule"]) {
      assert.equal(run(["lint"], { ...env, GITHUB_EVENT_NAME: event }).status, 1);
    }
    assert.equal(run(["lint"], { ...env, CI_MEASUREMENT_CACHE: "other" }).status, 1);
  }
});

test("only the box measures warm; every other runner measures cold without the remote", (t) => {
  const run = fixture(t);
  for (const runner of ["blacksmith-2vcpu-ubuntu-2404", "ubuntu-latest", undefined]) {
    const env = {
      RUNNER_ENVIRONMENT: "self-hosted",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      TURBO_SCM_BASE: "a".repeat(40),
      ...(runner === undefined ? {} : { CI_MEASUREMENT_RUNNER: runner }),
    };
    const warm = run(["lint"], { ...env, CI_MEASUREMENT_CACHE: "warm" });
    assert.equal(warm.status, 1, `${runner} warm`);
    assert.match(warm.stderr, /must run on the box/);
    const cold = run(["lint"], { ...env, CI_MEASUREMENT_CACHE: "cold" });
    assert.equal(cold.status, 0, cold.stderr);
    assert.ok(cold.args.includes("--cache=local:rw"), `${runner} cold`);
  }
});

test("a merge group runs only what it affects when the changes job says so and its base resolves", () => {
  const queue = {
    RUNNER_ENVIRONMENT: "self-hosted",
    GITHUB_EVENT_NAME: "merge_group",
    GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1-abcd",
    TURBO_SCM_BASE: "b".repeat(40),
  };
  const resolves = () => true;
  for (const [env, commitExists, affected] of [
    [{ ...queue, CI_GRAPH: "affected" }, resolves, true],
    [{ ...queue, CI_GRAPH: "affected" }, () => false, false],
    [{ ...queue, CI_GRAPH: "full" }, resolves, false],
    [queue, resolves, false],
    [{ ...queue, CI_GRAPH: "affected", TURBO_SCM_BASE: "" }, resolves, false],
    [{ ...queue, CI_GRAPH: "affected", TURBO_SCM_BASE: "main" }, resolves, false],
    [
      {
        ...queue,
        CI_GRAPH: "affected",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REF: "refs/heads/main",
      },
      resolves,
      false,
    ],
  ]) {
    const options = ciTurboOptions(env, { commitExists });
    assert.equal(options._tag, "ok", JSON.stringify(env));
    assert.equal(options.args.includes("--affected"), affected, JSON.stringify(env));
    // The queue stays the trusted cache writer whichever graph it runs.
    if (env.GITHUB_EVENT_NAME === "merge_group")
      assert.ok(options.args.includes("--cache=local:rw,remote:rw"), JSON.stringify(env));
  }
});

test("a merge group whose base cannot be resolved runs the full graph rather than failing", (t) => {
  const run = fixture(t);
  const result = run(["build", "typecheck", "lint"], {
    RUNNER_ENVIRONMENT: "self-hosted",
    GITHUB_EVENT_NAME: "merge_group",
    GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1-abcd",
    TURBO_SCM_BASE: "c".repeat(40),
    CI_GRAPH: "affected",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.args.includes("--affected"), false);
  assert.ok(result.args.includes("--cache=local:rw,remote:rw"));
});
