import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import {
  type BlobStore,
  INDEX_TREE_REF,
  WORKTREE_TREE_REF,
  captureKeys,
  isCaptureObjectKey,
  packIdxKeyOf,
  sha256Hex,
} from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Exit, Layer, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaptureChannel, type SessionCaptureApi } from "../src/capture-channel.ts";
import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  sh,
  worktreeRowFor,
} from "./capture-world.ts";

/**
 * Mend's verification of a capture's git section (ADR-0002 "Replacement and pickup", decision
 * 16). The failure observed on the cluster, reproduced by hand: an executor's pack holds the
 * root tree and the new blob but not the new subtree the root names, and the manifest still
 * claims `fsck: "verified"`. Register must record `failed`, the plan must restore the newest
 * capture that verifies under the unchanged head, and reads must come from it, stamped.
 */

/**
 * A commit that adds `sub/x.txt`, packed WITHOUT the `sub` tree: `pack-objects` over an
 * explicit object list (commit, root tree, blob) instead of `--revs`. `index-pack --verify`
 * passes — the pack is internally sound — and only a connectivity walk finds the hole.
 */
const packWithoutSubtree = (work: string, worktreeId: string, epoch: number, baseSha: string) => {
  sh(work, ["checkout", "-q", "-B", "scratch", baseSha]);
  fs.mkdirSync(path.join(work, "sub"), { recursive: true });
  fs.writeFileSync(path.join(work, "sub", "x.txt"), "inside a subtree\n");
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", "subtree edit"]);
  const commit = sh(work, ["rev-parse", "HEAD"]);
  const tree = sh(work, ["rev-parse", "HEAD^{tree}"]);
  const blob = sh(work, ["rev-parse", "HEAD:sub/x.txt"]);
  const subtree = sh(work, ["rev-parse", "HEAD:sub"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-partial-pack-"));
  const name = sh(
    work,
    ["pack-objects", "-q", path.join(out, "p")],
    `${commit}\n${tree}\n${blob}\n`,
  );
  const pack = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
  const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
  fs.rmSync(out, { recursive: true, force: true });
  const key = captureKeys(worktreeId, epoch).pack(sha256Hex(pack));
  return {
    tree,
    subtree,
    key,
    objects: new Map<string, Uint8Array>([
      [key, pack],
      [packIdxKeyOf(key), idx],
    ]),
  };
};

const packsOf = (sections: unknown): ReadonlyArray<string> =>
  (sections as { git: { packs: ReadonlyArray<string> } }).git.packs;
const refsOf = (sections: unknown): Readonly<Record<string, string>> =>
  (sections as { git: { refs: Readonly<Record<string, string>> } }).git.refs;

describe("capture git verification", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services = SessionRepository | WorktreeReads | CaptureStoreRepo | CaptureChannel | BlobStore;
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));
  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  it(
    "records `failed` for a pack that omits a tree it names, plans and reads the newest verified capture under the unchanged head, and verifies an `auto` head at the plan that would restore it",
    { timeout: 60_000 },
    async () => {
      const worktreeId = newWorktreeId();
      const branch = `mend/wt/${worktreeId}`;
      world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.createWorktree(
            world.project.id,
            { directory: worktreeId, branch },
            null,
            null,
          );
          yield* repo.attachWorktree!(world.project.id, worktreeId);
        }),
      );
      const cap0Id = world.memory.chains.get(worktreeId)?.headCapture ?? "";
      const cap0 = world.memory.captures.get(cap0Id);
      if (cap0 === undefined) throw new Error("capture 0 did not register");
      expect(cap0.gitFsck).toBe("verified");
      const basePack = packsOf(cap0.sections)[0] ?? "";
      const baseTree = refsOf(cap0.sections)[WORKTREE_TREE_REF] ?? "";
      // The executor claims the worktree; the routes are its own, scoped to this worktree.
      const { epoch, api } = await run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          const claimed = yield* captures.claim(worktreeId, "executor-1", 300);
          const channel = yield* CaptureChannel;
          const routes: SessionCaptureApi = channel.apiFor({
            worktreeId,
            projectId: world.project.id,
            executorId: "executor-1",
            footprintBytes: 0,
          });
          return { epoch: claimed.epoch, api: routes };
        }),
      );
      const gitSection = (packs: ReadonlyArray<string>, tree: string) => ({
        packs,
        refs: {
          [`refs/heads/${branch}`]: world.baseSha,
          [WORKTREE_TREE_REF]: tree,
          [INDEX_TREE_REF]: tree,
        },
        head: `refs/heads/${branch}`,
        // The executor's claim, which Mend records nothing from.
        fsck: "verified" as const,
      });
      const register = (built: ReturnType<typeof buildManifest>) =>
        api.register({
          worktree_id: worktreeId,
          epoch,
          n: built.manifest.n,
          parent: built.manifest.parent,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        });

      // 1. A `turn` capture whose pack lacks the subtree its root names: accepted, marked.
      const partial = packWithoutSubtree(world.work, worktreeId, epoch, world.baseSha);
      const cap1 = buildManifest({
        worktreeId,
        n: 1,
        parent: cap0Id,
        epoch,
        seq: 10,
        kind: "turn",
        git: gitSection([basePack, partial.key], partial.tree),
      });
      await run(uploadObjects(new Map([...partial.objects, [cap1.key, cap1.bytes]])));
      const landed = await run(register(cap1));
      expect(landed.head_n).toBe(1);
      expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("failed");
      expect(world.memory.chains.get(worktreeId)?.headCapture).toBe(cap1.id);

      // The plan keeps the head's identity (the next register parents on it) and restores
      // capture 0's git section — the newest that verifies — under it. The broken pack is not
      // presigned; every URL names a capture object.
      const plan1 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan1.head?.n).toBe(1);
      expect(plan1.head?.capture_id).toBe(cap1.id);
      expect(plan1.head?.manifest.sections.git.packs).toEqual([basePack]);
      expect(plan1.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(baseTree);
      expect(Object.keys(plan1.get_urls)).not.toContain(partial.key);
      expect(Object.keys(plan1.get_urls).every(isCaptureObjectKey)).toBe(true);

      // Reads route around it too: capture 0's tree, stamped as capture 0.
      const read1 = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          return yield* reads.worktreeMatchesCommit(world.project.id, worktreeId, world.baseSha);
        }),
      );
      expect(read1.value).toBe(true);
      expect(read1.stamp.captureN).toBe(0);

      // 2. A complete pack on top verifies, and the plan and the reads are its own again.
      const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
      });
      const cap2 = buildManifest({
        worktreeId,
        n: 2,
        parent: cap1.id,
        epoch,
        seq: 20,
        kind: "turn",
        git: gitSection([basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([...edited.objects, [cap2.key, cap2.bytes]])));
      expect((await run(register(cap2))).head_n).toBe(2);
      expect(world.memory.captures.get(cap2.id)?.gitFsck).toBe("verified");
      const plan2 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan2.head?.n).toBe(2);
      expect(plan2.head?.manifest.sections.git.packs).toEqual([basePack, edited.key]);
      expect(plan2.get_urls[edited.key]).toMatch(/^file:\/\//);
      const read2 = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          return yield* reads.diffWorktree(world.project.id, worktreeId, world.baseSha);
        }),
      );
      expect(read2.value).toContain("+three");
      expect(read2.stamp.captureN).toBe(2);

      // 3. An `auto` capture lands `unverified` (never the executor's claim); the plan that
      //    would restore it verifies it then, once, and records what it saw.
      const cap3 = buildManifest({
        worktreeId,
        n: 3,
        parent: cap2.id,
        epoch,
        seq: 30,
        kind: "auto",
        git: gitSection([basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([[cap3.key, cap3.bytes]])));
      expect((await run(register(cap3))).head_n).toBe(3);
      expect(world.memory.captures.get(cap3.id)?.gitFsck).toBe("unverified");
      const plan3 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan3.head?.n).toBe(3);
      expect(plan3.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(edited.tree);
      expect(world.memory.captures.get(cap3.id)?.gitFsck).toBe("verified");
    },
  );
});
