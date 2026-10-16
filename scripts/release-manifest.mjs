#!/usr/bin/env node
/**
 * The release manifest: what one image.yml run built, by digest, and the one CLI tarball it packed.
 * Every consumer reads it from its own run's `release-manifest` artifact.
 *
 *   write <out>                    from the run's digests-*, index-* and cli records (env below)
 *   digest <manifest> <image> <arch>
 *                                  prints that image's platform digest for that arch
 *   archive-digest <archive>       prints an image archive's platform manifest digest
 *   check-archive <manifest> <image> <arch> <archive>
 *                                  refuses the archive unless its platform manifest digest is the
 *                                  manifest's; prints the image IDs it may load as: its config
 *                                  digest (Docker's classic store), then its manifest digest (the
 *                                  containerd image store)
 *   check-cli <manifest> <dir>     refuses <dir> unless it holds exactly the manifest's CLI tarball
 *                                  with its sha512; prints the tarball's path
 *
 * `write` reads VERSION, BEFORE, COMMIT, DIGESTS (a directory of digests-<image>--<arch>/<hex>, as
 * download-artifact lays them out), INDEXES (index-<image>/digest) and CLI (the cli job's
 * {file, sha512, integrity}).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGES = ["mend", "mend-before", "mend-api", "mend-web"];
export const ARCHES = ["amd64", "arm64"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

class Refused extends Error {}

function ensure(condition, message) {
  if (!condition) throw new Refused(message);
}

/** Throws unless `manifest` has the release manifest's shape; returns it. */
export function validateManifest(manifest) {
  ensure(
    typeof manifest?.version === "string" &&
      typeof manifest.before === "string" &&
      /^[0-9a-f]{40}$/.test(manifest.commit ?? ""),
    "The release manifest needs version, before and a 40-hex commit",
  );
  for (const image of IMAGES) {
    const entry = manifest.images?.[image];
    ensure(
      DIGEST.test(entry?.index ?? ""),
      `The release manifest has no index digest for ${image}`,
    );
    for (const arch of ARCHES)
      ensure(
        DIGEST.test(entry.platforms?.[arch] ?? ""),
        `The release manifest has no ${arch} digest for ${image}`,
      );
  }
  const { cli } = manifest;
  ensure(
    /^[a-zA-Z0-9._-]+\.tgz$/.test(cli?.file ?? "") &&
      /^[0-9a-f]{128}$/.test(cli.sha512 ?? "") &&
      cli.integrity === `sha512-${Buffer.from(cli.sha512, "hex").toString("base64")}`,
    "The release manifest's cli entry needs a .tgz file, its sha512 and the matching integrity",
  );
  return manifest;
}

export const readManifest = (file) => validateManifest(JSON.parse(readFileSync(file, "utf8")));

/** The one regular file in `dir`, which must be all it holds. */
function onlyFile(dir, what) {
  const entries = readdirSync(dir, { withFileTypes: true });
  ensure(
    entries.length === 1 && entries[0].isFile(),
    `${what} must hold exactly one file, not ${entries.map((entry) => entry.name).join(", ")}`,
  );
  return entries[0].name;
}

/** The manifest from one run's records. */
export function buildManifest({ version, before, commit, digests, indexes, cli }) {
  const images = Object.fromEntries(
    IMAGES.map((image) => {
      const platforms = Object.fromEntries(
        ARCHES.map((arch) => {
          const hex = onlyFile(path.join(digests, `digests-${image}--${arch}`), `${image} ${arch}`);
          return [arch, `sha256:${hex}`];
        }),
      );
      const directory = path.join(indexes, `index-${image}`);
      ensure(onlyFile(directory, `${image}'s index`) === "digest", `${image}'s index record`);
      const index = readFileSync(path.join(directory, "digest"), "utf8").trim();
      return [image, { index, platforms }];
    }),
  );
  return validateManifest({ version, before, commit, images, cli });
}

/**
 * The named members of an uncompressed tar, read header by header without loading the archive:
 * an image archive is hundreds of megabytes. Names are compared without a leading `./`; pax `path`
 * records and GNU long names are honoured, so a member cannot hide behind either.
 */
