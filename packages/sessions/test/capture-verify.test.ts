import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import {
  BlobStore,
  BlobStoreError,
  BlobStoreFsLive,
  type CaptureManifest,
  BlobStoreS3Live,
  resolveBlobStoreConfig,
  INDEX_TREE_REF,
  WORKTREE_TREE_REF,
  captureKeys,
  isCaptureObjectKey,
  readCaptureFileBytes,
  packIdxKeyOf,
  runnerCachePathOf,
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
import { Cause, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  type CapturePlanNotice,
  CaptureRegisterBudget,
  MANIFEST_FEATURES,
  planBlockedWords,
  planWaitingWords,
  PRESIGN_TTL_SECONDS,
  PUT_URL_ASSUMED_BYTES_PER_SECOND,
  PUT_URL_CLOCK_MARGIN_SECONDS,
  PUT_URL_TTL_MIN_SECONDS,
  putUrlTtlSeconds,
  type SessionCaptureApi,
  UNEXPLAINED_CHECKS_BOUND,
  UPLOAD_ANSWER_PRESENT,
  UPLOAD_ANSWER_SHA256,
  type CaptureUploadPolicy,
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

/**
 * The Mend host failing one git step (review 2026-09-28 (13) #1): a `git` first on `PATH` that,
 * when armed for a subcommand, is killed with SIGKILL (the OOM killer) or fails for disk space,
 * once, and otherwise runs the real git. The capture's bytes are sound either way. `unexplained`
 * (review 2026-09-28 (14) #4) fails every run until recovered, exit 128, in words nothing lists.
 */
const hostGitFaults = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-host-git-"));
  const real = realGit();
  fs.writeFileSync(
    path.join(dir, "git"),
    [
      "#!/bin/sh",
      `if [ -e "${dir}/$1.kill" ]; then rm -f "${dir}/$1.kill"; kill -KILL $$; fi`,
      `if [ -e "${dir}/$1.enospc" ]; then rm -f "${dir}/$1.enospc"; echo "fatal: unable to create temporary file: No space left on device" >&2; exit 128; fi`,
      `if [ -e "${dir}/$1.unexplained" ]; then echo "fatal: something git never said before" >&2; exit 128; fi`,
      `exec "${real}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const realPath = process.env["PATH"] ?? "";
  return {
    dir,
    /** Arm one fault for `subcommand`'s next run, and put the wrapper first on `PATH`. */
    arm: (subcommand: string, fault: "kill" | "enospc" | "unexplained") => {
      fs.writeFileSync(path.join(dir, `${subcommand}.${fault}`), "");
      process.env["PATH"] = `${dir}:${realPath}`;
    },
    /** Whether the armed fault fired; disarm it and restore `PATH` (the host recovered). */
    recover: (subcommand: string, fault: "kill" | "enospc" | "unexplained") => {
      process.env["PATH"] = realPath;
      const armed = path.join(dir, `${subcommand}.${fault}`);
      const fired = !fs.existsSync(armed);
      fs.rmSync(armed, { force: true });
      return fired;
    },
    remove: () => {
      process.env["PATH"] = realPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** The git binary `PATH` resolves now, by absolute path. */
const realGit = (): string => {
  for (const at of (process.env["PATH"] ?? "").split(path.delimiter)) {
    const candidate = path.join(at, "git");
    if (at !== "" && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return "git";
};

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
    "records `failed` for a pack that omits a tree it names, reads the newest verified capture under the unchanged head, and verifies an `auto` head at the plan that would restore it",
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

      // The holder's own re-plan restores nothing from it (it resumes its disk): its head, as
      // registered (review 2026-09-28 (14) #2). A new launch's plan is refused, never planned as
      // another capture (review 2026-09-28 (14) #3: "review 14 #3" below).
      const plan1 = await run(api.planGet({ worktree_id: worktreeId, epoch }));
      expect(plan1.head?.n).toBe(1);
      expect(plan1.head?.capture_id).toBe(cap1.id);
      expect(plan1.head?.manifest.sections.git.packs).toEqual([basePack, partial.key]);
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
      // The holder ended; the next launch's boot plan lays the head down.
      const plan3 = await run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          yield* captures.release(worktreeId, epoch);
          const channel = yield* CaptureChannel;
          return yield* channel
            .apiFor({
              worktreeId,
              projectId: world.project.id,
              executorId: "executor-1",
              launchId: "launch-2",
              footprintBytes: 0,
            })
            .planGet({ worktree_id: worktreeId, epoch: 0 });
        }),
      );
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

/** The next sealing FINAL of `built`'s chain: the same sections, one capture later. */
const nextSealing = (
  at: { readonly worktreeId: string; readonly epoch: number },
  built: {
    readonly id: string;
    readonly manifest: ReturnType<typeof buildManifest>["manifest"];
  },
) => {
  const manifest = {
    ...built.manifest,
    n: built.manifest.n + 1,
    parent: built.id,
    seq: built.manifest.seq + 1,
  };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  const id = sha256Hex(bytes);
  return { manifest, bytes, id, key: captureKeys(at.worktreeId, at.epoch).manifest(id) };
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

/** A user file at the root of an edited tree (review 8 #8). */
const userFile = (work: string) => fs.writeFileSync(path.join(work, "a.txt"), "user file\n");

/**
 * A `git init --object-format=sha256` repository holding one commit of user work (review 8 #10):
 * its commit and tree, a pack of its whole closure, and a pack of the commit alone.
 */
const sha256Repo = (
  at: { readonly worktreeId: WorktreeId; readonly epoch: number },
  init: ReadonlyArray<string> = ["--object-format=sha256"],
) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-sha256-"));
  sh(work, ["init", "-q", ...init, "-b", "main"]);
  fs.writeFileSync(path.join(work, "work.txt"), "user work in a sha256 repository\n");
  sh(work, ["add", "."]);
  sh(work, ["commit", "-q", "-m", "sha256 work"]);
  const commit = sh(work, ["rev-parse", "HEAD"]);
  const tree = sh(work, ["rev-parse", "HEAD^{tree}"]);
  const pack = (objects: ReadonlyArray<string>) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review8-sha256-pack-"));
    const name = sh(work, ["pack-objects", "-q", path.join(out, "p")], `${objects.join("\n")}\n`);
    const bytes = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
    const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
    fs.rmSync(out, { recursive: true, force: true });
    const key = captureKeys(at.worktreeId, at.epoch).pack(sha256Hex(bytes));
    return {
      key,
      objects: new Map<string, Uint8Array>([
        [key, bytes],
        [packIdxKeyOf(key), idx],
      ]),
    };
  };
  const every = sh(work, ["rev-list", "--objects", "--all"])
    .split("\n")
    .map((line) => line.split(" ")[0] ?? "");
  const whole = pack(every);
  // The commit alone: its tree and the blob are not in the pack.
  const commitOnly = pack([commit]);
  fs.rmSync(work, { recursive: true, force: true });
  return { commit, tree, whole, commitOnly };
};
const section = (
  packs: ReadonlyArray<string>,
  tips: { readonly commit: string; readonly tree: string },
  objectFormat?: string,
  refFormat?: string,
) => ({
  packs,
  refs: { "refs/heads/main": tips.commit },
  head: "refs/heads/main",
  fsck: "verified" as const,
  worktree_tree: tips.tree,
  index_tree: tips.tree,
  raw_tree: tips.tree,
  ...(objectFormat === undefined ? {} : { object_format: objectFormat }),
  ...(refFormat === undefined ? {} : { ref_format: refFormat }),
});

/**
 * What a seal may rest on (review 2026-09-28 (3) #18 and #20): register records `final_seal` only
 * once Mend observed every section restore — the git section verified, the worktree metadata
 * document checked against the worktree tree it applies to — and a plan that restores other git
 * state than the head's carries no seal.
 */
describe("review 13 #1: a git step the Mend host could not finish concludes nothing about the capture", () => {
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
  const faults = hostGitFaults();
  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  });
  afterAll(async () => {
    faults.remove();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  /** A claimed worktree with capture 0, its routes, and what its plans told the session. */
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
    const notices: Array<CapturePlanNotice> = [];
    /** The session's routes as launch `launchId` of executor-1 asks them. */
    const routesFor = (launchId: string) =>
      Effect.map(
        CaptureChannel,
        (channel): SessionCaptureApi =>
          channel.apiFor({
            worktreeId,
            projectId: world.project.id,
            executorId: "executor-1",
            launchId,
            footprintBytes: 0,
            planNotice: (notice) => Effect.sync(() => void notices.push(notice)),
          }),
      );
    const { epoch, api } = await run(
      Effect.gen(function* () {
        const captures = yield* CaptureStoreRepo;
        const claimed = yield* captures.claim(worktreeId, "executor-1", 300, "launch-1");
        return { epoch: claimed.epoch, api: yield* routesFor("launch-1") };
      }),
    );
    const basePack = packsOf(cap0.sections)[0] ?? "";
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
    /** Capture `n` on top of `parent`: `a.txt` reads `words`. */
    const capture = async (n: number, parent: string, kind: "turn" | "auto", words: string) => {
      const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), `${words}\n`);
      });
      const built = buildManifest({
        worktreeId,
        n,
        parent,
        epoch,
        seq: n * 10,
        kind,
        git: gitSection([basePack, edited.key], edited.tree),
      });
      await run(uploadObjects(new Map([...edited.objects, [built.key, built.bytes]])));
      return { built, tree: edited.tree, pack: edited.key };
    };
    let launches = 1;
    /**
     * A resume's boot plan (review 2026-09-28 (14) #2): the holder ended (its lease released), and
     * a new launch asks — the plan that lays the head down, and so the one that verifies it.
     */
    const resumePlanExit = () =>
      run(
        Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          const lease = yield* captures.leaseOf(worktreeId);
          if (lease !== null && lease.executorId !== null) {
            yield* captures.release(worktreeId, lease.epoch);
          }
          launches += 1;
          const resumed = yield* routesFor(`launch-${launches}`);
          return yield* Effect.exit(resumed.planGet({ worktree_id: worktreeId, epoch: 0 }));
        }),
      );
    const plan = async () => {
      const exit = await resumePlanExit();
      if (Exit.isFailure(exit)) throw new Error(`the plan failed: ${Cause.pretty(exit.cause)}`);
      return exit.value;
    };
    const planExit = resumePlanExit;
    /** The launch the latest resume plan asked as. */
    const lastLaunch = () => `launch-${launches}`;
    return {
      api,
      routesFor,
      lastLaunch,
      worktreeId,
      cap0,
      cap0Id,
      basePack,
      epoch,
      notices,
      register,
      capture,
      plan,
      planExit,
    };
  };

  for (const fault of ["kill", "enospc"] as const) {
    it(
      `${fault}: a turn capture whose index-pack the host could not finish is \`unverified\`, verified again once it recovers, and the plan restores it — never an older git section`,
      { timeout: 60_000 },
      async () => {
        const at = await claimedWorktree();
        // 1. The session's first turn verifies.
        const v1 = await at.capture(1, at.cap0Id, "turn", `${fault} session work v1`);
        expect((await run(at.register(v1.built))).head_n).toBe(1);
        expect(world.memory.captures.get(v1.built.id)?.gitFsck).toBe("verified");
        // 2. The next turn, a sound pack: the Mend host fails one git step while verifying it.
        const v2 = await at.capture(2, v1.built.id, "turn", `${fault} session work v2 (latest)`);
        faults.arm("index-pack", fault);
        let landed;
        try {
          landed = await run(at.register(v2.built));
        } finally {
          expect(faults.recover("index-pack", fault)).toBe(true);
        }
        expect(landed.head_n).toBe(2);
        // Before: `failed`, for good.
        expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("unverified");
        // 3. The host recovered: a lost-ack re-register, then a resume's plan.
        expect((await run(at.register(v2.built))).head_n).toBe(2);
        const plan = await at.plan();
        expect(plan.head?.n).toBe(2);
        expect(plan.head?.manifest.sections.git.packs).toEqual([at.basePack, v2.pack]);
        expect(plan.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(v2.tree);
        expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("verified");
        expect(at.notices.at(-1)).toEqual({ kind: "planned", launchId: at.lastLaunch() });
        const read = await run(
          Effect.gen(function* () {
            const reads = yield* WorktreeReads;
            return yield* reads.diffWorktree(world.project.id, at.worktreeId, world.baseSha);
          }),
        );
        expect(read.stamp.captureN).toBe(2);
        expect(read.value).toContain("v2 (latest)");
      },
    );

    it(
      `${fault}: a plan that cannot verify an \`auto\` head now waits (the executor asks again, the session says why) and restores the head once the host recovers`,
      { timeout: 60_000 },
      async () => {
        const at = await claimedWorktree();
        const v1 = await at.capture(1, at.cap0Id, "turn", `${fault} plan-time v1`);
        expect((await run(at.register(v1.built))).head_n).toBe(1);
        const v3 = await at.capture(2, v1.built.id, "auto", `${fault} plan-time v3 (auto head)`);
        expect((await run(at.register(v3.built))).head_n).toBe(2);
        expect(world.memory.captures.get(v3.built.id)?.gitFsck).toBe("unverified");
        faults.arm("index-pack", fault);
        let underFault;
        try {
          underFault = await at.planExit();
        } finally {
          expect(faults.recover("index-pack", fault)).toBe(true);
        }
        // Before: the head was recorded `failed` and the plan restored capture 1's git section
        // under it, then and on every later plan.
        expect(Exit.isFailure(underFault)).toBe(true);
        if (Exit.isFailure(underFault)) {
          const error = Cause.findErrorOption(underFault.cause);
          expect(Option.isSome(error) ? error.value.reason : null).toBe("worktree-leased");
        }
        expect(world.memory.captures.get(v3.built.id)?.gitFsck).toBe("unverified");
        expect(at.notices.at(-1)).toEqual({
          kind: "waiting",
          words: planWaitingWords(2),
          launchId: at.lastLaunch(),
        });
        // The executor asks again once the host recovered: the head, as registered.
        const later = await at.plan();
        expect(later.head?.n).toBe(2);
        expect(later.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(v3.tree);
        expect(world.memory.captures.get(v3.built.id)?.gitFsck).toBe("verified");
        expect(at.notices.at(-1)).toEqual({ kind: "planned", launchId: at.lastLaunch() });
      },
    );
  }

  it(
    "a head recorded `failed` by an earlier host fault (before this fix, or by an older Mend) is verified again before any plan routes around it",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const v1 = await at.capture(1, at.cap0Id, "turn", "recheck v1");
      expect((await run(at.register(v1.built))).head_n).toBe(1);
      const v2 = await at.capture(2, v1.built.id, "turn", "recheck v2 (latest)");
      expect((await run(at.register(v2.built))).head_n).toBe(2);
      // What an older Mend recorded when one git step was OOM-killed.
      await run(Effect.flatMap(CaptureStoreRepo, (repo) => repo.setGitFsck(v2.built.id, "failed")));
      const plan = await at.plan();
      expect(plan.head?.manifest.sections.git.refs[WORKTREE_TREE_REF]).toBe(v2.tree);
      expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("verified");
      expect(at.notices.at(-1)).toEqual({ kind: "planned", launchId: at.lastLaunch() });
    },
  );

  it(
    "review 14 #3: a head git rejects by content is refused (422 `unrestorable`), never planned as another capture, and the session says the launch is blocked",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const v1 = await at.capture(1, at.cap0Id, "turn", "blocked v1");
      expect((await run(at.register(v1.built))).head_n).toBe(1);
      const partial = packWithoutSubtree(world.work, at.worktreeId, at.epoch, world.baseSha);
      const broken = buildManifest({
        worktreeId: at.worktreeId,
        n: 2,
        parent: v1.built.id,
        epoch: at.epoch,
        seq: 20,
        kind: "turn",
        git: {
          ...v1.built.manifest.sections.git,
          packs: [at.basePack, partial.key],
          refs: {
            ...v1.built.manifest.sections.git.refs,
            [WORKTREE_TREE_REF]: partial.tree,
            [INDEX_TREE_REF]: partial.tree,
          },
        },
      });
      await run(uploadObjects(new Map([...partial.objects, [broken.key, broken.bytes]])));
      expect((await run(at.register(broken))).head_n).toBe(2);
      expect(world.memory.captures.get(broken.id)?.gitFsck).toBe("failed");
      const refused = await at.planExit();
      // Before: 200, capture 1's sections under capture 2's identity — which sealantd, restoring
      // the head's own manifest from its key, never lays down — and `restored capture 1`.
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        const error = Cause.findErrorOption(refused.cause);
        expect(Option.isSome(error) ? [error.value.status, error.value.reason] : null).toEqual([
          422,
          "unrestorable",
        ]);
      }
      expect(at.notices.at(-1)).toEqual({
        kind: "blocked",
        words: planBlockedWords(2),
        launchId: at.lastLaunch(),
      });
      expect(planBlockedWords(2)).toBe(
        "launch blocked · capture 2's git section failed verification · discard or contact the operator",
      );
      // Nothing was claimed: the refused launch holds no epoch.
      const lease = await run(
        Effect.flatMap(CaptureStoreRepo, (repo) => repo.leaseOf(at.worktreeId)),
      );
      expect(lease?.executorId ?? null).toBeNull();
      // Still git's word on its bytes: checked again, still `failed`.
      expect(world.memory.captures.get(broken.id)?.gitFsck).toBe("failed");
    },
  );

  it(
    "review 14 #2: the holder's own re-plan and its recovery boot get their own `auto` head at once under a host fault, and shipping goes on",
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const v1 = await at.capture(1, at.cap0Id, "turn", "recovery v1");
      expect((await run(at.register(v1.built))).head_n).toBe(1);
      const v2 = await at.capture(2, v1.built.id, "auto", "recovery v2 (auto head)");
      expect((await run(at.register(v2.built))).head_n).toBe(2);
      expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("unverified");
      faults.arm("index-pack", "kill");
      try {
        // The holder asks again at its epoch (a daemon restart on its own disk): the head as it
        // stands, never a wait on a check of a head it does not restore.
        const replan = await run(at.api.planGet({ worktree_id: at.worktreeId, epoch: at.epoch }));
        expect(replan.head?.n).toBe(2);
        expect(replan.epoch).toBe(at.epoch);
        expect(at.notices.at(-1)).toEqual({ kind: "planned", launchId: "launch-1" });
        // The lease lapses (the executor crashed); Core boots the kept disk in recovery mode,
        // as the launch it was, asking from zero.
        const realNow = world.memory.clock.now;
        world.memory.clock.now = () => realNow() + 10 * 60 * 1000;
        let recovered;
        try {
          recovered = await run(at.api.planGet({ worktree_id: at.worktreeId, epoch: 0 }));
        } finally {
          world.memory.clock.now = realNow;
        }
        // Before: 409 `worktree-leased` on both, for as long as the host fault lasts, and the
        // recovery shipped nothing.
        expect(recovered.head?.capture_id).toBe(v2.built.id);
        expect(recovered.epoch).toBeGreaterThan(at.epoch);
        expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("unverified");
        // Its staged capture ships under the new epoch.
        const recoveredApi = await run(at.routesFor("launch-1"));
        const edited = packEditedTree(
          world.work,
          at.worktreeId,
          recovered.epoch,
          world.baseSha,
          (dir) => fs.writeFileSync(path.join(dir, "a.txt"), "recovery v3 (shipped)\n"),
        );
        const v3 = buildManifest({
          worktreeId: at.worktreeId,
          n: 3,
          parent: v2.built.id,
          epoch: recovered.epoch,
          seq: 30,
          kind: "auto",
          git: {
            ...v2.built.manifest.sections.git,
            packs: [at.basePack, edited.key],
            refs: {
              ...v2.built.manifest.sections.git.refs,
              [WORKTREE_TREE_REF]: edited.tree,
              [INDEX_TREE_REF]: edited.tree,
            },
          },
        });
        await run(uploadObjects(new Map([...edited.objects, [v3.key, v3.bytes]])));
        const shipped = await run(
          recoveredApi.register({
            worktree_id: at.worktreeId,
            epoch: recovered.epoch,
            n: 3,
            parent: v2.built.id,
            capture_id: v3.id,
            manifest_key: v3.key,
            manifest: v3.manifest,
          }),
        );
        expect(shipped.head_n).toBe(3);
      } finally {
        faults.recover("index-pack", "kill");
      }
      // A new launch's plan lays the head down, so it checks it: the host recovered, verified.
      const fresh = await at.plan();
      expect(fresh.head?.n).toBe(3);
    },
  );

  it(
    `review 14 #4: git exiting 128 in the same words nothing explains, ${UNEXPLAINED_CHECKS_BOUND} checks in a row, is recorded \`failed\` and the plan stops waiting`,
    { timeout: 60_000 },
    async () => {
      const at = await claimedWorktree();
      const v1 = await at.capture(1, at.cap0Id, "turn", "bound v1");
      expect((await run(at.register(v1.built))).head_n).toBe(1);
      const v2 = await at.capture(2, v1.built.id, "auto", "bound v2 (auto head)");
      expect((await run(at.register(v2.built))).head_n).toBe(2);
      faults.arm("rev-list", "unexplained");
      const reasons: Array<string | null> = [];
      try {
        for (let ask = 0; ask < UNEXPLAINED_CHECKS_BOUND + 1; ask++) {
          const exit = await at.planExit();
          const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
          reasons.push(Option.isSome(error) ? error.value.reason : null);
        }
      } finally {
        faults.recover("rev-list", "unexplained");
      }
      // Before: `worktree-leased` on every ask, for good.
      expect(reasons).toEqual([
        ...Array.from({ length: UNEXPLAINED_CHECKS_BOUND - 1 }, () => "worktree-leased"),
        "unrestorable",
        "unrestorable",
      ]);
      expect(world.memory.captures.get(v2.built.id)?.gitFsck).toBe("failed");
      expect(at.notices.at(-1)).toMatchObject({ kind: "blocked", words: planBlockedWords(2) });
    },
  );
});

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

  // Review 2026-09-28 (9) #7 (the reviewer's overlay-hardlink fixture): a tracked hardlink group's
  // bytes were compared in the raw tree alone. The workspace overlay laid other bytes over one
  // member — the kinds still matched — the seal was recorded, and sealantd's relink replaced the
  // overlay's unique bytes with the first member's. Link equality is now checked over the files
  // the restore lays down: the overlay over the checkout over the bulk, ancestors included.
  it("review 9 #7 a tracked hardlink group is one set of bytes in the files the restore lays down, the workspace overlay included", async () => {
    const at = await claimedWorktree();
    const attempt = async (tree: { readonly a: string; readonly b: string }, overlayB: string) => {
      const edit = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) => {
        fs.writeFileSync(path.join(work, "a.txt"), tree.a);
        fs.writeFileSync(path.join(work, "b.txt"), tree.b);
      });
      const meta = withMeta(at.worktreeId, at.epoch, {
        format: 1,
        entries: ["a.txt", "b.txt"].map((name) => ({
          path: name,
          kind: "file",
          mode: 0o644,
          mtime: 100000000000,
        })),
        hardlinks: [["a.txt", "b.txt"]],
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r9-overlay-"));
      fs.mkdirSync(path.join(dir, "tree"));
      fs.writeFileSync(path.join(dir, "tree", "b.txt"), overlayB);
      const overlay = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), { format: 2 });
      fs.rmSync(dir, { recursive: true, force: true });
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r9-empty-bulk-"));
      const emptyBulk = snapshotDirectory(emptyDir, captureKeys(at.worktreeId, at.epoch), {
        format: 2,
      });
      fs.rmSync(emptyDir, { recursive: true, force: true });
      const head = await run(
        Effect.flatMap(CaptureStoreRepo, (repo) => repo.headOf(at.worktreeId)),
      );
      const cap = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n: (head?.headN ?? 0) + 1,
          parent: head?.head?.id ?? at.cap0Id,
          seq: 300 + (head?.headN ?? 0),
          kind: "final",
          git: { ...at.gitSection([at.basePack, edit.key], edit.tree), raw_tree: edit.tree },
          workspace: {
            ...sectionOf(overlay),
            packs: [...overlay.packs, ...meta.workspace.packs],
            worktree_meta: meta.workspace.worktree_meta,
          },
          bulk: { ...sectionOf(emptyBulk), platform: "linux-x86_64-gnu" },
        }),
      );
      await run(
        uploadObjects(
          new Map([
            ...edit.objects,
            ...overlay.objects,
            ...emptyBulk.objects,
            ...meta.objects,
            [cap.key, cap.bytes],
          ]),
        ),
      );
      const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)(cap));
      return { answer, sealed: (await sealOf(at.worktreeId, at.epoch))?.captureId === cap.id };
    };
    // The reviewer's case: one set of bytes in the raw tree, other bytes laid over b.txt.
    const overwritten = await attempt(
      { a: "base group bytes\n", b: "base group bytes\n" },
      "new unique overlay work\n",
    );
    expect(overwritten.sealed).toBe(false);
    expect(overwritten.answer.seal).toEqual({ state: "refused", reason: "unrestorable" });
    // The overlay lays down the group's own bytes: one set of bytes, sealed.
    const same = await attempt(
      { a: "base group bytes\n", b: "base group bytes\n" },
      "base group bytes\n",
    );
    expect(same.sealed).toBe(true);
    // Different bytes in the raw tree, made one set by the overlay: what the restore lays down
    // decides, and it is one set.
    const joined = await attempt({ a: "joined bytes\n", b: "raw other bytes\n" }, "joined bytes\n");
    expect(joined.sealed).toBe(true);
  });

  it(
    "#18 a sealing capture whose git section fails verification registers and seals nothing; its holder's plan carries no seal",
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
      // Its holder's own re-plan (review 2026-09-28 (14) #2): the head, without the seal.
      expect(plan.head?.capture_id).toBe(cap1.id);
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

  // Review 2026-09-28 (8) #10 (the reviewer's characterization): a healthy `git init
  // --object-format=sha256` repository's final capture registered `gitFsck: "verified"` — the
  // verifier kept only 40-digit tips, and with none left it walked nothing and said verified. The
  // section names its object format (`object_format`, sealantd's manifest feature); Mend walks a
  // SHA-256 section's 64-digit tips in a SHA-256 repository, and a tip of another width than the
  // section's format is never verified.
  describe("review 8 #10 a SHA-256 git section is walked, never verified unwalked", () => {
    const registerFinal = async (
      at: Awaited<ReturnType<typeof claimedWorktree>>,
      n: number,
      parent: string,
      git: ReturnType<typeof section>,
      objects: ReadonlyMap<string, Uint8Array>,
      workspace?: CaptureManifest["sections"]["workspace"],
    ) => {
      const cap = sealing(
        at.worktreeId,
        at.epoch,
        buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n,
          parent,
          seq: 200 + n,
          kind: "final",
          git,
          bulk: READY_EMPTY_BULK,
          ...(workspace === undefined ? {} : { workspace }),
        }),
      );
      await run(uploadObjects(new Map([...objects, [cap.key, cap.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(cap));
      const row = await run(Effect.flatMap(CaptureStoreRepo, (repo) => repo.captureById(cap.id)));
      return { cap, gitFsck: row?.gitFsck, seal: await sealOf(at.worktreeId, at.epoch) };
    };

    it(
      "a SHA-256 section whose pack lacks the tree it names fails; the whole closure verifies and seals",
      { timeout: 60_000 },
      async () => {
        const at = await claimedWorktree();
        const repo = sha256Repo(at);
        expect(repo.commit).toMatch(/^[0-9a-f]{64}$/);
        const partial = await registerFinal(
          at,
          1,
          at.cap0Id,
          section([repo.commitOnly.key], repo, "sha256"),
          repo.commitOnly.objects,
        );
        expect(partial.gitFsck).toBe("failed");
        expect(partial.seal).toBeNull();
        const whole = await registerFinal(
          at,
          2,
          partial.cap.id,
          section([repo.whole.key], repo, "sha256"),
          repo.whole.objects,
        );
        expect(whole.gitFsck).toBe("verified");
        expect(whole.seal?.captureId).toBe(whole.cap.id);
        // The plan hands the format on, and only to an executor that reads it.
        const plan = await run(
          at.api.planGet({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            manifest_format: 2,
            manifest_features: MANIFEST_FEATURES,
          }),
        );
        expect(plan.head?.manifest.sections.git.object_format).toBe("sha256");
        const unread = await run(
          at.api
            .planGet({
              worktree_id: at.worktreeId,
              epoch: at.epoch,
              manifest_format: 2,
              manifest_features: MANIFEST_FEATURES.filter((feature) => feature !== "object_format"),
            })
            .pipe(Effect.flip),
        );
        expect(unread.missing).toEqual(["object_format"]);
      },
    );

    // sealantd review 9 #1 (cross-repo decision 24): a reftable repository's section names its
    // ref backend (`ref_format`). Mend walks it in a repository of that backend, hands the
    // backend on only to an executor that reads it, and verifies nothing under one it does not
    // read.
    it(
      "review 9 a reftable section verifies in a reftable repository and is planned only to a reader; an unknown ref backend is never verified",
      { timeout: 60_000 },
      async () => {
        const at = await claimedWorktree();
        const repo = sha256Repo(at, ["--ref-format=reftable"]);
        expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
        const unknown = await registerFinal(
          at,
          1,
          at.cap0Id,
          section([repo.whole.key], repo, undefined, "packed-v9"),
          repo.whole.objects,
        );
        expect(unknown.gitFsck).toBe("unverified");
        expect(unknown.seal).toBeNull();
        // HEAD read from a reftable repository's `.git/HEAD` file: its stub, never verified.
        const stub = await registerFinal(
          at,
          2,
          unknown.cap.id,
          {
            ...section([repo.whole.key], repo, undefined, "reftable"),
            head: "refs/heads/.invalid",
          },
          repo.whole.objects,
        );
        expect(stub.gitFsck).toBe("unverified");
        expect(stub.seal).toBeNull();
        // The workspace class brings the backend's own files back byte for byte, and symlinks at
        // `.git/HEAD` and under `.git/refs/` with any text, as the repository held them.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r9-reftable-class-"));
        fs.mkdirSync(path.join(dir, ".git", "reftable"), { recursive: true });
        fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".git", "reftable", "tables.list"), "");
        fs.symlinkSync("refs/heads/main", path.join(dir, ".git", "HEAD"));
        fs.symlinkSync("../../../elsewhere/any text", path.join(dir, ".git", "refs", "heads", "x"));
        const gitClass = snapshotDirectory(dir, captureKeys(at.worktreeId, at.epoch), {
          format: 2,
        });
        fs.rmSync(dir, { recursive: true, force: true });
        const reftable = await registerFinal(
          at,
          3,
          stub.cap.id,
          section([repo.whole.key], repo, undefined, "reftable"),
          new Map([...repo.whole.objects, ...gitClass.objects]),
          sectionOf(gitClass),
        );
        expect(reftable.gitFsck).toBe("verified");
        expect(reftable.seal?.captureId).toBe(reftable.cap.id);
        const plan = await run(
          at.api.planGet({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            manifest_format: 2,
            manifest_features: MANIFEST_FEATURES,
          }),
        );
        expect(plan.head?.manifest.sections.git.ref_format).toBe("reftable");
        const unread = await run(
          at.api
            .planGet({
              worktree_id: at.worktreeId,
              epoch: at.epoch,
              manifest_format: 2,
              manifest_features: MANIFEST_FEATURES.filter((feature) => feature !== "ref_format"),
            })
            .pipe(Effect.flip),
        );
        expect(unread.missing).toEqual(["ref_format"]);
      },
    );

    it(
      "64-digit tips in a section that names no object format are never verified",
      { timeout: 60_000 },
      async () => {
        const at = await claimedWorktree();
        const repo = sha256Repo(at);
        const unnamed = await registerFinal(
          at,
          1,
          at.cap0Id,
          section([repo.whole.key], repo),
          repo.whole.objects,
        );
        expect(unnamed.gitFsck).not.toBe("verified");
        expect(unnamed.seal).toBeNull();
      },
    );
  });

  // Review 2026-09-28 (8) #3, Mend's side: one symlink inode with several names. sealantd leaves
  // such a final flush incomplete; a document that says so anyway is never sealed on.
  it("review 8 #3 a hardlink group of symlinks is never sealed", async () => {
    const at = await claimedWorktree();
    const edit = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) => {
      fs.symlinkSync("target", path.join(work, "link-a"));
      fs.symlinkSync("target", path.join(work, "link-b"));
    });
    const meta = withMeta(at.worktreeId, at.epoch, {
      format: 1,
      entries: [
        { path: "link-a", kind: "symlink", mode: 0o777, mtime: 100 },
        { path: "link-b", kind: "symlink", mode: 0o777, mtime: 100 },
      ],
      hardlinks: [["link-a", "link-b"]],
    });
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
        workspace: meta.workspace,
        bulk: READY_EMPTY_BULK,
      }),
    );
    await run(uploadObjects(new Map([...edit.objects, ...meta.objects, [cap.key, cap.bytes]])));
    const answer = await run(
      registerOn(
        at.worktreeId,
        at.epoch,
        at.api,
      )(cap).pipe(
        Effect.map((ok) => ok.seal?.state ?? "absent"),
        // Refused at register, or registered with its seal refused: never recorded.
        Effect.catch(() => Effect.succeed("refused")),
      ),
    );
    expect(answer).toBe("refused");
    expect(await sealOf(at.worktreeId, at.epoch)).toBeNull();
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
        // One inode: both names stat the same mode and mtime (review 2026-09-28 (8) #9).
        fs.chmodSync(path.join(workspaceDir, "tree", "ignored.bin"), 0o644);
        fs.utimesSync(path.join(workspaceDir, "tree", "ignored.bin"), 100, 100);
        const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cross-bulk-"));
        fs.mkdirSync(path.join(bulkDir, "node_modules"));
        if (bulkBytes !== null) {
          fs.writeFileSync(path.join(bulkDir, "node_modules", "linked.bin"), bulkBytes);
          fs.chmodSync(path.join(bulkDir, "node_modules", "linked.bin"), 0o644);
          fs.utimesSync(path.join(bulkDir, "node_modules", "linked.bin"), 100, 100);
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
  options: {
    readonly blobs?: (root: string) => Layer.Layer<BlobStore>;
    readonly skip?: boolean;
    readonly policy?: Partial<CaptureUploadPolicy["Service"]>;
  },
  body: (harness: SealHarness) => void,
) =>
  describe.skipIf(options.skip === true)(title, () => {
    const world = makeCaptureWorld({
      ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
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
      // Sized to the call (e2e8): the shortest URL, plus the clock margin.
      expect(authority?.getTime() ?? 0).toBeGreaterThan(
        clock + (PUT_URL_TTL_MIN_SECONDS + PUT_URL_CLOCK_MARGIN_SECONDS) * 1000 - 5_000,
      );
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

      // An older daemon re-asking for the stored pack (answered a URL before a seal, review
      // 2026-09-28 (7) #7): once a seal of the epoch is recorded, no URL that could replace what
      // it names is handed out (cross-repo decision 26, review 2026-09-28 (9) #6). Refused, and
      // the seal stands.
      const legacy = await run(
        at.api
          .uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [file.key],
            sizes: { [file.key]: file.bytes.length },
          })
          .pipe(Effect.flip),
      );
      expect(legacy.reason).toBe("exists");
      expect(legacy.key).toBe(file.key);
      expect((await seals(at))?.captureId).toBe(file.cap.id);
      // A URL for an object the seal does not name is handed out: withheld again until it
      // expires, then every object the seal names is read back. One of them is found replaced
      // (out of band) with bytes of the same length.
      const other = sealedFile(at, "other unsaved bytes\n");
      const fresh = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [other.key],
          sizes: { [other.key]: other.bytes.length },
        }),
      );
      expect(typeof fresh.urls[other.key]).toBe("string");
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

    it("review 13 #1: a read-back whose index-pack the Mend host could not finish leaves the seal withheld, never void; the next read stands", async () => {
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
      bucketReplaceableUntil = clock - 60_000;
      const at = await claimed();
      const file = sealedFile(at, "review 13 read-back bytes\n");
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect((await recorded(at))?.captureId).toBe(file.cap.id);
      // A URL of the epoch is handed out, then expires: every object is read back again.
      const other = sealedFile(at, "review 13 other bytes\n");
      await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [other.key],
          sizes: { [other.key]: other.bytes.length },
        }),
      );
      clock = (world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0) + 1;
      const faults = hostGitFaults();
      try {
        faults.arm("index-pack", "kill");
        let during;
        try {
          during = await seals(at);
        } finally {
          expect(faults.recover("index-pack", "kill")).toBe(true);
        }
        // Before: `… does not index …` — void, for good.
        expect(during).toBeNull();
        expect((await recorded(at))?.voidReason ?? null).toBeNull();
        expect((await seals(at))?.captureId).toBe(file.cap.id);
      } finally {
        faults.remove();
      }
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
      // A URL for an object the seal does not name (one it names is never handed out once the
      // seal is recorded, review 2026-09-28 (9) #6).
      const other = sealedFile(at, "other saved bytes\n");
      let minted = false;
      authorityDuringReadBack = async () => {
        const answer = await run(
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [other.key],
            sizes: { [other.key]: other.bytes.length },
          }),
        );
        minted = typeof answer.urls[other.key] === "string";
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
      // The identical register again (a lost answer): where the seal stands now.
      expect(
        (await run(registerOn(strict.worktreeId, strict.epoch, strict.api)(onStrict.cap))).seal,
      ).toEqual({ state: "recorded" });
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

      // Not complete: refused `incomplete`. A manifest carrying no seal: no `seal` answered.
      const unfinished = await claimed();
      const partial = sealedFile(unfinished, "partial bytes\n");
      const partialManifest = {
        ...partial.cap.manifest,
        final_seal: { complete: false, epoch: unfinished.epoch, executor: "executor-1" },
      };
      const partialBytes = new Uint8Array(Buffer.from(JSON.stringify(partialManifest)));
      const partialId = sha256Hex(partialBytes);
      const partialCap = {
        manifest: partialManifest,
        bytes: partialBytes,
        id: partialId,
        key: captureKeys(unfinished.worktreeId, unfinished.epoch).manifest(partialId),
      };
      await run(
        uploadObjects(new Map([...partial.snapshot.objects, [partialCap.key, partialBytes]])),
      );
      expect(
        (await run(registerOn(unfinished.worktreeId, unfinished.epoch, unfinished.api)(partialCap)))
          .seal,
      ).toEqual({ state: "refused", reason: "incomplete" });
      const { final_seal: _none, ...unsealedManifest } = partial.cap.manifest;
      const unsealedBytes = new Uint8Array(
        Buffer.from(JSON.stringify({ ...unsealedManifest, n: 2, parent: partialId })),
      );
      const unsealedId = sha256Hex(unsealedBytes);
      await run(
        uploadObjects(
          new Map([
            [
              captureKeys(unfinished.worktreeId, unfinished.epoch).manifest(unsealedId),
              unsealedBytes,
            ],
          ]),
        ),
      );
      const plain = await run(
        registerOn(
          unfinished.worktreeId,
          unfinished.epoch,
          unfinished.api,
        )({
          manifest: { ...unsealedManifest, n: 2, parent: partialId },
          id: unsealedId,
          key: captureKeys(unfinished.worktreeId, unfinished.epoch).manifest(unsealedId),
        }),
      );
      expect(plain.head_capture_id).toBe(unsealedId);
      expect("seal" in plain).toBe(false);
    });

    it("the additive manifest fields register and are planned as written: workspace root_links, git object_format", async () => {
      bucketReplaceable = 0;
      const at = await claimed();
      const file = sealedFile(at, "linked roots\n");
      const manifest = {
        ...file.cap.manifest,
        sections: {
          ...file.cap.manifest.sections,
          workspace: {
            ...file.cap.manifest.sections.workspace,
            root_links: { ".git": "../dotgit" },
          },
        },
      };
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      const id = sha256Hex(bytes);
      const key = captureKeys(at.worktreeId, at.epoch).manifest(id);
      await run(uploadObjects(new Map([...file.snapshot.objects, [key, bytes]])));
      const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)({ manifest, id, key }));
      expect(answer.seal).toEqual({ state: "recorded" });
      expect((await planned(at)).head?.manifest.sections.workspace.root_links).toEqual({
        ".git": "../dotgit",
      });
    });
  },
);

