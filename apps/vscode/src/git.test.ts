import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { gitRunner, localRepositoryFacts, readCheckout, type Git } from "./git.js";

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

  it("reads a merge-base that fails other than 'no' (a shallow clone's missing history) as unknown", async () => {
    const { clone } = cloned("shallow");
    const failing: Git = (cwd, args) =>
      args[0] === "merge-base" ? Promise.resolve({ kind: "exit", code: 128 }) : git(cwd, args);
    expect(await readCheckout(clone, failing)).toEqual({ kind: "unknown", branch: "main" });
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
