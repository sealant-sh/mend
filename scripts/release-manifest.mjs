#!/usr/bin/env node
/**
 * The release manifest: what one image.yml run built, by digest, and the one CLI tarball it packed.
 * Every consumer reads it from its own run's `release-manifest` artifact.
 *
 *   write <out>                    from the run's digests-*, index-* and cli records (env below)
 *   archive-digest <archive>       prints an image archive's platform manifest digest
 *   check-archive <manifest> <image> <arch> <archive>
 *                                  refuses the archive unless its platform manifest digest is the
 *                                  manifest's; prints the image IDs it may load as: its config
 *                                  digest (Docker's classic store), then its manifest digest (the
 *                                  containerd image store)
 *   check-cli <manifest> <dir>     refuses <dir> unless it holds exactly the manifest's CLI tarball
 *                                  with its sha512; prints the tarball's path
 *   check-index <metadata> <index> <arch>=<digest>=<source>...
 *                                  refuses the index `imagetools create --metadata-file` reported
 *                                  unless <index> (its raw JSON, read by that digest) holds exactly
 *                                  the given sources, each arch's build under that arch's platform
 *                                  and nowhere else; prints its digest
 *   resolve <manifest> <repository> <image> <arch>
 *                                  reads <repository>@<the image's index> and @<its arch digest>
 *                                  raw, by the digests the manifest records, and prints the digest
 *                                  the index maps that arch's platform to, as a consumer of the
 *                                  index would select it, refusing unless it is that arch's build
 *
 * `write` reads VERSION, BEFORE, COMMIT, DIGESTS (a directory of digests-<image>--<arch>/<hex>, as
 * download-artifact lays them out), INDEXES (index-<image>/digest) and CLI (the cli job's
 * {file, sha512, integrity}).
 */
import { execFileSync } from "node:child_process";
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
const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
/**
 * What each arch's build is, as an index descriptor's platform: os, architecture, and the variants
 * BuildKit writes for it (none for amd64; none or v8 for arm64). Anything else is another platform.
 */
const PLATFORM = {
  amd64: { os: "linux", architecture: "amd64", variants: [undefined] },
  arm64: { os: "linux", architecture: "arm64", variants: [undefined, "v8"] },
};
const platformName = (platform) =>
  [platform?.os, platform?.architecture, platform?.variant].filter(Boolean).join("/") ||
  "no platform";
/** The arch whose build a descriptor's platform names, or undefined for any other platform. */
const archOf = (platform) =>
  ARCHES.find(
    (arch) =>
      platform?.os === PLATFORM[arch].os &&
      platform?.architecture === PLATFORM[arch].architecture &&
      PLATFORM[arch].variants.includes(platform?.variant || undefined),
  );

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

/** Annotated as BuildKit annotates the attestation it adds beside a platform manifest. */
const annotatedAttestation = (descriptor) =>
  descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";
/**
 * An attestation, which no platform resolution selects: annotated as one, and for no runnable
 * platform (BuildKit writes unknown/unknown). The annotation alone excludes nothing: containerd's
 * platform resolver does not read it, and takes the first descriptor whose platform matches.
 */
const isAttestation = (descriptor) =>
  annotatedAttestation(descriptor) &&
  descriptor.platform?.os === "unknown" &&
  descriptor.platform?.architecture === "unknown";

/** A registry document read by digest (`imagetools inspect …@<digest> --raw`): it must hash to it. */
function document(bytes, digest, what) {
  ensure(DIGEST.test(digest), `${what}: ${digest} is not a sha256 digest`);
  ensure(sha256(bytes) === digest, `${what} does not hash to ${digest}`);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const mediaType = parsed.mediaType;
  ensure(
    MANIFEST_TYPES.has(mediaType) || INDEX_TYPES.has(mediaType),
    `${what} is ${mediaType}, not an image manifest or index`,
  );
  return { ...parsed, index: INDEX_TYPES.has(mediaType) };
}

