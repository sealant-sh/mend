import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo, type CaptureRow } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { CaptureChannelLive, CaptureRuntimeLive } from "@mend/sessions";
import { makeMemoryCaptureStore } from "@mend/sessions/testing";
import { BlobStore, BlobStoreFsLive, captureKeys, packIdxKeyOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureRetention,
  CaptureRetentionLive,
  KEEP_ALL_MS,
  KEEP_HOURLY_MS,
  RETENTION_GRACE_MS,
  keysOfSections,
  thinningPlan,
} from "../src/capture-retention.ts";

/**
 * Retention over a directory bucket (ADR-0002 "Retention and compaction"): thinning by kind and
 * age, pack retirement after the grace from chain liveness only, and the sweep of a fenced epoch
 * prefix. Objects are written by hand under the fixed key layout; nothing here is a real pack.
 */

const HOUR = 60 * 60 * 1000;
const WT = WorktreeId.make("wt-ret");
const sha = (label: string) => label.padEnd(64, "0");

const row = (
  n: number,
  kind: CaptureRow["kind"],
  createdAt: number,
  epoch: number,
  sections: unknown = { git: { packs: [] }, workspace: { root: "", packs: [] }, bulk: "pending" },
): CaptureRow => ({
  id: sha(`cap${n}`),
  worktreeId: WT,
  n,
  parent: n === 0 ? null : sha(`cap${n - 1}`),
  epoch,
  seq: BigInt(n),
  kind,
  manifestKey: captureKeys(WT, epoch).manifest(sha(`cap${n}`)),
  sections,
  gitFsck: "verified",
  createdAt: new Date(createdAt),
});

describe("thinningPlan", () => {
  it("keeps checkpoint | suspend | final and the head; keeps every auto|turn for 24 h, one per hour to 7 d, none after", () => {
    const now = 10 * 24 * HOUR;
    const rows: Array<CaptureRow> = [
      row(0, "checkpoint", now - 9 * 24 * HOUR, 1),
      row(1, "auto", now - 8 * 24 * HOUR, 1), // older than 7 d → dropped
      row(2, "auto", now - 3 * 24 * HOUR - 20 * 60 * 1000, 1), // 3 d, hour bucket A, older → dropped
      row(3, "turn", now - 3 * 24 * HOUR - 10 * 60 * 1000, 1), // same bucket, newest → kept
      row(4, "suspend", now - 2 * 24 * HOUR, 1), // kept by kind
      row(5, "auto", now - 2 * HOUR, 1), // < 24 h → kept
      row(6, "auto", now - 60 * 1000, 1), // head → kept
    ];
    const drop = thinningPlan(rows, sha("cap6"), now);
    expect(drop.map((r) => r.n).toSorted()).toEqual([1, 2]);
    // Boundaries: exactly 24 h old enters hourly thinning; exactly 7 d old is dropped.
    const edge = [
      row(7, "auto", now - KEEP_ALL_MS, 1),
      row(8, "auto", now - KEEP_ALL_MS - 1, 1),
      row(9, "auto", now - KEEP_HOURLY_MS, 1),
    ];
    expect(thinningPlan(edge, null, now).map((r) => r.n)).toEqual([9]);
  });

  it("names every object a row's sections reference, including git indexes and dir roots", () => {
    expect(
      keysOfSections({
        git: { packs: ["captures/w/1/packs/a"] },
        workspace: { root: "captures/w/1/trees/r", packs: ["captures/w/1/packs/b"] },
        bulk: { root: "captures/w/1/trees/s", packs: ["captures/w/0/packs/c"] },
      }),
    ).toEqual([
      "captures/w/1/packs/a",
      "captures/w/1/packs/a.idx",
      "captures/w/1/packs/b",
      "captures/w/1/trees/r",
      "captures/w/0/packs/c",
      "captures/w/1/trees/s",
    ]);
    expect(
      keysOfSections({ git: { packs: [] }, workspace: { root: "", packs: [] }, bulk: "pending" }),
    ).toEqual([]);
  });
});

