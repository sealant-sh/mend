#!/usr/bin/env node
// Mend's pins of Sealant Core: the SDK and API contract in the pnpm catalog, the three Core images
// the root Dockerfile copies by digest, and the version the bundle declares in its label, its
// migration log line and its setup assets. They move together, to one Core version (stable or a
// `next` prerelease, docs/adr/0015-next-channel.md):
//
//   node scripts/sealant-pins.mjs pin 0.39.0-next.12      # rewrite every pin, then pnpm install
//   node scripts/sealant-pins.mjs pin 0.39.0 --no-install
//
// Mend never pins sealantd itself: the bundled worker bakes the sealantd its Core version pins.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const SEALANT_IMAGES = [
  { argument: "SEALANT_API_IMAGE", repository: "sealant-sh/sealant-api" },
  { argument: "SEALANT_WORKER_IMAGE", repository: "sealant-sh/sealant-worker" },
  { argument: "SEALANT_SSH_GATEWAY_IMAGE", repository: "sealant-sh/sealant-ssh-gateway" },
];

/** Every file that names the pinned Core version or one of its image digests. */
export const PIN_FILES = [
  "Dockerfile",
  "pnpm-workspace.yaml",
  "scripts/bundle-supervisor.mjs",
  "scripts/bundle-packaging.test.mjs",
  "deploy/docker/compose.v2.yaml",
  "deploy/docker/setup-contract.v2.json",
  "apps/cli/test-fixtures/docker/compose.v2.yaml",
  "apps/cli/test-fixtures/docker/setup-contract.v2.json",
];

const one = (text, pattern, what) => {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${what}, found ${matches.length}.`);
  return matches[0];
};

/** What the Dockerfile and the catalog pin today. */
export const readPins = ({ dockerfile, workspace }) => ({
  sealantVersion: one(
    dockerfile,
    /dev\.sealant\.mend\.sealant-version="([^"]*)"/,
    "Sealant label",
  )[1],
  sdk: one(workspace, /^ {2}"@sealant\/sdk": (\S+)$/m, "@sealant/sdk catalog entry")[1],
  apiContracts: one(
    workspace,
    /^ {2}"@sealant\/api-contracts": (\S+)$/m,
    "@sealant/api-contracts catalog entry",
  )[1],
  images: Object.fromEntries(
    SEALANT_IMAGES.map(({ argument }) => [
      argument,
      one(dockerfile, new RegExp(`^ARG ${argument}=(.*)$`, "m"), `ARG ${argument}`)[1],
    ]),
  ),
  previewSealantd: one(
    dockerfile,
    /^ARG MEND_PREVIEW_SEALANTD_IMAGE=(.*)$/m,
    "preview sealantd",
  )[1],
});

/** The digest an image argument pins, when it pins one in the expected repository. */
export const pinnedDigest = (reference, repository) =>
  new RegExp(`^ghcr\\.io/${repository.replace("/", "\\/")}@(sha256:[0-9a-f]{64})$`).exec(
    reference,
  )?.[1];

/**
 * What is wrong with a set of pins. Every release needs them consistent: one exact Core version
 * everywhere, every image by digest, no preview sealantd. A stable release also needs that version
 * stable: a `-next` (or any prerelease) Core is refused.
 */
export const pinProblems = (pins, { stable }) => {
  const problems = [];
  const version = pins.sealantVersion;
  if (!SEMVER.test(version))
    problems.push(`The Sealant label "${version}" is not an exact version.`);
  for (const [name, pinned] of [
    ["@sealant/sdk", pins.sdk],
    ["@sealant/api-contracts", pins.apiContracts],
  ]) {
    if (pinned !== version) {
      problems.push(`The catalog pins ${name} ${pinned}; the bundle declares Sealant ${version}.`);
    }
  }
  for (const { argument, repository } of SEALANT_IMAGES) {
    if (pinnedDigest(pins.images[argument], repository) === undefined) {
      problems.push(`ARG ${argument} must name ghcr.io/${repository}@sha256:<digest>.`);
    }
  }
  if (pins.previewSealantd !== '""') {
    problems.push("ARG MEND_PREVIEW_SEALANTD_IMAGE must stay empty outside a preview build.");
  }
  if (stable && version.includes("-")) {
    problems.push(
      `A stable release cannot pin Sealant ${version}. Release Core ${version.split("-")[0]} and pin it first.`,
    );
  }
  return problems;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with the old Core version and digests replaced by the new ones. The version is replaced as
 * written and as a test writes it in a regular expression (`0\.38\.1`), and only as a whole version:
 * `0.39.0-next.9` never rewrites part of `0.39.0-next.90`.
 */
export const rewritePins = (text, from, to) => {
  let result = text;
  for (const [argument, digest] of Object.entries(from.digests)) {
    result = result.replaceAll(digest, to.digests[argument]);
  }
  const whole = (literal) =>
    new RegExp(
      `(?<![0-9A-Za-z.\\\\-])${escapeRegExp(literal)}(?![0-9A-Za-z-]|\\\\?\\.[0-9A-Za-z])`,
      "g",
    );
  result = result.replace(
    whole(from.version.replaceAll(".", "\\.")),
    to.version.replaceAll(".", "\\."),
  );
  return result.replace(whole(from.version), to.version);
};

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The digest GHCR serves for `repository:tag`, read anonymously, as anyone pulling it would. */
export const registryDigest = async (repository, tag, fetchImpl = fetch) => {
  const token = await fetchImpl(`https://ghcr.io/token?scope=repository:${repository}:pull`);
  if (!token.ok) throw new Error(`GHCR refused a pull token for ${repository}: ${token.status}.`);
  const { token: bearer } = await token.json();
  const manifest = await fetchImpl(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_TYPES },
  });
  if (!manifest.ok) {
    throw new Error(`ghcr.io/${repository}:${tag} is not published (HTTP ${manifest.status}).`);
  }
  const digest = manifest.headers.get("docker-content-digest");
  if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`ghcr.io/${repository}:${tag} came back without a digest.`);
  }
  return digest;
};

