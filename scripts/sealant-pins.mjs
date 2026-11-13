#!/usr/bin/env node
// Mend's pins of sealant: the SDK and API contract in the pnpm catalog, the three sealant images
// the root Dockerfile copies by digest, and the version the bundle declares in its label, its
// migration log line and its setup assets. They move together, to one sealant version (stable or a
// `next` prerelease, docs/adr/0015-next-channel.md). A prerelease lives under separate names: the
// catalog aliases `@sealant/sdk` to `npm:@sealant/sdk-next@<version>`, and the images come from
// `sealant-api-next` and its siblings. A stable release is the plain names.
//
//   node scripts/sealant-pins.mjs pin 0.39.0-next.12      # rewrite every pin, pnpm install, nix/pnpm-deps.json
//   node scripts/sealant-pins.mjs pin 0.39.0 --no-install
//
// Mend never pins sealantd itself: the bundled worker bakes the sealantd its sealant version pins.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
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
  // Boat's resource gateway: the bundled worker runs it for Boat sessions linked to project
  // resources. sealant's next channel publishes it; its release workflow must too before a stable pin.
  { argument: "MEND_BOAT_GATEWAY_IMAGE", repository: "sealant-sh/sealant-boat-gateway" },
];

/** Production consumers that move with the pinned sealant version and image digests. Tests are not write targets. */
export const PIN_FILES = [
  "Dockerfile",
  "pnpm-workspace.yaml",
  "scripts/bundle-supervisor.mjs",
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
  aliases: [...workspace.matchAll(/npm:@sealant\/[a-z0-9-]+-next@\S+/g)].map((match) => match[0]),
});

/** Where a sealant version's image lives: `sealant-api` for a release, `sealant-api-next` before. */
export const repositoryFor = (repository, version) =>
  version.includes("-") ? `${repository}-next` : repository;

/** The catalog entry for a sealant package at `version`: plain for a release, an alias before. */
export const catalogSpec = (name, version) =>
  version.includes("-") ? `npm:${name}-next@${version}` : version;

/** The digest an image argument pins, when it pins one in the expected repository. */
export const pinnedDigest = (reference, repository) =>
  new RegExp(`^ghcr\\.io/${repository.replace("/", "\\/")}@(sha256:[0-9a-f]{64})$`).exec(
    reference,
  )?.[1];

/**
 * What is wrong with a set of pins. Every release needs them consistent: one exact sealant version
 * everywhere, every image by digest, no preview sealantd. A stable release also needs that version
 * stable: a `-next` (or any prerelease) sealant is refused.
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
    if (pinned !== catalogSpec(name, version)) {
      problems.push(
        `The catalog pins ${name} as ${pinned}; the bundle declares Sealant ${version}, so it must be ${catalogSpec(name, version)}.`,
      );
    }
  }
  for (const { argument, repository } of SEALANT_IMAGES) {
    const expected = repositoryFor(repository, version);
    if (pinnedDigest(pins.images[argument], expected) === undefined) {
      problems.push(`ARG ${argument} must name ghcr.io/${expected}@sha256:<digest>.`);
    }
  }
  if (pins.previewSealantd !== '""') {
    problems.push("ARG MEND_PREVIEW_SEALANTD_IMAGE must stay empty outside a preview build.");
  }
  if (stable && version.includes("-")) {
    problems.push(
      `A stable release cannot pin Sealant ${version}. Release sealant ${version.split("-")[0]} and pin it first.`,
    );
  }
  if (stable && (pins.aliases ?? []).length > 0) {
    problems.push(
      `A stable release cannot depend on a prerelease package: ${pins.aliases.join(", ")}.`,
    );
  }
  return problems;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A reference as a test writes it in a regular expression: `ghcr\.io\/sealant-sh\/…`. */
const asRegExpSource = (text) => text.replaceAll(".", "\\.").replaceAll("/", "\\/");

/**
 * `text` with the old sealant pins replaced by the new ones: each image reference (repository and
 * digest, as written and as a test writes it in a regular expression), the version (as written and
 * as `0\.38\.1`, and only as a whole version: `0.39.0-next.9` never rewrites part of
 * `0.39.0-next.90`), and the two catalog entries.
 */
