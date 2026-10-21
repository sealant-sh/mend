import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, WorktreesRepo } from "@mend/db";
import {
  CaptureGitVerifier,
  CaptureGitVerifierLive,
  CaptureRuntimeLive,
  SessionRepository,
  SessionRepositoryCapturedLive,
  WorktreeReads,
  WorktreeReadsCapturedLive,
} from "@mend/sessions";
import { makeCaptureWorld, newWorktreeId } from "@mend/sessions/testing";
import { BlobStore, decodeManifest, skippedFreshen, Store } from "@mend/store";
import { buildHandoffBundle, sh } from "@mend/store/testing";
import { Effect, Exit, Layer, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CaptureRetention,
  CaptureRetentionLive,
  RETENTION_GRACE_MS,
} from "../src/capture-retention.ts";

/**
 * A handoff whose worktree row landed and whose capture 0 did not (a crash, a failed attach, a
 * base-pack upload past the grace): retention runs, and the next attach still restores the
 * change. Real admission, real session repository, real pass, one directory bucket.
 */
describe("CaptureRetention and a handoff awaiting capture 0", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    CaptureGitVerifierLive.pipe(Layer.provide(world.layer)),
    CaptureRetentionLive.pipe(
      Layer.provide(CaptureRuntimeLive.pipe(Layer.provide(world.layer))),
      Layer.provide(world.layer),
    ),
    world.layer,
  );
  type Services =
    | SessionRepository
    | WorktreeReads
    | CaptureGitVerifier
    | CaptureRetention
    | CaptureStoreRepo
    | WorktreesRepo
    | BlobStore
    | Store;
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

  it.each(["the worktree row", "the chain's first rows"] as const)(
    "keeps the delta pack past the grace when the crash came after %s, and the next attach restores the change",
    async (crashAfter) => {
      const checkout = path.join(world.scratch, `checkout-${crashAfter.replaceAll(" ", "-")}`);
      sh(world.scratch, ["clone", "-q", world.work, checkout]);
      sh(checkout, ["checkout", "-q", "-b", "fix/login"]);
      fs.writeFileSync(path.join(checkout, "login.ts"), `export const login = "${crashAfter}";\n`);
      sh(checkout, ["add", "-A"]);
      sh(checkout, ["commit", "-q", "-m", "login"]);
      fs.writeFileSync(path.join(checkout, "notes.txt"), "untracked\n");
      const bundle = buildHandoffBundle(checkout);
      const worktreeId = newWorktreeId();
      const seen = await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          const admitted = yield* (yield* Store).admitHandoff(
            world.storePath,
            "main",
            bundle.bytes,
            {
              freshen: Effect.succeed(skippedFreshen("no credential in this test")),
              fileBytes: 0,
            },
          );
          const created = yield* repo.createWorktree(
            world.project.id,
            { id: worktreeId, directory: worktreeId, branch: `mend/${worktreeId}` },
            { kind: "handoff", admitted, ownerUserId: "user-dana", previous: null },
            null,
          );
          yield* (yield* WorktreesRepo).create({
            id: worktreeId,
            projectId: world.project.id,
            name: worktreeId,
            directory: worktreeId,
            branch: created.branch,
            baseSha: created.baseSha,
            baseRef: created.baseRef,
            handoff: created.handoff,
          });
          if (crashAfter === "the chain's first rows")
            yield* (yield* CaptureStoreRepo).init(worktreeId);

          yield* (yield* CaptureRetention).run(Date.now() + RETENTION_GRACE_MS + 60_000);

          yield* repo.attachWorktree!(world.project.id, worktreeId);
          const head = yield* (yield* CaptureStoreRepo).headOf(worktreeId);
          const manifestKey = head?.head?.manifestKey ?? "";
          const manifest = yield* decodeManifest(
            manifestKey,
            yield* (yield* BlobStore).get(manifestKey),
          );
          const verified = yield* (yield* CaptureGitVerifier).verify(world.project.id, manifest);
          const changed = yield* (yield* WorktreeReads).changedFiles(
            world.project.id,
            worktreeId,
            created.baseSha,
          );
          return { deltaPack: created.handoff?.deltaPack, manifest, verified, changed };
        }),
      );
      expect(seen.manifest.sections.git.packs).toContain(seen.deltaPack);
      expect(seen.verified).toMatchObject({ outcome: "verified" });
      expect(seen.changed.value.map((file) => file.path).toSorted()).toEqual([
        "login.ts",
        "notes.txt",
      ]);
    },
  );
});
