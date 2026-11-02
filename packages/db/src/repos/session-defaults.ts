import { NO_SESSION_DEFAULTS, SessionDefaults } from "@mend/domain/workbench";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userSessionDefaults } from "../schema/workbench.ts";

const decodeDefaults = Schema.decodeUnknownEffect(SessionDefaults);
const encodeDefaults = Schema.encodeEffect(SessionDefaults);

/**
 * A person's new-session defaults (`SessionDefaults`): the agent, model and effort the composer
 * picks first, on every device they sign in from.
 */
export class SessionDefaultsRepo extends Context.Service<
  SessionDefaultsRepo,
  {
    /** The person's defaults; none chosen when they never saved any. */
    readonly forUser: (userId: string) => Effect.Effect<SessionDefaults>;
    readonly set: (userId: string, defaults: SessionDefaults) => Effect.Effect<SessionDefaults>;
    /**
     * Keep `defaults` only if the person has none saved yet, and answer what is saved and whether
     * these were kept: a browser that kept defaults of its own before they moved here hands them
     * over once, and a second browser doing the same later changes nothing.
     */
    readonly adopt: (
      userId: string,
      defaults: SessionDefaults,
    ) => Effect.Effect<{ readonly saved: SessionDefaults; readonly adopted: boolean }>;
  }
>()("@mend/db/SessionDefaultsRepo") {}

const make: Effect.Effect<SessionDefaultsRepo["Service"], never, MendDB> = Effect.gen(function* () {
  const db = yield* MendDB;

  const fromRow = (row: typeof userSessionDefaults.$inferSelect | undefined) =>
    row === undefined
      ? Effect.succeed(NO_SESSION_DEFAULTS)
      : decodeDefaults({ harness: row.harness, byHarness: row.byHarness }).pipe(Effect.orDie);

  const forUser = Effect.fn("SessionDefaultsRepo.forUser")(function* (userId: string) {
    const [row] = yield* db
      .select()
      .from(userSessionDefaults)
      .where(eq(userSessionDefaults.userId, userId))
      .limit(1)
      .pipe(Effect.orDie);
    return yield* fromRow(row);
  });

  const set = Effect.fn("SessionDefaultsRepo.set")(function* (
    userId: string,
    defaults: SessionDefaults,
  ) {
    const encoded = yield* encodeDefaults(defaults).pipe(Effect.orDie);
    const [row] = yield* db
      .insert(userSessionDefaults)
      .values({ userId, harness: encoded.harness, byHarness: encoded.byHarness })
      .onConflictDoUpdate({
        target: userSessionDefaults.userId,
        set: {
          harness: encoded.harness,
          byHarness: encoded.byHarness,
          updatedAt: yield* DateTime.nowAsDate,
        },
      })
      .returning()
      .pipe(Effect.orDie);
    if (row === undefined) return yield* Effect.die("session defaults upsert returned no row");
    return yield* fromRow(row);
  });

  const adopt = Effect.fn("SessionDefaultsRepo.adopt")(function* (
    userId: string,
    defaults: SessionDefaults,
  ) {
    const encoded = yield* encodeDefaults(defaults).pipe(Effect.orDie);
    const inserted = yield* db
      .insert(userSessionDefaults)
      .values({ userId, harness: encoded.harness, byHarness: encoded.byHarness })
      .onConflictDoNothing({ target: userSessionDefaults.userId })
      .returning({ userId: userSessionDefaults.userId })
      .pipe(Effect.orDie);
    return { saved: yield* forUser(userId), adopted: inserted.length > 0 };
  });

  return { forUser, set, adopt };
});

export const SessionDefaultsRepoLive: Layer.Layer<SessionDefaultsRepo, never, MendDB> =
  Layer.effect(SessionDefaultsRepo, make);
