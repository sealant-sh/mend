import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guardDir = join(dirname(fileURLToPath(import.meta.url)), "guard");

/** A HOME with an optional CLI config, and a fake real `mend` after the guard on PATH. */
const world = ({ xdgUrl, legacyUrl } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "verify-guard-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "mend"), '#!/bin/sh\necho "real mend $*"\n');
  chmodSync(join(bin, "mend"), 0o755);
  const xdg = join(home, "xdg");
  if (xdgUrl !== undefined) {
    mkdirSync(join(xdg, "mend"), { recursive: true });
    writeFileSync(join(xdg, "mend", "cli.json"), JSON.stringify({ url: xdgUrl, token: "t" }));
  }
  if (legacyUrl !== undefined) {
    mkdirSync(join(home, ".mend"), { recursive: true });
    writeFileSync(join(home, ".mend", "cli.json"), JSON.stringify({ url: legacyUrl }));
  }
  return { home, bin, xdg };
};

const run = ({ home, bin, xdg }, env = {}) =>
  spawnSync(join(guardDir, "mend"), ["projects"], {
    encoding: "utf8",
    env: {
      PATH: `${guardDir}:${bin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      ...env,
    },
  });

const outer = "http://127.0.0.1:23105";

test("the guard refuses without a declared outer server", () => {
  const w = world({ xdgUrl: outer });
  try {
    const result = run(w);
    assert.equal(result.status, 97);
    assert.match(result.stderr, /MEND_VERIFY_OUTER_URL is not set/);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("the guard refuses a config that names another server, or none", () => {
  for (const xdgUrl of ["https://owner.example", ""]) {
    const w = world({ xdgUrl });
    try {
      const result = run(w, { MEND_VERIFY_OUTER_URL: outer });
      assert.equal(result.status, 97);
      assert.match(result.stderr, /a verifier never talks to the owner's server/);
      assert.doesNotMatch(result.stdout, /real mend/);
    } finally {
      rmSync(w.home, { recursive: true, force: true });
    }
  }
});

test("the guard refuses MEND_URL and MEND_TOKEN overrides", () => {
  const w = world({ xdgUrl: outer });
  try {
    assert.equal(run(w, { MEND_VERIFY_OUTER_URL: outer, MEND_URL: outer }).status, 97);
    assert.equal(run(w, { MEND_VERIFY_OUTER_URL: outer, MEND_TOKEN: "x" }).status, 97);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("the guard follows the CLI to a legacy ~/.mend when the XDG directory is missing", () => {
  const w = world({ legacyUrl: "https://owner.example" });
  try {
    const result = run(w, { MEND_VERIFY_OUTER_URL: outer });
    assert.equal(result.status, 97);
    assert.match(result.stderr, /\.mend/);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});

test("the guard runs the next mend on PATH for the declared outer server", () => {
  const w = world({ xdgUrl: `${outer}/` });
  try {
    const result = run(w, { MEND_VERIFY_OUTER_URL: outer });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "real mend projects");
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
});
