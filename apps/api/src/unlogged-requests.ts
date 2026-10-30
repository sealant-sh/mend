import { requestPathOf } from "@mend/network";
import { Effect, type Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

import { routedPath } from "./request-budgets.ts";

const RAW_FILE_READ = /^\/api\/worktrees\/.+\/raw$/;
const UNREGISTER_NAMING_PUSH_TOKEN = /^\/api\/devices\/./;

export const unloggedRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const path = routedPath(requestPathOf(request.url)).replace(/\/+$/, "");
  return RAW_FILE_READ.test(path) || UNREGISTER_NAMING_PUSH_TOKEN.test(path);
};

export const unloggedRequests: Layer.Layer<never, never, HttpRouter.HttpRouter> =
  HttpRouter.middleware(
    (handler) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        unloggedRequest(request) ? HttpMiddleware.withLoggerDisabled(handler) : handler,
      ),
    { global: true },
  );
