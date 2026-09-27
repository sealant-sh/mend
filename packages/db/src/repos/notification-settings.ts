import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from "@mend/domain/workbench";
import { inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userNotificationSettings } from "../schema/workbench.ts";

/**
 * What each person hears about on their phones (packages/jobs/src/session-notifier.ts). Per
 * account, like the git author: an account with no saved row hears the defaults.
 */
export class NotificationSettingsRepo extends Context.Service<
  NotificationSettingsRepo,
  {
    /** The account's settings, or the defaults when it saved none. */
    readonly forUser: (userId: string) => Effect.Effect<NotificationSettings>;
    /** Every account's settings, keyed by user id; an account with none saved gets the defaults. */
    readonly forUsers: (
      userIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, NotificationSettings>>;
    /** Save the account's settings whole, and answer them. */
    readonly set: (
      userId: string,
      settings: NotificationSettings,
    ) => Effect.Effect<NotificationSettings>;
  }
>()("@mend/db/NotificationSettingsRepo") {}

const selected = {
  userId: userNotificationSettings.userId,
  slackSessions: userNotificationSettings.slackSessions,
  turnFinished: userNotificationSettings.turnFinished,
  needsInput: userNotificationSettings.needsInput,
  failed: userNotificationSettings.failed,
};

const toSettings = (row: {
  readonly slackSessions: boolean;
  readonly turnFinished: boolean;
  readonly needsInput: boolean;
  readonly failed: boolean;
}): NotificationSettings =>
  new NotificationSettings({
    slackSessions: row.slackSessions,
    turnFinished: row.turnFinished,
    needsInput: row.needsInput,
    failed: row.failed,
  });

export const NotificationSettingsRepoLive: Layer.Layer<NotificationSettingsRepo, never, MendDB> =
  Layer.effect(
    NotificationSettingsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const forUsers = Effect.fn("NotificationSettingsRepo.forUsers")(function* (
        userIds: ReadonlyArray<string>,
      ) {
        const settings = new Map<string, NotificationSettings>(
          userIds.map((userId) => [userId, DEFAULT_NOTIFICATION_SETTINGS]),
        );
        if (userIds.length === 0) return settings;
        const rows = yield* db
          .select(selected)
          .from(userNotificationSettings)
          .where(inArray(userNotificationSettings.userId, [...userIds]))
          .pipe(Effect.orDie);
        for (const row of rows) settings.set(row.userId, toSettings(row));
        return settings;
      });

      const forUser = Effect.fn("NotificationSettingsRepo.forUser")(function* (userId: string) {
        const settings = yield* forUsers([userId]);
        return settings.get(userId) ?? DEFAULT_NOTIFICATION_SETTINGS;
      });

      const set = Effect.fn("NotificationSettingsRepo.set")(function* (
        userId: string,
        settings: NotificationSettings,
      ) {
        const values = {
          slackSessions: settings.slackSessions,
          turnFinished: settings.turnFinished,
          needsInput: settings.needsInput,
          failed: settings.failed,
        };
        const [row] = yield* db
          .insert(userNotificationSettings)
          .values({ userId, ...values })
          .onConflictDoUpdate({
            target: userNotificationSettings.userId,
            set: { ...values, updatedAt: new Date() },
          })
          .returning(selected)
          .pipe(Effect.orDie);
        if (row === undefined)
          return yield* Effect.die("notification settings upsert returned no row");
        return toSettings(row);
      });

      return { forUser, forUsers, set };
    }),
  );
