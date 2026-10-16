// The publish job's republish block, run as written in this repository's workflow, against a stub
// npm registry on 127.0.0.1, with tarballs crafted the ways three reviews found to fool a check of
// the tarball as built. Mend's block publishes the run's own normalized tarball byte for byte and
// checks the registry's integrity after; sealant-sh/sealant and sealant-sh/sealantd still rebuild
// the tarball they publish, so their copies of this file differ from this one.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { parse } from "yaml";

import { githubApi, registryStandIn } from "./fixtures/release-markers.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
// npm's bundled pacote by default; REPUBLISH_TEST_PACOTE runs the same tests against another one.
const PACOTE =
  process.env.REPUBLISH_TEST_PACOTE ??
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "npm/node_modules/pacote",
  );

/** The `# --- <name> ---` block of the first job in `text` that carries it, unindented. */
const section = (text, name) => {
  const begin = text.indexOf(`# --- ${name} ---`);
  const end = text.indexOf(`# --- end ${name} ---`, begin);
  if (begin < 0 || end < begin) return undefined;
  const lines = text.slice(begin, end).split("\n");
  const indent = /^ */.exec(lines[0] ?? "")?.[0].length ?? 0;
  return lines.map((line) => line.slice(indent)).join("\n");
};

/**
 * The republish block, from whichever workflow carries it, after the floor block the npm job runs
 * first (it defines registry_get and dist_tag) where there is one.
 */
const block = (() => {
  for (const file of ["next.yml", "release-cli.yml"]) {
    const workflow = path.join(root, ".github/workflows", file);
    if (!existsSync(workflow)) continue;
    const text = readFileSync(workflow, "utf8");
    const republish = section(text, "republish");
    if (republish === undefined) continue;
    return [section(text, "floor") ?? "", republish].join("\n");
  }
  throw new Error("No workflow carries the republish block.");
})();

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

const NAME = "@sealant/sdk-next";
const COMMIT = "c0ffee";
/** A normalized manifest, as normalize-npm-tarball.mjs writes one; `extra` adds what it would drop. */
const manifest = (version, extra = {}, name = NAME) =>
  JSON.stringify({
    name,
    version,
    main: "./dist/index.js",
    files: ["dist"],
    gitHead: COMMIT,
    ...extra,
  });
const goodEntries = (version) => [
  ["package/package.json", manifest(version)],
  ["package/dist/index.js", "export {};\n"],
];

/**
 * A stub registry: GET packument and dist-tags, PUT publish, PUT dist-tag. It keeps each published
 * tarball's bytes; `forgeIntegrity` serves another dist.integrity than the one npm sent, as a
 * registry that changed the bytes would.
 */
const registry = async (t, seed = {}, { forgeIntegrity = false } = {}) => {
  const packages = new Map(Object.entries(seed));
  const log = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = decodeURIComponent(request.url ?? "");
      const tagMatch = /^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/.exec(url);
      if (request.method === "PUT" && tagMatch !== null) {
        const record = packages.get(tagMatch[1]);
        record["dist-tags"][tagMatch[2]] = JSON.parse(body);
        log.push({ distTag: tagMatch[2], version: JSON.parse(body) });
        response.writeHead(200).end("{}");
        return;
      }
      const tagsMatch = /^\/-\/package\/(.+)\/dist-tags$/.exec(url);
      if (request.method === "GET" && tagsMatch !== null) {
        const record = packages.get(tagsMatch[1]);
        if (record === undefined) response.writeHead(404).end("{}");
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(record["dist-tags"]));
        return;
      }
      const name = url.slice(1);
      if (request.method === "GET") {
        const record = packages.get(name);
        if (record === undefined) response.writeHead(404).end("{}");
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(record));
        return;
      }
      if (request.method === "PUT") {
        const published = JSON.parse(body);
        const record = packages.get(name) ?? { name, versions: {}, "dist-tags": {} };
        if (forgeIntegrity)
          for (const entry of Object.values(published.versions))
            entry.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
        Object.assign(record.versions, published.versions);
        Object.assign(record["dist-tags"], published["dist-tags"]);
        const [version] = Object.keys(published.versions);
        packages.set(name, record);
        log.push({
          publish: version,
          distTags: published["dist-tags"],
          manifest: published.versions[version],
          bytes: Buffer.from(Object.values(published["_attachments"])[0].data, "base64"),
        });
        response.writeHead(201).end("{}");
        return;
      }
      response.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, log, packages };
};

