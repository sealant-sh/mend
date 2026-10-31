import { ProjectId } from "@mend/domain";
import {
  DopplerConfigs,
  DopplerConnectionInput,
  DopplerMapping,
  DopplerProjects,
  DopplerRemoved,
  DopplerSelection,
  DopplerStatus,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

export class DopplerRejected extends Schema.TaggedError<DopplerRejected>()(
  "DopplerRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}
export class DopplerUnavailable extends Schema.TaggedError<DopplerUnavailable>()(
  "DopplerUnavailable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** All reads and writes refer to the authenticated person's own connection and selections. */
export const dopplerGroup = HttpApiGroup.make("doppler")
  .add(HttpApiEndpoint.get("status", "/me/doppler", { success: DopplerStatus }))
  .add(
    HttpApiEndpoint.put("save", "/me/doppler", {
      payload: DopplerConnectionInput,
      success: Schema.Struct({ connected: Schema.Boolean }),
      error: DopplerRejected,
    }),
  )
  .add(HttpApiEndpoint.delete("disconnect", "/me/doppler", { success: DopplerRemoved }))
  .add(
    HttpApiEndpoint.put("use", "/me/doppler/projects/:projectId", {
      params: { projectId: ProjectId },
      payload: DopplerSelection,
      success: DopplerMapping,
      error: [NotFound, DopplerRejected, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMapping", "/me/doppler/projects/:projectId", {
      params: { projectId: ProjectId },
      success: DopplerRemoved,
      error: [NotFound, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("projects", "/me/doppler/projects", {
      success: DopplerProjects,
      error: [DopplerRejected, DopplerUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("configs", "/me/doppler/configs", {
      query: { project: Schema.String },
      success: DopplerConfigs,
      error: [DopplerRejected, DopplerUnavailable],
    }),
  )
  .middleware(AuthMiddleware);
