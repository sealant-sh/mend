import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

export class PushDevice extends Schema.Class<PushDevice>("PushDevice")({
  token: Schema.String,
  platform: Schema.String,
  userId: Schema.String,
}) {}

export class PushCredentialEndedError extends Schema.TaggedError<PushCredentialEndedError>()(
  "PushCredentialEndedError",
  {},
) {}

const decodeDevices = Schema.decodeUnknownSync(Schema.Array(PushDevice));

export class PushDevicesRepo extends Context.Service<
  PushDevicesRepo,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly deviceTokenId: string;
      readonly token: string;
      readonly platform: string;
    }) => Effect.Effect<PushDevice, PushCredentialEndedError>;
    readonly listForUsers: (
      userIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PushDevice>>;
    /** Prune a token the push service reported dead, whoever it belongs to. */
    readonly remove: (token: string) => Effect.Effect<void>;
    readonly forget: (deviceTokenId: string) => Effect.Effect<void>;
  }
>()("@mend/db/PushDevicesRepo") {}

export const PushDevicesRepoLive: Layer.Layer<PushDevicesRepo, never, PgClient.PgClient> =
  Layer.effect(
    PushDevicesRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const shareLockStandingAccountThenDevice = (userId: string, deviceTokenId: string) =>
        Effect.gen(function* () {
          const account = yield* sql`
            SELECT 1 FROM "user" WHERE id = ${userId} AND "deactivatedAt" IS NULL FOR SHARE`;
          if (account.length === 0) return false;
          const device = yield* sql`
            SELECT 1 FROM device_tokens
            WHERE id = ${deviceTokenId} AND user_id = ${userId} AND revoked_at IS NULL
            FOR SHARE`;
          return device.length > 0;
        });

      const register: PushDevicesRepo["Service"]["register"] = Effect.fn(
        "PushDevicesRepo.register",
      )((input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              if (!(yield* shareLockStandingAccountThenDevice(input.userId, input.deviceTokenId)))
                return yield* new PushCredentialEndedError();
              yield* sql`
                INSERT INTO push_devices (token, platform, device_token_id)
                VALUES (${input.token}, ${input.platform}, ${input.deviceTokenId})
                ON CONFLICT (token) DO UPDATE SET
                  platform = EXCLUDED.platform,
                  device_token_id = EXCLUDED.device_token_id,
                  last_seen_at = now()`;
              return new PushDevice({
                token: input.token,
                platform: input.platform,
                userId: input.userId,
              });
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error))),
      );

      const listForUsers = Effect.fn("PushDevicesRepo.listForUsers")(function* (
        userIds: ReadonlyArray<string>,
      ) {
        if (userIds.length === 0) return [];
        const rows = yield* sql`
          SELECT p.token, p.platform, d.user_id AS "userId"
          FROM push_devices p
          JOIN device_tokens d ON d.id = p.device_token_id
          JOIN "user" u ON u.id = d.user_id
          WHERE d.user_id IN ${sql.in([...userIds])}
            AND d.revoked_at IS NULL
            AND u."deactivatedAt" IS NULL`.pipe(Effect.orDie);
        return decodeDevices(rows);
      });

      const remove = Effect.fn("PushDevicesRepo.remove")(function* (token: string) {
        yield* sql`DELETE FROM push_devices WHERE token = ${token}`.pipe(Effect.orDie);
      });

      const forget = Effect.fn("PushDevicesRepo.forget")(function* (deviceTokenId: string) {
        yield* sql`DELETE FROM push_devices WHERE device_token_id = ${deviceTokenId}`.pipe(
          Effect.orDie,
        );
      });

      return { register, listForUsers, remove, forget };
    }),
  );
