import {
  PiProfileRemoved,
  PiProfileSaved,
  PiProfileUpload,
  PiProfileView,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";

/** The profile failed validation; the message says which rule. */
export class PiProfileRejected extends Schema.TaggedErrorClass<PiProfileRejected>()(
  "PiProfileRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * The signed-in account's pi setup (`mend connect pi`): every pi session it starts receives it.
 * PUT replaces the whole profile.
 */
export const piProfileGroup = HttpApiGroup.make("piProfile")
  .add(HttpApiEndpoint.get("get", "/me/pi-profile", { success: PiProfileView }))
  .add(
    HttpApiEndpoint.put("save", "/me/pi-profile", {
      payload: PiProfileUpload,
      success: PiProfileSaved,
      error: PiProfileRejected,
    }),
  )
  .add(HttpApiEndpoint.delete("remove", "/me/pi-profile", { success: PiProfileRemoved }))
  .middleware(AuthMiddleware);
