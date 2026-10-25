#!/usr/bin/env node
/**
 * The upgrade window of a candidate: the published releases image.yml's previous-upgrade jobs
 * upgrade it from (docs/operations/next-channel.md, "The upgrade window").
 *
 * - A stable candidate X.Y.Z: the highest stable release below it.
 * - A next candidate X.Y.Z-next.N: the newest next build below it, unless the highest stable below
 *   it supersedes it, and that stable release.
 * - A dry run, X.Y.Z-next.N.dryrun.<run>.<attempt>: the window of X.Y.Z-next.N, with next.N itself
 *   when it is published (the stamp sorts above it).
 * - A dev or acceptance build, 0.0.0-*: the window of the next build main would release now
 *   (scripts/next-version.mjs on origin/main). It orders below every release, so its upgrade is
 *   reported as not tested.
 *
 * The releases come from npm's own list for @sealant/mend and must agree with the live markers,
 * read as the stable guards read them: npm's `latest` and `next`, GitHub's latest release, and the
 * version label of ghcr's mend, mend-api and mend-web :latest. A marker that does not exist adds
 * nothing; one that answers in the wrong shape fails the run. Every stable release in the window
 * needs its pins in release/upgrade-from.json; a next build's are read live by the job. A waiver in
 * release/upgrade-waivers.json, for exactly this candidate and that release, records the
 * transition as waived instead of running it: never as passed.
 *
 *   node scripts/upgrade-window.mjs plan <candidate>     # writes the matrix to GITHUB_OUTPUT
 *   node scripts/upgrade-window.mjs notes <candidate>    # the release notes' waiver lines
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareNext, isNextVersion } from "./next-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Each part has at most 9 digits, as the stable guards read versions.
const PART = "(0|[1-9][0-9]{0,8})";
const STABLE = new RegExp(`^${PART}\\.${PART}\\.${PART}$`);
const NEXT = new RegExp(`^${PART}\\.${PART}\\.${PART}-next\\.${PART}$`);
const DRY_RUN = new RegExp(
  `^(${PART}\\.${PART}\\.${PART}-next\\.${PART})\\.dryrun\\.[1-9][0-9]*\\.[1-9][0-9]*$`,
);
const DERIVED = /^0\.0\.0-(dryrun|dev|acceptance)\./;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
export const ASSETS = [
  "compose.v2.yaml",
  "setup-contract.v2.json",
  "install.sh",
  "postgres-init.sh",
];
export const IMAGES = ["mend", "mend-api", "mend-web"];
const DIGEST_IMAGES = ["mend"];

class Refused extends Error {}
const ensure = (condition, message) => {
  if (!condition) throw new Refused(message);
};

export const isStable = (version) => STABLE.test(version);
export const isRelease = (version) => isStable(version) || isNextVersion(version);
export const isDerived = (version) => DERIVED.test(version);

/** The highest of `versions` below `candidate` (or at it, when `inclusive`) that `keep` accepts. */
const highestBelow = (versions, candidate, keep, inclusive) =>
  versions
    .filter((version) => keep(version) && compareNext(version, candidate) < (inclusive ? 1 : 0))
    .toSorted((a, b) => compareNext(b, a))[0];

/**
 * The releases a release `candidate` upgrades from, out of the published `versions`, checked
 * against the live `markers` ({ stable: [...], next }): a marker inside the window must be what
 * npm's list says, or the window cannot be trusted. With `inclusive`, the candidate itself counts
 * as below (a dry run's stamp sorts above its next build).
 */
