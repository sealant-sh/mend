// The upgrade window, its pins and its waivers (scripts/upgrade-window.mjs), the pieces of the
// previous-release upgrade that run without Docker (scripts/check-previous-upgrade.mjs), and the
// image.yml and release-cli.yml jobs that use them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  fileComment,
  lockfileProblems,
  migrationLevelProblems,
  prepareFixtureContainer,
  seededStateProblems,
} from "./check-previous-upgrade.mjs";
import {
  checkPins,
  githubLatest,
  imageLabel,
  npmMarkers,
  planFor,
  resolveWindow,
  waiverNotes,
  waiversFor,
} from "./upgrade-window.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const pins = JSON.parse(read("release/upgrade-from.json"));

// npm's list and markers for @sealant/mend as they read on 2026-10-16.
const TODAY = {
  versions: [
    "0.33.0",
    "0.34.2",
    "0.35.0",
    "0.35.1",
    "0.36.0-next.601",
    "0.36.0-next.780",
    "0.36.0-next.792",
  ],
  markers: {
    stable: [
      ["npm latest", "0.35.1"],
      ["GitHub's latest release", "0.35.1"],
      ["ghcr.io/sealant-sh/mend:latest", "0.35.1"],
    ],
    next: "0.36.0-next.792",
  },
};

