import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { rollbackFilesExec } from "../../src/rollback-files.ts";
const exec = promisify(execFile);
const roots: string[] = [];
export const rollbackFileFixture = async () => {
  const { stdout } = await exec("mktemp", ["-d", "-t", "mend-rollback-files.XXXXXX"]);
  const root = stdout.trim();
  roots.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    exec("git", args, {
      cwd: repo,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fake",
        GIT_AUTHOR_EMAIL: "fake@example.invalid",
        GIT_COMMITTER_NAME: "Fake",
        GIT_COMMITTER_EMAIL: "fake@example.invalid",
      },
    });
  await git("init", "-q");
  await fs.writeFile(path.join(repo, "tracked"), "baseline\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored\n");
  await git("add", ".");
  await git("commit", "-qm", "baseline");
  const target = (await git("rev-parse", "HEAD")).stdout.trim();
  const nativeRoot = path.join(root, "native");
  await fs.mkdir(path.join(nativeRoot, ".codex", "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(nativeRoot, ".codex", "sessions", "conversation.jsonl"),
    "native evidence\n",
  );
  const input = {
    operationId: "operation",
    generation: 1,
    repository: repo,
    journalRoot: path.join(root, "history"),
    nativeRoot,
    nativePaths: [".codex/sessions"],
    target,
  };
  const call = async (action: "save" | "restore" | "inspect" | "restoreSaved") => {
    const [program, ...args] = rollbackFilesExec({ ...input, action });
    if (program === undefined) throw new Error("Missing helper command");
    return exec(program, args, {
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  return { root, repo, git, target, input, call };
};

export const cleanupRollbackFiles = async () => {
  for (const root of roots.splice(0)) {
    console.info("Removing task fixture", root, await fs.readdir(root));
    await fs.rm(root, { recursive: true });
  }
};
