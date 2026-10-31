import {
  MendApi,
  NotFound,
  ResourceDenied,
  ResourceManifestUnverifiable,
  ResourceRegistryUnavailable,
  ResourceRejected,
  ResourceRuntimeUnavailable,
  ResourceStale,
} from "@mend/api-contracts";
import type { ProjectId, WorktreeId } from "@mend/domain";
import { resourceRefusalWords, resourceRuntimeRefusal } from "@mend/domain/workbench";
import { type ResourceImageRefusedError, Resources } from "@mend/sessions";
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

const rejected = (name: string, refusals: ReadonlyArray<{ key: string; message: string }>) =>
  new ResourceRejected({
    name,
    refusals,
    message: refusals.map((refusal) => `@${name} · ${resourceRefusalWords(refusal)}`).join("\n"),
  });

/** `NotFound` for a worktree that is not one of the project's. */
const projectWorktree = Effect.fn("resources.projectWorktree")(function* (
  projectId: ProjectId,
  worktreeId: WorktreeId,
) {
  const worktree = yield* (yield* ProjectAccess).worktree(worktreeId);
  if (worktree.projectId !== projectId) return yield* new NotFound({ id: worktreeId });
});

/** A registry that could not say the image's digest: unreachable is 503, unverifiable 502. */
const imageRefused = ({ name, refusal, reason, message }: ResourceImageRefusedError) =>
  reason === "unavailable"
    ? new ResourceRegistryUnavailable({ message })
    : reason === "unverifiable"
      ? new ResourceManifestUnverifiable({ message })
      : rejected(name, [refusal]);

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
        if (worktreeId !== null) yield* projectWorktree(project.id, worktreeId);
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
    .handle("add", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* Resources)
          .add(project, viewer, payload, { now: new Date(), timeZone: query.timeZone })
          .pipe(
            Effect.catchTags({
              ResourceActRefusedError: (error) => Effect.fail(denied(error)),
              ResourceDefinitionRefusedError: (error) =>
                Effect.fail(rejected(error.name, error.refusals)),
              ResourceImageRefusedError: (error) => Effect.fail(imageRefused(error)),
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
    )
    .handle("use", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, params.worktreeId);
        return yield* (yield* Resources)
          .use(project, viewer, params.worktreeId, params.definitionId, payload.mode, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(
            Effect.catchTags({
              ResourceActRefusedError: (error) => Effect.fail(denied(error)),
              ResourceDefinitionNotFoundError: () =>
                Effect.fail(new NotFound({ id: params.definitionId })),
              ResourceSelectionRefusedError: ({ name, refusal }) =>
                Effect.fail(rejected(name, [refusal])),
            }),
          );
      }),
    )
    // No runtime runs resources yet, so every start of one, by anyone who sees the project, is
    // refused before anything is created.
    .handle("start", ({ params }) =>
      Effect.gen(function* () {
        yield* visible(params.id);
        return yield* new ResourceRuntimeUnavailable({
          message: resourceRuntimeRefusal(params.name),
        });
      }),
    ),
);
