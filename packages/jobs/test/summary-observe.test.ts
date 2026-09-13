import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import {
  CaptureRuntimeLive,
  SessionRepository,
  SessionRepositoryCapturedLive,
  WorktreeReadsCapturedLive,
} from "@mend/sessions";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  worktreeRowFor,
} from "@mend/sessions/testing";
import { BlobStore, WORKTREE_TREE_REF, changeSummaryKey } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { SummaryObserver, SummaryObserverLive } from "../src/summary-observe.ts";

/**
 * The observed pass (ADR-0002 "Review"): a posted summary is `claimed` until a runner recomputes
 * it from the head capture's git class. Agreement stamps it; disagreement replaces it with what
 * the runner observed and stamps that.
 */
describe("summary-observe", () => {
  const world = makeCaptureWorld();
  const runtime = CaptureRuntimeLive.pipe(Layer.provide(world.layer));
  const layer = Layer.mergeAll(
    SummaryObserverLive.pipe(
      Layer.provide(runtime),
      Layer.provide(WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer))),
      Layer.provide(world.layer),
    ),
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, SummaryObserver | SessionRepository | CaptureStoreRepo | BlobStore>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  afterAll(() => {
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  it("stamps an agreeing summary observed, replaces a disagreeing one, and skips a stale capture", async () => {
    const worktreeId = newWorktreeId();
    const branch = `mend/wt/${worktreeId}`;
    world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
    // Capture 0, then an executor capture with one edit and a posted summary for it.
    const epoch = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.createWorktree(world.project.id, { directory: worktreeId, branch }, null, null);
        yield* repo.attachWorktree!(world.project.id, worktreeId);
        const captures = yield* CaptureStoreRepo;
        return (yield* captures.claim(worktreeId, "executor")).epoch;
      }),
    );
    const cap0 = world.memory.chains.get(worktreeId)?.headCapture ?? "";
    const basePack = JSON.parse(
      fs.readFileSync(
        path.join(world.blobRoot, world.memory.captures.get(cap0)?.manifestKey ?? ""),
        "utf8",
      ),
    ).sections.git.packs[0] as string;
    const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
      fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    });
    const cap1 = buildManifest({
      worktreeId,
      n: 1,
      parent: cap0,
      epoch,
      seq: 5,
      kind: "checkpoint",
      git: {
        packs: [basePack, edited.key],
        refs: { [`refs/heads/${branch}`]: world.baseSha, [WORKTREE_TREE_REF]: edited.tree },
        head: `refs/heads/${branch}`,
        fsck: "verified",
      },
    });
    const postSummary = (summary: unknown) =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const key = changeSummaryKey(worktreeId, 1);
        yield* blobs.put(key, new Uint8Array(Buffer.from(JSON.stringify(summary), "utf8")));
        const captures = yield* CaptureStoreRepo;
        yield* captures.acceptSummary(worktreeId, cap1.id, key);
        return key;
      });
    const observedDiff = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]]));
        const captures = yield* CaptureStoreRepo;
        yield* captures.register({
          worktreeId,
          id: cap1.id,
          n: 1,
          parent: cap0,
          epoch,
          seq: 5n,
          kind: "checkpoint",
          manifestKey: cap1.key,
          sections: cap1.manifest.sections,
          gitFsck: "verified",
        });
        // A wrong claim first: the executor said it also touched keep.md.
        yield* postSummary({
          base_sha: world.baseSha,
          files: [
            { path: "a.txt", additions: 1, deletions: 0 },
            { path: "keep.md", additions: 3, deletions: 0 },
          ],
          diff: "not what the runner sees",
        });
        const observer = yield* SummaryObserver;
        const outcome = yield* observer.observe({ worktreeId, captureId: cap1.id });
        expect(outcome).toEqual({ outcome: "observed", agreed: false });
        const blobs = yield* BlobStore;
        const stored = JSON.parse(
          Buffer.from(yield* blobs.get(changeSummaryKey(worktreeId, 1))).toString("utf8"),
        ) as { files: Array<{ path: string }>; diff: string };
        return stored;
      }),
    );
    expect(world.memory.summaries.get(cap1.id)?.state).toBe("observed");
    expect(observedDiff.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(observedDiff.diff).toContain("+three");
    // A claim that matches what the runner sees is stamped without being rewritten.
    const agreed = await run(
      Effect.gen(function* () {
        yield* postSummary(observedDiff);
        expect(world.memory.summaries.get(cap1.id)?.state).toBe("claimed");
        const observer = yield* SummaryObserver;
        return yield* observer.observe({ worktreeId, captureId: cap1.id });
      }),
    );
    expect(agreed).toEqual({ outcome: "observed", agreed: true });
    expect(world.memory.summaries.get(cap1.id)?.state).toBe("observed");
    // A summary for a capture that is no longer the head is left alone.
    const stale = await run(
      Effect.gen(function* () {
        const observer = yield* SummaryObserver;
        return yield* observer.observe({ worktreeId, captureId: cap0 });
      }),
    );
    expect(stale).toEqual({
      outcome: "skipped",
      reason: "the capture is no longer the chain head",
    });
  });
});
