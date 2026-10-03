import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  failureReason,
  parseRelinkReport,
  REPOSITORY_EXISTS_EXIT,
  REPOSITORY_OUTSIDE_EXIT,
  REPOSITORY_PATH_OCCUPIED_EXIT,
  repositoryCloneScript,
  repositoryRelinkScript,
} from "../src/session-repositories.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, env: gitEnv })
    .toString("utf8")
    .trim();

/**
 * The scripts name `/workspace/repo` and `/workspace/repos`: to run them for real they are
 * rewritten onto a scratch root, so the commands are exercised exactly as the workspace sees them.
 */
const inScratch = (script: string, root: string) =>
  script.replaceAll("/workspace/", `${root}/workspace/`);

const runSh = (script: string) => {
  const result = spawnSync("sh", ["-c", script], { env: gitEnv, encoding: "utf8" });
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

/** A main worktree at `<root>/workspace/repo` and an origin to clone a sibling from. */
const makeWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-repos-"));
  const main = path.join(root, "workspace", "repo");
  fs.mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(main, "app.ts"), "export const answer = 41\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "initial"]);
  const originWork = path.join(root, "core-work");
  fs.mkdirSync(originWork);
  git(originWork, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(originWork, "lib.rs"), "fn main() {}\n");
  git(originWork, ["add", "-A"]);
  git(originWork, ["commit", "-q", "-m", "core base"]);
  const baseSha = git(originWork, ["rev-parse", "HEAD"]);
  const origin = path.join(root, "core.git");
  git(root, ["clone", "-q", "--bare", originWork, origin]);
  return { root, main, origin, baseSha };
};

