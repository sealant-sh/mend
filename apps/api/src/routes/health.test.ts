import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

/**
 * `/health` needs no sign-in, so on an instance the Internet can reach it is read by anyone
 * (docs/adr/0004). It says how exposure was declared and how many gate items are open, and never
 * which: the ids would be a list of what to try. They are the operator's (`/operator/exposure`).
 */
describe("GET /api/health, read by anyone", () => {
  it("counts the open exposure gate items and names none of them", async () => {
    api = await createTenancyApi(
      {},
      {
        exposure: {
          exposure: "public",
          gate: [
            {
              id: "no-bearers-in-urls",
              established: "open",
              detail: "a bearer in a URL is still accepted",
              fix: "set MEND_URL_BEARERS=refuse",
              blocksStart: true,
              observable: true,
            },
            {
              id: "edge-tls",
              established: "open",
              detail: "this process cannot observe the edge's certificate",
              fix: "what would verify it: mend doctor from another network",
              blocksStart: false,
              observable: false,
            },
            // It refuses a public start, and still no build can observe it: counted as unobservable.
            {
              id: "workspace-ssh",
              established: "open",
              detail: "workspace SSH is published on 0.0.0.0:2222 apart from the web port",
              fix: "what would verify it: a connection attempt from outside",
              blocksStart: true,
              observable: false,
            },
            {
              id: "budgets",
              established: "observed",
              detail: "every budget is set",
              fix: null,
              blocksStart: true,
              observable: true,
            },
          ],
        },
      },
    );
    const response = await api.request(null, "GET", "/api/health");
    expect(response.status).toBe(200);
    const text = await response.text();
    const health: unknown = JSON.parse(text);
    expect(health).toMatchObject({
      upgradeTickets: true,
      exposure: { declared: "public", open: 3, unobservable: 2 },
    });
    for (const id of [
      "no-bearers-in-urls",
      "edge-tls",
      "workspace-ssh",
      "budgets",
      "MEND_URL_BEARERS",
    ]) {
      expect(text).not.toContain(id);
    }
  });
});
