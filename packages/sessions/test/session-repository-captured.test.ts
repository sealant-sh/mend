import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { BlobStore, WORKTREE_TREE_REF, captureIdOf, captureKeys } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaptureChannel } from "../src/capture-channel.ts";
import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WorktreeReads, WorktreeReadsCapturedLive, stampLabel } from "../src/worktree-reads.ts";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  worktreeRowFor,
} from "./capture-world.ts";

/**
 * `SessionRepositoryCapturedLive` (ADR-0002): the same port as the co-located adapter, served
 * from the bucket and the pointer store. An "executor" here is the test writing packs and
 * manifests by ADR-0015's rules and registering them through the pointer store.
 */
describe("SessionRepositoryCapturedLive", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services =
    | SessionRepository
    | WorktreeReads
    | CaptureStoreRepo
    | StoreRefsRepo
    | BlobStore
    | CaptureChannel;
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

  it("createWorktree resolves the base and writes the branch ref; attachWorktree registers capture 0 from a base pack and releases the lease", async () => {
    const worktreeId = newWorktreeId();
    const created = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo.createWorktree(
          world.project.id,
          { directory: worktreeId, branch: `mend/wt/${worktreeId}` },
          null,
          null,
        );
      }),
    );
    expect(created.baseRef).toBe("main");
    expect(created.baseSha).toBe(world.baseSha);
    world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, created.branch));
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        const refs = yield* StoreRefsRepo;
        const captures = yield* CaptureStoreRepo;
        yield* repo.attachWorktree!(world.project.id, worktreeId);
        // Idempotent: a retry after a crash between the row and capture 0 changes nothing.
        yield* repo.attachWorktree!(world.project.id, worktreeId);
        const chain = yield* captures.headOf(worktreeId);
        const lease = yield* captures.leaseOf(worktreeId);
        const branch = yield* refs.get(world.project.id, `refs/heads/${created.branch}`);
        const mount = yield* repo.worktreeMount(world.project.id, worktreeId);
        return { chain, lease, branch, mount };
      }),
    );
    expect(seen.mount).toBeUndefined();
    expect(seen.branch?.sha).toBe(world.baseSha);
    expect(seen.chain?.headN).toBe(0);
    expect(seen.chain?.head?.kind).toBe("checkpoint");
    expect(seen.chain?.head?.epoch).toBe(1);
    expect(seen.lease?.live).toBe(false);
    expect(seen.lease?.epoch).toBe(1);
    // The base pack sits under the project prefix, never an epoch's, and the manifest names it.
    const manifestKey = seen.chain?.head?.manifestKey ?? "";
    const manifest = JSON.parse(fs.readFileSync(path.join(world.blobRoot, manifestKey), "utf8"));
    expect(manifest.sections.git.packs[0]).toMatch(/^projects\/proj-cap\/packs\/[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(world.blobRoot, manifest.sections.git.packs[0]))).toBe(true);
    expect(manifest.checkpoint).toEqual({
      ordinal: 0,
      sha: world.baseSha,
      ref: `refs/mend/checkpoints/${worktreeId}/0`,
    });
    expect(captureIdOf(fs.readFileSync(path.join(world.blobRoot, manifestKey)))).toBe(
      seen.chain?.head?.id,
    );
    // A second worktree on the same branch name is refused like the co-located adapter does.
    const clash = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo
          .createWorktree(
            world.project.id,
            { directory: "other", branch: `mend/wt/${worktreeId}` },
            null,
            null,
          )
          .pipe(Effect.flip);
      }),
    );
    expect(clash._tag).toBe("GitError");
  });

  it(
    "reads come from the head capture's worktree tree, stamped; a checkpoint is derived on the runner when the executor posted none",
    { timeout: 30_000 },
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
      // Before any executor capture, the worktree equals the base.
      const untouched = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          const matches = yield* reads.worktreeMatchesCommit(
            world.project.id,
            worktreeId,
            world.baseSha,
          );
          const files = yield* reads.listWorktreeFiles(world.project.id, worktreeId, 100);
          return { matches, files };
        }),
      );
      expect(untouched.matches.value).toBe(true);
      expect(untouched.files.value.files).toEqual(["a.txt", "keep.md"]);
      expect(stampLabel(untouched.matches.stamp)).toBe("observed at capture 0 · seq 0");

      // The executor claims, edits, and ships capture 1 (an `auto` capture — partial by rule).
      const cap0 = world.memory.chains.get(worktreeId)?.headCapture ?? "";
      const epoch = await run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          return (yield* captures.claim(worktreeId, "executor-1")).epoch;
        }),
      );
      expect(epoch).toBe(2);
      const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
        fs.writeFileSync(path.join(dir, "new.txt"), "untracked but captured\n");
        fs.rmSync(path.join(dir, "keep.md"));
      });
      const basePack = JSON.parse(
        fs.readFileSync(
          path.join(world.blobRoot, world.memory.captures.get(cap0)?.manifestKey ?? ""),
          "utf8",
        ),
      ).sections.git.packs[0] as string;
      const cap1 = buildManifest({
        worktreeId,
        n: 1,
        parent: cap0,
        epoch,
        seq: 41,
        kind: "auto",
        git: {
          packs: [basePack, edited.key],
          refs: { [`refs/heads/${branch}`]: world.baseSha, [WORKTREE_TREE_REF]: edited.tree },
          head: `refs/heads/${branch}`,
          fsck: "verified",
        },
      });
      await run(
        Effect.gen(function* () {
          yield* uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]]));
          const captures = yield* CaptureStoreRepo;
          yield* captures.register({
            worktreeId,
            id: cap1.id,
            n: 1,
            parent: cap0,
            epoch,
            seq: 41n,
            kind: "auto",
            manifestKey: cap1.key,
            sections: cap1.manifest.sections,
            gitFsck: "verified",
          });
        }),
      );
      const observed = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          const diff = yield* reads.diffWorktree(world.project.id, worktreeId, world.baseSha);
          const files = yield* reads.changedFiles(world.project.id, worktreeId, world.baseSha);
          const matches = yield* reads.worktreeMatchesCommit(
            world.project.id,
            worktreeId,
            world.baseSha,
          );
          const listing = yield* reads.listWorktreeFiles(world.project.id, worktreeId, 100);
          return { diff, files, matches, listing };
        }),
      );
      expect(observed.diff.value).toContain("+three");
      expect(observed.diff.value).toContain("+untracked but captured");
      expect(observed.diff.value).toContain("-# keep");
      expect(observed.files.value.map((file) => file.path).toSorted()).toEqual([
        "a.txt",
        "keep.md",
        "new.txt",
      ]);
      expect(observed.matches.value).toBe(false);
      expect(observed.listing.value.files).toEqual(["a.txt", "new.txt"]);
      expect(observed.diff.stamp).toMatchObject({
        source: "capture",
        captureN: 1,
        captureId: cap1.id,
        seq: "41",
        kind: "auto",
        partial: true,
      });
      expect(stampLabel(observed.diff.stamp)).toBe("observed at capture 1 · seq 41 · partial");

      // Mend asks for checkpoint 1: nothing arrives from the executor within the wait, so the
      // runner derives the commit from the captured worktree tree and records it durably.
      const derived = await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          const snapshot = yield* repo.checkpoint({
            projectId: world.project.id,
            scope: worktreeId,
            worktreeName: worktreeId,
            index: 1,
            parent: Sha.make(world.baseSha),
          });
          const refs = yield* StoreRefsRepo;
          const ref = yield* refs.get(world.project.id, snapshot.ref);
          const reads = yield* WorktreeReads;
          // The derived commit is reachable by later reads through the recorded pack + ref.
          const range = yield* reads.diffRange(
            world.project.id,
            worktreeId,
            world.baseSha,
            snapshot.ref,
          );
          return { snapshot, ref, range };
        }),
      );
      expect(derived.snapshot.ref).toBe(`refs/mend/checkpoints/${worktreeId}/1`);
      expect(derived.snapshot.captureId).toBe(cap1.id);
      expect(derived.ref?.sha).toBe(derived.snapshot.sha);
      expect(derived.range.value).toContain("+three");
      const derivedPacks = [...world.memory.packs.values()].filter(
        (pack) => pack.worktreeId === worktreeId && pack.key.startsWith("projects/"),
      );
      expect(derivedPacks).toHaveLength(1);

      // When the executor's own `checkpoint` capture carries the ordinal, it wins outright.
      const checkpointRef = `refs/mend/checkpoints/${worktreeId}/2`;
      const cap2 = buildManifest({
        worktreeId,
        n: 2,
        parent: cap1.id,
        epoch,
        seq: 60,
        kind: "checkpoint",
        git: cap1.manifest.sections.git,
        checkpoint: { ordinal: 2, sha: derived.snapshot.sha, ref: checkpointRef },
      });
      const fromExecutor = await run(
        Effect.gen(function* () {
          yield* uploadObjects(new Map([[cap2.key, cap2.bytes]]));
          const captures = yield* CaptureStoreRepo;
          yield* captures.register({
            worktreeId,
            id: cap2.id,
            n: 2,
            parent: cap1.id,
            epoch,
            seq: 60n,
            kind: "checkpoint",
            manifestKey: cap2.key,
            sections: cap2.manifest.sections,
            gitFsck: "verified",
          });
          const repo = yield* SessionRepository;
          return yield* repo.checkpoint({
            projectId: world.project.id,
            scope: worktreeId,
            worktreeName: worktreeId,
            index: 2,
            parent: derived.snapshot.sha,
          });
        }),
      );
      expect(fromExecutor).toEqual({
        ref: checkpointRef,
        sha: derived.snapshot.sha,
        captureId: cap2.id,
      });
      // And a checkpoint that lands while Mend waits is taken from the wire.
      const cap3 = buildManifest({
        worktreeId,
        n: 3,
        parent: cap2.id,
        epoch,
        seq: 70,
        kind: "checkpoint",
        git: cap1.manifest.sections.git,
        checkpoint: {
          ordinal: 3,
          sha: derived.snapshot.sha,
          ref: `refs/mend/checkpoints/${worktreeId}/3`,
        },
      });
      const awaited = await run(
        Effect.gen(function* () {
          yield* uploadObjects(new Map([[cap3.key, cap3.bytes]]));
          const repo = yield* SessionRepository;
          const captures = yield* CaptureStoreRepo;
          const channel = yield* CaptureChannel;
          const waiting = yield* Effect.forkChild(
            repo.checkpoint({
              projectId: world.project.id,
              scope: worktreeId,
              worktreeName: worktreeId,
              index: 3,
              parent: derived.snapshot.sha,
            }),
          );
          yield* Effect.sleep("50 millis");
          yield* captures.register({
            worktreeId,
            id: cap3.id,
            n: 3,
            parent: cap2.id,
            epoch,
            seq: 70n,
            kind: "checkpoint",
            manifestKey: cap3.key,
            sections: cap3.manifest.sections,
            gitFsck: "verified",
          });
          const row = yield* captures.captureById(cap3.id);
          if (row !== null) channel.publish(row);
          return yield* Fiber.join(waiting);
        }),
      );
      expect(awaited.captureId).toBe(cap3.id);
      expect(awaited.ref).toBe(`refs/mend/checkpoints/${worktreeId}/3`);
      // Removal releases the lease; the chain stays for retention to thin.
      const released = await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.removeWorktreeForce(world.project.id, worktreeId);
          const captures = yield* CaptureStoreRepo;
          return yield* captures.leaseOf(worktreeId);
        }),
      );
      expect(released?.live).toBe(false);
      expect(world.memory.chains.get(worktreeId)?.headN).toBe(3);
    },
  );
});
