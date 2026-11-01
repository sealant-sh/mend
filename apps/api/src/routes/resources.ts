import {
  MendApi,
  BeginResourceLoadRequest,
  NotFound,
  ResourceDenied,
  ResourceManifestUnverifiable,
  ResourceRegistryUnavailable,
  ResourceNotReset,
  ResourceRejected,
  ResourceStale,
} from "@mend/api-contracts";
import type { ProjectId, WorktreeId } from "@mend/domain";
import { resourceRefusalWords } from "@mend/domain/workbench";
import {
  type ResourceImageRefusedError,
  type ResourceNameNotFoundError,
  Resources,
  ResourceLoads,
} from "@mend/sessions";
import { Effect, Schema } from "effect";
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

/** A start's or stop's refusals: whose act it is, an unknown name, or a worktree it needs. */
const controlRefused = {
  ResourceActRefusedError: (error: { readonly message: string }) => Effect.fail(denied(error)),
  ResourceNameNotFoundError: (error: ResourceNameNotFoundError) =>
    Effect.fail(new NotFound({ id: error.name })),
};

/**
 * A project's resources (ADR 0019). Every caller here is a person, whatever device their token is
 * on; the agent in a session reaches the same acts through its session's channel, as the
 * session's owner.
 */
export const ResourcesGroupLive = HttpApiBuilder.group(MendApi, "resources", (handlers) =>
  handlers
    .handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        const worktreeId = query.worktreeId ?? null;
        if (worktreeId !== null) yield* projectWorktree(project.id, worktreeId);
        return yield* (yield* Resources)
          .list(project, viewer, worktreeId, {
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
    .handle("remove", ({ params, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, payload.worktreeId);
        return yield* (yield* Resources)
          .remove(project, viewer, params.name, payload)
          .pipe(Effect.catchTags(controlRefused));
      }),
    )
    .handle("use", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, params.worktreeId);
        return yield* (yield* Resources)
          .use(project, viewer, params.worktreeId, params.name, payload.mode, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(Effect.catchTags(controlRefused));
      }),
    )
    .handle("start", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, payload.worktreeId);
        return yield* (yield* Resources)
          .start(project, viewer, params.name, payload, {
            now: new Date(),
            timeZone: query.timeZone,
          })
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
    .handle("stop", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, payload.worktreeId);
        return yield* (yield* Resources)
          .stop(project, viewer, params.name, payload, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(Effect.catchTags(controlRefused));
      }),
    )
    .handle("reset", ({ params, query }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, params.worktreeId);
        return yield* (yield* Resources)
          .reset(project, viewer, params.name, params.worktreeId, query.target ?? null, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(
            Effect.catchTags({
              ResourceActRefusedError: (error) => Effect.fail(denied(error)),
              ResourceNameNotFoundError: (error) => Effect.fail(new NotFound({ id: error.name })),
              ResourceNotResetError: (error) =>
                Effect.fail(new ResourceNotReset({ message: error.message })),
            }),
          );
      }),
    )
    .handleRaw("beginLoad", ({ params, query, request }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        const input = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(BeginResourceLoadRequest)),
          Effect.mapError(
            () =>
              new ResourceStale({
                message: "a load needs a resource, target and dump file or Postgres URL",
              }),
          ),
        );
        if (input.worktreeId !== null) yield* projectWorktree(project.id, input.worktreeId);
        return yield* (yield* ResourceLoads)
          .begin(project, viewer, input, { now: new Date(), timeZone: query.timeZone })
          .pipe(Effect.mapError((error) => new ResourceStale({ message: error.message })));
      }),
    )
    .handle("readLoad", ({ params, query }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* ResourceLoads)
          .read(project, viewer, params.loadId, { now: new Date(), timeZone: query.timeZone })
          .pipe(Effect.mapError((error) => new ResourceStale({ message: error.message })));
      }),
    )
    .handleRaw("feedLoad", ({ params, query, request }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        return yield* (yield* ResourceLoads)
          .feed(project, viewer, params.loadId, request.stream, {
            now: new Date(),
            timeZone: query.timeZone,
          })
          .pipe(Effect.mapError((error) => new ResourceStale({ message: error.message })));
      }),
    )
    .handle("env", ({ params, query }) =>
      Effect.gen(function* () {
        const { project, viewer } = yield* visible(params.id);
        yield* projectWorktree(project.id, params.worktreeId);
        return yield* (yield* Resources)
          .env(project, viewer, params.worktreeId, { now: new Date(), timeZone: query.timeZone })
          .pipe(
            Effect.catchTag("ResourceActRefusedError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
      }),
    ),
);
