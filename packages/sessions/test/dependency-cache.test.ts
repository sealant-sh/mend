import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  BlobStoreFsLive,
  captureKeys,
  decodeDirObject,
  keysNeededBy,
  materialize,
} from "@mend/store";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureUploadPolicyDefault,
  planForPlatform,
} from "../src/capture-channel.ts";
import { CaptureRemotesOff } from "../src/capture-remotes.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifierOff } from "../src/capture-verify.ts";
import {
  bulkSectionOfCache,
  dependencyCachePrefix,
  detectInstallCommand,
  platformKeyOf,
  promoteBulkToCache,
  readDependencyCache,
} from "../src/dependency-cache.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

describe("detectInstallCommand", () => {
  it("names the frozen install for the lockfile at the root, or nothing", () => {
    expect(detectInstallCommand(["package.json", "pnpm-lock.yaml"])).toBe(
      "pnpm install --frozen-lockfile",
    );
    expect(detectInstallCommand(["package.json", "yarn.lock"])).toBe("yarn install --immutable");
    expect(detectInstallCommand(["package.json", "package-lock.json"])).toBe("npm ci");
    expect(detectInstallCommand(["package.json"])).toBe("npm install");
    expect(detectInstallCommand(["Cargo.toml", "Cargo.lock"])).toBe("cargo fetch --locked");
    expect(detectInstallCommand(["pyproject.toml", "uv.lock"])).toBe("uv sync --frozen");
    expect(detectInstallCommand(["README.md"])).toBeNull();
  });
});

describe("platformKeyOf", () => {
  it("reads the probe into sealantd's <os>-<arch>-<libc>", () => {
    expect(platformKeyOf("Linux\nx86_64\nldd (GNU libc) 2.39\n")).toBe("linux-x86_64-gnu");
    expect(platformKeyOf("Linux\naarch64\nmusl libc (aarch64)\nVersion 1.2.5\n")).toBe(
      "linux-aarch64-musl",
    );
    expect(platformKeyOf("Darwin\narm64\n")).toBe("macos-aarch64-system");
    expect(platformKeyOf("")).toBeNull();
  });
});

describe("planForPlatform", () => {
  it("leaves the bulk section for the capturing platform and withholds it from another", () => {
    const manifest = buildManifest({
      worktreeId: "wt-x",
      n: 1,
      parent: null,
      epoch: 1,
      seq: 1,
      kind: "turn",
      bulk: {
        root: "captures/wt-x/1/trees/aa",
        packs: ["captures/wt-x/1/packs/bb"],
        platform: "linux-x86_64-gnu",
      },
    }).manifest;
    expect(planForPlatform(manifest, undefined)).toBe(manifest);
    expect(planForPlatform(manifest, "linux-x86_64-gnu")).toBe(manifest);
    expect(planForPlatform(manifest, "linux-aarch64-musl").sections.bulk).toBe("pending");
  });

  it("answers another platform its own tree from other_bulk, as stored, and pending when it has none", () => {
    const x86 = {
      root: "captures/wt-x/2/trees/aa",
      packs: ["captures/wt-x/2/packs/bb"],
      platform: "linux-x86_64-gnu",
    };
    const arm = {
      root: "c".repeat(64),
      packs: ["captures/wt-x/1/packs/dd"],
      platform: "linux-aarch64-gnu",
      format: 2 as const,
      dir_packs: ["captures/wt-x/1/packs/ee"],
    };
    const manifest = buildManifest({
      worktreeId: "wt-x",
      n: 2,
      parent: null,
      epoch: 2,
      kind: "turn",
      bulk: x86,
      otherBulk: { "linux-aarch64-gnu": arm },
    }).manifest;
    const forArm = planForPlatform(manifest, "linux-aarch64-gnu");
    expect(forArm.sections.bulk).toEqual(arm);
    // What the head carries is left as stored; only the answered section moves into `bulk`.
    expect(forArm.sections.other_bulk).toEqual({ "linux-aarch64-gnu": arm });
    expect(planForPlatform(manifest, "linux-x86_64-gnu")).toBe(manifest);
    expect(planForPlatform(manifest, "linux-aarch64-musl").sections.bulk).toBe("pending");
    // A head still pending on its own platform answers the platform other_bulk carries.
    const pendingHere = buildManifest({
      worktreeId: "wt-x",
      n: 3,
      parent: null,
      epoch: 3,
      otherBulk: { "linux-x86_64-gnu": x86 },
    }).manifest;
    expect(planForPlatform(pendingHere, "linux-x86_64-gnu").sections.bulk).toEqual(x86);
    expect(planForPlatform(pendingHere, "linux-aarch64-gnu")).toBe(pendingHere);
  });
});

