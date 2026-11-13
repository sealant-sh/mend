import { BOAT_FAILURE_KINDS, SealantBoatError } from "@sealant/sdk";
import { describe, expect, it } from "vitest";

import { toPlatformError } from "./client.ts";

/**
 * A Boat launch sealant failed reaches the session engine with Boat's reason intact, for every kind
 * sealant names (SLNT-793): the engine hands the kind to the Boat failure table unchanged, so this and
 * the table's own tests cover every kind without a launch each.
 */
describe("Boat's reason on a failed Boat launch", () => {
  for (const kind of BOAT_FAILURE_KINDS) {
    it(`keeps ${kind}, and nulls for what Boat did not say`, () => {
      const error = toPlatformError(
        new SealantBoatError(
          'Workspace ws-boat reached terminal status "failed" before becoming ready',
          {
            kind,
            retryable: kind === "rate-limited",
            operation: "create",
            status: 403,
            code: "api_code",
            requestId: "req_1",
            ...(kind === "permission-missing" ? { permission: "sandbox.create" } : {}),
          },
          { code: "workspace_not_ready" },
        ),
      );
      expect(error.boat).toEqual({
        kind,
        retryable: kind === "rate-limited",
        operation: "create",
        status: 403,
        code: "api_code",
        message: null,
        requestId: "req_1",
        permission: kind === "permission-missing" ? "sandbox.create" : null,
        retryAfterSeconds: null,
        retryAt: null,
        billingUrl: null,
      });
    });
  }
});
