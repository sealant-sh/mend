import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** An account's public facts — what a roster shows beside a seat. */
export class UserFacts extends Schema.Class<UserFacts>("UserFacts")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

/**
 * The accounts on this instance, as a count. better-auth owns the `user`
 * table (plain SQL, like the identity mapping); Mend only asks whether the
 * instance has been claimed yet — a fresh install's first visit is the
 * registration, and the login page asks this before it renders.
 */
export class UsersRepo extends Context.Service<
  UsersRepo,
  {
    readonly count: () => Effect.Effect<number>;
    /** Case-insensitive email lookup — how an owner names a colleague to add. */
    readonly byEmail: (email: string) => Effect.Effect<UserFacts | null>;
    readonly byId: (id: string) => Effect.Effect<UserFacts | null>;
  }
>()("@mend/db/UsersRepo") {}

export const UsersRepoLive: Layer.Layer<UsersRepo, never, PgClient.PgClient> = Layer.effect(
  UsersRepo,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const count = Effect.fn("UsersRepo.count")(function* () {
      const rows = yield* sql`SELECT count(*)::int AS count FROM "user"`.pipe(Effect.orDie);
      const row = rows[0] as { readonly count: number } | undefined;
      return row?.count ?? 0;
    });

    const decodeFacts = Schema.decodeUnknownSync(UserFacts);

    const byEmail = Effect.fn("UsersRepo.byEmail")(function* (email: string) {
      const rows = yield* sql`
        SELECT id, name, email FROM "user" WHERE lower(email) = lower(${email.trim()}) LIMIT 1`.pipe(
        Effect.orDie,
      );
      return rows[0] === undefined ? null : decodeFacts(rows[0]);
    });

    const byId = Effect.fn("UsersRepo.byId")(function* (id: string) {
      const rows = yield* sql`SELECT id, name, email FROM "user" WHERE id = ${id} LIMIT 1`.pipe(
        Effect.orDie,
      );
      return rows[0] === undefined ? null : decodeFacts(rows[0]);
    });

    return { count, byEmail, byId };
  }),
);
