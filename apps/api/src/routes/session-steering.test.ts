import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  ids,
  NULL_OWNER_SESSION,
  PROTOCOL_PROCESS,
  UDP_SERVICE,
} from "../../test/support/tenancy-harness.ts";

/**
 * Session steering beyond the HTTP API table (docs/adr/0003, "Sessions and shared control"): the
 * raw terminal and Service tunnel routes, and pre-organizations sessions with no owner.
 */

let api: TenancyApi;

beforeAll(async () => {
  api = await createTenancyApi();
});
afterAll(async () => {
  await api.dispose();
});
beforeEach(() => {
  api.world.calls.splice(0, api.world.calls.length);
});

describe("legacy sessions without an owner", () => {
  const turns = `/api/sessions/${NULL_OWNER_SESSION}/turns`;

  it("the first account steers them", async () => {
    const response = await api.request("alice", "POST", turns, { input: "Continue" });
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(404);
  });

  it("anyone else who can see them is refused before any effect", async () => {
    const response = await api.request("carol", "POST", turns, { input: "Continue" });
    expect({ status: response.status, calls: api.world.calls }).toEqual({
      status: 403,
      calls: [],
    });
  });
});

describe("raw steering routes", () => {
  const sharedA = ids("shared-a");
  const sharedB = ids("shared-b");

  it.each([
    {
      name: "a terminal by process",
      path: `/api/tty?process=${PROTOCOL_PROCESS}`,
      conflict: "protocol agents use the structured conversation API",
    },
    {
      name: "a Service tunnel",
      path: `/api/service-tunnel?service=${UDP_SERVICE}`,
      conflict: "UDP Services have no connection to tunnel",
    },
  ])(
    "$name: a visible non-owner is refused before the state conflict is disclosed",
    async (testCase) => {
      const refused = await api.rawRequest("carol", testCase.path);
      expect({
        status: refused.status,
        text: await refused.text(),
        calls: api.world.calls,
      }).toEqual({ status: 403, text: "forbidden", calls: [] });
      const owner = await api.rawRequest("alice", testCase.path);
      expect({ status: owner.status, text: await owner.text() }).toEqual({
        status: 409,
        text: testCase.conflict,
      });
    },
  );

  it.each([
    {
      name: "terminal by process",
      hidden: `/api/tty?process=${sharedA.process}`,
      missing: "/api/tty?process=missing",
    },
    {
      name: "terminal by session",
      hidden: `/api/tty?session=${sharedA.session}`,
      missing: "/api/tty?session=missing",
    },
    {
      name: "Service tunnel",
      hidden: `/api/service-tunnel?service=${sharedA.service}`,
      missing: "/api/service-tunnel?service=missing",
    },
  ])(
    "$name: another organization's resource answers exactly like a missing one",
    async (testCase) => {
      const hidden = await api.rawRequest("bob", testCase.hidden);
      const hiddenText = await hidden.text();
      const missing = await api.rawRequest("bob", testCase.missing);
      expect({ status: hidden.status, text: hiddenText, calls: api.world.calls }).toEqual({
        status: 404,
        text: await missing.text(),
        calls: [],
      });
    },
  );

  it("the owner of a visible session gets past authorization to the platform", async () => {
    await api.rawRequest("bob", `/api/tty?session=${sharedB.session}`);
    expect(api.world.calls).toContain("sealant.getWorkspace");
  });
});
