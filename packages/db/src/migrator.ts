import { Layer } from "effect";
import { Migrator } from "effect/sql";

import { migrations } from "./migrations.ts";

/** Runs pending migrations at boot, inside a transaction, tracked in `mend_migrations`. */
export const MigratorLive = Layer.effectDiscard(
  Migrator.make({})({
    loader: Migrator.fromRecord(migrations),
    table: "mend_migrations",
  }),
);
