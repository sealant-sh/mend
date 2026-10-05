#!/usr/bin/env node
// The first job of a release (.github/workflows/release-cli.yml), before anything builds or
// publishes (docs/adr/0015-next-channel.md):
//
// - Every release: the commit is on main; the Core pins are consistent (sealant-pins.mjs), each
//   pinned digest is what GHCR serves for the pinned Core version, and the bundle's setup assets
//   name that version.
// - A `next` build (vX.Y.Z-next.N): the tag is the version next-version.mjs gives its commit, and
//   no higher next tag exists (npm's `next` only moves forward).
// - A stable release (vX.Y.Z): no prerelease pin; the CLI package carries the version; no next
//   build of X.Y.Z sits on a commit this release leaves out; and the commit promotes the newest
//   next build of X.Y.Z it contains, one that published (npm has it). Since that build only the
//   Version Packages pull request, notes and docs may change, with renames counted as a deletion
//   and an addition.
//
//   node scripts/check-release-pins.mjs v0.36.0-next.56
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  compareCore,
  compareNext,
  isNextVersion,
  nextVersionOf,
  strayBuildsOf,
} from "./next-version.mjs";
import {
  SEMVER,
  assetProblems,
  digestProblems,
  pinProblems,
  readRepositoryPinFiles,
  readRepositoryPins,
} from "./sealant-pins.mjs";

/** The package whose version the tags carry. */
export const RELEASED_PACKAGE = "apps/cli";

/**
 * Paths a stable release may change after the `next` build it promotes. No `package.json` under
 * them: apps/docs and apps/marketing are workspace members, and a lifecycle script added there
 * runs in the image build's `pnpm install`.
 */
export const promotionAllows = (file) =>
  !file.endsWith("package.json") &&
  (file.startsWith(".changeset/") ||
    file.endsWith("/CHANGELOG.md") ||
    file.startsWith("docs/") ||
    file.startsWith("apps/docs/") ||
    file.startsWith("apps/marketing/") ||
    (!file.includes("/") && file.endsWith(".md")));

/** The `+`/`-` lines of a `git diff -U0`, headers left out. */
const changedLines = (diff) =>
  diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));

/**
 * What a stable release changes beyond its promoted `next` build. `files` is
 * `git diff --no-renames --name-only` from the `next` tag. `cliPackageDiff` and `chartDiff` are
 * `git diff -U0` of apps/cli/package.json, which may change only its version, and
 * deploy/helm/mend/Chart.yaml, which may change only `version` and `appVersion`; `chart` is the
 * chart at the release commit, whose `appVersion` must be the release.
 */
export const promotionProblems = ({
  version,
  nextTag,
  files,
  cliPackageDiff,
  chartDiff,
  chart,
}) => {
  if (nextTag === undefined) {
    return [
      `No next build of ${version} precedes this release. Tag v${version}-next.N on main, run it on the box, then release.`,
    ];
  }
  const problems = [];
  const extra = files.filter((file) => {
    if (file === "apps/cli/package.json") {
      return changedLines(cliPackageDiff).some(
        (line) => !/^[+-] {2}"version": "[^"]+",?$/.test(line),
      );
    }
    if (file === "deploy/helm/mend/Chart.yaml") {
      return changedLines(chartDiff).some((line) => !/^[+-](version|appVersion): /.test(line));
    }
    return !promotionAllows(file);
  });
  if (extra.length > 0) {
    problems.push(
      `This release is not a promotion of ${nextTag}: since it, ${extra.length} file(s) changed beyond release notes and docs (${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ", …" : ""}). Tag a new next build of this commit, prove it, then release.`,
    );
  }
  const appVersion = /^appVersion: "?([^"\s]+)"?$/m.exec(chart)?.[1];
  if (appVersion !== version) {
    problems.push(`deploy/helm/mend/Chart.yaml has appVersion ${appVersion}, not ${version}.`);
  }
  return problems;
};

/**
 * Every `-next` package the lockfile resolves. The lockfile is the authority: an alias in any
 * package.json or a pnpm override ends up here, not only the catalog's.
 */
export const lockfilePrereleases = (lockfile) => [
  ...new Set(
    [...lockfile.matchAll(/@sealant\/[a-z0-9-]+-next@[0-9A-Za-z.-]+/g)].map((match) => match[0]),
  ),
];