// Review 2026-09-28 (9) #6, cross-repo decision 26: once a seal of the epoch is recorded, no URL
// that could replace an object it names is handed out — even for a key the bucket did not hold
// when the call first asked (it was stored and sealed before the authority was recorded). Every
// key about to get a URL is asked of the bucket again once a seal is seen: stored, it is answered
// `present` (a launch that reads it) or refused (any other), and no authority is recorded.
/** Keys whose next `head` answers absent: the bucket as a call saw it before the seal landed. */
const headMisses = new Set<string>();
/** The bucket's answer to `replaceableUntil` in the suite below (Garage: it ignores `If-None-Match`). */
let replaceableBucket = 0;
describeSeals(
  "review 9 #6 no upload URL for an object a recorded seal names",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.sync(() => replaceableBucket),
          head: (key: string) => (headMisses.delete(key) ? Effect.succeed(null) : store.head(key)),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    it("a key stored and sealed after the call's first look is answered present or refused, never a URL", async () => {
      replaceableBucket = Date.now() - 60_000;
      const at = await claimed();
      const file = sealedFile(at, "sealed unique bytes\n");
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      const registered = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(registered.seal).toEqual({ state: "recorded" });
      const authority = () => world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`);
      const ask = () =>
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        });
      // A launch that does not read `present` (an older daemon): refused.
      headMisses.add(file.key);
      const refused = await run(ask().pipe(Effect.flip));
      expect(refused.reason).toBe("exists");
      expect(refused.key).toBe(file.key);
      expect(authority()).toBeUndefined();
      // A launch that reads `present`: answered present, no URL.
      await run(
        at.api.planGet({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          manifest_format: 2,
          manifest_features: MANIFEST_FEATURES,
          upload_answers: [UPLOAD_ANSWER_PRESENT],
        }),
      );
      headMisses.add(file.key);
      const answered = await run(ask());
      expect(answered.urls).toEqual({});
      expect(answered.present).toEqual([file.key]);
      expect(authority()).toBeUndefined();
      // The seal still stands: nothing could replace what it names.
      const standing = await run(
        Effect.flatMap(CaptureSeals, (service) =>
          service.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
        ).pipe(Effect.provide(CaptureSealsStoreLive)),
      );
      expect(standing?.captureId).toBe(file.cap.id);
      // An object the seal does not name still gets a URL, its authority recorded.
      const other = sealedFile(at, "later unsaved bytes\n");
      const fresh = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [other.key],
          sizes: { [other.key]: other.bytes.length },
        }),
      );
      expect(typeof fresh.urls[other.key]).toBe("string");
      expect(authority()?.getTime() ?? 0).toBeGreaterThan(Date.now());
    });
  },
);

// Garage self-host, 2026-10-02: a Stop's seal waited 10.5 minutes for the upload URLs of its
// epoch to expire. An executor that sends `x-amz-checksum-sha256` (`UPLOAD_ANSWER_SHA256`) gets URLs
// bound to their bytes on a store that checks them (`bindsBytes`): none of them can replace an
// object, so none is recorded as write authority, and the seal stands as soon as it registers.
const presigned: Array<{ readonly key: string; readonly sha256: string | undefined }> = [];
describeSeals(
  "bytes-bound upload URLs: no write authority, no wait",
  {
    // A world started this instant: no process before it handed out URLs.
    policy: { boundIndexTrustedAfterMs: 0 },
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          // Garage: it replaces objects, but checks a signed checksum. This process's own window
          // (a URL minted before it started), and the clock margin past it, are over.
          replaceableUntil: () => Effect.sync(() => Date.now() - 10 * 60_000),
          bindsBytes: Effect.succeed(true),
          presign: (
            key: string,
            method: "GET" | "PUT",
            ttl: number,
            length?: number,
            sha256?: string,
          ) =>
            Effect.sync(() => {
              if (method === "PUT") presigned.push({ key, sha256 });
            }).pipe(Effect.andThen(store.presign(key, method, ttl, length, sha256))),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    const plan = (at: Awaited<ReturnType<typeof claimed>>, answers: ReadonlyArray<string>) =>
      run(
        at.api.planGet({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          manifest_format: 2,
          manifest_features: MANIFEST_FEATURES,
          upload_answers: [...answers],
        }),
      );
    const authority = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
      world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`);
    const sealOf = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
      run(
        Effect.flatMap(CaptureSeals, (service) =>
          service.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
        ).pipe(Effect.provide(CaptureSealsStoreLive)),
      );
    const recordedSeal = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
      run(
        Effect.flatMap(CaptureStoreRepo, (repo) =>
          repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
        ),
      );

    it("binds every URL to its bytes, records no authority, and the seal stands as it registers", async () => {
      presigned.length = 0;
      const at = await claimed();
      await plan(at, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const file = sealedFile(at, "bound unique bytes\n");
      const index = `${file.key}.idx`;
      const indexDigest = "c".repeat(64);
      const minted = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key, index],
          sizes: { [file.key]: file.bytes.length, [index]: 12 },
          sha256: { [index]: indexDigest },
        }),
      );
      expect(Object.keys(minted.urls).toSorted()).toEqual([file.key, index].toSorted());
      // The pack is bound to the SHA-256 its name says; the index to the one declared.
      expect(presigned).toEqual([
        { key: file.key, sha256: file.key.slice(file.key.lastIndexOf("/") + 1) },
        { key: index, sha256: indexDigest },
      ]);
      expect(authority(at)).toBeUndefined();
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      const registered = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(registered.seal).toEqual({ state: "recorded" });
      // Nothing could replace what it names: it stands now, not 10.5 minutes from now, and
      // nothing was read back for it.
      expect((await sealOf(at))?.captureId).toBe(file.cap.id);
      expect((await recordedSeal(at))?.reverifiedAt ?? null).toBeNull();
    });

    it("keeps an index's URLs to one SHA-256, and refuses a declared SHA-256 its name contradicts", async () => {
      const at = await claimed();
      await plan(at, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const file = sealedFile(at, "bound index bytes\n");
      const index = `${file.key}.idx`;
      const ask = (sha256: Record<string, string>, key = index) =>
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [key],
          sizes: { [key]: 12 },
          sha256,
        });
      await run(ask({ [index]: "a".repeat(64) }));
      await run(ask({ [index]: "a".repeat(64) }));
      const other = await run(ask({ [index]: "b".repeat(64) }).pipe(Effect.flip));
      expect(other.status).toBe(409);
      const contradicted = await run(
        ask({ [file.key]: "d".repeat(64) }, file.key).pipe(Effect.flip),
      );
      expect(contradicted.status).toBe(400);
      expect(authority(at)).toBeUndefined();
    });

    it("review: two calls at once cannot bind one index to two digests", async () => {
      const at = await claimed();
      await plan(at, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const index = `${sealedFile(at, "raced index bytes\n").key}.idx`;
      const ask = (digest: string) =>
        at.api
          .uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [index],
            sizes: { [index]: 12 },
            sha256: { [index]: digest },
          })
          .pipe(Effect.result);
      const both = await run(
        Effect.all([ask("e".repeat(64)), ask("f".repeat(64))], { concurrency: "unbounded" }),
      );
      expect(both.filter((one) => one._tag === "Success")).toHaveLength(1);
      const refused = both.find((one) => one._tag === "Failure");
      expect(refused?._tag === "Failure" ? refused.failure.status : null).toBe(409);
    });

    it("review: a call with a part URL records authority, as part bytes are not bound", async () => {
      const at = await claimed();
      await plan(at, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const big = captureKeys(at.worktreeId, at.epoch).pack("9".repeat(64));
      const minted = await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [big],
          sizes: { [big]: 40 * 1024 * 1024 },
        }),
      );
      expect(Object.keys(minted.multipart)).toEqual([big]);
      expect(authority(at)?.getTime() ?? 0).toBeGreaterThan(Date.now());
    });

    it("review: a seal whose epoch's row is gone is read back, never taken as holding no authority", async () => {
      const at = await claimed();
      await plan(at, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const file = sealedFile(at, "a row that went away\n");
      await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      const registered = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(registered.seal).toEqual({ state: "recorded" });
      // The epoch's row goes with its worktree: the seal is read back as before the change — it
      // stands re-verified — never taken as standing over an epoch known to hold nothing.
      world.memory.deletedWorktrees.add(at.worktreeId);
      expect((await sealOf(at))?.captureId).toBe(file.cap.id);
      expect((await recordedSeal(at))?.reverifiedAt).toBeInstanceOf(Date);
    });

    it("records authority as before for an executor that sends no checksum, and for an index it declares nothing about", async () => {
      const older = await claimed();
      await plan(older, [UPLOAD_ANSWER_PRESENT]);
      const file = sealedFile(older, "unbound unique bytes\n");
      await run(
        older.api.uploadUrls({
          worktree_id: older.worktreeId,
          epoch: older.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        }),
      );
      expect(authority(older)?.getTime() ?? 0).toBeGreaterThan(Date.now());

      const undeclared = await claimed();
      await plan(undeclared, [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]);
      const index = `${sealedFile(undeclared, "an index nobody hashed\n").key}.idx`;
      await run(
        undeclared.api.uploadUrls({
          worktree_id: undeclared.worktreeId,
          epoch: undeclared.epoch,
          keys: [index],
          sizes: { [index]: 12 },
        }),
      );
      expect(authority(undeclared)?.getTime() ?? 0).toBeGreaterThan(Date.now());
    });
  },
);

