import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { GhFailure, GhRepoView, GhStatusView } from "./changes.ts";
import { AuthMiddleware } from "./common.ts";

/** Repository identity returned by the caller’s GitHub login. */
export class GithubRepositoryView extends Schema.Class<GithubRepositoryView>(
  "GithubRepositoryView",
)({
  provider: Schema.Literal("github"),
  nameWithOwner: Schema.String,
  url: Schema.String,
  sshUrl: Schema.String,
  /** HTTPS for public repositories, SSH with the person's configured git access otherwise. */
  cloneUrl: Schema.String,
}) {}

export const githubGroup = HttpApiGroup.make("github")
  .add(HttpApiEndpoint.get("status", "/github/status", { success: GhStatusView }))
  .add(
    HttpApiEndpoint.get("repos", "/github/repos", {
      query: { query: Schema.optional(Schema.String) },
      success: Schema.Array(GhRepoView),
      error: GhFailure,
    }),
  )
  .add(
    HttpApiEndpoint.post("repository", "/github/repository", {
      payload: Schema.Struct({ repository: Schema.String }),
      success: GithubRepositoryView,
      error: GhFailure,
    }),
  )
  .middleware(AuthMiddleware);

/** An Expo push token registration — one per app install, token is identity. */
export class RegisterDeviceRequest extends Schema.Class<RegisterDeviceRequest>(
  "RegisterDeviceRequest",
)({
  token: Schema.String,
  platform: Schema.String,
}) {}

export class RegisteredDevice extends Schema.Class<RegisteredDevice>("RegisteredDevice")({
  token: Schema.String,
  platform: Schema.String,
}) {}
