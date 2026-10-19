import {
  emptyHarnessModelCatalog,
  HARNESS_MODEL_SEED,
  HarnessModel,
  harnessModelCatalog,
  OPENCODE_DEFAULT_MODEL,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { modelPickRows } from "./model-picks.js";

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

describe("the new-session model rows", () => {
  it("lead with default model, which sends no model, for opencode's own choice", () => {
    const rows = modelPickRows(seeded("opencode"), "opencode");
    expect(rows[0]).toEqual({
      label: "default model",
      description: "sends no model · opencode's own config decides",
      model: null,
    });
    expect(rows.slice(1).map((row) => row.model)).toContain(OPENCODE_DEFAULT_MODEL);
    expect(rows.slice(1).some((row) => row.description.includes("default"))).toBe(false);
  });

  it("lead with default model before the catalog's default, which is listed by its id too", () => {
    const rows = modelPickRows(seeded("codex"), "codex");
    expect(rows[0]?.model).toBeNull();
    expect(rows[0]?.label).toBe("default model");
    expect(rows[1]?.model).toBe("gpt-6.1-sol");
    expect(rows[1]?.description).toBe("gpt-6.1-sol · the catalog's default");
    expect(rows.filter((row) => row.model === null)).toHaveLength(1);
  });

  it("offer default model even when the catalog lists nothing", () => {
    expect(modelPickRows(emptyHarnessModelCatalog("pi"), "pi").map((row) => row.model)).toEqual([
      null,
    ]);
  });
});