const labelledConfig = (label) => ({
  config: { Labels: label === undefined ? {} : { "org.opencontainers.image.version": label } },
});
const inspectAnswer = (image) => ({ status: 0, stdout: JSON.stringify(image), stderr: "" });
const docker = async (args) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  assert.equal(result.status, 0, `docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

test("a stable candidate upgrades from the highest stable below it", () => {
  assert.deepEqual(resolveWindow("0.36.0", TODAY.versions, TODAY.markers), ["0.35.1"]);
  assert.deepEqual(resolveWindow("0.35.1", TODAY.versions, TODAY.markers), ["0.35.0"]);
});

test("a next candidate upgrades from the newest next below it and the highest stable", () => {
  assert.deepEqual(resolveWindow("0.36.0-next.988", TODAY.versions, TODAY.markers), [
    "0.36.0-next.792",
    "0.35.1",
  ]);
  // A next build older than the highest stable is superseded by it.
  const after = { ...TODAY, versions: [...TODAY.versions, "0.36.0"] };
  assert.deepEqual(
    resolveWindow("0.37.0-next.3", after.versions, {
      stable: [["npm latest", "0.36.0"]],
      next: "0.36.0-next.792",
    }),
    ["0.36.0"],
  );
});

test("a dry run today resolves to 0.35.1 and the newest next, takes the full path, and fails when it resolves to nothing", () => {
  // release-cli.yml stamps a dry run above main's next build: it is upgraded to, not refused.
  const plan = planFor({
    candidate: "0.36.0-next.988.dryrun.38931186422.1",
    releaseOfMain: () => assert.fail("a dry run carries its own release"),
    live: TODAY,
    pins,
    waivers: [],
  });
  assert.equal(plan.release, "0.36.0-next.988");
  assert.equal(plan.derived, false);
  assert.deepEqual(plan.transitions, [
    { from: "0.36.0-next.792", waived: "" },
    { from: "0.35.1", waived: "" },
  ]);
  // The stamp sorts above its own next build: a published next.N is in its window.
  assert.deepEqual(
    planFor({
      candidate: "0.36.0-next.792.dryrun.1.1",
      releaseOfMain: () => assert.fail("a dry run carries its own release"),
      live: TODAY,
      pins,
      waivers: [],
    }).transitions.map(({ from }) => from),
    ["0.36.0-next.792", "0.35.1"],
  );
  // A dev or acceptance build, and the older dry-run form, take main's window and are the only
  // candidates whose upgrade is not tested.
  for (const candidate of [
    "0.0.0-dev.sha0123456789ab",
    "0.0.0-acceptance.9.1",
    "0.0.0-dryrun.9.1",
  ]) {
    const derived = planFor({
      candidate,
      releaseOfMain: () => "0.36.0-next.988",
      live: TODAY,
      pins,
      waivers: [],
    });
    assert.equal(derived.derived, true, candidate);
    assert.equal(derived.transitions.length, 2, candidate);
  }
  assert.throws(
    () =>
      planFor({
        candidate: "0.36.0-next.988.dryrun.1.1",
        releaseOfMain: () => "unused",
        live: { versions: [], markers: { stable: [] } },
        pins,
        waivers: [],
      }),
    /has no published release to upgrade from/,
  );
  assert.throws(
    () =>
      planFor({
        candidate: "0.0.0-dev.1",
        releaseOfMain: () => "0.0.0-dev.sha0123",
        live: TODAY,
        pins,
        waivers: [],
      }),
    /main would release 0\.0\.0-dev\.sha0123, not a stable or next version/,
  );
});

test("the live markers must agree with npm's list", () => {
  for (const markers of [
    { stable: [["GitHub's latest release", "0.35.0"]], next: "0.36.0-next.792" },
    { stable: [["ghcr.io/sealant-sh/mend:latest", "0.34.2"]] },
    { stable: [], next: "0.36.0-next.780" },
  ])
    assert.throws(
      () => resolveWindow("0.36.0-next.988", TODAY.versions, markers),
      /but the (highest stable release|newest next) below 0\.36\.0-next\.988 is/,
    );
  // npm's next inside the window must be in npm's list too, or its leg would go missing silently.
  assert.throws(
    () =>
      resolveWindow("0.36.0-next.900", ["0.35.1"], {
        stable: [["npm latest", "0.35.1"]],
        next: "0.36.0-next.792",
      }),
    /npm's next is 0\.36\.0-next\.792, which npm's version list lacks/,
  );
  // A next build a stable release superseded is left out, its marker included.
  assert.deepEqual(
    resolveWindow("0.37.0-next.1", ["0.35.1", "0.36.0-next.792", "0.36.0"], {
      stable: [["npm latest", "0.36.0"]],
      next: "0.36.0-next.792",
    }),
    ["0.36.0"],
  );
  // A marker at or above the candidate is a retry or the guards' business, not the window's.
  assert.deepEqual(
    resolveWindow("0.35.1", TODAY.versions, { stable: [["npm latest", "0.35.1"]] }),
    ["0.35.0"],
  );
});

test("every stable release in the window needs its pins; a next build's are read live", () => {
  // Only stable releases are committed: a next build in the window needs nothing here.
  checkPins(pins, ["0.35.1", "0.36.0-next.792"]);
  assert.deepEqual(Object.keys(pins.releases), ["0.35.1"]);
  assert.throws(
    () => checkPins(pins, ["0.35.0", "0.36.0-next.780"]),
    /has no pins for 0\.35\.0, inside the upgrade window/,
  );
  const broken = structuredClone(pins);
  broken.releases["0.35.1"].images.mend = "0.35.1";
  assert.throws(() => checkPins(broken, ["0.35.1"]), /images holds the mend digest alone/);
  // mend-api and mend-web are not pinned: the scenario does not run them.
  broken.releases["0.35.1"].images = {
    ...pins.releases["0.35.1"].images,
    "mend-api": pins.releases["0.35.1"].images.mend,
  };
  assert.throws(() => checkPins(broken, ["0.35.1"]), /images holds the mend digest alone/);
  delete broken.releases["0.35.1"].assets["install.sh"];
  broken.releases["0.35.1"].images = { mend: pins.releases["0.35.1"].images.mend };
  assert.throws(() => checkPins(broken, ["0.35.1"]), /assets\.install\.sh/);
});

test("each pinned CLI installs from its committed lockfile, bound to the pinned integrity", () => {
  for (const [version, entry] of Object.entries(pins.releases)) {
    const lock = JSON.parse(read(entry.npm.lockfile));
    assert.deepEqual(lockfileProblems(lock, version, entry.npm.integrity), [], version);
    const manifest = JSON.parse(read(`release/upgrade-from/${version}/package.json`));
    assert.deepEqual(manifest.dependencies, { "@sealant/mend": version });
  }
  const lock = JSON.parse(read(pins.releases["0.35.1"].npm.lockfile));
  assert.deepEqual(lockfileProblems(lock, "0.35.1", "sha512-other"), [
    "its @sealant/mend integrity is not the pinned sha512-other",
  ]);
  const loose = structuredClone(lock);
  delete loose.packages["node_modules/react"].integrity;
  assert.deepEqual(lockfileProblems(loose, "0.35.1", pins.releases["0.35.1"].npm.integrity), [
    "node_modules/react has no sha512 integrity",
  ]);
});

const waiver = (version, from, extra = {}) => ({
  version,
  from,
  reason: "0.35.1's assets predate the setup contract the candidate reads",
  approvedBy: "Yiannis",
  ...extra,
});

test("a waiver stands in only for exactly its candidate and release, and is never a pass", () => {
  const waivers = [waiver("0.36.0", "0.35.1")];
  const plan = planFor({
    candidate: "0.36.0",
    releaseOfMain: () => assert.fail("a release candidate takes no main window"),
    live: TODAY,
    pins,
    waivers,
  });
  assert.deepEqual(plan.transitions, [
    {
      from: "0.35.1",
      waived:
        "0.35.1's assets predate the setup contract the candidate reads (approved by Yiannis)",
    },
  ]);
  // An older candidate's waiver does not carry forward to the next one.
  for (const candidate of ["0.36.1", "0.36.0-next.988"])
    assert.ok(waiversFor(waivers, candidate).size === 0, candidate);
  assert.throws(() => waiversFor([waiver("0.36.0", "0.35.1", { approvedBy: "" })], "0.36.0"));
  assert.throws(() => waiversFor({ version: "0.36.0" }, "0.36.0"), /must be a list/);
  assert.throws(
    () => waiversFor([waiver("0.36.0", "0.35.1"), waiver("0.36.0", "0.35.1")], "0.36.0"),
    /two waivers/,
  );
  // The committed file waives nothing.
  assert.deepEqual(JSON.parse(read("release/upgrade-waivers.json")), []);
});

test("a stable release's notes carry its waived upgrade from a stable release", () => {
  const waivers = [waiver("0.36.0", "0.35.1"), waiver("0.36.0", "0.36.0-next.792")];
  assert.equal(
    waiverNotes(waivers, "0.36.0"),
    "**Upgrade testing waived**\n\n- The upgrade from 0.35.1 was not tested: 0.35.1's assets predate the setup contract the candidate reads (waiver approved by Yiannis).\n",
  );
  assert.equal(waiverNotes(waivers, "0.36.1"), "");
  assert.equal(waiverNotes([waiver("0.36.0-next.990", "0.35.1")], "0.36.0-next.990"), "");
});

/** release-cli.yml's github-release notes step as written, in a tree holding `waivers`. */
const releaseNotes = (t, version, waivers) => {
  const directory = mkdtempSync(path.join(tmpdir(), "upgrade-notes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of [
    "scripts/upgrade-window.mjs",
    "scripts/next-version.mjs",
    "apps/cli/CHANGELOG.md",
  ]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(directory, file));
  }
  mkdirSync(path.join(directory, "release"));
  writeFileSync(path.join(directory, "release/upgrade-waivers.json"), JSON.stringify(waivers));
  const { jobs } = parse(read(".github/workflows/release-cli.yml"));
  const step = jobs["github-release"].steps.find(
    (entry) => entry.name === "Extract this version's changelog section",
  );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_REF_NAME: `v${version}` },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(path.join(directory, "release-notes.md"), "utf8");
};

test("the github-release job writes a stable release's waivers into its notes", (t) => {
  const notes = releaseNotes(t, "0.36.0", [waiver("0.36.0", "0.35.1")]);
  assert.match(
    notes,
    /\*\*Upgrade testing waived\*\*\n\n- The upgrade from 0\.35\.1 was not tested/,
  );
  assert.doesNotMatch(releaseNotes(t, "0.36.0", []), /waived/);
  assert.doesNotMatch(releaseNotes(t, "0.36.0", [waiver("0.35.9", "0.35.1")]), /waived/);
});

test("Mend's migrations must be exactly the candidate's", () => {
  const manifest = "mend 0001_init\nmend 0002_users\nsealant 0000_x hash\n";
  assert.deepEqual(
    migrationLevelProblems(
      [
        { id: 1, name: "init" },
        { id: 2, name: "users" },
      ],
      manifest,
    ),
    [],
  );
  assert.deepEqual(migrationLevelProblems([{ id: 1, name: "init" }], manifest), [
    "migration 2_users is not applied",
  ]);
  assert.deepEqual(
    migrationLevelProblems(
      [
        { id: 1, name: "init" },
        { id: 2, name: "users" },
        { id: 3, name: "later" },
      ],
      manifest,
    ),
    ["migration 3_later is applied but not shipped"],
  );
  assert.deepEqual(migrationLevelProblems([], "sealant 0000_x h\n"), [
    "the candidate image lists no Mend migration",
  ]);
});

test("the seeded state must survive the upgrade whole", () => {
  const before = {
    projectId: "p",
    sessionId: "s",
    checkpoints: [
      { ordinal: 0, sha: "a" },
      { ordinal: 1, sha: "b" },
    ],
    commentId: "c",
    commentBody: "kept",
  };
  const after = {
    projects: [{ id: "p" }],
    sessionId: "s",
    checkpoints: [...before.checkpoints, { ordinal: 2, sha: "c" }],
    comments: [{ id: "c", body: "kept" }],
  };
  assert.deepEqual(seededStateProblems(before, after), []);
  assert.deepEqual(
    seededStateProblems(before, {
      projects: [],
      sessionId: undefined,
      checkpoints: [
        { ordinal: 0, sha: "a" },
        { ordinal: 1, sha: "z" },
      ],
      comments: [{ id: "c", body: "edited" }],
    }),
    [
      "project p is gone",
      "session s is gone",
      "checkpoint 1 (b) is gone or changed",
      "comment c changed",
    ],
  );
});

test("the seeded comment is one both old servers accept: file-level, every location null", () => {
  // Each old release's own target check (scripts/fixtures/review-comment-target, from its tag),
  // run against the scenario's payload, with the committed file in the slice.
  const payload = fileComment("upgrade-proof.txt", "kept across the upgrade");
  const files = [{ oldPath: null, newPath: "upgrade-proof.txt" }];
  for (const tag of ["v0.35.1", "v0.36.0-next.792"]) {
    const check = read(`scripts/fixtures/review-comment-target/${tag}.js.txt`);
    const verdict = (target) =>
      Function(
        "payload",
        "files",
        "lineAnchorExists",
        `${check}\nreturn targetValid;`,
      )({ ...payload, target }, files, () => assert.fail("a file-level target checks no hunk"));
    assert.equal(verdict(payload.target), true, tag);
    // The line anchor the first version sent, without its hunk hash, is what both refused.
    assert.equal(verdict({ ...payload.target, side: "new", startLine: 1, endLine: 1 }), false, tag);
  }
});

const dockerUsable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

test(
  "the Git fixture is prepared in a volume at /fixture, since no image has it",
  { skip: !dockerUsable && "needs a Docker daemon" },
  async (t) => {
    // busybox stands for the old Mend image here: like it, it has no /fixture.
    const image =
      "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
    await docker(["pull", image]);
    assert.notEqual(
      spawnSync("docker", ["run", "--rm", image, "test", "-d", "/fixture"]).status,
      0,
    );
    const directory = mkdtempSync(path.join(tmpdir(), "fixture-volume-"));
    const name = `mend-previous-upgrade-test-${process.pid}-${Date.now()}`;
    t.after(() => {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      spawnSync("docker", ["volume", "rm", "-f", name], { stdio: "ignore" });
      rmSync(directory, { recursive: true, force: true });
    });
    const bare = path.join(directory, "repo.git");
    mkdirSync(bare);
    writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
    const script = path.join(directory, "packaged-git-fixture.mjs");
    writeFileSync(script, "// fixture\n");
    await prepareFixtureContainer(docker, {
      name,
      image,
      network: "none",
      bare,
      files: [script],
      entrypoint: "true",
      command: [],
    });
    const listed = await docker([
      "run",
      "--rm",
      "--mount",
      `type=volume,source=${name},target=/fixture`,
      image,
      "sh",
      "-c",
      "cat /fixture/repo.git/HEAD && ls /fixture",
    ]);
    assert.match(listed, /ref: refs\/heads\/main/);
    assert.match(listed, /packaged-git-fixture\.mjs/);
  },
);

test("a marker in the wrong shape fails the window; only a real absence is absent", () => {
  const ok = {
    "dist-tags": { latest: "0.35.1", next: "0.36.0-next.792" },
    versions: { "0.35.1": {} },
  };
  assert.deepEqual(npmMarkers(ok), {
    latest: "0.35.1",
    next: "0.36.0-next.792",
    versions: ["0.35.1"],
  });
  assert.equal(npmMarkers({ "dist-tags": {}, versions: {} }).latest, undefined);
  for (const broken of [
    [],
    { ...ok, "dist-tags": [] },
    { ...ok, "dist-tags": null },
    { ...ok, versions: [] },
    { ...ok, "dist-tags": { latest: null } },
    { ...ok, "dist-tags": { latest: "" } },
    { ...ok, "dist-tags": { latest: "0.35.1 x" } },
    { ...ok, "dist-tags": { latest: "9223372036854775808.0.0" } },
    { ...ok, "dist-tags": { next: "0.36.0" } },
  ])
    assert.throws(() => npmMarkers(broken), JSON.stringify(broken));
  assert.equal(githubLatest(undefined), undefined);
  assert.equal(githubLatest({ tag_name: "v0.35.1" }), "0.35.1");
  for (const broken of [{}, { tag_name: "v" }, { tag_name: "0.35.1" }, { tag_name: 5 }, null, []])
    assert.throws(() => githubLatest(broken), JSON.stringify(broken));
  const ref = "ghcr.io/sealant-sh/mend-web:latest";
  assert.equal(
    imageLabel(
      ref,
      inspectAnswer({
        "linux/amd64": labelledConfig("0.35.1"),
        "linux/arm64": labelledConfig("0.35.1"),
      }),
    ),
    "0.35.1",
  );
  assert.equal(imageLabel(ref, inspectAnswer(labelledConfig("0.35.1"))), "0.35.1");
  assert.equal(
    imageLabel(ref, { status: 1, stdout: "", stderr: `ERROR: ${ref}: not found\n` }),
    undefined,
  );
  for (const broken of [
    inspectAnswer({ "linux/amd64": labelledConfig(), "linux/arm64": labelledConfig() }),
    inspectAnswer({
      "linux/amd64": labelledConfig("0.35.1"),
      "linux/arm64": labelledConfig("0.35.0"),
    }),
    inspectAnswer({}),
    inspectAnswer([]),
    { status: 0, stdout: "not json", stderr: "" },
    { status: 1, stdout: "", stderr: `ERROR: ${ref}: not found\nERROR: unauthorized\n` },
    { status: 1, stdout: "", stderr: "ERROR: failed to do request: connection refused\n" },
  ])
    assert.throws(() => imageLabel(ref, broken), JSON.stringify(broken));
});

test("image.yml upgrades from every release in the window, in both modes, gated by acceptance", () => {
  const { jobs } = parse(read(".github/workflows/image.yml"));
  const window = jobs["upgrade-window"];
  assert.equal(window.needs, "version");
  assert.equal(window.steps[0].with["fetch-depth"], 0);
  assert.equal(window.steps.at(-1).run, 'node scripts/upgrade-window.mjs plan "$VERSION"');
  for (const [name, target] of [
    ["previous-upgrade", "ghcr"],
    ["archive-previous-upgrade", "archive"],
  ]) {
    const job = jobs[name];
    assert.ok(job.needs.includes("upgrade-window"), name);
    assert.ok(job.needs.includes("release-manifest"), name);
    assert.match(job.if, new RegExp(`inputs\\.target == '${target}'`));
    assert.match(job.if, /needs\.upgrade-window\.result == 'success'/);
    assert.equal(
      job.strategy.matrix.transition,
      "${{ fromJSON(needs.upgrade-window.outputs.transitions) }}",
    );
    assert.deepEqual(job.strategy.matrix.runner, ["ubuntu-24.04", "ubuntu-24.04-arm"]);
    assert.equal(job.strategy["fail-fast"], false);
    const scenario = job.steps.find(
      (step) => step.run === "node scripts/check-previous-upgrade.mjs",
    );
    assert.equal(scenario.if, "matrix.transition.waived == ''");
    assert.equal(scenario.env.MEND_UPGRADE_FROM, "${{ matrix.transition.from }}");
    assert.equal(scenario.env.MEND_TEST_OFFLINE, target === "archive" ? "1" : undefined);
    const waived = job.steps.find((step) => step.name === "Record a waived transition");
    assert.equal(waived.if, "matrix.transition.waived != ''");
    assert.match(waived.run, /GITHUB_STEP_SUMMARY/);
    // Nothing that holds a write token: the job reads public releases and this run's artifacts.
    assert.ok(!Object.values(job.permissions).includes("write"), name);
  }
});
