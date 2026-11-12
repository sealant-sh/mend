import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "fingerprint.mjs");

const run = (...dirs) => {
  const result = spawnSync(process.execPath, [script, ...dirs], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const tree = () => {
  const root = mkdtempSync(join(tmpdir(), "fingerprint-test-"));
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "objects", "blob"), "object\n");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(Buffer.from([...Buffer.from(`${root}/`), 0xff]), "not UTF-8\n");
  return root;
};

test("a read leaves the fingerprint as it was", () => {
  const root = tree();
  try {
    const before = run(root);
    readFileSync(join(root, "a.txt"));
    readFileSync(join(root, ".git", "objects", "blob"));
    assert.equal(run(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, change] of [
  [
    "a freshened object's mtime",
    (root) =>
      utimesSync(join(root, ".git", "objects", "blob"), new Date(), new Date(Date.now() + 5000)),
  ],
  ["the same bytes written again", (root) => writeFileSync(join(root, "a.txt"), "one\n")],
  ["a lock file that appeared", (root) => writeFileSync(join(root, ".git", "index.lock"), "")],
  ["a file removed", (root) => rmSync(join(root, "a.txt"))],
  [
    "a file whose name is not UTF-8 written again",
    (root) => writeFileSync(Buffer.from([...Buffer.from(`${root}/`), 0xff]), "other\n"),
  ],
]) {
  test(`${name} changes the fingerprint`, () => {
    const root = tree();
    try {
      const before = run(root);
      change(root);
      assert.notEqual(run(root), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("refuses to run without a directory", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
});
