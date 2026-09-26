import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseHomeFileOutcomes,
  WORKSPACE_EXEC_ARG_CHARS,
  writeAbsentHomeFilesExecs,
  writeFilesExecs,
} from "./workspace-files.ts";

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

const encode = (value: string) => new TextEncoder().encode(value);

/** Run each exec with `HOME` at `home`; return what they printed, one outcome per file. */
const runIn = (home: string, execs: ReadonlyArray<ReadonlyArray<string>>) =>
  execs.flatMap(([command = "", ...args]) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return parseHomeFileOutcomes(result.stdout);
  });

describe("writeAbsentHomeFilesExecs", () => {
  it("writes each absent file under $HOME, directories included, and reports it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    const execs = writeAbsentHomeFilesExecs([
      { path: ".zshrc", bytes: encode("# a\n$(touch pwned)\n") },
      { path: ".config/starship.toml", bytes: encode("add_newline = false\n") },
    ]);
    expect(execs).toHaveLength(1);
    expect(runIn(home, execs)).toEqual([
      { path: ".zshrc", outcome: "written" },
      { path: ".config/starship.toml", outcome: "written" },
    ]);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("# a\n$(touch pwned)\n");
    expect(fs.readFileSync(path.join(home, ".config/starship.toml"), "utf8")).toBe(
      "add_newline = false\n",
    );
    expect(fs.statSync(path.join(home, ".zshrc")).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("leaves a file, a symlink (even a dangling one) and a directory where they are", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    fs.writeFileSync(path.join(home, ".zshrc"), "mine\n");
    fs.mkdirSync(path.join(home, ".config"), { mode: 0o700 });
    fs.symlinkSync(
      path.join(home, "dots", "starship.toml"),
      path.join(home, ".config/starship.toml"),
    );
    fs.mkdirSync(path.join(home, ".bashrc"));
    const execs = writeAbsentHomeFilesExecs([
      { path: ".zshrc", bytes: encode("mend\n") },
      { path: ".config/starship.toml", bytes: encode("mend\n") },
      { path: ".bashrc", bytes: encode("mend\n") },
      { path: ".config/new.toml", bytes: encode("new\n") },
    ]);
    expect(runIn(home, execs)).toEqual([
      { path: ".zshrc", outcome: "present" },
      { path: ".config/starship.toml", outcome: "present" },
      { path: ".bashrc", outcome: "present" },
      { path: ".config/new.toml", outcome: "written" },
    ]);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("mine\n");
    expect(fs.lstatSync(path.join(home, ".config/starship.toml")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, "dots"))).toBe(false);
    expect(fs.statSync(path.join(home, ".bashrc")).isDirectory()).toBe(true);
    // An existing directory keeps its own mode.
    expect(fs.statSync(path.join(home, ".config")).mode & 0o777).toBe(0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("splits files that would pass the argument budget across execs", () => {
    const large = "x".repeat(WORKSPACE_EXEC_ARG_CHARS / 2);
    const execs = writeAbsentHomeFilesExecs([
      { path: "a", bytes: encode(large) },
      { path: "b", bytes: encode(large) },
    ]);
    expect(execs).toHaveLength(2);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    expect(runIn(home, execs).map((outcome) => outcome.outcome)).toEqual(["written", "written"]);
    expect(fs.readFileSync(path.join(home, "b"), "utf8")).toBe(large);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
