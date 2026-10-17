// local-outer.sh's budgets: the local outer's server gets budgets sized for parallel verifiers,
// through its own Compose files, and the product's defaults stay. A fake `docker` stands in for the
// outer container; no daemon, no network beyond loopback.
//
//   node --test .claude/skills/verify/scripts/local-outer.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

/** The product's defaults, as apps/api/src/budgets.ts states them (`name: 1200,` or `a * b,`). */
const productDefaults = () => {
  const source = readFileSync(join(scripts, "../../../../apps/api/src/budgets.ts"), "utf8");
  const block = /DEFAULT_BUDGET_LIMITS: BudgetLimits = \{([^}]+)\}/.exec(source)[1];
  return Object.fromEntries(
    [...block.matchAll(/(\w+): ([\d *]+),/g)].map(([, name, value]) => [
      name,
      value.split("*").reduce((product, factor) => product * Number(factor.trim()), 1),
    ]),
  );
};

/**
 * A `docker` that answers `exec <name> docker inspect` with the labels Compose put on mend-mend-1,
 * keeps what `exec -i … cat > <file>` is given, and records every other call.
 */
const FAKE_DOCKER = `const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
const labels = {
  config_files: "/state/home/.config/mend/server/g1/compose.yaml,/state/home/.config/mend/server/g1/compose.mirrors.yaml",
  working_dir: "/state/home/.config/mend/server/g1",
  environment_file: process.env.FAKE_NO_ENV_LABEL ? "" : "/state/home/.config/mend/server/g1/server.env",
};
if (args[0] === "exec" && args[1] === "-i") {
  writeFileSync(process.env.FAKE_OVERLAY, readFileSync(0));
} else if (args[0] === "exec" && args[2] === "docker" && args[3] === "inspect") {
  const label = /project\\.([a-z_]+)/.exec(args[5])[1];
  if (process.env.FAKE_NO_LABELS) process.stdout.write("\\n");
  else process.stdout.write(labels[label] + "\\n");
}
`;

const outer = async (body) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-local-outer-"));
  const bin = join(dir, "bin");
  const log = join(dir, "docker.log");
  const overlay = join(dir, "overlay.yaml");
  mkdirSync(bin);
  // Through `node --`: Node reads a `--env-file` among a script's arguments as its own otherwise.
  writeFileSync(join(dir, "docker.cjs"), FAKE_DOCKER);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\nexec node -- "${join(dir, "docker.cjs")}" "$@"\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(log, "");
  const health = createServer((req, res) => res.end(req.url === "/api/health" ? "{}" : ""));
  await new Promise((done) => health.listen(0, "127.0.0.1", done));
  const { port } = health.address();
  const run = (extra = {}) =>
    new Promise((done) => {
      const child = spawn("sh", [join(scripts, "local-outer.sh"), "budgets"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MEND_VERIFY_OUTER_PORT: String(port),
          MEND_VERIFY_OUTER_NAME: "st-verify-outer-test",
          FAKE_LOG: log,
          FAKE_OVERLAY: overlay,
          ...extra,
        },
      });
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (out += data));
      child.on("exit", (status) => done({ status, out }));
    });
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    await body({ run, calls, overlay: () => readFileSync(overlay, "utf8") });
  } finally {
    health.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

test("budgets recreates the outer's mend with setup's Compose files and one overlay of budgets", async () => {
  await outer(async ({ run, calls, overlay }) => {
    const result = await run();
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /budgets for parallel verifiers: ADDRESS_REQUESTS_PER_MINUTE=12000/);
    const compose = calls().find((args) => args.includes("compose"));
    assert.deepEqual(compose, [
      "exec",
      "st-verify-outer-test",
      "docker",
      "compose",
      "--project-name",
      "mend",
      "--project-directory",
      "/state/home/.config/mend/server/g1",
      "--env-file",
      "/state/home/.config/mend/server/g1/server.env",
      "-f",
      "/state/home/.config/mend/server/g1/compose.yaml",
      "-f",
      "/state/home/.config/mend/server/g1/compose.mirrors.yaml",
      "-f",
      "/st-verify/compose.budgets.yaml",
      "up",
      "-d",
      "--no-deps",
      "mend",
    ]);
    const text = overlay();
    assert.match(text, /^services:\n {2}mend:\n {4}environment:\n/m);
    const set = Object.fromEntries(
      [...text.matchAll(/^ {6}(MEND_BUDGET_[A-Z_]+): "(\d+)"$/gm)].map(([, key, value]) => [
        key,
        Number(value),
      ]),
    );
    // Above the product's defaults for what parallel drivers spend; nothing turned off.
    const defaults = productDefaults();
    assert.equal(defaults.addressRequestsPerMinute, 1200);
    assert.ok(set.MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE >= 5 * 1200);
    assert.ok(set.MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE >= 5 * 1200);
    for (const [key, value] of Object.entries(set)) {
      assert.ok(value > 0, `${key} is off`);
      const name = key
        .replace(/^MEND_BUDGET_/, "")
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      assert.ok(name in defaults, `${key} is not a budget`);
      assert.ok(value >= defaults[name], `${key} is below the default`);
    }
    // Sign-in attempts keep the product's default: no driver signs in to the outer.
    assert.equal(set.MEND_BUDGET_SIGN_IN_ATTEMPTS_PER_MINUTE, undefined);
  });
});

