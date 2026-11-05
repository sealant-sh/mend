import type { ExecutorConfiguration } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

describe("Executor API authorization", () => {
  let api: TenancyApi;
  const used: Array<string> = [];
  const configuration: typeof ExecutorConfiguration.Type = {
    mode: "own",
    url: "https://executor.example.invalid",
    mendRunAvailable: false,
    member: { state: "unlinked", observedAt: null },
  };
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        executor: {
          manage: (org) =>
            Effect.sync(() => {
              used.push(`manage:${org}`);
              return configuration;
            }),
          configuration: (org) =>
            Effect.sync(() => {
              used.push(`read:${org}`);
              return configuration;
            }),
          configure: (org) =>
            Effect.sync(() => {
              used.push(`write:${org}`);
              return configuration;
            }),
          personalStatus: (org, user) =>
            Effect.sync(() => {
              used.push(`personal:${org}:${user}`);
              return { configured: true, url: configuration.url, link: configuration.member };
            }),
          begin: (org, user, target) =>
            Effect.sync(() => {
              used.push(`begin:${org}:${user}:${target}`);
              return "https://executor.example.invalid/authorize";
            }),
          unlink: (org, user, target) =>
            Effect.sync(() => {
              used.push(`unlink:${org}:${user}:${target}`);
            }),
        },
        executorRepo: { calls: () => Effect.succeed({ calls: [], olderCursor: null }) },
      },
    });
  });
  afterAll(async () => api.dispose());
  it("lets members read and manage only their own link, with owner-only organization and Mend-member writes", async () => {
    expect((await api.request(null, "GET", "/api/organization/executor")).status).toBe(401);
    expect((await api.request("carol", "GET", "/api/organization/executor")).status).toBe(200);
    expect((await api.request("carol", "GET", "/api/me/executor")).status).toBe(200);
    expect(
      (await api.request("carol", "POST", "/api/me/executor/link", { target: "person" })).status,
    ).toBe(200);
    const before = used.length;
    const writes: ReadonlyArray<readonly ["PUT" | "POST" | "DELETE", string, unknown]> = [
      ["POST", "/api/organization/executor/instance", { action: "start" }],
      ["POST", "/api/organization/executor/instance", { action: "stop" }],
      ["POST", "/api/organization/executor/instance", { action: "upgrade" }],
      ["POST", "/api/organization/executor/instance", { action: "remove" }],
      ["PUT", "/api/organization/executor", { mode: "own", url: configuration.url }],
      ["POST", "/api/me/executor/link", { target: "member" }],
      ["DELETE", "/api/me/executor/link/member", undefined],
    ];
    for (const [method, path, payload] of writes) {
      expect((await api.request("carol", method, path, payload)).status).toBe(404);
    }
    expect(used).toHaveLength(before);
    expect(
      (
        await api.request("alice", "POST", "/api/organization/executor/instance", {
          action: "start",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request("alice", "PUT", "/api/organization/executor", {
          mode: "own",
          url: configuration.url,
        })
      ).status,
    ).toBe(200);
    expect(
      (await api.request("alice", "POST", "/api/me/executor/link", { target: "member" })).status,
    ).toBe(200);
    expect((await api.request("alice", "DELETE", "/api/me/executor/link/member")).status).toBe(200);
    expect(used.some((value) => value.endsWith(":carol:person"))).toBe(true);
  });
  it("checks session visibility before reading a call history or approval", async () => {
    const path = `/api/sessions/${ids("private-alice").session}/executor`;
    expect((await api.request("carol", "GET", path)).status).toBe(404);
    expect((await api.request("bob", "GET", path)).status).toBe(404);
    expect((await api.request("alice", "GET", path)).status).toBe(200);
    expect(
      (await api.request("carol", "POST", path + "/hidden", { action: "accept", content: {} }))
        .status,
    ).toBe(404);
  });
});
