import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { localWorktreeGitStatus } from "../src/worktree-git-status.ts";

describe("working-tree commit selection", () => {
  it("shows staged, unstaged and untracked paths without calling committed branch work dirty or changing the index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mend-git-status-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git("init", "-b", "main");git("config", "user.name", "Fixture");git("config", "user.email", "fixture@localhost");
      writeFileSync(join(directory, "one"), "base\n");writeFileSync(join(directory, "two"), "base\n");
      git("add", "-A");git("commit", "-m", "base");git("switch", "-c", "topic");
      writeFileSync(join(directory, "one"), "committed\n");git("commit", "-am", "branch work");
      expect(await Effect.runPromise(localWorktreeGitStatus(directory))).toMatchObject({ dirty: false, files: [] });
      writeFileSync(join(directory, "one"), "staged\n");git("add", "one");
      writeFileSync(join(directory, "one"), "committed\n"); // Index differs even though HEAD and worktree agree.
      writeFileSync(join(directory, "two"), "unstaged\n");
      writeFileSync(join(directory, "new [file]\n"), "untracked\n");
      const index = readFileSync(join(directory, ".git/index"));
      const status = await Effect.runPromise(localWorktreeGitStatus(directory));
      expect(status.dirty).toBe(true);
      expect(status.files.map(file => file.path).toSorted()).toEqual(["new [file]\n", "one", "two"]);
      expect(status.files.find(file => file.path === "new [file]\n")).toMatchObject({ insertions: 0, deletions: 0 });
      expect(readFileSync(join(directory, ".git/index"))).toEqual(index);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
