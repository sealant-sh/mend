import type { GitAuthMode } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import {
  describeGitRemoteFailure,
  type GitError,
  type InvalidBranchError,
  type LandingBranchMovedError,
  Store,
  worktreePathOf,
} from "@mend/store";
import { Effect, Layer } from "effect";

import { LandingGit, LandingStepError, type LandingScope } from "./landing.ts";

/**
 * `LandingGit` for a co-located session: the worktree is a linked worktree of the project's bare
 * store on this machine, so every step runs against the store with `Store`
 * (docs/adr/0007-landing.md, "Where each step runs"). Mend's commit moves `mend/<name>` by
 * compare-and-swap in the bare store, so the worktree's files, index and HEAD file are never
 * touched. A capture-backed session (ADR 0002) needs the runner cache instead.
 */

const shortSha = (sha: string | null) => (sha === null ? "none" : sha.slice(0, 7));

/** A git failure in the remote's words when a known shape matched, verbatim otherwise. */
const gitWords = (error: GitError, mode: GitAuthMode | null): string => {
  const described = mode === null ? null : describeGitRemoteFailure(error.stderr, mode);
  if (described !== null) return described;
  if (error.stderr.trim() !== "") return error.stderr.trim();
  return `git ${error.args[0] ?? ""} exited ${error.exitCode ?? "without a code"}`;
};

const branchWords = (error: InvalidBranchError | LandingBranchMovedError): string =>
  error._tag === "InvalidBranchError"
    ? `${error.branch} is not a branch name git accepts`
    : `${error.branch} moved while landing · expected ${shortSha(error.expected)} · found ${shortSha(error.actual)}`;

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
            // Read before the snapshot: a commit the agent makes in between moves the branch
            // past this head, and step 2's compare-and-swap then writes nothing.
            const branchHead = yield* store.headSha(worktreeDir(scope));
            const checkpoint = yield* engine.checkpointNow(scope.session.id, trigger);
            return { checkpoint, branchHead };
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
              branch: scope.worktree.branch,
              checkpoint: input.checkpoint.sha,
              author: input.author,
              message: input.message,
              expectedHead: input.branchHead,
            })
            .pipe(
              Effect.map((landed) => ({
                head: landed.head,
                commitSha: landed.written?.sha ?? null,
              })),
              Effect.mapError(
                (error) =>
                  new LandingStepError({
                    step: "commit",
                    message: error._tag === "GitError" ? gitWords(error, null) : branchWords(error),
                  }),
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
