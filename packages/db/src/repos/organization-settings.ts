import { OrganizationSettings, WorkspaceImage } from "@mend/domain";
import type { OrganizationId, SessionRuntime } from "@mend/domain";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { organizationSettings as organizationSettingsTable } from "../schema/workbench.ts";
import { BuiltInSettings, readInstanceSettings } from "./instance-settings.ts";

const decodeWorkspaceImage = Schema.decodeUnknownEffect(WorkspaceImage);
const encodeOrganizationSettings = Schema.encodeEffect(OrganizationSettings);

/** One stored row as the domain reads it. */
export const organizationSettingsFromRow = (
  row: typeof organizationSettingsTable.$inferSelect,
): Effect.Effect<OrganizationSettings> =>
  Effect.gen(function* () {
    return new OrganizationSettings({
      workspaceImage: yield* decodeWorkspaceImage(row.workspaceImage).pipe(Effect.orDie),
      autoTour: row.autoTour,
      autoSuggest: row.autoSuggest,
      autoName: row.autoName,
      autoLand: row.autoLand,
      backgroundSessions: row.backgroundSessions,
    });
  });

/**
 * An organization's own values (docs/adr/0003-organizations-and-tenancy.md): its starting image,
 * which each new project copies, and the automation switches the old web app still stores. Owners
 * write them; the routes check that before calling here. An organization's row is written with a
 * copy of the server's image the first time anything asks for it, which `createOrganization` does
 * at creation (docs/adr/0025).
 */
export class OrganizationSettingsRepo extends Context.Service<
  OrganizationSettingsRepo,
  {
    /** The organization's own values; its starting image is always set. */
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
    /**
     * Where the organization's new sessions run, as it chose; null follows the server's default.
     * Kept apart from the values above: its default is the server's offer, not the instance's
     * settings (`sessionRuntimeFor` in `@mend/domain`).
     */
    readonly sessionRuntime: (
      organizationId: OrganizationId,
    ) => Effect.Effect<SessionRuntime | null>;
    /** Set the organization's choice; returns the choice it replaced. */
    readonly setSessionRuntime: (
      organizationId: OrganizationId,
      runtime: SessionRuntime | null,
    ) => Effect.Effect<SessionRuntime | null>;
  }
>()("@mend/db/OrganizationSettingsRepo") {}

export const OrganizationSettingsRepoLive: Layer.Layer<OrganizationSettingsRepo, never, MendDB> =
  Layer.effect(
    OrganizationSettingsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const builtIn = yield* BuiltInSettings;
      const encodeImage = Schema.encodeEffect(WorkspaceImage);
      /**
       * A new row for an organization that has none: a copy of the server's image now, which is
       * what the organization's own starting image is from then on.
       */
      const firstRow = (organizationId: OrganizationId) =>
        Effect.gen(function* () {
          const instance = yield* readInstanceSettings(db, builtIn);
          const workspaceImage = yield* encodeImage(instance.workspaceImage).pipe(Effect.orDie);
          return { organizationId, workspaceImage };
        });

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
        const read = db
          .select()
          .from(organizationSettingsTable)
          .where(eq(organizationSettingsTable.organizationId, organizationId))
          .limit(1)
          .pipe(Effect.orDie);
        const [row] = yield* read;
        if (row !== undefined) return yield* organizationSettingsFromRow(row);
        yield* db
          .insert(organizationSettingsTable)
          .values(yield* firstRow(organizationId))
          .onConflictDoNothing()
          .pipe(Effect.orDie);
        const [written] = yield* read;
        if (written === undefined) return yield* Effect.die("organization settings row missing");
        return yield* organizationSettingsFromRow(written);
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
            set: { ...values, updatedAt: yield* DateTime.nowAsDate },
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
                .values(yield* firstRow(organizationId))
                .onConflictDoNothing();
              const [row] = yield* tx
                .select()
                .from(organizationSettingsTable)
                .where(eq(organizationSettingsTable.organizationId, organizationId))
                .limit(1)
                .for("update");
              if (row === undefined) return yield* Effect.die("organization settings row missing");
              const next = update(yield* organizationSettingsFromRow(row));
              const values = yield* columns(next);
              yield* tx
                .update(organizationSettingsTable)
                .set({ ...values, updatedAt: yield* DateTime.nowAsDate })
                .where(eq(organizationSettingsTable.organizationId, organizationId));
              return next;
            }),
          )
          .pipe(Effect.orDie);
      });

      const sessionRuntime = Effect.fn("OrganizationSettingsRepo.sessionRuntime")(function* (
        organizationId: OrganizationId,
      ) {
        const [row] = yield* db
          .select({ sessionRuntime: organizationSettingsTable.sessionRuntime })
          .from(organizationSettingsTable)
          .where(eq(organizationSettingsTable.organizationId, organizationId))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.sessionRuntime ?? null;
      });

      const setSessionRuntime = Effect.fn("OrganizationSettingsRepo.setSessionRuntime")(function* (
        organizationId: OrganizationId,
        runtime: SessionRuntime | null,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(organizationSettingsTable)
                .values(yield* firstRow(organizationId))
                .onConflictDoNothing();
              const [row] = yield* tx
                .select({ sessionRuntime: organizationSettingsTable.sessionRuntime })
                .from(organizationSettingsTable)
                .where(eq(organizationSettingsTable.organizationId, organizationId))
                .limit(1)
                .for("update");
              yield* tx
                .update(organizationSettingsTable)
                .set({ sessionRuntime: runtime, updatedAt: yield* DateTime.nowAsDate })
                .where(eq(organizationSettingsTable.organizationId, organizationId));
              return row?.sessionRuntime ?? null;
            }),
          )
          .pipe(Effect.orDie);
      });

      return { get, set, modify, sessionRuntime, setSessionRuntime };
    }),
  );
