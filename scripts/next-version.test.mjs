import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { changeset, repository } from "./next-version.helpers.mjs";
import {
  changesetLevels,
  compareNext,
  highestStableTag,
  isNextVersion,
  nextVersion,
  nextVersionOf,
  planNext,
  previewVersion,
  previewVersionOf,
  registryRecord,
  strayNextBuilds,
} from "./next-version.mjs";

test("the base is the larger of what the changesets imply and what was already handed out", () => {
  const plan = (changesets, packageVersion = "0.36.0", handedOut = []) =>
    planNext({
      tags: ["v0.35.1", "v0.36.0", "cli-v0.9.0", "v0.37.0-next.4", ""],
      names: ["@sealant/sdk", "@sealant/api-contracts"],
      changesets,
      packageVersion,
      handedOut,
    }).base;
  assert.equal(plan([]), "0.36.1");
  assert.equal(plan([changeset([["@sealant/sdk", "patch"]])]), "0.36.1");
  // Any minor in the package's fixed group wins over patches.
  assert.equal(
    plan([
      changeset([["@sealant/sdk", "patch"]]),
      changeset([["@sealant/api-contracts", "minor"]]),
    ]),
    "0.37.0",
  );
  assert.equal(plan([changeset([["@sealant/sdk", "major"]])]), "1.0.0");
  // Another package's changeset does not count.
  assert.equal(plan([changeset([["@sealant/workspaces", "minor"]])]), "0.36.1");
  // After the Version Packages merge and before the tag, the bumped package version.
  assert.equal(plan([], "0.37.0"), "0.37.0");
  // A base already handed out above the last tag holds, whatever the changesets say now.
  assert.equal(plan([], "0.36.0", ["0.37.0-next.3120"]), "0.37.0");
  // Builds at or below the last tag no longer count.
  assert.equal(plan([], "0.36.0", ["0.36.0-next.3000", "0.35.2-next.10"]), "0.36.1");
  assert.equal(highestStableTag(["v0.9.0", "v0.10.0", "v0.10.0-next.3"]), "v0.10.0");
  assert.throws(() => planNext({ tags: ["cli-v0.4.0"], names: [], changesets: [] }), /No stable/);
});

test("changeset frontmatter is read the way changesets writes it", () => {
  assert.deepEqual(changesetLevels(`---\n'@sealant/mend': minor\n"@sealant/sdk": patch\n---\nx`), [
    { name: "@sealant/mend", level: "minor" },
    { name: "@sealant/sdk", level: "patch" },
  ]);
  assert.deepEqual(changesetLevels("no frontmatter"), []);
});

test("versions sort the way the channels are meant to move", () => {
  assert.equal(nextVersion("0.36.0", 3120), "0.36.0-next.3120");
  assert.equal(previewVersion("0.36.0", 12, 40), "0.36.0-next.12.preview.40");
  assert.throws(() => previewVersion("0.36.0", 12, "0"), /run number/);
  assert.ok(isNextVersion("0.36.0-next.0"));
  assert.ok(!isNextVersion("0.36.0-next.01"));
  assert.ok(!isNextVersion("0.36.0-next.12.preview.4"));
  assert.ok(!isNextVersion("0.36.0-preview.17"));
  assert.ok(compareNext("0.36.1-next.9", "0.37.0-next.2") < 0);
  assert.ok(compareNext("0.36.0-next.10", "0.36.0-next.9") > 0);
  assert.ok(compareNext("0.36.0-next.99", "0.36.0") < 0);
});

test("a stable release refuses next builds it would leave out", () => {
  const builds = [
    { version: "0.36.0-next.60", commit: "a" },
    { version: "0.36.0-next.64", commit: "d" },
    { version: "0.36.1-next.2", commit: "e" },
  ];
  assert.deepEqual(
    strayNextBuilds({ version: "0.36.0", builds, isAncestor: (commit) => commit === "a" }),
    [{ version: "0.36.0-next.64", commit: "d" }],
  );
});

