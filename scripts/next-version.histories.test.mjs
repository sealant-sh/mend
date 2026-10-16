// The next channel's numbering over generated git histories: whatever lands, is reverted or is
// tagged, each published version is newer than the last.
import assert from "node:assert/strict";
import test from "node:test";

import { changeset, repository } from "./next-version.helpers.mjs";
import { compareNext, nextVersionOf } from "./next-version.mjs";

test("every generated history publishes strictly increasing versions", (t) => {
  const levels = ["patch", "minor", "major"];
  const bump = (version, level) => {
    const [a, b, c] = version.split(".").map(Number);
    return level === "major"
      ? `${a + 1}.0.0`
      : level === "minor"
        ? `${a}.${b + 1}.0`
        : `${a}.${b}.${c + 1}`;
  };
  // A small deterministic generator, so a failure names a reproducible seed.
  const random = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const seen = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const r = repository(t);
    const pick = random(seed);
    let tagged = "0.36.0";
    let version = tagged;
    let changesets = new Map();
    let counter = 0;
    let versionPr;
    r.setVersion(version);
    r.commit("release");
    r.git("tag", `v${tagged}`);
    const published = [];
    const steps = [];
    for (let step = 0; step < 24; step += 1) {
      const roll = pick();
      let op;
      if (roll < 0.22) {
        op = "patch";
        const file = `.changeset/c${(counter += 1)}.md`;
        r.write(file, changeset([["@sealant/mend", "patch"]]));
        changesets.set(file, "patch");
      } else if (roll < 0.36) {
        op = "minor";
        const file = `.changeset/c${(counter += 1)}.md`;
        r.write(file, changeset([["@sealant/mend", "minor"]]));
        changesets.set(file, "minor");
      } else if (roll < 0.46) {
        op = "revert a minor changeset";
        const minor = [...changesets].find(([, level]) => level === "minor");
        if (minor !== undefined) {
          r.remove(minor[0]);
          changesets.delete(minor[0]);
        }
      } else if (roll < 0.62 && changesets.size > 0 && versionPr === undefined) {
        op = "version packages";
        const level = [...changesets.values()].reduce(
          (top, value) => Math.max(top, levels.indexOf(value)),
          0,
        );
        const before = { version, changesets: new Map(changesets) };
        version = bump(tagged, levels[level]);
        for (const file of changesets.keys()) r.remove(file);
        changesets = new Map();
        r.setVersion(version);
        versionPr = { before, version };
      } else if (roll < 0.7 && versionPr !== undefined) {
        op = "revert the version packages merge";
        version = versionPr.before.version;
        changesets = versionPr.before.changesets;
        for (const [file, level] of changesets)
          r.write(file, changeset([["@sealant/mend", level]]));
        r.setVersion(version);
        versionPr = undefined;
      } else if (roll < 0.86 && versionPr !== undefined && versionPr.commit !== undefined) {
        // The tag goes on the Version Packages commit, which may be behind HEAD by now.
        op = `tag v${versionPr.version}`;
        r.git("tag", `v${versionPr.version}`, versionPr.commit);
        tagged = versionPr.version;
        versionPr = undefined;
      } else {
        op = "plain";
      }
      seen.add(op.startsWith("tag ") ? "tag" : op);
      const sha = r.commit(op);
      if (op === "version packages") versionPr.commit = sha;
      const next = nextVersionOf("HEAD", "apps/cli", published);
      steps.push(`${op} → ${next}`);
      const last = published.at(-1);
      if (last !== undefined) {
        assert.ok(compareNext(next, last) > 0, `seed ${seed}:\n${steps.join("\n")}`);
      }
      published.push(next);
    }
  }
  // The histories cover every move the scheme has to survive.
  assert.deepEqual([...seen].sort(), [
    "minor",
    "patch",
    "plain",
    "revert a minor changeset",
    "revert the version packages merge",
    "tag",
    "version packages",
  ]);
});
