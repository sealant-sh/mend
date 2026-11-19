import {
  MendSettings,
  newOrganizationSettings,
  organizationDefaults,
  personDefaults,
} from "@mend/domain";
import type { OrganizationId } from "@mend/domain";
import { eq, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  organizationSettings as organizationSettingsTable,
  settings as settingsTable,
  userAutomationSettings,
} from "../schema/workbench.ts";
import { BuiltInSettings, readInstanceSettings } from "./instance-settings.ts";
import { organizationSettingsFromRow } from "./organization-settings.ts";
import { personSettingsFromRow } from "./person-settings.ts";

export { BuiltInSettings } from "./instance-settings.ts";

const decodeSettings = Schema.decodeUnknownEffect(MendSettings);

/**
 * Product settings live as one jsonb row; absence means the built-in ones (`BuiltInSettings`). The row is the instance's
 * (the operator's); `forOrganization` is what a project in an organization inherits, and
 * `forPerson` what one person's sessions in it get.
 */
export class SettingsRepo extends Context.Service<
  SettingsRepo,
  {
    /** The instance's settings document, as the operator edits it. */
    readonly get: () => Effect.Effect<MendSettings>;
    /**
     * The organization's values over the instance's (`organizationDefaults`): its own starting
     * image, and the instance's queue-era values. Launches read a project's own image, not this.
     */
    readonly forOrganization: (organizationId: OrganizationId) => Effect.Effect<MendSettings>;
    /**
     * What one person's sessions get: their organization's environment, with every automation
     * switch (naming, review passes, landing, background) from the person's own row
     * (`personDefaults`). Null, a session with no owner, gets Mend's default switches. The
     * organization's and the instance's own switches are never read here.
     */
    readonly forPerson: (
      organizationId: OrganizationId,
      userId: string | null,
    ) => Effect.Effect<MendSettings>;
    readonly modify: (
      update: (current: MendSettings) => MendSettings,
    ) => Effect.Effect<MendSettings>;
  }
>()("@mend/db/SettingsRepo") {}

export const SettingsRepoLive: Layer.Layer<SettingsRepo, never, MendDB> = Layer.effect(
  SettingsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const builtIn = yield* BuiltInSettings;

    const get = Effect.fn("SettingsRepo.get")(function* () {
      return yield* readInstanceSettings(db, builtIn);
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
              row === undefined ? builtIn : yield* decodeSettings(row.value).pipe(Effect.orDie);
            const next = update(current);
            const encoded = yield* Schema.encodeEffect(MendSettings)(next).pipe(Effect.orDie);
            yield* tx
              .insert(settingsTable)
              .values({ key: "mend", value: encoded })
              .onConflictDoUpdate({
                target: settingsTable.key,
                set: { value: encoded, updatedAt: yield* DateTime.nowAsDate },
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
      // Every organization has a row since migration 0230; one made since and not yet read has
      // none until `OrganizationSettingsRepo` writes its copy, which would be this image.
      return organizationDefaults(
        instance,
        row === undefined
          ? newOrganizationSettings(instance.workspaceImage)
          : yield* organizationSettingsFromRow(row),
      );
    });

    const forPerson = Effect.fn("SettingsRepo.forPerson")(function* (
      organizationId: OrganizationId,
      userId: string | null,
    ) {
      const organization = yield* forOrganization(organizationId);
      if (userId === null) return personDefaults(organization, null);
      const [row] = yield* db
        .select()
        .from(userAutomationSettings)
        .where(eq(userAutomationSettings.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      return personDefaults(organization, personSettingsFromRow(row));
    });

    return { get, forOrganization, forPerson, modify };
  }),
);