describeSeals(
  "bytes-bound upload URLs, a process just started",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.sync(() => Date.now() - 60_000),
          bindsBytes: Effect.succeed(true),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    it("review: binds no pack index until a process before it could have none live, and records its authority", async () => {
      const at = await claimed();
      await run(
        at.api.planGet({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          manifest_format: 2,
          manifest_features: MANIFEST_FEATURES,
          upload_answers: [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256],
        }),
      );
      const index = `${sealedFile(at, "an index too early\n").key}.idx`;
      await run(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [index],
          sizes: { [index]: 12 },
          sha256: { [index]: "a".repeat(64) },
        }),
      );
      expect(
        world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0,
      ).toBeGreaterThan(Date.now());
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

    // Review 2026-09-28 (9) #6, cross-repo decision 26, on the real bucket: once the seal is
    // recorded, an older daemon re-asking for a stored pack it names is refused — on Garage that
    // URL would replace the sealed bytes — and one that reads `present` is answered present.
    it("review 9 #6 a recorded seal's stored pack is never handed an upload URL", async () => {
      const at = await claimed();
      const file = sealedFile(at, "sealed bytes on a real bucket\n");
      await run(uploadObjects(new Map([...file.snapshot.objects, [file.cap.key, file.cap.bytes]])));
      const registered = await run(registerOn(at.worktreeId, at.epoch, at.api)(file.cap));
      expect(["recorded", "withheld"]).toContain(registered.seal?.state);
      const ask = () =>
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [file.key],
          sizes: { [file.key]: file.bytes.length },
        });
      const plan = (answers: ReadonlyArray<string>) =>
        run(
          at.api.planGet({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            manifest_format: 2,
            manifest_features: MANIFEST_FEATURES,
            upload_answers: [...answers],
          }),
        );
      // An older daemon: its plan lists no `present`.
      await plan([]);
      const refused = await run(ask().pipe(Effect.flip));
      expect(refused.reason).toBe("exists");
      expect(refused.key).toBe(file.key);
      await plan([UPLOAD_ANSWER_PRESENT]);
      const answered = await run(ask());
      expect(answered.urls).toEqual({});
      expect(answered.present).toEqual([file.key]);
      const read = await run(
        readCaptureFileBytes(file.cap.manifest, "workspace", "tree/unique.txt"),
      );
      expect(Buffer.from(read).toString()).toBe("sealed bytes on a real bucket\n");
    });
  },
);

