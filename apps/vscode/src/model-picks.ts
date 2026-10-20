import {
  catalogModelLabel,
  modelPicker,
  type HarnessModelCatalogView,
} from "@mend/domain/workbench";

/** One row of the new-session model QuickPick; `model` null sends no model at all. */
export interface ModelPickRow {
  readonly label: string;
  readonly description: string;
  readonly model: string | null;
}

/**
 * The model rows a new session offers, from the server's catalog (docs/models-audit.md). The first
 * is always `default model`, which sends no `--model`: the harness takes the catalog's default, or
 * chooses its own (opencode: its project's or the person's config, then the one it last used,
 * `HARNESSES_CHOOSING_THEIR_OWN_MODEL`). So a model the catalog stops listing can always be left.
 */
export const modelPickRows = (
  catalog: HarnessModelCatalogView,
  harnessName: string,
): ReadonlyArray<ModelPickRow> => [
  {
    label: "default model",
    description:
      catalog.defaultModel === null
        ? `sends no model · ${harnessName}'s own config decides`
        : `sends no model · ${catalogModelLabel(catalog, catalog.defaultModel)} today`,
    model: null,
  },
  ...modelPicker(catalog, { model: null, effort: null })
    .models.toSorted((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .map((option) => ({
      label: option.label,
      description: option.isDefault ? `${option.id} · the catalog's default` : option.id,
      model: option.id,
    })),
];