/** Problems with the pinned digests: each must be what GHCR serves for the pinned version's tag. */
export const digestProblems = async (pins, fetchImpl = fetch) => {
  const problems = [];
  for (const { argument, repository } of SEALANT_IMAGES) {
    const pinned = pinnedDigest(pins.images[argument], repository);
    if (pinned === undefined) continue;
    try {
      const published = await registryDigest(repository, pins.sealantVersion, fetchImpl);
      if (published !== pinned) {
        problems.push(
          `ARG ${argument} pins ${pinned}, but ghcr.io/${repository}:${pins.sealantVersion} is ${published}.`,
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
};

export const readRepositoryPins = async () => {
  const [dockerfile, workspace] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  ]);
  return readPins({ dockerfile, workspace });
};

const pin = async (version, { install }) => {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not an exact Core version.`);
  const current = await readRepositoryPins();
  const from = {
    version: current.sealantVersion,
    digests: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => {
        const digest = pinnedDigest(current.images[argument], repository);
        if (digest === undefined) throw new Error(`ARG ${argument} does not pin a digest today.`);
        return [argument, digest];
      }),
    ),
  };
  const to = {
    version,
    digests: Object.fromEntries(
      await Promise.all(
        SEALANT_IMAGES.map(async ({ argument, repository }) => [
          argument,
          await registryDigest(repository, version),
        ]),
      ),
    ),
  };
  for (const file of PIN_FILES) {
    const absolute = path.join(root, file);
    const before = await readFile(absolute, "utf8");
    const after = rewritePins(before, from, to);
    if (after !== before) await writeFile(absolute, after);
  }
  const problems = pinProblems(await readRepositoryPins(), { stable: false });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(`Sealant ${from.version} → ${version}`);
  for (const { argument } of SEALANT_IMAGES) console.log(`  ${argument} ${to.digests[argument]}`);
  if (install) execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, version, ...flags] = process.argv.slice(2);
  if (command !== "pin" || version === undefined) {
    console.error("usage: node scripts/sealant-pins.mjs pin <core-version> [--no-install]");
    process.exit(2);
  }
  await pin(version, { install: !flags.includes("--no-install") });
}
