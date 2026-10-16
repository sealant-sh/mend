import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isDryRunVersion,
  lockfilePrereleases,
  newestNextTag,
  promotionAllows,
  promotionProblems,
  published,
} from "./check-release-pins.mjs";
import { recordingRegistry } from "./fixtures/recording-registry.mjs";

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
  assert.deepEqual(files.toSorted(), ["docs/guard.ts", "packages/x/src/guard.ts"]);
  assert.match(promotion({ files })[0], /packages\/x\/src\/guard\.ts/);
});

test("npm publication uses the exact package/version GET and distinguishes a missing build", async () => {
  const registry = await recordingRegistry("https://registry.npmjs.org", (request, response) => {
    if (request.method === "GET" && request.path === "/@sealant%2fmend/0.36.0-next.56")
      response.writeHead(200).end("{}");
    else response.writeHead(404).end();
  });
  try {
    assert.equal(await published("0.36.0-next.56", registry.fetchImpl), true);
    assert.equal(await published("0.36.0-next.57", registry.fetchImpl), false);
    assert.deepEqual(
      registry.requests.map(({ method, path: requestPath }) => ({ method, path: requestPath })),
      [
        { method: "GET", path: "/@sealant%2fmend/0.36.0-next.56" },
        { method: "GET", path: "/@sealant%2fmend/0.36.0-next.57" },
      ],
    );
    assert.ok(registry.requests.every(({ authorization }) => authorization === null));
  } finally {
    await registry.close();
  }
});

for (const status of [401, 429, 500]) {
  test(`npm HTTP ${status} is an error, not evidence of an unpublished build`, async () => {
    const registry = await recordingRegistry("https://registry.npmjs.org", (_request, response) =>
      response.writeHead(status).end(),
    );
    try {
      await assert.rejects(published("0.36.0-next.56", registry.fetchImpl), {
        message: `npm answered ${status} for @sealant/mend@0.36.0-next.56.`,
      });
      assert.equal(registry.requests[0]?.path, "/@sealant%2fmend/0.36.0-next.56");
    } finally {
      await registry.close();
    }
  });
}

test("npm transport failure rejects publication evidence", async () => {
  const registry = await recordingRegistry("https://registry.npmjs.org", (_request, response) =>
    response.destroy(),
  );
  try {
    await assert.rejects(published("0.36.0-next.56", registry.fetchImpl), /fetch failed/);
    assert.equal(registry.requests.length, 1);
  } finally {
    await registry.close();
  }
});

test("a stable release reads prerelease packages from the lockfile, wherever they were declared", () => {
  const lockfile = [
    "importers:",
    "  packages/sessions:",
    "    dependencies:",
    "      '@sealant/sdk':",
    "        specifier: npm:@sealant/sdk-next@0.39.0-next.12",
    "        version: '@sealant/sdk-next@0.39.0-next.12'",
    "packages:",
    "  '@sealant/sdk-next@0.39.0-next.12':",
    "  '@sealant/api-contracts-next@0.39.0-next.12':",
    "  '@sealant/sdk@0.38.1':",
  ].join("\n");
  assert.deepEqual(lockfilePrereleases(lockfile), [
    "@sealant/sdk-next@0.39.0-next.12",
    "@sealant/api-contracts-next@0.39.0-next.12",
  ]);
  assert.deepEqual(lockfilePrereleases("  '@sealant/sdk@0.38.1':\n"), []);
});

test("only release-cli.yml's derived dry-run version skips the release-only checks", () => {
  assert.ok(isDryRunVersion("0.0.0-dryrun.38700000001.2"));
  for (const version of [
    "0.37.0",
    "0.37.0-next.4",
    "0.0.0-dryrun.1",
    "0.0.0-dryrun.1.2.3",
    "0.37.0-dryrun.1.2",
    "0.0.0-dryrun.1.2-next.3",
    "0.0.0-acceptance.1.2",
  ])
    assert.ok(!isDryRunVersion(version), version);
});

/**
 * The real script, copied beside a stand-in sealant-pins.mjs (good pins, no network) into a git
 * repository whose HEAD is not on origin/main. `git` is logged, then run for real.
 */
const offMain = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-pins-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["check-release-pins.mjs", "next-version.mjs"])
    copyFileSync(path.join(here, file), path.join(directory, file));
  const semver = readFileSync(path.join(here, "sealant-pins.mjs"), "utf8").match(
    /export const SEMVER =\s*[^;]+;/,
  )[0];
  writeFileSync(
    path.join(directory, "sealant-pins.mjs"),
    `${semver}
export const readRepositoryPins = async () => ({ sealantVersion: "1.0.0" });
export const readRepositoryPinFiles = async () => ({});
export const pinProblems = () => [];
export const assetProblems = () => [];
export const digestProblems = async () => [];
`,
  );
  mkdirSync(path.join(directory, "apps/cli"), { recursive: true });
  writeFileSync(path.join(directory, "apps/cli/package.json"), '{"version":"0.37.0"}');
  writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(path.join(directory, "deploy/helm/mend"), { recursive: true });
  writeFileSync(
    path.join(directory, "deploy/helm/mend/Chart.yaml"),
    "version: 0.37.0\nappVersion: 0.37.0\n",
  );
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitEnv = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args) =>
    execFileSync(real, args, { cwd: directory, env: { ...process.env, ...gitEnv } });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "--orphan", "elsewhere");
  git("commit", "-q", "--allow-empty", "-m", "off main");
  const bin = path.join(directory, ".bin");
  mkdirSync(bin);
  const log = path.join(directory, ".git-calls");
  writeFileSync(log, "");
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\necho "$*" >>${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );
  return (...args) => {
    writeFileSync(log, "");
    const result = spawnSync(process.execPath, ["check-release-pins.mjs", ...args], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}` },
    });
    return { ...result, git: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  };
};

test("a dry-run-shaped tag gets every release check; only --dry-run relaxes them", (t) => {
  const pins = offMain(t);
  // The audit's bypass: a v0.0.0-dryrun tag on an off-main commit.
  const tagged = pins("v0.0.0-dryrun.9.1");
  assert.equal(tagged.status, 1, tagged.stdout);
  assert.match(tagged.stderr, /this commit is not on origin\/main/);
  assert.match(tagged.stderr, /A prerelease is a next build/);
  assert.ok(tagged.git.includes("merge-base --is-ancestor HEAD origin/main"));
  // The dispatch's own dry run: the every-release pin checks only, nothing that reads history.
  const dry = pins("--dry-run", "v0.0.0-dryrun.9.1");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /pins Sealant 1\.0\.0 everywhere/);
  assert.deepEqual(dry.git, []);
  // --dry-run checks a dry-run version only.
  const flagged = pins("--dry-run", "v0.37.0");
  assert.equal(flagged.status, 1);
  assert.match(flagged.stderr, /--dry-run checks a 0\.0\.0-dryrun/);
  for (const args of [["--dry-run"], ["v0.37.0", "--dry-run"], ["--dry-run", "--dry-run", "v1"]])
    assert.equal(pins(...args).status, 2, args.join(" "));
});

test("an ordinary release on an off-main commit is refused", (t) => {
  const pins = offMain(t);
  for (const tag of ["v0.37.0", "v0.0.0-other.9.1"]) {
    const result = pins(tag);
    assert.equal(result.status, 1, tag);
    assert.match(result.stderr, /this commit is not on origin\/main/, tag);
  }
});