export const rewritePins = (text, from, to) => {
  let result = text;
  for (const [argument, reference] of Object.entries(from.images)) {
    // An image pinned for the first time has no old reference to find: it fills its empty ARG.
    if (reference === '""') {
      result = result.replace(
        new RegExp(`^ARG ${argument}=""$`, "m"),
        `ARG ${argument}=${to.images[argument]}`,
      );
      continue;
    }
    result = result
      .replaceAll(reference, to.images[argument])
      .replaceAll(asRegExpSource(reference), asRegExpSource(to.images[argument]));
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
  result = result.replace(whole(from.version), to.version);
  for (const name of ["@sealant/sdk", "@sealant/api-contracts"]) {
    result = result.replace(
      new RegExp(`^( {2}"${escapeRegExp(name)}": )\\S+$`, "m"),
      `$1${catalogSpec(name, to.version)}`,
    );
  }
  return result;
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
  for (const { argument, repository: name } of SEALANT_IMAGES) {
    const repository = repositoryFor(name, pins.sealantVersion);
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

/**
 * What the bundle's setup assets and supervisor say about the pinned sealant version: each must name
 * `version` where it names one, so an operator reads the version the image actually carries.
 */
export const assetProblems = (files, version) => {
  const problems = [];
  const expect = (file, ok, what) => {
    if (!ok) problems.push(`${file} does not name Sealant ${version} ${what}.`);
  };
  for (const file of [
    "deploy/docker/setup-contract.v2.json",
    "apps/cli/test-fixtures/docker/setup-contract.v2.json",
  ]) {
    const contract = JSON.parse(files[file]);
    expect(file, contract.sealantVersion === version, "as sealantVersion");
    expect(
      file,
      contract.bootstrap?.sealantMigrations?.endsWith(`from sealant-api ${version}`) === true,
      "in bootstrap.sealantMigrations",
    );
    expect(
      file,
      contract.captureStore?.workspaceNetwork?.includes(`Sealant ${version} runtime`) === true,
      "in captureStore.workspaceNetwork",
    );
  }
  for (const file of [
    "deploy/docker/compose.v2.yaml",
    "apps/cli/test-fixtures/docker/compose.v2.yaml",
  ]) {
    expect(file, files[file].includes(`Sealant ${version} API`), "in its header");
  }
  expect(
    "scripts/bundle-supervisor.mjs",
    files["scripts/bundle-supervisor.mjs"].includes(`applying Sealant ${version} migrations`),
    "in its migration log line",
  );
  return problems;
};

/** Every pin file's text, by path. */
export const readRepositoryPinFiles = async () =>
  Object.fromEntries(
    await Promise.all(
      PIN_FILES.map(async (file) => [file, await readFile(path.join(root, file), "utf8")]),
    ),
  );

export const readRepositoryPins = async () => {
  const [dockerfile, workspace] = await Promise.all([
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  ]);
  return readPins({ dockerfile, workspace });
};

export const NIX_PNPM_DEPS_COMMAND = "nix/update-pnpm-deps.sh";

const onPath = (name, searchPath) =>
  (searchPath ?? "").split(path.delimiter).some((directory) => {
    if (directory === "") return false;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

/**
 * nix/pnpm-deps.json pins the pnpm store's hash for one pnpm-lock.yaml, and the flake refuses to
 * build the CLI once the lockfile moves (nix/package.nix). After a pin moves the lockfile, refresh
 * it with Nix when Nix is here, and otherwise print the command that does.
 */
export const refreshNixPnpmDeps = (
  directory,
  { searchPath = process.env.PATH, log = console.log } = {},
) => {
  const lockfile = createHash("sha256")
    .update(readFileSync(path.join(directory, "pnpm-lock.yaml")))
    .digest("hex");
  const pinned = JSON.parse(readFileSync(path.join(directory, "nix/pnpm-deps.json"), "utf8"));
  if (pinned.lockfile === lockfile) return;
  if (!onPath("nix", searchPath)) {
    log(
      `nix/pnpm-deps.json names an older pnpm-lock.yaml, and nix is not on PATH. On a machine with Nix, run ${NIX_PNPM_DEPS_COMMAND} and commit nix/pnpm-deps.json with this pin.`,
    );
    return;
  }
  execFileSync(path.join(directory, NIX_PNPM_DEPS_COMMAND), [], {
    cwd: directory,
    stdio: "inherit",
    env: { ...process.env, PATH: searchPath },
  });
};

const pin = async (version, { install }) => {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not an exact sealant version.`);
  const current = await readRepositoryPins();
  const from = { version: current.sealantVersion, images: current.images };
  const to = {
    version,
    images: Object.fromEntries(
      await Promise.all(
        SEALANT_IMAGES.map(async ({ argument, repository: name }) => {
          const repository = repositoryFor(name, version);
          return [argument, `ghcr.io/${repository}@${await registryDigest(repository, version)}`];
        }),
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
  for (const { argument } of SEALANT_IMAGES) console.log(`  ${argument} ${to.images[argument]}`);
  if (!install) {
    console.log(
      `After pnpm install, run ${NIX_PNPM_DEPS_COMMAND} and commit nix/pnpm-deps.json with this pin.`,
    );
    return;
  }
  execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
  refreshNixPnpmDeps(root);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, version, ...flags] = process.argv.slice(2);
  if (command !== "pin" || version === undefined) {
    console.error("usage: node scripts/sealant-pins.mjs pin <core-version> [--no-install]");
    process.exit(2);
  }
  await pin(version, { install: !flags.includes("--no-install") });
}