/** The highest `vX.Y.Z-next.N` tag in `tags`, optionally only those of version X.Y.Z. */
export const newestNextTag = (tags, version) =>
  tags
    .filter((tag) => isNextVersion(tag.replace(/^v/, "")))
    .filter((tag) => version === undefined || compareCore(tag.slice(1), version) === 0)
    .sort((a, b) => compareNext(b.slice(1), a.slice(1)))[0];

/** Whether npm has `@sealant/mend@version`: the last step of a release, so the build published. */
export const published = async (version, fetchImpl = fetch) => {
  const response = await fetchImpl(`https://registry.npmjs.org/@sealant%2fmend/${version}`);
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`npm answered ${response.status} for @sealant/mend@${version}.`);
  return true;
};

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const onMain = () => {
  try {
    git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
    return true;
  } catch {
    return false;
  }
};

const check = async (tag) => {
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) return [`"${tag}" is not a vX.Y.Z release tag.`];
  const stable = !version.includes("-");
  const pins = await readRepositoryPins();
  const problems = [
    ...pinProblems(pins, { stable }),
    ...assetProblems(await readRepositoryPinFiles(), pins.sealantVersion),
    ...(await digestProblems(pins)),
  ];
  if (!onMain()) problems.push("A release is cut from main; this commit is not on origin/main.");
  const allNextTags = git(["tag", "--list", "v*-next.*"]).split("\n");
  if (!stable) {
    if (!isNextVersion(version)) {
      problems.push(`A prerelease is a next build, vX.Y.Z-next.N; "${tag}" is not one.`);
      return problems;
    }
    // Every other next build counts as handed out; the tag being checked does not vouch for itself.
    const handedOut = allNextTags
      .map((other) => other.slice(1))
      .filter((other) => isNextVersion(other) && other !== version);
    const expected = nextVersionOf("HEAD", RELEASED_PACKAGE, handedOut);
    if (version !== expected) {
      problems.push(`This commit's next version is ${expected}, not ${version}.`);
    }
    const newest = newestNextTag(allNextTags);
    if (newest !== undefined && compareNext(newest.slice(1), version) > 0) {
      problems.push(`${newest} already exists; npm's next only moves forward. Tag a newer commit.`);
    }
    return problems;
  }
  const prereleases = lockfilePrereleases(await readFile("pnpm-lock.yaml", "utf8"));
  if (prereleases.length > 0) {
    problems.push(`A stable release cannot ship a prerelease package: ${prereleases.join(", ")}.`);
  }
  const cliVersion = JSON.parse(await readFile("apps/cli/package.json", "utf8")).version;
  if (cliVersion !== version) {
    problems.push(
      `apps/cli/package.json carries ${cliVersion}. Merge the Version Packages pull request, then tag its commit.`,
    );
  }
  for (const build of await strayBuildsOf(version, "HEAD")) {
    problems.push(
      `v${build.version} was built from ${build.commit}, which this release does not contain: a server on it would lose that work by upgrading to ${version}. Release from a commit that contains it.`,
    );
  }
  const nextTag = newestNextTag(
    git(["tag", "--merged", "HEAD", "--list", "v*-next.*"]).split("\n"),
    version,
  );
  if (nextTag !== undefined && !(await published(nextTag.slice(1)))) {
    problems.push(
      `${nextTag} never reached npm, so its release did not finish: it proves nothing. Fix it, tag a new next build, prove it, then release.`,
    );
  }
  const diff = (file) =>
    nextTag === undefined ? "" : git(["diff", "-U0", `${nextTag}..HEAD`, "--", file]);
  problems.push(
    ...promotionProblems({
      version,
      nextTag,
      files:
        nextTag === undefined
          ? []
          : git(["diff", "--no-renames", "--name-only", `${nextTag}..HEAD`])
              .split("\n")
              .filter(Boolean),
      cliPackageDiff: diff("apps/cli/package.json"),
      chartDiff: diff("deploy/helm/mend/Chart.yaml"),
      chart: await readFile("deploy/helm/mend/Chart.yaml", "utf8"),
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
  console.log(
    `${tag}: pins Sealant ${pins.sealantVersion} everywhere; every pinned digest matches GHCR.`,
  );
}
