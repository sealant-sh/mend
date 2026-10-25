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
  type DiffFileFactsListing,
  type DiffFileFactsOptions,
  type DiffRangeOptions,
  type FileListing,
  type FileRead,
  type OpenRawFile,
  RawBlobCache,
  type RawBlobTarget,
  RawCacheLimits,
  type RawTreeSource,
  RawReadError,
  RawPreparationWait,
  parseImmutableTree,
  type GrepQuery,
  type GrepResult,
  type GitError,
  GitOpsRunner,
  type PathsBeyondGit,
  pathsBeyondGit,
  type RunnerCache,
  sha256Hex,
  Store,
  rawTreeOf,
  worktreePathOf,
  worktreeTreeOf,
} from "@mend/store";
import { Deferred, Duration, Effect, Layer, Schema, Scope, Semaphore } from "effect";
import * as Context from "effect/Context";

/**
 * Every "live worktree" read Mend serves, keyed by identity (ADR-0002 "runner.ts": callers keep
 * their names and move behind the runner). Two adapters, selected at the layer boundary with
 * `SessionRepository`:
 *
 * - co-located: today's `Store` bodies beside the files;
 * - captured: the runner's bare cache over the chain head's git class, where the worktree tree
 *   (`worktree_tree`, or the `refs/sealant/capture/worktree` pseudo-ref of a capture from before
 *   the `git_trees` feature) stands in for `add -A; write-tree` and every
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
  /** When the capture was registered (ISO 8601) — how far behind the executor the bytes are. */
  observedAt: Schema.NullOr(Schema.String),
});
export type ReadStamp = typeof ReadStamp.Type;

export const WORKTREE_STAMP: ReadStamp = {
  source: "worktree",
  captureN: null,
  captureId: null,
  seq: null,
  kind: null,
  partial: false,
  observedAt: null,
};

export const stampOf = (row: CaptureRow): ReadStamp => ({
  source: "capture",
  captureN: row.n,
  captureId: row.id,
  seq: row.seq.toString(),
  kind: row.kind,
  partial: row.kind === "auto",
  observedAt: row.createdAt.toISOString(),
});

/** "observed at capture 12 · seq 4,180" — the terse mono fact DESIGN.md asks for. */
export const stampLabel = (stamp: ReadStamp): string =>
  stamp.source === "worktree"
    ? "observed on the worktree"
    : `observed at capture ${stamp.captureN ?? "?"}${stamp.seq === null ? "" : ` · seq ${stamp.seq}`}${stamp.partial ? " · partial" : ""}`;

