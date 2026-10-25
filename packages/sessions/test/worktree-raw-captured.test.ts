import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo, ProjectsRepo, WorktreesRepo } from "@mend/db";
import { Sha, type WorktreeId } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import {
  BlobStore,
  captureKeys,
  decodeManifest,
  DEFAULT_RAW_CACHE_LIMITS,
  GitOpsRunner,
  packIdxKeyOf,
  RawBlobCache,
  RawBlobCacheLive,
  RawCacheLimits,
  RawPreparationWait,
  Store,
  StoreConfig,
  sha256Hex,
  WORKTREE_TREE_REF,
  worktreePathOf,
} from "@mend/store";
import { buildManifest, recordGit, uploadObjects } from "@mend/store/testing";
import { Duration, Effect, Exit, Layer, Logger, Scope, Stream, Tracer } from "effect";
import * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import {
  type RawView,
  WorktreeReads,
  WorktreeReadsCapturedLive,
  WorktreeReadsColocatedLive,
} from "../src/worktree-reads.ts";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  projectFor,
  sh,
  worktreeRowFor,
} from "./capture-world.ts";

/** `tree` with `name`'s blob replaced by the bytes on disk, unfiltered: a capture's `raw_tree`. */
const rawTreeOver = (work: string, tree: string, name: string) => {
  const blob = sh(work, ["hash-object", "-w", "--no-filters", name]);
  const index = path.join(work, ".git", "raw-tree-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: work, env, encoding: "utf8" }).trim();
  git("read-tree", tree);
  git("update-index", "--cacheinfo", `100644,${blob},${name}`);
  const raw = git("write-tree");
  fs.rmSync(index, { force: true });
  return raw;
};

/** A pack of `tree`'s objects beyond `baseSha`, through a commit of it. */
const packCommit = (
  work: string,
  worktreeId: string,
  epoch: number,
  baseSha: string,
  tree: string,
) => {
  const commit = sh(work, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@localhost",
    "commit-tree",
    tree,
    "-p",
    baseSha,
    "-m",
    "raw",
  ]);
  const out = fs.mkdtempSync(path.join(tmpdir(), "mend-raw-pack-"));
  const name = sh(
    work,
    ["pack-objects", "--revs", path.join(out, "p")],
    `${commit}\n^${baseSha}\n`,
  );
  const pack = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
  const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
  fs.rmSync(out, { recursive: true, force: true });
  const key = captureKeys(worktreeId, epoch).pack(sha256Hex(pack));
  return {
    key,
    objects: new Map<string, Uint8Array>([
      [key, pack],
      [packIdxKeyOf(key), idx],
    ]),
  };
};

