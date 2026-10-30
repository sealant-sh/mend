import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStoreFsLive,
  FORMAT_DIR_PACKS,
  GitOpsRunner,
  RawBlobCacheOff,
  sha256Hex,
} from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { memoryStoreRefs } from "./capture-world.ts";

/**
 * A worktree whose last capture cannot be restored: what removal asks (`changedFiles`) fails as a
 * read that did not happen, which removal turns into a blocker, never into a 500.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-reads-unrestorable-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const changedFilesOver = async (manifest: "missing" | "malformed") => {
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(path.join(scratch, `blobs-${manifest}`));
  const layer = WorktreeReadsCapturedLive.pipe(
    Layer.provide(memory.layer),
    Layer.provide(blobs),
    Layer.provide(memoryStoreRefs()),
    Layer.provide(Layer.mock(GitOpsRunner, {})),
    Layer.provide(RawBlobCacheOff),
  );
  const worktreeId = WorktreeId.make(`wt-${manifest}`);
  const built = buildManifest({
    worktreeId,
    epoch: 1,
    n: 0,
    parent: null,
    workspace: {
      root: sha256Hex(new Uint8Array()),
      packs: [],
      format: FORMAT_DIR_PACKS,
      dir_packs: [],
    },
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      if (manifest === "malformed") {
        yield* uploadObjects(new Map([[built.key, new TextEncoder().encode("{ not a manifest")]]));
      }
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(worktreeId);
      yield* repo.claim(worktreeId, "executor-1", 300);
      yield* repo.register({
        worktreeId,
        id: built.id,
        n: 0,
        parent: null,
        epoch: 1,
        seq: 1n,
        kind: "final",
        manifestKey: built.key,
        sections: built.manifest.sections,
        gitFsck: "verified",
      });
      const reads = yield* WorktreeReads;
      return yield* reads
        .changedFiles(ProjectId.make("p-unrestorable"), worktreeId, "base")
        .pipe(Effect.exit);
    }).pipe(Effect.provide(Layer.mergeAll(layer, memory.layer, blobs))),
  );
};

describe("WorktreeReads.changedFiles over a capture it cannot restore (captured)", () => {
  for (const manifest of ["missing", "malformed"] as const) {
    it(`fails as a read that did not happen when the head's manifest is ${manifest}`, async () => {
      const exit = await changedFilesOver(manifest);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null;
      expect(failure).toMatchObject({
        _tag: "Some",
        value: {
          _tag: "WorktreeNotCapturedError",
          message: expect.stringContaining("the change's last capture cannot be restored"),
        },
      });
    });
  }
});
