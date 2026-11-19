import { defaultWorkspaceImage, MendSettings, WorkspaceImage } from "@mend/domain";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { BuiltInSettings } from "./built-in-settings.ts";

/**
 * Migration 0230 (SLNT-1155, docs/adr/0025-one-home-per-setting.md, decision 5): a project's
 * workspace image becomes its own copy, and an organization's starting image its own. Every value
 * left to follow a level above becomes what it resolved to now, so no session's image changes:
 *
 * - each organization with no image of its own gets a copy of the server's: the instance's settings
 *   document's, else the built-in one for the server's runtime (`BuiltInSettings`, Ubuntu on a Boat
 *   server), exactly what `SettingsRepo.get` answered;
 * - each project with no image of its own gets a copy of its organization's, which by then is set.
 *
 * Both columns are then NOT NULL. The projects column keeps Mend's built-in image as its default
 * for rows inserted by hand (test fixtures); Mend itself always writes the organization's copy.
 */
export const workspaceImageOwnMigration: Effect.Effect<void, SqlError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const builtIn = yield* BuiltInSettings;
    const [stored] = yield* sql<{ readonly value: unknown }>`
      SELECT value FROM settings WHERE key = 'mend'`;
    const instance =
      stored === undefined
        ? builtIn
        : yield* Schema.decodeUnknownEffect(MendSettings)(stored.value).pipe(Effect.orDie);
    const encode = Schema.encodeEffect(WorkspaceImage);
    const serverImage = JSON.stringify(yield* encode(instance.workspaceImage).pipe(Effect.orDie));
    yield* sql`INSERT INTO organization_settings (organization_id, workspace_image)
      SELECT id, ${serverImage}::jsonb FROM organizations
      ON CONFLICT (organization_id) DO NOTHING`;
    yield* sql`UPDATE organization_settings SET workspace_image = ${serverImage}::jsonb
      WHERE workspace_image IS NULL`;
    yield* sql`UPDATE projects SET workspace_image = COALESCE(
        (SELECT organization.workspace_image FROM organization_settings organization
          WHERE organization.organization_id = projects.organization_id),
        ${serverImage}::jsonb)
      WHERE workspace_image IS NULL`;
    yield* sql`ALTER TABLE organization_settings ALTER COLUMN workspace_image SET NOT NULL`;
    const fixtureDefault = JSON.stringify(yield* encode(defaultWorkspaceImage).pipe(Effect.orDie));
    yield* sql.unsafe(`ALTER TABLE projects
      ALTER COLUMN workspace_image SET DEFAULT '${fixtureDefault.replaceAll("'", "''")}'::jsonb,
      ALTER COLUMN workspace_image SET NOT NULL`);
  });
