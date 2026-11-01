import { ProjectId, ResourceLoadId, WorktreeId } from "@mend/domain";
import {
  ReaderTimeZone,
  ResourceLoadAnswer,
  ResourceLoadSource,
  ResourceControlled,
  ResourceEnvAnswer,
  ResourceName,
  ResourceRefusal,
  ResourceSelectionEntry,
  ResourcesPage,
  ResourceLevel,
  ResourceStarted,
  ResourceStartOptions,
  ResourceStopOptions,
  ResourceUseRequest,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

/**
 * A project's resources (ADR 0019): read them, add, start, stop and remove one, choose how a
 * worktree uses it, and read the env its processes get. A project the caller cannot see is `NotFound`; one they see but may not change this way is
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

/** A reset that did not happen: not Postgres, not running, or failed; nothing was emptied. */
export class ResourceNotReset extends Schema.TaggedError<ResourceNotReset>()(
  "ResourceNotReset",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export const ResourceRemoved = Schema.Struct({ statusLine: Schema.String });
export type ResourceRemoved = typeof ResourceRemoved.Type;

/** A load request is parsed by its raw handler so validation cannot echo a source credential. */
export const BeginResourceLoadRequest = Schema.Struct({
  name: ResourceName,
  worktreeId: Schema.NullOr(WorktreeId),
  target: Schema.NullOr(Schema.Literals(["shared", "own"])),
  source: ResourceLoadSource,
});

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
    HttpApiEndpoint.delete("remove", "/projects/:id/resources/:name", {
      params: { id: ProjectId, name: ResourceName },
      payload: Schema.Struct({ level: ResourceLevel, worktreeId: WorktreeId }),
      success: ResourceRemoved,
      error: [NotFound, ResourceDenied, ResourceStale, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.put("use", "/projects/:id/worktrees/:worktreeId/resources/:name/selection", {
      params: { id: ProjectId, worktreeId: WorktreeId, name: ResourceName },
      query: { timeZone: ReaderTimeZone },
      payload: ResourceUseRequest,
      success: ResourceSelectionEntry,
      error: [NotFound, ResourceDenied, ResourceRejected, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.post("start", "/projects/:id/resources/:name/start", {
      params: { id: ProjectId, name: ResourceName },
      query: { timeZone: ReaderTimeZone },
      payload: ResourceStartOptions,
      success: ResourceStarted,
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
    HttpApiEndpoint.post("stop", "/projects/:id/resources/:name/stop", {
      params: { id: ProjectId, name: ResourceName },
      query: { timeZone: ReaderTimeZone },
      payload: ResourceStopOptions,
      success: ResourceControlled,
      error: [NotFound, ResourceDenied, ResourceRejected, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.post("reset", "/projects/:id/worktrees/:worktreeId/resources/:name/reset", {
      params: { id: ProjectId, worktreeId: WorktreeId, name: ResourceName },
      // Which database: the worktree's own or the shared one; what the worktree uses when absent.
      query: {
        timeZone: ReaderTimeZone,
        target: Schema.optional(Schema.Literals(["shared", "own"])),
      },
      success: Schema.Struct({ statusLine: Schema.String }),
      error: [NotFound, ResourceDenied, ResourceNotReset, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("env", "/projects/:id/worktrees/:worktreeId/resources/env", {
      params: { id: ProjectId, worktreeId: WorktreeId },
      query: { timeZone: ReaderTimeZone },
      success: ResourceEnvAnswer,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("beginLoad", "/projects/:id/resource-loads", {
      params: { id: ProjectId },
      query: { timeZone: ReaderTimeZone },
      payload: BeginResourceLoadRequest,
      success: ResourceLoadAnswer,
      error: [NotFound, ResourceDenied, ResourceStale, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("readLoad", "/projects/:id/resource-loads/:loadId", {
      params: { id: ProjectId, loadId: ResourceLoadId },
      query: { timeZone: ReaderTimeZone },
      success: ResourceLoadAnswer,
      error: [NotFound, ResourceDenied, ResourceStale],
    }),
  )
  .add(
    HttpApiEndpoint.put("feedLoad", "/projects/:id/resource-loads/:loadId/body", {
      params: { id: ProjectId, loadId: ResourceLoadId },
      query: { timeZone: ReaderTimeZone },
      success: ResourceLoadAnswer,
      error: [NotFound, ResourceDenied, ResourceStale, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
