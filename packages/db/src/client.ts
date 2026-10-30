// The shim is an ambient declaration, which an import cannot load; it rides with this module into
// every program that compiles the db package.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./drizzle-effect-sql-error.d.ts" />
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Layer, Redacted, String as Str } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { guardListens } from "./events.ts";
import { relations } from "./schema/relations.ts";

/**
 * Postgres owns product state; Sealant owns raw recordings (ARCHITECTURE.md §3).
 * Tables/columns are snake_case; the client transforms to camelCase at the
 * boundary so rows decode straight into domain schemas.
 */
/** MEND_DATABASE_POOL_MAX when unset: the connections one Mend pool may hold. */
export const DEFAULT_POOL_MAX = 6;

/** Every LISTEN on the pool is counted, and none may take its last connection (`guardListens`). */
export const ListenGuardLive: Layer.Layer<never, never, PgClient.PgClient> = Layer.effectDiscard(
  Effect.flatMap(PgClient.PgClient, (sql) => Effect.sync(() => guardListens(sql))),
);

const PgPoolLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL").pipe(
    // The dev-compose default; every real deployment sets DATABASE_URL.
    Config.orElse(() => Config.succeed(Redacted.make("postgres://mend:mend@localhost:5434/mend"))),
  ),
  applicationName: Config.succeed("mend"),
  // Mend shares its database server with Sealant, and a small hosted Postgres allows few
  // connections (alpha's allows 50 for both). An unset cap is the client's default of 10 per pool,
  // and Mend holds three pools; say it (docs/SELF-HOSTING.md, "Database connections").
  maxConnections: Config.Int("MEND_DATABASE_POOL_MAX").pipe(Config.withDefault(DEFAULT_POOL_MAX)),
  transformResultNames: Config.succeed(Str.snakeToCamel),
  transformQueryNames: Config.succeed(Str.camelToSnake),
});

export const PgLive = ListenGuardLive.pipe(Layer.provideMerge(PgPoolLive));

const databaseEffect = PgDrizzle.makeWithDefaults({ relations });

/** Schema-aware Drizzle client over the same Effect PostgreSQL pool used by existing repositories. */
export type MendDatabase = Effect.Success<typeof databaseEffect>;

export class MendDB extends Context.Service<MendDB, MendDatabase>()("@mend/db/MendDB") {}

export const MendDBLive: Layer.Layer<MendDB, never, PgClient.PgClient> = Layer.effect(
  MendDB,
  databaseEffect,
);
