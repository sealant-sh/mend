import { PreviewId } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

/**
 * Where a client without Mend's cookie signs in to a preview (docs/adr/0017, "Where the link
 * shows up"): `<preview origin>/__mend/auth?ticket=…&path=/`. The ticket in it opens once, within
 * thirty seconds, for the sign-in or paired device that asked.
 */
export class PreviewOpening extends Schema.Class<PreviewOpening>("PreviewOpening")({
  url: Schema.String,
}) {}

export const PreviewNotOpenableReason = Schema.Literals([
  /** The caller proved itself with neither a sign-in nor a paired device (the static token). */
  "no-credential",
  "previews-off",
  /** The gateway serves previews at `*.localhost`, which only the Mend machine reaches. */
  "loopback",
  /** The previews read's `open` is null: the gateway has nothing to serve for it now. */
  "not-served",
]);
export type PreviewNotOpenableReason = typeof PreviewNotOpenableReason.Type;

export class PreviewNotOpenable extends Schema.TaggedError<PreviewNotOpenable>()(
  "PreviewNotOpenable",
  { reason: PreviewNotOpenableReason, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The preview could not be addressed now, or every tailnet port is held; `message` says which. */
export class PreviewsUnavailable extends Schema.TaggedError<PreviewsUnavailable>()(
  "PreviewsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const previewsGroup = HttpApiGroup.make("previews")
  .add(
    HttpApiEndpoint.post("open", "/previews/:id/open", {
      params: { id: PreviewId },
      success: PreviewOpening,
      error: [NotFound, PreviewNotOpenable, PreviewsUnavailable, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