/** The chain has no head yet (capture 0 never registered) — nothing to read. */
export class WorktreeNotCapturedError extends Schema.TaggedError<WorktreeNotCapturedError>()(
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

/** The API resolves checkpoint membership before supplying its immutable commit and provenance. */
export type RawView =
  | { readonly kind: "current" }
  | { readonly kind: "capture"; readonly captureId: string }
  | { readonly kind: "checkpoint"; readonly commit: string; readonly captureId: string | null };

export interface RawFileObservation extends OpenRawFile {
  readonly stamp?: ReadStamp;
}

/**
 * A prepared file opens at once, with no Git or capture. A miss starts one preparation per file
 * (`source`, then the unpack) in `lifetime`, so it outlives a read that stops waiting, and the
 * read waits `RawPreparationWait` for it. A later miss joins the preparation in flight; past
 * `inFlight` of them a miss is refused as busy, and each ends at `preparationMillis`.
 */
const rawFilesOf = Effect.gen(function* () {
  const lifetime = yield* Scope.Scope;
  const cache = yield* RawBlobCache;
  const limits = yield* RawCacheLimits;
  const inFlight = new Map<string, Deferred.Deferred<void, RawReadError>>();
  const start = (
    key: string,
    file: RawBlobTarget,
    source: Effect.Effect<RawTreeSource, RawReadError>,
  ) =>
    Effect.gen(function* () {
      const done = Deferred.makeUnsafe<void, RawReadError>();
      inFlight.set(key, done);
      yield* Effect.flatMap(source, (tree) => cache.prepare(file, tree)).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(limits.preparationMillis),
          orElse: () => Effect.fail(new RawReadError({ reason: "io" })),
        }),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.delete(key);
          }),
        ),
        Effect.forkIn(lifetime),
      );
      return done;
    });
  return (
    file: RawBlobTarget,
    source: Effect.Effect<RawTreeSource, RawReadError>,
  ): Effect.Effect<OpenRawFile, RawReadError, Scope.Scope> =>
    Effect.gen(function* () {
      const ready = yield* cache.open(file);
      if (ready !== null) return ready;
      const key = JSON.stringify([file.project, file.name, file.path, file.within]);
      const joined = inFlight.get(key);
      if (joined === undefined && inFlight.size >= limits.inFlight)
        return yield* new RawReadError({ reason: "busy" });
      const done = joined ?? (yield* start(key, file, source));
      yield* Deferred.await(done).pipe(
        Effect.timeoutOrElse({
          duration: yield* RawPreparationWait,
          orElse: () => Effect.fail(new RawReadError({ reason: "preparing" })),
        }),
      );
      return (yield* cache.open(file)) ?? (yield* new RawReadError({ reason: "preparing" }));
    });
});

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
      options?: DiffRangeOptions,
    ) => Effect.Effect<Stamped<string>, WorktreeReadError>;
    readonly diffFileFacts: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean },
    ) => Effect.Effect<Stamped<ReadonlyArray<DiffFileFact>>, WorktreeReadError>;
    /** `diffFileFacts` within a budget (`Store.diffFileFactsBounded`): a cut listing, never a failure for size. */
    readonly diffFileFactsBounded: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      a: string,
      b: string,
      options: DiffFileFactsOptions,
    ) => Effect.Effect<Stamped<DiffFileFactsListing>, WorktreeReadError>;
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
    /** Bytes and the selected observation, held by the caller through body consumption. */
    readonly openRawFile: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      target: { readonly path: string; readonly within: string; readonly view?: RawView },
    ) => Effect.Effect<RawFileObservation, RawReadError, Scope.Scope>;
    /**
     * The start of one file, at most `maxBytes`: in the worktree as it stands (`at` null), or in a
     * commit's tree (a checkpoint's sha). Null when nothing readable is there, or the path leaves
     * the worktree.
     */
    readonly readFile: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      relative: string,
      at: string | null,
      maxBytes: number,
    ) => Effect.Effect<Stamped<FileRead | null>, WorktreeReadError>;
    /** Lines of the worktree as it stands that match `query`, at most `limit` (`git grep`). */
    readonly searchFiles: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      query: GrepQuery,
      limit: number,
    ) => Effect.Effect<Stamped<GrepResult>, WorktreeReadError>;
    /**
     * Worktree paths too long for git that the chain head carries (`pathsBeyondGit`): saved and
     * restored in the workspace class, and in no diff git computes. Null where Mend cannot tell
     * (a co-located worktree, a worktree with no capture yet).
     */
    readonly pathsBeyondGit: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<Stamped<PathsBeyondGit> | null>;
  }
>()("@mend/sessions/WorktreeReads") {}

// ─── Co-located ─────────────────────────────────────────────────────────────

export const WorktreeReadsColocatedLive: Layer.Layer<
  WorktreeReads,
  never,
  Store | ProjectsRepo | WorktreesRepo | RawBlobCache
