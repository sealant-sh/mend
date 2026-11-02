import { inheritedPersonSettings, PersonSettings } from "@mend/domain";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userAutomationSettings } from "../schema/workbench.ts";

/** One stored row as the domain reads it; no row is a person who chose nothing. */
export const personSettingsFromRow = (
  row: typeof userAutomationSettings.$inferSelect | undefined,
): PersonSettings =>
  row === undefined
    ? inheritedPersonSettings
    : new PersonSettings({
        autoTour: row.autoTour,
        autoSuggest: row.autoSuggest,
        autoName: row.autoName,
        autoLand: row.autoLand,
        backgroundSessions: row.backgroundSessions,
      });

/**
 * A person's own automation switches (`PersonSettings`): what their sessions get in place of their
 * organization's defaults, switch by switch. Only the person writes their own.
 */
export class PersonSettingsRepo extends Context.Service<
  PersonSettingsRepo,
  {
    /** The person's own values; every one null when they chose nothing. */
    readonly forUser: (userId: string) => Effect.Effect<PersonSettings>;
    /** Replace the person's own values. */
    readonly set: (userId: string, settings: PersonSettings) => Effect.Effect<PersonSettings>;
  }
>()("@mend/db/PersonSettingsRepo") {}

const make: Effect.Effect<PersonSettingsRepo["Service"], never, MendDB> = Effect.gen(function* () {
  const db = yield* MendDB;
  return {
    forUser: Effect.fn("PersonSettingsRepo.forUser")(function* (userId: string) {
      const [row] = yield* db
        .select()
        .from(userAutomationSettings)
        .where(eq(userAutomationSettings.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      return personSettingsFromRow(row);
    }),
    set: Effect.fn("PersonSettingsRepo.set")(function* (userId: string, settings: PersonSettings) {
      const values = {
        autoTour: settings.autoTour,
        autoSuggest: settings.autoSuggest,
        autoName: settings.autoName,
        autoLand: settings.autoLand,
        backgroundSessions: settings.backgroundSessions,
      };
      const [row] = yield* db
        .insert(userAutomationSettings)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userAutomationSettings.userId,
          set: { ...values, updatedAt: yield* DateTime.nowAsDate },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("person settings upsert returned no row");
      return personSettingsFromRow(row);
    }),
  };
});

export const PersonSettingsRepoLive: Layer.Layer<PersonSettingsRepo, never, MendDB> = Layer.effect(
  PersonSettingsRepo,
  make,
);
