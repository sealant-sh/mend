#!/usr/bin/env node
/**
 * The upgrade window of a candidate: the published releases image.yml's previous-upgrade jobs
 * upgrade it from (docs/operations/next-channel.md, "The upgrade window").
 *
 * - A stable candidate X.Y.Z: the highest stable release below it.
 * - A next candidate X.Y.Z-next.N: the newest next build below it, and the highest stable below it.
 * - A candidate that is no release (0.0.0-dryrun.*, 0.0.0-dev.*, 0.0.0-acceptance.*): the window of
 *   the next build main would release now (scripts/next-version.mjs on origin/main).
 *
 * The releases come from npm's own list for @sealant/mend and must agree with the live markers the
 * stable guards read: npm's `latest` and `next`, GitHub's latest release, and ghcr's mend:latest.
 * Every release in the window needs its pins in release/upgrade-from.json; one without them fails
 * the run, by name. A waiver in release/upgrade-waivers.json, for exactly this candidate and that
 * release, records the transition as waived instead of running it: never as passed.
 *
 *   node scripts/upgrade-window.mjs plan <candidate>     # writes the matrix to GITHUB_OUTPUT
 *   node scripts/upgrade-window.mjs notes <candidate>    # the release notes' waiver lines
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareNext, isNextVersion } from "./next-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

class Refused extends Error {}
const ensure = (condition, message) => {
  if (!condition) throw new Refused(message);
};

export const isStable = (version) => STABLE.test(version);
export const isRelease = (version) => isStable(version) || isNextVersion(version);
export const isDerived = (version) => DERIVED.test(version);

/** The highest of `versions` below `candidate` that `keep` accepts, or undefined. */
const highestBelow = (versions, candidate, keep) =>
  versions
    .filter((version) => keep(version) && compareNext(version, candidate) < 0)
    .toSorted((a, b) => compareNext(b, a))[0];

/**
 * The releases a release `candidate` upgrades from, out of the published `versions`, checked
 * against the live `markers` ({ stable: [...], next }): a marker below the candidate must be what
 * npm's list says, or the window cannot be trusted.
 */
export function resolveWindow(candidate, versions, markers) {
  ensure(isRelease(candidate), `${candidate} is not a stable or next release to take a window for`);
  const releases = versions.filter(isRelease);
  const stable = highestBelow(releases, candidate, isStable);
  const window = [];
  if (isNextVersion(candidate)) {
    // A next build older than the highest stable is superseded by it: a server on it upgrades to
    // that stable release first.
    const newest = highestBelow(releases, candidate, isNextVersion);
    const next =
      newest !== undefined && (stable === undefined || compareNext(newest, stable) > 0)
        ? newest
        : undefined;
    if (next !== undefined) window.push(next);
    const marked = markers.next;
    if (next !== undefined && marked !== undefined && compareNext(marked, candidate) < 0)
      ensure(
        marked === next,
        `npm's next is ${marked}, but the newest next below ${candidate} is ${next}`,
      );
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

/** Throws unless `pins` holds a complete, well-formed entry for each release in `window`. */
export function checkPins(pins, window) {
  const missing = window.filter((version) => pins.releases?.[version] === undefined);
  ensure(
    missing.length === 0,
    `release/upgrade-from.json has no pins for ${missing.join(", ")}, inside the upgrade window. Add them in this release's pull request (docs/operations/next-channel.md).`,
  );
  for (const version of window) {
    const entry = pins.releases[version];
    ensure(
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.npm?.integrity ?? ""),
      `${version}: npm.integrity`,
    );
    ensure(
      entry.npm.lockfile === `release/upgrade-from/${version}/package-lock.json`,
      `${version}: npm.lockfile`,
    );
    for (const image of IMAGES)
      ensure(DIGEST.test(entry.images?.[image] ?? ""), `${version}: images.${image}`);
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
      if (response.ok) return await response.json();
      if (attempt === 4) throw new Refused(`${url} answered ${response.status}`);
    } catch (error) {
      if (error instanceof Refused || attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
}

/** npm's list of @sealant/mend versions and the live markers, read anonymously. */
async function readLive() {
  const registry = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org/").replace(
    /\/?$/,
    "/",
  );
  const packument = await getJson(`${registry}@sealant%2fmend`);
  const tags = packument["dist-tags"] ?? {};
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const release = await getJson(
    `${api}/repos/${process.env.GITHUB_REPOSITORY || "sealant-sh/Mend"}/releases/latest`,
    {
      allow404: true,
    },
  );
  const stable = [
    ["npm latest", tags.latest],
    ["GitHub's latest release", release?.tag_name?.replace(/^v/, "")],
  ];
  // ghcr's mend:latest, its version label, as the stable guards read it.
  const owner = process.env.GITHUB_REPOSITORY_OWNER || "sealant-sh";
  try {
    const image = JSON.parse(
      execFileSync(
        "docker",
        [
          "buildx",
          "imagetools",
          "inspect",
          `ghcr.io/${owner}/mend:latest`,
          "--format",
          "{{json .Image}}",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const configs = Object.hasOwn(image, "config") ? [image] : Object.values(image);
    const labels = new Set(
      configs.map((config) => config.config?.Labels?.["org.opencontainers.image.version"]),
    );
    ensure(labels.size === 1, `ghcr.io/${owner}/mend:latest carries ${[...labels].join(", ")}`);
    stable.push([`ghcr.io/${owner}/mend:latest`, [...labels][0]]);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(
      `could not read ghcr.io/${owner}/mend:latest: ${String(error.stderr || error.message).trim()}`,
    );
  }
  for (const [marker, value] of stable)
    ensure(
      value === undefined || isStable(value),
      `${marker} is ${JSON.stringify(value)}, not X.Y.Z`,
    );
  ensure(
    tags.next === undefined || isNextVersion(tags.next),
    `npm next is ${JSON.stringify(tags.next)}`,
  );
  return { versions: Object.keys(packument.versions ?? {}), markers: { stable, next: tags.next } };
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
 * The transitions of `candidate`: its release (main's next build for a derived candidate), that
 * release's window out of `live`, the pins each needs, and the waivers for exactly `candidate`.
 */
export function planFor({ candidate, releaseOfMain, live, pins, waivers }) {
  ensure(
    isRelease(candidate) || isDerived(candidate),
    `${candidate} is not a version this job knows`,
  );
  const release = isDerived(candidate) ? releaseOfMain() : candidate;
  ensure(isRelease(release), `main would release ${release}, not a stable or next version`);
  const window = resolveWindow(release, live.versions, live.markers);
  checkPins(pins, window);
  return { release, transitions: planTransitions(window, waiversFor(waivers, candidate)) };
}

async function plan(candidate) {
  const { release, transitions } = planFor({
    candidate,
    releaseOfMain: nextBuildOfMain,
    live: await readLive(),
    pins: readJson("release/upgrade-from.json"),
    waivers: readJson("release/upgrade-waivers.json"),
  });
  const lines = [
    `### Upgrade window of ${candidate}`,
    "",
    isDerived(candidate)
      ? `${candidate} is no release: the window is that of ${release}, the next build main would release now.`
      : `${candidate} is upgraded from each release below.`,
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
      `transitions=${JSON.stringify(transitions)}\nrelease=${release}\nderived=${isDerived(candidate)}\n`,
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
