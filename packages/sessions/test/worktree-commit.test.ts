import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeGitRefused } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { commitWorktree } from "../src/worktree-commit.ts";

const execute = (argv: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = spawnSync(argv[0] ?? "", argv.slice(1), { encoding: "utf8" });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  });

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "mend-worktree-commit-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@localhost");
  writeFileSync(join(directory, "one"), "before\n");
  writeFileSync(join(directory, "two"), "before\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return {
    directory,
    git,
    execute,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
};

describe("native worktree commits", () => {
  it("commits selected literal paths with the custom message, ordinary author and hooks, without pushing", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.directory, "one"), "selected\n");
      writeFileSync(join(f.directory, "two"), "staged but not selected\n");
      f.git("add", "two");
      writeFileSync(join(f.directory, "[literal]"), "new\n");
      const hook = join(f.directory, ".git/hooks/pre-commit");
      writeFileSync(hook, "#!/bin/sh\nprintf 'ran' > hook-ran\n");
      chmodSync(hook, 0o755);
      const result = await Effect.runPromise(
        commitWorktree(
          f.directory,
          { message: "Fix parser\n\nKeep this body.", filePaths: ["one", "[literal]"] },
          f.execute,
          () => Effect.die("custom messages must not use inference"),
        ),
      );
      expect(result).toMatchObject({ status: "created", subject: "Fix parser" });
      expect(f.git("show", "--format=", "--name-only", "HEAD").split("\n")).toEqual([
        "[literal]",
        "one",
      ]);
      expect(f.git("log", "-1", "--format=%B")).toBe("Fix parser\n\nKeep this body.");
      expect(f.git("log", "-1", "--format=%an <%ae>")).toBe("Owner <owner@localhost>");
      expect(f.git("diff", "--cached")).toBe("");
      expect(f.git("diff", "--name-only").split("\n")).toEqual(["two"]);
      expect(readFileSync(join(f.directory, "hook-ran"), "utf8")).toBe("ran");
      expect(f.git("branch", "--show-current")).toBe("main");
      expect(f.git("remote")).toBe("");
    } finally {
      f.close();
    }
  });

  it("generates from a temporary index without touching staging, then commits all files and skips clean retries", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.directory, "one"), "staged\n");
      f.git("add", "one");
      writeFileSync(join(f.directory, "one"), "working\n");
      writeFileSync(join(f.directory, "new"), "new\n");
      const index = readFileSync(join(f.directory, ".git/index"));
      let generations = 0;
      const result = await Effect.runPromise(
        commitWorktree(f.directory, {}, f.execute, (context) =>
          Effect.sync(() => {
            generations++;
            expect(readFileSync(join(f.directory, ".git/index"))).toEqual(index);
            expect(context.summary).toContain("one");
            expect(context.summary).toContain("new");
            expect(context.patch).toContain("+working");
            return "Record work\n\nGenerated body";
          }),
        ),
      );
      expect(result).toMatchObject({ status: "created", subject: "Record work" });
      expect(f.git("status", "--porcelain")).toBe("");
      expect(
        await Effect.runPromise(
          commitWorktree(f.directory, {}, f.execute, () => Effect.die("clean commit generated")),
        ),
      ).toEqual({ status: "skipped_no_changes" });
      expect(generations).toBe(1);
    } finally {
      f.close();
    }
  });

  it("leaves real staging intact on failed generation and refuses escaping paths", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.directory, "one"), "staged\n");
      f.git("add", "one");
      writeFileSync(join(f.directory, "one"), "working\n");
      const index = readFileSync(join(f.directory, ".git/index"));
      const head = f.git("rev-parse", "HEAD");
      const failed = await Effect.runPromise(
        Effect.flip(
          commitWorktree(f.directory, {}, f.execute, () =>
            Effect.fail(new WorktreeGitRefused({ code: "unavailable", message: "No login" })),
          ),
        ),
      );
      expect(failed.message).toBe("No login");
      for (const file of ["../outside", "/tmp/outside", ".git/config", "a\0b"]) {
        expect(
          await Effect.runPromise(
            Effect.flip(
              commitWorktree(
                f.directory,
                { message: "invalid", filePaths: [file] },
                f.execute,
                () => Effect.die("generated"),
              ),
            ),
          ),
        ).toBeInstanceOf(WorktreeGitRefused);
      }
      expect(readFileSync(join(f.directory, ".git/index"))).toEqual(index);
      expect(f.git("rev-parse", "HEAD")).toBe(head);
    } finally {
      f.close();
    }
  });
});
