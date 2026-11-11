import { DEFAULT_SETTLE_SETTINGS, SettleSettings } from "@mend/domain/workbench";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userSettleSettings } from "../schema/workbench.ts";

export class SettleSettingsRepo extends Context.Service<
  SettleSettingsRepo,
  {
    readonly forUser: (userId: string) => Effect.Effect<SettleSettings>;
    readonly set: (userId: string, settings: SettleSettings) => Effect.Effect<SettleSettings>;
  }
>()("@mend/db/SettleSettingsRepo") {}

const make: Effect.Effect<SettleSettingsRepo["Service"], never, MendDB> = Effect.gen(function* () {
  const db = yield* MendDB;
  const selected = { stopSessionOnSettle: userSettleSettings.stopSessionOnSettle };
  return {
    forUser: Effect.fn("SettleSettingsRepo.forUser")(function* (userId: string) {
      const [row] = yield* db
        .select(selected)
        .from(userSettleSettings)
        .where(eq(userSettleSettings.userId, userId))
        .pipe(Effect.orDie);
      return row === undefined ? DEFAULT_SETTLE_SETTINGS : new SettleSettings(row);
    }),
    set: Effect.fn("SettleSettingsRepo.set")(function* (userId: string, settings: SettleSettings) {
      const [row] = yield* db
        .insert(userSettleSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({
          target: userSettleSettings.userId,
          set: { ...settings, updatedAt: yield* DateTime.nowAsDate },
        })
        .returning(selected)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("settle settings upsert returned no row");
      return new SettleSettings(row);
    }),
  };
});

export const SettleSettingsRepoLive: Layer.Layer<SettleSettingsRepo, never, MendDB> = Layer.effect(
  SettleSettingsRepo,
  make,
);
