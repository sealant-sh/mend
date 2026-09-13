import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CaptureStoreRepo,
  ProjectsRepo,
  StoreRefsRepo,
  WorktreesRepo,
  type CaptureRow,
} from "@mend/db";
import { type ProjectId, Sha, type WorktreeId } from "@mend/domain";
import {
  BlobStore,
  type CaptureManifest,
  captureIdOf,
  captureKeys,
  decodeManifest,
  encodeDirObject,
  git,
  GitError,
  GitOpsRunner,
  INDEX_TREE_REF,
  packIdxKeyOf,
  sha256Hex,
  Store,
  WORKTREE_TREE_REF,
  worktreePathOf,
} from "@mend/store";
import { Duration, Effect, Layer } from "effect";

import { CaptureChannel } from "./capture-channel.ts";
import { readDependencyCache } from "./dependency-cache.ts";
import { SessionRepository } from "./session-repository.ts";
import { derivedPackPrefix, ensureCaptureCache } from "./worktree-reads.ts";

/**
 * The capture-store adapter of the session authority (ADR-0002 "SessionRepositoryCapturedLive"):
 * the same port as `session-repository.ts`, served without a directory. Identities resolve to
 * chain heads in Postgres and objects in the bucket; git runs on the runner's cache when Mend
 * itself has to compute something.
 *
 * - `createWorktree` resolves the base and writes the branch ref; `attachWorktree` (called once
 *   the worktree row exists) packs the base, uploads it under the project prefix and registers
 *   capture 0 — an empty workspace class over the base's git section — under a Mend-held epoch
 *   that is released at once, so the executor's first `plan.get` claims epoch + 1. A worktree
 *   that still has a DIRECTORY in the store (adopted before captures, ADR-0002 amended
 *   2026-09-13) is backfilled instead of rebased: capture 0's tree is a final co-located
 *   checkpoint of the directory's current files, so uncommitted work rides into the bucket.
 * - `checkpoint` takes the newest `checkpoint` capture when the executor already posted one for
 *   this ordinal; otherwise — unless the engine flushed the lease holder first (`flushed`,
 *   `workspace.capture.flush()` since SDK 0.31.0) — it waits briefly for one to land, and then
 *   derives the snapshot on the runner from the head capture's worktree tree: the same commit
 *   the co-located store would have made, packed under `projects/<project>/packs/`, its ref in
 *   `store_refs`. The checkpoint row then names the capture it was observed from.
 * - `worktreeMount` answers undefined: nothing is co-located.
 */

/**
 * How long a Mend-requested checkpoint waits for the executor's own `checkpoint` capture: one
 * quiet window of sealantd's cadence (2 s quiet / 10 s maximum while dirty, ADR-0015).
 */
export const CHECKPOINT_WAIT = Duration.seconds(2);

const checkpointRef = (worktreeId: string, index: number) =>
  `refs/mend/checkpoints/${worktreeId}/${index}`;

const gitFailure = (cwd: string, what: string, detail: string) =>
  new GitError({ args: ["capture", what], cwd, exitCode: null, stderr: detail });

export const SessionRepositoryCapturedLive: Layer.Layer<
  SessionRepository,
  never,
  | Store
  | ProjectsRepo
  | WorktreesRepo
  | BlobStore
  | CaptureStoreRepo
  | StoreRefsRepo
  | GitOpsRunner
  | CaptureChannel
> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;
    const worktrees = yield* WorktreesRepo;
    const blobs = yield* BlobStore;
    const repo = yield* CaptureStoreRepo;
    const refs = yield* StoreRefsRepo;
    const runner = yield* GitOpsRunner;
    const channel = yield* CaptureChannel;
    const prepared = (projectId: ProjectId, worktreeId: WorktreeId) =>
      ensureCaptureCache(projectId, worktreeId).pipe(
        Effect.provideService(CaptureStoreRepo, repo),
        Effect.provideService(BlobStore, blobs),
        Effect.provideService(GitOpsRunner, runner),
        Effect.provideService(StoreRefsRepo, refs),
      );
    const blobFailure = (cwd: string, what: string) => (error: { readonly _tag: string }) =>
      gitFailure(cwd, what, `bucket: ${error._tag}`);

    /**
     * A self-contained pack of `sha`'s closure from the project's bare repo, content-addressed
     * under the project prefix; already-present packs are not re-uploaded.
     */
    const uploadBasePack = Effect.fn("SessionRepositoryCaptured.uploadBasePack")(function* (
      projectId: ProjectId,
      storePath: string,
      sha: Sha,
    ) {
      // Staged inside the store repository's object directory, as the runner stages its derived
      // packs: `pack-objects` renames its temporary pack into place, and a rename across
      // filesystems fails with EXDEV (a tmpfs `/tmp` against the store's disk — observed).
      const staging = path.join(storePath, "objects", `base-pack-${crypto.randomUUID()}`);
      fs.mkdirSync(staging, { recursive: true });
      const attempt = Effect.gen(function* () {
        const name = yield* git(
          ["pack-objects", "-q", "--revs", path.join(staging, "p")],
          storePath,
          undefined,
          undefined,
          `${sha}\n`,
        );
        const pack = new Uint8Array(fs.readFileSync(path.join(staging, `p-${name}.pack`)));
        const idx = new Uint8Array(fs.readFileSync(path.join(staging, `p-${name}.idx`)));
        const key = `${derivedPackPrefix(projectId)}${sha256Hex(pack)}`;
        yield* blobs
          .put(key, pack, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(storePath, "put")));
        yield* blobs
          .put(packIdxKeyOf(key), idx, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(storePath, "put")));
        yield* repo.recordPacks([
          {
            key,
            class: "git",
            bytes: pack.byteLength,
            worktreeId: null,
            epoch: null,
            platform: null,
          },
        ]);
        return { key, bytes: pack.byteLength };
      });
      return yield* attempt.pipe(
        Effect.ensuring(Effect.sync(() => fs.rmSync(staging, { recursive: true, force: true }))),
      );
    });

    const headManifest = (row: CaptureRow) =>
      blobs.get(row.manifestKey).pipe(
        Effect.flatMap((bytes) => decodeManifest(row.manifestKey, bytes)),
        Effect.mapError((error) => gitFailure("", "manifest", `${row.manifestKey}: ${error._tag}`)),
      );

    const createWorktree: SessionRepository["Service"]["createWorktree"] = (
      projectId,
      identity,
      base,
      remoteEnv,
    ) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(projectId);
        const resolved = yield* store.resolveBase(project.storePath, base, remoteEnv);
        // The branch is the worktree's ref, moved only by Mend (`store_refs`); a name already
        // taken is refused the way the co-located adapter refuses an existing branch.
        yield* refs
          .set(projectId, `refs/heads/${identity.branch}`, resolved.baseSha, null)
          .pipe(
            Effect.mapError(() =>
              gitFailure(
                project.storePath,
                "create",
                `branch "${identity.branch}" already exists in this project — pick another worktree name`,
              ),
            ),
          );
        return {
          name: identity.directory,
          branch: identity.branch,
          baseSha: resolved.baseSha,
          baseRef: resolved.baseRef,
        };
      });

    const attachWorktree: NonNullable<SessionRepository["Service"]["attachWorktree"]> = (
      projectId,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(projectId);
        const worktree = yield* worktrees
          .byId(worktreeId)
          .pipe(
            Effect.mapError(() =>
              gitFailure(project.storePath, "attach", `worktree ${worktreeId} has no row`),
            ),
          );
        yield* repo.init(worktreeId);
        const existing = yield* repo.headOf(worktreeId);
        if (existing?.head !== null && existing?.head !== undefined) return;
        // A legacy directory (the deprecated co-located store made it): its files, HEAD and
        // branch are the truth capture 0 must carry — not the base the row remembers.
        const legacyDir = worktreePathOf(project.storePath, worktree.directory);
        const legacy = fs.existsSync(path.join(legacyDir, ".git"))
          ? yield* backfillFromDirectory(project.storePath, legacyDir, worktreeId)
          : null;
        const headSha = legacy?.headSha ?? worktree.baseSha;
        const checkpointSha = legacy?.checkpointSha ?? worktree.baseSha;
        const basePack = yield* uploadBasePack(projectId, project.storePath, checkpointSha);
        const baseTree = yield* git(
          ["rev-parse", "--verify", `${checkpointSha}^{tree}`],
          project.storePath,
        );
        if (legacy !== null) {
          yield* Effect.logInfo(
            "capture mode: legacy worktree backfilled · capture 0 is the directory's current files",
          ).pipe(Effect.annotateLogs({ worktreeId, headSha, checkpointSha, directory: legacyDir }));
        }
        yield* refs
          .set(projectId, `refs/mend/base/${worktreeId}`, worktree.baseSha, null)
          .pipe(Effect.ignore);
        // Capture 0 under a Mend-held epoch: the CAS needs a live lease; the release right
        // after lets the executor's first plan claim the next epoch at once.
        const claimed = yield* repo
          .claim(worktreeId, `mend:${worktreeId}`)
          .pipe(
            Effect.mapError(() =>
              gitFailure(project.storePath, "attach", "the worktree is leased before capture 0"),
            ),
          );
        const finish = Effect.gen(function* () {
          const keys = captureKeys(worktreeId, claimed.epoch);
          // The empty workspace class is a real (empty) dir object, not a `""` root: sealantd's
          // materialiser fetches every class root by key and has no empty-root case (observed:
          // "no GET url in plan for" with an empty key).
          const emptyRoot = encodeDirObject([]);
          const emptyRootKey = keys.tree(sha256Hex(emptyRoot));
          yield* blobs
            .put(emptyRootKey, emptyRoot, { ifAbsent: true })
            .pipe(Effect.catch(blobFailure(project.storePath, "put")));
          const manifest: CaptureManifest = {
            worktree_id: worktreeId,
            n: 0,
            parent: null,
            epoch: claimed.epoch,
            seq: 0,
            kind: "checkpoint",
            created_at: new Date().toISOString(),
            sections: {
              git: {
                packs: [basePack.key],
                refs: {
                  [`refs/heads/${worktree.branch}`]: headSha,
                  [WORKTREE_TREE_REF]: baseTree,
                  [INDEX_TREE_REF]: baseTree,
                },
                head: `refs/heads/${worktree.branch}`,
                fsck: "verified",
              },
              workspace: { root: emptyRootKey, packs: [] },
              bulk: "pending",
            },
            checkpoint: {
              ordinal: 0,
              sha: checkpointSha,
              ref: checkpointRef(worktreeId, 0),
            },
          };
          const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8"));
          const id = captureIdOf(bytes);
          const manifestKey = keys.manifest(id);
          yield* blobs
            .put(manifestKey, bytes, { ifAbsent: true })
            .pipe(Effect.catch(blobFailure(project.storePath, "put")));
          yield* repo
            .register({
              worktreeId,
              id,
              n: 0,
              parent: null,
              epoch: claimed.epoch,
              seq: 0n,
              kind: "checkpoint",
              manifestKey,
              sections: manifest.sections,
              gitFsck: "verified",
            })
            .pipe(
              Effect.mapError((error) =>
                gitFailure(project.storePath, "attach", `capture 0: ${error.reason}`),
              ),
            );
          yield* refs
            .set(projectId, checkpointRef(worktreeId, 0), checkpointSha, null)
            .pipe(Effect.ignore);
          if (legacy !== null) {
            yield* refs
              .set(projectId, `refs/heads/${worktree.branch}`, headSha, null)
              .pipe(Effect.ignore);
          }
          const row = yield* repo.captureById(id);
          if (row !== null) channel.publish(row);
        });
        yield* finish.pipe(Effect.ensuring(repo.release(worktreeId, claimed.epoch)));
      });

    /**
     * The legacy backfill (ADR-0002 amended 2026-09-13, decision 24): one co-located checkpoint
     * of the directory — `add -A` under a temporary index, `write-tree`, `commit-tree` on the
     * directory's HEAD — under its own ref namespace so it collides with no ordinal the engine
     * hands out. Its closure is what the base pack carries.
     */
    const backfillFromDirectory = Effect.fn("SessionRepositoryCaptured.backfillFromDirectory")(
      function* (storePath: string, dir: string, worktreeId: WorktreeId) {
        const headSha = Sha.make(yield* git(["rev-parse", "--verify", "HEAD"], dir));
        const snapshot = yield* store.checkpoint(dir, `backfill-${worktreeId}`, 0, headSha);
        void storePath;
        return { headSha, checkpointSha: snapshot.sha };
      },
    );

    const renameBranch: SessionRepository["Service"]["renameBranch"] = (
      projectId,
      worktreeName,
      newBranch,
    ) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(projectId);
        const worktree = yield* worktrees.byName(projectId, worktreeName);
        if (worktree === null) {
          return yield* gitFailure(project.storePath, "rename", `no worktree "${worktreeName}"`);
        }
        const current = yield* refs.get(projectId, `refs/heads/${worktree.branch}`);
        const sha = current?.sha ?? worktree.baseSha;
        yield* refs
          .set(projectId, `refs/heads/${newBranch}`, sha, null)
          .pipe(
            Effect.mapError(() =>
              gitFailure(project.storePath, "rename", `branch "${newBranch}" already exists`),
            ),
          );
        if (current !== null) {
          yield* refs.remove(projectId, current.name, current.version).pipe(Effect.ignore);
        }
        // The executor learns the new ref on its next plan; a rename never moves bytes.
      });

    const resetWorktree: SessionRepository["Service"]["resetWorktree"] = (
      projectId,
      worktreeName,
    ) =>
      projects
        .byId(projectId)
        .pipe(
          Effect.flatMap((project) =>
            gitFailure(
              project.storePath,
              "reset",
              `worktree "${worktreeName}" cannot be reset in capture mode: a new capture 0 is a new worktree, and the hot pool does not freshen captured worktrees`,
            ),
          ),
        );

    const removeWorktreeForce: SessionRepository["Service"]["removeWorktreeForce"] = (
      projectId,
      worktreeName,
    ) =>
      Effect.gen(function* () {
        yield* projects.byId(projectId);
        const worktree = yield* worktrees.byName(projectId, worktreeName);
        if (worktree === null) return { leftover: null };
        // Release the lease under its epoch; the chain stays and retention retires the packs.
        const lease = yield* repo.leaseOf(worktree.id);
        if (lease !== null && lease.live) yield* repo.release(worktree.id, lease.epoch);
        return { leftover: null };
      });

    const checkpoint: SessionRepository["Service"]["checkpoint"] = (input) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(input.projectId);
        const worktreeId = input.scope;
        const chain = yield* repo.headOf(worktreeId as WorktreeId);
        if (chain?.head === null || chain?.head === undefined) {
          return yield* gitFailure(project.storePath, "checkpoint", "no capture registered yet");
        }
        // 1. The executor already posted a checkpoint capture for this ordinal.
        const fromHead = yield* headManifest(chain.head);
        if (fromHead.checkpoint !== undefined && fromHead.checkpoint.ordinal === input.index) {
          return {
            ref: fromHead.checkpoint.ref,
            sha: Sha.make(fromHead.checkpoint.sha),
            captureId: chain.head.id,
          };
        }
        // 2. Wait briefly for one to land (the turn boundary the executor snaps at) — only
        //    while an executor holds the worktree and the engine could not flush it first; a
        //    flushed head is already the disk as of now, and a dead lease has nobody to wait for.
        const lease = yield* repo.leaseOf(worktreeId as WorktreeId);
        const landed =
          lease !== null && lease.live && input.flushed !== true
            ? yield* channel.awaitRegister(
                worktreeId as WorktreeId,
                (row) => row.kind === "checkpoint" && row.n > (chain.head?.n ?? -1),
                CHECKPOINT_WAIT,
              )
            : null;
        if (landed !== null) {
          const manifest = yield* headManifest(landed);
          if (manifest.checkpoint !== undefined && manifest.checkpoint.ordinal === input.index) {
            return {
              ref: manifest.checkpoint.ref,
              sha: Sha.make(manifest.checkpoint.sha),
              captureId: landed.id,
            };
          }
        }
        // 3. Capture 0 alone on the chain: no executor has captured anything, so the worktree
        //    is byte for byte the base and the checkpoint is the base commit, observed at
        //    capture 0. Session create lands here (the worktree-start checkpoint is ordinal 0,
        //    the session-start one ordinal 1, and no executor has booted) — the derive path
        //    below would otherwise run a runner over an empty workspace class and fail.
        if (chain.head.n === 0 && fromHead.checkpoint !== undefined) {
          const ref = checkpointRef(worktreeId, input.index);
          const sha = Sha.make(fromHead.checkpoint.sha);
          const existing = yield* refs.get(input.projectId, ref);
          yield* refs
            .set(input.projectId, ref, sha, existing?.version ?? null)
            .pipe(
              Effect.mapError(() =>
                gitFailure(
                  project.storePath,
                  "checkpoint",
                  `${ref} moved underneath the checkpoint`,
                ),
              ),
            );
          yield* Effect.logInfo(
            "capture mode: checkpoint observed at capture 0 · the base tree, no executor capture yet",
          ).pipe(Effect.annotateLogs({ worktreeId, ordinal: input.index, sha }));
          return { ref, sha, captureId: chain.head.id };
        }
        // 4. Derive on the runner from the head capture's worktree tree — observed, never live.
        const ready = yield* prepared(input.projectId, worktreeId as WorktreeId).pipe(
          Effect.catchTag("WorktreeNotCapturedError", (error) =>
            Effect.fail(gitFailure(project.storePath, "checkpoint", error.message)),
          ),
        );
        const derived = yield* runner
          .commitTree(ready.cache, {
            tree: ready.worktreeTree,
            parent: input.parent,
            message: `mend checkpoint ${input.index} · observed at capture ${ready.head.n}`,
          })
          .pipe(
            Effect.catchTag("RunnerCacheError", (error) =>
              Effect.fail(gitFailure(project.storePath, "checkpoint", String(error.cause))),
            ),
          );
        const key = `${derivedPackPrefix(input.projectId)}${derived.packSha256}`;
        yield* blobs
          .put(key, derived.pack, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(project.storePath, "put")));
        yield* blobs
          .put(packIdxKeyOf(key), derived.idx, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(project.storePath, "put")));
        yield* repo.recordPacks([
          {
            key,
            class: "git",
            bytes: derived.pack.byteLength,
            worktreeId: worktreeId as WorktreeId,
            epoch: null,
            platform: null,
          },
        ]);
        const ref = checkpointRef(worktreeId, input.index);
        const existing = yield* refs.get(input.projectId, ref);
        yield* refs
          .set(input.projectId, ref, derived.sha, existing?.version ?? null)
          .pipe(
            Effect.mapError(() =>
              gitFailure(project.storePath, "checkpoint", `${ref} moved underneath the checkpoint`),
            ),
          );
        return { ref, sha: derived.sha, captureId: ready.head.id };
      });

    const worktreeMount: SessionRepository["Service"]["worktreeMount"] = (projectId) =>
      projects.byId(projectId).pipe(Effect.map(() => undefined));

    const prepareStandby: NonNullable<SessionRepository["Service"]["prepareStandby"]> = (
      projectId,
      alias,
      epoch,
      baseSha,
      platform,
    ) =>
      Effect.gen(function* () {
        const project = yield* projects.byId(projectId);
        const base = baseSha ?? (yield* store.resolveBase(project.storePath, null, null)).baseSha;
        const basePack = yield* uploadBasePack(projectId, project.storePath, base);
        const baseTree = yield* git(["rev-parse", "--verify", `${base}^{tree}`], project.storePath);
        const keys = captureKeys(alias, epoch);
        const emptyRoot = encodeDirObject([]);
        const emptyRootKey = keys.tree(sha256Hex(emptyRoot));
        yield* blobs
          .put(emptyRootKey, emptyRoot, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(project.storePath, "put")));
        const cache =
          platform === undefined
            ? null
            : yield* readDependencyCache(projectId, platform).pipe(
                Effect.provideService(BlobStore, blobs),
                Effect.catch(blobFailure(project.storePath, "cache")),
              );
        const manifest: CaptureManifest = {
          worktree_id: alias,
          n: 0,
          parent: null,
          epoch,
          seq: 0,
          kind: "checkpoint",
          // Fixed per standby, so the same inputs address the same manifest.
          created_at: new Date(epoch).toISOString(),
          sections: {
            git: {
              packs: [basePack.key],
              refs: {
                [`refs/heads/${project.defaultBranch}`]: base,
                [WORKTREE_TREE_REF]: baseTree,
                [INDEX_TREE_REF]: baseTree,
              },
              head: `refs/heads/${project.defaultBranch}`,
              fsck: "verified",
            },
            workspace: { root: emptyRootKey, packs: [] },
            bulk:
              cache === null
                ? "pending"
                : { root: cache.root, packs: cache.packs, platform: cache.platform },
          },
        };
        const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8"));
        const captureId = captureIdOf(bytes);
        const manifestKey = keys.manifest(captureId);
        yield* blobs
          .put(manifestKey, bytes, { ifAbsent: true })
          .pipe(Effect.catch(blobFailure(project.storePath, "put")));
        return { captureId, manifestKey, manifest, baseSha: base };
      });

    return {
      createWorktree,
      attachWorktree,
      prepareStandby,
      renameBranch,
      resetWorktree,
      removeWorktreeForce,
      checkpoint,
      worktreeMount,
    };
  }),
);

/** A stable executor id for Mend's own short-lived claims (capture 0, retention). */
export const mendExecutorId = () => `mend:${crypto.randomUUID()}`;