describe("CaptureRetention over dir://", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-retention-"));
  const blobRoot = path.join(scratch, "blobs");
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(blobRoot);
  const channel = CaptureChannelLive.pipe(Layer.provide(memory.layer), Layer.provide(blobs));
  const runtime = CaptureRuntimeLive.pipe(
    Layer.provide(channel),
    Layer.provide(memory.layer),
    Layer.provide(blobs),
  );
  const layer = Layer.mergeAll(
    CaptureRetentionLive.pipe(Layer.provide(runtime)),
    memory.layer,
    blobs,
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, CaptureRetention | CaptureStoreRepo | BlobStore>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const exists = (key: string) => fs.existsSync(path.join(blobRoot, key));
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("thins captures, retires unreferenced packs after the grace, and sweeps a fenced epoch prefix", async () => {
    const now = 30 * 24 * HOUR;
    memory.clock.now = () => now;
    const keys1 = captureKeys(WT, 1);
    const keys2 = captureKeys(WT, 2);
    // Objects: epoch 1 holds a base git pack (still referenced by the head, across epochs), a
    // workspace pack only the thinned capture named, and an orphan manifest whose CAS never
    // ran; epoch 2 holds the head's own pack.
    const basePack = keys1.pack(sha("base"));
    const stalePack = keys1.pack(sha("stale"));
    const headPack = keys2.pack(sha("head"));
    const orphanManifest = keys1.manifest(sha("orphan"));
    const cap0 = row(0, "checkpoint", now - 20 * 24 * HOUR, 1, {
      git: { packs: [basePack] },
      workspace: { root: "", packs: [] },
      bulk: "pending",
    });
    const cap1 = row(1, "auto", now - 10 * 24 * HOUR, 1, {
      git: { packs: [basePack] },
      workspace: { root: keys1.tree(sha("tree1")), packs: [stalePack] },
      bulk: "pending",
    });
    const cap2 = row(2, "turn", now - 2 * HOUR, 2, {
      git: { packs: [basePack, headPack] },
      workspace: { root: keys2.tree(sha("tree2")), packs: [] },
      bulk: "pending",
    });
    memory.leases.set(WT, { executorId: "executor", epoch: 2, expiresAt: now + 10_000 });
    memory.chains.set(WT, { headCapture: cap2.id, headN: 2, headEpoch: 2 });
    for (const capture of [cap0, cap1, cap2]) memory.captures.set(capture.id, capture);
    const objects = [
      basePack,
      packIdxKeyOf(basePack),
      stalePack,
      headPack,
      packIdxKeyOf(headPack),
      keys1.tree(sha("tree1")),
      keys2.tree(sha("tree2")),
      orphanManifest,
      cap0.manifestKey,
      cap1.manifestKey,
      cap2.manifestKey,
    ];
    await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const key of objects) yield* store.put(key, new Uint8Array([1, 2, 3]));
        const repo = yield* CaptureStoreRepo;
        yield* repo.recordPacks([
          { key: basePack, class: "git", bytes: 3, worktreeId: WT, epoch: 1, platform: null },
          {
            key: stalePack,
            class: "workspace",
            bytes: 3,
            worktreeId: WT,
            epoch: 1,
            platform: null,
          },
          { key: headPack, class: "git", bytes: 3, worktreeId: WT, epoch: 2, platform: null },
        ]);
      }),
    );
    // Packs were recorded "now": inside the grace, nothing retires yet even though cap1 thins.
    const first = await run(Effect.flatMap(CaptureRetention, (retention) => retention.run(now)));
    expect(first.capturesThinned).toBe(1);
    expect(first.packsRetired).toBe(0);
    expect(memory.captures.has(cap1.id)).toBe(false);
    expect(exists(cap1.manifestKey)).toBe(false);
    expect(exists(stalePack)).toBe(true);
    // Past the grace: the stale pack retires (row first, bytes second); the base pack, named by
    // the head across epochs, stays; the fenced epoch-1 prefix loses its orphan manifest and
    // the tree only the thinned capture named. Nothing under the live epoch moves.
    const later = now + RETENTION_GRACE_MS + 1;
    const second = await run(Effect.flatMap(CaptureRetention, (retention) => retention.run(later)));
    expect(second.capturesThinned).toBe(0);
    expect(second.packsRetired).toBe(1);
    expect(memory.packs.get(sha("stale"))?.state).toBe("retired");
    expect(memory.packs.get(sha("base"))?.state).toBe("uploaded");
    expect(exists(stalePack)).toBe(false);
    expect(exists(basePack)).toBe(true);
    expect(exists(packIdxKeyOf(basePack))).toBe(true);
    expect(exists(orphanManifest)).toBe(false);
    expect(exists(keys1.tree(sha("tree1")))).toBe(false);
    expect(exists(cap0.manifestKey)).toBe(true);
    expect(exists(headPack)).toBe(true);
    expect(exists(keys2.tree(sha("tree2")))).toBe(true);
    expect(exists(cap2.manifestKey)).toBe(true);
    // Idempotent: a third pass finds nothing.
    const third = await run(Effect.flatMap(CaptureRetention, (retention) => retention.run(later)));
    expect(third).toEqual({ chains: 1, capturesThinned: 0, packsRetired: 0, objectsRemoved: 0 });
  });
});
