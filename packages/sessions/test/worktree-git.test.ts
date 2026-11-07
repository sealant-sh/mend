import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeId } from "@mend/domain";
import { WorktreeGitRefused, type WorktreeBranchAction } from "@mend/domain/workbench";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { capturedBranchRefs, localBranchRefs } from "../src/worktree-git-reads.ts";
import { changeWorktreeBranch, makeWorktreeGitGate } from "../src/worktree-git.ts";

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "mend-worktree-git-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@localhost");
  writeFileSync(join(directory, "file"), "first\n");
  git("add", "file");
  git("commit", "-m", "first");
  const act = (action: WorktreeBranchAction) =>
    changeWorktreeBranch(directory, action, (argv) =>
      Effect.sync(() => {
        const result = spawnSync(argv[0] ?? "", argv.slice(1), { encoding: "utf8" });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }),
    );
  return { directory, git, act, close: () => rmSync(directory, { recursive: true, force: true }) };
};

describe("native branch operations", () => {
  it("lists retained local and remote branches after switching away", async () => {
    const f = fixture();
    try {
      f.git("remote", "add", "origin", f.directory);
      f.git("update-ref", "refs/remotes/origin/topic", "HEAD");
      f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic");
      f.git("update-ref", "refs/mend/checkpoints/internal", "HEAD");
      await Effect.runPromise(f.act({ kind: "switch", refName: "origin/topic" }));
      await Effect.runPromise(f.act({ kind: "switch", refName: "main" }));
      expect(await Effect.runPromise(localBranchRefs(f.directory))).toEqual([
        { name: "main", isRemote: false, current: true, upstreamRef: null },
        {
          name: "topic",
          isRemote: false,
          current: false,
          upstreamRef: "refs/remotes/origin/topic",
        },
        { name: "origin/topic", isRemote: true, current: false, upstreamRef: null },
      ]);
    } finally {
      f.close();
    }
  });

  it("lists each capture's saved refs even when another capture has moved the cache", () => {
    const first = {
      refs: {
        "refs/heads/main": "a",
        "refs/heads/topic": "b",
        "refs/remotes/origin/main": "a",
        "refs/remotes/origin/HEAD": "a",
        "refs/mend/internal": "b",
      },
      head: "refs/heads/topic",
    };
    const second = { refs: { "refs/heads/main": "a" }, head: "refs/heads/main" };
    expect(capturedBranchRefs(second)).toEqual([
      { name: "main", isRemote: false, current: true, upstreamRef: null },
    ]);
    expect(capturedBranchRefs(first)).toEqual([
      { name: "main", isRemote: false, current: false, upstreamRef: null },
      { name: "topic", isRemote: false, current: true, upstreamRef: null },
      { name: "origin/main", isRemote: true, current: false, upstreamRef: null },
    ]);
  });

  it("creates without switching, switches with dirty work intact, and returns to the previous branch", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.directory, "file"), "staged\n");
      f.git("add", "file");
      writeFileSync(join(f.directory, "file"), "unstaged\n");
      const index = readFileSync(join(f.directory, ".git/index"));
      expect(
        await Effect.runPromise(
          f.act({ kind: "create", refName: "feature/new", switchRef: false }),
        ),
      ).toEqual({ refName: "feature/new", branch: "main" });
      expect(f.git("branch", "--show-current")).toBe("main");
      expect(await Effect.runPromise(f.act({ kind: "switch", refName: "feature/new" }))).toEqual({
        refName: "feature/new",
        branch: "feature/new",
      });
      expect(readFileSync(join(f.directory, "file"), "utf8")).toBe("unstaged\n");
      expect(readFileSync(join(f.directory, ".git/index"))).toEqual(index);
      expect(await Effect.runPromise(f.act({ kind: "switch", refName: "-" }))).toEqual({
        refName: "main",
        branch: "main",
      });
      expect(
        await Effect.runPromise(
          f.act({ kind: "create", refName: "feature/next", switchRef: true }),
        ),
      ).toEqual({ refName: "feature/next", branch: "feature/next" });
    } finally {
      f.close();
    }
  });

  it("creates tracking branches and reuses the existing local branch for a remote ref", async () => {
    const f = fixture();
    try {
      f.git("remote", "add", "origin", f.directory);
      f.git("update-ref", "refs/remotes/origin/topic", "HEAD");
      expect(await Effect.runPromise(f.act({ kind: "switch", refName: "origin/topic" }))).toEqual({
        refName: "topic",
        branch: "topic",
      });
      f.git("checkout", "main");
      f.git("branch", "-m", "topic", "renamed");
      expect(await Effect.runPromise(f.act({ kind: "switch", refName: "origin/topic" }))).toEqual({
        refName: "renamed",
        branch: "renamed",
      });
    } finally {
      f.close();
    }
  });

  it("refuses stale path refs, option-like refs and checkout collisions without losing work", async () => {
    const f = fixture();
    try {
      f.git("checkout", "-b", "other");
      writeFileSync(join(f.directory, "file"), "other\n");
      f.git("commit", "-am", "other");
      f.git("checkout", "main");
      writeFileSync(join(f.directory, "file"), "mine\n");
      const index = readFileSync(join(f.directory, ".git/index"));
      for (const refName of ["file", "--force", "other", f.git("rev-parse", "HEAD")]) {
        const refused = await Effect.runPromise(Effect.flip(f.act({ kind: "switch", refName })));
        expect(refused).toBeInstanceOf(WorktreeGitRefused);
        expect(readFileSync(join(f.directory, "file"), "utf8")).toBe("mine\n");
        expect(readFileSync(join(f.directory, ".git/index"))).toEqual(index);
        expect(f.git("branch", "--show-current")).toBe("main");
      }
    } finally {
      f.close();
    }
  });

  it("orders complete landings against branch actions and releases after a refusal", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeWorktreeGitGate();
        const id = WorktreeId.make("worktree");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const landing = yield* Effect.forkChild(
          gate(
            id,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        expect((yield* Effect.flip(gate(id, Effect.void))).code).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(landing);
        yield* Effect.exit(gate(id, Effect.fail("expected")));
        yield* gate(id, Effect.void);
      }),
    );
  });
});
