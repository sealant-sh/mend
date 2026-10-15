import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const script = new URL("./ci-scope.mjs", import.meta.url).pathname;
const full = "mobile=true\npackaging=true\n";
const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mend-ci-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "CI fixture",
    GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI fixture",
    GIT_COMMITTER_EMAIL: "ci@example.invalid",
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "base");
  const write = (path, value = "fixture") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  const select = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
  return { cwd, git, write, commit, select };
};

test("selects dependent jobs from committed paths while root, manifests and unknowns run both", (t) => {
  const f = fixture(t);
  for (const [path, expected] of [
    ["docs/operations/notes.md", "mobile=false\npackaging=false\n"],
    ["apps/api/src/route.ts", "mobile=false\npackaging=true\n"],
    ["apps/web/src/view.tsx", "mobile=false\npackaging=true\n"],
    ["apps/mobile/src/view.tsx", full],
    ["packages/domain/src/id.ts", full],
    ["packages/new-shared/src/value.ts", full],
    ["apps/docs/package.json", full],
    [".github/workflows/ci.yml", full],
    [".claude/skills/verify/SKILL.md", full],
    ["scripts/verify-stack/stack.mjs", full],
    ["tooling/typescript/base.json", full],
    ["pnpm-lock.yaml", full],
    ["unknown/new-input.txt", full],
    ["apps/mobile/src/line\nbreak.ts", full],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    f.write(path);
    const head = f.commit();
    const result = f.select(base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, path);
  }
});

test("retains deleted and renamed origins when a source file moves into docs", (t) => {
  const f = fixture(t);
  f.write("packages/domain/source.ts");
  const base = f.commit();
  f.write("docs/placeholder.md");
  renameSync(join(f.cwd, "packages/domain/source.ts"), join(f.cwd, "docs/source.ts"));
  const renamed = f.commit();
  assert.equal(f.select(base, renamed).stdout, full);
  f.write("apps/mobile/removed.ts");
  const beforeDelete = f.commit();
  rmSync(join(f.cwd, "apps/mobile/removed.ts"));
  const deleted = f.commit();
  assert.equal(f.select(beforeDelete, deleted).stdout, full);
});

test("compares from the merge base when main advances independently", (t) => {
  const f = fixture(t);
  const original = f.git("rev-parse", "HEAD");
  f.write("packages/domain/base-only.ts");
  const main = f.commit();
  f.git("checkout", "-b", "proposal", original);
  f.write("docs/proposal.md");
  const head = f.commit();
  assert.equal(f.select(main, head).stdout, "mobile=false\npackaging=false\n");
});

test("missing history, malformed references, empty diffs and non-PR runs cannot skip jobs", (t) => {
  const f = fixture(t);
  const head = f.git("rev-parse", "HEAD");
  for (const args of [["--all"], [], ["--help", head], ["0".repeat(40), head], [head, head]]) {
    const result = f.select(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, full);
  }
});

test("a merge group runs only what its packages affect, and anything Turbo cannot attribute runs the full graph", (t) => {
  const f = fixture(t);
  for (const [path, graph] of [
    ["packages/domain/src/id.ts", "affected"],
    ["apps/web/src/view.tsx", "affected"],
    ["tooling/typescript/base.json", "affected"],
    [".changeset/quick-fox.md", "affected"],
    ["packages/db/turbo.json", "full"],
    ["turbo.json", "full"],
    ["pnpm-lock.yaml", "full"],
    [".github/workflows/ci.yml", "full"],
    ["scripts/ci-turbo.mjs", "full"],
    ["docs/operations/merge-queue.md", "full"],
    ["deploy/helm/values.yaml", "full"],
    [".oxlintrc.json", "full"],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    f.write(path);
    const head = f.commit();
    const result = f.select("--merge-group", base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\ngraph=${graph}\\n$`), path);
  }
});

test("a batched merge group is scoped by every pull request in it", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  f.write("packages/domain/src/first.ts");
  const first = f.commit();
  f.write("apps/api/src/second.ts");
  const bothInPackages = f.commit();
  assert.match(f.select("--merge-group", base, bothInPackages).stdout, /\ngraph=affected\n$/);
  // The second pull request alone touches the workflows: the whole group runs everything.
  f.git("checkout", "-b", "second-touches-workflows", first);
  f.write(".github/workflows/ci.yml");
  const second = f.commit();
  assert.match(f.select("--merge-group", base, first).stdout, /\ngraph=affected\n$/);
  assert.match(f.select("--merge-group", base, second).stdout, /\ngraph=full\n$/);
});

test("a merge group with no usable comparison runs the full graph", (t) => {
  const f = fixture(t);
  const head = f.git("rev-parse", "HEAD");
  for (const args of [[], [head], ["main", head], ["0".repeat(40), head], [head, head]]) {
    const result = f.select("--merge-group", ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${full}graph=full\n`, args.join(" "));
  }
});
