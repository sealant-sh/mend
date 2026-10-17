// Registry documents for the release's index binding (scripts/release-manifest.mjs): image
// manifests, the single-platform index Mend's build job pushes for each arch (the image and the
// attestation BuildKit adds), the multi-arch index imagetools create makes of the two, and every
// index the binding must refuse. The shapes are registry:2's and ghcr's: what
// `imagetools inspect --raw` answers for a release's index (ghcr.io/sealant-sh/mend:latest,
// read 2026-10-17), key order included.
import { createHash } from "node:crypto";

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const ARCHES = ["amd64", "arm64"];

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A registry document: its bytes and the digest it is read by. */
export const doc = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: sha256(bytes), value };
};

/** An image manifest; `seed` makes it a different image. */
export const imageManifest = (seed) =>
  doc({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: sha256(`config of ${seed}`),
      size: 4493,
    },
    layers: [],
  });

/** An index's descriptor of `manifest` for os/architecture[/variant]. */
export const childOf = (manifest, os, architecture, variant) => ({
  mediaType: OCI_MANIFEST,
  digest: manifest.digest,
  size: manifest.bytes.length,
  platform: { architecture, os, ...(variant ? { variant } : {}) },
});

/** `descriptor` annotated as BuildKit annotates an attestation, whatever its platform says. */
export const annotated = (descriptor) => ({
  ...descriptor,
  annotations: {
    "vnd.docker.reference.digest": descriptor.digest,
    "vnd.docker.reference.type": "attestation-manifest",
  },
});

/** The attestation BuildKit adds beside `manifest`: annotated, and for unknown/unknown. */
export const attestationOf = (manifest) => ({
  mediaType: OCI_MANIFEST,
  digest: imageManifest(`attestation of ${manifest.digest}`).digest,
  size: 838,
  annotations: {
    "vnd.docker.reference.digest": manifest.digest,
    "vnd.docker.reference.type": "attestation-manifest",
  },
  platform: { architecture: "unknown", os: "unknown" },
});

export const indexOf = (manifests) => doc({ schemaVersion: 2, mediaType: OCI_INDEX, manifests });

/**
 * One arch's build as Mend's build job pushes it (build-push-action's default provenance): a
 * single-platform index of the image and its attestation. `source` is what the job records, by
 * digest; `image` is the runnable manifest a consumer of that arch pulls.
 */
export const attestedBuild = (arch, seed = arch) => {
  const image = imageManifest(seed);
  return {
    arch,
    image,
    source: indexOf([childOf(image, "linux", arch), attestationOf(image)]),
  };
};

/** The two arches' builds of one image. */
export const buildsOf = (seed) =>
  Object.fromEntries(ARCHES.map((arch) => [arch, attestedBuild(arch, `${seed}/${arch}`)]));

/** The index imagetools create makes of the builds, amd64 first: every source's children. */
export const releaseIndex = (builds) =>
  indexOf(ARCHES.flatMap((arch) => builds[arch].source.value.manifests));

/** What a binding that maps <arch> to `mapped` instead of `build` says. */
const mapsTo = (arch, mapped, build) =>
  new RegExp(`maps linux/${arch} to ${mapped.digest}, not ${build.digest}, the ${arch} build`);
const both = (problem) => ({ amd64: problem, arm64: problem });

/**
 * Every index the binding refuses, made from `builds` as a real registry, BuildKit or a mis-ordered
 * matrix could make it: each with what the refusal says for each arch it holds at. An arch with no
 * entry resolves to its own build; its leg of identity passes, and the other leg refuses.
 */
export const refusedIndexes = (builds) => {
  const { amd64, arm64 } = builds;
  const attestations = [attestationOf(amd64.image), attestationOf(arm64.image)];
  const plain = [childOf(amd64.image, "linux", "amd64"), childOf(arm64.image, "linux", "arm64")];
  const real = [plain[0], attestations[0], plain[1], attestations[1]];
  const other = imageManifest("another build");
  // Astra's round 2: an attestation-annotated linux/amd64 descriptor of the arm64 build.
  const astra = annotated(childOf(arm64.image, "linux", "amd64"));
  const annotatedRunnable = /annotated as an attestation for linux\/(amd64|arm64\/v8), a platform/;
  return [
    {
      label: "swapped labels",
      index: indexOf([
        childOf(amd64.image, "linux", "arm64"),
        attestations[0],
        childOf(arm64.image, "linux", "amd64"),
        attestations[1],
      ]),
      problems: {
        amd64: mapsTo("amd64", arm64.image, amd64.image),
        arm64: mapsTo("arm64", amd64.image, arm64.image),
      },
    },
    {
      label: "a duplicated platform",
      index: indexOf([...real, childOf(other, "linux", "amd64")]),
      problems: { amd64: /has 2 linux\/amd64 entries/ },
    },
    {
      label: "a missing platform",
      index: indexOf([plain[0], attestations[0]]),
      problems: { arm64: /has 0 linux\/arm64 entries/ },
    },
    {
      label: "a digest listed twice",
      index: indexOf([...real, { ...plain[1], digest: amd64.image.digest }]),
      problems: both(new RegExp(`lists ${amd64.image.digest} 2 times`)),
    },
    {
      label: "an arm64 variant the build does not have",
      index: indexOf([plain[0], attestations[0], childOf(arm64.image, "linux", "arm64", "v7")]),
      problems: both(/holds linux\/arm64\/v7 /),
    },
    {
      label: "an amd64 variant",
      index: indexOf([childOf(amd64.image, "linux", "amd64", "v2"), ...real.slice(1)]),
      problems: both(/holds linux\/amd64\/v2 /),
    },
    {
      label: "another build under amd64 alone",
      index: indexOf([childOf(other, "linux", "amd64"), ...real.slice(1)]),
      problems: { amd64: mapsTo("amd64", other, amd64.image) },
    },
    {
      label: "another build under arm64 alone",
      index: indexOf([...real.slice(0, 2), childOf(other, "linux", "arm64"), attestations[1]]),
      problems: { arm64: mapsTo("arm64", other, arm64.image) },
    },
    {
      label: "Astra's annotated amd64 descriptor first",
      index: indexOf([astra, ...real]),
      problems: both(annotatedRunnable),
    },
    {
      label: "Astra's annotated amd64 descriptor last",
      index: indexOf([...real, astra]),
      problems: both(annotatedRunnable),
    },
    {
      label: "an annotated arm64 v8 descriptor",
      index: indexOf([...real, annotated(childOf(other, "linux", "arm64", "v8"))]),
      problems: both(annotatedRunnable),
    },
  ];
};

/** Indexes the binding accepts for `builds`: the real shape, its other order, and arm64 as v8. */
export const acceptedIndexes = (builds) => {
  const { amd64, arm64 } = builds;
  const amd = [childOf(amd64.image, "linux", "amd64"), attestationOf(amd64.image)];
  const arm = [childOf(arm64.image, "linux", "arm64"), attestationOf(arm64.image)];
  return [
    { label: "imagetools create's index, amd64 first", index: releaseIndex(builds) },
    { label: "arm64 first, as ghcr serves mend:latest", index: indexOf([...arm, ...amd]) },
    {
      label: "an arm64 build BuildKit labelled v8",
      index: indexOf([...amd, childOf(arm64.image, "linux", "arm64", "v8"), arm[1]]),
    },
  ];
};