describe("the shared dependency cache", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dependency-cache-"));
  const blobRoot = path.join(scratch, "blobs");
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(blobRoot);
  const layer = Layer.mergeAll(
    CaptureChannelLive.pipe(
      Layer.provide(CaptureGitVerifierOff),
      Layer.provide(CaptureSourcesOff),
      Layer.provide(CaptureRemotesOff),
      Layer.provide(memory.layer),
      Layer.provide(blobs),
      Layer.provide(CaptureUploadPolicyDefault),
    ),
    blobs,
    memory.layer,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore | CaptureStoreRepo | CaptureChannel>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const PROJECT = ProjectId.make("proj-cache");
  const PLATFORM = "linux-x86_64-gnu";

  /** An executor's capture with a dependency tree: `node_modules/pkg/index.js` in the bulk class. */
  const bulkCapture = (worktreeId: WorktreeId, epoch: number, n: number, parent: string | null) => {
    const tree = path.join(scratch, `bulk-${worktreeId}-${n}`);
    fs.mkdirSync(path.join(tree, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tree, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const built = buildManifest({
      worktreeId,
      n,
      parent,
      epoch,
      seq: 10 * n,
      kind: "checkpoint",
      bulk: { root: snapshot.root, packs: snapshot.packs, platform: PLATFORM },
    });
    return { snapshot, built };
  };

  it("a session's registered bulk capture writes nothing under the cache prefix; the install job's promotion does, re-keyed, and is readable", async () => {
    const worktreeId = WorktreeId.make("wt-session");
    const { snapshot, built } = bulkCapture(worktreeId, 1, 0, null);
    const cachePrefix = dependencyCachePrefix(PROJECT, PLATFORM);
    const listCache = Effect.gen(function* () {
      const store = yield* BlobStore;
      return (yield* store.list(cachePrefix)).map((entry) => entry.key);
    });
    const registered = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(worktreeId);
        const claimed = yield* repo.claim(worktreeId, "executor-1");
        const channel = yield* CaptureChannel;
        const api = channel.apiFor({
          worktreeId,
          projectId: PROJECT,
          executorId: "executor-1",
          footprintBytes: 0,
        });
        // The executor registers its capture through the channel, exactly as sealantd does.
        yield* api.register({
          worktree_id: worktreeId,
          epoch: claimed.epoch,
          n: 0,
          parent: null,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        });
        return {
          cacheKeys: yield* listCache,
          cache: yield* readDependencyCache(PROJECT, PLATFORM),
        };
      }),
    );
    // Policy: a session capture never promotes.
    expect(registered.cacheKeys).toEqual([]);
    expect(registered.cache).toBeNull();
    const bulkPacks = [...memory.packs.values()].filter((pack) => pack.class === "bulk");
    expect(bulkPacks.every((pack) => pack.worktreeId === worktreeId)).toBe(true);

    // The install job promotes: packs copied by digest, trees re-keyed under the prefix.
    const promoted = await run(
      Effect.gen(function* () {
        const record = yield* promoteBulkToCache(PROJECT, built.id, built.manifest);
        const cache = yield* readDependencyCache(PROJECT, PLATFORM);
        const store = yield* BlobStore;
        const rootBytes = yield* store.get(record?.root ?? "");
        const root = yield* decodeDirObject(record?.root ?? "", rootBytes);
        const nodeModules = root.find((entry) => entry.name === "node_modules");
        const childKeys: Array<string> = [];
        let key = nodeModules?.child;
        while (key !== undefined) {
          childKeys.push(key);
          const entries = yield* decodeDirObject(key, yield* store.get(key));
          key = entries.find((entry) => entry.kind === "dir")?.child;
        }
        return { record, cache, cacheKeys: yield* listCache, childKeys };
      }),
    );
    expect(promoted.record?.platform).toBe(PLATFORM);
    expect(promoted.record?.capture_id).toBe(built.id);
    expect(promoted.cache).toEqual(promoted.record);
    expect(promoted.record?.root.startsWith(`${cachePrefix}trees/`)).toBe(true);
    expect(promoted.record?.packs.every((key) => key.startsWith(`${cachePrefix}packs/`))).toBe(
      true,
    );
    expect(promoted.record?.packs.length).toBe(snapshot.packs.length);
    // Every child a promoted tree names lives under the cache too — nothing points back into
    // the session's epoch prefix.
    expect(promoted.childKeys.length).toBeGreaterThan(0);
    expect(promoted.childKeys.every((key) => key.startsWith(`${cachePrefix}trees/`))).toBe(true);
    expect(promoted.cacheKeys).toEqual(
      expect.arrayContaining([`${cachePrefix}root.json`, ...(promoted.record?.packs ?? [])]),
    );
    // The cache is named by its record, not by pack rows: the session's rows are untouched and
    // none points into the cache.
    const rows = [...memory.packs.values()];
    expect(rows.filter((pack) => pack.class === "bulk").length).toBe(snapshot.packs.length);
    expect(rows.every((pack) => !pack.key.startsWith(cachePrefix))).toBe(true);
    // No cache for another platform.
    expect(await run(readDependencyCache(PROJECT, "linux-aarch64-musl"))).toBeNull();
    // A record written before dir packs reads as format 1, and splices as it always did.
    expect(promoted.record?.format).toBeUndefined();
    if (promoted.record === null || promoted.record === undefined) throw new Error("no record");
    expect(bulkSectionOfCache(promoted.record)).toEqual({
      root: promoted.record.root,
      packs: promoted.record.packs,
      platform: PLATFORM,
    });
  });

  it("serves a platform only a record of its own platform, and promotes a head's own bulk section, never one other_bulk carries", async () => {
    const x86 = "linux-x86_64-gnu";
    const arm = "linux-aarch64-gnu";
    const project = ProjectId.make("proj-cache-platforms");
    // A record naming x86's tree, found under the arm prefix, is not arm's cache.
    const misplaced = {
      root: "captures/w/1/trees/aa",
      packs: [],
      platform: x86,
      capture_id: "c".repeat(64),
      promoted_at: new Date(0).toISOString(),
    };
    const read = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put(
          `${dependencyCachePrefix(project, arm)}root.json`,
          new Uint8Array(Buffer.from(JSON.stringify(misplaced), "utf8")),
        );
        yield* store.put(
          `${dependencyCachePrefix(project, x86)}root.json`,
          new Uint8Array(Buffer.from("{not json", "utf8")),
        );
        return {
          arm: yield* readDependencyCache(project, arm),
          x86: yield* readDependencyCache(project, x86),
        };
      }),
    );
    expect(read).toEqual({ arm: null, x86: null });

    // An install session's head built x86 and carries an arm tree from elsewhere: only x86 is
    // promoted, into x86's prefix; the arm prefix keeps what it had.
    const worktreeId = WorktreeId.make("wt-install-platforms");
    const { snapshot, built } = bulkCapture(worktreeId, 5, 0, null);
    const carrying = buildManifest({
      worktreeId,
      n: 0,
      parent: null,
      epoch: 5,
      kind: "final",
      bulk: { ...sectionOf(snapshot), platform: x86 },
      otherBulk: {
        [arm]: { root: "captures/w/1/trees/bb", packs: ["captures/w/1/packs/cc"], platform: arm },
      },
    });
    const promoted = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const record = yield* promoteBulkToCache(project, carrying.id, carrying.manifest);
        const store = yield* BlobStore;
        return {
          record,
          x86: yield* readDependencyCache(project, x86),
          armKeys: (yield* store.list(dependencyCachePrefix(project, arm))).map(
            (entry) => entry.key,
          ),
        };
      }),
    );
    expect(promoted.record?.platform).toBe(x86);
    expect(promoted.x86).toEqual(promoted.record);
    expect(promoted.armKeys).toEqual([`${dependencyCachePrefix(project, arm)}root.json`]);

    // A head with no tree of its own promotes nothing, whatever other_bulk carries.
    const onlyCarried = buildManifest({
      worktreeId,
      n: 1,
      parent: carrying.id,
      epoch: 5,
      otherBulk: { [x86]: { ...sectionOf(snapshot), platform: x86 } },
    });
    expect(await run(promoteBulkToCache(project, onlyCarried.id, onlyCarried.manifest))).toBeNull();
  });

  it("a format-2 bulk section promotes by copying its dir packs, keeps its root digest, and restores from the cache alone", async () => {
    const platform = "linux-aarch64-gnu";
    const worktreeId = WorktreeId.make("wt-install-v2");
    const tree = path.join(scratch, "bulk-v2");
    fs.mkdirSync(path.join(tree, "node_modules", "pkg", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tree, "node_modules", "pkg", "lib", "index.js"), "exports.v = 2;\n");
    fs.symlinkSync("pkg/lib/index.js", path.join(tree, "node_modules", "entry.js"));
    const sessionBlobs = path.join(scratch, "session-v2-blobs");
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, 4), {
      chunkSize: 64,
      format: 2,
      dirPackBudget: 2,
    });
    expect(snapshot.dirPacks.length).toBeGreaterThan(1);
    const built = buildManifest({
      worktreeId,
      n: 3,
      parent: null,
      epoch: 4,
      kind: "final",
      bulk: { ...sectionOf(snapshot), platform },
    });
    const cachePrefix = dependencyCachePrefix(PROJECT, platform);
    const promoted = await run(
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        const record = yield* promoteBulkToCache(PROJECT, built.id, built.manifest);
        return { record, cache: yield* readDependencyCache(PROJECT, platform) };
      }),
    );
    const record = promoted.record;
    if (record === null) throw new Error("nothing promoted");
    expect(promoted.cache).toEqual(record);
    expect(record.format).toBe(2);
    expect(record.root).toBe(snapshot.root);
    expect(record.dir_packs?.length).toBe(snapshot.dirPacks.length);
    for (const key of [...record.packs, ...(record.dir_packs ?? [])]) {
      expect(key.startsWith(`${cachePrefix}packs/`)).toBe(true);
    }
    // No dir object was re-keyed or written on its own: the cache holds packs and its record.
    const cacheKeys = await run(
      Effect.flatMap(BlobStore, (store) => store.list(cachePrefix)).pipe(
        Effect.map((entries) => entries.map((entry) => entry.key)),
      ),
    );
    expect(cacheKeys.some((key) => key.includes("/trees/"))).toBe(false);
    // The plan splice carries the format and the dir packs; a standby's plan presigns them.
    const section = bulkSectionOfCache(record);
    expect(section).toEqual({
      root: snapshot.root,
      packs: record.packs,
      platform,
      format: 2,
      dir_packs: record.dir_packs,
    });
    const standby = buildManifest({
      worktreeId: "standby",
      n: 0,
      parent: null,
      epoch: 9,
      bulk: section,
    }).manifest;
    const keys = await run(keysNeededBy(standby));
    expect(keys.toSorted()).toEqual([...record.packs, ...(record.dir_packs ?? [])].toSorted());
    // The cache restores without the session's objects: copy only the cache prefix elsewhere.
    fs.mkdirSync(path.join(sessionBlobs, path.dirname(cachePrefix)), { recursive: true });
    fs.cpSync(path.join(blobRoot, cachePrefix), path.join(sessionBlobs, cachePrefix), {
      recursive: true,
    });
    const target = path.join(scratch, "restored-v2");
    await Effect.runPromise(
      materialize(standby, "bulk", target).pipe(Effect.provide(BlobStoreFsLive(sessionBlobs))),
    );
    expect(
      fs.readFileSync(path.join(target, "node_modules", "pkg", "lib", "index.js"), "utf8"),
    ).toBe("exports.v = 2;\n");
    expect(fs.readlinkSync(path.join(target, "node_modules", "entry.js"))).toBe("pkg/lib/index.js");
  });
});
