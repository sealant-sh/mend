import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo, type CaptureRow } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import {
  CaptureChannelLive,
  CaptureGitVerifierOff,
  CaptureRemotesOff,
  CaptureSourcesOff,
  CaptureRuntimeLive,
  CaptureUploadPolicyDefault,
} from "@mend/sessions";
import { makeMemoryCaptureStore } from "@mend/sessions/testing";
import { BlobStore, BlobStoreFsLive, captureKeys, packIdxKeyOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureRetention,
  CaptureRetentionLive,
  KEEP_ALL_MS,
  KEEP_HOURLY_MS,
  MULTIPART_ORPHAN_MS,
  RETENTION_GRACE_MS,
  keysOfSections,
  thinningPlan,
  treePrefixesOfSections,
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

  it("names a format-2 section's dir packs, and never its root digest, which is no object", () => {
    const digest = "d".repeat(64);
    expect(
      keysOfSections({
        git: { packs: [] },
        workspace: {
          root: digest,
          packs: ["captures/w/2/packs/b"],
          format: 2,
          dir_packs: ["captures/w/2/packs/dw"],
        },
        // A mixed manifest: the format-1 bulk section carried from epoch 1.
        bulk: { root: "captures/w/1/trees/s", packs: ["captures/w/1/packs/c"], platform: "p" },
      }),
    ).toEqual([
      "captures/w/2/packs/b",
      "captures/w/2/packs/dw",
      "captures/w/1/packs/c",
      "captures/w/1/trees/s",
    ]);
    expect(
      treePrefixesOfSections({
        workspace: { root: digest, packs: [], format: 2, dir_packs: [] },
        bulk: { root: "captures/w/1/trees/s", packs: [], platform: "p" },
      }),
    ).toEqual(["captures/w/1/trees/"]);
  });

  it("names every object another platform's bulk section names (other_bulk), in either format", () => {
    const digest = "e".repeat(64);
    const sections = {
      git: { packs: [] },
      workspace: { root: "", packs: [] },
      bulk: { root: "captures/w/3/trees/x", packs: ["captures/w/3/packs/x"], platform: "x86" },
      other_bulk: {
        arm: { root: "captures/w/1/trees/a", packs: ["captures/w/1/packs/a"], platform: "arm" },
        riscv: {
          root: digest,
          packs: ["captures/w/2/packs/r"],
          platform: "riscv",
          format: 2,
          dir_packs: ["captures/w/2/packs/rd"],
        },
      },
    };
    expect(keysOfSections(sections)).toEqual([
      "captures/w/3/packs/x",
      "captures/w/3/trees/x",
      "captures/w/1/packs/a",
      "captures/w/1/trees/a",
      "captures/w/2/packs/r",
      "captures/w/2/packs/rd",
    ]);
    expect(treePrefixesOfSections(sections)).toEqual([
      "captures/w/3/trees/",
      "captures/w/1/trees/",
    ]);
    // Anything but a map of sections names nothing.
    for (const other_bulk of [null, "pending", ["captures/w/1/packs/a"]]) {
      expect(keysOfSections({ ...sections, other_bulk })).toEqual([
        "captures/w/3/packs/x",
        "captures/w/3/trees/x",
      ]);
    }
  });
});

