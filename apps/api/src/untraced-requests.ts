import { PAGE_VIEW_TOKEN_PARAM } from "@mend/network";
import { Effect, Layer } from "effect";
import { HttpMiddleware, UrlParams } from "effect/http";

import { rawFileRequest } from "./raw-file-privacy.ts";
import { routesToPageView } from "./routes/pages.ts";

/**
 * Effect's server tracer records `url.full` and `url.query` on every spelling the router matches,
 * refused or not, and reads a single predicate, so each route whose URL carries a secret joins
 * this one rather than providing its own.
 */
export const UntracedRequestsLive: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
    (request) => rawFileRequest(request) || routesToPageView(request),
  ),
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    Effect.gen(function* () {
      return [...(yield* UrlParams.CurrentRedactedNames), PAGE_VIEW_TOKEN_PARAM];
    }),
  ),
);
