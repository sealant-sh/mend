import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { testOnly } from "./ci-scope.mjs";
import { packageTestFiles } from "./remove-package-tests.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./remove-package-tests.mjs", import.meta.url));
const remove = (cwd) => spawnSync(process.execPath, [script, cwd], { encoding: "utf8" });

const scratch = (t, files) => {
  const dir = mkdtempSync(join(tmpdir(), "mend-remove-package-tests-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "fixture\n");
  }
  return dir;
};

test("removes exactly the package test files the scope skips, outside node_modules", (t) => {
  const removed = [
    "packages/a/test/engine.test.ts",
    "packages/a/test/fixtures/shell-profile/Dockerfile",
    "packages/a/src/view.spec.tsx",
    "packages/b/src/deep/id.test.mjs",
  ];
  const kept = [
    "packages/a/src/index.ts",
    "packages/a/package.json",
    "packages/a/test/package.json",
    "packages/a/src/data.test.json",
    "packages/a/node_modules/dep/test/c.test.js",
    "apps/api/src/route.test.ts",
    "scripts/x.test.mjs",
  ];
  const dir = scratch(t, [...removed, ...kept]);
  const result = remove(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "packages/a: 3\npackages/b: 1\nRemoved 4 package test files from 2 packages.\n",
  );
  for (const path of removed) assert.ok(!existsSync(join(dir, path)), path);
  for (const path of kept) assert.ok(existsSync(join(dir, path)), path);
});

test("fails, deleting nothing, when no package test file is left to remove", (t) => {
  for (const files of [[], ["packages/a/src/index.ts", "apps/api/src/route.test.ts"]]) {
    const dir = scratch(t, files);
    const result = remove(dir);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Removed no package test files under /);
    for (const path of files) assert.ok(existsSync(join(dir, path)), path);
  }
});

test("on this repository, removes every tracked file ci-scope's testOnly skips and nothing else", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "packages"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && existsSync(join(root, path)));
  const found = packageTestFiles(root);
  assert.deepEqual(
    found.filter((path) => tracked.includes(path)),
    tracked.filter(testOnly).toSorted(),
  );
  assert.ok(found.every(testOnly));
  assert.ok(found.length > 100, `only ${found.length} package test files`);
});

test("a lane that reads a package test file passes on a checkout and fails after the removal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mend-remove-package-tests-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A checkout of this commit's packages, read the way a lane step would.
  execFileSync("sh", ["-c", `git archive HEAD packages | tar -x -C "${dir}"`], { cwd: root });
  const fixture = "packages/sessions/test/fixtures/shell-profile/Dockerfile";
  const lane = () => spawnSync("cat", [fixture], { cwd: dir, encoding: "utf8" });
  const before = lane();
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /^FROM /m);
  const removal = remove(dir);
  assert.equal(removal.status, 0, removal.stderr);
  assert.match(removal.stdout, /^packages\/sessions: \d+$/m);
  const after = lane();
  assert.notEqual(after.status, 0);
  assert.match(after.stderr, /No such file or directory/);
});
