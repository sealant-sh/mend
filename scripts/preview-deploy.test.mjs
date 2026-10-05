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
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then printf 'asset\\n' > "$2"; shift; fi
  shift
done
`,
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
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
echo "mend $*" >> "$STUB_LOG"
[[ $2 == status ]] && echo "Mend server · healthy"
exit 0
`,
};

function deploy(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "preview-deploy-"));
  try {
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      const file = path.join(bin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    const log = path.join(directory, "calls.log");
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: directory,
      MEND_CONFIG_DIR: path.join(directory, "mend"),
      STUB_LOG: log,
      STUB_VERSION_LABEL: VERSION,
      STUB_REVISION_LABEL: COMMIT,
      STUB_IMAGE_PLATFORM: "linux/amd64",
      STUB_HOST_PLATFORM: "linux/amd64",
      STUB_LIVE: "0",
      ...overrides,
    };
    const result = spawnSync("bash", [script, VERSION, COMMIT], { encoding: "utf8", env });
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      upgraded: calls.includes("mend server upgrade"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("an image of the asked version, commit and platform upgrades a box with no live session", () => {
  const result = deploy();
  assert.equal(result.status, 0, result.output);
  assert.ok(result.upgraded);
  assert.match(result.output, /0 session\(s\) live/);
});

test("an image built from another commit is refused before anything changes", () => {
  const result = deploy({ STUB_REVISION_LABEL: "f".repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.output, /org\.opencontainers\.image\.revision="f{40}", expected "1a2b3c/);
  assert.match(result.output, /nothing deployed/);
  assert.ok(!result.upgraded);
});

test("an image without a revision label is refused", () => {
  const result = deploy({ STUB_REVISION_LABEL: "" });
  assert.equal(result.status, 1);
  assert.match(result.output, /image\.revision="", expected/);
  assert.ok(!result.upgraded);
});

test("an image for another platform is refused", () => {
  const result = deploy({ STUB_IMAGE_PLATFORM: "linux/arm64" });
  assert.equal(result.status, 1);
  assert.match(result.output, /built for linux\/arm64 and this box runs linux\/amd64/);
  assert.ok(!result.upgraded);
});

test("live sessions refuse the upgrade unless the operator asked for it", () => {
  const refused = deploy({ STUB_LIVE: "2" });
  assert.equal(refused.status, 1);
  assert.match(refused.output, /2 session\(s\) are live on this box · nothing deployed/);
  assert.ok(!refused.upgraded);

  const asked = deploy({ STUB_LIVE: "2", PREVIEW_DEPLOY_EVEN_IF_LIVE: "1" });
  assert.equal(asked.status, 0, asked.output);
  assert.ok(asked.upgraded);
});

test("a live-session count that cannot be read refuses, unless the operator asked to go on", () => {
  const refused = deploy({ STUB_LIVE: "fail" });
  assert.equal(refused.status, 1);
  assert.match(refused.output, /could not count live sessions .* · nothing deployed/);
  assert.ok(!refused.upgraded);

  const garbled = deploy({ STUB_LIVE: "psql: error: connection refused" });
  assert.equal(garbled.status, 1);
  assert.ok(!garbled.upgraded);

  const asked = deploy({ STUB_LIVE: "fail", PREVIEW_DEPLOY_EVEN_IF_LIVE: "1" });
  assert.equal(asked.status, 0, asked.output);
  assert.match(asked.output, /going on: PREVIEW_DEPLOY_EVEN_IF_LIVE=1/);
  assert.ok(asked.upgraded);
});
