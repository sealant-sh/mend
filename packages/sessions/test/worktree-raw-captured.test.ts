import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaptureStoreRepo, StoreRefsRepo, ProjectsRepo, WorktreesRepo } from "@mend/db";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import {
  BlobStore,
  BlobStoreFsLive,
  GitOpsRunner,
  Store,
  StoreConfig,
  worktreePathOf,
} from "@mend/store";
import { buildManifest } from "@mend/store/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect } from "vitest";

import {
  WorktreeReads,
  WorktreeReadsCapturedLive,
  WorktreeReadsColocatedLive,
  type RawView,
} from "../src/worktree-reads.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { projectFor } from "./capture-world.ts";

const project = ProjectId.make("raw-project");
const worktree = WorktreeId.make("raw-worktree");
const fixture = Effect.gen(function* () {
  const root = fs.mkdtempSync(join(tmpdir(), "mend-captured-raw-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  fs.writeFileSync(join(root, ".gitignore"), "ignored.bin\n");
  fs.writeFileSync(join(root, "ignored.bin"), "not captured");
  const memory = makeMemoryCaptureStore();
  const manifests: string[] = [];
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const prepared = yield* Deferred.make<void>();
  let slow = false;
  const store = Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)));
  const runner = Layer.unwrap(
    Effect.gen(function* () {
      const files = yield* Store;
      return Layer.mock(GitOpsRunner, {
        ensure: (input) =>
          Effect.gen(function* () {
            manifests.push(input.manifest.worktree_id + ":" + input.manifest.n);
            if (slow) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return {
              projectId: input.projectId,
              path: root,
              refs: input.manifest.sections.git.refs,
              head: input.manifest.sections.git.head,
            };
          }),
        resolve: (cache, ref) => Effect.succeed(Sha.make(cache.refs[ref] ?? ref)),
        prepareRawBlobFile: (cache, target) =>
          files
            .prepareRawBlobFile(cache.path, target)
            .pipe(Effect.tap(() => Deferred.succeed(prepared, undefined))),
        openRawBlobFile: (cache, target) => files.openRawBlobFile(cache.path, target),
      });
    }),
  ).pipe(Layer.provide(store));
  const blobs = BlobStoreFsLive(join(root, "bucket"));
  const services = Layer.mergeAll(
    memory.layer,
    blobs,
    Layer.mock(StoreRefsRepo, { refsMap: () => Effect.succeed({}) }),
    runner,
  );
  const layer = WorktreeReadsCapturedLive.pipe(Layer.provideMerge(services));
  const capture = (
    n: number,
    parent: string | null,
    content: Uint8Array,
    verified: "verified" | "failed" = "verified",
    withTree = true,
  ) =>
    Effect.gen(function* () {
      fs.writeFileSync(join(root, "image.png"), content);
      git("add", ".gitignore", "image.png");
      git("commit", "-qm", String(n));
      const commit = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      const built = buildManifest({
        worktreeId: worktree,
        n,
        parent,
        epoch: 1,
        seq: n + 1,
        git: {
          packs: [],
          refs: { "refs/heads/main": commit },
          head: "refs/heads/main",
          ...(withTree ? { worktree_tree: tree } : {}),
          fsck: "verified",
        },
      });
      yield* (yield* BlobStore).put(built.key, built.bytes);
      const repo = yield* CaptureStoreRepo;
      if (n === 0) {
        yield* repo.init(worktree);
        yield* repo.claim(worktree, "executor", 300);
      }
      yield* repo.register({
        worktreeId: worktree,
        id: built.id,
        n,
        parent,
        epoch: 1,
        seq: BigInt(n + 1),
        kind: "auto",
        manifestKey: built.key,
        sections: built.manifest.sections,
        gitFsck: verified,
      });
      return { id: built.id, commit };
    });
  const read = (view?: RawView, path = "image.png", id = worktree) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* (yield* WorktreeReads).openRawFile(project, id, {
          path,
          within: "",
          ...(view === undefined ? {} : { view }),
        });
        return {
          bytes: Buffer.concat(yield* Stream.runCollect(file.read(0, file.size))),
          stamp: file.stamp,
        };
      }),
    );
  return {
    layer,
    root,
    git,
    store,
    capture,
    read,
    manifests,
    memory,
    entered,
    release,
    prepared,
    slow: () => {
      slow = true;
    },
  };
});

