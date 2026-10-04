import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  newestNextTag,
  promotionAllows,
  promotionProblems,
  published,
} from "./check-release-pins.mjs";

const versionOnly = `diff --git a/apps/cli/package.json b/apps/cli/package.json
--- a/apps/cli/package.json
+++ b/apps/cli/package.json
@@ -3 +3 @@
-  "version": "0.35.1",
+  "version": "0.36.0",`;

const appVersionOnly = `--- a/deploy/helm/mend/Chart.yaml
+++ b/deploy/helm/mend/Chart.yaml
@@ -8 +8 @@
-appVersion: "0.35.1"
+appVersion: "0.36.0"`;

const chart = 'apiVersion: v2\nname: mend\nversion: 0.3.0\nappVersion: "0.36.0"\n';

const promotion = (overrides) =>
  promotionProblems({
    version: "0.36.0",
    nextTag: "v0.36.0-next.56",
    files: [],
    cliPackageDiff: "",
    chartDiff: "",
    chart,
    ...overrides,
  });

test("the newest next tag is chosen by version, and by release when one is named", () => {
  const tags = ["v0.36.0-next.9", "v0.36.0-next.56", "v0.36.0-next.100", "v0.35.1", ""];
  assert.equal(newestNextTag(tags), "v0.36.0-next.100");
  assert.equal(newestNextTag(["v0.36.0-next.9", "v0.37.0-next.1"]), "v0.37.0-next.1");
  // A patch release is proven by a next build of the patch, never by one of a later version.
  assert.equal(newestNextTag(["v0.36.1-next.3", "v0.37.0-next.1"], "0.36.1"), "v0.36.1-next.3");
  assert.equal(newestNextTag(["v0.37.0-next.1"], "0.36.1"), undefined);
  assert.equal(newestNextTag(["v0.36.0-next.9.preview.3", "v0.35.1"]), undefined);
});

test("a Version Packages pull request on top of a next build is a promotion", () => {
  assert.deepEqual(
    promotion({
      files: [
        ".changeset/stop-in-seconds.md",
        "apps/cli/CHANGELOG.md",
        "apps/cli/package.json",
        "deploy/helm/mend/Chart.yaml",
        "ROADMAP.md",
        "docs/operations/next-channel.md",
        "apps/docs/src/content/docs/getting-started/install.md",
      ],
      cliPackageDiff: versionOnly,
      chartDiff: appVersionOnly,
    }),
    [],
  );
});

test("code merged after the next build is not a promotion", () => {
  const [problem] = promotion({
    files: ["apps/cli/CHANGELOG.md", "packages/sessions/src/engine.ts", "Dockerfile"],
  });
  assert.match(problem, /not a promotion of v0\.36\.0-next\.56/);
  assert.match(problem, /2 file\(s\).*packages\/sessions\/src\/engine\.ts, Dockerfile/);
});

test("the CLI package may change only its version", () => {
  const [problem] = promotion({
    files: ["apps/cli/package.json"],
    cliPackageDiff: `${versionOnly}\n@@ -40 +40 @@\n-    "effect": "catalog:"\n+    "effect": "4.0.0"`,
  });
  assert.match(problem, /apps\/cli\/package\.json/);
});

test("the chart may change only version and appVersion, and appVersion must be the release", () => {
  const [image] = promotion({
    files: ["deploy/helm/mend/Chart.yaml"],
    chartDiff: `${appVersionOnly}\n@@ -20 +20 @@\n-  repository: ghcr.io/sealant-sh/mend\n+  repository: example/mend`,
  });
  assert.match(image, /deploy\/helm\/mend\/Chart\.yaml/);
  const [prerelease] = promotion({ chart: chart.replace('"0.36.0"', '"0.36.0-next.56"') });
  assert.match(prerelease, /appVersion 0\.36\.0-next\.56, not 0\.36\.0/);
});

test("a release with no next build of its own version is refused", () => {
  assert.match(promotion({ nextTag: undefined })[0], /No next build of 0\.36\.0 precedes/);
});

test("only notes and docs are allowed after the next build, and never a package.json", () => {
  for (const file of ["README.md", "apps/marketing/src/routes/index.tsx", "docs/adr/0015.md"]) {
    assert.ok(promotionAllows(file), file);
  }
  for (const file of [
    "apps/cli/README.md",
    "apps/cli/src/main.ts",
    ".github/workflows/release-cli.yml",
    "pnpm-lock.yaml",
    "deploy/docker/compose.v2.yaml",
    // Workspace members: a lifecycle script here runs in the image build's install.
    "apps/docs/package.json",
    "apps/marketing/package.json",
    "docs/package.json",
  ]) {
    assert.ok(!promotionAllows(file), file);
  }
});

test("a file moved into docs counts as removed from where it was", (t) => {
  // What the guard runs: --no-renames lists both sides of a move.
  const repo = mkdtempSync(path.join(tmpdir(), "promotion-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(repo, "packages/x/src"), { recursive: true });
  writeFileSync(
    path.join(repo, "packages/x/src/guard.ts"),
    "export const guard = true;\n".repeat(20),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  git("tag", "v0.36.0-next.1");
  mkdirSync(path.join(repo, "docs"));
  git("mv", "packages/x/src/guard.ts", "docs/guard.ts");
  git("commit", "-q", "-m", "move");
  const files = git("diff", "--no-renames", "--name-only", "v0.36.0-next.1..HEAD").split("\n");
  assert.deepEqual(files.sort(), ["docs/guard.ts", "packages/x/src/guard.ts"]);
  assert.match(promotion({ files })[0], /packages\/x\/src\/guard\.ts/);
});

test("a next build proves something only once npm has it", async () => {
  const fetchImpl = async (url) => ({
    ok: url.endsWith("/0.36.0-next.56"),
    status: url.endsWith("/0.36.0-next.56") ? 200 : 404,
  });
  assert.equal(await published("0.36.0-next.56", fetchImpl), true);
  assert.equal(await published("0.36.0-next.57", fetchImpl), false);
});
