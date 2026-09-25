import { CaptureStoreRepo, CheckpointsRepo, StoreRefsRepo } from "@mend/db";
import { derivedPackPrefix, ensureCaptureCache, SessionEngine } from "@mend/sessions";
import { BlobStore, GitOpsRunner, landedRefOf, packIdxKeyOf, type RunnerCache } from "@mend/store";
import { Effect, Layer } from "effect";

import { branchWords, gitWords } from "./git-words.ts";
import { LandingGit, LandingStepError, type LandingPlace } from "./landing.ts";

/**
 * `LandingGit` for a capture-backed session (ADR 0002, the default store kind): the worktree has
 * no directory beside Mend, so steps 1 to 3 run in the runner cache that already serves the
 * change's review diff (docs/adr/0007-landing.md, "Where each step runs"). The push goes from
 * that cache to the project's origin URL. Nothing runs in an executor.
 *
 * Mend's commit never reaches the executor's branch: the cache's refs are rewritten from the
 * capture on every `ensure`. So a landing's commit is packed under the project's derived prefix,
 * like a derived checkpoint, and the landed head is kept under `refs/mend/landed/<worktree>` in
 * `store_refs`, which every later `ensure` brings back. The next landing parents on it and the
 * agent's head by the store's `planLanding`, so it fast-forwards from what origin holds even
 * after the agent committed. A bundle's commit is neither uploaded nor kept.
 */

export { landedRefOf };

const stepError = (step: LandingStepError["step"], message: string) =>
  new LandingStepError({ step, message });

export const LandingGitCapturedLive: Layer.Layer<
  LandingGit,
  never,
  SessionEngine | CaptureStoreRepo | BlobStore | GitOpsRunner | StoreRefsRepo | CheckpointsRepo
