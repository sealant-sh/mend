// The release manifest image.yml writes, the archive and CLI checks acceptance runs against it, and
// the image.yml jobs that write and read it: run as written where they are shell, against stand-in
// commands and fixture archives.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  ARCHES,
  IMAGES,
  archiveIdentity,
  buildManifest,
  checkArchive,
  checkCli,
  checkIndex,
  validateManifest,
} from "./release-manifest.mjs";

const script = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));
const workflowText = (file) =>
  readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
const image = parse(workflowText("image.yml"));
const { jobs } = image;

const scratch = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const COMMIT = "f".repeat(40);

const cliRecord = (bytes) => {
  const digest = createHash("sha512").update(bytes).digest();
  return {
    file: "sealant-mend-1.2.3.tgz",
    sha512: digest.toString("hex"),
    integrity: `sha512-${digest.toString("base64")}`,
  };
};

/** The records one run's jobs upload, laid out as download-artifact lays out a pattern. */
const records = (directory, platforms = {}) => {
  const digests = path.join(directory, "digests");
  const indexes = path.join(directory, "indexes");
  for (const name of IMAGES) {
    for (const arch of ARCHES) {
      const dir = path.join(digests, `digests-${name}--${arch}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, platforms[`${name}/${arch}`] ?? hex(`${name}/${arch}`)), "");
    }
    mkdirSync(path.join(indexes, `index-${name}`), { recursive: true });
    writeFileSync(path.join(indexes, `index-${name}`, "digest"), `sha256:${hex(name)}\n`);
  }
  return { digests, indexes };
};

const manifestFor = (directory, platforms) =>
  buildManifest({
    version: "1.2.3",
    before: "0.0.0-acceptance.9.1",
    commit: COMMIT,
    ...records(directory, platforms),
    cli: cliRecord("tarball"),
  });

/**
 * An image archive as BuildKit's docker exporter writes one: oci-layout, index.json naming one
 * manifest, the manifest and config blobs, and manifest.json; packed by tar with `./` names.
 * `index` rewrites index.json's manifests, to forge a digest.
 */
const archive = (directory, { arch = "amd64", index } = {}) => {
  const root = path.join(directory, `layout-${Math.random()}`);
  mkdirSync(path.join(root, "blobs/sha256"), { recursive: true });
  const blob = (bytes) => {
    const digest = sha256(bytes);
    writeFileSync(path.join(root, "blobs/sha256", digest.slice(7)), bytes);
    return digest;
  };
  // A nonce in the config, so two fixture archives are two images.
  const config = Buffer.from(
    JSON.stringify({ architecture: arch, os: "linux", nonce: Math.random() }),
  );
  const configDigest = blob(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { digest: configDigest, size: config.length },
      layers: [],
    }),
  );
  const manifestDigest = blob(manifest);
  const descriptor = {
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    digest: manifestDigest,
    size: manifest.length,
  };
  writeFileSync(path.join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(
    path.join(root, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: index?.(descriptor) ?? [descriptor] }),
  );
  writeFileSync(path.join(root, "manifest.json"), "[]");
  const file = path.join(directory, `${Math.random()}.tar`);
  execFileSync("tar", ["-cf", file, "-C", root, "."]);
  return { file, platform: manifestDigest, config: configDigest };
};

test("the manifest holds every image's index and platform digests, the run's identity and the CLI", (t) => {
  const manifest = manifestFor(scratch(t));
  assert.deepEqual(Object.keys(manifest.images), IMAGES);
  assert.deepEqual(manifest.images.mend, {
    index: `sha256:${hex("mend")}`,
    platforms: { amd64: `sha256:${hex("mend/amd64")}`, arm64: `sha256:${hex("mend/arm64")}` },
  });
  assert.deepEqual(
    { version: manifest.version, before: manifest.before, commit: manifest.commit },
    { version: "1.2.3", before: "0.0.0-acceptance.9.1", commit: COMMIT },
  );
  assert.deepEqual(manifest.cli, cliRecord("tarball"));
});

test("a run missing a record, or holding a stray one, writes no manifest", (t) => {
  const directory = scratch(t);
  const { digests, indexes } = records(directory);
  const base = { version: "1.2.3", before: "b", commit: COMMIT, digests, indexes };
  writeFileSync(path.join(digests, "digests-mend--arm64", hex("second")), "");
  assert.throws(() => buildManifest({ ...base, cli: cliRecord("x") }), /exactly one file/);
  rmSync(path.join(digests, "digests-mend--arm64"), { recursive: true });
  assert.throws(() => buildManifest({ ...base, cli: cliRecord("x") }), /ENOENT/);
  const valid = manifestFor(scratch(t));
  for (const broken of [
    { ...valid, commit: "abc" },
    {
      ...valid,
      images: { ...valid.images, "mend-web": { ...valid.images["mend-web"], index: "latest" } },
    },
    { ...valid, cli: { ...valid.cli, integrity: "sha512-forged" } },
    { ...valid, cli: undefined },
  ])
    assert.throws(() => validateManifest(broken));
});

test("an archive's platform digest is computed from the archive, and must be the manifest's", (t) => {
  const directory = scratch(t);
  const amd64 = archive(directory);
  assert.deepEqual(archiveIdentity(amd64.file), {
    platform: amd64.platform,
    config: amd64.config,
    architecture: "amd64",
  });
  const manifest = manifestFor(directory, { "mend/amd64": amd64.platform.slice(7) });
  // The image IDs it may load as: the config digest, or on the containerd store the manifest's.
  assert.deepEqual(checkArchive(manifest, "mend", "amd64", amd64.file), [
    amd64.config,
    amd64.platform,
  ]);
  // Another image's archive, a well-formed one, is not this run's mend.
  const other = archive(directory);
  assert.notEqual(other.platform, amd64.platform);
  assert.throws(
    () => checkArchive(manifest, "mend-before", "amd64", amd64.file),
    /the release manifest records/,
  );
  // The right digest, built for the other arch.
  const arm = archive(directory, { arch: "arm64" });
  const armManifest = manifestFor(scratch(t), { "mend/amd64": arm.platform.slice(7) });
  assert.throws(() => checkArchive(armManifest, "mend", "amd64", arm.file), /built for arm64/);
});

test("an index.json whose digest is not its manifest's is refused", (t) => {
  const directory = scratch(t);
  // index.json claims the digest the manifest records, over a blob that hashes to something else.
  const recorded = `sha256:${hex("recorded")}`;
  const forged = archive(directory, {
    index: (descriptor) => [{ ...descriptor, digest: recorded }],
  });
  const manifest = manifestFor(directory, { "mend/amd64": recorded.slice(7) });
  assert.throws(() => checkArchive(manifest, "mend", "amd64", forged.file), /lacks the manifest/);
  // The blob is present under the claimed name, but its bytes are another manifest's.
  const root = path.join(directory, "swapped");
  mkdirSync(root);
  execFileSync("tar", ["-xf", forged.file, "-C", root]);
  writeFileSync(
    path.join(root, "blobs/sha256", recorded.slice(7)),
    readFileSync(path.join(root, "blobs/sha256", forged.platform.slice(7))),
  );
  const swapped = path.join(directory, "swapped.tar");
  execFileSync("tar", ["-cf", swapped, "-C", root, "."]);
  assert.throws(
    () => checkArchive(manifest, "mend", "amd64", swapped),
    /does not hash to the digest index\.json gives it/,
  );
  const result = spawnSync(
    process.execPath,
    [script, "check-archive", writeManifest(directory, manifest), "mend", "amd64", swapped],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::/);
  assert.equal(result.stdout, "");
});

test("an archive naming an index (attestations) or two manifests is refused", (t) => {
  const directory = scratch(t);
  const list = archive(directory, {
    index: (descriptor) => [
      { ...descriptor, mediaType: "application/vnd.oci.image.index.v1+json" },
    ],
  });
  assert.throws(() => archiveIdentity(list.file), /not one image manifest/);
  const two = archive(directory, { index: (descriptor) => [descriptor, descriptor] });
  assert.throws(() => archiveIdentity(two.file), /one platform manifest/);
});

const writeManifest = (directory, manifest) => {
  const file = path.join(directory, `manifest-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  return file;
};

test("the CLI tarball must be the manifest's file, by name and sha512, alone in its artifact", (t) => {
  const directory = scratch(t);
  const manifest = validateManifest({
    ...manifestFor(directory),
    cli: cliRecord("the tarball"),
  });
  const artifact = path.join(directory, "cli");
  mkdirSync(artifact);
  writeFileSync(path.join(artifact, "sealant-mend-1.2.3.tgz"), "the tarball");
  assert.equal(checkCli(manifest, artifact), path.join(artifact, "sealant-mend-1.2.3.tgz"));
  writeFileSync(path.join(artifact, "sealant-mend-1.2.3.tgz"), "the tarbalL");
  assert.throws(() => checkCli(manifest, artifact), /sha512 is not the release manifest's/);
  writeFileSync(path.join(artifact, "sealant-mend-1.2.3.tgz"), "the tarball");
  writeFileSync(path.join(artifact, ".npmrc"), "registry=https://evil.example/\n");
  assert.throws(() => checkCli(manifest, artifact), /exactly one file/);
});

// --- image.yml ---

const runsOn = (target, job) => {
  const condition = job.if ?? "";
  if (condition.includes(`inputs.target == '${target}'`)) return true;
  return !/inputs\.target == '/.test(condition);
};
const jobsFor = (target) =>
  Object.entries(jobs)
    .filter(([, job]) => runsOn(target, job))
    .map(([name]) => name);
const step = (job, name) => {
  const found = jobs[job].steps.find((entry) => entry.name === name);
  assert.ok(found, `${job} has no step ${name}`);
  return found;
};
const stepIdentity = (entry) => entry.name ?? entry.uses?.split("@")[0] ?? entry.run;

test("image.yml takes a target, ghcr by default, from a call and from a dispatch", () => {
  assert.deepEqual(image.on.workflow_call.inputs.target, {
    required: false,
    type: "string",
    default: "ghcr",
  });
  assert.equal(image.on.workflow_dispatch.inputs.target.default, "ghcr");
  assert.deepEqual(image.on.workflow_dispatch.inputs.target.options, ["ghcr", "archive"]);
  const check = step("version", "Check the target").run;
  for (const [target, status] of [
    ["ghcr", 0],
    ["archive", 0],
    ["registry", 1],
    ["", 1],
  ])
    assert.equal(
      spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", check], { env: { TARGET: target } })
        .status,
      status,
      target,
    );
  const acceptance = parse(workflowText("release-acceptance.yml"));
  assert.equal(acceptance.on.workflow_dispatch.inputs.target.default, "ghcr");
  assert.equal(acceptance.jobs.acceptance.with.target, "${{ inputs.target || 'ghcr' }}");
});

test("with ghcr, the jobs are today's plus the CLI and the manifest; archive jobs never run", () => {
  assert.deepEqual(jobsFor("ghcr"), [
    "version",
    "build",
    "merge",
    "cli",
    "release-manifest",
    "packaged-smoke",
  ]);
  assert.deepEqual(jobsFor("archive"), [
    "version",
    "archive-build",
    "archive-merge",
    "cli",
    "release-manifest",
    "archive-acceptance",
  ]);
  // Today's steps, in today's order, with additions only after them or between them.
  const keeps = (job, before) => {
    const now = jobs[job].steps.map(stepIdentity);
    let at = 0;
    for (const identity of now) if (identity === before[at]) at += 1;
    assert.equal(at, before.length, `${job} lost a step: ${JSON.stringify(now)}`);
  };
  keeps("build", [
    "Start the disk sampler",
    "actions/checkout",
    "docker/setup-buildx-action",
    "docker/login-action",
    "docker/build-push-action",
    "Export digest",
    "actions/upload-artifact",
    "Report peak disk use",
  ]);
  keeps("merge", [
    "actions/download-artifact",
    "docker/login-action",
    "Create and inspect the multi-arch candidate",
  ]);
  keeps("packaged-smoke", [
    "Start the disk sampler",
    "actions/checkout",
    "docker/login-action",
    "pnpm/action-setup",
    "actions/setup-node",
    "pnpm install --frozen-lockfile --ignore-scripts",
    "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    "Exercise packaged install and same-source version transition",
    "Report peak disk use",
  ]);
  const build = jobs.build.steps.find((entry) => entry.id === "build");
  assert.match(build.with.outputs, /push-by-digest=true,name-canonical=true,push=true/);
  assert.equal(jobs.build.steps.length, 8);
});

test("archive jobs hold no packages: write, log in nowhere and push to no registry but their own", () => {
  for (const name of ["archive-build", "archive-merge", "archive-acceptance"]) {
    const job = jobs[name];
    assert.ok(job.permissions, `${name} declares its permissions`);
    assert.equal(job.permissions.packages, undefined, name);
    assert.ok(!Object.values(job.permissions).includes("write"), name);
    for (const entry of job.steps) {
      assert.ok(!entry.uses?.startsWith("docker/login-action@"), `${name} logs in`);
      assert.doesNotMatch(entry.with?.outputs ?? "", /push=true|type=image|type=registry/);
      assert.doesNotMatch(entry.run ?? "", /docker push|ghcr\.io[^\s]*@|docker:\/\/ghcr/);
    }
  }
  const build = jobs["archive-build"].steps.find((entry) => entry.id === "build");
  assert.match(build.with.outputs, /^type=docker,dest=/);
  assert.equal(build.with.provenance, false);
  assert.equal(build.with.sbom, false);
  const push = step("archive-merge", "Push both arches' archives to it");
  assert.match(push.env.REPOSITORY, /^127\.0\.0\.1:5000\//);
  assert.match(push.run, /skopeo copy --preserve-digests/);
  assert.match(
    step("archive-merge", "Start a registry on loopback inside this job").run,
    /--publish 127\.0\.0\.1:5000:5000 registry:2/,
  );
});

test("no workflow downloads an artifact from another run", () => {
  const directory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const { jobs: all } = parse(readFileSync(path.join(directory, file), "utf8"));
    for (const [name, job] of Object.entries(all ?? {}))
      for (const entry of job.steps ?? [])
        if (entry.uses?.startsWith("actions/download-artifact@")) {
          assert.equal(entry.with?.["run-id"], undefined, `${file} ${name}`);
          assert.equal(entry.with?.["github-token"], undefined, `${file} ${name}`);
          assert.equal(entry.with?.repository, undefined, `${file} ${name}`);
        }
  }
});

test("the manifest, the CLI tarball and the archives are kept as long as they are needed", () => {
  const uploads = Object.values(jobs).flatMap((job) =>
    job.steps.filter((entry) => entry.uses?.startsWith("actions/upload-artifact@")),
  );
  const retention = (name) =>
    uploads.find((entry) => entry.with.name === name)?.with["retention-days"];
  assert.equal(retention("release-manifest"), 90);
  assert.equal(retention("mend-cli"), 90);
  assert.equal(retention("archive-${{ matrix.image.id }}--${{ matrix.platform.arch }}"), 1);
});

// A caller's grant is the ceiling for every job in image.yml, and a job that names no permissions
// inherits all of it: so each job names its own, and none of these release workflows can cancel or
// re-run workflows or delete artifacts.
test("every image.yml job names its permissions, and no release workflow holds actions: write", () => {
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(job.permissions && typeof job.permissions === "object", `image.yml ${name}`);
  }
  for (const file of ["image.yml", "release-cli.yml", "release-acceptance.yml"]) {
    const workflow = parse(
      readFileSync(fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url)), "utf8"),
    );
    const grants = [
      workflow.permissions,
      ...Object.values(workflow.jobs).map((job) => job.permissions),
    ];
    for (const grant of grants) {
      assert.notEqual(grant, "write-all", file);
      assert.notEqual(grant?.actions, "write", `${file} grants actions: write`);
    }
  }
});

test("the cli job packs once, normalizes, checks the result, and holds no credential or cache", () => {
  const cli = jobs.cli;
  assert.deepEqual(cli.permissions, { contents: "read" });
  assert.equal(cli["runs-on"], "ubuntu-24.04");
  const text = JSON.stringify(cli);
  assert.doesNotMatch(text, /id-token|cache: pnpm|actions\/cache/);
  const pack = step("cli", "Build, pack and normalize").run;
  assert.match(pack, /node scripts\/normalize-npm-tarball\.mjs "\$\{packed\[0\]\}" --out/);
  assert.match(pack, /node scripts\/normalize-npm-tarball\.mjs --check/);
  assert.equal(
    step("cli", "Set the version and commit").env.VERSION,
    "${{ needs.version.outputs.value }}",
  );
  assert.match(step("cli", "Set the version and commit").run, /npm pkg set "gitHead=\$COMMIT"/);
});

/**
 * A stand-in docker that records its argv. `image inspect` answers FIXTURE_ID when it is set, else
 * the reference it was asked about, as Docker does for an image ID; with FIXTURE_ONLY, it knows no
 * other image.
 */
const standIn = (t) => {
  const directory = scratch(t);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.FIXTURE_ONLY && !process.env.FIXTURE_ONLY.split(" ").includes(args[2])) process.exit(1);
  console.log(process.env.FIXTURE_ID ?? args[2]);
}
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  return {
    directory,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: directory,
    },
    calls: () =>
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    outputs: () => readFileSync(output, "utf8"),
  };
};

