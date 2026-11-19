import {
  RenameLayoutRequest,
  SavedLayout,
  SavedLayoutRemoved,
  SavedLayoutsView,
  SaveLayoutRequest,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware } from "./common.ts";

/** Another of the person's layouts has this name, ignoring case. */
export class SavedLayoutNameTaken extends Schema.TaggedError<SavedLayoutNameTaken>()(
  "SavedLayoutNameTaken",
  { name: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The person already keeps `limit` layouts, the most Mend holds per person. */
export class SavedLayoutLimitReached extends Schema.TaggedError<SavedLayoutLimitReached>()(
  "SavedLayoutLimitReached",
  { limit: Schema.Int, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class SavedLayoutNotFound extends Schema.TaggedError<SavedLayoutNotFound>()(
  "SavedLayoutNotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const byId = Schema.Struct({ id: Schema.String });

/**
 * The signed-in person's saved layouts of a workspace's tiles (ADR 0026, "Layouts"): the
 * account's own, shown in every workspace of every organization, and only ever the caller's. A
 * layout the schema doesn't know (another version, more tiles than the limit, a key it has no
 * place for, such as a session's id) is refused with 400 and nothing is stored.
 */
export const savedLayoutsGroup = HttpApiGroup.make("savedLayouts")
  .add(HttpApiEndpoint.get("list", "/me/layouts", { success: SavedLayoutsView }))
  .add(
    HttpApiEndpoint.post("save", "/me/layouts", {
      payload: SaveLayoutRequest,
      success: SavedLayout,
      error: [SavedLayoutNameTaken, SavedLayoutLimitReached],
    }).annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" }),
  )
  .add(
    HttpApiEndpoint.patch("rename", "/me/layouts/:id", {
      params: byId,
      payload: RenameLayoutRequest,
      success: SavedLayout,
      error: [SavedLayoutNameTaken, SavedLayoutNotFound],
    }).annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/me/layouts/:id", {
      params: byId,
      success: SavedLayoutRemoved,
    }),
  )
  .middleware(AuthMiddleware);
