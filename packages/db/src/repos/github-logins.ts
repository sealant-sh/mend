import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userGithubLogins } from "../schema/workbench.ts";

/** Mend's copy of one person's GitHub login, as stored: the token only ever sealed. */
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
 * Each person's GitHub login, kept by Mend for their own calls to GitHub's API (docs/adr/0028).
 * Every query is constrained to one person; nothing here reads or writes a plaintext token.
 */
export class GithubLoginsRepo extends Context.Service<
  GithubLoginsRepo,
  {
    readonly held: (userId: string) => Effect.Effect<HeldGithubLogin | null>;
    /** Keeps this login as the person's copy, in place of any earlier one. */
    readonly keep: (
      userId: string,
      login: Omit<HeldGithubLogin, "updatedAt">,
    ) => Effect.Effect<void>;
    /** Removes the copy when it came from this connected account; whether one went. */
    readonly forgetAccount: (userId: string, accountId: string) => Effect.Effect<boolean>;
    /**
     * Removes the copy GitHub refused, only while it is still that copy: a login connected again
     * meanwhile stays. Whether one went.
     */
    readonly forgetRefused: (userId: string, sealedToken: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/GithubLoginsRepo") {}

const makeGithubLoginsRepo: Effect.Effect<GithubLoginsRepo["Service"], never, MendDB> = Effect.gen(
  function* () {
    const db = yield* MendDB;
    return GithubLoginsRepo.of({
      held: Effect.fn("GithubLoginsRepo.held")(function* (userId: string) {
        const [row] = yield* db
          .select()
          .from(userGithubLogins)
          .where(eq(userGithubLogins.userId, userId))
          .pipe(Effect.orDie);
        return row === undefined
          ? null
          : yield* Schema.decodeUnknownEffect(HeldGithubLogin)(row).pipe(Effect.orDie);
      }),
      keep: Effect.fn("GithubLoginsRepo.keep")(function* (
        userId: string,
        login: Omit<HeldGithubLogin, "updatedAt">,
      ) {
        yield* db
          .insert(userGithubLogins)
          .values({ userId, ...login })
          .onConflictDoUpdate({
            target: userGithubLogins.userId,
            set: { ...login, updatedAt: new Date() },
          })
          .pipe(Effect.orDie);
      }),
      forgetAccount: Effect.fn("GithubLoginsRepo.forgetAccount")(function* (
        userId: string,
        accountId: string,
      ) {
        const rows = yield* db
          .delete(userGithubLogins)
          .where(
            and(eq(userGithubLogins.userId, userId), eq(userGithubLogins.accountId, accountId)),
          )
          .returning({ userId: userGithubLogins.userId })
          .pipe(Effect.orDie);
        return rows.length > 0;
      }),
      forgetRefused: Effect.fn("GithubLoginsRepo.forgetRefused")(function* (
        userId: string,
        sealedToken: string,
      ) {
        const rows = yield* db
          .delete(userGithubLogins)
          .where(
            and(eq(userGithubLogins.userId, userId), eq(userGithubLogins.sealedToken, sealedToken)),
          )
          .returning({ userId: userGithubLogins.userId })
          .pipe(Effect.orDie);
        return rows.length > 0;
      }),
    });
  },
);

export const GithubLoginsRepoLive: Layer.Layer<GithubLoginsRepo, never, MendDB> = Layer.effect(
  GithubLoginsRepo,
  makeGithubLoginsRepo,
);
