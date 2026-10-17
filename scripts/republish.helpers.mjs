// What republish*.test.mjs share: the publish job's republish block as this repository's workflow
// writes it, a stub npm registry on 127.0.0.1, crafted tarballs, and the runs of the block and of
// the npm step against them.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { parse } from "yaml";

import { githubApi, registryStandIn } from "./fixtures/release-markers.mjs";

export const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// npm's bundled pacote by default; REPUBLISH_TEST_PACOTE runs the same tests against another one.
export const PACOTE =
  process.env.REPUBLISH_TEST_PACOTE ??
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "npm/node_modules/pacote",
  );

/** The `# --- <name> ---` block of the first job in `text` that carries it, unindented. */
export const section = (text, name) => {
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
export const block = (() => {
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
export const tarGz = (entries) => {
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

export const NAME = "@sealant/sdk-next";

export const COMMIT = "c0ffee";

/** A normalized manifest, as normalize-npm-tarball.mjs writes one; `extra` adds what it would drop. */
export const manifest = (version, extra = {}, name = NAME) =>
  JSON.stringify({
    name,
    version,
    main: "./dist/index.js",
    files: ["dist"],
    gitHead: COMMIT,
    ...extra,
  });

export const goodEntries = (version) => [
  ["package/package.json", manifest(version)],
  ["package/dist/index.js", "export {};\n"],
];

/**
 * A stub registry: GET packument and dist-tags, PUT publish, PUT dist-tag. It keeps each published
 * tarball's bytes; `forgeIntegrity` serves another dist.integrity than the one npm sent, as a
 * registry that changed the bytes would.
 */
export const registry = async (t, seed = {}, { forgeIntegrity = false } = {}) => {
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

export const sha512 = (bytes) => createHash("sha512").update(bytes).digest();

export const tarballName = (name, version) => `${name.slice(1).replace("/", "-")}-${version}.tgz`;

/**
 * Runs the job's sequence on a crafted tarball against the stub: image.yml's mend-cli artifact
 * holding it, its release-manifest artifact recording it, then publish_release. `artifact` adds
 * files to the tarball's artifact directory; `record` overrides the manifest's fields; `tamper`
 * replaces the tarball's bytes after the manifest recorded them. `skipCheck` runs the checks and
 * the publish without check_artifacts, to show the empty directory alone keeps a planted .npmrc
 * from configuring npm.
 */
export const publish = async (
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
      RELEASE_TEST_RETRY_MS: "1",
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

export const seeded = (versions = {}, distTags = { latest: "0.38.1" }) => ({
  [NAME]: {
    name: NAME,
    versions: { "0.38.1": { version: "0.38.1" }, ...versions },
    "dist-tags": distTags,
  },
});

// --- the npm job's stable floor ---

export const MEND = "@sealant/mend";

export const mendEntries = (version) => [
  ["package/package.json", manifest(version, {}, MEND)],
  ["package/dist/index.js", ""],
];

export const OWNER = "sealant-ci";

/**
 * The npm job's "Publish to npm" step as written (its --provenance left out: it needs GitHub's
 * OIDC), over this run's artifacts, against the stub npm registry, a stub GitHub API for the latest
 * release, and a stand-in docker for each ghcr :latest.
 */
export const publishStep = async (
  t,
  stub,
  { version, github = {}, labels = {}, unreadable = [], environment = {} },
) => {
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
      RELEASE_TEST_RETRY_MS: "1",
      NPM_CONFIG_REGISTRY: stub.url,
      NPM_CONFIG_USERCONFIG: npmrc,
      ...environment,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output, github: githubStub.requests, docker: docker.calls() };
};

export const mendSeed = (versions = {}, distTags = { latest: "0.39.0" }) => ({
  [MEND]: {
    name: MEND,
    versions: { "0.39.0": { gitHead: "older" }, ...versions },
    "dist-tags": distTags,
  },
});
