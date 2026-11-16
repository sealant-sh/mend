// finalize-images, split from release-publication.test.mjs so neither file runs near CI's per-file
// limit (SLNT-1040). It runs the release workflow's own step against a stand-in docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  acceptedIndexes,
  buildsOf,
  refusedIndexes,
  releaseIndex,
} from "./fixtures/release-indexes.mjs";

const releaseDocument = parse(
  readFileSync(new URL("../.github/workflows/release-cli.yml", import.meta.url), "utf8"),
);
const releaseJobs = releaseDocument.jobs;
const imageDocument = parse(
  readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8"),
);
const promoted = (image) => `ghcr.io/sealant-ci/${image}`;

/** Each image's two attested builds and the index merge staged of them, as the manifest records. */
const RELEASED = Object.fromEntries(
  ["mend", "mend-before", "mend-api", "mend-web"].map((image) => [image, buildsOf(image)]),
);
const STAGED = Object.fromEntries(
  Object.entries(RELEASED).map(([image, builds]) => [image, releaseIndex(builds)]),
);
const accepted = (image) => STAGED[image].digest;
/** What the manifest records for each image of that release. */
const STAGED_MANIFEST_IMAGES = Object.fromEntries(
  Object.entries(RELEASED).map(([image, builds]) => [
    image,
    {
      index: accepted(image),
      platforms: { amd64: builds.amd64.source.digest, arm64: builds.arm64.source.digest },
    },
  ]),
);
const rawRead = (reference) => ["buildx", "imagetools", "inspect", reference, "--raw"];
const tagRead = (reference) => [
  "buildx",
  "imagetools",
  "inspect",
  reference,
  "--format",
  "{{json .Manifest}}",
];

/**
 * finalize-images' step as written, against a stand-in docker over a registry held in a JSON file:
 * `tags` maps a reference to its digest, `unreadable` lists references whose read fails for a
 * reason other than not found, and `onCreate` says what a create does: `land` (the tag gets the
 * source's digest), `other` (another digest lands), `vanish` (the tag becomes unreadable), with an
 * optional exit code. `answers` replaces a reference's read with exact stdout, stderr and exit
 * (only its first read, with `once`). The registry serves each image's index and builds by digest,
 * as merge staged them and the manifest records them; `indexes` replaces an image's index with
 * another document, which the manifest then records.
 */
const finalize = (
  t,
  { tags = {}, unreadable = [], onCreate = {}, manifest = {}, answers = {}, indexes = {} } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mend-finalize-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "registry.json");
  writeFileSync(calls, "");
  const staged = { ...STAGED, ...indexes };
  const documents = {};
  for (const image of Object.keys(RELEASED)) {
    documents[`${promoted(image)}@${staged[image].digest}`] =
      staged[image].bytes.toString("base64");
    for (const arch of ["amd64", "arm64"]) {
      const { source } = RELEASED[image][arch];
      documents[`${promoted(image)}@${source.digest}`] = source.bytes.toString("base64");
    }
  }
  writeFileSync(state, JSON.stringify({ tags, unreadable, onCreate, answers, documents }));
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect" && args[4] === "--raw" && args.length === 5) {
  const served = registry.documents[args[3]];
  if (served === undefined) { console.error("ERROR: " + args[3] + ": not found"); process.exit(1); }
  process.stdout.write(Buffer.from(served, "base64"));
  process.exit(0);
}
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect" && args[4] === "--format") {
  const ref = args[3];
  const answer = registry.answers[ref];
  if (answer !== undefined) {
    if (answer.once) {
      delete registry.answers[ref];
      save();
    }
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.exit ?? 1);
  }
  if (registry.unreadable.includes(ref)) {
    console.error("ERROR: failed to do request: Head \\"https://ghcr.io/v2/x\\": unauthorized");
    process.exit(1);
  }
  if (!(ref in registry.tags)) { console.error("ERROR: " + ref + ": not found"); process.exit(1); }
  console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: registry.tags[ref] }));
  process.exit(0);
}
if (args.slice(0, 4).join(" ") === "buildx imagetools create --tag" && args.length === 6) {
  const [target, source] = args.slice(4);
  const effect = registry.onCreate[target] ?? { land: true };
  if (effect.land) registry.tags[target] = source.split("@")[1];
  if (effect.other) registry.tags[target] = "sha256:" + "e".repeat(64);
  if (effect.vanish) registry.unreadable.push(target);
  save();
  process.exit(effect.exit ?? 0);
}
process.exit(79);
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: "1.2.3",
      before: "0.0.0-acceptance.9.1",
      commit: "f".repeat(40),
      images: Object.fromEntries(
        Object.entries(STAGED_MANIFEST_IMAGES).map(([image, entry]) => [
          image,
          { ...entry, index: staged[image].digest },
        ]),
      ),
      cli: {
        file: "sealant-mend-1.2.3.tgz",
        sha512: "0".repeat(128),
        integrity: `sha512-${Buffer.from("0".repeat(128), "hex").toString("base64")}`,
      },
      ...manifest,
    }),
  );
  const step = releaseJobs["finalize-images"].steps.find(
    (entry) => entry.name === "Publish each accepted index as its version",
  );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
      RUNNER_TEMP: directory,
      GITHUB_SHA: "f".repeat(40),
      GITHUB_REPOSITORY_OWNER: "sealant-ci",
      MANIFEST: file,
      VERSION: "1.2.3",
    },
  });
  return {
    ...result,
    output: result.stdout + result.stderr,
    registry: JSON.parse(readFileSync(state, "utf8")),
    calls: readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};
