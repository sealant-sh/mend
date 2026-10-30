import { ProjectId, ResourceDefinitionId, ResourceProposalId, WorktreeId } from "@mend/domain";
import {
  ReaderTimeZone,
  ResourceProposalEntry,
  ResourceProposalInput,
  ResourceRefusal,
  ResourcesPage,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * A project's resources (ADR 0019): read them, propose one, remove a proposal or a definition. A
 * project the caller cannot see is `NotFound`; one they see but may not change this way is
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
    HttpApiEndpoint.post("propose", "/projects/:id/resource-proposals", {
      params: { id: ProjectId },
      query: { timeZone: ReaderTimeZone },
      payload: ResourceProposalInput,
      success: ResourceProposalEntry,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [NotFound, ResourceDenied, ResourceRejected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("withdraw", "/projects/:id/resource-proposals/:proposalId", {
      params: { id: ProjectId, proposalId: ResourceProposalId },
      success: ResourceRemoved,
      error: [NotFound, ResourceDenied],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/resources/:definitionId", {
      params: { id: ProjectId, definitionId: ResourceDefinitionId },
      payload: Schema.Struct({ expectedDigest: ResourceSpecDigest }),
      success: ResourceRemoved,
      error: [NotFound, ResourceDenied, ResourceStale],
    }),
  )
  .middleware(AuthMiddleware);
