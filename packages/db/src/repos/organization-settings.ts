import { inheritedOrganizationSettings, OrganizationSettings, WorkspaceImage } from "@mend/domain";
import type { OrganizationId } from "@mend/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { organizationSettings as organizationSettingsTable } from "../schema/workbench.ts";

const decodeWorkspaceImage = Schema.decodeUnknownEffect(WorkspaceImage);
const encodeOrganizationSettings = Schema.encodeEffect(OrganizationSettings);

/** One stored row as the domain reads it; no row is an organization that set nothing. */
export const organizationSettingsFromRow = (
  row: typeof organizationSettingsTable.$inferSelect | undefined,
): Effect.Effect<OrganizationSettings> =>
  Effect.gen(function* () {
    if (row === undefined) return inheritedOrganizationSettings;
    return new OrganizationSettings({
      workspaceImage:
        row.workspaceImage === null
          ? null
          : yield* decodeWorkspaceImage(row.workspaceImage).pipe(Effect.orDie),
      autoTour: row.autoTour,
      autoSuggest: row.autoSuggest,
      autoName: row.autoName,
      autoLand: row.autoLand,
      backgroundSessions: row.backgroundSessions,
    });
  });

/**
 * An organization's own defaults (docs/adr/0003-organizations-and-tenancy.md): what every project
 * in it inherits in place of the instance's, value by value. Owners write them; the routes check
 * that before calling here.
 */
export class OrganizationSettingsRepo extends Context.Service<
  OrganizationSettingsRepo,
  {
    /** The organization's own values; every one null when it set nothing. */
    readonly get: (organizationId: OrganizationId) => Effect.Effect<OrganizationSettings>;
    /** Replace the organization's own values. */
    readonly set: (
      organizationId: OrganizationId,
      settings: OrganizationSettings,
    ) => Effect.Effect<OrganizationSettings>;
    /**
     * Rewrite the latest values under a row lock, so a save that validated slowly never restores
     * a value someone changed meanwhile.
     */
    readonly modify: (
      organizationId: OrganizationId,
      update: (current: OrganizationSettings) => OrganizationSettings,
    ) => Effect.Effect<OrganizationSettings>;
    /** Forget every value: the organization follows the instance again. */
    readonly clear: (organizationId: OrganizationId) => Effect.Effect<void>;
  }
>()("@mend/db/OrganizationSettingsRepo") {}

export const OrganizationSettingsRepoLive: Layer.Layer<OrganizationSettingsRepo, never, MendDB> =
  Layer.effect(
    OrganizationSettingsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const columns = (settings: OrganizationSettings) =>
        encodeOrganizationSettings(settings).pipe(
          Effect.orDie,
          Effect.map((encoded) => ({
            workspaceImage: encoded.workspaceImage,
            autoTour: encoded.autoTour,
            autoSuggest: encoded.autoSuggest,
            autoName: encoded.autoName,
            autoLand: encoded.autoLand,
            backgroundSessions: encoded.backgroundSessions,
          })),
        );

      const get = Effect.fn("OrganizationSettingsRepo.get")(function* (
        organizationId: OrganizationId,
      ) {
        const [row] = yield* db
          .select()
          .from(organizationSettingsTable)
          .where(eq(organizationSettingsTable.organizationId, organizationId))
          .limit(1)
          .pipe(Effect.orDie);
        return yield* organizationSettingsFromRow(row);
      });

      const set = Effect.fn("OrganizationSettingsRepo.set")(function* (
        organizationId: OrganizationId,
        settings: OrganizationSettings,
      ) {
        const values = yield* columns(settings);
        yield* db
          .insert(organizationSettingsTable)
          .values({ organizationId, ...values })
          .onConflictDoUpdate({
            target: organizationSettingsTable.organizationId,
            set: { ...values, updatedAt: new Date() },
          })
          .pipe(Effect.orDie);
        return settings;
      });

      const modify = Effect.fn("OrganizationSettingsRepo.modify")(function* (
        organizationId: OrganizationId,
        update: (current: OrganizationSettings) => OrganizationSettings,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // The row may not exist yet; creating it first gives the row lock something to hold.
              yield* tx
                .insert(organizationSettingsTable)
                .values({ organizationId })
                .onConflictDoNothing();
              const [row] = yield* tx
                .select()
                .from(organizationSettingsTable)
                .where(eq(organizationSettingsTable.organizationId, organizationId))
                .limit(1)
                .for("update");
              const next = update(yield* organizationSettingsFromRow(row));
              const values = yield* columns(next);
              yield* tx
                .update(organizationSettingsTable)
                .set({ ...values, updatedAt: new Date() })
                .where(eq(organizationSettingsTable.organizationId, organizationId));
              return next;
            }),
          )
          .pipe(Effect.orDie);
      });

      const clear = Effect.fn("OrganizationSettingsRepo.clear")(function* (
        organizationId: OrganizationId,
      ) {
        yield* db
          .delete(organizationSettingsTable)
          .where(eq(organizationSettingsTable.organizationId, organizationId))
          .pipe(Effect.orDie);
      });

      return { get, set, modify, clear };
    }),
  );
