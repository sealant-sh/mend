/**
 * `mend models`: the server-owned model catalog (docs/models-audit.md), one block per harness. The
 * CLI ships dependency-free and passes `--model <id>` through as text; this is where a terminal
 * sees which ids the server lists, which one a launch runs when none is named, and the efforts
 * each takes.
 */

/** One harness's catalog, as `GET /harnesses/models` answers it. */
export interface HarnessModelCatalogDto {
  readonly harness: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly isDefault: boolean;
    readonly efforts: ReadonlyArray<string> | null;
  }>;
  readonly defaultModel: string | null;
  readonly efforts: ReadonlyArray<string>;
  readonly fastCapable: boolean;
}

/** Whether `efforts` is one unbroken run of `scale`, so `first … last` names every level in it. */
const contiguousIn = (efforts: ReadonlyArray<string>, scale: ReadonlyArray<string>): boolean => {
  const from = scale.indexOf(efforts[0] ?? "");
  return from >= 0 && efforts.every((effort, index) => scale[from + index] === effort);
};

/**
 * `low … max` when the levels run without a gap in the harness's scale; the full list when they
 * do not, so `low, high, max` never reads as `low … max`.
 */
const effortRange = (efforts: ReadonlyArray<string>, scale: ReadonlyArray<string>): string =>
  efforts.length === 0
    ? "none"
    : efforts.length <= 2 || !contiguousIn(efforts, scale)
      ? efforts.join(", ")
      : `${efforts[0]} … ${efforts.at(-1)}`;

/**
 * The lines `mend models` prints: each harness, then one row per model with its id first (what
 * `--model` takes), its label, `default` on the one a launch runs when none is named, and the
 * efforts where a model takes fewer than its harness. `dim` paints the quiet parts.
 */
export const modelCatalogLines = (
  catalogs: ReadonlyArray<HarnessModelCatalogDto>,
  dim: (text: string) => string = (text) => text,
): ReadonlyArray<string> => {
  if (catalogs.length === 0)
    return ["no models listed · the server's harness_models table is empty"];
  const lines: Array<string> = [];
  for (const [index, catalog] of catalogs.entries()) {
    if (index > 0) lines.push("");
    const efforts = effortRange(catalog.efforts, catalog.efforts);
    lines.push(
      `${catalog.harness}  ${dim(`effort ${efforts}${catalog.fastCapable ? " · --fast" : ""}`)}`,
    );
    const idWidth = Math.max(...catalog.models.map((model) => model.id.length));
    for (const model of catalog.models) {
      const facts: Array<string> = [];
      // The one a launch runs when none is named: what the server resolved, flag or first row.
      if (model.id === catalog.defaultModel) facts.push("default");
      if (model.efforts !== null) {
        facts.push(`effort ${effortRange(model.efforts, catalog.efforts)}`);
      }
      lines.push(
        `  ${model.id.padEnd(idWidth)}  ${model.label}${facts.length === 0 ? "" : `  ${dim(facts.join(" · "))}`}`,
      );
    }
    if (catalog.models.length === 0) lines.push(`  ${dim("no models listed · the harness picks")}`);
  }
  return lines;
};

/** `mend models --json`: the catalog as the server answered it, for scripts (`printJson`). */
export const modelCatalogJson = (catalogs: ReadonlyArray<HarnessModelCatalogDto>) => ({
  version: 1,
  harnesses: catalogs,
});
