import type { PublicNetwork } from "@mend/network";
import { Layer } from "effect";
import type { HttpRouter } from "effect/unstable/http";

import type { Budgets } from "./budgets.ts";
import { errorBoundary, type ErrorDetail } from "./error-boundary.ts";
import { publicNetworkPolicy } from "./public-network-policy.ts";
import { requestBudgets } from "./request-budgets.ts";
import { apiResponseHeaders } from "./response-headers.ts";

/**
 * Every global middleware of the API, in one place, because their order is part of what they
 * promise (docs/adr/0004). The router wraps in registration order, first outermost:
 *
 * 1. `apiResponseHeaders`: outermost, so every answer carries the API's headers, the refusals of
 *    the middlewares below and the boundary's own included.
 * 2. `publicNetworkPolicy`: origin checks and CORS. Outside the boundary, so an answer the
 *    boundary rewrites still gets its CORS headers.
 * 3. `errorBoundary`: what error text may leave, and what a defect answers, for everything
 *    beneath it.
 * 4. `requestBudgets`: innermost of the four, and still before routing, authentication and a
 *    byte of the body.
 *
 * http-middleware.test.ts holds this order to what a client observes.
 */
export const apiMiddleware = (input: {
  readonly network: PublicNetwork;
  readonly budgets: Budgets["Service"];
  readonly trustedProxies: ReadonlyArray<string>;
  readonly errorDetail: ErrorDetail["Service"];
  readonly now?: () => number;
}): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  Layer.mergeAll(
    apiResponseHeaders,
    publicNetworkPolicy(input.network),
    errorBoundary(input.errorDetail),
    requestBudgets(input.budgets, input.trustedProxies, input.now),
  );
