import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  canonicalPaths,
  gitRunner,
  localRepositoryFacts,
  readCheckout,
  type Git,
  type RealPath,
} from "./git.js";
import { DEFAULT_OPTIONS, resolveBase } from "./new-session.js";
import { comparedPaths, matchProject } from "./project-match.js";
import type { Project } from "./types.js";

const scratch = mkdtempSync(path.join(tmpdir(), "mend-vscode-git-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sh = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Dana",
      "-c",
      "user.email=dana@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

/** An origin with one commit on main, and a clone of it. */
const cloned = (name: string): { readonly origin: string; readonly clone: string } => {
  const origin = path.join(scratch, `${name}-origin`);
  const clone = path.join(scratch, name);
  execFileSync("mkdir", ["-p", origin]);
  sh(origin, "init", "--quiet");
  sh(origin, "commit", "--quiet", "--allow-empty", "-m", "first");
  sh(scratch, "clone", "--quiet", origin, clone);
  return { origin, clone };
};

const git = gitRunner();

describe("readCheckout", () => {
  it("reads a branch tracking origin/main under another name as pushed, with the upstream it proved", async () => {
    const { clone } = cloned("renamed");
    sh(clone, "checkout", "--quiet", "-b", "fix/login", "--track", "origin/main");
    const fact = await readCheckout(clone, git);
    expect(fact).toEqual({
      kind: "pushed",
      branch: "fix/login",
      upstream: "refs/remotes/origin/main",
      commit: sh(clone, "rev-parse", "origin/main"),
    });
  });

  it("proves a branch pushed without -u against origin/<branch>, not the upstream it was cut from", async () => {
    const { clone } = cloned("pushed-no-u");
    sh(clone, "checkout", "--quiet", "-b", "fix/login", "--track", "origin/main");
    sh(clone, "commit", "--quiet", "--allow-empty", "-m", "the fix");
    sh(clone, "push", "--quiet", "origin", "fix/login");
    expect(sh(clone, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
      "refs/remotes/origin/main",
    );
    expect(await readCheckout(clone, git)).toEqual({
      kind: "pushed",
      branch: "fix/login",
      upstream: "refs/remotes/origin/fix/login",
      commit: sh(clone, "rev-parse", "HEAD"),
    });
  });

  it("reads a local commit as unpushed, and a branch with no remote-tracking ref alike", async () => {
    const { clone } = cloned("ahead");
    sh(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
    expect(await readCheckout(clone, git)).toEqual({ kind: "unpushed", branch: "main" });
    sh(clone, "checkout", "--quiet", "-b", "spike");
    expect(await readCheckout(clone, git)).toEqual({ kind: "unpushed", branch: "spike" });
  });

  it("reads a detached HEAD as elsewhere", async () => {
    const { clone } = cloned("detached");
    sh(clone, "checkout", "--quiet", "--detach");
    expect(await readCheckout(clone, git)).toEqual({ kind: "elsewhere" });
  });

  it("reads a merge-base that fails other than 'no' as unknown", async () => {
    const { clone } = cloned("merge-base-fails");
    const failing: Git = (cwd, args) =>
      args[0] === "merge-base" ? Promise.resolve({ kind: "exit", code: 128 }) : git(cwd, args);
    expect(await readCheckout(clone, failing)).toEqual({ kind: "unknown", branch: "main" });
  });

  it("reads a shallow clone whose boundary hides the ancestry as unknown, not unpushed", async () => {
    const { origin } = cloned("shallow");
    const clone = path.join(scratch, "shallow-depth-1");
    sh(scratch, "clone", "--quiet", "--depth", "1", `file://${origin}`, clone);
    sh(origin, "commit", "--quiet", "--allow-empty", "-m", "second");
    sh(clone, "fetch", "--quiet", "--depth", "1", "origin", "main");
    const hidden = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      cwd: clone,
      encoding: "utf8",
    });
    expect({ status: hidden.status, stderr: hidden.stderr }).toEqual({ status: 1, stderr: "" });
    expect(sh(origin, "merge-base", "--is-ancestor", sh(clone, "rev-parse", "HEAD"), "main")).toBe(
      "",
    );
    const checkout = await readCheckout(clone, git);
    expect(checkout).toEqual({ kind: "unknown", branch: "main" });
    expect(
      resolveBase({
        project: {
          id: "p1",
          name: "shallow",
          originUrl: origin,
          storePath: "/s",
          defaultBranch: "main",
        },
        join: null,
        prompt: "fix it",
        options: DEFAULT_OPTIONS,
        checkout,
        refusedBase: null,
      }),
    ).toEqual({ kind: "ref", ref: "main", shown: "main", note: "couldn't read your branch" });
  });

  it("checks HEAD against the upstream commit it read once, not the ref a fetch moves after", async () => {
    const { clone } = cloned("moved");
    const before = sh(clone, "rev-parse", "origin/main");
    sh(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
    const asked: Array<ReadonlyArray<string>> = [];
    const fetching: Git = async (cwd, args) => {
      asked.push(args);
      const answer = await git(cwd, args);
      if (args.at(-1) === "refs/remotes/origin/main^{commit}")
        sh(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
      return answer;
    };
    expect(await readCheckout(clone, fetching)).toEqual({ kind: "unpushed", branch: "main" });
    expect(asked).toContainEqual(["merge-base", "--is-ancestor", "HEAD", before]);
  });

  it("reads a git that hangs as unknown within the bound, never as unpushed", async () => {
    const hung = path.join(scratch, "hung-git");
    writeFileSync(hung, "#!/bin/sh\nsleep 10\n");
    chmodSync(hung, 0o755);
    const slow = gitRunner({ timeoutMs: 200, binary: hung });
    const started = Date.now();
    expect(await readCheckout(scratch, slow)).toEqual({ kind: "unknown", branch: null });
    expect(await localRepositoryFacts(scratch, slow)).toMatchObject({
      originUrl: null,
      originUnknown: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("localRepositoryFacts", () => {
  it("reads the origin, and says so when there is none", async () => {
    const { origin, clone } = cloned("facts");
    expect(await localRepositoryFacts(clone, git)).toEqual({
      path: clone,
      folder: "facts",
      originUrl: origin,
      originUnknown: false,
    });
    sh(clone, "remote", "remove", "origin");
    expect(await localRepositoryFacts(clone, git)).toMatchObject({
      originUrl: null,
      originUnknown: false,
    });
  });
});

const tool = (originUrl: string, storePath: string): Project => ({
  id: "p1",
  name: "tool",
  originUrl,
  storePath,
  defaultBranch: "main",
});
const matchAt = async (projects: ReadonlyArray<Project>, cwd: string, resolve: RealPath) => {
  const facts = await localRepositoryFacts(cwd, git);
  const real = await canonicalPaths(comparedPaths(projects, facts), resolve, 200);
  return matchProject(projects, facts, real);
};
const onDisk: RealPath = (one) => realpath(one);
const refused: RealPath = async () => {
  throw new Error("EACCES");
};
const hung: RealPath = () => new Promise(() => {});

describe("a window matched to its project by path (B1)", () => {
  it("matches a source adopted through a symlink, and a worktree under a store reached through one", async () => {
    const { clone } = cloned("linked");
    const alias = path.join(scratch, "alias");
    symlinkSync(scratch, alias);
    const adopted = tool(path.join(alias, "linked"), "/var/lib/mend/store/tool/repo");
    expect(await matchAt([adopted], clone, onDisk)).toEqual({
      status: "matched",
      project: adopted,
      matchedBy: "path",
    });
    const fix = path.join(scratch, "store", "tool", "worktrees", "fix");
    execFileSync("mkdir", ["-p", path.dirname(fix)]);
    sh(scratch, "clone", "--quiet", clone, fix);
    const stored = tool("git@github.com:dana/tool.git", path.join(alias, "store", "tool", "repo"));
    expect(await matchAt([stored], fix, onDisk)).toEqual({
      status: "matched",
      project: stored,
      matchedBy: "path",
    });
  });

  it("matches nothing by path when a path does not resolve, or not within the bound", async () => {
    const { clone } = cloned("unresolved");
    const adopted = tool(clone, "/var/lib/mend/store/tool/repo");
    expect(await matchAt([adopted], clone, onDisk)).toMatchObject({ status: "matched" });
    expect(await matchAt([adopted], clone, refused)).toEqual({ status: "not-found" });
    const started = Date.now();
    expect(await matchAt([adopted], clone, hung)).toEqual({ status: "not-found" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
