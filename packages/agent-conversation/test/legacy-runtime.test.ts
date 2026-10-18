/// <reference types="node" />

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/legacy-arrays.mjs", import.meta.url));

it("orders conversations and tasks without change-array-by-copy methods or input mutations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-legacy-arrays-"));
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
      cwd: root,
      env: { HOME: root, LANG: "C" },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      missingMethods: ["toSorted", "toReversed", "toSpliced", "with"],
      orderingChecked: true,
      inputsUnchanged: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(root)).toBe(false);
  }
});
