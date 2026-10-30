import {
  MendApi,
  NotFound,
  ResourceDenied,
  ResourceRejected,
  ResourceStale,
} from "@mend/api-contracts";
import type { ProjectId } from "@mend/domain";
import { Resources } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";

/** The project and the viewer it is visible to; `NotFound` for a project the caller cannot see. */
const visible = Effect.fn("resources.visible")(function* (id: ProjectId) {
  const access = yield* ProjectAccess;
  const project = yield* access.project(id);
  const viewer = yield* access.viewer();
  if (viewer === null) return yield* new NotFound({ id });
  return { project, viewer };
});

const denied = (error: { readonly message: string }) =>
  new ResourceDenied({ message: error.message });

/**
 * A project's resources (ADR 0019). Every caller here is a person, whatever device their token is
 * on: a workspace reaches resources through its session's socket or channel, which only reads.
 */
export const ResourcesGroupLive = HttpApiBuilder.group(MendApi, "resources", (handlers) =>
  handlers
    .handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        const worktreeId = query.worktreeId ?? null;
        if (worktreeId !== null) {
          const worktree = yield* (yield* ProjectAccess).worktree(worktreeId);
          if (worktree.projectId !== project.id) return yield* new NotFound({ id: worktreeId });
        }
        return yield* (yield* Resources)
          .list(project, { kind: "person", viewer }, worktreeId, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(
            // A person refused a read cannot see the project.
            Effect.catchTag("ResourceActRefusedError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
      }),
    )
    .handle("propose", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* Resources)
          .propose(project, viewer, payload, { now: new Date(), timeZone: query.timeZone })
          .pipe(
            Effect.catchTags({
              ResourceActRefusedError: (error) => Effect.fail(denied(error)),
              ResourceDefinitionRefusedError: (error) =>
                Effect.fail(
                  new ResourceRejected({
                    name: error.name,
                    refusals: error.refusals,
                    message: error.refusals
                      .map((refusal) => `@${error.name} · ${refusal.key} ${refusal.message}`)
                      .join("\n"),
                  }),
                ),
            }),
          );
      }),
    )
    .handle("withdraw", ({ params }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* Resources).withdraw(project, viewer, params.proposalId).pipe(
          Effect.catchTags({
            ResourceActRefusedError: (error) => Effect.fail(denied(error)),
            ResourceProposalNotFoundError: () =>
              Effect.fail(new NotFound({ id: params.proposalId })),
          }),
        );
      }),
    )
    .handle("remove", ({ params, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* Resources)
          .remove(project, viewer, { id: params.definitionId, digest: payload.expectedDigest })
          .pipe(
            Effect.catchTags({
              ResourceActRefusedError: (error) => Effect.fail(denied(error)),
              ResourceDefinitionNotFoundError: () =>
                Effect.fail(new NotFound({ id: params.definitionId })),
              ResourceDefinitionStaleError: () =>
                Effect.fail(
                  new ResourceStale({
                    message: "the definition changed since you read it · nothing was removed",
                  }),
                ),
            }),
          );
      }),
    ),
);