describe("CaptureRetention over dir://", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-retention-"));
  const blobRoot = path.join(scratch, "blobs");
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(blobRoot);
  const channel = CaptureChannelLive.pipe(
    Layer.provide(CaptureGitVerifierOff),
    Layer.provide(CaptureSourcesOff),
    Layer.provide(CaptureRemotesOff),
    Layer.provide(memory.layer),
    Layer.provide(blobs),
    Layer.provide(CaptureUploadPolicyDefault),
  );
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
    expect(third).toEqual({
      chains: 1,
      capturesThinned: 0,
      packsRetired: 0,
      objectsRemoved: 0,
      multipartAborted: 0,
    });
  });

  it("keeps what a live capture needs under a fenced epoch: its dir packs and every dir object below a format-1 root it carries", async () => {
    // A second worktree: the head stands at epoch 3 in format 2 for the workspace and carries
    // the format-1 bulk section an older executor wrote under epoch 2 (a mixed manifest). The
    // bulk tree's child dir object is named by no row — only by the root above it.
    const wt = WorktreeId.make("wt-ret-v2");
    const now = 40 * 24 * HOUR;
    memory.clock.now = () => now;
    const keys2 = captureKeys(wt, 2);
    const keys3 = captureKeys(wt, 3);
    const bulkRoot = keys2.tree(sha("bulkroot"));
    const bulkChild = keys2.tree(sha("bulkchild"));
    const bulkPack = keys2.pack(sha("bulkpack"));
    const strayTree = captureKeys(wt, 1).tree(sha("stray"));
    const dirPackOld = keys2.pack(sha("dirpack2"));
    const dirPackNew = keys3.pack(sha("dirpack3"));
    const contentPack = keys3.pack(sha("content3"));
    const olderCheckpoint: CaptureRow = {
      ...row(0, "checkpoint", now - 5 * HOUR, 2, {
        git: { packs: [] },
        // An epoch-2 capture of this build: format 2, its dir pack under epoch 2.
        workspace: { root: sha("root2"), packs: [], format: 2, dir_packs: [dirPackOld] },
        bulk: { root: bulkRoot, packs: [bulkPack], platform: "linux-x86_64-gnu" },
      }),
      worktreeId: wt,
      manifestKey: keys2.manifest(sha("m0")),
      id: sha("v2cap0"),
    };
    const head: CaptureRow = {
      ...row(1, "turn", now - 2 * HOUR, 3, {
        git: { packs: [] },
        workspace: {
          root: sha("root3"),
          packs: [contentPack],
          format: 2,
          dir_packs: [dirPackOld, dirPackNew],
        },
        bulk: { root: bulkRoot, packs: [bulkPack], platform: "linux-x86_64-gnu" },
      }),
      worktreeId: wt,
      manifestKey: keys3.manifest(sha("m1")),
      id: sha("v2cap1"),
      parent: sha("v2cap0"),
    };
    memory.leases.set(wt, { executorId: "executor", epoch: 3, expiresAt: now + 10_000 });
    memory.chains.set(wt, { headCapture: head.id, headN: 1, headEpoch: 3 });
    for (const capture of [olderCheckpoint, head]) memory.captures.set(capture.id, capture);
    const objects = [
      bulkRoot,
      bulkChild,
      bulkPack,
      strayTree,
      dirPackOld,
      dirPackNew,
      contentPack,
      olderCheckpoint.manifestKey,
      head.manifestKey,
    ];
    await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const key of objects) yield* store.put(key, new Uint8Array([1, 2, 3]));
        const repo = yield* CaptureStoreRepo;
        yield* repo.recordPacks(
          [
            { key: bulkPack, epoch: 2, cls: "bulk" as const },
            { key: dirPackOld, epoch: 2, cls: "workspace" as const },
            { key: dirPackNew, epoch: 3, cls: "workspace" as const },
            { key: contentPack, epoch: 3, cls: "workspace" as const },
          ].map(({ key, epoch, cls }) => ({
            key,
            class: cls,
            bytes: 3,
            worktreeId: wt,
            epoch,
            platform: cls === "bulk" ? "linux-x86_64-gnu" : null,
          })),
        );
      }),
    );
    // Well past the grace: packs recorded "now" would retire if no row named them, and the
    // fenced epochs 1 and 2 are swept of what no live capture needs.
    const later = now + RETENTION_GRACE_MS + 1;
    await run(Effect.flatMap(CaptureRetention, (retention) => retention.run(later)));
    for (const key of [dirPackOld, dirPackNew, contentPack, bulkPack, bulkRoot, bulkChild]) {
      expect(exists(key)).toBe(true);
    }
    expect(memory.packs.get(sha("dirpack2"))?.state).toBe("uploaded");
    expect(memory.packs.get(sha("dirpack3"))?.state).toBe("uploaded");
    // A dir object under a fenced prefix no live root lives under still goes.
    expect(exists(strayTree)).toBe(false);
  });

  it("keeps another platform's dependency tree under a fenced epoch while a live head carries it in other_bulk", async () => {
    // The session moved: an arm64 executor built a format-1 tree under epoch 1, a riscv one a
    // format-2 tree under epoch 2, and the head, on amd64 at epoch 4, carries both in
    // other_bulk. Every older capture row is gone: only the head names them.
    const wt = WorktreeId.make("wt-ret-other-bulk");
    const now = 50 * 24 * HOUR;
    memory.clock.now = () => now;
    const keys1 = captureKeys(wt, 1);
    const keys2 = captureKeys(wt, 2);
    const keys4 = captureKeys(wt, 4);
    const armRoot = keys1.tree(sha("armroot"));
    const armChild = keys1.tree(sha("armchild"));
    const armPack = keys1.pack(sha("armpack"));
    const riscvPack = keys2.pack(sha("riscvpack"));
    const riscvDirPack = keys2.pack(sha("riscvdir"));
    const x86Pack = keys4.pack(sha("x86pack"));
    const x86DirPack = keys4.pack(sha("x86dir"));
    // Off-chain leftovers under the same fenced epochs: these still go.
    const strayPack = keys2.pack(sha("straypack"));
    const strayManifest = keys1.manifest(sha("straymanifest"));
    const head: CaptureRow = {
      ...row(7, "turn", now - 2 * HOUR, 4, {
        git: { packs: [] },
        workspace: { root: "", packs: [] },
        bulk: {
          root: sha("x86root"),
          packs: [x86Pack],
          platform: "linux-x86_64-gnu",
          format: 2,
          dir_packs: [x86DirPack],
        },
        other_bulk: {
          "linux-aarch64-gnu": { root: armRoot, packs: [armPack], platform: "linux-aarch64-gnu" },
          "linux-riscv64-gnu": {
            root: sha("riscvroot"),
            packs: [riscvPack],
            platform: "linux-riscv64-gnu",
            format: 2,
            dir_packs: [riscvDirPack],
          },
        },
      }),
      worktreeId: wt,
      manifestKey: keys4.manifest(sha("ob7")),
      id: sha("obcap7"),
      parent: sha("obcap6"),
    };
    memory.leases.set(wt, { executorId: "executor", epoch: 4, expiresAt: now + 10_000 });
    memory.chains.set(wt, { headCapture: head.id, headN: 7, headEpoch: 4 });
    memory.captures.set(head.id, head);
    const kept = [armRoot, armChild, armPack, riscvPack, riscvDirPack, x86Pack, x86DirPack];
    await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const key of [...kept, strayPack, strayManifest, head.manifestKey]) {
          yield* store.put(key, new Uint8Array([1, 2, 3]));
        }
        const repo = yield* CaptureStoreRepo;
        yield* repo.recordPacks(
          [
            { key: armPack, epoch: 1, platform: "linux-aarch64-gnu" },
            { key: riscvPack, epoch: 2, platform: "linux-riscv64-gnu" },
            { key: riscvDirPack, epoch: 2, platform: "linux-riscv64-gnu" },
            { key: x86Pack, epoch: 4, platform: "linux-x86_64-gnu" },
            { key: x86DirPack, epoch: 4, platform: "linux-x86_64-gnu" },
          ].map(({ key, epoch, platform }) => ({
            key,
            class: "bulk" as const,
            bytes: 3,
            worktreeId: wt,
            epoch,
            platform,
          })),
        );
      }),
    );
    const later = now + RETENTION_GRACE_MS + 1;
    await run(Effect.flatMap(CaptureRetention, (retention) => retention.run(later)));
    for (const key of [...kept, head.manifestKey]) expect(exists(key)).toBe(true);
    for (const digest of ["armpack", "riscvpack", "riscvdir", "x86pack", "x86dir"]) {
      expect(memory.packs.get(sha(digest))?.state).toBe("uploaded");
    }
    expect(exists(strayPack)).toBe(false);
    expect(exists(strayManifest)).toBe(false);
  });

  it("aborts orphaned multipart uploads: under a fenced epoch at once, under the live epoch once the part URLs have lapsed", async () => {
    // The head stands at epoch 2 (previous test); an upload under epoch 1 can never complete
    // (no lease predicate passes for it), one under epoch 2 may still be in flight.
    const fencedKey = captureKeys(WT, 1).pack(sha("mp-fenced"));
    const liveKey = captureKeys(WT, 2).pack(sha("mp-live"));
    const opened = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const fenced = yield* store.createMultipart(fencedKey);
        const live = yield* store.createMultipart(liveKey);
        return { fenced: fenced.kind, live: live.kind };
      }),
    );
    expect(opened).toEqual({ fenced: "created", live: "created" });
    const wallClock = Date.now();
    const first = await run(
      Effect.flatMap(CaptureRetention, (retention) => retention.run(wallClock)),
    );
    expect(first.multipartAborted).toBe(1);
    const afterFirst = await run(
      Effect.flatMap(BlobStore, (store) => store.listMultipart(`captures/${WT}/`)),
    );
    expect(afterFirst.map((upload) => upload.key)).toEqual([liveKey]);
    const second = await run(
      Effect.flatMap(CaptureRetention, (retention) =>
        retention.run(wallClock + MULTIPART_ORPHAN_MS + 1),
      ),
    );
    expect(second.multipartAborted).toBe(1);
    const afterSecond = await run(
      Effect.flatMap(BlobStore, (store) => store.listMultipart(`captures/${WT}/`)),
    );
    expect(afterSecond).toEqual([]);
  });
});
