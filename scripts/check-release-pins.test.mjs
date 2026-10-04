import assert from "node:assert/strict";
import test from "node:test";

import { newestNextTag, promotionAllows, promotionProblems } from "./check-release-pins.mjs";

const versionOnly = `diff --git a/apps/cli/package.json b/apps/cli/package.json
--- a/apps/cli/package.json
+++ b/apps/cli/package.json
@@ -3 +3 @@
-  "version": "0.35.1",
+  "version": "0.36.0",`;

test("the newest next tag is chosen by version, not by string order", () => {
  assert.equal(
    newestNextTag(["v0.36.0-next.9", "v0.36.0-next.56", "v0.36.0-next.100", "v0.35.1", ""]),
    "v0.36.0-next.100",
  );
  assert.equal(newestNextTag(["v0.36.0-next.9", "v0.37.0-next.1"]), "v0.37.0-next.1");
  assert.equal(newestNextTag(["v0.36.0-next.9.preview.3", "v0.35.1"]), undefined);
});

test("a Version Packages pull request on top of a next build is a promotion", () => {
  assert.deepEqual(
    promotionProblems({
      nextTag: "v0.36.0-next.56",
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
    }),
    [],
  );
});

test("code merged after the next build is not a promotion", () => {
  const [problem] = promotionProblems({
    nextTag: "v0.36.0-next.56",
    files: ["apps/cli/CHANGELOG.md", "packages/sessions/src/engine.ts", "Dockerfile"],
    cliPackageDiff: "",
  });
  assert.match(problem, /not a promotion of v0\.36\.0-next\.56/);
  assert.match(problem, /2 file\(s\).*packages\/sessions\/src\/engine\.ts, Dockerfile/);
});

test("the CLI package may change only its version", () => {
  const [problem] = promotionProblems({
    nextTag: "v0.36.0-next.56",
    files: ["apps/cli/package.json"],
    cliPackageDiff: `${versionOnly}\n@@ -40 +40 @@\n-    "effect": "catalog:"\n+    "effect": "4.0.0"`,
  });
  assert.match(problem, /apps\/cli\/package\.json/);
});

test("a release with no next build before it is refused", () => {
  assert.match(
    promotionProblems({ nextTag: undefined, files: [], cliPackageDiff: "" })[0],
    /No next build precedes this release/,
  );
});

test("only notes, docs and release bookkeeping are allowed after the next build", () => {
  for (const file of [
    "README.md",
    "apps/marketing/src/routes/index.tsx",
    "docs/adr/0015-next-channel.md",
  ]) {
    assert.ok(promotionAllows(file), file);
  }
  for (const file of [
    "apps/cli/README.md",
    "apps/cli/src/main.ts",
    ".github/workflows/release-cli.yml",
    "pnpm-lock.yaml",
    "deploy/docker/compose.v2.yaml",
  ]) {
    assert.ok(!promotionAllows(file), file);
  }
});
