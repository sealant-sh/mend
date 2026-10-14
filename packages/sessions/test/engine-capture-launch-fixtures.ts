import * as fs from "node:fs";
import * as path from "node:path";

import type { WorktreeId } from "@mend/domain";
import { BlobStoreFsLive, decodeManifest, materialize } from "@mend/store";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";

import type { MemoryCaptureStore } from "./capture-store-memory.ts";
import { configuredHarnessHomePath } from "./engine/capture-fixture.ts";

/** Apply the head manifest's virtual `workspace/harness` entry to the selected daemon root. */
export const restoreConfiguredHarnessHome = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  options: CreateOptions,
  executorRoot: string,
) =>
  Effect.gen(function* () {
    const headId = memory.chains.get(worktreeId)?.headCapture ?? null;
    const head = headId === null ? null : (memory.captures.get(headId) ?? null);
    if (head === null) throw new Error("capture source has no head to materialize");
    const manifest = yield* decodeManifest(
      head.manifestKey,
      new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", head.manifestKey))),
    ).pipe(Effect.orDie);
    const workspace = path.join(executorRoot, "materialized-workspace");
    fs.rmSync(workspace, { recursive: true, force: true });
    yield* materialize(manifest, "workspace", workspace).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
      Effect.orDie,
    );
    const virtualHarness = path.join(workspace, "harness");
    if (!fs.existsSync(virtualHarness)) return;
    const harnessHome = configuredHarnessHomePath(options, executorRoot);
    fs.mkdirSync(path.dirname(harnessHome), { recursive: true });
    fs.renameSync(virtualHarness, harnessHome);
  });
