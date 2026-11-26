import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userGithubLogins } from "../schema/workbench.ts";

/** Mend's copy of one of a person's GitHub logins, as stored: the token only ever sealed. */
const HeldGithubLogin = Schema.Struct({
  /** The Sealant connected account the login was connected as. */
  accountId: Schema.String,
  /** The GitHub login it names, when the platform reported one. */
  login: Schema.NullOr(Schema.String),
  /** The token as `SecretCipher` sealed it. */
  sealedToken: Schema.String,
  updatedAt: Schema.Date,
});
export type HeldGithubLogin = typeof HeldGithubLogin.Type;

/**
 * Each person's GitHub logins, kept by Mend for their own calls to GitHub's API (docs/adr/0028):
 * one copy per connected account. Every query is constrained to one person; nothing here reads or
 * writes a plaintext token.
 */
export class GithubLoginsRepo extends Context.Service<
  GithubLoginsRepo,
  {
    /** Every copy Mend holds for the person, the most recently kept first. */
    readonly held: (userId: string) => Effect.Effect<ReadonlyArray<HeldGithubLogin>>;
    /** Keeps this login as the copy of its connected account, in place of an earlier one. */
    readonly keep: (
      userId: string,
      login: Omit<HeldGithubLogin, "updatedAt">,
    ) => Effect.Effect<void>;
    /** Removes the copy of this connected account; whether one went. */
    readonly forgetAccount: (userId: string, accountId: string) => Effect.Effect<boolean>;
    /**
     * Removes the copy GitHub refused, only while it is still that copy: a login connected again
     * meanwhile stays. Whether one went.
     */
    readonly forgetRefused: (
      userId: string,
      accountId: string,
      sealedToken: string,
    ) => Effect.Effect<boolean>;
  }
>()("@mend/db/GithubLoginsRepo") {}

/** Whether a delete removed a row. */
const removed = (rows: ReadonlyArray<unknown>) => rows.length > 0;

const makeGithubLoginsRepo: Effect.Effect<GithubLoginsRepo["Service"], never, MendDB> = Effect.gen(
  function* () {
    const db = yield* MendDB;
    return GithubLoginsRepo.of({
      held: Effect.fnUntraced(function* (userId: string) {
        const rows = yield* db
          .select()
          .from(userGithubLogins)
          .where(eq(userGithubLogins.userId, userId))
          .pipe(Effect.orDie);
        const held = yield* Schema.decodeUnknownEffect(Schema.Array(HeldGithubLogin))(rows).pipe(
          Effect.orDie,
        );
        return held.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }),
      keep: Effect.fnUntraced(function* (
        userId: string,
        login: Omit<HeldGithubLogin, "updatedAt">,
      ) {
        yield* db
          .insert(userGithubLogins)
          .values({ userId, ...login })
          .onConflictDoUpdate({
            target: [userGithubLogins.userId, userGithubLogins.accountId],
            set: { login: login.login, sealedToken: login.sealedToken, updatedAt: new Date() },
          })
          .pipe(Effect.orDie);
      }),
      forgetAccount: Effect.fnUntraced(function* (userId: string, accountId: string) {
        return removed(
          yield* db
            .delete(userGithubLogins)
            .where(
              and(eq(userGithubLogins.userId, userId), eq(userGithubLogins.accountId, accountId)),
            )
            .returning({ userId: userGithubLogins.userId })
            .pipe(Effect.orDie),
        );
      }),
      forgetRefused: Effect.fnUntraced(function* (
        userId: string,
        accountId: string,
        sealedToken: string,
      ) {
        return removed(
          yield* db
            .delete(userGithubLogins)
            .where(
              and(
                eq(userGithubLogins.userId, userId),
                eq(userGithubLogins.accountId, accountId),
                eq(userGithubLogins.sealedToken, sealedToken),
              ),
            )
            .returning({ userId: userGithubLogins.userId })
            .pipe(Effect.orDie),
        );
      }),
    });
  },
);

export const GithubLoginsRepoLive: Layer.Layer<GithubLoginsRepo, never, MendDB> = Layer.effect(
  GithubLoginsRepo,
  makeGithubLoginsRepo,
);