test("online acceptance pulls this arch's digests from the manifest and tags only the IDs it pulled", (t) => {
  const smoke = jobs["packaged-smoke"];
  assert.deepEqual(smoke.needs, ["version", "merge", "release-manifest"]);
  const downloads = smoke.steps.filter((entry) =>
    entry.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(
    downloads.map((entry) => entry.with.name),
    ["release-manifest", "mend-cli"],
  );
  const pull = step("packaged-smoke", "Pull the candidates by digest");
  const fake = standIn(t);
  const manifest = manifestFor(fake.directory);
  const file = writeManifest(fake.directory, manifest);
  for (const [arch, runner] of [
    ["amd64", "X64"],
    ["arm64", "ARM64"],
  ]) {
    const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", pull.run], {
      encoding: "utf8",
      env: {
        ...fake.env,
        FIXTURE_ID: `sha256:${"c".repeat(64)}`,
        RUNNER_ARCH: runner,
        REPOSITORY: "ghcr.io/sealant-sh/mend",
        MANIFEST: file,
        BEFORE: "0.0.0-acceptance.9.1",
        VERSION: "1.2.3",
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const id = `sha256:${"c".repeat(64)}`;
    const calls = fake.calls().slice(-6);
    const before = `ghcr.io/sealant-sh/mend@${manifest.images["mend-before"].platforms[arch]}`;
    const target = `ghcr.io/sealant-sh/mend@${manifest.images.mend.platforms[arch]}`;
    assert.deepEqual(calls, [
      ["pull", before],
      ["image", "inspect", before, "--format", "{{.Id}}"],
      ["tag", id, "ghcr.io/sealant-sh/mend:0.0.0-acceptance.9.1"],
      ["pull", target],
      ["image", "inspect", target, "--format", "{{.Id}}"],
      ["tag", id, "ghcr.io/sealant-sh/mend:1.2.3"],
    ]);
  }
  assert.match(fake.outputs(), new RegExp(`^before=sha256:c{64}\ntarget=sha256:c{64}\n`));
  const exercise = step(
    "packaged-smoke",
    "Exercise packaged install and same-source version transition",
  );
  assert.equal(exercise.run, "node scripts/check-packaged-server.mjs");
  assert.equal(exercise.env.MEND_TEST_IMAGE_ID, "${{ steps.images.outputs.before }}");
  assert.equal(exercise.env.MEND_TEST_UPGRADE_IMAGE_ID, "${{ steps.images.outputs.target }}");
  assert.equal(exercise.env.MEND_TEST_IMAGE_IDENTITY, "digest");
  assert.equal(exercise.env.MEND_TEST_CLI_TARBALL, "${{ steps.cli.outputs.tarball }}");
  assert.equal(exercise.env.MEND_TEST_OFFLINE, undefined);
  assert.match(
    step("packaged-smoke", "Check the CLI tarball against the manifest").run,
    /check-cli/,
  );
});

test("archive acceptance loads only its arch's checked archives, as their config digests, offline", (t) => {
  const acceptance = jobs["archive-acceptance"];
  const downloads = acceptance.steps
    .filter((entry) => entry.uses?.startsWith("actions/download-artifact@"))
    .map((entry) => entry.with);
  assert.deepEqual(
    downloads.map((entry) => entry.name),
    [
      "release-manifest",
      "archive-mend--${{ steps.platform.outputs.arch }}",
      "archive-mend-before--${{ steps.platform.outputs.arch }}",
      "mend-cli",
    ],
  );
  assert.ok(downloads.every((entry) => entry.pattern === undefined));
  const fake = standIn(t);
  const target = archive(fake.directory);
  const before = archive(fake.directory);
  for (const [name, file] of [
    ["mend", target.file],
    ["mend-before", before.file],
  ]) {
    mkdirSync(path.join(fake.directory, "archives", name), { recursive: true });
    writeFileSync(path.join(fake.directory, "archives", name, `${name}.tar`), readFileSync(file));
  }
  const manifest = manifestFor(fake.directory, {
    "mend/amd64": target.platform.slice(7),
    "mend-before/amd64": before.platform.slice(7),
  });
  const load = step("archive-acceptance", "Load the candidates from their archives").run;
  const file = writeManifest(fake.directory, manifest);
  const run = (extra = {}) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", load], {
      encoding: "utf8",
      env: {
        ...fake.env,
        REPOSITORY: "ghcr.io/sealant-sh/mend",
        MANIFEST: file,
        ARCH: "amd64",
        BEFORE: "0.0.0-acceptance.9.1",
        VERSION: "1.2.3",
        ...extra,
      },
    });
  const beforeArchive = path.join(fake.directory, "archives/mend-before/mend-before.tar");
  const targetArchive = path.join(fake.directory, "archives/mend/mend.tar");
  const loaded = run();
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(fake.calls(), [
    ["load", "--input", beforeArchive],
    ["image", "inspect", before.config, "--format", "{{.Id}}"],
    ["tag", before.config, "ghcr.io/sealant-sh/mend:0.0.0-acceptance.9.1"],
    ["load", "--input", targetArchive],
    ["image", "inspect", target.config, "--format", "{{.Id}}"],
    ["tag", target.config, "ghcr.io/sealant-sh/mend:1.2.3"],
  ]);
  assert.equal(fake.outputs(), `before=${before.config}\ntarget=${target.config}\n`);
  // Docker's containerd image store IDs an image by its manifest digest.
  const containerd = run({ FIXTURE_ONLY: `${before.platform} ${target.platform}` });
  assert.equal(containerd.status, 0, containerd.stderr);
  assert.deepEqual(
    fake
      .calls()
      .slice(6)
      .filter(([command]) => command === "tag"),
    [
      ["tag", before.platform, "ghcr.io/sealant-sh/mend:0.0.0-acceptance.9.1"],
      ["tag", target.platform, "ghcr.io/sealant-sh/mend:1.2.3"],
    ],
  );
  assert.match(
    fake.outputs(),
    new RegExp(`before=${before.platform}\ntarget=${target.platform}\n$`),
  );
  // An image that loads as anything else is never tagged.
  const calls = fake.calls().length;
  const elsewhere = run({ FIXTURE_ID: target.config });
  assert.equal(elsewhere.status, 1);
  assert.match(
    elsewhere.stdout + elsewhere.stderr,
    /did not load as its config digest or its manifest digest/,
  );
  assert.ok(
    fake
      .calls()
      .slice(calls)
      .every(([command]) => command !== "tag"),
  );
  // A swapped archive is refused before Docker sees it.
  writeFileSync(beforeArchive, readFileSync(target.file));
  const seen = fake.calls().length;
  const swapped = run();
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /the release manifest records/);
  assert.equal(fake.calls().length, seen);
  const exercise = step(
    "archive-acceptance",
    "Exercise packaged install and same-source version transition offline",
  );
  assert.equal(exercise.env.MEND_TEST_OFFLINE, "1");
  assert.equal(exercise.env.MEND_TEST_IMAGE_IDENTITY, "digest");
  assert.equal(exercise.env.MEND_TEST_IMAGE_ID, "${{ steps.images.outputs.before }}");
  assert.equal(exercise.env.MEND_TEST_UPGRADE_IMAGE_ID, "${{ steps.images.outputs.target }}");
  assert.equal(exercise.env.MEND_TEST_CLI_TARBALL, "${{ steps.cli.outputs.tarball }}");
});

