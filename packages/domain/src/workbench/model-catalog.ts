import { Schema } from "effect";

import {
  EFFORT_LEVELS,
  FAST_CAPABLE_HARNESSES,
  HARNESS_EFFORTS,
  type EffortLevel,
} from "./harness-launch.ts";

/**
 * The server-owned model catalog (docs/models-audit.md): one list per harness, read by every
 * picker and applied by every launch. No client carries a model id of its own; the phone, the
 * web, the desktop, the CLI and VS Code read `GET /harnesses/models` and offer what it says.
 */

/** One model a harness takes, as the server lists it. `id` is what the harness CLI accepts verbatim. */
export class HarnessModel extends Schema.Class<HarnessModel>("HarnessModel")({
  id: Schema.String,
  label: Schema.String,
  /** The model a launch runs when the request names none; one per harness. */
  isDefault: Schema.Boolean,
  /** The efforts this model takes when fewer than its harness's; null means the harness's. */
  efforts: Schema.NullOr(Schema.Array(Schema.Literals(EFFORT_LEVELS))),
}) {}

/** A harness's model list, with what a picker needs beside it. */
export class HarnessModelCatalog extends Schema.Class<HarnessModelCatalog>("HarnessModelCatalog")({
  harness: Schema.String,
  /** In the order the picker shows them; empty when the harness takes no model flag Mend knows. */
  models: Schema.Array(HarnessModel),
  /** The model a launch runs when none is named; null when the list is empty. */
  defaultModel: Schema.NullOr(Schema.String),
  /** What the harness CLI accepts at all; a model may take fewer. */
  efforts: Schema.Array(Schema.Literals(EFFORT_LEVELS)),
  /** Whether a launch may ask for priority processing. */
  fastCapable: Schema.Boolean,
}) {}

/**
 * The catalog as any reader holds it: the class above, or the same shape read off the wire by a
 * client with no schema runtime (the phone). Every helper below takes this, so a plain JSON
 * answer and a decoded instance are the same thing to the picker.
 */
export interface HarnessModelCatalogView {
  readonly harness: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly isDefault: boolean;
    readonly efforts: ReadonlyArray<EffortLevel> | null;
  }>;
  readonly defaultModel: string | null;
  readonly efforts: ReadonlyArray<EffortLevel>;
  readonly fastCapable: boolean;
}

/** A harness's catalog from its listed models: the default is the one flagged, else the first. */
export const harnessModelCatalog = (
  harness: string,
  models: ReadonlyArray<HarnessModel>,
): HarnessModelCatalog =>
  new HarnessModelCatalog({
    harness,
    models,
    defaultModel: models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null,
    efforts: HARNESS_EFFORTS[harness] ?? EFFORT_LEVELS,
    fastCapable: FAST_CAPABLE_HARNESSES.has(harness),
  });

/** The catalog a harness nobody listed models for gets: no models, the harness's own efforts. */
export const emptyHarnessModelCatalog = (harness: string): HarnessModelCatalog =>
  harnessModelCatalog(harness, []);

/** The efforts to offer for a model: its own when it takes fewer, else the harness's. */
export const catalogEfforts = (
  catalog: HarnessModelCatalogView,
  model: string | null,
): ReadonlyArray<EffortLevel> =>
  catalog.models.find((entry) => entry.id === model)?.efforts ?? catalog.efforts;

/** A model's label when the catalog lists it, else the id as given. */
export const catalogModelLabel = (catalog: HarnessModelCatalogView, model: string): string =>
  catalog.models.find((entry) => entry.id === model)?.label ?? model;

/**
 * An effort the model takes: the one asked for when it does, else the highest it does, so a saved
 * `ultra` sent to claude, or to a codex model that stops at `max`, never fails a launch. Null when
 * none was asked for or the harness takes no effort flag.
 */
export const clampEffort = (
  catalog: HarnessModelCatalogView,
  model: string | null,
  effort: EffortLevel | null | undefined,
): EffortLevel | null => {
  if (effort === undefined || effort === null) return null;
  const taken = catalogEfforts(catalog, model);
  return taken.includes(effort) ? effort : (taken.at(-1) ?? null);
};

/** A launch's model and effort as the server runs and records them. */
export interface ResolvedLaunchOptions {
  /** The model the harness is told to run; null for a harness with no catalog. */
  readonly model: string | null;
  /** The effort passed; null is the harness's own default. */
  readonly effort: EffortLevel | null;
}

const trimmed = (value: string | null | undefined): string | null => {
  const body = value?.trim() ?? "";
  return body === "" ? null : body;
};

/**
 * What a launch runs: the model the request named, else the harness's default from the catalog;
 * the effort clamped to what that model takes. A model the catalog does not list is passed through
 * as named, since harnesses accept ids the list does not know yet.
 */
export const resolveLaunchOptions = (
  catalog: HarnessModelCatalogView,
  requested: {
    readonly model?: string | null | undefined;
    readonly effort?: EffortLevel | null | undefined;
  },
): ResolvedLaunchOptions => {
  const model = trimmed(requested.model) ?? catalog.defaultModel;
  return { model, effort: clampEffort(catalog, model, requested.effort) };
};

