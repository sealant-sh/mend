import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PIN_FILES,
  SEALANT_IMAGES,
  digestProblems,
  pinProblems,
  pinnedDigest,
  readPins,
  rewritePins,
} from "./sealant-pins.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const digest = (character) => `sha256:${character.repeat(64)}`;

const repositoryPins = async () =>
  readPins({ dockerfile: await read("Dockerfile"), workspace: await read("pnpm-workspace.yaml") });

test("the checked-in pins are one exact Core version, by digest, with no preview sealantd", async () => {
  const pins = await repositoryPins();
  assert.deepEqual(pinProblems(pins, { stable: pins.sealantVersion.includes("-") === false }), []);
  for (const { argument, repository } of SEALANT_IMAGES) {
    assert.ok(pinnedDigest(pins.images[argument], repository), argument);
  }
});

test("a stable release refuses a prerelease Core; every release refuses inconsistent pins", () => {
  const consistent = {
    sealantVersion: "0.39.0-next.12",
    sdk: "0.39.0-next.12",
    apiContracts: "0.39.0-next.12",
    images: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => [
        argument,
        `ghcr.io/${repository}@${digest("a")}`,
      ]),
    ),
    previewSealantd: '""',
  };
  assert.deepEqual(pinProblems(consistent, { stable: false }), []);
  assert.match(pinProblems(consistent, { stable: true }).join("\n"), /Release Core 0\.39\.0/);

  const drifted = {
    ...consistent,
    sdk: "0.39.0-next.11",
    images: { ...consistent.images, SEALANT_API_IMAGE: "ghcr.io/sealant-sh/sealant-api:0.39.0" },
    previewSealantd: '"ghcr.io/sealant-sh/mend-preview-sealantd@sha256:00"',
  };
  const problems = pinProblems(drifted, { stable: false }).join("\n");
  assert.match(problems, /@sealant\/sdk 0\.39\.0-next\.11/);
  assert.match(problems, /SEALANT_API_IMAGE must name/);
  assert.match(problems, /MEND_PREVIEW_SEALANTD_IMAGE must stay empty/);
  assert.match(
    pinProblems({ ...consistent, sealantVersion: "0.39" }, { stable: false })[0],
    /exact/,
  );
});

test("rewriting moves every pin file to the new version and digests, and nothing else", async () => {
  const current = await repositoryPins();
  const from = {
    version: current.sealantVersion,
    digests: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => [
        argument,
        pinnedDigest(current.images[argument], repository),
      ]),
    ),
  };
  const to = {
    version: "0.39.0-next.12",
    digests: {
      SEALANT_API_IMAGE: digest("a"),
      SEALANT_WORKER_IMAGE: digest("b"),
      SEALANT_SSH_GATEWAY_IMAGE: digest("c"),
    },
  };
  const rewritten = {};
  for (const file of PIN_FILES) {
    const before = await read(file);
    rewritten[file] = rewritePins(before, from, to);
    assert.notEqual(rewritten[file], before, `${file} names the pinned version or a digest`);
    assert.ok(!rewritten[file].includes(from.version), `${file} still names ${from.version}`);
    for (const old of Object.values(from.digests)) assert.ok(!rewritten[file].includes(old), file);
    // Only the pins changed: the same number of lines, and every changed line names the new pin.
    const [beforeLines, afterLines] = [before.split("\n"), rewritten[file].split("\n")];
    assert.equal(afterLines.length, beforeLines.length, file);
    afterLines.forEach((line, index) => {
      if (line !== beforeLines[index]) {
        assert.match(line, /0\.39\.0-next\.12|0\\\.39\\\.0-next\\\.12|sha256:(a|b|c){64}/, file);
      }
    });
  }
  const pins = readPins({
    dockerfile: rewritten.Dockerfile,
    workspace: rewritten["pnpm-workspace.yaml"],
  });
  assert.deepEqual(pinProblems(pins, { stable: false }), []);
  assert.equal(pins.sealantVersion, "0.39.0-next.12");
  assert.equal(
    pins.images.SEALANT_WORKER_IMAGE,
    `ghcr.io/sealant-sh/sealant-worker@${digest("b")}`,
  );
  // The packaging test's own expectations move with the pins, regular expressions included.
  assert.match(
    rewritten["scripts/bundle-packaging.test.mjs"],
    /Sealant 0\\\.39\\\.0-next\\\.12 API/,
  );
});

test("a version is replaced only whole", () => {
  const from = { version: "0.39.0-next.9", digests: {} };
  const to = { version: "0.39.0-next.12", digests: {} };
  assert.equal(
    rewritePins(
      '"0.39.0-next.9" 0.39.0-next.90 10.39.0-next.9 0\\.39\\.0-next\\.9/ 0.39.0-next.9.1 0.39.0-next.9.',
      from,
      to,
    ),
    '"0.39.0-next.12" 0.39.0-next.90 10.39.0-next.9 0\\.39\\.0-next\\.12/ 0.39.0-next.9.1 0.39.0-next.12.',
  );
});

test("each pinned digest must be what GHCR serves for the pinned version", async () => {
  const pins = {
    sealantVersion: "0.38.1",
    images: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => [
        argument,
        `ghcr.io/${repository}@${digest("a")}`,
      ]),
    ),
  };
  const served = {
    "sealant-sh/sealant-api": digest("a"),
    "sealant-sh/sealant-worker": digest("f"),
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([url, init?.method ?? "GET"]);
    if (url.startsWith("https://ghcr.io/token")) {
      return { ok: true, status: 200, json: async () => ({ token: "anonymous" }) };
    }
    const repository = /\/v2\/(.+)\/manifests\//.exec(url)[1];
    const published = served[repository];
    return {
      ok: published !== undefined,
      status: published === undefined ? 404 : 200,
      headers: { get: () => published ?? null },
    };
  };
  const problems = await digestProblems(pins, fetchImpl);
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /SEALANT_WORKER_IMAGE pins sha256:a+, but ghcr\.io\/sealant-sh\/sealant-worker:0\.38\.1 is sha256:f+/,
  );
  assert.match(problems[1], /sealant-ssh-gateway:0\.38\.1 is not published \(HTTP 404\)/);
  assert.ok(
    requests.some(
      ([url, method]) => url.endsWith("/sealant-api/manifests/0.38.1") && method === "HEAD",
    ),
  );
});
