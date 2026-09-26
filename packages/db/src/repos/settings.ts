import { defaultSettings, MendSettings, organizationDefaults } from "@mend/domain";
import type { OrganizationId } from "@mend/domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  organizationSettings as organizationSettingsTable,
  settings as settingsTable,
} from "../schema/workbench.ts";
import { organizationSettingsFromRow } from "./organization-settings.ts";

const decodeSettings = Schema.decodeUnknownEffect(MendSettings);

/**
 * Product settings live as one jsonb row; absence means the defaults. The row is the instance's
 * (the operator's); `forOrganization` is what a project in an organization inherits.
 */
export class SettingsRepo extends Context.Service<
  SettingsRepo,
  {
    /** The instance's settings document, as the operator edits it. */
    readonly get: () => Effect.Effect<MendSettings>;
    /**
     * The defaults every project in the organization inherits: its own values over the
     * instance's (`organizationDefaults`). Launches and automations read this, never `get`.
     */
    readonly forOrganization: (organizationId: OrganizationId) => Effect.Effect<MendSettings>;
    readonly modify: (
      update: (current: MendSettings) => MendSettings,
    ) => Effect.Effect<MendSettings>;
  }
>()("@mend/db/SettingsRepo") {}

export const SettingsRepoLive: Layer.Layer<SettingsRepo, never, MendDB> = Layer.effect(
  SettingsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const get = Effect.fn("SettingsRepo.get")(function* () {
      const [row] = yield* db
        .select({ value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, "mend"))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return defaultSettings;
      return yield* decodeSettings(row.value).pipe(Effect.orDie);
    });

    const modify = Effect.fn("SettingsRepo.modify")(function* (
      update: (current: MendSettings) => MendSettings,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The row may not exist yet, so a row lock alone cannot serialize
            // first-write races. This transaction-scoped lock covers that case.
            yield* tx.execute(sql`select pg_advisory_xact_lock(hashtext('mend:settings'))`);
            const [row] = yield* tx
              .select({ value: settingsTable.value })
              .from(settingsTable)
              .where(eq(settingsTable.key, "mend"))
              .limit(1)
              .for("update");
            const current =
              row === undefined
                ? defaultSettings
                : yield* decodeSettings(row.value).pipe(Effect.orDie);
            const next = update(current);
            const encoded = yield* Schema.encodeEffect(MendSettings)(next).pipe(Effect.orDie);
            yield* tx
              .insert(settingsTable)
              .values({ key: "mend", value: encoded })
              .onConflictDoUpdate({
                target: settingsTable.key,
                set: { value: encoded, updatedAt: new Date() },
              });
            return next;
          }),
        )
        .pipe(Effect.orDie);
    });

    const forOrganization = Effect.fn("SettingsRepo.forOrganization")(function* (
      organizationId: OrganizationId,
    ) {
      const instance = yield* get();
      const [row] = yield* db
        .select()
        .from(organizationSettingsTable)
        .where(eq(organizationSettingsTable.organizationId, organizationId))
        .limit(1)
        .pipe(Effect.orDie);
      return organizationDefaults(instance, yield* organizationSettingsFromRow(row));
    });

    return { get, forOrganization, modify };
  }),
);
