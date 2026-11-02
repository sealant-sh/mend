import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CaptureStoreRepo,
  CheckpointsRepo,
  StoreRefConflictError,
  StoreRefsRepo,
  type CaptureRow,
  type PackRecord,
  type PackRow,
  type StoreRef,
} from "@mend/db";
import { Sha, type WorktreeId } from "@mend/domain";
import { type Checkpoint } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import {
  BlobStore,
  BlobStoreError,
  BlobStoreFsLive,
  GitOpsRunner,
  GitOpsRunnerLive,
  Store,
  StoreConfig,
  captureKeys,
  landedRefOf,
  packIdxKeyOf,
  runnerCachePathOf,
} from "@mend/store";
import { buildManifest } from "@mend/store/testing";
import { Deferred, Effect, Layer } from "effect";

import { LandingGitCapturedLive } from "../src/landing-git-captured.ts";
import { Landing, LandingGit, LandingLive, TourRequests } from "../src/landing.ts";
import { PullRequests } from "../src/pull-requests.ts";
import { checkpointOf, makeWorld } from "./world.ts";

const BRANCH = "mend/fix-login";
const DATE = new Date("2026-09-24T10:00:00Z");
const keyOf = (projectId: string, name: string) => `${projectId}\0${name}`;

/** A real capture and derived checkpoint, with independently known Git head and tree. */
export interface CapturedSnapshot {
  readonly row: CaptureRow;
  readonly checkpoint: Checkpoint;
  readonly agentHead: Sha;
  readonly tree: Sha;
  readonly objects: ReadonlyMap<string, Uint8Array>;
  /** Retained source packs explicitly supplied to subsequent cache restores. */
  readonly sourcePacks: ReadonlyArray<string>;
}

