import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import {
  BlobStore,
  BlobStoreFsLive,
  BlobStoreS3Live,
  resolveBlobStoreConfig,
  INDEX_TREE_REF,
  WORKTREE_TREE_REF,
  captureKeys,
  isCaptureObjectKey,
  readCaptureFileBytes,
  packIdxKeyOf,
  sha256Hex,
  stringifyExact,
} from "@mend/store";
import {
  buildManifest,
  sectionOf,
  snapshotDirectory,
  uploadObjects,
  writeCdcPack,
} from "@mend/store/testing";
import { Effect, Exit, Layer, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  MANIFEST_FEATURES,
  PRESIGN_TTL_SECONDS,
  type SessionCaptureApi,
  UPLOAD_ANSWER_PRESENT,
} from "../src/capture-channel.ts";
import {
  CaptureSeals,
  CaptureSealsStoreLive,
  makeCaptureSealsStore,
} from "../src/capture-seals.ts";
import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WorktreeReads, WorktreeReadsCapturedLive } from "../src/worktree-reads.ts";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  sh,
  worktreeRowFor,
} from "./capture-world.ts";

/**
 * Mend's verification of a capture's git section (ADR-0002 "Replacement and pickup", decision
 * 16). The failure observed on the cluster, reproduced by hand: an executor's pack holds the
 * root tree and the new blob but not the new subtree the root names, and the manifest still
 * claims `fsck: "verified"`. Register must record `failed`, the plan must restore the newest
 * capture that verifies under the unchanged head, and reads must come from it, stamped.
 */

/**
 * A commit that adds `sub/x.txt`, packed WITHOUT the `sub` tree: `pack-objects` over an
 * explicit object list (commit, root tree, blob) instead of `--revs`. `index-pack --verify`
 * passes — the pack is internally sound — and only a connectivity walk finds the hole.
 */
const packWithoutSubtree = (work: string, worktreeId: string, epoch: number, baseSha: string) => {
  sh(work, ["checkout", "-q", "-B", "scratch", baseSha]);
  fs.mkdirSync(path.join(work, "sub"), { recursive: true });
  fs.writeFileSync(path.join(work, "sub", "x.txt"), "inside a subtree\n");
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", "subtree edit"]);
  const commit = sh(work, ["rev-parse", "HEAD"]);
  const tree = sh(work, ["rev-parse", "HEAD^{tree}"]);
  const blob = sh(work, ["rev-parse", "HEAD:sub/x.txt"]);
  const subtree = sh(work, ["rev-parse", "HEAD:sub"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-partial-pack-"));
  const name = sh(
    work,
    ["pack-objects", "-q", path.join(out, "p")],
    `${commit}\n${tree}\n${blob}\n`,
  );
  const pack = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
  const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
  fs.rmSync(out, { recursive: true, force: true });
  const key = captureKeys(worktreeId, epoch).pack(sha256Hex(pack));
  return {
    tree,
    subtree,
    key,
    objects: new Map<string, Uint8Array>([
      [key, pack],
      [packIdxKeyOf(key), idx],
    ]),
  };
};

const packsOf = (sections: unknown): ReadonlyArray<string> =>
  (sections as { git: { packs: ReadonlyArray<string> } }).git.packs;
const refsOf = (sections: unknown): Readonly<Record<string, string>> =>
  (sections as { git: { refs: Readonly<Record<string, string>> } }).git.refs;

describe("capture git verification", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services = SessionRepository | WorktreeReads | CaptureStoreRepo | CaptureChannel | BlobStore;
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));
  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  it(
    "records `failed` for a pack that omits a tree it names, plans and reads the newest verified capture under the unchanged head, and verifies an `auto` head at the plan that would restore it",
    { timeout: 60_000 },
    async () => {
      const worktreeId = newWorktreeId();
      const branch = `mend/wt/${worktreeId}`;
      world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.createWorktree(
            world.project.id,
            { directory: worktreeId, branch },
            null,
            null,
          );
          yield* repo.attachWorktree!(world.project.id, worktreeId);
        }),
      );
      const cap0Id = world.memory.chains.get(worktreeId)?.headCapture ?? "";
      const cap0 = world.memory.captures.get(cap0Id);
      if (cap0 === undefined) throw new Error("capture 0 did not register");
      expect(cap0.gitFsck).toBe("verified");
      const basePack = packsOf(cap0.sections)[0] ?? "";
      const baseTree = refsOf(cap0.sections)[WORKTREE_TREE_REF] ?? "";
      // The executor claims the worktree; the routes are its own, scoped to this worktree.
      const { epoch, api } = await run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          const claimed = yield* captures.claim(worktreeId, "executor-1", 300);
          const channel = yield* CaptureChannel;
          const routes: SessionCaptureApi = channel.apiFor({
            worktreeId,
            projectId: world.project.id,
            executorId: "executor-1",
            footprintBytes: 0,
          });
          return { epoch: claimed.epoch, api: routes };
        }),
      );
      const gitSection = (packs: ReadonlyArray<string>, tree: string) => ({
        packs,
        refs: {
          [`refs/heads/${branch}`]: world.baseSha,
          [WORKTREE_TREE_REF]: tree,
          [INDEX_TREE_REF]: tree,
        },
        head: `refs/heads/${branch}`,
        // The executor's claim, which Mend records nothing from.
        fsck: "verified" as const,
      });
      const register = (built: ReturnType<typeof buildManifest>) =>
        api.register({
          worktree_id: worktreeId,
          epoch,
          n: built.manifest.n,
          parent: built.manifest.parent,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        });

      // 1. A `turn` capture whose pack lacks the subtree its root names: accepted, marked.
      const partial = packWithoutSubtree(world.work, worktreeId, epoch, world.baseSha);
      const cap1 = buildManifest({
        worktreeId,
        n: 1,
        parent: cap0Id,
        epoch,
        seq: 10,
        kind: "turn",
        git: gitSection([basePack, partial.key], partial.tree),
      });
      await run(uploadObjects(new Map([...partial.objects, [cap1.key, cap1.bytes]])));
      const landed = await run(register(cap1));
      expect(landed.head_n).toBe(1);
      expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("failed");
      expect(world.memory.chains.get(worktreeId)?.headCapture).toBe(cap1.id);

      // The plan keeps the head's identity (the next register parents on it) and restores
      // capture 0's git section — the newest that verifies — under it. The broken pack is not
      // presigned; every URL names a capture object.
      const plan1 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan1.head?.n).toBe(1);
      expect(plan1.head?.capture_id).toBe(cap1.id);
      expect(plan1.head?.manifest.sections.git.packs).toEqual([basePack]);
      expect(plan1.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(baseTree);
      expect(Object.keys(plan1.get_urls)).not.toContain(partial.key);
      expect(Object.keys(plan1.get_urls).every(isCaptureObjectKey)).toBe(true);

      // Reads route around it too: capture 0's tree, stamped as capture 0.
      const read1 = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          return yield* reads.worktreeMatchesCommit(world.project.id, worktreeId, world.baseSha);
        }),
      );
      expect(read1.value).toBe(true);
      expect(read1.stamp.captureN).toBe(0);

      // 2. A complete pack on top verifies, and the plan and the reads are its own again.
      const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
      });
      const cap2 = buildManifest({
        worktreeId,
        n: 2,
        parent: cap1.id,
        epoch,
        seq: 20,
        kind: "turn",
        git: gitSection([basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([...edited.objects, [cap2.key, cap2.bytes]])));
      expect((await run(register(cap2))).head_n).toBe(2);
      expect(world.memory.captures.get(cap2.id)?.gitFsck).toBe("verified");
      const plan2 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan2.head?.n).toBe(2);
      expect(plan2.head?.manifest.sections.git.packs).toEqual([basePack, edited.key]);
      expect(plan2.get_urls[edited.key]).toMatch(/^file:\/\//);
      const read2 = await run(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          return yield* reads.diffWorktree(world.project.id, worktreeId, world.baseSha);
        }),
      );
      expect(read2.value).toContain("+three");
      expect(read2.stamp.captureN).toBe(2);

      // 3. An `auto` capture lands `unverified` (never the executor's claim); the plan that
      //    would restore it verifies it then, once, and records what it saw.
      const cap3 = buildManifest({
        worktreeId,
        n: 3,
        parent: cap2.id,
        epoch,
        seq: 30,
        kind: "auto",
        git: gitSection([basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([[cap3.key, cap3.bytes]])));
      expect((await run(register(cap3))).head_n).toBe(3);
      expect(world.memory.captures.get(cap3.id)?.gitFsck).toBe("unverified");
      const plan3 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan3.head?.n).toBe(3);
      expect(plan3.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(edited.tree);
      expect(world.memory.captures.get(cap3.id)?.gitFsck).toBe("verified");
    },
  );
});

