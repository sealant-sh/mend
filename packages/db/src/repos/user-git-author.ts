import { PgClient } from "@effect/sql-pg";
import { GitAuthor, ResolvedGitAuthor } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

const AuthorRow = Schema.Struct({
  accountName: Schema.String,
  accountEmail: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
const decodeAuthorRow = Schema.decodeUnknownSync(AuthorRow);

/**
 * The account setting "Git author" (docs/GIT-ACCESS.md): the name and email an account's
 * workspaces commit as. Identity, like dotfiles and git access: per account, never per instance.
 */
export class UserGitAuthorRepo extends Context.Service<
  UserGitAuthorRepo,
  {
    /**
     * The author the account's workspaces receive: its saved setting, else the name and email
     * it registered with. Null for an account that does not exist.
     */
    readonly resolve: (userId: string) => Effect.Effect<ResolvedGitAuthor | null>;
    /** Save the account's setting; callers check it with `gitAuthorIssue` first. */
    readonly set: (userId: string, author: GitAuthor) => Effect.Effect<void>;
    /** Drop the setting: the account's registration name and email apply again. */
    readonly clear: (userId: string) => Effect.Effect<void>;
  }
>()("@mend/db/UserGitAuthorRepo") {}

export const UserGitAuthorRepoLive: Layer.Layer<UserGitAuthorRepo, never, PgClient.PgClient> =
  Layer.effect(
    UserGitAuthorRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const resolve = Effect.fn("UserGitAuthorRepo.resolve")(function* (userId: string) {
        // better-auth owns `user` (plain SQL, like UsersRepo); the setting sits beside it.
        const rows = yield* sql`
          SELECT u.name AS "accountName", u.email AS "accountEmail", a.name, a.email
          FROM "user" u
          LEFT JOIN user_git_author a ON a.user_id = u.id
          WHERE u.id = ${userId}
          LIMIT 1`.pipe(Effect.orDie);
        if (rows[0] === undefined) return null;
        const row = decodeAuthorRow(rows[0]);
        return row.name !== null && row.email !== null
          ? new ResolvedGitAuthor({ name: row.name, email: row.email, source: "setting" })
          : new ResolvedGitAuthor({
              name: row.accountName,
              email: row.accountEmail,
              source: "account",
            });
      });

      const set = Effect.fn("UserGitAuthorRepo.set")(function* (userId: string, author: GitAuthor) {
        yield* sql`
          INSERT INTO user_git_author (user_id, name, email)
          VALUES (${userId}, ${author.name}, ${author.email})
          ON CONFLICT (user_id) DO UPDATE
          SET name = excluded.name, email = excluded.email, updated_at = now()`.pipe(Effect.orDie);
      });

      const clear = Effect.fn("UserGitAuthorRepo.clear")(function* (userId: string) {
        yield* sql`DELETE FROM user_git_author WHERE user_id = ${userId}`.pipe(Effect.orDie);
      });

      return { resolve, set, clear };
    }),
  );
