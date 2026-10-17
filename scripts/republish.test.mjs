// The publish job's republish block, run as written in this repository's workflow, against a stub
// npm registry on 127.0.0.1, with tarballs crafted the ways three reviews found to fool a check of
// the tarball as built. Mend's block publishes the run's own normalized tarball byte for byte and
// checks the registry's integrity after; sealant-sh/sealant and sealant-sh/sealantd still rebuild
// the tarball they publish, so their copies of this file differ from this one.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  block,
  COMMIT,
  goodEntries,
  manifest,
  NAME,
  PACOTE,
  publish,
  registry,
  seeded,
  sha512,
  tarGz,
} from "./republish.helpers.mjs";

test("a tarball whose sha512 is not the manifest's is refused before npm runs", async (t) => {
  const stub = await registry(t, seeded());
  const tampered = [...goodEntries("0.39.0-next.9"), ["package/dist/extra.js", "evil();\n"]];
  const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9", "next", {
    tamper: tampered,
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /has another sha512 than the release manifest records/);
  assert.equal(stub.log.length, 0);
});

test("a release manifest of another version, commit or file is refused before npm runs", async (t) => {
  for (const [record, problem] of [
    [{ version: "0.39.0-next.8" }, /is for 0\.39\.0-next\.8, not 0\.39\.0-next\.9/],
    [{ commit: "beef" }, /is from beef, not c0ffee/],
    [{ cli: { file: "other.tgz", sha512: "0", integrity: "sha512-x" } }, /names other\.tgz/],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9", "next", {
      record,
    });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    assert.equal(stub.log.length, 0);
  }
});

test("a tarball that is not normalized is refused, never rewritten: `tag`, scripts, publishConfig, .npmrc", async (t) => {
  for (const [entries, problem] of [
    [[["package/package.json", manifest("0.39.0-next.9", { tag: "latest" })]], /it keeps tag/],
    [
      [["package/package.json", manifest("0.39.0-next.9", { scripts: { postinstall: "x" } })]],
      /it keeps scripts/,
    ],
    [
      [
        [
          "package/package.json",
          manifest("0.39.0-next.9", {
            publishConfig: { tag: "latest", registry: "https://evil.example/", access: "public" },
          }),
        ],
      ],
      /publishConfig holds more than access/,
    ],
    [
      [...goodEntries("0.39.0-next.9"), ["package/.npmrc", "registry=https://evil.example/\n"]],
      /it holds \.npmrc/,
    ],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, entries, "0.39.0-next.9");
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    assert.equal(stub.log.length, 0);
  }
});

/**
 * The guarantee, whichever manifest a given pacote keeps from a crafted tarball: either nothing is
 * published, or exactly the version, commit and dist-tag this run expects, from a manifest with no
 * `tag` and no scripts. (pacote releases differ in which duplicate entry wins; both outcomes hold.)
 */
const publishedOnlyWhatWasChecked = (stub, result, version) => {
  if (result.status !== 0) {
    assert.equal(stub.log.length, 0, result.output);
    return;
  }
  assert.equal(stub.log.length, 1, result.output);
  const [entry] = stub.log;
  assert.equal(entry.publish, version);
  assert.deepEqual(entry.distTags, { next: version });
  assert.equal(entry.manifest.gitHead, COMMIT);
  assert.equal(entry.manifest.tag, undefined);
  assert.equal(entry.manifest.scripts, undefined);
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
};

for (const [trick, name] of [
  ["package/./package.json", "package/./package.json"],
  ["package//package.json", "package//package.json"],
  ["a second manifest outside package/", "zzz/package.json"],
]) {
  test(`${trick}: only what was checked can be published`, async (t) => {
    const stub = await registry(t, seeded());
    const entries = [
      ...goodEntries("0.39.0-next.9"),
      [name, manifest("0.39.0", { tag: "latest" })],
    ];
    publishedOnlyWhatWasChecked(
      stub,
      await publish(t, stub, entries, "0.39.0-next.9"),
      "0.39.0-next.9",
    );
  });
}

