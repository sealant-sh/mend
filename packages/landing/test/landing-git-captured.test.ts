import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { it as effectIt } from "@effect/vitest";
import { CaptureStoreRepo, CheckpointsRepo, SessionNotFoundError, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { CapturesBehindError, SessionEngine } from "@mend/sessions";
import {
  BlobStore,
  GitOpsRunner,
  packIdxKeyOf,
  landedRefOf as storeLandedRefOf,
} from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { LandingGitCapturedLive, landedRefOf } from "../src/landing-git-captured.ts";
import { Landing, LandingGit } from "../src/landing.ts";
import { withCapturedFixture } from "./captured-fixture.ts";
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

describe("the captured adapter over real Git and retained capture objects", () => {
  for (const detached of [false, true]) {
    effectIt.live(
      `pairs a matching checkpoint with its ${detached ? "detached HEAD" : "branch"} capture`,
      () =>
        withCapturedFixture(
          (f) =>
            f.provide(
              Effect.gen(function* () {
                const before = f.agentState();
                const recorded = yield* (yield* LandingGit).checkpoint(f.world, "user-mark");
                expect(recorded.checkpoint).toEqual(f.first.checkpoint);
                expect(recorded.agentHead).toBe(f.first.agentHead);
                expect(f.requests()).toEqual(["user-mark"]);
                expect(f.events()).toEqual([]);
                expect(f.agentState()).toEqual(before);
              }),
            ),
          { detached },
        ),
    );
  }

  effectIt.live("retries a moving capture and returns the next matched checkpoint/head pair", () =>
    withCapturedFixture((f) =>
      Effect.gen(function* () {
        const second = yield* f.addCapture();
        f.resetEvents();
        f.planCheckpoints([
          { taken: f.first, head: second },
          { taken: second, head: second },
        ]);
        const recorded = yield* f.provide(
          Effect.gen(function* () {
            return yield* (yield* LandingGit).checkpoint(f.world, "user-mark");
          }),
        );
        expect(recorded.checkpoint).toEqual(second.checkpoint);
        expect(recorded.agentHead).toBe(second.agentHead);
        expect(recorded.checkpoint.sha).not.toBe(f.first.checkpoint.sha);
        expect(f.requests()).toEqual(["user-mark", "user-mark"]);
        expect(f.events()).toEqual([]);
      }),
    ),
  );

  effectIt.live(
    "refuses after three checkpoint/capture mismatches without publishing a landed ref",
    () =>
      withCapturedFixture((f) =>
        Effect.gen(function* () {
          const second = yield* f.addCapture();
          const third = yield* f.addCapture();
          const fourth = yield* f.addCapture();
          f.resetEvents();
          const beforeRefs = f.refs();
          const beforePacks = f.inventory();
          const before = f.agentState();
          f.planCheckpoints([
            { taken: f.first, head: second },
            { taken: second, head: third },
            { taken: third, head: fourth },
          ]);
          const error = yield* f.provide(
            Effect.gen(function* () {
              return yield* (yield* LandingGit).checkpoint(f.world, "user-mark").pipe(Effect.flip);
            }),
          );
          expect(error._tag).toBe("LandingStepError");
          expect(error.step).toBe("checkpoint");
          expect(error.message).toBe(
            "the workspace's captures kept moving while landing · nothing landed · try again",
          );
          expect(f.requests()).toEqual(["user-mark", "user-mark", "user-mark"]);
          expect(f.refs()).toEqual(beforeRefs);
          expect(f.inventory()).toEqual(beforePacks);
          expect(f.events()).toEqual([]);
          expect(f.agentState()).toEqual(before);
        }),
      ),
  );

  effectIt.live(
    "lands an owner's captured tree, keeps real pack/index bytes, and pushes from the cache",
    () =>
      withCapturedFixture((f) =>
        f.provide(
          Effect.gen(function* () {
            const before = f.agentState();
            const initialKeys = new Set(f.inventory().map((row) => row.key));
            const report = yield* (yield* Landing).land({
              sessionId: f.world.session.id,
              actorUserId: "ada",
              trigger: "manual",
              remoteBranch: null,
              pullRequest: false,
              title: null,
              body: null,
              webOrigin: "https://mend.test",
              remoteEnv: Effect.succeed({}),
            });
            expect(report.landing.outcome).toBe("pushed");
            const head = report.landing.commitSha;
            if (head === null) throw new Error("The leftovers must produce an owner commit");
            expect(report.landing.pushedSha).toBe(head);
            expect(report.landing.remoteBranch).toBe(f.world.worktree.branch);
            expect(report.landing.checkpointSha).toBe(f.first.checkpoint.sha);
            expect(f.git(f.origin, ["rev-parse", `refs/heads/${f.world.worktree.branch}`])).toBe(
              head,
            );
            expect(f.git(f.origin, ["rev-parse", `${head}^{tree}`])).toBe(f.first.tree);
            expect(f.git(f.origin, ["show", "-s", "--format=%an <%ae>|%cn <%ce>|%P", head])).toBe(
              `Ada Owner <ada@example.com>|Ada Owner <ada@example.com>|${f.first.agentHead}`,
            );
            expect(f.git(f.origin, ["show", `${head}:leftover-1.txt`])).toBe("leftover 1");
            expect(f.git(f.origin, ["show", "-s", "--format=%B", head])).toBe(
              `Keep the captured change\n\nMend-Session: https://mend.test/sessions/${f.world.session.id}`,
            );
            expect(f.agentState()).toEqual(before);
            const kept = f.inventory().filter((row) => !initialKeys.has(row.key));
            expect(kept).toHaveLength(1);
            const row = kept[0];
            if (row === undefined) throw new Error("No derived landing inventory row");
            expect(row).toMatchObject({
              class: "git",
              worktreeId: f.world.worktree.id,
              epoch: null,
              platform: null,
            });
            const blobs = yield* BlobStore;
            const pack = yield* blobs.get(row.key);
            const idx = yield* blobs.get(packIdxKeyOf(row.key));
            expect(row.key).toBe(`${f.prefix}${createHash("sha256").update(pack).digest("hex")}`);
            expect(row.bytes).toBe(pack.byteLength);
            expect(idx.byteLength).toBeGreaterThan(0);
            fs.writeFileSync(path.join(f.root, "kept.pack"), pack);
            fs.writeFileSync(path.join(f.root, "kept.idx"), idx);
            expect(f.git(f.root, ["verify-pack", "-v", path.join(f.root, "kept.idx")])).toContain(
              head,
            );
            const ref = yield* (yield* StoreRefsRepo).get(
              f.world.project.id,
              landedRefOf(f.world.worktree.id),
            );
            expect(ref).toMatchObject({ sha: head, version: 1 });
            expect(f.events()).toEqual([
              `put:${row.key}`,
              `put:${packIdxKeyOf(row.key)}`,
              "inventory",
              `ref:${landedRefOf(f.world.worktree.id)}`,
            ]);
            const durable = yield* blobs.list(f.prefix);
            const rows = f.inventory();
            f.resetEvents();
            const repeated = yield* (yield* LandingGit).commit(f.world, {
              checkpoint: f.first.checkpoint,
              agentHead: f.first.agentHead,
              lastLanded: head,
              keep: true,
              author: { name: "Ada Owner", email: "ada@example.com" },
              message: "No new work",
            });
            expect(repeated).toEqual({ head, commitSha: null, nothingNew: true });
            expect(yield* blobs.list(f.prefix)).toEqual(durable);
            expect(f.inventory()).toEqual(rows);
            expect(
              yield* (yield* StoreRefsRepo).get(
                f.world.project.id,
                landedRefOf(f.world.worktree.id),
              ),
            ).toEqual(ref);
            expect(f.events()).toEqual([]);
            expect(f.agentState()).toEqual(before);
          }),
        ),
      ),
  );

  effectIt.live(
    "an unchanged agent tree needs no owner commit and a repeated landing changes no durable state",
    () =>
      withCapturedFixture(
        (f) =>
          f.provide(
            Effect.gen(function* () {
              const git = yield* LandingGit;
              const refs = yield* StoreRefsRepo;
              const rows = f.inventory();
              const input = {
                checkpoint: f.first.checkpoint,
                agentHead: f.first.agentHead,
                lastLanded: null,
                keep: true,
                author: { name: "Ada", email: "ada@example.invalid" },
                message: "No leftovers",
              };
              const first = yield* git.commit(f.world, input);
              expect(first).toEqual({
                head: f.first.agentHead,
                commitSha: null,
                nothingNew: false,
              });
              const ref = yield* refs.get(f.world.project.id, landedRefOf(f.world.worktree.id));
              expect(ref?.sha).toBe(f.first.agentHead);
              f.resetEvents();
              const again = yield* git.commit(f.world, { ...input, lastLanded: first.head });
              expect(again).toEqual({ head: first.head, commitSha: null, nothingNew: true });
              expect(yield* refs.get(f.world.project.id, landedRefOf(f.world.worktree.id))).toEqual(
                ref,
              );
              expect(f.inventory()).toEqual(rows);
              expect(f.events()).toEqual([]);
            }),
          ),
        { leftovers: false },
      ),
  );

  effectIt.live(
    "keep:false imports an exact owner tree and history without durable landing writes",
    () =>
      withCapturedFixture((f) =>
        f.provide(
          Effect.gen(function* () {
            const blobs = yield* BlobStore;
            const git = yield* LandingGit;
            const beforeBlobs = yield* blobs.list(f.prefix);
            const beforeRows = f.inventory();
            const beforeRefs = f.refs();
            const beforeAgent = f.agentState();
            const result = yield* git.commit(f.world, {
              checkpoint: f.first.checkpoint,
              agentHead: f.first.agentHead,
              lastLanded: null,
              keep: false,
              author: { name: "Ada", email: "ada@example.invalid" },
              message: "Pull this checkpoint",
            });
            expect(result.commitSha).toBe(result.head);
            const bundle = yield* git.bundle(f.world, {
              base: f.base,
              tip: result.head,
              branch: f.world.worktree.branch,
              limitBytes: 1024 * 1024,
            });
            const file = path.join(f.root, "change.bundle");
            fs.writeFileSync(file, bundle.bytes);
            const consumer = path.join(f.root, "consumer");
            fs.mkdirSync(consumer);
            f.git(consumer, ["init", "-q", "-b", "main"]);
            f.git(consumer, ["fetch", "-q", f.origin, "main"]);
            f.git(consumer, ["update-ref", "refs/heads/main", f.base]);
            f.git(consumer, [
              "fetch",
              "-q",
              file,
              `refs/heads/${f.world.worktree.branch}:refs/heads/imported`,
            ]);
            expect(f.git(consumer, ["rev-parse", "imported"])).toBe(result.head);
            expect(f.git(consumer, ["rev-parse", "imported^{tree}"])).toBe(f.first.tree);
            expect(
              f.git(consumer, ["show", "-s", "--format=%an <%ae>|%cn <%ce>|%P", "imported"]),
            ).toBe(`Ada <ada@example.invalid>|Ada <ada@example.invalid>|${f.first.agentHead}`);
            expect(f.git(consumer, ["show", "imported:leftover-1.txt"])).toBe("leftover 1");
            expect(f.git(consumer, ["show", "-s", "--format=%B", "imported"])).toBe(
              "Pull this checkpoint",
            );
            expect(bundle.commits).toBe(2);
            expect(f.git(consumer, ["rev-list", "--count", `${f.base}..imported`])).toBe("2");
            expect(yield* blobs.list(f.prefix)).toEqual(beforeBlobs);
            expect(f.inventory()).toEqual(beforeRows);
            expect(f.refs()).toEqual(beforeRefs);
            expect(f.agentState()).toEqual(beforeAgent);
            expect(f.requests()).toEqual([]);
            expect(f.events()).toEqual([]);
          }),
        ),
      ),
  );

  effectIt.live(
    "restores a kept commit after cache deletion and joins a later matched capture with a fast-forward push",
    () =>
      withCapturedFixture((f) =>
        Effect.gen(function* () {
          const first = yield* f.provide(
            Effect.gen(function* () {
              return yield* (yield* LandingGit).commit(f.world, {
                checkpoint: f.first.checkpoint,
                agentHead: f.first.agentHead,
                lastLanded: null,
                keep: true,
                author: { name: "Ada", email: "ada@example.invalid" },
                message: "First landing",
              });
            }),
          );
          yield* f.provide(
            Effect.gen(function* () {
              return yield* (yield* LandingGit).push(f.world, {
                sha: first.head,
                remoteBranch: f.world.worktree.branch,
                remoteEnv: {},
              });
            }),
          );
          const second = yield* f.addCapture();
          f.planCheckpoints([{ taken: second, head: second }]);
          const before = f.agentState();
          f.deleteCache();
          expect(fs.existsSync(f.cachePath)).toBe(false);
          const result = yield* f.provide(
            Effect.gen(function* () {
              const git = yield* LandingGit;
              const taken = yield* git.checkpoint(f.world, "user-mark");
              expect(taken.agentHead).toBe(second.agentHead);
              expect(taken.checkpoint.sha).toBe(second.checkpoint.sha);
              const keptRef = yield* (yield* StoreRefsRepo).get(
                f.world.project.id,
                landedRefOf(f.world.worktree.id),
              );
              expect(keptRef?.sha).toBe(first.head);
              expect(f.git(f.cachePath, ["rev-parse", `${first.head}^{tree}`])).toBe(f.first.tree);
              const next = yield* git.commit(f.world, {
                checkpoint: taken.checkpoint,
                agentHead: taken.agentHead,
                lastLanded: first.head,
                keep: true,
                author: { name: "Ada", email: "ada@example.invalid" },
                message: "Second landing",
              });
              yield* git.push(f.world, {
                sha: next.head,
                remoteBranch: f.world.worktree.branch,
                remoteEnv: {},
              });
              return next;
            }),
          );
          expect(f.git(f.origin, ["rev-parse", `${result.head}^{tree}`])).toBe(second.tree);
          expect(f.git(f.origin, ["show", "-s", "--format=%P", result.head])).toBe(
            `${first.head} ${second.agentHead}`,
          );
          expect(f.git(f.origin, ["merge-base", "--is-ancestor", first.head, result.head])).toBe(
            "",
          );
          expect(
            f.git(f.origin, ["merge-base", "--is-ancestor", second.agentHead, result.head]),
          ).toBe("");
          expect(f.git(f.origin, ["show", `${result.head}:leftover-2.txt`])).toBe("leftover 2");
          expect(f.agentState()).toEqual(before);
        }),
      ),
  );
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
            Effect.fail(
              new CapturesBehindError({
                worktreeId: world.worktree.id,
                attempts: 4,
                stopping: false,
              }),
            ),
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

  it("names what is missing in words, and keeps the error's tag for the log", async () => {
    const world = makeWorld();
    const engine = Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      landingCheckpoint: () =>
        Effect.fail(new SessionNotFoundError({ sessionId: world.session.id })),
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
    expect(failure.message).toBe("the session no longer exists · nothing landed");
    expect(failure.message).not.toContain("SessionNotFoundError");
  });
});
