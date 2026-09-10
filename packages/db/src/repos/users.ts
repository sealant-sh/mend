import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

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

    return { count };
  }),
);
