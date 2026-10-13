import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { recordingRegistry } from "./fixtures/recording-registry.mjs";
import {
  PIN_FILES,
  SEALANT_IMAGES,
  assetProblems,
  digestProblems,
  pinProblems,
  pinnedDigest,
  readPins,
  registryDigest,
  repositoryFor,
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
    assert.ok(
      pinnedDigest(pins.images[argument], repositoryFor(repository, pins.sealantVersion)),
      argument,
    );
  }
});

test("a prerelease is pinned under the -next names, a release under the plain ones", () => {
  const next = {
    sealantVersion: "0.39.0-next.12",
    sdk: "npm:@sealant/sdk-next@0.39.0-next.12",
    apiContracts: "npm:@sealant/api-contracts-next@0.39.0-next.12",
    images: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => [
        argument,
        `ghcr.io/${repository}-next@${digest("a")}`,
      ]),
    ),
    previewSealantd: '""',
    aliases: [
      "npm:@sealant/sdk-next@0.39.0-next.12",
      "npm:@sealant/api-contracts-next@0.39.0-next.12",
    ],
  };
  assert.deepEqual(pinProblems(next, { stable: false }), []);
  const refused = pinProblems(next, { stable: true }).join("\n");
  assert.match(refused, /Release Core 0\.39\.0/);
  assert.match(
    refused,
    /cannot depend on a prerelease package: npm:@sealant\/sdk-next@0\.39\.0-next\.12/,
  );

  // A prerelease under the plain names, or a release under the -next ones, is inconsistent.
  const plainNames = pinProblems(
    {
      ...next,
      sdk: "0.39.0-next.12",
      images: {
        ...next.images,
        SEALANT_API_IMAGE: `ghcr.io/sealant-sh/sealant-api@${digest("a")}`,
      },
    },
    { stable: false },
  ).join("\n");
  assert.match(
    plainNames,
    /@sealant\/sdk as 0\.39\.0-next\.12.*must be npm:@sealant\/sdk-next@0\.39\.0-next\.12/,
  );
  assert.match(
    plainNames,
    /SEALANT_API_IMAGE must name ghcr\.io\/sealant-sh\/sealant-api-next@sha256/,
  );

  const release = {
    sealantVersion: "0.39.0",
    sdk: "0.39.0",
    apiContracts: "0.39.0",
    images: Object.fromEntries(
      SEALANT_IMAGES.map(({ argument, repository }) => [
        argument,
        `ghcr.io/${repository}@${digest("b")}`,
      ]),
    ),
    previewSealantd: '""',
    aliases: [],
  };
  assert.deepEqual(pinProblems(release, { stable: true }), []);
  assert.match(
    pinProblems(
      { ...release, aliases: ["npm:@sealant/runtime-client-next@0.20.0-next.7"] },
      { stable: true },
    ).join("\n"),
    /cannot depend on a prerelease package/,
  );

  const drifted = {
    ...next,
    sdk: "npm:@sealant/sdk-next@0.39.0-next.11",
    previewSealantd: '"ghcr.io/sealant-sh/mend-preview-sealantd@sha256:00"',
  };
  const problems = pinProblems(drifted, { stable: false }).join("\n");
  assert.match(problems, /npm:@sealant\/sdk-next@0\.39\.0-next\.11/);
  assert.match(problems, /MEND_PREVIEW_SEALANTD_IMAGE must stay empty/);
  assert.match(pinProblems({ ...next, sealantVersion: "0.39" }, { stable: false })[0], /exact/);
});

