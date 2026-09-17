import { and, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { pushDevices } from "../schema/workbench.ts";

export class PushDevice extends Schema.Class<PushDevice>("PushDevice")({
  token: Schema.String,
  platform: Schema.String,
  userId: Schema.String,
}) {}

/**
 * Phones registered for push notifications (Expo push tokens), each belonging to the account that
 * registered it (docs/adr/0003-organizations-and-tenancy.md). The token is the identity:
 * registering again refreshes `last_seen_at` and moves the phone to whoever registered it last,
 * and a token the push service reports as dead is removed.
 */
export class PushDevicesRepo extends Context.Service<
  PushDevicesRepo,
  {
    readonly register: (
      userId: string,
      token: string,
      platform: string,
    ) => Effect.Effect<PushDevice>;
    /** The devices of these accounts only; notifications never go to everyone. */
    readonly listForUsers: (
      userIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PushDevice>>;
    /** Prune a token the push service reported dead, whoever it belongs to. */
    readonly remove: (token: string) => Effect.Effect<void>;
    /** Unregister the caller's own device; another account's token is left untouched. */
    readonly removeOwned: (userId: string, token: string) => Effect.Effect<void>;
    /** Drop every phone of an account that lost access. */
    readonly removeAllForUser: (userId: string) => Effect.Effect<void>;
  }
>()("@mend/db/PushDevicesRepo") {}

const selectedDevice = {
  token: pushDevices.token,
  platform: pushDevices.platform,
  userId: pushDevices.userId,
};
const toPushDevice = (row: {
  readonly token: string;
  readonly platform: string;
  readonly userId: string;
}): PushDevice => new PushDevice(row);

export const PushDevicesRepoLive: Layer.Layer<PushDevicesRepo, never, MendDB> = Layer.effect(
  PushDevicesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const register = Effect.fn("PushDevicesRepo.register")(function* (
      userId: string,
      token: string,
      platform: string,
    ) {
      const [row] = yield* db
        .insert(pushDevices)
        .values({ token, platform, userId })
        .onConflictDoUpdate({
          target: pushDevices.token,
          set: { platform, userId, lastSeenAt: new Date() },
        })
        .returning(selectedDevice)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("push device upsert returned no row");
      return toPushDevice(row);
    });

    const listForUsers = Effect.fn("PushDevicesRepo.listForUsers")(function* (
      userIds: ReadonlyArray<string>,
    ) {
      if (userIds.length === 0) return [];
      const rows = yield* db
        .select(selectedDevice)
        .from(pushDevices)
        .where(inArray(pushDevices.userId, [...userIds]))
        .pipe(Effect.orDie);
      return rows.map(toPushDevice);
    });

    const remove = Effect.fn("PushDevicesRepo.remove")(function* (token: string) {
      yield* db.delete(pushDevices).where(eq(pushDevices.token, token)).pipe(Effect.orDie);
    });

    const removeOwned = Effect.fn("PushDevicesRepo.removeOwned")(function* (
      userId: string,
      token: string,
    ) {
      yield* db
        .delete(pushDevices)
        .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, userId)))
        .pipe(Effect.orDie);
    });

    const removeAllForUser = Effect.fn("PushDevicesRepo.removeAllForUser")(function* (
      userId: string,
    ) {
      yield* db.delete(pushDevices).where(eq(pushDevices.userId, userId)).pipe(Effect.orDie);
    });

    return { register, listForUsers, remove, removeOwned, removeAllForUser };
  }),
);
