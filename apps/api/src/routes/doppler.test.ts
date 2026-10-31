import { DopplerUnavailable } from "@mend/api-contracts";
import { ProjectId } from "@mend/domain";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const token = "dp.ct.synthetic-personal-canary";

describe("personal Doppler API", () => {
  let api: TenancyApi;
  const stored = new Map<string, string>();
  const mappings = new Map<
    string,
    Map<ProjectId, { projectId: ProjectId; dopplerProject: string; config: string }>
  >();
  const cipherInputs: Array<string> = [];
  const externalTokens: Array<Redacted.Redacted<string>> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        cipher: {
          encrypt: (plaintext) =>
            Effect.sync(() => {
              cipherInputs.push(plaintext);
              return "sealed-canary";
            }),
          decrypt: () => Effect.succeed(token),
        },
        doppler: {
          connection: (userId) =>
            Effect.succeed(
              stored.has(userId)
                ? { sealedToken: stored.get(userId) ?? "", updatedAt: new Date(0) }
                : null,
            ),
          save: (userId, sealed) =>
            Effect.sync(() => {
              stored.set(userId, sealed);
            }),
          mappings: (userId) => Effect.succeed([...(mappings.get(userId)?.values() ?? [])]),
          use: (userId, projectId, selection) =>
            Effect.sync(() => {
              const own = mappings.get(userId) ?? new Map();
              own.set(projectId, { projectId, ...selection });
              mappings.set(userId, own);
            }),
          removeMapping: (userId, projectId) =>
            Effect.succeed(mappings.get(userId)?.delete(projectId) ?? false),
          disconnect: (userId) =>
            Effect.sync(() => {
              mappings.delete(userId);
              return stored.delete(userId);
            }),
        },
        dopplerApi: {
          projects: (credential) =>
            Effect.sync(() => {
              externalTokens.push(credential);
              return { projects: [{ id: "backend", name: "Backend" }] };
            }),
          configs: (credential, project) => {
            externalTokens.push(credential);
            return project === "down"
              ? Effect.fail(new DopplerUnavailable({ message: "Doppler could not list configs." }))
              : Effect.succeed({ configs: [{ name: "dev" }] });
          },
        },
      },
    });
  });
  afterAll(async () => api.dispose());

  it("encrypts once, returns names only, isolates people and authorizes visible project mappings", async () => {
    expect((await api.request(null, "GET", "/api/me/doppler")).status).toBe(401);
    expect(await (await api.request("carol", "GET", "/api/me/doppler")).json()).toEqual({
      connected: false,
      name: null,
      updatedAt: null,
      mappings: [],
    });
    const saved = await api.request("carol", "PUT", "/api/me/doppler", { token });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ connected: true });
    expect(cipherInputs).toEqual([token]);
    expect(stored.get("carol")).toBe("sealed-canary");
    expect(externalTokens).toEqual([]);
    const shared = ids("shared-a").project;
    expect(
      (
        await api.request("carol", "PUT", `/api/me/doppler/projects/${shared}`, {
          dopplerProject: "backend",
          config: "dev_carol",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request("bob", "PUT", `/api/me/doppler/projects/${shared}`, {
          dopplerProject: "backend",
          config: "dev_bob",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request(
          "carol",
          "PUT",
          `/api/me/doppler/projects/${ids("private-alice").project}`,
          { dopplerProject: "backend", config: "prd" },
        )
      ).status,
    ).toBe(404);
    const status = await (await api.request("carol", "GET", "/api/me/doppler")).json();
    expect(status).toMatchObject({
      connected: true,
      name: null,
      updatedAt: "1970-01-01T00:00:00.000Z",
      mappings: [{ projectId: shared, dopplerProject: "backend", config: "dev_carol" }],
    });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain("sealed");
    expect(await (await api.request("alice", "GET", "/api/me/doppler")).json()).toMatchObject({
      connected: false,
      mappings: [],
    });
    expect(
      (await api.request("alice", "DELETE", `/api/me/doppler/projects/${shared}`)).status,
    ).toBe(200);
    expect(mappings.get("carol")?.size).toBe(1);
    expect((await api.request("carol", "GET", "/api/me/doppler/projects")).status).toBe(200);
    expect(
      (await api.request("carol", "GET", "/api/me/doppler/configs?project=backend")).status,
    ).toBe(200);
    expect(externalTokens.map(Redacted.value)).toEqual([token, token]);
    expect(JSON.stringify(externalTokens)).not.toContain(token);
    expect((await api.request("carol", "GET", "/api/me/doppler/configs?project=down")).status).toBe(
      502,
    );
    expect(
      await (await api.request("bob", "GET", "/api/me/doppler/projects")).json(),
    ).toMatchObject({ _tag: "DopplerRejected" });
    expect((await api.request("carol", "DELETE", "/api/me/doppler")).status).toBe(200);
    expect(stored.has("carol")).toBe(false);
    expect(mappings.has("carol")).toBe(false);
  });

  it("accepts service and unfamiliar token kinds; refuses only basic invalid input without echoing it", async () => {
    for (const credential of ["dp.st.fake-service", "unfamiliar-fake-kind"]) {
      expect(
        (await api.request("bob", "PUT", "/api/me/doppler", { token: credential })).status,
      ).toBe(200);
    }
    for (const credential of ["", "token with secret whitespace", "x".repeat(8193)]) {
      const response = await api.request("bob", "PUT", "/api/me/doppler", { token: credential });
      expect(response.status).toBe(422);
      if (credential !== "") expect(await response.text()).not.toContain(credential);
    }
    const invalid = await api.request(
      "bob",
      "PUT",
      `/api/me/doppler/projects/${ids("shared-b").project}`,
      { dopplerProject: "../bad", config: "dev" },
    );
    expect(invalid.status).toBe(422);
  });
});