const FINAL = ["mend", "mend-api", "mend-web"];
const finalRef = (image) => `${promoted(image)}:1.2.3`;
const ours = Object.fromEntries(FINAL.map((image) => [finalRef(image), accepted(image)]));
const creates = (result) => result.calls.filter((args) => args[2] === "create");

test("finalize creates each absent :<version> from the accepted index, after reading every one", (t) => {
  const result = finalize(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    creates(result),
    FINAL.map((image) => [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      finalRef(image),
      `${promoted(image)}@${accepted(image)}`,
    ]),
  );
  for (const image of FINAL) assert.equal(result.registry.tags[finalRef(image)], accepted(image));
  // Every index is bound, both arches, before any tag is read; every tag is read before any is
  // written.
  const firstCreate = result.calls.findIndex((args) => args[2] === "create");
  assert.deepEqual(result.calls.slice(0, firstCreate), [
    ...FINAL.flatMap((image) =>
      ["amd64", "arm64"].flatMap((arch) => [
        rawRead(`${promoted(image)}@${accepted(image)}`),
        rawRead(`${promoted(image)}@${RELEASED[image][arch].source.digest}`),
      ]),
    ),
    ...FINAL.map((image) => tagRead(finalRef(image))),
  ]);
});

test("finalize binds each index's platforms again, and writes nothing for an index the binding refuses", (t) => {
  // Each reaches finalize as if merge's check and acceptance had been stubbed to pass: the manifest
  // records the bad index, and nothing before this step looked at it. It is the last image's, so
  // the other two were bound and still no tag is read.
  for (const { label, index, problems } of refusedIndexes(RELEASED["mend-web"])) {
    const result = finalize(t, { indexes: { "mend-web": index } });
    assert.equal(result.status, 1, `${label}: ${result.output}`);
    assert.match(result.output, problems.amd64 ?? problems.arm64, label);
    assert.deepEqual(
      result.calls.filter((args) => args[4] !== "--raw"),
      [],
      `${label} reads no tag`,
    );
    assert.deepEqual(result.registry.tags, {}, label);
  }
  // The first image's swapped index stops finalize before any other image is read.
  const swapped = refusedIndexes(RELEASED.mend)[0];
  const first = finalize(t, { indexes: { mend: swapped.index } });
  assert.equal(first.status, 1, first.output);
  assert.match(first.output, swapped.problems.amd64);
  assert.deepEqual(first.calls, [
    rawRead(`${promoted("mend")}@${swapped.index.digest}`),
    rawRead(`${promoted("mend")}@${RELEASED.mend.amd64.source.digest}`),
  ]);
  // An index or a build the registry cannot serve by the recorded digest writes nothing either.
  for (const images of [
    { "mend-api": { index: `sha256:${"9".repeat(64)}` } },
    { "mend-api": { platforms: { arm64: `sha256:${"9".repeat(64)}` } } },
  ]) {
    const recorded = JSON.parse(JSON.stringify(STAGED_MANIFEST_IMAGES));
    for (const [image, entry] of Object.entries(images))
      recorded[image] = {
        ...recorded[image],
        ...entry,
        platforms: { ...recorded[image].platforms, ...entry.platforms },
      };
    const unserved = finalize(t, { manifest: { images: recorded } });
    assert.equal(unserved.status, 1, unserved.output);
    assert.match(unserved.output, /Could not read ghcr\.io\/sealant-ci\/mend-api@sha256:9{64}/);
    assert.deepEqual(
      unserved.calls.filter((args) => args[4] !== "--raw"),
      [],
    );
    assert.deepEqual(unserved.registry.tags, {});
  }
  // A real BuildKit index, its attestations unknown/unknown, in each order and with arm64 as v8,
  // is bound and tagged.
  for (const { label, index } of acceptedIndexes(RELEASED.mend)) {
    const result = finalize(t, { indexes: { mend: index } });
    assert.equal(result.status, 0, `${label}: ${result.output}`);
    assert.equal(result.registry.tags[finalRef("mend")], index.digest, label);
  }
});

