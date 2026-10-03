import {
  SecretFileRemoved,
  SecretFileSaved,
  SecretFileUpload,
  SecretFilesView,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";

/** The path or the content failed validation; the message says which rule. */
export class SecretFileRejected extends Schema.TaggedErrorClass<SecretFileRejected>()(
  "SecretFileRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * The signed-in account's secret files (docs/adr/0010-secret-files.md): every session it owns
 * receives them at launch. Only ever the caller's own. The content is write-only: PUT creates or
 * replaces the file at its path, and no route returns what a file holds.
 */
export const secretFilesGroup = HttpApiGroup.make("secretFiles")
  .add(HttpApiEndpoint.get("list", "/me/secret-files", { success: SecretFilesView }))
  .add(
    HttpApiEndpoint.put("save", "/me/secret-files", {
      payload: SecretFileUpload,
      success: SecretFileSaved,
      error: SecretFileRejected,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/me/secret-files", {
      query: { path: Schema.String },
      success: SecretFileRemoved,
    }),
  )
  .middleware(AuthMiddleware);
