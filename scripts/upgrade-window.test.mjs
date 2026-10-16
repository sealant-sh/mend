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
  lockfileProblems,
  migrationLevelProblems,
  seededStateProblems,
} from "./check-previous-upgrade.mjs";
import { checkPins, planFor, resolveWindow, waiverNotes, waiversFor } from "./upgrade-window.mjs";

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

test("a dry run today resolves to 0.35.1 and the newest next, and fails when it resolves to nothing", () => {
  const plan = planFor({
    candidate: "0.0.0-dryrun.38931186422.1",
    releaseOfMain: () => "0.36.0-next.988",
    live: TODAY,
    pins,
    waivers: [],
  });
  assert.equal(plan.release, "0.36.0-next.988");
  assert.deepEqual(plan.transitions, [
    { from: "0.36.0-next.792", waived: "" },
    { from: "0.35.1", waived: "" },
  ]);
  // A dev or acceptance build takes main's window too.
  assert.equal(
    planFor({
      candidate: "0.0.0-dev.sha0123456789ab",
      releaseOfMain: () => "0.36.0-next.988",
      live: TODAY,
      pins,
      waivers: [],
    }).transitions.length,
    2,
  );
  assert.throws(
    () =>
      planFor({
        candidate: "0.0.0-dryrun.1.1",
        releaseOfMain: () => "0.36.0-next.988",
        live: { versions: [], markers: { stable: [] } },
        pins,
        waivers: [],
      }),
    /has no published release to upgrade from/,
  );
  assert.throws(
    () =>
      planFor({
        candidate: "0.0.0-dryrun.1.1",
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
  // A marker at or above the candidate is a retry or the guards' business, not the window's.
  assert.deepEqual(
    resolveWindow("0.35.1", TODAY.versions, { stable: [["npm latest", "0.35.1"]] }),
    ["0.35.0"],
  );
});

test("every release in the window needs its pins, and the committed pins are complete", () => {
  checkPins(pins, ["0.35.1", "0.36.0-next.792"]);
  assert.throws(
    () => checkPins(pins, ["0.35.1", "0.36.0-next.780"]),
    /has no pins for 0\.36\.0-next\.780, inside the upgrade window/,
  );
  const broken = structuredClone(pins);
  broken.releases["0.35.1"].images.mend = "0.35.1";
  assert.throws(() => checkPins(broken, ["0.35.1"]), /0\.35\.1: images\.mend/);
  delete broken.releases["0.35.1"].assets["install.sh"];
  broken.releases["0.35.1"].images.mend = pins.releases["0.35.1"].images.mend;
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
    checkpoints: ["a", "b"],
    commentId: "c",
    commentBody: "kept",
    marker: "proof",
  };
  const after = {
    projects: [{ id: "p" }],
    sessionId: "s",
    checkpoints: ["a", "b", "c"],
    comments: [{ id: "c", body: "kept" }],
    patch: "+proof",
  };
  assert.deepEqual(seededStateProblems(before, after), []);
  assert.deepEqual(
    seededStateProblems(before, {
      projects: [],
      sessionId: undefined,
      checkpoints: ["a"],
      comments: [{ id: "c", body: "edited" }],
      patch: "",
    }),
    [
      "project p is gone",
      "session s is gone",
      "checkpoint b is gone",
      "comment c changed",
      "the Review slice no longer shows the change",
    ],
  );
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
