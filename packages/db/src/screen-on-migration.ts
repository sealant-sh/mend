import {
  defaultWorkspaceImage,
  defaultWorkspacePackages,
  imageHasScreen,
  WorkspaceImage,
} from "@mend/domain";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { BuiltInSettings } from "./built-in-settings.ts";

/**
 * Migration 0234 (SLNT-1201): the agent's screen is on by default. Mend's built-in image now has
 * it, so new servers, organizations and projects start with one. A saved image says `screen:
 * false` both where someone turned the screen off and where it only took the old default, and
 * Mend can't tell those apart. It takes an image nobody edited as one that took the default: a
 * family image with Mend's default packages and shell and no screen, on any OS family and with or
 * without Docker, because Mend picks those two itself for the runtime. Those get the screen; every
 * image someone changed keeps what it says. The instance's own document, every organization's
 * starting image and every project's image are read the same way.
 *
 * A server whose built-in image has no screen (not x86_64, `builtInSettingsFor`) changes no image.
 * The projects column's default, which only rows inserted by hand use, becomes the new built-in.
 */
export const screenOnMigration: Effect.Effect<void, SqlError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const builtIn = yield* BuiltInSettings;
    const encoded = yield* Schema.encodeEffect(WorkspaceImage)(defaultWorkspaceImage).pipe(
      Effect.orDie,
    );
    const fixtureDefault = JSON.stringify(encoded).replaceAll("'", "''");
    yield* sql.unsafe(`ALTER TABLE projects
      ALTER COLUMN workspace_image SET DEFAULT '${fixtureDefault}'::jsonb`);
    if (!imageHasScreen(builtIn.workspaceImage)) return;

    const packages = JSON.stringify(defaultWorkspacePackages);
    yield* sql`UPDATE projects
      SET workspace_image = jsonb_set(workspace_image, '{screen}', 'true'::jsonb)
      WHERE COALESCE(workspace_image->>'mode', 'family') = 'family'
        AND COALESCE(workspace_image->'screen', 'false'::jsonb) = 'false'::jsonb
        AND workspace_image->'packages' = ${packages}::jsonb
        AND workspace_image->>'shell' = 'zsh'`;
    yield* sql`UPDATE organization_settings
      SET workspace_image = jsonb_set(workspace_image, '{screen}', 'true'::jsonb)
      WHERE COALESCE(workspace_image->>'mode', 'family') = 'family'
        AND COALESCE(workspace_image->'screen', 'false'::jsonb) = 'false'::jsonb
        AND workspace_image->'packages' = ${packages}::jsonb
        AND workspace_image->>'shell' = 'zsh'`;
    yield* sql`UPDATE settings
      SET value = jsonb_set(value, '{workspaceImage,screen}', 'true'::jsonb)
      WHERE key = 'mend'
        AND COALESCE(value->'workspaceImage'->>'mode', 'family') = 'family'
        AND COALESCE(value->'workspaceImage'->'screen', 'false'::jsonb) = 'false'::jsonb
        AND value->'workspaceImage'->'packages' = ${packages}::jsonb
        AND value->'workspaceImage'->>'shell' = 'zsh'`;
  },
);