/** A bulk class captured and empty: ready, naming nothing (never `"pending"`). */
const READY_EMPTY_BULK = { root: "", packs: [], platform: "linux-x86_64-glibc" };

/** A workspace section holding only a worktree metadata document. */
const withMeta = (worktreeId: string, epoch: number, document: object) => {
  const bytes = new Uint8Array(Buffer.from(stringifyExact(document)));
  const content = writeCdcPack([bytes]);
  const contentKey = captureKeys(worktreeId, epoch).pack(sha256Hex(content.bytes));
  return {
    objects: new Map([[contentKey, content.bytes]]),
    workspace: {
      root: "",
      packs: [contentKey],
      worktree_meta: {
        format: 1,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        chunks: [sha256Hex(bytes)],
        packs: [contentKey],
      },
    },
  };
};

/** `built`'s manifest carrying `final_seal` for `executor-1`, as bytes under its own key. */
const sealing = (worktreeId: string, epoch: number, built: ReturnType<typeof buildManifest>) => {
  const manifest = {
    ...built.manifest,
    final_seal: { complete: true, epoch, executor: "executor-1" },
  };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  const id = sha256Hex(bytes);
  return { manifest, bytes, id, key: captureKeys(worktreeId, epoch).manifest(id) };
};

const registerOn =
  (worktreeId: string, epoch: number, api: SessionCaptureApi) =>
  (built: {
    readonly manifest: ReturnType<typeof buildManifest>["manifest"];
    readonly id: string;
    readonly key: string;
  }) =>
    api.register({
      worktree_id: worktreeId,
      epoch,
      n: built.manifest.n,
      parent: built.manifest.parent,
      capture_id: built.id,
      manifest_key: built.key,
      manifest: JSON.parse(JSON.stringify(built.manifest)),
    });

/**
 * What a seal may rest on (review 2026-09-28 (3) #18 and #20): register records `final_seal` only
 * once Mend observed every section restore — the git section verified, the worktree metadata
 * document checked against the worktree tree it applies to — and a plan that restores other git
 * state than the head's carries no seal.
 */
