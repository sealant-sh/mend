import {
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  GitCommandError,
  WS_METHODS,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { GatedMend } from "./device-gate.ts";
import type { PersonHub } from "./hub.ts";
import type { MendProject } from "./mend-workbench.ts";
import { worktreePathOf } from "./shell.ts";
import type { BearerSession } from "./state.ts";

/** Resolve a durable checkout, including one that has never held a conversation. */
export const findWorktreeForLaunch = (
  mend: Pick<GatedMend, "listWorktrees">,
  token: string,
  project: MendProject,
  path: string,
) =>
  mend
    .listWorktrees(token, project.id)
    .pipe(
      Effect.map(
        (worktrees) =>
          worktrees.find(
            (worktree) => worktreePathOf(project, { worktree: worktree.directory }) === path,
          ) ?? null,
      ),
    );

/** Standalone creation uses Mend's managed directory and named-branch provisioning policy. */
export const createStandaloneWorktree = (
  input: { readonly hub: PersonHub; readonly mend: GatedMend; readonly session: BearerSession },
  request: VcsCreateWorktreeInput,
): Effect.Effect<VcsCreateWorktreeResult, GitCommandError | EnvironmentAuthorizationError> => {
  const failed = (detail: string) =>
    new GitCommandError({
      operation: WS_METHODS.vcsCreateWorktree,
      command: "git worktree add",
      cwd: request.cwd,
      detail,
    });
  const failure = (error: { readonly _tag: string; readonly message: string }) =>
    error._tag === "MendDeviceRefused"
      ? new EnvironmentAuthorizationError({
          message: "Mend no longer accepts this device. Pair again from Mend.",
          requiredScope: AuthSourceControlWriteScope,
        })
      : failed(error.message);
  return Effect.gen(function* () {
    if (request.path !== null)
      return yield* failed("New worktrees use Mend's managed directory. The path must be null.");
    const location = yield* input.hub.locationOf(request.cwd).pipe(Effect.mapError(failure));
    if (location === null) return yield* failed("No project of yours is at this cwd.");
    const { project } = yield* input.mend
      .projectDetail(input.session.deviceToken, location.projectId)
      .pipe(Effect.mapError(failure));
    const created = yield* input.mend
      .createWorktree(input.session.deviceToken, project.id, {
        name: null,
        base: null,
        targetBranch: {
          refName: request.refName,
          ...(request.newRefName === undefined ? {} : { newRefName: request.newRefName }),
        },
      })
      .pipe(Effect.mapError(failure));
    return {
      worktree: {
        path: worktreePathOf(project, { worktree: created.directory }),
        refName: created.branch,
      },
    };
  });
};
