import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const turbo = join(repository, "node_modules/turbo/bin/turbo");
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-cache-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "cache-proof", private: true, packageManager: "pnpm@10.32.1" }),
  );
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/library: {}\n  packages/consumer: {}\n",
  );
  write(".node-version", "26.4.0\n");
  write(".gitignore", "node_modules/\n.turbo/\ndist/\n");
  write(".oxlintrc.json", "{}\n");
  write("tooling/scripts/bundle-app.mjs", "// shared builder\n");
  write("scripts/fixture.mjs", "// shared fixture\n");
  write(".claude/skills/verify/scripts/fixture.mjs", "// verification helper\n");
  write("deploy/docker/fixture.yaml", "image: postgres:17\n");
  write("docs/example.md", "Documentation only.\n");
  copyFileSync(join(repository, "turbo.json"), join(root, "turbo.json"));
  for (const name of ["library", "consumer"]) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({
        name,
        scripts: Object.fromEntries(
          ["build", "test", "typecheck", "lint"].map((task) => [task, "node execute.cjs"]),
        ),
        ...(name === "consumer" ? { dependencies: { library: "workspace:*" } } : {}),
      }),
    );
    write(
      `packages/${name}/execute.cjs`,
      "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result','artifact');\n",
    );
    write(`packages/${name}/src/input.ts`, "export const value = 1;\n");
  }
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CI: "true",
    MEND_CI_RUNTIME: `${process.version}/${process.platform}/${process.arch}`,
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Cache proof",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const base = git("rev-parse", "HEAD");
  const run = (args, overrides = {}) =>
    execFileSync(
      process.execPath,
      [turbo, "run", ...args, "--cache=local:rw", "--env-mode=strict"],
      {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
  const dry = (args, overrides) => JSON.parse(run([...args, "--dry=json"], overrides));
  return { root, write, git, base, run, dry };
};

test("real Turbo restores build artifacts and misses for shared inputs and hashed environment", (t) => {
  const f = fixture(t);
  f.run(["build", "test", "lint", "typecheck"]);
  const baseline = f.dry(["build", "test", "lint", "typecheck"]);
  assert.ok(baseline.tasks.every((task) => task.cache.status === "HIT"));
  rmSync(join(f.root, "packages/consumer/dist"), { recursive: true });
  f.run(["build", "--filter=consumer"]);
  assert.equal(readFileSync(join(f.root, "packages/consumer/dist/result"), "utf8"), "artifact");
  const cases = [
    [".node-version", "26.5.0\n", "consumer#test"],
    [".oxlintrc.json", '{"rules":{}}\n', "consumer#lint"],
    ["tooling/scripts/bundle-app.mjs", "// changed builder\n", "consumer#build"],
    ["scripts/fixture.mjs", "// changed fixture\n", "consumer#test"],
    [".claude/skills/verify/scripts/fixture.mjs", "// changed verification\n", "consumer#test"],
    ["deploy/docker/fixture.yaml", "image: postgres:18\n", "consumer#test"],
    [
      "pnpm-lock.yaml",
      readFileSync(join(f.root, "pnpm-lock.yaml"), "utf8") + "# changed lock\n",
      "consumer#typecheck",
    ],
    ["packages/library/src/input.ts", "export const value = 2;\n", "consumer#test"],
  ];
  for (const [file, contents, taskId] of cases) {
    const original = readFileSync(join(f.root, file));
    try {
      f.write(file, contents);
      const task = f
        .dry([taskId.split("#")[1], "--filter=consumer"])
        .tasks.find((candidate) => candidate.taskId === taskId);
      assert.notEqual(
        task.hash,
        baseline.tasks.find((candidate) => candidate.taskId === taskId).hash,
        file,
      );
      assert.equal(task.cache.status, "MISS", file);
    } finally {
      f.write(file, original);
    }
  }
  for (const overrides of [
    { MEND_TEST_DATABASE_URL: "postgres://fixture/changed" },
    { VITEST_MAX_WORKERS: "2" },
    { MEND_CI_RUNTIME: "v99.0.0/linux/x64" },
  ]) {
    const task = f
      .dry(["test", "--filter=consumer"], overrides)
      .tasks.find((candidate) => candidate.taskId === "consumer#test");
    assert.equal(task.cache.status, "MISS", JSON.stringify(overrides));
  }
  assert.ok(
    f
      .dry(["test"])
      .tasks.filter((task) => task.task === "test")
      .every((task) => task.cache.status === "HIT"),
    "restoring inputs restores cache hits",
  );
});

test("affected selection intersects lanes and follows cross-package inputs without selecting docs-only changes", (t) => {
  const f = fixture(t);
  const changed = (file, contents, args) => {
    const original = readFileSync(join(f.root, file));
    try {
      f.write(file, contents);
      const result = f.dry(["test", "--affected", ...args], { TURBO_SCM_BASE: f.base });
      return result.tasks
        .filter((task) => task.task === "test")
        .map((task) => task.package)
        .toSorted();
    } finally {
      f.write(file, original);
    }
  };
  assert.deepEqual(changed("docs/example.md", "Only docs changed.\n", []), []);
  assert.deepEqual(changed("packages/consumer/src/input.ts", "export const value=2;\n", []), [
    "consumer",
  ]);
  assert.deepEqual(
    changed("packages/consumer/src/input.ts", "export const value=2;\n", ["--filter=library"]),
    [],
  );
  assert.deepEqual(
    changed("packages/library/src/input.ts", "export const value=2;\n", ["--filter=consumer"]),
    ["consumer"],
  );
  assert.deepEqual(changed("scripts/fixture.mjs", "// new external fixture\n", []), [
    "consumer",
    "library",
  ]);
});

test("real service test tasks cannot replay a cached integration verdict", () => {
  const paths = [
    "apps/api",
    "apps/cli",
    "apps/desktop",
    "apps/t3-gateway",
    "packages/auth",
    "packages/db",
    "packages/jobs",
    "packages/landing",
    "packages/sessions",
    "packages/slack",
    "packages/store",
    "packages/t3-contracts",
    "packages/workspace-ssh",
  ];
  for (const path of paths) {
    const config = JSON.parse(readFileSync(join(repository, path, "turbo.json"), "utf8"));
    assert.equal(config.tasks.test.cache, false, path);
    assert.deepEqual(config.extends, ["//"], path);
  }
});