describe("a seal rests only on sections Mend observed restore", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services = SessionRepository | CaptureStoreRepo | CaptureChannel | BlobStore;
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));
  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  /** A worktree with capture 0 registered and claimed by `executor-1`; its routes. */
  const claimedWorktree = async () => {
    const worktreeId = newWorktreeId();
    const branch = `mend/wt/${worktreeId}`;
    world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.createWorktree(world.project.id, { directory: worktreeId, branch }, null, null);
        yield* repo.attachWorktree!(world.project.id, worktreeId);
      }),
    );
    const cap0Id = world.memory.chains.get(worktreeId)?.headCapture ?? "";
    const cap0 = world.memory.captures.get(cap0Id);
    if (cap0 === undefined) throw new Error("capture 0 did not register");
    const { epoch, api } = await run(
      Effect.gen(function* () {
        const captures = yield* CaptureStoreRepo;
        const claimed = yield* captures.claim(worktreeId, "executor-1", 300);
        const routes: SessionCaptureApi = (yield* CaptureChannel).apiFor({
          worktreeId,
          projectId: world.project.id,
          executorId: "executor-1",
          footprintBytes: 0,
        });
        return { epoch: claimed.epoch, api: routes };
      }),
    );
    const gitSection = (packs: ReadonlyArray<string>, tree: string) => ({
      packs,
      refs: {
        [`refs/heads/${branch}`]: world.baseSha,
        [WORKTREE_TREE_REF]: tree,
        [INDEX_TREE_REF]: tree,
      },
      head: `refs/heads/${branch}`,
      fsck: "verified" as const,
    });
    return {
      worktreeId,
      epoch,
      api,
      cap0Id,
      basePack: packsOf(cap0.sections)[0] ?? "",
      baseTree: refsOf(cap0.sections)[WORKTREE_TREE_REF] ?? "",
      gitSection,
    };
  };

  const sealOf = (worktreeId: WorktreeId, epoch: number) =>
    run(
      Effect.flatMap(CaptureStoreRepo, (repo) =>
        repo.sealedCompletion(worktreeId, "executor-1", epoch),
      ),
    );

  it(
    "#18 a sealing capture whose git section fails verification registers and seals nothing; the plan that restores older git carries no seal",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const partial = packWithoutSubtree(world.work, at.worktreeId, at.epoch, world.baseSha);
      const cap1 = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          n: 1,
          parent: at.cap0Id,
          epoch: at.epoch,
          seq: 10,
          kind: "final",
          git: at.gitSection([at.basePack, partial.key], partial.tree),
        }),
      );
      await run(uploadObjects(new Map([...partial.objects, [cap1.key, cap1.bytes]])));
      expect((await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1))).head_n).toBe(1);
      expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("failed");
      expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
      const plan = await run(
        at.api.planGet({ epoch: at.epoch, manifest_format: 2, manifest_features: ["final_seal"] }),
      );
      expect(plan.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(at.baseTree);
      expect(plan.head?.manifest.final_seal).toBeUndefined();
    },
  );

  it(
    "review 4 #12 a closure only another capture's pack completes never verifies: the manifest's listed packs alone must hold it, and nothing is sealed",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "only-in-warm-cache.txt"), "unique work in omitted pack\n");
      });
      // A turn lists the pack that holds the new tree: it verifies, and warms the runner cache.
      const first = buildManifest({
        worktreeId: at.worktreeId,
        n: 1,
        parent: at.cap0Id,
        epoch: at.epoch,
        seq: 10,
        kind: "turn",
        git: at.gitSection([at.basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([...edited.objects, [first.key, first.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(first));
      expect(world.memory.captures.get(first.id)?.gitFsck).toBe("verified");
      // The sealing final names the same tree but lists only the base pack.
      const sealed = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          n: 2,
          parent: first.id,
          epoch: at.epoch,
          seq: 20,
          kind: "final",
          git: at.gitSection([at.basePack], edited.tree),
        }),
      );
      await run(uploadObjects(new Map([[sealed.key, sealed.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(sealed));
      // What a fresh restore sees — a bare repository holding the listed packs — lacks the tree.
      const cold = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cold-restore-"));
      sh(cold, ["init", "-q", "--bare"]);
      const packDir = path.join(cold, "objects", "pack");
      fs.mkdirSync(packDir, { recursive: true });
      for (const key of sealed.manifest.sections.git.packs) {
        const digest = path.basename(key);
        fs.copyFileSync(path.join(world.blobRoot, key), path.join(packDir, `pack-${digest}.pack`));
        fs.copyFileSync(
          path.join(world.blobRoot, packIdxKeyOf(key)),
          path.join(packDir, `pack-${digest}.idx`),
        );
      }
      expect(() => sh(cold, ["rev-list", "--objects", "--missing=error", edited.tree])).toThrow();
      fs.rmSync(cold, { recursive: true, force: true });
      // Mend observes the same: failed, and no seal.
      expect(world.memory.captures.get(sealed.id)?.gitFsck).toBe("failed");
      expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
    },
  );

  it(
    "#18 a sealing capture whose git section verifies is sealed, and its plan keeps the seal",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), "sealed\n");
      });
      const cap1 = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          n: 1,
          parent: at.cap0Id,
          epoch: at.epoch,
          seq: 10,
          kind: "final",
          git: at.gitSection([at.basePack, edited.key], edited.tree),
          bulk: READY_EMPTY_BULK,
        }),
      );
      await run(uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
      expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("verified");
      expect((await sealOf(at.worktreeId, at.epoch))?.captureId).toBe(cap1.id);
      const plan = await run(
        at.api.planGet({ epoch: at.epoch, manifest_format: 2, manifest_features: ["final_seal"] }),
      );
      expect(plan.head?.manifest.final_seal?.complete).toBe(true);
    },
  );

  it(
    "#20 worktree metadata that names a file or a symlink the worktree tree does not hold, as that kind, is refused; one that matches it is sealed",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "kept.txt"), "tracked work\n");
      });
      const git = at.gitSection([at.basePack, edited.key], edited.tree);
      const ns = 1_790_544_318_479_764_000;
      const attempt = async (entries: ReadonlyArray<object>, n: number, parent: string) => {
        const meta = withMeta(at.worktreeId, at.epoch, { format: 1, entries });
        const built = sealing(
          at.worktreeId,
          at.epoch,
          buildManifest({
            worktreeId: at.worktreeId,
            n,
            parent,
            epoch: at.epoch,
            seq: 10 + n,
            kind: "final",
            git,
            workspace: meta.workspace,
            bulk: READY_EMPTY_BULK,
          }),
        );
        await run(
          uploadObjects(new Map([...edited.objects, ...meta.objects, [built.key, built.bytes]])),
        );
        const said = await run(
          registerOn(
            at.worktreeId,
            at.epoch,
            at.api,
          )(built).pipe(
            Effect.as("ok"),
            Effect.catch((error) => Effect.succeed(`${error.reason}: ${error.message}`)),
          ),
        );
        return { said, id: built.id };
      };
      const root = { path: "", kind: "dir", mode: 0o755, mtime: ns };
      const missing = await attempt(
        [root, { path: "missing-work.txt", kind: "file", mode: 0o644, mtime: ns }],
        1,
        at.cap0Id,
      );
      expect(missing.said).toMatch(
        /^unrestorable: .*missing-work\.txt.*absent from the tree the restore checks out/,
      );
      const wrongKind = await attempt(
        [root, { path: "kept.txt", kind: "symlink", mtime: ns }],
        1,
        at.cap0Id,
      );
      expect(wrongKind.said).toMatch(
        /^unrestorable: .*kept\.txt.*a file in the tree the restore checks out/,
      );
      const dirOverFile = await attempt(
        [root, { path: "kept.txt", kind: "dir", mode: 0o755, mtime: ns }],
        1,
        at.cap0Id,
      );
      expect(dirOverFile.said).toMatch(/^unrestorable: /);
      expect(world.memory.chains.get(at.worktreeId)?.headCapture).toBe(at.cap0Id);
      const matching = await attempt(
        [
          root,
          { path: "kept.txt", kind: "file", mode: 0o600, mtime: ns },
          { path: "untracked-empty", kind: "dir", mode: 0o700, mtime: ns },
        ],
        1,
        at.cap0Id,
      );
      expect(matching.said).toBe("ok");
      expect((await sealOf(at.worktreeId, at.epoch))?.captureId).toBe(matching.id);
    },
  );

  it(
    "review 5 #9 a store ref the listed packs hold bounds the walk only once its whole closure is in them: a pack missing an unchanged blob below the base fails, and seals nothing",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      sh(world.work, ["checkout", "-q", "-B", "boundary", world.baseSha]);
      fs.writeFileSync(path.join(world.work, "a.txt"), "new user work\n");
      sh(world.work, ["add", "-A"]);
      sh(world.work, ["commit", "-q", "-m", "newer"]);
      const commit = sh(world.work, ["rev-parse", "HEAD"]);
      const tree = sh(world.work, ["rev-parse", "HEAD^{tree}"]);
      // The base commit and tree are in the pack; the unchanged blob a checkout needs is not.
      const missing = sh(world.work, ["rev-parse", `${world.baseSha}:keep.md`]);
      const ids = sh(world.work, ["rev-list", "--objects", "--no-object-names", commit])
        .split("\n")
        .filter((id) => id !== "" && id !== missing);
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-boundary-pack-"));
      const name = sh(
        world.work,
        ["pack-objects", "-q", path.join(out, "p")],
        `${ids.join("\n")}\n`,
      );
      const pack = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
      const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
      const key = captureKeys(at.worktreeId, at.epoch).pack(sha256Hex(pack));
      const sealed = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          n: 1,
          parent: at.cap0Id,
          epoch: at.epoch,
          seq: 10,
          kind: "final",
          git: {
            packs: [key],
            refs: { "refs/heads/main": commit, [WORKTREE_TREE_REF]: tree, [INDEX_TREE_REF]: tree },
            head: "refs/heads/main",
            fsck: "verified",
          },
          bulk: READY_EMPTY_BULK,
        }),
      );
      await run(
        uploadObjects(
          new Map([
            [key, pack],
            [packIdxKeyOf(key), idx],
            [sealed.key, sealed.bytes],
          ]),
        ),
      );
      await run(registerOn(at.worktreeId, at.epoch, at.api)(sealed));
      // A cold repository holding exactly that pack cannot check the tree out.
      const cold = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cold-boundary-"));
      sh(cold, ["init", "-q", "--bare"]);
      fs.copyFileSync(
        path.join(out, `p-${name}.pack`),
        path.join(cold, "objects", "pack", `pack-${name}.pack`),
      );
      fs.copyFileSync(
        path.join(out, `p-${name}.idx`),
        path.join(cold, "objects", "pack", `pack-${name}.idx`),
      );
      expect(() => sh(cold, ["rev-list", "--objects", "--missing=error", commit])).toThrow();
      fs.rmSync(cold, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
      expect(world.memory.captures.get(sealed.id)?.gitFsck).toBe("failed");
      expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
    },
  );

  it("review 5 #10 a final seal over a manifest whose bulk class is still pending is registered without the seal", async () => {
    const at = await claimedWorktree();
    const built = sealing(
      at.worktreeId,
      at.epoch,
      buildManifest({
        worktreeId: at.worktreeId,
        n: 1,
        parent: at.cap0Id,
        epoch: at.epoch,
        kind: "final",
        git: at.gitSection([at.basePack], at.baseTree),
      }),
    );
    expect(built.manifest.sections.bulk).toBe("pending");
    await run(uploadObjects(new Map([[built.key, built.bytes]])));
    expect((await run(registerOn(at.worktreeId, at.epoch, at.api)(built))).head_n).toBe(1);
    expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
    // The same capture with its bulk class captured (empty, and so ready) is sealed.
    const ready = sealing(
      at.worktreeId,
      at.epoch,
      buildManifest({
        worktreeId: at.worktreeId,
        n: 2,
        parent: built.id,
        epoch: at.epoch,
        kind: "final",
        git: at.gitSection([at.basePack], at.baseTree),
        bulk: READY_EMPTY_BULK,
      }),
    );
    await run(uploadObjects(new Map([[ready.key, ready.bytes]])));
    await run(registerOn(at.worktreeId, at.epoch, at.api)(ready));
    expect((await sealOf(at.worktreeId, at.epoch))?.captureId).toBe(ready.id);
  });

  // Review 2026-09-28 (7) #7 (the reviewer's reproduction): `present` was answered to every
  // executor, and a daemon from before it (sealantd f0bf279) ignores the field and fails `NoUrl`
  // on every retry — a retained old disk whose upload landed but whose answer was lost could never
  // finish. `present` is negotiated: only a launch whose `plan.get` listed it in `upload_answers`
  // gets it; any other gets a write-once URL for the stored key, once its bytes are verified.
  it("review 7 #7 a stored key is answered present only to a launch that said it reads it; an older daemon gets a write-once URL", async () => {
    const at = await claimedWorktree();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-present-negotiated-"));
    fs.mkdirSync(path.join(dir, "tree"));
    fs.writeFileSync(path.join(dir, "tree", "landed.txt"), "uploaded, answer lost\n");
    const snapshot = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), { format: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
    await run(uploadObjects(snapshot.objects));
    const key = snapshot.packs[0] ?? "";
    const size = snapshot.objects.get(key)?.length ?? 0;
    const ask = () =>
      run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [key],
          sizes: { [key]: size },
        }),
      );
    const plan = (uploadAnswers?: ReadonlyArray<string>) =>
      run(
        at.api.planGet({
          epoch: at.epoch,
          manifest_format: 2,
          manifest_features: [...MANIFEST_FEATURES],
          ...(uploadAnswers === undefined ? {} : { upload_answers: uploadAnswers }),
        }),
      );
    // No plan seen by this process (a restart), then a plan without `upload_answers` (every
    // daemon before it): a URL, as the older daemon requires — never `present`.
    for (const before of [async () => undefined, async () => plan()]) {
      await before();
      const legacy = await ask();
      expect(legacy.present ?? []).toEqual([]);
      expect(typeof legacy.urls[key]).toBe("string");
    }
    // A plan that lists it: `present`, no URL.
    await plan([UPLOAD_ANSWER_PRESENT]);
    const negotiated = await ask();
    expect(negotiated.present).toEqual([key]);
    expect(negotiated.urls[key]).toBeUndefined();
    expect(negotiated.multipart[key]).toBeUndefined();
    // The same launch planning again without it (a daemon downgraded in place): the legacy
    // answer again.
    await plan([]);
    expect(typeof (await ask()).urls[key]).toBe("string");
  });

  // Review 2026-09-28 (6) #9, cross-repo decision 19 (the reviewer's reproduction): a sealed
  // pack's key was answered with another PUT URL, the bytes replaced at the same length through
  // it, and a second seal accepted on the warm cache though the saved file no longer read.
  it("review 6 #9 a stored pack gets no upload URL (present), cannot be rewritten through its file:// URL, and a second seal over it still reads", async () => {
    const at = await claimedWorktree();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-write-once-pack-"));
    fs.mkdirSync(path.join(dir, "tree"));
    fs.writeFileSync(path.join(dir, "tree", "unique.txt"), "unique saved bytes\n");
    const snapshot = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), { format: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
    const build = (n: number, parent: string) =>
      sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n,
          parent,
          kind: "final",
          git: at.gitSection([at.basePack], at.baseTree),
          workspace: sectionOf(snapshot),
          bulk: READY_EMPTY_BULK,
        }),
      );
    const cap1 = build(1, at.cap0Id);
    await run(uploadObjects(new Map([...snapshot.objects, [cap1.key, cap1.bytes]])));
    await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
    expect((await sealOf(at.worktreeId, at.epoch))?.captureId).toBe(cap1.id);
    const key = snapshot.packs[0] ?? "";
    const original = snapshot.objects.get(key) ?? new Uint8Array();
    // An executor that reads `present` (review 2026-09-28 (7) #7: negotiated in `plan.get`).
    await run(
      at.api.planGet({
        epoch: at.epoch,
        manifest_format: 2,
        manifest_features: [...MANIFEST_FEATURES],
        upload_answers: [UPLOAD_ANSWER_PRESENT],
      }),
    );
    const answer = await run(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [key],
        sizes: { [key]: original.length },
      }),
    );
    expect(answer.urls[key]).toBeUndefined();
    expect(answer.multipart[key]).toBeUndefined();
    expect(answer.present).toEqual([key]);
    // The object's path is what a URL minted before it existed names: it is published read-only.
    if (process.getuid?.() !== 0) {
      const corrupted = Buffer.from(original);
      corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
      const stored = await run(
        Effect.flatMap(BlobStore, (store) => store.presign(key, "PUT", 60, original.length)),
      );
      expect(() => fs.writeFileSync(stored.slice("file://".length), corrupted)).toThrow(/EACCES/);
    }
    const cap2 = build(2, cap1.id);
    await run(uploadObjects(new Map([[cap2.key, cap2.bytes]])));
    await run(registerOn(at.worktreeId, at.epoch, at.api)(cap2));
    expect((await sealOf(at.worktreeId, at.epoch))?.captureId).toBe(cap2.id);
    const saved = await run(readCaptureFileBytes(cap2.manifest, "workspace", "tree/unique.txt"));
    expect(Buffer.from(saved).toString("utf8")).toBe("unique saved bytes\n");
  });

  // Review 2026-09-28 (7) #9 (the reviewer's reproduction): the worktree metadata was checked
  // against the worktree tree while the restore checks out the raw tree. A document naming a file
  // the raw tree does not hold cannot be applied, so it is refused like any other namespace miss.
  it("review 7 #9 a document naming a file the raw tree does not hold is refused, never sealed", async () => {
    const at = await claimedWorktree();
    const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) => {
      fs.unlinkSync(path.join(work, "a.txt"));
    });
    const meta = withMeta(at.worktreeId, at.epoch, {
      format: 1,
      entries: [{ path: "a.txt", kind: "file", mode: 0o644, mtime: 0 }],
    });
    const cap = sealing(
      at.worktreeId,
      at.epoch,
      buildManifest({
        worktreeId: at.worktreeId,
        n: 1,
        parent: at.cap0Id,
        epoch: at.epoch,
        seq: 21,
        kind: "final",
        git: { ...at.gitSection([at.basePack, edited.key], at.baseTree), raw_tree: edited.tree },
        workspace: meta.workspace,
        bulk: READY_EMPTY_BULK,
      }),
    );
    await run(uploadObjects(new Map([...edited.objects, ...meta.objects, [cap.key, cap.bytes]])));
    expect(sh(world.work, ["ls-tree", "-r", edited.tree])).not.toContain("a.txt");
    const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)(cap).pipe(Effect.flip));
    expect(answer.reason).toBe("unrestorable");
    expect(answer.message).toContain("tree the restore checks out");
    expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
  });

  // Review 2026-09-28 (8) #8 (the reviewer's reproductions): the namespace check read a class only
  // for a path the raw tree did not hold, and let the raw tree win — but the restore writes the
  // workspace class over the checkout. And a directory the document named was accepted below a
  // file. The namespace is the restore's own: the workspace class over the raw tree, the bulk
  // class where neither holds the path, and every ancestor of a path the document names a
  // directory (or absent, for a directory it creates).
  describe("review 8 #8 the metadata is checked against the namespace the restore lays down", () => {
    const attempt = async (options: {
      readonly edit: (work: string) => void;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly kind: "file" | "symlink" | "dir";
        readonly mode: number;
        readonly mtime: number;
      }>;
      readonly overlay?: (tree: string) => void;
    }) => {
      const at = await claimedWorktree();
      const edit = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, options.edit);
      const meta = withMeta(at.worktreeId, at.epoch, { format: 1, entries: options.entries });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-overlay-"));
      fs.mkdirSync(path.join(dir, "tree"));
      options.overlay?.(path.join(dir, "tree"));
      const overlay = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), { format: 2 });
      fs.rmSync(dir, { recursive: true, force: true });
      const workspace =
        options.overlay === undefined
          ? meta.workspace
          : {
              ...sectionOf(overlay),
              packs: [...overlay.packs, ...meta.workspace.packs],
              worktree_meta: meta.workspace.worktree_meta,
            };
      const cap = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n: 1,
          parent: at.cap0Id,
          kind: "final",
          git: { ...at.gitSection([at.basePack, edit.key], edit.tree), raw_tree: edit.tree },
          workspace,
          bulk: READY_EMPTY_BULK,
        }),
      );
      await run(
        uploadObjects(
          new Map([
            ...edit.objects,
            ...(options.overlay === undefined ? [] : overlay.objects),
            ...meta.objects,
            [cap.key, cap.bytes],
          ]),
        ),
      );
      const answer = await run(
        registerOn(
          at.worktreeId,
          at.epoch,
          at.api,
        )(cap).pipe(
          Effect.map(() => null),
          Effect.flip,
          Effect.orElseSucceed(() => null),
        ),
      );
      return { answer, seal: await sealOf(at.worktreeId, at.epoch), cap };
    };
    const userFile = (work: string) => fs.writeFileSync(path.join(work, "a.txt"), "user file\n");

    it("a raw file the workspace class replaces with a symlink is a symlink: a document saying file is refused", async () => {
      const { answer, seal } = await attempt({
        edit: userFile,
        entries: [{ path: "a.txt", kind: "file", mode: 0o644, mtime: 100 }],
        overlay: (tree) => fs.symlinkSync("elsewhere", path.join(tree, "a.txt")),
      });
      expect(answer?.reason).toBe("unrestorable");
      expect(answer?.message).toContain("a.txt");
      expect(seal).toBeNull();
    });

    it("a directory the document names below a raw file is refused", async () => {
      const { answer, seal } = await attempt({
        edit: userFile,
        entries: [
          { path: "a.txt", kind: "file", mode: 0o644, mtime: 100 },
          { path: "a.txt/empty", kind: "dir", mode: 0o755, mtime: 100 },
        ],
      });
      expect(answer?.reason).toBe("unrestorable");
      expect(answer?.message).toContain("a.txt/empty");
      expect(seal).toBeNull();
    });

    it("a raw file below a directory the workspace class replaces with a symlink is not there", async () => {
      const { answer, seal } = await attempt({
        edit: (work) => {
          fs.mkdirSync(path.join(work, "sub"), { recursive: true });
          fs.writeFileSync(path.join(work, "sub", "x.txt"), "inside\n");
        },
        entries: [{ path: "sub/x.txt", kind: "file", mode: 0o644, mtime: 100 }],
        overlay: (tree) => fs.symlinkSync("elsewhere", path.join(tree, "sub")),
      });
      expect(answer?.reason).toBe("unrestorable");
      expect(answer?.message).toContain("sub/x.txt");
      expect(seal).toBeNull();
    });

    it("the workspace class's symlink over a raw file, named a symlink, applies", async () => {
      const { answer } = await attempt({
        edit: userFile,
        entries: [{ path: "a.txt", kind: "symlink", mode: 0o777, mtime: 100 }],
        overlay: (tree) => fs.symlinkSync("elsewhere", path.join(tree, "a.txt")),
      });
      expect(answer).toBeNull();
    });
  });

  // Review 2026-09-28 (7) #10 (the reviewer's reproduction): a tracked hardlink group whose
  // members hold the same bytes but whose entries promise one inode two modes and two mtimes was
  // sealed; the restore can keep only one. Every connected inode group — tracked hardlinks,
  // shared links and cross-class links — must promise one mode and one mtime.
  it("review 7 #10 one inode promised two modes or two mtimes is never sealed", async () => {
    const at = await claimedWorktree();
    const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) =>
      fs.writeFileSync(path.join(work, "copy.txt"), "one\ntwo\n"),
    );
    let parent = at.cap0Id;
    let n = 0;
    const attempt = async (copy: { readonly mode: number; readonly mtime: number | bigint }) => {
      n += 1;
      const meta = withMeta(at.worktreeId, at.epoch, {
        format: 1,
        entries: [
          { path: "a.txt", kind: "file", mode: 0o644, mtime: 100 },
          { path: "copy.txt", kind: "file", ...copy },
          { path: "keep.md", kind: "file", mode: 0o644, mtime: 100 },
        ],
        hardlinks: [["a.txt", "copy.txt"]],
      });
      const built = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n,
          parent,
          seq: 30 + n,
          kind: "final",
          git: at.gitSection([at.basePack, edited.key], edited.tree),
          workspace: meta.workspace,
          bulk: READY_EMPTY_BULK,
        }),
      );
      await run(
        uploadObjects(new Map([...edited.objects, ...meta.objects, [built.key, built.bytes]])),
      );
      await run(registerOn(at.worktreeId, at.epoch, at.api)(built));
      parent = built.id;
      return (await sealOf(at.worktreeId, at.epoch))?.captureId === built.id;
    };
    // The reviewer's case: 0644 at 100 ns beside 0600 at 200 ns.
    expect(await attempt({ mode: 0o600, mtime: 200 })).toBe(false);
    // Only the mtime differs.
    expect(await attempt({ mode: 0o644, mtime: 200 })).toBe(false);
    // Nanoseconds beyond a double's 53 bits: two mtimes one apart are two promises.
    expect(await attempt({ mode: 0o644, mtime: 1790544318484764716n })).toBe(false);
    // One inode, one promise: sealed.
    expect(await attempt({ mode: 0o644, mtime: 100 })).toBe(true);
  });

  // Review 2026-09-28 (8) #9 (the reviewer's reproduction): a cross-class group joining a
  // workspace name at 0600 / 100 s and a bulk name at 0644 / 200 s, holding the same bytes, with no
  // tracked member: only tracked entries' promises were compared, so it sealed — and the restore
  // links both names to the first inode, breaking the bulk entry's promise. Every class entry a
  // link names promises its inode too.
  it("review 8 #9 cross-class names whose class entries promise one inode two modes or mtimes are never sealed", async () => {
    const at = await claimedWorktree();
    const keys = captureKeys(at.worktreeId, at.epoch);
    let parent = at.cap0Id;
    let n = 0;
    const attempt = async (bulkMode: number, bulkMtimeSeconds: number) => {
      n += 1;
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-cross-ws-"));
      const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-cross-bulk-"));
      fs.mkdirSync(path.join(workspaceDir, "harness"));
      fs.mkdirSync(path.join(bulkDir, "node_modules"));
      const one = path.join(workspaceDir, "harness", "state.json");
      const two = path.join(bulkDir, "node_modules", "state.json");
      fs.writeFileSync(one, "one inode's bytes\n");
      fs.writeFileSync(two, "one inode's bytes\n");
      fs.chmodSync(one, 0o600);
      fs.chmodSync(two, bulkMode);
      fs.utimesSync(one, 100, 100);
      fs.utimesSync(two, bulkMtimeSeconds, bulkMtimeSeconds);
      const workspace = snapshotDirectory(workspaceDir, keys, { format: 2 });
      const bulk = snapshotDirectory(bulkDir, keys, { format: 2 });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(bulkDir, { recursive: true, force: true });
      const meta = withMeta(at.worktreeId, at.epoch, {
        format: 1,
        entries: [],
        cross_links: [
          [
            { class: "workspace", member: "harness/state.json" },
            { class: "bulk", member: "node_modules/state.json" },
          ],
        ],
      });
      const built = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n,
          parent,
          seq: 100 + n,
          kind: "final",
          git: at.gitSection([at.basePack], at.baseTree),
          workspace: {
            ...sectionOf(workspace),
            packs: [...workspace.packs, ...meta.workspace.packs],
            worktree_meta: meta.workspace.worktree_meta,
          },
          bulk: { ...sectionOf(bulk), platform: "linux-x86_64-glibc" },
        }),
      );
      await run(
        uploadObjects(
          new Map([
            ...workspace.objects,
            ...bulk.objects,
            ...meta.objects,
            [built.key, built.bytes],
          ]),
        ),
      );
      const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)(built));
      parent = built.id;
      return {
        sealed: (await sealOf(at.worktreeId, at.epoch))?.captureId === built.id,
        answer,
      };
    };
    // The reviewer's case: both the mode and the mtime differ.
    const both = await attempt(0o644, 200);
    expect(both.sealed).toBe(false);
    expect(both.answer.seal).toEqual({ state: "refused", reason: "unrestorable" });
    // Only the mtime differs; only the mode differs.
    expect((await attempt(0o600, 200)).sealed).toBe(false);
    expect((await attempt(0o644, 100)).sealed).toBe(false);
    // One inode, one promise: sealed.
    expect((await attempt(0o600, 100)).sealed).toBe(true);
  });

  // Review 2026-09-28 (6) #10 (the reviewer's reproduction): a `shared` link to a member its class
  // does not carry, and a tracked `hardlinks` group whose members the checkout writes with other
  // bytes, were sealed. Every link is now checked against the tree the restore checks out and
  // the class that carries the other name; what restores seals.
  it(
    "review 6 #10 a final seal needs tracked hardlink groups one blob and every shared link a member of its class holding the tracked file's bytes",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const keys = captureKeys(at.worktreeId, at.epoch);
      const entries = [
        { path: "a.txt", kind: "file", mode: 0o644, mtime: 0 },
        { path: "keep.md", kind: "file", mode: 0o644, mtime: 0 },
      ];
      // A worktree tree with `copy.txt` holding a.txt's bytes: a group that restores.
      const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) => {
        fs.writeFileSync(path.join(work, "copy.txt"), "one\ntwo\n");
      });
      let parent = at.cap0Id;
      let n = 0;
      const attempt = async (
        links: object,
        options?: { readonly bulk?: string | null; readonly edited?: boolean },
      ) => {
        n += 1;
        const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shared-bulk-"));
        if (options?.bulk !== undefined && options.bulk !== null) {
          fs.mkdirSync(path.join(bulkDir, "node_modules"));
          const linked = path.join(bulkDir, "node_modules", "linked.txt");
          fs.writeFileSync(linked, options.bulk);
          // One inode with a.txt: its class entry promises what the tracked entry does (review
          // 2026-09-28 (8) #9).
          fs.chmodSync(linked, 0o644);
          fs.utimesSync(linked, 0, 0);
        }
        const bulk = snapshotDirectory(bulkDir, keys, { format: 2 });
        fs.rmSync(bulkDir, { recursive: true, force: true });
        const withCopy = options?.edited === true;
        const meta = withMeta(at.worktreeId, at.epoch, {
          format: 1,
          entries: withCopy
            ? [...entries, { path: "copy.txt", kind: "file", mode: 0o644, mtime: 0 }].toSorted(
                (a, b) => a.path.localeCompare(b.path),
              )
            : entries,
          ...links,
        });
        const built = sealing(
          at.worktreeId,
          at.epoch,
          buildManifest({
            worktreeId: at.worktreeId,
            n,
            parent,
            epoch: at.epoch,
            seq: 20 + n,
            kind: "final",
            git: withCopy
              ? at.gitSection([at.basePack, edited.key], edited.tree)
              : at.gitSection([at.basePack], at.baseTree),
            workspace: meta.workspace,
            bulk:
              options?.bulk === undefined || options.bulk === null
                ? READY_EMPTY_BULK
                : { ...sectionOf(bulk), platform: "linux-x86_64-glibc" },
          }),
        );
        await run(
          uploadObjects(
            new Map([
              ...(withCopy ? edited.objects : []),
              ...bulk.objects,
              ...meta.objects,
              [built.key, built.bytes],
            ]),
          ),
        );
        expect((await run(registerOn(at.worktreeId, at.epoch, at.api)(built))).head_n).toBe(n);
        expect(world.memory.captures.get(built.id)?.gitFsck).toBe("verified");
        parent = built.id;
        return (await sealOf(at.worktreeId, at.epoch))?.captureId === built.id;
      };
      const shared = {
        shared: [{ path: "a.txt", class: "bulk", member: "node_modules/linked.txt" }],
      };
      // The reviewer's two: a shared member the (empty) bulk class does not carry, and a tracked
      // group whose members the checkout writes with other bytes.
      expect(
        await attempt({
          shared: [{ path: "a.txt", class: "bulk", member: "node_modules/missing" }],
        }),
      ).toBe(false);
      expect(await attempt({ hardlinks: [["a.txt", "keep.md"]] })).toBe(false);
      // A shared member its class carries with other bytes than the tracked file.
      expect(await attempt(shared, { bulk: "other bytes\n" })).toBe(false);
      // What restores seals: the member holding a.txt's bytes, a group of one blob.
      expect(await attempt(shared, { bulk: "one\ntwo\n" })).toBe(true);
      expect(await attempt({ hardlinks: [["a.txt", "copy.txt"]] }, { edited: true })).toBe(true);
    },
  );

  it(
    "review 5 #11 a final seal needs every cross-class hardlink member a file of its class holding the same bytes: absent or differing members register without the seal",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const keys = captureKeys(at.worktreeId, at.epoch);
      // A workspace class holding `tree/ignored.bin`, and a bulk class with `node_modules/linked.bin`.
      const classes = (bulkBytes: string | null, bulkChunkSize?: number) => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cross-ws-"));
        fs.mkdirSync(path.join(workspaceDir, "tree"));
        fs.writeFileSync(path.join(workspaceDir, "tree", "ignored.bin"), "one inode's bytes\n");
        const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cross-bulk-"));
        fs.mkdirSync(path.join(bulkDir, "node_modules"));
        if (bulkBytes !== null) {
          fs.writeFileSync(path.join(bulkDir, "node_modules", "linked.bin"), bulkBytes);
        }
        const workspace = snapshotDirectory(workspaceDir, keys, { format: 2 });
        const bulk = snapshotDirectory(bulkDir, keys, {
          format: 2,
          ...(bulkChunkSize === undefined ? {} : { chunkSize: bulkChunkSize }),
        });
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(bulkDir, { recursive: true, force: true });
        return { workspace, bulk };
      };
      const group = [
        { class: "workspace", member: "tree/ignored.bin" },
        { class: "bulk", member: "node_modules/linked.bin" },
      ];
      let parent = at.cap0Id;
      let n = 0;
      const attempt = async (
        bulkBytes: string | null,
        links: ReadonlyArray<object>,
        bulkChunkSize?: number,
      ) => {
        n += 1;
        const { workspace, bulk } = classes(bulkBytes, bulkChunkSize);
        const meta = withMeta(at.worktreeId, at.epoch, {
          format: 1,
          entries: [],
          cross_links: [links],
        });
        const metaSection = meta.workspace;
        const built = sealing(
          at.worktreeId,
          at.epoch,
          buildManifest({
            worktreeId: at.worktreeId,
            n,
            parent,
            epoch: at.epoch,
            seq: 10 + n,
            kind: "final",
            git: at.gitSection([at.basePack], at.baseTree),
            workspace: {
              ...sectionOf(workspace),
              packs: [...workspace.packs, ...metaSection.packs],
              worktree_meta: metaSection.worktree_meta,
            },
            bulk: { ...sectionOf(bulk), platform: "linux-x86_64-glibc" },
          }),
        );
        await run(
          uploadObjects(
            new Map([
              ...workspace.objects,
              ...bulk.objects,
              ...meta.objects,
              [built.key, built.bytes],
            ]),
          ),
        );
        expect((await run(registerOn(at.worktreeId, at.epoch, at.api)(built))).head_n).toBe(n);
        parent = built.id;
        return (await sealOf(at.worktreeId, at.epoch))?.captureId === built.id;
      };
      // Both endpoints absent from their classes.
      expect(
        await attempt(null, [
          { class: "workspace", member: "tree/missing-ignored" },
          { class: "bulk", member: "node_modules/missing-bulk" },
        ]),
      ).toBe(false);
      // The bulk member absent.
      expect(await attempt(null, group)).toBe(false);
      // Both present, other bytes of the same length: the restore would leave them two files.
      expect(await attempt("two inode's bytes\n", group)).toBe(false);
      // Both present, the same bytes: the declared topology restores, and the seal holds.
      expect(await attempt("one inode's bytes\n", group)).toBe(true);
      // The same bytes chunked otherwise by the bulk class: read back, one set of bytes.
      expect(await attempt("one inode's bytes\n", group, 5)).toBe(true);
      // …and other bytes chunked otherwise are still other bytes.
      expect(await attempt("two inode's bytes\n", group, 5)).toBe(false);
    },
  );
});

