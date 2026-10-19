import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import type * as vscode from "vscode";

import type { Project, RepositoryFacts, Session } from "./types.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  try {
    const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    const output = result.stdout.trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
};

/** Repository identity available from a VS Code workspace folder. */
export const repositoryFacts = async (folder: vscode.WorkspaceFolder): Promise<RepositoryFacts> => {
  if (folder.uri.scheme !== "file") {
    const remotePath = folder.uri.path.replace(/\/$/, "");
    return {
      path: remotePath,
      folder: path.posix.basename(remotePath),
      originUrl: null,
    };
  }
  const root =
    (await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"])) ?? folder.uri.fsPath;
  return {
    path: root,
    folder: path.basename(root),
    originUrl: await git(root, ["remote", "get-url", "origin"]),
  };
};

export const currentBranch = async (
  folder: vscode.WorkspaceFolder | undefined,
): Promise<string | null> => {
  if (folder === undefined || folder.uri.scheme !== "file") return null;
  return git(folder.uri.fsPath, ["branch", "--show-current"]);
};

const pathFlavor = (value: string): typeof path.posix | typeof path.win32 =>
  value.includes("\\") && !value.includes("/") ? path.win32 : path.posix;

/** Absolute host path of one session worktree. */
export const worktreePath = (project: Project, session: Session): string => {
  const flavor = pathFlavor(project.storePath);
  return flavor.join(flavor.dirname(project.storePath), "worktrees", session.worktree);
};