> = Layer.effect(
  WorktreeReads,
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;
    const worktrees = yield* WorktreesRepo;
    const rawFiles = yield* rawFilesOf;
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
      diffFileFactsBounded: (projectId, worktreeId, a, b, options) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.diffFileFactsBounded(dir, a, b, options)),
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
      openRawFile: (projectId, worktreeId, target) =>
        Effect.gen(function* () {
          const view = target.view;
          if (view?.kind === "capture") return yield* new RawReadError({ reason: "missing" });
          if (view?.kind === "checkpoint") {
            const project = yield* projects
              .byId(projectId)
              .pipe(Effect.mapError(() => new RawReadError({ reason: "missing" })));
            const commit = yield* parseImmutableTree(view.commit);
            const file: RawBlobTarget = {
              project: projectId,
              name: { kind: "commit", commit },
              path: target.path,
              within: target.within,
            };
            return yield* rawFiles(
              file,
              Effect.succeed({ repository: project.storePath, tree: commit }),
            );
          }
          const dir = yield* pathOf(projectId, worktreeId).pipe(
            Effect.mapError(() => new RawReadError({ reason: "missing" })),
          );
          return yield* store.openRawWorktreeFile(dir, target.path, target.within);
        }),
      readFile: (projectId, worktreeId, relative, at, maxBytes) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) =>
            at === null
              ? store.readWorktreeFile(dir, relative, maxBytes)
              : store.readBlob(dir, at, relative, maxBytes),
          ),
          Effect.map(stamped),
        ),
      searchFiles: (projectId, worktreeId, query, limit) =>
        pathOf(projectId, worktreeId).pipe(
          Effect.flatMap((dir) => store.grep(dir, null, query, limit)),
          Effect.map(stamped),
        ),
      pathsBeyondGit: () => Effect.succeed(null),
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

const selectedCapture = (worktreeId: WorktreeId, historical?: { readonly captureId: string }) =>
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const unavailable = (reason: string) =>
      new WorktreeNotCapturedError({
        worktreeId,
        message: `the checkpoint's historical Git evidence is unavailable · ${reason}`,
      });
    const chainHead =
      historical === undefined
        ? ((yield* repo.headOf(worktreeId))?.head ?? null)
        : yield* repo.captureById(historical.captureId);
    if (historical !== undefined && (chainHead === null || chainHead.worktreeId !== worktreeId)) {
      return yield* unavailable("its recorded capture is not retained for this worktree");
    }
    if (chainHead === null) {
      return yield* new WorktreeNotCapturedError({
        worktreeId,
        message: "the worktree has no registered capture yet",
      });
    }
    // A head whose git section failed verification (a pack that omits a tree it names) is not
    // read: the newest capture below it that verified is, and the stamp says so. An unverified
    // head is read as is — the failure, if any, surfaces with git's own words.
    if (historical !== undefined && chainHead.gitFsck === "failed") {
      return yield* unavailable("its capture failed Git verification");
    }
    const head =
      historical === undefined && chainHead.gitFsck === "failed"
        ? ((yield* repo.listChain(worktreeId))
            .filter((row) => row.n < chainHead.n && row.gitFsck === "verified")
            .at(-1) ?? chainHead)
        : chainHead;
    if (head.id !== chainHead.id) {
      yield* Effect.logInfo(
        "capture reads: the head's git section failed verification · reading the newest verified capture",
      ).pipe(
        Effect.annotateLogs({
          worktreeId,
          headN: chainHead.n,
          headCaptureId: chainHead.id,
          readN: head.n,
          readCaptureId: head.id,
        }),
      );
    }
    return head;
  });

/**
 * A capture a read named after a current read returned it: still retained for this worktree, and
 * one `selectedCapture` could have chosen. A failed capture is chosen only while no capture below
 * it verified, so a pin to it stands under the same condition.
 */
const pinnedCapture = (worktreeId: WorktreeId, captureId: string) =>
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const row = yield* repo.captureById(captureId);
    if (row === null || row.worktreeId !== worktreeId)
      return yield* new WorktreeNotCapturedError({
        worktreeId,
        message: "the pinned capture is not retained for this worktree",
      });
    if (
      row.gitFsck === "failed" &&
      (yield* repo.listChain(worktreeId)).some(
        (below) => below.n < row.n && below.gitFsck === "verified",
      )
    )
      return yield* new WorktreeNotCapturedError({
        worktreeId,
        message: "the pinned capture failed Git verification under a verified one",
      });
    return row;
  });

/** The capture a raw read observes: the one a JSON read selects, a pinned one, or a checkpoint's. */
const rawCapture = (
  worktreeId: WorktreeId,
  view: RawView,
): Effect.Effect<CaptureRow, RawReadError | WorktreeNotCapturedError, CaptureStoreRepo> => {
  if (view.kind === "current") return selectedCapture(worktreeId);
  const captureId = view.captureId;
  if (captureId === null || !/^[a-f0-9]{64}$/.test(captureId))
    return Effect.fail(new RawReadError({ reason: "missing" }));
  return view.kind === "capture"
    ? pinnedCapture(worktreeId, captureId)
    : selectedCapture(worktreeId, { captureId });
};

