import { describe, expect, it } from "vitest";

import { modelCatalogJson, modelCatalogLines, type HarnessModelCatalogDto } from "./models.ts";

const catalogs: ReadonlyArray<HarnessModelCatalogDto> = [
  {
    harness: "claude",
    models: [
      { id: "fable", label: "Fable · latest", isDefault: true, efforts: null },
      { id: "sonnet", label: "Sonnet · latest", isDefault: false, efforts: null },
    ],
    defaultModel: "fable",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    fastCapable: false,
  },
  {
    harness: "codex",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, efforts: null },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        isDefault: false,
        efforts: ["low", "medium", "high", "xhigh"],
      },
    ],
    defaultModel: "gpt-6.1-sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fastCapable: true,
  },
];

describe("mend models", () => {
  it("prints each harness, its ids first, the default marked, and the efforts a model limits", () => {
    expect(modelCatalogLines(catalogs)).toEqual([
      "claude  effort low … max",
      "  fable   Fable · latest  default",
      "  sonnet  Sonnet · latest",
      "",
      "codex  effort low … ultra · --fast",
      "  gpt-6.1-sol  GPT-6.1 Sol  default",
      "  gpt-5.5      GPT-5.5  effort low … xhigh",
    ]);
  });

  it("says when the server lists nothing", () => {
    expect(modelCatalogLines([])).toEqual([
      "no models listed · the server's harness_models table is empty",
    ]);
    expect(
      modelCatalogLines([
        { harness: "opencode", models: [], defaultModel: null, efforts: [], fastCapable: false },
      ]),
    ).toEqual(["opencode  effort none", "  no models listed · the harness picks"]);
  });

  it("keeps the JSON shape the server answered, under a version", () => {
    const parsed: { version: number; harnesses: ReadonlyArray<{ harness: string }> } = JSON.parse(
      modelCatalogJson(catalogs),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.harnesses.map((catalog) => catalog.harness)).toEqual(["claude", "codex"]);
  });
});
