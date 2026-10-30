import {
  CREDENTIAL_QUERY_PARAMETERS,
  INVITATION_HEADER,
  PAGE_VIEW_TOKEN_PARAM,
} from "@mend/network";
import { Effect, Layer } from "effect";
import { Headers, HttpMiddleware, UrlParams } from "effect/http";

import { routesToPageView } from "./routes/pages.ts";
import { unloggedRequest } from "./unlogged-requests.ts";

/**
 * Effect's server tracer records `url.full` and `url.query` on every spelling the router matches,
 * refused or not, and reads a single predicate, so each route whose URL carries a secret joins
 * this one rather than providing its own. A header it records once a TracerHeaderFilter opts in,
 * and a logged request's headers, show `<redacted>` for the invitation token a sign-up carries.
 */
export const UntracedRequestsLive: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
    (request) => unloggedRequest(request) || routesToPageView(request),
  ),
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    Effect.gen(function* () {
      return [
        ...(yield* UrlParams.CurrentRedactedNames),
        ...CREDENTIAL_QUERY_PARAMETERS,
        PAGE_VIEW_TOKEN_PARAM,
      ];
    }),
  ),
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.gen(function* () {
      return [...(yield* Headers.CurrentRedactedNames), INVITATION_HEADER];
    }),
  ),
);
