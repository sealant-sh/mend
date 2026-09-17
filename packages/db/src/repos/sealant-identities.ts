import { PgClient } from "@effect/sql-pg";
import { SealantIdentityStore, type MendUserRecord } from "@mend/sealant";
import { Effect, Layer } from "effect";

/**
 * The Mend user ↔ Sealant user mapping (docs/SEALANT-IDENTITY.md), one row per
 * account once it first touches the platform. Accounts are better-auth's
 * `user` table; the mapping is Mend's. Both are read with plain SQL here —
 * better-auth owns the `user` schema, so the drizzle schema does not model it.
 */
export const SealantIdentityStoreLive: Layer.Layer<SealantIdentityStore, never, PgClient.PgClient> =
  Layer.effect(
    SealantIdentityStore,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const user = Effect.fn("SealantIdentityStore.user")(function* (userId: string) {
        const rows = yield* sql`
        SELECT id, email, name FROM "user" WHERE id = ${userId} LIMIT 1`.pipe(Effect.orDie);
        const row = rows[0] as MendUserRecord | undefined;
        return row === undefined ? null : { id: row.id, email: row.email, name: row.name };
      });

      const sealantUserId = Effect.fn("SealantIdentityStore.sealantUserId")(function* (
        userId: string,
      ) {
        const rows = yield* sql`
        SELECT sealant_user_id FROM user_sealant_identities WHERE user_id = ${userId} LIMIT 1`.pipe(
          Effect.orDie,
        );
        const row = rows[0] as { readonly sealant_user_id: string } | undefined;
        return row?.sealant_user_id ?? null;
      });

      const record = Effect.fn("SealantIdentityStore.record")(function* (
        userId: string,
        sealantId: string,
      ) {
        yield* sql`
        INSERT INTO user_sealant_identities (user_id, sealant_user_id)
        VALUES (${userId}, ${sealantId})
        ON CONFLICT (user_id) DO UPDATE SET sealant_user_id = EXCLUDED.sealant_user_id`.pipe(
          Effect.orDie,
        );
      });

      return { user, sealantUserId, record };
    }),
  );
