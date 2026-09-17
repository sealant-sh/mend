import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import { BlobStore, BlobStoreFsLive, captureKeys, decodeDirObject } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureUploadPolicyDefault,
  planForPlatform,
} from "../src/capture-channel.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifierOff } from "../src/capture-verify.ts";
import {
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
  });
});