test("a second manifest with this version but a forged commit cannot publish under it", async (t) => {
  const stub = await registry(t, seeded());
  const entries = [
    ...goodEntries("0.39.0-next.9"),
    ["package//package.json", manifest("0.39.0-next.9", { gitHead: "forged", tag: "latest" })],
  ];
  publishedOnlyWhatWasChecked(
    stub,
    await publish(t, stub, entries, "0.39.0-next.9"),
    "0.39.0-next.9",
  );
});

test("with npm's own pacote today, the crafted manifests are the ones read, and refused", async (t) => {
  // The pacote this test runs (npm's bundled one) reads the later entry; the job pins its own.
  const stub = await registry(t, seeded());
  const entries = [
    ...goodEntries("0.39.0-next.9"),
    ["zzz/package.json", manifest("0.39.0", { tag: "latest" })],
  ];
  const result = await publish(t, stub, entries, "0.39.0-next.9");
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /version 0\.39\.0, not 0\.39\.0-next\.9/);
});

test("an artifact holding anything but the expected tarball or manifest is refused before npm runs", async (t) => {
  for (const [file, text] of [
    [".npmrc", "https-proxy=http://127.0.0.1:9/\nstrict-ssl=false\n"],
    ["extra.tgz", "x"],
    ["notes.txt", "x"],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9", "next", {
      artifact: { [file]: text },
    });
    assert.notEqual(result.status, 0, file);
    assert.match(result.output, /more than the expected tarballs/);
    assert.equal(stub.log.length, 0);
  }
});

test("from the empty directory, a .npmrc beside the tarball configures nothing", async (t) => {
  // A proxy that does not exist: npm would fail every request if it read this file.
  const stub = await registry(t, seeded());
  const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9", "next", {
    artifact: { ".npmrc": "proxy=http://127.0.0.1:9/\nhttps-proxy=http://127.0.0.1:9/\n" },
    skipCheck: true,
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
});

test("a root binding.gyp is refused: npm would turn it into an install script", async (t) => {
  const stub = await registry(t, seeded());
  const entries = [...goodEntries("0.39.0-next.9"), ["package/binding.gyp", "{ 'targets': [] }"]];
  const result = await publish(t, stub, entries, "0.39.0-next.9");
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /binding\.gyp/);
  assert.equal(stub.log.length, 0);
});

test("a prerelease must be a -next package, or Mend itself", async (t) => {
  const plain = "@sealant/sdk";
  const seed = { [plain]: { name: plain, versions: {}, "dist-tags": { latest: "0.38.1" } } };
  const entries = [
    ["package/package.json", manifest("0.39.0-next.9", {}, plain)],
    ["package/dist/index.js", ""],
  ];
  const stub = await registry(t, seed);
  const result = await publish(t, stub, entries, "0.39.0-next.9", "next", { name: plain });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /@sealant\/sdk is not a -next package/);
  assert.equal(stub.log.length, 0);
});

test("a -next package's sibling dependency must be its exact -next alias", async (t) => {
  const exact = {
    dependencies: { "@sealant/api-contracts": "npm:@sealant/api-contracts-next@0.39.0-next.9" },
  };
  const ok = await registry(t, seeded());
  const accepted = await publish(
    t,
    ok,
    [
      ["package/package.json", manifest("0.39.0-next.9", exact)],
      ["package/dist/index.js", ""],
    ],
    "0.39.0-next.9",
  );
  assert.equal(accepted.status, 0, accepted.output);
  assert.deepEqual(ok.log[0].manifest.dependencies, exact.dependencies);
  for (const spec of [
    "npm:@evil/api-contracts@0.39.0-next.9",
    "npm:@sealant/api-contracts-next@0.39.0-next.8",
    "npm:@sealant/api-contracts@0.39.0",
    "0.39.0-next.9",
  ]) {
    const stub = await registry(t, seeded());
    const entries = [
      [
        "package/package.json",
        manifest("0.39.0-next.9", { dependencies: { "@sealant/api-contracts": spec } }),
      ],
      ["package/dist/index.js", ""],
    ];
    const result = await publish(t, stub, entries, "0.39.0-next.9");
    assert.notEqual(result.status, 0, spec);
    assert.equal(stub.log.length, 0, spec);
  }
  // An alias to anything else is refused as well.
  const other = await registry(t, seeded());
  const aliased = await publish(
    t,
    other,
    [
      [
        "package/package.json",
        manifest("0.39.0-next.9", { dependencies: { effect: "npm:evil@1.0.0" } }),
      ],
      ["package/dist/index.js", ""],
    ],
    "0.39.0-next.9",
  );
  assert.notEqual(aliased.status, 0);
});

