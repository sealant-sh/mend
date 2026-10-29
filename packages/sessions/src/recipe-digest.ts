import {
  RecipeSpec,
  type ServiceDeclarations,
  type ServiceRecipe,
  type SetupDeclaration,
} from "@mend/domain/workbench";

import { sha256Hex } from "./setup.ts";

type Canonical = string | null | ReadonlyArray<Canonical> | { readonly [key: string]: Canonical };

export const canonicalJson = (value: Canonical): string => {
  if (value === null || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
};

export const RECIPE_DIGEST_PREFIX = "mend-recipe/v1\0";

/**
 * ADR 0017, decision log 4. Each dependency counts by its own digest, so that editing `db`'s
 * command changes the digest of a `web` that depends on it.
 */
export const recipeDigest = (input: {
  readonly command: string | null;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly dependencyDigests: ReadonlyArray<string>;
  readonly setup: SetupDeclaration | null;
}): string =>
  sha256Hex(
    RECIPE_DIGEST_PREFIX +
      canonicalJson({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        depends: input.dependencyDigests,
        setup: input.setup === null ? null : { run: input.setup.run, inputs: input.setup.inputs },
      }),
  );

const setupOf = (recipe: ServiceRecipe, setup: SetupDeclaration | null) =>
  recipe.command === null ? null : setup;

export const recipeDigestsOf = (declarations: ServiceDeclarations): ReadonlyMap<string, string> => {
  const runnable = new Map(
    declarations.recipes.flatMap((recipe) =>
      recipe.shadowedBy === null ? [[recipe.name, recipe] as const] : [],
    ),
  );
  const digests = new Map<string, string>();
  const visiting = new Set<string>();
  const digestOf = (recipe: ServiceRecipe): string | undefined => {
    const known = digests.get(recipe.name);
    if (known !== undefined || visiting.has(recipe.name)) return known;
    visiting.add(recipe.name);
    const dependencyDigests: string[] = [];
    for (const name of recipe.depends) {
      const dependency = runnable.get(name);
      const digest = dependency === undefined ? undefined : digestOf(dependency);
      if (digest === undefined) return undefined;
      dependencyDigests.push(digest);
    }
    const digest = recipeDigest({
      command: recipe.command,
      cwd: recipe.cwd,
      env: recipe.env,
      dependencyDigests,
      setup: setupOf(recipe, declarations.setup),
    });
    digests.set(recipe.name, digest);
    return digest;
  };
  for (const recipe of runnable.values()) digestOf(recipe);
  return digests;
};

export const recipeSpecOf = (
  recipe: ServiceRecipe,
  setup: SetupDeclaration | null,
  digests: ReadonlyMap<string, string>,
): RecipeSpec | null => {
  if (recipe.command === null) return null;
  const depends: Array<{ readonly name: string; readonly digest: string }> = [];
  for (const name of recipe.depends) {
    const digest = digests.get(name);
    if (digest === undefined) return null;
    depends.push({ name, digest });
  }
  return new RecipeSpec({
    argv: ["sh", "-c", recipe.command],
    cwd: recipe.cwd,
    env: recipe.env,
    depends,
    setup: setupOf(recipe, setup),
  });
};
