import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/atomic-write-failure.mjs", import.meta.url));

describe("workspace SSH config replacement failures", () => {
  for (const linked of [false, true]) {
    it.each(["fsync", "chmod", "rename"] as const)(
      `preserves ${linked ? "a symlink and its target" : "the existing file"} after a post-write %s failure`,
      (stage) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ssh-atomic-write-"));
        try {
          // Faults remain inside this disposable child. Vitest's filesystem bindings
          // and concurrently running test files are never changed.
          const child = spawnSync(
            process.execPath,
            ["--experimental-strip-types", fixture, root, stage, String(linked)],
            {
              cwd: root,
              env: { HOME: root, LANG: "C" },
              encoding: "utf8",
              timeout: 5_000,
              killSignal: "SIGKILL",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          expect(child.error).toBeUndefined();
          expect(child.signal).toBeNull();
          expect(child.status, child.stderr).toBe(0);
          expect(JSON.parse(child.stdout)).toEqual({
            stage,
            linked,
            temporaryObserved: true,
            oldFilePreserved: true,
            retrySucceeded: true,
          });
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          expect(fs.existsSync(root)).toBe(false);
        }
      },
    );
  }
});