/**
 * The `git_trees` manifest feature (sealantd review 3): the trees ride their own fields, `refs` is
 * the repository's refs whatever their names, and `raw_tree` is what a restore checks out. Reads
 * take `worktree_tree`, never a user ref that happens to be named like the old pseudo-ref, and
 * verification walks every tree a restore needs.
 */
describe("git sections that name their trees (git_trees)", () => {
  const world = makeCaptureWorld();
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
    world.layer,
  );
  type Services = SessionRepository | WorktreeReads | CaptureStoreRepo | CaptureChannel | BlobStore;
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));
  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  const claimed = async () => {
    const worktreeId = newWorktreeId();
    const branch = `mend/wt/${worktreeId}`;
    world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.createWorktree(world.project.id, { directory: worktreeId, branch }, null, null);
        yield* repo.attachWorktree!(world.project.id, worktreeId);
      }),
    );
    const cap0Id = world.memory.chains.get(worktreeId)?.headCapture ?? "";
    const cap0 = world.memory.captures.get(cap0Id);
    if (cap0 === undefined) throw new Error("capture 0 did not register");
    const { epoch, api } = await run(
      Effect.gen(function* () {
        const captures = yield* CaptureStoreRepo;
        const claim = yield* captures.claim(worktreeId, "executor-1", 300);
        const routes: SessionCaptureApi = (yield* CaptureChannel).apiFor({
          worktreeId,
          projectId: world.project.id,
          executorId: "executor-1",
          footprintBytes: 0,
        });
        return { epoch: claim.epoch, api: routes };
      }),
    );
    return { worktreeId, branch, epoch, api, cap0Id, basePack: packsOf(cap0.sections)[0] ?? "" };
  };

  it("reads the worktree tree from `worktree_tree`, keeps a user ref named like the old pseudo-ref as a ref, and plans it only for an executor that reads git_trees", async () => {
    const at = await claimed();
    const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (dir) => {
      fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    });
    const cap1 = buildManifest({
      worktreeId: at.worktreeId,
      n: 1,
      parent: at.cap0Id,
      epoch: at.epoch,
      seq: 10,
      kind: "turn",
      git: {
        packs: [at.basePack, edited.key],
        refs: {
          [`refs/heads/${at.branch}`]: world.baseSha,
          // A user's own ref under the old pseudo-ref's name: the base commit, not a tree.
          [WORKTREE_TREE_REF]: world.baseSha,
        },
        head: `refs/heads/${at.branch}`,
        fsck: "verified",
        worktree_tree: edited.tree,
        index_tree: edited.tree,
        raw_tree: edited.tree,
      },
    });
    await run(uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]])));
    await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
    expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("verified");
    const read = await run(
      Effect.gen(function* () {
        const reads = yield* WorktreeReads;
        return yield* reads.diffWorktree(world.project.id, at.worktreeId, world.baseSha);
      }),
    );
    expect(read.value).toContain("+three");
    const refused = await run(
      at.api
        .planGet({ epoch: at.epoch, manifest_format: 2, manifest_features: ["final_seal"] })
        .pipe(Effect.flip),
    );
    expect(refused.reason).toBe("manifest-features");
    expect(refused.missing).toEqual(["git_trees"]);
    const planned = await run(
      at.api.planGet({ epoch: at.epoch, manifest_format: 2, manifest_features: ["git_trees"] }),
    );
    expect(planned.manifest_features).toContain("git_trees");
    expect(planned.head?.manifest.sections.git.worktree_tree).toBe(edited.tree);
    expect(planned.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(world.baseSha);
  });

  it("verifies every tree a restore checks out: a raw tree no pack holds fails the git section", async () => {
    const at = await claimed();
    const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (dir) => {
      fs.writeFileSync(path.join(dir, "a.txt"), "raw\r\nbytes\r\n");
    });
    // A tree written in the work repository and never packed.
    const blob = sh(world.work, ["hash-object", "-w", "--stdin"], "only on the executor\n");
    const unpacked = sh(world.work, ["mktree"], `100644 blob ${blob}\tunpacked.txt\n`);
    const cap1 = buildManifest({
      worktreeId: at.worktreeId,
      n: 1,
      parent: at.cap0Id,
      epoch: at.epoch,
      seq: 10,
      kind: "turn",
      git: {
        packs: [at.basePack, edited.key],
        refs: { [`refs/heads/${at.branch}`]: world.baseSha },
        head: `refs/heads/${at.branch}`,
        fsck: "verified",
        worktree_tree: edited.tree,
        index_tree: edited.tree,
        raw_tree: unpacked,
      },
    });
    await run(uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]])));
    await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
    expect(world.memory.captures.get(cap1.id)?.gitFsck).toBe("failed");
  });
});

