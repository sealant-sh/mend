// Networked release smoke test. Never resolve dependencies from the checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isolatedClientEnvironment } from "../../../scripts/packaged-server-assertions.mjs";
import manifest from "../package.json" with { type: "json" };

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = realpathSync(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "mend-cli-package-"));
const outside = relative(repositoryRoot, realpathSync(scratch));
assert.ok(outside.startsWith(`..${sep}`), "Package test must run outside the repository");
console.log(`Package test directory: ${scratch}`);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: scratch,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
};

try {
  const home = join(scratch, "home");
  mkdirSync(home);
  const userConfig = join(scratch, "empty.npmrc");
  const globalConfig = join(scratch, "empty-global.npmrc");
  writeFileSync(userConfig, "", { mode: 0o600 });
  writeFileSync(globalConfig, "", { mode: 0o600 });
  const env = {
    ...isolatedClientEnvironment(process.env, home),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_ignore_scripts: "false",
    MEND_URL: "http://127.0.0.1:9",
    MEND_TOKEN: "",
  };
  // Prepack needs the checkout as cwd; package consumers get the same isolated home/config.
  console.log(run("pnpm", ["pack", "--pack-destination", scratch], { cwd: packageRoot, env }));
  const tarballs = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = join(scratch, tarballs[0]);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
  // Do not use --ignore-scripts: this exercises an ordinary consumer installation.
  console.log(run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", tarball], { env }));

  const installed = join(scratch, "node_modules", "@sealant", "mend");
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.version, manifest.version);
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(installedManifest[section] ?? {})) {
      assert.ok(!name.startsWith("@mend/"), `Unpublished runtime dependency: ${name}`);
      assert.ok(!/^(workspace|catalog|file|link):/.test(version), `Unresolved dependency: ${name}`);
    }
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "start"]) {
    assert.equal(
      installedManifest.scripts?.[hook],
      undefined,
      `Unexpected lifecycle hook: ${hook}`,
    );
  }
  assert.ok(!existsSync(join(scratch, "node_modules", "@mend")));
  assert.ok(!existsSync(join(installed, "src")));
  assert.ok(!existsSync(join(installed, "scripts")));

  const dist = join(installed, "dist");
  const outputFiles = readdirSync(dist);
  assert.ok(
    outputFiles.some((name) => /^dashboard-.*\.js$/.test(name)),
    "Missing lazy dashboard",
  );
  for (const name of outputFiles) {
    assert.ok(name.endsWith(".js"), `Unexpected build artifact: ${name}`);
    const source = readFileSync(join(dist, name), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(|require\s*\()\s*["']@mend\//);
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["'][^"']+\.tsx?["']/);
  }
  const bin = join(scratch, "node_modules", ".bin", "mend");
  assert.ok(statSync(bin).mode & 0o111, "npm did not make the CLI executable");
  assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
  const man = readFileSync(join(installed, "man", "mend.1"), "utf8");
  assert.ok(man.includes(manifest.version), "Man page has the wrong version");
  assert.ok(existsSync(join(installed, "man", "mend-ssh.1")));

  const cli = (args, overrides = {}) =>
    run(process.execPath, [bin, ...args], { env, timeout: 15_000, ...overrides });

  // Removing the native packages proves ordinary commands never load the TUI,
  // even on Node versions where OpenTUI itself could successfully initialize.
  const native = join(scratch, "node_modules", "@opentui");
  const hiddenNative = join(scratch, "opentui-not-on-module-path");
  renameSync(native, hiddenNative);
  try {
    assert.match(cli(["--help"]), /adopt\s+adopt a repository/);
    assert.match(cli([]), /adopt\s+adopt a repository/); // Non-TTY dashboard fallback.
    assert.match(cli(["help", "ssh"]), /mend ssh/);
    for (const command of ["--version", "version"]) {
      const lines = cli([command]).trim().split("\n");
      assert.equal(lines[0], `mend ${manifest.version}`);
      assert.equal(lines[1], "server · unreachable · http://127.0.0.1:9");
    }
    for (const shell of ["bash", "zsh"]) {
      assert.match(cli(["completions", shell]), /mend/);
    }
    assert.match(cli(["man", "ssh"], { env: { ...env, PATH: "" } }), /mend ssh/);
    assert.ok(cli(["qr", "mend://pair?code=PACKAGE-TEST"]).trim().length > 0);
    const rejected = spawnSync(process.execPath, [bin, "adopt", "/tmp/local-repository"], {
      cwd: scratch,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Local paths and file:\/\/ URLs are not supported/);
  } finally {
    renameSync(hiddenNative, native);
  }
  console.log(`PASS installed ${manifest.name}@${manifest.version} from ${tarball}`);
  console.log(
    "PASS help, version, completions, man, QR, local-source rejection with OpenTUI absent",
  );
  console.log(
    "PASS no unpublished runtime dependencies/imports, source files, or install/server hooks",
  );
} finally {
  if (process.env["MEND_KEEP_PACKAGE_TEST"] !== "1") {
    rmSync(scratch, { recursive: true, force: true });
  }
}
