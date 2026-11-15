import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sourceReferences, testInputAudit } from "./ci-test-inputs.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const turbo = join(repository, "node_modules/turbo/bin/turbo");

test("repository test reads are declared in resolved Turbo inputs and native consumers cannot cache", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repository,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const packages = files
    .filter(
      (file) =>
        /^(?:apps|packages)\/[^/]+\/package.json$/.test(file) &&
        JSON.parse(readFileSync(join(repository, file), "utf8")).scripts?.test,
    )
    .map((file) => dirname(file));
  const resolved = JSON.parse(
    execFileSync(process.execPath, [turbo, "run", "test", "--cache=local:rw", "--dry=json"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 20 * 1024 * 1024,
    }),
  );
  const problems = [];
  for (const entry of testInputAudit(repository, files, packages)) {
    const task = resolved.tasks.find(
      (candidate) => candidate.directory === entry.directory && candidate.task === "test",
    );
    assert.ok(task, entry.directory);
    for (const [file, source] of Object.entries(entry.references)) {
      const key = relative(join(repository, entry.directory), join(repository, file));
      if (!(key in task.inputs) && !(file in resolved.globalCacheInputs.files))
        problems.push(`${source} reads ${file}, missing from ${task.taskId} inputs`);
    }
    if (Object.keys(entry.binaries).length && task.resolvedTaskDefinition.cache !== false) {
      problems.push(
        `${task.taskId} runs native binaries ${JSON.stringify(entry.binaries)} but permits cached results`,
      );
    }
  }
  assert.deepEqual(problems, []);
});

test("input audit resolves root paths through URL, dirname, cwd, constants and templates", () => {
  const result = sourceReferences(
    `
    const root = path.join(import.meta.dirname, "..", "..", "..");
    readFileSync(path.join(root, "install.sh"));
    readFileSync(new URL("../../../Dockerfile", import.meta.url));
    readFileSync(path.join(process.cwd(), "../../packages/db/src/migrations.ts"));
    readFileSync(new URL(\`../../../deploy/docker/\${name}\`, import.meta.url));
    const here = fileURLToPath(import.meta.url);
    readFileSync(path.resolve(path.dirname(here), "../../../.oxlintrc.json"));
    readFileSync("../../.npmrc");
    spawnSync("ssh", ["-G"]);
    spawnSync(process.execPath, ["fixture.mjs"]);
  `,
    "/repo/apps/cli/src/example.test.ts",
    "/repo/apps/cli",
  );
  for (const file of [
    "install.sh",
    "Dockerfile",
    "packages/db/src/migrations.ts",
    "deploy/docker/*",
    ".oxlintrc.json",
    ".npmrc",
  ]) {
    assert.ok(result.paths.includes(`/repo/${file}`), file);
  }
  assert.deepEqual(result.binaries, ["ssh"]);
});

test("input audit counts root files the test command itself loads, and what they import", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-input-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "packages/web/package.json": JSON.stringify({
      scripts: {
        test: "node --test --test-reporter=../../scripts/reporter.mjs --test-reporter-destination=stdout src/a.test.mjs",
      },
    }),
    "packages/web/src/a.test.mjs": "export const checked = 1;\n",
    "scripts/reporter.mjs": 'import "./reporter-lib.mjs";\n',
    "scripts/reporter-lib.mjs": "export const format = 1;\n",
    "scripts/unrelated.mjs": "export const unrelated = 1;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const [audit] = testInputAudit(root, Object.keys(files), ["packages/web"]);
  assert.deepEqual(Object.keys(audit.references), [
    "scripts/reporter-lib.mjs",
    "scripts/reporter.mjs",
  ]);
  assert.equal(audit.references["scripts/reporter.mjs"], "packages/web/package.json");
});

test("input audit counts every file a templated path can name, and no file outside it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mend-input-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "packages/web/package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "packages/web/src/a.test.ts":
      "export const read = (name) => readFileSync(new URL(`../../../deploy/docker/${name}`, import.meta.url));\n",
    "deploy/docker/compose.yaml": "services: {}\n",
    "deploy/docker/init.sh": "true\n",
    "deploy/dockerfiles/Dockerfile": "FROM scratch\n",
    "deploy/docker/nested/compose.yaml": "services: {}\n",
    "deploy/other.yaml": "other: true\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const [audit] = testInputAudit(root, Object.keys(files), ["packages/web"]);
  assert.deepEqual(Object.keys(audit.references), [
    "deploy/docker/compose.yaml",
    "deploy/docker/init.sh",
  ]);
});
