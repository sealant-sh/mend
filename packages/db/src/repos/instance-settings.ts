import { MendSettings } from "@mend/domain";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { MendDB } from "../client.ts";
import { settings as settingsTable } from "../schema/workbench.ts";

export { BuiltInSettings } from "../built-in-settings.ts";

const decodeSettings = Schema.decodeUnknownEffect(MendSettings);

/**
 * The instance's settings document as it stands: the saved row, else the built-in one. Its
 * workspace image is the server's, which each new organization copies as its starting image.
 */
export const readInstanceSettings = (
  db: MendDB["Service"],
  builtIn: MendSettings,
): Effect.Effect<MendSettings> =>
  Effect.gen(function* () {
    const [row] = yield* db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, "mend"))
      .limit(1)
      .pipe(Effect.orDie);
    if (row === undefined) return builtIn;
    return yield* decodeSettings(row.value).pipe(Effect.orDie);
  });