function createFixture(options: { readonly leftovers?: boolean; readonly detached?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-captured-landing-"));
  const settings = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@example.invalid",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@example.invalid",
    GIT_AUTHOR_DATE: DATE.toISOString(),
    GIT_COMMITTER_DATE: DATE.toISOString(),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const saved = new Map<string, string | undefined>();
  for (const key of new Set([
    ...Object.keys(settings),
    ...Object.keys(process.env).filter((name) => name.startsWith("GIT_")),
  ])) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, settings);
  const gitEnv = { ...process.env };
  const close = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  const git = (cwd: string, args: ReadonlyArray<string>, input?: string, env?: NodeJS.ProcessEnv) =>
    execFileSync("git", [...args], {
      cwd,
      input,
      env: { ...gitEnv, ...env },
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  try {
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent);
    git(agent, ["init", "-q", "--object-format=sha1", "-b", BRANCH]);
    fs.writeFileSync(path.join(agent, "base.txt"), "base\n");
    git(agent, ["add", "-A"]);
    git(agent, ["commit", "-q", "-m", "base"]);
    const base = Sha.make(git(agent, ["rev-parse", "HEAD"]));
    const origin = path.join(root, "origin.git");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    git(agent, ["push", "-q", origin, `${base}:refs/heads/main`]);
    const world = makeWorld({
      baseSha: base,
      branch: BRANCH,
      originUrl: origin,
      storePath: agent,
      tour: { summary: "Keep the captured change", approach: null },
    });
    const prefix = `projects/${world.project.id}/packs/`;
    const packRows = new Map<string, PackRow>();
    const refRows = new Map<string, StoreRef>();
    const snapshots: CapturedSnapshot[] = [];
    const events: string[] = [];
    const requests: string[] = [];
    let failPut: "pack" | "index" | null = null;
    let gate: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null = null;
    const seedRef = (name: string, sha: Sha) =>
      refRows.set(keyOf(world.project.id, name), {
        projectId: world.project.id,
        name,
        sha,
        version: 1,
        updatedAt: DATE,
      });
    seedRef(`refs/mend/base/${world.worktree.id}`, base);
    const record = (item: PackRecord) => {
      const old = packRows.get(item.key);
      packRows.set(item.key, {
        ...item,
        id: item.key,
        state: "uploaded",
        createdAt: old?.createdAt ?? DATE,
        updatedAt: DATE,
      });
    };
    const pack = (revs: ReadonlyArray<string>, closure: boolean, key: (hash: string) => string) => {
      const staging = fs.mkdtempSync(path.join(root, "pack-"));
      try {
        const hash = git(
          agent,
          ["pack-objects", ...(closure ? ["--revs"] : []), path.join(staging, "p")],
          `${revs.join("\n")}\n`,
        );
        const bytes = new Uint8Array(fs.readFileSync(path.join(staging, `p-${hash}.pack`)));
        const idx = new Uint8Array(fs.readFileSync(path.join(staging, `p-${hash}.idx`)));
        return { key: key(createHash("sha256").update(bytes).digest("hex")), bytes, idx };
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    };
    const makeSnapshot = (leftovers = true, detached = false): CapturedSnapshot => {
      const ordinal = snapshots.length + 1;
      fs.writeFileSync(path.join(agent, `agent-${ordinal}.txt`), `agent ${ordinal}\n`);
      git(agent, ["add", "-A"]);
      git(agent, ["commit", "-q", "-m", `agent ${ordinal}`]);
      const agentHead = Sha.make(git(agent, ["rev-parse", "HEAD"]));
      if (detached) {
        git(agent, ["checkout", "-q", "--detach", agentHead]);
        git(agent, ["update-ref", "-d", `refs/heads/${BRANCH}`]);
      }
      if (leftovers)
        fs.writeFileSync(path.join(agent, `leftover-${ordinal}.txt`), `leftover ${ordinal}\n`);
      const index = path.join(root, `index-${ordinal}`);
      git(agent, ["read-tree", agentHead], undefined, { GIT_INDEX_FILE: index });
      git(agent, ["add", "-A"], undefined, { GIT_INDEX_FILE: index });
      const tree = Sha.make(git(agent, ["write-tree"], undefined, { GIT_INDEX_FILE: index }));
      const checkpointSha = Sha.make(
        git(agent, [
          "commit-tree",
          tree,
          "-p",
          snapshots.at(-1)?.checkpoint.sha ?? base,
          "-m",
          `checkpoint ${ordinal}`,
        ]),
      );
      const checkpoint = checkpointOf(world, ordinal, checkpointSha, "user-mark");
      seedRef(checkpoint.ref, checkpointSha);
      const source = pack([agentHead, tree], true, captureKeys(world.worktree.id, 1).pack);
      const derived = pack([checkpointSha], false, (hash) => `${prefix}${hash}`);
      record({
        key: derived.key,
        class: "git",
        bytes: derived.bytes.byteLength,
        worktreeId: world.worktree.id,
        epoch: null,
        platform: null,
      });
      const sourcePacks = [...(snapshots.at(-1)?.sourcePacks ?? []), source.key];
      const manifest = buildManifest({
        worktreeId: world.worktree.id,
        n: ordinal,
        parent: snapshots.at(-1)?.row.id ?? null,
        epoch: 1,
        git: {
          packs: sourcePacks,
          refs: detached ? {} : { [`refs/heads/${BRANCH}`]: agentHead },
          head: detached ? agentHead : `refs/heads/${BRANCH}`,
          worktree_tree: tree,
          fsck: "verified",
        },
      });
      const row: CaptureRow = {
        id: manifest.id,
        worktreeId: world.worktree.id,
        n: ordinal,
        parent: manifest.manifest.parent,
        epoch: 1,
        seq: BigInt(ordinal),
        kind: "auto",
        manifestKey: manifest.key,
        sections: manifest.manifest.sections,
        gitFsck: "verified",
        createdAt: DATE,
      };
      const objects = new Map<string, Uint8Array>([
        [source.key, source.bytes],
        [packIdxKeyOf(source.key), source.idx],
        [derived.key, derived.bytes],
        [packIdxKeyOf(derived.key), derived.idx],
        [manifest.key, manifest.bytes],
      ]);
      const snapshot = { row, checkpoint, agentHead, tree, objects, sourcePacks };
      snapshots.push(snapshot);
      return snapshot;
    };
    const first = makeSnapshot(options.leftovers, options.detached);
    let checkpointCaptureId: string | null | undefined;
    const prunedCaptures = new Set<string>();
    const captureOverrides = new Map<string, CaptureRow>();
    let current = first;
    let latest = first;
    let sequence: ReadonlyArray<{
      readonly taken: CapturedSnapshot;
      readonly head: CapturedSnapshot;
    }> = [];
    let attempt = 0;
    const refsService: Parameters<typeof StoreRefsRepo.of>[0] = {
      list: (projectId) =>
        Effect.sync(() => [...refRows.values()].filter((row) => row.projectId === projectId)),
      get: (projectId, name) => Effect.sync(() => refRows.get(keyOf(projectId, name)) ?? null),
      refsMap: (projectId) =>
        Effect.sync(() =>
          Object.fromEntries(
            [...refRows.values()]
              .filter((row) => row.projectId === projectId)
              .map((row) => [row.name, row.sha]),
          ),
        ),
      set: (projectId, name, sha, seenVersion) =>
        Effect.gen(function* () {
          const pause = name === landedRefOf(world.worktree.id) ? gate : null;
          if (pause) {
            gate = null;
            yield* Deferred.succeed(pause.entered, undefined);
            yield* Deferred.await(pause.release);
          }
          const old = refRows.get(keyOf(projectId, name));
          if ((old?.version ?? null) !== seenVersion)
            return yield* new StoreRefConflictError({ projectId, name, seenVersion });
          const row = { projectId, name, sha, version: (old?.version ?? 0) + 1, updatedAt: DATE };
          refRows.set(keyOf(projectId, name), row);
          events.push(`ref:${name}`);
          return row;
        }),
      remove: (projectId, name, seenVersion) =>
        Effect.suspend(() => {
          if (refRows.get(keyOf(projectId, name))?.version !== seenVersion)
            return Effect.fail(new StoreRefConflictError({ projectId, name, seenVersion }));
          refRows.delete(keyOf(projectId, name));
          return Effect.void;
        }),
    };
    const refsLayer: Layer.Layer<StoreRefsRepo> = Layer.succeed(StoreRefsRepo, refsService);
    const captureLayer: Layer.Layer<CaptureStoreRepo> = Layer.mock(CaptureStoreRepo, {
      headOf: (worktreeId) =>
        Effect.sync(() => ({
          worktreeId,
          headN: current.row.n,
          headEpoch: current.row.epoch,
          head: current.row,
        })).pipe(Effect.map((head) => (worktreeId === world.worktree.id ? head : null))),
      captureById: (captureId) =>
        Effect.sync(() =>
          prunedCaptures.has(captureId)
            ? null
            : (captureOverrides.get(captureId) ??
              snapshots.find((snapshot) => snapshot.row.id === captureId)?.row ??
              null),
        ),
      listChain: (worktreeId) =>
        Effect.sync(() =>
          snapshots.map((snapshot) => snapshot.row).filter((row) => row.worktreeId === worktreeId),
        ),
      listPacks: (state) =>
        Effect.sync(() =>
          [...packRows.values()].filter((row) => state === undefined || state === row.state),
        ),
      recordPacks: (records) =>
        Effect.sync(() => {
          for (const item of records) record(item);
          events.push("inventory");
        }),
    });
    const checkpointLayer: Layer.Layer<CheckpointsRepo> = Layer.mock(CheckpointsRepo, {
      captureIdOf: (id, worktreeId) =>
        Effect.sync(() => {
          const snapshot = snapshots.find(
            (item) => item.checkpoint.id === id && item.checkpoint.worktreeId === worktreeId,
          );
          return snapshot === undefined
            ? null
            : checkpointCaptureId === undefined
              ? snapshot.row.id
              : checkpointCaptureId;
        }),
      latestForWorktree: (worktreeId) =>
        Effect.sync(() => (worktreeId === world.worktree.id ? latest.checkpoint : null)),
    });
    const engineLayer: Layer.Layer<SessionEngine> = Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      landingCheckpoint: (_sessionId, trigger) =>
        Effect.sync(() => {
          requests.push(trigger);
          const response = sequence[attempt++];
          if (sequence.length > 0 && response === undefined)
            throw new Error("unexpected extra checkpoint request");
          if (response) {
            latest = response.taken;
            current = response.head;
          } else latest = current;
          return { checkpoint: latest.checkpoint, captureId: latest.row.id };
        }),
    });
    const blobsLayer: Layer.Layer<BlobStore> = Layer.effect(
      BlobStore,
      Effect.gen(function* () {
        const live = yield* BlobStore;
        return BlobStore.of({
          ...live,
          put: (key, body, putOptions) => {
            if (
              key.startsWith(prefix) &&
              ((failPut === "index" && key.endsWith(".idx")) ||
                (failPut === "pack" && !key.endsWith(".idx")))
            ) {
              return Effect.fail(
                new BlobStoreError({
                  operation: "put",
                  key,
                  cause: new Error("fixture disk full"),
                }),
              );
            }
            return live.put(key, body, putOptions).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (key.startsWith(prefix)) events.push(`put:${key}`);
                }),
              ),
            );
          },
        });
      }),
    ).pipe(Layer.provide(BlobStoreFsLive(path.join(root, "blobs"))));
    type Dependencies =
      | CaptureStoreRepo
      | StoreRefsRepo
      | CheckpointsRepo
      | SessionEngine
      | GitOpsRunner
      | StoreConfig
      | BlobStore;
    const runnerLayer: Layer.Layer<GitOpsRunner | StoreConfig | BlobStore> = GitOpsRunnerLive.pipe(
      Layer.provide(Store.layer),
      Layer.provideMerge(StoreConfig.layerFor(path.join(root, "store"))),
      Layer.provideMerge(blobsLayer),
    );
    const dependencies: Layer.Layer<Dependencies> = Layer.mergeAll(
      captureLayer,
      refsLayer,
      checkpointLayer,
      engineLayer,
      runnerLayer,
    );
    const adapterLayer: Layer.Layer<LandingGit | Dependencies> = LandingGitCapturedLive.pipe(
      Layer.provideMerge(dependencies),
    );
    const serviceLayer: Layer.Layer<Landing | LandingGit | Dependencies> = LandingLive.pipe(
      Layer.provideMerge(adapterLayer),
      Layer.provide(world.repos),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TourRequests, { request: () => Effect.void }),
          Layer.mock(PullRequests, {
            proofItems: () => Effect.succeed([]),
            attachProof: () => Effect.succeed({ delivered: 0, reused: 0, failed: [] }),
            find: () => Effect.succeed(null),
            publish: () => Effect.die("GitHub is outside this fixture"),
            observe: () => Effect.die("GitHub is outside this fixture"),
          }),
        ),
      ),
    );
    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        LandingGit | BlobStore | GitOpsRunner | StoreRefsRepo | CaptureStoreRepo | Landing
      >,
    ) => effect.pipe(Effect.provide(serviceLayer));
    const upload = (snapshot: CapturedSnapshot) =>
      provide(
        Effect.gen(function* () {
          const blobs = yield* BlobStore;
          for (const [key, bytes] of snapshot.objects)
            yield* blobs.put(key, bytes, { ifAbsent: true });
        }),
      );
    return {
      root,
      agent,
      origin,
      base,
      world,
      first,
      prefix,
      git,
      close,
      provide,
      cachePath: runnerCachePathOf(path.join(root, "store"), world.project.id),
      seed: upload(first),
      addCapture: () => Effect.sync(() => makeSnapshot()).pipe(Effect.tap(upload)),
      replaceCaptureRow: (row: CaptureRow) => {
        captureOverrides.set(row.id, row);
      },
      movePackToWorktree: (key: string, worktreeId: WorktreeId) => {
        const row = packRows.get(key);
        if (row !== undefined) packRows.set(key, { ...row, worktreeId });
      },
      setCheckpointCaptureId: (captureId: string | null) => {
        checkpointCaptureId = captureId;
      },
      pruneCapture: (captureId: string) => {
        prunedCaptures.add(captureId);
      },
      observeCapture: (snapshot: CapturedSnapshot) => {
        current = snapshot;
      },
      planCheckpoints: (plan: typeof sequence) => {
        sequence = plan;
        attempt = 0;
        requests.length = 0;
      },
      requests: () => [...requests],
      events: () => [...events],
      resetEvents: () => {
        events.length = 0;
      },
      failWrites: (kind: typeof failPut) => {
        failPut = kind;
      },
      inventory: () => [...packRows.values()],
      refs: () => [...refRows.values()],
      seedStoreRef: seedRef,
      deleteCache: () =>
        fs.rmSync(runnerCachePathOf(path.join(root, "store"), world.project.id), {
          recursive: true,
          force: true,
        }),
      pauseNextRefSet: Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate = { entered, release };
        return gate;
      }),
      agentState: () => ({
        head: git(agent, ["rev-parse", "HEAD"]),
        headFile: fs.readFileSync(path.join(agent, ".git", "HEAD"), "utf8"),
        refs: git(agent, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        index: fs.readFileSync(path.join(agent, ".git", "index")),
        status: git(agent, ["--no-optional-locks", "status", "--porcelain"]),
        files: fs
          .readdirSync(agent)
          .filter((name) => name !== ".git")
          .map((name) => [name, fs.readFileSync(path.join(agent, name), "utf8")]),
      }),
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Real local Git/blob/runner fixture, scoped and cleaned even when an assertion fails. */
export const withCapturedFixture = <A, E>(
  work: (fixture: ReturnType<typeof createFixture>) => Effect.Effect<A, E>,
  options: Parameters<typeof createFixture>[0] = {},
): Effect.Effect<A, E | BlobStoreError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() => createFixture(options)),
        (ownedFixture) => Effect.sync(ownedFixture.close),
      );
      yield* fixture.seed;
      fixture.resetEvents();
      return yield* work(fixture);
    }),
  );
