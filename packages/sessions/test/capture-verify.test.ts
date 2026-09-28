import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import {
  type BlobStore,
  INDEX_TREE_REF,
  WORKTREE_TREE_REF,
  captureKeys,
  isCaptureObjectKey,
  packIdxKeyOf,
  sha256Hex,
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

import { CaptureChannel, type SessionCaptureApi } from "../src/capture-channel.ts";
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
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(document)));
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
        /^unrestorable: .*missing-work\.txt.*absent from the worktree tree/,
      );
      const wrongKind = await attempt(
        [root, { path: "kept.txt", kind: "symlink", mtime: ns }],
        1,
        at.cap0Id,
      );
      expect(wrongKind.said).toMatch(/^unrestorable: .*kept\.txt.*a file in the worktree tree/);
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
