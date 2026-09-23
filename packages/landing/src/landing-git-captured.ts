import { CaptureStoreRepo, ChangeLandingsRepo, StoreRefsRepo, WorktreeChangesRepo } from "@mend/db";
import type { Sha } from "@mend/domain";
import { derivedPackPrefix, ensureCaptureCache, SessionEngine } from "@mend/sessions";
import { BlobStore, gitOutput, GitOpsRunner, packIdxKeyOf, type RunnerCache } from "@mend/store";
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
 * capture on every `ensure`. So the commit is packed under the project's derived prefix, like a
 * derived checkpoint, and its sha is kept under `refs/mend/landed/<worktree>` in `store_refs`.
 * Which commit the next landing builds on is `landingParent`'s rule.
 */

/** The `store_refs` name that keeps a worktree's latest landing commit. */
export const landedRefOf = (worktreeId: string) => `refs/mend/landed/${worktreeId}`;

/**
 * What a capture-backed landing's commit is parented on. The agent's branch never receives
 * Mend's commit, so after a landing it still stands behind what origin holds. While the agent
 * has not committed since (its head is an ancestor of the last landed commit), the next commit
 * goes on the landed one, and the push fast-forwards. Once the agent has committed past it, its
 * head is the parent, and its commits are pushed as they are; origin then refuses the push as
 * diverged if the landed commit is not in the agent's history, and the refusal says so.
 */
export const landingParent = (input: {
  readonly agentHead: Sha;
  readonly lastLanded: Sha | null;
  readonly agentHeadInLanded: boolean;
}): Sha =>
  input.lastLanded !== null && input.agentHeadInLanded ? input.lastLanded : input.agentHead;

const stepError = (step: LandingStepError["step"], message: string) =>
  new LandingStepError({ step, message });

/** `ancestor` is in `descendant`'s history; false when git cannot say (a missing object). */
const isAncestor = (cache: RunnerCache, ancestor: Sha, descendant: Sha) =>
  gitOutput(["merge-base", "--is-ancestor", ancestor, descendant], cache.path).pipe(
    Effect.map((out) => out.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );

export const LandingGitCapturedLive: Layer.Layer<
  LandingGit,
  never,
  | SessionEngine
  | CaptureStoreRepo
  | BlobStore
  | GitOpsRunner
  | StoreRefsRepo
  | ChangeLandingsRepo
  | WorktreeChangesRepo
> = Layer.effect(
  LandingGit,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;
    const landings = yield* ChangeLandingsRepo;
    const changes = yield* WorktreeChangesRepo;

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
          const agentHead = yield* runner
            .resolve(cache, `refs/heads/${scope.worktree.branch}`)
            .pipe(
              Effect.catch(() => runner.headSha(cache)),
              Effect.mapError((error) => stepError("checkpoint", gitWords(error, null))),
            );
          const change = yield* changes.byWorktree(scope.worktree.id);
          const history = change === null ? [] : yield* landings.listForChange(change.id);
          const lastLanded = history.find((landing) => landing.pushedSha !== null)?.pushedSha;
          const branchHead = landingParent({
            agentHead,
            lastLanded: lastLanded ?? null,
            agentHeadInLanded:
              lastLanded === undefined || lastLanded === null
                ? false
                : yield* isAncestor(cache, agentHead, lastLanded),
          });
          return { checkpoint, branchHead };
        }),
      commit: (scope, input) =>
        Effect.gen(function* () {
          const cache = yield* cacheOf(scope, "commit");
          const landed = yield* runner
            .landingCommit(cache, {
              parent: input.branchHead,
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
          if (landed.written === null) return { head: landed.head, commitSha: null };
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
          const name = landedRefOf(scope.worktree.id);
          const existing = yield* refs.get(scope.project.id, name);
          yield* refs
            .set(scope.project.id, name, derived.sha, existing?.version ?? null)
            .pipe(
              Effect.mapError(() =>
                stepError("commit", `${name} moved while landing · another landing ran at once`),
              ),
            );
          return { head: landed.head, commitSha: derived.sha };
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