const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries++) {
    if (tries > 200) throw new Error("never prepared");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Raw reads of a capture-mode worktree (the default store), over the production runner: a file of
 * the capture a read observes, or of a checkpoint's own capture, unpacked once into Mend's raw
 * cache and read from there.
 */
describe("raw reads of captured worktrees", () => {
  const world = makeCaptureWorld();
  let ensures = 0;
  const counted = Layer.effect(
    GitOpsRunner,
    Effect.map(GitOpsRunner, (runner) => ({
      ...runner,
      ensure: (input: Parameters<typeof runner.ensure>[0]) =>
        Effect.suspend(() => {
          ensures += 1;
          return runner.ensure(input);
        }),
    })),
  ).pipe(Layer.provide(world.layer));
  const logs: Array<string> = [];
  const spans: Array<Tracer.Span> = [];
  const layer = Layer.mergeAll(
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    WorktreeReadsCapturedLive.pipe(Layer.provide(counted), Layer.provide(world.layer)),
    world.layer,
  );
  type Services = SessionRepository | WorktreeReads | CaptureStoreRepo | BlobStore | RawBlobCache;
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);
      return span;
    },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(context),
        Effect.withTracer(tracer),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => logs.push(String(Logger.formatJson.log(options)))),
          ]),
        ),
      ),
    );
  const recorder = recordGit();
  const worktreeId = newWorktreeId();
  const other = newWorktreeId();
  const clip = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
  const clipNext = clip.map((byte) => 255 - byte);
  const captures: Array<string> = [];
  let checkpoint: { readonly sha: string; readonly captureId?: string | undefined };
  const epochs = new Map<string, number>();

  const register = (
    worktree: WorktreeId,
    n: number,
    edit: (dir: string) => void,
    gitFsck: "verified" | "failed" = "verified",
  ) =>
    run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const parent = world.memory.chains.get(worktree)?.headCapture ?? null;
        const epoch = epochs.get(worktree) ?? (yield* repo.claim(worktree, "executor-1")).epoch;
        epochs.set(worktree, epoch);
        const edited = packEditedTree(world.work, worktree, epoch, world.baseSha, edit);
        const parentKey = world.memory.captures.get(parent ?? "")?.manifestKey ?? "";
        const base = yield* decodeManifest(parentKey, yield* (yield* BlobStore).get(parentKey));
        const built = buildManifest({
          worktreeId: worktree,
          n,
          parent,
          epoch,
          seq: n * 10,
          kind: "auto",
          git: {
            packs: [...base.sections.git.packs.slice(0, 1), edited.key],
            refs: {
              [`refs/heads/mend/wt/${worktree}`]: world.baseSha,
              [WORKTREE_TREE_REF]: edited.tree,
            },
            head: `refs/heads/mend/wt/${worktree}`,
            fsck: gitFsck,
          },
        });
        yield* uploadObjects(new Map([...edited.objects, [built.key, built.bytes]]));
        yield* repo.register({
          worktreeId: worktree,
          id: built.id,
          n,
          parent,
          epoch,
          seq: BigInt(n * 10),
          kind: "auto",
          manifestKey: built.key,
          sections: built.manifest.sections,
          gitFsck,
        });
        return built.id;
      }),
    );

  const read = (
    view: RawView,
    name = "media/clip.mp4",
    range?: { offset: number; length: number },
    worktree: WorktreeId = worktreeId,
  ) =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          const file = yield* reads.openRawFile(world.project.id, worktree, {
            path: name,
            within: "",
            view,
          });
          const chunks = yield* Stream.runCollect(
            file.read(range?.offset ?? 0, range?.length ?? file.size),
          );
          return {
            canonicalPath: file.canonicalPath,
            captureId: file.stamp?.captureId ?? null,
            bytes: new Uint8Array(Buffer.concat(chunks)),
          };
        }),
      ),
    );
  const refusal = (view: RawView, name = "media/clip.mp4", worktree: WorktreeId = worktreeId) =>
    read(view, name, undefined, worktree).then(
      () => null,
      (error: unknown) => (error instanceof Error && "reason" in error ? error.reason : error),
    );
  const unpacks = () => recorder.runs().filter((line) => line.startsWith("cat-file blob")).length;
  const attach = (id: WorktreeId) =>
    run(
      Effect.gen(function* () {
        world.worktrees.set(id, worktreeRowFor(world, id, `mend/wt/${id}`));
        const repo = yield* SessionRepository;
        yield* repo.createWorktree(
          world.project.id,
          { id, directory: id, branch: `mend/wt/${id}` },
          { kind: "base", base: null },
          null,
        );
        if (repo.attachWorktree === undefined)
          return yield* Effect.die("the captured repository attaches worktrees");
        yield* repo.attachWorktree(world.project.id, id);
      }),
    );

  /** A worktree of its own whose one capture holds `files`, so no earlier test prepared them. */
  const isolated = async (files: Record<string, Uint8Array>) => {
    const id = newWorktreeId();
    await attach(id);
    const captureId = await register(id, 1, (dir) => {
      for (const [name, bytes] of Object.entries(files))
        fs.writeFileSync(path.join(dir, name), bytes);
    });
    return { id, captureId };
  };
  const cachedCopies = (bytes: Uint8Array) =>
    fs
      .readdirSync(path.join(world.scratch, "store", "_cache", "raw"), {
        recursive: true,
        encoding: "utf8",
      })
      .map((name) => path.join(world.scratch, "store", "_cache", "raw", name))
      .filter((file) => fs.statSync(file).isFile() && fs.readFileSync(file).equals(bytes)).length;

  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    for (const id of [worktreeId, other]) await attach(id);
    captures.push(
      await register(worktreeId, 1, (dir) => {
        fs.mkdirSync(path.join(dir, "media"), { recursive: true });
        fs.writeFileSync(path.join(dir, "media/clip.mp4"), clip);
        fs.writeFileSync(path.join(dir, "media/poster.png"), clip.slice(0, 5000));
        fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.png\n");
        fs.writeFileSync(path.join(dir, "ignored.png"), "never captured");
      }),
    );
    checkpoint = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo.checkpoint({
          projectId: world.project.id,
          scope: worktreeId,
          worktreeName: worktreeId,
          index: 1,
          parent: Sha.make(world.baseSha),
        });
      }),
    );
    captures.push(
      await register(worktreeId, 2, (dir) => {
        fs.mkdirSync(path.join(dir, "media"), { recursive: true });
        fs.writeFileSync(path.join(dir, "media/clip.mp4"), clipNext);
        fs.writeFileSync(path.join(dir, "media/poster.png"), clip.slice(0, 5000));
        fs.writeFileSync(path.join(dir, "media/fresh.webm"), clip.slice(0, 7000));
        fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.png\n");
      }),
    );
  }, 60_000);
  afterAll(async () => {
    recorder.remove();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  it("serves the current capture's bytes exactly; later opens and every range read no git and restore nothing", async () => {
    const first = await read({ kind: "current" });
    expect(first.bytes).toEqual(clipNext);
    expect(first.captureId).toBe(captures[1]);
    expect(first.canonicalPath).toBe("media/clip.mp4");
    recorder.clear();
    ensures = 0;
    expect((await read({ kind: "current" })).bytes).toEqual(clipNext);
    for (const [offset, length] of [
      [0, 1],
      [99_990, 10],
      [50_000, 20_000],
    ] as const)
      expect(
        (
          await read({ kind: "capture", captureId: first.captureId ?? "" }, undefined, {
            offset,
            length,
          })
        ).bytes,
      ).toEqual(clipNext.slice(offset, offset + length));
    expect(recorder.runs()).toEqual([]);
    expect(ensures).toBe(0);
  });

  it("serves a grant's later opens and seeks from the process's cache alone: no git, no restoration", async () => {
    const captureId = captures[1] ?? "";
    await read({ kind: "capture", captureId });
    const fresh = await Effect.runPromise(
      Layer.build(
        WorktreeReadsCapturedLive.pipe(
          Layer.provide(counted),
          Layer.provide(Layer.succeed(RawBlobCache, Context.get(context, RawBlobCache))),
          Layer.provide(world.layer),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    recorder.clear();
    ensures = 0;
    for (const [offset, length] of [
      [0, 1],
      [99_990, 10],
    ] as const) {
      const bytes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const file = yield* (yield* WorktreeReads).openRawFile(world.project.id, worktreeId, {
              path: "media/clip.mp4",
              within: "",
              view: { kind: "capture", captureId },
            });
            return new Uint8Array(
              Buffer.concat(yield* Stream.runCollect(file.read(offset, length))),
            );
          }),
        ).pipe(Effect.provide(fresh)),
      );
      expect(bytes).toEqual(clipNext.slice(offset, offset + length));
    }
    expect(recorder.runs()).toEqual([]);
    expect(ensures).toBe(0);
  });

  it("keeps a read pinned to the capture it named after the worktree moved on", async () => {
    const pinned = await read({ kind: "capture", captureId: captures[0] ?? "" });
    expect(pinned.bytes).toEqual(clip);
    expect(pinned.captureId).toBe(captures[0]);
    expect((await read({ kind: "current" })).bytes).toEqual(clipNext);
    expect(await refusal({ kind: "capture", captureId: captures[0] ?? "" }, undefined, other)).toBe(
      "missing",
    );
    expect(await refusal({ kind: "capture", captureId: "f".repeat(64) })).toBe("missing");
  });

  it("reads a checkpoint from its own capture, not the current files, and never without it", async () => {
    expect(checkpoint.captureId).toBe(captures[0]);
    const view: RawView = {
      kind: "checkpoint",
      commit: checkpoint.sha,
      captureId: checkpoint.captureId ?? null,
    };
    expect((await read(view)).bytes).toEqual(clip);
    expect(await refusal({ ...view, captureId: null })).toBe("missing");
    expect(await refusal({ ...view, captureId: "f".repeat(64) })).toBe("missing");
    expect(await refusal({ ...view, commit: "e".repeat(40) }, "media/poster.png")).toBe("missing");
  });

  it("answers a gitignored file, a directory and a path outside the worktree as missing", async () => {
    for (const name of ["ignored.png", "media", "../media/clip.mp4", ".git/config"])
      expect(await refusal({ kind: "current" }, name)).toBe("missing");
  });

  it("restores a capture at most once and unpacks a file once for concurrent opens", async () => {
    recorder.clear();
    ensures = 0;
    const opened = await Promise.all(
      Array.from({ length: 6 }, () => read({ kind: "current" }, "media/fresh.webm")),
    );
    for (const result of opened) expect(result.bytes).toEqual(clip.slice(0, 7000));
    expect(unpacks()).toBe(1);
    expect(ensures).toBeLessThanOrEqual(1);
  });

  it("answers preparing past the wait, keeps unpacking, and serves the next open without unpacking again", async () => {
    const name = "media/poster.png";
    const view: RawView = { kind: "capture", captureId: captures[0] ?? "" };
    recorder.clear();
    const cold = await run(
      Effect.scoped(
        Effect.flatMap(WorktreeReads, (reads) =>
          reads.openRawFile(world.project.id, worktreeId, { path: name, within: "", view }),
        ),
      ).pipe(Effect.flip, Effect.provideService(RawPreparationWait, Duration.zero)),
    );
    expect(cold.reason).toBe("preparing");
    const warm = await read(view, name);
    expect(warm.bytes).toEqual(clip.slice(0, 5000));
    expect(unpacks()).toBe(1);
  });

  it("reads the newest verified capture under a head that failed verification", async () => {
    const fallback = newWorktreeId();
    await attach(fallback);
    const good = await register(fallback, 1, (dir) => {
      fs.writeFileSync(path.join(dir, "good.bin"), clip.slice(0, 300));
    });
    const bad = await register(
      fallback,
      2,
      (dir) => {
        fs.writeFileSync(path.join(dir, "good.bin"), clip.slice(0, 400));
      },
      "failed",
    );
    const current = await read({ kind: "current" }, "good.bin", undefined, fallback);
    expect(current.captureId).toBe(good);
    expect(current.bytes).toEqual(clip.slice(0, 300));
    expect(await refusal({ kind: "capture", captureId: bad }, "good.bin", fallback)).toBe(
      "missing",
    );
  });

  it("reads a failed head as the JSON read does when no capture below it verified, and pins the URL to it", async () => {
    const failing = newWorktreeId();
    await attach(failing);
    const first = world.memory.chains.get(failing)?.headCapture ?? "";
    await run(Effect.flatMap(CaptureStoreRepo, (repo) => repo.setGitFsck(first, "unverified")));
    const head = await register(
      failing,
      1,
      (dir) => {
        fs.writeFileSync(path.join(dir, "head.bin"), clip.slice(0, 600));
      },
      "failed",
    );
    const json = await run(
      Effect.flatMap(WorktreeReads, (reads) =>
        reads.readFile(world.project.id, failing, "head.bin", null, 10_000),
      ),
    );
    expect(json.stamp.captureId).toBe(head);
    expect(json.value?.bytes).toEqual(clip.slice(0, 600));
    const current = await read({ kind: "current" }, "head.bin", undefined, failing);
    expect(current.captureId).toBe(head);
    expect(current.bytes).toEqual(clip.slice(0, 600));
    const pinned = await read({ kind: "capture", captureId: head }, "head.bin", undefined, failing);
    expect(pinned.bytes).toEqual(clip.slice(0, 600));
  });

  it("serves a captured file's bytes before its eol filter, as the raw tree holds them", async () => {
    const crlf = "one\r\ntwo\r\n";
    const raw = newWorktreeId();
    await attach(raw);
    const captureId = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const parent = world.memory.chains.get(raw)?.headCapture ?? null;
        const { epoch } = yield* repo.claim(raw, "executor-1");
        const filtered = packEditedTree(world.work, raw, epoch, world.baseSha, (dir) => {
          fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt text\n");
          fs.writeFileSync(path.join(dir, "notes.txt"), crlf);
        });
        const rawTree = rawTreeOver(world.work, filtered.tree, "notes.txt");
        const unfiltered = packCommit(world.work, raw, epoch, world.baseSha, rawTree);
        const parentKey = world.memory.captures.get(parent ?? "")?.manifestKey ?? "";
        const base = yield* decodeManifest(parentKey, yield* (yield* BlobStore).get(parentKey));
        const built = buildManifest({
          worktreeId: raw,
          n: 1,
          parent,
          epoch,
          seq: 10,
          kind: "auto",
          git: {
            packs: [...base.sections.git.packs.slice(0, 1), filtered.key, unfiltered.key],
            refs: { [`refs/heads/mend/wt/${raw}`]: world.baseSha },
            head: `refs/heads/mend/wt/${raw}`,
            worktree_tree: filtered.tree,
            raw_tree: rawTree,
            fsck: "verified",
          },
        });
        yield* uploadObjects(
          new Map([...filtered.objects, ...unfiltered.objects, [built.key, built.bytes]]),
        );
        yield* repo.register({
          worktreeId: raw,
          id: built.id,
          n: 1,
          parent,
          epoch,
          seq: 10n,
          kind: "auto",
          manifestKey: built.key,
          sections: built.manifest.sections,
          gitFsck: "verified",
        });
        return built.id;
      }),
    );
    const json = await run(
      Effect.flatMap(WorktreeReads, (reads) =>
        reads.readFile(world.project.id, raw, "notes.txt", null, 10_000),
      ),
    );
    expect(Buffer.from(json.value?.bytes ?? []).toString()).toBe("one\ntwo\n");
    for (const view of [{ kind: "current" }, { kind: "capture", captureId }] as const)
      expect(Buffer.from((await read(view, "notes.txt", undefined, raw)).bytes).toString()).toBe(
        crlf,
      );
  });

  it("prepares a file again after the runner's repository for its capture was pruned", async () => {
    const { id, captureId } = await isolated({
      "first.bin": clip.slice(0, 1400),
      "second.bin": clip.slice(0, 1500),
    });
    const view: RawView = { kind: "capture", captureId };
    expect((await read(view, "first.bin", undefined, id)).bytes).toEqual(clip.slice(0, 1400));
    fs.rmSync(path.join(world.scratch, "store", "_cache", "runner", world.project.id), {
      recursive: true,
      force: true,
    });
    expect((await read(view, "second.bin", undefined, id)).bytes).toEqual(clip.slice(0, 1500));
  });

  it("keeps preparing after the wait ends: the next open runs no git and restores nothing", async () => {
    const name = "later.bin";
    const expected = clip.slice(0, 9000);
    const { id, captureId } = await isolated({ [name]: expected });
    const view: RawView = { kind: "capture", captureId };
    const cold = await run(
      Effect.scoped(
        Effect.flatMap(WorktreeReads, (reads) =>
          reads.openRawFile(world.project.id, id, { path: name, within: "", view }),
        ),
      ).pipe(Effect.flip, Effect.provideService(RawPreparationWait, Duration.zero)),
    );
    expect(cold.reason).toBe("preparing");
    await until(() => cachedCopies(expected) > 0);
    recorder.clear();
    ensures = 0;
    expect((await read(view, name, undefined, id)).bytes).toEqual(expected);
    expect(recorder.runs()).toEqual([]);
    expect(ensures).toBe(0);
  });

  it("joins a preparation in flight, refuses a miss past the bound as busy, and ends a stuck one at its deadline", async () => {
    const { id } = await isolated({
      "stuck.bin": clip.slice(0, 1300),
      "other.bin": clip.slice(0, 1200),
    });
    let hang = true;
    const hanging = Layer.effect(
      BlobStore,
      Effect.map(BlobStore, (blobs) => ({
        ...blobs,
        get: (key: string) => (hang ? Effect.never : blobs.get(key)),
      })),
    ).pipe(Layer.provide(world.layer));
    const stuck = await Effect.runPromise(
      Layer.build(
        WorktreeReadsCapturedLive.pipe(
          Layer.provide(hanging),
          Layer.provide(counted),
          Layer.provide(world.layer),
          Layer.provide(
            Layer.succeed(RawCacheLimits, {
              ...DEFAULT_RAW_CACHE_LIMITS,
              inFlight: 1,
              preparationMillis: 300,
            }),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const open = (name: string, wait: Duration.Duration) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const file = yield* (yield* WorktreeReads).openRawFile(world.project.id, id, {
              path: name,
              within: "",
              view: { kind: "current" },
            });
            return file.size;
          }),
        ).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
          Effect.catch(() => Effect.succeed("served")),
          Effect.provide(stuck),
          Effect.provideService(RawPreparationWait, wait),
        ),
      );
    expect(await open("stuck.bin", Duration.zero)).toBe("preparing");
    expect(await open("other.bin", Duration.zero)).toBe("busy");
    expect(await open("stuck.bin", Duration.zero)).toBe("preparing");
    hang = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await open("stuck.bin", Duration.seconds(10))).toBe("served");
  });

  it("says nothing of a file's path in logs or traces", () => {
    const seen = [
      ...logs,
      ...spans.map((span) => JSON.stringify([span.name, [...span.attributes]])),
    ];
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) {
      expect(entry).not.toContain("clip.mp4");
      expect(entry).not.toContain("poster.png");
      expect(entry).not.toContain("fresh.webm");
    }
  });
});

