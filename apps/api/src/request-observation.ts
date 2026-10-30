import { isResetLinkCallback } from "@mend/auth";
import {
  CREDENTIAL_QUERY_PARAMETERS,
  INVITATION_HEADER,
  PAGE_VIEW_TOKEN_PARAM,
  requestPathOf,
  routedPath,
} from "@mend/network";
import type { ObservationPolicy } from "@mend/network/http-observation";
import { Effect, Layer } from "effect";
import { Headers, UrlParams } from "effect/http";

import { routesToPageView } from "./routes/pages.ts";

const RAW_FILE_READ = /^\/api\/worktrees\/.+\/raw$/;
const UNREGISTER_NAMING_PUSH_TOKEN = /^\/api\/devices\/./;

/** What the API leaves out of its request log and traces: a raw file read, a device, a page view. */
export const apiObservation: ObservationPolicy = {
  unobserved: (request) => {
    const target = requestPathOf(request.url);
    const path = routedPath(target).replace(/\/+$/, "");
    return (
      RAW_FILE_READ.test(path) ||
      UNREGISTER_NAMING_PUSH_TOKEN.test(path) ||
      isResetLinkCallback(target) ||
      routesToPageView(request)
    );
  },
};

/** Names Effect's server tracer records as `<redacted>` in a URL's query and in a header. */
export const RedactedRequestPartsLive: Layer.Layer<never> = Layer.mergeAll(
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
