import { CaptureStoreRepo, CheckpointsRepo, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { BlobStore, BlobStoreError, GitOpsRunner } from "@mend/store";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { COMMIT_NOT_KEPT } from "../src/git-words.ts";
import { LandingGitCapturedLive } from "../src/landing-git-captured.ts";
import { LandingGit } from "../src/landing.ts";
import { checkpointOf, makeWorld } from "./world.ts";

// The runner cache is ready; only the store's keeping of the commit is under test.
vi.mock("@mend/sessions", async (original) => {
  const actual = await original<typeof import("@mend/sessions")>();
  return {
    ...actual,
    ensureCaptureCache: () =>
      Effect.succeed({
        cache: {
          projectId: "p-api",
          path: "/tmp/landing-cache",
          refs: {},
          head: "refs/heads/mend/fix-login",
        },
      }),
  };
});

it("a landing commit the store could not keep is recorded in words, its blob error in the log (review of mend#675, F2)", async () => {
  const world = makeWorld();
  const head = Sha.make("a".repeat(40));
  const layer = LandingGitCapturedLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SessionEngine, { launchUnderWay: () => false }),
        Layer.mock(CaptureStoreRepo, {}),
        Layer.mock(BlobStore, {
          identity: "test",
          put: () =>
            Effect.fail(
              new BlobStoreError({
                operation: "put",
                key: "projects/p-api/packs/landing",
                cause: new Error("disk full"),
              }),
            ),
        }),
        Layer.mock(GitOpsRunner, {
          landingCommit: () =>
            Effect.succeed({
              head,
              nothingNew: false,
              written: {
                sha: head,
                tree: Sha.make("b".repeat(40)),
                parents: [head],
                derived: {
                  sha: head,
                  packSha256: "a".repeat(64),
                  pack: new Uint8Array([1]),
                  idx: new Uint8Array([2]),
                },
              },
            }),
        }),
        Layer.mock(StoreRefsRepo, {}),
        Layer.mock(CheckpointsRepo, {}),
      ),
    ),
  );
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* LandingGit;
      return yield* git
        .commit(world, {
          checkpoint: checkpointOf(world, 1, head, "user-mark"),
          agentHead: head,
          lastLanded: null,
          author: { name: "Ada", email: "ada@example.invalid" },
          message: "Land the fix",
          keep: true,
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer)),
  );
  expect(error.step).toBe("commit");
  expect(error.message).toBe(COMMIT_NOT_KEPT);
  expect(error.message).not.toContain("BlobStoreError");
  expect(error.message).not.toContain("bucket");
});