test("rewriting moves every pin file to a prerelease's -next names and digests, and nothing else", async () => {
  const current = await repositoryPins();
  const from = { version: current.sealantVersion, images: current.images };
  const to = {
    version: "0.39.0-next.12",
    images: {
      SEALANT_API_IMAGE: `ghcr.io/sealant-sh/sealant-api-next@${digest("a")}`,
      SEALANT_WORKER_IMAGE: `ghcr.io/sealant-sh/sealant-worker-next@${digest("b")}`,
      SEALANT_SSH_GATEWAY_IMAGE: `ghcr.io/sealant-sh/sealant-ssh-gateway-next@${digest("c")}`,
    },
  };
  const rewritten = {};
  for (const file of PIN_FILES) {
    const before = await read(file);
    rewritten[file] = rewritePins(before, from, to);
    assert.notEqual(rewritten[file], before, `${file} names the pinned version or a digest`);
    assert.ok(!rewritten[file].includes(from.version), `${file} still names ${from.version}`);
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
  assert.equal(pins.sdk, "npm:@sealant/sdk-next@0.39.0-next.12");
  assert.equal(
    pins.images.SEALANT_WORKER_IMAGE,
    `ghcr.io/sealant-sh/sealant-worker-next@${digest("b")}`,
  );
  assert.match(
    rewritten["scripts/bundle-packaging.test.mjs"],
    /sealant-sh\\\/sealant-api-next@sha256:a{64}/,
  );
  assert.match(
    rewritten["scripts/bundle-packaging.test.mjs"],
    /Sealant 0\\\.39\\\.0-next\\\.12 API/,
  );
  // And back to a release: the plain names and versions again.
  const release = {
    version: "0.39.0",
    images: Object.fromEntries(
      Object.entries(to.images).map(([k, v]) => [k, v.replace("-next@", "@")]),
    ),
  };
  const back = readPins({
    dockerfile: rewritePins(rewritten.Dockerfile, to, release),
    workspace: rewritePins(rewritten["pnpm-workspace.yaml"], to, release),
  });
  assert.deepEqual(pinProblems(back, { stable: true }), []);
});

test("a version is replaced only whole", () => {
  const from = { version: "0.39.0-next.9", images: {} };
  const to = { version: "0.39.0-next.12", images: {} };
  assert.equal(
    rewritePins(
      '"0.39.0-next.9" 0.39.0-next.90 10.39.0-next.9 0\\.39\\.0-next\\.9/ 0.39.0-next.9.1 0.39.0-next.9.',
      from,
      to,
    ),
    '"0.39.0-next.12" 0.39.0-next.90 10.39.0-next.9 0\\.39\\.0-next\\.12/ 0.39.0-next.9.1 0.39.0-next.12.',
  );
});

const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const pullToken = "synthetic-anonymous-pull-token";
const validTokenRequest = (request, repository) =>
  request.method === "GET" &&
  request.path === `/token?scope=repository:${repository}:pull` &&
  request.authorization === null;
const validManifestRequest = (request, repository, tag) =>
  request.method === "HEAD" &&
  request.path === `/v2/${repository}/manifests/${tag}` &&
  request.authorization === `Bearer ${pullToken}` &&
  request.accept === manifestAccept;

for (const repository of ["sealant-sh/sealant-api", "sealant-sh/sealant-api-next"]) {
  test(`GHCR resolves ${repository} by exact scoped token and authenticated manifest HEAD`, async () => {
    const tag = repository.endsWith("-next") ? "0.39.0-next.12" : "0.38.1";
    const registry = await recordingRegistry("https://ghcr.io", (request, response) => {
      if (validTokenRequest(request, repository))
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ token: pullToken }));
      else if (validManifestRequest(request, repository, tag))
        response.writeHead(200, { "Docker-Content-Digest": digest("b") }).end();
      else response.writeHead(401).end();
    });
    try {
      assert.equal(await registryDigest(repository, tag, registry.fetchImpl), digest("b"));
      assert.deepEqual(registry.requests, [
        {
          method: "GET",
          path: `/token?scope=repository:${repository}:pull`,
          authorization: null,
          accept: "*/*",
        },
        {
          method: "HEAD",
          path: `/v2/${repository}/manifests/${tag}`,
          authorization: `Bearer ${pullToken}`,
          accept: manifestAccept,
        },
      ]);
    } finally {
      await registry.close();
    }
  });
}