test("budgets falls back to server.env, and refuses a container Compose did not start", async () => {
  await outer(async ({ run, calls }) => {
    const result = await run({ FAKE_NO_ENV_LABEL: "1" });
    assert.equal(result.status, 0, result.out);
    const compose = calls().find((args) => args.includes("compose"));
    assert.equal(
      compose[compose.indexOf("--env-file") + 1],
      "/state/home/.config/mend/server/g1/server.env",
    );
  });
  await outer(async ({ run, calls }) => {
    const result = await run({ FAKE_NO_LABELS: "1" });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /carries no Compose labels; budgets not set/);
    assert.ok(!calls().some((args) => args.includes("compose")));
  });
});

/**
 * A `docker` and a `curl` for seeding and `up`. FAKE_HOST maps an image to the digest this machine
 * holds it by, FAKE_HUB an image to the digest Docker Hub names (absent: Docker Hub refuses),
 * FAKE_TARGET lists what the outer's daemon holds, FAKE_NETWORK says whether the cache's network
 * exists. `docker run -d` fails once recorded, which ends `up` there.
 */
const SEED_DOCKER = `const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
const host = JSON.parse(process.env.FAKE_HOST);
const target = JSON.parse(process.env.FAKE_TARGET);
const inner = args[0] === "exec" ? args.slice(args.indexOf("docker") + 1) : null;
if (inner && inner[0] === "image" && inner[1] === "inspect") process.exit(target.includes(inner.at(-1)) ? 0 : 1);
if (inner && inner[0] === "load") { readFileSync(0); process.exit(0); }
if (inner && inner[0] === "info") process.exit(0);
if (inner && inner[0] === "ps") process.exit(0);
if (args[0] === "image" && args[1] === "inspect") {
  const image = args.at(-1);
  if (!(image in host)) process.exit(1);
  process.stdout.write(image.replace(/:[^:]*$/, "") + "@" + host[image] + "\\n");
  process.exit(0);
}
if (args[0] === "save") { process.stdout.write("tar of " + args.at(-1)); process.exit(0); }
if (args[0] === "network" && args[1] === "inspect") process.exit(process.env.FAKE_NETWORK ? 0 : 1);
if (args[0] === "run") process.exit(1);
`;

const SEED_CURL = `const args = process.argv.slice(2);
const url = args.at(-1);
if (url.startsWith("https://auth.docker.io/")) { process.stdout.write('{"token":"t"}'); process.exit(0); }
const [, repo, tag] = /\\/v2\\/(.+)\\/manifests\\/(.+)$/.exec(url);
const image = repo.replace(/^library\\//, "") + ":" + tag;
const hub = JSON.parse(process.env.FAKE_HUB);
if (!(image in hub)) process.exit(22);
process.stdout.write("HTTP/2 200\\r\\ndocker-content-digest: " + hub[image] + "\\r\\n\\r\\n");
`;

