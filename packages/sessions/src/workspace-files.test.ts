import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseHomeFileOutcomes,
  WORKSPACE_EXEC_ARG_CHARS,
  WORKSPACE_EXEC_BATCH_CHARS,
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

/** Incompressible bytes: gzip keeps them about as large as they are. */
const randomOf = (size: number) => new Uint8Array(randomBytes(size));

/** Every argument under the per-argument limit; each exec's arguments under the batch, paths aside. */
const expectWithinLimits = (execs: ReadonlyArray<ReadonlyArray<string>>) => {
  for (const argv of execs) {
    const args = argv.slice(4);
    expect(args.some((arg) => arg.length > WORKSPACE_EXEC_ARG_CHARS)).toBe(false);
    expect(args.reduce((sum, arg) => sum + arg.length, 0)).toBeLessThan(
      WORKSPACE_EXEC_BATCH_CHARS + 10_000,
    );
  }
};

/** About 30 KB of a skill's text. */
const skillText = (index: number) =>
  new TextEncoder().encode(
    Array.from(
      { length: 600 },
      (_, line) => `- skill ${index}, rule ${line}: say what was observed\n`,
    ).join(""),
  );

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
    expect(fs.readdirSync(path.dirname(first))).toEqual(["SKILL.md"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a whole skills library in one exec: text compresses, and a copy travels once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    // 60 files of ~30 KB of text in each of three harness directories: 5.4 MB written, which
    // took 60 execs per directory as base64 riding 90 KB at a time.
    const files = ["claude", "codex", "pi"].flatMap((harness) =>
      Array.from({ length: 60 }, (_, index) => ({
        path: path.join(root, `.${harness}`, "skills", `s${index}`, "SKILL.md"),
        bytes: skillText(index),
      })),
    );
    const execs = writeFilesExecs(files);
    expect(execs).toHaveLength(1);
    expectWithinLimits(execs);
    runAll(execs);
    for (const file of files) {
      expect(fs.readFileSync(file.path).equals(file.bytes)).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stages a content too large for one exec across several and writes it whole at the end", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const target = path.join(root, "paste", "20260925-101010-abcd.png");
    const copy = path.join(root, "elsewhere", "same.png");
    const large = randomOf(1_600_000);
    const small = path.join(root, "paste", "small.txt");
    const execs = writeFilesExecs([
      { path: target, bytes: large },
      { path: copy, bytes: large },
      { path: small, bytes: new TextEncoder().encode("after") },
    ]);
    // ~2.13 M base64 characters are 24 arguments: 11, 11 and 2, the write riding the last with
    // the small file.
    expect(execs).toHaveLength(3);
    expectWithinLimits(execs);
    runAll(execs.slice(0, 2));
    // Until the last exec, readers see nothing at either path.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
    runAll(execs.slice(2));
    expect(fs.readFileSync(target).equals(large)).toBe(true);
    expect(fs.readFileSync(copy).equals(large)).toBe(true);
    expect(fs.readdirSync(path.dirname(target)).toSorted()).toEqual([
      "20260925-101010-abcd.png",
      "small.txt",
    ]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(small, "utf8")).toBe("after");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a new exec when the next content would not fit", () => {
    const files = [0, 1, 2].map((index) => ({
      path: `/workspace/harness-home/f${index}`,
      bytes: randomOf(400_000),
    }));
    // 400 000 random bytes are ~533 000 characters: two never share one exec.
    const execs = writeFilesExecs(files);
    expect(execs).toHaveLength(3);
    expectWithinLimits(execs);
  });

  it("writes a path given twice with its last bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const target = path.join(root, "a.txt");
    runAll(
      writeFilesExecs([
        { path: target, bytes: new TextEncoder().encode("first") },
        { path: target, bytes: new TextEncoder().encode("last") },
      ]),
    );
    expect(fs.readFileSync(target, "utf8")).toBe("last");
    fs.rmSync(root, { recursive: true, force: true });
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
