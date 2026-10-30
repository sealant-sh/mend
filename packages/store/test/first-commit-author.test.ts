import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { firstCommitAuthor } from "@mend/domain/workbench";
import { afterAll, describe, expect, it } from "vitest";

describe("authors a first commit with a name the real git binary stores unchanged", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-first-commit-author-"));
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: repository,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  execFileSync("git", ["init", "--quiet", "--bare", repository], { env });
  const tree = execFileSync("git", ["mktree"], { cwd: repository, env, input: "" })
    .toString()
    .trim();
  /** The author name git stores for `name`, or null when git refuses it. */
  const storedByGit = (name: string): string | null => {
    const ident = { GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_EMAIL: "a@example.com" };
    const result = spawnSync("git", ["commit-tree", tree, "-m", "probe"], {
      cwd: repository,
      env: { ...env, ...ident, GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name },
    });
    if (result.status !== 0) return null;
    const commit = result.stdout.toString().trim();
    return execFileSync("git", ["log", "-1", "--format=%an", commit], { cwd: repository, env })
      .toString()
      .replace(/\n$/, "");
  };
  afterAll(() => fs.rmSync(repository, { recursive: true, force: true }));

  it.each([
    [":", "jane.doe@example.com", "jane.doe"],
    [";", "jane.doe@example.com", "jane.doe"],
    [",", "jane.doe@example.com", "jane.doe"],
    ["Alice:", "alice@example.com", "Alice"],
    ["Alice;", "alice@example.com", "Alice"],
    ["<>", "jane.doe@example.com", "jane.doe"],
    ["Jane <Team>", "jane.doe@example.com", "Jane Team"],
    ["Jane\nDoe", "jane.doe@example.com", "JaneDoe"],
    [" .Anna Ng. ", "anna@example.com", ".Anna Ng."],
    ['"Anna", ', "anna@example.com", "Anna"],
    ["", "Cleo.Q+mend@example.com", "Cleo.Q+mend"],
    ["  ", "'cleo'@example.com", "cleo"],
    [":", ":;,@example.com", "person"],
    ["", "", "person"],
  ])("%j with email %j as %j", (name, email, expected) => {
    const author = firstCommitAuthor({ name, email });
    expect(author.name).toBe(expected);
    expect(storedByGit(author.name)).toBe(author.name);
    const git = storedByGit(name.trim());
    if (git !== null) expect(author.name).toBe(git);
  });
  it("keeps a long name git stores whole", () => {
    const name = "x".repeat(201);
    expect(firstCommitAuthor({ name, email: "x@example.com" }).name).toBe(name);
    expect(storedByGit(name)).toBe(name);
  });
});