/**
 * Prepare the runner cache for a worktree's chain head: fetch and decode the head manifest,
 * write the refs (store refs, the manifest's own, Mend's derived checkpoint packs) and hand
 * back the handle every read takes. Shared by the read adapter and the captured repository.
 * An explicit captureId reads only that retained historical capture, refusing lost/invalid
 * evidence instead of falling back to another capture. Derived packs are scoped to this worktree.
 */
export const ensureCaptureCache = Effect.fn("ensureCaptureCache")(function* (
  projectId: ProjectId,
  worktreeId: WorktreeId,
  historical?: { readonly captureId: string },
) {
  const head = yield* selectedCapture(worktreeId, historical);
  return yield* restoreCapture(projectId, worktreeId, head, historical !== undefined);
});

/**
 * The runner cache over exactly `head`. A strict restore refuses evidence that does not match its
 * row, where a lenient one (the chain head's) dies on it or answers git's own error.
 */
const restoreCapture = Effect.fnUntraced(function* (
  projectId: ProjectId,
  worktreeId: WorktreeId,
  head: CaptureRow,
  strict: boolean,
) {
  const repo = yield* CaptureStoreRepo;
  const blobs = yield* BlobStore;
  const runner = yield* GitOpsRunner;
  const refs = yield* StoreRefsRepo;
  const historical = strict ? { captureId: head.id } : undefined;
  const unavailable = (reason: string) =>
    new WorktreeNotCapturedError({
      worktreeId,
      message: `the checkpoint's historical Git evidence is unavailable · ${reason}`,
    });
  const bytes = yield* blobs
    .get(head.manifestKey)
    .pipe(
      Effect.catch((error) =>
        historical === undefined
          ? Effect.die(`capture reads: head manifest: ${error._tag}`)
          : Effect.fail(unavailable("its capture manifest could not be read")),
      ),
    );
  if (historical !== undefined && sha256Hex(bytes) !== historical.captureId) {
    return yield* unavailable("its capture manifest does not match the recorded digest");
  }
  const manifest = yield* decodeManifest(head.manifestKey, bytes).pipe(
    Effect.catch((error) =>
      historical === undefined
        ? Effect.die(`capture reads: head manifest: ${error.reason}`)
        : Effect.fail(unavailable("its capture manifest is invalid")),
    ),
  );
  if (
    historical !== undefined &&
    (manifest.worktree_id !== worktreeId || manifest.n !== head.n || manifest.epoch !== head.epoch)
  ) {
    return yield* unavailable("its capture manifest does not match the recorded worktree");
  }
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
      Effect.catch(
        (error): Effect.Effect<never, GitError | WorktreeNotCapturedError> =>
          historical !== undefined
            ? Effect.fail(unavailable("its retained Git objects could not be restored"))
            : error._tag === "GitError"
              ? Effect.fail(error)
              : Effect.die(`capture reads: runner ensure: ${error._tag}`),
      ),
    );
  // `worktree_tree` (the `git_trees` feature), else the pseudo-ref of a capture from before it.
  const worktreeTree = worktreeTreeOf(manifest.sections.git) ?? manifest.sections.git.head;
  return { cache, head, manifest, stamp: stampOf(head), worktreeTree } satisfies CaptureCache;
});

export const WorktreeReadsCapturedLive: Layer.Layer<
  WorktreeReads,
  never,
  CaptureStoreRepo | BlobStore | GitOpsRunner | StoreRefsRepo | RawBlobCache
