import {
  recipeRefusalLine,
  type ServiceDeclarations,
  type ServiceRecipe,
  type SetupDeclaration,
  setupRefusalsOf,
} from "@mend/domain/workbench";

import { type LaunchSpec, recipeLaunch } from "./service-launch.ts";

export interface PlannedRecipe {
  readonly recipe: ServiceRecipe;
  readonly launch: LaunchSpec | null;
}

export type PlanSetup =
  | { readonly _tag: "None" }
  | { readonly _tag: "Declared"; readonly setup: SetupDeclaration }
  | { readonly _tag: "Refused"; readonly line: string };

export type RecipePlan =
  | { readonly _tag: "Refused"; readonly message: string }
  | {
      readonly _tag: "Planned";
      readonly steps: ReadonlyArray<PlannedRecipe>;
      readonly setup: PlanSetup;
    };

/** Dependencies first, depth first in the order each recipe names them, each once, then `name`. */
const walkPlan = (
  name: string,
  runnable: ReadonlyMap<string, ServiceRecipe>,
): ReadonlyArray<ServiceRecipe> | string => {
  const planned = new Map<string, ServiceRecipe>();
  const visiting = new Set<string>();
  const visit = (current: string): string | null => {
    if (planned.has(current)) return null;
    if (visiting.has(current)) return `${current} · its depends form a cycle`;
    const recipe = runnable.get(current);
    if (recipe === undefined) return `No Service recipe named "${current}" exists in this session.`;
    visiting.add(current);
    for (const dependency of recipe.depends) {
      const refused = visit(dependency);
      if (refused !== null) return refused;
    }
    visiting.delete(current);
    planned.set(current, recipe);
    return null;
  };
  return visit(name) ?? [...planned.values()];
};

export const planRecipeStart = (declarations: ServiceDeclarations, name: string): RecipePlan => {
  const recipes = walkPlan(
    name,
    new Map(
      declarations.recipes.flatMap((recipe) =>
        recipe.shadowedBy === null ? [[recipe.name, recipe] as const] : [],
      ),
    ),
  );
  if (typeof recipes === "string") return { _tag: "Refused", message: recipes };
  const steps = recipes.map((recipe) => ({
    recipe,
    launch: recipe.command === null ? null : recipeLaunch({ ...recipe, command: recipe.command }),
  }));
  const refusals = setupRefusalsOf(declarations.refused);
  return {
    _tag: "Planned",
    steps,
    setup: !steps.some((step) => step.launch !== null)
      ? { _tag: "None" }
      : refusals.length > 0
        ? { _tag: "Refused", line: refusals.map(recipeRefusalLine).join("; ") }
        : declarations.setup === null
          ? { _tag: "None" }
          : { _tag: "Declared", setup: declarations.setup },
  };
};
