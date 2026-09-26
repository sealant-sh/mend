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
import { describe, expect, it } from "vitest";

/** Every route apps/mobile/src/data/*.ts calls, as the phone spells it. */
const MOBILE_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  // live.ts — projects, sessions, worktrees, GitHub
  ["GET", "/health"],
  ["GET", "/projects"],
  ["POST", "/projects"],
  ["GET", "/projects/:id"],
  ["GET", "/projects/:id/branches"],
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
  // pairing-client.ts + notifications.ts — reached with a raw fetch
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

const isEndpoint = (value: unknown): value is { readonly method: string; readonly path: string } =>
  isRecord(value) &&
  "method" in value &&
  "path" in value &&
  typeof value.method === "string" &&
  typeof value.path === "string";

const exported: ReadonlyArray<unknown> = Object.values(contracts);

const contractRoutes = new Set(
  exported
    .filter(isGroup)
    .flatMap((group) => Object.values(group.endpoints))
    .filter(isEndpoint)
    .map((endpoint) => shape(endpoint.method, endpoint.path)),
);

describe("mobile routes", () => {
  it("found the contract's groups", () => {
    expect(contractRoutes.size).toBeGreaterThan(40);
  });

  it.each(MOBILE_ROUTES)("%s %s exists in the server contract", (method, path) => {
    expect(contractRoutes).toContain(shape(method, path));
  });
});
