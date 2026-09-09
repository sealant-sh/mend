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
