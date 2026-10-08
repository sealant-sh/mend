// Every route the phone calls, pinned against the server contract. The phone
// builds its URLs by hand (raw fetch, no generated client), so nothing else
// fails at build time when the contract moves a route — this did happen:
// #83 replaced POST /changes/:id/comments with the slice-scoped route and
// the phone kept posting into a 404 for weeks. Every (method, path template)
// the data layer touches must exist in @mend/api-contracts.
//
// Keep this list in step with `grep -rn 'api(' src` — a route added to the
// data layer without a row here is a route nobody checks.

import * as contracts from "@mend/api-contracts";
import { HttpApiSchema } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

/** Every route apps/mobile/src/data/*.ts calls, as the phone spells it. */
const MOBILE_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  // live.ts — projects, sessions, worktrees, GitHub
  ["GET", "/health"],
  ["GET", "/projects"],
  ["POST", "/projects"],
  ["GET", "/projects/:id"],
  ["GET", "/projects/:id/branches"],
  ["GET", "/harnesses/models"],
  ["POST", "/projects/:id/sessions"],
  ["GET", "/sessions/:id"],
  ["DELETE", "/sessions/:id"],
  ["POST", "/sessions/:id/launch"],
  ["POST", "/sessions/:id/shell"],
  ["POST", "/sessions/:id/stop"],
  ["POST", "/sessions/:id/resume"],
  ["POST", "/sessions/:id/label"],
  ["POST", "/sessions/:id/handoff"],
  ["POST", "/sessions/:id/images"],
  ["GET", "/sessions/:id/waiting"],
  ["GET", "/sessions/:id/workspace-retirement"],
  ["POST", "/sessions/:id/workspace-retirement/replace"],
  ["GET", "/organization"],
  ["GET", "/sessions/:id/items"],
  ["GET", "/sessions/:id/turns"],
  ["POST", "/sessions/:id/turns"],
  ["GET", "/sessions/:id/requests"],
  ["POST", "/requests/:id/respond"],
  ["POST", "/turns/:id/interrupt"],
  ["POST", "/processes/:id/stop"],
  ["DELETE", "/worktrees/:id"],
  ["GET", "/github/status"],
  ["GET", "/github/repos"],
  ["POST", "/upgrade-tickets"],
  // review.ts — the review loop
  ["GET", "/changes/:id/comments"],
  ["POST", "/changes/:id/comments/:commentId/state"],
  ["GET", "/changes/:id/tour"],
  ["POST", "/changes/:id/tour"],
  ["POST", "/changes/:id/read"],
  ["POST", "/changes/:id/suggest"],
  ["GET", "/changes/:id/passes"],
  ["POST", "/changes/:id/reviews/open"],
  ["GET", "/changes/:id/reviews/:sliceId/diff"],
  ["POST", "/changes/:id/reviews/:sliceId/comments"],
  ["GET", "/sessions/:id/follow-up"],
  ["POST", "/sessions/:id/follow-up/deliver"],
  // pull-requests.ts — the change's pull request on GitHub
  ["GET", "/sessions/:id/landings"],
  ["POST", "/landings/:id/refresh"],
  // notification-settings.ts — what this account hears about on its phones
  ["GET", "/me/notifications"],
  ["PUT", "/me/notifications"],
  // pairing-client.ts + notifications.ts — reached with a raw fetch
  ["POST", "/pair"],
  ["POST", "/devices"],
];

/**
 * The routes the data layer reads with `apiNoContent`: their contract declares no success body, so
 * the server answers 204. `api` parses JSON, and an empty body fails it after the server already
 * did the work — Stop read "JSON Parse error" while the turn had stopped.
 */
const NO_CONTENT_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ["POST", "/turns/:id/interrupt"],
  ["POST", "/sessions/:id/workspace-retirement/replace"],
];

/** Reached with a raw fetch that reads the body itself, not with `api`. */
const RAW_FETCH_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ["POST", "/pair"],
  ["POST", "/devices"],
];

/** `:name` segments compare by position, not by the name each side picked. */
const shape = (method: string, path: string): string =>
  `${method} ${path.replace(/:[A-Za-z]+/g, ":_")}`;

// Effect's groups and endpoints are callable (pipeable) objects: typeof says "function".
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

const isGroup = (value: unknown): value is { readonly endpoints: Record<string, unknown> } =>
  isRecord(value) && "endpoints" in value;

const isEndpoint = (
  value: unknown,
): value is {
  readonly method: string;
  readonly path: string;
  readonly success: ReadonlySet<{ readonly ast: Parameters<typeof HttpApiSchema.isNoContent>[0] }>;
} =>
  isRecord(value) &&
  "method" in value &&
  "path" in value &&
  "success" in value &&
  typeof value.method === "string" &&
  typeof value.path === "string" &&
  value.success instanceof Set;

const exported: ReadonlyArray<unknown> = Object.values(contracts);

const endpoints = exported
  .filter(isGroup)
  .flatMap((group) => Object.values(group.endpoints))
  .filter(isEndpoint);

const contractRoutes = new Set(endpoints.map((endpoint) => shape(endpoint.method, endpoint.path)));

/** Whether the route answers with no body: every success schema it declares is empty. */
const answersNoContent = (method: string, path: string): boolean | undefined => {
  const endpoint = endpoints.find(
    (candidate) => shape(candidate.method, candidate.path) === shape(method, path),
  );
  if (endpoint === undefined) return undefined;
  return [...endpoint.success].every((schema) => HttpApiSchema.isNoContent(schema.ast));
};

const listed = (
  routes: ReadonlyArray<readonly [method: string, path: string]>,
  method: string,
  path: string,
): boolean => routes.some(([m, p]) => shape(m, p) === shape(method, path));

describe("mobile routes", () => {
  it("found the contract's groups", () => {
    expect(contractRoutes.size).toBeGreaterThan(40);
  });

  it.each(MOBILE_ROUTES)("%s %s exists in the server contract", (method, path) => {
    expect(contractRoutes).toContain(shape(method, path));
  });

  it.each(MOBILE_ROUTES.filter(([method, path]) => !listed(RAW_FETCH_ROUTES, method, path)))(
    "%s %s is read the way it answers: JSON with api, 204 with apiNoContent",
    (method, path) => {
      expect(answersNoContent(method, path)).toBe(listed(NO_CONTENT_ROUTES, method, path));
    },
  );
});
