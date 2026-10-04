#!/usr/bin/env node
// The first job of a release (.github/workflows/release-cli.yml), before anything builds or
// publishes (docs/adr/0015-next-channel.md):
//
// - Every release: the Core pins are consistent (sealant-pins.mjs) and each pinned digest is what
//   GHCR serves for the pinned Core version.
// - A `next` prerelease (vX.Y.Z-next.N): the tag is the version next-version.mjs gives its commit,
//   and that commit is on main.
// - A stable release (vX.Y.Z): no prerelease pin, the CLI package carries the version, and the
//   commit is a promotion: since the newest `next` tag it contains, only release bookkeeping and
//   documentation changed (the Version Packages pull request, notes, docs).
//
//   node scripts/check-release-pins.mjs v0.36.0-next.56
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { isNextVersion, nextVersionOf } from "./next-version.mjs";
import { SEMVER, digestProblems, pinProblems, readRepositoryPins } from "./sealant-pins.mjs";

/** Paths a stable release may change after the `next` build it promotes. */
export const promotionAllows = (file) =>
  file.startsWith(".changeset/") ||
  file.endsWith("/CHANGELOG.md") ||
  file === "deploy/helm/mend/Chart.yaml" ||
  file.startsWith("docs/") ||
  file.startsWith("apps/docs/") ||
  file.startsWith("apps/marketing/") ||
  (!file.includes("/") && file.endsWith(".md"));

/**
 * What a stable release changes beyond its promoted `next` build. `files` is `git diff --name-only`
 * from the `next` tag; `cliPackageDiff` is `git diff -U0` of apps/cli/package.json, which may change
 * only its version.
 */
export const promotionProblems = ({ nextTag, files, cliPackageDiff }) => {
  if (nextTag === undefined) {
    return [
      "No next build precedes this release. Tag a vX.Y.Z-next.N on main, run it on the box, then release.",
    ];
  }
  const changedLines = cliPackageDiff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  const extra = files.filter((file) =>
    file === "apps/cli/package.json"
      ? changedLines.some((line) => !/^[+-] {2}"version": "[^"]+",$/.test(line))
      : !promotionAllows(file),
  );
  return extra.length === 0
    ? []
    : [
        `This release is not a promotion of ${nextTag}: since it, ${extra.length} file(s) changed beyond release notes and docs (${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ", …" : ""}). Tag a new next build of this commit, prove it, then release.`,
      ];
};

/** The highest `vX.Y.Z-next.N` tag in `tags`. */
export const newestNextTag = (tags) =>
  tags
    .filter((tag) => isNextVersion(tag.replace(/^v/, "")))
    .map((tag) => ({
      tag,
      parts: tag
        .replace(/^v/, "")
        .split(/[.-]next\.|\./)
        .map(Number),
    }))
    .sort((a, b) => {
      for (let index = 0; index < 4; index += 1) {
        if (a.parts[index] !== b.parts[index]) return b.parts[index] - a.parts[index];
      }
      return 0;
    })[0]?.tag;

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const check = async (tag) => {
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) return [`"${tag}" is not a vX.Y.Z release tag.`];
  const stable = !version.includes("-");
  const pins = await readRepositoryPins();
  const problems = [...pinProblems(pins, { stable }), ...(await digestProblems(pins))];
  if (!stable) {
    if (!isNextVersion(version)) {
      problems.push(`A prerelease is a next build, vX.Y.Z-next.N; "${tag}" is not one.`);
    } else {
      const expected = nextVersionOf("HEAD");
      if (version !== expected)
        problems.push(`This commit's next version is ${expected}, not ${version}.`);
    }
    try {
      git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
    } catch {
      problems.push("A next build is cut from main; this commit is not on origin/main.");
    }
    return problems;
  }
  const cliVersion = JSON.parse(await readFile("apps/cli/package.json", "utf8")).version;
  if (cliVersion !== version) {
    problems.push(
      `apps/cli/package.json carries ${cliVersion}. Merge the Version Packages pull request, then tag its commit.`,
    );
  }
  const nextTag = newestNextTag(
    git(["tag", "--merged", "HEAD", "--list", "v*-next.*"]).split("\n"),
  );
  problems.push(
    ...promotionProblems({
      nextTag,
      files:
        nextTag === undefined
          ? []
          : git(["diff", "--name-only", `${nextTag}..HEAD`])
              .split("\n")
              .filter(Boolean),
      cliPackageDiff:
        nextTag === undefined
          ? ""
          : git(["diff", "-U0", `${nextTag}..HEAD`, "--", "apps/cli/package.json"]),
    }),
  );
  return problems;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2];
  if (tag === undefined) {
    console.error("usage: node scripts/check-release-pins.mjs <vX.Y.Z tag>");
    process.exit(2);
  }
  const problems = await check(tag);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  const pins = await readRepositoryPins();
  console.log(`${tag}: pins Sealant ${pins.sealantVersion}; every pinned digest matches GHCR.`);
}