test("each pinned digest must be what GHCR serves for the pinned version", async () => {
  const pins = {
    sealantVersion: "0.38.1",
    images: {
      SEALANT_API_IMAGE: `ghcr.io/sealant-sh/sealant-api@${digest("a")}`,
      SEALANT_WORKER_IMAGE: `ghcr.io/sealant-sh/sealant-worker@${digest("a")}`,
      SEALANT_SSH_GATEWAY_IMAGE: `ghcr.io/sealant-sh/sealant-ssh-gateway@${digest("a")}`,
    },
  };
  const repositories = [
    "sealant-sh/sealant-api",
    "sealant-sh/sealant-worker",
    "sealant-sh/sealant-ssh-gateway",
  ];
  const registry = await recordingRegistry("https://ghcr.io", (request, response) => {
    const repository = repositories.find(
      (candidate) =>
        validTokenRequest(request, candidate) || validManifestRequest(request, candidate, "0.38.1"),
    );
    if (repository === undefined) return response.writeHead(401).end();
    if (validTokenRequest(request, repository))
      return response.writeHead(200).end(JSON.stringify({ token: pullToken }));
    if (repository === "sealant-sh/sealant-ssh-gateway") return response.writeHead(404).end();
    return response
      .writeHead(200, {
        "Docker-Content-Digest": digest(repository.endsWith("worker") ? "f" : "a"),
      })
      .end();
  });
  try {
    assert.deepEqual(await digestProblems(pins, registry.fetchImpl), [
      `ARG SEALANT_WORKER_IMAGE pins ${digest("a")}, but ghcr.io/sealant-sh/sealant-worker:0.38.1 is ${digest("f")}.`,
      "ghcr.io/sealant-sh/sealant-ssh-gateway:0.38.1 is not published (HTTP 404).",
    ]);
    assert.deepEqual(
      registry.requests.map(({ method, path: requestPath }) => ({ method, path: requestPath })),
      repositories.flatMap((repository) => [
        { method: "GET", path: `/token?scope=repository:${repository}:pull` },
        { method: "HEAD", path: `/v2/${repository}/manifests/0.38.1` },
      ]),
    );
  } finally {
    await registry.close();
  }
});

for (const failure of [
  "token HTTP",
  "manifest HTTP",
  "missing digest",
  "malformed digest",
  "network",
]) {
  test(`GHCR ${failure} rejects digest evidence`, async () => {
    const registry = await recordingRegistry("https://ghcr.io", (request, response) => {
      if (validTokenRequest(request, "sealant-sh/sealant-api")) {
        if (failure === "token HTTP") return response.writeHead(403).end();
        if (failure === "network") return response.destroy();
        return response.writeHead(200).end(JSON.stringify({ token: pullToken }));
      }
      if (!validManifestRequest(request, "sealant-sh/sealant-api", "0.38.1"))
        return response.writeHead(401).end();
      if (failure === "manifest HTTP") return response.writeHead(503).end();
      const headers =
        failure === "malformed digest"
          ? { "Docker-Content-Digest": "sha256:not-a-digest" }
          : { "X-Unrelated-Digest": digest("a") };
      return response.writeHead(200, headers).end();
    });
    try {
      const expected =
        failure === "token HTTP"
          ? /GHCR refused a pull token for sealant-sh\/sealant-api: 403/
          : failure === "manifest HTTP"
            ? /is not published \(HTTP 503\)/
            : failure === "network"
              ? /fetch failed/
              : /came back without a digest/;
      await assert.rejects(
        registryDigest("sealant-sh/sealant-api", "0.38.1", registry.fetchImpl),
        expected,
      );
      assert.equal(
        registry.requests.length,
        failure === "token HTTP" || failure === "network" ? 1 : 2,
      );
    } finally {
      await registry.close();
    }
  });
}

test("the setup assets and the supervisor name the pinned Core version", async () => {
  const pins = await repositoryPins();
  const files = Object.fromEntries(
    await Promise.all(PIN_FILES.map(async (file) => [file, await read(file)])),
  );
  assert.deepEqual(assetProblems(files, pins.sealantVersion), []);
  const stale = {
    ...files,
    "deploy/docker/compose.v2.yaml": files["deploy/docker/compose.v2.yaml"].replace(
      `Sealant ${pins.sealantVersion} API`,
      "Sealant 0.1.0 API",
    ),
  };
  assert.deepEqual(assetProblems(stale, pins.sealantVersion), [
    `deploy/docker/compose.v2.yaml does not name Sealant ${pins.sealantVersion} in its header.`,
  ]);
  assert.equal(assetProblems(files, "0.39.0-next.12").length, 9);
});
