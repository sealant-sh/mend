import type { JobSpec } from "@mend/jobs";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * A review pass runs on the login of whoever asked for it (docs/adr/0008-one-refresher-for-provider-
 * logins.md, "Whose login pays"), never on the change owner's: carol asking for a pass over
 * alice's change spends carol's login.
 */
describe("review passes: whose login pays", () => {
  let api: TenancyApi;
  const enqueued: Array<JobSpec> = [];
  const sharedA = ids("shared-a");

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          jobs: { enqueue: (job) => Effect.sync(() => (enqueued.push(job), "job-1")) },
          changePasses: { queue: () => Effect.void },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    enqueued.splice(0, enqueued.length);
  });

  it.each([
    ["tour", "compose-tour"],
    ["read", "read-change"],
    ["suggest", "suggest-change"],
  ])("POST /%s queues %s on the asker's login", async (route, job) => {
    const carol = await api.request("carol", "POST", `/api/changes/${sharedA.change}/${route}`);
    const alice = await api.request("alice", "POST", `/api/changes/${sharedA.change}/${route}`);
    expect({ carol: carol.status, alice: alice.status }).toEqual({ carol: 200, alice: 200 });
    expect(enqueued.map((spec) => ({ name: spec.name, payload: spec.payload }))).toEqual([
      { name: job, payload: { changeId: sharedA.change, requestedBy: "carol" } },
      { name: job, payload: { changeId: sharedA.change, requestedBy: "alice" } },
    ]);
  });
});
