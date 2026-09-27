import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStoreFsLive,
  captureKeys,
  type DirEntry,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  GitOpsRunner,
  sha256Hex,
} from "@mend/store";
import { buildManifest, uploadObjects, writeCdcPack } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { memoryStoreRefs } from "./capture-world.ts";

/**
 * The change view's count of worktree paths too long for git (e2e run 4, 2026-09-27): read from
 * the chain head's workspace class, stamped with the capture it came from.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-reads-beyond-git-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const file = (name: string): DirEntry => ({
  name,
  kind: "file",
  mode: 0o100644,
  size: 0,
  mtime: 1,
  chunks: [],
});

describe("WorktreeReads.pathsBeyondGit (captured)", () => {
  it("counts the head's paths git cannot reach, stamped with that capture; none before any capture", async () => {
    const memory = makeMemoryCaptureStore();
    const blobs = BlobStoreFsLive(path.join(scratch, "blobs"));
    const layer = WorktreeReadsCapturedLive.pipe(
      Layer.provide(memory.layer),
      Layer.provide(blobs),
      Layer.provide(memoryStoreRefs()),
      Layer.provide(Layer.mock(GitOpsRunner, {})),
    );
    const worktreeId = WorktreeId.make("wt-beyond-git");
    const project = ProjectId.make("p-beyond-git");
    // tree/<17 × 243-byte directories>/leaf.txt: 4,156 bytes below the worktree root.
    const dirObjects: Array<Uint8Array> = [];
    const dir = (name: string, entries: ReadonlyArray<DirEntry>): DirEntry => {
      const bytes = encodeDirObject(entries);
      dirObjects.push(bytes);
      return { name, kind: "dir", mode: 0o40755, size: 0, mtime: 1, child: sha256Hex(bytes) };
    };
    let deepest = dir("q".repeat(243), [file("leaf.txt")]);
    for (let at = 0; at < 16; at += 1) deepest = dir(`${at}`.padEnd(243, "q"), [deepest]);
    const root = dir("", [dir("harness", []), dir("tree", [deepest, file("short.txt")])]);
    const pack = writeCdcPack(dirObjects);
    const packKey = captureKeys(worktreeId, 1).pack(sha256Hex(pack.bytes));
    const built = buildManifest({
      worktreeId,
      epoch: 1,
      n: 0,
      parent: null,
      workspace: {
        root: root.child ?? "",
        packs: [],
        format: FORMAT_DIR_PACKS,
        dir_packs: [packKey],
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reads = yield* WorktreeReads;
        const before = yield* reads.pathsBeyondGit(project, worktreeId);
        yield* uploadObjects(
          new Map([
            [packKey, pack.bytes],
            [built.key, built.bytes],
          ]),
        );
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
        const after = yield* reads.pathsBeyondGit(project, worktreeId);
        return { before, after };
      }).pipe(Effect.provide(Layer.mergeAll(layer, memory.layer, blobs))),
    );
    expect(result.before).toBeNull();
    expect(result.after?.value.count).toBe(1);
    expect(result.after?.value.paths[0]?.endsWith("/leaf.txt")).toBe(true);
    expect(result.after?.stamp.captureN).toBe(0);
  });
});
