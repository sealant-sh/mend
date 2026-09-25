import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Layer, Redacted, String as Str } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { relations } from "./schema/relations.ts";

/**
 * Postgres owns product state; Sealant owns raw recordings (ARCHITECTURE.md §3).
 * Tables/columns are snake_case; the client transforms to camelCase at the
 * boundary so rows decode straight into domain schemas.
 */
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL").pipe(
    // The dev-compose default; every real deployment sets DATABASE_URL.
    Config.orElse(() => Config.succeed(Redacted.make("postgres://mend:mend@localhost:5434/mend"))),
  ),
  applicationName: Config.succeed("mend"),
  // Mend shares its database server with Sealant, and a small hosted Postgres allows few
  // connections (alpha's allows 50 for both). An unset cap is pg's default of 10 per pool, and
  // Mend holds three pools; say it (docs/SELF-HOSTING.md, "Database connections").
  maxConnections: Config.int("MEND_DATABASE_POOL_MAX").pipe(Config.withDefault(6)),
  transformResultNames: Config.succeed(Str.snakeToCamel),
  transformQueryNames: Config.succeed(Str.camelToSnake),
});

const databaseEffect = PgDrizzle.makeWithDefaults({ relations });

/** Schema-aware Drizzle client over the same Effect PostgreSQL pool used by existing repositories. */
export type MendDatabase = Effect.Success<typeof databaseEffect>;

export class MendDB extends Context.Service<MendDB, MendDatabase>()("@mend/db/MendDB") {}

export const MendDBLive: Layer.Layer<MendDB, never, PgClient.PgClient> = Layer.effect(
  MendDB,
  databaseEffect,
);
