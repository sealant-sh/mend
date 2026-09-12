import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type CaptureStoreRepo,
  ProjectNotFoundError,
  ProjectsRepo,
  StoreRefConflictError,
  StoreRefsRepo,
  WorktreeNotFoundError,
  WorktreesRepo,
  type StoreRef,
} from "@mend/db";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Project, Worktree } from "@mend/domain/workbench";
import {
  BlobStore,
  BlobStoreFsLive,
  captureKeys,
  type GitOpsRunner,
  GitOpsRunnerLive,
  packIdxKeyOf,
  sha256Hex,
  Store,
  StoreConfig,
} from "@mend/store";
import { Effect, Layer } from "effect";

import { type CaptureChannel, CaptureChannelLive } from "../src/capture-channel.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

/**
 * A capture-mode world for the sessions tests: a real bare project repository (git on disk,
 * as the Store expects), a directory bucket, the in-memory pointer store and store refs, and
 * the runner over them. Everything an executor would do is done by hand here with the same
 * pack and manifest rules sealantd follows.
 */

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
};
export const sh = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  execFileSync("git", [...args], { cwd, env: gitEnv, input })
    .toString("utf8")
    .replace(/\n$/, "");

/** A bare project store with one `main` commit, laid out as `Store.adopt` lays it out. */
export const makeProjectRepo = (scratch: string) => {
  const work = path.join(scratch, "work");
  fs.mkdirSync(work);
  sh(work, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(work, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(work, "keep.md"), "# keep\n");
  sh(work, ["add", "."]);
  sh(work, ["commit", "-q", "-m", "base"]);
  const storePath = path.join(scratch, "store", "fixture", "repo.git");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  sh(scratch, ["clone", "-q", "--bare", work, storePath]);
  sh(storePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { work, storePath, baseSha: sh(storePath, ["rev-parse", "HEAD"]) };
};

/**
 * What an executor ships after editing the worktree: a commit on a scratch branch holding the
 * edited tree, packed incrementally against the base (self-contained, never thin), keyed by
 * sha256, with the worktree pseudo-ref naming that commit's tree.
 */
export const packEditedTree = (
  work: string,
  worktreeId: string,
  epoch: number,
  baseSha: string,
  edit: (dir: string) => void,
) => {
  sh(work, ["checkout", "-q", "-B", "scratch", baseSha]);
  edit(work);
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", "scratch edit", "--allow-empty"]);
  const commit = sh(work, ["rev-parse", "HEAD"]);
  const tree = sh(work, ["rev-parse", "HEAD^{tree}"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-edit-pack-"));
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
    tree,
    key,
    objects: new Map<string, Uint8Array>([
      [key, pack],
      [packIdxKeyOf(key), idx],
    ]),
  };
};

export const memoryStoreRefs = (): Layer.Layer<StoreRefsRepo> => {
  // Rows live outside the layer so every build of it sees the same refs.
  const rows = new Map<string, StoreRef>();
  const keyOf = (projectId: string, name: string) => `${projectId} ${name}`;
  return Layer.sync(StoreRefsRepo, () => {
    return {
      list: (projectId) =>
        Effect.sync(() =>
          [...rows.values()]
            .filter((row) => row.projectId === projectId)
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        ),
      get: (projectId, name) => Effect.sync(() => rows.get(keyOf(projectId, name)) ?? null),
      set: (projectId, name, sha, seenVersion) =>
        Effect.suspend(() => {
          const existing = rows.get(keyOf(projectId, name));
          if ((existing?.version ?? null) !== seenVersion) {
            return Effect.fail(new StoreRefConflictError({ projectId, name, seenVersion }));
          }
          const row: StoreRef = {
            projectId,
            name,
            sha,
            version: (existing?.version ?? 0) + 1,
            updatedAt: new Date(),
          };
          rows.set(keyOf(projectId, name), row);
          return Effect.succeed(row);
        }),
      remove: (projectId, name, seenVersion) =>
        Effect.suspend(() => {
          const existing = rows.get(keyOf(projectId, name));
          if (existing === undefined || existing.version !== seenVersion) {
            return Effect.fail(new StoreRefConflictError({ projectId, name, seenVersion }));
          }
          rows.delete(keyOf(projectId, name));
          return Effect.void;
        }),
      refsMap: (projectId) =>
        Effect.sync(() =>
          Object.fromEntries(
            [...rows.values()]
              .filter((row) => row.projectId === projectId)
              .map((row) => [row.name, row.sha]),
          ),
        ),
    };
  });
};

export const PROJECT = ProjectId.make("proj-cap");

export const projectFor = (storePath: string, baseSha: string) =>
  new Project({
    id: PROJECT,
    name: "fixture",
    originUrl: null,
    storePath,
    defaultBranch: "main",
    adoptedSha: Sha.make(baseSha),
    autoTour: "inherit",
    autoName: "inherit",
    autoSuggest: "inherit",
    backgroundSessions: "inherit",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: true,
    inheritUserSkills: true,
    hotSessions: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

export const projectsFor = (project: Project): Layer.Layer<ProjectsRepo> =>
  Layer.succeed(ProjectsRepo, {
    create: () => Effect.die("not in test"),
    setGitAuthMode: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setApplyDotfiles: () => Effect.die("not in test"),
    setInheritUserSkills: () => Effect.die("not in test"),
    setHotSessions: () => Effect.die("not in test"),
    byId: (id) =>
      id === project.id
        ? Effect.succeed(project)
        : Effect.fail(new ProjectNotFoundError({ projectId: id })),
    byName: () => Effect.succeed(null),
    list: () => Effect.succeed([project]),
    setAutomation: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
  });

export const worktreesFor = (rows: Map<string, Worktree>): Layer.Layer<WorktreesRepo> =>
  Layer.succeed(WorktreesRepo, {
    create: (input) =>
      Effect.sync(() => {
        const worktree = new Worktree({ ...input, createdAt: new Date(), updatedAt: new Date() });
        rows.set(worktree.id, worktree);
        return worktree;
      }),
    byId: (id) => {
      const found = rows.get(id);
      return found === undefined
        ? Effect.fail(new WorktreeNotFoundError({ id }))
        : Effect.succeed(found);
    },
    byName: (projectId, name) =>
      Effect.succeed(
        [...rows.values()].find((row) => row.projectId === projectId && row.name === name) ?? null,
      ),
    byDirectory: (projectId, directory) =>
      Effect.succeed(
        [...rows.values()].find(
          (row) => row.projectId === projectId && row.directory === directory,
        ) ?? null,
      ),
    listForProject: (projectId) =>
      Effect.succeed([...rows.values()].filter((row) => row.projectId === projectId)),
    setBase: () => Effect.void,
    rename: (id, name, branch) =>
      Effect.sync(() => {
        const current = rows.get(id);
        if (current !== undefined) {
          rows.set(id, new Worktree({ ...current, name, branch, updatedAt: new Date() }));
        }
      }),
    remove: (id) =>
      Effect.sync(() => {
        rows.delete(id);
      }),
    newestLiveSessionId: () => Effect.succeed(null),
  });

export interface CaptureWorld {
  readonly scratch: string;
  readonly storePath: string;
  readonly work: string;
  readonly baseSha: string;
  readonly project: Project;
  readonly worktrees: Map<string, Worktree>;
  readonly memory: ReturnType<typeof makeMemoryCaptureStore>;
  readonly blobRoot: string;
  /** Store, StoreConfig, BlobStore, CaptureStoreRepo, StoreRefsRepo, GitOpsRunner, CaptureChannel, ProjectsRepo, WorktreesRepo. */
  readonly layer: Layer.Layer<
    | Store
    | StoreConfig
    | BlobStore
    | ProjectsRepo
    | WorktreesRepo
    | CaptureStoreRepo
    | StoreRefsRepo
    | GitOpsRunner
    | CaptureChannel
  >;
}

export const makeCaptureWorld = (): CaptureWorld => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-capture-world-"));
  const repo = makeProjectRepo(scratch);
  const project = projectFor(repo.storePath, repo.baseSha);
  const worktrees = new Map<string, Worktree>();
  const memory = makeMemoryCaptureStore();
  const blobRoot = path.join(scratch, "blobs");
  const storeConfig = StoreConfig.layerFor(path.join(scratch, "store"));
  const store = Store.layer.pipe(Layer.provide(storeConfig));
  const blobs = BlobStoreFsLive(blobRoot);
  const refs = memoryStoreRefs();
  const runner = GitOpsRunnerLive.pipe(
    Layer.provide(store),
    Layer.provide(storeConfig),
    Layer.provide(blobs),
  );
  const channel = CaptureChannelLive.pipe(Layer.provide(memory.layer), Layer.provide(blobs));
  const layer = Layer.mergeAll(
    store,
    storeConfig,
    blobs,
    projectsFor(project),
    worktreesFor(worktrees),
    memory.layer,
    refs,
    runner,
    channel,
  );
  return {
    scratch,
    storePath: repo.storePath,
    work: repo.work,
    baseSha: repo.baseSha,
    project,
    worktrees,
    memory,
    blobRoot,
    layer,
  };
};

export const worktreeRowFor = (
  world: CaptureWorld,
  worktreeId: WorktreeId,
  branch: string,
): Worktree =>
  new Worktree({
    id: worktreeId,
    projectId: world.project.id,
    name: worktreeId,
    directory: worktreeId,
    branch,
    baseSha: Sha.make(world.baseSha),
    baseRef: "main",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

export const newWorktreeId = () => WorktreeId.make(`wt-${crypto.randomUUID().slice(0, 8)}`);
