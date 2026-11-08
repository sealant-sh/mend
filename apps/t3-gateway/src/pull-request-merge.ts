import {
  type PullRequestActionInput,
  type PullRequestRef,
  PullRequestOperationError,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
  type PullRequestMergeCapabilities,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { GatedMend } from "./device-gate.ts";
import type { PersonHub } from "./hub.ts";
import type { BearerSession } from "./state.ts";

/** The detail panel's merge-specific capabilities, independent of other PR handlers. */
export interface PullRequestMergeAccess {
  readonly capabilities: Pick<PullRequestCapabilities, "actions" | "mergeMethods">;
  readonly viewerPermissions: Pick<PullRequestViewerPermissions, "actions">;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
}

const failure = (operation: string, detail: string) =>
  new PullRequestOperationError({ operation, detail });

/** Explicit remote merging on the paired person's own GitHub account. Never called by landing. */
export const makePullRequestMergeHandlers = ({
  hub,
  mend,
  session,
}: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  const requireProject = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      if (hub.isRefused(session.deviceToken))
        return yield* failure("merge", "Mend no longer accepts this device. Pair again from Mend.");
      if (ref.host !== undefined && ref.host.toLowerCase() !== "github.com")
        return yield* failure("merge", "This Mend adapter supports github.com pull requests.");
      const shell = yield* hub.shellSnapshot;
      if (!shell.projects.some((project) => project.id === ref.projectId))
        return yield* failure("merge", "This project is not visible in this environment.");
    });
  const wrapped = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, PullRequestOperationError> =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof PullRequestOperationError
          ? error
          : failure(
              operation,
              error !== null &&
                typeof error === "object" &&
                "detail" in error &&
                typeof error.detail === "string"
                ? error.detail
                : "Mend could not complete this operation using your GitHub account.",
            ),
      ),
    );
  const mergeAccess = (
    ref: PullRequestRef,
  ): Effect.Effect<PullRequestMergeAccess, PullRequestOperationError> =>
    wrapped(
      "mergeAccess",
      Effect.gen(function* () {
        yield* requireProject(ref);
        const access = yield* mend.pullRequestMergeAccess(
          session.deviceToken,
          ref.projectId,
          ref.repository,
          ref.number,
        );
        if (
          ref.expectedAccountId !== undefined &&
          ref.expectedAccountId.toLowerCase() !== access.viewer.toLowerCase()
        )
          return yield* failure(
            "mergeAccess",
            "Your GitHub account changed. Open the pull request again.",
          );
        return {
          capabilities: { actions: ["merge"], mergeMethods: access.mergeMethods },
          viewerPermissions: { actions: access.canMerge ? ["merge"] : [] },
          mergeCapabilities: {
            merge: access.mergeMethods.includes("merge"),
            squash: access.mergeMethods.includes("squash"),
            rebase: access.mergeMethods.includes("rebase"),
          },
        };
      }),
    );
  const runAction = (
    input: PullRequestActionInput,
  ): Effect.Effect<void, PullRequestOperationError> =>
    wrapped(
      "runAction",
      Effect.gen(function* () {
        yield* requireProject(input);
        if (
          input.action !== "merge" ||
          input.stackNumber !== undefined ||
          input.expectedStackHeads !== undefined ||
          input.updateMethod !== undefined
        )
          return yield* failure(
            "runAction",
            "This Mend adapter offers an explicit merge of one pull request. This action is not supported.",
          );
        const { settings } = yield* hub.settings(session);
        const removeAgentCredits =
          settings.projectSettingsOverrides[input.projectId]?.removeAgentCreditsOnMerge ??
          settings.removeAgentCreditsOnMerge;
        yield* mend.mergePullRequest(session.deviceToken, input.projectId, input.number, {
          repository: input.repository,
          method: input.mergeMethod ?? "merge",
          ...(input.expectedAccountId === undefined
            ? {}
            : { expectedAccountId: input.expectedAccountId }),
          removeAgentCredits,
        });
      }),
    );
  return { mergeAccess, runAction };
};
