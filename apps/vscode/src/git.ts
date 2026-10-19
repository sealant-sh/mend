import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import type * as vscode from "vscode";

import type { CheckoutFact } from "./new-session.js";
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

const succeeds = async (cwd: string, args: ReadonlyArray<string>): Promise<boolean> => {
  try {
    await execFileAsync("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the folder's commits are on origin, so the server's store can start from its branch:
 * the branch, its upstream (else `origin/<branch>`), and whether HEAD is an ancestor of it. Read
 * from what this machine last fetched; nothing is fetched.
 */
export const checkoutFact = async (folder: vscode.WorkspaceFolder): Promise<CheckoutFact> => {
  if (folder.uri.scheme !== "file") return { kind: "elsewhere" };
  const cwd = folder.uri.fsPath;
  const branch = await git(cwd, ["branch", "--show-current"]);
  if (branch === null) return { kind: "elsewhere" };
  const tracking =
    (await git(cwd, ["rev-parse", "--verify", "--quiet", "@{upstream}"])) ??
    (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]));
  const pushed =
    tracking !== null && (await succeeds(cwd, ["merge-base", "--is-ancestor", "HEAD", tracking]));
  return { kind: pushed ? "pushed" : "unpushed", branch };
};

const pathFlavor = (value: string): typeof path.posix | typeof path.win32 =>
  value.includes("\\") && !value.includes("/") ? path.win32 : path.posix;

/** Absolute host path of one session worktree. */
export const worktreePath = (project: Project, session: Session): string => {
  const flavor = pathFlavor(project.storePath);
  return flavor.join(flavor.dirname(project.storePath), "worktrees", session.worktree);
};
