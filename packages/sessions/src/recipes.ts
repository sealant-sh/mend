import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ServiceRecipe } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { parse as parseToml } from "smol-toml";

/**
 * Declared Services (docs/SESSION-SERVICES.md): the repo's `mend.toml`,
 * read from the SESSION's worktree copy — so an agent can add a recipe as
 * part of its change and it reviews like any other edit. A missing file is
 * an empty declaration set; a malformed one is a typed error naming the
 * problem, never a guess.
 *
 * ```toml
 * [service.web]
 * command = "pnpm dev"
 * port = 3000
 *
 * [service.db]
 * # no command: an already-listening port to adopt
 * port = 5432
 * ```
 */

export const MEND_TOML = "mend.toml";

/** Directory-, shell-, and URL-safe recipe names; also the CLI lookup key. */
export const RECIPE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class RecipeFileError extends Schema.TaggedErrorClass<RecipeFileError>()("RecipeFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * File + project recipes as ONE declaration set. Collisions are refused at
 * write time (the web checks before creating); if one exists anyway, the
 * file wins — it travels with the repo and reviews like code.
 */
export const mergeRecipes = (
  file: ReadonlyArray<ServiceRecipe>,
  project: ReadonlyArray<ServiceRecipe>,
): ReadonlyArray<ServiceRecipe> => {
  const fileNames = new Set(file.map((recipe) => recipe.name));
  return [
    ...file,
    ...project.map((recipe) =>
      fileNames.has(recipe.name) ? new ServiceRecipe({ ...recipe, shadowedBy: "file" }) : recipe,
    ),
  ];
};

/** Read and validate the worktree's declared Services. Missing file = none. */
export const readServiceRecipes = (
  worktree: string,
): Effect.Effect<ReadonlyArray<ServiceRecipe>, RecipeFileError> =>
  Effect.gen(function* () {
    const filePath = path.join(worktree, MEND_TOML);
    const raw = yield* Effect.tryPromise({
      try: () => fs.readFile(filePath, "utf8"),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (raw === null) {
      return [];
    }
    return yield* parseServiceRecipes(raw, filePath);
  });

/**
 * Validate `mend.toml` text wherever it was read from — the co-located worktree, or the
 * session's live workspace when Mend is not beside the files. `filePath` only names the file in
 * the error.
 */
export const parseServiceRecipes = (
  raw: string,
  filePath: string,
): Effect.Effect<ReadonlyArray<ServiceRecipe>, RecipeFileError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = parseToml(raw);
    } catch (cause) {
      return yield* new RecipeFileError({
        path: filePath,
        message: `mend.toml is not valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    if (!isRecord(parsed)) {
      return [];
    }
    const services = parsed["service"];
    if (services === undefined) {
      return [];
    }
    if (!isRecord(services)) {
      return yield* new RecipeFileError({
        path: filePath,
        message: `"service" must be a table of recipes ([service.<name>]).`,
      });
    }

    const recipes: ServiceRecipe[] = [];
    for (const [name, entry] of Object.entries(services)) {
      if (!RECIPE_NAME.test(name)) {
        return yield* new RecipeFileError({
          path: filePath,
          message: `"${name}" is not a usable Service name (lowercase letters, digits, ".", "_", "-").`,
        });
      }
      if (!isRecord(entry)) {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}] must be a table.`,
        });
      }
      const port = entry["port"];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}] needs a port in 1..65535.`,
        });
      }
      const command = entry["command"];
      if (command !== undefined && (typeof command !== "string" || command.trim() === "")) {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}].command must be a non-empty shell command when present.`,
        });
      }
      const protocol = entry["protocol"];
      if (protocol !== undefined && protocol !== "tcp" && protocol !== "udp") {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}].protocol must be "tcp" or "udp" when present.`,
        });
      }
      const browserScheme = entry["browserScheme"];
      if (browserScheme !== undefined && browserScheme !== "http" && browserScheme !== "https") {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}].browserScheme must be "http" or "https" when present.`,
        });
      }
      if (protocol === "udp" && browserScheme !== undefined) {
        return yield* new RecipeFileError({
          path: filePath,
          message: `[service.${name}] cannot declare browserScheme for UDP.`,
        });
      }
      recipes.push(
        new ServiceRecipe({
          name,
          command: command === undefined ? null : command.trim(),
          port,
          protocol: protocol ?? "tcp",
          browserScheme: browserScheme ?? null,
          source: "file",
          shadowedBy: null,
        }),
      );
    }
    return recipes;
  });
