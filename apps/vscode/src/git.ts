import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type * as vscode from "vscode";

import type { CheckoutFact } from "./new-session.js";
import type { CanonicalPaths } from "./project-match.js";
import type { Project, RepositoryFacts, Session } from "./types.js";

/** What one git command said: its output, a non-zero exit, or nothing within the bound. */
export type GitAnswer =
  | { readonly kind: "out"; readonly stdout: string }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "unanswered" };

export type Git = (cwd: string, args: ReadonlyArray<string>) => Promise<GitAnswer>;

/** A probe's bound: a hung git or filesystem leaves the fact unknown, never New session hidden. */
export const GIT_PROBE_MS = 3_000;

export const gitRunner =
  ({ timeoutMs = GIT_PROBE_MS, binary = "git" } = {}): Git =>
  (cwd, args) =>
    new Promise((resolve) => {
      execFile(binary, args, { cwd, encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
        if (error === null) resolve({ kind: "out", stdout: stdout.trim() });
        else if (typeof error.code === "number" && error.killed !== true)
          resolve({ kind: "exit", code: error.code });
        else resolve({ kind: "unanswered" });
      });
    });

const defaultGit = gitRunner();

/** Repository identity available from a VS Code workspace folder. */
export const repositoryFacts = async (
  folder: vscode.WorkspaceFolder,
  git: Git = defaultGit,
): Promise<RepositoryFacts> => {
  if (folder.uri.scheme !== "file") {
    const remotePath = folder.uri.path.replace(/\/$/, "");
    return {
      path: remotePath,
      folder: path.posix.basename(remotePath),
      originUrl: null,
      originUnknown: false,
    };
  }
  return localRepositoryFacts(folder.uri.fsPath, git);
};

export const localRepositoryFacts = async (cwd: string, git: Git): Promise<RepositoryFacts> => {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.kind === "out" && top.stdout !== "" ? top.stdout : cwd;
  const origin = top.kind === "unanswered" ? top : await git(root, ["remote", "get-url", "origin"]);
  return {
    path: root,
    folder: path.basename(root),
    originUrl: origin.kind === "out" && origin.stdout !== "" ? origin.stdout : null,
    originUnknown: origin.kind === "unanswered",
  };
};

export type RealPath = (path: string) => Promise<string>;

/** How this extension host resolves a folder's paths: one on another machine compares as written. */
export const realPathFor = (folder: vscode.WorkspaceFolder): RealPath =>
  folder.uri.scheme === "file" ? (one) => fs.realpath(one) : async (one) => one;

/**
 * Each path through its symlinks, within the probe bound. A path that does not resolve in time, or
 * at all, is left out, so it matches nothing.
 */
export const canonicalPaths = async (
  paths: ReadonlyArray<string>,
  realpath: RealPath,
  timeoutMs = GIT_PROBE_MS,
): Promise<CanonicalPaths> => {
  const resolved = await Promise.all(
    paths.map(async (one): Promise<ReadonlyArray<[string, string]>> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, null);
      });
      const real = await Promise.race([
        Promise.resolve()
          .then(() => realpath(one))
          .catch(() => null),
        late,
      ]).finally(() => clearTimeout(timer));
      return real === null ? [] : [[one, real]];
    }),
  );
  return new Map(resolved.flat());
};

/**
 * Whether the folder's commits are on origin, so the server's store can start from them: the
 * branch, `origin/<branch>` (else its upstream), and whether HEAD is an ancestor of it. Read from
 * what this machine last fetched; nothing is fetched. A probe that hangs or fails, and a "no" from
 * a shallow clone, read unknown, never unpushed.
 */
export const checkoutFact = async (
  folder: vscode.WorkspaceFolder,
  git: Git = defaultGit,
): Promise<CheckoutFact> =>
  folder.uri.scheme === "file" ? readCheckout(folder.uri.fsPath, git) : { kind: "elsewhere" };

export const readCheckout = async (cwd: string, git: Git): Promise<CheckoutFact> => {
  const current = await git(cwd, ["branch", "--show-current"]);
  if (current.kind === "unanswered") return { kind: "unknown", branch: null };
  if (current.kind !== "out" || current.stdout === "") return { kind: "elsewhere" };
  const branch = current.stdout;
  const upstreamOf = (spec: string): Promise<GitAnswer> =>
    git(cwd, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", spec]);
  // Her branch on origin first: pushed without `-u`, it is there while `@{upstream}` still names
  // the branch it was cut from.
  let upstream = await upstreamOf(`refs/remotes/origin/${branch}`);
  if (upstream.kind === "exit") upstream = await upstreamOf("@{upstream}");
  if (upstream.kind === "unanswered") return { kind: "unknown", branch };
  if (upstream.kind !== "out" || !upstream.stdout.startsWith("refs/remotes/"))
    return { kind: "unpushed", branch };
  const ref = upstream.stdout;
  // One read of the upstream: a fetch that moves the ref later cannot pass a commit that lacks HEAD.
  const commit = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (commit.kind !== "out" || commit.stdout === "") return { kind: "unknown", branch };
  const ancestry = await git(cwd, ["merge-base", "--is-ancestor", "HEAD", commit.stdout]);
  if (ancestry.kind === "out")
    return { kind: "pushed", branch, upstream: ref, commit: commit.stdout };
  if (ancestry.kind !== "exit" || ancestry.code !== 1) return { kind: "unknown", branch };
  // In a shallow clone git answers 1 when the boundary hides the ancestry, not only for "no".
  const shallow = await git(cwd, ["rev-parse", "--is-shallow-repository"]);
  return shallow.kind === "out" && shallow.stdout === "false"
    ? { kind: "unpushed", branch }
    : { kind: "unknown", branch };
};

const pathFlavor = (value: string): typeof path.posix | typeof path.win32 =>
  value.includes("\\") && !value.includes("/") ? path.win32 : path.posix;

/** Absolute host path of one session worktree. */
export const worktreePath = (project: Project, session: Session): string => {
  const flavor = pathFlavor(project.storePath);
  return flavor.join(flavor.dirname(project.storePath), "worktrees", session.worktree);
};