describe("repositories in a session: the shell that brings one in (docs/adr/0010)", () => {
  it("clones the origin nested in the main worktree, on the session's branch at the base, linked at /workspace/repos/<name>, and excluded from the main repository", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    const script = inScratch(
      repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/feature", baseSha }),
      root,
    );
    const result = runSh(script);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    const nested = path.join(main, ".mend", "repos", "core");
    const link = path.join(root, "workspace", "repos", "core");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(nested));
    expect(git(nested, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("mend/feature");
    expect(git(nested, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(fs.existsSync(path.join(nested, "lib.rs"))).toBe(true);
    // The main repository never sees the sibling: not untracked, not a gitlink.
    expect(git(main, ["status", "--porcelain"])).toBe("");
    expect(fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8")).toContain(
      ".mend/\n",
    );
    // The ready mark says the add ran to its end: a relink trusts only a directory that has it.
    // It lives in a directory of its own, so a repository named `core.ready` cannot collide.
    expect(fs.statSync(path.join(main, ".mend", "ready", "core")).isFile()).toBe(true);
  });

  it("refuses to work behind a link at .mend, where the captures would carry only the link", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mend-elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(main, ".mend"));
    const cloned = runSh(
      inScratch(
        repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/x", baseSha }),
        root,
      ),
    );
    expect(cloned.exitCode).toBe(REPOSITORY_OUTSIDE_EXIT);
    expect(cloned.stderr).toContain("is a link");
    // Nothing was written behind the link, not even the directories.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    const relinked = runSh(inScratch(repositoryRelinkScript(["core"]), root));
    expect(parseRelinkReport(relinked.stdout).get("core")).toBe("outside");
  });

  it("adds the exclude on a line of its own when the exclude file ends without a newline", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    fs.mkdirSync(path.join(main, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "info", "exclude"), "scratch/");
    const result = runSh(
      inScratch(
        repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/x", baseSha }),
        root,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8")).toBe(
      "scratch/\n.mend/\n",
    );
    expect(git(main, ["status", "--porcelain"])).toBe("");
    // Running it again adds nothing.
    runSh(inScratch(repositoryRelinkScript(["core"]), root));
    expect(fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8")).toBe(
      "scratch/\n.mend/\n",
    );
  });

  it("refuses a directory that is not a link at the repository's path, and clones nothing", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    fs.mkdirSync(path.join(root, "workspace", "repos", "core"), { recursive: true });
    const result = runSh(
      inScratch(
        repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/x", baseSha }),
        root,
      ),
    );
    expect(result.exitCode).toBe(REPOSITORY_PATH_OCCUPIED_EXIT);
    expect(result.stderr).toContain("is not a link");
    expect(fs.existsSync(path.join(main, ".mend", "repos", "core"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "workspace", "repos", "core"))).toEqual([]);
  });

  it("refuses to clone over a directory that is already there, with its own exit code", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    fs.mkdirSync(path.join(main, ".mend", "repos", "core"), { recursive: true });
    const result = runSh(
      inScratch(
        repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/x", baseSha }),
        root,
      ),
    );
    expect(result.exitCode).toBe(REPOSITORY_EXISTS_EXIT);
    expect(result.stderr).toContain("already exists");
  });

  it("fails with git's own words when the base is not in the origin", () => {
    const { root, origin } = makeWorkspace();
    const result = runSh(
      inScratch(
        repositoryCloneScript({
          originUrl: origin,
          name: "core",
          branch: "mend/x",
          baseSha: "0123456789012345678901234567890123456789",
        }),
        root,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(failureReason(result.stderr, "fallback")).toMatch(/0123456789/);
  });

  it("relinks what came back after a restore and names what did not", () => {
    const { root, main, origin, baseSha } = makeWorkspace();
    runSh(
      inScratch(
        repositoryCloneScript({ originUrl: origin, name: "core", branch: "mend/x", baseSha }),
        root,
      ),
    );
    // A restore brings the nested directory back and not the link outside the captured root.
    fs.rmSync(path.join(root, "workspace", "repos"), { recursive: true, force: true });
    // An add that was interrupted before its ready mark: a directory, no mark.
    fs.mkdirSync(path.join(main, ".mend", "repos", "half", ".git"), { recursive: true });
    // A directory that is not a link where the link should go.
    fs.mkdirSync(path.join(root, "workspace", "repos", "taken"), { recursive: true });
    fs.mkdirSync(path.join(main, ".mend", "repos", "taken", ".git"), { recursive: true });
    fs.writeFileSync(path.join(main, ".mend", "ready", "taken"), "");
    const result = runSh(
      inScratch(repositoryRelinkScript(["core", "sealantd", "half", "taken"]), root),
    );
    expect(result.exitCode).toBe(0);
    const report = parseRelinkReport(result.stdout);
    expect(report.get("core")).toBe("ready");
    expect(report.get("sealantd")).toBe("missing");
    expect(report.get("half")).toBe("partial");
    expect(report.get("taken")).toBe("occupied");
    const link = path.join(root, "workspace", "repos", "core");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(main, ".mend", "repos", "core")));
    expect(fs.existsSync(path.join(root, "workspace", "repos", "sealantd"))).toBe(false);
    expect(fs.existsSync(path.join(root, "workspace", "repos", "half"))).toBe(false);
    // The occupied directory is left exactly as it was: no link made inside it.
    expect(fs.readdirSync(path.join(root, "workspace", "repos", "taken"))).toEqual([]);
  });

  it("reads only the words it knows from a relink report", () => {
    const report = parseRelinkReport(
      "ready core\nnoise\nmissing a b\noccupied x\n\nunlinked y\noutside z\nbogus w\n",
    );
    expect([...report.entries()]).toEqual([
      ["core", "ready"],
      ["a b", "missing"],
      ["x", "occupied"],
      ["y", "unlinked"],
      ["z", "outside"],
    ]);
  });

  it("quotes every value it interpolates", () => {
    const script = repositoryCloneScript({
      originUrl: "git@github.com:org/it's.git",
      name: "core",
      branch: "mend/a b",
      baseSha: "abc",
    });
    expect(script).toContain(`'git@github.com:org/it'\\''s.git'`);
    expect(script).toContain(`'mend/a b'`);
    expect(repositoryRelinkScript(["a", "b c"])).toContain(`for name in 'a' 'b c'; do`);
  });

  it("keeps a failure's reason short and never empty", () => {
    expect(failureReason("", "the clone ended with exit 128")).toBe(
      "the clone ended with exit 128",
    );
    expect(failureReason("fatal: one\n\nfatal: two\nfatal: three\nfatal: four\n", "x")).toBe(
      "fatal: two · fatal: three · fatal: four",
    );
    expect(failureReason("x".repeat(900), "x")).toHaveLength(500);
  });
});