// Review 2026-09-28 (10) #5, cross-repo decision 31: a seal stands over the write authority of
// every epoch its objects live under, not only its own; and a request for upload URLs admitted
// under an epoch that ended while it read the bucket records nothing and mints nothing. The
// bucket here ignores conditional PUTs (Garage) and has forgotten which keys it minted URLs for
// (a restarted process): only the recorded authority (`capture_put_authority`) says a URL lives.
const review10StartupHorizon = Date.now() - 60_000;
let review10BlockedKey: string | undefined;
let review10HeadEntered: (() => void) | undefined;
let review10HeadResume: Promise<void> | undefined;
describeSeals(
  "review 10 #5 authority over a seal's inherited objects",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.succeed(review10StartupHorizon),
          head: (key: string) =>
            Effect.gen(function* () {
              const found = yield* store.head(key);
              if (key === review10BlockedKey && found === null) {
                review10BlockedKey = undefined;
                review10HeadEntered?.();
                yield* Effect.promise(() => review10HeadResume ?? Promise.resolve());
              }
              return found;
            }),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    /** Release `at`'s epoch and claim the next one for another launch, with its routes. */
    const nextLaunch = (at: { readonly worktreeId: WorktreeId; readonly epoch: number }) =>
      run(
        Effect.gen(function* () {
          const repo = yield* CaptureStoreRepo;
          yield* repo.release(at.worktreeId, at.epoch);
          const lease = yield* repo.claim(at.worktreeId, "executor-next", 3600, "launch-next");
          const api = (yield* CaptureChannel).apiFor({
            worktreeId: at.worktreeId,
            projectId: world.project.id,
            executorId: "executor-next",
            launchId: "launch-next",
            footprintBytes: 0,
          });
          return { epoch: lease.epoch, api };
        }),
      );
    /** A final capture of the next launch carrying `file`'s pack from the earlier epoch. */
    const inheritingFinal = (
      at: { readonly worktreeId: WorktreeId; readonly git: object },
      epoch: number,
      parent: string,
      file: ReturnType<typeof sealedFile>,
    ) => {
      const built = buildManifest({
        worktreeId: at.worktreeId,
        epoch,
        n: 2,
        parent,
        kind: "final",
        git: JSON.parse(JSON.stringify(at.git)),
        workspace: sectionOf(file.snapshot),
        bulk: READY_EMPTY_BULK,
      });
      const manifest = {
        ...built.manifest,
        final_seal: { complete: true, epoch, executor: "launch-next" },
      };
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      const id = sha256Hex(bytes);
      return { manifest, bytes, id, key: captureKeys(at.worktreeId, epoch).manifest(id) };
    };
    const standing = (worktreeId: WorktreeId, epoch: number) =>
      run(
        Effect.flatMap(CaptureSeals, (service) =>
          service.sealedCompletion(worktreeId, "launch-next", epoch),
        ).pipe(Effect.provide(CaptureSealsStoreLive)),
      );

    it("a new epoch's seal is withheld while an upload URL of the epoch whose pack it carries lives, and void once that pack reads back changed", async () => {
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      try {
        const at = await claimed();
        const file = sealedFile(at, "unique inherited work\n");
        const cap1 = buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n: 1,
          parent: at.cap0Id,
          kind: "turn",
          git: JSON.parse(JSON.stringify(at.git)),
          workspace: sectionOf(file.snapshot),
          bulk: READY_EMPTY_BULK,
        });
        // The old epoch is handed a URL for the pack, uploads it and registers.
        const urls = await run(
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [file.key],
            sizes: { [file.key]: file.bytes.length },
          }),
        );
        expect(typeof urls.urls[file.key]).toBe("string");
        await run(uploadObjects(new Map([...file.snapshot.objects, [cap1.key, cap1.bytes]])));
        await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
        const inheritedUntil =
          world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0;
        expect(inheritedUntil).toBeGreaterThan(clock);
        // The next launch seals a final capture that carries that pack.
        const next = await nextLaunch(at);
        const cap = inheritingFinal(at, next.epoch, cap1.id, file);
        await run(uploadObjects(new Map([[cap.key, cap.bytes]])));
        const answer = await run(registerOn(at.worktreeId, next.epoch, next.api)(cap));
        // The old epoch's URL could still replace the pack: the seal does not stand.
        expect(answer.seal).toEqual({ state: "withheld", reason: "write-authority" });
        expect(await standing(at.worktreeId, next.epoch)).toBeNull();
        expect(world.memory.seals.get(`${at.worktreeId}:${next.epoch}`)?.scopes).toEqual(
          [
            { worktreeId: at.worktreeId, epoch: at.epoch },
            { worktreeId: at.worktreeId, epoch: next.epoch },
          ].toSorted((a, b) => a.epoch - b.epoch),
        );
        // Which it does, before it expires …
        const stored = path.join(world.blobRoot, file.key);
        const changed = Buffer.from(file.bytes);
        changed[0] = (changed[0] ?? 0) ^ 0xff;
        fs.chmodSync(stored, 0o644);
        fs.writeFileSync(stored, changed);
        // … so once it has, the read-back finds other bytes: void, for good.
        clock = inheritedUntil + 1;
        expect(await standing(at.worktreeId, next.epoch)).toBeNull();
        expect(world.memory.seals.get(`${at.worktreeId}:${next.epoch}`)?.voidReason).toEqual(
          expect.any(String),
        );
      } finally {
        Date.now = realNow;
      }
    });

    it("a request admitted under an old epoch that resumes after a newer epoch's seal stands records no authority and mints no URL", async () => {
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      let resume: (() => void) | undefined;
      try {
        const at = await claimed();
        const file = sealedFile(at, "late inherited unique work\n");
        await run(
          at.api.planGet({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            manifest_format: 2,
            manifest_features: MANIFEST_FEATURES,
            upload_answers: [UPLOAD_ANSWER_PRESENT],
          }),
        );
        const cap1 = buildManifest({
          worktreeId: at.worktreeId,
          epoch: at.epoch,
          n: 1,
          parent: at.cap0Id,
          kind: "turn",
          git: JSON.parse(JSON.stringify(at.git)),
          workspace: sectionOf(file.snapshot),
          bulk: READY_EMPTY_BULK,
        });
        const entered = new Promise<void>((resolve) => {
          review10HeadEntered = resolve;
        });
        review10HeadResume = new Promise<void>((resolve) => {
          resume = resolve;
        });
        review10BlockedKey = file.key;
        const ask = () =>
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: [file.key],
            sizes: { [file.key]: file.bytes.length },
          });
        // The old request reads the pack absent, and waits there.
        const oldRequest = run(ask().pipe(Effect.flip));
        await entered;
        // A retry is handed the URL, uploads and registers; the epoch ends.
        expect(typeof (await run(ask())).urls[file.key]).toBe("string");
        await run(uploadObjects(new Map([...file.snapshot.objects, [cap1.key, cap1.bytes]])));
        await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
        const next = await nextLaunch(at);
        const cap = inheritingFinal(at, next.epoch, cap1.id, file);
        const minted = await run(
          next.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: next.epoch,
            keys: [cap.key],
            sizes: { [cap.key]: cap.bytes.length },
          }),
        );
        expect(typeof minted.urls[cap.key]).toBe("string");
        await run(uploadObjects(new Map([[cap.key, cap.bytes]])));
        expect((await run(registerOn(at.worktreeId, next.epoch, next.api)(cap))).seal?.state).toBe(
          "withheld",
        );
        // Every URL of both epochs expires; the seal is read back and stands.
        clock =
          Math.max(
            world.memory.putAuthority.get(`${at.worktreeId}:${next.epoch}`)?.getTime() ?? 0,
            world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)?.getTime() ?? 0,
          ) + 1;
        const accepted = await run(registerOn(at.worktreeId, next.epoch, next.api)(cap));
        expect(accepted.seal).toEqual({ state: "recorded" });
        const oldAuthority = world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`);
        // The old request resumes: its epoch is over, so it records nothing and mints nothing.
        resume?.();
        const late = await oldRequest;
        expect(late.reason).toBe("lease-lost");
        expect(world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`)).toEqual(oldAuthority);
        expect((await standing(at.worktreeId, next.epoch))?.captureId).toBe(cap.id);
      } finally {
        resume?.();
        Date.now = realNow;
        review10BlockedKey = undefined;
        review10HeadEntered = undefined;
      }
    });
  },
);

