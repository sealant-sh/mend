import {
  CaptureStoreRepo,
  ProjectNotFoundError,
  ProjectsRepo,
  StoreRefsRepo,
  WorktreesRepo,
  type CaptureRow,
  type WorktreeNotFoundError,
} from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  type CaptureManifest,
  type ChangedFile,
  decodeManifest,
  type DiffFileFact,
  type FileListing,
  type GitError,
  GitOpsRunner,
  type RunnerCache,
  Store,
  WORKTREE_TREE_REF,
  worktreePathOf,
} from "@mend/store";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * Every "live worktree" read Mend serves, keyed by identity (ADR-0002 "runner.ts": callers keep
 * their names and move behind the runner). Two adapters, selected at the layer boundary with
 * `SessionRepository`:
 *
 * - co-located: today's `Store` bodies beside the files;
 * - captured: the runner's bare cache over the chain head's git class, where the worktree
 *   pseudo-ref (`refs/sealant/capture/worktree`) stands in for `add -A; write-tree` and every
 *   answer carries the stamp the review page renders — "observed at capture n · seq s".
 *
 * A stamp is never a verdict: it says which capture the bytes came from, and whether that
 * capture was `auto` (partial by ADR-0015 — not atomic across files).
 */

export const ReadStamp = Schema.Struct({
  source: Schema.Literals(["worktree", "capture"]),
  captureN: Schema.NullOr(Schema.Int),
  captureId: Schema.NullOr(Schema.String),
  seq: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  /** `auto` captures tear across files; the next capture corrects it. */
  partial: Schema.Boolean,
});
export type ReadStamp = typeof ReadStamp.Type;

export const WORKTREE_STAMP: ReadStamp = {
  source: "worktree",
  captureN: null,
  captureId: null,
  seq: null,
  kind: null,
  partial: false,
};

export const stampOf = (row: CaptureRow): ReadStamp => ({
  source: "capture",
  captureN: row.n,
  captureId: row.id,
  seq: row.seq.toString(),
  kind: row.kind,
  partial: row.kind === "auto",
});

/** "observed at capture 12 · seq 4,180" — the terse mono fact DESIGN.md asks for. */
export const stampLabel = (stamp: ReadStamp): string =>
  stamp.source === "worktree"
    ? "observed on the worktree"
    : `observed at capture ${stamp.captureN ?? "?"}${stamp.seq === null ? "" : ` · seq ${stamp.seq}`}${stamp.partial ? " · partial" : ""}`;

/** The chain has no head yet (capture 0 never registered) — nothing to read. */
export class WorktreeNotCapturedError extends Schema.TaggedErrorClass<WorktreeNotCapturedError>()(
  "WorktreeNotCapturedError",
  { worktreeId: Schema.String, message: Schema.String },
) {}

export type WorktreeReadError =
  | GitError
  | ProjectNotFoundError
  | WorktreeNotFoundError
  | WorktreeNotCapturedError;

export interface Stamped<A> {
  readonly value: A;
  readonly stamp: ReadStamp;
}

export class WorktreeReads extends Context.Service<
  WorktreeReads,
  {
    /** The worktree against `base`: tracked edits plus untracked files, rendered. */
    readonly diffWorktree: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      base: string,
    ) => Effect.Effect<Stamped<string>, WorktreeReadError>;
    readonly changedFiles: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      base: string,
    ) => Effect.Effect<Stamped<ReadonlyArray<ChangedFile>>, WorktreeReadError>;
    readonly diffRange: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean; readonly contextLines?: number },
    ) => Effect.Effect<Stamped<string>, WorktreeReadError>;
    readonly diffFileFacts: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean },
    ) => Effect.Effect<Stamped<ReadonlyArray<DiffFileFact>>, WorktreeReadError>;
    /** Whether the worktree's tree equals `commit`'s tree. */
    readonly worktreeMatchesCommit: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      commit: string,
    ) => Effect.Effect<Stamped<boolean>, WorktreeReadError>;
    readonly listWorktreeFiles: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      limit: number,
    ) => Effect.Effect<Stamped<FileListing>, WorktreeReadError>;
  }
>()("@mend/sessions/WorktreeReads") {}

// ─── Co-located ─────────────────────────────────────────────────────────────

export const WorktreeReadsColocatedLive: Layer.Layer<
  WorktreeReads,
  never,
  Store | ProjectsRepo | WorktreesRepo
