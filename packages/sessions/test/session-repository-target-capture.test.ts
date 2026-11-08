import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import { WORKTREE_TREE_REF, INDEX_TREE_REF, packIdxKeyOf, sha256Hex, git } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { makeCaptureWorld, newWorktreeId, sh, worktreeRowFor } from "./capture-world.ts";

// After an agent commits in a captured workspace, its branch's objects are in the bucket,
// not the adopted repository. A new named worktree must start at that exact branch head.
it.each(["current", "missing", "stale", "failed"])(
  "resolves the captured branch with %s evidence and preserves its source",
  async (retained) => {
    const world = makeCaptureWorld();
    try {
      const sourceId = newWorktreeId();
      const branch = "feature/source";
      sh(world.work, ["checkout", "-qb", branch]);
      fs.writeFileSync(path.join(world.work, "agent.txt"), "committed by the agent\n");
      sh(world.work, ["add", "-A"]);
      sh(world.work, ["commit", "-qm", "agent commit"]);
      const head = Sha.make(sh(world.work, ["rev-parse", "HEAD"]));
      const tree = sh(world.work, ["rev-parse", "HEAD^{tree}"]);
      fs.writeFileSync(path.join(world.work, "keep.md"), "uncommitted source edit\n");
      const sourceStatus = sh(world.work, ["status", "--porcelain=v1"]);
      const sourceIndex = fs.readFileSync(path.join(world.work, ".git", "index"));
      const prefix = path.join(world.scratch, "closure");
      const packId = sh(world.work, ["pack-objects", "--revs", prefix], `${head}\n`);
      const pack = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.pack`));
      const idx = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.idx`));
      const key = `projects/${world.project.id}/packs/${sha256Hex(pack)}`;
      world.worktrees.set(sourceId, worktreeRowFor(world, sourceId, branch));
      const layer = Layer.mergeAll(
        world.layer,
        SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const captures = yield* CaptureStoreRepo;
            const refs = yield* StoreRefsRepo;
            const repo = yield* SessionRepository;
            yield* captures.init(sourceId);
            const lease = yield* captures.claim(sourceId, "source");
            const built = buildManifest({
              worktreeId: sourceId,
              n: 0,
              parent: null,
              epoch: lease.epoch,
              seq: 1,
              kind: "checkpoint",
              git: {
                packs: [key],
                head: `refs/heads/${branch}`,
                refs: {
                  [`refs/heads/${branch}`]: head,
                  [WORKTREE_TREE_REF]: tree,
                  [INDEX_TREE_REF]: tree,
                },
                fsck: "verified",
              },
            });
            yield* uploadObjects(
              new Map([
                [key, pack],
                [packIdxKeyOf(key), idx],
                [built.key, built.bytes],
              ]),
            );
            yield* captures.register({
              worktreeId: sourceId,
              id: built.id,
              n: 0,
              parent: null,
              epoch: lease.epoch,
              seq: 1n,
              kind: "checkpoint",
              manifestKey: built.key,
              sections: built.manifest.sections,
              gitFsck: retained === "failed" ? "failed" : "verified",
            });
            if (retained !== "missing")
              yield* refs.set(
                world.project.id,
                `refs/heads/${branch}`,
                retained === "stale" ? Sha.make(world.baseSha) : head,
                null,
              );
            expect(
              (yield* Effect.result(git(["cat-file", "-e", head], world.storePath)))._tag,
            ).toBe("Failure");
            const childId = newWorktreeId();
            const creation = repo.createWorktree(
              world.project.id,
              { id: childId, directory: childId, branch: `mend/wt/${childId}` },
              {
                kind: "base",
                base: null,
                targetBranch: { refName: branch, newRefName: "feature/child" },
              },
              null,
            );
            if (retained === "failed") {
              expect((yield* Effect.result(creation))._tag).toBe("Failure");
              expect(yield* refs.get(world.project.id, "refs/heads/feature/child")).toBeNull();
              expect(yield* captures.headOf(childId)).toBeNull();
              return;
            }
            const created = yield* creation;
            expect(created.baseSha).toBe(head);
            world.worktrees.set(
              childId,
              new Worktree({
                ...worktreeRowFor(world, childId, created.branch),
                baseSha: created.baseSha,
                baseRef: created.baseRef,
              }),
            );
            yield* repo.attachWorktree!(world.project.id, childId);
            const child = yield* captures.headOf(childId);
            expect(child?.head?.n).toBe(0);
            expect(yield* git(["show", `${head}:agent.txt`], world.storePath)).toBe(
              "committed by the agent",
            );
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(sh(world.work, ["rev-parse", "HEAD"])).toBe(head);
      expect(sh(world.work, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
      expect(sh(world.work, ["status", "--porcelain=v1"])).toBe(sourceStatus);
      expect(fs.readFileSync(path.join(world.work, ".git", "index"))).toEqual(sourceIndex);
      expect(fs.readFileSync(path.join(world.work, "keep.md"), "utf8")).toBe(
        "uncommitted source edit\n",
      );
    } finally {
      fs.rmSync(world.scratch, { recursive: true, force: true });
    }
  },
);