const sha512 = (bytes) => createHash("sha512").update(bytes).digest();
const tarballName = (name, version) => `${name.slice(1).replace("/", "-")}-${version}.tgz`;

/**
 * Runs the job's sequence on a crafted tarball against the stub: image.yml's mend-cli artifact
 * holding it, its release-manifest artifact recording it, then publish_release. `artifact` adds
 * files to the tarball's artifact directory; `record` overrides the manifest's fields; `tamper`
 * replaces the tarball's bytes after the manifest recorded them. `skipCheck` runs the checks and
 * the publish without check_artifacts, to show the empty directory alone keeps a planted .npmrc
 * from configuring npm.
 */
const publish = async (
  t,
  stub,
  entries,
  version,
  channel = "next",
  { artifact = {}, skipCheck = false, name = NAME, record = {}, tamper } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "republish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, "cli");
  const release = path.join(directory, "release");
  mkdirSync(cli);
  mkdirSync(release);
  const file = tarballName(name, version);
  const bytes = tarGz(entries);
  const digest = sha512(bytes);
  writeFileSync(path.join(cli, file), tamper === undefined ? bytes : tarGz(tamper));
  for (const [extra, text] of Object.entries(artifact)) writeFileSync(path.join(cli, extra), text);
  writeFileSync(
    path.join(release, "release-manifest.json"),
    JSON.stringify({
      version,
      commit: COMMIT,
      cli: {
        file,
        sha512: digest.toString("hex"),
        integrity: `sha512-${digest.toString("base64")}`,
      },
      ...record,
    }),
  );
  const npmrc = path.join(directory, "npmrc");
  writeFileSync(npmrc, `${stub.url.replace("http:", "")}:_authToken=test\n`);
  const script = [
    "set -euo pipefail",
    block,
    skipCheck
      ? [
          'cd "$(mktemp -d)"',
          'tarball="$CLI/$(cd "$CLI" && ls *.tgz)"',
          'integrity=$(recorded_integrity "$tarball" "$RELEASE/release-manifest.json" "$2" "$3")',
          'check_tarball "$tarball" "$1" "$2" "$3" "$4"',
          'publish_exact "$tarball" "$1" "$2" "$3" "$4" "$integrity"',
        ].join("\n")
      : 'publish_release "$CLI" "$RELEASE" "$@"',
  ].join("\n");
  const child = spawn("bash", ["-c", script, "republish", name, version, COMMIT, channel], {
    cwd: cli,
    env: {
      ...process.env,
      CLI: cli,
      RELEASE: release,
      REPUBLISH_TEST_PACOTE: PACOTE,
      REPUBLISH_TEST_WAIT: "0",
      NPM_CONFIG_REGISTRY: stub.url,
      NPM_CONFIG_USERCONFIG: npmrc,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output, bytes };
};

const seeded = (versions = {}, distTags = { latest: "0.38.1" }) => ({
  [NAME]: {
    name: NAME,
    versions: { "0.38.1": { version: "0.38.1" }, ...versions },
    "dist-tags": distTags,
  },
});

test("the run's normalized tarball is published under next as it is, and its integrity read back", async (t) => {
  const stub = await registry(t, seeded());
  const { status, output, bytes } = await publish(
    t,
    stub,
    goodEntries("0.39.0-next.9"),
    "0.39.0-next.9",
  );
  assert.equal(status, 0, output);
  assert.equal(stub.log.length, 1);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  // Not repacked: the registry received the bytes the manifest recorded.
  assert.deepEqual(stub.log[0].bytes, bytes);
  assert.equal(stub.log[0].manifest.dist.integrity, `sha512-${sha512(bytes).toString("base64")}`);
  assert.match(output, /published with the integrity this run accepted/);
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
});

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

test("a registry serving another integrity after the publish is an incident, and the channel's dist-tag has moved", async (t) => {
  // What next-channel.md's incident steps undo: the job fails, but npm publish --tag already moved
  // the channel's dist-tag to the incident version.
  const stub = await registry(t, seeded(), { forgeIntegrity: true });
  const result = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /::error::INCIDENT: .*Do not republish: deprecate/);
  assert.equal(stub.log.length, 1);
  assert.equal(stub.packages.get(NAME)["dist-tags"].next, "0.39.0-next.9");
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
  // A stable release: latest itself now names the incident version.
  const mend = "@sealant/mend";
  const stable = await registry(
    t,
    { [mend]: { name: mend, versions: { "0.38.1": {} }, "dist-tags": { latest: "0.38.1" } } },
    { forgeIntegrity: true },
  );
  const entries = [
    ["package/package.json", manifest("0.39.0", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const released = await publish(t, stable, entries, "0.39.0", "latest", { name: mend });
  assert.notEqual(released.status, 0, released.output);
  assert.match(released.output, /::error::INCIDENT/);
  assert.equal(stable.packages.get(mend)["dist-tags"].latest, "0.39.0");
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

test("next never moves back: an older version than the current next is refused", async (t) => {
  const stub = await registry(
    t,
    seeded(
      { "0.39.0-next.12": { gitHead: "later" } },
      { latest: "0.38.1", next: "0.39.0-next.12" },
    ),
  );
  const { status, output } = await publish(
    t,
    stub,
    goodEntries("0.39.0-next.11"),
    "0.39.0-next.11",
  );
  assert.notEqual(status, 0, output);
  assert.equal(stub.log.length, 0);
  assert.match(output, /next is already 0\.39\.0-next\.12/);
});

test("a version already published from this commit is done once its integrity checks; from another, refused", async (t) => {
  const integrity = `sha512-${sha512(tarGz(goodEntries("0.39.0-next.9"))).toString("base64")}`;
  const stub = await registry(
    t,
    seeded({ "0.39.0-next.9": { gitHead: COMMIT, dist: { integrity } } }),
  );
  assert.equal((await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9")).status, 0);
  assert.equal(stub.log.length, 0);
  // A re-run over a version the registry serves with other bytes is the incident, not "done".
  const forged = await registry(
    t,
    seeded({ "0.39.0-next.9": { gitHead: COMMIT, dist: { integrity: "sha512-other" } } }),
  );
  const incident = await publish(t, forged, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(incident.status, 0);
  assert.match(incident.output, /::error::INCIDENT/);
  const other = await registry(t, seeded({ "0.39.0-next.9": { gitHead: "elsewhere" } }));
  const refused = await publish(t, other, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /published from elsewhere/);
});

test("a package document over 256 KB is read, not passed as an argument", async (t) => {
  // Linux caps one argument at 128 KB (MAX_ARG_STRLEN): @sealant/mend's document passed it at
  // v0.36.0-next.601, and the job died with "Argument list too long" (run 37342721738).
  const padding = "x".repeat(200);
  const versions = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [`0.0.${i}`, { gitHead: "older", readme: padding }]),
  );
  const distTags = Object.fromEntries(
    Array.from({ length: 8000 }, (_, i) => [`channel-${i}`, `0.0.${i % 1500}`]),
  );
  const large = () =>
    seeded(
      { ...versions, "0.39.0-next.8": { gitHead: "older" } },
      { ...distTags, latest: "0.38.1", next: "0.39.0-next.8" },
    );
  const stub = await registry(t, large());
  assert.ok(JSON.stringify(stub.packages.get(NAME)).length > 256 * 1024);
  assert.ok(JSON.stringify(stub.packages.get(NAME)["dist-tags"]).length > 128 * 1024);
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.equal(status, 0, output);
  assert.equal(stub.log.length, 1);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  // The same document read back: published from this commit is done; next never moves back.
  assert.equal((await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9")).status, 0);
  assert.equal(stub.log.length, 1);
  const older = await publish(
    t,
    await registry(t, large()),
    goodEntries("0.39.0-next.7"),
    "0.39.0-next.7",
  );
  assert.notEqual(older.status, 0, older.output);
  assert.match(older.output, /next is already 0\.39\.0-next\.8/);
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

test("a registry failure stops the job instead of being read as nothing published", async (t) => {
  const stub = await registry(t, {});
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(status, 0);
  assert.match(output, /answered 404/);
  assert.equal(stub.log.length, 0);
});

test("a stable release publishes under latest with the same checks", async (t) => {
  const mend = "@sealant/mend";
  const seed = {
    [mend]: { name: mend, versions: { "0.38.1": {} }, "dist-tags": { latest: "0.38.1" } },
  };
  const entries = [
    ["package/package.json", manifest("0.39.0", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const stub = await registry(t, seed);
  const result = await publish(t, stub, entries, "0.39.0", "latest", { name: mend });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(stub.log[0].distTags, { latest: "0.39.0" });
  const next = [
    ["package/package.json", manifest("0.39.0-next.9", {}, mend)],
    ["package/dist/index.js", ""],
  ];
  const refused = await publish(t, await registry(t, seed), next, "0.39.0-next.9", "latest", {
    name: mend,
  });
  assert.notEqual(refused.status, 0);
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

// --- the npm job's stable floor ---

const MEND = "@sealant/mend";
const mendEntries = (version) => [
  ["package/package.json", manifest(version, {}, MEND)],
  ["package/dist/index.js", ""],
];
const integrityOf = (entries) => `sha512-${sha512(tarGz(entries)).toString("base64")}`;
const OWNER = "sealant-ci";
const latestLabels = (version) =>
  Object.fromEntries(
    ["mend", "mend-api", "mend-web"].map((image) => [`ghcr.io/${OWNER}/${image}:latest`, version]),
  );

/**
 * The npm job's "Publish to npm" step as written (its --provenance left out: it needs GitHub's
 * OIDC), over this run's artifacts, against the stub npm registry, a stub GitHub API for the latest
 * release, and a stand-in docker for each ghcr :latest.
 */
const publishStep = async (t, stub, { version, github = {}, labels = {}, unreadable = [] }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "republish-step-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const dir of ["cli", "release"]) mkdirSync(path.join(directory, dir));
  const file = tarballName(MEND, version);
  const bytes = tarGz(mendEntries(version));
  const digest = sha512(bytes);
  writeFileSync(path.join(directory, "cli", file), bytes);
  writeFileSync(
    path.join(directory, "release", "release-manifest.json"),
    JSON.stringify({
      version,
      commit: COMMIT,
      cli: {
        file,
        sha512: digest.toString("hex"),
        integrity: `sha512-${digest.toString("base64")}`,
      },
    }),
  );
  const tags = Object.fromEntries(
    Object.keys(labels).map((ref) => [ref, `sha256:${"b".repeat(64)}`]),
  );
  const docker = registryStandIn(directory, { tags, versions: labels, unreadable });
  const githubStub = await githubApi(t, github);
  const npmrc = path.join(directory, "npmrc");
  writeFileSync(npmrc, `${stub.url.replace("http:", "")}:_authToken=test\n`);
  const { jobs } = parse(
    readFileSync(path.join(root, ".github/workflows/release-cli.yml"), "utf8"),
  );
  const run = jobs.npm.steps.find((entry) => entry.name === "Publish to npm").run;
  assert.equal(run.split(" --provenance").length, 2);
  const child = spawn("bash", ["-c", run.replace(" --provenance", "")], {
    env: {
      ...process.env,
      PATH: `${docker.bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: directory,
      GITHUB_REF_NAME: `v${version}`,
      GITHUB_SHA: COMMIT,
      GITHUB_REPOSITORY: "sealant-sh/Mend",
      GITHUB_REPOSITORY_OWNER: OWNER,
      GITHUB_API_URL: githubStub.url,
      REPUBLISH_TEST_PACOTE: PACOTE,
      REPUBLISH_TEST_WAIT: "0",
      NPM_CONFIG_REGISTRY: stub.url,
      NPM_CONFIG_USERCONFIG: npmrc,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output, github: githubStub.requests, docker: docker.calls() };
};
const mendSeed = (versions = {}, distTags = { latest: "0.39.0" }) => ({
  [MEND]: {
    name: MEND,
    versions: { "0.39.0": { gitHead: "older" }, ...versions },
    "dist-tags": distTags,
  },
});

test("stable npm: above the floor the run's tarball publishes; below it nothing does", async (t) => {
  const lower = await registry(t, mendSeed());
  const published = await publishStep(t, lower, {
    version: "0.40.0",
    github: { latest: "v0.39.0" },
    labels: latestLabels("0.39.0"),
  });
  assert.equal(published.status, 0, published.output);
  assert.match(published.output, /Stable floor: 0\.39\.0 .*0\.40\.0 may publish/);
  assert.equal(lower.log.length, 1);
  assert.deepEqual(lower.log[0].distTags, { latest: "0.40.0" });
  // Each marker alone above the version refuses before npm publishes anything.
  for (const [marker, markers, named] of [
    [
      "npm latest",
      { github: {}, labels: {}, distTags: { latest: "0.41.0" } },
      /npm:@sealant\/mend@latest/,
    ],
    ["GitHub's latest release", { github: { latest: "v0.41.0" } }, /github:sealant-sh\/Mend/],
    ["a ghcr :latest", { labels: latestLabels("0.41.0") }, /ghcr\.io\/sealant-ci\/mend:latest/],
  ]) {
    const stub = await registry(t, mendSeed({}, markers.distTags ?? { latest: "0.39.0" }));
    const refused = await publishStep(t, stub, { version: "0.40.0", ...markers });
    assert.equal(refused.status, 1, marker);
    assert.match(refused.output, /0\.40\.0 is below the stable floor/, marker);
    assert.match(refused.output, named, marker);
    assert.match(
      refused.output,
      /a backport such as 0\.35\.2 after 0\.36\.0 is refused on purpose/,
    );
    assert.equal(stub.log.length, 0, marker);
  }
});

test("stable npm at the floor publishes nothing and only verifies the accepted tarball", async (t) => {
  const accepted = { gitHead: COMMIT, dist: { integrity: integrityOf(mendEntries("0.40.0")) } };
  const retried = await registry(t, mendSeed({ "0.40.0": accepted }, { latest: "0.40.0" }));
  const retry = await publishStep(t, retried, {
    version: "0.40.0",
    github: { latest: "v0.39.0" },
    labels: latestLabels("0.39.0"),
  });
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /0\.40\.0 may retry/);
  assert.match(retry.output, /a same-version retry publishes nothing/);
  assert.match(retry.output, /published with the integrity this run accepted/);
  assert.equal(retried.log.length, 0);
  assert.equal(retried.packages.get(MEND)["dist-tags"].latest, "0.40.0");
  // Other bytes under that version are the incident; a version npm does not hold at all means a
  // marker was moved by hand.
  const forged = await registry(
    t,
    mendSeed(
      { "0.40.0": { gitHead: COMMIT, dist: { integrity: "sha512-other" } } },
      { latest: "0.40.0" },
    ),
  );
  const incident = await publishStep(t, forged, { version: "0.40.0" });
  assert.equal(incident.status, 1);
  assert.match(incident.output, /::error::INCIDENT/);
  assert.equal(forged.log.length, 0);
  const handMoved = await registry(t, mendSeed());
  const moved = await publishStep(t, handMoved, {
    version: "0.40.0",
    labels: latestLabels("0.40.0"),
  });
  assert.equal(moved.status, 1);
  assert.match(moved.output, /is the stable floor, but npm does not hold it/);
  assert.equal(handMoved.log.length, 0);
  assert.equal(handMoved.packages.get(MEND)["dist-tags"].latest, "0.39.0");
});

test("stable npm fails, publishing nothing, on an unreadable or malformed marker", async (t) => {
  for (const [label, markers, problem] of [
    ["GitHub answers 502", { github: { status: 502 } }, /GitHub answered 502/],
    [
      "a :latest unreadable",
      { labels: latestLabels("0.39.0"), unreadable: ["ghcr.io/sealant-ci/mend-web:latest"] },
      /Could not read ghcr\.io\/sealant-ci\/mend-web:latest/,
    ],
    ["a label not X.Y.Z", { labels: latestLabels("0.40") }, /not a plain X\.Y\.Z/],
  ]) {
    const stub = await registry(t, mendSeed());
    const result = await publishStep(t, stub, { version: "0.40.0", ...markers });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.equal(stub.log.length, 0, label);
  }
});

test("a next build reads no floor and publishes under next as before", async (t) => {
  const stub = await registry(t, mendSeed({}, { latest: "0.39.0", next: "0.40.0-next.3" }));
  const result = await publishStep(t, stub, {
    version: "0.40.0-next.4",
    github: { latest: "v9.9.9" },
    labels: latestLabels("9.9.9"),
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.github, []);
  assert.deepEqual(result.docker, []);
  assert.deepEqual(stub.log[0].distTags, { next: "0.40.0-next.4" });
});
