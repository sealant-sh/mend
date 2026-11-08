import { PgClient } from "@effect/sql-pg";
import { OrganizationId, Timestamp } from "@mend/domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { deviceTokens } from "../schema/workbench.ts";

/**
 * One of a person's access keys (docs/adr/0023-access-keys.md): a `device_tokens` row of kind
 * `access_key`. Only the SHA-256 of its secret is stored, so the secret is never read back.
 */
export class AccessKey extends Schema.Class<AccessKey>("AccessKey")({
  id: Schema.String,
  name: Schema.String,
  organizationId: OrganizationId,
  createdAt: Timestamp,
  lastUsedAt: Schema.NullOr(Timestamp),
  expiresAt: Schema.NullOr(Timestamp),
}) {}

/** No live access key with that id belongs to this person. */
export class AccessKeyNotFoundError extends Schema.TaggedError<AccessKeyNotFoundError>()(
  "AccessKeyNotFoundError",
  { id: Schema.String },
) {}

/**
 * A person's access keys. The row is shared with paired devices, so every query here names
 * `kind = 'access_key'` and the device queries name `kind = 'device'`: neither list shows the
 * other, and neither revoke reaches the other. Revoking every credential of a removed member is
 * `DevicesRepo.revokeAllForUser`, which takes both kinds.
 */
export class AccessKeysRepo extends Context.Service<
  AccessKeysRepo,
  {
    /** The id is minted here; the caller hashes the secret it hands out once. */
    readonly create: (input: {
      readonly userId: string;
      readonly organizationId: OrganizationId;
      readonly name: string;
      readonly secretHash: string;
      readonly expiresAt: Date | null;
    }) => Effect.Effect<AccessKey>;
    /** Newest first. Revoked keys drop off; expired ones stay until revoked. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<AccessKey>>;
    /** A key already revoked answers as unknown, as it is no longer listed. */
    readonly revoke: (
      userId: string,
      id: string,
    ) => Effect.Effect<AccessKey, AccessKeyNotFoundError>;
  }
>()("@mend/db/AccessKeysRepo") {}

const selectedKey = {
  id: deviceTokens.id,
  name: deviceTokens.name,
  organizationId: deviceTokens.organizationId,
  createdAt: deviceTokens.createdAt,
  lastUsedAt: deviceTokens.lastUsedAt,
  expiresAt: deviceTokens.expiresAt,
};

const decodeKey = Schema.decodeUnknownSync(AccessKey);

/** What every access-key row is stored as, whatever the person named it. */
export const ACCESS_KEY_PLATFORM = "access-key";

export const AccessKeysRepoLive: Layer.Layer<AccessKeysRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    AccessKeysRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sql = yield* PgClient.PgClient;
      const changed = (userId: string) =>
        notifyEvent(sql, { type: "user", userId, facet: "devices" });

      const create = Effect.fn("AccessKeysRepo.create")(function* (input: {
        readonly userId: string;
        readonly organizationId: OrganizationId;
        readonly name: string;
        readonly secretHash: string;
        readonly expiresAt: Date | null;
      }) {
        const [row] = yield* db
          .insert(deviceTokens)
          .values({
            // A UUID has no `_`, so the id reads back out of `mak_<id>_<secret>`.
            id: crypto.randomUUID(),
            userId: input.userId,
            name: input.name,
            platform: ACCESS_KEY_PLATFORM,
            tokenHash: input.secretHash,
            kind: "access_key",
            organizationId: input.organizationId,
            expiresAt: input.expiresAt,
          })
          .returning(selectedKey)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("access key insert returned no row");
        yield* changed(input.userId);
        return decodeKey(row);
      });

      const list = Effect.fn("AccessKeysRepo.list")(function* (userId: string) {
        const rows = yield* db
          .select(selectedKey)
          .from(deviceTokens)
          .where(
            and(
              eq(deviceTokens.userId, userId),
              eq(deviceTokens.kind, "access_key"),
              isNull(deviceTokens.revokedAt),
            ),
          )
          .orderBy(desc(deviceTokens.createdAt))
          .pipe(Effect.orDie);
        return rows.map((row) => decodeKey(row));
      });

      const revoke = Effect.fn("AccessKeysRepo.revoke")(function* (userId: string, id: string) {
        const [row] = yield* db
          .update(deviceTokens)
          .set({ revokedAt: yield* DateTime.nowAsDate })
          .where(
            and(
              eq(deviceTokens.id, id),
              eq(deviceTokens.userId, userId),
              eq(deviceTokens.kind, "access_key"),
              isNull(deviceTokens.revokedAt),
            ),
          )
          .returning(selectedKey)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new AccessKeyNotFoundError({ id });
        yield* changed(userId);
        return decodeKey(row);
      });

      return { create, list, revoke };
    }),
  );