export function resolveWindow(candidate, versions, markers, { inclusive = false } = {}) {
  ensure(isRelease(candidate), `${candidate} is not a stable or next release to take a window for`);
  const below = (version) => compareNext(version, candidate) < (inclusive ? 1 : 0);
  const releases = versions.filter(isRelease);
  const stable = highestBelow(releases, candidate, isStable, inclusive && isStable(candidate));
  const window = [];
  if (isNextVersion(candidate)) {
    // A next build older than the highest stable is superseded by it: a server on it upgrades to
    // that stable release first.
    const newest = highestBelow(releases, candidate, isNextVersion, inclusive);
    const supersedes = (version) => stable !== undefined && compareNext(version, stable) < 0;
    const next = newest !== undefined && !supersedes(newest) ? newest : undefined;
    if (next !== undefined) window.push(next);
    // npm's next, when it is inside the window, is checked on its own: it must be in the list
    // and be the next build chosen, or a leg would go missing silently.
    const marked = markers.next;
    if (marked !== undefined && below(marked) && !supersedes(marked)) {
      ensure(releases.includes(marked), `npm's next is ${marked}, which npm's version list lacks`);
      ensure(
        marked === next,
        `npm's next is ${marked}, but the newest next below ${candidate} is ${next}`,
      );
    }
  }
  if (stable !== undefined) window.push(stable);
  for (const [marker, value] of markers.stable ?? [])
    if (value !== undefined && compareNext(value, candidate) < 0)
      ensure(
        value === stable,
        `${marker} is ${value}, but the highest stable release below ${candidate} is ${stable}`,
      );
  ensure(window.length > 0, `${candidate} has no published release to upgrade from`);
  return window;
}

/**
 * Throws unless `pins` holds a complete, well-formed entry for each stable release in `window`. A
 * next build's pins are read live by scripts/check-previous-upgrade.mjs.
 */
export function checkPins(pins, window) {
  const stable = window.filter(isStable);
  const missing = stable.filter((version) => pins.releases?.[version] === undefined);
  ensure(
    missing.length === 0,
    `release/upgrade-from.json has no pins for ${missing.join(", ")}, inside the upgrade window. A published stable release needs its pins in the first pull request to main after it (docs/operations/next-channel.md).`,
  );
  for (const version of stable) {
    const entry = pins.releases[version];
    ensure(
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.npm?.integrity ?? ""),
      `${version}: npm.integrity`,
    );
    ensure(Number.isFinite(Date.parse(entry.publishedAt)), `${version}: publishedAt`);
    ensure(
      entry.npm.lockfile === `release/upgrade-from/${version}/package-lock.json`,
      `${version}: npm.lockfile`,
    );
    ensure(
      JSON.stringify(Object.keys(entry.images ?? {})) === JSON.stringify(DIGEST_IMAGES) &&
        DIGEST.test(entry.images.mend),
      `${version}: images holds the mend digest alone`,
    );
    for (const asset of ASSETS)
      ensure(HEX.test(entry.assets?.[asset] ?? ""), `${version}: assets.${asset}`);
    const support = Object.entries(entry.support ?? {});
    ensure(support.length > 0, `${version}: support images`);
    for (const [reference, pinned] of support)
      ensure(/^[\w./-]+@sha256:[0-9a-f]{64}$/.test(pinned), `${version}: support ${reference}`);
  }
}

/**
 * The waivers for exactly `candidate`, by the release they waive. A waiver names one candidate
 * version and one release; one for an earlier candidate does not carry forward.
 */
export function waiversFor(waivers, candidate) {
  ensure(Array.isArray(waivers), "release/upgrade-waivers.json must be a list");
  const found = new Map();
  for (const waiver of waivers) {
    ensure(
      ["version", "from", "reason", "approvedBy"].every(
        (field) => typeof waiver?.[field] === "string" && waiver[field].trim() !== "",
      ),
      `a waiver needs version, from, reason and approvedBy: ${JSON.stringify(waiver)}`,
    );
    if (waiver.version !== candidate) continue;
    ensure(!found.has(waiver.from), `two waivers for ${candidate} from ${waiver.from}`);
    found.set(waiver.from, waiver);
  }
  return found;
}