// Review 2026-09-28 (10) #5 on a real bucket that ignores `If-None-Match` (Garage): the old
// epoch's URL, minted before its pack was uploaded, really replaces that pack after a newer
// epoch sealed a capture carrying it — and that seal never stands on the replaced bytes. The
// process that reads the seal has been up past its startup horizon and did not mint that URL
// (another Mend replica did): only the recorded authority knows it lives.
describeSeals(
  "review 10 #5 on a real bucket (MEND_TEST_S3_URL)",
  {
    skip: garageConfig === null,
    blobs: (root) =>
      garageConfig === null
        ? BlobStoreFsLive(root)
        : Layer.effect(
            BlobStore,
            Effect.map(BlobStore, (store) => ({
              ...store,
              replaceableUntil: (key: string) =>
                store
                  .replaceableUntil(key)
                  .pipe(Effect.map((until) => (until === 0 ? 0 : review10StartupHorizon))),
            })),
          ).pipe(Layer.provide(BlobStoreS3Live(garageConfig))),
  },
  ({ world, run, claimed }) => {
    it("an old epoch's live URL replaces a pack a newer seal carries: the seal is withheld, then void", async () => {
      const at = await claimed();
      const file = sealedFile(at, "unique inherited bytes on a real bucket\n");
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
      const cap1 = buildManifest({
        worktreeId: at.worktreeId,
        epoch: at.epoch,
        n: 1,
        parent: at.cap0Id,
        kind: "turn",
        git: JSON.parse(JSON.stringify(at.git)),
        workspace: sectionOf(file.snapshot),
        bulk: READY_EMPTY_BULK,
      });
      await run(
        uploadObjects(
          new Map(
            [...file.snapshot.objects]
              .filter(([key]) => key !== file.key)
              .concat([[cap1.key, cap1.bytes]]),
          ),
        ),
      );
      await run(registerOn(at.worktreeId, at.epoch, at.api)(cap1));
      const next = await run(
        Effect.gen(function* () {
          const repo = yield* CaptureStoreRepo;
          yield* repo.release(at.worktreeId, at.epoch);
          const lease = yield* repo.claim(at.worktreeId, "executor-next", 3600, "launch-next");
          const api = (yield* CaptureChannel).apiFor({
            worktreeId: at.worktreeId,
            projectId: world.project.id,
            executorId: "executor-next",
            launchId: "launch-next",
            footprintBytes: 0,
          });
          return { epoch: lease.epoch, api };
        }),
      );
      const built = buildManifest({
        worktreeId: at.worktreeId,
        epoch: next.epoch,
        n: 2,
        parent: cap1.id,
        kind: "final",
        git: JSON.parse(JSON.stringify(at.git)),
        workspace: sectionOf(file.snapshot),
        bulk: READY_EMPTY_BULK,
      });
      const manifest = {
        ...built.manifest,
        final_seal: { complete: true, epoch: next.epoch, executor: "launch-next" },
      };
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
      const cap = {
        manifest,
        bytes,
        id: sha256Hex(bytes),
        key: captureKeys(at.worktreeId, next.epoch).manifest(sha256Hex(bytes)),
      };
      await run(uploadObjects(new Map([[cap.key, bytes]])));
      const answer = await run(registerOn(at.worktreeId, next.epoch, next.api)(cap));
      if (
        (await run(Effect.flatMap(BlobStore, (store) => store.replaceableUntil(file.key)))) === 0
      ) {
        // A bucket that honours the precondition: nothing can replace the pack.
        expect(answer.seal).toEqual({ state: "recorded" });
        return;
      }
      expect(answer.seal?.state).toBe("withheld");
      // The old epoch's URL replaces the carried pack's first byte.
      const bad = Buffer.from(file.bytes);
      bad[0] = (bad[0] ?? 0) ^ 0xff;
      expect((await fetch(url, { method: "PUT", headers, body: bad })).status).toBe(200);
      // Once every URL has expired, the read-back finds other bytes: void, never standing.
      const after = Date.now() + 2 * 60 * 60 * 1000;
      const standing = await run(
        Effect.flatMap(CaptureSeals, (service) =>
          service.sealedCompletion(at.worktreeId, "launch-next", next.epoch),
        ).pipe(Effect.provide(makeCaptureSealsStore({ now: () => after }))),
      );
      expect(standing).toBeNull();
      expect(world.memory.seals.get(`${at.worktreeId}:${next.epoch}`)?.voidReason).toEqual(
        expect.any(String),
      );
    });
  },
);