> = Layer.effect(
  WorktreeReads,
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;
    /** Per capture: a capture never changes, so its count is read once. */
    const beyondGit = new Map<string, PathsBeyondGit>();
    const BEYOND_GIT_CACHE = 256;
    const prepared = (projectId: ProjectId, worktreeId: WorktreeId) =>
      ensureCaptureCache(projectId, worktreeId).pipe(
        Effect.provideService(CaptureStoreRepo, repo),
        Effect.provideService(BlobStore, blobs),
        Effect.provideService(GitOpsRunner, runner),
        Effect.provideService(StoreRefsRepo, refs),
      );
    const rawFiles = yield* rawFilesOf;
    const restores = yield* Semaphore.make((yield* RawCacheLimits).restores);
    /**
     * Where Git finds `file`. The runner cache is restored on every preparation, never kept: the
     * runner prunes a project's repository when others need the room.
     */
    const rawSource = (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      head: CaptureRow,
      file: RawBlobTarget,
    ): Effect.Effect<RawTreeSource, RawReadError> =>
      Effect.gen(function* () {
        const ready = yield* restoreCapture(projectId, worktreeId, head, true);
        if (file.name.kind === "commit")
          return { repository: ready.cache.path, tree: file.name.commit };
        // The files' bytes as they stood, before clean, LFS and line-ending filters.
        const tree = yield* runner.resolve(
          ready.cache,
          rawTreeOf(ready.manifest.sections.git) ?? ready.manifest.sections.git.head,
        );
        return { repository: ready.cache.path, tree: yield* parseImmutableTree(tree) };
      }).pipe(
        Effect.provideService(CaptureStoreRepo, repo),
        Effect.provideService(BlobStore, blobs),
        Effect.provideService(GitOpsRunner, runner),
        Effect.provideService(StoreRefsRepo, refs),
        Effect.mapError(() => new RawReadError({ reason: "missing" })),
        restores.withPermits(1),
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
      diffFileFactsBounded: (projectId, worktreeId, a, b, options) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .diffFileFactsBounded(ready.cache, a, b, options)
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
      openRawFile: (projectId, worktreeId, target) =>
        Effect.gen(function* () {
          const view = target.view ?? { kind: "current" };
          // Selected before any open, so a capture no longer retained is never served from the cache.
          const head = yield* rawCapture(worktreeId, view).pipe(
            Effect.provideService(CaptureStoreRepo, repo),
            Effect.mapError(() => new RawReadError({ reason: "missing" })),
          );
          const file: RawBlobTarget = {
            project: projectId,
            name:
              view.kind === "checkpoint"
                ? { kind: "commit", commit: yield* parseImmutableTree(view.commit) }
                : { kind: "capture", captureId: head.id },
            path: target.path,
            within: target.within,
          };
          const opened = yield* rawFiles(file, rawSource(projectId, worktreeId, head, file));
          return { ...opened, stamp: stampOf(head) };
        }),
      // The worktree as it stands is the head capture's tree.
      readFile: (projectId, worktreeId, relative, at, maxBytes) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .readBlob(ready.cache, at ?? ready.worktreeTree, relative, maxBytes)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      searchFiles: (projectId, worktreeId, query, limit) =>
        prepared(projectId, worktreeId).pipe(
          Effect.flatMap((ready) =>
            runner
              .grep(ready.cache, ready.worktreeTree, query, limit)
              .pipe(Effect.map((value) => ({ value, stamp: ready.stamp }))),
          ),
        ),
      pathsBeyondGit: (_projectId, worktreeId) =>
        Effect.gen(function* () {
          const head = (yield* repo.headOf(worktreeId))?.head ?? null;
          if (head === null) return null;
          const known = beyondGit.get(head.id);
          if (known !== undefined) return { value: known, stamp: stampOf(head) };
          const bytes = yield* blobs.get(head.manifestKey);
          const manifest = yield* decodeManifest(head.manifestKey, bytes);
          const value = yield* pathsBeyondGit(manifest).pipe(
            Effect.provideService(BlobStore, blobs),
          );
          if (beyondGit.size >= BEYOND_GIT_CACHE) beyondGit.clear();
          beyondGit.set(head.id, value);
          return { value, stamp: stampOf(head) };
        }).pipe(
          // Unreadable is not none: the caller says nothing rather than `0 paths`.
          Effect.catch((error) =>
            Effect.logWarning("capture reads: paths beyond git unreadable").pipe(
              Effect.annotateLogs({ worktreeId, error: error._tag }),
              Effect.as(null),
            ),
          ),
        ),
    };
  }),
);