export function readTarMembers(file, wanted) {
  const found = new Map();
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const header = Buffer.alloc(512);
    let offset = 0;
    let longName;
    while (offset + 512 <= size) {
      readSync(fd, header, 0, 512, offset);
      if (header.every((byte) => byte === 0)) break;
      const field = (start, length) => {
        const raw = header.subarray(start, start + length);
        const end = raw.indexOf(0);
        return raw.subarray(0, end < 0 ? length : end).toString("utf8");
      };
      const length = Number.parseInt(field(124, 12).trim() || "0", 8);
      ensure(Number.isSafeInteger(length), `${file} is not a tar archive`);
      const type = field(156, 1);
      // POSIX ustar splits a long name into prefix and name; GNU's own format uses those bytes
      // for other fields, and says so with a different magic.
      const posix = header.subarray(257, 263).toString("latin1") === "ustar\0";
      const prefix = posix ? field(345, 155) : "";
      const body = () => {
        const content = Buffer.alloc(length);
        readSync(fd, content, 0, length, offset + 512);
        return content;
      };
      if (type === "x" || type === "L") {
        const content = body().toString("utf8");
        longName =
          type === "L" ? content.split("\0")[0] : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content)?.[1];
      } else if (type !== "g") {
        const raw = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        const name = raw.replace(/^(\.\/)+/, "");
        longName = undefined;
        if (wanted.has(name)) {
          ensure(!found.has(name), `${file} holds ${name} twice`);
          found.set(name, body());
        }
      }
      offset += 512 + Math.ceil(length / 512) * 512;
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

/**
 * An image archive's platform manifest, computed rather than trusted: index.json must name exactly
 * one image manifest, and the blob it names must hash to that digest. Returns the manifest digest
 * and the config digest, which is the image ID Docker loads it as, and the config's architecture.
 */
export function archiveIdentity(archive) {
  const index = readTarMembers(archive, new Set(["index.json"])).get("index.json");
  ensure(index !== undefined, `${archive} has no index.json`);
  const manifests = JSON.parse(index.toString("utf8")).manifests;
  ensure(
    Array.isArray(manifests) && manifests.length === 1,
    `${archive}'s index.json must name one platform manifest`,
  );
  const [descriptor] = manifests;
  ensure(
    MANIFEST_TYPES.has(descriptor.mediaType) && DIGEST.test(descriptor.digest ?? ""),
    `${archive}'s index.json names ${descriptor.mediaType}, not one image manifest`,
  );
  const manifestBlob = `blobs/sha256/${descriptor.digest.slice(7)}`;
  const manifestBytes = readTarMembers(archive, new Set([manifestBlob])).get(manifestBlob);
  ensure(manifestBytes !== undefined, `${archive} lacks the manifest index.json names`);
  ensure(
    sha256(manifestBytes) === descriptor.digest,
    `${archive}'s manifest does not hash to the digest index.json gives it`,
  );
  const config = JSON.parse(manifestBytes.toString("utf8")).config?.digest;
  ensure(DIGEST.test(config ?? ""), `${archive}'s manifest names no config`);
  const configBlob = `blobs/sha256/${config.slice(7)}`;
  const configBytes = readTarMembers(archive, new Set([configBlob])).get(configBlob);
  ensure(
    configBytes !== undefined && sha256(configBytes) === config,
    `${archive}'s config is missing or does not hash to its digest`,
  );
  return {
    platform: descriptor.digest,
    config,
    architecture: JSON.parse(configBytes.toString("utf8")).architecture,
  };
}

/**
 * The IDs Docker may load the archive as, once its platform manifest is the one the release
 * manifest records: the config digest on Docker's classic image store, the manifest digest on the
 * containerd image store. Both are hashes of content checked here.
 */
export function checkArchive(manifest, image, arch, archive) {
  ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
  const expected = manifest.images[image].platforms[arch];
  const identity = archiveIdentity(archive);
  ensure(
    identity.platform === expected,
    `${archive} holds ${identity.platform}; the release manifest records ${expected} for ${image} ${arch}`,
  );
  ensure(
    identity.architecture === arch,
    `${archive} is built for ${identity.architecture}, not ${arch}`,
  );
  return [identity.config, identity.platform];
}

/** The CLI tarball's path, once `dir` holds exactly it and its sha512 is the manifest's. */
export function checkCli(manifest, dir) {
  const file = onlyFile(dir, "The CLI artifact");
  ensure(file === manifest.cli.file, `The CLI artifact holds ${file}, not ${manifest.cli.file}`);
  const tarball = path.resolve(dir, file);
  const sha512 = createHash("sha512").update(readFileSync(tarball)).digest("hex");
  ensure(sha512 === manifest.cli.sha512, `${file}'s sha512 is not the release manifest's`);
  return tarball;
}

function main([command, ...args]) {
  const { env } = process;
  switch (`${command}:${args.length}`) {
    case "write:1": {
      const manifest = buildManifest({
        version: env.VERSION,
        before: env.BEFORE,
        commit: env.COMMIT,
        digests: env.DIGESTS,
        indexes: env.INDEXES,
        cli: JSON.parse(env.CLI ?? "null"),
      });
      writeFileSync(args[0], `${JSON.stringify(manifest, null, 2)}\n`);
      return JSON.stringify(manifest);
    }
    case "digest:3": {
      const [file, image, arch] = args;
      ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
      return readManifest(file).images[image].platforms[arch];
    }
    case "archive-digest:1":
      return archiveIdentity(args[0]).platform;
    case "check-archive:4":
      return checkArchive(readManifest(args[0]), args[1], args[2], args[3]).join(" ");
    case "check-cli:2":
      return checkCli(readManifest(args[0]), args[1]);
    default:
      throw new Refused(
        "usage: release-manifest.mjs write <out> | digest <manifest> <image> <arch> | archive-digest <archive> | check-archive <manifest> <image> <arch> <archive> | check-cli <manifest> <dir>",
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
