import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { GhFailure, GhRepoView, GhStatusView } from "./changes.ts";
import { AuthMiddleware } from "./common.ts";

export const githubGroup = HttpApiGroup.make("github")
  .add(HttpApiEndpoint.get("status", "/github/status", { success: GhStatusView }))
  .add(
    HttpApiEndpoint.get("repos", "/github/repos", {
      query: { query: Schema.optional(Schema.String) },
      success: Schema.Array(GhRepoView),
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