it.effect(
  "previews a capture exactly, reuses preparation, omits ignored files and pins historical bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const first = yield* f.capture(0, null, Uint8Array.from([0, 255, 1]));
        const observed = yield* f.read();
        expect(observed.bytes).toEqual(Buffer.from([0, 255, 1]));
        expect(observed.stamp).toMatchObject({
          captureId: first.id,
          captureN: 0,
          seq: "1",
          partial: true,
        });
        yield* f.read();
        expect(f.manifests).toEqual([`${worktree}:0`]);
        const second = yield* f.capture(1, first.id, Uint8Array.from([2, 3]));
        expect((yield* f.read()).bytes).toEqual(Buffer.from([2, 3]));
        expect((yield* f.read({ kind: "capture", captureId: first.id })).bytes).toEqual(
          observed.bytes,
        );
        expect(
          (yield* f.read({ kind: "checkpoint", commit: first.commit, captureId: first.id })).bytes,
        ).toEqual(observed.bytes);
        expect(yield* Effect.flip(f.read(undefined, "ignored.bin"))).toMatchObject({
          reason: "missing",
        });
        expect(f.manifests).toEqual([`${worktree}:0`, `${worktree}:1`]);
        expect(second.id).not.toBe(first.id);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "uses the verified-head fallback and refuses missing, failed or foreign historical evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const good = yield* f.capture(0, null, Uint8Array.of(1));
        const bad = yield* f.capture(1, good.id, Uint8Array.of(2), "failed");
        expect((yield* f.read()).stamp?.captureId).toBe(good.id);
        for (const view of [
          { kind: "capture", captureId: bad.id },
          { kind: "checkpoint", commit: good.commit, captureId: null },
          { kind: "checkpoint", commit: good.commit, captureId: "f".repeat(64) },
        ] satisfies RawView[])
          expect(yield* Effect.flip(f.read(view))).toMatchObject({ reason: "missing" });
        expect(
          yield* Effect.flip(
            f.read(
              { kind: "capture", captureId: good.id },
              "image.png",
              WorktreeId.make("foreign"),
            ),
          ),
        ).toMatchObject({ reason: "missing" });
        f.memory.captures.delete(good.id);
        expect(yield* Effect.flip(f.read({ kind: "capture", captureId: good.id }))).toMatchObject({
          reason: "missing",
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "a cold preview times out at ten seconds, continues preparing, and later opens share the result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* f.capture(0, null, Uint8Array.of(0, 17));
        f.slow();
        const pending = yield* Effect.forkScoped(
          Effect.all([Effect.result(f.read()), Effect.result(f.read())], {
            concurrency: "unbounded",
          }),
        );
        yield* Deferred.await(f.entered);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(pending);
        for (const result of results)
          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "preparing" } });
        yield* Deferred.succeed(f.release, undefined);
        yield* Deferred.await(f.prepared);
        expect((yield* f.read()).bytes).toEqual(Buffer.from([0, 17]));
        expect(f.manifests).toEqual([`${worktree}:0`]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "reads an older capture whose tree falls back to its recorded head, without resolving a mutable ref on later opens",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* f.capture(0, null, Uint8Array.of(9, 0, 255), "verified", false);
        expect((yield* f.read()).bytes).toEqual(Buffer.from([9, 0, 255]));
        yield* f.read();
        expect(f.manifests).toEqual([`${worktree}:0`]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("co-located checkpoints share one repository/blob cache across worktrees", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    fs.writeFileSync(join(f.root, "image.png"), Uint8Array.of(5, 0, 255));
    f.git("add", "image.png");
    f.git("commit", "-qm", "base");
    const commit = f.git("rev-parse", "HEAD");
    const projectRow = projectFor(join(f.root, ".git"), commit);
    const rows = ["first", "second"].map(
      (name) =>
        new Worktree({
          id: WorktreeId.make(name),
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
      f.git("worktree", "add", "--detach", dir, commit);
      fs.writeFileSync(join(dir, "image.png"), "edited current bytes");
    }
    const layer = WorktreeReadsColocatedLive.pipe(
      Layer.provide(f.store),
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
    yield* Effect.gen(function* () {
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
      expect(
        fs.readdirSync(join(f.root, "_cache/raw")).filter((file) => file.endsWith(".blob")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);
