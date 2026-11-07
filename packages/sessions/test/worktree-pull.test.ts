import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { pullWorktree } from "../src/worktree-pull.ts";

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const execute = (argv: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = spawnSync(argv[0] ?? "", argv.slice(1), { encoding: "utf8" });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  });
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "mend-worktree-pull-"));
  const remote = join(directory, "remote.git");
  const source = join(directory, "source");
  const work = join(directory, "work");
  git(directory, "init", "--bare", "-b", "main", remote);
  git(directory, "clone", remote, source);
  git(source, "config", "user.name", "Owner");
  git(source, "config", "user.email", "owner@localhost");
  writeFileSync(join(source, "one"), "before\n");
  git(source, "add", "one");
  git(source, "commit", "-m", "initial");
  git(source, "push", "origin", "main");
  git(directory, "clone", remote, work);
  const advance = () => {
    writeFileSync(join(source, "one"), "remote change\n");
    git(source, "commit", "-am", "remote change");
    git(source, "push", "origin", "main");
    return git(source, "rev-parse", "HEAD");
  };
  return { source, work, advance, close: () => rmSync(directory, { recursive: true, force: true }) };
};

// People press Pull when their branch's upstream moves. T3 v0.1.2 only fast-forwards.
describe("native worktree pull", () => {
  it("fast-forwards the configured upstream and reports an up-to-date retry", async () => {
    const f = fixture();
    try {
      const sha = f.advance();
      expect(await Effect.runPromise(pullWorktree(f.work, execute))).toEqual({
        status: "pulled", refName: "main", upstreamRef: "origin/main",
      });
      expect(git(f.work, "rev-parse", "HEAD")).toBe(sha);
      expect(readFileSync(join(f.work, "one"), "utf8")).toBe("remote change\n");
      expect(await Effect.runPromise(pullWorktree(f.work, execute))).toMatchObject({ status: "skipped_up_to_date" });
    } finally { f.close(); }
  });

  it("refuses overwrites and divergence without merging or losing local work", async () => {
    const f = fixture();
    try {
      f.advance();
      writeFileSync(join(f.work, "one"), "local work\n");
      const head = git(f.work, "rev-parse", "HEAD");
      const refused = await Effect.runPromise(Effect.flip(pullWorktree(f.work, execute)));
      expect(refused.code).toBe("git");
      expect(git(f.work, "rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(f.work, "one"), "utf8")).toBe("local work\n");
      git(f.work, "-c", "user.name=Owner", "-c", "user.email=owner@localhost", "commit", "-am", "local work");
      const diverged = git(f.work, "rev-parse", "HEAD");
      expect((await Effect.runPromise(Effect.flip(pullWorktree(f.work, execute)))).code).toBe("git");
      expect(git(f.work, "rev-parse", "HEAD")).toBe(diverged);
    } finally { f.close(); }
  });

  it("refuses a detached head or an unconfigured upstream before fetching", async () => {
    const f = fixture();
    try {
      git(f.work, "branch", "--unset-upstream");
      expect((await Effect.runPromise(Effect.flip(pullWorktree(f.work, execute)))).message).toContain("no upstream");
      git(f.work, "checkout", "--detach");
      expect((await Effect.runPromise(Effect.flip(pullWorktree(f.work, execute)))).message).toContain("detached HEAD");
    } finally { f.close(); }
  });
});
