import { modelPicker, type HarnessModelCatalogView } from "@mend/domain/workbench";

/** One row of the new-session model QuickPick; `model` null sends no model at all. */
export interface ModelPickRow {
  readonly label: string;
  readonly description: string;
  readonly model: string | null;
}

/**
 * The model rows a new session offers, from the server's catalog (docs/models-audit.md), the one a
 * plain Enter takes first. A harness whose catalog names a default leads with it. One that names
 * none chooses its own model (opencode: its project's or the person's config, then the one it last
 * used, `HARNESSES_CHOOSING_THEIR_OWN_MODEL`), so its own choice leads and sends no `--model`, which
 * would beat that config.
 */
export const modelPickRows = (
  catalog: HarnessModelCatalogView,
  harnessName: string,
): ReadonlyArray<ModelPickRow> => {
  const listed = modelPicker(catalog, { model: null, effort: null })
    .models.toSorted((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .map((option) => ({
      label: option.label,
      description: option.isDefault ? `${option.id} · default` : option.id,
      model: option.id,
    }));
  if (catalog.defaultModel !== null) return listed;
  return [
    {
      label: `${harnessName}'s own choice`,
      description: "default · its own config decides",
      model: null,
    },
    ...listed,
  ];
};
