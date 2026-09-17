import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

/** Push devices belong to the account that registers them (docs/adr/0003). */
describe("push devices", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi();
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("register and unregister act as the signed-in account, never a client-chosen one", async () => {
    const registered = await api.request("carol", "POST", "/api/devices", {
      token: "ExponentPushToken[carol]",
      platform: "ios",
    });
    expect(registered.status).toBe(200);
    const removed = await api.request("bob", "DELETE", "/api/devices/ExponentPushToken%5Bcarol%5D");
    expect(removed.status).toBeLessThan(300);
    expect(api.deviceWrites).toEqual([
      "register:carol:ExponentPushToken[carol]",
      "removeOwned:bob:ExponentPushToken[carol]",
    ]);
  });
});
