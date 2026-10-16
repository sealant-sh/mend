// scripts/normalize-npm-tarball.mjs, run as image.yml's cli job runs it, on tarballs crafted the
// ways republish.test.mjs found to fool a check of the tarball as built: the rewrite those cases
// prove for the publisher holds for the one tarball acceptance installs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const script = fileURLToPath(new URL("./normalize-npm-tarball.mjs", import.meta.url));
// npm's bundled pacote by default; NORMALIZE_PACOTE runs the same tests against another one.
const PACOTE =
  process.env.NORMALIZE_PACOTE ??
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "npm/node_modules/pacote",
  );

/** A ustar archive of `entries` (name → text), names as given, so any path trick can be written. */
const tarGz = (entries) => {
  const blocks = [];
  for (const [name, text] of entries) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = [...header].reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
};

const NAME = "@sealant/mend";
const COMMIT = "c0ffee";
const VERSION = "0.39.0-next.9";
const manifest = (version, extra = {}, name = NAME) =>
  JSON.stringify({
    name,
    version,
    gitHead: COMMIT,
    main: "./dist/index.js",
    files: ["dist"],
    scripts: { prepack: "echo never", postpack: "echo never" },
    devDependencies: { vitest: "1.0.0" },
    ...extra,
  });
const goodEntries = (version = VERSION, extra = {}, name = NAME) => [
  ["package/package.json", manifest(version, extra, name)],
  ["package/dist/index.js", "export {};\n"],
];

/** Runs the script on a crafted tarball; `args` replace the expected name/version/commit. */
const normalize = (t, entries, args = [], { check = false, tarball } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "normalize-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = tarball ?? path.join(directory, "in.tgz");
  if (tarball === undefined) writeFileSync(input, tarGz(entries));
  const out = path.join(directory, "out");
  mkdirSync(out);
  const result = spawnSync(
    process.execPath,
    [
      script,
      ...(check ? ["--check"] : ["--out", out]),
      input,
      ...(args.length > 0 ? args : ["--name", NAME, "--version", VERSION, "--commit", COMMIT]),
    ],
    { encoding: "utf8", env: { ...process.env, NORMALIZE_PACOTE: PACOTE } },
  );
  const files = readdirSync(out);
  const printed = result.status === 0 ? JSON.parse(result.stdout) : undefined;
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    printed,
    out,
    files,
    input,
    /** The package.json inside the result, read back with tar. */
    manifest: () =>
      JSON.parse(
        execFileSync("tar", ["-xzOf", path.join(out, files[0]), "package/package.json"], {
          encoding: "utf8",
        }),
      ),
  };
};

test("a good tarball is rewritten without its scripts, and its digests are npm's", (t) => {
  const result = normalize(t, goodEntries());
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.files, ["sealant-mend-0.39.0-next.9.tgz"]);
  const written = result.manifest();
  assert.equal(written.scripts, undefined);
  assert.equal(written.devDependencies, undefined);
  assert.equal(written.gitHead, COMMIT);
  assert.equal(result.printed.file, "sealant-mend-0.39.0-next.9.tgz");
  // The script refuses a pack whose file differs from the integrity npm reports for it.
  const digest = createHash("sha512")
    .update(readFileSync(path.join(result.out, result.files[0])))
    .digest();
  assert.equal(result.printed.sha512, digest.toString("hex"));
  assert.equal(result.printed.integrity, `sha512-${digest.toString("base64")}`);
});

test("a `tag` field in the manifest is dropped, and publishConfig keeps only access", (t) => {
  const result = normalize(
    t,
    goodEntries(VERSION, {
      tag: "latest",
      publishConfig: { tag: "latest", registry: "https://evil.example/", access: "public" },
    }),
  );
  assert.equal(result.status, 0, result.output);
  const written = result.manifest();
  assert.equal(written.tag, undefined);
  assert.deepEqual(written.publishConfig, { access: "public" });
});

test("a packed .npmrc, wherever it sits, does not reach the repacked tarball", (t) => {
  const result = normalize(t, [
    ...goodEntries(),
    ["package/.npmrc", "registry=https://evil.example/\n"],
    ["package/dist/.npmrc", "registry=https://evil.example/\n"],
  ]);
  assert.equal(result.status, 0, result.output);
  const listing = execFileSync("tar", ["-tzf", path.join(result.out, result.files[0])], {
    encoding: "utf8",
  });
  assert.doesNotMatch(listing, /\.npmrc/);
});

/**
 * The guarantee, whichever manifest a given pacote keeps from a crafted tarball: either nothing is
 * written, or exactly the version and commit this run expects, from a manifest with no `tag` and
 * no scripts.
 */
const onlyWhatWasChecked = (result) => {
  if (result.status !== 0) {
    assert.deepEqual(result.files, [], result.output);
    return;
  }
  const written = result.manifest();
  assert.equal(written.version, VERSION);
  assert.equal(written.gitHead, COMMIT);
  assert.equal(written.tag, undefined);
  assert.equal(written.scripts, undefined);
};

for (const [trick, name] of [
  ["package/./package.json", "package/./package.json"],
  ["package//package.json", "package//package.json"],
  ["a second manifest outside package/", "zzz/package.json"],
]) {
  test(`${trick}: only what was checked is written`, (t) => {
    onlyWhatWasChecked(
      normalize(t, [...goodEntries(), [name, manifest("0.39.0", { tag: "latest" })]]),
    );
  });
}

test("a second manifest with this version but a forged commit is not written under it", (t) => {
  onlyWhatWasChecked(
    normalize(t, [
      ...goodEntries(),
      ["package//package.json", manifest(VERSION, { gitHead: "forged", tag: "latest" })],
    ]),
  );
});

