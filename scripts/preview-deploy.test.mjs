import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/preview-deploy.sh runs as root on the box, through the deploy user's forced command. Here
// it runs against stand-ins for `id`, `curl`, `docker` and `mend` that print what they are told and
// record what they were asked, so each refusal is checked to change nothing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/preview-deploy.sh");

const VERSION = "0.36.0-next.601.preview.40";
const COMMIT = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

const STUBS = {
  id: `#!/usr/bin/env bash
echo 0
`,
  curl: `#!/usr/bin/env bash
url="\${!#}"
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then printf 'downloaded:%s\\n' "$url" > "$2"; shift; fi
  shift
done
`,
  docker: `#!/usr/bin/env bash
case $1 in
  pull) exit 0 ;;
  image)
    case $4 in
      *image.version*) printf '%s\\n' "$STUB_VERSION_LABEL" ;;
      *image.revision*) printf '%s\\n' "$STUB_REVISION_LABEL" ;;
      *.Os*) printf '%s\\n' "$STUB_IMAGE_PLATFORM" ;;
    esac ;;
  version) printf '%s\\n' "$STUB_HOST_PLATFORM" ;;
  exec)
    [[ $STUB_LIVE == fail ]] && { echo "Error: No such container: mend-postgres-1" >&2; exit 1; }
    printf '%s\\n' "$STUB_LIVE" ;;
  inspect) exit 1 ;;
esac
`,
  mend: `#!/usr/bin/env bash
case $2 in
  status)
    if [[ -e $STUB_APPLIED ]]; then echo "Mend server · healthy"; exit 0; fi
    printf '%s\\n' "$STUB_STATUS_OUTPUT"
    exit "$STUB_STATUS_CODE" ;;
  setup|upgrade)
    while [[ $# -gt 0 ]]; do
      if [[ $1 == --assets-dir ]]; then
        for asset in compose.v2.yaml postgres-init.sh; do
          printf '%s\\0' "$asset" "$(cat "$2/$asset")" >> "$STUB_ASSETS"
        done
      fi
      shift
    done
    touch "$STUB_APPLIED" ;;
esac
exit 0
`,
};

// A count and NUL-delimited arguments preserve each argv element, including SQL with spaces.
function recordedCalls(log) {
  if (!existsSync(log)) return [];
  const fields = readFileSync(log, "utf8").split("\0");
  assert.equal(fields.pop(), "", "each recorded argument is NUL-terminated");
  const calls = [];
  while (fields.length > 0) {
    const command = fields.shift();
    const count = Number(fields.shift());
    assert.ok(Number.isInteger(count) && count >= 0 && count <= fields.length);
    calls.push({ command, args: fields.splice(0, count) });
  }
  return calls;
}

