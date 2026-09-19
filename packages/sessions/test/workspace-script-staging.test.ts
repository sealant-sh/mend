import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GIT_SSH_SHIM_SCRIPT } from "@mend/sessions";
import { describe, expect, it } from "vitest";

import { SESSION_HELPER_SCRIPT, workspaceScriptStaging } from "../src/session-socket.ts";

/**
 * A captured workspace mounts nothing, so the helper and the git shim are written from inside it.
 * The command is run for real under `sh`, as `sealant.exec` runs it in the workspace.
 */
describe("workspaceScriptStaging", () => {
  it("writes both scripts, byte for byte and executable, into <dir>/bin", () => {
    // A quote and a space in the path: the directory is the one argument that is not base64.
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mend-staging-")), "it's here");
    execFileSync("sh", ["-c", workspaceScriptStaging(dir)]);
    for (const [name, script] of [
      ["mend", SESSION_HELPER_SCRIPT],
      ["mend-git-ssh", GIT_SSH_SHIM_SCRIPT],
    ] as const) {
      const file = path.join(dir, "bin", name);
      expect(fs.readFileSync(file, "utf8")).toBe(script);
      expect(fs.statSync(file).mode & 0o111).toBe(0o111);
    }
  });

  it("stages a shim that runs: with no socket and no endpoint it refuses, naming itself", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-staging-"));
    execFileSync("sh", ["-c", workspaceScriptStaging(dir)]);
    const run = () =>
      execFileSync(path.join(dir, "bin", "mend-git-ssh"), [], {
        env: { PATH: process.env["PATH"] ?? "" },
        stdio: "pipe",
      });
    expect(run).toThrowError(/mend-git-ssh is git's transport/);
  });
});
