import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

describe("GET /sessions/:id", () => {
  const shared = ids("shared-a");

  it("answers launchAdmission agentRan: a never-launched Retry is refused once an agent ran", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            personLayoutPossible: () => Effect.succeed(false),
            refreshCaptureStatus: () => Effect.void,
          },
          checkpoints: { listForWorktree: () => Effect.succeed([]) },
          landings: { listForChange: () => Effect.succeed([]) },
        },
      },
    );
    try {
      const response = await api.request("alice", "GET", `/api/sessions/${shared.session}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        session: { id: shared.session },
        launchAdmission: "agentRan",
      });
    } finally {
      await api.dispose();
    }
  });
});
