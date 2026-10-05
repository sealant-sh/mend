import {
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
  it("lead with opencode's own choice, which sends no model, then its catalog", () => {
    const rows = modelPickRows(seeded("opencode"), "opencode");
    expect(rows[0]).toEqual({
      label: "opencode's own choice",
      description: "default · its own config decides",
      model: null,
    });
    expect(rows.slice(1).map((row) => row.model)).toContain(OPENCODE_DEFAULT_MODEL);
    expect(rows.slice(1).some((row) => row.description.includes("default"))).toBe(false);
  });

  it("lead with the catalog's default for a harness that has one, with no own-choice row", () => {
    const rows = modelPickRows(seeded("codex"), "codex");
    expect(rows[0]?.model).toBe("gpt-6.1-sol");
    expect(rows[0]?.description).toBe("gpt-6.1-sol · default");
    expect(rows.some((row) => row.model === null)).toBe(false);
  });
});
