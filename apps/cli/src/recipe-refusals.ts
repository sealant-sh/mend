import { recipeChangedLine, resourceProposalsSection } from "@mend/domain/workbench";

/** One refusal of `GET /sessions/:id/declarations`: the recipe, the key it names, and why. */
export interface RecipeRefusalDto {
  readonly name: string | null;
  readonly key: string;
  readonly message: string;
}

/** The parts of `GET /sessions/:id/declarations` the CLI reads; a server before 0.37 has none. */
export interface ServiceDeclarationsDto {
  readonly refused: ReadonlyArray<RecipeRefusalDto>;
  readonly ignored: ReadonlyArray<{ readonly name: string | null; readonly key: string }>;
}

const recipeLine = (
  name: string,
  declared: ReadonlyArray<{ readonly name: string }>,
  declarations: ServiceDeclarationsDto | null,
): string => {
  const refusals = (declarations?.refused ?? []).filter((refusal) => refusal.name === name);
  if (refusals.length > 0) {
    return `${name} is refused by mend.toml · ${refusals
      .map((refusal) => `${refusal.key} ${refusal.message}`)
      .join(" · ")}`;
  }
  return declared.length === 0
    ? `no mend.toml recipes in this worktree — declare [service.${name}] first`
    : `no recipe named "${name}" — declared: ${declared.map((entry) => entry.name).join(", ")}`;
};

export const missingRecipeLine = (
  name: string,
  declared: ReadonlyArray<{ readonly name: string }>,
  declarations: ServiceDeclarationsDto | null,
): string =>
  [
    recipeLine(name, declared, declarations),
    ...(declarations === null ? [] : resourceProposalsSection(declarations)),
  ].join("\n");

export const approvedVersionLine = (view: {
  readonly service: { readonly name: string };
  readonly approvedVersion?: boolean;
}): string | null => (view.approvedVersion === true ? recipeChangedLine(view.service.name) : null);