/**
 * Review 2026-09-28 (7) #8: on a bucket that ignores `If-None-Match` (Garage), a PUT URL handed
 * out before an object's upload can replace its bytes after the seal. A seal stands only once no
 * URL of its epoch can still be used, and only over objects read back as what their names say.
 */
interface SealHarness {
  readonly world: ReturnType<typeof makeCaptureWorld>;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SessionRepository | CaptureStoreRepo | CaptureChannel | BlobStore>,
  ) => Promise<A>;
  readonly claimed: () => Promise<{
    readonly worktreeId: WorktreeId;
    readonly epoch: number;
    readonly api: SessionCaptureApi;
    readonly cap0Id: string;
    readonly git: object;
  }>;
}

const describeSeals = (
  title: string,
  options: { readonly blobs?: (root: string) => Layer.Layer<BlobStore>; readonly skip?: boolean },
  body: (harness: SealHarness) => void,
) =>
  describe.skipIf(options.skip === true)(title, () => {
    const world = makeCaptureWorld(options.blobs === undefined ? {} : { blobs: options.blobs });
    const layer = Layer.mergeAll(
      SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
      world.layer,
    );
    type Services = SessionRepository | CaptureStoreRepo | CaptureChannel | BlobStore;
    const scope = Scope.makeUnsafe();
    let context: Context.Context<Services>;
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(effect.pipe(Effect.provide(context)));
    beforeAll(async () => {
      context = await Effect.runPromise(
        Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
      );
    });
    afterAll(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      fs.rmSync(world.scratch, { recursive: true, force: true });
    });
    const claimed = async () => {
      const worktreeId = newWorktreeId();
      const branch = `mend/wt/${worktreeId}`;
      world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.createWorktree(
            world.project.id,
            { directory: worktreeId, branch },
            null,
            null,
          );
          yield* repo.attachWorktree!(world.project.id, worktreeId);
        }),
      );
      const cap0Id = world.memory.chains.get(worktreeId)?.headCapture ?? "";
      const cap0 = world.memory.captures.get(cap0Id);
      if (cap0 === undefined) throw new Error("capture 0 did not register");
      const { epoch, api } = await run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          const lease = yield* captures.claim(worktreeId, "executor-1", 300);
          const routes: SessionCaptureApi = (yield* CaptureChannel).apiFor({
            worktreeId,
            projectId: world.project.id,
            executorId: "executor-1",
            footprintBytes: 0,
          });
          return { epoch: lease.epoch, api: routes };
        }),
      );
      const tree = refsOf(cap0.sections)[WORKTREE_TREE_REF] ?? "";
      return {
        worktreeId,
        epoch,
        api,
        cap0Id,
        git: {
          packs: [packsOf(cap0.sections)[0] ?? ""],
          refs: {
            [`refs/heads/${branch}`]: world.baseSha,
            [WORKTREE_TREE_REF]: tree,
            [INDEX_TREE_REF]: tree,
          },
          head: `refs/heads/${branch}`,
          fsck: "verified" as const,
        },
      };
    };
    body({ world, run, claimed });
  });

