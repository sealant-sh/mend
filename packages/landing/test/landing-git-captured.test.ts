import { CaptureStoreRepo, CheckpointsRepo, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { CapturesBehindError, SessionEngine } from "@mend/sessions";
import { BlobStore, GitOpsRunner, landedRefOf as storeLandedRefOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { LandingGitCapturedLive, landedRefOf } from "../src/landing-git-captured.ts";
import { LandingGit } from "../src/landing.ts";
import { checkpointOf, makeWorld } from "./world.ts";

/**
 * Which commit a capture-backed landing builds on is the store's `planLanding`, tested with real
 * repositories in @mend/store (a fresh runner cache restored from the derived pack and the landed
 * ref, after the agent committed). What this adapter adds is where the landed head is kept.
 */
describe("landedRefOf", () => {
  it("keeps the latest landed head under Mend's own namespace, never the agent's branch", () => {
    expect(landedRefOf("wt-1")).toBe("refs/mend/landed/wt-1");
    expect(landedRefOf).toBe(storeLandedRefOf);
  });
});

/**
 * Every landing's step 1 — the Land panel, Slack's button, `mend land`, a completed turn — goes
 * through this adapter, so the capture barrier lives here: nothing is read, committed or pushed
 * from a head the executor's captures have not caught up with.
 */
describe("a capture-backed landing's checkpoint", () => {
  it("waits for the executor's captures and lands nothing while they are behind", async () => {
    const world = makeWorld();
    const asked: string[] = [];
    const engine = Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      // The old path: a checkpoint of whatever head is registered, caught up or not.
      checkpointNow: (_sessionId, trigger) =>
        Effect.sync(() => {
          asked.push("checkpointNow");
          return checkpointOf(world, 1, Sha.make("1".repeat(40)), trigger);
        }),
      landingCheckpoint: () =>
        Effect.sync(() => void asked.push("landingCheckpoint")).pipe(
          Effect.andThen(
            Effect.fail(new CapturesBehindError({ worktreeId: world.worktree.id, attempts: 4 })),
          ),
        ),
    });
    const layer = LandingGitCapturedLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          engine,
          Layer.mock(CaptureStoreRepo, {}),
          Layer.mock(BlobStore, { identity: "test" }),
          Layer.mock(GitOpsRunner, {}),
          Layer.mock(StoreRefsRepo, {}),
          Layer.mock(CheckpointsRepo, {}),
        ),
      ),
    );
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* LandingGit).checkpoint(world, "user-mark").pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(failure._tag).toBe("LandingStepError");
    expect(failure.step).toBe("checkpoint");
    expect(failure.message).toBe(
      "the workspace's captures have not caught up · asked 4 times · nothing landed · try again",
    );
    expect(asked).toEqual(["landingCheckpoint"]);
  });
});
