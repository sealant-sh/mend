import { describe, expect, it } from "vitest";

import { HARNESS_MODEL_SEED } from "./harness-launch.ts";
import {
  catalogEfforts,
  emptyHarnessModelCatalog,
  HarnessModel,
  harnessModelCatalog,
  modelPicker,
  modelPickerFor,
  pickerLaunchFields,
  resolveLaunchOptions,
  sessionModelLine,
} from "./model-catalog.ts";

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

describe("harnessModelCatalog", () => {
  it("names the flagged default, the harness's efforts, and whether it goes fast", () => {
    const codex = seeded("codex");
    expect(codex.defaultModel).toBe("gpt-6.1-sol");
    expect(codex.efforts.at(-1)).toBe("ultra");
    expect(codex.fastCapable).toBe(true);
    const claude = seeded("claude");
    expect(claude.defaultModel).toBe("fable");
    expect(claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claude.fastCapable).toBe(false);
  });

  it("falls back to the first model when none is flagged, and to nothing when the list is empty", () => {
    const rows = [
      new HarnessModel({ id: "b", label: "B", isDefault: false, efforts: null }),
      new HarnessModel({ id: "a", label: "A", isDefault: false, efforts: null }),
    ];
    expect(harnessModelCatalog("codex", rows).defaultModel).toBe("b");
    const opencode = emptyHarnessModelCatalog("opencode");
    expect(opencode.defaultModel).toBeNull();
    expect(opencode.efforts).toEqual([]);
    expect(opencode.models).toEqual([]);
  });

  it("offers each model only the efforts it takes", () => {
    const codex = seeded("codex");
    expect(catalogEfforts(codex, "gpt-6.1-sol").at(-1)).toBe("ultra");
    expect(catalogEfforts(codex, "gpt-6-luna").at(-1)).toBe("max");
    expect(catalogEfforts(codex, "gpt-5.5").at(-1)).toBe("xhigh");
    // A model the catalog does not know gets its harness's efforts.
    expect(catalogEfforts(codex, "gpt-7-preview").at(-1)).toBe("ultra");
    expect(catalogEfforts(codex, null).at(-1)).toBe("ultra");
  });
});