test("the manifest job writes from this run's records, whichever merge ran", (t) => {
  const job = jobs["release-manifest"];
  assert.ok(job.needs.includes("merge") && job.needs.includes("archive-merge"));
  assert.match(job.if, /^!cancelled\(\) && /);
  const write = step("release-manifest", "Write release-manifest.json");
  const directory = scratch(t);
  const { digests, indexes } = records(directory);
  const record = cliRecord("tarball");
  const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", write.run], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: directory,
      VERSION: "1.2.3",
      BEFORE: "0.0.0-acceptance.9.1",
      COMMIT,
      DIGESTS: digests,
      INDEXES: indexes,
      CLI: JSON.stringify(record),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const written = JSON.parse(
    readFileSync(path.join(directory, "manifest/release-manifest.json"), "utf8"),
  );
  assert.deepEqual(written.cli, record);
  assert.equal(written.images["mend-api"].index, `sha256:${hex("mend-api")}`);
});

// --- the index imagetools create pushed ---

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
/** A registry document: its bytes and the digest it is read by. */
const doc = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: sha256(bytes), value };
};
const imageManifest = (arch) =>
  doc({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${hex(arch)}`,
      size: 1,
    },
    layers: [],
  });
const childOf = (manifest, os, architecture, variant) => ({
  mediaType: OCI_MANIFEST,
  digest: manifest.digest,
  size: manifest.bytes.length,
  platform: { os, architecture, ...(variant ? { variant } : {}) },
});
/** BuildKit's attestation entry for `manifest`. */
const attestationOf = (manifest) => ({
  mediaType: OCI_MANIFEST,
  digest: `sha256:${hex(`attestation of ${manifest.digest}`)}`,
  size: 1,
  platform: { os: "unknown", architecture: "unknown" },
  annotations: {
    "vnd.docker.reference.digest": manifest.digest,
    "vnd.docker.reference.type": "attestation-manifest",
  },
});
const indexOf = (manifests) => doc({ schemaVersion: 2, mediaType: OCI_INDEX, manifests });
const created = (index) => ({
  "containerimage.descriptor": { mediaType: OCI_INDEX, digest: index.digest },
});
const amd64 = imageManifest("amd64");
const arm64 = imageManifest("arm64");
const plainChildren = [childOf(amd64, "linux", "amd64"), childOf(arm64, "linux", "arm64")];

test("an index made from two plain image manifests is the one create reported", () => {
  const index = indexOf(plainChildren);
  assert.equal(checkIndex(created(index), index.bytes, [amd64, arm64]), index.digest);
  // containerimage.digest, where buildx writes it, must agree with the descriptor.
  assert.equal(
    checkIndex({ ...created(index), "containerimage.digest": index.digest }, index.bytes, [
      amd64,
      arm64,
    ]),
    index.digest,
  );
  assert.throws(
    () =>
      checkIndex({ ...created(index), "containerimage.digest": amd64.digest }, index.bytes, [
        amd64,
        arm64,
      ]),
    /two different ones/,
  );
  assert.throws(() => checkIndex({}, index.bytes, [amd64, arm64]), /no index digest/);
});

test("an index made from attested single-platform indexes holds each source's children", () => {
  const sources = [amd64, arm64].map((manifest, at) =>
    indexOf([plainChildren[at], attestationOf(manifest)]),
  );
  const index = indexOf(sources.flatMap((source) => source.value.manifests));
  assert.equal(checkIndex(created(index), index.bytes, sources), index.digest);
  // An attestation of a source left out is a source's manifest missing.
  const partial = indexOf([...plainChildren, attestationOf(amd64)]);
  assert.throws(() => checkIndex(created(partial), partial.bytes, sources), /lacks sha256:/);
  // A source index of two platforms is not one arch's build.
  const both = indexOf(plainChildren);
  assert.throws(() => checkIndex(created(both), both.bytes, [both]), /more than one platform/);
});

test("an index missing one source's manifest is refused", () => {
  const other = imageManifest("someone else's arm64");
  const index = indexOf([plainChildren[0], childOf(other, "linux", "arm64")]);
  assert.throws(
    () => checkIndex(created(index), index.bytes, [amd64, arm64]),
    new RegExp(`lacks ${arm64.digest}`),
  );
});

test("an index whose platforms are not exactly linux/amd64 and linux/arm64 is refused", () => {
  const arm = imageManifest("arm/v7");
  for (const [children, sources] of [
    [
      [plainChildren[0], childOf(arm, "linux", "arm", "v7")],
      [amd64, arm],
    ],
    [
      [plainChildren[0], childOf(arm64, "linux", "amd64")],
      [amd64, arm64],
    ],
    [[plainChildren[0]], [amd64]],
  ]) {
    const index = indexOf(children);
    assert.throws(
      () => checkIndex(created(index), index.bytes, sources),
      /not linux\/amd64 and linux\/arm64/,
    );
  }
  // Nor may it hold a manifest no source gave it.
  const extra = indexOf([...plainChildren, childOf(imageManifest("extra"), "linux", "riscv64")]);
  assert.throws(() => checkIndex(created(extra), extra.bytes, [amd64, arm64]), /from no source/);
});

test("the audit's case: a single arm64 manifest in place of the created index is refused", () => {
  // Reported as created, the lone manifest is not a multi-arch index.
  assert.throws(
    () => checkIndex(created(arm64), arm64.bytes, [amd64, arm64]),
    /single image manifest, not a multi-arch index/,
  );
  // Create reported its own index; bytes read for any other digest (the moved tag's) do not hash to it.
  const index = indexOf(plainChildren);
  assert.throws(() => checkIndex(created(index), arm64.bytes, [amd64, arm64]), /does not hash to/);
  // The index the moved tag names, a lone arm64 child, fails on its own terms too.
  const moved = indexOf([plainChildren[1]]);
  assert.throws(() => checkIndex(created(moved), moved.bytes, [amd64, arm64]), /lacks/);
});

test("no step learns the index digest from the tag; both merges check what create reported", (t) => {
  const tagInspect = /imagetools inspect "\$REPOSITORY:\$(?:VERSION|tag)"(.*)$/;
  for (const [name, job] of Object.entries(jobs))
    for (const entry of job.steps ?? [])
      for (const line of (entry.run ?? "").split("\n")) {
        const found = tagInspect.exec(line);
        if (found === null) continue;
        // Only the log of what was pushed names the tag (finalize-images, in release-cli.yml,
        // reads :<version> on purpose, to refuse a spent version).
        assert.ok(found[1] === "", `${name} "${entry.name}" reads the tag: ${line.trim()}`);
      }
  for (const job of ["merge", "archive-merge"]) {
    const create = jobs[job].steps.find((entry) => /imagetools create/.test(entry.run ?? ""));
    assert.match(
      create.run,
      /imagetools create --metadata-file "\$RUNNER_TEMP\/index\/create\.json"/,
    );
    const record = step(job, "Check and record the index digest");
    assert.match(record.run, /check-index create\.json index\.json/);
    assert.match(record.run, /inspect "\$REPOSITORY@\$digest" --raw >index\.json/);
    const steps = jobs[job].steps;
    const upload = steps.findIndex((entry) => entry.with?.name === "index-${{ matrix.image.id }}");
    assert.ok(upload > steps.indexOf(record), `${job} uploads the digest after checking it`);
  }

  // merge's step as written, its /tmp/digests moved to a fixture, against a registry stand-in
  // whose tag has moved to a lone arm64 index: it records the index create reported.
  const directory = scratch(t);
  const digests = path.join(directory, "digests");
  const documents = path.join(directory, "documents");
  const work = path.join(directory, "index");
  for (const dir of [digests, documents, work, path.join(directory, "bin")]) mkdirSync(dir);
  const index = indexOf(plainChildren);
  for (const entry of [amd64, arm64, index, indexOf([plainChildren[1]])])
    writeFileSync(path.join(documents, entry.digest), entry.bytes);
  for (const entry of [amd64, arm64]) writeFileSync(path.join(digests, entry.digest.slice(7)), "");
  writeFileSync(path.join(work, "create.json"), JSON.stringify(created(index)));
  writeFileSync(
    path.join(directory, "bin", "docker"),
    `#!${process.execPath}
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = args[3]?.indexOf("@") ?? -1;
if (args.slice(0, 3).join(" ") !== "buildx imagetools inspect" || args[4] !== "--raw" || at < 0) process.exit(79);
process.stdout.write(readFileSync(${JSON.stringify(documents)} + "/" + args[3].slice(at + 1)));
`,
  );
  chmodSync(path.join(directory, "bin", "docker"), 0o755);
  const record = step("merge", "Check and record the index digest");
  const run = (create) => {
    writeFileSync(path.join(work, "create.json"), JSON.stringify(create));
    return spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-c", record.run.replaceAll("/tmp/digests", digests)],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
          REPOSITORY: "ghcr.invalid/fixture/mend",
          GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
        },
      },
    );
  };
  const recorded = run(created(index));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(readFileSync(path.join(work, "digest"), "utf8"), `${index.digest}\n`);
  // Had create reported the lone index the tag now names, nothing would be recorded.
  rmSync(path.join(work, "digest"));
  const lone = run(created(indexOf([plainChildren[1]])));
  assert.equal(lone.status, 1);
  assert.match(lone.stderr, /lacks/);
  assert.equal(readFileSync(path.join(work, "digest"), "utf8"), "");
});

// A status-function call in a job's `if`, ignoring quoted strings: `'always()' != ''` names none.
const callsStatusFunction = (condition) =>
  /\b(always|cancelled|success|failure)\s*\(\s*\)/.test(
    String(condition ?? "").replace(/'(?:[^']|'')*'/g, "''"),
  );

// GitHub's rule, which the static checks above do not see: a job whose `if` names no status
// function (always, cancelled, success, failure) runs only if every job above it, however far up,
// succeeded, and a skipped job counts as not succeeded. Run 38917070036, the first dry run, skipped
// archive acceptance this way: merge, skipped on an archive run, sits above release-manifest.
const simulateRun = (target, { graph = jobs, event = "push" } = {}) => {
  const needsOf = (name) => [graph[name].needs ?? []].flat();
  const ancestors = (name, seen = new Set()) => {
    for (const need of needsOf(name)) if (!seen.has(need)) ancestors(need, seen.add(need));
    return seen;
  };
  const result = {};
  const pending = new Set(Object.keys(graph));
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => needsOf(name).every((need) => need in result));
    assert.ok(ready.length > 0, "the workflow's needs form a cycle");
    for (const name of ready) {
      let expression = (graph[name].if ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
      if (!callsStatusFunction(expression))
        expression = expression === "" ? "success()" : `success() && (${expression})`;
      const allAbove = [...ancestors(name)].every((job) => result[job] === "success");
      const script = expression
        .replace(/!cancelled\(\)/g, "true")
        .replace(/always\(\)/g, "true")
        .replace(/success\(\)/g, String(allAbove))
        .replace(/failure\(\)/g, "false")
        .replace(/inputs\.target/g, JSON.stringify(target))
        .replace(/github\.event_name/g, JSON.stringify(event))
        .replace(/github\.repository/g, JSON.stringify("sealant-sh/mend"))
        .replace(/needs\.([\w-]+)\.result/g, (_, need) => JSON.stringify(result[need]))
        .replace(/!=/g, "!==")
        .replace(/(?<![!=])==/g, "===");
      result[name] = Function(`"use strict"; return (${script});`)() ? "success" : "skipped";
      pending.delete(name);
    }
  }
  return result;
};

test("on each target, GitHub runs that target's acceptance though the other target's jobs were skipped", () => {
  const archive = simulateRun("archive");
  assert.equal(archive["archive-acceptance"], "success");
  assert.equal(archive["packaged-smoke"], "skipped");
  for (const name of ["build", "merge"]) assert.equal(archive[name], "skipped", name);
  const ghcr = simulateRun("ghcr");
  assert.equal(ghcr["packaged-smoke"], "success");
  assert.equal(ghcr["archive-acceptance"], "skipped");
  for (const name of ["archive-build", "archive-merge"]) assert.equal(ghcr[name], "skipped", name);
  for (const run of [archive, ghcr]) assert.equal(run["release-manifest"], "success");
});

test("a tag push runs finalize, npm and promotion; a dry-run dispatch runs acceptance and none of them", () => {
  const graph = parse(
    readFileSync(new URL("../.github/workflows/release-cli.yml", import.meta.url), "utf8"),
  ).jobs;
  const push = simulateRun("ghcr", { graph, event: "push" });
  for (const name of ["acceptance", "finalize-images", "github-release", "npm", "promote-images"])
    assert.equal(push[name], "success", name);
  const dispatch = simulateRun("archive", { graph, event: "workflow_dispatch" });
  assert.equal(dispatch.acceptance, "success");
  for (const name of ["finalize-images", "github-release", "npm", "promote-images"])
    assert.equal(dispatch[name], "skipped", name);
});

// The same rule across every workflow. A job whose `if` names no status function is skipped when
// any job above it was. Each such job below a job that can be skipped is listed here with why that
// skip is also this job's; a new one fails until someone has looked.
const SKIPPED_TOGETHER = new Map([
  // Only a fork skips version; everything below it should skip there too.
  ["image.yml build", "same target as its ancestors; version skips only on a fork"],
  ["image.yml merge", "same target as its ancestors; version skips only on a fork"],
  ["image.yml archive-build", "same target as its ancestors; version skips only on a fork"],
  ["image.yml archive-merge", "same target as its ancestors; version skips only on a fork"],
  ["image.yml cli", "version skips only on a fork"],
  // Every publishing job runs on a tag push, and none on a dispatch.
  ["release-cli.yml npm", "its ancestors carry the same push condition"],
  ["release-cli.yml promote-images", "its ancestors carry the same push condition"],
  // Nothing publishes on a pull request.
  [
    "publish-vscode.yml github-release",
    "publish is skipped only on a pull request, where this is too",
  ],
  // A preview without a sealantd or Core ref builds neither the image nor its source.
  ["preview.yml sealantd", "plan skips only on a fork"],
  ["preview.yml sealantd-image", "skipped exactly when there is no sealantd ref to preview"],
  ["preview.yml core", "plan skips only on a fork"],
  ["preview.yml core-images", "skipped exactly when there is no Core ref to preview"],
]);

test("no workflow job is skipped behind a job its own path expected to skip, unless reviewed", () => {
  const directory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  const exposed = [];
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const { jobs: all = {} } = parse(readFileSync(path.join(directory, file), "utf8")) ?? {};
    const needsOf = (name) => [all[name]?.needs ?? []].flat();
    const ancestors = (name, seen = new Set()) => {
      for (const need of needsOf(name)) if (!seen.has(need)) ancestors(need, seen.add(need));
      return seen;
    };
    for (const [name, job] of Object.entries(all)) {
      if (callsStatusFunction(job.if)) continue;
      if ([...ancestors(name)].some((above) => all[above]?.if !== undefined)) {
        exposed.push(`${file} ${name}`);
      }
    }
  }
  assert.deepEqual(exposed.toSorted(), [...SKIPPED_TOGETHER.keys()].toSorted());
});

test("a status function inside a quoted string is not a status function", () => {
  assert.equal(callsStatusFunction("inputs.target == 'archive' && 'always()' != ''"), false);
  assert.equal(callsStatusFunction("${{ !cancelled() && inputs.target == 'ghcr' }}"), true);
  assert.equal(callsStatusFunction("always( )"), true);
  assert.equal(callsStatusFunction("github.event_name == 'push'"), false);
  assert.equal(callsStatusFunction(undefined), false);
});
