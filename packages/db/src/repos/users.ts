import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** An account's public facts: what a roster shows beside a membership. */
export class UserFacts extends Schema.Class<UserFacts>("UserFacts")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

const CountRow = Schema.Struct({ count: Schema.Number });
const decodeCount = Schema.decodeUnknownSync(CountRow);
const decodeFacts = Schema.decodeUnknownSync(UserFacts);

/**
 * The accounts on this instance. better-auth owns the `user` table (plain SQL, like the identity
 * mapping). Accounts are deactivated, never deleted (docs/adr/0003-organizations-and-tenancy.md).
 */
export class UsersRepo extends Context.Service<
  UsersRepo,
  {
    readonly count: () => Effect.Effect<number>;
    readonly byId: (id: string) => Effect.Effect<UserFacts | null>;
    /** Case-insensitive email lookup. */
    readonly byEmail: (email: string) => Effect.Effect<UserFacts | null>;
    /** The earliest registered account, or null on an unclaimed instance. */
    readonly oldest: () => Effect.Effect<UserFacts | null>;
    /** Mark the account deactivated. Refusing its sign-ins lands with member removal. */
    readonly deactivate: (id: string) => Effect.Effect<void>;
  }
>()("@mend/db/UsersRepo") {}

export const UsersRepoLive: Layer.Layer<UsersRepo, never, PgClient.PgClient> = Layer.effect(
  UsersRepo,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const count = Effect.fn("UsersRepo.count")(function* () {
      const rows = yield* sql`SELECT count(*)::int AS count FROM "user"`.pipe(Effect.orDie);
      return rows[0] === undefined ? 0 : decodeCount(rows[0]).count;
    });

    const byId = Effect.fn("UsersRepo.byId")(function* (id: string) {
      const rows = yield* sql`SELECT id, name, email FROM "user" WHERE id = ${id} LIMIT 1`.pipe(
        Effect.orDie,
      );
      return rows[0] === undefined ? null : decodeFacts(rows[0]);
    });

    const byEmail = Effect.fn("UsersRepo.byEmail")(function* (email: string) {
      const rows = yield* sql`
        SELECT id, name, email FROM "user" WHERE lower(email) = lower(${email.trim()}) LIMIT 1`.pipe(
        Effect.orDie,
      );
      return rows[0] === undefined ? null : decodeFacts(rows[0]);
    });

    const oldest = Effect.fn("UsersRepo.oldest")(function* () {
      const rows = yield* sql`
        SELECT id, name, email FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1`.pipe(
        Effect.orDie,
      );
      return rows[0] === undefined ? null : decodeFacts(rows[0]);
    });

    const deactivate = Effect.fn("UsersRepo.deactivate")(function* (id: string) {
      yield* sql`
        UPDATE "user" SET "deactivatedAt" = now()
        WHERE id = ${id} AND "deactivatedAt" IS NULL`.pipe(Effect.orDie);
    });

    return { count, byId, byEmail, oldest, deactivate };
  }),
);