test("the block's check and normalize-npm-tarball.mjs --check give the same answers", async (t) => {
  // The publisher runs no repository file, so it carries the check written out; this holds the
  // copy to the script image.yml's cli job ran.
  const normalizer = fileURLToPath(new URL("./normalize-npm-tarball.mjs", import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), "republish-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = "0.39.0-next.9";
  const cases = {
    normalized: goodEntries(version),
    "a tag": [["package/package.json", manifest(version, { tag: "latest" })]],
    scripts: [["package/package.json", manifest(version, { scripts: { prepare: "x" } })]],
    "publishConfig beyond access": [
      [
        "package/package.json",
        manifest(version, { publishConfig: { access: "public", tag: "x" } }),
      ],
    ],
    "publishConfig without access": [
      ["package/package.json", manifest(version, { publishConfig: {} })],
    ],
    "only access": [
      ["package/package.json", manifest(version, { publishConfig: { access: "public" } })],
    ],
    "an .npmrc": [...goodEntries(version), ["package/lib/.npmrc", "x=1\n"]],
    "a binding.gyp": [...goodEntries(version), ["package/binding.gyp", "{}"]],
    "a forged commit": [["package/package.json", manifest(version, { gitHead: "forged" })]],
    "another version": [["package/package.json", manifest("0.39.0-next.8")]],
    "a stable version": [["package/package.json", manifest("0.39.0")]],
    "a plain name under next": [["package/package.json", manifest(version, {}, "@sealant/sdk")]],
    "an alias": [["package/package.json", manifest(version, { dependencies: { a: "npm:b@1" } })]],
    "a sibling alias": [
      [
        "package/package.json",
        manifest(version, {
          dependencies: { "@sealant/api-contracts": `npm:@sealant/api-contracts-next@${version}` },
        }),
      ],
    ],
  };
  const answers = {};
  for (const [label, entries] of Object.entries(cases)) {
    const tarball = path.join(directory, `${Object.keys(answers).length}.tgz`);
    writeFileSync(tarball, tarGz(entries));
    const args = [NAME, version, COMMIT, "next"];
    const fromBlock = await new Promise((resolve) => {
      const child = spawn(
        "bash",
        ["-c", `set -euo pipefail\n${block}\ncheck_tarball "$@"`, "check", tarball, ...args],
        { env: { ...process.env, REPUBLISH_TEST_PACOTE: PACOTE }, stdio: "ignore" },
      );
      child.on("close", resolve);
    });
    const script = spawnSync(
      process.execPath,
      [
        normalizer,
        "--check",
        tarball,
        "--name",
        NAME,
        "--version",
        version,
        "--commit",
        COMMIT,
        "--channel",
        "next",
      ],
      { env: { ...process.env, NORMALIZE_PACOTE: PACOTE }, encoding: "utf8" },
    ).status;
    answers[label] = [fromBlock === 0, script === 0];
  }
  for (const [label, [byBlock, byScript]] of Object.entries(answers))
    assert.equal(byBlock, byScript, `${label}: block ${byBlock}, script ${byScript}`);
  assert.deepEqual(
    Object.entries(answers)
      .filter(([, [accepted]]) => accepted)
      .map(([label]) => label),
    ["normalized", "only access", "a sibling alias"],
  );
});
