import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, StoreRefsRepo, WorktreesRepo } from "@mend/db";
import {
  BlobStore,
  decodeManifest,
  INDEX_TREE_REF,
  skippedFreshen,
  Store,
  WORKTREE_TREE_REF,
} from "@mend/store";
import { buildHandoffBundle, sh } from "@mend/store/testing/handoff";
import { Effect, Exit, Layer, Result, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaptureChannel } from "../src/capture-channel.ts";
import { CaptureGitVerifier, CaptureGitVerifierLive } from "../src/capture-verify.ts";
import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";
import { makeCaptureWorld, newWorktreeId } from "./capture-world.ts";

const noFreshen = {
  freshen: Effect.succeed(skippedFreshen("no credential in this test")),
  fileBytes: 0,
};

describe("SessionRepositoryCapturedLive with a handoff", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    CaptureGitVerifierLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services =
    | SessionRepository
    | WorktreeReads
    | CaptureGitVerifier
    | CaptureStoreRepo
    | StoreRefsRepo
    | WorktreesRepo
    | BlobStore
    | Store
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

  const makeCheckout = (name: string) => {
    const checkout = path.join(world.scratch, name);
    sh(world.scratch, ["clone", "-q", world.work, checkout]);
    sh(checkout, ["checkout", "-q", "-b", "fix/login"]);
    fs.writeFileSync(path.join(checkout, "login.ts"), "export const login = () => true;\n");
    sh(checkout, ["add", "-A"]);
    sh(checkout, ["commit", "-q", "-m", "login"]);
    fs.writeFileSync(path.join(checkout, "staged.ts"), "staged\n");
    sh(checkout, ["add", "staged.ts"]);
    fs.appendFileSync(path.join(checkout, "a.txt"), "three\n");
    fs.writeFileSync(path.join(checkout, "notes.txt"), "untracked\n");
    return checkout;
  };

  it("lays capture 0 down from the snapshot: branch at H, ordinal 0 at M, review equal to the checkout's diff", async () => {
    const checkout = makeCheckout("checkout-one");
    const bundle = buildHandoffBundle(checkout, { machine: "dana-mbp" });
    const worktreeId = newWorktreeId();
    const branch = "mend/fix-login";
    const seen = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const repo = yield* SessionRepository;
        const rows = yield* WorktreesRepo;
        const refs = yield* StoreRefsRepo;
        const captures = yield* CaptureStoreRepo;
        const blobs = yield* BlobStore;
        const admitted = yield* store.admitHandoff(
          world.storePath,
          "main",
          bundle.bytes,
          noFreshen,
        );
        const created = yield* repo.createWorktree(
          world.project.id,
          { id: worktreeId, directory: worktreeId, branch },
          { kind: "handoff", admitted, ownerUserId: "user-dana" },
          null,
        );
        const row = yield* rows.create({
          id: worktreeId,
          projectId: world.project.id,
          name: "fix-login",
          directory: worktreeId,
          branch: created.branch,
          baseSha: created.baseSha,
          baseRef: created.baseRef,
          handoff: created.handoff,
        });
        yield* repo.attachWorktree!(world.project.id, worktreeId);
        const chain = yield* captures.headOf(worktreeId);
        const manifestKey = chain?.head?.manifestKey ?? "";
        const manifest = yield* decodeManifest(manifestKey, yield* blobs.get(manifestKey));
        const branchRef = yield* refs.get(world.project.id, `refs/heads/${branch}`);
        const baseRef = yield* refs.get(world.project.id, `refs/mend/base/${worktreeId}`);
        const verified = yield* (yield* CaptureGitVerifier).verify(world.project.id, manifest);
        const changed = yield* (yield* WorktreeReads).changedFiles(
          world.project.id,
          worktreeId,
          created.baseSha,
        );
        // The engine's creation tail and the first session-start, as capture 0 alone answers them.
        const ordinal0 = yield* repo.checkpoint({
          projectId: world.project.id,
          scope: worktreeId,
          worktreeName: worktreeId,
          index: 0,
          parent: null,
        });
        const ordinal1 = yield* repo.checkpoint({
          projectId: world.project.id,
          scope: worktreeId,
          worktreeName: worktreeId,
          index: 1,
          parent: ordinal0.sha,
        });
        const checkpointRef0 = yield* refs.get(
          world.project.id,
          `refs/mend/checkpoints/${worktreeId}/0`,
        );
        const reviewed = yield* (yield* WorktreeReads).diffRange(
          world.project.id,
          worktreeId,
          ordinal0.sha,
          ordinal1.sha,
        );
        return {
          created,
          row,
          manifest,
          branchRef,
          baseRef,
          verified,
          changed,
          ordinal0,
          ordinal1,
          checkpointRef0,
          reviewed,
        };
      }),
    );
    expect(seen.created).toMatchObject({
      branch,
      baseSha: bundle.mergeBase,
      baseRef: "main",
      handoff: {
        machine: "dana-mbp",
        localBranch: "fix/login",
        head: bundle.head,
        index: bundle.index,
        checkpoint: bundle.checkpoint,
        mergeBase: bundle.mergeBase,
        worktreeTree: bundle.worktreeTree,
        indexTree: bundle.indexTree,
        ownerUserId: "user-dana",
      },
    });
    expect(bundle.mergeBase).toBe(world.baseSha);
    // Under the worktree's own capture prefix, so retention owns it with the chain.
    expect(seen.row.handoff?.deltaPack).toMatch(
      new RegExp(`^captures/${worktreeId}/0/packs/[0-9a-f]{64}$`),
    );
    expect(seen.branchRef?.sha).toBe(bundle.head);
    expect(seen.baseRef?.sha).toBe(bundle.mergeBase);
    expect(seen.manifest.sections.git.refs).toEqual({
      [`refs/heads/${branch}`]: bundle.head,
      [WORKTREE_TREE_REF]: bundle.worktreeTree,
      [INDEX_TREE_REF]: bundle.indexTree,
    });
    expect(seen.manifest.sections.git.packs).toHaveLength(2);
    expect(seen.manifest.sections.git.packs[1]).toBe(seen.row.handoff?.deltaPack);
    expect(seen.manifest.sections.git.fsck).toBe("verified");
    // Ordinal 0 is the base M, what Review anchors at; the first session-start is W itself.
    expect(seen.manifest.checkpoint).toEqual({
      ordinal: 0,
      sha: bundle.mergeBase,
      ref: `refs/mend/checkpoints/${worktreeId}/0`,
    });
    expect(seen.checkpointRef0?.sha).toBe(bundle.mergeBase);
    expect(seen.ordinal0.sha).toBe(bundle.mergeBase);
    expect(seen.ordinal1.sha).toBe(bundle.checkpoint);
    expect(seen.verified).toMatchObject({ outcome: "verified" });
    const expected = sh(checkout, ["diff", "--name-only", bundle.mergeBase, bundle.checkpoint])
      .split("\n")
      .toSorted();
    expect(seen.changed.value.map((file) => file.path).toSorted()).toEqual(expected);
    const reviewedPaths = [...seen.reviewed.value.matchAll(/^\+\+\+ b\/(.+)$/gm)]
      .map((match) => match[1])
      .toSorted();
    expect(reviewedPaths).toEqual(expected);
    expect(expected).toEqual(["a.txt", "login.ts", "notes.txt", "staged.ts"]);
  });

  it("takes the same admitted handoff again after a crash between the branch ref and the row, and refuses another handoff on the taken name", async () => {
    const checkout = makeCheckout("checkout-two");
    const bundle = buildHandoffBundle(checkout, { cutAt: "2026-10-18T08:00:00.000Z" });
    sh(checkout, ["commit", "-q", "-am", "more"]);
    const other = buildHandoffBundle(checkout, { cutAt: "2026-10-18T08:00:01.000Z" });
    expect(other.head).not.toBe(bundle.head);
    const worktreeId = newWorktreeId();
    const branch = `mend/${worktreeId}`;
    const outcome = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const repo = yield* SessionRepository;
        const admitted = yield* store.admitHandoff(
          world.storePath,
          "main",
          bundle.bytes,
          noFreshen,
        );
        const first = yield* repo.createWorktree(
          world.project.id,
          { id: worktreeId, directory: worktreeId, branch },
          { kind: "handoff", admitted, ownerUserId: "user-dana" },
          null,
        );
        const again = yield* repo.createWorktree(
          world.project.id,
          { id: worktreeId, directory: worktreeId, branch },
          { kind: "handoff", admitted, ownerUserId: "user-dana" },
          null,
        );
        const otherAdmitted = yield* store.admitHandoff(
          world.storePath,
          "main",
          other.bytes,
          noFreshen,
        );
        const taken = yield* repo
          .createWorktree(
            world.project.id,
            { id: worktreeId, directory: worktreeId, branch },
            { kind: "handoff", admitted: otherAdmitted, ownerUserId: "user-dana" },
            null,
          )
          .pipe(Effect.result);
        return { first, again, taken };
      }),
    );
    expect(outcome.again).toEqual(outcome.first);
    expect(Result.isFailure(outcome.taken)).toBe(true);
    if (Result.isFailure(outcome.taken) && outcome.taken.failure._tag === "GitError") {
      expect(outcome.taken.failure.stderr).toMatch(/already exists/);
    } else {
      expect.unreachable("the taken name was not refused with a GitError");
    }
  });
});