function deploy(overrides = {}, setupOptions = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "preview-deploy-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      const file = path.join(bin, name);
      writeFileSync(
        file,
        body.replace("\n", `\nprintf '%s\\0' ${name} "$#" "$@" >> "$STUB_CALLS"\n`),
      );
      chmodSync(file, 0o755);
    }
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: directory,
      MEND_CONFIG_DIR: path.join(directory, "mend"),
      TMPDIR: directory,
      STUB_CALLS: path.join(directory, "argv.log"),
      STUB_ASSETS: path.join(directory, "assets.log"),
      STUB_APPLIED: path.join(directory, "applied"),
      STUB_STATUS_OUTPUT: "Mend server · healthy",
      STUB_STATUS_CODE: "0",
      STUB_VERSION_LABEL: VERSION,
      STUB_REVISION_LABEL: COMMIT,
      STUB_IMAGE_PLATFORM: "linux/amd64",
      STUB_HOST_PLATFORM: "linux/amd64",
      STUB_LIVE: "0",
      ...overrides,
    };
    const result = spawnSync("bash", [script, VERSION, COMMIT, ...setupOptions], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: recordedCalls(env.STUB_CALLS),
      assets: existsSync(env.STUB_ASSETS)
        ? readFileSync(env.STUB_ASSETS, "utf8").split("\0").slice(0, -1)
        : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const deploymentCalls = (result) =>
  result.calls.filter(
    ({ command, args }) =>
      command === "mend" && args[0] === "server" && ["setup", "upgrade"].includes(args[1]),
  );

const assertNoDeployment = (result) => assert.deepEqual(deploymentCalls(result), []);

const assertCandidateDeployed = (result, action, options = []) => {
  assert.equal(result.status, 0, result.output);
  const deployments = deploymentCalls(result);
  assert.equal(deployments.length, 1, "one deployment command");
  const assetsDirectory = deployments[0].args[5];
  assert.equal(typeof assetsDirectory, "string");
  assert.deepEqual(deployments[0].args, [
    "server",
    action,
    "--version",
    VERSION,
    "--assets-dir",
    assetsDirectory,
    ...options,
  ]);
  const downloads = result.calls.filter(({ command }) => command === "curl");
  const assets = ["compose.v2.yaml", "postgres-init.sh"];
  assert.deepEqual(
    downloads.map(({ args }) => args),
    assets.map((asset) => [
      "-fsSL",
      "--retry",
      "3",
      "--output",
      path.join(assetsDirectory, asset),
      `https://raw.githubusercontent.com/sealant-sh/mend/${COMMIT}/deploy/docker/${asset}`,
    ]),
  );
  assert.deepEqual(
    result.assets,
    assets.flatMap((asset) => [
      asset,
      `downloaded:https://raw.githubusercontent.com/sealant-sh/mend/${COMMIT}/deploy/docker/${asset}`,
    ]),
  );
  assert.deepEqual(
    result.calls
      .filter(({ command, args }) => command === "docker" && args[0] === "pull")
      .map(({ args }) => args),
    [["pull", `ghcr.io/sealant-sh/mend:${VERSION}`]],
  );
  assert.deepEqual(
    result.calls
      .filter(({ command, args }) => command === "docker" && args[0] === "image")
      .map(({ args }) => args),
    [
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      "{{.Os}}/{{.Architecture}}",
    ].map((format) => [
      "image",
      "inspect",
      "--format",
      format,
      `ghcr.io/sealant-sh/mend:${VERSION}`,
    ]),
  );
  assert.deepEqual(
    result.calls
      .filter(({ command, args }) => command === "mend" && args[1] === "status")
      .map(({ args }) => args),
    [
      ["server", "status"],
      ["server", "status"],
    ],
  );
};

const SETUP_OPTIONS = [
  "--url",
  "https://preview.example.invalid",
  "--bind",
  "127.0.0.1,10.0.0.17",
  "--edge",
  "--exposure",
  "public",
];

test("an image of the asked version, commit and platform upgrades a box with no live session", () => {
  const result = deploy();
  assertCandidateDeployed(result, "upgrade");
  assert.match(result.output, /0 session\(s\) live/);
});

test("an image built from another commit is refused before anything changes", () => {
  const result = deploy({ STUB_REVISION_LABEL: "f".repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.output, /org\.opencontainers\.image\.revision="f{40}", expected "1a2b3c/);
  assert.match(result.output, /nothing deployed/);
  assertNoDeployment(result);
});

test("an image without a revision label is refused", () => {
  const result = deploy({ STUB_REVISION_LABEL: "" });
  assert.equal(result.status, 1);
  assert.match(result.output, /image\.revision="", expected/);
  assertNoDeployment(result);
});

test("an image for another platform is refused", () => {
  const result = deploy({ STUB_IMAGE_PLATFORM: "linux/arm64" });
  assert.equal(result.status, 1);
  assert.match(result.output, /built for linux\/arm64 and this box runs linux\/amd64/);
  assertNoDeployment(result);
});

test("live sessions refuse the upgrade unless the operator asked for it", () => {
  const refused = deploy({ STUB_LIVE: "2" });
  assert.equal(refused.status, 1);
  assert.match(refused.output, /2 session\(s\) are live on this box · nothing deployed/);
  assertNoDeployment(refused);

  const asked = deploy({ STUB_LIVE: "2", PREVIEW_DEPLOY_EVEN_IF_LIVE: "1" });
  assert.equal(asked.status, 0, asked.output);
  assertCandidateDeployed(asked, "upgrade");
});

test("a live-session count that cannot be read refuses, unless the operator asked to go on", () => {
  const refused = deploy({ STUB_LIVE: "fail" });
  assert.equal(refused.status, 1);
  assert.match(refused.output, /could not count live sessions .* · nothing deployed/);
  assertNoDeployment(refused);

  const garbled = deploy({ STUB_LIVE: "psql: error: connection refused" });
  assert.equal(garbled.status, 1);
  assertNoDeployment(garbled);

  const asked = deploy({ STUB_LIVE: "fail", PREVIEW_DEPLOY_EVEN_IF_LIVE: "1" });
  assert.equal(asked.status, 0, asked.output);
  assert.match(asked.output, /going on: PREVIEW_DEPLOY_EVEN_IF_LIVE=1/);
  assertCandidateDeployed(asked, "upgrade");
});

test("an unconfigured box installs the exact candidate assets and forwards setup options", () => {
  const result = deploy(
    {
      STUB_STATUS_OUTPUT:
        "No Mend server is configured. Run mend server setup explicitly to install one.",
      STUB_STATUS_CODE: "1",
      STUB_LIVE: "fail",
    },
    SETUP_OPTIONS,
  );
  assertCandidateDeployed(result, "setup", SETUP_OPTIONS);
  assert.equal(
    result.calls.filter(({ command, args }) => command === "docker" && args[0] === "exec").length,
    0,
    "first install does not ask a nonexistent bundled Postgres for live sessions",
  );
});

for (const { name, output, code } of [
  { name: "healthy", output: "Mend server · healthy", code: "0" },
  { name: "stopped", output: "Mend is stopped. No health claim was made.", code: "0" },
  {
    name: "stopped with a nonzero status",
    output: "Mend is stopped. No health claim was made.",
    code: "1",
  },
  {
    name: "unhealthy",
    output: "Mend is running but exact-version health was not observed.",
    code: "1",
  },
]) {
  test(`a configured ${name} box upgrades the exact candidate and ignores setup options`, () => {
    const result = deploy({ STUB_STATUS_OUTPUT: output, STUB_STATUS_CODE: code }, SETUP_OPTIONS);
    assertCandidateDeployed(result, "upgrade");
    assert.match(result.output, /setup options are ignored/);
    assert.equal(
      result.calls.filter(({ command, args }) => command === "docker" && args[0] === "exec").length,
      1,
    );
  });
}

test("an image labeled with another version is refused before a deployment command", () => {
  const result = deploy({ STUB_VERSION_LABEL: "0.36.0-next.601.preview.39" });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /image\.version="0\.36\.0-next\.601\.preview\.39", expected "0\.36\.0-next\.601\.preview\.40"/,
  );
  assertNoDeployment(result);
});