/**
 * The index's runnable descriptors for each arch, in the index's order. Every descriptor that is not
 * an attestation counts toward a platform, whatever its annotations: an attestation annotation on a
 * descriptor for a runnable platform is refused, any platform but the builds' is refused, and so is
 * a digest the index lists twice. The first of an arch's entries is the one containerd would select.
 */
function platformEntries(index, digest) {
  for (const descriptor of index.manifests)
    ensure(
      isAttestation(descriptor) || !annotatedAttestation(descriptor),
      `The index ${digest} has ${descriptor.digest} annotated as an attestation for ${platformName(descriptor.platform)}, a platform a consumer can select`,
    );
  const counted = new Map();
  for (const descriptor of index.manifests)
    counted.set(descriptor.digest, (counted.get(descriptor.digest) ?? 0) + 1);
  for (const [listed, times] of counted)
    ensure(times === 1, `The index ${digest} lists ${listed} ${times} times`);
  const entries = Object.fromEntries(ARCHES.map((arch) => [arch, []]));
  for (const descriptor of index.manifests.filter((entry) => !isAttestation(entry))) {
    const arch = archOf(descriptor.platform);
    ensure(
      arch !== undefined,
      `The index ${digest} holds ${platformName(descriptor.platform)} (${descriptor.digest}), not ${ARCHES.map((name) => `linux/${name}`).join(" or ")}`,
    );
    entries[arch].push(descriptor);
  }
  return entries;
}

/**
 * The runnable manifest one arch's build job pushed as <digest>: the document itself when it is an
 * image manifest, or the one runnable child of a single-platform index, which BuildKit pushes when
 * it adds an attestation (Mend's builds do: build-push-action's default provenance).
 */
function buildOf(parsed, digest, arch) {
  if (!parsed.index) return digest;
  const runnable = parsed.manifests.filter((descriptor) => !isAttestation(descriptor));
  ensure(
    runnable.length === 1,
    `The ${arch} source ${digest} is an index of more than one platform`,
  );
  return runnable[0].digest;
}

/**
 * The digest `imagetools create` reported for the index it pushed, once that index is the one this
 * job asked for. The tag it pushed can move before anything reads it again, so the digest comes
 * from create's own metadata and the index is read by that digest. Each source is one arch's build,
 * named by the arch its build job recorded: a plain image manifest, or a single-platform index (an
 * attested build) whose one runnable child is the build. The index must map each arch's platform to
 * that arch's build and to nothing else, hold every source's children (attestations too), and hold
 * nothing more. A platform label swapped between two descriptors, a platform listed twice or
 * missing, a variant the build does not have, a digest listed twice, and an attestation annotation
 * on a descriptor for a runnable platform are each refused: only an annotated unknown/unknown
 * descriptor is an attestation (isAttestation).
 */
export function checkIndex(metadata, indexBytes, sources) {
  const reported = [
    metadata["containerimage.digest"],
    metadata["containerimage.descriptor"]?.digest,
  ].filter((value) => value !== undefined);
  ensure(
    reported.length > 0 && reported.every((value) => value === reported[0]),
    "imagetools create reported no index digest, or two different ones",
  );
  const [digest] = reported;
  const index = document(indexBytes, digest, "The created index");
  ensure(index.index, `The created ${digest} is a single image manifest, not a multi-arch index`);
  ensure(
    sources.length === ARCHES.length &&
      ARCHES.every((arch) => sources.filter((source) => source.arch === arch).length === 1),
    `check-index needs exactly one source per arch (${ARCHES.join(", ")}), not ${sources.map(({ arch }) => arch).join(", ") || "none"}`,
  );
  const entries = platformEntries(index, digest);
  // platformEntries refused any digest listed twice, so each descriptor is counted once here.
  const children = new Set(index.manifests.map((descriptor) => descriptor.digest));
  const expected = new Set();
  for (const { arch, digest: source, bytes } of sources) {
    const parsed = document(bytes, source, `The ${arch} source ${source}`);
    const build = buildOf(parsed, source, arch);
    ensure(
      entries[arch].length === 1,
      `The created index has ${entries[arch].length} linux/${arch} entries (${entries[arch].map((entry) => entry.digest).join(", ") || "none"}), not one`,
    );
    ensure(
      entries[arch][0].digest === build,
      `The created index maps linux/${arch} to ${entries[arch][0].digest}, not ${build}, the ${arch} build`,
    );
    const wanted = parsed.index
      ? parsed.manifests.map((descriptor) => descriptor.digest)
      : [source];
    for (const child of wanted) {
      ensure(
        children.has(child),
        `The created index lacks ${child}, from the ${arch} source ${source}`,
      );
      expected.add(child);
    }
  }
  const extra = [...children].filter((child) => !expected.has(child));
  ensure(extra.length === 0, `The created index holds ${extra.join(", ")}, from no source`);
  return digest;
}