describe("resolveLaunchOptions", () => {
  it("applies the harness default when the request names no model", () => {
    expect(resolveLaunchOptions(seeded("claude"), {})).toEqual({ model: "fable", effort: null });
    expect(resolveLaunchOptions(seeded("codex"), { model: "  " })).toEqual({
      model: "gpt-6.1-sol",
      effort: null,
    });
  });

  it("passes a named model through, listed or not", () => {
    expect(resolveLaunchOptions(seeded("claude"), { model: "sonnet", effort: "high" })).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(resolveLaunchOptions(seeded("codex"), { model: "gpt-7-preview" })).toEqual({
      model: "gpt-7-preview",
      effort: null,
    });
  });

  it("clamps the effort to what the resolved model takes", () => {
    expect(resolveLaunchOptions(seeded("codex"), { model: "gpt-5.5", effort: "ultra" })).toEqual({
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(resolveLaunchOptions(seeded("claude"), { effort: "ultra" })).toEqual({
      model: "fable",
      effort: "max",
    });
  });

  it("records nothing for a harness with no catalog, and drops an effort it cannot take", () => {
    expect(resolveLaunchOptions(emptyHarnessModelCatalog("opencode"), { effort: "high" })).toEqual({
      model: null,
      effort: null,
    });
    expect(resolveLaunchOptions(emptyHarnessModelCatalog("shell"), {})).toEqual({
      model: null,
      effort: null,
    });
  });
});

describe("modelPicker", () => {
  it("preselects the server's default when nothing was chosen", () => {
    const picker = modelPicker(seeded("claude"), { model: null, effort: null });
    expect(picker.model).toBe("fable");
    expect(picker.modelLabel).toBe("Fable · latest");
    expect(picker.models.filter((row) => row.selected).map((row) => row.id)).toEqual(["fable"]);
    expect(picker.efforts[0]).toEqual({ effort: null, label: "default", selected: true });
    expect(picker.efforts.map((row) => row.effort)).toEqual([
      null,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(picker.hasModels).toBe(true);
    expect(pickerLaunchFields(picker)).toEqual({ model: "fable" });
  });

  it("keeps a sticky choice the catalog still lists, and clamps its effort", () => {
    const picker = modelPicker(seeded("codex"), { model: "gpt-5.5", effort: "ultra" });
    expect(picker.model).toBe("gpt-5.5");
    expect(picker.effort).toBe("xhigh");
    expect(picker.efforts.filter((row) => row.selected).map((row) => row.effort)).toEqual([
      "xhigh",
    ]);
    expect(pickerLaunchFields(picker)).toEqual({ model: "gpt-5.5", effort: "xhigh" });
  });

  it("marks the model a launch runs as the default, even when no row is flagged", () => {
    const rows = [
      new HarnessModel({ id: "b", label: "B", isDefault: false, efforts: null }),
      new HarnessModel({ id: "a", label: "A", isDefault: false, efforts: null }),
    ];
    const picker = modelPicker(harnessModelCatalog("codex", rows), { model: null, effort: null });
    expect(picker.model).toBe("b");
    expect(picker.models.map((row) => [row.id, row.isDefault])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it("reads a sticky id the catalog no longer lists as the default", () => {
    const picker = modelPicker(seeded("claude"), { model: "claude-fable-5", effort: "high" });
    expect(picker.model).toBe("fable");
    expect(picker.effort).toBe("high");
  });

  it("hides the model control for a harness with nothing to pick", () => {
    const picker = modelPicker(emptyHarnessModelCatalog("opencode"), { model: null, effort: null });
    expect(picker.hasModels).toBe(false);
    expect(picker.modelLabel).toBe("model");
    expect(picker.efforts).toEqual([{ effort: null, label: "default", selected: true }]);
    expect(pickerLaunchFields(picker)).toEqual({});
  });
});

describe("modelPickerFor", () => {
  it("passes the sticky choice through while the server has not answered", () => {
    const picker = modelPickerFor(undefined, "codex", { model: "gpt-5.5", effort: "high" });
    expect(picker.hasModels).toBe(false);
    expect(picker.models).toEqual([]);
    expect(picker.model).toBe("gpt-5.5");
    expect(picker.effort).toBe("high");
    expect(picker.modelLabel).toBe("gpt-5.5");
    expect(picker.fastCapable).toBe(true);
    // The harness's own scale, since no model row can narrow it yet.
    expect(picker.efforts.map((row) => row.effort).at(-1)).toBe("ultra");
    expect(pickerLaunchFields(picker)).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("sends nothing while loading when nothing was chosen, so the server applies its default", () => {
    const picker = modelPickerFor(undefined, "claude", { model: null, effort: null });
    expect(pickerLaunchFields(picker)).toEqual({});
    expect(picker.modelLabel).toBe("model");
  });

  it("picks the harness's catalog out of the server's list once it has answered", () => {
    const catalogs = [seeded("claude"), seeded("codex")];
    expect(modelPickerFor(catalogs, "codex", { model: null, effort: null }).model).toBe(
      "gpt-6.1-sol",
    );
    const unlisted = modelPickerFor(catalogs, "opencode", { model: "x", effort: "high" });
    expect(unlisted.hasModels).toBe(false);
    expect(unlisted.model).toBeNull();
    expect(unlisted.effort).toBeNull();
  });
});

describe("sessionModelLine", () => {
  it("says the model by label and the effort when recorded, and nothing otherwise", () => {
    const claude = seeded("claude");
    expect(sessionModelLine(claude, { model: "fable", effort: "high" })).toBe(
      "Fable · latest · high",
    );
    expect(sessionModelLine(claude, { model: "claude-opus-4", effort: null })).toBe(
      "claude-opus-4",
    );
    expect(sessionModelLine(null, { model: "fable", effort: null })).toBe("fable");
    expect(sessionModelLine(claude, { model: null, effort: null })).toBeNull();
  });
});