test("the reviewed histories: a minor before a patch's tag, a reverted minor, a tag, a preview", (t) => {
  const r = repository(t);
  const published = [];
  const publish = () => {
    const version = nextVersionOf("HEAD", "apps/cli", published);
    const last = published.at(-1);
    if (last !== undefined) assert.ok(compareNext(version, last) > 0, `${version} after ${last}`);
    published.push(version);
    return version;
  };
  r.setVersion("0.36.0");
  r.commit("release 0.36.0");
  r.git("tag", "v0.36.0");

  r.write(".changeset/fix.md", changeset([["@sealant/mend", "patch"]]));
  r.commit("fix");
  assert.equal(publish(), "0.36.1-next.2");

  // The patch's Version Packages merge.
  r.remove(".changeset/fix.md");
  r.setVersion("0.36.1");
  const versionCommit = r.commit("chore: version packages");
  assert.equal(publish(), "0.36.1-next.3");

  // A minor lands before the tag.
  r.write(".changeset/feature.md", changeset([["@sealant/mend", "minor"]]));
  r.commit("feature");
  assert.equal(publish(), "0.37.0-next.4");
  r.commit("another");
  assert.equal(publish(), "0.37.0-next.5");

  // The tag goes on the Version Packages commit, behind HEAD: nothing restarts.
  r.git("tag", "v0.36.1", versionCommit);
  r.commit("after the tag");
  assert.equal(publish(), "0.37.0-next.6");

  // The minor's changeset is reverted: the base already handed out holds.
  r.remove(".changeset/feature.md");
  r.commit("revert feature");
  assert.equal(publish(), "0.37.0-next.7");

  // A preview of this commit sorts after its next build.
  r.git("checkout", "-q", "-b", "feature");
  r.commit("feature one");
  assert.equal(
    previewVersionOf("HEAD", "main", 7, "apps/cli", published),
    "0.37.0-next.7.preview.7",
  );
  r.git("checkout", "-q", "main");

  // A shallow clone would count too few commits: refused.
  const shallow = mkdtempSync(path.join(tmpdir(), "next-version-shallow-"));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.repo}`, shallow]);
  process.chdir(shallow);
  assert.throws(() => nextVersionOf("HEAD", "apps/cli"), /shallow clone/);
  process.chdir(r.repo);
});

const response = (status, body = {}) => ({ ok: status === 200, status, json: async () => body });
const noWait = { delay: () => 0 };

test("the npm lookup retries, and fails closed on a 404, a 5xx or a network error", async () => {
  const record = {
    versions: { "0.39.0-next.9": { gitHead: "abc" } },
    "dist-tags": { next: "0.39.0-next.9" },
  };
  let calls = 0;
  const flaky = async () => (++calls < 3 ? response(503) : response(200, record));
  assert.deepEqual(await registryRecord("@sealant/sdk", { fetchImpl: flaky, ...noWait }), record);
  assert.equal(calls, 3);
  // Every package read here exists: a 404 is not "nothing published".
  await assert.rejects(
    registryRecord("@sealant/sdk", { fetchImpl: async () => response(404), ...noWait }),
    /npm answered 404/,
  );
  await assert.rejects(
    registryRecord("@sealant/sdk", { fetchImpl: async () => response(500), ...noWait }),
    /npm answered 500/,
  );
  await assert.rejects(
    registryRecord("@sealant/sdk", {
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
      ...noWait,
    }),
    /ECONNRESET/,
  );
});

test("--newer exits 0 only for a newer next version, and fails closed on garbage", () => {
  const newer = (a, b) =>
    spawnSync("node", [new URL("./next-version.mjs", import.meta.url).pathname, "--newer", a, b])
      .status;
  assert.equal(newer("0.36.0-next.62", "0.36.0-next.60"), 0);
  assert.equal(newer("0.37.0-next.1", "0.36.0-next.900"), 0);
  assert.equal(newer("0.36.0-next.60", "0.36.0-next.62"), 1);
  assert.equal(newer("0.36.0-next.60", "0.36.0-next.60"), 1);
  assert.equal(newer("0.36.0-next.60", "0.36.0"), 1);
  assert.equal(newer("garbage", "0.36.0-next.1"), 1);
  assert.equal(newer("0.36.0-next.1", "garbage"), 1);
});

test("both complete versions must be canonical before comparing different or equal cores", () => {
  const invalid = [
    "0.37.0-next.garbage",
    "0.36.0-next.garbage",
    "0.36.0-next.",
    "0.36.0-next.01",
    "0.36.0-next.-1",
    "0.36.0-next.1extra",
    "0.36.0-next.1.preview.4",
    "0.36.0+build",
    "0.36.0-alpha.1",
    "v0.36.0",
    "00.36.0",
    "0.036.0",
    "0.36.00",
    "0.36",
    "0.36.0.1",
    "0.36.0-next.1 ",
    "0.36.0\n",
    "0.36.0-next.Infinity",
    "0.36.0-next.NaN",
    "0.36.0-next.1e3",
    "0.36.0-next.1.2",
    "garbage",
  ];
  const valid = ["0.35.0-next.1", "0.36.0-next.1", "0.37.0-next.1", "0.36.0"];
  for (const bad of invalid) {
    for (const control of valid) {
      for (const [a, b] of [
        [bad, control],
        [control, bad],
      ]) {
        const run = spawnSync(process.execPath, [
          new URL("./next-version.mjs", import.meta.url).pathname,
          "--newer",
          a,
          b,
        ]);
        assert.equal(run.status, 1, "the public --newer CLI accepted malformed input");
        assert.equal(run.stdout.length, 0);
        assert.equal(run.stderr.length, 0);
        assert.ok(Number.isNaN(compareNext(a, b)), "invalid input produced an order");
      }
    }
  }
  for (const bad of [undefined, null, 123, {}, []]) {
    assert.ok(Number.isNaN(compareNext(bad, "0.36.0-next.1")));
    assert.ok(Number.isNaN(compareNext("0.36.0-next.1", bad)));
  }
});

test("the public newer comparison preserves stable and next ordering after full validation", () => {
  const pairs = [
    ["0.37.0-next.0", "0.36.0-next.999", 1],
    ["0.36.1-next.0", "0.36.0-next.999", 1],
    ["1.0.0-next.0", "0.99.99", 1],
    ["0.36.0", "0.36.0-next.999", 1],
    ["0.36.0-next.10", "0.36.0-next.9", 1],
    ["0.36.0-next.1", "0.36.0-next.0", 1],
    ["0.36.0", "0.36.0", 0],
    ["0.36.0-next.0", "0.36.0-next.0", 0],
  ];
  for (const [a, b, order] of pairs) {
    for (const [left, right, expected] of [
      [a, b, order],
      [b, a, -order],
    ]) {
      assert.equal(Math.sign(compareNext(left, right)), expected === 0 ? 0 : expected);
      const run = spawnSync(process.execPath, [
        new URL("./next-version.mjs", import.meta.url).pathname,
        "--newer",
        left,
        right,
      ]);
      assert.equal(run.status, expected > 0 ? 0 : 1);
      assert.equal(run.stdout.length, 0);
      assert.equal(run.stderr.length, 0);
    }
  }
});

test("publishing only some commits, with merge commits in main, still only goes up", (t) => {
  const levels = ["patch", "minor", "major"];
  const bump = (version, level) => {
    const [a, b, c] = version.split(".").map(Number);
    return level === "major"
      ? `${a + 1}.0.0`
      : level === "minor"
        ? `${a}.${b + 1}.0`
        : `${a}.${b}.${c + 1}`;
  };
  const random = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (const seed of [21, 22, 23, 24, 25, 26]) {
    const r = repository(t);
    const pick = random(seed);
    let tagged = "0.36.0";
    let changesets = new Map();
    let counter = 0;
    r.setVersion(tagged);
    r.commit("release");
    r.git("tag", `v${tagged}`);
    const published = [];
    const steps = [];
    for (let step = 0; step < 20; step += 1) {
      const roll = pick();
      let op = "plain";
      if (roll < 0.25) {
        op = roll < 0.15 ? "patch" : "minor";
        const file = `.changeset/c${(counter += 1)}.md`;
        r.write(file, changeset([["@sealant/mend", op]]));
        changesets.set(file, op);
        r.commit(op);
      } else if (roll < 0.4) {
        // A merge commit: a side branch of two commits, merged without fast-forward.
        op = "merge a branch";
        r.git("checkout", "-q", "-b", `side${step}`);
        r.commit("side one");
        r.commit("side two");
        r.git("checkout", "-q", "main");
        r.git("merge", "-q", "--no-ff", "-m", "merge", `side${step}`);
      } else if (roll < 0.5) {
        op = "revert a minor changeset";
        const minor = [...changesets].find(([, level]) => level === "minor");
        if (minor !== undefined) {
          r.remove(minor[0]);
          changesets.delete(minor[0]);
        }
        r.commit(op);
      } else if (roll < 0.62 && changesets.size > 0) {
        op = "version packages, then tag it";
        const level = [...changesets.values()].reduce(
          (top, value) => Math.max(top, levels.indexOf(value)),
          0,
        );
        tagged = bump(tagged, levels[level]);
        for (const file of changesets.keys()) r.remove(file);
        changesets = new Map();
        r.setVersion(tagged);
        const sha = r.commit(op);
        r.git("tag", `v${tagged}`, sha);
      } else {
        r.commit(op);
      }
      // Like Mend: only some commits get a next build handed out.
      if (pick() < 0.5) continue;
      const next = nextVersionOf("HEAD", "apps/cli", published);
      steps.push(`${op} → ${next}`);
      const last = published.at(-1);
      if (last !== undefined)
        assert.ok(compareNext(next, last) > 0, `seed ${seed}:\n${steps.join("\n")}`);
      published.push(next);
    }
  }
});
