import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { WORKSPACE_EXEC_ARG_CHARS, writeFilesExecs } from "./workspace-files.ts";

/** Run the execs with a real `sh`, the way a workspace would, and fail on the first nonzero exit. */
const runAll = (execs: ReadonlyArray<ReadonlyArray<string>>) => {
  for (const [command = "", ...args] of execs) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }
};

const bytesOf = (size: number, seed: number) =>
  Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 256);

describe("writeFilesExecs", () => {
  it("packs small files into one exec and writes them readable, directories included", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const first = path.join(root, "skills", "a", "SKILL.md");
    const second = path.join(root, "skills", "b", "nested", "notes.md");
    const execs = writeFilesExecs([
      { path: first, bytes: new TextEncoder().encode("# a\n$(touch pwned)\n") },
      { path: second, bytes: new TextEncoder().encode("") },
    ]);
    expect(execs).toHaveLength(1);
    runAll(execs);
    expect(fs.readFileSync(first, "utf8")).toBe("# a\n$(touch pwned)\n");
    expect(fs.readFileSync(second, "utf8")).toBe("");
    expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
    expect(fs.statSync(first).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.dirname(first)).mode & 0o777).toBe(0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends a large file chunk by chunk and renames it into place whole", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const target = path.join(root, "paste", "20260925-101010-abcd.png");
    const large = bytesOf(200_000, 7);
    const small = path.join(root, "paste", "small.txt");
    const execs = writeFilesExecs([
      { path: target, bytes: large },
      { path: small, bytes: new TextEncoder().encode("after") },
    ]);
    // 200 000 bytes are 266 668 base64 characters: three chunks, a rename, then the small file.
    expect(execs).toHaveLength(5);
    for (const argv of execs) {
      const argChars = argv.slice(3).reduce((sum, arg) => sum + arg.length, 0);
      expect(argChars).toBeLessThan(96 * 1024);
      expect(argv.slice(3).some((arg) => arg.length > WORKSPACE_EXEC_ARG_CHARS)).toBe(false);
    }
    runAll(execs.slice(0, 3));
    // Until the rename, readers see nothing at the target.
    expect(fs.existsSync(target)).toBe(false);
    runAll(execs.slice(3));
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(large);
    expect(fs.existsSync(`${target}.mend-part`)).toBe(false);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(small, "utf8")).toBe("after");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a new exec when the next small file would not fit", () => {
    const files = [0, 1, 2].map((index) => ({
      path: `/workspace/harness-home/f${index}`,
      bytes: bytesOf(40_000, index),
    }));
    // 40 000 bytes are 53 336 characters: two never share one exec.
    expect(writeFilesExecs(files)).toHaveLength(3);
  });
});
