import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.join(import.meta.dirname, "..", "..", "..");
const installer = path.join(repositoryRoot, "install.sh");
const temporaryDirectories: Array<string> = [];

const makeTools = (
  nodeVersion: string,
  npmExit = 0,
): { readonly bin: string; readonly log: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-installer-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "fake tools");
  const log = path.join(root, "commands.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh
if [ "$1" = -p ]; then printf '%s\\n' '${nodeVersion}'; else printf 'v%s\\n' '${nodeVersion}'; fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh
printf 'npm' >>"$MEND_INSTALL_TEST_LOG"
printf ' <%s>' "$@" >>"$MEND_INSTALL_TEST_LOG"
printf '\\n' >>"$MEND_INSTALL_TEST_LOG"
exit ${npmExit}
`,
    { mode: 0o755 },
  );
  for (const command of ["docker", "mend"]) {
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh
printf '${command} <%s>\\n' "$*" >>"$MEND_INSTALL_TEST_LOG"
exit 99
`,
      { mode: 0o755 },
    );
  }
  return { bin, log };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const runInstaller = (tools: { readonly bin: string; readonly log: string }, version = "0.23.4") =>
  spawnSync("/bin/sh", [installer], {
    encoding: "utf8",
    env: {
      PATH: tools.bin,
      MEND_INSTALL_TEST_LOG: tools.log,
      MEND_VERSION: version,
    },
  });

describe("the shell installer", () => {
  it("installs only the requested CLI and tells the user how to set up a server", () => {
    const tools = makeTools("22.13.0");

    const result = runInstaller(tools);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(tools.log, "utf8")).toBe(
      "npm <install> <--global> <--no-fund> <--no-audit> <@sealant/mend@0.23.4>\n",
    );
    expect(result.stdout).toContain("Next: mend server setup");
    expect(result.stdout).not.toContain("server is running");
  });

  it("refuses an old Node with an actionable error before invoking npm", () => {
    for (const version of ["21.0.0", "22.12.0", "18.19.1"]) {
      const tools = makeTools(version);

      const result = runInstaller(tools);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `mend install: Node.js 22.13 or newer is required; found v${version}. Upgrade Node.js, then retry.\n`,
      );
      expect(fs.existsSync(tools.log)).toBe(false);
    }
  });

  it("takes every Node the CLI's engines take (fresh install 2026-10-10)", () => {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ engines: { node: ">=22.13.0" } });
    for (const version of ["22.13.0", "22.23.3", "23.0.0", "26.4.0"]) {
      const result = runInstaller(makeTools(version));
      expect(result.status, `${version}: ${result.stderr}`).toBe(0);
    }
  });

  it("reports npm global-install failure without starting Docker or the server", () => {
    const tools = makeTools("26.4.0", 1);

    const result = runInstaller(tools, "latest");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fix npm's global prefix or permissions");
    const commands = fs.readFileSync(tools.log, "utf8");
    expect(commands).toContain("@sealant/mend@latest");
    expect(commands).not.toContain("docker");
    expect(commands).not.toContain("mend <");
  });
});
