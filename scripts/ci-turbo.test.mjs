import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
      assert.ok(
        result.args.includes(
          `--cache=local:rw${runner === "self-hosted" ? (writes ? ",remote:rw" : ",remote:r") : ""}`,
        ),
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
