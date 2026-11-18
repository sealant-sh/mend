import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, NULL_OWNER_SESSION } from "../../test/support/tenancy-harness.ts";

/**
 * What Stop session would do (docs/adr/0026, decision 7): the dialog names each session that keeps
 * the workspace running as the inbox does, with whose it is.
 */
describe("GET /sessions/:id/stop-preview", () => {
  it("names the sessions that keep the workspace running, with their titles and owners", async () => {
    const sharedA = ids("shared-a");
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            stopSessionReach: () =>
              Effect.succeed({
                workspace: "keeps-running",
                runningSessions: [sharedA.session],
                services: [],
              } as const),
          },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "GET",
        `/api/sessions/${NULL_OWNER_SESSION}/stop-preview`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sessionId: NULL_OWNER_SESSION,
        workspace: "keeps-running",
        runningSessions: [
          {
            sessionId: sharedA.session,
            title: "Tenancy harness",
            ownerUserId: "alice",
            ownerName: "Alice",
          },
        ],
        services: [],
      });
    } finally {
      await api.dispose();
    }
  });
});