// e2e8 F2 (Mend repository on Garage): a sealing register re-read every bulk pack for every member
// its link checks looked up — the proof caches are void while an upload URL could replace the
// bytes — 4 m 35 s and ~40 GB of GETs for 0.78 GB of packs; sealantd timed it out at 60 s and
// retried, and every timed-out attempt ran on beside the next. Reads are now counted per key.
interface BucketReads {
  /** Whole-object GETs (`get`, `getStream`) by key. */
  readonly whole: Map<string, number>;
  /** Ranged GETs by key and extent. */
  readonly ranged: Map<string, number>;
  /** Every GET of either kind. */
  gets: number;
  /** Called on each whole GET, before it reads. */
  onWhole: ((key: string) => Promise<void>) | undefined;
  /** The next whole GET (or stream) of this key fails as the store not answering (a 503). */
  failOnce: string | undefined;
}
const bucketReads: BucketReads = {
  whole: new Map(),
  ranged: new Map(),
  gets: 0,
  onWhole: undefined,
  failOnce: undefined,
};
/** The bucket's answer to `replaceableUntil` in the suite below. */
let passBucketReplaceable: () => number = () => 0;
const resetReads = () => {
  bucketReads.whole.clear();
  bucketReads.ranged.clear();
  bucketReads.gets = 0;
  bucketReads.onWhole = undefined;
  bucketReads.failOnce = undefined;
};
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
describeSeals(
  "e2e8 F2 a sealing register reads each object at most once, answers within its budget, and is single-flight",
  {
    blobs: (root) =>
      Layer.effect(
        BlobStore,
        Effect.map(BlobStore, (store) => ({
          ...store,
          replaceableUntil: () => Effect.sync(() => passBucketReplaceable()),
          get: (key: string) =>
            Effect.gen(function* () {
              bump(bucketReads.whole, key);
              bucketReads.gets += 1;
              const hook = bucketReads.onWhole;
              if (hook !== undefined) yield* Effect.promise(() => hook(key));
              if (bucketReads.failOnce === key) {
                bucketReads.failOnce = undefined;
                return yield* new BlobStoreError({
                  operation: "get",
                  key,
                  cause: new Error("503 Service Unavailable"),
                });
              }
              return yield* store.get(key);
            }),
          getStream: (key: string) =>
            Effect.suspend(() => {
              bump(bucketReads.whole, key);
              bucketReads.gets += 1;
              if (bucketReads.failOnce === key) {
                bucketReads.failOnce = undefined;
                return Effect.fail(
                  new BlobStoreError({
                    operation: "get",
                    key,
                    cause: new Error("503 Service Unavailable"),
                  }),
                );
              }
              return store.getStream(key);
            }),
          getRange: (key: string, start: number, length: number) =>
            Effect.suspend(() => {
              bump(bucketReads.ranged, `${key} ${start}+${length}`);
              bucketReads.gets += 1;
              return store.getRange(key, start, length);
            }),
        })),
      ).pipe(Layer.provide(BlobStoreFsLive(root))),
  },
  ({ world, run, claimed }) => {
    const MEMBERS = 12;
    /**
     * The shape e2e8 hit: tracked files pnpm hardlinks into `node_modules` (`shared` links), the
     * bulk members spread over several packs that each hold many of them.
     */
    const sharedLinksCapture = (at: Awaited<ReturnType<typeof claimed>>, tag: string) => {
      const keys = captureKeys(at.worktreeId, at.epoch);
      const names = Array.from(
        { length: MEMBERS },
        (_, index) => `t${String(index).padStart(2, "0")}`,
      );
      const bytesOf = (name: string) => `${tag} ${name} ${"x".repeat(900)}\n`;
      const edited = packEditedTree(world.work, at.worktreeId, at.epoch, world.baseSha, (work) => {
        for (const name of names) fs.writeFileSync(path.join(work, name), bytesOf(name));
      });
      const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-e2e8-pass-bulk-"));
      const pkg = path.join(bulkDir, "node_modules", ".pnpm", "pkg");
      fs.mkdirSync(pkg, { recursive: true });
      for (const name of names) {
        const file = path.join(pkg, name);
        fs.writeFileSync(file, bytesOf(name));
        fs.chmodSync(file, 0o644);
        fs.utimesSync(file, 0, 0);
      }
      const bulk = snapshotDirectory(bulkDir, keys, { format: 2, packBudget: 4 * 1024 });
      fs.rmSync(bulkDir, { recursive: true, force: true });
      const meta = withMeta(at.worktreeId, at.epoch, {
        format: 1,
        entries: names.map((name) => ({ path: name, kind: "file", mode: 0o644, mtime: 0 })),
        shared: names.map((name) => ({
          path: name,
          class: "bulk",
          member: `node_modules/.pnpm/pkg/${name}`,
        })),
      });
      const built = sealing(
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
            packs: [packsOf(world.memory.captures.get(at.cap0Id)?.sections)[0] ?? "", edited.key],
            refs: {
              [`refs/heads/mend/wt/${at.worktreeId}`]: world.baseSha,
              [WORKTREE_TREE_REF]: edited.tree,
              [INDEX_TREE_REF]: edited.tree,
            },
            head: `refs/heads/mend/wt/${at.worktreeId}`,
            fsck: "verified" as const,
          },
          workspace: meta.workspace,
          bulk: { ...sectionOf(bulk), platform: "linux-x86_64-glibc" },
        }),
      );
      return {
        built,
        bulkPacks: bulk.packs,
        bulkDirPacks: bulk.dirPacks,
        objects: new Map([
          ...edited.objects,
          ...bulk.objects,
          ...meta.objects,
          [built.key, built.bytes],
        ]),
      };
    };
    /** Whole GETs of any one key, at most; and of `keys` in all. */
    const wholeReads = (keys: ReadonlyArray<string>) => ({
      most: Math.max(0, ...bucketReads.whole.values()),
      of: keys.reduce((total, key) => total + (bucketReads.whole.get(key) ?? 0), 0),
    });

    it("reads each pack whole at most once per register while an upload URL could replace it", async () => {
      // Garage inside the window: no proof from an earlier pass stands.
      passBucketReplaceable = () => Date.now() + 3_600_000;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "once");
      expect(capture.bulkPacks.length).toBeGreaterThan(2);
      await run(uploadObjects(capture.objects));
      resetReads();
      const answer = await run(registerOn(at.worktreeId, at.epoch, at.api)(capture.built));
      expect(answer.head_capture_id).toBe(capture.built.id);
      // Every check passed — recorded, and withheld only because a URL could still replace it.
      expect(answer.seal).toEqual({ state: "withheld", reason: "write-authority" });
      const reads = wholeReads(capture.bulkPacks);
      // Before: every bulk pack was read whole once for the payloads and once more per member
      // any link looked up (12 members: 20-odd GETs of each pack).
      expect(reads.most).toBe(1);
      expect(reads.of).toBe(capture.bulkPacks.length);
      // No extent is read twice either.
      expect(Math.max(0, ...bucketReads.ranged.values())).toBe(1);
    });

    /** Every GET, whole or ranged, of any of `keys`. */
    const readsOf = (keys: ReadonlyArray<string>) => {
      let total = 0;
      for (const [key, count] of bucketReads.whole) if (keys.includes(key)) total += count;
      for (const [extent, count] of bucketReads.ranged) {
        if (keys.includes(extent.slice(0, extent.indexOf(" ")))) total += count;
      }
      return total;
    };

    it("alpha 0.34.2: on a store that refuses overwrites a later seal reads none of what an earlier one proved; on one that does not it reads it all again", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "proven");
      const packs = [...capture.bulkPacks, ...capture.bulkDirPacks];
      await run(uploadObjects(capture.objects));
      resetReads();
      const first = await run(registerOn(at.worktreeId, at.epoch, at.api)(capture.built));
      expect(first.seal).toEqual({ state: "recorded" });
      // The first seal reads every pack: nothing was proven before it.
      const firstReads = readsOf(packs);
      expect(firstReads).toBeGreaterThanOrEqual(packs.length);
      // The executor's next FINAL over the same sections (a later Stop): every object it names
      // was read and hashed by the seal before, and the bucket refuses to replace any of them.
      const second = nextSealing(at, capture.built);
      await run(uploadObjects(new Map([[second.key, second.bytes]])));
      resetReads();
      const again = await run(registerOn(at.worktreeId, at.epoch, at.api)(second));
      expect(again.seal).toEqual({ state: "recorded" });
      // Before: every chunk a shared link's digest needs was read again (12 ranged GETs).
      expect(readsOf(packs)).toBe(0);
      expect(bucketReads.gets).toBeLessThan(firstReads);
      // A bucket that does not refuse overwrites, inside a URL's window: nothing proven before
      // stands, and the next seal reads every pack again — each whole at most once.
      passBucketReplaceable = () => Date.now() + 3_600_000;
      const third = nextSealing(at, second);
      await run(uploadObjects(new Map([[third.key, third.bytes]])));
      resetReads();
      const windowed = await run(registerOn(at.worktreeId, at.epoch, at.api)(third));
      expect(windowed.seal).toEqual({ state: "withheld", reason: "write-authority" });
      for (const key of packs) expect(bucketReads.whole.get(key)).toBe(1);
    });

    it("a retry of a register still running joins it, an abandoned attempt included: one verification", async () => {
      passBucketReplaceable = () => Date.now() + 3_600_000;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "joined");
      await run(uploadObjects(capture.objects));
      resetReads();
      // The first attempt stalls on its first bulk pack read, and its caller gives up on it —
      // sealantd's 60 s timeout.
      const { promise: stalled, resolve: release } = Promise.withResolvers<void>();
      const { promise: reachedPack, resolve: reached } = Promise.withResolvers<void>();
      bucketReads.onWhole = async (key) => {
        if (!capture.bulkPacks.includes(key)) return;
        bucketReads.onWhole = undefined;
        reached();
        await stalled;
      };
      const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
      const first = await run(Effect.forkDetach(register));
      await reachedPack;
      await Effect.runPromise(Fiber.interrupt(first));
      // Two retries arrive while it is still reading; then the read goes on.
      const retries = Promise.all([run(register), run(register)]);
      release();
      const [one, two] = await retries;
      expect(one).toEqual(two);
      expect(one.head_capture_id).toBe(capture.built.id);
      expect(one.seal).toEqual({ state: "withheld", reason: "write-authority" });
      // Before: each attempt verified the capture itself — every pack read three times over.
      expect(wholeReads(capture.bulkPacks).most).toBe(1);
      expect(world.memory.captures.get(capture.built.id)?.id).toBe(capture.built.id);
    });

    it("past its budget a register answers withheld (verifying), registers the capture, and the re-ask reads the seal once its checks pass", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "budget");
      await run(uploadObjects(capture.objects));
      const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
      const prompt = await run(register.pipe(Effect.provideService(CaptureRegisterBudget, 0)));
      // Registered at once — the chain moved — the seal not yet.
      expect(prompt.head_capture_id).toBe(capture.built.id);
      expect(world.memory.chains.get(at.worktreeId)?.headCapture).toBe(capture.built.id);
      expect(prompt.seal).toEqual({ state: "withheld", reason: "verifying" });
      // The executor's re-ask: recorded once the checks passed.
      const again = await run(register);
      expect(again.seal).toEqual({ state: "recorded" });
      expect(
        (
          await run(
            Effect.flatMap(CaptureStoreRepo, (repo) =>
              repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
            ),
          )
        )?.captureId,
      ).toBe(capture.built.id);
    });

    it("review 13 #1: a sealing FINAL whose git verification the Mend host could not finish (one index-pack OOM-killed) is withheld (unavailable), never refused, and the re-ask after recovery records it", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "review13-hostgit");
      await run(uploadObjects(capture.objects));
      resetReads();
      const faults = hostGitFaults();
      try {
        faults.arm("index-pack", "kill");
        const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
        let first;
        try {
          first = await run(register);
        } finally {
          expect(faults.recover("index-pack", "kill")).toBe(true);
        }
        // Before: `refused/unrestorable` on this and every later ask, the row `failed`.
        expect(first.head_capture_id).toBe(capture.built.id);
        expect(first.seal).toEqual({ state: "withheld", reason: "unavailable" });
        expect(world.memory.captures.get(capture.built.id)?.gitFsck).toBe("unverified");
        const again = await run(register);
        expect(again.seal).toEqual({ state: "recorded" });
        expect(world.memory.captures.get(capture.built.id)?.gitFsck).toBe("verified");
        expect(
          (
            await run(
              Effect.flatMap(CaptureStoreRepo, (repo) =>
                repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
              ),
            )
          )?.captureId,
        ).toBe(capture.built.id);
      } finally {
        faults.remove();
      }
    });

    it("review 12 #4: a read the store failed during the seal checks withholds the seal (unavailable), and the next ask checks again and records it", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "transient-read");
      await run(uploadObjects(capture.objects));
      resetReads();
      // One whole-pack GET answers 503: the store not answering, not a fact about the pack.
      bucketReads.failOnce = capture.bulkPacks[0];
      const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
      const first = await run(register);
      // Registered at once, the seal withheld as retryable — never refused as unrestorable.
      expect(first.head_capture_id).toBe(capture.built.id);
      expect(first.seal).toEqual({ state: "withheld", reason: "unavailable" });
      expect(world.memory.seals.get(`${at.worktreeId}:${at.epoch}`)).toBeUndefined();
      // The store answers again: the executor's re-ask checks again and the seal is recorded.
      const again = await run(register);
      expect(again.seal).toEqual({ state: "recorded" });
      expect(
        (
          await run(
            Effect.flatMap(CaptureStoreRepo, (repo) =>
              repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
            ),
          )
        )?.captureId,
      ).toBe(capture.built.id);
      expect(await run(register)).toEqual(again);
    });

    it("review 12 #4: a git section the verifier could not read withholds the seal (unavailable), and the re-ask verifies it again and records the seal", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "transient-git");
      await run(uploadObjects(capture.objects));
      resetReads();
      // The git pack's GET answers 503 while the runner prepares its cache afresh.
      fs.rmSync(runnerCachePathOf(path.join(world.scratch, "store"), world.project.id), {
        recursive: true,
        force: true,
      });
      bucketReads.failOnce = packsOf(world.memory.captures.get(at.cap0Id)?.sections)[0];
      const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
      const first = await run(register);
      expect(bucketReads.failOnce).toBeUndefined();
      expect(first.head_capture_id).toBe(capture.built.id);
      expect(first.seal).toEqual({ state: "withheld", reason: "unavailable" });
      expect(world.memory.captures.get(capture.built.id)?.gitFsck).toBe("unverified");
      const again = await run(register);
      expect(again.seal).toEqual({ state: "recorded" });
      expect(world.memory.captures.get(capture.built.id)?.gitFsck).toBe("verified");
    });

    it("review 12 #4: a seal verified after the register answered but whose record died is recorded on the next ask, not left verifying", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "transient-record");
      await run(uploadObjects(capture.objects));
      resetReads();
      const repo = await run(CaptureStoreRepo);
      const original = repo.recordSeal;
      let attempts = 0;
      // The first record dies (the database connection reset, as `.orDie` surfaces it).
      Object.assign(repo, {
        recordSeal: (...args: Parameters<typeof original>) =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 1 ? Effect.die("PostgreSQL connection reset") : original(...args);
          }),
      });
      try {
        const register = registerOn(at.worktreeId, at.epoch, at.api)(capture.built);
        const first = await run(register.pipe(Effect.provideService(CaptureRegisterBudget, 0)));
        expect(first.seal).toEqual({ state: "withheld", reason: "verifying" });
        const recordRan = () => attempts > 0;
        for (let i = 0; i < 500 && !recordRan(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(attempts).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The recorder died: its job is settled and dropped, so the re-ask checks and records.
        const again = await run(register);
        expect(again.seal).toEqual({ state: "recorded" });
        expect(attempts).toBe(2);
        expect(world.memory.seals.get(`${at.worktreeId}:${at.epoch}`)?.captureId).toBe(
          capture.built.id,
        );
      } finally {
        Object.assign(repo, { recordSeal: original });
      }
    });

    it("after a restart the re-ask checks the seal again and records it", async () => {
      passBucketReplaceable = () => 0;
      const at = await claimed();
      const capture = sharedLinksCapture(at, "restart");
      await run(uploadObjects(capture.objects));
      // The first process answers `verifying` and is gone before its checks record the seal: its
      // successor holds no verdict.
      world.memory.holdRecordSeal.held = true;
      const quiet = await run(
        registerOn(
          at.worktreeId,
          at.epoch,
          at.api,
        )(capture.built).pipe(Effect.provideService(CaptureRegisterBudget, 0)),
      );
      expect(quiet.seal).toEqual({ state: "withheld", reason: "verifying" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        await run(
          Effect.flatMap(CaptureStoreRepo, (repo) =>
            repo.sealedCompletion(at.worktreeId, "executor-1", at.epoch),
          ),
        ),
      ).toBeNull();
      world.memory.holdRecordSeal.held = false;
      // A fresh channel over the same store and bucket: the executor's re-ask.
      const restarted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* Layer.build(Layer.fresh(world.channel));
            const api = Context.get(channel, CaptureChannel).apiFor({
              worktreeId: at.worktreeId,
              projectId: world.project.id,
              executorId: "executor-1",
              footprintBytes: 0,
            });
            return yield* registerOn(at.worktreeId, at.epoch, api)(capture.built);
          }),
        ),
      );
      expect(restarted.seal).toEqual({ state: "recorded" });
    });
  },
);