const seeding = async (env, args) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-local-outer-seed-"));
  const bin = join(dir, "bin");
  const log = join(dir, "docker.log");
  mkdirSync(bin);
  for (const [tool, source] of [
    ["docker", SEED_DOCKER],
    ["curl", SEED_CURL],
  ]) {
    writeFileSync(join(dir, `${tool}.cjs`), source);
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec node -- "${join(dir, `${tool}.cjs`)}" "$@"\n`, {
      mode: 0o755,
    });
  }
  writeFileSync(log, "");
  try {
    const result = await new Promise((done) => {
      const child = spawn("sh", [join(scripts, "local-outer.sh"), ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MEND_VERIFY_OUTER_NAME: "st-verify-outer-test",
          MEND_VERIFY_OUTER_CONFIG: join(dir, "config"),
          MEND_VERIFY_OUTER_WORK: join(dir, "work"),
          MEND_VERIFY_REGISTRY_MIRROR: "",
          FAKE_LOG: log,
          FAKE_HOST: "{}",
          FAKE_HUB: "{}",
          FAKE_TARGET: "[]",
          ...env,
        },
      });
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (out += data));
      child.on("exit", (status) => done({ status, out }));
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const loaded = (calls) => calls.filter((args) => args[0] === "save").map((args) => args.at(-1));

test("seed loads this machine's copy only when Docker Hub names its digest, or cannot say", async () => {
  const current = "sha256:" + "a".repeat(64);
  const stale = "sha256:" + "b".repeat(64);
  const { status, out, calls } = await seeding(
    {
      FAKE_HOST: JSON.stringify({
        "postgres:17-alpine": current,
        "node:26-bookworm": stale,
        "registry:3.1": current,
        "dxflrs/garage:v2.4.1": current,
      }),
      FAKE_HUB: JSON.stringify({
        "postgres:17-alpine": current,
        "node:26-bookworm": current,
        "dxflrs/garage:v2.4.1": current,
      }),
      FAKE_TARGET: JSON.stringify(["dxflrs/garage:v2.4.1"]),
    },
    ["seed"],
  );
  assert.equal(status, 0, out);
  assert.deepEqual(loaded(calls).toSorted(), ["postgres:17-alpine", "registry:3.1"]);
  assert.match(out, new RegExp(`postgres:17-alpine · loaded ${current} \\(current\\)`));
  assert.match(
    out,
    new RegExp(`node:26-bookworm · stale here \\(${stale}; Docker Hub names ${current}\\)`),
  );
  assert.match(
    out,
    new RegExp(`registry:3.1 · loaded ${current} \\(unchecked: Docker Hub did not answer\\)`),
  );
  assert.match(out, /docker:27\.5\.1-dind-rootless · not on this machine/);
  assert.doesNotMatch(out, /garage/, "a tag the outer holds is left as it is");
});

test("up asks the hub-cache first only when told to, on the cache's network", async () => {
  const plain = await seeding({}, ["up"]);
  const run = plain.calls.find((args) => args[0] === "run");
  assert.equal(run[run.indexOf("--network") + 1], "bridge");
  assert.ok(!run.some((arg) => arg.startsWith("--registry-mirror")));

  const mirror = "http://st-verify-hub-cache:5000";
  const refused = await seeding({ MEND_VERIFY_REGISTRY_MIRROR: mirror }, ["up"]);
  assert.equal(refused.status, 1);
  assert.match(
    refused.out,
    /no network st-verify-hub-cache: run `local-outer.sh hub-cache up` first/,
  );
  assert.ok(!refused.calls.some((args) => args[0] === "run"));

  const mirrored = await seeding({ MEND_VERIFY_REGISTRY_MIRROR: mirror, FAKE_NETWORK: "1" }, [
    "up",
  ]);
  const cached = mirrored.calls.find((args) => args[0] === "run");
  assert.equal(cached[cached.indexOf("--network") + 1], "st-verify-hub-cache");
  assert.deepEqual(cached.slice(cached.indexOf("docker:27.5.1-dind") + 1), [
    "--tls=false",
    "--host=unix:///var/run/docker.sock",
    `--registry-mirror=${mirror}`,
    "--insecure-registry=st-verify-hub-cache:5000",
  ]);
});
