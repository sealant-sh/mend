import { HARNESS_MODEL_SEED, HarnessModel, harnessModelCatalog } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

const seeded = (harness: string) =>
  harnessModelCatalog(
    harness,
    (HARNESS_MODEL_SEED[harness] ?? []).map(
      (row) =>
        new HarnessModel({
          id: row.id,
          label: row.label,
          isDefault: row.isDefault,
          efforts: row.efforts ?? null,
        }),
    ),
  );

/** The catalog is the machine's: the same list for every signed-in account, none for a stranger. */
describe("harness models", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        harnessModels: {
          list: () => Effect.succeed([seeded("claude"), seeded("codex")]),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("lists every harness's models with its default, efforts and speed", async () => {
    const response = await api.request("carol", "GET", "/api/harnesses/models");
    expect(response.status).toBe(200);
    const catalogs: ReadonlyArray<{
      harness: string;
      defaultModel: string | null;
      efforts: ReadonlyArray<string>;
      fastCapable: boolean;
      models: ReadonlyArray<{ id: string; efforts: ReadonlyArray<string> | null }>;
    }> = await response.json();
    expect(catalogs.map((catalog) => catalog.harness)).toEqual(["claude", "codex"]);
    const claude = catalogs[0];
    expect(claude?.defaultModel).toBe("fable");
    expect(claude?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claude?.fastCapable).toBe(false);
    const codex = catalogs[1];
    expect(codex?.defaultModel).toBe("gpt-6.1-sol");
    expect(codex?.fastCapable).toBe(true);
    expect(codex?.models.find((model) => model.id === "gpt-5.5")?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codex?.models.find((model) => model.id === "gpt-6.1-sol")?.efforts).toBeNull();
  });

  it("is the same list for another member", async () => {
    const response = await api.request("bob", "GET", "/api/harnesses/models");
    expect(response.status).toBe(200);
    const catalogs: ReadonlyArray<{ harness: string }> = await response.json();
    expect(catalogs.map((catalog) => catalog.harness)).toEqual(["claude", "codex"]);
  });

  it("asks for a signed-in account", async () => {
    expect((await api.request(null, "GET", "/api/harnesses/models")).status).toBe(401);
  });
});