> = Layer.effect(
  WorktreeReads,
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;
    const worktrees = yield* WorktreesRepo;
    const pathOf = (projectId: ProjectId, worktreeId: WorktreeId) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(projectId);
        const worktree = yield* worktrees.byId(worktreeId);
        return worktreePathOf(project.storePath, worktree.directory);
      });
    const stamped = <A>(value: A): Stamped<A> => ({ value, stamp: WORKTREE_STAMP });
    return {
      diffWorktree: (projectId, worktreeId, base) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.diffWorktree(dir, base)),
          Effect.map(stamped),
        ),
      changedFiles: (projectId, worktreeId, base) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.changedFiles(dir, base, null)),
          Effect.map(stamped),
        ),
      diffRange: (projectId, worktreeId, a, b, options) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.diffRange(dir, a, b, options)),
          Effect.map(stamped),
        ),
      diffFileFacts: (projectId, worktreeId, a, b, options) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.diffFileFacts(dir, a, b, options)),
          Effect.map(stamped),
        ),
      worktreeMatchesCommit: (projectId, worktreeId, commit) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.worktreeMatchesCommit(dir, commit)),
          Effect.map(stamped),
        ),
      listWorktreeFiles: (projectId, worktreeId, limit) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.listWorktreeFiles(dir, limit)),
          Effect.map(stamped),
        ),
    };
  }),
);

// ─── Captured ───────────────────────────────────────────────────────────────

export interface CaptureCache {
  readonly cache: RunnerCache;
  readonly head: CaptureRow;
  readonly manifest: CaptureManifest;
  readonly stamp: ReadStamp;
  /** The worktree tree at capture time, or the head commit when the capture carried none. */
  readonly worktreeTree: string;
}

/** Mend-made packs for a worktree live under the project prefix, never an epoch's. */
export const derivedPackPrefix = (projectId: ProjectId) => `projects/${projectId}/packs/`;

/**
 * Prepare the runner cache for a worktree's chain head: fetch and decode the head manifest,
 * write the refs (store refs, the manifest's own, Mend's derived checkpoint packs) and hand
 * back the handle every read takes. Shared by the read adapter and the captured repository.
 */
export const ensureCaptureCache = Effect.fn("ensureCaptureCache")(function* (
  projectId: ProjectId,
  worktreeId: WorktreeId,
) {
  const repo = yield* CaptureStoreRepo;
  const blobs = yield* BlobStore;
  const runner = yield* GitOpsRunner;
  const refs = yield* StoreRefsRepo;
  const chain = yield* repo.headOf(worktreeId);
  const head = chain?.head ?? null;
  if (head === null) {
    return yield* new WorktreeNotCapturedError({
      worktreeId,
      message: "the worktree has no registered capture yet",
    });
  }
  const bytes = yield* blobs
    .get(head.manifestKey)
    .pipe(Effect.catch((error) => Effect.die(`capture reads: head manifest: ${error._tag}`)));
  const manifest = yield* decodeManifest(head.manifestKey, bytes).pipe(
    Effect.catch((error) => Effect.die(`capture reads: head manifest: ${error.reason}`)),
  );
  const derived = (yield* repo.listPacks())
    .filter(
      (pack) =>
        pack.class === "git" &&
        pack.worktreeId === worktreeId &&
        pack.state !== "retired" &&
        pack.key.startsWith(derivedPackPrefix(projectId)),
    )
    .map((pack) => pack.key);
  const cache = yield* runner
    .ensure({
      projectId,
      manifest,
      storeRefs: yield* refs.refsMap(projectId),
      extraPacks: derived,
    })
    .pipe(
      Effect.catch((error) =>
        error._tag === "GitError"
          ? Effect.fail(error)
          : Effect.die(`capture reads: runner ensure: ${error._tag}`),
      ),
    );
  const worktreeTree = manifest.sections.git.refs[WORKTREE_TREE_REF] ?? manifest.sections.git.head;
  return { cache, head, manifest, stamp: stampOf(head), worktreeTree } satisfies CaptureCache;
});

export const WorktreeReadsCapturedLive: Layer.Layer<
  WorktreeReads,
  never,
  CaptureStoreRepo | BlobStore | GitOpsRunner | StoreRefsRepo
> = Layer.effect(
  WorktreeReads,
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;
    const prepared = (projectId: ProjectId, worktreeId: WorktreeId) =>
      ensureCaptureCache(projectId, worktreeId).pipe(
        Effect.provideService(CaptureStoreRepo, repo),
        Effect.provideService(BlobStore, blobs),
        Effect.provideService(GitOpsRunner, runner),
        Effect.provideService(StoreRefsRepo, refs),
      );
    return {
      diffWorktree: (projectId, worktreeId, base) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .diffRange(ready.cache, base, ready.worktreeTree)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      changedFiles: (projectId, worktreeId, base) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .changedFiles(ready.cache, base, ready.worktreeTree)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      diffRange: (projectId, worktreeId, a, b, options) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .diffRange(ready.cache, a, b, options)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      diffFileFacts: (projectId, worktreeId, a, b, options) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .diffFileFacts(ready.cache, a, b, options)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      worktreeMatchesCommit: (projectId, worktreeId, commit) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            Effect.all([
              runner.treeOf(ready.cache, ready.worktreeTree),
              runner.treeOf(ready.cache, commit),
            ]).pipe(
              Effect.map(([current, expected]) => ({
                value: current === expected,
                stamp: ready.stamp,
              })),
            ),
          ),
        ),
      listWorktreeFiles: (projectId, worktreeId, limit) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .listTreeFiles(ready.cache, ready.worktreeTree, limit)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
    };
  }),
);
