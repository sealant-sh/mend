import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/release-cli.yml", import.meta.url),
  "utf8",
);

// Inspect the checked-in job boundaries, not a second model of the release workflow.
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `Missing release job ${name}`);
  const remaining = workflow.slice(start + 1);
  const next = remaining.slice(1).search(/^  [\w-]+:\s*$/m);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

function dependencies(name) {
  const match = job(name).match(/^    needs: (.+)$/m);
  assert.ok(match, `${name} must declare its publication dependencies`);
  return match[1]
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(",")
    .map((value) => value.trim());
}

test("npm waits for verified images and public setup assets", () => {
  assert.ok(dependencies("npm").includes("images"));
  assert.ok(dependencies("npm").includes("github-release"));
  assert.ok(dependencies("github-release").includes("images"));
  assert.ok(!dependencies("github-release").includes("npm"));
});

test("asset verification uses anonymous exact-version downloads and byte comparison", () => {
  const release = job("github-release");
  const verification = release.slice(release.indexOf("- name: Verify anonymous setup downloads"));
  assert.match(verification, /set -euo pipefail/);
  assert.match(verification, /curl -q --fail --location/);
  assert.match(verification, /releases\/download\/\$GITHUB_REF_NAME\/\$asset/);
  assert.match(verification, /cmp "\$source" "\$downloads\/\$asset"/);
  assert.doesNotMatch(verification, /GH_TOKEN|Authorization/);
  for (const asset of [
    "compose.v2.yaml",
    "postgres-init.sh",
    "setup-contract.v2.json",
    "install.sh",
  ]) {
    assert.ok(verification.includes(asset), `Verify required asset ${asset}`);
  }
});

test("release retries preserve already published assets", () => {
  const release = job("github-release");
  assert.match(release, /gh release view/);
  assert.match(release, /gh release upload/);
  assert.match(release, /--latest=false/);
  assert.doesNotMatch(release, /--clobber|gh release delete|--draft/);
});

test("stable latest promotion waits for npm and the GitHub release", () => {
  assert.ok(dependencies("promote-images").includes("npm"));
  assert.ok(dependencies("promote-images").includes("github-release"));
  const promotion = job("promote-images");
  const prereleaseGuard = promotion.indexOf('if [[ "$version" == *-* ]]; then exit 0; fi');
  assert.ok(prereleaseGuard >= 0);
  assert.ok(promotion.indexOf("docker buildx imagetools create") > prereleaseGuard);
  assert.ok(promotion.indexOf("gh release edit") > prereleaseGuard);
});

test("nothing builds or publishes before the pins are checked", () => {
  const pins = job("pins");
  assert.match(pins, /fetch-depth: 0/);
  assert.match(pins, /node scripts\/check-release-pins\.mjs "\$GITHUB_REF_NAME"/);
  assert.ok(dependencies("images").includes("pins"));
  // npm, the GitHub release and the latest promotion all wait on images, so on the pins too.
  assert.ok(dependencies("github-release").includes("images"));
});

test("a next build is a GitHub prerelease on npm's next dist-tag, and never moves latest", () => {
  assert.match(job("npm"), /if \[\[ "\$version" == \*-\* \]\]; then channel=next; fi/);
  assert.match(
    job("github-release"),
    /if \[\[ "\$VERSION" == \*-\* \]\]; then flags\+=\(--prerelease\); fi/,
  );
  assert.match(job("github-release"), /A \\`next\\` build of Mend from main/);
});

test("image.yml pushes a version once, and only its own dispatch is held to main", async (t) => {
  const image = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  const merge = image.slice(image.indexOf("Create and inspect the multi-arch candidate"));
  const refusal = merge.indexOf("already exists; a version is pushed once");
  assert.ok(refusal > 0);
  assert.ok(merge.indexOf("docker buildx imagetools create") > refusal);

  // Run the dispatch check as written, with a stand-in `gh` that knows one tag.
  const step = image.slice(image.indexOf("- name: A direct dispatch comes from main"));
  const script = step
    .slice(step.indexOf("run: |") + "run: |".length, step.indexOf("- name: Resolve one version"))
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const bin = mkdtempSync(`${tmpdir()}/image-dispatch-`);
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    `${bin}/gh`,
    '#!/bin/sh\ncase "$2" in */tags/v0.36.0-next.60) exit 0 ;; esac\nexit 1\n',
  );
  chmodSync(`${bin}/gh`, 0o755);
  const run = (workflow, ref, version = "") =>
    spawnSync("bash", ["-c", script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "sealant-sh/Mend",
        GITHUB_WORKFLOW_REF: `sealant-sh/Mend/.github/workflows/${workflow}@${ref}`,
        GITHUB_REF: ref,
        OVERRIDE_VERSION: version,
      },
    }).status;
  // The Version PR's pre-tag acceptance: release-acceptance.yml dispatched on its branch, calling image.yml.
  assert.equal(run("release-acceptance.yml", "refs/heads/changeset-release/main"), 0);
  assert.equal(run("image.yml", "refs/heads/feature"), 1);
  assert.equal(run("image.yml", "refs/heads/main"), 0);
  assert.equal(run("image.yml", "refs/heads/main", "0.0.0-dev.sha0123456789ab"), 0);
  assert.equal(run("image.yml", "refs/heads/main", "0.36.0-next.60"), 0);
  assert.equal(run("image.yml", "refs/heads/main", "0.36.0"), 1);
});

test("npm's next is checked again after the approval, so it never moves back", () => {
  const npm = job("npm");
  const check = npm.indexOf('node scripts/next-version.mjs --newer "$version" "$current"');
  assert.ok(check > 0);
  assert.ok(npm.indexOf("publish --access public") > check);
});
