import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { Project } from "@mend/domain/workbench";
import { WorktreeReads, WorktreeReadsCapturedLive, WORKTREE_STAMP } from "@mend/sessions";
import { makeCaptureWorld, newWorktreeId, sh, worktreeRowFor } from "@mend/sessions/testing";
import { INDEX_TREE_REF, packIdxKeyOf, sha256Hex, Store, WORKTREE_TREE_REF } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";

it.each(["feature/agent-source", "mend/wt/agent-source"])(
  "lists captured local branch %s at the project root without changing its checkout",
  async (branch) => {
    const world = makeCaptureWorld();
    const worktreeId = newWorktreeId();
    sh(world.work, ["checkout", "-qb", branch]);
    fs.writeFileSync(path.join(world.work, "agent.txt"), "agent commit\n");
    sh(world.work, ["add", "-A"]);
    sh(world.work, ["commit", "-qm", "Agent change"]);
    const head = sh(world.work, ["rev-parse", "HEAD"]);
    const tree = sh(world.work, ["rev-parse", "HEAD^{tree}"]);
    const committedAt = sh(world.work, ["show", "-s", "--format=%cI", "HEAD"]);
    const prefix = path.join(world.scratch, "closure");
    const packId = sh(world.work, ["pack-objects", "--revs", prefix], `${head}\n`);
    const pack = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.pack`));
    const idx = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.idx`));
    const key = `projects/${world.project.id}/packs/${sha256Hex(pack)}`;
    fs.writeFileSync(path.join(world.work, "keep.md"), "keep this dirty\n");
    const status = sh(world.work, ["status", "--porcelain=v1"]);
    const index = fs.readFileSync(path.join(world.work, ".git/index"));
    const source = worktreeRowFor(world, worktreeId, branch);
    world.worktrees.set(worktreeId, source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const captures = yield* CaptureStoreRepo;
        yield* captures.init(worktreeId);
        const lease = yield* captures.claim(worktreeId, "source");
        const built = buildManifest({
          worktreeId,
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
              [`refs/remotes/origin/${branch}`]: world.baseSha,
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
          worktreeId,
          id: built.id,
          n: 0,
          parent: null,
          epoch: lease.epoch,
          seq: 1n,
          kind: "checkpoint",
          manifestKey: built.key,
          sections: built.manifest.sections,
          gitFsck: "verified",
        });
      }).pipe(Effect.provide(world.layer)),
    );
    const captured = WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer));
    const reads = {
      readDefaultBranchFile: () => Effect.succeed({ value: null, stamp: WORKTREE_STAMP }),
      listBranches: (projectId: typeof world.project.id, id: typeof worktreeId) =>
        Effect.gen(function* () {
          return yield* (yield* WorktreeReads).listBranches(projectId, id);
        }).pipe(Effect.provide(captured)),
    };
    const api = await createTenancyApi(
      {},
      {
        implement: {
          store: {
            listBranches: (storePath) =>
              Effect.gen(function* () {
                return yield* (yield* Store).listBranches(storePath);
              }).pipe(Effect.provide(world.layer)),
          },
          reads,
        },
      },
    );
    try {
      const template = [...api.world.projects.values()][0];
      if (template === undefined) throw new Error("Missing project fixture");
      api.world.addProject(
        new Project({
          ...template,
          id: world.project.id,
          storePath: world.storePath,
          defaultBranch: "main",
          visibility: "private",
          createdByUserId: "alice",
        }),
      );
      api.world.addWorktree(source);
      expect(sh(world.storePath, ["branch", "--list", branch])).toBe("");
      const result = await api.request(
        "alice",
        "GET",
        `/api/projects/${world.project.id}/branches`,
      );
      expect(result.status).toBe(200);
      const branches: unknown = await result.json();
      expect(branches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "main", isDefault: true }),
          { name: branch, sha: head, committedAt, isDefault: false },
        ]),
      );
      const member = await api.request("bob", "GET", `/api/projects/${world.project.id}/branches`);
      expect(member.status).toBe(404);
      expect(sh(world.work, ["rev-parse", "HEAD"])).toBe(head);
      expect(sh(world.work, ["status", "--porcelain=v1"])).toBe(status);
      expect(fs.readFileSync(path.join(world.work, ".git/index"))).toEqual(index);
    } finally {
      await api.dispose();
      fs.rmSync(world.scratch, { recursive: true, force: true });
    }
  },
);