// ─── the picker, headless ────────────────────────────────────────────────────

/** A model row as the picker shows it. */
export interface ModelPickerItem {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly selected: boolean;
}

/** An effort row; `effort` null is the harness's own default. */
export interface EffortPickerItem {
  readonly effort: EffortLevel | null;
  readonly label: string;
  readonly selected: boolean;
}

/** What a person last chose for a harness; null means they chose nothing. */
export interface ModelPickerChoice {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
}

/**
 * The picker's state for one harness: what to list, what is selected, and what to send. Built
 * once here; each client only draws it (docs/models-audit.md, decision 7).
 */
export interface ModelPicker {
  /** The effective model: the sticky choice when the catalog still lists it, else the default. */
  readonly model: string | null;
  /** The effective effort: the sticky choice when the model takes it, else the highest it does. */
  readonly effort: EffortLevel | null;
  /** The pill's word: the model's label, the id when unlisted, `model` when there is nothing to pick. */
  readonly modelLabel: string;
  readonly models: ReadonlyArray<ModelPickerItem>;
  /** The harness's default first, then the efforts the effective model takes. */
  readonly efforts: ReadonlyArray<EffortPickerItem>;
  /** Whether there is anything to pick: a harness with no catalog hides the model control. */
  readonly hasModels: boolean;
  readonly fastCapable: boolean;
}

export const modelPicker = (
  catalog: HarnessModelCatalogView,
  choice: ModelPickerChoice,
): ModelPicker => {
  const listed = choice.model !== null && catalog.models.some((entry) => entry.id === choice.model);
  const model = listed ? choice.model : catalog.defaultModel;
  const effort = clampEffort(catalog, model, choice.effort);
  return {
    model,
    effort,
    modelLabel: model === null ? "model" : catalogModelLabel(catalog, model),
    models: catalog.models.map((entry) => ({
      id: entry.id,
      label: entry.label,
      // The one a launch runs when none is named: the flagged row, else the first (`defaultModel`).
      isDefault: entry.id === catalog.defaultModel,
      selected: entry.id === model,
    })),
    efforts: [
      { effort: null, label: "default", selected: effort === null },
      ...catalogEfforts(catalog, model).map((level) => ({
        effort: level,
        label: level,
        selected: effort === level,
      })),
    ],
    hasModels: catalog.models.length > 0,
    fastCapable: catalog.fastCapable,
  };
};

/**
 * The picker before the catalog has answered, or when the server has none to give (an older
 * server, a request that failed): nothing to list, the sticky choice passes through as it is, and
 * the server resolves the default and the clamp. Nothing a person chose is dropped while a request
 * is in flight.
 */
export const pendingModelPicker = (harness: string, choice: ModelPickerChoice): ModelPicker => {
  const catalog = emptyHarnessModelCatalog(harness);
  const effort = clampEffort(catalog, null, choice.effort);
  return {
    model: choice.model,
    effort,
    modelLabel: choice.model ?? "model",
    models: [],
    efforts: [
      { effort: null, label: "default", selected: effort === null },
      ...catalog.efforts.map((level) => ({
        effort: level,
        label: level,
        selected: effort === level,
      })),
    ],
    hasModels: false,
    fastCapable: catalog.fastCapable,
  };
};

/**
 * The picker for one harness out of the server's answer: `undefined` is an answer not yet in
 * (`pendingModelPicker`), a list without the harness is a harness nobody listed models for.
 */
export const modelPickerFor = (
  catalogs: ReadonlyArray<HarnessModelCatalogView> | undefined,
  harness: string,
  choice: ModelPickerChoice,
): ModelPicker =>
  catalogs === undefined
    ? pendingModelPicker(harness, choice)
    : modelPicker(
        catalogs.find((catalog) => catalog.harness === harness) ??
          emptyHarnessModelCatalog(harness),
        choice,
      );

/** The model and effort fields a launch request carries for this picker state; absent means unset. */
export const pickerLaunchFields = (
  picker: Pick<ModelPicker, "model" | "effort">,
): { readonly model?: string; readonly effort?: EffortLevel } => ({
  ...(picker.model === null ? {} : { model: picker.model }),
  ...(picker.effort === null ? {} : { effort: picker.effort }),
});

/**
 * The words a session line carries for the model it runs on: the label when the catalog knows
 * the id, the id otherwise, and the effort when one was chosen. Null when nothing was recorded.
 */
export const sessionModelLine = (
  catalog: HarnessModelCatalogView | null,
  session: { readonly model: string | null; readonly effort: EffortLevel | null },
): string | null => {
  if (session.model === null && session.effort === null) return null;
  const parts: Array<string> = [];
  if (session.model !== null) {
    parts.push(catalog === null ? session.model : catalogModelLabel(catalog, session.model));
  }
  if (session.effort !== null) parts.push(session.effort);
  return parts.join(" · ");
};
