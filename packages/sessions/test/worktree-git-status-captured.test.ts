import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { captureKeys, git, packIdxKeyOf, sha256Hex } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SessionRepository } from "../src/session-repository.ts";
import { readWorktreeGitStatus } from "../src/worktree-git-status.ts";
import { makeCaptureWorld, newWorktreeId, sh, worktreeRowFor } from "./capture-world.ts";

describe("captured working-tree commit selection", () => {
  it("reads retained staging and working trees, including cancelled staging and untracked files", async () => {
    const world = makeCaptureWorld();
    try {
      writeFileSync(join(world.work, "a.txt"), "staged\n");
      sh(world.work, ["add", "a.txt"]);
      const index = sh(world.work, ["write-tree"]);
      writeFileSync(join(world.work, "a.txt"), "one\ntwo\n");
      writeFileSync(join(world.work, "keep.md"), "# changed\n");
      writeFileSync(join(world.work, "new [file]"), "new\n");
      const temporary = join(world.scratch, "snapshot-index");
      await Effect.runPromise(git(["add", "-A"], world.work, { GIT_INDEX_FILE: temporary }));
      const tree = await Effect.runPromise(
        git(["write-tree"], world.work, { GIT_INDEX_FILE: temporary }),
      );
      const name = execFileSync("git", ["pack-objects", "--revs", join(world.scratch, "p")], {
        cwd: world.work,
        input: `${world.baseSha}\n${index}\n${tree}\n`,
        encoding: "utf8",
      }).trim();
      const pack = readFileSync(join(world.scratch, `p-${name}.pack`));
      const id = newWorktreeId();
      const row = worktreeRowFor(world, id, "main");
      world.worktrees.set(id, row);
      const key = captureKeys(id, 1).pack(sha256Hex(pack));
      const built = buildManifest({
        worktreeId: id,
        n: 0,
        parent: null,
        epoch: 1,
        git: {
          packs: [key],
          refs: { "refs/heads/main": world.baseSha },
          head: "refs/heads/main",
          fsck: "verified",
          index_tree: index,
          worktree_tree: tree,
        },
      });
      const status = await Effect.runPromise(
        Effect.gen(function* () {
          yield* uploadObjects(
            new Map([
              [key, pack],
              [packIdxKeyOf(key), readFileSync(join(world.scratch, `p-${name}.idx`))],
              [built.key, built.bytes],
            ]),
          );
          const repo = yield* CaptureStoreRepo;
          yield* repo.init(id);
          const lease = yield* repo.claim(id, "runner");
          yield* repo.register({
            worktreeId: id,
            id: built.id,
            n: 0,
            parent: null,
            epoch: lease.epoch,
            seq: 0n,
            kind: "checkpoint",
            manifestKey: built.key,
            sections: built.manifest.sections,
            gitFsck: "verified",
          });
          return yield* readWorktreeGitStatus(row);
        }).pipe(
          Effect.provide(
            Layer.merge(
              world.layer,
              Layer.mock(SessionRepository, { worktreeMount: () => Effect.succeed(undefined) }),
            ),
          ),
        ),
      );
      expect(status.dirty).toBe(true);
      expect(status.files.map((file) => file.path)).toEqual(["a.txt", "keep.md", "new [file]"]);
      expect(status.files.find((file) => file.path === "new [file]")).toMatchObject({
        insertions: 0,
        deletions: 0,
      });
      expect(status.files.find((file) => file.path === "a.txt")).toMatchObject({
        insertions: 0,
        deletions: 0,
      });
    } finally {
      rmSync(world.scratch, { recursive: true, force: true });
    }
  });
});
