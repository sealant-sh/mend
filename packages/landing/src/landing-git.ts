import type { GitAuthMode } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import {
  describeGitRemoteFailure,
  type GitError,
  type InvalidBranchError,
  Store,
  worktreePathOf,
} from "@mend/store";
import { Effect, Layer } from "effect";

import { LandingGit, LandingStepError, type LandingScope } from "./landing.ts";

/**
 * `LandingGit` for a co-located session: the worktree is a linked worktree of the project's bare
 * store on this machine, so every step runs against the store with `Store`
 * (docs/adr/0007-landing.md, "Where each step runs"). Mend's commit is written in the bare store
 * and kept under `refs/mend/landed/<worktree>`; `mend/<name>` never moves, so the worktree's
 * files, index and HEAD are never touched and the agent's next commit reverts nothing. A
 * capture-backed session (ADR 0002) needs the runner cache instead.
 */

/** A git failure in the remote's words when a known shape matched, verbatim otherwise. */
const gitWords = (error: GitError, mode: GitAuthMode | null): string => {
  const described = mode === null ? null : describeGitRemoteFailure(error.stderr, mode);
  if (described !== null) return described;
  if (error.stderr.trim() !== "") return error.stderr.trim();
  return `git ${error.args[0] ?? ""} exited ${error.exitCode ?? "without a code"}`;
};

const branchWords = (error: InvalidBranchError): string =>
  `${error.branch} is not a branch name git accepts`;

const worktreeDir = (scope: LandingScope) =>
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
      };
    }),
  );