test("with npm's own pacote today, the crafted manifest is the one read, and refused", (t) => {
  const result = normalize(t, [...goodEntries(), ["zzz/package.json", manifest("0.39.0")]]);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /version 0\.39\.0, not 0\.39\.0-next\.9/);
  assert.deepEqual(result.files, []);
});

test("a wrong name, version or commit is refused", (t) => {
  for (const [args, problem] of [
    [["--name", "@sealant/other", "--version", VERSION, "--commit", COMMIT], /name @sealant\/mend/],
    [
      ["--name", NAME, "--version", "0.39.0-next.8", "--commit", COMMIT],
      /version 0\.39\.0-next\.9/,
    ],
    [["--name", NAME, "--version", VERSION, "--commit", "beef"], /gitHead c0ffee, not beef/],
  ]) {
    const result = normalize(t, goodEntries(), args);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    assert.deepEqual(result.files, []);
  }
});

test("a root binding.gyp is refused: npm would turn it into an install script", (t) => {
  const result = normalize(t, [...goodEntries(), ["package/binding.gyp", "{ 'targets': [] }"]]);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /binding\.gyp/);
  assert.deepEqual(result.files, []);
});

test("a channel adds the publisher's checks: the version's shape, and a -next name under next", (t) => {
  const args = (name, version, channel) => [
    "--name",
    name,
    "--version",
    version,
    "--commit",
    COMMIT,
    "--channel",
    channel,
  ];
  assert.equal(normalize(t, goodEntries(VERSION), args(NAME, VERSION, "next")).status, 0);
  assert.equal(normalize(t, goodEntries("0.39.0"), args(NAME, "0.39.0", "latest")).status, 0);
  assert.notEqual(normalize(t, goodEntries(VERSION), args(NAME, VERSION, "latest")).status, 0);
  const plain = normalize(
    t,
    goodEntries(VERSION, {}, "@sealant/sdk"),
    args("@sealant/sdk", VERSION, "next"),
  );
  assert.notEqual(plain.status, 0);
  assert.match(plain.output, /@sealant\/sdk is not a -next package/);
  // Without a channel, a candidate's dev version is normalized as it is.
  const dev = "0.0.0-dev.sha0123456789ab";
  assert.equal(
    normalize(t, goodEntries(dev), ["--name", NAME, "--version", dev, "--commit", COMMIT]).status,
    0,
  );
});

test("a -next package's sibling dependency must be its exact -next alias; other aliases are refused", (t) => {
  const sdk = "@sealant/sdk-next";
  const args = ["--name", sdk, "--version", VERSION, "--commit", COMMIT];
  const exact = {
    dependencies: { "@sealant/api-contracts": `npm:@sealant/api-contracts-next@${VERSION}` },
  };
  const accepted = normalize(t, goodEntries(VERSION, exact, sdk), args);
  assert.equal(accepted.status, 0, accepted.output);
  assert.deepEqual(accepted.manifest().dependencies, exact.dependencies);
  for (const spec of [
    `npm:@evil/api-contracts@${VERSION}`,
    "npm:@sealant/api-contracts-next@0.39.0-next.8",
    "npm:@sealant/api-contracts@0.39.0",
    VERSION,
  ]) {
    const result = normalize(
      t,
      goodEntries(VERSION, { dependencies: { "@sealant/api-contracts": spec } }, sdk),
      args,
    );
    assert.notEqual(result.status, 0, spec);
    assert.deepEqual(result.files, [], spec);
  }
  const aliased = normalize(
    t,
    goodEntries(VERSION, { dependencies: { effect: "npm:evil@1.0.0" } }),
  );
  assert.notEqual(aliased.status, 0);
  assert.match(aliased.output, /effect is an alias/);
});

test("check mode accepts the normalized tarball and prints the same digests, writing nothing", (t) => {
  const normalized = normalize(t, goodEntries(VERSION, { tag: "latest" }));
  assert.equal(normalized.status, 0, normalized.output);
  const tarball = path.join(normalized.out, normalized.files[0]);
  const before = readFileSync(tarball);
  const checked = normalize(t, [], [], { check: true, tarball });
  assert.equal(checked.status, 0, checked.output);
  assert.deepEqual(checked.printed, normalized.printed);
  assert.deepEqual(readFileSync(tarball), before);
  assert.deepEqual(checked.files, []);
});

test("check mode refuses a tarball that is not normalized, and never repacks it", (t) => {
  for (const [entries, problem] of [
    [goodEntries(), /it keeps scripts, devDependencies/],
    [
      [
        [
          "package/package.json",
          JSON.stringify({
            ...JSON.parse(manifest(VERSION)),
            scripts: undefined,
            devDependencies: undefined,
            tag: "latest",
          }),
        ],
        ["package/dist/index.js", ""],
      ],
      /it keeps tag/,
    ],
    [
      [
        [
          "package/package.json",
          JSON.stringify({
            name: NAME,
            version: VERSION,
            gitHead: COMMIT,
            publishConfig: { access: "public", registry: "https://evil.example/" },
          }),
        ],
      ],
      /publishConfig holds more than access/,
    ],
    [
      [
        ["package/package.json", JSON.stringify({ name: NAME, version: VERSION, gitHead: COMMIT })],
        ["package/.npmrc", "registry=https://evil.example/\n"],
      ],
      /it holds \.npmrc/,
    ],
    [
      [
        [
          "package/package.json",
          JSON.stringify({ name: NAME, version: VERSION, gitHead: "forged" }),
        ],
      ],
      /gitHead forged, not c0ffee/,
    ],
  ]) {
    const result = normalize(t, entries, [], { check: true });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    assert.deepEqual(result.files, []);
  }
});
