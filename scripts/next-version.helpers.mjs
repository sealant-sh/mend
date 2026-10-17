// Fixtures shared by the next-version tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const changeset = (entries) =>
  `---\n${entries.map(([name, level]) => `"${name}": ${level}`).join("\n")}\n---\n\nWhat changed.\n`;

const home = process.cwd();

/** A throwaway repository with Mend's layout: apps/cli/package.json and .changeset/. */
export const repository = (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-version-"));
  const cwd = home;
  process.chdir(repo);
  t.after(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const remove = (file) => unlinkSync(path.join(repo, file));
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--allow-empty", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const setVersion = (version) =>
    write("apps/cli/package.json", JSON.stringify({ name: "@sealant/mend", version }));
  git("init", "-q", "-b", "main");
  write(".changeset/config.json", "{}");
  write(".changeset/README.md", "not a changeset");
  return { repo, git, write, remove, commit, setVersion };
};