test("finalize is done when :<version> already names this run's index: a rerun of failed jobs", (t) => {
  const result = finalize(t, { tags: ours });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(creates(result), []);
  assert.match(result.output, /is already this run's sha256:/);
});

test("finalize refuses a version that exists at another digest, before writing any tag", (t) => {
  const result = finalize(t, {
    tags: { [finalRef("mend-web")]: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /::error::.*mend-web:1\.2\.3 exists at sha256:e{64}.*is spent: cut a new one/,
  );
  assert.deepEqual(creates(result), []);
});

test("finalize fails without writing on a read that is not a not-found", (t) => {
  const result = finalize(t, { unreadable: [finalRef("mend-api")] });
  assert.equal(result.status, 1);
  assert.match(result.output, /::error::Could not read .*mend-api:1\.2\.3; nothing was written/);
  assert.deepEqual(creates(result), []);
});

test("finalize reads absent only from buildx's sole not-found line, and fails on anything else", (t) => {
  const ref = finalRef("mend");
  // The audit's case: not found plus another error is a failed read, not an absent tag.
  for (const [label, answer] of [
    [
      "mixed lines",
      { stderr: `ERROR: ${ref}: not found\nERROR: unauthorized: authentication required\n` },
    ],
    ["an error before it", { stderr: `WARNING: retrying\nERROR: ${ref}: not found\n` }],
    ["a changed format", { stderr: `error: ${ref}: not found\n` }],
    ["another reference", { stderr: `ERROR: ${ref}-other: not found\n` }],
    ["output beside it", { stdout: "{}\n", stderr: `ERROR: ${ref}: not found\n` }],
  ]) {
    const result = finalize(t, { answers: { [ref]: answer } });
    assert.equal(result.status, 1, label);
    assert.match(result.output, /Could not read .*mend:1\.2\.3; nothing was written/, label);
    assert.deepEqual(creates(result), [], label);
  }
  // The exact sole line, however many trailing newlines, is absent: the tag is created. Its
  // re-read after the create is the ordinary one.
  const result = finalize(t, {
    answers: { [ref]: { stderr: `ERROR: ${ref}: not found\n\n`, once: true } },
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(creates(result).length, 1 + 2);
  assert.deepEqual(creates(result)[0].slice(4), [ref, `${promoted("mend")}@${accepted("mend")}`]);
});

test("finalize: a create that reported an error but left this run's digest is a success", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("mend")]: { land: true, exit: 1 } } });
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    /::warning::The create reported exit 1, but .*mend:1\.2\.3 resolves to/,
  );
  assert.equal(creates(result).length, 3);
});

test("finalize refuses when the tag shows another digest after its create", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("mend-api")]: { other: true } } });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /mend-api:1\.2\.3 resolves to sha256:e{64} after the create.*is spent/,
  );
  // mend-web is not written after the refusal.
  assert.deepEqual(
    creates(result).map((args) => args[4]),
    [finalRef("mend"), finalRef("mend-api")],
  );
});

