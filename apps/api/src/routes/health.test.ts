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
            },
            {
              id: "edge-tls",
              established: "open",
              detail: "this process cannot observe the edge's certificate",
              fix: "what would verify it: mend doctor from another network",
              blocksStart: false,
            },
            {
              id: "budgets",
              established: "observed",
              detail: "every budget is set",
              fix: null,
              blocksStart: true,
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
      exposure: { declared: "public", open: 2, unobservable: 1 },
    });
    for (const id of ["no-bearers-in-urls", "edge-tls", "budgets", "MEND_URL_BEARERS"]) {
      expect(text).not.toContain(id);
    }
  });
});
