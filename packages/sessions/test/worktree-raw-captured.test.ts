import { CaptureStoreRepo, StoreRefsRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import { BlobStore, GitOpsRunner } from "@mend/store";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";

it("answers a captured raw read as not available yet, without preparing a capture", async () => {
  const layer = WorktreeReadsCapturedLive.pipe(
    Layer.provide(Layer.mock(CaptureStoreRepo, {})),
    Layer.provide(Layer.mock(BlobStore, { identity: "unused" })),
    Layer.provide(Layer.mock(GitOpsRunner, {})),
    Layer.provide(Layer.mock(StoreRefsRepo, {})),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        Effect.flatMap(WorktreeReads, (reads) =>
          reads.openRawFile(ProjectId.make("project"), WorktreeId.make("worktree"), {
            path: "image.png",
            within: "",
          }),
        ),
      ),
    ).pipe(Effect.provide(layer)),
  );
  expect(error).toMatchObject({ _tag: "RawReadError", reason: "captured" });
});