/** A final capture sealing one workspace file: its snapshot, its pack's key and bytes. */
const sealedFile = (
  at: {
    readonly worktreeId: WorktreeId;
    readonly epoch: number;
    readonly cap0Id: string;
    readonly git: object;
  },
  content: string,
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-replaceable-"));
  fs.mkdirSync(path.join(dir, "tree"));
  fs.writeFileSync(path.join(dir, "tree", "unique.txt"), content);
  const snapshot = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), { format: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
  const key = snapshot.packs[0] ?? "";
  const cap = sealing(
    at.worktreeId,
    at.epoch,
    buildManifest({
      worktreeId: at.worktreeId,
      epoch: at.epoch,
      n: 1,
      parent: at.cap0Id,
      kind: "final",
      git: JSON.parse(JSON.stringify(at.git)),
      workspace: sectionOf(snapshot),
      bulk: READY_EMPTY_BULK,
    }),
  );
  return { snapshot, key, bytes: snapshot.objects.get(key) ?? new Uint8Array(), cap };
};

/** The bucket's answer to `replaceableUntil`: 0 refuses overwrites (S3, MinIO); else Garage's. */
let bucketReplaceableUntil = 0;
describeSeals(
  "review 7 #8 a seal over objects an upload URL could still replace",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.sync(() => bucketReplaceableUntil),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    it("is withheld while a URL of its epoch lives, stands once its objects read back, and is void for good once one reads back as other bytes", async () => {
      let clock = Date.now();
      const seals = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
        run(
          Effect.flatMap(CaptureSeals, (service) =>
            service.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
          ).pipe(Effect.provide(makeCaptureSealsStore({ now: () => clock }))),
        );
      const recorded = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
        run(
          Effect.flatMap(CaptureStoreRepo, (repo) =>
            repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
          ),
        );

      // A bucket that refuses overwrites: the seal stands as recorded, URL or not.
      bucketReplaceableUntil = 0;
      const strict = await claimed();
      const onStrict = sealedFile(strict, "unique saved bytes\n");
      await run(
        strict.api.uploadUrls({
          worktree_id: strict.worktreeId,
          epoch: strict.epoch,
          keys: [onStrict.key],
          sizes: { [onStrict.key]: onStrict.bytes.length },
        }),
      );
      await run(
        uploadObjects(
          new Map([...onStrict.snapshot.objects, [onStrict.cap.key, onStrict.cap.bytes]]),
        ),
      );
      await run(registerOn(strict.worktreeId, strict.epoch, strict.api)(onStrict.cap));
      expect((await seals(strict))?.captureId).toBe(onStrict.cap.id);

      // Garage: the reviewer's order. A PUT URL is handed out while the pack is absent — its
      // expiry recorded before it leaves Mend — the bytes land, the seal registers.
      bucketReplaceableUntil = clock - 60_000;
      const at = await claimed();
      const file = sealedFile(at, "unique saved bytes\n");
      const minted = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      expect(typeof minted.urls[file.key]).toBe("string");
      const authority = world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`);
      expect(authority?.getTime() ?? 0).toBeGreaterThan(clock + PRESIGN_TTL_SECONDS * 1000 - 5_000);
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      // Recorded, but not standing: the URL could still replace the pack.
      expect((await recorded(at))?.captureId).toBe(file.cap.id);
      expect(await seals(at)).toBeNull();
      // Past the URL's expiry: every object reads back as its name says — it stands, re-verified.
      clock = (authority?.getTime() ?? 0) + 1;
      expect((await seals(at))?.captureId).toBe(file.cap.id);
      expect((await recorded(at))?.reverifiedAt?.getTime()).toBe(clock);
      expect((await seals(at))?.captureId).toBe(file.cap.id);

      // Another URL handed out under the epoch (an older daemon re-asking for the stored pack is
      // answered one, review 2026-09-28 (7) #7): withheld again until it expires. Through it the
      // pack is replaced with bytes of the same length.
      const legacy = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      expect(typeof legacy.urls[file.key]).toBe("string");
      expect(await seals(at)).toBeNull();
      const stored = path.join(world.blobRoot, file.key);
      const corrupted = Buffer.from(file.bytes);
      corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
      fs.chmodSync(stored, 0o644);
      fs.writeFileSync(stored, corrupted);
      clock = (world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0) + 1;
      // Read back as other bytes: void, and it never stands again — not even over the bytes
      // put back.
      expect(await seals(at)).toBeNull();
      expect((await recorded(at))?.voidReason).toContain(file.key);
      fs.writeFileSync(stored, file.bytes);
      expect(await seals(at)).toBeNull();
    });
  },
);

// Review 2026-09-28 (8) #5 (the reviewer's reproductions): the seal service read the epoch's
// write authority once, read every object back and marked the seal re-verified — a URL handed out
// while it read was never seen, and the seal it returned stood with that URL live. And the register
// answered success with nothing to say whether the seal it carried stands, while the plan handed
// on `final_seal` of a seal the store withheld: sealantd answered complete on that.
/** A write authority handed out when the seal service first reads the sealed manifest back. */
let authorityDuringReadBack: (() => Promise<void>) | undefined;
/** The bucket's answer to `replaceableUntil` in the suite below: 0 refuses overwrites. */
let bucketReplaceable = 0;
describeSeals(
  "review 8 #5 write authority is fenced against a seal's read-back, and the register and the plan say how the seal stands",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.sync(() => bucketReplaceable),
          get: (key: string) =>
            Effect.gen(function* () {
              const action = authorityDuringReadBack;
              if (key.includes("/manifests/") && action !== undefined) {
                authorityDuringReadBack = undefined;
                yield* Effect.promise(action);
              }
              return yield* store.get(key);
            }),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    const standing = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
      run(
        Effect.flatMap(CaptureSeals, (service) =>
          service.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
        ).pipe(Effect.provide(CaptureSealsStoreLive)),
      );
    const planned = (at: {
      readonly worktreeId: WorktreeId;
      readonly epoch: number;
      readonly api: SessionCaptureApi;
    }) =>
      run(
        at.api.planGet({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          manifest_format: 2,
          manifest_features: MANIFEST_FEATURES,
          upload_answers: [UPLOAD_ANSWER_PRESENT],
        }),
      );

    it("a URL handed out while the seal's objects are read back leaves the seal withheld", async () => {
      bucketReplaceable = Date.now() - 60_000;
      const at = await claimed();
      const file = sealedFile(at, "saved bytes\n");
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      // A URL of the epoch lives briefly past the register: the seal registers withheld, and its
      // first read-back comes once that URL has expired.
      const expires = Date.now() + 150;
      await run(
        Effect.flatMap(CaptureStoreRepo, (repo) =>
          repo.recordPutAuthority(at.worktreeId, at.epoch, new Date(expires)),
        ),
      );
      await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(await standing(at)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now()) + 20));
      let minted = false;
      authorityDuringReadBack = async () => {
        const answer = await run(
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [file.key],
            sizes: { [file.key]: file.bytes.length },
          }),
        );
        minted = typeof answer.urls[file.key] === "string";
      };
      const accepted = await standing(at);
      expect(minted).toBe(true);
      expect(
        world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0,
      ).toBeGreaterThan(Date.now());
      // The URL lives: the seal does not stand, now or on the next read.
      expect(accepted).toBeNull();
      expect(await standing(at)).toBeNull();
      const recorded = await run(
        Effect.flatMap(CaptureStoreRepo, (repo) =>
          repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
        ),
      );
      expect(recorded?.reverifiedAt ?? null).toBeNull();
    });

    it("the register answers the seal recorded, withheld or refused, and the plan hands on only a standing seal", async () => {
      // A bucket that refuses overwrites: recorded, and the plan carries it.
      bucketReplaceable = 0;
      const strict = await claimed();
      const onStrict = sealedFile(strict, "unique saved bytes\n");
      await run(
        uploadObjects(
          new Map([...onStrict.snapshot.objects, [onStrict.cap.key, onStrict.cap.bytes]]),
        ),
      );
      const strictAnswer = await run(
        registerOn(strict.worktreeId, strict.epoch, strict.api)(onStrict.cap),
      );
      expect(strictAnswer.seal).toEqual({ state: "recorded" });
      expect((await planned(strict)).head?.manifest.final_seal?.complete).toBe(true);
      // A standing seal is handed on only to an executor that reads it.
      const unread = await run(
        strict.api
          .planGet({
            worktree_id: strict.worktreeId,
            epoch: strict.epoch,
            manifest_format: 2,
            manifest_features: MANIFEST_FEATURES.filter((feature) => feature !== "final_seal"),
          })
          .pipe(Effect.flip),
      );
      expect(unread.missing).toEqual(["final_seal"]);

      // Garage: a URL of the epoch lives when the seal registers — withheld, and the plan carries
      // the head without it; asked again (a lost-answer retry), still withheld.
      bucketReplaceable = Date.now() - 60_000;
      const at = await claimed();
      const file = sealedFile(at, "unique saved bytes\n");
      await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(answer.head_capture_id).toBe(file.cap.id);
      expect(answer.seal?.state).toBe("withheld");
      expect(answer.seal?.reason).toBe("write-authority");
      const plan = await planned(at);
      expect(plan.head?.capture_id).toBe(file.cap.id);
      expect(plan.head?.manifest.final_seal).toBeUndefined();
      const again = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(again.seal?.state).toBe("withheld");

      // A seal that does not name this executor: refused. A manifest with no seal: no answer.
      bucketReplaceable = 0;
      const other = await claimed();
      const foreign = sealedFile(other, "other bytes\n");
      const foreignManifest = {
        ...foreign.cap.manifest,
        final_seal: { complete: true, epoch: other.epoch, executor: "another-launch" },
      };
      const foreignBytes = new Uint8Array(Buffer.from(JSON.stringify(foreignManifest)));
      const foreignId = sha256Hex(foreignBytes);
      const foreignCap = {
        manifest: foreignManifest,
        bytes: foreignBytes,
        id: foreignId,
        key: captureKeys(other.worktreeId, other.epoch).manifest(foreignId),
      };
      await run(
        uploadObjects(new Map([...foreign.snapshot.objects, [foreignCap.key, foreignBytes]])),
      );
      const refused = await run(registerOn(other.worktreeId, other.epoch, other.api)(foreignCap));
      expect(refused.seal).toEqual({ state: "refused", reason: "executor" });
      expect((await planned(other)).head?.manifest.final_seal).toBeUndefined();
    });
  },
);

// The reviewer's reproduction on a real bucket that ignores `If-None-Match` (Garage 2.4.1):
// opt in with MEND_TEST_S3_URL (s3://bucket?endpoint=…&region=…) + AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY, as the store's S3 contract does.
const garageConfig = (() => {
  const url = process.env["MEND_TEST_S3_URL"];
  if (url === undefined || url === "") return null;
  const resolved = resolveBlobStoreConfig({ MEND_BLOB_STORE: url });
  if (resolved.target.kind !== "s3") return null;
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  if (accessKeyId === undefined || secretAccessKey === undefined) return null;
  return { ...resolved.target, credentials: { accessKeyId, secretAccessKey } };
})();
describeSeals(
  "review 7 #8 on a real bucket (MEND_TEST_S3_URL)",
  {
    skip: garageConfig === null,
    blobs: (root) =>
      garageConfig === null ? BlobStoreFsLive(root) : BlobStoreS3Live(garageConfig),
  },
  ({ run, claimed }) => {
    it("the URL minted before the pack's upload replaces it after the register: no seal stands on it", async () => {
      const at = await claimed();
      const file = sealedFile(at, "unique saved bytes\n");
      const minted = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      const url = minted.urls[file.key] ?? "";
      const headers = { "if-none-match": "*", "content-length": String(file.bytes.length) };
      expect(
        (await fetch(url, { method: "PUT", headers, body: Buffer.from(file.bytes) })).status,
      ).toBe(200);
      await run(
        uploadObjects(
          new Map(
            [...file.snapshot.objects]
              .filter(([key]) => key !== file.key)
              .concat([[file.cap.key, file.cap.bytes]]),
          ),
        ),
      );
      const registered = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      const seals = () =>
        run(
          Effect.flatMap(CaptureSeals, (service) =>
            service.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
          ).pipe(Effect.provide(CaptureSealsStoreLive)),
        );
      const plannedSeal = async () =>
        (
          await run(
            at.api.planGet({
              worktree_id: at.worktreeId,
              epoch: at.epoch,
              manifest_format: 2,
              manifest_features: MANIFEST_FEATURES,
              upload_answers: [UPLOAD_ANSWER_PRESENT],
            }),
          )
        ).head?.manifest.final_seal;
      const refuses =
        (await run(Effect.flatMap(BlobStore, (store) => store.replaceableUntil(file.key)))) === 0;
      if (refuses) {
        // A bucket that honours the precondition: the seal stands, and the URL cannot replace.
        expect(registered.seal).toEqual({ state: "recorded" });
        expect((await seals())?.captureId).toBe(file.cap.id);
        expect((await plannedSeal())?.complete).toBe(true);
        return;
      }
      // Garage: withheld while the URL lives — the register says so (review 2026-09-28 (8) #5),
      // the plan hands the head on without it …
      expect(registered.seal?.state).toBe("withheld");
      expect(await plannedSeal()).toBeUndefined();
      expect(await seals()).toBeNull();
      // … which it does: the same URL replaces the pack's first byte, and the seal still does
      // not stand on it.
      const bad = Buffer.from(file.bytes);
      bad[0] = (bad[0] ?? 0) ^ 0xff;
      expect((await fetch(url, { method: "PUT", headers, body: bad })).status).toBe(200);
      const read = await run(
        readCaptureFileBytes(file.cap.manifest, "workspace", "tree/unique.txt").pipe(Effect.result),
      );
      expect(read._tag).toBe("Failure");
      expect(await seals()).toBeNull();
    });
  },
);