/** How long a URL of `ttl` seconds withholds its epoch's seal: its life, plus the clock margin. */
const withheldFor = (ttl: number) => ttl + PUT_URL_CLOCK_MARGIN_SECONDS;

// e2e8 (the seal window on Garage): every PUT URL lived 15 minutes, and every URL withholds its
// epoch's seal until it expires plus the clock margin — every Stop waited 20 minutes to seal. A
// URL now lives as long as its call's bytes need at a conservative rate, never less than
// sealantd's 5-minute reuse of a URL it holds, never more than 15 minutes.
describeSeals(
  "e2e8 a PUT URL lives as long as its call's bytes need",
  {},
  ({ world, run, claimed }) => {
    it("sizes the URL's lifetime, and the write authority recorded for it, to the call's declared bytes", async () => {
      expect(putUrlTtlSeconds(0)).toBe(PUT_URL_TTL_MIN_SECONDS);
      expect(PUT_URL_TTL_MIN_SECONDS).toBe(330);
      expect(putUrlTtlSeconds(100 * PUT_URL_ASSUMED_BYTES_PER_SECOND)).toBe(430);
      expect(putUrlTtlSeconds(10 * 1024 * 1024 * 1024)).toBe(PRESIGN_TTL_SECONDS);
      expect(putUrlTtlSeconds(null)).toBe(PRESIGN_TTL_SECONDS);
      const authorityAfter = async (sizes: Record<string, number | undefined>) => {
        const at = await claimed();
        const keys = Object.keys(sizes);
        const declared = Object.fromEntries(
          Object.entries(sizes).filter(
            (entry): entry is [string, number] => entry[1] !== undefined,
          ),
        );
        const before = Date.now();
        await run(
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: at.epoch,
            keys: keys.map((key) => captureKeys(at.worktreeId, at.epoch).pack(key)),
            sizes: Object.fromEntries(
              Object.entries(declared).map(([key, size]) => [
                captureKeys(at.worktreeId, at.epoch).pack(key),
                size,
              ]),
            ),
          }),
        );
        const recorded = world.memory.putAuthority.get(`${at.worktreeId}:${at.epoch}`);
        return Math.round(((recorded?.getTime() ?? 0) - before) / 1000);
      };
      // A Stop's final capture: a few small objects. 5.5 min + the 5 min margin, not 20 min.
      const small = await authorityAfter({ ["1".repeat(64)]: 2_000, ["2".repeat(64)]: 30_000 });
      expect(Math.abs(small - withheldFor(330))).toBeLessThanOrEqual(2);
      // A call of 100 MiB, over two keys: 100 s more.
      const bulk = await authorityAfter({
        ["3".repeat(64)]: 60 * PUT_URL_ASSUMED_BYTES_PER_SECOND,
        ["4".repeat(64)]: 40 * PUT_URL_ASSUMED_BYTES_PER_SECOND,
      });
      expect(Math.abs(bulk - withheldFor(430))).toBeLessThanOrEqual(2);
      // A key of unknown size: the cap, as before.
      const unsized = await authorityAfter({ ["5".repeat(64)]: undefined });
      expect(Math.abs(unsized - withheldFor(PRESIGN_TTL_SECONDS))).toBeLessThanOrEqual(2);
    });
  },
);
