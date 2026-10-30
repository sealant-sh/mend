import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lintCli = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const rootDirectory = fileURLToPath(new URL("../../../..", import.meta.url));

interface Report {
  readonly diagnostics: ReadonlyArray<{ readonly filename: string; readonly message: string }>;
}

const lint = (cwd: string, files: ReadonlyArray<string>) => {
  const result = spawnSync(process.execPath, [lintCli, "--format=json", ...files], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const report: Report = JSON.parse(result.stdout);
  return { status: result.status, report, output: result.stdout + result.stderr };
};

// The probes sit in a copy of the repository's layout outside it, under the real config, so a lint
// of the checkout running meanwhile never meets them.
const withProbes = async (
  probes: ReadonlyArray<readonly [string, string]>,
  check: (root: string, files: ReadonlyArray<string>) => void,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "mobile-request-lint-"));
  try {
    await copyFile(path.join(rootDirectory, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
    const directory = path.join(root, "apps/mobile/src/data/probe");
    await mkdir(directory, { recursive: true });
    const files: string[] = [];
    for (const [name, source] of probes) {
      const file = path.join(directory, name);
      await writeFile(file, source);
      files.push(file);
    }
    check(root, files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("the lint that keeps the phone's requests on the pairing's machine", () => {
  it("rejects every spelling of a machine, a config read or a raw request outside their owners", async () => {
    const rejected: ReadonlyArray<readonly [string, string]> = [
      ["machine.ts", 'import { openMachine } from "@/data/machine"; void openMachine;'],
      ["config.ts", 'import { loadConfig } from "@/data/pairing-config"; void loadConfig;'],
      ["fetch.ts", 'void fetch("https://b.example/api/projects");'],
      ["relative-machine.ts", 'import { openMachine } from "../machine"; void openMachine;'],
      [
        "extension-machine.ts",
        'import { openMachine } from "@/data/machine.ts"; void openMachine;',
      ],
      ["namespace-machine.ts", 'import * as Machines from "../machine"; void Machines;'],
      ["relative-config.ts", 'import { loadConfig } from "../pairing-config"; void loadConfig;'],
      [
        "extension-config.ts",
        'import { useConfig } from "@/data/pairing-config.ts"; void useConfig;',
      ],
      ["reexport-config.ts", 'export { loadConfig } from "../pairing-config";'],
      ["global-fetch.ts", 'void globalThis.fetch("https://b.example/api/projects");'],
      ["window-fetch.ts", 'void window.fetch("https://b.example/api/projects");'],
      ["self-fetch.ts", 'void self.fetch("https://b.example/api/projects");'],
      ["global-xhr.ts", "void new globalThis.XMLHttpRequest();"],
      ["socket.ts", 'void new WebSocket("wss://b.example/api/tty");'],
      ["global-socket.ts", 'void new globalThis.WebSocket("wss://b.example/api/tty");'],
    ];
    await withProbes(rejected, (root, files) => {
      for (const cwd of [root, path.join(root, "apps/mobile")]) {
        const { status, report, output } = lint(cwd, files);
        expect(status, output).toBe(1);
        const passed = rejected
          .map(([name]) => name)
          .filter((name) => !report.diagnostics.some((entry) => entry.filename.endsWith(name)));
        expect(passed, `passed lint from ${cwd}`).toEqual([]);
      }
    });
  });

  it("allows the machine's errors and the config's types from anywhere", async () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      [
        "allowed.ts",
        'import { ApiError, PairingEnded } from "../machine"; import type { Connection } from "../pairing-config"; export const failures = [ApiError, PairingEnded]; export type Seen = Connection;',
      ],
    ];
    await withProbes(allowed, (root, files) => {
      const { status, output } = lint(root, files);
      expect(status, output).toBe(0);
    });
  });
});