test("finalize fails when the tag is unreadable, or still absent, after its create", (t) => {
  const vanished = finalize(t, { onCreate: { [finalRef("mend")]: { vanish: true } } });
  assert.equal(vanished.status, 1);
  assert.match(vanished.output, /mend:1\.2\.3 is unreadable after the create/);
  const missing = finalize(t, { onCreate: { [finalRef("mend")]: { exit: 1 } } });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /mend:1\.2\.3 does not exist after the create \(exit 1\)/);
});

test("finalize refuses another release's manifest or a missing index, writing nothing", (t) => {
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const result = finalize(t, { manifest });
    assert.equal(result.status, 1, JSON.stringify(manifest));
    assert.deepEqual(creates(result), []);
  }
});

test("finalize gates npm and promotion, and the three queue on one release channel", () => {
  const finalizeJob = releaseJobs["finalize-images"];
  assert.equal(finalizeJob.if, "github.event_name == 'push'");
  assert.deepEqual(finalizeJob.permissions, { contents: "read", packages: "write" });
  assert.equal(finalizeJob["runs-on"], "ubuntu-24.04");
  assert.ok(finalizeJob.needs.includes("acceptance"));
  const download = finalizeJob.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(download.with, { name: "release-manifest", path: "release" });
  // Only the manifest reader that binds the index, from the tag push's own commit (no ref), with
  // no credential left behind; checked out first, so the workspace it cleans is still empty.
  const checkout = finalizeJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, {
    "persist-credentials": false,
    "sparse-checkout": ".node-version\nscripts/release-manifest.mjs\n",
    "sparse-checkout-cone-mode": false,
  });
  assert.ok(finalizeJob.steps.indexOf(checkout) < finalizeJob.steps.indexOf(download));
  for (const name of ["npm", "promote-images"])
    assert.ok(releaseJobs[name].needs.includes("finalize-images"), name);
  for (const name of ["finalize-images", "npm", "promote-images"])
    assert.deepEqual(
      releaseJobs[name].concurrency,
      { group: "mend-release-channel", "cancel-in-progress": false, queue: "max" },
      name,
    );
});

test("on a real version, only finalize-images writes :<version>", () => {
  // Every registry write in image.yml and release-cli.yml, its continuation lines joined, and what
  // it tags. merge's shell is run above: a real version is staged.
  const registryWrites = [];
  for (const [file, document] of [
    ["image.yml", imageDocument],
    ["release-cli.yml", releaseDocument],
  ])
    for (const [name, definition] of Object.entries(document.jobs))
      for (const entry of definition.steps ?? []) {
        for (const line of (entry.run ?? "").replace(/\\\n\s*/g, " ").split("\n"))
          if (/docker buildx imagetools create|docker push|skopeo copy/.test(line))
            registryWrites.push({ at: `${file} ${name}`, line: line.trim(), entry });
        if (/push=true/.test(entry.with?.outputs ?? ""))
          registryWrites.push({ at: `${file} ${name}`, line: entry.with.outputs, entry });
      }
  // archive-merge writes only to the registry it starts on loopback.
  const loopback = registryWrites.filter(({ at }) => at === "image.yml archive-merge");
  assert.ok(loopback.length >= 2);
  for (const { entry } of loopback)
    assert.equal(entry.env.REPOSITORY, "127.0.0.1:5000/${{ matrix.image.name }}");
  const ghcr = registryWrites.filter(({ at }) => at !== "image.yml archive-merge");
  const tagged = (pattern) => ghcr.filter(({ line }) => pattern.test(line)).map(({ at }) => at);
  assert.deepEqual(tagged(/\$(VERSION|version)\b/), ["release-cli.yml finalize-images"]);
  assert.deepEqual(tagged(/:\$tag"/), ["image.yml merge"]);
  assert.deepEqual(tagged(/:latest"/), ["release-cli.yml promote-images"]);
  // The build pushes by digest only: no tag at all.
  for (const { line } of ghcr.filter(({ at }) => at === "image.yml build"))
    assert.match(line, /push-by-digest=true/);
  assert.deepEqual(ghcr.map(({ at }) => at).toSorted(), [
    "image.yml build",
    "image.yml merge",
    "release-cli.yml finalize-images",
    "release-cli.yml promote-images",
  ]);
});
