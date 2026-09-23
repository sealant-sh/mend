import { SessionEngine } from "@mend/sessions";
import { Store, worktreePathOf } from "@mend/store";
import { Effect, Layer } from "effect";

import { branchWords, gitWords } from "./git-words.ts";
import { LandingGit, LandingStepError, type LandingPlace } from "./landing.ts";

/**
 * `LandingGit` for a co-located session: the worktree is a linked worktree of the project's bare
 * store on this machine, so every step runs against the store with `Store`
 * (docs/adr/0007-landing.md, "Where each step runs"). Mend's commit is written in the bare store
 * and kept under `refs/mend/landed/<worktree>`; `mend/<name>` never moves, so the worktree's
 * files, index and HEAD are never touched and the agent's next commit reverts nothing. A
 * capture-backed session (ADR 0002) uses the runner cache instead (`LandingGitCapturedLive`).
 */

const worktreeDir = (scope: LandingPlace) =>
  worktreePathOf(scope.project.storePath, scope.worktree.directory);

export const LandingGitColocatedLive: Layer.Layer<LandingGit, never, Store | SessionEngine> =
  Layer.effect(
    LandingGit,
    Effect.gen(function* () {
      const store = yield* Store;
      const engine = yield* SessionEngine;

      return {
        checkpoint: (scope, trigger) =>
          Effect.gen(function* () {
            // Read before the snapshot, so everything H holds is in the checkpoint's tree: a
            // commit the agent makes in between is in the tree and joins at the next landing.
            const agentHead = yield* store.headSha(worktreeDir(scope));
            const checkpoint = yield* engine.checkpointNow(scope.session.id, trigger);
            return { checkpoint, agentHead };
          }).pipe(
            Effect.mapError(
              (error) =>
                new LandingStepError({
                  step: "checkpoint",
                  message:
                    error._tag === "GitError"
                      ? gitWords(error, null)
                      : `${error._tag} · checkpoint`,
                }),
            ),
          ),
        commit: (scope, input) =>
          store
            .landingCommit(scope.project.storePath, {
              agentHead: input.agentHead,
              lastLanded: input.lastLanded,
              checkpoint: input.checkpoint.sha,
              author: input.author,
              message: input.message,
              keepFor: scope.worktree.id,
            })
            .pipe(
              Effect.map((landed) => ({
                head: landed.head,
                commitSha: landed.written?.sha ?? null,
                nothingNew: landed.nothingNew,
              })),
              Effect.mapError(
                (error) => new LandingStepError({ step: "commit", message: gitWords(error, null) }),
              ),
            ),
        push: (scope, input) =>
          store
            .push(scope.project.storePath, {
              remote: "origin",
              sha: input.sha,
              remoteBranch: input.remoteBranch,
              remoteEnv: { ...input.remoteEnv },
            })
            .pipe(
              Effect.catchTags({
                GitError: (error) =>
                  Effect.fail(
                    new LandingStepError({
                      step: "push",
                      message: gitWords(error, scope.project.gitAuthMode),
                    }),
                  ),
                InvalidBranchError: (error) =>
                  Effect.fail(new LandingStepError({ step: "push", message: branchWords(error) })),
              }),
            ),
        changedFiles: (scope, input) =>
          store
            .diffFileFacts(scope.project.storePath, input.base, input.head)
            .pipe(
              Effect.mapError(
                (error) => new LandingStepError({ step: "files", message: gitWords(error, null) }),
              ),
            ),
        probe: (place, input) =>
          store
            .probeRemote(place.project.storePath, {
              remote: "origin",
              sha: input.sha,
              remoteBranch: input.remoteBranch,
              remoteEnv: { ...input.remoteEnv },
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new LandingStepError({
                    step: "probe",
                    message:
                      error._tag === "GitError"
                        ? gitWords(error, place.project.gitAuthMode)
                        : branchWords(error),
                  }),
              ),
            ),
        bundle: (scope, input) =>
          store.bundle(scope.project.storePath, input).pipe(
            Effect.catchTags({
              GitError: (error) =>
                Effect.fail(
                  new LandingStepError({ step: "bundle", message: gitWords(error, null) }),
                ),
              InvalidBranchError: (error) =>
                Effect.fail(new LandingStepError({ step: "bundle", message: branchWords(error) })),
            }),
          ),
      };
    }),
  );
