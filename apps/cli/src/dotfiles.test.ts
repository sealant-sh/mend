import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  dotfilesRepositoryFacts,
  parseDotfilesRepoArgs,
  readSyncFiles,
  scanDotfileCandidates,
} from "./dotfiles.ts";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-dotfiles-"));

describe("scanDotfileCandidates", () => {
  it("reports only curated candidates that exist as files", () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, ".zshrc"), "export A=1\n");
    fs.mkdirSync(path.join(home, ".config", "git"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "git", "config"), "[user]\n");
    // A directory with a candidate name must not appear.
    fs.mkdirSync(path.join(home, ".vimrc"));

    const found = scanDotfileCandidates(home);
    const paths = found.map((entry) => entry.path);
    expect(paths).toContain(".zshrc");
    expect(paths).toContain(".config/git/config");
    expect(paths).not.toContain(".vimrc");
    expect(found.find((entry) => entry.path === ".zshrc")?.group).toBe("shell");
  });
});

describe("readSyncFiles", () => {
  it("reads contents with modes; an explicit missing path is an error, not a skip", () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, ".zshrc"), "export A=1\n");
    fs.chmodSync(path.join(home, ".zshrc"), 0o755);

    const ok = readSyncFiles(home, [".zshrc"]);
    expect("files" in ok && ok.files).toEqual([
      {
        path: ".zshrc",
        contentsBase64: Buffer.from("export A=1\n").toString("base64"),
        mode: "755",
      },
    ]);

    const missing = readSyncFiles(home, [".zshrc", ".typo"]);
    expect("error" in missing && missing.error).toMatch(/\.typo/);
  });

  it("rejects a file over the server's 1MB cap before uploading", () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, ".big"), Buffer.alloc(1024 * 1024 + 1));
    const result = readSyncFiles(home, [".big"]);
    expect("error" in result && result.error).toMatch(/over 1MB/);
  });
});

/** The refusal a parse returns, or null when it parsed. */
const errorOf = (args: ReadonlyArray<string>) => {
  const parsed = parseDotfilesRepoArgs(args);
  return parsed.kind === "error" ? parsed.error : null;
};

describe("parseDotfilesRepoArgs", () => {
  it("takes a URL alone with every default", () => {
    expect(parseDotfilesRepoArgs(["https://github.com/me/dots.git"])).toEqual({
      kind: "set",
      repository: {
        url: "https://github.com/me/dots.git",
        ref: null,
        subdirectory: null,
        manager: "auto",
        bootstrap: true,
      },
    });
  });

  it("reads every option, in any order around the URL", () => {
    expect(
      parseDotfilesRepoArgs([
        "--manager",
        "copy",
        "git@github.com:me/dots.git",
        "--ref",
        "work",
        "--no-bootstrap",
        "--subdirectory",
        "dots",
      ]),
    ).toEqual({
      kind: "set",
      repository: {
        url: "git@github.com:me/dots.git",
        ref: "work",
        subdirectory: "dots",
        manager: "copy",
        bootstrap: false,
      },
    });
  });

  it.each(["auto", "copy", "stow", "chezmoi"])("accepts --manager %s", (manager) => {
    const parsed = parseDotfilesRepoArgs(["https://x/dots.git", "--manager", manager]);
    expect(parsed.kind === "set" && parsed.repository.manager).toBe(manager);
  });

  it("clears with --clear alone", () => {
    expect(parseDotfilesRepoArgs(["--clear"])).toEqual({ kind: "clear" });
    expect(parseDotfilesRepoArgs(["https://x/dots.git", "--clear"])).toEqual({
      kind: "error",
      error: "--clear takes no URL or other options",
    });
  });

  it("refuses what it cannot read, before any request", () => {
    expect(errorOf([])).toBe("name the repository URL, or --clear to remove it");
    expect(errorOf(["https://x/dots.git", "--manager", "yadm"])).toBe(
      "--manager must be one of auto, copy, stow, chezmoi",
    );
    expect(errorOf(["https://x/dots.git", "--manager"])).toBe("--manager needs a value");
    expect(errorOf(["https://x/dots.git", "--ref", "--no-bootstrap"])).toBe("--ref needs a value");
    expect(errorOf(["https://x/dots.git", "--subdirectory", " "])).toBe(
      "--subdirectory needs a value",
    );
    expect(errorOf(["https://x/dots.git", "--bootstrap"])).toBe("unknown flag --bootstrap");
    expect(errorOf(["https://x/a.git", "https://x/b.git"])).toBe("one repository URL only");
  });
});

describe("dotfilesRepositoryFacts", () => {
  it("names the branch, subdirectory, manager and bootstrap", () => {
    expect(
      dotfilesRepositoryFacts({
        url: "https://x/dots.git",
        ref: null,
        subdirectory: null,
        manager: "auto",
        bootstrap: true,
      }),
    ).toBe("default branch · manager auto · install.sh on");
    expect(
      dotfilesRepositoryFacts({
        url: "https://x/dots.git",
        ref: "work",
        subdirectory: "dots",
        manager: "stow",
        bootstrap: false,
      }),
    ).toBe("work · dots/ · manager stow · install.sh off");
  });
});
