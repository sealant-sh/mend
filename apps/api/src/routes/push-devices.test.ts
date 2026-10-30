import type { Tracer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { phoneBearerOf, type HarnessUser } from "../../test/support/tenancy-harness.ts";

const phoneOf = (user: HarnessUser) => ({ authorization: `Bearer ${phoneBearerOf(user)}` });

describe("push devices", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi();
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("register and unregister act as the calling phone, never a client-chosen one", async () => {
    const before = api.deviceWrites.length;
    const registered = await api.request(
      null,
      "POST",
      "/api/devices",
      { token: "ExponentPushToken[carol]", platform: "ios" },
      phoneOf("carol"),
    );
    expect(registered.status).toBe(200);
    const removed = await api.request(null, "DELETE", "/api/devices", undefined, phoneOf("bob"));
    expect(removed.status).toBe(204);
    expect(api.deviceWrites.slice(before)).toEqual([
      "register:carol:carol-phone:ExponentPushToken[carol]",
      "forget:bob-phone",
    ]);
  });

  it("forgets the calling phone when an older app unregisters by naming its push token", async () => {
    const before = api.deviceWrites.length;
    const push = "ExponentPushToken[older-app]";
    const registered = await api.request(
      null,
      "POST",
      "/api/devices",
      { token: push, platform: "ios" },
      phoneOf("carol"),
    );
    expect(registered.status).toBe(200);
    const removed = await api.request(
      null,
      "DELETE",
      `/api/devices/${encodeURIComponent(push)}`,
      undefined,
      phoneOf("carol"),
    );
    expect(removed.status).toBe(204);
    expect(api.deviceWrites.slice(before)).toEqual([
      `register:carol:carol-phone:${push}`,
      "forget:carol-phone",
    ]);
  });

  it("refuses a push token from a browser sign-in, whose end would not drop it", async () => {
    const before = api.deviceWrites.length;
    const refused = await api.request("carol", "POST", "/api/devices", {
      token: "ExponentPushToken[browser]",
      platform: "web",
    });
    expect(refused.status).toBe(403);
    const unregistered = await api.request("carol", "DELETE", "/api/devices");
    expect(unregistered.status).toBe(204);
    expect(api.deviceWrites.slice(before)).toEqual([]);
  });

  it("keeps the push token out of the request log and traces when a phone unregisters", async () => {
    const logs: string[] = [];
    const spans: Tracer.Span[] = [];
    const logged = await createTenancyApi({}, { logs, spans });
    try {
      const push = "ExponentPushToken[push-secret-needle]";
      const registered = await logged.request(
        null,
        "POST",
        "/api/devices",
        { token: push, platform: "ios" },
        phoneOf("carol"),
      );
      expect(registered.status).toBe(200);
      const removed = await logged.request(
        null,
        "DELETE",
        "/api/devices",
        undefined,
        phoneOf("carol"),
      );
      expect(removed.status).toBe(204);
      expect(logged.deviceWrites).toContain("forget:carol-phone");
      expect(logs.filter((line) => line.includes("Sent HTTP response"))).toHaveLength(2);
      expect.soft(logs.filter((line) => line.includes("push-secret-needle"))).toEqual([]);
      const traces = JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]));
      expect.soft(traces).not.toContain("push-secret-needle");
    } finally {
      await logged.dispose();
    }
  });

  it("keeps an older app's push token out of the request log and traces, whatever the server answers", async () => {
    const logs: string[] = [];
    const spans: Tracer.Span[] = [];
    const logged = await createTenancyApi({}, { logs, spans });
    try {
      const named = encodeURIComponent("ExponentPushToken[legacy-secret-needle]");
      const answers: Array<string> = [];
      for (const { method, path } of [
        { method: "DELETE", path: `/api/devices/${named}` },
        { method: "DELETE", path: `/API//Devices/${named}/` },
        { method: "GET", path: `/api/devices/${named}` },
        { method: "DELETE", path: `/api/devices/${named}/extra` },
      ]) {
        const response = await logged.request(null, method, path, undefined, phoneOf("carol"));
        answers.push(`${method} ${response.status}`);
      }
      expect.soft(answers).toEqual(["DELETE 204", "DELETE 204", "GET 404", "DELETE 404"]);
      expect.soft(logs.filter((line) => line.includes("legacy-secret-needle"))).toEqual([]);
      const traces = JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]));
      expect.soft(traces).not.toContain("legacy-secret-needle");
    } finally {
      await logged.dispose();
    }
  });
});
