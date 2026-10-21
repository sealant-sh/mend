import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const script = new URL("./ci-scope.mjs", import.meta.url).pathname;
const full = "mobile=true\npackaging=true\nstore=true\n";
const only = ({ mobile = false, packaging = false, store = false } = {}) =>
  `mobile=${mobile}\npackaging=${packaging}\nstore=${store}\n`;
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

test("selects dependent jobs from committed paths while root, manifests and unknowns run every extra", (t) => {
  const f = fixture(t);
  for (const [path, expected] of [
    ["docs/operations/notes.md", only()],
    ["apps/api/src/route.ts", only({ packaging: true })],
    ["apps/web/src/view.tsx", only({ packaging: true })],
    ["apps/mobile/src/view.tsx", only({ mobile: true, packaging: true })],
    ["packages/domain/src/id.ts", full],
    ["packages/store/src/git.ts", full],
    ["packages/sessions/src/engine.ts", only({ mobile: true, packaging: true })],
    ["packages/new-shared/src/value.ts", only({ mobile: true, packaging: true })],
    ["Dockerfile", full],
    ["apps/docs/package.json", full],
    [".github/workflows/ci.yml", full],
    [".claude/skills/verify/SKILL.md", full],
    ["scripts/verify-stack/stack.mjs", full],
    ["tooling/typescript/base.json", full],
    ["pnpm-lock.yaml", full],
    ["unknown/new-input.txt", full],
    ["apps/mobile/src/line\nbreak.ts", full],
    // A package's tests and their helpers reach neither the mobile web build nor the packaging lane.
    ["packages/sessions/test/engine-capture-joining.test.ts", only()],
    ["packages/domain/src/id.test.ts", only()],
    ["packages/db/test/postgres.ts", only()],
    // The store's own tests are what store-image-git runs.
    ["packages/store/test/handoff.test.ts", only({ store: true })],
    ["packages/store/src/git.test.ts", only({ store: true })],
    ["packages/sessions/test/package.json", full],
    ["packages/x/test/a\nb.test.ts", full],
    ["apps/api/src/route.test.ts", only({ packaging: true })],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    f.write(path);
    const head = f.commit();
    const result = f.select(base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, path);
  }
});

test("a package's test-only change skips the extras only when every other path does", (t) => {
  const f = fixture(t);
  for (const [paths, expected] of [
    [["packages/sessions/test/engine-capture-joining.test.ts", "packages/domain/src/id.ts"], full],
    [
      ["packages/sessions/test/engine-capture-joining.test.ts", "apps/api/src/route.ts"],
      only({ packaging: true }),
    ],
    [["packages/domain/src/id.test.ts", "docs/operations/notes.md"], only()],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    for (const path of paths) f.write(path, `${paths.join(",")}\n`);
    const head = f.commit();
    const result = f.select(base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, paths.join(" + "));
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
  assert.equal(f.select(beforeDelete, deleted).stdout, only({ mobile: true, packaging: true }));
});

test("compares from the merge base when main advances independently", (t) => {
  const f = fixture(t);
  const original = f.git("rev-parse", "HEAD");
  f.write("packages/domain/base-only.ts");
  const main = f.commit();
  f.git("checkout", "-b", "proposal", original);
  f.write("docs/proposal.md");
  const head = f.commit();
  assert.equal(f.select(main, head).stdout, only());
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
    ["docs/operations/merge-queue.md", "affected"],
    ["docs/adr/0001.md", "affected"],
    ["docsx/a.md", "full"],
    ["apps/docs/src/content/docs/x.md", "affected"],
    ["apps/docs/turbo.json", "full"],
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

test("root docs join a merge group's affected graph only beside paths Turbo attributes", (t) => {
  const f = fixture(t);
  for (const [paths, graph] of [
    [["docs/x.md", "packages/domain/src/id.ts"], "affected"],
    [["docs/x.md", "scripts/ci-turbo.mjs"], "full"],
    [["docs/x.md", "turbo.json"], "full"],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    for (const path of paths) f.write(path, `${paths.join(",")}\n`);
    const head = f.commit();
    const result = f.select("--merge-group", base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\ngraph=${graph}\\n$`), paths.join(" + "));
  }
});

test("a root file named docs is a root file, not the docs directory", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  f.write("docs");
  const head = f.commit();
  assert.equal(f.select("--merge-group", base, head).stdout, `${full}graph=full\n`);
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