/** The matrix of transitions: each release, and whether a waiver stands in for running it. */
export function planTransitions(window, waivers) {
  return window.map((from) => {
    const waiver = waivers.get(from);
    return waiver === undefined
      ? { from, waived: "" }
      : { from, waived: `${waiver.reason} (approved by ${waiver.approvedBy})` };
  });
}

/** The release notes' lines for a stable candidate's waived upgrades from a stable release. */
export function waiverNotes(waivers, candidate) {
  if (!isStable(candidate)) return "";
  const lines = [...waiversFor(waivers, candidate).values()]
    .filter((waiver) => isStable(waiver.from))
    .map(
      (waiver) =>
        `- The upgrade from ${waiver.from} was not tested: ${waiver.reason} (waiver approved by ${waiver.approvedBy}).`,
    );
  return lines.length === 0 ? "" : `**Upgrade testing waived**\n\n${lines.join("\n")}\n`;
}

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

async function getJson(url, { allow404 = false } = {}) {
  const headers = { accept: "application/json" };
  if (url.startsWith("https://api.github.com/") && process.env.GH_TOKEN)
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (allow404 && response.status === 404) return undefined;
      if (response.ok) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Refused(`${url} answered something that is not JSON`);
        }
      }
      if (attempt === 4) throw new Refused(`${url} answered ${response.status}`);
    } catch (error) {
      if (error instanceof Refused || attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The version label every platform of `ref` carries, or undefined when the registry says `ref`
 * does not exist: buildx's not-found line and nothing else. Anything else that is not one plain
 * X.Y.Z on every platform fails.
 */
export function imageLabel(ref, { status, stdout, stderr }) {
  if (status !== 0) {
    ensure(
      stdout === "" && stderr.replace(/\n+$/, "") === `ERROR: ${ref}: not found`,
      `could not read ${ref}: ${stderr.trim()}`,
    );
    return undefined;
  }
  let image;
  try {
    image = JSON.parse(stdout);
  } catch {
    throw new Refused(`${ref} answered an image config that is not JSON`);
  }
  ensure(isObject(image), `${ref} answered no image config`);
  const configs = Object.hasOwn(image, "config") ? [image] : Object.values(image);
  ensure(configs.length > 0, `${ref} answered no platform`);
  const labels = configs.map(
    (config) => config?.config?.Labels?.["org.opencontainers.image.version"],
  );
  ensure(
    labels.every((label) => typeof label === "string" && STABLE.test(label) && label === labels[0]),
    `${ref} carries no single plain X.Y.Z version label (${labels.map((label) => JSON.stringify(label ?? null)).join(", ")})`,
  );
  return labels[0];
}

/** npm's `latest` and `next` from the package's dist-tags; a missing tag is absent. */
export function npmMarkers(packument) {
  ensure(isObject(packument), "npm's @sealant/mend record is not a JSON object");
  ensure(isObject(packument.versions), "npm's @sealant/mend record has no versions");
  const tags = packument["dist-tags"];
  ensure(isObject(tags), "npm's @sealant/mend dist-tags is not a JSON object");
  const read = (tag, shape) => {
    if (!Object.hasOwn(tags, tag)) return undefined;
    ensure(
      typeof tags[tag] === "string" && shape.test(tags[tag]),
      `npm's ${tag} is ${JSON.stringify(tags[tag])}`,
    );
    return tags[tag];
  };
  return {
    latest: read("latest", STABLE),
    next: read("next", NEXT),
    versions: Object.keys(packument.versions),
  };
}

/** GitHub's latest release tag as X.Y.Z, or undefined when there is none (a 404). */
export function githubLatest(release) {
  if (release === undefined) return undefined;
  const tag = isObject(release) ? release.tag_name : undefined;
  ensure(
    typeof tag === "string" && tag.startsWith("v") && STABLE.test(tag.slice(1)),
    `GitHub's latest release is tagged ${JSON.stringify(tag)}, not vX.Y.Z`,
  );
  return tag.slice(1);
}

/** npm's list of @sealant/mend versions and the live markers, read anonymously. */
async function readLive() {
  const registry = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org/").replace(
    /\/?$/,
    "/",
  );
  const npm = npmMarkers(await getJson(`${registry}@sealant%2fmend`));
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const repository = process.env.GITHUB_REPOSITORY || "sealant-sh/Mend";
  const stable = [
    ["npm latest", npm.latest],
    [
      "GitHub's latest release",
      githubLatest(await getJson(`${api}/repos/${repository}/releases/latest`, { allow404: true })),
    ],
  ];
  const owner = process.env.GITHUB_REPOSITORY_OWNER || "sealant-sh";
  for (const image of IMAGES) {
    const ref = `ghcr.io/${owner}/${image}:latest`;
    const read = spawnSync(
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"],
      {
        encoding: "utf8",
      },
    );
    ensure(read.error === undefined, `could not run docker to read ${ref}: ${read.error?.message}`);
    stable.push([
      ref,
      imageLabel(ref, { status: read.status, stdout: read.stdout, stderr: read.stderr }),
    ]);
  }
  return { versions: npm.versions, markers: { stable, next: npm.next } };
}

/** The release a derived candidate stands for: the next build main would release now. */
const nextBuildOfMain = () =>
  execFileSync(
    "node",
    [path.join(root, "scripts/next-version.mjs"), "--package", "apps/cli", "origin/main"],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();

/**
 * The transitions of `candidate`: the release whose window it takes (its own; a dry run's next
 * build; main's next build for a dev or acceptance build), that window out of `live`, the pins each
 * stable release in it needs, and the waivers for exactly `candidate`. `derived` is true when the
 * candidate orders below the window and cannot be upgraded to.
 */
export function planFor({ candidate, releaseOfMain, live, pins, waivers }) {
  const stamp = DRY_RUN.exec(candidate);
  ensure(
    isRelease(candidate) || stamp !== null || isDerived(candidate),
    `${candidate} is not a version this job knows`,
  );
  const derived = stamp === null && isDerived(candidate);
  const release = stamp !== null ? stamp[1] : derived ? releaseOfMain() : candidate;
  ensure(isRelease(release), `main would release ${release}, not a stable or next version`);
  const window = resolveWindow(release, live.versions, live.markers, { inclusive: stamp !== null });
  checkPins(pins, window);
  return { release, derived, transitions: planTransitions(window, waiversFor(waivers, candidate)) };
}

async function plan(candidate) {
  const { release, derived, transitions } = planFor({
    candidate,
    releaseOfMain: nextBuildOfMain,
    live: await readLive(),
    pins: readJson("release/upgrade-from.json"),
    waivers: readJson("release/upgrade-waivers.json"),
  });
  const lines = [
    `### Upgrade window of ${candidate}`,
    "",
    derived
      ? `${candidate} is no release: the window is that of ${release}, the next build main would release now; the upgrade itself is not tested, since ${candidate} orders below it.`
      : release === candidate
        ? `${candidate} is upgraded from each release below.`
        : `${candidate} is a dry run of ${release}: it is upgraded from each release below.`,
    "",
    ...transitions.map(({ from, waived }) =>
      waived ? `- from ${from}: **waived**: ${waived}` : `- from ${from}: runs`,
    ),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `transitions=${JSON.stringify(transitions)}\nrelease=${release}\nderived=${derived}\n`,
    );
}

async function main([command, candidate, ...rest]) {
  ensure(
    candidate !== undefined && rest.length === 0,
    "usage: upgrade-window.mjs plan|notes <candidate>",
  );
  if (command === "plan") return plan(candidate);
  if (command === "notes")
    return process.stdout.write(waiverNotes(readJson("release/upgrade-waivers.json"), candidate));
  throw new Refused(`unknown command ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
