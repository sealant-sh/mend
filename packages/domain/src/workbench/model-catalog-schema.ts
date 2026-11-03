import { Schema } from "effect";

import { EFFORT_LEVELS } from "./harness-launch.ts";
import { harnessCatalogFields } from "./model-catalog.ts";

// The model catalog's Schemas; `./model-catalog.ts` holds the rules a picker reads, free of
// Effect.

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
  /**
   * The model a launch runs when none is named; null when the list is empty, or when the harness
   * chooses its own and no row is flagged (`HARNESSES_CHOOSING_THEIR_OWN_MODEL`).
   */
  defaultModel: Schema.NullOr(Schema.String),
  /** What the harness CLI accepts at all; a model may take fewer. */
  efforts: Schema.Array(Schema.Literals(EFFORT_LEVELS)),
  /** Whether a launch may ask for priority processing. */
  fastCapable: Schema.Boolean,
}) {}

/** A harness's catalog from its listed models (`harnessCatalogFields`). */
export const harnessModelCatalog = (
  harness: string,
  models: ReadonlyArray<HarnessModel>,
): HarnessModelCatalog => new HarnessModelCatalog(harnessCatalogFields(harness, models));

/** The catalog a harness nobody listed models for gets: no models, the harness's own efforts. */
export const emptyHarnessModelCatalog = (harness: string): HarnessModelCatalog =>
  harnessModelCatalog(harness, []);
