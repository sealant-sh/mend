import { DEFAULT_MESSAGE_SETTINGS, MessageSettings } from "@mend/domain/workbench";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userMessageSettings } from "../schema/workbench.ts";

export class MessageSettingsRepo extends Context.Service<
  MessageSettingsRepo,
  {
    readonly forUser: (userId: string) => Effect.Effect<MessageSettings>;
    readonly set: (userId: string, settings: MessageSettings) => Effect.Effect<MessageSettings>;
  }
>()("@mend/db/MessageSettingsRepo") {}

const make: Effect.Effect<MessageSettingsRepo["Service"], never, MendDB> = Effect.gen(function* () {
  const db = yield* MendDB;
  const selected = { sendSteersRunningTurn: userMessageSettings.sendSteersRunningTurn };
  return {
    forUser: Effect.fn("MessageSettingsRepo.forUser")(function* (userId: string) {
      const [row] = yield* db
        .select(selected)
        .from(userMessageSettings)
        .where(eq(userMessageSettings.userId, userId))
        .pipe(Effect.orDie);
      return row === undefined ? DEFAULT_MESSAGE_SETTINGS : new MessageSettings(row);
    }),
    set: Effect.fn("MessageSettingsRepo.set")(function* (
      userId: string,
      settings: MessageSettings,
    ) {
      const [row] = yield* db
        .insert(userMessageSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({
          target: userMessageSettings.userId,
          set: { ...settings, updatedAt: yield* DateTime.nowAsDate },
        })
        .returning(selected)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("message settings upsert returned no row");
      return new MessageSettings(row);
    }),
  };
});

export const MessageSettingsRepoLive: Layer.Layer<MessageSettingsRepo, never, MendDB> =
  Layer.effect(MessageSettingsRepo, make);