/**
 * The digest the index <bytes>, read by <digest>, maps <arch>'s platform to: what a consumer pulling
 * the index for that platform gets. containerd takes the first descriptor whose platform matches,
 * annotations aside; exactly one may match (platformEntries refuses the rest), so the first is the
 * only one and it is the one the binding checked.
 */
export function selectPlatform(bytes, digest, arch) {
  ensure(ARCHES.includes(arch), `No build for ${arch}`);
  const index = document(bytes, digest, `The index ${digest}`);
  ensure(index.index, `${digest} is a single image manifest, not a multi-arch index`);
  const entries = platformEntries(index, digest)[arch];
  ensure(
    entries.length === 1,
    `The index ${digest} has ${entries.length} linux/${arch} entries, not one`,
  );
  return entries[0].digest;
}

/**
 * The digest a consumer of <image>'s index gets for <arch>, once it is that arch's build. `read`
 * answers a document's raw bytes by its digest. The index the manifest records, read by its digest,
 * must map the arch's platform to the build the manifest records for the arch (its build job's
 * digest, read by that digest: the runnable manifest itself, or an attested build's one runnable
 * child). merge's check bound the two; this binds them again on the index a later job reads.
 */
export function resolvePlatform(manifest, image, arch, read) {
  ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
  const { index, platforms } = manifest.images[image];
  const mapped = selectPlatform(read(index), index, arch);
  const source = platforms[arch];
  const build = buildOf(
    document(read(source), source, `The ${arch} build ${source}`),
    source,
    arch,
  );
  ensure(
    mapped === build,
    `The index ${index} maps linux/${arch} to ${mapped}, not ${build}, the ${arch} build the release manifest records for ${image}${build === source ? "" : ` (in ${source})`}`,
  );
  return mapped;
}

/** A registry document's raw bytes, read by digest; a failed read is refused, never guessed. */
const registryReader = (repository) => (digest) => {
  const reference = `${repository}@${digest}`;
  try {
    return execFileSync("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    throw new Refused(`Could not read ${reference}`);
  }
};

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
    case "archive-digest:1":
      return archiveIdentity(args[0]).platform;
    case "check-archive:4":
      return checkArchive(readManifest(args[0]), args[1], args[2], args[3]).join(" ");
    case "check-cli:2":
      return checkCli(readManifest(args[0]), args[1]);
    case "resolve:4": {
      const [file, repository, image, arch] = args;
      return resolvePlatform(readManifest(file), image, arch, registryReader(repository));
    }
    default:
      if (command === "check-index" && args.length >= 3) {
        const [metadata, index, ...given] = args;
        const sources = given.map((entry) => {
          const [arch, digest, file] = entry.split("=");
          ensure(
            ARCHES.includes(arch) && file !== undefined && entry.split("=").length === 3,
            `${entry} is not <arch>=<digest>=<file>`,
          );
          return { arch, digest, bytes: readFileSync(file) };
        });
        return checkIndex(JSON.parse(readFileSync(metadata, "utf8")), readFileSync(index), sources);
      }
      throw new Refused(
        "usage: release-manifest.mjs write <out> | archive-digest <archive> | check-archive <manifest> <image> <arch> <archive> | check-cli <manifest> <dir> | resolve <manifest> <repository> <image> <arch> | check-index <metadata> <index> <arch>=<digest>=<source>...",
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
