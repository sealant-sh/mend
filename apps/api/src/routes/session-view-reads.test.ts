import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * The session list, the session view and the project view read the per-person columns (the people
 * live in each executor, its retirement; docs/adr/0016, decision 13) only when per-person homes are
 * possible at all. With the flag off and nothing recorded they run the plain reads: no subquery.
 */
describe("the per-person columns of the session reads", () => {
  let api: TenancyApi | null = null;
  const shared = ids("shared-a");
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  const readsWith = async (possible: boolean) => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            personLayoutPossible: () => Effect.succeed(possible),
            refreshCaptureStatus: () => Effect.void,
          },
        },
      },
    );
    const list = await api.request("alice", "GET", "/api/sessions");
    expect(list.status).toBe(200);
    // The view and the project view read the session rows first: which read they make is the
    // point here (this world does not answer the rest of either).
    await api.request("alice", "GET", `/api/sessions/${shared.session}`);
    await api.request("alice", "GET", `/api/projects/${shared.project}`);
    return api.world.calls.filter((call) => call.startsWith("sessions."));
  };

  it("with the flag off and nothing recorded, the plain reads", async () => {
    const calls = await readsWith(false);
    expect(calls).toContain("sessions.listActive");
    expect(calls).toContain("sessions.listForProject");
    expect(calls.filter((call) => call.endsWith("View") || call === "sessions.viewById")).toEqual(
      [],
    );
  });

  it("with per-person homes possible, the reads with live people and the retirement", async () => {
    const calls = await readsWith(true);
    expect(calls).toContain("sessions.listActiveView");
    expect(calls).toContain("sessions.viewById");
    expect(calls).toContain("sessions.listForProjectView");
    expect(calls).not.toContain("sessions.listActive");
  });
});