describe("raw reads of co-located checkpoints", () => {
  it("shares one repository/blob cache across worktrees and never reads the current file", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "mend-colocated-raw-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        }).trim();
      git("init", "-q");
      fs.writeFileSync(path.join(root, "image.png"), Uint8Array.of(5, 0, 255));
      git("add", "image.png");
      git("commit", "-qm", "base");
      const commit = git("rev-parse", "HEAD");
      const projectRow = projectFor(path.join(root, ".git"), commit);
      const rows = ["first", "second"].map(
        (name) =>
          new Worktree({
            id: newWorktreeId(),
            projectId: projectRow.id,
            name,
            directory: name,
            branch: name,
            baseSha: Sha.make(commit),
            baseRef: "main",
            handoff: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
      );
      for (const row of rows) {
        const dir = worktreePathOf(projectRow.storePath, row.directory);
        git("worktree", "add", "--detach", dir, commit);
        fs.writeFileSync(path.join(dir, "image.png"), "edited current bytes");
      }
      const layer = WorktreeReadsColocatedLive.pipe(
        Layer.provide(
          Layer.merge(Store.layer, RawBlobCacheLive).pipe(
            Layer.provide(StoreConfig.layerFor(root)),
          ),
        ),
        Layer.provide(Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(projectRow) })),
        Layer.provide(
          Layer.mock(WorktreesRepo, {
            byId: (id) => {
              const row = rows.find((candidate) => candidate.id === id);
              return row === undefined ? Effect.die("unexpected worktree") : Effect.succeed(row);
            },
          }),
        ),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const reads = yield* WorktreeReads;
          for (const row of rows)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* reads.openRawFile(projectRow.id, row.id, {
                  path: "image.png",
                  within: "",
                  view: { kind: "checkpoint", commit, captureId: null },
                });
                expect(Buffer.concat(yield* Stream.runCollect(file.read(0, file.size)))).toEqual(
                  Buffer.from([5, 0, 255]),
                );
              }),
            );
          const unpacked = fs
            .readdirSync(path.join(root, "_cache/raw"), { recursive: true, encoding: "utf8" })
            .map((name) => path.join(root, "_cache/raw", name))
            .filter((file) => fs.statSync(file).isFile());
          expect(unpacked.map((file) => [...fs.readFileSync(file)])).toEqual([[5, 0, 255]]);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