> = Layer.effect(
  LandingGit,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;
    const checkpoints = yield* CheckpointsRepo;

    /** The cache over the worktree's chain head, with Mend's derived packs installed. */
    const cacheOf = (place: LandingPlace, step: LandingStepError["step"]) =>
      ensureCaptureCache(place.project.id, place.worktree.id).pipe(
        Effect.provideService(CaptureStoreRepo, repo),
        Effect.provideService(BlobStore, blobs),
        Effect.provideService(GitOpsRunner, runner),
        Effect.provideService(StoreRefsRepo, refs),
        Effect.map((ready) => ready.cache),
        Effect.mapError((error) =>
          stepError(step, error._tag === "GitError" ? gitWords(error, null) : error.message),
        ),
      );

    /** H: the agent's branch head as the chain head's capture holds it. */
    const agentHeadOf = (cache: RunnerCache, place: LandingPlace) =>
      runner.resolve(cache, `refs/heads/${place.worktree.branch}`).pipe(
        Effect.catch(() => runner.headSha(cache)),
        Effect.mapError((error) => stepError("checkpoint", gitWords(error, null))),
      );

    const originOf = (place: LandingPlace, step: LandingStepError["step"]) =>
      place.project.originUrl === null
        ? Effect.fail(stepError(step, "the project has no origin"))
        : Effect.succeed(place.project.originUrl);

    return {
      checkpoint: (scope, trigger) =>
        Effect.gen(function* () {
          const checkpoint = yield* engine
            .checkpointNow(scope.session.id, trigger)
            .pipe(
              Effect.mapError((error) =>
                stepError(
                  "checkpoint",
                  error._tag === "GitError" ? gitWords(error, null) : `${error._tag} · checkpoint`,
                ),
              ),
            );
          const cache = yield* cacheOf(scope, "checkpoint");
          return { checkpoint, agentHead: yield* agentHeadOf(cache, scope) };
        }),
      latest: (scope) =>
        Effect.gen(function* () {
          const checkpoint = yield* checkpoints.latestForWorktree(scope.worktree.id);
          const cache = yield* cacheOf(scope, "checkpoint");
          return { checkpoint, agentHead: yield* agentHeadOf(cache, scope) };
        }),
      commit: (scope, input) =>
        Effect.gen(function* () {
          const cache = yield* cacheOf(scope, "commit");
          const landed = yield* runner
            .landingCommit(cache, {
              agentHead: input.agentHead,
              lastLanded: input.lastLanded,
              checkpoint: input.checkpoint.sha,
              author: input.author,
              message: input.message,
            })
            .pipe(
              Effect.mapError((error) =>
                stepError(
                  "commit",
                  error._tag === "GitError" ? gitWords(error, null) : String(error.cause),
                ),
              ),
            );
          const result = {
            head: landed.head,
            commitSha: landed.written?.sha ?? null,
            nothingNew: landed.nothingNew,
          };
          // A bundle's commit stays in this cache for the bundle and nowhere else.
          if (!input.keep) return result;
          if (landed.written !== null) {
            const { derived } = landed.written;
            const key = `${derivedPackPrefix(scope.project.id)}${derived.packSha256}`;
            const bucket = (error: { readonly _tag: string }) =>
              stepError("commit", `bucket: ${error._tag}`);
            yield* blobs.put(key, derived.pack, { ifAbsent: true }).pipe(Effect.mapError(bucket));
            yield* blobs
              .put(packIdxKeyOf(key), derived.idx, { ifAbsent: true })
              .pipe(Effect.mapError(bucket));
            yield* repo.recordPacks([
              {
                key,
                class: "git",
                bytes: derived.pack.byteLength,
                worktreeId: scope.worktree.id,
                epoch: null,
                platform: null,
              },
            ]);
          }
          const name = landedRefOf(scope.worktree.id);
          const existing = yield* refs.get(scope.project.id, name);
          if (existing?.sha !== landed.head) {
            yield* refs
              .set(scope.project.id, name, landed.head, existing?.version ?? null)
              .pipe(
                Effect.mapError(() =>
                  stepError("commit", `${name} moved while landing · another landing ran at once`),
                ),
              );
          }
          return result;
        }),
      push: (scope, input) =>
        Effect.gen(function* () {
          const remote = yield* originOf(scope, "push");
          const cache = yield* cacheOf(scope, "push");
          return yield* runner
            .push(cache, {
              remote,
              sha: input.sha,
              remoteBranch: input.remoteBranch,
              remoteEnv: { ...input.remoteEnv },
            })
            .pipe(
              Effect.catchTags({
                GitError: (error) =>
                  Effect.fail(stepError("push", gitWords(error, scope.project.gitAuthMode))),
                InvalidBranchError: (error) => Effect.fail(stepError("push", branchWords(error))),
              }),
            );
        }),
      changedFiles: (scope, input) =>
        Effect.gen(function* () {
          const cache = yield* cacheOf(scope, "files");
          return yield* runner
            .diffFileFacts(cache, input.base, input.head)
            .pipe(Effect.mapError((error) => stepError("files", gitWords(error, null))));
        }),
      probe: (place, input) =>
        Effect.gen(function* () {
          const remote = yield* originOf(place, "probe");
          const cache = yield* cacheOf(place, "probe");
          return yield* runner
            .probeRemote(cache, {
              remote,
              sha: input.sha,
              remoteBranch: input.remoteBranch,
              remoteEnv: { ...input.remoteEnv },
            })
            .pipe(
              Effect.mapError((error) =>
                stepError(
                  "probe",
                  error._tag === "GitError"
                    ? gitWords(error, place.project.gitAuthMode)
                    : branchWords(error),
                ),
              ),
            );
        }),
      bundle: (scope, input) =>
        Effect.gen(function* () {
          const cache = yield* cacheOf(scope, "bundle");
          return yield* runner.bundle(cache, input).pipe(
            Effect.catchTags({
              GitError: (error) => Effect.fail(stepError("bundle", gitWords(error, null))),
              InvalidBranchError: (error) => Effect.fail(stepError("bundle", branchWords(error))),
            }),
          );
        }),
    };
  }),
);
