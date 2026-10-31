import { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  ReaderTimeZone,
  ResourceAddInput,
  ResourceAdded,
  ResourceName,
  ResourceRefusal,
  ResourceSelectionEntry,
  ResourcesPage,
  ResourceSpecDigest,
  ResourceUseRequest,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

/**
 * A project's resources (ADR 0019): read them, add one, remove one and choose how a worktree uses
 * it. A project the caller cannot see is `NotFound`; one they see but may not change this way is
 * `ResourceDenied`, with the words that say whose act it is.
 */

export class ResourceDenied extends Schema.TaggedError<ResourceDenied>()(
  "ResourceDenied",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Each field the definition rules refuse, keyed (`ports`, `volumes.data`), and one line each. */
export class ResourceRejected extends Schema.TaggedError<ResourceRejected>()(
  "ResourceRejected",
  { name: Schema.String, refusals: Schema.Array(ResourceRefusal), message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The definition changed after the caller read it; nothing was written. */
export class ResourceStale extends Schema.TaggedError<ResourceStale>()(
  "ResourceStale",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The image's registry did not answer in time; nothing was added, so adding again may. */
export class ResourceRegistryUnavailable extends Schema.TaggedError<ResourceRegistryUnavailable>()(
  "ResourceRegistryUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** The registry's manifest could not be verified against its bytes; nothing was added. */
export class ResourceManifestUnverifiable extends Schema.TaggedError<ResourceManifestUnverifiable>()(
  "ResourceManifestUnverifiable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** A start, refused in the words `resourceRuntimeRefusal` says; nothing was started. */
export class ResourceRuntimeUnavailable extends Schema.TaggedError<ResourceRuntimeUnavailable>()(
  "ResourceRuntimeUnavailable",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export const ResourceRemoved = Schema.Struct({ statusLine: Schema.String });
export type ResourceRemoved = typeof ResourceRemoved.Type;

export const resourcesGroup = HttpApiGroup.make("resources")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/resources", {
      params: { id: ProjectId },
      query: { timeZone: ReaderTimeZone, worktreeId: Schema.optional(WorktreeId) },
      success: ResourcesPage,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/resources", {
      params: { id: ProjectId },
      // The worktree the add came from: a worktree resource starts there at once.
      query: { timeZone: ReaderTimeZone, worktreeId: Schema.optional(WorktreeId) },
      payload: ResourceAddInput,
      success: ResourceAdded,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [
        NotFound,
        ResourceDenied,
        ResourceRejected,
        ResourceRegistryUnavailable,
        ResourceManifestUnverifiable,
        RemovalInProgress,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/resources/:definitionId", {
      params: { id: ProjectId, definitionId: ResourceDefinitionId },
      payload: Schema.Struct({ expectedDigest: ResourceSpecDigest }),
      success: ResourceRemoved,
      error: [NotFound, ResourceDenied, ResourceStale, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.put(
      "use",
      "/projects/:id/worktrees/:worktreeId/resources/:definitionId/selection",
      {
        params: { id: ProjectId, worktreeId: WorktreeId, definitionId: ResourceDefinitionId },
        query: { timeZone: ReaderTimeZone },
        payload: ResourceUseRequest,
        success: ResourceSelectionEntry,
        error: [NotFound, ResourceDenied, ResourceRejected, RemovalInProgress],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("start", "/projects/:id/resources/:name/start", {
      params: { id: ProjectId, name: ResourceName },
      error: [NotFound, ResourceRuntimeUnavailable, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
