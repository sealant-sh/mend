import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/** Shared control (docs/adr/0003, "Sessions and shared control") over the two-organization world. */
describe("shared control", () => {
  let api: TenancyApi;
  const sharedA = ids("shared-a");
  const toggle = `/api/sessions/${sharedA.session}/shared-control`;
  const turns = `/api/sessions/${sharedA.session}/turns`;

  beforeAll(async () => {
    api = await createTenancyApi();
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    api.world.calls.splice(0, api.world.calls.length);
  });

  it("only the owner turns it on; a teammate is refused before anything moves", async () => {
    const carol = await api.request("carol", "PUT", toggle, { enabled: true });
    const bob = await api.request("bob", "PUT", toggle, { enabled: true });
    expect({ carol: carol.status, bob: bob.status, calls: api.world.calls }).toEqual({
      carol: 403,
      bob: 404,
      calls: [],
    });
  });

  it("once the owner shares, a teammate steers; once it is off again, they are refused", async () => {
    const refusedBefore = await api.request("carol", "POST", turns, { input: "Continue" });
    expect(refusedBefore.status).toBe(403);

    const on = await api.request("alice", "PUT", toggle, { enabled: true });
    expect(on.status).toBe(200);
    expect(api.world.calls).toEqual([
      "sessions.setSharedControl",
      "controlEvents.record",
      "audit.record",
    ]);

    api.world.calls.splice(0, api.world.calls.length);
    const steered = await api.request("carol", "POST", turns, { input: "Continue" });
    expect(steered.status).not.toBe(403);
    expect(api.world.calls.length).toBeGreaterThan(0);

    const off = await api.request("alice", "PUT", toggle, { enabled: false });
    expect(off.status).toBe(200);
    api.world.calls.splice(0, api.world.calls.length);
    const refusedAfter = await api.request("carol", "POST", turns, { input: "Continue" });
    expect({ status: refusedAfter.status, calls: api.world.calls }).toEqual({
      status: 403,
      calls: [],
    });
  });
});
